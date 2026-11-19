// modules/tone/dehum.js - tone.dehum, mains hum and buzz removal.
//
// Technique: a comb of narrow notch filters (RBJ audio EQ cookbook notch
// sections) at the mains frequency and its harmonics. Every notch has the
// same width in hertz (2 Hz by default), so the higher harmonics get a
// proportionally higher Q and the notches never eat into the voice: eight
// 2 Hz notches remove well under one percent of the speech band. More
// harmonics take out buzz as well as hum.
//
// "Find it for me" (offline) measures the take before filtering: the first
// 20 seconds are mixed to mono, low passed and decimated to 1 kHz (the
// engine's windowed-sinc resampler), and Goertzel's algorithm (G. Goertzel,
// "An algorithm for the evaluation of finite trigonometric series", 1958)
// scans 47 to 53 Hz and 57 to 63 Hz in 0.05 Hz steps over the first four
// harmonics. A hum line is far sharper than anything in a voice, so the
// family whose peaks stand highest above their own neighbours wins, and the
// notches go on the exact measured frequency (mains is often a few tenths
// of a hertz off). If there is no hum at all, 60 Hz is used and a note says
// so. Live, two small banks of 3 Hz band passes listen at 50, 100, 150 and
// 60, 120, 180 Hz and the notches glide to whichever family is louder.
//
// Live: with 50 or 60 Hz chosen, the live output equals the offline render.

import { bufLen } from '../../core/buf.js'
import { resampleTo } from '../../core/resample.js'
import { EqBank, BQ, NOTCH, BANDPASS, OFF, clamp, poleCoef, liveCopy } from './_dsp.js'

const MAXH = 40

class DehumProc {
  constructor(sr, p, measuredF0) {
    this.sr = sr
    this.bank = new EqBank(sr, MAXH, 2, 60)
    this.measured = measuredF0
    // live family detector
    this.det = []
    for (let h = 1; h <= 3; h++) {
      this.det.push(new BQ(BANDPASS, sr, 50 * h, (50 * h) / 3, 0))
      this.det.push(new BQ(BANDPASS, sr, 60 * h, (60 * h) / 3, 0))
    }
    this.p50 = 0
    this.p60 = 0
    this.pc = poleCoef(500, sr)
    this.every = Math.max(1, Math.round(0.25 * sr))
    this.cnt = 0
    this.track = 60
    this.set(p)
    this.bank.snap()
  }

  set(p) {
    this.H = Math.round(clamp(+p.harmonics || 1, 1, MAXH))
    this.width = clamp(+p.width || 2, 0.2, 50)
    this.mode = p.mains === '50' ? 50 : p.mains === '60' ? 60 : 0
    this._design()
  }

  f0() {
    if (this.mode) return this.mode
    if (this.measured > 0) return this.measured
    return this.track
  }

  _design() {
    const f0 = this.f0()
    const top = 0.45 * this.sr
    for (let h = 1; h <= MAXH; h++) {
      const f = f0 * h
      if (h <= this.H && f < top) this.bank.design(h - 1, NOTCH, f, f / this.width, 0)
      else this.bank.design(h - 1, OFF, 1000, 1, 0)
    }
  }

  run(chs, nch, n) {
    if (!this.mode && !(this.measured > 0)) {
      const A = chs[0]
      const B = nch > 1 ? chs[1] : null
      const d = this.det
      const pc = this.pc
      // filter up to each switch before retuning, so the switch lands on
      // the same sample whatever the block size
      let s0 = 0
      for (let i = 0; i < n; i++) {
        let x = A[i]
        if (B) x = 0.5 * (x + B[i])
        if (!(x < 1e6 && x > -1e6)) x = 0
        let e50 = 0
        let e60 = 0
        for (let k = 0; k < 6; k += 2) {
          const u = d[k].tick(x)
          const v = d[k + 1].tick(x)
          e50 += u * u
          e60 += v * v
        }
        this.p50 = e50 + pc * (this.p50 - e50)
        this.p60 = e60 + pc * (this.p60 - e60)
        if (this.p50 < 1e-30) this.p50 = 0
        if (this.p60 < 1e-30) this.p60 = 0
        if (++this.cnt >= this.every) {
          this.cnt = 0
          let want = this.track
          if (this.p50 > 2 * this.p60 && this.p50 > 1e-14) want = 50
          else if (this.p60 > 2 * this.p50 && this.p60 > 1e-14) want = 60
          if (want !== this.track) {
            this.bank.run(chs, nch, i + 1 - s0, s0)
            s0 = i + 1
            this.track = want
            this._design()
          }
        }
      }
      this.bank.run(chs, nch, n - s0, s0)
      return
    }
    this.bank.run(chs, nch, n)
  }

  reset() {
    this.bank.reset()
    for (let k = 0; k < this.det.length; k++) this.det[k].reset()
    this.p50 = this.p60 = 0
  }
}

function goertzelPow(x, f, sr) {
  const w = (2 * Math.PI * f) / sr
  const c = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i] + c * s1 - s2
    s2 = s1
    s1 = s0
  }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / (x.length * x.length)
}

/** Measured hum fundamental in Hz, or 0 when no hum stands out. */
function measureHum(chs, sr) {
  const n = Math.min(chs[0].length, Math.round(20 * sr))
  if (n < sr) return 0
  const mono = new Float32Array(n)
  const g = 1 / chs.length
  for (let c = 0; c < chs.length; c++) {
    const s = chs[c]
    for (let i = 0; i < n; i++) mono[i] += s[i] * g
  }
  const d = sr === 1000 ? mono : resampleTo(mono, sr, 1000)
  let mean = 0
  for (let i = 0; i < d.length; i++) mean += d[i]
  mean /= d.length || 1
  for (let i = 0; i < d.length; i++) d[i] -= mean
  const lineSum = (f) => {
    let e = 0
    for (let h = 1; h <= 4; h++) e += goertzelPow(d, f * h, 1000)
    return e
  }
  let best = 0
  let bestScore = 0
  for (const base of [50, 60]) {
    // coarse scan at 0.1 Hz, then refine at 0.02 Hz
    let f1 = base
    let e1 = -1
    for (let f = base - 3; f <= base + 3 + 1e-9; f += 0.1) {
      const e = lineSum(f)
      if (e > e1) {
        e1 = e
        f1 = f
      }
    }
    let f2 = f1
    for (let f = f1 - 0.1; f <= f1 + 0.1 + 1e-9; f += 0.02) {
      const e = lineSum(f)
      if (e > e1) {
        e1 = e
        f2 = f
      }
    }
    // how far each harmonic stands above its neighbours 0.7 and 1.4 Hz away
    let score = 0
    for (let h = 1; h <= 4; h++) {
      const fh = f2 * h
      const pk = goertzelPow(d, fh, 1000)
      const nb = 0.25 * (goertzelPow(d, fh - 0.7, 1000) + goertzelPow(d, fh + 0.7, 1000) + goertzelPow(d, fh - 1.4, 1000) + goertzelPow(d, fh + 1.4, 1000))
      if (pk > 1e-16) score += Math.max(0, 10 * Math.log10(pk / (nb + 1e-20)))
    }
    if (score > bestScore) {
      bestScore = score
      best = f2
    }
  }
  // at least about 8 dB of peak over neighbours, summed over the harmonics
  return bestScore > 8 ? Math.round(best * 100) / 100 : 0
}

export default {
  id: 'tone.dehum',
  name: 'Hum removal',
  family: 'tone',
  about: 'Removes mains hum and buzz at 50 or 60 hertz and their harmonics with narrow notches that leave your voice alone.',
  params: [
    {
      id: 'mains', name: 'Hum frequency', type: 'choice', def: 'auto',
      options: [{ v: 'auto', name: 'Find it for me' }, { v: '50', name: '50 hertz' }, { v: '60', name: '60 hertz' }],
    },
    { id: 'harmonics', name: 'Harmonics', type: 'number', min: 1, max: 40, step: 1, def: 8, unit: 'count', noun: ['harmonic', 'harmonics'] },
    { id: 'width', name: 'Notch width', type: 'number', min: 0.5, max: 10, step: 0.5, def: 2, unit: 'hz' },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 2,
  surprise: false,
  process(input, p, ctx) {
    const n = bufLen(input)
    if (!n) return input
    let measured = 0
    if (p.mains !== '50' && p.mains !== '60') {
      measured = measureHum(input.ch, input.sr)
      if (!measured) {
        measured = 60
        if (ctx && typeof ctx.note === 'function') ctx.note('Hum removal found no clear hum, so it used 60 hertz.')
      }
    }
    new DehumProc(input.sr, p, measured).run(input.ch, input.ch.length, n)
    return input
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p) {
      const proc = new DehumProc(sr, p, 0)
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
