import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import mongoose, { Schema, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { catalogProjection, catalogSearchPipeline, readLibraryCatalog } from './catalog';
import type { CatalogItem, LibraryDependencies, LibraryReader } from './catalog';

let mongo: MongoMemoryServer;
const me = new Types.ObjectId(),
  other = new Types.ObjectId();
const reader: LibraryReader = { id: String(me), child: false, hidden: false };
const Item = mongoose.model<CatalogItem>(
  'CatalogFixture',
  new Schema<CatalogItem>({}, { strict: false }),
);
const ids = {
  own: new Types.ObjectId(),
  secret: new Types.ObjectId(),
  shared: new Types.ObjectId(),
  adult: new Types.ObjectId(),
  book: new Types.ObjectId(),
  pending: new Types.ObjectId(),
};
let passageReads = 0;
const deps: LibraryDependencies = {
  search: (pipeline) => Item.aggregate<CatalogItem>(pipeline).exec(),
  details: (filter) => Item.findOne(filter).select(catalogProjection).lean(),
  passage: async () => {
    passageReads++;
    return {
      text: 'A real stored passage about a lighthouse.',
      title: 'The light',
      chunks: 2,
      sections: 3,
    };
  },
};

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Item.insertMany([
    {
      _id: ids.own,
      owner: me,
      state: 'ready',
      shared: false,
      kind: 'audio',
      title: 'Private aircheck',
      description: 'Springfield presenter at sunrise',
    },
    {
      _id: ids.secret,
      owner: other,
      state: 'ready',
      shared: false,
      title: 'Secret Springfield tape',
      description: 'hidden phrase: marmalade dragon',
    },
    {
      _id: ids.shared,
      owner: other,
      state: 'ready',
      shared: true,
      kind: 'video',
      title: 'Cheerios 1994',
      description: 'A woman sings about breakfast cereal',
      path: 'Videos/Commercials/Food',
      tracks: [
        {
          title: 'TV spot',
          seconds: 30,
          key: 'private-storage-key',
          description: {
            state: 'done',
            summary: 'A kitchen scene',
            scenes: [{ t: 3, text: 'A blue toucan dances' }],
          },
        },
      ],
      meta: { sourceUrl: 'https://example.com/record', privateReview: 'do not reveal me' },
    },
    {
      _id: ids.adult,
      owner: other,
      state: 'ready',
      shared: true,
      grownUpsOnly: true,
      title: 'Springfield grownups special',
    },
    {
      _id: ids.book,
      owner: other,
      state: 'ready',
      shared: true,
      kind: 'text',
      title: 'Lighthouse',
      synopsis: 'Ships and harbors',
      sections: [{ title: 'The light', chunkCount: 2 }],
    },
    {
      _id: ids.pending,
      owner: me,
      state: 'pending',
      shared: true,
      title: 'Springfield unfinished',
    },
    ...Array.from({ length: 26 }, (_, i) => ({
      owner: other,
      state: 'ready',
      shared: true,
      title: 'Serial radio ' + String(i).padStart(2, '0'),
    })),
  ]);
});
after(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

test('remembered details and alternative keywords find actual catalog records', async () => {
  const result = await readLibraryCatalog(
    { action: 'search', queries: ['nonexistent slogan', 'woman breakfast'] },
    reader,
    deps,
  );
  assert.ok('items' in result);
  assert.equal(result.items?.[0]?.id, String(ids.shared));
  assert.equal(result.items?.[0]?.url, '/library?book=' + ids.shared);
  assert.match(result.items?.[0]?.evidence[0].text || '', /woman/);
});
test('scene notes, folder facts, and spelling mistakes can identify candidates', async () => {
  for (const query of ['blue toucan', 'commercials food', 'Cheerious']) {
    const result = await readLibraryCatalog({ action: 'search', queries: [query] }, reader, deps);
    assert.ok('items' in result);
    assert.equal(result.items?.[0]?.id, String(ids.shared), query);
    if (query === 'Cheerious') assert.equal(result.approximate, true);
  }
});
test('ordinary reader sees shared and own ready items, never another private item', async () => {
  const result = await readLibraryCatalog(
    { action: 'search', queries: ['Springfield'] },
    reader,
    deps,
  );
  assert.ok('items' in result);
  assert.deepEqual(
    new Set(result.items?.map((item) => item.id)),
    new Set([String(ids.own), String(ids.adult)]),
  );
  assert.deepEqual(
    await readLibraryCatalog({ action: 'details', id: String(ids.secret) }, reader, deps),
    { error: 'That item is unavailable.' },
  );
  const initial = passageReads;
  await readLibraryCatalog({ action: 'passage', id: String(ids.secret) }, reader, deps);
  assert.equal(passageReads, initial);
});
test('child and hidden-library account restrictions apply to search and guessed IDs', async () => {
  for (const restricted of [
    { ...reader, child: true },
    { ...reader, hidden: true },
  ]) {
    const result = await readLibraryCatalog(
      { action: 'search', queries: ['Springfield'] },
      restricted,
      deps,
    );
    assert.ok('items' in result);
    assert.deepEqual(
      result.items?.map((item) => item.id),
      [String(ids.own)],
    );
    assert.deepEqual(
      await readLibraryCatalog({ action: 'details', id: String(ids.adult) }, restricted, deps),
      { error: 'That item is unavailable.' },
    );
  }
});
test('mine and library scopes do not bleed into each other', async () => {
  const mine = await readLibraryCatalog(
    { action: 'search', queries: ['Springfield'], scope: 'mine' },
    reader,
    deps,
  );
  const shared = await readLibraryCatalog(
    { action: 'search', queries: ['Springfield'], scope: 'library' },
    reader,
    deps,
  );
  assert.ok('items' in mine && 'items' in shared);
  assert.deepEqual(
    mine.items?.map((item) => item.id),
    [String(ids.own)],
  );
  assert.deepEqual(
    shared.items?.map((item) => item.id),
    [String(ids.adult)],
  );
});
test('stable pages expose more and exhaust without duplicate results', async () => {
  const found: string[] = [];
  for (let page = 0; page < 3; page++) {
    const result = await readLibraryCatalog(
      { action: 'search', queries: ['Serial radio'], page },
      reader,
      deps,
    );
    assert.ok('items' in result);
    found.push(...(result.items || []).map((item) => item.id));
    assert.equal(result.more, page < 2);
    assert.equal(result.nextPage, page < 2 ? page + 1 : null);
  }
  assert.equal(found.length, 26);
  assert.equal(new Set(found).size, 26);
});
test('details omit storage keys, raw account IDs and internal review metadata', async () => {
  const result = await readLibraryCatalog(
    { action: 'details', id: String(ids.shared) },
    reader,
    deps,
  );
  const serialized = JSON.stringify(result);
  assert.ok('parts' in result && result.parts?.length === 1);
  assert.doesNotMatch(serialized, /private-storage-key|do not reveal me/);
  assert.ok(!serialized.includes(String(other)));
});
test('passages preserve text, carry position, and cannot treat recordings as books', async () => {
  const result = await readLibraryCatalog(
    { action: 'passage', id: String(ids.book) },
    reader,
    deps,
  );
  assert.ok('text' in result);
  assert.match(result.text || '', /lighthouse/);
  assert.deepEqual(result.next, { section: 0, chunk: 1 });
  const recording = await readLibraryCatalog(
    { action: 'passage', id: String(ids.shared) },
    reader,
    deps,
  );
  assert.ok('error' in recording);
});
test('untrusted regular expression syntax is searched literally and inputs are bounded', async () => {
  const result = await readLibraryCatalog({ action: 'search', queries: ['.*'] }, reader, deps);
  assert.ok('items' in result && result.items?.length === 0);
  assert.throws(() =>
    catalogSearchPipeline({ action: 'search', queries: ['x'.repeat(121)] }, reader),
  );
  assert.throws(() =>
    catalogSearchPipeline({ action: 'search', queries: ['x'] }, { ...reader, id: '' }),
  );
  await assert.rejects(() =>
    readLibraryCatalog({ action: 'delete', id: String(ids.shared) }, reader, deps),
  );
});
