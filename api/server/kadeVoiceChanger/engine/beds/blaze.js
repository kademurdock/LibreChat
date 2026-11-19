// beds/blaze.js - A roaring blaze: a big fire that roars, flares and crackles hard.
//
// Technique: the fire engine of beds/campfire.js (Farnell's lapping, hissing
// and crackling, "Designing Sound", 2010, with clustered after-crackles,
// pops and log collapses) at full size, with several burning spots spread
// across the stereo field, each crackling on its own, a loud flickering roar
// (low-passed noise opened up as the fire grows) and frequent whooshing
// flare-ups when the wind feeds it. Distance takes the crackle's sparkle
// first and leaves the roar.

import { finishBed, eq, runBed } from './rain.js'
import { fireLayer } from './campfire.js'

const bed = {
  id: 'blaze',
  name: 'Roaring blaze',
  group: 'fire',
  about: 'A big bonfire roaring and flaring, crackling loudly all across, timbers collapsing into it.',
  params: [
    { id: 'size', name: 'Size of the fire', type: 'number', min: 0, max: 100, step: 1, def: 75, unit: 'percent', rand: [45, 100] },
    { id: 'crackle', name: 'Crackle', type: 'number', min: 0, max: 100, step: 1, def: 65, unit: 'percent', rand: [30, 95] },
    { id: 'flare', name: 'Flare-ups', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [15, 85] },
    { id: 'distance', name: 'Distance', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 65] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const dist = q.distance / 100
      const { L, R } = fireLayer(n, rate, s.rng, {
        size: q.size / 100,
        crackle: q.crackle / 100,
        pops: 0.55,
        logs: 0.45,
        roar: 0.75,
        hiss: 0.5,
        flare: q.flare / 100,
        width: 0.9,
        sources: 3,
      })
      if (dist > 0.02) {
        const fc = 15000 * Math.pow(1 - dist, 1.8) + 1500
        for (const ch of [L, R]) eq(ch, rate, [['lowpass', fc, 0.6]])
      }
      finishBed(L, R, rate, -20 + (q.size - 75) * 0.06 - q.distance * 0.04, 3)
      return { L, R }
    })
  },
}

export default bed
