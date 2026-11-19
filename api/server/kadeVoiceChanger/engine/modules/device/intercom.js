// modules/device/intercom.js - device.intercom, Intercom and drive-through.
//
// A small speaker in a box at the end of a cheap line:
// - the talk button: a relay clunk when the line opens and when it closes,
//   with the line's hiss and buzz only there while it is open;
// - an overdriven little amplifier (lopsided clipping) and mains buzz on
//   the line (the rectifier buzz of the kit Hum);
// - the box: a bank of narrow resonances that rings with the voice,
//   strongest in the weatherproof metal door box, plus the speaker's
//   narrow band;
// - four places: an apartment door box, a drive-through order speaker
//   (crushed by heavy compression), an office desk intercom, and a
//   classroom wall speaker with the classroom's own echo around it.

import { makeDevice, Bank, butter, Bq, Rand, Crackler, Hum, Squash, SmallRoom, Edges, Burst, BLOCK, SPEECH, taper, frac, db, onePoleCoef } from './_kit.js'

const STYLES = ['door', 'drive', 'office', 'school']
// [hp, lp, res1, q1, res2, q2, res3, q3, compress ratio, drive base, makeup]
const SPEC = [
  [520, 3000, 1100, 7, 2300, 9, 3400, 10, 4, 2.5, 7],
  [420, 3500, 1800, 4, 3000, 5, 900, 3, 10, 2, 6],
  [300, 4000, 900, 4, 2000, 5, 2900, 6, 3, 1.2, 5],
  [250, 4500, 700, 3, 1600, 4, 2600, 5, 3, 1.4, 5],
]
// The relay clunk's level against speech (about the height of a loud
// syllable: any louder and the clunk alone decides the take's peak, so the
// final limiter has to pull the whole take down for it).
const CLUNK = 2.5

class IntercomCore {
  constructor(sr, p, rng) {
    this.sr = sr
    this.r = new Rand(rng, 'icom-noise')
    this.mic = new Bank(sr, 4)
    this.spk = new Bank(sr, 6)
    this.res = [new Bq(sr), new Bq(sr), new Bq(sr)]
    this.resG = new Float64Array(3)
    this.comp = new Squash(sr)
    this.hum = new Hum(sr, 60)
    this.crk = new Crackler(sr, new Rand(rng, 'icom-crackle'))
    this.room = new SmallRoom(sr, 2)
    this.edges = new Edges()
    this.clunk = new Burst(sr, new Rand(rng, 'icom-clunk')).color(300, 2500)
    this.clunk2 = new Burst(sr, new Rand(rng, 'icom-clunk2')).color(300, 2500)
    this.hissF = new Bq(sr).hp(800, 0.7071)
    this.tmp = new Float32Array(BLOCK)
    this.tmp2 = new Float32Array(BLOCK)
    this.line = 0
    this.lineT = 0
    this.closeAt = -1
    this.latency = 0
    this.set(p)
  }

  set(p) {
    let st = STYLES.indexOf(p.style)
    if (st < 0) st = 0
    this.style = st
    const S = SPEC[st]
    const mic = this.mic.allOff()
    mic.f[0].hp(200, 0.7071)
    butter(mic, 1, 'lp', 5000, 4)
    const spk = this.spk.allOff()
    let j = butter(spk, 0, 'hp', S[0], 4)
    butter(spk, j, 'lp', S[1], 4)
    const box = frac(p.box)
    for (let k = 0; k < 3; k++) {
      this.res[k].bp(S[2 + 2 * k], S[3 + 2 * k])
      this.resG[k] = box * (k === 0 ? 2.2 : k === 1 ? 1.6 : 1.0) * (st === 0 ? 1.4 : 1)
    }
    this.comp.set(-32, S[8], 2, 120, st === 1 ? 12 : 8, 6)
    const ds = frac(p.distortion)
    this.drive = S[9] * (0.4 + 2.2 * ds)
    this.humLvl = taper(p.buzz, st === 0 ? -8 : -12)
    this.hissLvl = taper(p.noise, st === 1 ? -18 : -22)
    this.crk.set(st === 1 ? 12 : 4, 0, 0.03, 0.5, 0.5)
    this.crkLvl = this.hissLvl * (st === 1 ? 6 : 3)
    this.clicks = !!p.clicks
    this.school = st === 3
    this.room.set(0.7, 0.9, 0.35)
    this.makeup = db(S[10])
  }

  onRise(i) {
    this.lineT = 1
    this.closeAt = -1
    if (this.clicks) {
      this.clunk.trigger(i, 0.5, 4, 14, SPEECH * CLUNK, 0.1)
      this.clunk2.trigger(i + Math.round(0.012 * this.sr), 0.3, 2, 8, SPEECH * CLUNK * 0.5, 0.1)
    }
  }

  onFall(i) {
    const delay = Math.round(0.12 * this.sr)
    this.closeAt = i + delay
    if (this.clicks) this.clunk.trigger(i + delay, 0.5, 3, 10, SPEECH * CLUNK * 0.7, 0.1)
  }

  run(s, n, talk) {
    const r = this.r
    const tmp = this.tmp
    const tmp2 = this.tmp2
    if (talk) this.edges.scan(talk, n, this)
    else this.lineT = 1
    this.mic.run(s, n)
    this.comp.run(s, n)
    // the little amplifier: lopsided clipping
    const d = this.drive
    for (let q = 0; q < n; q++) {
      const v = s[q] * d
      s[q] = (v > 0 ? Math.tanh(v) : Math.tanh(v * 1.3) / 1.3) / d
    }
    // the box rings
    for (let k = 0; k < 3; k++) {
      const g = this.resG[k]
      if (g <= 0) continue
      for (let q = 0; q < n; q++) tmp[q] = s[q]
      this.res[k].run(tmp, n)
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
    }
    // line: hiss, buzz and crackle while it is open
    let ln = this.line
    let lt = this.lineT
    let ca = this.closeAt
    const kl = onePoleCoef(150, this.sr)
    r.fill(tmp, n)
    this.hissF.run(tmp, n)
    this.hum.render(tmp2, n, 0.75)
    const hl = this.hissLvl * 2.4
    const bl = this.humLvl
    for (let q = 0; q < n; q++) {
      if (ca >= 0) {
        if (ca === 0) {
          lt = 0
          ca = -1
        } else ca--
      }
      ln += (lt - ln) * kl
      s[q] = (s[q] + tmp[q] * hl + tmp2[q] * bl) * ln
    }
    this.line = ln < 1e-6 ? 0 : ln
    this.lineT = lt
    this.closeAt = ca
    if (this.crkLvl > 0) {
      this.crk.render(tmp, n)
      const g = this.crkLvl * this.line
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
    }
    tmp.fill(0, 0, n)
    this.clunk.render(tmp, n)
    this.clunk2.render(tmp, n)
    for (let q = 0; q < n; q++) s[q] += tmp[q]
    const mk = this.makeup / 0.8
    for (let q = 0; q < n; q++) s[q] = 0.8 * Math.tanh(s[q] * mk)
    this.spk.run(s, n)
    if (this.school) this.room.run(s, n, 0.4, 1)
  }

  reset() {
    this.mic.reset()
    this.spk.reset()
    for (let k = 0; k < 3; k++) this.res[k].reset()
    this.comp.reset()
    this.crk.reset()
    this.room.reset()
    this.edges.reset()
    this.clunk.stop()
    this.clunk2.stop()
    this.hissF.reset()
    this.line = 0
    this.lineT = 0
    this.closeAt = -1
  }
}

export default makeDevice({
  id: 'device.intercom',
  name: 'Intercom',
  about: 'A voice from a little speaker box: a door buzzer, a drive-through order speaker, an office intercom or a classroom speaker.',
  params: [
    {
      id: 'style', name: 'Box', type: 'choice', def: 'door',
      options: [
        { v: 'door', name: 'Door buzzer box' },
        { v: 'drive', name: 'Drive-through speaker' },
        { v: 'office', name: 'Office intercom' },
        { v: 'school', name: 'Classroom speaker' },
      ],
    },
    { id: 'buzz', name: 'Buzz', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 60] },
    { id: 'distortion', name: 'Distortion', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [15, 80] },
    { id: 'box', name: 'Box ring', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
    { id: 'clicks', name: 'Button clicks', type: 'bool', def: true },
    { id: 'noise', name: 'Line hiss', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [5, 50] },
  ],
  cost: 2,
  tail: (p) => (p && p.style === 'school' ? 1.2 : 0.4),
  talk: { gapMs: 700, leadMs: 60, holdMs: 600 },
  latency: () => 0,
  build: (sr, p, rng) => new IntercomCore(sr, p, rng),
})
