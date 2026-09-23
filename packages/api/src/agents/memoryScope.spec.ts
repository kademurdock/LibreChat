import { existingMemoryScope } from './memoryScope';

describe('existing memory bucket ownership', () => {
  test('a correction cannot copy a private fact into shared memory', () => {
    expect(existingMemoryScope([{ key: 'snack', agentId: 'kiana' }], 'snack', undefined)).toBe('kiana');
  });
  test('an existing shared fact stays shared when the writer changes its scope', () => {
    expect(existingMemoryScope([{ key: 'snack' }], 'snack', 'kiana')).toBeUndefined();
  });
  test('same key in different buckets remains explicitly selectable', () => {
    const rows = [{ key: 'how_we_talk' }, { key: 'how_we_talk', agentId: 'kiana' }];
    expect(existingMemoryScope(rows, 'how_we_talk', 'kiana')).toBe('kiana');
    expect(existingMemoryScope(rows, 'how_we_talk', undefined)).toBeUndefined();
  });
  test('new topics use requested scope, without inheriting another topic', () => {
    expect(existingMemoryScope([{ key: 'snack', agentId: 'kiana' }], 'pet', undefined)).toBeUndefined();
  });
});
