// beds/car-highway.js - Inside a car at highway speed.
//
// This file also carries the shared toolkit of the "moving and spooky" beds
// (vehicles, haunted places, clocks, static, phone lines, the music box).
// Those beds import it from here and never from another family's file.
//
// Toolkit techniques and their published sources:
// - Engines: a crank-phase accumulator fires one pressure pulse per
//   combustion event (cylinders x revolutions / 2 for four-stroke, one per
//   revolution per cylinder for two-stroke), with cycle-to-cycle amplitude
//   and timing variation, through a resonant low pass (the pulse shape) and
//   pipe and body resonances. This is the source-filter engine model of
//   Andy Farnell, "Designing Sound" (MIT Press 2010, the engine and motor
//   chapters) and of Baldan, Lachambre, Delle Monache and Boussard,
//   "Physically informed car engine sound synthesis" (2015). Diesel clatter
//   is a short noise burst at each firing through a band pass.
// - Modal impacts: every knock, clack and ring is a sum of exponentially
//   decaying sinusoids (modal synthesis; van den Doel and Pai, "The sounds of
//   physical shapes", Presence 1998), each made with the two-multiply
//   recursive resonator y[n] = 2 r cos(w) y[n-1] - r^2 y[n-2].
// - Filters are core/biquad.js (RBJ cookbook); swept filters update their
//   coefficients every 32 samples.
// - Reverb is an eight-line feedback delay network (Stautner and Puckette
//   1982; Jot and Chaigne 1991) with a Hadamard mixing matrix, one-pole
//   damping in every loop and Schroeder allpass input diffusion.
// - Smooth random control ("wander") is smoothstep interpolation between
//   random points, so speeds, gusts and loads drift without corners.
// - Levels: every bed is measured with core/loudness.js (BS.1770 LUFS) and
//   set to a common loudness, peaks capped and brick-wall limited.
//
// The car itself: road noise is low rumble plus tyre roar with the tyre
// cavity resonance near 220 Hz (a known cabin tone), wind noise grows with
// about the fifth power of speed, concrete seams give the front-then-rear
// axle thump pair (wheelbase / speed apart), an open window adds the
// low "wub" of side-window buffeting (a Helmholtz resonance of the cabin),
// trucks pass with a pressure whoosh and a little doppler on their engine,
// and lane changes bring the indicator relay's tick and tock.

import { resolveParams } from '../core/params.js'
import { makeRng } from '../core/rng.js'
import { rbjCoefs, Biquad, OnePole } from '../core/biquad.js'
import { pink, brown } from '../core/noise.js'
import { lufs } from '../core/loudness.js'
import { limitBuf } from '../core/dyn.js'

export const TAU = Math.PI * 2

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

export function dB(db) {
  return Math.pow(10, db / 20)
}

// ------------------------------------------------------------------ setup

/** Common start of generate(): safe rate and length, resolved params, rng. */
export function setup(bed, seconds, sr, p, rng) {
  let rate = Number(sr)
  if (!(rate >= 1000 && rate <= 384000)) rate = 48000
  let secs = Number(seconds)
  if (!(secs > 0) || !Number.isFinite(secs)) secs = 0
  if (secs > 3600) secs = 3600
  const n = Math.max(0, Math.round(secs * rate))
  const q = resolveParams(bed, p || {})
  const r = rng && typeof rng.fork === 'function' ? rng : makeRng(bed.id)
  return { n, sr: rate, q, rng: r, dur: n / rate }
}

export function stereo(sr, L, R) {
  return { sr, ch: [L, R] }
}

function cleanArr(s) {
  for (let i = 0; i < s.length; i++) {
    const v = s[i]
    if (!(v > -1e9 && v < 1e9)) s[i] = 0
    else if (v < 1e-30 && v > -1e-30) s[i] = 0
  }
}

/** What the last finish() measured (for tuning and tests): internal loudness and the gain used. */
export const finishInfo = { loud: -200, gainDb: 0 }

/**
 * Final stage of every bed: loudness to targetLufs, peaks capped so a sparse
 * bed (clock ticks) is never crushed, a brick-wall limiter under -1.2 dBFS,
 * and a last clean of anything non-finite. minLufs is the quietest internal
 * loudness the normaliser will believe: when settings empty a scene out (no
 * events, no wind) the little that is left stays quiet instead of being
 * pushed up to the target. Returns the stereo buffer.
 */
export function finish(L, R, sr, targetLufs = -23, minLufs = -200) {
  cleanArr(L)
  cleanArr(R)
  const b = { sr, ch: [L, R] }
  if (!L.length) return b
  let pk = 0
  for (let c = 0; c < 2; c++) {
    const s = c ? R : L
    for (let i = 0; i < s.length; i++) {
      const a = s[i] < 0 ? -s[i] : s[i]
      if (a > pk) pk = a
    }
  }
  if (!(pk > 1e-9)) {
    L.fill(0)
    R.fill(0)
    return b
  }
  const measured = lufs(b)
  finishInfo.loud = measured
  const loud = Math.max(measured, minLufs)
  let g = loud > -150 ? dB(targetLufs - loud) : 0.25 / pk
  if (pk * g > 1.6) g = 1.6 / pk
  if (!Number.isFinite(g)) g = 0
  finishInfo.gainDb = g > 0 ? 20 * Math.log10(g) : -200
  for (let c = 0; c < 2; c++) {
    const s = c ? R : L
    for (let i = 0; i < s.length; i++) s[i] *= g
  }
  if (pk * g > 0.88) limitBuf(b, { ceilingDb: -1.2, lookaheadMs: 1.5, releaseMs: 60, truePeak: false })
  for (let c = 0; c < 2; c++) {
    const s = c ? R : L
    for (let i = 0; i < s.length; i++) {
      let v = s[i]
      if (!(v > -1e9 && v < 1e9)) v = 0
      else if (v > 0.95) v = 0.95
      else if (v < -0.95) v = -0.95
      else if (v < 1e-30 && v > -1e-30) v = 0
      s[i] = v
    }
  }
  return b
}

// ------------------------------------------------------------------ signals

/** Smooth random wander in about -1..1: `rate` random points per second, smoothstep between them. */
export function wander(n, sr, rate, rng) {
  const out = new Float32Array(n)
  const step = Math.max(1, sr / Math.max(1e-3, rate))
  let a = rng.next() * 2 - 1
  let b = rng.next() * 2 - 1
  let pos = rng.next() * step
  const inv = 1 / step
  for (let i = 0; i < n; i++) {
    const t = pos * inv
    out[i] = a + (b - a) * t * t * (3 - 2 * t)
    pos += 1
    if (pos >= step) {
      pos -= step
      a = b
      b = rng.next() * 2 - 1
    }
  }
  return out
}

/** White noise in -1..1 from an rng (cheap, no core allocation besides the array). */
export function whiteArr(n, rng) {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = rng.next() * 2 - 1
  return out
}

/** Noise of a colour: 'white' | 'pink' | 'brown'. */
export function noise(n, rng, kind = 'pink') {
  if (kind === 'brown') return brown(n, rng)
  if (kind === 'white') return whiteArr(n, rng)
  return pink(n, rng)
}

/** Two noises with correlation about corr (0 independent, 1 identical). */
export function noisePair(n, rng, kind = 'pink', corr = 0.3) {
  const c = clamp(corr, 0, 1)
  const a = noise(n, rng.fork('a'), kind)
  const b = noise(n, rng.fork('b'), kind)
  if (c > 0) {
    const m = noise(n, rng.fork('m'), kind)
    const gc = Math.sqrt(c)
    const gi = Math.sqrt(1 - c)
    for (let i = 0; i < n; i++) {
      a[i] = gc * m[i] + gi * a[i]
      b[i] = gc * m[i] + gi * b[i]
    }
  }
  return [a, b]
}

/**
 * Faint room tone added into L and R (independent sides, softly low passed
 * white noise at the given RMS), so quiet beds never fall to digital silence.
 */
export function addAir(L, R, sr, rng, level = 0.001, lpHz = 3000) {
  const n = L.length
  const a = 1 - Math.exp((-TAU * Math.min(lpHz, sr * 0.45)) / sr)
  const g = level * Math.sqrt(3) * Math.sqrt(2 / a)
  let sl = 0
  let sr2 = 0
  for (let i = 0; i < n; i++) {
    sl += a * (rng.next() * 2 - 1 - sl)
    sr2 += a * (rng.next() * 2 - 1 - sr2)
    L[i] += sl * g
    R[i] += sr2 * g
  }
}

/** Scale sig in place to the given RMS (silence stays silence). */
export function norm(sig, target = 1) {
  let e = 0
  for (let i = 0; i < sig.length; i++) e += sig[i] * sig[i]
  const r = sig.length ? Math.sqrt(e / sig.length) : 0
  if (r > 1e-12) {
    const g = target / r
    for (let i = 0; i < sig.length; i++) sig[i] *= g
  }
  return sig
}

/** Scale sig in place so its peak is `target` (events use this, so amp means peak). */
export function normPeak(sig, target = 1) {
  let m = 0
  for (let i = 0; i < sig.length; i++) {
    const a = sig[i] < 0 ? -sig[i] : sig[i]
    if (a > m) m = a
  }
  if (m > 1e-12) {
    const g = target / m
    for (let i = 0; i < sig.length; i++) sig[i] *= g
  }
  return sig
}

/** dst += src * gain (equal lengths up to the shorter). */
export function addTo(dst, src, gain = 1, offset = 0) {
  const n = Math.min(dst.length - offset, src.length)
  for (let i = 0; i < n; i++) dst[i + offset] += src[i] * gain
  return dst
}

/** Multiply sig by env (array) in place, optionally env mapped as base + depth * env. */
export function mulEnv(sig, env, base = 0, depth = 1) {
  const n = Math.min(sig.length, env.length)
  for (let i = 0; i < n; i++) sig[i] *= base + depth * env[i]
  return sig
}

// ------------------------------------------------------------------ filters

export function bq(sig, sr, type, f, q = 0.707, g = 0) {
  new Biquad(type, sr, f, q, g).run(sig)
  return sig
}

export function lp1(sig, sr, f) {
  new OnePole(sr, f, 'lp').run(sig)
  return sig
}

export function hp1(sig, sr, f) {
  new OnePole(sr, f, 'hp').run(sig)
  return sig
}

/**
 * Biquad whose frequency follows freqs (Float32Array, one value per sample;
 * read every `block` samples) or a function of the sample index. In place.
 */
export function sweep(sig, sr, type, freqs, q = 0.707, gainDb = 0, block = 32) {
  const n = sig.length
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  let b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0
  const isFn = typeof freqs === 'function'
  for (let s = 0; s < n; s += block) {
    const f = isFn ? freqs(s) : freqs[s]
    const c = rbjCoefs(type, sr, f > 5 ? f : 5, q, gainDb)
    b0 = c.b0; b1 = c.b1; b2 = c.b2; a1 = c.a1; a2 = c.a2
    const e = s + block < n ? s + block : n
    for (let i = s; i < e; i++) {
      const x = sig[i]
      let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      if (y < 1e-25 && y > -1e-25) y = 0
      x2 = x1; x1 = x; y2 = y1; y1 = y
      sig[i] = y
    }
    if (!(y1 > -1e12 && y1 < 1e12)) { x1 = x2 = y1 = y2 = 0 }
  }
  return sig
}

/** Parallel bank of band passes: modes [[hz, q, gain]...]; returns a new signal. */
export function resBank(src, sr, modes) {
  const out = new Float32Array(src.length)
  const tmp = new Float32Array(src.length)
  for (const m of modes) {
    if (!(m[0] < sr * 0.45)) continue
    tmp.set(src)
    new Biquad('bandpass', sr, m[0], m[1]).run(tmp)
    const g = m[2] === undefined ? 1 : m[2]
    for (let i = 0; i < tmp.length; i++) out[i] += tmp[i] * g
  }
  return out
}

// ------------------------------------------------------------------ panning and events

/** Equal-power pan gains for pan in -1..1. */
export function panL(p) {
  return Math.cos(((clamp(p, -1, 1) + 1) * Math.PI) / 4)
}
export function panR(p) {
  return Math.sin(((clamp(p, -1, 1) + 1) * Math.PI) / 4)
}

/** Add a mono signal into L and R at sample i0 with a fixed pan. */
export function addPanned(L, R, src, i0, gain = 1, pan = 0) {
  const gl = gain * panL(pan)
  const gr = gain * panR(pan)
  const n = L.length
  const s0 = i0 < 0 ? -i0 : 0
  for (let k = s0; k < src.length; k++) {
    const i = i0 + k
    if (i >= n) break
    L[i] += src[k] * gl
    R[i] += src[k] * gr
  }
}

/**
 * One decaying sinusoid (a mode) added into sig from sample i0:
 * amp * exp(-t / tau) * sin(2 pi f t + phase). Stops at -80 dB.
 */
export function addMode(sig, i0, f, tau, amp, sr, phase = 0) {
  if (!(f > 0 && f < sr * 0.47) || !(tau > 0) || !(amp !== 0)) return
  const n = sig.length
  if (i0 >= n) return
  const w = (TAU * f) / sr
  const r = Math.exp(-1 / (tau * sr))
  const c = 2 * r * Math.cos(w)
  const r2 = r * r
  let len = Math.ceil(tau * sr * 9.21)
  let y2 = amp * Math.sin(phase - w) / r // value "before" the start
  let y1 = amp * Math.sin(phase)
  let i = i0
  if (i < 0) {
    // advance the oscillator to the buffer start
    const skip = -i
    if (skip >= len) return
    for (let k = 0; k < skip; k++) {
      const y = c * y1 - r2 * y2
      y2 = y1
      y1 = y
    }
    len -= skip
    i = 0
  }
  const end = Math.min(n, i + len)
  for (; i < end; i++) {
    sig[i] += y1
    const y = c * y1 - r2 * y2
    y2 = y1
    y1 = y
  }
}

/** Modes [[hz, tau, gain]...] into L and R with one pan; amp scales all. */
export function addModes(L, R, i0, sr, modes, amp, pan = 0, phaseRng = null) {
  const gl = amp * panL(pan)
  const gr = amp * panR(pan)
  for (const m of modes) {
    const ph = phaseRng ? phaseRng.next() * TAU : 0
    addModeLR(L, R, i0, m[0], m[1], m[2] * gl, m[2] * gr, sr, ph)
  }
}

/** One mode into both channels with its own gain per side (one oscillator, -70 dB stop). */
export function addModeLR(L, R, i0, f, tau, gl, gr, sr, phase = 0) {
  if (!(f > 0 && f < sr * 0.47) || !(tau > 0) || (gl === 0 && gr === 0)) return
  const n = L.length
  if (i0 >= n) return
  const w = (TAU * f) / sr
  const r = Math.exp(-1 / (tau * sr))
  const c = 2 * r * Math.cos(w)
  const r2 = r * r
  let len = Math.ceil(tau * sr * 8.06)
  let y2 = Math.sin(phase - w) / r
  let y1 = Math.sin(phase)
  let i = i0
  if (i < 0) {
    const skip = -i
    if (skip >= len) return
    for (let k = 0; k < skip; k++) {
      const y = c * y1 - r2 * y2
      y2 = y1
      y1 = y
    }
    len -= skip
    i = 0
  }
  const end = Math.min(n, i + len)
  for (; i < end; i++) {
    L[i] += y1 * gl
    R[i] += y1 * gr
    const y = c * y1 - r2 * y2
    y2 = y1
    y1 = y
  }
}

/**
 * A filtered noise burst: noise * attack ramp * exp(-t / tau), through one
 * RBJ filter, panned into L and R. opts: { amp, pan, tau, f, q, type, attack (s), hold (s) }.
 */
export function addBurst(L, R, i0, sr, rng, o) {
  const amp = o.amp ?? 0.5
  if (!(amp > 0)) return
  const tau = Math.max(0.0002, o.tau ?? 0.01)
  const att = Math.max(0, Math.round((o.attack ?? 0) * sr))
  const hold = Math.max(0, Math.round((o.hold ?? 0) * sr))
  const len = att + hold + Math.ceil(tau * sr * 7)
  const n = L.length
  if (i0 >= n || i0 + len <= 0) return
  const c = rbjCoefs(o.type || 'bandpass', sr, Math.min(o.f ?? 1000, sr * 0.45), o.q ?? 0.7, o.gain ?? 0)
  const d = Math.exp(-1 / (tau * sr))
  const gl = amp * panL(o.pan ?? 0)
  const gr = amp * panR(o.pan ?? 0)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  let e = 1
  for (let k = 0; k < len; k++) {
    let env
    if (k < att) env = k / att
    else if (k < att + hold) env = 1
    else {
      env = e
      e *= d
    }
    const x = (rng.next() * 2 - 1) * env
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    x2 = x1; x1 = x; y2 = y1; y1 = y
    const i = i0 + k
    if (i >= n) break
    if (i >= 0) {
      L[i] += y * gl
      R[i] += y * gr
    }
  }
}

/** Poisson event times (seconds) at `rate` per second over dur, at least minGap apart. */
export function eventTimes(rate, dur, rng, minGap = 0, start = 0) {
  const out = []
  if (!(rate > 0) || !(dur > 0)) return out
  let t = start + -Math.log(1 - rng.next()) / rate
  while (t < dur) {
    out.push(t)
    t += Math.max(minGap, -Math.log(1 - rng.next()) / rate)
  }
  return out
}

// ------------------------------------------------------------------ oscillators

const TBL = 2048

/** Wavetable from harmonic amplitudes [a1, a2, ...] (and optional phases), peak 1. */
export function harmonicTable(amps, phases = null) {
  const t = new Float32Array(TBL + 1)
  for (let h = 0; h < amps.length; h++) {
    const a = amps[h]
    if (!a) continue
    const ph = phases ? phases[h] || 0 : 0
    for (let i = 0; i < TBL; i++) t[i] += a * Math.sin((TAU * (h + 1) * i) / TBL + ph)
  }
  let m = 0
  for (let i = 0; i < TBL; i++) m = Math.max(m, Math.abs(t[i]))
  if (m > 0) for (let i = 0; i < TBL; i++) t[i] /= m
  t[TBL] = t[0]
  return t
}

export const SINE = harmonicTable([1])

/**
 * Oscillator added into out: freq (number or per-sample array, Hz), amp
 * (number or per-sample array), from a wavetable. Frequencies whose top
 * harmonic would pass 0.45 sr fade out instead of aliasing (maxHarm says how
 * many harmonics the table holds). Returns the end phase (0..1).
 */
export function oscInto(out, sr, freq, amp, table = SINE, phase = 0, maxHarm = 1, i0 = 0, len = -1) {
  const n = len < 0 ? out.length - i0 : Math.min(len, out.length - i0)
  const fArr = typeof freq !== 'number'
  const aArr = typeof amp !== 'number'
  const lim = (sr * 0.45) / Math.max(1, maxHarm)
  const ph = phase - Math.floor(phase)
  // Separate loops per argument shape keep each one monomorphic (one shape
  // per function is several times faster in every JavaScript engine).
  if (n <= 0) return ph
  if (!fArr && !aArr) return oscFixed(out, sr, freq, amp, table, ph, lim, i0, n)
  if (fArr && !aArr) return oscFreq(out, sr, freq, amp, table, ph, lim, i0, n)
  if (fArr && aArr) return oscFreqAmp(out, sr, freq, amp, table, ph, lim, i0, n)
  return oscAmp(out, sr, freq, amp, table, ph, lim, i0, n)
}

function oscAmp(out, sr, freq, amp, table, ph, lim, i0, n) {
  let g = 1
  if (freq > lim) g = freq > lim * 1.25 ? 0 : 1 - (freq - lim) / (lim * 0.25)
  const inc = freq / sr
  for (let k = 0; k < n; k++) {
    const x = ph * TBL
    const j = x | 0
    out[i0 + k] += g * amp[k] * (table[j] + (table[j + 1] - table[j]) * (x - j))
    ph += inc
    if (ph >= 1) ph -= ph < 2 ? 1 : Math.floor(ph)
    else if (ph < 0) ph -= Math.floor(ph)
  }
  return ph
}

function oscFixed(out, sr, freq, amp, table, ph, lim, i0, n) {
  let a = amp
  if (freq > lim) a *= freq > lim * 1.25 ? 0 : 1 - (freq - lim) / (lim * 0.25)
  const inc = freq / sr
  for (let k = 0; k < n; k++) {
    const x = ph * TBL
    const j = x | 0
    out[i0 + k] += a * (table[j] + (table[j + 1] - table[j]) * (x - j))
    ph += inc
    if (ph >= 1) ph -= ph < 2 ? 1 : Math.floor(ph)
    else if (ph < 0) ph -= Math.floor(ph)
  }
  return ph
}

function oscFreq(out, sr, freq, amp, table, ph, lim, i0, n) {
  const inv = 1 / sr
  for (let k = 0; k < n; k++) {
    const f = freq[k]
    let a = amp
    if (f > lim) a *= f > lim * 1.25 ? 0 : 1 - (f - lim) / (lim * 0.25)
    const x = ph * TBL
    const j = x | 0
    out[i0 + k] += a * (table[j] + (table[j + 1] - table[j]) * (x - j))
    ph += f * inv
    if (ph >= 1) ph -= ph < 2 ? 1 : Math.floor(ph)
    else if (ph < 0) ph -= Math.floor(ph)
  }
  return ph
}

function oscFreqAmp(out, sr, freq, amp, table, ph, lim, i0, n) {
  const inv = 1 / sr
  for (let k = 0; k < n; k++) {
    const f = freq[k]
    let a = amp[k]
    if (f > lim) a *= f > lim * 1.25 ? 0 : 1 - (f - lim) / (lim * 0.25)
    const x = ph * TBL
    const j = x | 0
    out[i0 + k] += a * (table[j] + (table[j + 1] - table[j]) * (x - j))
    ph += f * inv
    if (ph >= 1) ph -= ph < 2 ? 1 : Math.floor(ph)
    else if (ph < 0) ph -= Math.floor(ph)
  }
  return ph
}

/**
 * A tone event panned into L/R: attack seconds, hold seconds, then an
 * exponential release with time constant tau. freq may be a function of
 * seconds since the start (for chirps); table/maxHarm as oscInto.
 */
export function addTone(L, R, i0, sr, o) {
  const f0 = o.f ?? 1000
  const att = Math.max(1, Math.round((o.attack ?? 0.005) * sr))
  const hold = Math.max(0, Math.round((o.hold ?? 0.05) * sr))
  const tau = Math.max(0.001, o.tau ?? 0.03)
  const rel = Math.ceil(tau * sr * 6.9)
  const len = att + hold + rel
  const n = L.length
  if (i0 >= n || i0 + len <= 0) return
  const table = o.table || SINE
  const maxH = o.maxHarm || 1
  const lim = (sr * 0.45) / maxH
  const gl = (o.amp ?? 0.3) * panL(o.pan ?? 0)
  const gr = (o.amp ?? 0.3) * panR(o.pan ?? 0)
  const d = Math.exp(-1 / (tau * sr))
  const fFn = typeof f0 === 'function' ? f0 : null
  const vib = o.vibrato || 0
  const vibRate = o.vibratoRate || 5
  const m = Math.min(len, n - i0)
  if (fFn || vib) {
    const fa = new Float32Array(m)
    for (let k = 0; k < m; k++) {
      let f = fFn ? fFn(k / sr) : f0
      if (vib) f *= 1 + vib * Math.sin((TAU * vibRate * k) / sr)
      fa[k] = f > 0 ? f : 0
    }
    toneArr(L, R, i0, sr, m, att, hold, d, table, lim, gl, gr, fa, o.phase || 0)
  } else {
    toneFixed(L, R, i0, sr, m, att, hold, d, table, lim, gl, gr, f0, o.phase || 0)
  }
}

function toneFixed(L, R, i0, sr, m, att, hold, d, table, lim, gl, gr, f, ph) {
  let g = 1
  if (f > lim) g = f > lim * 1.25 ? 0 : 1 - (f - lim) / (lim * 0.25)
  if (g === 0) return
  const inc = f / sr
  let e = g
  const ah = att + hold
  for (let k = 0; k < m; k++) {
    let env
    if (k < att) env = g * (0.5 - 0.5 * Math.cos((Math.PI * k) / att))
    else if (k < ah) env = g
    else {
      env = e
      e *= d
    }
    const x = ph * TBL
    const j = x | 0
    const v = env * (table[j] + (table[j + 1] - table[j]) * (x - j))
    ph += inc
    if (ph >= 1) ph -= ph < 2 ? 1 : Math.floor(ph)
    const i = i0 + k
    if (i >= 0) {
      L[i] += v * gl
      R[i] += v * gr
    }
  }
}

function toneArr(L, R, i0, sr, m, att, hold, d, table, lim, gl, gr, fa, ph) {
  const inv = 1 / sr
  let e = 1
  const ah = att + hold
  for (let k = 0; k < m; k++) {
    let env
    if (k < att) env = 0.5 - 0.5 * Math.cos((Math.PI * k) / att)
    else if (k < ah) env = 1
    else {
      env = e
      e *= d
    }
    const f = fa[k]
    if (f > lim) env *= f > lim * 1.25 ? 0 : 1 - (f - lim) / (lim * 0.25)
    const x = ph * TBL
    const j = x | 0
    const v = env * (table[j] + (table[j + 1] - table[j]) * (x - j))
    ph += f * inv
    if (ph >= 1) ph -= ph < 2 ? 1 : Math.floor(ph)
    const i = i0 + k
    if (i >= 0) {
      L[i] += v * gl
      R[i] += v * gr
    }
  }
}

// ------------------------------------------------------------------ engine

/**
 * Engine source: a pulse per combustion event, shaped and normalised to RMS 1.
 * rpm: number or Float32Array (per sample). o: { cyl=4, strokes=4,
 * firesPerRev, rough=0.08 (cycle-to-cycle spread), uneven=0.05 (cylinder to
 * cylinder), pattern (per-cylinder gain list), misfire=0 (chance),
 * pulseHz=300, pulseQ=1.2, res: [[hz, q, gainDb]...] (pipe/body peaks),
 * knock=0 (diesel clatter level), knockHz=2500, knockMs=1.8 }.
 */
export function engine(n, sr, rpm, o = {}, rng) {
  const out = new Float32Array(n)
  if (!n) return out
  const r = rng || makeRng('engine')
  const cyl = Math.max(1, Math.round(o.cyl || 4))
  const fpr = o.firesPerRev || (o.strokes === 2 ? cyl : cyl / 2)
  const rough = o.rough ?? 0.08
  const gains = new Float64Array(cyl)
  for (let k = 0; k < cyl; k++) {
    gains[k] = clamp(1 + (o.uneven ?? 0.05) * r.gauss(), 0.3, 1.8)
    if (o.pattern) gains[k] *= o.pattern[k % o.pattern.length]
  }
  const misfire = o.misfire || 0
  const knockAmt = o.knock || 0
  const knk = knockAmt > 0 ? new Float32Array(n) : null
  const isArr = typeof rpm !== 'number'
  let ph = r.next()
  let k = 0
  let jit = 0
  for (let i = 0; i < n; i++) {
    const rp = isArr ? rpm[i] : rpm
    const inc = ((rp > 0 ? rp : 0) * fpr) / 60 / sr
    ph += inc * (1 + jit)
    if (ph >= 1) {
      ph -= 1
      if (ph >= 1) ph = 0
      const step = inc * (1 + jit)
      const frac = step > 0 ? clamp(ph / step, 0, 1) : 0
      let a = gains[k % cyl] * (1 + rough * r.gauss())
      if (misfire > 0 && r.next() < misfire) a *= 0.12
      if (a < 0) a = 0
      out[i] += a * (1 - frac)
      if (i > 0) out[i - 1] += a * frac
      if (knk) knk[i] += a
      jit = clamp(rough * 0.12 * r.gauss(), -0.3, 0.3)
      k++
    }
  }
  bq(out, sr, 'lowpass', o.pulseHz || 300, o.pulseQ || 1.2)
  if (o.pulse2Hz) bq(out, sr, 'lowpass', o.pulse2Hz, 0.707)
  if (o.res) for (const m of o.res) bq(out, sr, 'peak', m[0], m[1], m[2])
  hp1(out, sr, 16)
  norm(out, 1)
  if (knk) {
    const d = Math.exp(-1 / (((o.knockMs || 1.8) / 1000) * sr))
    let e = 0
    for (let i = 0; i < n; i++) {
      e = e * d + knk[i]
      if (e < 1e-20) e = 0
      knk[i] = e * (r.next() * 2 - 1)
    }
    bq(knk, sr, 'bandpass', o.knockHz || 2500, 1.1)
    bq(knk, sr, 'highpass', 700, 0.707)
    norm(knk, knockAmt)
    for (let i = 0; i < n; i++) out[i] += knk[i]
  }
  return out
}

// ------------------------------------------------------------------ reverb

/**
 * Eight-line feedback delay network. opts: { size=1 (scales the delay
 * lengths, 1 = a living room), rt60=1 (seconds), damp=0.4 (0 bright .. 1
 * dark), predelayMs=8, diffuse=0.6 (input allpass gain, 0 = none) }.
 * process(L, R, wet, dry) works in place.
 */
export class Fdn {
  constructor(sr, o = {}) {
    const base = [31.7, 37.3, 41.9, 45.1, 53.7, 59.3, 67.1, 73.9]
    const size = clamp(o.size ?? 1, 0.05, 6)
    const rt = Math.max(0.05, o.rt60 ?? 1)
    this.sr = sr
    this.lines = []
    this.len = new Int32Array(8)
    this.idx = new Int32Array(8)
    this.g = new Float64Array(8)
    this.z = new Float64Array(8)
    let g2 = 0
    for (let i = 0; i < 8; i++) {
      let l = Math.max(12, Math.round((base[i] * size * sr) / 1000)) | 1
      for (let j = 0; j < i; j++) if (this.len[j] === l) l += 2
      this.len[i] = l
      this.lines.push(new Float32Array(l))
      this.g[i] = Math.pow(10, (-3 * l) / (rt * sr))
      g2 += this.g[i] * this.g[i]
    }
    g2 /= 8
    const fc = 600 + 17000 * Math.pow(1 - clamp(o.damp ?? 0.4, 0, 0.97), 2)
    this.c = Math.exp((-TAU * Math.min(fc, sr * 0.45)) / sr)
    // Wet level so a long noise input comes out with about its own energy.
    this.out = (Math.sqrt(Math.max(0.002, 1 - g2)) * 2.0) / Math.sqrt(1 - this.c * 0.5)
    const pd = Math.max(0, Math.round(((o.predelayMs ?? 8) * sr) / 1000))
    this.pdLen = pd + 1
    this.pdL = new Float32Array(this.pdLen)
    this.pdR = new Float32Array(this.pdLen)
    this.pdI = 0
    const dg = clamp(o.diffuse ?? 0.6, 0, 0.85)
    this.dg = dg
    const dms = [4.77, 3.59, 12.73, 9.31]
    const ds = Math.min(1.5, Math.max(0.3, size))
    // the eight input allpasses (four per side) share one buffer
    this.apLen = new Int32Array(8)
    this.apOff = new Int32Array(8)
    this.apIdx = new Int32Array(8)
    let tot = 0
    for (let c = 0; c < 2; c++) {
      for (let k = 0; k < 4; k++) {
        const l = Math.max(3, Math.round((dms[k] * ds * (c ? 1.07 : 1) * sr) / 1000))
        this.apLen[c * 4 + k] = l
        this.apOff[c * 4 + k] = tot
        tot += l
      }
    }
    this.apBuf = new Float32Array(tot)
  }

  process(L, R, wet = 0.3, dry = 1) {
    const n = L.length
    const [d0, d1, d2, d3, d4, d5, d6, d7] = this.lines
    const len = this.len
    const n0 = len[0], n1 = len[1], n2 = len[2], n3 = len[3], n4 = len[4], n5 = len[5], n6 = len[6], n7 = len[7]
    const idx = this.idx
    let j0 = idx[0], j1 = idx[1], j2 = idx[2], j3 = idx[3], j4 = idx[4], j5 = idx[5], j6 = idx[6], j7 = idx[7]
    const g = this.g
    const g0 = g[0], g1 = g[1], g2 = g[2], g3 = g[3], g4 = g[4], g5 = g[5], g6 = g[6], g7 = g[7]
    const z = this.z
    let z0 = z[0], z1 = z[1], z2 = z[2], z3 = z[3], z4 = z[4], z5 = z[5], z6 = z[6], z7 = z[7]
    const c = this.c
    const c1 = 1 - c
    const wo = wet * this.out
    const s8 = 1 / Math.sqrt(8)
    const pdL = this.pdL
    const pdR = this.pdR
    const pdLen = this.pdLen
    let pdi = this.pdI
    const ap = this.apBuf
    const apLen = this.apLen
    const apOff = this.apOff
    const apIdx = this.apIdx
    // the eight allpass sections as views with their own read positions
    const A0 = ap.subarray(apOff[0], apOff[0] + apLen[0]), A1 = ap.subarray(apOff[1], apOff[1] + apLen[1])
    const A2 = ap.subarray(apOff[2], apOff[2] + apLen[2]), A3 = ap.subarray(apOff[3], apOff[3] + apLen[3])
    const B0 = ap.subarray(apOff[4], apOff[4] + apLen[4]), B1 = ap.subarray(apOff[5], apOff[5] + apLen[5])
    const B2 = ap.subarray(apOff[6], apOff[6] + apLen[6]), B3 = ap.subarray(apOff[7], apOff[7] + apLen[7])
    const m0 = apLen[0], m1 = apLen[1], m2 = apLen[2], m3 = apLen[3], m4 = apLen[4], m5 = apLen[5], m6 = apLen[6], m7 = apLen[7]
    let p0 = apIdx[0], p1 = apIdx[1], p2 = apIdx[2], p3 = apIdx[3], p4 = apIdx[4], p5 = apIdx[5], p6 = apIdx[6], p7 = apIdx[7]
    const dg = this.dg
    const T = 1e-20
    const ha = 1 - Math.exp((-TAU * 45) / this.sr)
    let hl = this.hl || 0
    let hr = this.hr || 0
    for (let i = 0; i < n; i++) {
      const xl0 = L[i]
      const xr0 = R[i]
      let xl = pdL[pdi]
      let xr = pdR[pdi]
      pdL[pdi] = xl0
      pdR[pdi] = xr0
      pdi++
      if (pdi >= pdLen) pdi = 0
      if (dg > 0) {
        let d, v
        d = A0[p0]; v = xl + dg * d; A0[p0] = v < T && v > -T ? 0 : v; xl = d - dg * v; if (++p0 >= m0) p0 = 0
        d = A1[p1]; v = xl + dg * d; A1[p1] = v < T && v > -T ? 0 : v; xl = d - dg * v; if (++p1 >= m1) p1 = 0
        d = A2[p2]; v = xl + dg * d; A2[p2] = v < T && v > -T ? 0 : v; xl = d - dg * v; if (++p2 >= m2) p2 = 0
        d = A3[p3]; v = xl + dg * d; A3[p3] = v < T && v > -T ? 0 : v; xl = d - dg * v; if (++p3 >= m3) p3 = 0
        d = B0[p4]; v = xr + dg * d; B0[p4] = v < T && v > -T ? 0 : v; xr = d - dg * v; if (++p4 >= m4) p4 = 0
        d = B1[p5]; v = xr + dg * d; B1[p5] = v < T && v > -T ? 0 : v; xr = d - dg * v; if (++p5 >= m5) p5 = 0
        d = B2[p6]; v = xr + dg * d; B2[p6] = v < T && v > -T ? 0 : v; xr = d - dg * v; if (++p6 >= m6) p6 = 0
        d = B3[p7]; v = xr + dg * d; B3[p7] = v < T && v > -T ? 0 : v; xr = d - dg * v; if (++p7 >= m7) p7 = 0
      }
      z0 = c1 * d0[j0] + c * z0
      z1 = c1 * d1[j1] + c * z1
      z2 = c1 * d2[j2] + c * z2
      z3 = c1 * d3[j3] + c * z3
      z4 = c1 * d4[j4] + c * z4
      z5 = c1 * d5[j5] + c * z5
      z6 = c1 * d6[j6] + c * z6
      z7 = c1 * d7[j7] + c * z7
      if (z0 < T && z0 > -T) z0 = 0
      if (z1 < T && z1 > -T) z1 = 0
      if (z2 < T && z2 > -T) z2 = 0
      if (z3 < T && z3 > -T) z3 = 0
      if (z4 < T && z4 > -T) z4 = 0
      if (z5 < T && z5 > -T) z5 = 0
      if (z6 < T && z6 > -T) z6 = 0
      if (z7 < T && z7 > -T) z7 = 0
      const o0 = z0 * g0, o1 = z1 * g1, o2 = z2 * g2, o3 = z3 * g3
      const o4 = z4 * g4, o5 = z5 * g5, o6 = z6 * g6, o7 = z7 * g7
      const outL = o0 - o2 + o4 - o6
      const outR = o1 - o3 + o5 - o7
      const a0 = o0 + o1, a1 = o0 - o1, a2 = o2 + o3, a3 = o2 - o3
      const a4 = o4 + o5, a5 = o4 - o5, a6 = o6 + o7, a7 = o6 - o7
      const b0 = a0 + a2, b1 = a1 + a3, b2 = a0 - a2, b3 = a1 - a3
      const b4 = a4 + a6, b5 = a5 + a7, b6 = a4 - a6, b7 = a5 - a7
      const inL = xl * 0.5
      const inR = xr * 0.5
      d0[j0] = (b0 + b4) * s8 + inL
      d1[j1] = (b1 + b5) * s8 + inR
      d2[j2] = (b2 + b6) * s8 - inL
      d3[j3] = (b3 + b7) * s8 - inR
      d4[j4] = (b0 - b4) * s8 + inL
      d5[j5] = (b1 - b5) * s8 + inR
      d6[j6] = (b2 - b6) * s8 - inL
      d7[j7] = (b3 - b7) * s8 - inR
      if (++j0 >= n0) j0 = 0
      if (++j1 >= n1) j1 = 0
      if (++j2 >= n2) j2 = 0
      if (++j3 >= n3) j3 = 0
      if (++j4 >= n4) j4 = 0
      if (++j5 >= n5) j5 = 0
      if (++j6 >= n6) j6 = 0
      if (++j7 >= n7) j7 = 0
      // the wet path loses its lowest rumble (a one-pole high pass near 45 Hz)
      hl += ha * (outL - hl)
      hr += ha * (outR - hr)
      if (hl < T && hl > -T) hl = 0
      if (hr < T && hr > -T) hr = 0
      L[i] = dry * xl0 + wo * (outL - hl)
      R[i] = dry * xr0 + wo * (outR - hr)
    }
    this.hl = Number.isFinite(hl) ? hl : 0
    this.hr = Number.isFinite(hr) ? hr : 0
    apIdx[0] = p0; apIdx[1] = p1; apIdx[2] = p2; apIdx[3] = p3; apIdx[4] = p4; apIdx[5] = p5; apIdx[6] = p6; apIdx[7] = p7
    this.pdI = pdi
    idx[0] = j0; idx[1] = j1; idx[2] = j2; idx[3] = j3; idx[4] = j4; idx[5] = j5; idx[6] = j6; idx[7] = j7
    const zs = [z0, z1, z2, z3, z4, z5, z6, z7]
    for (let k = 0; k < 8; k++) z[k] = Number.isFinite(zs[k]) ? zs[k] : 0
    return this
  }
}

// ------------------------------------------------------------------ the car bed

const CARS = {
  family: { rpmPerMs: 80, eng: { cyl: 4, pulseHz: 210, pulseQ: 1.4, rough: 0.05, res: [[110, 2, 3]] }, engDb: -9, ins: 1, rattle: 0 },
  truck: {
    rpmPerMs: 64,
    eng: { cyl: 8, pulseHz: 170, pulseQ: 2.2, rough: 0.12, uneven: 0.1, pattern: [1.3, 0.75, 0.85, 1.25, 0.8, 1.2, 1.3, 0.8], res: [[75, 2.5, 5], [240, 3, 3]] },
    engDb: -2,
    ins: 0.6,
    rattle: 1,
  },
  small: { rpmPerMs: 104, eng: { cyl: 3, pulseHz: 380, pulseQ: 2.4, rough: 0.07, res: [[160, 2.5, 4], [520, 3, 3]] }, engDb: -5, ins: 0.75, rattle: 0.4 },
  electric: { rpmPerMs: 0, eng: null, engDb: -99, ins: 1.1, rattle: 0 },
}

const bed = {
  id: 'car-highway',
  name: 'Car on the highway',
  group: 'vehicles',
  about: 'Riding in a car at highway speed: tyre roar, wind, the engine, and trucks passing by.',
  params: [
    { id: 'intensity', name: 'Speed', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [30, 90] },
    {
      id: 'car',
      name: 'Car',
      type: 'choice',
      def: 'family',
      options: [
        { v: 'family', name: 'A quiet family car' },
        { v: 'truck', name: 'An old pickup truck' },
        { v: 'small', name: 'A small buzzy car' },
        { v: 'electric', name: 'An electric car' },
      ],
    },
    {
      id: 'surface',
      name: 'Road',
      type: 'choice',
      def: 'smooth',
      options: [
        { v: 'smooth', name: 'Smooth new road' },
        { v: 'seams', name: 'Concrete with seams' },
        { v: 'rough', name: 'Worn rough road' },
        { v: 'wet', name: 'Wet road' },
      ],
    },
    {
      id: 'windows',
      name: 'Windows',
      type: 'choice',
      def: 'closed',
      options: [
        { v: 'closed', name: 'All closed' },
        { v: 'crack', name: 'One open a crack' },
        { v: 'open', name: 'One rolled down' },
      ],
    },
    { id: 'traffic', name: 'Passing traffic', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 80] },
  ],

  generate(seconds, sr, p, rng) {
    const s = setup(bed, seconds, sr, p, rng)
    const { n, q } = s
    const SR = s.sr
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    if (n === 0) return stereo(SR, L, R)
    const r = s.rng
    const car = CARS[q.car] || CARS.family
    const k = q.intensity / 100
    const win = q.windows
    const winOpen = win === 'open' ? 1 : win === 'crack' ? 0.45 : 0

    // speed in metres per second, drifting gently; load follows hills
    const v0 = 16 + 24 * k
    const w1 = wander(n, SR, 0.06, r.fork('v1'))
    const w2 = wander(n, SR, 0.45, r.fork('v2'))
    const load = wander(n, SR, 0.09, r.fork('load'))
    const v = new Float32Array(n)
    for (let i = 0; i < n; i++) v[i] = v0 * (1 + 0.035 * w1[i] + 0.006 * w2[i])
    const sp = v0 / 30

    // road rumble (structure-borne) and tyre roar (airborne), left and right wheels
    const rough = q.surface === 'rough' ? 1 : q.surface === 'seams' ? 0.4 : q.surface === 'wet' ? 0.3 : 0.12
    const [rl, rr] = noisePair(n, r.fork('rumble'), 'brown', 0.55)
    for (const sig of [rl, rr]) {
      bq(sig, SR, 'lowpass', 150 + 40 * sp, 0.8)
      bq(sig, SR, 'peak', 48, 1.6, 4)
      norm(sig, 1)
    }
    const surf = wander(n, SR, 3 + 4 * rough, r.fork('surf'))
    const rumbleG = dB(-2 + 25 * Math.log10(sp) + 3 * rough)
    for (let i = 0; i < n; i++) {
      const m = 1 + rough * 0.35 * surf[i]
      L[i] += rl[i] * rumbleG * m
      R[i] += rr[i] * rumbleG * m
    }
    const [tl, tr] = noisePair(n, r.fork('tyre'), 'pink', 0.4)
    for (const sig of [tl, tr]) {
      bq(sig, SR, 'bandpass', 520 + 120 * sp, 0.45)
      bq(sig, SR, 'peak', 222, 4, 6)
      bq(sig, SR, 'lowpass', 2400 * car.ins + 400 * winOpen, 0.707)
      norm(sig, 1)
    }
    const tyreG = dB(-1 + 30 * Math.log10(sp) + (q.surface === 'wet' ? -2 : 0) + (car.ins < 1 ? 2 : 0))
    addTo(L, tl, tyreG)
    addTo(R, tr, tyreG)

    // wet road: tyre spray hiss with swishes through puddles
    if (q.surface === 'wet') {
      const [sl, sr2] = noisePair(n, r.fork('spray'), 'white', 0.2)
      const sw = wander(n, SR, 1.3, r.fork('swish'))
      for (const sig of [sl, sr2]) {
        bq(sig, SR, 'bandpass', 2600, 0.5)
        bq(sig, SR, 'highshelf', 6000, 0.707, -8)
        norm(sig, 1)
      }
      const g = dB(-5 + 30 * Math.log10(sp))
      for (let i = 0; i < n; i++) {
        const m = 0.65 + 0.35 * sw[i]
        L[i] += sl[i] * g * m * m
        R[i] += sr2[i] * g * m * m
      }
      for (const t of eventTimes(0.12, s.dur, r.fork('puddles'), 2)) {
        addBurst(L, R, Math.round(t * SR), SR, r, { amp: 2.2 * g, pan: r.range(-0.6, 0.6), tau: 0.16, attack: 0.05, f: 1800, q: 0.5 })
      }
    }

    // wind noise from the pillars and mirrors, gusting independently per side
    {
      const [wl, wr] = noisePair(n, r.fork('wind'), 'pink', 0.25)
      const gl = wander(n, SR, 0.25, r.fork('gl'))
      const gr = wander(n, SR, 0.22, r.fork('gr'))
      for (const sig of [wl, wr]) {
        bq(sig, SR, 'highpass', 380, 0.707)
        bq(sig, SR, 'peak', 1300, 0.9, 4)
        bq(sig, SR, 'lowpass', 5500 + 6000 * winOpen, 0.707)
        norm(sig, 1)
      }
      const g = dB(-13 + 50 * Math.log10(sp) + 16 * winOpen + (car.ins < 1 ? 3 : 0))
      for (let i = 0; i < n; i++) {
        L[i] += wl[i] * g * (1 + 0.3 * gl[i])
        R[i] += wr[i] * g * (1 + 0.3 * gr[i]) * (winOpen ? 0.7 : 1)
      }
    }

    // side-window buffeting: the cabin's Helmholtz "wub"
    if (winOpen > 0) {
      const fb = new Float32Array(n)
      const fw = wander(n, SR, 0.3, r.fork('fb'))
      const am = wander(n, SR, 0.8, r.fork('fbam'))
      for (let i = 0; i < n; i++) fb[i] = (14 + 3 * sp) * (1 + 0.06 * fw[i])
      const buf = new Float32Array(n)
      oscInto(buf, SR, fb, 1, harmonicTable([1, 0.7, 0.45, 0.3, 0.2, 0.12]), r.next(), 6)
      const nz = noise(n, r.fork('fbn'), 'brown')
      bq(nz, SR, 'lowpass', 120, 0.7)
      norm(nz, 0.5)
      for (let i = 0; i < n; i++) buf[i] = (buf[i] * (1 + nz[i])) * (0.75 + 0.25 * am[i])
      bq(buf, SR, 'lowpass', 160, 0.7)
      norm(buf, 1)
      const g = dB(-6 + 6 * winOpen + 12 * Math.log10(sp))
      for (let i = 0; i < n; i++) {
        L[i] += buf[i] * g * 0.6
        R[i] += buf[i] * g
      }
    }

    // the engine (or the electric motor's whine), in front of us
    if (car.eng) {
      const rpm = new Float32Array(n)
      for (let i = 0; i < n; i++) rpm[i] = v[i] * car.rpmPerMs * (1 + 0.04 * load[i])
      const e = engine(n, SR, rpm, car.eng, r.fork('engine'))
      bq(e, SR, 'lowpass', 900 + 2500 * winOpen + (car.ins < 1 ? 800 : 0), 0.707)
      const g = dB(car.engDb + 6 * k + 4 * winOpen)
      for (let i = 0; i < n; i++) {
        const x = e[i] * g * (0.8 + 0.2 * load[i])
        L[i] += x
        R[i] += x
      }
    } else {
      const f = new Float32Array(n)
      for (let i = 0; i < n; i++) f[i] = v[i] * 19.5
      const wb = new Float32Array(n)
      oscInto(wb, SR, f, 1, harmonicTable([1, 0.35, 0.5, 0.1, 0.2]), r.next(), 5)
      for (let i = 0; i < n; i++) f[i] *= 13.1
      oscInto(wb, SR, f, 0.06, SINE, r.next(), 1)
      const g = dB(-30 + 8 * k)
      for (let i = 0; i < n; i++) {
        const x = wb[i] * g * (0.7 + 0.3 * load[i])
        L[i] += x
        R[i] += x
      }
    }

    // concrete seams: front axle then rear axle, wheelbase / speed apart
    const thumpSet = (t, amp) => {
      const vv = v[Math.min(n - 1, Math.round(t * SR))]
      const wheel = 2.7 / vv
      for (let ax = 0; ax < 2; ax++) {
        const i0 = Math.round((t + ax * wheel) * SR)
        const a = amp * (ax ? 0.75 : 1) * r.range(0.85, 1.15)
        for (let side = -1; side <= 1; side += 2) {
          const j = i0 + Math.round(r.range(0, 0.004) * SR)
          addModes(L, R, j, SR, [[r.range(52, 68), 0.055, 1], [r.range(95, 120), 0.03, 0.5]], a, side * 0.25, r)
          addBurst(L, R, j, SR, r, { amp: a * 2.6, pan: side * 0.3, tau: 0.014, f: 380, q: 0.7 })
        }
      }
    }
    if (q.surface === 'seams') {
      let t = r.range(0, 0.4)
      while (t < s.dur) {
        thumpSet(t, 4.5 * dB(10 * Math.log10(sp)))
        const vv = v[Math.min(n - 1, Math.round(t * SR))]
        t += r.range(8.5, 13) / vv
      }
    } else {
      const rate = q.surface === 'rough' ? 2.2 : 0.12
      for (const t of eventTimes(rate, s.dur, r.fork('bumps'), 0.25)) thumpSet(t, r.range(0.3, 1.1) * (q.surface === 'rough' ? 1 : 0.6))
    }

    // rattles (old cars): little bursts of a loose panel after bumps
    if (car.rattle > 0) {
      for (const t of eventTimes(0.5 * car.rattle * (0.5 + rough), s.dur, r.fork('rattle'), 0.4)) {
        let tt = t
        const hits = 2 + r.int(5)
        for (let h = 0; h < hits; h++) {
          addModes(L, R, Math.round(tt * SR), SR, [[r.range(900, 1400), 0.012, 1], [r.range(2300, 3100), 0.006, 0.6]], 0.35, r.range(-0.5, 0.5))
          tt += r.range(0.025, 0.06)
        }
      }
    }

    // passing traffic: trucks and cars overtaking on the left
    const passRate = (q.traffic / 100) * 0.16
    for (const tc of eventTimes(passRate, s.dur + 3, r.fork('pass'), 2.5, -2)) {
      const truck = r.next() < 0.45
      const w = truck ? r.range(0.9, 1.5) : r.range(0.5, 0.9)
      const t0 = tc - 5 * w
      const m = Math.round(10 * w * SR)
      const seg = noise(m, r.fork('p' + tc), 'pink')
      const seg2 = noise(m, r.fork('q' + tc), 'brown')
      for (let i = 0; i < m; i++) seg[i] = seg[i] + seg2[i] * 1.3
      const bright = 700 + 2600 * winOpen
      bq(seg, SR, 'lowpass', bright, 0.8)
      bq(seg, SR, 'highpass', 60, 0.7)
      norm(seg, 1)
      if (truck) {
        const f = new Float32Array(m)
        const f0 = r.range(42, 58)
        for (let i = 0; i < m; i++) f[i] = f0 * (1 - 0.035 * Math.atan(((i / SR - 5 * w) / w) * 1.5) / 1.57)
        oscInto(seg, SR, f, 1.1, harmonicTable([1, 0.8, 0.6, 0.5, 0.35, 0.3, 0.2, 0.15]), 0, 8)
      }
      const amp = (truck ? 1.25 : 0.7) * dB(4 * winOpen)
      const side = -1
      const gL = new Float32Array(m)
      const gR = new Float32Array(m)
      for (let i = 0; i < m; i++) {
        const x = (i / SR - 5 * w) / w
        const e = 1 / (1 + x * x)
        const env = e * Math.sqrt(e) * amp
        const pan = side * (0.45 + 0.5 * e)
        gL[i] = env * panL(pan)
        gR[i] = env * panR(pan)
      }
      const i0 = Math.round(t0 * SR)
      for (let i = 0; i < m; i++) {
        const j = i0 + i
        if (j < 0) continue
        if (j >= n) break
        L[j] += seg[i] * gL[i]
        R[j] += seg[i] * gR[i]
      }
      if (truck) addBurst(L, R, Math.round((tc - 0.05) * SR), SR, r, { amp: 1.6, pan: -0.7, tau: 0.12, attack: 0.04, f: 70, q: 0.9, type: 'lowpass' })
    }

    // lane changes: the indicator relay, tick on and tock off
    for (const t of eventTimes((q.traffic / 100) * 0.035 + 0.008, s.dur, r.fork('lane'), 6)) {
      const flashes = 3 + r.int(4)
      const per = r.range(0.68, 0.76)
      for (let f = 0; f < flashes; f++) {
        const i1 = Math.round((t + f * per) * SR)
        const i2 = Math.round((t + f * per + per * 0.5) * SR)
        addModes(L, R, i1, SR, [[1750, 0.006, 1], [3900, 0.003, 0.7], [620, 0.01, 0.4]], 0.5, -0.15)
        addBurst(L, R, i1, SR, r, { amp: 0.35, pan: -0.15, tau: 0.0015, f: 3000, q: 0.7 })
        addModes(L, R, i2, SR, [[1450, 0.006, 1], [3300, 0.003, 0.5], [560, 0.01, 0.4]], 0.38, -0.15)
      }
    }

    // the cabin: a little low boom
    bq(L, SR, 'peak', 58, 1.4, 3)
    bq(R, SR, 'peak', 58, 1.4, 3)
    return finish(L, R, SR, -23 + (k - 0.6) * 8, -12)
  },
}

export default bed
