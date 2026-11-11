/* Nov 11 2026 (card 8): "do not relearn" markers. Plain node:test, no model, no network, no database:
 *   node --test api/server/services/kadeKnownTombstones.test.js
 * The collection is an in-memory stand-in. Every person and fact here is made up. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const T = require('./kadeKnownTombstones');

/** A tiny stand-in for the one collection, answering only the shapes the module uses. */
function fakeColl(rows = []) {
  let n = 0;
  const c = {
    rows,
    find(filter) {
      const now = new Date();
      const hit = rows.filter((r) => r.userId === filter.userId && (!r.expiresAt || r.expiresAt > now));
      return { limit: () => ({ toArray: async () => hit.map((r) => ({ ...r })) }), toArray: async () => hit };
    },
    insertOne: async (doc) => {
      const row = { _id: `t${++n}`, ...doc };
      rows.push(row);
      return { insertedId: row._id };
    },
    deleteMany: async (filter) => {
      const before = rows.length;
      const ids = filter._id && filter._id.$in;
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (r.userId !== filter.userId) continue;
        if (ids && !ids.includes(r._id)) continue;
        rows.splice(i, 1);
      }
      return { deletedCount: before - rows.length };
    },
  };
  return c;
}

async function withColl(coll, fn) {
  const before = T.__seam.coll;
  T.__seam.coll = coll;
  try {
    return await fn();
  } finally {
    T.__seam.coll = before;
  }
}

const FACT = 'Her clinic visit is Thursday the 19th at the eye doctor.';

test('content words: lower case, no small words, numbers kept whole, each once', () => {
  assert.deepEqual(T.words(FACT), ['clinic', 'visit', 'thursday', '19th', 'eye', 'doctor']);
  assert.deepEqual(T.words("Mom's pharmacy number is 417 555 0100"), ['moms', 'pharmacy', 'number', '417', '555', '0100']);
  assert.deepEqual(T.words(''), []);
});

test('a hash is tied to the person: the same word for two people never matches', () => {
  assert.notEqual(T.hashOf('userA', 'clinic'), T.hashOf('userB', 'clinic'));
  assert.equal(T.hashOf('userA', 'clinic'), T.hashOf('userA', 'clinic'));
  assert.equal(T.hashOf('userA', 'clinic').length, 16);
  const tomb = T.hashes('userA', FACT);
  assert.equal(T.covers(tomb, T.hashes('userA', FACT)), true);
  assert.equal(T.covers(tomb, T.hashes('userB', FACT)), false, 'B saying the same words is not A\'s forgotten fact');
});

test('the match: most of the forgotten words again is the fact again; a passing mention is not', () => {
  const tomb = T.hashes('u1', FACT);
  assert.equal(T.covers(tomb, T.hashes('u1', 'She has the eye doctor clinic visit on Thursday the 19th.')), true);
  assert.equal(T.covers(tomb, T.hashes('u1', 'Clinic visit Thursday 19th, eye doctor, bring glasses.')), true);
  assert.equal(T.covers(tomb, T.hashes('u1', 'She went to the eye doctor last spring.')), false);
  assert.equal(T.covers(tomb, T.hashes('u1', 'Her clinic visit moved to Friday the 20th.')), false, 'a new fact is not blocked');
  /* review fix: a reworded fact is still the forgotten one */
  const sister = T.hashes('u1', 'Her sister lives in Branson.');
  assert.equal(T.covers(sister, T.hashes('u1', 'Has a sister nearby in Branson, Missouri.')), true);
  assert.equal(T.covers(sister, T.hashes('u1', 'Her sister likes cats.')), false);
  /* a two-word fact needs both words; a one-word fact blocks nothing */
  assert.equal(T.covers(T.hashes('u1', 'Kasper cat'), T.hashes('u1', 'my cat Kasper')), true);
  assert.equal(T.covers(T.hashes('u1', 'Kasper cat'), T.hashes('u1', 'my cat')), false);
  assert.equal(T.covers(T.hashes('u1', 'Kasper'), T.hashes('u1', 'Kasper')), false);
});

test('scrub drops only the sentences that carry the forgotten fact', () => {
  const tombs = [{ hashes: T.hashes('u1', FACT) }];
  const text = 'We talked about the garden. Her clinic visit is Thursday the 19th at the eye doctor! She wants raised beds.\nAlso the cat.';
  const r = T.scrubWith('u1', text, tombs);
  assert.equal(r.removed, 1);
  assert.equal(r.text, 'We talked about the garden. She wants raised beds.\nAlso the cat.');
  assert.deepEqual(T.scrubWith('u1', 'Nothing here.', tombs), { text: 'Nothing here.', removed: 0 });
  assert.deepEqual(T.scrubWith('u2', text, tombs).removed, 0, 'tombstone hashes belong to u1 only');
  assert.equal(T.blockedWith('u1', 'A line. ' + FACT, tombs), true);
  assert.equal(T.blockedWith('u1', 'A line about tea.', tombs), false);
});

test('storage: add keeps no words, only hashes; blocks, scrub and lift read this person only', async () => {
  const coll = fakeColl();
  await withColl(coll, async () => {
    assert.equal(await T.add({ userId: 'u1', agentId: 'agent_x', text: FACT }), true);
    assert.equal(await T.add({ userId: 'u1', text: 'Kasper' }), false, 'a one-word fact gets no tombstone');
    assert.equal(coll.rows.length, 1);
    const row = coll.rows[0];
    assert.ok(!JSON.stringify(row).match(/clinic|thursday|doctor/i), 'the forgotten words are not stored');
    assert.equal(row.hashes.length, 6);
    assert.ok(row.expiresAt > row.createdAt);
    assert.equal(await T.blocks('u1', 'Clinic visit Thursday the 19th with the eye doctor.'), true);
    assert.equal(await T.blocks('u2', 'Clinic visit Thursday the 19th with the eye doctor.'), false);
    const s = await T.scrub('u1', 'Hi. Clinic visit Thursday the 19th with the eye doctor.');
    assert.deepEqual(s, { text: 'Hi.', removed: 1 });
    const f = await T.scrubFields('u1', { summary: 'Hi. ' + FACT, take: 'Fine.', relationship: { a: 1 } });
    assert.equal(f.fields.summary, 'Hi.');
    assert.equal(f.fields.take, 'Fine.');
    assert.deepEqual(f.fields.relationship, { a: 1 });
    /* told again on purpose: lifted */
    assert.equal(await T.lift({ userId: 'u2', text: FACT }), 0);
    assert.equal(await T.lift({ userId: 'u1', text: FACT }), 1);
    assert.equal(await T.blocks('u1', FACT), false);
  });
});

test('off switch and failures: KADE_KNOWN_TOMBSTONE=0 checks nothing; a broken store blocks the write (review fix: fails closed) and leaves text as it was', async () => {
  const coll = fakeColl();
  await withColl(coll, async () => {
    await T.add({ userId: 'u1', text: FACT });
    assert.equal(await T.blocks('u1', FACT, { KADE_KNOWN_TOMBSTONE: '0' }), false);
    assert.deepEqual(await T.scrub('u1', FACT, { KADE_KNOWN_TOMBSTONE: '0' }), { text: FACT, removed: 0 });
  });
  const broken = { find: () => { throw new Error('down'); } };
  await withColl(broken, async () => {
    assert.equal(await T.blocks('u1', FACT), true);
    assert.deepEqual(await T.scrub('u1', FACT), { text: FACT, removed: 0 });
  });
});

test('the TypeScript twin in data-schemas matches this file word for word and hash for hash', async () => {
  const file = path.resolve(__dirname, '../../../packages/data-schemas/src/memory/tombstoneMatch.ts');
  let ts;
  try {
    ts = await import(pathToFileURL(file).href);
  } catch (e) {
    /* Node without type stripping cannot load .ts; say so rather than pass silently */
    assert.fail('could not load tombstoneMatch.ts (needs Node 22.18+ type stripping): ' + e.message);
  }
  const samples = [
    FACT,
    "Mom's pharmacy number is 417 555 0100",
    'Sister Dana visits on Friday the 14th, driving up from Tulsa.',
    'The user’s dog Biscuit, 7 years old!!',
    '',
    'a an to of 12 3rd x',
  ];
  for (const s of samples) {
    assert.deepEqual(ts.tombstoneWords(s), T.words(s), s);
    assert.deepEqual(ts.tombstoneHashes('u1', s), T.hashes('u1', s), s);
  }
  for (const [a, b] of [
    [FACT, 'Clinic visit Thursday 19th, eye doctor.'],
    [FACT, 'Her clinic visit moved to Friday the 20th.'],
    ['Kasper cat', 'my cat Kasper'],
    ['Kasper', 'Kasper'],
  ]) {
    assert.equal(ts.tombstoneCovers(T.hashes('u1', a), T.hashes('u1', b)), T.covers(T.hashes('u1', a), T.hashes('u1', b)), `${a} / ${b}`);
  }
});

test('every writer named in the header really checks the tombstone', () => {
  const fs = require('node:fs');
  const root = path.resolve(__dirname, '../../..');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  assert.match(read('packages/data-schemas/src/methods/memory.ts'), /memoryTombstoned\(String\(userId\), value\)/);
  assert.equal((read('packages/data-schemas/src/methods/memory.ts').match(/memoryTombstoned\(/g) || []).length, 2, 'createMemory and setMemory');
  assert.match(read('api/models/kadeMemorySummary.js'), /kadeKnownTombstones'\)\.scrubFields\(userId/);
  assert.match(read('api/server/services/kadeSameDayMemory.js'), /scrub: \(userId, text\) => require\('\.\/kadeKnownTombstones'\)\.scrub/);
  assert.match(read('api/server/services/kadeCardCheck.js'), /blocks: \(userId, text\) => require\('\.\/kadeKnownTombstones'\)\.blocks/);
  assert.match(read('api/models/kadeDiary.js'), /kadeKnownTombstones'\)\.blocks\(userId, text\)/);
  assert.match(read('api/server/services/kadeSoul.js'), /kadeKnownTombstones'\)\.blocks\(userId/);
});
