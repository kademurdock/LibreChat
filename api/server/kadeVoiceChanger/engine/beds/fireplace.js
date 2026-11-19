// beds/fireplace.js - A fire in the hearth, indoors: cosy crackle in a quiet room.
//
// Technique: the fire engine of beds/campfire.js (Farnell's lapping, hissing
// and crackling, "Designing Sound", 2010, with clustered after-crackles,
// sap pops and log shifts) made smaller and softer, its logs settling on a
// metal grate (two short metallic modes join the wooden thud), plus the
// low steady draw of the chimney, and the room around it as a small feedback
// delay network (Jot and Chaigne 1991). The room also takes a little of the
// top end, as soft furnishings do.

import {
  finishBed, Fdn, Rand32, whiteArr, eq, applyCurve, addInto, smoothCurve, ctrlLen, HOP, clamp, runBed,
} from './rain.js'
import { fireLayer } from './campfire.js'

const bed = {
  id: 'fireplace',
  name: 'Fireplace',
  group: 'fire',
  about: 'A log fire in the hearth of a quiet room, crackling gently, the chimney drawing, logs shifting on the grate.',
  params: [
    { id: 'size', name: 'Size of the fire', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [20, 80] },
    { id: 'crackle', name: 'Crackle', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [25, 90] },
    { id: 'logs', name: 'Logs settling', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [0, 75] },
    { id: 'room', name: 'Room sound', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 75] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const size = q.size / 100
      const { L, R } = fireLayer(n, rate, s.rng, {
        size: size * 0.85,
        crackle: q.crackle / 100,
        pops: 0.3,
        logs: q.logs / 100,
        roar: 0.25,
        hiss: 0.3,
        flare: 0.2,
        width: 0.35,
        grate: true,
      })
      // The chimney draws: a low, slowly breathing rumble.
      const rnd = new Rand32(s.rng.fork('chimney'))
      const m = ctrlLen(n)
      const env = smoothCurve(m, rate / HOP, rnd, 0.2, 3)
      for (let i = 0; i < m; i++) env[i] = clamp(1 + 0.4 * env[i], 0.3, 2) * (0.02 + 0.03 * size)
      for (const ch of [L, R]) {
        const w = whiteArr(n, rnd)
        eq(w, rate, [['lowpass', 90, 0.7], ['lowpass', 140, 0.7], ['highpass', 30, 0.7]])
        applyCurve(w, env, 1)
        addInto(ch, w)
        eq(ch, rate, [['highshelf', 7000, 0.7, -4]])
      }
      const room = q.room / 100
      if (room > 0) new Fdn(rate, { size: 0.5, rt60: 0.6, damp: 0.55, predelayMs: 5 }).process(L, R, 0.45 * room, 1)
      finishBed(L, R, rate, -21.5 + (q.size - 45) * 0.06, 3.5)
      return { L, R }
    })
  },
}

export default bed
