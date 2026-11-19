// beds/wind.js - Wind: a rushing, gusting airstream with whistles and a low rumble.
//
// This file also holds the wind engine that the storm, howl, trees, blizzard
// and desert beds use.
//
// Techniques and their published sources:
// - Wind as moving band-passed noise, after Andy Farnell, "Designing Sound"
//   (MIT Press 2010), the wind chapter: one slowly varying "wind speed"
//   control drives the centre frequency, brightness and loudness of several
//   noise bands at once, so a gust gets louder, brighter and higher together
//   as real wind does.
// - The speed signal is the sum of slow swells, gust events (raised-cosine
//   rise, hold and fall at random times) and fast turbulence, each a smooth
//   random curve. The right ear hears the gust a fraction of a second after
//   the left (or the other way round), so gusts sweep across.
// - Whistles and howls are aeolian tones and cavity resonances: noise
//   through two cascaded high-Q bandpasses whose pitch follows the wind
//   speed (an aeolian tone's frequency is the Strouhal number times speed
//   over size, about 0.2 U / d; Strouhal 1878). They speak only above a
//   threshold speed, which is why real whistles come and go with gusts.
// - Filters are the topology-preserving state-variable filter of Zavalishin,
//   "The Art of VA Filter Design" (2012), in Simper's form, which stays
//   stable while its frequency moves every few samples.
// - Leaves and needles: rustle made of many tiny clicks whose density
//   follows each tree's own lagged share of the gust (Farnell's tree rustle),
//   so the trees answer one after another across the stereo field.

import {
  HOP, Rand32, clamp, smoothstep, ctrlLen, smoothCurve, eq, addInto, panGains, finishBed, Impacts, runBed,
} from './rain.js'

const TWO_PI = 2 * Math.PI

/**
 * Wind speed control curve (one value per HOP samples), roughly
 * strength * (0.4 .. 1.8). gusts 0..1 sets how much it varies.
 */
export function windSpeed(m, sr, rnd, strength, gusts) {
  const cr = sr / HOP
  const dur = (m * HOP) / sr
  const slow = smoothCurve(m, cr, rnd, 0.03, 2)
  const mid = smoothCurve(m, cr, rnd, 0.14, 3)
  const fast = smoothCurve(m, cr, rnd, 1.1, 3)
  const gust = new Float32Array(m)
  const rate = 0.05 + 0.2 * gusts
  let t = rnd.range(0.2, 3)
  while (t < dur) {
    const g = rnd.range(0.35, 1)
    const atk = rnd.range(0.6, 2.4)
    const hold = rnd.range(0.2, 1.8)
    const rel = rnd.range(1.4, 4.5)
    const i0 = Math.floor((t * sr) / HOP)
    const a = Math.max(1, Math.round((atk * sr) / HOP))
    const h = Math.round((hold * sr) / HOP)
    const r = Math.max(1, Math.round((rel * sr) / HOP))
    for (let k = 0; k < a + h + r; k++) {
      const i = i0 + k
      if (i >= m) break
      let v
      if (k < a) v = 0.5 - 0.5 * Math.cos((Math.PI * k) / a)
      else if (k < a + h) v = 1
      else v = 0.5 + 0.5 * Math.cos((Math.PI * (k - a - h)) / r)
      v *= g
      if (v > gust[i]) gust[i] = v
    }
    t += rnd.exp(1 / rate)
  }
  const u = new Float32Array(m)
  for (let i = 0; i < m; i++) {
    const v = strength * (0.8 + 0.25 * slow[i] + gusts * (0.6 * mid[i] + 0.85 * gust[i] - 0.22) + 0.08 * fast[i])
    u[i] = clamp(v, strength * 0.42 + 0.02, 1.9)
  }
  return u
}

/** Delay a control curve by d frames (holding the first value). */
function lagCurve(c, d) {
  const out = new Float32Array(c.length)
  for (let i = 0; i < c.length; i++) out[i] = c[i - d >= 0 ? i - d : 0]
  return out
}

/**
 * Band of noise through `stages` cascaded TPT bandpasses (unity peak) whose
 * centre follows fc (control curve, Hz) and whose level follows gain
 * (control curve), added into out with weight w. Allocation-free.
 */
export function bandNoise(out, sr, rnd, fc, q, gain, w = 1, stages = 1) {
  const n = out.length
  let s = rnd.s
  let a1 = 0, a2 = 0, a3 = 0, k = 1 / q
  let i1 = 0, i2 = 0, j1 = 0, j2 = 0
  const fmax = sr * 0.45
  for (let b = 0, i = 0; i < n; b++) {
    const bi = b < fc.length ? b : fc.length - 1
    let f = fc[bi]
    if (f > fmax) f = fmax
    if (f < 8) f = 8
    const g = Math.tan((Math.PI * f) / sr)
    a1 = 1 / (1 + g * (g + k))
    a2 = g * a1
    a3 = g * a2
    const g0 = gain[bi] * w
    const g1 = gain[bi + 1 < gain.length ? bi + 1 : gain.length - 1] * w
    const dg = (g1 - g0) / HOP
    let gg = g0
    const end = Math.min(n, i + HOP)
    if (g0 === 0 && g1 === 0) {
      // Keep the filter running quietly so it does not click when it returns.
      for (; i < end; i++) {
        s ^= s << 13
        s ^= s >>> 17
        s ^= s << 5
        const x = s / 2147483648
        const v3 = x - i2
        const v1 = a1 * i1 + a2 * v3
        const v2 = i2 + a2 * i1 + a3 * v3
        i1 = 2 * v1 - i1
        i2 = 2 * v2 - i2
      }
      continue
    }
    for (; i < end; i++) {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      const x = s / 2147483648
      let v3 = x - i2
      let v1 = a1 * i1 + a2 * v3
      let v2 = i2 + a2 * i1 + a3 * v3
      i1 = 2 * v1 - i1
      i2 = 2 * v2 - i2
      let y = k * v1
      if (stages > 1) {
        v3 = y - j2
        v1 = a1 * j1 + a2 * v3
        v2 = j2 + a2 * j1 + a3 * v3
        j1 = 2 * v1 - j1
        j2 = 2 * v2 - j2
        y = k * v1
      }
      out[i] += y * gg
      gg += dg
    }
    if (!(i1 > -1e9 && i1 < 1e9)) i1 = i2 = j1 = j2 = 0
    if (i1 < 1e-20 && i1 > -1e-20) i1 = 0
    if (i2 < 1e-20 && i2 > -1e-20) i2 = 0
    if (j1 < 1e-20 && j1 > -1e-20) j1 = 0
    if (j2 < 1e-20 && j2 > -1e-20) j2 = 0
  }
  rnd.s = s
}

/**
 * Rustle: tiny clicks whose density follows env (control curve 0..1),
 * each a fast decaying tick, into a temp array, then coloured. Returns it.
 */
export function rustle(n, sr, rnd, env, d0, d1, decayMs, noiseAmt, colour) {
  const out = new Float32Array(n)
  let s = rnd.s
  const dec = Math.exp(-1000 / (decayMs * sr))
  let y = 0
  for (let b = 0, i = 0; i < n; b++) {
    const e = env[b < env.length ? b : env.length - 1]
    const e1 = env[b + 1 < env.length ? b + 1 : env.length - 1]
    const de = (e1 - e) / HOP
    let ee = e
    const thr = clamp((d0 + d1 * e * e) / sr, 0, 1) * 4294967296
    const end = Math.min(n, i + HOP)
    for (; i < end; i++, ee += de) {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      let x = 0
      if ((s >>> 0) < thr) {
        s ^= s << 13
        s ^= s >>> 17
        s ^= s << 5
        const u = s / 2147483648
        x = u * u * u * 4
      }
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      y = y * dec + x
      out[i] = (y + (s / 2147483648) * noiseAmt) * ee
    }
  }
  rnd.s = s
  eq(out, sr, colour)
  return out
}

const LEAVES = {
  summer: { decayMs: 1.4, noise: 0.25, d0: 150, d1: 9000, colour: [['highpass', 900, 0.6], ['peak', 2400, 0.8, 4], ['lowpass', 7500, 0.6]], gain: 0.55 },
  dry: { decayMs: 0.5, noise: 0.08, d0: 60, d1: 6000, colour: [['highpass', 1800, 0.6], ['peak', 4800, 0.9, 5], ['lowpass', 12000, 0.6]], gain: 0.7 },
  pine: { decayMs: 2.5, noise: 1.2, d0: 0, d1: 2000, colour: [['highpass', 1300, 0.6], ['peak', 3200, 0.5, 3], ['lowpass', 8000, 0.6]], gain: 0.28 },
}

export const LEAF_KINDS = Object.keys(LEAVES)

/**
 * The wind engine. Returns { L, R, speed } (speed is the control curve).
 * o: { strength 0..1, gusts 0..1, whistle 0..1, whistleHz, howl 0..1, howlHz,
 *      rumble 0..1, rush 0..1 (default 1), leaves 0..1, leafKind, trees 1..8,
 *      snow 0..1, sand 0..1, dunes 0..1, rattle 0..1, inside bool,
 *      distance 0..1, speed (optional control curve to use) }
 */
export function windLayer(n, sr, rng, o = {}) {
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  if (n === 0) return { L, R, speed: new Float32Array(2) }
  const rnd = new Rand32(rng.fork('wind'))
  const crnd = new Rand32(rng.fork('wind-curves'))
  const m = ctrlLen(n)
  const cr = sr / HOP
  const strength = clamp(o.strength === undefined ? 0.45 : o.strength, 0, 1.2)
  const gusts = clamp(o.gusts === undefined ? 0.5 : o.gusts, 0, 1)
  const u = o.speed || windSpeed(m, sr, crnd, 0.15 + 0.85 * strength, gusts)
  const sweep = Math.round(((crnd.range(0.2, 0.5) * sr) / HOP) * (crnd.chance(0.5) ? 1 : -1))
  const uL = sweep > 0 ? u : lagCurve(u, -sweep)
  const uR = sweep > 0 ? lagCurve(u, sweep) : u
  const inside = !!o.inside
  const rush = o.rush === undefined ? 1 : o.rush
  const fc = new Float32Array(m)
  const gn = new Float32Array(m)

  for (let c = 0; c < 2; c++) {
    const out = c === 0 ? L : R
    const uc = c === 0 ? uL : uR
    const turb = smoothCurve(m, cr, crnd, 2.2, 3)
    // Low rush: the body of the airstream.
    for (let i = 0; i < m; i++) {
      const v = uc[i] * (1 + 0.08 * turb[i])
      fc[i] = 110 + 230 * v + 160 * v * v
      gn[i] = 0.9 * Math.pow(v, 1.5) * rush
    }
    bandNoise(out, sr, rnd, fc, 0.85, gn, 1, 1)
    // High rush: air tearing past edges, much brighter in gusts.
    for (let i = 0; i < m; i++) {
      const v = uc[i] * (1 + 0.12 * turb[i])
      fc[i] = 520 + 950 * v + 480 * v * v
      gn[i] = 0.4 * Math.pow(v, 2.2) * rush * (inside ? 0.25 : 1)
    }
    bandNoise(out, sr, rnd, fc, 0.7, gn, 1, 1)
    // Low rumble: buffeting.
    if ((o.rumble || 0) > 0) {
      const amp = smoothCurve(m, cr, crnd, 3, 2)
      for (let i = 0; i < m; i++) {
        const v = uc[i]
        fc[i] = 55 + 40 * v
        gn[i] = 2.2 * o.rumble * Math.pow(v, 2.4) * clamp(1 + 1.6 * amp[i], 0, 3)
      }
      bandNoise(out, sr, rnd, fc, 0.6, gn, 1, 2)
    }
  }

  // Whistles (high, thin) and howls (low, moaning): pitched resonances that
  // speak when the wind passes a threshold and slide up as it rises.
  const tones = []
  // Thresholds sit near this bed's own typical speed, so tones speak in its gusts.
  let typical = 0
  for (let i = 0; i < m; i++) typical += u[i]
  typical /= m
  if ((o.whistle || 0) > 0) {
    const base = o.whistleHz || crnd.range(900, 1700)
    for (let k = 0; k < 3; k++) tones.push({ f: base * [1, 1.37, 1.83][k] * crnd.range(0.96, 1.04), q: crnd.range(18, 32), th: typical * crnd.range(0.75, 1.2), g: o.whistle * [1, 0.6, 0.4][k], pan: crnd.bi() * 0.8, lag: crnd.int(Math.round(cr * 0.8)) })
  }
  if ((o.howl || 0) > 0) {
    const base = o.howlHz || 330
    for (let k = 0; k < 3; k++) tones.push({ f: base * [1, 1.19, 1.5][k] * crnd.range(0.98, 1.02), q: crnd.range(30, 45), th: typical * (crnd.range(0.6, 0.9) + k * 0.12), g: o.howl * [1, 0.55, 0.4][k], pan: (k - 1) * 0.5 + crnd.bi() * 0.2, lag: crnd.int(Math.round(cr * 0.6)), howl: true })
  }
  if (tones.length) {
    const tmp = new Float32Array(n)
    const pg = new Float64Array(2)
    for (const tn of tones) {
      tmp.fill(0)
      const ul = lagCurve(u, tn.lag)
      const wob = smoothCurve(m, cr, crnd, 0.4, 3)
      const flutter = smoothCurve(m, cr, crnd, 4, 2)
      for (let i = 0; i < m; i++) {
        const sp = ul[i]
        fc[i] = tn.f * (0.62 + 0.55 * sp) * (1 + 0.03 * wob[i] + 0.006 * flutter[i])
        gn[i] = tn.g * smoothstep(tn.th, tn.th + 0.45 * typical + 0.05, sp) * Math.sqrt(tn.q) * (tn.howl ? 2.6 : 1.6) * (0.8 + 0.2 * flutter[i])
      }
      bandNoise(tmp, sr, rnd, fc, tn.q, gn, 1, 2)
      panGains(tn.pan, pg)
      addInto(L, tmp, pg[0])
      addInto(R, tmp, pg[1])
    }
  }

  // Trees: each answers the gust a little later, from its own place.
  if ((o.leaves || 0) > 0) {
    const kind = LEAVES[o.leafKind] || LEAVES.summer
    const trees = clamp(Math.round(o.trees || 4), 1, 8)
    const pg = new Float64Array(2)
    const env = new Float32Array(m)
    const swish = new Float32Array(n)
    for (let k = 0; k < trees; k++) {
      const pan = trees === 1 ? 0 : -0.9 + (1.8 * k) / (trees - 1) + crnd.bi() * 0.1
      const ul = lagCurve(u, crnd.int(Math.round(cr * 2.2)))
      const lvl = crnd.range(0.6, 1) * o.leaves
      const th = crnd.range(0.12, 0.3)
      const jit = smoothCurve(m, cr, crnd, 1.5, 2)
      for (let i = 0; i < m; i++) env[i] = clamp(smoothstep(th, th + 0.9, ul[i]) * (1 + 0.25 * jit[i]), 0, 1.3)
      const tex = rustle(n, sr, rnd, env, kind.d0, kind.d1, kind.decayMs, kind.noise, kind.colour)
      panGains(pan, pg)
      const g = kind.gain * lvl / Math.sqrt(trees / 3)
      addInto(L, tex, g * pg[0])
      addInto(R, tex, g * pg[1])
      // Branch swish: a soft mid whoosh as the boughs move.
      swish.fill(0)
      for (let i = 0; i < m; i++) {
        fc[i] = 420 + 380 * ul[i]
        gn[i] = 0.35 * lvl * env[i] * env[i]
      }
      bandNoise(swish, sr, rnd, fc, 1.1, gn, 1, 1)
      addInto(L, swish, pg[0] / Math.sqrt(trees / 2))
      addInto(R, swish, pg[1] / Math.sqrt(trees / 2))
    }
  }

  // Blowing snow and ice: a fine hiss and dense tiny ticks on every surface.
  if ((o.snow || 0) > 0) {
    const env = new Float32Array(m)
    for (let c = 0; c < 2; c++) {
      const uc = c === 0 ? uL : uR
      for (let i = 0; i < m; i++) env[i] = clamp(Math.pow(uc[i], 1.6), 0, 2)
      const tex = rustle(n, sr, rnd, env, 200, 7000, 0.25, 0.9, [['highpass', 3800, 0.6], ['peak', 7000, 0.7, 3], ['lowpass', 14000, 0.6]])
      addInto(c === 0 ? L : R, tex, 0.32 * o.snow * (inside ? 0.25 : 1))
    }
  }

  // Sand: saltation only starts above a threshold speed, then hisses hard.
  if ((o.sand || 0) > 0) {
    const env = new Float32Array(m)
    for (let c = 0; c < 2; c++) {
      const uc = c === 0 ? uL : uR
      for (let i = 0; i < m; i++) env[i] = clamp(Math.pow(Math.max(0, uc[i] - 0.28) * 1.6, 1.2), 0, 1.6)
      const tex = rustle(n, sr, rnd, env, 0, 16000, 0.35, 0.6, [['highpass', 2200, 0.6], ['peak', 5500, 0.6, 4], ['lowpass', 13000, 0.6]])
      addInto(c === 0 ? L : R, tex, 0.7 * o.sand)
    }
  }

  // Singing dunes: now and then a sand avalanche hums low (about 70 to
  // 105 Hz with a few harmonics), swelling and fading over several seconds.
  if ((o.dunes || 0) > 0) {
    const dur = n / sr
    let t = crnd.range(1, 6)
    const pg = new Float64Array(2)
    while (t < dur) {
      const f0 = crnd.range(70, 105)
      const len = crnd.range(4, 9)
      const pan = crnd.bi() * 0.6
      panGains(pan, pg)
      const i0 = Math.round(t * sr)
      const i1 = Math.min(n, i0 + Math.round(len * sr))
      const lvl = 0.05 * o.dunes * crnd.range(0.6, 1)
      let ph = 0
      const wob = crnd.range(0.2, 0.5)
      for (let i = i0; i < i1; i++) {
        const tt = (i - i0) / sr
        const e = Math.sin((Math.PI * tt) / len)
        const f = f0 * (1 + 0.02 * Math.sin(TWO_PI * wob * tt) + 0.008 * Math.sin(TWO_PI * 5.3 * tt))
        ph += (TWO_PI * f) / sr
        if (ph > 1e4) ph -= TWO_PI * Math.floor(ph / TWO_PI)
        const y = lvl * e * e * (Math.sin(ph) + 0.5 * Math.sin(2 * ph + 0.3) + 0.25 * Math.sin(3 * ph + 1.1) + 0.12 * Math.sin(4 * ph))
        L[i] += y * pg[0]
        R[i] += y * pg[1]
      }
      t += len + crnd.exp(25 / Math.max(0.1, o.dunes))
    }
  }

  // Loose window rattle in strong gusts (heard from inside a house).
  if ((o.rattle || 0) > 0) {
    const imp = new Impacts(L, R, sr, rnd)
    const pan = crnd.range(0.3, 0.8) * (crnd.chance(0.5) ? 1 : -1)
    const bank = imp.addBank([310, 640, 1180, 2250, 3400], [0.012, 0.01, 0.008, 0.006, 0.004], [0.5, 0.45, 0.4, 0.3, 0.2], pan, 0.2)
    const th = 0.55 + 0.25 * (1 - o.rattle)
    const dur = n / sr
    let t = 0
    let rate = crnd.range(14, 26)
    while (t < dur) {
      const sp = u[Math.min(m - 1, Math.floor((t * sr) / HOP))]
      const e = smoothstep(th, th + 0.35, sp)
      if (e > 0.02 && rnd.chance(0.85)) imp.excite(bank, t, 0.25 * o.rattle * e * rnd.range(0.4, 1))
      t += (1 / rate) * rnd.range(0.7, 1.3)
      if (rnd.chance(0.02)) rate = crnd.range(14, 26)
    }
    imp.renderBanks()
  }

  if (inside) {
    for (const s of [L, R]) eq(s, sr, [['lowpass', 1800, 0.6], ['lowshelf', 150, 0.7, 2]])
  }
  if ((o.distance || 0) > 0.02) {
    const f = 15000 * Math.pow(1 - clamp(o.distance, 0, 1), 1.5) + 1800
    for (const s of [L, R]) eq(s, sr, [['lowpass', f, 0.6]])
  }
  return { L, R, speed: u }
}

const bed = {
  id: 'wind',
  name: 'Wind',
  group: 'weather',
  about: 'Open-air wind that rises and falls in gusts, with a thin whistle and a low rumble in the strong ones.',
  params: [
    { id: 'strength', name: 'Wind strength', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [20, 85] },
    { id: 'gusts', name: 'Gusts', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'whistle', name: 'Whistle', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 70] },
    { id: 'rumble', name: 'Low rumble', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 70] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const { L, R } = windLayer(n, s.sr, s.rng, {
        strength: q.strength / 100,
        gusts: q.gusts / 100,
        whistle: q.whistle / 100,
        rumble: q.rumble / 100,
      })
      finishBed(L, R, s.sr, -20.5 + (q.strength - 45) * 0.08)
      return { L, R }
    })
  },
}

export default bed
