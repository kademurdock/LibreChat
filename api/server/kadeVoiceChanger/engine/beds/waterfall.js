// beds/waterfall.js - A waterfall: a deep, steady roar with spray.
//
// Technique: a waterfall is the limit of running water where bubbles and
// splashes are so dense they fuse into noise (van den Doel 2005, "Physically
// based models for liquid sounds"), so the body is broadband noise shaped
// like recorded falls (strong low mids, a broad presence lift), surging
// slowly and churning fast; underneath, a low thunder of water hitting the
// pool, its loudness flickering with turbulence (Farnell, "Designing
// Sound", 2010, on turbulent water); on top, the hiss of spray. The
// running-water engine of beds/creek.js adds a dense swarm of Minnaert
// bubbles and droplet splashes close by, so it stays liquid, not just hiss.

import {
  finishBed, Rand32, whiteArr, eq, applyCurve, addInto, smoothCurve, ctrlLen, HOP, clamp, correlate, runBed,
} from './rain.js'
import { waterLayer } from './creek.js'

const bed = {
  id: 'waterfall',
  name: 'Waterfall',
  group: 'water',
  about: 'The roar of a waterfall pouring into its pool, with drifting spray, from a small cascade to huge falls.',
  params: [
    { id: 'size', name: 'Size of the falls', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [25, 95] },
    { id: 'spray', name: 'Spray', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 85] },
    { id: 'distance', name: 'Distance', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [10, 75] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const size = q.size / 100
      const spray = q.spray / 100
      const dist = q.distance / 100
      const rnd = new Rand32(s.rng.fork('falls'))
      const m = ctrlLen(n)
      const cr = rate / HOP
      const near = waterLayer(n, rate, s.rng, {
        flow: 1,
        babble: 0.35,
        spots: 3,
        spotR: [2, 9],
        swarm: 1200 + 1200 * size,
        swarmR: [0.6, 5],
        swarmAmp: 0.015,
        splash: 120 + 400 * spray,
        rush: 0,
        trickle: 300 + 300 * spray,
        width: 1,
      })
      const L = near.L
      const R = near.R
      const detail = (1 - 0.75 * dist) * 0.8
      for (let i = 0; i < n; i++) {
        L[i] *= detail
        R[i] *= detail
      }
      const top = 3500 + 5000 * size
      for (let c = 0; c < 2; c++) {
        const ch = c === 0 ? L : R
        const surge = smoothCurve(m, cr, rnd, 0.12, 3)
        const churn = smoothCurve(m, cr, rnd, 3, 3)
        const env = new Float32Array(m)
        // The roar.
        for (let i = 0; i < m; i++) env[i] = clamp(1 + 0.22 * surge[i] + 0.12 * churn[i], 0.4, 1.8)
        let w = whiteArr(n, rnd)
        eq(w, rate, [['highpass', 45, 0.7], ['lowpass', top, 0.6], ['peak', 320, 0.7, 4 + 3 * size], ['peak', 2400, 0.8, 2]])
        applyCurve(w, env, 0.14)
        addInto(ch, w)
        // Low thunder of the water hitting the pool.
        for (let i = 0; i < m; i++) env[i] = clamp(1 + 0.6 * churn[i] + 0.3 * surge[i], 0.2, 2.5) * (0.04 + 0.16 * size * size)
        w = whiteArr(n, rnd)
        eq(w, rate, [['lowpass', 140, 0.7], ['lowpass', 200, 0.7], ['highpass', 28, 0.7]])
        applyCurve(w, env, 2.2)
        addInto(ch, w)
        // Spray hiss, flickering.
        const flick = smoothCurve(m, cr, rnd, 9, 2)
        for (let i = 0; i < m; i++) env[i] = clamp(1 + 0.45 * flick[i] + 0.2 * surge[i], 0.2, 2) * spray * (1 - 0.8 * dist)
        w = whiteArr(n, rnd)
        eq(w, rate, [['highpass', 3200, 0.6], ['lowpass', 13000, 0.6]])
        applyCurve(w, env, 0.06)
        addInto(ch, w)
      }
      correlate(L, R, 0.3)
      if (dist > 0.02) {
        const fc = 14000 * Math.pow(1 - dist, 1.7) + 1300
        for (const ch of [L, R]) eq(ch, rate, [['lowpass', fc, 0.6]])
      }
      finishBed(L, R, rate, -19.5 + (q.size - 60) * 0.06 - q.distance * 0.04)
      return { L, R }
    })
  },
}

export default bed
