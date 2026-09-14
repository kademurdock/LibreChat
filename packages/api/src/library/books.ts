/** Series-level corrections supported by the catalog's own synopses. */
export function correctedBookShelf(title: string, author = ''): string | null {
  if (/^chicken soup (?:for|for the)/i.test(title)) return 'Nonfiction — Inspirational stories';
  if (title === 'The Wisdom of a Broken Heart') return 'Nonfiction — Self-help & relationships';
  if (title === 'Erotic City' && /pynk/i.test(author)) return 'Fiction — Urban';
  return null;
}
