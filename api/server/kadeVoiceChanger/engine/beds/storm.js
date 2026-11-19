// beds/storm.js - Thunderstorm: heavy rain, gusts, and thunder that cracks or rolls.
//
// Thunder is built the way acousticians model it, not as a sample:
// - A lightning channel is a tortuous random walk from the ground up into
//   the cloud (mean direction change about 16 degrees per few metres, as
//   measured on photographs by Few 1969 and used by Ribner and Roy 1982,
//   "Acoustics of thunder: a quasilinear model for tortuous lightning",
//   JASA 72), with side branches and a long horizontal run inside the cloud.
// - Every short segment of the channel radiates an N-wave (a sharp rise,
//   a straight fall through zero, a sharp return), mostly broadside to the
//   segment. Each arrives after its own distance divided by the speed of
//   sound, so the nearest part of the bolt arrives first as the crack, the
//   rest as rolling claps and rumble that can last ten seconds or more.
// - N-waves lengthen with distance (weak-shock stretching), and the air
//   absorbs highs more the farther they travel, so segments are grouped by
//   distance and each group is low-passed for its range: a close strike rips
//   and cracks, a far one only grumbles.
// - Hills and clouds return late echoes: a long, dark feedback delay network
//   (Jot and Chaigne 1991) adds the rolling tail.
// The rain is the engine of beds/rain.js (Marshall-Palmer drops, Farnell
// style drop events), its intensity surging with the gusts of the wind
// engine of beds/wind.js, as storm rain does.

import {
  Rand32, clamp, eq, addInto, rmsOf, Fdn, rainLayer, ctrlLen, levelTo, limitBed, runBed,
} from './rain.js'
import { windLayer, windSpeed } from './wind.js'

const C = 343

/**
 * One strike as a mono Float32Array (already filtered), loudest near the
 * start for close strikes. dist: horizontal distance in metres.
 */
function strike(sr, rnd, dist) {
  const H = rnd.range(1800, 4000)
  const az = rnd.range(-Math.PI, Math.PI)
  let px = dist * Math.cos(az)
  let py = dist * Math.sin(az)
  let pz = 0
  // Segment records: arrival time, amplitude, N-wave length, distance.
  const T = []
  const A = []
  const W = []
  const D = []
  const emit = (x0, y0, z0, x1, y1, z1, energy, crackish) => {
    const mx = (x0 + x1) / 2
    const my = (y0 + y1) / 2
    const mz = (z0 + z1) / 2 + 1.7
    const r = Math.sqrt(mx * mx + my * my + mz * mz) + 1
    const dx = x1 - x0
    const dy = y1 - y0
    const dz = z1 - z0
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-9
    const cs = (dx * mx + dy * my + dz * mz) / (len * r)
    const side = 1 - cs * cs
    const g = 0.04 + side * side * side * side
    // The return stroke is strongest in its first few hundred metres.
    const e = crackish ? energy * (1 + 2.5 * Math.exp(-mz / 260)) : energy
    T.push(r / C)
    A.push((e * len * g) / r)
    const wbase = crackish && r < 900 ? rnd.logRange(0.0004, 0.0014) : rnd.logRange(0.0028, 0.009)
    W.push(wbase * Math.pow(r / 1000, 0.25))
    D.push(r)
  }
  const walk = (x, y, z, dx, dy, dz, length, step, energy, upBias, flat, crackish) => {
    let travelled = 0
    let guard = 0
    while (travelled < length && guard++ < 6000) {
      dx += rnd.gauss() * 0.28
      dy += rnd.gauss() * 0.28
      dz += rnd.gauss() * 0.28 + upBias
      if (flat) dz *= 0.3
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-9
      dx /= l
      dy /= l
      dz /= l
      const s = step * rnd.range(0.6, 1.4)
      const nx = x + dx * s
      const ny = y + dy * s
      let nz = z + dz * s
      if (nz < 0) nz = 0
      emit(x, y, z, nx, ny, nz, energy, crackish)
      if (!flat && rnd.chance(0.006)) {
        walk(x, y, z, rnd.gauss(), rnd.gauss(), -Math.abs(rnd.gauss()) * 0.5, rnd.range(60, 450), step, energy * 0.45, -0.05, false, crackish)
      }
      x = nx
      y = ny
      z = nz
      travelled += s
    }
    return [x, y, z]
  }
  // Return stroke: ground to cloud base, strongest.
  const top = walk(px, py, pz, 0, 0, 1, H, 5, 1, 0.35, false, true)
  // Cloud run: long and horizontal, weaker, the source of the long roll.
  const ang = rnd.range(0, 2 * Math.PI)
  walk(top[0], top[1], top[2], Math.cos(ang), Math.sin(ang), 0, rnd.range(800, 5500), 9, 0.4, 0, true, false)

  let t0 = Infinity
  let t1 = 0
  let rMin = Infinity
  for (let i = 0; i < T.length; i++) {
    if (T[i] < t0) t0 = T[i]
    if (T[i] > t1) t1 = T[i]
    if (D[i] < rMin) rMin = D[i]
  }
  const close = rMin < 1200
  const pre = close ? rnd.range(0.06, 0.22) : 0
  const len = Math.min(Math.round((t1 - t0 + pre + 1.2) * sr), sr * 28)
  // Three range groups, each filtered for its own air path.
  const groups = [
    { lo: 0, hi: 1200, buf: null },
    { lo: 1200, hi: 4000, buf: null },
    { lo: 4000, hi: 1e9, buf: null },
  ]
  for (const g of groups) g.buf = new Float32Array(len)
  for (let i = 0; i < T.length; i++) {
    const g = D[i] < 1200 ? groups[0] : D[i] < 4000 ? groups[1] : groups[2]
    const s0 = Math.round((T[i] - t0 + pre) * sr)
    const w = Math.max(2, Math.round(W[i] * sr))
    const a = A[i]
    const buf = g.buf
    const end = Math.min(len, s0 + w)
    const k = (2 * a) / (w - 1)
    for (let j = s0, v = a; j < end; j++, v -= k) buf[j] += v
  }
  // The tearing leader just before a close strike: quick small cracks growing louder.
  if (close) {
    let amax = 0
    for (let i = 0; i < T.length; i++) if (D[i] < 1200 && A[i] > amax) amax = A[i]
    const cnt = rnd.int(40) + 25
    for (let c = 0; c < cnt; c++) {
      const x = c / cnt
      const s0 = Math.round(pre * x * sr * rnd.range(0.9, 1.0))
      const w = Math.max(2, Math.round(rnd.logRange(0.0005, 0.0018) * sr))
      const a = amax * (0.08 + 0.55 * x * x) * rnd.range(0.4, 1) * (rnd.chance(0.5) ? 1 : -1)
      const end = Math.min(len, s0 + w)
      const k = (2 * a) / (w - 1)
      for (let j = s0, v = a; j < end; j++, v -= k) groups[0].buf[j] += v
    }
  }
  const out = new Float32Array(len)
  for (const g of groups) {
    const rRep = Math.max(g.lo === 0 ? rMin : g.lo, rMin)
    const fc = 9000 / (1 + rRep / 330)
    eq(g.buf, sr, [['lowpass', fc, 0.6], ['lowpass', fc * 1.4, 0.6], ['highpass', 34, 0.7], ['lowshelf', 70, 0.7, -4]])
    addInto(out, g.buf)
  }
  return { sig: out, rMin, pan: Math.sin(az) * 0.75 }
}

/**
 * Thunder over n samples: { L, R } (with its echo tail). perMinute 0..12,
 * distance metres (typical; each strike varies around it). The first
 * strike comes in the first few seconds so a short preview hears thunder
 * (early: false, for the later pieces of a long bed, keeps the plain rate).
 */
export function thunderLayer(n, sr, rng, o = {}) {
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  const per = clamp(o.perMinute === undefined ? 3 : o.perMinute, 0, 30)
  if (n === 0 || per <= 0) return { L, R, count: 0 }
  const rnd = new Rand32(rng.fork('thunder'))
  const dist0 = clamp(o.distance || 2500, 150, 20000)
  const dur = n / sr
  let t = o.early === false ? rnd.exp(60 / per) : rnd.range(0.4, 2.5)
  let count = 0
  while (t < dur) {
    const dist = clamp(dist0 * Math.exp(0.4 * rnd.gauss()), 150, 20000)
    const st = strike(sr, rnd, dist)
    // Level: the loudest 50 ms of a strike sits at a level set by how near it is.
    const sig = st.sig
    const blk = Math.max(1, Math.round(sr * 0.05))
    let best = 0
    for (let i = 0; i + blk <= sig.length; i += blk) {
      let e = 0
      for (let j = i; j < i + blk; j++) e += sig[j] * sig[j]
      if (e > best) best = e
    }
    const envPk = Math.sqrt(best / blk)
    const target = 0.55 * Math.pow(800 / Math.max(800, st.rMin), 0.6) * rnd.range(0.7, 1.15)
    const g = envPk > 1e-12 ? target / envPk : 0
    const a = (st.pan + 1) * 0.25 * Math.PI
    const gl = Math.cos(a) * g
    const gr = Math.sin(a) * g
    const itd = Math.round(Math.abs(st.pan) * 0.0006 * sr)
    const i0 = Math.round(t * sr)
    const dl = st.pan > 0 ? itd : 0
    const dr = st.pan < 0 ? itd : 0
    for (let j = 0; j < sig.length; j++) {
      const il = i0 + j + dl
      const ir = i0 + j + dr
      if (il < n) L[il] += sig[j] * gl
      if (ir < n) R[ir] += sig[j] * gr
      if (il >= n && ir >= n) break
    }
    count++
    t += Math.max(3, rnd.exp(60 / per))
  }
  // Echoes from hills and cloud: long, dark, wide.
  new Fdn(sr, { size: 3.2, rt60: 3.2, damp: 0.75, predelayMs: 40 }).process(L, R, 0.55, 1)
  return { L, R, count }
}

const SURFACES = [
  { v: 'mixed', name: 'Ground, puddles and leaves' },
  { v: 'pavement', name: 'Street and pavement' },
  { v: 'window', name: 'A window' },
  { v: 'roof', name: 'A tin roof' },
  { v: 'tent', name: 'A tent' },
]

const bed = {
  id: 'storm',
  name: 'Thunderstorm',
  group: 'weather',
  about: 'Heavy rain and gusty wind with thunder, cracking overhead or rumbling far away.',
  params: [
    { id: 'intensity', name: 'How hard it rains', type: 'number', min: 0, max: 100, step: 1, def: 70, unit: 'percent', rand: [40, 95] },
    { id: 'thunder', name: 'Thunder per minute', type: 'number', min: 0, max: 12, step: 1, def: 4, unit: 'count', noun: ['roll', 'rolls'], rand: [2, 8] },
    { id: 'distance', name: 'Thunder distance', type: 'number', min: 300, max: 12000, step: 100, def: 2500, unit: 'meters', rand: [500, 8000] },
    { id: 'wind', name: 'Wind', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 80] },
    { id: 'surface', name: 'What it falls on', type: 'choice', def: 'mixed', options: SURFACES },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg, segment) => {
      const s = { sr: rate, rng: rg }
      const m = ctrlLen(n)
      const windAmt = q.wind / 100
      // One gust curve drives both the wind and surges in the rain.
      const speed = windSpeed(m, rate, new Rand32(s.rng.fork('gust')), 0.25 + 0.75 * Math.max(0.15, windAmt), 0.7)
      let mean = 0
      for (let i = 0; i < m; i++) mean += speed[i]
      mean /= m
      const mod = new Float32Array(m)
      for (let i = 0; i < m; i++) mod[i] = clamp(Math.pow(speed[i] / mean, 0.7), 0.4, 2)
      const rain = rainLayer(n, rate, s.rng.fork('rain'), {
        intensity: q.intensity,
        surface: q.surface,
        drips: 0.35,
        waves: 0.25,
        mod,
      })
      const { L, R } = rain
      if (windAmt > 0) {
        const w = windLayer(n, rate, s.rng.fork('wind'), {
          strength: windAmt,
          gusts: 0.7,
          whistle: 0.15,
          rumble: 0.3,
          speed,
          inside: q.surface === 'window' || q.surface === 'roof' || q.surface === 'tent',
        })
        // Wind sits under the rain, rising to meet it at full strength.
        const rr = rmsOf(L, R)
        const wr = rmsOf(w.L, w.R)
        const g = wr > 1e-9 ? (rr / wr) * 0.75 * Math.pow(windAmt, 0.8) : 0
        addInto(L, w.L, g)
        addInto(R, w.R, g)
      }
      // Level the rain and wind first (by loudness), then thunder sits on top
      // at its own level, then the limiter.
      levelTo(L, R, rate, -21.5 + (q.intensity - 70) * 0.06)
      const th = thunderLayer(n, rate, s.rng, { perMinute: q.thunder, distance: q.distance, early: segment === 0 })
      addInto(L, th.L)
      addInto(R, th.R)
      limitBed(L, R, rate)
      return { L, R }
    })
  },
}

export default bed
