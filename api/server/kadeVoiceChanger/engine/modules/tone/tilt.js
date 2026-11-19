// modules/tone/tilt.js - tone.tilt, one knob from darker to brighter.
//
// Technique: the tilt equaliser of mastering consoles. "Gentle" is a single
// first-order shelf, H(s) = G (s + wp/G) / (s + G wp), made digital with the
// bilinear transform prewarped at the pivot (modules/tone/_dsp.js TILT1):
// the top end moves by the amount, the bottom end by the same amount the
// other way, and the pivot does not move at all. A speech-weighted level
// correction (modules/tone/_dsp.js SpeechWeight) then keeps the loudness of
// the voice where it was while its colour swings; offline the take's own
// integrated loudness (BS.1770) is measured before and after and matched
// exactly. "Steep" pairs a low shelf
// and a high shelf from the RBJ audio EQ cookbook, both centred on the
// pivot (Q 0.5), for a quicker turn between the two ends.
//
// Live: the same filtering as the offline render (coefficients glide on a
// fixed 16-sample grid). Live cannot measure the whole take, so it starts
// from the speech-weighted estimate and then matches loudness as you talk
// (modules/tone/_dsp.js LoudMatch), settling within a second or two.

import { bufLen } from '../../core/buf.js'
import { lufs, kWeightingCoefs } from '../../core/loudness.js'
import { EqBank, GainGlide, SpeechWeight, LoudMatch, OFF, TILT1, LOWSHELF, HIGHSHELF, matchLoudness, liveCopy } from './_dsp.js'

class TiltProc {
  constructor(sr, p) {
    this.bank = new EqBank(sr, 2, 2, 25)
    this.out = new GainGlide(sr, 25)
    this.meter = new SpeechWeight(sr)
    this.match = null
    this.est = 1
    this.set(p)
    this.bank.snap()
    this.out.to(this.out.gt, true)
  }

  set(p) {
    const a = +p.amount || 0
    if (p.slope === 'steep') {
      this.bank.design(0, LOWSHELF, p.pivot, 0.5, -a)
      this.bank.design(1, HIGHSHELF, p.pivot, 0.5, a)
    } else {
      this.bank.design(0, TILT1, p.pivot, 0.7071, a)
      this.bank.design(1, OFF, 1000, 1, 0)
    }
    this.est = this.meter.correction(this.bank.tgt, 2)
    if (this.match) this.match.restart(this.est)
    this.out.to(this.est)
  }

  run(chs, nch, n) {
    const m = this.match
    if (!m) {
      this.bank.run(chs, nch, n)
      this.out.apply(chs, nch, n)
      return
    }
    // live: work in pieces that end on the loudness window grid
    let off = 0
    while (off < n) {
      let len = m.toBoundary()
      if (len > n - off) len = n - off
      m.measureIn(chs, nch, len, off)
      this.bank.run(chs, nch, len, off)
      m.measureRaw(chs, nch, len, off)
      this.out.apply(chs, nch, len, off)
      if (m.endWindow()) this.out.to(m.gain())
      off += len
    }
  }

  reset() {
    this.bank.reset()
  }
}

export default {
  id: 'tone.tilt',
  name: 'Tilt',
  family: 'tone',
  about: 'One knob from darker to brighter: the top and bottom of your voice see-saw around a middle point, and the overall volume stays put.',
  params: [
    {
      id: 'amount', name: 'Darker or brighter', type: 'number', min: -12, max: 12, step: 0.5, def: 3, unit: 'db',
      words: { neg: 'darker', pos: 'brighter', zero: 'even' }, rand: [-6, 6],
    },
    { id: 'pivot', name: 'Middle point', type: 'number', min: 150, max: 6000, step: 10, def: 900, unit: 'hz', rand: [400, 2500] },
    {
      id: 'slope', name: 'Turn', type: 'choice', def: 'gentle',
      options: [{ v: 'gentle', name: 'Gentle' }, { v: 'steep', name: 'Steep' }],
    },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 1,
  process(input, p) {
    const n = bufLen(input)
    if (!n) return input
    const before = lufs(input)
    new TiltProc(input.sr, p).run(input.ch, input.ch.length, n)
    matchLoudness(input, before, lufs)
    return input
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p) {
      const proc = new TiltProc(sr, p)
      proc.match = new LoudMatch(sr, kWeightingCoefs(sr))
      proc.match.restart(proc.est)
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
