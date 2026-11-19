// modules/pitch/octaver.js - pitch.octaver, "Octave stack".
//
// Technique: the octave divider of guitar and organ effects (the analogue
// flip-flop divider, and its digital pitch-shifting successors), done here
// with core/voice.js shiftVoiceBuf (TD-PSOLA, Moulines and Charpentier 1990)
// so each octave is a real, cleanly re-pitched voice that keeps the
// speaker's words. PSOLA lays every grain on the original pitch marks, so
// the octaves stay time-aligned with the dry voice and mixing them does not
// comb or flange the way a delayed copy would: they fuse into one huge sound,
// the chanting monk, the giant chorus, the dark double. Timbre follows lets the octaves also move their
// formants part of the way (half of an octave's worth at most), so the low
// voices sound like bigger bodies as well as lower notes.

import { shiftVoiceBuf } from '../../core/voice.js'
import { analyse, cleanBuf, usable, progress } from './_lib.js'

export default {
  id: 'pitch.octaver',
  name: 'Octave stack',
  family: 'pitch',
  about: 'Adds your voice an octave or two below and an octave above: monk chant, giant chorus.',
  params: [
    { id: 'down1', name: 'One octave down', type: 'number', min: 0, max: 100, step: 1, def: 70, unit: 'percent', rand: [30, 90] },
    { id: 'down2', name: 'Two octaves down', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 60] },
    { id: 'up1', name: 'One octave up', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 50] },
    { id: 'dry', name: 'Your own voice', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [60, 100] },
    { id: 'timbre', name: 'Timbre follows', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 60] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 4,
  process(input, p, ctx) {
    if (!usable(input)) return input
    cleanBuf(input)
    const lv = [
      [-12, Math.max(0, Number(p.down1) || 0) / 100],
      [-24, Math.max(0, Number(p.down2) || 0) / 100],
      [12, Math.max(0, Number(p.up1) || 0) / 100],
    ]
    const dry = Math.max(0, Number(p.dry) || 0) / 100
    const tf = Math.min(1, Math.max(0, (Number(p.timbre) || 0) / 100))
    const n = input.ch[0].length
    const out = input.ch.map((s) => {
      const o = new Float32Array(n)
      if (dry > 0) for (let i = 0; i < n; i++) o[i] = dry * s[i]
      return o
    })
    const active = lv.filter((x) => x[1] > 0)
    if (active.length) {
      const an = analyse(input)
      let done = 0
      for (const [semis, g] of active) {
        const formant = Math.max(-6, Math.min(6, 0.5 * tf * semis))
        // octaves below spread their grains apart and sound thinner; a small
        // lift keeps a 100 percent octave about as loud as the voice
        const gain = g * (semis < 0 ? 1.1 : 0.85)
        const y = shiftVoiceBuf(input, { semitones: semis, formant, track: an.track })
        for (let c = 0; c < out.length; c++) {
          const o = out[c]
          const s = y.ch[c]
          for (let i = 0; i < n; i++) o[i] += gain * s[i]
        }
        done++
        progress(ctx, done / active.length)
      }
    }
    return cleanBuf({ sr: input.sr, ch: out })
  },
}
