import { normalizeMemoryKey } from '../memoryKey';

describe('normalizeMemoryKey', () => {
  const schemaTakes = (k: string) => /^[a-z_]+$/.test(k);

  it('leaves a key the schema already takes exactly as it is', () => {
    for (const k of ['dad_health', 'agent_notes', 'promise_second_verse', '_odd__but_legal_']) {
      expect(normalizeMemoryKey(k)).toBe(k);
    }
  });

  it('spells numbers as words (the canon example that lost cards)', () => {
    expect(normalizeMemoryKey('render_hung_98_minutes')).toBe('render_hung_ninety_eight_minutes');
    expect(normalizeMemoryKey('trip_2026')).toBe('trip_two_thousand_twenty_six');
    expect(normalizeMemoryKey('room_7')).toBe('room_seven');
    expect(normalizeMemoryKey('age_0')).toBe('age_zero');
    expect(normalizeMemoryKey('code_007')).toBe('code_zero_zero_seven');
    expect(normalizeMemoryKey('phone_4175551234')).toBe('phone_four_one_seven_five_five_five_one_two_three_four');
  });

  it('lowercases and turns spaces, dashes and punctuation into single underscores', () => {
    expect(normalizeMemoryKey('Dad-Health')).toBe('dad_health');
    expect(normalizeMemoryKey('  concert crew ')).toBe('concert_crew');
    expect(normalizeMemoryKey('mom.foot--surgery!')).toBe('mom_foot_surgery');
    expect(normalizeMemoryKey('Café_Visit')).toBe('caf_visit');
  });

  it('always returns something the schema takes, unless nothing usable is left', () => {
    for (const k of ['A1', 'x-2-y', 'Kasper the Cat', 'position_alpha_dog', '9lives']) {
      expect(schemaTakes(normalizeMemoryKey(k))).toBe(true);
    }
    expect(normalizeMemoryKey('123')).toBe('one_hundred_twenty_three');
    expect(normalizeMemoryKey('!!!')).toBe('!!!');
    expect(normalizeMemoryKey('')).toBe('');
  });
});
