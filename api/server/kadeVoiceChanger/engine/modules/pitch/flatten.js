// modules/pitch/flatten.js - pitch.flatten, "Monotone".
//
// Technique: pitch-range compression in the log-frequency domain, applied
// cycle by cycle with core/voice.js retuneVoiceBuf (TD-PSOLA re-pitching,
// Moulines and Charpentier 1990), the manipulation Praat offers as "stylize
// pitch" and "shift and compress range" (Boersma and Weenink). For every
// voiced cycle with pitch f0:
//   flat   = log2(note) + keep * (log2(f0) - log2(median))
//   output = 2 ^ ((1 - amount) * log2(f0) + amount * flat)
// where median is the speaker's own middle pitch (from the whole take), note
// is either that same middle pitch or a set pitch in hertz, keep is how much
// intonation survives, and amount is how far the voice is pulled. Amount 100
// and keep 0 give the dead-flat robot or bored drone: every cycle at exactly
// one frequency, so the voice buzzes on a single note.

import { retuneVoiceBuf } from '../../core/voice.js'
import { analyse, cleanBuf, usable, progress } from './_lib.js'

export default {
  id: 'pitch.flatten',
  name: 'Monotone',
  family: 'pitch',
  about: 'Flattens the melody out of your voice, from a bored drone to a dead-flat robot on one note.',
  params: [
    {
      id: 'target',
      name: 'Note',
      type: 'choice',
      def: 'own',
      options: [
        { v: 'own', name: 'Your own middle pitch' },
        { v: 'set', name: 'The set pitch' },
      ],
    },
    { id: 'hz', name: 'Set pitch', type: 'number', min: 50, max: 800, step: 1, def: 110, unit: 'hz', rand: [70, 300] },
    { id: 'amount', name: 'Amount', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [70, 100] },
    { id: 'keep', name: 'Keep intonation', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 40] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    if (!usable(input)) return input
    cleanBuf(input)
    const amount = Math.min(1, Math.max(0, (Number(p.amount) || 0) / 100))
    if (amount === 0) return input
    const keep = Math.min(1, Math.max(0, (Number(p.keep) || 0) / 100))
    const an = analyse(input)
    const med = an.median > 0 ? an.median : 120
    const note = p.target === 'set' ? Math.max(20, Number(p.hz) || 110) : med
    const lMed = Math.log2(med)
    const lNote = Math.log2(note)
    progress(ctx, 0.2)
    const out = retuneVoiceBuf(input, {
      track: an.track,
      targetFn: (t, f0) => {
        const lf = Math.log2(f0)
        const flat = lNote + keep * (lf - lMed)
        return Math.pow(2, (1 - amount) * lf + amount * flat)
      },
    })
    progress(ctx, 1)
    return cleanBuf(out)
  },
}
