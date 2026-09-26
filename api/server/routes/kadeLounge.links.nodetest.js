/* The Clubhouse link lane (Part 291, Sep 25 2026): YouTube and Spotify links
 * from the iPhone. yt-dlp never runs here: child_process.spawn is a fake that
 * answers like yt-dlp does, so the route is exercised end to end with its real
 * temp files and cleanup.
 *
 * Run: node --test api/server/routes/kadeLounge.links.nodetest.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');

const logs = [];
const spawns = [];
let answer = () => ({ code: 0, stdout: '' });
let spotifyTitle = 'Fancy Song - Some Band';
/* Name lookups and the redirect walk never touch the network here (Part 291 review F23). */
const dnsCalls = [];
const hops = [];
let dnsAnswer = () => [{ address: '93.184.216.34', family: 4 }];
let hopAnswer = () => ({ status: 200 });
/* The Family feature pack (Part 293): the real rule from packages/api family/pack.ts, for whoever
 * the test signs in; `packUser` stands in for req.user's account. */
const pack = require('tsx/cjs/api').require('../../../packages/api/src/family/pack.ts', __filename);
let packUser = { id: 'u1', role: 'ADMIN' };

function fakeSpawn(bin, args) {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = () => {};
  spawns.push({ bin, args });
  setImmediate(() => {
    const a = answer(args, spawns.length) || {};
    if (a.stdout) p.stdout.emit('data', Buffer.from(a.stdout));
    if (a.stderr) p.stderr.emit('data', Buffer.from(a.stderr));
    p.emit('close', a.code || 0);
  });
  return p;
}

const stubs = {
  child_process: { spawn: fakeSpawn },
  dns: {
    promises: {
      lookup: async (hostname, options) => {
        dnsCalls.push({ hostname, options });
        const a = dnsAnswer(hostname);
        if (a instanceof Error) throw a;
        return a;
      },
    },
  },
  axios: { get: async () => ({ data: { title: spotifyTitle } }) },
  jsonwebtoken: { sign: () => 'token' },
  '@librechat/data-schemas': {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
  },
  '~/server/middleware': { requireJwtAuth: (_req, _res, next) => next() },
  '~/models/kadeClubRoom': { KadeClubRoom: {} },
  './Clubhouse/pages': { loungeHtml: '', engineHtml: '' },
  '~/server/utils/stripAiTells': { stripAiTells: (s) => s, KADE_STYLE_NOTE: '' },
  '@librechat/api': { familyFeatures: () => pack.familyFeatures(packUser) },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};

const router = require('./kadeLounge');
const lane = router.linkLane;
lane.linkDeps.fetch = async (url, init) => {
  hops.push({ url, init });
  const a = hopAnswer(url) || {};
  if (a instanceof Error) throw a;
  const headers = new Map(Object.entries(a.headers || {}));
  return { status: a.status || 200, headers: { get: (k) => headers.get(k.toLowerCase()) || null }, body: { cancel: async () => {} } };
};
const fetchTrack = router.stack
  .find((layer) => layer.route && layer.route.path === '/fetch-track')
  .route.stack.slice(-1)[0].handle;

async function post(url) {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(n) { this.statusCode = n; return this; },
    json(v) { this.body = v; return this; },
    set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    send(v) { this.body = v; return this; },
  };
  await fetchTrack({ body: { url }, user: { id: 'u1' } }, res);
  return res;
}

const arg = (args, flag) => args[args.indexOf(flag) + 1];
const isDownload = (args) => args.includes('-o');
/** yt-dlp's download step: write the finished m4a (and a stray .orig.m4a) where -o says. */
function writeTrack(args, bytes = 'm4a-bytes') {
  const base = arg(args, '-o').replace('.%(ext)s', '');
  fs.writeFileSync(base + '.m4a', bytes);
  fs.writeFileSync(base + '.orig.m4a', 'left behind');
  return base;
}

beforeEach(() => {
  logs.length = 0;
  spawns.length = 0;
  delete process.env.FFMPEG_PATH;
  delete process.env.YT_DLP_PATH;
  answer = () => ({ code: 0, stdout: '' });
  dnsCalls.length = 0;
  hops.length = 0;
  dnsAnswer = () => [{ address: '93.184.216.34', family: 4 }];
  hopAnswer = () => ({ status: 200 });
  packUser = { id: 'u1', role: 'ADMIN' };
  delete process.env.KADE_FAMILY_PACK_LINKS;
});

const BOB = { id: '6b0000000000000000000000' }; // made long after the family cutoff
const REVIEW_SEAT = { id: '6a6125d73939d20b95251078' };
const config = router.stack.find((layer) => layer.route && layer.route.path === '/config').route.stack.slice(-1)[0].handle;
async function getConfig() {
  const res = { body: undefined, json(v) { this.body = v; return this; } };
  await config({ user: { id: 'u1' } }, res);
  return res.body;
}

test('Family feature pack: jukebox links stay open to everyone while KADE_FAMILY_PACK_LINKS is not 1', async () => {
  for (const user of [BOB, REVIEW_SEAT]) {
    packUser = user;
    answer = (args) => (isDownload(args) ? (writeTrack(args), { code: 0 }) : { code: 0, stdout: 'Fancy Song\n' });
    const res = await post('https://youtu.be/dQw4w9WgXcQ');
    assert.notEqual(res.statusCode, 403, JSON.stringify(user));
    assert.equal((await getConfig()).features.jukeboxLinks, true);
  }
});

test('Family feature pack: with KADE_FAMILY_PACK_LINKS=1 an account outside the pack is refused before anything runs', async () => {
  process.env.KADE_FAMILY_PACK_LINKS = '1';
  assert.equal(lane.PACK_REFUSAL, pack.FAMILY_PACK_REFUSAL, 'the lounge says what the pack helper says');
  for (const user of [BOB, REVIEW_SEAT, { id: '6a5fc5fa351af41332734161', kadeLibraryAccess: 'none' }]) {
    packUser = user;
    const res = await post('https://youtu.be/dQw4w9WgXcQ');
    assert.equal(res.statusCode, 403, JSON.stringify(user));
    assert.deepEqual(res.body, { error: 'Media links are part of the Family feature pack. Ask Kade to add it to your account.', pack: true });
    const cfg = await getConfig();
    assert.equal(cfg.features.jukeboxLinks, false, 'the room page greys the link box out');
    assert.equal(cfg.features.familyLibrary, false);
  }
  const wide = await post('https://example.com/song.mp3');
  assert.equal(wide.statusCode, 403, 'the wide lane too');
  assert.equal(spawns.length, 0, 'yt-dlp never ran');
  assert.equal(dnsCalls.length, 0, 'nothing was looked up');
  assert.ok(logs.some(([level, line]) => level === 'warn' && /refused user=u1: not in the Family feature pack/.test(line)));
  // In the pack: a family account from before the cutoff, one Kade said yes to, and an admin.
  for (const user of [{ id: '6a5fc5fa351af41332734161' }, { ...BOB, kadeLibraryAccess: 'family' }, { ...BOB, role: 'ADMIN' }]) {
    packUser = user;
    answer = (args) => (isDownload(args) ? (writeTrack(args), { code: 0 }) : { code: 0, stdout: 'Fancy Song\n' });
    assert.notEqual((await post('https://youtu.be/dQw4w9WgXcQ')).statusCode, 403, JSON.stringify(user));
    assert.equal((await getConfig()).features.jukeboxLinks, true);
  }
});

test('Family feature pack: an unreadable pack answer counts as outside the pack', async () => {
  const saved = lane.linkDeps.features;
  lane.linkDeps.features = () => { throw new Error('lookup failed'); };
  try {
    const res = await post('https://youtu.be/dQw4w9WgXcQ');
    assert.equal(res.statusCode, 403);
    assert.equal(spawns.length, 0);
    assert.deepEqual(lane.loungeFeatures({ id: 'u1' }), { mediaLinks: false, describerLinks: false, jukeboxLinks: false, familyLibrary: false });
  } finally {
    lane.linkDeps.features = saved;
  }
});

test('youtubeVideoLink maps every single-video shape to a plain watch link', () => {
  const plain = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  for (const link of [
    'https://youtu.be/dQw4w9WgXcQ?si=abc',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=4',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
    'https://youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ?feature=shared',
  ]) {
    assert.equal(lane.youtubeVideoLink(new URL(link)), plain, link);
  }
});

test('youtubeVideoLink refuses channels, playlists and broken ids', () => {
  for (const link of [
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/@SomeChannel',
    'https://www.youtube.com/channel/UC1234567890',
    'https://www.youtube.com/c/SomeChannel/videos',
    'https://www.youtube.com/',
    'https://www.youtube.com/watch?v=short',
    'https://youtu.be/',
  ]) {
    assert.equal(lane.youtubeVideoLink(new URL(link)), null, link);
  }
});

test('spotifyTrackLink takes songs only', () => {
  assert.equal(lane.spotifyTrackLink(new URL('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x')), true);
  assert.equal(lane.spotifyTrackLink(new URL('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC')), true);
  assert.equal(lane.spotifyTrackLink(new URL('https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3')), false);
  assert.equal(lane.spotifyTrackLink(new URL('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')), false);
  assert.equal(lane.spotifyTrackLink(new URL('https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF')), false);
});

test('ytFinalAnswer names the answers knocking will not change, and never the bot wall', () => {
  assert.match(lane.ytFinalAnswer("ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video"), /private/);
  assert.match(lane.ytFinalAnswer('ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.'), /age-restricted/);
  assert.match(lane.ytFinalAnswer('Video unavailable. This video is no longer available because the YouTube account associated with this video has been terminated.'), /removed/);
  assert.match(lane.ytFinalAnswer('This video contains content from X, who has blocked it in your country on copyright grounds'), /copyright/);
  assert.equal(lane.ytFinalAnswer("ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies"), null);
  assert.equal(lane.ytFinalAnswer('yt-dlp timeout'), null);
  assert.equal(lane.ytFinalAnswer(''), null);
});

test('ytPermanentError stops on private, removed, copyright and unsupported links only', () => {
  assert.equal(lane.ytPermanentError('Private video. Sign in if you have been granted access'), true);
  assert.equal(lane.ytPermanentError('This video has been removed by the uploader'), true);
  assert.equal(lane.ytPermanentError('ERROR: Unsupported URL: https://example.com/page'), true);
  assert.equal(lane.ytPermanentError("Sign in to confirm you're not a bot"), false);
  assert.equal(lane.ytPermanentError('Sign in to confirm your age'), false);
});

test('ytCommonArgs names Node for YouTube scripts and passes ffmpeg only as a real path', () => {
  let args = lane.ytCommonArgs();
  assert.equal(arg(args, '--js-runtimes'), 'node:' + process.execPath);
  assert.ok(args.includes('--ignore-config'));
  assert.ok(!args.includes('--ffmpeg-location'));
  process.env.FFMPEG_PATH = 'ffmpeg';
  assert.ok(!lane.ytCommonArgs().includes('--ffmpeg-location'), 'a bare name is not a path');
  process.env.FFMPEG_PATH = '  ';
  assert.ok(!lane.ytCommonArgs().includes('--ffmpeg-location'));
  process.env.FFMPEG_PATH = '/usr/bin/ffmpeg';
  args = lane.ytCommonArgs();
  assert.equal(arg(args, '--ffmpeg-location'), '/usr/bin/ffmpeg');
});

test('a YouTube link comes back as audio/mp4 with its title, good audio args, and no temp files', async () => {
  process.env.YT_DLP_PATH = '/opt/yt-dlp';
  let base = '';
  answer = (args) => {
    if (!isDownload(args)) return { stdout: 'A Song Title\n' };
    base = writeTrack(args);
    return {};
  };
  const res = await post('https://youtu.be/dQw4w9WgXcQ?list=PL123');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'audio/mp4');
  assert.equal(decodeURIComponent(res.headers['x-kade-title']), 'A Song Title');
  assert.equal(res.body.toString(), 'm4a-bytes');
  assert.equal(spawns.length, 2);
  for (const { bin, args } of spawns) {
    assert.equal(bin, '/opt/yt-dlp');
    assert.ok(args.includes('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'the plain watch link, list= dropped');
    assert.ok(!args.some((a) => a.includes('list=')));
    assert.equal(arg(args, '--js-runtimes'), 'node:' + process.execPath);
    assert.equal(arg(args, '--match-filters'), '!is_live & duration<905');
    assert.equal(arg(args, '--playlist-items'), '1');
  }
  const download = spawns[1].args;
  assert.equal(arg(download, '-f'), 'bestaudio[acodec^=mp4a]/bestaudio');
  assert.equal(arg(download, '--audio-format'), 'm4a');
  assert.equal(arg(download, '--audio-quality'), '160K');
  assert.equal(arg(download, '--max-filesize'), '60m');
  assert.ok(!fs.existsSync(base + '.m4a') && !fs.existsSync(base + '.orig.m4a'), 'temp files cleaned up');
  assert.ok(logs.some(([level, m]) => level === 'info' && /^\[lounge\/fetch-track\] ok youtu\.be rung \d 9 bytes$/.test(m)));
});

test('channels, playlists and Spotify albums are refused before yt-dlp runs', async () => {
  let res = await post('https://www.youtube.com/playlist?list=PL123');
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /not a channel or playlist/);
  res = await post('https://www.youtube.com/@SomeChannel');
  assert.equal(res.statusCode, 400);
  res = await post('https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3');
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Spotify song link/);
  res = await post('not a link');
  assert.equal(res.statusCode, 400);
  res = await post('http://127.0.0.1/song.mp3');
  assert.equal(res.statusCode, 400);
  assert.equal(spawns.length, 0);
});

test('a private video is answered plainly with 422, walled false, after one try', async () => {
  answer = () => ({ code: 1, stderr: "ERROR: [youtube] dQw4w9WgXcQ: Private video. Sign in if you've been granted access to this video" });
  const res = await post('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body, { error: 'That video is private, so the server cannot get it.', walled: false });
  assert.equal(spawns.length, 1, 'the ladder stops at a permanent answer');
});

test('an age-restricted video skips the second pass and does not knock', async () => {
  answer = () => ({ code: 1, stderr: 'ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm your age. This video may be inappropriate for some users.' });
  const res = await post('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.walled, false);
  assert.match(res.body.error, /age-restricted/);
  assert.equal(spawns.length, lane.YT_LADDER.length, 'one pass round the clients, not two');
});

test('the bot wall still climbs both passes and answers walled:true', async () => {
  answer = () => ({ code: 1, stderr: "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot. Use --cookies-from-browser" });
  const res = await post('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.walled, true);
  assert.match(res.body.error, /stonewalling/);
  assert.equal(spawns.length, lane.YT_LADDER.length * 2);
});

test('a failure on another site is never walled, even when it says sign in', async () => {
  answer = () => ({ code: 1, stderr: 'ERROR: [soundcloud] 123: Sign in required' });
  const res = await post('https://soundcloud.com/someone/some-song');
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.walled, false);
  assert.match(res.body.error, /would not fetch/);
});

test('an unsupported link stops after one try', async () => {
  answer = () => ({ code: 1, stderr: 'ERROR: Unsupported URL: https://example.com/page' });
  const res = await post('https://example.com/page');
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.walled, false);
  assert.equal(spawns.length, 1);
});

test('a file over the cap (yt-dlp skipped it and exited 0) is a 413, not a crash', async () => {
  answer = (args) => (isDownload(args) ? {} : { stdout: 'Long Mix\n' });
  const res = await post('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.body, { error: 'That audio is over the 60MB cap.' });
});

test('a Spotify song is looked up by name on YouTube', async () => {
  spotifyTitle = 'Fancy Song - Some Band';
  answer = (args) => {
    if (!isDownload(args)) return { stdout: 'Fancy Song (Official Audio)\n' };
    writeTrack(args);
    return {};
  };
  const res = await post('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc');
  assert.equal(res.statusCode, 200);
  assert.ok(spawns[0].args.includes('ytsearch1:Fancy Song - Some Band audio'));
  assert.equal(decodeURIComponent(res.headers['x-kade-title']), 'Fancy Song (Official Audio)');
});

test('a live, too-long or missing video is still the friendly 404', async () => {
  answer = () => ({ code: 0, stdout: '' });
  const res = await post('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /15 minutes/);
});

/* ── Part 291 review F23: private addresses on the wide lane ── */

test('privateAddress refuses every non-public address and passes public ones', () => {
  for (const ip of [
    '127.0.0.1', '127.8.9.10', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '100.127.255.255', '0.0.0.0', '255.255.255.255', '224.0.0.1', '192.0.2.5',
    '::', '::1', '[::1]', '::ffff:127.0.0.1', '::ffff:7f00:1', '[::ffff:7f00:1]', '::ffff:8.8.8.8', '::127.0.0.1',
    'fd12:3456::1', 'fc00::1', 'fe80::1', 'fe80::1%eth0', 'fec0::1', 'ff02::1',
    '64:ff9b::10.0.0.1', '64:ff9b::a9fe:a9fe', '2002:c0a8:0101::1', '2001:db8::1', '2001::1',
    'not-an-address', '', '1.2.3', '::ffff:999.1.1.1',
  ]) {
    assert.equal(lane.privateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '169.253.1.1', '2606:4700:4700::1111', '2a00:1450:4001::200e', '[2606:4700::1]', '64:ff9b::8.8.8.8', '2002:0808:0808::1']) {
    assert.equal(lane.privateAddress(ip), false, ip);
  }
});

test('IPv6, mapped and odd IPv4 spellings of private hosts are refused before any lookup or yt-dlp', async () => {
  for (const link of [
    'http://[::ffff:127.0.0.1]/a.mp3',
    'http://[fd12:3456::1]:8080/x',
    'http://[::1]/song.mp3',
    'http://[::]/song.mp3',
    'http://[fe80::1]/song.mp3',
    'http://0x7f.1/song.mp3',
    'http://2130706433/song.mp3',
    'http://0/song.mp3',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/song.mp3',
    'http://localhost:3080/api',
    'http://api.railway.internal/x',
    'http://printer.local/x',
    'http://app.localhost/x',
  ]) {
    const res = await post(link);
    assert.equal(res.statusCode, 400, link);
    assert.equal(res.body.error, 'That link points somewhere private.', link);
  }
  assert.equal(spawns.length, 0);
  assert.equal(hops.length, 0);
  assert.equal(dnsCalls.length, 0, 'literals are judged as they are');
});

test('a name is resolved for every address, and one private answer is enough to refuse', async () => {
  dnsAnswer = (h) =>
    h === 'localtest.me'
      ? [{ address: '127.0.0.1', family: 4 }]
      : h === 'sneaky.example'
        ? [{ address: '93.184.216.34', family: 4 }, { address: 'fd12::5', family: 6 }]
        : h === 'mapped.example'
          ? [{ address: '::ffff:10.0.0.2', family: 6 }]
          : [{ address: '93.184.216.34', family: 4 }];
  for (const link of ['http://localtest.me/a.mp3', 'https://sneaky.example/a.mp3', 'https://mapped.example/a.mp3']) {
    const res = await post(link);
    assert.equal(res.statusCode, 400, link);
    assert.equal(res.body.error, 'That link points somewhere private.');
  }
  assert.deepEqual(dnsCalls.map((c) => c.hostname), ['localtest.me', 'sneaky.example', 'mapped.example']);
  assert.ok(dnsCalls.every((c) => c.options.all === true), 'every address, not just the first');
  assert.equal(spawns.length, 0);
  assert.equal(hops.length, 0);
  assert.ok(logs.some(([level, m]) => level === 'warn' && /refused sneaky\.example/.test(m)));
});

test('a site that cannot be found is refused plainly', async () => {
  dnsAnswer = () => Object.assign(new Error('getaddrinfo ENOTFOUND nowhere.example'), { code: 'ENOTFOUND' });
  const res = await post('https://nowhere.example/a.mp3');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "That link's site could not be found.");
  assert.equal(spawns.length, 0);
});

test('a redirect into a private address is refused; yt-dlp never runs', async () => {
  hopAnswer = (url) => (url === 'https://public.example/song' ? { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } } : { status: 200 });
  let res = await post('https://public.example/song');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'That link points somewhere private.');
  assert.equal(hops.length, 1);
  assert.equal(hops[0].init.redirect, 'manual', 'the server follows redirects itself');
  hopAnswer = (url) => (url === 'https://public.example/song' ? { status: 301, headers: { location: '//inside.example/x' } } : { status: 200 });
  dnsAnswer = (h) => (h === 'inside.example' ? [{ address: '10.0.0.9', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
  res = await post('https://public.example/song');
  assert.equal(res.statusCode, 400);
  assert.equal(spawns.length, 0);
});

test('public redirects are walked and yt-dlp starts at the end of the chain; too many hops is refused', async () => {
  hopAnswer = (url) =>
    url === 'https://short.example/s' ? { status: 301, headers: { location: 'https://cdn.example.org/song.mp3' } } : { status: 206 };
  answer = (args) => {
    if (!isDownload(args)) return { stdout: 'https://cdn.example.org/song.mp3\nhttps://cdn.example.org/song.mp3\nsong\n' };
    writeTrack(args);
    return {};
  };
  const res = await post('https://short.example/s');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(hops.map((h) => h.url), ['https://short.example/s', 'https://cdn.example.org/song.mp3']);
  for (const { args } of spawns) {
    assert.ok(args.includes('https://cdn.example.org/song.mp3'));
    assert.ok(!args.includes('https://short.example/s'));
  }
  spawns.length = 0;
  let n = 0;
  hopAnswer = () => ({ status: 302, headers: { location: 'https://loop.example/' + ++n } });
  const loop = await post('https://loop.example/0');
  assert.equal(loop.statusCode, 400);
  assert.match(loop.body.error, /too many hops/);
  assert.equal(spawns.length, 0);
});

test('a link that does not answer the check is refused', async () => {
  hopAnswer = () => new TypeError('fetch failed');
  const res = await post('https://slow.example/a.mp3');
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /did not answer/);
  assert.equal(spawns.length, 0);
});

test('after the metadata pass, a page or media link on a private address stops the download', async () => {
  answer = (args) => {
    if (!isDownload(args)) return { stdout: 'https://public.example/page\nhttp://10.0.0.5/secret.mp3\nSecret\n' };
    writeTrack(args);
    return {};
  };
  let res = await post('https://public.example/page');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'That link points somewhere private.');
  assert.equal(spawns.length, 1, 'no download');
  const meta = spawns[0].args;
  assert.equal(arg(meta, '-f'), 'bestaudio[acodec^=mp4a]/bestaudio', 'the same format the download would take');
  assert.deepEqual(meta.filter((a, i) => meta[i - 1] === '--print'), ['%(webpage_url)s', '%(url)s', '%(title)s'], 'links first: a title can hold a line break');
  assert.ok(logs.some(([level, m]) => level === 'warn' && /after the metadata pass: it led to 10\.0\.0\.5/.test(m)));

  spawns.length = 0;
  answer = (args) => (isDownload(args) ? {} : { stdout: 'https://public.example/page\nrtmp://public.example/live\nOdd\n' });
  res = await post('https://public.example/page');
  assert.equal(res.statusCode, 400);
  assert.equal(spawns.length, 1);

  /* A title with a line break in it cannot push the media link out of the checked lines. */
  spawns.length = 0;
  answer = (args) => (isDownload(args) ? {} : { stdout: 'https://public.example/page\nhttp://[fd12::7]/x.mp3\nLine one\nline two\n' });
  res = await post('https://public.example/page');
  assert.equal(res.statusCode, 400);
  assert.equal(spawns.length, 1);
});

test('a public wide-lane link still plays, and NA links from yt-dlp are ignored', async () => {
  answer = (args) => {
    if (!isDownload(args)) return { stdout: 'NA\nNA\nArchive Song\n' };
    writeTrack(args);
    return {};
  };
  const res = await post('https://archive.example.org/details/song');
  assert.equal(res.statusCode, 200);
  assert.equal(decodeURIComponent(res.headers['x-kade-title']), 'Archive Song');
  assert.equal(spawns.length, 2);
  assert.equal(arg(spawns[1].args, '-f'), 'bestaudio[acodec^=mp4a]/bestaudio');
});

test('the YouTube lane never runs the wide-lane checks', async () => {
  answer = (args) => {
    if (!isDownload(args)) return { stdout: 'A Song Title\n' };
    writeTrack(args);
    return {};
  };
  const res = await post('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(res.statusCode, 200);
  assert.equal(dnsCalls.length, 0);
  assert.equal(hops.length, 0);
  assert.deepEqual(spawns[0].args.filter((a, i) => spawns[0].args[i - 1] === '--print'), ['%(title)s']);
});
