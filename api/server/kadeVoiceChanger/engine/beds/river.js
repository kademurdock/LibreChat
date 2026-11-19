// beds/river.js - A river: a broad steady flow, with rapids if you want them.
//
// Technique: the running-water engine of beds/creek.js scaled up, following
// van den Doel 2005 ("Physically based models for liquid sounds"): a river
// is thousands of Minnaert bubbles a second (Minnaert 1933) over a wide
// range of sizes, so individual gurgles merge into a liquid roar, plus a
// broadband flow rush and, for big water, a low rumble of turbulence. Rapids
// add surface splashes and more, bigger gurgling spots. Distance takes the
// highs and the detail first, as it does across a valley.

import {
  finishBed, Rand32, whiteArr, eq, applyCurve, addInto, smoothCurve, ctrlLen, HOP, clamp, runBed,
} from './rain.js'
import { waterLayer } from './creek.js'

const bed = {
  id: 'river',
  name: 'River',
  group: 'water',
  about: 'A wide river flowing past, from a smooth steady current to churning rapids.',
  params: [
    { id: 'flow', name: 'How much water', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [25, 90] },
    { id: 'rapids', name: 'Rapids', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [0, 85] },
    { id: 'distance', name: 'Distance', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [10, 75] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const flow = q.flow / 100
      const rapids = q.rapids / 100
      const { L, R } = waterLayer(n, s.sr, s.rng, {
        flow,
        babble: 0.3 + 0.6 * rapids,
        spots: 3 + Math.round(5 * rapids),
        spotR: [2, 12],
        swarm: 500 + 2000 * flow,
        swarmR: [0.8, 7],
        swarmAmp: 0.02,
        splash: 40 + 320 * rapids * (0.5 + flow),
        rush: 0.6 + 0.9 * flow,
        rushEq: [['highpass', 60, 0.6], ['lowpass', 3800, 0.6], ['peak', 450, 0.7, 3]],
        trickle: 200 + 200 * rapids,
        width: 1,
        xi: [0.08, 0.25],
      })
      // Big water rumbles underneath.
      const rnd = new Rand32(s.rng.fork('rumble'))
      const m = ctrlLen(n)
      const env = smoothCurve(m, s.sr / HOP, rnd, 0.5, 3)
      for (let i = 0; i < m; i++) env[i] = clamp(1 + 0.5 * env[i], 0.3, 2) * (0.03 + 0.09 * flow * flow)
      for (const ch of [L, R]) {
        const w = whiteArr(n, rnd)
        eq(w, s.sr, [['lowpass', 160, 0.7], ['lowpass', 220, 0.7], ['highpass', 30, 0.7]])
        applyCurve(w, env, 1.6)
        addInto(ch, w)
      }
      const dist = q.distance / 100
      if (dist > 0.02) {
        const fc = 14000 * Math.pow(1 - dist, 1.7) + 1400
        for (const ch of [L, R]) eq(ch, s.sr, [['lowpass', fc, 0.6]])
      }
      finishBed(L, R, s.sr, -20.5 + (q.flow - 55) * 0.06 - q.distance * 0.04)
      return { L, R }
    })
  },
}

export default bed
