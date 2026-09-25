/** The SDK's built-in subagent tool name (Constants.SUBAGENT in @librechat/agents). */
const SUBAGENT_TOOL = 'subagent';

/**
 * Final permission-filtered loader output. Credentials are never copied.
 *
 * KADE Sep 24 2026: in event-driven mode (production) initializeAgent leaves
 * `tools` empty and the model binds `toolDefinitions`, so this used to report
 * `available: []` on every turn while telling the model "only the available
 * list is callable". Bound definitions (anything not deferred) now count as
 * available, and so does the SDK's own `subagent` tool when this agent has a
 * spawn target (the library consultation or a configured specialist).
 */
export function runtimeCapabilities(agent: {
  tools?: unknown[];
  toolDefinitions?: { name?: string; defer_loading?: boolean }[];
  hasDeferredTools?: boolean;
  codeEnvAvailable?: boolean;
  subagents?: { enabled?: boolean; allowSelf?: boolean } | null;
  subagentAgentConfigs?: unknown[] | null;
}): { available: string[]; discoverable: string[]; codeEnvironment: boolean; note: string } {
  const definitions = agent.toolDefinitions || [];
  const canSpawn =
    agent.subagents?.enabled === true &&
    ((agent.subagentAgentConfigs?.length ?? 0) > 0 || agent.subagents.allowSelf !== false);
  const available = [
    ...new Set(
      [
        ...(agent.tools || []).map((tool) => {
          if (typeof tool === 'string') return tool;
          if (tool && typeof tool === 'object' && 'name' in tool && typeof tool.name === 'string')
            return tool.name;
          if (tool && typeof tool === 'object' && 'type' in tool && typeof tool.type === 'string')
            return tool.type;
          return '';
        }),
        ...definitions.filter((tool) => tool.defer_loading !== true).map((tool) => tool.name || ''),
        canSpawn ? SUBAGENT_TOOL : '',
      ].filter(Boolean),
    ),
  ].sort();
  const discoverable = agent.hasDeferredTools
    ? [
        ...new Set(
          definitions
            .map((tool) => tool.name || '')
            .filter((name) => name && !available.includes(name)),
        ),
      ].sort()
    : [];
  return {
    available,
    discoverable,
    codeEnvironment: agent.codeEnvAvailable === true,
    note:
      'Only the available list is callable in this reply. Discoverable tools must be loaded successfully first. A missing tool is not evidence that an account is connected. Ask for setup when the loader reports an authorization requirement. Do not claim another agent can perform an action until its own loaded tools confirm it.' +
      (canSpawn
        ? ' The subagent tool asks the agents its description names; use it to consult them, and their answer comes back to you.'
        : ''),
  };
}
