// stereo.place - Put the voice somewhere around your head (for headphones).
//
// Technique: the structural spherical-head model of Brown and Duda 1998,
// "A structural model for binaural sound synthesis" (IEEE Trans. Speech and
// Audio Processing 6(5)), as built in core/space3d.js: interaural time and
// level differences, head shadow, pinna notches that rise with height, the
// dull "behind you" cue (Blauert's directional bands) and distance loss with
// air absorption and near-field level difference, so a voice at 20 cm is
// truly in one ear. A rear correction (_lib.js rearCompDb) keeps a voice
// behind you duller than one in front, which the plain sphere model does not.
// Distance is sold by the room: a named space from
// core/ir.js (direct sound removed) is played at a fixed level while the
// direct voice falls with distance, so past the room's critical distance the
// voice is mostly room (Kuttruff, "Room Acoustics").
//
// Live: the same head model streamed sample by sample (_lib.js Binaural) and
// an 8-line feedback delay network in place of the convolution room.

import { clamp, finite, monoOf, spatialize, roomTail, roomOptions, ROOMS, ROOM_LEVEL, Binaural, LiveRoom, inMono, outStereo } from './_lib.js'

const ROOM_IDS = ['none', 'small-room', 'hallway', 'big-hall', 'church', 'outdoors', 'cave']

function pos(p) {
  return {
    az: clamp(finite(p.angle, -60), -180, 180),
    el: clamp(finite(p.height, 0), -40, 80),
    dist: clamp(finite(p.distance, 1.5), 0.1, 30),
  }
}

function roomOf(p) {
  return ROOMS[p.room] ? p.room : 'none'
}

export default {
  id: 'stereo.place',
  name: 'Put the voice somewhere',
  family: 'stereo',
  about: 'Places your voice around your head on headphones: beside you, behind you, above you, in your ear or across the room.',
  params: [
    { id: 'angle', name: 'Direction', type: 'number', min: -180, max: 180, step: 5, def: -60, unit: 'degrees', rand: [-180, 180] },
    { id: 'height', name: 'Height', type: 'number', min: -40, max: 80, step: 5, def: 0, unit: 'degrees', rand: [-20, 50] },
    { id: 'distance', name: 'Distance', type: 'number', min: 0.1, max: 30, step: 0.1, def: 1.5, unit: 'meters', rand: [0.3, 6] },
    { id: 'room', name: 'Room', type: 'choice', def: 'small-room', options: roomOptions(ROOM_IDS) },
  ],
  stereo: 'make',
  tail: (p) => 0.002 + roomTail(p && ROOMS[p.room] ? p.room : 'none'),
  warps: false,
  cost: 2,
  process(input, p, ctx) {
    const sr = input.sr
    const x = monoOf(input)
    if (x.length === 0) return { sr, ch: [new Float32Array(0), new Float32Array(0)] }
    const where = pos(p)
    const rng = ctx && ctx.rng ? ctx.rng.fork('room') : undefined
    return spatialize(x, sr, where, { room: roomOf(p), comp: 1, rng, doppler: false })
  },
  live: {
    latency(p, sr) {
      const b = new Binaural(sr)
      const w = pos(p)
      b.az = w.az; b.el = w.el; b.dist = w.dist
      return Math.max(0, Math.floor(b.minDelay()))
    },
    create(sr, p) {
      const bin = new Binaural(sr)
      const room = new LiveRoom(sr, ROOM_IDS)
      const gc = Math.exp(-1 / (0.02 * sr))
      const st = { tWet: 0, cWet: 0 }
      function apply(np, snap) {
        const w = pos(np)
        bin.az = w.az; bin.el = w.el; bin.dist = w.dist
        const id = roomOf(np)
        room.setRoom(id)
        st.tWet = ROOMS[id].space ? ROOM_LEVEL / ROOMS[id].dc : 0
        if (snap) {
          bin.snap()
          st.cWet = st.tWet
        }
      }
      apply(p, true)
      return {
        process(ins, outs, n) {
          for (let i = 0; i < n; i++) {
            const x = inMono(ins, i)
            bin.tick(x)
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
