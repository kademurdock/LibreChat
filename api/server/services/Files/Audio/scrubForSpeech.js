/**
 * KADE July 13 2026 — read-aloud text hygiene.
 *
 * Bug report (right after the Grok 4.20 flip): read-aloud started (a) speaking
 * from the "middle" — actually the model's REASONING, which the auto-play path
 * included while the manual path skipped it — and (b) reciting web-search
 * SOURCES/citations at the end. Grok is a search-happy model and appends a
 * sources block + citation anchors more readily than Hermes did.
 *
 * This is the single server-side chokepoint for the auto-play TTS text (the
 * inworld proxy still strips its own citation glyphs downstream; this catches
 * the VISIBLE-prose citation shapes the proxy can't, and trims a trailing
 * Sources section entirely so it's never voiced).
 */

/* KADE Oct 25 2026 — LINEAR-TIME PATTERNS. Five of the patterns below used to backtrack:
 * the old trailing-sources pattern (\n+\s* ... \s*:?\s*\n) split whitespace runs every
 * possible way, so 2,000 blank lines held the whole server for 3 s and 4,000 for 50 s, and
 * any signed-in account could send that to /tts/manual. The footnote, markdown-link/image
 * and lazy reasoning-block patterns rescanned to the end of the text for every unclosed
 * opener (100k characters: 2-15 s each). The replacements below match exactly what the old
 * patterns matched (300k random inputs each, 0 differences) and take milliseconds on
 * 400k-character attack input. Keep them linear: no nested or adjacent quantifiers that can
 * share characters, and no lazy scans that restart per opener. */

// Trailing "Sources:" / "References:" / "Citations:" block → gone (it's the
// last thing in the reply; everything from that heading on is link soup).
// Only the first newline of a whitespace run may start a match (an earlier newline always
// wins), and the tail only has to prove that a newline follows the heading.
const TRAILING_SOURCES_RE =
  /\n(?<!\n\s*?\n)\s*(?:#{1,6}\s*)?(?:\*{0,2})(?:sources|references|citations|works cited)(?:\*{0,2})(?:[^\S\n]*\n|[^\S\n]*:[^\S\n]*\n)[\s\S]*$/i;

// Citation anchor tokens the model may type as literal text ("turn0search3"),
// with or without the escaped/real private-use prefix.
const CITATION_ANCHOR_RE = /(?:\\?u[eE]20[0-9a-fA-F]|\b)(?:turn\d+[a-z]+\d+)+\b/gi;

// Private-use citation glyphs (explicit escapes, heredoc-safe).
const PUA_RE = /[\uE200-\uE20F\uF000-\uF0FF]/g;

// Literal escape-text a model sometimes types in prose.
const LITERAL_NBSP_RE = /\\u00a0/gi;

// Bare bracketed footnote refs at end of sentences: "...fact.[1][2]" → "...fact."
// A whitespace run can only start a match at its first character.
const FOOTNOTE_REF_RE = /(?<!\s)\s*\[(?:\d{1,3})\](?=[\s.,;:!?)]|$)/g;

/**
 * Markdown links → just the visible label (never speak a URL). Same result as
 * /\[([^\]]+)\]\((?:[^)]*)\)/g (links) or /!\[([^\]]*)\]\((?:[^)]*)\)/g (images),
 * but each ']' and ')' is looked up once instead of once per '['.
 * @param {string} text
 * @param {boolean} image
 * @returns {string}
 */
function replaceMarkdownLinks(text, image) {
  const opener = image ? '![' : '[';
  let out = '';
  let pos = 0;
  let from = 0;
  let bracket = -2;
  let paren = -2;
  const nextBracket = (i) => {
    if (bracket === -2 || (bracket !== -1 && bracket < i)) {
      bracket = text.indexOf(']', i);
    }
    return bracket;
  };
  const nextParen = (i) => {
    if (paren === -2 || (paren !== -1 && paren < i)) {
      paren = text.indexOf(')', i);
    }
    return paren;
  };
  for (;;) {
    const i = text.indexOf(opener, from);
    if (i === -1) {
      break;
    }
    const labelStart = i + opener.length;
    const j = nextBracket(labelStart);
    if (j === -1) {
      break;
    }
    if ((!image && j === labelStart) || text[j + 1] !== '(') {
      from = i + 1;
      continue;
    }
    const k = nextParen(j + 2);
    if (k === -1) {
      break;
    }
    out += text.slice(pos, i) + text.slice(labelStart, j);
    pos = k + 1;
    from = k + 1;
  }
  return pos === 0 ? text : out + text.slice(pos);
}

/**
 * Removes every open…close span, shortest first, like /open[\s\S]*?close/g, without
 * rescanning to the end of the text for each opener that never closes.
 * @param {string} text
 * @param {RegExp} openRe - global
 * @param {RegExp} closeRe - global
 * @returns {string}
 */
function removeDelimited(text, openRe, closeRe) {
  let out = '';
  let pos = 0;
  for (;;) {
    openRe.lastIndex = pos;
    const open = openRe.exec(text);
    if (!open) {
      break;
    }
    closeRe.lastIndex = open.index + open[0].length;
    const close = closeRe.exec(text);
    if (!close) {
      break;
    }
    out += text.slice(pos, open.index);
    pos = close.index + close[0].length;
  }
  return pos === 0 ? text : out + text.slice(pos);
}

// Bare URLs anywhere → dropped (a spoken URL is noise).
const BARE_URL_RE = /\bhttps?:\/\/\S+/gi;

// KADE July 13 2026: DeepSeek V4 Pro is a thinking model. Its reasoning is
// supposed to stay in a hidden channel, but on tool turns it can surface as
// tagged thinking blocks in the spoken text. Strip every tagged form so
// read-aloud never voices the model's reasoning (untagged reasoning-in-content
// is a separate, model-side issue — this covers the tagged forms).
// <think>\u2026</think> and \uF001\u2026\uF002 go through removeDelimited (linear); the
// :::thinking block closes on the next ":::" and stays a regex.
const THINK_OPEN_RE = /<think>/gi;
const THINK_CLOSE_RE = /<\/think>/gi;
const THINK_BLOCK_RE = /:::thinking[\s\S]*?:::\n?/gi;
const PUA_REASON_OPEN_RE = /\uF001/g;
const PUA_REASON_CLOSE_RE = /\uF002/g;
const DEEP_THINK_MARKER_RE = /\[DEEP THINK(?:\s+\d{10,17})?\]/gi;
/* KADE Aug 14 2026: [INSTANT <ms>] is DEEP THINK's twin — the thinking
 * picker's Instant mode and the "Answer now instead" button stamp it on the
 * OUTGOING user message. Read-aloud must never voice it, same as its twin. */
const INSTANT_MARKER_RE = /\[INSTANT(?:\s+\d{10,17})?\]/gi;

function scrubForSpeech(text) {
  if (!text || typeof text !== 'string') {
    return text;
  }
  const unthought = removeDelimited(
    removeDelimited(text, THINK_OPEN_RE, THINK_CLOSE_RE).replace(THINK_BLOCK_RE, ''),
    PUA_REASON_OPEN_RE,
    PUA_REASON_CLOSE_RE,
  );
  const delinked = replaceMarkdownLinks(
    replaceMarkdownLinks(
      unthought
        .replace(DEEP_THINK_MARKER_RE, '')
        .replace(INSTANT_MARKER_RE, '')
        .replace(TRAILING_SOURCES_RE, ''),
      true,
    ),
    false,
  );
  return delinked
    .replace(CITATION_ANCHOR_RE, '')
    .replace(PUA_RE, '')
    .replace(LITERAL_NBSP_RE, ' ')
    .replace(FOOTNOTE_REF_RE, '')
    .replace(BARE_URL_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,!?;:])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { scrubForSpeech };
