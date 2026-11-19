// core/env.js - level envelopes for the Voice Changer engine.
//
// follow() is the classic attack/release peak follower: the rectified signal
// drives a one-pole smoother whose coefficient switches between an attack
// constant (level rising) and a release constant (level falling). The time
// constants are the usual "time to reach 63 percent" values, c = exp(-1 / (t * sr)),
// as in Giannoulis, Massberg and Reiss, "Digital Dynamic Range Compressor
// Design - A Tutorial and Analysis" (JAES 2012), section on level detection.
// A time of zero means instant.
//
// rmsEnv() is a centred sliding-window RMS: every output sample is the root
// mean square of the window of input around it, so the envelope lines up with
// the sound instead of lagging it (which is what segmentation and offline
// gain riding want). It keeps a running sum of squares in float64 and
// recomputes the sum exactly every 32768 samples so rounding never drifts.
// Near the edges the window is simply shorter and the mean uses the samples
// that exist.
//
// Both return a new Float32Array and never emit NaN: non-finite input samples
// count as silence.

/** One-pole coefficient for a time constant in milliseconds (0 = instant). */
export function envCoef(ms, sr) {
  const t = Number(ms)
  if (!(t > 0) || !(sr > 0)) return 0
  return Math.exp(-1000 / (t * sr))
}

/**
 * Peak follower. Returns a Float32Array of the same length holding the
 * smoothed absolute level (linear, not dB).
 */
export function follow(sig, sr, attackMs = 1, releaseMs = 50) {
  const n = sig ? sig.length : 0
  const out = new Float32Array(n)
  const ca = envCoef(attackMs, sr)
  const cr = envCoef(releaseMs, sr)
  let y = 0
  for (let i = 0; i < n; i++) {
    let x = sig[i]
    if (x < 0) x = -x
    if (!(x <= 1e30)) x = 0 // NaN and Infinity read as silence
    const c = x > y ? ca : cr
    y = x + c * (y - x)
    if (y < 1e-25) y = 0
    out[i] = y
  }
  return out
}

/**
 * Centred sliding RMS over windowMs. Returns a Float32Array (linear level).
 */
export function rmsEnv(sig, sr, windowMs = 20) {
  const n = sig ? sig.length : 0
  const out = new Float32Array(n)
  if (!n) return out
  let w = Math.round((Math.max(0, Number(windowMs) || 0) * sr) / 1000)
  if (w < 1) w = 1
  if (w > 2 * n + 1) w = 2 * n + 1
  const back = Math.floor((w - 1) / 2) // samples before the centre
  const fwd = w - 1 - back // samples after the centre
  const sq = (v) => (v === v && v !== Infinity && v !== -Infinity ? v * v : 0)
  // window for output i covers [i - back, i + fwd]
  let lo = 0
  let hi = -1 // inclusive bounds of the current summed range
  let acc = 0
  for (let i = 0; i < n; i++) {
    const wantLo = i - back < 0 ? 0 : i - back
    const wantHi = i + fwd >= n ? n - 1 : i + fwd
    if ((i & 32767) === 0) {
      // exact resync
      acc = 0
      for (let k = wantLo; k <= wantHi; k++) acc += sq(sig[k])
      lo = wantLo
      hi = wantHi
    } else {
      while (hi < wantHi) acc += sq(sig[++hi])
      while (lo < wantLo) acc -= sq(sig[lo++])
    }
    const cnt = hi - lo + 1
    const m = acc > 0 ? acc / cnt : 0
    out[i] = m > 0 ? Math.sqrt(m) : 0
  }
  return out
}

/**
 * Convert a linear envelope to dB in place-safe fashion: returns a new
 * Float32Array, silence reads as floorDb (default -200).
 */
export function envToDb(env, floorDb = -200) {
  const n = env.length
  const out = new Float32Array(n)
  const floorG = Math.pow(10, floorDb / 20)
  for (let i = 0; i < n; i++) {
    const v = env[i]
    out[i] = v > floorG ? 20 * Math.log10(v) : floorDb
  }
  return out
}
