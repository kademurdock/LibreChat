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

// Trailing "Sources:" / "References:" / "Citations:" block → gone (it's the
// last thing in the reply; everything from that heading on is link soup).
const TRAILING_SOURCES_RE =
  /\n+\s*(?:#{1,6}\s*)?(?:\*{0,2})(?:sources|references|citations|works cited)(?:\*{0,2})\s*:?\s*\n[\s\S]*$/i;

// Citation anchor tokens the model may type as literal text ("turn0search3"),
// with or without the escaped/real private-use prefix.
const CITATION_ANCHOR_RE = /(?:\\?u[eE]20[0-9a-fA-F])?turn\d+(?:search|image|news|video|ref|file)\d+/g;

// Private-use citation glyphs (explicit escapes, heredoc-safe).
const PUA_RE = /[\uE200-\uE20F\uF000-\uF0FF]/g;

// Literal escape-text a model sometimes types in prose.
const LITERAL_NBSP_RE = /\\u00a0/gi;

// Bare bracketed footnote refs at end of sentences: "...fact.[1][2]" → "...fact."
const FOOTNOTE_REF_RE = /\s*\[(?:\d{1,3})\](?=[\s.,;:!?)]|$)/g;

// Markdown links → just the visible label (never speak a URL).
const MD_LINK_RE = /\[([^\]]+)\]\((?:[^)]*)\)/g;
const MD_IMAGE_RE = /!\[([^\]]*)\]\((?:[^)]*)\)/g;

// Bare URLs anywhere → dropped (a spoken URL is noise).
const BARE_URL_RE = /\bhttps?:\/\/\S+/gi;

function scrubForSpeech(text) {
  if (!text || typeof text !== 'string') {
    return text;
  }
  return text
    .replace(TRAILING_SOURCES_RE, '')
    .replace(MD_IMAGE_RE, '$1')
    .replace(MD_LINK_RE, '$1')
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
