// modules/spec/_carriers.js - built-in "other sounds" for cross-synthesis
// (spec.morph and spec.blend). NOT an effect: no default export; the registry
// should skip files whose name starts with an underscore.
//
// Every carrier is synthesised here, seeded from the stage rng, in stereo, to
// the exact length needed, so nothing is ever looped and nothing is a
// recording. The recipes follow published procedural-audio designs:
// - wind: noise through slowly wandering resonant band-pass filters whose
//   centre and level follow a gust curve, plus a broadband low-passed body
//   (Farnell 2010, "Designing Sound", the wind chapters).
// - rain: individual drops as damped sinusoids whose pitch rises over the
//   drop's life (the Minnaert bubble resonance, as modelled by van den Doel
//   2005, "Physically based models for liquid sounds", ACM TAP), on a bed of
//   velvet-noise patter and a high hiss.
// - fire: low-passed brown-noise roar with slow flicker, a band of hiss,
//   sparse crackle pops and bursts of micro-crackle (Farnell 2010, fire).
// - engine: an impulse train at the firing rate with per-cylinder level
//   differences and slow rpm wander, exciting resonances for the exhaust,
//   body and rattle (source-filter engine model, Farnell 2010, engines).
// - ocean: scheduled waves, each a slow swell, a bright crash and a fizzing
//   retreat, on a brown-noise rumble.
// - crowd: a babble of fourteen small formant-synth talkers (saw source,
//   three formant band-passes, random vowels and syllable timing), made at
//   16 kHz and resampled, in the manner of Klatt-style cascade synthesis.
// - pad: band-limited (polyBLEP, Valimaki and Huovilainen 2007) detuned saw
//   chords on a four-chord progression with slow filter breathing.
// - organ: additive tonewheel-style drawbar organ (sine partials at
//   0.5 to 8 times each note) with chorus-vibrato and a slow rotating feel.
// - bells: struck bells with the classic inharmonic church-bell partials
//   (hum, prime, tierce, quint, nominal ...), each a damped complex
//   oscillator, struck on a pentatonic pattern.
//
// makeCarrier(name, len, sr, rng) returns [L, R] Float32Arrays at RMS 0.1.

import { pink, white, brown, velvet, crackle, burstEnvelope } from '../../core/noise.js'
import { Biquad, SVF } from '../../core/biquad.js'
import { resampleTo } from '../../core/resample.js'

export const CARRIER_OPTIONS = [
  { v: 'wind', name: 'Wind' },
  { v: 'rain', name: 'Rain' },
  { v: 'fire', name: 'Fire' },
  { v: 'engine', name: 'Engine' },
  { v: 'ocean', name: 'Ocean waves' },
  { v: 'crowd', name: 'Crowd noise' },
  { v: 'pad', name: 'Synth pad' },
  { v: 'organ', name: 'Organ' },
  { v: 'bells', name: 'Bells' },
]


const TAB_N = 4096
const SIN_TAB = new Float32Array(TAB_N + 1)
for (let i = 0; i <= TAB_N; i++) SIN_TAB[i] = Math.sin((2 * Math.PI * i) / TAB_N)

function sinT(ph) {
  const x = (ph - Math.floor(ph)) * TAB_N
  const i = x | 0
  const f = x - i
  return SIN_TAB[i] + (SIN_TAB[i + 1] - SIN_TAB[i]) * f
}

function blep(t, dt) {
  if (t < dt) {
    const u = t / dt
    return u + u - u * u - 1
  }
  if (t > 1 - dt) {
    const u = (t - 1) / dt
    return u * u + u + u + 1
  }
  return 0
}

/** Smooth random curve in about -1..1: cosine-interpolated random points `rate` per second. */
function smoothCurve(len, sr, rng, rate) {
  const out = new Float32Array(len)
  const T = Math.max(2, Math.round(sr / Math.max(0.01, rate)))
  let a = rng.next() * 2 - 1
  let b = rng.next() * 2 - 1
  let k = Math.floor(rng.next() * T)
  for (let i = 0; i < len; i++) {
    const t = 0.5 - 0.5 * Math.cos((Math.PI * k) / T)
    out[i] = a + (b - a) * t
    k++
    if (k >= T) {
      k = 0
      a = b
      b = rng.next() * 2 - 1
    }
  }
  return out
}

function hzOfMidi(m) {
  return 440 * Math.pow(2, (m - 69) / 12)
}

function normalizePair(L, R, target = 0.1) {
  let e = 0
  for (let i = 0; i < L.length; i++) e += L[i] * L[i] + R[i] * R[i]
  const r = L.length ? Math.sqrt(e / (2 * L.length)) : 0
  if (r > 1e-9) {
    const g = target / r
    for (let i = 0; i < L.length; i++) {
      L[i] *= g
      R[i] *= g
    }
  }
  for (let i = 0; i < L.length; i++) {
    if (!(L[i] > -1e30 && L[i] < 1e30)) L[i] = 0
    if (!(R[i] > -1e30 && R[i] < 1e30)) R[i] = 0
  }
  return [L, R]
}

// ---------------------------------------------------------------- wind

function wind(len, sr, rng) {
  const L = new Float32Array(len)
  const R = new Float32Array(len)
  const shared = smoothCurve(len, sr, rng.fork('gust'), 0.13)
  const slow = smoothCurve(len, sr, rng.fork('gust2'), 0.045)
  const outs = [L, R]
  const nyq = sr * 0.45
  for (let c = 0; c < 2; c++) {
    const r = rng.fork('wind' + c)
    const body = pink(len, r.fork('body'))
    // wind has no real sub-bass; keep the body above about 100 Hz
    new Biquad('highpass', sr, Math.min(100, nyq), 0.7).run(body)
    new Biquad('highpass', sr, Math.min(100, nyq), 0.7).run(body)
    const wn = white(len, r.fork('white'))
    const own = smoothCurve(len, sr, r.fork('own'), 0.3)
    const wander = [smoothCurve(len, sr, r.fork('w0'), 0.21), smoothCurve(len, sr, r.fork('w1'), 0.17), smoothCurve(len, sr, r.fork('w2'), 0.27)]
    const base = [310 + 60 * r.next(), 520 + 90 * r.next(), 820 + 150 * r.next()]
    const lp = new SVF(sr)
    const bp = [new SVF(sr), new SVF(sr), new SVF(sr)]
    const hiss = new Biquad('highpass', sr, Math.min(3200, nyq), 0.7)
    const out = outs[c]
    let g = 0.5
    let fBody = 800
    const fh = [0, 0, 0]
    for (let b0 = 0; b0 < len; b0 += 32) {
      const ci = b0
      let gv = 0.55 + 0.3 * shared[ci] + 0.15 * own[ci] + 0.15 * slow[ci]
      if (gv < 0.06) gv = 0.06
      if (gv > 1) gv = 1
      g = gv
      fBody = Math.min(nyq, 220 + 1700 * g * g)
      for (let j = 0; j < 3; j++) fh[j] = Math.min(nyq, base[j] * (0.75 + 0.6 * g) * (1 + 0.18 * wander[j][ci]))
      const bEnd = Math.min(len, b0 + 32)
      const gb = 0.25 + 0.75 * g
      const gh = 0.22 * Math.pow(g, 1.7)
      for (let i = b0; i < bEnd; i++) {
        let y = lp.tick(body[i], fBody, 0.7).lp * gb
        const x = wn[i]
        for (let j = 0; j < 3; j++) y += bp[j].tick(x, fh[j], 16).bp * gh * (j === 1 ? 1.2 : 1)
        y += hiss.tick(x) * 0.02 * g
        out[i] = y
      }
    }
  }
  return normalizePair(L, R)
}

// ---------------------------------------------------------------- rain

function rain(len, sr, rng) {
  const L = new Float32Array(len)
  const R = new Float32Array(len)
  const nyq = sr * 0.45
  const outs = [L, R]
  for (let c = 0; c < 2; c++) {
    const r = rng.fork('rain' + c)
    const out = outs[c]
    // hiss bed
    const h = white(len, r.fork('hiss'))
    new Biquad('highpass', sr, Math.min(1300, nyq), 0.7).run(h)
    new Biquad('lowpass', sr, Math.min(8500, nyq), 0.7).run(h)
    const sway = smoothCurve(len, sr, r.fork('sway'), 0.2)
    for (let i = 0; i < len; i++) out[i] = h[i] * 0.05 * (1 + 0.3 * sway[i])
    // dense patter
    const pat = velvet(len, sr, 1800, r.fork('patter'))
    new Biquad('highpass', sr, Math.min(2200, nyq), 0.7).run(pat)
    new Biquad('lowpass', sr, Math.min(7000, nyq), 0.7).run(pat)
    for (let i = 0; i < len; i++) out[i] += pat[i] * 0.12
  }
  // individual drops, panned
  const dr = rng.fork('drops')
  const addDrops = (rate, fLo, fHi, durLo, durHi, ampLo, ampHi, rise) => {
    const mean = sr / rate
    let t = -Math.log(1 - dr.next()) * mean
    while (t < len) {
      const s = Math.floor(t)
      const f0 = Math.exp(Math.log(fLo) + (Math.log(fHi) - Math.log(fLo)) * dr.next())
      const dur = Math.max(8, Math.round((durLo + (durHi - durLo) * dr.next()) * sr))
      const u = dr.next()
      const amp = ampLo + (ampHi - ampLo) * u * u * u
      const k = rise * (0.5 + dr.next())
      const pan = dr.next()
      const gl = Math.cos(pan * 0.5 * Math.PI)
      const gr = Math.sin(pan * 0.5 * Math.PI)
      const tau = dur / 3.5
      const att = 0.00025 * sr
      let ph = dr.next()
      const end = Math.min(len, s + dur)
      for (let i = s; i < end; i++) {
        const q = i - s
        const f = Math.min(nyq, f0 * (1 + (k * q) / dur))
        ph += f / sr
        const v = sinT(ph) * amp * Math.exp(-q / tau) * (1 - Math.exp(-q / att))
        L[i] += v * gl
        R[i] += v * gr
      }
      // impact tick
      const tk = Math.min(len, s + Math.max(2, Math.round(0.0005 * sr)))
      for (let i = s; i < tk; i++) {
        const v = (dr.next() * 2 - 1) * amp * 0.35 * Math.exp(-(i - s) / (0.00015 * sr + 1))
        L[i] += v * gl
        R[i] += v * gr
      }
      t += -Math.log(1 - dr.next()) * mean
    }
  }
  addDrops(320, 1500, 5200, 0.003, 0.011, 0.03, 0.45, 0.9)
  addDrops(14, 480, 1100, 0.014, 0.032, 0.15, 0.6, 0.6)
  return normalizePair(L, R)
}

// ---------------------------------------------------------------- fire

function fire(len, sr, rng) {
  const L = new Float32Array(len)
  const R = new Float32Array(len)
  const nyq = sr * 0.45
  const outs = [L, R]
  const flickShared = smoothCurve(len, sr, rng.fork('flick'), 2.2)
  for (let c = 0; c < 2; c++) {
    const r = rng.fork('fire' + c)
    const out = outs[c]
    const fl2 = smoothCurve(len, sr, r.fork('f2'), 6.5)
    // the roar of the flames: a band from about 90 to 500 Hz, not a sub-bass rumble
    const roar = pink(len, r.fork('roar'))
    new Biquad('lowpass', sr, Math.min(500, nyq), 0.8).run(roar)
    new Biquad('highpass', sr, Math.min(90, nyq), 0.7).run(roar)
    new Biquad('highpass', sr, Math.min(90, nyq), 0.7).run(roar)
    const lap = pink(len, r.fork('lap'))
    new Biquad('bandpass', sr, Math.min(900, nyq), 0.6).run(lap)
    const hs = white(len, r.fork('hiss'))
    new Biquad('bandpass', sr, Math.min(3500, nyq), 0.8).run(hs)
    const cr = crackle(len, sr, 13, r.fork('crk'), { popChance: 0.1, maxWidthMs: 1.4, minAmp: 0.1 })
    new Biquad('highpass', sr, Math.min(300, nyq), 0.7).run(cr)
    const micro = crackle(len, sr, 95, r.fork('micro'), { maxWidthMs: 0.4, minAmp: 0.02, popChance: 0 })
    const bursts = burstEnvelope(len, sr, { rate: 0.8, attackMs: 20, holdMs: 140, releaseMs: 320 }, r.fork('bursts'))
    for (let i = 0; i < len; i++) {
      const fk = 0.62 + 0.3 * flickShared[i] + 0.1 * fl2[i]
      out[i] = roar[i] * 1.1 * fk + lap[i] * 0.5 * (0.7 + 0.3 * fl2[i]) + hs[i] * 0.08 * fk + cr[i] * 0.85 + micro[i] * 0.45 * bursts[i]
    }
  }
  return normalizePair(L, R)
}

// ---------------------------------------------------------------- engine

function engine(len, sr, rng) {
  const L = new Float32Array(len)
  const R = new Float32Array(len)
  const nyq = sr * 0.45
  const r = rng.fork('engine')
  const rpm1 = smoothCurve(len, sr, r.fork('rpm1'), 0.22)
  const rpm2 = smoothCurve(len, sr, r.fork('rpm2'), 1.7)
  const noise = white(len, r.fork('mech'))
  const exc = new Float32Array(len)
  const fenv = new Float32Array(len)
  const cyl = [1, 0.82, 0.93, 0.78]
  // each firing is a smooth 2.5 ms pressure pulse (sine-squared), not a click,
  // so the energy sits in the low harmonics where an engine's growl lives
  const T = Math.max(4, Math.round(0.0025 * sr))
  const pulse = new Float32Array(T)
  for (let i = 0; i < T; i++) {
    const s = Math.sin((Math.PI * (i + 0.5)) / T)
    pulse[i] = s * s
  }
  let ph = 0
  let n = 0
  let env = 0
  const envC = Math.exp(-1 / (0.004 * sr))
  for (let i = 0; i < len; i++) {
    const f = 46 * (1 + 0.05 * rpm1[i] + 0.015 * rpm2[i])
    ph += f / sr
    if (ph >= 1) {
      ph -= 1
      const a = cyl[n & 3] * (1 + 0.06 * r.gauss())
      n++
      const end = Math.min(len, i + T)
      for (let j = i; j < end; j++) exc[j] += a * pulse[j - i]
      env = 1
    }
    env *= envC
    fenv[i] = env
  }
  const bp1 = new SVF(sr)
  const lp1 = new SVF(sr)
  const bp2 = new SVF(sr)
  const mech = new Biquad('bandpass', sr, Math.min(1800, nyq), 1)
  const f1 = Math.min(110, nyq)
  const f2 = Math.min(380, nyq)
  const f3 = Math.min(900, nyq)
  for (let i = 0; i < len; i++) {
    const x = exc[i]
    const y = (bp1.tick(x, f1, 3).bp * 0.9) / 3 + lp1.tick(x, f2, 1.2).lp * 0.7 + (bp2.tick(x, f3, 2).bp * 0.2) / 2
    const m = mech.tick(noise[i] * fenv[i]) * 0.06
    L[i] = y + m
    R[i] = y * 0.96 + m * 0.8
  }
  // a little exhaust breath under the firing
  const breath = pink(len, r.fork('breath'))
  new Biquad('lowpass', sr, Math.min(700, nyq), 0.7).run(breath)
  let ey = 0
  for (let i = 0; i < len; i++) ey += L[i] * L[i]
  const gb = len ? (Math.sqrt(ey / len) / 0.2) * 0.12 : 0
  for (let i = 0; i < len; i++) {
    const b = breath[i] * gb * (0.6 + 0.4 * fenv[i])
    L[i] += b
    R[i] += breath[(i + 331) % len] * gb * (0.6 + 0.4 * fenv[i])
  }
  return normalizePair(L, R)
}

// ---------------------------------------------------------------- ocean

function ocean(len, sr, rng) {
  const L = new Float32Array(len)
  const R = new Float32Array(len)
  const nyq = sr * 0.45
  const dur = len / sr
  const wr = rng.fork('waves')
  const waves = []
  let t = -wr.next() * 4
  while (t < dur + 6) {
    const rise = 1.6 + 1.6 * wr.next()
    waves.push({ t0: t, peak: t + rise, decay: 3 + 2.5 * wr.next(), amp: 0.55 + 0.45 * wr.next() })
    t += 5.5 + 4.5 * wr.next()
  }
  const outs = [L, R]
  for (let c = 0; c < 2; c++) {
    const r = rng.fork('ocean' + c)
    const out = outs[c]
    const off = (c === 0 ? -1 : 1) * (0.1 + 0.15 * r.next())
    const surf = pink(len, r.fork('surf'))
    const fz = white(len, r.fork('fizz'))
    new Biquad('highpass', sr, Math.min(3500, nyq), 0.7).run(fz)
    const rum = brown(len, r.fork('rumble'))
    new Biquad('lowpass', sr, Math.min(180, nyq), 0.7).run(rum)
    new Biquad('highpass', sr, Math.min(35, nyq), 0.7).run(rum)
    const lp = new SVF(sr)
    const grain = velvet(len, sr, 900, r.fork('foam'))
    for (let b0 = 0; b0 < len; b0 += 64) {
      const ts = b0 / sr
      let W = 0
      let B = 0
      let F = 0
      for (let k = 0; k < waves.length; k++) {
        const w = waves[k]
        const t0 = w.t0 + off
        const tp = w.peak + off
        if (ts < t0 || ts > tp + w.decay * 2.5) continue
        let e
        let b
        let f = 0
        if (ts < tp) {
          const x = (ts - t0) / (tp - t0)
          e = x * x
          b = x * x * x
        } else {
          const d = ts - tp
          e = Math.exp(-d / (w.decay / 2.2))
          b = Math.exp(-d / 0.45)
          f = Math.exp(-d / 1.4) * (1 - Math.exp(-d / 0.08))
        }
        e *= w.amp
        b *= w.amp
        f *= w.amp
        if (e > W) W = e
        if (b > B) B = b
        if (f > F) F = f
      }
      const fc = Math.min(nyq, 300 + 3600 * B)
      const bEnd = Math.min(len, b0 + 64)
      for (let i = b0; i < bEnd; i++) {
        const s = lp.tick(surf[i], fc, 0.6).lp
        out[i] = s * (0.12 + 1.1 * W) + fz[i] * (0.06 * W + 0.25 * F) * (0.5 + 0.5 * Math.abs(grain[i]) * 4) + rum[i] * 0.18
      }
    }
  }
  return normalizePair(L, R)
}

// ---------------------------------------------------------------- crowd

const VOWELS = [
  [730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240], [530, 1840, 2480], [570, 840, 2410],
  [660, 1720, 2410], [490, 1350, 1690], [440, 1020, 2240], [400, 1920, 2560],
]

function crowd(len, sr, rng) {
  const srC = Math.min(sr, 16000)
  const n = Math.max(1, Math.round((len * srC) / sr))
  const Lc = new Float32Array(n)
  const Rc = new Float32Array(n)
  const nyq = srC * 0.45
  const T = 14
  for (let v = 0; v < T; v++) {
    const r = rng.fork('talker' + v)
    const female = r.next() < 0.5
    const f0b = female ? 170 + 70 * r.next() : 95 + 45 * r.next()
    const fs = female ? 1.15 : 1
    const pan = 0.05 + 0.9 * r.next()
    const lvl = 0.35 + 0.65 * r.next()
    const gl = Math.cos(pan * 0.5 * Math.PI) * lvl
    const gr = Math.sin(pan * 0.5 * Math.PI) * lvl
    const inton = smoothCurve(n, srC, r.fork('inton'), 0.9)
    const bp = [new SVF(srC), new SVF(srC), new SVF(srC)]
    const cur = [500, 1500, 2500]
    const tgt = [500, 1500, 2500]
    let ph = r.next()
    let env = 0
    let on = 1
    let timer = Math.round((0.05 + 0.3 * r.next()) * srC)
    let bump = 0
    const ca = Math.exp(-1 / (0.02 * srC))
    const cr = Math.exp(-1 / (0.04 * srC))
    const glide = 1 - Math.exp(-32 / (0.03 * srC))
    for (let b0 = 0; b0 < n; b0 += 32) {
      for (let j = 0; j < 3; j++) cur[j] += (tgt[j] - cur[j]) * glide
      const bEnd = Math.min(n, b0 + 32)
      for (let i = b0; i < bEnd; i++) {
        timer--
        if (timer <= 0) {
          if (on && r.next() < 0.18) {
            on = 0
            timer = Math.round((0.25 + 0.6 * r.next()) * srC)
          } else {
            on = 1
            const vw = VOWELS[r.int(VOWELS.length)]
            for (let j = 0; j < 3; j++) tgt[j] = Math.min(nyq, vw[j] * fs)
            timer = Math.round((0.12 + 0.14 * r.next()) * srC)
            bump = 0.06 * (r.next() * 2 - 1)
          }
        }
        const target = on ? 1 : 0
        env = target + (target > env ? ca : cr) * (env - target)
        const f0 = f0b * (1 + 0.09 * inton[i] + bump)
        const dt = f0 / srC
        ph += dt
        if (ph >= 1) ph -= 1
        const saw = 2 * ph - 1 - blep(ph, dt)
        const x = saw * env
        let y = bp[0].tick(x, cur[0], cur[0] / 90).bp * (90 / cur[0])
        y += bp[1].tick(x, cur[1], cur[1] / 110).bp * (110 / cur[1]) * 0.55
        y += bp[2].tick(x, cur[2], cur[2] / 140).bp * (140 / cur[2]) * 0.3
        Lc[i] += y * gl
        Rc[i] += y * gr
      }
    }
  }
  let L = Lc
  let R = Rc
  if (srC !== sr) {
    L = resampleTo(Lc, srC, sr)
    R = resampleTo(Rc, srC, sr)
  }
  const fixL = new Float32Array(len)
  const fixR = new Float32Array(len)
  fixL.set(L.subarray(0, Math.min(len, L.length)))
  fixR.set(R.subarray(0, Math.min(len, R.length)))
  const room = pink(len, rng.fork('room'))
  let e = 0
  for (let i = 0; i < len; i++) e += fixL[i] * fixL[i]
  const rr = len ? Math.sqrt(e / len) : 0
  for (let i = 0; i < len; i++) {
    fixL[i] += room[i] * rr * 0.35
    fixR[i] += room[(i + 997) % len] * rr * 0.35
  }
  return normalizePair(fixL, fixR)
}

// ---------------------------------------------------------------- chords

const PROGRESSION = [
  [45, 52, 57, 60, 64],
  [41, 48, 57, 60, 65],
  [48, 55, 60, 64, 67],
  [43, 50, 55, 59, 62],
]
const CHORD_SECONDS = 5

function chordMidi(tSec, voice, glideSec) {
  const seg = Math.floor(tSec / CHORD_SECONDS)
  const a = PROGRESSION[seg % PROGRESSION.length][voice]
  const b = PROGRESSION[(seg + 1) % PROGRESSION.length][voice]
  const into = tSec - seg * CHORD_SECONDS
  const gs = CHORD_SECONDS - glideSec
  if (glideSec > 0 && into > gs) {
    const x = (into - gs) / glideSec
    const s = x * x * (3 - 2 * x)
    return a + (b - a) * s
  }
  return a
}

function pad(len, sr, rng) {
  const L = new Float32Array(len)
  const R = new Float32Array(len)
  const nyq = sr * 0.45
  const r = rng.fork('pad')
  const det = [-0.09, 0, 0.09]
  const phs = new Float64Array(15)
  for (let i = 0; i < 15; i++) phs[i] = r.next()
  const fL = new SVF(sr)
  const fR = new SVF(sr)
  const phiL = r.next() * 6.28
  const phiR = r.next() * 6.28
  const freqs = new Float64Array(15)
  for (let b0 = 0; b0 < len; b0 += 32) {
    const t = b0 / sr
    for (let v = 0; v < 5; v++) {
      const m = chordMidi(t, v, 1.0)
      for (let d = 0; d < 3; d++) freqs[v * 3 + d] = hzOfMidi(m + det[d])
    }
    const cL = Math.min(nyq, 700 + 1500 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.06 * t + phiL)))
    const cR = Math.min(nyq, 700 + 1500 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.06 * t + phiR)))
    const swell = (0.85 + 0.15 * Math.sin(2 * Math.PI * 0.11 * t)) * Math.min(1, t / 0.3 + 0.05)
    const bEnd = Math.min(len, b0 + 32)
    for (let i = b0; i < bEnd; i++) {
      let l = 0
      let rr = 0
      for (let k = 0; k < 15; k++) {
        const dt = freqs[k] / sr
        let p = phs[k] + dt
        if (p >= 1) p -= 1
        phs[k] = p
        const s = 2 * p - 1 - blep(p, dt)
        const d = k % 3
        if (d === 0) l += s
        else if (d === 2) rr += s
        else {
          l += 0.7 * s
          rr += 0.7 * s
        }
      }
      L[i] = fL.tick(l * swell, cL, 0.8).lp
      R[i] = fR.tick(rr * swell, cR, 0.8).lp
    }
  }
  return normalizePair(L, R)
}

function organ(len, sr, rng) {
  const L = new Float32Array(len)
  const R = new Float32Array(len)
  const nyq = sr * 0.45
  const r = rng.fork('organ')
  const ratios = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8]
  const weights = [0.5, 1, 0.55, 0.75, 0.4, 0.5, 0.2, 0.22, 0.3]
  const NV = 5
  const NP = ratios.length
  const phs = new Float64Array(NV * NP)
  for (let i = 0; i < phs.length; i++) phs[i] = r.next()
  const inc = new Float64Array(NV * NP)
  const amp = new Float64Array(NV)
  const xf = 0.025
  for (let b0 = 0; b0 < len; b0 += 32) {
    const t = b0 / sr
    const seg = Math.floor(t / CHORD_SECONDS)
    const into = t - seg * CHORD_SECONDS
    for (let v = 0; v < NV; v++) {
      const base = PROGRESSION[seg % PROGRESSION.length][v] + (v >= 2 ? 12 : 0)
      const nextNote = PROGRESSION[(seg + 1) % PROGRESSION.length][v] + (v >= 2 ? 12 : 0)
      const prevNote = PROGRESSION[(seg + PROGRESSION.length - 1) % PROGRESSION.length][v] + (v >= 2 ? 12 : 0)
      let a = 1
      if (nextNote !== base && into > CHORD_SECONDS - xf) a = (CHORD_SECONDS - into) / xf
      if (prevNote !== base && into < xf && seg > 0) a = into / xf
      if (t < 0.01) a = t / 0.01
      amp[v] = a < 0 ? 0 : a
      const vib = 1 + 0.0035 * Math.sin(2 * Math.PI * 6.6 * t)
      const f = hzOfMidi(base) * vib
      for (let p = 0; p < NP; p++) {
        const fp = f * ratios[p]
        inc[v * NP + p] = fp < nyq ? fp / sr : 0
      }
    }
    const rot = Math.sin(2 * Math.PI * 0.9 * t)
    const gUL = 0.75 + 0.25 * rot
    const gUR = 0.75 - 0.25 * rot
    const bEnd = Math.min(len, b0 + 32)
    for (let i = b0; i < bEnd; i++) {
      let low = 0
      let up = 0
      for (let v = 0; v < NV; v++) {
        const av = amp[v]
        for (let p = 0; p < NP; p++) {
          const k = v * NP + p
          const d = inc[k]
          if (d === 0) continue
          let ph = phs[k] + d
          if (ph >= 1) ph -= 1
          phs[k] = ph
          const s = sinT(ph) * weights[p] * av
          if (p >= 3) up += s
          else low += s
        }
      }
      L[i] = low + up * gUL
      R[i] = low + up * gUR
    }
  }
  return normalizePair(L, R)
}

// ---------------------------------------------------------------- bells

const BELL_RATIOS = [0.5, 1.0, 1.183, 1.506, 2.0, 2.514, 2.662, 3.011, 4.166]
const BELL_AMPS = [0.35, 0.8, 0.6, 0.4, 1.0, 0.35, 0.3, 0.25, 0.15]
const BELL_TAUS = [4.0, 2.6, 2.0, 1.6, 1.3, 0.9, 0.8, 0.6, 0.45]
const BELL_NOTES = [60, 62, 64, 67, 69, 72, 74, 76, 55, 57]

function bells(len, sr, rng) {
  const L = new Float32Array(len)
  const R = new Float32Array(len)
  const nyq = sr * 0.45
  const r = rng.fork('bells')
  let t = 0.03
  const dur = len / sr
  while (t < dur) {
    const s = Math.floor(t * sr)
    const note = BELL_NOTES[r.int(BELL_NOTES.length)]
    const f0 = hzOfMidi(note)
    const a0 = 0.5 + 0.5 * r.next()
    const pan = 0.1 + 0.8 * r.next()
    const gl = Math.cos(pan * 0.5 * Math.PI)
    const gr = Math.sin(pan * 0.5 * Math.PI)
    const tscale = Math.pow(440 / f0, 0.3)
    for (let p = 0; p < BELL_RATIOS.length; p++) {
      const f = f0 * BELL_RATIOS[p] * (1 + 0.003 * (r.next() * 2 - 1))
      if (f >= nyq) continue
      const tau = BELL_TAUS[p] * tscale
      const rd = Math.exp(-1 / (tau * sr))
      const w = (2 * Math.PI * f) / sr
      const mc = rd * Math.cos(w)
      const ms = rd * Math.sin(w)
      const ph = r.next() * 2 * Math.PI
      let zr = a0 * BELL_AMPS[p] * Math.cos(ph)
      let zi = a0 * BELL_AMPS[p] * Math.sin(ph)
      const maxN = Math.min(len - s, Math.round(Math.min(3, tau * 5.8) * sr))
      for (let q = 0; q < maxN; q++) {
        const i = s + q
        L[i] += zr * gl
        R[i] += zr * gr
        const nr = zr * mc - zi * ms
        zi = zr * ms + zi * mc
        zr = nr
      }
    }
    // strike click
    const ck = Math.min(len, s + Math.round(0.003 * sr))
    const bq = new Biquad('bandpass', sr, Math.min(3200, nyq), 1.5)
    for (let i = s; i < ck; i++) {
      const v = bq.tick((r.next() * 2 - 1) * Math.exp(-(i - s) / (0.0006 * sr))) * a0 * 0.6
      L[i] += v * gl
      R[i] += v * gr
    }
    t += 0.2 + 0.28 * r.next()
  }
  return normalizePair(L, R)
}

const GENERATORS = { wind, rain, fire, engine, ocean, crowd, pad, organ, bells }

/** [L, R] Float32Arrays of a built-in carrier, `len` samples at sr, RMS 0.1. */
export function makeCarrier(name, len, sr, rng) {
  const n = Math.max(0, len | 0)
  if (n === 0) return [new Float32Array(0), new Float32Array(0)]
  const gen = GENERATORS[name] || wind
  return gen(n, sr, rng.fork('carrier-' + (GENERATORS[name] ? name : 'wind')))
}
