// modules/device/toy.js - device.toy, Talking toy.
//
// A voice coming out of a toy:
// - speech chip: the 1980s way, 8 kHz and 4-bit ADPCM (the IMA/DVI coder
//   in the kit), with no proper smoothing filter after it, so a buzzy
//   image rides on top of the gritty voice;
// - cheap sample: a later toy's 8-bit sample player with no anti-alias
//   filter at all, so high sounds fold back down as metallic aliasing;
// - pull-string record: the tiny phonograph inside an old talking doll, a
//   narrow peaky band with surface noise and crackle, its spring running
//   fast at the start of each phrase and slowing down as it unwinds;
// - the speaker: a coin-sized cone in a plastic shell, thin and peaky, and
//   rattling when pushed;
// - battery low: weak batteries slow the clock, so the pitch sags, sags
//   further on loud sounds that draw more current, wavers, and the amp
//   clips sooner. The pitch moves without changing the timing, using a
//   two-tap crossfading delay-line pitch shifter (Zolzer, "DAFX: Digital
//   Audio Effects", delay-line pitch shifting).

import { makeDevice, Ctl, Bank, butter, Bq, Rand, Crackler, RateHold, Edges, BLOCK, SPEECH, frac, db, onePoleCoef } from './_kit.js'
import { DelayLine } from '../../core/delay.js'

const CHIPS = ['chip', 'sample', 'record']
const WIN_MS = 40

/** Two-tap delay-line pitch shifter; ratio 1 is a pure delay of half the window length. */
class Sag {
  constructor(sr) {
    this.W = Math.round(WIN_MS * 0.001 * sr)
    this.dl = new DelayLine(this.W + 8)
    this.d = this.W / 2
  }

  get latency() {
    return Math.round(this.W / 2)
  }

  run(s, n, ratio) {
    const W = this.W
    const dl = this.dl
    let d = this.d
    for (let q = 0; q < n; q++) {
      dl.write(s[q])
      const r = ratio[q]
      if (r < 0.9999 || r > 1.0001) d += 1 - r
      else if (d !== W / 2) {
        // back at normal speed: drift home to the single-tap position, slowly
        let st = (W / 2 - d) * 0.001
        if (st > 0.002) st = 0.002
        else if (st < -0.002) st = -0.002
        d = Math.abs(W / 2 - d) < 0.01 ? W / 2 : d + st
      }
      if (d >= W) d -= W
      else if (d < 0) d += W
      let d2 = d + W / 2
      if (d2 >= W) d2 -= W
      const a = Math.sin((Math.PI * d) / W)
      const w1 = a * a
      s[q] = dl.read(d) * w1 + dl.read(d2) * (1 - w1)
    }
    this.d = d
  }

  reset() {
    this.dl.clear()
    this.d = this.W / 2
  }
}

class ToyCore {
  constructor(sr, p, rng) {
    this.sr = sr
    this.r = new Rand(rng, 'toy-noise')
    this.pre = new Bank(sr, 6)
    this.hold = new RateHold(sr)
    this.post = new Bank(sr, 2)
    this.spk = new Bank(sr, 8)
    this.sag = new Sag(sr)
    this.rattleF = new Bq(sr).hp(1500, 0.7071)
    this.crk = new Crackler(sr, new Rand(rng, 'toy-crackle'))
    this.surfF = new Bq(sr).hp(800, 0.7071)
    this.wav = new Ctl(sr, { shape: 'smooth', rate: 0.6, rng: rng.fork('toy-waver') })
    this.edges = new Edges()
    this.ratio = new Float32Array(BLOCK)
    this.tmp = new Float32Array(BLOCK)
    this.env = 0
    this.envK = onePoleCoef(6, sr)
    this.spring = 0
    this.latency = this.sag.latency
    this.set(p)
  }

  set(p) {
    let c = CHIPS.indexOf(p.chip)
    if (c < 0) c = 0
    this.chip = c
    const cr = frac(p.crunch)
    const pre = this.pre.allOff()
    const post = this.post.allOff()
    let j
    if (c === 0) {
      j = butter(pre, 0, 'hp', 200, 2)
      butter(pre, j, 'lp', 3600, 8)
      this.hold.set(8000 - 2500 * cr, 3, 4, 0.7 + 2.3 * cr)
      post.f[0].lp(5200, 0.7071)
    } else if (c === 1) {
      pre.f[0].hp(150, 0.7071)
      this.hold.set(11025 - 5000 * cr, 2, 8 - 2 * cr, 1 + cr)
      post.f[0].lp(9000, 0.7071)
    } else {
      j = butter(pre, 0, 'hp', 450, 4)
      j = butter(pre, j, 'lp', 3200, 4)
      pre.f[j++].peak(1100, 2, 5)
      pre.f[j++].peak(2300, 2.5, 4)
      this.hold.set(this.sr, 0, 16, 1)
    }
    const sp = frac(p.speaker)
    const spk = this.spk.allOff()
    j = butter(spk, 0, 'hp', 280 + 520 * sp, 4)
    j = butter(spk, j, 'lp', 5600 - 1400 * sp, 4)
    spk.f[j++].peak(1500, 1.5, 2 + 5 * sp)
    spk.f[j++].peak(3000, 2, 1 + 4 * sp)
    this.rattle = frac(p.rattle)
    this.bat = frac(p.battery)
    this.clipL = 0.9 - 0.55 * this.bat
    this.batGain = db(-4 * this.bat)
    if (c === 2) {
      this.crk.set(25 + 40 * cr, 0.6, 0.03, 0.8, 0.5)
      this.crkLvl = SPEECH * 0.25
      this.surfLvl = SPEECH * 0.05 * (0.5 + cr)
    } else {
      this.crk.set(0, 0)
      this.crkLvl = 0
      this.surfLvl = 0
    }
    this.makeup = db(c === 2 ? 7 : 5)
  }

  onRise() {
    // pull the string: the record starts fast
    if (this.chip === 2) this.spring = 1
  }

  onFall() {}

  run(s, n, talk) {
    const r = this.r
    const ratio = this.ratio
    const tmp = this.tmp
    if (talk) this.edges.scan(talk, n, this)
    this.pre.run(s, n)
    if (this.chip === 2) {
      r.fill(tmp, n)
      this.surfF.run(tmp, n)
      const g = this.surfLvl * 2
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
      this.crk.render(tmp, n)
      const cg = this.crkLvl
      for (let q = 0; q < n; q++) s[q] += tmp[q] * cg
    }
    this.hold.run(s, n)
    this.post.run(s, n)
    // pitch: battery sag (deeper on loud sounds), waver, the record's spring
    const bat = this.bat
    let env = this.env
    const ek = this.envK
    let sp = this.spring
    const spDecay = Math.exp(-1 / (2.5 * this.sr))
    const rec = this.chip === 2
    for (let q = 0; q < n; q++) {
      const x = s[q]
      env += ((x < 0 ? -x : x) - env) * ek
      let semi = 0
      if (bat > 0) {
        const load = Math.min(1.5, env * 12)
        semi -= bat * (3.2 + 1.8 * load) + bat * 0.5 * this.wav.next()
      }
      if (rec) {
        semi += 0.9 * sp - 1.4 * (1 - sp) * (0.3 + bat)
        sp *= spDecay
      }
      ratio[q] = Math.pow(2, semi / 12)
    }
    this.env = env < 1e-9 ? 0 : env
    this.spring = sp
    this.sag.run(s, n, ratio)
    // weak battery: the amp clips sooner and gets quieter
    const L = this.clipL
    const bg = this.batGain
    for (let q = 0; q < n; q++) s[q] = L * Math.tanh(s[q] / L) * bg
    // speaker rattle on the loud bits
    if (this.rattle > 0) {
      const t = 0.12
      for (let q = 0; q < n; q++) {
        const a = s[q] < 0 ? -s[q] : s[q]
        tmp[q] = a > t ? (a - t) * r.w() * 3 * this.rattle : 0
      }
      this.rattleF.run(tmp, n)
      for (let q = 0; q < n; q++) s[q] += tmp[q]
    }
    const mk = this.makeup / 0.85
    for (let q = 0; q < n; q++) s[q] = 0.85 * Math.tanh(s[q] * mk)
    this.spk.run(s, n)
  }

  reset() {
    this.pre.reset()
    this.hold.reset()
    this.post.reset()
    this.spk.reset()
    this.sag.reset()
    this.rattleF.reset()
    this.crk.reset()
    this.surfF.reset()
    this.edges.reset()
    this.env = 0
    this.spring = 0
  }
}

export default makeDevice({
  id: 'device.toy',
  name: 'Talking toy',
  about: 'Your voice coming out of a talking toy: a gritty speech chip, a cheap sample, or a pull-string record, maybe with dying batteries.',
  params: [
    {
      id: 'chip', name: 'Inside the toy', type: 'choice', def: 'chip',
      options: [
        { v: 'chip', name: 'Speech chip' },
        { v: 'sample', name: 'Cheap sample' },
        { v: 'record', name: 'Pull-string record' },
      ],
    },
    { id: 'speaker', name: 'Tiny speaker', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [30, 90] },
    { id: 'battery', name: 'Battery low', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 70] },
    { id: 'crunch', name: 'Crunch', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
    { id: 'rattle', name: 'Speaker rattle', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [0, 60] },
  ],
  cost: 2,
  talk: { gapMs: 600, leadMs: 0, holdMs: 500 },
  latency: (sr) => Math.round(Math.round(WIN_MS * 0.001 * sr) / 2),
  build: (sr, p, rng) => new ToyCore(sr, p, rng),
})
