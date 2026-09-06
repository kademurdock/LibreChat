import { withVoicePerformance } from './performance';

describe('current voice performance guidance', () => {
  it('reaches a character that already has legacy percent tags', () => {
    const persona = 'Be a diplomatic friend. Use %%%warm%%% once at the start.';
    const result = withVoicePerformance(persona, true);
    expect(result.startsWith(persona)).toBe(true);
    expect(result).toContain('## Voice performance v2');
    expect(result).toContain('replace any older one-instruction-per-reply rule');
  });
  it('is added only once across repeated instruction assembly', () => {
    const once = withVoicePerformance('Character instructions', true);
    expect(withVoicePerformance(once, true)).toBe(once);
  });
  it('honors the existing disable switch without changing a persona', () => {
    expect(withVoicePerformance('Character instructions', false)).toBe('Character instructions');
  });
  it('also teaches newly created agents without bespoke tags', () => {
    expect(withVoicePerformance('', true)).toContain('%%%amused with a little disbelief%%%');
  });
});
