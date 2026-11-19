// stereo.split - Split personality: a different you in each ear.
//
// Technique: two independent pitch-and-timbre shifts of the same take
// (core/voice.js shiftVoice, pitch-synchronous overlap-add with formant
// resampling, after Moulines and Charpentier 1990 and Praat's change-gender
// method), sharing one pitch analysis, each placed toward its own ear with
// an equal-power pan. "Both at once" plays the two people together, word for
// word in sync, so the ears argue; "Take turns" hands each phrase
// (core/segment.js findPhrases) to the other person, crossfading in the
// pauses, so they talk one after the other.

import { shiftVoice } from '../../core/voice.js'
import { trackPitch } from '../../core/pitch.js'
import { findPhrases } from '../../core/segment.js'
import { clamp, finite, monoOf, panGains, cleanSig } from './_lib.js'

export default {
  id: 'stereo.split',
  name: 'Split personality',
  family: 'stereo',
  about: 'Two different people made from your voice, one in each ear, talking together or taking turns.',
  params: [
    { id: 'leftPitch', name: 'Left voice pitch', type: 'number', min: -12, max: 12, step: 0.5, def: -5, unit: 'semitones', rand: [-8, 0] },
    { id: 'leftTimbre', name: 'Left voice timbre', type: 'number', min: -6, max: 6, step: 0.5, def: -3, unit: 'semitones', rand: [-4, 1] },
    { id: 'rightPitch', name: 'Right voice pitch', type: 'number', min: -12, max: 12, step: 0.5, def: 5, unit: 'semitones', rand: [0, 8] },
    { id: 'rightTimbre', name: 'Right voice timbre', type: 'number', min: -6, max: 6, step: 0.5, def: 3, unit: 'semitones', rand: [-1, 4] },
    {
      id: 'mode', name: 'How they talk', type: 'choice', def: 'both',
      options: [{ v: 'both', name: 'Both at once' }, { v: 'turns', name: 'Take turns, phrase by phrase' }],
    },
    { id: 'apart', name: 'How far apart', type: 'number', min: 0, max: 100, step: 1, def: 85, unit: 'percent', rand: [60, 100] },
  ],
  stereo: 'make',
  tail: () => 0,
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    const sr = input.sr
    const x = monoOf(input)
    const n = x.length
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    if (n === 0) return { sr, ch: [L, R] }
    const track = trackPitch(x, sr)
    const a = shiftVoice(x, sr, { semitones: clamp(finite(p.leftPitch, -5), -12, 12), formant: clamp(finite(p.leftTimbre, -3), -6, 6), track, seed: 'split-left' })
    if (ctx && typeof ctx.progress === 'function') ctx.progress(0.5)
    const b = shiftVoice(x, sr, { semitones: clamp(finite(p.rightPitch, 5), -12, 12), formant: clamp(finite(p.rightTimbre, 3), -6, 6), track, seed: 'split-right' })
    const apart = clamp(finite(p.apart, 85), 0, 100) / 100
    const gA = panGains(-apart, new Float64Array(2))
    const gB = panGains(apart, new Float64Array(2))
    if (p.mode === 'turns') {
      // weight of the left person, phrase by phrase, crossfading in pauses
      const ph = findPhrases(x, sr)
      const w = new Float32Array(n)
      const xf = Math.max(1, Math.round(0.03 * sr))
      let cur = 1
      let from = 0
      for (let k = 0; k <= ph.length; k++) {
        const sw = k < ph.length - 1 ? Math.round(0.5 * (ph[k].end + ph[k + 1].start)) : n
        const end = Math.min(n, sw)
        for (let i = from; i < end; i++) w[i] = cur
        if (k >= ph.length - 1) {
          for (let i = end; i < n; i++) w[i] = cur
          break
        }
        // crossfade around the switch
        const next = 1 - cur
        for (let j = -xf; j < xf; j++) {
          const i = sw + j
          if (i < 0 || i >= n) continue
          const f = (j + xf) / (2 * xf)
          w[i] = cur + (next - cur) * (0.5 - 0.5 * Math.cos(Math.PI * f))
        }
        from = Math.min(n, sw + xf)
        cur = next
      }
      for (let i = 0; i < n; i++) {
        const wa = Math.sqrt(w[i])
        const wb = Math.sqrt(1 - w[i])
        const va = a[i] * wa, vb = b[i] * wb
        L[i] = va * gA[0] + vb * gB[0]
        R[i] = va * gA[1] + vb * gB[1]
      }
    } else {
      const g = 0.85
      for (let i = 0; i < n; i++) {
        L[i] = (a[i] * gA[0] + b[i] * gB[0]) * g
        R[i] = (a[i] * gA[1] + b[i] * gB[1]) * g
      }
    }
    return { sr, ch: [cleanSig(L), cleanSig(R)] }
  },
}
