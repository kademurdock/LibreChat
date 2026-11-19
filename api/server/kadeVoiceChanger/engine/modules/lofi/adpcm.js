// modules/lofi/adpcm.js - lofi.adpcm, "4-bit ADPCM".
//
// Technique: adaptive differential pulse-code modulation as published by the
// Interactive Multimedia Association (IMA, "Recommended Practices for
// Enhancing Digital Audio Compatibility in Multimedia Systems", 1992, the
// DVI algorithm used by old computer games and sound files) and by Dialogic
// (application note "Dialogic ADPCM Algorithm", 1988, the 12-bit coding of
// the voice chips in arcade boards, answering machines and toys). Each
// sample is coded as a few bits of difference from a running prediction;
// the step size adapts after every code, so loud passages get coarse steps
// (a hiss that follows the voice) and sharp attacks overload the step for a
// moment (a rough, splashy edge). Two, three and five-bit versions use the
// same step tables with the index tables of the SWF format's ADPCM. The
// coders live in _chips.js.
//
// The take is resampled to the coding rate with core/resample.js (the
// converter a developer would have used), coded, decoded and brought back
// to the take's rate either smoothly (sinc interpolation, a well filtered
// sound card) or stair-stepped (each value held, like a bare converter with
// no reconstruction filter, which adds the bright buzz of its images).

import { resampleTo } from '../../core/resample.js'
import { peak } from '../../core/buf.js'
import { adpcmCode } from './_chips.js'
import { holdToRate, fitLength, clamp, num } from './_lib.js'

export default {
  id: 'lofi.adpcm',
  name: '4-bit ADPCM',
  family: 'lofi',
  about: 'The squeezed sound of old game and answering-machine samples: a hiss that follows your voice and splashy edges on sharp sounds.',
  params: [
    { id: 'rate', name: 'Sample rate', type: 'number', min: 4000, max: 32000, step: 25, def: 11025, unit: 'hz', rand: [6000, 22050] },
    { id: 'bits', name: 'Bits', type: 'number', min: 2, max: 5, step: 1, def: 4, unit: 'bits', rand: [3, 4] },
    {
      id: 'chip', name: 'Coder', type: 'choice', def: 'ima',
      options: [
        { v: 'ima', name: 'Computer sound file' },
        { v: 'oki', name: 'Voice chip, 12-bit' },
      ],
    },
    {
      id: 'playback', name: 'Playback', type: 'choice', def: 'smooth',
      options: [
        { v: 'smooth', name: 'Smooth' },
        { v: 'stepped', name: 'Stair-stepped' },
      ],
    },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 2,
  process(input, p, ctx) {
    const sr = input.sr
    const n = input.ch && input.ch.length ? input.ch[0].length : 0
    const rate = clamp(num(p.rate, 11025), 1000, 192000)
    const bits = clamp(Math.round(num(p.bits, 4)), 2, 5)
    const oki = p.chip === 'oki'
    const full = oki ? 2047 : 32767
    // normalise into the coder like a developer would, then give the level back
    const pk = peak(input)
    const norm = pk > 1e-9 ? Math.min(0.9 / pk, 1000) : 1
    const scale = full * norm
    const ch = input.ch.map((x) => {
      if (n === 0) return new Float32Array(0)
      const y = rate === sr ? Float64Array.from(x) : resampleTo(x, sr, rate)
      for (let i = 0; i < y.length; i++) {
        const v = y[i] * scale
        y[i] = Number.isFinite(v) ? v : 0
      }
      const dec = new Float32Array(y.length)
      adpcmCode(y, dec, bits, oki ? 'oki' : 'ima')
      for (let i = 0; i < dec.length; i++) dec[i] /= scale
      let out
      if (p.playback === 'stepped') out = holdToRate(dec, rate, sr, n)
      else out = rate === sr ? dec : resampleTo(dec, rate, sr)
      return fitLength(out, n)
    })
    return { sr, ch }
  },
}
