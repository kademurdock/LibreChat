// beds/wolves-far.js - Wolves howling far off across a valley at night, and the harmonic voice engine.
//
// A howl is a nearly pure gliding tone: it rises in the first half second,
// holds with a slow drift and a little vibrato, sometimes breaks upward, and
// falls away at the end; packs howl in chorus and avoid each other's pitch
// (Harrington and Mech, "Wolf howling and its role in territory
// maintenance", Behaviour 1979; Theberge and Falls, "Howling as a means of
// communication in timber wolves", American Zoologist 1967). Pups add short
// rising "yips".
//
// harmonicVoice() is a sinusoidal source-filter voice used here and by the
// farm, harbor and mountain beds: a harmonic series whose fundamental follows
// a breakpoint contour (smoothed in log frequency, plus slow jitter and
// delayed vibrato), each harmonic weighted by a spectral tilt and by a
// formant envelope (a sum of resonance curves, optionally morphing between
// two vowel shapes over time), normalised to a steady loudness, with
// period-doubling roughness (amplitude modulation at half the pitch, the
// subharmonic "rasp" of rough animal voices; see Wilden, Herzel and
// colleagues, "Subharmonics, biphonation, and deterministic chaos in mammal
// vocalization", Bioacoustics 1998) and a breath noise. The harmonics come
// from one rotating phasor through the Chebyshev recursion
// sin(k+1)x = 2 cos x sin kx - sin(k-1)x, so a rich voice costs a few
// multiply-adds per harmonic per sample.
//
// The bed puts the pack hundreds of meters away: little direct sound,
// strong valley reverb and long echoes off the far slopes (SPACES.valley),
// over a cold night wind.

import { makeRng } from '../core/rng.js'
import { resolveParams } from '../core/params.js'
import { makeScene, emit, addAir, finishScene, SPACES, clamp, smoothNoise } from './forest-birds.js'
import { addCrickets } from './night-crickets.js'

const TAU = Math.PI * 2

function R(rng, a, b) {
  return a + (b - a) * rng.next()
}

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

// Breakpoint curve [[t, v], ...] read at time t, cosine-smoothed between points.
function bp(points, t, logv) {
  if (!points || !points.length) return 0
  if (t <= points[0][0]) return points[0][1]
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i]
    if (t <= t1) {
      const [t0, v0] = points[i - 1]
      const u = t1 > t0 ? (t - t0) / (t1 - t0) : 1
      const s = 0.5 - 0.5 * Math.cos(Math.PI * u)
      if (logv) return v0 * Math.pow(v1 / v0, s)
      return v0 + (v1 - v0) * s
    }
  }
  return points[points.length - 1][1]
}

function formantGain(f, fm) {
  let g = 0.015
  for (let i = 0; i < fm.length; i++) {
    const F = fm[i][0]
    const hb = Math.max(20, fm[i][1] * 0.5)
    const x = (f - F) / hb
    g += Math.pow(10, num(fm[i][2], 0) / 20) / (1 + x * x)
  }
  return g
}

/**
 * Harmonic source-filter voice. spec: { dur, f: [[t, hz]...], amp: [[t, a]...],
 * formants: [[hz, bandwidth, dB]...], formants2, morph: [[t, 0..1]...],
 * tilt (dB per octave, negative), nh (max harmonics), jitter (cents),
 * vibR (Hz), vibC (cents), vibOn (s), rough (0..1), breath (0..1), gain }.
 * Returns a Float32Array of dur seconds (plus a few ms).
 */
export function harmonicVoice(sr, rng, spec) {
  const dur = Math.max(0.02, num(spec.dur, 1))
  const len = Math.ceil((dur + 0.01) * sr)
  const out = new Float32Array(len)
  const K = Math.max(1, Math.min(40, Math.round(num(spec.nh, 16))))
  const lim = 0.45 * sr
  const tilt = num(spec.tilt, -6) / 6.0206
  const fm1 = spec.formants || [[800, 400, 0]]
  const fm2 = spec.formants2 || null
  const jit = num(spec.jitter, 0)
  const vibR = num(spec.vibR, 0)
  const vibC = num(spec.vibC, 0)
  const vibOn = num(spec.vibOn, 0)
  const rough = clamp(num(spec.rough, 0), 0, 1)
  const breath = clamp(num(spec.breath, 0), 0, 1)
  const gain = num(spec.gain, 1)
  const B = 16
  const nb = Math.ceil(len / B) + 2
  const jn = jit > 0 ? smoothNoise(nb, B / sr, 0.035, rng) : null
  const jn2 = jit > 0 ? smoothNoise(nb, B / sr, 0.25, rng) : null
  const aPrev = new Float64Array(K + 1)
  const aNext = new Float64Array(K + 1)
  const da = new Float64Array(K + 1)
  const fmTmp = fm2 ? fm1.map((x) => x.slice()) : fm1
  let ph = rng.next() * TAU
  let re = Math.cos(ph)
  let im = Math.sin(ph)
  let hre = Math.cos(ph * 0.5)
  let him = Math.sin(ph * 0.5)
  let first = true
  let nz1 = 0
  let nz2 = 0
  const c1n = 1 - Math.exp((-TAU * 300) / sr)
  const c2n = 1 - Math.exp((-TAU * Math.min(lim, 3500)) / sr)
  let breathA = 0
  for (let b = 0, j = 0; b < len; b += B, j++) {
    const e = b + B < len ? b + B : len
    const t = (b + B * 0.5) / sr
    let f = Math.max(20, bp(spec.f, t, true))
    let cents = 0
    if (jn) cents += jit * (0.7 * jn[j] + 0.5 * jn2[j])
    if (vibC > 0 && t > vibOn) cents += vibC * Math.min(1, (t - vibOn) / 0.4) * Math.sin(TAU * vibR * t)
    f *= Math.pow(2, cents / 1200)
    const amp = Math.max(0, bp(spec.amp, t, false)) * gain
    let fm = fm1
    if (fm2) {
      const m = clamp(bp(spec.morph, t, false), 0, 1)
      for (let i = 0; i < fmTmp.length; i++) {
        const a = fm1[i]
        const z = fm2[i] || a
        fmTmp[i][0] = a[0] + (z[0] - a[0]) * m
        fmTmp[i][1] = a[1] + (z[1] - a[1]) * m
        fmTmp[i][2] = num(a[2], 0) + (num(z[2], 0) - num(a[2], 0)) * m
      }
      fm = fmTmp
    }
    let ss = 0
    for (let k = 1; k <= K; k++) {
      const fk = k * f
      let a = 0
      if (fk < lim) a = Math.pow(k, tilt) * formantGain(fk, fm)
      aNext[k] = a
      ss += a * a
    }
    const norm = ss > 0 ? amp / Math.sqrt(ss) : 0
    for (let k = 1; k <= K; k++) {
      aNext[k] *= norm
      if (first) aPrev[k] = aNext[k]
      da[k] = (aNext[k] - aPrev[k]) / (e - b)
    }
    first = false
    const w = (TAU * f) / sr
    const cr = Math.cos(w)
    const ci = Math.sin(w)
    const hcr = Math.cos(w * 0.5)
    const hci = Math.sin(w * 0.5)
    const bA = breath * amp
    const dB = (bA - breathA) / (e - b)
    for (let i = b; i < e; i++) {
      const nre = re * cr - im * ci
      im = re * ci + im * cr
      re = nre
      const hre2 = hre * hcr - him * hci
      him = hre * hci + him * hcr
      hre = hre2
      const c2 = 2 * re
      let sPrev = 0
      let sCur = im
      let y = 0
      for (let k = 1; k <= K; k++) {
        aPrev[k] += da[k]
        y += aPrev[k] * sCur
        const sN = c2 * sCur - sPrev
        sPrev = sCur
        sCur = sN
      }
      if (rough > 0) y *= 1 + rough * him
      if (breath > 0) {
        const wn = rng.next() * 2 - 1
        nz1 += c1n * (wn - nz1)
        nz2 += c2n * (wn - nz1 - nz2)
        breathA += dB
        y += nz2 * breathA * 1.5
      }
      out[i] = y
    }
    breathA = bA
    const mag = re * re + im * im
    const fix = (3 - mag) * 0.5
    re *= fix
    im *= fix
    const hmag = hre * hre + him * him
    const hfix = (3 - hmag) * 0.5
    hre *= hfix
    him *= hfix
    // keep the half-rate phasor locked to the full one (it can drift by rounding)
    if ((j & 63) === 0) {
      const hp = Math.atan2(him, hre)
      const fp = Math.atan2(im, re)
      let d = fp - 2 * hp
      d -= TAU * Math.round(d / TAU)
      if (Math.abs(d) > 1e-3) {
        const np = hp + d * 0.5
        hre = Math.cos(np)
        him = Math.sin(np)
      }
    }
  }
  return out
}

/** One wolf howl. v: { f0, bright }. */
export function howl(sr, rng, v) {
  const f0 = v.f0 * R(rng, 0.94, 1.06)
  const dur = R(rng, 3, 6.5)
  const rise = R(rng, 0.35, 0.7)
  const f = [[0, f0 * R(rng, 0.66, 0.78)], [rise, f0 * R(rng, 0.97, 1.03)]]
  const tf = dur - R(rng, 0.6, 1.1)
  // the held part wanders: two or three slow turns, sometimes a break upward
  const turns = 2 + rng.int(2)
  let level = 1
  for (let k = 1; k <= turns; k++) {
    const tk = rise + ((tf - rise) * k) / (turns + 1)
    if (k === 2 && rng.next() < 0.3) {
      f.push([tk, f0 * level], [tk + 0.07, f0 * level * R(rng, 1.08, 1.16)])
      level *= 1.1
    } else {
      level *= R(rng, 0.95, 1.06)
      f.push([tk, f0 * level])
    }
  }
  f.push([tf, f0 * level * R(rng, 0.96, 1.01)], [dur, f0 * R(rng, 0.58, 0.72)])
  return harmonicVoice(sr, rng, {
    dur,
    f,
    amp: [[0, 0], [0.25, 0.6], [rise + 0.3, 1], [tf, 0.9], [dur, 0]],
    formants: [[R(rng, 450, 600), 600, 0], [1600, 700, -12]],
    tilt: -12 + num(v.bright, 0) * 3,
    nh: 8,
    jitter: 7,
    vibR: R(rng, 4, 6),
    vibC: R(rng, 6, 16),
    vibOn: rise + 0.5,
    rough: 0.03,
    breath: 0.05,
  })
}

/** A short rising yip. */
export function yip(sr, rng, f0) {
  const d = R(rng, 0.1, 0.22)
  return harmonicVoice(sr, rng, {
    dur: d,
    f: [[0, f0 * 0.8], [d * 0.4, f0 * 1.3], [d, f0 * 0.95]],
    amp: [[0, 0], [0.02, 1], [d * 0.7, 0.8], [d, 0]],
    formants: [[900, 500, 0], [1800, 600, -6]],
    tilt: -6,
    nh: 10,
    jitter: 20,
    rough: 0.15,
    breath: 0.1,
  })
}

/**
 * A pack howling in choruses. o: { pack (wolves), dist (m), choruses
 * (0..1, how much of the time they howl), yips (bool), gain, send, center }.
 */
export function addPack(sc, rng, o = {}) {
  const sr = sc.sr
  const pack = Math.max(1, Math.round(num(o.pack, 4)))
  const dist = Math.max(30, num(o.dist, 700))
  const busy = clamp(num(o.choruses, 0.5), 0, 1)
  if (!(busy > 0)) return
  const center = num(o.center, R(rng, -0.5, 0.5))
  const wolves = []
  for (let k = 0; k < pack; k++) {
    const r = rng.fork('wolf' + k)
    // spread pitches: they avoid each other's note
    const f0 = 330 + ((k * 0.618) % 1) * 300 + R(r, -20, 20)
    wolves.push({ r, f0, pan: clamp(center + R(r, -0.25, 0.25), -0.95, 0.95), dist: dist * R(r, 0.9, 1.12), bright: R(r, -0.5, 1) })
  }
  const cr = rng.fork('choruses')
  // a lone howl, an answer, the chorus building, then quiet
  let t = R(cr, 0.4, 2.2)
  while (t < sc.dur) {
    const len = R(cr, 9, 18) * (0.7 + 0.6 * busy)
    const order = wolves.map((w, i) => i)
    for (let i = order.length - 1; i > 0; i--) {
      const j = cr.int(i + 1)
      const x = order[i]
      order[i] = order[j]
      order[j] = x
    }
    let join = t
    order.forEach((wi, n) => {
      const w = wolves[wi]
      if (n === 1) join = t + R(w.r, 3.5, 6)
      else if (n > 1) join += R(w.r, 0.6, 2.5)
      let tt = join
      const end = t + len + (n === 0 ? 2 : 0)
      while (tt < end) {
        const ev = howl(sr, w.r, w)
        emit(sc, ev, tt * sr, w.pan, w.dist, num(o.gain, 1) * R(w.r, 0.8, 1.1), num(o.send, 0.7))
        tt += ev.length / sr + (n === 0 && tt < t + 5 ? R(w.r, 1.5, 3) : R(w.r, 0.4, 2.2))
      }
    })
    if (o.yips !== false && pack > 1) {
      const yr = rng.fork('yips' + Math.round(t * 10))
      let ty = t + R(yr, 5, 8)
      while (ty < t + len - 1) {
        const k = 2 + yr.int(5)
        for (let i = 0; i < k; i++) {
          const ev = yip(sr, yr, R(yr, 650, 950))
          emit(sc, ev, (ty + i * R(yr, 0.15, 0.3)) * sr, clamp(center + R(yr, -0.3, 0.3), -1, 1), dist * R(yr, 0.9, 1.1), num(o.gain, 1) * 0.55, num(o.send, 0.7))
        }
        ty += R(yr, 2.5, 7)
      }
    }
    t += len + R(cr, 10, 30) * (1.5 - busy)
  }
}

// ---------------------------------------------------------------- the bed

const bed = {
  id: 'wolves-far',
  name: 'Wolves far off',
  group: 'nature',
  about: 'A cold night: a wolf pack howling across the valley, echoing off the far hills, wind in the dark.',
  params: [
    { id: 'intensity', name: 'Howling', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent' },
    { id: 'distance', name: 'How far away', type: 'number', min: 150, max: 3000, step: 50, def: 700, unit: 'meters' },
    { id: 'pack', name: 'Pack size', type: 'number', min: 1, max: 8, step: 1, def: 4, unit: 'count', noun: ['wolf', 'wolves'] },
    { id: 'yips', name: 'Pups yipping', type: 'bool', def: true },
    { id: 'wind', name: 'Night wind', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent' },
    { id: 'insects', name: 'Night insects', type: 'number', min: 0, max: 100, step: 1, def: 10, unit: 'percent' },
  ],
  generate(seconds, sr, p, rng) {
    const q = resolveParams(bed, p || {})
    const r = rng || makeRng('wolves-far')
    const sc = makeScene(seconds, sr, r)
    if (!sc.n) return { sr: sc.sr, ch: [sc.L, sc.R] }
    const I = q.intensity / 100
    addAir(sc, { hushDb: -60, wind: 0.04 + 0.9 * (q.wind / 100), gust: 0.7, body: 380, foliage: 0.3, foliageHz: 4200, rustle: 0.1, rumble: 0.3, gustPeriod: 11 }, r.fork('air'))
    if (I > 0) addPack(sc, r.fork('pack'), { pack: q.pack, dist: q.distance, choruses: I, yips: q.yips, gain: 7, send: 0.75 })
    const ins = q.insects / 100
    if (ins > 0) addCrickets(sc, r.fork('crickets'), { count: Math.round(ins * 10), dist: 12, warmth: 0.15, kind: 'field', gain: 0.25, send: 0.4 })
    return finishScene(sc, SPACES.valley, r.fork('space'), -8.5)
  },
}

export default bed
