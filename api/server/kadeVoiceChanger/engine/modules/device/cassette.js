// modules/device/cassette.js - device.cassette, Cassette tape.
//
// A compact cassette from record head to playback:
// - recording: tape saturation (a soft, compressing curve that rounds
//   loud syllables) and the playback head's low "head bump";
// - the tape: normal ferric, chrome, a worn-out tape, or a copy of a copy
//   (two generations: duller, twice the hiss, wider wow); a misaligned head
//   (azimuth error) takes away the top end;
// - the transport: wow (about once a second), drift, flutter (the capstan,
//   several times a second) and scrape flutter, as a modulated delay (kit
//   Wobble); a chewed tape adds wild crinkled pitch swings;
// - dropouts: short holes in the oxide, where the level falls and the
//   highs vanish for a moment;
// - hiss: the bright, steady noise of the tape itself.
// Figures follow published cassette deck specifications (wow and flutter
// of 0.05 to 0.3 percent, ferric top end about 12 kHz, chrome about 15 kHz).

import { makeDevice, Bank, butter, Rand, Swell, Crackler, Wobble, BLOCK, taper, frac, db, onePoleCoef } from './_kit.js'

const TAPES = ['ferric', 'chrome', 'worn', 'dub']
// [top end Hz, hiss dB at full, wow scale, dropout scale]
const TAPE = [
  [12000, -18, 1, 1],
  [15000, -21, 0.9, 0.8],
  [6500, -15, 1.6, 3],
  [8000, -13, 1.5, 1.5],
]
const WOB_MS = 9

class CassetteCore {
  constructor(sr, p, rng) {
    this.sr = sr
    this.r = new Rand(rng, 'tape-noise')
    this.recF = new Bank(sr, 2)
    this.tape = new Bank(sr, 4)
    this.wob = new Wobble(sr, WOB_MS, rng, 'tape')
    this.drop = new Swell(sr, new Rand(rng, 'tape-drop'))
    this.crinkle = new Crackler(sr, new Rand(rng, 'tape-crinkle'))
    this.hissF = new Bank(sr, 2)
    this.tmp = new Float32Array(BLOCK)
    this.env = new Float32Array(BLOCK)
    this.dl = 0
    this.latency = this.wob.latency
    this.set(p)
    this.wob.settle()
  }

  set(p) {
    let t = TAPES.indexOf(p.tape)
    if (t < 0) t = 0
    const T = TAPE[t]
    const hl = frac(p.highLoss)
    const sat = frac(p.saturation)
    const ch = frac(p.chewed)
    this.satL = 1.2 - 0.95 * sat
    const rf = this.recF.allOff()
    rf.f[0].peak(90, 1.2, 2.5)
    rf.f[1].hp(35, 0.7071)
    const tp = this.tape.allOff()
    const top = T[0] * (1 - 0.65 * hl)
    butter(tp, 0, 'lp', top, 4)
    tp.f[2].hs(top * 0.45, 0.7071, -2 - 12 * hl - (t === 2 ? 5 : 0))
    if (t === 3) tp.f[3].lp(top * 0.9, 0.7071)
    const w = frac(p.wow) * T[2]
    const f = frac(p.flutter)
    this.wob.set(0.008 * w, 0.8, 0.003 * w + 0.02 * ch, 0.25 + 2.5 * ch, 0.005 * f, 9.5, 0.0007 * f + 0.008 * ch, 38)
    const d = frac(p.dropouts)
    this.drop.set(d > 0 || ch > 0 || t === 2 ? (0.03 + 1.6 * d * d) * T[3] + 3 * ch : 0, 5, 30 + 60 * ch, 45, 0.8, 0.5)
    this.crinkle.set(ch * 25, 0, 0.1, 1, 0.8)
    this.crLvl = taper(p.chewed, -6)
    this.dropK = onePoleCoef(1500, this.sr)
    this.hissF.allOff()
    this.hissF.f[0].hp(500, 0.7071)
    this.hissF.f[1].lp(Math.min(16000, top * 1.1), 0.7071)
    this.hissLvl = taper(p.hiss, T[1]) * (t === 3 ? 1.4 : 1)
    this.makeup = db(0.5 + 1.5 * sat)
  }

  run(s, n) {
    const r = this.r
    const tmp = this.tmp
    const env = this.env
    // record: saturation and head bump
    const L = this.satL
    const inv = 1 / L
    for (let q = 0; q < n; q++) s[q] = L * Math.tanh(s[q] * inv)
    this.recF.run(s, n)
    this.tape.run(s, n)
    this.wob.run(s, n, null)
    // dropouts: level falls and the highs vanish
    this.drop.render(env, n)
    let dl = this.dl
    const dk = this.dropK
    for (let q = 0; q < n; q++) {
      const e = env[q]
      dl += (s[q] - dl) * dk
      if (e > 0) s[q] = (s[q] * (1 - e) + dl * e * 0.6) * (1 - 0.75 * e)
    }
    this.dl = dl
    if (this.crLvl > 0) {
      this.crinkle.render(tmp, n)
      const g = this.crLvl
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
    }
    // tape hiss
    if (this.hissLvl > 0) {
      r.fill(tmp, n)
      this.hissF.run(tmp, n)
      const g = this.hissLvl * 2
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
    }
    const mk = this.makeup
    for (let q = 0; q < n; q++) s[q] *= mk
  }

  reset() {
    this.recF.reset()
    this.tape.reset()
    this.wob.reset()
    this.drop.reset()
    this.crinkle.reset()
    this.hissF.reset()
    this.dl = 0
  }
}

export default makeDevice({
  id: 'device.cassette',
  name: 'Cassette tape',
  about: 'Your voice on a cassette: tape hiss, wow and flutter, warm saturation, dropouts, a dull head, or a chewed-up tape.',
  params: [
    {
      id: 'tape', name: 'Tape', type: 'choice', def: 'ferric',
      options: [
        { v: 'ferric', name: 'Normal tape' },
        { v: 'chrome', name: 'Chrome tape' },
        { v: 'worn', name: 'Worn out tape' },
        { v: 'dub', name: 'Copy of a copy' },
      ],
    },
    { id: 'hiss', name: 'Hiss', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [15, 70] },
    { id: 'wow', name: 'Wow', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [10, 60] },
    { id: 'flutter', name: 'Flutter', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [10, 60] },
    { id: 'dropouts', name: 'Dropouts', type: 'number', min: 0, max: 100, step: 1, def: 10, unit: 'percent', rand: [0, 40] },
    { id: 'highLoss', name: 'Dull head', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [0, 60] },
    { id: 'saturation', name: 'Saturation', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [10, 70] },
    { id: 'chewed', name: 'Chewed tape', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 30] },
  ],
  cost: 2,
  talk: null,
  latency: (sr) => Math.max(4, Math.round(WOB_MS * 0.001 * sr)),
  build: (sr, p, rng) => new CassetteCore(sr, p, rng),
})
