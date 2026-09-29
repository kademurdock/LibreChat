const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** "98" -> "ninety_eight", "2026" -> "two_thousand_twenty_six"; past 9999, digit by digit. */
function numberWords(digits: string): string {
  const n = Number(digits);
  if (!Number.isInteger(n) || n > 9999 || (digits.length > 1 && digits.startsWith('0'))) {
    return digits.split('').map((d) => ONES[Number(d)]).join('_');
  }
  const words: string[] = [];
  let rest = n;
  if (rest >= 1000) { words.push(ONES[Math.floor(rest / 1000)], 'thousand'); rest %= 1000; }
  if (rest >= 100) { words.push(ONES[Math.floor(rest / 100)], 'hundred'); rest %= 100; }
  if (rest >= 20) { words.push(TENS[Math.floor(rest / 10)]); rest %= 10; if (rest) words.push(ONES[rest]); }
  else if (rest > 0 || words.length === 0) words.push(ONES[rest]);
  return words.join('_');
}

/**
 * The memory schema only takes lowercase letters and underscores. Writers
 * still send "Dad-Health", "render_hung_98_minutes" (the canon instructions'
 * own example did, until Sep 29 2026) or "concert crew", and every one of
 * those was a lost card: Amber A's keeper failed three writes on Sep 28 with
 * "Key must only contain lowercase letters and underscores". Normalise
 * instead: lowercase, numbers as words, anything else an underscore.
 * A key with nothing usable left comes back unchanged, so the schema still
 * refuses it with its own message.
 */
export function normalizeMemoryKey(raw: string): string {
  const original = String(raw ?? '');
  /* A key the schema already takes is left exactly as it is, so an existing
   * card (even one with a doubled or leading underscore) still matches. */
  if (/^[a-z_]+$/.test(original)) return original;
  const key = original
    .trim()
    .toLowerCase()
    .replace(/\d+/g, (d) => `_${numberWords(d)}_`)
    .replace(/[^a-z_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /[a-z]/.test(key) ? key : original;
}
