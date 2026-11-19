// modules/echo/reverse.js - echo.reverse, every echo plays backwards.
//
// Technique: the reverse delay of tape and digital delay pedals. The voice
// is recorded into a delay line; every slice period L a read head starts at
// the newest sample and runs BACKWARDS through what was just said, so the
// delay it reads grows by two samples for every sample of time (it moves
// back one while the writer moves on one). Over a grain of length G it plays
// the last G samples in reverse. Two heads take turns so one grain can fade
// out while the next fades in (raised-cosine crossfades whose overlapping
// halves sum to exactly one; see Roads, "Microsound", 2001, on overlapped
// grains, and Zolzer, ed., "DAFX", 2nd ed. 2011, chapter 6 on time-segment
// processing). The result: each echo is a reversed slice of what you just
// said, swelling in the way speech does when played backwards.
//
// Repeats come from feedback. "All backwards" feeds the line back into
// itself one slice period later, so the same slice is reversed again on the
// next pass and every repeat is backwards. "Backwards, then forwards" feeds
// the reversed output back in, so the next pass flips it again and the
// repeats alternate direction. Feedback passes a low pass (darker repeats).
// The two heads can sit on opposite sides, so slices alternate ears.
//
// The wet path lags by up to one slice (it can only reverse what has been
// said); the dry voice is untouched. The live and offline versions are the
// same per-sample kernel.

import { DelayLine } from '../../core/delay.js'
import { num, clamp, mixGains, repeatsTo, capTail, smoothCoef, onePoleG, feedbackSat, flush, runKernel, tailFade } from './_lib.js'

const MAX_MS = 2000
const DMIN = 2

function fadeFrac(p) {
  return 0.04 + 0.36 * clamp(num(p && p.smooth, 35) / 100, 0, 1)
}

function rawTail(p) {
  const g = mixGains(p && p.mix)
  if (g.wet === 0) return 0
  const L = clamp(num(p && p.length, 500), 100, MAX_MS) / 1000
  const reps = repeatsTo(num(p && p.feedback, 25) / 100)
  return (2 + fadeFrac(p) + reps) * L + 0.05
}

class ReverseKernel {
  constructor(sr, p) {
    this.sr = sr
    this.line = new DelayLine(Math.ceil((2.8 * MAX_MS) / 1000 * sr) + 64)
    this.kT = smoothCoef(0.08, sr)
    this.kG = smoothCoef(0.02, sr)
    this.hpG = onePoleG(80, sr)
    // per head: active, position, grain length, fade length
    this.act = new Uint8Array(2)
    this.pos = new Float64Array(2)
    this.glen = new Float64Array(2)
    this.flen = new Float64Array(2)
    this.reset()
    this.set(p)
    this.snap()
  }

  set(p) {
    const sr = this.sr
    this.tL = Math.max(64, Math.round((clamp(num(p.length, 500), 100, MAX_MS) / 1000) * sr))
    this.tX = Math.max(32, Math.round(this.tL * fadeFrac(p)))
    this.tFb = clamp(num(p.feedback, 25) / 100, 0, 0.9)
    this.alt = p.repeats === 'alternate' ? 1 : 0
    const damp = clamp(num(p.damping, 20) / 100, 0, 1)
    this.tLp = onePoleG(15000 * Math.pow(1000 / 15000, damp), sr)
    const s = clamp(num(p.spread, 40) / 100, 0, 1) * 0.7
    // balance law: centre is unity on both sides
    this.tPL0 = 1
    this.tPR0 = 1 - s
    this.tPL1 = 1 - s
    this.tPR1 = 1
    const g = mixGains(p.mix)
    this.tDry = g.dry
    this.tWet = g.wet
  }

  snap() {
    this.fbD = this.tL
    this.fb = this.tFb
    this.lp = this.tLp
    this.pl0 = this.tPL0
    this.pr0 = this.tPR0
    this.pl1 = this.tPL1
    this.pr1 = this.tPR1
    this.dry = this.tDry
    this.wet = this.tWet
    this.L = this.tL
  }

  reset() {
    this.line.clear()
    this.act.fill(0)
    this.pos.fill(0)
    this.t = 0
    this.head = 1
    this.started = 0
    this.hpS = 0
    this.lpS = 0
    this.yPrev = 0
  }

  _start() {
    const h = this.head === 0 ? 1 : 0
    this.head = h
    this.L = this.tL
    const X = Math.min(this.tX, Math.floor(this.L * 0.45))
    this.act[h] = 1
    this.pos[h] = 0
    this.flen[h] = Math.max(1, X)
    this.glen[h] = this.L + X
    this.t = 0
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
    const act = this.act
    const pos = this.pos
    const glen = this.glen
    const flen = this.flen
    let fbD = this.fbD, fb = this.fb, lp = this.lp
    let pl0 = this.pl0, pr0 = this.pr0, pl1 = this.pl1, pr1 = this.pr1, dry = this.dry, wet = this.wet
    let hpS = this.hpS, lpS = this.lpS, yPrev = this.yPrev
    const alt = this.alt
    for (let i = 0; i < n; i++) {
      if (!this.started) {
        this.started = 1
        this._start()
      } else if (this.t >= this.L) {
        this._start()
      }
      let xl = inL[i]
      let xr = inR[i]
      if (!(xl > -1e9 && xl < 1e9)) xl = 0
      if (!(xr > -1e9 && xr < 1e9)) xr = 0
      fbD += (this.L - fbD) * kT
      fb += (this.tFb - fb) * kG
      lp += (this.tLp - lp) * kG
      pl0 += (this.tPL0 - pl0) * kG
      pr0 += (this.tPR0 - pr0) * kG
      pl1 += (this.tPL1 - pl1) * kG
      pr1 += (this.tPR1 - pr1) * kG
      dry += (this.tDry - dry) * kG
      wet += (this.tWet - wet) * kG
      const m = 0.5 * (xl + xr)
      let v = (m - hpS) * hpG
      let y = v + hpS
      hpS = flush(y + v)
      const send = m - y
      // feedback: the line itself one slice later (all backwards), or the reversed output (alternating)
      const back = alt ? yPrev : line.read(fbD - 1)
      v = (back - lpS) * lp
      y = v + lpS
      lpS = flush(y + v)
      line.write(flush(send + feedbackSat(fb * y)))
      // the two backwards heads
      let w0 = 0
      let w1 = 0
      for (let h = 0; h < 2; h++) {
        if (!act[h]) continue
        const k = pos[h]
        const G = glen[h]
        const X = flen[h]
        let win = 1
        if (k < X) win = 0.5 - 0.5 * Math.cos((Math.PI * k) / X)
        else if (k >= G - X) win = 0.5 + 0.5 * Math.cos((Math.PI * (k - (G - X))) / X)
        const e = line.read(DMIN + 2 * k) * win
        if (h === 0) w0 = e
        else w1 = e
        pos[h] = k + 1
        if (k + 1 >= G) act[h] = 0
      }
      this.t++
      yPrev = w0 + w1
      const yl = dry * xl + wet * (w0 * pl0 + w1 * pl1)
      const yr = dry * xr + wet * (w0 * pr0 + w1 * pr1)
      if (oR) {
        oL[i] = yl
        oR[i] = yr
      } else {
        oL[i] = 0.5 * (yl + yr)
      }
    }
    this.fbD = fbD; this.fb = fb; this.lp = lp
    this.pl0 = pl0; this.pr0 = pr0; this.pl1 = pl1; this.pr1 = pr1; this.dry = dry; this.wet = wet
    this.hpS = hpS; this.lpS = lpS; this.yPrev = yPrev
  }
}

export default {
  id: 'echo.reverse',
  name: 'Reverse echo',
  family: 'echo',
  about: 'Every echo is a backwards slice of what you just said, swelling up behind your voice like a tape played in reverse.',
  params: [
    { id: 'length', name: 'Slice length', type: 'number', min: 100, max: 2000, step: 10, def: 500, unit: 'ms', rand: [250, 900] },
    { id: 'feedback', name: 'Repeats', type: 'number', min: 0, max: 90, step: 1, def: 25, unit: 'percent', rand: [0, 50] },
    {
      id: 'repeats', name: 'Repeats play', type: 'choice', def: 'backward',
      options: [
        { v: 'backward', name: 'All backwards' },
        { v: 'alternate', name: 'Backwards, then forwards' },
      ],
    },
    { id: 'smooth', name: 'Smoothness', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [15, 80] },
    { id: 'damping', name: 'Darker repeats', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [0, 60] },
    { id: 'spread', name: 'Stereo spread', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [0, 90] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [30, 55] },
  ],
  stereo: 'make',
  warps: false,
  cost: 2,
  tail: (p) => capTail(rawTail(p)),
  process(input, p, ctx) {
    const raw = rawTail(p)
    const k = new ReverseKernel(input.sr, p)
    return runKernel(k, input, capTail(raw), 2, ctx, tailFade(raw))
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p) {
      return new ReverseKernel(sr, p)
    },
  },
}
