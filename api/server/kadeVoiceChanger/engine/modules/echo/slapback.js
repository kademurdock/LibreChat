// modules/echo/slapback.js - echo.slapback, one quick slap of an echo.
//
// Technique: a single short tape-style echo (60 to 180 ms), the sound of
// 1950s rock and roll records, where a second tape machine played the vocal
// back a moment later (see Zolzer, ed., "DAFX", 2nd ed. 2011, section 2.2,
// "slapback"). Each character colours the slap the way the real thing did:
// - Warm tape: band limited (120 Hz to 4.5 kHz, 12 dB per octave), a little tape
//   saturation and the faint flutter of a capstan.
// - Clean: a plain digital slap.
// - Small room: the slap off a near hard wall, smeared by Schroeder allpass
//   diffusion (Schroeder and Logan, JAES 1961) and a faint second bounce.
// - Stadium: the slap from the far stands of a big venue: dark, diffuse,
//   and answered again by the stands opposite.
// Stereo spread makes the right slap a little later than the left, so the
// slap opens out around the head; at zero it stays centred. Extra slaps feed
// the slap back for a short flutter of repeats.
//
// The live and offline versions are the same per-sample kernel.

import { DelayLine } from '../../core/delay.js'
import { num, clamp, repeatsTo, capTail, smoothCoef, onePoleG, feedbackSat, tapeSat, flush, runKernel, tailFade, Allpass } from './_lib.js'

const CHAR = {
  //        hp   lp     sat  flutter(ms) diffusion second secondRatio
  tape: [120, 4500, 0.8, 0.12, 0, 0, 1.6],
  clean: [50, 15000, 0, 0, 0, 0, 1.6],
  room: [150, 7500, 0, 0, 0.45, 0.3, 1.9],
  stadium: [220, 2600, 0, 0, 0.62, 0.5, 1.6],
}
const MAX_MS = 300
const SPREAD = 0.07
const AP_MS = [3.1, 5.3, 8.9]

function charOf(p) {
  const k = p && p.character
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(CHAR, k) ? CHAR[k] : CHAR.tape
}

function rawTail(p) {
  const lvl = clamp(num(p && p.level, 55) / 100, 0, 1)
  if (lvl === 0) return 0
  const c = charOf(p)
  const t = (clamp(num(p && p.time, 110), 30, MAX_MS) / 1000) * (1 + SPREAD) + 0.004
  const longest = c[5] > 0 ? t * c[6] : t
  const reps = repeatsTo(num(p && p.feedback, 0) / 100)
  return longest + reps * t + (c[4] > 0 ? 0.06 : 0) + 0.04
}

class SlapKernel {
  constructor(sr, p) {
    this.sr = sr
    const maxSamp = Math.ceil(((MAX_MS * (1 + SPREAD) * 1.9 + 10) / 1000) * sr) + 8
    this.lineL = new DelayLine(maxSamp)
    this.lineR = new DelayLine(maxSamp)
    const apMax = Math.ceil((10 / 1000) * sr) + 2
    this.apL = AP_MS.map((ms) => new Allpass(apMax, (ms / 1000) * sr, 0))
    this.apR = AP_MS.map((ms) => new Allpass(apMax, ((ms * 1.13) / 1000) * sr, 0))
    this.kT = smoothCoef(0.1, sr)
    this.kG = smoothCoef(0.02, sr)
    this.flInc = 7.3 / sr
    this.reset()
    this.set(p)
    this.snap()
  }

  set(p) {
    const sr = this.sr
    const c = charOf(p)
    const spread = clamp(num(p.spread, 20) / 100, 0, 1)
    this.tD = Math.max(1, (clamp(num(p.time, 110), 30, MAX_MS) / 1000) * sr)
    this.tRatio = 1 + SPREAD * spread
    this.tLvl = clamp(num(p.level, 55) / 100, 0, 1)
    this.tFb = clamp(num(p.feedback, 0) / 100, 0, 0.6)
    this.tHp = onePoleG(c[0], sr)
    this.tLp = onePoleG(c[1], sr)
    this.tSat = c[2]
    this.tFl = (c[3] / 1000) * sr
    this.tDiff = c[4]
    this.tSec = c[5]
    this.tSecR = c[6]
    this.tCross = spread
  }

  snap() {
    this.d = this.tD
    this.ratio = this.tRatio
    this.lvl = this.tLvl
    this.fb = this.tFb
    this.hp = this.tHp
    this.lp = this.tLp
    this.sat = this.tSat
    this.fl = this.tFl
    this.diff = this.tDiff
    this.sec = this.tSec
    this.secR = this.tSecR
    this.cross = this.tCross
  }

  reset() {
    this.lineL.clear()
    this.lineR.clear()
    for (const a of this.apL) a.reset()
    for (const a of this.apR) a.reset()
    this.hpL = 0
    this.hpR = 0
    this.lpL = 0
    this.lpR = 0
    this.lpL2 = 0
    this.lpR2 = 0
    this.ph = 0
  }

  process(ins, outs, n) {
    const inL = ins[0]
    const inR = ins.length > 1 ? ins[1] : ins[0]
    const oL = outs[0]
    const oR = outs.length > 1 ? outs[1] : null
    const kT = this.kT
    const kG = this.kG
    const lineL = this.lineL
    const lineR = this.lineR
    const apL = this.apL
    const apR = this.apR
    const TWO_PI = 2 * Math.PI
    let d = this.d, ratio = this.ratio, lvl = this.lvl, fb = this.fb, hp = this.hp, lp = this.lp
    let sat = this.sat, fl = this.fl, diff = this.diff, sec = this.sec, secR = this.secR, cross = this.cross
    let hpL = this.hpL, hpR = this.hpR, lpL = this.lpL, lpR = this.lpR, lpL2 = this.lpL2, lpR2 = this.lpR2, ph = this.ph
    for (let i = 0; i < n; i++) {
      let xl = inL[i]
      let xr = inR[i]
      if (!(xl > -1e9 && xl < 1e9)) xl = 0
      if (!(xr > -1e9 && xr < 1e9)) xr = 0
      d += (this.tD - d) * kT
      ratio += (this.tRatio - ratio) * kT
      secR += (this.tSecR - secR) * kT
      lvl += (this.tLvl - lvl) * kG
      fb += (this.tFb - fb) * kG
      hp += (this.tHp - hp) * kG
      lp += (this.tLp - lp) * kG
      sat += (this.tSat - sat) * kG
      fl += (this.tFl - fl) * kG
      diff += (this.tDiff - diff) * kG
      sec += (this.tSec - sec) * kG
      cross += (this.tCross - cross) * kG
      const w = fl * (1 + Math.sin(TWO_PI * ph))
      ph += this.flInc
      if (ph >= 1) ph -= 1
      const dl = d + w
      const dr = d * ratio + w
      // the slap, plus (for rooms and stadiums) the answer from further away,
      // taken from the other side when the slap is spread
      let sl = lineL.read(dl - 1)
      let srr = lineR.read(dr - 1)
      if (sec > 1e-4) {
        const a2 = lineL.read(dl * secR - 1)
        const b2 = lineR.read(dr * secR - 1)
        sl += sec * ((1 - cross) * a2 + cross * b2)
        srr += sec * ((1 - cross) * b2 + cross * a2)
      }
      // tone: high pass, low pass
      let v = (sl - hpL) * hp
      let y = v + hpL
      hpL = flush(y + v)
      sl -= y
      v = (srr - hpR) * hp
      y = v + hpR
      hpR = flush(y + v)
      srr -= y
      // two one-pole low passes in a row: 12 dB per octave, like tape and distance
      v = (sl - lpL) * lp
      y = v + lpL
      lpL = flush(y + v)
      v = (y - lpL2) * lp
      y = v + lpL2
      lpL2 = flush(y + v)
      sl = y
      v = (srr - lpR) * lp
      y = v + lpR
      lpR = flush(y + v)
      v = (y - lpR2) * lp
      y = v + lpR2
      lpR2 = flush(y + v)
      srr = y
      if (sat > 1e-4) {
        sl += sat * (tapeSat(1.8 * sl) / 1.8 - sl)
        srr += sat * (tapeSat(1.8 * srr) / 1.8 - srr)
      }
      if (diff > 1e-4) {
        let dl2 = sl
        let dr2 = srr
        for (let k = 0; k < 3; k++) {
          apL[k].g = diff
          apR[k].g = diff
          dl2 = apL[k].tick(dl2)
          dr2 = apR[k].tick(dr2)
        }
        sl += (dl2 - sl) * (diff / 0.62 > 1 ? 1 : diff / 0.62)
        srr += (dr2 - srr) * (diff / 0.62 > 1 ? 1 : diff / 0.62)
      } else {
        for (let k = 0; k < 3; k++) {
          apL[k].tick(0)
          apR[k].tick(0)
        }
      }
      lineL.write(flush(xl + feedbackSat(fb * sl)))
      lineR.write(flush(xr + feedbackSat(fb * srr)))
      const yl = xl + lvl * sl
      const yr = xr + lvl * srr
      if (oR) {
        oL[i] = yl
        oR[i] = yr
      } else {
        oL[i] = 0.5 * (yl + yr)
      }
    }
    this.d = d; this.ratio = ratio; this.lvl = lvl; this.fb = fb; this.hp = hp; this.lp = lp
    this.sat = sat; this.fl = fl; this.diff = diff; this.sec = sec; this.secR = secR; this.cross = cross
    this.hpL = hpL; this.hpR = hpR; this.lpL = lpL; this.lpR = lpR; this.lpL2 = lpL2; this.lpR2 = lpR2; this.ph = ph
  }
}

export default {
  id: 'echo.slapback',
  name: 'Slapback',
  family: 'echo',
  about: 'One quick slap of an echo right behind your voice, from an old rock and roll tape machine to the far stands of a stadium.',
  params: [
    { id: 'time', name: 'Slap time', type: 'number', min: 30, max: 300, step: 1, def: 110, unit: 'ms', rand: [70, 170] },
    { id: 'level', name: 'Slap level', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [35, 75] },
    {
      id: 'character', name: 'Character', type: 'choice', def: 'tape',
      options: [
        { v: 'tape', name: 'Warm tape' },
        { v: 'clean', name: 'Clean' },
        { v: 'room', name: 'Small room' },
        { v: 'stadium', name: 'Stadium' },
      ],
    },
    { id: 'feedback', name: 'Extra slaps', type: 'number', min: 0, max: 60, step: 1, def: 0, unit: 'percent', rand: [0, 30] },
    { id: 'spread', name: 'Stereo spread', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [0, 80] },
  ],
  stereo: 'make',
  warps: false,
  cost: 1,
  tail: (p) => capTail(rawTail(p)),
  process(input, p, ctx) {
    const raw = rawTail(p)
    const k = new SlapKernel(input.sr, p)
    return runKernel(k, input, capTail(raw), 2, ctx, tailFade(raw))
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p) {
      return new SlapKernel(sr, p)
    },
  },
}
