// modules/time/palindrome.js - time.palindrome, "There and back": the clip
// (or every phrase, or every word) plays forward and then straight back
// again, like a tape loop rocked to and fro.
//
// Technique: a passage followed by its own time reversal, the forward and
// backward tape loop of musique concrete (Thom Holmes, "Electronic and
// Experimental Music", on tape techniques). For the whole clip the turn happens where the
// speech ends, not after the trailing silence, so there is no dead air in the
// middle. Per phrase or per word the original pauses between them are kept,
// which gives the sing-song "hello olleh" rhythm. With no pause at the turn
// the sound folds back on itself seamlessly, because the reversed copy starts
// on the very sample where the forward copy stopped; joins are raised-cosine
// crossfades (renderSegments in _lib.js).

import { findUnits, mixDown, prepare, renderBuf, forwardSeg, reverseSeg, silenceSeg, msToSamples, dbGain, speechSpan } from './_lib.js'

export default {
  id: 'time.palindrome',
  name: 'There and back',
  family: 'time',
  about: 'Plays forward and then straight back again, for the whole clip, each phrase or each word.',
  params: [
    {
      id: 'unit',
      name: 'What turns around',
      type: 'choice',
      def: 'whole',
      options: [
        { v: 'whole', name: 'The whole clip' },
        { v: 'phrases', name: 'Each phrase' },
        { v: 'words', name: 'Each word' },
      ],
    },
    {
      id: 'order',
      name: 'Order',
      type: 'choice',
      def: 'there',
      options: [
        { v: 'there', name: 'Forward, then backward' },
        { v: 'back', name: 'Backward, then forward' },
      ],
    },
    { id: 'gapMs', name: 'Pause at the turn', type: 'number', min: 0, max: 1000, step: 10, def: 120, unit: 'ms', rand: [0, 300] },
    { id: 'backLevel', name: 'Backward part level', type: 'number', min: -24, max: 0, step: 1, def: 0, unit: 'db', rand: [-9, 0] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: true,
  cost: 1,
  process(input, p, ctx) {
    const n = prepare(input)
    if (!n) return input
    const sr = input.sr
    const h = msToSamples(4, sr, 1)
    const gap = msToSamples(p.gapMs, sr, 0)
    const g = dbGain(p.backLevel)
    const backFirst = p.order === 'back'
    const mono = mixDown(input)
    const segs = []
    const turn = (a, b) => {
      // one there-and-back of source a..b
      if (backFirst) {
        segs.push(reverseSeg(a, b, h, g))
        if (gap > 0) segs.push(silenceSeg(gap, h))
        segs.push(forwardSeg(a, b - a, h))
      } else {
        segs.push(forwardSeg(a, b - a, h))
        if (gap > 0) segs.push(silenceSeg(gap, h))
        segs.push(reverseSeg(a, b, h, g))
      }
    }
    if (p.unit === 'whole') {
      const sp = speechSpan(mono, sr)
      const a = sp.phrases.length ? sp.start : 0
      const b = sp.phrases.length ? sp.end : n
      if (backFirst) {
        // lead-in, the speech backwards, the turn, then everything forward
        if (a > 0) segs.push(forwardSeg(0, a, h))
        segs.push(reverseSeg(a, b, h, g))
        if (gap > 0) segs.push(silenceSeg(gap, h))
        segs.push(forwardSeg(a, n - a, h))
      } else {
        // forward to the end of the speech, the turn, back to the very start,
        // then whatever quiet tail the clip had
        segs.push(forwardSeg(0, b, h))
        if (gap > 0) segs.push(silenceSeg(gap, h))
        segs.push(reverseSeg(0, b, h, g))
        if (b < n) segs.push(forwardSeg(b, n - b, h))
      }
    } else {
      const units = findUnits(mono, sr, p.unit === 'words' ? 'words' : 'phrases')
      if (!units.length) return input
      let cur = 0
      for (let k = 0; k < units.length; k++) {
        const u = units[k]
        if (u.end <= cur) continue
        const a = Math.max(cur, u.start)
        if (a > cur) segs.push(forwardSeg(cur, a - cur, h))
        turn(a, u.end)
        cur = u.end
      }
      if (cur < n) segs.push(forwardSeg(cur, n - cur, h))
    }
    const out = renderBuf(input, segs)
    if (ctx && typeof ctx.progress === 'function') ctx.progress(1)
    return out
  },
}
