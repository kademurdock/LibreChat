/**
 * Citation Regex Patterns
 *
 * These patterns handle two formats that LLMs may output:
 * 1. Literal escape sequences: "\ue202turn0search0" (backslash + "ue202" = 6 chars)
 * 2. Actual Unicode characters: "turn0search0" (U+E202 = 1 char, private use area)
 *
 * The system instructs LLMs to output literal escape sequences, but some models
 * may convert them to actual Unicode characters during text generation. These
 * dual-format patterns ensure robust citation handling regardless of output format.
 *
 * Citation Format:
 * - \ue202 / U+E202: Standalone citation marker (before each anchor)
 * - \ue200 / U+E200: Composite group start
 * - \ue201 / U+E201: Composite group end
 * - \ue203 / U+E203: Highlight span start
 * - \ue204 / U+E204: Highlight span end
 *
 * Anchor Pattern: turn{N}{type}{index}
 * - N: Turn number (0-based)
 * - type: search|image|news|video|ref|file
 * - index: Result index within that type (0-based)
 *
 * Examples:
 * - Standalone: "Statement.\ue202turn0search0"
 * - Composite: "\ue200\ue202turn0search0\ue202turn0news1\ue201"
 * - Highlighted: "\ue203Cited text.\ue204\ue202turn0search0"
 */

/** Matches highlighted text spans in both literal and Unicode formats */
export const SPAN_REGEX = /((?:\\ue203|\ue203).*?(?:\\ue204|\ue204))/g;

/** Matches composite citation blocks (multiple citations grouped together) */
export const COMPOSITE_REGEX = /((?:\\ue200|\ue200).*?(?:\\ue201|\ue201))/g;

/** Matches standalone citation anchors with turn, type, and index capture groups */
export const STANDALONE_PATTERN =
  /(?:\\ue202|\ue202)turn(\d+)(search|image|news|video|ref|file)(\d+)/g;

/** Removes all citation marker characters from text for clean display */
export const CLEANUP_REGEX =
  /\\ue200|\\ue201|\\ue202|\\ue203|\\ue204|\\ue206|\ue200|\ue201|\ue202|\ue203|\ue204|\ue206/g;

/** Matches invalid/orphaned citations (with leading whitespace) for removal */
export const INVALID_CITATION_REGEX =
  /\s*(?:\\ue202|\ue202)turn\d+(search|news|image|video|ref|file)\d+/g;

/**
 * KADE July 11 2026: literal escaped non-breaking spaces typed as TEXT by the
 * model ("\u00A0" appearing verbatim in prose — a habit Hermes 4 picked up
 * from the citation escape-sequence format; seen live in Kade's chat).
 * Replace with a plain space at display/announce/copy time. Applied only to
 * markdown TEXT nodes (and speech/announcement strings), never code blocks.
 */
export const LITERAL_NBSP_REGEX = /\\u00a0/gi;

/**
 * KADE July 13 2026 -- BARE citation anchors with NO leading PUA glyph.
 * DeepSeek + Grok emit "turn0search1" as PLAIN TEXT (the  sentinel wrap
 * is provider-specific to OpenAI-style search), so the glyph-REQUIRED
 * INVALID_CITATION_REGEX / STANDALONE_PATTERN miss them and they leak into the
 * copy + export output (Kade's report on Kiana/DeepSeek). Matches the anchor
 * with or without a glyph/escape prefix; mirrors scrubForSpeech.ts and the
 * inline regexes already in LiveAnnouncer/ConversationMode.
 */
export const BARE_CITATION_REGEX =
  /(?:\\?u[eE]20[0-9a-fA-F])?turn\d+(?:search|image|news|video|ref|file)\d+/g;
