// modules/mod/tremolo.js - Tremolo: the voice pulses louder and softer.
//
// Technique: amplitude modulation by a low-frequency oscillator, the oldest
// effect on guitar amplifiers (see Udo Zolzer, ed., "DAFX: Digital Audio
// Effects", 2nd ed. 2011, chapter 2 on modulators). The gain follows
// g = 1 - depth * (1 - u), where u runs 0..1 along the chosen wave, so at full
// depth the quiet point is silence and the loud point is the untouched
// voice. The waves: smooth (sine), even (triangle), choppy (square), pulsing
// (instant rise, slow fall), swelling (slow rise, instant drop) and random
// (a new level each cycle, sample and hold). Every gain curve passes through
// a short one-pole smoother (2 ms for the waves with corners, 0.3 ms for the
// smooth ones), so the corners of the square and the jumps of the pulse and
// random waves never click. The right channel can run up to half a cycle
// behind the left, which turns a mono pulse into a stereo swirl (at half a
// cycle the voice swaps sides, like an auto-pan). The output is always
// stereo.

import { makeRng } from '../../core/rng.js'

const TWO_PI = 2 * Math.PI
const SHAPES = ['sine', 'triangle', 'square', 'saw', 'ramp', 'random']

function num(v, d) {
  return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : d
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

const params = [
  { id: 'rate', name: 'Speed', type: 'number', min: 0.5, max: 20, step: 0.1, def: 5.5, unit: 'hz', rand: [2, 9] },
  { id: 'depth', name: 'Depth', type: 'number', min: 0, max: 100, step: 1, def: 70, unit: 'percent', rand: [40, 100] },
  {
    id: 'shape', name: 'Wave', type: 'choice', def: 'sine',
    options: [
      { v: 'sine', name: 'Smooth' },
      { v: 'triangle', name: 'Even' },
      { v: 'square', name: 'Choppy' },
      { v: 'saw', name: 'Pulsing' },
      { v: 'ramp', name: 'Swelling' },
      { v: 'random', name: 'Random' },
    ],
  },
  { id: 'phase', name: 'Stereo offset', type: 'number', min: 0, max: 180, step: 5, def: 0, unit: 'degrees', rand: [0, 120] },
]

function shapeValue(shape, q, r) {
  switch (shape) {
    case 1:
      return q < 0.5 ? 2 * q : 2 - 2 * q
    case 2:
      return q < 0.5 ? 1 : 0
    case 3:
      return 1 - q
    case 4:
      return q
    case 5:
      return r
    default:
      return 0.5 + 0.5 * Math.sin(TWO_PI * q)
  }
}

function createKernel(sr, p0, rngIn) {
  const rng = rngIn || makeRng('mod.tremolo')
  const smSoft = 1 - Math.exp(-1 / (0.0003 * sr))
  const smHard = 1 - Math.exp(-1 / (0.002 * sr))
  const smP = 1 - Math.exp(-1 / (0.03 * sr))
  let inc = 5.5 / sr, depthT = 0.7, shape = 0, offT = 0
  let depth = 0.7, off = 0
  let q = 0, qr = 0, rL = 1, rR = 1, gL = 1, gR = 1

  function set(p) {
    inc = clamp(num(p.rate, 5.5), 0, 40) / sr
    depthT = clamp(num(p.depth, 70), 0, 100) / 100
    const s = SHAPES.indexOf(p.shape)
    shape = s >= 0 ? s : 0
    offT = clamp(num(p.phase, 0), 0, 360) / 360
  }
  function reset() {
    depth = depthT
    off = offT
    q = 0
    qr = off
    rL = 1
    rR = 1
    gL = 1 - depth * (1 - shapeValue(shape, q, rL))
    gR = 1 - depth * (1 - shapeValue(shape, qr, rR))
  }
  set(p0)
  reset()

  return {
    set,
    reset,
    process(ins, outs, n) {
      const nIn = ins.length
      const two = outs.length > 1
      const sm = shape === 0 || shape === 1 ? smSoft : smHard
      for (let i = 0; i < n; i++) {
        const x0 = ins[0][i]
        const x1 = nIn > 1 ? ins[1][i] : x0
        depth += (depthT - depth) * smP
        off += (offT - off) * smP
        let nq = q + inc
        if (nq >= 1) {
          nq -= Math.floor(nq)
          rL = rng.next()
        }
        q = nq
        let nr = q + off
        if (nr >= 1) nr -= 1
        if (nr < qr && qr - nr > 0.5) rR = rng.next()
        qr = nr
        const tL = 1 - depth * (1 - shapeValue(shape, q, rL))
        const tR = 1 - depth * (1 - shapeValue(shape, qr, rR))
        gL += (tL - gL) * sm
        gR += (tR - gR) * sm
        outs[0][i] = x0 * gL
        if (two) outs[1][i] = x1 * gR
      }
    },
  }
}

export default {
  id: 'mod.tremolo',
  name: 'Tremolo',
  family: 'mod',
  about: 'Your voice pulses louder and softer, from a gentle shimmer to a hard machine-gun stutter.',
  params,
  stereo: 'make',
  tail: () => 0,
  warps: false,
  cost: 1,
  process(input, p, ctx) {
    const sr = input.sr
    const len = input.ch.length ? input.ch[0].length : 0
    const outs = [new Float32Array(len), new Float32Array(len)]
    if (!len) return { sr, ch: outs }
    const k = createKernel(sr, p, ctx && ctx.rng)
    k.process(input.ch, outs, len)
    if (ctx && typeof ctx.progress === 'function') ctx.progress(1)
    return { sr, ch: outs }
  },
  live: {
    latency: () => 0,
    create(sr, p, rng) {
      return createKernel(sr, p, rng)
    },
  },
}
