// beds/boat-engine.js - Out on the water in a motor boat: the engine, the hull
// slapping the waves, the wash along the side.
//
// Techniques and sources:
// - Engines use the toolkit's combustion-pulse model (beds/car-highway.js;
//   Farnell, "Designing Sound", 2010): a small two-stroke outboard (two
//   firings per turn per cylinder pair, a buzzing 150 to 170 Hz at speed),
//   an old single-cylinder fishing-boat diesel (one firing every two turns:
//   the slow "putt, putt, putt" a few times a second, with its exhaust
//   knock), or a big ship's slow two-stroke diesel (a deep throb near 10 Hz)
//   with the generators' hum, heard through the decks.
// - Waves on a hull: each wave that meets the hull gives one or two slaps,
//   a band of low noise with a fast attack and the hull's own hollow ring
//   (modal synthesis, van den Doel and Pai 1998), arriving at the wave period
//   with natural spread; between them the water laps and gurgles (small
//   Minnaert bubbles, van den Doel 2005). The wash along the side is pink
//   noise that swells with speed and with each wave.
// - Sitting at the bow puts the engine further off (quieter and darker)
//   and the waves closer.

import { setup, stereo, finish, clamp, dB, wander, noise, noisePair, norm, addTo, bq, engine, oscInto, SINE, addModes, addBurst, Fdn } from './car-highway.js'
import { addDrip } from './haunted-house.js'

/**
 * Hull slaps and lapping for o.dur seconds. o: { period=3 (s), amp=1,
 * hull=1 (1 small boat, 2 big), lap=1 (gurgle amount), panSpread=0.8 }.
 */
export function addHullWater(L, R, sr, rng, o = {}) {
  const dur = o.dur ?? L.length / sr
  const period = o.period ?? 3
  const amp = o.amp ?? 1
  const hull = o.hull ?? 1
  const spread = o.panSpread ?? 0.8
  let t = rng.range(0, period)
  while (t < dur) {
    const slaps = 1 + rng.int(3)
    let ts = t
    for (let j = 0; j < slaps; j++) {
      const i0 = Math.round(ts * sr)
      const pan = rng.range(-spread, spread)
      const a = amp * rng.range(0.4, 1) * (j ? 0.6 : 1)
      addBurst(L, R, i0, sr, rng, { amp: a, pan, attack: 0.006, tau: rng.range(0.05, 0.12) * hull, f: rng.range(350, 650) / Math.sqrt(hull), q: 0.6, type: 'lowpass' })
      addModes(L, R, i0, sr, [[rng.range(110, 160) / hull, 0.07 * hull, 1], [rng.range(300, 380) / hull, 0.035, 0.4]], a * 0.5, pan, rng)
      addBurst(L, R, i0 + Math.round(0.02 * sr), sr, rng, { amp: a * 0.25, pan, attack: 0.01, tau: 0.08, f: rng.range(1800, 3200), q: 0.6 })
      ts += rng.range(0.15, 0.5)
    }
    // gurgles and laps between the slaps
    const lap = o.lap ?? 1
    const g = Math.round(lap * rng.range(2, 7))
    for (let j = 0; j < g; j++) {
      const tg = t + rng.range(0.1, period)
      if (tg >= dur) continue
      addDrip(L, R, Math.round(tg * sr), sr, rng, { f: rng.range(320, 1100), amp: amp * rng.range(0.05, 0.18), pan: rng.range(-spread, spread), rise: rng.range(5, 18) })
    }
    t += period * rng.range(0.75, 1.3)
  }
}

/** The wash along the hull: a stereo pink pair already filtered and normalised to RMS 1. */
export function washPair(n, sr, rng, bright = 1) {
  const [a, b] = noisePair(n, rng, 'pink', 0.3)
  for (const s of [a, b]) {
    bq(s, sr, 'bandpass', 900 * bright, 0.45)
    bq(s, sr, 'highpass', 150, 0.707)
    norm(s, 1)
  }
  return [a, b]
}

const BOATS = {
  outboard: { rpm: 4800, lo: 0.55, eng: { cyl: 2, strokes: 2, pulseHz: 1300, pulseQ: 3, rough: 0.06, res: [[420, 3, 4], [2100, 4, 3]] }, engDb: -2, lp: 6000, wash: 1, hull: 1 },
  fishing: { rpm: 620, lo: 0.7, eng: { cyl: 1, pulseHz: 170, pulseQ: 3, rough: 0.1, knock: 0.7, knockHz: 900, knockMs: 6, res: [[90, 2, 6], [280, 3, 4]] }, engDb: 0, lp: 3500, wash: 0.6, hull: 1.3 },
  ship: { rpm: 100, lo: 0.8, eng: { cyl: 6, strokes: 2, pulseHz: 60, pulseQ: 1.6, rough: 0.07, res: [[38, 2, 5]] }, engDb: -1, lp: 500, wash: 0.5, hull: 2.2 },
}

const bed = {
  id: 'boat-engine',
  name: 'Motor boat',
  group: 'vehicles',
  about: 'Out on the water in a motor boat: the engine, the hull slapping the waves and the wash along the side.',
  params: [
    { id: 'intensity', name: 'Throttle', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [25, 90] },
    {
      id: 'boat',
      name: 'Boat',
      type: 'choice',
      def: 'fishing',
      options: [
        { v: 'outboard', name: 'A small outboard motor' },
        { v: 'fishing', name: 'An old fishing boat' },
        { v: 'ship', name: 'A big ship, below deck' },
      ],
    },
    { id: 'waves', name: 'Waves', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [15, 90] },
    {
      id: 'seat',
      name: 'Where you sit',
      type: 'choice',
      def: 'engine',
      options: [
        { v: 'engine', name: 'Near the engine' },
        { v: 'bow', name: 'Up at the bow' },
      ],
    },
  ],

  generate(seconds, sr, p, rng) {
    const s = setup(bed, seconds, sr, p, rng)
    const { n, q } = s
    const SR = s.sr
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    if (n === 0) return stereo(SR, L, R)
    const r = s.rng
    const dur = s.dur
    const k = q.intensity / 100
    const boat = BOATS[q.boat] || BOATS.fishing
    const bow = q.seat === 'bow'
    const wv = q.waves / 100

    // the engine, its revs wandering with the throttle hand and the load of the waves
    const thr = wander(n, SR, 0.1, r.fork('thr'))
    const waveLoad = wander(n, SR, 0.4, r.fork('wl'))
    const rpm = new Float32Array(n)
    const base = boat.rpm * (boat.lo + (1 - boat.lo) * k)
    for (let i = 0; i < n; i++) rpm[i] = base * (1 + 0.02 * thr[i] + 0.012 * wv * waveLoad[i])
    const e = engine(n, SR, rpm, boat.eng, r.fork('engine'))
    bq(e, SR, 'lowpass', boat.lp * (bow ? 0.5 : 1), 0.707)
    if (q.boat === 'ship') {
      // generators and machinery hum through the decks
      const ml = noise(n, r.fork('mach'), 'brown')
      bq(ml, SR, 'lowpass', 300, 0.7)
      norm(ml, 0.6)
      addTo(e, ml, 1)
      for (const [f, a] of [[60, 0.35], [120, 0.2], [180, 0.08]]) oscInto(e, SR, f, a, SINE, r.next(), 1)
    }
    const eg = dB(boat.engDb + 4 * k + (bow ? -9 : 0))
    for (let i = 0; i < n; i++) {
      const x = e[i] * eg
      L[i] += x * (bow ? 1 : 0.9)
      R[i] += x
    }
    // wash along the hull, swelling with speed and each wave
    {
      const [wl, wr] = washPair(n, SR, r.fork('wash'), q.boat === 'ship' ? 0.6 : 1)
      const sw = wander(n, SR, 0.35, r.fork('sw'))
      const g = dB(-10 + 8 * k + 4 * wv + (bow ? 3 : 0)) * boat.wash
      for (let i = 0; i < n; i++) {
        const m = 0.7 + 0.3 * sw[i]
        L[i] += wl[i] * g * m
        R[i] += wr[i] * g * (1.4 - m)
      }
    }
    // slaps and laps
    if (wv > 0) {
      const period = q.boat === 'ship' ? r.range(5, 8) : r.range(1.6, 3.2) / (0.6 + 0.6 * k)
      addHullWater(L, R, SR, r.fork('hull'), { dur, period, amp: (0.6 + 1.4 * wv) * (bow ? 1.4 : 1) * (q.boat === 'ship' ? 0.5 : 1), hull: boat.hull, lap: 0.5 + wv })
    }
    // spray when a small boat runs fast
    if (q.boat === 'outboard' && k > 0.4) {
      const [pl, pr] = noisePair(n, r.fork('spray'), 'white', 0.2)
      const sw = wander(n, SR, 1.2, r.fork('sp'))
      for (const sig of [pl, pr]) {
        bq(sig, SR, 'bandpass', 3500, 0.5)
        norm(sig, 1)
      }
      const g = dB(-14 + 10 * (k - 0.4))
      for (let i = 0; i < n; i++) {
        const m = clamp(0.5 + 0.5 * sw[i], 0, 1)
        L[i] += pl[i] * g * m
        R[i] += pr[i] * g * m
      }
    }
    if (q.boat === 'ship') new Fdn(SR, { size: 1.6, rt60: 0.9, damp: 0.6, predelayMs: 8 }).process(L, R, 0.2, 1)
    else new Fdn(SR, { size: 1.2, rt60: 0.45, damp: 0.6, predelayMs: 6, diffuse: 0.6 }).process(L, R, 0.12, 1)
    return finish(L, R, SR, -22 + (k - 0.55) * 8, -9)
  },
}

export default bed
