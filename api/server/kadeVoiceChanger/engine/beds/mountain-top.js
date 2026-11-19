// beds/mountain-top.js - On a windy summit above a wide valley.
//
// Up high the wind is the place: a strong, gusting roar with nothing to
// break it, the low buffeting of air rushing past your ears, and rock edges
// that whistle. The roar and hiss come from the shared air model
// (forest-birds.js addAir) turned up and opened out; on top of it:
// - whistles: narrow band passes on noise whose centre rises and falls with
//   the gust speed, the way an edge tone follows the flow (Strouhal: the
//   shedding frequency is proportional to wind speed over the edge size);
// - buffeting: low noise below about 120 Hz with fast flutter, rising
//   steeply with the gusts.
// Far below, a hawk cries now and then (a hoarse falling scream from the
// harmonic voice in wolves-far.js) and the valley answers with long echoes
// whose delay follows the valley size. Optionally a far herd grazes with
// bells: sheet-metal bell clanks from modal synthesis (seagulls-harbor.js)
// in the slow, uneven rhythm of animals stepping and pulling grass.

import { makeRng } from '../core/rng.js'
import { resolveParams } from '../core/params.js'
import { makeScene, emit, addAir, finishScene, drawPan, SPACES, clamp, smoothNoise } from './forest-birds.js'
import { harmonicVoice } from './wolves-far.js'
import { modalInto } from './seagulls-harbor.js'

const TAU = Math.PI * 2

function R(rng, a, b) {
  return a + (b - a) * rng.next()
}

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

/**
 * Whistling edges and low buffeting that follow the scene's gusts (call
 * after addAir). o: { strength 0..1, whistle 0..1, buffet 0..1 }.
 */
export function addGale(sc, rng, o = {}) {
  const { n, sr, L, R: Rt } = sc
  if (!n || !sc.gust) return
  const strength = clamp(num(o.strength, 0.6), 0, 1)
  const whistle = clamp(num(o.whistle, 0.4), 0, 1)
  const buffet = clamp(num(o.buffet, 0.4), 0, 1)
  const gust = sc.gust
  const step = sc.gustStep
  const lim = 0.45 * sr
  // whistles
  const nw = whistle > 0 ? 3 : 0
  for (let w = 0; w < nw; w++) {
    const r = rng.fork('whistle' + w)
    const base = R(r, 420, 1500)
    const q = R(r, 18, 40)
    const pan = R(r, -0.8, 0.8)
    const a = ((pan + 1) * Math.PI) / 4
    const gl = Math.cos(a)
    const gr = Math.sin(a)
    const thr = R(r, 0.22, 0.42)
    let xs = (r.uint32() | 1) >>> 0
    const wob = smoothNoise(Math.ceil(n / step) + 2, step / sr, 0.5, r)
    // whistles flicker as eddies come and go
    const flick = smoothNoise(Math.ceil(n / step) + 2, step / sr, 0.16, r.fork('flicker'))
    let ic1 = 0
    let ic2 = 0
    const k = 1 / q
    for (let b = 0, j = 0; b < n; b += step, j++) {
      const e = b + step < n ? b + step : n
      const g = gust[j]
      const f = Math.min(lim * 0.9, base * (0.7 + 0.7 * g) * (1 + 0.03 * wob[j]))
      const tg = Math.tan((Math.PI * f) / sr)
      const a1 = 1 / (1 + tg * (tg + k))
      const a2 = tg * a1
      const a3 = tg * a2
      // a whistle only sounds above a threshold speed; the band pass output
      // is scaled back up by its bandwidth so lev is the whistle's own level
      const norm = 1 / (0.577 * Math.sqrt((2 * f) / (q * sr)))
      const lev = ((whistle * strength * Math.max(0, g - thr)) / (1 - thr)) * 0.3 * norm * Math.max(0, 0.55 + 0.6 * flick[j])
      for (let i = b; i < e; i++) {
        xs ^= xs << 13
        xs ^= xs >>> 17
        xs ^= xs << 5
        const v3 = (xs | 0) * 4.656612873077393e-10 - ic2
        const v1 = a1 * ic1 + a2 * v3
        const v2 = ic2 + a2 * ic1 + a3 * v3
        ic1 = 2 * v1 - ic1
        ic2 = 2 * v2 - ic2
        const y = v1 * k * lev
        L[i] += y * gl
        Rt[i] += y * gr
      }
      if (!(ic1 > -1e9 && ic1 < 1e9)) ic1 = ic2 = 0
    }
  }
  // buffeting: low passed noise with a fast flutter
  if (buffet > 0) {
    const r = rng.fork('buffet')
    let xl = (r.fork('l').uint32() | 1) >>> 0
    let xr = (r.fork('r').uint32() | 1) >>> 0
    const fl = smoothNoise(Math.ceil(n / step) + 2, step / sr, 0.18, r.fork('flutter'))
    const c = 1 - Math.exp((-TAU * 110) / sr)
    let l1 = 0, l2 = 0, r1 = 0, r2 = 0
    for (let b = 0, j = 0; b < n; b += step, j++) {
      const e = b + step < n ? b + step : n
      const g = gust[j]
      const lev = buffet * strength * strength * Math.pow(g, 3) * (0.5 + 0.5 * Math.max(0, fl[j] + 0.3)) * 1.6
      for (let i = b; i < e; i++) {
        xl ^= xl << 13
        xl ^= xl >>> 17
        xl ^= xl << 5
        xr ^= xr << 13
        xr ^= xr >>> 17
        xr ^= xr << 5
        const nl = (xl | 0) * 4.656612873077393e-10
        const nr = (xr | 0) * 4.656612873077393e-10
        l1 += c * (nl - l1)
        l2 += c * (l1 - l2)
        r1 += c * (nr * 0.6 + nl * 0.4 - r1)
        r2 += c * (r1 - r2)
        L[i] += l2 * lev
        Rt[i] += r2 * lev
      }
    }
  }
}

/** A hawk's hoarse falling scream. */
export function hawkCry(sr, rng) {
  const d = R(rng, 1.1, 2.1)
  const F = R(rng, 2700, 3300)
  return harmonicVoice(sr, rng, {
    dur: d,
    f: [[0, F * 0.72], [0.12, F], [0.4, F * 0.95], [d, F * 0.62]],
    amp: [[0, 0], [0.08, 1], [d * 0.6, 0.8], [d, 0]],
    formants: [[3000, 2500, 0]],
    tilt: -10,
    nh: 4,
    jitter: 60,
    rough: 0.12,
    breath: 0.55,
  })
}

// Sheet-metal bell partials (uneven, short), per bell.
function bellModes(rng) {
  return [[1, 1, 1], [R(rng, 1.4, 1.6), 0.7, 0.7], [R(rng, 2, 2.3), 0.5, 0.5], [R(rng, 2.5, 2.8), 0.4, 0.35], [R(rng, 3.1, 3.5), 0.3, 0.25], [R(rng, 4.1, 4.6), 0.2, 0.15]]
}

/** A far herd grazing with bells. o: { count, dist, gain, send }. */
export function addHerdBells(sc, rng, o = {}) {
  const sr = sc.sr
  const count = Math.max(0, Math.round(num(o.count, 4)))
  for (let c = 0; c < count; c++) {
    const r = rng.fork('cow' + c)
    const f = R(r, 480, 900)
    const modes = bellModes(r)
    const pan = R(r, -0.8, 0.8)
    const dist = num(o.dist, 500) * R(r, 0.8, 1.3)
    let t = R(r, 0, 4)
    while (t < sc.dur) {
      const k = 2 + r.int(6)
      const ev = new Float32Array(Math.ceil((k * 0.6 + 1) * sr))
      let tt = 0
      for (let i = 0; i < k; i++) {
        modalInto(ev, Math.round(tt * sr), sr, f, modes, R(r, 0.25, 0.5), R(r, 0.3, 0.8), R(r, 0.3, 1), r)
        tt += R(r, 0.18, 0.6)
      }
      emit(sc, ev, t * sr, pan, dist, num(o.gain, 1), num(o.send, 0.6))
      t += tt + R(r, 2, 9)
    }
  }
}

// ---------------------------------------------------------------- the bed

const bed = {
  id: 'mountain-top',
  name: 'Mountain top',
  group: 'nature',
  about: 'A windy summit: gusts roaring past your ears, whistling rocks, a hawk crying far below, echoes.',
  params: [
    { id: 'intensity', name: 'Wind strength', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent' },
    { id: 'gusts', name: 'Gustiness', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent' },
    { id: 'whistle', name: 'Whistling rocks', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent' },
    { id: 'valley', name: 'Valley size', type: 'number', min: 200, max: 3000, step: 50, def: 900, unit: 'meters' },
    { id: 'hawk', name: 'Hawk crying far off', type: 'bool', def: true },
    { id: 'bells', name: 'Far herd with bells', type: 'bool', def: false },
  ],
  generate(seconds, sr, p, rng) {
    const q = resolveParams(bed, p || {})
    const r = rng || makeRng('mountain-top')
    const sc = makeScene(seconds, sr, r)
    if (!sc.n) return { sr: sc.sr, ch: [sc.L, sc.R] }
    const W = q.intensity / 100
    const G = q.gusts / 100
    addAir(sc, { hushDb: -56, wind: 0.06 + 0.94 * W, gust: 0.2 + 0.8 * G, body: 650, foliage: 0.35, foliageHz: 5500, rustle: 0.04, rumble: 0.5, gustPeriod: 7, windGain: 4, gustBias: 0.1 }, r.fork('air'))
    addGale(sc, r.fork('gale'), { strength: 0.15 + 0.85 * W, whistle: q.whistle / 100, buffet: 0.5 })
    // the valley's echoes follow its size
    const k = q.valley / 900
    const space = Object.assign({}, SPACES.summit, { echoes: SPACES.summit.echoes.map((e) => [e[0] * k, e[1] / Math.sqrt(Math.max(0.5, k)), e[2], e[3]]) })
    if (q.hawk) {
      const hr = r.fork('hawk')
      let t = R(hr, 0.8, 5)
      while (t < sc.dur) {
        const ev = hawkCry(sc.sr, hr)
        emit(sc, ev, t * sc.sr, drawPan(hr, 0.85), R(hr, 150, 450), 6, 0.9)
        t += ev.length / sc.sr + R(hr, 5, 16)
      }
    }
    if (q.bells) addHerdBells(sc, r.fork('herd'), { count: 4, dist: q.valley * 0.5, gain: 3, send: 0.7 })
    return finishScene(sc, space, r.fork('space'), -10)
  },
}

export default bed
