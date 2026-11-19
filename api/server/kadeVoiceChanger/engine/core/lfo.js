// core/lfo.js - low-frequency oscillators for modulation.
//
// A phase accumulator in [0, 1) advanced by rate / sr per sample. Shapes:
//   sine      sin(2 pi phase)
//   triangle  starts at 0 rising, peaks at +1 a quarter cycle in (in phase with sine)
//   square    +1 for the first half cycle, -1 for the second
//   saw       falling ramp, +1 down to -1 (the classic "sawtooth down")
//   ramp      rising ramp, -1 up to +1
//   random    sample-and-hold: a new uniform value in -1..1 each cycle
//   smooth    slewed random: cosine interpolation from one random value to
//             the next across each cycle, so it wanders without corners
//             (the "smooth random" of analogue modular systems)
// These are control signals, so the waveforms are deliberately naive (no
// band limiting): at LFO rates aliasing is irrelevant.
//
// Randomness comes only from the supplied rng (core/rng.js); without one a
// fixed seed is used so output is still deterministic. phase is 0..1.
// rate may be changed at any time (this.rate) for tempo or random-rate
// effects; fill(arr) writes a block without per-sample method lookups.
//
// reset() rewinds everything a fresh LFO would start from: the phase, and for
// random and smooth the random stream too. The constructor keeps a copy of the
// rng's state from before its first draw (core/rng.js clone) and a second
// copy to replay from, so after reset() the LFO gives exactly the values a new
// LFO with the same options would, and reset() itself allocates nothing.
// (After a reset the LFO draws from its private copy, never again from the
// rng it was given. An rng without clone() keeps the old behaviour: the phase
// is reset and the random values carry on.)

import { makeRng } from './rng.js'

const SHAPES = ['sine', 'triangle', 'square', 'saw', 'ramp', 'random', 'smooth']

export class LFO {
  constructor(sr, opts = {}) {
    this.sr = sr
    this.shape = SHAPES.indexOf(opts.shape) >= 0 ? opts.shape : opts.shape === 'tri' ? 'triangle' : opts.shape === 'sawtooth' ? 'saw' : 'sine'
    this.rate = Number.isFinite(opts.rate) ? opts.rate : 1
    let ph = Number(opts.phase) || 0
    ph = ph - Math.floor(ph)
    this.phase = ph
    this.rng = opts.rng || makeRng('lfo')
    // the random stream's starting point, for reset()
    const r = this.rng
    if (r && typeof r.clone === 'function' && typeof r.getState === 'function') {
      this._rng0 = r.clone()
      this._replay = r.clone()
      this._st = new Float64Array(6)
    } else {
      this._rng0 = null
      this._replay = null
      this._st = null
    }
    this._a = this.rng.next() * 2 - 1
    this._b = this.rng.next() * 2 - 1
  }

  _advance() {
    let p = this.phase + this.rate / this.sr
    if (p >= 1 || p < 0) {
      const wraps = Math.floor(p)
      p -= wraps
      if (wraps !== 0) {
        this._a = this._b
        this._b = this.rng.next() * 2 - 1
      }
    }
    this.phase = p === p ? p : 0
  }

  _value(p) {
    switch (this.shape) {
      case 'sine':
        return Math.sin(2 * Math.PI * p)
      case 'triangle':
        return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4
      case 'square':
        return p < 0.5 ? 1 : -1
      case 'saw':
        return 1 - 2 * p
      case 'ramp':
        return 2 * p - 1
      case 'random':
        return this._a
      case 'smooth': {
        const t = 0.5 - 0.5 * Math.cos(Math.PI * p)
        return this._a + (this._b - this._a) * t
      }
    }
    return 0
  }

  /** Current value in -1..1, then advance one sample. */
  next() {
    const v = this._value(this.phase)
    this._advance()
    return v
  }

  /** Value at the current phase without advancing. */
  peek() {
    return this._value(this.phase)
  }

  /** Fill arr (any typed array) with successive values. Returns arr. */
  fill(arr, depth = 1, offset = 0) {
    for (let i = 0; i < arr.length; i++) arr[i] = offset + depth * this.next()
    return arr
  }

  setRate(hz) {
    this.rate = Number.isFinite(hz) ? hz : this.rate
    return this
  }

  /** Back to the start: phase (0 unless given) and, for random and smooth, the random stream. */
  reset(phase = 0) {
    const ph = Number(phase) || 0
    this.phase = ph - Math.floor(ph)
    if (this._rng0) {
      this._replay.setState(this._rng0.getState(this._st))
      this.rng = this._replay
      this._a = this.rng.next() * 2 - 1
      this._b = this.rng.next() * 2 - 1
    }
    return this
  }
}

export const LFO_SHAPES = SHAPES
