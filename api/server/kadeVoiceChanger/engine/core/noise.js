// core/noise.js - noise sources and random event building blocks.
//
// white   uniform in -1..1 (RMS about 0.577). Uniform rather than Gaussian
//         because it can never exceed full scale.
// pink    white through Paul Kellet's "refined" pink filter (seven parallel
//         one-pole sections, published on the music-dsp list in 1999), which
//         holds a -3 dB per octave slope within about 0.05 dB from roughly
//         10 Hz to Nyquist at 44.1 kHz (the corners scale with the rate, the
//         slope stays). The filter is pre-run for 4096 samples so the output
//         starts settled, and scaled so its RMS is 0.2 (about -14 dBFS).
// brown   leaky integrated white (a first-order lowpass with its pole just
//         inside the unit circle, -6 dB per octave above a corner of about
//         20 Hz at 48 kHz), pre-run and scaled to RMS 0.2 from the
//         closed-form variance of the leaky integrator, so loudness does not
//         depend on buffer length.
// velvet  Jarvelainen and Karjalainen's velvet noise (2007), as used for
//         reverbs and decorrelation by Valimaki and colleagues: one
//         impulse of random sign at a random place in each grid period of
//         sr / density samples, zero elsewhere. Perceptually smooth at around
//         1500 to 2000 impulses per second and very sparse to convolve with.
// crackle sparse random clicks at a Poisson rate with random amplitude,
//         width and polarity, half of them sharp single-sided ticks and half
//         short decaying noise bursts, and a small chance of a loud pop.
//         This is the building block for vinyl surface, fire, static and
//         Geiger-counter textures.
// burstEnvelope  Poisson or listed bursts with attack, hold and release,
//         for gusts, rumbles, crowd swells and the like.
//
// Every function takes an rng from core/rng.js; nothing uses Math.random.

import { makeRng } from './rng.js'

function rngOr(rng) {
  return rng || makeRng('noise')
}

/** Uniform white noise in -1..1. */
export function white(n, rng) {
  const r = rngOr(rng)
  const out = new Float32Array(Math.max(0, n | 0))
  for (let i = 0; i < out.length; i++) out[i] = r.next() * 2 - 1
  return out
}

let pinkScale = 0

function kelletGain() {
  if (pinkScale) return pinkScale
  // Energy of the filter's impulse response, then scale for uniform input
  // (variance 1/3) to land on RMS 0.2.
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  let e = 0
  for (let i = 0; i < 40000; i++) {
    const w = i === 0 ? 1 : 0
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.969 * b2 + w * 0.153852
    b3 = 0.8665 * b3 + w * 0.3104856
    b4 = 0.55 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.016898
    const y = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362
    b6 = w * 0.115926
    e += y * y
  }
  pinkScale = 0.2 / Math.sqrt(e / 3)
  return pinkScale
}

/** Pink noise (-3 dB per octave), RMS about 0.2. */
export function pink(n, rng) {
  const r = rngOr(rng)
  const len = Math.max(0, n | 0)
  const out = new Float32Array(len)
  const g = kelletGain()
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  const warm = 4096
  for (let i = -warm; i < len; i++) {
    const w = r.next() * 2 - 1
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.969 * b2 + w * 0.153852
    b3 = 0.8665 * b3 + w * 0.3104856
    b4 = 0.55 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.016898
    const y = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362
    b6 = w * 0.115926
    if (i >= 0) out[i] = y * g
  }
  return out
}

/** Brown (red) noise, -6 dB per octave, RMS about 0.2. leak sets the low corner. */
export function brown(n, rng, leak = 0.9975) {
  const r = rngOr(rng)
  const len = Math.max(0, n | 0)
  const out = new Float32Array(len)
  let a = Number(leak)
  if (!(a > 0)) a = 0.9975
  if (a > 0.99999) a = 0.99999
  const g = 0.2 / Math.sqrt(1 / 3 / (1 - a * a))
  let y = 0
  const warm = Math.min(200000, Math.ceil(6 / (1 - a)))
  for (let i = -warm; i < len; i++) {
    y = a * y + (r.next() * 2 - 1)
    if (i >= 0) out[i] = y * g
  }
  return out
}

/** Velvet noise: `density` impulses of random sign per second. */
export function velvet(n, sr, density = 2000, rng) {
  const r = rngOr(rng)
  const len = Math.max(0, n | 0)
  const out = new Float32Array(len)
  let d = Number(density)
  if (!(d > 0)) return out
  if (d > sr) d = sr
  const td = sr / d
  for (let m = 0; ; m++) {
    const base = m * td
    if (base >= len) break
    const pos = Math.floor(base + r.next() * (td - 1e-9))
    if (pos < len) out[pos] = r.next() < 0.5 ? -1 : 1
  }
  return out
}

/**
 * Random sparse clicks. ratePerSec is the average number of events.
 * opts: { minWidthMs=0.03, maxWidthMs=2.5, popChance=0.04, minAmp=0.05,
 *         tickShare=0.5 } (share of events that are single-sided ticks).
 */
export function crackle(n, sr, ratePerSec = 20, rng, opts = {}) {
  const r = rngOr(rng)
  const len = Math.max(0, n | 0)
  const out = new Float32Array(len)
  let rate = Number(ratePerSec)
  if (!(rate > 0) || len === 0) return out
  if (rate > sr / 2) rate = sr / 2
  const minW = Math.max(0.005, opts.minWidthMs ?? 0.03)
  const maxW = Math.max(minW, opts.maxWidthMs ?? 2.5)
  const popChance = opts.popChance ?? 0.04
  const minAmp = opts.minAmp ?? 0.05
  const tickShare = opts.tickShare ?? 0.5
  const lnMin = Math.log(minW)
  const lnMax = Math.log(maxW)
  const meanGap = sr / rate
  let t = -Math.log(1 - r.next()) * meanGap
  while (t < len) {
    const start = Math.floor(t)
    const u = r.next()
    let amp = minAmp + (1 - minAmp) * u * u * u
    if (r.next() < popChance) amp = 0.7 + 0.3 * r.next()
    const pol = r.next() < 0.5 ? -1 : 1
    const wMs = Math.exp(lnMin + (lnMax - lnMin) * r.next())
    const w = Math.max(1, Math.round((wMs * sr) / 1000))
    const end = Math.min(len, start + w * 4)
    const k = 1 / w
    if (r.next() < tickShare) {
      // Sharp single-sided tick: instant rise, exponential fall.
      for (let i = start; i < end; i++) out[i] += pol * amp * Math.exp(-(i - start) * k)
    } else {
      // Short decaying noise burst, a tiny "crk".
      for (let i = start; i < end; i++) {
        out[i] += amp * (r.next() * 2 - 1) * Math.exp(-(i - start) * k)
      }
    }
    t += -Math.log(1 - r.next()) * meanGap
  }
  return out
}

/**
 * Envelope (0..1) made of bursts.
 * opts: { rate=1 (bursts per second, Poisson), attackMs=30, holdMs=60,
 *   releaseMs=250, gainMin=0.3, gainMax=1, jitter=0.5 (random spread of the
 *   three times, 0..1), events=null }
 * events, when given, replaces the random schedule: an array of start
 * times in seconds, or of { t, gain, attackMs, holdMs, releaseMs }.
 * Overlapping bursts take the louder value.
 */
export function burstEnvelope(n, sr, opts = {}, rng) {
  const r = rngOr(rng)
  const len = Math.max(0, n | 0)
  const out = new Float32Array(len)
  if (len === 0) return out
  const aMs = opts.attackMs ?? 30
  const hMs = opts.holdMs ?? 60
  const rMs = opts.releaseMs ?? 250
  const gMin = opts.gainMin ?? 0.3
  const gMax = opts.gainMax ?? 1
  const jit = Math.min(1, Math.max(0, opts.jitter ?? 0.5))
  const list = []
  if (Array.isArray(opts.events)) {
    for (const e of opts.events) {
      if (typeof e === 'number') list.push({ t: e, gain: gMax, attackMs: aMs, holdMs: hMs, releaseMs: rMs })
      else if (e && Number.isFinite(e.t)) {
        list.push({ t: e.t, gain: e.gain ?? gMax, attackMs: e.attackMs ?? aMs, holdMs: e.holdMs ?? hMs, releaseMs: e.releaseMs ?? rMs })
      }
    }
  } else {
    const rate = Number(opts.rate ?? 1)
    if (rate > 0) {
      let t = -Math.log(1 - r.next()) / rate
      const dur = len / sr
      const j = () => 1 + jit * (r.next() * 2 - 1)
      while (t < dur) {
        list.push({ t, gain: gMin + (gMax - gMin) * r.next(), attackMs: aMs * j(), holdMs: hMs * j(), releaseMs: rMs * j() })
        t += -Math.log(1 - r.next()) / rate
      }
    }
  }
  for (const e of list) {
    const s = Math.round(e.t * sr)
    const a = Math.max(1, Math.round((e.attackMs * sr) / 1000))
    const h = Math.max(0, Math.round((e.holdMs * sr) / 1000))
    const rl = Math.max(1, Math.round((e.releaseMs * sr) / 1000))
    const g = Math.max(0, Math.min(1, e.gain))
    const end = Math.min(len, s + a + h + rl)
    for (let i = Math.max(0, s); i < end; i++) {
      const k = i - s
      let v
      if (k < a) v = 0.5 - 0.5 * Math.cos((Math.PI * k) / a)
      else if (k < a + h) v = 1
      else v = 0.5 + 0.5 * Math.cos((Math.PI * (k - a - h)) / rl)
      v *= g
      if (v > out[i]) out[i] = v
    }
  }
  return out
}
