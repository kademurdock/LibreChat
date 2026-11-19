// modules/device/radio.js - device.radio, AM radio.
//
// A voice on the medium-wave broadcast band, through a home receiver:
// - the station's own processing: a hard compressor and clipper, the
//   loud, dense sound of AM talk radio;
// - the band: static (hiss, atmospheric crackle and the odd lightning
//   crash), sky-wave fading (a slow fade plus a moving two-path comb, the
//   selective fading of night-time reception), and a heterodyne whistle
//   where two stations' carriers beat;
// - tuning: on the station; slightly off it, where the receiver's IF
//   filter sits on one sideband so the sound turns thin, edgy and
//   distorted (slope detection in an envelope detector, as every radio
//   textbook warns); or between stations, where the voice is faint, the
//   static and whistle take over and another station bleeds in;
// - the receiver's AGC lifts the static whenever the station fades;
// - four sets: a 1930s wooden cabinet (warm, boomy, humming valves), a
//   1950s kitchen table radio, a 1960s pocket transistor (tinny, small
//   speaker) and a car radio (wider, with alternator whine instead of hum).

import { makeDevice, Ctl, Bank, butter, Rand, Crackler, Hum, Squash, Swell, Shift, BLOCK, taper, frac, db } from './_kit.js'
import { DelayLine } from '../../core/delay.js'

const ERAS = ['1930s', '1950s', '1960s', 'car']
const MAKEUP = [3, 3.5, 6, 2]

class RadioCore {
  constructor(sr, p, rng) {
    this.sr = sr
    this.r = new Rand(rng, 'radio-noise')
    this.station = new Squash(sr)
    this.txF = new Bank(sr, 4)
    this.tune = new Bank(sr, 3)
    this.rx = new Bank(sr, 7)
    this.statF = new Bank(sr, 2)
    this.crk = new Crackler(sr, new Rand(rng, 'radio-crackle'))
    this.crash = new Swell(sr, new Rand(rng, 'radio-crash'))
    this.hum = new Hum(sr, 60)
    this.path = new DelayLine(Math.ceil(0.004 * sr) + 8)
    this.other = new DelayLine(Math.ceil(0.7 * sr) + 8)
    this.otherShift = new Shift(sr)
    this.otherShift.set(-230)
    this.otherF = new Bank(sr, 3)
    butter(this.otherF, 0, 'lp', 2600, 4)
    this.otherF.f[2].hp(300, 0.7071)
    this.fadeL = new Ctl(sr, { shape: 'smooth', rate: 0.1, rng: rng.fork('radio-fade') })
    this.combL = new Ctl(sr, { shape: 'smooth', rate: 0.15, rng: rng.fork('radio-comb') })
    this.whL = new Ctl(sr, { shape: 'smooth', rate: 0.2, rng: rng.fork('radio-whistle') })
    this.altL = new Ctl(sr, { shape: 'smooth', rate: 0.15, rng: rng.fork('radio-engine') })
    this.whBase = 900 + 900 * rng.fork('radio-whf').next()
    this.tmp = new Float32Array(BLOCK)
    this.tmp2 = new Float32Array(BLOCK)
    this.fd = new Float32Array(BLOCK)
    this.whPh = 0
    this.altPh = 0
    this.latency = 0
    this.set(p)
  }

  set(p) {
    let era = ERAS.indexOf(p.era)
    if (era < 0) era = 1
    this.era = era
    const tuning = p.tuning === 'off' ? 1 : p.tuning === 'between' ? 2 : 0
    this.tuning = tuning
    // station processing
    this.station.set(-28, 5, 3, 250, 6, 8)
    this.txF.allOff()
    this.txF.f[0].hp(90, 0.7071)
    butter(this.txF, 1, 'lp', 4800, 4)
    // detuned IF: one sideband rolled away
    const tn = this.tune.allOff()
    if (tuning === 1) {
      tn.f[0].hp(550, 0.7071)
      tn.f[1].peak(2300, 1, 7)
      tn.f[2].lp(3600, 0.7071)
    } else if (tuning === 2) {
      tn.f[0].hp(400, 0.7071)
      tn.f[1].peak(1800, 0.8, 4)
    }
    // the set
    const rx = this.rx.allOff()
    let j = 0
    if (era === 0) {
      j = butter(rx, 0, 'hp', 110, 2)
      j = butter(rx, j, 'lp', 3500, 4)
      rx.f[j++].peak(240, 1, 4)
      rx.f[j++].peak(1500, 1.2, 2)
    } else if (era === 1) {
      j = butter(rx, 0, 'hp', 200, 2)
      j = butter(rx, j, 'lp', 4000, 4)
      rx.f[j++].peak(1000, 1, 3)
      rx.f[j++].peak(2500, 1.5, 2)
    } else if (era === 2) {
      j = butter(rx, 0, 'hp', 450, 4)
      j = butter(rx, j, 'lp', 3800, 4)
      rx.f[j++].peak(1600, 1.2, 6)
    } else {
      j = butter(rx, 0, 'hp', 140, 2)
      j = butter(rx, j, 'lp', 5000, 4)
      rx.f[j++].peak(3000, 1.5, 2)
      rx.f[j++].peak(120, 1, 2)
    }
    this.statF.allOff()
    this.statF.f[0].lp(5000, 0.7071)
    this.statF.f[1].hp(200, 0.7071)
    const statMul = tuning === 0 ? 1 : tuning === 1 ? 1.8 : 3.5
    this.statLvl = taper(p.static, -14) * statMul
    const st = frac(p.static)
    this.crk.set((8 + 70 * st) * (tuning === 2 ? 2 : 1), 0.4 * st, 0.03, 1.5, 0.55)
    this.crash.set(st * (tuning === 2 ? 0.35 : 0.12), 15, 60, 260, 0.8, 0.4)
    const fd = frac(p.fading)
    this.fadeDepth = tuning === 2 ? 0.45 + 0.5 * fd : 0.75 * fd
    this.combA = (tuning === 2 ? 0.4 : 0) + 0.55 * fd
    this.fadeL.rate = 0.05 + 0.2 * fd
    this.voiceG = tuning === 0 ? 1 : tuning === 1 ? db(-3) : db(-12)
    this.detune = tuning === 1 ? 1 : 0
    this.otherLvl = tuning === 2 ? 0.22 : 0
    const whMul = tuning === 0 ? 0.6 : tuning === 1 ? 1.2 : 1.6
    this.whLvl = taper(p.whistle, -14, 30) * whMul * 1.41
    this.whSweep = tuning === 2 ? 600 : tuning === 1 ? 60 : 15
    this.whHz = tuning === 1 ? 2900 : this.whBase
    const humMax = era === 0 ? -12 : era === 1 ? -18 : era === 2 ? -34 : -22
    this.humLvl = taper(p.hum, humMax)
    this.altLvl = era === 3 ? taper(p.hum, -24) : 0
    this.warm = era === 0 ? 1.3 : era === 1 ? 1.1 : 0
    this.cross = era === 2 ? 0.006 : 0
    this.makeup = db(MAKEUP[era] + (tuning === 2 ? 4 : 0))
  }

  run(s, n) {
    const r = this.r
    const tmp = this.tmp
    const tmp2 = this.tmp2
    const fdv = this.fd
    this.txF.run(s, n)
    this.station.run(s, n)
    for (let q = 0; q < n; q++) s[q] = Math.tanh(s[q] * 2.2) / 2.2
    // fading and the moving comb (sky wave), the other station
    const fdep = this.fadeDepth
    const ca = this.combA
    const path = this.path
    const other = this.other
    const ol = this.otherLvl
    const vg = this.voiceG
    for (let q = 0; q < n; q++) {
      const x = s[q]
      path.write(x)
      other.write(x)
      const f = 0.5 + 0.5 * this.fadeL.next()
      const fade = 1 - fdep * f * f
      fdv[q] = fade
      const dd = (1.6 + 1.2 * this.combL.next()) * 0.001 * this.sr
      s[q] = (x + ca * path.read(dd)) * fade * vg
      tmp[q] = ol > 0 ? other.read(0.61 * this.sr) : 0
    }
    if (ol > 0) {
      this.otherShift.run(tmp, n)
      this.otherF.run(tmp, n)
      for (let q = 0; q < n; q++) s[q] += tmp[q] * ol * (1.3 - fdv[q])
    }
    // off-station: slope detection distortion
    if (this.detune) {
      for (let q = 0; q < n; q++) {
        const v = s[q] * 3
        s[q] = (Math.tanh(v + 0.35) - 0.3364) / 3
      }
    }
    this.tune.run(s, n)
    // static, crackle, crashes, raised by the AGC when the station fades
    r.fill(tmp, n)
    this.crash.render(tmp2, n)
    const sl = this.statLvl * 3.4
    for (let q = 0; q < n; q++) {
      const agc = 1 + 1.6 * (1 - fdv[q])
      tmp[q] = tmp[q] * sl * agc * (1 + 6 * tmp2[q])
    }
    this.crk.render(tmp2, n)
    const cl = this.statLvl * 5
    for (let q = 0; q < n; q++) tmp[q] += tmp2[q] * cl * (1 + 1.6 * (1 - fdv[q]))
    // heterodyne whistle
    if (this.whLvl > 0) {
      let ph = this.whPh
      const sw = this.whSweep
      const base = this.whHz
      const g = this.whLvl
      for (let q = 0; q < n; q++) {
        const hz = base + sw * this.whL.next()
        ph += hz / this.sr
        if (ph >= 1) ph -= 1
        tmp[q] += Math.sin(6.283185307 * ph) * g
      }
      this.whPh = ph
    }
    this.statF.run(tmp, n)
    for (let q = 0; q < n; q++) s[q] += tmp[q]
    // the set: hum or alternator whine, valve warmth or transistor grit
    if (this.humLvl > 0) {
      this.hum.render(tmp, n, 0.3)
      const g = this.humLvl
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
    }
    if (this.altLvl > 0) {
      let ph = this.altPh
      const g = this.altLvl * 1.2
      for (let q = 0; q < n; q++) {
        const hz = 780 + 140 * this.altL.next()
        ph += hz / this.sr
        if (ph >= 1) ph -= 1
        const a = 6.283185307 * ph
        s[q] += (Math.sin(a) + 0.4 * Math.sin(2 * a) + 0.2 * Math.sin(3 * a)) * g
      }
      this.altPh = ph
    }
    // the set's output stage, then its loudspeaker
    if (this.warm > 0) {
      const k = this.warm * 2
      for (let q = 0; q < n; q++) s[q] = Math.tanh(s[q] * k) / k
    }
    if (this.cross > 0) {
      const c = this.cross
      for (let q = 0; q < n; q++) {
        const v = s[q]
        s[q] = v > c ? v - c * 0.7 : v < -c ? v + c * 0.7 : v * 0.3
      }
    }
    const mk = this.makeup / 0.8
    for (let q = 0; q < n; q++) s[q] = 0.8 * Math.tanh(s[q] * mk)
    this.rx.run(s, n)
  }

  reset() {
    this.txF.reset()
    this.station.reset()
    this.tune.reset()
    this.rx.reset()
    this.statF.reset()
    this.crk.reset()
    this.crash.reset()
    this.path.clear()
    this.other.clear()
    this.otherShift.reset()
    this.otherF.reset()
  }
}

export default makeDevice({
  id: 'device.radio',
  name: 'AM radio',
  about: 'A voice on the AM dial: static, fading and whistles, tuned right in, slightly off, or lost between stations.',
  params: [
    {
      id: 'tuning', name: 'Tuning', type: 'choice', def: 'on',
      options: [
        { v: 'on', name: 'On the station' },
        { v: 'off', name: 'Slightly off' },
        { v: 'between', name: 'Between stations' },
      ],
    },
    { id: 'static', name: 'Static', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [10, 60] },
    { id: 'fading', name: 'Fading', type: 'number', min: 0, max: 100, step: 1, def: 15, unit: 'percent', rand: [0, 60] },
    { id: 'whistle', name: 'Whistle', type: 'number', min: 0, max: 100, step: 1, def: 10, unit: 'percent', rand: [0, 40] },
    {
      id: 'era', name: 'Radio set', type: 'choice', def: '1950s',
      options: [
        { v: '1930s', name: '1930s wooden cabinet' },
        { v: '1950s', name: '1950s kitchen radio' },
        { v: '1960s', name: '1960s pocket transistor' },
        { v: 'car', name: 'Car radio' },
      ],
    },
    { id: 'hum', name: 'Hum', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [0, 50] },
  ],
  cost: 2,
  talk: null,
  latency: () => 0,
  build: (sr, p, rng) => new RadioCore(sr, p, rng),
})
