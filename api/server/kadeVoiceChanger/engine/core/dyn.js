// core/dyn.js - dynamics for the Voice Changer engine: compressor, limiter, gate.
//
// compress() is the feed-forward, log-domain design recommended by
// Giannoulis, Massberg and Reiss, "Digital Dynamic Range Compressor Design -
// A Tutorial and Analysis" (JAES 2012): the level of each sample is taken in
// dB, a static gain computer with a quadratic soft knee gives the wanted gain
// reduction, and that reduction (not the signal) is smoothed by a branching
// one-pole peak detector, attack while reduction grows and release while it
// shrinks. Smoothing in the log domain keeps attack and release times the
// same at every level, which is why it sounds even on speech. Optional
// lookahead (offline only: the detector simply reads ahead in the array)
// lets the gain start falling before a consonant hits.
//
// limitBuf() is a brick-wall lookahead peak limiter, channel-linked:
// 1. For every sample the required gain is ceiling / peak, where the peak is
//    the largest channel, and with truePeak on (the default) also the
//    4x-oversampled inter-sample peaks next to it (core/loudness.js).
// 2. A forward moving minimum over the lookahead window makes the gain reach
//    its floor before the peak arrives (monotonic deque, O(n)).
// 3. A one-pole release lets the gain recover slowly once the peak is past.
// 4. Two cascaded moving averages whose combined length equals the
//    lookahead turn the steps into a smooth S-shaped ramp. Because every
//    value averaged for the sample at a peak already contains that peak in
//    its forward window, the smoothed gain at the peak is never above the
//    required gain: the ceiling holds by construction (the approach is the
//    one described by Geraint Luff, "Signalsmith Audio: limiter design").
// 5. A final pass clamps any sample still above the ceiling (float rounding
//    can leave one a single ulp over); the ceiling is rounded down to the
//    nearest float32 first, so no sample is ever above it.
// Offline, the lookahead needs no delay: the gain simply looks ahead.
//
// gate() is a downward gate with hysteresis and hold: a fast peak detector
// opens the gate at the threshold and lets it close only once the level has
// fallen hysteresisDb below it and the hold time has run out. The gain
// glides between unity and the floor with one-pole attack and release, so it
// never clicks.
//
// Everything works in place on Float32Arrays (or buffers for the *Buf forms)
// and returns what it changed. No NaN in, no NaN out: non-finite samples
// are treated as silence and written back as 0.

import { interSamplePeaks } from './loudness.js'
import { envCoef } from './env.js'

const LN10_20 = Math.LN10 / 20
const DB_PER_LN = 20 / Math.LN10

function num(v, d) {
  const x = Number(v)
  return v === undefined || v === null || !Number.isFinite(x) ? d : x
}

// ---------------------------------------------------------------- compressor

// Shared core: chs is an array of equal-length Float32Arrays, the detector
// takes the largest channel (channel link), the same gain goes to all.
function compressCore(chs, sr, opts) {
  const o = opts || {}
  const T = num(o.thresholdDb, -18)
  let R = o.ratio === Infinity ? Infinity : num(o.ratio, 3)
  if (!(R >= 1)) R = 1
  const W = Math.max(0, num(o.kneeDb, 6))
  const makeup = num(o.makeupDb, 0)
  const ca = envCoef(num(o.attackMs, 5), sr)
  const cr = envCoef(num(o.releaseMs, 80), sr)
  const look = Math.max(0, Math.round((num(o.lookaheadMs, 0) * sr) / 1000))
  const grOut = o.grOut instanceof Float32Array ? o.grOut : null
  const slope = R === Infinity ? -1 : 1 / R - 1 // dB of gain per dB over
  const nch = chs.length
  const n = nch ? chs[0].length : 0
  const makeupG = Math.exp(makeup * LN10_20)
  const kneeLo = T - W / 2
  const kneeHi = T + W / 2
  // below this linear level the gain computer asks for nothing
  const quietLin = Math.exp(kneeLo * LN10_20)
  let s = 0 // smoothed gain reduction, dB, >= 0
  for (let i = 0; i < n; i++) {
    const j = i + look < n ? i + look : n - 1
    let a = 0
    for (let c = 0; c < nch; c++) {
      let v = chs[c][j]
      if (v < 0) v = -v
      if (v > a && v <= 1e30) a = v
    }
    let want = 0
    if (a > quietLin) {
      const x = Math.log(a) * DB_PER_LN
      if (x >= kneeHi) want = -slope * (x - T)
      else {
        const d = x - kneeLo
        want = (-slope * d * d) / (2 * W || 1) // W is never 0 here; guarded anyway
      }
    }
    s = want > s ? want + ca * (s - want) : want + cr * (s - want)
    if (s < 1e-9) s = 0
    const g = s === 0 ? makeupG : Math.exp((makeup - s) * LN10_20)
    for (let c = 0; c < nch; c++) {
      const v = chs[c][i]
      chs[c][i] = v <= 1e30 && v >= -1e30 ? v * g : 0
    }
    if (grOut && i < grOut.length) grOut[i] = -s
  }
}

/**
 * Compress sig in place. opts: { thresholdDb=-18, ratio=3 (Infinity allowed),
 * attackMs=5, releaseMs=80, kneeDb=6, makeupDb=0, lookaheadMs=0,
 * grOut: Float32Array to receive the gain reduction in dB (<= 0) }.
 * Returns sig.
 */
export function compress(sig, sr, opts) {
  if (!sig || !sig.length) return sig
  compressCore([sig], sr, opts)
  return sig
}

/** Channel-linked compress of a whole buffer in place. Returns b. */
export function compressBuf(b, opts) {
  if (!b || !b.ch || !b.ch.length || !b.ch[0].length) return b
  compressCore(b.ch, b.sr, opts)
  return b
}

// ---------------------------------------------------------------- limiter

const F32 = new Float32Array(1)
const U32 = new Uint32Array(F32.buffer)

/** Largest float32 value that is <= x (x > 0). */
export function float32AtOrBelow(x) {
  F32[0] = x
  if (F32[0] > x) U32[0] -= 1
  return F32[0]
}

/**
 * Lookahead brick-wall limiter, in place, channel-linked.
 * opts: { ceilingDb=-1, lookaheadMs=5, releaseMs=80, truePeak=true }.
 * After it, no sample of any channel is above the ceiling. Returns b.
 */
export function limitBuf(b, opts = {}) {
  if (!b || !b.ch || !b.ch.length) return b
  const chs = b.ch
  const nch = chs.length
  const n = chs[0].length
  if (!n) return b
  const sr = b.sr > 0 ? b.sr : 48000
  let ceilDb = num(opts.ceilingDb, -1)
  if (ceilDb > 24) ceilDb = 24
  if (ceilDb < -120) ceilDb = -120
  const ceil = Math.pow(10, ceilDb / 20)
  const c32 = float32AtOrBelow(ceil)
  const truePeak = opts.truePeak !== false
  const L = Math.max(1, Math.round((Math.max(0, num(opts.lookaheadMs, 5)) * sr) / 1000))
  const cr = envCoef(Math.max(0, num(opts.releaseMs, 80)), sr)

  // 1. required gain, padded with L samples of "no reduction" in front so the
  //    ramp for a peak at the very start can begin before the clip does.
  const N = n + L
  const req = new Float32Array(N)
  req.fill(1, 0, L)
  const pk = truePeak ? new Float32Array(n) : null
  const level = new Float32Array(n)
  for (let c = 0; c < nch; c++) {
    const s = chs[c]
    if (truePeak) {
      interSamplePeaks(s, ceil, pk)
      for (let i = 0; i < n; i++) if (pk[i] > level[i]) level[i] = pk[i]
    } else {
      for (let i = 0; i < n; i++) {
        let v = s[i]
        if (v < 0) v = -v
        if (v > level[i] && v <= 1e30) level[i] = v
      }
    }
  }
  let any = false
  for (let i = 0; i < n; i++) {
    const v = level[i]
    if (v > ceil) {
      req[L + i] = ceil / v
      any = true
    } else req[L + i] = 1
  }
  if (!any) {
    // nothing to do except clean non-finite samples
    for (let c = 0; c < nch; c++) {
      const s = chs[c]
      for (let i = 0; i < n; i++) if (!(s[i] <= 1e30 && s[i] >= -1e30)) s[i] = 0
    }
    return b
  }

  // 2. forward moving minimum over [i, i + L - 1] (monotonic deque)
  const h = new Float32Array(N)
  const dq = new Int32Array(N)
  let head = 0
  let tail = 0 // deque holds indices with increasing req values
  let next = 0 // next index to push
  for (let i = 0; i < N; i++) {
    const end = i + L - 1 < N ? i + L - 1 : N - 1
    while (next <= end) {
      const v = req[next]
      while (tail > head && req[dq[tail - 1]] >= v) tail--
      dq[tail++] = next
      next++
    }
    while (dq[head] < i) head++
    h[i] = req[dq[head]]
  }

  // 3. release: falls instantly, recovers with a one-pole
  let r = 1
  for (let i = 0; i < N; i++) {
    const v = h[i]
    r = v < r ? v : v + cr * (r - v)
    h[i] = r
  }

  // 4. two moving averages, lengths L1 + L2 - 1 = L
  const L1 = Math.ceil(L / 2)
  const L2 = L - L1 + 1
  boxInPlace(h, L1, req) // req is free now: reuse as scratch
  boxInPlace(h, L2, req)

  // 5. apply, then clamp anything still over by rounding
  for (let c = 0; c < nch; c++) {
    const s = chs[c]
    for (let i = 0; i < n; i++) {
      let g = h[L + i]
      if (g > 1) g = 1
      let y = s[i]
      y = y <= 1e30 && y >= -1e30 ? y * g : 0
      if (y > c32) y = c32
      else if (y < -c32) y = -c32
      s[i] = y
    }
  }
  return b
}

// Causal moving average of length len over a (in place), using scratch.
// Values before the start count as a[0]'s left neighbour, which is 1 here.
function boxInPlace(a, len, scratch) {
  const N = a.length
  if (len <= 1) return
  scratch.set(a)
  let acc = len // len virtual samples of 1 before the start
  const inv = 1 / len
  for (let i = 0; i < N; i++) {
    acc += scratch[i]
    acc -= i - len >= 0 ? scratch[i - len] : 1
    a[i] = acc * inv
  }
}

/** Sample-peak limiter on one Float32Array (convenience). Returns sig. */
export function limitSig(sig, sr, opts = {}) {
  limitBuf({ sr, ch: [sig] }, opts)
  return sig
}

// ---------------------------------------------------------------- gate

function gateCore(chs, sr, opts) {
  const o = opts || {}
  const T = num(o.thresholdDb, -50)
  const hyst = Math.max(0, num(o.hysteresisDb, 6))
  const floorDb = Math.min(0, num(o.floorDb, -80))
  const ca = envCoef(Math.max(0, num(o.attackMs, 1)), sr)
  const cr = envCoef(Math.max(0, num(o.releaseMs, 120)), sr)
  const holdN = Math.max(0, Math.round((num(o.holdMs, 50) * sr) / 1000))
  const look = Math.max(0, Math.round((num(o.lookaheadMs, 0) * sr) / 1000))
  const openLin = Math.pow(10, T / 20)
  const closeLin = Math.pow(10, (T - hyst) / 20)
  const floorG = floorDb <= -200 ? 0 : Math.pow(10, floorDb / 20)
  // detector: instant attack, 10 ms release peak follower
  const dr = envCoef(10, sr)
  const nch = chs.length
  const n = nch ? chs[0].length : 0
  let env = 0
  let open = false
  let hold = 0
  let g = floorG
  for (let i = 0; i < n; i++) {
    const j = i + look < n ? i + look : n - 1
    let a = 0
    for (let c = 0; c < nch; c++) {
      let v = chs[c][j]
      if (v < 0) v = -v
      if (v > a && v <= 1e30) a = v
    }
    env = a > env ? a : a + dr * (env - a)
    if (env >= openLin) {
      open = true
      hold = holdN
    } else if (open) {
      if (env < closeLin) {
        if (hold > 0) hold--
        else open = false
      } else hold = holdN
    }
    const target = open ? 1 : floorG
    g = target > g ? target + ca * (g - target) : target + cr * (g - target)
    if (g < 1e-12) g = 0
    for (let c = 0; c < nch; c++) {
      const v = chs[c][i]
      chs[c][i] = v <= 1e30 && v >= -1e30 ? v * g : 0
    }
  }
}

/**
 * Noise gate in place. opts: { thresholdDb=-50, attackMs=1, releaseMs=120,
 * holdMs=50, floorDb=-80, hysteresisDb=6, lookaheadMs=0 }. Returns sig.
 */
export function gate(sig, sr, opts) {
  if (!sig || !sig.length) return sig
  gateCore([sig], sr, opts)
  return sig
}

/** Channel-linked gate of a buffer in place. Returns b. */
export function gateBuf(b, opts) {
  if (!b || !b.ch || !b.ch.length || !b.ch[0].length) return b
  gateCore(b.ch, b.sr, opts)
  return b
}
