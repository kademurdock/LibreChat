import { runtimeCapabilities } from './capabilities';

describe('runtimeCapabilities', () => {
  it('counts bound tool definitions as available in event-driven mode, where tools is empty', () => {
    const view = runtimeCapabilities({
      tools: [],
      toolDefinitions: [{ name: 'kade_library' }, { name: 'kade_help' }],
      hasDeferredTools: false,
    });
    expect(view.available).toEqual(['kade_help', 'kade_library']);
    expect(view.discoverable).toEqual([]);
  });

  it('keeps deferred definitions discoverable, not available', () => {
    const view = runtimeCapabilities({
      tools: [],
      toolDefinitions: [{ name: 'kade_library' }, { name: 'kade_lyrics', defer_loading: true }],
      hasDeferredTools: true,
    });
    expect(view.available).toEqual(['kade_library']);
    expect(view.discoverable).toEqual(['kade_lyrics']);
  });

  it('still reads full tool instances in the legacy mode', () => {
    const view = runtimeCapabilities({ tools: [{ name: 'web_search' }, 'kade_help'] });
    expect(view.available).toEqual(['kade_help', 'web_search']);
  });

  it('lists the subagent tool when the agent has someone to consult, and says it may be used', () => {
    const view = runtimeCapabilities({
      tools: [],
      toolDefinitions: [{ name: 'kade_memory_search' }],
      subagents: { enabled: true, allowSelf: false },
      subagentAgentConfigs: [{ id: 'agent_librarian' }],
    });
    expect(view.available).toEqual(['kade_memory_search', 'subagent']);
    expect(view.note).toContain('The subagent tool asks the agents its description names');
  });

  it('does not list the subagent tool without a target', () => {
    for (const agent of [
      { subagents: { enabled: true, allowSelf: false }, subagentAgentConfigs: [] },
      { subagents: { enabled: false }, subagentAgentConfigs: [{ id: 'agent_x' }] },
      { subagents: undefined, subagentAgentConfigs: undefined },
    ]) {
      const view = runtimeCapabilities({ tools: [], toolDefinitions: [], ...agent });
      expect(view.available).toEqual([]);
      expect(view.note).not.toContain('subagent tool');
    }
  });

  it('counts self-spawn as a target when it is allowed', () => {
    const view = runtimeCapabilities({ subagents: { enabled: true }, subagentAgentConfigs: [] });
    expect(view.available).toEqual(['subagent']);
  });
});
