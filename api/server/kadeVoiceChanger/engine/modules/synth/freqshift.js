// modules/synth/freqshift.js - single-sideband frequency shifter (synth.freqshift).
//
// Technique: the Bode frequency shifter (Harald Bode, "Solid state audio
// frequency spectrum shifter", AES preprint 395, 1965; described digitally
// in Zolzer (ed.), DAFX, 2nd edition 2011, chapter 2, "Single-side-band
// modulation"). An allpass pair splits the voice into two copies 90 degrees
// apart (the analytic signal re + i im); re cos(phi) - im sin(phi) then moves
// every frequency up by the rate of phi, and a negative rate moves it down.
// Unlike pitch shifting, every partial moves by the same number of hertz, so
// the harmonics stop lining up: a few hertz swirls and phases, tens of hertz
// sounds uneasy and metallic, hundreds of hertz is a single-sideband radio
// tuned slightly off, the "voice from another planet". Content moved below
// 0 Hz folds back, as in every analogue shifter.
//
// The 90-degree pair is Olli Niemitalo's polyphase IIR Hilbert transformer
// ("Hilbert transform", yehar.com, 2001): two chains of four second-order
// allpass sections, y[n] = a^2 (x[n] + y[n-2]) - x[n-2], one chain followed by
// a sample of delay; within a degree of 90 apart over nearly the whole band
// at any sample rate. It is written out here (rather than borrowed) because
// the feedback loop needs the per-sample state.
//
// Spiral feedback sends the shifted output back through a delay, so every
// echo is shifted again: with a long echo time the voice climbs (or falls)
// in a spiral of echoes, the endless-staircase effect; with a short time it
// rings as a moving metallic resonance. The loop is damped by a 7 kHz
// one-pole lowpass and a 30 Hz DC blocker, and a soft saturator keeps it
// bounded at any feedback. Tuning drift wanders the shift slowly (a smooth
// random LFO from core/lfo.js) like an old receiver drifting off station.
// Offline, a spiral runs on after the take until it has fallen 60 dB (the
// module's tail), capped at 12 s; a spiral that would ring longer (high
// feedback with a long echo time) fades out over the last 40 percent of the
// tail, at most 4 s, and a full one gets a short fade on its very end.
//
// The carrier phasor advances by a rotation recurrence renormalised every
// sample, so it never drifts and needs no sin or cos per sample. Shift,
// feedback, echo time and mix are smoothed in live mode, and offline and
// live run the same core.

import { bufLen, fade } from '../../core/buf.js'
import { makeRng } from '../../core/rng.js'
import { DelayLine } from '../../core/delay.js'
import { LFO } from '../../core/lfo.js'

const TWO_PI = 2 * Math.PI
const TAIL_MAX = 12

/**
 * Seconds until the spiral has fallen 60 dB: each trip round the loop is
 * one echo time and scales by the feedback, so it takes ln(0.001)/ln(fb)
 * trips (the 7 kHz damping and the saturator only make it shorter).
 */
function spiralSeconds(p) {
  const f = Math.min(0.97, Math.max(0, (Number(p && p.feedback) || 0) / 100))
  if (!(f > 0.001)) return 0
  const t = Math.max(0.001, (Number(p.time) || 1) / 1000)
  const echoes = Math.log(0.001) / Math.log(f)
  return t * (echoes + 1)
}
const COEF_A = [0.6923878, 0.9360654322959, 0.988229522686, 0.9987488452737]
const COEF_B = [0.4021921162426, 0.856171088242, 0.9722909545651, 0.9952884791278]
const A2 = new Float64Array(COEF_A.map((a) => a * a))
const B2 = new Float64Array(COEF_B.map((a) => a * a))
const TINY = 1e-25
const MAX_TIME_S = 1.0

class Quadrature {
  constructor() {
    this.sa = new Float64Array(16)
    this.sb = new Float64Array(16)
    this.dly = 0
    this.re = 0
    this.im = 0
  }

  tick(x) {
    let a = x
    let b = x
    const sa = this.sa
    const sb = this.sb
    for (let k = 0; k < 4; k++) {
      const o = k * 4
      let ya = A2[k] * (a + sa[o + 3]) - sa[o + 1]
      if (ya < TINY && ya > -TINY) ya = 0
      sa[o + 1] = sa[o]
      sa[o] = a
      sa[o + 3] = sa[o + 2]
      sa[o + 2] = ya
      a = ya
      let yb = B2[k] * (b + sb[o + 3]) - sb[o + 1]
      if (yb < TINY && yb > -TINY) yb = 0
      sb[o + 1] = sb[o]
      sb[o] = b
      sb[o + 3] = sb[o + 2]
      sb[o + 2] = yb
      b = yb
    }
    this.re = b
    this.im = this.dly
    this.dly = a
  }

  reset() {
    this.sa.fill(0)
    this.sb.fill(0)
    this.dly = 0
    this.re = 0
    this.im = 0
  }
}

class ShiftCore {
  constructor(sr, rng) {
    this.sr = sr
    this.q = [new Quadrature(), new Quadrature()]
    const maxT = Math.ceil(MAX_TIME_S * sr) + 8
    this.dl = [new DelayLine(maxT), new DelayLine(maxT)]
    this.fbs = new Float64Array(2)
    this.lp = new Float64Array(2)
    this.hpX = new Float64Array(2)
    this.hpY = new Float64Array(2)
    this.kLP = 1 - Math.exp((-TWO_PI * Math.min(7000, 0.3 * sr)) / sr)
    this.Rhp = Math.exp((-TWO_PI * 30) / sr)
    this.k16 = 1 - Math.exp(-16 / (0.03 * sr))
    this.kS = 1 - Math.exp(-1 / (0.03 * sr))
    this.kT = 1 - Math.exp(-1 / (0.08 * sr))
    this.lfo = new LFO(sr, { shape: 'smooth', rate: 0.3 * 16, rng: rng || makeRng('synth.freqshift') })
    this.c = 1
    this.s = 0
    this.cd = 1
    this.sd = 0
    this.hz = 0
    this.hzT = 0
    this.drift = 0
    this.fb = 0
    this.fbT = 0
    this.T = 1
    this.TT = 1
    this.mix = 1
    this.mixT = 1
    this.cnt = 0
  }

  set(p, instant) {
    const lim = this.sr * 0.45
    let h = Number(p.shift)
    if (!Number.isFinite(h)) h = 0
    if (h > lim) h = lim
    if (h < -lim) h = -lim
    this.hzT = h
    this.drift = Math.max(0, Number(p.drift) || 0)
    let f = (Number(p.feedback) || 0) / 100
    if (!(f > 0)) f = 0
    if (f > 0.97) f = 0.97
    this.fbT = f
    let t = ((Number(p.time) || 0) / 1000) * this.sr
    if (!(t >= 1)) t = 1
    if (t > MAX_TIME_S * this.sr) t = MAX_TIME_S * this.sr
    this.TT = t
    let m = Number(p.mix)
    if (!(m >= 0)) m = 100
    this.mixT = Math.min(1, m / 100)
    if (instant) {
      this.hz = this.hzT
      this.fb = this.fbT
      this.T = this.TT
      this.mix = this.mixT
      this.cnt = 0
    }
  }

  reset() {
    this.q[0].reset()
    this.q[1].reset()
    this.dl[0].clear()
    this.dl[1].clear()
    this.fbs.fill(0)
    this.lp.fill(0)
    this.hpX.fill(0)
    this.hpY.fill(0)
    this.c = 1
    this.s = 0
    this.cnt = 0
    this.hz = this.hzT
    this.fb = this.fbT
    this.T = this.TT
    this.mix = this.mixT
  }

  _chan(k, x, cph, sph, loop) {
    const q = this.q[k]
    q.tick(x + this.fb * this.fbs[k])
    const y = q.re * cph - q.im * sph
    if (loop) {
      let z = this.lp[k] + (y - this.lp[k]) * this.kLP
      if (z < TINY && z > -TINY) z = 0
      this.lp[k] = z
      let hy = z - this.hpX[k] + this.Rhp * this.hpY[k]
      if (hy < TINY && hy > -TINY) hy = 0
      if (!(hy > -1e6 && hy < 1e6)) hy = 0
      this.hpX[k] = z
      this.hpY[k] = hy
      const d = this.dl[k]
      d.write(hy / Math.sqrt(1 + 0.1 * hy * hy))
      this.fbs[k] = d.read(this.T - 1)
    }
    return y
  }

  run(in0, in1, out0, out1, n) {
    const sr = this.sr
    const kS = this.kS
    const loopNeeded = this.fbT > 0 || this.fb > 1e-6
    for (let i = 0; i < n; i++) {
      if ((this.cnt & 15) === 0) {
        this.hz += (this.hzT - this.hz) * this.k16
        let h = this.hz
        if (this.drift > 0) h += this.drift * this.lfo.next()
        const lim = sr * 0.45
        if (h > lim) h = lim
        if (h < -lim) h = -lim
        const w = (TWO_PI * h) / sr
        this.cd = Math.cos(w)
        this.sd = Math.sin(w)
      }
      this.cnt++
      this.fb += (this.fbT - this.fb) * kS
      this.mix += (this.mixT - this.mix) * kS
      this.T += (this.TT - this.T) * this.kT
      const cph = this.c
      const sph = this.s
      const m = this.mix
      let x = in0[i]
      if (!(x > -1e9 && x < 1e9)) x = 0
      if (in1 && out1) {
        let x1 = in1[i]
        if (!(x1 > -1e9 && x1 < 1e9)) x1 = 0
        const y1 = this._chan(1, x1, cph, sph, loopNeeded)
        out1[i] = x1 + m * (y1 - x1)
      }
      const y0 = this._chan(0, x, cph, sph, loopNeeded)
      out0[i] = x + m * (y0 - x)
      const nc = cph * this.cd - sph * this.sd
      const ns = sph * this.cd + cph * this.sd
      const g = 1.5 - 0.5 * (nc * nc + ns * ns)
      this.c = nc * g
      this.s = ns * g
    }
  }
}

export default {
  id: 'synth.freqshift',
  name: 'Frequency shifter',
  family: 'synth',
  about: 'Slides every part of your voice up or down by the same number of hertz: a radio tuned slightly off, or an uneasy alien.',
  params: [
    { id: 'shift', name: 'Shift', type: 'number', min: -2000, max: 2000, step: 1, def: 50, unit: 'hz', rand: [-250, 250] },
    { id: 'feedback', name: 'Spiral feedback', type: 'number', min: 0, max: 95, step: 1, def: 0, unit: 'percent', rand: [0, 65] },
    { id: 'time', name: 'Spiral echo time', type: 'number', min: 1, max: 1000, step: 1, def: 150, unit: 'ms', rand: [20, 400] },
    { id: 'drift', name: 'Tuning drift', type: 'number', min: 0, max: 300, step: 1, def: 0, unit: 'hz', rand: [0, 40] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [55, 100] },
  ],
  stereo: 'keep',
  tail: (p) => Math.min(TAIL_MAX, spiralSeconds(p)),
  warps: false,
  cost: 1,
  process(input, p, ctx) {
    const n = bufLen(input)
    if (!n) return input
    const sr = input.sr || (ctx && ctx.sr) || 48000
    const base = ctx && ctx.rng ? ctx.rng : makeRng('synth.freqshift')
    const spiral = spiralSeconds(p)
    const tailSec = Math.min(TAIL_MAX, spiral)
    const total = n + Math.round(tailSec * sr)
    // with spiral feedback the output runs on past the take (silence in)
    const ch =
      total === n
        ? input.ch
        : input.ch.map((x) => {
            const y = new Float32Array(total)
            y.set(x)
            return y
          })
    for (let c = 0; c < ch.length; c += 2) {
      const core = new ShiftCore(sr, base.fork('drift'))
      core.set(p, true)
      const b = c + 1 < ch.length ? ch[c + 1] : null
      core.run(ch[c], b, ch[c], b, total)
    }
    const out = { sr, ch }
    if (total > n) {
      // a capped spiral fades over its last 40 percent (at most 4 s); a full
      // one is 60 dB down by its end and gets only a short fade
      fade(out, 0, spiral > tailSec ? Math.min(4, 0.4 * tailSec) : Math.min(0.5, 0.1 * tailSec))
    }
    return out
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p, rng) {
      const core = new ShiftCore(sr, (rng || makeRng('synth.freqshift')).fork('drift'))
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
