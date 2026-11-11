/* Nov 11 2026 (card 10): ISOLATION BETWEEN PEOPLE, on a real (in-memory) MongoDB.
 *
 * The plan's section 4 test, number 6 of the consent research's fourteen: plant a marker fact in
 * account A, then look for it everywhere account B can be shown something: B's memory cards (what
 * the keeper and every character turn read), B's relationship summary and its thread (what the
 * same-day and nightly passes keep, and what reach-out reads), B's logbook, B's mood and moments,
 * B's card-check marks, and B's "what do you know about me" card. It must never appear. Then the
 * whole database is scanned: every row that holds the marker must belong to A.
 *
 * Needs mongoose, mongodb-memory-server, module-alias and a built @librechat/data-schemas and
 * @librechat/api. On kadepc: NODE_PATH=F:/KadeAI-work/forkship-20261110/buildcopy/node_modules,
 * TMP on F: (the mongod scratch folders are large). Without them the suite is skipped, never passed.
 * No model, no network. Every person and fact here is made up. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const API = path.resolve(__dirname, '../..');
const ROOT = path.resolve(API, '..');

let deps = null;
try {
  deps = {
    mongoose: require('mongoose'),
    MongoMemoryServer: require('mongodb-memory-server').MongoMemoryServer,
    schemas: require('@librechat/data-schemas'),
  };
  require('module-alias').addAlias('~', API);
} catch (e) {
  deps = null;
}

const A = '64a0000000000000000000a1';
const B = '64b0000000000000000000b2';
const AGENT = 'agent_synthetic_harley';
const MARKER = 'ZEBRA7731';
const FACT = `The spare key is under the blue flowerpot by the shed, code word ${MARKER}.`;

test('a marker fact in account A never reaches account B', { skip: deps ? false : 'mongoose / mongodb-memory-server / data-schemas not installed here' }, async (t) => {
  const { mongoose, MongoMemoryServer, schemas } = deps;
  const name = `iso_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const mongo = await MongoMemoryServer.create({ instance: { dbName: name, ip: '127.0.0.1' } });
  await mongoose.connect(mongo.getUri(name));
  t.after(async () => {
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
    await mongo.stop();
    /* A module loaded here (the models' cache) keeps one timer running. This unref'd timer never holds
     * the process open itself; if that timer does, the file ends 2 s after its tests, keeping their
     * exit code (process.exit with no argument uses process.exitCode). */
    setTimeout(() => process.exit(), 2000).unref();
  });
  schemas.createModels(mongoose);
  const methods = schemas.createMethods(mongoose, {});
  const db = mongoose.connection;
  await mongoose.models.User.create([
    { _id: new mongoose.Types.ObjectId(A), email: 'a@example.invalid', username: 'synthetic_a', provider: 'local', personalization: { memories: true } },
    { _id: new mongoose.Types.ObjectId(B), email: 'b@example.invalid', username: 'synthetic_b', provider: 'local', personalization: { memories: true } },
  ]);

  /* ── A's life, through the real writers where they run without a model ── */
  await methods.setMemory({ userId: A, agentId: null, key: 'spare_key', value: FACT, tokenCount: 20 });
  await methods.setMemory({ userId: A, agentId: AGENT, key: 'spare_key_harley', value: `Harley knows ${FACT}`, tokenCount: 20 });
  await methods.setMemory({ userId: B, agentId: null, key: 'garden', value: 'B is planning raised garden beds.', tokenCount: 8 });
  const summaries = require('~/models/kadeMemorySummary');
  await summaries.setMemorySummary(A, AGENT, { summary: `They talked about the shed. ${FACT}`, thread: `Ask about the shed key ${MARKER}.`, source: 'nightly' });
  await summaries.setMemorySummary(B, AGENT, { summary: 'They talked about garden beds.', source: 'nightly' });
  const now = new Date();
  await db.collection('kadediaryentries').insertOne({ userId: A, agentId: AGENT, text: `Talked about the shed. ${FACT}`, entryDate: now.toISOString().slice(0, 10), source: 'keeper', createdAt: now, updatedAt: now });
  await db.collection('kadediaryentries').insertOne({ userId: A, agentId: null, text: `Shared note: ${FACT}`, entryDate: now.toISOString().slice(0, 10), source: 'keeper', createdAt: now, updatedAt: now });
  await db.collection('kademoments').insertOne({ userId: A, agentId: AGENT, quote: `the key, ${MARKER}`, speaker: 'them', kind: 'line', why: 'a private joke', createdAt: now, uses: 0 });
  await db.collection('kadesoulstates').insertOne({ userId: A, agentId: AGENT, mood: 'warm', moodWhy: `the ${MARKER} key story`, updatedAt: now });
  await db.collection('kadecardchecks').insertOne({ userId: A, agentId: null, key: 'spare_key', status: 'checked', quote: FACT, checkedAt: now, valueHash: 'x' });
  await db.collection('kadepeople').insertOne({ ownerId: A, agentId: AGENT, name: 'Synthetic Neighbor', note: `knows about ${MARKER}`, provenance: 'conversation' });

  const has = (v) => JSON.stringify(v === undefined ? null : v).includes(MARKER);

  /* ── 1. memory cards: what every character turn and the keeper read for B ── */
  const fa = await methods.getFormattedMemories({ userId: A, agentId: AGENT });
  assert.ok(has(fa), 'control: A sees the marker');
  const fb = await methods.getFormattedMemories({ userId: B, agentId: AGENT });
  assert.ok(!has(fb), 'B\'s cards never carry A\'s fact');
  assert.ok(!has(await methods.getAllUserMemories(B)), 'B\'s memory page never shows it');
  assert.ok(has(fb.withoutKeys) === false && /garden/.test(fb.withoutKeys));

  /* ── 2. the relationship summary and its thread (same-day, nightly, reach-out read these) ── */
  const sa = await summaries.getMemorySummary(A, AGENT);
  assert.ok(has(sa), 'control');
  const sb = await summaries.getMemorySummary(B, AGENT);
  assert.ok(!has(sb));

  /* ── 3. the logbook, flipped through by date and by character ── */
  const diary = require('~/models/kadeDiary');
  const da = await diary.searchDiary({ userId: A, agentId: AGENT, limit: 10 });
  assert.ok(has(da), 'control');
  const dbB = await diary.searchDiary({ userId: B, agentId: AGENT, limit: 10 });
  assert.ok(!has(dbB));

  /* ── 4. mood and moments ── */
  const soul = require('~/server/services/kadeSoul');
  const req = (id) => ({ user: { id, role: 'USER' }, body: { conversationId: 'conv-b', text: 'hi' } });
  const tb = await soul.getSoulTailBlock({ userId: B, agentId: AGENT, req: req(B), conversationId: null, userText: 'tell me about the key' });
  assert.ok(!has(tb), 'B\'s soul block never carries A\'s moment or mood reason');
  if (typeof soul.listMoments === 'function') assert.ok(!has(await soul.listMoments({ userId: B, agentId: AGENT })));

  /* ── 5. card-check marks ── */
  const checks = require('./kadeCardCheck');
  const marks = await checks.getCardChecks(B, await methods.getAllUserMemories(B));
  assert.ok(!has([...marks.values()]));

  /* ── 6. "what do you know about me", with its real storage ── */
  const known = require('./kadeKnownCard');
  const ka = await known.read({ req: req(A), agentId: AGENT, group: 'all' });
  assert.ok(has(ka), 'control: A hears it');
  const kb = await known.read({ req: req(B), agentId: AGENT, group: 'all' });
  assert.equal(kb.ok, true);
  assert.ok(!has(kb));
  /* B forgetting everything never touches A */
  await known.forgetAll({ req: { ...req(B), body: { conversationId: 'conv-b', text: 'forget everything' } }, agentId: AGENT });
  await known.forgetAll({ req: { ...req(B), body: { conversationId: 'conv-b', text: 'yes' } }, agentId: AGENT });
  assert.ok(has(await methods.getAllUserMemories(A)), 'A\'s cards are still there');
  assert.equal((await methods.getAllUserMemories(B)).length, 0, 'B\'s are gone');

  /* ── 7. the whole database: every row holding the marker belongs to A ── */
  const owners = new Set([A]);
  const leaks = [];
  for (const { name: coll } of await db.db.listCollections().toArray()) {
    if (coll.startsWith('system.')) continue;
    for (const row of await db.collection(coll).find({}).toArray()) {
      if (!has(row)) continue;
      const owner = String(row.userId ?? row.user ?? row.ownerId ?? '');
      if (!owners.has(owner)) leaks.push(`${coll}:${owner || 'no owner'}`);
    }
  }
  assert.deepEqual(leaks, [], 'no row outside A\'s own holds the marker (per-character shared rows hold nothing about a person)');

  /* ── 8. card 8 on real storage: A forgets the shared fact; what carried it goes, and it does not come back ── */
  const shared = (await known.read({ req: req(A), agentId: AGENT, group: 'all' })).items.find((i) => i.fact === FACT);
  assert.ok(shared, 'A hears the shared card');
  /* Review fix: forget reads the fact back and asks first; the yes comes in the next message. */
  const asked = await known.forget({ req: req(A), agentId: AGENT, ref: shared.ref });
  assert.equal(asked.needsYes, true, JSON.stringify(asked));
  const yes = req(A);
  yes.body.text = 'yes, forget it';
  const gone = await known.forget({ req: yes, agentId: AGENT, ref: shared.ref });
  assert.equal(gone.ok, true, JSON.stringify(gone));
  assert.equal(gone.forgotten, FACT);
  const left = await methods.getAllUserMemories(A);
  assert.ok(!left.some((c) => c.key === 'spare_key'), 'the card is deleted');
  const tombRows = await db.collection('kadeknowntombstones').find({ userId: A }).toArray();
  assert.equal(tombRows.length, 1);
  assert.ok(!has(tombRows) && !JSON.stringify(tombRows).includes('flowerpot'), 'the tombstone keeps no words');
  const lines = await db.collection('kadediaryentries').find({ userId: A }).toArray();
  assert.equal(lines.length, 1, 'the line that was only the fact is gone');
  assert.equal(lines[0].text, 'Talked about the shed.', 'the other line keeps what was not the fact');
  assert.equal(lines[0].embedding, null);
  assert.equal(await db.collection('kademoments').countDocuments({ userId: A }), 0, 'the moment quoting it is gone');
  /* the night's pass writes the summary again from the old chat: the fact is dropped at the save */
  await summaries.setMemorySummary(A, AGENT, { summary: `They talked about the shed. ${FACT} Then the garden.`, source: 'nightly' });
  const again = await summaries.getMemorySummary(A, AGENT);
  assert.ok(!has(again.summary) && /the shed\. Then the garden\./.test(again.summary), again.summary);
  /* a moment carrying it again is refused */
  const kept = await soul.keepMoment({ userId: A, agentId: AGENT, quote: FACT.slice(0, 120), speaker: 'them', kind: 'line', why: 'x', evidence: FACT });
  assert.equal(kept.ok, false);
  /* B's identical words are B's own, never blocked by A's tombstone */
  await summaries.setMemorySummary(B, AGENT, { summary: `B said: ${FACT}`, source: 'nightly' });
  assert.ok(has((await summaries.getMemorySummary(B, AGENT)).summary));
});

test('reach-out and character days read only the recipient\'s own rows (source check)', () => {
  const reach = fs.readFileSync(path.join(API, 'server/services/kadeReachOut.js'), 'utf8');
  /* reach-out builds a first text from the recipient's own cards and summary thread only */
  assert.match(reach, /async cards\(userId, agentId\) \{\s*const \{ getAllUserMemories \} = require\('~\/models'\);\s*const \[shared, own\] = await Promise\.all\(\[getAllUserMemories\(userId, \{ agentId: null \}\), getAllUserMemories\(userId, \{ agentId \}\)\]\);/);
  assert.match(reach, /async thread\(userId, agentId\) \{\s*const row = await require\('~\/models\/kadeMemorySummary'\)\.getMemorySummary\(userId, agentId\);/);
  /* the character-days writer reads no person's memory, chat text, summary or moments at all */
  const days = fs.readFileSync(path.join(API, 'server/services/kadeCharacterDays.js'), 'utf8');
  for (const coll of ['memoryentries', 'kadememorysummaries', 'kademoments', 'kadediaryentries', "collection('messages')", 'getAllUserMemories', 'getMessages', 'kadesoulstates']) {
    assert.ok(!days.includes(coll), `character days touch ${coll}`);
  }
});

test.todo('lists: one account never hears another\'s list (the lists service is card 7, built in the everyday lane, not in this branch)');
