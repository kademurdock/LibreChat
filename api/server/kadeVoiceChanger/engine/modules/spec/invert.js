// modules/spec/invert.js - Mirror spectrum: the voice turned inside out.
//
// Technique: spectral inversion, the principle of the classic analogue
// speech-inversion scrambler (frequencies f become 2c - f inside the band
// 0..2c, so lows come out high and highs come out low; see for example Beker
// and Piper, "Secure Speech Communications", 1985). In the STFT domain the
// mirrored frame is Y[k] = conj(X[K - k]) for 0 <= k <= K (K = 2c in bins),
// which is the negative-frequency image of the frame modulated by
// exp(i 2 pi K n / N). As in spec.shift, frame u (starting at sample s) is
// rotated by exp(i 2 pi K s / N) so every frame agrees with the same global
// modulation: the result is an exact, artefact-free inversion. The mirror
// point is rounded to half a bin of an 85 ms frame (about 6 Hz). Everything
// above 2c is dropped, as in the real scramblers.

import { spectralProcess } from '../../core/stft.js'
import { resolveParams } from '../../core/params.js'
import { frameSize, progressTo, cleanSig, blendInto, TWO_PI } from './_spectral.js'

function invertSignal(src, sr, hz, N) {
  const nb = (N >> 1) + 1
  let K = Math.round((2 * hz * N) / sr)
  if (K > nb - 1) K = nb - 1
  if (K < 2) K = 2
  const tr = new Float64Array(nb)
  const ti = new Float64Array(nb)
  // anything landing under 50 Hz is only rumble: leave it out
  const kLow = Math.max(1, Math.ceil((50 * N) / sr))
  return spectralProcess(src, { size: N, hop: N >> 2 }, (re, im, f, info) => {
    let q = (K * info.start) % N
    if (q < 0) q += N
    const ang = (TWO_PI * q) / N
    const c = Math.cos(ang)
    const s = Math.sin(ang)
    tr.fill(0)
    ti.fill(0)
    for (let k = kLow; k < K && k < nb - 1; k++) {
      const j = K - k
      const a = re[j]
      const b = j === 0 || j === nb - 1 ? 0 : -im[j] // conjugate
      tr[k] = a * c - b * s
      ti[k] = a * s + b * c
    }
    for (let k = 0; k < nb; k++) {
      re[k] = tr[k]
      im[k] = ti[k]
    }
  })
}

const invert = {
  id: 'spec.invert',
  name: 'Mirror spectrum',
  family: 'spec',
  about: 'Flips your voice inside out, lows become highs, like an old scrambled radio.',
  params: [
    { id: 'hz', name: 'Mirror around', type: 'number', min: 300, max: 6000, step: 10, def: 1650, unit: 'hz', rand: [1100, 2600] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [70, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 2,
  process(input, params, ctx) {
    const p = resolveParams(invert, params)
    const sr = input.sr
    const nch = input.ch.length
    const len = input.ch[0] ? input.ch[0].length : 0
    if (len === 0) return { sr, ch: input.ch.map(() => new Float32Array(0)) }
    const N = frameSize(sr, 85.3)
    const hz = Math.min(p.hz, sr * 0.245)
    const ch = []
    for (let c = 0; c < nch; c++) {
      const src = input.ch[c]
      const wet = invertSignal(src, sr, hz, N)
      ch.push(cleanSig(blendInto(wet, src, p.mix / 100)))
      progressTo(ctx, (c + 1) / nch)
    }
    return { sr, ch }
  },
}

export default invert
