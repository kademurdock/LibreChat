import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync(new URL('../ConversationMode.tsx', import.meta.url), 'utf8');
const begin = source.indexOf('  const enqueueAudio =');
const end = source.indexOf('\n  }, []);', begin) + 12;
const body = stripTypeScriptTypes(source.slice(begin, end) + '\nglobalThis.enqueue = enqueueAudio;');

for (const interrupt of [false, true]) test(`classic audio queue, interrupt during decode = ${interrupt}`, async () => {
  let resolveDecode, starts = 0, observations = 0;
  const sandbox = {
    useCallback: f => f, turnIdRef: { current: 1 }, abortRef: { current: false },
    playQueueRef: { current: Promise.resolve() }, outputAnalyserRef: { current: null },
    currentSourceRef: { current: null }, presentationRef: { current: {} }, console,
    observePlayback: () => observations++,
    audioCtxRef: { current: {
      currentTime: 7, destination: {},
      decodeAudioData: () => new Promise(resolve => { resolveDecode = resolve; }),
      createBufferSource() { return {
        connect() {},
        start(time) { assert.equal(time, 7); starts++; queueMicrotask(() => this.onended()); },
      }; },
    } },
  };
  vm.runInNewContext(body, sandbox);
  const done = sandbox.enqueue(Promise.resolve(new ArrayBuffer(4)));
  await new Promise(resolve => setImmediate(resolve));
  if (interrupt) sandbox.turnIdRef.current++;
  resolveDecode({ duration: 1 });
  await done;
  assert.equal(starts, interrupt ? 0 : 1);
  assert.equal(observations, interrupt ? 0 : 1);
});
