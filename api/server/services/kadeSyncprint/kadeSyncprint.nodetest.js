/* Nov 14 2026 (Tellavision "Follow along", step 0): the vendored syncprint.js is the exact file its
 * checksum names, and a fingerprint is made on a worker thread with a time limit.
 * Run: node --test api/server/services/kadeSyncprint/kadeSyncprint.nodetest.js (no network, no database). */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fingerprintFile } = require('./index');
const SyncPrint = require('./syncprint');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kade-syncprint-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** A made-up film: a new chord every quarter second, at frequencies a fingerprint can tell apart. */
function film(seconds, seed = 1) {
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const rate = 8000;
  const samples = new Int16Array(Math.round(seconds * rate));
  let tones = [];
  for (let i = 0; i < samples.length; i++) {
    if (i % 2000 === 0) tones = [0, 1, 2].map(() => 350 + next() * 3000);
    let v = (next() - 0.5) * 0.05;
    for (const f of tones) v += 0.25 * Math.sin((2 * Math.PI * f * i) / rate);
    samples[i] = Math.round(v * 12000);
  }
  return samples;
}
const write = (name, samples) => {
  const file = path.join(root, name);
  fs.writeFileSync(file, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  return file;
};

test('the vendored syncprint.js matches its checksum file', () => {
  const listed = fs.readFileSync(path.join(__dirname, 'syncprint.js.sha256'), 'utf8');
  const found = /^([0-9a-f]{64}) {2}syncprint\.js\n?$/.exec(listed);
  assert.ok(found, 'the checksum file is "<sha256>  syncprint.js"');
  const actual = createHash('sha256')
    .update(fs.readFileSync(path.join(__dirname, 'syncprint.js')))
    .digest('hex');
  assert.equal(
    actual,
    found[1],
    'syncprint.js changed without its checksum: copy the library again with its checksum',
  );
  assert.equal(SyncPrint.FORMAT_VERSION, 1);
  assert.equal(SyncPrint.PARAMS.sampleRate, 8000, 'the describer writes 8 kHz sound for it');
  assert.equal(SyncPrint.error, null);
});

test('a fingerprint made on the worker thread finds a 6 s clip of the same sound, with hiss too', async () => {
  const samples = film(45);
  const made = await fingerprintFile(write('film.s16', samples));
  assert.ok(made.bytes instanceof Uint8Array);
  assert.equal(Buffer.from(made.bytes.subarray(0, 4)).toString('latin1'), 'SYPR');
  assert.ok(Math.abs(made.seconds - 45) < 0.001);
  assert.equal(made.format, 1);
  assert.ok(made.peaks > 0);
  const matcher = SyncPrint.createMatcher(SyncPrint.decode(made.bytes));
  assert.ok(matcher, 'the bytes decode into a matcher');
  for (const at of [4, 21.5, 37]) {
    const clip = samples.slice(at * 8000, (at + 6) * 8000);
    const found = matcher.match(clip);
    assert.equal(found.found, true, `clip at ${at} s`);
    assert.ok(Math.abs(found.filmSec - at) < 0.1, `found at ${found.filmSec} for ${at}`);
    let s = 7;
    const hiss = Int16Array.from(clip, (v) => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return Math.max(-32768, Math.min(32767, v + Math.round((s / 2 ** 32 - 0.5) * 6000)));
    });
    const noisy = matcher.match(hiss);
    assert.equal(noisy.found, true, `noisy clip at ${at} s`);
    assert.ok(Math.abs(noisy.filmSec - at) < 0.1);
  }
});

test('the main thread keeps answering while a long film is fingerprinted', async () => {
  const file = write('long.s16', film(600, 3));
  let ticks = 0;
  const beat = setInterval(() => (ticks += 1), 20);
  const started = Date.now();
  const made = await fingerprintFile(file);
  clearInterval(beat);
  const ms = Date.now() - started;
  assert.ok(Math.abs(made.seconds - 600) < 0.001);
  assert.ok(ticks >= Math.floor(ms / 20) * 0.5, `ticked ${ticks} times in ${ms} ms`);
});

test('a time limit, a stop, a missing file and too little sound each end it plainly', async () => {
  const file = write('limit.s16', film(600, 5));
  await assert.rejects(
    fingerprintFile(file, { timeoutMs: 5 }),
    (e) => e.code === 'KADE_SYNC_TIMEOUT',
  );
  const stop = new AbortController();
  const stopped = fingerprintFile(file, { signal: stop.signal });
  stop.abort();
  await assert.rejects(stopped, (e) => e.code === 'KADE_SYNC_STOPPED');
  await assert.rejects(
    fingerprintFile(file, { signal: stop.signal }),
    (e) => e.code === 'KADE_SYNC_STOPPED',
  );
  await assert.rejects(
    fingerprintFile(path.join(root, 'nothing.s16')),
    (e) => e.code === 'KADE_SYNC_FAILED' && /gone/.test(e.message),
  );
  await assert.rejects(
    fingerprintFile(write('short.s16', film(1))),
    (e) => e.code === 'KADE_SYNC_FAILED' && /too short/.test(e.message),
  );
});
