// modules/tone/filter.js - tone.filter, a resonant filter that can sweep.
//
// Technique: the topology-preserving-transform state-variable filter of
// Vadim Zavalishin ("The Art of VA Filter Design") in Andrew Simper's
// (Cytomic) closed form. Its two trapezoidal integrators stay stable and
// smooth when the cutoff moves on every single sample, which is what a
// sweep, an envelope filter or a drifting filter needs. One stage gives 12
// dB per octave; "steep" cascades a second stage (24 dB per octave): for
// low and high pass the second stage is a plain Butterworth section so the
// resonance peak stays one peak, for band pass and notch both stages share
// the resonance for a narrower band or a deeper notch. The band pass output
// is scaled to a 0 dB peak.
//
// Sweeps move the cutoff on a log (octave) scale: a slow sine sweep, a
// smooth random drift, or an envelope follower that opens (or closes) the
// filter as you talk. The envelope is measured against a slowly falling
// peak of your own level, so it reacts the same on a quiet take and a loud
// one. Resonance runs from a soft Q of 0.6 to a ringing Q of 24. Changing
// the kind or the slope live crossfades from the old filter to the new one
// over 20 ms (the old one keeps running meanwhile), so it never clicks; a
// soft ceiling keeps a ringing resonance from ever passing a peak of 8.
//
// Live: the same code per sample; with the same random seed the live output
// is identical to the offline render.

import { bufLen } from '../../core/buf.js'
import { clamp, poleCoef, safety, liveCopy } from './_dsp.js'

const TYPES = { lowpass: 0, highpass: 1, bandpass: 2, notch: 3 }
const SWEEPS = { still: 0, lfo: 1, envup: 2, envdown: 3, drift: 4 }
const SQRT2 = Math.SQRT2

function resToQ(r) {
  return 0.6 * Math.pow(40, clamp(+r || 0, 0, 100) / 100)
}

function fallbackRng() {
  let s = 0x2545f491
  return {
    range(a, b) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return a + ((b - a) * s) / 4294967296
    },
  }
}

class FilterProc {
  constructor(sr, p, rng) {
    this.sr = sr
    this.rng = rng && typeof rng.range === 'function' ? rng : fallbackRng()
    this.ic = new Float64Array(8) // [channel][stage][ic1, ic2]
    this.icOld = new Float64Array(8) // the previous kind, while crossfading
    this.ks = 1 - poleCoef(15, sr)
    this.xfInc = 1 / Math.max(1, 0.02 * sr)
    this.xf = 1
    this.ph = 0
    this.env = 0
    this.ref = 1e-3
    this.ea = poleCoef(4, sr)
    this.er = poleCoef(140, sr)
    this.rr = poleCoef(2500, sr)
    this.drA = 0
    this.drB = this.rng.range(-1, 1)
    this.drPh = 0
    // per-sample coefficients shared by both chains
    this.k = 1
    this.a1 = 0
    this.a2 = 0
    this.a3 = 0
    this.s1 = 0
    this.s2 = 0
    this.s3 = 0
    this.type = -1
    this.set(p)
    this.xf = 1
    this.lf = this.lfT
    this.q = this.qT
    this.mix = this.mixT
  }

  set(p) {
    const t = TYPES[p.type]
    const type = t === undefined ? 0 : t
    const steep = p.slope === 'steep'
    if (this.type >= 0 && (type !== this.type || steep !== this.steep)) {
      // a new kind of filter: keep the old one running and crossfade (20 ms)
      this.icOld.set(this.ic)
      this.oldType = this.type
      this.oldSteep = this.steep
      this.xf = 0
    }
    this.type = type
    this.steep = steep
    const s = SWEEPS[p.sweep]
    this.sweep = s === undefined ? 0 : s
    this.rate = clamp(+p.rate || 0, 0, 50)
    this.oct = (4 * clamp(+p.range || 0, 0, 100)) / 100
    this.lfT = Math.log2(clamp(+p.freq || 1000, 20, 20000))
    this.qT = resToQ(p.resonance)
    this.mixT = clamp(+p.mix, 0, 100) / 100
  }

  /** One sample through a one- or two-stage chain using state ic at offset o. */
  _chain(ic, o, x0, type, steep) {
    const k = this.k
    let s1 = ic[o]
    let s2 = ic[o + 1]
    let v3 = x0 - s2
    let v1 = this.a1 * s1 + this.a2 * v3
    let v2 = s2 + this.a2 * s1 + this.a3 * v3
    s1 = 2 * v1 - s1
    s2 = 2 * v2 - s2
    if (!(s1 > 1e-25 || s1 < -1e-25) || !(s1 < 1e9 && s1 > -1e9)) s1 = 0
    if (!(s2 > 1e-25 || s2 < -1e-25) || !(s2 < 1e9 && s2 > -1e9)) s2 = 0
    ic[o] = s1
    ic[o + 1] = s2
    let y = type === 0 ? v2 : type === 1 ? x0 - k * v1 - v2 : type === 2 ? k * v1 : x0 - k * v1
    if (steep) {
      // low and high pass: a plain Butterworth second stage; band pass and
      // notch: the same resonance again
      const bw = type < 2
      const kB = bw ? SQRT2 : k
      const b1 = bw ? this.s1 : this.a1
      const b2 = bw ? this.s2 : this.a2
      const b3 = bw ? this.s3 : this.a3
      s1 = ic[o + 2]
      s2 = ic[o + 3]
      v3 = y - s2
      v1 = b1 * s1 + b2 * v3
      v2 = s2 + b2 * s1 + b3 * v3
      s1 = 2 * v1 - s1
      s2 = 2 * v2 - s2
      if (!(s1 > 1e-25 || s1 < -1e-25) || !(s1 < 1e9 && s1 > -1e9)) s1 = 0
      if (!(s2 > 1e-25 || s2 < -1e-25) || !(s2 < 1e9 && s2 > -1e9)) s2 = 0
      ic[o + 2] = s1
      ic[o + 3] = s2
      y = type === 0 ? v2 : type === 1 ? y - kB * v1 - v2 : type === 2 ? kB * v1 : y - kB * v1
    }
    return y < 1e6 && y > -1e6 ? y : 0
  }

  run(chs, nch, n) {
    const sr = this.sr
    const nyq = 0.45 * sr
    const ks = this.ks
    const sweep = this.sweep
    const inc = this.rate / sr
    const oct = this.oct
    const a = chs[0]
    const b = nch > 1 ? chs[1] : null
    const nc = b ? 2 : 1
    let lf = this.lf
    let q = this.q
    let mix = this.mix
    const lfT = this.lfT
    const qT = this.qT
    const mixT = this.mixT
    for (let i = 0; i < n; i++) {
      lf += (lfT - lf) * ks
      q += (qT - q) * ks
      mix += (mixT - mix) * ks
      const xa = a[i]
      const xb = b ? b[i] : 0
      // cutoff modulation in octaves
      let m = 0
      if (sweep === 1) {
        this.ph += inc
        if (this.ph >= 1) this.ph -= 1
        m = 0.5 * oct * Math.sin(2 * Math.PI * this.ph)
      } else if (sweep === 2 || sweep === 3) {
        let lv = xa < 0 ? -xa : xa
        const lb = xb < 0 ? -xb : xb
        if (lb > lv) lv = lb
        if (!(lv < 1e6)) lv = 0
        this.env = lv > this.env ? lv + this.ea * (this.env - lv) : lv + this.er * (this.env - lv)
        if (this.env < 1e-25) this.env = 0
        this.ref = this.env > this.ref ? this.env : this.ref * this.rr
        if (this.ref < 1e-3) this.ref = 1e-3
        let v = this.env / this.ref
        if (v > 1) v = 1
        m = sweep === 2 ? oct * v : -oct * v
      } else if (sweep === 4) {
        this.drPh += inc
        if (this.drPh >= 1) {
          this.drPh -= 1
          this.drA = this.drB
          this.drB = this.rng.range(-1, 1)
        }
        const u = 0.5 - 0.5 * Math.cos(Math.PI * this.drPh)
        m = 0.5 * oct * (this.drA + (this.drB - this.drA) * u)
      }
      let fc = Math.pow(2, lf + m)
      if (fc < 20) fc = 20
      else if (fc > nyq) fc = nyq
      const g = Math.tan((Math.PI * fc) / sr)
      const k = 1 / q
      this.k = k
      this.a1 = 1 / (1 + g * (g + k))
      this.a2 = g * this.a1
      this.a3 = g * this.a2
      const needBw = (this.steep && this.type < 2) || (this.xf < 1 && this.oldSteep && this.oldType < 2)
      if (needBw) {
        this.s1 = 1 / (1 + g * (g + SQRT2))
        this.s2 = g * this.s1
        this.s3 = g * this.s2
      }
      const fading = this.xf < 1
      for (let c = 0; c < nc; c++) {
        const x0 = c === 0 ? xa : xb
        const o = c * 4
        let y = this._chain(this.ic, o, x0, this.type, this.steep)
        if (fading) {
          const yo = this._chain(this.icOld, o, x0, this.oldType, this.oldSteep)
          y = yo + (y - yo) * this.xf
        }
        const out = x0 + (y - x0) * mix
        if (c === 0) a[i] = out
        else b[i] = out
      }
      if (fading) {
        this.xf += this.xfInc
        if (this.xf > 1) this.xf = 1
      }
    }
    this.lf = lf
    this.q = q
    this.mix = mix
    safety(chs, nch, n)
  }

  reset() {
    this.ic.fill(0)
    this.icOld.fill(0)
    this.xf = 1
    this.env = 0
    this.ref = 1e-3
    this.ph = 0
  }
}

export default {
  id: 'tone.filter',
  name: 'Filter',
  family: 'tone',
  about: 'A resonant filter: low pass, high pass, band pass or notch. Leave it still, or let it sweep slowly, drift, or open as you talk.',
  params: [
    {
      id: 'type', name: 'Kind', type: 'choice', def: 'lowpass',
      options: [
        { v: 'lowpass', name: 'Low pass, keeps the lows' },
        { v: 'highpass', name: 'High pass, keeps the highs' },
        { v: 'bandpass', name: 'Band pass, keeps a band' },
        { v: 'notch', name: 'Notch, removes a band' },
      ],
    },
    { id: 'freq', name: 'Frequency', type: 'number', min: 20, max: 20000, step: 1, def: 1200, unit: 'hz', rand: [300, 4000] },
    { id: 'resonance', name: 'Resonance', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 70] },
    {
      id: 'slope', name: 'Slope', type: 'choice', def: 'steep',
      options: [{ v: 'gentle', name: 'Gentle, 12 decibels per octave' }, { v: 'steep', name: 'Steep, 24 decibels per octave' }],
    },
    {
      id: 'sweep', name: 'Movement', type: 'choice', def: 'still',
      options: [
        { v: 'still', name: 'Still' },
        { v: 'lfo', name: 'Slow sweep' },
        { v: 'drift', name: 'Random drift' },
        { v: 'envup', name: 'Opens as you talk' },
        { v: 'envdown', name: 'Closes as you talk' },
      ],
    },
    { id: 'rate', name: 'Sweep speed', type: 'number', min: 0.05, max: 10, step: 0.05, def: 0.4, unit: 'hz', rand: [0.1, 2] },
    { id: 'range', name: 'Sweep range', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent' },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 1,
  process(input, p, ctx) {
    const n = bufLen(input)
    if (!n) return input
    new FilterProc(input.sr, p, ctx && ctx.rng).run(input.ch, input.ch.length, n)
    return input
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p, rng) {
      const proc = new FilterProc(sr, p, rng)
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
