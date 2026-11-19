// modules/lofi/blown.js - lofi.blown, "Blown speaker".
//
// Technique: the small-speaker model of _speakers.js (Thiele and Small's
// lumped driver: resonance high pass, break-up peaks, soft-clipped
// excursion) with the faults of a damaged driver added one by one, as they
// are described in loudspeaker repair and measurement practice (a rubbing
// voice coil, a torn cone or surround, a loose connection):
// - Rattle: a torn surround lets the cone flap. Excursion past a low
//   threshold is clipped hard on one side only (the torn side), and the
//   excess, roughened with noise, rings a papery band around 2 kHz.
// - Buzz: a rubbing voice coil scrapes on every loud syllable. The upper
//   part of the voice is hard clipped and gated by the voice's own envelope,
//   a fizz that rides on the words.
// - Crackle: a loose wire. Random cut-outs (a few milliseconds to a few
//   tenths of a second, deeper and more frequent when the voice is loud,
//   as the moving lead wire flexes) with a click at each break, scheduled as
//   an inhomogeneous Poisson process (the hazard accumulates sample by
//   sample and fires at an exponentially drawn level, which is exact for a
//   rate that changes over time).
// The torn cone also gets its own uneven response: a honky 650 Hz peak, a
// hole at 1.5 kHz and a lost top.

import { tanhFast } from '../../core/shape.js'
import { makeRng } from '../../core/rng.js'
import { LBiquad, FilterBank, LP, HP, BP, PEAK, HP1, smoothCoef, clamp, num, runStream } from './_lib.js'

const BODY = [[HP, 140, 0.9, 0], [PEAK, 650, 4, 6], [PEAK, 1500, 3, -8], [PEAK, 3100, 3, 4], [LP, 6500, 0.7, 0]]

class BlownChan {
  constructor(sr, rng) {
    this.sr = sr
    this.rng = rng
    this.body = new FilterBank(sr, 6).load(BODY)
    this.disp = new LBiquad(sr).set(LP, 250, 0.8, 0)
    this.rbp = new LBiquad(sr).set(BP, 2100, 1.2, 0)
    this.rhp = new LBiquad(sr).set(HP1, 700, 0, 0)
    this.bhp = new LBiquad(sr).set(HP, 1000, 0.7, 0)
    this.blp = new LBiquad(sr).set(LP, 6000, 0.7, 0)
    this.chp = new LBiquad(sr).set(HP1, 300, 0, 0)
    this.env = 0
    this.eA = 1 - Math.exp(-1 / (0.002 * sr))
    this.eR = 1 - Math.exp(-1 / (0.04 * sr))
    this.gain = 1
    this.gainT = 1
    this.gK = 1 - Math.exp(-1 / (0.0004 * sr))
    this.left = 0 // samples left in a cut-out
    this.haz = 0
    this.next = -Math.log(1 - rng.next())
    this.click = 0
  }

  reset() {
    this.body.reset()
    this.disp.reset()
    this.rbp.reset()
    this.rhp.reset()
    this.bhp.reset()
    this.blp.reset()
    this.chp.reset()
    this.env = 0
    this.gain = 1
    this.gainT = 1
    this.left = 0
    this.haz = 0
    this.click = 0
  }
}

class BlownKernel {
  constructor(sr, p, rng) {
    this.sr = sr
    const r = rng || makeRng('lofi.blown')
    this.chs = [new BlownChan(sr, r.fork('L')), new BlownChan(sr, r.fork('R'))]
    this.k = smoothCoef(20, sr)
    this.set(p || {}, true)
  }

  set(p, immediate = false) {
    this.rattleT = clamp(num(p && p.rattle, 50), 0, 100) / 100
    this.buzzT = clamp(num(p && p.buzz, 40), 0, 100) / 100
    this.crackle = clamp(num(p && p.crackle, 30), 0, 100) / 100
    this.mixT = clamp(num(p && p.mix, 100), 0, 100) / 100
    if (immediate || this.mix === undefined) {
      this.rattle = this.rattleT
      this.buzz = this.buzzT
      this.mix = this.mixT
    }
  }

  reset() {
    this.chs[0].reset()
    this.chs[1].reset()
    this.rattle = this.rattleT
    this.buzz = this.buzzT
    this.mix = this.mixT
  }

  _tick(ch, x, rattle, buzz, mix) {
    const sr = this.sr
    const ax = x < 0 ? -x : x
    ch.env += (ax - ch.env) * (ax > ch.env ? ch.eA : ch.eR)
    if (ch.env < 1e-25) ch.env = 0
    // torn surround: one-sided excursion clipping, fed back as growl
    const d = ch.disp.tick(x)
    const lim = 0.06 + 0.25 * (1 - rattle)
    const dc = d > lim ? lim + (d - lim) * 0.15 : d < -2.5 * lim ? -2.5 * lim + (d + 2.5 * lim) * 0.4 : d
    let v = x + (dc - d) * (0.6 + 1.4 * rattle)
    // flapping: the excess excursion rings a papery band
    const ex = (d > lim ? d - lim : 0) + (d < -lim ? d + lim : 0)
    let r = 0
    if (ex !== 0) r = ex * (0.5 + 0.5 * (ch.rng.next() * 2 - 1)) * 6 * rattle
    r = ch.rhp.tick(ch.rbp.tick(r))
    // rubbing voice coil: gated fizz
    let fz = 0
    if (buzz > 0) {
      const h = ch.bhp.tick(x) * 40
      const c = h > 1 ? 1 : h < -1 ? -1 : h
      fz = c * ch.env * buzz * 0.9
    }
    fz = ch.blp.tick(fz)
    v = ch.body.tick(v + r + fz)
    v = tanhFast(v * 1.6) / 1.6
    // loose wire
    const cr = this.crackle
    if (cr > 0) {
      if (ch.left > 0) {
        if (--ch.left === 0) {
          ch.gainT = 1
          ch.click += (ch.rng.next() < 0.5 ? -1 : 1) * cr * (0.2 + 0.4 * ch.rng.next())
        }
      } else {
        const rate = cr * cr * 7 * (0.25 + 4 * Math.min(1, ch.env * 3))
        ch.haz += rate / sr
        if (ch.haz >= ch.next) {
          ch.haz = 0
          ch.next = -Math.log(1 - ch.rng.next())
          const u = ch.rng.next()
          ch.left = Math.max(1, Math.round(sr * (0.002 + 0.18 * u * u * u)))
          ch.gainT = 0.03 + 0.5 * (1 - cr) * ch.rng.next()
          ch.click += (ch.rng.next() < 0.5 ? -1 : 1) * cr * (0.3 + 0.5 * ch.rng.next())
        }
      }
    } else if (ch.gainT !== 1) {
      ch.gainT = 1
      ch.left = 0
    }
    ch.gain += (ch.gainT - ch.gain) * ch.gK
    let ck = ch.click
    ch.click *= 0.6
    if (ch.click < 1e-6 && ch.click > -1e-6) ch.click = 0
    ck = ch.chp.tick(ck)
    const wet = v * ch.gain + ck
    return x * (1 - mix) + wet * mix
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
      this.rattle += (this.rattleT - this.rattle) * k
      this.buzz += (this.buzzT - this.buzz) * k
      this.mix += (this.mixT - this.mix) * k
      o0[i] = this._tick(c0, x0, this.rattle, this.buzz, this.mix)
      if (o1) o1[i] = this._tick(c1, x1, this.rattle, this.buzz, this.mix)
    }
    c0.body.heal()
    c1.body.heal()
  }
}

export default {
  id: 'lofi.blown',
  name: 'Blown speaker',
  family: 'lofi',
  about: 'A wrecked speaker: a torn cone that flaps and rattles, a voice coil that buzzes on loud words, and a loose wire that crackles and cuts out.',
  params: [
    { id: 'rattle', name: 'Rattle', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
    { id: 'buzz', name: 'Buzz', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 70] },
    { id: 'crackle', name: 'Crackle', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 60] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [80, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 1,
  process(input, p, ctx) {
    const k = new BlownKernel(input.sr, p, ctx && ctx.rng ? ctx.rng.fork('blown') : null)
    return runStream(k, input, 0, 0, ctx)
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p, rng) {
      return new BlownKernel(sr, p, rng ? rng.fork('blown') : null)
    },
  },
}
