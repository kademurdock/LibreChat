/**
 * Part 293: media links for the Sound Booth's covers (links.ts). yt-dlp never runs here:
 * child_process.spawn answers for a fake yt-dlp binary the way yt-dlp does, and a "download"
 * writes a real tone with ffmpeg-static, so the real MP3 conversion, length probe, temp folder
 * and cleanup run end to end. DNS and the direct-file GET are answered by the test, except in the
 * last test, which proves the real GET refuses a loopback address at connect time.
 *
 * Run: node --import tsx --test packages/api/src/description/links.test.mjs
 */
import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import http from 'node:http';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import {
  directTransport,
  downloadDirect,
  extractorArgs,
  linkShapeProblem,
  listedHosts,
  looksLikeMedia,
  MEDIA_REDIRECTS,
  MEDIA_SITE_HOSTS,
  mediaAudio,
  publicHost,
  hideSecrets,
  publicSiteLink,
  readMediaLink,
  resolveShortLink,
  SITE_EXTRACTORS,
  siteArgs,
} from './links.ts';

process.env.FFMPEG_PATH = ffmpegPath;
process.env.FFPROBE_PATH = ffprobeStatic.path;
delete process.env.KADE_YT_COOKIES;
delete process.env.KADE_POT_URL;
const FAKE = 'fake-yt-dlp-for-links';
process.env.YT_DLP_PATH = FAKE;

const realSpawn = childProcess.spawn;
let runs = [];
let answer = () => ({ code: 0 });

function makeTone(target, seconds, codec = 'libmp3lame') {
  return new Promise((resolve, reject) => {
    const make = realSpawn(ffmpegPath, [
      '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`,
      '-c:a', codec, target,
    ]);
    make.on('close', (code) => (code === 0 ? resolve() : reject(new Error('fixture ffmpeg failed'))));
  });
}

function fakeYtDlp(args, options = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { on() {}, end() {} };
  child.kill = () => {};
  runs.push(args);
  const reply = answer(args, runs.length) || {};
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    child.emit('close', code);
  };
  options.signal?.addEventListener('abort', () => {
    if (finished) return;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    child.emit('error', error);
    finish(null);
  }, { once: true });
  setImmediate(async () => {
    if (reply.tone) await makeTone(args[args.indexOf('-o') + 1].replace('%(ext)s', 'm4a'), reply.tone, 'aac');
    if (reply.stdout) child.stdout.emit('data', Buffer.from(reply.stdout));
    if (reply.stderr) child.stderr.emit('data', Buffer.from(reply.stderr));
    finish(reply.code ?? 0);
  });
  return child;
}
childProcess.spawn = (bin, args, options) => (bin === FAKE ? fakeYtDlp(args, options) : realSpawn(bin, args, options));
syncBuiltinESMExports();

const root = await mkdtemp(join(tmpdir(), 'kade-links-test-'));
const work = join(root, 'work');
const fixtures = join(root, 'fixtures');
await Promise.all([work, fixtures].map((dir) => import('node:fs/promises').then((fs) => fs.mkdir(dir))));
after(() => rm(root, { recursive: true, force: true }));

/** DNS as the test says: every name is public unless listed. */
let dns = {};
let dnsCalls = [];
const resolve = async (host) => {
  dnsCalls.push(host);
  const found = dns[host];
  if (found instanceof Error) throw found;
  return (found || ['93.184.216.34']).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
/** The direct-file GET as the test says: url -> { status, headers, body }. */
let web = () => ({ status: 404 });
let gets = [];
let closed = 0;
const transport = async (url) => {
  gets.push(url.href);
  const reply = web(url) || {};
  const headers = Object.fromEntries(Object.entries(reply.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status: reply.status ?? 200,
    header: (name) => headers[name.toLowerCase()] || '',
    body: (async function* () {
      for (const chunk of reply.chunks || (reply.body ? [reply.body] : [])) yield chunk;
    })(),
    close: () => { closed++; },
  };
};

beforeEach(() => {
  runs = [];
  dns = {};
  dnsCalls = [];
  gets = [];
  closed = 0;
  answer = () => ({ code: 0 });
  web = () => ({ status: 404 });
});

const options = (extra = {}) => ({
  maxSeconds: 360, maxBytes: 20 * 1024 * 1024, signal: new AbortController().signal, tmp: work, resolve, transport, ...extra,
});
const kind = (expected) => (error) => {
  assert.equal(error.kind, expected, `${error.kind}: ${error.message}`);
  return true;
};

/* ── reading a pasted link ─────────────────────────────────────────── */

test('links: YouTube, the big media sites and direct files are read; nothing is fetched', () => {
  assert.deepEqual(readMediaLink('https://youtu.be/dQw4w9WgXcQ?list=RD1&t=30'), {
    kind: 'youtube', site: 'youtube', siteName: 'YouTube', id: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  });
  const sites = {
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ': 'youtube',
    'https://vimeo.com/76979871': 'vimeo',
    'https://player.vimeo.com/video/76979871': 'vimeo',
    'soundcloud.com/some-band/sunny-day': 'soundcloud',
    'https://on.soundcloud.com/AbC123': 'soundcloud',
    'https://someband.bandcamp.com/track/sunny-day': 'bandcamp',
    'https://www.tiktok.com/@someone/video/7234567890123456789': 'tiktok',
    'https://vm.tiktok.com/ZMabcdef/': 'tiktok',
    'https://www.instagram.com/reel/Cabc123/': 'instagram',
    'https://www.facebook.com/watch/?v=1234567890': 'facebook',
    'https://fb.watch/abcDEF/': 'facebook',
    'https://x.com/someone/status/1234567890123456789': 'x',
    'https://twitter.com/someone/status/1234567890123456789': 'x',
    'https://www.dailymotion.com/video/x8abcd': 'dailymotion',
    'https://dai.ly/x8abcd': 'dailymotion',
    'https://clips.twitch.tv/FunnyClipName': 'twitch',
    'https://www.reddit.com/r/music/comments/abc123/sunny_day/': 'reddit',
    'https://v.redd.it/abc123def': 'reddit',
    'https://archive.org/details/SunnyDay1978': 'archive',
  };
  /* Short and share links, which no site extractor reads: followed first (resolveShortLink). */
  const short = new Set([
    'https://on.soundcloud.com/AbC123',
    'https://fb.watch/abcDEF/',
    'https://v.redd.it/abc123def',
    'https://www.facebook.com/share/v/abc123/',
    'https://www.facebook.com/share/r/abc123/',
    'https://www.reddit.com/r/music/s/abc123',
    'https://m.tiktok.com/v/7234567890123456789.html',
  ]);
  for (const text of short) sites[text] = readMediaLink(text).site;
  for (const [text, site] of Object.entries(sites)) {
    const link = readMediaLink(text);
    assert.equal(link.site, site, text);
    assert.ok(link.url.startsWith('https://'), text);
    assert.ok(!link.url.includes('#'), text);
    assert.match(link.id, /^[\w:.-]+$/, `${text}: a log-safe id`);
    if (site !== 'youtube') assert.match(link.id, new RegExp(`^${site}:[\\da-f]{10}$`), `${text}: the site and a hash`);
    assert.equal(link.short === true, short.has(text), `${text}: short ${short.has(text)}`);
  }
  assert.deepEqual([...short].map((text) => readMediaLink(text).site), ['soundcloud', 'facebook', 'reddit', 'facebook', 'facebook', 'reddit', 'tiktok']);
  /* TikTok's extractor takes only www.tiktok.com, so the bare and mobile hosts are sent as www. */
  assert.equal(readMediaLink('https://tiktok.com/@someone/video/7234567890123456789').url, 'https://www.tiktok.com/@someone/video/7234567890123456789');
  assert.equal(readMediaLink('https://m.tiktok.com/@someone/video/7234567890123456789').url, 'https://www.tiktok.com/@someone/video/7234567890123456789');
  assert.equal(readMediaLink('https://m.tiktok.com/v/7234567890123456789.html').url, 'https://m.tiktok.com/v/7234567890123456789.html', 'a short one is followed as it is');
  assert.equal(readMediaLink('https://soundcloud.com/band/song#t=1:00').url, 'https://soundcloud.com/band/song');
  assert.equal(readMediaLink('https://vimeo.com/1').siteName, 'Vimeo');
  assert.equal(readMediaLink('https://archive.org/details/x').siteName, 'the Internet Archive');
  for (const ext of ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aac', 'mp4', 'mov', 'webm']) {
    const link = readMediaLink(`https://cdn.example.com/music/Sunny%20Day.${ext.toUpperCase()}?sig=abc`);
    assert.equal(link.kind, 'file', ext);
    assert.equal(link.site, 'file');
    assert.equal(link.siteName, 'the link');
    assert.equal(link.url, `https://cdn.example.com/music/Sunny%20Day.${ext.toUpperCase()}?sig=abc`);
    assert.match(link.id, /^file:cdn\.example\.com-Sunny-Day\./);
  }
  assert.equal(readMediaLink('https://archive.org/download/SunnyDay1978/side-a.mp3').kind, 'file', 'a file ending wins');
});

test('links: pages on other sites, playlists and broken text are named, never fetched', () => {
  assert.deepEqual(readMediaLink('https://example.com/songs/sunny-day'), { problem: 'not-supported' });
  assert.deepEqual(readMediaLink('https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ'), { problem: 'not-supported' });
  assert.deepEqual(readMediaLink('https://evilbandcamp.com/track/x'), { problem: 'not-supported' });
  assert.deepEqual(readMediaLink('https://a.b.bandcamp.com/track/x'), { problem: 'not-supported' });
  assert.deepEqual(readMediaLink('https://bandcamp.com/track/x'), { problem: 'not-supported' }, 'no extractor takes bare bandcamp.com');
  assert.deepEqual(readMediaLink('https://www.youtube.com/playlist?list=PL123'), { problem: 'not-video' });
  assert.deepEqual(readMediaLink('https://www.youtube.com/@someband'), { problem: 'not-video' });
  for (const text of ['', '   ', 'not a link at all', 'ftp://cdn.example.com/song.mp3', 'javascript:alert(1)', 'file:///etc/passwd.mp3']) {
    assert.deepEqual(readMediaLink(text), { problem: 'not-link' }, JSON.stringify(text));
  }
});

test('SSRF: private, loopback, unique-local, metadata, internal names, user@host and IP literals are refused before any lookup', () => {
  const blocked = [
    'http://10.0.0.5/song.mp3',
    'http://192.168.1.20/song.mp3',
    'http://172.16.0.9/song.mp3',
    'http://127.0.0.1/song.mp3',
    'http://2130706433/song.mp3', // 127.0.0.1 as one number
    'http://0x7f.1/song.mp3',
    'http://169.254.169.254/latest/meta-data/iam.mp3', // the cloud metadata address
    'http://100.100.100.200/song.mp3',
    'http://[::1]/song.mp3',
    'http://[fd00::5]/song.mp3',
    'http://[fe80::1]/song.mp3',
    'http://[::ffff:127.0.0.1]/song.mp3',
    'https://93.184.216.34/song.mp3', // even a public address: names only
    'http://localhost/song.mp3',
    'http://localhost./song.mp3',
    'http://api.localhost/song.mp3',
    'http://mongodb/song.mp3',
    'http://redis:6379/song.mp3',
    'http://kade-api.railway.internal/song.mp3',
    'http://metadata.google.internal/computeMetadata/v1/x.mp3',
    'http://printer.local/song.mp3',
    'https://user:secret@cdn.example.com/song.mp3',
    'https://cdn.example.com@10.0.0.5/song.mp3',
    'https://attacker@soundcloud.com/band/song',
    'https://cdn.example.com:8443/song.mp3',
    'https://vimeo.com:444/76979871',
  ];
  for (const text of blocked) assert.deepEqual(readMediaLink(text), { problem: 'blocked-address' }, text);
  assert.equal(linkShapeProblem(new URL('http://[::1]/x')), 'is an IP address');
  assert.equal(linkShapeProblem(new URL('http://x.railway.internal/x')), 'is a private or internal name');
  assert.equal(linkShapeProblem(new URL('https://u@cdn.example.com/x')), 'carries a sign-in');
  assert.equal(linkShapeProblem(new URL('https://cdn.example.com/x.mp3')), null);
});

test('SSRF: a name is public only when every address it has is public; a name that does not resolve is refused', async () => {
  const cases = {
    'private.example': ['10.1.2.3'],
    'loop4.example': ['127.0.0.1'],
    'loop6.example': ['::1'],
    'ula.example': ['fd12:3456::7'],
    'linklocal6.example': ['fe80::abcd'],
    'metadata.example': ['169.254.169.254'],
    'cgnat.example': ['100.64.0.1'],
    'mapped.example': ['::ffff:192.168.0.1'],
    'mixed.example': ['93.184.216.34', '10.0.0.1'],
  };
  Object.assign(dns, cases);
  for (const host of Object.keys(cases)) assert.equal(await publicHost(host, resolve), 'blocked-address', host);
  dns['gone.example'] = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
  dns['empty.example'] = [];
  assert.equal(await publicHost('gone.example', resolve), 'not-found');
  assert.equal(await publicHost('empty.example', resolve), 'not-found');
  assert.equal(await publicHost('cdn.example.com', resolve), null);
  assert.equal(await publicHost('10.0.0.1', resolve), 'blocked-address', 'a literal is judged without a lookup');
  assert.equal(await publicHost('x.railway.internal', resolve), 'blocked-address');
  assert.ok(!dnsCalls.includes('10.0.0.1') && !dnsCalls.includes('x.railway.internal'));
});

/* ── yt-dlp: the allowlist, never the generic extractor ────────────── */

test('extractors: each site loads only its own, the generic extractor is struck out, and nothing widens it', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(SITE_EXTRACTORS)), {
    vimeo: ['vimeo'],
    soundcloud: ['soundcloud'],
    bandcamp: ['bandcamp'],
    tiktok: ['tiktok', 'vm\\.tiktok'],
    instagram: ['instagram'],
    facebook: ['facebook', 'facebook:reel'],
    x: ['twitter'],
    dailymotion: ['dailymotion'],
    twitch: ['twitch:clips'],
    reddit: ['reddit'],
    archive: ['archive\\.org'],
  });
  const everyName = Object.values(SITE_EXTRACTORS).flat();
  for (const name of everyName) {
    assert.doesNotMatch(name, /generic|^default$|^all$|shortener|^end$|youtube/i, name);
    assert.ok(!name.startsWith('-'), name);
  }
  for (const [site, own] of Object.entries(SITE_EXTRACTORS)) {
    const args = extractorArgs(site);
    assert.equal(args[0], '--use-extractors');
    assert.equal(args.length, 2);
    const names = args[1].split(',');
    assert.deepEqual(names, [...own, '-generic'], `${site}: its own extractors only, then generic struck out`);
    for (const name of everyName.filter((other) => !own.includes(other)))
      assert.ok(!names.includes(name), `${site} never loads ${name}`);
    const common = siteArgs(site);
    assert.deepEqual(common.slice(common.indexOf('--use-extractors'), common.indexOf('--use-extractors') + 2), args);
    assert.equal(common.filter((arg) => arg === '--use-extractors').length, 1);
    assert.ok(common.includes('--ignore-config'), 'no config file can add extractors');
    assert.ok(common.includes('--no-playlist'));
    assert.ok(!common.some((arg) => /force-generic|default-search|--exec|--config-location/.test(arg)));
  }
  assert.ok(!extractorArgs('reddit')[1].includes('bandcamp') && !extractorArgs('x')[1].includes('bandcamp'),
    'a Reddit or X post can never chain into Bandcamp');
  for (const site of ['youtube', 'file', '__proto__', 'constructor', 'generic']) {
    assert.throws(() => extractorArgs(site), kind('not-supported'), site);
  }
});

test('SSRF: the Bandcamp pattern bypass (a host followed by ?.bandcamp.com/track/...) never reaches yt-dlp', async () => {
  assert.deepEqual(readMediaLink('http://127.0.0.1:18931?.bandcamp.com/track/x'), { problem: 'blocked-address' });
  assert.deepEqual(readMediaLink('http://kade-api.railway.internal:3080#.bandcamp.com/track/x'), { problem: 'blocked-address' });
  assert.deepEqual(readMediaLink('https://evil.example?.bandcamp.com/track/x'), { problem: 'not-supported' });
  assert.deepEqual(readMediaLink('https://evil.example#.bandcamp.com/track/x'), { problem: 'not-supported' });
  /* A Reddit post runs yt-dlp with Reddit's extractor alone, so its outside link finds no extractor. */
  answer = () => ({ code: 1, stderr: 'ERROR: No suitable extractor found for URL http://127.0.0.1:18931#.bandcamp.com/track/x' });
  await assert.rejects(mediaAudio('https://www.reddit.com/r/music/comments/abc123/sunny_day/', options()), kind('not-supported'));
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].slice(runs[0].indexOf('--use-extractors'), runs[0].indexOf('--use-extractors') + 2), ['--use-extractors', 'reddit,-generic']);
});

const listing = (fields = {}) => JSON.stringify({
  _type: 'video', title: 'Sunny Day', duration: 3, uploader: 'Some Band', webpage_url: 'https://soundcloud.com/some-band/sunny-day',
  url: 'https://cf-media.sndcdn.com/abc.m4a',
  formats: [{ url: 'https://cf-media.sndcdn.com/abc.m4a' }, { url: 'https://cf-hls-media.sndcdn.com/playlist.m3u8', manifest_url: 'https://cf-hls-media.sndcdn.com/playlist.m3u8' }],
  ...fields,
});

test('site: a SoundCloud song comes in as an MP3 through the allowlist, the link after --, and the checked listing', async () => {
  answer = (args) => (args.includes('--dump-single-json') ? { stdout: listing() } : { tone: 3, stdout: '[download] 100%' });
  const got = await mediaAudio('https://soundcloud.com/some-band/sunny-day#comments', options());
  assert.equal(got.site, 'soundcloud');
  assert.equal(got.siteName, 'SoundCloud');
  assert.equal(got.title, 'Sunny Day');
  assert.equal(got.seconds, 3);
  assert.equal(got.uploader, 'Some Band');
  assert.equal(got.link, 'https://soundcloud.com/some-band/sunny-day');
  const head = got.buffer.subarray(0, 3);
  assert.ok(head.toString('latin1') === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0), 'an MP3');
  assert.equal(runs.length, 2, 'metadata, then one download');
  const [meta, download] = runs;
  for (const args of runs) {
    assert.deepEqual(args.slice(args.indexOf('--use-extractors'), args.indexOf('--use-extractors') + 2), ['--use-extractors', 'soundcloud,-generic']);
    assert.ok(args.includes('--ignore-config'));
    assert.ok(!args.some((arg) => arg === 'generic' || /force-generic/.test(arg)), 'the generic extractor is never asked for');
  }
  assert.equal(meta[meta.length - 2], '--', 'the link comes after --');
  assert.equal(meta.at(-1), 'https://soundcloud.com/some-band/sunny-day');
  assert.ok(meta.includes('--flat-playlist'));
  assert.ok(download.includes('--load-info-json'), 'the download uses exactly the checked listing');
  assert.ok(!download.includes('https://soundcloud.com/some-band/sunny-day'), 'and is not handed the link again');
  assert.equal(download[download.indexOf('--match-filter') + 1], 'duration <? 360 & !is_live');
  assert.deepEqual([...new Set(dnsCalls)].sort(), ['cf-hls-media.sndcdn.com', 'cf-media.sndcdn.com', 'soundcloud.com']);
  assert.deepEqual(await readdir(work), [], 'temp folder removed');
});

test('site: an album, playlist or profile is refused from the listing, and nothing is downloaded', async () => {
  answer = () => ({ stdout: JSON.stringify({ _type: 'playlist', title: 'Whole Album', entries: [{ url: 'x' }] }) });
  await assert.rejects(mediaAudio('https://someband.bandcamp.com/album/whole-album', options()), kind('not-video'));
  assert.equal(runs.length, 1);
});

test('SSRF: a listing that sends the download to a private address stops before the download', async () => {
  answer = () => ({ stdout: listing({ formats: [{ url: 'http://169.254.169.254/latest/meta-data/' }] }) });
  await assert.rejects(mediaAudio('https://vimeo.com/76979871', options()), kind('blocked-address'));
  assert.equal(runs.length, 1);
  dns['media.cdn.example'] = ['10.20.30.40'];
  answer = () => ({ stdout: listing({ url: 'https://media.cdn.example/a.m4a', formats: [] }) });
  await assert.rejects(mediaAudio('https://vimeo.com/76979871', options()), kind('blocked-address'));
  answer = () => ({ stdout: listing({ formats: [{ url: 'file:///etc/passwd' }] }) });
  await assert.rejects(mediaAudio('https://vimeo.com/76979871', options()), kind('blocked-address'));
  answer = () => ({ stdout: listing({ webpage_url: 'http://kade.railway.internal/x' }) });
  await assert.rejects(mediaAudio('https://vimeo.com/76979871', options()), kind('blocked-address'));
  assert.equal(runs.filter((args) => args.includes('--load-info-json')).length, 0, 'never downloaded');
});

test('site: yt-dlp failures come back as kinds; a link no allowlisted extractor takes is not supported', async () => {
  answer = () => ({ code: 1, stderr: 'ERROR: Unsupported URL: https://www.twitch.tv/videos/123' });
  await assert.rejects(mediaAudio('https://www.twitch.tv/videos/123', options()), kind('not-supported'));
  answer = () => ({ code: 2, stderr: 'yt-dlp: error: no such option: --use-extractors' });
  await assert.rejects(mediaAudio('https://vimeo.com/1', options()), kind('tools'));
  answer = () => ({ code: 1, stderr: 'ERROR: [Instagram] abc: Requested content is not available, rate-limit reached or login required' });
  await assert.rejects(mediaAudio('https://www.instagram.com/reel/abc/', options()), kind('private'));
  answer = () => ({ code: 1, stderr: 'ERROR: [vimeo] 1: This video is private' });
  await assert.rejects(mediaAudio('https://vimeo.com/1', options()), kind('private'));
  answer = () => ({ stdout: listing({ duration: 433 }) });
  await assert.rejects(mediaAudio('https://vimeo.com/1', options()), (error) => error.kind === 'too-long' && error.seconds === 433);
  answer = () => ({ stdout: listing({ age_limit: 18 }) });
  await assert.rejects(mediaAudio('https://www.reddit.com/r/x/comments/abc/y/', options({ allowAgeRestricted: false })), kind('age'));
  assert.equal(runs.filter((args) => args.includes('--load-info-json')).length, 0);
});

test('site: a listing without a length is measured after the download, and a long one is refused, not trimmed', async () => {
  answer = (args) => (args.includes('--dump-single-json') ? { stdout: listing({ duration: null }) } : { tone: 2 });
  const got = await mediaAudio('https://x.com/someone/status/1234567890123456789', options());
  assert.ok(got.seconds > 1.9 && got.seconds < 2.2, `measured ${got.seconds}`);
  answer = (args) => (args.includes('--dump-single-json') ? { stdout: listing({ duration: null }) } : { tone: 4 });
  await assert.rejects(mediaAudio('https://x.com/someone/status/1234567890123456789', options({ maxSeconds: 3 })), kind('too-long'));
  assert.deepEqual(await readdir(work), []);
});

/* ── a private link's key stays out of the id, the record and the log ── */

test('site: a SoundCloud secret share or a Vimeo unlisted link keeps its key out of the id, the record and every log line', async () => {
  const cases = [
    ['https://soundcloud.com/a/b/s-secret123', ['secret123'], 'https://soundcloud.com/a/b'],
    ['https://soundcloud.com/a/b/s-secret123?si=tok4567&utm_source=clipboard', ['secret123', 'tok4567'], 'https://soundcloud.com/a/b'],
    ['https://vimeo.com/1/abcdef?h=abcdef', ['abcdef'], 'https://vimeo.com/1'],
    ['https://vimeo.com/76979871/abcdef1234', ['abcdef1234'], 'https://vimeo.com/76979871'],
    ['https://player.vimeo.com/video/76979871?h=abcdef1234', ['abcdef1234'], 'https://player.vimeo.com/video/76979871'],
  ];
  for (const [text, keys, record] of cases) {
    const link = readMediaLink(text);
    for (const key of keys) assert.ok(!link.id.includes(key), `${text}: id ${link.id}`);
    assert.equal(link.url, text, 'yt-dlp itself still gets the whole link: the key is what opens it');
    assert.equal(publicSiteLink(link.site, new URL(link.url)).link, record, text);
  }
  assert.equal(publicSiteLink('vimeo', new URL('https://vimeo.com/channels/staffpicks/76979871')).link, 'https://vimeo.com/channels/staffpicks/76979871');
  assert.equal(publicSiteLink('reddit', new URL('https://www.reddit.com/r/music/comments/abc/x/?share_id=tok9876')).link, 'https://www.reddit.com/r/music/comments/abc/x/');
  /* Facebook's watch?v= only names the public video, so the record keeps it; nothing else. */
  const fb = publicSiteLink('facebook', new URL('https://www.facebook.com/watch/?v=1234567890&mibextid=tok5555'));
  assert.equal(fb.link, 'https://www.facebook.com/watch/?v=1234567890');
  assert.ok(fb.secrets.includes('tok5555') && !fb.secrets.includes('1234567890'), fb.secrets.join());
  const encoded = publicSiteLink('soundcloud', new URL('https://soundcloud.com/a/b?si=ab%2Fcd+ef99'));
  assert.equal(encoded.link, 'https://soundcloud.com/a/b');
  for (const form of ['ab%2Fcd+ef99', 'ab/cd ef99']) {
    assert.equal(hideSecrets(`yt-dlp said ${form} here`, encoded.secrets).includes(form), false, form);
  }
  assert.notEqual(readMediaLink('https://vimeo.com/1/abcdef1234').id, readMediaLink('https://vimeo.com/1/abcdef5678').id, 'different links, different ids');

  const lines = [];
  const text = 'https://soundcloud.com/a/b/s-secret123?si=tok4567';
  answer = (args) => (args.includes('--dump-single-json') ? { stdout: listing({ webpage_url: text }) } : { tone: 3 });
  const got = await mediaAudio(text, options({ log: (line) => lines.push(line) }));
  assert.equal(got.link, 'https://soundcloud.com/a/b', 'the record keeps no key');
  assert.equal(got.id, readMediaLink(text).id);
  assert.equal(runs[0].at(-1), text, 'yt-dlp was handed the whole link');

  answer = () => ({ code: 1, stderr: `ERROR: [soundcloud] s-secret123: Unable to download JSON metadata: HTTP Error 404 for ${text}` });
  const failed = await mediaAudio(text, options({ log: (line) => lines.push(line) })).catch((error) => error);
  assert.equal(failed.kind, 'removed');
  assert.ok(lines.length > 0, 'the failure was logged');
  for (const said of [...lines, failed.message, got.id, got.link]) {
    assert.ok(!said.includes('secret123') && !said.includes('tok4567'), `no key in: ${said}`);
  }
});

/* ── short and share links: followed first, every hop checked ──────── */

test('short links: on.soundcloud.com, fb.watch, v.redd.it and share links are followed to the same site, then yt-dlp gets that page', async () => {
  const hops = {
    'https://on.soundcloud.com/AbC123': 'https://soundcloud.com/some-band/sunny-day?si=abc123&utm_source=clipboard',
    'https://fb.watch/abcDEF/': 'https://www.facebook.com/share/v/xyz789/',
    'https://www.facebook.com/share/v/xyz789/': 'https://www.facebook.com/watch/?v=1234567890',
    'https://v.redd.it/abc123def': 'https://www.reddit.com/r/music/comments/abc123/sunny_day/',
    'https://www.reddit.com/r/music/s/abc123': 'https://www.reddit.com/r/music/comments/abc123/sunny_day/',
    'https://m.tiktok.com/v/7234567890123456789.html': 'https://www.tiktok.com/@someone/video/7234567890123456789',
  };
  web = (url) => (hops[url.href] ? { status: 301, headers: { Location: hops[url.href] } } : { status: 404 });
  const expected = {
    'https://on.soundcloud.com/AbC123': ['soundcloud', 'https://soundcloud.com/some-band/sunny-day?si=abc123&utm_source=clipboard', 1],
    'https://fb.watch/abcDEF/': ['facebook', 'https://www.facebook.com/watch/?v=1234567890', 2],
    'https://v.redd.it/abc123def': ['reddit', 'https://www.reddit.com/r/music/comments/abc123/sunny_day/', 1],
    'https://www.reddit.com/r/music/s/abc123': ['reddit', 'https://www.reddit.com/r/music/comments/abc123/sunny_day/', 1],
    'https://m.tiktok.com/v/7234567890123456789.html': ['tiktok', 'https://www.tiktok.com/@someone/video/7234567890123456789', 1],
  };
  for (const [text, [site, page, fetched]] of Object.entries(expected)) {
    runs = [];
    gets = [];
    answer = (args) => (args.includes('--dump-single-json') ? { stdout: listing({ webpage_url: page, url: 'https://media.example.com/a.m4a', formats: [] }) } : { tone: 2 });
    const lines = [];
    const got = await mediaAudio(text, options({ log: (line) => lines.push(line) }));
    assert.equal(got.site, site, text);
    assert.equal(gets.length, fetched, `${text}: only the short hops were requested by this code`);
    assert.ok(!gets.includes(page), `${text}: the song's page itself is left to yt-dlp`);
    assert.equal(runs[0].at(-1), page, `${text}: yt-dlp gets the page the short link led to`);
    assert.deepEqual(runs[0].slice(runs[0].indexOf('--use-extractors'), runs[0].indexOf('--use-extractors') + 2), extractorArgs(site));
    assert.equal(got.id, readMediaLink(text).id, 'the id stays the pasted link\'s');
    assert.equal(got.link, site === 'facebook' ? 'https://www.facebook.com/watch/?v=1234567890' : page.split('?')[0], `${text}: the record keeps no private query`);
    assert.ok(lines.some((line) => line.includes('the short link led to')), text);
  }
  assert.equal(closed > 0, true, 'every redirect answer was closed unread');
});

test('short links: a hop to a private address, another site, a sign-in wall or nowhere stops before yt-dlp', async () => {
  dns['internal.example'] = ['192.168.1.9'];
  const cases = [
    ['http://127.0.0.1/x', 'blocked-address'],
    ['http://[::1]/x', 'blocked-address'],
    ['http://kade-api.railway.internal/x', 'blocked-address'],
    ['https://on.soundcloud.com:444/x', 'blocked-address'],
    ['https://user@soundcloud.com/a/b', 'blocked-address'],
    ['http://internal.example/song', 'not-supported'],
    ['https://example.com/song', 'not-supported'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'not-supported'],
    ['https://someband.bandcamp.com/track/x', 'not-supported'],
    ['https://cdn.example.com/song.mp3', 'not-supported'],
    ['file:///etc/passwd', 'not-link'],
  ];
  for (const [location, expected] of cases) {
    runs = [];
    gets = [];
    web = () => ({ status: 302, headers: { Location: location } });
    await assert.rejects(mediaAudio('https://on.soundcloud.com/AbC123', options()), kind(expected), location);
    assert.deepEqual(gets, ['https://on.soundcloud.com/AbC123'], `${location}: only the short link was requested`);
    assert.equal(runs.length, 0, `${location}: yt-dlp never ran`);
  }
  web = () => ({ status: 302, headers: { Location: 'https://www.facebook.com/login/?next=%2Fwatch' } });
  await assert.rejects(mediaAudio('https://fb.watch/abcDEF/', options()), kind('private'));
  for (const [status, expected] of [[200, 'removed'], [404, 'removed'], [403, 'private'], [500, 'unavailable']]) {
    web = () => ({ status });
    await assert.rejects(mediaAudio('https://on.soundcloud.com/AbC123', options()), kind(expected), String(status));
  }
  web = () => ({ status: 302 });
  await assert.rejects(mediaAudio('https://on.soundcloud.com/AbC123', options()), kind('failed'));
  gets = [];
  dns['on.soundcloud.com'] = ['10.0.0.1'];
  await assert.rejects(mediaAudio('https://on.soundcloud.com/AbC123', options()), kind('blocked-address'));
  assert.deepEqual(gets, [], 'a short host that resolves privately is never requested');
  delete dns['on.soundcloud.com'];
  let n = 0;
  gets = [];
  web = () => ({ status: 302, headers: { Location: `https://on.soundcloud.com/hop${n++}` } });
  await assert.rejects(mediaAudio('https://on.soundcloud.com/AbC123', options()), kind('redirects'));
  assert.equal(gets.length, MEDIA_REDIRECTS);
  assert.equal(runs.length, 0);
  await assert.rejects(resolveShortLink(readMediaLink('https://on.soundcloud.com/AbC123'), { signal: AbortSignal.abort(), resolve, transport: () => Promise.reject(new Error('aborted')) }), kind('timeout'));
});

/* ── a direct file, fetched by our code ────────────────────────────── */

const toneFile = join(fixtures, 'tone.mp3');
await makeTone(toneFile, 3);
const tone = await readFile(toneFile);

test('direct file: a public MP3 comes in, measured, named from its file, without its query string', async () => {
  web = () => ({ status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(tone.length) }, body: tone });
  const got = await mediaAudio('https://cdn.example.com/music/Sunny_Day.mp3?sig=secret-token', options());
  assert.equal(got.site, 'file');
  assert.equal(got.siteName, 'the link');
  assert.equal(got.title, 'Sunny Day');
  assert.ok(got.seconds > 2.9 && got.seconds < 3.2, `measured ${got.seconds}`);
  assert.equal(got.link, 'https://cdn.example.com/music/Sunny_Day.mp3', 'no token in the record');
  assert.deepEqual(gets, ['https://cdn.example.com/music/Sunny_Day.mp3?sig=secret-token']);
  assert.deepEqual(dnsCalls, ['cdn.example.com']);
  assert.equal(runs.length, 0, 'yt-dlp never sees a direct file');
  assert.deepEqual(await readdir(work), []);
});

test('SSRF: a direct file on a name that resolves privately is refused before any request', async () => {
  for (const address of ['10.0.0.8', '192.168.0.4', '127.0.0.1', '::1', 'fd00::1', '169.254.169.254', '0.0.0.0']) {
    gets = [];
    dns['cdn.example.com'] = [address];
    await assert.rejects(mediaAudio('https://cdn.example.com/song.mp3', options()), kind('blocked-address'), address);
    assert.deepEqual(gets, [], `${address}: nothing was requested`);
  }
  dns['cdn.example.com'] = Object.assign(new Error('getaddrinfo ENOTFOUND cdn.example.com'), { code: 'ENOTFOUND' });
  await assert.rejects(mediaAudio('https://cdn.example.com/song.mp3', options()), kind('not-found'));
  assert.deepEqual(gets, []);
});

test('SSRF: every redirect is checked again: into a private name, an IP, a sign-in, another scheme', async () => {
  dns['internal.example'] = ['192.168.1.9'];
  const redirectTo = (location) => (url) => (url.hostname === 'cdn.example.com' ? { status: 302, headers: { Location: location } } : { status: 200, body: tone });
  for (const location of [
    'http://internal.example/song.mp3',
    'http://127.0.0.1/song.mp3',
    'http://[::1]:8080/song.mp3',
    'http://169.254.169.254/latest/meta-data/',
    'http://kade-api.railway.internal:3080/api/config',
    'https://user@cdn2.example.com/song.mp3',
    'file:///etc/passwd',
    'ftp://cdn2.example.com/song.mp3',
  ]) {
    gets = [];
    web = redirectTo(location);
    await assert.rejects(mediaAudio('https://cdn.example.com/song.mp3', options()), kind('blocked-address'), location);
    assert.deepEqual(gets, ['https://cdn.example.com/song.mp3'], `${location}: only the first hop was requested`);
  }
  assert.ok(closed >= 8, 'each redirect answer was closed');
});

test('direct file: public redirects are followed up to the cap, and one more is refused', async () => {
  let hop = 0;
  web = (url) => {
    const n = Number(new URL(url).searchParams.get('n') || 0);
    return n < MEDIA_REDIRECTS ? { status: 301, headers: { Location: `/song.mp3?n=${n + 1}` } } : { status: 200, headers: { 'Content-Type': 'audio/mpeg' }, body: tone };
  };
  const got = await mediaAudio('https://cdn.example.com/song.mp3', options());
  assert.equal(gets.length, MEDIA_REDIRECTS + 1);
  assert.equal(got.link, 'https://cdn.example.com/song.mp3');
  gets = [];
  web = () => ({ status: 302, headers: { Location: `https://cdn.example.com/again-${hop++}.mp3` } });
  await assert.rejects(mediaAudio('https://cdn.example.com/song.mp3', options()), kind('redirects'));
  assert.equal(gets.length, MEDIA_REDIRECTS + 1);
});

test('direct file: pages, playlists dressed as audio, and oversized files are refused', async () => {
  web = () => ({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: Buffer.from('<html>') });
  await assert.rejects(mediaAudio('https://cdn.example.com/song.mp3', options()), kind('not-media'));
  web = () => ({ status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' }, body: Buffer.from('#EXTM3U') });
  await assert.rejects(mediaAudio('https://cdn.example.com/song.mp3', options()), kind('not-media'));
  const playlist = Buffer.from('#EXTM3U\n#EXTINF:10,\nhttp://169.254.169.254/latest/meta-data/\n');
  web = () => ({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, body: playlist });
  await assert.rejects(mediaAudio('https://cdn.example.com/song.mp3', options()), kind('not-media'), 'sniffed before ffmpeg opens it');
  web = () => ({ status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(500 * 1024 ** 2) }, body: tone });
  await assert.rejects(mediaAudio('https://cdn.example.com/song.mp3', options()), kind('too-large'));
  const chunk = Buffer.alloc(1024 * 1024, 0xff);
  web = () => ({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, chunks: Array.from({ length: 70 }, () => chunk) });
  await assert.rejects(mediaAudio('https://cdn.example.com/song.mp3', options()), kind('too-large'), 'counted while streaming');
  web = () => ({ status: 404 });
  await assert.rejects(mediaAudio('https://cdn.example.com/song.mp3', options()), kind('removed'));
  web = () => ({ status: 403 });
  await assert.rejects(mediaAudio('https://cdn.example.com/song.mp3', options()), kind('private'));
  const long = join(fixtures, 'long.mp3');
  await makeTone(long, 5);
  const longBytes = await readFile(long);
  web = () => ({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, body: longBytes });
  await assert.rejects(mediaAudio('https://cdn.example.com/long.mp3', options({ maxSeconds: 4 })), (error) => error.kind === 'too-long' && error.seconds > 4.9);
  assert.deepEqual(await readdir(work), []);
  assert.equal(looksLikeMedia(new Uint8Array(Buffer.from('ffconcat version 1.0\n'))), false);
  assert.equal(looksLikeMedia(new Uint8Array(tone.subarray(0, 16))), true);
});

test('SSRF: downloadDirect checks the first address too, and the listing reader refuses odd schemes', async () => {
  dns['cdn.example.com'] = ['10.9.9.9'];
  await assert.rejects(
    downloadDirect(new URL('https://cdn.example.com/a.mp3'), join(work, 'x.mp3'), { maxBytes: 1024, signal: new AbortController().signal, resolve, transport }),
    kind('blocked-address'),
  );
  assert.deepEqual(gets, []);
  assert.deepEqual(listedHosts({ formats: [{ url: 'gopher://x.example/' }] }), { hosts: [], problem: 'a gopher: link' });
  assert.deepEqual(listedHosts({ url: 'https://a.example/x', formats: [{ url: 'https://b.example/y' }] }).hosts, ['a.example', 'b.example']);
});

test('SSRF: the real GET refuses a loopback address at connect time (a name that changes its answer is still caught)', async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.end('secret');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    await assert.rejects(
      directTransport(new URL(`http://localhost:${port}/song.mp3`), new AbortController().signal),
      (error) => error.code === 'ESSRF',
    );
    assert.equal(requests, 0, 'the connection was never made');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* ── the real yt-dlp against the host table (offline) ────────────────
 * The fake above cannot tell whether an extractor really takes a host. This runs the real yt-dlp
 * (KADE_REAL_YT_DLP, else yt-dlp on the PATH; skipped when neither is there) with each site's own
 * arguments, --simulate, and every request sent to a local proxy that answers 502, so nothing
 * leaves this machine. A host the booth accepts that no allowed extractor takes fails here. */

const REAL_YT_DLP = process.env.KADE_REAL_YT_DLP || 'yt-dlp';

function runReal(args, ms = 90000) {
  return new Promise((resolvePromise) => {
    let out = '';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const child = realSpawn(REAL_YT_DLP, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), ms);
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('error', (error) => done({ missing: error.code === 'ENOENT', out: String(error) }));
    child.on('close', (code) => done({ code, out }));
  });
}

/** A local proxy that records every request and answers 502, so yt-dlp reaches nothing. */
async function recordingProxy() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.statusCode = 502;
    res.end();
  });
  server.on('connect', (req, socket) => {
    seen.push(`CONNECT ${req.url}`);
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function realRun(site, tail) {
  const proxy = await recordingProxy();
  try {
    const result = await runReal([
      ...siteArgs(site), '--simulate', '--no-cache-dir', '--proxy', proxy.url,
      '--socket-timeout', '5', '--extractor-retries', '0', ...tail,
    ]);
    return { ...result, seen: [...proxy.seen] };
  } finally {
    await proxy.close();
  }
}

async function inTurns(items, width, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i]);
    }
  }));
  return results;
}

test('real yt-dlp: every host the booth sends to yt-dlp has an extractor, and no site can reach Bandcamp or an internal host', { timeout: 600000 }, async (t) => {
  const version = await runReal(['--version'], 30000);
  if (version.missing || version.code !== 0) {
    t.skip(`yt-dlp is not installed here (${REAL_YT_DLP}); set KADE_REAL_YT_DLP to run this check`);
    return;
  }
  const table = [
    'https://vimeo.com/76979871',
    'https://www.vimeo.com/76979871',
    'https://player.vimeo.com/video/76979871',
    'https://vimeo.com/76979871/abcdef1234',
    'https://soundcloud.com/some-band/sunny-day',
    'https://www.soundcloud.com/some-band/sunny-day',
    'https://m.soundcloud.com/some-band/sunny-day',
    'https://soundcloud.com/some-band/sunny-day/s-AbCdEf123',
    'https://someband.bandcamp.com/track/sunny-day',
    'https://www.tiktok.com/@someone/video/7234567890123456789',
    'https://vm.tiktok.com/ZMabcdef/',
    'https://vt.tiktok.com/ZMabcdef/',
    'https://www.instagram.com/reel/Cabc123/',
    'https://www.instagram.com/p/Cabc123/',
    'https://www.facebook.com/watch/?v=1234567890',
    'https://www.facebook.com/someone/videos/1234567890/',
    'https://www.facebook.com/reel/1234567890',
    'https://x.com/someone/status/1234567890123456789',
    'https://twitter.com/someone/status/1234567890123456789',
    'https://www.dailymotion.com/video/x8abcd',
    'https://dai.ly/x8abcd',
    'https://clips.twitch.tv/FunnyClipName',
    'https://www.twitch.tv/someone/clip/FunnyClipName',
    'https://www.reddit.com/r/music/comments/abc123/sunny_day/',
    'https://old.reddit.com/r/music/comments/abc123/sunny_day/',
    'https://archive.org/details/SunnyDay1978',
    /* Every other host readMediaLink accepts for a site. */
    'https://tiktok.com/@someone/video/7234567890123456789',
    'https://m.tiktok.com/@someone/video/7234567890123456789',
    'https://instagram.com/reel/Cabc123/',
    'https://facebook.com/watch/?v=1234567890',
    'https://m.facebook.com/watch/?v=1234567890',
    'https://web.facebook.com/watch/?v=1234567890',
    'https://www.x.com/someone/status/1234567890123456789',
    'https://mobile.x.com/someone/status/1234567890123456789',
    'https://www.twitter.com/someone/status/1234567890123456789',
    'https://mobile.twitter.com/someone/status/1234567890123456789',
    'https://dailymotion.com/video/x8abcd',
    'https://twitch.tv/someone/clip/FunnyClipName',
    'https://m.twitch.tv/someone/clip/FunnyClipName',
    'https://reddit.com/r/music/comments/abc123/sunny_day/',
    'https://new.reddit.com/r/music/comments/abc123/sunny_day/',
    'https://www.archive.org/details/SunnyDay1978',
    'https://vimeo.com/channels/staffpicks/76979871',
  ];
  const covered = new Set(table.map((text) => new URL(text).hostname));
  for (const host of MEDIA_SITE_HOSTS) {
    assert.ok(covered.has(host) || readMediaLink(`https://${host}/x`).short, `${host} is in the real check`);
  }
  const results = await inTurns(table, 4, async (text) => {
    const link = readMediaLink(text);
    assert.equal(link.kind, 'site', text);
    assert.ok(!link.short, `${text} goes straight to yt-dlp`);
    return { text, site: link.site, ...(await realRun(link.site, ['--flat-playlist', '--', link.url])) };
  });
  for (const { text, site, out } of results) {
    assert.doesNotMatch(out, /No suitable extractor|Unsupported URL/, `${text} (${site}): ${out.slice(-400)}`);
    assert.match(out, /\[[\w:. -]+\]/, `${text}: an allowed extractor took it: ${out.slice(-400)}`);
  }

  /* The review's bypass, both ways: the hostile link handed over directly, and handed on by a
   * site's listing as url_transparent (with and without naming Bandcamp's extractor). */
  const hostile = 'http://127.0.0.1:18931#.bandcamp.com/track/x';
  const chains = await inTurns(Object.keys(SITE_EXTRACTORS).filter((site) => site !== 'bandcamp'), 4, async (site) => {
    const direct = await realRun(site, ['--', 'http://127.0.0.1:18931?.bandcamp.com/track/x']);
    const listing = join(work, `chain-${site}.json`);
    await import('node:fs/promises').then((fs) => fs.writeFile(listing, JSON.stringify({ _type: 'url_transparent', url: hostile, ie_key: 'Bandcamp', id: 'x', title: 'x' })));
    const named = await realRun(site, ['--load-info-json', listing]);
    await import('node:fs/promises').then((fs) => fs.writeFile(listing, JSON.stringify({ _type: 'url_transparent', url: hostile, id: 'x', title: 'x' })));
    const unnamed = await realRun(site, ['--load-info-json', listing]);
    await rm(listing, { force: true });
    return { site, direct, named, unnamed };
  });
  for (const { site, direct, named, unnamed } of chains) {
    for (const [how, run] of Object.entries({ direct, named, unnamed })) {
      assert.match(run.out, /No suitable extractor/, `${site} ${how}: ${run.out.slice(-400)}`);
      assert.doesNotMatch(run.out, /\[Bandcamp\]/, `${site} ${how}`);
      assert.deepEqual(run.seen, [], `${site} ${how}: no request was even attempted`);
    }
  }
});
