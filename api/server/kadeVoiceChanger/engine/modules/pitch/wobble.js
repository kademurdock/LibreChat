// modules/pitch/wobble.js - pitch.wobble, "Warble and drift".
//
// Technique: a slowly wandering pitch offset applied with core/voice.js
// shiftVoiceBuf (TD-PSOLA, Moulines and Charpentier 1990), a function of
// time in semitones. The offset blends a regular sine (the steady warble of
// a worn tape or a wobbly toy) with slewed random motion (the drunk, nervous
// or seasick drift: three smooth random layers an octave apart, a 1/f-like
// mix in the manner of Voss and Clarke's 1/f music experiments, 1978), set by
// Randomness. Timbre follow moves the formants by the same offset, which
// turns the effect from a wavering singer into a warped tape, where
// everything slides together.

import { shiftVoiceBuf } from '../../core/voice.js'
import { analyse, cleanBuf, usable, rngOf, ControlCurve, smoothRandom, progress } from './_lib.js'

export default {
  id: 'pitch.wobble',
  name: 'Warble and drift',
  family: 'pitch',
  about: 'Your pitch wanders and wobbles: drunk, seasick, nervous or a warped tape.',
  params: [
    { id: 'depth', name: 'Depth', type: 'number', min: 0, max: 400, step: 1, def: 80, unit: 'cents', rand: [30, 200] },
    { id: 'speed', name: 'Speed', type: 'number', min: 0.1, max: 8, step: 0.1, def: 1.5, unit: 'hz', rand: [0.4, 4] },
    { id: 'randomness', name: 'Randomness', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent' },
    { id: 'timbre', name: 'Timbre follows', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    if (!usable(input)) return input
    cleanBuf(input)
    const depth = Number(p.depth) || 0
    if (depth === 0) return input
    const an = analyse(input)
    const sr = an.sr
    const secs = input.ch[0].length / sr
    const speed = Math.max(0.05, Number(p.speed) || 1)
    const rnd = Math.min(1, Math.max(0, (Number(p.randomness) || 0) / 100))
    const tf = Math.min(1, Math.max(0, (Number(p.timbre) || 0) / 100))
    const rng = rngOf(ctx, 'wobble')
    const r1 = smoothRandom(secs + 1, speed, rng.fork('a'))
    const r2 = smoothRandom(secs + 1, speed * 2, rng.fork('b'))
    const r3 = smoothRandom(secs + 1, speed * 0.5, rng.fork('c'))
    const ph = rng.next()
    const semis = depth / 100
    const curve = new ControlCurve(secs + 0.5, 1000).fill((t) => {
      const reg = Math.sin(2 * Math.PI * (speed * t + ph))
      // the three random layers, weighted 1, 1/2, 1, peak about 1
      const ran = (r1.at(t) + 0.5 * r2.at(t) + r3.at(t)) / 1.6
      return semis * ((1 - rnd) * reg + rnd * ran)
    })
    progress(ctx, 0.2)
    const fn = curve.fn()
    const opts = { semitones: fn, track: an.track }
    if (tf > 0) opts.formant = (t) => tf * curve.at(t)
    const out = shiftVoiceBuf(input, opts)
    progress(ctx, 1)
    return cleanBuf(out)
  },
}
