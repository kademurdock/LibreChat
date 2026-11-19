// beds/rain-gutter.js - A rain gutter: roof water running along the gutter,
// gurgling down the pipe and pouring out at the bottom.
//
// Techniques and their published sources:
// - The rain all round is the rain engine of beds/rain.js (Marshall-Palmer
//   drop sizes, every drop its own event, Farnell's "Designing Sound", MIT
//   Press 2010). Its intensity comes in waves, and the gutter follows the
//   same waves about six seconds late, because a roof collects the rain and
//   lets it go slowly (a first-order lag, the linear reservoir of rainfall
//   runoff models, Nash 1957).
// - Water is bubble sound. The gutter's thin flow, the gurgles and the
//   pour are streams of Minnaert bubbles (Minnaert 1933, f = 3 / r), with
//   van den Doel's damping and upward chirp ("Physically based models for
//   liquid sounds", ACM Trans. Applied Perception 2(4), 2005), and small
//   splashes as short resonant noise bursts (Farnell 2010).
// - The downpipe: air swallowed by the falling water comes up as big,
//   strongly chirped bubbles in runs (the glug-glug of a pipe), drops patter
//   on the thin metal wall (a bank of inharmonic modes, modal synthesis after
//   van den Doel and Pai 1998, driven by dense tiny impacts), and all of it
//   sounds through the air column inside: a feedback comb filter with a
//   lowpass in its loop (Moorer 1979, "About this reverberation business",
//   Computer Music Journal 3(2)) tuned to the length of pipe below the last
//   bend, which is what makes it hollow.
// - The spout pours onto what you pick: paving stones (bright splatter and
//   slaps), a rain barrel (a plunging stream that drags air under, lots of
//   bubbles, and the hollow of air above the water, a tube closed at one
//   end whose modes are the odd harmonics of a quarter wave, f = c / 4L),
//   or a puddle.
// - Spills: where the gutter overflows, big drops fall from its edge, each
//   from its own spot with its own rhythm, quicker as the flow grows.
// - The house wall beside the pipe gives a short reflection (an 8-line
//   feedback delay network, Jot and Chaigne 1991).

import {
  rainLayer, Rand32, Impacts, clamp, ctrlLen, smoothCurve, eq, addInto, whiteArr, applyCurve, HOP, finishBed, runBed, Fdn,
} from './rain.js'
import { waterLayer } from './creek.js'

const TWO_PI = 2 * Math.PI

const WHERE = {
  stones: { surface: 'pavement' },
  barrel: { surface: 'mixed' },
  puddle: { surface: 'puddles' },
}

// Part levels, set by measuring each part's loudness at the defaults: the
// pour leads, the pipe a little under it, the rain and the gutter behind.
const LEVEL = { channel: 1.8, pipe: 0.7, spout: 1, spill: 6 }
const RAIN_LEVEL = 0.5
const SPOUT_GAIN = { barrel: 1, stones: 3.8, puddle: 2 }

/** Power-law radius in metres between r0 and r1 mm (bigger gamma, more small ones). */
function drawRadius(rnd, r0, r1, gamma) {
  const a = 1 - gamma
  const x0 = Math.pow(r0, a)
  const x1 = Math.pow(r1, a)
  return Math.pow(x0 + (x1 - x0) * rnd.next(), 1 / a) * 0.001
}

/**
 * Feedback comb with a one-pole lowpass in the loop, in place. The output is
 * scaled so the level stays about the same as the resonance grows (the loop
 * lowpass keeps the highs from building up, so the full-band 1 - fb^2 would
 * over-correct).
 */
function pipeComb(x, sr, f0, fb, dampHz) {
  const d = Math.max(2, Math.round(sr / f0))
  const buf = new Float32Array(d)
  const c = Math.exp((-TWO_PI * Math.min(dampHz, sr * 0.45)) / sr)
  const c1 = 1 - c
  const k = Math.sqrt(1 - 0.6 * fb * fb)
  let z = 0
  let idx = 0
  for (let i = 0; i < x.length; i++) {
    let zz = buf[idx] * c1 + z * c
    if (zz < 1e-20 && zz > -1e-20) zz = 0
    z = zz
    const y = x[i] + fb * zz
    buf[idx] = y
    idx++
    if (idx >= d) idx = 0
    x[i] = y * k
  }
}

/**
 * The parts of the gutter, each { L, R }, not yet mixed or levelled.
 * q: resolved params (intensity, where, pipe, drips, distance, all 0..100 or the choice).
 */
export function gutterParts(n, sr, q, rng) {
  const parts = {}
  const where = WHERE[q.where] ? q.where : 'barrel'
  const I = clamp(q.intensity / 100, 0, 1)
  const pipe = clamp(q.pipe / 100, 0, 1)
  const spill = clamp(q.drips / 100, 0, 1)
  const dist = clamp(q.distance / 100, 0, 1)
  const m = ctrlLen(n)
  const cr = sr / HOP
  const dur = n / sr
  const crnd = new Rand32(rng.fork('gutter-curves'))
  const rnd = new Rand32(rng.fork('gutter'))

  // Rain in waves, and the gutter's flow following them late.
  const W = smoothCurve(m, cr, crnd, 0.045, 3, 0.55)
  const rainMod = new Float32Array(m)
  for (let i = 0; i < m; i++) rainMod[i] = clamp(1 + 0.9 * W[i], 0.3, 2.2)
  const surge = smoothCurve(m, cr, crnd, 0.35, 2)
  const F = new Float32Array(m)
  const lag = 1 - Math.exp(-1 / (6 * cr))
  let y = rainMod[0]
  for (let i = 0; i < m; i++) {
    y += lag * (rainMod[i] - y)
    F[i] = clamp(y * (1 + 0.18 * surge[i]), 0.2, 2.5)
  }
  const lvl = (t) => F[Math.min(m - 1, Math.max(0, Math.floor((t * sr) / HOP)))]
  // How much water the roof sends down at this rain.
  const base = 0.2 + 0.8 * Math.pow(I, 1.1)

  // The rain all round.
  parts.rain = rainLayer(n, sr, rng.fork('rain'), {
    intensity: q.intensity,
    surface: WHERE[where].surface,
    distance: 0.3 + 0.5 * dist,
    drips: 0,
    waves: 0,
    mod: rainMod,
    washGain: 0.9,
    dropGain: 0.8,
  })

  // The gutter channel overhead: a thin flow along a metal trough, off to the left.
  {
    const g = waterLayer(n, sr, rng.fork('channel'), {
      flow: 0.3 * base,
      babble: 0.5,
      spots: 3,
      spotR: [1, 3.5],
      swarm: 80 + 300 * base,
      swarmR: [0.5, 2],
      swarmAmp: 0.02,
      splash: 10 + 40 * base,
      rush: 0.08 * base,
      rushEq: [['bandpass', 1500, 0.5]],
      trickle: 60 + 200 * base,
      width: 0.7,
      mod: F,
      distance: 0,
    })
    // Overhead and a little further off than the pipe: its distance is in its lowpass.
    const top = Math.min(9000, 15000 * Math.pow(1 - (0.3 + 0.5 * dist), 1.7) + 1500)
    for (const s of [g.L, g.R]) eq(s, sr, [['peak', 3000, 1, 3], ['lowpass', top, 0.7]])
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    addInto(L, g.L, 1)
    addInto(L, g.R, 0.35)
    addInto(R, g.R, 0.55)
    parts.channel = { L, R }
  }

  // The downpipe: glugs, patter on the wall and the rush, through its air column.
  {
    const P = new Float32Array(n)
    const imp = new Impacts(P, P, sr, rnd)
    const wf = [780, 1230, 1710, 2380, 3150, 4100].map((f) => f * rnd.range(0.95, 1.05))
    const wall = imp.addBank(wf, [0.022, 0.018, 0.016, 0.012, 0.01, 0.008], [0.5, 0.45, 0.4, 0.33, 0.28, 0.22], 0, 0)
    imp.sizzleBank(wall, 150 + 1200 * base, 0.05, F)
    const glugRate = (0.15 + 1.6 * pipe) * (0.4 + 0.8 * base)
    const gAmp = 0.13 * (0.35 + 0.65 * pipe)
    let t = rnd.exp(1 / glugRate)
    while (t < dur) {
      const cnt = 2 + Math.floor(rnd.exp(1.5 + 4 * pipe))
      const rc = rnd.logRange(0.004, 0.012)
      let tb = t
      for (let j = 0; j < cnt; j++) {
        const r = rc * Math.exp(rnd.gauss() * 0.18)
        imp.bubble(tb, gAmp * Math.pow(r / 0.008, 0.8) * rnd.range(0.4, 1) * lvl(tb), 0, 3 / r, rnd.range(0.35, 0.9))
        tb += rnd.exp(0.045)
      }
      t = tb + rnd.exp(1 / (glugRate * clamp(lvl(t), 0.3, 2)))
    }
    const spl = 100 + 350 * base
    t = rnd.exp(1 / spl)
    while (t < dur) {
      imp.burst(t, 0.05 * rnd.range(0.2, 1) * lvl(t), 0, rnd.range(900, 3500), 0.9, rnd.range(0.001, 0.004), 0.1)
      t += rnd.exp(1 / (spl * lvl(t)))
    }
    imp.renderBanks()
    const w = whiteArr(n, rnd)
    eq(w, sr, [['bandpass', 700, 0.5]])
    applyCurve(w, F, 0.06 * base)
    addInto(P, w)
    // The air column below the last bend: about 0.6 to 0.9 m of pipe.
    const f0 = 343 / (2 * rnd.range(0.6, 0.9))
    pipeComb(P, sr, f0, 0.45 + 0.35 * pipe, 2800)
    eq(P, sr, [['lowpass', 5000, 0.7], ['highpass', 90, 0.7]])
    // The pipe is just right of centre, near you; a hint of width. Turning
    // the gurgling up also brings the pipe forward.
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    const lag2 = Math.round(0.0004 * sr)
    const pg = 0.7 + 0.6 * pipe
    for (let i = 0; i < n; i++) {
      L[i] = 0.62 * pg * P[i]
      R[i] = 0.78 * pg * (i >= lag2 ? P[i - lag2] : 0)
    }
    parts.pipe = { L, R }
  }

  // The pour from the spout.
  {
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    const imp = new Impacts(L, R, sr, rnd)
    const pan = 0.5
    const sp = () => clamp(pan + rnd.bi() * 0.1, -1, 1)
    if (where === 'stones') {
      const lam = 300 + 2200 * base
      let t = rnd.exp(1 / lam)
      while (t < dur) {
        const D = rnd.range(1, 3.5)
        const a = 0.035 * Math.pow(D / 2, 1.2) * rnd.range(0.25, 1) * Math.sqrt(lvl(t))
        imp.burst(t, a, sp(), 5200 * Math.sqrt(2 / (D + 0.6)) * rnd.range(0.75, 1.3), 0.9, 0.0006 + 0.0007 * D, 0.5)
        t += rnd.exp(1 / (lam * lvl(t)))
      }
      const slaps = 20 + 80 * base
      t = rnd.exp(1 / slaps)
      while (t < dur) {
        const a = rnd.range(0.3, 1) * lvl(t)
        imp.lowBurst(t, 0.05 * a, sp(), rnd.range(500, 1100), rnd.range(0.003, 0.008))
        imp.burst(t, 0.04 * a, sp(), rnd.range(1500, 3000), 1, 0.002, 0.3)
        t += rnd.exp(1 / slaps)
      }
      t = rnd.exp(1 / 20)
      while (t < dur) {
        const r = drawRadius(rnd, 1.5, 4, 1.5)
        imp.bubble(t, 0.02 * rnd.range(0.3, 1), sp(), 3 / r, rnd.range(0.1, 0.3))
        t += rnd.exp(1 / 20)
      }
      for (const [s, k] of [[L, 0.85], [R, 1.15]]) {
        const w = whiteArr(n, rnd)
        eq(w, sr, [['bandpass', 3000, 0.5]])
        applyCurve(w, F, 0.025 * base * k)
        addInto(s, w)
      }
    } else if (where === 'barrel') {
      const lam = 120 + 500 * base
      let t = rnd.exp(1 / lam)
      while (t < dur) {
        const r = drawRadius(rnd, 1.2, 8, 1.8)
        imp.bubble(t, 0.056 * Math.pow(r / 0.003, 0.8) * rnd.range(0.2, 1) * Math.sqrt(lvl(t)), sp(), 3 / r, rnd.range(0.1, 0.35))
        t += rnd.exp(1 / (lam * lvl(t)))
      }
      const spl = 100 + 600 * base
      t = rnd.exp(1 / spl)
      while (t < dur) {
        imp.burst(t, 0.045 * rnd.range(0.2, 1) * lvl(t), sp(), rnd.range(1200, 4500), 0.9, rnd.range(0.001, 0.003), 0.1)
        t += rnd.exp(1 / (spl * lvl(t)))
      }
      // The air above the water in the barrel is a tube closed at the water
      // and open at the top, so its modes are the odd harmonics of a quarter
      // wave (f = c / 4L); one more mode for the wooden staves.
      const fq = 343 / (4 * rnd.range(0.3, 0.6))
      const bf = [fq, 3 * fq * 0.98, 5 * fq * 0.96, 7 * fq * 0.95, rnd.range(380, 460)]
      const body = imp.addBank(bf, [0.08, 0.06, 0.04, 0.03, 0.025], [0.5, 0.45, 0.4, 0.3, 0.25], pan, 0.15)
      imp.sizzleBank(body, 400 + 1500 * base, 0.02, F)
      imp.renderBanks()
      for (const [s, k] of [[L, 0.85], [R, 1.15]]) {
        const w = whiteArr(n, rnd)
        eq(w, sr, [['lowpass', 260, 0.7]])
        applyCurve(w, F, 0.012 * base * k)
        addInto(s, w)
      }
    } else {
      const lam = 100 + 500 * base
      let t = rnd.exp(1 / lam)
      while (t < dur) {
        const r = drawRadius(rnd, 1, 5, 1.6)
        imp.bubble(t, 0.04 * Math.pow(r / 0.0025, 0.8) * rnd.range(0.2, 1) * Math.sqrt(lvl(t)), sp(), 3 / r, rnd.range(0.1, 0.3))
        t += rnd.exp(1 / (lam * lvl(t)))
      }
      const spl = 200 + 1500 * base
      t = rnd.exp(1 / spl)
      while (t < dur) {
        imp.burst(t, 0.03 * rnd.range(0.2, 1) * lvl(t), sp(), rnd.range(2000, 6500), 1, rnd.range(0.0006, 0.002), 0.3)
        t += rnd.exp(1 / (spl * lvl(t)))
      }
      const plunks = 10 + 40 * base
      t = rnd.exp(1 / plunks)
      while (t < dur) {
        const a = rnd.range(0.3, 1) * lvl(t)
        imp.burst(t, 0.05 * a, sp(), rnd.range(700, 1400), 1.2, 0.003, 0)
        imp.bubble(t + rnd.range(0.001, 0.004), 0.04 * a, sp(), 3 / rnd.range(0.005, 0.009), rnd.range(0.15, 0.35))
        t += rnd.exp(1 / plunks)
      }
      imp.renderBanks()
    }
    parts.spout = { L, R }
  }

  // Spills over the gutter's edge: big drops, each spot with its own rhythm.
  {
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    const imp = new Impacts(L, R, sr, rnd)
    const spots = spill > 0 ? 1 + Math.round(spill * 3) : 0
    for (let k = 0; k < spots; k++) {
      const pan = clamp(-0.8 + 0.35 * k + rnd.bi() * 0.1, -1, 1)
      const period = rnd.logRange(0.2, 0.7)
      const g = rnd.range(0.6, 1) * (0.5 + 0.5 * spill)
      const drift = smoothCurve(m, cr, crnd, 0.1, 2)
      let t = rnd.next() * period
      while (t < dur) {
        const a = 0.12 * g * rnd.range(0.7, 1.1)
        if (where === 'stones') {
          imp.burst(t, a * 1.3, pan, 3000 * rnd.range(0.8, 1.25), 0.9, 0.0025, 0.5)
          imp.burst(t + 0.001, a * 0.5, pan, 1400, 1.2, 0.005, 0)
        } else {
          imp.burst(t, a, pan, 3600 * rnd.range(0.8, 1.2), 1, 0.0012, 0.25)
          imp.bubble(t + rnd.range(0.001, 0.003), a * 0.32, pan, rnd.range(480, 1150), rnd.range(0.18, 0.35))
        }
        const ci = Math.min(m - 1, Math.floor((t * sr) / HOP))
        const speed = clamp(F[ci], 0.4, 2) * (0.5 + base)
        t += (period / speed) * Math.max(0.3, 1 + 0.15 * rnd.gauss() + 0.3 * drift[ci])
      }
    }
    imp.renderBanks()
    parts.spill = { L, R }
  }

  // Louder as more water comes down (on top of the busier events), and
  // each pour target brought to about the same loudness.
  parts.flowGain = Math.pow(base / 0.61, 0.6)
  parts.spoutGain = SPOUT_GAIN[where]
  return parts
}

const bed = {
  id: 'rain-gutter',
  name: 'Rain gutter',
  group: 'water',
  about: 'Rain running along the gutter, gurgling down the pipe and pouring out at the bottom.',
  params: [
    { id: 'intensity', name: 'How hard it rains', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [25, 95] },
    {
      id: 'where',
      name: 'Where it pours',
      type: 'choice',
      def: 'barrel',
      options: [
        { v: 'barrel', name: 'Into a rain barrel' },
        { v: 'stones', name: 'Onto paving stones' },
        { v: 'puddle', name: 'Into a puddle' },
      ],
    },
    { id: 'pipe', name: 'Gurgling in the pipe', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [15, 90] },
    { id: 'drips', name: 'Spilling over the edge', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 80] },
    { id: 'distance', name: 'Distance', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [0, 60] },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const parts = gutterParts(n, rate, q, rg)
      const dist = q.distance / 100
      // The close parts: gutter, pipe, pour and spills, which distance quietens and dulls.
      const L = new Float32Array(n)
      const R = new Float32Array(n)
      const near = (1 - 0.5 * dist) * parts.flowGain
      for (const k of Object.keys(LEVEL)) {
        const g = LEVEL[k] * near * (k === 'spout' ? parts.spoutGain : 1)
        addInto(L, parts[k].L, g)
        addInto(R, parts[k].R, g)
      }
      if (dist > 0.02) {
        const fc = 15000 * Math.pow(1 - dist, 1.7) + 1800
        eq(L, rate, [['lowpass', fc, 0.6]])
        eq(R, rate, [['lowpass', fc, 0.6]])
      }
      addInto(L, parts.rain.L, RAIN_LEVEL)
      addInto(R, parts.rain.R, RAIN_LEVEL)
      new Fdn(rate, { size: 0.55, rt60: 0.35, damp: 0.5, predelayMs: 3 }).process(L, R, 0.12, 1)
      finishBed(L, R, rate, -20 + (q.intensity - 55) * 0.07 - q.distance * 0.04)
      return { L, R }
    })
  },
}

export default bed
