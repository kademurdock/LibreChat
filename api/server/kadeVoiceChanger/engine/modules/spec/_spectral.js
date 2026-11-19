// modules/spec/_spectral.js - shared tools for the spectral family. This file is
// NOT an effect: it has no default export, and the registry should skip any
// file whose name starts with an underscore.
//
// What lives here, and where each technique comes from:
// - frameSize(): FFT sizes chosen by duration rather than by sample count, so an
//   effect sounds the same at 8 kHz and at 96 kHz.
// - princarg() and trueFrequencies(): the phase vocoder's instantaneous
//   frequency estimate from the phase advance between frames (Flanagan and
//   Golden 1966, "Phase vocoder"; Dolson 1986, "The phase vocoder: a tutorial").
// - PeakWarp: peak-region spectral warping with identity phase locking, after
//   Laroche and Dolson 1999, "New phase-vocoder techniques for real-time pitch
//   shifting, chorusing, harmonizing and other exotic audio modifications"
//   (JAES 47(11)). Each spectral peak moves with the bins around it as one
//   block, and the block is rotated by its accumulated phase increment, so
//   moved partials stay clean sinusoids.
// - addPartial(): inverse-FFT additive synthesis (Rodet and Depalle 1992,
//   "Spectral envelopes and inverse FFT synthesis", AES 93rd Convention): a
//   sinusoid is written straight into a frame's spectrum as the main lobe of
//   the Hann window's transform, W(d) = (N/2) e^(-i pi d) sinc(d) / (1 - d^2).
// - noiseOlaGain(): level correction for frames whose phases are randomised.
//   A random-phase frame spreads its energy over the whole frame instead of
//   following the analysis window, so overlap-add of such frames comes out
//   quieter by a fixed, computable factor (2 for Hann/Hann at a quarter hop).
// - multiSpectral(): weighted overlap-add over several signals in lock step.
//   core/stft.js spectralProcess handles one signal; cross-synthesis needs the
//   voice and a second sound frame by frame. It uses exactly the same frame
//   layout and window-sum normalisation as core/stft.js (Crochiere 1980), with
//   Float32 accumulators and, for flat-overlap windows, one constant instead
//   of a per-sample window-sum array, to keep phone memory down.
// - StreamSTFT: a streaming short-time Fourier engine for live mode. Fixed hop,
//   no allocation per sample or per frame, latency of exactly one frame.
// - readSide(): reads ctx.side (CONTRACT "the other sound") defensively: it
//   loops or trims to the needed length and resamples when the rate differs.

import { FFT } from '../../core/fft.js'
import { hann } from '../../core/window.js'
import { resampleTo } from '../../core/resample.js'
import { makeRng } from '../../core/rng.js'

export const TWO_PI = 2 * Math.PI

/** Power-of-two FFT size closest (in log terms) to `ms` milliseconds at sr. */
export function frameSize(sr, ms, min = 64, max = 32768) {
  const target = Math.max(16, (sr * ms) / 1000)
  let n = 1 << Math.round(Math.log2(target))
  if (n < min) n = min
  if (n > max) n = max
  return n
}

/** Largest power of two whose length stays at or under `ms` milliseconds (live sizes). */
export function frameSizeAtMost(sr, ms, min = 32, max = 4096) {
  let n = min
  while (n * 2 <= max && ((n * 2) * 1000) / sr <= ms) n *= 2
  return n
}

// Random unit phasors without trig per bin: 4096 evenly spaced angles (a
// 0.09 degree grid, far finer than anything a random phase can reveal).
const PH_N = 4096
export const PH_COS = new Float64Array(PH_N)
export const PH_SIN = new Float64Array(PH_N)
for (let i = 0; i < PH_N; i++) {
  PH_COS[i] = Math.cos((TWO_PI * i) / PH_N)
  PH_SIN[i] = Math.sin((TWO_PI * i) / PH_N)
}
/** Index of a random phasor in PH_COS / PH_SIN, from rng.next(). */
export function randPhase(rng) {
  return (rng.next() * PH_N) | 0
}

/** Wrap a phase to -pi..pi. */
export function princarg(x) {
  return x - TWO_PI * Math.round(x / TWO_PI)
}

/** rng from the stage context, or a fixed fallback so calls stay deterministic. */
export function rngOf(ctx, label) {
  if (ctx && ctx.rng && typeof ctx.rng.next === 'function') return ctx.rng
  return makeRng(label || 'spec')
}

/** Report progress 0..1 when the host asked for it. */
export function progressTo(ctx, f) {
  if (ctx && typeof ctx.progress === 'function') {
    try {
      ctx.progress(f < 0 ? 0 : f > 1 ? 1 : f)
    } catch {
      // a host's progress callback must never break a render
    }
  }
}

/** True when the host asked to stop. */
export function stopAsked(ctx) {
  if (!ctx || typeof ctx.cancelled !== 'function') return false
  try {
    return !!ctx.cancelled()
  } catch {
    return false
  }
}

/** Pass a plain sentence to the render report. */
export function noteTo(ctx, msg) {
  if (ctx && typeof ctx.note === 'function') {
    try {
      ctx.note(msg)
    } catch {
      // notes are advisory
    }
  }
}

/**
 * Replace NaN, Infinity and float32 denormals with 0, in place, and fold any
 * sample beyond +12 dBFS (4.0) smoothly under 7.5 (a tanh knee). Normal
 * material never gets near it; it only stops pathological inputs (full-scale
 * noise into a sparse pulse train, say) from breaking the "peak under 8"
 * contract before the final limiter.
 */
export function cleanSig(s) {
  for (let i = 0; i < s.length; i++) {
    const v = s[i]
    if (!(v > -1e30 && v < 1e30) || (v < 1e-30 && v > -1e-30)) s[i] = 0
    else if (v > 4) s[i] = 4 + 3.5 * Math.tanh((v - 4) / 3.5)
    else if (v < -4) s[i] = -4 - 3.5 * Math.tanh((-v - 4) / 3.5)
  }
  return s
}

/** A buffer whose channels are fresh copies of `sig` padded with `extra` zeros. */
export function padSig(sig, extra) {
  const out = new Float32Array(sig.length + Math.max(0, extra | 0))
  out.set(sig)
  return out
}

/** Equal-power style dry/wet blend: out = wet*m + dry*(1-m), in place into wet. */
export function blendInto(wet, dry, m) {
  if (m >= 1) return wet
  const a = m <= 0 ? 0 : m
  const b = 1 - a
  const n = Math.min(wet.length, dry.length)
  for (let i = 0; i < n; i++) wet[i] = wet[i] * a + dry[i] * b
  for (let i = n; i < wet.length; i++) wet[i] *= a
  return wet
}

/**
 * Overlap-add level correction for frames whose phases are randomised, for a
 * window w used on both sides at hop `hop`, with exact window-sum division.
 */
export function noiseOlaGain(w, hop) {
  const N = w.length
  let mw2 = 0
  for (let i = 0; i < N; i++) mw2 += w[i] * w[i]
  mw2 /= N
  // window sums at a sample in the steady middle (averaged over one hop)
  let sww = 0
  let sw2 = 0
  for (let n = 0; n < hop; n++) {
    let a = 0
    for (let k = n; k < N; k += hop) a += w[k] * w[k]
    sww += a
    sw2 += a
  }
  sww /= hop
  sw2 /= hop
  // output variance = sigma^2 * mw2 * sw2 / sww^2 ; undo it
  return Math.sqrt((sww * sww) / (sw2 * mw2))
}

/** Constant overlap sum of w*w at hop (1.5 for periodic Hann at a quarter hop). */
export function olaSum(w, hop) {
  const N = w.length
  let s = 0
  for (let n = 0; n < hop; n++) {
    for (let k = n; k < N; k += hop) s += w[k] * w[k]
  }
  return s / hop
}

// ------------------------------------------------------------ phase vocoder

/**
 * Magnitudes, phases and true frequencies (radians per sample) of a frame.
 * prevPh holds the previous frame's phases and is updated. first=true uses the
 * bin centre frequencies.
 */
export function trueFrequencies(re, im, N, hop, prevPh, mag, ph, omega, first) {
  const nb = (N >> 1) + 1
  const binW = TWO_PI / N
  for (let k = 0; k < nb; k++) {
    const a = re[k]
    const b = im[k]
    mag[k] = Math.sqrt(a * a + b * b)
    const p = Math.atan2(b, a)
    ph[k] = p
    if (first) omega[k] = k * binW
    else {
      const expect = k * binW * hop
      let d = p - prevPh[k] - expect
      d -= TWO_PI * Math.round(d / TWO_PI)
      omega[k] = k * binW + d / hop
    }
    prevPh[k] = p
  }
}

/**
 * Peak-region warping (Laroche and Dolson 1999). warp.map(omega) returns the
 * new frequency in radians per sample (or a negative number to drop that
 * peak). With env (an envelope Float32Array), every moved bin is re-weighted
 * by env[target] / env[source] so the formants stay where they were.
 */
export class PeakWarp {
  constructor(N, hop) {
    const nb = (N >> 1) + 1
    this.N = N
    this.hop = hop
    this.nb = nb
    this.prevPh = new Float64Array(nb)
    this.rotPrev = new Float64Array(nb)
    this.rotNew = new Float64Array(nb)
    this.mag = new Float64Array(nb)
    this.ph = new Float64Array(nb)
    this.omega = new Float64Array(nb)
    this.oRe = new Float64Array(nb)
    this.oIm = new Float64Array(nb)
    this.peaks = new Int32Array(nb)
    this.first = true
  }

  reset() {
    this.prevPh.fill(0)
    this.rotPrev.fill(0)
    this.first = true
  }

  run(re, im, warp, env) {
    const { N, hop, nb, mag, omega, oRe, oIm, peaks, rotPrev, rotNew } = this
    trueFrequencies(re, im, N, hop, this.prevPh, mag, this.ph, omega, this.first)
    this.first = false
    let mx = 0
    for (let k = 1; k < nb - 1; k++) if (mag[k] > mx) mx = mag[k]
    oRe.fill(0)
    oIm.fill(0)
    rotNew.fill(0)
    if (!(mx > 1e-12)) {
      for (let k = 0; k < nb; k++) {
        re[k] = 0
        im[k] = 0
      }
      const t = this.rotPrev
      this.rotPrev = rotNew
      this.rotNew = t
      return
    }
    const floor = mx * 1e-5
    let np = 0
    for (let k = 2; k < nb - 2; k++) {
      const m = mag[k]
      if (m > floor && m > mag[k - 1] && m >= mag[k + 1] && m > mag[k - 2] && m >= mag[k + 2]) peaks[np++] = k
    }
    const toBin = N / TWO_PI
    let lo = 1
    for (let q = 0; q < np; q++) {
      const p = peaks[q]
      // region ends at the quietest bin between this peak and the next
      let hi = nb - 2
      if (q + 1 < np) {
        const p2 = peaks[q + 1]
        let best = p
        let bm = Infinity
        for (let k = p + 1; k < p2; k++) {
          if (mag[k] < bm) {
            bm = mag[k]
            best = k
          }
        }
        hi = best
      }
      const wp = omega[p]
      const wt = warp.map(wp)
      if (wt > 0 && wt < Math.PI) {
        const dk = Math.round((wt - wp) * toBin)
        let th = rotPrev[p] + (wt - wp) * hop
        th -= TWO_PI * Math.round(th / TWO_PI)
        const c = Math.cos(th)
        const s = Math.sin(th)
        for (let k = lo; k <= hi; k++) {
          rotNew[k] = th
          const kt = k + dk
          if (kt < 1 || kt > nb - 2) continue
          let g = 1
          if (env) {
            const es = env[k]
            g = es > 1e-30 ? env[kt] / es : 0
            if (g > 16) g = 16
          }
          const a = re[k]
          const b = im[k]
          oRe[kt] += g * (a * c - b * s)
          oIm[kt] += g * (a * s + b * c)
        }
      }
      lo = hi + 1
    }
    for (let k = 0; k < nb; k++) {
      re[k] = oRe[k]
      im[k] = oIm[k]
    }
    re[0] = 0
    im[0] = 0
    im[nb - 1] = 0
    re[nb - 1] = 0
    const t = this.rotPrev
    this.rotPrev = rotNew
    this.rotNew = t
  }
}

// ------------------------------------------------------------ additive synthesis

/**
 * Add amp * cos(2 pi f n / sr + phase) (f = bin * sr / N, phase at the frame's
 * first sample) to a Hann-windowed frame spectrum, as the window transform's
 * main lobe. Neighbouring bins alternate in sign, so only three trig calls are
 * needed per partial.
 */
export function addPartial(re, im, N, bin, amp, phase) {
  const nb = (N >> 1) + 1
  if (!(bin > 0.5) || bin >= nb - 1.5 || !(amp > 0)) return
  const k0 = Math.floor(bin) - 1
  const scale = amp * N * 0.25
  let d = k0 - bin
  let ph = phase - Math.PI * d
  let c = Math.cos(ph)
  let s = Math.sin(ph)
  let sp = Math.sin(Math.PI * d)
  for (let j = 0; j < 4; j++, d += 1) {
    const k = k0 + j
    if (k >= 1 && k < nb - 1) {
      const ad = d < 0 ? -d : d
      let g
      if (ad < 1e-7) g = 1
      else if (ad > 1 - 1e-7 && ad < 1 + 1e-7) g = 0.5
      else if (ad >= 2) g = 0
      else g = sp / (Math.PI * d * (1 - d * d))
      if (g !== 0) {
        re[k] += scale * g * c
        im[k] += scale * g * s
      }
    }
    c = -c
    s = -s
    sp = -sp
  }
}

/** Peak-bin gain of the Hann main lobe at fractional offset d (1 at d = 0). */
export function lobeGain(d) {
  const ad = d < 0 ? -d : d
  if (ad < 1e-7) return 1
  if (ad > 1 - 1e-7 && ad < 1 + 1e-7) return 0.5
  if (ad >= 2) return 0
  return Math.sin(Math.PI * d) / (Math.PI * d * (1 - d * d))
}

// ------------------------------------------------------------ lock-step STFT

/**
 * Weighted overlap-add over several input signals at once (all the same
 * length), producing nOut outputs. cb(ins, outs, frame, info) receives arrays
 * of { re, im } (n/2+1 bins); outs start zeroed each frame. Hann on both sides
 * by default; exact window-sum normalisation as in core/stft.js.
 * Returns an array of Float32Array outputs, each the input length.
 */
export function multiSpectral(ins, nOut, opts, cb, ctx, progBase = 0, progSpan = 1) {
  const len = ins.length ? ins[0].length : 0
  const outs = []
  if (len === 0) {
    for (let o = 0; o < nOut; o++) outs.push(new Float32Array(0))
    return outs
  }
  const N = opts.size
  const hop = opts.hop || N >> 2
  const pad = N - hop
  const w = opts.window || hann(N)
  const fft = new FFT(N)
  const nb = (N >> 1) + 1
  const frames = Math.floor((len - 1 + pad) / hop) + 1
  const inSpec = ins.map(() => ({ re: new Float64Array(nb), im: new Float64Array(nb) }))
  const outSpec = []
  const acc = []
  for (let o = 0; o < nOut; o++) {
    outSpec.push({ re: new Float64Array(nb), im: new Float64Array(nb) })
    // Float32 accumulators: half the memory of core/stft.js, which matters for
    // long stereo takes on a phone; the rounding is far below hearing
    acc.push(new Float32Array(len))
  }
  // With this frame layout every sample lies under the full set of frames, so
  // for a window whose squared overlap is flat (Hann at a quarter hop) the
  // window sum is one constant and no per-sample array is needed.
  let lo = Infinity
  let hi = 0
  for (let n = 0; n < hop; n++) {
    let a = 0
    for (let k = n; k < N; k += hop) a += w[k] * w[k]
    if (a < lo) lo = a
    if (a > hi) hi = a
  }
  const flat = lo > 0 && hi / lo < 1 + 1e-9
  const norm = flat ? null : new Float32Array(len)
  const frame = new Float64Array(N)
  const info = { start: 0, center: 0, size: N, hop, frames }
  const every = Math.max(1, Math.floor(frames / 20))
  for (let f = 0; f < frames; f++) {
    const start = f * hop - pad
    const i0 = start < 0 ? -start : 0
    const i1 = start + N > len ? len - start : N
    for (let s = 0; s < ins.length; s++) {
      const sig = ins[s]
      for (let i = 0; i < i0; i++) frame[i] = 0
      for (let i = i0; i < i1; i++) frame[i] = sig[start + i] * w[i]
      for (let i = i1; i < N; i++) frame[i] = 0
      fft.realForward(frame, inSpec[s].re, inSpec[s].im)
    }
    for (let o = 0; o < nOut; o++) {
      outSpec[o].re.fill(0)
      outSpec[o].im.fill(0)
    }
    info.start = start
    info.center = start + (N >> 1)
    cb(inSpec, outSpec, f, info)
    for (let o = 0; o < nOut; o++) {
      fft.realInverse(outSpec[o].re, outSpec[o].im, frame)
      const a = acc[o]
      for (let i = i0; i < i1; i++) a[start + i] += frame[i] * w[i]
    }
    if (norm) for (let i = i0; i < i1; i++) norm[start + i] += w[i] * w[i]
    if (f % every === 0) {
      progressTo(ctx, progBase + (progSpan * f) / frames)
      if (stopAsked(ctx)) break
    }
  }
  if (flat) {
    const g = 1 / lo
    for (let o = 0; o < nOut; o++) {
      const a = acc[o]
      for (let i = 0; i < len; i++) {
        const v = a[i] * g
        a[i] = v > -1e30 && v < 1e30 ? v : 0
      }
      outs.push(a)
    }
    return outs
  }
  let mx = 0
  for (let i = 0; i < len; i++) if (norm[i] > mx) mx = norm[i]
  const eps = mx * 1e-9 + 1e-30
  for (let o = 0; o < nOut; o++) {
    const a = acc[o]
    for (let i = 0; i < len; i++) {
      const v = norm[i] > eps ? a[i] / norm[i] : 0
      a[i] = v > -1e30 && v < 1e30 ? v : 0
    }
    outs.push(a)
  }
  return outs
}

// ------------------------------------------------------------ live STFT

/**
 * Streaming STFT with a fixed hop. tick(x, owner) takes one input sample and
 * returns one output sample delayed by exactly N samples; whenever a frame is
 * complete it calls owner.spectrum(re, im) to edit the frame's n/2+1 bins in
 * place. Nothing is allocated after construction.
 */
export class StreamSTFT {
  constructor(N, hop) {
    this.N = N
    this.hop = hop
    this.nb = (N >> 1) + 1
    this.fft = new FFT(N)
    this.w = hann(N)
    this.invNorm = 1 / olaSum(this.w, hop)
    this.inBuf = new Float64Array(N)
    this.outBuf = new Float64Array(N)
    this.frame = new Float64Array(N)
    this.re = new Float64Array(this.nb)
    this.im = new Float64Array(this.nb)
    this.count = 0
  }

  reset() {
    this.inBuf.fill(0)
    this.outBuf.fill(0)
    this.count = 0
  }

  tick(x, owner) {
    const N = this.N
    const hop = this.hop
    this.inBuf[N - hop + this.count] = x > -1e30 && x < 1e30 ? x : 0
    const y = this.outBuf[this.count]
    this.count++
    if (this.count === hop) {
      this.count = 0
      const { inBuf, outBuf, frame, w, re, im } = this
      for (let i = 0; i < N; i++) frame[i] = inBuf[i] * w[i]
      this.fft.realForward(frame, re, im)
      owner.spectrum(re, im)
      this.fft.realInverse(re, im, frame)
      outBuf.copyWithin(0, hop)
      outBuf.fill(0, N - hop)
      const g = this.invNorm
      for (let i = 0; i < N; i++) {
        const v = outBuf[i] + frame[i] * w[i] * g
        outBuf[i] = v > -1e30 && v < 1e30 && (v > 1e-30 || v < -1e-30) ? v : 0
      }
      inBuf.copyWithin(0, hop)
    }
    return y
  }
}

/** A dry-path delay of D samples for live mixing (allocation-free per sample). */
export class DryDelay {
  constructor(D) {
    this.D = Math.max(0, D | 0)
    this.buf = new Float32Array(this.D + 1)
    this.i = 0
  }

  tick(x) {
    if (this.D === 0) return x
    const y = this.buf[this.i]
    this.buf[this.i] = x
    this.i++
    if (this.i >= this.D) this.i = 0
    return y
  }

  reset() {
    this.buf.fill(0)
    this.i = 0
  }
}

// ------------------------------------------------------------ the other sound

/**
 * The other sound (ctx.side) as an array of channels at `sr` and exactly `len`
 * samples long, or null when the host gave none (or it is silent). Shorter
 * sounds loop with a short equal-power crossfade; longer ones are trimmed.
 */
export function readSide(ctx, len, sr) {
  const side = ctx && ctx.side
  if (!side || !Array.isArray(side.ch) || !side.ch.length || !(side.ch[0] && side.ch[0].length)) return null
  let chans = side.ch.slice(0, 2).map((c) => (c instanceof Float32Array ? c : Float32Array.from(c)))
  if (side.sr > 0 && sr > 0 && side.sr !== sr) chans = chans.map((c) => resampleTo(c, side.sr, sr))
  let energy = 0
  for (const c of chans) for (let i = 0; i < c.length; i += 7) energy += c[i] * c[i]
  if (!(energy > 1e-12)) return null
  return chans.map((c) => fitLength(c, len, sr))
}

/** Loop (equal-power crossfade) or trim a signal to exactly len samples. */
export function fitLength(c, len, sr) {
  if (c.length === len) return new Float32Array(c)
  const out = new Float32Array(len)
  if (c.length >= len) {
    out.set(c.subarray(0, len))
    return out
  }
  const xf = Math.min(Math.floor(c.length / 3), Math.round(0.25 * sr))
  const step = c.length - xf
  if (step <= 0) {
    for (let i = 0; i < len; i++) out[i] = c[i % c.length]
    return out
  }
  for (let pos = 0; pos < len; pos += step) {
    for (let i = 0; i < c.length && pos + i < len; i++) {
      let g = 1
      if (pos > 0 && i < xf) g = Math.sin((0.5 * Math.PI * (i + 0.5)) / xf)
      if (i >= c.length - xf && pos + step < len) g *= Math.cos((0.5 * Math.PI * (i - (c.length - xf) + 0.5)) / xf)
      out[pos + i] += c[i] * g
    }
  }
  return out
}

/** RMS of a signal (finite samples only). */
export function sigRms(s) {
  let e = 0
  for (let i = 0; i < s.length; i++) {
    const v = s[i]
    if (v > -1e30 && v < 1e30) e += v * v
  }
  return s.length ? Math.sqrt(e / s.length) : 0
}
