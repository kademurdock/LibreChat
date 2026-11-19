// stereo.pingpong - Ping-pong phrases: each phrase (or syllable) jumps to the
// other ear.
//
// Technique: speech segmentation (core/segment.js: findPhrases, a two-level
// energy endpoint detector after Rabiner and Sambur 1975, and findSyllables,
// the syllable-nucleus method of de Jong and Wempe 2009) drives an
// equal-power pan (the sine-cosine pan law, so loudness holds as the voice
// moves). The move between sides is a raised-cosine glide centred in the
// pause between phrases, or on the boundary between syllables; a glide of 0
// is a near-instant 3 ms switch that never clicks.

import { findPhrases, findSyllables } from '../../core/segment.js'
import { clamp, finite, monoOf, panGains, cleanSig } from './_lib.js'

export default {
  id: 'stereo.pingpong',
  name: 'Ping-pong phrases',
  family: 'stereo',
  about: 'Each phrase you say jumps to the other ear, left, right, left. Or every syllable, for a dizzy bounce.',
  params: [
    {
      id: 'unit', name: 'Switch on', type: 'choice', def: 'phrase',
      options: [{ v: 'phrase', name: 'Each phrase' }, { v: 'syllable', name: 'Each syllable' }],
    },
    { id: 'width', name: 'How far to each side', type: 'number', min: 0, max: 100, step: 1, def: 90, unit: 'percent', rand: [60, 100] },
    { id: 'glide', name: 'Glide between sides', type: 'number', min: 0, max: 500, step: 10, def: 40, unit: 'ms', rand: [0, 200] },
    {
      id: 'start', name: 'First side', type: 'choice', def: 'left',
      options: [{ v: 'left', name: 'Left' }, { v: 'right', name: 'Right' }],
    },
  ],
  stereo: 'make',
  tail: () => 0,
  warps: false,
  cost: 1,
  process(input, p) {
    const sr = input.sr
    const x = monoOf(input)
    const n = x.length
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    if (n === 0) return { sr, ch: [L, R] }
    const segs = p.unit === 'syllable' ? findSyllables(x, sr) : findPhrases(x, sr)
    const width = clamp(finite(p.width, 90), 0, 100) / 100
    const first = p.start === 'right' ? 1 : -1
    const glide = Math.max(0.003 * sr, (clamp(finite(p.glide, 40), 0, 500) / 1000) * sr)
    // switch points: middle of each gap (or the boundary when they touch)
    const ns = segs.length
    const sw = new Float64Array(Math.max(0, ns - 1))
    for (let k = 0; k + 1 < ns; k++) sw[k] = 0.5 * (segs[k].end + segs[k + 1].start)
    // half-width of each glide, never overlapping the next or previous one
    const hw = new Float64Array(sw.length)
    for (let k = 0; k < sw.length; k++) {
      let h = glide / 2
      if (k > 0) h = Math.min(h, 0.45 * (sw[k] - sw[k - 1]))
      if (k + 1 < sw.length) h = Math.min(h, 0.45 * (sw[k + 1] - sw[k]))
      hw[k] = Math.max(1, h)
    }
    const g = new Float64Array(2)
    const STEP = 32
    let k = 0
    let gl0 = 0, gr0 = 0, gl1 = 0, gr1 = 0
    const panAt = (i) => {
      // pan at sample i: side of the current segment, gliding across switches
      while (k < sw.length && i > sw[k] + hw[k]) k++
      const side = (k % 2 === 0 ? first : -first) * width
      if (k < sw.length && i > sw[k] - hw[k]) {
        const f = (i - (sw[k] - hw[k])) / (2 * hw[k])
        const w = 0.5 - 0.5 * Math.cos(Math.PI * clamp(f, 0, 1))
        return side + (-side - side) * w
      }
      return side
    }
    panGains(panAt(0), g)
    gl1 = g[0]; gr1 = g[1]
    for (let i0 = 0; i0 < n; i0 += STEP) {
      gl0 = gl1; gr0 = gr1
      panGains(panAt(Math.min(n, i0 + STEP)), g)
      gl1 = g[0]; gr1 = g[1]
      const iEnd = Math.min(n, i0 + STEP)
      for (let i = i0; i < iEnd; i++) {
        const f = (i - i0) / STEP
        const v = x[i]
        L[i] = v * (gl0 + (gl1 - gl0) * f)
        R[i] = v * (gr0 + (gr1 - gr0) * f)
      }
    }
    return { sr, ch: [cleanSig(L), cleanSig(R)] }
  },
}
