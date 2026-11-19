// modules/spec/codec.js - Bad internet audio: a voice squeezed through a starving codec.
//
// Technique: a caricature of a low-bitrate transform codec, built from the
// textbook pieces (Painter and Spanias 2000, "Perceptual coding of digital
// audio", Proc. IEEE; Bosi and Goldberg, "Introduction to Digital Audio
// Coding and Standards", 2003):
// - 21 ms frames at half overlap with square-root Hann windows (the framing
//   of MDCT codecs), so artefacts change frame by frame the way real ones do;
// - a bandwidth that shrinks with the bitrate (about 3.4 kHz at 6 kbps up to
//   20 kHz at 64 kbps);
// - a bit budget: only the strongest bins of each frame are coded (the share
//   shrinks with the bitrate), their levels quantised in coarse decibel steps
//   and their phases on a coarse grid, which gives the swirly "birdie" and
//   metallic sounds of starved codecs;
// - whole bands that fall far below the loudest band are dropped (spectral
//   holes), and coded bands get noise filling in the bins that lost their
//   bits, as modern codecs do;
// - "Warble": the jitter-buffer wobble of video calls, a slowly wandering
//   fractional read position (cubic interpolation, mean delay zero) that
//   bends the pitch a little, plus a coarser, shifting phase grid.

import { spectralProcess } from '../../core/stft.js'
import { resolveParams } from '../../core/params.js'
import { frameSize, rngOf, progressTo, cleanSig, TWO_PI, PH_COS, PH_SIN } from './_spectral.js'

const BR = [6, 8, 12, 16, 24, 32, 48, 64]
const CUT = [3400, 4000, 6000, 8000, 11000, 14000, 17000, 20000]
const KEEP = [0.1, 0.14, 0.2, 0.28, 0.4, 0.55, 0.75, 0.9]
const STEP_DB = [7, 6, 4.5, 3.5, 2.5, 2, 1.5, 1]
const PBITS = [2, 2.5, 3, 3.5, 4, 4.5, 5, 6]
const FILL = [0.3, 0.28, 0.25, 0.22, 0.18, 0.15, 0.12, 0.1]
const DROP_DB = [26, 30, 34, 38, 44, 50, 56, 62]
const EDGES = [0, 200, 400, 600, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000, 48000]

function interp(table, br) {
  const x = Math.log2(Math.max(BR[0], Math.min(BR[BR.length - 1], br)))
  for (let i = 0; i < BR.length - 1; i++) {
    const a = Math.log2(BR[i])
    const b = Math.log2(BR[i + 1])
    if (x <= b) {
      const t = (x - a) / (b - a)
      return table[i] + (table[i + 1] - table[i]) * t
    }
  }
  return table[table.length - 1]
}

function smoothCurve(len, sr, rng, rate) {
  const out = new Float32Array(len)
  const T = Math.max(2, Math.round(sr / rate))
  let a = rng.next() * 2 - 1
  let b = rng.next() * 2 - 1
  let k = 0
  for (let i = 0; i < len; i++) {
    out[i] = a + (b - a) * (0.5 - 0.5 * Math.cos((Math.PI * k) / T))
    if (++k >= T) {
      k = 0
      a = b
      b = rng.next() * 2 - 1
    }
  }
  return out
}

/** Wandering read position, cubic Hermite, mean delay zero. */
function warbleRead(src, sr, depthMs, rng) {
  const len = src.length
  const out = new Float32Array(len)
  const d = (depthMs / 1000) * sr
  const c1 = smoothCurve(len, sr, rng.fork('w1'), 0.9)
  const c2 = smoothCurve(len, sr, rng.fork('w2'), 3.1)
  for (let i = 0; i < len; i++) {
    let pos = i + d * (0.75 * c1[i] + 0.25 * c2[i])
    if (pos < 0) pos = 0
    if (pos > len - 1) pos = len - 1
    const j = Math.floor(pos)
    const f = pos - j
    const y0 = src[j > 0 ? j - 1 : 0]
    const y1 = src[j]
    const y2 = src[j + 1 < len ? j + 1 : len - 1]
    const y3 = src[j + 2 < len ? j + 2 : len - 1]
    const a1 = 0.5 * (y2 - y0)
    const a2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3
    const a3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2)
    out[i] = ((a3 * f + a2) * f + a1) * f + y1
  }
  return out
}

function codecChannel(src, sr, N, p, rng) {
  const nb = (N >> 1) + 1
  const hop = N >> 1
  const br = p.bitrate
  const wb = p.warble / 100
  const cut = Math.min(interp(CUT, br), sr * 0.45)
  const kc = Math.max(4, Math.min(nb - 2, Math.round((cut * N) / sr)))
  const keepN = Math.max(2, Math.round(interp(KEEP, br) * kc))
  const step = interp(STEP_DB, br)
  const levels = Math.max(2, Math.round(Math.pow(2, Math.max(1, interp(PBITS, br) - 1.5 * wb))))
  const qph = TWO_PI / levels
  const fill = interp(FILL, br)
  const dropDb = interp(DROP_DB, br)
  // bands
  const band = new Int32Array(nb)
  let nBands = 0
  for (let k = 0; k < nb; k++) {
    const f = (k * sr) / N
    let b = 0
    while (b < EDGES.length - 2 && f >= EDGES[b + 1]) b++
    band[k] = b
    if (b + 1 > nBands) nBands = b + 1
  }
  const bandE = new Float64Array(nBands)
  const bandN = new Float64Array(nBands)
  const mag = new Float64Array(nb)
  const scratch = new Float64Array(nb)
  const LN = 20 / Math.LN10
  return spectralProcess(src, { size: N, hop, window: 'sqrthann' }, (re, im) => {
    bandE.fill(0)
    bandN.fill(0)
    for (let k = 1; k <= kc; k++) {
      const m2 = re[k] * re[k] + im[k] * im[k]
      mag[k] = Math.sqrt(m2)
      bandE[band[k]] += m2
      bandN[band[k]] += 1
    }
    let topBand = 0
    for (let b = 0; b < nBands; b++) {
      bandE[b] = bandN[b] > 0 ? Math.sqrt(bandE[b] / bandN[b]) : 0
      if (bandE[b] > topBand) topBand = bandE[b]
    }
    if (!(topBand > 1e-12)) {
      re.fill(0)
      im.fill(0)
      return
    }
    const dropBelow = topBand * Math.pow(10, -dropDb / 20)
    for (let k = 1; k <= kc; k++) scratch[k - 1] = mag[k]
    const view = scratch.subarray(0, kc)
    view.sort()
    const thr = view[Math.max(0, kc - keepN)]
    const dOff = wb > 0 ? rng.next() - 0.5 : 0
    const pOff = wb > 0 ? (rng.next() - 0.5) * wb : 0
    for (let k = 0; k < nb; k++) {
      if (k < 1 || k > kc) {
        re[k] = 0
        im[k] = 0
        continue
      }
      const be = bandE[band[k]]
      if (be < dropBelow) {
        re[k] = 0
        im[k] = 0
        continue
      }
      const m = mag[k]
      if (m >= thr && m > 0) {
        const db = LN * Math.log(m)
        const mq = Math.pow(10, ((Math.round(db / step + dOff) - dOff) * step) / 20)
        const ph = Math.atan2(im[k], re[k])
        const pq = (Math.round(ph / qph + pOff) - pOff) * qph
        re[k] = mq * Math.cos(pq)
        im[k] = mq * Math.sin(pq)
      } else {
        const a = be * fill * (0.4 + 0.8 * rng.next())
        const j = (rng.next() * 4096) | 0
        re[k] = a * PH_COS[j]
        im[k] = a * PH_SIN[j]
      }
    }
  })
}

const codec = {
  id: 'spec.codec',
  name: 'Bad internet audio',
  family: 'spec',
  about: 'Your voice squeezed through a weak video call: swirly, thin and wobbling underwater.',
  params: [
    {
      id: 'bitrate', name: 'Connection quality', type: 'number', min: 6, max: 64, step: 1, def: 10,
      unit: 'count', noun: ['kilobit per second', 'kilobits per second'], rand: [6, 24],
    },
    { id: 'warble', name: 'Warble', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 80] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 2,
  process(input, params, ctx) {
    const p = resolveParams(codec, params)
    const sr = input.sr
    const nch = input.ch.length
    const len = input.ch[0] ? input.ch[0].length : 0
    if (len === 0) return { sr, ch: input.ch.map(() => new Float32Array(0)) }
    const N = frameSize(sr, 21.3)
    const rng = rngOf(ctx, 'spec.codec')
    const ch = []
    for (let c = 0; c < nch; c++) {
      let src = input.ch[c]
      // the same wobble on both sides, as one network path carries both
      if (p.warble > 0) src = warbleRead(src, sr, 7 * (p.warble / 100), rng.fork('warble'))
      ch.push(cleanSig(codecChannel(src, sr, N, p, rng.fork('codec' + c))))
      progressTo(ctx, (c + 1) / nch)
    }
    return { sr, ch }
  },
}

export default codec
