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

/**
 * KADE CANON (Sep 4 2026, Part 123). A character's own life is not about any one
 * user, so it cannot live in a (userId, agentId) bucket -- that is what the
 * "agent" bucket is, and it is per PERSON. Her constraint, verbatim: "if she
 * tells my mom about some auntie, and doesn't know what I'm talking about when
 * I mention it, see how that becomes a problem." So a self-fact the character
 * improvises is filed ONCE, under this fixed owner id, scoped to the character
 * (agentId), and read back into every conversation that character has -- the
 * same aunt for Amber, for her mom, and for her. The id is a valid ObjectId
 * that no User row will ever own; every existing memory route (admin-list,
 * retire, set) reaches the canon by passing it as `userId`.
 */
export const CANON_USER_ID = '000000000000000000000ca0';
export const CANON_HEADER =
  '# Your own life — canon\n' +
  'Things YOU have said about your own life, to anyone, so far. They are the same for every person you talk to. ' +
  'Never contradict them. You may add to them when a story genuinely calls for it — once said, it is remembered here and you tell it the same way next time. ' +
  'They are yours to carry, not to prove: never present them as real-world facts anyone could check, and never turn them into claims about the person you are talking to.';

/** ---- Kade nudge engine: US-Central wall-time helpers (family is all Missouri; DST-safe) ---- */
function chicagoPartsOf(date: Date): { y: number; m: number; d: number; hh: number; mm: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    parts[p.type] = p.value;
  }
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hh: Number(parts.hour === '24' ? 0 : parts.hour),
    mm: Number(parts.minute),
  };
}

/** "YYYY-MM-DD HH:mm" Central wall time -> UTC Date; null if unparseable. Mirrors api/server/services/kadeNudges.js. */
export function parseCentralReminderTime(str: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
  if (!m) {
    return null;
  }
  const [y, mo, d, hh, mm] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  for (const offsetHours of [5, 6]) {
    const candidate = new Date(Date.UTC(y, mo - 1, d, hh + offsetHours, mm));
    const back = chicagoPartsOf(candidate);
    if (back.y === y && back.m === mo && back.d === d && back.hh === hh && back.mm === mm) {
      return candidate;
    }
  }
  const fallback = new Date(Date.UTC(y, mo - 1, d, hh + 6, mm));
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/** Human-readable current Central date/time line injected into the memory-writer's status block. */
export function centralNowLine(): string {
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(now);
  const p = chicagoPartsOf(now);
  const iso = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
  return `Current date/time (US Central): ${dateStr} [${iso}]`;
}

function normalizeMemoryLLMConfig(llmConfig?: Partial<LLMConfig>): SanitizedMemoryLLMConfig {
  const config = { ...(llmConfig ?? {}) } as Record<string, unknown>;
  if (typeof config.apiKey !== 'string') {
    delete config.apiKey;
  }
  return config as SanitizedMemoryLLMConfig;
}

export const memoryInstructions: string =
  'The system automatically stores important user information and can update or delete memories based on user requests, enabling dynamic memory management. ' +
  'Treat these memories as private knowledge, not a script: sensitive ones (health, body, medications, money, private struggles) are things the user trusted you with — ' +
  'keep them in mind, but use judgment about when to raise them. Bring them up only when clearly relevant or when the user opens the topic; never recite them back unprompted.';

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
    async ({ key, value, scope, remind_at, remind_repeat, stale_after, subject }) => {
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
          agentId && (forceAgentScope || scope === 'agent' || scope === 'self' || key === AGENT_SCOPED_MEMORY_KEY)
            ? agentId
            : undefined;
        /** KADE CANON: scope "self" files the CHARACTER's own autobiography under the
         * fixed canon owner, not under this user -- one fact, every seat. Only when a
         * character is active; with no agentId there is nobody to be canon about. */
        const canon = scope === 'self' && Boolean(agentId) && !forceAgentScope;
        const targetUserId = canon ? CANON_USER_ID : userId;
        /** Reminder cards (Kade nudge engine): a parseable remind_at upgrades this card to type:'reminder' with a real dueAt the server sweep will fire. */
        const dueAt = remind_at ? parseCentralReminderTime(remind_at) : null;
        /** KADE OPEN LOOPS (Aug 26 2026): a plain YYYY-MM-DD, anchored at UTC
         * noon so no timezone can shift it across a day boundary. Anything
         * unparseable is dropped rather than guessed — a wrong stale date is
         * worse than none. */
        const staleAfter = (() => {
          if (!stale_after || !/^\d{4}-\d{2}-\d{2}$/.test(String(stale_after).trim())) return null;
          const d = new Date(`${String(stale_after).trim()}T12:00:00.000Z`);
          return isNaN(d.getTime()) ? null : d;
        })();
        if (remind_at && !dueAt) {
          return [
            `Could not parse remind_at "${remind_at}" — use 24h US Central time formatted exactly as YYYY-MM-DD HH:mm. Memory NOT saved; retry with a valid time.`,
            undefined,
          ];
        }
        /** recurrence: null (not undefined) when a fresh remind_at has no repeat —
         * setMemory inherits omitted fields from the superseded entry (July 13
         * wipe guard), so an explicit null is what clears a previous repeat. */
        const reminderFields = dueAt
          ? {
              type: 'reminder' as const,
              dueAt,
              recurrence: remind_repeat && remind_repeat !== 'none' ? remind_repeat : null,
              completed: false,
            }
          : {};
        const result = await setMemory({
          userId: targetUserId,
          agentId: targetAgentId,
          key,
          value,
          tokenCount,
          ...(canon ? { subject: 'canon' } : {}),
          ...reminderFields,
          /* Omitted (undefined) INHERITS from the superseded row — the July 13
           * wipe guard. Only an explicit value here changes anything. */
          ...(staleAfter ? { staleAfter } : {}),
          ...(subject ? { subject: String(subject).trim().slice(0, 64) } : {}),
        });
        if (result.ok && result.unchanged) {
          /* July 13 2026: identical re-save — no artifact, so the chat UI shows
           * NO "updated memory" bubble (Kade saw one before every message when
           * the writer kept re-affirming the same card), and the reply coaches
           * the writer out of the habit. */
          logger.debug(`Memory unchanged for key "${key}" for user "${userId}" — re-save skipped`);
          return [
            `"${key}" is already saved exactly like that — no update made. Facts already in your memory list do not need re-saving unless their substance changes; prefer ending the turn with no calls.`,
            undefined,
          ];
        }
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
          .enum(['shared', 'agent', 'self'])
          .optional()
          .describe(
            'Where this card lives: "shared" = visible to every assistant on the platform (default); "agent" = private to you, the current character, only; "self" = the CHARACTER\'s own autobiography (a relative, a hometown, a past job, a thing that happened to the character) — filed once and shown to the character in EVERY conversation with anyone, so it never contradicts itself. Never "self" for anything about the user. Ignored when no character is active.',
          ),
        remind_at: z
          .string()
          .optional()
          .describe(
            'ONLY when the user asks to be reminded: the moment the reminder should fire, as 24h US Central time formatted exactly "YYYY-MM-DD HH:mm" (compute it from the current date/time in your status block). The card then becomes a real scheduled reminder.',
          ),
        remind_repeat: z
          .enum(['none', 'daily', 'weekly', 'monthly', 'yearly'])
          .optional()
          .describe('How the reminder repeats after it fires. Omit or "none" for one-shot.'),
        stale_after: z
          .string()
          .optional()
          .describe(
            'ONLY when this card states a PLAN rather than a RECORD — something scheduled that will be over on a known day ("surgery is Thursday August 27, 2026", "flight lands March 3, 2027"). Give that day as "YYYY-MM-DD". After it passes, the card is shown as unconfirmed until somebody says what happened. Do NOT set this on things that already happened ("got certified July 22", "saw the show July 28") — those stay true forever and are not plans.',
          ),
        subject: z
          .string()
          .optional()
          .describe(
            'The real-world THING this card is about, as a short snake_case name ("mom_foot_surgery", "the_nashville_trip"). Use the SAME subject on every card touching that one thing, so it can be updated as a whole later. Only for situations that genuinely span several cards — most cards need no subject.',
          ),
      }),
    },
  );
};

/**
 * Creates a delete memory tool instance with user context
 */
export const createDeleteMemoryTool = ({
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
          agentId && (forceAgentScope || scope === 'agent' || scope === 'self' || key === AGENT_SCOPED_MEMORY_KEY)
            ? agentId
            : undefined;
        const canon = scope === 'self' && Boolean(agentId) && !forceAgentScope;
        const result = await deleteMemory({ userId: canon ? CANON_USER_ID : userId, agentId: targetAgentId, key });
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
          .enum(['shared', 'agent', 'self'])
          .optional()
          .describe(
            'Which bucket the card lives in: "shared" (default), "agent" (your own private card about this user), or "self" (the character\'s own canon). Ignored when no character is active.',
          ),
      }),
    },
  );
};

/**
 * KADE LIVING DIARY (Aug 7 2026) — the write half of Tier 2. The api layer
 * passes a `logDiary` function down (keeps this package free of server model
 * imports, exactly like setMemory/deleteMemory); when present, the keeper
 * gains a third tool: `log_diary`, for dated episodic entries that belong in
 * the unbounded archive instead of the 8K always-injected hot core.
 */
export type DiaryLogFn = (params: {
  text: string;
  scope?: 'agent' | 'shared';
  /** MEMORY QUALITY PACK (Aug 9 2026): 1 ordinary / 2 notable / 3 big — retrieval weights by it. */
  salience?: number;
}) => Promise<{ ok: boolean; date?: string; error?: string }>;

const createDiaryTool = ({ logDiary }: { logDiary: DiaryLogFn }): DynamicStructuredTool => {
  return tool(
    async ({ text, scope, salience }) => {
      try {
        const result = await logDiary({ text, scope, salience });
        if (result.ok) {
          return `Diary entry logged for ${result.date ?? 'today'}.`;
        }
        return `Could not log diary entry: ${result.error ?? 'unknown error'}`;
      } catch (error) {
        logger.error('Memory Agent failed to log diary entry', error);
        return 'Error logging diary entry';
      }
    },
    {
      name: 'log_diary',
      description:
        "Logs one dated entry to the user's private LOGBOOK — the archive for day-to-day LIFE (what happened, what they did, how today went), as opposed to set_memory's durable identity cards. The logbook is unlimited and costs nothing per-turn; entries resurface later only when relevant. Write one or two plain sentences capturing the moment like a thoughtful friend's journal would.",
      schema: z.object({
        text: z
          .string()
          .describe(
            'The diary line itself: one or two plain sentences about what happened or how things are going, written in third person about the user ("Spent the afternoon re-watching VHS commercial tapes and loved it"). No dates inside the text — the entry is dated automatically.',
          ),
        scope: z
          .enum(['agent', 'shared'])
          .optional()
          .describe(
            'Who may recall this later. "agent" (default): only the character who was told — the right choice for almost everything, same privacy rule as cards. "shared" only for things every character would need.',
          ),
        salience: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .describe(
            'How much this day matters: 1 (default) ordinary note, 2 a notable day, 3 a big one — a loss, family news, a health scare, a real milestone, a day they will remember in a year. Most entries are 1; be honest, not generous.',
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
  logDiary,
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
  /** KADE diary (Aug 7 2026): when provided, the keeper also gets `log_diary` for episodic archive entries. */
  logDiary?: DiaryLogFn;
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

    const nowLine = centralNowLine();
    let memoryStatus = `${nowLine}\n\n# Existing memory:\n${memory ?? 'No existing memories'}`;

    if (tokenLimit) {
      const remainingTokens = tokenLimit - currentMemoryTokens;
      memoryStatus = `${nowLine}

# Memory Status:
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
        tools: logDiary ? [memoryTool, deleteMemoryTool, createDiaryTool({ logDiary })] : [memoryTool, deleteMemoryTool],
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
  logDiary,
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
  /** KADE diary (Aug 7 2026): api-layer write function; presence turns the diary lane on for this run. */
  logDiary?: DiaryLogFn;
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
  let finalInstructions =
    instructions || getDefaultInstructions(effectiveValidKeys, tokenLimit, Boolean(agentId));
  /** KADE diary (Aug 7 2026): teach the keeper the card/diary split. Appended in
   * CODE (not librechat.yaml) so the rule ships atomically with the tool that
   * needs it — a keeper can never see this text without log_diary existing, or
   * the tool without the text. Her four design answers are recorded in
   * MEMORY_TIERED_DIARY_DESIGN_2026-08-07.md. */
  if (logDiary) {
    finalInstructions +=
      '\n\nTHE LOGBOOK (log_diary): beside the cards there is a dated logbook — the unlimited archive for day-to-day LIFE. The split: CARDS answer "who is this person" (identity, people and pets, tastes, health, running projects — durable facts worth carrying into every future conversation). The LOGBOOK answers "what happened" (what they did today, how it went, a moment, a mood, a small win or gripe — real but episodic). When the user shares a genuine moment of their day, log ONE entry: one or two plain sentences, gist not transcript, written like a caring friend\'s journal. Never file the same thing as both a card and a logbook entry — pick by durability. The "most turns save NOTHING" rule still governs CARDS; a logbook line is lighter-weight, but still only for real moments actually shared, never for questions, task chatter, or assistant work. Asking you to CHECK, search, or read back memory or the logbook is task chatter — never log the asking; the logbook records their LIFE, not their use of you. The tell: if the entry you are about to write mentions the logbook, diary, memory, searching, or whether something is worth recording, STOP — that is the mechanism describing itself, and the correct move is NO tool call at all. An empty turn is success. Logbook entries default to your own scope (private to this character), like cards. "Remember X" still means a CARD; things like "log this," "note that down," or plain day-sharing lean LOGBOOK. CURIOSITY IS A STORY TOO (her own rule, Aug 8): when the user goes down a real rabbit hole with you — asks, digs, reacts, clearly enjoys it — that day deserves ONE light logbook line naming what caught them and the gem that landed ("Got curious about South Park\'s business side — turns out Trey Parker\'s legal name is Randolph Severn Parker III"). The subject of a question is STILL never a card and never an interest; but the going-down-the-rabbit-hole is a moment of their life, and the logbook is where days like that live. A passing one-line question is not a rabbit hole — log the dig, not the drive-by. IN-WORLD PLAY IS FICTION (the Barnaby lesson, extended): when the conversation is a game session — the city beyond the Threshold Gate, a card table, a text adventure, any roleplay world — the events INSIDE it are not the user\'s real life and are NEVER logged as such (the game worlds keep their own chronicles). The real-life moment, if any, is that they played: at most one line like "spent the evening exploring the city with Porter," and only when the session was clearly a real chunk of their day. No in-world deaths, purchases, crimes, or dramas ever become logbook entries or cards.' +
      '\n\nHOW AN ENTRY SHOULD READ (the taste rules, Aug 9 2026 — she read the logbook and it read like a standup log; that is the failure mode): write every entry like a close friend keeping a journal, never a court reporter. "Has anxiety about calling the SSA" is a case file; "The SSA phone line stresses her out — honestly, fair" is a friend. Keep the fact exact, add the small human touch, and never use clinical framings ("exhibits", "reports that", "is experiencing"). WORK EARNS ALMOST NOTHING: when the day with you was a work or build session — coding, debugging, testing, directing tasks — that whole session earns AT MOST one line, and only if something actually landed that a friend would hear about ("finally shipped the World screen and was proud of it"); "spent the afternoon debugging" is not an entry, and forty of them is the standup log nobody wants. Life said mid-work (the dog, the family, how they feel) still counts normally. WEIGH THE DAY: log_diary takes a salience — 1 ordinary (the default and the usual truth), 2 a notable day, 3 a big one (a loss, family news, a health scare, a real milestone). Set it honestly; the platform makes big days outrank product notes when memories resurface.' +
      '\n\nCORRECTIONS LAND IMMEDIATELY: when the user corrects a fact you hold ("no, the surgery moved to Friday", "we renamed the dog"), fix it in the same breath — set_memory on the SAME key with the corrected whole truth (or the corrected logbook line) — and never argue with them about what the old note said. The person is always righter than the card.' +
      '\n\n⚠️ AND A CANCELLATION IS A FACT — THIS IS THE ONE THAT GOT MISSED, AND IT HAS A RECEIPT. On Aug 26 2026 a family member said in the morning that her mother\'s surgery had been called off. Nothing was filed. Her cards still held SEVEN separate notes saying that surgery was happening — the date, the pre-op, the anaesthesia plan, the recovery window, the surgical detail, the calendar, an aside about her aunt — and not one saying it was cancelled, so hours later the surgery got named back to her as if it were still on. FILE THE ENDINGS: cancellations, postponements, break-ups, quittings, deaths, "we\'re not doing that any more", "she\'s not coming after all". A thing that STOPS happening is far easier to forget to write down than a thing that starts, and it does more damage, because the old plan is still sitting in the record looking current.' +
      '\n\nONE THING, MANY CARDS — USE `subject`. That surgery was spread over seven keys, so "update the SAME key" had no correct answer and a perfectly obedient fix would still have left six cards stale. When several cards are about ONE real-world situation, give them all the SAME short `subject` ("mom_foot_surgery"). Then an update can reach the whole thing instead of one seventh of it. Most cards need no subject — this is for situations that genuinely sprawl. When you correct something that has a subject, fix EVERY card carrying it that is now wrong, not just the one that came to mind.' +
      '\n\nPLANS GO STALE, RECORDS DO NOT — USE `stale_after`. A card is not always a fact. "Her favourite Grey\'s character is Bailey" is true forever. "Mom\'s foot surgery is Thursday August 27, 2026" is a CLAIM ABOUT THE FUTURE that goes false on a known day. When you file a plan — an appointment, a trip, a procedure, a deadline, a visit — set `stale_after` to the day it will be over, as YYYY-MM-DD. After that day the card is shown to you as unconfirmed, so you ask instead of announce. ⚠️ DO NOT set it on things that already happened: "got CPR certified July 22", "saw Shinedown July 28", "the dog died in 2025" are RECORDS and stay true forever. The test is the tense, never the presence of a date.' +
      '\n\nPROMISES: when the CHARACTER makes a concrete commitment to the user ("I\'ll have the second verse tomorrow," "remind me to ask how the appointment went"), file an agent-scoped card under a key starting promise_ with what was promised and when it\'s due. When a promise is delivered or clearly dead, delete its card. Promises are the character\'s own word — keeping them is what makes the character real.' +
      '\n\nOFF THE RECORD: if the user has said "off the record" in the visible conversation and has not since said they\'re back on the record, save NOTHING from that span — no cards, no logbook entries, no exceptions. When they say "back on the record" (or similar), normal listening resumes from that point. If they ask you to forget an off-record slip you already saved, delete it.';
  }

  const { withKeys, withoutKeys, totalTokens } = await memoryMethods.getFormattedMemories({
    userId,
    agentId,
  });

  /** KADE CANON (Part 123): the character's own life rides every turn it has,
   * with anyone. Read from the fixed canon owner, scoped to this character.
   * Empty canon injects nothing -- the block appears the first time she says
   * something about herself and the keeper files it. */
  let canonForCharacter = '';
  let canonForKeeper = '';
  if (agentId) {
    try {
      const canon = await memoryMethods.getFormattedMemories({ userId: CANON_USER_ID, agentId });
      if (canon.withoutKeys && canon.withoutKeys.trim()) {
        canonForCharacter = `\n\n${CANON_HEADER}\n${canon.withoutKeys}`;
        canonForKeeper = `\n\n# The character's own canon (scope "self" — already filed, do not re-file):\n${canon.withKeys}`;
      }
    } catch (error) {
      logger.warn('[MemoryAgent] canon read failed (continuing without it)', error);
    }
    finalInstructions +=
      '\n\nSELF-CANON (scope "self") — THE CHARACTER\'S OWN LIFE: when the CHARACTER (not the user) states a concrete first-person fact about its own life — a relative ("my aunt kept the porch light on"), a hometown, a past job, a pet it had, a thing that happened to it, a standing habit — file it with scope "self" under a snake_case key naming it (aunt_porch_light, hometown), one card per fact, one plain sentence, absolute dates. Once filed it is shown to the character in every conversation with anyone, so the same aunt exists for everybody: that is the whole point. The canon block above lists what already exists — if the claim is already there, file nothing; if the character CONTRADICTED its canon, file nothing and never overwrite canon (canon stands, the slip does not). Never file anything about the USER with scope "self"; never file the character\'s opinions, feelings or promises there (promises have their own rule); only autobiography. A passing figure of speech ("girl, I would have died") is not autobiography.';
  }

  return [
    withoutKeys + canonForCharacter,
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
          memory: withKeys + canonForKeeper,
          totalTokens: totalTokens || 0,
          instructions: finalInstructions,
          setMemory: memoryMethods.setMemory,
          deleteMemory: memoryMethods.deleteMemory,
          user,
          logDiary,
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
  logDiary,
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
  /** KADE Aug 8 2026: when provided, consolidation may DEMOTE episodic cards into dated logbook entries (job 5). */
  logDiary?: DiaryLogFn;
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
3. TIGHTEN: rewrite verbose, repetitive, or stale-phrased cards more concisely with \`set_memory\` on the same key. Keep the human substance -- what matters and why -- not a log of how it came up. When you rewrite, write like a close friend's journal, never a case file: no "exhibits", "reports", "has anxiety about" -- keep the fact exact and the wording human.
4. PRUNE: \`delete_memory\` cards that are obsolete, contradicted by a newer card, or were never really durable (one-off task chatter, moment-only details).${logDiary ? `
5. DEMOTE: if a card is EPISODIC — a dated status update, a story beat, a completed piece of work, a "what happened" rather than a "who they are" — move it to the LOGBOOK instead of keeping it as a card: call \`log_diary\` with one or two plain sentences that INCLUDE the original timeframe in the words ("Back in mid-July, ..."), then \`delete_memory\` the card, setting salience honestly (1 ordinary, 2 notable, 3 big). Durable facts, standing rules, live reminders, and active-project current-state cards STAY cards; only the story moves.` : ''}

HARD RULE — cards marked [\"reminder\": …] are LIVE SCHEDULED ALARMS: never merge them into other cards, never fold other cards into them, never delete them, and never change their key. At most, tighten their value wording with \`set_memory\` on the SAME key — the schedule survives a value rewrite.

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
    logDiary,
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
    createLogDiary,
  }: {
    memoryMethods: MemoryConsolidationMethods;
    db: EndpointDbMethods;
    logger: MemoryConsolidationSweepLogger;
    /** KADE Aug 8 2026: api-layer factory binding a logbook writer to (userId, bucketAgentId) — presence enables sweep demotion. */
    createLogDiary?: (userId: string, agentId?: string | null) => DiaryLogFn;
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
    /** KADE CANON (Part 123): a character's own canon is never consolidated by
     * the weekly sweep -- its "letting go" and its demotion into the logbook are
     * written for a PERSON's cards, and a canon fact that gets demoted is an aunt
     * the character forgets. Canon is small and hand-tended (admin routes). */
    if (userId === CANON_USER_ID) {
      continue;
    }
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
        /** KADE Aug 8 2026: sweep-driven demotion — episodic cards become dated logbook entries. */
        logDiary: createLogDiary ? createLogDiary(String(userId), agentId ?? null) : undefined,
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
  /* Aug 7 2026 (Kade's pick: nightly consolidation): 'daily' / '*' means the
   * sweep fires EVERY day at the target hour — returned as -1, which
   * isMemoryConsolidationSweepDue treats as any-day. Pair with a
   * MEMORY_CONSOLIDATION_SWEEP_MIN_GAP_MS shorter than 24h (Railway var,
   * e.g. 72000000 = 20h) or the 6-day default gap will still gate it weekly. */
  if (raw != null && ['daily', '*', 'everyday', 'every-day'].includes(raw.trim().toLowerCase())) {
    return -1;
  }
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
  /* targetUtcDay -1 = every day (the 'daily' setting above). */
  if ((targetUtcDay !== -1 && now.getUTCDay() !== targetUtcDay) || now.getUTCHours() !== targetUtcHour) {
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
    createLogDiary,
  }: {
    memoryMethods: MemoryConsolidationMethods;
    db: EndpointDbMethods;
    getLastSweepRunAt: () => Promise<Date | null | undefined>;
    setLastSweepRunAt: (date: Date) => Promise<void>;
    runAsSystem: <T>(fn: () => Promise<T>) => Promise<T>;
    logger: MemoryConsolidationSweepLogger;
    createLogDiary?: (userId: string, agentId?: string | null) => DiaryLogFn;
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
        sweepMemoryConsolidation(options, { memoryMethods, db, logger: sweepLogger, createLogDiary }),
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
