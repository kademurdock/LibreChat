// modules/echo/_lib.js - shared helpers for the echo family (not a module).
//
// This file has no default export: it is a helper library the echo modules
// import. A registry builder should skip files whose name starts with an
// underscore (the pitch family uses the same convention).
//
// What is here:
// - The offline runner. Every echo module except the reverse reverb swell is
//   written once, as a streaming "kernel" (the live version), and the offline
//   process simply runs that same kernel over the take plus its declared tail.
//   Offline and live therefore sound identical, and the kernel is per-sample,
//   so its output does not depend on the block size the host uses.
// - The mix law used by the whole family: the dry voice stays at full level
//   until the mix passes the middle, and the echoes reach full level at the
//   middle ("dual linear" crossfade, the usual law of hardware delay pedals
//   with one blend knob). At 50 percent you hear all of the voice and all of
//   the echoes.
// - Tail arithmetic: how many repeats a feedback loop needs to fall a given
//   number of decibels (repeats = ln(floor) / ln(gain)), and the family-wide
//   cap on tails (20 s, with a fade so a runaway loop ends like an engineer
//   pulling the fader).
// - Small allocation-free building blocks: a topology-preserving one-pole
//   (Zavalishin, "The Art of VA Filter Design", 2012), a Schroeder allpass
//   diffuser (Schroeder and Logan, "Colorless artificial reverberation",
//   JAES 1961), a bounded soft saturator for feedback paths, and a small
//   spring tank after Valimaki, Parker and Abel, "Parametric spring
//   reverberation effect", JAES 2010 (a cascade of stretched first-order
//   allpass filters inside a lowpassed feedback loop, which makes the
//   falling "drip" chirps of a real spring).

import { sanitize } from '../../core/buf.js'

/** Longest tail any echo module declares, in seconds. */
export const TAIL_CAP = 20

/** Default floor for tail estimates: sound below this many dB under the first echo is treated as gone. */
export const TAIL_FLOOR_DB = -50

/** Number or fallback. */
export function num(v, def) {
  const x = Number(v)
  return Number.isFinite(x) ? x : def
}

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

/** Dry and wet gains for a mix percent (0 all dry, 50 both full, 100 all wet). */
export function mixGains(mixPct) {
  const m = clamp(num(mixPct, 50) / 100, 0, 1)
  return { dry: m <= 0.5 ? 1 : 2 * (1 - m), wet: m >= 0.5 ? 1 : 2 * m }
}

/** Repeats a loop with this gain needs to fall floorDb (Infinity at or above unity). */
export function repeatsTo(gain, floorDb = TAIL_FLOOR_DB) {
  const g = Math.abs(num(gain, 0))
  if (!(g > 1e-4)) return 0
  if (g >= 0.995) return Infinity
  return Math.ceil(Math.log(Math.pow(10, floorDb / 20)) / Math.log(g))
}

/** Clamp a tail to [0, TAIL_CAP]; Infinity and NaN become the cap and 0. */
export function capTail(sec) {
  if (sec === Infinity) return TAIL_CAP
  if (!(sec > 0)) return 0
  return sec > TAIL_CAP ? TAIL_CAP : sec
}

/** Per-sample smoothing coefficient for a one-pole with time constant tauSec. */
export function smoothCoef(tauSec, sr) {
  const t = Math.max(1e-4, tauSec) * sr
  return 1 - Math.exp(-1 / t)
}

/** TPT one-pole coefficient G = g / (1 + g), g = tan(pi f / sr). */
export function onePoleG(freq, sr) {
  const f = clamp(num(freq, 1000), 1, sr * 0.45)
  const g = Math.tan((Math.PI * f) / sr)
  return g / (1 + g)
}

/**
 * Bounded soft saturation for feedback paths: exactly linear below 0.6, then a
 * tanh knee that never passes 1. Feedback can never build a loop past 1.
 */
export function feedbackSat(x) {
  if (x < 0.6 && x > -0.6) return x
  if (!(x > -1e9 && x < 1e9)) return 0
  const a = x < 0 ? -x : x
  const e = Math.exp((-2 * (a - 0.6)) / 0.4)
  const y = 0.6 + 0.4 * ((1 - e) / (1 + e))
  return x < 0 ? -y : y
}

/** Rounded saturation with drive for tape colour: x(27 + x^2) / (27 + 9x^2), clamped at |x| = 3. */
export function tapeSat(x) {
  if (x > 3) return 1
  if (x < -3) return -1
  const x2 = x * x
  return (x * (27 + x2)) / (27 + 9 * x2)
}

/** Flush values that would decay into float32 denormals. */
export function flush(x) {
  return x < 1e-20 && x > -1e-20 ? 0 : x
}

/**
 * Schroeder allpass diffuser with a fixed integer delay (set at construction
 * up to maxSamples; changeable later without allocation).
 */
export class Allpass {
  constructor(maxSamples, delay, g) {
    this.size = Math.max(2, Math.ceil(maxSamples) + 1)
    this.buf = new Float32Array(this.size)
    this.w = 0
    this.setDelay(delay)
    this.g = num(g, 0.5)
  }

  setDelay(d) {
    this.d = clamp(Math.round(num(d, 1)), 1, this.size - 1)
  }

  tick(x) {
    let r = this.w - this.d
    if (r < 0) r += this.size
    const z = this.buf[r]
    const v = x + this.g * z
    const y = z - this.g * v
    this.buf[this.w] = v < 1e-20 && v > -1e-20 ? 0 : v
    this.w = this.w + 1 === this.size ? 0 : this.w + 1
    return y
  }

  reset() {
    this.buf.fill(0)
    this.w = 0
  }
}

/**
 * A small spring tank. A cascade of M stretched first-order allpass sections
 * A(z) = (a + z^-K) / (1 + a z^-K) with a < 0 delays low frequencies more
 * than high ones, so a click comes out as a falling chirp; inside a feedback
 * loop (delay, lowpass, gain) each trip round adds more chirp, which is the
 * dripping "boing" of a spring. K is about sr / 8 kHz, so the dispersion sits
 * below 4 kHz like a real tank. variant 0 or 1 picks slightly different
 * lengths for left and right.
 */
export class Spring {
  constructor(sr, variant = 0) {
    this.sr = sr
    // 12 sections at a = -0.7 give about the low-frequency delay spread of 18 at -0.62
    // (each section delays DC by K (1 - a) / (1 + a) samples), at two thirds of the cost.
    this.M = 12
    this.K = Math.max(1, Math.round(sr / 8000))
    this.a = variant ? -0.66 : -0.7
    this.ring = new Float32Array(this.M * this.K)
    this.ri = 0
    const loopMs = variant ? 43.7 : 37.1
    this.loopLen = Math.max(4, Math.round((loopMs / 1000) * sr))
    this.loop = new Float32Array(this.loopLen)
    this.li = 0
    this.fb = 0.72
    this.lpG = onePoleG(4200, sr)
    this.lpS = 0
    this.hpG = onePoleG(180, sr)
    this.hpS = 0
  }

  tick(x) {
    // input high pass (springs are thin at the bottom)
    const hv = (x - this.hpS) * this.hpG
    const hl = hv + this.hpS
    this.hpS = flush(hl + hv)
    let v = x - hl + this.fb * this.loop[this.li]
    // dispersion cascade, canonical form per section: w = v - a w[n-K]; y = a w + w[n-K]
    const a = this.a
    const K = this.K
    const ring = this.ring
    const ri = this.ri
    const end = this.M * K
    for (let base = 0; base < end; base += K) {
      const old = ring[base + ri]
      const w = v - a * old
      ring[base + ri] = w < 1e-20 && w > -1e-20 ? 0 : w
      v = a * w + old
    }
    this.ri = ri + 1 === K ? 0 : ri + 1
    // loop: lowpass, then into the delay
    const lv = (v - this.lpS) * this.lpG
    const lp = lv + this.lpS
    this.lpS = flush(lp + lv)
    this.loop[this.li] = feedbackSat(lp)
    this.li = this.li + 1 === this.loopLen ? 0 : this.li + 1
    return v
  }

  reset() {
    this.ring.fill(0)
    this.loop.fill(0)
    this.ri = 0
    this.li = 0
    this.lpS = 0
    this.hpS = 0
  }
}

/**
 * Run a streaming kernel over a whole take plus tailSec of silence.
 * kernel.process(ins, outs, n) is the live interface. outCh is the number of
 * output channels. fadeSec fades the very end of the tail (raised cosine).
 * Returns a new buffer { sr, ch }.
 */
export function runKernel(kernel, input, tailSec, outCh, ctx, fadeSec = 0.05) {
  const sr = input.sr
  const n = input.ch && input.ch.length ? input.ch[0].length : 0
  const extra = Math.max(0, Math.round(num(tailSec, 0) * sr))
  const N = n + extra
  const nIn = input.ch.length >= 2 ? 2 : 1
  const ins = new Array(nIn)
  for (let c = 0; c < nIn; c++) {
    const a = new Float32Array(N)
    a.set(input.ch[c])
    sanitize(a)
    ins[c] = a
  }
  const outs = new Array(outCh)
  for (let c = 0; c < outCh; c++) outs[c] = new Float32Array(N)
  const B = 8192
  const progress = ctx && typeof ctx.progress === 'function' ? ctx.progress : null
  const cancelled = ctx && typeof ctx.cancelled === 'function' ? ctx.cancelled : null
  const vin = new Array(nIn)
  const vout = new Array(outCh)
  for (let s = 0; s < N; s += B) {
    const e = Math.min(N, s + B)
    for (let c = 0; c < nIn; c++) vin[c] = ins[c].subarray(s, e)
    for (let c = 0; c < outCh; c++) vout[c] = outs[c].subarray(s, e)
    kernel.process(vin, vout, e - s)
    if (progress && ((s / B) & 7) === 7) progress(e / Math.max(1, N))
    if (cancelled && ((s / B) & 7) === 7 && cancelled()) break
  }
  // fade the end of the tail (never into the take itself)
  const f = Math.min(extra, Math.round(Math.max(0, num(fadeSec, 0)) * sr))
  if (f > 0) {
    for (let c = 0; c < outCh; c++) {
      const o = outs[c]
      for (let k = 0; k < f; k++) o[N - 1 - k] *= 0.5 - 0.5 * Math.cos((Math.PI * (k + 0.5)) / f)
    }
  }
  for (let c = 0; c < outCh; c++) sanitize(outs[c])
  if (progress) progress(1)
  return { sr, ch: outs }
}

/** End fade for a tail: long when the tail was cut at the cap, short otherwise. */
export function tailFade(rawSec) {
  return rawSec === Infinity || rawSec > TAIL_CAP ? 3 : 0.05
}
