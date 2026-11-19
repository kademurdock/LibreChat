// modules/lofi/_lib.js - shared helpers for the lofi family (not a module).
//
// This file has no default export: it is a helper library the lofi modules
// import. A registry builder should skip files whose name starts with an
// underscore (the pitch, echo and stereo families use the same convention).
//
// What is here:
// - LBiquad: a second-order filter with Robert Bristow-Johnson's "Audio EQ
//   Cookbook" coefficients plus bilinear first-order low and high passes,
//   computed straight into the object's own fields. Unlike core/biquad.js,
//   whose set() returns a small coefficient object, nothing here allocates,
//   so live set() calls may retune it on the audio thread. Direct Form I with
//   float64 state, flushed to zero below 1e-25 (the same reasoning as
//   core/biquad.js: retuning between blocks cannot jump the state, and silent
//   tails never become denormals).
// - FilterBank: up to eight LBiquads in series, loaded from constant tables.
// - Halfband2x: a streaming 2x oversampler for waveshapers. Both directions
//   use one 63-tap linear-phase halfband lowpass (windowed sinc with a Kaiser
//   window, beta 8, after Kaiser and Schafer 1980; the polyphase halfband
//   structure is the textbook one, see Crochiere and Rabiner, "Multirate
//   Digital Signal Processing", 1983). Every other tap of a halfband filter is
//   zero, so each base-rate sample costs 32 multiply-adds up and 33 down. The
//   whole round trip delays the signal by exactly 31 base-rate samples, an
//   integer, so the offline runner can remove it exactly.
// - runStream: the offline runner. Every live-capable lofi module is written
//   once as a streaming kernel; offline processing runs that same kernel over
//   the take, flushes its latency with silence and drops the first `latency`
//   samples, so offline and live outputs are the same samples, aligned with
//   the dry input.
// - holdToRate: zero-order-hold playback of a low-rate sample stream, the
//   way an old sound chip's converter holds each value until the next one.
//   The held waveform is box-filtered at twice the output rate (each output
//   sample is the exact average of the staircase over its own interval) and
//   brought down with core/resample.js, which keeps the chip's own images
//   (the bright buzz of an 8 kHz converter) while stopping our rendering from
//   adding aliases of its own. Each held value is centred on its own sample
//   time, so the output lines up with the dry voice. An optional list of
//   transition times plays samples at uneven moments (a playback loop that
//   stalls).

import { besselI0 } from '../../core/window.js'
import { resample } from '../../core/resample.js'
import { sanitize } from '../../core/buf.js'

export const TINY = 1e-25

export function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

export function dbg(db) {
  return Math.pow(10, db / 20)
}

/** Fraction per sample a one-pole smoother moves toward its target (time constant ms). */
export function smoothCoef(ms, sr) {
  const t = Math.max(0.01, Number(ms) || 0)
  return 1 - Math.exp(-1000 / (t * sr))
}

// Filter type codes for LBiquad.
export const LP = 0
export const HP = 1
export const BP = 2
export const NOTCH = 3
export const PEAK = 4
export const LS = 5
export const HS = 6
export const AP = 7
export const LP1 = 8
export const HP1 = 9
export const OFF = 10

export class LBiquad {
  constructor(sr) {
    this.sr = sr
    this.b0 = 1
    this.b1 = 0
    this.b2 = 0
    this.a1 = 0
    this.a2 = 0
    this.x1 = 0
    this.x2 = 0
    this.y1 = 0
    this.y2 = 0
  }

  /** Retune. Low passes and shelves above 0.45 of the rate turn into a straight wire. */
  set(type, freq, q = 0.707, gainDb = 0) {
    const sr = this.sr
    let f = freq > 1 ? freq : 1
    let t = type
    if ((t === LP || t === LP1 || t === PEAK || t === HS || t === LS || t === NOTCH) && f > sr * 0.45) t = OFF
    if (f > sr * 0.45) f = sr * 0.45
    let Q = q > 0.05 ? q : 0.05
    if (Q > 60) Q = 60
    const g = Number.isFinite(gainDb) ? gainDb : 0
    if (t === OFF || ((t === PEAK || t === LS || t === HS) && g === 0)) {
      this.b0 = 1
      this.b1 = this.b2 = this.a1 = this.a2 = 0
      return this
    }
    if (t === LP1 || t === HP1) {
      const K = Math.tan((Math.PI * f) / sr)
      const a1 = (K - 1) / (K + 1)
      if (t === LP1) {
        this.b0 = K / (1 + K)
        this.b1 = this.b0
      } else {
        this.b0 = 1 / (1 + K)
        this.b1 = -this.b0
      }
      this.b2 = 0
      this.a1 = a1
      this.a2 = 0
      return this
    }
    const w0 = (2 * Math.PI * f) / sr
    const cs = Math.cos(w0)
    const sn = Math.sin(w0)
    const alpha = sn / (2 * Q)
    const A = Math.pow(10, g / 40)
    let b0, b1, b2, a0, a1, a2
    switch (t) {
      case LP:
        b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0
        a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha
        break
      case HP:
        b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0
        a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha
        break
      case BP:
        b0 = alpha; b1 = 0; b2 = -alpha
        a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha
        break
      case NOTCH:
        b0 = 1; b1 = -2 * cs; b2 = 1
        a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha
        break
      case AP:
        b0 = 1 - alpha; b1 = -2 * cs; b2 = 1 + alpha
        a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha
        break
      case PEAK:
        b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A
        a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A
        break
      case LS: {
        const sq = 2 * Math.sqrt(A) * alpha
        b0 = A * ((A + 1) - (A - 1) * cs + sq)
        b1 = 2 * A * ((A - 1) - (A + 1) * cs)
        b2 = A * ((A + 1) - (A - 1) * cs - sq)
        a0 = (A + 1) + (A - 1) * cs + sq
        a1 = -2 * ((A - 1) + (A + 1) * cs)
        a2 = (A + 1) + (A - 1) * cs - sq
        break
      }
      case HS: {
        const sq = 2 * Math.sqrt(A) * alpha
        b0 = A * ((A + 1) + (A - 1) * cs + sq)
        b1 = -2 * A * ((A - 1) + (A + 1) * cs)
        b2 = A * ((A + 1) + (A - 1) * cs - sq)
        a0 = (A + 1) - (A - 1) * cs + sq
        a1 = 2 * ((A - 1) - (A + 1) * cs)
        a2 = (A + 1) - (A - 1) * cs - sq
        break
      }
      default:
        b0 = 1; b1 = 0; b2 = 0; a0 = 1; a1 = 0; a2 = 0
    }
    this.b0 = b0 / a0
    this.b1 = b1 / a0
    this.b2 = b2 / a0
    this.a1 = a1 / a0
    this.a2 = a2 / a0
    return this
  }

  tick(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y < TINY && y > -TINY ? 0 : y
    return this.y1
  }

  /** Filter sig[0..n) in place. */
  run(sig, n = sig.length) {
    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2
    let x1 = this.x1, x2 = this.x2, y1 = this.y1, y2 = this.y2
    for (let i = 0; i < n; i++) {
      const x = sig[i]
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = x
      y2 = y1
      y1 = y < TINY && y > -TINY ? 0 : y
      sig[i] = y1
    }
    if (!(Number.isFinite(y1) && Number.isFinite(y2) && Number.isFinite(x1) && Number.isFinite(x2))) x1 = x2 = y1 = y2 = 0
    this.x1 = x1; this.x2 = x2; this.y1 = y1; this.y2 = y2
    return sig
  }

  reset() {
    this.x1 = this.x2 = this.y1 = this.y2 = 0
    return this
  }

  /** Guard against a poisoned state (call once per block). */
  heal() {
    if (!(Number.isFinite(this.y1) && Number.isFinite(this.y2) && Number.isFinite(this.x1) && Number.isFinite(this.x2))) this.reset()
  }
}

/** Up to `max` LBiquads in series, loaded from a table of [type, freq, q, gainDb] rows. */
export class FilterBank {
  constructor(sr, max = 8) {
    this.sr = sr
    this.f = new Array(max)
    for (let i = 0; i < max; i++) this.f[i] = new LBiquad(sr)
    this.n = 0
  }

  /** rows: constant table; scale multiplies every frequency (tape speed, size). */
  load(rows, scale = 1) {
    const m = Math.min(rows ? rows.length : 0, this.f.length)
    for (let i = 0; i < m; i++) {
      const r = rows[i]
      this.f[i].set(r[0], r[1] * scale, r[2], r[3])
    }
    this.n = m
    return this
  }

  tick(x) {
    let v = x
    const f = this.f
    for (let i = 0; i < this.n; i++) v = f[i].tick(v)
    return v
  }

  run(sig, n = sig.length) {
    for (let i = 0; i < this.n; i++) this.f[i].run(sig, n)
    return sig
  }

  reset() {
    for (let i = 0; i < this.f.length; i++) this.f[i].reset()
    return this
  }

  heal() {
    for (let i = 0; i < this.n; i++) this.f[i].heal()
  }
}

// ---------------------------------------------------------------- 2x oversampling

const HB_SIDE = 32 // nonzero odd-offset taps (offsets -31, -29, ... 31)
export const HB_DELAY = 31 // base-rate samples of delay for a full up-and-down round trip

const HB = (() => {
  const c = new Float64Array(HB_SIDE)
  const beta = 8
  const i0b = besselI0(beta)
  let s = 0
  for (let i = 0; i < HB_SIDE; i++) {
    const m = 2 * i - 31
    const r = m / 32
    const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b
    const x = (Math.PI * m) / 2
    const h = 0.5 * (Math.sin(x) / x) * w
    c[i] = h
    s += h
  }
  for (let i = 0; i < HB_SIDE; i++) c[i] *= 0.5 / s // odd taps sum to one half: unity gain at DC
  return c
})()

export class Halfband2x {
  constructor() {
    this.xb = new Float64Array(2 * HB_SIDE)
    this.eb = new Float64Array(2 * HB_SIDE)
    this.ob = new Float64Array(2 * HB_SIDE)
    this.w = 0
    this.e = 0 // earlier 2x-rate sample of the current base step
    this.o = 0 // later 2x-rate sample
  }

  reset() {
    this.xb.fill(0)
    this.eb.fill(0)
    this.ob.fill(0)
    this.w = 0
    this.e = 0
    this.o = 0
  }

  /** Push one base-rate sample; leaves the two 2x-rate samples in this.e then this.o. */
  up(x) {
    const w = (this.w + HB_SIDE - 1) & (HB_SIDE - 1)
    this.w = w
    const xb = this.xb
    const v = x > -1e30 && x < 1e30 ? x : 0
    xb[w] = v
    xb[w + HB_SIDE] = v
    let acc = 0
    for (let i = 0; i < HB_SIDE; i++) acc += HB[i] * xb[w + i]
    this.e = 2 * acc
    this.o = xb[w + 15]
  }

  /** Push the two shaped 2x-rate samples of this base step; returns one base-rate sample. */
  down(se, so) {
    const w = this.w
    const eb = this.eb
    const ob = this.ob
    const a = se > -1e30 && se < 1e30 ? se : 0
    const b = so > -1e30 && so < 1e30 ? so : 0
    eb[w] = a
    eb[w + HB_SIDE] = a
    ob[w] = b
    ob[w + HB_SIDE] = b
    let acc = 0
    for (let i = 0; i < HB_SIDE; i++) acc += HB[i] * eb[w + i]
    return acc + 0.5 * ob[w + 16]
  }
}

/** A short ring delay of exactly d samples (d < 64) for the dry path. */
export class ShortDelay {
  constructor(d) {
    this.d = Math.max(0, Math.min(63, d | 0))
    this.b = new Float64Array(64)
    this.w = 0
  }

  tick(x) {
    const b = this.b
    b[this.w] = x
    const y = b[(this.w - this.d) & 63]
    this.w = (this.w + 1) & 63
    return y
  }

  reset() {
    this.b.fill(0)
    this.w = 0
  }
}

// ---------------------------------------------------------------- offline runner

/**
 * Run a live kernel ({ process(ins, outs, n) }) over a buffer, flushing and
 * removing `latency` samples, and adding `tail` samples of ring-out.
 * Returns a new buffer with the input's channel count.
 */
export function runStream(kernel, input, latency, tail, ctx) {
  const sr = input.sr
  const nch = input.ch && input.ch.length ? Math.min(2, input.ch.length) : 1
  const n = input.ch && input.ch.length ? input.ch[0].length : 0
  const L = Math.max(0, Math.round(num(latency, 0)))
  const extra = Math.max(0, Math.round(num(tail, 0)))
  const N = n + L + extra
  const ins = new Array(nch)
  const outs = new Array(nch)
  for (let c = 0; c < nch; c++) {
    const a = new Float32Array(N)
    if (input.ch[c]) a.set(input.ch[c])
    sanitize(a)
    ins[c] = a
    outs[c] = new Float32Array(N)
  }
  const B = 4096
  const vin = new Array(nch)
  const vout = new Array(nch)
  const progress = ctx && typeof ctx.progress === 'function' ? ctx.progress : null
  const cancelled = ctx && typeof ctx.cancelled === 'function' ? ctx.cancelled : null
  for (let s = 0, blk = 0; s < N; s += B, blk++) {
    const e = Math.min(N, s + B)
    for (let c = 0; c < nch; c++) {
      vin[c] = ins[c].subarray(s, e)
      vout[c] = outs[c].subarray(s, e)
    }
    kernel.process(vin, vout, e - s)
    if ((blk & 15) === 15) {
      if (progress) progress(e / Math.max(1, N))
      if (cancelled && cancelled()) break
    }
  }
  const ch = new Array(input.ch && input.ch.length ? input.ch.length : 1)
  for (let c = 0; c < ch.length; c++) {
    const src = outs[Math.min(c, nch - 1)]
    const y = src.slice(L, L + n + extra)
    sanitize(y)
    ch[c] = y
  }
  return { sr, ch }
}

// ---------------------------------------------------------------- chip playback

/**
 * Zero-order hold of `lev` (a stream at rate R) rendered at rate sr, outLen
 * samples. With `times` (Float64Array of lev.length + 1 transition times in
 * chip-sample units, times[0] = 0), sample k is held from times[k] to
 * times[k + 1]; otherwise sample k covers [k, k + 1). Holds are centred on
 * their sample times (shifted back half a nominal period) so the output is
 * aligned with the input. os: render oversampling (1 or 2).
 */
export function holdToRate(lev, R, sr, outLen, times = null, os = 2) {
  const m = lev.length
  const N = Math.max(0, outLen | 0) * os
  const H = new Float32Array(N)
  if (N === 0) return new Float32Array(0)
  const step = R / (sr * os)
  if (!times) {
    for (let j = 0; j < N; j++) {
      const a = (j - 0.5) * step + 0.5
      const b = a + step
      let acc = 0
      let pos = a
      let k = Math.floor(pos)
      while (pos < b) {
        const e = k + 1 < b ? k + 1 : b
        if (k >= 0 && k < m) acc += lev[k] * (e - pos)
        pos = e
        k++
      }
      H[j] = acc / step
    }
  } else {
    let k = 0
    for (let j = 0; j < N; j++) {
      const a = (j - 0.5) * step + 0.5
      const b = a + step
      let acc = 0
      let pos = a
      if (pos < 0) pos = b < 0 ? b : 0
      while (k < m && times[k + 1] <= pos) k++
      while (pos < b && k < m) {
        const end = times[k + 1] < b ? times[k + 1] : b
        if (end > pos) acc += lev[k] * (end - pos)
        pos = end
        if (end >= times[k + 1]) k++
      }
      H[j] = acc / step
    }
  }
  if (os === 1) return H
  const y = resample(H, 1 / os)
  if (y.length === outLen) return y
  const z = new Float32Array(outLen)
  z.set(y.subarray(0, Math.min(outLen, y.length)))
  return z
}

/** Copy of sig with exactly len samples (cut or zero padded). */
export function fitLength(sig, len) {
  if (sig.length === len) return sig
  const z = new Float32Array(len)
  z.set(sig.length > len ? sig.subarray(0, len) : sig)
  return z
}
