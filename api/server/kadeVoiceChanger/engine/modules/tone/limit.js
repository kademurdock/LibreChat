// modules/tone/limit.js - tone.limit, "Limiter".
//
// Technique: a lookahead brick-wall peak limiter (core/dyn.js limitBuf): the
// gain needed to keep every sample under the ceiling is found a few
// milliseconds ahead of the sound, held over the lookahead window with a
// moving minimum, released with a one-pole, and smoothed with two moving
// averages, so the gain is already down when a peak arrives and comes back
// without a click (the design in Giannoulis, Massberg and Reiss, "Digital
// dynamic range compressor design: a tutorial and analysis", JAES 2012,
// taken to an infinite ratio). The channels of a stereo take share one gain,
// so the picture does not shift when one side peaks. With "Catch peaks
// between samples" on, the level is read on a 4 times oversampled copy, so
// the peaks a player rebuilds between the samples stay under the ceiling too.
//
// Push is plain gain in front of the limiter. At 0 the limiter only catches
// what was already over the ceiling; pushing 6 to 12 decibels into it is how
// a vocal or a whole song is made louder and denser without clipping.
//
// Offline only: the limiter reads ahead of the sound.

import { bufLen } from '../../core/buf.js'
import { limitBuf } from '../../core/dyn.js'

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

export default {
  id: 'tone.limit',
  name: 'Limiter',
  family: 'tone',
  about: 'Stops the loudest moments at a ceiling so nothing clips. Push the sound into it to make everything louder and denser.',
  params: [
    { id: 'push', name: 'Push into the limiter', type: 'number', min: 0, max: 24, step: 0.5, def: 0, unit: 'db' },
    { id: 'ceiling', name: 'Peak ceiling', type: 'number', min: -12, max: 0, step: 0.1, def: -1, unit: 'db' },
    { id: 'release', name: 'Release', type: 'number', min: 10, max: 1000, step: 1, def: 80, unit: 'ms' },
    { id: 'lookahead', name: 'Look ahead', type: 'number', min: 0.5, max: 10, step: 0.5, def: 5, unit: 'ms' },
    { id: 'truePeak', name: 'Catch peaks between samples', type: 'bool', def: true },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 1,
  surprise: false,
  process(input, p) {
    const n = bufLen(input)
    if (!n) return input
    const push = clamp(num(p && p.push, 0), 0, 24)
    if (push > 0) {
      const g = Math.pow(10, push / 20)
      for (let c = 0; c < input.ch.length; c++) {
        const a = input.ch[c]
        for (let i = 0; i < a.length; i++) {
          const v = a[i]
          a[i] = v > -1e9 && v < 1e9 ? v * g : 0
        }
      }
    }
    limitBuf(input, {
      ceilingDb: clamp(num(p && p.ceiling, -1), -12, 0),
      lookaheadMs: clamp(num(p && p.lookahead, 5), 0.5, 10),
      releaseMs: clamp(num(p && p.release, 80), 10, 1000),
      truePeak: !(p && p.truePeak === false),
    })
    return input
  },
}
