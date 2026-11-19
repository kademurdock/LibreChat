// core/window.js - analysis and synthesis windows.
//
// Formulas follow Harris 1978, "On the use of windows for harmonic analysis
// with the discrete Fourier transform" (Hann, Hamming, exact three-term
// Blackman) and Kaiser and Schafer 1980 for the Kaiser-Bessel window.
//
// Periodic versus symmetric: hann, sqrtHann, hamming and blackman default to
// the PERIODIC ("DFT-even") form, w[i] = f(i / n), which is what overlap-add
// spectral processing needs (Hann at hop n/4 or n/2 then sums to an exact
// constant). Pass symmetric = true for the classic filter-design form,
// w[i] = f(i / (n - 1)). kaiser defaults to symmetric, because it is mostly
// used to taper windowed-sinc filters (resampling, FIR design).
//
// All windows are returned as fresh Float64Array, so callers may scale them.

function denom(n, symmetric) {
  return symmetric ? Math.max(1, n - 1) : Math.max(1, n)
}

/** Hann (raised cosine). */
export function hann(n, symmetric = false) {
  const w = new Float64Array(n)
  const d = denom(n, symmetric)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / d)
  if (n === 1) w[0] = 1
  return w
}

/** Square root of Hann: analysis and synthesis together give Hann (COLA at hop n/2). */
export function sqrtHann(n, symmetric = false) {
  const w = hann(n, symmetric)
  for (let i = 0; i < n; i++) w[i] = Math.sqrt(w[i])
  return w
}

/** Hamming, a0 = 0.54. */
export function hamming(n, symmetric = false) {
  const w = new Float64Array(n)
  const d = denom(n, symmetric)
  for (let i = 0; i < n; i++) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / d)
  if (n === 1) w[0] = 1
  return w
}

/** Exact Blackman (Harris 1978 coefficients 7938/18608, 9240/18608, 1430/18608). */
export function blackman(n, symmetric = false) {
  const a0 = 7938 / 18608
  const a1 = 9240 / 18608
  const a2 = 1430 / 18608
  const w = new Float64Array(n)
  const d = denom(n, symmetric)
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / d
    const v = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x)
    w[i] = v < 0 ? 0 : v
  }
  if (n === 1) w[0] = 1
  return w
}

/** Zeroth-order modified Bessel function of the first kind (power series). */
export function besselI0(x) {
  let sum = 1
  let term = 1
  const q = (x * x) / 4
  for (let k = 1; k < 200; k++) {
    term *= q / (k * k)
    sum += term
    if (term < sum * 1e-17) break
  }
  return sum
}

/** Kaiser-Bessel window. beta about 5 to 9 for audio filters. */
export function kaiser(n, beta = 8.6, symmetric = true) {
  const w = new Float64Array(n)
  const d = denom(n, symmetric)
  const den = besselI0(beta)
  for (let i = 0; i < n; i++) {
    const r = (2 * i) / d - 1
    const t = 1 - r * r
    w[i] = besselI0(beta * Math.sqrt(t > 0 ? t : 0)) / den
  }
  if (n === 1) w[0] = 1
  return w
}

/** Window by name: 'hann' | 'sqrthann' | 'hamming' | 'blackman' | 'kaiser' | 'rect'. */
export function windowByName(name, n) {
  switch (String(name || 'hann').toLowerCase()) {
    case 'sqrthann':
    case 'sqrt-hann':
    case 'sqrt_hann':
      return sqrtHann(n)
    case 'hamming':
      return hamming(n)
    case 'blackman':
      return blackman(n)
    case 'kaiser':
      return kaiser(n, 8.6, false)
    case 'rect':
    case 'none': {
      const w = new Float64Array(n)
      w.fill(1)
      return w
    }
    case 'hann':
    default:
      return hann(n)
  }
}
