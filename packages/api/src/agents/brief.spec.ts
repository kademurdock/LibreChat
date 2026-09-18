import { assertBriefToolCalls, isBriefToolAllowed, restrictBriefTools } from './brief';

describe('morning brief composition', () => {
  it('keeps factual reads and removes every sending, scheduling and delegation tool', () => {
    const names = [
      'kade_weather',
      'kade_news',
      'kade_notify',
      'kade_message',
      'kade_call_me',
      'kade_research',
      'kade_feedback',
      'execute_code',
      'web_search',
      'agent_handoff',
    ];
    const agent = {
      tools: names.map((name) => ({ name, invoke: jest.fn() })),
      toolDefinitions: names.map((name) => ({ name })),
      codeEnvAvailable: true,
      hasDeferredTools: true,
    };
    const original = [...agent.tools];
    restrictBriefTools(agent);
    expect(agent.tools.map((tool) => tool.name)).toEqual(['kade_weather', 'kade_news']);
    expect(agent.toolDefinitions.map((tool) => tool.name)).toEqual(['kade_weather', 'kade_news']);
    expect(agent.tools[0]).toBe(original[0]);
    expect(agent.codeEnvAvailable).toBe(false);
    expect(agent.hasDeferredTools).toBe(false);
    expect(original).toHaveLength(names.length);
  });

  it('rejects an invented or stale notification call before tools are loaded for execution', () => {
    expect(() => assertBriefToolCalls(['kade_weather', 'kade_news'])).not.toThrow();
    expect(() => assertBriefToolCalls(['kade_weather', 'kade_notify'])).toThrow(/only permits/);
    expect(() => assertBriefToolCalls(['future_send_tool'])).toThrow(/only permits/);
    expect(isBriefToolAllowed('kade_notify')).toBe(false);
  });

  it('fails closed on unnamed definitions and handles a toolless agent', () => {
    const agent = { toolDefinitions: [{}, { name: 'kade_news' }] };
    restrictBriefTools(agent);
    expect(agent.toolDefinitions).toEqual([{ name: 'kade_news' }]);
    expect(() => restrictBriefTools({})).not.toThrow();
  });
});
