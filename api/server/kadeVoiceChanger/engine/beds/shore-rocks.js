// beds/shore-rocks.js - Waves breaking on a rocky shore.
//
// Technique: the wave engine of beds/ocean.js in its rock mode. Instead of a
// long peeling break and a wash up the sand, each wave slams into the rocks:
// a low boom with a sharp attack, a slap, a burst of spray, then the water
// thrown up falls back as hundreds of separate drops and splashes (short
// resonant noise bursts and Minnaert bubbles, Minnaert 1933, with van den
// Doel 2005 damping and chirp) while big low bubbles glug and gurgle in the
// crevices as it drains, over the steady roar of surf along the coast.

import { finishBed, runBed } from './rain.js'
import { oceanLayer } from './ocean.js'

const bed = {
  id: 'shore-rocks',
  name: 'Waves on rocks',
  group: 'water',
  about: 'Sea waves booming against rocks, spray falling back in a shower of drops and water gurgling out of the cracks.',
  params: [
    { id: 'size', name: 'Wave size', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [25, 95] },
    { id: 'period', name: 'Time between waves', type: 'number', min: 4, max: 16, step: 0.5, def: 8, unit: 'seconds', rand: [5, 12] },
    { id: 'spray', name: 'Spray and splashes', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [20, 90] },
    { id: 'distance', name: 'Distance', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [0, 60] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const { L, R } = oceanLayer(n, s.sr, s.rng, {
        size: q.size / 100,
        period: q.period,
        shore: 'rocks',
        spray: q.spray / 100,
        distance: q.distance / 100,
      })
      finishBed(L, R, s.sr, -19.5 + (q.size - 60) * 0.1 - q.distance * 0.04, 3)
      return { L, R }
    })
  },
}

export default bed
