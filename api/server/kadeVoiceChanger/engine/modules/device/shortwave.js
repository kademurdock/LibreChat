// modules/device/shortwave.js - device.shortwave, Shortwave.
//
// Long-distance radio bounced off the ionosphere:
// - ham sideband: single-sideband voice through a narrow 300 Hz to 2.7 kHz
//   filter and a speech processor; a receiver tuned a little off moves
//   every frequency by the same number of hertz (kit Shift, a Bode
//   frequency shifter), which gives the famous squawky, sing-song "duck"
//   voice of a mistuned sideband signal;
// - broadcast: shortwave AM, wider, with the distortion AM picks up when
//   its carrier fades away from its sidebands;
// - fading: flat fades plus a moving two-path comb at the chosen speed, the
//   selective fading of multipath propagation (described in the ITU-R
//   F.1487 / Watterson ionospheric channel model as delayed, fading paths);
// - atmospheric noise: hiss, the crackle of distant lightning and the
//   occasional big crash, all pumped up by the receiver's AGC whenever the
//   signal sinks;
// - interference: a warbling carrier, over-the-horizon radar pulses (the
//   rapid "woodpecker" knock heard on shortwave for decades) or teletype
//   tones (frequency-shift keying, 170 Hz shift at 45.45 baud).

import { makeDevice, Ctl, Bank, butter, Rand, Crackler, Squash, Swell, Shift, Burst, BLOCK, SPEECH, taper, frac, db } from './_kit.js'
import { DelayLine } from '../../core/delay.js'

class ShortwaveCore {
  constructor(sr, p, rng) {
    this.sr = sr
    this.r = new Rand(rng, 'sw-noise')
    this.txF = new Bank(sr, 6)
    this.proc = new Squash(sr)
    this.shift = new Shift(sr)
    this.agc = new Squash(sr)
    this.rx = new Bank(sr, 6)
    this.nF = new Bank(sr, 2)
    this.crk = new Crackler(sr, new Rand(rng, 'sw-crackle'))
    this.crash = new Swell(sr, new Rand(rng, 'sw-crash'))
    this.path = new DelayLine(Math.ceil(0.005 * sr) + 8)
    this.fadeL = new Ctl(sr, { shape: 'smooth', rate: 0.3, rng: rng.fork('sw-fade') })
    this.combL = new Ctl(sr, { shape: 'smooth', rate: 0.4, rng: rng.fork('sw-comb') })
    this.warbL = new Ctl(sr, { shape: 'sine', rate: 5, rng: rng.fork('sw-warble') })
    this.driftL = new Ctl(sr, { shape: 'smooth', rate: 0.07, rng: rng.fork('sw-drift') })
    this.knock = new Burst(sr, new Rand(rng, 'sw-knock')).color(500, 3500)
    this.tmp = new Float32Array(BLOCK)
    this.tmp2 = new Float32Array(BLOCK)
    this.fd = new Float32Array(BLOCK)
    this.wPh = 0
    this.hPh = 0
    this.kPh = 0
    this.ttPh = 0
    this.ttLeft = 0
    this.ttMark = 1
    this.warbHz = 1000 + 700 * rng.fork('sw-whf').next()
    this.latency = 0
    this.set(p)
  }

  set(p) {
    const sr = this.sr
    this.ssb = p.mode !== 'am'
    const tx = this.txF.allOff()
    let j
    if (this.ssb) {
      j = butter(tx, 0, 'hp', 300, 4)
      butter(tx, j, 'lp', 2700, 8)
      this.proc.set(-30, 6, 1, 90, 7, 6)
      this.shift.set(p.detune)
    } else {
      j = butter(tx, 0, 'hp', 150, 2)
      butter(tx, j, 'lp', 4500, 6)
      this.proc.set(-28, 3, 3, 200, 4, 8)
      this.shift.set(0)
    }
    this.hetHz = !this.ssb && Math.abs(p.detune) >= 20 ? Math.abs(p.detune) * 4 : 0
    const fd = frac(p.fading)
    this.fadeDepth = 0.85 * fd
    this.combA = 0.85 * fd
    this.fadeL.rate = p.speed
    this.combL.rate = p.speed * 1.35
    this.agc.set(-30, 8, 4, 450, 8, 8)
    const rx = this.rx.allOff()
    j = butter(rx, 0, 'hp', 250, 4)
    j = butter(rx, j, 'lp', this.ssb ? 3000 : 4200, 2)
    rx.f[j++].peak(1200, 1, 3)
    this.nF.allOff()
    this.nF.f[0].lp(this.ssb ? 3200 : 4500, 0.7071)
    this.nF.f[1].hp(200, 0.7071)
    const nz = frac(p.noise)
    this.noiseLvl = taper(p.noise, -12)
    this.crk.set(15 + 120 * nz, 1.2 * nz, 0.05, 2, 0.6)
    this.crash.set(0.25 * nz, 8, 40, 300, 0.8, 0.5)
    this.kind = p.interference === 'pulse' ? 1 : p.interference === 'teletype' ? 2 : 0
    this.intLvl = taper(p.warble, -12, 30)
    this.makeup = db(this.ssb ? 3 : 3)
  }

  run(s, n) {
    const r = this.r
    const tmp = this.tmp
    const tmp2 = this.tmp2
    const fdv = this.fd
    const sr = this.sr
    this.txF.run(s, n)
    this.proc.run(s, n)
    for (let q = 0; q < n; q++) s[q] = Math.tanh(s[q] * 2) / 2
    if (this.ssb) this.shift.run(s, n)
    // ionosphere: flat fade and moving comb
    const fdep = this.fadeDepth
    const ca = this.combA
    const path = this.path
    for (let q = 0; q < n; q++) {
      const x = s[q]
      path.write(x)
      const f = 0.5 + 0.5 * this.fadeL.next()
      const fade = 1 - fdep * f * Math.sqrt(f)
      fdv[q] = fade
      const dd = (2 + 1.6 * this.combL.next()) * 0.001 * sr
      let y = (x + ca * path.read(dd)) * fade
      if (!this.ssb && fade < 0.6) {
        // AM with a fading carrier: the detector distorts
        const k = 1 + (0.6 - fade) * 6
        y = Math.tanh(y * k * 3 + 0.2 * (k - 1)) / (k * 3)
      }
      s[q] = y
    }
    // atmospheric noise
    r.fill(tmp, n)
    this.crash.render(tmp2, n)
    const nl = this.noiseLvl * 3.4
    for (let q = 0; q < n; q++) tmp[q] *= nl * (1 + 7 * tmp2[q])
    this.crk.render(tmp2, n)
    const cl = this.noiseLvl * 4
    for (let q = 0; q < n; q++) tmp[q] += tmp2[q] * cl
    // interference
    const il = this.intLvl
    if (il > 0) {
      if (this.kind === 0) {
        let ph = this.wPh
        const g = il * 1.41
        for (let q = 0; q < n; q++) {
          const hz = this.warbHz + 120 * this.driftL.next() + 45 * this.warbL.next()
          ph += hz / sr
          if (ph >= 1) ph -= 1
          tmp[q] += Math.sin(6.283185307 * ph) * g
        }
        this.wPh = ph
      } else if (this.kind === 1) {
        // radar knock at about 10 per second
        let ph = this.kPh
        const inc = 10.2 / sr
        tmp2.fill(0, 0, n)
        for (let q = 0; q < n; q++) {
          ph += inc
          if (ph >= 1) {
            ph -= 1
            this.knock.trigger(q, 0.3, 1.5, 4, il * 9, 0.2)
          }
        }
        this.kPh = ph
        this.knock.render(tmp, n)
      } else {
        // teletype: mark and space 170 Hz apart, 45.45 baud
        let ph = this.ttPh
        const g = il * 1.41
        const baud = Math.round(sr / 45.45)
        for (let q = 0; q < n; q++) {
          if (--this.ttLeft <= 0) {
            this.ttMark = r.u() < 0.5 ? 1 : 0
            this.ttLeft = baud
          }
          const hz = this.ttMark ? 2125 : 2295
          ph += hz / sr
          if (ph >= 1) ph -= 1
          tmp[q] += Math.sin(6.283185307 * ph) * g
        }
        this.ttPh = ph
      }
    }
    if (this.hetHz > 0) {
      let ph = this.hPh
      const g = il > 0 ? il : SPEECH * 0.05
      for (let q = 0; q < n; q++) {
        ph += this.hetHz / sr
        if (ph >= 1) ph -= 1
        tmp[q] += Math.sin(6.283185307 * ph) * g
      }
      this.hPh = ph
    }
    this.nF.run(tmp, n)
    for (let q = 0; q < n; q++) s[q] += tmp[q]
    // receiver AGC brings the noise up as the signal sinks
    this.agc.run(s, n)
    const mk = this.makeup / 0.8
    for (let q = 0; q < n; q++) s[q] = 0.8 * Math.tanh(s[q] * mk)
    this.rx.run(s, n)
  }

  reset() {
    this.txF.reset()
    this.proc.reset()
    this.shift.reset()
    this.agc.reset()
    this.rx.reset()
    this.nF.reset()
    this.crk.reset()
    this.crash.reset()
    this.path.clear()
    this.knock.stop()
  }
}

export default makeDevice({
  id: 'device.shortwave',
  name: 'Shortwave',
  about: 'A voice from across the world on shortwave: sideband squawk, deep fades, crackling atmosphere and strange signals.',
  params: [
    {
      id: 'mode', name: 'Signal', type: 'choice', def: 'ssb',
      options: [
        { v: 'ssb', name: 'Ham sideband' },
        { v: 'am', name: 'Broadcast' },
      ],
    },
    { id: 'detune', name: 'Tuning error', type: 'number', min: -400, max: 400, step: 5, def: 60, unit: 'hz', rand: [-150, 150] },
    { id: 'speed', name: 'Fading speed', type: 'number', min: 0.05, max: 2, step: 0.05, def: 0.3, unit: 'hz', rand: [0.1, 0.8] },
    { id: 'fading', name: 'Fading depth', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
    { id: 'noise', name: 'Atmospheric noise', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [15, 70] },
    { id: 'warble', name: 'Interference', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 60] },
    {
      id: 'interference', name: 'Interference kind', type: 'choice', def: 'warble',
      options: [
        { v: 'warble', name: 'Warbling carrier' },
        { v: 'pulse', name: 'Radar knocking' },
        { v: 'teletype', name: 'Teletype tones' },
      ],
    },
  ],
  cost: 2,
  talk: null,
  latency: () => 0,
  build: (sr, p, rng) => new ShortwaveCore(sr, p, rng),
})
