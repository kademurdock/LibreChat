/**
 * Part 293: YouTube audio for the Sound Booth's YuE2 covers (youtubeAudio in youtube.ts).
 * yt-dlp never runs here: child_process.spawn answers for a fake yt-dlp binary like yt-dlp
 * does, and the "download" writes a real tone with ffmpeg-static, so the real MP3 conversion,
 * temp folder and cleanup are exercised end to end. ffmpeg runs for real.
 *
 * Run: node --import tsx --test packages/api/src/description/youtubeAudio.test.mjs
 */
import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import {
  ffmpegLocation,
  readAudioMetadata,
  readYouTubeLink,
  youtubeAudio,
  YouTubeAudioError,
  youtubeURL,
} from './youtube.ts';

process.env.FFMPEG_PATH = ffmpegPath;
delete process.env.KADE_YT_COOKIES;
delete process.env.KADE_POT_URL;
const FAKE = 'fake-yt-dlp-for-tests';
process.env.YT_DLP_PATH = FAKE;

const realSpawn = childProcess.spawn;
/** Every fake yt-dlp run: its arguments. */
let runs = [];
/** How the fake answers: (args, run) => { code, stdout, stderr, tone, hang }. */
let answer = () => ({ code: 0 });

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
  if (options.signal) {
    options.signal.addEventListener(
      'abort',
      () => {
        if (finished) return;
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        child.emit('error', error);
        finish(null);
      },
      { once: true },
    );
  }
  if (reply.hang) return child;
  setImmediate(async () => {
    if (reply.tone) {
      const target = args[args.indexOf('-o') + 1].replace('%(ext)s', reply.tone.ext);
      await new Promise((resolve, reject) => {
        const make = realSpawn(ffmpegPath, [
          '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${reply.tone.seconds}`,
          ...(reply.tone.ext === 'webm' ? ['-c:a', 'libopus'] : ['-c:a', 'aac']), target,
        ]);
        make.on('close', (code) => (code === 0 ? resolve() : reject(new Error('fixture ffmpeg failed'))));
      });
    }
    if (reply.stdout) child.stdout.emit('data', Buffer.from(reply.stdout));
    if (reply.stderr) child.stderr.emit('data', Buffer.from(reply.stderr));
    finish(reply.code ?? 0);
  });
  return child;
}
childProcess.spawn = (bin, args, options) => (bin === FAKE ? fakeYtDlp(args, options) : realSpawn(bin, args, options));
syncBuiltinESMExports();

const root = await mkdtemp(join(tmpdir(), 'kade-ytaudio-test-'));
after(() => rm(root, { recursive: true, force: true }));
beforeEach(() => {
  runs = [];
});

const metadata = (fields = {}) => JSON.stringify({ title: 'Sunny Day (Official Audio)', duration: 3, uploader: 'Some Band', ...fields });
const isMetadataRun = (args) => args.includes('--dump-single-json');
const options = (extra = {}) => ({ maxSeconds: 360, maxBytes: 20 * 1024 * 1024, signal: new AbortController().signal, tmp: root, ...extra });

test('links: every YouTube shape becomes one plain watch link, and playlist or radio parts are dropped', () => {
  const id = 'dQw4w9WgXcQ';
  const canonical = `https://www.youtube.com/watch?v=${id}`;
  for (const link of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&list=PLabc123&index=4`,
    `https://www.youtube.com/watch?v=${id}&list=RD${id}&start_radio=1`,
    `https://m.youtube.com/watch?v=${id}&feature=share`,
    `https://music.youtube.com/watch?v=${id}&list=RDAMVM${id}`,
    `https://youtu.be/${id}?si=abcdef&t=42`,
    `https://www.youtube.com/shorts/${id}?feature=share`,
    `https://youtube.com/live/${id}`,
    `https://www.youtube.com/embed/${id}?start=10`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `http://www.youtube.com/watch?v=${id}`,
    `youtu.be/${id}`,
    `  www.youtube.com/watch?v=${id}  `,
  ]) {
    assert.deepEqual(readYouTubeLink(link), { id, url: canonical }, link);
  }
});

test('links: other sites, channels, playlists and broken text are named, never fetched', () => {
  const problem = (text) => readYouTubeLink(text).problem;
  assert.equal(problem('https://vimeo.com/123456'), 'not-youtube');
  assert.equal(problem('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ'), 'not-youtube');
  assert.equal(problem('https://open.spotify.com/track/abc'), 'not-youtube');
  assert.equal(problem('https://www.youtube.com/playlist?list=PLabc123'), 'not-video');
  assert.equal(problem('https://www.youtube.com/@SomeBand'), 'not-video');
  assert.equal(problem('https://www.youtube.com/results?search_query=song'), 'not-video');
  assert.equal(problem('https://www.youtube.com/watch?list=PLabc123'), 'not-video');
  assert.equal(problem('https://youtu.be/short'), 'not-video');
  assert.equal(problem('not a link at all'), 'not-link');
  assert.equal(problem(''), 'not-link');
  assert.equal(problem('https://youtube.com@localhost/watch?v=dQw4w9WgXcQ'), 'not-link');
  assert.equal(problem('https://youtube.com:8443/watch?v=dQw4w9WgXcQ'), 'not-link');
  assert.equal(problem('javascript:alert(1)'), 'not-link');
  assert.equal(problem('file:///etc/passwd'), 'not-link');
  // The describer keeps its own sentences.
  assert.throws(() => youtubeURL('not a link at all'), { message: 'Enter a YouTube video link.' });
  assert.throws(() => youtubeURL('https://youtube.com/playlist?list=abc'), {
    message: 'Enter a single YouTube video link, not a channel or playlist.',
  });
  assert.equal(youtubeURL('https://youtu.be/aqz-KE-bpKQ?t=5'), 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
});

test('ffmpeg: only a real path is handed to yt-dlp, never a bare name', () => {
  const saved = process.env.FFMPEG_PATH;
  try {
    process.env.FFMPEG_PATH = 'ffmpeg';
    assert.deepEqual(ffmpegLocation(), []);
    process.env.FFMPEG_PATH = 'C:\\tools\\ffmpeg.exe';
    assert.deepEqual(ffmpegLocation(), ['--ffmpeg-location', 'C:\\tools\\ffmpeg.exe']);
  } finally {
    process.env.FFMPEG_PATH = saved;
  }
});

test('metadata: the length is judged before any download, in kinds rather than sentences', () => {
  const kind = (json, cookies = false, grownUp = true) => {
    try {
      readAudioMetadata(json, 360, cookies, grownUp);
      return 'ok';
    } catch (error) {
      assert.ok(error instanceof YouTubeAudioError);
      return error.kind;
    }
  };
  assert.equal(kind({ title: 'x', duration: 433.1 }), 'too-long');
  try {
    readAudioMetadata({ title: 'x', duration: 433.1 }, 360, false);
  } catch (error) {
    assert.equal(error.seconds, 433.1);
  }
  // YouTube lists whole seconds, so a listing AT the limit may hold a fraction more: refused too.
  assert.equal(kind({ title: 'x', duration: 360 }), 'too-long');
  assert.equal(kind({ title: 'x', duration: 359 }), 'ok');
  assert.equal(kind({ title: 'x', is_live: true, live_status: 'is_live' }), 'live');
  assert.equal(kind({ title: 'x', live_status: 'is_upcoming' }), 'live');
  assert.equal(kind({ title: 'x', live_status: 'post_live' }), 'processing');
  assert.equal(kind({ title: 'x', duration: 60, availability: 'private' }), 'private');
  assert.equal(kind({ title: 'x', duration: 60, availability: 'subscriber_only' }), 'members');
  assert.equal(kind({ title: 'x', duration: 60, availability: 'premium_only' }), 'premium');
  assert.equal(kind({ title: 'x', duration: 60, age_limit: 18 }), 'age');
  assert.equal(kind({ title: 'x', duration: 60, age_limit: 18 }, true), 'ok', 'signed-in cookies may get through');
  // A child is refused an age-restricted video even when the server is signed in.
  assert.equal(kind({ title: 'x', duration: 60, age_limit: 18 }, true, false), 'age');
  assert.equal(kind({ title: 'x', duration: 60, availability: 'needs_auth' }, true, false), 'age');
  assert.equal(kind({ title: 'x', duration: 60, availability: 'needs_auth' }, false, true), 'age');
  assert.equal(kind({ title: 'x', duration: 60, age_limit: 0 }, true, false), 'ok', 'a child keeps ordinary videos');
  assert.equal(
    (() => { try { readAudioMetadata({ title: 'x', duration: 60, age_limit: 18 }, 360, true); return 'ok'; } catch (error) { return error.kind; } })(),
    'age',
    'not allowed unless the caller says so',
  );
  assert.equal(kind({ title: 'x' }), 'no-length');
  assert.equal(kind(null), 'unreadable');
  const zwsp = String.fromCodePoint(0x200b);
  assert.equal(readAudioMetadata({ title: `Sunny ${zwsp}Day`, duration: 60 }, 360, false).title, 'Sunny Day');
});

test('download: one video comes in as an MP3 with its title and length, and the temp folder goes', async () => {
  answer = (args) =>
    isMetadataRun(args) ? { stdout: metadata() } : { tone: { ext: 'webm', seconds: 3 }, stdout: '[download] 100%' };
  const got = await youtubeAudio('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ', options());
  assert.equal(got.title, 'Sunny Day (Official Audio)');
  assert.equal(got.seconds, 3);
  assert.equal(got.uploader, 'Some Band');
  assert.equal(got.id, 'dQw4w9WgXcQ');
  assert.equal(got.link, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  const head = got.buffer.subarray(0, 3);
  assert.ok(head.toString('latin1') === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0), 'an MP3');
  assert.ok(got.buffer.length > 10000);
  assert.equal(runs.length, 2, 'metadata, then one download');
  for (const args of runs) {
    assert.ok(args.includes('--no-playlist'));
    assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'never the playlist link');
    assert.ok(!args.join(' ').includes('list='));
  }
  const download = runs[1];
  assert.equal(download[download.indexOf('-f') + 1], 'ba[acodec^=mp4a]/ba/b[height<=360]/b');
  assert.equal(download[download.indexOf('--match-filter') + 1], 'duration < 360 & !is_live');
  assert.deepEqual(await readdir(root), [], 'temp folder removed');
});

test('duration: a video over six minutes is refused from its metadata, and nothing is downloaded', async () => {
  answer = () => ({ stdout: metadata({ duration: 433 }) });
  await assert.rejects(youtubeAudio('https://youtu.be/dQw4w9WgXcQ', options()), (error) => {
    assert.equal(error.kind, 'too-long');
    assert.equal(error.seconds, 433);
    return true;
  });
  assert.equal(runs.length, 1);
  assert.ok(isMetadataRun(runs[0]));
  assert.deepEqual(await readdir(root), []);
});

/** The MP3's real length, from ffprobe. */
async function measured(buffer) {
  const file = join(root, 'measure.mp3');
  await writeFile(file, buffer);
  try {
    return await new Promise((resolve, reject) => {
      const probe = realSpawn(ffprobeStatic.path, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
      let out = '';
      probe.stdout.on('data', (chunk) => (out += chunk));
      probe.on('close', (code) => (code === 0 ? resolve(Number(out.trim())) : reject(new Error('ffprobe failed'))));
    });
  } finally {
    await rm(file, { force: true });
  }
}

test('duration: the MP3 stops a tenth of a second short of the limit, so a listing just under it always fits', async () => {
  // Listed at 2 s under a 3 s limit, but holding 2.99 s of sound (plus the encoder's few hundredths).
  answer = (args) => (isMetadataRun(args) ? { stdout: metadata({ duration: 2 }) } : { tone: { ext: 'webm', seconds: 2.99 } });
  const got = await youtubeAudio('https://youtu.be/dQw4w9WgXcQ', options({ maxSeconds: 3 }));
  const seconds = await measured(got.buffer);
  assert.ok(seconds <= 2.95 && seconds > 2.8, `measured ${seconds} s`);
  // A short song is never touched by the cut.
  answer = (args) => (isMetadataRun(args) ? { stdout: metadata({ duration: 2 }) } : { tone: { ext: 'webm', seconds: 2 } });
  const whole = await measured((await youtubeAudio('https://youtu.be/dQw4w9WgXcQ', options({ maxSeconds: 360 }))).buffer);
  assert.ok(whole > 1.95 && whole < 2.1, `measured ${whole} s`);
  assert.deepEqual(await readdir(root), []);
});

test('errors: a private video stops at the first client; a link that is not YouTube never starts yt-dlp', async () => {
  answer = () => ({ code: 1, stderr: 'ERROR: [youtube] dQw4w9WgXcQ: Private video. Sign in if you have been granted access to this video' });
  await assert.rejects(youtubeAudio('https://youtu.be/dQw4w9WgXcQ', options()), { kind: 'private' });
  assert.equal(runs.length, 1);
  runs = [];
  await assert.rejects(youtubeAudio('https://vimeo.com/1', options()), { kind: 'not-youtube' });
  await assert.rejects(youtubeAudio('https://www.youtube.com/playlist?list=PL1', options()), { kind: 'not-video' });
  assert.equal(runs.length, 0);
  assert.deepEqual(await readdir(root), []);
});

test('errors: the bot wall on every client is named as the bot wall', async () => {
  answer = () => ({ code: 1, stderr: "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication." });
  await assert.rejects(youtubeAudio('https://youtu.be/dQw4w9WgXcQ', options()), { kind: 'bot' });
  assert.equal(runs.length, 8, 'two passes round the four clients');
  assert.deepEqual(await readdir(root), []);
});

test('errors: a deadline that cuts the climb short still names what YouTube was answering', async () => {
  answer = (_args, run) =>
    run === 1 ? { code: 1, stderr: "ERROR: Sign in to confirm you're not a bot" } : { hang: true };
  const started = Date.now();
  await assert.rejects(youtubeAudio('https://youtu.be/dQw4w9WgXcQ', options({ metadataMs: 400 })), { kind: 'bot' });
  assert.ok(Date.now() - started < 5000);
  runs = [];
  answer = () => ({ hang: true });
  const stop = new AbortController();
  setTimeout(() => stop.abort(new Error('deadline')), 200);
  await assert.rejects(youtubeAudio('https://youtu.be/dQw4w9WgXcQ', options({ signal: stop.signal })), { kind: 'timeout' });
  assert.deepEqual(await readdir(root), [], 'cleaned up after a timeout too');
});

test('errors: a slow download after a walled metadata client is a timeout, not the bot wall', async () => {
  // Metadata: the first client is walled, the second answers. Then the download hangs past the deadline.
  answer = (args, run) =>
    run === 1
      ? { code: 1, stderr: "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication." }
      : isMetadataRun(args)
        ? { stdout: metadata() }
        : { hang: true };
  const stop = new AbortController();
  setTimeout(() => stop.abort(new Error('deadline')), 500);
  await assert.rejects(youtubeAudio('https://youtu.be/dQw4w9WgXcQ', options({ signal: stop.signal })), (error) => {
    assert.equal(error.kind, 'timeout');
    return true;
  });
  assert.equal(runs.length, 3, 'walled, metadata, then the download that hung');
  assert.ok(!isMetadataRun(runs[2]));
  assert.deepEqual(await readdir(root), []);
});

test('age: a child is refused an age-restricted video even when the server is signed in, and nothing is downloaded', async () => {
  process.env.KADE_YT_COOKIES = '# Netscape HTTP Cookie File (test placeholder)\n';
  try {
    answer = () => ({ stdout: metadata({ age_limit: 18, availability: 'needs_auth', duration: 200 }) });
    await assert.rejects(youtubeAudio('https://youtu.be/dQw4w9WgXcQ', options({ allowAgeRestricted: false })), { kind: 'age' });
    assert.equal(runs.length, 1, 'only the metadata pass ran');
    assert.ok(isMetadataRun(runs[0]));
    runs = [];
    await assert.rejects(youtubeAudio('https://youtu.be/dQw4w9WgXcQ', options()), { kind: 'age' }, 'refused unless the caller allows it');
    assert.equal(runs.length, 1);
    // A grown-up with the server signed in gets through to the download.
    runs = [];
    answer = (args) =>
      isMetadataRun(args)
        ? { stdout: metadata({ age_limit: 18, availability: 'needs_auth', duration: 3 }) }
        : { tone: { ext: 'm4a', seconds: 3 } };
    const got = await youtubeAudio('https://youtu.be/dQw4w9WgXcQ', options({ allowAgeRestricted: true }));
    assert.ok(got.buffer.length > 10000);
    assert.equal(runs.length, 2);
  } finally {
    delete process.env.KADE_YT_COOKIES;
  }
  assert.deepEqual(await readdir(root), []);
});

test('errors: an MP3 over the size cap is refused, and a missing download is a plain failure', async () => {
  answer = (args) => (isMetadataRun(args) ? { stdout: metadata({ duration: 3 }) } : { tone: { ext: 'm4a', seconds: 3 } });
  await assert.rejects(youtubeAudio('https://youtu.be/dQw4w9WgXcQ', options({ maxBytes: 2000 })), { kind: 'too-large' });
  answer = (args) =>
    isMetadataRun(args)
      ? { stdout: metadata() }
      : { stdout: '[download] File is larger than max-filesize (99999999 bytes > 67108864 bytes). Aborting.' };
  await assert.rejects(youtubeAudio('https://youtu.be/dQw4w9WgXcQ', options()), { kind: 'too-large' });
  answer = (args) => (isMetadataRun(args) ? { stdout: metadata() } : { stdout: '[download] nothing happened' });
  await assert.rejects(youtubeAudio('https://youtu.be/dQw4w9WgXcQ', options()), { kind: 'failed' });
  assert.deepEqual(await readdir(root), []);
});
