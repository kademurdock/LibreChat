/** Max character length for sanitized titles (the output will never exceed this). */
export const MAX_TITLE_LENGTH = 200;
export const DEFAULT_TITLE_FALLBACK = 'Untitled Conversation';

/**
 * Sanitizes LLM-generated chat titles by removing {@link https://en.wikipedia.org/wiki/Chain-of-thought_prompting <think>}
 * reasoning blocks, normalizing whitespace, and truncating to {@link MAX_TITLE_LENGTH} characters.
 *
 * Titles exceeding the limit are truncated at a code-point-safe boundary and suffixed with `...`.
 *
 * @param rawTitle - The raw LLM-generated title string, potentially containing <think> blocks.
 * @returns A sanitized, potentially truncated title string, never empty (fallback used if needed).
 */
export function sanitizeTitle(rawTitle: string): string {
  if (!rawTitle || typeof rawTitle !== 'string') {
    return DEFAULT_TITLE_FALLBACK;
  }

  const thinkBlockRegex = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
  let cleaned = rawTitle.replace(thinkBlockRegex, '');

  // KADE July 16 2026 — titles were picking up junk from this platform's own
  // pipeline. Strip, in order:
  // 1. PUA-sentinel reasoning blocks (reframe-proxy wraps streamed reasoning
  //    in U+F001/U+F002 — a title generated through the streamed path can
  //    carry the whole hidden think block), then any stray PUA characters.
  cleaned = cleaned.replace(/\uF001[\s\S]*?\uF002/g, '');
  cleaned = cleaned.replace(/[\uE000-\uF8FF]/g, '');
  // 2. %%%…%%% voice-performance tags and [sound:]/[watch:] cue tokens — never
  //    meant for any reading surface, titles included.
  cleaned = cleaned.replace(/%%%[\s\S]*?%%%/g, ' ').replace(/%%%/g, ' ');
  cleaned = cleaned.replace(/\[(?:sound|watch)\s*:[^\]]*\]/gi, ' ');
  // 3. Markdown dressing some title models add despite the prompt.
  cleaned = cleaned.replace(/[*_\`#]+/g, '');

  const normalized = cleaned.replace(/\s+/g, ' ');
  let trimmed = normalized.trim();

  // 4. "Title:" prefixes, one pair of surrounding quotes, trailing period.
  trimmed = trimmed.replace(/^title\s*[:\u2014-]\s*/i, '');
  const quotePairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['\u201C', '\u201D'],
    ['\u2018', '\u2019'],
    ['\u00AB', '\u00BB'],
  ];
  for (const [open, close] of quotePairs) {
    if (trimmed.length > 1 && trimmed.startsWith(open) && trimmed.endsWith(close)) {
      trimmed = trimmed.slice(1, -1).trim();
      break;
    }
  }
  trimmed = trimmed.replace(/[.\u3002]+$/, '').trim();

  if (trimmed.length === 0) {
    return DEFAULT_TITLE_FALLBACK;
  }

  const codePoints = [...trimmed];
  if (codePoints.length > MAX_TITLE_LENGTH) {
    const truncateAt = MAX_TITLE_LENGTH - 3;
    return codePoints.slice(0, truncateAt).join('').trimEnd() + '...';
  }

  return trimmed;
}
