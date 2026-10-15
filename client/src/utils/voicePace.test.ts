import { fishPaceValue, generationRate, isFishVoice, voiceCacheKey } from './voicePace';

describe('provider generation pace', () => {
  it('restricts API speed and lets an explicit listener choice override the character', () => {
    expect(generationRate(1.4, 1.2)).toBe(1.2);
    expect(generationRate(1.25, null)).toBe(1.25);
    expect(generationRate(1, 2)).toBe(1.5);
    expect(generationRate(1, 0.1)).toBe(0.5);
    expect(generationRate(undefined, NaN)).toBe(1);
  });
  it('maps old saved Fish numbers to semantic delivery choices', () => {
    expect(fishPaceValue(1.25)).toBe(1.2);
    expect(fishPaceValue(2)).toBe(1.5);
    expect(fishPaceValue(1)).toBe(1);
  });
  it('uses actual provider metadata for retained aliases', () => {
    expect(isFishVoice('Miss-A', { 'Miss-A': 'inworld' })).toBe(false);
    expect(isFishVoice('Miss-A (Amber A)', { 'Miss-A (Amber A)': 'fish' })).toBe(true);
    expect(isFishVoice('Voice (Classic)')).toBe(false);
  });
  it('never reuses an old pace, voice, or text-only audio cache entry', () => {
    const key = voiceCacheKey('same words', 'Fish voice', 1.2);
    expect(key).not.toBe(voiceCacheKey('same words', 'Classic voice', 1.2));
    expect(key).not.toBe(voiceCacheKey('same words', 'Fish voice', 1));
    expect(key).toContain('pacing-v2');
  });
});
