// modules/mod/chopper.js - Chopper: talking through helicopter blades, or into
// a spinning fan.
//
// What really happens when you talk into a fan: every blade that crosses the
// path between your mouth and the listener blocks part of the sound, so the
// voice is chopped at the blade-pass rate (blades x turns per second: a
// three-blade desk fan at about 1200 rpm chops at about 60 Hz, a helicopter
// rotor heard close by at 12 to 25 Hz). That periodic amplitude modulation
// puts sidebands around every harmonic of the voice, which is the buzzy,
// robotic "we are the fan people" sound. Three smaller things make it sound
// like a real fan rather than a tremolo, and this module models all of them:
// 1. Blade shape. A blade is opaque for part of its turn and the edges come
//    and go quickly, so the gain is not a sine: a blade-shaped occlusion
//    window (flat core, raised-cosine edges) is read from a table for thin
//    blades, wide blades, paddles that leave only a short gap, or a soft
//    sine wobble.
// 2. Diffraction. Low frequencies bend round a blade, high ones do not, so
//    the occlusion is frequency dependent: the voice is split by a one-pole
//    filter at 550 Hz and the lows dip only about half as deep as the highs
//    (the size argument of Kinsler and Frey, "Fundamentals of Acoustics":
//    an obstacle shadows wavelengths shorter than itself).
// 3. Moving reflections. While a blade is in the way it also reflects some
//    of the voice back off its moving face. That reflection arrives a
//    fraction of a millisecond late (comb colour) and, because the blade
//    surface moves, its delay sweeps across each pass, which shifts its
//    pitch (Doppler). The reflection is a second read of the same delay
//    line whose delay ramps from 0.35 to 1.25 ms across each cycle, faded in
//    by the occlusion so the ramp's reset is never heard.
// Rotor wobble: a real motor never runs perfectly evenly, so the turning
// speed drifts by a few percent (two smooth random walks, slow and fast),
// and the direct path itself is gently phase-modulated in step with the
// blades (at most 2 percent pitch deviation), the slight warble of air being
// pushed toward and away from you. Optional blade noise adds the rush of
// air, pulsing with each blade. The rotor can also spin up from a standstill
// or wind down, like a helicopter starting or a fan switched off.
//
// One streaming kernel serves offline and live. The direct path sits a few
// samples behind so it can be modulated both ways; live reports that as its
// latency and the offline render removes it.

import { DelayLine } from '../../core/delay.js'
import { makeRng } from '../../core/rng.js'

const TWO_PI = 2 * Math.PI
const TAB = 1024
const SHAPES = ['thin', 'wide', 'paddle', 'smooth']
const SPINS = ['steady', 'up', 'down']
const FM_MAX_MS = 0.12
const CTL = 16

function num(v, d) {
  return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : d
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

function smoothstep(x) {
  const t = x < 0 ? 0 : x > 1 ? 1 : x
  return t * t * (3 - 2 * t)
}

const params = [
  { id: 'rate', name: 'Chop rate', type: 'number', min: 4, max: 80, step: 0.5, def: 18, unit: 'hz', rand: [10, 60] },
  { id: 'depth', name: 'Depth', type: 'number', min: 0, max: 100, step: 1, def: 85, unit: 'percent', rand: [60, 100] },
  {
    id: 'blade', name: 'Blades', type: 'choice', def: 'wide',
    options: [
      { v: 'thin', name: 'Thin blades' },
      { v: 'wide', name: 'Wide blades' },
      { v: 'paddle', name: 'Paddles' },
      { v: 'smooth', name: 'Soft wobble' },
    ],
  },
  { id: 'wobble', name: 'Rotor wobble', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [10, 60] },
  { id: 'colour', name: 'Blade reflections', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
  { id: 'noise', name: 'Blade noise', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 30] },
  {
    id: 'spin', name: 'Rotor', type: 'choice', def: 'steady',
    options: [{ v: 'steady', name: 'Steady' }, { v: 'up', name: 'Spinning up' }, { v: 'down', name: 'Winding down' }],
  },
]

// Occlusion tables: 0 = clear path, 1 = blade fully in the way, blade
// centred at half a turn, and always exactly clear at the turn's start.
let TABLES = null
function tables() {
  if (TABLES) return TABLES
  const t = new Float32Array(4 * (TAB + 1))
  const spec = [
    [0.18, 0.08], // thin: core width, edge width (fractions of a turn)
    [0.38, 0.12], // wide
    [0.62, 0.1], // paddle: leaves a gap of about a fifth of a turn
  ]
  for (let s = 0; s < 4; s++) {
    for (let k = 0; k <= TAB; k++) {
      const q = k / TAB
      let v
      if (s === 3) v = 0.5 - 0.5 * Math.cos(TWO_PI * q)
      else {
        const w = spec[s][0] / 2
        const e = spec[s][1]
        const d = Math.abs(q - 0.5)
        v = d <= w ? 1 : d < w + e ? 0.5 + 0.5 * Math.cos((Math.PI * (d - w)) / e) : 0
      }
      t[s * (TAB + 1) + k] = v
    }
  }
  TABLES = t
  return t
}

function latencyFor(sr) {
  return Math.ceil((FM_MAX_MS / 1000) * sr) + 2
}

function createKernel(sr, p0, rngIn, totalSamples) {
  const rng = rngIn || makeRng('mod.chopper')
  const tab = tables()
  const lat = latencyFor(sr)
  const msS = sr / 1000
  const lines = [new DelayLine(lat + Math.ceil(1.4 * msS) + 8), new DelayLine(lat + Math.ceil(1.4 * msS) + 8)]
  const lo = new Float64Array(2)
  const cLo = 1 - Math.exp((-TWO_PI * Math.min(550, sr * 0.4)) / sr)
  const cNhp = 1 - Math.exp((-TWO_PI * Math.min(300, sr * 0.4)) / sr)
  const cNlp = 1 - Math.exp((-TWO_PI * Math.min(3000, sr * 0.4)) / sr)
  const sm = 1 - Math.exp(-1 / (0.03 * sr))
  const w1Inc = (0.9 * CTL) / sr
  const w2Inc = (6 * CTL) / sr
  const total = totalSamples > 0 ? totalSamples : 0
  let rateT = 18, depthT = 0.85, wobT = 0.3, colT = 0.5, noiseT = 0, shape = 1, spin = 0
  let rate = 18, depth = 0.85, wob = 0.3, col = 0.5, noise = 0
  let q = 0, el = 0, mul = 1
  let w1a = 0, w1b = 0, w1p = 0, w2a = 0, w2b = 0, w2p = 0, wv = 0
  let nh = 0, nl = 0
  let ctl = 0

  function set(p) {
    rateT = clamp(num(p.rate, 18), 0.5, 200)
    depthT = clamp(num(p.depth, 85), 0, 100) / 100
    wobT = clamp(num(p.wobble, 30), 0, 100) / 100
    colT = clamp(num(p.colour, 50), 0, 100) / 100
    noiseT = clamp(num(p.noise, 0), 0, 100) / 100
    const s = SHAPES.indexOf(p.blade)
    shape = s >= 0 ? s : 1
    const sp = SPINS.indexOf(p.spin)
    const nsp = sp >= 0 ? sp : 0
    if (nsp !== spin) el = 0
    spin = nsp
  }
  function spinMul() {
    if (spin === 1) return 0.06 + 0.94 * smoothstep(el / (3.5 * sr))
    if (spin === 2) {
      if (total > 0) {
        const start = Math.max(0, total - 4 * sr)
        return 1 - 0.85 * smoothstep((el - start) / Math.max(1, total - start))
      }
      return 1 - 0.85 * smoothstep(el / (6 * sr))
    }
    return 1
  }
  function control() {
    w1p += w1Inc
    if (w1p >= 1) {
      w1p -= 1
      w1a = w1b
      w1b = rng.next() * 2 - 1
    }
    w2p += w2Inc
    if (w2p >= 1) {
      w2p -= 1
      w2a = w2b
      w2b = rng.next() * 2 - 1
    }
    const v1 = w1a + (w1b - w1a) * (0.5 - 0.5 * Math.cos(Math.PI * w1p))
    const v2 = w2a + (w2b - w2a) * (0.5 - 0.5 * Math.cos(Math.PI * w2p))
    wv = 0.05 * v1 + 0.02 * v2
    mul = spinMul()
  }
  function snap() {
    rate = rateT
    depth = depthT
    wob = wobT
    col = colT
    noise = noiseT
  }
  function reset() {
    lines[0].clear()
    lines[1].clear()
    lo[0] = lo[1] = 0
    nh = nl = 0
    q = 0
    el = 0
    w1a = rng.next() * 2 - 1
    w1b = rng.next() * 2 - 1
    w2a = rng.next() * 2 - 1
    w2b = rng.next() * 2 - 1
    w1p = w2p = 0
    ctl = 0
    snap()
  }
  set(p0)
  reset()

  return {
    set,
    reset,
    process(ins, outs, n) {
      const nc = outs.length < 2 ? outs.length : 2
      const nIn = ins.length
      const base = tab
      const off = shape * (TAB + 1)
      for (let i = 0; i < n; i++) {
        if (ctl === 0) {
          control()
          ctl = CTL
        }
        ctl--
        el++
        rate += (rateT - rate) * sm
        depth += (depthT - depth) * sm
        wob += (wobT - wob) * sm
        col += (colT - col) * sm
        noise += (noiseT - noise) * sm
        const r = rate * mul * (1 + wob * wv)
        let nq = q + r / sr
        if (nq >= 1) nq -= Math.floor(nq)
        q = nq
        const x = q * TAB
        const k = x | 0
        const occ = base[off + k] + (base[off + k + 1] - base[off + k]) * (x - k)
        // direct path phase wobble, capped at 2 percent pitch deviation
        let fm = 0.018 / (TWO_PI * (r > 1 ? r : 1)) * 1000
        if (fm > FM_MAX_MS) fm = FM_MAX_MS
        const dDir = lat + fm * wob * msS * Math.sin(TWO_PI * q)
        const dRef = lat + (0.35 + 0.9 * q) * msS
        const gHi = 1 - depth * occ
        const gLo = 1 - depth * occ * 0.55
        const gRef = occ * col * 0.75
        // blade noise: band-limited rush that swells as each blade passes
        const w = rng.next() * 2 - 1
        nh += (w - nh) * cNhp
        const hp = w - nh
        nl += (hp - nl) * cNlp
        const air = noise > 0 ? nl * noise * 0.12 * (0.3 + 0.7 * occ) : 0
        const x0 = ins[0][i]
        const x1 = nIn > 1 ? ins[1][i] : x0
        for (let c = 0; c < nc; c++) {
          const line = lines[c]
          line.write(c === 0 ? x0 : x1)
          const v = line.read(dDir)
          let l = lo[c] + (v - lo[c]) * cLo
          if (l < 1e-20 && l > -1e-20) l = 0
          lo[c] = l
          const refl = gRef > 0 ? line.read(dRef) * gRef : 0
          outs[c][i] = l * gLo + (v - l) * gHi + refl + air
        }
      }
    },
  }
}

export default {
  id: 'mod.chopper',
  name: 'Chopper',
  family: 'mod',
  about: 'Talking through spinning helicopter blades, or into a fan: the buzzing, chopped, robot-like voice.',
  params,
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 2,
  process(input, p, ctx) {
    const sr = input.sr
    const nch = Math.min(2, input.ch.length)
    const len = nch ? input.ch[0].length : 0
    if (!len) return input
    const lat = latencyFor(sr)
    const total = len + lat
    const ins = input.ch.slice(0, nch).map((c) => {
      const y = new Float32Array(total)
      y.set(c)
      return y
    })
    const full = ins.map(() => new Float32Array(total))
    const k = createKernel(sr, p, ctx && ctx.rng, len)
    const B = 1 << 15
    for (let a = 0; a < total; a += B) {
      const b = Math.min(total, a + B)
      k.process(ins.map((c) => c.subarray(a, b)), full.map((c) => c.subarray(a, b)), b - a)
      if (ctx && typeof ctx.progress === 'function') ctx.progress(b / total)
      if (ctx && typeof ctx.cancelled === 'function' && ctx.cancelled()) break
    }
    return { sr, ch: full.map((c) => c.slice(lat)) }
  },
  live: {
    latency: (p, sr) => latencyFor(sr || 48000),
    create(sr, p, rng) {
      return createKernel(sr, p, rng, 0)
    },
  },
}
