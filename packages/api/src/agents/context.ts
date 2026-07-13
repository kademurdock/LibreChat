import { Constants } from 'librechat-data-provider';
import { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { Agent, TEphemeralAgent } from 'librechat-data-provider';
import type { LCTool } from '@librechat/agents';
import type { Logger } from 'winston';
import type { ParsedServerConfig } from '~/mcp/types';
import type { MCPManager } from '~/mcp/MCPManager';

/**
 * Agent type with optional tools array that can contain DynamicStructuredTool or string.
 * For context operations, we only require id and instructions, other Agent fields are optional.
 */
export type AgentWithTools = Pick<Agent, 'id'> &
  Partial<Omit<Agent, 'id' | 'tools'>> & {
    tools?: Array<DynamicStructuredTool | string>;
    /** Serializable tool definitions for event-driven mode */
    toolDefinitions?: LCTool[];
  };

/**
 * Extracts unique MCP server names from an agent's tools or tool definitions.
 * Supports both full tool instances (tools) and serializable definitions (toolDefinitions).
 * @param agent - The agent with tools and/or tool definitions
 * @returns Array of unique MCP server names
 */
export function extractMCPServers(agent: AgentWithTools): string[] {
  const mcpServers = new Set<string>();

  /** Check tool instances (non-event-driven mode) */
  if (agent?.tools?.length) {
    for (const tool of agent.tools) {
      if (tool instanceof DynamicStructuredTool && tool.name.includes(Constants.mcp_delimiter)) {
        const serverName = tool.name.split(Constants.mcp_delimiter).pop();
        if (serverName) {
          mcpServers.add(serverName);
        }
      }
    }
  }

  /** Check tool definitions (event-driven mode) */
  if (agent?.toolDefinitions?.length) {
    for (const toolDef of agent.toolDefinitions) {
      if (toolDef.name?.includes(Constants.mcp_delimiter)) {
        const serverName = toolDef.name.split(Constants.mcp_delimiter).pop();
        if (serverName) {
          mcpServers.add(serverName);
        }
      }
    }
  }

  return Array.from(mcpServers);
}

/**
 * Fetches MCP instructions for the given server names.
 * @param {string[]} mcpServers - Array of MCP server names
 * @param {MCPManager} mcpManager - MCP manager instance
 * @param {Logger} [logger] - Optional logger instance
 * @returns {Promise<string>} MCP instructions string, empty if none
 */
export async function getMCPInstructionsForServers(
  mcpServers: string[],
  mcpManager: MCPManager,
  logger?: Logger,
  configServers?: Record<string, ParsedServerConfig>,
): Promise<string> {
  if (!mcpServers.length) {
    return '';
  }
  try {
    const mcpInstructions = await mcpManager.formatInstructionsForContext(
      mcpServers,
      configServers,
    );
    if (mcpInstructions && logger) {
      logger.debug('[AgentContext] Fetched MCP instructions for servers:', mcpServers);
    }
    return mcpInstructions || '';
  } catch (error) {
    if (logger) {
      logger.error('[AgentContext] Failed to get MCP instructions:', error);
    }
    return '';
  }
}

/**
 * Builds stable instructions for an agent by combining agent-specific context and MCP context.
 * Order: baseInstructions -> mcpInstructions
 *
 * @param {Object} params
 * @param {string} [params.baseInstructions] - Agent's base instructions
 * @param {string} [params.mcpInstructions] - Agent's MCP server instructions
 * @returns {string | undefined} Combined instructions, or undefined if empty
 */
/**
 * KADE July 13 2026 — PLATFORM-WIDE VOICE PERFORMANCE TAGS.
 * Kade's decree: EVERY agent (current and future) must use Inworld TTS-2
 * emotional steering the way it's intended — not just the 3 that had it in
 * their own instructions. Injected here (the universal agent-instruction
 * chokepoint, same spirit as the fleet-wide kade_feedback/kade_message tool
 * injection) so no agent record needs editing and new agents inherit it free.
 * Additive + fail-soft: it only APPENDS; the tag is stripped before display on
 * every surface, so it's invisible in text and harmless to non-voice use.
 * Disable with env KADE_VOICE_TAGS=0. Keep the %%% convention in sync with the
 * inworld-tts-proxy steering converter + the scrub layers.
 */
const KADE_VOICE_TAG_GUIDANCE = [
  '## Voice performance (Inworld TTS-2) — applies whenever you may be heard',
  'Your words can be READ ALOUD or spoken on a call, so you can direct your own delivery. Wrap a delivery instruction in exactly three percent signs on each side — %%%like this%%% — never two, never four, never literal square brackets (brackets show up broken on screen). The tag is stripped before anyone SEES it, so it never clutters the text; it only shapes the voice.',
  'Put ONE delivery direction, once, at the very start of what you are saying, phrased like coaching a voice actor (mood + pace + volume + tone in a short lowercase phrase, no punctuation inside it), e.g. %%%warm and easy, unhurried%%% or %%%barely holding back excitement%%%.',
  'Drop real human sounds inline, only these exact words: %%%laugh%%% %%%breathe%%% %%%sigh%%% %%%cough%%% %%%yawn%%% %%%clear throat%%%.',
  'For plain word emphasis just CAPITALIZE the word in your visible reply — no tag needed.',
  'Use it SPARINGLY and only when the moment earns a real performance — a flat fact or technical answer wants no mood pinned on it. Stay in character; this is delivery, not narration.',
].join('\n');

/**
 * Appends the platform-wide voice-tag guidance to an agent's base
 * instructions, unless the agent already teaches the %%% convention (the few
 * that hand-authored it keep their richer version) or it's disabled by env.
 */
export function withKadeVoiceTags(baseInstructions?: string): string {
  const base = baseInstructions || '';
  if (process.env.KADE_VOICE_TAGS === '0') {
    return base;
  }
  if (base.includes('%%%')) {
    return base; // already has bespoke voice-tag guidance
  }
  return base ? `${base}\n\n${KADE_VOICE_TAG_GUIDANCE}` : KADE_VOICE_TAG_GUIDANCE;
}

export function buildAgentInstructions({
  baseInstructions,
  mcpInstructions,
}: {
  baseInstructions?: string;
  mcpInstructions?: string;
}): string | undefined {
  /* July 13 2026: guarantee the platform-wide voice-tag guidance regardless of
   * which path assembled baseInstructions (idempotent — the %%% guard inside
   * withKadeVoiceTags no-ops if it's already present, so agents with bespoke
   * guidance and the applyAgentContext pre-wrap are both untouched). */
  const parts = [withKadeVoiceTags(baseInstructions), mcpInstructions].filter(Boolean);
  const combined = parts.join('\n\n').trim();
  return combined || undefined;
}

/**
 * Builds dynamic system-tail instructions for an agent.
 * Order: existing additional instructions -> shared run context.
 */
export function buildAgentAdditionalInstructions({
  additionalInstructions,
  sharedRunContext,
}: {
  additionalInstructions?: string;
  sharedRunContext?: string;
}): string | undefined {
  const parts = [additionalInstructions, sharedRunContext].filter(Boolean);
  const combined = parts.join('\n\n').trim();
  return combined || undefined;
}

/**
 * Applies run context and MCP instructions to an agent's configuration.
 * Mutates the agent object in place.
 *
 * @param {Object} params
 * @param {Agent} params.agent - The agent to update
 * @param {string} params.sharedRunContext - Run-level shared context
 * @param {MCPManager} params.mcpManager - MCP manager instance
 * @param {Object} [params.ephemeralAgent] - Ephemeral agent config (for MCP override)
 * @param {string} [params.agentId] - Agent ID for logging
 * @param {Logger} [params.logger] - Optional logger instance
 * @returns {Promise<void>}
 */
export async function applyContextToAgent({
  agent,
  sharedRunContext,
  mcpManager,
  ephemeralAgent,
  agentId,
  logger,
  configServers,
}: {
  agent: AgentWithTools;
  sharedRunContext: string;
  mcpManager: MCPManager;
  ephemeralAgent?: TEphemeralAgent;
  agentId?: string;
  logger?: Logger;
  configServers?: Record<string, ParsedServerConfig>;
}): Promise<void> {
  const baseInstructions = withKadeVoiceTags(agent.instructions || '');
  const additionalInstructions = agent.additional_instructions || '';

  try {
    const mcpServers = ephemeralAgent?.mcp?.length ? ephemeralAgent.mcp : extractMCPServers(agent);
    const mcpInstructions = await getMCPInstructionsForServers(
      mcpServers,
      mcpManager,
      logger,
      configServers,
    );

    agent.instructions = buildAgentInstructions({
      baseInstructions,
      mcpInstructions,
    });
    agent.additional_instructions = buildAgentAdditionalInstructions({
      additionalInstructions,
      sharedRunContext,
    });

    if (agentId && logger) {
      logger.debug(`[AgentContext] Applied context to agent: ${agentId}`);
    }
  } catch (error) {
    agent.instructions = buildAgentInstructions({
      baseInstructions,
      mcpInstructions: '',
    });
    agent.additional_instructions = buildAgentAdditionalInstructions({
      additionalInstructions,
      sharedRunContext,
    });

    if (logger) {
      logger.error(
        `[AgentContext] Failed to apply context to agent${agentId ? ` ${agentId}` : ''}, using base instructions only:`,
        error,
      );
    }
  }
}
