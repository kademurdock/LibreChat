const { scrubForSpeech } = require('./scrubForSpeech');

/** Jest cannot interrupt synchronous work, so a timeout alone never fails a slow regex. */
const timed = (fn) => {
  const started = performance.now();
  const result = fn();
  return { result, ms: performance.now() - started };
};

describe('scrubForSpeech', () => {
  it('drops a trailing sources block', () => {
    const text = 'Here is the answer.\n\n**Sources**:\n- [One](https://a.b)\n- [Two](https://c.d)';
    expect(scrubForSpeech(text)).toBe('Here is the answer.');
  });

  it('drops a trailing references heading block', () => {
    expect(scrubForSpeech('It rained.\n\n### References\n1. Thing')).toBe('It rained.');
  });

  it('keeps a sources line that is not followed by a newline', () => {
    expect(scrubForSpeech('See the sources below')).toBe('See the sources below');
  });

  it('drops footnote markers', () => {
    expect(scrubForSpeech('It rained [1]. Then it stopped.[2]')).toBe(
      'It rained. Then it stopped.',
    );
  });

  it('reads links and images as their labels', () => {
    expect(
      scrubForSpeech('Look: ![a picture](https://img/x.png) and [the map](https://m/x).'),
    ).toBe('Look: a picture and the map.');
  });

  it('removes tagged reasoning but keeps voice tags', () => {
    const text =
      '<think>plan it</think>%%%bright%%% Hi!\uF001hidden\uF002 :::thinking\nhmm\n:::\nDone.';
    expect(scrubForSpeech(text)).toBe('%%%bright%%% Hi! Done.');
  });

  it('leaves an unclosed reasoning tag alone, as before', () => {
    expect(scrubForSpeech('<think>never closed')).toBe('<think>never closed');
  });

  it.each([
    ['blank lines', '\n'.repeat(100_000) + 'x'],
    ['spaces', `a${' '.repeat(100_000)}x`],
    ['a heading followed by spaces', `\nsources${' '.repeat(100_000)}x`],
    ['unclosed brackets', '['.repeat(100_000)],
    ['unclosed image openers', '!['.repeat(50_000)],
    ['links that never close', '[a]('.repeat(25_000)],
    ['unclosed think tags', '<think>'.repeat(14_000)],
    ['unclosed reasoning marks', '\uF001'.repeat(100_000)],
  ])('stays fast on 100k characters of %s', (_name, text) => {
    const { ms } = timed(() => scrubForSpeech(text));
    expect(ms).toBeLessThan(1_000);
  });
});
