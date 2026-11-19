// beds/cave-drips.js - A dripping cave: drops plinking into pools in the dark, echoing.
//
// Technique: each drip is a drop falling into a pool: a small impact tick
// and then the "plink", a Minnaert bubble (Minnaert 1933) trapped by the
// drop, with van den Doel's damping and a strong upward chirp (van den Doel
// 2005; drip bubbles rise more than stream bubbles, which is the "bloop"),
// sometimes a second smaller bubble and a few splash droplets after it.
// Several drip points each keep their own pitch and their own slow,
// slightly wandering rhythm, as stalactites do, and some drip onto rock
// instead of water. A large dark feedback delay network (Stautner and
// Puckette 1982; Jot and Chaigne 1991), sized by the cave, gives the long
// echoing tail; a far-off stream (the running-water engine of beds/creek.js)
// and a faint low air rumble come from deeper in.

import {
  finishBed, Rand32, Impacts, whiteArr, eq, applyCurve, addInto, smoothCurve, ctrlLen, HOP, clamp, Fdn, runBed,
} from './rain.js'
import { waterLayer } from './creek.js'

const bed = {
  id: 'cave-drips',
  name: 'Dripping cave',
  group: 'water',
  about: 'Deep in a cave: water dripping into pools from several places, each with its own note, echoing in the dark.',
  params: [
    { id: 'drips', name: 'Dripping places', type: 'number', min: 1, max: 10, step: 1, def: 4, unit: 'count', noun: ['place', 'places'], rand: [2, 8] },
    { id: 'speed', name: 'Drip speed', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
    { id: 'size', name: 'Cave size', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [30, 95] },
    { id: 'stream', name: 'Far-off stream', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [0, 60] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const dur = n / rate
      const m = ctrlLen(n)
      const cr = rate / HOP
      const rnd = new Rand32(s.rng.fork('drips'))
      const crnd = new Rand32(s.rng.fork('curves'))
      const L = new Float32Array(n)
      const R = new Float32Array(n)
      const imp = new Impacts(L, R, rate, rnd)
      const base = 3.6 * Math.pow(0.22, q.speed / 100)
      for (let k = 0; k < q.drips; k++) {
        const period = base * crnd.logRange(0.55, 1.8)
        const f0 = crnd.logRange(480, 2300)
        const pan = crnd.bi() * 0.9
        const r = crnd.logRange(1.5, 12)
        const lvl = 0.5 / Math.pow(r, 0.7)
        const rock = crnd.chance(0.2)
        const drift = smoothCurve(m, cr, crnd, 0.05, 2)
        let t = crnd.next() * period
        while (t < dur) {
          const a = lvl * rnd.range(0.7, 1)
          if (rock) {
            imp.burst(t, a * 0.9, pan, rnd.range(1500, 3200), 1.2, 0.0015, 0.5)
            imp.burst(t + 0.0008, a * 0.4, pan, rnd.range(4000, 6000), 1, 0.0006, 0)
          } else {
            imp.burst(t, a * 0.35, pan, rnd.range(3000, 5000), 1, 0.0004, 0.4)
            imp.bubble(t + rnd.range(0.0008, 0.002), a * 0.55, pan, f0 * rnd.range(0.94, 1.06), rnd.range(0.25, 0.45), rnd.range(0.7, 1))
            if (rnd.chance(0.4)) imp.bubble(t + rnd.range(0.006, 0.025), a * 0.2, pan, f0 * rnd.range(1.4, 2.1), rnd.range(0.2, 0.4))
            if (rnd.chance(0.25)) {
              const cnt = 1 + rnd.int(3)
              for (let j = 0; j < cnt; j++) {
                imp.burst(t + rnd.range(0.04, 0.16), a * 0.12, pan + rnd.bi() * 0.1, rnd.range(2500, 6000), 1, 0.0008, 0.2)
              }
            }
          }
          const ci = Math.min(m - 1, Math.floor((t * rate) / HOP))
          t += period * Math.max(0.4, 1 + 0.07 * rnd.gauss() + 0.2 * drift[ci])
        }
      }
      imp.renderBanks()
      // Deep in the cave: a far stream and a low breath of air, mostly heard as echo.
      const stream = q.stream / 100
      if (stream > 0) {
        const far = waterLayer(n, rate, s.rng.fork('stream'), { flow: 0.4, babble: 0.5, spots: 3, swarm: 250, splash: 30, rush: 0.2, trickle: 60, width: 0.6, distance: 0.75 })
        addInto(L, far.L, 0.35 * stream)
        addInto(R, far.R, 0.35 * stream)
      }
      const air = smoothCurve(m, cr, crnd, 0.1, 3)
      for (let i = 0; i < m; i++) air[i] = clamp(1 + 0.4 * air[i], 0.3, 2)
      for (const ch of [L, R]) {
        const w = whiteArr(n, rnd)
        eq(w, rate, [['lowpass', 110, 0.7], ['lowpass', 160, 0.7], ['highpass', 25, 0.7]])
        applyCurve(w, air, 0.05)
        addInto(ch, w)
      }
      const size = q.size / 100
      new Fdn(rate, { size: 1.4 + 2.6 * size, rt60: 1.8 + 5 * size, damp: 0.55, predelayMs: 12 + 30 * size }).process(L, R, 0.7 + 1.1 * size, 1)
      finishBed(L, R, rate, -22, 3)
      return { L, R }
    })
  },
}

export default bed
