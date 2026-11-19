// beds/airplane-cabin.js - In an airliner's cabin at cruise: the steady roar,
// the engines' slow beating, air vents, and the cabin chime.
//
// Techniques and sources:
// - Cruise cabin noise is dominated by the turbulent boundary layer over
//   the fuselage, a smooth broadband roar peaking in the low hundreds of
//   hertz and falling steeply above about 1 kHz through the insulation
//   (Wilby, "Aircraft interior noise", Journal of Sound and Vibration 190,
//   1996). Engine noise adds low-frequency rumble and tones at the fan
//   shaft rate; two engines a fraction of a hertz apart beat slowly
//   (the "wow-wow" every few seconds that passengers hear). Seats near the
//   back are louder and lower (jet exhaust and fan noise), seats at the front
//   hiss more (boundary layer at the nose).
// - The air vents are a soft high hiss; turbulence bumps the airframe (low
//   thumps), swells the roar and rattles the galley and the trolleys.
// - The cabin chime is a soft two-note ding-dong (or a single ding) made of
//   decaying sinusoids with a few partials (modal synthesis, van den Doel and
//   Pai 1998), with the cabin's small reverb.

import { setup, stereo, finish, clamp, dB, wander, noisePair, norm, addTo, bq, oscInto, harmonicTable, addModes, addBurst, eventTimes, Fdn } from './car-highway.js'

const FAN = harmonicTable([1, 0.5, 0.33, 0.2, 0.14, 0.1])

const SEATS = {
  front: { roarHz: 520, roarQ: 0.5, hiss: 3, eng: -10, low: -2 },
  wing: { roarHz: 380, roarQ: 0.55, hiss: 0, eng: -5, low: 0 },
  back: { roarHz: 280, roarQ: 0.6, hiss: -2, eng: -1, low: 3 },
}

const bed = {
  id: 'airplane-cabin',
  name: 'Airplane cabin',
  group: 'vehicles',
  about: 'Seated on an airliner at cruise: the steady roar, slow beating engines, air vents and the cabin chime.',
  params: [
    { id: 'intensity', name: 'How loud', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [30, 85] },
    {
      id: 'seat',
      name: 'Seat',
      type: 'choice',
      def: 'wing',
      options: [
        { v: 'front', name: 'Near the front' },
        { v: 'wing', name: 'Over the wing' },
        { v: 'back', name: 'At the back, by the engines' },
      ],
    },
    { id: 'chimes', name: 'Cabin chimes', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [0, 70] },
    { id: 'turbulence', name: 'Turbulence', type: 'number', min: 0, max: 100, step: 1, def: 15, unit: 'percent', rand: [0, 60] },
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
    const seat = SEATS[q.seat] || SEATS.wing
    const tb = q.turbulence / 100

    // turbulence: a slow random bumpiness that swells the roar
    const bump = wander(n, SR, 0.7 + 1.5 * tb, r.fork('bump'))
    const slow = wander(n, SR, 0.08, r.fork('slow'))
    const swell = new Float32Array(n)
    for (let i = 0; i < n; i++) swell[i] = 1 + 0.03 * slow[i] + tb * 0.18 * bump[i]

    // the roar
    const [al, ar] = noisePair(n, r.fork('roar'), 'pink', 0.55)
    for (const sig of [al, ar]) {
      bq(sig, SR, 'bandpass', seat.roarHz, seat.roarQ)
      bq(sig, SR, 'lowshelf', 120, 0.707, 4 + seat.low)
      bq(sig, SR, 'lowpass', 1800, 0.707)
      bq(sig, SR, 'lowpass', 2400, 0.707)
      norm(sig, 1)
    }
    const [bl, br] = noisePair(n, r.fork('rumble'), 'brown', 0.7)
    for (const sig of [bl, br]) {
      bq(sig, SR, 'lowpass', 110, 0.7)
      norm(sig, 1)
    }
    const gLow = dB(-6 + seat.low)
    for (let i = 0; i < n; i++) {
      L[i] += (al[i] + bl[i] * gLow) * swell[i]
      R[i] += (ar[i] + br[i] * gLow) * swell[i]
    }
    // two engines, fan tones a fraction of a hertz apart: the slow beat
    {
      const f0 = r.range(78, 92)
      const beat = r.range(0.2, 0.6)
      const g = dB(-20 + seat.eng)
      const fl = new Float32Array(n)
      const fr = new Float32Array(n)
      const dw = wander(n, SR, 0.05, r.fork('fan'))
      for (let i = 0; i < n; i++) {
        fl[i] = f0 * (1 + 0.002 * dw[i])
        fr[i] = (f0 + beat) * (1 - 0.002 * dw[i])
      }
      const tl = new Float32Array(n)
      const tr = new Float32Array(n)
      oscInto(tl, SR, fl, g, FAN, r.next(), 6)
      oscInto(tr, SR, fr, g, FAN, r.next(), 6)
      for (let i = 0; i < n; i++) {
        const a = tl[i] * 0.8 + tr[i] * 0.55
        const b = tr[i] * 0.8 + tl[i] * 0.55
        L[i] += a
        R[i] += b
      }
    }
    // air vents above the seat
    {
      const [vl, vr] = noisePair(n, r.fork('vent'), 'white', 0.3)
      for (const sig of [vl, vr]) {
        bq(sig, SR, 'highpass', 2500, 0.707)
        bq(sig, SR, 'lowpass', 9000, 0.707)
        norm(sig, 1)
      }
      const g = dB(-24 + seat.hiss)
      addTo(L, vl, g)
      addTo(R, vr, g * 0.8)
    }
    // turbulence bumps and rattles
    if (tb > 0) {
      for (const t of eventTimes(0.05 + 0.6 * tb, dur, r.fork('jolt'), 0.6)) {
        const i0 = Math.round(t * SR)
        const a = (0.5 + 1.2 * tb) * r.range(0.5, 1)
        addModes(L, R, i0, SR, [[r.range(30, 45), 0.12, 1], [r.range(70, 95), 0.07, 0.5]], a, r.range(-0.3, 0.3), r)
        // something in the galley rattles
        if (r.next() < 0.6) {
          let tt = t + 0.02
          const f = r.range(900, 2200)
          const pan = r.range(-0.8, 0.8)
          for (let h = 0; h < 3 + r.int(7); h++) {
            addModes(L, R, Math.round(tt * SR), SR, [[f * r.range(0.95, 1.05), 0.015, 1], [f * 2.7, 0.008, 0.5]], 0.12 * a, pan)
            tt += r.range(0.03, 0.07)
          }
        }
      }
    }
    // the cabin chime
    const ch = q.chimes / 100
    if (ch > 0) {
      const CH = [[1, 0.9, 1], [2.0, 0.45, 0.18], [3.01, 0.25, 0.06]]
      for (const t of eventTimes(0.015 + 0.06 * ch, dur - 1.5, r.fork('chime'), 6, -0.5)) {
        if (t < 0) continue
        const hi = r.range(1150, 1250)
        const two = r.next() < 0.6
        const notes = two ? [hi, hi * 0.794] : [hi]
        notes.forEach((f, j) => {
          const modes = CH.map(([ratio, tau, g]) => [f * ratio, tau, g])
          addModes(L, R, Math.round((t + j * 0.62) * SR), SR, modes, 2.2, 0.1, r)
        })
      }
    }
    // overhead bins, a seatbelt buckle now and then
    for (const t of eventTimes(0.03, dur, r.fork('cabin'), 5)) {
      const i0 = Math.round(t * SR)
      const pan = r.range(-0.9, 0.9)
      if (r.next() < 0.5) {
        addModes(L, R, i0, SR, [[r.range(110, 140), 0.05, 1], [r.range(340, 420), 0.03, 0.6], [r.range(1100, 1400), 0.01, 0.3]], 0.35, pan, r)
        addBurst(L, R, i0, SR, r, { amp: 0.25, pan, tau: 0.01, f: 600, q: 0.7 })
      } else {
        addModes(L, R, i0, SR, [[r.range(2600, 3200), 0.006, 1], [r.range(5200, 6200), 0.003, 0.5]], 0.15, pan)
      }
    }
    new Fdn(SR, { size: 0.7, rt60: 0.35, damp: 0.7, predelayMs: 4 }).process(L, R, 0.12, 1)
    return finish(L, R, SR, -22 + (k - 0.55) * 8, -8)
  },
}

export default bed
