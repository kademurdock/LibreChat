// modules/lofi/mp3.js - lofi.mp3, "Old internet file".
//
// Technique: a real perceptual transform codec, built the way the MPEG-1/2
// Layer III and AAC long-block coders are described in the literature
// (K. Brandenburg, "MP3 and AAC explained", AES 17th Conference, 1999;
// ISO/IEC 11172-3 annex D on psychoacoustic models; J. P. Princen,
// A. W. Johnson and A. B. Bradley, "Subband/transform coding using filter
// bank designs based on time domain aliasing cancellation", ICASSP 1987):
// 1. The voice is resampled down to the coder's rate (an 8, 11, 16, 22 or
//    32 kHz file, as low bit rates forced).
// 2. A modified discrete cosine transform of 512 lines with a sine window
//    (time-domain aliasing cancellation, hop 512), computed as a DCT-IV
//    through a complex FFT. Only long blocks, like the cheap encoders of the
//    late 1990s: a sharp sound's quantisation noise smears over the whole
//    window, so every "t" and "k" gets a ghostly pre-echo before it.
// 3. A psychoacoustic model per frame: energy in critical bands (Zwicker's
//    band edges), spread to neighbouring bands (about -10 dB per band upward
//    and -25 dB downward), minus a signal-to-mask offset, floored by the
//    threshold of hearing (Terhardt's formula). "Swirl" lowers the offset:
//    more of the voice is judged inaudible and thrown away.
// 4. Noise allocation: each band's quantiser step is set so its noise would
//    sit at the masking threshold, then a global gain in quarter-power-of-two
//    steps (Layer III's global_gain) is raised until the frame fits its bit
//    budget, estimated from a Huffman-like cost per quantised value. A bit
//    reservoir lets busy frames borrow from quiet ones. The quantiser is
//    Layer III's power law, q = nint((|x| / step)^0.75 - 0.0946).
// 5. When bits run short whole bands drop to zero and come back from frame
//    to frame: the swirling, watery "birdie" sound of an over-squeezed file,
//    plus the top-end loss of the encoder's low pass.
// 6. Stereo takes are coded as mid and side (joint stereo) with most of the
//    bits on the mid, so the stereo image wobbles and collapses as it should.
// "Times re-saved" decodes and re-encodes with the frames shifted, the way a
// file passed around and re-converted piles artefacts on artefacts.

import { resampleTo } from '../../core/resample.js'
import { FFT } from '../../core/fft.js'
import { fitLength, clamp, num } from './_lib.js'

const M = 512
const TWO_M = 2 * M

const QUALITIES = {
  awful: { name: 'Awful, a tiny file', rc: 8000, kbps: 6, lp: 2800 },
  bad: { name: 'Bad, dial-up quality', rc: 11025, kbps: 12, lp: 4200 },
  poor: { name: 'Poor, streaming radio', rc: 16000, kbps: 20, lp: 5600 },
  fair: { name: 'Fair, a shared song', rc: 22050, kbps: 30, lp: 7000 },
  ok: { name: 'Okay, a decent old file', rc: 32000, kbps: 64, lp: 12500 },
}

const BARK_EDGES = [0, 100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480, 1720, 2000, 2320, 2700, 3150, 3700, 4400, 5300, 6400, 7700, 9500, 12000, 15500, 20500, 1e9]

// ---------------------------------------------------------------- transform

const WIN = (() => {
  const w = new Float64Array(TWO_M)
  for (let i = 0; i < TWO_M; i++) w[i] = Math.sin((Math.PI * (i + 0.5)) / TWO_M)
  return w
})()

class Dct4 {
  constructor() {
    this.fft = new FFT(TWO_M)
    this.re = new Float64Array(TWO_M)
    this.im = new Float64Array(TWO_M)
    this.pc = new Float64Array(M)
    this.ps = new Float64Array(M)
    this.qc = new Float64Array(M)
    this.qs = new Float64Array(M)
    for (let n = 0; n < M; n++) {
      this.pc[n] = Math.cos((Math.PI * n) / TWO_M)
      this.ps[n] = Math.sin((Math.PI * n) / TWO_M)
      const t = (Math.PI * (2 * n + 1)) / (4 * M)
      this.qc[n] = Math.cos(t)
      this.qs[n] = Math.sin(t)
    }
  }

  /** out[k] = sum u[n] cos(pi/M (n + 1/2)(k + 1/2)). */
  run(u, out) {
    const re = this.re
    const im = this.im
    for (let n = 0; n < M; n++) {
      re[n] = u[n] * this.pc[n]
      im[n] = -u[n] * this.ps[n]
    }
    for (let n = M; n < TWO_M; n++) {
      re[n] = 0
      im[n] = 0
    }
    this.fft.forward(re, im)
    for (let k = 0; k < M; k++) out[k] = re[k] * this.qc[k] + im[k] * this.qs[k]
  }
}

// ---------------------------------------------------------------- psychoacoustics

function athDb(f) {
  const k = Math.max(0.02, f / 1000)
  return 3.64 * Math.pow(k, -0.8) - 6.5 * Math.exp(-0.6 * (k - 3.3) * (k - 3.3)) + 1e-3 * Math.pow(k, 4)
}

function makeBands(rc, lpHz) {
  const nyq = rc / 2
  const kLp = Math.max(8, Math.min(M, Math.round((lpHz / nyq) * M)))
  const edges = [0]
  for (let i = 1; i < BARK_EDGES.length; i++) {
    let k = Math.round((BARK_EDGES[i] / nyq) * M)
    if (k > kLp) k = kLp
    if (k - edges[edges.length - 1] >= 4) edges.push(k)
    if (k >= kLp) break
  }
  if (edges[edges.length - 1] < kLp) edges.push(kLp)
  const nb = edges.length - 1
  const lo = new Int32Array(nb)
  const hi = new Int32Array(nb)
  const ath = new Float64Array(nb)
  // A full-scale sine has energy M^2 / 4 in this transform; full scale is
  // taken as 92 dB SPL. ath[b] is the threshold of hearing per line.
  const ref = (M * M) / 4
  for (let b = 0; b < nb; b++) {
    lo[b] = edges[b]
    hi[b] = edges[b + 1]
    const fc = (((lo[b] + hi[b]) / 2) * nyq) / M
    ath[b] = ref * Math.pow(10, (athDb(fc) - 92) / 10)
  }
  // spreading of masking between bands: -10 dB per band upward, -25 dB downward
  const spr = new Float64Array(nb * nb)
  for (let b = 0; b < nb; b++) {
    for (let j = 0; j < nb; j++) {
      const d = b - j
      spr[b * nb + j] = d >= 0 ? Math.pow(10, -1.0 * d) : Math.pow(10, 2.5 * d)
    }
  }
  return { nb, lo, hi, ath, kLp, spr }
}

// ---------------------------------------------------------------- one channel

class Coder {
  constructor(rc, cfg, swirl) {
    this.rc = rc
    this.bands = makeBands(rc, Math.min(cfg.lp, 0.45 * rc))
    // signal-to-mask offset: about 20 dB for the harmonics of a voice when
    // the bits allow it; swirl lowers it so more is judged inaudible
    this.smr = 24 - 0.14 * swirl
    // and a wider dead zone (rounding below one half), a bit-saving trick of cheap encoders
    this.round = 0.4054 - 0.22 * (swirl / 100)
    this.dct = new Dct4()
    this.u = new Float64Array(M)
    this.X = new Float64Array(M)
    this.v = new Float64Array(M)
    const nb = this.bands.nb
    this.E = new Float64Array(nb)
    this.T = new Float64Array(nb)
    this.step = new Float64Array(nb)
    this.q = new Float64Array(M)
    this.res = 0
  }

  bitsAt(G) {
    const { nb, lo, hi } = this.bands
    const X = this.X
    const mul = Math.pow(2, G / 4)
    const rnd = this.round
    let bits = 0
    let last = -1
    for (let b = 0; b < nb; b++) {
      const inv = 1 / (this.step[b] * mul)
      for (let k = lo[b]; k < hi[b]; k++) {
        const a = Math.abs(X[k]) * inv
        const q = a > 0 ? Math.floor(Math.pow(a, 0.75) + rnd) : 0
        this.q[k] = q
        if (q > 0) last = k
      }
    }
    for (let k = 0; k <= last; k++) {
      const q = this.q[k]
      bits += q === 0 ? 0.5 : 2.5 + 2 * Math.log2(q)
    }
    return bits
  }

  /** Quantise the spectrum in this.X in place to what a decoder would rebuild. */
  frame(budget, resMax) {
    const { nb, lo, hi, ath, kLp, spr } = this.bands
    const X = this.X
    // the encoder's low pass, with a short taper
    const taper = 12
    for (let k = kLp; k < M; k++) X[k] = 0
    for (let j = 0; j < taper; j++) {
      const k = kLp - 1 - j
      if (k < 0) break
      X[k] *= 0.5 - 0.5 * Math.cos((Math.PI * (j + 0.5)) / taper)
    }
    const E = this.E
    let any = 0
    for (let b = 0; b < nb; b++) {
      let e = 0
      for (let k = lo[b]; k < hi[b]; k++) e += X[k] * X[k]
      E[b] = e
      any += e
    }
    if (!(any > 1e-12)) {
      X.fill(0)
      this.res = Math.min(resMax, this.res + budget)
      return
    }
    const off = Math.pow(10, -this.smr / 10)
    for (let b = 0; b < nb; b++) {
      let s = 0
      const row = b * nb
      for (let j = 0; j < nb; j++) s += E[j] * spr[row + j]
      const w = hi[b] - lo[b]
      const t = Math.max(s * off, ath[b] * w)
      this.T[b] = t
      this.step[b] = Math.sqrt((12 * t) / w)
    }
    const need = this.bitsAt(0)
    const allowed = need <= budget ? need : budget + Math.min(this.res, need - budget)
    let G = 0
    if (need > allowed) {
      let a = 0
      let c = 160
      while (c - a > 1) {
        const mid = (a + c) >> 1
        if (this.bitsAt(mid) > allowed) a = mid
        else c = mid
      }
      G = c
    }
    const used = this.bitsAt(G)
    this.res = Math.max(0, Math.min(resMax, this.res + budget - used))
    const mul = Math.pow(2, G / 4)
    for (let b = 0; b < nb; b++) {
      const st = this.step[b] * mul
      for (let k = lo[b]; k < hi[b]; k++) {
        const q = this.q[k]
        X[k] = q > 0 ? (X[k] < 0 ? -1 : 1) * Math.pow(q, 4 / 3) * st : 0
      }
    }
  }

  /** Code a whole signal (at the coder rate) and return the decoded signal. */
  run(x, kbps, offset) {
    const len = x.length
    const pad = M + offset
    const F = Math.ceil((pad + len) / M)
    const L = (F + 1) * M
    const xp = new Float64Array(L)
    for (let i = 0; i < len; i++) xp[pad + i] = x[i]
    const yp = new Float64Array(L)
    const rawBudget = (kbps * 1000 * M) / this.rc
    const budget = Math.max(16, rawBudget - 70 - 4 * this.bands.nb)
    const resMax = 2040 * (M / 576)
    const u = this.u
    const X = this.X
    const v = this.v
    const h = M >> 1
    for (let f = 0; f < F; f++) {
      const o = f * M
      // fold the windowed 2M samples to M (TDAC), then DCT-IV
      for (let n = 0; n < h; n++) {
        u[n] = -xp[o + 3 * h - 1 - n] * WIN[3 * h - 1 - n] - xp[o + 3 * h + n] * WIN[3 * h + n]
        u[h + n] = xp[o + n] * WIN[n] - xp[o + M - 1 - n] * WIN[M - 1 - n]
      }
      this.dct.run(u, X)
      this.frame(budget, resMax)
      this.dct.run(X, v)
      const s = 2 / M
      for (let i = 0; i < h; i++) {
        const a = v[h + i] * s
        const b = -v[M - 1 - i] * s
        const c = -v[h - 1 - i] * s
        const d = -v[i] * s
        yp[o + i] += a * WIN[i]
        yp[o + h + i] += b * WIN[h + i]
        yp[o + M + i] += c * WIN[M + i]
        yp[o + 3 * h + i] += d * WIN[3 * h + i]
      }
    }
    const out = new Float32Array(len)
    for (let i = 0; i < len; i++) {
      const y = yp[pad + i]
      out[i] = Number.isFinite(y) ? y : 0
    }
    return out
  }
}

/** For tests: the transform and the coder. */
export const _internals = { Dct4, Coder, QUALITIES, M, WIN }

export default {
  id: 'lofi.mp3',
  name: 'Old internet file',
  family: 'lofi',
  about: 'Your voice squeezed into a tiny music file from the dial-up days: swirly and watery, with ghostly pre-echoes before sharp sounds.',
  params: [
    {
      id: 'quality', name: 'File quality', type: 'choice', def: 'bad',
      options: Object.keys(QUALITIES).map((v) => ({ v, name: QUALITIES[v].name })),
    },
    { id: 'swirl', name: 'Swirl', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
    { id: 'copies', name: 'Times re-saved', type: 'number', min: 1, max: 4, step: 1, def: 1, unit: 'count', noun: ['time', 'times'], rand: [1, 2] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    const sr = input.sr
    const n = input.ch && input.ch.length ? input.ch[0].length : 0
    const cfg = QUALITIES[p.quality] || QUALITIES.bad
    const rc = Math.min(cfg.rc, sr)
    const swirl = clamp(num(p.swirl, 50), 0, 100)
    const copies = clamp(Math.round(num(p.copies, 1)), 1, 8)
    const nch = input.ch.length
    if (n === 0) return { sr, ch: input.ch.map(() => new Float32Array(0)) }
    let chans = input.ch.map((x) => {
      const y = rc === sr ? Float32Array.from(x) : resampleTo(x, sr, rc)
      for (let i = 0; i < y.length; i++) if (!Number.isFinite(y[i])) y[i] = 0
      return y
    })
    const stereo = nch >= 2
    const progress = ctx && typeof ctx.progress === 'function' ? ctx.progress : null
    // swirl also squeezes the bit budget: half a step either way around the nominal rate
    const kbps = cfg.kbps * (1.25 - 0.5 * (swirl / 100))
    for (let g = 0; g < copies; g++) {
      const offset = (g * 173) % M
      if (stereo) {
        const L = chans[0]
        const R = chans[1]
        const m = new Float32Array(L.length)
        const s = new Float32Array(L.length)
        for (let i = 0; i < L.length; i++) {
          m[i] = 0.5 * (L[i] + R[i])
          s[i] = 0.5 * (L[i] - R[i])
        }
        const kb = kbps * 1.5
        const md = new Coder(rc, cfg, swirl).run(m, kb * 0.7, offset)
        const sd = new Coder(rc, cfg, Math.min(100, swirl + 15)).run(s, kb * 0.3, offset)
        const nl = new Float32Array(L.length)
        const nr = new Float32Array(L.length)
        for (let i = 0; i < L.length; i++) {
          nl[i] = md[i] + sd[i]
          nr[i] = md[i] - sd[i]
        }
        const rest = chans.slice(2).map((x) => new Coder(rc, cfg, swirl).run(x, kbps, offset))
        chans = [nl, nr, ...rest]
      } else {
        chans = chans.map((x) => new Coder(rc, cfg, swirl).run(x, kbps, offset))
      }
      if (progress) progress((g + 1) / copies)
      if (ctx && typeof ctx.cancelled === 'function' && ctx.cancelled()) break
    }
    const ch = chans.map((y) => fitLength(rc === sr ? y : resampleTo(y, rc, sr), n))
    return { sr, ch }
  },
}
