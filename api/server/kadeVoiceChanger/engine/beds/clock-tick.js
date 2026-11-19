// beds/clock-tick.js - A ticking clock in a quiet room.
//
// Technique: the anchor escapement makes two little impacts per beat (the
// escape-wheel tooth landing on the pallet, then the "drop" a few
// milliseconds later), alternating between the entry and exit pallets, so
// tick and tock differ in tone and the clock's beat error makes the two
// halves of each second slightly unequal (horology: Rawlings, "The Science
// of Clocks and Watches"). Each impact is a short broadband click plus the
// ringing of the movement's small brass parts and the wooden case's body
// modes (modal synthesis; van den Doel and Pai, "The sounds of physical
// shapes", 1998). Strikes, when on, are gong-rod chimes with the
// inharmonic partials of a clamped bar (ratios 1, 2.76, 5.40, 8.93; Fletcher
// and Rossing, "The Physics of Musical Instruments"). The room is the shared
// feedback delay network.

import { setup, stereo, finish, clamp, addModes, addBurst, addAir, Fdn } from './car-highway.js'

const CLOCKS = {
  watch: { rate: 5, metal: [[3900, 0.004, 1], [6100, 0.003, 0.7], [8700, 0.002, 0.4]], body: [[1800, 0.006, 0.4], [2600, 0.005, 0.3]], click: 6000, amp: 0.5, gong: 0 },
  mantel: { rate: 2.5, metal: [[2500, 0.008, 1], [4100, 0.006, 0.6], [6300, 0.004, 0.35]], body: [[480, 0.025, 0.6], [910, 0.018, 0.5], [1500, 0.012, 0.35]], click: 3500, amp: 0.8, gong: 330 },
  wall: { rate: 2, metal: [[2100, 0.01, 1], [3500, 0.007, 0.6], [5200, 0.005, 0.3]], body: [[310, 0.035, 0.7], [620, 0.025, 0.55], [1150, 0.016, 0.35]], click: 3000, amp: 0.9, gong: 260 },
  tall: { rate: 1, metal: [[1700, 0.012, 1], [2900, 0.009, 0.55], [4400, 0.006, 0.3]], body: [[140, 0.06, 1], [265, 0.045, 0.7], [430, 0.03, 0.5], [800, 0.02, 0.3]], click: 2500, amp: 1, gong: 147 },
}

const ROOMS = {
  close: { size: 0.5, rt60: 0.35, damp: 0.6, wet: 0.08 },
  room: { size: 1, rt60: 0.7, damp: 0.5, wet: 0.22 },
  hall: { size: 2.2, rt60: 1.8, damp: 0.4, wet: 0.38 },
}

const bed = {
  id: 'clock-tick',
  name: 'Ticking clock',
  group: 'spooky',
  about: 'A clock ticking in a quiet room, from a pocket watch to a tall case clock that can strike the hour.',
  params: [
    {
      id: 'clock',
      name: 'Clock',
      type: 'choice',
      def: 'wall',
      options: [
        { v: 'watch', name: 'A pocket watch' },
        { v: 'mantel', name: 'A mantel clock' },
        { v: 'wall', name: 'A wall clock' },
        { v: 'tall', name: 'A tall case clock' },
      ],
    },
    { id: 'intensity', name: 'How loud it ticks', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [30, 85] },
    {
      id: 'size',
      name: 'Room',
      type: 'choice',
      def: 'room',
      options: [
        { v: 'close', name: 'Right beside it' },
        { v: 'room', name: 'A quiet room' },
        { v: 'hall', name: 'A big empty hall' },
      ],
    },
    { id: 'strike', name: 'Strikes the hour', type: 'bool', def: false },
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
    const ck = CLOCKS[q.clock] || CLOCKS.wall
    const room = ROOMS[q.size] || ROOMS.room
    const k = q.intensity / 100
    const pan = r.range(-0.35, 0.35)
    const per = 1 / ck.rate
    const beatErr = r.range(-0.035, 0.035) // tick and tock halves are not quite equal
    const metal = ck.metal.map((m) => [m[0] * r.range(0.95, 1.05), m[1], m[2]])
    const metal2 = ck.metal.map((m) => [m[0] * r.range(0.88, 0.97), m[1], m[2]])
    const body = ck.body.map((m) => [m[0] * r.range(0.95, 1.05), m[1], m[2]])
    let t = r.range(0.05, per)
    let beat = 0
    // a mechanical clock loses or gains a little as it runs: a slow drift
    let drift = 1 + r.range(-0.002, 0.002)
    while (t < dur) {
      const tock = beat % 2 === 1
      const a = ck.amp * (tock ? 0.82 : 1) * (1 + 0.05 * r.gauss())
      const i0 = Math.round(t * SR)
      const m = tock ? metal2 : metal
      // the lock: a click with the movement ringing
      addBurst(L, R, i0, SR, r, { amp: a * 0.5, pan, tau: 0.0007, f: ck.click, q: 0.7 })
      addModes(L, R, i0, SR, m, a * 0.35, pan, r)
      addModes(L, R, i0, SR, body, a * 0.4 * (tock ? 1.15 : 1), pan, r)
      // the drop a few milliseconds later, smaller
      const j0 = i0 + Math.round(r.range(0.003, 0.007) * SR)
      addBurst(L, R, j0, SR, r, { amp: a * 0.28, pan, tau: 0.0005, f: ck.click * 1.3, q: 0.8 })
      addModes(L, R, j0, SR, m, a * 0.15, pan, r)
      const half = per * (1 + (tock ? -beatErr : beatErr))
      t += half * drift + r.gauss() * 0.0002
      drift += r.gauss() * 0.00005
      beat++
    }
    // striking the hour (a few strokes somewhere in the middle of the take)
    if (q.strike && ck.gong > 0 && dur > 3) {
      const strokes = Math.max(1, Math.min(12, Math.floor((dur * 0.6) / 2.2), 1 + r.int(9)))
      let ts = clamp(r.range(0.2, 0.45) * dur, 0.5, Math.max(0.5, dur - strokes * 2.2))
      const f = ck.gong * r.range(0.96, 1.04)
      const rod = [[f, 3.2, 1], [f * 2.76, 1.4, 0.55], [f * 5.4, 0.6, 0.3], [f * 8.93, 0.3, 0.15], [f * 1.003, 3.0, 0.5]]
      for (let j = 0; j < strokes && ts < dur; j++) {
        const i0 = Math.round(ts * SR)
        addModes(L, R, i0, SR, rod, 0.35 * (0.7 + 0.3 * k), pan, r)
        addBurst(L, R, i0, SR, r, { amp: 0.15, pan, tau: 0.003, f: 2000, q: 0.6 })
        ts += r.range(2.0, 2.3)
      }
    }
    new Fdn(SR, { size: room.size, rt60: room.rt60, damp: room.damp, predelayMs: 4 + 10 * room.size }).process(L, R, room.wet, 1)
    // a very quiet room tone so the gaps are never digital silence
    addAir(L, R, SR, r.fork('roomtone'), 0.0012)
    return finish(L, R, SR, -27 + (k - 0.55) * 10 + (q.clock === 'watch' ? -4 : 0), -40)
  },
}

export default bed
