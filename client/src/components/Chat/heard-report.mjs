/* heard-report.mjs — Nov 11 2026. How far a streaming call's playback got, for the bridge.
 *
 * When someone barges in on a character, the bridge now stores only what was actually heard
 * (kade-ai-bridge heard-cut.js). It knows what it SENT; only the client knows what PLAYED. So when
 * playback stops (the bridge's 'clear', or the Stop button), the call sends one message:
 *
 *   { type: 'heard', seq: <int>, ms: <int> }
 *
 *   seq — the number of the WAV clip that was playing, counting every WAV binary frame this call's
 *         socket has delivered, from 1 (a "LIVE" PCM frame is not a clip and is not counted; a
 *         clip dropped by an earlier flush still counts, because the bridge counted it when sent).
 *         0 = no clip has played yet.
 *   ms    — milliseconds of that clip that had played. A clip that had finished reports its length.
 *
 * Clips numbered below seq played whole; clips after it never started. Pure code, no browser
 * parts: the same rules serve the iPhone and Android ports. Tested in heard-report.test.mjs.
 */

/** A fresh log for one call. */
export function createPlaybackLog() {
  return { received: 0, clips: [], last: { seq: 0, ms: 0 } };
}

/** A WAV binary frame arrived; returns its clip number. Call for every WAV frame, before decoding. */
export function noteClipReceived(log) {
  log.received += 1;
  return log.received;
}

/** A clip was scheduled to start at `startSec` (AudioContext time) and lasts `durSec`. */
export function noteClipScheduled(log, seq, startSec, durSec) {
  if (!Number.isFinite(startSec) || !Number.isFinite(durSec) || !(seq > 0)) return;
  log.clips.push({ seq, start: startSec, dur: Math.max(0, durSec) });
  if (log.clips.length > 64) log.clips.splice(0, log.clips.length - 64);
}

/** Where playback is at `nowSec`: { seq, ms }. Does not change the log. */
export function heardAt(log, nowSec) {
  let best = null;
  for (const c of log.clips) {
    if (c.start > nowSec) continue; // scheduled, not started
    const ms = Math.round(Math.min(nowSec - c.start, c.dur) * 1000);
    if (!best || c.seq > best.seq) best = { seq: c.seq, ms };
  }
  if (!best || best.seq < log.last.seq) return { ...log.last };
  return best;
}

/** Playback was flushed at `nowSec`: returns the report to send and starts the log afresh. */
export function flushReport(log, nowSec) {
  const report = heardAt(log, nowSec);
  log.clips = [];
  log.last = report;
  return { type: 'heard', seq: report.seq, ms: report.ms };
}

/** The AudioContext time the listener is hearing now (output latency taken off when known). */
export function heardClock(ctx) {
  if (!ctx || !Number.isFinite(ctx.currentTime)) return 0;
  const lag =
    Number.isFinite(ctx.outputLatency) && ctx.outputLatency > 0 && ctx.outputLatency < 1
      ? ctx.outputLatency
      : 0;
  return Math.max(0, ctx.currentTime - lag);
}
