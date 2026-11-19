// modules/device/vinyl.js - device.vinyl, Vinyl record.
//
// A long-player or single on a home turntable:
// - surface: fine, dense crackle (dust in the groove: bright, tiny ticks at
//   a Poisson rate), and separate pops from scratches and static, bigger
//   and duller;
// - the turntable: rumble (a low, slightly lumpy roar from the motor and
//   bearing) and wow at the turning rate, 33 or 45 turns a minute, from an
//   off-centre pressing;
// - warp: a warped disc lifts and drops the stylus once per turn, so the
//   pitch swings much wider and the level and rumble pulse with it;
// - wear: a well-played record loses its top end and the loud peaks pick
//   up the gritty inner-groove distortion of a worn stylus.
// Wow and warp use the kit Wobble (a modulated delay); the published wow
// and flutter figures of consumer turntables (0.1 to 0.3 percent) set the
// default range.

import { makeDevice, Bank, butter, Bq, Rand, Crackler, Wobble, BLOCK, taper, frac } from './_kit.js'

const WOB_MS = 8

class VinylCore {
  constructor(sr, p, rng) {
    this.sr = sr
    this.r = new Rand(rng, 'vinyl-noise')
    this.eq = new Bank(sr, 4)
    this.wob = new Wobble(sr, WOB_MS, rng, 'vinyl')
    this.fine = new Crackler(sr, new Rand(rng, 'vinyl-crackle'), 24)
    this.big = new Crackler(sr, new Rand(rng, 'vinyl-pops'), 8)
    this.crkF = new Bq(sr).lp(9000, 0.7071)
    this.popF = new Bq(sr).lp(5000, 0.7071)
    this.rumF = new Bank(sr, 3)
    butter(this.rumF, 0, 'lp', 45, 4)
    this.rumF.f[2].hp(9, 0.7071)
    this.hissF = new Bq(sr).hp(2000, 0.7071)
    this.tmp = new Float32Array(BLOCK)
    this.revPh = 0
    this.latency = this.wob.latency
    this.set(p)
    this.wob.settle()
  }

  set(p) {
    this.rev = p.speed === '45' ? 0.75 : 100 / 3 / 60
    const we = frac(p.wear)
    const eq = this.eq.allOff()
    eq.f[0].ls(150, 0.7071, 1)
    eq.f[1].hs(6000, 0.7071, -1 - 9 * we)
    eq.f[2].lp(18000 - 10000 * we, 0.7071)
    this.wear = we
    const w = frac(p.wow)
    const wp = frac(p.warp)
    this.warp = wp
    this.wob.set(0.005 * w + 0.014 * wp, this.rev, 0.0025 * w, 0.15, 0.0016 * w, 10, 0, 30)
    const c = frac(p.crackle)
    this.fine.set(c > 0 ? 8 + 320 * Math.pow(c, 1.5) : 0, 0, 0.02, 0.25, 0.15)
    this.fineLvl = taper(p.crackle, 4)
    const pp = frac(p.pops)
    this.big.set(pp > 0 ? 0.05 + 2.5 * pp * pp : 0, pp > 0 ? 0.02 + 0.6 * pp * pp : 0, 0.2, 1.4, 0.1)
    this.popLvl = taper(p.pops, 14, 24)
    this.rumLvl = taper(p.rumble, 2)
    this.hissLvl = taper(p.wear, -36)
  }

  run(s, n) {
    const r = this.r
    const tmp = this.tmp
    const we = this.wear
    if (we > 0) {
      // inner-groove grit on the loud peaks
      const k = 2.5 + 4 * we
      const m = 0.6 * we
      for (let q = 0; q < n; q++) {
        const x = s[q]
        const v = x * k
        s[q] = x + ((v > 0 ? Math.tanh(v) : Math.tanh(v * 1.3) / 1.3) / k - x) * m
      }
    }
    this.eq.run(s, n)
    this.wob.run(s, n, null)
    // warp pulses the level once per turn
    let ph = this.revPh
    const inc = this.rev / this.sr
    const wp = this.warp
    if (wp > 0) {
      for (let q = 0; q < n; q++) {
        ph += inc
        if (ph >= 1) ph -= 1
        s[q] *= 1 + 0.12 * wp * Math.sin(6.283185307 * ph)
      }
    } else {
      ph += inc * n
      ph -= Math.floor(ph)
    }
    // rumble, a little lumpy, pulsing with a warp
    r.fill(tmp, n)
    this.rumF.run(tmp, n)
    const rl = this.rumLvl * 30
    for (let q = 0; q < n; q++) s[q] += tmp[q] * rl * (1 + wp * 0.8 * Math.sin(6.283185307 * (this.revPh + (q * inc))))
    this.revPh = ph
    if (this.hissLvl > 0) {
      r.fill(tmp, n)
      this.hissF.run(tmp, n)
      const g = this.hissLvl * 2
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
    }
    if (this.fineLvl > 0) {
      this.fine.render(tmp, n)
      this.crkF.run(tmp, n)
      const g = this.fineLvl
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
    }
    if (this.popLvl > 0) {
      this.big.render(tmp, n)
      this.popF.run(tmp, n)
      const g = this.popLvl
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
    }
  }

  reset() {
    this.eq.reset()
    this.wob.reset()
    this.fine.reset()
    this.big.reset()
    this.crkF.reset()
    this.popF.reset()
    this.rumF.reset()
    this.hissF.reset()
  }
}

export default makeDevice({
  id: 'device.vinyl',
  name: 'Vinyl record',
  about: 'Your voice pressed on a record: dusty crackle, pops, a low rumble, gentle wow, and a warp if you want one.',
  params: [
    { id: 'crackle', name: 'Crackle', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [15, 70] },
    { id: 'pops', name: 'Pops', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [5, 60] },
    { id: 'rumble', name: 'Rumble', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [0, 50] },
    { id: 'wow', name: 'Wow', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [5, 50] },
    { id: 'warp', name: 'Warp', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 50] },
    { id: 'wear', name: 'Wear', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [0, 60] },
    {
      id: 'speed', name: 'Record speed', type: 'choice', def: '33',
      options: [
        { v: '33', name: 'Long-player, 33 turns a minute' },
        { v: '45', name: 'Single, 45 turns a minute' },
      ],
    },
  ],
  cost: 2,
  talk: null,
  latency: (sr) => Math.max(4, Math.round(WOB_MS * 0.001 * sr)),
  build: (sr, p, rng) => new VinylCore(sr, p, rng),
})
