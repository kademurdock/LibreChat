// beds/dungeon.js - A stone dungeon: water dripping, chains shifting, far groans.
//
// Techniques and sources: drips are Minnaert bubble resonances that rise in
// pitch as they ring (van den Doel, "Physically based models for liquid
// sounds", ACM TAP 2005), from a few fixed leaks that each keep their own
// slow, slightly wandering rhythm, as real leaks do; chains are runs of
// inharmonic link impacts with a drag scrape (modal synthesis, van den Doel
// and Pai 1998); groans are the formant-filtered moans of
// beds/haunted-house.js pitched low with more voice in them; a heavy iron
// door booms far off now and then; rats squeak in quick high bunches. The
// stone room is the shared feedback delay network with little damping
// (hard wet stone keeps its highs).

import { setup, stereo, finish, clamp, noisePair, norm, addTo, bq, eventTimes, addModes, addBurst, addTone, Fdn } from './car-highway.js'
import { addDrip, addChain, addMoan, addCreak, METAL } from './haunted-house.js'

const ROOMS = {
  cell: { size: 0.7, rt60: 1.3, damp: 0.25, wet: 0.28 },
  vault: { size: 1.8, rt60: 2.6, damp: 0.3, wet: 0.38 },
  catacomb: { size: 3.2, rt60: 4.2, damp: 0.35, wet: 0.48 },
}

const bed = {
  id: 'dungeon',
  name: 'Dungeon',
  group: 'spooky',
  about: 'Deep under a castle: water dripping on stone, chains shifting, far groans and an iron door.',
  params: [
    { id: 'intensity', name: 'How much happens', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [25, 85] },
    { id: 'drips', name: 'Dripping water', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [20, 100] },
    { id: 'chains', name: 'Chains', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [0, 90] },
    { id: 'groans', name: 'Far groans', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [0, 80] },
    {
      id: 'size',
      name: 'Room',
      type: 'choice',
      def: 'vault',
      options: [
        { v: 'cell', name: 'A small cell' },
        { v: 'vault', name: 'A stone vault' },
        { v: 'catacomb', name: 'Long catacombs' },
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
    const act = q.intensity / 100
    const room = ROOMS[q.size] || ROOMS.vault
    const EL = new Float32Array(n)
    const ER = new Float32Array(n)

    // leaks: each has a place, a pitch range and its own slowly changing interval
    const dripAmt = q.drips / 100
    if (dripAmt > 0) {
      const leaks = 2 + Math.round(4 * dripAmt)
      for (let k = 0; k < leaks; k++) {
        const pan = r.range(-0.9, 0.9)
        const f = r.range(900, 2600)
        const amp = r.range(0.35, 1) * (0.5 + 0.5 * dripAmt)
        let per = r.range(0.7, 3.5) / (0.6 + 0.8 * dripAmt)
        let t = r.range(0, per)
        while (t < dur) {
          addDrip(EL, ER, Math.round(t * SR), SR, r, { f: f * r.range(0.9, 1.12), amp: amp * r.range(0.7, 1), pan, rise: r.range(18, 40) })
          per *= r.range(0.93, 1.08)
          per = clamp(per, 0.35, 5)
          t += per * r.range(0.85, 1.15)
        }
      }
    }
    // chains shifting
    const chainAmt = q.chains / 100
    if (chainAmt > 0) {
      for (const t of eventTimes(0.05 + 0.25 * chainAmt * (0.5 + act), dur, r.fork('chain'), 2.5)) {
        addChain(EL, ER, t, SR, r, { links: 3 + r.int(10), heavy: r.range(0.2, 1), amp: r.range(0.35, 0.8), pan: r.range(-0.8, 0.8), spread: r.range(0.04, 0.09), drag: 0.4 })
      }
    }
    // groans from far down the passages
    const groanAmt = q.groans / 100
    if (groanAmt > 0) {
      for (const t of eventTimes(0.015 + 0.06 * groanAmt, dur, r.fork('groan'), 5, -1)) {
        addMoan(EL, ER, Math.round(Math.max(0, t) * SR), SR, r, {
          dur: r.range(1.6, 3.6), f0: r.range(80, 130), glide: r.range(-4, 1), vowels: r.pick([['uh', 'oh', 'oo'], ['ah', 'oh'], ['oh', 'uh', 'oo']]),
          breath: r.range(0.3, 0.55), pan: r.range(-0.9, 0.9), dark: 900, q: 7, amp: 0.3 + 0.5 * groanAmt,
        })
      }
    }
    // an iron door, far off: hinge squeal, then the boom
    for (const t of eventTimes(0.006 + 0.02 * act, dur - 2, r.fork('door'), 12)) {
      const pan = r.range(-0.7, 0.7)
      addCreak(EL, ER, Math.round(t * SR), SR, r, { dur: r.range(0.6, 1.4), rate0: 40, peak: r.range(120, 260), rate1: 60, modes: METAL, jitter: 0.1, amp: 0.25, pan })
      const i0 = Math.round((t + r.range(1.2, 1.8)) * SR)
      addModes(EL, ER, i0, SR, [[r.range(48, 60), 0.25, 1], [r.range(95, 115), 0.16, 0.6], [r.range(420, 520), 0.3, 0.25], [r.range(1150, 1300), 0.2, 0.12]], 1.1, pan, r)
      addBurst(EL, ER, i0, SR, r, { amp: 0.6, pan, tau: 0.04, f: 220, q: 0.7, type: 'lowpass' })
    }
    // rats
    for (const t of eventTimes(0.01 + 0.04 * act, dur, r.fork('rats'), 4)) {
      const k = 2 + r.int(4)
      const pan = r.range(-0.9, 0.9)
      let tt = t
      for (let j = 0; j < k; j++) {
        const f = r.range(3200, 5200)
        const up = r.next() < 0.5
        addTone(EL, ER, Math.round(tt * SR), SR, { f: (x) => f * (up ? 1 + 6 * x : 1.15 - 5 * x), attack: 0.004, hold: r.range(0.02, 0.05), tau: 0.012, amp: 0.05, pan })
        tt += r.range(0.06, 0.16)
      }
    }
    new Fdn(SR, { size: room.size, rt60: room.rt60, damp: room.damp, predelayMs: 15, diffuse: 0.65 }).process(EL, ER, room.wet, 1)

    // the deep stillness of stone: a faint low rumble and air
    const [al, ar] = noisePair(n, r.fork('air'), 'brown', 0.4)
    bq(al, SR, 'lowpass', 160, 0.7)
    bq(ar, SR, 'lowpass', 160, 0.7)
    norm(al, 0.01)
    norm(ar, 0.01)
    addTo(L, al)
    addTo(R, ar)
    addTo(L, EL)
    addTo(R, ER)
    return finish(L, R, SR, -25 + (act - 0.5) * 4, -34)
  },
}

export default bed
