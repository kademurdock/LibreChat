// beds/music-box-broken.js - An old music box, slightly broken, playing a sad waltz.
//
// Technique: a music box is a steel comb whose tines are plucked by pins on
// a turning cylinder. Each tine is a clamped-free bar, so besides its note it
// rings with inharmonic partials near 6.27 and 17.55 times the fundamental
// that die quickly (Fletcher and Rossing, "The Physics of Musical
// Instruments", the vibrating-bar chapter); the note itself rings for
// seconds, low tines longest. Every note is that set of decaying modes
// (modal synthesis, van den Doel and Pai 1998) plus the tick of the pin
// letting go, through the little wooden box's body resonances and a room.
// The tempo comes from a spring under a fan-fly governor, so it flutters a
// little and slows as the spring runs down; when it nearly stops, someone
// winds it again (the ratchet's clicks) and it starts up at full speed.
// Broken, by degrees: a missing tine or two (the pin just thunks), some
// tines out of tune, a damper that buzzes against a ringing tine, and now
// and then the cylinder catching so a note comes late. The tune is an
// original waltz in A minor written for this bed: sixteen bars of melody
// over a bass note and two chord tones in each bar.

import { setup, stereo, finish, clamp, dB, wander, noisePair, norm, addTo, bq, addModes, addBurst, addAir, Fdn } from './car-highway.js'

// [bar, beat, midi, beats] — melody, original
const MELODY = [
  [0, 0, 76, 2], [0, 2, 72, 1],
  [1, 0, 71, 1], [1, 1, 72, 1], [1, 2, 69, 1],
  [2, 0, 68, 2], [2, 2, 71, 1],
  [3, 0, 64, 3],
  [4, 0, 76, 2], [4, 2, 77, 1],
  [5, 0, 76, 1], [5, 1, 74, 1], [5, 2, 72, 1],
  [6, 0, 71, 1], [6, 1, 69, 1], [6, 2, 68, 1],
  [7, 0, 69, 3],
  [8, 0, 72, 2], [8, 2, 76, 1],
  [9, 0, 79, 2], [9, 2, 77, 1],
  [10, 0, 76, 1], [10, 1, 74, 1], [10, 2, 72, 1],
  [11, 0, 74, 3],
  [12, 0, 77, 2], [12, 2, 76, 1],
  [13, 0, 74, 1], [13, 1, 72, 1], [13, 2, 71, 1],
  [14, 0, 72, 1], [14, 1, 71, 1], [14, 2, 68, 1],
  [15, 0, 69, 3],
]
// per bar: bass note and the two chord tones on beats two and three
const HARMONY = [
  [57, 60, 64], [57, 60, 64], [52, 59, 64], [52, 59, 68],
  [57, 60, 64], [57, 60, 65], [52, 59, 64], [57, 60, 64],
  [48, 60, 64], [55, 59, 62], [57, 60, 64], [55, 59, 62],
  [50, 62, 65], [50, 62, 65], [52, 59, 64], [57, 60, 64],
]

function hz(m) {
  // the comb sits an octave above the written notes, where music boxes sing
  return 880 * Math.pow(2, (m - 69) / 12)
}

const bed = {
  id: 'music-box-broken',
  name: 'Broken music box',
  group: 'spooky',
  about: 'An old music box playing a sad little waltz, out of tune, missing notes, running down and wound again.',
  params: [
    { id: 'intensity', name: 'How loud', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [30, 85] },
    { id: 'broken', name: 'How broken', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'tempo', name: 'Tempo', type: 'number', min: 50, max: 160, step: 1, def: 104, unit: 'bpm', rand: [80, 130] },
    { id: 'winding', name: 'Runs down and is wound again', type: 'bool', def: true },
    {
      id: 'size',
      name: 'Room',
      type: 'choice',
      def: 'room',
      options: [
        { v: 'close', name: 'In your hands' },
        { v: 'room', name: 'An attic room' },
        { v: 'hall', name: 'An empty hall' },
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
    const br = q.broken / 100
    const k = q.intensity / 100

    // this box's faults, fixed for the seed: missing, detuned and buzzing tines
    const fault = new Map()
    const tines = new Set()
    for (const m of MELODY) tines.add(m[2])
    for (const h of HARMONY) for (const x of h) tines.add(x)
    for (const t of tines) {
      const f = { cents: r.gauss() * 6 * br, missing: false, buzz: false }
      if (r.next() < 0.3 * br) f.cents += r.sign() * r.range(25, 60) * br
      if (r.next() < 0.12 * br) f.missing = true
      if (r.next() < 0.15 * br) f.buzz = true
      fault.set(t, f)
    }
    const body = [[520, 0.02, 1], [1250, 0.012, 0.6], [2300, 0.006, 0.3]]

    const pluck = (t, midi, vel, pan) => {
      const f = fault.get(midi) || { cents: 0, missing: false, buzz: false }
      const i0 = Math.round(t * SR)
      if (f.missing && r.next() < 0.85) {
        // the pin hits a broken stub: a dull tick
        addModes(L, R, i0, SR, [[r.range(900, 1400), 0.008, 1]], 0.12 * vel, pan, r)
        return
      }
      const f0 = hz(midi) * Math.pow(2, f.cents / 1200)
      const tau = clamp(2.3 * Math.sqrt(440 / f0), 0.5, 3)
      const modes = [[f0, tau, 1], [f0 * 2.0, tau * 0.3, 0.07], [f0 * 6.27, tau * 0.06, 0.22], [f0 * 17.55, 0.03, 0.08], [f0 * 1.0015, tau * 0.45, 0.25]]
      addModes(L, R, i0, SR, modes, 0.3 * vel, pan, r)
      // the pin's tick and a puff of the box
      addBurst(L, R, i0, SR, r, { amp: 0.06 * vel, pan, tau: 0.0005, f: 6000, q: 0.7 })
      addModes(L, R, i0, SR, body, 0.03 * vel, pan, r)
      if (f.buzz && r.next() < 0.7) {
        // a damper chattering on the ringing tine
        const bl = Math.round(r.range(0.08, 0.2) * SR)
        const rate = r.range(28, 55)
        for (let j = 0; j < 8; j++) {
          const tt = i0 + Math.round((j / rate) * SR)
          if (tt > i0 + bl) break
          addBurst(L, R, tt, SR, r, { amp: 0.05 * vel * (1 - j / 8), pan, tau: 0.002, f: f0 * 2, q: 3 })
        }
      }
    }

    // spring and governor: tempo multiplier over time, with rewinds
    const beatsPerBar = 3
    const bars = 16
    const tuneBeats = bars * beatsPerBar
    const flutter = wander(n, SR, 0.9, r.fork('gov'))
    let spring = q.winding ? r.range(0.45, 1) : 1 // how wound it is, 1 = full
    let t = r.range(0.1, 0.4)
    let beat = r.int(tuneBeats) // start somewhere in the tune
    beat -= beat % beatsPerBar
    const notesAt = new Map()
    for (const m of MELODY) {
      const key = m[0] * beatsPerBar + m[1]
      if (!notesAt.has(key)) notesAt.set(key, [])
      notesAt.get(key).push(m)
    }
    const fly = new Float32Array(n) // governor speed, for the whir
    while (t < dur) {
      const sp = q.winding ? 0.55 + 0.45 * Math.sqrt(spring) : 1
      const bpm = q.tempo * sp * (1 + 0.025 * flutter[Math.min(n - 1, Math.round(t * SR))])
      const bl = 60 / bpm
      const pos = beat % tuneBeats
      const bar = Math.floor(pos / beatsPerBar)
      const inBar = pos % beatsPerBar
      const late = r.next() < 0.04 * br ? r.range(0.06, 0.18) : 0
      const harm = HARMONY[bar]
      if (inBar === 0) pluck(t + late, harm[0], 0.75 * r.range(0.9, 1.05), -0.25)
      else {
        pluck(t + 0.004 + late, harm[1], 0.42 * r.range(0.85, 1.05), 0.2)
        pluck(t + 0.009 + late, harm[2], 0.38 * r.range(0.85, 1.05), 0.3)
      }
      const ms = notesAt.get(pos)
      if (ms) for (const m of ms) pluck(t + late, m[2], r.range(0.9, 1.05), 0)
      // the fly turns while the tune plays
      const i0 = Math.round(t * SR)
      const i1 = Math.min(n, Math.round((t + bl) * SR))
      for (let i = i0; i < i1; i++) fly[i] = sp
      t += bl
      beat++
      if (q.winding) {
        spring -= 0.011 * (1 + 0.5 * br)
        if (spring < 0.08) {
          // it stops; a moment later someone winds it
          const pause = r.range(0.8, 2)
          const winds = 8 + r.int(8)
          let tw = t + pause
          for (let w = 0; w < winds; w++) {
            const iw = Math.round(tw * SR)
            addModes(L, R, iw, SR, [[r.range(2500, 3200), 0.006, 1], [r.range(5200, 6500), 0.003, 0.6], [r.range(700, 900), 0.012, 0.4]], 0.12, 0.1, r)
            addBurst(L, R, iw, SR, r, { amp: 0.08, pan: 0.1, tau: 0.001, f: 4000, q: 0.6 })
            tw += r.range(0.12, 0.17) * (w % 2 ? 1.25 : 1)
          }
          t = tw + r.range(0.3, 0.8)
          spring = 1
        }
      }
    }
    // the governor's soft whir
    {
      const [wl, wr] = noisePair(n, r.fork('whir'), 'pink', 0.8)
      for (const sig of [wl, wr]) {
        bq(sig, SR, 'bandpass', 1400, 1.5)
        norm(sig, 1)
      }
      const g = dB(-46 + 6 * br)
      for (let i = 0; i < n; i++) {
        const e = fly[i]
        L[i] += wl[i] * g * e
        R[i] += wr[i] * g * e
      }
    }
    const room = q.size === 'hall' ? { size: 2.3, rt60: 2.4, damp: 0.35, wet: 0.4 } : q.size === 'close' ? { size: 0.4, rt60: 0.3, damp: 0.5, wet: 0.06 } : { size: 1, rt60: 0.9, damp: 0.5, wet: 0.22 }
    bq(L, SR, 'highpass', 120, 0.707)
    bq(R, SR, 'highpass', 120, 0.707)
    new Fdn(SR, { size: room.size, rt60: room.rt60, damp: room.damp, predelayMs: 6 + 8 * room.size }).process(L, R, room.wet, 1)
    addAir(L, R, SR, r.fork('air'), 0.0008)
    return finish(L, R, SR, -24 + (k - 0.55) * 10, -24)
  },
}

export default bed
