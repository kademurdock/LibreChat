// modules/echo/canyon.js - echo.canyon, calling across a canyon.
//
// Technique: two long delay lines, one per rock wall, that feed each other,
// the way a shout bounces between the walls of a gorge. The left wall sits
// at the chosen distance and the right wall further off (how much further
// depends on the place), so the first answer comes from the left, the next
// from the right, then both walls answer together, and the spacing keeps
// alternating long and short like a real canyon instead of ticking like a
// metronome. The delay of each wall is the round trip at the speed of sound,
// 2 d / 343 m/s.
//
// Every trip loses something, as sound does outdoors: the first answer is
// quieter the further away the wall (spherical spreading), the shout loses
// its top on the way (air absorption, ISO 9613-1 in spirit: a low pass that
// falls with distance), each bounce passes a one-pole low pass (rock and air
// eat the highs, so every answer is darker than the last) and three short Schroeder
// allpass diffusers (Schroeder and Logan, JAES 1961), so each answer is a
// little more smeared, as rough rock scatters it. The number of echoes sets
// the loop gain so that the chosen number of answers come back before the
// rest fade under -30 dB.
//
// Changing the distance while it plays glides the walls (a pitch swoop),
// never a click. The live and offline versions are the same per-sample kernel.

import { DelayLine } from '../../core/delay.js'
import { num, clamp, mixGains, repeatsTo, capTail, smoothCoef, onePoleG, feedbackSat, flush, runKernel, tailFade, Allpass } from './_lib.js'

const C = 343
const MAX_M = 600
//               far wall ratio, diffusion, allpass scale
const PLACES = {
  canyon: [1.38, 0.5, 1.0],
  gorge: [1.12, 0.42, 0.6],
  valley: [1.75, 0.6, 1.6],
}
const AP_MS = [4.7, 9.1, 15.3]

function placeKey(p) {
  const k = p && p.place
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(PLACES, k) ? k : 'canyon'
}

function placeOf(p) {
  return PLACES[placeKey(p)]
}

// Loop gain per number of echoes, measured: with these, a short shout at the
// default distance and darkening gives that many separate answers above
// -30 dB (below -30 dB under a voice an answer is lost). One echo is the near
// wall alone, two is both walls once, three and up let the walls bounce.
const LOOP = [0, 0, 0, 0.18, 0.28, 0.3, 0.39, 0.49, 0.53]

function loopGain(count) {
  return LOOP[clamp(Math.round(num(count, 4)), 1, 8)]
}

function rawTail(p) {
  const g = mixGains(p && p.mix)
  if (g.wet === 0) return 0
  const pl = placeOf(p)
  const tA = (2 * clamp(num(p && p.distance, 170), 30, MAX_M)) / C
  const tB = tA * pl[0]
  const reps = repeatsTo(loopGain(p && p.count))
  return Math.max(tA, tB) * (reps + 1) + (3 * AP_MS[2] * pl[2]) / 1000 + 0.1
}

class CanyonKernel {
  constructor(sr, p) {
    this.sr = sr
    const maxA = Math.ceil(((2 * MAX_M) / C) * sr * 1.01) + 16
    this.lineA = new DelayLine(maxA)
    this.lineB = new DelayLine(Math.ceil(maxA * 1.76) + 16)
    const apMax = Math.ceil(((AP_MS[2] * 1.6 * 1.1) / 1000) * sr) + 4
    this.apA = AP_MS.map(() => new Allpass(apMax, 1, 0.5))
    this.apB = AP_MS.map(() => new Allpass(apMax, 1, 0.5))
    this.kT = smoothCoef(0.25, sr)
    this.kG = smoothCoef(0.03, sr)
    this.hpG = onePoleG(140, sr)
    this.place = ''
    this.reset()
    this.set(p)
    this.snap()
  }

  set(p) {
    const sr = this.sr
    const pl = placeOf(p)
    const dist = clamp(num(p.distance, 170), 30, MAX_M)
    this.tDA = Math.max(2, ((2 * dist) / C) * sr)
    this.tDB = this.tDA * pl[0]
    this.tFb = loopGain(p.count)
    const near = 0.8 / (1 + dist / 350)
    this.tGA = near
    // one echo: only the near wall answers
    this.tGB = clamp(Math.round(num(p.count, 4)), 1, 8) >= 2 ? (near * 0.75) / pl[0] : 0
    this.tAir = onePoleG(14000 * Math.exp(-dist / 600), sr)
    const dk = clamp(num(p.darken, 45) / 100, 0, 1)
    this.tLp = onePoleG(15000 * Math.pow(700 / 15000, dk * 0.75), sr)
    this.tDiff = pl[1]
    const key = placeKey(p)
    if (key !== this.place) {
      // allpass lengths are fixed per place (changing them is a small glitch in the smear only)
      this.place = key
      for (let k = 0; k < 3; k++) {
        this.apA[k].setDelay((AP_MS[k] * pl[2] * sr) / 1000)
        this.apB[k].setDelay((AP_MS[k] * pl[2] * 1.09 * sr) / 1000)
      }
    }
    this.tSide = 1 - 0.85 * clamp(num(p.spread, 80) / 100, 0, 1)
    const g = mixGains(p.mix)
    this.tDry = g.dry
    this.tWet = g.wet
  }

  snap() {
    this.dA = this.tDA
    this.dB = this.tDB
    this.fb = this.tFb
    this.gA = this.tGA
    this.gB = this.tGB
    this.air = this.tAir
    this.lp = this.tLp
    this.diff = this.tDiff
    this.side = this.tSide
    this.dry = this.tDry
    this.wet = this.tWet
  }

  reset() {
    this.lineA.clear()
    this.lineB.clear()
    for (const a of this.apA) a.reset()
    for (const a of this.apB) a.reset()
    this.hpS = 0
    this.airS = 0
    this.lpA = 0
    this.lpB = 0
  }

  process(ins, outs, n) {
    const inL = ins[0]
    const inR = ins.length > 1 ? ins[1] : ins[0]
    const oL = outs[0]
    const oR = outs.length > 1 ? outs[1] : null
    const kT = this.kT
    const kG = this.kG
    const hpG = this.hpG
    const lineA = this.lineA
    const lineB = this.lineB
    const a0 = this.apA[0], a1 = this.apA[1], a2 = this.apA[2], b0 = this.apB[0], b1 = this.apB[1], b2 = this.apB[2]
    let dA = this.dA, dB = this.dB, fb = this.fb, gA = this.gA, gB = this.gB, air = this.air
    let lp = this.lp, diff = this.diff, side = this.side, dry = this.dry, wet = this.wet
    let hpS = this.hpS, airS = this.airS, lpA = this.lpA, lpB = this.lpB
    for (let i = 0; i < n; i++) {
      let xl = inL[i]
      let xr = inR[i]
      if (!(xl > -1e9 && xl < 1e9)) xl = 0
      if (!(xr > -1e9 && xr < 1e9)) xr = 0
      dA += (this.tDA - dA) * kT
      dB += (this.tDB - dB) * kT
      fb += (this.tFb - fb) * kG
      gA += (this.tGA - gA) * kG
      gB += (this.tGB - gB) * kG
      air += (this.tAir - air) * kG
      lp += (this.tLp - lp) * kG
      diff += (this.tDiff - diff) * kG
      side += (this.tSide - side) * kG
      dry += (this.tDry - dry) * kG
      wet += (this.tWet - wet) * kG
      // the shout as it leaves: lows trimmed, top lost to the air
      const m = 0.5 * (xl + xr)
      let v = (m - hpS) * hpG
      let y = v + hpS
      hpS = flush(y + v)
      const hs = m - y
      v = (hs - airS) * air
      y = v + airS
      airS = flush(y + v)
      const send = y
      // each wall's answer: darker and more scattered on every bounce
      let eA = lineA.read(dA - 1)
      let eB = lineB.read(dB - 1)
      v = (eA - lpA) * lp
      y = v + lpA
      lpA = flush(y + v)
      eA = y
      v = (eB - lpB) * lp
      y = v + lpB
      lpB = flush(y + v)
      eB = y
      a0.g = diff
      a1.g = diff
      a2.g = diff
      b0.g = diff
      b1.g = diff
      b2.g = diff
      eA = a2.tick(a1.tick(a0.tick(eA)))
      eB = b2.tick(b1.tick(b0.tick(eB)))
      // the walls answer each other
      lineA.write(flush(gA * send + feedbackSat(fb * eB)))
      lineB.write(flush(gB * send + feedbackSat(fb * eA)))
      const wl = eA + side * eB
      const wr = eB + side * eA
      const yl = dry * xl + wet * wl
      const yr = dry * xr + wet * wr
      if (oR) {
        oL[i] = yl
        oR[i] = yr
      } else {
        oL[i] = 0.5 * (yl + yr)
      }
    }
    this.dA = dA; this.dB = dB; this.fb = fb; this.gA = gA; this.gB = gB; this.air = air
    this.lp = lp; this.diff = diff; this.side = side; this.dry = dry; this.wet = wet
    this.hpS = hpS; this.airS = airS; this.lpA = lpA; this.lpB = lpB
  }
}

export default {
  id: 'echo.canyon',
  name: 'Canyon calls',
  family: 'echo',
  about: 'Shout across a canyon and hear the rock walls answer, each answer further away, fainter and darker.',
  params: [
    { id: 'distance', name: 'Cliff distance', type: 'number', min: 30, max: 600, step: 1, def: 170, unit: 'meters', rand: [80, 350] },
    { id: 'count', name: 'Echoes', type: 'number', min: 1, max: 8, step: 1, def: 4, unit: 'count', noun: ['echo', 'echoes'], rand: [2, 6] },
    {
      id: 'place', name: 'Place', type: 'choice', def: 'canyon',
      options: [
        { v: 'canyon', name: 'Canyon with two walls' },
        { v: 'gorge', name: 'Narrow gorge' },
        { v: 'valley', name: 'Wide mountain valley' },
      ],
    },
    { id: 'darken', name: 'Darkening', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [20, 75] },
    { id: 'spread', name: 'Spread', type: 'number', min: 0, max: 100, step: 1, def: 80, unit: 'percent', rand: [50, 100] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [35, 55] },
  ],
  stereo: 'make',
  warps: false,
  cost: 1,
  tail: (p) => capTail(rawTail(p)),
  process(input, p, ctx) {
    const raw = rawTail(p)
    const k = new CanyonKernel(input.sr, p)
    return runKernel(k, input, capTail(raw), 2, ctx, tailFade(raw))
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p) {
      return new CanyonKernel(sr, p)
    },
  },
}
