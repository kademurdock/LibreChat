// beds/seagulls-harbor.js - A small harbor: gulls, lapping water, clinking rigging, a far bell buoy.
//
// Gulls: the long call of the big gulls is a few low "huoh" notes, a run of
// loud "kyow" notes (a quick rise, a fall) and often a "ha-ha-ha" laugh;
// there are also single mewing calls and sharp "kek" alarms. Their voices
// are harsh and nasal: a harmonic voice (harmonicVoice in wolves-far.js) with
// a flat spectral tilt, broad nasal resonances near 1.7 and 3.2 kHz, pitch
// jitter and period-doubling roughness. Some gulls call while flying past,
// so their side changes during the call.
//
// Metal: halyards slapping masts and the bell buoy are modal synthesis
// (Adrien, "The missing link: modal synthesis", 1991; van den Doel and Pai,
// "The sounds of physical shapes", Presence 1998): a strike excites a set of
// exponentially decaying sinusoids. Halyard clinks use the free-bar mode
// ratios 1 : 2.756 : 5.404 : 8.933 and come in bursts when the wind gusts
// (they read the scene's gust curve); the buoy uses the classic bell partials
// (hum, prime, minor third, fifth, nominal and above) with long decays, rung
// by the swell in small clusters.
//
// Rope and fender creaks are stick-slip friction: a train of tiny slips
// whose rate glides up and down, ringing wooden resonances. A far boat
// engine is a slow diesel putter (low thumps at the firing rate) moving
// across the water. Water lapping comes from frogs-pond.js. The space has
// the slap of hulls and harbor walls (SPACES.harbor).
//
// Named exports: modal, modalInto, BELL, BAR, gullCall, creak.

import { makeRng } from '../core/rng.js'
import { resolveParams } from '../core/params.js'
import { makeScene, emit, emitPath, addAir, finishScene, drawPan, drawDist, gustAt, SPACES, clamp } from './forest-birds.js'
import { harmonicVoice } from './wolves-far.js'
import { addLapping } from './frogs-pond.js'

const TAU = Math.PI * 2
const TINY = 1e-20

function R(rng, a, b) {
  return a + (b - a) * rng.next()
}

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

export const BAR = [[1, 1, 1], [2.756, 0.6, 0.55], [5.404, 0.36, 0.3], [8.933, 0.22, 0.14]]
export const BELL = [[0.5, 1.6, 0.5], [1, 1.2, 0.8], [1.183, 1, 0.65], [1.506, 0.7, 0.4], [2, 0.75, 1], [2.514, 0.45, 0.35], [2.662, 0.4, 0.3], [3.011, 0.35, 0.25], [4.166, 0.22, 0.15]]

/**
 * Add a struck object into out at sample off. f = base Hz, ratios =
 * [[ratio, decay factor, amp], ...], decay = seconds for the base mode,
 * hardness 0..1 (softer strikes lose the high modes), amp.
 */
export function modalInto(out, off, sr, f, ratios, decay, hardness, amp, rng) {
  const lim = 0.45 * sr
  const att = Math.max(1, Math.round((0.0015 - 0.0013 * clamp(hardness, 0, 1)) * sr))
  for (const [ratio, dk, a0] of ratios) {
    const fm = f * ratio * (1 + 0.002 * (rng ? rng.gauss() : 0))
    if (fm >= lim) continue
    const d = Math.max(0.005, decay * dk)
    const len = Math.min(out.length - off, Math.ceil(d * 7 * sr))
    if (len <= 0) continue
    const w = (TAU * fm) / sr
    const k = Math.exp(-1 / (d * sr))
    const cr = Math.cos(w) * k
    const ci = Math.sin(w) * k
    // high modes are weaker for soft strikes
    const a = amp * a0 * Math.pow(Math.min(1, (2000 + 9000 * hardness) / fm), 0.7)
    let re = 1
    let im = 0
    for (let i = 0; i < len; i++) {
      const nre = re * cr - im * ci
      im = re * ci + im * cr
      re = nre
      const e = i < att ? i / att : 1
      out[off + i] += im * a * e
    }
  }
}

/** A struck object as its own event (Float32Array). */
export function modal(sr, rng, f, ratios, decay, hardness = 0.6, amp = 1) {
  let longest = 0
  for (const m of ratios) longest = Math.max(longest, decay * m[1])
  const out = new Float32Array(Math.ceil((longest * 5 + 0.01) * sr))
  modalInto(out, 0, sr, f, ratios, decay, hardness, amp, rng)
  return out
}

function bandInto(buf, out, sr, f, q, g) {
  if (f >= 0.45 * sr) return
  const w0 = (TAU * f) / sr
  const al = Math.sin(w0) / (2 * q)
  const a0 = 1 + al
  const b0 = al / a0
  const a1 = (-2 * Math.cos(w0)) / a0
  const a2 = (1 - al) / a0
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i]
    const y = b0 * (x - x2) - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y < TINY && y > -TINY ? 0 : y
    out[i] += y1 * g
  }
}

/** Stick-slip creak of rope or wood. Returns a Float32Array. */
export function creak(sr, rng, o = {}) {
  const dur = num(o.dur, R(rng, 0.35, 0.9))
  const len = Math.ceil((dur + 0.05) * sr)
  const exc = new Float32Array(len)
  const r0 = num(o.rate0, R(rng, 25, 60))
  const r1 = num(o.rate1, R(rng, 70, 180))
  let t = 0.002
  while (t < dur) {
    const u = t / dur
    const rate = r0 + (r1 - r0) * Math.sin(Math.PI * u)
    const env = Math.sin(Math.PI * u)
    const i = Math.round(t * sr)
    if (i + 1 < len) {
      const a = env * (0.6 + 0.8 * rng.next())
      exc[i] += a
      exc[i + 1] -= a * 0.4
    }
    t += (1 / rate) * (1 + 0.15 * (rng.next() * 2 - 1))
  }
  const out = new Float32Array(len)
  const base = num(o.base, R(rng, 300, 450))
  bandInto(exc, out, sr, base, 6, 1)
  bandInto(exc, out, sr, base * R(rng, 2.2, 2.8), 7, 0.7)
  bandInto(exc, out, sr, base * R(rng, 5, 6.5), 6, 0.35)
  return out
}

/** One gull call. kind: 'long' | 'mew' | 'kek'. F = the bird's pitch. */
export function gullCall(sr, rng, kind, F) {
  const voice = (d, f, amp, rough) => harmonicVoice(sr, rng, {
    dur: d,
    f,
    amp,
    formants: [[R(rng, 1500, 1900), 900, 0], [R(rng, 3000, 3500), 1200, -4], [800, 500, -8]],
    tilt: -2,
    nh: 14,
    jitter: 45,
    rough: Math.min(0.85, rough * 1.5),
    breath: 0.18,
  })
  const notes = []
  if (kind === 'mew') {
    const d = R(rng, 0.45, 0.8)
    notes.push([0, voice(d, [[0, F * 0.8], [0.14, F * 1.12], [d, F * 0.72]], [[0, 0], [0.04, 1], [d * 0.75, 0.7], [d, 0]], 0.18)])
  } else if (kind === 'kek') {
    const k = 3 + rng.int(5)
    for (let i = 0; i < k; i++) {
      const d = R(rng, 0.05, 0.075)
      notes.push([i * R(rng, 0.11, 0.15), voice(d, [[0, F * 1.05], [d, F * 0.95]], [[0, 0], [0.008, 1], [d, 0]], 0.3)])
    }
  } else {
    let t = 0
    const low = 1 + rng.int(2)
    for (let i = 0; i < low; i++) {
      const d = R(rng, 0.13, 0.18)
      notes.push([t, voice(d, [[0, F * 0.6], [d, F * 0.66]], [[0, 0], [0.03, 0.55], [d, 0]], 0.25)])
      t += d + R(rng, 0.12, 0.2)
    }
    const k = 4 + rng.int(7)
    let per = R(rng, 0.34, 0.42)
    for (let i = 0; i < k; i++) {
      const d = R(rng, 0.2, 0.3)
      const f = F * R(rng, 0.96, 1.04)
      notes.push([t, voice(d, [[0, f * 0.55], [0.035, f], [d * 0.5, f * 0.93], [d, f * 0.62]], [[0, 0], [0.025, 1], [d * 0.6, 0.8], [d, 0]], 0.35)])
      t += per
      per *= 0.97
    }
    if (rng.next() < 0.6) {
      const h = 4 + rng.int(6)
      for (let i = 0; i < h; i++) {
        const d = R(rng, 0.08, 0.1)
        notes.push([t, voice(d, [[0, F * 0.88], [d, F * 0.8]], [[0, 0], [0.012, 0.85], [d, 0]], 0.4)])
        t += R(rng, 0.12, 0.15)
      }
    }
  }
  let end = 0
  for (const [t, s] of notes) end = Math.max(end, Math.round(t * sr) + s.length)
  const out = new Float32Array(end + 1)
  for (const [t, s] of notes) {
    const o = Math.round(t * sr)
    for (let i = 0; i < s.length; i++) out[o + i] += s[i]
  }
  return out
}

/** Gulls around the harbor. o: { count, dist, busy 0..1, gain, send }. */
export function addGulls(sc, rng, o = {}) {
  const sr = sc.sr
  const count = Math.max(0, Math.round(num(o.count, 4)))
  if (!count) return
  const busy = clamp(num(o.busy, 0.5), 0, 1)
  const gulls = []
  for (let k = 0; k < count; k++) {
    const r = rng.fork('gull' + k)
    gulls.push({ r, F: R(r, 820, 1150), pan: drawPan(r, 0.9), dist: drawDist(r, num(o.dist, 25), 0.5, 4, 400) })
  }
  const tr = rng.fork('gullturns')
  let t = R(tr, 0.2, 1.5)
  while (t < sc.dur) {
    const g = gulls[tr.int(gulls.length)]
    const u = tr.next()
    const kind = u < 0.45 ? 'long' : u < 0.8 ? 'mew' : 'kek'
    const ev = gullCall(sr, g.r, kind, g.F * R(g.r, 0.98, 1.02))
    const gain = num(o.gain, 1) * R(g.r, 0.7, 1.1)
    if (tr.next() < 0.4) {
      // calling while flying past: the side drifts during the call
      const p0 = g.pan
      const p1 = clamp(p0 + R(tr, -1.2, 1.2), -0.95, 0.95)
      const d0 = g.dist
      const d1 = drawDist(tr, num(o.dist, 25), 0.5, 4, 400)
      const T = ev.length / sr
      emitPath(sc, ev, t * sr, (tt, out) => {
        const s = clamp(tt / T, 0, 1)
        out.pan = p0 + (p1 - p0) * s
        out.dist = d0 + (d1 - d0) * s
      }, gain, num(o.send, 0.4))
      g.pan = p1
      g.dist = d1
    } else {
      emit(sc, ev, t * sr, g.pan, g.dist, gain, num(o.send, 0.4))
    }
    // other gulls often answer quickly, then a lull
    t += ev.length / sr * R(tr, 0.3, 1) + (tr.next() < 0.5 ? R(tr, 0.2, 1.2) : R(tr, 1.5, 7) / (0.3 + busy))
  }
}

/** Halyards clinking on masts when the wind gusts. o: { masts, dist, level, gain, send }. */
export function addRigging(sc, rng, o = {}) {
  const sr = sc.sr
  const masts = Math.max(0, Math.round(num(o.masts, 4)))
  const level = clamp(num(o.level, 0.4), 0, 1)
  if (!masts || !(level > 0)) return
  for (let m = 0; m < masts; m++) {
    const r = rng.fork('mast' + m)
    const f = R(r, 1700, 3300)
    const pan = drawPan(r, 0.9)
    const dist = drawDist(r, num(o.dist, 30), 0.5, 6, 200)
    let t = R(r, 0, 3)
    while (t < sc.dur) {
      const g = gustAt(sc, t)
      const rate = level * (0.05 + 1.2 * g * g * g)
      if (r.next() < Math.min(0.9, rate * 2)) {
        const k = 1 + r.int(4)
        const ev = new Float32Array(Math.ceil((k * 0.5 + 1.6) * sr))
        let tt = 0
        for (let i = 0; i < k; i++) {
          modalInto(ev, Math.round(tt * sr), sr, f * R(r, 0.995, 1.005), BAR, R(r, 0.25, 0.45), R(r, 0.5, 0.9), R(r, 0.4, 1), r)
          tt += R(r, 0.15, 0.5)
        }
        emit(sc, ev, t * sr, pan, dist, num(o.gain, 0.5), num(o.send, 0.4))
        t += tt
      }
      t += R(r, 0.4, 1.4)
    }
  }
}

/** A far bell buoy rung by the swell. o: { dist, gain, send }. */
export function addBellBuoy(sc, rng, o = {}) {
  const sr = sc.sr
  const r = rng.fork('buoy')
  const f = R(r, 420, 640)
  const pan = drawPan(r, 0.8)
  const dist = Math.max(60, num(o.dist, 250))
  let t = R(r, 0.5, 5)
  while (t < sc.dur) {
    const k = 1 + r.int(3)
    for (let i = 0; i < k; i++) {
      const ev = modal(sr, r, f, BELL, R(r, 2.5, 3.5), R(r, 0.4, 0.8), R(r, 0.5, 1))
      emit(sc, ev, (t + i * R(r, 0.9, 2.2)) * sr, pan, dist, num(o.gain, 1), num(o.send, 0.6))
    }
    t += k * 1.5 + R(r, 5, 14)
  }
}

/** Distant diesel putter crossing the water. o: { dist, gain, send }. */
export function addBoat(sc, rng, o = {}) {
  const sr = sc.sr
  const r = rng.fork('boat')
  let t = R(r, -8, 4)
  while (t < sc.dur) {
    const dur = R(r, 12, 25)
    const len = Math.ceil(dur * sr)
    const ev = new Float32Array(len)
    const fire = R(r, 7, 10)
    const tone = R(r, 55, 80)
    let tt = 0
    while (tt < dur) {
      const i = Math.round(tt * sr)
      const a = 0.6 + 0.4 * r.next()
      const tl = Math.min(len - i, Math.round(0.09 * sr))
      for (let j = 0; j < tl; j++) {
        const x = j / sr
        ev[i + j] += a * Math.sin(TAU * tone * x) * Math.exp(-x / 0.025) + a * 0.15 * (r.next() * 2 - 1) * Math.exp(-x / 0.008)
      }
      tt += (1 / fire) * (1 + 0.04 * r.gauss())
    }
    const fade = Math.round(Math.min(dur * 0.3, 3) * sr)
    for (let i = 0; i < fade; i++) {
      ev[i] *= i / fade
      ev[len - 1 - i] *= i / fade
    }
    const p0 = R(r, -0.9, 0.9)
    const p1 = clamp(p0 + R(r, -1, 1), -0.95, 0.95)
    const d = Math.max(60, num(o.dist, 200))
    emitPath(sc, ev, t * sr, (x, out) => {
      const s = x / dur
      out.pan = p0 + (p1 - p0) * s
      out.dist = d * (1 + 0.3 * Math.cos(Math.PI * s))
    }, num(o.gain, 1), num(o.send, 0.5))
    t += dur + R(r, 6, 30)
  }
}

/** A foghorn far out: a long low reed tone with a grunt at the end. o: { dist, gain, send }. */
export function addFoghorn(sc, rng, o = {}) {
  const sr = sc.sr
  const r = rng.fork('foghorn')
  const F = R(r, 150, 210)
  let t = R(r, 0.5, 4)
  while (t < sc.dur) {
    const d = R(r, 2.4, 3.4)
    const ev = harmonicVoice(sr, r, {
      dur: d,
      f: [[0, F * 0.9], [0.3, F], [d - 0.45, F], [d, F * 0.78]],
      amp: [[0, 0], [0.25, 1], [d - 0.35, 1], [d, 0]],
      formants: [[420, 300, 0], [950, 450, -4], [2100, 800, -10]],
      tilt: -4,
      nh: 24,
      jitter: 3,
      rough: 0.05,
      breath: 0.04,
    })
    emit(sc, ev, t * sr, num(o.pan, -0.4), Math.max(300, num(o.dist, 1500)), num(o.gain, 1), num(o.send, 0.8))
    t += R(r, 18, 30)
  }
}

// ---------------------------------------------------------------- the bed

const bed = {
  id: 'seagulls-harbor',
  name: 'Seagulls in a harbor',
  group: 'nature',
  about: 'A small harbor: gulls calling and laughing, water lapping, rigging clinking, a bell buoy far out.',
  params: [
    { id: 'intensity', name: 'Gulls', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent' },
    { id: 'distance', name: 'Distance to the gulls', type: 'number', min: 5, max: 120, step: 1, def: 25, unit: 'meters' },
    { id: 'water', name: 'Lapping water', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent' },
    { id: 'rigging', name: 'Rigging clinking', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent' },
    { id: 'wind', name: 'Sea breeze', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent' },
    { id: 'boats', name: 'Boats and bell buoy', type: 'bool', def: true },
    { id: 'foghorn', name: 'Foghorn', type: 'bool', def: false },
  ],
  generate(seconds, sr, p, rng) {
    const q = resolveParams(bed, p || {})
    const r = rng || makeRng('seagulls-harbor')
    const sc = makeScene(seconds, sr, r)
    if (!sc.n) return { sr: sc.sr, ch: [sc.L, sc.R] }
    const I = q.intensity / 100
    addAir(sc, { hushDb: -58, wind: 0.06 + 0.85 * (q.wind / 100), gust: 0.7, body: 480, foliage: 0.1, foliageHz: 3000, rustle: 0, rumble: 0.35, gustPeriod: 8 }, r.fork('air'))
    const w = q.water / 100
    if (w > 0) addLapping(sc, r.fork('lap'), { level: w, dist: 3, gain: 0.5, send: 0.25, size: 1.4 })
    if (I > 0) addGulls(sc, r.fork('gulls'), { count: 2 + Math.round(I * 6), dist: q.distance, busy: I, gain: 0.9, send: 0.4 })
    addRigging(sc, r.fork('rigging'), { masts: 4, dist: 30, level: q.rigging / 100, gain: 0.35, send: 0.4 })
    if (q.boats) {
      addBellBuoy(sc, r.fork('buoy'), { dist: 260, gain: 1.6, send: 0.55 })
      addBoat(sc, r.fork('boat'), { dist: 220, gain: 2.5, send: 0.45 })
    }
    if (q.foghorn) addFoghorn(sc, r.fork('fog'), { dist: 1500, gain: 9, send: 0.8 })
    return finishScene(sc, SPACES.harbor, r.fork('space'), -8.5)
  },
}

export default bed
