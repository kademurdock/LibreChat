const briefTools = new Set(['kade_weather', 'kade_news']);

export function isBriefToolAllowed(name: string): boolean {
  return briefTools.has(name);
}

/** Enforced again at execution: a model-invented call must never send a push. */
export function assertBriefToolCalls(names: string[]): void {
  if (names.some((name) => !isBriefToolAllowed(name))) {
    throw new Error('Morning brief composition only permits weather and news tools.');
  }
}

/** Restrict both legacy instances and event-driven definitions before graph execution. */
export function restrictBriefTools<
  T extends { name?: string },
  D extends { name?: string },
>(agent: {
  tools?: T[];
  toolDefinitions?: D[];
  codeEnvAvailable?: boolean;
  hasDeferredTools?: boolean;
}): void {
  if (agent.tools) agent.tools = agent.tools.filter((tool) => isBriefToolAllowed(tool.name || ''));
  if (agent.toolDefinitions) {
    agent.toolDefinitions = agent.toolDefinitions.filter((tool) =>
      isBriefToolAllowed(tool.name || ''),
    );
  }
  agent.codeEnvAvailable = false;
  agent.hasDeferredTools = false;
}
