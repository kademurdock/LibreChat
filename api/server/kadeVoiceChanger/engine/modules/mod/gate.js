// modules/mod/gate.js - Rhythm gate: the voice switched on and off in a beat.
//
// Technique: the tempo-synced step gate ("trance gate") of dance-music
// production: a step sequencer, here 8 to 34 steps long, holds a level for
// every step and the voice's gain follows it, so speech is cut into a
// rhythm. Steps are sixteenth notes by default (eighths, thirty-seconds and
// sixteenth triplets are offered) at the chosen tempo. Swing delays every
// second step, the way a drum machine's shuffle does (the first step of each
// pair gets from 50 up to 75 percent of the pair's length). Each edge is
// rounded by a one-pole smoother (the edge softness), which keeps a hard
// gate free of clicks and lets a soft one breathe. The step clock is a
// running position that advances by tempo / 60 x steps per beat / rate every
// sample, so a tempo change mid-stream never jumps. Offline, "start on the
// first word" begins the pattern at the first spoken sound instead of at the
// start of the file, so the first syllable lands on the downbeat.
//
// Patterns: trance (the classic offbeat-heavy sixteenth gate), stutter
// (every other step), offbeat pump (only the "and"), gallop, triplet,
// half time, heartbeat (lub-dub), dots and dashes (S O S in the telegraph
// code, one step per dot) and random (drawn once from the stage's seed, so
// the same seed repeats it).

import { makeRng } from '../../core/rng.js'

const PATTERNS = {
  trance: [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1],
  stutter: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
  offbeat: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
  gallop: [1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1],
  triplet: [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0],
  halftime: [1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0],
  heartbeat: [1, 1, 0, 1, 1, 0, 0, 0],
  // S O S: dot = 1 step, dash = 3, gaps of 1 inside a letter, 3 between, 7 after
  morse: [1, 0, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0],
}
const NAMES = ['trance', 'stutter', 'offbeat', 'gallop', 'triplet', 'halftime', 'heartbeat', 'morse', 'random']
const MAXLEN = 34

function num(v, d) {
  return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : d
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

const params = [
  {
    id: 'pattern', name: 'Pattern', type: 'choice', def: 'trance',
    options: [
      { v: 'trance', name: 'Trance' },
      { v: 'stutter', name: 'Stutter' },
      { v: 'offbeat', name: 'Offbeat pump' },
      { v: 'gallop', name: 'Gallop' },
      { v: 'triplet', name: 'Triplet feel' },
      { v: 'halftime', name: 'Half time' },
      { v: 'heartbeat', name: 'Heartbeat' },
      { v: 'morse', name: 'Dots and dashes' },
      { v: 'random', name: 'Random' },
    ],
  },
  { id: 'tempo', name: 'Tempo', type: 'number', min: 60, max: 200, step: 1, def: 120, unit: 'bpm', rand: [90, 140] },
  {
    id: 'steps', name: 'Step size', type: 'choice', def: '4',
    options: [
      { v: '4', name: 'Sixteenth notes' },
      { v: '2', name: 'Eighth notes' },
      { v: '8', name: 'Thirty-second notes' },
      { v: '6', name: 'Sixteenth triplets' },
    ],
  },
  { id: 'smooth', name: 'Edge softness', type: 'number', min: 1, max: 50, step: 1, def: 5, unit: 'ms', rand: [2, 12] },
  { id: 'depth', name: 'Depth', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [70, 100] },
  { id: 'swing', name: 'Swing', type: 'number', min: 0, max: 75, step: 1, def: 0, unit: 'percent', rand: [0, 40] },
  { id: 'sync', name: 'Start on the first word', type: 'bool', def: true },
]

/** First sample where the take rises within 30 dB of its peak (minus 10 ms). */
function firstSound(chs, sr) {
  const n = chs[0].length
  let pk = 0
  for (let c = 0; c < chs.length; c++) {
    const s = chs[c]
    for (let i = 0; i < n; i++) {
      const a = s[i] < 0 ? -s[i] : s[i]
      if (a > pk && a < 1e30) pk = a
    }
  }
  if (!(pk > 1e-6)) return 0
  const th = pk * 0.0316
  // a peak follower (20 ms release) must stay above the threshold for 12 ms,
  // so a lone click does not count as the first word
  const rel = Math.exp(-1 / (0.02 * sr))
  const need = Math.max(1, Math.round(sr * 0.012))
  let env = 0
  let run = 0
  for (let i = 0; i < n; i++) {
    let a = 0
    for (let c = 0; c < chs.length; c++) {
      const v = chs[c][i] < 0 ? -chs[c][i] : chs[c][i]
      if (v > a && v < 1e30) a = v
    }
    env = a > env ? a : env * rel
    if (env > th) {
      run++
      if (run >= need) return Math.max(0, i - run - Math.round(sr * 0.01))
    } else run = 0
  }
  return 0
}

function createKernel(sr, p0, rngIn, startSample) {
  const rng = rngIn || makeRng('mod.gate')
  const pat = new Float64Array(MAXLEN)
  const rnd = new Float64Array(16)
  for (let k = 0; k < 16; k++) rnd[k] = k === 0 || rng.next() < 0.58 ? 1 : 0
  const smP = 1 - Math.exp(-1 / (0.03 * sr))
  let len = 16, inc = 0, swingT = 0, depthT = 1, coef = 0
  let swing = 0, depth = 1
  let pos = 0, g = 1
  const pos0 = -(startSample || 0)

  function set(p) {
    const name = NAMES.indexOf(p.pattern) >= 0 ? p.pattern : 'trance'
    const src = name === 'random' ? rnd : PATTERNS[name]
    len = src.length
    for (let k = 0; k < len; k++) pat[k] = src[k]
    const spb = clamp(num(Number(p.steps), 4), 1, 16)
    inc = ((clamp(num(p.tempo, 120), 20, 400) / 60) * spb) / sr
    swingT = clamp(num(p.swing, 0), 0, 75) / 100
    depthT = clamp(num(p.depth, 100), 0, 100) / 100
    coef = 1 - Math.exp(-1000 / (clamp(num(p.smooth, 5), 0.2, 200) * sr))
  }
  function level(ps) {
    if (ps < 0) return 1
    const pair = Math.floor(ps / 2)
    const fr = ps / 2 - pair
    const split = 0.5 + swing / 3
    const k = 2 * pair + (fr < split ? 0 : 1)
    return pat[k % len]
  }
  function reset() {
    swing = swingT
    depth = depthT
    pos = pos0 * inc
    g = 1 - depth * (1 - level(pos))
  }
  set(p0)
  reset()

  return {
    set,
    reset,
    process(ins, outs, n) {
      const nc = outs.length
      const nIn = ins.length
      for (let i = 0; i < n; i++) {
        swing += (swingT - swing) * smP
        depth += (depthT - depth) * smP
        const t = 1 - depth * (1 - level(pos))
        g += (t - g) * coef
        pos += inc
        if (pos > 1e9) pos -= Math.floor(1e9 / (2 * len)) * 2 * len
        for (let c = 0; c < nc; c++) {
          const x = ins[c < nIn ? c : nIn - 1][i]
          outs[c][i] = x * g
        }
      }
    },
  }
}

export default {
  id: 'mod.gate',
  name: 'Rhythm gate',
  family: 'mod',
  about: 'Chops your voice on and off in a beat, from a trance gate to a heartbeat or dots and dashes.',
  params,
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 1,
  process(input, p, ctx) {
    const sr = input.sr
    const len = input.ch.length ? input.ch[0].length : 0
    if (!len) return input
    const start = p.sync === false ? 0 : firstSound(input.ch, sr)
    const outs = input.ch.map(() => new Float32Array(len))
    const k = createKernel(sr, p, ctx && ctx.rng, start)
    k.process(input.ch, outs, len)
    if (ctx && typeof ctx.progress === 'function') ctx.progress(1)
    return { sr, ch: outs }
  },
  live: {
    latency: () => 0,
    create(sr, p, rng) {
      return createKernel(sr, p, rng, 0)
    },
  },
}
