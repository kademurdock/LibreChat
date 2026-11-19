// stereo.flyby - Fly-by: the voice rushes past you, pitch dropping as it goes.
//
// Technique: a moving source on a straight line, heard through the
// spherical-head binaural model of Brown and Duda 1998 (core/space3d.js
// place) for direction, head shadow, elevation and distance cues, with the
// doppler shift done here by retarded time, the textbook moving-source
// construction (Morse and Ingard, "Theoretical Acoustics", 1968, on sound
// from moving sources): the sound heard at time t left the source at the
// time tau that solves tau + d(tau) / c = t. Reading the voice at tau(t) gives exactly
// f' = f c / (c - v_r), higher coming and lower going, with the fastest
// change at the closest point, and the voice is heard from where the source
// was when it spoke. The map is solved every 32 samples by fixed-point
// iteration (it contracts, since the source is slower than sound) and the
// voice is read with cubic Hermite interpolation in between.
//
// The whole map is shifted by one constant so the voice is read at its own
// time at both ends of every pass: the take starts at once (no silence while
// the sound "travels" from far away) and ends on its last word, so the only
// tail is the head model's few samples and the chosen place's reverb.
//
// Geometry: "from" and "to" are directions around your head. The line's
// closest point lies between them (on the shorter way round; from left to
// right passes in front, from right to left passes behind), at the closest
// distance, raised by the height angle. Several passes go back and forth,
// each centred in its share of the take.
//
// Fitting the pass to the take (so a long recording never sits out of
// hearing): the source keeps its chosen speed through the closest point and
// for about two and a half seconds either side, then eases smoothly to a
// stop (position s = S tanh(v t / S)), so the pitch glides up as it comes,
// swoops down past you and settles again, and the far ends stay within a
// few seconds' travel. With several passes the ease is tighter, so every
// turn-round is gentle instead of a sudden jump in pitch. Loudness then
// follows the distance through a power law fitted to the take, d^g with g
// chosen so the far ends of the pass are heard 12 dB under the closest point
// (four times the closest distance), never lost: the approach is a steady
// crescendo across the whole take, however long it is. The closest point
// plays at the level of the voice at one metre, so a far pass is not simply
// a quieter take; it is drier at the closest point, roomier at the ends.

import { clamp, finite, monoOf, spatialize, roomTail, roomOptions, readCubic, distGain, ROOMS, DEG, SPEED_OF_SOUND } from './_lib.js'

const ROOM_IDS = ['none', 'outdoors', 'alley', 'tunnel', 'stadium']
const SPEEDS = { walk: 1.4, run: 5, bike: 9, car: 20, fastcar: 35, race: 70, jet: 160 }
// seconds of near full-speed travel either side of a single pass
const HOLD = 2.5
// the easing scale stays between these (metres)
const S_LO = 10
const S_HI = 300
// the far ends are heard as if this many times the closest distance away
const FAR_LEVEL = 4
// samples between points of the time map
const STEP = 32
// the head model's own tail (interaural delay plus filter run-out) is under 2 ms
const HEAD_TAIL = 0.002

function wrap180(a) {
  let x = ((a % 360) + 540) % 360 - 180
  if (x === -180) x = 180
  return x
}

function roomOf(p) {
  return p && ROOMS[p.room] ? p.room : 'none'
}

function geometry(p, seconds) {
  const from = clamp(finite(p.from, -90), -180, 180)
  const to = clamp(finite(p.to, 90), -180, 180)
  let delta = wrap180(to - from)
  if (Math.abs(delta) < 1) delta = 180
  const bis = (from + delta / 2) * DEG
  const sign = delta >= 0 ? 1 : -1
  const c = clamp(finite(p.closest, 2), 0.5, 30)
  const e = clamp(finite(p.height, 0), 0, 90) * DEG
  const v = SPEEDS[p.speed] || SPEEDS.car
  const passes = clamp(Math.round(finite(p.passes, 1)), 1, 8)
  const T = Math.max(0.05, seconds)
  const W = T / passes
  let S = clamp(v * HOLD, S_LO, S_HI)
  // several passes: ease so the turn-round speed is under a tenth of full speed
  if (passes > 1) S = Math.min(S, (v * W) / 4)
  S = Math.max(S, 1e-3)
  const sEnd = S * Math.tanh((v * W) / (2 * S))
  const dEnd = Math.sqrt(c * c + sEnd * sEnd)
  const ratio = dEnd / c
  const gamma = ratio > FAR_LEVEL ? Math.log(FAR_LEVEL) / Math.log(ratio) : 1
  return {
    c, v, passes, W, S, dEnd, gamma,
    px: c * Math.sin(bis) * Math.cos(e),
    py: c * Math.cos(bis) * Math.cos(e),
    pz: c * Math.sin(e),
    ux: sign * Math.cos(bis),
    uy: -sign * Math.sin(bis),
  }
}

// position along the line (metres from the closest point) at source time tau
function along(g, tau) {
  let k = Math.floor(tau / g.W)
  if (k < 0) k = 0
  if (k > g.passes - 1) k = g.passes - 1
  const mid = (k + 0.5) * g.W
  const dir = k % 2 === 0 ? 1 : -1
  return g.S * Math.tanh((g.v * (tau - mid) * dir) / g.S)
}

function distAt(g, tau) {
  const s = along(g, tau)
  return Math.sqrt(g.c * g.c + s * s)
}

// tau at every STEP samples of listener time, for nPts points
function timeMap(g, sr, nPts) {
  const tau = new Float64Array(nPts)
  const C = SPEED_OF_SOUND
  let prev = 0
  let rate = 1
  for (let j = 0; j < nPts; j++) {
    const t = (j * STEP) / sr
    let x = j === 0 ? t : prev + (rate * STEP) / sr
    for (let it = 0; it < 12; it++) {
      const nx = t - (distAt(g, x) - g.dEnd) / C
      const dx = nx - x
      x = nx
      if (dx < 1e-10 && dx > -1e-10) break
    }
    if (!(x === x)) x = t
    if (j > 0) rate = ((x - prev) * sr) / STEP
    tau[j] = x
    prev = x
  }
  return tau
}

/** Fit a buffer's channels to exactly n samples (pad with silence or cut). */
function fitLength(ch, n) {
  return ch.map((s) => {
    if (s.length === n) return s
    const o = new Float32Array(n)
    o.set(s.subarray(0, Math.min(n, s.length)))
    return o
  })
}

export default {
  id: 'stereo.flyby',
  name: 'Fly-by',
  family: 'stereo',
  about: 'Your voice zooms past you from one side to the other, its pitch dropping as it goes by, like a passing car or jet.',
  params: [
    { id: 'from', name: 'Comes from', type: 'number', min: -180, max: 180, step: 5, def: -90, unit: 'degrees', rand: [-150, -30] },
    { id: 'to', name: 'Goes toward', type: 'number', min: -180, max: 180, step: 5, def: 90, unit: 'degrees', rand: [30, 150] },
    {
      id: 'speed', name: 'Speed', type: 'choice', def: 'car',
      options: [
        { v: 'walk', name: 'Walking' }, { v: 'run', name: 'Running' }, { v: 'bike', name: 'Bicycle' },
        { v: 'car', name: 'Car' }, { v: 'fastcar', name: 'Fast car' }, { v: 'race', name: 'Race car' }, { v: 'jet', name: 'Jet plane' },
      ],
    },
    { id: 'closest', name: 'Closest distance', type: 'number', min: 0.5, max: 30, step: 0.5, def: 2, unit: 'meters', rand: [1, 6] },
    { id: 'passes', name: 'Passes', type: 'number', min: 1, max: 8, step: 1, def: 1, unit: 'count', noun: ['pass', 'passes'], rand: [1, 3] },
    { id: 'height', name: 'Height', type: 'number', min: 0, max: 90, step: 5, def: 0, unit: 'degrees', rand: [0, 40] },
    { id: 'room', name: 'Place', type: 'choice', def: 'outdoors', options: roomOptions(ROOM_IDS) },
  ],
  stereo: 'make',
  tail: (p) => HEAD_TAIL + roomTail(roomOf(p)),
  warps: false,
  cost: 2,
  process(input, p, ctx) {
    const sr = input.sr
    const x = monoOf(input)
    const n = x.length
    if (n === 0) return { sr, ch: [new Float32Array(0), new Float32Array(0)] }
    const room = roomOf(p)
    const g = geometry(p, n / sr)

    // the time map covers the take plus a little, for the head model's tail
    const nPts = Math.ceil((n + Math.ceil(0.05 * sr)) / STEP) + 2
    const tau = timeMap(g, sr, nPts)
    const last = nPts - 1
    const tLast = (last * STEP) / sr

    // the voice as it arrives: read at its source time, with the level set
    // so the closest point plays as loud as the voice at one metre (the
    // distance still shapes the pass; it does not sink the whole take)
    const makeup = 1 / distGain(g.c)
    const y = new Float32Array(n)
    for (let j = 0; j * STEP < n; j++) {
      const a = tau[j] * sr
      const b = tau[j + 1] * sr
      const i0 = j * STEP
      const i1 = Math.min(n, i0 + STEP)
      const d = (b - a) / STEP
      for (let i = i0; i < i1; i++) y[i] = makeup * readCubic(x, a + d * (i - i0))
    }

    // where the voice is heard from at listener time t: where it was at tau(t)
    const path = (t) => {
      let tt
      const f = (t * sr) / STEP
      if (!(f > 0)) tt = tau[0]
      else if (f >= last) tt = tau[last] + (t - tLast)
      else {
        const j = Math.floor(f)
        tt = tau[j] + (tau[j + 1] - tau[j]) * (f - j)
      }
      const s = along(g, tt)
      const px = g.px + g.ux * s
      const py = g.py + g.uy * s
      const pz = g.pz
      const h = Math.sqrt(px * px + py * py)
      const d = Math.sqrt(h * h + pz * pz)
      return { az: Math.atan2(px, py) / DEG, el: Math.atan2(pz, h) / DEG, dist: g.c * Math.pow(Math.max(d, 1e-3) / g.c, g.gamma) }
    }

    const rng = ctx && ctx.rng ? ctx.rng.fork('room') : undefined
    const out = spatialize(y, sr, path, { room, comp: 0.5, rng, doppler: false })
    return { sr, ch: fitLength(out.ch, n + Math.round((HEAD_TAIL + roomTail(room)) * sr)) }
  },
}
