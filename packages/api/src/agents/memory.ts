/** Memories */
import { z } from 'zod';
import { Tools } from 'librechat-data-provider';
import { logger } from '@librechat/data-schemas';
import { tool } from '@librechat/agents/langchain/tools';
import { Run, Providers, GraphEvents } from '@librechat/agents';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import type {
  OpenAIClientOptions,
  StreamEventData,
  ToolEndCallback,
  EventHandler,
  ToolEndData,
  LLMConfig,
} from '@librechat/agents';
import type { BaseMessage, ToolMessage } from '@librechat/agents/langchain/messages';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type {
  AppConfig,
  ObjectId,
  MemoryMethods,
  MemoryBucketRef,
  IUser,
} from '@librechat/data-schemas';
import type { TAttachment, TMemoryConfig, MemoryArtifact } from 'librechat-data-provider';
import type { Response as ServerResponse } from 'express';
import type { RunLLMConfig, EndpointDbMethods, ServerRequest } from '~/types';
import { getProviderConfig } from '~/endpoints/config/providers';
import { GenerationJobManager } from '~/stream/GenerationJobManager';
import { resolveConfigHeaders, createSafeUser } from '~/utils';
import Tokenizer from '~/utils/tokenizer';

type RequiredMemoryMethods = Pick<
  MemoryMethods,
  'setMemory' | 'deleteMemory' | 'getFormattedMemories'
>;

type ToolEndMetadata = Record<string, unknown> & {
  run_id?: string;
  thread_id?: string;
};

type SanitizedMemoryLLMConfig = Omit<Partial<LLMConfig>, 'apiKey'> & { apiKey?: string };

export interface MemoryConfig {
  validKeys?: string[];
  instructions?: string;
  llmConfig?: Partial<LLMConfig>;
  tokenLimit?: number;
}

/**
 * The single key used for an agent's own memory bucket (Kade-AI two-tier memory).
 * Anything filed under this key, in a call that has an `agentId`, is scoped to that
 * one agent only -- every other key is shared and visible to every agent, exactly
 * as memory worked before this feature existed.
 */
export const AGENT_SCOPED_MEMORY_KEY = 'agent_notes';

function normalizeMemoryLLMConfig(llmConfig?: Partial<LLMConfig>): SanitizedMemoryLLMConfig {
  const config = { ...(llmConfig ?? {}) } as Record<string, unknown>;
  if (typeof config.apiKey !== 'string') {
    delete config.apiKey;
  }
  return config as SanitizedMemoryLLMConfig;
}

export const memoryInstructions =
  'The system automatically stores important user information and can update or delete memories based on user requests, enabling dynamic memory management.';

const getDefaultInstructions = (
  validKeys?: string[],
  tokenLimit?: number,
  agentScoped?: boolean,
) => `Use the \`set_memory\` tool to save important information about the user, but ONLY when the user has requested you to remember something.

The \`delete_memory\` tool should only be used in two scenarios:
  1. When the user explicitly asks to forget or remove specific information
  2. When updating existing memories, use the \`set_memory\` tool instead of deleting and re-adding the memory.

1. ONLY use memory tools when the user requests memory actions with phrases like:
   - "Remember [that] [I]..."
   - "Don't forget [that] [I]..."
   - "Please remember..."
   - "Store this..."
   - "Forget [that] [I]..."
   - "Delete the memory about..."

2. NEVER store information just because the user mentioned it in conversation.

3. NEVER use memory tools when the user asks you to use other tools or invoke tools in general.

4. Memory tools are ONLY for memory requests, not for general tool usage.

5. If the user doesn't ask you to remember or forget something, DO NOT use any memory tools.

${validKeys && validKeys.length > 0 ? `\nVALID KEYS: ${validKeys.join(', ')}` : ''}
${
  agentScoped
    ? `\nKey choice: use "${AGENT_SCOPED_MEMORY_KEY}" for anything specific to YOUR OWN persona/relationship with the user -- things another assistant wouldn't know or share. Use one of the other keys for general facts about the user that any assistant should be able to see.`
    : ''
}

${tokenLimit ? `\nTOKEN LIMIT: Maximum ${tokenLimit} tokens per memory value.` : ''}

When in doubt, and the user hasn't asked to remember or forget anything, END THE TURN IMMEDIATELY.`;

/**
 * Creates a memory tool instance with user context
 */
export const createMemoryTool = ({
  userId,
  agentId,
  setMemory,
  validKeys,
  tokenLimit,
  totalTokens = 0,
  forceAgentScope = false,
}: {
  userId: string | ObjectId;
  /** The persona currently in the conversation, if any. Writes with `scope: 'agent'` (or the legacy `agent_notes` key) go to this persona's own bucket; everything else stays shared. */
  agentId?: string;
  setMemory: MemoryMethods['setMemory'];
  validKeys?: string[];
  tokenLimit?: number;
  totalTokens?: number;
  /** When true (agent-bucket consolidation), EVERY write is scoped to `agentId` regardless of key/scope -- keeps card splits inside the bucket being consolidated. */
  forceAgentScope?: boolean;
}): DynamicStructuredTool => {
  const remainingTokens = tokenLimit ? tokenLimit - totalTokens : Infinity;
  const isOverflowing = tokenLimit ? remainingTokens <= 0 : false;

  return tool(
    async ({ key, value, scope }) => {
      try {
        if (validKeys && validKeys.length > 0 && !validKeys.includes(key)) {
          logger.warn(
            `Memory Agent failed to set memory: Invalid key "${key}". Must be one of: ${validKeys.join(
              ', ',
            )}`,
          );
          return [`Invalid key "${key}". Must be one of: ${validKeys.join(', ')}`, undefined];
        }

        const tokenCount = Tokenizer.getTokenCount(value, 'o200k_base');

        if (isOverflowing) {
          const errorArtifact: Record<Tools.memory, MemoryArtifact> = {
            [Tools.memory]: {
              key: 'system',
              type: 'error',
              value: JSON.stringify({
                errorType: 'already_exceeded',
                tokenCount: Math.abs(remainingTokens),
                totalTokens: totalTokens,
                tokenLimit: tokenLimit!,
              }),
              tokenCount: totalTokens,
            },
          };
          return [`Memory storage exceeded. Cannot save new memories.`, errorArtifact];
        }

        if (tokenLimit) {
          const newTotalTokens = totalTokens + tokenCount;
          const newRemainingTokens = tokenLimit - newTotalTokens;

          if (newRemainingTokens < 0) {
            const errorArtifact: Record<Tools.memory, MemoryArtifact> = {
              [Tools.memory]: {
                key: 'system',
                type: 'error',
                value: JSON.stringify({
                  errorType: 'would_exceed',
                  tokenCount: Math.abs(newRemainingTokens),
                  totalTokens: newTotalTokens,
                  tokenLimit,
                }),
                tokenCount: totalTokens,
              },
            };
            return [`Memory storage would exceed limit. Cannot save this memory.`, errorArtifact];
          }
        }

        const artifact: Record<Tools.memory, MemoryArtifact> = {
          [Tools.memory]: {
            key,
            value,
            tokenCount,
            type: 'update',
          },
        };

        /** Scope resolution: explicit `scope: 'agent'` (or the legacy `agent_notes` key, or a forced consolidation pass) files this card in the current persona's own bucket; everything else stays shared. */
        const targetAgentId =
          agentId && (forceAgentScope || scope === 'agent' || key === AGENT_SCOPED_MEMORY_KEY)
            ? agentId
            : undefined;
        const result = await setMemory({ userId, agentId: targetAgentId, key, value, tokenCount });
        if (result.ok) {
          logger.debug(`Memory set for key "${key}" (${tokenCount} tokens) for user "${userId}"`);
          return [`Memory set for key "${key}" (${tokenCount} tokens)`, artifact];
        }
        logger.warn(`Failed to set memory for key "${key}" for user "${userId}"`);
        return [`Failed to set memory for key "${key}"`, undefined];
      } catch (error) {
        logger.error('Memory Agent failed to set memory', error);
        return [`Error setting memory for key "${key}"`, undefined];
      }
    },
    {
      name: 'set_memory',
      description: 'Saves important information about the user into memory.',
      responseFormat: 'content_and_artifact',
      schema: z.object({
        key: z
          .string()
          .describe(
            validKeys && validKeys.length > 0
              ? `The key of the memory value. Must be one of: ${validKeys.join(', ')}`
              : 'Short snake_case topic name for this memory card (e.g. "dad_health", "concert_crew"). Reuse an existing key to update that card.',
          ),
        value: z
          .string()
          .describe(
            'Value MUST be a complete sentence that fully describes relevant user information.',
          ),
        scope: z
          .enum(['shared', 'agent'])
          .optional()
          .describe(
            'Where this card lives: "shared" = visible to every assistant on the platform (default); "agent" = private to you, the current character, only. Ignored when no character is active.',
          ),
      }),
    },
  );
};

/**
 * Creates a delete memory tool instance with user context
 */
const createDeleteMemoryTool = ({
  userId,
  agentId,
  deleteMemory,
  validKeys,
  forceAgentScope = false,
}: {
  userId: string | ObjectId;
  agentId?: string;
  deleteMemory: MemoryMethods['deleteMemory'];
  validKeys?: string[];
  /** When true (agent-bucket consolidation), deletions always target `agentId`'s bucket. */
  forceAgentScope?: boolean;
}) => {
  return tool(
    async ({ key, scope }) => {
      try {
        if (validKeys && validKeys.length > 0 && !validKeys.includes(key)) {
          logger.warn(
            `Memory Agent failed to delete memory: Invalid key "${key}". Must be one of: ${validKeys.join(
              ', ',
            )}`,
          );
          return [`Invalid key "${key}". Must be one of: ${validKeys.join(', ')}`, undefined];
        }

        const artifact: Record<Tools.memory, MemoryArtifact> = {
          [Tools.memory]: {
            key,
            type: 'delete',
          },
        };

        const targetAgentId =
          agentId && (forceAgentScope || scope === 'agent' || key === AGENT_SCOPED_MEMORY_KEY)
            ? agentId
            : undefined;
        const result = await deleteMemory({ userId, agentId: targetAgentId, key });
        if (result.ok) {
          logger.debug(`Memory deleted for key "${key}" for user "${userId}"`);
          return [`Memory deleted for key "${key}"`, artifact];
        }
        logger.warn(`Failed to delete memory for key "${key}" for user "${userId}"`);
        return [`Failed to delete memory for key "${key}"`, undefined];
      } catch (error) {
        logger.error('Memory Agent failed to delete memory', error);
        return [`Error deleting memory for key "${key}"`, undefined];
      }
    },
    {
      name: 'delete_memory',
      description:
        'Deletes specific memory data about the user using the provided key. For updating existing memories, use the `set_memory` tool instead',
      responseFormat: 'content_and_artifact',
      schema: z.object({
        key: z
          .string()
          .describe(
            validKeys && validKeys.length > 0
              ? `The key of the memory to delete. Must be one of: ${validKeys.join(', ')}`
              : 'The key identifier of the memory card to delete',
          ),
        scope: z
          .enum(['shared', 'agent'])
          .optional()
          .describe(
            'Which bucket the card lives in: "shared" (default) or "agent" (your own private card). Ignored when no character is active.',
          ),
      }),
    },
  );
};
export class BasicToolEndHandler implements EventHandler {
  private callback?: ToolEndCallback;
  constructor(callback?: ToolEndCallback) {
    this.callback = callback;
  }

  handle(
    event: string,
    data: StreamEventData | undefined,
    metadata?: Record<string, unknown>,
  ): void {
    if (!metadata) {
      console.warn(`Graph or metadata not found in ${event} event`);
      return;
    }
    const toolEndData = data as ToolEndData | undefined;
    if (!toolEndData?.output) {
      console.warn('No output found in tool_end event');
      return;
    }
    this.callback?.(toolEndData, metadata);
  }
}

export async function processMemory({
  res,
  userId,
  agentId,
  setMemory,
  deleteMemory,
  messages,
  memory,
  messageId,
  conversationId,
  validKeys,
  instructions,
  llmConfig,
  tokenLimit,
  totalTokens = 0,
  streamId = null,
  user,
  forceAgentScope = false,
}: {
  res: ServerResponse;
  setMemory: MemoryMethods['setMemory'];
  deleteMemory: MemoryMethods['deleteMemory'];
  userId: string | ObjectId;
  /** The persona currently in the conversation, if any (Kade-AI two-tier memory). */
  agentId?: string;
  memory: string;
  messageId: string;
  conversationId: string;
  messages: BaseMessage[];
  validKeys?: string[];
  instructions: string;
  tokenLimit?: number;
  totalTokens?: number;
  llmConfig?: Partial<LLMConfig>;
  streamId?: string | null;
  user?: IUser;
  /** When true, every write/delete is pinned to `agentId`'s bucket (used by agent-bucket consolidation). */
  forceAgentScope?: boolean;
}): Promise<(TAttachment | null)[] | undefined> {
  try {
    const memoryTool = createMemoryTool({
      userId,
      agentId,
      tokenLimit,
      setMemory,
      validKeys,
      totalTokens,
      forceAgentScope,
    });
    const deleteMemoryTool = createDeleteMemoryTool({
      userId,
      agentId,
      validKeys,
      deleteMemory,
      forceAgentScope,
    });

    const currentMemoryTokens = totalTokens;

    let memoryStatus = `# Existing memory:\n${memory ?? 'No existing memories'}`;

    if (tokenLimit) {
      const remainingTokens = tokenLimit - currentMemoryTokens;
      memoryStatus = `# Memory Status:
Current memory usage: ${currentMemoryTokens} tokens
Token limit: ${tokenLimit} tokens
Remaining capacity: ${remainingTokens} tokens

# Existing memory:
${memory ?? 'No existing memories'}`;
    }

    const defaultLLMConfig: LLMConfig = {
      provider: Providers.OPENAI,
      model: 'gpt-4.1-mini',
      temperature: 0.4,
      streaming: false,
      disableStreaming: true,
    };

    const finalLLMConfig = {
      ...defaultLLMConfig,
      ...normalizeMemoryLLMConfig(llmConfig),
      maxRetries: 0,
      /**
       * Ensure streaming is always disabled for memory processing
       */
      streaming: false,
      disableStreaming: true,
    } as LLMConfig;

    // Handle GPT-5+ models
    if ('model' in finalLLMConfig && /\bgpt-[5-9](?:\.\d+)?\b/i.test(finalLLMConfig.model ?? '')) {
      // Remove temperature for GPT-5+ models
      delete finalLLMConfig.temperature;

      // Move maxTokens to modelKwargs for GPT-5+ models
      if ('maxTokens' in finalLLMConfig && finalLLMConfig.maxTokens != null) {
        const modelKwargs = (finalLLMConfig as OpenAIClientOptions).modelKwargs ?? {};
        const paramName =
          (finalLLMConfig as OpenAIClientOptions).useResponsesApi === true
            ? 'max_output_tokens'
            : 'max_completion_tokens';
        modelKwargs[paramName] = finalLLMConfig.maxTokens;
        delete finalLLMConfig.maxTokens;
        (finalLLMConfig as OpenAIClientOptions).modelKwargs = modelKwargs;
      }
    }

    const bedrockConfig = finalLLMConfig as {
      additionalModelRequestFields?: { thinking?: unknown };
      temperature?: number;
    };
    if (
      llmConfig?.provider === Providers.BEDROCK &&
      bedrockConfig.additionalModelRequestFields?.thinking != null &&
      bedrockConfig.temperature != null
    ) {
      (finalLLMConfig as unknown as Record<string, unknown>).temperature = 1;
    }

    const anthropicConfig = finalLLMConfig as {
      thinking?: { type?: string };
      temperature?: number;
    };
    if (
      llmConfig?.provider === Providers.ANTHROPIC &&
      anthropicConfig.thinking?.type === 'enabled' &&
      anthropicConfig.temperature != null
    ) {
      delete (finalLLMConfig as Record<string, unknown>).temperature;
    }

    /**
     * Resolve request-based headers across provider-specific carriers (OpenAI
     * `configuration.defaultHeaders`, native Anthropic `clientOptions.defaultHeaders`)
     * so gateway-fronted built-in providers receive resolved metadata/auth headers
     * on memory extraction too. Native Google headers are resolved at init.
     */
    resolveConfigHeaders({
      llmConfig: finalLLMConfig as unknown as RunLLMConfig,
      user: user ? createSafeUser(user) : undefined,
      body: { conversationId, messageId },
    });

    const artifactPromises: Promise<TAttachment | null>[] = [];
    const memoryCallback = createMemoryCallback({ res, artifactPromises, streamId });
    const customHandlers = {
      [GraphEvents.TOOL_END]: new BasicToolEndHandler(memoryCallback),
    };

    /**
     * For Bedrock provider, include instructions in the user message instead of as a system prompt.
     * Bedrock's Converse API requires conversations to start with a user message, not a system message.
     * Other providers can use the standard system prompt approach.
     */
    const isBedrock = llmConfig?.provider === Providers.BEDROCK;

    let graphInstructions: string | undefined = instructions;
    let graphAdditionalInstructions: string | undefined = memoryStatus;
    let processedMessages = messages;

    if (isBedrock) {
      const combinedInstructions = [instructions, memoryStatus].filter(Boolean).join('\n\n');

      if (messages.length > 0) {
        const firstMessage = messages[0];
        const originalContent =
          typeof firstMessage.content === 'string' ? firstMessage.content : '';

        if (typeof firstMessage.content !== 'string') {
          logger.warn(
            'Bedrock memory processing: First message has non-string content, using empty string',
          );
        }

        const bedrockUserMessage = new HumanMessage(
          `${combinedInstructions}\n\n${originalContent}`,
        );
        processedMessages = [bedrockUserMessage, ...messages.slice(1)];
      } else {
        processedMessages = [new HumanMessage(combinedInstructions)];
      }

      graphInstructions = undefined;
      graphAdditionalInstructions = undefined;
    }

    const run = await Run.create({
      runId: messageId,
      graphConfig: {
        type: 'standard',
        llmConfig: finalLLMConfig,
        tools: [memoryTool, deleteMemoryTool],
        instructions: graphInstructions,
        additional_instructions: graphAdditionalInstructions,
        toolEnd: true,
      },
      customHandlers,
      returnContent: true,
    });

    const config = {
      runName: 'MemoryRun',
      configurable: {
        user_id: userId,
        thread_id: conversationId,
        provider: llmConfig?.provider,
      },
      streamMode: 'values',
      recursionLimit: 3,
      version: 'v2',
    } as const;

    const inputs = {
      messages: processedMessages,
    };
    const content = await run.processStream(inputs, config);
    if (content) {
      logger.debug('[MemoryAgent] Processed successfully', {
        userId,
        conversationId,
        messageId,
        provider: llmConfig?.provider,
      });
    } else {
      logger.debug('[MemoryAgent] Returned no content', { userId, conversationId, messageId });
    }
    return await Promise.all(artifactPromises);
  } catch (error) {
    logger.error(
      `[MemoryAgent] Failed to process memory | userId: ${userId} | conversationId: ${conversationId} | messageId: ${messageId}`,
      { error },
    );
  }
}

export async function createMemoryProcessor({
  res,
  userId,
  agentId,
  messageId,
  memoryMethods,
  conversationId,
  config = {},
  streamId = null,
  user,
}: {
  res: ServerResponse;
  messageId: string;
  conversationId: string;
  userId: string | ObjectId;
  /** The persona currently in the conversation, if any (Kade-AI two-tier memory). Omit/undefined = shared-only, identical to pre-existing behavior. */
  agentId?: string;
  memoryMethods: RequiredMemoryMethods;
  config?: MemoryConfig;
  streamId?: string | null;
  user?: IUser;
}): Promise<[string, (messages: BaseMessage[]) => Promise<(TAttachment | null)[] | undefined>]> {
  const { validKeys, instructions, llmConfig, tokenLimit } = config;

  /**
   * When there's an active agent, the tool's key enum grows by exactly one option
   * (`agent_notes`) so the memory-writer can choose to file something under that
   * one persona instead of the shared keys. This is a single combined LLM call per
   * turn either way -- no extra per-message cost from adding the second tier.
   */
  /**
   * With a curated validKeys list, an active persona adds exactly one extra option
   * (the legacy `agent_notes`). With NO validKeys configured (free-form "memory
   * cards" mode), keys stay unrestricted -- appending here would otherwise
   * accidentally lock the writer down to `agent_notes` only.
   */
  const effectiveValidKeys =
    agentId && validKeys && validKeys.length > 0
      ? [...validKeys, AGENT_SCOPED_MEMORY_KEY]
      : validKeys;
  const finalInstructions =
    instructions || getDefaultInstructions(effectiveValidKeys, tokenLimit, Boolean(agentId));

  const { withKeys, withoutKeys, totalTokens } = await memoryMethods.getFormattedMemories({
    userId,
    agentId,
  });

  return [
    withoutKeys,
    async function (messages: BaseMessage[]): Promise<(TAttachment | null)[] | undefined> {
      try {
        return await processMemory({
          res,
          userId,
          agentId,
          messages,
          validKeys: effectiveValidKeys,
          llmConfig,
          messageId,
          tokenLimit,
          streamId,
          conversationId,
          memory: withKeys,
          totalTokens: totalTokens || 0,
          instructions: finalInstructions,
          setMemory: memoryMethods.setMemory,
          deleteMemory: memoryMethods.deleteMemory,
          user,
        });
      } catch (error) {
        logger.error('Memory Agent failed to process memory', error);
      }
    },
  ];
}

/**
 * Memory-hygiene consolidation pass (Kade-AI build plan, Part 2). Reviews everything
 * currently ACTIVE in one bucket (the shared bucket, or one agent's own bucket) and
 * asks the memory-writer LLM to merge near-duplicates and tighten stale phrasing --
 * NOT to extract anything new. Reuses `processMemory` end-to-end (same tools, same
 * supersede-on-write behavior), so a consolidation write is indistinguishable at the
 * data layer from a normal one.
 *
 * `res` is optional because this is meant to be triggered outside of a live chat
 * turn (an admin/self-serve route, or eventually a schedule) -- when omitted, a
 * stub is used so `processMemory`'s artifact handling just resolves quietly instead
 * of trying to write to a real HTTP stream.
 */
export async function consolidateMemoryBucket({
  res,
  userId,
  agentId,
  scopeLabel,
  memoryMethods,
  llmConfig,
  tokenLimit,
  user,
}: {
  res?: ServerResponse;
  userId: string | ObjectId;
  /** null/undefined = the shared bucket; an agent's string id = just that agent's own bucket. */
  agentId?: string | null;
  /** Human-readable label dropped into the prompt, e.g. "shared" or "Kiana's own". */
  scopeLabel: string;
  memoryMethods: RequiredMemoryMethods;
  llmConfig?: Partial<LLMConfig>;
  tokenLimit?: number;
  user?: IUser;
}): Promise<{ ran: boolean; attachments?: (TAttachment | null)[] }> {
  const resolvedAgentId = agentId ?? undefined;
  const { withKeys, totalTokens } = await memoryMethods.getFormattedMemories({
    userId,
    agentId: resolvedAgentId,
    onlyThisBucket: true,
  });

  if (!withKeys) {
    logger.debug('[MemoryAgent] Consolidation skipped -- bucket is empty', {
      userId,
      scopeLabel,
    });
    return { ran: false };
  }

  const instructions = `You are doing routine housekeeping on your own memory, NOT extracting anything new from a conversation.

Below is everything currently active in the "${scopeLabel}" memory bucket. The target shape is MEMORY CARDS: each entry covers exactly ONE topic, in one or two plain sentences (aim under ~60 tokens), under a short descriptive snake_case key that names the topic (e.g. "dad_health", "concert_crew", "cat_kasper"). Your jobs, in priority order:
1. SPLIT: if an entry lumps several unrelated topics together, break it into separate cards -- \`set_memory\` each new topic under its own new key, then \`set_memory\` the original key down to just its remaining topic (or \`delete_memory\` it if nothing is left).
2. MERGE: if entries are near-duplicates or say overlapping things about the same topic, combine them into ONE card and \`delete_memory\` the leftovers.
3. TIGHTEN: rewrite verbose, repetitive, or stale-phrased cards more concisely with \`set_memory\` on the same key. Keep the human substance -- what matters and why -- not a log of how it came up.
4. PRUNE: \`delete_memory\` cards that are obsolete, contradicted by a newer card, or were never really durable (one-off task chatter, moment-only details).

Emit ALL of your set_memory/delete_memory calls together in a single response. Do NOT invent facts that are not already present below. Do NOT erase information that is still true just to shorten things -- tighten phrasing, don't erase substance. If everything already looks like clean one-topic cards, do nothing and end the turn immediately.`;

  const consolidationRequest = new HumanMessage(
    `Here is everything currently active in the "${scopeLabel}" memory bucket:\n\n${withKeys}\n\nReview it per your instructions.`,
  );

  const stubRes = { headersSent: false } as unknown as ServerResponse;
  const attachments = await processMemory({
    res: res ?? stubRes,
    userId,
    agentId: resolvedAgentId,
    setMemory: memoryMethods.setMemory,
    deleteMemory: memoryMethods.deleteMemory,
    messages: [consolidationRequest],
    memory: withKeys,
    messageId: `consolidation-${Date.now()}`,
    conversationId: `consolidation-${userId}-${resolvedAgentId ?? 'shared'}`,
    /** Free-form keys in BOTH buckets (memory-cards mode); forceAgentScope pins agent-bucket writes in-bucket so card splits can't leak into shared. */
    validKeys: undefined,
    instructions,
    forceAgentScope: Boolean(resolvedAgentId),
    llmConfig,
    tokenLimit,
    totalTokens: totalTokens || 0,
    user,
  });

  return { ran: true, attachments };
}

/**
 * Narrows `memory.agent` (from librechat.yaml) to the LLM-based shape (provider +
 * model), as opposed to the alternate "point at an existing Agent id" shape. Both
 * the on-demand consolidate route and the platform-wide sweep need this same check.
 */
function getMemoryAgentLLMSpec(memoryConfig: TMemoryConfig | undefined): {
  provider: string;
  model: string;
  model_parameters?: Record<string, unknown>;
} | null {
  const agent = memoryConfig?.agent as
    | { provider?: string; model?: string; model_parameters?: Record<string, unknown> }
    | undefined;
  if (!agent?.provider || !agent?.model) {
    return null;
  }
  return {
    provider: agent.provider,
    model: agent.model,
    model_parameters: agent.model_parameters,
  };
}

/**
 * Resolves the memory-writer LLM's real credentials (apiKey/baseURL/etc.) from
 * `memory.agent.provider` (e.g. "OpenRouter" -- usually a CUSTOM endpoint, not a
 * first-party provider recognized directly by the LLM-run library). Shared by the
 * on-demand `/consolidate` route (real `req`, real logged-in user) and the
 * platform-wide weekly sweep (no live HTTP request -- a minimal synthetic `req` is
 * built from just `appConfig` + `userId`, which is all `initializeCustom` actually
 * reads for a provider configured with an env-var apiKey/baseURL like ours).
 *
 * Skipping this and hand-building `{ provider, model }` directly is what broke the
 * first version of the on-demand route -- it silently had no apiKey/baseURL at all.
 */
export async function resolveMemoryAgentLLMConfig({
  appConfig,
  memoryConfig,
  userId,
  tenantId,
  req,
  db,
}: {
  appConfig: AppConfig;
  memoryConfig: TMemoryConfig | undefined;
  userId: string;
  tenantId?: string;
  /** Pass the real Express request when available (the on-demand route always has one). */
  req?: ServerRequest;
  db: EndpointDbMethods;
}): Promise<Partial<LLMConfig>> {
  const spec = getMemoryAgentLLMSpec(memoryConfig);
  if (!spec) {
    throw new Error(
      'No memory-writer provider/model configured (memory.agent.provider / memory.agent.model in librechat.yaml).',
    );
  }

  const { getOptions, overrideProvider } = getProviderConfig({
    provider: spec.provider,
    appConfig,
  });

  const effectiveReq =
    req ??
    ({
      config: appConfig,
      body: {},
      user: { id: userId, tenantId },
    } as unknown as ServerRequest);

  const resolved = await getOptions({
    req: effectiveReq,
    endpoint: spec.provider,
    model_parameters: { model: spec.model, ...spec.model_parameters },
    db,
  });

  return {
    provider: resolved.provider ?? overrideProvider,
    ...resolved.llmConfig,
    configuration: resolved.configOptions,
  } as Partial<LLMConfig>;
}

type MemoryConsolidationMethods = RequiredMemoryMethods & {
  getActiveMemoryBuckets: () => Promise<MemoryBucketRef[]>;
};

export type MemoryConsolidationSweepLogger = Pick<typeof logger, 'info' | 'warn' | 'error' | 'debug'>;

export interface MemoryConsolidationSweepOptions {
  appConfig?: AppConfig;
  /** Re-fetches the latest config at sweep time (mirrors files/sweep.ts) so a librechat.yaml edit takes effect without a restart. */
  loadAppConfig?: () => Promise<AppConfig | null | undefined>;
}

export interface MemoryConsolidationSweepResult {
  scanned: number;
  consolidated: number;
  skipped: number;
  failed: number;
}

/**
 * Platform-wide memory-hygiene pass (Kade-AI build plan, Part 2 -- the corrected,
 * server-only design). Iterates EVERY (user, bucket) pair on the whole platform
 * that currently has active memory content -- not just one account -- and runs
 * the exact same consolidation used by the on-demand route for each one. One
 * bucket failing (bad config, model hiccup, etc.) never stops the rest; each is
 * independently caught and counted.
 */
export async function sweepMemoryConsolidation(
  options: MemoryConsolidationSweepOptions | undefined = {},
  {
    memoryMethods,
    db,
    logger: sweepLogger,
  }: {
    memoryMethods: MemoryConsolidationMethods;
    db: EndpointDbMethods;
    logger: MemoryConsolidationSweepLogger;
  },
): Promise<MemoryConsolidationSweepResult> {
  const { appConfig: initialAppConfig, loadAppConfig } = options;
  const appConfig =
    typeof loadAppConfig === 'function'
      ? (await loadAppConfig()) ?? initialAppConfig
      : initialAppConfig;

  const result: MemoryConsolidationSweepResult = {
    scanned: 0,
    consolidated: 0,
    skipped: 0,
    failed: 0,
  };

  if (!appConfig) {
    sweepLogger.warn('[sweepMemoryConsolidation] No app config available -- skipping this run.');
    return result;
  }

  const memoryConfig = appConfig.memory;
  if (!memoryConfig || memoryConfig.disabled === true) {
    sweepLogger.info('[sweepMemoryConsolidation] Memory is disabled -- nothing to do.');
    return result;
  }

  if (!getMemoryAgentLLMSpec(memoryConfig)) {
    sweepLogger.warn(
      '[sweepMemoryConsolidation] No memory-writer provider/model configured -- skipping this run.',
    );
    return result;
  }

  const buckets = await memoryMethods.getActiveMemoryBuckets();
  sweepLogger.info(
    `[sweepMemoryConsolidation] Starting sweep across ${buckets.length} active bucket(s).`,
  );

  for (const bucket of buckets) {
    result.scanned++;
    const userId = String(bucket.userId);
    const agentId = bucket.agentId ?? undefined;
    const scopeLabel = agentId
      ? `agent ${agentId}'s own (key: ${AGENT_SCOPED_MEMORY_KEY})`
      : 'shared';

    try {
      const llmConfig = await resolveMemoryAgentLLMConfig({
        appConfig,
        memoryConfig,
        userId,
        db,
      });

      const { ran } = await consolidateMemoryBucket({
        userId,
        agentId,
        scopeLabel,
        memoryMethods,
        llmConfig,
        tokenLimit: memoryConfig.tokenLimit,
      });

      if (ran) {
        result.consolidated++;
      } else {
        result.skipped++;
      }
    } catch (error) {
      result.failed++;
      sweepLogger.error(
        `[sweepMemoryConsolidation] Failed consolidating user ${userId}'s ${scopeLabel} bucket:`,
        error,
      );
    }
  }

  sweepLogger.info(
    `[sweepMemoryConsolidation] Done: ${result.scanned} scanned, ${result.consolidated} consolidated, ${result.skipped} already-clean, ${result.failed} failed.`,
  );

  return result;
}

const DEFAULT_MEMORY_CONSOLIDATION_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** Sunday, matching the existing daily Mongo backup's off-peak slot. */
const DEFAULT_MEMORY_CONSOLIDATION_TARGET_UTC_DAY = 0;
const DEFAULT_MEMORY_CONSOLIDATION_TARGET_UTC_HOUR = 9;
const DEFAULT_MEMORY_CONSOLIDATION_MIN_GAP_MS = 6 * 24 * 60 * 60 * 1000;

export function getMemoryConsolidationCheckInterval(
  interval: string | undefined = process.env.MEMORY_CONSOLIDATION_SWEEP_INTERVAL_MS,
): number {
  if (interval == null || interval.trim() === '') {
    return DEFAULT_MEMORY_CONSOLIDATION_CHECK_INTERVAL_MS;
  }
  const value = Number(interval);
  if (!Number.isFinite(value) || value < 0 || (value > 0 && value < 1)) {
    return DEFAULT_MEMORY_CONSOLIDATION_CHECK_INTERVAL_MS;
  }
  return value;
}

/**
 * NaN-safe integer env reader for the weekly sweep's target slot. Same
 * silent-fallback contract as getMemoryConsolidationCheckInterval: unset,
 * blank, non-integer, or out-of-range values yield the default. The effective
 * slot is echoed in the scheduler's startup log line so a glance at the
 * Railway logs confirms what it's actually set to.
 */
function getTargetIntEnv(
  raw: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (raw == null || raw.trim() === '') {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return defaultValue;
  }
  return value;
}

/** UTC day-of-week (0=Sunday..6=Saturday) the weekly sweep targets. */
export function getMemoryConsolidationTargetUtcDay(
  raw: string | undefined = process.env.MEMORY_CONSOLIDATION_SWEEP_DAY,
): number {
  return getTargetIntEnv(raw, DEFAULT_MEMORY_CONSOLIDATION_TARGET_UTC_DAY, 0, 6);
}

/** UTC hour (0-23) the weekly sweep targets. */
export function getMemoryConsolidationTargetUtcHour(
  raw: string | undefined = process.env.MEMORY_CONSOLIDATION_SWEEP_HOUR,
): number {
  return getTargetIntEnv(raw, DEFAULT_MEMORY_CONSOLIDATION_TARGET_UTC_HOUR, 0, 23);
}

/**
 * True exactly once per week's target window: the wall-clock UTC day+hour match
 * AND at least `minGapMs` has passed since the last confirmed run (the persisted
 * marker, not just "was this the right hour" -- a redeploy that bounces the
 * process twice inside the same target hour must not double-fire).
 */
export function isMemoryConsolidationSweepDue({
  now,
  lastRunAt,
  targetUtcDay = DEFAULT_MEMORY_CONSOLIDATION_TARGET_UTC_DAY,
  targetUtcHour = DEFAULT_MEMORY_CONSOLIDATION_TARGET_UTC_HOUR,
  minGapMs = DEFAULT_MEMORY_CONSOLIDATION_MIN_GAP_MS,
}: {
  now: Date;
  lastRunAt?: Date | null;
  targetUtcDay?: number;
  targetUtcHour?: number;
  minGapMs?: number;
}): boolean {
  if (now.getUTCDay() !== targetUtcDay || now.getUTCHours() !== targetUtcHour) {
    return false;
  }
  if (lastRunAt && now.getTime() - lastRunAt.getTime() < minGapMs) {
    return false;
  }
  return true;
}

/**
 * Boots the platform-wide weekly consolidation sweep. Entirely self-contained on
 * this server: an hourly `setInterval` wall-clock check + a persisted last-run
 * marker in Mongo (via `getLastSweepRunAt`/`setLastSweepRunAt`), no external
 * scheduler and no dependency on any Claude/Cowork session being available --
 * this must keep running even if Kade's Claude credit runs out. Mirrors the
 * file-retention sweep pattern (`files/sweep.ts`), except it deliberately does
 * NOT run immediately at boot (a redeploy shouldn't ever trigger a real
 * consolidation pass -- only the actual weekly window should).
 */
export function startMemoryConsolidationSweep(
  options: MemoryConsolidationSweepOptions | undefined = {},
  {
    memoryMethods,
    db,
    getLastSweepRunAt,
    setLastSweepRunAt,
    runAsSystem,
    logger: sweepLogger,
  }: {
    memoryMethods: MemoryConsolidationMethods;
    db: EndpointDbMethods;
    getLastSweepRunAt: () => Promise<Date | null | undefined>;
    setLastSweepRunAt: (date: Date) => Promise<void>;
    runAsSystem: <T>(fn: () => Promise<T>) => Promise<T>;
    logger: MemoryConsolidationSweepLogger;
  },
): NodeJS.Timeout | null {
  const intervalMs = getMemoryConsolidationCheckInterval();
  if (intervalMs === 0) {
    sweepLogger.info(
      '[sweepMemoryConsolidation] Disabled by MEMORY_CONSOLIDATION_SWEEP_INTERVAL_MS=0',
    );
    return null;
  }

  const targetUtcDay = getMemoryConsolidationTargetUtcDay();
  const targetUtcHour = getMemoryConsolidationTargetUtcHour();

  let isSweeping = false;
  const checkAndMaybeRun = async () => {
    if (isSweeping) {
      return;
    }

    isSweeping = true;
    try {
      const now = new Date();
      const lastRunAt = await runAsSystem(() => getLastSweepRunAt());
      if (!isMemoryConsolidationSweepDue({ now, lastRunAt, targetUtcDay, targetUtcHour })) {
        return;
      }

      sweepLogger.info(
        '[sweepMemoryConsolidation] Weekly window reached -- starting platform-wide sweep.',
      );
      await runAsSystem(() => setLastSweepRunAt(now));
      await runAsSystem(() =>
        sweepMemoryConsolidation(options, { memoryMethods, db, logger: sweepLogger }),
      );
    } catch (error) {
      sweepLogger.error('[sweepMemoryConsolidation] Background sweep failed:', error);
    } finally {
      isSweeping = false;
    }
  };

  const interval = setInterval(checkAndMaybeRun, intervalMs);
  interval.unref?.();
  sweepLogger.info(
    `[sweepMemoryConsolidation] Scheduler started -- checking hourly, fires on UTC day ${targetUtcDay} (0=Sunday) at hour ${targetUtcHour} UTC (server-side only, no external dependency).`,
  );
  return interval;
}

async function handleMemoryArtifact({
  res,
  data,
  metadata,
  streamId = null,
}: {
  res: ServerResponse;
  data: ToolEndData;
  metadata?: ToolEndMetadata;
  streamId?: string | null;
}) {
  const output = data?.output as ToolMessage | undefined;
  if (!output) {
    return null;
  }

  if (!output.artifact) {
    return null;
  }

  const memoryArtifact = output.artifact[Tools.memory] as MemoryArtifact | undefined;
  if (!memoryArtifact) {
    return null;
  }

  const attachment: Partial<TAttachment> = {
    type: Tools.memory,
    toolCallId: output.tool_call_id,
    messageId: metadata?.run_id ?? '',
    conversationId: metadata?.thread_id ?? '',
    [Tools.memory]: memoryArtifact,
  };
  if (!res.headersSent) {
    return attachment;
  }
  if (streamId) {
    GenerationJobManager.emitChunk(streamId, { event: 'attachment', data: attachment });
  } else {
    res.write(`event: attachment\ndata: ${JSON.stringify(attachment)}\n\n`);
  }
  return attachment;
}

/**
 * Creates a memory callback for handling memory artifacts
 * @param params - The parameters object
 * @param params.res - The server response object
 * @param params.artifactPromises - Array to collect artifact promises
 * @param params.streamId - The stream ID for resumable mode, or null for standard mode
 * @returns The memory callback function
 */
export function createMemoryCallback({
  res,
  artifactPromises,
  streamId = null,
}: {
  res: ServerResponse;
  artifactPromises: Promise<Partial<TAttachment> | null>[];
  streamId?: string | null;
}): ToolEndCallback {
  return async (data: ToolEndData, metadata?: Record<string, unknown>) => {
    const output = data?.output as ToolMessage | undefined;
    const memoryArtifact = output?.artifact?.[Tools.memory] as MemoryArtifact;
    if (memoryArtifact == null) {
      return;
    }
    artifactPromises.push(
      handleMemoryArtifact({ res, data, metadata, streamId }).catch((error) => {
        logger.error('Error processing memory artifact content:', error);
        return null;
      }),
    );
  };
}
