import { MAX_SUBAGENTS } from 'librechat-data-provider';
import { agentCreateSchema, agentUpdateSchema, agentSubagentsSchema } from './validation';

describe('agent tts speed (Oct 30 2026)', () => {
  it('accepts a number in range, and null, which clears a saved speed', () => {
    expect(agentUpdateSchema.parse({ tts: { speakingRate: 1.2 } }).tts).toEqual({
      speakingRate: 1.2,
    });
    expect(agentUpdateSchema.parse({ tts: { speakingRate: null } }).tts).toEqual({
      speakingRate: null,
    });
    expect(
      agentCreateSchema.safeParse({
        name: 'Character',
        provider: 'openai',
        model: 'gpt-4',
        tts: { speakingRate: null },
      }).success,
    ).toBe(true);
  });

  it('keeps the 0.5 to 1.5 range and leaves an absent key absent', () => {
    expect(agentUpdateSchema.safeParse({ tts: { speakingRate: 1.6 } }).success).toBe(false);
    expect(agentUpdateSchema.safeParse({ tts: { speakingRate: 0.4 } }).success).toBe(false);
    expect(agentUpdateSchema.parse({ tts: { voiceId: 'Voice 1' } }).tts).toEqual({
      voiceId: 'Voice 1',
    });
  });
});

describe('agentSubagentsSchema', () => {
  it('accepts enabled:true with a list within the cap', () => {
    const result = agentSubagentsSchema.safeParse({
      enabled: true,
      allowSelf: false,
      agent_ids: ['agent_1', 'agent_2'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts the feature-off shape (enabled:false, no agents)', () => {
    const result = agentSubagentsSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
  });

  it('rejects agent_ids longer than MAX_SUBAGENTS', () => {
    const oversized = Array.from({ length: MAX_SUBAGENTS + 1 }, (_, i) => `agent_${i}`);
    const result = agentSubagentsSchema.safeParse({
      enabled: true,
      agent_ids: oversized,
    });
    expect(result.success).toBe(false);
  });

  it('accepts exactly MAX_SUBAGENTS entries', () => {
    const atCap = Array.from({ length: MAX_SUBAGENTS }, (_, i) => `agent_${i}`);
    const result = agentSubagentsSchema.safeParse({
      enabled: true,
      agent_ids: atCap,
    });
    expect(result.success).toBe(true);
  });
});

describe('agentCreateSchema with subagents', () => {
  const base = {
    provider: 'openAI',
    model: 'gpt-4o-mini',
    tools: [],
  };

  it('passes with subagents omitted', () => {
    const result = agentCreateSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it('passes with a valid subagents config', () => {
    const result = agentCreateSchema.safeParse({
      ...base,
      subagents: { enabled: true, allowSelf: true, agent_ids: [] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects when subagents.agent_ids exceeds the cap', () => {
    const oversized = Array.from({ length: MAX_SUBAGENTS + 1 }, (_, i) => `agent_${i}`);
    const result = agentCreateSchema.safeParse({
      ...base,
      subagents: { enabled: true, agent_ids: oversized },
    });
    expect(result.success).toBe(false);
  });
});

describe('agentUpdateSchema with subagents', () => {
  it('accepts a partial update with only the disabled flag set', () => {
    const result = agentUpdateSchema.safeParse({
      subagents: { enabled: false, allowSelf: true, agent_ids: [] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects oversized agent_ids on update', () => {
    const oversized = Array.from({ length: MAX_SUBAGENTS + 3 }, (_, i) => `agent_${i}`);
    const result = agentUpdateSchema.safeParse({
      subagents: { enabled: true, agent_ids: oversized },
    });
    expect(result.success).toBe(false);
  });
});
