/**
 * DB-2 (platform audit, Nov 12 2026). api/db/connect.js sets no socketTimeoutMS and no default
 * maxTimeMS, so one stuck read on the turn path could hold a reply forever. Reads the reply waits
 * on pass these options so the server gives up after KADE_TURN_READ_MAX_MS (default 3000 ms);
 * every caller already treats a failed read as "nothing found" or a plain turn error, which is
 * better than silence. KADE_TURN_READ_MAX_MS=0 removes the limit (the old behaviour).
 * The pool wait limit (MONGO_WAIT_QUEUE_TIMEOUT_MS) is a Railway setting, not this file.
 */
function turnReadMaxMs() {
  const raw = process.env.KADE_TURN_READ_MAX_MS;
  const n = raw == null || String(raw).trim() === '' ? 3000 : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Query or aggregate options for a turn-path read: `{ maxTimeMS }`, or `{}` when switched off. */
function turnReadOptions() {
  const ms = turnReadMaxMs();
  return ms > 0 ? { maxTimeMS: ms } : {};
}

module.exports = { turnReadMaxMs, turnReadOptions };
