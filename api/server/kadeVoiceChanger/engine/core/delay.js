// core/delay.js - delay line with fractional reads.
//
// Storage: a power-of-two ring buffer (Float32Array) addressed with a bit
// mask, so wrapping costs one AND instead of a compare or a modulo.
//
// Reads: read(d) uses 4-point, 3rd-order cubic Hermite interpolation
// (the Catmull-Rom spline; see Olli Niemitalo, "Polynomial Interpolators for
// High-Quality Resampling of Oversampled Audio", 2001). It is smooth enough
// for chorus, flanger, vibrato and doppler, where the delay moves every
// sample, and much cheaper than windowed sinc. readLinear(d) is plain linear
// interpolation for cheap or deliberately rough effects.
//
// Timing convention: write(x) first, then read(d) returns the input from d
// samples ago, so read(0) is the sample just written and read(D) after
// every write gives an exact D-sample delay. d is clamped to the valid
// range [0, maxSamples]. For d below 1 the interpolator has no "future"
// sample, so it reuses the newest sample in that slot.

function nextPow2(n) {
  let p = 4
  while (p < n) p <<= 1
  return p
}

export class DelayLine {
  /** @param {number} maxSamples longest delay that will be read */
  constructor(maxSamples) {
    const m = Math.max(1, Math.ceil(Number(maxSamples) || 1))
    this.size = nextPow2(m + 4)
    this.mask = this.size - 1
    this.buf = new Float32Array(this.size)
    this.w = 0
    this.maxDelay = this.size - 3
  }

  /** Push one sample. */
  write(x) {
    this.buf[this.w] = x > -1e30 && x < 1e30 ? x : 0
    this.w = (this.w + 1) & this.mask
  }

  /** Fractional read, cubic Hermite. */
  read(d) {
    let D = d
    if (!(D > 0)) D = 0
    if (D > this.maxDelay) D = this.maxDelay
    const i = D | 0
    const f = D - i
    const buf = this.buf
    const mask = this.mask
    const base = this.w - 1 - i
    const y0 = buf[base & mask]
    const y1 = buf[(base - 1) & mask]
    const y2 = buf[(base - 2) & mask]
    const ym1 = i === 0 ? y0 : buf[(base + 1) & mask]
    if (f === 0) return y0
    const c1 = 0.5 * (y1 - ym1)
    const c2 = ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2
    const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1)
    return ((c3 * f + c2) * f + c1) * f + y0
  }

  /** Fractional read, linear. */
  readLinear(d) {
    let D = d
    if (!(D > 0)) D = 0
    if (D > this.maxDelay) D = this.maxDelay
    const i = D | 0
    const f = D - i
    const base = this.w - 1 - i
    const a = this.buf[base & this.mask]
    const b = this.buf[(base - 1) & this.mask]
    return a + (b - a) * f
  }

  /** Alias of read. */
  tap(d) {
    return this.read(d)
  }

  /** Write x, then return the cubic read at d (a one-call delay). */
  process(x, d) {
    this.write(x)
    return this.read(d)
  }

  clear() {
    this.buf.fill(0)
    this.w = 0
  }
}
