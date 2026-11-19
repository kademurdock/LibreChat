// modules/time/reversewords.js - time.reversewords, "Backwards words": every
// syllable, word or phrase is played backwards in its own place, so the
// sentence keeps its rhythm, its pauses and its tune while the sounds inside
// turn over. It sounds like a secret language spoken by you.
//
// Technique: locally time-reversed speech, the method of Saberi and Perrott,
// "Cognitive restoration of reversed speech" (Nature 398, 1999): the signal
// is cut into pieces and each piece is reversed where it stands. With pieces
// under about 60 ms the words stay understandable (a garbled, gritty voice);
// at syllable length and longer they turn into fluent nonsense with the
// speaker's own rhythm. Here the pieces can follow the speech itself
// (syllables, words or phrases from core/segment.js, so cuts fall in the dips
// between sounds) or be even slices of a set length, as in that study.
// Each speech unit turns only its sounding middle (within 30 dB of its own
// peak), so the quiet lead-in and decay at the edges of every phrase stay
// where they were and the pauses keep their length. Every join is a short
// raised-cosine crossfade (renderSegments in _lib.js), and pauses between
// phrases are left untouched.

import { findUnits, unitCore, mixDown, prepare, renderBuf, forwardSeg, reverseSeg, msToSamples } from './_lib.js'
import { makeRng } from '../../core/rng.js'

export default {
  id: 'time.reversewords',
  name: 'Backwards words',
  family: 'time',
  about: 'Every syllable or word plays backwards in its own place, so your sentence keeps its rhythm but turns into a secret language.',
  params: [
    {
      id: 'unit',
      name: 'Piece',
      type: 'choice',
      def: 'syllables',
      options: [
        { v: 'syllables', name: 'Syllables' },
        { v: 'words', name: 'Words' },
        { v: 'phrases', name: 'Whole phrases' },
        { v: 'slices', name: 'Even slices' },
      ],
    },
    { id: 'sliceMs', name: 'Slice length, for even slices', type: 'number', min: 20, max: 500, step: 5, def: 120, unit: 'ms', rand: [60, 250] },
    { id: 'amount', name: 'How many pieces turn', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [60, 100] },
    { id: 'smooth', name: 'Smoothing', type: 'number', min: 1, max: 40, step: 1, def: 8, unit: 'ms', rand: [4, 14] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: true,
  cost: 1,
  process(input, p, ctx) {
    const n = prepare(input)
    if (!n) return input
    const sr = input.sr
    const mono = mixDown(input)
    const units = findUnits(mono, sr, p.unit, p.sliceMs)
    if (!units.length) return input
    const rng = ctx && ctx.rng ? ctx.rng : makeRng('time.reversewords')
    const chance = Math.max(0, Math.min(1, (Number(p.amount) || 0) / 100))
    const h = msToSamples(p.smooth / 2, sr, 1)
    const exact = p.unit === 'slices'
    const segs = []
    let cur = 0
    for (let k = 0; k < units.length; k++) {
      // speech units turn only their sounding middle, so the quiet edges of
      // each phrase (and so its start, end and pauses) stay in place; even
      // slices turn whole, as in the published method
      const u = exact ? units[k] : unitCore(mono, sr, units[k])
      if (u.end <= cur) continue
      const a = Math.max(cur, u.start)
      if (a > cur) segs.push(forwardSeg(cur, a - cur, h))
      if (rng.next() < chance) segs.push(reverseSeg(a, u.end, h))
      else segs.push(forwardSeg(a, u.end - a, h))
      cur = u.end
    }
    if (cur < n) segs.push(forwardSeg(cur, n - cur, h))
    const out = renderBuf(input, segs)
    if (ctx && typeof ctx.progress === 'function') ctx.progress(1)
    return out
  },
}
