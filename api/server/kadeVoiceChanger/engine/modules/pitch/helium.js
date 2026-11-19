// modules/pitch/helium.js - pitch.helium, "Gas voices".
//
// Technique: the physics of breathing a light or heavy gas. The vocal folds
// keep vibrating at nearly the same rate, so the note hardly moves, but the
// resonances of the vocal tract scale with the speed of sound in the gas
// (Fant and Lindqvist, "Pressure and gas mixture effects on divers'
// speech", STL-QPSR 1968). The speed of sound goes as the square root of the
// heat-capacity ratio over the molar mass: about 2.9 times air in pure
// helium, 1.86 times in an 80/20 helium and oxygen diving mix, and 0.39
// times in sulfur hexafluoride. A breath from a balloon mixes with the air
// already in the lungs and throat, so the full-amount ratios used here are
// chosen as typical of a real breath rather than of the pure gas: 1.6 for a
// balloon, 1.86 for diving air, and 0.5 for the heavy gas. Amount scales the shift in log frequency (amount 50
// is half the semitones). The formants are moved without moving the pitch
// by core/voice.js shiftVoiceBuf (a resampled formant copy re-pitched back
// with TD-PSOLA, Moulines and Charpentier 1990).

import { shiftVoiceBuf } from '../../core/voice.js'
import { analyse, cleanBuf, usable, progress } from './_lib.js'

const RATIO = { helium: 1.6, heliox: 1.86, heavy: 0.5 }

export default {
  id: 'pitch.helium',
  name: 'Gas voices',
  family: 'pitch',
  about: 'The squeaky helium-balloon voice, or the deep heavy-gas voice: the gas moves your timbre, not your note.',
  params: [
    {
      id: 'gas',
      name: 'Gas',
      type: 'choice',
      def: 'helium',
      options: [
        { v: 'helium', name: 'Helium balloon' },
        { v: 'heliox', name: 'Deep-sea diving air' },
        { v: 'heavy', name: 'Heavy gas' },
      ],
    },
    { id: 'amount', name: 'Amount', type: 'number', min: 0, max: 100, step: 1, def: 85, unit: 'percent', rand: [50, 100] },
    { id: 'pitch', name: 'Pitch nudge', type: 'number', min: -6, max: 6, step: 0.5, def: 0, unit: 'semitones', rand: [-1, 2] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    if (!usable(input)) return input
    cleanBuf(input)
    const amount = Math.min(1, Math.max(0, (Number(p.amount) || 0) / 100))
    const ratio = RATIO[p.gas] || RATIO.helium
    const formant = Math.max(-12, Math.min(12, 12 * Math.log2(ratio) * amount))
    const semis = Number(p.pitch) || 0
    if (Math.abs(formant) < 1e-6 && semis === 0) return input
    const an = analyse(input)
    progress(ctx, 0.2)
    const out = shiftVoiceBuf(input, { semitones: semis, formant, track: an.track })
    progress(ctx, 1)
    return cleanBuf(out)
  },
}
