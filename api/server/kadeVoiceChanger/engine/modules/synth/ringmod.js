// modules/synth/ringmod.js - ring modulator (synth.ringmod).
//
// Technique: ring modulation, the plain product of the voice and a carrier
// (the four-diode ring modulator of the analogue studios; described as
// "ring modulation" in Udo Zolzer (ed.), DAFX: Digital Audio Effects, 2nd
// edition 2011, chapter 2, "Modulators and demodulators"). Multiplying by a
// sine at f turns every partial at p into a pair at p - f and p + f and
// removes the original, so a voice's harmonic series turns inharmonic: at
// 20 to 40 Hz it is the classic tin-voiced space invader, at a few hundred
// hertz a clanging bell-like robot. Square, triangle and sawtooth carriers
// add more sideband pairs. Their corners are band limited with polyBLEP
// (Valimaki and Huovilainen, "Antialiasing oscillators in subtractive
// synthesis", IEEE Signal Processing Magazine 24(2), 2007), so a fast
// carrier does not add aliasing whistles of its own.
//
// Loudness: each carrier is scaled by the inverse of its own RMS (sine
// root 2, triangle and sawtooth root 3, square 1), so the ringing voice comes
// out about as loud as the dry one and flicking shapes does not jump in level.
//
// Wobble swings the carrier pitch with a slow sine, in semitones either way,
// which turns the steady invader tone into a seasick, sci-fi wobble.
//
// The other sound (CONTRACT side input): the carrier becomes that recording,
// level-normalised by its RMS and gently limited, so the voice is ring
// modulated by an engine, a song or a storm. Without one the module falls
// back to the sine carrier and says so through ctx.note.
//
// A 15 Hz DC blocker sits on the input: any offset in a recording would
// otherwise come out as a loud carrier tone. Carrier and mix are smoothed
// in live mode, and a change of shape crossfades over 20 ms, so dragging a
// control never clicks. Offline and live run the same core, so they match
// sample for sample when the settings are the same.

import { bufLen } from '../../core/buf.js'

const TWO_PI = 2 * Math.PI
const SHAPES = ['sine', 'square', 'triangle', 'saw', 'side']
const SHAPE_GAIN = [Math.SQRT2, 1, Math.sqrt(3), Math.sqrt(3), 1]

function polyBlep(t, dt) {
  if (t < dt) {
    const u = t / dt
    return u + u - u * u - 1
  }
  if (t > 1 - dt) {
    const u = (t - 1) / dt
    return u * u + u + u + 1
  }
  return 0
}

function wave(shape, ph, dt) {
  switch (shape) {
    case 0:
      return Math.sin(TWO_PI * ph)
    case 1: {
      let v = ph < 0.5 ? 1 : -1
      v += polyBlep(ph, dt)
      let p2 = ph + 0.5
      if (p2 >= 1) p2 -= 1
      v -= polyBlep(p2, dt)
      return v
    }
    case 2:
      return 4 * Math.abs(ph - 0.5) - 1
    case 3:
      return 2 * ph - 1 - polyBlep(ph, dt)
  }
  return 0
}

/** Shared carrier and mixing core for offline and live use. */
class RingCore {
  constructor(sr) {
    this.sr = sr
    this.R = Math.exp((-TWO_PI * 15) / sr)
    this.dcX = new Float64Array(2)
    this.dcY = new Float64Array(2)
    this.k16 = 1 - Math.exp(-16 / (0.03 * sr))
    this.kS = 1 - Math.exp(-1 / (0.02 * sr))
    this.xfLen = Math.max(1, Math.round(0.02 * sr))
    this.ph = 0
    this.wph = 0
    this.f = 30
    this.fT = 30
    this.wr = 0
    this.wd = 0
    this.mix = 1
    this.mixT = 1
    this.shape = 0
    this.oldShape = 0
    this.xf = 0
    this.dt = 30 / sr
    this.cnt = 0
  }

  set(p, shapeName, instant) {
    let s = SHAPES.indexOf(shapeName)
    if (s < 0) s = 0
    let f = Number(p.freq)
    if (!(f > 0)) f = 30
    if (f > this.sr * 0.45) f = this.sr * 0.45
    this.fT = f
    this.wr = Math.max(0, Number(p.wobbleRate) || 0)
    this.wd = Math.max(0, Number(p.wobbleDepth) || 0)
    let m = Number(p.mix)
    if (!(m >= 0)) m = 100
    this.mixT = Math.min(1, m / 100)
    if (instant) {
      this.f = this.fT
      this.mix = this.mixT
      this.shape = s
      this.xf = 0
      this.cnt = 0
    } else if (s !== this.shape) {
      this.oldShape = this.shape
      this.shape = s
      this.xf = this.xfLen
    }
  }

  reset() {
    this.dcX.fill(0)
    this.dcY.fill(0)
    this.ph = 0
    this.wph = 0
    this.cnt = 0
    this.f = this.fT
    this.mix = this.mixT
    this.xf = 0
  }

  /**
   * in0/in1 and out0/out1 are channel arrays (in1/out1 null for mono).
   * side: normalised carrier samples (or null), read from index off.
   */
  run(in0, in1, out0, out1, n, side, off) {
    const R = this.R
    const dcX = this.dcX
    const dcY = this.dcY
    const sr = this.sr
    const xfLen = this.xfLen
    let ph = this.ph
    let dt = this.dt
    let mix = this.mix
    const kS = this.kS
    const sideLen = side ? side.length : 0
    for (let i = 0; i < n; i++) {
      if ((this.cnt & 15) === 0) {
        this.f += (this.fT - this.f) * this.k16
        let f = this.f
        if (this.wd > 0 && this.wr > 0) {
          this.wph += (16 * this.wr) / sr
          this.wph -= Math.floor(this.wph)
          f *= Math.pow(2, (this.wd * Math.sin(TWO_PI * this.wph)) / 12)
        }
        dt = f / sr
        if (dt > 0.45) dt = 0.45
      }
      this.cnt++
      ph += dt
      if (ph >= 1) ph -= 1
      let c
      const s = this.shape
      if (s === 4) c = sideLen ? side[(off + i) % sideLen] : 0
      else c = wave(s, ph, dt) * SHAPE_GAIN[s]
      if (this.xf > 0) {
        const a = this.xf / xfLen
        const o = this.oldShape
        const co = o === 4 ? (sideLen ? side[(off + i) % sideLen] : 0) : wave(o, ph, dt) * SHAPE_GAIN[o]
        c = c * (1 - a) + co * a
        this.xf--
      }
      mix += (this.mixT - mix) * kS
      // left (or mono)
      let x = in0[i]
      if (!(x > -1e9 && x < 1e9)) x = 0
      let x1 = 0
      if (in1) {
        x1 = in1[i]
        if (!(x1 > -1e9 && x1 < 1e9)) x1 = 0
      }
      let y = x - dcX[0] + R * dcY[0]
      dcX[0] = x
      dcY[0] = y < 1e-20 && y > -1e-20 ? 0 : y
      out0[i] = x + mix * (y * c - x)
      if (in1 && out1) {
        y = x1 - dcX[1] + R * dcY[1]
        dcX[1] = x1
        dcY[1] = y < 1e-20 && y > -1e-20 ? 0 : y
        out1[i] = x1 + mix * (y * c - x1)
      }
    }
    this.ph = ph
    this.dt = dt
    this.mix = mix
  }
}

/** Mono, RMS-normalised, softly limited carrier from the other sound. */
function sideCarrier(side, n) {
  const sl = bufLen(side)
  if (!sl) return null
  const out = new Float32Array(n)
  const nc = side.ch.length
  for (let c = 0; c < nc; c++) {
    const s = side.ch[c]
    for (let i = 0; i < n; i++) {
      const v = s[i % sl]
      if (v > -1e9 && v < 1e9) out[i] += v / nc
    }
  }
  let acc = 0
  for (let i = 0; i < n; i++) acc += out[i] * out[i]
  const r = n ? Math.sqrt(acc / n) : 0
  if (!(r > 1e-5)) return null
  const g = 1 / r
  for (let i = 0; i < n; i++) {
    let v = out[i] * g
    // gentle limit at about 4 times the RMS so a loud bang cannot spike
    if (v > 2 || v < -2) v = (v > 0 ? 1 : -1) * (2 + 2 * Math.tanh((Math.abs(v) - 2) / 2))
    out[i] = v
  }
  return out
}

function say(ctx, text) {
  if (ctx && typeof ctx.note === 'function') ctx.note(text)
}

export default {
  id: 'synth.ringmod',
  name: 'Ring modulator',
  family: 'synth',
  about: 'Multiplies your voice by a tone, so it rings like metal: the tin-voiced space invader, or a clanging robot when set high.',
  params: [
    { id: 'freq', name: 'Carrier pitch', type: 'number', min: 1, max: 3000, step: 1, def: 30, unit: 'hz', rand: [18, 600] },
    {
      id: 'shape',
      name: 'Carrier shape',
      type: 'choice',
      def: 'sine',
      options: [
        { v: 'sine', name: 'Smooth sine' },
        { v: 'square', name: 'Square' },
        { v: 'triangle', name: 'Triangle' },
        { v: 'saw', name: 'Sawtooth' },
        { v: 'side', name: 'The other sound' },
      ],
    },
    { id: 'wobbleRate', name: 'Wobble speed', type: 'number', min: 0, max: 20, step: 0.05, def: 0.5, unit: 'hz', rand: [0.1, 6] },
    {
      id: 'wobbleDepth',
      name: 'Wobble depth',
      type: 'number',
      min: 0,
      max: 24,
      step: 0.5,
      def: 0,
      unit: 'semitones',
      words: { pos: 'either way', zero: 'no wobble' },
      rand: [0, 7],
    },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [55, 100] },
  ],
  stereo: 'keep',
  side: true,
  tail: () => 0,
  warps: false,
  cost: 1,
  process(input, p, ctx) {
    const n = bufLen(input)
    if (!n) return input
    const sr = input.sr || (ctx && ctx.sr) || 48000
    let shape = p.shape
    let side = null
    if (shape === 'side') {
      side = ctx && ctx.side ? sideCarrier(ctx.side, n) : null
      if (!side) {
        shape = 'sine'
        say(ctx, 'Ring modulator: no other sound was given (or it was silent), so a smooth sine carrier was used.')
      }
    }
    const ch = input.ch
    for (let c = 0; c < ch.length; c += 2) {
      const core = new RingCore(sr)
      core.set(p, shape, true)
      const b = c + 1 < ch.length ? ch[c + 1] : null
      core.run(ch[c], b, ch[c], b, n, side, 0)
    }
    return input
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p) {
      const core = new RingCore(sr)
      core.set(p, p.shape === 'side' ? 'sine' : p.shape, true)
      return {
        process(ins, outs, n) {
          const in0 = ins[0]
          const in1 = ins.length > 1 ? ins[1] : null
          const out0 = outs[0]
          const out1 = outs.length > 1 ? outs[1] : null
          if (in1 && out1) core.run(in0, in1, out0, out1, n, null, 0)
          else {
            core.run(in0, null, out0, null, n, null, 0)
            if (out1) for (let i = 0; i < n; i++) out1[i] = out0[i]
          }
        },
        set(q) {
          core.set(q, q.shape === 'side' ? 'sine' : q.shape, false)
        },
        reset() {
          core.reset()
        },
      }
    },
  },
}
