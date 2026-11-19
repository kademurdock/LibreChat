// modules/tone/eq.js - tone.eq, a six-band parametric equalizer.
//
// Technique: six second-order sections in cascade, each one a bell, shelf,
// cut or notch from Robert Bristow-Johnson's "Cookbook formulae for audio EQ
// biquad filter coefficients", run in Direct Form I with float64 state
// (modules/tone/_dsp.js EqBank). Width is a plain "sharpness" percent that
// maps to the cookbook Q on a log scale: 25 percent is Q 0.71 (the shelf
// slope of the cookbook's S = 1, and a Butterworth cut), 33 percent is Q 1
// (about 1.4 octaves wide), 100 percent is Q 16 (a surgical notch).
//
// The bands start on a gentle voice polish (a low cut at 80 Hz, a little
// less mud at 250 Hz, a touch of presence at 3 kHz and air at 10 kHz), so
// the effect does something tasteful the moment it is added. Setting every
// gain to 0 and band 1 to Off makes it flat.
//
// Live: the same bank; a slider move glides the coefficients over about 20
// ms on a fixed 16-sample grid, so moves never click and the live output is
// sample-identical to the offline render.

import { bufLen } from '../../core/buf.js'
import { EqBank, GainGlide, OFF, BELL, LOWSHELF, HIGHSHELF, LOWCUT, HIGHCUT, NOTCH, sharpToQ, dbLin, safety, liveCopy } from './_dsp.js'

const TYPE_OPTIONS = [
  { v: 'off', name: 'Off' },
  { v: 'bell', name: 'Bell' },
  { v: 'lowshelf', name: 'Low shelf' },
  { v: 'highshelf', name: 'High shelf' },
  { v: 'lowcut', name: 'Low cut' },
  { v: 'highcut', name: 'High cut' },
  { v: 'notch', name: 'Notch' },
]
const TYPE_CODE = { off: OFF, bell: BELL, lowshelf: LOWSHELF, highshelf: HIGHSHELF, lowcut: LOWCUT, highcut: HIGHCUT, notch: NOTCH }

// type, frequency, gain, sharpness
const START = [
  ['lowcut', 80, 0, 25],
  ['bell', 250, -2, 33],
  ['bell', 800, 0, 33],
  ['bell', 3000, 2, 33],
  ['bell', 6500, 0, 33],
  ['highshelf', 10000, 3, 25],
]

const BANDS = 6
const T_ID = []
const F_ID = []
const G_ID = []
const Q_ID = []
const params = []
for (let k = 0; k < BANDS; k++) {
  const b = 'band' + (k + 1)
  T_ID.push(b + 'Type')
  F_ID.push(b + 'Freq')
  G_ID.push(b + 'Gain')
  Q_ID.push(b + 'Q')
  const s = START[k]
  params.push(
    { id: b + 'Type', name: 'Band ' + (k + 1) + ' shape', type: 'choice', def: s[0], options: TYPE_OPTIONS },
    { id: b + 'Freq', name: 'Band ' + (k + 1) + ' frequency', type: 'number', min: 20, max: 20000, step: 1, def: s[1], unit: 'hz' },
    { id: b + 'Gain', name: 'Band ' + (k + 1) + ' boost or cut', type: 'number', min: -24, max: 24, step: 0.5, def: s[2], unit: 'db' },
    { id: b + 'Q', name: 'Band ' + (k + 1) + ' sharpness', type: 'number', min: 0, max: 100, step: 1, def: s[3], unit: 'percent' },
  )
}
params.push({ id: 'output', name: 'Output volume', type: 'number', min: -24, max: 12, step: 0.5, def: 0, unit: 'db' })

class EqProc {
  constructor(sr, p) {
    this.bank = new EqBank(sr, BANDS, 2, 20)
    this.out = new GainGlide(sr, 20)
    this.set(p)
    this.bank.snap()
    this.out.to(this.out.gt, true)
  }

  set(p) {
    for (let k = 0; k < BANDS; k++) {
      const code = TYPE_CODE[p[T_ID[k]]]
      this.bank.design(k, code === undefined ? OFF : code, p[F_ID[k]], sharpToQ(p[Q_ID[k]]), p[G_ID[k]])
    }
    this.out.to(dbLin(p.output))
  }

  run(chs, nch, n) {
    this.bank.run(chs, nch, n)
    this.out.apply(chs, nch, n)
    safety(chs, nch, n)
  }

  reset() {
    this.bank.reset()
  }
}

export default {
  id: 'tone.eq',
  name: 'Equalizer',
  family: 'tone',
  about: 'Six bands of boost and cut, each a bell, shelf, cut or notch. Starts on a gentle voice polish; set the gains to 0 for flat.',
  params,
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 1,
  surprise: false,
  process(input, p) {
    const n = bufLen(input)
    if (!n) return input
    const proc = new EqProc(input.sr, p)
    proc.run(input.ch, input.ch.length, n)
    return input
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p) {
      const proc = new EqProc(sr, p)
      return {
        process(ins, outs, n) {
          proc.run(outs, liveCopy(ins, outs, n), n)
        },
        set(np) {
          proc.set(np)
        },
        reset() {
          proc.reset()
        },
      }
    },
  },
}
