// modules/device/cylinder.js - device.cylinder, Wax cylinder (about 1900).
//
// The earliest recordings, cut acoustically into a turning wax cylinder:
// - an acoustic recording horn and diaphragm: a narrow, peaky band
//   (narrowness moves it from about 300 Hz to 3.5 kHz down to 500 Hz to
//   2.2 kHz) with strong horn resonances, the honky "far away" sound;
// - a roaring hiss of worn wax, louder than any disc, and a low rushing
//   groove noise that swells with every turn of the mandrel;
// - big, slow speed wobble: once per turn at about 160 turns a minute
//   (2.7 Hz) from an off-centre cylinder, plus the hunting of the motor's
//   governor (kit Wobble);
// - wear: the frying crackle and the blunt-stylus distortion of a cylinder
//   played many times.
// Reference: the cylinder chapters of Read and Welch, "From Tin Foil to
// Stereo", and published transfer engineers' notes on cylinder noise.

import { makeDevice, Bank, butter, Rand, Crackler, Wobble, BLOCK, taper, frac, db } from './_kit.js'

const REV = 160 / 60
const WOB_MS = 9

class CylinderCore {
  constructor(sr, p, rng) {
    this.sr = sr
    this.r = new Rand(rng, 'cyl-noise')
    this.band = new Bank(sr, 9)
    this.wob = new Wobble(sr, WOB_MS, rng, 'cyl')
    this.crk = new Crackler(sr, new Rand(rng, 'cyl-crackle'))
    this.hissF = new Bank(sr, 2)
    this.grooveF = new Bank(sr, 2)
    this.tmp = new Float32Array(BLOCK)
    this.tmp2 = new Float32Array(BLOCK)
    this.revPh = rng.fork('cyl-rev').next()
    this.latency = this.wob.latency
    this.set(p)
    this.wob.settle()
  }

  set(p) {
    const nar = frac(p.band)
    const b = this.band.allOff()
    let j = butter(b, 0, 'hp', 300 + 250 * nar, 4)
    j = butter(b, j, 'lp', 3500 - 1300 * nar, 6)
    b.f[j++].peak(650 + 100 * nar, 2, 5)
    b.f[j++].peak(1500, 2.5, 6)
    b.f[j++].peak(2600 - 300 * nar, 3, 3)
    const w = frac(p.wobble)
    this.wob.set(0.026 * w, REV, 0.011 * w, 0.22, 0.0038 * w, 8, 0.0005 * w, 30)
    this.hissF.allOff()
    this.hissF.f[0].hp(400, 0.7071)
    this.hissF.f[1].lp(6000, 0.7071)
    this.hissLvl = taper(p.hiss, -6)
    this.grooveF.allOff()
    this.grooveF.f[0].lp(700, 0.7071)
    this.grooveF.f[1].hp(120, 0.7071)
    this.grooveLvl = taper(p.groove, -8)
    const we = frac(p.wear)
    this.wear = we
    this.crk.set(20 + 120 * we, 0.3 + 2 * we, 0.03, 0.6, 0.75)
    this.crkLvl = taper(p.wear, 4)
    this.makeup = db(9 + 3 * nar)
  }

  run(s, n) {
    const r = this.r
    const tmp = this.tmp
    const tmp2 = this.tmp2
    // blunt stylus on worn wax
    const we = this.wear
    if (we > 0) {
      const k = 2 + 8 * we
      for (let q = 0; q < n; q++) {
        const x = s[q]
        const v = x * k
        const d = (v > 0 ? Math.tanh(v) : Math.tanh(v * 1.5) / 1.5) / k
        s[q] = x + (d - x) * Math.min(1, we * 1.5)
      }
    }
    this.wob.run(s, n, null)
    r.fill(tmp, n)
    this.hissF.run(tmp, n)
    r.fill(tmp2, n)
    this.grooveF.run(tmp2, n)
    let ph = this.revPh
    const inc = REV / this.sr
    const hl = this.hissLvl * 2.3
    const gl = this.grooveLvl * 5
    for (let q = 0; q < n; q++) {
      ph += inc
      if (ph >= 1) ph -= 1
      const turn = Math.sin(6.283185307 * ph)
      s[q] += tmp[q] * hl * (1 + 0.25 * turn) + tmp2[q] * gl * (0.5 + 0.5 * turn * turn)
    }
    this.revPh = ph
    this.crk.render(tmp, n)
    const cl = this.crkLvl
    for (let q = 0; q < n; q++) s[q] += tmp[q] * cl
    // the horn colours voice and noise alike
    this.band.run(s, n)
    const mk = this.makeup
    for (let q = 0; q < n; q++) s[q] *= mk
  }

  reset() {
    this.band.reset()
    this.wob.reset()
    this.crk.reset()
    this.hissF.reset()
    this.grooveF.reset()
  }
}

export default makeDevice({
  id: 'device.cylinder',
  name: 'Wax cylinder',
  about: 'A voice from about 1900 on a wax cylinder: narrow and honky, under a roar of hiss, wobbling as the cylinder turns.',
  params: [
    { id: 'hiss', name: 'Hiss', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [30, 80] },
    { id: 'groove', name: 'Groove rumble', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [20, 70] },
    { id: 'wobble', name: 'Wobble', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [15, 70] },
    { id: 'band', name: 'Narrowness', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
    { id: 'wear', name: 'Wear', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [10, 70] },
  ],
  cost: 2,
  talk: null,
  latency: (sr) => Math.max(4, Math.round(WOB_MS * 0.001 * sr)),
  build: (sr, p, rng) => new CylinderCore(sr, p, rng),
})
