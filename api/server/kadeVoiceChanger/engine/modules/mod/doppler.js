// modules/mod/doppler.js - Pass-by pitch: the voice zooms past you.
//
// Technique: the moving-source Doppler effect computed exactly from retarded
// time (see J. O. Smith III, "Physical Audio Signal Processing", CCRMA, the
// section on Doppler simulation with a variable delay line). The talker
// travels in a straight line at a steady speed, passing the listener at the
// closest distance chosen. Sound emitted at time tau reaches the listener at
//     t = tau + d(tau) / c,   d(tau) = sqrt(closest^2 + (v (tau - pass))^2),
// so for every output sample the emission time is found by Newton's method
// (the equation is strictly increasing below the speed of sound, and two or
// three iterations from the previous answer converge to well under a
// thousandth of a sample), and the voice is read there by the
// band-limited variable-speed reader of core/resample.js, which keeps the
// raised pitch of the approach free of aliasing. Approaching, the voice is
// higher, receding it is lower, with the famous swoop as it passes; the
// size of the swoop comes from the speed alone, exactly as on a road.
// Along the way the level follows the distance (softened by the distance
// fade, so far-off words stay audible), the air takes away treble with
// distance (a one-pole low pass at 43.3 kHz / sqrt(distance), an
// approximation of ISO 9613-1 absorption), and the voice pans with its
// direction by a constant-power law; a talker coming straight at you stays
// centred and turns duller behind you.
//
// Every phrase can zoom past on its own (the take is cut between phrases by
// core/segment.js and each piece makes its own pass, crossfaded over 40 ms
// in the pause), or the whole clip can be one pass. Each pass happens at the
// middle of its piece and the delay is referenced to the piece's edges, so
// the edges stay exactly in time with the input; inside a piece the voice
// runs a little ahead of the input while it approaches and catches up as it
// leaves, which is why this module declares that it warps timing.

import { varispeed } from '../../core/resample.js'
import { findPhrases } from '../../core/segment.js'

const C = 343
const SPEEDS = { bike: 8, town: 14, highway: 30, race: 80, train: 100, jet: 200 }
const XFADE_S = 0.04
const R0 = 1

function num(v, d) {
  return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : d
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

const params = [
  {
    id: 'speed', name: 'Speed', type: 'choice', def: 'race',
    options: [
      { v: 'bike', name: 'Bicycle' },
      { v: 'town', name: 'Car in town' },
      { v: 'highway', name: 'Car on the highway' },
      { v: 'race', name: 'Race car' },
      { v: 'train', name: 'Fast train' },
      { v: 'jet', name: 'Jet plane' },
    ],
  },
  { id: 'closest', name: 'Closest distance', type: 'number', min: 1, max: 60, step: 0.5, def: 6, unit: 'meters', rand: [3, 15] },
  {
    id: 'direction', name: 'Direction', type: 'choice', def: 'ltr',
    options: [
      { v: 'ltr', name: 'Left to right' },
      { v: 'rtl', name: 'Right to left' },
      { v: 'alternate', name: 'Back and forth' },
      { v: 'straight', name: 'Straight past you' },
    ],
  },
  {
    id: 'passes', name: 'Passes', type: 'choice', def: 'phrase',
    options: [{ v: 'phrase', name: 'Every phrase' }, { v: 'once', name: 'Once over the whole clip' }],
  },
  { id: 'fade', name: 'Distance fade', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [40, 80] },
]

/** Contiguous pieces covering the take, cut at the middle of each pause. */
function pieces(mono, sr, perPhrase) {
  const n = mono.length
  if (!perPhrase) return [[0, n]]
  const ph = findPhrases(mono, sr)
  if (ph.length < 2) return [[0, n]]
  const out = []
  let a = 0
  for (let k = 0; k < ph.length - 1; k++) {
    const b = Math.round((ph[k].end + ph[k + 1].start) / 2)
    if (b - a > sr * 0.3) {
      out.push([a, b])
      a = b
    }
  }
  out.push([a, n])
  return out
}

/**
 * One pass over x (a slice of the take). Returns the rendered L and R, the
 * same length as x, with the pass at centre sample pc and the delay
 * referenced to sample refAt (so that sample, and its mirror, stay in time).
 */
function renderPass(x, sr, v, closest, sign, straight, fade, pc, refAt) {
  const m = x.length
  const L = new Float32Array(m)
  const R = new Float32Array(m)
  if (!m) return { L, R }
  const vs = v / sr // metres per sample
  const cs = C / sr
  const y2 = closest * closest
  const dist = (P) => {
    const X = vs * (P - pc)
    return Math.sqrt(y2 + X * X)
  }
  const dRef = dist(refAt)
  // arrival time in samples of the sound emitted at sample P
  const arrive = (P) => P + (dist(P) - dRef) / cs
  const slope = (P) => {
    const X = vs * (P - pc)
    const d = Math.sqrt(y2 + X * X)
    return 1 + (vs * X) / (d * cs)
  }
  const pos = new Float64Array(m + 1)
  // first emission time: solve arrive(P) = 0
  let P = 0
  for (let it = 0; it < 40; it++) {
    const f = arrive(P)
    const step = f / slope(P)
    P -= step
    if (Math.abs(step) < 1e-7) break
  }
  pos[0] = P
  for (let j = 1; j <= m; j++) {
    P += 1 / slope(P)
    for (let it = 0; it < 4; it++) {
      const step = (arrive(P) - j) / slope(P)
      P -= step
      if (Math.abs(step) < 1e-6) break
    }
    pos[j] = P
  }
  const rate = new Float64Array(m)
  for (let j = 0; j < m; j++) rate[j] = pos[j + 1] - pos[j]
  const y = varispeed(x, rate, sr, { start: pos[0] / sr, length: m, stopFade: 0 })
  // level, air and pan per output sample (air coefficient every 32 samples)
  const gRef = R0 + closest
  // two topology-preserving one-pole low passes in series (Zavalishin):
  // flat when the talker is near, because the cutoff then sits at Nyquist
  let s1 = 0
  let s2 = 0
  let G = 1
  for (let j = 0; j < m; j++) {
    const Pj = pos[j]
    const X = vs * (Pj - pc)
    const d = Math.sqrt(y2 + X * X)
    if ((j & 31) === 0) {
      let fc = 43300 / Math.sqrt(d > 1 ? d : 1)
      // a talker behind you sounds duller still
      const back = straight && X > 0 ? X / d : 0
      fc *= 1 - 0.55 * back
      if (fc > sr * 0.499) fc = sr * 0.499
      const t = Math.tan((Math.PI * fc) / sr)
      G = t / (1 + t)
    }
    const s = y[j]
    const va = (s - s1) * G
    const lp = va + s1
    s1 = lp + va
    const vb = (lp - s2) * G
    const lpB = vb + s2
    s2 = lpB + vb
    if (s1 < 1e-20 && s1 > -1e-20) s1 = 0
    if (s2 < 1e-20 && s2 > -1e-20) s2 = 0
    const levDb = -20 * Math.log10((R0 + d) / gRef) * fade
    const g = Math.pow(10, levDb / 20)
    const pan = straight ? 0 : (sign * X) / d
    const th = (pan + 1) * 0.25 * Math.PI
    const o = lpB * g
    L[j] = o * Math.cos(th) * Math.SQRT2
    R[j] = o * Math.sin(th) * Math.SQRT2
  }
  return { L, R }
}

export default {
  id: 'mod.doppler',
  name: 'Pass-by pitch',
  family: 'mod',
  about: 'Your voice zooms past like a passing car, train or jet: higher as it comes, lower as it goes.',
  params,
  stereo: 'make',
  tail: () => 0,
  warps: true,
  cost: 3,
  process(input, p, ctx) {
    const sr = input.sr
    const n = input.ch.length ? input.ch[0].length : 0
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    if (!n) return { sr, ch: [L, R] }
    const mono = new Float32Array(n)
    const g = 1 / input.ch.length
    for (let c = 0; c < input.ch.length; c++) {
      const s = input.ch[c]
      for (let i = 0; i < n; i++) {
        const v = s[i]
        mono[i] += v === v && v < 1e30 && v > -1e30 ? v * g : 0
      }
    }
    const v = SPEEDS[p.speed] || SPEEDS.race
    const closest = clamp(num(p.closest, 6), 0.5, 200)
    const fade = clamp(num(p.fade, 60), 0, 100) / 100
    const dir = p.direction
    const straight = dir === 'straight'
    const list = pieces(mono, sr, p.passes !== 'once')
    const xf = Math.max(1, Math.round(XFADE_S * sr))
    for (let k = 0; k < list.length; k++) {
      const a = list[k][0]
      const b = list[k][1]
      const sa = k > 0 ? Math.max(0, a - xf) : 0
      const sb = k < list.length - 1 ? Math.min(n, b + xf) : n
      const x = mono.subarray(sa, sb)
      const sign = dir === 'rtl' ? -1 : dir === 'alternate' && k % 2 === 1 ? -1 : 1
      const pc = (a + b) / 2 - sa
      const out = renderPass(x, sr, v, closest, sign, straight, fade, pc, a - sa)
      for (let j = 0; j < out.L.length; j++) {
        const i = sa + j
        let w = 1
        if (k > 0 && i < a + xf) {
          const u = (i - (a - xf)) / (2 * xf)
          w = Math.sin(0.5 * Math.PI * clamp(u, 0, 1))
          w *= w
        }
        if (k < list.length - 1 && i > b - xf) {
          const u = (i - (b - xf)) / (2 * xf)
          const c = Math.cos(0.5 * Math.PI * clamp(u, 0, 1))
          w *= c * c
        }
        L[i] += out.L[j] * w
        R[i] += out.R[j] * w
      }
      if (ctx && typeof ctx.progress === 'function') ctx.progress((k + 1) / list.length)
      if (ctx && typeof ctx.cancelled === 'function' && ctx.cancelled()) break
    }
    return { sr, ch: [L, R] }
  },
}
