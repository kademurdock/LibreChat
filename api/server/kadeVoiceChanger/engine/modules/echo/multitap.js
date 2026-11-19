// modules/echo/multitap.js - echo.multitap, echoes in a rhythm pattern.
//
// Technique: a multi-tap delay line, the design of the first digital delays
// and of the tape echo units with several playback heads (Zolzer, ed.,
// "DAFX: Digital Audio Effects", 2nd ed. 2011, section 2.3; Dattorro,
// "Effect Design, Part 2: Delay-Line Modulation and Chorus", JAES 1997, for
// the tapped-line view). One line holds the voice; up to eight read heads
// pick it up at the beat positions of a pattern, each with its own level,
// place in the stereo field and tone (later taps darker, like heads further
// down a worn tape). The whole pattern can recirculate: the line feeds back
// into itself once per pattern cycle, so the rhythm plays again, quieter
// and darker. Patterns are written in beats and played at a tempo.
//
// Changing pattern or tempo while it plays glides every head to its new
// place (a short pitch swoop), never a click. The live and offline versions
// are the same per-sample kernel.

import { DelayLine } from '../../core/delay.js'
import { makeRng } from '../../core/rng.js'
import { num, clamp, mixGains, repeatsTo, capTail, smoothCoef, onePoleG, feedbackSat, flush, runKernel, tailFade } from './_lib.js'

const MAXT = 8
const MIN_BPM = 60
const MAX_BEATS = 4

function seq(times, gains, pans, cycle) {
  return { cycle, taps: times.map((t, i) => [t, gains[i], pans[i]]) }
}

function bounce() {
  const times = []
  let t = 0
  let gap = 0.9
  for (let k = 0; k < 8; k++) {
    t += gap
    times.push(t)
    gap *= 0.72
  }
  const gains = times.map((_, k) => 0.9 * Math.pow(0.82, k))
  const pans = times.map((_, k) => (k % 2 ? 0.35 : -0.35) * (1 - k / 10))
  return seq(times, gains, pans, 4)
}

function slowing() {
  const times = []
  let t = 0
  let gap = 0.12
  for (let k = 0; k < 6; k++) {
    t += gap
    times.push(t)
    gap *= 1.5
  }
  const gains = times.map((_, k) => 0.85 - 0.1 * k)
  const pans = times.map((_, k) => -0.9 + (1.8 * k) / 5)
  return seq(times, gains, pans, 3)
}

function sweep() {
  const times = []
  for (let k = 1; k <= 8; k++) times.push(0.25 * k)
  return seq(times, times.map((_, k) => 0.9 - 0.07 * k), times.map((_, k) => -1 + (2 * k) / 7), 2)
}

const FIXED = {
  even: seq([0.5, 1, 1.5, 2], [0.9, 0.75, 0.6, 0.45], [-0.7, 0.7, -0.4, 0.4], 2),
  gallop: seq([0.5, 0.75, 1, 1.5, 1.75, 2], [0.85, 0.6, 0.8, 0.55, 0.4, 0.5], [-0.8, -0.3, 0.6, 0.8, 0.3, -0.6], 2),
  dotted: seq([0.75, 1.5, 2.25, 3], [0.9, 0.7, 0.55, 0.4], [-0.8, 0.8, -0.5, 0.5], 3),
  triplets: seq([1 / 3, 2 / 3, 1, 4 / 3, 5 / 3, 2], [0.8, 0.65, 0.75, 0.5, 0.4, 0.45], [-0.9, 0, 0.9, -0.6, 0, 0.6], 2),
  swing: seq([2 / 3, 1, 5 / 3, 2], [0.85, 0.65, 0.7, 0.5], [-0.7, 0.5, 0.7, -0.5], 2),
  heartbeat: seq([0.75, 1, 1.75, 2, 2.75, 3], [0.85, 0.6, 0.6, 0.42, 0.4, 0.28], [-0.6, -0.6, 0.6, 0.6, -0.3, -0.3], 3),
  bounce: bounce(),
  slowing: slowing(),
  sweep: sweep(),
}

/** The scattered pattern: seven taps at seeded random beats. */
function scatter(rng) {
  const r = rng.fork('scatter')
  const times = []
  for (let k = 0; k < 7; k++) times.push(0.15 + 2.45 * r.next())
  times.sort((a, b) => a - b)
  const gains = times.map((t) => 0.9 * (1 - 0.55 * (t / 2.6)))
  const pans = times.map(() => r.range(-0.95, 0.95))
  return seq(times, gains, pans, 3)
}

function patternOf(name, scat) {
  if (name === 'scatter') return scat
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(FIXED, name) ? FIXED[name] : FIXED.gallop
}

function beatSec(p) {
  return 60 / clamp(num(p && p.tempo, 110), MIN_BPM, 200)
}

// The scattered taps depend on the seed, so its tail uses the latest a tap can land.
const SCATTER_BOUND = { cycle: 3, taps: [[2.6, 1, 0]] }

function rawTail(p) {
  const g = mixGains(p && p.mix)
  if (g.wet === 0) return 0
  const pat = patternOf(p && p.pattern, SCATTER_BOUND)
  const b = beatSec(p)
  let last = 0
  for (const t of pat.taps) if (t[0] > last) last = t[0]
  const reps = repeatsTo(num(p && p.feedback, 15) / 100)
  return last * b + reps * pat.cycle * b + 0.05
}

class MultiKernel {
  constructor(sr, p, rng) {
    this.sr = sr
    const r = rng && typeof rng.fork === 'function' ? rng : makeRng('echo.multitap')
    this.scat = scatter(r)
    this.line = new DelayLine(Math.ceil((MAX_BEATS * 60) / MIN_BPM * sr * 1.02) + 16)
    this.tD = new Float64Array(MAXT)
    this.cD = new Float64Array(MAXT)
    this.tGL = new Float64Array(MAXT)
    this.tGR = new Float64Array(MAXT)
    this.cGL = new Float64Array(MAXT)
    this.cGR = new Float64Array(MAXT)
    this.tLp = new Float64Array(MAXT)
    this.cLp = new Float64Array(MAXT)
    this.st = new Float64Array(MAXT)
    this.kT = smoothCoef(0.06, sr)
    this.kG = smoothCoef(0.03, sr)
    this.hpG = onePoleG(110, sr)
    this.reset()
    this.set(p)
    this.snap()
  }

  set(p) {
    const sr = this.sr
    const pat = patternOf(p.pattern, this.scat)
    const b = beatSec(p) * sr
    const spread = clamp(num(p.spread, 70) / 100, 0, 1)
    const damp = clamp(num(p.damping, 30) / 100, 0, 1)
    const nT = Math.min(MAXT, pat.taps.length)
    for (let k = 0; k < MAXT; k++) {
      if (k < nT) {
        const t = pat.taps[k]
        this.tD[k] = Math.max(1, t[0] * b)
        const pan = t[2] * spread
        this.tGL[k] = t[1] * (pan > 0 ? 1 - pan : 1)
        this.tGR[k] = t[1] * (pan < 0 ? 1 + pan : 1)
        const q = (k + 1) / nT
        this.tLp[k] = onePoleG(15000 * Math.pow(1200 / 15000, damp * q), sr)
      } else {
        this.tGL[k] = 0
        this.tGR[k] = 0
        this.tLp[k] = onePoleG(15000, sr)
        // unused heads keep their place so a pattern change glides from where they were
      }
    }
    this.tFbD = Math.max(1, pat.cycle * b)
    this.tFb = clamp(num(p.feedback, 15) / 100, 0, 0.9)
    this.tFbLp = onePoleG(15000 * Math.pow(1200 / 15000, damp * 0.5), sr)
    const g = mixGains(p.mix)
    this.tDry = g.dry
    this.tWet = g.wet
  }

  snap() {
    for (let k = 0; k < MAXT; k++) {
      this.cD[k] = this.tD[k] > 0 ? this.tD[k] : 1
      this.cGL[k] = this.tGL[k]
      this.cGR[k] = this.tGR[k]
      this.cLp[k] = this.tLp[k]
    }
    this.fbD = this.tFbD
    this.fb = this.tFb
    this.fbLp = this.tFbLp
    this.dry = this.tDry
    this.wet = this.tWet
  }

  reset() {
    this.line.clear()
    this.st.fill(0)
    this.hpS = 0
    this.fbS = 0
  }

  process(ins, outs, n) {
    const inL = ins[0]
    const inR = ins.length > 1 ? ins[1] : ins[0]
    const oL = outs[0]
    const oR = outs.length > 1 ? outs[1] : null
    const kT = this.kT
    const kG = this.kG
    const hpG = this.hpG
    const line = this.line
    const tD = this.tD, cD = this.cD, tGL = this.tGL, tGR = this.tGR, cGL = this.cGL, cGR = this.cGR
    const tLp = this.tLp, cLp = this.cLp, st = this.st
    let fbD = this.fbD
    let fb = this.fb
    let fbLp = this.fbLp
    let dry = this.dry
    let wet = this.wet
    let hpS = this.hpS
    let fbS = this.fbS
    for (let i = 0; i < n; i++) {
      let xl = inL[i]
      let xr = inR[i]
      if (!(xl > -1e9 && xl < 1e9)) xl = 0
      if (!(xr > -1e9 && xr < 1e9)) xr = 0
      fbD += (this.tFbD - fbD) * kT
      fb += (this.tFb - fb) * kG
      fbLp += (this.tFbLp - fbLp) * kG
      dry += (this.tDry - dry) * kG
      wet += (this.tWet - wet) * kG
      // send: the mono voice with the lows trimmed
      const m = 0.5 * (xl + xr)
      let v = (m - hpS) * hpG
      let y = v + hpS
      hpS = flush(y + v)
      const send = m - y
      // the whole pattern recirculates once per cycle
      const back = line.read(fbD - 1)
      v = (back - fbS) * fbLp
      y = v + fbS
      fbS = flush(y + v)
      line.write(flush(send + feedbackSat(fb * y)))
      let wl = 0
      let wr = 0
      for (let k = 0; k < MAXT; k++) {
        cD[k] += (tD[k] - cD[k]) * kT
        cGL[k] += (tGL[k] - cGL[k]) * kG
        cGR[k] += (tGR[k] - cGR[k]) * kG
        cLp[k] += (tLp[k] - cLp[k]) * kG
        const gl = cGL[k]
        const gr = cGR[k]
        if (gl < 1e-6 && gr < 1e-6) {
          st[k] = 0
          continue
        }
        const e = line.read(cD[k])
        v = (e - st[k]) * cLp[k]
        y = v + st[k]
        st[k] = flush(y + v)
        wl += y * gl
        wr += y * gr
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
    this.fbD = fbD
    this.fb = fb
    this.fbLp = fbLp
    this.dry = dry
    this.wet = wet
    this.hpS = hpS
    this.fbS = fbS
  }
}

export default {
  id: 'echo.multitap',
  name: 'Rhythm echoes',
  family: 'echo',
  about: 'Several echoes in a rhythm pattern, a gallop, a heartbeat, a bouncing ball, scattered around your head.',
  params: [
    {
      id: 'pattern', name: 'Pattern', type: 'choice', def: 'gallop',
      options: [
        { v: 'even', name: 'Even steps' },
        { v: 'gallop', name: 'Gallop' },
        { v: 'dotted', name: 'Dotted' },
        { v: 'triplets', name: 'Triplets' },
        { v: 'swing', name: 'Swing' },
        { v: 'heartbeat', name: 'Heartbeat' },
        { v: 'bounce', name: 'Bouncing ball' },
        { v: 'slowing', name: 'Slowing down' },
        { v: 'sweep', name: 'Sweeping across' },
        { v: 'scatter', name: 'Scattered' },
      ],
    },
    { id: 'tempo', name: 'Pattern tempo', type: 'number', min: 60, max: 200, step: 1, def: 110, unit: 'bpm', rand: [80, 150] },
    { id: 'spread', name: 'Stereo spread', type: 'number', min: 0, max: 100, step: 1, def: 70, unit: 'percent', rand: [40, 100] },
    { id: 'feedback', name: 'Pattern repeats', type: 'number', min: 0, max: 90, step: 1, def: 15, unit: 'percent', rand: [0, 40] },
    { id: 'damping', name: 'Darker echoes', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [10, 60] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [25, 50] },
  ],
  stereo: 'make',
  warps: false,
  cost: 2,
  tail: (p) => capTail(rawTail(p)),
  process(input, p, ctx) {
    const sr = input.sr
    const k = new MultiKernel(sr, p, ctx && ctx.rng)
    const raw = rawTail(p)
    return runKernel(k, input, capTail(raw), 2, ctx, tailFade(raw))
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p, rng) {
      return new MultiKernel(sr, p, rng)
    },
  },
}
