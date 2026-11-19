// modules/lofi/drive.js - lofi.drive, "Distortion".
//
// Technique: static waveshaping between pre-emphasis and post filtering, the
// structure of guitar pedals and amp stages as analysed in D. T. Yeh,
// "Digital Implementation of Musical Distortion Circuits by Analysis and
// Simulation" (Stanford PhD thesis, 2009) and in J. Pakarinen and D. T. Yeh,
// "A review of digital techniques for modeling vacuum-tube guitar
// amplifiers" (Computer Music Journal, 2009): a tone stack shapes what gets
// clipped, the clipper bends it, filters after it tame the fizz. The shaper
// runs at twice the sample rate (a 63-tap halfband oversampler, _lib.js), so
// hard clipping and folding do not spray aliases back into the voice.
//
// Characters (each a pre filter, a curve and a post filter):
// - Warm tube: an asymmetric hyperbolic tangent around a bias point
//   (single-ended valve stage; even harmonics), very gentle filters.
// - Overdrive: a mid hump (about 900 Hz) into an algebraic soft clipper
//   x / sqrt(1 + x^2), the smooth symmetric diode clipping of overdrive pedals.
// - Amp crunch: two gain stages with a coupling high pass between them (the
//   cascaded preamp of a crunchy amplifier), a presence lift after.
// - Fuzz: a big gain into an asymmetric transistor-style clipper and then a
//   hard limit, so the voice turns square and woolly; a mid scoop after.
// - Dying battery fuzz: a fuzz whose transistor is starved: a dead zone means
//   quiet parts sputter and gate while loud parts rip.
// - Hard clip: a brick-wall clipper with a presence lift.
// - Wave folder: the triangle folder of west-coast synthesis (core/shape.js
//   fold), which turns loud parts into bright, metallic overtones.
// - Rectifier: mostly full-wave rectification, an octave-up ring-modulated
//   growl.
// The output level is matched to a quiet reference tone through the same
// curve, so turning up the drive changes the sound, not the loudness.

import { tanhFast, fold } from '../../core/shape.js'
import { LP, HP1, PEAK, LS, HS, FilterBank, LBiquad, Halfband2x, ShortDelay, HB_DELAY, smoothCoef, dbg, clamp, num, runStream } from './_lib.js'

const CHARS = {
  warm: { name: 'Warm tube', gain: 1, shape: 0, pre: [[HP1, 40, 0, 0], [PEAK, 1200, 0.7, 2]], post: [[LP, 12000, 0.6, 0]] },
  overdrive: { name: 'Overdrive', gain: 1, shape: 1, pre: [[HP1, 160, 0, 0], [PEAK, 900, 0.8, 6]], post: [[LP, 5500, 0.7, 0]] },
  crunch: { name: 'Amp crunch', gain: 1, shape: 2, pre: [[HP1, 90, 0, 0], [PEAK, 1600, 0.8, 4]], post: [[PEAK, 3000, 1, 2], [LP, 7000, 0.7, 0]] },
  fuzz: { name: 'Fuzz', gain: 4, shape: 3, pre: [[HP1, 100, 0, 0], [LP, 5000, 0.7, 0]], post: [[PEAK, 900, 0.7, -3], [LP, 4500, 0.5, 0]] },
  battery: { name: 'Dying battery fuzz', gain: 3, shape: 4, pre: [[HP1, 120, 0, 0]], post: [[LP, 3800, 0.8, 0]] },
  hard: { name: 'Hard clip', gain: 1, shape: 5, pre: [[HP1, 60, 0, 0], [PEAK, 2500, 0.8, 3]], post: [[LP, 9000, 0.7, 0]] },
  fold: { name: 'Wave folder', gain: 0.5, shape: 6, pre: [[HP1, 80, 0, 0], [LP, 4000, 0.7, 0]], post: [[LP, 10000, 0.7, 0]] },
  rectifier: { name: 'Rectifier', gain: 1, shape: 7, pre: [[HP1, 80, 0, 0]], post: [[HP1, 40, 0, 0], [LP, 8000, 0.7, 0]] },
}

const TUBE_B = 0.3
const TUBE_T = Math.tanh(TUBE_B)
const TUBE_S = 1 - TUBE_T * TUBE_T
const BAT_T = 0.2

/** The curves without memory (used for level matching, and by the shaper). */
function curve(id, x) {
  switch (id) {
    case 0:
      return (tanhFast(x + TUBE_B) - TUBE_T) / TUBE_S
    case 1:
      return x / Math.sqrt(1 + x * x)
    case 2: {
      const a = (tanhFast(1.5 * x + 0.2) - 0.1974) / 0.961
      return tanhFast(2.5 * a)
    }
    case 3: {
      const y = x > 0 ? tanhFast(x) : 1.6 * tanhFast(0.55 * x)
      const z = 1.15 * y
      return z > 1 ? 1 : z < -1 ? -1 : z
    }
    case 4: {
      const m = Math.abs(tanhFast(1.4 * x))
      const y = m > BAT_T ? (m - BAT_T) / (1 - BAT_T) : 0
      return x >= 0 ? y : -0.75 * y
    }
    case 5:
      return x > 1 ? 1 : x < -1 ? -1 : x
    case 6:
      return fold(x, 1)
    case 7: {
      const t = tanhFast(x)
      return 0.8 * (t < 0 ? -t : t) + 0.2 * t
    }
    default:
      return x
  }
}

/** Gain that brings a 0.25 sine through the curve back to its own level. */
function makeupFor(id, g) {
  let s = 0
  let s2 = 0
  const N = 64
  for (let i = 0; i < N; i++) {
    const y = curve(id, 0.25 * g * Math.sin((2 * Math.PI * (i + 0.5)) / N))
    s += y
    s2 += y * y
  }
  const mean = s / N
  const ac = Math.sqrt(Math.max(0, s2 / N - mean * mean))
  const want = 0.25 / Math.SQRT2
  return ac > 1e-9 ? clamp(want / ac, 0.03, 4) : 4
}

class DriveChan {
  constructor(sr) {
    this.sr = sr
    this.pre = new FilterBank(sr, 3)
    this.post = new FilterBank(sr, 3)
    this.dc = new LBiquad(sr).set(HP1, 15, 0, 0)
    this.ls = new LBiquad(sr)
    this.hs = new LBiquad(sr)
    this.hb = new Halfband2x()
    this.dry = new ShortDelay(HB_DELAY)
    this.hpS = 0 // crunch coupling high pass state (at 2x)
    this.hpC = 1 - Math.exp((-2 * Math.PI * 150) / (2 * sr))
  }

  load(c) {
    this.pre.load(c.pre)
    this.post.load(c.post)
  }

  tone(t) {
    this.ls.set(LS, 400, 0.7, -0.06 * t)
    this.hs.set(HS, 2500, 0.7, 0.08 * t)
  }

  reset() {
    this.pre.reset()
    this.post.reset()
    this.dc.reset()
    this.ls.reset()
    this.hs.reset()
    this.hb.reset()
    this.dry.reset()
    this.hpS = 0
  }

  shape(id, x) {
    if (id === 2) {
      // two stages with a coupling capacitor between them
      const a = (tanhFast(1.5 * x + 0.2) - 0.1974) / 0.961
      this.hpS += (a - this.hpS) * this.hpC
      if (this.hpS < 1e-25 && this.hpS > -1e-25) this.hpS = 0
      return tanhFast(2.5 * (a - this.hpS))
    }
    return curve(id, x)
  }
}

class DriveKernel {
  constructor(sr, p) {
    this.sr = sr
    this.chs = [new DriveChan(sr), new DriveChan(sr)]
    this.k = smoothCoef(20, sr)
    this.kFade = 1 / Math.max(1, Math.round(0.006 * sr))
    this.char = null
    this.pending = null
    this.fade = 1
    this.fadeDir = 0
    this.toneNow = 0
    this.toneT = 0
    this.toneDone = 1e9
    this.count = 0
    this.set(p || {}, true)
  }

  _apply(key) {
    const c = CHARS[key] || CHARS.crunch
    this.char = key in CHARS ? key : 'crunch'
    this.c = c
    this.shapeId = c.shape
    this.chs[0].load(c)
    this.chs[1].load(c)
    this._gainTargets()
  }

  _gainTargets() {
    const g = dbg(this.driveDb) * this.c.gain
    this.gT = g
    this.mkT = makeupFor(this.shapeId, g)
  }

  set(p, immediate = false) {
    const key = p && p.character in CHARS ? p.character : this.char || 'crunch'
    this.driveDb = clamp(num(p && p.drive, 18), 0, 60)
    this.toneT = clamp(num(p && p.tone, 0), -100, 100)
    this.mixT = clamp(num(p && p.mix, 100), 0, 100) / 100
    if (immediate || this.char === null) {
      this._apply(key)
      this.g = this.gT
      this.mk = this.mkT
      this.mix = this.mixT
      this.toneNow = this.toneT
      this.chs[0].tone(this.toneNow)
      this.chs[1].tone(this.toneNow)
      this.toneDone = this.toneNow
      this.fade = 1
      this.fadeDir = 0
      this.pending = null
    } else {
      if (key !== this.char) {
        this.pending = key
        this.fadeDir = -1
      }
      this._gainTargets()
    }
  }

  reset() {
    this.chs[0].reset()
    this.chs[1].reset()
    if (this.pending) this._apply(this.pending)
    this.pending = null
    this.fade = 1
    this.fadeDir = 0
    this.g = this.gT
    this.mk = this.mkT
    this.mix = this.mixT
  }

  _tick(ch, x, g, mk, mix, fade) {
    const dry = ch.dry.tick(x)
    const u = ch.pre.tick(x) * g
    ch.hb.up(u)
    const id = this.shapeId
    const se = ch.shape(id, ch.hb.e)
    const so = ch.shape(id, ch.hb.o)
    let y = ch.hb.down(se, so)
    y = ch.post.tick(y)
    y = ch.dc.tick(y)
    y = ch.hs.tick(ch.ls.tick(y))
    return dry * (1 - mix) + y * mk * mix * fade
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
      this.toneNow += (this.toneT - this.toneNow) * k
      if (++this.count >= 32) {
        this.count = 0
        if (Math.abs(this.toneNow - this.toneDone) > 0.25) {
          c0.tone(this.toneNow)
          c1.tone(this.toneNow)
          this.toneDone = this.toneNow
        }
      }
      if (this.fadeDir !== 0) {
        this.fade += this.fadeDir * this.kFade
        if (this.fade <= 0) {
          this.fade = 0
          if (this.pending) {
            this._apply(this.pending)
            this.g = this.gT
            this.mk = this.mkT
          }
          this.pending = null
          this.fadeDir = 1
        } else if (this.fade >= 1) {
          this.fade = 1
          this.fadeDir = 0
        }
      }
      o0[i] = this._tick(c0, x0, this.g, this.mk, this.mix, this.fade)
      if (o1) o1[i] = this._tick(c1, x1, this.g, this.mk, this.mix, this.fade)
    }
    c0.pre.heal()
    c0.post.heal()
    c1.pre.heal()
    c1.post.heal()
  }
}

export default {
  id: 'lofi.drive',
  name: 'Distortion',
  family: 'lofi',
  about: 'Distorts your voice like a pedal or an amp: warm tube, overdrive, crunch, fuzz, a dying battery, hard clipping, a folder or a rectifier.',
  params: [
    { id: 'drive', name: 'Drive', type: 'number', min: 0, max: 48, step: 0.5, def: 18, unit: 'db', rand: [6, 30] },
    {
      id: 'character', name: 'Character', type: 'choice', def: 'crunch',
      options: Object.keys(CHARS).map((v) => ({ v, name: CHARS[v].name })),
    },
    { id: 'tone', name: 'Tone', type: 'number', min: -100, max: 100, step: 1, def: 0, unit: 'percent', words: { neg: 'darker', pos: 'brighter', zero: 'neutral' }, rand: [-40, 40] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [60, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 2,
  process(input, p, ctx) {
    const k = new DriveKernel(input.sr, p)
    return runStream(k, input, HB_DELAY, 0, ctx)
  },
  live: {
    latency() {
      return HB_DELAY
    },
    create(sr, p) {
      return new DriveKernel(sr, p)
    },
  },
}
