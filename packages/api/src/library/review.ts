interface ReviewedMove {
  id: string;
  from: string;
  title: string;
  kind: string;
  to: string;
  category: string;
  addTags?: string[];
  newTitle?: string;
}

interface ReviewedOperation {
  updateOne: {
    filter: { _id: string; path: string; title: string; kind: string; state: string };
    update: {
      $set: { path: string; category: string; title?: string };
      $addToSet?: { tags: { $each: string[] } };
    };
  };
}

export function reviewedLibraryMoves(moves: ReviewedMove[], categories: readonly string[]): ReviewedOperation[] {
  if (!Array.isArray(moves) || !moves.length || moves.length > 500) throw new Error('Supply 1–500 reviewed items.');
  const ids = new Set<string>();
  return moves.map((move) => {
    if (!move || typeof move.id !== 'string' || !/^[a-f0-9]{24}$/i.test(move.id) || ids.has(move.id.toLowerCase())) throw new Error('Invalid or duplicate item ID.');
    ids.add(move.id.toLowerCase());
    if (typeof move.from !== 'string' || typeof move.title !== 'string' || typeof move.to !== 'string') throw new Error('Each item needs its current title, current folder and destination.');
    if (!['text', 'audio', 'video'].includes(move.kind)) throw new Error('Invalid media kind.');
    const root = move.kind === 'text' ? /^Books\// : move.kind === 'audio' ? /^Audio\// : /^Videos?\//;
    if (!root.test(move.to) || move.to.length > 400 || /[\\\x00-\x1f]/.test(move.to) || move.to.split('/').some((part) => !part.trim() || part === '.' || part === '..')) throw new Error('Destination must be a valid folder for this media kind.');
    if (!categories.includes(move.category) || (move.kind !== 'text' && move.category === 'book')) throw new Error('Invalid category for this media.');
    const tags = move.addTags || [];
    if (!Array.isArray(tags) || tags.length > 12 || tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 80)) throw new Error('Invalid discovery tags.');
    if (move.newTitle !== undefined && (typeof move.newTitle !== 'string' || !move.newTitle.trim() || move.newTitle.length > 300)) throw new Error('Invalid repaired title.');
    return {
      updateOne: {
        filter: { _id: move.id, path: move.from, title: move.title, kind: move.kind, state: 'ready' },
        update: {
          $set: { path: move.to, category: move.category, ...(move.newTitle !== undefined ? { title: move.newTitle.trim() } : {}) },
          ...(tags.length ? { $addToSet: { tags: { $each: [...new Set(tags.map((tag) => tag.trim()))] } } } : {}),
        },
      },
    };
  });
}
