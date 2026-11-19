// modules/space/hall.js - space.hall, "Hall reverb": the long, slow-blooming
// reverb of a concert hall, the one a ballad vocal sits in.
//
// Technique: the 16-line feedback delay network of ./reverb.js (Jot and
// Chaigne, "Digital delay networks for designing artificial reverberators",
// AES 1991; Householder feedback, modulated lines, frequency-dependent
// decay), set the way concert halls measure (Beranek, "Concert Halls and
// Opera Houses", 2nd ed. 2004; Barron, "Auditorium Acoustics and
// Architectural Design", 2nd ed. 2010):
// - long delay lines (18 to 46 ms for the shortest), so the echoes are far
//   apart at first and the tail builds slowly instead of arriving at once;
// - a clear gap before the first reflection (the "initial time delay gap",
//   15 to 40 ms in good halls), which keeps the words in front of the room;
// - a sparse fan of early reflections off the side walls, spread wide, since
//   early sound from the sides is what makes a hall feel spacious;
// - bass that rings longer than the middle (a bass ratio above 1 is the
//   "warmth" of a hall) and a top that dies sooner (air and seats);
// - slow, gentle modulation, enough to stop the tail ringing like metal.
// The same code runs offline and live.

import { FdnEngine, fdnConfig, MixInstance, dryGain, wetGain, renderLive } from './reverb.js'

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

// Early reflections off the side walls, balcony fronts and ceiling: times in
// units of the shortest line (so they move with the size), and where each
// arrives from (-1 left, +1 right).
const ER_T = [0.55, 0.78, 1.12, 1.37, 1.71, 2.05, 2.46, 2.9, 3.4, 3.95]
const ER_PAN = [-0.85, 0.8, -0.45, 0.95, 0.3, -0.95, 0.6, -0.2, -0.7, 0.75]

function hallSetup(st, p) {
  const c = st.cfg
  const size = clamp(num(p.size, 60), 0, 100) / 100
  const decay = clamp(num(p.decay, 2.6), 0.5, 12)
  const dark = clamp(num(p.damping, 45), 0, 100) / 100
  const warm = clamp(num(p.warmth, 40), 0, 100) / 100
  const early = clamp(num(p.early, 50), 0, 100) / 100
  c.minDelayMs = 18 + 28 * size
  c.spread = 3.1
  c.decay = decay
  c.hiRatio = 1 / (1 + 2.2 * dark)
  c.hiHz = 7000 * Math.pow(0.36, dark)
  c.bassRatio = 1 + 0.45 * warm
  c.bassHz = 250
  c.mod = 0.22
  c.modRate = 0.4
  c.predelayMs = clamp(num(p.predelay, 25), 0, 150)
  c.diffusion = 1
  c.sendHp = clamp(num(p.lowcut, 120), 20, 500)
  c.sendLp = 14000 * Math.pow(0.55, dark)
  // the tail's loudness rises gently with the decay, as in ./reverb.js
  c.lateGain = 0.85 * Math.pow(decay / 1.8, 0.25)
  c.earlyGain = 1
  c.earlyLp = 6500
  c.width = clamp(num(p.width, 1.1), 0, 1.5)
  c.freeze = 0
  c.shimmer = 0
  st.fdn.configure(c)
  // early energy: up to about half the tail's, set by "Early echoes"
  let e = 0
  for (let k = 0; k < ER_T.length; k++) {
    const gk = Math.exp(-0.55 * ER_T[k])
    e += gk * gk
  }
  const er = early > 0 ? Math.sqrt((0.5 * early) / e) * c.lateGain : 0
  for (let k = 0; k < ER_T.length; k++) {
    const gk = Math.exp(-0.55 * ER_T[k]) * er
    const pan = ER_PAN[k]
    st.tMs[k] = ER_T[k] * c.minDelayMs + 2
    st.tL[k] = gk * Math.sqrt(0.5 * (1 - pan))
    st.tR[k] = gk * Math.sqrt(0.5 * (1 + pan))
  }
  st.fdn.setTaps(ER_T.length, st.tMs, st.tL, st.tR)
  st.mix.dryT = dryGain(p.mix)
  st.mix.wetT = wetGain(p.mix)
}

function makeHallLive(sr, p, rng) {
  const fdn = new FdnEngine(sr, { lines: 16, maxLineMs: 160, maxPreMs: 360, rng: rng && rng.fork ? rng.fork('hall') : rng })
  const st = { fdn, cfg: fdnConfig(), mix: new MixInstance(sr), tMs: new Float64Array(16), tL: new Float64Array(16), tR: new Float64Array(16) }
  hallSetup(st, p)
  return {
    process(ins, outs, n) {
      st.mix.mixBlock(ins, outs, n, fdn)
    },
    set(np) {
      hallSetup(st, np)
    },
    reset() {
      fdn.reset()
      st.mix.inited = false
    },
  }
}

function hallTail(p) {
  const decay = clamp(num(p && p.decay, 2.6), 0.5, 12)
  const warm = clamp(num(p && p.warmth, 40), 0, 100) / 100
  return Math.min(30, clamp(num(p && p.predelay, 25), 0, 150) / 1000 + decay * (1.12 + 0.3 * warm) + 0.25)
}

export default {
  id: 'space.hall',
  name: 'Hall reverb',
  family: 'space',
  about: 'A concert hall around your voice: a short gap, wide early echoes, then a long warm tail. The classic reverb for a slow song.',
  params: [
    { id: 'size', name: 'Hall size', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [35, 90] },
    { id: 'decay', name: 'Decay time', type: 'number', min: 0.5, max: 12, step: 0.1, def: 2.6, unit: 'seconds', rand: [1.6, 5] },
    { id: 'predelay', name: 'Gap before the hall answers', type: 'number', min: 0, max: 150, step: 1, def: 25, unit: 'ms', rand: [10, 60] },
    { id: 'damping', name: 'Darkness', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [25, 70] },
    { id: 'warmth', name: 'Low end bloom', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [20, 70] },
    { id: 'early', name: 'Early echoes', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [25, 75] },
    { id: 'lowcut', name: 'Low cut', type: 'number', min: 20, max: 500, step: 5, def: 120, unit: 'hz' },
    { id: 'width', name: 'Width', type: 'number', min: 0, max: 1.5, step: 0.05, def: 1.1, unit: 'x', rand: [0.8, 1.4] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 28, unit: 'percent', rand: [15, 40] },
  ],
  stereo: 'make',
  tail: (p) => hallTail(p),
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    const inst = makeHallLive(input.sr, p, ctx && ctx.rng)
    return renderLive(inst, input, hallTail(p), ctx, 0.25)
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p, rng) {
      return makeHallLive(sr, p, rng)
    },
  },
}
