// modules/device/tincan.js - device.tincan, Tin-can string phone.
//
// Two cans and a taut string:
// - the talking can: its bottom is a stiff little drum, so only the band
//   its modes can move gets into the string, with sharp metallic peaks (the
//   tin-can modes of core/ir.js: about 1.4, 2.0, 2.9 and 4.7 kHz for a
//   soup can; a big coffee can sits lower; paper cups are softer and
//   papery);
// - the string: vibration runs down it and part of it bounces back and
//   forth between the cans, so each word gets a springy, zinging echo
//   whose spacing is the round trip along the string (length / wave
//   speed), smeared by dispersion (a feedback delay with a chain of
//   allpass sections, after the spring reverb model of Valimaki, Parker
//   and Abel 2010) and dulled by the string's losses; a slack string passes
//   much less and much duller;
// - the listening can rings again on the way out.

import { makeDevice, Bank, butter, Bq, Rand, BLOCK, frac, db } from './_kit.js'
import { DelayLine } from '../../core/delay.js'

const CANS = ['soup', 'coffee', 'cup']
// [modes [hz, q, db]...], hp, lp
const CAN = [
  [[[1430, 12, 8], [2010, 15, 8], [2860, 18, 6], [4700, 10, 4]], 450, 6000],
  [[[900, 8, 7], [1350, 10, 6], [2100, 12, 5], [3300, 10, 4]], 350, 5000],
  [[[1200, 1.5, 5], [2500, 2, 4], [3600, 2, 2]], 500, 3800],
]
const WAVE = 420 // m/s along the string
const MAX_LEN = 30

function setCan(bank, C, scale) {
  bank.allOff()
  let j = butter(bank, 0, 'hp', C[1], 4)
  bank.f[j++].lp(C[2], 0.7071)
  const modes = C[0]
  for (let k = 0; k < modes.length; k++) bank.f[j++].peak(modes[k][0], modes[k][1], modes[k][2] * scale)
}

class TinCore {
  constructor(sr, p, rng) {
    this.sr = sr
    this.r = new Rand(rng, 'tin-noise')
    this.canA = new Bank(sr, 8)
    this.canB = new Bank(sr, 8)
    this.str = new Bank(sr, 2)
    this.dl = new DelayLine(Math.ceil(((2 * MAX_LEN) / WAVE) * sr) + 16)
    this.ap = [new Bq(sr), new Bq(sr), new Bq(sr), new Bq(sr), new Bq(sr), new Bq(sr)]
    this.loopLp = new Bq(sr)
    this.loopHp = new Bq(sr).hp(300, 0.7071)
    this.tmp = new Float32Array(BLOCK)
    this.latency = 0
    this.set(p)
  }

  set(p) {
    let c = CANS.indexOf(p.can)
    if (c < 0) c = 0
    this.can = c
    const C = CAN[c]
    const ring = frac(p.ring)
    const ten = frac(p.tension)
    setCan(this.canA, C, 0.7 + 0.3 * ring)
    setCan(this.canB, C, 0.3 + 1.0 * ring)
    this.str.allOff()
    this.str.f[0].lp(1100 + 3400 * ten, 0.7071)
    this.str.f[1].lp(1600 + 4500 * ten, 0.7071)
    this.strG = db(-14 * (1 - ten))
    this.len = Math.max(1, Math.min(MAX_LEN, p.length))
    this.D = ((2 * this.len) / WAVE) * this.sr
    const z = frac(p.zing)
    this.fb = (0.25 + 0.55 * z) * (0.6 + 0.4 * ten) * Math.max(0.6, 1 - this.len / 120)
    this.zMix = 0.15 + 0.55 * z
    for (let k = 0; k < this.ap.length; k++) this.ap[k].ap(900 + 500 * k, 0.6)
    this.loopLp.lp(2500 + 2500 * ten, 0.7071)
    this.paper = c === 2
    this.makeup = db(c === 2 ? 8 : 5)
  }

  run(s, n) {
    const tmp = this.tmp
    this.canA.run(s, n)
    // the string: a little slap on loud words, its losses, and its echoes
    for (let q = 0; q < n; q++) s[q] = Math.tanh(s[q] * 2.5) / 2.5
    if (this.paper) {
      const r = this.r
      for (let q = 0; q < n; q++) {
        const x = s[q]
        const a = x < 0 ? -x : x
        s[q] = x + (a > 0.12 ? r.w() * (a - 0.12) * 0.5 : 0)
      }
    }
    this.str.run(s, n)
    const g = this.strG
    const dl = this.dl
    const D = this.D
    const fb = this.fb
    const zm = this.zMix
    for (let q = 0; q < n; q++) {
      const x = s[q] * g
      let e = dl.read(D)
      for (let k = 0; k < 6; k++) e = this.ap[k].tick(e)
      e = this.loopHp.tick(this.loopLp.tick(e))
      dl.write(x + e * fb)
      tmp[q] = e
      s[q] = x + e * zm
    }
    this.canB.run(s, n)
    const mk = this.makeup
    for (let q = 0; q < n; q++) s[q] *= mk
  }

  reset() {
    this.canA.reset()
    this.canB.reset()
    this.str.reset()
    this.dl.clear()
    for (const a of this.ap) a.reset()
    this.loopLp.reset()
    this.loopHp.reset()
  }
}

export default makeDevice({
  id: 'device.tincan',
  name: 'Tin-can phone',
  about: 'Talking through two cans and a string: thin, metallic and ringing, with a springy zing running down the line.',
  params: [
    {
      id: 'can', name: 'Cans', type: 'choice', def: 'soup',
      options: [
        { v: 'soup', name: 'Soup cans' },
        { v: 'coffee', name: 'Big coffee cans' },
        { v: 'cup', name: 'Paper cups' },
      ],
    },
    { id: 'length', name: 'String length', type: 'number', min: 2, max: 30, step: 1, def: 8, unit: 'meters', rand: [3, 20] },
    { id: 'tension', name: 'String tightness', type: 'number', min: 0, max: 100, step: 1, def: 70, unit: 'percent', rand: [40, 100] },
    { id: 'ring', name: 'Can ring', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'zing', name: 'String zing', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 80] },
  ],
  cost: 2,
  tail: () => 0.5,
  talk: null,
  latency: () => 0,
  build: (sr, p, rng) => new TinCore(sr, p, rng),
})
