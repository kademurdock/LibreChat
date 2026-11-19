// beds/rain.js - Rain: thousands of single droplets over a wash, on the surface you pick.
//
// This file also holds the small synthesis kit the other weather, water and
// fire beds share (they import it from here, never from another family).
//
// Techniques and their published sources:
// - Drop sizes follow the Marshall-Palmer distribution (Marshall and Palmer
//   1948, "The distribution of raindrops with size", J. Meteorology 5):
//   N(D) = N0 exp(-Lambda D) with Lambda = 4.1 R^-0.21 per millimetre for a
//   rain rate R in millimetres per hour, so heavier rain brings more and
//   bigger drops. Impact speed is the terminal velocity fit of Atlas,
//   Srivastava and Sekhon 1973 (v = 9.65 - 10.3 exp(-0.6 D) metres per
//   second), and loudness follows the impact energy, D^3 v^2.
// - Every audible drop is its own event, built the way Andy Farnell builds
//   rain in "Designing Sound" (MIT Press 2010): a contact tick plus a short
//   resonant noise burst whose pitch falls as the drop grows, coloured by
//   what it lands on (glass ping, tin ring, tent thud, leaf patter, puddle
//   plink). Behind them sits a wash made from very dense tiny impulses and
//   noise, which is what millions of distant drops add up to.
// - Drops into water add a Minnaert bubble (Minnaert 1933, "On musical air
//   bubbles and the sounds of running water"): a damped sine at f = 3 / r
//   (radius in metres) whose damping d = 0.043 f + 0.0014 f^1.5 and slight
//   upward chirp f(t) = f (1 + xi d t) are those of van den Doel 2005,
//   "Physically based models for liquid sounds" (ACM Trans. Applied
//   Perception 2(4)).
// - Surfaces that ring as a whole (a tin roof's panels, a tent's fabric, a
//   window pane) are modal resonator banks (two-pole resonators, the modal
//   synthesis of Adrien 1991 and van den Doel and Pai 1998) driven by every
//   impact, so the whole roof drums as it does in life.
// - Room sound: an 8-line feedback delay network (Stautner and Puckette 1982;
//   Jot and Chaigne 1991) with Hadamard mixing and lowpass damping in the
//   loop, its loop gains set from the decay time.
// - Fast noise: Marsaglia's xorshift32 (2003), seeded from the bed's rng, so
//   everything stays deterministic for a seed.
// - Level: every bed is brought to a loudness target with ITU-R BS.1770
//   (core/loudness.js), so a preset's bed level means the same for rain as
//   for a waterfall, then a lookahead limiter (core/dyn.js) catches the
//   rare close event; peaks are never clipped.

import { Biquad } from '../core/biquad.js'
import { makeRng } from '../core/rng.js'
import { resolveParams } from '../core/params.js'
import { limitBuf } from '../core/dyn.js'
import { lufs } from '../core/loudness.js'

// ------------------------------------------------------------------ kit

/** Control signals are computed once every HOP samples and interpolated. */
export const HOP = 64

const TWO_PI = 2 * Math.PI

/** Fast seeded uniform noise (xorshift32). */
export class Rand32 {
  constructor(rng) {
    let s = rng && typeof rng.uint32 === 'function' ? rng.uint32() : 0x9e3779b9
    s = s | 0
    if (s === 0) s = 0x2545f491
    this.s = s
  }
  /** Uniform in [0, 1). */
  next() {
    let s = this.s
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    this.s = s
    return (s >>> 0) / 4294967296
  }
  /** Uniform in [-1, 1). */
  bi() {
    let s = this.s
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    this.s = s
    return s / 2147483648
  }
  range(a, b) {
    return a + (b - a) * this.next()
  }
  /** Log-uniform between a and b (both above 0). */
  logRange(a, b) {
    return a * Math.exp(Math.log(b / a) * this.next())
  }
  /** Exponential waiting time with the given mean. */
  exp(mean) {
    return -Math.log(1 - this.next() * 0.999999) * mean
  }
  /** Standard normal (Box-Muller, not for per-sample use). */
  gauss() {
    const u = 1 - this.next()
    const v = this.next()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v)
  }
  chance(p) {
    return this.next() < p
  }
  int(k) {
    return Math.floor(this.next() * k)
  }
}

export function clamp(x, a, b) {
  return x < a ? a : x > b ? b : x
}

export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Number of control frames for n samples. */
export function ctrlLen(n) {
  return Math.ceil(n / HOP) + 2
}

/**
 * Smooth random wandering curve (control rate sr / HOP), the sum of
 * `octaves` layers of cosine-interpolated random values starting at hz and
 * doubling, each `rough` times the one before. Result is roughly -1..1,
 * standard deviation about 0.35.
 */
export function smoothCurve(m, ctrlRate, rnd, hz, octaves = 3, rough = 0.5) {
  const out = new Float32Array(m)
  let ampSum = 0
  let amp = 1
  let f = hz
  for (let o = 0; o < octaves; o++) {
    const step = Math.max(1.5, ctrlRate / f)
    let a = rnd.bi()
    let b = rnd.bi()
    let pos = rnd.next() * step
    for (let i = 0; i < m; i++) {
      pos += 1
      if (pos >= step) {
        pos -= step
        a = b
        b = rnd.bi()
      }
      const w = 0.5 - 0.5 * Math.cos((Math.PI * pos) / step)
      out[i] += amp * (a + (b - a) * w)
    }
    ampSum += amp
    amp *= rough
    f *= 2
  }
  const k = 1 / ampSum
  for (let i = 0; i < m; i++) out[i] *= k
  return out
}

/** Value of a control curve at audio sample i (linear interpolation). */
export function curveAt(c, i) {
  const x = i / HOP
  const j = x | 0
  const f = x - j
  const a = c[j < c.length ? j : c.length - 1]
  const b = c[j + 1 < c.length ? j + 1 : c.length - 1]
  return a + (b - a) * f
}

/** Equal-power pan gains for pan in -1..1, written into out[0], out[1]. */
export function panGains(pan, out) {
  const a = (clamp(pan, -1, 1) + 1) * 0.25 * Math.PI
  out[0] = Math.cos(a)
  out[1] = Math.sin(a)
  return out
}

/** Run a list of [type, freq, q, gainDb] biquads over sig in place. */
export function eq(sig, sr, specs) {
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]
    const f = Math.min(s[1], sr * 0.45)
    new Biquad(s[0], sr, f, s[2] === undefined ? 0.707 : s[2], s[3] || 0).run(sig)
  }
  return sig
}

/** White noise (-1..1), fast. */
export function whiteArr(n, rnd, amp = 1) {
  const out = new Float32Array(n)
  let s = rnd.s
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = (s / 2147483648) * amp
  }
  rnd.s = s
  return out
}

/** Brown-ish noise: leaky integrated white, RMS about amp. */
export function brownArr(n, rnd, amp = 1, leak = 0.996) {
  const out = new Float32Array(n)
  let s = rnd.s
  let y = 0
  const g = amp * Math.sqrt((1 - leak * leak) * 3)
  for (let i = -2000; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    y = leak * y + s / 2147483648
    if (i >= 0) out[i] = y * g
  }
  rnd.s = s
  return out
}

/**
 * Sizzle: noise plus sparse random impulses (density per second), the
 * texture of many tiny distant impacts. Not yet filtered.
 */
export function sizzleArr(n, sr, rnd, density, noiseAmt = 0.4) {
  const out = new Float32Array(n)
  let s = rnd.s
  const p = clamp(density / sr, 0, 1)
  const thr = p * 4294967296
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    let v = (s / 2147483648) * noiseAmt
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    if ((s >>> 0) < thr) {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      const u = s / 2147483648
      v += u * u * u * 6
    }
    out[i] = v
  }
  rnd.s = s
  return out
}

/** Multiply sig by gain times a control curve (or a number). */
export function applyCurve(sig, curve, gain = 1) {
  const n = sig.length
  if (!curve) {
    if (gain !== 1) for (let i = 0; i < n; i++) sig[i] *= gain
    return sig
  }
  for (let j = 0, i = 0; i < n; j++) {
    const a = curve[j < curve.length ? j : curve.length - 1] * gain
    const b = curve[j + 1 < curve.length ? j + 1 : curve.length - 1] * gain
    const end = Math.min(n, i + HOP)
    const d = (b - a) / HOP
    let g = a
    for (; i < end; i++) {
      sig[i] *= g
      g += d
    }
  }
  return sig
}

/** Partly correlate two independent channels in place (corr 0..1). */
export function correlate(L, R, corr) {
  const c = clamp(corr, 0, 0.999)
  if (c <= 0) return
  const t = (1 - Math.sqrt(1 - c * c)) / c
  const a = 1 / Math.sqrt(1 + t * t)
  const b = t * a
  for (let i = 0; i < L.length; i++) {
    const l = L[i]
    const r = R[i]
    L[i] = a * l + b * r
    R[i] = a * r + b * l
  }
}

export function addInto(dst, src, gain = 1) {
  const n = Math.min(dst.length, src.length)
  for (let i = 0; i < n; i++) dst[i] += src[i] * gain
}

export function rmsOf(L, R) {
  let e = 0
  for (let i = 0; i < L.length; i++) e += L[i] * L[i] + R[i] * R[i]
  const n = L.length * 2
  return n ? Math.sqrt(e / n) : 0
}

export function peakOf(L, R) {
  let m = 0
  for (let i = 0; i < L.length; i++) {
    const a = L[i] < 0 ? -L[i] : L[i]
    const b = R[i] < 0 ? -R[i] : R[i]
    if (a > m) m = a
    if (b > m) m = b
  }
  return m
}

/** Multiply both channels by g; any non-finite sample becomes 0. */
export function scaleSafe(L, R, g) {
  const k = Number.isFinite(g) ? g : 0
  for (let c = 0; c < 2; c++) {
    const s = c === 0 ? L : R
    for (let i = 0; i < s.length; i++) {
      const v = s[i] * k
      s[i] = v > -1e9 && v < 1e9 ? v : 0
    }
  }
}

/** BS.1770 loudness of a stereo pair (LUFS, gated), -200 for silence. */
export function loudnessOf(L, R, sr) {
  const v = lufs({ sr, ch: [L, R] })
  return Number.isFinite(v) ? v : -200
}

/** Scale a stereo pair to a loudness in LUFS (no limiting). Returns the gain. */
export function levelTo(L, R, sr, targetLufs) {
  const now = loudnessOf(L, R, sr)
  const g = now > -150 ? Math.pow(10, (targetLufs - now) / 20) : 0
  scaleSafe(L, R, g)
  return g
}

/**
 * Last stage: a fast lookahead limiter (core/dyn.js) to -1.5 dBFS when
 * anything is over, then a soft knee above 0.9 as a guard that should
 * never be reached.
 */
export function limitBed(L, R, sr) {
  if (peakOf(L, R) > 0.84) {
    limitBuf({ sr, ch: [L, R] }, { ceilingDb: -1.5, lookaheadMs: 2, releaseMs: 60, truePeak: false })
  }
  scaleAndClip(L, R, 1)
}

/**
 * Bring a finished bed to its level: loudness to targetLufs (BS.1770, so
 * every bed at a preset's level sounds about as loud as any other), but
 * never more gain than lets the loudest peak reach `headroom` (so a rare
 * close event is limited by a few decibels instead of pulling the whole
 * bed down); then the limiter of limitBed.
 */
export function finishBed(L, R, sr, targetLufs = -20, headroom = 2.5) {
  const now = loudnessOf(L, R, sr)
  const p = peakOf(L, R)
  let g = now > -150 ? Math.pow(10, (targetLufs - now) / 20) : 0
  if (p * g > headroom && p > 1e-9) g = headroom / p
  scaleSafe(L, R, g)
  limitBed(L, R, sr)
}

/** Scale both channels, soft-knee anything above 0.9, zero non-finite samples. */
export function scaleAndClip(L, R, g = 1) {
  const k = 0.9
  const w = 1 - k
  for (let c = 0; c < 2; c++) {
    const s = c === 0 ? L : R
    for (let i = 0; i < s.length; i++) {
      let v = s[i] * g
      if (!(v > -1e9 && v < 1e9)) v = 0
      if (v > k) v = k + w * Math.tanh((v - k) / w)
      else if (v < -k) v = -k - w * Math.tanh((-v - k) / w)
      else if (v < 1e-30 && v > -1e-30) v = 0
      s[i] = v
    }
  }
}

/** Common start of every generate(): safe length, resolved params, rng. */
export function bedSetup(bed, seconds, sr, p, rng) {
  let rate = Number(sr)
  if (!(rate >= 1000 && rate <= 384000)) rate = 48000
  let secs = Number(seconds)
  if (!(secs > 0) || !Number.isFinite(secs)) secs = 0
  if (secs > 3600) secs = 3600
  const n = Math.max(0, Math.round(secs * rate))
  const q = resolveParams(bed, p || {})
  const r = rng && typeof rng.fork === 'function' ? rng : makeRng(bed.id)
  return { n, sr: rate, q, rng: r, seconds: n / rate }
}

/** A stereo buffer from two channels. */
export function stereo(sr, L, R) {
  return { sr, ch: [L, R] }
}

/** Longest stretch rendered in one go; longer beds are made of fresh segments. */
export const SEGMENT_SECONDS = 30
const CROSSFADE_SECONDS = 1.5

/**
 * Run a bed: resolve params, then render(n, sr, q, rng, segment) -> { L, R }
 * (already levelled; segment is 0 for the first or only piece). Up to 45 s renders in one piece. Longer beds (a whole long
 * take) are rendered as 30 s segments, each from its own fork of the rng so
 * nothing ever repeats, joined with 1.5 s equal-power crossfades (right for
 * uncorrelated textures). Working memory then stays that of a 30 s render,
 * which matters in a phone's web view; only the output is full length.
 */
export function runBed(bed, seconds, sr, p, rng, render) {
  const s = bedSetup(bed, seconds, sr, p, rng)
  const n = s.n
  if (n === 0) return stereo(s.sr, new Float32Array(0), new Float32Array(0))
  const seg = Math.round(SEGMENT_SECONDS * s.sr)
  if (n <= seg * 1.5) {
    const out = render(n, s.sr, s.q, s.rng, 0)
    return stereo(s.sr, out.L, out.R)
  }
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  const xf = Math.round(CROSSFADE_SECONDS * s.sr)
  for (let k = 0, start = 0; start < n; k++, start += seg) {
    let len = Math.min(n - start, seg + xf)
    // Fold a short remainder into this segment rather than leave a sliver.
    if (n - (start + seg) < seg * 0.5) len = n - start
    const out = render(len, s.sr, s.q, s.rng.fork('segment-' + k), k)
    const fadeIn = k > 0 ? xf : 0
    const last = start + len >= n
    for (let i = 0; i < len; i++) {
      let g = 1
      if (i < fadeIn) g = Math.sin((0.5 * Math.PI * (i + 0.5)) / fadeIn)
      if (!last && i >= len - xf) g *= Math.cos((0.5 * Math.PI * (i - (len - xf) + 0.5)) / xf)
      L[start + i] += out.L[i] * g
      R[start + i] += out.R[i] * g
    }
    if (last) break
  }
  return stereo(s.sr, L, R)
}

/**
 * Event renderer: adds short synthesised impacts straight into a stereo
 * pair of Float32Arrays, plus shared resonant bodies driven by many impacts.
 * Nothing is allocated per sample; one small object per body.
 */
export class Impacts {
  constructor(L, R, sr, rnd) {
    this.L = L
    this.R = R
    this.n = L.length
    this.sr = sr
    this.fmax = sr * 0.45
    this.rnd = rnd
    this.g = new Float64Array(2)
    this.banks = []
  }

  _pan(pan) {
    panGains(pan, this.g)
  }

  /**
   * Noise burst through a resonant bandpass: excitation decays with time
   * constant tau seconds; click adds an impulse at the start (contact tick).
   */
  burst(t, amp, pan, fc, q, tau, click = 0) {
    if (!(amp > 1e-7)) return
    const sr = this.sr
    const n = this.n
    const i0 = Math.round(t * sr)
    if (i0 >= n) return
    let f = fc > this.fmax ? this.fmax : fc < 20 ? 20 : fc
    const w0 = (TWO_PI * f) / sr
    const alpha = Math.sin(w0) / (2 * q)
    const a0 = 1 + alpha
    const b0 = alpha / a0
    const a1 = (-2 * Math.cos(w0)) / a0
    const a2 = (1 - alpha) / a0
    const ts = Math.max(1, tau * sr)
    const dec = Math.exp(-1 / ts)
    const ring = (q / (Math.PI * f)) * sr
    let len = Math.ceil(6.9 * (ts + ring)) + 4
    if (len > sr) len = sr
    const end = Math.min(n, i0 + len)
    this._pan(pan)
    const gl = amp * this.g[0]
    const gr = amp * this.g[1]
    const L = this.L
    const R = this.R
    let s = this.rnd.s
    let env = 1
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    for (let i = i0; i < end; i++) {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      let x = (s / 2147483648) * env
      if (i === i0) x += click
      env *= dec
      const y = b0 * (x - x2) - a1 * y1 - a2 * y2
      x2 = x1
      x1 = x
      y2 = y1
      y1 = y
      if (i >= 0) {
        L[i] += y * gl
        R[i] += y * gr
      }
    }
    this.rnd.s = s
  }

  /** Lowpassed noise burst (two-pole lowpass), for thuds and splats. */
  lowBurst(t, amp, pan, fc, tau, attack = 0) {
    if (!(amp > 1e-7)) return
    const sr = this.sr
    const n = this.n
    const i0 = Math.round(t * sr)
    if (i0 >= n) return
    const f = fc > this.fmax ? this.fmax : fc < 10 ? 10 : fc
    const w0 = (TWO_PI * f) / sr
    const cs = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * 0.8)
    const a0 = 1 + alpha
    const b0 = (1 - cs) / 2 / a0
    const b1 = (1 - cs) / a0
    const a1 = (-2 * cs) / a0
    const a2 = (1 - alpha) / a0
    const ts = Math.max(1, tau * sr)
    const dec = Math.exp(-1 / ts)
    const at = Math.max(1, Math.round(attack * sr))
    let len = Math.ceil(6.9 * ts + at + (2 * sr) / f) + 4
    if (len > sr * 8) len = sr * 8
    const end = Math.min(n, i0 + len)
    this._pan(pan)
    const gl = amp * this.g[0]
    const gr = amp * this.g[1]
    const L = this.L
    const R = this.R
    let s = this.rnd.s
    let env = 1
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    for (let i = i0, k = 0; i < end; i++, k++) {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      let e
      if (k < at) e = k / at
      else {
        e = env
        env *= dec
      }
      const x = (s / 2147483648) * e
      const y = b0 * (x + x2) + b1 * x1 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = x
      y2 = y1
      y1 = y
      if (i >= 0) {
        L[i] += y * gl
        R[i] += y * gr
      }
    }
    this.rnd.s = s
  }

  /** One damped sine mode amp * r^k sin(w k), time constant tau seconds. */
  mode(t, amp, pan, f, tau) {
    if (!(amp > 1e-7) || f >= this.fmax || f < 10) return
    const sr = this.sr
    const n = this.n
    const i0 = Math.round(t * sr)
    if (i0 >= n) return
    const w = (TWO_PI * f) / sr
    const r = Math.exp(-1 / Math.max(1, tau * sr))
    const c = 2 * r * Math.cos(w)
    const r2 = r * r
    let len = Math.ceil(6.9 * tau * sr) + 2
    if (len > sr * 4) len = sr * 4
    const end = Math.min(n, i0 + len)
    this._pan(pan)
    const gl = this.g[0]
    const gr = this.g[1]
    const L = this.L
    const R = this.R
    let y2 = 0
    let y1 = amp * r * Math.sin(w)
    for (let i = i0 + 1; i < end; i++) {
      if (i >= 0) {
        L[i] += y1 * gl
        R[i] += y1 * gr
      }
      const y = c * y1 - r2 * y2
      y2 = y1
      y1 = y
    }
  }

  /**
   * Minnaert bubble with van den Doel damping and chirp. f0 in Hz, xi the
   * rise factor (0.1 typical), dampMul scales the damping.
   */
  bubble(t, amp, pan, f0, xi = 0.1, dampMul = 1) {
    if (!(amp > 1e-7) || !(f0 > 20) || f0 >= this.fmax) return
    const sr = this.sr
    const n = this.n
    const i0 = Math.round(t * sr)
    if (i0 >= n) return
    const d = (0.043 * f0 + 0.0014 * Math.pow(f0, 1.5)) * dampMul
    // Ring until -50 dB.
    let len = Math.ceil((5.76 / d) * sr) + 2
    if (len > sr * 0.5) len = Math.floor(sr * 0.5)
    const end = Math.min(n, i0 + len)
    this._pan(pan)
    const gl = amp * this.g[0]
    const gr = amp * this.g[1]
    const L = this.L
    const R = this.R
    const dec = Math.exp(-d / sr)
    // Magic-circle oscillator (Chamberlin's coupled form): sine and cosine
    // states rotated by a coefficient that grows each sample for the chirp.
    let env = 1
    let sn = 0
    let cs = 1
    const fEnd = Math.min(this.fmax, f0 * (1 + xi * d * (len / sr)))
    let k = 2 * Math.sin((Math.PI * f0) / sr)
    const kEnd = 2 * Math.sin((Math.PI * fEnd) / sr)
    const dk = len > 1 ? (kEnd - k) / len : 0
    for (let i = i0; i < end; i++) {
      sn += k * cs
      cs -= k * sn
      const y = env * sn
      if (i >= 0) {
        L[i] += y * gl
        R[i] += y * gr
      }
      env *= dec
      k += dk
    }
  }

  /**
   * A shared resonant body: modes (Hz), time constants (s), gains, a pan
   * and a stereo spread of its modes. Returns the body's index.
   */
  addBank(freqs, taus, gains, pan = 0, spread = 0.4) {
    const b = {
      input: new Float32Array(this.n),
      f: Float64Array.from(freqs),
      tau: Float64Array.from(taus),
      g: Float64Array.from(gains),
      pan,
      spread,
    }
    this.banks.push(b)
    return this.banks.length - 1
  }

  /** Strike a body with an impulse at time t. */
  excite(bank, t, amp) {
    const b = this.banks[bank]
    if (!b) return
    const i = Math.round(t * this.sr)
    if (i >= 0 && i < this.n) b.input[i] += amp
  }

  /**
   * Strike a body with a short decaying noise burst (a softer contact). The
   * burst carries the same energy as an impulse of size amp, so low modes
   * are not over-driven by the burst's coherent sum.
   */
  exciteSoft(bank, t, amp, ms) {
    const b = this.banks[bank]
    if (!b) return
    const i0 = Math.round(t * this.sr)
    const len = Math.max(1, Math.round((ms * this.sr) / 1000))
    const dec = Math.exp(-3 / len)
    let e = amp * Math.sqrt(3 * (1 - dec * dec))
    const inp = b.input
    let s = this.rnd.s
    const end = Math.min(this.n, i0 + len * 3)
    for (let i = i0; i < end; i++) {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      if (i >= 0) inp[i] += (s / 2147483648) * e
      e *= dec
    }
    this.rnd.s = s
  }

  /** Dense small random impulses into a body (the roar of a downpour). */
  sizzleBank(bank, density, amp, curve = null) {
    const b = this.banks[bank]
    if (!b || !(density > 0) || !(amp > 0)) return
    const inp = b.input
    const n = this.n
    let s = this.rnd.s
    const base = clamp(density / this.sr, 0, 1)
    for (let j = 0, i = 0; i < n; j++) {
      const cv = curve ? curve[j < curve.length ? j : curve.length - 1] : 1
      const thr = clamp(base * cv, 0, 1) * 4294967296
      const end = Math.min(n, i + HOP)
      for (; i < end; i++) {
        s ^= s << 13
        s ^= s >>> 17
        s ^= s << 5
        if ((s >>> 0) < thr) {
          s ^= s << 13
          s ^= s >>> 17
          s ^= s << 5
          const u = s / 2147483648
          inp[i] += u * u * u * amp
        }
      }
    }
    this.rnd.s = s
  }

  /** Ring every body and add it to the output. */
  renderBanks() {
    const L = this.L
    const R = this.R
    const n = this.n
    const sr = this.sr
    const g = this.g
    for (const b of this.banks) {
      const inp = b.input
      for (let m = 0; m < b.f.length; m++) {
        const f = b.f[m]
        if (!(f > 10) || f >= this.fmax) continue
        const w = (TWO_PI * f) / sr
        const r = Math.exp(-1 / Math.max(1, b.tau[m] * sr))
        const c = 2 * r * Math.cos(w)
        const r2 = r * r
        const gin = b.g[m] * Math.sin(w)
        panGains(b.pan + (m & 1 ? 1 : -1) * b.spread * (0.4 + 0.6 * ((m * 0.618) % 1)), g)
        const gl = g[0]
        const gr = g[1]
        let y1 = 0
        let y2 = 0
        for (let i = 0; i < n; i++) {
          let y = gin * inp[i] + c * y1 - r2 * y2
          if (y < 1e-20 && y > -1e-20) y = 0
          y2 = y1
          y1 = y
          L[i] += y * gl
          R[i] += y * gr
        }
      }
      b.input = null
    }
    this.banks = []
  }
}

/**
 * 8-line feedback delay network reverb, in place on a stereo pair.
 * size scales the delay lengths (1 = a medium room, about 30 to 75 ms),
 * rt60 is the decay time in seconds, damp 0..1 how quickly highs die.
 * Wet output is scaled for roughly equal loudness on steady sounds.
 */
export class Fdn {
  constructor(sr, { size = 1, rt60 = 1, damp = 0.4, predelayMs = 0 } = {}) {
    const base = [29.7, 37.1, 41.1, 43.7, 53.3, 59.9, 67.7, 73.1]
    this.sr = sr
    this.len = new Int32Array(8)
    this.off = new Int32Array(8)
    this.idx = new Int32Array(8)
    this.gain = new Float64Array(8)
    this.z = new Float64Array(8)
    this.y = new Float64Array(8)
    let total = 0
    let gAvg = 0
    const rt = Math.max(0.05, rt60)
    for (let i = 0; i < 8; i++) {
      let l = Math.max(8, Math.round((base[i] * Math.max(0.05, size) * sr) / 1000)) | 1
      for (let j = 0; j < i; j++) if (this.len[j] === l) l += 2
      this.len[i] = l
      this.off[i] = total
      total += l
      this.gain[i] = Math.pow(10, (-3 * l) / (rt * sr))
      gAvg += this.gain[i] * this.gain[i]
    }
    gAvg /= 8
    this.buf = new Float32Array(total)
    const fc = 16000 * Math.pow(1 - clamp(damp, 0, 0.98), 1.5) + 500
    this.c = Math.exp((-TWO_PI * Math.min(fc, sr * 0.45)) / sr)
    this.bin = 0.5
    this.bout = 1 / (this.bin * Math.sqrt(8 / Math.max(0.02, 1 - gAvg))) / Math.sqrt(1 - this.c * 0.6)
    const pd = Math.max(0, Math.round((predelayMs * sr) / 1000))
    this.pdLen = pd + 1
    this.pdL = new Float32Array(this.pdLen)
    this.pdR = new Float32Array(this.pdLen)
    this.pdI = 0
  }

  /** L, R in place: out = dry * in + wet * reverb(in). */
  process(L, R, wet = 0.3, dry = 1) {
    const n = L.length
    const buf = this.buf
    const len = this.len
    const off = this.off
    const idx = this.idx
    const gain = this.gain
    const z = this.z
    const y = this.y
    const c = this.c
    const c1 = 1 - c
    const bin = this.bin
    const ko = this.bout * 0.35355339
    const pdL = this.pdL
    const pdR = this.pdR
    const pdLen = this.pdLen
    let pdI = this.pdI
    const hs = 0.35355339
    for (let i = 0; i < n; i++) {
      const inL = L[i]
      const inR = R[i]
      pdL[pdI] = inL
      pdR[pdI] = inR
      pdI++
      if (pdI >= pdLen) pdI = 0
      const xL = pdL[pdI] * bin
      const xR = pdR[pdI] * bin
      for (let j = 0; j < 8; j++) {
        let v = buf[off[j] + idx[j]]
        let zz = v * c1 + z[j] * c
        if (zz < 1e-20 && zz > -1e-20) zz = 0
        z[j] = zz
        y[j] = zz
      }
      const o0 = y[0], o1 = y[1], o2 = y[2], o3 = y[3], o4 = y[4], o5 = y[5], o6 = y[6], o7 = y[7]
      const outL = (o0 - o1 + o2 - o3 + o4 - o5 + o6 - o7) * ko
      const outR = (o0 + o1 - o2 - o3 + o4 + o5 - o6 - o7) * ko
      const g0 = o0 * gain[0], g1 = o1 * gain[1], g2 = o2 * gain[2], g3 = o3 * gain[3]
      const g4 = o4 * gain[4], g5 = o5 * gain[5], g6 = o6 * gain[6], g7 = o7 * gain[7]
      const a0 = g0 + g1, a1 = g0 - g1, a2 = g2 + g3, a3 = g2 - g3
      const a4 = g4 + g5, a5 = g4 - g5, a6 = g6 + g7, a7 = g6 - g7
      const b0 = a0 + a2, b2 = a0 - a2, b1 = a1 + a3, b3 = a1 - a3
      const b4 = a4 + a6, b6 = a4 - a6, b5 = a5 + a7, b7 = a5 - a7
      buf[off[0] + idx[0]] = (b0 + b4) * hs + xL
      buf[off[1] + idx[1]] = (b1 + b5) * hs + xR
      buf[off[2] + idx[2]] = (b2 + b6) * hs - xL
      buf[off[3] + idx[3]] = (b3 + b7) * hs - xR
      buf[off[4] + idx[4]] = (b0 - b4) * hs + xL
      buf[off[5] + idx[5]] = (b1 - b5) * hs + xR
      buf[off[6] + idx[6]] = (b2 - b6) * hs - xL
      buf[off[7] + idx[7]] = (b3 - b7) * hs - xR
      for (let j = 0; j < 8; j++) {
        let k = idx[j] + 1
        if (k >= len[j]) k = 0
        idx[j] = k
      }
      L[i] = inL * dry + outL * wet
      R[i] = inR * dry + outR * wet
    }
    this.pdI = pdI
  }
}

// ------------------------------------------------------------------ rain engine

/** Rain rate in millimetres per hour from a 0..100 intensity. */
export function rainRate(intensity) {
  return 0.4 * Math.pow(150, clamp(intensity, 0, 100) / 100)
}

/** Atlas et al. 1973 terminal velocity, m/s, for diameter D in mm. */
function terminal(D) {
  return Math.max(0.5, 9.65 - 10.3 * Math.exp(-0.6 * D))
}

/** Relative impact amplitude of a drop of diameter D mm (2.5 mm is about 1). */
export function dropAmp(D) {
  return (Math.pow(D, 1.5) * terminal(D)) / 29
}

// Wash colour per surface: biquads [type, freq, q, gainDb], and its level.
const WASH = {
  mixed: { eq: [['highpass', 380, 0.6], ['peak', 3200, 0.7, 3], ['lowpass', 11000, 0.6]], gain: 1 },
  leaves: { eq: [['highpass', 520, 0.6], ['peak', 2700, 0.8, 4], ['lowpass', 9500, 0.6]], gain: 1 },
  puddles: { eq: [['highpass', 300, 0.6], ['peak', 2300, 0.7, 3], ['lowpass', 9000, 0.6]], gain: 0.9 },
  pavement: { eq: [['highpass', 700, 0.6], ['peak', 5200, 0.7, 4], ['lowpass', 14000, 0.6]], gain: 1.1 },
  window: { eq: [['highpass', 160, 0.6], ['lowpass', 2300, 0.7], ['lowpass', 3800, 0.7]], gain: 0.75 },
  roof: { eq: [['highpass', 120, 0.6], ['lowpass', 2600, 0.7], ['lowpass', 4200, 0.7]], gain: 0.45 },
  tent: { eq: [['highpass', 110, 0.6], ['lowpass', 1500, 0.7], ['lowpass', 2600, 0.7]], gain: 0.6 },
}

export const RAIN_SURFACES = Object.keys(WASH)

/**
 * The rain engine. Returns { L, R } of length n (not yet levelled).
 * o: { intensity 0..100, surface, distance 0..1, drips 0..1, waves 0..1,
 *      mod (control curve multiplying the intensity, or null),
 *      ring 0..1 (tin roof), roofSize 0.6..1.4 (bigger = lower), tentSize 0.7..1.3,
 *      washGain, dropGain, dripSurface (what drips land on) }
 */
export function rainLayer(n, sr, rng, o = {}) {
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  if (n === 0) return { L, R }
  const rnd = new Rand32(rng.fork('drops'))
  const crnd = new Rand32(rng.fork('curves'))
  const surface = WASH[o.surface] ? o.surface : 'mixed'
  const rate = rainRate(o.intensity === undefined ? 50 : o.intensity)
  const dist = clamp(o.distance || 0, 0, 1)
  const dur = n / sr
  const m = ctrlLen(n)
  const cr = sr / HOP

  // Rain comes in waves: a slow wandering intensity curve.
  const waves = clamp(o.waves === undefined ? 0.3 : o.waves, 0, 1)
  const I = smoothCurve(m, cr, crnd, 0.045, 3, 0.55)
  for (let i = 0; i < m; i++) {
    let v = 1 + waves * 1.3 * I[i]
    if (o.mod) v *= o.mod[i < o.mod.length ? i : o.mod.length - 1]
    I[i] = clamp(v, 0.15, 2.5)
  }
  const Iat = (t) => I[Math.min(m - 1, Math.floor((t * sr) / HOP))]

  const lambda = 4.1 * Math.pow(rate, -0.21)
  const drawD = () => Math.min(5.8, 0.5 + rnd.exp(1 / lambda))
  const imp = new Impacts(L, R, sr, rnd)
  const dropGain = (o.dropGain === undefined ? 1 : o.dropGain) * (1 - 0.8 * dist)

  // Shared bodies for surfaces that ring as a whole.
  let banks = null
  if (surface === 'roof') {
    const ring = clamp(o.ring === undefined ? 0.6 : o.ring, 0, 1)
    const size = clamp(o.roofSize || 1, 0.5, 1.6)
    const tauMul = 0.3 + 1.5 * ring
    const panels = []
    const ratios = [1, 1.41, 1.83, 2.37, 2.95, 3.62, 4.43, 5.31, 6.42]
    const pg = [1, 0.85, 0.75, 0.62, 0.52, 0.44, 0.37, 0.3, 0.25]
    for (let k = 0; k < 4; k++) {
      const base = rnd.range(1050, 2100) / Math.sqrt(size)
      const f = [rnd.range(320, 600) / size]
      const tau = [0.025 * tauMul]
      const g = [0.3]
      for (let j = 0; j < ratios.length; j++) {
        f.push(base * ratios[j] * rnd.range(0.95, 1.05))
        tau.push(rnd.range(0.025, 0.065) * tauMul * (1.15 - j * 0.06))
        g.push(pg[j])
      }
      panels.push(imp.addBank(f, tau, g, -0.75 + k * 0.5, 0.25))
    }
    const low = imp.addBank(
      [92 / size, 141 / size, 207 / size, 289 / size],
      [0.08 * tauMul, 0.065 * tauMul, 0.05 * tauMul, 0.04 * tauMul],
      [0.32, 0.28, 0.24, 0.2],
      0,
      0.5
    )
    banks = { panels, low }
  } else if (surface === 'tent') {
    const ts = clamp(o.tentSize || 1, 0.6, 1.5)
    const f = [72, 113, 161, 232, 318, 540, 870].map((x) => x / ts)
    const tau = [0.03, 0.025, 0.02, 0.016, 0.012, 0.007, 0.005]
    const g = [0.3, 0.28, 0.26, 0.24, 0.22, 0.2, 0.16]
    banks = { skin: [imp.addBank(f, tau, g, -0.4, 0.3), imp.addBank(f.map((x) => x * 1.07), tau, g, 0.4, 0.3)] }
  } else if (surface === 'window') {
    const f = []
    const tau = []
    const g = []
    for (let j = 0; j < 9; j++) {
      f.push(700 * Math.pow(7, j / 8) * rnd.range(0.92, 1.08))
      tau.push(rnd.range(0.006, 0.018))
      g.push(0.55 / (1 + j * 0.25))
    }
    banks = { pane: imp.addBank(f, tau, g, 0, 0.6) }
  }

  // Drop renderers. a is the drop's amplitude at the listener.
  const renderDrop = (kind, t, D, a, pan, far) => {
    switch (kind) {
      case 'ground': {
        const fc = 3300 * Math.sqrt(2 / (D + 0.6)) * rnd.range(0.75, 1.3) * (far ? 0.8 : 1)
        imp.burst(t, a * 1.6, pan, fc, 1.1, (0.0008 + 0.0011 * D) * rnd.range(0.7, 1.3), 0.3)
        if (D > 2.2 && !far && rnd.chance(0.5)) imp.burst(t + 0.0015, a * 0.7, pan, fc * 0.45, 1.4, 0.004 + 0.0015 * D, 0)
        break
      }
      case 'pavement': {
        const fc = 5200 * Math.sqrt(2 / (D + 0.6)) * rnd.range(0.8, 1.25) * (far ? 0.8 : 1)
        imp.burst(t, a * 1.5, pan, fc, 0.9, (0.0006 + 0.0007 * D) * rnd.range(0.7, 1.3), 0.6)
        if (!far && rnd.chance(0.35)) imp.burst(t + 0.001, a * 0.6, pan, fc * 1.4, 1.2, 0.003 + 0.001 * D, 0)
        break
      }
      case 'puddle': {
        imp.burst(t, a * 0.9, pan, 4200 * rnd.range(0.7, 1.3), 1.0, 0.0006 + 0.0005 * D, 0.2)
        if (rnd.chance(0.35 + 0.1 * D)) {
          const rb = D * rnd.range(0.35, 1.0) * 0.001
          imp.bubble(t + rnd.range(0.0008, 0.004), a * 0.26, pan, Math.max(500, 3 / rb), rnd.range(0.08, 0.25))
        }
        if (D > 3 && !far && rnd.chance(0.5)) imp.mode(t, a * 0.35, pan, rnd.range(330, 650), 0.01)
        break
      }
      case 'leaf': {
        imp.burst(t, a * 1.2, pan, 2600 * rnd.range(0.7, 1.6), 2.4, 0.0005 + 0.0006 * D, 0.12)
        imp.mode(t, a * 0.22, pan, rnd.range(320, 1100), rnd.range(0.004, 0.012))
        break
      }
      case 'glass': {
        imp.burst(t, a * 1.6, pan, 5200 * rnd.range(0.75, 1.35), 1.1, 0.0003 + 0.0002 * D, 0.9)
        imp.mode(t, a * 0.3, pan, rnd.range(2600, 6500), rnd.range(0.0025, 0.006))
        if (rnd.chance(0.5)) imp.mode(t, a * 0.16, pan, rnd.range(1500, 3200), rnd.range(0.003, 0.008))
        imp.excite(banks.pane, t, a * 0.09 * D)
        break
      }
      case 'tin': {
        imp.burst(t, a * 0.45, pan, 5000 * rnd.range(0.8, 1.3), 1, 0.0003, 0.5)
        const k = Math.min(3, Math.max(0, Math.floor((pan + 1) * 2)))
        imp.excite(banks.panels[k], t, a * rnd.range(0.7, 1.2))
        imp.excite(banks.low, t, a * 0.35 * D)
        break
      }
      case 'tent': {
        const fc = 1100 * Math.sqrt(2 / (D + 0.5)) * rnd.range(0.75, 1.3)
        imp.burst(t, a * 2.4, pan, fc, 1.4, 0.0014 + 0.0012 * D, 0.08)
        if (rnd.chance(0.3)) imp.burst(t, a * 0.25, pan, 4800, 2, 0.0004, 0.2)
        imp.exciteSoft(banks.skin[pan < 0 ? 0 : 1], t, a * 0.17, 1.2)
        break
      }
    }
  }

  const kindFor = (far) => {
    switch (surface) {
      case 'leaves':
        return rnd.chance(0.82) ? 'leaf' : 'ground'
      case 'puddles':
        return rnd.chance(0.8) ? 'puddle' : 'ground'
      case 'pavement':
        return rnd.chance(0.85) ? 'pavement' : 'puddle'
      case 'window':
        return far ? 'ground' : 'glass'
      case 'roof':
        return 'tin'
      case 'tent':
        return 'tent'
      default: {
        const u = rnd.next()
        return u < 0.42 ? 'ground' : u < 0.75 ? 'puddle' : 'leaf'
      }
    }
  }

  // Near drops (half a metre to three metres) and middle-distance drops.
  const onBody = surface === 'roof' || surface === 'tent' || surface === 'window'
  const lamNear = 22 * Math.pow(rate / 5, 0.72) * (surface === 'roof' ? 3.2 : surface === 'tent' ? 2.2 : surface === 'window' ? 1.6 : 1)
  const lamMid = onBody ? 0 : lamNear * 7
  const layers = [
    { lam: lamNear, r0: 0.8, r1: 3, far: false },
    { lam: lamMid, r0: 3, r1: 14, far: true },
  ]
  for (const ly of layers) {
    if (!(ly.lam > 0)) continue
    let t = rnd.exp(1 / (ly.lam * Iat(0)))
    while (t < dur) {
      const D = drawD()
      const r = ly.r0 * Math.pow(ly.r1 / ly.r0, rnd.next())
      // Loudness follows impact energy, gently compressed (the ear and any
      // real microphone never hear the full physical range).
      const a = (Math.pow(dropAmp(D), 0.75) / Math.pow(r, 0.85)) * dropGain * 0.5
      const pan = rnd.bi() * (onBody ? 0.85 : 1)
      renderDrop(kindFor(ly.far), t, D, a, pan, ly.far)
      t += rnd.exp(1 / (ly.lam * Iat(t)))
    }
  }

  // Drip points: big drops falling from eaves, leaves, a gutter or a frame,
  // each with its own wandering rhythm.
  const drips = clamp(o.drips || 0, 0, 1)
  const nDrip = Math.round(drips * 4 + (drips > 0 ? 0.4 : 0))
  for (let k = 0; k < nDrip; k++) {
    const period = rnd.logRange(0.35, 2.4)
    const pan = rnd.bi() * 0.85
    const drift = smoothCurve(m, cr, crnd, 0.08, 2)
    const lvl = rnd.range(0.55, 1) * (1 - 0.6 * dist)
    const ds = o.dripSurface || (surface === 'mixed' || surface === 'puddles' || surface === 'roof' ? 'puddle' : surface === 'leaves' ? 'leaf' : surface)
    let t = rnd.next() * period
    while (t < dur) {
      const D = rnd.range(3.8, 5.5)
      const a = Math.pow(dropAmp(D), 0.5) * lvl * 0.22 * (0.8 + 0.4 * rnd.next())
      if (ds === 'puddle') {
        imp.burst(t, a * 1.1, pan, 3600 * rnd.range(0.8, 1.2), 1, 0.0012, 0.25)
        imp.bubble(t + rnd.range(0.001, 0.003), a * 0.32, pan, rnd.range(480, 1150), rnd.range(0.18, 0.35))
      } else if (ds === 'window') {
        imp.burst(t, a * 1.1, pan, 2400, 1.2, 0.0012, 0.3)
        imp.mode(t, a * 0.22, pan, rnd.range(900, 1500), 0.006)
      } else if (ds === 'tent') {
        renderDrop('tent', t, D, a * 1.2, pan, false)
      } else if (ds === 'leaf') {
        renderDrop('leaf', t, D, a * 1.4, pan, false)
      } else {
        renderDrop('ground', t, D, a * 1.2, pan, false)
      }
      const ci = Math.min(m - 1, Math.floor((t * sr) / HOP))
      t += period * Math.max(0.3, 1 + 0.12 * rnd.gauss() + 0.35 * drift[ci])
    }
  }

  // Wash: dense tiny impacts plus noise, coloured by the surface.
  const w = WASH[surface]
  const washAmp = 0.05 * Math.pow(rate / 5, 0.55) * w.gain * (o.washGain === undefined ? 1 : o.washGain) * (1 + 0.6 * dist)
  const density = clamp(2500 * Math.pow(rate / 5, 0.5), 400, 20000)
  const gcurve = new Float32Array(m)
  for (let i = 0; i < m; i++) gcurve[i] = Math.pow(I[i], 0.6)
  for (let c = 0; c < 2; c++) {
    const s = sizzleArr(n, sr, rnd, density, 0.45)
    eq(s, sr, w.eq)
    applyCurve(s, gcurve, washAmp)
    addInto(c === 0 ? L : R, s)
  }
  // Heavy rain also has a low roar of runoff and far drops.
  if (rate > 6 && !onBody) {
    const g = 0.03 * Math.pow((rate - 6) / 50, 0.7)
    for (let c = 0; c < 2; c++) {
      const s = brownArr(n, rnd, 1, 0.99)
      eq(s, sr, [['lowpass', 380, 0.7], ['highpass', 45, 0.7]])
      applyCurve(s, gcurve, g)
      addInto(c === 0 ? L : R, s)
    }
  }

  // Bodies: a downpour drums on them continuously as well as drop by drop.
  if (banks) {
    if (surface === 'roof') {
      const dens = clamp(900 * Math.pow(rate / 5, 0.7), 80, 12000)
      for (const b of banks.panels) imp.sizzleBank(b, dens, 0.16, I)
      imp.sizzleBank(banks.low, dens, 0.08, I)
    } else if (surface === 'tent') {
      const dens = clamp(500 * Math.pow(rate / 5, 0.7), 50, 8000)
      for (const b of banks.skin) imp.sizzleBank(b, dens, 0.02, I)
    } else if (surface === 'window') {
      imp.sizzleBank(banks.pane, clamp(200 * Math.pow(rate / 5, 0.7), 20, 3000), 0.015, I)
    }
    imp.renderBanks()
  }

  // Distance: the air and everything between takes the highs.
  if (dist > 0.02) {
    const fc = 16000 * Math.pow(1 - dist, 1.6) + 2200
    for (const s of [L, R]) eq(s, sr, [['lowpass', fc, 0.6]])
  }
  return { L, R }
}

// ------------------------------------------------------------------ the bed

const bed = {
  id: 'rain',
  name: 'Rain',
  group: 'weather',
  about: 'Steady rain, close enough to hear the drops, on the ground, puddles and leaves, or a surface you pick.',
  params: [
    { id: 'intensity', name: 'How hard it rains', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    {
      id: 'surface',
      name: 'What it falls on',
      type: 'choice',
      def: 'mixed',
      options: [
        { v: 'mixed', name: 'Ground, puddles and leaves' },
        { v: 'leaves', name: 'Leaves' },
        { v: 'puddles', name: 'Puddles' },
        { v: 'pavement', name: 'Street and pavement' },
        { v: 'window', name: 'A window' },
        { v: 'roof', name: 'A tin roof' },
        { v: 'tent', name: 'A tent' },
      ],
    },
    { id: 'distance', name: 'Distance', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [0, 60] },
    { id: 'drips', name: 'Drips from above', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [0, 80] },
    { id: 'waves', name: 'Comes and goes', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [10, 70] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const { L, R } = rainLayer(n, s.sr, s.rng, {
        intensity: q.intensity,
        surface: q.surface,
        distance: q.distance / 100,
        drips: q.drips / 100,
        waves: q.waves / 100,
      })
      finishBed(L, R, s.sr, -20 + (q.intensity - 50) * 0.08 - q.distance * 0.04)
      return { L, R }
    })
  },
}

export default bed
