/**
 * WHISPER MODE — a delivery instruction must not carry an agenda.
 *
 * The live shape, Aug 24 2026, a family seat at 10:46pm Central. She said she
 * was taking her meds and heading to bed "in just a minute" — present tense,
 * still talking. The reply:
 *
 *   "Alright, no reminder needed. Zeus in, meds in hand, you're set. Go say
 *    good night to your mama for me and I'll see you tomorrow — big day with
 *    that 2:15 appointment, I'm around if you want to talk before or after.
 *    Sleep good, girl."
 *
 * Kade's report: "Kiana is rushing her to constantly end the conversation…
 * acting like talking to the AI is a waste of time. It's really lame."
 *
 * The cause was the last five words of a rule that opens by promising content
 * will not change: "Like talking somebody toward sleep." Plus a length
 * instruction ("favor shorter sentences") sitting in a list of delivery
 * instructions, which came back out as a literal "keep it short" at the start
 * of a reply, where the steering tag goes.
 */
const { KADE_WHISPER_LINE } = require('../kadeWorldPulse');

describe('KADE_WHISPER_LINE', () => {
  /**
   * ⚠️ NOTE ON HOW THIS TEST IS WRITTEN, because the first draft was wrong and
   * it is an easy trap: a banned-SUBSTRING check cannot tell "wrap up" from
   * "do NOT wrap up." The rewritten line has to SAY the forbidden things in
   * order to forbid them, so a naive ban fails on the fix itself. Assert the
   * agenda's IMPERATIVE form is gone, and assert the prohibitions are present.
   */
  test('THE BUG, REPRODUCED: the sleep agenda is gone in its instructing form', () => {
    const l = KADE_WHISPER_LINE.toLowerCase();
    // The literal closing sentence that caused it.
    expect(l).not.toContain('like talking somebody toward sleep');
    expect(l).not.toContain('toward sleep.');
    // And it must never be phrased as something to do.
    for (const imperative of ['talk them toward sleep', 'ease them toward sleep', 'guide them to sleep']) {
      expect(l).not.toContain(imperative);
    }
  });

  test('the sleep agenda is present ONLY as a prohibition, never as a direction', () => {
    const l = KADE_WHISPER_LINE.toLowerCase();
    // Every mention of ending/sleep must sit behind a negation.
    for (const phrase of ['wrap up', 'winding the conversation down', 'go sleep', 'sign off']) {
      expect(l).toContain(phrase);
      const i = l.indexOf(phrase);
      const before = l.slice(Math.max(0, i - 60), i);
      expect(before).toMatch(/not |never |do not |n't /);
    }
  });

  test('it explicitly forbids ending the conversation, because quiet is not a hint', () => {
    const l = KADE_WHISPER_LINE.toLowerCase();
    expect(l).toContain('not a hint to wrap up');
    expect(l).toContain('unless they say they are going');
  });

  test('no length or brevity instruction — that is what leaked as visible text', () => {
    const l = KADE_WHISPER_LINE.toLowerCase();
    // "favor shorter sentences" was the source. A brevity rule in a delivery
    // list gets rendered as a delivery tag.
    expect(l).not.toContain('shorter sentences');
    expect(l).not.toContain('favor shorter');
    expect(l).not.toContain('be brief');
    // It must actively say length is unchanged, not merely omit the rule.
    expect(l).toContain('length');
  });

  test('it still does the job it exists for — the delivery half is intact', () => {
    const l = KADE_WHISPER_LINE.toLowerCase();
    for (const kept of ['hushed', 'soft', 'no caps', 'shouting', 'paragraph breaks', 'whisper']) {
      expect(l).toContain(kept);
    }
  });

  test('it names itself a sound-only setting up front', () => {
    // The old line said "content exactly the same" and then changed content.
    // The promise has to be unambiguous and early.
    expect(KADE_WHISPER_LINE.toLowerCase()).toContain('about sound and nothing else');
  });

  test('steering tags are still demonstrated, so the model knows the shape', () => {
    expect(KADE_WHISPER_LINE).toMatch(/%%%[^%]+%%%/);
  });
});
