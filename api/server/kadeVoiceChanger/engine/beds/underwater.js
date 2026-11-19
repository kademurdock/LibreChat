// beds/underwater.js - Underwater: muffled pressure, rising bubbles, a crackling reef.
//
// Technique: what makes a sound read as "under water" is how water carries
// it: highs vanish, everything arrives as low, enveloping pressure.
// - A deep pressure rumble (low-passed noise) that surges as waves pass
//   overhead, with the muffled whoosh of the surface swells when shallow.
// - Snapping shrimp, the crackle that fills almost every warm-sea
//   recording (Au and Banks 1998, "The acoustics of the snapping shrimp",
//   JASA 103): thousands of very short broadband clicks a second from all
//   around, near and far.
// - A diver's breathing: the demand valve hissing on each breath in, then on
//   each breath out a cascade of exhaust bubbles, large Minnaert bubbles
//   (Minnaert 1933) chirping upward as they rise (van den Doel 2005 damping
//   and chirp), with the low gurgle of the exhaust itself.

import {
  finishBed, Rand32, Impacts, whiteArr, eq, applyCurve, addInto, smoothCurve, ctrlLen, HOP, clamp, runBed,
} from './rain.js'

/** Raised-cosine attack, hold and release added into a control curve. */
function addShape(env, sr, t0, a, h, r, g) {
  const fr = sr / HOP
  const i0 = Math.round(t0 * fr)
  const A = Math.max(1, Math.round(a * fr))
  const H = Math.round(h * fr)
  const Rr = Math.max(1, Math.round(r * fr))
  for (let k = 0; k < A + H + Rr; k++) {
    const i = i0 + k
    if (i < 0) continue
    if (i >= env.length) break
    const v = k < A ? 0.5 - 0.5 * Math.cos((Math.PI * k) / A) : k < A + H ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (k - A - H)) / Rr)
    env[i] += v * g
  }
}

const bed = {
  id: 'underwater',
  name: 'Underwater',
  group: 'water',
  about: 'Under the sea: muffled pressure and swells, a crackling reef all round, and a diver breathing out streams of bubbles.',
  params: [
    { id: 'depth', name: 'Depth', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 85] },
    { id: 'swell', name: 'Waves above', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [15, 85] },
    { id: 'reef', name: 'Reef crackle', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [0, 80] },
    { id: 'diver', name: 'Diver breathing', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [0, 90] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const s = { sr: rate, rng: rg }
      const depth = q.depth / 100
      const swellAmt = q.swell / 100
      const reef = q.reef / 100
      const diver = q.diver / 100
      const dur = n / rate
      const m = ctrlLen(n)
      const cr = rate / HOP
      const rnd = new Rand32(s.rng.fork('sea'))
      const crnd = new Rand32(s.rng.fork('curves'))
      const L = new Float32Array(n)
      const R = new Float32Array(n)

      // Pressure rumble and passing swells.
      const swell = new Float32Array(m)
      let tw = crnd.range(-2, 1)
      while (tw < dur) {
        addShape(swell, rate, tw, crnd.range(1.2, 2.2), crnd.range(0.2, 0.8), crnd.range(1.5, 3), crnd.range(0.5, 1) * swellAmt * 1.8)
        tw += crnd.range(5, 9)
      }
      const slow = smoothCurve(m, cr, crnd, 0.08, 3)
      const env = new Float32Array(m)
      for (let c = 0; c < 2; c++) {
        const ch = c === 0 ? L : R
        for (let i = 0; i < m; i++) env[i] = clamp(1 + 0.35 * slow[i] + 0.5 * swell[i] * (1 - 0.6 * depth), 0.3, 3) * (1 + 0.6 * depth)
        let w = whiteArr(n, rnd)
        eq(w, rate, [['lowpass', 300 - 130 * depth, 0.7], ['lowpass', 420 - 150 * depth, 0.7], ['highpass', 28, 0.7], ['peak', 260, 0.8, 4]])
        applyCurve(w, env, 0.7)
        addInto(ch, w)
        // The surface overhead: a muffled whoosh with each swell (shallow water).
        for (let i = 0; i < m; i++) env[i] = swell[(i + c * 300) % m] * (1 - depth) * (1 - depth)
        w = whiteArr(n, rnd)
        eq(w, rate, [['bandpass', 420, 0.6], ['lowpass', 900, 0.7]])
        applyCurve(w, env, 0.16)
        addInto(ch, w)
      }

      const imp = new Impacts(L, R, rate, rnd)
      // Snapping shrimp: very short clicks from all around, near and far.
      if (reef > 0) {
        const lam = (150 + 1600 * reef) * (1 - 0.6 * depth)
        let t = rnd.exp(1 / lam)
        while (t < dur) {
          const r = rnd.logRange(1.5, 40)
          const a = (0.3 / r) * rnd.range(0.3, 1)
          imp.burst(t, a, rnd.bi(), rnd.range(2500, 7000), 0.7, rnd.range(0.00006, 0.0002), 1)
          t += rnd.exp(1 / lam)
        }
      }

      // The diver: breathe in (valve hiss), breathe out (bubbles and exhaust gurgle).
      if (diver > 0) {
        const hiss = new Float32Array(m)
        const gurgle = new Float32Array(m)
        let t = crnd.range(0, 1.2)
        while (t < dur) {
          const inLen = crnd.range(1.4, 2.1)
          addShape(hiss, rate, t, 0.25, inLen - 0.5, 0.25, 1)
          const t2 = t + inLen + crnd.range(0.3, 0.7)
          const outLen = crnd.range(1.6, 2.6)
          addShape(gurgle, rate, t2, 0.1, outLen - 0.6, 0.5, 1)
          // A cascade of exhaust bubbles, densest at the start of the breath.
          let tb = t2
          while (tb < t2 + outLen) {
            const x = (tb - t2) / outLen
            const rr = rnd.logRange(0.002, 0.012)
            const a = 0.11 * diver * Math.pow(rr / 0.005, 0.7) * rnd.range(0.4, 1) * (1 - 0.6 * x)
            imp.bubble(tb, a, rnd.bi() * 0.35, 3 / rr, rnd.range(0.25, 0.5), rnd.range(0.7, 1.1))
            tb += rnd.exp(1 / (380 * (1 - 0.7 * x) + 40))
          }
          t = t2 + outLen + crnd.range(0.4, 1.4)
        }
        for (let c = 0; c < 2; c++) {
          const ch = c === 0 ? L : R
          let w = whiteArr(n, rnd)
          eq(w, rate, [['bandpass', 3400, 0.9], ['highpass', 1500, 0.7]])
          applyCurve(w, hiss, 0.03 * diver)
          addInto(ch, w)
          w = whiteArr(n, rnd)
          eq(w, rate, [['lowpass', 320, 0.7], ['highpass', 60, 0.7]])
          applyCurve(w, gurgle, 0.22 * diver)
          addInto(ch, w)
        }
      }
      imp.renderBanks()
      // Water takes the highs; the deeper, the darker.
      const fc = 4800 - 3900 * depth
      for (const ch of [L, R]) eq(ch, rate, [['lowpass', fc, 0.6], ['lowpass', fc * 1.6, 0.6]])
      finishBed(L, R, rate, -21 - depth * 2)
      return { L, R }
    })
  },
}

export default bed
