// core/biquad.js - second-order filters, one-pole filters and a state-variable filter.
//
// Biquad: coefficients from Robert Bristow-Johnson's "Audio EQ Cookbook"
// (the RBJ cookbook): lowpass, highpass, bandpass with constant 0 dB peak
// gain, notch, peaking EQ, low shelf, high shelf and allpass. The shelves
// take Q directly (Q = 0.707 is the cookbook's shelf slope S = 1). The
// filter runs in Direct Form I with float64 state. Direct Form I is chosen
// over transposed Direct Form II because its state is the actual past input
// and output, so changing coefficients between blocks (a sweeping wah, an
// automated EQ) cannot produce the internal-state jumps that make TDF-II
// click. Recursive state and output are flushed to an exact zero once they
// fall below 1e-25 (about -500 dB). An explicit threshold is used rather
// than the add-and-subtract-a-constant trick, because that trick quantises
// the state and a lowpass with poles near z = 1 then sticks on a tiny DC
// value forever (a limit cycle). The threshold is far above the float32
// denormal range, so silent tails stay fast on every CPU and never write
// denormals into Float32Arrays.
//
// OnePole: Vadim Zavalishin's topology-preserving transform (TPT) one-pole
// from "The Art of VA Filter Design". It is bilinear-exact at the cutoff
// (-3 dB exactly at freq), stable under any modulation, and the highpass is
// the input minus the lowpass.
//
// SVF: the TPT state-variable filter in Andrew Simper's (Cytomic) form of
// Zavalishin's design. Two trapezoidal integrators with the delay-free loop
// solved in closed form, so it stays stable and smooth when cutoff and Q
// change on every single sample, which is what wah, formant sweeps and
// talk-box style effects need. tick() returns one shared result object
// { lp, bp, hp, notch, peak, ap } (no allocation per sample).

const TINY = 1e-25

const TYPES = {
  lowpass: 'lowpass', lp: 'lowpass', lpf: 'lowpass',
  highpass: 'highpass', hp: 'highpass', hpf: 'highpass',
  bandpass: 'bandpass', bp: 'bandpass', bpf: 'bandpass', band: 'bandpass',
  notch: 'notch', bandstop: 'notch', br: 'notch', bandreject: 'notch',
  peak: 'peak', peaking: 'peak', bell: 'peak', eq: 'peak', peakingeq: 'peak',
  lowshelf: 'lowshelf', ls: 'lowshelf', lowShelf: 'lowshelf',
  highshelf: 'highshelf', hs: 'highshelf', highShelf: 'highshelf',
  allpass: 'allpass', ap: 'allpass', apf: 'allpass',
}

/** Normalise a filter type name, or throw with a plain sentence. */
export function filterType(t) {
  const k = TYPES[t] || TYPES[String(t).toLowerCase()]
  if (!k) throw new RangeError('Unknown filter type "' + t + '". Use lowpass, highpass, bandpass, notch, peak, lowshelf, highshelf or allpass.')
  return k
}

function clampFreq(f, sr) {
  const v = Number(f)
  if (!(v > 1e-3)) return 1e-3
  const hi = sr * 0.4999
  return v > hi ? hi : v
}

function clampQ(q) {
  const v = Number(q)
  if (!(v > 1e-3)) return 1e-3
  return v > 1000 ? 1000 : v
}

/**
 * RBJ cookbook coefficients, normalised by a0.
 * @returns {{b0:number,b1:number,b2:number,a1:number,a2:number}}
 */
export function rbjCoefs(type, sr, freq, q = 0.707, gainDb = 0) {
  return rbjInto({ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }, filterType(type), sr, freq, q, gainDb)
}

/**
 * RBJ cookbook coefficients written into out.b0, b1, b2, a1, a2 (normalised by
 * a0). t must already be a normalised type name (filterType). Allocates
 * nothing, so Biquad.set() can retune on the audio thread. Returns out.
 */
function rbjInto(out, t, sr, freq, q, gainDb) {
  const f = clampFreq(freq, sr)
  const Q = clampQ(q)
  const g = Number.isFinite(Number(gainDb)) ? Number(gainDb) : 0
  const w0 = (2 * Math.PI * f) / sr
  const cs = Math.cos(w0)
  const sn = Math.sin(w0)
  const alpha = sn / (2 * Q)
  const A = Math.pow(10, g / 40)
  let b0, b1, b2, a0, a1, a2
  switch (t) {
    case 'lowpass':
      b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0
      a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha
      break
    case 'highpass':
      b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0
      a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha
      break
    case 'bandpass':
      b0 = alpha; b1 = 0; b2 = -alpha
      a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha
      break
    case 'notch':
      b0 = 1; b1 = -2 * cs; b2 = 1
      a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha
      break
    case 'allpass':
      b0 = 1 - alpha; b1 = -2 * cs; b2 = 1 + alpha
      a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha
      break
    case 'peak':
      b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A
      a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A
      break
    case 'lowshelf': {
      const sq = 2 * Math.sqrt(A) * alpha
      b0 = A * ((A + 1) - (A - 1) * cs + sq)
      b1 = 2 * A * ((A - 1) - (A + 1) * cs)
      b2 = A * ((A + 1) - (A - 1) * cs - sq)
      a0 = (A + 1) + (A - 1) * cs + sq
      a1 = -2 * ((A - 1) + (A + 1) * cs)
      a2 = (A + 1) + (A - 1) * cs - sq
      break
    }
    case 'highshelf': {
      const sq = 2 * Math.sqrt(A) * alpha
      b0 = A * ((A + 1) + (A - 1) * cs + sq)
      b1 = -2 * A * ((A - 1) + (A + 1) * cs)
      b2 = A * ((A + 1) + (A - 1) * cs - sq)
      a0 = (A + 1) - (A - 1) * cs + sq
      a1 = 2 * ((A - 1) - (A + 1) * cs)
      a2 = (A + 1) - (A - 1) * cs - sq
      break
    }
  }
  out.b0 = b0 / a0
  out.b1 = b1 / a0
  out.b2 = b2 / a0
  out.a1 = a1 / a0
  out.a2 = a2 / a0
  return out
}

export class Biquad {
  constructor(type, sr, freq, q = 0.707, gainDb = 0) {
    this.sr = sr
    this.type = filterType(type)
    this.freq = freq
    this.q = q
    this.gainDb = gainDb
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0
    this.set(type, freq, q, gainDb)
  }

  /**
   * Change any of type, freq, q, gainDb (undefined keeps the old value). State is kept.
   * The coefficients are written straight into this filter: no allocation, so a
   * live module may call set() from its process loop.
   */
  set(type, freq, q, gainDb) {
    if (type !== undefined && type !== null && type !== this.type) this.type = filterType(type)
    if (freq !== undefined) this.freq = freq
    if (q !== undefined) this.q = q
    if (gainDb !== undefined) this.gainDb = gainDb
    rbjInto(this, this.type, this.sr, this.freq, this.q === undefined ? 0.707 : this.q, this.gainDb === undefined ? 0 : this.gainDb)
    return this
  }

  /** One sample in, one sample out. */
  tick(x) {
    if (!(x - x === 0)) x = 0 // NaN or Infinity in: treat as silence, never poison the state
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y < TINY && y > -TINY ? 0 : y
    return this.y1
  }

  /** Filter a whole Float32Array in place. Returns it. */
  run(sig) {
    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2
    let x1 = this.x1, x2 = this.x2, y1 = this.y1, y2 = this.y2
    const n = sig.length
    for (let i = 0; i < n; i++) {
      let x = sig[i]
      if (!(x - x === 0)) x = 0 // NaN or Infinity in: silence for that sample only
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = x
      y2 = y1
      y1 = y < TINY && y > -TINY ? 0 : y
      sig[i] = y1
    }
    // A non-finite input would poison the state forever; recover instead.
    if (!Number.isFinite(y1) || !Number.isFinite(y2) || !Number.isFinite(x1) || !Number.isFinite(x2)) {
      x1 = x2 = y1 = y2 = 0
    }
    this.x1 = x1; this.x2 = x2; this.y1 = y1; this.y2 = y2
    return sig
  }

  reset() {
    this.x1 = this.x2 = this.y1 = this.y2 = 0
    return this
  }

  /** Exact magnitude response of the current coefficients at hz, in dB. */
  magnitudeDb(hz) {
    const w = (2 * Math.PI * hz) / this.sr
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w)
    const nr = this.b0 + this.b1 * c1 + this.b2 * c2
    const ni = -(this.b1 * s1 + this.b2 * s2)
    const dr = 1 + this.a1 * c1 + this.a2 * c2
    const di = -(this.a1 * s1 + this.a2 * s2)
    const m = Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di))
    return m > 1e-10 ? 20 * Math.log10(m) : -200
  }
}

/** Run a list of biquads over sig in place: [{ type, freq, q, gain }...]. Returns sig. */
export function filterChain(sig, sr, specs) {
  if (!specs) return sig
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]
    if (!s) continue
    const g = s.gain !== undefined ? s.gain : s.gainDb !== undefined ? s.gainDb : 0
    new Biquad(s.type, sr, s.freq, s.q !== undefined ? s.q : 0.707, g).run(sig)
  }
  return sig
}

/** First-order TPT lowpass or highpass. */
export class OnePole {
  constructor(sr, freq, mode = 'lp') {
    this.sr = sr
    this.mode = mode === 'hp' || mode === 'highpass' ? 'hp' : 'lp'
    this.s = 0
    this.G = 0
    this.set(freq)
  }

  set(freq) {
    this.freq = clampFreq(freq, this.sr)
    const g = Math.tan((Math.PI * this.freq) / this.sr)
    this.G = g / (1 + g)
    return this
  }

  tick(x) {
    if (!(x - x === 0)) x = 0
    const v = (x - this.s) * this.G
    const lp = v + this.s
    const s = lp + v
    this.s = s < TINY && s > -TINY ? 0 : s
    return this.mode === 'hp' ? x - lp : lp
  }

  run(sig) {
    const G = this.G
    let s = this.s
    const n = sig.length
    if (this.mode === 'hp') {
      for (let i = 0; i < n; i++) {
        const x = sig[i]
        const v = (x - s) * G
        const lp = v + s
        s = lp + v
        if (s < TINY && s > -TINY) s = 0
        sig[i] = x - lp
      }
    } else {
      for (let i = 0; i < n; i++) {
        const v = (sig[i] - s) * G
        const lp = v + s
        s = lp + v
        if (s < TINY && s > -TINY) s = 0
        sig[i] = lp
      }
    }
    this.s = Number.isFinite(s) ? s : 0
    return sig
  }

  reset() {
    this.s = 0
    return this
  }
}

/** TPT state-variable filter (Simper / Zavalishin), safe for per-sample modulation. */
export class SVF {
  constructor(sr) {
    this.sr = sr
    this.ic1 = 0
    this.ic2 = 0
    this._f = -1
    this._q = -1
    this._k = 1.414
    this._a1 = 0
    this._a2 = 0
    this._a3 = 0
    this.out = { lp: 0, bp: 0, hp: 0, notch: 0, peak: 0, ap: 0 }
  }

  _coefs(freq, q) {
    if (freq === this._f && q === this._q) return
    this._f = freq
    this._q = q
    let f = clampFreq(freq, this.sr)
    if (f > this.sr * 0.49) f = this.sr * 0.49
    let Q = Number(q)
    if (!(Q > 0.02)) Q = 0.02
    if (Q > 200) Q = 200
    const g = Math.tan((Math.PI * f) / this.sr)
    const k = 1 / Q
    this._k = k
    this._a1 = 1 / (1 + g * (g + k))
    this._a2 = g * this._a1
    this._a3 = g * this._a2
  }

  /** One sample; returns the shared { lp, bp, hp, notch, peak, ap } object. */
  tick(x, freq, q = 0.707) {
    this._coefs(freq, q)
    const ic1 = this.ic1
    const ic2 = this.ic2
    const v3 = x - ic2
    const v1 = this._a1 * ic1 + this._a2 * v3
    const v2 = ic2 + this._a2 * ic1 + this._a3 * v3
    let n1 = 2 * v1 - ic1
    let n2 = 2 * v2 - ic2
    if (n1 < TINY && n1 > -TINY) n1 = 0
    if (n2 < TINY && n2 > -TINY) n2 = 0
    if (!(n1 > -1e15 && n1 < 1e15) || !(n2 > -1e15 && n2 < 1e15)) {
      n1 = 0
      n2 = 0
    }
    this.ic1 = n1
    this.ic2 = n2
    const k = this._k
    const o = this.out
    o.lp = v2
    o.bp = v1
    o.hp = x - k * v1 - v2
    o.notch = x - k * v1
    o.peak = 2 * v2 - x + k * v1
    o.ap = x - 2 * k * v1
    return o
  }

  /**
   * Filter sig in place. freq and q may be numbers or per-sample arrays
   * (Float32Array of the same length). mode: lp bp hp notch peak ap.
   */
  run(sig, freq, q = 0.707, mode = 'lp') {
    const n = sig.length
    const fa = typeof freq === 'number' ? null : freq
    const qa = typeof q === 'number' ? null : q
    const sel = mode === 'bp' ? 1 : mode === 'hp' ? 2 : mode === 'notch' ? 3 : mode === 'peak' ? 4 : mode === 'ap' ? 5 : 0
    for (let i = 0; i < n; i++) {
      const o = this.tick(sig[i], fa ? fa[i] : freq, qa ? qa[i] : q)
      sig[i] = sel === 0 ? o.lp : sel === 1 ? o.bp : sel === 2 ? o.hp : sel === 3 ? o.notch : sel === 4 ? o.peak : o.ap
    }
    return sig
  }

  reset() {
    this.ic1 = 0
    this.ic2 = 0
    return this
  }
}
