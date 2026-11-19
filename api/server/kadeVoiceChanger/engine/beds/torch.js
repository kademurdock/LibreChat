// beds/torch.js - A crackling torch: a flame on a stick, fluttering, spitting and dripping.
//
// Techniques and their published sources:
// - Flame flutter. A buoyant flame puffs: its tip pinches off and flares
//   again at a rate set by how wide it is, f = 1.5 / sqrt(D) Hz for a flame
//   D metres across (Cetegen and Ahmed 1993, "Experiments on the periodic
//   instability of buoyant plumes and pool fires", Combustion and Flame 93).
//   A torch head four to sixteen centimetres across puffs about four to
//   seven times a second, and that quick, uneven flapping is what tells a
//   torch from a campfire's slow breathing. The flame's roar here is noise
//   in three parts, after Farnell's "lapping" ("Designing Sound", MIT Press
//   2010): a broad band at the flame's size, a low whump and an airy top,
//   their loudness following a puffing oscillator whose rate and depth
//   wander, plus faster ragged flapping. The top flaps hardest, as it does
//   on a real flame.
// - Burning pitch fizzes: a dense stream of tiny ticks (the frying texture
//   of many small bubbles bursting; Farnell's "hissing" made granular) that
//   comes in spits.
// - Wood crackle and small pops: the fire engine of beds/campfire.js, kept
//   small and close.
// - Sputters: now and then the flame gutters, dips and spits a quick run of
//   pops, then flares back.
// - Drips of burning pitch: a spit as one lets go, a fall of about half a
//   second (t = sqrt(2h / g) from the torch's height), a soft splat on the
//   floor and a crackling hiss that dies away as the drop burns out.
// - Movement: swinging the torch, or a draught past it, speeds the air
//   through the flame, so it roars louder and higher with a rush of air;
//   a swung torch also moves across in front of you.
// - Places: open air; a stone wall with its hall; or a row of torches down
//   a stone passage, the further ones quieter and duller. The stone rooms
//   are an 8-line feedback delay network (Jot and Chaigne 1991).

import {
  HOP, Rand32, Impacts, clamp, ctrlLen, smoothCurve, eq, addInto, whiteArr, sizzleArr, applyCurve, panGains, finishBed, runBed, Fdn,
} from './rain.js'
import { fireLayer } from './campfire.js'
import { bandNoise } from './wind.js'

const TWO_PI = 2 * Math.PI

// The flame's level against the crackle, drips and fizz (set by measuring
// each part's loudness: the flame leads, the crackle peaks well above it).
const FLAME = 0.16

/** Add a mono signal into L and R, panned by base plus a control curve, ramped between frames. */
function addPanned(L, R, src, base, curve, gain) {
  const n = Math.min(L.length, src.length)
  const g0 = new Float64Array(2)
  const g1 = new Float64Array(2)
  for (let j = 0, i = 0; i < n; j++) {
    const ja = curve ? (j < curve.length ? j : curve.length - 1) : 0
    const jb = curve ? (j + 1 < curve.length ? j + 1 : curve.length - 1) : 0
    panGains(base + (curve ? curve[ja] : 0), g0)
    panGains(base + (curve ? curve[jb] : 0), g1)
    const end = Math.min(n, i + HOP)
    const dl = ((g1[0] - g0[0]) * gain) / HOP
    const dr = ((g1[1] - g0[1]) * gain) / HOP
    let gl = g0[0] * gain
    let gr = g0[1] * gain
    for (; i < end; i++) {
      const v = src[i]
      L[i] += v * gl
      R[i] += v * gr
      gl += dl
      gr += dr
    }
  }
}

/**
 * One torch. Returns { L, R, drips: [landing times in s], sputters: count }.
 * o: { size 0..1, crackle 0..1, drips 0..1, move 0..1, pan -1..1,
 *      swingPan 0..1 (how far a swing carries it across; 0 on a wall),
 *      far 0..1 (a torch further off: quieter, duller, fewer details),
 *      floor 'stone' | 'ground', firstDrip seconds or null,
 *      mute { flame, fizz, wood, events, drips } (for measuring the parts) }
 */
export function torchLayer(n, sr, rng, o = {}) {
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  const out = { L, R, drips: [], sputters: 0 }
  if (n === 0) return out
  const rnd = new Rand32(rng.fork('torch'))
  const crnd = new Rand32(rng.fork('torch-curves'))
  const m = ctrlLen(n)
  const cr = sr / HOP
  const dur = n / sr
  const size = clamp(o.size === undefined ? 0.5 : o.size, 0, 1)
  const crackle = clamp(o.crackle === undefined ? 0.55 : o.crackle, 0, 1)
  const drips = clamp(o.drips === undefined ? 0.35 : o.drips, 0, 1)
  const move = clamp(o.move === undefined ? 0.2 : o.move, 0, 1)
  const pan0 = clamp(o.pan || 0, -1, 1)
  const swingPan = clamp(o.swingPan === undefined ? 1 : o.swingPan, 0, 1)
  const far = clamp(o.far || 0, 0, 1)
  const stone = o.floor !== 'ground'
  const mute = o.mute || {}

  // The puffing oscillator: rate from the flame's width, wandering a little.
  const D = 0.04 + 0.12 * size
  const fPuff = 1.5 / Math.sqrt(D)
  const wander = smoothCurve(m, cr, crnd, 0.6, 2)
  const depthC = smoothCurve(m, cr, crnd, 0.25, 2)
  const ruffle = smoothCurve(m, cr, crnd, 15, 2, 0.6)
  const slow = smoothCurve(m, cr, crnd, 0.3, 3)
  const P = new Float32Array(m)
  let ph = crnd.next()
  for (let i = 0; i < m; i++) {
    ph += (fPuff * (1 + 0.16 * wander[i])) / cr
    if (ph >= 1) ph -= 1
    const s = Math.sin(TWO_PI * ph)
    // A puff flares quickly and pinches off more gently.
    P[i] = s > 0 ? s : 0.6 * s
  }

  // Swings or draughts: air speed through the flame V, and where it is.
  const V = new Float32Array(m)
  const PN = new Float32Array(m)
  if (move > 0) {
    const rate = 0.05 + 0.3 * move
    let t = crnd.range(0.8, 3.5)
    while (t < dur) {
      const len = crnd.range(0.45, 1.3)
      const g = crnd.range(0.5, 1) * (0.4 + 0.6 * move)
      const dir = crnd.chance(0.5) ? 1 : -1
      const i0 = Math.round(t * cr)
      const tot = Math.max(2, Math.round(len * cr))
      for (let k = 0; k < tot; k++) {
        const i = i0 + k
        if (i >= m) break
        const x = k / tot
        const sx = Math.sin(Math.PI * x)
        V[i] += g * sx * sx
        PN[i] += dir * g * 0.35 * swingPan * sx
      }
      t += len + crnd.exp(1 / rate)
    }
  }

  // Sputters: the flame gutters, spits a run of pops, then flares back.
  const Mul = new Float32Array(m).fill(1)
  const EV = new Float32Array(n)
  const imp = new Impacts(EV, EV, sr, rnd)
  if (crackle > 0 && far < 0.6) {
    const rate = 0.025 + 0.1 * crackle
    let t = crnd.range(2.5, 8)
    while (t < dur) {
      out.sputters++
      const i0 = Math.round(t * cr)
      const dip = Math.round(0.18 * cr)
      const fl = Math.round(crnd.range(0.7, 1.4) * cr)
      const depth = crnd.range(0.3, 0.5)
      for (let k = 0; k < dip + fl; k++) {
        const i = i0 + k
        if (i >= m) break
        Mul[i] *= k < dip ? 1 - depth * Math.sin((Math.PI * k) / dip) : 1 + 0.35 * Math.exp((-3 * (k - dip)) / fl) * Math.min(1, (k - dip) / (0.08 * cr))
      }
      if (!mute.events) {
        const pops = 5 + crnd.int(12)
        let tp = t + 0.02
        for (let k = 0; k < pops; k++) {
          const a = 0.5 * crnd.range(0.25, 1) * (1 - 0.6 * far)
          if (crnd.chance(0.3)) imp.burst(tp, a * 1.2, 0, crnd.range(350, 900), 0.8, crnd.range(0.002, 0.004), 0.6)
          else imp.burst(tp, a, 0, crnd.logRange(1500, 5000), 1, crnd.range(0.0003, 0.0012), 0.8)
          tp += crnd.exp(0.045)
        }
        imp.burst(t, 0.06 * (1 - 0.6 * far), 0, crnd.range(4500, 6500), 0.7, 0.08, 0)
      }
      t += Math.max(2, crnd.exp(1 / rate))
    }
  }

  // Flame strength E, its centre and the whoosh of air.
  const E = new Float32Array(m)
  const E15 = new Float32Array(m)
  const E2 = new Float32Array(m)
  const fcBody = new Float32Array(m)
  const fcSide = new Float32Array(m)
  const gBody = new Float32Array(m)
  const gWhoosh = new Float32Array(m)
  const fcWhoosh = new Float32Array(m)
  const body0 = 430 - 170 * size
  for (let i = 0; i < m; i++) {
    const depth = clamp(0.3 + 0.22 * depthC[i], 0.08, 0.55)
    const e = clamp((1 + depth * P[i] + 0.22 * ruffle[i] + 0.15 * slow[i] + 1.1 * V[i]) * Mul[i], 0.12, 4)
    E[i] = e
    E15[i] = e * Math.sqrt(e)
    E2[i] = e * e
    fcBody[i] = body0 * (1 + 0.1 * ruffle[i] + 0.9 * V[i])
    fcSide[i] = fcBody[i] * 1.15
    gBody[i] = e
    gWhoosh[i] = V[i] * V[i]
    fcWhoosh[i] = 380 + 1200 * V[i]
  }

  const lvl = 1 - 0.75 * far
  if (!mute.flame) {
    const M = new Float32Array(n)
    // The flame's band, centred by its size.
    bandNoise(M, sr, rnd, fcBody, 0.65, gBody, 0.5, 1)
    // The low whump.
    let w = whiteArr(n, rnd)
    const lp = 120 + 160 * size
    eq(w, sr, [['lowpass', lp, 0.7], ['lowpass', lp * 1.4, 0.7]])
    applyCurve(w, E15, 0.9 * (0.6 + 0.6 * size))
    addInto(M, w)
    // The airy top, flapping hardest (a far torch has lost it to distance).
    if (far < 0.6) {
      w = whiteArr(n, rnd)
      eq(w, sr, [['highpass', 1700, 0.6], ['lowpass', 6500, 0.6]])
      applyCurve(w, E2, 0.045 * (1 - 0.5 * far))
      addInto(M, w)
    }
    // A rush of air when it swings.
    if (move > 0) bandNoise(M, sr, rnd, fcWhoosh, 0.8, gWhoosh, 0.35, 1)
    addPanned(L, R, M, pan0, PN, FLAME * lvl)
    // A little of the flame unique to each ear, for size, when it is close.
    if (far === 0) {
      bandNoise(L, sr, rnd, fcSide, 0.6, gBody, 0.17 * FLAME * lvl, 1)
      bandNoise(R, sr, rnd, fcSide, 0.6, gBody, 0.17 * FLAME * lvl, 1)
    }
  }

  if (!mute.fizz && far < 0.6) {
    // Burning pitch fizzing in spits.
    const spit = smoothCurve(m, cr, crnd, 1.4, 3)
    const Z = new Float32Array(m)
    const za = (0.15 + 0.85 * crackle) * 0.03 * (1 - 0.5 * far)
    for (let i = 0; i < m; i++) {
      const v = clamp(0.55 + 1.5 * spit[i], 0.08, 2)
      Z[i] = v * v * (0.5 + 0.5 * E[i]) * za
    }
    const z = sizzleArr(n, sr, rnd, 250 + 1100 * crackle, 0.12)
    eq(z, sr, [['bandpass', 5000, 0.6]])
    applyCurve(z, Z, 1)
    addPanned(L, R, z, pan0, PN, lvl)
  }

  if (!mute.wood) {
    // Wood crackle and small pops, from the fire engine, small and close.
    const wood = fireLayer(n, sr, rng.fork('torch-wood'), {
      size: 0.12 + 0.3 * size,
      crackle: (0.05 + 0.85 * crackle) * (1 - 0.4 * far),
      pops: (0.04 + 0.45 * crackle) * (1 - 0.6 * far),
      logs: 0,
      roar: 0,
      hiss: 0.1,
      flare: 0,
      width: 0.1,
    })
    const wm = wood.L
    for (let i = 0; i < n; i++) wm[i] = 0.5 * (wm[i] + wood.R[i])
    addPanned(L, R, wm, pan0, PN, 2.1 * (0.5 + 0.9 * crackle) * lvl)
  }

  // Drips of burning pitch: let go, fall, splat and hiss out on the floor.
  const FL = new Float32Array(n)
  const fimp = new Impacts(FL, FL, sr, rnd)
  if (drips > 0 && far < 0.6 && !mute.drips) {
    const rate = 0.02 + 0.13 * drips
    let t = o.firstDrip != null ? o.firstDrip : crnd.range(1.2, 4.5)
    while (t < dur) {
      const h = crnd.range(0.9, 1.6)
      const tf = Math.sqrt((2 * h) / 9.81)
      const g = crnd.range(0.6, 1)
      imp.burst(t, 0.15 * g, 0, crnd.range(2500, 4500), 1, 0.0006, 0.3)
      const tl = t + tf
      if (tl < dur) {
        out.drips.push(tl)
        fimp.burst(tl, 0.35 * g, 0, stone ? crnd.range(2200, 3000) : crnd.range(1200, 1800), 1.1, 0.0008, stone ? 0.5 : 0.15)
        fimp.lowBurst(tl, 0.15 * g, 0, stone ? 900 : 500, 0.004)
        const tau = crnd.range(0.12, 0.24)
        fimp.burst(tl + 0.003, 0.075 * g, 0, crnd.range(4800, 6500), 0.7, tau, 0)
        const ticks = 12 + crnd.int(25)
        for (let k = 0; k < ticks; k++) {
          const tk = tl + 0.005 + crnd.exp(tau * 1.2)
          const a = 0.12 * g * crnd.range(0.2, 1) * Math.exp(-(tk - tl) / (tau * 1.6))
          fimp.burst(tk, a, 0, crnd.logRange(2500, 8000), 1, 0.0002, 0.6)
        }
      }
      t += Math.max(1.5, crnd.exp(1 / rate))
    }
  }
  imp.renderBanks()
  fimp.renderBanks()
  // EV and FL were written through both "sides" of the event renderer at
  // the centre (0.707 each), so they carry sqrt(2) too much; 0.707 undoes it.
  addPanned(L, R, EV, pan0, PN, 0.707 * lvl)
  addPanned(L, R, FL, clamp(pan0 * 0.85, -1, 1), null, 0.707 * lvl)

  if (far > 0.02) {
    const fc = 13000 * Math.pow(1 - far, 1.6) + 1400
    eq(L, sr, [['lowpass', fc, 0.6]])
    eq(R, sr, [['lowpass', fc, 0.6]])
  }
  return out
}

const PLACES = {
  hand: { pan: 0, floor: 'ground', swingPan: 1, room: { size: 0.3, rt60: 0.25, damp: 0.6, predelayMs: 2 }, wet: 0.06, others: [] },
  wall: { pan: -0.25, floor: 'stone', swingPan: 0, room: { size: 1.1, rt60: 1.4, damp: 0.4, predelayMs: 8 }, wet: 0.38, others: [] },
  passage: {
    pan: -0.3,
    floor: 'stone',
    swingPan: 0,
    room: { size: 1.5, rt60: 2.3, damp: 0.45, predelayMs: 12 },
    wet: 0.48,
    others: [
      { pan: 0.45, far: 0.45, gain: 0.7 },
      { pan: -0.05, far: 0.75, gain: 0.55 },
    ],
  },
}

const bed = {
  id: 'torch',
  name: 'Crackling torch',
  group: 'fire',
  about: 'A burning torch fluttering and spitting, drips of burning pitch hissing out on the floor.',
  params: [
    { id: 'size', name: 'Size of the flame', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'crackle', name: 'Crackle and spit', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [20, 90] },
    { id: 'drips', name: 'Burning drips', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [0, 80] },
    { id: 'move', name: 'Movement', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [0, 70] },
    {
      id: 'place',
      name: 'Where it burns',
      type: 'choice',
      def: 'hand',
      options: [
        { v: 'hand', name: 'Held in your hand, outdoors' },
        { v: 'wall', name: 'On a stone wall' },
        { v: 'passage', name: 'A row down a stone passage' },
      ],
    },
  ],
  generate(seconds, sr, p, rng) {
    return runBed(bed, seconds, sr, p, rng, (n, rate, q, rg) => {
      const pl = PLACES[q.place] || PLACES.hand
      const size = q.size / 100
      const crackle = q.crackle / 100
      const move = q.move / 100
      const main = torchLayer(n, rate, rg.fork('main'), {
        size,
        crackle,
        drips: q.drips / 100,
        move,
        pan: pl.pan,
        swingPan: pl.swingPan,
        floor: pl.floor,
      })
      const { L, R } = main
      for (let k = 0; k < pl.others.length; k++) {
        const ot = pl.others[k]
        const t = torchLayer(n, rate, rg.fork('far-' + k), {
          size: size * 0.9,
          crackle: crackle * 0.8,
          drips: 0,
          move: move * 0.5,
          pan: ot.pan,
          swingPan: 0,
          far: ot.far,
          floor: pl.floor,
        })
        addInto(L, t.L, ot.gain)
        addInto(R, t.R, ot.gain)
      }
      new Fdn(rate, pl.room).process(L, R, pl.wet, 1)
      finishBed(L, R, rate, -21 + (q.size - 50) * 0.06, 3.5)
      return { L, R }
    })
  },
}

export default bed
