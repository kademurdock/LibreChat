// modules/tone/deess.js - tone.deess, a de-esser that does not lisp.
//
// Technique: a split-band dynamic de-esser. A de-esser lisps when it turns
// the whole voice down on every "s", when it cuts so deep that the hiss
// that makes an "s" an "s" is gone, or when it confuses bright vowels with
// sibilance. This one avoids all three:
// - Only the sibilant band is turned down. The band is taken out with a
//   fixed band pass (a 0 dB peak RBJ cookbook section around the chosen
//   frequency, about an octave and a half wide) or, in "whole top" mode, a
//   high pass, and the output is x + (g - 1) * band(x). With g = 1 that is
//   the untouched voice; the filters never change while it works, only the
//   scalar g, so there is no coefficient zipper. The "focused" band leaves
//   the air above it alone, which keeps the "s" crisp.
// - Detection is relative, in two ways. The band's level is compared with
//   a slowly falling peak of the whole voice's 10 ms level (how loud you
//   have been talking), so the threshold means "how far below your own
//   voice an s may sit" and works at any recording level. And a sibilance
//   test (the band carries most of the energy at that moment, as it does in
//   "s", "sh" and "z" but not in vowels) keeps bright vowels untouched.
// - The reduction is capped by "Most reduction" (8 dB by default, enough to
//   tame a harsh "s" and never enough to erase it), uses a soft knee and a
//   4:1 slope, with a 1 ms attack and 30 ms release.
// "Hear what is removed" plays only the part being taken away, so settings
// can be checked by ear (live, switching it crossfades over 20 ms).
//
// Live: same code on a fixed grid, identical samples to the offline render.

import { bufLen } from '../../core/buf.js'
import { EqBank, LOWCUT, HIGHCUT, BANDPASS, clamp, poleCoef, powDb, smoothstep, liveCopy } from './_dsp.js'

const LN10_20 = Math.LN10 / 20
const BLOCK = 128
const SLOPE = 0.75 // 4:1
const KNEE = 6

class DeessProc {
  constructor(sr, p) {
    this.sr = sr
    this.sc = new EqBank(sr, 2, 2, 30)
    this.bd = new EqBank(sr, 1, 2, 30)
    this.scBuf = [new Float64Array(BLOCK), new Float64Array(BLOCK)]
    this.bdBuf = [new Float64Array(BLOCK), new Float64Array(BLOCK)]
    // band and full-band levels: mean squares, 1 ms rise, 15 ms fall
    this.fa = poleCoef(1, sr)
    this.fr = poleCoef(15, sr)
    // the voice reference: a 10 ms mean square, held with a slow fall
    this.cm = poleCoef(10, sr)
    this.ra = poleCoef(5, sr)
    this.rr = poleCoef(1500, sr)
    this.pm = 0
    this.ga = poleCoef(1, sr)
    this.gr = poleCoef(30, sr)
    this.ps = 0
    this.pf = 0
    this.pr = 0
    this.s = 0
    this.lk = 1 - poleCoef(20, sr)
    this.set(p)
    this.lm = this.lmT
    this.sc.snap()
    this.bd.snap()
  }

  set(p) {
    const sr = this.sr
    const f = clamp(+p.freq || 7000, 1000, 0.42 * sr)
    this.sc.design(0, LOWCUT, 0.7 * f, 0.7071, 0)
    this.sc.design(1, HIGHCUT, Math.min(2.2 * f, 0.46 * sr), 0.7071, 0)
    if (p.mode === 'top') this.bd.design(0, LOWCUT, 0.8 * f, 0.7071, 0)
    else this.bd.design(0, BANDPASS, f, 0.9, 0)
    this.thr = clamp(+p.threshold, -60, 0)
    this.range = clamp(+p.range, 0, 40)
    this.lmT = p.listen === true ? 1 : 0
  }

  run(chs, nch, n) {
    for (let i0 = 0; i0 < n; i0 += BLOCK) {
      const m = n - i0 < BLOCK ? n - i0 : BLOCK
      this._block(chs, nch > 1 ? 2 : 1, i0, m)
    }
  }

  _block(chs, nc, i0, m) {
    const sc = this.scBuf
    const bd = this.bdBuf
    for (let c = 0; c < nc; c++) {
      const x = chs[c]
      const a = sc[c]
      const b = bd[c]
      for (let i = 0; i < m; i++) {
        let v = x[i0 + i]
        if (!(v < 1e6 && v > -1e6)) v = 0
        a[i] = v
        b[i] = v
      }
    }
    this.sc.run(sc, nc, m)
    this.bd.run(bd, nc, m)
    const A = chs[0]
    const B = nc > 1 ? chs[1] : null
    const sa = sc[0]
    const sb = sc[1]
    const ba = bd[0]
    const bb = bd[1]
    let ps = this.ps
    let pf = this.pf
    let pr = this.pr
    let pm = this.pm
    const cm = this.cm
    let s = this.s
    const fa = this.fa
    const fr = this.fr
    const ra = this.ra
    const rr = this.rr
    const thr = this.thr
    const range = this.range
    const lmT = this.lmT
    const lk = this.lk
    let lm = this.lm
    for (let i = 0; i < m; i++) {
      let xa = A[i0 + i]
      if (!(xa < 1e6 && xa > -1e6)) xa = 0
      let xs = sa[i] * sa[i]
      let xf = xa * xa
      let xb = 0
      if (B) {
        xb = B[i0 + i]
        if (!(xb < 1e6 && xb > -1e6)) xb = 0
        if (sb[i] * sb[i] > xs) xs = sb[i] * sb[i]
        if (xb * xb > xf) xf = xb * xb
      }
      ps = xs > ps ? xs + fa * (ps - xs) : xs + fr * (ps - xs)
      pf = xf > pf ? xf + fa * (pf - xf) : xf + fr * (pf - xf)
      pm = xf + cm * (pm - xf)
      pr = pm > pr ? pm + ra * (pr - pm) : pm + rr * (pr - pm)
      if (ps < 1e-30) ps = 0
      if (pf < 1e-30) pf = 0
      if (pm < 1e-30) pm = 0
      if (pr < 1e-30) pr = 0
      let want = 0
      if (ps > 1e-14) {
        const Ls = powDb(ps)
        const over = Ls - (powDb(pr) + thr)
        if (over > -KNEE / 2) {
          want = over >= KNEE / 2 ? SLOPE * over : (SLOPE * (over + KNEE / 2) * (over + KNEE / 2)) / (2 * KNEE)
          if (want > range) want = range
          want *= smoothstep((Ls - powDb(pf) + 15) / 10)
        }
      }
      s = want > s ? want + this.ga * (s - want) : want + this.gr * (s - want)
      if (s < 1e-9) s = 0
      const g = s === 0 ? 1 : Math.exp(-s * LN10_20)
      if (lm !== lmT) {
        lm += (lmT - lm) * lk
        if (lm - lmT < 1e-6 && lm - lmT > -1e-6) lm = lmT
      }
      if (lm === 0) {
        A[i0 + i] = xa + (g - 1) * ba[i]
        if (B) B[i0 + i] = xb + (g - 1) * bb[i]
      } else if (lm === 1) {
        A[i0 + i] = (1 - g) * ba[i]
        if (B) B[i0 + i] = (1 - g) * bb[i]
      } else {
        // between the voice and what is removed
        const ya = xa + (g - 1) * ba[i]
        A[i0 + i] = ya + lm * ((1 - g) * ba[i] - ya)
        if (B) {
          const yb = xb + (g - 1) * bb[i]
          B[i0 + i] = yb + lm * ((1 - g) * bb[i] - yb)
        }
      }
    }
    this.lm = lm
    this.ps = ps
    this.pf = pf
    this.pr = pr
    this.pm = pm
    this.s = s
  }

  reset() {
    this.sc.reset()
    this.bd.reset()
    this.ps = this.pf = this.pr = this.pm = this.s = 0
  }
}

export default {
  id: 'tone.deess',
  name: 'De-esser',
  family: 'tone',
  about: 'Tames harsh s and sh sounds without a lisp: only the hiss band is turned down, only on s sounds, and never all the way.',
  params: [
    { id: 'threshold', name: 'Threshold, below your voice', type: 'number', min: -40, max: 0, step: 0.5, def: -26, unit: 'db' },
    { id: 'freq', name: 'Hiss frequency', type: 'number', min: 2000, max: 12000, step: 50, def: 7000, unit: 'hz' },
    { id: 'range', name: 'Most reduction', type: 'number', min: 0, max: 24, step: 0.5, def: 8, unit: 'db' },
    {
      id: 'mode', name: 'Band', type: 'choice', def: 'focused',
      options: [{ v: 'focused', name: 'Focused on the hiss' }, { v: 'top', name: 'Whole top end' }],
    },
    { id: 'listen', name: 'Hear what is removed', type: 'bool', def: false },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 2,
  surprise: false,
  process(input, p) {
    const n = bufLen(input)
    if (!n) return input
    new DeessProc(input.sr, p).run(input.ch, input.ch.length, n)
    return input
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p) {
      const proc = new DeessProc(sr, p)
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
