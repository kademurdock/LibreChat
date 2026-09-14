/** Series-level corrections supported by the catalog's own synopses. */
export function correctedBookShelf(title: string, author = '', path = ''): string | null {
  if (/^chicken soup (?:for|for the)/i.test(title)) return 'Nonfiction — Inspirational stories';
  if (title === 'The Wisdom of a Broken Heart') return 'Nonfiction — Self-help & relationships';
  if (title === 'Erotic City' && /pynk/i.test(author)) return 'Fiction — Urban';
  // Earlier imported shelf labels contain a replacement character instead of a dash.
  const damaged = path.match(/^Books\/(Fiction|Nonfiction)\s+[\uFFFD]\s+(.+)$/);
  if (damaged) return damaged[1] + ' — ' + damaged[2];
  return null;
}
