import { formatGeneratedLyricsDraft } from './format';

describe('formatGeneratedLyricsDraft', () => {
  it('keeps lyric lines together and separates every section with one blank line', () => {
    const draft =
      "English, 1990s soul, female lead.\n\nLyrics:\n\n[Verse 1]\n\nI need a minute\n\nBefore I answer\n\n\n[Chorus]\n\nIt's gon' be hard, hard, hard\n\nOoo, but we gon' make it happen\n\n";

    expect(formatGeneratedLyricsDraft(draft)).toBe(
      "English, 1990s soul, female lead.\n\nLyrics:\n[Verse 1]\nI need a minute\nBefore I answer\n\n[Chorus]\nIt's gon' be hard, hard, hard\nOoo, but we gon' make it happen",
    );
  });

  it('puts section labels on their own lines without rewriting lyrics or cues', () => {
    const draft =
      "Lyrics: [Verse 1] I ask for help\n(Help me, yeah)\n[riff]\nI try again [Chorus] We gon' make it happen [riff]\n[Outro - Vamp] Ooo-ooo\n";

    expect(formatGeneratedLyricsDraft(draft)).toBe(
      "Lyrics: \n[Verse 1]\nI ask for help\n(Help me, yeah)\n[riff]\nI try again\n\n[Chorus]\nWe gon' make it happen [riff]\n\n[Outro - Vamp]\nOoo-ooo",
    );
  });

  it('preserves the title, music direction, readback, and internal lyric spacing', () => {
    const prefix = 'TITLE: One More Try\r\nEnglish, soul.\r\n\r\nLYRICS:';
    const suffix = 'READBACK: A female lead sings through frustration.\r\nWith a final vamp.\r\n';
    const draft = `${prefix}\r\n  [Verse 2]  \r\n\r\n  I ask  for help (yeah)  \r\n\r\n${suffix}`;

    expect(formatGeneratedLyricsDraft(draft)).toBe(
      `${prefix}\n[Verse 2]\nI ask  for help (yeah)\n\n${suffix}`,
    );
  });

  it('leaves bracketed words and vocal cues inside a section', () => {
    const draft = 'Lyrics:\n[Verse]\n[unclear]\n\nOhh [hold] yeah\n\n[Choir joins]\n(We can)';

    expect(formatGeneratedLyricsDraft(draft)).toBe(
      'Lyrics:\n[Verse]\n[unclear]\nOhh [hold] yeah\n[Choir joins]\n(We can)',
    );
  });

  it('recognizes chorus variants without mistaking words beginning with a section name', () => {
    const draft =
      'Lyrics:\n[Introductory note]\nFirst line\n[Pre Chorus]\nNext line\n[Post-Chorus]\nOoo\n[Final Chorus]\nLast line';

    expect(formatGeneratedLyricsDraft(draft)).toBe(
      'Lyrics:\n[Introductory note]\nFirst line\n\n[Pre Chorus]\nNext line\n\n[Post-Chorus]\nOoo\n\n[Final Chorus]\nLast line',
    );
  });

  it('gives a sung line plain punctuation: straight quotes, no semicolons, a dash becomes a comma', () => {
    const draft =
      'Lyrics:\n[Verse]\nI said “No”, it’s fine—really\nShe left—\nOne thing; then another\nWait… what\n\n[Outro - Vamp]\nOoo-ooo';

    expect(formatGeneratedLyricsDraft(draft)).toBe(
      'Lyrics:\n[Verse]\nI said "No", it\'s fine, really\nShe left\nOne thing, then another\nWait... what\n\n[Outro - Vamp]\nOoo-ooo',
    );
  });

  it('is stable when formatting an already formatted draft again', () => {
    const draft = 'Lyrics:\n[Verse]\nOne step\n\n[Chorus]\nOne more try\n\nREADBACK: A soul song.';

    expect(formatGeneratedLyricsDraft(formatGeneratedLyricsDraft(draft))).toBe(draft);
  });

  it.each([
    'English, instrumental soul.\nREADBACK: Piano and drums.',
    'My lyrics: I ask for help\nAnd try again',
    'Lyrics:\n\nREADBACK: No words yet.',
    '',
  ])('leaves a draft without an explicit nonempty Lyrics block unchanged: %s', (draft) => {
    expect(formatGeneratedLyricsDraft(draft)).toBe(draft);
  });
});
