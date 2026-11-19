// beds/ocean.js - Ocean waves on a beach: swell, crash, wash and the fizzing pull-back.
//
// This file also holds the wave engine used by beds/shore-rocks.js.
//
// Technique: each wave is an event with four acts, following the anatomy of
// a breaking wave as sound designers describe it (Farnell, "Designing
// Sound", 2010, on water and on layered event textures):
// 1. the swell rising as the wave steepens (darker noise swelling up),
// 2. the crash: the lip plunges and the break peels along the beach, so the
//    crash is several sections breaking one after another, sweeping across
//    the stereo field, with a low thump for the bigger waves,
// 3. the wash running up the sand (a broad bright hiss), then
// 4. the backwash: foam and sand draining back, a fizz made of thousands of
//    tiny bubble pops whose density follows the draining water; on a pebble
//    beach the stones rattle and grind as the water drags them back.
// Waves come at irregular intervals in sets (every few waves two or three
// bigger ones), over the steady roar of surf breaking farther along the
// shore. Every layer is filtered noise or a density-following crackle
// shaped by per-wave envelopes at control rate, so nothing ever repeats.

import {
  HOP, Rand32, clamp, ctrlLen, smoothCurve, eq, addInto, whiteArr, applyCurve, panGains, finishBed, Impacts, runBed,
} from './rain.js'
import { rustle } from './wind.js'

/** Add a raised-cosine attack then exponential decay to env (control rate). */
function addEnv(env, sr, t0, attack, hold, tau, gain) {
  if (!(gain > 0)) return
  const m = env.length
  const fr = sr / HOP
  const i0 = Math.round(t0 * fr)
  const a = Math.max(1, Math.round(attack * fr))
  const h = Math.max(0, Math.round(hold * fr))
  const dec = Math.exp(-1 / Math.max(1, tau * fr))
  const end = Math.min(m, i0 + a + h + Math.round(tau * fr * 7))
  let d = 1
  for (let i = Math.max(0, i0); i < end; i++) {
    const k = i - i0
    let v
    if (k < a) v = 0.5 - 0.5 * Math.cos((Math.PI * k) / a)
    else if (k < a + h) v = 1
    else {
      v = d
      d *= dec
    }
    env[i] += v * gain
  }
}

/** Filtered noise shaped by a control envelope, added to out. */
function layer(out, sr, rnd, specs, env, gain) {
  const s = whiteArr(out.length, rnd)
  eq(s, sr, specs)
  applyCurve(s, env, gain)
  addInto(out, s)
}

/**
 * The wave engine. Returns { L, R }.
 * o: { size 0..1, period seconds, shore 'sand'|'pebbles'|'rocks', distance 0..1,
 *      spray 0..1 (rocks) }
 */
export function oceanLayer(n, sr, rng, o = {}) {
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  if (n === 0) return { L, R }
  const rnd = new Rand32(rng.fork('ocean'))
  const ernd = new Rand32(rng.fork('waves'))
  const m = ctrlLen(n)
  const cr = sr / HOP
  const dur = n / sr
  const size = clamp(o.size === undefined ? 0.5 : o.size, 0, 1)
  const period = clamp(o.period || 9, 2, 30)
  const shore = o.shore === 'pebbles' || o.shore === 'rocks' ? o.shore : 'sand'
  const rocks = shore === 'rocks'
  const dist = clamp(o.distance || 0, 0, 1)
  const spray = clamp(o.spray === undefined ? 0.5 : o.spray, 0, 1)

  const mk = () => [new Float32Array(m), new Float32Array(m)]
  const swell = mk()
  const cLow = mk()
  const cMid = mk()
  const cHigh = mk()
  const wash = mk()
  const fizz = mk()
  const peb = mk()
  const thump = new Float32Array(m)
  const pg = new Float64Array(2)
  const both = (pair, pan, t0, at, hold, tau, g) => {
    panGains(pan, pg)
    addEnv(pair[0], sr, t0, at, hold, tau, g * pg[0] * 1.41)
    addEnv(pair[1], sr, t0, at, hold, tau, g * pg[1] * 1.41)
  }
  const imp = rocks ? new Impacts(L, R, sr, rnd) : null

  // Wave schedule: one already draining at the start, the next breaking soon.
  let tc = -period * ernd.range(0.3, 0.5)
  let inSet = 0
  let untilSet = 3 + ernd.int(4)
  const calm = 1 - smoothSize(size)
  while (tc < dur + 1) {
    let h = (0.25 + 0.75 * size) * ernd.range(0.7, 1.15)
    if (inSet > 0) {
      h *= 1.3
      inSet--
    } else if (--untilSet <= 0) {
      inSet = 1 + ernd.int(2)
      untilSet = 4 + ernd.int(4)
    }
    const side = ernd.chance(0.5) ? 1 : -1
    const pStart = side * ernd.range(0.3, 0.9)
    const pEnd = -side * ernd.range(0.1, 0.8)
    if (!rocks) {
      // 1. the swell
      both(swell, pStart * 0.5, tc - 2.6, 2.4, 0, 0.5, h * (0.25 + 0.2 * size))
      // 2. the crash, peeling along the beach
      const S = 3 + ernd.int(4)
      const dt = ernd.range(0.12, 0.35) * (0.7 + 0.6 * calm)
      for (let j = 0; j < S; j++) {
        const x = S > 1 ? j / (S - 1) : 0
        const pan = pStart + (pEnd - pStart) * x
        const g = h * ernd.range(0.6, 1) * (1 - 0.12 * j)
        const at = ernd.range(0.06, 0.2) * (1 + 2.5 * calm)
        const tau = ernd.range(0.45, 0.9) * (1 + 0.4 * size)
        both(cLow, pan, tc + j * dt, at, 0.05, tau, g * 0.8)
        both(cMid, pan, tc + j * dt, at, 0.05, tau * 0.9, g * (0.4 + 0.6 * size))
        both(cHigh, pan, tc + j * dt, at * 0.8, 0.02, tau * 0.7, g * size * size * 0.9)
      }
      addEnv(thump, sr, tc, 0.03, 0, 0.32, h * h * size * 0.9)
      // 3. the wash up the beach (closer, wider)
      const wStart = tc + ernd.range(0.35, 0.7)
      both(wash, ernd.bi() * 0.3, wStart, ernd.range(0.6, 1.1), ernd.range(0.6, 1.6), ernd.range(0.8, 1.4), h * (0.5 + 0.3 * calm))
      // 4. the backwash: fizz and, on pebbles, the grinding rattle
      const bStart = wStart + ernd.range(1.4, 2.4)
      const bTau = ernd.range(1.2, 2.2)
      both(fizz, ernd.bi() * 0.3, bStart, 0.5, 0.3, bTau, h)
      both(fizz, ernd.bi() * 0.4, wStart + 0.2, 0.4, 0.4, 0.9, h * 0.45)
      if (shore === 'pebbles') {
        both(peb, ernd.bi() * 0.4, bStart - 0.3, 0.6, 0.6, bTau * 0.9, h)
        both(peb, ernd.bi() * 0.4, wStart, 0.5, 0.2, 0.7, h * 0.4)
      }
    } else {
      // Against rocks: a boom, a slap, spray, then water falling back and draining.
      const pan = pStart * 0.8
      both(swell, pan * 0.5, tc - 2.2, 2, 0, 0.4, h * 0.3)
      const hits = 1 + ernd.int(3)
      for (let j = 0; j < hits; j++) {
        const tj = tc + j * ernd.range(0.08, 0.4)
        const pj = clamp(pan + ernd.bi() * 0.35, -1, 1)
        const g = h * ernd.range(0.6, 1) * (j === 0 ? 1 : 0.6)
        addEnv(thump, sr, tj, 0.012, 0, 0.28, g * g * 1.4)
        both(cLow, pj, tj, 0.015, 0.02, 0.35, g * 0.9)
        both(cMid, pj, tj, 0.01, 0.01, 0.18, g * 1.1)
        both(cHigh, pj, tj + 0.02, 0.05, 0.05, 0.5 + 0.4 * spray, g * (0.4 + 0.8 * spray))
        // Water falling back as drops and splashes.
        const drops = Math.round((20 + 90 * spray) * g)
        for (let d = 0; d < drops; d++) {
          const td = tj + 0.15 + Math.pow(rnd.next(), 1.6) * (0.6 + 1.6 * spray)
          const pd = clamp(pj + rnd.bi() * 0.5, -1, 1)
          const a = 0.04 * g * rnd.range(0.3, 1)
          imp.burst(td, a, pd, rnd.range(1800, 5000), 1, rnd.range(0.0008, 0.002), 0.2)
          if (rnd.chance(0.45)) imp.bubble(td + 0.001, a * 0.45, pd, rnd.logRange(600, 3000), rnd.range(0.1, 0.3))
        }
        // Gurgles and glugs in the crevices as it drains.
        const glugs = 3 + rnd.int(8)
        for (let d = 0; d < glugs; d++) {
          const td = tj + rnd.range(0.4, 3.5)
          const f = rnd.logRange(140, 520)
          const a = 0.05 * g * rnd.range(0.4, 1)
          const pd = clamp(pj + rnd.bi() * 0.4, -1, 1)
          imp.bubble(td, a, pd, f, rnd.range(0.2, 0.55), rnd.range(0.6, 1.2))
          if (rnd.chance(0.5)) imp.bubble(td + rnd.range(0.03, 0.09), a * 0.7, pd, f * rnd.range(1.1, 1.5), rnd.range(0.2, 0.5))
        }
      }
      // Draining trickle off the rock faces.
      both(fizz, pan * 0.6, tc + 0.6, 0.4, 0.5, 1.6, h * 0.6)
      both(wash, ernd.bi() * 0.4, tc + 0.3, 0.3, 0.3, 0.9, h * 0.3)
    }
    tc += period * ernd.range(0.7, 1.3)
  }

  // The bubble cloud a breaking wave traps (Deane 1997, "Sound generation
  // and air entrainment by breaking waves in the surf zone", JASA 102):
  // Minnaert bubbles whose density follows the crash and the wash, which is
  // what makes surf sound wet rather than like wind.
  {
    const bimp = imp || new Impacts(L, R, sr, rnd)
    const envSum = new Float32Array(m)
    let eMax = 1e-9
    for (let i = 0; i < m; i++) {
      const v = cMid[0][i] + cMid[1][i] + cLow[0][i] + cLow[1][i] + 0.8 * (wash[0][i] + wash[1][i]) + 0.5 * (fizz[0][i] + fizz[1][i])
      envSum[i] = v
      if (v > eMax) eMax = v
    }
    const nearB = 1 - 0.8 * dist
    const lamMax = (500 + 1700 * size) * nearB
    if (lamMax > 1) {
      let t = rnd.exp(1 / lamMax)
      while (t < dur) {
        const e = envSum[Math.min(m - 1, Math.floor((t * sr) / HOP))] / eMax
        if (rnd.next() < e) {
          const r = rnd.logRange(0.0006, rocks ? 0.008 : 0.005)
          const a = 0.03 * Math.sqrt(e) * Math.pow(r / 0.002, 0.7) * rnd.range(0.2, 1) * nearB
          bimp.bubble(t, a, rnd.bi() * 0.9, 3 / r, rnd.range(0.08, 0.3))
        }
        t += rnd.exp(1 / lamMax)
      }
    }
  }

  // Steady surf farther along the shore.
  const roar = smoothCurve(m, cr, ernd, 0.06, 3)
  const roarL = new Float32Array(m)
  const roarR = new Float32Array(m)
  const base = (0.12 + 0.25 * size) * (1 + 1.2 * dist)
  for (let i = 0; i < m; i++) {
    roarL[i] = base * clamp(1 + 0.45 * roar[i], 0.3, 2)
    roarR[i] = base * clamp(1 + 0.45 * roar[(i + Math.round(cr * 1.5)) % m], 0.3, 2)
  }

  const nearG = 1 - 0.7 * dist
  for (let c = 0; c < 2; c++) {
    const out = c === 0 ? L : R
    layer(out, sr, rnd, [['lowpass', 380, 0.7], ['lowpass', 900, 0.7], ['highpass', 40, 0.7]], c === 0 ? roarL : roarR, 0.55)
    layer(out, sr, rnd, [['lowpass', 500, 0.7], ['highpass', 50, 0.7]], swell[c], 0.6 * nearG)
    layer(out, sr, rnd, [['bandpass', 260, 0.6], ['lowpass', 900, 0.7]], cLow[c], 1.2 * nearG)
    layer(out, sr, rnd, [['bandpass', 1000, 0.5], ['lowpass', 5000, 0.7]], cMid[c], 0.75 * nearG)
    layer(out, sr, rnd, [['bandpass', 3200, 0.5], ['lowpass', 11000, 0.7]], cHigh[c], 0.55 * nearG)
    layer(out, sr, rnd, [['highpass', 600, 0.6], ['peak', 2600, 0.6, 3], ['lowpass', 10000, 0.6]], wash[c], 0.32 * nearG)
    const fz = rustle(n, sr, rnd, fizz[c], 0, rocks ? 9000 : 14000, 0.2, 0.05, [['highpass', 2600, 0.6], ['peak', 6000, 0.7, 3], ['lowpass', 13000, 0.6]])
    addInto(out, fz, 0.22 * nearG * nearG)
    if (shore === 'pebbles') {
      const pb = rustle(n, sr, rnd, peb[c], 0, 4000, 1.2, 0.05, [['bandpass', 2400, 1.6], ['peak', 4200, 1.5, 4], ['highpass', 700, 0.6]])
      addInto(out, pb, 0.4 * nearG)
    }
  }
  // The thump is felt as much as heard: low and centred.
  {
    const s = whiteArr(n, rnd)
    eq(s, sr, [['lowpass', 110, 0.7], ['lowpass', 160, 0.7], ['highpass', 30, 0.7]])
    applyCurve(s, thump, rocks ? 4.5 : 3.2)
    addInto(L, s, nearG)
    addInto(R, s, nearG)
  }
  if (imp) imp.renderBanks()
  if (dist > 0.02) {
    const fc = 15000 * Math.pow(1 - dist, 1.8) + 1500
    for (const s of [L, R]) eq(s, sr, [['lowpass', fc, 0.6]])
  }
  return { L, R }
}

function smoothSize(x) {
  return clamp(x * 1.6, 0, 1)
}

const bed = {
  id: 'ocean',
  name: 'Ocean waves',
  group: 'water',
  about: 'Waves rolling onto a beach, crashing, washing up the sand and fizzing back, from calm lapping to big surf.',
  params: [
    { id: 'size', name: 'Wave size', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [15, 90] },
    { id: 'period', name: 'Time between waves', type: 'number', min: 4, max: 16, step: 0.5, def: 9, unit: 'seconds', rand: [6, 13] },
    {
      id: 'shore',
      name: 'Beach',
      type: 'choice',
      def: 'sand',
      options: [
        { v: 'sand', name: 'Sandy beach' },
        { v: 'pebbles', name: 'Pebble beach' },
      ],
    },
    { id: 'distance', name: 'Distance', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 70] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const { L, R } = oceanLayer(n, s.sr, s.rng, {
        size: q.size / 100,
        period: q.period,
        shore: q.shore,
        distance: q.distance / 100,
      })
      finishBed(L, R, s.sr, -19.5 + (q.size - 50) * 0.1 - q.distance * 0.04, 3)
      return { L, R }
    })
  },
}

export default bed
