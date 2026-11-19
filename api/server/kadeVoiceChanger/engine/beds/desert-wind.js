// beds/desert-wind.js - Desert wind: dry gusts hissing with blown sand.
//
// Technique: the wind engine of beds/wind.js (moving band-passed noise on
// one gust curve; Farnell, "Designing Sound", 2010) with sand saltation:
// grains only start to hop and hiss above a threshold wind speed (Bagnold,
// "The Physics of Blown Sand and Desert Dunes", 1941), so the hiss swells
// sharply in gusts and drops away in lulls. It is made of dense tiny grain
// clicks. Optional singing dunes: now and then a sliding sand face hums low,
// around 70 to 105 Hz with a few harmonics, as booming dunes do (described
// by Bagnold, and measured by Andreotti 2004 and Vriend et al. 2007).

import { finishBed, runBed } from './rain.js'
import { windLayer } from './wind.js'

const bed = {
  id: 'desert-wind',
  name: 'Desert wind',
  group: 'weather',
  about: 'Hot dry wind across open sand, the grains hissing in every gust, with the odd low hum of a singing dune if you like.',
  params: [
    { id: 'strength', name: 'Wind strength', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [30, 90] },
    { id: 'sand', name: 'Blowing sand', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [25, 90] },
    { id: 'gusts', name: 'Gusts', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [25, 85] },
    { id: 'dunes', name: 'Singing dunes', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 60] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const { L, R } = windLayer(n, s.sr, s.rng, {
        strength: q.strength / 100,
        gusts: q.gusts / 100,
        sand: q.sand / 100,
        dunes: q.dunes / 100,
        whistle: 0.06,
        rumble: 0.2,
        rush: 0.85,
      })
      finishBed(L, R, s.sr, -20 + (q.strength - 55) * 0.06)
      return { L, R }
    })
  },
}

export default bed
