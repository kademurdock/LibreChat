// modules/lofi/saturate.js - lofi.saturate, "Tape saturation".
//
// Technique: the record-and-play path of an analogue tape machine as it is
// explained in J. G. McKnight's tape-recording papers (for example "Tape
// reproducer response measurements with a reproducer test tape", JAES 1967,
// and the NAB/IEC equalisation standards) and modelled in J. Chowdhury,
// "Real-time physical modelling for analog tape machines" (DAFx 2019):
// 1. Record pre-emphasis lifts the highs (a high shelf) before the tape.
// 2. The tape saturates softly (a hyperbolic tangent, at twice the sample
//    rate through the halfband oversampler), so the lifted highs saturate
//    first: tape's high-frequency compression.
// 3. Playback de-emphasis takes the lift back out, leaving the highs gently
//    squashed and rounded.
// 4. The playback head's "head bump": a low-frequency peak with a smaller
//    dip above it, whose frequency rises with tape speed (about 48 Hz at
//    7.5 inches per second, 85 Hz at 15, 150 Hz at 30).
// 5. Gap and spacing loss: a gentle top-end roll-off that also depends on
//    speed.
// Bias: an under-biased tape distorts sooner and crosses over less cleanly
// near zero (a small dead zone, the grit of a mis-aligned machine) and stays
// bright; an over-biased tape is cleaner but darker (a high shelf down).
// The same kernel runs offline and live.

import { tanhFast } from '../../core/shape.js'
import { LP, HP1, PEAK, HS, FilterBank, LBiquad, Halfband2x, ShortDelay, HB_DELAY, smoothCoef, dbg, clamp, num, runStream } from './_lib.js'

const SPEEDS = {
  '7.5': { name: 'Slow, 7.5 inches a second', emph: 2000, emphDb: 8, bump: 48, gap: 11000 },
  '15': { name: 'Studio, 15 inches a second', emph: 3000, emphDb: 6, bump: 85, gap: 17000 },
  '30': { name: 'Fast, 30 inches a second', emph: 4500, emphDb: 4, bump: 150, gap: 21000 },
}

class TapeChan {
  constructor(sr) {
    this.sr = sr
    this.pre = new LBiquad(sr)
    this.de = new LBiquad(sr)
    this.post = new FilterBank(sr, 5)
    this.dc = new LBiquad(sr).set(HP1, 12, 0, 0)
    this.hb = new Halfband2x()
    this.dry = new ShortDelay(HB_DELAY)
    this.rows = [[PEAK, 85, 1.0, 3], [PEAK, 180, 1.4, -1], [LP, 17000, 0.6, 0], [HS, 5000, 0.7, 0]]
  }

  tune(sp, bumpDb, overBias) {
    this.pre.set(HS, sp.emph, 0.6, sp.emphDb)
    this.de.set(HS, sp.emph, 0.6, -sp.emphDb)
    const r = this.rows
    r[0][1] = sp.bump
    r[0][3] = bumpDb
    r[1][1] = sp.bump * 2.1
    r[1][3] = -bumpDb / 3
    r[2][1] = sp.gap
    r[3][3] = -7 * overBias
    this.post.load(r)
  }

  reset() {
    this.pre.reset()
    this.de.reset()
    this.post.reset()
    this.dc.reset()
    this.hb.reset()
    this.dry.reset()
  }
}

class TapeKernel {
  constructor(sr, p) {
    this.sr = sr
    this.chs = [new TapeChan(sr), new TapeChan(sr)]
    this.k = smoothCoef(20, sr)
    this.tSpeed = null
    this.tBump = NaN
    this.tOver = NaN
    this.set(p || {}, true)
  }

  set(p, immediate = false) {
    const sp = p && p.speed in SPEEDS ? p.speed : '15'
    const drive = clamp(num(p && p.drive, 6), 0, 30)
    const bias = clamp(num(p && p.bias, 0), -100, 100) / 100
    const bump = clamp(num(p && p.bump, 3), 0, 12)
    this.under = bias < 0 ? -bias : 0
    this.over = bias > 0 ? bias : 0
    this.asym = 0.08 * (1 + 2 * this.under)
    this.asymT = Math.tanh(this.asym)
    this.asymS = 1 - this.asymT * this.asymT
    const g = dbg(drive) * (1 + 0.8 * this.under) * (1 - 0.3 * this.over) * 0.5
    this.gT = g
    // level match: a quiet tone comes out at its own level
    const ref = 0.25
    this.mkT = ref / Math.max(1e-6, (tanhFast(g * ref + this.asym) - this.asymT) / this.asymS)
    this.mixT = clamp(num(p && p.mix, 100), 0, 100) / 100
    if (sp !== this.tSpeed || bump !== this.tBump || this.over !== this.tOver) {
      this.tSpeed = sp
      this.tBump = bump
      this.tOver = this.over
      const s = SPEEDS[sp]
      this.chs[0].tune(s, bump, this.over)
      this.chs[1].tune(s, bump, this.over)
    }
    if (immediate || this.g === undefined) {
      this.g = this.gT
      this.mk = this.mkT
      this.mix = this.mixT
    }
  }

  reset() {
    this.chs[0].reset()
    this.chs[1].reset()
    this.g = this.gT
    this.mk = this.mkT
    this.mix = this.mixT
  }

  shape(x) {
    const u = this.under
    let s = x
    if (u > 0) s -= 0.04 * u * tanhFast(40 * s)
    // a small bias point makes the curve slightly lopsided: the even harmonics of tape
    const b = this.asym
    return (tanhFast(s + b) - this.asymT) / this.asymS
  }

  _tick(ch, x, g, mk, mix) {
    const dry = ch.dry.tick(x)
    const u = ch.pre.tick(x) * g
    ch.hb.up(u)
    const y0 = ch.hb.down(this.shape(ch.hb.e), this.shape(ch.hb.o))
    let y = ch.de.tick(y0)
    y = ch.post.tick(y)
    y = ch.dc.tick(y) * mk
    return dry * (1 - mix) + y * mix
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
      this.g += (this.gT - this.g) * k
      this.mk += (this.mkT - this.mk) * k
      this.mix += (this.mixT - this.mix) * k
      o0[i] = this._tick(c0, x0, this.g, this.mk, this.mix)
      if (o1) o1[i] = this._tick(c1, x1, this.g, this.mk, this.mix)
    }
    c0.post.heal()
    c1.post.heal()
  }
}

export default {
  id: 'lofi.saturate',
  name: 'Tape saturation',
  family: 'lofi',
  about: 'Warms and thickens your voice like recording it hot onto analogue tape, with the soft squash, the rounded highs and the low head bump.',
  params: [
    { id: 'drive', name: 'Drive', type: 'number', min: 0, max: 24, step: 0.5, def: 9, unit: 'db', rand: [3, 15] },
    { id: 'bias', name: 'Bias', type: 'number', min: -100, max: 100, step: 1, def: 0, unit: 'percent', words: { neg: 'under-biased', pos: 'over-biased', zero: 'aligned' }, rand: [-40, 40] },
    { id: 'bump', name: 'Head bump', type: 'number', min: 0, max: 9, step: 0.5, def: 3, unit: 'db', rand: [1, 6] },
    {
      id: 'speed', name: 'Tape speed', type: 'choice', def: '15',
      options: Object.keys(SPEEDS).map((v) => ({ v, name: SPEEDS[v].name })),
    },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [70, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 2,
  process(input, p, ctx) {
    const k = new TapeKernel(input.sr, p)
    return runStream(k, input, HB_DELAY, 0, ctx)
  },
  live: {
    latency() {
      return HB_DELAY
    },
    create(sr, p) {
      return new TapeKernel(sr, p)
    },
  },
}
