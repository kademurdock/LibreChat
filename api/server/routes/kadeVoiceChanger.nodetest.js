'use strict';
/* The Voice Changer's server half without a database, a network or B2 (Oct 22 2026).
 * Run: node --test api/server/routes/kadeVoiceChanger.nodetest.js
 * express, multer and express-rate-limit come from the api's own dependencies. Sign-in,
 * the models, storage and ffmpeg are in-memory fakes handed to createRouter(deps); the
 * engine folder, modules.json, beds.json, soundBeds.json and the sample voices are the
 * real files. Every name here is made up. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const express = require('express');

const vc = require('./kadeVoiceChanger');
const serve = require('../kadeVoiceChanger/serve');

const { LIMITS, ENGINE, SOUND_BEDS, checkChain } = vc._internals;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const ENGINE_DIR = path.join(__dirname, '..', 'kadeVoiceChanger', 'engine');
const VERSION = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, 'manifest.json'), 'utf8')).version;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const ADA = '6a00000000000000000000a1';
const BEA = '6a00000000000000000000b2';
const CAL = '6a00000000000000000000c3';
const USERS = {
  [ADA]: { _id: ADA, name: 'Ada Example', username: 'ada', email: 'ada@example.test' },
  [BEA]: { _id: BEA, name: 'Bea Sample Person', username: 'bea', email: 'bea@example.test' },
  [CAL]: { _id: CAL, name: '', username: 'cal', email: 'cal@example.test' },
};
const as = (id) => ({ 'x-test-user': JSON.stringify({ id, role: 'USER' }) });

/* ── fakes ──────────────────────────────────────────────────────────────── */

const fakeAuth = (req, res, next) => {
  const raw = req.headers['x-test-user'];
  if (!raw) return res.status(401).json({ message: 'Unauthorized' });
  req.user = JSON.parse(raw);
  return next();
};

let idSeq = 0;
const newId = () => (0xabc0000000 + ++idSeq).toString(16).padStart(24, '0');
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function matches(doc, q) {
  return Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && '$ne' in v) return String(doc[k]) !== String(v.$ne);
    return String(doc[k]) === String(v);
  });
}

/** A query result with the chain the router uses: sort, limit, populate, lean. */
function query(rows) {
  let out = rows.slice();
  const q = {
    sort(spec) {
      const [[key, dir]] = Object.entries(spec);
      out.sort((a, b) => (a[key] < b[key] ? -dir : a[key] > b[key] ? dir : 0));
      return q;
    },
    limit(n) {
      out = out.slice(0, n);
      return q;
    },
    populate(field, select) {
      assert.equal(field, 'user');
      assert.equal(select, 'name username', 'only the name fields leave the users collection');
      out = out.map((r) => ({ ...r, user: USERS[String(r.user)] ? { _id: r.user, name: USERS[String(r.user)].name, username: USERS[String(r.user)].username } : null }));
      return q;
    },
    lean: async () => clone(out),
  };
  return q;
}

function fakeCollection() {
  const rows = [];
  let clock = Date.parse('2026-10-22T12:00:00Z');
  const tick = () => new Date((clock += 1000)).toISOString();
  return {
    rows,
    create: async (doc) => {
      const t = tick();
      const row = { _id: newId(), ...clone(doc), createdAt: t, updatedAt: t };
      rows.push(row);
      return { ...clone(row), toObject: () => clone(row) };
    },
    find: (q) => query(rows.filter((r) => matches(r, q))),
    findOne: (q) => ({ lean: async () => clone(rows.find((r) => matches(r, q)) || null) }),
    countDocuments: async (q) => rows.filter((r) => matches(r, q)).length,
    findOneAndUpdate: (q, u, opts = {}) => ({
      lean: async () => {
        assert.equal(opts.returnDocument, 'after');
        let row = rows.find((r) => matches(r, q));
        if (!row && opts.upsert) {
          row = { _id: newId(), ...clone(q), createdAt: tick() };
          rows.push(row);
        }
        if (!row) return null;
        for (const [k, v] of Object.entries(u.$set || {})) {
          if (k.includes('.')) {
            const [a, b] = k.split('.');
            row[a] = { ...(row[a] || {}), [b]: v };
          } else row[k] = clone(v);
        }
        row.updatedAt = tick();
        return clone(row);
      },
    }),
    deleteOne: async (q) => {
      const i = rows.findIndex((r) => matches(r, q));
      if (i >= 0) rows.splice(i, 1);
      return { deletedCount: i >= 0 ? 1 : 0 };
    },
  };
}

/** A take is a few bytes saying how long the fake ffprobe should say it is. */
const take = (seconds) => Buffer.from(`FAKE-SOUND seconds=${seconds} `.padEnd(64, '.'));

function makeWorld(extra = {}) {
  const world = {
    assets: fakeCollection(),
    presets: fakeCollection(),
    prefs: fakeCollection(),
    stored: [],
    transcoded: [],
    probed: 0,
    storageDown: false,
    transcodeDown: false,
  };
  world.router = vc.createRouter({
    auth: fakeAuth,
    logger: quiet,
    KadeAsset: world.assets,
    KadeVoicePreset: world.presets,
    KadeVoicePrefs: world.prefs,
    saveBufferToS3: async (args) => {
      if (world.storageDown) throw new Error('bucket unreachable');
      world.stored.push(args);
      return `https://b2.example.test/bucket/${args.basePath}/${args.userId}/${args.fileName}?X-Amz-Signature=abc`;
    },
    probeSeconds: async (buffer, ext) => {
      world.probed += 1;
      world.lastExt = ext;
      const m = /seconds=([\d.]+)/.exec(buffer.toString('latin1'));
      return m ? Number(m[1]) : null;
    },
    transcode: async (buffer, ext, opts) => {
      if (world.transcodeDown) throw Object.assign(new Error('encoder missing'), { stderr: 'libmp3lame not found' });
      world.transcoded.push({ ext, title: opts.title, bytes: buffer.length });
      return Buffer.from('ID3-fake-mp3-bytes');
    },
    filterShared: async (docs) => docs.filter((p) => !/forbidden/i.test(p.name)),
    ...extra,
  });
  return world;
}

/* ── one app, every piece mounted the way index.js mounts it ───────────── */

let server;
let base;
let world;
let limited;
before(async () => {
  world = makeWorld();
  limited = makeWorld({ savesPerDay: 2 });
  const app = express();
  serve.mountEngine(app);
  app.use('/api/kade/voice-changer', world.router);
  app.use('/limited', limited.router);
  app.get('/voice-changer', vc.voiceChangerPage);
  app.get('/voice-changer/engine', vc.enginePage);
  app.get('/page-missing', vc.pageRoute('voiceChangerHtml', { load: () => { throw new Error("Cannot find module './VoiceChanger/pages'"); }, logger: quiet }));
  app.get('/page-string', vc.pageRoute('voiceChangerHtml', { load: () => ({ voiceChangerHtml: '<!doctype html><title>Voice Changer</title>' }) }));
  app.get('/page-engine', vc.pageRoute('engineHostHtml', { cacheControl: 'no-store', load: () => ({ engineHostHtml: '<!doctype html><title>engine</title>' }) }));
  app.get('/page-handler', vc.pageRoute('voiceChangerHtml', { load: () => ({ voiceChangerHtml: (_req, res) => res.type('html').send('from a handler') }) }));
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

const api = (p) => `${base}/api/kade/voice-changer${p}`;
async function call(url, { method = 'GET', user, body, headers = {} } = {}) {
  const init = { method, headers: { ...(user ? as(user) : {}), ...headers } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, text, json };
}

function saveForm({ file = take(13.2), type = 'audio/wav', name = 'take.wav', fields = {}, files } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ title: 'Test take', presetId: 'giant-in-a-cave', presetName: 'Giant in a cave', ...fields })) {
    if (v !== undefined) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  for (const f of files || [{ file, type, name }]) {
    if (f.file) form.append('audio', new Blob([f.file], { type: f.type }), f.name);
  }
  return form;
}
const save = (user, opts, url = api('/save')) => call(url, { method: 'POST', user, body: saveForm(opts) });

let catalog;
const bannedIn = async (text) => {
  if (!catalog) catalog = await import(pathToFileURL(path.join(ENGINE_DIR, 'catalog.js')).href);
  return catalog.findBannedWord(text);
};

/* ── GET /config ────────────────────────────────────────────────────────── */

test('config: sign-in required, never cached, and the shape both apps read', async () => {
  assert.equal((await call(api('/config'))).status, 401);
  const r = await call(api('/config'), { user: ADA });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const c = r.json;
  assert.equal(c.engineVersion, VERSION);
  assert.equal(c.engineBase, `/vc-engine/${VERSION}/`);
  assert.equal(c.catalogUrl, `/vc-engine/${VERSION}/catalog.json`);
  assert.equal(c.modulesUrl, `/vc-engine/${VERSION}/modules.json`);
  assert.equal(c.bedsUrl, `/vc-engine/${VERSION}/beds.json`);
  assert.equal(c.maxSeconds, 180);
  assert.equal(c.previewSeconds, 6);
  assert.equal(c.saveMaxBytes, 40 * 1024 * 1024);
  assert.deepEqual(c.features, { save: true, presets: true, aiBeds: false });
  assert.deepEqual(c.saveKinds, ['wav', 'mp3', 'm4a', 'aac', 'webm', 'ogg', 'flac']);
  assert.equal(c.limits.savesPerDay, 300);
  assert.equal(c.limits.presetsPerPerson, 1000);
  assert.equal(c.limits.presetStages, 12);
  assert.equal(c.limits.favorites, 2000);
  assert.equal(c.limits.recent, 100);
  for (const k of ['catalogUrl', 'modulesUrl', 'bedsUrl', 'clientUrl', 'bridgeUrl']) {
    const rel = c[k].slice(c.engineBase.length);
    assert.ok(fs.existsSync(path.join(ENGINE_DIR, rel)), `${k} points at a real engine file`);
  }
});

test('config: the recorded backgrounds are real loops with plain names and site paths', async () => {
  const c = (await call(api('/config'), { user: ADA })).json;
  assert.ok(c.soundBeds.length >= 30, 'every ambience loop the platform has');
  const groups = new Set(c.soundBedGroups.map((g) => g.id));
  assert.deepEqual([...groups], ['weather', 'water', 'fire', 'nature', 'places', 'indoors']);
  const ids = new Set();
  const files = new Set();
  const madeBeds = new Set(ENGINE.beds.keys());
  /* the fictional town, ward and shop names the loops were first made for */
  const placeNames = /bellward|sweetwater|tanglefoot|millrace|starlite|bijou|easel|early bird|dez|pat's|mercy|fairlawn|gravewalk|long ?acre|gully|ropewalk|net ?loft|reedbank|alder|the hook|the patch/i;
  for (const b of c.soundBeds) {
    assert.match(b.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${b.id} is a sound-file id render.js accepts`);
    assert.ok(!ids.has(b.id), `${b.id} is unique`);
    ids.add(b.id);
    assert.ok(!madeBeds.has(b.id), `${b.id} does not share an id with a made background`);
    assert.ok(groups.has(b.group), `${b.id} has a known group`);
    assert.match(b.url, /^\/assets\/sounds\/reverie\/[a-z0-9]+\/[a-z0-9.]+\.m4a$/);
    assert.ok(!files.has(b.url), `${b.url} is listed once`);
    files.add(b.url);
    assert.ok(fs.existsSync(path.join(ROOT, 'client', 'public', b.url)), `${b.url} ships with the site`);
    assert.ok(b.seconds >= 10 && b.seconds <= 60, `${b.id} is a loop, not a one-shot`);
    assert.ok(b.name && b.name.length <= 48 && b.about && b.about.length < 120);
    assert.doesNotMatch(`${b.name} ${b.about}`, placeNames, `${b.id} names no made-up place`);
    /* "fal" alone, so "falling" water still passes */
    assert.doesNotMatch(`${b.name} ${b.about}`, /(^|[^a-z])fal([^a-z]|$)|seed audio|stable audio|elevenlabs/i, `${b.id} names no product`);
    assert.equal(await bannedIn(`${b.name}. ${b.about}`), null, `${b.id} passes the engine's name check`);
  }
  /* the newest copy wins: superseded folders are never offered */
  for (const old of ['/places296/amb.arcade.room.m4a', '/places296/amb.bakery.room.m4a', '/world153/amb.home.quiet.m4a', '/life172/amb.laundry.quiet.m4a', '/levels173/amb.bellward.m4a', '/levels173/amb.millrace.m4a', '/life/work.diner.grill.loop.m4a']) {
    assert.ok(![...files].some((u) => u.endsWith(old)), `${old} has a newer version`);
  }
  for (const want of ['An old barbershop', 'A small busy bar', 'A diner griddle', 'Rain dripping from a shelter', 'A river spillway', 'Woods at night']) {
    assert.ok(c.soundBeds.some((b) => b.name === want), `${want} is offered`);
  }
});

test('config: two sample voices, 16-bit WAV at 24 kHz, cut at a pause', async () => {
  const c = (await call(api('/config'), { user: ADA })).json;
  assert.deepEqual(c.samples.map((s) => s.name), ['Sample voice: a woman talking', 'Sample voice: a man talking']);
  for (const s of c.samples) {
    assert.ok(s.url.startsWith(c.engineBase + 'samples/'));
    const bytes = fs.readFileSync(path.join(ENGINE_DIR, s.url.slice(c.engineBase.length)));
    assert.equal(bytes.toString('latin1', 0, 4), 'RIFF');
    assert.equal(bytes.readUInt16LE(22), 1, 'mono');
    assert.equal(bytes.readUInt32LE(24), 24000, '24 kHz kept');
    assert.equal(bytes.readUInt16LE(34), 16, '16-bit');
    assert.ok(s.seconds >= 12 && s.seconds <= 15, `${s.id} is ${s.seconds} s, inside 12 to 15`);
    /* the last 50 ms is the quiet of a pause, not a word cut off */
    const n = (bytes.length - 44) / 2;
    let peak = 0;
    for (let i = n - 1200; i < n; i++) peak = Math.max(peak, Math.abs(bytes.readInt16LE(44 + i * 2)));
    assert.ok(peak < 3000, `${s.id} ends quietly (peak ${peak})`);
  }
});

/* ── POST /save ─────────────────────────────────────────────────────────── */

test('save: a take becomes a My Creations item, written directly, in the my-assets shape', async () => {
  const before = world.assets.rows.length;
  const r = await save(ADA, { fields: { macros: { pitch: 2, timbre: -1 }, chain: [{ m: 'pitch.voice', p: { semitones: -8 } }], seconds: '13.2' } });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(Object.keys(r.json), ['id', 'kind', 'service', 'url', 'backupUrl', 'description', 'shared', 'archived', 'prompt', 'model', 'costUSD', 'createdAt']);
  assert.equal(r.json.kind, 'audio');
  assert.equal(r.json.service, 'voice_changer');
  assert.equal(r.json.costUSD, 0);
  assert.equal(r.json.prompt, '', 'no prompt, so no describer can bill anyone');
  assert.equal(r.json.description, 'Test take, your voice as Giant in a cave, 13 seconds');
  assert.equal(r.json.shared, false);
  assert.equal(world.assets.rows.length, before + 1);
  const row = world.assets.rows.at(-1);
  assert.equal(String(row.user), ADA);
  assert.equal(row.chargedUSD, 0);
  assert.equal(row.metadata.source, 'voice_changer');
  assert.equal(row.metadata.title, 'Test take');
  assert.equal(row.metadata.presetId, 'giant-in-a-cave');
  assert.equal(row.metadata.presetName, 'Giant in a cave');
  assert.equal(row.metadata.seconds, 13.2);
  assert.deepEqual(row.metadata.macros, { pitch: 2, timbre: -1 });
  assert.deepEqual(row.metadata.chain, [{ m: 'pitch.voice', p: { semitones: -8 } }]);
  assert.equal(row.metadata.engineVersion, VERSION);
  const put = world.stored.at(-1);
  assert.equal(put.basePath, 'audios');
  assert.equal(put.userId, ADA);
  assert.match(put.fileName, /^voicechanger-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp3$/);
  assert.equal(put.buffer.toString(), 'ID3-fake-mp3-bytes', 'the MP3 is what is stored, not the upload');
  assert.equal(world.transcoded.at(-1).title, 'Test take');
  assert.equal(r.json.url, `https://b2.example.test/bucket/audios/${ADA}/${put.fileName}?X-Amz-Signature=abc`);
  const src = fs.readFileSync(path.join(__dirname, 'kadeVoiceChanger.js'), 'utf8');
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /logKadeAsset\s*\(/, 'never logKadeAsset: no second B2 copy, no paid describe');
});

test('save: the file kind is allowed by its type or by its name', async () => {
  let r = await save(ADA, { type: 'application/octet-stream', name: 'phone memo.m4a' });
  assert.equal(r.status, 201, r.text);
  assert.equal(world.lastExt, 'm4a');
  r = await save(ADA, { type: 'audio/webm;codecs=opus', name: 'blob' });
  assert.equal(r.status, 201, r.text);
  assert.equal(world.lastExt, 'webm');
  r = await save(ADA, { type: 'audio/ogg', name: 'recording' });
  assert.equal(r.status, 201);
  assert.equal(world.lastExt, 'ogg');
  r = await save(ADA, { type: 'audio/flac', name: 'x.FLAC' });
  assert.equal(r.status, 201);
  assert.equal(world.lastExt, 'flac');
  r = await save(ADA, { fields: { title: '' } });
  assert.equal(r.status, 201);
  assert.match(r.json.description, /^Voice Changer recording, /, 'an untitled save still has a name');
  r = await save(ADA, { fields: { presetName: undefined, presetId: undefined }, file: take(1.2) });
  assert.equal(r.json.description, 'Test take, your voice, changed, 1 second');
});

test('save: refusals are plain sentences and nothing is stored', async () => {
  const stored = world.stored.length;
  const assets = world.assets.rows.length;
  const cases = [
    [{ files: [] }, 400, /There was no recording to save\. Send it in the field named "audio"\./],
    [{ type: 'text/plain', name: 'notes.txt' }, 415, /That kind of file cannot be saved\. The Voice Changer saves WAV, MP3, M4A, AAC, WebM, Ogg and FLAC sound files\./],
    [{ type: 'video/mp4', name: 'clip.mp4' }, 415, /cannot be saved/],
    [{ files: [{ file: take(3), type: 'audio/wav', name: 'a.wav' }, { file: take(3), type: 'audio/wav', name: 'b.wav' }] }, 400, /Send one recording at a time/],
    [{ file: take(200) }, 413, /^That file is too long: the Voice Changer keeps up to 3 minutes\.$/],
    [{ fields: { seconds: '400' } }, 413, /^That file is too long: the Voice Changer keeps up to 3 minutes\.$/],
    [{ fields: { seconds: 'soon' } }, 400, /not a number of seconds/],
    [{ file: Buffer.from('this is not a sound at all') }, 422, /could not be read as sound, so nothing was saved/],
    [{ fields: { title: 'x'.repeat(81) } }, 400, /The title can be up to 80 characters\./],
    [{ fields: { presetName: 'y'.repeat(81) } }, 400, /preset name can be up to 80/],
    [{ fields: { presetId: 'no spaces allowed' } }, 400, /preset id could not be read/],
    [{ fields: { macros: { pitch: 'x'.repeat(4100) } } }, 400, /too long to save/],
    [{ fields: { macros: '{not json' } }, 400, /could not be read, so nothing was saved/],
    [{ fields: { macros: [1, 2] } }, 400, /not in the right shape/],
    [{ fields: { macros: { $where: 'sleep(1)' } } }, 400, /not in the right shape/],
    [{ fields: { chain: [{ m: 'pitch.voice', p: { 'a.b': 1 } }] } }, 400, /not in the right shape/],
    [{ fields: { chain: Array.from({ length: 40 }, () => ({ m: 'pitch.voice', p: { semitones: 1, note: 'z'.repeat(500) } })) } }, 400, /too long to save/],
  ];
  for (const [opts, status, said] of cases) {
    const r = await save(ADA, opts);
    assert.equal(r.status, status, `${JSON.stringify(opts).slice(0, 80)} -> ${r.text}`);
    assert.match(r.json.error, said);
  }
  assert.equal(world.stored.length, stored);
  assert.equal(world.assets.rows.length, assets);
});

test('save: over 40 megabytes is refused before ffmpeg ever runs', async () => {
  const probed = world.probed;
  const big = Buffer.alloc(40 * 1024 * 1024 + 1, 1);
  const r = await save(ADA, { file: big });
  assert.equal(r.status, 413);
  assert.match(r.json.error, /^That file is too big: the Voice Changer saves files up to 40 megabytes\. Nothing was saved\.$/);
  assert.equal(world.probed, probed);
});

test('save: an encoder or storage failure says nothing was saved', async () => {
  const assets = world.assets.rows.length;
  world.transcodeDown = true;
  let r = await save(ADA);
  world.transcodeDown = false;
  assert.equal(r.status, 500);
  assert.match(r.json.error, /could not be made into an MP3, so nothing was saved/);
  world.storageDown = true;
  r = await save(ADA);
  world.storageDown = false;
  assert.equal(r.status, 502);
  assert.match(r.json.error, /could not be stored just now, so nothing was saved/);
  assert.equal(world.assets.rows.length, assets);
});

test('save: a daily limit per person; refused saves do not use it up', async () => {
  const url = `${base}/limited/save`;
  assert.equal((await save(BEA, { files: [] }, url)).status, 400);
  assert.equal((await save(BEA, {}, url)).status, 201);
  assert.equal((await save(BEA, {}, url)).status, 201);
  const r = await save(BEA, {}, url);
  assert.equal(r.status, 429);
  assert.match(r.json.error, /^You have saved 2 recordings from the Voice Changer today, which is the most for one day\. Saving opens again tomorrow\.$/);
  assert.equal((await save(ADA, {}, url)).status, 201, 'the limit is per person');
  assert.equal((await call(`${base}/limited/save`, { method: 'POST' })).status, 401);
});

/* ── presets ────────────────────────────────────────────────────────────── */

const bedId = () => SOUND_BEDS.beds[0].id;
const goodPreset = (extra = {}) => ({
  name: 'Big voice in a small room',
  about: 'Low and close.',
  chain: [
    { m: 'pitch.voice', p: { semitones: -8, formant: -6 } },
    { m: 'space.room', p: { space: 'closet', mix: 40 } },
    { m: 'synth.vocoder', p: { carrier: 'side' }, off: true },
  ],
  macros: { pitch: 2, speed: 1.25, bed: { file: bedId(), level: -24 } },
  bed: { b: 'rain', level: -20, p: { surface: 'roof', intensity: 70 }, duck: 6, fade: { in: 1, out: 2 } },
  side: bedId(),
  seed: 7,
  shared: true,
  ...extra,
});

test('presets: a good preset is saved and comes back the same', async () => {
  const r = await call(api('/presets'), { method: 'POST', user: ADA, body: goodPreset() });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.name, 'Big voice in a small room');
  assert.equal(r.json.mine, true);
  assert.equal(r.json.shared, true);
  assert.deepEqual(r.json.chain, goodPreset().chain);
  assert.deepEqual(r.json.bed, goodPreset().bed);
  assert.deepEqual(r.json.macros, goodPreset().macros);
  assert.equal(r.json.side, bedId());
  assert.equal(r.json.seed, 7);
  assert.equal(world.presets.rows.at(-1).engineVersion, VERSION);
  assert.equal(String(world.presets.rows.at(-1).user), ADA);
});

test('presets: every effect and setting is checked against modules.json', async () => {
  const bad = [
    [{ chain: [{ m: 'pitch.nonsense' }] }, /Effect 1 uses "pitch\.nonsense", which is not an effect the Voice Changer has\./],
    [{ chain: [{ m: 'pitch.voice', p: { loudness: 3 } }] }, /Effect 1 \(Pitch and timbre\) has no setting called "loudness"\./],
    [{ chain: [{ m: 'pitch.voice', p: { semitones: 30 } }] }, /"Pitch" is 30, outside its range of -24 to 24\./],
    [{ chain: [{ m: 'pitch.voice', p: { semitones: '3' } }] }, /must be a number/],
    [{ chain: [{ m: 'space.room', p: { space: 'moon-base' } }] }, /cannot be "moon-base"/],
    [{ chain: [{ m: 'pitch.voice', fx: 1 }] }, /unknown field "fx"/],
    [{ chain: [{ p: {} }] }, /does not say which effect it is/],
    [{ chain: [] }, /needs at least one effect/],
    [{ chain: Array.from({ length: 13 }, () => ({ m: 'pitch.voice' })) }, /up to 12 effects; this one has 13/],
    [{ chain: undefined }, /needs at least one effect/],
    [{ name: '' }, /Give the preset a name\./],
    [{ name: 'n'.repeat(61) }, /up to 60 characters/],
    [{ about: 'a'.repeat(161) }, /up to 160 characters/],
    [{ bed: { b: 'lava-lake' } }, /There is no background called "lava-lake"\./],
    [{ bed: { b: 'rain', p: { surface: 'trampoline' } } }, /cannot be "trampoline"/],
    [{ bed: { file: 'not-a-recorded-bed' } }, /There is no recorded background called "not-a-recorded-bed"\./],
    [{ bed: { b: 'rain', level: 20 } }, /outside its range of -60 to 6/],
    [{ macros: { pitch: 99 } }, /"?Pitch"? is 99, outside its range of -24 to 24/],
    [{ macros: { wobble: 1 } }, /There is no main control called "wobble"\./],
    [{ side: 'nothing-here' }, /no recorded sound called "nothing-here"/],
    [{ shared: 'yes' }, /Shared must be true or false\./],
    [{ owner: BEA }, /A preset has no field called "owner"\./],
  ];
  const before = world.presets.rows.length;
  for (const [patch, said] of bad) {
    const r = await call(api('/presets'), { method: 'POST', user: ADA, body: goodPreset(patch) });
    assert.equal(r.status, 400, `${JSON.stringify(patch).slice(0, 80)} -> ${r.text}`);
    assert.match(r.json.error, said);
  }
  assert.equal(world.presets.rows.length, before);
});

test('presets: every module and every one of its settings in modules.json is accepted', () => {
  let stages = 0;
  for (const mod of ENGINE.modules.values()) {
    for (const pick of ['def', 'min', 'max']) {
      const p = {};
      for (const param of mod.params) {
        if (param.type === 'number') p[param.id] = pick === 'def' ? param.def : param[pick];
        else if (param.type === 'choice') p[param.id] = pick === 'max' ? param.options.at(-1).v : param.options[0].v;
        else p[param.id] = pick !== 'min';
      }
      assert.doesNotThrow(() => checkChain([{ m: mod.id, p }], ENGINE), mod.id);
      stages += 1;
    }
  }
  assert.ok(stages >= 300, `${stages} stages checked`);
});

test('presets: the list holds mine and everyone else’s shared ones, first names only', async () => {
  await call(api('/presets'), { method: 'POST', user: BEA, body: goodPreset({ name: 'Bea shares this', shared: true }) });
  await call(api('/presets'), { method: 'POST', user: BEA, body: goodPreset({ name: 'Bea keeps this', shared: false }) });
  await call(api('/presets'), { method: 'POST', user: CAL, body: goodPreset({ name: 'Cal shares this', shared: true }) });
  await call(api('/presets'), { method: 'POST', user: CAL, body: goodPreset({ name: 'A forbidden word here', shared: true }) });
  const r = await call(api('/presets'), { user: ADA });
  assert.equal(r.status, 200);
  assert.ok(r.json.mine.length >= 1 && r.json.mine.every((p) => p.mine === true && !('by' in p)));
  const names = r.json.shared.map((p) => p.name);
  assert.ok(names.includes('Bea shares this') && names.includes('Cal shares this'));
  assert.ok(!names.includes('Bea keeps this'), 'private presets stay private');
  assert.ok(!names.includes('Big voice in a small room'), 'my own shared preset is under mine, not shared');
  assert.ok(!names.includes('A forbidden word here'), 'the viewer filter runs on shared presets');
  const bea = r.json.shared.find((p) => p.name === 'Bea shares this');
  assert.equal(bea.by, 'Bea');
  assert.equal(r.json.shared.find((p) => p.name === 'Cal shares this').by, 'cal', 'no name falls back to the username');
  assert.doesNotMatch(r.text, /@example\.test|6a00000000000000000000b2|Sample Person/, 'no email, account id or surname leaves');
});

test('presets: change and delete are the owner’s alone', async () => {
  const made = (await call(api('/presets'), { method: 'POST', user: ADA, body: goodPreset({ name: 'Mine to change', shared: false }) })).json;
  let r = await call(api(`/presets/${made.id}`), { method: 'PATCH', user: BEA, body: { name: 'Taken over' } });
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'That preset was not found.');
  r = await call(api(`/presets/${made.id}`), { method: 'PATCH', user: ADA, body: { name: '  Changed   name ', chain: [{ m: 'mod.chorus', p: { voices: 4 } }], seed: null } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.name, 'Changed name');
  assert.deepEqual(r.json.chain, [{ m: 'mod.chorus', p: { voices: 4 } }]);
  assert.equal(r.json.seed, null);
  assert.equal(r.json.about, 'Low and close.', 'fields not sent are kept');
  r = await call(api(`/presets/${made.id}`), { method: 'PATCH', user: ADA, body: {} });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Nothing in the preset was changed/);
  r = await call(api(`/presets/${made.id}`), { method: 'PATCH', user: ADA, body: { chain: [{ m: 'mod.chorus', p: { voices: 9 } }] } });
  assert.equal(r.status, 400);
  assert.equal((await call(api('/presets/not-an-id'), { method: 'PATCH', user: ADA, body: { name: 'x' } })).status, 404);
  assert.equal((await call(api(`/presets/${made.id}`), { method: 'DELETE', user: BEA })).status, 404);
  r = await call(api(`/presets/${made.id}`), { method: 'DELETE', user: ADA });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, id: made.id });
  assert.equal((await call(api(`/presets/${made.id}`), { method: 'DELETE', user: ADA })).status, 404);
});

test('presets: at most 1,000 per person', async () => {
  const w = makeWorld();
  for (let i = 0; i < LIMITS.PRESETS_PER_PERSON; i++) w.presets.rows.push({ _id: newId(), user: CAL, name: `p${i}`, chain: [{ m: 'pitch.voice' }], createdAt: '2026-10-01', updatedAt: '2026-10-01' });
  const app = express();
  app.use('/vc', w.router);
  const s = await new Promise((resolve) => {
    const x = app.listen(0, '127.0.0.1', () => resolve(x));
  });
  try {
    const r = await call(`http://127.0.0.1:${s.address().port}/vc/presets`, { method: 'POST', user: CAL, body: goodPreset() });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'You have 1,000 presets saved, which is the most one person can keep. Delete one to make room.');
  } finally {
    await new Promise((resolve) => s.close(resolve));
  }
});

/* ── prefs ──────────────────────────────────────────────────────────────── */

test('prefs: defaults for a new person, then saved favourites and settings', async () => {
  let r = await call(api('/prefs'), { user: CAL });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { favorites: [], recent: [], settings: { autoPreview: true, previewSeconds: 6, previewDelayMs: 350, keepLevel: true }, updatedAt: null });
  r = await call(api('/prefs'), { method: 'PUT', user: CAL, body: { favorites: ['giant-in-a-cave', 'tin-invader', 'giant-in-a-cave', 'custom:6a00000000000000000000ff'], settings: { previewSeconds: 10 } } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.favorites, ['giant-in-a-cave', 'tin-invader', 'custom:6a00000000000000000000ff'], 'repeats are dropped');
  assert.equal(r.json.settings.previewSeconds, 10);
  assert.equal(r.json.settings.autoPreview, true);
  r = await call(api('/prefs'), { method: 'PUT', user: CAL, body: { settings: { autoPreview: false, previewDelayMs: 1200.4 } } });
  assert.deepEqual(r.json.settings, { autoPreview: false, previewSeconds: 10, previewDelayMs: 1200, keepLevel: true }, 'settings merge');
  assert.deepEqual(r.json.favorites, ['giant-in-a-cave', 'tin-invader', 'custom:6a00000000000000000000ff'], 'favourites kept');
  r = await call(api('/prefs'), { user: CAL });
  assert.equal(r.json.settings.previewSeconds, 10, 'the iPhone reads what the website wrote');
  assert.deepEqual((await call(api('/prefs'), { user: BEA })).json.favorites, [], 'each person has their own');
  assert.equal(world.prefs.rows.filter((p) => String(p.user) === CAL).length, 1);
});

test('prefs: caps and settings ranges', async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => `preset-${i}`);
  let r = await call(api('/prefs'), { method: 'PUT', user: ADA, body: { favorites: many(2000), recent: many(100) } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.favorites.length, 2000);
  assert.equal(r.json.recent.length, 100);
  const bad = [
    [{ favorites: many(2001) }, /^You can keep up to 2,000 favorites; this list has 2,001\.$/],
    [{ recent: many(101) }, /^You can keep up to 100 recent presets; this list has 101\.$/],
    [{ favorites: 'giant-in-a-cave' }, /must be a list of preset ids/],
    [{ favorites: ['has spaces'] }, /"has spaces" is not a preset id/],
    [{ favorites: [42] }, /is not a preset id/],
    [{ settings: { previewSeconds: 1 } }, /outside its range of 2 to 20/],
    [{ settings: { previewSeconds: 21 } }, /outside its range of 2 to 20/],
    [{ settings: { previewDelayMs: 2001 } }, /outside its range of 0 to 2000/],
    [{ settings: { previewDelayMs: -1 } }, /outside its range of 0 to 2000/],
    [{ settings: { autoPreview: 'yes' } }, /must be on or off/],
    [{ settings: { keepLevel: 1 } }, /must be on or off/],
    [{ settings: { volume: 3 } }, /no Voice Changer setting called "volume"/],
    [{ theme: 'dark' }, /no Voice Changer setting called "theme"/],
    [{}, /Nothing was sent to save/],
  ];
  for (const [body, said] of bad) {
    r = await call(api('/prefs'), { method: 'PUT', user: ADA, body });
    assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 60)} -> ${r.text}`);
    assert.match(r.json.error, said);
  }
  assert.equal((await call(api('/prefs'), { user: ADA })).json.favorites.length, 2000, 'a refused change leaves what was there');
  assert.equal((await call(api('/prefs'))).status, 401);
});

/* ── the engine on the web ──────────────────────────────────────────────── */

test('engine: the current version is immutable for a year, with the right types and open CORS', async () => {
  assert.equal(serve.engineVersion(), VERSION);
  const cases = [
    ['catalog.js', /^application\/javascript; charset=utf-8$/i],
    ['host/client.js', /^application\/javascript; charset=utf-8$/i],
    ['host/worker.js', /^application\/javascript; charset=utf-8$/i],
    ['core/wav.js', /^application\/javascript; charset=utf-8$/i],
    ['modules.json', /^application\/json; charset=utf-8$/i],
    ['catalog.json', /^application\/json; charset=utf-8$/i],
    ['manifest.json', /^application\/json; charset=utf-8$/i],
    ['samples/sample-woman.wav', /^audio\/wav$/],
  ];
  for (const [file, type] of cases) {
    const res = await fetch(`${base}/vc-engine/${VERSION}/${file}`);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get('content-type'), type, file);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable', file);
    assert.equal(res.headers.get('access-control-allow-origin'), '*', file);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(fs.readFileSync(path.join(ENGINE_DIR, file))), `${file} is the file on disk`);
  }
  const old = await fetch(`${base}/vc-engine/0ld0ld0ld0ld/catalog.js`);
  assert.equal(old.status, 200);
  assert.equal(old.headers.get('cache-control'), 'no-cache', 'an old version is never pinned for a year');
  await old.arrayBuffer();
});

test('engine: tools, tests, dot files, folders and misses are 404 and never cached', async () => {
  const misses = [
    'tools/render_cli.js',
    'tools/make_registry.js',
    'test/fixtures.mjs',
    'test/contract.nodetest.mjs',
    'TOOLS/listen.js',
    'Test/fixtures.mjs',
    '%74ools/listen.js',
    'tools%2Flisten.js',
    'samples/..%2ftools/listen.js',
    'core/../tools/listen.js',
    '..%2f..%2fCONTRACT.md',
    '.gitignore',
    '.hidden/x.js',
    'core/',
    'core',
    'no-such-file.js',
    'modules/pitch/nothing.js',
  ];
  for (const m of misses) {
    const res = await fetch(`${base}/vc-engine/${VERSION}/${m}`);
    assert.equal(res.status, 404, m);
    assert.equal(res.headers.get('cache-control'), 'no-store', m);
    assert.match(res.headers.get('content-type'), /^text\/plain/, m);
    assert.equal(await res.text(), 'There is no such Voice Changer engine file.', m);
  }
  const bad = await fetch(`${base}/vc-engine/${encodeURIComponent('v1;rm')}/catalog.js`);
  assert.equal(bad.status, 404, 'a version with odd characters is not a version');
  const post = await fetch(`${base}/vc-engine/${VERSION}/catalog.js`, { method: 'POST' });
  assert.ok([404, 405].includes(post.status));
  assert.equal(post.headers.get('cache-control'), 'no-store');
  await post.text();
});

test('engine: an unreadable manifest closes the engine with a sentence instead of stopping the site', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-no-manifest-'));
  try {
    const app = express();
    const logged = [];
    const mounted = serve.mountEngine(app, { dir: empty, logger: { error: (m) => logged.push(m) } });
    assert.equal(mounted.version, null);
    assert.ok(mounted.error);
    assert.match(logged[0], /engine not served, manifest unreadable/);
    app.get('/still-up', (_req, res) => res.send('up'));
    const s = await new Promise((resolve) => {
      const x = app.listen(0, '127.0.0.1', () => resolve(x));
    });
    try {
      const at = `http://127.0.0.1:${s.address().port}`;
      const res = await fetch(`${at}/vc-engine/${VERSION}/catalog.js`);
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(await res.text(), 'The Voice Changer engine is not ready on the server just now. Please try again later.');
      assert.equal(await (await fetch(`${at}/still-up`)).text(), 'up', 'the rest of the site still answers');
    } finally {
      await new Promise((resolve) => s.close(resolve));
    }
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('api: when the engine lists could not be read, every route says so after sign-in', async () => {
  const w = makeWorld({ engine: null });
  const app = express();
  app.use('/vc', w.router);
  const s = await new Promise((resolve) => {
    const x = app.listen(0, '127.0.0.1', () => resolve(x));
  });
  try {
    const at = (p) => `http://127.0.0.1:${s.address().port}/vc${p}`;
    assert.equal((await call(at('/config'))).status, 401, 'sign-in still comes first');
    for (const [p, method, body] of [['/config', 'GET'], ['/presets', 'GET'], ['/presets', 'POST', goodPreset()], ['/prefs', 'PUT', { favorites: [] }]]) {
      const r = await call(at(p), { method, user: ADA, body });
      assert.equal(r.status, 503, `${method} ${p}`);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.json.error, 'The Voice Changer is not ready on the server just now. Nothing was changed; please try again later.');
    }
    const r = await save(ADA, {}, at('/save'));
    assert.equal(r.status, 503);
    assert.equal(w.stored.length + w.assets.rows.length + w.probed, 0, 'nothing was measured, stored or written');
  } finally {
    await new Promise((resolve) => s.close(resolve));
  }
});

/* The real ffprobe and ffmpeg, where they are installed (the production image has both; a
 * machine without them skips this). The fakes above stand in for them everywhere else. */
const HAVE_FFMPEG = ['FFPROBE_PATH', 'FFMPEG_PATH'].every((k, i) => {
  const r = spawnSync(process.env[k] || ['ffprobe', 'ffmpeg'][i], ['-version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
});
test('save tools: real ffprobe measures and real ffmpeg makes a tagged MP3', { skip: HAVE_FFMPEG ? false : 'ffmpeg and ffprobe are not installed here' }, async () => {
  const temps = () => new Set(fs.readdirSync(os.tmpdir()).filter((f) => /^vc-(probe|save)-/.test(f)));
  const tempsBefore = temps();
  const { encodeWav } = await import(pathToFileURL(path.join(ENGINE_DIR, 'core', 'wav.js')).href);
  const sr = 24000;
  const sig = new Float32Array(sr * 2);
  for (let i = 0; i < sig.length; i++) sig[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr);
  const wav = Buffer.from(encodeWav({ sr, ch: [sig] }, 16));
  const seconds = await vc._internals.probeSeconds(wav, 'wav');
  assert.ok(Math.abs(seconds - 2) < 0.05, `the WAV measures ${seconds} s`);
  const mp3 = await vc._internals.transcode(wav, 'wav', { title: 'A test tone' });
  assert.equal(mp3.toString('latin1', 0, 3), 'ID3', 'an ID3 tag carries the title');
  assert.ok(mp3.includes(Buffer.from('A test tone', 'latin1')));
  const back = await vc._internals.probeSeconds(mp3, 'mp3');
  assert.ok(Math.abs(back - 2) < 0.15, `the MP3 measures ${back} s`);
  assert.equal(await vc._internals.probeSeconds(Buffer.from('this is not a sound at all'), 'wav'), null);
  assert.deepEqual([...temps()].filter((f) => !tempsBefore.has(f)), [], 'temp folders are removed');
});

/* ── pages, the Home tile and the wiring ────────────────────────────────── */

test('pages: a missing page module answers 503 in a sentence; pages are not cached', async () => {
  let res = await fetch(`${base}/page-missing`);
  assert.equal(res.status, 503);
  assert.equal(await res.text(), 'The Voice Changer page is not ready yet. Please try again a little later.');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  res = await fetch(`${base}/page-string`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  await res.text();
  res = await fetch(`${base}/page-engine`);
  assert.equal(res.headers.get('cache-control'), 'no-store', 'the iPhone engine page is no-store');
  await res.text();
  res = await fetch(`${base}/page-handler`);
  assert.equal(await res.text(), 'from a handler');
  for (const p of ['/voice-changer', '/voice-changer/engine']) {
    res = await fetch(`${base}${p}`);
    assert.ok([200, 503].includes(res.status), `${p} answers whether or not the page module exists yet`);
    if (p.endsWith('/engine')) assert.equal(res.headers.get('cache-control'), 'no-store');
    await res.text();
  }
});

test('Home: the Voice Changer tile sits right after the Sound Booth, spoken and described', async () => {
  const home = require('./kadeHome').homeHtml;
  const tile = home.match(/<a class="hubitem" href="\/voice-changer"[^\n]*<\/a>/);
  assert.ok(tile, 'the tile is on Home');
  assert.match(tile[0], /aria-label="The Voice Changer"/);
  assert.match(tile[0], /aria-describedby="h-voicechanger"/);
  assert.match(tile[0], /<span class="hicon" aria-hidden="true">🎭<\/span>/);
  assert.match(tile[0], /<strong>Voice Changer<\/strong>/);
  assert.match(tile[0], /<small id="h-voicechanger">Record or upload your voice, then flick through thousands of voices, places, devices and effects\. It all runs on your own device, free\.<\/small>/);
  const at = (href) => home.indexOf(`<a class="hubitem" href="${href}"`);
  assert.ok(at('/sound-booth') > 0 && at('/sound-booth') < at('/voice-changer') && at('/voice-changer') < at('/my-creations'), 'Sound Booth, Voice Changer, My Creations');
  const create = home.slice(home.indexOf('Create and explore'), home.indexOf('id="sec-talk"'));
  assert.ok(create.includes('href="/voice-changer"'), 'under Create and explore');
  assert.equal(await bannedIn('The Voice Changer. Record or upload your voice, then flick through thousands of voices, places, devices and effects.'), null);
  for (const s of [...home.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])) new Function(s);
});

test('wiring: index.js mounts the engine, the API before /api/kade, and both pages', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const at = (s) => {
    const i = src.indexOf(s);
    assert.ok(i > 0, `index.js has ${s}`);
    return i;
  };
  const engine = at("require('./kadeVoiceChanger/serve').mountEngine(app, { logger })");
  const apiMount = at("app.use('/api/kade/voice-changer', require('./routes/kadeVoiceChanger').build())");
  const kade = at("app.use('/api/kade', routes.kade)");
  const page = at("app.get('/voice-changer', require('./routes/kadeVoiceChanger').voiceChangerPage)");
  const enginePage = at("app.get('/voice-changer/engine', require('./routes/kadeVoiceChanger').enginePage)");
  const notFound = at("app.use('/api', apiNotFound)");
  assert.ok(engine < apiMount && apiMount < kade, 'the voice changer API comes before the catch-all /api/kade router');
  assert.ok(page < notFound && enginePage < notFound);
});

test('folder-name trap: nothing under client/public/assets is called voice-changer or vc-engine', () => {
  const assets = path.join(ROOT, 'client', 'public', 'assets');
  for (const name of ['voice-changer', 'vc-engine']) assert.equal(fs.existsSync(path.join(assets, name)), false, name);
  assert.equal(fs.existsSync(path.join(ROOT, 'client', 'public', 'vc-engine')), false);
});

test('the service worker never reloads the Voice Changer as a broken chat page', () => {
  const heal = fs.readFileSync(path.join(ROOT, 'client', 'sw', 'heal.js'), 'utf8');
  const context = { self: { registration: { scope: 'https://example.test/' }, addEventListener() {} }, URL, Map, Promise, setTimeout };
  vm.runInNewContext(heal, context);
  const client = (url) => ({ frameType: 'top-level', visibilityState: 'visible', url });
  assert.equal(context.isRecoverableAppClient(client('https://example.test/voice-changer')), false);
  assert.equal(context.isRecoverableAppClient(client('https://example.test/voice-changer/engine')), false);
  assert.equal(context.isRecoverableAppClient(client('https://example.test/c/new')), true);
});

test('the models load the kadeAsset way and the default export builds lazily', () => {
  for (const f of ['kadeVoicePreset.js', 'kadeVoicePrefs.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'api', 'models', f), 'utf8');
    assert.match(src, /mongoose\.models\.\w+ \|\|\s*mongoose\.model\(/);
    new vm.Script(src);
  }
  /* KadeVoicePref (the per-character voice picks) already lives in Mongoose's default plural
   * 'kadevoiceprefs'; sharing it would mix records and break the unique index on user. */
  const collectionOf = (f) => {
    const src = fs.readFileSync(path.join(ROOT, 'api', 'models', f), 'utf8');
    const m = src.match(/mongoose\.model\(\s*'(\w+)'\s*,\s*\w+\s*(?:,\s*'([a-z0-9_]+)'\s*)?\)/);
    assert.ok(m, `${f} names its model`);
    return m[2] || m[1].toLowerCase() + 's';
  };
  const taken = collectionOf('kadeVoicePref.js');
  assert.equal(taken, 'kadevoiceprefs');
  assert.equal(collectionOf('kadeVoicePrefs.js'), 'kadevoicechangerprefs');
  assert.equal(collectionOf('kadeVoicePreset.js'), 'kadevoicechangerpresets');
  assert.equal(typeof vc, 'function', 'mounting the module itself works too');
  assert.equal(typeof vc.build, 'function');
  assert.throws(() => vc.createRouter({}), /needs auth/);
});
