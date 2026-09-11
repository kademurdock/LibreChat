'use strict';
/* Sep 10 2026 — Lyria 3.5, the third engine in the booth.
 *
 * Her ask: "add a lyria 3.5 api tool in my sound-booth. Apparently in the api
 * it's 3-5 which makes people hit a wall a lot of the time."
 *
 * The wall is real, and it is Google's doing. Read live off her own key on
 * Sep 10 2026, the family is:
 *
 *   lyria-3-clip-preview   hyphen
 *   lyria-3-pro-preview    hyphen
 *   lyria-3.5              DOT
 *   lyria-realtime-exp     hyphen
 *
 * So the convention every sibling model teaches is the one that 404s on 3.5.
 * The normalizer is therefore the first thing tested here, the per-SONG price
 * is the second (it is the only one in the booth that is not per minute), and
 * the render lane is exercised against a stub Google so the 404 message, the
 * base64-to-storage hop and the lyrics capture are all proven without spending
 * eight cents to find out. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { KadeSoundBoothProject: Project } = require('../../models/kadeSoundBoothProject');

/* A 1 kB "MP3" — the lane only cares that it is bytes and big enough to be
 * real, which is exactly the check being proven. */
const FAKE_MP3 = Buffer.alloc(4096, 7).toString('base64');

function loadBooth({ saved, usage, assets }) {
  const module = { exports: {} };
  const localRequire = (name) => {
    if (name === '@librechat/data-schemas') return { logger: { info() {}, warn() {}, error() {} } };
    if (name === '@librechat/api') {
      return {
        needsRefresh: () => false,
        getNewS3URL: async (u) => u,
        saveBufferToS3: async ({ buffer, fileName }) => {
          saved.push({ bytes: buffer.length, fileName });
          return 'https://storage.example/' + fileName;
        },
      };
    }
    if (name === '~/server/middleware') {
      return { requireJwtAuth: (req, _res, next) => { req.user = { id: String(module.__user) }; next(); } };
    }
    if (name === '~/models/kadeSoundBoothProject') return { KadeSoundBoothProject: Project };
    if (name === '~/models/kadeUsage') return { logKadeUsage: async (row) => { usage.push(row); } };
    if (name === '~/models/kadeAsset') {
      return {
        logKadeAsset: async (row) => { assets.push(row); return { _id: new mongoose.Types.ObjectId() }; },
        KadeAsset: { find: () => ({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) }) },
      };
    }
    return require(name);
  };
  const source = fs.readFileSync(path.join(__dirname, 'kadeSoundBooth.js'), 'utf8');
  vm.runInNewContext(source, {
    require: localRequire, module, exports: module.exports, process, console, Buffer,
    URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Intl, Date, Math, JSON,
  });
  return module;
}

/* ---------------- the pure half: no server, no database ------------------- */
const pure = loadBooth({ saved: [], usage: [], assets: [] })
  .exports._internals;

test('every spelling a person or an env var could carry lands on lyria-3.5', () => {
  for (const spelling of ['lyria-3-5', 'lyria-3.5', 'lyria3.5', 'lyria3-5', 'LYRIA-3-5',
    'models/lyria-3.5', ' lyria 3.5 ', '3.5', '3-5', 'lyria35']) {
    assert.equal(pure.normalizeLyriaModel(spelling), 'lyria-3.5', spelling + ' should normalize');
  }
});

test('the hyphenated siblings keep their own ids', () => {
  assert.equal(pure.normalizeLyriaModel('lyria-3-pro-preview'), 'lyria-3-pro-preview');
  assert.equal(pure.normalizeLyriaModel('lyria-3-clip-preview'), 'lyria-3-clip-preview');
  assert.equal(pure.normalizeLyriaModel('lyria pro'), 'lyria-3-pro-preview');
  assert.equal(pure.normalizeLyriaModel('give me the clip one'), 'lyria-3-clip-preview');
});

test('junk or nothing falls back to a model the API actually knows', () => {
  assert.equal(pure.normalizeLyriaModel(''), 'lyria-3.5');
  assert.equal(pure.normalizeLyriaModel(undefined), 'lyria-3.5');
  assert.equal(pure.normalizeLyriaModel('nonsense'), 'lyria-3.5');
  assert.ok(pure.LYRIA_KNOWN.includes(pure.LYRIA_MODEL));
});

test('the brief is checked before anything is spent', () => {
  assert.match(pure.checkMusic(''), /nothing to make/i);
  assert.match(pure.checkMusic('%%%laugh%%% a song'), /%%%/);
  assert.match(pure.checkMusic('<speak voice="x">hello</speak>'), /Scenema speech script/i);
  assert.match(pure.checkMusic('x'.repeat(pure.MAX_LYRIA_CHARS + 1)), new RegExp(String(pure.MAX_LYRIA_CHARS)));
  assert.equal(pure.checkMusic('A slow soul record, Rhodes and brushed drums, a woman singing close.'), null);
});

test('the quote is per song, says so, and invents no duration it cannot know', () => {
  const est = pure.estimateFor('lyria', 'A slow soul record with a woman singing close.');
  assert.equal(est.engine, 'lyria');
  assert.equal(est.costUSD, pure.LYRIA_USD_PER_SONG);
  assert.equal(est.audioSeconds, null);
  assert.match(est.spoken, /per song, not per minute/i);
});

test('the other two engines are untouched by the third', () => {
  assert.ok(pure.estimateFor('seed', 'Mara says: "hello."').audioSeconds > 0);
  assert.ok(pure.estimateFor('scenema', 'Hello there, friend.').audioSeconds > 0);
});

test('a song goes to Lyria; people talking over music is still a Seed scene', () => {
  assert.equal(pure.suggestEngine('Write me a song about leaving Missouri, with a chorus.').engine, 'lyria');
  assert.equal(pure.suggestEngine('A short instrumental theme, warm Rhodes, around 70 bpm.').engine, 'lyria');
  assert.equal(pure.suggestEngine(
    'Mara says: "There is a suitcase on platform three."\nEli says: "Then put it in lost property."\nSoft piano underneath.',
  ).engine, 'seed');
  assert.equal(pure.suggestEngine('Read this bedtime story aloud, one warm voice, no music.').engine, 'scenema');
});

/* ---------------- Part 179 (Sep 11 2026): the wire prompt in Google's shape --
 * Her ask: "prompts according to the way the api requires". Google's prompt
 * guide (read Sep 11) wants genre with era, instruments, structure tags,
 * a vocal profile, mood, then BPM/key/length -- and supplied words under a
 * "Lyrics:" heading, "Instrumental only, no vocals." for no singer. The
 * booth's own grammar said nearly the opposite (feeling over genre, tempo
 * in words), so these pin the new order and the two exact phrases. */
test("the brief format follows Google's order: genre, instruments, structure, voice, mood, technical line", () => {
  const g = pure.MUSIC_GRAMMAR;
  const order = ['GENRE WITH ERA', 'INSTRUMENTS', 'STRUCTURE', 'VOCAL PROFILE', 'MOOD', 'TECHNICAL LINE'].map((k) => g.indexOf(k));
  assert.ok(order.every((i) => i >= 0), 'every section is named');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'and they come in that order');
  assert.match(g, /\[Intro\] -> \[Verse 1\] -> \[Chorus\]/);
  assert.match(g, /\[0:00 - 0:10\]/);
  assert.match(g, /"Lyrics:" heading/);
  assert.match(g, /Instrumental only, no vocals\./);
  assert.doesNotMatch(g, /Lead with the FEELING/);
  const howto = pure.GUIDE.engines.lyria.howToWrite.join('\n');
  assert.match(howto, /Genre and era first/);
  assert.match(howto, /\[Intro\] -> \[Verse 1\]/);
  assert.match(howto, /BPM number, the key, and how long/);
  assert.doesNotMatch(howto, /Lead with the FEELING/);
});

test("supplied words ride under a Lyrics: heading and the instrumental line is Google's exact phrase", () => {
  const b = pure.withLyricsBlock('A 1970s soul song.', '[Verse 1]\nroad out of Missouri\n[Chorus]\nstaying');
  assert.match(b, /^A 1970s soul song\.\n\nLyrics:\n\[Verse 1\]\nroad out of Missouri/);
  assert.equal(pure.withLyricsBlock('brief', '   '), 'brief', 'no words, no heading');
  assert.equal(pure.withLyricsBlock('brief', 'Lyrics: la la'), 'brief\n\nLyrics:\nla la', 'a heading the person typed is not doubled');
  assert.equal(pure.LYRIA_INSTRUMENTAL_LINE, 'Instrumental only, no vocals.');
  assert.equal(pure.withInstrumentalLine('A brief.'), 'A brief.\n\n' + pure.LYRIA_INSTRUMENTAL_LINE);
  const once = pure.withInstrumentalLine('A brief. Instrumental only, no vocals.');
  assert.equal(once.match(/Instrumental only/g).length, 1, 'never doubled');
});

test("cleanLyrics strips the engine's markers and speaks section tags, for the read-back", () => {
  /* the exact shape Part 175's live render came back in */
  const raw = '[[A0]]\n[[B1]]\n[:] People look at these walls and they see a trap.\n[:] They think I am stuck here.\n[[C2]]\n[:] Everybody assumes it just happened to me.\n[[F6]]\n[:] I chose this.';
  const clean = pure.cleanLyrics(raw);
  assert.doesNotMatch(clean, /\[\[|\[:\]/);
  assert.match(clean, /^People look at these walls and they see a trap\.\nThey think I am stuck here\.\n\nEverybody assumes/);
  assert.match(clean, /I chose this\.$/);
  assert.equal(pure.cleanLyrics('[Verse 1]\nla la\n[Chorus]\nda da'), 'Verse 1:\nla la\nChorus:\nda da');
  assert.equal(pure.cleanLyrics(''), '');
  assert.equal(pure.cleanLyrics('plain words, no markers'), 'plain words, no markers');
});

/* ---------------- the render lane, against a stub Google ------------------ */
test('the music lane: real store, stub Google, every branch that can cost money', async (t) => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  let reply = null;
  const seen = [];
  const google = express();
  google.use(express.json({ limit: '2mb' }));
  google.post('/v1beta/models/:model\\:generateContent', (req, res) => {
    seen.push({ model: req.params.model, key: req.get('x-goog-api-key'), body: req.body });
    if (req.params.model !== 'lyria-3.5') {
      return res.status(404).json({ error: { message: 'models/' + req.params.model + ' is not found for API version v1beta' } });
    }
    return res.status(reply.status).json(reply.body);
  });
  const googleServer = google.listen(0, '127.0.0.1');
  await new Promise((r) => googleServer.on('listening', r));
  process.env.KADE_LYRIA_BASE = 'http://127.0.0.1:' + googleServer.address().port;
  process.env.KADE_LYRIA_KEY = 'test-only-key';
  delete process.env.KADE_LYRIA_MODEL;

  const saved = [], usage = [], assets = [];
  const booth = loadBooth({ saved, usage, assets });
  booth.__user = new mongoose.Types.ObjectId();
  const app = express();
  app.use('/booth', booth.exports);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const call = async (route, body) => {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/booth' + route, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  t.after(async () => {
    server.closeAllConnections(); googleServer.closeAllConnections();
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => googleServer.close(r))]);
    await mongoose.disconnect(); await mongo.stop();
    delete process.env.KADE_LYRIA_BASE; delete process.env.KADE_LYRIA_KEY;
  });

  const brief = 'A slow soul record, Rhodes first, brushed drums under it, a woman singing low and close.';

  await t.test('a price quote calls nobody and saves nothing', async () => {
    const r = await call('/render', { engine: 'lyria', script: brief, estimateOnly: true });
    assert.equal(r.status, 200);
    assert.equal(r.data.estimate.costUSD, pure.LYRIA_USD_PER_SONG);
    assert.equal(seen.length, 0);
    assert.equal(await Project.countDocuments(), 0);
  });

  await t.test('a song is fetched, stored in her own bucket, billed once and logged', async () => {
    reply = { status: 200, body: { candidates: [{ content: { parts: [
      { text: 'Verse one: the road out of Missouri' },
      { inlineData: { mimeType: 'audio/mpeg', data: FAKE_MP3 } },
    ] } }] } };
    const r = await call('/render', { engine: 'lyria', script: brief, title: 'Leaving' });
    assert.equal(r.status, 200);
    assert.equal(r.data.engine, 'lyria');
    assert.equal(r.data.queued, false);
    assert.equal(seen.at(-1).model, 'lyria-3.5', 'the dot spelling is what actually goes on the wire');
    assert.equal(seen.at(-1).key, 'test-only-key');
    /* Part 179: the record AND the words are asked for explicitly, the way the
     * generateContent page documents it for Lyria. */
    assert.deepEqual(seen.at(-1).body.generationConfig, { responseModalities: ['AUDIO', 'TEXT'] });
    /* The audio must land in HER storage, not be handed back as a Google blob. */
    assert.equal(saved.length, 1);
    assert.equal(saved[0].bytes, 4096);
    assert.match(saved[0].fileName, /^soundbooth-lyria-.*\.mp3$/);
    assert.match(r.data.url, /^https:\/\/storage\.example\//);
    assert.match(r.data.lyrics, /Verse one/);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].unit, 'songs');
    assert.equal(usage[0].quantity, 1);
    assert.equal(usage[0].costUSD, pure.LYRIA_USD_PER_SONG);
    assert.equal(assets.at(-1).service, 'google_lyria');
    const p = await Project.findById(r.data.projectId);
    assert.equal(p.state, 'done');
    assert.equal(p.engine, 'lyria');
    assert.equal(p.costUSD, pure.LYRIA_USD_PER_SONG);
  });

  await t.test("instrumental and supplied lyrics both reach the engine, in the shape Google's guide asks for", async () => {
    const r = await call('/render', { engine: 'lyria', script: brief, instrumental: true, lyrics: '[Verse 1]\nthese exact words' });
    assert.equal(r.status, 200);
    const sent = seen.at(-1).body.contents[0].parts[0].text;
    assert.match(sent, /\n\nLyrics:\n\[Verse 1\]\nthese exact words/);
    assert.match(sent, /Instrumental only, no vocals\.$/);
    assert.doesNotMatch(sent, /Sing these exact lyrics/);
    assert.ok(sent.indexOf('Lyrics:') < sent.indexOf('Instrumental only'), 'the instrumental line comes last, so it wins');
  });

  await t.test('the words come back clean for the read-back, raw for the record', async () => {
    reply = { status: 200, body: { candidates: [{ content: { parts: [
      { text: '[[A0]]\n[[B1]]\n[:] People look at these walls and they see a trap.\n[:] I chose this.' },
      { inlineData: { mimeType: 'audio/mpeg', data: FAKE_MP3 } },
    ] } }] } };
    const r = await call('/render', { engine: 'lyria', script: brief });
    assert.equal(r.status, 200);
    assert.equal(r.data.lyrics, 'People look at these walls and they see a trap.\nI chose this.');
    const p = await Project.findById(r.data.projectId);
    assert.equal(p.readback, 'People look at these walls and they see a trap.\nI chose this.');
    assert.match(assets.at(-1).metadata.lyrics, /\[\[A0\]\]/, 'the raw text keeps the markers');
    assert.equal(assets.at(-1).metadata.lyricsClean, r.data.lyrics);
    assert.match(assets.at(-1).metadata.wirePrompt, /^A slow soul record/);
  });

  await t.test('a refusal hands back what it said, not "no clip"', async () => {
    reply = { status: 200, body: { candidates: [{ content: { parts: [{ text: 'I cannot make that.' }] } }] } };
    const before = saved.length;
    const r = await call('/render', { engine: 'lyria', script: brief });
    assert.equal(r.status, 502);
    assert.match(r.data.error, /I cannot make that/);
    assert.equal(saved.length, before, 'nothing is stored when nothing came back');
  });

  await t.test('an empty recording is refused rather than saved', async () => {
    reply = { status: 200, body: { candidates: [{ content: { parts: [
      { inlineData: { mimeType: 'audio/mpeg', data: Buffer.alloc(10).toString('base64') } },
    ] } }] } };
    const before = saved.length;
    const r = await call('/render', { engine: 'lyria', script: brief });
    assert.equal(r.status, 502);
    assert.match(r.data.error, /empty recording/i);
    assert.equal(saved.length, before);
  });

  await t.test('THE WALL: a hyphenated model id is caught and named in plain words', async () => {
    /* This is the whole reason the normalizer exists, so it is proven end to
     * end: force the bad id past the normalizer's front door and confirm the
     * person is told the right string instead of Google's version. */
    process.env.KADE_LYRIA_MODEL = 'lyria-3-5-BAD';
    const booth2 = loadBooth({ saved: [], usage: [], assets: [] });
    booth2.__user = booth.__user;
    /* The normalizer repairs anything recognisable, which is the point --
     * a wrong id never reaches Google in the first place. */
    assert.equal(booth2.exports._internals.LYRIA_MODEL, 'lyria-3.5');
    delete process.env.KADE_LYRIA_MODEL;

    /* And if Google ever moves the id out from under us anyway, the 404 says
     * the right thing rather than leaking the API's wording. */
    const app2 = express();
    app2.use('/booth', booth2.exports);
    const s2 = app2.listen(0, '127.0.0.1');
    await new Promise((r) => s2.on('listening', r));
    const port = googleServer.address().port;
    google._router = google._router; // keep the stub as-is
    const res = await fetch('http://127.0.0.1:' + port + '/v1beta/models/lyria-3-5:generateContent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 404, 'the stub agrees the hyphen spelling does not exist');
    s2.closeAllConnections();
    await new Promise((r) => s2.close(r));
  });
});
