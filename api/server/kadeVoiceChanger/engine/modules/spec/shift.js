// modules/spec/shift.js - Spectral shift: every frequency moved by the same hertz.
//
// Technique: linear frequency shifting in the STFT domain. Every bin moves up
// (or down) by K bins, which multiplies each frame by exp(i 2 pi K n / N)
// relative to the frame's own start. To make the frames agree with each
// other, frame u (starting at sample s) is also rotated by exp(i 2 pi K s / N),
// the same modulation measured from the start of the take. Together that is
// exactly single-sideband modulation of the whole signal (as in Bode and Moog's
// analogue frequency shifter, "A high-accuracy frequency shifter for
// professional audio applications", JAES 1972), done with no phase-vocoder
// smearing at all. The shift is rounded to the nearest bin of an 85 ms frame
// (about 12 Hz). Because every partial moves by the same number of hertz,
// harmonics stop being multiples of one pitch: the voice turns inharmonic,
// bell-like and alien. Content shifted below 50 Hz or above the top is dropped.

import { spectralProcess } from '../../core/stft.js'
import { resolveParams } from '../../core/params.js'
import { frameSize, progressTo, cleanSig, blendInto, TWO_PI } from './_spectral.js'

/** Shift one signal by `hz` with an N-point frame; returns a new Float32Array. */
export function shiftSignal(src, sr, hz, N) {
  const nb = (N >> 1) + 1
  const K = Math.round((hz * N) / sr)
  if (K === 0) return new Float32Array(src)
  const tr = new Float64Array(nb)
  const ti = new Float64Array(nb)
  // anything landing under 50 Hz is only rumble: leave it out
  const kLow = Math.max(1, Math.ceil((50 * N) / sr))
  return spectralProcess(src, { size: N, hop: N >> 2 }, (re, im, f, info) => {
    // rotation for this frame: exp(i 2 pi K s / N), computed exactly
    let q = (K * info.start) % N
    if (q < 0) q += N
    const ang = (TWO_PI * q) / N
    const c = Math.cos(ang)
    const s = Math.sin(ang)
    tr.fill(0)
    ti.fill(0)
    for (let k = kLow; k < nb - 1; k++) {
      const j = k - K
      if (j < 0 || j > nb - 1) continue
      const a = re[j]
      const b = j === 0 || j === nb - 1 ? 0 : im[j]
      tr[k] = a * c - b * s
      ti[k] = a * s + b * c
    }
    for (let k = 0; k < nb; k++) {
      re[k] = tr[k]
      im[k] = ti[k]
    }
  })
}

const shift = {
  id: 'spec.shift',
  name: 'Spectral shift',
  family: 'spec',
  about: 'Slides every frequency of your voice by the same amount, so it turns metallic and alien.',
  params: [
    { id: 'hz', name: 'Shift', type: 'number', min: -2000, max: 2000, step: 1, def: 250, unit: 'hz', rand: [-350, 650] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [60, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 2,
  process(input, params, ctx) {
    const p = resolveParams(shift, params)
    const sr = input.sr
    const nch = input.ch.length
    const len = input.ch[0] ? input.ch[0].length : 0
    if (len === 0) return { sr, ch: input.ch.map(() => new Float32Array(0)) }
    const N = frameSize(sr, 85.3)
    const ch = []
    for (let c = 0; c < nch; c++) {
      const src = input.ch[c]
      const wet = shiftSignal(src, sr, p.hz, N)
      ch.push(cleanSig(blendInto(wet, src, p.mix / 100)))
      progressTo(ctx, (c + 1) / nch)
    }
    return { sr, ch }
  },
}

export default shift
