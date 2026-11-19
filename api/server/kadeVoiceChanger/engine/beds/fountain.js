// beds/fountain.js - A fountain splashing into its basin, in a garden or a town square.
//
// Technique: event synthesis (Farnell, "Designing Sound", 2010). The falling
// water breaks into thousands of droplets a second; each lands in the basin
// as a short bright splash (a resonant noise burst) and often a tiny
// Minnaert bubble (Minnaert 1933; damping and chirp from van den Doel 2005),
// which gives a fountain its sparkle. The jets themselves add a steady
// splashing stream that pulses slightly as the pump surges, and the basin
// sloshes softly. In a town square the buildings round it return a short
// diffuse echo (a feedback delay network, Jot and Chaigne 1991).

import {
  finishBed, Rand32, Impacts, whiteArr, eq, applyCurve, addInto, smoothCurve, ctrlLen, HOP, clamp, Fdn, runBed,
} from './rain.js'

const PLACES = {
  square: { rate: 1, spread: 0.75, echo: 0.2 },
  garden: { rate: 0.45, spread: 0.45, echo: 0 },
}

const bed = {
  id: 'fountain',
  name: 'Fountain',
  group: 'water',
  about: 'A fountain splashing and sparkling into its stone basin, in a quiet garden or a town square.',
  params: [
    { id: 'flow', name: 'How much water', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    {
      id: 'place',
      name: 'Where it is',
      type: 'choice',
      def: 'square',
      options: [
        { v: 'square', name: 'A town square' },
        { v: 'garden', name: 'A small garden' },
      ],
    },
    { id: 'distance', name: 'Distance', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 65] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const pl = PLACES[q.place] || PLACES.square
      const flow = q.flow / 100
      const dist = q.distance / 100
      const L = new Float32Array(n)
      const R = new Float32Array(n)
      const rnd = new Rand32(s.rng.fork('drops'))
      const crnd = new Rand32(s.rng.fork('curves'))
      const imp = new Impacts(L, R, rate, rnd)
      const m = ctrlLen(n)
      const cr = rate / HOP
      const pump = smoothCurve(m, cr, crnd, 0.35, 3)
      const lvl = (t) => clamp(1 + 0.18 * pump[Math.min(m - 1, Math.floor((t * rate) / HOP))], 0.5, 1.5)
      const dur = n / rate
      const lam = (500 + 3000 * flow) * pl.rate
      let t = rnd.exp(1 / lam)
      while (t < dur) {
        const D = rnd.range(1, 3.2)
        const a = 0.04 * Math.pow(D / 2, 1.2) * rnd.range(0.25, 1) * lvl(t)
        const pan = rnd.bi() * pl.spread
        imp.burst(t, a, pan, rnd.range(2200, 6500), 1, rnd.range(0.0006, 0.0016), 0.2)
        if (rnd.chance(0.35)) imp.bubble(t + rnd.range(0.0005, 0.003), a * 0.3, pan, 3 / (D * rnd.range(0.4, 1) * 0.001), rnd.range(0.1, 0.25))
        t += rnd.exp(1 / (lam * lvl(t)))
      }
      // The jets' steady stream and the basin's slosh.
      const flutter = smoothCurve(m, cr, crnd, 6, 2)
      const env = new Float32Array(m)
      for (let c = 0; c < 2; c++) {
        const ch = c === 0 ? L : R
        for (let i = 0; i < m; i++) env[i] = clamp(1 + 0.25 * pump[i] + 0.08 * flutter[i], 0.3, 2) * (0.25 + 0.5 * flow)
        let w = whiteArr(n, rnd)
        eq(w, rate, [['bandpass', 1900, 0.5], ['lowpass', 8000, 0.6]])
        applyCurve(w, env, 0.12)
        addInto(ch, w)
        for (let i = 0; i < m; i++) env[i] = clamp(1 + 0.5 * pump[(i + 400) % m], 0.2, 2) * (0.2 + 0.3 * flow)
        w = whiteArr(n, rnd)
        eq(w, rate, [['lowpass', 380, 0.7], ['highpass', 70, 0.7]])
        applyCurve(w, env, 0.1)
        addInto(ch, w)
      }
      imp.renderBanks()
      if (pl.echo > 0) new Fdn(rate, { size: 1.6, rt60: 1.2, damp: 0.5, predelayMs: 18 }).process(L, R, pl.echo * (1 + dist), 1)
      if (dist > 0.02) {
        const fc = 15000 * Math.pow(1 - dist, 1.7) + 1600
        for (const ch of [L, R]) eq(ch, rate, [['lowpass', fc, 0.6]])
      }
      finishBed(L, R, rate, -20.5 + (q.flow - 50) * 0.06 - q.distance * 0.04)
      return { L, R }
    })
  },
}

export default bed
