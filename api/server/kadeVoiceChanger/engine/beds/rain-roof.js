// beds/rain-roof.js - Rain drumming on a tin roof, heard from underneath.
//
// Technique: the rain engine of beds/rain.js on its tin surface. Every drop
// strikes one of four metal panels, each a bank of inharmonic plate modes
// (modal synthesis, Adrien 1991; van den Doel and Pai 1998), plus a low
// bank for the whole roof's thrum, and a downpour also feeds the panels a
// dense stream of tiny impacts so the roof roars as well as pings. The rain
// on the ground outside comes through muffled, gutter overflow drips into a
// puddle (Minnaert 1933 bubbles), and the space under the roof is a feedback
// delay network (Stautner and Puckette 1982) sized to the building.

import { rainLayer, finishBed, Fdn, clamp, runBed } from './rain.js'

const PLACES = {
  porch: { size: 1, room: { size: 0.4, rt60: 0.3, damp: 0.5 }, wet: 0.12 },
  shed: { size: 0.75, room: { size: 0.35, rt60: 0.6, damp: 0.35 }, wet: 0.3 },
  barn: { size: 1.4, room: { size: 1.3, rt60: 1.6, damp: 0.45 }, wet: 0.35 },
}

const bed = {
  id: 'rain-roof',
  name: 'Rain on a tin roof',
  group: 'weather',
  about: 'Under a metal roof while rain drums and pings on it, with gutter drips outside.',
  params: [
    { id: 'intensity', name: 'How hard it rains', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [25, 90] },
    { id: 'ring', name: 'Metal ring', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [30, 90] },
    {
      id: 'place',
      name: 'Under what',
      type: 'choice',
      def: 'porch',
      options: [
        { v: 'porch', name: 'A porch roof' },
        { v: 'shed', name: 'A small shed' },
        { v: 'barn', name: 'A big barn' },
      ],
    },
    { id: 'drips', name: 'Gutter drips', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [0, 80] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const place = PLACES[q.place] || PLACES.porch
      const { L, R } = rainLayer(n, s.sr, s.rng.fork('rain'), {
        intensity: q.intensity,
        surface: 'roof',
        ring: q.ring / 100,
        roofSize: place.size,
        drips: q.drips / 100,
        dripSurface: 'puddle',
        waves: 0.3,
      })
      new Fdn(s.sr, { ...place.room, predelayMs: 2 }).process(L, R, place.wet, 1)
      finishBed(L, R, s.sr, -20 + (q.intensity - 50) * 0.08 + clamp(q.ring - 60, -60, 40) * 0.01)
      return { L, R }
    })
  },
}

export default bed
