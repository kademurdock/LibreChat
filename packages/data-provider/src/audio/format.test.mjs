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
