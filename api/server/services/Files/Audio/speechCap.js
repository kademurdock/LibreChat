/* KADE Oct 25 2026 (upstream 698ee25fe idea): a cap on the text one read-aloud request may
 * synthesize. With no cap, one 3 MB request fanned out into ~750 paid provider calls, and
 * speech is free to users, so it all lands on Kade's Inworld plan. The longest real request
 * in Jun 27 - Oct 25 2026 was 56,702 characters (28k manual and 588 streamed requests), so
 * the default leaves headroom. KADE_TTS_MAX_INPUT_CHARS overrides it with a plain whole
 * number of at least 1,000 ("100,000" or "500" fall back to the default rather than
 * silently cutting every read to a few characters). */
const DEFAULT_TTS_MAX_INPUT_CHARS = 100000;
const MIN_TTS_MAX_INPUT_CHARS = 1000;
const TAG_MARK = '%%%';
const WORD_BOUNDARY_LOOKBACK = 200;

/** @returns {number} */
function getTtsMaxInputChars() {
  const configured = Number(process.env.KADE_TTS_MAX_INPUT_CHARS);
  return Number.isInteger(configured) && configured >= MIN_TTS_MAX_INPUT_CHARS
    ? configured
    : DEFAULT_TTS_MAX_INPUT_CHARS;
}

/**
 * Reads text only up to `maxChars`, as if it ended there. Prefers to stop between words,
 * never leaves half of a %%%voice tag%%% behind (the proxy would speak it), and never ends
 * on half of an emoji's surrogate pair.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function capSpeechText(text, maxChars) {
  if (typeof text !== 'string' || text.length <= maxChars) {
    return text;
  }
  let capped = text.slice(0, Math.max(0, maxChars));
  const stop = Math.max(1, capped.length - WORD_BOUNDARY_LOOKBACK);
  for (let i = capped.length - 1; i >= stop; i--) {
    if (/\s/.test(capped[i])) {
      capped = capped.slice(0, i);
      break;
    }
  }
  if (capped.split(TAG_MARK).length % 2 === 0) {
    capped = capped.slice(0, capped.lastIndexOf(TAG_MARK));
  }
  const last = capped.charCodeAt(capped.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    capped = capped.slice(0, -1);
  }
  return capped;
}

module.exports = {
  DEFAULT_TTS_MAX_INPUT_CHARS,
  MIN_TTS_MAX_INPUT_CHARS,
  getTtsMaxInputChars,
  capSpeechText,
};
