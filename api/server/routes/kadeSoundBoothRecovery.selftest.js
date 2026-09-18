'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { KadeSoundBoothProject: Project } = require('../../models/kadeSoundBoothProject');

test('real project store: quoting, concurrent polls, stop, resume, and new takes', async (t) => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const remote = express(); remote.use(express.json());
  const starts = [], stops = [], uploaded = []; const jobs = new Map();
  remote.post('/audio/scenema/start', (req, res) => {
    starts.push(req.body); const id = 'job-' + starts.length; jobs.set(id, { state: 'queued' });
    res.json({ jobId: id });
  });
  remote.get('/audio/scenema/status', async (req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 40)); jobs.has(req.query.jobId) ? res.json(jobs.get(req.query.jobId)) : res.status(404).json({ error: 'gone' });
  });
  remote.post('/audio/scenema/cancel', (req, res) => { stops.push(req.body.jobId); res.json({ ok: true, state: jobs.get(req.body.jobId)?.state === 'done' ? 'done' : 'cancelled' }); });
  const remoteServer = remote.listen(0, '127.0.0.1');
  await new Promise((resolve) => remoteServer.on('listening', resolve));
  process.env.BRIDGE_URL = process.env.KADE_BRIDGE_URL = 'http://127.0.0.1:' + remoteServer.address().port;
  process.env.BRIDGE_SECRET = 'test-only';
  const user = new mongoose.Types.ObjectId();
  const module = { exports: {} };
  const localRequire = (name) => {
    if (name === '@librechat/data-schemas') return { logger: { info() {}, warn() {}, error() {} } };
    if (name === '@librechat/api') return { createYueRouter: () => require('express').Router(), yueConfigured: () => false, needsRefresh: () => false, saveBufferToS3: async (data) => { uploaded.push(data); return 'https://example.test/source.wav'; } };
    if (name === './kadeSoundBoothStitch') return { ...require(name), durationOf: async () => 61, normalizeReferenceClip: async () => { throw new Error('Must not trim an AuK source'); } };
    if (name === '~/server/middleware') return { requireJwtAuth: (req, _res, next) => { req.user = { id: String(user) }; next(); } };
    if (name === '~/models/kadeSoundBoothProject') return { KadeSoundBoothProject: Project };
    if (name === '~/models/kadeUsage') return { logKadeUsage: async () => {} };
    if (name === '~/models/kadeAsset') return { logKadeAsset: async () => {}, KadeAsset: { find: () => ({ lean: async () => [] }) } };
    return require(name);
  };
  const source = fs.readFileSync(path.join(__dirname, 'kadeSoundBooth.js'), 'utf8');
  vm.runInNewContext(source, { require: localRequire, module, exports: module.exports, process, console, Buffer, URL, URLSearchParams, setTimeout, clearTimeout });
  const app = express(); app.use('/booth', module.exports);
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.on('listening', resolve));
  const call = async (route, body) => {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/booth' + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  t.after(async () => {
    for (let i = 0; i < 50 && await Project.countDocuments({ renderLease: { $exists: true } }); i++) await new Promise(r => setTimeout(r, 10));
    server.closeAllConnections(); remoteServer.closeAllConnections(); await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => remoteServer.close(r))]); await mongoose.disconnect(); await mongo.stop(); });
  const script = '<speak voice="A dry clear adult voice" gender="female">' + 'This is a complete sentence with a clear voice and a steady rhythm. '.repeat(78) + '</speak>';
  const body = { engine: 'scenema', script, seed: 1234, validate: false, vc_steps: 42, min_match_ratio: 0.9, skip_vc: true };
  await t.test('a price quote makes no job and saves no project', async () => {
    const r = await call('/render', { ...body, estimateOnly: true });
    assert.equal(r.status, 200); assert.equal(r.data.estimate.costUSD, null);
    assert.match(r.data.estimate.spoken, /startup, processing/i);
    assert.equal(starts.length, 0); assert.equal(await Project.countDocuments(), 0);
  });
  let id;
  await t.test('long render starts polling and forwards voice controls', async () => {
    const r = await call('/render', body); assert.equal(r.status, 200); assert.equal(r.data.queued, true);
    id = r.data.projectId; assert.equal(r.data.voiceSeed, 1234);
    assert.equal(starts[0].seed, 1234); assert.equal(starts[0].vc_steps, 42); assert.equal(starts[0].validate, false); assert.equal(starts[0].skip_vc, true);
  });
  await t.test('an active render cannot be overwritten', async () => {
    const r = await call('/render', { ...body, projectId: id, seed: 9999 }); assert.equal(r.status, 409);
    assert.equal((await Project.findById(id)).voiceSeed, 1234);
  });
  await t.test('overlapping device polls submit the next part only once', async () => {
    jobs.set('job-1', { state: 'done', result: { url: 'https://example.test/part1.mp3', wavUrl: 'https://example.test/part1.wav', engine: 'auk', durationS: 30 }, costUSD: 0.1 });
    await Promise.all([call('/status/job-1'), call('/status/job-1')]);
    assert.equal(starts.length, 2); const p = await Project.findById(id);
    assert.equal(p.parts[0].state, 'done'); assert.equal(p.costUSD, 0.1); assert.equal(p.parts[1].jobId, 'job-2');
    assert.equal(p.parts[0].wavUrl, 'https://example.test/part1.wav');
    assert.equal(starts[1].reference_voice_url, 'https://example.test/part1.wav');
  });
  await t.test('Stop resolves the current part even when the device holds the original job id', async () => {
    const r = await call('/cancel/job-1', {}); assert.equal(r.status, 200); assert.deepEqual(stops, ['job-2']);
    assert.equal((await Project.findById(id)).state, 'cancelled');
    const poll = await call('/status/job-1'); assert.equal(poll.data.state, 'cancelled'); assert.equal(starts.length, 2);
  });
  await t.test('resume keeps the completed paid part and voice settings', async () => {
    const r = await call('/render', { ...body, projectId: id }); assert.equal(r.status, 200); assert.equal(r.data.resumed, true);
    const p = await Project.findById(id); assert.equal(p.parts[0].state, 'done'); assert.equal(p.parts[0].url, 'https://example.test/part1.mp3');
    assert.equal(starts.length, 3); assert.equal(starts[2].seed, 1234);
  });
  await t.test('Stop keeps a just-finished part without starting the next one', async () => {
    jobs.set('job-3', { state: 'done', result: { url: 'https://example.test/part2.mp3', durationS: 30 }, costUSD: 0.1 });
    const r = await call('/cancel/job-1', {}); assert.equal(r.data.state, 'cancelled');
    const p = await Project.findById(id); assert.equal(p.parts[1].state, 'done');
    await call('/status/job-1'); assert.equal(starts.length, 3);
  });
  await t.test('a new short take clears stale multipart state', async () => {
    await Project.updateOne({ _id: id }, { $set: { state: 'failed' } });
    const r = await call('/render', { ...body, projectId: id, script: '<speak voice="clear" gender="female">One new line.</speak>' });
    assert.equal(r.status, 200); const p = await Project.findById(id); assert.equal(p.parts.length, 0); assert.equal(p.voiceSeed, 1234);
  });
  await t.test('polling an old take cannot finish a newer one', async () => {
    await call('/status/job-1'); assert.equal((await Project.findById(id)).state, 'queued');
  });
  await t.test('concurrent single-take finishes charge once', async () => {
    jobs.set('job-4', { state: 'done', result: { url: 'https://example.test/new.mp3', durationS: 5 }, costUSD: 0.05 });
    const before = (await Project.findById(id)).costUSD;
    await Promise.all([call('/status/job-4'), call('/status/job-4')]);
    assert.equal((await Project.findById(id)).costUSD, before + 0.05);
  });
  await t.test('two devices starting a new take submit only once', async () => {
    const before = starts.length;
    const results = await Promise.all([call('/render', { ...body, projectId: id }), call('/render', { ...body, projectId: id })]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); assert.equal(starts.length, before + 1);
  });

  await t.test('a forgotten single job exits polling and allows a retry', async () => {
    const p = await Project.create({ user, state: 'queued', jobs: ['missing-job'], script: 'Old test' });
    const r = await call('/status/missing-job'); assert.equal(r.status, 200); assert.equal(r.data.state, 'failed');
    assert.equal((await Project.findById(p._id)).state, 'failed');
  });

  await t.test('AuK edit preserves the instruction and source through quote and submit', async () => {
    const edit = { engine: 'scenema', auk_task: 'edit', instruction: 'Replace Tuesday with Thursday.', reference_voice_url: 'https://example.test/source.wav', gen_seconds: 8 };
    let r = await call('/render', { ...edit, estimateOnly: true });
    assert.equal(r.status, 200); assert.equal(r.data.estimate.audioSeconds, 8);
    const before = starts.length;
    r = await call('/render', edit); assert.equal(r.status, 200);
    assert.equal(starts.length, before + 1);
    const sent = starts.at(-1);
    assert.equal(sent.auk_task, 'edit'); assert.equal(sent.instruction, edit.instruction);
    assert.equal(sent.reference_voice_url, edit.reference_voice_url); assert.equal(sent.gen_seconds, 8);
    const saved = await Project.findById(r.data.projectId);
    assert.equal(saved.script, edit.instruction); assert.equal(saved.options.auk_task, 'edit');
    r = await call('/render', { ...edit, reference_voice_url: undefined }); assert.equal(r.status, 400);
    r = await call('/render', { ...edit, gen_seconds: -1 }); assert.equal(r.status, 400);
  });

  await t.test('long scripts retain their full text for recovery', async () => {
    const longScript = '<speak voice="clear" gender="female">' + 'A sentence with familiar words and a steady pace. '.repeat(190) + '</speak>';
    assert.ok(longScript.length > 8000);
    const r = await call('/render', { engine: 'scenema', script: longScript });
    assert.equal(r.status, 200);
    assert.equal((await Project.findById(r.data.projectId)).script, longScript);
  });

  await t.test('redesigning a voice replaces an old XML voice description safely', async () => {
    const r = await call('/render', { engine: 'scenema', script: '<speak voice="old voice" gender="female">Hello there.</speak>', voice_description: 'Warm & expressive "storyteller"' });
    assert.equal(r.status, 200);
    assert.match(starts.at(-1).prompt, /voice="Warm &amp; expressive &quot;storyteller&quot;"/);
    assert.doesNotMatch(starts.at(-1).prompt, /old voice/);
    assert.match(starts.at(-1).prompt, /Hello there\./);
  });

  await t.test('AuK import preserves the entire source beyond the old 45-second trim', async () => {
    const original = Buffer.alloc(61 * 24000 * 2, 17);
    const form = new FormData(); form.append('engine', 'scenema');
    form.append('clip', new Blob([original], { type: 'audio/wav' }), 'recording.wav');
    const r = await fetch('http://127.0.0.1:' + server.address().port + '/booth/reference', { method: 'POST', body: form });
    assert.equal(r.status, 200); const data = await r.json();
    assert.equal(data.seconds, 61); assert.deepEqual(uploaded.at(-1).buffer, original);
    assert.match(data.spoken, /full original recording is kept/);
  });

});
