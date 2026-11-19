// modules/lofi/crush.js - lofi.crush, "Bit crusher".
//
// Technique: the two halves of a cheap analogue-to-digital converter, done
// on purpose. Sample-rate reduction is a sample-and-hold driven by a phase
// accumulator (a new value is taken each time the phase passes one, the
// value is held until the next), which folds everything above half the new
// rate back down as inharmonic aliases: the classic crusher ring. Bit
// reduction is a uniform mid-tread quantiser (core/shape.js crush, step
// 2^(1 - bits)), which removes quiet detail and turns it into grainy noise.
// Optional smoothing puts an eighth-order Butterworth low pass (four RBJ
// cookbook sections with the Butterworth pole Q values 0.510, 0.601, 0.900
// and 2.563) before the sampler and the same after it, the textbook
// anti-alias and reconstruction filters, for a clean "low sample rate"
// sound instead of a gritty one. Jitter randomly stretches and shrinks
// each sample period, like a sampler with an unstable clock. The kernel is
// the same offline and live.

import { crush } from '../../core/shape.js'
import { makeRng } from '../../core/rng.js'
import { LP, FilterBank, smoothCoef, clamp, num, runStream } from './_lib.js'

const BUTTER8 = [0.5098, 0.6013, 0.9, 2.5629]

class CrushChan {
  constructor(sr, rng) {
    this.sr = sr
    this.rng = rng
    this.aa = new FilterBank(sr, 4)
    this.rc = new FilterBank(sr, 4)
    this.rows = [[LP, 1000, BUTTER8[0], 0], [LP, 1000, BUTTER8[1], 0], [LP, 1000, BUTTER8[2], 0], [LP, 1000, BUTTER8[3], 0]]
    this.ph = 1 // take a sample at once
    this.held = 0
    this.jf = 1
  }

  tune(fc) {
    for (let i = 0; i < 4; i++) this.rows[i][1] = fc
    this.aa.load(this.rows)
    this.rc.load(this.rows)
  }

  reset() {
    this.aa.reset()
    this.rc.reset()
    this.ph = 1
    this.held = 0
    this.jf = 1
  }
}

class CrushKernel {
  constructor(sr, p, rng) {
    this.sr = sr
    const r = rng || makeRng('lofi.crush')
    this.chs = [new CrushChan(sr, r.fork('L')), new CrushChan(sr, r.fork('R'))]
    this.k = smoothCoef(15, sr)
    this.rate = -1
    this.set(p || {}, true)
  }

  set(p, immediate = false) {
    this.bits = clamp(num(p && p.bits, 6), 1, 16)
    const rate = clamp(num(p && p.rate, 8000), 50, 192000)
    this.smooth = !!(p && p.smooth)
    this.jit = clamp(num(p && p.jitter, 0), 0, 100) / 100
    this.mixT = clamp(num(p && p.mix, 100), 0, 100) / 100
    if (rate !== this.rate) {
      this.rate = rate
      this.inc = rate / this.sr
      const fc = Math.min(0.45 * rate, 0.45 * this.sr)
      this.chs[0].tune(fc)
      this.chs[1].tune(fc)
    }
    if (immediate || this.mix === undefined) this.mix = this.mixT
  }

  reset() {
    this.chs[0].reset()
    this.chs[1].reset()
    this.mix = this.mixT
  }

  _tick(ch, x, mix) {
    const a = this.smooth ? ch.aa.tick(x) : x
    ch.ph += this.inc * ch.jf
    if (ch.ph >= 1) {
      ch.ph -= Math.floor(ch.ph)
      ch.held = crush(a, this.bits)
      ch.jf = this.jit > 0 ? 1 + this.jit * 0.6 * (ch.rng.next() * 2 - 1) : 1
    }
    const y = this.smooth ? ch.rc.tick(ch.held) : ch.held
    return x * (1 - mix) + y * mix
  }

  process(ins, outs, n) {
    const a0 = ins[0]
    const a1 = ins.length > 1 ? ins[1] : ins[0]
    const o0 = outs[0]
    const o1 = outs.length > 1 ? outs[1] : null
    const c0 = this.chs[0]
    const c1 = this.chs[1]
    const k = this.k
    for (let i = 0; i < n; i++) {
      const v0 = a0[i]
      const v1 = a1[i]
      // a host may hand over a stray NaN or Infinity: treat it as silence
      const x0 = v0 > -1e30 && v0 < 1e30 ? v0 : 0
      const x1 = v1 > -1e30 && v1 < 1e30 ? v1 : 0
      this.mix += (this.mixT - this.mix) * k
      o0[i] = this._tick(c0, x0, this.mix)
      if (o1) o1[i] = this._tick(c1, x1, this.mix)
    }
    c0.aa.heal()
    c0.rc.heal()
    c1.aa.heal()
    c1.rc.heal()
  }
}

export default {
  id: 'lofi.crush',
  name: 'Bit crusher',
  family: 'lofi',
  about: 'Fewer bits and a lower sample rate: from a slightly grainy voice down to a buzzing, ringing digital wreck.',
  params: [
    { id: 'bits', name: 'Bits', type: 'number', min: 1, max: 16, step: 1, def: 6, unit: 'bits', rand: [3, 10] },
    { id: 'rate', name: 'Sample rate', type: 'number', min: 500, max: 48000, step: 50, def: 8000, unit: 'hz', rand: [2000, 16000] },
    { id: 'smooth', name: 'Smoothing filters', type: 'bool', def: false },
    { id: 'jitter', name: 'Clock jitter', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 40] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [70, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 1,
  process(input, p, ctx) {
    const k = new CrushKernel(input.sr, p, ctx && ctx.rng ? ctx.rng.fork('crush') : null)
    return runStream(k, input, 0, 0, ctx)
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p, rng) {
      return new CrushKernel(sr, p, rng ? rng.fork('crush') : null)
    },
  },
}
