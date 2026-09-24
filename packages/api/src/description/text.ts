const breaking = /[\p{Cc}\u{2028}\u{2029}]/gu;
const hidden = /[\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200B}\u{FEFF}\u{00AD}]/gu;
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Text as NVDA should hear it: NFC, line breaks and control characters turned into spaces,
 * bidi controls, zero-width spaces and soft hyphens removed, spaces collapsed. Zero-width
 * joiners stay, because emoji sequences and some scripts need them.
 */
export function cleanLabel(value: string): string {
  return value
    .replace(loneSurrogate, '')
    .normalize('NFC')
    .replace(breaking, ' ')
    .replace(hidden, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cuts to at most `max` characters without splitting an emoji or other two-unit character. */
export function clip(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('');
}
