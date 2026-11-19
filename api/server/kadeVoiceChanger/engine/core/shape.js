// core/shape.js - waveshapers: memoryless sample-in, sample-out curves.
//
// Each function maps one number to one number, so a module can run any of
// them inside its own loop. All are defined for every finite input and never
// return NaN for one; non-finite input returns 0 where the formula could
// otherwise misbehave (fold, crush, the companders).
//
//   tanh(x)            hyperbolic tangent (Math.tanh, with a cheap guard)
//   tanhFast(x)        Pade (7,6) rational approximation of tanh, clamped at
//                      |x| = 4.97 where it reaches 1; about 1e-4 error, much
//                      cheaper on older JavaScript engines
//   softClip(x, k)     tanh(k x) / tanh(k): drive k bends the curve harder
//                      while +-1 still maps to +-1; k near 0 is a straight line
//   hardClip(x, t)     clamp to +-t
//   fold(x, t)         triangle wavefolder: reflects off +-t again and again
//                      (the West Coast synthesis folder), closed form, no loop
//   sinFold(x, amt)    sine wavefolder sin(pi/2 * amt * x)
//   rectify(x, amt)    amt 0..1 blends toward full-wave |x|; amt -1..0 blends
//                      toward half-wave max(x, 0)
//   tube(x, bias)      asymmetric tanh around a bias point with the offset
//                      removed and unity small-signal slope, which adds the
//                      even harmonics of a single-ended valve stage
//   diode(x, amt)      soft one-sided clipper: the negative half is squashed
//   chebyshev(x, n)    Chebyshev polynomial T_n(x) on clamped x: turns a full
//                      scale sine into exactly its n-th harmonic
//   crush(x, bits)     symmetric mid-tread uniform quantiser with step
//                      2^(1 - bits); fractional bits are allowed for smooth
//                      control; zero is always a level; output saturates at
//                      +-1 like a real converter
//   muLaw / muLawInv   ITU-T G.711 mu-law continuous companding curve, mu = 255
//   aLaw / aLawInv     ITU-T G.711 A-law continuous companding curve, A = 87.6
// The G.711 functions are the smooth curves of the standard, not its 8-bit
// segment tables; quantise with crush between them to imitate a phone line.
//
// shapeSig(sig, fn, a, b, mix) applies any of these to a whole Float32Array
// in place with a dry/wet mix.

const MU = 255
const LN1MU = Math.log(1 + MU)
const A = 87.6
const LNA1 = 1 + Math.log(A)

export function tanh(x) {
  if (x > 20) return 1
  if (x < -20) return -1
  const y = Math.tanh(x)
  return y === y ? y : 0
}

export function tanhFast(x) {
  if (x > 4.97) return 1
  if (x < -4.97) return -1
  const x2 = x * x
  const a = x * (135135 + x2 * (17325 + x2 * (378 + x2)))
  const b = 135135 + x2 * (62370 + x2 * (3150 + x2 * 28))
  return a / b
}

export function softClip(x, k = 1) {
  const d = Number(k)
  if (!(d > 1e-4)) return x > 1e6 ? 1e6 : x < -1e6 ? -1e6 : x
  return tanh(d * x) / Math.tanh(d)
}

export function hardClip(x, t = 1) {
  const l = Math.abs(t)
  return x > l ? l : x < -l ? -l : x === x ? x : 0
}

export function fold(x, t = 1) {
  const l = Math.abs(t)
  if (!(l > 1e-9) || !Number.isFinite(x)) return 0
  const u = (x - l) / (4 * l)
  return l - 4 * l * Math.abs(u - Math.floor(u + 0.5))
}

export function sinFold(x, amt = 1) {
  if (!Number.isFinite(x)) return 0
  return Math.sin(0.5 * Math.PI * amt * x)
}

export function rectify(x, amt = 1) {
  if (!(x - x === 0)) return 0 // NaN or Infinity in
  const a = amt > 1 ? 1 : amt < -1 ? -1 : amt || 0
  if (a >= 0) return x + a * (Math.abs(x) - x)
  return x + -a * ((x > 0 ? x : 0) - x)
}

export function tube(x, bias = 0.1) {
  const b = Number(bias) || 0
  const tb = Math.tanh(b)
  const slope = 1 - tb * tb
  return (tanh(x + b) - tb) / (slope > 1e-6 ? slope : 1e-6)
}

export function diode(x, amt = 1) {
  if (x >= 0) return x
  const a = Math.max(0, Number(amt) || 0)
  if (a === 0) return x
  return tanh(x * (1 + 4 * a)) / (1 + 4 * a)
}

export function chebyshev(x, n = 2) {
  const v = x > 1 ? 1 : x < -1 ? -1 : x === x ? x : 0
  const order = Math.max(0, Math.floor(n))
  if (order === 0) return 1
  let t0 = 1
  let t1 = v
  for (let k = 1; k < order; k++) {
    const t2 = 2 * v * t1 - t0
    t0 = t1
    t1 = t2
  }
  return t1
}

export function crush(x, bits = 8) {
  if (!Number.isFinite(x)) return 0
  let b = Number(bits)
  if (!(b >= 1)) b = 1
  if (b > 32) b = 32
  const step = Math.pow(2, 1 - b)
  const m = Math.abs(x)
  let q = Math.floor(m / step + 0.5) * step
  if (q > 1) q = 1
  return x < 0 ? -q : q
}

export function muLaw(x, mu = MU) {
  if (!Number.isFinite(x)) return 0
  const v = x > 1 ? 1 : x < -1 ? -1 : x
  const ln = mu === MU ? LN1MU : Math.log(1 + mu)
  const y = Math.log(1 + mu * Math.abs(v)) / ln
  return v < 0 ? -y : y
}

export function muLawInv(y, mu = MU) {
  if (!Number.isFinite(y)) return 0
  const v = y > 1 ? 1 : y < -1 ? -1 : y
  const x = (Math.pow(1 + mu, Math.abs(v)) - 1) / mu
  return v < 0 ? -x : x
}

export function aLaw(x) {
  if (!Number.isFinite(x)) return 0
  const v = x > 1 ? 1 : x < -1 ? -1 : x
  const m = Math.abs(v)
  const y = m < 1 / A ? (A * m) / LNA1 : (1 + Math.log(A * m)) / LNA1
  return v < 0 ? -y : y
}

export function aLawInv(y) {
  if (!Number.isFinite(y)) return 0
  const v = y > 1 ? 1 : y < -1 ? -1 : y
  const m = Math.abs(v)
  const x = m < 1 / LNA1 ? (m * LNA1) / A : Math.exp(m * LNA1 - 1) / A
  return v < 0 ? -x : x
}

/**
 * Apply a shaper to sig in place: sig[i] = mix * fn(sig[i], a, b) + (1 - mix) * sig[i].
 * mix is 0..1. Returns sig.
 */
export function shapeSig(sig, fn, a, b, mix = 1) {
  const w = mix > 1 ? 1 : mix < 0 ? 0 : mix
  const d = 1 - w
  for (let i = 0; i < sig.length; i++) {
    const x = sig[i]
    const y = fn(x, a, b)
    sig[i] = w * y + d * x
  }
  return sig
}
