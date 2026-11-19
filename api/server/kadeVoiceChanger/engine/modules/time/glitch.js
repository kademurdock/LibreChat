// modules/time/glitch.js - time.glitch, "Glitch": the voice breaks into
// beat-repeat glitches, slices that fire again on a tempo grid, flip
// backwards, jump in pitch, roll faster and faster, or freeze into a buzz.
//
// Technique: the beat-repeat and buffer-shuffle family of production
// effects, built the way Nick Collins describes automatic breakbeat cutting
// ("Algorithmic composition methods for breakbeat science", 2001; the BBCut
// library): at chosen moments a slice is captured and replayed as a burst of
// repeats whose lengths come from note divisions of a tempo (eighth,
// sixteenth and thirty-second notes), with per-repeat gating, reversal and
// pitch. The aesthetic is the "glitch" of Kim Cascone, "The aesthetics of
// failure" (Computer Music Journal 24:4, 2000), but tidy: every slice edge is
// a raised-cosine crossfade of about 2.5 ms (renderSegments in _lib.js), so
// the cuts are crisp without clicks, and pitch jumps read the slice faster or
// slower through a low-passed copy so nothing aliases.
// Event kinds, drawn from the seeded rng:
// - repeat: the slice fires 2 or more times, with a gate (a short gap) after
//   each copy;
// - roll: two eighths, two sixteenths, then thirty-seconds, building in level
//   (and climbing in pitch when the event is also pitched);
// - freeze: a 18 to 40 ms grain looped seamlessly into a short buzz;
// - any of them backwards (every copy, or every other copy), and any of them
//   pitched by a musical interval or diving or rising step by step.
// Glitches start on syllable starts (core/segment.js), so a repeat catches
// the front of a sound. "Add the glitches" inserts them and the words carry
// on after; "Keep the timing" writes them over what came next, like a CD
// skipping, so the take keeps its length.

import { mixDown, prepare, renderBuf, forwardSeg, silenceSeg, msToSamples } from './_lib.js'
import { findSyllables } from '../../core/segment.js'
import { makeRng } from '../../core/rng.js'

const JUMPS = [12, 7, 5, -5, -7, -12, 'dive', 'rise']

export default {
  id: 'time.glitch',
  name: 'Glitch',
  family: 'time',
  about: 'Breaks your voice into beat-repeat glitches: slices that repeat on a tempo, flip backwards, jump in pitch and roll faster.',
  params: [
    { id: 'density', name: 'How often', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [20, 60] },
    { id: 'repeats', name: 'Most repeats', type: 'number', min: 1, max: 16, step: 1, def: 6, unit: 'count', noun: ['repeat', 'repeats'], rand: [3, 8] },
    { id: 'tempo', name: 'Tempo', type: 'number', min: 60, max: 200, step: 1, def: 120, unit: 'bpm', rand: [90, 150] },
    { id: 'reverse', name: 'Backwards pieces', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 60] },
    { id: 'pitch', name: 'Pitch jumps', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 60] },
    { id: 'roll', name: 'Speed-up rolls', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 60] },
    {
      id: 'mode',
      name: 'Timing',
      type: 'choice',
      def: 'insert',
      options: [
        { v: 'insert', name: 'Add the glitches' },
        { v: 'replace', name: 'Keep the timing' },
      ],
    },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: true,
  cost: 2,
  process(input, p, ctx) {
    const n = prepare(input)
    if (!n) return input
    const sr = input.sr
    const density = Math.max(0, Math.min(1, (Number(p.density) || 0) / 100))
    if (density <= 0) return input
    const syl = findSyllables(mixDown(input), sr)
    if (!syl.length) return input
    const rng = ctx && ctx.rng ? ctx.rng : makeRng('time.glitch')
    const beat = (60 / Math.max(20, Number(p.tempo) || 120)) * sr
    const maxR = Math.max(1, Math.round(Number(p.repeats) || 1))
    const pRev = Math.max(0, Math.min(1, (Number(p.reverse) || 0) / 100))
    const pPitch = Math.max(0, Math.min(1, (Number(p.pitch) || 0) / 100))
    const pRoll = Math.max(0, Math.min(1, (Number(p.roll) || 0) / 100))
    const replace = p.mode === 'replace'
    const h = msToSamples(1.25, sr, 1)
    const hFreeze = msToSamples(3, sr, 1)
    const minPiece = msToSamples(10, sr, 8)
    const spacing = msToSamples(380, sr, 1)
    const pc = density * 0.4

    // pick the moments (at least one)
    const at = []
    let next = 0
    for (let k = 0; k < syl.length; k++) {
      const s = syl[k].start
      if (s < next || s >= n - minPiece) continue
      if (rng.next() < pc) {
        at.push(s)
        next = s + spacing
      }
    }
    if (!at.length) at.push(syl[rng.int(syl.length)].start)

    // added glitches never grow the take past three times its length (or 10 s)
    const budget = Math.max(10 * sr, 3 * n)
    let added = 0
    const segs = []
    let cur = 0
    for (let e = 0; e < at.length; e++) {
      const s = at[e]
      if (s < cur) continue
      if (!replace && added > budget) break
      if (s > cur) segs.push(forwardSeg(cur, s - cur, h))
      // what kind of glitch
      const R = maxR <= 1 ? 1 : Math.max(2, Math.round(Math.ceil(maxR / 2) + rng.next() * (maxR - Math.ceil(maxR / 2))))
      const isRoll = rng.next() < pRoll
      const isFreeze = !isRoll && R >= 4 && rng.next() < 0.2
      const rev = rng.next() < pRev
      const revAll = rng.next() < 0.5
      const pitched = rng.next() < pPitch
      const jump = pitched ? (isRoll ? 'rise' : JUMPS[rng.int(JUMPS.length)]) : 0
      const pieces = [] // [length, semitones, gain]
      if (isFreeze) {
        const g = msToSamples(18 + 22 * rng.next(), sr, minPiece)
        const count = Math.min(48, 3 * R)
        for (let r = 0; r < count; r++) pieces.push([g, typeof jump === 'number' ? jump : 0, 0.9, 0])
      } else if (isRoll) {
        let L = rng.next() < 0.5 ? beat / 2 : beat / 4
        const count = Math.max(4, Math.min(24, R + 4))
        let inGroup = 0
        let groupSize = 2
        for (let r = 0; r < count && L >= minPiece; r++) {
          const semis = pitched ? Math.min(12, r) : 0
          const g = 0.55 + (0.45 * r) / Math.max(1, count - 1)
          pieces.push([Math.round(L), semis, g, 0.1])
          if (++inGroup >= groupSize) {
            inGroup = 0
            L /= 2
            groupSize *= 2
          }
        }
      } else {
        const u = rng.next()
        const L = u < 0.5 ? beat / 4 : u < 0.8 ? beat / 2 : beat / 8
        const gate = [0, 0.12, 0.25, 0.4][rng.int(4)]
        for (let r = 0; r < R; r++) {
          let semis = 0
          if (jump === 'dive') semis = -1.5 * r
          else if (jump === 'rise') semis = 1.5 * r
          else if (typeof jump === 'number') semis = jump
          pieces.push([Math.max(minPiece, Math.round(L)), semis, 1, gate])
        }
      }
      let outLen = 0
      const xf = isFreeze ? hFreeze : h
      for (let r = 0; r < pieces.length; r++) {
        const [Lr, semis, g, gate] = pieces[r]
        // keeping the timing, a glitch never runs past the end of the take
        if (replace && s + outLen + Lr > n) break
        const rate = Math.pow(2, Math.max(-24, Math.min(24, semis)) / 12)
        const sound = Math.max(4, Math.round(Lr * (1 - gate)))
        const back = rev && (revAll || r % 2 === 1)
        if (back) segs.push({ kind: 'src', src: s + (sound - 1) * rate, len: sound, dir: -1, rate, gain: g, xf })
        else segs.push({ kind: 'src', src: s, len: sound, dir: 1, rate, gain: g, xf })
        if (Lr > sound) segs.push(silenceSeg(Lr - sound, xf))
        outLen += Lr
      }
      cur = replace ? Math.min(n, s + outLen) : s
      added += outLen
    }
    if (cur < n) segs.push(forwardSeg(cur, n - cur, h))
    const out = renderBuf(input, segs)
    if (ctx && typeof ctx.progress === 'function') ctx.progress(1)
    return out
  },
}
