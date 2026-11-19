// modules/synth/am.js - audio-rate amplitude modulation (synth.am).
//
// Technique: amplitude modulation with the carrier kept (Zolzer (ed.),
// DAFX: Digital Audio Effects, 2nd edition 2011, chapter 2, "Amplitude
// modulation"). The gain swings between 1 - depth and 1 at the flutter
// speed. Below about 15 Hz that is a tremolo; from 20 to 60 Hz the ear stops
// hearing separate beats and hears roughness instead, a gargle or a voice
// through a fan; above 100 Hz the gain swing adds sidebands either side of
// every partial while the voice itself stays, which is the buzz of insect
// wings and of a mouth full of bees.
//
// Shapes of the gain swing (u runs 0..1, gain = 1 - depth + depth u):
//   smooth        raised sine
//   triangle      straight ramps
//   choppy square soft square, tanh(5 sin)/tanh(5), so its edges never click
//   short bursts  a raised-cosine pulse open for 30 percent of each cycle
//                 (wing beats, a helicopter blade passing a microphone)
//   random steps  a new random level every cycle, slewed a little
//   bubbly        smooth random: cosine glides from one random level to the
//                 next every cycle (gargling, boiling)
// Unsteadiness gives every cycle its own length and depth, drawn from the
// stage's seeded rng, so a gargle sounds wet and organic instead of motorised.
//
// Loudness: the average power of each gain shape is measured once at load
// (the mean and mean square of u), and the output is divided by the RMS of
// the gain so the flutter does not make the voice quieter.
//
// Live mode runs the same core block by block; speed, depth and mix are
// smoothed and a change of shape crossfades over 10 ms.

import { bufLen } from '../../core/buf.js'
import { makeRng } from '../../core/rng.js'

const TWO_PI = 2 * Math.PI
const SHAPES = ['sine', 'triangle', 'square', 'pulse', 'random', 'bubbly']
const SQ_K = 5
const SQ_N = 1 / Math.tanh(SQ_K)
const PULSE_W = 0.3

function uDet(s, ph) {
  switch (s) {
    case 0:
      return 0.5 + 0.5 * Math.sin(TWO_PI * ph)
    case 1:
      return ph < 0.5 ? 2 * ph : 2 - 2 * ph
    case 2:
      return 0.5 + 0.5 * Math.tanh(SQ_K * Math.sin(TWO_PI * ph)) * SQ_N
    case 3:
      return ph < PULSE_W ? 0.5 - 0.5 * Math.cos((TWO_PI * ph) / PULSE_W) : 0
  }
  return 0.5
}

// Mean and mean square of u for each shape (measured once).
const EU = new Float64Array(6)
const EU2 = new Float64Array(6)
;(function measureShapes() {
  const N = 4096
  for (let s = 0; s < 4; s++) {
    let a = 0
    let b = 0
    for (let i = 0; i < N; i++) {
      const u = uDet(s, (i + 0.5) / N)
      a += u
      b += u * u
    }
    EU[s] = a / N
    EU2[s] = b / N
  }
  // random steps: uniform levels, a little smoothing
  EU[4] = 0.5
  EU2[4] = 0.32
  // bubbly: cosine glide between independent uniform levels
  let b = 0
  for (let i = 0; i < N; i++) {
    const w = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / N)
    b += (1 / 3) * ((1 - w) * (1 - w) + w * w) + 0.5 * w * (1 - w)
  }
  EU[5] = 0.5
  EU2[5] = b / N
})()

function compFor(s, d) {
  const e = (1 - d) * (1 - d) + 2 * (1 - d) * d * EU[s] + d * d * EU2[s]
  const g = e > 1e-6 ? 1 / Math.sqrt(e) : 4
  return g > 4 ? 4 : g
}

class AmCore {
  constructor(sr, rng) {
    this.sr = sr
    this.rng = rng || makeRng('synth.am')
    this.kS = 1 - Math.exp(-1 / (0.02 * sr))
    this.xfLen = Math.max(1, Math.round(0.01 * sr))
    this.ph = 0
    this.rate = 35
    this.rateT = 35
    this.depth = 0.85
    this.depthT = 0.85
    this.mix = 1
    this.mixT = 1
    this.jit = 0
    this.shape = 0
    this.oldShape = 0
    this.xf = 0
    this.rateMul = 1
    this.depthMul = 1
    this.ra = this.rng.next()
    this.rb = this.rng.next()
    this.step = this.ra
    this.comp = 1
    this.cnt = 0
  }

  set(p, instant) {
    let s = SHAPES.indexOf(p.shape)
    if (s < 0) s = 0
    let r = Number(p.rate)
    if (!(r > 0)) r = 35
    if (r > this.sr * 0.2) r = this.sr * 0.2
    this.rateT = r
    this.depthT = Math.min(1, Math.max(0, (Number(p.depth) || 0) / 100))
    let m = Number(p.mix)
    if (!(m >= 0)) m = 100
    this.mixT = Math.min(1, m / 100)
    this.jit = Math.min(1, Math.max(0, (Number(p.jitter) || 0) / 100))
    if (instant) {
      this.rate = this.rateT
      this.depth = this.depthT
      this.mix = this.mixT
      this.shape = s
      this.xf = 0
      this.comp = compFor(s, this.depth)
    } else if (s !== this.shape) {
      this.oldShape = this.shape
      this.shape = s
      this.xf = this.xfLen
    }
  }

  reset() {
    this.ph = 0
    this.rate = this.rateT
    this.depth = this.depthT
    this.mix = this.mixT
    this.xf = 0
    this.rateMul = 1
    this.depthMul = 1
    this.cnt = 0
  }

  _newCycle() {
    const rng = this.rng
    this.ra = this.rb
    this.rb = rng.next()
    const j = this.jit
    if (j > 0) {
      let g = rng.gauss()
      if (g > 2) g = 2
      if (g < -2) g = -2
      let m = 1 + j * 0.45 * g
      if (m < 0.35) m = 0.35
      this.rateMul = m
      this.depthMul = 1 - j * 0.6 * rng.next()
    } else {
      this.rateMul = 1
      this.depthMul = 1
    }
  }

  _u(s, ph) {
    if (s < 4) return uDet(s, ph)
    if (s === 4) return this.step
    return this.ra + (this.rb - this.ra) * (0.5 - 0.5 * Math.cos(Math.PI * ph))
  }

  run(in0, in1, out0, out1, n) {
    const kS = this.kS
    const sr = this.sr
    for (let i = 0; i < n; i++) {
      if ((this.cnt & 15) === 0) {
        this.comp = compFor(this.shape, this.depth)
      }
      this.cnt++
      this.rate += (this.rateT - this.rate) * kS
      this.depth += (this.depthT - this.depth) * kS
      this.mix += (this.mixT - this.mix) * kS
      const r = this.rate * this.rateMul
      this.ph += r / sr
      if (this.ph >= 1) {
        this.ph -= Math.floor(this.ph)
        this._newCycle()
      }
      // random steps: slewed toward the held level
      let slew = (TWO_PI * 12 * r) / sr
      if (slew > 1) slew = 1
      this.step += (this.ra - this.step) * slew
      let u = this._u(this.shape, this.ph)
      if (this.xf > 0) {
        const a = this.xf / this.xfLen
        u = u * (1 - a) + this._u(this.oldShape, this.ph) * a
        this.xf--
      }
      const d = this.depth * this.depthMul
      const g = (1 - d + d * u) * this.comp
      const m = this.mix
      let x = in0[i]
      if (!(x > -1e9 && x < 1e9)) x = 0
      if (in1 && out1) {
        let x1 = in1[i]
        if (!(x1 > -1e9 && x1 < 1e9)) x1 = 0
        out1[i] = x1 + m * (x1 * g - x1)
      }
      out0[i] = x + m * (x * g - x)
    }
  }
}

export default {
  id: 'synth.am',
  name: 'Fast flutter',
  family: 'synth',
  about: 'Pulses your volume tens or hundreds of times a second: a gargle, a voice through a fan, or the buzz of insect wings.',
  params: [
    { id: 'rate', name: 'Flutter speed', type: 'number', min: 1, max: 800, step: 0.5, def: 35, unit: 'hz', rand: [12, 260] },
    { id: 'depth', name: 'Depth', type: 'number', min: 0, max: 100, step: 1, def: 85, unit: 'percent', rand: [55, 100] },
    {
      id: 'shape',
      name: 'Shape',
      type: 'choice',
      def: 'sine',
      options: [
        { v: 'sine', name: 'Smooth' },
        { v: 'triangle', name: 'Triangle' },
        { v: 'square', name: 'Choppy square' },
        { v: 'pulse', name: 'Short bursts' },
        { v: 'random', name: 'Random steps' },
        { v: 'bubbly', name: 'Bubbly' },
      ],
    },
    { id: 'jitter', name: 'Unsteadiness', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 70] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [60, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 1,
  process(input, p, ctx) {
    const n = bufLen(input)
    if (!n) return input
    const sr = input.sr || (ctx && ctx.sr) || 48000
    const base = ctx && ctx.rng ? ctx.rng : makeRng('synth.am')
    const ch = input.ch
    for (let c = 0; c < ch.length; c += 2) {
      // one modulator for a stereo pair keeps the image steady
      const core = new AmCore(sr, base.fork('pair' + c))
      core.set(p, true)
      const b = c + 1 < ch.length ? ch[c + 1] : null
      core.run(ch[c], b, ch[c], b, n)
    }
    return input
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p, rng) {
      const core = new AmCore(sr, rng ? rng.fork('pair0') : makeRng('synth.am').fork('pair0'))
      core.set(p, true)
      return {
        process(ins, outs, n) {
          const in1 = ins.length > 1 ? ins[1] : null
          const out1 = outs.length > 1 ? outs[1] : null
          if (in1 && out1) core.run(ins[0], in1, outs[0], out1, n)
          else {
            core.run(ins[0], null, outs[0], null, n)
            if (out1) for (let i = 0; i < n; i++) out1[i] = outs[0][i]
          }
        },
        set(q) {
          core.set(q, false)
        },
        reset() {
          core.reset()
        },
      }
    },
  },
}
