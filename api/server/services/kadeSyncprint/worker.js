'use strict';
/* Tellavision "Follow along" (Nov 14 2026): the worker thread that makes a film's fingerprint.
 * It reads the raw sound file (8 kHz mono signed 16-bit little-endian, the describer's sound pass
 * writes it), runs syncprint's fingerprint and encode, and hands back the bytes of the .sypr file.
 * Started only by index.js, never on the main thread, so a long film never stalls a chat. */
const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');

const say = (message, transfer) => {
  try {
    parentPort.postMessage(message, transfer);
  } catch {
    /* the thread is being stopped */
  }
};

function run() {
  if (!workerData || !workerData.kadeSyncprint) return;
  let raw;
  try {
    raw = fs.readFileSync(workerData.file);
  } catch (e) {
    say({ ok: false, error: e && e.code === 'ENOENT' ? 'the sound file was gone' : 'the sound file could not be read' });
    return;
  }
  /* Two bytes a sample. A view needs an even offset; a copy is made only when it is not. */
  const length = raw.length >> 1;
  let samples;
  if (raw.byteOffset % 2 === 0) samples = new Int16Array(raw.buffer, raw.byteOffset, length);
  else {
    const even = new Uint8Array(length * 2);
    even.set(raw.subarray(0, length * 2));
    samples = new Int16Array(even.buffer);
  }
  if (length < 8000 * 2) {
    say({ ok: false, error: `the sound is too short to fingerprint (${(length / 8000).toFixed(2)} s)` });
    return;
  }
  const SyncPrint = require('./syncprint');
  if (SyncPrint.error) {
    say({ ok: false, error: `syncprint settings: ${SyncPrint.error}` });
    return;
  }
  const print = SyncPrint.fingerprint(samples);
  if (!print) {
    say({ ok: false, error: 'syncprint made no fingerprint' });
    return;
  }
  const bytes = SyncPrint.encode(print);
  if (!bytes) {
    say({ ok: false, error: 'syncprint could not encode the fingerprint' });
    return;
  }
  say(
    {
      ok: true,
      bytes,
      seconds: print.durationSec,
      peaks: print.count,
      frames: print.frames,
      format: SyncPrint.FORMAT_VERSION,
      version: SyncPrint.VERSION,
    },
    [bytes.buffer],
  );
}

try {
  run();
} catch (e) {
  say({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
}
