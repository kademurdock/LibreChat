const { DEFAULT_TTS_MAX_INPUT_CHARS, getTtsMaxInputChars, capSpeechText } = require('./speechCap');

describe('getTtsMaxInputChars', () => {
  const original = process.env.KADE_TTS_MAX_INPUT_CHARS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.KADE_TTS_MAX_INPUT_CHARS;
    } else {
      process.env.KADE_TTS_MAX_INPUT_CHARS = original;
    }
  });

  it('defaults well above the longest real read (56,702 characters)', () => {
    delete process.env.KADE_TTS_MAX_INPUT_CHARS;
    expect(getTtsMaxInputChars()).toBe(DEFAULT_TTS_MAX_INPUT_CHARS);
    expect(DEFAULT_TTS_MAX_INPUT_CHARS).toBeGreaterThan(56702);
  });

  it('takes a positive whole number from KADE_TTS_MAX_INPUT_CHARS', () => {
    process.env.KADE_TTS_MAX_INPUT_CHARS = '250000';
    expect(getTtsMaxInputChars()).toBe(250000);
  });

  it('accepts exponent form', () => {
    process.env.KADE_TTS_MAX_INPUT_CHARS = '2e5';
    expect(getTtsMaxInputChars()).toBe(200000);
  });

  it.each(['0', '-5', 'lots', '', '100,000', '500', '1500.5'])(
    'falls back to the default for %p instead of a tiny or broken cap',
    (value) => {
      process.env.KADE_TTS_MAX_INPUT_CHARS = value;
      expect(getTtsMaxInputChars()).toBe(DEFAULT_TTS_MAX_INPUT_CHARS);
    },
  );
});

describe('capSpeechText', () => {
  it('leaves text at or under the cap alone', () => {
    expect(capSpeechText('Hello there, friend.', 20)).toBe('Hello there, friend.');
    expect(capSpeechText('Hello there.', 100)).toBe('Hello there.');
  });

  it('leaves non-strings alone', () => {
    expect(capSpeechText(undefined, 10)).toBeUndefined();
  });

  it('never returns more than the cap and stops between words', () => {
    const result = capSpeechText('one two three four five six', 15);
    expect(result.length).toBeLessThanOrEqual(15);
    expect(result).toBe('one two three');
  });

  it('drops a voice tag the cap would cut in half', () => {
    const text = 'First part. %%%bright and easy%%% Second part goes on and on.';
    const cut = text.indexOf('easy');
    const result = capSpeechText(text, cut);
    expect(result).not.toContain('%%%');
    expect(result.trim()).toBe('First part.');
  });

  it('keeps a whole voice tag that fits', () => {
    const text = '%%%warm%%% Hello there, this keeps going for a while.';
    const result = capSpeechText(text, 25);
    expect(result.startsWith('%%%warm%%%')).toBe(true);
    expect(result.split('%%%').length % 2).toBe(1);
  });

  it('never leaves half of a voice tag that contains spaces', () => {
    const text = 'Opening line. %%%bright and easy%%% then the rest of the reply goes on.';
    for (let cap = 14; cap < text.length; cap++) {
      const result = capSpeechText(text, cap);
      expect(result.split('%%%').length % 2).toBe(1);
      expect(result.length).toBeLessThanOrEqual(cap);
    }
  });

  it('never ends on half of an emoji', () => {
    const result = capSpeechText('😀'.repeat(600), 1001);
    const last = result.charCodeAt(result.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(result.length).toBeLessThanOrEqual(1001);
  });

  it('cuts a long word-free run at the cap', () => {
    expect(capSpeechText('x'.repeat(5000), 1000)).toHaveLength(1000);
  });

  it('caps a 3 MB request quickly', () => {
    const started = Date.now();
    const result = capSpeechText('word '.repeat(600000), DEFAULT_TTS_MAX_INPUT_CHARS);
    expect(result.length).toBeLessThanOrEqual(DEFAULT_TTS_MAX_INPUT_CHARS);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
