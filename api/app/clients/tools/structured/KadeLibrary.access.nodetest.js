/* kade_library for an account without family library access (Sep 24 2026).
 * Run: node --test api/app/clients/tools/structured/KadeLibrary.access.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadTool({ user, result }) {
  const seen = {};
  const stubs = {
    '@librechat/agents/langchain/tools': { Tool: class {} },
    '@librechat/api': {
      readLibraryCatalog: async (input, reader) => {
        seen.reader = reader;
        return JSON.parse(JSON.stringify(result));
      },
      catalogProjection: {},
      libraryToolDescription: '',
      libraryToolSchema: {},
      // The real rule lives in packages/api library/access.ts (tested there).
      familyLibraryMember: (u) => u.role === 'ADMIN' || u.kadeLibraryAccess === 'family',
      familyLibraryAccessNote: 'NOTE: family members Kade has approved.',
      familyLibraryEmptyGuidance: 'EMPTY: needs Kade.',
      libraryReviewSeat: (u) => String(u.id) === 'review',
      ownUploadsOnlyNote: 'OWN: only its own uploads.',
    },
    '~/models/kadeBook': { KadeBook: {}, KadeBookText: {} },
    '~/models': {
      getUserById: async (id) => {
        seen.lookedUp = id;
        return user;
      },
    },
    '@librechat/data-schemas': { logger: { info() {}, warn() {} } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./KadeLibrary'), 'utf8'), {
    module,
    require: (name) => stubs[name],
    JSON,
    String,
    Array,
  });
  return { Tool: module.exports, seen };
}

test('a restricted reader is told, in words to relay, that the family collection needs Kade', async () => {
  const { Tool, seen } = loadTool({
    user: { _id: 'u1', email: 'new@example.com', kadeAccountType: 'adult' },
    result: { items: [], guidance: 'Try shorter words.' },
  });
  const out = JSON.parse(await new Tool({ req: { user: { id: 'u1' } } })._call({ action: 'search', queries: ['making out'] }));
  assert.equal(seen.reader.hidden, true);
  assert.equal(out.familyLibrary, 'NOTE: family members Kade has approved.');
  assert.equal(out.guidance, 'EMPTY: needs Kade.');
  assert.deepEqual(out.items, []);
});

test('a family member gets the catalog result exactly as before', async () => {
  const result = { items: [{ id: 'a', title: 'Making Out: Zoey fools around' }], guidance: 'These are candidates.' };
  const { Tool, seen } = loadTool({ user: { _id: 'u2', kadeLibraryAccess: 'family', kadeAccountType: 'adult' }, result });
  const out = JSON.parse(await new Tool({ req: { user: { id: 'u2' } } })._call({ action: 'search', queries: ['making out'] }));
  assert.deepEqual(out, result);
  assert.equal(seen.reader.hidden, false);
  assert.equal(seen.reader.child, false);
});

test("the owner's untyped admin seat is not treated as a child; unknown types still are", async () => {
  let loaded = loadTool({ user: { _id: 'k', role: 'ADMIN' }, result: { items: [] } });
  await new loaded.Tool({ req: { user: { id: 'k' } } })._call({ action: 'search', queries: ['x'] });
  assert.equal(loaded.seen.reader.child, false);
  assert.equal(loaded.seen.reader.hidden, false);
  loaded = loadTool({ user: { _id: 'g', kadeLibraryAccess: 'family' }, result: { items: [] } });
  await new loaded.Tool({ req: { user: { id: 'g' } } })._call({ action: 'search', queries: ['x'] });
  assert.equal(loaded.seen.reader.child, true);
});

test('on the voice lane the person on the line is the reader, not the service seat', async () => {
  const { Tool, seen } = loadTool({ user: { _id: 'amber', kadeLibraryAccess: 'family', kadeAccountType: 'adult' }, result: { items: [] } });
  await new Tool({ req: { user: { id: 'kade-service', role: 'ADMIN' }, kadeOnBehalfOf: { id: 'amber' } } })._call({ action: 'search', queries: ['x'] });
  assert.equal(seen.lookedUp, 'amber');
  assert.equal(seen.reader.id, 'amber');
});

test('the App Review seat hears only that its library holds its own uploads', async () => {
  const result = { items: [], guidance: 'Try shorter words.' };
  const { Tool, seen } = loadTool({ user: { _id: 'review', email: 'kadeai.vischeck722@gmail.com' }, result });
  const out = JSON.parse(await new Tool({ req: { user: { id: 'review' } } })._call({ action: 'search', queries: ['making out'] }));
  assert.equal(seen.reader.hidden, true);
  assert.equal(out.library, 'OWN: only its own uploads.');
  assert.equal(out.familyLibrary, undefined);
  assert.equal(out.guidance, 'Try shorter words.');
  assert.doesNotMatch(JSON.stringify(out), /Kade|family/);
});

test('a voice turn whose caller could not be identified searches nothing, not the service seat', async () => {
  const { Tool, seen } = loadTool({ user: { _id: 'kade-service', role: 'ADMIN' }, result: { items: [{ id: 'a' }] } });
  const req = { user: { id: 'kade-service', role: 'ADMIN' }, body: { kadeOnBehalfOf: 'unknown@example.com' }, kadeOnBehalfOfUnresolved: true };
  const out = JSON.parse(await new Tool({ req })._call({ action: 'search', queries: ['x'] }));
  assert.match(out.error, /could not tell whose account/);
  assert.match(out.error, /Do not say the library lacks the item/);
  assert.equal(seen.lookedUp, undefined);
  assert.equal(seen.reader, undefined);
});
