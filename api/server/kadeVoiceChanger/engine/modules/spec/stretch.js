// modules/spec/stretch.js - Spectral stretch: harmonics pulled apart or squeezed.
//
// Technique: peak-region phase-vocoder warping (Laroche and Dolson 1999,
// "New phase-vocoder techniques for real-time pitch shifting, chorusing,
// harmonizing and other exotic audio modifications", JAES 47(11); see
// _spectral.js PeakWarp). Every spectral peak moves, with its surrounding
// bins as one block, to a new frequency on a power law around 150 Hz:
// f' = 150 * (f / 150)^a. With a above 1 each octave becomes wider, so the
// upper harmonics drift sharp like a stiff piano string or a bell; below 1
// they bunch together into a rough, gong-like cluster. The partials are no
// longer a harmonic series, which is what makes the voice sound metallic.
// With "Keep vowels" on, every moved bin is re-weighted by the cepstral
// spectral envelope (core/envelope.js) at its new place, so the formants stay
// where the mouth put them and the words stay clear.

import { spectralProcess } from '../../core/stft.js'
import { cepstralEnvelope } from '../../core/envelope.js'
import { resolveParams } from '../../core/params.js'
import { frameSize, progressTo, cleanSig, blendInto, PeakWarp, TWO_PI } from './_spectral.js'

class PowerWarp {
  constructor(sr, a) {
    this.piv = (TWO_PI * 150) / sr
    this.a = a
    this.low = (TWO_PI * 40) / sr
  }

  map(w) {
    if (w < this.low) return w
    return this.piv * Math.pow(w / this.piv, this.a)
  }
}

function stretchChannel(src, sr, N, p) {
  const nb = (N >> 1) + 1
  const hop = N >> 2
  const pw = new PeakWarp(N, hop)
  const warp = new PowerWarp(sr, p.factor)
  const mag = new Float64Array(nb)
  const env = new Float32Array(nb)
  const envOpts = { out: env }
  const order = Math.max(4, Math.round(0.0016 * sr))
  const keep = p.formants
  return spectralProcess(src, { size: N, hop }, (re, im) => {
    if (keep) {
      for (let k = 0; k < nb; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      cepstralEnvelope(mag, order, envOpts)
    }
    pw.run(re, im, warp, keep ? env : null)
  })
}

const stretch = {
  id: 'spec.stretch',
  name: 'Spectral stretch',
  family: 'spec',
  about: 'Pulls the harmonics of your voice apart or squeezes them together, for bell and metal voices.',
  params: [
    { id: 'factor', name: 'Stretch', type: 'number', min: 0.5, max: 2, step: 0.01, def: 1.3, unit: 'x', rand: [0.75, 1.5] },
    { id: 'formants', name: 'Keep vowels', type: 'bool', def: true },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [70, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 3,
  process(input, params, ctx) {
    const p = resolveParams(stretch, params)
    const sr = input.sr
    const nch = input.ch.length
    const len = input.ch[0] ? input.ch[0].length : 0
    if (len === 0) return { sr, ch: input.ch.map(() => new Float32Array(0)) }
    const N = frameSize(sr, 42.7)
    const ch = []
    for (let c = 0; c < nch; c++) {
      const src = input.ch[c]
      const wet = Math.abs(p.factor - 1) < 1e-6 ? new Float32Array(src) : stretchChannel(src, sr, N, p)
      ch.push(cleanSig(blendInto(wet, src, p.mix / 100)))
      progressTo(ctx, (c + 1) / nch)
    }
    return { sr, ch }
  },
}

export default stretch
