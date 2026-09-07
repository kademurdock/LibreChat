/** Final permission-filtered loader output. Credentials are never copied. */
export function runtimeCapabilities(agent: {
  tools?: unknown[];
  toolDefinitions?: { name?: string }[];
  hasDeferredTools?: boolean;
  codeEnvAvailable?: boolean;
}): { available: string[]; discoverable: string[]; codeEnvironment: boolean; note: string } {
  const available = [
    ...new Set(
      (agent.tools || [])
        .map((tool) => {
          if (typeof tool === 'string') return tool;
          if (tool && typeof tool === 'object' && 'name' in tool && typeof tool.name === 'string')
            return tool.name;
          if (tool && typeof tool === 'object' && 'type' in tool && typeof tool.type === 'string')
            return tool.type;
          return '';
        })
        .filter(Boolean),
    ),
  ].sort();
  const discoverable = agent.hasDeferredTools
    ? [
        ...new Set(
          (agent.toolDefinitions || [])
            .map((tool) => tool.name || '')
            .filter((name) => name && !available.includes(name)),
        ),
      ].sort()
    : [];
  return {
    available,
    discoverable,
    codeEnvironment: agent.codeEnvAvailable === true,
    note: 'Only the available list is callable in this reply. Discoverable tools must be loaded successfully first. A missing tool is not evidence that an account is connected. Ask for setup when the loader reports an authorization requirement. Do not claim another agent can perform an action until its own loaded tools confirm it.',
  };
}
