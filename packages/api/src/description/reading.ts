export const readingChunkLimit = 180;
export const readingTextLimit = 6000;

/** Splits a finite screen reading without losing, reordering or cutting any word. */
export function readingChunks(value: string, format?: (text: string) => string): string[] {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > readingTextLimit)
    throw new SyntaxError('The screen reading was empty or too long.');
  const text = format ? format(normalized) : normalized;
  if (!text || text.length > readingTextLimit)
    throw new SyntaxError('The screen reading was empty or too long.');
  const chunks: string[] = [];
  let chunk = '';
  for (const word of text.split(' ')) {
    if (word.length > readingChunkLimit)
      throw new SyntaxError('A screen reading word was too long to preserve.');
    if (chunk && chunk.length + word.length + 1 > readingChunkLimit) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk = chunk ? `${chunk} ${word}` : word;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
