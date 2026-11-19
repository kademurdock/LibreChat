// modules/echo/dub.js - echo.dub, the reggae and dub sound-system delay.
//
// Technique: a tape-style feedback delay whose loop holds a resonant band
// pass and a saturating stage, the way dub engineers ran a tape echo through
// a filter and rode the feedback up to the edge of runaway (see Zolzer, ed.,
// "DAFX", 2nd ed. 2011, chapter 2 for the feedback delay). The band pass is
// the topology-preserving state-variable filter in Andrew Simper's form of
// Zavalishin's design ("The Art of VA Filter Design", 2012), which stays
// smooth while its centre is swept; its coefficients are refreshed every
// fourth sample (counted from the start, so any block size gives the same
// sound). Each repeat is band-limited again, so repeats turn thin and
// telephone-like as they fade, and a slow sine sweeps the centre so they
// whoosh up and down. Above 90 percent the feedback runs past unity (100
// percent is a loop gain of 1.1): the loop then grows on its own and the
// saturator (a rounded tanh-like curve) holds it at a loud, singing ceiling
// instead of exploding, the classic "runaway" swell.
//
// Spring splash: a spring tank after Valimaki, Parker and Abel, "Parametric
// spring reverberation effect", JAES 2010 (stretched allpass dispersion in a
// lowpassed loop, see _lib.js), different on each side, hit by the echoes and
// by a little of the voice: the drippy "boing" of dub records.
//
// The live and offline versions are the same per-sample kernel.

import { DelayLine } from '../../core/delay.js'
import { LFO } from '../../core/lfo.js'
import { makeRng } from '../../core/rng.js'
import { num, clamp, mixGains, repeatsTo, capTail, smoothCoef, onePoleG, tapeSat, flush, runKernel, tailFade, Spring } from './_lib.js'

const MAX_MS = 1500
const DRIFT_MS = 0.5
const Q = 0.9
const RUNAWAY_SEC = 8

/** Loop gain for the feedback percent: straight up to 90, then 90..100 maps to 0.9..1.1. */
function loopGain(pct) {
  const f = clamp(num(pct, 70), 0, 100)
  return f <= 90 ? f / 100 : 0.9 + (f - 90) * 0.02
}

function runaway(p) {
  return loopGain(p && p.feedback) >= 0.97
}

function rawTail(p) {
  const g = mixGains(p && p.mix)
  if (g.wet === 0) return 0
  const T = clamp(num(p && p.time, 375), 60, MAX_MS) / 1000 + (2 * DRIFT_MS) / 1000
  const spring = num(p && p.spring, 30) > 0 ? 1.3 : 0
  // A loop at or past runaway sings forever: give it eight seconds after the
  // take and fade it out like an engineer pulling the fader.
  if (runaway(p)) return RUNAWAY_SEC + spring
  const reps = repeatsTo(loopGain(p && p.feedback))
  return (reps + 1) * T + spring + 0.05
}

function endFade(p) {
  return runaway(p) ? 3 : tailFade(rawTail(p))
}

class DubKernel {
  constructor(sr, p, rng) {
    this.sr = sr
    const r = rng && typeof rng.fork === 'function' ? rng : makeRng('echo.dub')
    this.line = new DelayLine(Math.ceil(((MAX_MS + 2 * DRIFT_MS + 5) / 1000) * sr) + 8)
    this.drift = new LFO(sr, { shape: 'smooth', rate: 0.35, rng: r.fork('drift') })
    this.springL = new Spring(sr, 0)
    this.springR = new Spring(sr, 1)
    this.kT = smoothCoef(0.15, sr)
    this.kG = smoothCoef(0.03, sr)
    this.hpG = onePoleG(100, sr)
    this.reset()
    this.set(p)
    this.snap()
  }

  set(p) {
    const sr = this.sr
    this.tD = Math.max(1, (clamp(num(p.time, 375), 60, MAX_MS) / 1000) * sr)
    this.tFb = loopGain(p.feedback)
    this.tTone = Math.log2(clamp(num(p.tone, 1000), 100, 6000))
    this.tSweep = 1.5 * clamp(num(p.sweep, 40) / 100, 0, 1)
    this.rateInc = clamp(num(p.rate, 0.12), 0.01, 5) / sr
    this.tSpring = 0.9 * clamp(num(p.spring, 30) / 100, 0, 1)
    const g = mixGains(p.mix)
    this.tDry = g.dry
    this.tWet = g.wet
  }

  snap() {
    this.d = this.tD
    this.fb = this.tFb
    this.tone = this.tTone
    this.sw = this.tSweep
    this.spring = this.tSpring
    this.dry = this.tDry
    this.wet = this.tWet
  }

  reset() {
    this.line.clear()
    this.springL.reset()
    this.springR.reset()
    this.drift.reset(0)
    this.ph = 0.75
    this.cnt = 0
    this.ic1 = 0
    this.ic2 = 0
    this.a1 = 1
    this.a2 = 0
    this.a3 = 0
    this.hpS = 0
  }

  process(ins, outs, n) {
    const inL = ins[0]
    const inR = ins.length > 1 ? ins[1] : ins[0]
    const oL = outs[0]
    const oR = outs.length > 1 ? outs[1] : null
    const sr = this.sr
    const kT = this.kT
    const kG = this.kG
    const hpG = this.hpG
    const line = this.line
    const drift = this.drift
    const springL = this.springL
    const springR = this.springR
    const driftS = (DRIFT_MS / 1000) * sr
    const nyq = sr * 0.45
    const kq = 1 / Q
    const piSr = Math.PI / sr
    const TWO_PI = 2 * Math.PI
    const rateInc = this.rateInc
    let d = this.d, fb = this.fb, tone = this.tone, sw = this.sw, spring = this.spring, dry = this.dry, wet = this.wet
    let hpS = this.hpS, ph = this.ph, cnt = this.cnt
    let ic1 = this.ic1, ic2 = this.ic2, a1 = this.a1, a2 = this.a2, a3 = this.a3
    for (let i = 0; i < n; i++) {
      let xl = inL[i]
      let xr = inR[i]
      if (!(xl > -1e9 && xl < 1e9)) xl = 0
      if (!(xr > -1e9 && xr < 1e9)) xr = 0
      d += (this.tD - d) * kT
      fb += (this.tFb - fb) * kG
      tone += (this.tTone - tone) * kG
      sw += (this.tSweep - sw) * kG
      spring += (this.tSpring - spring) * kG
      dry += (this.tDry - dry) * kG
      wet += (this.tWet - wet) * kG
      // filter centre: refreshed every fourth sample
      if ((cnt & 3) === 0) {
        let fc = Math.pow(2, tone + sw * Math.sin(TWO_PI * ph))
        if (fc > nyq) fc = nyq
        const g = Math.tan(fc * piSr)
        a1 = 1 / (1 + g * (g + kq))
        a2 = g * a1
        a3 = g * a2
      }
      cnt = (cnt + 1) & 0x3fffffff
      ph += rateInc
      if (ph >= 1) ph -= 1
      const m = 0.5 * (xl + xr)
      const v = (m - hpS) * hpG
      const y = v + hpS
      hpS = flush(y + v)
      const send = m - y
      // the tape echo, drifting a hair like a real machine
      const e = line.read(d + driftS * (1 + drift.next()) - 1)
      // band pass (unity peak gain: k times the band output)
      const v3 = e - ic2
      const v1 = a1 * ic1 + a2 * v3
      const v2 = ic2 + a2 * ic1 + a3 * v3
      ic1 = flush(2 * v1 - ic1)
      ic2 = flush(2 * v2 - ic2)
      if (!(ic1 > -1e6 && ic1 < 1e6) || !(ic2 > -1e6 && ic2 < 1e6)) {
        ic1 = 0
        ic2 = 0
      }
      const echo = tapeSat(1.2 * kq * v1) / 1.2
      line.write(flush(send + fb * echo))
      let wl = echo
      let wr = echo
      if (spring > 1e-4) {
        // the spring, hit by the echoes and a little of the voice
        const hit = echo + 0.35 * send
        wl += spring * springL.tick(hit)
        wr += spring * springR.tick(hit)
      }
      const yl = dry * xl + wet * wl
      const yr = dry * xr + wet * wr
      if (oR) {
        oL[i] = yl
        oR[i] = yr
      } else {
        oL[i] = 0.5 * (yl + yr)
      }
    }
    this.d = d; this.fb = fb; this.tone = tone; this.sw = sw; this.spring = spring; this.dry = dry; this.wet = wet
    this.hpS = hpS; this.ph = ph; this.cnt = cnt
    this.ic1 = ic1; this.ic2 = ic2; this.a1 = a1; this.a2 = a2; this.a3 = a3
  }
}

export default {
  id: 'echo.dub',
  name: 'Dub delay',
  family: 'echo',
  about: 'A sound-system dub echo: filtered repeats that sweep and swirl, a dripping spring, and feedback that runs away into a swell above 90 percent.',
  params: [
    { id: 'time', name: 'Echo time', type: 'number', min: 60, max: 1500, step: 1, def: 375, unit: 'ms', rand: [250, 600] },
    { id: 'feedback', name: 'Feedback', type: 'number', min: 0, max: 100, step: 1, def: 70, unit: 'percent', rand: [50, 85] },
    { id: 'tone', name: 'Filter center', type: 'number', min: 200, max: 4000, step: 10, def: 1000, unit: 'hz', rand: [500, 2000] },
    { id: 'sweep', name: 'Filter sweep', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 80] },
    { id: 'rate', name: 'Sweep speed', type: 'number', min: 0.02, max: 2, step: 0.01, def: 0.12, unit: 'hz', rand: [0.05, 0.4] },
    { id: 'spring', name: 'Spring splash', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 70] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [30, 55] },
  ],
  stereo: 'make',
  warps: false,
  cost: 2,
  tail: (p) => capTail(rawTail(p)),
  process(input, p, ctx) {
    const raw = rawTail(p)
    const k = new DubKernel(input.sr, p, ctx && ctx.rng)
    return runKernel(k, input, capTail(raw), 2, ctx, endFade(p))
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p, rng) {
      return new DubKernel(sr, p, rng)
    },
  },
}
