const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const mongoose = require('mongoose');
const ts = require('typescript');

const helperPath = path.resolve(__dirname, '../../packages/api/src/audio/editDescription.ts');
const helperModule = new Module(helperPath, module);
helperModule._compile(ts.transpileModule(fs.readFileSync(helperPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, helperPath);
const source = fs.readFileSync(path.join(__dirname, 'kadeAsset.js'), 'utf8');

function fixture(env = {}, mirror = async () => null) {
  const calls = { get: [], post: [], updates: [], scheduled: [], mirror: [] };
  const db = new mongoose.Mongoose();
  const modelModule = { exports: {} };
  const stubs = {
    mongoose: db,
    axios: {
      get: async (...args) => {
        calls.get.push(args);
        return { data: Buffer.from('image'), headers: { 'content-type': 'image/png' } };
      },
      post: async (...args) => {
        calls.post.push(args);
        return { data: { choices: [{ message: { content: 'Existing generated description.' } }] } };
      },
    },
    '@librechat/data-schemas': { logger: { info() {}, warn() {} } },
    '@librechat/api': {
      ...helperModule.exports,
      saveURLToS3: async (args) => { calls.mirror.push(args); return mirror(args); },
    },
    '~/server/services/kadeRealCost': { openRouterCost: () => 0 },
    '~/models/kadeUsage': { logKadeUsage() {} },
  };
  vm.runInNewContext(source + '\nmodule.exports.enrichAsset = enrichAsset;', {
    require: (id) => {
      assert.ok(id in stubs, `Unexpected dependency: ${id}`);
      return stubs[id];
    },
    module: modelModule,
    process: { env: { OPENROUTER_KEY: 'test-only', KADE_ASSET_MIRROR: '0', ...env } },
    setImmediate: (fn) => calls.scheduled.push(fn),
    Buffer,
  }, { filename: 'kadeAsset.js' });
  const { KadeAsset, logKadeAsset, enrichAsset } = modelModule.exports;
  let stored;
  KadeAsset.create = async (values) => { stored = new KadeAsset(values); return stored; };
  KadeAsset.updateOne = async (filter, update) => {
    calls.updates.push({ filter, update });
    stored.set(update.$set);
  };
  const log = (values = {}) => logKadeAsset({
    userId: new mongoose.Types.ObjectId(), kind: 'audio', service: 'auk_audio',
    url: 'https://example.invalid/audio.wav', prompt: 'Make the voice Irish.',
    metadata: { aukTask: 'edit' }, ...values,
  });
  return { calls, log, enrichAsset };
}

test('AuK edit is labeled before detached enrichment and never described by a model', async () => {
  const { calls, log, enrichAsset } = fixture();
  const doc = await log({ metadata: { aukTask: 'edit', editInstruction: '  Make it\n youthful  ' } });
  assert.equal(doc.description, 'Edit requested: Make it youthful. The recording was processed. Listen to check whether the change worked.');
  assert.equal(calls.scheduled.length, 1);
  assert.equal(calls.updates.length, 0);
  await enrichAsset(doc);
  assert.equal(calls.post.length, 0);
  assert.equal(calls.get.length, 0);
  assert.equal(calls.updates.length, 0);
});

for (const env of [{ KADE_ASSET_DESCRIBE: '0' }, { OPENROUTER_KEY: '' }]) {
  test(`AuK edit label survives disabled model descriptions: ${JSON.stringify(env)}`, async () => {
    const { calls, log, enrichAsset } = fixture(env);
    const doc = await log();
    assert.match(doc.description, /^Edit requested: Make the voice Irish\./);
    await enrichAsset(doc);
    assert.equal(calls.post.length, 0);
    assert.equal(calls.get.length, 0);
    assert.equal(calls.updates.length, 0);
  });
}

test('an edit without a prompt still gets an honest result label', async () => {
  const { log } = fixture();
  const doc = await log({ prompt: undefined });
  assert.equal(doc.description, 'Audio edit requested. The recording was processed. Listen to check whether the change worked.');
});

for (const metadata of [{ descriptionSource: 'user' }, { title: 'My own title' }]) {
  test(`delayed edit mirroring preserves a user description: ${JSON.stringify(metadata)}`, async () => {
    let finishMirror;
    const { calls, log, enrichAsset } = fixture({ KADE_ASSET_MIRROR: '1' },
      () => new Promise((resolve) => { finishMirror = resolve; }));
    const doc = await log();
    const pending = enrichAsset(doc);
    doc.description = 'My own title';
    doc.metadata = { ...doc.metadata, ...metadata };
    finishMirror('https://example.invalid/backup.wav');
    await pending;
    assert.equal(doc.description, 'My own title');
    assert.equal(doc.backupUrl, 'https://example.invalid/backup.wav');
    assert.equal(calls.mirror.length, 1);
    assert.equal(calls.updates.length, 1);
    assert.deepEqual(Object.keys(calls.updates[0].update.$set), ['backupUrl']);
    assert.equal(calls.post.length, 0);
    assert.equal(calls.get.length, 0);
  });
}

test('ordinary AuK speech retains the existing model description path', async () => {
  const { calls, log, enrichAsset } = fixture();
  const doc = await log({ metadata: { aukTask: 'speech' }, prompt: '<speak>Hello</speak>' });
  assert.equal(doc.description, undefined);
  await enrichAsset(doc);
  assert.equal(calls.post.length, 1);
  assert.equal(calls.get.length, 0);
  assert.equal(doc.description, 'Existing generated description.');
  assert.match(calls.post[0][1].messages[0].content[0].text, /<speak>Hello<\/speak>/);
});

test('the edit marker does not change image descriptions', async () => {
  const { calls, log, enrichAsset } = fixture();
  const doc = await log({ kind: 'image' });
  assert.equal(doc.description, undefined);
  await enrichAsset(doc);
  assert.equal(calls.get.length, 1);
  assert.equal(calls.post.length, 1);
  assert.equal(doc.description, 'Existing generated description.');
});
