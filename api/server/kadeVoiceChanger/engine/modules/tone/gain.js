// modules/tone/gain.js - tone.gain, volume and polarity.
//
// Technique: a plain multiplier. Live, the volume glides to new settings
// over 20 ms (a one-pole on the gain, per sample), so a slider never
// zippers, and flipping the polarity fades through zero instead of
// clicking. Offline the gain is applied exactly (past 12 dB over full
// scale a soft ceiling takes over, so no setting can pass a peak of 8 on
// down the chain). Polarity flip turns the
// waveform upside down: silent on its own, but it decides whether two
// copies of a voice add up or cancel when mixed.

import { bufLen } from '../../core/buf.js'
import { GainGlide, dbLin, safety, liveCopy } from './_dsp.js'

function target(p) {
  return (p.invert === true ? -1 : 1) * dbLin(p.db)
}

export default {
  id: 'tone.gain',
  name: 'Volume',
  family: 'tone',
  about: 'Turns the voice up or down, and can flip its polarity.',
  params: [
    { id: 'db', name: 'Volume change', type: 'number', min: -48, max: 18, step: 0.5, def: 0, unit: 'db' },
    { id: 'invert', name: 'Flip polarity', type: 'bool', def: false },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 1,
  surprise: false,
  process(input, p) {
    const n = bufLen(input)
    if (!n) return input
    const g = target(p)
    if (g === 1) return input
    for (let c = 0; c < input.ch.length; c++) {
      const a = input.ch[c]
      for (let i = 0; i < n; i++) a[i] *= g
    }
    safety(input.ch, input.ch.length, n)
    return input
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p) {
      const gg = new GainGlide(sr, 20, target(p))
      return {
        process(ins, outs, n) {
          const nch = liveCopy(ins, outs, n)
          gg.apply(outs, nch, n)
          safety(outs, nch, n)
        },
        set(np) {
          gg.to(target(np))
        },
        reset() {
          gg.to(gg.gt, true)
        },
      }
    },
  },
}
