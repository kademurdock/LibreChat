// modules/synth/fm.js - frequency wobble by delay modulation (synth.fm).
//
// Technique: a modulated delay line used as a pitch modulator, the
// "vibrato" structure of Dattorro, "Effect Design, Part 2: Delay-Line
// Modulation and Chorus" (JAES 45(10), 1997) and Zolzer (ed.), DAFX, 2nd
// edition 2011, chapter 3 ("Vibrato"). Reading the voice at a delay that
// swings by +-H seconds at r Hz multiplies its pitch by 1 - H m'(t): slow
// rates give a vibrato or a seasick tape warble, rates of tens of hertz a
// watery alien gargle, and audio rates (100 Hz and up) real FM sidebands, a
// gritty buzzing voice. Fractional reads use 4-point cubic Hermite
// interpolation (Niemitalo, "Polynomial Interpolators for High-Quality
// Resampling of Oversampled Audio", 2001).
//
// Musical limit: the swing is capped so the pitch ratio never drops below
// 0.1 (the read point never stops or runs backwards), whatever the depth and
// speed. Past that point delay modulation stops sounding like a voice and
// starts sounding like broken digital audio.
//
// Shapes: smooth (sine), triangle (a two-pitch yodel), wandering (smooth
// random glides, a drunk or failing tape), watery (two sines a golden ratio
// apart, an underwater shimmer that never quite repeats). Randomness slowly
// varies the speed and depth.
//
// Offline the delay is centred: the read point swings around the present
// sample (the whole take is in memory), so the wobbling voice stays exactly
// in time with the dry one. Live mode must be causal, so it reads from a
// core/delay.js DelayLine at a fixed mean delay (7.5 ms plus 2 samples, room
// for the widest swing) plus the swing, reads the dry path at that same mean
// delay, and reports it as its latency; the modulator is the same code in both.

import { bufLen } from '../../core/buf.js'
import { makeRng } from '../../core/rng.js'
import { DelayLine } from '../../core/delay.js'

const TWO_PI = 2 * Math.PI
const SHAPES = ['sine', 'triangle', 'wander', 'watery']
// max |m'(t)| per unit rate, used for the musical cap
const SLOPE = [TWO_PI, 4, Math.PI, TWO_PI * (0.6 + 0.4 * 1.618)]
const GOLD = 1.6180339887

/** Modulator m(t) in -1..1 plus the swing H in samples. */
class Wobbler {
  constructor(sr, rng) {
    this.sr = sr
    this.rng = rng || makeRng('synth.fm')
    this.kS = 1 - Math.exp(-1 / (0.03 * sr))
    this.ph = 0
    this.ph2 = this.rng.next()
    this.wa = this.rng.next() * 2 - 1
    this.wb = this.rng.next() * 2 - 1
    // slow random for "randomness"
    this.nph = 0
    this.na = this.rng.next() * 2 - 1
    this.nb = this.rng.next() * 2 - 1
    this.n2a = this.rng.next() * 2 - 1
    this.n2b = this.rng.next() * 2 - 1
    this.rate = 8
    this.rateT = 8
    this.H = 0
    this.HT = 0
    this.rnd = 0
    this.shape = 0
    this.mix = 1
    this.mixT = 1
  }

  set(p, instant) {
    let s = SHAPES.indexOf(p.shape)
    if (s < 0) s = 0
    this.shape = s
    let r = Number(p.rate)
    if (!(r > 0)) r = 8
    if (r > this.sr * 0.1) r = this.sr * 0.1
    this.rnd = Math.min(1, Math.max(0, (Number(p.randomness) || 0) / 100))
    let H = (Math.max(0, Number(p.depth) || 0) / 1000 / 2) * this.sr
    // cap: H * slope * rate * (1 + 0.5 rnd) / sr <= 0.9
    const cap = (0.9 * this.sr) / (SLOPE[s] * r * (1 + 0.5 * this.rnd))
    if (H > cap) H = cap
    this.rateT = r
    this.HT = H
    let m = Number(p.mix)
    if (!(m >= 0)) m = 100
    this.mixT = Math.min(1, m / 100)
    if (instant) {
      this.rate = r
      this.H = H
      this.mix = this.mixT
    }
  }

  reset() {
    this.ph = 0
    this.rate = this.rateT
    this.H = this.HT
    this.mix = this.mixT
  }

  /** Advance one sample; returns the delay offset in samples (-H..H). */
  next() {
    const kS = this.kS
    this.rate += (this.rateT - this.rate) * kS
    this.H += (this.HT - this.H) * kS
    this.mix += (this.mixT - this.mix) * kS
    const sr = this.sr
    let r = this.rate
    let depthMul = 1
    if (this.rnd > 0) {
      // slow cosine-glide noise at 0.7 Hz
      this.nph += 0.7 / sr
      if (this.nph >= 1) {
        this.nph -= 1
        this.na = this.nb
        this.nb = this.rng.next() * 2 - 1
        this.n2a = this.n2b
        this.n2b = this.rng.next() * 2 - 1
      }
      const w = 0.5 - 0.5 * Math.cos(Math.PI * this.nph)
      r *= 1 + 0.5 * this.rnd * (this.na + (this.nb - this.na) * w)
      depthMul = 1 - 0.4 * this.rnd * (0.5 + 0.5 * (this.n2a + (this.n2b - this.n2a) * w))
    }
    this.ph += r / sr
    if (this.ph >= 1) {
      this.ph -= Math.floor(this.ph)
      this.wa = this.wb
      this.wb = this.rng.next() * 2 - 1
    }
    let m
    switch (this.shape) {
      case 1:
        m = this.ph < 0.25 ? 4 * this.ph : this.ph < 0.75 ? 2 - 4 * this.ph : 4 * this.ph - 4
        break
      case 2:
        m = this.wa + (this.wb - this.wa) * (0.5 - 0.5 * Math.cos(Math.PI * this.ph))
        break
      case 3:
        this.ph2 += (r * GOLD) / sr
        if (this.ph2 >= 1) this.ph2 -= Math.floor(this.ph2)
        m = 0.6 * Math.sin(TWO_PI * this.ph) + 0.4 * Math.sin(TWO_PI * this.ph2)
        break
      default:
        m = Math.sin(TWO_PI * this.ph)
    }
    return this.H * depthMul * m
  }
}

/** Cubic Hermite read of sig at fractional index t (zero outside). */
function readAt(sig, n, t) {
  const i = Math.floor(t)
  const f = t - i
  const ym1 = i - 1 >= 0 && i - 1 < n ? sig[i - 1] : 0
  const y0 = i >= 0 && i < n ? sig[i] : 0
  const y1 = i + 1 >= 0 && i + 1 < n ? sig[i + 1] : 0
  const y2 = i + 2 >= 0 && i + 2 < n ? sig[i + 2] : 0
  const c1 = 0.5 * (y1 - ym1)
  const c2 = ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2
  const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1)
  return ((c3 * f + c2) * f + c1) * f + y0
}

function clean(sig) {
  const n = sig.length
  let bad = false
  for (let i = 0; i < n; i++) {
    const v = sig[i]
    if (!(v > -1e9 && v < 1e9)) {
      bad = true
      break
    }
  }
  if (!bad) return sig
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = sig[i]
    out[i] = v > -1e9 && v < 1e9 ? v : 0
  }
  return out
}

export default {
  id: 'synth.fm',
  name: 'Frequency wobble',
  family: 'synth',
  about: 'Wobbles the pitch of your voice fast or slow: a seasick warble, a watery alien, or a buzzing voice at high speeds.',
  params: [
    { id: 'rate', name: 'Wobble speed', type: 'number', min: 0.1, max: 300, step: 0.1, def: 8, unit: 'hz', rand: [3, 40] },
    { id: 'depth', name: 'Wobble depth', type: 'number', min: 0, max: 15, step: 0.05, def: 2.5, unit: 'ms', rand: [0.6, 5] },
    {
      id: 'shape',
      name: 'Shape',
      type: 'choice',
      def: 'sine',
      options: [
        { v: 'sine', name: 'Smooth' },
        { v: 'triangle', name: 'Triangle' },
        { v: 'wander', name: 'Wandering' },
        { v: 'watery', name: 'Watery' },
      ],
    },
    { id: 'randomness', name: 'Randomness', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 60] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [50, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 1,
  process(input, p, ctx) {
    const n = bufLen(input)
    if (!n) return input
    const sr = input.sr || (ctx && ctx.sr) || 48000
    const base = ctx && ctx.rng ? ctx.rng : makeRng('synth.fm')
    const nch = input.ch.length
    // one modulator for all channels, so the stereo image does not swim
    const wob = new Wobbler(sr, base.fork('wobble'))
    wob.set(p, true)
    const offs = new Float32Array(n)
    for (let i = 0; i < n; i++) offs[i] = wob.next()
    const mix = wob.mixT
    const out = new Array(nch)
    for (let c = 0; c < nch; c++) {
      const x = clean(input.ch[c])
      const y = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const w = readAt(x, n, i - offs[i])
        y[i] = x[i] + mix * (w - x[i])
      }
      out[c] = y
    }
    return { sr, ch: out }
  },
  live: {
    // A fixed mean delay that fits the largest swing the controls allow
    // (15 ms of depth is +-7.5 ms), so moving the depth never moves the
    // timing: 7.5 ms plus 2 samples at every setting.
    latency(p, sr) {
      return 2 + Math.ceil(0.0075 * (sr || 48000))
    },
    create(sr, p, rng) {
      const wob = new Wobbler(sr, rng ? rng.fork('wobble') : makeRng('synth.fm').fork('wobble'))
      wob.set(p, true)
      const mean = 2 + Math.ceil(0.0075 * sr)
      const maxD = 2 * mean + 8
      const d0 = new DelayLine(maxD)
      const d1 = new DelayLine(maxD)
      // the dry path is read at the same mean delay so mix blends in time
      return {
        process(ins, outs, n) {
          const in0 = ins[0]
          const in1 = ins.length > 1 ? ins[1] : null
          const out0 = outs[0]
          const out1 = outs.length > 1 ? outs[1] : null
          for (let i = 0; i < n; i++) {
            const off = wob.next()
            const m = wob.mix
            let x = in0[i]
            if (!(x > -1e9 && x < 1e9)) x = 0
            let x1 = 0
            if (in1) {
              x1 = in1[i]
              if (!(x1 > -1e9 && x1 < 1e9)) x1 = 0
            }
            d0.write(x)
            const dry0 = d0.read(mean)
            out0[i] = dry0 + m * (d0.read(mean + off) - dry0)
            if (in1 && out1) {
              d1.write(x1)
              const dry1 = d1.read(mean)
              out1[i] = dry1 + m * (d1.read(mean + off) - dry1)
            } else if (out1) out1[i] = out0[i]
          }
        },
        set(q) {
          wob.set(q, false)
        },
        reset() {
          wob.reset()
          d0.clear()
          d1.clear()
        },
      }
    },
  },
}
