// beds/hail.js - Hail: hard ice stones clattering and bouncing on what they hit.
//
// Technique: event synthesis in the manner of Farnell's "Designing Sound"
// (MIT Press 2010). Every hailstone is its own impact: a hard contact tick
// plus the response of the surface (turf thock, wood knock, glass tick, or
// the panel modes of a tin roof or a car, struck modal banks after Adrien
// 1991 and van den Doel and Pai 1998). Unlike rain, ice bounces: each stone
// strikes again one to three times, each bounce sooner and softer by the
// coefficient of restitution (a bouncing ball's intervals shrink
// geometrically), which is the rattle that tells hail from rain. Stone sizes
// follow an exponential distribution (as in Cheng and English 1983 for
// hailstone spectra). Distant stones make a bright clicking wash, and rain
// usually falls with it, using the rain engine of beds/rain.js.

import {
  Rand32, Impacts, clamp, finishBed, sizzleArr, eq, addInto, rainLayer, rmsOf, runBed,
} from './rain.js'

const SURFACES = {
  ground: { bounce: 0.25, rain: 'mixed' },
  deck: { bounce: 0.9, rain: 'pavement' },
  window: { bounce: 0.8, rain: 'window' },
  roof: { bounce: 0.9, rain: 'roof' },
  car: { bounce: 0.85, rain: 'pavement' },
}

/** Hail over n samples: { L, R } before levelling. */
export function hailLayer(n, sr, rng, o = {}) {
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  if (n === 0) return { L, R }
  const rnd = new Rand32(rng.fork('hail'))
  const imp = new Impacts(L, R, sr, rnd)
  const surf = SURFACES[o.surface] ? o.surface : 'ground'
  const S = SURFACES[surf]
  const inten = clamp((o.intensity === undefined ? 50 : o.intensity) / 100, 0, 1)
  const size = clamp(o.size === undefined ? 0.4 : o.size, 0, 1)
  const dur = n / sr
  const lam = 12 + 420 * Math.pow(inten, 1.4)
  const meanD = 4 + 14 * size

  // Shared bodies.
  let panels = null
  let pane = -1
  if (surf === 'roof' || surf === 'car') {
    panels = []
    const car = surf === 'car'
    for (let k = 0; k < (car ? 2 : 4); k++) {
      const base = car ? rnd.range(140, 260) : rnd.range(900, 1800)
      const ratios = car ? [1, 1.62, 2.31, 3.4, 5.1, 7.3, 11.8, 17] : [1, 1.41, 1.83, 2.37, 2.95, 3.62, 4.43, 5.31]
      const f = ratios.map((x) => base * x * rnd.range(0.95, 1.05))
      const tau = ratios.map((x, j) => (car ? 0.05 : 0.06) * (1.1 - j * 0.07) * rnd.range(0.8, 1.2))
      const g = ratios.map((x, j) => 0.6 / (1 + j * 0.25))
      panels.push(imp.addBank(f, tau, g, car ? -0.4 + k * 0.8 : -0.75 + k * 0.5, 0.25))
    }
  }
  if (surf === 'window' || surf === 'car') {
    const f = []
    const tau = []
    const g = []
    for (let j = 0; j < 8; j++) {
      f.push(900 * Math.pow(6, j / 7) * rnd.range(0.92, 1.08))
      tau.push(rnd.range(0.005, 0.014))
      g.push(0.4 / (1 + j * 0.3))
    }
    pane = imp.addBank(f, tau, g, surf === 'car' ? 0.2 : 0, 0.5)
  }

  const hit = (t, D, a, pan, first) => {
    const hard = Math.pow(D / 10, 0.3)
    switch (surf) {
      case 'ground': {
        imp.burst(t, a * 1.4, pan, 2000 * rnd.range(0.7, 1.3) / hard, 1.2, 0.0015 + 0.0008 * hard, 0.5)
        if (first) imp.lowBurst(t, a * 0.5, pan, rnd.range(180, 320), 0.006)
        break
      }
      case 'deck': {
        imp.burst(t, a * 1.1, pan, 3200 * rnd.range(0.8, 1.2), 1, 0.0004, 0.9)
        imp.mode(t, a * 0.5, pan, rnd.range(420, 1050) / hard, rnd.range(0.008, 0.02))
        imp.mode(t, a * 0.25, pan, rnd.range(1100, 2600), rnd.range(0.004, 0.01))
        break
      }
      case 'window': {
        imp.burst(t, a * 1.2, pan, 6000 * rnd.range(0.8, 1.2), 1.2, 0.00025, 1)
        imp.mode(t, a * 0.3, pan, rnd.range(2500, 7000), rnd.range(0.003, 0.007))
        imp.excite(pane, t, a * 0.4)
        break
      }
      case 'roof': {
        imp.burst(t, a * 0.6, pan, 5200 * rnd.range(0.8, 1.2), 1, 0.0003, 0.9)
        imp.excite(panels[Math.min(3, Math.max(0, Math.floor((pan + 1) * 2)))], t, a * 1.1)
        break
      }
      case 'car': {
        if (rnd.chance(0.3)) {
          imp.burst(t, a * 1.1, pan, 6000, 1.2, 0.00025, 1)
          imp.excite(pane, t, a * 0.35)
        } else {
          imp.burst(t, a * 0.7, pan, 3800 * rnd.range(0.8, 1.2), 1, 0.0004, 0.8)
          imp.excite(panels[pan < 0 ? 0 : 1], t, a * 0.9)
        }
        break
      }
    }
  }

  let t = rnd.exp(1 / lam)
  while (t < dur) {
    const D = Math.min(50, 5 + rnd.exp(meanD - 4))
    const r = rnd.logRange(0.8, 9)
    const a = (Math.pow(D / 10, 1.3) * 0.32) / Math.pow(r, 0.8)
    const pan = rnd.bi()
    hit(t, D, a, pan, true)
    // Bounces: sooner and softer each time.
    if (rnd.chance(S.bounce)) {
      const e = rnd.range(0.32, 0.55)
      let gap = rnd.range(0.05, 0.22) * Math.sqrt(D / 10)
      let tb = t
      let ab = a
      const nb = 1 + rnd.int(3)
      for (let b = 0; b < nb; b++) {
        tb += gap
        ab *= Math.pow(e, 1.3)
        gap *= e
        if (tb >= dur || ab < 1e-4) break
        hit(tb, D * 0.8, ab, pan + rnd.bi() * 0.06, false)
      }
    }
    t += rnd.exp(1 / lam)
  }
  imp.renderBanks()

  // The clicking wash of stones landing farther away.
  const dens = 300 + 7000 * Math.pow(inten, 1.2)
  for (let c = 0; c < 2; c++) {
    const s = sizzleArr(n, sr, rnd, dens, 0.15)
    eq(s, sr, [['highpass', 1800, 0.6], ['peak', 4500, 0.8, 4], ['lowpass', 11000, 0.6]])
    addInto(c === 0 ? L : R, s, 0.03 * (0.3 + inten))
  }

  // Rain with it.
  const rainAmt = clamp(o.rain === undefined ? 0.3 : o.rain, 0, 1)
  if (rainAmt > 0) {
    const ra = rainLayer(n, sr, rng.fork('rain'), { intensity: 35 + 50 * rainAmt, surface: S.rain, drips: 0, waves: 0.2 })
    const hr = rmsOf(L, R)
    const rr = rmsOf(ra.L, ra.R)
    const g = rr > 1e-9 ? (hr / rr) * 0.9 * rainAmt : 0
    addInto(L, ra.L, g)
    addInto(R, ra.R, g)
  }
  return { L, R }
}

const bed = {
  id: 'hail',
  name: 'Hail',
  group: 'weather',
  about: 'Hailstones clattering and bouncing on the ground, a deck, a window, a tin roof or a car.',
  params: [
    { id: 'intensity', name: 'How hard it hails', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [25, 90] },
    { id: 'size', name: 'Stone size', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [10, 80] },
    {
      id: 'surface',
      name: 'What it hits',
      type: 'choice',
      def: 'ground',
      options: [
        { v: 'ground', name: 'Grass and ground' },
        { v: 'deck', name: 'A wooden deck' },
        { v: 'window', name: 'A window' },
        { v: 'roof', name: 'A tin roof' },
        { v: 'car', name: 'A car' },
      ],
    },
    { id: 'rain', name: 'Rain with it', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 70] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const { L, R } = hailLayer(n, s.sr, s.rng, { intensity: q.intensity, size: q.size / 100, surface: q.surface, rain: q.rain / 100 })
      finishBed(L, R, s.sr, -20 + (q.intensity - 50) * 0.08)
      return { L, R }
    })
  },
}

export default bed
