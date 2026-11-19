// core/resample.js - sample-rate conversion and variable-speed playback.
//
// Both tools are bandlimited interpolation as described by Julius O. Smith III
// in "Digital Audio Resampling Home Page" (CCRMA), the method behind
// libresample and resample-1.x. Every output sample is the input's
// bandlimited reconstruction evaluated at a fractional read position: a
// weighted sum of the input samples around that position, the weights taken
// from a windowed-sinc lowpass kernel.
//
// Kernel: sinc tapered by a Kaiser-Bessel window (Kaiser and Schafer 1980)
// with beta 8, which rejects the stopband by about 80 dB. At unity scale the
// kernel reaches 32 input samples to each side (64 taps). Its -6 dB point is
// at 0.915 of the lower of the two Nyquist frequencies, so the passband is
// flat to within 0.1 dB up to about 0.84 of it (20 kHz at 48 kHz) and the
// stopband starts just below Nyquist. Measured: a 20 kHz tone taken down to
// 16 kHz aliases at -106 dB, and the image of a 7 kHz tone (0.875 of Nyquist,
// inside the transition band) taken from 16 to 48 kHz sits at -75 dB.
//
// When the output rate is below the input rate (downsampling, or playing
// faster than normal speed) the kernel's cutoff is scaled down by that ratio
// and its reach scaled up by the same amount. This is Smith's "rho" scaling
// and it is what keeps aliasing out of a speed-up. Upsampling and slow
// playback use the kernel at unity scale.
//
// resample() and resampleTo() have one fixed ratio, so they precompute a
// polyphase table: the kernel at 512 fractional phases, each row normalised
// to exactly unit DC gain, with linear interpolation between the two nearest
// rows. One output sample then costs two multiply-adds per tap over
// contiguous memory. Tables are cached per scale.
//
// varispeed() changes speed on every sample, so it evaluates the kernel from
// a single finely sampled table (512 points per input sample, linearly
// interpolated) at whatever scale the current speed needs, exactly as in
// Smith's algorithm. Speed may be any value from -16 to 16; negative speeds
// play backwards (scratching). Below 4 percent speed the level fades in
// proportion to the speed, the way a real tape head or record stylus loses
// output as it slows, so a stopped read head is silent rather than holding a
// DC level and the final stop of a tape-stop never clicks.
//
// Timing convention: output sample j of resample(sig, ratio) is read at input
// position j / ratio, so the first samples line up. Input outside the signal
// is silence. Non-finite input samples are treated as silence.

import { besselI0 } from './window.js'

const ZC = 32 // kernel half-length in input samples at unity scale
const BETA = 8.0
const FC = 0.915 // -6 dB point as a fraction of the lower Nyquist frequency
const PHASES = 512 // polyphase rows for fixed-ratio resampling
const TAB_RES = 512 // single-table points per input sample (varispeed)
const MAX_SPEED = 16
const MAP_STEP = 16 // varispeed map: one read position every 16 output samples

const I0_BETA = besselI0(BETA)

/** The unity-scale kernel at distance u (input samples) from the read position. */
function kernelAt(u) {
  const a = u < 0 ? -u : u
  if (a >= ZC) return 0
  const x = FC * u
  const s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
  const r = a / ZC
  return FC * s * (besselI0(BETA * Math.sqrt(1 - r * r)) / I0_BETA)
}

// ---------------------------------------------------------------- polyphase

const POLY = new Map()

function polyTable(rho) {
  const key = rho === 1 ? 'unity' : rho.toPrecision(12)
  let t = POLY.get(key)
  if (t) return t
  const half = Math.ceil(ZC / rho)
  const taps = 2 * half
  const tab = new Float32Array((PHASES + 1) * taps)
  const row = new Float64Array(taps)
  for (let p = 0; p <= PHASES; p++) {
    const phi = p / PHASES
    let sum = 0
    for (let j = 0; j < taps; j++) {
      // distance from the read position to input sample (n - half + 1 + j)
      const u = phi + half - 1 - j
      const v = rho * kernelAt(u * rho)
      row[j] = v
      sum += v
    }
    const g = sum > 0 ? 1 / sum : 1
    const o = p * taps
    for (let j = 0; j < taps; j++) tab[o + j] = row[j] * g
  }
  t = { tab, taps, half }
  if (POLY.size > 24) POLY.clear()
  POLY.set(key, t)
  return t
}

function paddedCopy(sig, pad) {
  const len = sig.length
  const xp = new Float32Array(len + 2 * pad)
  for (let i = 0; i < len; i++) {
    const v = sig[i]
    xp[pad + i] = v === v && v !== Infinity && v !== -Infinity ? v : 0
  }
  return xp
}

/** Fixed-ratio core: outLen samples, output j read at input position j * step. */
function polyResample(sig, outLen, step, rho) {
  const { tab, taps, half } = polyTable(rho)
  const pad = half + 2
  const xp = paddedCopy(sig, pad)
  const out = new Float32Array(outLen)
  const off = pad + 1 - half
  for (let j = 0; j < outLen; j++) {
    const t = j * step
    const n = Math.floor(t)
    const pf = (t - n) * PHASES
    const p = pf | 0
    const a = pf - p
    const r0 = p * taps
    const r1 = r0 + taps
    const base = n + off
    let acc0 = 0
    let acc1 = 0
    for (let k = 0; k < taps; k++) {
      const v = xp[base + k]
      acc0 += v * tab[r0 + k]
      acc1 += v * tab[r1 + k]
    }
    out[j] = acc0 + a * (acc1 - acc0)
  }
  return out
}

function checkRatio(r, what) {
  if (!(r > 0) || r === Infinity) throw new RangeError(what + ' must be a positive number, got ' + r)
}

/**
 * Change the sample rate by `ratio` (output rate / input rate). The output
 * has round(len * ratio) samples. Downsampling is anti-aliased.
 * @param {Float32Array|Float64Array} sig
 * @param {number} ratio
 * @returns {Float32Array}
 */
export function resample(sig, ratio) {
  const r = Number(ratio)
  checkRatio(r, 'Resample ratio')
  const len = sig.length
  const outLen = Math.round(len * r)
  if (outLen <= 0 || len === 0) return new Float32Array(0)
  if (r === 1) return paddedCopy(sig, 0)
  return polyResample(sig, outLen, 1 / r, Math.min(1, r))
}

/**
 * Convert from fromSr to toSr. Output length round(len * toSr / fromSr).
 * Equal rates return a copy.
 */
export function resampleTo(sig, fromSr, toSr) {
  const a = Number(fromSr)
  const b = Number(toSr)
  checkRatio(a, 'Source sample rate')
  checkRatio(b, 'Target sample rate')
  const len = sig.length
  if (a === b) return paddedCopy(sig, 0)
  const outLen = Math.round((len * b) / a)
  if (outLen <= 0 || len === 0) return new Float32Array(0)
  return polyResample(sig, outLen, a / b, Math.min(1, b / a))
}

// ---------------------------------------------------------------- varispeed

let SINGLE = null

function singleTable() {
  if (SINGLE) return SINGLE
  const n = ZC * TAB_RES
  const h = new Float64Array(n + 2)
  for (let l = 0; l <= n; l++) h[l] = kernelAt(l / TAB_RES)
  const d = new Float64Array(n + 1)
  for (let l = 0; l <= n; l++) d[l] = h[l + 1] - h[l]
  SINGLE = { h, d, n }
  return SINGLE
}

function makeSpeedAt(rate, sr, clock) {
  if (typeof rate === 'number') {
    const v = rate === rate && rate !== Infinity && rate !== -Infinity ? rate : 1
    return { constant: v, fn: null, arr: null }
  }
  if (rate instanceof Float32Array || rate instanceof Float64Array || Array.isArray(rate)) {
    return { constant: null, fn: null, arr: rate.length ? rate : [1] }
  }
  if (typeof rate === 'function') return { constant: null, fn: rate, arr: null, inClock: clock === 'in' }
  return { constant: 1, fn: null, arr: null }
}

/**
 * Variable-speed playback with a moving, anti-aliased read head.
 *
 * @param {Float32Array} sig
 * @param {number|((tSeconds:number)=>number)|Float32Array} rate playback speed
 *   (1 normal, 2 twice as fast and an octave up, 0 stopped, negative backwards).
 *   A function is called once per output sample with the time in seconds;
 *   an array gives the speed for each output sample (the last value holds).
 * @param {number} sr sample rate, used only to turn samples into seconds.
 *   Always pass it (CONTRACT section 3). Missing, zero, negative or not a
 *   number, it falls back to 48000 without an error, so a rate function then
 *   reads 48 kHz seconds; an { sr, ...opts } object in its place also works.
 *   A missing or empty sig gives an empty Float32Array.
 * @param {{clock?:'out'|'in', start?:number|'end', length?:number,
 *   maxSeconds?:number, stopSeconds?:number, stopFade?:number}} opts
 *   clock 'out' (default): the function gets output (playback) time;
 *   'in': it gets the read position in input seconds.
 *   start: first read position in seconds, or 'end'.
 *   length: exact output length in samples. Without it the output ends when
 *   the read head runs off the end (or, going backwards, off the start), when
 *   it has stood still for stopSeconds (default 0.25) after moving, or at
 *   maxSeconds (default 8 times the input, at least 2 s).
 *   stopFade: speed below which the level fades toward silence (0.04; 0 = off).
 * @returns {Float32Array}
 */
export function varispeed(sig, rate, sr = 48000, opts = {}) {
  return varispeedCore(sig, rate, sr, opts, false).out
}

/**
 * varispeed() that also returns where the read head was: map[q] is the input
 * position (samples) at output sample q * mapStep, with one entry past the end.
 * @returns {{ out: Float32Array, map: Float64Array, mapStep: number }}
 */
export function varispeedWithMap(sig, rate, sr = 48000, opts = {}) {
  return varispeedCore(sig, rate, sr, opts, true)
}

function varispeedCore(sig, rate, srIn, optsIn, wantMap) {
  let sr = srIn
  let opts = optsIn || {}
  if (sr && typeof sr === 'object') {
    opts = sr
    sr = opts.sr || 48000
  }
  sr = Number(sr) > 0 && Number(sr) < Infinity ? Number(sr) : 48000
  if (!sig || typeof sig.length !== 'number') sig = new Float32Array(0)
  const len = sig.length
  const sp = makeSpeedAt(rate, sr, opts.clock)
  const { h, d, n: tabN } = singleTable()
  const reach = Math.ceil(ZC * MAX_SPEED) + 2
  const pad = 2 * reach
  const xp = paddedCopy(sig, pad)
  const fixedLen = opts.length !== undefined && opts.length !== null ? Math.max(0, Math.floor(Number(opts.length) || 0)) : -1
  const maxOut = fixedLen >= 0 ? fixedLen : Math.ceil(Math.max(2 * sr, 8 * len, (Number(opts.maxSeconds) || 0) * sr))
  const stopLimit = Math.max(1, Math.round((opts.stopSeconds !== undefined ? Number(opts.stopSeconds) || 0 : 0.25) * sr))
  const stopFade = opts.stopFade !== undefined ? Math.max(0, Number(opts.stopFade) || 0) : 0.04
  let pos = 0
  if (opts.start === 'end') pos = len
  else if (opts.start !== undefined) pos = (Number(opts.start) || 0) * sr

  // A constant zero speed with no length asked for plays nothing at all.
  if (fixedLen < 0 && sp.constant !== null && !(Math.abs(sp.constant) >= 1e-9)) {
    return { out: new Float32Array(0), map: wantMap ? Float64Array.of(pos) : null, mapStep: MAP_STEP }
  }
  let cap = fixedLen >= 0 ? fixedLen : sp.constant !== null ? Math.min(maxOut, Math.ceil(len / Math.abs(sp.constant)) + 4) : Math.min(maxOut, len + 1024)
  let out = new Float32Array(Math.max(1, cap))
  let map = wantMap ? new Float64Array(Math.max(2, Math.ceil(cap / MAP_STEP) + 2)) : null
  let j = 0
  let moved = 0
  let still = 0
  let lastS = 1
  const lenF = len
  const reachF = ZC * MAX_SPEED + 1

  while (j < maxOut) {
    let s
    if (sp.constant !== null) s = sp.constant
    else if (sp.arr) s = sp.arr[j < sp.arr.length ? j : sp.arr.length - 1]
    else s = sp.fn(sp.inClock ? pos / sr : j / sr)
    s = +s
    if (!(s === s) || s === Infinity || s === -Infinity) s = 1
    if (s > MAX_SPEED) s = MAX_SPEED
    else if (s < -MAX_SPEED) s = -MAX_SPEED
    const as = s < 0 ? -s : s
    if (fixedLen < 0) {
      if (s > 0 && pos > lenF - 1 + 1e-9) break
      if (s < 0 && pos < -1e-9) break
      if (as < 1e-9) {
        if (moved > 1 && ++still > stopLimit) break
      } else {
        still = 0
      }
    }
    if (j >= out.length) {
      const bigger = new Float32Array(Math.min(maxOut, out.length * 2 + 1024))
      bigger.set(out)
      out = bigger
    }
    if (map && j % MAP_STEP === 0) {
      const q = j / MAP_STEP
      if (q >= map.length) {
        const m2 = new Float64Array(map.length * 2 + 8)
        m2.set(map)
        map = m2
      }
      map[q] = pos
    }
    let v = 0
    if (pos > -reachF && pos < lenF + reachF) {
      const rho = as > 1 ? 1 / as : 1
      const step = rho * TAB_RES
      const n0 = Math.floor(pos)
      const phi = pos - n0
      let acc = 0
      // left wing: input samples n0, n0-1, ... at distance phi, phi+1, ...
      let tp = phi * step
      let i = n0 + pad
      while (tp < tabN) {
        const l = tp | 0
        acc += xp[i] * (h[l] + (tp - l) * d[l])
        tp += step
        i--
      }
      // right wing: input samples n0+1, n0+2, ... at distance 1-phi, 2-phi, ...
      tp = (1 - phi) * step
      i = n0 + 1 + pad
      while (tp < tabN) {
        const l = tp | 0
        acc += xp[i] * (h[l] + (tp - l) * d[l])
        tp += step
        i++
      }
      v = acc * rho
      if (stopFade > 0 && as < stopFade) v *= as / stopFade
    }
    out[j++] = v
    pos += s
    moved += as
    lastS = s
  }
  if (map) {
    // One entry at or past the end, extrapolated at the last speed, so the
    // map always brackets the last output sample.
    const q = Math.ceil(j / MAP_STEP)
    if (q >= map.length) {
      const m2 = new Float64Array(q + 2)
      m2.set(map)
      map = m2
    }
    map[q] = pos + (q * MAP_STEP - j) * lastS
    map = map.slice(0, q + 1)
  }
  const res = j === out.length ? out : out.slice(0, j)
  return { out: res, map, mapStep: MAP_STEP }
}

export { MAP_STEP }
