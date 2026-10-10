import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { consumeSpeechAudio, speechAudioFile, speechAudioBlob } from './speech.ts';
import { MediaSourceAppender } from './MediaSourceAppender.ts';

const wav = readFileSync(
  new URL('../../../../packages/data-provider/src/audio/fixtures/sunfish.wav', import.meta.url),
);
const mp3 = readFileSync(new URL('../../../public/assets/silence.mp3', import.meta.url));
const array = (bytes) => Uint8Array.from(bytes).buffer;
function response(bytes, splits = [1, 2, 5, 12], type = 'audio/mpeg') {
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        const end = splits.shift() ?? bytes.length;
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
        if (offset === bytes.length) controller.close();
      },
    }),
    { headers: { 'Content-Type': type } },
  );
}

test('manual and cached Sunfish clips produce a WAV Blob and download extension', async () => {
  const file = speechAudioFile(array(wav));
  assert.equal(file.blob.type, 'audio/wav');
  assert.equal(file.extension, 'wav');
  assert.deepEqual(Buffer.from(await file.blob.arrayBuffer()), wav);
  const cached = await speechAudioBlob(new Blob([array(wav)], { type: 'audio/mpeg' }));
  assert.equal(cached.type, 'audio/wav');
  assert.deepEqual(Buffer.from(await cached.arrayBuffer()), wav);
});

test('MP3 clips retain correct preview/share/download format', async () => {
  const file = speechAudioFile(array(mp3), 'audio/wav');
  assert.equal(file.extension, 'mp3');
  assert.equal(file.blob.type, 'audio/mpeg');
  assert.equal(
    (await speechAudioBlob(new Blob([array(mp3)], { type: 'audio/wav' }))).type,
    'audio/mpeg',
  );
});

for (const cache of [true, false]) {
  test(`torn Sunfish WAV header bypasses MP3 MediaSource with cache ${cache}`, async () => {
    let opened = 0;
    const blob = await consumeSpeechAudio(response(wav), {
      cache,
      openStream() {
        opened++;
        throw Error('WAV must not open MediaSource');
      },
    });
    assert.equal(opened, 0);
    assert.equal(blob.type, 'audio/wav');
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), wav);
  });
}

test('verified MP3 streams in original order, closes once, and retains bytes only when caching', async () => {
  for (const cache of [true, false]) {
    const chunks = [];
    let closes = 0;
    const blob = await consumeSpeechAudio(response(mp3), {
      cache,
      openStream(type) {
        assert.equal(type, 'audio/mpeg');
        return {
          append(part) {
            chunks.push(Buffer.from(part));
          },
          close() {
            closes++;
          },
          cancel() {
            throw Error('unexpected cancel');
          },
        };
      },
    });
    assert.equal(closes, 1);
    assert.deepEqual(Buffer.concat(chunks), mp3);
    if (cache) assert.deepEqual(Buffer.from(await blob.arrayBuffer()), mp3);
    else assert.equal(blob, null);
  }
});

test('Safari without MPEG MediaSource receives the complete MP3 Blob even with caching disabled', async () => {
  const blob = await consumeSpeechAudio(response(mp3), { cache: false, openStream: () => null });
  assert.equal(blob.type, 'audio/mpeg');
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), mp3);
});

test('MIME labels alone never admit unknown bytes into MPEG MediaSource', async () => {
  let opened = false;
  await consumeSpeechAudio(response(Buffer.from('unknown audio content')), {
    cache: false,
    openStream() {
      opened = true;
      return null;
    },
  });
  assert.equal(opened, false);
});

test('stalled response cancels its reader and any opened stream', async () => {
  let cancelled = 0,
    streamCancelled = 0;
  const stalled = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(mp3.subarray(0, 16));
      },
      cancel() {
        cancelled++;
      },
    }),
  );
  await assert.rejects(
    consumeSpeechAudio(stalled, {
      cache: false,
      timeoutMs: 5,
      openStream: () => ({
        append() {},
        close() {},
        cancel() {
          streamCancelled++;
        },
      }),
    }),
    /timed out/,
  );
  assert.equal(cancelled, 1);
  assert.equal(streamCancelled, 1);
});

test('aborting an incomplete real Sunfish WAV cannot return a late autoplay Blob', async () => {
  const controller = new AbortController();
  let cancelled = 0;
  const incomplete = new Response(
    new ReadableStream({
      start(target) {
        target.enqueue(wav.subarray(0, wav.length / 2));
      },
      cancel() {
        cancelled++;
      },
    }),
    { headers: { 'Content-Type': 'audio/mpeg' } },
  );
  const buffered = consumeSpeechAudio(incomplete, {
    cache: false,
    signal: controller.signal,
    openStream() {
      throw Error('WAV must not enter MediaSource');
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(buffered, { name: 'AbortError' });
  assert.equal(cancelled, 1);
});

test('MediaSource waits for queued MP3 data before ending the stream', () => {
  const previous = globalThis.MediaSource;
  class Source extends EventTarget {
    updating = false;
    chunks = [];
    appendBuffer(part) {
      this.updating = true;
      this.chunks.push(part);
    }
    flush() {
      this.updating = false;
      this.dispatchEvent(new Event('updateend'));
    }
  }
  class Media extends EventTarget {
    static last;
    readyState = 'closed';
    source = new Source();
    ended = 0;
    constructor() {
      super();
      Media.last = this;
    }
    addSourceBuffer(type) {
      assert.equal(type, 'audio/mpeg');
      return this.source;
    }
    endOfStream() {
      this.readyState = 'ended';
      this.ended++;
    }
    open() {
      this.readyState = 'open';
      this.dispatchEvent(new Event('sourceopen'));
    }
  }
  const oldURL = URL.createObjectURL,
    oldRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => {};
  globalThis.MediaSource = Media;
  try {
    const appender = new MediaSourceAppender('audio/mpeg');
    appender.addData(array(mp3.subarray(0, 16)));
    appender.addData(array(mp3.subarray(16)));
    appender.close();
    const media = Media.last;
    assert.equal(media.ended, 0);
    media.open();
    assert.equal(media.source.chunks.length, 1);
    media.source.flush();
    assert.equal(media.source.chunks.length, 2);
    assert.equal(media.ended, 0);
    media.source.flush();
    assert.equal(media.ended, 1);
    assert.deepEqual(Buffer.concat(media.source.chunks.map((part) => Buffer.from(part))), mp3);
  } finally {
    globalThis.MediaSource = previous;
    URL.createObjectURL = oldURL;
    URL.revokeObjectURL = oldRevoke;
  }
});
