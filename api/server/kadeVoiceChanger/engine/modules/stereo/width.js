// stereo.width - Width: mid/side widening, plus stereo made from a mono voice.
//
// Technique: mid/side matrixing (Blumlein's sum and difference, as used in
// every mastering width control): M = (L + R) / 2, S = (L - R) / 2, the side
// is scaled, then L = M + S, R = M - S. Because only the side changes, the
// mono fold-down (L + R) / 2 is exactly the mid: widening never thins a mono
// listener.
//
// A mono voice has no side to widen, so a side is made from the mid with a
// decorrelator: four Schroeder allpass filters in series (Schroeder 1962,
// "Natural sounding artificial reverberation", JAES 10) with mutually prime
// delays. An allpass keeps every frequency's level and scrambles its phase,
// so M + A(M) and M - A(M) are two different-sounding but complementary
// ears (Gerzon's and Kendall's decorrelation approach to pseudo-stereo,
// Kendall 1995, "The decorrelation of audio signals and its impact on
// spatial imagery", Computer Music Journal 19(4)). They still sum to exactly
// M in mono. The lowest notes are kept in the middle with a 150 Hz high-pass
// on the side, as in vinyl mastering, so bass stays solid and mono-safe.
//
// One streaming kernel serves both the offline process and live mode, so
// they sound the same.

import { Biquad } from '../../core/biquad.js'
import { clamp, finite } from './_lib.js'

const AP_MS = [4.13, 6.37, 9.71, 13.93]
const AP_G = [0.62, -0.58, 0.55, -0.5]

class WidthKernel {
  constructor(sr) {
    this.sr = sr
    this.bufs = []
    this.len = new Int32Array(4)
    this.pos = new Int32Array(4)
    for (let k = 0; k < 4; k++) {
      const L = Math.max(2, Math.round((AP_MS[k] / 1000) * sr))
      this.len[k] = L
      this.bufs.push(new Float32Array(L))
    }
    this.hpIn = new Biquad('highpass', sr, Math.min(150, 0.4 * sr), 0.707)
    this.hpSyn = new Biquad('highpass', sr, Math.min(150, 0.4 * sr), 0.707)
    this.sc = Math.exp(-1 / (0.01 * sr))
    this.tSide = 1; this.tSyn = 0; this.tMid = 1; this.tBass = 1
    this.cSide = 1; this.cSyn = 0; this.cMid = 1; this.cBass = 1
  }

  set(p, snap) {
    const w = clamp(finite(p.width, 1.4), 0, 2.5)
    const fill = clamp(finite(p.fill, 50), 0, 100) / 100
    const bal = clamp(finite(p.balance, 0), -100, 100) / 100
    const midG = bal > 0 ? 1 - 0.75 * bal : 1
    const sideG = bal < 0 ? 1 + 0.75 * bal : 1 + 0.25 * bal
    this.tSide = w * sideG
    this.tSyn = 0.72 * fill
    this.tMid = midG
    this.tBass = p.bassMono === false ? 0 : 1
    if (snap) {
      this.cSide = this.tSide; this.cSyn = this.tSyn; this.cMid = this.tMid; this.cBass = this.tBass
    }
  }

  reset() {
    for (let k = 0; k < 4; k++) {
      this.bufs[k].fill(0)
      this.pos[k] = 0
    }
    this.hpIn.reset()
    this.hpSyn.reset()
  }

  run(ins, outs, n) {
    const two = ins.length > 1
    const outTwo = outs.length > 1
    const sc = this.sc
    for (let i = 0; i < n; i++) {
      let l = ins[0][i]
      if (!(l > -1e30 && l < 1e30)) l = 0
      let r = two ? ins[1][i] : l
      if (!(r > -1e30 && r < 1e30)) r = 0
      const m = 0.5 * (l + r)
      const sIn = 0.5 * (l - r)
      // decorrelated copy of the mid through the allpass chain
      let a = m
      for (let k = 0; k < 4; k++) {
        const b = this.bufs[k]
        const p = this.pos[k]
        const g = AP_G[k]
        const wd = b[p]
        let w = a + g * wd
        if (w < 1e-25 && w > -1e-25) w = 0
        b[p] = w
        a = wd - g * w
        this.pos[k] = p + 1 === this.len[k] ? 0 : p + 1
      }
      this.cSide = this.tSide + (this.cSide - this.tSide) * sc
      this.cSyn = this.tSyn + (this.cSyn - this.tSyn) * sc
      this.cMid = this.tMid + (this.cMid - this.tMid) * sc
      this.cBass = this.tBass + (this.cBass - this.tBass) * sc
      const hs = this.hpSyn.tick(a)
      const syn = a + (hs - a) * this.cBass
      // a stereo input's own bass side is never made wider than it was
      // while the switch is on (narrowing still narrows it)
      const hi = this.hpIn.tick(sIn)
      const lo = sIn - hi
      const cs = this.cSide
      const loG = cs + ((cs < 1 ? cs : 1) - cs) * this.cBass
      const s = hi * cs + lo * loG + cs * this.cSyn * syn
      const mm = this.cMid * m
      if (outTwo) {
        outs[0][i] = mm + s
        outs[1][i] = mm - s
      } else {
        outs[0][i] = mm
      }
    }
  }
}

export default {
  id: 'stereo.width',
  name: 'Width',
  family: 'stereo',
  about: 'Makes the sound wider or narrower. A mono voice is spread into real stereo that still sounds right in mono.',
  params: [
    { id: 'width', name: 'Width', type: 'number', min: 0, max: 2.5, step: 0.05, def: 1.4, unit: 'x', rand: [1.1, 2] },
    { id: 'fill', name: 'Stereo from mono', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [25, 85] },
    {
      id: 'balance', name: 'Center or sides', type: 'number', min: -100, max: 100, step: 1, def: 0, unit: 'percent',
      words: { neg: 'more center', pos: 'more sides', zero: 'even' }, rand: [-20, 30],
    },
    { id: 'bassMono', name: 'Keep bass in the middle', type: 'bool', def: true },
  ],
  stereo: 'make',
  tail: () => 0,
  warps: false,
  cost: 1,
  process(input, p, ctx) {
    const sr = input.sr
    const n = input.ch.length ? input.ch[0].length : 0
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    if (n === 0) return { sr, ch: [L, R] }
    const k = new WidthKernel(sr)
    k.set(p, true)
    k.run(input.ch.length > 1 ? [input.ch[0], input.ch[1]] : [input.ch[0]], [L, R], n)
    return { sr, ch: [L, R] }
  },
  live: {
    latency: () => 0,
    create(sr, p) {
      const k = new WidthKernel(sr)
      k.set(p, true)
      return {
        process(ins, outs, n) {
          k.run(ins, outs, n)
        },
        set(np) {
          k.set(np, false)
        },
        reset() {
          k.reset()
        },
      }
    },
  },
}
