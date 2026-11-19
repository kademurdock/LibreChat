// modules/lofi/companding.js - lofi.companding, "Phone-line coding".
//
// Technique: ITU-T Recommendation G.711, the 64 kilobit-per-second coding of
// every digital telephone line: the voice band-limited (the 300 to 3400 Hz
// channel of ITU-T G.712), sampled at 8 kHz and coded to 8 bits on a
// segmented logarithmic scale, mu-law (North America and Japan) or A-law
// (the rest of the world). The coder in _chips.js follows the standard's
// segment structure bit for bit, so at 8 bits the result is exactly what a
// phone exchange does to a voice: fine steps for quiet sounds, coarse ones
// for loud sounds, and the faint fizz that rides on every word. Fewer bits
// throw away mantissa bits for a worse line; other rates bend the standard
// on purpose.
//
// Offline the rate change uses core/resample.js (windowed-sinc, alias free).
// Live mode cannot look ahead, so it uses an eighth-order Butterworth anti-
// alias filter, a sampler with linear interpolation at the exact sample
// instants, the same coder, a linear-interpolating reconstruction and the
// same Butterworth after it; it sounds the same, delayed by one 8 kHz sample
// and the two filters' group delay.

import { resampleTo } from '../../core/resample.js'
import { LP, HP, FilterBank, clamp, num, fitLength } from './_lib.js'
import { muEncode, muDecode, aEncode, aDecode, coarsenG711 } from './_chips.js'

const BUTTER8 = [0.5098, 0.6013, 0.9, 2.5629]
const BUTTER4 = [0.5412, 1.3066]
const BAND_LO = 300
const BAND_HI = 3400

function code1(x, isA, bits) {
  let v = Math.round(x * 32768)
  if (!(v >= -32768)) v = -32768
  if (v > 32767) v = 32767
  let c = isA ? aEncode(v) : muEncode(v)
  if (bits < 8) c = coarsenG711(c, bits, isA)
  return (isA ? aDecode(c) : muDecode(c)) / 32768
}

function roundTrip(sig, isA, bits) {
  for (let i = 0; i < sig.length; i++) sig[i] = code1(sig[i], isA, bits)
  return sig
}

function lpCut(rate, band) {
  return band ? Math.min(BAND_HI, 0.45 * rate) : 0.45 * rate
}

// ---------------------------------------------------------------- live kernel

class CompandChan {
  constructor(sr) {
    this.aa = new FilterBank(sr, 6)
    this.rc = new FilterBank(sr, 4)
    this.prev = 0
    this.ph = 0
    this.c0 = 0
    this.c1 = 0
  }

  reset() {
    this.aa.reset()
    this.rc.reset()
    this.prev = 0
    this.ph = 0
    this.c0 = 0
    this.c1 = 0
  }
}

class CompandKernel {
  constructor(sr, p) {
    this.sr = sr
    this.chs = [new CompandChan(sr), new CompandChan(sr)]
    this.aaRows = [[HP, BAND_LO, BUTTER4[0], 0], [HP, BAND_LO, BUTTER4[1], 0], [LP, 3400, BUTTER8[0], 0], [LP, 3400, BUTTER8[1], 0], [LP, 3400, BUTTER8[2], 0], [LP, 3400, BUTTER8[3], 0]]
    this.rcRows = [[LP, 3400, BUTTER8[0], 0], [LP, 3400, BUTTER8[1], 0], [LP, 3400, BUTTER8[2], 0], [LP, 3400, BUTTER8[3], 0]]
    this.set(p || {})
  }

  set(p) {
    this.isA = !!(p && p.law === 'a')
    this.bits = clamp(Math.round(num(p && p.bits, 8)), 4, 8)
    const rate = clamp(num(p && p.rate, 8000), 2000, 48000)
    const band = p ? p.band !== false : true
    if (rate !== this.rate || band !== this.band) {
      this.rate = rate
      this.band = band
      this.inc = rate / this.sr
      const fc = lpCut(rate, band)
      for (let i = 2; i < 6; i++) this.aaRows[i][1] = fc
      for (let i = 0; i < 4; i++) this.rcRows[i][1] = fc
      for (let c = 0; c < 2; c++) {
        const ch = this.chs[c]
        if (band) ch.aa.load(this.aaRows)
        else {
          // skip the two band high passes
          for (let i = 0; i < 4; i++) {
            const r = this.aaRows[i + 2]
            ch.aa.f[i].set(r[0], r[1], r[2], r[3])
          }
          ch.aa.n = 4
        }
        ch.rc.load(this.rcRows)
      }
    }
  }

  reset() {
    this.chs[0].reset()
    this.chs[1].reset()
  }

  _tick(ch, x) {
    const a = ch.aa.tick(x)
    const inc = this.inc
    if (inc >= 1) return code1(a, this.isA, this.bits)
    ch.ph += inc
    if (ch.ph >= 1) {
      ch.ph -= 1
      const t = 1 - ch.ph / inc
      const s = ch.prev + (a - ch.prev) * t
      ch.c0 = ch.c1
      ch.c1 = code1(s, this.isA, this.bits)
    }
    ch.prev = a
    return ch.rc.tick(ch.c0 + (ch.c1 - ch.c0) * ch.ph)
  }

  process(ins, outs, n) {
    const a0 = ins[0]
    const a1 = ins.length > 1 ? ins[1] : ins[0]
    const o0 = outs[0]
    const o1 = outs.length > 1 ? outs[1] : null
    const c0 = this.chs[0]
    const c1 = this.chs[1]
    for (let i = 0; i < n; i++) {
      const v0 = a0[i]
      const v1 = a1[i]
      // a host may hand over a stray NaN or Infinity: treat it as silence
      const x0 = v0 > -1e30 && v0 < 1e30 ? v0 : 0
      const x1 = v1 > -1e30 && v1 < 1e30 ? v1 : 0
      o0[i] = this._tick(c0, x0)
      if (o1) o1[i] = this._tick(c1, x1)
    }
    c0.aa.heal()
    c0.rc.heal()
    c1.aa.heal()
    c1.rc.heal()
  }
}

// Delay of the live path: one codec sample plus the DC group delay of the two
// eighth-order Butterworth filters, sum(sin((2k - 1) pi / 16)) / (2 pi fc) each.
const BUTTER8_TAU = 1 / Math.sin(Math.PI / 16)

export default {
  id: 'lofi.companding',
  name: 'Phone-line coding',
  family: 'lofi',
  about: 'The exact digital phone-line sound: 8 kilohertz, 8-bit logarithmic coding, the faint fizz on every word. Fewer bits make a worse line.',
  params: [
    {
      id: 'law', name: 'Coding', type: 'choice', def: 'mu',
      options: [
        { v: 'mu', name: 'North American and Japanese lines' },
        { v: 'a', name: 'European and international lines' },
      ],
    },
    { id: 'rate', name: 'Sample rate', type: 'number', min: 4000, max: 16000, step: 500, def: 8000, unit: 'hz', rand: [6000, 11000] },
    { id: 'bits', name: 'Bits', type: 'number', min: 4, max: 8, step: 1, def: 8, unit: 'bits', rand: [5, 8] },
    { id: 'band', name: 'Phone band filter', type: 'bool', def: true },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 2,
  process(input, p, ctx) {
    const sr = input.sr
    const n = input.ch && input.ch.length ? input.ch[0].length : 0
    const rate = clamp(num(p.rate, 8000), 2000, 48000)
    const isA = p.law === 'a'
    const bits = clamp(Math.round(num(p.bits, 8)), 4, 8)
    const band = p.band !== false
    const ch = input.ch.map((x) => {
      if (n === 0) return new Float32Array(0)
      let y = rate === sr ? Float32Array.from(x) : resampleTo(x, sr, rate)
      for (let i = 0; i < y.length; i++) if (!Number.isFinite(y[i])) y[i] = 0
      if (band) {
        const fb = new FilterBank(rate, 4).load([
          [HP, BAND_LO, BUTTER4[0], 0], [HP, BAND_LO, BUTTER4[1], 0],
          [LP, BAND_HI, BUTTER4[0], 0], [LP, BAND_HI, BUTTER4[1], 0],
        ])
        fb.run(y)
      }
      roundTrip(y, isA, bits)
      const back = rate === sr ? y : resampleTo(y, rate, sr)
      return fitLength(back, n)
    })
    return { sr, ch }
  },
  live: {
    latency(p, sr) {
      const rate = clamp(num(p && p.rate, 8000), 2000, 48000)
      if (rate >= sr) return 0
      const fc = lpCut(rate, p ? p.band !== false : true)
      return Math.max(0, Math.round(sr / rate + (2 * BUTTER8_TAU * sr) / (2 * Math.PI * fc)))
    },
    create(sr, p) {
      return new CompandKernel(sr, p)
    },
  },
}
