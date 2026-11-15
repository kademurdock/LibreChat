/* Open voices in the Sound Booth (Nov 15 2026): VoxCPM2 and Ming, Design a voice and Speak with a
 * voice, saved voices as marked My Creations rows. The router runs with fakes for the bridge,
 * storage re-signing and the asset store; nothing is called for real.
 *
 * Run: node --test api/server/routes/kadeSoundBoothOpenVoices.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const ov = require('./kadeSoundBoothOpenVoices');
const { OPEN_VOICES_HTML, OPEN_VOICES_SCRIPT } = require('./kadeSoundBoothOpenVoicesPage');

const USER = '6a0000000000000000000abc';
const OTHER = '6a0000000000000000000def';
const B2 = 'https://s3.us-east-005.backblazeb2.com/bucket';

/* ---------- a tiny in-memory KadeAsset ---------- */
function fakeAssets(rows) {
  let n = 0;
  const get = (o, p) => p.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
  const match = (row, q) => Object.entries(q).every(([k, v]) => {
    const have = get(row, k);
    if (v && typeof v === 'object' && '$exists' in v) return (have !== undefined) === v.$exists;
    return String(have) === String(v);
  });
  const chain = (value) => ({ sort() { return chain(value); }, select() { return chain(value); }, lean: async () => (value == null ? null : JSON.parse(JSON.stringify(value))) });
  return {
    rows,
    find: (q) => chain(rows.filter((r) => match(r, q))),
    findOne: (q) => chain(rows.find((r) => match(r, q)) || null),
    async updateOne(q, u) {
      const row = rows.find((r) => match(r, q));
      if (!row) return { modifiedCount: 0 };
      for (const [k, v] of Object.entries(u.$set || {})) { const ks = k.split('.'); let o = row; ks.slice(0, -1).forEach((x) => { o = o[x] = o[x] || {}; }); o[ks.at(-1)] = v; }
      for (const k of Object.keys(u.$unset || {})) { const ks = k.split('.'); let o = row; ks.slice(0, -1).forEach((x) => { o = o && o[x]; }); if (o) delete o[ks.at(-1)]; }
      return { modifiedCount: 1 };
    },
    async create(doc) { const row = { _id: `7b00000000000000000000${String(++n).padStart(2, '0')}`, ...JSON.parse(JSON.stringify(doc)) }; rows.push(row); return row; },
  };
}

function fakeHttp(bridge) {
  const calls = [];
  return {
    calls,
    async get(url, o) { calls.push({ verb: 'get', url, o }); return bridge.get(url, o); },
    async post(url, body, o) { calls.push({ verb: 'post', url, body, o }); return bridge.post(url, body, o); },
  };
}

async function boot(t, { ready = { voxcpm: true, ming: false }, rows = [], bridge } = {}) {
  const assets = fakeAssets(rows);
  const http = fakeHttp(bridge || {
    get: async (url, o) => ({ data: { state: 'done', engine: 'voxcpm', mode: 'design', seed: 5, result: { url: `${B2}/voxcpm/t.mp3?X-Amz-Signature=w`, seconds: 2.5, seed: 5 }, jobId: o.params.jobId } }),
    post: async (url, body) => ({ data: url.endsWith('/start') ? { ok: true, jobId: 'ov_abc123def', seed: body.seed || 77, coldLikely: true } : { ok: true, state: 'cancelled' } }),
  });
  const refreshed = [];
  const app = express();
  app.use((req, _res, next) => { req.user = { id: req.headers['x-user'] || USER }; next(); });
  app.use(ov.createOpenVoicesRouter({
    auth: (_req, _res, next) => next(), http, bridgeBase: () => 'https://bridge.test', secret: () => 'test-only',
    readiness: async () => ready, KadeAsset: assets,
    fresh: async (url) => { refreshed.push(url); return url.replace(/\?.*$/, '') + '?X-Amz-Signature=fresh'; },
    references: (user) => ({
      authorize: async (url) => { if (!String(url).startsWith(`${B2}/audios/${user}/`)) throw new Error('not yours'); },
      refresh: async (url) => { if (!String(url).startsWith(`${B2}/audios/${user}/`)) throw new Error('not yours'); return url.replace(/\?.*$/, '') + '?X-Amz-Signature=fresh'; },
    }),
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, user) => {
    const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { call, http, assets, refreshed };
}

test('checkTake: both modes, plain refusals, Ming refused while not set up', () => {
  const ready = { voxcpm: true, ming: false };
  assert.deepEqual(ov.checkTake({ engine: 'voxcpm', mode: 'design', description: ' A  warm voice ', text: ' Hi ' }, ready).body,
    { engine: 'voxcpm', mode: 'design', text: 'Hi', description: 'A warm voice' });
  assert.equal(ov.checkTake({ engine: 'ming', mode: 'design', description: 'd', text: 'Hi' }, ready).error, 'Ming is not set up yet. Use VoxCPM2 for now.');
  assert.equal(ov.checkTake({ engine: 'ming', mode: 'design', description: 'd', text: 'Hi' }, { ming: true }).body.engine, 'ming');
  assert.match(ov.checkTake({ engine: 'voxcpm', mode: 'design', text: 'Hi' }, ready).error, /Describe the voice/);
  assert.match(ov.checkTake({ engine: 'voxcpm', mode: 'speak', text: 'Hi' }, ready).error, /saved voice or import a clip/);
  assert.match(ov.checkTake({ engine: 'voxcpm', mode: 'design', description: 'd', text: '' }, ready).error, /words to say/);
  assert.match(ov.checkTake({ engine: 'voxcpm', mode: 'design', description: 'd', text: 'x'.repeat(5001) }, ready).error, /5000/);
  assert.match(ov.checkTake({ engine: 'voxcpm', mode: 'design', description: 'd'.repeat(401), text: 'x' }, ready).error, /400/);
  assert.match(ov.checkTake({ engine: 'voxcpm', mode: 'design', description: 'd', text: 'x', seed: 'abc' }, ready).error, /whole number/);
  assert.equal(ov.checkTake({ engine: 'voxcpm', mode: 'design', description: 'd', text: 'x', seed: '' }, ready).body.seed, undefined);
  assert.equal(ov.checkTake({ engine: 'voxcpm', mode: 'design', description: 'd', text: 'x', seed: '12' }, ready).body.seed, 12);
  const speak = ov.checkTake({ engine: 'voxcpm', mode: 'speak', text: 'x', style: 'slightly faster,  cheerful tone', voiceId: '7b0000000000000000000001' }, ready).body;
  assert.deepEqual(speak, { engine: 'voxcpm', mode: 'clone', text: 'x', style: 'slightly faster, cheerful tone' });
});

test('a saved voice sends its words only for a short clip', () => {
  assert.equal(ov.promptWordsFor({ words: 'Hello there.', seconds: 3 }), 'Hello there.');
  assert.equal(ov.promptWordsFor({ words: 'Long one.', seconds: 31 }), '');
  assert.equal(ov.promptWordsFor({ words: 'No length.' }), '');
  assert.equal(ov.promptWordsFor({ seconds: 3 }), '');
});

test('the list shows ready engines and only this person\'s saved voices, re-signed', async (t) => {
  const rows = [
    { _id: '7b0000000000000000000001', user: USER, kind: 'audio', url: `${B2}/voxcpm/a.mp3?X-Amz-Signature=old`, backupUrl: `${B2}/assets/a.mp3?X-Amz-Signature=old`, metadata: { savedVoice: { name: 'Grandpa', engine: 'voxcpm', seconds: 3.1 } } },
    { _id: '7b0000000000000000000002', user: USER, kind: 'audio', url: `${B2}/voxcpm/b.mp3`, metadata: { jobId: 'ov_x' } },
    { _id: '7b0000000000000000000003', user: OTHER, kind: 'audio', url: `${B2}/voxcpm/c.mp3`, metadata: { savedVoice: { name: 'Not hers' } } },
  ];
  const { call } = await boot(t, { rows });
  const r = await call('/open-voices');
  assert.deepEqual(r.body.engines.map((e) => e.id), ['voxcpm']);
  assert.deepEqual(r.body.voices.map((v) => v.name), ['Grandpa']);
  assert.equal(r.body.voices[0].url, `${B2}/assets/a.mp3?X-Amz-Signature=fresh`, 'the mirror, re-signed');
  assert.equal(r.body.coldNote, ov.COLD_NOTE);
});

test('Design a voice: the bridge gets the description and words, and the cold note comes back', async (t) => {
  const { call, http } = await boot(t);
  const r = await call('/open-voices/take', { engine: 'voxcpm', mode: 'design', description: 'A bright young voice', text: 'Good morning.' });
  assert.equal(r.status, 200);
  assert.equal(r.body.jobId, 'ov_abc123def');
  assert.equal(r.body.coldLikely, true);
  assert.match(r.body.coldNote, /first take after a quiet spell can take a few minutes/);
  const start = http.calls.find((c) => c.url === 'https://bridge.test/audio/open-voices/start');
  assert.deepEqual(start.body, { engine: 'voxcpm', mode: 'design', text: 'Good morning.', description: 'A bright young voice', secret: 'test-only', userId: USER });
  const refused = await call('/open-voices/take', { engine: 'ming', mode: 'design', description: 'd', text: 'x' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'Ming is not set up yet. Use VoxCPM2 for now.');
});

test('Speak with a saved voice: re-signed clip, its words, and the style', async (t) => {
  const rows = [{ _id: '7b0000000000000000000001', user: USER, kind: 'audio', url: `${B2}/voxcpm/a.mp3?X-Amz-Signature=old`,
    metadata: { savedVoice: { name: 'Grandpa', engine: 'voxcpm', words: 'Hello there, kiddo.', seconds: 2.8 } } }];
  const { call, http } = await boot(t, { rows, ready: { voxcpm: true, ming: true } });
  const r = await call('/open-voices/take', { engine: 'ming', mode: 'speak', voiceId: '7b0000000000000000000001', text: 'Time for supper.', style: 'cheerful tone' });
  assert.equal(r.status, 200);
  const start = http.calls.find((c) => c.url.endsWith('/start'));
  assert.equal(start.body.mode, 'clone');
  assert.equal(start.body.reference_voice_url, `${B2}/voxcpm/a.mp3?X-Amz-Signature=fresh`);
  assert.equal(start.body.prompt_text, 'Hello there, kiddo.');
  assert.equal(start.body.style, 'cheerful tone');
  const theirs = await call('/open-voices/take', { engine: 'voxcpm', mode: 'speak', voiceId: '7b0000000000000000000001', text: 'x' }, OTHER);
  assert.equal(theirs.status, 400);
  assert.match(theirs.body.error, /saved voice is gone/);
});

test('Speak with an imported clip: only this person\'s upload, re-signed, words passed through', async (t) => {
  const { call, http } = await boot(t);
  const clip = `${B2}/audios/${USER}/soundbooth-ref-abc.wav?X-Amz-Signature=old`;
  const r = await call('/open-voices/take', { engine: 'voxcpm', mode: 'speak', clipUrl: clip, clipWords: 'This is me talking.', clipSeconds: 12.4, text: 'Hi' });
  assert.equal(r.status, 200);
  const start = http.calls.find((c) => c.url.endsWith('/start'));
  assert.equal(start.body.reference_voice_url, `${B2}/audios/${USER}/soundbooth-ref-abc.wav?X-Amz-Signature=fresh`);
  assert.equal(start.body.prompt_text, 'This is me talking.');
  const foreign = await call('/open-voices/take', { engine: 'voxcpm', mode: 'speak', clipUrl: `${B2}/audios/${OTHER}/x.wav`, text: 'Hi' });
  assert.equal(foreign.status, 400);
  assert.match(foreign.body.error, /not saved on your account/);
});

test('an imported clip\'s words go only with a clip of thirty seconds or less', async (t) => {
  const { call, http } = await boot(t);
  const clip = `${B2}/audios/${USER}/soundbooth-ref-abc.wav`;
  const starts = () => http.calls.filter((c) => c.url.endsWith('/start'));
  const long = await call('/open-voices/take', { engine: 'voxcpm', mode: 'speak', clipUrl: clip, clipWords: 'All of it.', clipSeconds: 45, text: 'Hi' });
  assert.equal(long.status, 400);
  assert.match(long.body.error, /thirty seconds or less/);
  assert.equal(starts().length, 0, 'refused before any GPU time');
  const unknown = await call('/open-voices/take', { engine: 'voxcpm', mode: 'speak', clipUrl: clip, clipWords: 'All of it.', text: 'Hi' });
  assert.equal(unknown.status, 200);
  assert.equal('prompt_text' in starts().at(-1).body, false, 'a clip of unknown length goes without the words');
  await call('/open-voices/take', { engine: 'voxcpm', mode: 'speak', clipUrl: clip, clipWords: 'All of it.', clipSeconds: 29, text: 'Hi' });
  assert.equal(starts().at(-1).body.prompt_text, 'All of it.');
});

test('a finished take reports its recording; Keep marks its My Creations row, with no cap', async (t) => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push({ _id: `7c00000000000000000000${String(i).padStart(2, '0')}`, user: USER, kind: 'audio', url: `${B2}/x${i}.mp3`, metadata: { savedVoice: { name: `V${i}` } } });
  rows.push({ _id: '7b0000000000000000000009', user: USER, kind: 'audio', url: `${B2}/voxcpm/t.mp3`, metadata: { jobId: 'ov_abc123def', openVoice: { engine: 'voxcpm', mode: 'design', description: 'A bright voice', words: 'Good morning.', seconds: 2.5 } } });
  const { call, assets } = await boot(t, { rows });
  const s = await call('/open-voices/take/ov_abc123def');
  assert.equal(s.body.state, 'done');
  assert.equal(s.body.assetId, '7b0000000000000000000009');
  assert.equal(s.body.seconds, 2.5);
  assert.equal((await call('/open-voices/keep', { jobId: 'ov_abc123def', name: '' })).status, 400);
  const k = await call('/open-voices/keep', { jobId: 'ov_abc123def', name: 'Morning voice' });
  assert.equal(k.status, 200);
  assert.equal(k.body.spoken, 'Saved Morning voice to your voices.');
  const kept = assets.rows.find((r) => r._id === '7b0000000000000000000009').metadata.savedVoice;
  assert.equal(kept.name, 'Morning voice');
  assert.equal(kept.words, 'Good morning.');
  assert.equal(kept.seconds, 2.5);
  assert.equal((await call('/open-voices')).body.voices.length, 31);
  assert.equal((await call('/open-voices/keep', { jobId: 'ov_abc123def', name: 'x' }, OTHER)).status, 404);
  assert.equal((await call('/open-voices/take/not-a-job')).status, 400);
});

test('an imported clip can be kept as a voice, and a voice can be forgotten', async (t) => {
  const { call, assets } = await boot(t);
  const clip = `${B2}/audios/${USER}/soundbooth-ref-abc.wav?X-Amz-Signature=old`;
  const k = await call('/open-voices/keep-clip', { clipUrl: clip, name: 'My own voice', clipWords: 'Hi, it is me.', seconds: 12.34 });
  assert.equal(k.status, 200);
  const row = assets.rows.at(-1);
  assert.equal(row.url, clip);
  assert.equal(row.service, 'soundbooth_voice');
  assert.deepEqual({ ...row.metadata.savedVoice, savedAt: 'x' }, { name: 'My own voice', engine: null, description: '', words: 'Hi, it is me.', seconds: 12.3, savedAt: 'x' });
  assert.equal((await call('/open-voices/keep-clip', { clipUrl: `${B2}/audios/${OTHER}/x.wav`, name: 'n' })).status, 400);
  const f = await call('/open-voices/forget', { voiceId: k.body.voice.id });
  assert.equal(f.status, 200);
  assert.equal(row.metadata.savedVoice, undefined);
  assert.equal(assets.rows.includes(row), true, 'the recording stays');
  assert.equal((await call('/open-voices/forget', { voiceId: k.body.voice.id })).status, 404);
});

test('a bridge refusal is said plainly; a failed take carries its sentence; Stop reaches the bridge', async (t) => {
  const bridge = {
    get: async () => ({ data: { state: 'failed', error: 'The reference clip is silent or damaged.' } }),
    post: async (url) => {
      if (url.endsWith('/start')) { const e = new Error('400'); e.response = { status: 400, data: { error: 'The words are too long. The most is 5000 characters.' } }; throw e; }
      return { data: { ok: true, state: 'cancelled' } };
    },
  };
  const { call, http } = await boot(t, { bridge });
  const r = await call('/open-voices/take', { engine: 'voxcpm', mode: 'design', description: 'd', text: 'x' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'The words are too long. The most is 5000 characters.');
  assert.equal((await call('/open-voices/take/ov_abc123def')).body.error, 'The reference clip is silent or damaged.');
  assert.equal((await call('/open-voices/stop', { jobId: 'ov_abc123def' })).body.state, 'cancelled');
  assert.deepEqual(http.calls.at(-1).body, { secret: 'test-only', jobId: 'ov_abc123def', userId: USER });
});

test('a take still running comes back with its job, so the page can follow it and offer Stop', async (t) => {
  const bridge = {
    get: async () => ({ data: { state: 'running', wait: { spoken: 'Speaking now.' } } }),
    post: async () => { const e = new Error('400'); e.response = { status: 400, data: { error: 'One take at a time. The last one is still being made.', jobId: 'ov_still123' } }; throw e; },
  };
  const { call } = await boot(t, { bridge });
  const r = await call('/open-voices/take', { engine: 'voxcpm', mode: 'design', description: 'd', text: 'x' });
  assert.equal(r.status, 409);
  assert.equal(r.body.jobId, 'ov_still123');
  assert.equal(r.body.error, ov.STILL_MAKING);
});

test('readiness: a bridge that answers with an HTTP error offers nothing; one that cannot be reached offers VoxCPM2', async () => {
  const refuse = (status) => ({ get: async () => { const e = new Error(String(status)); e.response = { status }; throw e; } });
  for (const status of [403, 404, 500]) {
    const read = ov.createReadiness({ http: refuse(status), bridgeBase: () => 'https://bridge.test', secret: () => 's' });
    assert.deepEqual(await read(), { voxcpm: false, ming: false }, String(status));
  }
  const timeout = ov.createReadiness({ http: { get: async () => { const e = new Error('timeout of 4000ms exceeded'); e.code = 'ECONNABORTED'; throw e; } }, bridgeBase: () => 'https://bridge.test', secret: () => 's' });
  assert.deepEqual(await timeout(), { voxcpm: true, ming: false });
});

test('/health never waits long on the bridge: the last answer, or nothing yet, and the cache fills behind it', async () => {
  let release = null;
  let asked = 0;
  const http = { get: () => { asked++; return new Promise((r) => { release = () => r({ data: { enabled: true, engines: { voxcpm: { configured: true }, ming: { configured: true } } } }); }); } };
  const read = ov.createReadiness({ http, bridgeBase: () => 'https://bridge.test', secret: () => 's' });
  const t0 = Date.now();
  const first = await ov.healthBlock(read, 50);
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(first.engines, [], 'nothing known yet');
  const second = ov.healthBlock(read, 2000);
  release();
  assert.deepEqual((await second).engines.map((e) => e.id), ['voxcpm', 'ming']);
  assert.equal(asked, 1, 'one bridge call in flight, shared');
  assert.deepEqual((await ov.healthBlock(read, 50)).engines.map((e) => e.id), ['voxcpm', 'ming'], 'from the cache');
});

test('readiness: from the bridge health, cached; Ming hidden when the bridge cannot say', async () => {
  let n = 0;
  let clock = 0;
  const http = { get: async () => { n++; if (n === 2) throw new Error('down'); return { data: { enabled: true, engines: { voxcpm: { configured: true }, ming: { configured: true } } } }; } };
  const read = ov.createReadiness({ http, bridgeBase: () => 'https://bridge.test', secret: () => 's', now: () => clock });
  assert.deepEqual(await read(), { voxcpm: true, ming: true });
  assert.deepEqual(await read(), { voxcpm: true, ming: true });
  assert.equal(n, 1);
  clock += 61000;
  assert.deepEqual(await read(), { voxcpm: true, ming: false });
  let asked = 0;
  const silent = ov.createReadiness({ http: { get: async () => { asked++; return { data: {} }; } }, bridgeBase: () => 'https://bridge.test', secret: () => '' });
  assert.deepEqual(await silent(), { voxcpm: false, ming: false });
  assert.equal(asked, 0, 'no bridge secret, no call');
  assert.deepEqual((await ov.healthBlock(async () => ({ voxcpm: true, ming: false }))).engines.map((e) => e.id), ['voxcpm']);
});

test('the panel: real labels for every control, no second live region, nothing auto-plays', () => {
  const ids = [...OPEN_VOICES_HTML.matchAll(/<(?:select|textarea|input)[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 8);
  for (const id of ids) assert.match(OPEN_VOICES_HTML, new RegExp(`<label[^>]*for="${id}"`), `${id} has a label`);
  assert.doesNotMatch(OPEN_VOICES_HTML + OPEN_VOICES_SCRIPT, /aria-live|autoplay|\.play\(\)/);
  assert.match(OPEN_VOICES_HTML, />Design a voice</);
  assert.match(OPEN_VOICES_HTML, />Speak with a voice</);
  assert.match(OPEN_VOICES_SCRIPT, /coldSaid/);
  /* By ear: Make is never disabled under her finger, a take's heading nests under Takes, the start
   * line has no long number, and Remove names the voice and asks first. */
  assert.doesNotMatch(OPEN_VOICES_SCRIPT, /\.disabled\s*=/);
  assert.match(OPEN_VOICES_SCRIPT, /createElement\('h4'\)/);
  assert.match(OPEN_VOICES_SCRIPT, /'Making a take\.'/);
  assert.doesNotMatch(OPEN_VOICES_SCRIPT, /Making a take, voice number/);
  assert.match(OPEN_VOICES_SCRIPT, /window\.confirm\('Remove ' \+ nm/);
  assert.match(OPEN_VOICES_SCRIPT, /clipSeconds/);
  assert.doesNotMatch(OPEN_VOICES_HTML, /VoxCPM2 and Ming/, 'the engine names come from the server list');
  const vm = require('node:vm');
  new vm.Script(OPEN_VOICES_SCRIPT.replace(/^\s*<script>|<\/script>\s*$/g, ''));
});

/* ---------- Ming's own controls (worker ming_contract.py) ---------- */

test('checkTake: Ming built-in voice, one control per take, tags and languages; VoxCPM2 refuses them', () => {
  const ready = { voxcpm: true, ming: true };
  assert.deepEqual(ov.checkTake({ engine: 'ming', mode: 'design', voice: 'US_Emma', text: 'Hi' }, ready).body, { engine: 'ming', mode: 'design', text: 'Hi', voice: 'US_Emma' });
  assert.deepEqual(ov.MING_CONTROLS.voices.map((v) => v.value), ['US_Emma', 'UK_George', 'UK_Charlotte', '灵小柔', '灵楷']);
  assert.equal(ov.MING_CONTROLS.tags.length, 14);
  assert.match(ov.checkTake({ engine: 'ming', mode: 'design', voice: 'US_Emma', description: 'warm', text: 'Hi' }, ready).error, /not both/);
  assert.match(ov.checkTake({ engine: 'ming', mode: 'design', text: 'Hi' }, ready).error, /or pick a built-in voice/);
  assert.match(ov.checkTake({ engine: 'ming', mode: 'design', voice: 'Nobody', text: 'Hi' }, ready).error, /Pick a built-in voice/);
  assert.match(ov.checkTake({ engine: 'ming', mode: 'design', description: 'd', emotion: 'sad', text: 'Hi' }, ready).error, /are for Speak with a voice/);
  assert.match(ov.checkTake({ engine: 'ming', mode: 'design', description: 'd', text: 'Hi [Sigh]' }, ready).error, /Sound tags need Speak with a voice/);
  const speak = { engine: 'ming', mode: 'speak', voiceId: '7b0000000000000000000001', text: 'Hi' };
  assert.deepEqual(ov.checkTake({ ...speak, emotion: 'happy', speed: '', language: 'en' }, ready).body, { engine: 'ming', mode: 'clone', text: 'Hi', emotion: 'happy', language: 'en' });
  assert.match(ov.checkTake({ ...speak, voice: 'US_Emma' }, ready).error, /for Design a voice/);
  for (const mix of [{ emotion: 'sad', pitch: 'low' }, { emotion: 'sad', style: 'calm' }, { speed: 'fast', style: 'calm' }]) {
    assert.match(ov.checkTake({ ...speak, ...mix }, ready).error, /one of these per take/, JSON.stringify(mix));
  }
  assert.match(ov.checkTake({ ...speak, text: 'Hi [Sigh]', emotion: 'sad' }, ready).error, /Sound tags work only with no style/);
  assert.match(ov.checkTake({ ...speak, language: 'fr', speed: 'slow' }, ready).error, /^French works only with no style/);
  assert.match(ov.checkTake({ ...speak, text: 'Hi [Yawn]' }, ready).error, /does not know the sound tag \[Yawn\]/);
  assert.match(ov.checkTake({ ...speak, emotion: 'bored' }, ready).error, /Pick an emotion/);
  assert.match(ov.checkTake({ ...speak, engine: 'voxcpm', emotion: 'happy' }, ready).error, /work only with Ming/);
  assert.deepEqual(ov.checkTake({ ...speak, engine: 'voxcpm', text: 'Hi [Yawn]', emotion: '' }, ready).body, { engine: 'voxcpm', mode: 'clone', text: 'Hi [Yawn]' }, 'VoxCPM2 unchanged');
});

test('Ming over the route: tags and far languages need the clip words before any GPU time; the controls reach the bridge', async (t) => {
  const rows = [
    { _id: '7b0000000000000000000001', user: USER, kind: 'audio', url: `${B2}/ming/a.mp3`, metadata: { savedVoice: { name: 'Short', words: 'Hello there.', seconds: 3 } } },
    { _id: '7b0000000000000000000002', user: USER, kind: 'audio', url: `${B2}/ming/b.mp3`, metadata: { savedVoice: { name: 'No words', seconds: 40 } } },
  ];
  const { call, http } = await boot(t, { rows, ready: { voxcpm: true, ming: true } });
  const starts = () => http.calls.filter((c) => c.url.endsWith('/start'));
  const noWords = await call('/open-voices/take', { engine: 'ming', mode: 'speak', voiceId: '7b0000000000000000000002', text: 'Well [Sigh] fine.' });
  assert.equal(noWords.status, 400);
  assert.match(noWords.body.error, /Sound tags need a clip of thirty seconds or less whose words are typed in/);
  const german = await call('/open-voices/take', { engine: 'ming', mode: 'speak', voiceId: '7b0000000000000000000002', text: 'Guten Tag.', language: 'de' });
  assert.match(german.body.error, /^German needs a clip/);
  assert.equal(starts().length, 0, 'refused before the bridge');
  const tagged = await call('/open-voices/take', { engine: 'ming', mode: 'speak', voiceId: '7b0000000000000000000001', text: 'Well [Sigh] fine.', language: 'en' });
  assert.equal(tagged.status, 200);
  assert.equal(starts().at(-1).body.prompt_text, 'Hello there.');
  assert.equal(starts().at(-1).body.language, 'en');
  await call('/open-voices/take', { engine: 'ming', mode: 'speak', voiceId: '7b0000000000000000000002', text: 'Hi', speed: 'slow', volume: 'high' });
  const b = starts().at(-1).body;
  assert.deepEqual([b.speed, b.volume, 'pitch' in b, 'emotion' in b], ['slow', 'high', false, false]);
  await call('/open-voices/take', { engine: 'ming', mode: 'design', voice: 'UK_Charlotte', text: 'Good evening.' });
  assert.deepEqual(starts().at(-1).body, { engine: 'ming', mode: 'design', text: 'Good evening.', voice: 'UK_Charlotte', secret: 'test-only', userId: USER });
  const list = await call('/open-voices');
  assert.equal(list.body.engines.find((e) => e.id === 'ming').controls.tags.length, 14);
  assert.equal('controls' in list.body.engines.find((e) => e.id === 'voxcpm'), false);
});

test('the panel by DOM: Ming controls only with Ming, a tag lands at the cursor, the take sends the controls', async () => {
  const { JSDOM } = require('jsdom');
  const engines = ov.engineList({ voxcpm: true, ming: true });
  const sent = [];
  const dom = new JSDOM(`<!doctype html><body><p id="status" role="status"></p>${OPEN_VOICES_HTML}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.getToken = async () => 'tok';
  w.AbortSignal.timeout = () => undefined;
  w.fetch = async (url, o) => {
    const body = o && o.body ? JSON.parse(o.body) : null;
    if (body) sent.push({ url, body });
    const data = url.endsWith('/open-voices') ? { engines, voices: [{ id: '7b0000000000000000000001', name: 'Grandpa', seconds: 3 }], coldNote: '' } : { error: 'Held for the test.' };
    return { ok: !body, status: body ? 400 : 200, json: async () => data };
  };
  w.eval(OPEN_VOICES_SCRIPT.replace(/^\s*<script>|<\/script>\s*$/g, ''));
  const $ = (id) => w.document.getElementById(id);
  for (let i = 0; i < 20 && $('openVoicesDrawer').hidden; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal($('openVoicesDrawer').hidden, false);
  const pickEngine = (id) => { $('ovEngine').value = id; $('ovEngine').onchange(); };
  pickEngine('voxcpm');
  assert.deepEqual([$('ovMingDesign').hidden, $('ovMingSpeak').hidden, $('ovTagsBox').hidden], [true, true, true], 'VoxCPM2 shows none');
  pickEngine('ming');
  assert.match($('status').textContent, /Ming picked\. You can pick a built-in voice/);
  assert.equal($('ovMingDesign').hidden, false);
  assert.equal($('ovTagsBox').hidden, true, 'tags only in Speak with a voice');
  assert.deepEqual([...$('ovBuiltin').options].map((o) => o.value), ['', 'US_Emma', 'UK_George', 'UK_Charlotte', '灵小柔', '灵楷']);
  $('ovBuiltin').value = 'US_Emma';
  $('ovDescription').value = 'warm';
  $('ovText').value = 'Hello.';
  await $('ovMake').onclick();
  assert.match($('status').textContent, /not both/);
  assert.equal(w.document.activeElement, $('ovDescription'));
  assert.equal(sent.length, 0);
  $('ovModeSpeak').onclick();
  assert.deepEqual([$('ovMingDesign').hidden, $('ovMingSpeak').hidden, $('ovTagsBox').hidden], [true, false, false]);
  assert.equal($('ovTag').options.length, 14);
  /* A tag at the cursor: between the two words, spaced, focus back in the words box after it. */
  $('ovText').value = 'Well fine.';
  $('ovText').focus(); $('ovText').setSelectionRange(4, 4); $('ovText').blur();
  $('ovTag').value = '[Sigh]';
  $('ovInsertTag').onclick();
  assert.equal($('ovText').value, 'Well [Sigh] fine.');
  assert.equal(w.document.activeElement, $('ovText'));
  assert.equal($('ovText').selectionStart, 'Well [Sigh]'.length);
  assert.match($('status').textContent, /Inserted the Sigh tag/);
  $('ovEmotion').value = 'sad'; $('ovSpeed').value = 'fast';
  await $('ovMake').onclick();
  assert.match($('status').textContent, /one of these per take/);
  assert.equal(w.document.activeElement, $('ovEmotion'));
  $('ovSpeed').value = '';
  $('ovVoice').value = '7b0000000000000000000001';
  await $('ovMake').onclick();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { engine: 'ming', mode: 'speak', text: 'Well [Sigh] fine.', seed: '', emotion: 'sad', speed: '', pitch: '', volume: '', language: '', style: '', voiceId: '7b0000000000000000000001' });
  assert.match($('status').textContent, /Held for the test/);
  pickEngine('voxcpm');
  assert.equal($('ovMingSpeak').hidden, true);
  dom.window.close();
});

test('the panel: the Ming controls are labelled and hidden until Ming is picked', () => {
  for (const id of ['ovMingDesign', 'ovMingSpeak', 'ovTagsBox']) assert.match(OPEN_VOICES_HTML, new RegExp(`id="${id}" hidden`));
  for (const id of ['ovBuiltin', 'ovEmotion', 'ovSpeed', 'ovPitch', 'ovVolume', 'ovLanguage', 'ovTag']) assert.match(OPEN_VOICES_HTML, new RegExp(`<label[^>]*for="${id}"`));
  assert.match(OPEN_VOICES_HTML, /Tags need a clip of thirty seconds or less whose words are typed in, and no style/);
  assert.ok(OPEN_VOICES_SCRIPT.includes('/\\s$/'), 'the regex survives the template literal');
});

test('the booth page carries the panel and still parses', () => {
  const { soundBoothHtml } = require('./kadeSoundBoothPage');
  assert.match(soundBoothHtml, /id="openVoicesDrawer" hidden/);
  const vm = require('node:vm');
  for (const m of soundBoothHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
});
