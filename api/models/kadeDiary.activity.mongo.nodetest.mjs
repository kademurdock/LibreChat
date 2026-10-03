import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const require = createRequire(import.meta.url);
const { diaryDiagnostic } = require('@librechat/api');
const { KadeDiaryEntry, logDiaryEntry } = require('./kadeDiary.js');
const now = new Date('2026-10-03T12:00:00.000Z');

function fixtureEnvironment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (environment) => {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  t.after(() => apply(previous));
}

const hour = 60 * 60 * 1000;
const userId = '000000000000000000000001';
const databaseName = `diary_diagnostic_${randomUUID().replaceAll('-', '')}`;
let server;

before(async () => {
  server = await MongoMemoryServer.create({
    binary: { version: '8.2.1' },
    instance: { dbName: databaseName, ip: '127.0.0.1' },
  });
  await mongoose.connect(server.getUri(databaseName), { serverSelectionTimeoutMS: 5000 });
  await KadeDiaryEntry.init();
});

beforeEach(async (t) => {
  assert.equal(mongoose.connection.name, databaseName);
  await KadeDiaryEntry.deleteMany({});
  await mongoose.connection.collection('kadememorypolicies').deleteMany({});
  fixtureEnvironment(t, {
    KADE_DIARY: '1',
    KADE_DIARY_DEDUP: '1',
    KADE_DIARY_EPISODE: '1',
    KADE_EMBED_GEMINI_KEY: undefined,
    KADE_EMBED_OPENAI_KEY: undefined,
  });
});

after(async () => {
  try {
    if (mongoose.connection.readyState === 1) {
      assert.equal(mongoose.connection.name, databaseName);
      assert.match(databaseName, /^diary_diagnostic_[a-f0-9]+$/);
      await mongoose.connection.dropDatabase();
    }
  } finally {
    await mongoose.disconnect();
    await server?.stop();
  }
});

const readActivity = () => diaryDiagnostic(KadeDiaryEntry.collection, now);
const write = (options = {}) =>
  logDiaryEntry({
    userId,
    text: 'A synthetic fixture episode.',
    conversationId: 'fixture-episode',
    origin: 'live_chat',
    ...options,
  });

test('real create and repeated same-entry amendments persist nested dates and count entries once', async (t) => {
  const created = new Date(now.getTime() - 3 * hour);
  t.mock.timers.enable({ apis: ['Date'], now: created });
  assert.equal((await write()).ok, true);
  const initial = await KadeDiaryEntry.findOne({ userId }).lean();
  assert.equal(initial.writeActivity.live_chat.createdAt.getTime(), created.getTime());
  assert.equal(initial.writeActivity.live_chat.amendedAt, undefined);
  t.mock.timers.setTime(now.getTime() - 2 * hour);
  assert.equal(
    (await write({ text: 'A second development in the fixture episode.' })).amended,
    true,
  );
  t.mock.timers.setTime(now.getTime() - hour);
  assert.equal(
    (await write({ text: 'The final development in the fixture episode.' })).amended,
    true,
  );
  const stored = await KadeDiaryEntry.findOne({ userId }).lean();
  assert.equal(String(stored._id), String(initial._id));
  assert.equal(await KadeDiaryEntry.countDocuments(), 1);
  assert.equal(stored.priorTexts.length, 2);
  assert.equal(stored.priorTexts[0], initial.text);
  assert.equal(stored.writeActivity.live_chat.createdAt.getTime(), created.getTime());
  assert.equal(stored.writeActivity.live_chat.amendedAt.getTime(), now.getTime() - hour);
  assert.deepEqual((await readActivity()).byOrigin.live_chat, {
    entries: 1,
    createdEntries24h: 1,
    amendedEntries24h: 1,
    lastCreatedAt: created.toISOString(),
    lastAmendedAt: new Date(now.getTime() - hour).toISOString(),
    lastWriteAt: new Date(now.getTime() - hour).toISOString(),
  });
});

test('temporary traffic stays separate from live chat, explicit canaries, and briefs', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const [index, origin] of [
    'temporary_unknown',
    'temporary_unknown',
    'canary',
    'brief',
  ].entries()) {
    assert.equal(
      (
        await write({
          origin,
          conversationId: `fixture-${index}`,
          text: `Fixture event number ${index}.`,
        })
      ).ok,
      true,
    );
  }
  const result = await readActivity();
  assert.equal(result.byOrigin.temporary_unknown.entries, 2);
  assert.equal(result.byOrigin.temporary_unknown.createdEntries24h, 2);
  assert.equal(result.byOrigin.canary.entries, 1);
  assert.equal(result.byOrigin.brief.entries, 1);
  assert.equal(result.byOrigin.live_chat.entries, 0);
  assert.equal(result.byOrigin.live_chat.lastWriteAt, null);
});

test('manual, historical imports, and consolidation writes cannot advance live-chat evidence', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const source of ['manual', 'mined', 'backfill', 'gpt-import']) {
    assert.equal(
      (
        await write({
          source,
          conversationId: `fixture-${source}`,
          text: `Fixture from ${source}.`,
        })
      ).ok,
      true,
    );
  }
  assert.equal(
    (
      await write({
        conversationId: 'consolidation-fixture',
        text: 'A fixture seasonal milestone.',
      })
    ).ok,
    true,
  );
  const result = await readActivity();
  assert.equal(result.byOrigin.manual.entries, 1);
  assert.equal(result.byOrigin.backfill.entries, 3);
  assert.equal(result.byOrigin.consolidation.entries, 1);
  assert.equal(result.byOrigin.live_chat.entries, 0);
});

test('embedding and voice maintenance change document updatedAt without advancing writer evidence', async (t) => {
  const created = new Date(now.getTime() - 4 * hour);
  t.mock.timers.enable({ apis: ['Date'], now: created });
  assert.equal((await write()).ok, true);
  const initial = await KadeDiaryEntry.findOne({ userId }).lean();
  t.mock.timers.setTime(now.getTime() - hour);
  await KadeDiaryEntry.updateOne(
    { _id: initial._id },
    {
      $set: {
        embedding: [0.1, 0.2],
        voiceRepairedAt: new Date(),
        text: 'A repaired fixture episode.',
      },
    },
  );
  const stored = await KadeDiaryEntry.findById(initial._id).lean();
  assert.deepEqual(stored.writeActivity, initial.writeActivity);
  assert.equal(stored.updatedAt.getTime(), now.getTime() - hour);
  const result = await readActivity();
  assert.equal(result.byOrigin.live_chat.lastWriteAt, created.toISOString());
  assert.equal(result.byOrigin.live_chat.amendedEntries24h, 0);
  assert.equal(result.sourceHistory.keeper.newestDocumentUpdatedAt, stored.updatedAt.toISOString());
});

test('duplicates, empty writes, disabled writes, and excluded conversations do not stamp activity', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() - hour });
  assert.equal((await write()).ok, true);
  const initial = await KadeDiaryEntry.findOne({ userId }).lean();
  t.mock.timers.setTime(now.getTime());
  assert.equal((await write()).duplicate, true);
  assert.equal((await write({ text: '   ' })).ok, false);
  assert.equal(
    (await write({ text: 'Checked the diary for memory housekeeping; nothing needed changing.' }))
      .ok,
    false,
  );
  process.env.KADE_DIARY = '0';
  assert.equal((await write({ text: 'A disabled fixture entry.' })).ok, false);
  process.env.KADE_DIARY = '1';
  await mongoose.connection.collection('kadememorypolicies').insertOne({
    userId,
    conversationId: 'fixture-episode',
    excluded: true,
  });
  assert.equal((await write({ text: 'An excluded fixture entry.' })).ok, false);
  const stored = await KadeDiaryEntry.findById(initial._id).lean();
  assert.deepEqual(stored, initial);
  assert.equal(await KadeDiaryEntry.countDocuments(), 1);
  assert.equal((await readActivity()).byOrigin.live_chat.amendedEntries24h, 0);
});

test('an amendment at the text limit remains a no-op with no new stamp or sibling entry', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() - hour });
  assert.equal((await write({ text: 'x'.repeat(2000) })).ok, true);
  const initial = await KadeDiaryEntry.findOne({ userId }).lean();
  t.mock.timers.setTime(now.getTime());
  assert.equal((await write({ text: 'Another fixture development.' })).duplicate, true);
  assert.deepEqual(await KadeDiaryEntry.findById(initial._id).lean(), initial);
  assert.equal(await KadeDiaryEntry.countDocuments(), 1);
  assert.equal((await readActivity()).byOrigin.live_chat.amendedEntries24h, 0);
});

test('real server-rejected amend and fallback create leave persisted activity unchanged', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() - hour });
  assert.equal((await write()).ok, true);
  const initial = await KadeDiaryEntry.findOne({ userId }).lean();
  await mongoose.connection.db.command({
    collMod: KadeDiaryEntry.collection.name,
    validator: { syntheticPermit: { $exists: true } },
    validationLevel: 'strict',
    validationAction: 'error',
  });
  try {
    t.mock.timers.setTime(now.getTime());
    const result = await write({ text: 'A server-rejected fixture update.' });
    assert.equal(result.ok, false);
    assert.match(result.error, /validation/i);
    assert.deepEqual(await KadeDiaryEntry.findById(initial._id).lean(), initial);
    assert.equal(await KadeDiaryEntry.countDocuments(), 1);
    assert.equal((await readActivity()).byOrigin.live_chat.amendedEntries24h, 0);
  } finally {
    await mongoose.connection.db.command({
      collMod: KadeDiaryEntry.collection.name,
      validator: {},
    });
  }
});

test('real aggregation handles date boundaries, legacy rows, all source history, and metadata privacy', async () => {
  const since = new Date(now.getTime() - 24 * hour);
  const older = new Date(since.getTime() - 1);
  const amended = new Date(now.getTime() - hour);
  const latest = new Date(now.getTime() - hour / 2);
  const future = new Date(now.getTime() + hour);
  const privateText = 'PRIVATE_SYNTHETIC_DIARY_TEXT';
  const privateUser = 'PRIVATE_SYNTHETIC_USER_ID';
  const privateConversation = 'PRIVATE_SYNTHETIC_CONVERSATION_ID';
  const fixtures = [
    {
      source: 'keeper',
      createdAt: since,
      updatedAt: amended,
      writeActivity: { live_chat: { createdAt: since, amendedAt: amended } },
    },
    {
      source: 'keeper',
      createdAt: older,
      updatedAt: older,
      writeActivity: { live_chat: { createdAt: older, amendedAt: future } },
    },
    {
      source: 'keeper',
      createdAt: older,
      updatedAt: latest,
      writeActivity: { live_chat: { createdAt: '2026-10-03', amendedAt: latest } },
    },
    { source: null, createdAt: older, updatedAt: amended },
    { createdAt: future, updatedAt: '2026-10-03' },
    {
      source: 'unrecognized-source',
      createdAt: older,
      updatedAt: future,
      writeActivity: { live_chat: { createdAt: future } },
    },
    {
      source: 'backfill',
      createdAt: older,
      updatedAt: older,
      writeActivity: { unrecognized_origin: { createdAt: latest } },
    },
    {
      source: 'manual',
      createdAt: older,
      updatedAt: older,
      writeActivity: { live_chat: { createdAt: null, amendedAt: null } },
    },
  ].map((fixture) => ({
    ...fixture,
    text: privateText,
    userId: privateUser,
    conversationId: privateConversation,
    sourceConversationIds: [privateConversation],
    priorTexts: [privateText],
    embedding: [1, 2, 3],
  }));
  const inserted = await KadeDiaryEntry.collection.insertMany(fixtures);
  const result = await readActivity();
  assert.deepEqual(result.byOrigin.live_chat, {
    entries: 3,
    createdEntries24h: 1,
    amendedEntries24h: 2,
    lastCreatedAt: since.toISOString(),
    lastAmendedAt: latest.toISOString(),
    lastWriteAt: latest.toISOString(),
  });
  assert.equal(result.legacy.entries, 5);
  assert.equal(result.legacy.newestCreatedAt, older.toISOString());
  assert.equal(result.legacy.newestDocumentUpdatedAt, amended.toISOString());
  assert.deepEqual(result.sourceHistory.keeper, {
    entries: 5,
    newestCreatedAt: since.toISOString(),
    newestDocumentUpdatedAt: latest.toISOString(),
  });
  assert.equal(result.sourceHistory.other.entries, 1);
  assert.equal(result.sourceHistory.backfill.entries, 1);
  assert.equal(result.sourceHistory.manual.entries, 1);
  assert.equal(
    Object.values(result.sourceHistory).reduce((total, row) => total + row.entries, 0),
    8,
  );
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(
    serialized,
    /PRIVATE_SYNTHETIC|"text"|"_id"|userId|conversationId|embedding|priorTexts/,
  );
  for (const id of Object.values(inserted.insertedIds)) {
    assert.equal(serialized.includes(String(id)), false);
  }
});
