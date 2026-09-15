'use strict';
/* Part 122. Real ffmpeg, real MP3s, real durations — a stitch test that mocks
 * the joining has tested nothing. Generates tones, joins them, and checks the
 * result is as long as its parts added up and still plays.
 * Run: node --test kadeSoundBoothStitch.selftest.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { stitchMp3Buffers, durationOf, sayStitched, concatLine } = require('./kadeSoundBoothStitch');

function ff(args) {
  return new Promise((res, rej) =>
    execFile(process.env.FFMPEG_PATH || 'ffmpeg', args, { timeout: 60000 }, (e, so, se) => (e ? rej(new Error(String(se).slice(-400))) : res())),
  );
}
/** A real MP3 of a sine tone, n seconds long. */
async function tone(seconds, freq = 440, rate = 44100, format = 'mp3') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tone-'));
  const f = path.join(dir, `a.${format}`);
  await ff(['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    `sine=frequency=${freq}:duration=${seconds}:sample_rate=${rate}`, ...(format === 'wav' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'libmp3lame', '-b:a', '192k']), f]);
  const b = await fs.readFile(f);
  await fs.rm(dir, { recursive: true, force: true });
  return b;
}

test('two parts join into one file as long as both', async () => {
  const a = await tone(2, 440);
  const b = await tone(3, 660);
  const { buffer, reencoded } = await stitchMp3Buffers([a, b]);
  assert.ok(buffer.length > 0);
  const d = await durationOf(buffer);
  assert.ok(d >= 4.5 && d <= 5.6, `joined length was ${d}s, expected about 5`);
  assert.equal(reencoded, false, 'same-format parts should copy, not re-encode');
});

test('five parts keep their ORDER and their total length', async () => {
  const parts = [];
  for (let i = 0; i < 5; i++) parts.push(await tone(1, 300 + i * 100));
  const { buffer } = await stitchMp3Buffers(parts);
  const d = await durationOf(buffer);
  assert.ok(d >= 4.5 && d <= 5.8, `five one-second parts came to ${d}s`);
});

test('parts that disagree on sample rate still join, and SAY they were re-encoded', async () => {
  const a = await tone(2, 440, 44100);
  const b = await tone(2, 440, 24000);
  const { buffer, reencoded, notes } = await stitchMp3Buffers([a, b]);
  const d = await durationOf(buffer);
  assert.ok(d >= 3.4 && d <= 4.6, `mixed-rate join came to ${d}s`);
  if (reencoded) assert.match(notes.join(' '), /re-encoded/);
  assert.ok(buffer.length > 0);
});

test('one part comes back untouched — no pointless re-encode', async () => {
  const a = await tone(2);
  const { buffer, reencoded } = await stitchMp3Buffers([a]);
  assert.equal(reencoded, false);
  assert.ok(buffer.equals(a), 'a single part should be byte-identical');
});

test('empty input is an error, not a silent empty file', async () => {
  await assert.rejects(() => stitchMp3Buffers([]), /nothing to stitch/);
  await assert.rejects(() => stitchMp3Buffers([null, undefined]), /nothing to stitch/);
});

test('AuK WAV masters join without changing any PCM samples', async () => {
  const a = await tone(1, 440, 24000, 'wav');
  const b = await tone(2, 660, 24000, 'wav');
  const pcm = (wav) => {
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    for (let at = 12; at + 8 <= wav.length;) {
      const size = wav.readUInt32LE(at + 4);
      if (wav.toString('ascii', at, at + 4) === 'data') return wav.subarray(at + 8, at + 8 + size);
      at += 8 + size + (size % 2);
    }
    throw new Error('Missing PCM data');
  };
  const { buffer, reencoded } = await stitchMp3Buffers([a, b], 'wav');
  assert.equal(reencoded, false);
  assert.deepEqual(pcm(buffer), Buffer.concat([pcm(a), pcm(b)]));
});

test('a quote in a filename cannot break out of the concat list', () => {
  assert.equal(concatLine("/tmp/it's.mp3"), "file '/tmp/it'\\''s.mp3'");
  assert.doesNotMatch(concatLine("/tmp/a'; rm -rf /; '.mp3"), /^file '[^']*'$/);
});

test('the spoken line names the part count and the length', () => {
  assert.match(sayStitched(4, 185, []), /4 parts joined into one recording, 3 minutes 5 seconds/);
  assert.match(sayStitched(2, 42, ['the parts had to be re-encoded to join cleanly']), /Note: the parts had to be re-encoded/);
  assert.doesNotMatch(sayStitched(2, 42, []), /Note:/);
});
