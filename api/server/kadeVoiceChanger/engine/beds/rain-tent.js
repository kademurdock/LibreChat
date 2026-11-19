// beds/rain-tent.js - Rain pattering on a tent, from inside or just outside.
//
// Technique: the rain engine of beds/rain.js on its tent surface. Each drop
// is a soft "pat" (a short resonant noise burst in the low mids; Farnell,
// "Designing Sound", 2010) and also strikes the fabric, two banks of lossy
// low membrane modes (modal synthesis, van den Doel and Pai 1998), so big
// drops falling from the trees above land with a hollow thup. Inside, the
// rain on the ground comes through the fabric muffled; outside you hear it
// in full with the tent pattering beside you.

import { rainLayer, finishBed, addInto, eq, runBed } from './rain.js'

const bed = {
  id: 'rain-tent',
  name: 'Rain on a tent',
  group: 'weather',
  about: 'Camping in the rain: drops patter and thump on the tent fabric, with bigger drips falling from the trees.',
  params: [
    { id: 'intensity', name: 'How hard it rains', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [20, 85] },
    {
      id: 'size',
      name: 'Tent size',
      type: 'choice',
      def: 'small',
      options: [
        { v: 'small', name: 'Small tent' },
        { v: 'big', name: 'Big family tent' },
      ],
    },
    { id: 'drips', name: 'Drips from trees', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [10, 85] },
    {
      id: 'where',
      name: 'Where you are',
      type: 'choice',
      def: 'inside',
      options: [
        { v: 'inside', name: 'Inside the tent' },
        { v: 'outside', name: 'Just outside it' },
      ],
    },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const tentSize = q.size === 'big' ? 0.75 : 1.2
      const tent = rainLayer(n, s.sr, s.rng.fork('tent'), {
        intensity: q.intensity,
        surface: 'tent',
        tentSize,
        drips: q.drips / 100,
        dripSurface: 'tent',
        waves: 0.3,
        washGain: q.where === 'outside' ? 0.2 : 1,
      })
      const { L, R } = tent
      if (q.where === 'outside') {
        // Outside: the tent's pats are softer and brighter, the rain all round in full.
        for (const ch of [L, R]) eq(ch, s.sr, [['highshelf', 2000, 0.7, 3], ['lowshelf', 200, 0.7, -6]])
        const around = rainLayer(n, s.sr, s.rng.fork('around'), {
          intensity: q.intensity,
          surface: 'mixed',
          drips: 0.2,
          waves: 0.3,
        })
        for (let i = 0; i < n; i++) {
          L[i] = L[i] * 0.6 + around.L[i]
          R[i] = R[i] * 0.6 + around.R[i]
        }
      }
      finishBed(L, R, s.sr, -20.5 + (q.intensity - 50) * 0.08)
      return { L, R }
    })
  },
}

export default bed
