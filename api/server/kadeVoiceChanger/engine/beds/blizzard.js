// beds/blizzard.js - Blizzard: hard freezing wind full of driven snow.
//
// Technique: the wind engine of beds/wind.js run strong and gusty (moving
// band-passed noise on one gust curve; Farnell, "Designing Sound", 2010),
// with a deep buffeting rumble, a cold howl (two cascaded high-Q bandpasses
// whose pitch follows the gusts; Zavalishin 2012 filters) and blowing snow:
// a fine high hiss plus dense tiny ice ticks whose density rises with the
// wind speed. From inside a cabin the walls take the highs, the howl comes
// through the gaps and the windows rattle (a struck modal bank).

import { finishBed, Fdn, Rand32, runBed } from './rain.js'
import { windLayer } from './wind.js'

const bed = {
  id: 'blizzard',
  name: 'Blizzard',
  group: 'weather',
  about: 'A howling snowstorm: freezing gusts full of hissing, ticking snow, out in it or safe inside a cabin.',
  params: [
    { id: 'strength', name: 'Wind strength', type: 'number', min: 0, max: 100, step: 1, def: 80, unit: 'percent', rand: [55, 100] },
    { id: 'snow', name: 'Blowing snow', type: 'number', min: 0, max: 100, step: 1, def: 65, unit: 'percent', rand: [30, 90] },
    { id: 'howl', name: 'Howl', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [15, 80] },
    {
      id: 'where',
      name: 'Where you are',
      type: 'choice',
      def: 'outside',
      options: [
        { v: 'outside', name: 'Out in the storm' },
        { v: 'inside', name: 'Inside a cabin' },
      ],
    },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const inside = q.where === 'inside'
      const pick = new Rand32(s.rng.fork('pitch'))
      const { L, R } = windLayer(n, s.sr, s.rng, {
        strength: q.strength / 100,
        gusts: 0.7,
        snow: q.snow / 100,
        howl: (q.howl / 100) * (inside ? 1.1 : 0.8),
        howlHz: pick.range(240, 420),
        whistle: 0.3,
        rumble: 0.55,
        rush: inside ? 0.6 : 1,
        inside,
        rattle: inside ? 0.35 : 0,
      })
      if (inside) new Fdn(s.sr, { size: 0.4, rt60: 0.45, damp: 0.6, predelayMs: 3 }).process(L, R, 0.2, 1)
      finishBed(L, R, s.sr, -19.5 + (q.strength - 80) * 0.06)
      return { L, R }
    })
  },
}

export default bed
