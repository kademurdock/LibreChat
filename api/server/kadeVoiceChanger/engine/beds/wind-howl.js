// beds/wind-howl.js - Howling wind around a house, from inside or out.
//
// Technique: the wind engine of beds/wind.js (moving band-passed noise
// driven by one gust curve; Farnell, "Designing Sound", 2010) with its howl
// voices up front: noise through two cascaded high-Q state-variable
// bandpasses (Zavalishin 2012) tuned like the cavity and gap tones around a
// building, whose pitch slides up with each gust (aeolian tones scale with
// wind speed, Strouhal 1878), so the house moans "wooo" as gusts arrive.
// Inside, the rush is muffled by the walls, loose windows rattle in the
// strongest gusts (a struck modal bank), and the room is a small feedback
// delay network (Jot and Chaigne 1991).

import { finishBed, Fdn, runBed } from './rain.js'
import { windLayer } from './wind.js'

const bed = {
  id: 'wind-howl',
  name: 'Howling wind',
  group: 'weather',
  about: 'Wind moaning and howling round the house in long gusts, with windows rattling when it blows hardest.',
  params: [
    { id: 'strength', name: 'Wind strength', type: 'number', min: 0, max: 100, step: 1, def: 65, unit: 'percent', rand: [40, 95] },
    { id: 'gusts', name: 'Gusts', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [30, 90] },
    { id: 'pitch', name: 'Howl pitch', type: 'number', min: 120, max: 900, step: 10, def: 330, unit: 'hz', rand: [180, 600] },
    {
      id: 'where',
      name: 'Where you are',
      type: 'choice',
      def: 'inside',
      options: [
        { v: 'inside', name: 'Inside the house' },
        { v: 'outside', name: 'Outside by the house' },
      ],
    },
    { id: 'rattle', name: 'Window rattle', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 70] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const inside = q.where === 'inside'
      const { L, R } = windLayer(n, s.sr, s.rng, {
        strength: q.strength / 100,
        gusts: q.gusts / 100,
        howl: inside ? 0.7 : 0.55,
        howlHz: q.pitch,
        whistle: 0.12,
        rumble: 0.35,
        rush: inside ? 0.55 : 0.85,
        inside,
        rattle: (q.rattle / 100) * (inside ? 1 : 0.4),
      })
      if (inside) new Fdn(s.sr, { size: 0.45, rt60: 0.55, damp: 0.5, predelayMs: 4 }).process(L, R, 0.25, 1)
      finishBed(L, R, s.sr, -20 + (q.strength - 65) * 0.06)
      return { L, R }
    })
  },
}

export default bed
