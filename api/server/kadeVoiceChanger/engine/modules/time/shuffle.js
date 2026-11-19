// modules/time/shuffle.js - time.shuffle, "Scrambled order": the words,
// syllables or phrases come out in a jumbled order, like a message cut up
// and pasted back together wrong.
//
// Technique: the tape cut-up (the method Brion Gysin and William Burroughs
// took from collage to tape: cut the recording into pieces, rearrange them),
// done on speech units from core/segment.js so every cut lands in a dip
// between sounds. The pauses stay exactly where they were and only the
// sounding middle of each unit moves (within 30 dB of its own peak; the quiet
// padding at phrase edges stays put), so the take keeps its length and, when
// the shuffle stays within each phrase, every phrase keeps its start and end.
// How mixed up it gets is a locally random sort: each unit's sort key is its
// own position plus a random offset whose spread grows with the amount
// (a / (1 - a) times the number of units), so small amounts only swap
// neighbours and the top of the range is a full random order (which is never
// left as the original order). Joins are short raised-cosine crossfades
// (renderSegments in _lib.js), and some pieces can also play backwards.

import { findUnits, unitCore, mixDown, prepare, renderBuf, forwardSeg, reverseSeg, msToSamples } from './_lib.js'
import { findPhrases } from '../../core/segment.js'
import { makeRng } from '../../core/rng.js'

export default {
  id: 'time.shuffle',
  name: 'Scrambled order',
  family: 'time',
  about: 'Your words come out in a jumbled order, like a message cut up and pasted back together wrong.',
  params: [
    {
      id: 'unit',
      name: 'Piece',
      type: 'choice',
      def: 'words',
      options: [
        { v: 'words', name: 'Words' },
        { v: 'syllables', name: 'Syllables' },
        { v: 'phrases', name: 'Whole phrases' },
        { v: 'slices', name: 'Even slices' },
      ],
    },
    { id: 'amount', name: 'How mixed up', type: 'number', min: 0, max: 100, step: 1, def: 70, unit: 'percent', rand: [40, 100] },
    {
      id: 'scope',
      name: 'Mix within',
      type: 'choice',
      def: 'phrase',
      options: [
        { v: 'phrase', name: 'Each phrase' },
        { v: 'whole', name: 'The whole clip' },
      ],
    },
    { id: 'sliceMs', name: 'Slice length, for even slices', type: 'number', min: 40, max: 600, step: 10, def: 200, unit: 'ms', rand: [80, 300] },
    { id: 'reverse', name: 'Some pieces backwards', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 30] },
    { id: 'smooth', name: 'Smoothing', type: 'number', min: 2, max: 40, step: 1, def: 8, unit: 'ms', rand: [5, 14] },
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
    const found = findUnits(mono, sr, p.unit, p.sliceMs)
    if (found.length < 2) return input
    // speech units move only their sounding middle, so the quiet edges of
    // each phrase stay put; even slices move whole
    const units = p.unit === 'slices' ? found : found.map((u) => unitCore(mono, sr, u))
    const rng = ctx && ctx.rng ? ctx.rng : makeRng('time.shuffle')
    const a = Math.max(0, Math.min(1, (Number(p.amount) || 0) / 100))
    const pRev = Math.max(0, Math.min(1, (Number(p.reverse) || 0) / 100))
    const K = units.length
    // groups: one for the whole clip, or one per phrase (units outside every
    // phrase stay where they are)
    const group = new Int32Array(K)
    if (p.scope !== 'whole' && p.unit !== 'phrases') {
      const ph = findPhrases(mono, sr)
      let q = 0
      for (let k = 0; k < K; k++) {
        const c = (units[k].start + units[k].end) / 2
        while (q < ph.length && ph[q].end <= c) q++
        group[k] = q < ph.length && ph[q].start <= c ? q : -1 - k
      }
    }
    const assign = new Int32Array(K)
    for (let k = 0; k < K; k++) assign[k] = k
    if (a > 0) {
      const byGroup = new Map()
      for (let k = 0; k < K; k++) {
        const g = group[k]
        if (!byGroup.has(g)) byGroup.set(g, [])
        byGroup.get(g).push(k)
      }
      for (const idx of byGroup.values()) {
        const m = idx.length
        if (m < 2) continue
        const spread = a >= 0.995 ? 1e9 : (a / (1 - a)) * m
        const keys = idx.map((_, i) => ({ i, key: i + spread * rng.next() }))
        keys.sort((x, y) => x.key - y.key)
        let same = true
        for (let i = 0; i < m; i++) if (keys[i].i !== i) same = false
        if (same && a >= 0.995) keys.push(keys.shift()) // full scramble never stays in order
        for (let i = 0; i < m; i++) assign[idx[i]] = idx[keys[i].i]
      }
    }
    // the edit list: pauses in place, units in their new order
    const h = msToSamples(p.smooth / 2, sr, 1)
    const segs = []
    let cur = 0
    for (let k = 0; k < K; k++) {
      const slot = units[k]
      if (slot.start > cur) segs.push(forwardSeg(cur, slot.start - cur, h))
      const u = units[assign[k]]
      if (pRev > 0 && rng.next() < pRev) segs.push(reverseSeg(u.start, u.end, h))
      else segs.push(forwardSeg(u.start, u.end - u.start, h))
      cur = Math.max(cur, slot.end)
    }
    if (cur < n) segs.push(forwardSeg(cur, n - cur, h))
    const out = renderBuf(input, segs)
    if (ctx && typeof ctx.progress === 'function') ctx.progress(1)
    return out
  },
}
