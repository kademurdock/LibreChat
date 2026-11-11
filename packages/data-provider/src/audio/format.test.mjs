import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { speechAudioFormat, sniffSpeechAudioFormat } from './format.ts';

const wav = readFileSync(new URL('./fixtures/sunfish.wav', import.meta.url));
const mp3 = readFileSync(new URL('../../../../client/public/assets/silence.mp3', import.meta.url));

test('real Sunfish WAV overrides its incorrect live audio/mpeg label', () => {
  assert.equal(
    createHash('sha256').update(wav).digest('hex'),
    'fa5c3336622614e238c6a9a9f9ee7ba57b0d20ea055baf6c50fcb10013fba366',
  );
  assert.deepEqual(speechAudioFormat(wav, 'audio/mpeg'), {
    mimeType: 'audio/wav',
    extension: 'wav',
  });
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24000);
});

test('existing real MP3 stays MP3 even with a WAV label', () => {
  assert.deepEqual(speechAudioFormat(mp3, 'audio/wav'), {
    mimeType: 'audio/mpeg',
    extension: 'mp3',
  });
});

test('MPEG frame headers without ID3 are supported; ADTS and invalid frames are rejected', () => {
  for (const header of [
    [0xff, 0xfb, 0x90],
    [0xff, 0xf3, 0x80],
    [0xff, 0xe2, 0x40],
  ]) {
    assert.equal(sniffSpeechAudioFormat(Uint8Array.from(header))?.extension, 'mp3');
  }
  for (const header of [
    [0xff, 0xf1, 0x50],
    [0xff, 0xff, 0xff],
    [0xff, 0xfb, 0x0c],
  ]) {
    assert.equal(sniffSpeechAudioFormat(Uint8Array.from(header)), null);
  }
});

test('short or misleading RIFF prefixes cannot be classified as WAV', () => {
  assert.equal(sniffSpeechAudioFormat(wav.subarray(0, 11)), null);
  assert.equal(sniffSpeechAudioFormat(Buffer.from('RIFF1234AVI ')), null);
});

test('header fallback is normalized and rejects non-audio or injected types', () => {
  assert.equal(speechAudioFormat(new Uint8Array(), 'Audio/X-WAV; charset=binary').extension, 'wav');
  for (const type of [null, 'text/html', 'audio/mpeg\r\nSet-Cookie: secret', 'audio/unknown']) {
    assert.deepEqual(speechAudioFormat(new Uint8Array(), type), {
      mimeType: 'application/octet-stream',
      extension: 'bin',
    });
  }
});

// Nov 11 2026: the voice proxy can put a `kdtm` chunk (the face timing track) between fmt and data.
test('a WAV carrying a kdtm timing chunk still sniffs as WAV', () => {
  const json = Buffer.from(
    '{"v":1,"src":"inworld","set":"oxr","dur":1,"vis":[[0,1,"sil"]],"cov":[[0,1]]}',
  );
  const pad = json.length % 2;
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(4 + 24 + 8 + json.length + pad + 8 + 48, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(24000, 24);
  head.writeUInt32LE(48000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('kdtm', 36, 'ascii');
  head.writeUInt32LE(json.length, 40);
  const data = Buffer.alloc(8);
  data.write('data', 0, 'ascii');
  data.writeUInt32LE(48, 4);
  const withTrack = Buffer.concat([head, json, Buffer.alloc(pad), data, Buffer.alloc(48)]);
  assert.deepEqual(speechAudioFormat(withTrack, 'audio/mpeg'), {
    mimeType: 'audio/wav',
    extension: 'wav',
  });
  assert.deepEqual(sniffSpeechAudioFormat(withTrack.subarray(0, 12)), {
    mimeType: 'audio/wav',
    extension: 'wav',
  });
});
