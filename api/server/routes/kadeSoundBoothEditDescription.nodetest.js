const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const express = require('express'), mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { KadeAsset } = require('../../models/kadeAsset');
const { KadeSoundBoothProject: Project } = require('../../models/kadeSoundBoothProject');
const ts = require('typescript');
const mod = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../../../packages/api/src/audio/editDescription.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module: mod, exports: mod.exports });
const descriptions = mod.exports;

test('edit result wording distinguishes requests from observed effects and preserves explicit descriptions', () => {
  const asset = { kind: 'audio', service: 'auk_audio', prompt: 'Make the voice Irish.', description: 'An Irish voice speaks.' };
  assert.equal(descriptions.audioAssetDescription(asset), asset.description);
  assert.equal(descriptions.audioAssetDescription(asset, true), 'Edit requested: Make the voice Irish. The recording was processed. Listen to check whether the change worked.');
  assert.equal(descriptions.audioAssetDescription({ ...asset, metadata: { aukTask: 'edit', editInstruction: 'Make it younger.' } }), descriptions.aukEditDescription(asset.prompt));
  assert.equal(descriptions.audioAssetDescription({ ...asset, metadata: { aukTask: 'edit', descriptionSource: 'user' } }), asset.description);
  assert.equal(descriptions.audioAssetDescription({ ...asset, metadata: { title: asset.description } }, true), asset.description);
  assert.equal(descriptions.audioAssetDescription({ ...asset, prompt: '<speak>Hello.</speak>' }, true), asset.description);
});

test('actual gallery and asset-event routes label per-take edits without changing saved descriptions', async t => {
  const mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  const user = new mongoose.Types.ObjectId(), other = new mongoose.Types.ObjectId();
  const instruction1 = 'Give this voice an Irish accent.', instruction2 = 'Make this voice sound younger.';
  const first = await KadeAsset.create({ user, kind: 'audio', service: 'auk_audio', prompt: instruction1, description: 'An Irish woman speaks.', url: 'https://storage.test/irish.mp3' });
  const second = await KadeAsset.create({ user, kind: 'audio', service: 'auk_audio', prompt: instruction2, description: 'A youthful voice speaks.', url: 'https://storage.test/young.mp3' });
  const custom = await KadeAsset.create({ user, kind: 'audio', service: 'auk_audio', prompt: instruction1, description: 'My own title', metadata: { title: 'My own title' }, url: 'https://storage.test/custom.mp3' });
  const editProject = await Project.create({ user, engine: 'scenema', state: 'done', script: instruction2, options: { auk_task: 'edit', instruction: instruction2 }, assets: [first._id, second._id, custom._id], jobs: ['current-edit'] });
  const helper = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeSoundBoothAssetDescriptions.js'), 'utf8'), { module: helper, require: name => name === '@librechat/api' ? descriptions : { KadeSoundBoothProject: Project } });
  const app = express(); app.use(express.json());
  const logged = [];
  const source = fs.readFileSync(path.join(__dirname, 'kade.js'), 'utf8');
  const context = { router: app, KadeAsset, mongoose, ...descriptions, isAdminRole: () => true, freshAssetUrl: async url => url, logger: console,
    process: { env: { KADE_USAGE_EVENT_SECRET: 'fixture' } },
    requireJwtAuth: (req, _res, next) => { req.user = { id: String(user) }; req.query ||= {}; next(); },
    require: name => name === './kadeSoundBoothAssetDescriptions' ? helper.exports : { logKadeAsset: async data => { logged.push(data); } } };
  vm.runInNewContext(source.slice(source.indexOf('async function assetView('), source.indexOf("router.get('/my-assets'")), context);
  for (const route of ["router.get('/my-assets'", "router.post('/asset-event'"]) {
    const start = source.indexOf(route), end = source.indexOf('\n});', start) + 4;
    vm.runInNewContext(source.slice(start, end), context);
  }
  const boothSource = fs.readFileSync(path.join(__dirname, 'kadeSoundBooth.js'), 'utf8');
  vm.runInNewContext(boothSource.slice(boothSource.indexOf('async function takesFor('), boothSource.indexOf('function projectView(')), context);
  const boothTakes = await context.takesFor([editProject], user);
  assert.equal(boothTakes.get(first.id).description, descriptions.aukEditDescription(instruction1));
  assert.equal(boothTakes.get(second.id).description, descriptions.aukEditDescription(instruction2));
  const server = app.listen(0); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await mongo.stop(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const response = await fetch(base + '/my-assets'); assert.equal(response.status, 200);
  const rows = (await response.json()).assets;
  assert.equal(rows.find(row => row.id === first.id).description, descriptions.aukEditDescription(instruction1));
  assert.equal(rows.find(row => row.id === second.id).description, descriptions.aukEditDescription(instruction2));
  assert.equal(rows.find(row => row.id === custom.id).description, 'My own title');
  assert.equal((await KadeAsset.findById(first.id)).description, first.description, 'presentation does not rewrite stored history');
  await Project.updateOne({ _id: editProject._id }, { $set: { script: 'A newer draft instruction.', 'options.instruction': 'A newer draft instruction.' } });
  const post = userId => fetch(base + '/asset-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: 'fixture', userId, kind: 'audio', service: 'auk_audio', url: 'https://storage.test/finished.wav', prompt: instruction2, metadata: { jobId: 'current-edit' } }) });
  assert.equal((await post(String(user))).status, 200);
  assert.equal(logged[0].metadata.aukTask, 'edit'); assert.equal(logged[0].metadata.editInstruction, instruction2);
  assert.equal((await post(String(other))).status, 200);
  assert.equal(logged[1].metadata.aukTask, undefined, 'project lookup is account scoped');
});

test('multipart stitch marks the saved result as an edit with its actual instruction', async () => {
  let logged;
  const loaded = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeSoundBoothChain.js'), 'utf8'), {
    module: loaded, process, Buffer, console,
    require: name => {
      if (name === 'axios') return { get: async () => ({ data: Buffer.from('rendered part') }) };
      if (name === '@librechat/api') return { saveBufferToS3: async () => 'https://storage.test/joined.mp3' };
      if (name === '~/models/kadeAsset') return { logKadeAsset: async data => { logged = data; return { _id: 'saved-edit' }; } };
      if (name === './kadeSoundBoothStitch') return { stitchMp3Buffers: async () => ({ buffer: Buffer.from('joined'), notes: [] }), durationOf: async () => 60, sayStitched: () => 'Ready.' };
      if (name === '@librechat/data-schemas') return { logger: { info() {}, warn() {}, error() {} } };
      return require(name);
    },
  });
  const project = { _id: 'project', user: 'owner', script: 'Make the voice Irish.', options: { auk_task: 'edit' }, assets: [], parts: [0, 1].map(index => ({ index, state: 'done', url: 'https://storage.test/part.mp3', audioEngine: 'auk' })), save: async () => {} };
  await loaded.exports.stitch(project);
  assert.equal(logged.metadata.aukTask, 'edit');
  assert.equal(logged.metadata.editInstruction, project.script);
  assert.equal(project.state, 'done');
});
