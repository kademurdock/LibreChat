// core/envelope.js - spectral envelopes and linear prediction.
//
// cepstralEnvelope: the real-cepstrum envelope (Oppenheim and Schafer,
// homomorphic deconvolution; Noll 1964). The log magnitude spectrum is
// transformed to the cepstrum, quefrencies above `order` are removed (they
// hold the pitch harmonics' ripple), and the rest is transformed back and
// exponentiated, which gives a smooth curve through the spectrum. The lifter
// is flat up to 80 percent of the order and tapers with a half cosine to
// zero at the order, which avoids the ringing of a hard cut.
//   A plain cepstral envelope runs through the middle of a harmonic spectrum,
//   below the harmonic peaks. With { trueEnvelope: true } it becomes the
//   "true envelope" of Imai and Abe 1979, as revived by Roebel and Rodet 2005
//   ("Efficient spectral envelope estimation and its application to pitch
//   shifting and envelope preservation", DAFx): the log spectrum is replaced
//   by the maximum of itself and the current envelope and smoothed again,
//   until the envelope rides on the harmonic peaks (within tolerance dB) or
//   the iteration limit is reached.
//   Order: 1.5 to 2 ms of quefrency (order = 0.0016 * sr, as core/pv.js uses)
//   gives a plain envelope of speech free of harmonic ripple. For the true
//   envelope use Roebel's order sr / (2 f0): a lower order cannot follow a
//   sharp formant (at 1.6 ms it misses a 60 Hz wide first formant by 4 dB).
//   Work arrays are kept per size and reused, so repeated calls allocate only
//   the returned envelope (or nothing, with opts.out).
//
// warpEnvelope reads an envelope at frequencies divided by a ratio (formant
// shifting in the spectral domain). lpcResidual and lpcSynthesize are the
// inverse and all-pole filters for speech-chip and vocoder effects.
//
// lpc: linear prediction by the autocorrelation method with the
// Levinson-Durbin recursion (Makhoul 1975, "Linear prediction: a tutorial
// review"), in float64. A tiny white-noise correction on r[0] keeps
// near-silent or pure-tone frames well conditioned, and the recursion stops
// early if a reflection coefficient ever reaches magnitude 1, so the filter
// is always stable. Convention: A(z) = 1 + a1 z^-1 + ... + ap z^-p and the
// prediction error is e[n] = sum_j a[j] x[n - j] with a[0] = 1. err is the
// total squared error over the frame, so sqrt(err) / |A| has the same scale
// as the magnitude of the frame's (unnormalised) FFT.
//
// lpcEnvelope: that all-pole model's magnitude at evenly spaced bins from 0 to
// Nyquist, by FFT of the zero-padded coefficients when the size allows,
// otherwise by direct evaluation.
//
// Spectra here are arrays of n/2 + 1 magnitudes (the core/fft.js rfft layout).

import { fftOf, nextPow2 } from './fft.js'

const WORK = new Map()

function workFor(N) {
  let w = WORK.get(N)
  if (!w) {
    const nb = (N >> 1) + 1
    w = {
      logA: new Float64Array(nb),
      logO: new Float64Array(nb),
      zero: new Float64Array(nb),
      ceps: new Float64Array(N),
      sRe: new Float64Array(nb),
      sIm: new Float64Array(nb),
    }
    WORK.set(N, w)
  }
  return w
}

function linInterp(src, nbOut) {
  const nbIn = src.length
  const out = new Float64Array(nbOut)
  const sc = (nbIn - 1) / Math.max(1, nbOut - 1)
  for (let k = 0; k < nbOut; k++) {
    const x = k * sc
    const i = Math.floor(x)
    const t = x - i
    out[k] = i + 1 < nbIn ? src[i] * (1 - t) + src[i + 1] * t : src[nbIn - 1]
  }
  return out
}

/**
 * Smooth magnitude envelope of a magnitude spectrum.
 * @param {Float32Array|Float64Array} mag n/2+1 magnitudes (linear)
 * @param {number} order cepstral coefficients kept (quefrency cut-off, samples)
 * @param {{trueEnvelope?:boolean, iterations?:number, toleranceDb?:number,
 *   floorDb?:number, out?:Float32Array}} opts
 * @returns {Float32Array} envelope magnitudes, same length as mag
 */
export function cepstralEnvelope(mag, order, opts = {}) {
  const nb = mag.length
  const out = opts.out && opts.out.length === nb ? opts.out : new Float32Array(nb)
  if (nb < 3) {
    for (let k = 0; k < nb; k++) out[k] = Math.abs(Number(mag[k]) || 0)
    return out
  }
  let N = 2 * (nb - 1)
  let src = mag
  let resampled = false
  if ((N & (N - 1)) !== 0) {
    N = nextPow2(N)
    src = linInterp(mag, (N >> 1) + 1)
    resampled = true
  }
  const nbw = (N >> 1) + 1
  const w = workFor(N)
  let mx = 0
  for (let k = 0; k < nbw; k++) {
    const v = Math.abs(src[k])
    if (v > mx && v < Infinity) mx = v
  }
  if (!(mx > 0)) {
    out.fill(0)
    return out
  }
  const floor = mx * Math.pow(10, (opts.floorDb !== undefined ? -Math.abs(opts.floorDb) : -120) / 20)
  for (let k = 0; k < nbw; k++) {
    let v = Math.abs(src[k])
    if (!(v > floor) || v === Infinity) v = floor
    w.logO[k] = Math.log(v)
    w.logA[k] = w.logO[k]
  }
  let q = Math.round(Number(order) || 0)
  if (q < 1) q = 1
  if (q > nbw - 2) q = nbw - 2
  const flat = Math.floor(q * 0.8)
  const iters = opts.trueEnvelope ? Math.max(1, Math.min(200, Math.round(opts.iterations || 24))) : 1
  const tol = (opts.toleranceDb !== undefined ? opts.toleranceDb : 1) * (Math.LN10 / 20)
  const fft = fftOf(N)
  for (let it = 0; it < iters; it++) {
    fft.realInverse(w.logA, w.zero, w.ceps)
    const c = w.ceps
    for (let i = 0; i < N; i++) {
      const d = i <= N - i ? i : N - i
      if (d <= flat) continue
      if (d >= q) c[i] = 0
      else c[i] *= 0.5 + 0.5 * Math.cos((Math.PI * (d - flat)) / (q - flat))
    }
    fft.realForward(c, w.sRe, w.sIm)
    if (iters === 1) break
    let worst = 0
    for (let k = 0; k < nbw; k++) {
      const s = w.sRe[k]
      const e = w.logO[k] - s
      if (e > worst) worst = e
      w.logA[k] = w.logO[k] > s ? w.logO[k] : s
    }
    if (worst < tol) break
  }
  if (!resampled) {
    for (let k = 0; k < nb; k++) out[k] = Math.exp(w.sRe[k])
  } else {
    const sc = (nbw - 1) / (nb - 1)
    for (let k = 0; k < nb; k++) {
      const x = k * sc
      const i = Math.floor(x)
      const t = x - i
      const v = i + 1 < nbw ? w.sRe[i] * (1 - t) + w.sRe[i + 1] * t : w.sRe[nbw - 1]
      out[k] = Math.exp(v)
    }
  }
  return out
}

/**
 * Envelope read at frequencies divided by ratio: out[k] = env(k / ratio),
 * so ratio 1.2 moves every formant up by 20 percent. Linear interpolation;
 * past the top the last value holds.
 */
export function warpEnvelope(env, ratio, out) {
  const nb = env.length
  const o = out && out.length === nb ? out : new Float32Array(nb)
  const r = Number(ratio) > 0 ? Number(ratio) : 1
  for (let k = 0; k < nb; k++) {
    const x = k / r
    const i = Math.floor(x)
    if (i >= nb - 1) o[k] = env[nb - 1]
    else {
      const t = x - i
      o[k] = env[i] * (1 - t) + env[i + 1] * t
    }
  }
  return o
}

/**
 * Linear prediction coefficients of a frame (autocorrelation method).
 * @param {Float32Array|Float64Array} frame (window it first if you want a window,
 *   or pass opts.window = 'hann' | 'hamming')
 * @param {number} order
 * @param {{window?:string, noiseFloor?:number}} opts
 * @returns {{ a: Float64Array, err: number, k: Float64Array }}
 *   a[0] = 1; k holds the reflection (PARCOR) coefficients.
 */
export function lpc(frame, order, opts = {}) {
  const n = frame ? frame.length : 0
  let p = Math.floor(Number(order) || 0)
  if (p < 1) p = 1
  const a = new Float64Array(p + 1)
  const kk = new Float64Array(p)
  a[0] = 1
  if (n === 0) return { a, err: 0, k: kk }
  let x = frame
  const wname = opts.window ? String(opts.window).toLowerCase() : ''
  if (wname === 'hann' || wname === 'hamming' || !(isFiniteArray(frame))) {
    x = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      let v = Number(frame[i])
      if (!(v === v) || v === Infinity || v === -Infinity) v = 0
      let wv = 1
      if (wname === 'hann') wv = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n)
      else if (wname === 'hamming') wv = 0.54 - 0.46 * Math.cos((2 * Math.PI * (i + 0.5)) / n)
      x[i] = v * wv
    }
  }
  const r = new Float64Array(p + 1)
  for (let lag = 0; lag <= p; lag++) {
    let s = 0
    for (let i = lag; i < n; i++) s += x[i] * x[i - lag]
    r[lag] = s
  }
  const nf = opts.noiseFloor !== undefined ? Math.max(0, Number(opts.noiseFloor) || 0) : 1e-9
  r[0] *= 1 + nf
  let err = r[0]
  if (!(err > 1e-300)) return { a, err: 0, k: kk }
  const tmp = new Float64Array(p + 1)
  for (let i = 1; i <= p; i++) {
    let acc = r[i]
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j]
    const ki = -acc / err
    if (!(ki > -1 && ki < 1)) break
    kk[i - 1] = ki
    for (let j = 0; j < i; j++) tmp[j] = a[j]
    for (let j = 1; j < i; j++) a[j] = tmp[j] + ki * tmp[i - j]
    a[i] = ki
    err *= 1 - ki * ki
    if (!(err > 0)) {
      err = 0
      break
    }
  }
  return { a, err, k: kk }
}

function isFiniteArray(x) {
  for (let i = 0; i < x.length; i++) {
    const v = x[i]
    if (!(v === v) || v === Infinity || v === -Infinity) return false
  }
  return true
}

/**
 * Magnitude of the all-pole model sqrt(err) / |A(e^jw)| at nBins evenly
 * spaced frequencies from 0 to Nyquist inclusive.
 * @returns {Float32Array}
 */
export function lpcEnvelope(a, err, nBins) {
  const nb = Math.max(1, Math.floor(nBins) || 1)
  const out = new Float32Array(nb)
  const p = a.length - 1
  const g = Math.sqrt(err > 0 ? err : 0)
  if (nb === 1) {
    let s = 0
    for (let j = 0; j <= p; j++) s += a[j]
    out[0] = g / Math.max(Math.abs(s), 1e-12)
    return out
  }
  const N = 2 * (nb - 1)
  if ((N & (N - 1)) === 0 && N >= 2 * (p + 1) && N >= 4) {
    const fft = fftOf(N)
    const buf = new Float64Array(N)
    for (let j = 0; j <= p; j++) buf[j] = a[j]
    const re = new Float64Array(nb)
    const im = new Float64Array(nb)
    fft.realForward(buf, re, im)
    for (let k = 0; k < nb; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      out[k] = g / (m > 1e-12 ? m : 1e-12)
    }
    return out
  }
  for (let k = 0; k < nb; k++) {
    const w = (Math.PI * k) / (nb - 1)
    let rr = 0
    let ii = 0
    for (let j = 0; j <= p; j++) {
      rr += a[j] * Math.cos(w * j)
      ii -= a[j] * Math.sin(w * j)
    }
    const m = Math.sqrt(rr * rr + ii * ii)
    out[k] = g / (m > 1e-12 ? m : 1e-12)
  }
  return out
}

/** Prediction residual e[n] = sum_j a[j] x[n-j] (inverse filter), new array. */
export function lpcResidual(sig, a) {
  const n = sig.length
  const p = a.length - 1
  const e = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = sig[i]
    const top = i < p ? i : p
    for (let j = 1; j <= top; j++) s += a[j] * sig[i - j]
    e[i] = s
  }
  return e
}

/**
 * All-pole synthesis y[n] = gain * x[n] - sum_j a[j] y[n-j], new array.
 * state (optional Float64Array of length p) carries the filter memory
 * between blocks, newest first.
 */
export function lpcSynthesize(exc, a, gain = 1, state) {
  const n = exc.length
  const p = a.length - 1
  const y = new Float32Array(n)
  const mem = state && state.length >= p ? state : new Float64Array(p)
  for (let i = 0; i < n; i++) {
    let s = gain * exc[i]
    for (let j = 1; j <= p; j++) s -= a[j] * mem[j - 1]
    if (!(s > -1e6 && s < 1e6)) s = 0
    else if (s < 1e-25 && s > -1e-25) s = 0
    for (let j = p - 1; j > 0; j--) mem[j] = mem[j - 1]
    if (p > 0) mem[0] = s
    y[i] = s
  }
  return y
}
