// modules/pitch/speed.js - pitch.speed, "Tape speed".
//
// Technique: the oldest voice trick of all, playing a recording faster or
// slower, so pitch, timbre and tempo all move together (the sped-up tape
// chipmunk, the slowed-down drawl). A steady speed is a plain sample-rate
// change with a windowed-sinc resampler (core/resample.js resample, after
// Smith, "Digital Audio Resampling Home Page", the bandlimited interpolation
// method); with motor wobble on, a moving read head (core/resample.js
// varispeed) follows the speed times a slow "wow" (smooth random near 0.7 Hz)
// and a faint "flutter" near 7 Hz, the two speed faults of a tape transport
// as described in the IEC 60386 measurement standard.
// The output is shorter or longer than the input, so the module warps.

import { resample, varispeed } from '../../core/resample.js'
import { cleanBuf, usable, rateOf, rngOf, smoothRandom, progress } from './_lib.js'

export default {
  id: 'pitch.speed',
  name: 'Tape speed',
  family: 'pitch',
  about: 'Plays your voice faster or slower like a tape, so pitch and speed change together.',
  params: [
    { id: 'speed', name: 'Speed', type: 'number', min: 0.25, max: 4, step: 0.01, def: 1.5, unit: 'x', rand: [0.6, 1.8] },
    { id: 'wobble', name: 'Motor wobble', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 40] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: true,
  cost: 1,
  process(input, p, ctx) {
    if (!usable(input)) return input
    cleanBuf(input)
    const sr = rateOf(input)
    const speed = Math.min(4, Math.max(0.25, Number(p.speed) || 1))
    const wob = Math.min(1, Math.max(0, (Number(p.wobble) || 0) / 100))
    const n = input.ch[0].length
    if (wob === 0) {
      if (speed === 1) return input
      const ch = input.ch.map((s) => resample(s, 1 / speed))
      progress(ctx, 1)
      return cleanBuf({ sr: input.sr, ch })
    }
    // wow: up to 4 percent of speed, flutter: up to 0.6 percent
    const secs = n / sr / speed * 1.2 + 1
    const rng = rngOf(ctx, 'wobble')
    const wow = smoothRandom(secs, 0.7, rng)
    const fl = smoothRandom(secs, 7, rng)
    const rate = (t) => speed * (1 + wob * (0.04 * wow.at(t) + 0.006 * fl.at(t)))
    const ch = input.ch.map((s) => varispeed(s, rate, sr, { stopFade: 0 }))
    // channels may end a sample apart; make them equal
    let len = ch[0].length
    for (let c = 1; c < ch.length; c++) if (ch[c].length < len) len = ch[c].length
    for (let c = 0; c < ch.length; c++) if (ch[c].length !== len) ch[c] = ch[c].slice(0, len)
    progress(ctx, 1)
    return cleanBuf({ sr: input.sr, ch })
  },
}
