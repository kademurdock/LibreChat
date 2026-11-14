'use strict';
/* Tellavision "Follow along" (Nov 14 2026, design step 0): one function that makes a film's
 * fingerprint on a worker thread, with a time limit, so the describer's main thread (and every
 * chat on it) never waits for it. syncprint.js beside this file is an exact copy of the library
 * the phone apps also ship; syncprint.js.sha256 holds its checksum, and a test fails when the
 * two disagree.
 *
 * KADE_DESCRIPTION_SYNC_TIMEOUT_MS (default 600000, floor 1000): how long one fingerprint may take.
 * KADE_DESCRIPTION_SYNC_HEAP_MB (default 512, floor 128): the worker's V8 heap; the sound itself
 * is a Buffer (two bytes a sample at 8 kHz: 16 KB a second, about 115 MB for two hours). */
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const TIMEOUT_MS = () => Math.max(1000, Number(process.env.KADE_DESCRIPTION_SYNC_TIMEOUT_MS) || 600000);
const HEAP_MB = () => Math.max(128, Number(process.env.KADE_DESCRIPTION_SYNC_HEAP_MB) || 512);
const failure = (message, code) => Object.assign(new Error(message), { code });

/**
 * Fingerprints a raw sound file (8 kHz mono signed 16-bit little-endian) on a worker thread.
 * Resolves { bytes: Uint8Array (the .sypr file), seconds, peaks, frames, format, version }.
 * Rejects with err.code KADE_SYNC_TIMEOUT, KADE_SYNC_STOPPED (the signal was aborted) or
 * KADE_SYNC_FAILED. The worker is always stopped before this settles.
 */
function fingerprintFile(file, options = {}) {
  const signal = options.signal;
  const limit = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : TIMEOUT_MS();
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(failure('The fingerprint was stopped.', 'KADE_SYNC_STOPPED'));
    let settled = false;
    let timer = null;
    let worker = null;
    const onAbort = () => done(reject, failure('The fingerprint was stopped.', 'KADE_SYNC_STOPPED'));
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (worker) worker.terminate().catch(() => {});
      fn(value);
    };
    try {
      worker = new Worker(path.join(__dirname, 'worker.js'), {
        workerData: { kadeSyncprint: true, file: String(file) },
        resourceLimits: { maxOldGenerationSizeMb: HEAP_MB() },
      });
    } catch (e) {
      return done(reject, Object.assign(failure('The fingerprint worker could not start.', 'KADE_SYNC_FAILED'), { cause: e }));
    }
    timer = setTimeout(
      () => done(reject, failure(`The fingerprint took longer than ${Math.round(limit / 1000)} s.`, 'KADE_SYNC_TIMEOUT')),
      limit,
    );
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (m) =>
      m && m.ok && m.bytes instanceof Uint8Array
        ? done(resolve, {
            bytes: m.bytes,
            seconds: m.seconds,
            peaks: m.peaks,
            frames: m.frames,
            format: m.format,
            version: m.version,
          })
        : done(reject, failure(String((m && m.error) || 'The fingerprint failed.').slice(0, 300), 'KADE_SYNC_FAILED')),
    );
    worker.once('error', (e) =>
      done(
        reject,
        Object.assign(
          failure(
            e && e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'The fingerprint ran out of memory.' : 'The fingerprint worker failed.',
            'KADE_SYNC_FAILED',
          ),
          { cause: e },
        ),
      ),
    );
    worker.once('exit', () => done(reject, failure('The fingerprint worker stopped before it finished.', 'KADE_SYNC_FAILED')));
  });
}

module.exports = { fingerprintFile };
