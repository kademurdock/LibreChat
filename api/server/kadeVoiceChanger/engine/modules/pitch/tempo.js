// modules/pitch/tempo.js - pitch.tempo, "Tempo without pitch".
//
// Technique: phase-vocoder time-scale modification with identity phase
// locking (Laroche and Dolson 1999, "Improved phase vocoder time-scale
// modification of audio") and transient zones that keep consonant attacks
// single (Duxbury, Davies and Sandler 2002), through core/pv.js stretch.
// Tempo 2 means twice as fast (half as long); the voice keeps its note and
// its timbre. The output length changes, so the module warps.

import { stretch } from '../../core/pv.js'
import { cleanBuf, usable, rateOf, progress } from './_lib.js'

export default {
  id: 'pitch.tempo',
  name: 'Tempo without pitch',
  family: 'pitch',
  about: 'Talks faster or slower while your voice keeps its own pitch.',
  params: [
    { id: 'tempo', name: 'Tempo', type: 'number', min: 0.25, max: 4, step: 0.01, def: 0.75, unit: 'x', rand: [0.6, 1.6] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: true,
  cost: 4,
  process(input, p, ctx) {
    if (!usable(input)) return input
    cleanBuf(input)
    const sr = rateOf(input)
    const tempo = Math.min(4, Math.max(0.25, Number(p.tempo) || 1))
    if (tempo === 1) return input
    const f = 1 / tempo
    const ch = []
    for (let c = 0; c < input.ch.length; c++) {
      ch.push(stretch(input.ch[c], sr, f))
      progress(ctx, (c + 1) / input.ch.length)
    }
    let len = ch[0].length
    for (let c = 1; c < ch.length; c++) if (ch[c].length < len) len = ch[c].length
    for (let c = 0; c < ch.length; c++) if (ch[c].length !== len) ch[c] = ch[c].slice(0, len)
    return cleanBuf({ sr: input.sr, ch })
  },
}
