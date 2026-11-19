// modules/spec/blur.js - Spectral smear: the voice melts into a dreamy haze.
//
// Technique: spectral magnitude smoothing over time and frequency (the
// "spectral blur" family of phase-vocoder processes; see Wishart 1994,
// "Audible Design", and the STFT magnitude-averaging effects in Zolzer, ed.,
// "DAFX"). Each bin's magnitude feeds an asymmetric one-pole smoother that
// rises quickly and falls slowly, so every sound leaves a lingering ghost of
// itself; a symmetric two-way one-pole across neighbouring bins smears the
// pitch. The original frame is kept as it is, and only the excess of the
// smeared magnitude over the live one is added, with random phases, so the
// words stay put while the haze grows around them. The random-phase part is
// level-corrected for overlap-add (_spectral.js noiseOlaGain). "Smear time"
// is the time the haze takes to fall by 60 decibels, so it is also the tail.

import { spectralProcess } from '../../core/stft.js'
import { hann } from '../../core/window.js'
import { resolveParams } from '../../core/params.js'
import { frameSize, rngOf, progressTo, padSig, cleanSig, noiseOlaGain, PH_COS, PH_SIN } from './_spectral.js'

function blurChannel(src, sr, N, p, rng) {
  const nb = (N >> 1) + 1
  const hop = N >> 2
  const S = new Float64Array(nb)
  const M = new Float64Array(nb)
  const B = new Float64Array(nb)
  const a = p.amount / 100
  const tRel = Math.max(0.001, p.time / 1000 / 6.9)
  const tAtt = Math.max(0.0015, tRel / 8)
  const cRel = Math.exp(-hop / (tRel * sr))
  const cAtt = Math.exp(-hop / (tAtt * sr))
  // across bins: spread percent maps to a smoothing width up to about 250 Hz
  const binHz = sr / N
  const widthHz = 4 + (p.spread / 100) * 250
  const cf = p.spread > 0 ? Math.exp(-binHz / widthHz) : 0
  const ng = noiseOlaGain(hann(N), hop)
  return spectralProcess(src, { size: N, hop }, (re, im) => {
    for (let k = 0; k < nb; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      M[k] = m
      const s = S[k]
      const v = m > s ? m + cAtt * (s - m) : m + cRel * (s - m)
      S[k] = v < 1e-20 ? 0 : v
    }
    // frequency smear of the held magnitudes (forward and backward one-pole)
    if (cf > 0) {
      let y = S[0]
      for (let k = 0; k < nb; k++) {
        y = S[k] + cf * (y - S[k])
        B[k] = y
      }
      y = B[nb - 1]
      for (let k = nb - 1; k >= 0; k--) {
        y = B[k] + cf * (y - B[k])
        B[k] = y
      }
    } else {
      for (let k = 0; k < nb; k++) B[k] = S[k]
    }
    for (let k = 1; k < nb - 1; k++) {
      const ex = B[k] - M[k]
      if (ex <= 0) continue
      const j = (rng.next() * 4096) | 0
      const m = ex * a * ng
      re[k] += m * PH_COS[j]
      im[k] += m * PH_SIN[j]
    }
  })
}

const blur = {
  id: 'spec.blur',
  name: 'Spectral smear',
  family: 'spec',
  about: 'Smears your voice into a lingering dreamy haze, like a ghost echoing itself.',
  params: [
    { id: 'amount', name: 'Smear amount', type: 'number', min: 0, max: 100, step: 1, def: 70, unit: 'percent', rand: [40, 100] },
    { id: 'time', name: 'Smear time', type: 'number', min: 50, max: 6000, step: 10, def: 1200, unit: 'ms', rand: [400, 3000] },
    { id: 'spread', name: 'Pitch smear', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 60] },
  ],
  stereo: 'keep',
  tail: (p) => (p && p.time > 0 ? p.time / 1000 : 1.2),
  warps: false,
  cost: 2,
  process(input, params, ctx) {
    const p = resolveParams(blur, params)
    const sr = input.sr
    const nch = input.ch.length
    const len = input.ch[0] ? input.ch[0].length : 0
    // an empty take still gets its tail (silence), as every stage promises input + tail
    if (len === 0) return { sr, ch: input.ch.map(() => new Float32Array(Math.round((p.time / 1000) * sr))) }
    const N = frameSize(sr, 42.7)
    const extra = Math.round((p.time / 1000) * sr)
    const rng = rngOf(ctx, 'spec.blur')
    const ch = []
    for (let c = 0; c < nch; c++) {
      const src = padSig(input.ch[c], extra)
      ch.push(cleanSig(blurChannel(src, sr, N, p, rng.fork('ch' + c))))
      progressTo(ctx, (c + 1) / nch)
    }
    return { sr, ch }
  },
}

export default blur
