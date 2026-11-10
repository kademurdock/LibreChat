'use strict';
/* Nov 10 2026: "organize your thoughts" had no time limit on its model call; a host that went quiet
 * left the page waiting for ever. Run: node --test api/server/routes/kadeTranscribe.organize.nodetest.js
 * (needs express on the path; fetch is a stub, nothing leaves the machine). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

function load() {
  const filename = path.join(__dirname, 'kadeTranscribe.js');
  const loaded = new Module(filename, module);
  loaded.paths = module.paths;
  const stubs = {
    express: Object.assign(() => ({}), { Router: () => ({ post() {}, get() {}, use() {} }), json: () => () => {}, raw: () => () => {} }),
    multer: Object.assign(() => ({ single: () => () => {}, any: () => () => {} }), { memoryStorage: () => ({}) }),
    '@librechat/data-schemas': { logger: { info() {}, warn() {}, error() {} } },
    '~/server/middleware': { requireJwtAuth: () => {} },
    '~/models/kadePronunciation': { getUserDictionary: async () => [] },
  };
  loaded.require = (id) => (id in stubs ? stubs[id] : Module.prototype.require.call(loaded, id));
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return loaded.exports.organizeText;
}

async function withFetch(stub, env, run) {
  const keep = { fetch: global.fetch, key: process.env.OPENROUTER_KEY, wait: process.env.KADE_ORGANIZE_TIMEOUT_MS };
  global.fetch = stub;
  process.env.OPENROUTER_KEY = 'test-only';
  if (env.KADE_ORGANIZE_TIMEOUT_MS) process.env.KADE_ORGANIZE_TIMEOUT_MS = env.KADE_ORGANIZE_TIMEOUT_MS;
  else delete process.env.KADE_ORGANIZE_TIMEOUT_MS;
  try { return await run(load()); } finally {
    global.fetch = keep.fetch;
    if (keep.key === undefined) delete process.env.OPENROUTER_KEY; else process.env.OPENROUTER_KEY = keep.key;
    if (keep.wait === undefined) delete process.env.KADE_ORGANIZE_TIMEOUT_MS; else process.env.KADE_ORGANIZE_TIMEOUT_MS = keep.wait;
  }
}
/** A host that never answers, and ends only when the caller's own signal fires (as fetch does). */
const silentHost = (seen) => (url, options) => new Promise((_, reject) => {
  seen.push(options);
  if (!options.signal) return; // no signal: waits for ever, which is the bug
  options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
});

test('a model host that never answers is cut at the time limit with a plain message', async () => {
  const seen = [];
  await withFetch(silentHost(seen), { KADE_ORGANIZE_TIMEOUT_MS: '1000' }, async (organizeText) => {
    const t0 = Date.now();
    const outcome = await Promise.race([
      organizeText('um so I was thinking we should, uh, move the meeting', 'notes').then(() => 'answered', (e) => e.message),
      new Promise((resolve) => setTimeout(() => resolve('STILL WAITING after 4 s (the bug)'), 4000)),
    ]);
    assert.equal(outcome, 'The organizer took too long to answer. Your transcript is unchanged. Please try again.');
    assert.ok(Date.now() - t0 < 2500);
    assert.ok(seen[0].signal, 'the call carries a time limit');
  });
});

test('a body that stalls after the headers is cut by the same limit', async () => {
  await withFetch(async (url, options) => ({ ok: true, json: () => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }) }), { KADE_ORGANIZE_TIMEOUT_MS: '1000' }, async (organizeText) => {
    await assert.rejects(organizeText('some words to tidy', 'prose'), /took too long to answer/);
  });
});

test('an ordinary answer and an ordinary refusal are unchanged; the default wait is 90 s', async () => {
  let waited = null;
  const keepTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => { waited = ms; return keepTimeout.call(AbortSignal, ms); };
  try {
    await withFetch(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: ' **Meeting** \n- Move it. ' } }] }) }), {}, async (organizeText) => {
      assert.equal(await organizeText('move the meeting', 'notes'), '**Meeting** \n- Move it.');
    });
    assert.equal(waited, 90000);
    await withFetch(async () => ({ ok: false, status: 402, text: async () => 'Insufficient credits' }), {}, async (organizeText) => {
      await assert.rejects(organizeText('move the meeting', 'notes'), /^Error: Organizer 402: Insufficient credits$/);
    });
    await withFetch(async () => ({ ok: true, json: async () => ({ choices: [] }) }), { KADE_ORGANIZE_TIMEOUT_MS: '12' }, async (organizeText) => {
      await assert.rejects(organizeText('move the meeting', 'notes'), /returned nothing/);
    });
    assert.equal(waited, 90000, 'a limit under one second is ignored');
  } finally { AbortSignal.timeout = keepTimeout; }
});
