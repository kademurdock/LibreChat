// modules/space/shimmer.js - space.shimmer, the angelic reverb whose tail
// climbs into octaves and fifths, as if a choir answered from the ceiling.
//
// Technique: the "shimmer" reverb of 1980s and 1990s ambient production: a
// pitch shifter inside a reverb's feedback loop, so every trip round the
// loop is shifted again and the tail rises in steps of the interval while it
// decays. Here the reverb is the 16-line feedback delay network of
// ./reverb.js (Jot and Chaigne 1991, Householder feedback, modulated lines,
// frequency-dependent decay), and the shifter is a delay-line granular pitch
// shifter: two read taps sweep through a 70 ms buffer at the shifted speed,
// each under a sine-squared window, half a sweep apart, so the windows always
// sum to one (the classic rotating-tap shifter of studio harmonisers). A low
// pass in the loop keeps the climbing octaves from turning into whistles and
// a soft limit on what goes round keeps the loop bounded; its gain is
// normalised so a full shimmer still loses a fifth of its energy per trip.
// The same code runs offline and live.

import { FdnEngine, fdnConfig, MixInstance, dryGain, wetGain, renderLive } from './reverb.js'

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

// [first ratio, second ratio (0 = none), level of the second]
const INTERVALS = {
  octave: [2, 0, 0],
  fifth: [1.5, 0, 0],
  octfifth: [2, 1.5, 0.7],
  twooct: [2, 4, 0.55],
  down: [0.5, 0, 0],
  downup: [0.5, 2, 0.8],
}

function shimmerSetup(st, p) {
  const c = st.cfg
  const size = clamp(num(p.size, 70), 0, 100)
  const decay = clamp(num(p.decay, 5), 1, 20)
  const tone = clamp(num(p.tone, 55), 0, 100) / 100
  const iv = INTERVALS[p.interval] || INTERVALS.octave
  c.minDelayMs = 12 * Math.pow(2, (size - 50) / 25)
  c.spread = 3.1
  c.decay = decay
  c.hiRatio = 0.35 + 0.5 * tone
  c.hiHz = 3000 + 4000 * tone
  c.bassRatio = 1.05
  c.bassHz = 220
  c.mod = 0.45
  c.modRate = 0.5
  c.predelayMs = 20
  c.diffusion = 1
  c.sendHp = 140
  c.sendLp = 9000 + 6000 * tone
  c.lateGain = 0.85 * Math.pow(decay / 1.8, 0.25)
  c.earlyGain = 0
  c.earlyLp = 0
  c.width = 1.2
  c.freeze = 0
  c.shimmer = clamp(num(p.amount, 60), 0, 100) / 100
  c.shRatioA = iv[0]
  c.shRatioB = iv[1]
  c.shMixB = iv[2]
  c.shLp = 3500 + 8500 * tone
  st.fdn.configure(c)
  st.mix.dryT = dryGain(p.mix)
  st.mix.wetT = wetGain(p.mix)
}

function makeShimmerLive(sr, p, rng) {
  const fdn = new FdnEngine(sr, { lines: 16, maxLineMs: 160, maxPreMs: 60, rng: rng && rng.fork ? rng.fork('shimmer') : rng, shimmer: true })
  const st = { fdn, cfg: fdnConfig(), mix: new MixInstance(sr) }
  fdn.setTaps(0, [], [], [])
  shimmerSetup(st, p)
  return {
    process(ins, outs, n) {
      st.mix.mixBlock(ins, outs, n, fdn)
    },
    set(np) {
      shimmerSetup(st, np)
    },
    reset() {
      fdn.reset()
      st.mix.inited = false
    },
  }
}

function shimmerTail(p) {
  const decay = clamp(num(p.decay, 5), 1, 20)
  const amt = clamp(num(p.amount, 60), 0, 100) / 100
  return Math.min(30, decay * (1.15 + 0.85 * amt) + 0.3)
}

export default {
  id: 'space.shimmer',
  name: 'Shimmer',
  family: 'space',
  about: 'A heavenly reverb whose tail rises an octave or a fifth, like a choir answering from above.',
  params: [
    {
      id: 'interval',
      name: 'Interval',
      type: 'choice',
      def: 'octave',
      options: [
        { v: 'octave', name: 'Octave up' },
        { v: 'fifth', name: 'Fifth up' },
        { v: 'octfifth', name: 'Octave and fifth' },
        { v: 'twooct', name: 'One and two octaves up' },
        { v: 'down', name: 'Octave down' },
        { v: 'downup', name: 'Octave down and up' },
      ],
    },
    { id: 'amount', name: 'Shimmer', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [35, 80] },
    { id: 'decay', name: 'Decay time', type: 'number', min: 1, max: 20, step: 0.1, def: 5, unit: 'seconds', rand: [3, 9] },
    { id: 'size', name: 'Size', type: 'number', min: 0, max: 100, step: 1, def: 70, unit: 'percent', rand: [45, 90] },
    { id: 'tone', name: 'Brightness', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [35, 75] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [25, 55] },
  ],
  stereo: 'make',
  tail: (p) => shimmerTail(p),
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    const inst = makeShimmerLive(input.sr, p, ctx && ctx.rng)
    return renderLive(inst, input, shimmerTail(p), ctx, 0.25)
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p, rng) {
      return makeShimmerLive(sr, p, rng)
    },
  },
}
