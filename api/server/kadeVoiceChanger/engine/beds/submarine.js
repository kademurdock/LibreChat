// beds/submarine.js - Inside a submarine: the hum of the boat, sonar pings
// ringing out into the deep, the hull groaning under pressure.
//
// Techniques and sources:
// - The active sonar "ping" is a short tone burst (a few hundred
//   milliseconds between about 2 and 4 kHz in the classic sound) whose
//   reverberation in the sea lasts for seconds, with an echo returning
//   from a target after the two-way travel time (2 x range / 1500 m/s) and
//   shifted a little by the target's motion (Urick, "Principles of
//   Underwater Sound", 1983). The long ring is a large, bright feedback
//   delay network; the echo is a second, weaker ping at the doppler-shifted
//   pitch.
// - Hull groans are very slow stick-slip creaks through low steel
//   resonances (Avanzini, Serafin and Rocchesso 2005, as in
//   beds/haunted-house.js), with sharp stress pops (decaying modes, van den
//   Doel and Pai 1998) as the steel shifts.
// - Inside: the boat's electrical hum (60 Hz and harmonics), ventilation
//   noise, the slow swish of the screw, water moving past the hull.

import { setup, stereo, finish, clamp, dB, wander, noisePair, noise, norm, addTo, bq, oscInto, harmonicTable, addTone, addModes, addBurst, eventTimes, Fdn } from './car-highway.js'
import { addCreak, addDrip, HULL } from './haunted-house.js'

const bed = {
  id: 'submarine',
  name: 'Submarine',
  group: 'vehicles',
  about: 'Inside a submarine: the low hum of the boat, sonar pings ringing into the deep, the hull groaning.',
  params: [
    { id: 'intensity', name: 'How loud', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [30, 85] },
    { id: 'pings', name: 'Sonar pings', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [20, 90] },
    { id: 'groans', name: 'Hull groans', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [10, 85] },
    { id: 'hum', name: 'Machinery hum', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [15, 80] },
    { id: 'distance', name: 'Echo distance', type: 'number', min: 200, max: 5000, step: 50, def: 1500, unit: 'meters', rand: [500, 4000] },
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

    // inside the boat: hum, ventilation, the screw's slow swish
    const hum = q.hum / 100
    {
      const g = dB(-20 + 12 * hum)
      oscInto(L, SR, 60, g, harmonicTable([1, 0.55, 0.4, 0.2, 0.12, 0.06]), 0, 6)
      oscInto(R, SR, 60.05, g, harmonicTable([1, 0.55, 0.4, 0.2, 0.12, 0.06]), 0.3, 6)
      const [vl, vr] = noisePair(n, r.fork('vent'), 'pink', 0.4)
      for (const sig of [vl, vr]) {
        bq(sig, SR, 'bandpass', 700, 0.6)
        bq(sig, SR, 'lowpass', 2500, 0.707)
        norm(sig, 1)
      }
      const gv = dB(-20 + 8 * hum)
      addTo(L, vl, gv)
      addTo(R, vr, gv)
      const sw = noise(n, r.fork('screw'), 'brown')
      bq(sw, SR, 'lowpass', 220, 0.7)
      norm(sw, 1)
      const rate = r.range(1.6, 2.6)
      const ph = r.next()
      const gs = dB(-12 + 6 * hum)
      for (let i = 0; i < n; i++) {
        const m = 0.6 + 0.4 * Math.sin(2 * Math.PI * (rate * (i / SR) + ph))
        const x = sw[i] * gs * m
        L[i] += x
        R[i] += x * 0.9
      }
    }
    // water outside: a dark wash and the odd gurgle
    {
      const [wl, wr] = noisePair(n, r.fork('water'), 'brown', 0.3)
      for (const sig of [wl, wr]) {
        bq(sig, SR, 'lowpass', 350, 0.7)
        norm(sig, 1)
      }
      addTo(L, wl, 0.2)
      addTo(R, wr, 0.2)
      for (const t of eventTimes(0.3, dur, r.fork('gurgle'), 0.5)) addDrip(L, R, Math.round(t * SR), SR, r, { f: r.range(250, 600), amp: 0.06, pan: r.range(-0.8, 0.8), rise: 6 })
    }
    // the hull under pressure
    const gr = q.groans / 100
    const H = new Float32Array(n)
    const HR = new Float32Array(n)
    if (gr > 0) {
      for (const t of eventTimes(0.03 + 0.12 * gr, dur, r.fork('groan'), 3, -1)) {
        const d = r.range(1.8, 4.5)
        const r0 = r.range(5, 14)
        addCreak(H, HR, Math.round(Math.max(0, t) * SR), SR, r, { dur: d, rate0: r0, peak: r0 * r.range(1.5, 3.5), rate1: r0 * r.range(0.7, 1.4), modes: HULL, jitter: 0.15, wobble: 0.5, amp: (0.5 + 0.7 * gr) * r.range(0.6, 1), pan: r.range(-0.8, 0.8), rub: 0.3, tail: 0.6 })
      }
      for (const t of eventTimes(0.02 + 0.08 * gr, dur, r.fork('pop'), 2)) {
        const f = r.range(260, 700)
        const pan = r.range(-0.9, 0.9)
        addModes(H, HR, Math.round(t * SR), SR, [[f, 0.35, 1], [f * 2.41, 0.2, 0.5], [f * 4.1, 0.1, 0.25]], (0.25 + 0.4 * gr) * r.range(0.6, 1), pan, r)
        addBurst(H, HR, Math.round(t * SR), SR, r, { amp: 0.3 * gr, pan, tau: 0.003, f: 1800, q: 0.6 })
      }
    }
    // sonar: the ping, its long ring in the sea, the echo from far away
    const pg = q.pings / 100
    const PL = new Float32Array(n)
    const PR = new Float32Array(n)
    if (pg > 0) {
      const f = r.range(2400, 3400)
      const per = 12 - 7 * pg
      const echoDelay = (2 * q.distance) / 1500
      const dop = 1 + r.range(-0.012, 0.012)
      const echoG = clamp(0.6 * Math.pow(400 / q.distance, 0.7), 0.08, 0.6)
      let t = r.range(0.2, Math.min(per, 2.5))
      while (t < dur) {
        const i0 = Math.round(t * SR)
        const hold = r.range(0.18, 0.32)
        addTone(PL, PR, i0, SR, { f, attack: 0.004, hold, tau: 0.08, amp: 0.5, pan: 0 })
        addTone(PL, PR, i0, SR, { f: f * 2, attack: 0.004, hold, tau: 0.05, amp: 0.05, pan: 0 })
        const te = t + echoDelay
        if (te < dur) addTone(PL, PR, Math.round(te * SR), SR, { f: f * dop, attack: 0.03, hold: hold * 1.1, tau: 0.15, amp: 0.5 * echoG, pan: r.range(-0.5, 0.5) })
        t += per * r.range(0.92, 1.08)
      }
    }
    // the sea rings: a long bright tail for pings, a dark steel ring for the hull
    new Fdn(SR, { size: 3.5, rt60: 3.5 + (q.distance / 5000) * 3, damp: 0.15, predelayMs: 25, diffuse: 0.75 }).process(PL, PR, 1.0, 0.6)
    bq(PL, SR, 'lowpass', 6000, 0.707)
    bq(PR, SR, 'lowpass', 6000, 0.707)
    new Fdn(SR, { size: 1.8, rt60: 1.6, damp: 0.5, predelayMs: 10 }).process(H, HR, 0.4, 1)
    addTo(L, H)
    addTo(R, HR)
    addTo(L, PL, 0.9)
    addTo(R, PR, 0.9)
    // a little boat interior around everything
    new Fdn(SR, { size: 0.7, rt60: 0.4, damp: 0.5, predelayMs: 3 }).process(L, R, 0.08, 1)
    return finish(L, R, SR, -23 + (k - 0.55) * 8, -22)
  },
}

export default bed
