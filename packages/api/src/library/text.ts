export const printDisabilityNotice =
  'This book was produced for people with bona fide print disabilities.';

/** Keep performance instructions off the page without removing ordinary bracketed book text. */
export function readingText(text: string): string {
  return text
    .replace(/%{2,3}[^%]*%{2,3}/g, '')
    .replace(/\[\[(?:voice|speaker)\s+[^\]]*\]\]/gi, '')
    .replace(/\[(?:sound|delivery|voice|style|tone):[^\]]*\]/gi, '')
    .trim();
}

export function readingJacket(text: string): string {
  return text
    .replace(/From Bookshare, for people with print disabilities\./gi, printDisabilityNotice)
    .replace(/\s*Please do not pass this book on\./gi, '');
}
