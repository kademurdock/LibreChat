'use strict';
/* Audit fix (Nov 12 2026): read an uploaded book on a worker thread with a time limit. The parser
 * (kadeReadingRoomParse.js) is pure, but its regexes are quadratic or worse on hostile markup
 * (a 43 KB DAISY head took 69 s), and on the main thread that stopped every chat and call.
 *
 * Memory: production starts Node with --max-old-space-size (Dockerfile CMD), and that flag wins
 * over a worker's resourceLimits (measured on Node 24.22.1), and no V8 limit counts Buffers at
 * all. So the worker also watches its own heap + Buffer use and stops itself over the budget.
 *
 * KADE_BOOK_PARSE_WORKER=0 parses in-process as before.
 * KADE_BOOK_PARSE_TIMEOUT_MS (default 90000, floor 1000), KADE_BOOK_PARSE_HEAP_MB (default 1536, floor 256). */
const fs = require('node:fs');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const TOO_SLOW = 'That file took too long to read, so it was stopped. If it is a real book, tell Kade.';
const TOO_BIG = 'That file unpacks to more than the library can read as one book.';
const NOT_READ = 'The book reader stopped before it finished. Try again in a moment.';

if (!isMainThread && workerData && workerData.kadeParseBook) {
  const say = (message) => { try { parentPort.postMessage(message); } catch { /* the thread is being stopped */ } };
  let buffer;
  try {
    buffer = workerData.path ? fs.readFileSync(workerData.path) : Buffer.from(workerData.buffer);
  } catch (e) {
    say({ ok: false, code: 'KADE_PARSE_FAILED', error: e && e.code === 'ENOENT' ? 'The upload was gone before it could be read. Send it again.' : NOT_READ });
  }
  if (buffer) {
    // The file's own bytes are a Buffer too, so they ride on top of the budget.
    const budget = workerData.memoryMb * 1024 * 1024 + buffer.length;
    const watch = setInterval(() => {
      const m = process.memoryUsage();
      if (m.heapUsed + m.external > budget) { clearInterval(watch); say({ ok: false, code: 'KADE_PARSE_MEMORY', error: TOO_BIG }); }
    }, 100);
    require('./kadeReadingRoomParse').parseBook(buffer, workerData.filename)
      .then((parsed) => say({ ok: true, parsed }))
      .catch((e) => say({ ok: false, code: 'KADE_PARSE_FAILED', error: String((e && e.message) || e).slice(0, 300) }))
      .finally(() => clearInterval(watch));
  }
}

const TIMEOUT_MS = () => Math.max(1000, Number(process.env.KADE_BOOK_PARSE_TIMEOUT_MS) || 90000);
const HEAP_MB = () => Math.max(256, Number(process.env.KADE_BOOK_PARSE_HEAP_MB) || 1536);
const failure = (message, code) => Object.assign(new Error(message), { code });

/** parseBook off the main thread. Pass { path } (read inside the worker, no copy), { buffer }, or both
 * (the worker reads the path; the in-process fallback uses the buffer). Rejects with a sentence that
 * is safe to say to the reader; err.code is KADE_PARSE_TIMEOUT, KADE_PARSE_MEMORY or KADE_PARSE_FAILED. */
async function parseBookIsolated({ path, buffer, filename }) {
  if (!path && !buffer) throw failure('No book arrived.', 'KADE_PARSE_FAILED');
  if (process.env.KADE_BOOK_PARSE_WORKER === '0') {
    return require('./kadeReadingRoomParse').parseBook(buffer || await fs.promises.readFile(path), filename);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let worker = null;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (worker) worker.terminate().catch(() => {});
      fn(value);
    };
    try {
      worker = new Worker(__filename, {
        workerData: { kadeParseBook: true, path: path || null, buffer: path ? null : buffer, filename: String(filename || ''), memoryMb: HEAP_MB() },
        resourceLimits: { maxOldGenerationSizeMb: HEAP_MB() },
      });
    } catch (e) {
      return done(reject, failure(NOT_READ, 'KADE_PARSE_FAILED'));
    }
    timer = setTimeout(() => done(reject, failure(TOO_SLOW, 'KADE_PARSE_TIMEOUT')), TIMEOUT_MS());
    worker.once('message', (m) => (m && m.ok
      ? done(resolve, m.parsed)
      : done(reject, failure((m && m.error) || 'the book could not be read', (m && m.code) || 'KADE_PARSE_FAILED'))));
    worker.once('error', (e) => done(reject, e && e.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? failure(TOO_BIG, 'KADE_PARSE_MEMORY')
      : Object.assign(failure(NOT_READ, 'KADE_PARSE_FAILED'), { cause: e })));
    worker.once('exit', () => done(reject, failure(NOT_READ, 'KADE_PARSE_FAILED')));
  });
}

module.exports = { parseBookIsolated };
