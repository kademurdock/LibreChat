// beds/campfire.js - A campfire: crackles and pops over the soft roar of the flames.
//
// This file also holds the fire engine used by beds/fireplace.js and
// beds/blaze.js.
//
// Technique: Andy Farnell's fire model ("Designing Sound", MIT Press 2010,
// the fire chapter) splits fire into three parts, and this follows it:
// - lapping: the flames' low roar, low-passed noise whose loudness flickers
//   with a smooth random curve, plus a soft breathy mid band;
// - hissing: high-passed noise amplitude-modulated by squared slow noise, so
//   it spits in bursts rather than hissing evenly;
// - crackling: random sharp events, here given more structure than a plain
//   Poisson stream: each crackle may trigger a few smaller after-crackles
//   within tens of milliseconds (a self-exciting cluster process, Hawkes
//   1971), the way burning wood splits in little runs. Sizes are heavy
//   tailed (many tiny ticks, the odd loud snap), each a short resonant noise
//   burst with a contact tick.
// Added detail: sap pockets bursting as loud pops with a spray of embers and
// sometimes a whistling jet of steam (a narrow noise band that flutters);
// and log shifts now and then: a dull wooden thud (two low modes), embers
// tinkling as they settle (short glassy modes), and the fire flaring up for
// a few seconds afterwards.

import {
  HOP, Rand32, Impacts, clamp, ctrlLen, smoothCurve, eq, addInto, whiteArr, applyCurve, panGains, finishBed, runBed,
} from './rain.js'
import { bandNoise } from './wind.js'

/**
 * The fire engine. Returns { L, R }.
 * o: { size 0..1, crackle 0..1, pops 0..1, logs 0..1, roar 0..1, hiss 0..1,
 *      flare 0..1 (flare-ups), sources (how many burning spots), width 0..1,
 *      grate bool (logs settle on a metal grate), firstLog seconds or null }
 */
export function fireLayer(n, sr, rng, o = {}) {
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  if (n === 0) return { L, R }
  const rnd = new Rand32(rng.fork('fire'))
  const crnd = new Rand32(rng.fork('fire-curves'))
  const imp = new Impacts(L, R, sr, rnd)
  const m = ctrlLen(n)
  const cr = sr / HOP
  const dur = n / sr
  const size = clamp(o.size === undefined ? 0.5 : o.size, 0, 1)
  const crackle = clamp(o.crackle === undefined ? 0.6 : o.crackle, 0, 1)
  const pops = clamp(o.pops === undefined ? 0.4 : o.pops, 0, 1)
  const logs = clamp(o.logs === undefined ? 0.4 : o.logs, 0, 1)
  const roarAmt = clamp(o.roar === undefined ? 0.5 : o.roar, 0, 1)
  const hissAmt = clamp(o.hiss === undefined ? 0.4 : o.hiss, 0, 1)
  const flareAmt = clamp(o.flare === undefined ? 0.3 : o.flare, 0, 1)
  const width = clamp(o.width === undefined ? 0.5 : o.width, 0, 1)
  const sources = clamp(Math.round(o.sources || 1), 1, 5)

  // Flicker: the fire's breathing, plus flare-ups.
  const flick = smoothCurve(m, cr, crnd, 2.2, 3)
  const F = new Float32Array(m)
  for (let i = 0; i < m; i++) F[i] = 1 + 0.32 * flick[i]
  const flare = (t, g, len) => {
    const i0 = Math.round((t * sr) / HOP)
    const a = Math.round(cr * 0.4)
    const tot = Math.round(cr * len)
    for (let k = 0; k < tot; k++) {
      const i = i0 + k
      if (i < 0) continue
      if (i >= m) break
      const v = k < a ? k / a : Math.exp((-3 * (k - a)) / (tot - a))
      F[i] += g * v
    }
  }
  if (flareAmt > 0) {
    let t = crnd.range(1, 8)
    while (t < dur) {
      flare(t, flareAmt * crnd.range(0.3, 0.8), crnd.range(1.5, 4))
      t += crnd.exp(12 / (0.3 + flareAmt))
    }
  }

  // Log shifts: thud, settling embers, then a flare.
  if (logs > 0) {
    const rate = 1 / 45 + logs / 9
    let t = o.firstLog != null ? o.firstLog : crnd.range(2, 6) + crnd.exp(1 / rate) * 0.5
    while (t < dur) {
      const pan = crnd.bi() * 0.4 * width
      const g = crnd.range(0.6, 1) * (0.5 + 0.5 * size)
      imp.lowBurst(t, 0.18 * g, pan, crnd.range(160, 300), 0.04)
      imp.mode(t, 0.12 * g, pan, crnd.range(95, 160), 0.06)
      imp.mode(t, 0.06 * g, pan, crnd.range(240, 420), 0.03)
      imp.burst(t, 0.08 * g, pan, crnd.range(1200, 2400), 1, 0.003, 0.3)
      if (o.grate) {
        imp.mode(t + 0.002, 0.04 * g, pan, crnd.range(900, 1400), 0.08)
        imp.mode(t + 0.002, 0.03 * g, pan, crnd.range(2100, 3200), 0.05)
      }
      const tinks = 8 + crnd.int(22)
      for (let k = 0; k < tinks; k++) {
        const tk = t + 0.03 + Math.pow(crnd.next(), 1.8) * crnd.range(0.4, 1.3)
        const a = 0.05 * g * crnd.range(0.15, 1) * Math.exp(-(tk - t) * 1.5)
        const pk = clamp(pan + crnd.bi() * 0.15, -1, 1)
        imp.mode(tk, a, pk, crnd.logRange(1700, 5800), crnd.range(0.005, 0.02))
        imp.burst(tk, a * 0.8, pk, crnd.range(3000, 7000), 1, 0.0002, 0.5)
      }
      flare(t + 0.3, 0.5 + 0.4 * size, crnd.range(2.5, 5))
      t += Math.max(4, crnd.exp(1 / rate))
    }
  }
  const Fat = (t) => F[Math.min(m - 1, Math.max(0, Math.floor((t * sr) / HOP)))]

  // Steam jets get their own noise bands; events write their envelopes.
  const jetEnv = [new Float32Array(m), new Float32Array(m)]
  const jetPan = [crnd.bi() * 0.4 * width, crnd.bi() * 0.4 * width]

  // Crackles and pops, per burning spot.
  for (let sIdx = 0; sIdx < sources; sIdx++) {
    const centre = sources === 1 ? 0 : (-1 + (2 * (sIdx + 0.5)) / sources) * width
    const spread = (0.25 + 0.2 * width) / Math.sqrt(sources)
    const lam = ((2 + 34 * crackle) * (0.4 + size)) / Math.sqrt(sources)
    let t = rnd.exp(1 / lam)
    while (t < dur) {
      const f = Fat(t)
      const pan = clamp(centre + rnd.bi() * spread, -1, 1)
      // Heavy-tailed size: many tiny ticks, the odd loud one.
      const a = Math.min(0.55, 0.06 * Math.pow(1 - rnd.next() * 0.999, -1 / 1.6)) * (0.6 + 0.4 * size)
      const u = rnd.next()
      if (u < 0.6) {
        imp.burst(t, a * 1.4, pan, rnd.logRange(1500, 7000), rnd.range(0.8, 1.5), rnd.range(0.0001, 0.0005), 0.8)
      } else if (u < 0.9) {
        imp.burst(t, a * 1.6, pan, rnd.logRange(600, 3000), rnd.range(0.8, 1.6), rnd.range(0.0005, 0.003), 0.4)
        if (rnd.chance(0.4)) imp.burst(t + rnd.range(0.0003, 0.0015), a * 0.8, pan, rnd.logRange(1500, 5000), 1, 0.0003, 0.5)
      } else {
        imp.burst(t, a * 1.8, pan, rnd.logRange(2500, 6500), 1, 0.0003, 1)
        imp.burst(t + rnd.range(0.0008, 0.003), a * 1.2, pan, rnd.logRange(800, 2500), 1.2, 0.001, 0.6)
      }
      // After-crackles: a little run following the first.
      const after = Math.floor(rnd.exp(0.6 + 2.6 * crackle))
      let ta = t
      for (let j = 0; j < after; j++) {
        ta += rnd.exp(0.012)
        imp.burst(ta, a * rnd.range(0.15, 0.5), clamp(pan + rnd.bi() * 0.05, -1, 1), rnd.logRange(1500, 7000), 1.1, rnd.range(0.0001, 0.0004), 0.7)
      }
      t += rnd.exp(1 / (lam * clamp(f, 0.3, 3)))
    }
    // Sap pops, with ember spray and sometimes a jet of steam.
    const lamPop = ((0.03 + 0.3 * pops) * (0.5 + size)) / Math.sqrt(sources)
    if (pops > 0) {
      let tp = rnd.range(0.5, 4) + rnd.exp(1 / lamPop) * 0.5
      while (tp < dur) {
        const pan = clamp(centre + rnd.bi() * spread, -1, 1)
        const g = rnd.range(0.5, 1) * (0.6 + 0.4 * size)
        imp.burst(tp, 0.35 * g, pan, rnd.range(300, 900), 0.7, rnd.range(0.002, 0.005), 1)
        imp.burst(tp, 0.25 * g, pan, rnd.range(3500, 6500), 1, 0.0003, 1)
        const embers = 4 + rnd.int(11)
        for (let k = 0; k < embers; k++) {
          const te = tp + rnd.range(0.02, 0.4)
          imp.burst(te, 0.04 * g * rnd.range(0.2, 1), clamp(pan + rnd.bi() * 0.2, -1, 1), rnd.logRange(2500, 8000), 1, 0.0002, 0.6)
        }
        if (rnd.chance(0.35)) {
          const which = rnd.int(2)
          const len = rnd.range(0.5, 2.8)
          const i0 = Math.round((tp * sr) / HOP)
          const tot = Math.round(len * cr)
          const env = jetEnv[which]
          for (let k = 0; k < tot; k++) {
            const i = i0 + k
            if (i >= m) break
            const x = k / tot
            env[i] += g * Math.sin(Math.PI * Math.sqrt(x)) * (0.6 + 0.4 * Math.sin(k * 0.9 + rnd.next()))
          }
        }
        tp += rnd.exp(1 / lamPop)
      }
    }
  }
  imp.renderBanks()

  // Lapping roar and breath, flickering.
  const env = new Float32Array(m)
  const roarLvl = roarAmt * (0.15 + 0.85 * Math.pow(size, 1.4))
  for (let c = 0; c < 2; c++) {
    const ch = c === 0 ? L : R
    let w
    // A caller with its own flame sound (the torch) asks for no roar; the
    // filters are then skipped, which keeps it fast.
    if (roarLvl > 0) {
      const own = smoothCurve(m, cr, crnd, 3.5, 2)
      for (let i = 0; i < m; i++) env[i] = clamp(F[i] + 0.12 * own[i], 0.2, 3) * roarLvl
      w = whiteArr(n, rnd)
      const lp = 170 + 480 * size
      eq(w, sr, [['lowpass', lp, 0.7], ['lowpass', lp * 1.6, 0.7], ['highpass', 38, 0.7]])
      applyCurve(w, env, 0.55)
      addInto(ch, w)
      for (let i = 0; i < m; i++) env[i] = clamp(F[i] * F[i], 0.05, 6) * roarLvl
      w = whiteArr(n, rnd)
      eq(w, sr, [['bandpass', 650 + 500 * size, 0.6]])
      applyCurve(w, env, 0.09)
      addInto(ch, w)
    }
    // Hiss in spits: high noise times squared slow noise.
    const spit = smoothCurve(m, cr, crnd, 1.2, 3)
    for (let i = 0; i < m; i++) {
      const v = 0.4 + 1.6 * spit[i]
      env[i] = v * v * hissAmt * (0.4 + 0.6 * size)
    }
    w = whiteArr(n, rnd)
    eq(w, sr, [['highpass', 2600, 0.6], ['lowpass', 9500, 0.6]])
    applyCurve(w, env, 0.012)
    addInto(ch, w)
  }
  // Steam jets: narrow fluttering hiss at a wandering pitch.
  {
    const tmp = new Float32Array(n)
    const fc = new Float32Array(m)
    const pg = new Float64Array(2)
    for (let j = 0; j < 2; j++) {
      let any = false
      for (let i = 0; i < m; i++) if (jetEnv[j][i] > 0) { any = true; break }
      if (!any) continue
      const wob = smoothCurve(m, cr, crnd, 0.7, 2)
      const base = j === 0 ? crnd.range(2400, 3800) : crnd.range(4200, 6500)
      for (let i = 0; i < m; i++) fc[i] = base * (1 + 0.08 * wob[i])
      tmp.fill(0)
      bandNoise(tmp, sr, rnd, fc, 7, jetEnv[j], 0.05, 2)
      panGains(jetPan[j], pg)
      addInto(L, tmp, pg[0])
      addInto(R, tmp, pg[1])
    }
  }
  return { L, R }
}

const bed = {
  id: 'campfire',
  name: 'Campfire',
  group: 'fire',
  about: 'A wood campfire crackling and popping, flames softly roaring, logs settling now and then.',
  params: [
    { id: 'size', name: 'Size of the fire', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 85] },
    { id: 'crackle', name: 'Crackle', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [25, 95] },
    { id: 'pops', name: 'Pops and sparks', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 80] },
    { id: 'logs', name: 'Logs settling', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [0, 80] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const { L, R } = fireLayer(n, s.sr, s.rng, {
        size: q.size / 100,
        crackle: q.crackle / 100,
        pops: q.pops / 100,
        logs: q.logs / 100,
        roar: 0.22,
        hiss: 0.35,
        flare: 0.25,
        width: 0.5,
      })
      finishBed(L, R, s.sr, -21 + (q.size - 50) * 0.06, 3.5)
      return { L, R }
    })
  },
}

export default bed
