// modules/spec/comb.js - Harmonic comb: the voice sung through a tuned chord.
//
// Technique, two paths mixed by "Ring":
// 1. A spectral comb filter. Each bin is weighted by
//    ((1 + cos(2 pi f / f0)) / 2)^s for every note f0 of the chosen chord (the
//    largest weight wins), a raised-cosine comb whose teeth sit on the
//    harmonics of each note; "Sharpness" sets s. Unlike a delay-line comb
//    (Schroeder 1962) it has no ringing tail and no feedback to run away, and
//    the teeth can be as narrow as one bin of an 85 ms frame.
// 2. Resonant teeth: every harmonic of every chord note is written as an
//    exact, phase-continuous partial with inverse-FFT additive synthesis
//    (Rodet and Depalle 1992; _spectral.js addPartial), each doubled a few
//    cents apart for a choral beat, with its level read from the voice's
//    cepstral spectral envelope at that frequency (core/envelope.js). That is
//    the chord singing your vowels, like a choir that follows your mouth.
// Both paths are energy-matched to the voice frame by frame, with a smoothed
// gain so loudness never pumps.

import { spectralProcess } from '../../core/stft.js'
import { cepstralEnvelope } from '../../core/envelope.js'
import { resolveParams } from '../../core/params.js'
import { frameSize, progressTo, cleanSig, blendInto, addPartial, rngOf, TWO_PI } from './_spectral.js'

const CHORDS = {
  one: [0],
  fifth: [0, 7],
  major: [0, 4, 7],
  minor: [0, 3, 7],
  sus: [0, 5, 7],
  seventh: [0, 4, 7, 10],
  eerie: [0, 1, 6],
}

function combChannel(src, sr, N, p, rng) {
  const nb = (N >> 1) + 1
  const hop = N >> 2
  const notes = (CHORDS[p.chord] || CHORDS.fifth).map((st) => p.base * Math.pow(2, st / 12))
  const s = Math.pow(2, (p.sharpness / 100) * 7)
  // comb mask
  const mask = new Float64Array(nb)
  for (let k = 1; k < nb; k++) {
    const f = (k * sr) / N
    let best = 0
    for (const f0 of notes) {
      if (f < f0 * 0.6) continue
      const v = Math.pow(0.5 + 0.5 * Math.cos((TWO_PI * f) / f0), s)
      if (v > best) best = v
    }
    mask[k] = best
  }
  // resonant teeth
  const top = Math.min(9000, sr * 0.45)
  const tf = []
  for (const f0 of notes) {
    for (let h = 1; h * f0 < top; h++) {
      tf.push(h * f0 * Math.pow(2, -5 / 1200))
      tf.push(h * f0 * Math.pow(2, 6 / 1200))
    }
  }
  const nt = tf.length
  const tPh = new Float64Array(nt)
  for (let i = 0; i < nt; i++) tPh[i] = TWO_PI * rng.next()
  const ring = p.ring / 100
  const mag = new Float64Array(nb)
  const env = new Float32Array(nb)
  const envOpts = { out: env }
  const order = Math.max(4, Math.round(0.0016 * sr))
  const tRe = new Float64Array(nb)
  const tIm = new Float64Array(nb)
  let gF = -1
  let gT = -1
  const gc = 0.6
  const toBin = N / sr
  return spectralProcess(src, { size: N, hop }, (re, im, f, info) => {
    let e0 = 0
    for (let k = 0; k < nb; k++) {
      const m2 = re[k] * re[k] + im[k] * im[k]
      mag[k] = Math.sqrt(m2)
      e0 += m2
    }
    // filtered path
    let e1 = 0
    for (let k = 0; k < nb; k++) {
      re[k] *= mask[k]
      im[k] *= mask[k]
      e1 += re[k] * re[k] + im[k] * im[k]
    }
    // Both gains are level-free ratios. They fall at once and rise smoothly, so a
    // sudden drop can never overshoot, and they hold through digital silence.
    if (e0 > 1e-24 && e1 > 1e-30) {
      let tf1 = Math.sqrt(e0 / e1)
      if (tf1 > 30) tf1 = 30
      gF = gF < 0 || tf1 < gF ? tf1 : gF * gc + tf1 * (1 - gc)
    }
    // teeth path
    let gTT = -1
    if (ring > 0) {
      tRe.fill(0)
      tIm.fill(0)
      if (e0 > 1e-24) {
        cepstralEnvelope(mag, order, envOpts)
        for (let i = 0; i < nt; i++) {
          const b = tf[i] * toBin
          const k = Math.round(b)
          if (k < 1 || k >= nb - 1) continue
          const amp = env[k]
          // phase at this frame's first sample: advance by one hop per frame
          addPartial(tRe, tIm, N, b, amp, tPh[i])
        }
        let e2 = 0
        for (let k = 0; k < nb; k++) e2 += tRe[k] * tRe[k] + tIm[k] * tIm[k]
        if (e2 > 1e-30) {
          gTT = Math.sqrt(e0 / e2)
          if (gTT > 1e6) gTT = 1e6
        }
      }
      for (let i = 0; i < nt; i++) {
        let q = tPh[i] + TWO_PI * tf[i] * (hop / sr)
        q -= TWO_PI * Math.floor(q / TWO_PI)
        tPh[i] = q
      }
    }
    if (gTT >= 0) gT = gT < 0 || gTT < gT ? gTT : gT * gc + gTT * (1 - gc)
    // equal-power blend of the two (uncorrelated) paths
    const a = Math.cos(ring * 0.5 * Math.PI) * (gF < 0 ? 1 : gF)
    const b = Math.sin(ring * 0.5 * Math.PI) * (gT < 0 ? 0 : gT)
    for (let k = 0; k < nb; k++) {
      re[k] = re[k] * a + tRe[k] * b
      im[k] = im[k] * a + tIm[k] * b
    }
  })
}

const comb = {
  id: 'spec.comb',
  name: 'Harmonic comb',
  family: 'spec',
  about: 'Tunes your voice to a chord, from a metallic ring to a choir singing your words.',
  params: [
    { id: 'base', name: 'Root note', type: 'number', min: 50, max: 800, step: 1, def: 110, unit: 'hz', rand: [80, 260] },
    {
      id: 'chord', name: 'Chord', type: 'choice', def: 'fifth',
      options: [
        { v: 'one', name: 'One note' },
        { v: 'fifth', name: 'Power chord' },
        { v: 'major', name: 'Major' },
        { v: 'minor', name: 'Minor' },
        { v: 'sus', name: 'Suspended' },
        { v: 'seventh', name: 'Seventh' },
        { v: 'eerie', name: 'Eerie cluster' },
      ],
    },
    { id: 'sharpness', name: 'Sharpness', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [35, 85] },
    { id: 'ring', name: 'Ring', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [20, 80] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [70, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 3,
  process(input, params, ctx) {
    const p = resolveParams(comb, params)
    const sr = input.sr
    const nch = input.ch.length
    const len = input.ch[0] ? input.ch[0].length : 0
    if (len === 0) return { sr, ch: input.ch.map(() => new Float32Array(0)) }
    const N = frameSize(sr, 85.3)
    const rng = rngOf(ctx, 'spec.comb')
    const ch = []
    for (let c = 0; c < nch; c++) {
      const src = input.ch[c]
      // the same tooth phases on both sides keep a stereo voice centred
      const wet = combChannel(src, sr, N, p, rng.fork('teeth'))
      ch.push(cleanSig(blendInto(wet, src, p.mix / 100)))
      progressTo(ctx, (c + 1) / nch)
    }
    return { sr, ch }
  },
}

export default comb
