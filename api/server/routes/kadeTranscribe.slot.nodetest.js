/* Nov 12 2026 (audit SEC-6): transcription uploads are counted BEFORE the body is read. Big
 * uploads: 2 per person and KADE_TRANSCRIBE_MAX_RUNNING for the server. Small posts (Clubhouse
 * ears, dictation) have their own, larger count, so a room never goes deaf. Every finished
 * transcription is logged; voice memos at chargedUSD 0. Real express; Deepgram, the account and
 * the usage log are stand-ins, so nothing is spent.
 * Run: node --test api/server/routes/kadeTranscribe.slot.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const express = require('express');

const usage = [];
function load() {
  const filename = path.join(__dirname, 'kadeTranscribe.js');
  const loaded = new Module(filename, module);
  loaded.paths = module.paths;
  const stubs = {
    express,
    multer: Object.assign(() => ({ single: () => (_q, _s, n) => n(), any: () => (_q, _s, n) => n() }), { memoryStorage: () => ({}) }),
    '@librechat/data-schemas': { logger: { info() {}, warn() {}, error() {} } },
    '~/server/middleware': {
      requireJwtAuth: (req, _res, next) => {
        req.user = { id: req.get('x-test-user') || 'u1' };
        next();
      },
    },
    '~/models/kadePronunciation': { getUserDictionary: async () => [] },
    '~/models/kadeUsage': { logKadeUsage: async (row) => usage.push(row) },
  };
  loaded.require = (id) => (id in stubs ? stubs[id] : Module.prototype.require.call(loaded, id));
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return loaded.exports;
}

/* Deepgram stand-in: every request waits until release() is called. */
let waiting = [];
let reached = 0;
const realFetch = global.fetch;
function holdDeepgram() {
  global.fetch = async (url) => {
    if (!String(url).startsWith('https://api.deepgram.com/')) return realFetch(url);
    reached += 1;
    await new Promise((resolve) => waiting.push(resolve));
    return {
      ok: true,
      json: async () => ({ metadata: { duration: 30 }, results: { channels: [{ alternatives: [{ transcript: 'hello there' }] }] } }),
    };
  };
}
const releaseAll = () => {
  const w = waiting;
  waiting = [];
  w.forEach((r) => r());
};

function post(port, bytes, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'content-type': 'audio/mpeg', 'content-length': bytes, ...headers } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
      },
    );
    req.on('error', reject);
    req.end(Buffer.alloc(bytes, 1));
  });
}
const until = async (fn) => {
  for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
};

let server;
let port;
test.before(async () => {
  process.env.DEEPGRAM_API_KEY = 'test-only';
  holdDeepgram();
  const app = express();
  app.use(load());
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;
});
test.after(() => {
  global.fetch = realFetch;
  server.close();
});

test('three big uploads at once from one person: the third is refused while two run', async () => {
  reached = 0;
  const big = 9 * 1024 * 1024;
  const a = post(port, big, { 'x-test-user': 'big1' });
  const b = post(port, big, { 'x-test-user': 'big1' });
  await until(() => reached >= 2);
  const c = await post(port, big, { 'x-test-user': 'big1' });
  assert.equal(c.status, 429);
  assert.match(c.body.error, /Two of your transcriptions are already running/);
  releaseAll();
  assert.equal((await a).status, 200);
  assert.equal((await b).status, 200);
  // The slots came back.
  const d = post(port, big, { 'x-test-user': 'big1' });
  await until(() => waiting.length >= 1);
  releaseAll();
  assert.equal((await d).status, 200);
});

test('five small Clubhouse clips at once from one anchor all reach the transcriber', async () => {
  reached = 0;
  const posts = Array.from({ length: 5 }, () => post(port, 100 * 1024, { 'x-test-user': 'anchor', 'x-kade-club': '1' }));
  await until(() => reached >= 5);
  assert.equal(reached, 5);
  releaseAll();
  for (const r of await Promise.all(posts)) assert.equal(r.status, 200);
});

test('a voice memo is logged at chargedUSD 0; a Clubhouse clip as before, with no chargedUSD', async () => {
  usage.length = 0;
  const memo = post(port, 50 * 1024, { 'x-test-user': 'memo' });
  const club = post(port, 50 * 1024, { 'x-test-user': 'memo', 'x-kade-club': '1' });
  await until(() => waiting.length >= 2);
  releaseAll();
  await Promise.all([memo, club]);
  await until(() => usage.length >= 2);
  const t = usage.find((u) => u.service === 'transcribe');
  const c = usage.find((u) => u.service === 'clubhouse_ears');
  assert.equal(t.chargedUSD, 0);
  assert.equal(t.metadata.kind, 'voice_memo');
  assert.ok(!('chargedUSD' in c));
  assert.equal(t.quantity, 30);
});

test('a declared size over 150 MB is refused before the body is read', () => {
  let status = 0;
  let body = null;
  const { transcribeSlot } = load();
  const res = { status(n) { status = n; return this; }, json(b) { body = b; return this; }, set() { return this; } };
  transcribeSlot({ get: () => String(151 * 1024 * 1024), user: { id: 'x' } }, res, () => assert.fail('next'));
  assert.equal(status, 413);
  assert.match(body.error, /150 megabytes/);
});

test('a client that hangs up mid-upload frees its slot', async () => {
  reached = 0;
  const big = 9 * 1024 * 1024;
  for (let round = 0; round < 3; round++) {
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'content-length': big, 'x-test-user': 'quitter' } });
      req.on('error', () => resolve());
      req.write(Buffer.alloc(1024));
      setTimeout(() => { req.destroy(); resolve(); }, 50);
    });
  }
  await new Promise((r) => setTimeout(r, 100));
  const ok = post(port, big, { 'x-test-user': 'quitter' });
  await until(() => waiting.length >= 1);
  releaseAll();
  assert.equal((await ok).status, 200);
});
