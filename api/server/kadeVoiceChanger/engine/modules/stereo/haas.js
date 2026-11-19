// stereo.haas - Short-delay widen: one ear hears the voice a few milliseconds late.
//
// Technique: the precedence effect (Haas 1951, "Uber den Einfluss eines
// Einfachechos auf die Horsamkeit von Sprache", Acustica 1; Wallach, Newman
// and Rosenzweig 1949). A copy delayed by roughly 1 to 40 ms is not heard as
// an echo but fuses with the first arrival: the voice seems to come from the
// leading side while the image spreads wide. Past about 35 ms the copy starts
// to separate into a slap. The late ear is optionally darkened with a
// one-pole low-pass, which both sounds like a far wall and softens the comb
// filter a mono fold-down would otherwise show. Delay changes glide through a
// cubic-interpolated fractional delay line (core/delay.js), so moving the
// slider never clicks.
//
// Mono in: the leading ear gets the voice, the late ear the delayed copy.
// Stereo in: each side keeps its own channel; the late side is delayed.

import { DelayLine } from '../../core/delay.js'
import { clamp, finite } from './_lib.js'

class HaasKernel {
  constructor(sr) {
    this.sr = sr
    this.line = new DelayLine(Math.ceil(0.045 * sr) + 8)
    this.sc = Math.exp(-1 / (0.03 * sr))
    this.gc = Math.exp(-1 / (0.01 * sr))
    this.tD = 0; this.cD = 0
    this.tG = 1; this.cG = 1
    this.tLp = 0.9; this.cLp = 0.9
    this.lp = 0
    this.leadLeft = true
  }

  set(p, snap) {
    const ms = clamp(finite(p.delay, 14), 1, 40)
    this.tD = (ms / 1000) * this.sr
    this.tG = Math.pow(10, clamp(finite(p.level, -1), -24, 0) / 20)
    const soft = clamp(finite(p.soften, 30), 0, 100) / 100
    const fc = Math.min(0.45 * this.sr, 18000 * Math.pow(2500 / 18000, soft))
    const g = Math.tan((Math.PI * fc) / this.sr)
    this.tLp = g / (1 + g)
    this.leadLeft = p.lead !== 'right'
    if (snap) {
      this.cD = this.tD; this.cG = this.tG; this.cLp = this.tLp
    }
  }

  reset() {
    this.line.clear()
    this.lp = 0
  }

  run(ins, outs, n) {
    const two = ins.length > 1
    const outTwo = outs.length > 1
    const leadLeft = this.leadLeft
    for (let i = 0; i < n; i++) {
      let a = ins[0][i]
      if (!(a > -1e30 && a < 1e30)) a = 0
      let b = two ? ins[1][i] : a
      if (!(b > -1e30 && b < 1e30)) b = 0
      const lead = leadLeft ? a : b
      const lateIn = leadLeft ? b : a
      this.cD = this.tD + (this.cD - this.tD) * this.sc
      this.cG = this.tG + (this.cG - this.tG) * this.gc
      this.cLp = this.tLp + (this.cLp - this.tLp) * this.gc
      this.line.write(lateIn)
      const d = this.line.read(this.cD)
      const v = (d - this.lp) * this.cLp
      const y = v + this.lp
      let s = y + v
      if (s < 1e-25 && s > -1e-25) s = 0
      this.lp = s
      const late = y * this.cG
      const l = leadLeft ? lead : late
      const r = leadLeft ? late : lead
      if (outTwo) {
        outs[0][i] = l
        outs[1][i] = r
      } else {
        outs[0][i] = 0.5 * (l + r)
      }
    }
  }
}

export default {
  id: 'stereo.haas',
  name: 'Short-delay widen',
  family: 'stereo',
  about: 'One ear hears your voice a few milliseconds late, so it sounds wide and leans toward the other side.',
  params: [
    { id: 'delay', name: 'Late ear delay', type: 'number', min: 1, max: 40, step: 0.5, def: 14, unit: 'ms', rand: [6, 25] },
    {
      id: 'lead', name: 'Heard first in', type: 'choice', def: 'left',
      options: [{ v: 'left', name: 'Left ear' }, { v: 'right', name: 'Right ear' }],
    },
    { id: 'level', name: 'Late ear level', type: 'number', min: -12, max: 0, step: 0.5, def: -1, unit: 'db', rand: [-4, 0] },
    { id: 'soften', name: 'Soften the late ear', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 60] },
  ],
  stereo: 'make',
  tail: (p) => clamp(finite(p && p.delay, 14), 1, 40) / 1000,
  warps: false,
  cost: 1,
  process(input, p) {
    const sr = input.sr
    const n0 = input.ch.length ? input.ch[0].length : 0
    const extra = n0 ? Math.ceil((clamp(finite(p.delay, 14), 1, 40) / 1000) * sr) + 2 : 0
    const n = n0 + extra
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    if (n0 === 0) return { sr, ch: [L, R] }
    const ins = input.ch.length > 1 ? [padTo(input.ch[0], n), padTo(input.ch[1], n)] : [padTo(input.ch[0], n)]
    const k = new HaasKernel(sr)
    k.set(p, true)
    k.run(ins, [L, R], n)
    return { sr, ch: [L, R] }
  },
  live: {
    latency: () => 0,
    create(sr, p) {
      const k = new HaasKernel(sr)
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

function padTo(s, n) {
  if (s.length === n) return s
  const o = new Float32Array(n)
  o.set(s.subarray(0, Math.min(n, s.length)))
  return o
}
