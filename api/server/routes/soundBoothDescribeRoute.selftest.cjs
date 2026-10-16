'use strict';
/* Oct 11 2026: Describe the sound of the recording, the routes (packages/api/src/music/lyrics.ts createLyricsRouter).
 *
 * The real router and the real Mongo model (an in-memory Mongo), with the lyric transcriber and the describer replaced by fakes
 * the test controls: when each answers, whether it fails, whether it hangs. Nothing leaves this process, and no model is called.
 *
 *   - KADE_DESCRIBE_SOUND=0: every answer is byte for byte what a router with no describer sends, the describer is never
 *     called, and POST /reference/describe does not exist.
 *   - On: Transcribe reference lyrics answers with the lyrics and a `direction` (or a plain `direction_note`). A description that
 *     fails, throws, returns nothing or is slow never fails, blocks or delays the lyrics beyond the lyric call.
 *   - The per-recording hold, the cover limit, the ownership check and the cache hold for both routes. The description is kept
 *     with the lyrics, so a second press costs nothing, and a description that finishes late is kept for the next press.
 *
 * Run: node --test api/server/routes/soundBoothDescribeRoute.selftest.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const logs = [];
const dataSchemas = { logger: { info: (line) => logs.push(['info', String(line)]), warn: (line) => logs.push(['warn', String(line)]), error: (line) => logs.push(['error', String(line)]) } };
function lyricsModule() {
  const filename = path.resolve(process.env.LYRICS_SOURCE || path.join(__dirname, '../../../packages/api/src/music/lyrics.ts'));
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = (id) => (id === '@librechat/data-schemas' ? dataSchemas : Module.prototype.require.call(mod, id));
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  return mod.exports;
}
const lyrics = lyricsModule();
const { createLyricsRouter, registerMusicReference } = lyrics;

const WORDS = '[Verse]\nSome made-up words\n\n[Chorus]\nMore made-up words';
const TRANSCRIPT = () => ({ transcript: WORDS, seconds: 30, model: 'gemini-3.8-flash', usage: { inputTokens: 100, outputTokens: 20 } });
const LINE = 'English, folk, mid-tempo, female lead vocal, warm acoustic guitar, soft harmonies';
const SOUND = () => ({ direction: LINE, seconds: 30, model: 'gemini-3.8-flash', usage: { inputTokens: 80, outputTokens: 12 } });
const MISS = 'I could not describe the sound this time; type it yourself.';
const LATE = 'The description of the sound is not ready yet. Choose Describe the sound of the recording in a moment.';
const FAILED = 'I could not describe the sound this time. Your Music direction is kept; type it yourself.';
const RETRY = 'The sound of this recording could not be described a moment ago. Try again in half a minute, or type the direction yourself.';
const NO_WORDS = 'No clear words were detected. Your existing lyrics are kept.';
const WORKED_ON = 'This recording is already being worked on. Wait for it to finish.';
const TRANSCRIBING = 'This recording is already being transcribed. Wait for it to finish.';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  const out = {};
  out.promise = new Promise((resolve, reject) => { out.resolve = resolve; out.reject = reject; });
  return out;
};

let mongo, downloads = 0;
let serial = 0;
const apps = [];
const BYTES = Buffer.from('ID3fixture audio');

/** A router with fake hooks. `describe: false` leaves the hook out, as a server without the feature has it. */
async function rig({ describe = true, wait, env } = {}) {
  const control = {
    duration: 30,
    transcribeCalls: [],
    describeCalls: [],
    transcribe: async () => TRANSCRIPT(),
    describe: async () => SOUND(),
  };
  const hooks = {
    auth: (_req, _res, next) => next(),
    user: (req) => String(req.headers['x-user'] || 'a'),
    savedSources: async () => [],
    refresh: async (url) => url,
    duration: async () => control.duration,
    transcribe: async (...args) => { control.transcribeCalls.push(args); return control.transcribe(...args); },
    ...(describe ? { describe: async (...args) => { control.describeCalls.push(args); return control.describe(...args); } } : {}),
    ...(wait ? { describeWait: wait } : {}),
  };
  const app = express();
  app.use(createLyricsRouter(hooks));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  apps.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, user = 'a') => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': user }, body: JSON.stringify(body) });
  const read = async (response) => ({ status: response.status, text: await response.clone().text(), json: await response.json().catch(() => undefined) });
  /** A recording owned by a fresh account, so no scenario reads another's cache. */
  const recording = async (label) => {
    const user = `${label}-${++serial}`;
    const url = `https://assets.test/${user}.mp3`;
    await registerMusicReference(user, url);
    return { user, url };
  };
  return { control, post, read, recording, env };
}

function withEnv(value, run) {
  return async () => {
    const saved = process.env.KADE_DESCRIBE_SOUND;
    if (value === undefined) delete process.env.KADE_DESCRIBE_SOUND;
    else process.env.KADE_DESCRIBE_SOUND = value;
    try { return await run(); } finally {
      if (saved === undefined) delete process.env.KADE_DESCRIBE_SOUND;
      else process.env.KADE_DESCRIBE_SOUND = saved;
    }
  };
}

test('Describe the sound: the routes', async (t) => {
  const savedEnv = process.env.KADE_DESCRIBE_SOUND;
  delete process.env.KADE_DESCRIBE_SOUND;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await mongoose.model('KadeMusicReference').init();
  axios.defaults.adapter = async (config) => {
    if (!String(config.url).startsWith('https://assets.test/')) throw new Error(`unexpected call to ${config.url}`);
    downloads++;
    assert.equal(config.maxRedirects, 0);
    return { data: BYTES, status: 200, statusText: 'OK', headers: { 'content-type': 'audio/mpeg' }, config };
  };
  t.after(async () => {
    for (const server of apps) { server.closeAllConnections(); server.close(); }
    await mongoose.disconnect();
    await mongo.stop();
    if (savedEnv === undefined) delete process.env.KADE_DESCRIBE_SOUND;
    else process.env.KADE_DESCRIBE_SOUND = savedEnv;
  });
  const Rows = mongoose.model('KadeMusicReference');
  const rowOf = (user) => Rows.findOne({ user }).lean();

  await t.test('off switch: KADE_DESCRIBE_SOUND=0 answers byte for byte as a router with no describer, and the describe route is not there', withEnv('0', async () => {
    const plain = await rig({ describe: false });
    const off = await rig({ describe: true });
    const asked = [];
    for (const [name, make] of [
      ['fresh', async (r, who) => r.post('/reference/lyrics', { url: who.url, describe: true }, who.user)],
      ['cached', async (r, who) => r.post('/reference/lyrics', { url: who.url, describe: true }, who.user)],
      ['not owned', async (r, who) => r.post('/reference/lyrics', { url: who.url, describe: true }, 'someone-else')],
      ['bad body', async (r) => r.post('/reference/lyrics', { url: 'http://localhost' })],
      ['no body', async (r) => r.post('/reference/lyrics', {})],
    ]) {
      const whoPlain = name === 'cached' ? asked[0] : await plain.recording('plain');
      const whoOff = name === 'cached' ? asked[1] : await off.recording('off');
      if (name === 'fresh') asked.push(whoPlain, whoOff);
      const a = await plain.read(await make(plain, whoPlain));
      const b = await off.read(await make(off, whoOff));
      assert.equal(a.status, b.status, name);
      assert.equal(b.text, a.text, `${name}: the same bytes`);
      assert.doesNotMatch(b.text, /direction/, name);
    }
    assert.equal(off.control.describeCalls.length, 0, 'the describer is never called');
    assert.equal(off.control.transcribeCalls.length, 1);
    const who = await off.recording('off-describe');
    const gone = await off.read(await off.post('/reference/describe', { url: who.url }, who.user));
    const goneBase = await plain.read(await plain.post('/reference/describe', { url: who.url }, who.user));
    assert.equal(gone.status, 404);
    assert.equal(gone.text, goneBase.text, 'a route that does not exist answers as a route that does not exist');
    assert.equal(off.control.describeCalls.length, 0);
    assert.equal((await rowOf(who.user)).sound, undefined, 'nothing is kept');
  }));

  await t.test('off switch: with a describer but the feature flag unset to 1 or anything else, it is on', withEnv('1', async () => {
    const on = await rig();
    const who = await on.recording('flag-one');
    const got = await on.read(await on.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
    assert.equal(got.json.direction, LINE);
  }));

  await t.test('on, both work: the lyrics and the description, in one answer; both are kept; a second press costs nothing', withEnv(undefined, async () => {
    const r = await rig();
    const who = await r.recording('both');
    const first = await r.read(await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
    assert.equal(first.status, 200);
    assert.equal(first.json.transcript, WORDS);
    assert.equal(first.json.cached, false);
    assert.equal(first.json.model, 'gemini-3.8-flash');
    assert.deepEqual(first.json.usage, { inputTokens: 100, outputTokens: 20 });
    assert.match(first.json.warning, /wrong or missing words/);
    assert.equal(first.json.direction, LINE);
    assert.deepEqual(first.json.direction_usage, { inputTokens: 80, outputTokens: 12 }, 'what the extra call cost is in the same answer');
    assert.equal(first.json.direction_note, undefined);
    assert.equal(r.control.transcribeCalls.length, 1);
    assert.equal(r.control.describeCalls.length, 1);
    const [t1, d1] = [r.control.transcribeCalls[0], r.control.describeCalls[0]];
    assert.deepEqual([d1[0].toString(), d1[1], d1[2]], [t1[0].toString(), t1[1], t1[2]], 'the same recording, type and length go to both');
    assert.equal(t1[0].toString(), 'ID3fixture audio');
    const row = await rowOf(who.user);
    assert.equal(row.sound.direction, LINE);
    assert.equal(row.soundVersion, 'mimo26-sound-v2');
    const second = await r.read(await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
    assert.equal(second.json.cached, true);
    assert.equal(second.json.direction, LINE);
    assert.equal(second.json.transcript, WORDS);
    assert.equal(r.control.transcribeCalls.length, 1);
    assert.equal(r.control.describeCalls.length, 1, 'no second call is paid for');
    assert.equal(downloads > 0, true);
  }));

  await t.test('the description is optional: null, a throw, a rejection and an empty line all still give the lyrics, with a plain note', withEnv(undefined, async () => {
    for (const [label, make] of [
      ['null', async () => null],
      ['a throw', () => { throw new Error('describer exploded'); }],
      ['a rejection', async () => { throw new Error('provider down'); }],
      ['an empty line', async () => ({ direction: '   ', seconds: 30, model: 'm' })],
    ]) {
      const r = await rig();
      r.control.describe = make;
      const who = await r.recording('optional');
      const got = await r.read(await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
      assert.equal(got.status, 200, label);
      assert.equal(got.json.transcript, WORDS, label);
      assert.equal(got.json.direction, undefined, label);
      assert.equal(got.json.direction_note, MISS, label);
      const row = await rowOf(who.user);
      assert.equal(row.transcript.transcript, WORDS, `${label}: the lyrics are kept`);
      assert.equal(row.sound, undefined, `${label}: no description is kept`);
    }
    assert.ok(logs.some(([level, line]) => level === 'warn' && /sound describe hook failed reason=error:describer exploded/.test(line)));
  }));

  await t.test('a slow description never delays the lyrics: they go out when the lyric call ends, and the description is kept for the next press', withEnv(undefined, async () => {
    const r = await rig();
    const late = deferred();
    r.control.describe = () => late.promise;
    const who = await r.recording('slow');
    const began = Date.now();
    const got = await r.read(await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
    assert.ok(Date.now() - began < 1500, `lyrics went out in ${Date.now() - began} ms`);
    assert.equal(got.status, 200);
    assert.equal(got.json.transcript, WORDS);
    assert.equal(got.json.direction, undefined);
    assert.equal(got.json.direction_note, LATE);
    assert.equal(r.control.describeCalls.length, 1);
    assert.equal((await rowOf(who.user)).leaseUntil, undefined, 'the hold is released');
    /* the explicit button while it is still running joins it: no second call */
    const joined = r.post('/reference/describe', { url: who.url }, who.user);
    await sleep(60);
    late.resolve(SOUND());
    const answered = await r.read(await joined);
    assert.equal(answered.status, 200);
    assert.equal(answered.json.direction, LINE);
    assert.equal(r.control.describeCalls.length, 1, 'joined, not paid twice');
    await sleep(60);
    assert.equal((await rowOf(who.user)).sound.direction, LINE, 'kept when it finished');
    const again = await r.read(await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
    assert.equal(again.json.cached, true);
    assert.equal(again.json.direction, LINE);
    assert.equal(r.control.describeCalls.length, 1);
  }));

  await t.test('a description that never finishes does not hold the lyrics, and it is only waited for when asked to', withEnv(undefined, async () => {
    const r = await rig();
    r.control.describe = () => new Promise(() => {});
    const who = await r.recording('hung');
    const began = Date.now();
    const got = await r.read(await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
    assert.ok(Date.now() - began < 1500);
    assert.equal(got.json.transcript, WORDS);
    assert.equal(got.json.direction_note, LATE);
    const patient = await rig({ wait: { afterLyricsMs: 250 } });
    patient.control.describe = async () => { await sleep(80); return SOUND(); };
    patient.control.transcribe = async () => TRANSCRIPT();
    const other = await patient.recording('patient');
    const waited = await patient.read(await patient.post('/reference/lyrics', { url: other.url, describe: true }, other.user));
    assert.equal(waited.json.direction, LINE, 'a short wait (a test seam; the shipped wait is none) picks up a description that is nearly ready');
  }));

  await t.test('a description that is ready before the lyrics is used even when the lyric call is also quick', withEnv(undefined, async () => {
    const r = await rig();
    r.control.transcribe = async () => { await sleep(120); return TRANSCRIPT(); };
    const who = await r.recording('quick');
    const got = await r.read(await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
    assert.equal(got.json.direction, LINE);
  }));

  await t.test('lyrics that fail: the old sentences, and a description that worked is still kept for the button', withEnv(undefined, async () => {
    const r = await rig();
    r.control.transcribe = async () => { throw new Error('both transcribers down'); };
    const who = await r.recording('lyricfail');
    const got = await r.read(await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
    assert.equal(got.status, 502);
    assert.deepEqual(got.json, { error: 'Could not transcribe this recording. Your existing lyrics are kept. Try a clearer recording or type the words.' });
    await sleep(80);
    const row = await rowOf(who.user);
    assert.equal(row.transcript, undefined);
    assert.equal(row.leaseUntil, undefined);
    assert.equal(row.sound.direction, LINE, 'the description was paid for, so it is kept');
    const button = await r.read(await r.post('/reference/describe', { url: who.url }, who.user));
    assert.equal(button.json.direction, LINE);
    assert.equal(button.json.cached, true);
    assert.equal(r.control.describeCalls.length, 1);

    const quiet = await rig();
    quiet.control.transcribe = async () => ({ transcript: '   ', seconds: 30, model: 'scribe_v2' });
    const instrumental = await quiet.recording('instrumental');
    const none = await quiet.read(await quiet.post('/reference/lyrics', { url: instrumental.url, describe: true }, instrumental.user));
    assert.equal(none.status, 422);
    assert.deepEqual(none.json, { error: `${NO_WORDS} To hear what it sounds like instead, choose Describe the sound of the recording.` }, 'an instrumental is pointed to the button that suits it');
    await sleep(60);
    assert.equal((await rowOf(instrumental.user)).sound.direction, LINE);
    /* the same answer without the opt-in is the old sentence alone, and no description is made */
    const old = await rig();
    old.control.transcribe = async () => ({ transcript: '   ', seconds: 30, model: 'scribe_v2' });
    const bare = await old.recording('instrumental-old');
    const oldNone = await old.read(await old.post('/reference/lyrics', { url: bare.url }, bare.user));
    assert.equal(oldNone.status, 422);
    assert.deepEqual(oldNone.json, { error: NO_WORDS });
    assert.equal(old.control.describeCalls.length, 0);
  }));

  await t.test('the hold: two presses at once make one transcription and one description; the second is told to wait', withEnv(undefined, async () => {
    const r = await rig();
    const gate = deferred();
    r.control.transcribe = async () => { await gate.promise; return TRANSCRIPT(); };
    const who = await r.recording('twice');
    const first = r.post('/reference/lyrics', { url: who.url, describe: true }, who.user);
    await sleep(120);
    const second = await r.read(await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
    assert.equal(second.status, 409);
    assert.deepEqual(second.json, { error: WORKED_ON }, 'a press that asks for a description is not told it is being "transcribed": the hold may be a description');
    /* a press without the opt-in (an app) is told the old sentence */
    const bare = await r.read(await r.post('/reference/lyrics', { url: who.url }, who.user));
    assert.equal(bare.status, 409);
    assert.deepEqual(bare.json, { error: TRANSCRIBING });
    gate.resolve();
    const done = await r.read(await first);
    assert.equal(done.status, 200);
    assert.equal(done.json.direction, LINE);
    assert.equal(r.control.transcribeCalls.length, 1);
    assert.equal(r.control.describeCalls.length, 1);
  }));

  await t.test('the cover limit, ownership and the bad request are answered as they always were, before any call', withEnv(undefined, async () => {
    const r = await rig();
    const who = await r.recording('limits');
    r.control.duration = 361;
    const tooLong = await r.read(await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.json.error, /6 minutes 1 seconds long\. Covers support up to 6 minutes/);
    r.control.duration = null;
    const unreadable = await r.read(await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
    assert.equal(unreadable.status, 400);
    assert.match(unreadable.json.error, /could not be read/);
    r.control.duration = 30;
    assert.equal((await r.post('/reference/lyrics', { url: who.url, describe: true }, 'stranger')).status, 404);
    assert.equal((await r.post('/reference/lyrics', { url: 'http://localhost' }, who.user)).status, 400);
    assert.equal((await r.post('/reference/lyrics', { url: 'https://127.0.0.1/private', describe: true }, who.user)).status, 404);
    assert.equal((await r.post('/reference/lyrics', {}, who.user)).status, 400);
    assert.equal(r.control.transcribeCalls.length, 0);
    assert.equal(r.control.describeCalls.length, 0, 'a refused recording is never sent to the describer');
    assert.equal((await rowOf(who.user)).leaseUntil, undefined);
  }));

  await t.test('lyrics already kept from before the feature: the press says the lyrics are cached at once, and the description is made and kept behind it', withEnv(undefined, async () => {
    /* the lyrics were kept by an app that does not ask for a description (no opt-in), so there is no description yet */
    const r = await rig();
    const who = await r.recording('before');
    const plainFirst = await r.read(await r.post('/reference/lyrics', { url: who.url }, who.user));
    assert.equal(plainFirst.json.cached, false);
    assert.equal(plainFirst.json.direction, undefined, 'no opt-in, no description key');
    assert.equal(r.control.describeCalls.length, 0, 'no opt-in, nothing paid for');
    /* the page's press: the lyrics are cached, the description is only the new part. It is not waited for beyond the lyrics:
     * the answer is at once, whatever the describer is doing */
    const late = deferred();
    r.control.describe = () => late.promise;
    const began = Date.now();
    const alone = await r.read(await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
    assert.ok(Date.now() - began < 1500, `answered in ${Date.now() - began} ms`);
    assert.equal(alone.json.cached, true);
    assert.equal(alone.json.transcript, WORDS);
    assert.equal(alone.json.direction, undefined);
    assert.equal(alone.json.direction_note, LATE);
    assert.equal(r.control.transcribeCalls.length, 1, 'the lyrics are not paid for again');
    assert.equal(r.control.describeCalls.length, 1);
    /* another press while it runs does not fetch the recording again or start a second call */
    const fetched = downloads;
    const again = await r.read(await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
    assert.equal(again.json.direction_note, LATE);
    assert.equal(downloads, fetched, 'no second download while the description is being made');
    assert.equal(r.control.describeCalls.length, 1);
    /* it finishes, is kept, and the next press has everything */
    late.resolve(SOUND());
    await sleep(80);
    assert.equal((await rowOf(who.user)).sound.direction, LINE);
    const done = await r.read(await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
    assert.equal(done.json.cached, true);
    assert.equal(done.json.direction, LINE);
    assert.equal(r.control.describeCalls.length, 1);

    /* a describer that answers at once is picked up in the same answer */
    const quick = await rig();
    const fast = await quick.recording('before-fast');
    await quick.post('/reference/lyrics', { url: fast.url }, fast.user);
    const picked = await quick.read(await quick.post('/reference/lyrics', { url: fast.url, describe: true }, fast.user));
    assert.equal(picked.json.cached, true);
    assert.equal(picked.json.direction, LINE);

    /* the wait is a seam: given time, a describer that is nearly ready is waited for; a hung one is not */
    const patient = await rig({ wait: { aloneMs: 400 } });
    const slowOne = await patient.recording('before-patient');
    await patient.post('/reference/lyrics', { url: slowOne.url }, slowOne.user);
    patient.control.describe = async () => { await sleep(80); return SOUND(); };
    const waited = await patient.read(await patient.post('/reference/lyrics', { url: slowOne.url, describe: true }, slowOne.user));
    assert.equal(waited.json.direction, LINE);
    const hung = await rig({ wait: { aloneMs: 100 } });
    const other = await hung.recording('before-hung');
    await hung.post('/reference/lyrics', { url: other.url }, other.user);
    hung.control.describe = () => new Promise(() => {});
    const began2 = Date.now();
    const bounded = await hung.read(await hung.post('/reference/lyrics', { url: other.url, describe: true }, other.user));
    assert.ok(Date.now() - began2 < 1500);
    assert.equal(bounded.json.cached, true);
    assert.equal(bounded.json.transcript, WORDS);
    assert.equal(bounded.json.direction_note, LATE);

    /* an old version of the kept description counts as none */
    const stale = await rig();
    const old = await stale.recording('stale');
    await stale.post('/reference/lyrics', { url: old.url, describe: true }, old.user);
    await Rows.updateOne({ user: old.user }, { $set: { soundVersion: 'an-older-version' } });
    const refreshed = await stale.read(await stale.post('/reference/lyrics', { url: old.url, describe: true }, old.user));
    assert.equal(refreshed.json.direction, LINE);
    assert.equal(stale.control.describeCalls.length, 2);
    assert.equal((await rowOf(old.user)).soundVersion, 'mimo26-sound-v2');
  }));

  await t.test('a description kept but lyrics not: the lyrics are made, the kept description is not paid for again', withEnv(undefined, async () => {
    const r = await rig();
    const who = await r.recording('soundonly');
    r.control.transcribe = async () => { throw new Error('down'); };
    assert.equal((await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user)).status, 502);
    await sleep(80);
    r.control.transcribe = async () => TRANSCRIPT();
    const got = await r.read(await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
    assert.equal(got.json.transcript, WORDS);
    assert.equal(got.json.cached, false);
    assert.equal(got.json.direction, LINE);
    assert.equal(r.control.describeCalls.length, 1);
    assert.equal(r.control.transcribeCalls.length, 2);
  }));

  await t.test('the Describe button route: the line, its cost, kept, and free the second time', withEnv(undefined, async () => {
    const r = await rig();
    const who = await r.recording('button');
    const first = await r.read(await r.post('/reference/describe', { url: who.url }, who.user));
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, { direction: LINE, direction_usage: { inputTokens: 80, outputTokens: 12 }, cached: false });
    const second = await r.read(await r.post('/reference/describe', { url: who.url }, who.user));
    assert.deepEqual(second.json, { direction: LINE, direction_usage: { inputTokens: 80, outputTokens: 12 }, cached: true });
    assert.equal(r.control.describeCalls.length, 1);
    assert.equal(r.control.transcribeCalls.length, 0, 'it never transcribes');
    assert.equal((await rowOf(who.user)).transcript, undefined, 'and keeps no lyrics');
    assert.equal((await rowOf(who.user)).leaseUntil, undefined);
    /* the lyrics button then finds the description already there */
    const lyricsAfter = await r.read(await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
    assert.equal(lyricsAfter.json.direction, LINE);
    assert.equal(r.control.describeCalls.length, 1);
  }));

  await t.test('the Describe button route: a failure is a plain sentence, nothing is kept, and the hold is released for another try', withEnv(undefined, async () => {
    for (const make of [async () => null, () => { throw new Error('boom'); }, async () => { throw new Error('boom'); }]) {
      const r = await rig({ wait: { missButtonMs: 0 } }); /* no cool-down, so the retry is immediate (the cool-down has its own test) */
      r.control.describe = make;
      const who = await r.recording('buttonfail');
      const failed = await r.read(await r.post('/reference/describe', { url: who.url }, who.user));
      assert.equal(failed.status, 502);
      assert.deepEqual(failed.json, { error: FAILED });
      const row = await rowOf(who.user);
      assert.equal(row.sound, undefined);
      assert.equal(row.leaseUntil, undefined);
      r.control.describe = async () => SOUND();
      const retry = await r.read(await r.post('/reference/describe', { url: who.url }, who.user));
      assert.equal(retry.status, 200);
      assert.equal(retry.json.direction, LINE);
    }
  }));

  await t.test('the Describe button route shares the lookup, ownership, cover limit and hold of the transcriber', withEnv(undefined, async () => {
    const r = await rig();
    const who = await r.recording('buttonlimits');
    assert.equal((await r.post('/reference/describe', {}, who.user)).status, 400);
    assert.equal((await r.read(await r.post('/reference/describe', { url: 'http://localhost' }, who.user))).json.error, 'Import a cover recording first.');
    const stranger = await r.read(await r.post('/reference/describe', { url: who.url }, 'stranger'));
    assert.equal(stranger.status, 404);
    assert.deepEqual(stranger.json, { error: 'That recording is not saved on your account. Import it again.' });
    assert.equal((await r.post('/reference/describe', { url: 'https://127.0.0.1/private' }, who.user)).status, 404);
    r.control.duration = 361;
    const tooLong = await r.read(await r.post('/reference/describe', { url: who.url }, who.user));
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.json.error, /Covers support up to 6 minutes/);
    r.control.duration = 30;
    assert.equal(r.control.describeCalls.length, 0);
    /* held by a transcription that has no description in flight: the button waits its turn */
    const held = await rig({ wait: { missButtonMs: 0 } }); /* the transcription's own description missed; no cool-down here, so the hold is what answers */
    held.control.describe = async () => null;
    const gate = deferred();
    held.control.transcribe = async () => { await gate.promise; return TRANSCRIPT(); };
    const other = await held.recording('buttonheld');
    const running = held.post('/reference/lyrics', { url: other.url, describe: true }, other.user);
    await sleep(120);
    const waiting = await held.read(await held.post('/reference/describe', { url: other.url }, other.user));
    assert.equal(waiting.status, 409);
    assert.deepEqual(waiting.json, { error: 'This recording is already being worked on. Wait for it to finish.' });
    gate.resolve();
    assert.equal((await running).status, 200);
    assert.equal((await rowOf(other.user)).leaseUntil, undefined);
  }));

  await t.test('two Describe presses at once make one call', withEnv(undefined, async () => {
    const r = await rig();
    const gate = deferred();
    r.control.describe = async () => { await gate.promise; return SOUND(); };
    const who = await r.recording('buttontwice');
    const a = r.post('/reference/describe', { url: who.url }, who.user);
    await sleep(120);
    const b = r.post('/reference/describe', { url: who.url }, who.user);
    await sleep(60);
    gate.resolve();
    const [one, two] = await Promise.all([r.read(await a), r.read(await b)]);
    assert.equal(one.json.direction, LINE);
    assert.equal(two.json.direction, LINE);
    assert.equal(r.control.describeCalls.length, 1);
  }));

  await t.test('an account never sees another account\'s description, and the logs carry no key', withEnv(undefined, async () => {
    const r = await rig();
    const mine = await r.recording('mine');
    await r.post('/reference/describe', { url: mine.url }, mine.user);
    const theirs = await r.recording('theirs');
    r.control.describe = async () => null;
    const miss = await r.read(await r.post('/reference/lyrics', { url: theirs.url, describe: true }, theirs.user));
    assert.equal(miss.json.direction, undefined);
    assert.equal((await r.post('/reference/describe', { url: mine.url }, theirs.user)).status, 404);
    assert.ok(logs.every(([, line]) => !/key|secret/i.test(line) || /could not be kept|hook failed/.test(line)));
  }));

  await t.test('an app that does not ask for a description (no opt-in) is answered byte for byte as a router with no describer, and pays and waits for nothing', withEnv(undefined, async () => {
    const plain = await rig({ describe: false });
    const on = await rig();
    const who = await plain.recording('plain');
    const ours = await on.recording('ours');
    const old = await plain.read(await plain.post('/reference/lyrics', { url: who.url }, who.user));
    const fresh = await on.read(await on.post('/reference/lyrics', { url: ours.url }, ours.user));
    assert.equal(fresh.status, old.status);
    assert.equal(fresh.text, old.text, 'the first press: the same bytes');
    assert.doesNotMatch(fresh.text, /direction/);
    const oldCached = await plain.read(await plain.post('/reference/lyrics', { url: who.url }, who.user));
    const cached = await on.read(await on.post('/reference/lyrics', { url: ours.url }, ours.user));
    assert.equal(cached.text, oldCached.text, 'the second press: the same bytes');
    assert.equal(on.control.describeCalls.length, 0, 'nothing was paid for');

    /* even with a description already kept (made by the button), the lyric answer for an app does not grow a key */
    const kept = await on.recording('kept');
    assert.equal((await on.post('/reference/describe', { url: kept.url }, kept.user)).status, 200);
    const callsBefore = on.control.describeCalls.length;
    const keptPress = await on.read(await on.post('/reference/lyrics', { url: kept.url }, kept.user));
    assert.equal(keptPress.text, old.text);
    const keptAgain = await on.read(await on.post('/reference/lyrics', { url: kept.url }, kept.user));
    assert.equal(keptAgain.text, oldCached.text);
    assert.equal(on.control.describeCalls.length, callsBefore);

    /* only the boolean true asks: a string, a number or anything else does not */
    for (const asked of ['true', 1, 'yes', null, [], {}, false]) {
      const other = await on.recording('not-asked');
      const got = await on.read(await on.post('/reference/lyrics', { url: other.url, describe: asked }, other.user));
      assert.equal(got.text, old.text, `describe: ${JSON.stringify(asked)}`);
    }
    assert.equal(on.control.describeCalls.length, callsBefore, 'none of them paid for a description');

    /* the same press with the opt-in does get it */
    const asks = await on.recording('asks');
    const got = await on.read(await on.post('/reference/lyrics', { url: asks.url, describe: true }, asks.user));
    assert.equal(got.json.direction, LINE);
  }));

  await t.test('a recording whose description fails is not paid for, or downloaded, again on every press', withEnv(undefined, async () => {
    const r = await rig();
    r.control.describe = async () => null;
    const who = await r.recording('missed');
    const first = await r.read(await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
    assert.equal(first.json.direction_note, MISS);
    await sleep(60);
    const row = await rowOf(who.user);
    assert.equal(row.sound, undefined);
    assert.equal(row.soundMiss.version, 'mimo26-sound-v2');
    assert.ok(Date.now() - new Date(row.soundMiss.at).getTime() < 5000, 'the moment of the failure is kept with the recording');
    const fetched = downloads;
    for (let press = 0; press < 5; press += 1) {
      const again = await r.read(await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
      assert.equal(again.status, 200);
      assert.equal(again.json.cached, true);
      assert.equal(again.json.transcript, WORDS);
      assert.equal(again.json.direction_note, MISS, 'the plain note, at once');
    }
    assert.equal(r.control.transcribeCalls.length, 1);
    assert.equal(r.control.describeCalls.length, 1, 'five more presses paid for nothing');
    assert.equal(downloads, fetched, 'and fetched nothing');
    /* the button honours a short cool-down: a double press is stopped, with a plain sentence */
    const button = await r.read(await r.post('/reference/describe', { url: who.url }, who.user));
    assert.equal(button.status, 429);
    assert.deepEqual(button.json, { error: RETRY });
    assert.equal(r.control.describeCalls.length, 1);
    assert.equal(downloads, fetched);
    assert.equal((await rowOf(who.user)).leaseUntil, undefined, 'no hold is left behind');

    /* the window ends: 20 minutes on, a Transcribe press tries again; a success clears the failure and keeps the line */
    await Rows.updateOne({ user: who.user }, { $set: { 'soundMiss.at': new Date(Date.now() - 20 * 60 * 1000) } });
    r.control.describe = async () => SOUND();
    const later = await r.read(await r.post('/reference/lyrics', { url: who.url, describe: true }, who.user));
    assert.equal(later.json.cached, true);
    assert.equal(later.json.direction, LINE);
    assert.equal(r.control.describeCalls.length, 2);
    await sleep(40);
    const healed = await rowOf(who.user);
    assert.equal(healed.sound.direction, LINE);
    assert.equal(healed.soundMiss, undefined, 'a success forgets the failure');

    /* the button's own window is short: 31 seconds on, it tries again; inside it, it does not */
    const other = await r.recording('missed-button');
    r.control.describe = async () => null;
    assert.equal((await r.post('/reference/describe', { url: other.url }, other.user)).status, 502);
    await sleep(60);
    assert.equal((await rowOf(other.user)).soundMiss.version, 'mimo26-sound-v2', 'a failure on the button is remembered too');
    r.control.describe = async () => SOUND();
    const calls = r.control.describeCalls.length;
    assert.equal((await r.post('/reference/describe', { url: other.url }, other.user)).status, 429);
    assert.equal(r.control.describeCalls.length, calls);
    await Rows.updateOne({ user: other.user }, { $set: { 'soundMiss.at': new Date(Date.now() - 31 * 1000) } });
    const retried = await r.read(await r.post('/reference/describe', { url: other.url }, other.user));
    assert.equal(retried.status, 200);
    assert.equal(retried.json.direction, LINE);

    /* a failure noted under an older describer version is forgotten */
    const versioned = await r.recording('missed-version');
    r.control.describe = async () => null;
    await r.post('/reference/describe', { url: versioned.url }, versioned.user);
    await sleep(60);
    await Rows.updateOne({ user: versioned.user }, { $set: { 'soundMiss.version': 'an-older-version' } });
    r.control.describe = async () => SOUND();
    assert.equal((await r.post('/reference/describe', { url: versioned.url }, versioned.user)).status, 200);

    /* the windows are seams: with none, every press tries (the old behaviour of a retry) */
    const eager = await rig({ wait: { missAutoMs: 0, missButtonMs: 0 } });
    eager.control.describe = async () => null;
    const again = await eager.recording('eager');
    await eager.post('/reference/lyrics', { url: again.url, describe: true }, again.user);
    await sleep(60);
    await eager.post('/reference/lyrics', { url: again.url, describe: true }, again.user);
    await sleep(60);
    await eager.post('/reference/describe', { url: again.url }, again.user);
    assert.equal(eager.control.describeCalls.length >= 3, true);
  }));

  await t.test('a description that never finishes is given up on at its deadline: the plain failure, the hold released, the failure kept, no press stuck behind it', withEnv(undefined, async () => {
    const r = await rig({ wait: { deadlineMs: 80, missButtonMs: 0 } });
    r.control.describe = () => new Promise(() => {});
    const who = await r.recording('deadline');
    const began = Date.now();
    const got = await r.read(await r.post('/reference/describe', { url: who.url }, who.user));
    const took = Date.now() - began;
    assert.equal(got.status, 502);
    assert.deepEqual(got.json, { error: FAILED });
    assert.ok(took >= 60 && took < 2000, `gave up after ${took} ms`);
    await sleep(60);
    const row = await rowOf(who.user);
    assert.equal(row.leaseUntil, undefined);
    assert.equal(row.sound, undefined);
    assert.equal(row.soundMiss.version, 'mimo26-sound-v2');
    assert.ok(logs.some(([level, line]) => level === 'warn' && /sound describe passed its deadline of 80 ms/.test(line)));
    /* the next press is a fresh call, not a join onto the hung one */
    r.control.describe = async () => SOUND();
    const retry = await r.read(await r.post('/reference/describe', { url: who.url }, who.user));
    assert.equal(retry.status, 200);
    assert.equal(retry.json.direction, LINE);
    assert.equal(r.control.describeCalls.length, 2);

    /* through a Transcribe press: the lyrics are never held, and later presses are not held either */
    const t2 = await rig({ wait: { deadlineMs: 80 } });
    t2.control.describe = () => new Promise(() => {});
    const other = await t2.recording('deadline-lyrics');
    const began2 = Date.now();
    const first = await t2.read(await t2.post('/reference/lyrics', { url: other.url, describe: true }, other.user));
    assert.ok(Date.now() - began2 < 1500);
    assert.equal(first.json.transcript, WORDS);
    assert.equal(first.json.direction_note, LATE);
    await sleep(200);
    const second = await t2.read(await t2.post('/reference/lyrics', { url: other.url, describe: true }, other.user));
    assert.equal(second.json.cached, true);
    assert.equal(second.json.direction_note, MISS, 'the hung call is over; the plain note, at once');
    assert.equal(t2.control.describeCalls.length, 1);
  }));
});
