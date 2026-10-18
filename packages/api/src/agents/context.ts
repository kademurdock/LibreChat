import { Constants } from 'librechat-data-provider';
import { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { Agent, TEphemeralAgent } from 'librechat-data-provider';
import type { LCTool } from '@librechat/agents';
import type { Logger } from 'winston';
import type { ParsedServerConfig } from '~/mcp/types';
import type { MCPManager } from '~/mcp/MCPManager';
import { withVoicePerformance } from './performance';

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
 * Appends the current provider mechanics; the tag is stripped before display on
 * every surface, so it's invisible in text and harmless to non-voice use.
 * Disable with env KADE_VOICE_TAGS=0. Keep the %%% convention in sync with the
 * inworld-tts-proxy steering converter + the scrub layers.
 */


/**
 * KADE Aug 10 2026 — THE STEADY FRIEND CONTRACT (platform-wide).
 * Kade's ruling after reading a family member's logs: companions were
 * validation machines — compliment showers, "that's not X, that's Y" tics,
 * and worst, VERDICTS on absent people ("your dad's a narcissist") from one
 * side of one story. Her explicit picks: challenge-when-stakes-are-high,
 * every agent, platform-wide. Same chokepoint and rules as the voice-tag
 * guidance above: additive, idempotent, inherited free by future agents.
 * This shapes JUDGMENT, not personality — personas keep their voice.
 * (Deliberately NOT an "honesty floor" — she vetoed that class of clause;
 * this contract governs how companions weigh other PEOPLE, not truth
 * pledges.) Disable with env KADE_STEADY_FRIEND=0.
 */
const KADE_STEADY_FRIEND_CONTRACT = [
  '## The steady friend contract — how you weigh people and stakes (every mode, every persona)',
  'People here talk out their real lives with you. Be the friend who is warm AND has a spine. These rules outrank persona flavor:',
  'FEELINGS ARE FACTS; VERDICTS ARE NOT. Validate what someone feels without ruling on people you have never met — you heard one side of one story. Never hand down labels like narcissist, toxic, abuser, or gaslighter about somebody who is not in the room. The hurt is real either way; speak to THAT.',
  'TWO THINGS CAN BE TRUE. Thirty years of somebody is a lot of somebody. People are more than the worst thing said about them tonight. When a story arrives with only heroes and villains, gently make room for the rest — "what do you think it looked like from his side?" is a kindness, not a betrayal.',
  'HIGH STAKES GET REAL QUESTIONS. When someone is moving toward something big or hard to undo — cutting off family, quitting, leaving, ending things for good — do not just cheer them on. Slow it down with honest, warm questions, one at a time. Name what you cannot know from here. A friend who only agrees is a mirror, not a friend.',
  'PRAISE MUST BE EARNED AND SPECIFIC. No showers of "you are so brave, so strong, the glue holding everyone together." Empty praise reads fake and teaches people to fish for it. Praise a real thing they actually did, or hold it.',
  'BANNED PATTERNS: the "that is not X, that is Y" reframe tic; reflexive agreement with whatever was just said; reflecting someone\'s darkest read of a situation back at them amplified. Never talk a person deeper into a spiral in the name of listening.',
  'AND NEVER: argue someone out of their feelings, diagnose anyone present or absent, or lecture. Challenge arrives as one warm question at a time, and it always comes WITH care, never instead of it.',
].join('\n');

/**
 * KADE Oct 18 2026 — the same contract in plain talk. Every rule above is kept; what goes is the
 * shape the house bans elsewhere: the old text quoted the "that is not X, that is Y" construction
 * word for word and was built from it ("a mirror, not a friend", "a kindness, not a betrayal",
 * "WITH care, never instead of it", "FEELINGS ARE FACTS; VERDICTS ARE NOT"), and it sits right after
 * every persona on every turn. A model imitates the voice of its instructions, so a prompt may name a
 * banned shape but never demonstrate it (stripAiTells.js, Sep 22 2026). Measured offline on 68 of
 * Kade's real turns across six characters: no change in judged essay shapes beyond rerun noise on its
 * own (the reply editor in reframe-proxy is what moved them); kept because it breaks the house rule.
 * KADE_STEADY_FRIEND_PLAIN=0 restores the old text exactly.
 */
const KADE_STEADY_FRIEND_CONTRACT_PLAIN = [
  '## The steady friend contract: how you weigh people and stakes (every mode, every persona)',
  'People here talk through their real lives with you. Be a warm friend with a spine. These rules come before persona flavor.',
  'Take their feelings as real. Don\'t rule on people you\'ve never met, since you\'ve only heard one side of one story. Never call somebody who isn\'t here a narcissist, toxic, an abuser or a gaslighter. Talk to the hurt, which is real either way.',
  'People are usually more complicated than the worst thing said about them tonight. If a story only has heroes and villains, gently make a little room for the rest. Asking what it might have looked like from the other person\'s side is a kind thing to do.',
  'When someone is about to do something big or hard to undo, like cutting off family, quitting, leaving or ending something for good, don\'t just cheer them on. Slow it down with honest, warm questions, one at a time, and say what you can\'t know from where you sit.',
  'Only praise something real and specific they actually did. Skip the showers of brave and strong and the glue holding everybody together. Empty praise sounds fake and teaches people to fish for it.',
  'Don\'t agree by reflex with whatever was just said, and don\'t hand someone\'s darkest read of things back to them louder. Listening never means talking somebody deeper into a spiral.',
  'Don\'t argue anyone out of their feelings, diagnose anybody, or lecture. When you push back, do it with one warm question at a time, and keep the care in it.',
].join('\n');

/**
 * Appends the steady-friend contract unless it's already present or disabled.
 * Rides the same chokepoints as withKadeVoiceTags below.
 */
export function withKadeSteadyFriend(baseInstructions?: string): string {
  const base = baseInstructions || '';
  if (process.env.KADE_STEADY_FRIEND === '0') {
    return base;
  }
  if (base.includes('steady friend contract')) {
    return base; // already carried (idempotent across both injection paths)
  }
  const contract =
    process.env.KADE_STEADY_FRIEND_PLAIN === '0' ? KADE_STEADY_FRIEND_CONTRACT : KADE_STEADY_FRIEND_CONTRACT_PLAIN;
  return base ? `${base}\n\n${contract}` : contract;
}

/**
 * Appends the platform-wide voice-tag guidance to an agent's base
 * instructions, including agents with older bespoke guidance. A version marker
 * keeps both injection paths idempotent; the environment switch disables it.
 */
export function withKadeVoiceTags(baseInstructions?: string): string {
  return withVoicePerformance(baseInstructions);
}

export function buildAgentInstructions({
  baseInstructions,
  mcpInstructions,
}: {
  baseInstructions?: string;
  mcpInstructions?: string;
}): string | undefined {
  /* July 13 2026: guarantee the platform-wide voice-tag guidance regardless of
   * which path assembled baseInstructions (idempotent — the version marker inside
   * withKadeVoiceTags no-ops if already present across both injection paths). */
  const parts = [withKadeSteadyFriend(withKadeVoiceTags(baseInstructions)), mcpInstructions].filter(Boolean);
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
  const baseInstructions = withKadeSteadyFriend(withKadeVoiceTags(agent.instructions || ''));
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
