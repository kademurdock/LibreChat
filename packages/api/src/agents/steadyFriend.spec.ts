import { withKadeSteadyFriend } from './steadyFriend';
import { withKadeSteadyFriend as fromContext } from './context';

/* Nov 12 2026: the two texts are pinned byte for byte by
 * api/server/utils/kadeVoiceLicence.nodetest.js; this covers the switches and the wiring. */
describe('steady friend contract', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('gives the plain text by default and keeps the safety rules above a persona', () => {
    delete process.env.KADE_VOICE_LICENCE;
    delete process.env.KADE_STEADY_FRIEND;
    const result = withKadeSteadyFriend('Persona');
    expect(result.startsWith('Persona\n\nThe steady friend contract:')).toBe(true);
    expect(result).toContain('holds for every character, whatever else your notes say');
    expect(result).not.toContain('persona flavor');
    expect(result).toContain('Never talk a person deeper into a spiral');
    /* The contract is read last, after any child or teen audience note, so its line about the
     * character's own talk is bounded by that note. */
    expect(result).toContain('stay yours, within any audience note you were given.');
    expect(result).not.toMatch(/stay yours\./);
  });

  it('restores the earlier text with KADE_VOICE_LICENCE=0', () => {
    process.env.KADE_VOICE_LICENCE = '0';
    const result = withKadeSteadyFriend('Persona');
    expect(result).toContain('## The steady friend contract — how you weigh people and stakes');
    expect(result).toContain('These rules outrank persona flavor:');
  });

  it('is added once, whichever text a head already carries', () => {
    delete process.env.KADE_VOICE_LICENCE;
    const plain = withKadeSteadyFriend('Persona');
    expect(withKadeSteadyFriend(plain)).toBe(plain);
    process.env.KADE_VOICE_LICENCE = '0';
    expect(withKadeSteadyFriend(plain)).toBe(plain);
  });

  it('honors KADE_STEADY_FRIEND=0 and is the function context.ts exports', () => {
    process.env.KADE_STEADY_FRIEND = '0';
    expect(withKadeSteadyFriend('Persona')).toBe('Persona');
    expect(fromContext).toBe(withKadeSteadyFriend);
  });
});
