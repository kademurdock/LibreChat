/* Part 293: the Sound Booth's media link for a YuE2 cover (YouTube, other big
 * media sites, or a direct audio/video file), behind the Family feature pack.
 *
 * The file route and the link route run from the real kadeSoundBooth.js source
 * (the /reference region, sliced out and run with fakes for storage and the
 * duration probe, the way soundBoothReference.selftest.cjs does), so the test
 * holds them to the SAME answer shape. The real readMediaLink (packages/api
 * description/links.ts) reads every pasted link; yt-dlp is never run:
 * mediaAudio is a fake that answers the way links.ts does, except in the
 * six-minute test, which runs the real chain with a fake yt-dlp.
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

const tsx = require('tsx/cjs/api');
const links = tsx.require('../../../packages/api/src/description/links.ts', __filename);
const pack = tsx.require('../../../packages/api/src/family/pack.ts', __filename);

/* ---------- the real musicReferenceError, compiled from lyrics.ts ---------- */
function musicLyrics() {
  const ts = require('typescript');
  const filename = path.resolve(__dirname, '../../../packages/api/src/music/lyrics.ts');
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = module.paths;
  // form-data and the logger are only used by the transcriber, which this test never calls.
  const stubs = { 'form-data': function FormData() {}, '@librechat/data-schemas': { logger: { info() {}, warn() {}, error() {} } } };
  compiled.require = (id) => (id in stubs ? stubs[id] : Module.prototype.require.call(compiled, id));
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

const VISCHECK = '6a6125d73939d20b95251078'; // the App Review seat
const BOB = '6b0000000000000000000000'; // an account made long after the family cutoff
const EARLY_REVIEW = '6a3f47e79be0146175d0e3e7'; // made before the cutoff; a review seat only when listed

/** A fresh world: fake storage, a fake downloader, the real link reader, and the routes wired to them. */
function world(overrides = {}) {
  const w = {
    logs: [],
    stored: [],
    registered: [],
    downloads: [],
    seconds: 192.4,
    pack: true,
    download: async (found) => ({
      buffer: Buffer.alloc(4096, 1), title: 'Sunny Day (Official Audio)', seconds: 192, uploader: 'Some Band',
      id: found.id, link: found.url, site: found.site, siteName: found.siteName,
    }),
    ...overrides,
  };
  const logger = { info: (m) => w.logs.push(['info', m]), warn: (m) => w.logs.push(['warn', m]), error: (m) => w.logs.push(['error', String(m)]) };
  w.routes = loadRoutes({
    logger,
    durationOf: async (buffer) => (w.durationOf ? w.durationOf(buffer) : w.seconds),
    saveBufferToS3: async ({ buffer, fileName }) => { w.stored.push({ buffer, fileName }); return 'https://assets.test/audios/' + fileName; },
    registerMusicReference: async (...args) => { w.registered.push(args); },
    api: {
      readMediaLink: links.readMediaLink,
      mediaAudio: async (found, options) => { w.downloads.push({ link: found, options }); return w.download(found, options); },
      familyFeatures: (user) => (w.features ? w.features(user) : { mediaLinks: w.pack, describerLinks: true, jukeboxLinks: true, familyLibrary: w.pack }),
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

const plain = (value) => JSON.parse(JSON.stringify(value)); // objects made inside the vm have its prototypes

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
  assert.deepEqual(plain(viaLink.body.source), { site: 'youtube', title: 'Sunny Day (Official Audio)', seconds: 192, link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  assert.match(viaLink.body.spoken, /^Covering Sunny Day \(Official Audio\), 3 minutes 12 seconds, from YouTube\. The full original is kept\. Choose Transcribe reference lyrics/);
  assert.match(file.body.spoken, /^Clip imported, 192\.4 seconds\./, 'the file import still says what it said');
  // The storage tail is shared: the same folder, and the source is kept with the reference.
  assert.equal(w.stored.length, 2);
  assert.match(w.stored[1].fileName, /^soundbooth-ref-.*\.mp3$/);
  assert.equal(w.registered[0][3], null, 'a file import has no source');
  assert.deepEqual(plain(w.registered[1].slice(2)), [192.4, { site: 'youtube', title: 'Sunny Day (Official Audio)', seconds: 192, link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', id: 'dQw4w9WgXcQ' }]);
  // The downloader got the plain link and the booth's limits.
  assert.equal(w.downloads[0].link.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(w.downloads[0].link.site, 'youtube');
  assert.equal(w.downloads[0].options.maxSeconds, 360);
  assert.equal(w.downloads[0].options.maxBytes, 20 * 1024 * 1024);
  assert.ok(w.downloads[0].options.signal instanceof AbortSignal);
  assert.equal(w.state.running.size, 0);
});

test('media sites and direct files: the same shape, named with where the song came from', async () => {
  const w = world();
  const cloud = await w.link({ engine: 'yue2', url: 'https://soundcloud.com/some-band/sunny-day' });
  assert.equal(cloud.statusCode, 200);
  assert.deepEqual(plain(cloud.body.source), { site: 'soundcloud', title: 'Sunny Day (Official Audio)', seconds: 192, link: 'https://soundcloud.com/some-band/sunny-day' });
  assert.match(cloud.body.spoken, /^Covering Sunny Day \(Official Audio\), 3 minutes 12 seconds, from SoundCloud\./);
  const file = await w.link({ engine: 'yue2', url: 'https://cdn.example.com/music/sunny-day.mp3' });
  assert.equal(file.statusCode, 200);
  assert.equal(file.body.source.site, 'file');
  assert.match(file.body.spoken, /, from the link\./);
  assert.deepEqual(w.downloads.map((d) => d.link.kind), ['site', 'file']);
  assert.equal(Object.keys(file.body).filter((key) => key !== 'source').join(), Object.keys(cloud.body).filter((key) => key !== 'source').join());
  assert.equal(link.siteLabel('archive'), 'the Internet Archive');
  assert.equal(link.siteLabel('something-new'), 'the link');
});

test('duration: the downloader refuses a long video before downloading, said like a long file', async () => {
  const w = world({ download: async () => { throw new FakeYouTubeError('too-long', 433.1); } });
  const res = await w.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.kind, 'too-long');
  assert.match(res.body.error, /^This YouTube video is 7 minutes 13 seconds long, and covers from YouTube must be shorter than 6 minutes\./);
  assert.equal(w.stored.length, 0);
  // Listed at exactly six minutes: refused too, and the sentence never says "6 minutes ... up to 6 minutes".
  const edge = world({ download: async () => { throw new FakeYouTubeError('too-long', 360); } });
  const six = await edge.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(six.statusCode, 400);
  assert.match(six.body.error, /^This YouTube video is 6 minutes long, and covers from YouTube must be shorter than 6 minutes\./);
  assert.doesNotMatch(six.body.error, /up to/);
  const cloud = await edge.link({ engine: 'yue2', url: 'https://soundcloud.com/band/long-song' });
  assert.match(cloud.body.error, /^This song from SoundCloud is 6 minutes long, and covers from a link must be shorter than 6 minutes\. Choose a shorter song/);
  // A measured MP3 over six minutes is refused by the shared tail, as a file would be.
  const w2 = world();
  w2.seconds = 433.1;
  const tail = await w2.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(tail.statusCode, 400);
  assert.match(tail.body.error, /7 minutes 13 seconds long\. Covers support up to 6 minutes/);
  assert.equal(w2.stored.length, 0);
});

const boothGuide = () => {
  const a = booth.indexOf('const GUIDE = ') + 14;
  const b = booth.indexOf('\n};', a) + 2;
  return vm.runInNewContext('(' + booth.slice(a, b) + ')', {
    effectsGuide: {}, SCREENPLAY_HELP: '', yueCost: '', yueStylesEnabled: () => false, yueStyles: {},
  });
};
const cover = (g) => g.engines.yue2.settings.find((s) => s.key === 'reference_voice_url');

test('Family feature pack: without it the route refuses in plain words, and nothing is fetched', async () => {
  assert.equal(link.PACK_NOTE, pack.FAMILY_PACK_NOTE, 'the booth says what the pack helper says');
  assert.equal(link.PACK_REFUSAL, pack.FAMILY_PACK_REFUSAL);
  const w = world({ pack: false });
  const res = await w.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Media links are part of the Family feature pack. Ask Kade to add it to your account.');
  assert.equal(res.body.pack, true);
  assert.equal(w.downloads.length, 0);
  assert.equal(w.state.running.size, 0);
  assert.match(w.logs.find(([level]) => level === 'warn')[1], /link REFUSED user=u1: not in the Family feature pack/);
  // The real rule: the App Review seat and "bob" (made after the cutoff) are out; a family account is in.
  const real = world({ features: (user) => pack.familyFeatures(user, {}) });
  for (const user of [{ id: VISCHECK }, { id: VISCHECK, kadeLibraryAccess: 'family' }, { id: BOB }]) {
    assert.equal((await real.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' }, user)).statusCode, 403, user.id);
  }
  assert.equal(real.downloads.length, 0);
  assert.equal((await real.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' }, { id: BOB, kadeLibraryAccess: 'family' })).statusCode, 200);
  assert.equal((await real.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' }, { id: BOB, role: 'ADMIN' })).statusCode, 200);
  // A lookup that throws never opens the downloader.
  const unsure = world({ features: () => { throw new Error('lookup failed'); } });
  assert.equal((await unsure.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' })).statusCode, 403);
  // The kill switch refuses everyone, pack or not.
  const off = world({ env: { KADE_SOUNDBOOTH_YT_LINKS: '0' } });
  const refused = await off.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.body.error, link.SWITCHED_OFF);
  assert.equal(off.downloads.length, 0);
});

test('Family feature pack: the guide greys the field out for everyone else, never hides it', () => {
  const GUIDE = boothGuide();
  const before = JSON.stringify(GUIDE);
  assert.match(cover(GUIDE).hint, /You can also paste a media link to a song, from YouTube or another media site\./);

  const family = link.guideFor(GUIDE, { id: 'u1' }, () => ({ mediaLinks: true }), {});
  assert.deepEqual(cover(family).link, {
    site: 'media', label: 'Or paste a media link (YouTube and other sites)', hint: cover(family).link.hint,
    button: 'Import from link', path: '/api/kade/sound-booth/reference/link', maxSeconds: 360, available: true,
  });
  assert.match(cover(family).link.hint, /YouTube, SoundCloud, Bandcamp, Vimeo, TikTok, Instagram, Facebook, X, Reddit, Dailymotion, Twitch clips or the Internet Archive, or a direct link to an audio or video file/);
  assert.match(cover(family).hint, /paste a media link/);

  /* `link` keeps its first meaning, usable now (the iPhone branch ios-p293 shows a live row for
   * it); the greyed-out field rides `lockedLink`, which only updated clients read. */
  const reviewSeat = (user) => pack.familyFeatures(user, {});
  for (const user of [{ id: VISCHECK }, { id: BOB }]) {
    const locked = cover(link.guideFor(GUIDE, user, reviewSeat, {}));
    assert.equal(locked.link, undefined, `${user.id}: no live link for a client that reads only link`);
    assert.deepEqual(locked.lockedLink, {
      site: 'media', label: 'Or paste a media link (YouTube and other sites)', button: 'Import from link',
      available: false, locked: 'Part of the Family feature pack',
    }, `${user.id}: the same label, shown greyed out, with no path to press`);
    assert.match(locked.hint, /^Import one song, up to six minutes\. YuE2 uses its melody/, 'the hint only offers what can be used');
  }
  assert.equal(cover(family).lockedLink, undefined, 'a family account gets only the live link');
  const unsure = link.guideFor(GUIDE, { id: 'u1' }, () => { throw new Error('lookup failed'); }, {});
  assert.equal(cover(unsure).link, undefined, 'unsure means greyed out');
  assert.equal(cover(unsure).lockedLink.available, false);
  const switchedOff = link.guideFor(GUIDE, { id: 'u1' }, () => ({ mediaLinks: true }), { KADE_SOUNDBOOTH_YT_LINKS: '0' });
  assert.equal(cover(switchedOff).link, undefined, 'the kill switch takes the field away for everyone');
  assert.equal(cover(switchedOff).lockedLink, undefined);
  const lockedOff = link.guideFor(GUIDE, { id: BOB }, reviewSeat, { KADE_SOUNDBOOTH_YT_LINKS: '0' });
  assert.equal(cover(lockedOff).lockedLink, undefined, 'and its greyed-out form too');
  /* An extra App Review seat (KADE_APP_REVIEW_USER_IDS) made before the cutoff: the route and the
   * guide shut it out exactly as the old isReviewSeat gate did. */
  const saved = process.env.KADE_APP_REVIEW_USER_IDS;
  process.env.KADE_APP_REVIEW_USER_IDS = `${VISCHECK},${EARLY_REVIEW}`;
  try {
    assert.equal(cover(link.guideFor(GUIDE, { id: EARLY_REVIEW }, reviewSeat, {})).link, undefined);
    assert.equal(link.linkImportAvailable({ id: EARLY_REVIEW }, reviewSeat, {}), false);
  } finally {
    if (saved === undefined) delete process.env.KADE_APP_REVIEW_USER_IDS;
    else process.env.KADE_APP_REVIEW_USER_IDS = saved;
  }
  assert.equal(link.linkImportAvailable({ id: EARLY_REVIEW }, reviewSeat, {}), true, 'unlisted, the same early account is family');
  assert.equal(JSON.stringify(GUIDE), before, 'the shared guide is never changed');
  assert.equal(link.guideFor(GUIDE, { id: 'u1' }, () => ({ mediaLinks: true }), {}).engines.scenema, GUIDE.engines.scenema);
  // A child account in the pack keeps the field.
  assert.equal(cover(link.guideFor(GUIDE, { id: 'child', kadeAccountType: 'child' }, () => ({ mediaLinks: true }), {})).link.available, true);
});

/* The website's linkField, run from the page source: greyed out means a label, a disabled box
 * and button, and a visible note both controls are described by. */
function pageLinkField() {
  const pageContext = { module: { exports: {} }, require: () => ({ SHARED_HEAD: '' }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeSoundBoothPage.js'), 'utf8'), pageContext);
  const html = pageContext.module.exports.soundBoothHtml;
  const from = html.indexOf('    function linkField(s, id){');
  const to = html.indexOf('    async function importLink(){', from);
  assert.ok(from > 0 && to > from, 'linkField is where the test expects it');
  const sandbox = {
    state: { clips: [], linkDraft: '', importing: false, linkImporting: false, rendering: false, jobId: null },
    esc: (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  };
  vm.runInNewContext(html.slice(from, to), sandbox);
  return (setting) => sandbox.linkField(setting, 'set_reference_voice_url');
}

test('greyed out on the website: a real label, disabled controls, and "Part of the Family feature pack" as their description', () => {
  const linkField = pageLinkField();
  const GUIDE = boothGuide();
  const locked = linkField(cover(link.guideFor(GUIDE, { id: BOB }, () => ({ mediaLinks: false }), {})));
  assert.match(locked, /<label class="field" for="set_reference_voice_url_link">Or paste a media link \(YouTube and other sites\)<\/label>/);
  assert.match(locked, /<p class="hint locked" id="set_reference_voice_url_link_lock">Part of the Family feature pack\. Ask Kade to add it to your account\.<\/p>/);
  assert.match(locked, /<input type="text"[^>]* id="set_reference_voice_url_link"[^>]* disabled aria-describedby="set_reference_voice_url_link_lock">/);
  assert.match(locked, /<button type="button" class="act" id="btnLinkImport" disabled aria-describedby="set_reference_voice_url_link_lock">Import from link<\/button>/);
  const open = linkField(cover(link.guideFor(GUIDE, { id: 'u1' }, () => ({ mediaLinks: true }), {})));
  assert.doesNotMatch(open, /disabled|Family feature pack/);
  assert.match(open, /aria-describedby="set_reference_voice_url_link_h"/);
  assert.match(open, /placeholder="https:\/\/"/);
  assert.match(open, />Import from link<\/button>/);
});

test('words: link problems, YouTube, other sites and direct files are said plainly', () => {
  const say = (kind, site) => link.linkWords(new FakeYouTubeError(kind), undefined, site);
  assert.equal(say('bot'), 'YouTube is blocking the server right now. Try again in a few minutes, or download the song and import the file.');
  assert.equal(link.linkStatus(new FakeYouTubeError('bot')), 503);
  assert.match(say('private'), /^This YouTube video is private/);
  assert.match(say('age'), /age-restricted/);
  assert.equal(link.linkWords(new FakeYouTubeError('age'), { id: 'kid', kadeAccountType: 'child' }), 'This YouTube video is age-restricted, so it cannot be brought in on this account. Choose a different video.');
  assert.equal(link.linkWords(new FakeYouTubeError('age'), { id: 'kid', kadeAccountType: 'child' }, 'tiktok'), 'This is age-restricted, so it cannot be brought in on this account. Choose a different song.');
  assert.equal(link.linkWords(new FakeYouTubeError('age'), { id: 'u1' }), link.WORDS.age);
  assert.match(say('removed'), /has been removed/);
  assert.match(say('not-supported'), /^The booth cannot bring songs in from that site\./);
  assert.match(say('not-video'), /channel, playlist or album/);
  assert.match(say('blocked-address', 'file'), /private or internal address, or carries a sign-in or a port number/);
  assert.match(say('not-found', 'file'), /could not be found/);
  assert.match(say('redirects', 'file'), /too many hops/);
  assert.match(say('not-media', 'file'), /did not send an audio or video file/);
  assert.match(say('timeout'), /took too long/);
  assert.equal(say('private', 'soundcloud'), 'This is private on SoundCloud, or needs a sign-in there, so the server cannot get it. If you have the song, import the file instead.');
  assert.equal(say('failed', 'archive'), 'The song could not be brought in from the Internet Archive. Try again in a few minutes, or download the song and import the file.');
  assert.equal(say('timeout', 'x'), 'X took too long to answer. Try again in a few minutes, or download the song and import the file.');
  assert.equal(say('removed', 'file'), 'Nothing is at that link any more. Check the link, or import the song as a file.');
  assert.equal(say('private', 'file'), link.FILE_WORDS.private);
  assert.equal(link.linkStatus(new FakeYouTubeError('blocked-address')), 400);
  assert.equal(link.linkStatus(new FakeYouTubeError('not-media')), 422);
  assert.equal(say('something new'), link.WORDS.failed);
  assert.equal(link.linkWords(new Error('plain')), link.WORDS.failed);
  for (const words of [...Object.values(link.LINK_WORDS), ...Object.values(link.FILE_WORDS)]) assert.doesNotMatch(words, /undefined|\$\{/);
  assert.equal(link.spokenMinutes(61), '1 minute 1 second');
  assert.equal(link.spokenMinutes(45), '45 seconds');
  assert.equal(link.spokenMinutes(120), '2 minutes');
  assert.equal(link.clock(192.4), '3:12');
  assert.equal(link.clock(65), '1:05');
});

test('refusals: other sites, private addresses, not YuE2, empty, and failures come back in the booth voice', async () => {
  const w = world();
  let res = await w.link({ engine: 'yue2', url: 'https://example.com/songs/sunny-day' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, link.LINK_WORDS['not-supported']);
  assert.equal(res.body.kind, 'not-supported');
  for (const url of ['http://169.254.169.254/latest/meta-data/x.mp3', 'http://[::1]/song.mp3', 'https://user@cdn.example.com/song.mp3', 'http://kade.railway.internal/song.mp3']) {
    res = await w.link({ engine: 'yue2', url });
    assert.equal(res.statusCode, 400, url);
    assert.equal(res.body.kind, 'blocked-address', url);
  }
  res = await w.link({ engine: 'scenema', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /YuE2 covers/);
  res = await w.link({ engine: 'yue2', url: '   ' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Paste a media link first.');
  assert.equal(w.downloads.length, 0);

  const walled = world({ download: async () => { throw new FakeYouTubeError('bot'); } });
  res = await walled.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'YouTube is blocking the server right now. Try again in a few minutes, or download the song and import the file.');
  const failed = walled.logs.find(([level, line]) => level === 'warn' && /link FAILED/.test(line));
  assert.match(failed[1], /^\[soundbooth\/reference\] link FAILED user=u1 video=dQw4w9WgXcQ kind=bot/);
  assert.equal(walled.state.running.size, 0);

  const gone = world({ download: async () => { throw new FakeYouTubeError('private'); } });
  res = await gone.link({ engine: 'yue2', url: 'https://www.instagram.com/reel/Cabc123/' });
  assert.equal(res.statusCode, 422);
  assert.match(res.body.error, /^This is private on Instagram/);
  assert.match(gone.logs.find(([level]) => level === 'warn')[1], /video=instagram:[\da-f]{10} kind=private/, 'a short id, never the whole link');
  assert.doesNotMatch(gone.logs.find(([level]) => level === 'warn')[1], /Cabc123|instagram\.com/);
  /* A SoundCloud secret share: its key never reaches a log line (review of Sep 25). */
  const secret = world({ download: async () => { throw new FakeYouTubeError('removed'); } });
  res = await secret.link({ engine: 'yue2', url: 'https://soundcloud.com/a/b/s-secret123?si=tok4567' });
  assert.equal(res.statusCode, 422);
  assert.ok(secret.logs.length > 0);
  for (const [, line] of secret.logs) assert.doesNotMatch(line, /secret123|tok4567/, line);
});

test('caps: one import at a time per person, and a daily cap', async () => {
  let release;
  const w = world({ download: () => new Promise((resolve) => { release = () => resolve({ buffer: Buffer.alloc(4096, 1), title: 'Song', seconds: 100, id: 'dQw4w9WgXcQ', link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', site: 'youtube' }); }) });
  const first = w.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await w.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(second.statusCode, 409);
  assert.match(second.body.error, /A link import is already running for you/);
  release();
  assert.equal((await first).statusCode, 200);

  const capped = world({ cap: link.dailyCap(2, () => '2026-09-25') });
  assert.equal((await capped.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' })).statusCode, 200);
  assert.equal((await capped.link({ engine: 'yue2', url: 'https://vimeo.com/76979871' })).statusCode, 200);
  const third = await capped.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(third.statusCode, 429);
  assert.match(third.body.error, /2 link imports today/);
  // A link the booth will not fetch is refused before the cap counts it.
  const day = link.dailyCap(1, () => '2026-09-25');
  const w2 = world({ cap: day });
  await w2.link({ engine: 'yue2', url: 'https://example.com/page' });
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
  const waitForAbort = async (_found, options) =>
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

test('age: a child is never carried past an age gate by the server', async () => {
  // The fake answers like mediaAudio: an age-restricted video is refused unless the caller allows it.
  const ageGated = async (found, options) => {
    if (!options.allowAgeRestricted) throw new FakeYouTubeError('age');
    return { buffer: Buffer.alloc(4096, 1), title: 'Grown-up Song', seconds: 200, id: found.id, link: found.url, site: found.site };
  };
  const child = world({ download: ageGated });
  const res = await child.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' }, { id: 'kid', kadeAccountType: 'child' });
  assert.equal(res.statusCode, 422);
  // The child hears the true reason: this account, not YouTube, is what stops it.
  assert.equal(res.body.error, link.WORDS['age-child']);
  assert.doesNotMatch(res.body.error, /will not hand it to the server|import the file/);
  assert.equal(res.body.kind, 'age');
  assert.equal(child.downloads[0].options.allowAgeRestricted, false);
  assert.equal(child.stored.length, 0);

  const grownUp = world({ download: ageGated });
  const ok = await grownUp.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' }, { id: 'u1', kadeAccountType: 'adult' });
  assert.equal(ok.statusCode, 200);
  // A grown-up refused by YouTube itself (server not signed in) keeps today's sentence.
  const unsigned = world({ download: async () => { throw new FakeYouTubeError('age'); } });
  const theirs = await unsigned.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' }, { id: 'u2' });
  assert.equal(theirs.body.error, link.WORDS.age);
  assert.equal(grownUp.downloads[0].options.allowAgeRestricted, true);
  const plainAccount = world({ download: ageGated });
  assert.equal((await plainAccount.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' })).statusCode, 200);
});

/* The real chain at the six-minute edge: the route, the real mediaAudio and youtubeAudio (packages/api
 * description/links.ts and youtube.ts, loaded through tsx) with yt-dlp faked by a real tone, the real MP3
 * conversion, then the real storeReference, durationOf (ffprobe) and musicReferenceError.
 * YouTube lists whole seconds, so a listed "359" can hold up to 359.99 s of sound, and the MP3
 * encoder adds a few hundredths more (360.04 s here). Before Part 293's review a listed 6:00 was
 * downloaded whole and then refused with "This recording is 6 minutes 0 seconds long. Covers
 * support up to 6 minutes." Now a listed 6:00 is refused from its metadata, and the MP3 of
 * anything shorter is cut a tenth of a second short of the limit, so it always passes. */
test('six-minute edge: listed at 6:00 is refused before any download; listed at 5:59 comes in and passes', async (t) => {
  const childProcess = require('node:child_process');
  const ffmpegPath = require('ffmpeg-static');
  const FAKE = 'fake-yt-dlp-for-tests';
  const saved = { spawn: childProcess.spawn, env: { ...process.env } };
  t.after(() => {
    childProcess.spawn = saved.spawn;
    for (const key of ['FFMPEG_PATH', 'FFPROBE_PATH', 'YT_DLP_PATH', 'KADE_YT_COOKIES', 'KADE_POT_URL']) {
      if (saved.env[key] === undefined) delete process.env[key];
      else process.env[key] = saved.env[key];
    }
  });
  process.env.FFMPEG_PATH = ffmpegPath;
  process.env.FFPROBE_PATH = require('ffprobe-static').path; // read when kadeSoundBoothStitch loads
  process.env.YT_DLP_PATH = FAKE;
  delete process.env.KADE_YT_COOKIES;
  delete process.env.KADE_POT_URL;
  let runs = [];
  let video = { title: 'Six Minutes Exactly', listed: 360, sound: 360.9 };
  childProcess.spawn = (bin, args, options) => {
    if (bin !== FAKE) return saved.spawn(bin, args, options);
    runs.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { on() {}, end() {} };
    child.kill = () => {};
    setImmediate(async () => {
      if (args.includes('--dump-single-json')) {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ title: video.title, duration: video.listed, uploader: 'Some Band' })));
      } else {
        const target = args[args.indexOf('-o') + 1].replace('%(ext)s', 'webm');
        await new Promise((resolve, reject) => {
          const make = saved.spawn(ffmpegPath, ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${video.sound}`, '-c:a', 'libopus', target]);
          make.on('close', (code) => (code === 0 ? resolve() : reject(new Error('fixture ffmpeg failed'))));
        });
      }
      child.emit('close', 0);
    });
    return child;
  };
  const { durationOf } = require('./kadeSoundBoothStitch');

  // Listed at exactly 6:00: refused from the metadata, in words that do not contradict themselves.
  const six = world({ durationOf, download: (found, options) => links.mediaAudio(found, options) });
  const refused = await six.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.body.kind, 'too-long');
  assert.match(refused.body.error, /^This YouTube video is 6 minutes long, and covers from YouTube must be shorter than 6 minutes\./);
  assert.equal(runs.length, 1, 'the metadata pass only: nothing was downloaded');
  assert.equal(six.stored.length, 0);

  // Listed at 5:59 but holding 359.99 s of sound: the MP3 is cut at 359.9 s and passes the booth's check.
  runs = [];
  video = { title: 'Just Under Six', listed: 359, sound: 359.99 };
  const w = world({ durationOf, download: (found, options) => links.mediaAudio(found, options) });
  const res = await w.link({ engine: 'yue2', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(res.statusCode, 200, res.body && res.body.error);
  assert.equal(runs.length, 2, 'metadata, then one download');
  assert.equal(runs[1][runs[1].indexOf('--match-filter') + 1], 'duration < 360 & !is_live');
  assert.ok(res.body.seconds < 359.96 && res.body.seconds > 359.8, `measured ${res.body.seconds} s: cut just short of six minutes`);
  assert.equal(musicReferenceError(res.body.seconds), undefined);
  assert.equal(res.body.source.seconds, 359);
  assert.match(res.body.spoken, /^Covering Just Under Six, 6 minutes, from YouTube\./);
  assert.equal(w.stored.length, 1);
  assert.equal(w.registered[0][2], res.body.seconds);
});
