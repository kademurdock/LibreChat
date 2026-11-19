// modules/space/plate.js - space.plate, "Plate reverb": the bright, smooth
// studio reverb that sat behind most recorded vocals from the late 1950s on.
//
// Technique: a plate reverb is a thin steel sheet, about two metres by one,
// hung on springs, driven by a transducer and heard through two pickups.
// What the ear gets from it (Arcas and Chaigne, "On the quality of plate
// reverberation", Applied Acoustics 71, 2010; Bilbao, "A digital plate
// reverberation algorithm", JAES 55, 2007):
// - no early reflections and no gap: the sound is dense from the first
//   instant, because bending waves in steel are dispersive and the plate is
//   small, so thousands of modes answer at once;
// - a bright top that lasts, since a steel plate loses its highs far more
//   slowly than a room full of air and people does;
// - a decay set by a damping pad pressed near the plate, from under a second
//   to five or six;
// - a wide, even stereo picture from the two pickups.
// Here that behaviour is made with the 16-line feedback delay network of
// ./reverb.js (Jot and Chaigne 1991) run very dense: short lines (4 to 9 ms
// for the shortest), full input diffusion, no early taps, high frequencies
// kept nearly as long as the middle, and only a trace of modulation. Studios
// almost always high-passed the send to a plate, so a low cut is built in.
// The same code runs offline and live.

import { FdnEngine, fdnConfig, MixInstance, dryGain, wetGain, renderLive } from './reverb.js'

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

function plateSetup(st, p) {
  const c = st.cfg
  const decay = clamp(num(p.decay, 1.8), 0.3, 8)
  const tone = clamp(num(p.tone, 65), 0, 100) / 100
  const thick = clamp(num(p.size, 50), 0, 100) / 100
  c.minDelayMs = 4 + 5 * thick
  c.spread = 2.6
  c.decay = decay
  c.hiRatio = 0.45 + 0.5 * tone
  c.hiHz = 3500 + 6500 * tone
  c.bassRatio = 1.05
  c.bassHz = 200
  c.mod = clamp(num(p.modulation, 15), 0, 100) / 100 * 0.5
  c.modRate = 0.7
  c.predelayMs = clamp(num(p.predelay, 0), 0, 120)
  c.diffusion = 1
  c.sendHp = clamp(num(p.lowcut, 180), 20, 600)
  c.sendLp = 9000 + 9000 * tone
  c.lateGain = 0.9 * Math.pow(decay / 1.8, 0.25)
  c.earlyGain = 0
  c.earlyLp = 0
  c.width = clamp(num(p.width, 1), 0, 1.5)
  c.freeze = 0
  c.shimmer = 0
  st.fdn.configure(c)
  st.mix.dryT = dryGain(p.mix)
  st.mix.wetT = wetGain(p.mix)
}

function makePlateLive(sr, p, rng) {
  const fdn = new FdnEngine(sr, { lines: 16, maxLineMs: 60, maxPreMs: 160, rng: rng && rng.fork ? rng.fork('plate') : rng })
  const st = { fdn, cfg: fdnConfig(), mix: new MixInstance(sr) }
  fdn.setTaps(0, [], [], [])
  plateSetup(st, p)
  return {
    process(ins, outs, n) {
      st.mix.mixBlock(ins, outs, n, fdn)
    },
    set(np) {
      plateSetup(st, np)
    },
    reset() {
      fdn.reset()
      st.mix.inited = false
    },
  }
}

function plateTail(p) {
  const decay = clamp(num(p && p.decay, 1.8), 0.3, 8)
  return Math.min(30, clamp(num(p && p.predelay, 0), 0, 120) / 1000 + decay * 1.15 + 0.15)
}

export default {
  id: 'space.plate',
  name: 'Plate reverb',
  family: 'space',
  about: 'The bright, smooth studio reverb from a ringing steel plate: dense from the first instant, with no echoes in it. A classic on singing.',
  params: [
    { id: 'decay', name: 'Decay time', type: 'number', min: 0.3, max: 8, step: 0.1, def: 1.8, unit: 'seconds', rand: [0.9, 3.5] },
    { id: 'predelay', name: 'Gap before the plate', type: 'number', min: 0, max: 120, step: 1, def: 0, unit: 'ms', rand: [0, 40] },
    { id: 'tone', name: 'Brightness', type: 'number', min: 0, max: 100, step: 1, def: 65, unit: 'percent', rand: [40, 85] },
    { id: 'size', name: 'Plate size', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [25, 80] },
    { id: 'modulation', name: 'Swirl', type: 'number', min: 0, max: 100, step: 1, def: 15, unit: 'percent', rand: [5, 40] },
    { id: 'lowcut', name: 'Low cut', type: 'number', min: 20, max: 600, step: 5, def: 180, unit: 'hz' },
    { id: 'width', name: 'Width', type: 'number', min: 0, max: 1.5, step: 0.05, def: 1, unit: 'x', rand: [0.8, 1.3] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [15, 45] },
  ],
  stereo: 'make',
  tail: (p) => plateTail(p),
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    const inst = makePlateLive(input.sr, p, ctx && ctx.rng)
    return renderLive(inst, input, plateTail(p), ctx, 0.15)
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p, rng) {
      return makePlateLive(sr, p, rng)
    },
  },
}
