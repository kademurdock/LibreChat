// modules/spec/freeze.js - Spectral freeze: moments of the voice caught and held.
//
// Technique: the phase-vocoder freeze (Dolson 1986, "The phase vocoder: a
// tutorial"; the "spectral freeze" of Zolzer, ed., "DAFX", time-frequency
// chapter). At a freeze moment one STFT frame is captured: its magnitudes,
// and each bin's true frequency, measured from the phase advance since the
// previous frame. While the freeze holds, that frame is played again and
// again with every bin's phase advanced by its own frequency times the hop,
// so the captured sound rings on as a steady, glassy chord instead of a
// buzzing loop. Up to four freezes overlap, each with a quick swell in and a
// slow fade out over the last part of its hold. Freezes are caught either on
// a steady beat or at the start of each syllable (core/segment.js
// findSyllables, captured at the syllable's loudest moment), never closer
// together than the interval. "Frozen level" sets how far the held sound
// replaces the live voice while it rings.

import { spectralProcess, stftLayout } from '../../core/stft.js'
import { findSyllables, findPhrases } from '../../core/segment.js'
import { resolveParams } from '../../core/params.js'
import { frameSize, progressTo, padSig, cleanSig, TWO_PI } from './_spectral.js'

const VOICES = 4

function triggerSamples(mono, sr, p) {
  const len = mono.length
  const minGap = Math.round((p.interval / 1000) * sr)
  const out = []
  if (p.when === 'words') {
    const syl = findSyllables(mono, sr)
    let last = -Infinity
    for (const s of syl) {
      const t = s.peak !== undefined ? s.peak : (s.start + s.end) >> 1
      if (t - last >= minGap) {
        out.push(t)
        last = t
      }
    }
    if (out.length) return out
  }
  // steady beat from the first sound onward
  const ph = findPhrases(mono, sr)
  let t = ph.length ? ph[0].start + Math.round(0.08 * sr) : Math.round(0.08 * sr)
  while (t < len) {
    out.push(t)
    t += Math.max(1, minGap)
  }
  return out
}

function freezeChannel(src, sr, N, hop, trigFrames, p) {
  const nb = (N >> 1) + 1
  const holdFrames = Math.max(2, Math.round(((p.hold / 1000) * sr) / hop))
  const blend = p.blend / 100
  const prevPh = new Float64Array(nb)
  const curPh = new Float64Array(nb)
  const curMag = new Float64Array(nb)
  const curW = new Float64Array(nb)
  const voices = []
  for (let v = 0; v < VOICES; v++) {
    voices.push({ on: false, age: 0, mag: new Float64Array(nb), w: new Float64Array(nb), ph: new Float64Array(nb) })
  }
  const binW = TWO_PI / N
  let ti = 0
  const att = 2
  const relStart = Math.floor(holdFrames * 0.55)
  return spectralProcess(src, { size: N, hop }, (re, im, f) => {
    for (let k = 0; k < nb; k++) {
      const a = re[k]
      const b = im[k]
      curMag[k] = Math.sqrt(a * a + b * b)
      const ph = Math.atan2(b, a)
      curPh[k] = ph
      let d = ph - prevPh[k] - k * binW * hop
      d -= TWO_PI * Math.round(d / TWO_PI)
      curW[k] = k * binW + d / hop
      prevPh[k] = ph
    }
    // new freezes caught at this frame
    while (ti < trigFrames.length && trigFrames[ti] <= f) {
      if (trigFrames[ti] === f && f > 0) {
        let slot = -1
        let oldest = -1
        for (let v = 0; v < VOICES; v++) {
          if (!voices[v].on) {
            slot = v
            break
          }
          if (oldest < 0 || voices[v].age > voices[oldest].age) oldest = v
        }
        if (slot < 0) slot = oldest
        const vc = voices[slot]
        vc.on = true
        vc.age = 0
        vc.mag.set(curMag)
        vc.w.set(curW)
        vc.ph.set(curPh)
      }
      ti++
    }
    // held sound for this frame
    let duck = 0
    let anyOn = false
    for (let v = 0; v < VOICES; v++) {
      const vc = voices[v]
      if (!vc.on) continue
      let e
      if (vc.age < att) e = 0.5 - 0.5 * Math.cos((Math.PI * (vc.age + 1)) / (att + 1))
      else if (vc.age < relStart) e = 1
      else e = 0.5 + 0.5 * Math.cos((Math.PI * (vc.age - relStart)) / Math.max(1, holdFrames - relStart))
      if (e > duck) duck = e
      vc.e = e * blend
      anyOn = true
    }
    if (!anyOn) return
    const keep = 1 - blend * duck
    for (let k = 0; k < nb; k++) {
      re[k] *= keep
      im[k] *= keep
    }
    for (let v = 0; v < VOICES; v++) {
      const vc = voices[v]
      if (!vc.on) continue
      const e = vc.e
      const mag = vc.mag
      const ph = vc.ph
      const w = vc.w
      for (let k = 1; k < nb - 1; k++) {
        if (vc.age > 0) {
          let q = ph[k] + w[k] * hop
          q -= TWO_PI * Math.round(q / TWO_PI)
          ph[k] = q
        }
        const m = mag[k] * e
        if (m === 0) continue
        re[k] += m * Math.cos(ph[k])
        im[k] += m * Math.sin(ph[k])
      }
      vc.age++
      if (vc.age >= holdFrames) vc.on = false
    }
  })
}

const freeze = {
  id: 'spec.freeze',
  name: 'Spectral freeze',
  family: 'spec',
  about: 'Catches moments of your voice and holds them ringing, like a sound frozen in ice.',
  params: [
    { id: 'hold', name: 'Hold length', type: 'number', min: 50, max: 4000, step: 10, def: 900, unit: 'ms', rand: [300, 2000] },
    { id: 'interval', name: 'Freeze every', type: 'number', min: 100, max: 4000, step: 10, def: 700, unit: 'ms', rand: [300, 1600] },
    { id: 'blend', name: 'Frozen level', type: 'number', min: 0, max: 100, step: 1, def: 65, unit: 'percent', rand: [40, 90] },
    {
      id: 'when', name: 'Freeze when', type: 'choice', def: 'words',
      options: [
        { v: 'words', name: 'At each syllable' },
        { v: 'steady', name: 'On a steady beat' },
      ],
    },
  ],
  stereo: 'keep',
  tail: (p) => (p && p.hold > 0 ? p.hold / 1000 : 0.9),
  warps: false,
  cost: 3,
  process(input, params, ctx) {
    const p = resolveParams(freeze, params)
    const sr = input.sr
    const nch = input.ch.length
    const len = input.ch[0] ? input.ch[0].length : 0
    // an empty take still gets its tail (silence), as every stage promises input + tail
    if (len === 0) return { sr, ch: input.ch.map(() => new Float32Array(Math.round((p.hold / 1000) * sr))) }
    const N = frameSize(sr, 42.7)
    const hop = N >> 2
    const extra = Math.round((p.hold / 1000) * sr)
    const mono = new Float32Array(len)
    for (let c = 0; c < nch; c++) {
      const s = input.ch[c]
      for (let i = 0; i < len; i++) mono[i] += s[i] / nch
    }
    const trig = triggerSamples(mono, sr, p)
    const lay = stftLayout(len + extra, { size: N, hop })
    // frame whose centre is nearest each trigger
    const trigFrames = trig.map((t) => Math.max(1, Math.round((t + lay.pad - N / 2) / hop)))
    const ch = []
    for (let c = 0; c < nch; c++) {
      const src = padSig(input.ch[c], extra)
      ch.push(cleanSig(freezeChannel(src, sr, N, hop, trigFrames, p)))
      progressTo(ctx, (c + 1) / nch)
    }
    return { sr, ch }
  },
}

export default freeze
