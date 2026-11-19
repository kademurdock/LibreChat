// modules/pitch/glide.js - pitch.glide, "Rising or falling".
//
// Technique: a pitch offset that travels from one value to another over the
// whole clip, applied with core/voice.js shiftVoiceBuf (TD-PSOLA, Moulines
// and Charpentier 1990) as a function of time. The curve choices are the
// usual automation shapes of a mixing desk: straight (linear in semitones,
// which the ear hears as an even glide), smooth (raised cosine, slow at both
// ends), early (most of the change at the start, an exponential approach)
// and late (most of the change at the end). Timbre follow moves the formants
// part of the way with the pitch, so a fall can also make the speaker grow.

import { shiftVoiceBuf } from '../../core/voice.js'
import { analyse, cleanBuf, usable, ControlCurve, progress } from './_lib.js'

function shapeOf(name, x) {
  const u = x < 0 ? 0 : x > 1 ? 1 : x
  switch (name) {
    case 'smooth':
      return 0.5 - 0.5 * Math.cos(Math.PI * u)
    case 'early':
      return (1 - Math.exp(-4 * u)) / (1 - Math.exp(-4))
    case 'late':
      return (Math.exp(4 * u) - 1) / (Math.exp(4) - 1)
    default:
      return u
  }
}

export default {
  id: 'pitch.glide',
  name: 'Rising or falling',
  family: 'pitch',
  about: 'Your voice slides from one pitch to another across the whole clip, rising or sinking as you talk.',
  params: [
    { id: 'from', name: 'Start pitch', type: 'number', min: -24, max: 24, step: 0.5, def: 0, unit: 'semitones', rand: [-6, 6] },
    { id: 'to', name: 'End pitch', type: 'number', min: -24, max: 24, step: 0.5, def: -8, unit: 'semitones', rand: [-12, 12] },
    {
      id: 'curve',
      name: 'Curve',
      type: 'choice',
      def: 'smooth',
      options: [
        { v: 'straight', name: 'Straight' },
        { v: 'smooth', name: 'Smooth' },
        { v: 'early', name: 'Fast at first' },
        { v: 'late', name: 'Fast at the end' },
      ],
    },
    { id: 'timbre', name: 'Timbre follows', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 60] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    if (!usable(input)) return input
    cleanBuf(input)
    const a = Number(p.from) || 0
    const b = Number(p.to) || 0
    const tf = Math.min(1, Math.max(0, (Number(p.timbre) || 0) / 100))
    if (a === 0 && b === 0) return input
    const an = analyse(input)
    const secs = input.ch[0].length / an.sr
    const dur = secs > 1e-6 ? secs : 1e-6
    const curve = new ControlCurve(secs + 0.5, 500).fill((t) => a + (b - a) * shapeOf(p.curve, t / dur))
    progress(ctx, 0.2)
    const opts = { semitones: curve.fn(), track: an.track }
    // the formant curve is capped at a third of an octave either way, past
    // which a sliding timbre stops sounding like the same speaker
    if (tf > 0) opts.formant = (t) => Math.max(-4, Math.min(4, tf * curve.at(t)))
    const out = shiftVoiceBuf(input, opts)
    progress(ctx, 1)
    return cleanBuf(out)
  },
}
