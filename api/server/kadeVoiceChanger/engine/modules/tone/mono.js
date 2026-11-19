// modules/tone/mono.js - tone.mono, make mono or swap the sides.
//
// Technique: a 2 by 2 channel matrix (left out = a L + b R, right out =
// c L + d R). "Both sides mixed" uses the equal-weight sum (L + R) / 2 on
// both outputs, which keeps a centred voice at the same level; one side
// only copies that side to both; swap exchanges them. Live, the four matrix
// weights glide over 25 ms, so changing the choice crossfades instead of
// clicking. A mono take passes through untouched (there is nothing to mix
// or swap), and the channel count never changes.

import { bufLen } from '../../core/buf.js'
import { poleCoef, liveCopy } from './_dsp.js'

const MATS = {
  mix: [0.5, 0.5, 0.5, 0.5],
  left: [1, 0, 1, 0],
  right: [0, 1, 0, 1],
  swap: [0, 1, 1, 0],
}

class MonoProc {
  constructor(sr, p) {
    this.k = 1 - poleCoef(25, sr)
    this.m = new Float64Array(4)
    this.t = new Float64Array(4)
    this.set(p)
    this.m.set(this.t)
  }

  set(p) {
    const M = MATS[p.mode] || MATS.mix
    for (let j = 0; j < 4; j++) this.t[j] = M[j]
  }

  run(chs, nch, n) {
    if (nch < 2) return
    const L = chs[0]
    const R = chs[1]
    const m = this.m
    const t = this.t
    const k = this.k
    let a = m[0], b = m[1], c = m[2], d = m[3]
    const ta = t[0], tb = t[1], tc = t[2], td = t[3]
    for (let i = 0; i < n; i++) {
      if (a !== ta || b !== tb || c !== tc || d !== td) {
        a += (ta - a) * k
        b += (tb - b) * k
        c += (tc - c) * k
        d += (td - d) * k
        if (a - ta < 1e-7 && a - ta > -1e-7 && b - tb < 1e-7 && b - tb > -1e-7 && c - tc < 1e-7 && c - tc > -1e-7 && d - td < 1e-7 && d - td > -1e-7) {
          a = ta
          b = tb
          c = tc
          d = td
        }
      }
      const l = L[i]
      const r = R[i]
      L[i] = a * l + b * r
      R[i] = c * l + d * r
    }
    m[0] = a
    m[1] = b
    m[2] = c
    m[3] = d
  }
}

export default {
  id: 'tone.mono',
  name: 'Mono and swap',
  family: 'tone',
  about: 'Folds a stereo take to mono, keeps only the left or right side, or swaps the two sides.',
  params: [
    {
      id: 'mode', name: 'What to do', type: 'choice', def: 'mix',
      options: [
        { v: 'mix', name: 'Both sides mixed to mono' },
        { v: 'left', name: 'Left side only' },
        { v: 'right', name: 'Right side only' },
        { v: 'swap', name: 'Swap left and right' },
      ],
    },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 1,
  surprise: false,
  process(input, p) {
    const n = bufLen(input)
    if (!n || input.ch.length < 2) return input
    new MonoProc(input.sr, p).run(input.ch, 2, n)
    return input
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p) {
      const proc = new MonoProc(sr, p)
      return {
        process(ins, outs, n) {
          proc.run(outs, liveCopy(ins, outs, n), n)
        },
        set(np) {
          proc.set(np)
        },
        reset() {
          proc.m.set(proc.t)
        },
      }
    },
  },
}
