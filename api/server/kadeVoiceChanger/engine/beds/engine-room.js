// beds/engine-room.js - Down in an engine room: big machinery pounding away in
// a hard steel space, steam hissing, a pump thumping, tools clanking.
//
// Techniques and sources:
// - A ship's diesel uses the toolkit's combustion-pulse engine
//   (beds/car-highway.js; Farnell, "Designing Sound", 2010) as an eight-
//   cylinder four-stroke near 700 rpm with heavy injection knock, its
//   turbocharger whine and the generators' 60 Hz hum and harmonics.
// - A steam engine is rhythmic: each piston stroke ends in an exhaust chuff
//   (band-passed noise with a fast attack, four per turn for a double-acting
//   two-cylinder engine) and the valve gear clicks and clanks once a turn;
//   steam leaks are steady high hisses that flare up now and then.
// - A turbine hall is a steady whine (blade-passing tones) over broadband
//   roar and the deep hum of the generators.
// - Everywhere: a pump with its slow thump-and-swoosh, metal clanks that
//   ring like the steel around them (inharmonic modes; modal synthesis, van
//   den Doel and Pai 1998) and a bright, hard feedback-delay-network room.

import { setup, stereo, finish, clamp, dB, wander, noisePair, noise, norm, addTo, bq, engine, oscInto, SINE, harmonicTable, addModes, addBurst, eventTimes, Fdn } from './car-highway.js'

const ROOMS = {
  small: { size: 1, rt60: 1.0, damp: 0.25, wet: 0.25 },
  large: { size: 2.4, rt60: 2.2, damp: 0.25, wet: 0.35 },
}

const bed = {
  id: 'engine-room',
  name: 'Engine room',
  group: 'vehicles',
  about: 'Deep in an engine room: huge machinery pounding in a steel hall, steam hissing, a pump and clanking tools.',
  params: [
    { id: 'intensity', name: 'How hard it works', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [30, 90] },
    {
      id: 'machine',
      name: 'Machinery',
      type: 'choice',
      def: 'diesel',
      options: [
        { v: 'diesel', name: 'A big ship diesel' },
        { v: 'steam', name: 'An old steam engine' },
        { v: 'turbine', name: 'Power station turbines' },
      ],
    },
    { id: 'steam', name: 'Steam hiss', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [0, 80] },
    { id: 'clanks', name: 'Clanks and tools', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 80] },
    {
      id: 'size',
      name: 'Room',
      type: 'choice',
      def: 'large',
      options: [
        { v: 'small', name: 'A cramped compartment' },
        { v: 'large', name: 'A big steel hall' },
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
    const room = ROOMS[q.size] || ROOMS.large
    const load = wander(n, SR, 0.08, r.fork('load'))
    const M = new Float32Array(n)

    if (q.machine === 'diesel') {
      const rpm = new Float32Array(n)
      const base = 560 + 260 * k
      for (let i = 0; i < n; i++) rpm[i] = base * (1 + 0.008 * load[i])
      const e = engine(n, SR, rpm, { cyl: 8, pulseHz: 140, pulseQ: 1.5, rough: 0.07, knock: 0.9, knockHz: 1900, knockMs: 2.5, res: [[70, 2, 5], [260, 3, 3]] }, r.fork('engine'))
      addTo(M, e, dB(0 + 3 * k))
      // turbocharger whine and the generators
      const f = new Float32Array(n)
      for (let i = 0; i < n; i++) f[i] = (2800 + 1400 * k) * (1 + 0.01 * load[i])
      oscInto(M, SR, f, dB(-28 + 6 * k), SINE, 0, 1)
      oscInto(M, SR, 60, dB(-16), harmonicTable([1, 0.6, 0.35, 0.15]), 0, 4)
    } else if (q.machine === 'steam') {
      const rev = 1.1 + 0.9 * k // turns per second
      let t = r.range(0, 0.3)
      let j = 0
      while (t < dur) {
        const i0 = Math.round(t * SR)
        const a = (j % 2 ? 0.8 : 1) * r.range(0.85, 1.1)
        addBurst(L, R, i0, SR, r, { amp: 0.9 * a, pan: j % 4 < 2 ? -0.3 : 0.3, attack: 0.012, hold: 0.04, tau: 0.09, f: 1100, q: 0.6 })
        addBurst(L, R, i0, SR, r, { amp: 0.7 * a, pan: 0, attack: 0.01, tau: 0.08, f: 180, q: 0.8, type: 'lowpass' })
        if (j % 4 === 0) {
          // the valve gear: a click and a clank once a turn
          addModes(L, R, i0 + Math.round(0.1 * SR), SR, [[r.range(900, 1100), 0.05, 1], [r.range(2400, 2700), 0.03, 0.6], [r.range(4100, 4600), 0.015, 0.3]], 0.25, 0.4, r)
          addModes(L, R, i0 + Math.round(0.28 * SR), SR, [[r.range(300, 360), 0.08, 1], [r.range(820, 900), 0.05, 0.5]], 0.35, -0.4, r)
        }
        t += 1 / (rev * 4) * r.range(0.97, 1.03)
        j++
      }
      // the flywheel and crank: a low rumble swelling once a turn
      const fw = new Float32Array(n)
      oscInto(fw, SR, rev, 1, SINE, 0, 1)
      const rb = noise(n, r.fork('rumble'), 'brown')
      bq(rb, SR, 'lowpass', 120, 0.7)
      norm(rb, 1)
      for (let i = 0; i < n; i++) M[i] += rb[i] * 0.2 * (1 + 0.5 * fw[i])
    } else {
      // turbines: blade-passing whine over a roar, generators humming
      const [tl, tr] = noisePair(n, r.fork('roar'), 'pink', 0.6)
      for (const sig of [tl, tr]) {
        bq(sig, SR, 'bandpass', 900, 0.4)
        norm(sig, 1)
      }
      addTo(L, tl, 0.6)
      addTo(R, tr, 0.6)
      const f1 = r.range(1700, 1900) * (0.9 + 0.2 * k)
      oscInto(M, SR, f1, dB(-20 + 4 * k), SINE, 0, 1)
      oscInto(M, SR, f1 * 2.02, dB(-27 + 4 * k), SINE, 0, 1)
      oscInto(M, SR, f1 * 0.5, dB(-24), SINE, 0, 1)
      oscInto(M, SR, 60, dB(-10), harmonicTable([1, 0.5, 0.4, 0.2, 0.1]), 0, 5)
    }
    // the deep room rumble every machine space has
    {
      const [bl, br] = noisePair(n, r.fork('deep'), 'brown', 0.5)
      for (const sig of [bl, br]) {
        bq(sig, SR, 'lowpass', 150, 0.7)
        norm(sig, 1)
      }
      addTo(L, bl, 0.25)
      addTo(R, br, 0.25)
    }
    // a pump: thump and swoosh
    {
      const per = r.range(1.1, 1.7)
      let t = r.range(0, per)
      while (t < dur) {
        const i0 = Math.round(t * SR)
        addModes(L, R, i0, SR, [[r.range(55, 65), 0.07, 1], [r.range(130, 150), 0.04, 0.4]], 0.6, 0.6, r)
        addBurst(L, R, i0 + Math.round(per * 0.4 * SR), SR, r, { amp: 0.35, pan: 0.6, attack: 0.15, hold: 0.1, tau: 0.15, f: 700, q: 0.6 })
        t += per * r.range(0.99, 1.01)
      }
    }
    // steam leaks
    const st = q.steam / 100
    if (st > 0) {
      const [hl, hr] = noisePair(n, r.fork('leak'), 'white', 0.4)
      const fl = wander(n, SR, 0.4, r.fork('fl'))
      for (const sig of [hl, hr]) {
        bq(sig, SR, 'highpass', 2500, 0.707)
        bq(sig, SR, 'peak', 5500, 1.5, 4)
        norm(sig, 1)
      }
      const g = dB(-24 + 10 * st)
      for (let i = 0; i < n; i++) {
        const e = 0.7 + 0.3 * fl[i]
        L[i] += hl[i] * g * e
        R[i] += hr[i] * g * (1.4 - e)
      }
      for (const t of eventTimes(0.04 + 0.12 * st, dur, r.fork('vent'), 3)) {
        addBurst(L, R, Math.round(t * SR), SR, r, { amp: 0.4 + 0.5 * st, pan: r.range(-0.8, 0.8), attack: 0.05, hold: r.range(0.4, 1.5), tau: 0.4, f: 4200, q: 0.5 })
      }
    }
    // clanks: tools, hatches, a wrench on a pipe
    const cl = q.clanks / 100
    for (const t of eventTimes(0.04 + 0.3 * cl, dur, r.fork('clank'), 0.8)) {
      const i0 = Math.round(t * SR)
      const pan = r.range(-0.9, 0.9)
      const f = r.range(380, 1400)
      const a = (0.25 + 0.5 * cl) * r.range(0.5, 1)
      addModes(L, R, i0, SR, [[f, 0.25, 1], [f * 2.32, 0.15, 0.6], [f * 3.87, 0.09, 0.4], [f * 5.61, 0.05, 0.25]], a, pan, r)
      addBurst(L, R, i0, SR, r, { amp: a * 0.6, pan, tau: 0.002, f: 3000, q: 0.6 })
      if (r.next() < 0.3) addModes(L, R, i0 + Math.round(r.range(0.1, 0.25) * SR), SR, [[f * 1.1, 0.2, 1], [f * 2.6, 0.1, 0.5]], a * 0.5, pan, r)
    }
    addTo(L, M, 1)
    addTo(R, M, 0.95)
    new Fdn(SR, { size: room.size, rt60: room.rt60, damp: room.damp, predelayMs: 8 + 8 * room.size }).process(L, R, room.wet, 1)
    return finish(L, R, SR, -21 + (k - 0.55) * 8, -16)
  },
}

export default bed
