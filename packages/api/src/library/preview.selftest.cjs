const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const test = require('node:test');
const code = Module.stripTypeScriptTypes(fs.readFileSync(__dirname + '/preview.ts', 'utf8')).replace(/^export /gm, '') + '\nmodule.exports={filingPreviewIds,previewLibraryFolders};';
const compiled = new Module(__filename + '.compiled', module);
compiled._compile(code, __filename + '.compiled');
const { filingPreviewIds, previewLibraryFolders } = compiled.exports;
test('preview requires a bounded, valid selection', () => {
  for (const value of [undefined, [], ['bad'], Array(101).fill('a'.repeat(24))]) assert.throws(() => filingPreviewIds(value));
  assert.deepEqual(filingPreviewIds(['A'.repeat(24), 'a'.repeat(24)]), ['a'.repeat(24)]);
});
test('preview asks only about intake and returns guarded moves with undo metadata', async () => {
  const items = [{ _id: '1', title: 'Unknown ad', path: 'Videos/Needs Filing', kind: 'video', category: 'other' }, { _id: '2', title: 'Filed', path: 'Video/Channels/Noggin', kind: 'video' }];
  const before = JSON.stringify(items);
  const result = await previewLibraryFolders(items, {
    zoneOf: (item) => item._id === '1' ? 'intake' : 'filed', categoryOf: () => 'commercials',
    fileMedia: async (batch) => {
      assert.equal(batch.length, 1);
      return { decisions: [{ item: batch[0], to: 'Video/Commercials/Food & Grocery/1990s', why: 'Product named in description', confidence: 0.95 }], costUSD: 0.001 };
    },
  });
  assert.equal(JSON.stringify(items), before);
  assert.equal(result.changes[0].from, items[0].path);
  assert.equal(result.changes[0].oldCategory, 'other');
  assert.equal(result.changes[0].category, 'commercials');
  assert.match(result.skipped[0].reason, /Already filed/);
});
test('uncertain and unavailable judgements stay unresolved', async () => {
  const item = { _id: '1', title: 'Unknown', path: 'Videos/Needs Filing', kind: 'video' };
  for (const decision of [{ item, to: null }, { item, error: 'timeout' }]) {
    const result = await previewLibraryFolders([item], { zoneOf: () => 'intake', categoryOf: () => 'tv', fileMedia: async () => ({ decisions: [decision], costUSD: 0 }) });
    assert.equal(result.changes.length, 0);
    assert.equal(result.skipped.length, 1);
  }
});
test('an already-filed selection uses no model request', async () => {
  const result = await previewLibraryFolders([{ _id: '1', title: 'Filed', kind: 'audio', path: 'Audio/Audiobooks' }], { zoneOf: () => 'filed', categoryOf: () => 'audiobook', fileMedia: () => { throw new Error('must not call'); } });
  assert.equal(result.costUSD, 0);
  assert.equal(result.changes.length, 0);
});
