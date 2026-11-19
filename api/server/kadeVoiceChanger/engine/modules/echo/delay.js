// modules/echo/delay.js - echo.delay, the everyday echo.
//
// Technique: a feedback delay line per ear, the circuit of every tape and
// digital echo since the 1950s (see Zolzer, ed., "DAFX: Digital Audio
// Effects", 2nd ed. 2011, chapter 2, "Delays"). Each repeat passes through
// the loop's tone filters, so the echoes darken as they fade (damping: a
// topology-preserving one-pole low pass, plus a 90 Hz high pass that keeps
// repeats from piling up mud). Three stereo layouts:
// - Center: each channel echoes itself (a mono voice gives a mono echo).
// - Bouncing between ears: the classic ping-pong. The voice feeds the left
//   line only, and the two lines feed each other, so repeats alternate
//   left, right, left.
// - Wide: the right line is 7 percent longer, so the repeats drift apart and
//   spread out across the head.
// Tape wobble modulates the delay time with slow wow (slewed random) and
// fast flutter (a 6 Hz sine), read with cubic Hermite interpolation
// (core/delay.js), and adds the gentle saturation and top loss of tape.
// Echo time can lock to a beat (quarter, eighth, dotted eighth, triplet,
// sixteenth, half note at a tempo). Changing the time while it plays glides
// like a tape machine changing speed instead of clicking.
//
// The live version and the offline version are the same per-sample kernel.

import { DelayLine } from '../../core/delay.js'
import { LFO } from '../../core/lfo.js'
import { makeRng } from '../../core/rng.js'
import { num, clamp, mixGains, repeatsTo, capTail, smoothCoef, onePoleG, feedbackSat, tapeSat, flush, runKernel, tailFade } from './_lib.js'

const DIV = { quarter: 1, eighth: 0.5, dotted: 0.75, triplet: 1 / 3, sixteenth: 0.25, half: 2 }
const WIDE = 1.07
const MAX_MS = 2000
const WOW_MS = 3.5
const FLUTTER_MS = 0.3

function echoMs(p) {
  const div = p && p.division
  if (div && div !== 'free' && DIV[div]) {
    const q = 60000 / clamp(num(p.tempo, 120), 30, 300)
    return clamp(q * DIV[div], 20, MAX_MS)
  }
  return clamp(num(p && p.time, 340), 20, MAX_MS)
}

function rawTail(p) {
  const g = mixGains(p && p.mix)
  if (g.wet === 0) return 0
  const T = (echoMs(p) / 1000) * (p && p.stereo === 'wide' ? WIDE : 1) + (2 * (WOW_MS + FLUTTER_MS)) / 1000
  const reps = repeatsTo(num(p && p.feedback, 40) / 100)
  return (reps + 1) * T + 0.05
}

class DelayKernel {
  constructor(sr, p, rng) {
    this.sr = sr
    const r = rng && typeof rng.fork === 'function' ? rng : makeRng('echo.delay')
    const maxSamp = Math.ceil(((MAX_MS * WIDE + 2 * (WOW_MS + FLUTTER_MS) + 5) / 1000) * sr) + 8
    this.lineL = new DelayLine(maxSamp)
    this.lineR = new DelayLine(maxSamp)
    this.wow = new LFO(sr, { shape: 'smooth', rate: 0.55, rng: r.fork('wow') })
    this.flPh = 0
    this.flInc = 6.1 / sr
    this.kT = smoothCoef(0.12, sr)
    this.kG = smoothCoef(0.02, sr)
    this.hpG = onePoleG(90, sr)
    this.reset()
    this.set(p)
    this.snap()
  }

  set(p) {
    const sr = this.sr
    this.tD = Math.max(1, (echoMs(p) / 1000) * sr)
    this.tFb = clamp(num(p.feedback, 40) / 100, 0, 0.95)
    const wob = clamp(num(p.wobble, 0) / 100, 0, 1)
    this.tWob = wob
    const damp = clamp(num(p.damping, 35) / 100, 0, 1)
    const cut = 16000 * Math.pow(1200 / 16000, damp) * (1 - 0.35 * wob)
    this.tLp = onePoleG(cut, sr)
    const g = mixGains(p.mix)
    this.tDry = g.dry
    this.tWet = g.wet
    const mode = p.stereo === 'mono' ? 0 : p.stereo === 'wide' ? 2 : 1
    this.tSelf = mode === 1 ? 0 : 1 // input to own line (else mono sum to the left line)
    this.tCross = mode === 1 ? 1 : 0 // ping-pong cross feedback
    this.tRatio = mode === 2 ? WIDE : 1
  }

  snap() {
    this.d = this.tD
    this.fb = this.tFb
    this.wob = this.tWob
    this.lp = this.tLp
    this.dry = this.tDry
    this.wet = this.tWet
    this.self = this.tSelf
    this.cross = this.tCross
    this.ratio = this.tRatio
  }

  reset() {
    this.lineL.clear()
    this.lineR.clear()
    this.lpL = 0
    this.lpR = 0
    this.hpL = 0
    this.hpR = 0
    this.flPh = 0
    this.wow.reset(0)
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
    const wowS = (WOW_MS / 1000) * sr
    const flS = (FLUTTER_MS / 1000) * sr
    const TWO_PI = 2 * Math.PI
    let d = this.d
    let fb = this.fb
    let wob = this.wob
    let lp = this.lp
    let dry = this.dry
    let wet = this.wet
    let self = this.self
    let cross = this.cross
    let ratio = this.ratio
    let lpL = this.lpL
    let lpR = this.lpR
    let hpL = this.hpL
    let hpR = this.hpR
    let flPh = this.flPh
    const lineL = this.lineL
    const lineR = this.lineR
    for (let i = 0; i < n; i++) {
      let xl = inL[i]
      let xr = inR[i]
      if (!(xl > -1e9 && xl < 1e9)) xl = 0
      if (!(xr > -1e9 && xr < 1e9)) xr = 0
      d += (this.tD - d) * kT
      ratio += (this.tRatio - ratio) * kT
      fb += (this.tFb - fb) * kG
      wob += (this.tWob - wob) * kG
      lp += (this.tLp - lp) * kG
      dry += (this.tDry - dry) * kG
      wet += (this.tWet - wet) * kG
      self += (this.tSelf - self) * kG
      cross += (this.tCross - cross) * kG
      // tape wobble
      let w = 0
      const wv = this.wow.next()
      if (wob > 1e-4) {
        w = wob * (wowS * (wv + 1) + flS * (Math.sin(TWO_PI * flPh) + 1))
      }
      flPh += this.flInc
      if (flPh >= 1) flPh -= 1
      let eL = lineL.read(d + w - 1)
      let eR = lineR.read(d * ratio + w - 1)
      // darker repeats: low pass, then the mud-cutting high pass
      let v = (eL - lpL) * lp
      let y = v + lpL
      lpL = flush(y + v)
      eL = y
      v = (eR - lpR) * lp
      y = v + lpR
      lpR = flush(y + v)
      eR = y
      v = (eL - hpL) * hpG
      y = v + hpL
      hpL = flush(y + v)
      eL -= y
      v = (eR - hpR) * hpG
      y = v + hpR
      hpR = flush(y + v)
      eR -= y
      if (wob > 1e-4) {
        const t = 0.7 * wob
        eL += t * (tapeSat(1.6 * eL) / 1.6 - eL)
        eR += t * (tapeSat(1.6 * eR) / 1.6 - eR)
      }
      const m = 0.5 * (xl + xr)
      const sendL = self * xl + (1 - self) * m
      const sendR = self * xr
      const bl = fb * ((1 - cross) * eL + cross * eR)
      const br = fb * ((1 - cross) * eR + cross * eL)
      lineL.write(flush(sendL + feedbackSat(bl)))
      lineR.write(flush(sendR + feedbackSat(br)))
      const yl = dry * xl + wet * eL
      const yr = dry * xr + wet * eR
      if (oR) {
        oL[i] = yl
        oR[i] = yr
      } else {
        oL[i] = 0.5 * (yl + yr)
      }
    }
    this.d = d
    this.fb = fb
    this.wob = wob
    this.lp = lp
    this.dry = dry
    this.wet = wet
    this.self = self
    this.cross = cross
    this.ratio = ratio
    this.lpL = lpL
    this.lpR = lpR
    this.hpL = hpL
    this.hpR = hpR
    this.flPh = flPh
  }
}

export default {
  id: 'echo.delay',
  name: 'Echo',
  family: 'echo',
  about: 'Repeats of your voice, from a quick double to long echoes, centered, bouncing between your ears, or on wobbly old tape.',
  params: [
    { id: 'time', name: 'Echo time', type: 'number', min: 20, max: 2000, step: 1, def: 340, unit: 'ms', rand: [160, 700] },
    {
      id: 'division', name: 'Lock to a beat', type: 'choice', def: 'free',
      options: [
        { v: 'free', name: 'Off, use the echo time' },
        { v: 'quarter', name: 'Quarter note' },
        { v: 'eighth', name: 'Eighth note' },
        { v: 'dotted', name: 'Dotted eighth' },
        { v: 'triplet', name: 'Eighth note triplet' },
        { v: 'sixteenth', name: 'Sixteenth note' },
        { v: 'half', name: 'Half note' },
      ],
    },
    { id: 'tempo', name: 'Beat tempo', type: 'number', min: 60, max: 200, step: 1, def: 120, unit: 'bpm' },
    { id: 'feedback', name: 'Repeats', type: 'number', min: 0, max: 95, step: 1, def: 40, unit: 'percent', rand: [15, 60] },
    { id: 'damping', name: 'Darker repeats', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [10, 70] },
    {
      id: 'stereo', name: 'Stereo', type: 'choice', def: 'pingpong',
      options: [
        { v: 'mono', name: 'Center' },
        { v: 'pingpong', name: 'Bouncing between ears' },
        { v: 'wide', name: 'Wide' },
      ],
    },
    { id: 'wobble', name: 'Tape wobble', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 60] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [20, 50] },
  ],
  stereo: 'make',
  warps: false,
  cost: 1,
  tail: (p) => capTail(rawTail(p)),
  process(input, p, ctx) {
    const sr = input.sr
    const raw = rawTail(p)
    const k = new DelayKernel(sr, p, ctx && ctx.rng)
    return runKernel(k, input, capTail(raw), 2, ctx, tailFade(raw))
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p, rng) {
      return new DelayKernel(sr, p, rng)
    },
  },
}
