// beds/car-rain.js - Sitting in a car in the rain: drumming on the roof,
// drops on the windscreen, the wipers swishing and thunking, the fan running.
//
// Techniques and sources:
// - Each raindrop is an impulse whose size is heavy-tailed (many small,
//   few big; drop-size spectra after Marshall and Palmer 1948), arriving as
//   a Poisson stream. The roof is a thin steel panel, so the impulses ring a
//   bank of its plate modes (modal synthesis of impacts; van den Doel and
//   Pai 1998), and the windscreen is glass: higher, shorter and sharper.
//   Big drops falling from trees land as single loud plunks.
// - The wiper is rubber dragged across wet glass: a band of noise that
//   swells and pans across the stroke, a squeak now and then (the
//   stick-slip creak of beds/haunted-house.js, high and short), the motor's
//   whir, and a soft thunk where the blade reverses and parks.
// - Idling and driving use the toolkit engine (beds/car-highway.js) and
//   wet-tyre hiss; the heater fan is steady broadband air.

import { setup, stereo, finish, clamp, dB, wander, noisePair, norm, addTo, bq, resBank, engine, oscInto, harmonicTable, addModes, addBurst, eventTimes, Fdn } from './car-highway.js'
import { addCreak } from './haunted-house.js'

const ROOF = [[160, 5, 0.8], [330, 6, 1], [560, 7, 0.9], [870, 8, 0.7], [1300, 8, 0.5], [2000, 7, 0.35], [3100, 6, 0.2]]
const GLASS = [[1900, 4, 0.7], [3200, 5, 1], [4800, 5, 0.6], [6500, 4, 0.3]]
const WIPER_SQUEAK = [[1300, 12, 1], [2650, 14, 0.6], [3900, 15, 0.3]]

/** Poisson impulses with heavy-tailed sizes into sig (in place). rate per second may be an array per sample. */
function drops(sig, sr, rng, rate, alpha = 1.7, cap = 8) {
  const n = sig.length
  const isArr = typeof rate !== 'number'
  for (let i = 0; i < n; i++) {
    const p = (isArr ? rate[i] : rate) / sr
    if (rng.next() < p) {
      const a = Math.min(cap, Math.pow(1 - rng.next(), -1 / alpha) - 0.6)
      sig[i] += rng.next() < 0.5 ? a : -a * 0.8
    }
  }
  return sig
}

const bed = {
  id: 'car-rain',
  name: 'Car in the rain',
  group: 'vehicles',
  about: 'Inside a car in the rain: drumming on the roof, drops on the windscreen, wipers swishing and the heater fan.',
  params: [
    { id: 'intensity', name: 'How hard it rains', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [25, 90] },
    {
      id: 'wipers',
      name: 'Wipers',
      type: 'choice',
      def: 'slow',
      options: [
        { v: 'off', name: 'Wipers off' },
        { v: 'slow', name: 'Slow wipers' },
        { v: 'fast', name: 'Fast wipers' },
      ],
    },
    {
      id: 'motion',
      name: 'The car',
      type: 'choice',
      def: 'idle',
      options: [
        { v: 'parked', name: 'Parked, engine off' },
        { v: 'idle', name: 'Parked, engine running' },
        { v: 'driving', name: 'Driving slowly' },
      ],
    },
    { id: 'fan', name: 'Heater fan', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [0, 70] },
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

    // rain on the roof: left and right halves of the panel
    const sw = wander(n, SR, 0.15, r.fork('swell'))
    const rate = new Float32Array(n)
    const base = 120 + 2400 * k * k
    for (let i = 0; i < n; i++) rate[i] = base * (0.75 + 0.25 * sw[i])
    for (const [side, dst] of [['l', L], ['r', R]]) {
      const imp = drops(new Float32Array(n), SR, r.fork('roof' + side), rate)
      const modes = ROOF.map((m) => [m[0] * r.range(0.94, 1.06), m[1], m[2]])
      const roof = resBank(imp, SR, modes)
      // the patter's own tick on top
      bq(imp, SR, 'highpass', 2500, 0.707)
      for (let i = 0; i < n; i++) roof[i] += imp[i] * 0.02
      bq(roof, SR, 'lowpass', 6500, 0.707)
      norm(roof, 1)
      addTo(dst, roof, dB(-2 + 6 * k))
    }
    // a steady downpour hush (the roof roars as well as pings when it pours)
    {
      const [hl, hr] = noisePair(n, r.fork('hush'), 'white', 0.5)
      for (const sig of [hl, hr]) {
        bq(sig, SR, 'bandpass', 700, 0.5)
        bq(sig, SR, 'lowpass', 1800, 0.707)
        norm(sig, 1)
      }
      const g = dB(-22 + 16 * k)
      addTo(L, hl, g)
      addTo(R, hr, g)
    }
    // drops on the windscreen, in front
    {
      const imp = drops(new Float32Array(n), SR, r.fork('glass'), base * 0.25, 1.8)
      const gl = resBank(imp, SR, GLASS)
      norm(gl, 1)
      const g = dB(-14 + 5 * k)
      for (let i = 0; i < n; i++) {
        L[i] += gl[i] * g * 0.8
        R[i] += gl[i] * g
      }
    }
    // big plunks from overhanging trees
    for (const t of eventTimes(0.2 + 0.4 * k, dur, r.fork('plunk'), 0.3)) {
      const pan = r.range(-0.8, 0.8)
      addModes(L, R, Math.round(t * SR), SR, ROOF.map((m) => [m[0] * r.range(0.95, 1.05), 0.6 / m[1] * 0.1 + 0.02, m[2]]), r.range(0.4, 0.9), pan, r)
    }

    // the wipers
    if (q.wipers !== 'off') {
      const per = q.wipers === 'fast' ? r.range(0.72, 0.8) : r.range(1.5, 1.7)
      const stroke = q.wipers === 'fast' ? 0.32 : 0.48
      const pause = q.wipers === 'slow' ? r.range(0.4, 1.2) : 0
      let t = r.range(0, per)
      while (t < dur) {
        for (let dir = 0; dir < 2; dir++) {
          const t0 = t + dir * stroke
          const i0 = Math.round(t0 * SR)
          const m = Math.round(stroke * SR)
          // rubber swish across the glass, panning with the blade
          const [a, b] = noisePair(m, r.fork('w' + t0), 'pink', 0.6)
          bq(a, SR, 'bandpass', 1700, 0.9)
          bq(b, SR, 'bandpass', 1650, 0.9)
          norm(a, 1)
          norm(b, 1)
          const g = 0.3 + 0.2 * k
          for (let j = 0; j < m && i0 + j < n; j++) {
            const x = j / m
            const env = Math.sin(Math.PI * x) * g
            const pan = dir ? 1 - 2 * x : -1 + 2 * x
            L[i0 + j] += a[j] * env * (0.7 - 0.3 * pan)
            R[i0 + j] += b[j] * env * (0.7 + 0.3 * pan)
          }
          // a squeak on some strokes
          if (r.next() < 0.25) addCreak(L, R, i0 + Math.round(stroke * 0.3 * SR), SR, r, { dur: stroke * 0.35, rate0: 220, peak: 380, rate1: 260, modes: WIPER_SQUEAK, jitter: 0.05, amp: 0.12, pan: 0, rub: 0.05, tail: 0.05 })
          // the blade turning round at the end of its sweep
          addModes(L, R, i0 + m, SR, [[r.range(110, 140), 0.03, 1], [r.range(300, 360), 0.015, 0.4]], 0.3, dir ? -0.6 : 0.6, r)
        }
        // the motor
        const mi = Math.round(t * SR)
        const ml = Math.round(2 * stroke * SR)
        oscInto(L, SR, 95, 0.02, harmonicTable([1, 0.6, 0.4, 0.25]), 0, 4, mi, Math.min(ml, n - mi))
        oscInto(R, SR, 95, 0.02, harmonicTable([1, 0.6, 0.4, 0.25]), 0, 4, mi, Math.min(ml, n - mi))
        t += 2 * stroke + pause + (q.wipers === 'fast' ? Math.max(0, per - 2 * stroke) : 0.05)
      }
    }
    // engine and road
    if (q.motion !== 'parked') {
      const rpm = new Float32Array(n)
      const wv = wander(n, SR, 0.2, r.fork('rpm'))
      const base2 = q.motion === 'driving' ? 1500 : 760
      for (let i = 0; i < n; i++) rpm[i] = base2 * (1 + 0.015 * wv[i])
      const e = engine(n, SR, rpm, { cyl: 4, pulseHz: 160, pulseQ: 1.4, rough: 0.07, res: [[90, 2, 3]] }, r.fork('engine'))
      bq(e, SR, 'lowpass', 500, 0.707)
      const g = dB(q.motion === 'driving' ? -9 : -13)
      addTo(L, e, g)
      addTo(R, e, g)
    }
    if (q.motion === 'driving') {
      const [tl, tr] = noisePair(n, r.fork('tyres'), 'white', 0.3)
      const swish = wander(n, SR, 0.9, r.fork('tsw'))
      for (const sig of [tl, tr]) {
        bq(sig, SR, 'bandpass', 2400, 0.5)
        bq(sig, SR, 'lowpass', 6000, 0.707)
        norm(sig, 1)
      }
      const [rl, rr] = noisePair(n, r.fork('road'), 'brown', 0.5)
      for (const sig of [rl, rr]) {
        bq(sig, SR, 'lowpass', 160, 0.7)
        norm(sig, 1)
      }
      for (let i = 0; i < n; i++) {
        const m = 0.6 + 0.4 * swish[i]
        L[i] += tl[i] * 0.35 * m + rl[i] * 0.4
        R[i] += tr[i] * 0.35 * m + rr[i] * 0.4
      }
    }
    // the heater fan
    const fan = q.fan / 100
    if (fan > 0) {
      const [fl, fr] = noisePair(n, r.fork('fan'), 'white', 0.5)
      for (const sig of [fl, fr]) {
        bq(sig, SR, 'bandpass', 800, 0.6)
        bq(sig, SR, 'peak', 2200, 1, 3)
        norm(sig, 1)
      }
      const g = dB(-22 + 14 * fan)
      addTo(L, fl, g)
      addTo(R, fr, g)
      oscInto(L, SR, r.range(140, 180), g * 0.08, harmonicTable([1, 0.3]), 0, 2)
    }
    // the small closed cabin
    bq(L, SR, 'peak', 70, 1.2, 2)
    bq(R, SR, 'peak', 70, 1.2, 2)
    new Fdn(SR, { size: 0.35, rt60: 0.18, damp: 0.6, predelayMs: 1 }).process(L, R, 0.1, 1)
    return finish(L, R, SR, -23 + (k - 0.55) * 8, -8)
  },
}

export default bed
