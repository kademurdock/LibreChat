const test = require('node:test');
const assert = require('node:assert/strict');
const factory = { exports: {} };
require('node:vm').runInNewContext(
  require('node:fs').readFileSync(require('node:path').join(__dirname, 'audio.js'), 'utf8'),
  { module: factory, Date, Map, Set, Promise, Error },
);
const createAudio = factory.exports;
const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture(fetch) {
  const starts = [];
  let context;
  class AudioContext {
    constructor() {
      context = this;
      this.state = 'suspended';
      this.sampleRate = 48000;
    }
    async resume() {
      this.state = 'running';
      this.onstatechange();
    }
    createBuffer() {
      return 'silent';
    }
    async decodeAudioData(value) {
      return value;
    }
    createBufferSource() {
      const node = {
        connect() {},
        disconnect() {},
        start() {
          starts.push(node);
        },
        stop() {
          node.stopped = true;
        },
      };
      return node;
    }
    createGain() {
      return { gain: { value: 0 }, connect() {}, disconnect() {} };
    }
  }
  return {
    audio: createAudio({ AudioContext, fetch, AbortController, setTimeout, clearTimeout }),
    starts,
    get context() {
      return context;
    },
  };
}
const response = { ok: true, arrayBuffer: async () => 'sound' };
test('one gesture enables later asynchronously loaded effects on the shared context', async () => {
  const f = fixture(async () => response);
  f.audio.unlock();
  assert.equal(await f.audio.play('/step', 0.5), true);
  assert.equal(f.starts.filter((s) => s.buffer === 'sound').length, 1);
});
test('network failure can retry the same URL instead of caching a rejected promise', async () => {
  let calls = 0;
  const f = fixture(async () => {
    if (++calls === 1) throw new Error('offline');
    return response;
  });
  f.audio.unlock();
  assert.equal(await f.audio.play('/step', 0.5), false);
  assert.equal(await f.audio.play('/step', 0.5), true);
  assert.equal(calls, 2);
});
test('late loop download cannot start after leaving the room', async () => {
  let deliver;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
  );
  f.audio.unlock();
  const loop = f.audio.loop('/river', 0.2);
  loop.pause();
  deliver(response);
  await flush();
  assert.equal(f.starts.filter((s) => s.loop).length, 0);
});
test('a loop decoded while interrupted starts when the audio context resumes', async () => {
  const f = fixture(async () => response);
  f.audio.unlock();
  f.context.state = 'interrupted';
  f.audio.loop('/river', 0.2);
  await flush();
  assert.equal(f.starts.filter((s) => s.loop).length, 0);
  f.audio.unlock();
  await flush();
  assert.equal(f.starts.filter((s) => s.loop).length, 1);
});
test('overlapping requests share one download and obey the current sound switch', async () => {
  let calls = 0,
    deliver,
    allowed = true;
  const f = fixture(() => {
    calls++;
    return new Promise((resolve) => {
      deliver = resolve;
    });
  });
  f.audio.unlock();
  const a = f.audio.play('/step', 0.5, () => allowed);
  const b = f.audio.play('/step', 0.5, () => allowed);
  allowed = false;
  deliver(response);
  assert.deepEqual(await Promise.all([a, b]), [false, false]);
  assert.equal(calls, 1);
});
