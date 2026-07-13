/**
 * KADE July 13 2026 — read-aloud text hygiene (client mirror of the server's
 * api/server/services/Files/Audio/scrubForSpeech.js). Strips web-search
 * SOURCES/citations/URLs the model appends (Grok recites them otherwise), but
 * DELIBERATELY KEEPS %%% voice-performance tags — those must reach the inworld
 * TTS proxy, which converts them to real steering before synthesis. Keep this
 * in sync with the server copy.
 */

const TRAILING_SOURCES_RE =
  /\n+\s*(?:#{1,6}\s*)?(?:\*{0,2})(?:sources|references|citations|works cited)(?:\*{0,2})\s*:?\s*\n[\s\S]*$/i;
const CITATION_ANCHOR_RE = /(?:\\?u[eE]20[0-9a-fA-F])?turn\d+(?:search|image|news|video|ref|file)\d+/g;
const PUA_RE = /[\uE200-\uE20F\uF000-\uF0FF]/g;
const LITERAL_NBSP_RE = /\\u00a0/gi;
const FOOTNOTE_REF_RE = /\s*\[(?:\d{1,3})\](?=[\s.,;:!?)]|$)/g;
const MD_LINK_RE = /\[([^\]]+)\]\((?:[^)]*)\)/g;
const MD_IMAGE_RE = /!\[([^\]]*)\]\((?:[^)]*)\)/g;
const BARE_URL_RE = /\bhttps?:\/\/\S+/gi;

export function scrubForSpeech(text: string): string {
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
