/* Cover this take on an ACE-Step XL take, end to end through the code that decides (Oct 10 2026).
 *
 * The real YuE2 router (yue.ts on audio/jobs.ts) and the real cover check (lyrics.ts validateMusicReference with the real
 * ownership rules of speech/edit.ts) on an in-memory Mongo, RunPod and the storage download stood in by an axios adapter that
 * enforces maxContentLength the way axios does. The assets are shaped as the ACE complete hook saves them: url is the MP3,
 * metadata.wavUrl the 24-bit 48 kHz WAV master. Nothing leaves this process. The page attaches an ACE take's MP3
 * (soundBoothAce.selftest.cjs proves it); this proves why, and what else the check does:
 *
 *   - an ACE take is a valid YuE2 cover source: its MP3 and its WAV master are owned by the account that made it, a
 *     re-signed library link is too, and another person's take is refused before anything is downloaded;
 *   - FINDING A (20 MB): the booth measures a recording it has no length for by downloading it under a twenty megabyte cap. An ACE WAV
 *     master (288 kB a second) is over the cap past 72 seconds, so a cover started from the WAV fails with "Could not check the cover
 *     recording"; the 320k MP3 (40 kB a second) fits up to eight minutes. The same cap applies to a YuE2 take's WAV master. It is
 *     reported, not changed, here;
 *   - FINDING B (six minutes): a cover is limited to 360 seconds. An ACE take made at 6:00 can measure a hair over (MP3 padding)
 *     and be refused; a take of 5:59 or less is not.
 * Run: node api/server/routes/kadeSoundBoothAceCover.selftest.cjs (through run-booth-tests.sh for NODE_PATH). */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const ts = require('typescript'), express = require('express'), axios = require('axios'), mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const SRC = path.resolve(__dirname, '../../../packages/api/src/');
function source(relative) {
  const filename = path.join(SRC, relative + '.ts');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = (id) => (id === '@librechat/data-schemas' ? { logger: { info() {}, warn() {}, error() {} } } : Module.prototype.require.call(mod, id));
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  return mod.exports;
}
require.extensions['.ts'] = (mod, filename) =>
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { validateMusicReference, musicReferenceError } = source('music/lyrics');
const { isOwnedAudioReference } = source('speech/edit');
const { createYueRouter } = source('music/yue');

const MIB20 = 20 * 1024 * 1024;
const WAV_BYTES_PER_SECOND = 48000 * 3 * 2; // 24-bit PCM, 48 kHz, stereo: the ACE master
const MP3_BYTES_PER_SECOND = 320000 / 8; // 320 kbps: the listening copy
const SENTENCE_CHECK = 'Could not check the cover recording. No music request was sent. Import it again and retry.';
const SENTENCE_SIX = /Covers support up to 6 minutes\./;
const SENTENCE_OWNED = 'That recording is not saved on your account. Import it again.';
const LYRICS = '[Verse]\nthe invented words\n\n[Chorus]\nhold on';

const env = process.env;
env.AWS_BUCKET_NAME = 'booth-bucket';
env.AWS_ENDPOINT_URL = 'https://s3.example.test';
env.AWS_REGION = 'us-east-1';
env.YUE_ENDPOINT_ID = 'yuefixture';
env.RUNPOD_API_KEY = 'fixture';

/* The take an ACE worker would have made: its two links, signed. */
let takeNumber = 0;
const media = new Map(); // base url (no query) -> { bytes, seconds }
function aceTake(seconds, signature = 'aaa') {
  takeNumber += 1;
  const folder = `ace/${String(takeNumber).padStart(8, '0')}-5b1d-4c7a-9e11-0a6d2b7c8e44`;
  const sign = (key, sig) => `https://s3.example.test/booth-bucket/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${sig}`;
  const take = { seconds, mp3: sign(`${folder}/master.mp3`, signature), wav: sign(`${folder}/master.wav`, signature), resign: (key) => sign(`${folder}/master.${key}`, 'rotated') };
  media.set(`${folder}/master.mp3`, { bytes: Math.round(seconds * MP3_BYTES_PER_SECOND), seconds });
  media.set(`${folder}/master.wav`, { bytes: Math.round(seconds * WAV_BYTES_PER_SECOND), seconds });
  return take;
}

(async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await mongoose.model('KadeMusicReference').init();
  const calls = { downloads: [], runs: [] };
  axios.defaults.adapter = async (config) => {
    const url = String(config.url || '');
    const reply = (data) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
    if (url.startsWith('https://api.runpod.ai/v2/yuefixture/')) {
      const rest = url.slice('https://api.runpod.ai/v2/yuefixture/'.length);
      if (rest === 'run') {
        calls.runs.push((typeof config.data === 'string' ? JSON.parse(config.data) : config.data).input);
        return reply({ id: `prov${calls.runs.length}` });
      }
      return reply({ status: 'IN_QUEUE' });
    }
    const key = new URL(url).pathname.replace(/^\/booth-bucket\//, '');
    const file = media.get(key);
    assert.ok(file, 'an unexpected download: ' + url);
    calls.downloads.push({ key, cap: config.maxContentLength });
    if (config.maxContentLength > 0 && file.bytes > config.maxContentLength) {
      throw Object.assign(new Error(`maxContentLength size of ${config.maxContentLength} exceeded`), { code: 'ERR_BAD_RESPONSE' });
    }
    /* The first eight bytes carry the length the stand-in duration probe will read back. */
    const body = Buffer.alloc(Math.max(8, file.bytes));
    body.writeDoubleLE(file.seconds, 0);
    return { data: body, status: 200, statusText: 'OK', headers: { 'content-type': key.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav' }, config };
  };

  /* The accounts' assets, exactly the two links the ACE complete hook keeps for each take. */
  const assetsOf = new Map();
  const own = (user, ...takes) => assetsOf.set(user, takes.flatMap((t) => [t.mp3, t.wav]));
  const hooks = {
    auth: (_req, _res, next) => next(),
    user: (req) => String(req.headers['x-test-user']),
    savedSources: async (user) => assetsOf.get(user) || [],
    authorize: async (user, url) => {
      if (!isOwnedAudioReference(user, url, assetsOf.get(user) || [], env)) throw new Error(SENTENCE_OWNED);
    },
    refresh: async (url) => url,
    duration: async (buffer) => buffer.readDoubleLE(0),
  };
  const app = express();
  app.use(createYueRouter({
    auth: hooks.auth,
    user: hooks.user,
    validateReference: (user, url) => validateMusicReference(user, url, hooks, { yueCover: true }),
    project: async () => new mongoose.Types.ObjectId().toString(),
    update: async () => {},
    complete: async () => {},
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let who = 0;
  /* Each case is a new person, so the one-active-job rule never gets in the way. */
  const cover = async (user, url, extra = {}) => {
    const res = await fetch(base + '/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user },
      body: JSON.stringify({ engine: 'yue2', script: 'English, folk, warm alto', lyrics: LYRICS, reference_voice_url: url, referenceExpected: true, ...extra }),
    });
    return { status: res.status, data: await res.json() };
  };
  const person = () => `owner${++who}`;
  const startedBefore = () => ({ downloads: calls.downloads.length, runs: calls.runs.length });
  const quiet = (before) => assert.deepEqual({ downloads: calls.downloads.length, runs: calls.runs.length }, before);

  try {
    /* ---- the MP3 of a normal ACE take: owned, measured, queued as a YuE2 cover ---- */
    const song = aceTake(95);
    let user = person();
    own(user, song);
    let before = startedBefore();
    let res = await cover(user, song.mp3);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.queued, true);
    assert.equal(calls.runs.length, before.runs + 1, 'one cover request reached the YuE2 endpoint');
    assert.equal(calls.runs.at(-1).reference_voice_url, song.mp3, 'with the take as its reference recording');
    assert.equal(calls.runs.at(-1).lyrics, LYRICS);
    assert.equal(calls.downloads.at(-1).cap, MIB20, 'the booth measured it under the twenty megabyte cap');
    assert.ok(media.get(new URL(song.mp3).pathname.replace(/^\/booth-bucket\//, '')).bytes < MIB20, 'and the MP3 is far under it');

    /* ---- the same take with a re-signed library link is still owned (the library signs links afresh) ---- */
    user = person();
    own(user, song);
    res = await cover(user, song.resign('mp3'));
    assert.equal(res.status, 200, JSON.stringify(res.data));

    /* ---- another person's take is refused before anything is downloaded or sent ---- */
    const theirs = aceTake(95);
    const thief = person();
    own(thief);
    before = startedBefore();
    res = await cover(thief, theirs.mp3);
    assert.ok(res.status >= 400 && res.status < 500, String(res.status));
    assert.equal(res.data.error, SENTENCE_OWNED);
    quiet(before);

    /* ---- FINDING A: the WAV master fails the length check past 72 seconds, the MP3 does not ---- */
    const limit = Math.floor(MIB20 / WAV_BYTES_PER_SECOND);
    assert.equal(limit, 72, 'a 24-bit 48 kHz stereo WAV passes the twenty megabyte cap only up to 72 seconds');
    for (const [seconds, wavFits] of [[30, true], [72, true], [73, false], [95, false], [180, false], [300, false]]) {
      const take = aceTake(seconds);
      const u = person();
      own(u, take);
      res = await cover(u, take.wav);
      if (wavFits) assert.equal(res.status, 200, `${seconds} s WAV: ${JSON.stringify(res.data)}`);
      else {
        assert.ok(res.status >= 400, `${seconds} s WAV should not pass`);
        assert.equal(res.data.error, SENTENCE_CHECK, `${seconds} s WAV`);
      }
      const v = person();
      own(v, take);
      res = await cover(v, take.mp3);
      assert.equal(res.status, 200, `${seconds} s MP3 always fits: ${JSON.stringify(res.data)}`);
    }
    assert.ok(MIB20 / MP3_BYTES_PER_SECOND > 520, 'the 320k MP3 stays under the cap for almost nine minutes');
    /* The failed measure is not remembered as a recording of unknown length: nothing was registered for the WAV that failed. */
    const failed = aceTake(95);
    const owner = person();
    own(owner, failed);
    before = startedBefore();
    res = await cover(owner, failed.wav);
    assert.equal(res.data.error, SENTENCE_CHECK);
    assert.equal(calls.runs.length, before.runs, 'and nothing was sent to the GPU');

    /* ---- FINDING B: six minutes ---- */
    for (const [seconds, passes] of [[240, true], [300, true], [359, true], [359.9, true], [360, true], [360.04, false], [361, false], [420, false]]) {
      const take = aceTake(seconds);
      const u = person();
      own(u, take);
      res = await cover(u, take.mp3);
      if (passes) assert.equal(res.status, 200, `${seconds} s: ${JSON.stringify(res.data)}`);
      else {
        assert.ok(res.status >= 400, `${seconds} s should be refused`);
        assert.match(res.data.error, SENTENCE_SIX, `${seconds} s`);
      }
    }
    assert.equal(musicReferenceError(360, { yueCover: true }), undefined);
    assert.match(musicReferenceError(360.04, { yueCover: true }), SENTENCE_SIX, 'a 6:00 ACE take can measure a hair over the six minute cover limit');
    assert.equal(musicReferenceError(359.9, { yueCover: true }), undefined, 'a take of 5:59 or less is fine');

    console.log('ACE cover source: owned MP3 and WAV, re-signed link, foreign take refused unseen; the WAV master passes the 20 MB length check only up to 72 s while the MP3 always fits; the 6:00 edge is documented.');
  } finally {
    server.closeAllConnections();
    server.close();
    await mongoose.disconnect();
    await mongo.stop();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
