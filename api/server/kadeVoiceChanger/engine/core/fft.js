// core/fft.js - fast Fourier transforms.
//
// Complex transform: the iterative radix-2 Cooley-Tukey algorithm
// (decimation in time). The input is put in bit-reversed order with a
// precomputed permutation table, then log2(n) butterfly passes run with
// twiddle factors read from a precomputed half-circle cosine/sine table.
// Tables are cached per size in a module-level map, so making many FFT
// objects of the same size costs nothing after the first.
//
// Real transform: the classic "half-size complex" packing (see for example
// Sorensen, Jones, Heideman and Burrus 1987, "Real-valued fast Fourier
// transform algorithms", and Numerical Recipes "realft"). An n-point real
// signal is read as an n/2-point complex signal z[m] = x[2m] + i x[2m+1],
// transformed with the n/2-point complex FFT, and then split into the
// even and odd sample spectra and recombined with one twiddle per bin.
// The inverse runs the same steps backwards. This halves the work of a real
// transform compared with zero-imaginary complex input.
//
// Conventions: forward is X[k] = sum x[m] e^(-2 pi i k m / n), unscaled.
// inverse is x[m] = (1/n) sum X[k] e^(+2 pi i k m / n), so a forward then an
// inverse returns the input. Work arrays are Float64Array for accuracy
// (round-trip error about 1e-15 relative); Float32Array input is accepted.
//
// The contract asks for sizes 16..32768; any power of two from 2 to 2^22
// works here. Nothing in forward/inverse/realForward/realInverse allocates.

const TABLES = new Map()

function isPow2(n) {
  return n >= 2 && (n & (n - 1)) === 0
}

function tablesFor(n) {
  let t = TABLES.get(n)
  if (t) return t
  const half = n >> 1
  const cos = new Float64Array(half)
  const sin = new Float64Array(half)
  for (let k = 0; k < half; k++) {
    const a = (2 * Math.PI * k) / n
    cos[k] = Math.cos(a)
    sin[k] = Math.sin(a)
  }
  const bits = Math.round(Math.log2(n))
  const rev = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    let r = 0
    let x = i
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | (x & 1)
      x >>= 1
    }
    rev[i] = r
  }
  t = { cos, sin, rev }
  TABLES.set(n, t)
  return t
}

export class FFT {
  /** @param {number} n power of two */
  constructor(n) {
    n = Math.floor(n)
    if (!isPow2(n) || n > 1 << 22) throw new RangeError('FFT size must be a power of two from 2 to 4194304, got ' + n)
    this.n = n
    const t = tablesFor(n)
    this._cos = t.cos
    this._sin = t.sin
    this._rev = t.rev
    this._half = null // lazily made n/2 FFT for the real transforms
    this._zr = null
    this._zi = null
    this._rc = null
    this._rs = null
  }

  _permute(re, im) {
    const n = this.n
    const rev = this._rev
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) {
        let t = re[i]
        re[i] = re[j]
        re[j] = t
        t = im[i]
        im[i] = im[j]
        im[j] = t
      }
    }
  }

  _passes(re, im, sgn) {
    const n = this.n
    const cos = this._cos
    const sin = this._sin
    // First pass (size 2) has twiddle 1: do it without multiplies.
    for (let i = 0; i < n; i += 2) {
      const ar = re[i]
      const ai = im[i]
      const br = re[i + 1]
      const bi = im[i + 1]
      re[i] = ar + br
      im[i] = ai + bi
      re[i + 1] = ar - br
      im[i + 1] = ai - bi
    }
    for (let size = 4; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let j = 0; j < half; j++) {
        const k = j * step
        const wr = cos[k]
        const wi = sgn * sin[k]
        for (let i = j; i < n; i += size) {
          const b = i + half
          const xr = re[b]
          const xi = im[b]
          const tr = xr * wr - xi * wi
          const ti = xr * wi + xi * wr
          const ar = re[i]
          const ai = im[i]
          re[b] = ar - tr
          im[b] = ai - ti
          re[i] = ar + tr
          im[i] = ai + ti
        }
      }
    }
  }

  /** In-place forward transform of n complex values. */
  forward(re, im) {
    this._permute(re, im)
    this._passes(re, im, -1)
  }

  /** In-place inverse transform, scaled by 1/n. */
  inverse(re, im) {
    this._permute(re, im)
    this._passes(re, im, 1)
    const n = this.n
    const s = 1 / n
    for (let i = 0; i < n; i++) {
      re[i] *= s
      im[i] *= s
    }
  }

  _realSetup() {
    if (this._zr) return
    const n = this.n
    const m = n >> 1
    this._half = m >= 2 ? new FFT(m) : null
    this._zr = new Float64Array(Math.max(m, 1))
    this._zi = new Float64Array(Math.max(m, 1))
    this._rc = new Float64Array(m + 1)
    this._rs = new Float64Array(m + 1)
    for (let k = 0; k <= m; k++) {
      const a = (2 * Math.PI * k) / n
      this._rc[k] = Math.cos(a)
      this._rs[k] = Math.sin(a)
    }
  }

  /**
   * Real forward transform without allocation. sig may be shorter than n
   * (zero padded). Writes n/2+1 bins into outRe/outIm.
   */
  realForward(sig, outRe, outIm) {
    this._realSetup()
    const n = this.n
    const m = n >> 1
    const zr = this._zr
    const zi = this._zi
    const len = Math.min(sig.length, n)
    for (let j = 0; j < m; j++) {
      const a = 2 * j
      zr[j] = a < len ? sig[a] : 0
      zi[j] = a + 1 < len ? sig[a + 1] : 0
    }
    if (this._half) this._half.forward(zr, zi)
    const rc = this._rc
    const rs = this._rs
    for (let k = 0; k <= m; k++) {
      const k1 = k === m ? 0 : k
      const k2 = k === 0 ? 0 : m - k
      const ar = zr[k1]
      const ai = zi[k1]
      const br = zr[k2]
      const bi = zi[k2]
      const fer = 0.5 * (ar + br)
      const fei = 0.5 * (ai - bi)
      const for_ = 0.5 * (ai + bi)
      const foi = -0.5 * (ar - br)
      const c = rc[k]
      const s = rs[k]
      outRe[k] = fer + c * for_ + s * foi
      outIm[k] = fei + c * foi - s * for_
    }
    outIm[0] = 0
    outIm[m] = 0
  }

  /**
   * Real inverse transform without allocation: n/2+1 bins in, n real samples
   * out (into `out`, any typed array of length >= n). Imaginary parts of the
   * DC and Nyquist bins are ignored.
   */
  realInverse(re, im, out) {
    this._realSetup()
    const n = this.n
    const m = n >> 1
    const zr = this._zr
    const zi = this._zi
    const rc = this._rc
    const rs = this._rs
    for (let k = 0; k < m; k++) {
      const ar = re[k]
      const ai = k === 0 ? 0 : im[k]
      const br = re[m - k]
      const bi = m - k === m || m - k === 0 ? 0 : im[m - k]
      // Fe = (X[k] + conj X[m-k]) / 2 ; Fo = (X[k] - conj X[m-k]) conj(W^k) / 2
      const fer = 0.5 * (ar + br)
      const fei = 0.5 * (ai - bi)
      const dr = ar - br
      const di = ai + bi
      const c = rc[k]
      const s = rs[k]
      const for_ = 0.5 * (dr * c - di * s)
      const foi = 0.5 * (dr * s + di * c)
      zr[k] = fer - foi
      zi[k] = fei + for_
    }
    if (this._half) this._half.inverse(zr, zi)
    for (let j = 0; j < m; j++) {
      out[2 * j] = zr[j]
      out[2 * j + 1] = zi[j]
    }
  }
}

const SHARED = new Map()

/** A cached FFT object per size, for callers that do not keep their own. */
export function fftOf(n) {
  let f = SHARED.get(n)
  if (!f) {
    f = new FFT(n)
    SHARED.set(n, f)
  }
  return f
}

/** Real FFT: returns { re, im } Float64Arrays of n/2+1 bins. */
export function rfft(fft, sig) {
  const m = (fft.n >> 1) + 1
  const re = new Float64Array(m)
  const im = new Float64Array(m)
  fft.realForward(sig, re, im)
  return { re, im }
}

/** Inverse real FFT: n/2+1 bins in, Float32Array(n) out. */
export function irfft(fft, re, im) {
  const out = new Float32Array(fft.n)
  fft.realInverse(re, im, out)
  return out
}

/** Smallest power of two >= n (at least 2). */
export function nextPow2(n) {
  let p = 2
  while (p < n) p <<= 1
  return p
}
