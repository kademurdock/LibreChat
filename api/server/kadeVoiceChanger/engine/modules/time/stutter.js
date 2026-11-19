// modules/time/stutter.js - time.stutter, "Stutter": the start of a word is
// caught and fired off again and again before the word goes on, the
// "b-b-b-but" of a stutter edit or a sampler retrigger.
//
// Technique: retrigger editing, the producer's stutter edit (cut the first
// slice of a word, paste copies in front of it, gate each copy and smooth
// every edge), in the form Nick Collins formalised for automatic breakbeat
// cutting ("Algorithmic composition methods for breakbeat science", 2001,
// and his BBCut library: repeats, rolls whose pieces shrink, and per-repeat
// pitch and amplitude changes). Pieces start where core/segment.js finds a
// word or phrase
// beginning, so a repeat begins on a consonant instead of mid-vowel. Every
// piece fades in and out over about 3 ms with raised-cosine crossfades
// (renderSegments in _lib.js), short enough to keep the attack crisp and
// long enough that no edge clicks. Optional extras from modern production:
// a gap after each copy (the gated, rhythmic stutter), pieces that shrink or
// grow (a roll that speeds up or slows down), a pitch step per copy that
// climbs or falls into the real word (tape-style, reading the piece faster
// or slower through a low-passed copy so nothing aliases), and a volume
// change per copy. The word itself always arrives at full level and normal
// pitch. Copies are inserted, so the take gets longer.

import { findUnits, mixDown, prepare, renderBuf, forwardSeg, silenceSeg, msToSamples, dbGain } from './_lib.js'
import { findPhrases } from '../../core/segment.js'
import { makeRng } from '../../core/rng.js'

const SHRINK = 0.72

export default {
  id: 'time.stutter',
  name: 'Stutter',
  family: 'time',
  about: 'Fires off the start of a word again and again before the word goes on, like a stutter edit in a dance track.',
  params: [
    {
      id: 'where',
      name: 'Where',
      type: 'choice',
      def: 'words',
      options: [
        { v: 'words', name: 'Word starts' },
        { v: 'phrases', name: 'Phrase starts' },
        { v: 'random', name: 'Random places' },
        { v: 'everywhere', name: 'Everywhere' },
      ],
    },
    { id: 'repeats', name: 'Repeats', type: 'number', min: 1, max: 12, step: 1, def: 3, unit: 'count', noun: ['repeat', 'repeats'], rand: [2, 5] },
    { id: 'pieceMs', name: 'Piece length', type: 'number', min: 20, max: 400, step: 5, def: 90, unit: 'ms', rand: [50, 160] },
    { id: 'chance', name: 'How often', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [25, 70] },
    {
      id: 'roll',
      name: 'Rhythm',
      type: 'choice',
      def: 'even',
      options: [
        { v: 'even', name: 'Even' },
        { v: 'faster', name: 'Speeding up' },
        { v: 'slower', name: 'Slowing down' },
      ],
    },
    { id: 'pitchStep', name: 'Pitch step per repeat', type: 'number', min: -3, max: 3, step: 0.5, def: 0, unit: 'semitones', rand: [-1, 1] },
    { id: 'level', name: 'Volume change per repeat', type: 'number', min: -12, max: 6, step: 0.5, def: 0, unit: 'db', rand: [-4, 2] },
    { id: 'gate', name: 'Gap between repeats', type: 'number', min: 0, max: 80, step: 1, def: 20, unit: 'percent', rand: [0, 40] },
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
    const rng = ctx && ctx.rng ? ctx.rng : makeRng('time.stutter')
    const L = msToSamples(p.pieceMs, sr, 16)
    const R = Math.max(1, Math.round(Number(p.repeats) || 1))
    const chance = Math.max(0, Math.min(1, (Number(p.chance) || 0) / 100))
    if (chance <= 0) return input
    // candidate start points
    const cands = []
    if (p.where === 'words' || p.where === 'phrases') {
      const units = findUnits(mono, sr, p.where === 'words' ? 'words' : 'phrases')
      for (let k = 0; k < units.length; k++) cands.push(units[k].start)
    } else {
      const ph = findPhrases(mono, sr)
      const mean = 0.45 * sr
      for (let k = 0; k < ph.length; k++) {
        const a = ph[k].start
        const b = ph[k].end - L
        if (p.where === 'everywhere') {
          for (let t = a; t <= b; t += L) cands.push(t)
        } else {
          let t = a + Math.round(-Math.log(1 - rng.next()) * mean * 0.5)
          while (t <= b) {
            cands.push(t)
            t += L + Math.round(-Math.log(1 - rng.next()) * mean)
          }
        }
      }
    }
    if (!cands.length) return input
    // which candidates fire (at least one, so the effect is always heard)
    const fire = []
    let lastEnd = -1
    for (let k = 0; k < cands.length; k++) {
      const s = cands[k]
      if (s < lastEnd || s >= n - 8) continue
      if (rng.next() < chance) {
        fire.push(s)
        lastEnd = s + L
      }
    }
    if (!fire.length) fire.push(cands[rng.int(cands.length)])
    // the edit list
    const h = msToSamples(1.5, sr, 1)
    const gateF = Math.max(0, Math.min(0.8, (Number(p.gate) || 0) / 100))
    const step = Number(p.pitchStep) || 0
    const x = Number(p.level) || 0
    const lens = []
    let evLen = 0
    for (let r = 0; r < R; r++) {
      let Lr = L
      if (p.roll === 'faster') Lr = L * Math.pow(SHRINK, r)
      else if (p.roll === 'slower') Lr = L * Math.pow(SHRINK, R - 1 - r)
      Lr = Math.max(msToSamples(12, sr, 8), Math.round(Lr))
      lens.push(Lr)
      evLen += Lr
    }
    // never grow the take past three times its length (or 10 s), so extreme
    // settings stay within a phone's memory
    const budget = Math.max(10 * sr, 3 * n)
    const segs = []
    let cur = 0
    let added = 0
    for (let e = 0; e < fire.length; e++) {
      if (e > 0 && added + evLen > budget) break
      added += evLen
      const s = Math.min(n - 1, Math.max(0, fire[e]))
      if (s > cur) segs.push(forwardSeg(cur, s - cur, h))
      for (let r = 0; r < R; r++) {
        const Lr = lens[r]
        let semis = -step * (R - r)
        if (semis > 24) semis = 24
        if (semis < -24) semis = -24
        const rate = Math.pow(2, semis / 12)
        const db = x < 0 ? x * r : -x * (R - r)
        const sound = Math.max(4, Math.round(Lr * (1 - gateF)))
        const gap = Lr - sound
        segs.push({ kind: 'src', src: s, len: sound, dir: 1, rate, gain: dbGain(Math.max(-60, db)), xf: h })
        if (gap > 0) segs.push(silenceSeg(gap, h))
      }
      cur = s
    }
    if (cur < n) segs.push(forwardSeg(cur, n - cur, h))
    const out = renderBuf(input, segs)
    if (ctx && typeof ctx.progress === 'function') ctx.progress(1)
    return out
  },
}
