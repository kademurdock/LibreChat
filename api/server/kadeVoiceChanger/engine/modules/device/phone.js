// modules/device/phone.js - device.phone, Telephone: seven eras of the phone call.
//
// Each era is the chain a call really went through, so they sound clearly
// different from one another:
// - 1920s candlestick: a carbon-button transmitter (compressive, lopsided,
//   with granule "frying" noise that grows with the voice; the carbon
//   microphone's behaviour is described in Fagen (ed.), "A History of
//   Engineering and Science in the Bell System"), a long lossy line and a
//   ringing watch-case receiver, about 400 Hz to 2.6 kHz.
// - 1950s rotary: the classic 300 Hz to 3.4 kHz voice channel of the
//   analog network (ITU-T G.712 telephone band) with a milder carbon mic and
//   the handset receiver's presence peak.
// - 1980s cordless: an analog FM link with a 2:1 compander (the noise
//   "breathes" with the voice), deviation limiting, and static swishes that
//   come more often as the signal weakens.
// - 1990s cell phone: 8 kHz sampling, a coarse speech coder (kit SpecCodec)
//   with noisy top band, bad-frame burbles at low signal, and the 217 Hz
//   radio buzz that early digital handsets induced in nearby audio (the
//   TDMA frame rate of second-generation phones).
// - 2000s flip phone: harder coding with spectral holes (the swirl), phone
//   noise suppression with its musical-noise warble, voice activity gating
//   and an automatic gain control that pumps.
// - Internet call: 16 kHz wideband, mild coding, noise suppression, and
//   robotic hiccups when packets are lost.
// - Speakerphone: the talker across a small room from a conference phone,
//   half-duplex clipping of every first syllable (the echo suppressor lets
//   one side through at a time), pause ducking and a boxy small speaker.
// Line noise, hum, crackle, roughness and signal strength each mean the
// natural thing for the chosen era.

import {
  makeDevice, Bank, butter, Bq, Rand, Crackler, Hum, Compander, Squash, SpecCodec, RateHold, SmallRoom, Swell,
  Edges, BLOCK, SPEECH, taper, frac, db, codecSize, onePoleCoef,
} from './_kit.js'
import { tanh } from '../../core/shape.js'

const ERAS = ['candlestick', 'rotary', 'cordless', 'cellular', 'flip', 'voip', 'speaker']
// Output makeup per era in dB, measured so speech comes out near its input level.
const MAKEUP = [5, 5.5, 5, 4.5, 5, 1.5, 6]

class PhoneCore {
  constructor(sr, p, rng) {
    this.sr = sr
    this.r = new Rand(rng, 'phone-noise')
    this.mic = new Bank(sr, 6)
    this.rx = new Bank(sr, 9)
    this.line = new Bq(sr)
    this.hissF = new Bank(sr, 2)
    this.crk = new Crackler(sr, new Rand(rng, 'phone-crackle'))
    this.hum = new Hum(sr, 60)
    this.codec = new SpecCodec(sr, new Rand(rng, 'phone-codec'))
    this.hold = new RateHold(sr)
    this.room = new SmallRoom(sr, 1.4)
    this.tx = new Compander(sr)
    this.rxp = new Compander(sr)
    this.agc = new Squash(sr)
    this.swish = new Swell(sr, new Rand(rng, 'phone-swish'))
    this.drop = new Swell(sr, new Rand(rng, 'phone-drop'))
    this.swishF = new Bq(sr).hp(900, 0.7)
    this.edges = new Edges()
    this.tmp = new Float32Array(BLOCK)
    this.tmp2 = new Float32Array(BLOCK)
    this.env = 0
    this.envK = onePoleCoef(30, sr)
    this.tdmaPh = 0
    this.dg = 1
    this.muteFrom = -1
    this.muteLeft = 0
    this.latency = codecSize(sr)
    this.set(p)
  }

  set(p) {
    const sr = this.sr
    let era = ERAS.indexOf(p.era)
    if (era < 0) era = 1
    this.era = era
    const rough = frac(p.rough)
    const sig = frac(p.signal)
    const weak = 1 - sig
    const mic = this.mic.allOff()
    const rx = this.rx.allOff()
    this.hissF.allOff()
    let i = 0
    let j = 0
    this.carbon = 0
    this.bias = 0
    this.fry = 0
    this.lineOn = false
    this.lineGain = 1
    this.hissLvl = 0
    this.hissPre = false
    this.humLvl = 0
    this.buzz = 0.3
    this.tdma = 0
    this.crkPost = false
    this.agcOn = false
    this.cordless = false
    this.spk = 0
    this.dropOn = false
    let crkRate = 0
    let crkMax = 0
    let codecOn = false
    switch (era) {
      case 0: // 1920s candlestick
        mic.f[i++].hp(250, 0.7071)
        mic.f[i++].peak(1200, 2, 6)
        mic.f[i++].lp(3000, 0.7071)
        j = butter(rx, 0, 'hp', 480, 4)
        j = butter(rx, j, 'lp', 2600, 4)
        rx.f[j++].peak(1000, 2.5, 8)
        rx.f[j++].peak(2200, 3, 4)
        this.carbon = 3 + 9 * rough
        this.bias = 0.4
        this.fry = taper(p.rough, -20)
        this.lineOn = true
        this.line.lp(2500 - 800 * weak, 0.7071)
        this.lineGain = db(-10 * weak)
        this.hissLvl = taper(p.noise, -18)
        this.hissF.f[0].lp(2200, 0.7071)
        this.humLvl = taper(p.hum, -4)
        this.buzz = 0.6
        crkRate = 2 + 38 * Math.pow(frac(p.crackle), 1.3)
        crkMax = 6
        break
      case 1: // 1950s rotary
        mic.f[i++].hp(200, 0.7071)
        mic.f[i++].peak(1800, 1.2, 3)
        j = butter(rx, 0, 'hp', 300, 4)
        j = butter(rx, j, 'lp', 3400, 6)
        rx.f[j++].peak(1500, 1, 3)
        rx.f[j++].peak(2800, 2, 4)
        this.carbon = 1 + 2.5 * rough
        this.bias = 0.2
        this.fry = taper(p.rough, -30)
        this.lineOn = true
        this.line.lp(3400 - 1300 * weak, 0.7071)
        this.lineGain = db(-9 * weak)
        this.hissLvl = taper(p.noise, -24)
        this.hissF.f[0].lp(3000, 0.7071)
        this.humLvl = taper(p.hum, -8)
        this.buzz = 0.45
        crkRate = 1 + 20 * Math.pow(frac(p.crackle), 1.3)
        crkMax = 2
        break
      case 2: // 1980s cordless
        j = butter(mic, 0, 'hp', 200, 2)
        j = butter(mic, j, 'lp', 4000, 4)
        j = butter(rx, 0, 'hp', 300, 4)
        j = butter(rx, j, 'lp', 3000, 6)
        rx.f[j++].peak(1800, 1.2, 3)
        this.cordless = true
        this.tx.set(2, SPEECH, 3, 40, 24, 1)
        this.rxp.set(1.6 + 0.8 * rough, SPEECH * 0.7, 9, 22, 24, -1)
        this.dev = 1.4 + 2 * rough
        this.hissLvl = taper(p.noise, -16) * (1 + 2.5 * weak)
        this.hissF.f[0].hp(1200, 0.7071)
        this.swish.set(0.04 + 0.7 * Math.pow(weak, 1.4), 40, 160, 220, 0.7, 0.4)
        this.humLvl = taper(p.hum, -14)
        this.buzz = 0.3
        crkRate = 1 + 18 * Math.pow(frac(p.crackle), 1.3)
        crkMax = 0
        break
      case 3: // 1990s cell
        j = butter(mic, 0, 'hp', 150, 2)
        j = butter(mic, j, 'lp', 3600, 8)
        j = butter(rx, 0, 'hp', 300, 4)
        j = butter(rx, j, 'lp', 3400, 8)
        rx.f[j++].peak(2000, 1, 3)
        rx.f[j++].peak(600, 1, -2)
        this.hold.set(8000, 2, 13, 1)
        codecOn = true
        this.codec.set(true, 3400, 0.3 + 0.5 * rough, 0.05 + 0.13 * rough, 2900 - 900 * rough, 0, 14 * Math.pow(weak, 1.5), 0, 0.3 + 0.3 * rough)
        this.dropOn = true
        this.drop.set(0.4 * weak * weak, 5, 220, 30, 0.7, 1)
        this.hissLvl = taper(p.noise, -30)
        this.hissPre = true
        this.hissF.f[0].lp(3000, 0.7071)
        this.tdma = taper(p.hum, -20)
        this.crkPost = true
        crkRate = 0.5 + 12 * Math.pow(frac(p.crackle), 1.5)
        crkMax = 0
        break
      case 4: // 2000s flip
        j = butter(mic, 0, 'hp', 200, 2)
        j = butter(mic, j, 'lp', 3600, 8)
        j = butter(rx, 0, 'hp', 400, 4)
        j = butter(rx, j, 'lp', 3400, 8)
        rx.f[j++].peak(1500, 1, 4)
        rx.f[j++].peak(3000, 2, 3)
        this.agcOn = true
        this.agc.set(-27, 3, 2, 180, 4, 8)
        this.hold.set(8000, 2, 13, 1)
        codecOn = true
        this.codec.set(true, 3400, 0.5 + 0.45 * rough, 0.13 + 0.22 * rough, 2500 - 600 * rough, 0.55 + 0.35 * rough, 12 * Math.pow(weak, 1.5), 0.6, 0.2 + 0.25 * rough)
        this.dropOn = true
        this.drop.set(0.35 * weak * weak, 5, 200, 30, 0.7, 1)
        this.hissLvl = taper(p.noise, -24)
        this.hissPre = true
        this.hissF.f[0].lp(3200, 0.7071)
        this.tdma = taper(p.hum, -22)
        this.crkPost = true
        crkRate = 0.5 + 10 * Math.pow(frac(p.crackle), 1.5)
        crkMax = -2
        break
      case 5: // internet call
        mic.f[i++].hp(80, 0.7071)
        butter(mic, i, 'lp', 7200, 8)
        j = butter(rx, 0, 'hp', 120, 2)
        j = butter(rx, j, 'lp', 7000, 6)
        rx.f[j++].peak(3000, 1, 2)
        rx.f[j++].peak(250, 1, -2)
        this.hold.set(16000, 0, 16, 1)
        codecOn = true
        this.codec.set(true, 7000, 0.08 + 0.32 * rough, 0.02 + 0.1 * rough, 6200 - 1800 * rough, 0.45, 7 * Math.pow(weak, 1.5), 0.25, 0.05 + 0.15 * rough)
        this.hissLvl = taper(p.noise, -38)
        this.hissPre = true
        this.hissF.f[0].lp(6000, 0.7071)
        this.humLvl = taper(p.hum, -24)
        this.buzz = 0.75
        this.crkPost = true
        crkRate = 0.3 + 6 * Math.pow(frac(p.crackle), 1.5)
        crkMax = -6
        break
      default: // speakerphone
        j = butter(mic, 0, 'hp', 150, 2)
        j = butter(mic, j, 'lp', 3600, 6)
        j = butter(rx, 0, 'hp', 350, 4)
        j = butter(rx, j, 'lp', 3300, 6)
        rx.f[j++].peak(900, 1.5, 4)
        rx.f[j++].peak(2500, 2, 3)
        this.roomWet = 0.3 + 0.45 * weak
        this.room.set(0.35, 0.5, 0.45)
        this.agcOn = true
        this.agc.set(-27, 2.5, 5, 220, 3, 8)
        this.spk = 1 + 3 * rough
        this.hissLvl = taper(p.noise, -30)
        this.hissF.f[0].lp(3000, 0.7071)
        this.humLvl = taper(p.hum, -14)
        this.buzz = 0.4
        crkRate = 0.5 + 12 * Math.pow(frac(p.crackle), 1.3)
        crkMax = 0
        break
    }
    if (!codecOn) {
      this.hold.set(sr, 0, 16, 1)
      this.codec.set(false, 3400, 0, 0, 0, 0, 0, 0)
    }
    this.crkLvl = crkRate > 0 ? taper(p.crackle, crkMax) : 0
    this.crk.set(crkRate * (p.crackle > 0 ? 1 : 0), this.crkPost ? 0 : crkRate * 0.03, this.crkPost ? 0.05 : 0.03, this.crkPost ? 0.4 : 1.5, this.crkPost ? 0.8 : 0.45)
    this.makeup = db(MAKEUP[era])
  }

  onRise(i) {
    if (this.era === 6) {
      this.muteFrom = i
      this.muteLeft = Math.round(0.085 * this.sr)
    }
  }

  onFall() {}

  run(s, n, talk) {
    const era = this.era
    const r = this.r
    const tmp = this.tmp
    const tmp2 = this.tmp2
    if (era === 6) {
      if (talk) this.edges.scan(talk, n, this)
      this.room.run(s, n, this.roomWet, 1 - 0.4 * this.roomWet)
    }
    this.mic.run(s, n)
    if (era === 6) {
      // half-duplex: the first syllable is clipped, pauses are ducked
      let g = this.dg
      const kd = 1 - Math.exp(-1 / (0.004 * this.sr))
      const ku = 1 - Math.exp(-1 / (0.02 * this.sr))
      const kr = 1 - Math.exp(-1 / (0.15 * this.sr))
      for (let k = 0; k < n; k++) {
        let target = !talk || talk[k] ? 1 : 0.3
        if (this.muteLeft > 0 && k >= this.muteFrom) {
          target = 0
          this.muteLeft--
        }
        g += (target - g) * (target < g ? (target === 0 ? kd : kr) : ku)
        s[k] *= g
      }
      this.dg = g
      this.muteFrom = 0
    }
    if (this.carbon > 0) {
      // carbon button: compressive and lopsided, with frying noise
      const k = this.carbon
      const b = this.bias
      const tb = Math.tanh(b)
      const norm = 1 / (k * (1 - tb * tb))
      const fry = this.fry * 1.7
      const ek = this.envK
      let env = this.env
      for (let q = 0; q < n; q++) {
        const x = s[q]
        const ax = x < 0 ? -x : x
        env += (ax - env) * ek
        s[q] = (tanh(k * x + b) - tb) * norm + fry * r.w() * (0.15 + env * 30)
      }
      this.env = env < 1e-12 ? 0 : env
    }
    if (this.agcOn) this.agc.run(s, n)
    if (this.dropOn) {
      this.drop.render(tmp, n)
      for (let q = 0; q < n; q++) s[q] *= 1 - tmp[q]
    }
    if (this.hissPre && this.hissLvl > 0) {
      r.fill(tmp, n)
      this.hissF.run(tmp, n)
      const g = this.hissLvl * 2
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
    }
    this.hold.run(s, n)
    this.codec.run(s, n)
    if (this.cordless) {
      this.tx.run(s, n)
      // FM deviation limiting
      const d = this.dev
      for (let q = 0; q < n; q++) s[q] = Math.tanh(s[q] * d) / d
      this.swish.render(tmp2, n)
      r.fill(tmp, n)
      this.hissF.run(tmp, n)
      const hg = this.hissLvl * 2.2
      for (let q = 0; q < n; q++) {
        const e = tmp2[q]
        s[q] = s[q] * (1 - 0.75 * e) + tmp[q] * (hg + SPEECH * 0.5 * e)
      }
      this.rxp.run(s, n)
    }
    if (this.lineOn) {
      this.line.run(s, n)
      const lg = this.lineGain
      if (this.hissLvl > 0) {
        r.fill(tmp, n)
        this.hissF.run(tmp, n)
        const g = this.hissLvl * 2.4
        for (let q = 0; q < n; q++) s[q] = s[q] * lg + tmp[q] * g
      } else if (lg !== 1) for (let q = 0; q < n; q++) s[q] *= lg
    } else if (!this.hissPre && !this.cordless && this.hissLvl > 0) {
      r.fill(tmp, n)
      this.hissF.run(tmp, n)
      const g = this.hissLvl * 2
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
    }
    if (this.humLvl > 0) {
      this.hum.render(tmp, n, this.buzz)
      const g = this.humLvl
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
    }
    if (this.tdma > 0) {
      // 217 Hz radio burst buzz: 1/8 duty pulses
      let ph = this.tdmaPh
      const inc = 216.7 / this.sr
      const g = this.tdma * 2.6
      for (let q = 0; q < n; q++) {
        ph += inc
        if (ph >= 1) ph -= 1
        s[q] += (ph < 0.125 ? 0.875 : -0.125) * g
      }
      this.tdmaPh = ph
    }
    if (this.crkLvl > 0) {
      this.crk.render(tmp, n)
      const g = this.crkLvl
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
    }
    if (this.spk > 0) {
      // the speakerphone's little amplifier, before its speaker
      const d = this.spk
      for (let q = 0; q < n; q++) s[q] = Math.tanh(s[q] * d * 2) / (d * 2)
    }
    this.rx.run(s, n)
    const mk = this.makeup
    for (let q = 0; q < n; q++) s[q] *= mk
  }

  reset() {
    this.mic.reset()
    this.rx.reset()
    this.line.reset()
    this.hissF.reset()
    this.codec.reset()
    this.hold.reset()
    this.room.reset()
    this.tx.reset()
    this.rxp.reset()
    this.agc.reset()
    this.crk.reset()
    this.swish.reset()
    this.drop.reset()
    this.edges.reset()
    this.env = 0
    this.dg = 1
    this.muteLeft = 0
  }
}

export default makeDevice({
  id: 'device.phone',
  name: 'Telephone',
  about: 'Your voice down a phone line, from a 1920s candlestick phone to a modern internet call or a speakerphone.',
  params: [
    {
      id: 'era', name: 'Phone', type: 'choice', def: 'rotary',
      options: [
        { v: 'candlestick', name: '1920s candlestick phone' },
        { v: 'rotary', name: '1950s rotary desk phone' },
        { v: 'cordless', name: '1980s cordless phone' },
        { v: 'cellular', name: '1990s cell phone' },
        { v: 'flip', name: '2000s flip phone' },
        { v: 'voip', name: 'Internet call' },
        { v: 'speaker', name: 'Speakerphone' },
      ],
    },
    { id: 'noise', name: 'Line noise', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [10, 60] },
    { id: 'hum', name: 'Hum and buzz', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [0, 50] },
    { id: 'crackle', name: 'Crackle', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [0, 50] },
    { id: 'rough', name: 'Roughness', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [20, 75] },
    { id: 'signal', name: 'Signal strength', type: 'number', min: 0, max: 100, step: 1, def: 85, unit: 'percent', rand: [45, 100] },
  ],
  cost: 2,
  talk: { gapMs: 300, leadMs: 0, holdMs: 300 },
  latency: (sr) => codecSize(sr),
  build: (sr, p, rng) => new PhoneCore(sr, p, rng),
})
