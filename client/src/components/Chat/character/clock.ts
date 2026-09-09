/** Device playout time when the browser exposes it; render time otherwise. */
export function playbackTime(ctx: AudioContext, now = performance.now()): number {
  const rendered = Math.max(0, ctx.currentTime);
  try {
    const stamp = ctx.getOutputTimestamp?.();
    const time = stamp?.contextTime, measured = stamp?.performanceTime;
    if (ctx.state === 'running' && time != null && measured != null &&
        Number.isFinite(time) && time >= 0 && Number.isFinite(measured) && measured > 0 &&
        now >= measured && now - measured < 1000) {
      return Math.max(0, Math.min(rendered, time + (now - measured) / 1000));
    }
  } catch { /* Optional device measurement must never affect audio playback. */ }
  return rendered;
}
