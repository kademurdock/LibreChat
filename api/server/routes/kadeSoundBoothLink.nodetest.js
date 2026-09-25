/* Part 293: the Sound Booth's YouTube link for a YuE2 cover.
 *
 * The file route and the link route run from the real kadeSoundBooth.js source
 * (the /reference region, sliced out and run with fakes for storage and the
 * duration probe, the way soundBoothReference.selftest.cjs does), so the test
 * holds them to the SAME answer shape. yt-dlp is never run: youtubeAudio is a
 * fake that answers the way packages/api description/youtube.ts does.
 *
 * Run: node --test api/server/routes/kadeSoundBoothLink.nodetest.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const link = require('./kadeSoundBoothLink');

/* ---------- the real musicReferenceError, compiled from lyrics.ts ---------- */
function musicLyrics() {
  const ts = require('typescript');
  const filename = path.resolve(__dirname, '../../../packages/api/src/music/lyrics.ts');
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = module.paths;
  // form-data is only used by the transcriber, which this test never calls.
  compiled.require = (id) => (id === 'form-data' ? function FormData() {} : Module.prototype.require.call(compiled, id));
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  compiled._compile(source, filename);
  return compiled.exports;
}
const { musicReferenceError } = musicLyrics();

/* ---------- the /reference region of kadeSoundBooth.js, with fakes ---------- */
const booth = fs.readFileSync(path.join(__dirname, 'kadeSoundBooth.js'), 'utf8');
function loadRoutes(fakes) {
  const routes = {};
  const context = {
    router: {
      post(route, ...handlers) { routes[route] = handlers.at(-1); },
      use() {},
    },
    requireJwtAuth() {},
    refUpload: { single() {} },
    REF_EXT: { 'audio/mpeg': 'mp3' },
    ENGINE_REF_FORMATS: { seed: { exts: ['wav', 'mp3', 'm4a', 'ogg'], say: 'x' }, scenema: { exts: ['mp3'], say: 'x' } },
    musicReferenceError,
    saveBufferToS3: fakes.saveBufferToS3,
    registerMusicReference: fakes.registerMusicReference,
    logger: fakes.logger,
    Date,
    Math,
    require(name) {
      if (name === './kadeSoundBoothStitch') return { durationOf: fakes.durationOf, normalizeReferenceClip: async () => null };
      if (name === './kadeSoundBoothLink') {
        return { ...link, createReferenceLinkRouter: (deps) => { routes.linkDeps = deps; return 'link router'; } };
      }
      if (name === '~/server/services/kadeFunding') return { isReviewSeat: fakes.isReviewSeat };
      if (name === '@librechat/api') return fakes.api;
      throw new Error('unexpected require ' + name);
    },
  };
  const start = booth.indexOf("router.post('/reference',");
  const end = booth.indexOf('/* ============================ POST /idea', start);
  assert.ok(start > 0 && end > start, 'the /reference region is where the test expects it');
  vm.runInNewContext(booth.slice(start, end), context);
  assert.equal(typeof routes['/reference'], 'function');
  assert.ok(routes.linkDeps, 'the link router is mounted in the /reference region');
  return routes;
}

function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.writableEnded = false;
  res.destroyed = false;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.writableEnded = true; res.emit('finish'); return res; };
  return res;
}

class FakeYouTubeError extends Error {
  constructor(kind, seconds) {
    super('detail for the log: ' + kind);
    this.kind = kind;
    this.seconds = seconds;
  }
}

/** A fresh world: fake storage, a fake YouTube, and the routes wired to them. */
function world(overrides = {}) {
  const w = {
    logs: [],
    stored: [],
    registered: [],
    downloads: [],
    seconds: 192.4,
    reviewSeat: false,
    download: async () => ({ buffer: Buffer.alloc(4096, 1), title: 'Sunny Day (Official Audio)', seconds: 192, uploader: 'Some Band', id: 'dQw4w9WgXcQ', link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
    ...overrides,
  };
  const logger = { info: (m) => w.logs.push(['info', m]), warn: (m) => w.logs.push(['warn', m]), error: (m) => w.logs.push(['error', String(m)]) };
  w.routes = loadRoutes({
    logger,
    durationOf: async () => w.seconds,
    saveBufferToS3: async ({ buffer, fileName }) => { w.stored.push({ buffer, fileName }); return 'https://assets.test/audios/' + fileName; },
    registerMusicReference: async (...args) => { w.registered.push(args); },
    isReviewSeat: () => w.reviewSeat,
    api: {
      readYouTubeLink: (text) => {
        const m = /youtu\.?be(?:\.com)?\/(?:watch\?v=)?([\w-]{11})/.exec(text);
        if (/vimeo/.test(text)) return { problem: 'not-youtube' };
        return m ? { id: m[1], url: 'https://www.youtube.com/watch?v=' + m[1] } : { problem: 'not-link' };
      },
      youtubeAudio: async (url, options) => { w.downloads.push({ url, options }); return w.download(url, options); },
    },
  });
  w.state = { cap: overrides.cap || link.dailyCap(20, () => '2026-09-25'), running: new Set() };
  w.deps = { ...w.routes.linkDeps, deadlineMs: overrides.deadlineMs, env: overrides.env || {} };
  w.link = async (body, user = { id: 'u1' }) => {
    const res = fakeRes();
    await link.handleReferenceLink({ user, body }, res, w.deps, w.state);
    return res;
  };
  w.file = async (engine = 'yue2') => {
    const res = fakeRes();
    await w.routes['/reference']({ user: { id: 'u1' }, body: { engine }, file: { buffer: Buffer.alloc(4096, 2), mimetype: 'audio/mpeg', originalname: 'song.mp3' } }, res);
    return res;
  };
  return w;
}

test('same shape: a YouTube link answers exactly like a file import, plus the title and length', async () => {
  const w = world();
  const file = await w.file();
  const viaLink = await w.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ?list=RD1' });
  assert.equal(file.statusCode, 200);
  assert.equal(viaLink.statusCode, 200);
  assert.deepEqual(Object.keys(viaLink.body).filter((key) => key !== 'source'), Object.keys(file.body));
  for (const key of ['ok', 'bytes', 'seconds', 'ext']) assert.equal(typeof viaLink.body[key], typeof file.body[key], key);
  assert.equal(viaLink.body.ext, 'mp3');
  assert.equal(viaLink.body.name, 'Sunny Day (Official Audio)');
  assert.equal(viaLink.body.seconds, 192.4, 'measured the same way a file is');
  const plain = (value) => JSON.parse(JSON.stringify(value)); // objects made inside the vm have its prototypes
  assert.deepEqual(plain(viaLink.body.source), { site: 'youtube', title: 'Sunny Day (Official Audio)', seconds: 192, link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  assert.match(viaLink.body.spoken, /^Covering Sunny Day \(Official Audio\), 3 minutes 12 seconds, from YouTube\. The full original is kept\. Choose Transcribe reference lyrics/);
  assert.match(file.body.spoken, /^Clip imported, 192\.4 seconds\./, 'the file import still says what it said');
  // The storage tail is shared: the same folder, and the source is kept with the reference.
  assert.equal(w.stored.length, 2);
  assert.match(w.stored[1].fileName, /^soundbooth-ref-.*\.mp3$/);
  assert.equal(w.registered[0][3], null, 'a file import has no source');
  assert.deepEqual(plain(w.registered[1].slice(2)), [192.4, { site: 'youtube', title: 'Sunny Day (Official Audio)', seconds: 192, link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', id: 'dQw4w9WgXcQ' }]);
  // The downloader got the plain link and the booth's limits.
  assert.equal(w.downloads[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(w.downloads[0].options.maxSeconds, 360);
  assert.equal(w.downloads[0].options.maxBytes, 20 * 1024 * 1024);
  assert.ok(w.downloads[0].options.signal instanceof AbortSignal);
  assert.equal(w.state.running.size, 0);
});

test('duration: the downloader refuses a long video before downloading, said like a long file', async () => {
  const w = world({ download: async () => { throw new FakeYouTubeError('too-long', 433.1); } });
  const res = await w.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.kind, 'too-long');
  assert.match(res.body.error, /^This YouTube video is 7 minutes 13 seconds long\. Covers support up to 6 minutes\./);
  assert.equal(w.stored.length, 0);
  // A measured MP3 over six minutes is refused by the shared tail, as a file would be.
  const w2 = world();
  w2.seconds = 433.1;
  const tail = await w2.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(tail.statusCode, 400);
  assert.match(tail.body.error, /7 minutes 13 seconds long\. Covers support up to 6 minutes/);
  assert.equal(w2.stored.length, 0);
});

test('App Review: the review seat is refused with a neutral sentence and is never shown the field', async () => {
  const w = world({ reviewSeat: true });
  const res = await w.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, link.REVIEW_WORDS);
  assert.doesNotMatch(res.body.error, /YouTube|review|Apple/i);
  assert.equal(w.downloads.length, 0);

  const boothGuide = () => {
    const a = booth.indexOf('const GUIDE = ') + 14;
    const b = booth.indexOf('\n};', a) + 2;
    return vm.runInNewContext('(' + booth.slice(a, b) + ')', {
      effectsGuide: {}, SCREENPLAY_HELP: '', yueCost: '', yueStylesEnabled: () => false, yueStyles: {},
    });
  };
  const GUIDE = boothGuide();
  const before = JSON.stringify(GUIDE);
  const cover = (g) => g.engines.yue2.settings.find((s) => s.key === 'reference_voice_url');
  assert.match(cover(GUIDE).hint, /You can also paste a YouTube link to a song\./);

  const family = link.guideFor(GUIDE, { id: 'u1' }, () => false, {});
  assert.deepEqual(cover(family).link, {
    site: 'youtube', label: 'Or paste a YouTube link', hint: cover(family).link.hint,
    button: 'Import from YouTube', path: '/api/kade/sound-booth/reference/link', maxSeconds: 360,
  });
  assert.match(cover(family).hint, /paste a YouTube link/);

  const reviewer = link.guideFor(GUIDE, { id: 'review' }, () => true, {});
  assert.equal(cover(reviewer).link, undefined);
  assert.doesNotMatch(JSON.stringify(reviewer.engines.yue2), /YouTube/);
  assert.match(cover(reviewer).hint, /^Import one song, up to six minutes\. YuE2 uses its melody/);

  const unsure = link.guideFor(GUIDE, { id: 'u1' }, () => { throw new Error('lookup failed'); }, {});
  assert.equal(cover(unsure).link, undefined, 'unsure means hidden');
  const switchedOff = link.guideFor(GUIDE, { id: 'u1' }, () => false, { KADE_SOUNDBOOTH_YT_LINKS: '0' });
  assert.equal(cover(switchedOff).link, undefined);
  assert.equal(JSON.stringify(GUIDE), before, 'the shared guide is never changed');
  assert.equal(link.guideFor(GUIDE, { id: 'u1' }, () => false, {}).engines.scenema, GUIDE.engines.scenema);
  // A child account is not the review seat and keeps the field.
  assert.ok(cover(link.guideFor(GUIDE, { id: 'child', kadeAccountType: 'child' }, () => false, {})).link);
});

test('words: the bot wall, private, age-restricted and removed videos are said plainly', () => {
  const say = (kind) => link.linkWords(new FakeYouTubeError(kind));
  assert.equal(say('bot'), 'YouTube is blocking the server right now. Try again in a few minutes, or download the song and import the file.');
  assert.equal(link.linkStatus(new FakeYouTubeError('bot')), 503);
  assert.match(say('private'), /^This YouTube video is private/);
  assert.match(say('age'), /age-restricted/);
  assert.match(say('removed'), /has been removed/);
  assert.match(say('not-youtube'), /^That is not a YouTube link\./);
  assert.match(say('not-video'), /channel or a playlist/);
  assert.match(say('timeout'), /took too long/);
  assert.equal(say('something new'), link.WORDS.failed);
  assert.equal(link.linkWords(new Error('plain')), link.WORDS.failed);
  assert.equal(link.spokenMinutes(61), '1 minute 1 second');
  assert.equal(link.spokenMinutes(45), '45 seconds');
  assert.equal(link.spokenMinutes(120), '2 minutes');
  assert.equal(link.clock(192.4), '3:12');
  assert.equal(link.clock(65), '1:05');
});

test('refusals: not YouTube, not YuE2, empty, and failures from YouTube come back in the booth voice', async () => {
  const w = world();
  let res = await w.link({ engine: 'yue2', url: 'https://vimeo.com/123' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, link.WORDS['not-youtube']);
  res = await w.link({ engine: 'scenema', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /YuE2 covers/);
  res = await w.link({ engine: 'yue2', url: '   ' });
  assert.equal(res.statusCode, 400);
  assert.equal(w.downloads.length, 0);

  const walled = world({ download: async () => { throw new FakeYouTubeError('bot'); } });
  res = await walled.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'YouTube is blocking the server right now. Try again in a few minutes, or download the song and import the file.');
  const failed = walled.logs.find(([level, line]) => level === 'warn' && /link FAILED/.test(line));
  assert.match(failed[1], /^\[soundbooth\/reference\] link FAILED user=u1 video=dQw4w9WgXcQ kind=bot/);
  assert.equal(walled.state.running.size, 0);

  const gone = world({ download: async () => { throw new FakeYouTubeError('private'); } });
  res = await gone.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(res.statusCode, 422);
  assert.match(res.body.error, /private/);
});

test('caps: one import at a time per person, and a daily cap', async () => {
  let release;
  const w = world({ download: () => new Promise((resolve) => { release = () => resolve({ buffer: Buffer.alloc(4096, 1), title: 'Song', seconds: 100, id: 'dQw4w9WgXcQ', link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }); }) });
  const first = w.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await w.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(second.statusCode, 409);
  release();
  assert.equal((await first).statusCode, 200);

  const capped = world({ cap: link.dailyCap(2, () => '2026-09-25') });
  assert.equal((await capped.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' })).statusCode, 200);
  assert.equal((await capped.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' })).statusCode, 200);
  const third = await capped.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(third.statusCode, 429);
  assert.match(third.body.error, /2 YouTube imports today/);
  // A link that is not YouTube is refused before the cap counts it.
  const day = link.dailyCap(1, () => '2026-09-25');
  const w2 = world({ cap: day });
  await w2.link({ engine: 'yue2', url: 'https://vimeo.com/1' });
  assert.equal((await w2.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' })).statusCode, 200);
  // A new day starts a new count.
  let today = '2026-09-25';
  const rolling = link.dailyCap(1, () => today);
  assert.equal(rolling.take('u1'), true);
  assert.equal(rolling.take('u1'), false);
  today = '2026-09-26';
  assert.equal(rolling.take('u1'), true);
});

test('deadline and hang-up: the import is stopped, answered once, and the person is freed', async () => {
  const waitForAbort = async (_url, options) =>
    new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new FakeYouTubeError('timeout')), { once: true }));
  const w = world({ deadlineMs: 50, download: waitForAbort });
  const res = await w.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(res.statusCode, 504);
  assert.match(res.body.error, /took too long/);
  assert.equal(w.state.running.size, 0);

  const left = world({ download: waitForAbort });
  const res2 = fakeRes();
  const pending = link.handleReferenceLink({ user: { id: 'u1' }, body: { engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' } }, res2, left.deps, left.state);
  await new Promise((resolve) => setImmediate(resolve));
  res2.destroyed = true;
  res2.emit('close');
  await pending;
  assert.equal(res2.body, undefined, 'nobody is answered after they leave');
  assert.ok(left.downloads[0].options.signal.aborted);
  assert.equal(left.state.running.size, 0);
  assert.equal(left.stored.length, 0);
});
