// modules/device/_kit.js - shared parts for the device family (telephones,
// radios, records, tapes). This file is NOT a module: it has no default export
// and a registry tool should skip files whose names start with an underscore.
//
// Every device is a streaming "core": a small object that processes one block
// of mono samples in place, with a per-sample talk flag (is somebody keyed up
// or speaking right now?). The SAME core runs offline and live:
// - offline (process), the talk flags come from core/segment.js findPhrases,
//   so key-up clicks, squelch tails, roger beeps and phrase-edge tones land
//   exactly at the phrase edges (and a little before them where the device
//   would sound first, like a space-radio intro tone);
// - live, the flags come from TalkGate, a level gate with hold, and there is
//   no look-ahead, so start sounds land with the first syllable.
// Inside a core, speech always sits at an RMS of about 0.1 (-20 dBFS): the
// wrapper scales the input by 0.1 / speechLevel before the core and back
// after it, so distortion, compression and the noise floors behave the same
// for a quiet phone recording and a loud studio take. The offline speech
// level is the RMS of the loud 20 ms frames; live it is tracked slowly.
//
// Techniques and their published sources:
// - Bq: second-order sections with Robert Bristow-Johnson's "Audio EQ
//   Cookbook" coefficients, Direct Form I in float64, computed without
//   allocation so live set() never makes garbage. Butterworth cascades use
//   the textbook pole-pair Q values.
// - Rand: Marsaglia's xorshift32 ("Xorshift RNGs", J. Stat. Software 2003),
//   seeded from the stage rng, for per-sample noise without method chains.
// - Crackler: Poisson-scheduled clicks (exponential gaps) with exponentially
//   decaying ticks, noise bursts and pops, the streaming twin of
//   core/noise.js crackle.
// - Hum: mains hum as the first harmonics of 60 Hz plus the narrow charging
//   pulses of a rectifier (sin^8, which repeats at 120 Hz and is rich in
//   harmonics), the "buzz" of cheap amplifiers.
// - Wobble: wow, drift and flutter as a modulated delay line (the classic
//   tape-transport model: a delay that moves by A sin(2 pi f t) changes the
//   speed by 2 pi f A / sr), with cubic reads from core/delay.js.
// - RateHold: sample-and-hold rate reduction with optional coders: ITU-T
//   G.711 mu-law (core/shape.js curves, 8-bit), plain linear bits, and the
//   IMA/DVI 4-bit ADPCM of the Interactive Multimedia Association's 1992
//   recommended practice (step and index tables from that document).
// - SpecCodec: a streaming STFT (sqrt-Hann, 50 percent overlap, perfect
//   reconstruction when idle) that imitates low-bit-rate speech coding: band
//   energies quantised on a coarse dB grid, weak bins dropped (the "spectral
//   holes" behind codec swirl and birdies), noise-filled top bands, a
//   minimum-statistics noise floor with over-subtraction (the musical-noise
//   warble of phone noise suppression, after Boll 1979 and Martin 2001) and
//   frame loss concealed by repeating the last frame phase-continued (the
//   robotic burble of a weak cell signal).
// - SmallRoom: a four-line feedback delay network with a Hadamard matrix
//   and damped loops (Jot and Chaigne 1991), after two Schroeder allpass
//   diffusers, for nurseries, living rooms and classrooms in live mode.
// - Squash: a feed-forward log-domain compressor (Giannoulis, Massberg and
//   Reiss 2012) in streaming form, for AGC, station processing and companders;
//   LookSquash adds the usual look-ahead delay (the detector runs a few
//   milliseconds ahead of the gain) so a level control that rose in a pause
//   does not overshoot the next word.
// - Shift: single-sideband frequency shifting with Olli Niemitalo's
//   polyphase IIR Hilbert pair (yehar.com, 2001) and a renormalised rotating
//   phasor, for mistuned sideband radio and stray stations.
// - Tone and Burst: sample-accurate one-shots for beeps, chirps, data bursts,
//   sirens, chimes, key-up clicks and squelch tails.
// - TalkGate: an RMS gate with hysteresis, hold and a slow minimum-tracking
//   noise floor, plus the slow speech level the live wrapper normalises by.

import { DelayLine } from '../../core/delay.js'
import { LFO } from '../../core/lfo.js'
import { FFT } from '../../core/fft.js'
import { findPhrases } from '../../core/segment.js'
import { makeRng } from '../../core/rng.js'
import { bufLen } from '../../core/buf.js'
import { muLaw, muLawInv, crush } from '../../core/shape.js'
import { resolveParams } from '../../core/params.js'

export const BLOCK = 512
const TINY = 1e-20
const TWO_PI = 2 * Math.PI
export const SPEECH = 0.1 // speech RMS inside every core

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

export function db(d) {
  return Math.pow(10, d / 20)
}

/** Percent 0..100 as 0..1. */
export function frac(pct) {
  const v = Number(pct) / 100
  return v > 0 ? (v < 1 ? v : 1) : 0
}

/**
 * Percent to a gain on a log taper: 100 gives maxDb, lower settings fall off
 * by rangeDb across the travel, 0 is silent. maxDb is relative to speech.
 */
export function taper(pct, maxDb, rangeDb = 36) {
  const u = frac(pct)
  return u <= 0 ? 0 : SPEECH * db(maxDb - rangeDb * (1 - u))
}

// ---------------------------------------------------------------- filters

function qq(q) {
  const v = +q
  return v > 0.05 ? (v < 100 ? v : 100) : 0.05
}

/** One biquad section (RBJ cookbook), Direct Form I, float64 state. */
export class Bq {
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
    this.on = false
  }

  _set(b0, b1, b2, a0, a1, a2) {
    const k = 1 / a0
    this.b0 = b0 * k
    this.b1 = b1 * k
    this.b2 = b2 * k
    this.a1 = a1 * k
    this.a2 = a2 * k
    this.on = true
    return this
  }

  _w(f) {
    let v = +f
    if (!(v >= 1)) v = 1
    const hi = this.sr * 0.45
    if (v > hi) v = hi
    return (TWO_PI * v) / this.sr
  }

  /** Pass straight through (and skip the work). */
  off() {
    this.on = false
    return this
  }

  lp(f, q = 0.7071) {
    if (!(f < this.sr * 0.45)) return this.off()
    const w = this._w(f)
    const c = Math.cos(w)
    const a = Math.sin(w) / (2 * qq(q))
    return this._set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + a, -2 * c, 1 - a)
  }

  hp(f, q = 0.7071) {
    const w = this._w(f)
    const c = Math.cos(w)
    const a = Math.sin(w) / (2 * qq(q))
    return this._set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + a, -2 * c, 1 - a)
  }

  /** Band pass with a 0 dB peak. */
  bp(f, q = 1) {
    const w = this._w(f)
    const c = Math.cos(w)
    const a = Math.sin(w) / (2 * qq(q))
    return this._set(a, 0, -a, 1 + a, -2 * c, 1 - a)
  }

  notch(f, q = 1) {
    if (!(f < this.sr * 0.45)) return this.off()
    const w = this._w(f)
    const c = Math.cos(w)
    const a = Math.sin(w) / (2 * qq(q))
    return this._set(1, -2 * c, 1, 1 + a, -2 * c, 1 - a)
  }

  /** Second-order allpass (phase only). */
  ap(f, q = 0.7071) {
    if (!(f < this.sr * 0.45)) return this.off()
    const w = this._w(f)
    const c = Math.cos(w)
    const a = Math.sin(w) / (2 * qq(q))
    return this._set(1 - a, -2 * c, 1 + a, 1 + a, -2 * c, 1 - a)
  }

  peak(f, q, g) {
    if (!(f < this.sr * 0.45) || !g) return this.off()
    const w = this._w(f)
    const c = Math.cos(w)
    const a = Math.sin(w) / (2 * qq(q))
    const A = Math.pow(10, g / 40)
    return this._set(1 + a * A, -2 * c, 1 - a * A, 1 + a / A, -2 * c, 1 - a / A)
  }

  ls(f, q, g) {
    if (!g) return this.off()
    const w = this._w(f)
    const c = Math.cos(w)
    const a = Math.sin(w) / (2 * qq(q))
    const A = Math.pow(10, g / 40)
    const sq = 2 * Math.sqrt(A) * a
    return this._set(
      A * (A + 1 - (A - 1) * c + sq),
      2 * A * (A - 1 - (A + 1) * c),
      A * (A + 1 - (A - 1) * c - sq),
      A + 1 + (A - 1) * c + sq,
      -2 * (A - 1 + (A + 1) * c),
      A + 1 + (A - 1) * c - sq,
    )
  }

  hs(f, q, g) {
    if (!(f < this.sr * 0.45) || !g) return this.off()
    const w = this._w(f)
    const c = Math.cos(w)
    const a = Math.sin(w) / (2 * qq(q))
    const A = Math.pow(10, g / 40)
    const sq = 2 * Math.sqrt(A) * a
    return this._set(
      A * (A + 1 + (A - 1) * c + sq),
      -2 * A * (A - 1 + (A + 1) * c),
      A * (A + 1 + (A - 1) * c - sq),
      A + 1 - (A - 1) * c + sq,
      2 * (A - 1 - (A + 1) * c),
      A + 1 - (A - 1) * c - sq,
    )
  }

  tick(x) {
    if (!this.on) return x
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y < TINY && y > -TINY ? 0 : y
    return this.y1
  }

  run(s, n) {
    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2
    let x1 = this.x1, x2 = this.x2, y1 = this.y1, y2 = this.y2
    for (let i = 0; i < n; i++) {
      const x = s[i]
      let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      if (y < TINY && y > -TINY) y = 0
      x2 = x1
      x1 = x
      y2 = y1
      y1 = y
      s[i] = y
    }
    if (!(y1 < 1e9 && y1 > -1e9) || !(y2 < 1e9 && y2 > -1e9)) x1 = x2 = y1 = y2 = 0
    this.x1 = x1
    this.x2 = x2
    this.y1 = y1
    this.y2 = y2
  }

  reset() {
    this.x1 = this.x2 = this.y1 = this.y2 = 0
  }
}

/** A fixed number of biquads run in order; unused sections stay off. */
export class Bank {
  constructor(sr, count) {
    this.f = new Array(count)
    for (let i = 0; i < count; i++) this.f[i] = new Bq(sr)
    this.count = count
  }

  run(s, n) {
    const f = this.f
    for (let k = 0; k < this.count; k++) if (f[k].on) f[k].run(s, n)
  }

  allOff() {
    for (let k = 0; k < this.count; k++) this.f[k].off()
    return this
  }

  reset() {
    for (let k = 0; k < this.count; k++) this.f[k].reset()
  }
}

const BUTTER_Q = {
  2: [0.7071],
  4: [0.5412, 1.3066],
  6: [0.5176, 0.7071, 1.9319],
  8: [0.5098, 0.6013, 0.9, 2.5629],
}

/** Butterworth lp or hp of order 2/4/6/8 into bank.f[i..]; returns the next index. */
export function butter(bank, i, type, f, order) {
  const qs = BUTTER_Q[order] || BUTTER_Q[2]
  for (let k = 0; k < qs.length; k++) bank.f[i + k][type](f, qs[k])
  return i + qs.length
}

/** One-pole lowpass state helper: coefficient for a cutoff. */
export function onePoleCoef(hz, sr) {
  return 1 - Math.exp((-TWO_PI * clamp(hz, 1, sr * 0.49)) / sr)
}

// ---------------------------------------------------------------- noise

/** Fast seeded white noise (xorshift32), seeded from the stage rng. */
export class Rand {
  constructor(rng, label) {
    const r = rng && typeof rng.fork === 'function' ? rng.fork(label || 'rand') : makeRng(label || 'rand')
    let s = Math.floor(r.next() * 4294967295) | 0
    if (s === 0) s = 0x2545f491
    this.s = s
  }

  u() {
    let x = this.s
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.s = x
    return (x >>> 0) / 4294967296
  }

  w() {
    return this.u() * 2 - 1
  }

  fill(out, n) {
    let x = this.s
    for (let i = 0; i < n; i++) {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      out[i] = ((x >>> 0) / 4294967296) * 2 - 1
    }
    this.s = x
  }
}

/** Poisson clicks, crackle and pops, streaming. Output is unscaled (ticks up to about 1). */
export class Crackler {
  constructor(sr, rand, slots = 16) {
    this.sr = sr
    this.r = rand
    this.ns = slots
    this.amp = new Float64Array(slots)
    this.cf = new Float64Array(slots)
    this.sgn = new Float64Array(slots)
    this.kind = new Uint8Array(slots)
    this.active = 0
    this.rate = 0
    this.popRate = 0
    this.next = -1
    this.nextPop = -1
    this.lnMin = Math.log(0.03)
    this.lnMax = Math.log(1.2)
    this.burstShare = 0.4
    this.lp = 0
  }

  /** rate and popRate in events per second; widths in ms; burstShare 0..1. */
  set(rate, popRate = 0, minMs = 0.03, maxMs = 1.2, burstShare = 0.4) {
    const r = rate > 0 ? rate : 0
    const p = popRate > 0 ? popRate : 0
    if (Math.abs(r - this.rate) > 0.1 * this.rate + 1e-9 || (this.next < 0 && r > 0)) this.next = r > 0 ? this._gap(r) : -1
    if (Math.abs(p - this.popRate) > 0.1 * this.popRate + 1e-9 || (this.nextPop < 0 && p > 0)) this.nextPop = p > 0 ? this._gap(p) : -1
    this.rate = r
    this.popRate = p
    this.lnMin = Math.log(Math.max(0.005, minMs))
    this.lnMax = Math.log(Math.max(minMs, maxMs))
    this.burstShare = clamp(burstShare, 0, 1)
  }

  _gap(rate) {
    return Math.floor((-Math.log(1 - this.r.u() * 0.999999) * this.sr) / rate)
  }

  _spawn(a, wMs, kind) {
    let k = 0
    let low = Infinity
    for (let j = 0; j < this.ns; j++) {
      if (this.amp[j] < low) {
        low = this.amp[j]
        k = j
      }
    }
    this.amp[k] = a
    this.cf[k] = Math.exp(-1000 / (wMs * this.sr))
    this.sgn[k] = this.r.u() < 0.5 ? -1 : 1
    this.kind[k] = kind
    this.active = 1
  }

  render(out, n) {
    const r = this.r
    for (let i = 0; i < n; i++) {
      if (this.next >= 0 && --this.next < 0) {
        const u = r.u()
        const w = Math.exp(this.lnMin + (this.lnMax - this.lnMin) * r.u())
        this._spawn(0.03 + 0.97 * u * u * u, w, r.u() < this.burstShare ? 1 : 0)
        this.next = this._gap(this.rate)
      }
      if (this.nextPop >= 0 && --this.nextPop < 0) {
        this._spawn(0.55 + 0.45 * r.u(), 0.5 + 2.5 * r.u(), 2)
        this.nextPop = this._gap(this.popRate)
      }
      let v = 0
      if (this.active) {
        let any = 0
        for (let k = 0; k < this.ns; k++) {
          const a = this.amp[k]
          if (a > 1e-4) {
            const kd = this.kind[k]
            v += kd === 1 ? a * r.w() : a * this.sgn[k]
            this.amp[k] = a * this.cf[k]
            any = 1
          } else if (a !== 0) this.amp[k] = 0
        }
        this.active = any
      }
      out[i] = v
    }
  }

  reset() {
    this.amp.fill(0)
    this.active = 0
  }
}

/** Mains hum (60 Hz) and rectifier buzz, unit level. */
export class Hum {
  constructor(sr, hz = 60) {
    this.sr = sr
    this.inc = hz / sr
    this.ph = 0
  }

  setHz(hz) {
    this.inc = clamp(hz, 1, this.sr * 0.2) / this.sr
  }

  /** buzz 0..1 blends warm hum toward a hard 120 Hz buzz. */
  render(out, n, buzz) {
    const b = clamp(buzz, 0, 1)
    let ph = this.ph
    const inc = this.inc
    for (let i = 0; i < n; i++) {
      ph += inc
      if (ph >= 1) ph -= 1
      const a = TWO_PI * ph
      const s1 = Math.sin(a)
      const hum = 0.8 * s1 + 0.45 * Math.sin(2 * a) + 0.2 * Math.sin(3 * a)
      let p = s1 * s1
      p *= p
      p *= p
      out[i] = (1 - b) * hum + b * 3.2 * (p - 0.2734375)
    }
    this.ph = ph
  }
}

/**
 * A core/lfo.js LFO evaluated at a control rate (every 32 samples) and
 * linearly interpolated: the same shapes at a fraction of the cost, for
 * modulators below about 100 Hz. Drop-in for LFO.next() and .rate.
 */
export class Ctl {
  constructor(sr, opts) {
    this.lfo = new LFO(sr / 32, opts)
    this.a = this.lfo.next()
    this.b = this.lfo.next()
    this.i = 0
  }

  get rate() {
    return this.lfo.rate
  }

  set rate(hz) {
    this.lfo.rate = hz
  }

  next() {
    const v = this.a + (this.b - this.a) * this.i * 0.03125
    if (++this.i >= 32) {
      this.i = 0
      this.a = this.b
      this.b = this.lfo.next()
    }
    return v
  }
}

// ---------------------------------------------------------------- transport

/** Wow, drift and flutter as a modulated delay. latency = base delay in samples. */
export class Wobble {
  constructor(sr, maxMs, rng, label = 'wobble') {
    this.sr = sr
    this.base = Math.max(4, Math.round(maxMs * 0.001 * sr))
    this.dl = new DelayLine(2 * this.base + 8)
    const r = rng && typeof rng.fork === 'function' ? rng : makeRng(label)
    this.wow = new Ctl(sr, { shape: 'sine', rate: 0.5, rng: r.fork(label + 'w') })
    this.drift = new Ctl(sr, { shape: 'smooth', rate: 0.3, rng: r.fork(label + 'd') })
    this.flut = new Ctl(sr, { shape: 'sine', rate: 9, rng: r.fork(label + 'f') })
    this.flutR = new Ctl(sr, { shape: 'smooth', rate: 25, rng: r.fork(label + 'r') })
    this.tw = 0
    this.td = 0
    this.tf = 0
    this.tr = 0
    this.aw = 0
    this.ad = 0
    this.af = 0
    this.ar = 0
    this.k = 1 - Math.exp(-1 / (0.05 * sr))
  }

  get latency() {
    return this.base
  }

  /**
   * Depths are peak speed deviations as fractions (0.003 = 0.3 percent).
   * wow: periodic (once per turn), drift: slow random, flutter: fast
   * periodic, rough: fast random.
   */
  set(wow, wowHz, drift, driftHz, flutter, flutterHz, rough = 0, roughHz = 25) {
    const sr = this.sr
    this.wow.rate = clamp(wowHz, 0.05, 40)
    this.drift.rate = clamp(driftHz, 0.02, 40)
    this.flut.rate = clamp(flutterHz, 0.5, 80)
    this.flutR.rate = clamp(roughHz, 1, 120)
    let tw = (Math.max(0, wow) * sr) / (TWO_PI * this.wow.rate)
    let td = (Math.max(0, drift) * sr) / (Math.PI * this.drift.rate)
    let tf = (Math.max(0, flutter) * sr) / (TWO_PI * this.flut.rate)
    let tr = (Math.max(0, rough) * sr) / (Math.PI * this.flutR.rate)
    const tot = tw + td + tf + tr
    const lim = this.base - 3
    if (tot > lim) {
      const k = lim / tot
      tw *= k
      td *= k
      tf *= k
      tr *= k
    }
    this.tw = tw
    this.td = td
    this.tf = tf
    this.tr = tr
  }

  /** Jump the smoothed depths to their targets (offline start). */
  settle() {
    this.aw = this.tw
    this.ad = this.td
    this.af = this.tf
    this.ar = this.tr
  }

  /** extra: optional per-sample additional delay offset in samples (Float32Array) or null. */
  run(s, n, extra) {
    const dl = this.dl
    const k = this.k
    const base = this.base
    const lim = base - 1
    for (let i = 0; i < n; i++) {
      this.aw += (this.tw - this.aw) * k
      this.ad += (this.td - this.ad) * k
      this.af += (this.tf - this.af) * k
      this.ar += (this.tr - this.ar) * k
      dl.write(s[i])
      let m = this.aw * this.wow.next() + this.ad * this.drift.next() + this.af * this.flut.next() + this.ar * this.flutR.next()
      if (extra) m += extra[i]
      if (m > lim) m = lim
      else if (m < -lim) m = -lim
      s[i] = dl.read(base + m)
    }
  }

  reset() {
    this.dl.clear()
  }
}

// ---------------------------------------------------------------- coders

const IMA_STEP = new Int32Array([
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
  118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
  6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
])
const IMA_IDX = new Int32Array([-1, -1, -1, -1, 2, 4, 6, 8])

/**
 * Sample-and-hold rate reduction plus an optional coder.
 * mode: 0 none, 1 mu-law 8 bit, 2 linear `bits`, 3 IMA ADPCM 4 bit.
 */
export class RateHold {
  constructor(sr) {
    this.sr = sr
    this.inc = 1
    this.ph = 1
    this.held = 0
    this.mode = 0
    this.bits = 16
    this.gain = 1
    this.pred = 0
    this.idx = 0
  }

  /** rate in Hz (>= sr means every sample), gain: level into the coder (headroom). */
  set(rate, mode = 0, bits = 16, gain = 1) {
    this.inc = rate >= this.sr ? 1 : Math.max(0.001, rate / this.sr)
    this.mode = mode | 0
    this.bits = clamp(bits, 1, 24)
    this.gain = gain > 0 ? gain : 1
  }

  _code(x) {
    const g = this.gain
    const v = x * g
    switch (this.mode) {
      case 1:
        return muLawInv(crush(muLaw(v), 8)) / g
      case 2:
        return crush(v, this.bits) / g
      case 3: {
        let s = Math.round(v * 32767)
        if (s > 32767) s = 32767
        else if (s < -32768) s = -32768
        let diff = s - this.pred
        let code = 0
        if (diff < 0) {
          code = 8
          diff = -diff
        }
        let step = IMA_STEP[this.idx]
        let vp = step >> 3
        if (diff >= step) {
          code |= 4
          diff -= step
          vp += step
        }
        step >>= 1
        if (diff >= step) {
          code |= 2
          diff -= step
          vp += step
        }
        step >>= 1
        if (diff >= step) {
          code |= 1
          vp += step
        }
        let p = code & 8 ? this.pred - vp : this.pred + vp
        if (p > 32767) p = 32767
        else if (p < -32768) p = -32768
        this.pred = p
        let ix = this.idx + IMA_IDX[code & 7]
        if (ix < 0) ix = 0
        else if (ix > 88) ix = 88
        this.idx = ix
        return p / 32768 / g
      }
    }
    return x
  }

  run(s, n) {
    if (this.inc >= 1 && this.mode === 0) return
    let ph = this.ph
    const inc = this.inc
    for (let i = 0; i < n; i++) {
      ph += inc
      if (ph >= 1) {
        ph -= 1
        this.held = this._code(s[i])
      }
      s[i] = this.held
    }
    this.ph = ph
  }

  reset() {
    this.ph = 1
    this.held = 0
    this.pred = 0
    this.idx = 0
  }
}

// Bark-like band edges (Hz) for the codec.
const CODEC_EDGES = [0, 100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480, 1720, 2000, 2320, 2700, 3150, 3700, 4400, 5300, 6400, 7700, 9500, 12000, 15500, 30000]

/** STFT frame length used by SpecCodec at a rate (its latency in samples). */
export function codecSize(sr) {
  let N = 16
  while (N < sr * 0.016) N <<= 1
  return N
}

/** Streaming low-bit-rate speech coder imitation. latency = frame length. */
export class SpecCodec {
  constructor(sr, rand) {
    const N = codecSize(sr)
    this.sr = sr
    this.N = N
    this.hop = N >> 1
    this.fft = new FFT(N)
    this.win = new Float64Array(N)
    for (let i = 0; i < N; i++) this.win[i] = Math.sin((Math.PI * i) / N)
    this.inF = new Float64Array(N)
    this.outF = new Float64Array(N)
    this.re = new Float64Array(N)
    this.im = new Float64Array(N)
    this.pre = new Float64Array(N)
    this.pim = new Float64Array(N)
    const half = N >> 1
    const binHz = sr / N
    const e = []
    for (let b = 0; b < CODEC_EDGES.length; b++) {
      let k = Math.round(CODEC_EDGES[b] / binHz)
      if (k > half + 1) k = half + 1
      if (!e.length || k > e[e.length - 1]) e.push(k)
    }
    if (e[e.length - 1] < half + 1) e.push(half + 1)
    this.edges = Int32Array.from(e)
    this.nb = this.edges.length - 1
    this.floor = new Float64Array(this.nb).fill(1e-6)
    this.r = rand
    this.cnt = 0
    this.active = false
    this.fc = 3400
    this.q = 0
    this.holes = 0
    this.fillFrom = 1e9
    this.ns = 0
    this.nsFloor = 0.1
    this.lossRate = 0
    this.lossLeft = 0
    this.lossCount = 0
    this.gate = 0
    this.gateRef = 0
    this.hoarse = 0
  }

  get latency() {
    return this.N
  }

  /**
   * q 0..1 envelope coarseness, holes 0..1 (share of each band's peak below
   * which bins vanish), fillHz: bands above are noise filled, ns 0..1 noise
   * suppression, loss: lost frames per second (bursts of 1-3), gate 0..1
   * squashes frames far below the running speech level, hoarse 0..1: bins
   * weaker than that share of their band's peak lose their phase (the rough,
   * hoarse texture of a coarsely coded residual between the harmonics).
   */
  set(active, fc, q, holes, fillHz, ns, loss, gate = 0, hoarse = 0) {
    this.active = !!active
    this.fc = clamp(fc, 200, this.sr * 0.5)
    this.q = clamp(q, 0, 1)
    this.holes = clamp(holes, 0, 0.9)
    this.fillFrom = fillHz > 0 ? fillHz : 1e9
    this.ns = clamp(ns, 0, 1)
    this.lossRate = Math.max(0, loss)
    this.gate = clamp(gate, 0, 1)
    this.hoarse = clamp(hoarse, 0, 0.95)
  }

  run(s, n) {
    const hop = this.hop
    const inF = this.inF
    const outF = this.outF
    let cnt = this.cnt
    for (let i = 0; i < n; i++) {
      inF[hop + cnt] = s[i]
      s[i] = outF[cnt]
      if (++cnt === hop) {
        cnt = 0
        this._frame()
      }
    }
    this.cnt = cnt
  }

  _frame() {
    const N = this.N
    const hop = this.hop
    const re = this.re
    const im = this.im
    const win = this.win
    const inF = this.inF
    for (let i = 0; i < N; i++) {
      re[i] = inF[i] * win[i]
      im[i] = 0
    }
    if (this.active) {
      this.fft.forward(re, im)
      this._code()
      this.fft.inverse(re, im)
    }
    const outF = this.outF
    outF.copyWithin(0, hop)
    outF.fill(0, N - hop)
    for (let i = 0; i < N; i++) {
      const v = re[i] * win[i]
      outF[i] += v === v ? v : 0
    }
    inF.copyWithin(0, hop)
  }

  _code() {
    const N = this.N
    const half = N >> 1
    const re = this.re
    const im = this.im
    const r = this.r
    const binHz = this.sr / N
    const kMax = Math.min(half, Math.floor(this.fc / binHz))
    // Frame loss: repeat the last frame, phase-continued, fading.
    let lost = false
    if (this.lossLeft > 0) {
      lost = true
      this.lossLeft--
    } else if (this.lossRate > 0 && r.u() < (this.lossRate * this.hop) / this.sr) {
      lost = true
      this.lossLeft = Math.floor(r.u() * 3)
    }
    if (lost) {
      this.lossCount++
      const fadeK = Math.pow(0.72, this.lossCount)
      for (let k = 0; k <= half; k++) {
        const sg = k & 1 ? -fadeK : fadeK
        re[k] = this.pre[k] * sg
        im[k] = this.pim[k] * sg
      }
    } else {
      this.lossCount = 0
      const step = 1.5 + 7 * this.q
      const holes2 = this.holes * this.holes
      const hoarse2 = this.hoarse * this.hoarse
      const ns = this.ns
      let total = 0
      for (let b = 0; b < this.nb; b++) {
        const k0 = this.edges[b]
        const k1 = Math.min(this.edges[b + 1], kMax + 1)
        if (k1 <= k0) continue
        let E = 0
        let mx = 0
        for (let k = k0; k < k1; k++) {
          const p = re[k] * re[k] + im[k] * im[k]
          E += p
          if (p > mx) mx = p
        }
        total += E
        if (!(E > 1e-14)) continue
        let g = 1
        if (this.q > 0) {
          const d = 10 * Math.log10(E)
          const dq = Math.round(d / step) * step
          g *= Math.pow(10, (dq - d) / 20)
        }
        if (ns > 0) {
          const per = E / (k1 - k0)
          let fl = this.floor[b]
          fl = per < fl ? per : fl * 1.035
          if (fl < 1e-12) fl = 1e-12
          this.floor[b] = fl
          const gn = 1 - (ns * 3 * fl) / per
          g *= gn > 0.06 ? gn : 0.06 * (1 - ns) + 0.004
        }
        const thr = mx * holes2
        const hthr = mx * hoarse2
        const fill = k0 * binHz >= this.fillFrom
        for (let k = k0; k < k1; k++) {
          const p = re[k] * re[k] + im[k] * im[k]
          if (p < thr) {
            re[k] = 0
            im[k] = 0
          } else if (fill || p < hthr) {
            const m = Math.sqrt(p) * g
            const a = TWO_PI * r.u()
            re[k] = m * Math.cos(a)
            im[k] = m * Math.sin(a)
          } else {
            re[k] *= g
            im[k] *= g
          }
        }
      }
      if (this.gate > 0) {
        // frames far below the speech level are pushed down (voice activity)
        const lvl = total
        this.gateRef = this.gateRef ? this.gateRef + (Math.max(lvl, this.gateRef * 0.5) - this.gateRef) * (lvl > this.gateRef ? 0.05 : 0.002) : lvl
        if (lvl < this.gateRef * 0.003) {
          const k = 1 - 0.9 * this.gate
          for (let i = 0; i <= half; i++) {
            re[i] *= k
            im[i] *= k
          }
        }
      }
    }
    for (let k = kMax + 1; k <= half; k++) {
      re[k] = 0
      im[k] = 0
    }
    re[0] = 0
    im[0] = 0
    im[half] = 0
    for (let k = 0; k <= half; k++) {
      this.pre[k] = re[k]
      this.pim[k] = im[k]
    }
    for (let k = 1; k < half; k++) {
      re[N - k] = re[k]
      im[N - k] = -im[k]
    }
  }

  reset() {
    this.inF.fill(0)
    this.outF.fill(0)
    this.pre.fill(0)
    this.pim.fill(0)
    this.cnt = 0
    this.lossLeft = 0
    this.lossCount = 0
  }
}

// ---------------------------------------------------------------- spaces

/** Four-line FDN room, mono in and out. */
export class SmallRoom {
  constructor(sr, maxScale = 2.5) {
    this.sr = sr
    this.maxScale = maxScale
    const base = [8.1, 11.7, 14.3, 18.9]
    this.baseMs = base
    let maxLen = 0
    for (let i = 0; i < 4; i++) maxLen = Math.max(maxLen, Math.ceil((base[i] * maxScale * sr) / 1000) + 4)
    let size = 4
    while (size < maxLen + 2) size <<= 1
    this.size = size
    this.mask = size - 1
    this.buf = [new Float32Array(size), new Float32Array(size), new Float32Array(size), new Float32Array(size)]
    this.d = new Int32Array(4)
    this.g = new Float64Array(4)
    this.lp = new Float64Array(4)
    this.w = 0
    // two input diffusers
    let asz = 4
    while (asz < Math.ceil(0.012 * maxScale * sr) + 4) asz <<= 1
    this.apBuf = [new Float32Array(asz), new Float32Array(asz)]
    this.apMask = asz - 1
    this.apD = new Int32Array(2)
    this.apW = 0
    this.a = 0.5
    this.set(0.5, 0.5, 0.5)
  }

  /** size 0..1, rt60 seconds, damp 0..1. */
  set(size, rt60, damp) {
    const sr = this.sr
    const sc = 0.35 + (this.maxScale - 0.35) * clamp(size, 0, 1)
    const rt = clamp(rt60, 0.05, 8)
    for (let i = 0; i < 4; i++) {
      const d = Math.max(2, Math.min(this.size - 2, Math.round((this.baseMs[i] * sc * sr) / 1000)))
      this.d[i] = d
      this.g[i] = Math.pow(10, (-3 * d) / (rt * sr))
    }
    this.apD[0] = Math.max(1, Math.min(this.apMask - 1, Math.round(0.0053 * sc * sr)))
    this.apD[1] = Math.max(1, Math.min(this.apMask - 1, Math.round(0.0017 * sc * sr)))
    this.a = onePoleCoef(9000 - 7000 * clamp(damp, 0, 1), sr)
  }

  run(s, n, wet, dry) {
    const b0 = this.buf[0], b1 = this.buf[1], b2 = this.buf[2], b3 = this.buf[3]
    const m = this.mask
    const d = this.d
    const g = this.g
    const lp = this.lp
    const a = this.a
    const ap0 = this.apBuf[0], ap1 = this.apBuf[1]
    const am = this.apMask
    const ad0 = this.apD[0], ad1 = this.apD[1]
    let w = this.w
    let aw = this.apW
    let l0 = lp[0], l1 = lp[1], l2 = lp[2], l3 = lp[3]
    for (let i = 0; i < n; i++) {
      const x = s[i]
      // diffusers (Schroeder allpass, g = 0.6)
      let v = x
      let z = ap0[(aw - ad0) & am]
      let u = v + 0.6 * z
      if (u < TINY && u > -TINY) u = 0
      ap0[aw] = u
      v = z - 0.6 * u
      z = ap1[(aw - ad1) & am]
      u = v + 0.6 * z
      if (u < TINY && u > -TINY) u = 0
      ap1[aw] = u
      v = z - 0.6 * u
      aw = (aw + 1) & am
      const o0 = b0[(w - d[0]) & m]
      const o1 = b1[(w - d[1]) & m]
      const o2 = b2[(w - d[2]) & m]
      const o3 = b3[(w - d[3]) & m]
      l0 += (o0 - l0) * a
      l1 += (o1 - l1) * a
      l2 += (o2 - l2) * a
      l3 += (o3 - l3) * a
      if (l0 < TINY && l0 > -TINY) l0 = 0
      if (l1 < TINY && l1 > -TINY) l1 = 0
      if (l2 < TINY && l2 > -TINY) l2 = 0
      if (l3 < TINY && l3 > -TINY) l3 = 0
      const h0 = 0.5 * (l0 + l1 + l2 + l3)
      const h1 = 0.5 * (l0 - l1 + l2 - l3)
      const h2 = 0.5 * (l0 + l1 - l2 - l3)
      const h3 = 0.5 * (l0 - l1 - l2 + l3)
      const v0 = v < TINY && v > -TINY ? 0 : v
      b0[w] = v0 + g[0] * h0
      b1[w] = v0 + g[1] * h1
      b2[w] = v0 + g[2] * h2
      b3[w] = v0 + g[3] * h3
      w = (w + 1) & m
      const y = 0.5 * (o0 - o1 + o2 - o3)
      s[i] = dry * x + wet * y
    }
    lp[0] = l0
    lp[1] = l1
    lp[2] = l2
    lp[3] = l3
    this.w = w
    this.apW = aw
  }

  reset() {
    for (let i = 0; i < 4; i++) this.buf[i].fill(0)
    this.apBuf[0].fill(0)
    this.apBuf[1].fill(0)
    this.lp.fill(0)
  }
}

// ---------------------------------------------------------------- dynamics

/** Streaming feed-forward compressor with static ratio (log domain). */
export class Squash {
  constructor(sr) {
    this.sr = sr
    this.env = 0
    this.thr = -20
    this.slope = 0
    this.ca = 0
    this.cr = 0
    this.mk = 1
    this.knee = 6
    this.set(-20, 1, 5, 100, 0)
  }

  set(thresholdDb, ratio, attackMs, releaseMs, makeupDb = 0, kneeDb = 6) {
    this.thr = thresholdDb
    const R = ratio >= 1 ? ratio : 1
    this.slope = 1 - 1 / R
    this.ca = Math.exp(-1000 / (Math.max(0.05, attackMs) * this.sr))
    this.cr = Math.exp(-1000 / (Math.max(1, releaseMs) * this.sr))
    this.mk = db(makeupDb)
    this.knee = Math.max(0.1, kneeDb)
  }

  /** Compress s in place; the gain reduction is smoothed in dB. */
  run(s, n) {
    let env = this.env
    const thr = this.thr
    const sl = this.slope
    const ca = this.ca
    const cr = this.cr
    const kn = this.knee
    const mk = this.mk
    if (sl <= 0) {
      if (mk !== 1) for (let i = 0; i < n; i++) s[i] *= mk
      return
    }
    for (let i = 0; i < n; i++) {
      const x = s[i]
      const a = x < 0 ? -x : x
      const l = a > 1e-6 ? 8.685889638 * Math.log(a) : -120
      const over = l - thr
      let want = 0
      if (over > kn / 2) want = sl * over
      else if (over > -kn / 2) {
        const t = over + kn / 2
        want = (sl * t * t) / (2 * kn)
      }
      env = want > env ? want + ca * (env - want) : want + cr * (env - want)
      if (env < 1e-9) env = 0
      s[i] = x * mk * Math.exp(-0.115129255 * env)
    }
    this.env = env
  }

  reset() {
    this.env = 0
  }
}

/**
 * Squash with look-ahead: the level detector hears the signal aheadMs before
 * it is turned down, so gain that rose during a pause (an automatic level
 * control lifting the room noise) is already back down when the next word
 * arrives. Without it the first few milliseconds of every word after a pause
 * overshoot by the whole makeup gain. Keep attackMs at a quarter of aheadMs
 * or less. The signal path is delayed by `latency` samples.
 */
export class LookSquash extends Squash {
  constructor(sr, aheadMs = 5) {
    super(sr)
    this.L = Math.max(1, Math.round(aheadMs * 0.001 * sr))
    this.buf = new Float32Array(this.L)
    this.w = 0
    // the detector: instant peak with a 20 ms fall, so the gain computer sees
    // the waveform's crest, not every zero crossing (a plain |x| detector
    // only pushes the gain down near each crest, which slows the attack)
    this.pk = 0
    this.pkFall = Math.exp(-1 / (0.02 * sr))
  }

  get latency() {
    return this.L
  }

  run(s, n) {
    const buf = this.buf
    const L = this.L
    let w = this.w
    let env = this.env
    let pk = this.pk
    const fall = this.pkFall
    const thr = this.thr
    const sl = this.slope
    const ca = this.ca
    const cr = this.cr
    const kn = this.knee
    const mk = this.mk
    for (let i = 0; i < n; i++) {
      const x = s[i]
      const late = buf[w]
      buf[w] = x
      if (++w >= L) w = 0
      if (sl <= 0) {
        s[i] = late * mk
        continue
      }
      const ax = x < 0 ? -x : x
      pk = ax > pk ? ax : pk * fall
      if (pk < 1e-9) pk = 0
      const a = pk
      const l = a > 1e-6 ? 8.685889638 * Math.log(a) : -120
      const over = l - thr
      let want = 0
      if (over > kn / 2) want = sl * over
      else if (over > -kn / 2) {
        const t = over + kn / 2
        want = (sl * t * t) / (2 * kn)
      }
      env = want > env ? want + ca * (env - want) : want + cr * (env - want)
      if (env < 1e-9) env = 0
      s[i] = late * mk * Math.exp(-0.115129255 * env)
    }
    this.env = env
    this.pk = pk
    this.w = w
  }

  reset() {
    this.env = 0
    this.pk = 0
    this.buf.fill(0)
    this.w = 0
  }
}

/**
 * Syllabic compander half (the 2:1 / 1:2 pair of analog radio links and
 * cordless phones): compress (mode +1) or expand (mode -1) around a
 * reference level, with its own detector timing, so noise added between
 * the two halves "breathes" with the voice.
 */
export class Compander {
  constructor(sr) {
    this.sr = sr
    this.env = SPEECH
    this.ratio = 2
    this.ref = SPEECH
    this.range = 30
    this.ca = 0
    this.cr = 0
    this.mode = 1
    this.set(2, SPEECH, 5, 60, 30, 1)
  }

  set(ratio, refLin, attackMs, releaseMs, rangeDb, mode) {
    this.ratio = Math.max(1, ratio)
    this.ref = Math.max(1e-4, refLin)
    this.ca = Math.exp(-1000 / (Math.max(0.1, attackMs) * this.sr))
    this.cr = Math.exp(-1000 / (Math.max(1, releaseMs) * this.sr))
    this.range = Math.max(0, rangeDb)
    this.mode = mode < 0 ? -1 : 1
  }

  run(s, n) {
    let env = this.env
    const ca = this.ca
    const cr = this.cr
    const lref = Math.log(this.ref)
    const k = this.mode > 0 ? 1 / this.ratio - 1 : this.ratio - 1
    const lim = this.range * 0.115129255
    for (let i = 0; i < n; i++) {
      const x = s[i]
      const a = (x < 0 ? -x : x) * 1.4142
      env = a > env ? a + ca * (env - a) : a + cr * (env - a)
      if (env < 1e-7) env = 1e-7
      let gl = k * (Math.log(env) - lref)
      if (gl > lim) gl = lim
      else if (gl < -lim) gl = -lim
      s[i] = x * Math.exp(gl)
    }
    this.env = env
  }

  reset() {
    this.env = this.ref
  }
}

/** Random events as a smooth 0..1 envelope (static swishes, dropouts, fades, crashes). */
export class Swell {
  constructor(sr, rand) {
    this.sr = sr
    this.r = rand
    this.rate = 0
    this.next = -1
    this.t = 0
    this.a = 1
    this.h = 0
    this.rl = 1
    this.depth = 0
    this.on = false
    this.aMs = 20
    this.hMs = 100
    this.rMs = 100
    this.jit = 0.6
    this.dMin = 0.5
  }

  set(rate, attackMs, holdMs, releaseMs, jitter = 0.6, depthMin = 0.5) {
    const r = rate > 0 ? rate : 0
    if (Math.abs(r - this.rate) > 0.1 * this.rate + 1e-9 || (this.next < 0 && r > 0)) this.next = r > 0 ? this._gap(r) : -1
    this.rate = r
    this.aMs = attackMs
    this.hMs = holdMs
    this.rMs = releaseMs
    this.jit = clamp(jitter, 0, 1)
    this.dMin = clamp(depthMin, 0, 1)
  }

  _gap(rate) {
    return Math.floor((-Math.log(1 - this.r.u() * 0.999999) * this.sr) / rate)
  }

  /** Start one event now (after wait samples), regardless of the schedule. */
  fire(depth = 1) {
    this._start(depth)
  }

  _start(depth) {
    const r = this.r
    const jt = this.jit
    const sr = this.sr / 1000
    this.a = Math.max(1, Math.round(this.aMs * (1 + jt * (r.u() * 2 - 1)) * sr))
    this.h = Math.max(0, Math.round(this.hMs * (1 + jt * (r.u() * 2 - 1)) * sr))
    this.rl = Math.max(1, Math.round(this.rMs * (1 + jt * (r.u() * 2 - 1)) * sr))
    this.depth = depth
    this.t = 0
    this.on = true
  }

  render(out, n) {
    for (let i = 0; i < n; i++) {
      if (this.next >= 0 && --this.next < 0) {
        if (!this.on) this._start(this.dMin + (1 - this.dMin) * this.r.u())
        this.next = this._gap(this.rate)
      }
      let e = 0
      if (this.on) {
        const t = this.t
        if (t < this.a) e = 0.5 - 0.5 * Math.cos((Math.PI * t) / this.a)
        else if (t < this.a + this.h) e = 1
        else if (t < this.a + this.h + this.rl) e = 0.5 + 0.5 * Math.cos((Math.PI * (t - this.a - this.h)) / this.rl)
        else {
          this.on = false
          e = 0
        }
        e *= this.depth
        this.t++
      }
      out[i] = e
    }
  }

  reset() {
    this.on = false
  }
}

// ---------------------------------------------------------------- frequency shift

const HA = [0.6923878, 0.9360654322959, 0.988229522686, 0.9987488452737].map((a) => a * a)
const HB = [0.4021921162426, 0.856171088242, 0.9722909545651, 0.9952884791278].map((a) => a * a)

/** Single-sideband frequency shifter (Bode method), streaming. */
export class Shift {
  constructor(sr) {
    this.sr = sr
    this.sa = new Float64Array(16)
    this.sb = new Float64Array(16)
    this.dly = 0
    this.c = 1
    this.s = 0
    this.cd = 1
    this.sd = 0
    this.hz = 0
  }

  set(hz) {
    const h = clamp(Number(hz) || 0, -this.sr * 0.25, this.sr * 0.25)
    this.hz = h
    const w = (TWO_PI * h) / this.sr
    this.cd = Math.cos(w)
    this.sd = Math.sin(w)
  }

  /** In place: s = shifted s. */
  run(s, n) {
    const sa = this.sa
    const sb = this.sb
    let c = this.c
    let sn = this.s
    const cd = this.cd
    const sd = this.sd
    for (let i = 0; i < n; i++) {
      const x = s[i]
      let a = x
      let b = x
      for (let k = 0; k < 4; k++) {
        const j = 4 * k
        let ya = HA[k] * (a + sa[j + 3]) - sa[j + 1]
        if (ya < TINY && ya > -TINY) ya = 0
        sa[j + 1] = sa[j]
        sa[j] = a
        sa[j + 3] = sa[j + 2]
        sa[j + 2] = ya
        a = ya
        let yb = HB[k] * (b + sb[j + 3]) - sb[j + 1]
        if (yb < TINY && yb > -TINY) yb = 0
        sb[j + 1] = sb[j]
        sb[j] = b
        sb[j + 3] = sb[j + 2]
        sb[j + 2] = yb
        b = yb
      }
      // chain A, one sample late, lags chain B by 90 degrees
      const re = b
      const im = this.dly
      this.dly = a
      s[i] = re * c - im * sn
      const nc = c * cd - sn * sd
      const ns = sn * cd + c * sd
      const kk = 1.5 - 0.5 * (nc * nc + ns * ns)
      c = nc * kk
      sn = ns * kk
    }
    this.c = c
    this.s = sn
  }

  reset() {
    this.sa.fill(0)
    this.sb.fill(0)
    this.dly = 0
  }
}

// ---------------------------------------------------------------- one-shots

/** Sequenced beeps: up to 12 segments, each a sweep with its own wave. */
export class Tone {
  constructor(sr, rand, maxSeg = 12) {
    this.sr = sr
    this.r = rand
    this.max = maxSeg
    this.f0 = new Float64Array(maxSeg)
    this.f1 = new Float64Array(maxSeg)
    this.len = new Int32Array(maxSeg)
    this.amp = new Float64Array(maxSeg)
    this.wave = new Uint8Array(maxSeg)
    this.nseg = 0
    this.seg = -1
    this.t = 0
    this.ph = 0
    this.wait = 0
    this.fsk = 0
    this.fskLeft = 0
  }

  clear() {
    this.nseg = 0
    return this
  }

  /**
   * Add a segment. wave: 0 sine, 1 soft square, 2 bell (struck, decaying),
   * 3 data (random switching between f0 and f1 at 1200 symbols a second).
   */
  add(f0, f1, ms, amp, wave = 0) {
    if (this.nseg >= this.max) return this
    const k = this.nseg++
    this.f0[k] = f0
    this.f1[k] = f1
    this.len[k] = Math.max(1, Math.round((ms * this.sr) / 1000))
    this.amp[k] = amp
    this.wave[k] = wave
    return this
  }

  /** Start the sequence after `wait` samples. */
  start(wait = 0) {
    if (!this.nseg) return
    this.seg = 0
    this.t = 0
    this.wait = Math.max(0, wait | 0)
  }

  get busy() {
    return this.seg >= 0
  }

  /** Total length of the loaded sequence in samples. */
  get length() {
    let L = 0
    for (let k = 0; k < this.nseg; k++) L += this.len[k]
    return L
  }

  stop() {
    this.seg = -1
  }

  /** Adds into out. */
  render(out, n, gain = 1) {
    if (this.seg < 0) return
    const sr = this.sr
    const ramp = Math.max(1, Math.round(0.003 * sr))
    for (let i = 0; i < n; i++) {
      if (this.wait > 0) {
        this.wait--
        continue
      }
      const k = this.seg
      const L = this.len[k]
      const t = this.t
      const x = t / L
      let f = this.f0[k] + (this.f1[k] - this.f0[k]) * x
      const wv = this.wave[k]
      if (wv === 3) {
        if (--this.fskLeft <= 0) {
          this.fsk = this.r.u() < 0.5 ? 0 : 1
          this.fskLeft = Math.max(1, Math.round(sr / 1200))
        }
        f = this.fsk ? this.f1[k] : this.f0[k]
      }
      this.ph += f / sr
      if (this.ph >= 1) this.ph -= Math.floor(this.ph)
      const a = TWO_PI * this.ph
      let v
      if (wv === 1) v = Math.tanh(3 * Math.sin(a)) * 0.8
      else if (wv === 2) {
        const tt = t / sr
        v = Math.sin(a) * Math.exp(-tt * 2.2) + 0.25 * Math.sin(a * 2.76) * Math.exp(-tt * 9) + 0.12 * Math.sin(a * 5.4) * Math.exp(-tt * 18)
      } else v = Math.sin(a)
      let e = 1
      if (wv !== 2 && t < ramp) e = 0.5 - 0.5 * Math.cos((Math.PI * t) / ramp)
      if (t > L - ramp) e *= 0.5 - 0.5 * Math.cos((Math.PI * (L - t)) / ramp)
      out[i] += v * e * this.amp[k] * gain
      if (++this.t >= L) {
        this.t = 0
        if (++this.seg >= this.nseg) {
          this.seg = -1
          return
        }
      }
    }
  }
}

/** A noise burst with attack, hold (with a rough flutter) and release. Adds into out. */
export class Burst {
  constructor(sr, rand) {
    this.sr = sr
    this.r = rand
    this.left = 0
    this.wait = 0
    this.t = 0
    this.a = 1
    this.h = 1
    this.rl = 1
    this.amp = 0
    this.rough = 0.3
    this.f = new Bq(sr)
    this.f2 = new Bq(sr)
    this.lp = 0
    this.flut = 1
  }

  /** Shape the burst colour: high pass and low pass corners in Hz (0 = none). */
  color(hpHz, lpHz) {
    if (hpHz > 0) this.f.hp(hpHz, 0.7071)
    else this.f.off()
    if (lpHz > 0) this.f2.lp(lpHz, 0.7071)
    else this.f2.off()
    return this
  }

  trigger(wait, attackMs, holdMs, releaseMs, amp, rough = 0.3) {
    const sr = this.sr
    this.wait = Math.max(0, wait | 0)
    this.a = Math.max(1, Math.round((attackMs * sr) / 1000))
    this.h = Math.max(0, Math.round((holdMs * sr) / 1000))
    this.rl = Math.max(1, Math.round((releaseMs * sr) / 1000))
    this.t = 0
    this.left = this.a + this.h + this.rl
    this.amp = amp
    this.rough = clamp(rough, 0, 1)
  }

  get busy() {
    return this.left > 0
  }

  render(out, n) {
    if (this.left <= 0) return
    const r = this.r
    const f = this.f
    const f2 = this.f2
    const fl = 1 - Math.exp(-1 / (0.004 * this.sr))
    for (let i = 0; i < n; i++) {
      if (this.wait > 0) {
        this.wait--
        continue
      }
      if (this.left <= 0) break
      const t = this.t
      let e
      if (t < this.a) e = 0.5 - 0.5 * Math.cos((Math.PI * t) / this.a)
      else if (t < this.a + this.h) e = 1
      else e = 0.5 + 0.5 * Math.cos((Math.PI * (t - this.a - this.h)) / this.rl)
      this.flut += (1 - this.rough + this.rough * r.u() * 1.6 - this.flut) * fl
      let v = r.w()
      if (f.on) v = f.tick(v)
      if (f2.on) v = f2.tick(v)
      out[i] += v * e * this.amp * this.flut
      this.t++
      this.left--
    }
  }

  stop() {
    this.left = 0
  }
}

// ---------------------------------------------------------------- talk detection

/** Live talk gate and slow speech level for the live wrapper. */
export class TalkGate {
  constructor(sr, holdMs = 400) {
    this.sr = sr
    this.c20 = 1 - Math.exp(-1 / (0.02 * sr))
    this.cUp = 1 - Math.exp(-1 / (1.0 * sr))
    this.cDn = 1 - Math.exp(-1 / (8 * sr))
    this.fUp = 1 - Math.exp(-1 / (4 * sr))
    this.fDn = 1 - Math.exp(-1 / (0.3 * sr))
    this.holdN = Math.round((holdMs * sr) / 1000)
    this.reset()
  }

  setHold(ms) {
    this.holdN = Math.round((Math.max(0, ms) * this.sr) / 1000)
  }

  reset() {
    this.ms = 0
    this.peak = 0.08
    this.floor = 0.002
    this.open = false
    this.hold = 0
  }

  /** Speech RMS estimate for level normalisation. */
  get ref() {
    return clamp(this.peak * 0.6, 0.003, 0.5)
  }

  run(s, n, flags) {
    for (let i = 0; i < n; i++) {
      const x = s[i]
      const v = x === x && x < 1e6 && x > -1e6 ? x : 0
      this.ms += (v * v - this.ms) * this.c20
      if (this.ms < 1e-20) this.ms = 0
      const r = Math.sqrt(this.ms)
      this.peak += (r - this.peak) * (r > this.peak ? this.cUp : this.cDn)
      if (this.peak < 0.004) this.peak = 0.004
      this.floor += (r - this.floor) * (r > this.floor ? this.fUp : this.fDn)
      if (this.floor < 1e-5) this.floor = 1e-5
      const openT = Math.max(this.floor * 3, this.peak * 0.18, 0.0015)
      if (r > openT) {
        this.open = true
        this.hold = this.holdN
      } else if (this.open && r < openT * 0.5) {
        if (this.hold > 0) this.hold--
        else this.open = false
      }
      if (flags) flags[i] = this.open ? 1 : 0
    }
  }
}

/** Offline speech level: RMS of the 20 ms frames within 20 dB of the loudest. */
export function speechRef(x, sr) {
  const n = x.length
  const hop = Math.max(1, Math.round(sr * 0.02))
  const nf = Math.floor(n / hop)
  if (nf < 1) return 0.05
  const fr = new Float64Array(nf)
  for (let f = 0; f < nf; f++) {
    let a = 0
    for (let i = f * hop; i < (f + 1) * hop; i++) {
      const v = x[i]
      if (v === v && v < 1e6 && v > -1e6) a += v * v
    }
    fr[f] = a / hop
  }
  const sorted = Float64Array.from(fr).sort()
  const top = sorted[Math.min(nf - 1, Math.floor(nf * 0.95))]
  if (!(top > 1e-10)) return 0.05
  let acc = 0
  let cnt = 0
  for (let f = 0; f < nf; f++) {
    if (fr[f] > top * 0.01) {
      acc += fr[f]
      cnt++
    }
  }
  const r = Math.sqrt(acc / Math.max(1, cnt))
  return clamp(r, 0.003, 0.5)
}

/**
 * Offline talk flags: 1 while a transmission is on. Phrases closer than
 * gapMs merge; each starts leadMs early (firstLeadMs for the first) when the
 * pause before it allows. Returns { flags, phrases }.
 */
export function talkFlags(x, sr, total, opts = {}) {
  const gap = opts.gapMs ?? 400
  const lead = Math.round(((opts.leadMs ?? 30) * sr) / 1000)
  const firstLead = Math.round(((opts.firstLeadMs ?? opts.leadMs ?? 30) * sr) / 1000)
  const minOff = Math.round(0.06 * sr)
  const flags = new Uint8Array(total)
  const phrases = findPhrases(x, sr, { minSilenceMs: gap, minPhraseMs: 120 })
  let prevEnd = -minOff
  for (let k = 0; k < phrases.length; k++) {
    const p = phrases[k]
    let s = p.start - (k === 0 ? firstLead : lead)
    if (s < prevEnd + minOff) s = Math.min(p.start, prevEnd + minOff)
    if (s < 0) s = 0
    const e = Math.min(total, p.end)
    for (let i = s; i < e; i++) flags[i] = 1
    prevEnd = e
  }
  return { flags, phrases }
}

// ---------------------------------------------------------------- the wrapper

function choiceIds(params) {
  const ids = []
  for (const p of params) if (p.type === 'choice') ids.push(p.id)
  return ids
}

function safe(v) {
  if (!(v === v) || v > 1e6 || v < -1e6) return 0
  const a = v < 0 ? -v : v
  if (a <= 1.5) return v
  const y = 1.5 + 1.5 * Math.tanh((a - 1.5) / 1.5)
  return v < 0 ? -y : y
}

/**
 * Build a device module from a core factory.
 * def: { id, name, about, params, cost, tail(p, sr), surprise, talk: { gapMs,
 *   leadMs, firstLeadMs, holdMs } | null, latency(sr), build(sr, p, rng, info),
 *   live: true|false, warps: true|false, prepare(mono, sr, p) }
 * The core: { latency, set(p), run(s, n, talk), reset() }.
 * prepare (offline only) may replace the mono take before the core runs, for
 * a device whose playback speed changes the timing (a record played at the
 * wrong speed); such a device must declare warps: true. Live ignores it.
 */
export function makeDevice(def) {
  const choices = choiceIds(def.params)
  const latencyOf = (sr) => Math.max(0, Math.round(def.latency ? def.latency(sr) : 0))
  const tailOf = (p, sr) => (def.tail ? Math.max(0, def.tail(p, sr)) : 0)
  const mod = {
    id: def.id,
    name: def.name,
    family: 'device',
    about: def.about,
    params: def.params,
    stereo: 'keep',
    warps: def.warps === true,
    cost: def.cost || 2,
    tail: (p, sr) => tailOf(p, sr),
    process(input, pIn, ctx) {
      const c = ctx || {}
      const p = resolveParams(mod, pIn)
      const sr = input.sr
      const n0 = bufLen(input)
      const nch = Math.max(1, input.ch.length)
      if (n0 === 0) return { sr, ch: input.ch.map(() => new Float32Array(0)) }
      let mono = new Float32Array(n0)
      if (nch === 1) mono.set(input.ch[0])
      else {
        const g = 1 / nch
        for (let k = 0; k < nch; k++) {
          const ch = input.ch[k]
          for (let i = 0; i < n0; i++) mono[i] += ch[i] * g
        }
      }
      for (let i = 0; i < n0; i++) {
        const v = mono[i]
        if (!(v === v) || v > 1e6 || v < -1e6) mono[i] = 0
      }
      if (typeof def.prepare === 'function') {
        const m2 = def.prepare(mono, sr, p)
        if (m2 instanceof Float32Array) {
          mono = m2
          for (let i = 0; i < mono.length; i++) {
            const v = mono[i]
            if (!(v === v) || v > 1e6 || v < -1e6) mono[i] = 0
          }
        }
      }
      const n = mono.length
      if (n === 0) return { sr, ch: input.ch.map(() => new Float32Array(0)) }
      const rng = c.rng || makeRng(def.id)
      const ref = speechRef(mono, sr)
      const lat = latencyOf(sr)
      const tailN = Math.round(tailOf(p, sr) * sr)
      const outLen = n + tailN
      const total = outLen + lat
      const tf = def.talk ? talkFlags(mono, sr, total, def.talk) : null
      const core = def.build(sr, p, rng, { offline: true, phrases: tf ? tf.phrases : [], length: n, ref })
      const out = new Float32Array(outLen)
      const s = new Float32Array(BLOCK)
      const t = new Uint8Array(BLOCK)
      const pre = SPEECH / ref
      const post = ref / SPEECH
      let blocks = 0
      for (let pos = 0; pos < total; pos += BLOCK) {
        const m = Math.min(BLOCK, total - pos)
        for (let j = 0; j < m; j++) {
          const q = pos + j
          s[j] = q < n ? mono[q] * pre : 0
          t[j] = tf ? tf.flags[q] : 0
        }
        core.run(s, m, tf ? t : null)
        for (let j = 0; j < m; j++) {
          const q = pos + j - lat
          if (q >= 0 && q < outLen) out[q] = safe(s[j] * post)
        }
        if ((++blocks & 63) === 0) {
          if (typeof c.progress === 'function') c.progress(Math.min(1, (pos + m) / total))
          if (typeof c.cancelled === 'function' && c.cancelled()) break
        }
      }
      const ch = [out]
      for (let k = 1; k < nch; k++) ch.push(new Float32Array(out))
      return { sr, ch }
    },
  }
  if (def.live !== false) {
    mod.live = {
      latency(p, sr) {
        return latencyOf(sr)
      },
      create(sr, pIn, rng) {
        const p = resolveParams(mod, pIn)
        const r = rng || makeRng(def.id + ':live')
        const core = def.build(sr, p, r, { offline: false, phrases: [], length: 0, ref: 0.06 })
        const gate = new TalkGate(sr, def.talk ? def.talk.holdMs ?? def.talk.gapMs ?? 400 : 400)
        const s = new Float32Array(BLOCK)
        const t = new Uint8Array(BLOCK)
        let cur = p
        let pending = null
        let duck = 0 // 0 open, 1 closing, 2 opening
        let gPre = SPEECH / gate.ref
        return {
          process(ins, outs, n) {
            const nin = ins.length
            const nout = outs.length
            for (let off = 0; off < n; off += BLOCK) {
              const m = Math.min(BLOCK, n - off)
              if (nin > 1) {
                const a = ins[0]
                const b = ins[1]
                for (let j = 0; j < m; j++) s[j] = 0.5 * (a[off + j] + b[off + j])
              } else {
                const a = ins[0]
                for (let j = 0; j < m; j++) s[j] = a[off + j]
              }
              for (let j = 0; j < m; j++) {
                const v = s[j]
                if (!(v === v) || v > 1e6 || v < -1e6) s[j] = 0
              }
              gate.run(s, m, t)
              const target = SPEECH / gate.ref
              const g0 = gPre
              const step = (target - g0) / m
              for (let j = 0; j < m; j++) s[j] *= g0 + step * j
              gPre = target
              core.run(s, m, def.talk ? t : null)
              // duck around structural changes (era, style...)
              let d0 = 1
              let d1 = 1
              if (duck === 1) {
                d1 = 0
              } else if (duck === 2) {
                d0 = 0
              }
              for (let j = 0; j < m; j++) {
                const gp = 1 / (g0 + step * j)
                const dk = d0 + ((d1 - d0) * j) / m
                s[j] = safe(s[j] * gp * dk)
              }
              if (duck === 1) {
                if (pending) core.set(pending)
                cur = pending || cur
                pending = null
                duck = 2
              } else if (duck === 2) duck = 0
              for (let k = 0; k < nout; k++) {
                const o = outs[k]
                for (let j = 0; j < m; j++) o[off + j] = s[j]
              }
            }
          },
          set(np) {
            if (!np) return
            let structural = false
            for (let k = 0; k < choices.length; k++) if (np[choices[k]] !== cur[choices[k]]) structural = true
            if (structural) {
              pending = np
              duck = 1
            } else {
              core.set(np)
              cur = np
            }
          },
          reset() {
            core.reset()
            gate.reset()
            gPre = SPEECH / gate.ref
            duck = 0
            pending = null
          },
        }
      },
    }
  }
  return mod
}

/** Rising and falling edges of a talk flag block, sample-accurate. */
export class Edges {
  constructor() {
    this.prev = 0
    this.since = 1e9 // samples since the last fall (silence length)
  }

  /**
   * Calls obj.onRise(i, silenceSamples) and obj.onFall(i) for block index i
   * (methods, so live blocks create no closures).
   */
  scan(talk, n, obj) {
    if (!talk) return
    let prev = this.prev
    for (let i = 0; i < n; i++) {
      const v = talk[i]
      if (v !== prev) {
        if (v) obj.onRise(i, this.since)
        else {
          obj.onFall(i)
          this.since = 0
        }
        prev = v
      } else if (!v) this.since++
    }
    this.prev = prev
  }

  reset() {
    this.prev = 0
    this.since = 1e9
  }
}
