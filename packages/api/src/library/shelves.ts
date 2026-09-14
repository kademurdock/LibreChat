type LibraryItem = { kind?: string; category?: string; path?: string };
const categories: { [key: string]: string } = { audiobook: 'Audiobooks', movie: 'Movies', cassette: 'Cassettes', radio: 'Radio', commercials: 'Commercials', music: 'Music', tv: 'Television', vhs: 'Home video', psa: 'Public service announcements' };
export function libraryPath(item: LibraryItem): string {
  const root = item.kind === 'video' ? 'Videos' : item.kind === 'audio' ? 'Audio' : 'Books';
  const tail = (item.path || '').replace(/^(?:Books|Audio|Videos?|Recordings|Archive clips)(?:\/|$)/i, '');
  const category = libraryCategory(item);
  return root + (tail ? '/' + tail : (categories[category] ? '/' + categories[category] : ''));
}
export function libraryCategory(item: LibraryItem): string {
  if (item.kind === 'text' || !item.kind) return 'book';
  if (item.category === 'book' || (item.kind === 'video' && item.category === 'audiobook')) return 'other';
  return item.category || 'other';
}
/** Virtual shelves leave original upload paths and in-flight imports untouched. */
export function libraryPathExpression(): Record<string, unknown> {
  return { $let: { vars: {
    root: { $switch: { branches: [{ case: { $eq: ['$kind', 'video'] }, then: 'Videos' }, { case: { $eq: ['$kind', 'audio'] }, then: 'Audio' }], default: 'Books' } },
    parts: { $split: [{ $ifNull: ['$path', ''] }, '/'] },
    fallback: { $switch: { branches: Object.entries(categories).map(([key, label]) => ({ case: key === 'audiobook' ? { $and: [{ $eq: ['$category', key] }, { $ne: ['$kind', 'video'] }] } : { $eq: ['$category', key] }, then: label })), default: '' } },
  }, in: { $let: { vars: {
    tail: { $cond: [{ $in: [{ $toLower: { $arrayElemAt: ['$$parts', 0] } }, ['books', 'audio', 'videos', 'video', 'recordings', 'archive clips']] }, { $slice: ['$$parts', 1, { $size: '$$parts' }] }, '$$parts'] },
  }, in: { $concat: ['$$root', { $cond: [{ $eq: [{ $filter: { input: '$$tail', as: 'p', cond: { $ne: ['$$p', ''] } } }, []] }, { $cond: [{ $eq: ['$$fallback', ''] }, '', { $concat: ['/', '$$fallback'] }] }, { $reduce: { input: '$$tail', initialValue: '', in: { $concat: ['$$value', '/', '$$this'] } } }] }] } } } } };
}
