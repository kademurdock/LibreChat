// stereo.orbit - Circling head: the voice travels round and round you.
//
// Technique: the spherical-head binaural model of Brown and Duda 1998
// (core/space3d.js place) driven by a circular path. Every cue moves
// smoothly with the source: the interaural delay and level swing from ear to
// ear, the head shadow darkens the far ear, the pinna's "behind" dulling and
// 1 kHz lift come and go as it passes behind you, and with a tilt the circle
// leans so the voice rises above your head in front and dips behind (the
// pinna notch climbs from about 5 kHz to 13 kHz as it rises, Hebrank and
// Wright 1974). The classic "virtual barber shop" headphone trick, with a
// real head model instead of a pan pot. The rear correction of _lib.js
// (rearCompDb) keeps the back half of the circle audibly behind you.
//
// Live: the same model streamed (_lib.js Binaural), the circle's phase kept
// running across setting changes so speeding up never jumps.

import { clamp, finite, monoOf, spatialize, roomTail, roomOptions, ROOMS, ROOM_LEVEL, Binaural, LiveRoom, inMono, outStereo } from './_lib.js'

const ROOM_IDS = ['none', 'small-room', 'big-hall', 'outdoors']

function shape(p) {
  return {
    period: clamp(finite(p.period, 4), 0.5, 30),
    dist: clamp(finite(p.distance, 1.2), 0.3, 5),
    height: clamp(finite(p.height, 0), -40, 60),
    tilt: clamp(finite(p.tilt, 0), 0, 80),
    dir: p.direction === 'counterclockwise' ? -1 : 1,
    start: clamp(finite(p.start, 0), -180, 180),
  }
}

function elevation(s, phaseDeg) {
  return clamp(s.height + s.tilt * Math.cos(phaseDeg * (Math.PI / 180)), -90, 90)
}

function roomOf(p) {
  return ROOMS[p.room] ? p.room : 'none'
}

export default {
  id: 'stereo.orbit',
  name: 'Circling head',
  family: 'stereo',
  about: 'Your voice circles around your head on headphones, past each ear and behind you, and can swoop over the top.',
  params: [
    { id: 'period', name: 'Time for one circle', type: 'number', min: 0.5, max: 30, step: 0.1, def: 4, unit: 'seconds', rand: [1.5, 8] },
    { id: 'distance', name: 'Distance', type: 'number', min: 0.3, max: 5, step: 0.1, def: 1.2, unit: 'meters', rand: [0.5, 2.5] },
    { id: 'height', name: 'Height', type: 'number', min: -40, max: 60, step: 5, def: 0, unit: 'degrees', rand: [-10, 30] },
    { id: 'tilt', name: 'Tilt over the top', type: 'number', min: 0, max: 80, step: 5, def: 0, unit: 'degrees', rand: [0, 60] },
    {
      id: 'direction', name: 'Direction', type: 'choice', def: 'clockwise',
      options: [{ v: 'clockwise', name: 'Clockwise' }, { v: 'counterclockwise', name: 'Counterclockwise' }],
    },
    { id: 'start', name: 'Starting direction', type: 'number', min: -180, max: 180, step: 5, def: 0, unit: 'degrees' },
    { id: 'room', name: 'Room', type: 'choice', def: 'none', options: roomOptions(ROOM_IDS) },
  ],
  stereo: 'make',
  tail: (p) => 0.002 + roomTail(p && ROOMS[p.room] ? p.room : 'none'),
  warps: false,
  cost: 2,
  process(input, p, ctx) {
    const sr = input.sr
    const x = monoOf(input)
    if (x.length === 0) return { sr, ch: [new Float32Array(0), new Float32Array(0)] }
    const s = shape(p)
    const path = (t) => {
      const ph = s.start + (s.dir * 360 * t) / s.period
      return { az: ph, el: elevation(s, ph), dist: s.dist }
    }
    const rng = ctx && ctx.rng ? ctx.rng.fork('room') : undefined
    return spatialize(x, sr, path, { room: roomOf(p), comp: 1, rng, doppler: false })
  },
  live: {
    latency: () => 0,
    create(sr, p) {
      const bin = new Binaural(sr)
      const room = new LiveRoom(sr, ROOM_IDS)
      const gc = Math.exp(-1 / (0.02 * sr))
      const st = { s: shape(p), phase: 0, inc: 0, tWet: 0, cWet: 0 }
      function apply(np, snap) {
        const s = shape(np)
        if (snap || s.start !== st.s.start) st.phase = s.start
        st.s = s
        st.inc = (s.dir * 360) / (s.period * sr)
        const id = roomOf(np)
        room.setRoom(id)
        st.tWet = ROOMS[id].space ? ROOM_LEVEL / ROOMS[id].dc : 0
        if (snap) st.cWet = st.tWet
        bin.dist = s.dist
        bin.az = st.phase
        bin.el = elevation(s, st.phase)
        if (snap) bin.snap()
      }
      apply(p, true)
      return {
        process(ins, outs, n) {
          const s = st.s
          for (let i = 0; i < n; i++) {
            if (bin.ctr === 0) {
              bin.az = st.phase
              bin.el = elevation(s, st.phase)
            }
            const x = inMono(ins, i)
            bin.tick(x)
            let ph = st.phase + st.inc
            if (ph > 180) ph -= 360
            else if (ph < -180) ph += 360
            st.phase = ph
            st.cWet = st.tWet + (st.cWet - st.tWet) * gc
            let l = bin.l, r = bin.r
            if (st.cWet > 1e-5) {
              room.tick(x)
              l += room.l * st.cWet
              r += room.r * st.cWet
            }
            outStereo(outs, i, l, r)
          }
        },
        set(np) {
          apply(np, false)
        },
        reset() {
          bin.reset()
          room.clear()
        },
      }
    },
  },
}
