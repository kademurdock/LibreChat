// core/hilbert.js - analytic signals and the single-sideband frequency shifter.
//
// Hilbert pair: Olli Niemitalo's polyphase IIR Hilbert transformer
// ("Hilbert transform", yehar.com, 2001). Two parallel chains of four
// second-order allpass sections, each section
//     y[n] = a^2 (x[n] + y[n-2]) - x[n-2],
// with one chain followed by a single sample of delay. The two outputs keep
// equal magnitude (both are allpass) and differ in phase by 90 degrees
// within about 0.7 degrees over nearly the whole band: from roughly
// 0.0008 to 0.498 of the sample rate (about 40 Hz to 23.9 kHz at 48 kHz,
// 7 Hz to 4 kHz at 8 kHz; the test measures it, and the error is still
// under 2 degrees at 20 Hz). The design is relative to the sample rate, so it
// works the same at 8 kHz and at 96 kHz. Both outputs are delayed and phase
// distorted relative to the input in the same way, which is harmless for
// frequency shifting, ring-style effects and envelopes.
//
// Frequency shifter: the Bode / single-sideband method. With the analytic
// pair (re, im), re cos(phi) - im sin(phi) moves every frequency UP by the
// rate of phi, and re cos(phi) + im sin(phi) moves it DOWN. Unlike ring
// modulation there is only one sideband, so harmonic voices turn
// inharmonic: small shifts (1 to 10 Hz) give a swirling, phasing quality;
// tens of hertz give the metallic "radio from another planet" sound. The
// carrier phasor is advanced by a rotation recurrence (one multiply-add
// pair per sample) and renormalised every sample with a first-order
// correction, so it never drifts and needs no per-sample sin or cos. A shift
// given as a function of time is read every 16 samples; the phase stays
// continuous, so moving shifts never click.
//
// analytic(sig) uses the same allpass pair by default (streaming, cheap).
// analytic(sig, { method: 'fft' }) gives the exact analytic signal instead
// (the real part is then the input itself) by zeroing negative frequencies
// of one whole-signal transform; it needs memory for a transform of the
// next power of two above the length, so prefer the default for long takes.

import { FFT, nextPow2 } from './fft.js'

const COEF_A = [0.6923878, 0.9360654322959, 0.988229522686, 0.9987488452737]
const COEF_B = [0.4021921162426, 0.856171088242, 0.9722909545651, 0.9952884791278]
const A2 = new Float64Array(COEF_A.map((a) => a * a))
const B2 = new Float64Array(COEF_B.map((a) => a * a))
const TINY = 1e-25

/**
 * Streaming 90-degree allpass pair. tick(x) sets this.re and this.im
 * (im lags re by 90 degrees, so re + i im is analytic) and returns this.
 */
export class HilbertPair {
  constructor() {
    // Per chain: four sections x (x1, x2, y1, y2).
    this.sa = new Float64Array(16)
    this.sb = new Float64Array(16)
    this.dly = 0
    this.re = 0
    this.im = 0
  }

  tick(x) {
    let a = x > -1e30 && x < 1e30 ? x : 0
    let b = a
    const sa = this.sa
    const sb = this.sb
    for (let k = 0; k < 4; k++) {
      const o = k * 4
      const ya = A2[k] * (a + sa[o + 3]) - sa[o + 1]
      sa[o + 1] = sa[o]
      sa[o] = a
      sa[o + 3] = sa[o + 2]
      sa[o + 2] = ya < TINY && ya > -TINY ? 0 : ya
      a = sa[o + 2]
      const yb = B2[k] * (b + sb[o + 3]) - sb[o + 1]
      sb[o + 1] = sb[o]
      sb[o] = b
      sb[o + 3] = sb[o + 2]
      sb[o + 2] = yb < TINY && yb > -TINY ? 0 : yb
      b = sb[o + 2]
    }
    // Chain A, delayed by one sample, lags chain B by 90 degrees.
    this.re = b
    this.im = this.dly
    this.dly = a
    return this
  }

  reset() {
    this.sa.fill(0)
    this.sb.fill(0)
    this.dly = 0
    this.re = 0
    this.im = 0
    return this
  }
}

/** Whole-signal pair through the allpass chains. */
function analyticIIR(sig) {
  const n = sig.length
  const re = new Float32Array(n)
  const im = new Float32Array(n)
  const h = new HilbertPair()
  for (let i = 0; i < n; i++) {
    h.tick(sig[i])
    re[i] = h.re
    im[i] = h.im
  }
  return { re, im }
}

function analyticFFT(sig) {
  const n = sig.length
  const re = new Float32Array(n)
  const im = new Float32Array(n)
  if (n === 0) return { re, im }
  const N = nextPow2(Math.max(2, n))
  const fft = new FFT(N)
  const xr = new Float64Array(N)
  const xi = new Float64Array(N)
  for (let i = 0; i < n; i++) {
    const v = sig[i]
    xr[i] = v > -1e30 && v < 1e30 ? v : 0
  }
  fft.forward(xr, xi)
  const half = N >> 1
  for (let k = 1; k < half; k++) {
    xr[k] *= 2
    xi[k] *= 2
  }
  for (let k = half + 1; k < N; k++) {
    xr[k] = 0
    xi[k] = 0
  }
  fft.inverse(xr, xi)
  for (let i = 0; i < n; i++) {
    re[i] = xr[i]
    im[i] = xi[i]
  }
  return { re, im }
}

/**
 * Analytic signal { re, im } (Float32Arrays, same length as sig).
 * opts.method: 'iir' (default, allpass pair) or 'fft' (exact, whole signal).
 */
export function analytic(sig, opts = {}) {
  return opts.method === 'fft' ? analyticFFT(sig) : analyticIIR(sig)
}

/** Amplitude envelope |analytic(sig)| as a Float32Array. */
export function envelope(sig, opts = {}) {
  const { re, im } = analytic(sig, opts)
  for (let i = 0; i < re.length; i++) re[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i])
  return re
}

/**
 * Streaming single-sideband frequency shifter (for live chains).
 * process(input, output, n) may run in place; set(hz) changes the shift
 * with a continuous phase.
 */
export class FreqShifter {
  constructor(sr, hz = 0) {
    this.sr = sr
    this.pair = new HilbertPair()
    this.c = 1
    this.s = 0
    this.cd = 1
    this.sd = 0
    this.hz = 0
    this.set(hz)
  }

  set(hz) {
    let h = Number(hz)
    if (!Number.isFinite(h)) h = 0
    const lim = this.sr * 0.5
    if (h > lim) h = lim
    if (h < -lim) h = -lim
    this.hz = h
    const w = (2 * Math.PI * h) / this.sr
    this.cd = Math.cos(w)
    this.sd = Math.sin(w)
    return this
  }

  process(input, output, n = input.length) {
    const p = this.pair
    let c = this.c
    let s = this.s
    const cd = this.cd
    const sd = this.sd
    for (let i = 0; i < n; i++) {
      p.tick(input[i])
      output[i] = p.re * c - p.im * s
      const nc = c * cd - s * sd
      const ns = s * cd + c * sd
      const k = 1.5 - 0.5 * (nc * nc + ns * ns)
      c = nc * k
      s = ns * k
    }
    this.c = c
    this.s = s
    return output
  }

  reset() {
    this.pair.reset()
    this.c = 1
    this.s = 0
    return this
  }
}

/**
 * Shift every frequency in sig by hz (positive up, negative down).
 * hz: a number, a Float32Array of per-sample shifts, or a function of time
 * in seconds (read every 16 samples). Returns a new Float32Array of the
 * same length. Content shifted below 0 Hz folds back as its mirror image,
 * as in every analog Bode shifter.
 */
export function freqShift(sig, sr, hz) {
  if (!(sr > 0)) sr = 48000
  const n = sig.length
  const out = new Float32Array(n)
  const pair = new HilbertPair()
  const lim = sr * 0.5
  const twoPiOverSr = (2 * Math.PI) / sr
  const isFn = typeof hz === 'function'
  const isArr = !isFn && hz && typeof hz.length === 'number'
  let fixed = isFn || isArr ? 0 : Number(hz)
  if (!Number.isFinite(fixed)) fixed = 0
  if (!isFn && !isArr && fixed === 0) {
    // Zero shift still passes through the pair, so latency and phase
    // match a moving shift that happens to rest at zero.
    for (let i = 0; i < n; i++) {
      pair.tick(sig[i])
      out[i] = pair.re
    }
    return out
  }
  let c = 1
  let s = 0
  let cd = 1
  let sd = 0
  let cur = NaN
  for (let i = 0; i < n; i++) {
    let h
    if (isArr) h = hz[i]
    else if (isFn) {
      if ((i & 15) === 0) {
        h = Number(hz(i / sr))
      } else h = cur
    } else h = fixed
    if (h !== cur) {
      let v = h
      if (!Number.isFinite(v)) v = 0
      if (v > lim) v = lim
      if (v < -lim) v = -lim
      cur = h
      const w = v * twoPiOverSr
      cd = Math.cos(w)
      sd = Math.sin(w)
    }
    pair.tick(sig[i])
    out[i] = pair.re * c - pair.im * s
    const nc = c * cd - s * sd
    const ns = s * cd + c * sd
    const k = 1.5 - 0.5 * (nc * nc + ns * ns)
    c = nc * k
    s = ns * k
  }
  return out
}
