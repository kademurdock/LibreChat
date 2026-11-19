// beds/spaceship-bridge.js - The bridge of a starship: the engines' deep drone,
// air handling, consoles chirping and beeping, and an alert when you want one.
//
// Techniques and sources: the drone is additive synthesis, a few low sine
// partials in near-unison pairs so they beat slowly (the classic film
// sound-design way to make a hum feel alive), over air-handling noise and a
// faint power hum, with a slow "breathing" swell. Console sounds are short
// sine and square blips, quick glides and trills drawn from a small set of
// pitches, scheduled as Poisson events from several stations around the
// room (left, right, ahead), so the room never repeats. The alert choices
// are a soft repeating two-tone pulse and a rising siren whoop heard from
// the corridors. The room is the shared feedback delay network; a bigger
// ship has a lower drone and a longer, wider room.

import { setup, stereo, finish, clamp, dB, wander, noisePair, norm, addTo, bq, oscInto, harmonicTable, SINE, addTone, eventTimes, Fdn } from './car-highway.js'

const SQ = harmonicTable([1, 0, 0.33, 0, 0.2, 0, 0.14, 0, 0.11])
const SOFT = harmonicTable([1, 0.2, 0.05])
const NOTES = [1046.5, 1174.7, 1318.5, 1568, 1760, 2093, 2349.3, 2637]

const SIZES = {
  shuttle: { drone: 1.35, size: 0.7, rt60: 0.5, wet: 0.12 },
  cruiser: { drone: 1, size: 1.4, rt60: 0.9, wet: 0.18 },
  flagship: { drone: 0.75, size: 2.4, rt60: 1.6, wet: 0.25 },
}

const bed = {
  id: 'spaceship-bridge',
  name: 'Spaceship bridge',
  group: 'vehicles',
  about: 'On the bridge of a starship: a deep engine drone, air humming, consoles chirping and beeping.',
  params: [
    { id: 'intensity', name: 'How loud', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [30, 85] },
    { id: 'hum', name: 'Engine drone', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [30, 90] },
    { id: 'beeps', name: 'Console beeps', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    {
      id: 'alert',
      name: 'Alert',
      type: 'choice',
      def: 'off',
      options: [
        { v: 'off', name: 'All calm' },
        { v: 'soft', name: 'A soft warning pulse' },
        { v: 'siren', name: 'Full alarm' },
      ],
    },
    {
      id: 'size',
      name: 'Ship',
      type: 'choice',
      def: 'cruiser',
      options: [
        { v: 'shuttle', name: 'A small shuttle' },
        { v: 'cruiser', name: 'A cruiser' },
        { v: 'flagship', name: 'A giant flagship' },
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
    const ship = SIZES[q.size] || SIZES.cruiser
    const hum = q.hum / 100

    // the drone: beating low partials with a slow breath
    if (hum > 0) {
      const base = r.range(38, 46) * ship.drone
      const breath = wander(n, SR, 0.12, r.fork('breath'))
      const amp = new Float32Array(n)
      const g = dB(-6 + 6 * hum)
      for (let i = 0; i < n; i++) amp[i] = g * (0.85 + 0.15 * breath[i])
      const parts = [[1, 1], [1.5, 0.5], [2, 0.55], [3, 0.22], [4.02, 0.12], [6.01, 0.05]]
      for (const [ratio, a] of parts) {
        const beat = r.range(0.07, 0.35)
        const al = new Float32Array(n)
        for (let i = 0; i < n; i++) al[i] = amp[i] * a * 0.5
        oscInto(L, SR, base * ratio, al, SINE, r.next(), 1)
        oscInto(R, SR, base * ratio + beat, al, SINE, r.next(), 1)
        oscInto(L, SR, base * ratio + beat * 0.5, al, SINE, r.next(), 1)
        oscInto(R, SR, base * ratio - beat * 0.3, al, SINE, r.next(), 1)
      }
      // power hum
      oscInto(L, SR, 120, g * 0.06, harmonicTable([1, 0.4, 0.2]), 0, 3)
      oscInto(R, SR, 120.3, g * 0.06, harmonicTable([1, 0.4, 0.2]), 0.5, 3)
    }
    // air handling
    {
      const [al, ar] = noisePair(n, r.fork('air'), 'pink', 0.3)
      for (const sig of [al, ar]) {
        bq(sig, SR, 'bandpass', 600, 0.5)
        bq(sig, SR, 'lowpass', 3000, 0.707)
        norm(sig, 1)
      }
      const g = dB(-24 + 8 * hum)
      addTo(L, al, g)
      addTo(R, ar, g)
    }
    // the consoles: each station has a voice and its own habits
    const bp = q.beeps / 100
    if (bp > 0) {
      const stations = [{ pan: -0.75 }, { pan: -0.3 }, { pan: 0.35 }, { pan: 0.8 }, { pan: 0.05 }]
      const bg = 0.45 * (0.5 + 0.7 * bp)
      for (const st of stations) {
        const set = [r.pick(NOTES), r.pick(NOTES), r.pick(NOTES)]
        const table = r.next() < 0.5 ? SINE : SQ
        const maxH = table === SQ ? 9 : 1
        for (const t of eventTimes(0.12 + 0.6 * bp, dur, r.fork('st' + st.pan), 0.3)) {
          const kind = r.next()
          const i0 = Math.round(t * SR)
          if (kind < 0.45) {
            // a run of blips
            const c = 1 + r.int(4)
            for (let j = 0; j < c; j++) {
              addTone(L, R, i0 + Math.round(j * 0.09 * SR), SR, { f: r.pick(set), attack: 0.003, hold: r.range(0.03, 0.06), tau: 0.012, amp: bg * (table === SQ ? 0.4 : 1), pan: st.pan, table, maxHarm: maxH })
            }
          } else if (kind < 0.7) {
            // a chirp up or down
            const f0 = r.range(700, 1400)
            const up = r.next() < 0.6
            addTone(L, R, i0, SR, { f: (x) => f0 * (up ? 1 + x * 14 : 2.4 - x * 14), attack: 0.004, hold: 0.07, tau: 0.015, amp: bg * 0.8, pan: st.pan })
          } else if (kind < 0.88) {
            // a data trill
            const a = r.pick(set)
            const b = a * r.pick([1.122, 1.26, 1.335])
            for (let j = 0; j < 6 + r.int(8); j++) {
              addTone(L, R, i0 + Math.round(j * 0.035 * SR), SR, { f: j % 2 ? a : b, attack: 0.002, hold: 0.02, tau: 0.006, amp: bg * 0.6, pan: st.pan })
            }
          } else {
            // an acknowledgement: two soft rising notes
            const a = r.pick([880, 987.8, 1046.5])
            addTone(L, R, i0, SR, { f: a, attack: 0.01, hold: 0.08, tau: 0.12, amp: bg * 0.9, pan: st.pan, table: SOFT, maxHarm: 3 })
            addTone(L, R, i0 + Math.round(0.13 * SR), SR, { f: a * 1.5, attack: 0.01, hold: 0.1, tau: 0.2, amp: bg * 0.9, pan: st.pan, table: SOFT, maxHarm: 3 })
          }
        }
      }
    }
    // alerts
    if (q.alert === 'soft') {
      let t = r.range(0.3, 1.5)
      while (t < dur) {
        addTone(L, R, Math.round(t * SR), SR, { f: 660, attack: 0.06, hold: 0.25, tau: 0.15, amp: 0.25, pan: 0, table: SOFT, maxHarm: 3 })
        addTone(L, R, Math.round((t + 0.45) * SR), SR, { f: 495, attack: 0.06, hold: 0.25, tau: 0.2, amp: 0.25, pan: 0, table: SOFT, maxHarm: 3 })
        t += 2.6
      }
    } else if (q.alert === 'siren') {
      let t = r.range(0.2, 0.8)
      while (t < dur) {
        addTone(L, R, Math.round(t * SR), SR, { f: (x) => 420 + 520 * Math.min(1, x / 0.7), attack: 0.04, hold: 0.65, tau: 0.08, amp: 0.3, pan: r.range(-0.2, 0.2), table: SQ, maxHarm: 9 })
        t += 1.25
      }
    }
    new Fdn(SR, { size: ship.size, rt60: ship.rt60, damp: 0.4, predelayMs: 6 + 6 * ship.size }).process(L, R, ship.wet, 1)
    return finish(L, R, SR, -23 + (k - 0.55) * 8, -14)
  },
}

export default bed
