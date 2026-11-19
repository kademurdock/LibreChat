// stereo.walkaway - Walking away or toward: the talker walks off down a
// hallway (or across a field, into a cave) while talking, or walks up to you.
//
// Technique: a radial path through the spherical-head binaural model of
// Brown and Duda 1998 (core/space3d.js place): the direct voice falls 6 dB
// per doubling of distance and loses highs to the air (ISO 9613-1), with the
// tiny doppler of walking pace, while the room is heard at a steady level
// (its send has three quarters of the distance loss undone), so the voice
// turns from dry and present to distant and roomy exactly past the room's
// critical distance (Kuttruff, "Room Acoustics"). A talker who walks away
// usually faces away too: speech radiates its highs forward (Chu and Warnock
// 2002, "Detailed directivity of sound fields around human talkers", NRC
// Canada), so "facing away" adds a high-shelf cut of about 7 dB above 2 kHz
// and 3 dB less level to the direct voice only.

import { Biquad } from '../../core/biquad.js'
import { clamp, finite, monoOf, spatialize, roomTail, roomOptions, ROOMS, ROOM_LEVEL, SPEED_OF_SOUND } from './_lib.js'

const ROOM_IDS = ['none', 'hallway', 'small-room', 'big-hall', 'church', 'outdoors', 'alley', 'tunnel', 'cave']

export default {
  id: 'stereo.walkaway',
  name: 'Walking away or toward',
  family: 'stereo',
  about: 'The talker walks away from you while speaking, fading into the room, or walks up close from far away.',
  params: [
    { id: 'from', name: 'Starting distance', type: 'number', min: 0.5, max: 40, step: 0.5, def: 1, unit: 'meters', rand: [0.5, 4] },
    { id: 'to', name: 'Ending distance', type: 'number', min: 0.5, max: 40, step: 0.5, def: 12, unit: 'meters', rand: [6, 25] },
    { id: 'angle', name: 'Direction', type: 'number', min: -180, max: 180, step: 5, def: 0, unit: 'degrees', rand: [-60, 60] },
    { id: 'room', name: 'Place', type: 'choice', def: 'hallway', options: roomOptions(ROOM_IDS) },
    {
      id: 'facing', name: 'Talker faces', type: 'choice', def: 'auto',
      options: [
        { v: 'auto', name: 'The way they walk' },
        { v: 'toward', name: 'Toward you' },
        { v: 'away', name: 'Away from you' },
      ],
    },
  ],
  stereo: 'make',
  tail: (p) => {
    const a = clamp(finite(p && p.from, 1), 0.5, 40)
    const b = clamp(finite(p && p.to, 12), 0.5, 40)
    return Math.abs(a - b) / SPEED_OF_SOUND + 0.002 + roomTail(p && ROOMS[p.room] ? p.room : 'none')
  },
  warps: false,
  cost: 2,
  process(input, p, ctx) {
    const sr = input.sr
    const x = monoOf(input)
    const n = x.length
    if (n === 0) return { sr, ch: [new Float32Array(0), new Float32Array(0)] }
    const d0 = clamp(finite(p.from, 1), 0.5, 40)
    const d1 = clamp(finite(p.to, 12), 0.5, 40)
    const az = clamp(finite(p.angle, 0), -180, 180)
    const T = Math.max(1e-3, n / sr)
    const away = p.facing === 'away' || (p.facing !== 'toward' && d1 > d0)
    if (away) {
      // facing away: the direct voice loses its forward-radiated highs
      new Biquad('highshelf', sr, Math.min(2000, 0.4 * sr), 0.707, -7).run(x)
      const g = Math.pow(10, -3 / 20)
      for (let i = 0; i < n; i++) x[i] *= g
    }
    const path = (t) => {
      const f = clamp(t / T, 0, 1)
      return { az, el: 0, dist: d0 + (d1 - d0) * f }
    }
    const rng = ctx && ctx.rng ? ctx.rng.fork('room') : undefined
    const room = ROOMS[p.room] ? p.room : 'none'
    // a talker facing away still fills the room with sound, so the room is
    // fed a little harder to make up the level the direct voice lost
    return spatialize(x, sr, path, { room, comp: 0.75, rng, doppler: true, wet: room !== 'none' ? ((away ? 1.25 : 1) * ROOM_LEVEL) / ROOMS[room].dc : 0 })
  },
}
