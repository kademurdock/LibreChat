import vm from 'node:vm';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import ts from 'typescript';
import mongoose from 'mongoose';

const require = createRequire(import.meta.url);
const {
  diaryWriteOrigins,
  diaryChatOrigin,
  diaryWriteOrigin,
  diaryDiagnostic,
} = require('@librechat/api');
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

const emptyActivity = {
  entries: 0,
  createdEntries24h: 0,
  amendedEntries24h: 0,
  lastCreatedAt: null,
  lastAmendedAt: null,
  lastWriteAt: null,
};

test('temporary conversations and morning briefs do not imply live human chat', () => {
  assert.equal(diaryChatOrigin({}), 'live_chat');
  assert.equal(diaryChatOrigin({ isTemporary: false }), 'live_chat');
  assert.equal(diaryChatOrigin({ isTemporary: true }), 'temporary_unknown');
  assert.equal(diaryChatOrigin({ toolPolicy: 'morning-brief' }), 'brief');
  assert.equal(diaryChatOrigin({ isTemporary: true, toolPolicy: 'morning-brief' }), 'brief');
  assert.equal(diaryChatOrigin({ isTemporary: true, toolPolicy: 'probe' }), 'temporary_unknown');
});

test('write classification honors provenance and rejects unsupported origins', () => {
  for (const origin of diaryWriteOrigins) {
    assert.equal(diaryWriteOrigin({ source: 'keeper', origin }), origin);
  }
  assert.equal(diaryWriteOrigin({ source: 'manual', origin: 'live_chat' }), 'manual');
  for (const source of ['mined', 'backfill', 'gpt-import']) {
    assert.equal(diaryWriteOrigin({ source, origin: 'live_chat' }), 'backfill');
  }
  for (const conversationId of ['consolidation-episode', 'consolidate-episode']) {
    assert.equal(
      diaryWriteOrigin({ source: 'keeper', conversationId, origin: 'live_chat' }),
      'consolidation',
    );
  }
  assert.equal(diaryWriteOrigin({ source: 'keeper', origin: 'invented-origin' }), 'unknown');
  assert.equal(diaryWriteOrigin({ source: 'keeper', conversationId: 'canary-episode' }), 'unknown');
  assert.equal(diaryWriteOrigin({ source: 'unexpected', origin: 'live_chat' }), 'unknown');
  assert.equal(diaryWriteOrigin({}), 'unknown');
});

test('an empty collection reports no evidence, with all known origin and source buckets', async () => {
  const result = await diaryDiagnostic({ aggregate: () => ({ toArray: async () => [] }) }, now);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.evidence, 'persisted-successful-writes');
  assert.equal(result.generatedAt, now.toISOString());
  assert.deepEqual(Object.keys(result.byOrigin), [...diaryWriteOrigins]);
  for (const activity of Object.values(result.byOrigin)) {
    assert.deepEqual(activity, emptyActivity);
  }
  assert.deepEqual(Object.keys(result.sourceHistory), [
    'keeper',
    'manual',
    'mined',
    'backfill',
    'gpt-import',
    'other',
  ]);
  assert.deepEqual(result.legacy, {
    entries: 0,
    newestCreatedAt: null,
    newestDocumentUpdatedAt: null,
  });
  assert.match(result.countSemantics, /repeated amendments.*count once/i);
  assert.match(result.coverage, /temporary.*cannot be verified/i);
  assert.match(result.historicalUpdatedAtMeaning, /maintenance.*cannot establish/i);
});

test('metadata serialization excludes content and IDs, retaining successful-write dates', async () => {
  const privateSentinel = 'PRIVATE_FIXTURE_CONTENT_DO_NOT_RETURN';
  let calls = 0;
  const collection = {
    aggregate(pipeline, options) {
      calls++;
      assert.deepEqual(options, { maxTimeMS: 5000 });
      assert.deepEqual(Object.keys(pipeline[0].$project).sort(), [
        '_id',
        'createdAt',
        'origins',
        'source',
        'updatedAt',
      ]);
      assert.equal(pipeline[0].$project._id, 0);
      assert.doesNotMatch(JSON.stringify(pipeline), /\$(?:out|merge)|text|userId|conversationId/);
      return {
        toArray: async () => [
          {
            byOrigin: [
              {
                _id: 'live_chat',
                entries: 3,
                createdEntries24h: 1,
                amendedEntries24h: 2,
                lastCreatedAt: new Date('2026-10-03T08:00:00Z'),
                lastAmendedAt: new Date('2026-10-03T11:00:00Z'),
                text: privateSentinel,
                userId: privateSentinel,
              },
            ],
            legacy: [{ _id: null, entries: 4, newestCreatedAt: new Date('invalid') }],
            sourceHistory: [
              { _id: 'keeper', entries: 7, newestCreatedAt: new Date('2026-10-03T08:00:00Z') },
            ],
            text: privateSentinel,
          },
        ],
      };
    },
  };
  const result = await diaryDiagnostic(collection, now);
  assert.equal(calls, 1);
  assert.deepEqual(result.byOrigin.live_chat, {
    entries: 3,
    createdEntries24h: 1,
    amendedEntries24h: 2,
    lastCreatedAt: '2026-10-03T08:00:00.000Z',
    lastAmendedAt: '2026-10-03T11:00:00.000Z',
    lastWriteAt: '2026-10-03T11:00:00.000Z',
  });
  assert.equal(result.legacy.newestCreatedAt, null);
  assert.equal(result.sourceHistory.keeper.entries, 7);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FIXTURE|userId|conversationId|"_id"|"text"/);
});

test('database failures remain failures instead of becoming empty activity', async () => {
  const failure = new Error('synthetic database unavailable');
  await assert.rejects(
    diaryDiagnostic({ aggregate: () => ({ toArray: async () => Promise.reject(failure) }) }),
    (error) => error === failure,
  );
});

test('real Mongoose model preserves nested dates and actual rejected writes fail without storage', async (t) => {
  const previousBufferCommands = mongoose.get('bufferCommands');
  mongoose.set('bufferCommands', false);
  t.after(() => mongoose.set('bufferCommands', previousBufferCommands));
  fixtureEnvironment(t, {
    KADE_DIARY: '1',
    KADE_DIARY_DEDUP: '0',
    KADE_EMBED_GEMINI_KEY: undefined,
    KADE_EMBED_OPENAI_KEY: undefined,
  });
  const { KadeDiaryEntry, logDiaryEntry } = require('../../../../api/models/kadeDiary.js');
  const doc = new KadeDiaryEntry({
    userId: 'synthetic-user',
    text: 'A synthetic episode.',
    entryDate: '2026-10-03',
    writeActivity: { live_chat: { createdAt: now } },
  });
  doc.set('writeActivity.live_chat.amendedAt', new Date(now.getTime() + 1));
  await doc.validate();
  assert.equal(doc.writeActivity.live_chat.createdAt.getTime(), now.getTime());
  assert.equal(doc.writeActivity.live_chat.amendedAt.getTime(), now.getTime() + 1);
  assert.equal(KadeDiaryEntry.schema.path('writeActivity.live_chat.amendedAt').instance, 'Date');
  assert.deepEqual(await logDiaryEntry({ userId: 'synthetic-user', text: '  ' }), {
    ok: false,
    error: 'missing userId or text',
  });
  const failedWrite = await logDiaryEntry({
    userId: 'synthetic-user',
    text: 'A synthetic entry with no database connection.',
    origin: 'live_chat',
  });
  assert.equal(failedWrite.ok, false);
  assert.match(failedWrite.error, /before initial connection|bufferCommands/);
  process.env.KADE_DIARY = '0';
  assert.deepEqual(await logDiaryEntry({ userId: 'synthetic-user', text: 'Disabled entry.' }), {
    ok: false,
    error: 'diary disabled',
  });
});

function diagnosticRoute(diagnostic) {
  const source = readFileSync(
    new URL('../../../../api/server/routes/kade.js', import.meta.url),
    'utf8',
  );
  const ast = ts.createSourceFile(
    'kade.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declarations = ast.statements.filter(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some((declaration) =>
        ['requireAdminAccess', 'requireMemoryAdminRead'].includes(declaration.name.getText(ast)),
      ),
  );
  const registration = ast.statements.find(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      statement.expression.expression.getText(ast) === 'router.get' &&
      statement.expression.arguments[0]?.text === '/admin/diary-diagnostic',
  );
  assert.ok(registration, 'the admin diagnostic route must be registered');
  const jwt = () => {};
  const admin = () => {};
  const readUsers = () => {};
  const capabilities = { ACCESS_ADMIN: 'access:admin', READ_USERS: 'read:users' };
  const collection = { fixture: true };
  let registered;
  const context = {
    process: { env: {} },
    requireJwtAuth: jwt,
    requireCapability: (capability) => {
      assert.ok(Object.values(capabilities).includes(capability));
      return capability === capabilities.ACCESS_ADMIN ? admin : readUsers;
    },
    SystemCapabilities: capabilities,
    diaryDiagnostic: diagnostic,
    mongoose: {
      connection: {
        collection: (name) => {
          assert.equal(name, 'kadediaryentries');
          return collection;
        },
      },
    },
    router: { get: (...args) => (registered = args) },
  };
  vm.runInNewContext(
    [...declarations, registration].map((statement) => statement.getText(ast)).join('\n'),
    context,
  );
  assert.deepEqual(registered.slice(0, 4), ['/admin/diary-diagnostic', jwt, admin, readUsers]);
  assert.equal(registered.length, 5, 'the handler follows all three existing access checks');
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = JSON.parse(JSON.stringify(body));
      return this;
    },
  };
  return { handler: registered[4], response, env: context.process.env, collection };
}

test('admin diagnostic keeps JWT and both capabilities, and sends metadata with no-store', async () => {
  const payload = { schemaVersion: 1, evidence: 'persisted-successful-writes' };
  const route = diagnosticRoute(async (collection) => {
    assert.equal(collection, route.collection);
    return payload;
  });
  await route.handler({}, route.response);
  assert.equal(route.response.statusCode, 200);
  assert.deepEqual(route.response.body, payload);
  assert.equal(route.response.headers['Cache-Control'], 'no-store');
});

test('admin diagnostic reports a generic uncached 503 when storage fails', async () => {
  const route = diagnosticRoute(async () => {
    throw new Error('PRIVATE_DATABASE_CONNECTION_DETAILS');
  });
  await route.handler({}, route.response);
  assert.equal(route.response.statusCode, 503);
  assert.deepEqual(route.response.body, { error: 'Could not read diary activity metadata' });
  assert.equal(route.response.headers['Cache-Control'], 'no-store');
  assert.doesNotMatch(JSON.stringify(route.response), /PRIVATE_DATABASE/);
});

test('admin diagnostic kill switch avoids querying storage', async () => {
  const route = diagnosticRoute(async () => assert.fail('disabled diagnostic must not query'));
  route.env.KADE_MEMORY_HEALTH = '0';
  await route.handler({}, route.response);
  assert.deepEqual(route.response.body, { disabled: true });
  assert.equal(route.response.headers['Cache-Control'], 'no-store');
});
