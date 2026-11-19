// modules/device/gramophone.js - device.gramophone, Gramophone 78.
//
// A shellac 78 on a wind-up machine:
// - the recording: made acoustically into a horn (roughly 200 Hz to
//   4.5 kHz with the recording horn's honk), or for the electric pickup
//   setting, a later electrical recording;
// - the groove: worn grooves distort on loud passages (tracing distortion
//   of a blunted needle, lopsided and harsh) and lose their highs;
// - the turntable: once-per-turn wow at 78 turns a minute (1.3 Hz, from an
//   off-centre hole), slow drift, and the flutter of a spring motor's
//   governor (kit Wobble, a modulated delay);
// - shellac surface noise: a loud, gritty hiss that swells once per turn
//   plus a lower swish, crackle, pops, and the tick of a scratch going
//   round each turn;
// - the playback: the soundbox and horn (big horn, small table horn) or an
//   electric pickup through a valve set; all the noise goes through it too,
//   so it is coloured like the voice;
// - the turntable speed: early records were cut anywhere from about 70 to
//   90 turns a minute before 78 settled in, so a record played on a machine
//   set a little fast or slow comes out higher and quicker, or lower and
//   slower (a plain windowed-sinc speed change, core/resample.js), and the
//   once-a-turn wobble follows the turntable. "Spring running down" plays the
//   end of the take as a wind-up motor sags when its spring is spent: the
//   governor holds the speed until the last few seconds, then it slides
//   down by about a third (core/resample.js varispeed on the input clock).
//   Every speed but 78 changes the timing, so the module warps; live, the
//   speed choice only moves the wobble rate.
// Reference: the acoustic recording and reproduction chapters of Read and
// Welch, "From Tin Foil to Stereo".

import { makeDevice, Bank, butter, Bq, Rand, Crackler, Wobble, BLOCK, SPEECH, taper, frac, db } from './_kit.js'
import { resample, varispeed } from '../../core/resample.js'

const HORNS = ['big', 'small', 'electric']
const RPM = { 70: 70, 78: 78, 80: 80, 90: 90, rundown: 78 }
const WOB_MS = 6
// running down: the last RUNDOWN_S seconds (at most 45 percent of the take)
// slide from full speed to 1 - RUNDOWN_DEPTH
const RUNDOWN_S = 6
const RUNDOWN_DEPTH = 0.35

function rpmOf(p) {
  return RPM[p.speed] || 78
}

/** Offline only: the record turning at the chosen speed (the take's new timing). */
function prepareSpeed(mono, sr, p) {
  if (p.speed === 'rundown') {
    const D = mono.length / sr
    const sag = Math.min(0.45 * D, RUNDOWN_S)
    if (!(sag > 0.01)) return mono
    const t0 = D - sag
    const rate = (t) => {
      if (t <= t0) return 1
      const u = (t - t0) / sag
      return 1 - RUNDOWN_DEPTH * Math.pow(u < 1 ? u : 1, 1.7)
    }
    return varispeed(mono, rate, sr, { clock: 'in', stopFade: 0 })
  }
  const r = rpmOf(p) / 78
  if (r === 1) return mono
  return resample(mono, 1 / r)
}

class GramoCore {
  constructor(sr, p, rng) {
    this.sr = sr
    this.r = new Rand(rng, 'gramo-noise')
    this.rec = new Bank(sr, 5)
    this.play = new Bank(sr, 8)
    this.wob = new Wobble(sr, WOB_MS, rng, 'gramo')
    this.crk = new Crackler(sr, new Rand(rng, 'gramo-crackle'))
    this.hissF = new Bank(sr, 2)
    this.swishF = new Bq(sr).lp(900, 0.7071)
    this.wearF = new Bq(sr)
    this.tmp = new Float32Array(BLOCK)
    this.tmp2 = new Float32Array(BLOCK)
    this.revPh = rng.fork('gramo-rev').next()
    this.scratchAmp = 0.3 + 0.7 * rng.fork('gramo-scratch').next()
    this.tick = 0
    this.rev = 78 / 60
    this.latency = this.wob.latency
    this.set(p)
    this.wob.settle()
  }

  set(p) {
    let h = HORNS.indexOf(p.horn)
    if (h < 0) h = 0
    this.hornK = h
    const rec = this.rec.allOff()
    let j
    if (h === 2) {
      j = butter(rec, 0, 'hp', 90, 2)
      j = butter(rec, j, 'lp', 6000, 4)
    } else {
      j = butter(rec, 0, 'hp', 200, 2)
      j = butter(rec, j, 'lp', 4500, 4)
      rec.f[j++].peak(1000, 1.5, 3)
    }
    const pl = this.play.allOff()
    if (h === 0) {
      j = butter(pl, 0, 'hp', 180, 2)
      j = butter(pl, j, 'lp', 4500, 6)
      pl.f[j++].peak(500, 1.5, 4)
      pl.f[j++].peak(1200, 2, 5)
      pl.f[j++].peak(2400, 2.5, 4)
    } else if (h === 1) {
      j = butter(pl, 0, 'hp', 300, 4)
      j = butter(pl, j, 'lp', 4000, 4)
      pl.f[j++].peak(900, 2, 5)
      pl.f[j++].peak(2000, 2.5, 4)
    } else {
      j = butter(pl, 0, 'hp', 100, 2)
      j = butter(pl, j, 'lp', 5500, 4)
      pl.f[j++].peak(2500, 1.2, 3)
      pl.f[j++].peak(180, 1, 2)
    }
    this.rev = rpmOf(p) / 60
    const w = frac(p.wow)
    this.wob.set(0.016 * w, this.rev, 0.0035 * w, 0.25, 0.0023 * w, 6, 0, 25)
    const we = frac(p.wear)
    this.wear = we
    this.wearF.lp(5500 - 3000 * we, 0.7071)
    this.hissF.allOff()
    this.hissF.f[0].hp(350, 0.7071)
    this.hissF.f[1].lp(7000, 0.7071)
    this.surf = taper(p.surface, -10)
    this.swish = taper(p.surface, -12)
    const c = frac(p.crackle)
    this.crk.set(6 + 50 * c, 0.15 + 1.5 * c, 0.04, 1.5, 0.35)
    this.crkLvl = taper(p.crackle, 8)
    this.scratch = c > 0.35 ? (c - 0.35) / 0.65 : 0
    this.makeup = db(h === 1 ? 6 : 4)
  }

  run(s, n) {
    const r = this.r
    const tmp = this.tmp
    const tmp2 = this.tmp2
    this.rec.run(s, n)
    // worn groove: distortion that grows on loud passages
    const we = this.wear
    if (we > 0) {
      const k = 1 + 6 * we
      for (let q = 0; q < n; q++) {
        const x = s[q]
        const v = x * k * 2
        const d = (v > 0 ? Math.tanh(v) : Math.tanh(v * 1.4) / 1.4) / (k * 2)
        s[q] = x + (d - x) * Math.min(1, we * 1.4)
      }
      this.wearF.run(s, n)
    }
    this.wob.run(s, n, null)
    // shellac surface: hiss swelling once per turn, a lower swish, crackle and the scratch
    r.fill(tmp, n)
    this.hissF.run(tmp, n)
    r.fill(tmp2, n)
    this.swishF.run(tmp2, n)
    let ph = this.revPh
    const inc = this.rev / this.sr
    const sl = this.surf * 2.4
    const sw = this.swish * 4
    for (let q = 0; q < n; q++) {
      ph += inc
      if (ph >= 1) {
        ph -= 1
        if (this.scratch > 0) this.tick = this.scratch * this.scratchAmp * SPEECH * 6
      }
      const turn = Math.sin(6.283185307 * ph)
      s[q] += tmp[q] * sl * (1 + 0.35 * turn) + tmp2[q] * sw * (0.6 + 0.4 * turn * turn)
    }
    this.revPh = ph
    this.crk.render(tmp, n)
    const cl = this.crkLvl
    let tk = this.tick
    for (let q = 0; q < n; q++) {
      s[q] += tmp[q] * cl + tk
      tk *= 0.82
      if (tk < 1e-7 && tk > -1e-7) tk = 0
    }
    this.tick = tk
    this.play.run(s, n)
    const mk = this.makeup
    for (let q = 0; q < n; q++) s[q] *= mk
  }

  reset() {
    this.rec.reset()
    this.play.reset()
    this.wob.reset()
    this.crk.reset()
    this.hissF.reset()
    this.swishF.reset()
    this.wearF.reset()
    this.tick = 0
  }
}

export default makeDevice({
  id: 'device.gramophone',
  name: 'Gramophone record',
  about: 'An old 78 on a wind-up gramophone: horn honk, hissing shellac, crackle, a scratch going round, wobble, and a speed to set.',
  params: [
    {
      id: 'horn', name: 'Player', type: 'choice', def: 'big',
      options: [
        { v: 'big', name: 'Big horn' },
        { v: 'small', name: 'Small table horn' },
        { v: 'electric', name: 'Electric pickup' },
      ],
    },
    { id: 'surface', name: 'Surface noise', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [20, 75] },
    { id: 'crackle', name: 'Crackle', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [15, 75] },
    { id: 'wow', name: 'Wobble', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [10, 60] },
    { id: 'wear', name: 'Wear', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [10, 70] },
    {
      id: 'speed', name: 'Turntable speed', type: 'choice', def: '78',
      options: [
        { v: '70', name: '70, too slow' },
        { v: '78', name: '78, the right speed' },
        { v: '80', name: '80, a touch fast' },
        { v: '90', name: '90, much too fast' },
        { v: 'rundown', name: 'Spring running down' },
      ],
    },
  ],
  cost: 2,
  warps: true,
  prepare: prepareSpeed,
  talk: null,
  latency: (sr) => Math.max(4, Math.round(WOB_MS * 0.001 * sr)),
  build: (sr, p, rng) => new GramoCore(sr, p, rng),
})
