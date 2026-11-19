// beds/wind-trees.js - Wind through the trees: leaves rustle as each gust passes.
//
// Technique: the wind engine of beds/wind.js (moving band-passed noise
// driven by one gust curve; Farnell, "Designing Sound", 2010) kept soft, with
// a rustle voice per tree: thousands of tiny clicks whose density follows
// that tree's own delayed share of the gust, coloured for green leaves, dry
// leaves or pine needles (a smooth sigh), plus the swish of moving boughs.
// Trees stand at different places across the stereo field and answer the
// gust one after another, which is how a gust is heard crossing a wood.

import { finishBed, runBed } from './rain.js'
import { windLayer } from './wind.js'

const bed = {
  id: 'wind-trees',
  name: 'Wind in the trees',
  group: 'weather',
  about: 'A breeze moving through the trees, leaves rustling as each gust passes from one tree to the next.',
  params: [
    { id: 'strength', name: 'Wind strength', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [20, 80] },
    { id: 'gusts', name: 'Gusts', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [25, 85] },
    {
      id: 'leaves',
      name: 'Kind of trees',
      type: 'choice',
      def: 'summer',
      options: [
        { v: 'summer', name: 'Leafy summer trees' },
        { v: 'dry', name: 'Dry autumn leaves' },
        { v: 'pine', name: 'Pine trees' },
      ],
    },
    { id: 'trees', name: 'How many trees', type: 'number', min: 1, max: 8, step: 1, def: 4, unit: 'count', noun: ['tree', 'trees'], rand: [2, 7] },
    { id: 'distance', name: 'Distance', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 60] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const { L, R } = windLayer(n, s.sr, s.rng, {
        strength: q.strength / 100,
        gusts: q.gusts / 100,
        leaves: 0.8,
        leafKind: q.leaves,
        trees: q.trees,
        whistle: 0.04,
        rumble: 0.12,
        rush: 0.55,
        distance: q.distance / 100,
      })
      finishBed(L, R, s.sr, -20.5 + (q.strength - 45) * 0.06 - q.distance * 0.04)
      return { L, R }
    })
  },
}

export default bed
