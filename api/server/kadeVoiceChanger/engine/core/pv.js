// core/pv.js - phase vocoder time stretching and pitch shifting.
//
// stretch(): the phase vocoder (Flanagan and Golden 1966; Dolson 1986, "The
// phase vocoder: a tutorial") with the identity phase locking of Laroche and
// Dolson 1999, "Improved phase vocoder time-scale modification of audio"
// (IEEE Trans. Speech and Audio Processing 7). Frames are read from the input
// at a hop Ha = Hs / factor and written to the output at a fixed hop Hs, with
// Hann analysis and synthesis windows (Hs = N/4, or N/8 when the factor can
// drop below 0.5, so analysis frames always overlap). For every spectral
// peak (a bin larger than its two neighbours on each side) the instantaneous
// frequency comes from the phase advance since the previous frame, unwrapped
// around the bin's expected advance, and the peak's output phase advances by
// that frequency times Hs. Every other bin in the peak's region of influence
// (bounded by the lowest bins between neighbouring peaks) keeps its analysis
// phase offset from the peak, which holds each partial's shape together and
// removes most of the "phasiness" of the plain phase vocoder.
//
// Transients: onsets are found on the input (5 ms blocks of the first
// difference, which favours broadband attacks; a rise of 9 dB or more over
// the previous blocks' mean, at least 40 ms apart, within 45 dB of the
// loudest block). A phase reset alone cannot keep an attack sharp, because
// every frame whose window holds the attack writes its own copy of it at a
// different output time. So, for a constant factor, the stretch is suspended
// around each onset (the transient-preserving approach of Duxbury, Davies and
// Sandler 2002): every frame whose window touches the onset advances one to
// one and keeps its analysis phases, which rebuilds the attack exactly once,
// and the rest of the signal stretches slightly more so the total length is
// still round(len * factor). Measured on clicks stretched two and four times,
// all of each click's energy stays within 4 ms of its peak (against about 40
// percent with a reset alone). When onsets are so dense that the zones would
// cover most of the signal, and for a factor that varies with time, the
// first frame past each onset gets a phase reset instead.
//
// The window is about 43 ms (2048 points at 44.1 or 48 kHz, scaled with the
// rate), which resolves the harmonics of low voices. Output samples are divided
// by the summed window products, so the gain is exactly one at every sample.
// A factor may be a function of input time in seconds.
//
// pvShift(): pitch shift = stretch by the ratio, then resample by its inverse
// (core/resample.js; a varying ratio uses varispeed along the stretch's own
// time map). keepFormants corrects every frame before resynthesis so the
// spectral envelope ends where it started (or moved by formantRatio): each
// frame's cepstral envelope (core/envelope.js) E is computed and the bins are
// multiplied by E(f * ratio / formantRatio) / E(f), clamped to -30..+40 dB,
// since resampling will then move every frequency by the ratio. (Speech has
// little energy above 5 kHz, so an octave down needs large lifts there.)
// Measured on two real voices from -12 to +12 semitones, the formants stay
// within 0.4 semitones. The stretch inside pvShift uses the same transient
// zones, so consonants stay crisp after a pitch shift too.
//
// findOnsets() is exported for other modules (and core/voice.js uses it to
// keep consonant bursts single). Non-finite input samples count as silence.

import { fftOf } from './fft.js'
import { hann } from './window.js'
import { resample, varispeed } from './resample.js'
import { cepstralEnvelope } from './envelope.js'

const TWO_PI = 2 * Math.PI
const MIN_F = 0.25
const MAX_F = 8

function princarg(p) {
  return p - TWO_PI * Math.round(p / TWO_PI)
}

function clean(sig) {
  for (let i = 0; i < sig.length; i++) {
    const v = sig[i]
    if (!(v === v && v < 1e30 && v > -1e30)) return Float32Array.from(sig, (u) => (u === u && u < 1e30 && u > -1e30 ? u : 0))
  }
  return sig
}

function clampF(f) {
  const x = Number(f)
  if (!(x === x) || x === Infinity || x === -Infinity) return 1
  return x < MIN_F ? MIN_F : x > MAX_F ? MAX_F : x
}

function frameSize(sr, size) {
  if (size) {
    let p = 64
    while (p < size && p < 32768) p <<= 1
    return p
  }
  const e = Math.round(Math.log2(Math.max(64, 0.045 * sr)))
  return Math.max(128, Math.min(16384, 1 << e))
}

/**
 * Onset times (input samples) of broadband attacks.
 * @returns {Int32Array}
 */
export function findOnsets(sig, sr, opts = {}) {
  const n = sig.length
  const block = Math.max(16, Math.round((opts.blockMs || 5) * sr * 0.001))
  const nbk = Math.floor(n / block)
  if (nbk < 2) return new Int32Array(0)
  const lv = new Float64Array(nbk)
  let mx = -300
  let prev = 0
  for (let b = 0; b < nbk; b++) {
    let e = 0
    for (let i = b * block; i < (b + 1) * block; i++) {
      const v = sig[i]
      const dv = v - prev
      prev = v
      e += dv * dv
    }
    lv[b] = 10 * Math.log10(e / block + 1e-20)
    if (lv[b] > mx) mx = lv[b]
  }
  const rise = opts.riseDb || 9
  const floor = mx - (opts.rangeDb || 45)
  const gap = Math.max(1, Math.round(((opts.minGapMs || 40) * sr * 0.001) / block))
  const res = []
  let lastB = -1e9
  for (let b = 1; b < nbk; b++) {
    if (!(lv[b] > floor)) continue
    let m = 0
    let c = 0
    for (let q = Math.max(0, b - 4); q < b; q++) {
      m += Math.pow(10, lv[q] / 10)
      c++
    }
    const ref = 10 * Math.log10(m / c + 1e-20)
    if (lv[b] - ref >= rise && b - lastB >= gap) {
      res.push(b * block + (block >> 1))
      lastB = b
    }
  }
  return Int32Array.from(res)
}

/**
 * Phase-vocoder core. factorAt: number, or function of input seconds.
 * hook(mag, info) may rewrite the magnitudes of each frame before resynthesis.
 * @returns {{ out: Float32Array, centersIn: Float64Array, hop: number, frames: number }}
 */
function pvCore(sig, sr, factorSpec, opts, hook) {
  const len = sig.length
  const N = frameSize(sr, opts && opts.size)
  const nb = (N >> 1) + 1
  const constF = typeof factorSpec === 'number' ? clampF(factorSpec) : null
  const fAt = constF === null ? (p) => clampF(factorSpec(p / sr)) : null
  const plain = constF === 1 // factor exactly one: keep analysis phases
  const onsets = (opts && opts.transients === false) || plain ? new Int32Array(0) : findOnsets(sig, sr)
  // Transient zones (constant factors): every frame whose window touches an
  // onset advances one to one with its analysis phases, so the attack is
  // rebuilt exactly once; the rest stretches a little more to keep the length.
  const zones = []
  let fOut = constF
  let cover = 0
  if (constF !== null && !plain && onsets.length) {
    const half = N >> 1
    for (let q = 0; q < onsets.length; q++) {
      const a = Math.max(0, onsets[q] - half)
      const b = Math.min(len, onsets[q] + half)
      if (zones.length && a <= zones[zones.length - 1][1]) zones[zones.length - 1][1] = b
      else zones.push([a, b])
    }
    for (let q = 0; q < zones.length; q++) cover += zones[q][1] - zones[q][0]
    if (cover > 0 && cover < 0.6 * len) fOut = clampF((len * constF - cover) / (len - cover))
    else zones.length = 0
  }
  // smallest factor decides the synthesis hop
  let minF = constF !== null ? Math.min(constF, fOut) : MAX_F
  if (constF === null) {
    const stepS = Math.max(1, Math.round(sr * 0.01))
    for (let p = 0; p <= len; p += stepS) {
      const f = fAt(p)
      if (f < minF) minF = f
    }
  }
  const Hs = minF >= 0.5 ? N >> 2 : N >> 3
  // schedule of analysis centres, and the output length
  const centers = []
  const inZone = []
  let outLen
  if (constF !== null) {
    outLen = Math.round(len * constF)
    const T = Math.ceil((outLen + N / 2) / Hs) + 1
    if (!zones.length) {
      const Ha = Hs / constF
      for (let t = 0; t <= T; t++) {
        centers.push(t * Ha)
        inZone.push(0)
      }
    } else {
      // the second pass corrects fOut so the input ends where the output does
      for (let pass = 0; pass < 2; pass++) {
        centers.length = 0
        inZone.length = 0
        let p = 0
        let zi = 0
        let cross = -1
        for (let t = 0; t <= T; t++) {
          while (zi < zones.length && zones[zi][1] <= p) zi++
          const zf = zi < zones.length && p >= zones[zi][0] ? 1 : 0
          centers.push(p)
          inZone.push(zf)
          const np = p + (zf ? Hs : Hs / fOut)
          if (cross < 0 && np >= len) cross = (t + (len - p) / (np - p)) * Hs
          p = np
        }
        if (pass === 0 && cross > cover) {
          const want = outLen - cover
          if (want > 0) fOut = clampF((fOut * want) / (cross - cover))
        }
      }
    }
  } else {
    let p = 0
    let t = 0
    outLen = -1
    for (let guard = 0; guard < 1e7; guard++) {
      centers.push(p)
      inZone.push(0)
      const f = fAt(p)
      const np = p + Hs / f
      if (outLen < 0 && np >= len) outLen = Math.round(t * Hs + (len - p) * f)
      p = np
      t++
      if (outLen >= 0 && t * Hs - N / 2 > outLen + Hs) break
    }
    if (outLen < 0) outLen = Math.round(t * Hs)
  }
  const frames = centers.length
  const out = new Float64Array(outLen)
  const norm = new Float64Array(outLen)
  const win = hann(N)
  const fft = fftOf(N)
  const frame = new Float64Array(N)
  const re = new Float64Array(nb)
  const im = new Float64Array(nb)
  const mag = new Float64Array(nb)
  const ph = new Float64Array(nb)
  const prevPh = new Float64Array(nb)
  const syn = new Float64Array(nb)
  const instW = new Float64Array(nb)
  const isPeak = new Uint8Array(nb)
  const peaks = new Int32Array(nb)
  let onIdx = 0
  const info = { frame: 0, inPos: 0, outPos: 0, factor: 1, sr, size: N }
  let prevIp = 0
  for (let t = 0; t < frames; t++) {
    const c = t * Hs
    if (c - N / 2 >= outLen) break
    const pIn = centers[t]
    const ip = Math.round(pIn)
    const start = ip - (N >> 1)
    for (let i = 0; i < N; i++) {
      const k = start + i
      frame[i] = k >= 0 && k < len ? sig[k] * win[i] : 0
    }
    fft.realForward(frame, re, im)
    let mx = 0
    for (let k = 0; k < nb; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      mag[k] = m
      if (m > mx) mx = m
      ph[k] = Math.atan2(im[k], re[k])
    }
    // a phase reset: the first frame, a factor of one, a transient zone, or
    // (with a varying factor) the first frame past an onset
    let reset = t === 0 || plain || inZone[t] === 1
    while (onIdx < onsets.length && onsets[onIdx] <= pIn) {
      if (t > 0 && onsets[onIdx] > centers[t - 1]) reset = true
      onIdx++
    }
    if (reset) {
      for (let k = 0; k < nb; k++) syn[k] = ph[k]
    } else {
      const Ha = ip - prevIp
      if (Ha > 0) {
        for (let k = 0; k < nb; k++) {
          const omega = (TWO_PI * k) / N
          instW[k] = omega + princarg(ph[k] - prevPh[k] - omega * Ha) / Ha
        }
      }
      // peaks: larger than two neighbours on each side, within 80 dB of the frame peak
      const floor = mx * 1e-4
      let np = 0
      isPeak.fill(0)
      for (let k = 2; k < nb - 2; k++) {
        const m = mag[k]
        if (m > floor && m > mag[k - 1] && m >= mag[k + 1] && m > mag[k - 2] && m >= mag[k + 2]) {
          peaks[np++] = k
          isPeak[k] = 1
        }
      }
      if (np === 0) {
        for (let k = 0; k < nb; k++) syn[k] = princarg(syn[k] + Hs * instW[k])
      } else {
        for (let q = 0; q < np; q++) {
          const pk = peaks[q]
          syn[pk] = princarg(syn[pk] + Hs * instW[pk])
        }
        // regions of influence, split at the lowest bin between neighbouring peaks
        let lo = 0
        for (let q = 0; q < np; q++) {
          const pk = peaks[q]
          let hi = nb - 1
          if (q + 1 < np) {
            const nx = peaks[q + 1]
            let mb = pk + 1
            for (let k = pk + 1; k < nx; k++) if (mag[k] < mag[mb]) mb = k
            hi = mb
          }
          const base = syn[pk] - ph[pk]
          for (let k = lo; k <= hi; k++) if (k !== pk) syn[k] = ph[k] + base
          lo = hi + 1
        }
      }
    }
    for (let k = 0; k < nb; k++) prevPh[k] = ph[k]
    prevIp = ip
    if (hook) {
      info.frame = t
      info.inPos = pIn
      info.outPos = c
      info.factor = constF !== null ? constF : fAt(pIn)
      hook(mag, info)
    }
    for (let k = 0; k < nb; k++) {
      const m = mag[k]
      re[k] = m * Math.cos(syn[k])
      im[k] = m * Math.sin(syn[k])
    }
    fft.realInverse(re, im, frame)
    const o0 = c - (N >> 1)
    for (let i = 0; i < N; i++) {
      const j = o0 + i
      if (j < 0 || j >= outLen) continue
      out[j] += frame[i] * win[i]
      norm[j] += win[i] * win[i]
    }
  }
  const res = new Float32Array(outLen)
  let nmax = 0
  for (let i = 0; i < outLen; i++) if (norm[i] > nmax) nmax = norm[i]
  const eps = nmax * 1e-3 + 1e-12
  for (let i = 0; i < outLen; i++) {
    const v = norm[i] > eps ? out[i] / norm[i] : 0
    res[i] = v === v && v < 1e30 && v > -1e30 ? v : 0
  }
  return { out: res, centersIn: Float64Array.from(centers), hop: Hs, frames }
}

/**
 * Change duration by `factor` (2 = twice as long), keeping pitch.
 * @param {Float32Array} sig
 * @param {number} sr
 * @param {number|((tInSeconds:number)=>number)} factor 0.25..8
 * @param {{size?:number, transients?:boolean}} opts
 * @returns {Float32Array} round(len * factor) samples (for a function, the
 *   integral of the factor over the input)
 */
export function stretch(sig, srIn, factor, opts = {}) {
  const sr = Number(srIn) > 0 && Number(srIn) < Infinity ? Number(srIn) : 48000
  const len = sig ? sig.length : 0
  if (len === 0) return new Float32Array(0)
  if (typeof factor === 'number' && Math.abs(clampF(factor) - 1) < 1e-9) return Float32Array.from(sig, (v) => (v === v && v < 1e30 && v > -1e30 ? v : 0))
  return pvCore(clean(sig), sr, typeof factor === 'function' ? factor : clampF(factor), opts || {}, null).out
}

function envelopeHook(sr, N, ratioOf, formantOf, opts) {
  const order = Math.max(8, Math.round((opts.envelopeMs || 1.6) * 0.001 * sr))
  const te = !!opts.trueEnvelope
  const nb = (N >> 1) + 1
  const env = new Float32Array(nb)
  const LO = 0.0316 // -30 dB
  const HI = 100 // +40 dB
  return (mag, info) => {
    cepstralEnvelope(mag, order, { out: env, trueEnvelope: te, iterations: 8 })
    const r = ratioOf(info)
    const fr = formantOf(info)
    const s = r / fr
    for (let k = 0; k < nb; k++) {
      const x = k * s
      const i = Math.floor(x)
      const tv = i >= nb - 1 ? env[nb - 1] : env[i] + (x - i) * (env[i + 1] - env[i])
      const e = env[k]
      let g = e > 1e-30 ? tv / e : 1
      if (!(g > LO)) g = LO
      else if (g > HI) g = HI
      mag[k] *= g
    }
  }
}

function fitLength(y, len) {
  if (y.length === len) return y
  const o = new Float32Array(len)
  o.set(y.length > len ? y.subarray(0, len) : y)
  return o
}

/**
 * Pitch shift by `ratio` (2 = an octave up), duration kept.
 * @param {Float32Array} sig
 * @param {number} sr
 * @param {number|((t:number)=>number)} ratio 0.25..4 (a function of seconds may vary it)
 * @param {{keepFormants?:boolean, formantRatio?:number|((t:number)=>number),
 *   trueEnvelope?:boolean, envelopeMs?:number, size?:number}} opts
 * @returns {Float32Array} same length as sig
 */
export function pvShift(sig, srIn, ratio, opts = {}) {
  const sr = Number(srIn) > 0 && Number(srIn) < Infinity ? Number(srIn) : 48000
  const o = opts || {}
  const len = sig ? sig.length : 0
  if (len === 0) return new Float32Array(0)
  const keep = o.keepFormants !== false
  const frSpec = o.formantRatio === undefined ? 1 : o.formantRatio
  const rConst = typeof ratio === 'function' ? null : Math.min(4, Math.max(0.25, Number(ratio) > 0 ? Number(ratio) : 1))
  const frConst = typeof frSpec === 'function' ? null : Number(frSpec) > 0 ? Number(frSpec) : 1
  const N = frameSize(sr, o.size)
  const rOf = rConst !== null ? () => rConst : (info) => info.factor
  const fOf = frConst !== null ? () => frConst : (info) => Math.min(4, Math.max(0.25, Number(frSpec(info.inPos / sr)) || 1))
  const needHook = keep && !(rConst === 1 && frConst === 1)
  if (rConst === 1 && !needHook) return Float32Array.from(sig, (v) => (v === v && v < 1e30 && v > -1e30 ? v : 0))
  const hook = needHook ? envelopeHook(sr, N, rOf, fOf, o) : null
  if (rConst !== null) {
    const z = pvCore(clean(sig), sr, rConst, o, hook).out
    if (rConst === 1) return fitLength(z, len)
    return fitLength(resample(z, 1 / rConst), len)
  }
  const rFn = (t) => Math.min(4, Math.max(0.25, Number(ratio(t)) || 1))
  const core = pvCore(clean(sig), sr, rFn, o, hook)
  const C = core.centersIn
  const Hs = core.hop
  // input time at stretched-output position q, through the frame schedule
  const inAt = (q) => {
    let t = q / Hs
    if (t < 0) t = 0
    const i = Math.floor(t)
    if (i >= C.length - 1) return C[C.length - 1]
    return C[i] + (t - i) * (C[i + 1] - C[i])
  }
  const y = varispeed(core.out, (qSec) => rFn(inAt(qSec * sr) / sr), sr, { clock: 'in', length: len, stopFade: 0 })
  return fitLength(y, len)
}
