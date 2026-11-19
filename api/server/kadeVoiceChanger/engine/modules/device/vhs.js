// modules/device/vhs.js - device.vhs, Video tape sound (home video, linear track).
//
// The mono audio of a home video tape, recorded on a narrow linear track
// along the tape's edge:
// - tape speed sets everything: standard play reaches about 10 kHz, long
//   play about 7 kHz and extended play only about 5 kHz, with more hiss and
//   wobble at each slower speed (published linear-track specifications);
// - the transport: wow and the faster flutter of the capstan and the
//   spinning head drum (kit Wobble);
// - hum and the video buzz: mains hum plus the 60 Hz buzz that the video
//   heads' switching and the picture's vertical sync leak into the audio;
// - bad tracking: bursts of noise, dropouts and pitch glitches when the
//   heads wander off the tracks.

import { makeDevice, Bank, butter, Bq, Rand, Swell, Crackler, Hum, Wobble, BLOCK, SPEECH, taper, frac, db, onePoleCoef } from './_kit.js'

const SPEEDS = ['sp', 'lp', 'ep']
// [top Hz, hiss dB, wobble scale]
const SPEC = [
  [10000, -22, 1],
  [6500, -18, 1.5],
  [4500, -14, 2.2],
]
const WOB_MS = 7

class VHSCore {
  constructor(sr, p, rng) {
    this.sr = sr
    this.r = new Rand(rng, 'vhs-noise')
    this.rec = new Bank(sr, 4)
    this.wob = new Wobble(sr, WOB_MS, rng, 'vhs')
    this.track = new Swell(sr, new Rand(rng, 'vhs-track'))
    this.crk = new Crackler(sr, new Rand(rng, 'vhs-crackle'))
    this.hum = new Hum(sr, 60)
    this.hissF = new Bank(sr, 2)
    this.buzzF = new Bq(sr).bp(1800, 0.6)
    this.tmp = new Float32Array(BLOCK)
    this.env = new Float32Array(BLOCK)
    this.jit = new Float32Array(BLOCK)
    this.bPh = 0
    this.jv = 0
    this.dl = 0
    this.latency = this.wob.latency
    this.set(p)
    this.wob.settle()
  }

  set(p) {
    let sp = SPEEDS.indexOf(p.speed)
    if (sp < 0) sp = 0
    const S = SPEC[sp]
    const rec = this.rec.allOff()
    rec.f[0].hp(70, 0.7071)
    butter(rec, 1, 'lp', S[0], 4)
    rec.f[3].peak(120, 1, 1.5)
    const w = frac(p.wobble) * S[2]
    this.wob.set(0.0065 * w, 0.7, 0.0035 * w, 0.3, 0.0045 * w, 15, 0.001 * w, 60)
    this.hissF.allOff()
    this.hissF.f[0].hp(1500, 0.7071)
    this.hissF.f[1].lp(Math.min(14000, S[0] * 1.3), 0.7071)
    this.hissLvl = taper(p.hiss, S[1])
    this.humLvl = taper(p.hum, -14)
    this.buzzLvl = taper(p.hum, -16)
    const t = frac(p.tracking)
    this.tr = t
    this.track.set(t > 0 ? 0.04 + 1.8 * t * t : 0, 8, 30 + 120 * t, 70, 0.8, 0.4)
    this.crk.set(t > 0 ? 2 + 40 * t : 0, 0, 0.05, 0.6, 0.7)
    this.crkLvl = taper(p.tracking, 0)
    this.dropK = onePoleCoef(1200, this.sr)
    this.makeup = db(1)
  }

  run(s, n) {
    const r = this.r
    const tmp = this.tmp
    const env = this.env
    const jit = this.jit
    this.rec.run(s, n)
    // tracking trouble: a burst envelope that also shakes the pitch
    this.track.render(env, n)
    let jv = this.jv
    const lim = this.wob.latency * 0.3
    for (let q = 0; q < n; q++) {
      const e = env[q]
      if (e > 0) jv += (r.w() * lim - jv) * 0.002
      else jv *= 0.999
      jit[q] = jv * e
    }
    this.jv = jv
    this.wob.run(s, n, jit)
    let dl = this.dl
    const dk = this.dropK
    r.fill(tmp, n)
    this.hissF.run(tmp, n)
    const hl = this.hissLvl * 2.2
    for (let q = 0; q < n; q++) {
      const e = env[q]
      dl += (s[q] - dl) * dk
      const v = e > 0 ? (s[q] * (1 - e) + dl * e * 0.7) * (1 - 0.6 * e) : s[q]
      s[q] = v + tmp[q] * (hl + e * SPEECH * 0.7)
    }
    this.dl = dl
    if (this.crkLvl > 0) {
      this.crk.render(tmp, n)
      const g = this.crkLvl
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
    }
    // hum and the video buzz
    if (this.humLvl > 0) {
      this.hum.render(tmp, n, 0.2)
      const g = this.humLvl
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
      let ph = this.bPh
      const inc = 59.94 / this.sr
      for (let q = 0; q < n; q++) {
        ph += inc
        if (ph >= 1) ph -= 1
        tmp[q] = ph < 0.04 ? 1 : -0.0417
      }
      this.bPh = ph
      this.buzzF.run(tmp, n)
      const bg = this.buzzLvl * 6
      for (let q = 0; q < n; q++) s[q] += tmp[q] * bg
    }
    const mk = this.makeup
    for (let q = 0; q < n; q++) s[q] *= mk
  }

  reset() {
    this.rec.reset()
    this.wob.reset()
    this.track.reset()
    this.crk.reset()
    this.hissF.reset()
    this.buzzF.reset()
    this.jv = 0
    this.dl = 0
  }
}

export default makeDevice({
  id: 'device.vhs',
  name: 'Video tape sound',
  about: 'The sound of an old home video tape: hiss, wobble, hum and buzz, slower speeds getting duller, and bad tracking bursts.',
  params: [
    {
      id: 'speed', name: 'Tape speed', type: 'choice', def: 'sp',
      options: [
        { v: 'sp', name: 'Standard play' },
        { v: 'lp', name: 'Long play' },
        { v: 'ep', name: 'Extended play' },
      ],
    },
    { id: 'hiss', name: 'Hiss', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [15, 65] },
    { id: 'wobble', name: 'Wobble', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [10, 60] },
    { id: 'hum', name: 'Hum and buzz', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 55] },
    { id: 'tracking', name: 'Bad tracking', type: 'number', min: 0, max: 100, step: 1, def: 10, unit: 'percent', rand: [0, 50] },
  ],
  cost: 2,
  talk: null,
  latency: (sr) => Math.max(4, Math.round(WOB_MS * 0.001 * sr)),
  build: (sr, p, rng) => new VHSCore(sr, p, rng),
})
