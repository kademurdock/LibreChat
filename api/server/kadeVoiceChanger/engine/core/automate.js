// core/automate.js - parameter curves over time for the Voice Changer engine.
//
// A curve spec is one of:
// - a number: the same value all the way through;
// - { from, to, shape }: one sweep across the whole clip (or across
//   startSec..endSec when those are given, holding the end values outside);
// - [[tSec, value], ...]: breakpoints in seconds. Values glide linearly
//   between points and hold before the first and after the last. A point may
//   carry a third element naming the shape of the glide INTO it
//   ('lin', 'exp', 'sine', 'step');
// - a function (tSec) => value, sampled once per sample;
// - a Float32Array or plain array of numbers (not pairs): stretched across
//   the clip with linear interpolation.
//
// Shapes:
// - 'lin' is a straight line.
// - 'exp' is a geometric glide (equal ratios per unit time, the way pitch and
//   frequency sound even) when both ends have the same sign and neither is
//   zero; otherwise, since a geometric glide cannot pass through zero, it is
//   the normalised exponential (e^(4t) - 1) / (e^4 - 1), slow then fast.
// - 'sine' is a raised-cosine ease in and out.
// - 'step' holds the old value and jumps at the point.
// Unknown shape names fall back to 'lin'. Non-finite values in a spec count
// as 0, unsorted breakpoints are sorted, and the result is always finite.
//
// curve() fills a Float32Array in one pass without allocating per sample.
// at() evaluates the same spec at one time, for stages that only need a
// value per block or per grain.

const EXP_K = 4
const EXP_DEN = Math.exp(EXP_K) - 1

function fin(v) {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

function shapeName(s) {
  const k = String(s || 'lin').toLowerCase()
  if (k === 'exp' || k === 'exponential' || k === 'log' || k === 'geometric') return 'exp'
  if (k === 'sine' || k === 'sin' || k === 'cos' || k === 'smooth' || k === 'ease') return 'sine'
  if (k === 'step' || k === 'hold' || k === 'jump') return 'step'
  return 'lin'
}

// Value between a and b at fraction u (0..1) for a shape.
function blend(a, b, u, shape) {
  if (u <= 0) return a
  if (u >= 1) return b
  switch (shape) {
    case 'exp':
      if ((a > 0 && b > 0) || (a < 0 && b < 0)) return a * Math.pow(b / a, u)
      return a + (b - a) * ((Math.exp(EXP_K * u) - 1) / EXP_DEN)
    case 'sine':
      return a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * u))
    case 'step':
      return a
    default:
      return a + (b - a) * u
  }
}

function isPairs(spec) {
  return Array.isArray(spec) && spec.length > 0 && Array.isArray(spec[0])
}

function normPoints(spec) {
  const pts = []
  for (let i = 0; i < spec.length; i++) {
    const p = spec[i]
    if (!Array.isArray(p) || p.length < 2) continue
    const t = Number(p[0])
    if (!Number.isFinite(t)) continue
    pts.push({ t, v: fin(p[1]), s: shapeName(p[2]), i })
  }
  pts.sort((a, b) => a.t - b.t || a.i - b.i)
  return pts
}

/**
 * Sample a spec into a Float32Array of len samples at rate sr.
 */
export function curve(spec, len, sr) {
  const n = Math.max(0, Math.floor(Number(len) || 0))
  const out = new Float32Array(n)
  if (!n) return out
  const rate = sr > 0 ? sr : 48000
  if (typeof spec === 'number' || typeof spec === 'string' || spec === null || spec === undefined || typeof spec === 'boolean') {
    out.fill(fin(spec))
    return out
  }
  if (typeof spec === 'function') {
    for (let i = 0; i < n; i++) {
      let v
      try {
        v = Number(spec(i / rate))
      } catch {
        v = 0
      }
      out[i] = Number.isFinite(v) ? v : 0
    }
    return out
  }
  if (isPairs(spec)) {
    const pts = normPoints(spec)
    if (!pts.length) return out
    if (pts.length === 1) {
      out.fill(pts[0].v)
      return out
    }
    let k = 0 // segment index: pts[k] .. pts[k + 1]
    for (let i = 0; i < n; i++) {
      const t = i / rate
      if (t <= pts[0].t) {
        out[i] = pts[0].v
        continue
      }
      while (k < pts.length - 2 && t >= pts[k + 1].t) k++
      const a = pts[k]
      const b = pts[k + 1]
      if (t >= b.t) {
        out[i] = b.v
        continue
      }
      const span = b.t - a.t
      out[i] = span > 0 ? blend(a.v, b.v, (t - a.t) / span, b.s) : b.v
    }
    return out
  }
  if (spec instanceof Float32Array || spec instanceof Float64Array || Array.isArray(spec)) {
    const m = spec.length
    if (!m) return out
    if (m === 1 || n === 1) {
      out.fill(fin(spec[0]))
      return out
    }
    const scale = (m - 1) / (n - 1)
    for (let i = 0; i < n; i++) {
      const x = i * scale
      const j = Math.floor(x)
      const f = x - j
      const a = fin(spec[j])
      out[i] = j + 1 < m ? a + (fin(spec[j + 1]) - a) * f : a
    }
    return out
  }
  if (typeof spec === 'object') {
    const from = fin(spec.from !== undefined ? spec.from : spec.to)
    const to = fin(spec.to !== undefined ? spec.to : spec.from)
    const shape = shapeName(spec.shape)
    const dur = n / rate
    const t0 = spec.startSec !== undefined ? fin(spec.startSec) : 0
    const t1 = spec.endSec !== undefined ? fin(spec.endSec) : dur
    if (!(t1 > t0)) {
      for (let i = 0; i < n; i++) out[i] = i / rate < t0 ? from : to
      return out
    }
    if (shape === 'lin' && t0 === 0 && t1 === dur) {
      const d = n > 1 ? (to - from) / (n - 1) : 0
      for (let i = 0; i < n; i++) out[i] = from + d * i
      out[n - 1] = to
      return out
    }
    const inv = 1 / (t1 - t0)
    const lastT = n > 1 ? (n - 1) / rate : 0
    // the whole-clip sweep should land exactly on `to` at the last sample
    const stretch = t0 === 0 && t1 === dur && lastT > 0 ? dur / lastT : 1
    for (let i = 0; i < n; i++) {
      const u = ((i / rate) * stretch - t0) * inv
      out[i] = blend(from, to, u, shape)
    }
    return out
  }
  return out
}

/**
 * One value of a spec at tSec, where durSec is the clip length (needed for
 * {from, to} sweeps and stretched arrays).
 */
export function at(spec, tSec, durSec) {
  const t = fin(tSec)
  if (typeof spec === 'number' || typeof spec === 'string' || spec === null || spec === undefined || typeof spec === 'boolean') return fin(spec)
  if (typeof spec === 'function') {
    try {
      return fin(spec(t))
    } catch {
      return 0
    }
  }
  if (isPairs(spec)) {
    const pts = normPoints(spec)
    if (!pts.length) return 0
    if (t <= pts[0].t) return pts[0].v
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k]
      const b = pts[k + 1]
      if (t < b.t) {
        const span = b.t - a.t
        return span > 0 ? blend(a.v, b.v, (t - a.t) / span, b.s) : b.v
      }
    }
    return pts[pts.length - 1].v
  }
  const dur = fin(durSec)
  if (spec instanceof Float32Array || spec instanceof Float64Array || Array.isArray(spec)) {
    const m = spec.length
    if (!m) return 0
    if (m === 1 || !(dur > 0)) return fin(spec[0])
    let x = (t / dur) * (m - 1)
    if (x < 0) x = 0
    if (x > m - 1) x = m - 1
    const j = Math.floor(x)
    const a = fin(spec[j])
    return j + 1 < m ? a + (fin(spec[j + 1]) - a) * (x - j) : a
  }
  if (typeof spec === 'object') {
    const from = fin(spec.from !== undefined ? spec.from : spec.to)
    const to = fin(spec.to !== undefined ? spec.to : spec.from)
    const t0 = spec.startSec !== undefined ? fin(spec.startSec) : 0
    const t1 = spec.endSec !== undefined ? fin(spec.endSec) : dur
    if (!(t1 > t0)) return t < t0 ? from : to
    return blend(from, to, (t - t0) / (t1 - t0), shapeName(spec.shape))
  }
  return 0
}

/** True when spec is anything other than a plain constant. */
export function isAutomated(spec) {
  return !(typeof spec === 'number' || typeof spec === 'string' || spec === null || spec === undefined || typeof spec === 'boolean')
}
