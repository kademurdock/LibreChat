// modules/time/trim.js - time.trim, "Close the gaps": long pauses are cut
// down to a short breath, so the take moves like a fast talker or a tight
// radio edit.
//
// Technique: silence removal by endpoint detection, the classic two-threshold
// energy detector of Rabiner and Sambur, "An Algorithm for Determining the
// Endpoints of Isolated Utterances" (Bell System Technical Journal 1975), as
// core/segment.js findPhrases runs it relative to the clip's own levels.
// Every pause the detector finds that is longer than the setting is shortened
// to the length asked for: the first half of what is kept comes from the
// start of the pause and the second half from its end, so each phrase keeps
// its own natural decay and its soft onset, and the cut itself is a
// raised-cosine crossfade inside near-silence (renderSegments in _lib.js),
// which hides it completely. The detector pads each phrase a little (30 ms
// before, 60 ms after), so even "keep nothing" leaves about 90 ms between
// phrases and never clips a word.

import { mixDown, prepare, renderBuf, forwardSeg, msToSamples } from './_lib.js'
import { findPhrases } from '../../core/segment.js'
import { fade } from '../../core/buf.js'

export default {
  id: 'time.trim',
  name: 'Close the gaps',
  family: 'time',
  about: 'Cuts long pauses down to a short breath, so you sound like a fast talker or a tight radio edit.',
  params: [
    { id: 'longerThan', name: 'Shorten pauses longer than', type: 'number', min: 80, max: 2000, step: 10, def: 250, unit: 'ms', rand: [150, 500] },
    { id: 'keepMs', name: 'Pause left behind', type: 'number', min: 0, max: 1000, step: 10, def: 80, unit: 'ms', rand: [20, 200] },
    { id: 'ends', name: 'Trim the start and end too', type: 'bool', def: true },
    { id: 'smooth', name: 'Smoothing', type: 'number', min: 2, max: 60, step: 1, def: 12, unit: 'ms', rand: [6, 20] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: true,
  surprise: false,
  cost: 1,
  process(input, p, ctx) {
    const n = prepare(input)
    if (!n) return input
    const sr = input.sr
    const ph = findPhrases(mixDown(input), sr, { minSilenceMs: p.longerThan })
    if (!ph.length) return input
    const keep = msToSamples(p.keepMs, sr, 0)
    const keepA = keep >> 1
    const keepB = keep - keepA
    const h = msToSamples(p.smooth / 2, sr, 1)
    // kept stretches of the input, in order
    const kept = []
    let start = p.ends ? ph[0].start - Math.min(ph[0].start, keepB) : 0
    for (let k = 0; k < ph.length; k++) {
      if (k < ph.length - 1) {
        const a = ph[k].end
        const b = ph[k + 1].start
        if (b - a > keep + 2 * h) {
          kept.push([start, a + keepA])
          start = b - keepB
        }
      } else {
        const end = p.ends ? ph[k].end + Math.min(n - ph[k].end, keepA) : n
        kept.push([start, end])
      }
    }
    const segs = []
    for (let k = 0; k < kept.length; k++) {
      const [a, b] = kept[k]
      if (b > a) segs.push(forwardSeg(a, b - a, h))
    }
    if (!segs.length) return input
    const out = renderBuf(input, segs)
    // the new first and last samples sit inside room tone; ease them in and out
    if (p.ends) fade(out, Math.min(0.004, out.ch[0].length / sr / 4), Math.min(0.004, out.ch[0].length / sr / 4))
    if (ctx && typeof ctx.progress === 'function') ctx.progress(1)
    return out
  },
}
