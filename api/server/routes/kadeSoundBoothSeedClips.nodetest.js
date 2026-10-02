/* Oct 2 2026: Seed Audio's reference clips (kadeSoundBoothSeedClips.js) and the Seed lane of
 * POST /render and POST /reference that use them.
 *
 * Her Seed Audio renders had stopped coming through. Her voice clip was 32.6 seconds; fal takes
 * 30 and answered 422, and the booth said
 * "[object Object]". The first half here needs nothing: the decisions, the ffmpeg argument lists
 * and the sentences. The second half runs real ffmpeg on synthetic tones (never anyone's voice) and
 * the real booth routes against a stub fal, stub storage and an in-memory Mongo; it is skipped
 * when ffmpeg is not installed (set FFMPEG_PATH and FFPROBE_PATH to point at one).
 *
 * Run: node --test api/server/routes/kadeSoundBoothSeedClips.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFile } = require('node:child_process');
const clips = require('./kadeSoundBoothSeedClips');

const USER = '6a0000000000000000000abc';
const OTHER = '6a0000000000000000000def';

/* ---------------- the decisions, without ffmpeg ---------------- */

test('a clip is known by its first bytes, not by its name', () => {
  const pad = (head) => Buffer.concat([Buffer.from(head, 'latin1'), Buffer.alloc(64)]);
  assert.equal(clips.sniffFormat(pad('RIFF\x24\x00\x00\x00WAVEfmt ')), 'wav');
  assert.equal(clips.sniffFormat(pad('OggS\x00\x02' + '\x00'.repeat(22) + '\x13OpusHead')), 'ogg_opus');
  assert.equal(clips.sniffFormat(pad('OggS\x00\x02' + '\x00'.repeat(22) + '\x01vorbis')), 'ogg');
  assert.equal(clips.sniffFormat(pad('fLaC\x00\x00\x00\x22')), 'flac');
  assert.equal(clips.sniffFormat(pad('\x00\x00\x00\x20ftypM4A ')), 'm4a');
  assert.equal(clips.sniffFormat(pad('ID3\x04\x00\x00')), 'mp3');
  assert.equal(clips.sniffFormat(Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(64)])), 'mp3', 'an MPEG-1 Layer III frame');
  assert.equal(clips.sniffFormat(Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80]), Buffer.alloc(64)])), null, 'ADTS AAC is not MP3');
  assert.equal(clips.sniffFormat(Buffer.from('tiny')), null);
});

test('the plan: long clips are cut, unreadable or oversized ones converted, the rest kept', () => {
  assert.deepEqual(clips.seedClipPlan({ seconds: 32.6, bytes: 3129804, format: 'wav' }), { action: 'fit', cut: true, why: ['long'] });
  assert.deepEqual(clips.seedClipPlan({ seconds: 29.5, bytes: 2832078, format: 'wav' }), { action: 'keep', cut: false, why: [] });
  assert.deepEqual(clips.seedClipPlan({ seconds: 29.6, bytes: 500000, format: 'mp3' }), { action: 'fit', cut: true, why: ['long'] });
  assert.deepEqual(clips.seedClipPlan({ seconds: 12, bytes: 300000, format: 'm4a' }), { action: 'fit', cut: false, why: ['format'] });
  assert.deepEqual(clips.seedClipPlan({ seconds: 12, bytes: 300000, format: 'ogg' }), { action: 'fit', cut: false, why: ['format'] });
  assert.deepEqual(clips.seedClipPlan({ seconds: 12, bytes: 300000, format: 'ogg_opus' }), { action: 'keep', cut: false, why: [] });
  assert.deepEqual(clips.seedClipPlan({ seconds: 25, bytes: 14400000, format: 'wav' }), { action: 'fit', cut: false, why: ['big'] });
  assert.deepEqual(clips.seedClipPlan({ seconds: 47, bytes: 14400000, format: 'flac' }), { action: 'fit', cut: true, why: ['long', 'big', 'format'] });
  assert.deepEqual(clips.seedClipPlan({ seconds: null, bytes: 300000, format: null }), { action: 'keep', cut: false, why: ['length unknown'] });
  assert.equal(clips.SEED_CLIP_LIMIT_SECONDS, 30);
  assert.equal(clips.SEED_CLIP_MAX_BYTES, 10000000);
});

test("ffmpeg's silence report is read, including a pause that runs past what was read", () => {
  const stderr = [
    'Input #0, mp3, from \'in.mp3\':',
    '[silencedetect @ 0000020a] silence_start: 2.61',
    '[silencedetect @ 0000020a] silence_end: 3.2 | silence_duration: 0.59',
    '[silencedetect @ 0000020a] silence_start: 24.3',
    '[silencedetect @ 0000020a] silence_end: 25.1 | silence_duration: 0.8',
    '[silencedetect @ 0000020a] silence_start: 29.1',
    'size=N/A time=00:00:29.50 bitrate=N/A speed= 300x',
  ].join('\r\n');
  assert.deepEqual(clips.parseSilences(stderr), [
    { start: 2.61, end: 3.2 }, { start: 24.3, end: 25.1 }, { start: 29.1, end: null },
  ]);
  assert.deepEqual(clips.parseSilences(''), []);
});

test('the cut: the latest pause after twenty seconds, a little way into the quiet; else at 29.5', () => {
  assert.deepEqual(clips.chooseCut([{ start: 21, end: 21.6 }, { start: 26.2, end: 27 }]), { at: 26.6, pause: true });
  assert.deepEqual(clips.chooseCut([{ start: 26.2, end: 26.5 }]), { at: 26.35, pause: true }, 'half way into a short pause');
  assert.deepEqual(clips.chooseCut([{ start: 29.1, end: null }]), { at: 29.3, pause: true }, 'a pause running to the limit is cut half way into what is left of it');
  assert.deepEqual(clips.chooseCut([{ start: 29.2, end: 30.4 }]), { at: 29.4, pause: true }, 'never closer than a tenth to the limit');
  assert.deepEqual(clips.chooseCut([{ start: 29.4, end: null }]), { at: 29.5, pause: false }, 'too close to the limit to count');
  assert.deepEqual(clips.chooseCut([{ start: 12, end: 14 }]), { at: 29.5, pause: false }, 'a pause before twenty seconds would throw away too much');
  assert.deepEqual(clips.chooseCut([]), { at: 29.5, pause: false });
  assert.deepEqual(clips.chooseCut(undefined), { at: 29.5, pause: false });
  for (const s of [20, 23.3, 27.77, 29.2]) {
    const cut = clips.chooseCut([{ start: s, end: s + 3 }]);
    assert.ok(cut.at <= 29.4 && cut.at > s, `${s}: ${cut.at}`);
  }
});

test('the ffmpeg argument lists, exactly', () => {
  assert.deepEqual(clips.silenceArgs('/tmp/in.mp3'), ['-nostdin', '-hide_banner', '-nostats', '-t', '29.5', '-i', '/tmp/in.mp3', '-vn', '-af', 'silencedetect=noise=-35dB:d=0.25', '-f', 'null', '-']);
  assert.deepEqual(clips.fitArgs('/tmp/in.mp3', '/tmp/seed.wav', { at: 28.5, fade: 0.3 }), [
    '-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', '/tmp/in.mp3', '-vn',
    '-t', '28.50', '-af', 'afade=t=out:st=28.20:d=0.3',
    '-ac', '1', '-ar', '48000', '-sample_fmt', 's16', '/tmp/seed.wav',
  ]);
  assert.deepEqual(clips.fitArgs('/tmp/in.m4a', '/tmp/seed.wav', { at: null }), [
    '-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', '/tmp/in.m4a', '-vn', '-ac', '1', '-ar', '48000', '-sample_fmt', 's16', '/tmp/seed.wav',
  ], 'a conversion has no cut and no fade');
});

test('the sentences she hears', () => {
  assert.equal(clips.sayTrimmed('Your clip', 32.6, 29.5, false), 'Your clip was 33 seconds. Seed Audio takes up to 30, so the first 29 and a half seconds were used.');
  assert.equal(clips.sayTrimmed('Clip 2', 47, 28.04, true), 'Clip 2 was 47 seconds. Seed Audio takes up to 30, so the first 28 seconds were used, ending at a pause.');
  /* A clip of 29.5 to 30 seconds is cut too; said by its length it would sound like a cut for no reason. */
  assert.equal(clips.sayTrimmed('Your clip', 29.8, 29.5, false), "Your clip was right at Seed Audio's 30-second limit, so to be safe the first 29 and a half seconds were used.");
  assert.equal(clips.sayTrimmed('Clip 2', 30, 26.4, true), "Clip 2 was right at Seed Audio's 30-second limit, so to be safe the first 26 and a half seconds were used, ending at a pause.");
  assert.equal(clips.sayTrimmed('Your clip', 30.04, 29.5, false), "Your clip was right at Seed Audio's 30-second limit, so to be safe the first 29 and a half seconds were used.", 'rounds to 30, so it is said as the limit');
  assert.equal(clips.sayTrimmed('Your clip', 30.1, 29.5, false), 'Your clip was 30.1 seconds. Seed Audio takes up to 30, so the first 29 and a half seconds were used.');
  assert.equal(clips.sayTrimmed('Your clip', undefined, 29.5, false), 'Your clip was longer than 30 seconds. Seed Audio takes up to 30, so the first 29 and a half seconds were used.');
  for (const was of [29.51, 29.8, 29.96, 30, 30.04]) {
    assert.doesNotMatch(clips.sayTrimmed('Your clip', was, 29.5, false), /was (29|30)(\.\d)? seconds/, `${was} is never said as a length under or at the limit`);
  }
  assert.equal(clips.sayConverted('Your clip', ['format']), 'Your clip was in a format Seed Audio cannot read, so a WAV copy was sent.');
  assert.equal(clips.sayConverted('Clip 3', ['big']), 'Clip 3 was too big a file for Seed Audio, so a smaller copy was sent.');
  assert.equal(clips.sayConverted('Clip 1', ['big', 'format']), 'Clip 1 was too big and in a format Seed Audio cannot read, so a smaller WAV copy was sent.');
  assert.equal(clips.sayImportTrim(32.6, { seconds: 28.51, pause: true }), 'Seed Audio takes clips up to 30 seconds. Yours was 33, so the first 28 and a half seconds were kept, ending at a pause.');
  assert.equal(clips.sayImportTrim(45, { seconds: 29.5, pause: false }, { capped: true }), 'Seed Audio takes clips up to 30 seconds. Yours was longer than 45 seconds, so the first 29 and a half seconds were kept.');
  assert.equal(clips.sayImportTrim(29.8, { seconds: 29.5, pause: false }), 'Seed Audio takes clips up to 30 seconds. Yours was right at that limit, so to be safe the first 29 and a half seconds were kept.');
  assert.equal(clips.sayImportLong(32.6), 'Seed Audio takes clips up to 30 seconds. This one is 33, so when you render, the first 29 and a half seconds are used.');
  assert.equal(clips.sayImportLong(29.9), 'Seed Audio takes clips up to 30 seconds. This one is right at that limit, so to be safe, when you render, the first 29 and a half seconds are used.');
  const said = [
    clips.sayTrimmed('Clip 1', 31, 29.5, true), clips.sayTrimmed('Clip 1', 29.9, 29.5, true), clips.sayConverted('Clip 1', ['big']),
    clips.sayImportTrim(40, { seconds: 29.5 }), clips.sayImportTrim(29.7, { seconds: 29.5 }), clips.sayImportLong(40), clips.sayImportLong(29.7),
  ];
  for (const line of said) assert.doesNotMatch(line, /[;:()]/, 'plain sentences, nothing a screen reader stumbles on');
});

test('which clips the booth may open, and the copy beside them', () => {
  const ours = `https://store.test/bucket/audios/${USER}/soundbooth-ref-abc.wav?X-Amz-Signature=old`;
  const fresh = `https://store.test/bucket/audios/${USER}/soundbooth-ref-abc.wav?X-Amz-Signature=new`;
  assert.deepEqual(clips.ownClip(ours, fresh, USER), { file: 'soundbooth-ref-abc.wav' });
  assert.equal(clips.ownClip(ours, fresh, OTHER), null, 'someone else’s folder');
  assert.equal(clips.ownClip(`https://elsewhere.test/bucket/audios/${USER}/x.wav`, fresh, USER), null, 'another host');
  assert.equal(clips.ownClip(`https://store.test/bucket/images/${USER}/x.wav`, `https://store.test/bucket/images/${USER}/x.wav`, USER), null, 'not the audio folder');
  assert.equal(clips.ownClip(`http://store.test/bucket/audios/${USER}/x.wav`, `http://store.test/bucket/audios/${USER}/x.wav`, USER), null, 'not https');
  assert.equal(clips.ownClip('not a url', fresh, USER), null);
  assert.equal(clips.seedCopyName('soundbooth-ref-abc.wav'), 'soundbooth-ref-abc-seed.wav');
  assert.equal(clips.seedCopyName('soundbooth-ref-abc.mp3'), 'soundbooth-ref-abc-seed.wav');
  assert.equal(clips.seedCopyName('soundbooth-ref-abc-seed.wav'), 'soundbooth-ref-abc-seed.wav', 'a copy is never copied again under a new name');
});

/* ---------------- the preparer, with every dependency faked ---------------- */

function fakeWorld(over = {}) {
  const STORE = 'https://store.test/bucket/';
  const w = {
    objects: new Map(), registry: new Map(), saves: [], downloads: [], peeks: [], fits: [], logs: [],
    measure: async () => 32.6,
    fit: async (buffer, options) => ({ buffer: Buffer.alloc(4000, 1), seconds: 28.4, at: 28.4, pause: true, options }),
    downloadDelay: 0,
    ...over,
  };
  const keyOf = (url) => new URL(url).pathname.replace('/bucket/', '');
  const identity = (url) => { const u = new URL(url); return u.origin + u.pathname; };
  const stored = (url) => w.objects.get(keyOf(url)) || Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ' + 'x'.repeat(100), 'latin1');
  w.signed = (key, tag = 'fresh') => `${STORE}${key}?X-Amz-Signature=${tag}`;
  w.prepare = clips.createSeedClipPreparer({
    resign: async (url, key) => { const k = key || keyOf(url); return k.split('/').length >= 3 ? w.signed(k) : undefined; },
    seconds: async (user, url) => w.registry.get(user + '|' + identity(url)),
    peek: async (url) => { w.peeks.push(keyOf(url)); const b = stored(url); return { head: b.subarray(0, 64), bytes: b.length }; },
    download: async (url) => {
      w.downloads.push(keyOf(url));
      if (w.downloadDelay) await new Promise((r) => setTimeout(r, w.downloadDelay));
      if (w.downloadFails) throw new Error('403 expired');
      return stored(url);
    },
    measure: (buffer) => w.measure(buffer),
    fit: async (buffer, options) => { w.fits.push(options); return w.fit(buffer, options); },
    save: async (user, buffer, fileName) => { if (w.saveFails) throw new Error('storage down'); const k = `audios/${user}/${fileName}`; w.saves.push(k); w.objects.set(k, buffer); return w.signed(k, 'saved'); },
    register: async (user, url, seconds) => { if (typeof seconds === 'number') w.registry.set(user + '|' + identity(url), seconds); },
    logger: { info: (m) => w.logs.push(['info', m]), warn: (m) => w.logs.push(['warn', m]) },
    deadlineMs: w.deadlineMs,
  });
  w.know = (key, seconds) => w.registry.set(`${USER}|${STORE}${key}`, seconds);
  return w;
}

test('her clip: cut once, stored beside the original, said in one sentence', async () => {
  const w = fakeWorld();
  const original = w.signed(`audios/${USER}/soundbooth-ref-muq.wav`, 'old');
  const out = await w.prepare(USER, [original]);
  assert.deepEqual(out.urls, [w.signed(`audios/${USER}/soundbooth-ref-muq-seed.wav`, 'saved')]);
  assert.deepEqual(out.notes, ['Your clip was 33 seconds. Seed Audio takes up to 30, so the first 28 and a half seconds were used, ending at a pause.']);
  assert.equal(out.fitted, 1);
  assert.deepEqual(w.saves, [`audios/${USER}/soundbooth-ref-muq-seed.wav`]);
  assert.deepEqual(w.fits, [{ format: 'wav', cut: true }]);
  assert.equal(w.registry.get(`${USER}|https://store.test/bucket/audios/${USER}/soundbooth-ref-muq-seed.wav`), 28.4, 'the copy is registered with its length');
  assert.equal(w.registry.get(`${USER}|https://store.test/bucket/audios/${USER}/soundbooth-ref-muq.wav`), 32.6, 'and so is the original');

  /* The next render: no download, no cut, no save; the same copy and the same sentence. */
  const again = await w.prepare(USER, [original]);
  assert.deepEqual(again.urls, [w.signed(`audios/${USER}/soundbooth-ref-muq-seed.wav`)]);
  assert.deepEqual(again.notes, out.notes);
  assert.equal(w.saves.length, 1);
  assert.equal(w.fits.length, 1);
  assert.equal(w.downloads.length, 1);
});

test('a clip that fits goes as it is, signed again; three clips are named by place', async () => {
  const measured = { a: 12, b: 47, c: 20 };
  /* Three WAV headers; the byte after the header says which clip it is, and so how long. */
  const plain = fakeWorld({ measure: async (buffer) => measured[buffer.toString('latin1', 20, 21)] });
  for (const k of ['a', 'b', 'c']) plain.objects.set(`audios/${USER}/${k}.wav`, Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt     ' + k + 'x'.repeat(60), 'latin1'));
  const out = await plain.prepare(USER, ['a', 'b', 'c'].map((k) => plain.signed(`audios/${USER}/${k}.wav`, 'old')));
  assert.deepEqual(out.urls, [plain.signed(`audios/${USER}/a.wav`), plain.signed(`audios/${USER}/b-seed.wav`, 'saved'), plain.signed(`audios/${USER}/c.wav`)]);
  assert.deepEqual(out.notes, ['Clip 2 was 47 seconds. Seed Audio takes up to 30, so the first 28 and a half seconds were used, ending at a pause.']);
  assert.equal(out.fitted, 1);
});

test('a clip that is not hers, or not in our storage, is sent untouched and never fetched', async () => {
  const w = fakeWorld();
  const foreign = 'https://elsewhere.test/a/b/clip.wav?sig=1';
  const theirs = w.signed(`audios/${OTHER}/soundbooth-ref-x.wav`, 'old');
  const fal = 'https://v3b.fal.media/files/b/out.wav';
  const out = await w.prepare(USER, [foreign, theirs, fal]);
  assert.deepEqual(out.urls, [foreign, theirs, fal]);
  assert.deepEqual(out.notes, []);
  assert.equal(w.downloads.length, 0);
});

test('anything going wrong sends the clip as it was (fails open) and says why in the log', async () => {
  const original = (w) => w.signed(`audios/${USER}/soundbooth-ref-z.wav`, 'old');
  const fresh = (w) => w.signed(`audios/${USER}/soundbooth-ref-z.wav`);
  let w = fakeWorld({ downloadFails: true });
  assert.deepEqual((await w.prepare(USER, [original(w)])).urls, [fresh(w)]);
  assert.match(w.logs.at(-1)[1], /could not fetch soundbooth-ref-z\.wav/);
  w = fakeWorld({ fit: async () => { const e = new Error('Command failed: ffmpeg'); e.stderr = 'Invalid data'; throw e; } });
  assert.deepEqual((await w.prepare(USER, [original(w)])).urls, [fresh(w)]);
  assert.match(w.logs.at(-1)[1], /could not fit soundbooth-ref-z\.wav \(long; sending it as it is\).*Invalid data/);
  w = fakeWorld({ saveFails: true });
  assert.deepEqual((await w.prepare(USER, [original(w)])).urls, [fresh(w)]);
  assert.match(w.logs.at(-1)[1], /could not store the copy/);
  w = fakeWorld({ measure: async () => null });
  const unknown = await w.prepare(USER, [original(w)]);
  assert.deepEqual(unknown.urls, [fresh(w)]);
  assert.equal(w.fits.length, 0, 'a clip whose length cannot be read is not cut blind');
  assert.match(w.logs.at(-1)[1], /length unknown/);
  assert.deepEqual(await fakeWorld().prepare(USER, undefined), { urls: [], notes: [], fitted: 0, logs: [] });
});

test('a clip the reference list knows fits is not fetched: an MP3 at all, a WAV only its first bytes', async () => {
  const w = fakeWorld();
  w.know(`audios/${USER}/voice.mp3`, 12);
  w.know(`audios/${USER}/voice.wav`, 29.5);
  const out = await w.prepare(USER, [w.signed(`audios/${USER}/voice.mp3`, 'old'), w.signed(`audios/${USER}/voice.wav`, 'old')]);
  assert.deepEqual(out.urls, [w.signed(`audios/${USER}/voice.mp3`), w.signed(`audios/${USER}/voice.wav`)]);
  assert.deepEqual(out.notes, []);
  assert.deepEqual(w.downloads, [], 'nothing fetched whole');
  assert.deepEqual(w.peeks, [`audios/${USER}/voice.wav`], 'only the WAV is peeked at, for its size');
  assert.equal(w.fits.length, 0);
});

test('known to fit by length, but not by size or format, is still fetched and fitted', async () => {
  /* A 20-second WAV kept as it was imported, 14 MB: too big for fal, so it is converted. */
  const big = fakeWorld({ measure: async () => 20 });
  big.know(`audios/${USER}/hires.wav`, 20);
  big.objects.set(`audios/${USER}/hires.wav`, Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ', 'latin1'), Buffer.alloc(14 * 1000 * 1000)]));
  const b = await big.prepare(USER, [big.signed(`audios/${USER}/hires.wav`, 'old')]);
  assert.deepEqual(big.peeks, [`audios/${USER}/hires.wav`]);
  assert.deepEqual(big.downloads, [`audios/${USER}/hires.wav`]);
  assert.deepEqual(b.urls, [big.signed(`audios/${USER}/hires-seed.wav`, 'saved')]);
  /* An M4A is never sent as it is, whatever its length; it is not even peeked at. */
  const m4a = fakeWorld({ measure: async () => 8 });
  m4a.know(`audios/${USER}/memo.m4a`, 8);
  m4a.objects.set(`audios/${USER}/memo.m4a`, Buffer.concat([Buffer.from('\x00\x00\x00\x20ftypM4A ', 'latin1'), Buffer.alloc(64)]));
  const m = await m4a.prepare(USER, [m4a.signed(`audios/${USER}/memo.m4a`, 'old')]);
  assert.deepEqual(m4a.peeks, []);
  assert.deepEqual(m4a.downloads, [`audios/${USER}/memo.m4a`]);
  assert.deepEqual(m.notes, ['Your clip was in a format Seed Audio cannot read, so a WAV copy was sent.']);
  /* A ".wav" whose first bytes are not a WAV is fetched and looked at properly. */
  const odd = fakeWorld({ measure: async () => 10 });
  odd.know(`audios/${USER}/odd.wav`, 10);
  odd.objects.set(`audios/${USER}/odd.wav`, Buffer.concat([Buffer.from('fLaC\x00\x00\x00\x22', 'latin1'), Buffer.alloc(64)]));
  await odd.prepare(USER, [odd.signed(`audios/${USER}/odd.wav`, 'old')]);
  assert.deepEqual(odd.downloads, [`audios/${USER}/odd.wav`]);
  assert.deepEqual(odd.fits, [{ format: 'flac', cut: false }]);
});

test('checking stops at the deadline: a stalled clip, and any after it, go as they are', async () => {
  const w = fakeWorld({ deadlineMs: 60, downloadDelay: 400 });
  const first = w.signed(`audios/${USER}/slow.wav`, 'old');
  const second = w.signed(`audios/${USER}/next.wav`, 'old');
  const started = Date.now();
  const out = await w.prepare(USER, [first, second]);
  assert.ok(Date.now() - started < 350, `answered in ${Date.now() - started} ms, not after the stalled download`);
  assert.deepEqual(out.urls, [w.signed(`audios/${USER}/slow.wav`), w.signed(`audios/${USER}/next.wav`)], 'signed again, as they are');
  assert.deepEqual(out.notes, []);
  assert.equal(out.fitted, 0);
  assert.deepEqual(w.downloads, [`audios/${USER}/slow.wav`], 'the clip after the deadline is not started');
  assert.ok(w.logs.some(([level, line]) => level === 'warn' && /clip 1 not checked within 60 ms; sending it as it is/.test(line)));
  assert.ok(w.logs.some(([level, line]) => level === 'warn' && /clip 2 not checked/.test(line)));
  /* The stalled check finishes on its own and stores its copy, so the next render can use it. */
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(w.saves, [`audios/${USER}/slow-seed.wav`]);
  assert.equal(clips.SEED_PREP_DEADLINE_MS, 25000);
});

/* ---------------- real ffmpeg: synthetic tones only ---------------- */

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
function ff(args) {
  return new Promise((resolve, reject) => execFile(FFMPEG, args, { timeout: 60000 }, (e, so, se) => (e ? reject(new Error(String(se).slice(-400))) : resolve())));
}
const ffmpegReady = new Promise((resolve) => execFile(FFMPEG, ['-version'], { timeout: 15000 }, (e) => resolve(!e)));
/** A tone of `seconds` as an `ext` file. With `gaps`, 2.6 s of tone then 0.6 s of quiet, like speech with breaths. */
async function tone(seconds, { gaps = false, ext = 'mp3' } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'seed-tone-'));
  const f = path.join(dir, `a.${ext}`);
  const source = gaps
    ? `sine=frequency=330:sample_rate=44100:duration=${seconds},volume='if(lt(mod(t,3.2),2.6),0.8,0)':eval=frame`
    : `sine=frequency=220:sample_rate=44100:duration=${seconds}`;
  const codec = { mp3: ['-c:a', 'libmp3lame', '-b:a', '128k'], m4a: ['-c:a', 'aac', '-b:a', '96k'], wav: ['-c:a', 'pcm_s16le'] }[ext];
  await ff(['-nostdin', '-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', source, '-ac', '2', ...codec, f]);
  const b = await fsp.readFile(f);
  await fsp.rm(dir, { recursive: true, force: true });
  return b;
}

test('real ffmpeg: a 33-second clip with pauses is cut at one; a steady 40-second one at 29.5', async (t) => {
  if (!(await ffmpegReady)) return t.skip('ffmpeg is not installed here; set FFMPEG_PATH and FFPROBE_PATH');
  const { durationOf } = require('./kadeSoundBoothStitch');
  const speechy = await tone(33, { gaps: true });
  const cut = await clips.fitSeedClip(speechy, { format: 'mp3', cut: true });
  assert.equal(cut.pause, true);
  assert.ok(cut.seconds >= 20 && cut.seconds <= 29.4, `cut at ${cut.seconds}`);
  assert.equal(clips.sniffFormat(cut.buffer), 'wav');
  assert.ok(Math.abs((await durationOf(cut.buffer)) - cut.seconds) < 0.05);
  assert.ok(cut.buffer.length < clips.SEED_CLIP_MAX_BYTES / 3, 'a 48 kHz mono WAV of under 30 s is about 2.8 MB');
  const steady = await clips.fitSeedClip(await tone(40, { ext: 'wav' }), { format: 'wav', cut: true });
  assert.equal(steady.pause, false);
  assert.ok(Math.abs(steady.seconds - 29.5) < 0.05, `cut at ${steady.seconds}`);
  const converted = await clips.fitSeedClip(await tone(8, { ext: 'm4a' }), { format: 'm4a', cut: false });
  assert.equal(clips.sniffFormat(converted.buffer), 'wav');
  assert.ok(Math.abs(converted.seconds - 8) < 0.2, `kept whole: ${converted.seconds}`);
});

/* ---------------- the booth's routes, with a stub fal and stub storage ---------------- */

const STORE = 'https://store.test';
const keyOf = (url) => new URL(url).pathname.replace(/^\/bucket\//, '');
const identity = (url) => { const u = new URL(url); return u.origin + u.pathname; };
const signed = (key, tag = 'fresh') => `${STORE}/bucket/${key}?X-Amz-Date=20261002T000000Z&X-Amz-Expires=604800&X-Amz-Signature=${tag}`;

function loadBooth(world) {
  const express = require('express');
  const mongoose = require('mongoose');
  const module = { exports: {} };
  const logger = { info: (m) => world.logs.push(['info', String(m)]), warn: (m) => world.logs.push(['warn', String(m)]), error: (m) => world.logs.push(['error', String(m)]), debug() {} };
  const api = {
    needsRefresh: () => false,
    getNewS3URL: async (url, key) => { const k = key || keyOf(url); return k.split('/').length >= 3 ? signed(k) : undefined; },
    saveBufferToS3: async ({ userId, buffer, fileName, basePath }) => { const k = `${basePath}/${userId}/${fileName}`; world.objects.set(k, buffer); world.saves.push(k); return signed(k, 'saved'); },
    musicReferenceSeconds: async (user, url) => world.registry.get(user + '|' + identity(url)),
    registerMusicReference: async (user, url, seconds) => { if (typeof seconds === 'number') world.registry.set(user + '|' + identity(url), seconds); },
    musicReferenceError: () => undefined,
    musicReferenceSpeedNote: () => '',
    yueConfigured: () => false,
    yueStyles: {},
    yueStylesEnabled: () => false,
    yueCost: 'test price',
    yueCoverSettings: (settings) => settings,
    yueCoverOptions: () => ({}),
    yueSavedOptions: (options) => options,
    musicCoverLengthGuide: (yue) => yue,
    effectsGuide: { name: 'Stable Audio', settings: [], howToWrite: [] },
    effectsConfigured: () => false,
    writingCost: () => ({ costUSD: 0, measured: false }),
    musicWritingSettings: () => ({}),
    notifyMusic: async () => ({ accepted: false }),
  };
  const proxied = new Proxy(api, {
    get(target, key) {
      if (key in target) return target[key];
      if (/^create\w*Router$/.test(String(key))) return () => express.Router();
      return undefined;
    },
  });
  const localRequire = (name) => {
    if (name === 'axios') return world.axios;
    if (name === '@librechat/data-schemas') return { logger };
    if (name === '@librechat/api') return proxied;
    if (name === '~/server/services/kadeJevJudges') return {};
    if (name === '~/server/utils/kadeSongAudience') return { songAudience: async () => 'explicit', hasExplicitWords: () => false, explicitSungLines: () => [] };
    if (name === '~/models') return { getAgent: async () => null };
    if (name === '~/server/middleware') return { requireJwtAuth: (req, _res, next) => { req.user = { id: USER }; next(); } };
    if (name === '~/models/kadeSoundBoothProject') return require('../../models/kadeSoundBoothProject');
    if (name === '~/models/kadeUsage') return { logKadeUsage: async () => {}, KadeUsage: {} };
    if (name === '~/models/kadeAsset') return { logKadeAsset: async (row) => { world.assets.push(row); return { _id: new mongoose.Types.ObjectId() }; }, KadeAsset: {} };
    return require(name);
  };
  const source = fs.readFileSync(path.join(__dirname, 'kadeSoundBooth.js'), 'utf8');
  vm.runInNewContext(source, {
    require: localRequire, module, exports: module.exports, process, console, Buffer,
    URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Intl, Date, Math, JSON,
  });
  return module.exports;
}

const FAL_TOO_LONG = (index) => ({ detail: [{ loc: ['body', 'audio_urls', index], msg: 'Audio duration exceeds the maximum allowed. Maximum is 30.0 seconds.', type: 'audio_duration_too_long', ctx: { max_duration: 30 } }] });

test('the booth: her failed renders replayed, then the same clip of hers going through', async (t) => {
  if (!(await ffmpegReady)) return t.skip('ffmpeg is not installed here; set FFMPEG_PATH and FFPROBE_PATH');
  const express = require('express');
  const mongoose = require('mongoose');
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const { KadeSoundBoothProject: Project } = require('../../models/kadeSoundBoothProject');
  const { durationOf } = require('./kadeSoundBoothStitch');

  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const saved = { FAL_KEY: process.env.FAL_KEY, BRIDGE_SECRET: process.env.BRIDGE_SECRET };
  process.env.FAL_KEY = 'test-only';
  process.env.BRIDGE_SECRET = 'test-only';

  const world = { objects: new Map(), registry: new Map(), saves: [], logs: [], assets: [], gets: [], peeks: [], fal: [], foreign: new Map(), bridgeJob: null };
  /* fal, as it behaved on Oct 2: it fetches every clip and refuses one over 30 seconds. */
  world.falAnswer = async (body) => {
    for (const [i, url] of (body.audio_urls || []).entries()) {
      const seconds = url.startsWith(STORE) ? await durationOf(world.objects.get(keyOf(url))) : world.foreign.get(url);
      if (seconds > 30) {
        const e = new Error('Request failed with status code 422');
        e.response = { status: 422, data: FAL_TOO_LONG(i) };
        throw e;
      }
    }
    return { data: { audio: { url: 'https://v3b.fal.media/files/b/test/out.wav', duration: 3.2 } } };
  };
  world.axios = {
    get: async (url, options = {}) => {
      /* Storage answers a ranged read as B2 does: 206, the bytes asked for, and the whole size. */
      const range = options.headers && options.headers.Range;
      if (range) world.peeks.push(url); else world.gets.push(url);
      if (url.includes('/audio/scenema/status')) return { data: world.bridgeJob };
      if (!url.startsWith(STORE)) { const e = new Error('getaddrinfo ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
      const b = world.objects.get(keyOf(url));
      if (!b) { const e = new Error('Request failed with status code 404'); e.response = { status: 404, data: Buffer.from('<Error><Code>NoSuchKey</Code></Error>') }; throw e; }
      if (range === 'bytes=0-63') return { status: 206, headers: { 'content-range': `bytes 0-63/${b.length}` }, data: b.subarray(0, 64) };
      return { status: 200, headers: {}, data: b };
    },
    post: async (url, body) => { world.fal.push({ url, body }); return world.falAnswer(body); },
  };

  const app = express();
  app.use('/booth', loadBooth(world));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/booth';
  const call = async (route, body) => {
    const res = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const upload = async (engine, buffer, name, type) => {
    const form = new FormData();
    form.append('engine', engine);
    form.append('clip', new Blob([buffer], { type }), name);
    const res = await fetch(base + '/reference', { method: 'POST', body: form });
    return { status: res.status, data: await res.json() };
  };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await mongoose.disconnect();
    await mongo.stop();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const script = 'A short line in a quiet room.\nNarrator (warm, unhurried): @Audio1 says hello.';
  const herClipKey = `audios/${USER}/soundbooth-ref-muq.mp3`;
  world.objects.set(herClipKey, await tone(33, { gaps: true }));
  world.registry.set(USER + '|' + identity(signed(herClipKey)), 32.6);

  await t.test('a long clip the booth cannot open: fal’s 422 is said in words and logged, not "[object Object]"', async () => {
    const foreign = 'https://elsewhere.test/clips/a/b/voice.wav?sig=1';
    world.foreign.set(foreign, 32.6);
    const r = await call('/render', { engine: 'seed', script, audio_urls: [foreign], referenceExpected: true });
    assert.equal(r.status, 502);
    assert.equal(r.data.error, 'Seed Audio could not make that: Clip 1 is too long. Seed Audio takes clips up to 30 seconds.');
    const p = await Project.findById(r.data.projectId);
    assert.equal(p.state, 'failed');
    assert.equal(p.lastError, r.data.error);
    const warn = world.logs.find(([level, line]) => level === 'warn' && /seed failed status=422/.test(line));
    assert.ok(warn, 'a failed Seed render is logged');
    assert.match(warn[1], /audio_duration_too_long/);
    assert.equal(world.saves.length, 0);
    assert.ok(!world.gets.some((u) => u.startsWith('https://elsewhere.test')), 'an address that is not ours is never fetched by the server');
  });

  let copyUrl;
  await t.test('her own 33-second clip is cut once at a pause, and the render goes through and says so', async () => {
    const r = await call('/render', { engine: 'seed', script, audio_urls: [signed(herClipKey, 'old')], referenceExpected: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.match(r.data.note, /^Your clip was 33 seconds\. Seed Audio takes up to 30, so the first \d+( and a half)? seconds were used, ending at a pause\.$/);
    const sent = world.fal.at(-1).body.audio_urls;
    assert.equal(sent.length, 1);
    assert.equal(keyOf(sent[0]), `audios/${USER}/soundbooth-ref-muq-seed.wav`);
    copyUrl = sent[0];
    const copySeconds = await durationOf(world.objects.get(keyOf(sent[0])));
    assert.ok(copySeconds >= 20 && copySeconds <= 29.5, `the copy is ${copySeconds}s`);
    assert.deepEqual(world.saves, [`audios/${USER}/soundbooth-ref-muq-seed.wav`]);
    const p = await Project.findById(r.data.projectId);
    assert.equal(p.state, 'done');
    assert.equal(keyOf(p.options.audio_urls[0]), herClipKey, 'the project keeps her own whole clip, so AuK edit still gets all of it');
    assert.equal(p.options.audio_urls.length, 1);
    assert.deepEqual(p.options.seed_sent_urls.map(keyOf), [`audios/${USER}/soundbooth-ref-muq-seed.wav`], 'and records the copy Seed heard');
    assert.ok(world.logs.some(([level, line]) => level === 'info' && /seed clips fitted/.test(line) && /cut at a pause/.test(line)));
  });

  await t.test('the next render reuses the copy: nothing fetched, cut or stored again', async () => {
    const savesBefore = world.saves.length;
    const fetchesBefore = world.gets.filter((u) => keyOf(u) === herClipKey).length;
    const r = await call('/render', { engine: 'seed', script, audio_urls: [signed(herClipKey, 'old')] });
    assert.equal(r.status, 200);
    assert.equal(keyOf(world.fal.at(-1).body.audio_urls[0]), keyOf(copyUrl));
    assert.match(r.data.note, /^Your clip was 33 seconds\./);
    assert.equal(world.saves.length, savesBefore);
    assert.equal(world.gets.filter((u) => keyOf(u) === herClipKey).length, fetchesBefore);
  });

  await t.test('a clip that already fits is sent as it is, signed again, with nothing to say', async () => {
    const key = `audios/${USER}/soundbooth-ref-short.wav`;
    world.objects.set(key, await tone(10, { ext: 'wav' }));
    const before = world.saves.length;
    const r = await call('/render', { engine: 'seed', script, audio_urls: [signed(key, 'old')] });
    assert.equal(r.status, 200);
    assert.equal(world.fal.at(-1).body.audio_urls[0], signed(key));
    assert.equal(r.data.note, null);
    assert.equal(world.saves.length, before);
  });

  await t.test('an M4A clip is sent as a WAV copy, and said so', async () => {
    const key = `audios/${USER}/soundbooth-ref-memo.m4a`;
    world.objects.set(key, await tone(8, { ext: 'm4a' }));
    const r = await call('/render', { engine: 'seed', script, audio_urls: [signed(key, 'old')] });
    assert.equal(r.status, 200);
    assert.equal(keyOf(world.fal.at(-1).body.audio_urls[0]), `audios/${USER}/soundbooth-ref-memo-seed.wav`);
    assert.equal(r.data.note, 'Your clip was in a format Seed Audio cannot read, so a WAV copy was sent.');
  });

  await t.test('a timeout and an empty answer are said plainly and logged', async () => {
    const keep = world.falAnswer;
    world.falAnswer = async () => { const e = new Error('timeout of 180000ms exceeded'); e.code = 'ECONNABORTED'; throw e; };
    let r = await call('/render', { engine: 'seed', script });
    assert.equal(r.status, 502);
    assert.equal(r.data.error, 'Seed Audio could not make that: Seed Audio did not answer in time.');
    assert.ok(world.logs.some(([level, line]) => level === 'warn' && /seed failed status=- .*code=ECONNABORTED/.test(line)));
    world.falAnswer = async () => ({ data: { detail: 'odd' } });
    r = await call('/render', { engine: 'seed', script });
    assert.equal(r.status, 502);
    assert.equal(r.data.error, 'Seed Audio returned no clip. Try rewording it.');
    assert.ok(world.logs.some(([level, line]) => level === 'warn' && /seed returned no clip.*odd/.test(line)));
    world.falAnswer = keep;
  });

  await t.test('a Seed import over 30 seconds is cut on the way in, so Play plays what Seed will hear', async () => {
    const r = await upload('seed', await tone(33, { gaps: true }), 'voice.mp3', 'audio/mpeg');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.seconds >= 20 && r.data.seconds <= 29.5, `imported at ${r.data.seconds}s`);
    assert.match(r.data.spoken, /Seed Audio takes clips up to 30 seconds\. Yours was 33, so the first \d+( and a half)? seconds were kept, ending at a pause\./);
    assert.doesNotMatch(r.data.spoken, /first twenty are what count/);
    const stored = world.objects.get(keyOf(r.data.url));
    assert.equal(clips.sniffFormat(stored), 'wav');
    assert.ok((await durationOf(stored)) <= 29.5);
    assert.equal(world.registry.get(USER + '|' + identity(r.data.url)), r.data.seconds, 'registered at the length that was kept');
    /* And it goes straight through a render: nothing more to cut, and it is not fetched whole,
     * because the reference list knows its length; only its first bytes are read, for its size. */
    const before = world.saves.length;
    const rendered = await call('/render', { engine: 'seed', script, audio_urls: [r.data.url] });
    assert.equal(rendered.status, 200);
    assert.equal(rendered.data.note, null);
    assert.equal(world.saves.length, before);
    assert.equal(keyOf(world.fal.at(-1).body.audio_urls[0]), keyOf(r.data.url));
    assert.equal(world.gets.filter((u) => keyOf(u) === keyOf(r.data.url)).length, 0, 'not downloaded');
    assert.equal(world.peeks.filter((u) => keyOf(u) === keyOf(r.data.url)).length, 1, 'peeked at once');
    const p = await Project.findById(rendered.data.projectId);
    assert.equal(p.options.seed_sent_urls, undefined, 'nothing was swapped, so nothing extra is recorded');
  });

  await t.test('an AuK import keeps the whole original, as before', async () => {
    const original = await tone(33, { gaps: true });
    const r = await upload('scenema', original, 'voice.mp3', 'audio/mpeg');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(world.objects.get(keyOf(r.data.url)).equals(original));
    assert.doesNotMatch(r.data.spoken, /Seed Audio/);
  });

  await t.test('a bridge job that failed with an object says its words', async () => {
    const p = await Project.create({ user: USER, engine: 'scenema', title: 'Bridge', script: '<speak>Hi.</speak>', state: 'running', jobs: ['job-obj'] });
    world.bridgeJob = { state: 'failed', error: { message: 'No graphics card was free.' } };
    const r = await call('/status/job-obj');
    assert.equal(r.status, 200);
    assert.equal(r.data.error, 'No graphics card was free.');
    assert.equal(r.data.spoken, 'That render did not finish. No graphics card was free.');
    assert.equal((await Project.findById(p._id)).lastError, 'No graphics card was free.');
    assert.ok(world.logs.some(([level, line]) => level === 'warn' && /status\] job=job-obj failed/.test(line)));
  });
});
