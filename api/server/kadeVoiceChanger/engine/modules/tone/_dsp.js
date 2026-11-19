// modules/tone/_dsp.js - shared building blocks for the tone family.
//
// THIS FILE IS NOT AN EFFECT MODULE. It has no default export; the registry
// tool must skip files whose names start with "_". Only files in
// modules/tone/ import it.
//
// What is here, and where each technique comes from:
// 1. designInto(): second-order filter coefficients from Robert
//    Bristow-Johnson's "Cookbook formulae for audio EQ biquad filter
//    coefficients" (the RBJ cookbook), written into a Float64Array so that a
//    live parameter change never allocates. Also first-order low pass, high
//    pass and a first-order tilt shelf made with the bilinear transform and
//    frequency prewarping: the tilt's zero and pole sit symmetrically around
//    the pivot on a log axis, so the pivot itself is untouched and the two
//    ends move by equal and opposite amounts.
// 2. EqBank: a cascade of Direct Form I biquads for one or two channels whose
//    coefficients glide toward new targets. Gliding the five coefficients is
//    always stable, because the region of stable (a1, a2) pairs is a
//    triangle (a convex set) and every blend of two stable filters stays
//    inside it. Glide steps happen on a fixed 16-sample grid counted from
//    the first sample, so the output never depends on how a host cuts the
//    audio into blocks: offline and live renders give identical samples.
// 3. BQ: one fixed biquad without allocation, for crossovers and side chains.
// 4. CompCore: the feed-forward, log-domain compressor gain computer with a
//    quadratic soft knee and branching attack/release smoothing of the gain
//    reduction, from Giannoulis, Massberg and Reiss, "Digital Dynamic Range
//    Compressor Design - A Tutorial and Analysis" (JAES 2012), fed by a short
//    mean-square detector.
// 5. Limiter: a streaming lookahead brick-wall limiter after Geraint Luff,
//    "Signalsmith Audio: limiter design": the minimum required gain is held
//    over the lookahead, smoothed with instant attack and slow release, then
//    averaged over exactly the lookahead length. Every gain value averaged
//    for the sample at a peak already saw that peak, so the gain there is
//    never above what the peak needs and the ceiling holds by construction.
// 6. Loudness keeping for tone changes: SpeechWeight (a filter cascade's
//    level against the long-term shape of speech, an instant estimate),
//    matchLoudness (offline: BS.1770 integrated loudness measured before and
//    after, matched exactly) and LoudMatch (live: K-weighted powers in and
//    out, gated and averaged, applied on a fixed 100 ms grid).
// 7. GainGlide (a volume that glides instead of jumping), safety (a soft
//    ceiling for runaway settings), the live/offline glue (liveCopy,
//    runAligned for stages with lookahead) and small helpers: clamps,
//    decibels, a smoothstep, frame levels and a percentile for the offline
//    "measure first" options.
//
// Every recursive state is flushed to exact zero below 1e-25 (far above the
// float denormal range) and reset when it stops being finite, so silent
// tails stay fast and nothing can turn into NaN or Infinity.

export const TINY = 1e-25

// filter type codes
export const OFF = 0
export const BELL = 1
export const LOWSHELF = 2
export const HIGHSHELF = 3
export const LOWCUT = 4 // second-order high pass
export const HIGHCUT = 5 // second-order low pass
export const NOTCH = 6
export const BANDPASS = 7 // constant 0 dB peak
export const ALLPASS = 8
export const TILT1 = 9 // first-order tilt, gainDb is the change at the top end
export const LOWPASS1 = 10
export const HIGHPASS1 = 11

const LN10_20 = Math.LN10 / 20
const DB_PER_LN_POW = 10 / Math.LN10 // dB of a power value per natural log

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

/** Decibels to linear gain, never NaN. */
export function dbLin(db) {
  const d = +db
  return d === d ? Math.exp(d * LN10_20) : 1
}

/** Linear power to dB, silence reads -200. */
export function powDb(p) {
  return p > 1e-20 ? Math.log(p) * DB_PER_LN_POW : -200
}

export function smoothstep(x) {
  const t = x < 0 ? 0 : x > 1 ? 1 : x
  return t * t * (3 - 2 * t)
}

/** One-pole coefficient for a time constant in ms at a rate (per step of `every` samples). */
export function poleCoef(ms, sr, every = 1) {
  const t = +ms
  if (!(t > 0) || !(sr > 0)) return 0
  return Math.exp(-(1000 * every) / (t * sr))
}

/** "Sharpness" percent (0 wide .. 100 narrow) to a filter Q from 0.25 to 16. */
export function sharpToQ(s) {
  const v = clamp(+s || 0, 0, 100)
  return 0.25 * Math.pow(2, (6 * v) / 100)
}

function ident(c, o) {
  c[o] = 1
  c[o + 1] = 0
  c[o + 2] = 0
  c[o + 3] = 0
  c[o + 4] = 0
}

function isIdent(c, o) {
  return c[o] === 1 && c[o + 1] === 0 && c[o + 2] === 0 && c[o + 3] === 0 && c[o + 4] === 0
}

/**
 * Write normalised coefficients b0 b1 b2 a1 a2 into c[o..o+4].
 * Bands that sit above what the sample rate can carry turn into a straight
 * wire (bells, high shelves, high cuts, notches) or are held just under the
 * top (low cuts, low shelves, band passes), so 8 kHz takes behave.
 */
export function designInto(c, o, type, sr, freq, q, gainDb) {
  if (type === OFF) {
    ident(c, o)
    return
  }
  let f = +freq
  if (!(f > 1)) f = 1
  let Q = +q
  if (!(Q > 0.05)) Q = 0.05
  if (Q > 400) Q = 400
  let g = +gainDb
  if (!(g === g) || g === Infinity || g === -Infinity) g = 0
  const top = 0.475 * sr
  if (f >= top) {
    if (type === BELL || type === HIGHSHELF || type === HIGHCUT || type === NOTCH || type === LOWPASS1) {
      ident(c, o)
      return
    }
    f = top
  }
  if ((type === BELL || type === LOWSHELF || type === HIGHSHELF || type === TILT1) && g > -1e-9 && g < 1e-9) {
    ident(c, o)
    return
  }
  if (type === TILT1 || type === LOWPASS1 || type === HIGHPASS1) {
    const t = Math.tan((Math.PI * f) / sr)
    if (type === LOWPASS1) {
      const b = t / (1 + t)
      c[o] = b
      c[o + 1] = b
      c[o + 3] = (t - 1) / (t + 1)
    } else if (type === HIGHPASS1) {
      const b = 1 / (1 + t)
      c[o] = b
      c[o + 1] = -b
      c[o + 3] = (t - 1) / (t + 1)
    } else {
      // H(s) = G (s + wp/G) / (s + G wp): lows at 1/G, highs at G, |H(j wp)| = 1
      const G = Math.exp(g * LN10_20)
      const a0 = 1 + G * t
      c[o] = (G + t) / a0
      c[o + 1] = (t - G) / a0
      c[o + 3] = (G * t - 1) / a0
    }
    c[o + 2] = 0
    c[o + 4] = 0
    return
  }
  const w0 = (2 * Math.PI * f) / sr
  const cs = Math.cos(w0)
  const sn = Math.sin(w0)
  const alpha = sn / (2 * Q)
  const A = Math.exp(g * (LN10_20 / 2)) // 10^(g/40)
  let b0, b1, b2, a0, a1, a2
  switch (type) {
    case HIGHCUT:
      b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0
      a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha
      break
    case LOWCUT:
      b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0
      a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha
      break
    case BANDPASS:
      b0 = alpha; b1 = 0; b2 = -alpha
      a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha
      break
    case NOTCH:
      b0 = 1; b1 = -2 * cs; b2 = 1
      a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha
      break
    case ALLPASS:
      b0 = 1 - alpha; b1 = -2 * cs; b2 = 1 + alpha
      a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha
      break
    case LOWSHELF: {
      const sq = 2 * Math.sqrt(A) * alpha
      b0 = A * ((A + 1) - (A - 1) * cs + sq)
      b1 = 2 * A * ((A - 1) - (A + 1) * cs)
      b2 = A * ((A + 1) - (A - 1) * cs - sq)
      a0 = (A + 1) + (A - 1) * cs + sq
      a1 = -2 * ((A - 1) + (A + 1) * cs)
      a2 = (A + 1) + (A - 1) * cs - sq
      break
    }
    case HIGHSHELF: {
      const sq = 2 * Math.sqrt(A) * alpha
      b0 = A * ((A + 1) + (A - 1) * cs + sq)
      b1 = -2 * A * ((A - 1) + (A + 1) * cs)
      b2 = A * ((A + 1) + (A - 1) * cs - sq)
      a0 = (A + 1) - (A - 1) * cs + sq
      a1 = 2 * ((A - 1) - (A + 1) * cs)
      a2 = (A + 1) - (A - 1) * cs - sq
      break
    }
    default: // BELL
      b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A
      a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A
  }
  c[o] = b0 / a0
  c[o + 1] = b1 / a0
  c[o + 2] = b2 / a0
  c[o + 3] = a1 / a0
  c[o + 4] = a2 / a0
}

/** Magnitude (linear) of the coefficients at c[o..] for a frequency given by cos/sin of w and 2w. */
export function magAt(c, o, c1, s1, c2, s2) {
  const nr = c[o] + c[o + 1] * c1 + c[o + 2] * c2
  const ni = -(c[o + 1] * s1 + c[o + 2] * s2)
  const dr = 1 + c[o + 3] * c1 + c[o + 4] * c2
  const di = -(c[o + 3] * s1 + c[o + 4] * s2)
  const den = dr * dr + di * di
  return den > 1e-30 ? Math.sqrt((nr * nr + ni * ni) / den) : 1
}

// ---------------------------------------------------------------- speech weight

/**
 * Level correction for a tone change, so a colour can change while the
 * loudness does not. The response of a filter cascade is measured at 32
 * log-spaced points from 80 Hz to 10 kHz, weighted by the long-term shape
 * of speech (power density roughly flat below 500 Hz and falling 6 dB per
 * octave above it; each log-spaced point covers a band proportional to its
 * frequency), and the correction is one over the root of the weighted
 * power. It is a starting estimate: offline the take is measured exactly
 * (matchLoudness), live the LoudMatch below refines it. Allocates only in
 * the constructor.
 */
export class SpeechWeight {
  constructor(sr) {
    const N = 32
    this.n = N
    this.w = new Float64Array(N)
    this.cs = new Float64Array(N * 4)
    let ws = 0
    for (let i = 0; i < N; i++) {
      const f0 = 80 * Math.pow(10000 / 80, i / (N - 1))
      const w = f0 < 500 ? f0 / 500 : 500 / f0
      this.w[i] = w
      ws += w
      const f = f0 < 0.45 * sr ? f0 : 0.45 * sr
      const om = (2 * Math.PI * f) / sr
      this.cs[i * 4] = Math.cos(om)
      this.cs[i * 4 + 1] = Math.sin(om)
      this.cs[i * 4 + 2] = Math.cos(2 * om)
      this.cs[i * 4 + 3] = Math.sin(2 * om)
    }
    for (let i = 0; i < N; i++) this.w[i] /= ws
  }

  /** Correction gain (linear, 1/8..8) for the cascade of `slots` sections in c. */
  correction(c, slots) {
    let e = 0
    const cs = this.cs
    for (let i = 0; i < this.n; i++) {
      let m = 1
      const o = i * 4
      for (let s = 0; s < slots; s++) m *= magAt(c, s * 5, cs[o], cs[o + 1], cs[o + 2], cs[o + 3])
      e += this.w[i] * m * m
    }
    let g = e > 1e-6 ? 1 / Math.sqrt(e) : 1
    if (g > 8) g = 8
    if (g < 0.125) g = 0.125
    return g
  }
}

// ---------------------------------------------------------------- EqBank

export class EqBank {
  constructor(sr, slots, nch = 2, glideMs = 20) {
    this.sr = sr
    this.slots = slots
    this.nch = nch
    this.tgt = new Float64Array(slots * 5)
    this.cur = new Float64Array(slots * 5)
    for (let s = 0; s < slots; s++) {
      this.tgt[s * 5] = 1
      this.cur[s * 5] = 1
    }
    this.st = new Float64Array(nch * slots * 4)
    this.on = new Uint8Array(slots)
    this.k = 1 - Math.exp(-16 / (Math.max(1, glideMs) * 0.001 * sr))
    this.t = 0
    this.gliding = false
  }

  /** Set slot s's target filter (glides there unless snap() follows). */
  design(s, type, freq, q, gainDb) {
    designInto(this.tgt, s * 5, type, this.sr, freq, q, gainDb)
    this.gliding = true
  }

  /** Jump straight to the targets (used when a render or a live stage starts). */
  snap() {
    this.cur.set(this.tgt)
    this.gliding = false
    this._flags()
  }

  _flags() {
    for (let s = 0; s < this.slots; s++) this.on[s] = isIdent(this.cur, s * 5) && isIdent(this.tgt, s * 5) ? 0 : 1
  }

  _glide() {
    const cur = this.cur
    const tgt = this.tgt
    const k = this.k
    let mx = 0
    for (let j = 0; j < cur.length; j++) {
      const d = tgt[j] - cur[j]
      cur[j] += d * k
      const a = d < 0 ? -d : d
      if (a > mx) mx = a
    }
    if (mx < 1e-7) {
      cur.set(tgt)
      this.gliding = false
    }
    this._flags()
  }

  /** Filter chs[0..nch-1] in place over n samples starting at off. */
  run(chs, nch, n, off = 0) {
    const slots = this.slots
    const cur = this.cur
    const st = this.st
    const on = this.on
    const nc = nch < this.nch ? nch : this.nch
    let i = off
    n += off
    while (i < n) {
      const ph = this.t & 15
      let end = i + 16 - ph
      if (end > n) end = n
      if (ph === 0 && this.gliding) this._glide()
      for (let c = 0; c < nc; c++) {
        const x = chs[c]
        for (let s = 0; s < slots; s++) {
          const so = (c * slots + s) * 4
          if (!on[s]) {
            // a straight wire: keep the state an identity filter would hold
            if (end - i >= 2) {
              st[so] = x[end - 1]
              st[so + 1] = x[end - 2]
            } else {
              st[so + 1] = st[so]
              st[so] = x[i]
            }
            st[so + 2] = st[so]
            st[so + 3] = st[so + 1]
            continue
          }
          const co = s * 5
          const b0 = cur[co], b1 = cur[co + 1], b2 = cur[co + 2], a1 = cur[co + 3], a2 = cur[co + 4]
          let x1 = st[so], x2 = st[so + 1], y1 = st[so + 2], y2 = st[so + 3]
          for (let j = i; j < end; j++) {
            const v = x[j]
            let y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            if (!(y > TINY || y < -TINY)) y = 0
            else if (y > 1e9 || y < -1e9) y = 0
            x2 = x1
            x1 = v
            y2 = y1
            y1 = y
            x[j] = y
          }
          if (!(x1 > -1e9 && x1 < 1e9) || !(x2 > -1e9 && x2 < 1e9)) {
            x1 = 0
            x2 = 0
            y1 = 0
            y2 = 0
          }
          st[so] = x1
          st[so + 1] = x2
          st[so + 2] = y1
          st[so + 3] = y2
        }
      }
      this.t += end - i
      i = end
    }
  }

  reset() {
    this.st.fill(0)
    this.t = 0
  }
}

// ---------------------------------------------------------------- BQ

const TMP = new Float64Array(5)

export class BQ {
  constructor(type = OFF, sr = 48000, freq = 1000, q = 0.7071, gainDb = 0) {
    this.b0 = 1
    this.b1 = 0
    this.b2 = 0
    this.a1 = 0
    this.a2 = 0
    this.x1 = 0
    this.x2 = 0
    this.y1 = 0
    this.y2 = 0
    if (type !== OFF) this.design(type, sr, freq, q, gainDb)
  }

  design(type, sr, freq, q, gainDb) {
    designInto(TMP, 0, type, sr, freq, q, gainDb)
    this.b0 = TMP[0]
    this.b1 = TMP[1]
    this.b2 = TMP[2]
    this.a1 = TMP[3]
    this.a2 = TMP[4]
    return this
  }

  tick(x) {
    let y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    if (!(y > TINY || y < -TINY)) y = 0
    else if (y > 1e9 || y < -1e9) {
      y = 0
      this.x1 = this.x2 = this.y1 = this.y2 = 0
      return 0
    }
    this.x2 = this.x1
    this.x1 = x === x && x < 1e9 && x > -1e9 ? x : 0
    this.y2 = this.y1
    this.y1 = y
    return y
  }

  reset() {
    this.x1 = this.x2 = this.y1 = this.y2 = 0
  }
}

// ---------------------------------------------------------------- CompCore

/**
 * Gain computer plus smoothing. feed(x2) takes the detector input as a
 * squared sample (already the largest of the linked channels) and returns
 * the smoothed gain reduction in dB (0 or more). After each feed, `want`
 * holds the unsmoothed static reduction for that sample.
 */
export class CompCore {
  constructor(sr) {
    this.sr = sr
    this.p = 0
    this.s = 0
    this.want = 0
    this.setup(-20, 3, 6, 5, 100, 2)
  }

  setup(thresholdDb, ratio, kneeDb, attackMs, releaseMs, detectMs = 2) {
    this.T = +thresholdDb
    const R = ratio >= 1 ? +ratio : 1
    this.slope = 1 - 1 / R // dB of reduction per dB over
    this.W = kneeDb > 0 ? +kneeDb : 0
    this.lo = this.T - this.W / 2
    this.hi = this.T + this.W / 2
    this.ca = poleCoef(attackMs, this.sr)
    this.cr = poleCoef(releaseMs, this.sr)
    this.cd = poleCoef(detectMs, this.sr)
  }

  /** Static gain reduction in dB for a level in dB. */
  staticGr(x) {
    if (x <= this.lo) return 0
    if (x >= this.hi || this.W === 0) return x > this.T ? this.slope * (x - this.T) : 0
    const d = x - this.lo
    return (this.slope * d * d) / (2 * this.W)
  }

  feed(x2) {
    let p = x2 + this.cd * (this.p - x2)
    if (!(p > 1e-30)) p = 0
    else if (p > 1e12) p = 1e12
    this.p = p
    const want = p > 1e-20 ? this.staticGr(Math.log(p) * DB_PER_LN_POW) : 0
    this.want = want
    let s = this.s
    s = want > s ? want + this.ca * (s - want) : want + this.cr * (s - want)
    if (s < 1e-9) s = 0
    this.s = s
    return s
  }

  reset() {
    this.p = 0
    this.s = 0
    this.want = 0
  }
}

// ---------------------------------------------------------------- Limiter

const F32 = new Float32Array(1)
const U32 = new Uint32Array(F32.buffer)

/** Largest float32 at or below x (x > 0), so a clamp never lands one ulp over. */
export function f32Below(x) {
  F32[0] = x
  if (F32[0] > x) U32[0] -= 1
  return F32[0]
}

/**
 * Streaming lookahead limiter, linked over up to two channels. Its output is
 * delayed by `latency` samples. step(xL, xR) consumes one frame and leaves
 * the delayed, limited frame in this.oL / this.oR.
 */
export class Limiter {
  constructor(sr, lookMs = 1.5, releaseMs = 60, ceilingDb = -1) {
    const L = Math.max(1, Math.round((lookMs * sr) / 1000))
    this.L = L
    this.latency = L
    this.dlL = new Float64Array(L + 1)
    this.dlR = new Float64Array(L + 1)
    this.cap = L + 2
    this.qv = new Float64Array(this.cap)
    this.qi = new Float64Array(this.cap)
    this.qh = 0
    this.qn = 0
    this.bx = new Float64Array(L)
    this.bx.fill(1)
    this.bs = L
    this.bp = 0
    this.h = 1
    this.pos = 0
    this.oL = 0
    this.oR = 0
    this.sr = sr
    this.setup(releaseMs, ceilingDb)
  }

  setup(releaseMs, ceilingDb) {
    this.rel = poleCoef(releaseMs, this.sr)
    // up to 12 dB over full scale, for backstops that guard the headroom between stages
    this.ceil = dbLin(clamp(+ceilingDb || 0, -60, 12))
    this.c32 = f32Below(this.ceil)
  }

  step(xL, xR) {
    const L = this.L
    let a = xL < 0 ? -xL : xL
    const b = xR < 0 ? -xR : xR
    if (b > a) a = b
    if (!(a <= 1e9)) a = 1e9
    const r = a > this.ceil ? this.ceil / a : 1
    // monotonic deque of the last L + 1 required gains (minimum at the head)
    const cap = this.cap
    const qv = this.qv
    const qi = this.qi
    while (this.qn > 0) {
      const ti = (this.qh + this.qn - 1) % cap
      if (qv[ti] >= r) this.qn--
      else break
    }
    const wi = (this.qh + this.qn) % cap
    qv[wi] = r
    qi[wi] = this.pos
    this.qn++
    while (qi[this.qh] < this.pos - L) {
      this.qh = (this.qh + 1) % cap
      this.qn--
    }
    const m = qv[this.qh]
    // instant attack, slow release
    let h = this.h
    h = m < h ? m : m + this.rel * (h - m)
    this.h = h
    // moving average over exactly L values
    this.bs += h - this.bx[this.bp]
    this.bx[this.bp] = h
    this.bp++
    if (this.bp === L) this.bp = 0
    if ((this.pos & 65535) === 65535) {
      let s = 0
      for (let j = 0; j < L; j++) s += this.bx[j]
      this.bs = s
    }
    let g = this.bs / L
    if (g > 1) g = 1
    // delay line: write the newest, read the one L samples old
    const w = this.pos % (L + 1)
    const rd = (this.pos + 1) % (L + 1)
    this.dlL[w] = xL === xL && xL < 1e9 && xL > -1e9 ? xL : 0
    this.dlR[w] = xR === xR && xR < 1e9 && xR > -1e9 ? xR : 0
    let yL = this.dlL[rd] * g
    let yR = this.dlR[rd] * g
    const c = this.c32
    if (yL > c) yL = c
    else if (yL < -c) yL = -c
    if (yR > c) yR = c
    else if (yR < -c) yR = -c
    this.oL = yL
    this.oR = yR
    this.pos++
  }

  reset() {
    this.dlL.fill(0)
    this.dlR.fill(0)
    this.qh = 0
    this.qn = 0
    this.bx.fill(1)
    this.bs = this.L
    this.bp = 0
    this.h = 1
    this.pos = 0
  }
}

// ---------------------------------------------------------------- gain glide

/**
 * A volume that glides to new targets (about 20 ms) instead of jumping, so
 * live moves never click. The glide is per sample, so block sizes never
 * change the result.
 */
export class GainGlide {
  constructor(sr, ms = 20, g = 1) {
    this.k = 1 - poleCoef(ms, sr)
    this.g = g
    this.gt = g
  }

  to(gt, snap = false) {
    this.gt = gt === gt && gt < 1e6 && gt > -1e6 ? gt : 1
    if (snap) this.g = this.gt
  }

  apply(chs, nch, n, off = 0) {
    let g = this.g
    const gt = this.gt
    const end = off + n
    if (g === gt) {
      if (gt === 1) return
      for (let c = 0; c < nch; c++) {
        const a = chs[c]
        for (let i = off; i < end; i++) a[i] *= gt
      }
      return
    }
    const k = this.k
    const a = chs[0]
    const b = nch > 1 ? chs[1] : null
    for (let i = off; i < end; i++) {
      if (g !== gt) {
        g += (gt - g) * k
        const d = gt - g
        if (d < 1e-7 && d > -1e-7) g = gt
      }
      a[i] *= g
      if (b) b[i] *= g
    }
    this.g = g
  }
}

// ---------------------------------------------------------------- safety

/**
 * A soft ceiling for runaway settings (every band of an EQ boosted at the
 * same frequency, say): untouched below 4 (12 dB over full scale, which a
 * sensible setting never reaches before the final limiter), then a tanh
 * knee that never passes 7.9, so no stage can hand on a peak of 8 or more.
 */
export function safety(chs, nch, n, off = 0) {
  const end = off + n
  for (let c = 0; c < nch; c++) {
    const x = chs[c]
    for (let i = off; i < end; i++) {
      const v = x[i]
      if (v > 4 || v < -4) {
        const a = v < 0 ? -v : v
        const y = 4 + 3.9 * Math.tanh((a - 4) / 3.9)
        x[i] = v < 0 ? -y : y
      } else if (v !== v) x[i] = 0
    }
  }
}

/**
 * Offline loudness match: scale the channels so their integrated loudness
 * (core/loudness.js, BS.1770) returns to `beforeLufs`. Silence and takes
 * under the -70 LUFS gate are left alone; the change is capped at 18 dB.
 */
export function matchLoudness(b, beforeLufs, lufsFn) {
  if (!(beforeLufs > -70)) return
  const after = lufsFn(b)
  if (!(after > -70)) return
  let d = beforeLufs - after
  if (d > 18) d = 18
  if (d < -18) d = -18
  if (d < 0.01 && d > -0.01) return
  const g = Math.pow(10, d / 20)
  for (let c = 0; c < b.ch.length; c++) {
    const x = b.ch[c]
    for (let i = 0; i < x.length; i++) x[i] *= g
  }
  safety(b.ch, b.ch.length, b.ch[0].length)
}

// ---------------------------------------------------------------- live loudness match

/**
 * Live counterpart of matchLoudness: the K-weighted (BS.1770 shelf and
 * high pass, core/loudness.js kWeightingCoefs) power of what goes in and of
 * what the filters make of it (before any level correction) is gathered in
 * 100 ms windows; windows more than 20 dB under the running level are
 * skipped (pauses), the rest are averaged as powers, and the correction is
 * the square root of their ratio, the same quantity an integrated loudness
 * meter compares. It starts from the instant estimate (counted as one
 * window) and keeps a running mean that learns fast for the first second
 * and then settles to about three seconds of memory, so it neither lags
 * nor wobbles with each syllable. Allocates only in the constructor.
 */
export class LoudMatch {
  constructor(sr, kCoefs) {
    const mk = () => {
      const a = new BQ()
      const b = new BQ()
      a.b0 = kCoefs.shelf.b0; a.b1 = kCoefs.shelf.b1; a.b2 = kCoefs.shelf.b2; a.a1 = kCoefs.shelf.a1; a.a2 = kCoefs.shelf.a2
      b.b0 = kCoefs.hp.b0; b.b1 = kCoefs.hp.b1; b.b2 = kCoefs.hp.b2; b.a1 = kCoefs.hp.a1; b.a2 = kCoefs.hp.a2
      return [a, b]
    }
    const i = mk()
    const o = mk()
    this.i1 = i[0]
    this.i2 = i[1]
    this.o1 = o[0]
    this.o2 = o[1]
    this.win = Math.max(1, Math.round(0.1 * sr))
    this.pin = 0
    this.praw = 0
    this.cin = 0
    this.craw = 0
    this.si = 0
    this.sr = 0
    this.ready = false
    this.k = 0
    this.est = 1
  }

  _acc(chs, nch, n, off, f1, f2) {
    let e = 0
    const a = chs[0]
    const b = nch > 1 ? chs[1] : null
    const end = off + n
    for (let i = off; i < end; i++) {
      const x = b ? 0.5 * (a[i] + b[i]) : a[i]
      const y = f2.tick(f1.tick(x))
      e += y * y
    }
    return e
  }

  /** Samples left before the current 100 ms window closes. */
  toBoundary() {
    return this.win - this.cin
  }

  measureIn(chs, nch, n, off = 0) {
    this.pin += this._acc(chs, nch, n, off, this.i1, this.i2)
    this.cin += n
  }

  /** The filtered, not yet corrected signal, over the same samples. */
  measureRaw(chs, nch, n, off = 0) {
    this.praw += this._acc(chs, nch, n, off, this.o1, this.o2)
    this.craw += n
  }

  /**
   * Close the window if it is full. Returns true when gain() moved; the
   * caller applies it from the next sample, so the result never depends on
   * how the host cuts the audio into blocks.
   */
  endWindow() {
    if (this.cin < this.win) return false
    const wi = this.pin / this.cin
    const wr = this.praw / this.craw
    this.pin = this.praw = 0
    this.cin = this.craw = 0
    if (!(wi > 1e-7) || !(wr > 1e-12) || (this.ready && wi < 0.01 * this.si)) return false
    if (!this.ready) {
      // the estimate stands in for the past
      this.si = wi
      this.sr = wi / (this.est * this.est)
      this.ready = true
      this.k = 0
    }
    this.k++
    const a = 1 / (this.k + 1) > 0.03 ? 1 / (this.k + 1) : 0.03
    this.si += a * (wi - this.si)
    this.sr += a * (wr - this.sr)
    return true
  }

  /** Linear correction (1/8..8); call when ready. */
  gain() {
    let g = this.sr > 0 ? Math.sqrt(this.si / this.sr) : 1
    if (!(g < 8)) g = 8
    if (g < 0.125) g = 0.125
    return g
  }

  /**
   * The filters changed and est is the new instant estimate: keep what was
   * learned about the input, start the output side from the estimate and
   * learn fast again. The window grid stays.
   */
  restart(est) {
    this.est = est > 0 ? est : 1
    if (this.ready) {
      this.sr = this.si / (this.est * this.est)
      this.k = 0
    }
  }

  reset() {
    this.i1.reset()
    this.i2.reset()
    this.o1.reset()
    this.o2.reset()
    this.ready = false
    this.pin = this.praw = 0
    this.cin = this.craw = 0
  }
}

// ---------------------------------------------------------------- live and offline glue

/**
 * Live entry: copy ins into outs where they are different arrays (outs may
 * alias ins) over n samples. Returns the number of output channels.
 */
export function liveCopy(ins, outs, n) {
  const no = outs.length
  const ni = ins.length
  for (let c = 0; c < no; c++) {
    const src = ins[c < ni ? c : ni - 1]
    const dst = outs[c]
    if (src !== dst) for (let i = 0; i < n; i++) dst[i] = src[i]
  }
  return no
}

/**
 * Offline helper for stages with a fixed latency: runs `runFn(chs, nch, n)`
 * over the input padded with `lat` zeros and returns channels with the
 * latency removed (same length as the input).
 */
export function runAligned(chs, lat, runFn) {
  const nch = chs.length
  const n = chs[0].length
  if (!(lat > 0)) {
    runFn(chs, nch, n)
    return chs
  }
  const pad = new Array(nch)
  for (let c = 0; c < nch; c++) {
    const a = new Float32Array(n + lat)
    a.set(chs[c])
    pad[c] = a
  }
  runFn(pad, nch, n + lat)
  const out = new Array(nch)
  for (let c = 0; c < nch; c++) out[c] = pad[c].slice(lat, lat + n)
  return out
}

/**
 * Mean-square level in dB of every hop (hopMs) over a winMs window, linked
 * over channels (mean of channels). Returns a Float32Array (offline use).
 */
export function frameLevelsDb(chs, sr, hopMs = 10, winMs = 30) {
  const n = chs[0].length
  const hop = Math.max(1, Math.round((hopMs * sr) / 1000))
  const win = Math.max(hop, Math.round((winMs * sr) / 1000))
  const nf = Math.max(1, Math.ceil(n / hop))
  const out = new Float32Array(nf)
  const nch = chs.length
  for (let f = 0; f < nf; f++) {
    const c0 = f * hop + (hop >> 1) - (win >> 1)
    const a = c0 < 0 ? 0 : c0
    const b = c0 + win > n ? n : c0 + win
    let e = 0
    for (let c = 0; c < nch; c++) {
      const x = chs[c]
      for (let i = a; i < b; i++) {
        const v = x[i]
        if (v === v && v < 1e9 && v > -1e9) e += v * v
      }
    }
    const cnt = (b - a) * nch
    out[f] = cnt > 0 ? powDb(e / cnt) : -200
  }
  return out
}

/** p-th percentile (0..1) of a numeric array (copied and sorted). */
export function percentile(arr, p) {
  if (!arr.length) return -200
  const s = Float64Array.from(arr).sort()
  const idx = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))
  return s[idx]
}
