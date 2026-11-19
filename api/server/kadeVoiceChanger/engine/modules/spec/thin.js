// modules/spec/thin.js - Spectral gate: keep only the loud parts of the spectrum, or only the quiet.
//
// Technique: a per-bin spectral gate, the frequency-domain cousin of a noise
// gate (spectral thresholding as in Wishart 1994, "Audible Design", and the
// spectral "tracing" processes of the phase-vocoder tradition). Every bin is
// compared with a reference level: the louder of the current frame's loudest
// bin and a slowly falling memory of recent loud frames, so pauses gate shut
// instead of letting the room noise through. "Keep the loud parts" passes
// bins within the threshold of that reference (a skeleton made of the
// strongest harmonics); "Keep the quiet parts" passes only what lies below it
// (the breath and hiss between the harmonics: a wispy ghost). A soft knee and
// a per-bin attack and release smoother keep the familiar "musical noise"
// twitter of hard spectral gates down; "Smoothness" sets both.

import { spectralProcess } from '../../core/stft.js'
import { resolveParams } from '../../core/params.js'
import { frameSize, progressTo, cleanSig, blendInto } from './_spectral.js'

function thinChannel(src, sr, N, p) {
  const nb = (N >> 1) + 1
  const hop = N >> 2
  const g = new Float64Array(nb)
  const mag = new Float64Array(nb)
  const sm = p.smooth / 100
  const knee = 1 + 11 * sm
  const thr = p.threshold
  const quiet = p.keep === 'quiet'
  const frameSec = hop / sr
  const cAtt = Math.exp(-frameSec / (0.002 + 0.02 * sm))
  const cRel = Math.exp(-frameSec / (0.01 + 0.15 * sm))
  const refFall = Math.exp(-frameSec / 0.35)
  const slowFall = Math.exp(-frameSec / 3)
  let ref = 0
  let refSlow = 0
  const LN = 20 / Math.LN10
  return spectralProcess(src, { size: N, hop }, (re, im) => {
    let mx = 0
    for (let k = 0; k < nb; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      mag[k] = m
      if (m > mx) mx = m
    }
    ref = Math.max(mx, ref * refFall)
    refSlow = Math.max(mx, refSlow * slowFall)
    // absolute floor: about -90 dB for a full-scale sine's peak bin
    const floor = (N / 4) * 3e-5
    const refDb = ref > floor ? LN * Math.log(ref) : LN * Math.log(floor)
    // the quiet parts stop 35 dB under the threshold, so pauses stay quiet
    const lowDb = (refSlow > floor ? LN * Math.log(refSlow) : LN * Math.log(floor)) + thr - 35 - refDb
    for (let k = 0; k < nb; k++) {
      const m = mag[k]
      const l = m > 1e-30 ? LN * Math.log(m) - refDb : -400
      // soft knee around the threshold: 0 below, 1 above
      let t = (l - thr) / knee + 0.5
      t = t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t)
      let target = t
      if (quiet) {
        let u = (l - lowDb) / knee + 0.5
        u = u < 0 ? 0 : u > 1 ? 1 : u * u * (3 - 2 * u)
        target = (1 - t) * u
        if (m < floor) target = 0
      }
      const c = target > g[k] ? cAtt : cRel
      let v = target + c * (g[k] - target)
      if (v < 1e-9) v = 0
      g[k] = v
      re[k] *= v
      im[k] *= v
    }
  })
}

const thin = {
  id: 'spec.thin',
  name: 'Spectral gate',
  family: 'spec',
  about: 'Keeps only the strongest notes of your voice for a skeleton sound, or only the breath for a wispy ghost.',
  params: [
    { id: 'threshold', name: 'Threshold', type: 'number', min: -70, max: -3, step: 1, def: -15, unit: 'db', rand: [-30, -8] },
    {
      id: 'keep', name: 'Keep', type: 'choice', def: 'loud',
      options: [
        { v: 'loud', name: 'The loud parts' },
        { v: 'quiet', name: 'The quiet parts' },
      ],
    },
    { id: 'smooth', name: 'Smoothness', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [20, 80] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [80, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 2,
  process(input, params, ctx) {
    const p = resolveParams(thin, params)
    const sr = input.sr
    const nch = input.ch.length
    const len = input.ch[0] ? input.ch[0].length : 0
    if (len === 0) return { sr, ch: input.ch.map(() => new Float32Array(0)) }
    const N = frameSize(sr, 42.7)
    const ch = []
    for (let c = 0; c < nch; c++) {
      const src = input.ch[c]
      const wet = thinChannel(src, sr, N, p)
      ch.push(cleanSig(blendInto(wet, src, p.mix / 100)))
      progressTo(ctx, (c + 1) / nch)
    }
    return { sr, ch }
  },
}

export default thin
