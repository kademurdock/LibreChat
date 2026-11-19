// beds/creek.js - A babbling creek: water gurgling over stones close by.
//
// This file also holds the running-water engine used by the river,
// waterfall, fountain, underwater and cave beds.
//
// Technique: liquid sound is bubble sound. Following van den Doel 2005,
// "Physically based models for liquid sounds" (ACM Trans. Applied
// Perception 2(4)), running water is synthesised as a stream of Minnaert
// bubbles (Minnaert 1933): each a damped sine at f = 3 / r (r the radius in
// metres) with van den Doel's damping d = 0.043 f + 0.0014 f^1.5 and upward
// chirp f(t) = f (1 + xi d t) as the bubble nears the surface. Radii are
// drawn from a power law, as van den Doel does for brooks and rivers.
// What makes a creek rather than a fizz:
// - gurgling spots: water spilling over a particular stone makes clusters
//   of bubbles of similar size, phrase after phrase, from its own place in
//   the stereo field, with its own pitch range and rhythm;
// - a dense background swarm of small bubbles and small surface splashes;
// - a soft broadband flow rush underneath (Farnell, "Designing Sound",
//   2010, running water), and a sparkle of tiny high bubbles.

import {
  Rand32, Impacts, clamp, ctrlLen, smoothCurve, eq, addInto, whiteArr, applyCurve, HOP, finishBed, runBed,
} from './rain.js'

/** Power-law radius (metres) between r0 and r1 mm with exponent gamma (bigger gamma, more small ones). */
function drawRadius(rnd, r0, r1, gamma) {
  const u = rnd.next()
  const a = 1 - gamma
  const x0 = Math.pow(r0, a)
  const x1 = Math.pow(r1, a)
  return Math.pow(x0 + (x1 - x0) * u, 1 / a) * 0.001
}

/**
 * The running-water engine. Returns { L, R }.
 * o: { flow 0..1, babble 0..1, spots count, spotR: [lo, hi] mm,
 *      swarm bubbles per second, swarmR: [lo, hi] mm, swarmAmp,
 *      splash per second, rush 0..1, rushEq, trickle per second,
 *      width 0..1, distance 0..1, xi: [lo, hi] chirp, mod (control curve) }
 */
export function waterLayer(n, sr, rng, o = {}) {
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  if (n === 0) return { L, R }
  const rnd = new Rand32(rng.fork('water'))
  const crnd = new Rand32(rng.fork('water-curves'))
  const imp = new Impacts(L, R, sr, rnd)
  const dur = n / sr
  const m = ctrlLen(n)
  const cr = sr / HOP
  const flow = clamp(o.flow === undefined ? 0.5 : o.flow, 0, 1)
  const babble = clamp(o.babble === undefined ? 0.5 : o.babble, 0, 1)
  const width = clamp(o.width === undefined ? 0.9 : o.width, 0, 1)
  const xiLo = o.xi ? o.xi[0] : 0.1
  const xiHi = o.xi ? o.xi[1] : 0.32
  const surge = smoothCurve(m, cr, crnd, 0.15, 3)
  const level = (t) => {
    const i = Math.min(m - 1, Math.floor((t * sr) / HOP))
    let v = 1 + 0.45 * surge[i]
    if (o.mod) v *= o.mod[Math.min(o.mod.length - 1, i)]
    return clamp(v, 0.2, 2.5)
  }

  // Gurgling spots: clusters of similar bubbles from one place.
  const spots = clamp(Math.round(o.spots === undefined ? 4 : o.spots), 0, 12)
  const sr0 = o.spotR ? o.spotR[0] : 1.4
  const sr1 = o.spotR ? o.spotR[1] : 7
  for (let k = 0; k < spots; k++) {
    const pan = (spots === 1 ? 0 : -1 + (2 * (k + 0.5)) / spots + rnd.bi() * 0.15) * width
    // Each spot has its own size range within the overall one.
    const c = Math.exp(Math.log(sr0) + (Math.log(sr1) - Math.log(sr0)) * rnd.next())
    const lo = Math.max(sr0, c / 1.8)
    const hi = Math.min(sr1, c * 1.8)
    const clRate = rnd.range(1.2, 3.5) * (0.4 + flow) * (0.15 + 1.1 * babble)
    const amp = rnd.range(0.6, 1) * 0.11 * (0.35 + 0.65 * babble)
    const rhythm = smoothCurve(m, cr, crnd, rnd.range(0.2, 0.6), 2)
    let t = rnd.exp(1 / clRate)
    while (t < dur) {
      const cnt = 2 + Math.floor(rnd.exp(1 + 6 * babble))
      const rc = drawRadius(rnd, lo, hi, 1.5)
      let tb = t
      for (let j = 0; j < cnt; j++) {
        const r = rc * Math.exp(rnd.gauss() * 0.22)
        const f = 3 / r
        const a = amp * Math.pow(r / 0.003, 0.8) * rnd.range(0.35, 1) * level(tb)
        imp.bubble(tb, a, clamp(pan + rnd.bi() * 0.06, -1, 1), f, rnd.range(xiLo, xiHi))
        tb += rnd.exp(0.022 + 0.03 * (1 - babble))
      }
      const ci = Math.min(m - 1, Math.floor((t * sr) / HOP))
      t = tb + rnd.exp(1 / (clRate * clamp(1 + 0.8 * rhythm[ci], 0.2, 2.5)))
    }
  }

  // Background swarm of small bubbles.
  const swarm = o.swarm === undefined ? 200 + 500 * flow : o.swarm
  if (swarm > 0) {
    const a0 = o.swarmAmp === undefined ? 0.03 : o.swarmAmp
    const s0 = o.swarmR ? o.swarmR[0] : 0.7
    const s1 = o.swarmR ? o.swarmR[1] : 3.5
    let t = rnd.exp(1 / swarm)
    while (t < dur) {
      const r = drawRadius(rnd, s0, s1, 2)
      imp.bubble(t, a0 * Math.pow(r / 0.002, 0.8) * rnd.range(0.2, 1) * level(t), rnd.bi() * width, 3 / r, rnd.range(xiLo, xiHi))
      t += rnd.exp(1 / (swarm * level(t)))
    }
  }

  // Small splashes where the surface breaks over stones.
  const splash = o.splash === undefined ? 40 + 140 * flow : o.splash
  if (splash > 0) {
    let t = rnd.exp(1 / splash)
    while (t < dur) {
      imp.burst(t, 0.09 * rnd.range(0.2, 1), rnd.bi() * width, rnd.range(1800, 7000), 0.9, rnd.range(0.001, 0.004), 0.15)
      t += rnd.exp(1 / (splash * level(t)))
    }
  }

  // Sparkle: tiny bubbles high up.
  const trickle = o.trickle === undefined ? 150 + 300 * flow : o.trickle
  if (trickle > 0) {
    let t = rnd.exp(1 / trickle)
    while (t < dur) {
      const r = rnd.logRange(0.0003, 0.0008)
      imp.bubble(t, 0.02 * rnd.range(0.2, 1), rnd.bi() * width, 3 / r, 0.1)
      t += rnd.exp(1 / trickle)
    }
  }

  // Flow rush underneath.
  const rush = o.rush === undefined ? (0.25 + 0.3 * flow) * (1.5 - babble) : o.rush
  if (rush > 0) {
    const env = new Float32Array(m)
    for (let i = 0; i < m; i++) env[i] = clamp(1 + 0.3 * surge[i], 0.3, 2)
    const spec = o.rushEq || [['highpass', 150, 0.6], ['lowpass', 6000, 0.6], ['peak', 800, 0.7, 3]]
    for (let c = 0; c < 2; c++) {
      const s = whiteArr(n, rnd)
      eq(s, sr, spec)
      applyCurve(s, env, rush * 0.25)
      addInto(c === 0 ? L : R, s)
    }
  }

  const dist = clamp(o.distance || 0, 0, 1)
  if (dist > 0.02) {
    const fc = 15000 * Math.pow(1 - dist, 1.7) + 1500
    for (const s of [L, R]) eq(s, sr, [['lowpass', fc, 0.6]])
  }
  return { L, R }
}

const bed = {
  id: 'creek',
  name: 'Babbling creek',
  group: 'water',
  about: 'A shallow creek close by, gurgling and bubbling over the stones in several places.',
  params: [
    { id: 'flow', name: 'How much water', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 85] },
    { id: 'babble', name: 'Babbling', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [25, 90] },
    { id: 'spots', name: 'Gurgling spots', type: 'number', min: 1, max: 8, step: 1, def: 4, unit: 'count', noun: ['spot', 'spots'], rand: [2, 7] },
    { id: 'distance', name: 'Distance', type: 'number', min: 0, max: 100, step: 1, def: 15, unit: 'percent', rand: [0, 60] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const { L, R } = waterLayer(n, s.sr, s.rng, {
        flow: q.flow / 100,
        babble: q.babble / 100,
        spots: q.spots,
        distance: q.distance / 100,
      })
      finishBed(L, R, s.sr, -20 + (q.flow - 50) * 0.06 - q.distance * 0.04)
      return { L, R }
    })
  },
}

export default bed
