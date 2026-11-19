// modules/time/drawl.js - time.drawl, "Slow-motion stretch": the voice is
// drawn out, either keeping its pitch (a lazy drawl) or dropping with it like
// a slow-motion film shot.
//
// Technique, pitch kept: phase-vocoder time stretching with identity phase
// locking (core/pv.js stretch; Laroche and Dolson 1999), which keeps
// consonant attacks crisp. By default the stretch is non-uniform, the idea of
// Covell, Withgott and Slaney, "MACH1: Nonuniform time-scale modification of
// speech" (ICASSP 1998): steady vowels carry most of the stretch while
// consonants and bursts stay close to their own speed, which is how people
// really drawl and why it sounds far more natural than stretching
// everything evenly. A vowel weight comes from the 300 Hz to 2.5 kHz band
// (where vowels put their energy and s or sh do not) in 10 ms frames, within
// 30 dB of the loudest frame; the per-frame stretch is then scaled so the
// whole take still comes out the asked-for number of times longer.
// Technique, pitch dropped: plain slow playback through core/resample.js
// (windowed-sinc resampling for a steady factor, varispeed for a varying
// one), so pitch and timbre fall together, the classic slowed-down tape. The
// vowel weighting is skipped here, because a slowed tape's pitch falls with
// its stretch and a weighted stretch would make the pitch wobble.
// Both can ramp: slow down as the take goes on, or start slow and catch up.

import { prepare, msToSamples, mixDown } from './_lib.js'
import { Biquad } from '../../core/biquad.js'
import { stretch } from '../../core/pv.js'
import { resample, varispeed } from '../../core/resample.js'

// Vowel weight per 10 ms hop (0..1).
function vowelWeights(sig, sr, hop) {
  const n = sig.length
  const nh = Math.max(1, Math.ceil(n / hop))
  const band = new Float32Array(sig)
  new Biquad('highpass', sr, Math.min(300, sr * 0.2), 0.707).run(band)
  new Biquad('lowpass', sr, Math.min(2500, sr * 0.45), 0.707).run(band)
  const all = new Float32Array(sig)
  new Biquad('highpass', sr, Math.min(70, sr * 0.2), 0.707).run(all)
  const dbv = new Float32Array(nh)
  const ratio = new Float32Array(nh)
  let top = -200
  for (let k = 0; k < nh; k++) {
    let ev = 0
    let ea = 0
    const a = k * hop
    const b = Math.min(n, a + hop)
    for (let i = a; i < b; i++) {
      ev += band[i] * band[i]
      ea += all[i] * all[i]
    }
    const m = Math.max(1, b - a)
    const d = ev / m > 1e-14 ? 10 * Math.log10(ev / m) : -140
    dbv[k] = d
    ratio[k] = ea > 1e-20 ? ev / ea : 0
    if (d > top) top = d
  }
  const w = new Float32Array(nh)
  for (let k = 0; k < nh; k++) {
    let loud = (dbv[k] - (top - 30)) / 18
    loud = loud < 0 ? 0 : loud > 1 ? 1 : loud
    let voc = ratio[k] * 1.6
    voc = voc > 1 ? 1 : voc
    w[k] = loud * voc
  }
  // a short moving average (50 ms) so the stretch glides
  const s = new Float32Array(nh)
  for (let k = 0; k < nh; k++) {
    let acc = 0
    let c = 0
    for (let q = Math.max(0, k - 2); q <= Math.min(nh - 1, k + 2); q++) {
      acc += w[q]
      c++
    }
    s[k] = acc / c
  }
  return s
}

export default {
  id: 'time.drawl',
  name: 'Slow-motion stretch',
  family: 'time',
  about: 'Draws your voice out slower, keeping your pitch for a lazy drawl, or dropping it like a slow-motion film shot.',
  params: [
    { id: 'factor', name: 'Slow down by', type: 'number', min: 1, max: 4, step: 0.05, def: 1.8, unit: 'x', rand: [1.3, 2.5] },
    {
      id: 'pitch',
      name: 'Pitch',
      type: 'choice',
      def: 'keep',
      options: [
        { v: 'keep', name: 'Keep my pitch' },
        { v: 'drop', name: 'Drop it, like slow motion' },
      ],
    },
    { id: 'vowels', name: 'Stretch the vowels most, when keeping pitch', type: 'bool', def: true },
    {
      id: 'ramp',
      name: 'Change over time',
      type: 'choice',
      def: 'steady',
      options: [
        { v: 'steady', name: 'Steady' },
        { v: 'slowing', name: 'Slows down as it goes' },
        { v: 'catching', name: 'Starts slow, then catches up' },
      ],
    },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: true,
  cost: 3,
  process(input, p, ctx) {
    const n = prepare(input)
    if (!n) return input
    const sr = input.sr
    const F = Math.max(1, Math.min(4, Number(p.factor) || 1))
    if (F <= 1.0001) return input
    const drop = p.pitch === 'drop'
    const steady = p.ramp !== 'slowing' && p.ramp !== 'catching'
    // vowel weighting only when the pitch is kept: slowed tape drops its
    // pitch by the stretch, so weighting would make the pitch wobble
    const vowels = !!p.vowels && !drop
    const uniform = steady && !vowels
    let fac = null
    const hop = msToSamples(10, sr, 1)
    if (!uniform) {
      // per-hop stretch, scaled so the mean over the take is F
      const nh = Math.max(1, Math.ceil(n / hop))
      let w
      if (vowels) {
        w = vowelWeights(mixDown(input), sr, hop)
      } else {
        w = new Float32Array(nh).fill(1)
      }
      const v = new Float32Array(nh)
      for (let k = 0; k < nh; k++) {
        const u = nh > 1 ? k / (nh - 1) : 0.5
        const r = p.ramp === 'slowing' ? 0.15 + 1.7 * u : p.ramp === 'catching' ? 1.85 - 1.7 * u : 1
        v[k] = (0.3 + 0.7 * w[k]) * r
      }
      fac = new Float32Array(nh)
      let k1 = 0
      for (let k = 0; k < nh; k++) k1 += v[k]
      k1 = k1 > 1e-9 ? nh / k1 : 1
      for (let it = 0; it < 4; it++) {
        let mean = 0
        for (let k = 0; k < nh; k++) {
          let f = 1 + (F - 1) * k1 * v[k]
          if (f > 8) f = 8
          fac[k] = f
          mean += f
        }
        mean /= nh
        if (Math.abs(mean - F) < 1e-3 || mean <= 1) break
        k1 *= (F - 1) / (mean - 1)
      }
    }
    const facAt = (tSec) => {
      const x = (tSec * sr) / hop
      const i = Math.floor(x)
      if (i <= 0) return fac[0]
      if (i >= fac.length - 1) return fac[fac.length - 1]
      return fac[i] + (x - i) * (fac[i + 1] - fac[i])
    }
    const ch = new Array(input.ch.length)
    let minLen = Infinity
    for (let c = 0; c < input.ch.length; c++) {
      if (ctx && typeof ctx.cancelled === 'function' && ctx.cancelled()) return input
      const x = input.ch[c]
      let y
      if (drop) y = uniform ? resample(x, F) : varispeed(x, (t) => 1 / facAt(t), sr, { clock: 'in' })
      else y = uniform ? stretch(x, sr, F) : stretch(x, sr, facAt)
      ch[c] = y
      if (y.length < minLen) minLen = y.length
      if (ctx && typeof ctx.progress === 'function') ctx.progress((c + 1) / input.ch.length)
    }
    for (let c = 0; c < ch.length; c++) if (ch[c].length !== minLen) ch[c] = ch[c].slice(0, minLen)
    return { sr, ch }
  },
}
