// test/measure.mjs - measuring tools for engine tests (Node only).
//
// These are deliberately INDEPENDENT of the engine's own analysis code: they
// carry their own small radix-2 FFT instead of importing core/fft.js, and the
// pitch estimator here is not core/pitch.js, so a bug in the engine cannot
// hide itself by also being in the ruler.
//
// medianF0: per-frame autocorrelation pitch in the manner of Boersma 1993,
//   "Accurate short-term analysis of the fundamental frequency and the
//   harmonics-to-noise ratio of a sampled sound": Hann-windowed frames of
//   about 2.5 periods of the lowest pitch, autocorrelation by FFT, divided
//   by the window's own autocorrelation to undo the taper, the earliest peak
//   within 10 percent of the best one chosen (which avoids octave-down
//   errors), parabolic refinement, and a voicing and loudness gate.
// spectralCentroid / bandEnergyDb: Welch averaged periodograms, 2048-point
//   Hann frames at 50 percent overlap, scaled so the band energies add up to
//   the signal's mean square (a full-scale sine reads -3 dB in its band).
// formantShiftEstimate: per-frame cepstrally smoothed log spectra (real
//   cepstrum liftered below 1.8 ms, which removes pitch harmonics up to
//   about 500 Hz), averaged over loud frames, resampled on a log-frequency
//   axis at 48 points per octave from 300 Hz up to 5.5 kHz, mean removed,
//   and cross-correlated. The overall tilt is deliberately NOT removed: when
//   a whole envelope slides up, its tilt over a fixed band changes too, and
//   detrending was measured to hide two thirds of a real shift. The best lag is the ratio by which b's spectral
//   envelope (its formants) sits above or below a's. Because both envelopes
//   are compared as whole shapes, every formant peak votes, which is far more
//   robust than picking single peaks.

import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

// ---------- tiny independent FFT ----------

const fftCache = new Map()

function fftTables(n) {
  let t = fftCache.get(n)
  if (t) return t
  const rev = new Uint32Array(n)
  const bits = Math.round(Math.log2(n))
  for (let i = 0; i < n; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
    rev[i] = r
  }
  const cos = new Float64Array(n / 2)
  const sin = new Float64Array(n / 2)
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n)
    sin[k] = Math.sin((2 * Math.PI * k) / n)
  }
  t = { rev, cos, sin }
  fftCache.set(n, t)
  return t
}

/** In-place complex FFT; inverse when inv is true (scaled 1/n). */
export function cfft(re, im, inv = false) {
  const n = re.length
  const { rev, cos, sin } = fftTables(n)
  for (let i = 0; i < n; i++) {
    const j = rev[i]
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  const sg = inv ? 1 : -1
  for (let size = 2; size <= n; size <<= 1) {
    const h = size >> 1
    const st = n / size
    for (let i = 0; i < n; i += size) {
      for (let j = 0; j < h; j++) {
        const wr = cos[j * st]
        const wi = sg * sin[j * st]
        const a = i + j
        const b = a + h
        const tr = re[b] * wr - im[b] * wi
        const ti = re[b] * wi + im[b] * wr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
      }
    }
  }
  if (inv) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}

function pow2ceil(n) {
  let p = 2
  while (p < n) p <<= 1
  return p
}

function hannSym(n) {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n)
  return w
}

function asSig(x) {
  if (x instanceof Float32Array || x instanceof Float64Array) return x
  if (x && x.ch) {
    if (x.ch.length === 1) return x.ch[0]
    const n = x.ch[0].length
    const m = new Float32Array(n)
    for (const c of x.ch) for (let i = 0; i < n; i++) m[i] += c[i] / x.ch.length
    return m
  }
  return Float32Array.from(x || [])
}

// ---------- sanity ----------

/** Throws unless buf is a well-formed, finite buffer with peak <= maxPeak. */
export function assertSane(buf, { maxPeak = 8 } = {}) {
  assert.ok(buf && typeof buf === 'object', 'buffer missing')
  assert.ok(Number.isFinite(buf.sr) && buf.sr > 0, 'buffer has no valid sample rate')
  assert.ok(Array.isArray(buf.ch) && buf.ch.length >= 1, 'buffer has no channels')
  const n = buf.ch[0].length
  let pk = 0
  for (let c = 0; c < buf.ch.length; c++) {
    const s = buf.ch[c]
    assert.ok(s instanceof Float32Array, 'channel ' + c + ' is not a Float32Array')
    assert.equal(s.length, n, 'channel lengths differ')
    for (let i = 0; i < s.length; i++) {
      const v = s[i]
      if (!Number.isFinite(v)) assert.fail('channel ' + c + ' sample ' + i + ' is ' + v)
      const a = v < 0 ? -v : v
      if (a > pk) pk = a
    }
  }
  assert.ok(pk <= maxPeak, 'peak ' + pk.toFixed(3) + ' above ' + maxPeak)
  return { peak: pk, length: n }
}

// ---------- pitch ----------

/**
 * Frame-by-frame f0 by normalised autocorrelation.
 * @returns {{ hop:number, f0: Float32Array, conf: Float32Array }}
 */
export function f0Track(sigIn, sr, { minHz = 60, maxHz = 1000, hopMs = 10, voicing = 0.5, gateDb = 35 } = {}) {
  const sig = asSig(sigIn)
  const L = Math.max(32, Math.round(Math.max(0.04, 2.5 / minHz) * sr))
  const N = pow2ceil(2 * L)
  const hop = Math.max(1, Math.round((hopMs * sr) / 1000))
  const nf = sig.length >= L ? Math.floor((sig.length - L) / hop) + 1 : 0
  const w = hannSym(L)
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  // window autocorrelation
  for (let i = 0; i < L; i++) re[i] = w[i]
  cfft(re, im)
  for (let k = 0; k < N; k++) {
    re[k] = re[k] * re[k] + im[k] * im[k]
    im[k] = 0
  }
  cfft(re, im, true)
  const rw = new Float64Array(L)
  for (let t = 0; t < L; t++) rw[t] = re[t] / re[0]
  // loudness gate
  const energies = new Float64Array(nf)
  let maxE = 0
  for (let f = 0; f < nf; f++) {
    let e = 0
    const s0 = f * hop
    for (let i = 0; i < L; i++) e += sig[s0 + i] * sig[s0 + i]
    energies[f] = e
    if (e > maxE) maxE = e
  }
  const gate = maxE * Math.pow(10, -gateDb / 10)
  const f0 = new Float32Array(nf)
  const conf = new Float32Array(nf)
  const tMin = Math.max(2, Math.floor(sr / maxHz))
  const tMax = Math.min(Math.ceil(sr / minHz), Math.floor(L * 0.6))
  const r = new Float64Array(tMax + 2)
  for (let f = 0; f < nf; f++) {
    if (!(energies[f] > gate) || energies[f] === 0) continue
    const s0 = f * hop
    let mean = 0
    for (let i = 0; i < L; i++) mean += sig[s0 + i]
    mean /= L
    re.fill(0)
    im.fill(0)
    for (let i = 0; i < L; i++) re[i] = (sig[s0 + i] - mean) * w[i]
    cfft(re, im)
    for (let k = 0; k < N; k++) {
      re[k] = re[k] * re[k] + im[k] * im[k]
      im[k] = 0
    }
    cfft(re, im, true)
    const r0 = re[0]
    if (!(r0 > 0)) continue
    for (let t = 0; t <= tMax + 1 && t < L; t++) r[t] = re[t] / r0 / (rw[t] > 1e-6 ? rw[t] : 1e-6)
    let best = 0
    for (let t = tMin; t <= tMax; t++) {
      if (r[t] > r[t - 1] && r[t] >= r[t + 1] && r[t] > best) best = r[t]
    }
    if (best < voicing) continue
    let pick = -1
    for (let t = tMin; t <= tMax; t++) {
      if (r[t] > r[t - 1] && r[t] >= r[t + 1] && r[t] >= 0.9 * best) {
        pick = t
        break
      }
    }
    if (pick < 0) continue
    const a = r[pick - 1]
    const b = r[pick]
    const c = r[pick + 1]
    const den = a - 2 * b + c
    const off = den < 0 ? (0.5 * (a - c)) / den : 0
    f0[f] = sr / (pick + (off > -1 && off < 1 ? off : 0))
    conf[f] = b
  }
  return { hop, f0, conf }
}

/** Median f0 (Hz) over voiced frames; 0 when nothing is voiced. */
export function medianF0(sig, sr, opts) {
  const tr = f0Track(sig, sr, opts)
  const v = []
  for (let i = 0; i < tr.f0.length; i++) if (tr.f0[i] > 0) v.push(tr.f0[i])
  if (!v.length) return 0
  v.sort((x, y) => x - y)
  const m = v.length >> 1
  return v.length & 1 ? v[m] : 0.5 * (v[m - 1] + v[m])
}

// ---------- spectra ----------

function welch(sigIn, N = 2048) {
  const sig = asSig(sigIn)
  let n = N
  if (sig.length < n) n = Math.max(16, pow2ceil(Math.max(16, sig.length)) >> 0)
  const hop = n >> 1
  const w = hannSym(n)
  let w2 = 0
  for (let i = 0; i < n; i++) w2 += w[i] * w[i]
  const nb = n / 2 + 1
  const psd = new Float64Array(nb)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  let frames = 0
  for (let s0 = 0; s0 === 0 || s0 + n <= sig.length; s0 += hop) {
    for (let i = 0; i < n; i++) {
      re[i] = s0 + i < sig.length ? sig[s0 + i] * w[i] : 0
      im[i] = 0
    }
    cfft(re, im)
    for (let k = 0; k < nb; k++) {
      const p = re[k] * re[k] + im[k] * im[k]
      psd[k] += (k === 0 || k === nb - 1 ? 1 : 2) * p
    }
    frames++
    if (s0 + n >= sig.length) break
  }
  const scale = 1 / (frames * n * w2)
  for (let k = 0; k < nb; k++) psd[k] *= scale
  return { psd, n }
}

/** Power-weighted mean frequency (Hz). 0 for silence. */
export function spectralCentroid(sig, sr) {
  const { psd, n } = welch(sig)
  let a = 0
  let b = 0
  for (let k = 0; k < psd.length; k++) {
    a += ((k * sr) / n) * psd[k]
    b += psd[k]
  }
  return b > 0 ? a / b : 0
}

/** Mean-square energy between lo and hi Hz, in dB (a full-scale sine is about -3 dB). */
export function bandEnergyDb(sig, sr, lo, hi) {
  const { psd, n } = welch(sig)
  let e = 0
  for (let k = 0; k < psd.length; k++) {
    const f = (k * sr) / n
    if (f >= lo && f < hi) e += psd[k]
  }
  return 10 * Math.log10(e > 1e-20 ? e : 1e-20)
}

// ---------- levels, stereo, time ----------

/** Pearson correlation of left and right; 1 for mono. */
export function stereoCorrelation(buf) {
  if (!buf.ch || buf.ch.length < 2) return 1
  const L = buf.ch[0]
  const R = buf.ch[1]
  const n = L.length
  if (!n) return 1
  let ml = 0
  let mr = 0
  for (let i = 0; i < n; i++) {
    ml += L[i]
    mr += R[i]
  }
  ml /= n
  mr /= n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const a = L[i] - ml
    const b = R[i] - mr
    sxy += a * b
    sxx += a * a
    syy += b * b
  }
  if (sxx === 0 && syy === 0) return 1
  if (sxx === 0 || syy === 0) return 0
  return sxy / Math.sqrt(sxx * syy)
}

/** RMS level in dB (buffer or Float32Array); -200 for silence. */
export function rmsDb(sig) {
  const chans = sig && sig.ch ? sig.ch : [sig]
  let e = 0
  let n = 0
  for (const s of chans) {
    for (let i = 0; i < s.length; i++) e += s[i] * s[i]
    n += s.length
  }
  const r = n ? Math.sqrt(e / n) : 0
  return r > 1e-10 ? 20 * Math.log10(r) : -200
}

export function lengthSeconds(buf) {
  return buf.ch && buf.ch.length ? buf.ch[0].length / buf.sr : 0
}

/** Milliseconds for fn(); with reps > 1 the fastest run. */
export function timeIt(fn, reps = 1) {
  let best = Infinity
  for (let r = 0; r < Math.max(1, reps); r++) {
    const t0 = performance.now()
    fn()
    const dt = performance.now() - t0
    if (dt < best) best = dt
  }
  return best
}

// ---------- formants ----------

const ENV_PER_OCT = 48

/** Average cepstrally smoothed log-magnitude envelope (dB) of loud frames. */
export function spectralEnvelopeDb(sigIn, sr, { liftMs = 1.8, frameMs = 40, gateDb = 30 } = {}) {
  const sig = asSig(sigIn)
  const N = pow2ceil(Math.round((frameMs / 1000) * sr))
  const hop = N >> 2
  const w = hannSym(N)
  const nb = N / 2 + 1
  const env = new Float64Array(nb)
  const nf = sig.length >= N ? Math.floor((sig.length - N) / hop) + 1 : 0
  const en = new Float64Array(nf)
  let maxE = 0
  for (let f = 0; f < nf; f++) {
    let e = 0
    for (let i = 0; i < N; i++) {
      const v = sig[f * hop + i] * w[i]
      e += v * v
    }
    en[f] = e
    if (e > maxE) maxE = e
  }
  const gate = maxE * Math.pow(10, -gateDb / 10)
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const qc = Math.max(2, Math.round((liftMs / 1000) * sr))
  let used = 0
  for (let f = 0; f < nf; f++) {
    if (!(en[f] > gate)) continue
    for (let i = 0; i < N; i++) {
      re[i] = sig[f * hop + i] * w[i]
      im[i] = 0
    }
    cfft(re, im)
    const floor = 1e-9 * Math.sqrt(en[f])
    for (let k = 0; k < N; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      re[k] = Math.log(m + floor + 1e-30)
      im[k] = 0
    }
    cfft(re, im, true) // real cepstrum
    for (let q = 0; q < N; q++) {
      const d = q <= N / 2 ? q : N - q
      let g = 0
      if (d < qc) g = 0.5 + 0.5 * Math.cos((Math.PI * d) / qc)
      re[q] *= g
      im[q] = 0
    }
    cfft(re, im)
    for (let k = 0; k < nb; k++) env[k] += (20 / Math.LN10) * re[k]
    used++
  }
  if (used) for (let k = 0; k < nb; k++) env[k] /= used
  return { env, n: N, frames: used }
}

function logGrid(envObj, sr, lo, hi, detrend = false) {
  const { env, n } = envObj
  const oct = Math.log2(hi / lo)
  const m = Math.floor(oct * ENV_PER_OCT) + 1
  const g = new Float64Array(m)
  for (let i = 0; i < m; i++) {
    const f = lo * Math.pow(2, i / ENV_PER_OCT)
    const x = (f * n) / sr
    const k = Math.floor(x)
    const t = x - k
    g[i] = env[k] * (1 - t) + env[Math.min(env.length - 1, k + 1)] * t
  }
  // remove the mean (or, when asked, the best straight line)
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (let i = 0; i < m; i++) {
    sx += i; sy += g[i]; sxx += i * i; sxy += i * g[i]
  }
  const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx)
  const icpt = (sy - slope * sx) / m
  for (let i = 0; i < m; i++) g[i] -= detrend ? icpt + slope * i : sy / m
  return g
}

/**
 * How far b's formants sit from a's, as a frequency ratio (1 = same,
 * about 1.26 = four semitones higher). a and b are Float32Arrays or buffers.
 */
export function formantShiftEstimate(a, b, sr, { maxSemitones = 12, lo = 300, hi = 5500, liftMs = 1.8, detrend = false } = {}) {
  const top = Math.min(hi, sr * 0.45)
  const ea = logGrid(spectralEnvelopeDb(a, sr, { liftMs }), sr, lo, top, detrend)
  const eb = logGrid(spectralEnvelopeDb(b, sr, { liftMs }), sr, lo, top, detrend)
  const m = ea.length
  const maxLag = Math.min(Math.round((maxSemitones / 12) * ENV_PER_OCT), m >> 1)
  const corr = new Float64Array(2 * maxLag + 1)
  for (let l = -maxLag; l <= maxLag; l++) {
    let sab = 0, saa = 0, sbb = 0, ma = 0, mb = 0, cnt = 0
    for (let i = 0; i < m; i++) {
      const j = i + l
      if (j < 0 || j >= m) continue
      ma += ea[i]
      mb += eb[j]
      cnt++
    }
    ma /= cnt
    mb /= cnt
    for (let i = 0; i < m; i++) {
      const j = i + l
      if (j < 0 || j >= m) continue
      const x = ea[i] - ma
      const y = eb[j] - mb
      sab += x * y
      saa += x * x
      sbb += y * y
    }
    corr[l + maxLag] = saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0
  }
  let bi = 0
  for (let i = 1; i < corr.length; i++) if (corr[i] > corr[bi]) bi = i
  let off = 0
  if (bi > 0 && bi < corr.length - 1) {
    const p = corr[bi - 1], q = corr[bi], r = corr[bi + 1]
    const den = p - 2 * q + r
    if (den < 0) off = (0.5 * (p - r)) / den
  }
  const lag = bi - maxLag + off
  return Math.pow(2, lag / ENV_PER_OCT)
}

/** formantShiftEstimate in semitones. */
export function formantShiftSemitones(a, b, sr, opts) {
  return 12 * Math.log2(formantShiftEstimate(a, b, sr, opts))
}
