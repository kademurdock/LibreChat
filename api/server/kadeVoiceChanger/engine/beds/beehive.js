// beds/beehive.js - A busy beehive, and the flying-insect engine (bees, bumblebees, flies, mosquitoes).
//
// The flight tone of an insect is its wingbeat: about 230 beats a second for
// a honeybee, 130 to 180 for a bumblebee, near 200 for a house fly and 450
// to 650 for a mosquito, with a long series of harmonics. One insect flying
// past is a band-limited harmonic wavetable (additive synthesis into a
// table, so it never aliases) read at the wingbeat rate. Its path is a
// straight pass with swerves; the pitch follows the doppler shift
// (f * c / (c + radial speed), with c = 343 m/s) plus the small wingbeat
// changes of a turning insect, and level, side and air colour come from the
// scene's distance model (emitPath in forest-birds.js).
//
// The hive's hum is many bees at once. Rather than run dozens of
// oscillators, every bee adds one impulse per wingbeat (placed between
// samples by linear splitting) into one of two pulse tracks, with its own
// slowly wandering wingbeat and its own spells of activity. The summed
// trains then pass through a gentle source tilt (a wingbeat is a smooth push,
// not a click) and the shared colour of the box: a low pass whose corner
// falls as you go "inside", and a body resonance near 450 Hz. This
// is the excitation-and-shared-filter idea of source-filter synthesis,
// which makes a dense, beating choral hum for a few hundred thousand
// additions instead of millions of oscillator samples.
//
// Named exports: insectTable, flyBy, addFlyBys, hiveHum.

import { makeRng } from '../core/rng.js'
import { resolveParams } from '../core/params.js'
import { makeScene, emit, emitPath, addAir, finishScene, makeSingers, runSingers, SPACES, clamp, smoothNoise } from './forest-birds.js'

const TAU = Math.PI * 2
const TINY = 1e-20
const C = 343

function R(rng, a, b) {
  return a + (b - a) * rng.next()
}

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

const KINDS = {
  bee: { f: [215, 250], speed: [1.6, 3.8], tilt: 1.5, gain: 0.07, wander: 0.04 },
  bumble: { f: [130, 180], speed: [1.2, 2.6], tilt: 1.4, gain: 0.1, wander: 0.03 },
  fly: { f: [175, 215], speed: [1.2, 3.2], tilt: 1.3, gain: 0.07, wander: 0.08 },
  mosquito: { f: [450, 640], speed: [0.4, 1.1], tilt: 1.2, gain: 0.03, wander: 0.06 },
}

/** A one-cycle harmonic table of 2048 points, harmonics only below 0.45 sr at fMax. */
export function insectTable(sr, fMax, tilt, rng) {
  const N = 2048
  const t = new Float32Array(N + 1)
  const K = Math.max(1, Math.min(24, Math.floor((0.45 * sr) / Math.max(20, fMax))))
  for (let k = 1; k <= K; k++) {
    const a = Math.pow(k, -tilt) * (0.75 + 0.5 * rng.next()) * (k === 2 ? 1.2 : 1)
    const ph = rng.next() * TAU
    for (let i = 0; i < N; i++) t[i] += a * Math.sin((TAU * k * i) / N + ph)
  }
  let pk = 0
  for (let i = 0; i < N; i++) pk = Math.max(pk, Math.abs(t[i]))
  const g = pk > 0 ? 1 / pk : 1
  for (let i = 0; i < N; i++) t[i] *= g
  t[N] = t[0]
  return t
}

/**
 * One insect flying past. o: { kind, closest (m), side (+1 right, -1 left),
 * height (m), dur (s), speed (m/s) }. Returns { sig, path } for emitPath.
 */
export function flyBy(sr, rng, o = {}) {
  const k = KINDS[o.kind] || KINDS.bee
  const f0 = R(rng, k.f[0], k.f[1])
  const v = num(o.speed, R(rng, k.speed[0], k.speed[1])) * (rng.next() < 0.5 ? -1 : 1)
  const dur = Math.max(0.5, num(o.dur, R(rng, 2.5, 6)))
  const closest = Math.max(0.15, num(o.closest, R(rng, 0.4, 2.5)))
  const side = num(o.side, rng.next() < 0.5 ? -1 : 1)
  const h = num(o.height, R(rng, -0.3, 0.6))
  const tc = dur * R(rng, 0.35, 0.65)
  const sw1 = R(rng, 0.4, 1.2)
  const sw2 = R(rng, 1.5, 3.5)
  const p1 = rng.next() * TAU
  const p2 = rng.next() * TAU
  const swing = R(rng, 0.15, 0.6) * (o.kind === 'fly' || o.kind === 'mosquito' ? 1.6 : 1)
  // position at time t (meters): x along the pass, y to the side, z height
  const pos = (t, out) => {
    const x = v * (t - tc) + swing * Math.sin(TAU * sw1 * t + p1)
    const y = closest + swing * 0.6 * (1 + Math.sin(TAU * sw2 * t + p2))
    out.x = x
    out.d = Math.sqrt(x * x + y * y + h * h)
  }
  const tmp = { x: 0, d: 1 }
  // side mirrors the pass (left-to-right or right-to-left on top of the speed sign)
  const path = (t, out) => {
    pos(t, tmp)
    out.dist = tmp.d
    out.pan = clamp((tmp.x / tmp.d) * side * 0.95, -1, 1)
  }
  const len = Math.ceil(dur * sr)
  const sig = new Float32Array(len)
  const tab = insectTable(sr, f0 * 1.25, k.tilt, rng)
  const B = 32
  const m = Math.ceil(len / B) + 2
  const wan = smoothNoise(m, B / sr, 0.6, rng)
  const wan2 = smoothNoise(m, B / sr, 0.12, rng)
  let ph = rng.next()
  let dPrev
  pos(0, tmp)
  dPrev = tmp.d
  const fade = Math.min(len / 2, Math.round(0.35 * sr))
  for (let b = 0, j = 0; b < len; b += B, j++) {
    const e = b + B < len ? b + B : len
    const t = (b + B) / sr
    pos(t, tmp)
    const vr = ((tmp.d - dPrev) * sr) / B
    dPrev = tmp.d
    const f = f0 * (1 + k.wander * (0.7 * wan[j] + 0.5 * wan2[j])) * (C / (C + vr))
    const inc = f / sr
    for (let i = b; i < e; i++) {
      const x = ph * 2048
      const ix = x | 0
      const fr = x - ix
      let y = tab[ix] + (tab[ix + 1] - tab[ix]) * fr
      if (i < fade) y *= i / fade
      else if (i > len - fade) y *= (len - i) / fade
      sig[i] = y
      ph += inc
      if (ph >= 1) ph -= 1
    }
  }
  return { sig, path, gain: k.gain }
}

/**
 * Insects flying past now and then. o: { kind, rate (per minute),
 * closest (m), gain, send, first (seconds, earliest start) }.
 */
export function addFlyBys(sc, rng, o = {}) {
  const rate = Math.max(0, num(o.rate, 6)) / 60
  if (!(rate > 0) || !sc.n) return
  const r = rng.fork('flybys-' + (o.kind || 'bee'))
  let t = num(o.first, R(r, 0.2, 2.5))
  let guard = 0
  while (t < sc.dur && guard++ < 2000) {
    const fb = flyBy(sc.sr, r, { kind: o.kind, closest: R(r, 0.5, 1.6) * num(o.closest, 1), dur: o.kind === 'mosquito' ? R(r, 2, 5) : R(r, 2, 5.5) })
    emitPath(sc, fb.sig, t * sc.sr, fb.path, fb.gain * num(o.gain, 1), num(o.send, 0.25))
    t += -Math.log(1 - r.next()) / rate + 0.3
  }
}

/**
 * The hum of a hive. o: { bees, dist, muffle 0..1, gain, send }.
 */
export function hiveHum(sc, rng, o = {}) {
  const { n, sr } = sc
  if (!n) return
  const N = Math.max(1, Math.round(num(o.bees, 60)))
  const muffle = clamp(num(o.muffle, 0.2), 0, 1)
  const tL = new Float32Array(n)
  const tR = new Float32Array(n)
  const dur = sc.dur
  for (let b = 0; b < N; b++) {
    const r = rng.fork('bee' + b)
    const fk = R(r, 205, 265) * (r.next() < 0.15 ? R(r, 0.82, 0.9) : 1)
    const r1 = R(r, 0.05, 0.4)
    const r2 = R(r, 0.6, 2.5)
    const p1 = r.next() * TAU
    const p2 = r.next() * TAU
    const d1 = R(r, 0.01, 0.03)
    const d2 = R(r, 0.004, 0.012)
    const a0 = R(r, 0.5, 1)
    const side = r.next()
    const gl = side < 0.4 ? 1 : side < 0.6 ? 0.7 : 0.25
    const gr = side < 0.4 ? 0.25 : side < 0.6 ? 0.7 : 1
    // spells of activity; each bee starts at its own point in its wingbeat
    let t = r.next() / fk
    let on = r.next() < 0.75
    let spell = R(r, 1, on ? 14 : 5)
    let spellStart = -R(r, 0, spell)
    let fadeIn = on
    while (t < dur) {
      if (t > spellStart + spell) {
        on = !on
        spellStart = t
        spell = R(r, 1, on ? 14 : 5)
        fadeIn = on
      }
      const f = fk * (1 + d1 * Math.sin(TAU * r1 * t + p1) + d2 * Math.sin(TAU * r2 * t + p2))
      if (on) {
        const u = t - spellStart
        const left = spellStart + spell - t
        let env = Math.min(1, u / 0.4, left / 0.4)
        if (!fadeIn) env = Math.min(1, left / 0.4)
        if (env < 0) env = 0
        const a = a0 * env * (0.92 + 0.16 * r.next())
        const x = t * sr
        const i = x | 0
        const fr = x - i
        if (i + 1 < n) {
          tL[i] += a * gl * (1 - fr)
          tL[i + 1] += a * gl * fr
          tR[i] += a * gr * (1 - fr)
          tR[i + 1] += a * gr * fr
        }
      }
      t += 1 / f
    }
  }
  // the box: high pass at 70 Hz, a body resonance, and a low pass that closes when muffled
  const lim = 0.45 * sr
  const fc = Math.min(lim, 2200 * (1 - 0.7 * muffle))
  const scale = ((0.5 * sr) / 235) * (0.9 / Math.sqrt(N)) * 0.045
  for (const tr of [tL, tR]) {
    let hp = 0
    let s0 = 0
    let s1 = 0, s2 = 0
    const ch = 1 - Math.exp((-TAU * 70) / sr)
    // a wingbeat is a smooth push, not a click: its harmonics fall about 6 dB
    // per octave above roughly 450 Hz (one pole), before the box colours it
    const cs = 1 - Math.exp((-TAU * 450) / sr)
    const cl = 1 - Math.exp((-TAU * fc) / sr)
    // body resonance: RBJ peaking EQ at 450 Hz, +7 dB, Q 1.4
    const w0 = (TAU * 450) / sr
    const A = Math.pow(10, 7 / 40)
    const al = Math.sin(w0) / (2 * 1.4)
    const a0 = 1 + al / A
    const b0 = (1 + al * A) / a0
    const b1 = (-2 * Math.cos(w0)) / a0
    const b2 = (1 - al * A) / a0
    const a1 = b1
    const a2 = (1 - al / A) / a0
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    for (let i = 0; i < n; i++) {
      let x = tr[i] * scale
      s0 += cs * (x - s0)
      x = s0
      hp += ch * (x - hp)
      x -= hp
      s1 += cl * (x - s1)
      s2 += cl * (s1 - s2)
      const y = b0 * s2 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = s2
      y2 = y1
      y1 = y < TINY && y > -TINY ? 0 : y
      tr[i] = y1
    }
  }
  const dist = Math.max(0.3, num(o.dist, 2))
  emit(sc, tL, 0, -0.5, dist, num(o.gain, 1), num(o.send, 0.3))
  emit(sc, tR, 0, 0.5, dist, num(o.gain, 1), num(o.send, 0.3))
}

// ---------------------------------------------------------------- the bed

const bed = {
  id: 'beehive',
  name: 'Beehive',
  group: 'nature',
  about: 'Beside a busy hive in a garden: a warm, beating hum, and bees zipping past your head.',
  params: [
    { id: 'intensity', name: 'How busy', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent' },
    { id: 'distance', name: 'Distance from the hive', type: 'number', min: 0.5, max: 20, step: 0.5, def: 2.5, unit: 'meters' },
    { id: 'flybys', name: 'Bees flying past', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent' },
    { id: 'place', name: 'Where you are', type: 'choice', def: 'garden', options: [{ v: 'garden', name: 'At the hive in a garden' }, { v: 'inside', name: 'Ear against the hive' }] },
    { id: 'breeze', name: 'Breeze', type: 'number', min: 0, max: 100, step: 1, def: 15, unit: 'percent' },
  ],
  generate(seconds, sr, p, rng) {
    const q = resolveParams(bed, p || {})
    const r = rng || makeRng('beehive')
    const sc = makeScene(seconds, sr, r)
    if (!sc.n) return { sr: sc.sr, ch: [sc.L, sc.R] }
    const I = q.intensity / 100
    const inside = q.place === 'inside'
    addAir(sc, { hushDb: inside ? -66 : -60, wind: inside ? 0.02 : 0.05 + 0.8 * (q.breeze / 100), gust: 0.5, body: 420, foliage: 0.4, foliageHz: 3200, rustle: inside ? 0 : 0.3, rumble: 0.1 }, r.fork('air'))
    if (I > 0) {
      hiveHum(sc, r.fork('hum'), { bees: 15 + Math.round(I * 90), dist: inside ? 0.35 : q.distance, muffle: inside ? 0.85 : 0.15, gain: inside ? 0.35 : 1.1, send: inside ? 0.6 : 0.25 })
      const fl = q.flybys / 100
      if (fl > 0) {
        if (inside) addFlyBys(sc, r.fork('fly'), { kind: 'bee', rate: 4 * fl * I, closest: 2, gain: 0.25, send: 0.3 })
        else {
          addFlyBys(sc, r.fork('fly'), { kind: 'bee', rate: (4 + 26 * I) * fl, closest: 1 + q.distance * 0.3, gain: 1, send: 0.25 })
          addFlyBys(sc, r.fork('bumble'), { kind: 'bumble', rate: 2 * fl, closest: 1.5, gain: 1, send: 0.25, first: R(r, 3, 12) })
        }
      }
    }
    if (!inside && I > 0) {
      const birds = makeSingers(['whistler', 'carol'], r.fork('birds'), { dist: 45, gainMul: 0.6 })
      runSingers(sc, birds, r.fork('songs'), { rate: 0.5, start: [2, 8] })
    }
    return finishScene(sc, inside ? SPACES.hive : SPACES.field, r.fork('space'), -10)
  },
}

export default bed
