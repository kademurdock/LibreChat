// beds/forest-birds.js - Forest birds, and the outdoor kit every nature bed shares.
//
// The bed: a leafy or piney wood in spring. Several individual birds, each a
// "species-like" voice with its own small repertoire of song types, sit at
// their own distance and direction and sing in bouts: a bird repeats one song
// type a few times, then switches (the "eventual variety" singing described
// for many songbirds by Hartshorne and later by Catchpole and Slater, "Bird
// Song: Biological Themes and Variations", 2008). Neighbours of one kind keep
// out of each other's way (counter-singing), so songs answer instead of
// piling up. Contact chips, a far dove and an occasional woodpecker drum fill
// the gaps, over a breathing wind in the trees.
//
// Song synthesis: every note is a sine sweep with a curved log-frequency
// contour (start, end, an arch in octaves), optional fast frequency
// modulation (trills and burrs), amplitude modulation (buzzy notes) and the
// first three overtones at small levels, which is how birdsong spectrograms
// look: nearly pure whistles that move fast (Mindlin and Laje, "The Physics
// of Birdsong", 2005; the practical recipes in Andy Farnell, "Designing
// Sound", MIT Press 2010, chapter on birds). The oscillator is a rotating
// phasor whose step is recomputed every 8 samples, so a long dawn chorus
// costs little.
//
// The kit (named exports used by the other nature beds):
// - makeScene / emit / emitPath: a stereo scene with a reverb send. emit()
//   places a mono event at a distance and direction: inverse-distance level,
//   air and ground absorption as two one-pole low passes whose corner falls
//   with distance (after the ISO 9613-1 trend that highs die first), an
//   equal-power pan with a small interaural delay, and a reverb send that
//   falls only 3 dB per doubling of distance (the direct sound falls 6 dB),
//   so far sources come out "mostly room" as they do outdoors.
// - finishScene: a feedback delay network reverb (Jot and Chaigne 1991, with
//   an 8 x 8 Hadamard feedback matrix as in J. O. Smith, "Physical Audio Signal
//   Processing"), two Schroeder allpass diffusers, a cloud of early
//   scattering taps (tree trunks) and optional long discrete echoes (valley
//   walls), then a safety limiter.
// - addAir: the place's air: a quiet pink hush (never digital silence), a
//   wind body whose low-pass corner and level follow a slow gust curve, a
//   foliage hiss, and leaf-rustle grains (Poisson noise bursts whose rate
//   rises with the gusts). The gust curve is kept on the scene so other
//   layers (halyards, rustles) can follow the same wind.
// - renderNote / renderNotes / runSingers / SPECIES: the bird engine.
//
// No recordings anywhere: everything is synthesis driven by the seeded rng.

import { makeRng } from '../core/rng.js'
import { resolveParams } from '../core/params.js'
import { limitBuf } from '../core/dyn.js'

const TAU = Math.PI * 2
const REF_DIST = 10
const TINY = 1e-20

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

// ---------------------------------------------------------------- scene

/** A stereo scene of exactly `seconds` at sr, with a mono reverb send. */
export function makeScene(seconds, sr, rng) {
  let rate = Number(sr)
  if (!(rate > 0) || !Number.isFinite(rate)) rate = 48000
  const s = Number(seconds)
  const n = s > 0 && Number.isFinite(s) ? Math.round(s * rate) : 0
  return {
    sr: rate,
    n,
    dur: n / rate,
    L: new Float32Array(n),
    R: new Float32Array(n),
    S: new Float32Array(n),
    rng: rng || makeRng('scene'),
    gust: null,
    gustStep: 32,
  }
}

/** The gust value (0..1) at a time in seconds (0.5 when the scene has no air). */
export function gustAt(sc, t) {
  const g = sc.gust
  if (!g) return 0.5
  let j = Math.floor((t * sc.sr) / sc.gustStep)
  if (j < 0) j = 0
  if (j >= g.length) j = g.length - 1
  return g[j]
}

function airCoef(sr, dist) {
  const fc = Math.min(0.45 * sr, 18000 / (1 + dist / 60))
  const g = Math.tan((Math.PI * fc) / sr)
  return g / (1 + g)
}

/**
 * Place a mono event in the scene. start in samples (may be negative: the
 * event began before the bed), pan -1..1, dist in meters, gain is the level
 * at 10 m, send is the reverb send (independent of distance). sig is
 * filtered in place.
 */
export function emit(sc, sig, start, pan, dist, gain, send) {
  const n = sc.n
  const len = sig.length
  const s0 = Math.round(start)
  if (!len || s0 >= n || s0 + len <= 0 || !(gain > 0)) return
  const d = dist > 0.25 ? dist : 0.25
  const G = airCoef(sc.sr, d)
  let z1 = 0
  let z2 = 0
  for (let i = 0; i < len; i++) {
    const x = sig[i]
    const v1 = (x - z1) * G
    const y1 = v1 + z1
    z1 = y1 + v1
    const v2 = (y1 - z2) * G
    const y2 = v2 + z2
    z2 = y2 + v2
    sig[i] = y2
  }
  const p = clamp(num(pan, 0), -1, 1)
  const dirG = gain * Math.min(4, REF_DIST / d)
  const a = ((p + 1) * Math.PI) / 4
  const gl = Math.cos(a) * dirG
  const gr = Math.sin(a) * dirG
  const itd = Math.round(Math.abs(p) * 0.00065 * sc.sr)
  const dl = p > 0 ? itd : 0
  const dr = p < 0 ? itd : 0
  mixLane(sc.L, sig, s0 + dl, gl)
  mixLane(sc.R, sig, s0 + dr, gr)
  if (send > 0) mixLane(sc.S, sig, s0, gain * send * wetDist(d))
}

// The reverberant part also weakens with distance, but only about 3 dB per
// doubling against the direct sound's 6 dB, so far sources end up mostly room.
function wetDist(d) {
  return Math.sqrt(Math.min(4, REF_DIST / d))
}

function mixLane(dst, src, off, g) {
  const n = dst.length
  let i0 = 0
  if (off < 0) i0 = -off
  const iEnd = Math.min(src.length, n - off)
  for (let i = i0; i < iEnd; i++) dst[i + off] += src[i] * g
}

/**
 * Place a moving mono event. path(tSeconds, o) must set o.pan and o.dist
 * (it is called every 64 samples with t measured from the event start).
 * Doppler belongs in the synthesis; this moves level, colour and side.
 */
export function emitPath(sc, sig, start, path, gain, send) {
  const n = sc.n
  const len = sig.length
  const s0 = Math.round(start)
  if (!len || s0 >= n || s0 + len <= 0 || !(gain > 0)) return
  const sr = sc.sr
  const B = 64
  const o = { pan: 0, dist: 10 }
  let z1 = 0
  let z2 = 0
  path(0, o)
  let pgl = 0
  let pgr = 0
  {
    const d = o.dist > 0.25 ? o.dist : 0.25
    const a = ((clamp(o.pan, -1, 1) + 1) * Math.PI) / 4
    const dg = gain * Math.min(4, REF_DIST / d)
    pgl = Math.cos(a) * dg
    pgr = Math.sin(a) * dg
  }
  const L = sc.L
  const R = sc.R
  const S = sc.S
  const wet0 = gain * (send > 0 ? send : 0)
  for (let b = 0; b < len; b += B) {
    const e = b + B < len ? b + B : len
    path(e / sr, o)
    const d = o.dist > 0.25 ? o.dist : 0.25
    const G = airCoef(sr, d)
    const a = ((clamp(num(o.pan, 0), -1, 1) + 1) * Math.PI) / 4
    const dg = gain * Math.min(4, REF_DIST / d)
    const ngl = Math.cos(a) * dg
    const ngr = Math.sin(a) * dg
    const wet = wet0 * wetDist(d)
    const inv = 1 / (e - b)
    for (let i = b; i < e; i++) {
      const x = sig[i]
      const v1 = (x - z1) * G
      const y1 = v1 + z1
      z1 = y1 + v1
      const v2 = (y1 - z2) * G
      const y = v2 + z2
      z2 = y + v2
      const k = s0 + i
      if (k >= 0 && k < n) {
        const f = (i - b) * inv
        L[k] += y * (pgl + (ngl - pgl) * f)
        R[k] += y * (pgr + (ngr - pgr) * f)
        S[k] += y * wet
      }
    }
    pgl = ngl
    pgr = ngr
  }
}

// ---------------------------------------------------------------- space

// Named outdoor spaces. rt60 seconds, damp 0..1 (high loss in the tail),
// size scales the delay lengths, early = number of scattering taps spread
// over earlyMs, wet = tail level, echoes = [[seconds, gain, pan, lowpassHz]].
export const SPACES = {
  forest: { rt60: 1.3, damp: 0.5, size: 1.0, predelayMs: 14, early: 12, earlyMs: 160, earlyGain: 0.3, wet: 0.36, lowCut: 160 },
  pines: { rt60: 1.5, damp: 0.42, size: 1.1, predelayMs: 16, early: 12, earlyMs: 190, earlyGain: 0.28, wet: 0.38, lowCut: 160 },
  jungle: { rt60: 1.9, damp: 0.5, size: 1.15, predelayMs: 10, early: 14, earlyMs: 140, earlyGain: 0.34, wet: 0.65, lowCut: 140 },
  night: { rt60: 1.7, damp: 0.55, size: 1.1, predelayMs: 18, early: 10, earlyMs: 200, earlyGain: 0.28, wet: 0.5, lowCut: 150 },
  field: { rt60: 0.7, damp: 0.7, size: 0.8, predelayMs: 6, early: 4, earlyMs: 40, earlyGain: 0.15, wet: 0.18, lowCut: 200, echoes: [[0.42, 0.06, -0.5, 2500]] },
  meadow: { rt60: 0.9, damp: 0.65, size: 0.9, predelayMs: 8, early: 5, earlyMs: 60, earlyGain: 0.16, wet: 0.24, lowCut: 180, echoes: [[0.55, 0.07, 0.6, 2200], [0.9, 0.04, -0.4, 1600]] },
  swamp: { rt60: 1.4, damp: 0.6, size: 1.0, predelayMs: 10, early: 10, earlyMs: 120, earlyGain: 0.3, wet: 0.5, lowCut: 100 },
  pond: { rt60: 1.2, damp: 0.55, size: 0.95, predelayMs: 8, early: 8, earlyMs: 90, earlyGain: 0.3, wet: 0.42, lowCut: 120 },
  harbor: { rt60: 1.3, damp: 0.45, size: 1.2, predelayMs: 20, early: 8, earlyMs: 220, earlyGain: 0.3, wet: 0.4, lowCut: 120, echoes: [[0.32, 0.12, 0.7, 4000], [0.61, 0.07, -0.6, 3000]] },
  valley: { rt60: 2.6, damp: 0.6, size: 1.6, predelayMs: 40, early: 6, earlyMs: 300, earlyGain: 0.2, wet: 0.5, lowCut: 120, echoes: [[0.9, 0.22, 0.55, 2200], [1.55, 0.14, -0.6, 1700], [2.3, 0.08, 0.2, 1200]] },
  summit: { rt60: 1.2, damp: 0.7, size: 1.4, predelayMs: 30, early: 3, earlyMs: 120, earlyGain: 0.1, wet: 0.22, lowCut: 160, echoes: [[1.3, 0.2, -0.6, 2600], [2.1, 0.13, 0.65, 1900], [3.2, 0.07, -0.2, 1300]] },
  farmyard: { rt60: 0.9, damp: 0.5, size: 0.9, predelayMs: 6, early: 6, earlyMs: 90, earlyGain: 0.3, wet: 0.3, lowCut: 140, echoes: [[0.075, 0.18, 0.5, 5000], [0.16, 0.08, -0.4, 3500]] },
  hive: { rt60: 0.6, damp: 0.5, size: 0.5, predelayMs: 2, early: 6, earlyMs: 25, earlyGain: 0.3, wet: 0.3, lowCut: 90 },
}

const FDN_BASE = [1009, 1201, 1427, 1663, 1907, 2161, 2437, 2711]
const IN_SIGN = [1, -1, 1, 1, -1, 1, -1, -1]

function pow2Above(n) {
  let p = 16
  while (p < n) p <<= 1
  return p
}

/** Render the reverb of the send S into L and R (added). */
export function renderSpace(S, sr, spec, rng, L, R) {
  const n = S.length
  const wet = num(spec && spec.wet, 0)
  if (!n || !(wet > 0)) return
  const r = rng || makeRng('space')
  const k48 = sr / 48000
  const size = clamp(num(spec.size, 1), 0.2, 3)
  const rt = clamp(num(spec.rt60, 1.2), 0.1, 12)
  const pre = Math.max(1, Math.round((num(spec.predelayMs, 10) * sr) / 1000))
  const E = Math.max(0, Math.min(24, Math.round(num(spec.early, 8))))
  const eMs = Math.max(5, num(spec.earlyMs, 100))
  const eGain = num(spec.earlyGain, 0.3)
  const echoes = Array.isArray(spec.echoes) ? spec.echoes : []
  // early scattering taps: random times, decaying, alternating sides
  const eD = new Int32Array(E)
  const eL = new Float32Array(E)
  const eR = new Float32Array(E)
  for (let k = 0; k < E; k++) {
    const u = (k + r.next()) / Math.max(1, E)
    const ms = 3 + eMs * u * u
    eD[k] = pre + Math.round((ms * sr) / 1000)
    const g = eGain * Math.pow(0.82, k) * (0.6 + 0.4 * r.next()) * (r.next() < 0.5 ? -1 : 1)
    const pan = clamp((k % 2 ? 1 : -1) * (0.3 + 0.7 * r.next()), -1, 1)
    const a = ((pan + 1) * Math.PI) / 4
    eL[k] = g * Math.cos(a)
    eR[k] = g * Math.sin(a)
  }
  const X = Math.min(8, echoes.length)
  const xD = new Int32Array(X)
  const xL = new Float32Array(X)
  const xR = new Float32Array(X)
  const xC = new Float64Array(X)
  const xS = new Float64Array(X)
  for (let k = 0; k < X; k++) {
    const e = echoes[k]
    xD[k] = Math.max(1, Math.round(num(e[0], 0.5) * sr))
    const g = num(e[1], 0.1)
    const pan = clamp(num(e[2], 0), -1, 1)
    const a = ((pan + 1) * Math.PI) / 4
    xL[k] = g * Math.cos(a)
    xR[k] = g * Math.sin(a)
    const fc = Math.min(0.45 * sr, Math.max(100, num(e[3], 3000)))
    xC[k] = 1 - Math.exp((-TAU * fc) / sr)
  }
  let maxD = pre + 2
  for (let k = 0; k < E; k++) if (eD[k] > maxD) maxD = eD[k]
  for (let k = 0; k < X; k++) if (xD[k] > maxD) maxD = xD[k]
  const RS = pow2Above(maxD + 2)
  const RM = RS - 1
  const ring = new Float32Array(RS)
  // two allpass diffusers
  const a1n = Math.max(2, Math.round(142 * size * k48))
  const a2n = Math.max(2, Math.round(379 * size * k48))
  const ap1 = new Float32Array(a1n)
  const ap2 = new Float32Array(a2n)
  let ap1i = 0
  let ap2i = 0
  const apg = 0.62
  // eight delay lines in one block
  const lens = new Int32Array(8)
  const offs = new Int32Array(8)
  let tot = 0
  for (let k = 0; k < 8; k++) {
    lens[k] = Math.max(8, Math.round(FDN_BASE[k] * size * k48 * (0.97 + 0.06 * r.next())))
    offs[k] = tot
    tot += lens[k]
  }
  const lines = new Float32Array(tot)
  const pos = new Int32Array(8)
  const fbg = new Float64Array(8)
  let gm = 0
  for (let k = 0; k < 8; k++) {
    fbg[k] = Math.pow(10, (-3 * lens[k]) / (sr * rt))
    gm += fbg[k] / 8
  }
  const damp = clamp(num(spec.damp, 0.5), 0, 0.95)
  const dfc = Math.min(0.45 * sr, 16000 * (1 - damp) + 900)
  const dc = 1 - Math.exp((-TAU * dfc) / sr)
  const lp = new Float64Array(8)
  const v = new Float64Array(8)
  const hh = new Float64Array(8)
  const norm = wet * Math.sqrt(Math.max(0.02, 1 - gm * gm)) * 0.9
  const lowCut = Math.max(20, num(spec.lowCut, 120))
  const hc = 1 - Math.exp((-TAU * lowCut) / sr)
  let hs = 0
  let w = 0
  const h8 = 1 / Math.sqrt(8)
  for (let i = 0; i < n; i++) {
    let x = S[i]
    hs += hc * (x - hs)
    x -= hs
    ring[w] = x
    let oL = 0
    let oR = 0
    for (let k = 0; k < E; k++) {
      const s = ring[(w - eD[k]) & RM]
      oL += s * eL[k]
      oR += s * eR[k]
    }
    for (let k = 0; k < X; k++) {
      const s = ring[(w - xD[k]) & RM]
      let st = xS[k] + xC[k] * (s - xS[k])
      if (st < TINY && st > -TINY) st = 0
      xS[k] = st
      oL += st * xL[k]
      oR += st * xR[k]
    }
    let u = ring[(w - pre) & RM] * 0.7 + (oL + oR) * 0.3
    // diffusers
    let b1 = ap1[ap1i]
    let t1 = u + apg * b1
    ap1[ap1i] = t1
    u = b1 - apg * t1
    if (++ap1i >= a1n) ap1i = 0
    const b2 = ap2[ap2i]
    const t2 = u + apg * b2
    ap2[ap2i] = t2
    u = b2 - apg * t2
    if (++ap2i >= a2n) ap2i = 0
    // read lines
    for (let k = 0; k < 8; k++) v[k] = lines[offs[k] + pos[k]]
    // fast Walsh-Hadamard transform, 8 points
    const s0 = v[0] + v[1], d0 = v[0] - v[1]
    const s1 = v[2] + v[3], d1 = v[2] - v[3]
    const s2 = v[4] + v[5], d2 = v[4] - v[5]
    const s3 = v[6] + v[7], d3 = v[6] - v[7]
    const q0 = s0 + s1, q1 = d0 + d1, q2 = s0 - s1, q3 = d0 - d1
    const q4 = s2 + s3, q5 = d2 + d3, q6 = s2 - s3, q7 = d2 - d3
    hh[0] = (q0 + q4) * h8
    hh[1] = (q1 + q5) * h8
    hh[2] = (q2 + q6) * h8
    hh[3] = (q3 + q7) * h8
    hh[4] = (q0 - q4) * h8
    hh[5] = (q1 - q5) * h8
    hh[6] = (q2 - q6) * h8
    hh[7] = (q3 - q7) * h8
    oL += (v[0] - v[1] + v[2] - v[3] + v[4] - v[5] + v[6] - v[7]) * norm
    oR += (v[0] + v[1] - v[2] - v[3] + v[4] + v[5] - v[6] - v[7]) * norm
    for (let k = 0; k < 8; k++) {
      let l = lp[k] + dc * (hh[k] - lp[k])
      if (l < TINY && l > -TINY) l = 0
      lp[k] = l
      lines[offs[k] + pos[k]] = l * fbg[k] + u * IN_SIGN[k] * 0.5
      if (++pos[k] >= lens[k]) pos[k] = 0
    }
    L[i] += oL * wet
    R[i] += oR * wet
    w = (w + 1) & RM
  }
}

/**
 * Mix the reverb in, trim the whole scene by trimDb, clean up and limit.
 * Returns the bed buffer { sr, ch: [L, R] }. Beds are trimmed to sit around
 * -24 LUFS at their defaults, with peaks well under full scale.
 */
export function finishScene(sc, spec, rng, trimDb = -10) {
  const { L, R, S, sr, n } = sc
  if (n && spec) renderSpace(S, sr, spec, rng || sc.rng.fork('space'), L, R)
  const tg = Math.pow(10, num(trimDb, 0) / 20)
  let pk = 0
  for (let i = 0; i < n; i++) {
    let a = L[i] * tg
    let b = R[i] * tg
    L[i] = a
    R[i] = b
    if (!(a > -1e30 && a < 1e30)) a = L[i] = 0
    if (!(b > -1e30 && b < 1e30)) b = R[i] = 0
    if (a < 0) a = -a
    if (b < 0) b = -b
    if (a > pk) pk = a
    if (b > pk) pk = b
  }
  const out = { sr, ch: [L, R] }
  if (pk > 0.89) limitBuf(out, { ceilingDb: -1.2, lookaheadMs: 4, releaseMs: 120, truePeak: false })
  sc.S = null
  return out
}

// ---------------------------------------------------------------- slow curves

/** Smooth random wander in -1..1 at m points dt apart, knots about `period` s apart. */
export function smoothNoise(m, dt, period, rng) {
  const out = new Float32Array(Math.max(0, m))
  const per = Math.max(dt * 2, period)
  let a = rng.next() * 2 - 1
  let b = rng.next() * 2 - 1
  let seg = per * (0.5 + rng.next())
  let pos = rng.next() * seg
  for (let j = 0; j < out.length; j++) {
    while (pos >= seg) {
      pos -= seg
      a = b
      b = rng.next() * 2 - 1
      seg = per * (0.5 + rng.next())
    }
    const s = 0.5 - 0.5 * Math.cos((Math.PI * pos) / seg)
    out[j] = a + (b - a) * s
    pos += dt
  }
  return out
}

/**
 * Activity curve 0.2..1.6 over the scene (chorus waves): returns a function
 * of time in seconds. Singers divide their pauses by it.
 */
export function activityCurve(sc, rng, depth = 0.5) {
  const dt = 0.25
  const m = Math.ceil(sc.dur / dt) + 4
  const c = smoothNoise(m, dt, 14, rng)
  return (t) => {
    let j = Math.floor(t / dt)
    if (j < 0) j = 0
    if (j >= m) j = m - 1
    return clamp(1 + depth * c[j], 0.2, 1.6)
  }
}

/** A distance drawn around `mean` (log-normal), kept within lo..hi. */
export function drawDist(rng, mean, spread = 0.5, lo = 1, hi = 5000) {
  return clamp(mean * Math.exp(spread * rng.gauss()), lo, hi)
}

/** A pan position, spread across the field and kept off the exact centre. */
export function drawPan(rng, width = 0.95) {
  const s = rng.next() < 0.5 ? -1 : 1
  return s * width * (0.12 + 0.88 * Math.sqrt(rng.next()))
}

// ---------------------------------------------------------------- noise

/**
 * Fast uniform white noise in -1..1 for long ambience layers: Marsaglia's
 * xorshift32 ("Xorshift RNGs", Journal of Statistical Software 2003) run
 * inline, seeded from the scene's rng so it stays deterministic. Plenty
 * random for hiss and about three times faster than one rng call per sample.
 */
export function fastWhite(n, rng) {
  const out = new Float32Array(Math.max(0, n | 0))
  let x = (rng.uint32() | 1) >>> 0
  for (let i = 0; i < out.length; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = (x | 0) * 4.656612873077393e-10
  }
  return out
}

/** Fast pink noise (Kellet's refined filter over fastWhite), RMS about 0.2. */
export function fastPink(n, rng) {
  const w = fastWhite(n, rng)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  // settle the filter on a short run first
  let x = (rng.uint32() | 1) >>> 0
  for (let i = 0; i < 4096; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    const v = (x | 0) * 4.656612873077393e-10
    b0 = 0.99886 * b0 + v * 0.0555179
    b1 = 0.99332 * b1 + v * 0.0750759
    b2 = 0.969 * b2 + v * 0.153852
    b3 = 0.8665 * b3 + v * 0.3104856
    b4 = 0.55 * b4 + v * 0.5329522
    b5 = -0.7616 * b5 - v * 0.016898
    b6 = v * 0.115926
  }
  const g = 0.2 / 1.749 // the refined filter's output RMS is about 1.749 for uniform input in -1..1
  for (let i = 0; i < w.length; i++) {
    const v = w[i]
    b0 = 0.99886 * b0 + v * 0.0555179
    b1 = 0.99332 * b1 + v * 0.0750759
    b2 = 0.969 * b2 + v * 0.153852
    b3 = 0.8665 * b3 + v * 0.3104856
    b4 = 0.55 * b4 + v * 0.5329522
    b5 = -0.7616 * b5 - v * 0.016898
    const y = b0 + b1 + b2 + b3 + b4 + b5 + b6 + v * 0.5362
    b6 = v * 0.115926
    w[i] = y * g
  }
  return w
}

// ---------------------------------------------------------------- air

/**
 * The air of a place, added straight to L and R.
 * o: { hushDb=-60 (floor), wind 0..1, gust 0..1 (how much it varies),
 *      body=450 (Hz, corner of the wind roar), foliage 0..1, foliageHz=3200,
 *      rustle 0..1, rumble 0..1, gustPeriod=9 (s), windGain=1 (extra level
 *      for places where the wind is the main sound), gustBias=0 (-0.4..0.4,
 *      a windier or calmer place on average) }
 */
export function addAir(sc, o, rng) {
  const { n, sr, L, R } = sc
  if (!n) return
  const r = rng || sc.rng.fork('air')
  const step = 32
  const m = Math.ceil(n / step) + 2
  const dt = step / sr
  const gAmt = clamp(num(o.gust, 0.5), 0, 1)
  const gp = Math.max(2, num(o.gustPeriod, 9))
  const bias = clamp(num(o.gustBias, 0), -0.4, 0.4)
  const slow = smoothNoise(m, dt, gp * 1.6, r.fork('g1'))
  const mid = smoothNoise(m, dt, gp * 0.4, r.fork('g2'))
  const fast = smoothNoise(m, dt, 0.7, r.fork('g3'))
  const gust = new Float32Array(m)
  for (let j = 0; j < m; j++) {
    gust[j] = clamp(0.5 + bias + gAmt * (0.42 * slow[j] + 0.26 * mid[j] + 0.1 * fast[j]), 0, 1)
  }
  sc.gust = gust
  sc.gustStep = step
  const wind = clamp(num(o.wind, 0.3), 0, 1)
  const wg = Math.max(0, num(o.windGain, 1))
  const foliage = clamp(num(o.foliage, 0.4), 0, 1)
  const rustle = clamp(num(o.rustle, 0.3), 0, 1)
  const rumble = clamp(num(o.rumble, 0.2), 0, 1)
  const hush = Math.pow(10, num(o.hushDb, -60) / 20)
  // four noise streams made on the fly (xorshift32, Kellet pink for two of
  // them), so a long take never holds whole-length noise arrays in memory
  let xa = (r.fork('pL').uint32() | 1) >>> 0
  let xb = (r.fork('pR').uint32() | 1) >>> 0
  let xc = (r.fork('wL').uint32() | 1) >>> 0
  let xd = (r.fork('wR').uint32() | 1) >>> 0
  let a0 = 0, a1p = 0, a2p = 0, a3p = 0, a4p = 0, a5p = 0, a6p = 0
  let c0 = 0, c1p = 0, c2p = 0, c3p = 0, c4p = 0, c5p = 0, c6p = 0
  const PK = 0.2 / 1.749
  const XS = 4.656612873077393e-10
  const lim = 0.45 * sr
  // 1. hush floor: pink, low passed at about 2.5 kHz (one pole)
  const hc = 1 - Math.exp((-TAU * Math.min(lim, 2500)) / sr)
  // 2. wind body: TPT state-variable low pass, corner follows the gust
  const body = Math.max(60, num(o.body, 450))
  // 3. foliage: band of white noise (two one-pole sections: high pass then low pass)
  const fHz = Math.min(lim * 0.8, Math.max(400, num(o.foliageHz, 3200)))
  const fhc = 1 - Math.exp((-TAU * fHz * 0.5) / sr)
  const flc = 1 - Math.exp((-TAU * Math.min(lim, fHz * 2)) / sr)
  // 4. rustle grains
  const grainK = Math.exp(-1 / (0.0045 * sr))
  const ghc = 1 - Math.exp((-TAU * Math.min(lim * 0.7, 1800)) / sr)
  // 5. rumble: pink through a one pole at 90 Hz, twice
  const rc = 1 - Math.exp((-TAU * 90) / sr)
  let hL = 0, hR = 0
  let ic1L = 0, ic2L = 0, ic1R = 0, ic2R = 0
  let fhL = 0, fhR = 0, flL = 0, flR = 0
  let gEnvL = 0, gEnvR = 0, ghL = 0, ghR = 0
  let r1 = 0, r2 = 0
  const kq = 1 / 0.7
  for (let b = 0, j = 0; b < n; b += step, j++) {
    const e = b + step < n ? b + step : n
    const g = gust[j]
    const g2 = gust[j + 1]
    const gg = 0.5 * (g + g2)
    const fc = Math.min(lim, body * (0.55 + 1.6 * gg))
    const tg = Math.tan((Math.PI * fc) / sr)
    const a1 = 1 / (1 + tg * (tg + kq))
    const a2 = tg * a1
    const a3 = tg * a2
    const wA = wind * (0.12 + 0.88 * g * g) * 0.75 * wg
    const wB = wind * (0.12 + 0.88 * g2 * g2) * 0.75 * wg
    const fA = foliage * wind * (0.05 + Math.pow(g, 2.2)) * 0.5 * wg
    const fB = foliage * wind * (0.05 + Math.pow(g2, 2.2)) * 0.5 * wg
    // grain probability per sample: a few per second when calm, many in gusts
    const rate = rustle * (3 + 260 * Math.pow(gg, 3) * (0.3 + wind))
    const th = 1 - (2 * rate) / sr
    const gAmp = rustle * (0.1 + 0.5 * gg) * 0.55
    const inv = 1 / (e - b)
    for (let i = b; i < e; i++) {
      const f = (i - b) * inv
      xa ^= xa << 13
      xa ^= xa >>> 17
      xa ^= xa << 5
      const ua = (xa | 0) * XS
      a0 = 0.99886 * a0 + ua * 0.0555179
      a1p = 0.99332 * a1p + ua * 0.0750759
      a2p = 0.969 * a2p + ua * 0.153852
      a3p = 0.8665 * a3p + ua * 0.3104856
      a4p = 0.55 * a4p + ua * 0.5329522
      a5p = -0.7616 * a5p - ua * 0.016898
      const xl = (a0 + a1p + a2p + a3p + a4p + a5p + a6p + ua * 0.5362) * PK
      a6p = ua * 0.115926
      xb ^= xb << 13
      xb ^= xb >>> 17
      xb ^= xb << 5
      const ub = (xb | 0) * XS
      c0 = 0.99886 * c0 + ub * 0.0555179
      c1p = 0.99332 * c1p + ub * 0.0750759
      c2p = 0.969 * c2p + ub * 0.153852
      c3p = 0.8665 * c3p + ub * 0.3104856
      c4p = 0.55 * c4p + ub * 0.5329522
      c5p = -0.7616 * c5p - ub * 0.016898
      const xr = (c0 + c1p + c2p + c3p + c4p + c5p + c6p + ub * 0.5362) * PK
      c6p = ub * 0.115926
      // hush
      hL += hc * (xl - hL)
      hR += hc * (xr - hR)
      // wind body with partial correlation between sides
      const wl = 0.78 * xl + 0.42 * xr
      const wr = 0.78 * xr + 0.42 * xl
      let v3 = wl - ic2L
      let v1 = a1 * ic1L + a2 * v3
      let v2 = ic2L + a2 * ic1L + a3 * v3
      ic1L = 2 * v1 - ic1L
      ic2L = 2 * v2 - ic2L
      const bodyL = v2
      v3 = wr - ic2R
      v1 = a1 * ic1R + a2 * v3
      v2 = ic2R + a2 * ic1R + a3 * v3
      ic1R = 2 * v1 - ic1R
      ic2R = 2 * v2 - ic2R
      const bodyR = v2
      const wAmp = wA + (wB - wA) * f
      // foliage band
      xc ^= xc << 13
      xc ^= xc >>> 17
      xc ^= xc << 5
      const nl = (xc | 0) * XS
      xd ^= xd << 13
      xd ^= xd >>> 17
      xd ^= xd << 5
      const nr = (xd | 0) * XS
      fhL += fhc * (nl - fhL)
      fhR += fhc * (nr - fhR)
      flL += flc * (nl - fhL - flL)
      flR += flc * (nr - fhR - flR)
      const fAmp = fA + (fB - fA) * f
      // rustle grains: an event whenever the white sample crosses the threshold
      if (nl > th) gEnvL += gAmp * (0.3 + 0.7 * (nr * 0.5 + 0.5))
      if (nr > th) gEnvR += gAmp * (0.3 + 0.7 * (nl * 0.5 + 0.5))
      gEnvL *= grainK
      gEnvR *= grainK
      if (gEnvL < TINY) gEnvL = 0
      if (gEnvR < TINY) gEnvR = 0
      const grl = nr * gEnvL
      const grr = nl * gEnvR
      ghL += ghc * (grl - ghL)
      ghR += ghc * (grr - ghR)
      // rumble
      r1 += rc * (xl + xr - r1)
      r2 += rc * (r1 - r2)
      const rum = r2 * rumble * 0.3 * (0.4 + 0.6 * gg)
      L[i] += hL * hush * 3 + bodyL * wAmp + flL * fAmp + (grl - ghL) + rum
      R[i] += hR * hush * 3 + bodyR * wAmp + flR * fAmp + (grr - ghR) + rum
    }
    if (!(ic1L > -1e9 && ic1L < 1e9)) ic1L = ic2L = 0
    if (!(ic1R > -1e9 && ic1R < 1e9)) ic1R = ic2R = 0
  }
}

// ---------------------------------------------------------------- notes

/**
 * Add one note into out. Fields (seconds and hertz): t (start within out),
 * d (length), f0, f1 (start and end), bend (contour curve, 1 = straight in
 * log frequency), arch (octaves added at the middle, negative dips),
 * fmR, fmD (vibrato or trill: rate, depth in octaves), amR, amD (buzz: rate,
 * depth 0..1), h2, h3, h4 (overtone levels), att, rel (seconds), swell
 * (0..1, a rounder middle), a (amplitude), noise (breath band around the
 * pitch, 0..1), ph (start phase).
 */
export function renderNote(out, sr, nt, rng) {
  const off = Math.round(num(nt.t, 0) * sr)
  let len = Math.round(num(nt.d, 0.1) * sr)
  if (len < 4 || off >= out.length || off < 0) return
  if (off + len > out.length) len = out.length - off
  if (len < 4) return
  const lim = 0.45 * sr
  const f0 = Math.max(20, num(nt.f0, 1000))
  const f1 = Math.max(20, num(nt.f1, f0))
  const arch = num(nt.arch, 0)
  const fmD = Math.abs(num(nt.fmD, 0))
  const fmax = Math.max(f0, f1) * Math.pow(2, Math.max(0, arch) + fmD)
  const scale = fmax > lim * 0.92 ? (lim * 0.92) / fmax : 1
  const lf0 = Math.log2(f0 * scale)
  const dlf = Math.log2(f1 * scale) - lf0
  const bend = Math.max(0.1, num(nt.bend, 1))
  const fmR = num(nt.fmR, 0)
  const amR = num(nt.amR, 0)
  const amD = clamp(num(nt.amD, 0), 0, 1)
  const h2 = num(nt.h2, 0)
  const h3 = num(nt.h3, 0)
  const h4 = num(nt.h4, 0)
  let att = Math.max(1, Math.round(num(nt.att, 0.01) * sr))
  let rel = Math.max(1, Math.round(num(nt.rel, 0.02) * sr))
  if (att + rel > len) {
    const k = len / (att + rel)
    att = Math.max(1, Math.floor(att * k))
    rel = Math.max(1, Math.floor(rel * k))
  }
  const swell = clamp(num(nt.swell, 0), 0, 1)
  const amp = num(nt.a, 1)
  const noise = clamp(num(nt.noise, 0), 0, 1)
  const fmP = num(nt.fmP, 0)
  const ph = nt.ph !== undefined ? num(nt.ph, 0) : rng ? rng.next() * TAU : 0
  let re = Math.cos(ph)
  let im = Math.sin(ph)
  const nzc = 1 - Math.exp((-TAU * 180) / sr)
  const nzg = noise * 2.2 / Math.sqrt(nzc)
  let nz = 0
  const r = rng || makeRng('note')
  const invLen = 1 / len
  const B = 8
  const ampAt = (i) => {
    let e = 1
    if (i < att) {
      const s = Math.sin((Math.PI * 0.5 * i) / att)
      e = s * s
    }
    const k = len - i
    if (k < rel) {
      const s = Math.sin((Math.PI * 0.5 * (k > 0 ? k : 0)) / rel)
      e *= s * s
    }
    if (swell > 0) e *= 1 - swell + swell * Math.sin(Math.PI * i * invLen)
    if (amD > 0) e *= 1 - amD * (0.5 + 0.5 * Math.cos((TAU * amR * i) / sr))
    return e * amp
  }
  let aPrev = ampAt(0)
  for (let b = 0; b < len; b += B) {
    const e = b + B < len ? b + B : len
    const uc = (b + 0.5 * (e - b)) * invLen
    const sh = bend === 1 ? uc : Math.pow(uc, bend)
    let lf = lf0 + dlf * sh + arch * 4 * uc * (1 - uc)
    if (fmD > 0) lf += fmD * Math.sin((TAU * fmR * (b + 0.5 * (e - b))) / sr + fmP)
    const f = Math.pow(2, lf)
    const w = (TAU * f) / sr
    const cr = Math.cos(w)
    const ci = Math.sin(w)
    const g2 = 2 * f < lim ? h2 : 0
    const g3 = 3 * f < lim ? h3 : 0
    const g4 = 4 * f < lim ? h4 : 0
    const aNext = ampAt(e)
    const da = (aNext - aPrev) / (e - b)
    let a = aPrev
    let j = off + b
    for (let i = b; i < e; i++, j++) {
      const nre = re * cr - im * ci
      im = re * ci + im * cr
      re = nre
      const s1 = im
      const c1 = re
      const s2 = 2 * s1 * c1
      const c2 = 1 - 2 * s1 * s1
      const s3 = s1 * (3 - 4 * s1 * s1)
      const s4 = 2 * s2 * c2
      let y = s1 + g2 * s2 + g3 * s3 + g4 * s4
      if (noise > 0) {
        nz += nzc * (r.next() * 2 - 1 - nz)
        y = y * (1 - noise * 0.6) + nz * nzg * s1
      }
      out[j] += y * a
      a += da
    }
    aPrev = aNext
    // keep the phasor on the unit circle
    const mag = re * re + im * im
    const fix = (3 - mag) * 0.5
    re *= fix
    im *= fix
  }
}

/** Length in seconds of a list of notes. */
export function notesDur(notes) {
  let d = 0
  for (const nt of notes) {
    const e = num(nt.t, 0) + num(nt.d, 0)
    if (e > d) d = e
  }
  return d
}

/** Render a list of notes into a new Float32Array (with a short tail). */
export function renderNotes(notes, sr, rng, padSec = 0.03) {
  const len = Math.max(1, Math.ceil((notesDur(notes) + padSec) * sr))
  const out = new Float32Array(len)
  for (const nt of notes) renderNote(out, sr, nt, rng)
  return out
}

// ---------------------------------------------------------------- species

function R(rng, a, b) {
  return a + (b - a) * rng.next()
}

function note(o) {
  return Object.assign({ t: 0, d: 0.1, f0: 3000, f1: 3000, bend: 1, arch: 0, fmR: 0, fmD: 0, amR: 0, amD: 0, h2: 0.12, h3: 0.03, h4: 0, att: 0.01, rel: 0.025, swell: 0, a: 1, noise: 0 }, o)
}

// A syllable of a caroling song (robin-like): short, curved, slightly burry.
function carolSyl(rng, v) {
  const base = v * R(rng, 1900, 3100)
  const kind = rng.int(4)
  const d = R(rng, 0.1, 0.2)
  const o = { d, h2: R(rng, 0.15, 0.35), h3: R(rng, 0.03, 0.09), att: R(rng, 0.008, 0.018), rel: R(rng, 0.02, 0.04), swell: 0.3 }
  if (kind === 0) Object.assign(o, { f0: base * 0.9, f1: base * 0.95, arch: R(rng, 0.25, 0.55) })
  else if (kind === 1) Object.assign(o, { f0: base * 1.3, f1: base * 0.8, bend: 0.7 })
  else if (kind === 2) Object.assign(o, { f0: base * 0.8, f1: base * 1.25, bend: 1.4 })
  else Object.assign(o, { f0: base, f1: base * 0.84, arch: R(rng, 0.2, 0.35) })
  if (rng.next() < 0.25) Object.assign(o, { fmR: R(rng, 45, 80), fmD: R(rng, 0.025, 0.06) })
  return note(o)
}

/**
 * Species-like voices. Each has: gain (level at 10 m), dist (distance factor
 * against the bed's distance), period [min, max] seconds between songs,
 * bout [min, max] repeats of one song type, types (repertoire size), send
 * (reverb), and type(rng, voice) -> a list of notes (one song type). voice
 * is the individual's pitch factor (about 0.9..1.1).
 */
export const SPECIES = {
  // Caroling phrases of two to four repeated syllables (robin-like).
  carol: {
    gain: 0.5, dist: 1, period: [2.5, 6], bout: [2, 5], types: 4, send: 0.5,
    type(rng, v) {
      const nP = 2 + rng.int(3)
      const notes = []
      let t = 0
      for (let p = 0; p < nP; p++) {
        const syl = carolSyl(rng, v)
        const reps = 1 + rng.int(3)
        const gap = R(rng, 0.04, 0.09)
        for (let k = 0; k < reps; k++) {
          notes.push(note(Object.assign({}, syl, { t, a: 0.85 + 0.15 * rng.next() })))
          t += syl.d + gap
        }
        t += R(rng, 0.05, 0.13)
      }
      return notes
    },
  },
  // Clear whistles: "fee-bee", "tea-cher tea-cher", or three falling notes.
  whistler: {
    gain: 0.45, dist: 1.1, period: [3, 7], bout: [3, 7], types: 3, send: 0.55,
    type(rng, v) {
      const kind = rng.int(3)
      const notes = []
      if (kind === 0) {
        const F = v * R(rng, 3500, 4100)
        const d1 = R(rng, 0.3, 0.42)
        notes.push(note({ t: 0, d: d1, f0: F, f1: F * 0.98, h2: 0.04, h3: 0.01, att: 0.03, rel: 0.05, swell: 0.3 }))
        const t2 = d1 + R(rng, 0.04, 0.08)
        notes.push(note({ t: t2, d: R(rng, 0.32, 0.46), f0: F * 0.86, f1: F * 0.83, h2: 0.04, h3: 0.01, att: 0.03, rel: 0.07, amR: R(rng, 5, 8), amD: 0.25 }))
      } else if (kind === 1) {
        const hi = v * R(rng, 5600, 6600)
        const lo = v * R(rng, 3800, 4600)
        const per = R(rng, 0.22, 0.3)
        const reps = 3 + rng.int(3)
        for (let k = 0; k < reps; k++) {
          const t = k * per
          notes.push(note({ t, d: R(rng, 0.07, 0.095), f0: hi, f1: hi * 0.82, bend: 0.8, h2: 0.15, att: 0.006, rel: 0.02 }))
          notes.push(note({ t: t + per * 0.45, d: R(rng, 0.09, 0.12), f0: lo, f1: lo * 0.95, h2: 0.12, att: 0.008, rel: 0.03 }))
        }
      } else {
        const F = v * R(rng, 3000, 3800)
        for (let k = 0; k < 3; k++) {
          notes.push(note({ t: k * 0.32, d: R(rng, 0.2, 0.26), f0: F * Math.pow(0.9, k), f1: F * Math.pow(0.9, k) * 0.97, h2: 0.05, att: 0.025, rel: 0.05, swell: 0.4 }))
        }
      }
      return notes
    },
  },
  // Descending cascade of trills with a flourish at the end, or one even trill.
  cascade: {
    gain: 0.5, dist: 1, period: [3, 8], bout: [3, 8], types: 3, send: 0.5,
    type(rng, v) {
      const notes = []
      if (rng.next() < 0.7) {
        let t = 0
        const m1 = 5 + rng.int(4)
        const p1 = R(rng, 0.062, 0.076)
        let f = v * R(rng, 6000, 7000)
        for (let k = 0; k < m1; k++) {
          notes.push(note({ t, d: R(rng, 0.035, 0.05), f0: f, f1: f * 0.7, bend: 0.8, h2: 0.2, att: 0.004, rel: 0.012, a: 0.6 + 0.4 * (k / m1) }))
          f *= 0.975
          t += p1
        }
        const m2 = 3 + rng.int(3)
        const p2 = R(rng, 0.09, 0.11)
        let g = v * R(rng, 3700, 4400)
        for (let k = 0; k < m2; k++) {
          notes.push(note({ t, d: R(rng, 0.05, 0.07), f0: g, f1: g * 0.75, arch: 0.1, h2: 0.22, att: 0.005, rel: 0.015 }))
          g *= 0.97
          t += p2
        }
        const F = v * R(rng, 2800, 3300)
        notes.push(note({ t: t + 0.02, d: R(rng, 0.18, 0.26), f0: F, f1: F * 1.45, arch: R(rng, 0.3, 0.6), bend: 1.6, h2: 0.25, h3: 0.08, att: 0.01, rel: 0.04 }))
      } else {
        const reps = 12 + rng.int(10)
        const per = R(rng, 0.05, 0.068)
        const F = v * R(rng, 3500, 5500)
        for (let k = 0; k < reps; k++) {
          notes.push(note({ t: k * per, d: R(rng, 0.03, 0.042), f0: F * 1.3, f1: F, bend: 0.7, h2: 0.25, att: 0.003, rel: 0.01, a: k < 3 ? 0.6 + 0.13 * k : 1 }))
        }
      }
      return notes
    },
  },
  // Long tumbling song of quick high notes and trills (wren-like). Loud and near.
  tumbler: {
    gain: 0.42, dist: 0.7, period: [5, 11], bout: [2, 4], types: 2, send: 0.45,
    type(rng, v) {
      const motifs = []
      const nm = 4 + rng.int(3)
      for (let k = 0; k < nm; k++) {
        const reps = rng.next() < 0.6 ? 3 + rng.int(9) : 1
        const d = reps > 1 ? R(rng, 0.018, 0.035) : R(rng, 0.05, 0.1)
        const F = v * R(rng, 3200, 8000)
        const kind = rng.int(3)
        motifs.push({ reps, d, per: d + R(rng, 0.008, 0.025), F, kind, h2: R(rng, 0.1, 0.3) })
      }
      const notes = []
      let t = 0
      const total = R(rng, 2.4, 3.8)
      let i = 0
      while (t < total) {
        const mo = motifs[(i * 3 + rng.int(2)) % nm]
        for (let k = 0; k < mo.reps; k++) {
          const f0 = mo.kind === 0 ? mo.F * 1.25 : mo.kind === 1 ? mo.F * 0.85 : mo.F
          const f1 = mo.kind === 0 ? mo.F * 0.85 : mo.kind === 1 ? mo.F * 1.2 : mo.F * 0.97
          notes.push(note({ t, d: mo.d, f0, f1, arch: mo.kind === 2 ? 0.2 : 0, h2: mo.h2, h3: 0.05, att: 0.003, rel: Math.min(0.012, mo.d * 0.4) }))
          t += mo.per
        }
        t += R(rng, 0.005, 0.04)
        i++
      }
      return notes
    },
  },
  // Thin buzzy notes, rising at the end (warbler-like).
  buzzer: {
    gain: 0.36, dist: 1.1, period: [3, 7], bout: [3, 8], types: 2, send: 0.5,
    type(rng, v) {
      const k = 3 + rng.int(4)
      const F = v * R(rng, 4500, 6200)
      const up = rng.next() < 0.6
      const notes = []
      let t = 0
      for (let i = 0; i < k; i++) {
        const last = i === k - 1
        const f = last && up ? F * 1.25 : F * (1 - 0.02 * i)
        const d = R(rng, 0.15, 0.28)
        notes.push(note({ t, d, f0: f, f1: f * (up ? 1.06 : 0.96), h2: 0.1, amR: R(rng, 85, 160), amD: 0.85, att: 0.015, rel: 0.03 }))
        t += d + R(rng, 0.07, 0.14)
      }
      return notes
    },
  },
  // Flute-like phrase with a two-voiced trill at the end (thrush-like). Far and lovely.
  flute: {
    gain: 0.48, dist: 1.6, period: [3.5, 8], bout: [1, 2], types: 5, send: 0.75,
    type(rng, v) {
      const notes = []
      let t = 0
      const intro = 2 + rng.int(2)
      for (let k = 0; k < intro; k++) {
        notes.push(note({ t, d: R(rng, 0.04, 0.06), f0: v * R(rng, 1500, 1900), f1: v * 1400, h2: 0.3, a: 0.3, att: 0.006, rel: 0.02 }))
        t += R(rng, 0.08, 0.11)
      }
      t += R(rng, 0.06, 0.1)
      const fl = 2 + rng.int(3)
      for (let k = 0; k < fl; k++) {
        const F = v * R(rng, 1800, 3200)
        const d = R(rng, 0.12, 0.2)
        notes.push(note({ t, d, f0: F, f1: F * R(rng, 0.92, 1.08), arch: R(rng, -0.08, 0.12), h2: R(rng, 0.25, 0.4), h3: 0.1, att: 0.012, rel: 0.04, swell: 0.3 }))
        t += d + R(rng, 0.015, 0.045)
      }
      const td = R(rng, 0.3, 0.5)
      const A = v * R(rng, 4000, 5400)
      notes.push(note({ t, d: td, f0: A, f1: A * 0.92, fmR: R(rng, 25, 45), fmD: R(rng, 0.06, 0.12), h2: 0.1, a: 0.55, att: 0.01, rel: 0.06 }))
      notes.push(note({ t: t + 0.01, d: td * 0.9, f0: A * R(rng, 1.35, 1.6), f1: A * 1.3, fmR: R(rng, 30, 55), fmD: R(rng, 0.05, 0.1), fmP: 1.3, h2: 0.08, a: 0.42, att: 0.01, rel: 0.06 }))
      return notes
    },
  },
  // Soft low coos, far off (dove-like).
  dove: {
    gain: 0.6, dist: 2.2, period: [6, 13], bout: [2, 5], types: 2, send: 0.6,
    type(rng, v) {
      const F = v * R(rng, 440, 500)
      const c = { h2: 0.25, h3: 0.08, att: 0.06, rel: 0.12, noise: 0.18, swell: 0.4 }
      if (rng.next() < 0.6) {
        return [
          note(Object.assign({ t: 0, d: 0.28, f0: F, f1: F * 1.18, arch: 0.04 }, c)),
          note(Object.assign({ t: 0.34, d: 0.5, f0: F * 1.2, f1: F * 1.05, arch: 0.1 }, c)),
          note(Object.assign({ t: 1.2, d: 0.45, f0: F, f1: F * 0.96 }, c)),
          note(Object.assign({ t: 1.9, d: 0.45, f0: F, f1: F * 0.96 }, c)),
          note(Object.assign({ t: 2.6, d: 0.48, f0: F * 0.98, f1: F * 0.94 }, c)),
        ]
      }
      return [
        note(Object.assign({ t: 0, d: 0.25, f0: F, f1: F * 1.02 }, c)),
        note(Object.assign({ t: 0.32, d: 0.45, f0: F * 1.15, f1: F * 1.05, arch: 0.06 }, c)),
        note(Object.assign({ t: 0.9, d: 0.35, f0: F * 0.95, f1: F * 0.9 }, c)),
      ]
    },
  },
  // Sweet slurred descending whistles (meadow-lark-like).
  slurs: {
    gain: 0.5, dist: 1.5, period: [3, 7], bout: [2, 5], types: 4, send: 0.45,
    type(rng, v) {
      const k = 3 + rng.int(4)
      const notes = []
      let t = 0
      let F = v * R(rng, 3200, 4200)
      for (let i = 0; i < k; i++) {
        const d = i === 0 ? R(rng, 0.25, 0.4) : R(rng, 0.1, 0.22)
        const f0 = F
        const f1 = F * R(rng, 0.7, 0.92)
        notes.push(note({ t, d, f0, f1, bend: R(rng, 0.6, 1.6), arch: R(rng, -0.05, 0.1), h2: 0.18, h3: 0.05, att: 0.012, rel: 0.04 }))
        t += d + R(rng, 0.02, 0.07)
        F = v * R(rng, 2400, 4000)
      }
      return notes
    },
  },
  // Accelerating "bouncing ball" of whistles (field-sparrow-like).
  bouncer: {
    gain: 0.45, dist: 1.4, period: [3, 7], bout: [3, 6], types: 2, send: 0.4,
    type(rng, v) {
      const k = 9 + rng.int(6)
      const F = v * R(rng, 3800, 4800)
      const rise = R(rng, 0.98, 1.06)
      const notes = []
      let t = 0
      let per = R(rng, 0.3, 0.36)
      for (let i = 0; i < k; i++) {
        const d = Math.max(0.035, per * 0.6)
        const f = F * Math.pow(rise, i)
        notes.push(note({ t, d, f0: f * 1.06, f1: f * 0.97, h2: 0.06, att: 0.008, rel: 0.02 }))
        t += per
        per = Math.max(0.055, per * 0.82)
      }
      return notes
    },
  },
  // Three plain notes, a buzz and a trill (song-sparrow-like).
  sparrowSong: {
    gain: 0.48, dist: 0.9, period: [3, 7], bout: [3, 8], types: 3, send: 0.4,
    type(rng, v) {
      const notes = []
      let t = 0
      const F = v * R(rng, 2600, 3400)
      const intro = 2 + rng.int(3)
      for (let i = 0; i < intro; i++) {
        notes.push(note({ t, d: R(rng, 0.07, 0.11), f0: F * 1.05, f1: F * 0.9, h2: 0.25, att: 0.006, rel: 0.02 }))
        t += R(rng, 0.17, 0.22)
      }
      const bz = R(rng, 0.2, 0.32)
      notes.push(note({ t, d: bz, f0: v * 4600, f1: v * 4300, amR: R(rng, 90, 140), amD: 0.85, h2: 0.15, noise: 0.25, att: 0.01, rel: 0.03 }))
      t += bz + 0.05
      const tr = 5 + rng.int(6)
      const G = v * R(rng, 3500, 5500)
      for (let i = 0; i < tr; i++) {
        notes.push(note({ t, d: 0.028, f0: G * 1.3, f1: G, h2: 0.2, att: 0.003, rel: 0.01 }))
        t += 0.055
      }
      notes.push(note({ t: t + 0.03, d: R(rng, 0.1, 0.16), f0: v * R(rng, 2400, 3000), f1: v * 2200, h2: 0.25, att: 0.008, rel: 0.03 }))
      return notes
    },
  },
}

/** Contact chips from small birds: returns a list of notes for one chip. */
export function chipNotes(rng, kind, v = 1) {
  if (kind === 0) {
    return [note({ t: 0, d: R(rng, 0.02, 0.04), f0: v * R(rng, 6500, 8200), f1: v * R(rng, 3600, 4500), bend: 0.6, h2: 0.3, att: 0.002, rel: 0.01 })]
  }
  if (kind === 1) {
    return [note({ t: 0, d: R(rng, 0.035, 0.05), f0: v * R(rng, 7400, 8400), f1: v * 7900, h2: 0.05, att: 0.006, rel: 0.015 })]
  }
  return [note({ t: 0, d: R(rng, 0.03, 0.05), f0: v * R(rng, 2600, 3200), f1: v * 2000, arch: 0.15, h2: 0.5, h3: 0.2, att: 0.002, rel: 0.015 })]
}

/**
 * Make singers of the given species. opts: { dist (bed distance), gainMul,
 * sendMul, panWidth, species (a table shaped like SPECIES; default SPECIES) }.
 * Returns singer objects for runSingers.
 */
export function makeSingers(list, rng, opts = {}) {
  const out = []
  const table = opts.species || SPECIES
  const dist = num(opts.dist, 20)
  const gm = num(opts.gainMul, 1)
  const smul = num(opts.sendMul, 1)
  const pw = num(opts.panWidth, 0.95)
  list.forEach((name, i) => {
    const sp = table[name]
    if (!sp) return
    const r = rng.fork('singer' + i + name)
    const v = 1 + 0.08 * r.gauss()
    const types = []
    const nt = Math.max(1, sp.types)
    for (let k = 0; k < nt; k++) types.push(sp.type(r, clamp(v, 0.82, 1.2)))
    out.push({
      name,
      sp,
      r,
      types,
      pan: drawPan(r, pw),
      dist: drawDist(r, dist * sp.dist, 0.45, 2, 2000),
      gain: sp.gain * gm * (0.75 + 0.5 * r.next()),
      send: sp.send * smul,
    })
  })
  return out
}

/** One rendition of a song type: small changes in pitch, tempo and level each time. */
export function rendition(type, rng, sr) {
  const p = 1 + 0.012 * rng.gauss()
  const q = 1 + 0.035 * rng.gauss()
  const cut = rng.next() < 0.12 ? Math.max(1, type.length - 1 - rng.int(3)) : type.length
  const notes = new Array(cut)
  for (let i = 0; i < cut; i++) {
    const nt = type[i]
    const j = 1 + 0.004 * rng.gauss()
    notes[i] = Object.assign({}, nt, { t: nt.t * q, d: nt.d * (0.6 + 0.4 * q), f0: nt.f0 * p * j, f1: nt.f1 * p * j, a: nt.a * (0.85 + 0.3 * rng.next()) })
  }
  return renderNotes(notes, sr, rng)
}

/**
 * Let singers sing through the scene. Same-species neighbours counter-sing
 * (one waits for the other). opts: { rate (song rate factor, 1 normal),
 * activity (function of t), start [lo, hi] seconds for the first song,
 * until (seconds) }.
 */
export function runSingers(sc, singers, rng, opts = {}) {
  const sr = sc.sr
  const rate = Math.max(0.05, num(opts.rate, 1))
  const act = typeof opts.activity === 'function' ? opts.activity : () => 1
  const st = opts.start || [0.2, 3.5]
  const until = num(opts.until, sc.dur)
  const busyUntil = Object.create(null)
  // everybody's first song time, then process in time order
  const queue = singers.map((s) => ({ s, t: R(s.r, st[0], st[1]) + (s.sp.period[0] * s.r.next()) / rate * 0.5, type: s.r.int(s.types.length), left: 0 }))
  let guard = 0
  while (queue.length && guard++ < 20000) {
    let bi = 0
    for (let i = 1; i < queue.length; i++) if (queue[i].t < queue[bi].t) bi = i
    const q = queue[bi]
    if (q.t >= until) {
      queue.splice(bi, 1)
      continue
    }
    const s = q.s
    // counter-singing: wait a moment for a neighbour of the same kind to finish
    const busy = busyUntil[s.name] || -1
    if (busy > q.t && busy - q.t < 4) {
      q.t = busy + R(s.r, 0.3, 1.2)
      continue
    }
    if (q.left <= 0) {
      q.type = s.types.length > 1 ? (q.type + 1 + s.r.int(s.types.length - 1)) % s.types.length : 0
      q.left = s.sp.bout[0] + s.r.int(s.sp.bout[1] - s.sp.bout[0] + 1)
    }
    q.left--
    const ev = rendition(s.types[q.type], s.r, sr)
    emit(sc, ev, q.t * sr, s.pan, s.dist, s.gain, s.send)
    const len = ev.length / sr
    busyUntil[s.name] = Math.max(busy, q.t + len)
    const per = R(s.r, s.sp.period[0], s.sp.period[1])
    q.t += len + per / (rate * act(q.t))
  }
}

/** Woodpecker drumming roll: a burst of wooden knocks on a resonant trunk. */
export function drumRoll(sr, rng) {
  const strikes = 12 + rng.int(14)
  const r0 = R(rng, 15, 24)
  const accel = R(rng, -0.012, 0.01)
  const fw = R(rng, 520, 900)
  const total = strikes / r0 + 0.15
  const len = Math.ceil(total * sr)
  const exc = new Float32Array(len)
  let t = 0.005
  let per = 1 / r0
  for (let k = 0; k < strikes; k++) {
    const i = Math.round(t * sr)
    if (i + 2 >= len) break
    const env = Math.sin((Math.PI * (k + 0.5)) / strikes)
    const a = (0.45 + 0.55 * env) * (0.85 + 0.3 * rng.next())
    exc[i] += a
    exc[i + 1] -= a * 0.6
    const nb = Math.round(0.0006 * sr)
    for (let j = 2; j < nb && i + j < len; j++) exc[i + j] += a * 0.25 * (rng.next() * 2 - 1)
    t += per
    per *= 1 + accel
  }
  const out = new Float32Array(len)
  const modes = [[fw, 14, 1], [fw * 2.31, 11, 0.55], [fw * 3.93, 9, 0.32], [fw * 6.1, 7, 0.15]]
  const lim = 0.45 * sr
  for (const [f, q, g] of modes) {
    if (f >= lim) continue
    // constant-peak band pass (RBJ cookbook), run inline
    const w0 = (TAU * f) / sr
    const al = Math.sin(w0) / (2 * q)
    const a0 = 1 + al
    const b0 = al / a0
    const a1 = (-2 * Math.cos(w0)) / a0
    const a2 = (1 - al) / a0
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    for (let i = 0; i < len; i++) {
      const x = exc[i]
      const y = b0 * x - b0 * x2 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = x
      y2 = y1
      y1 = y < TINY && y > -TINY ? 0 : y
      out[i] += y1 * g * 3
    }
  }
  for (let i = 0; i < len; i++) out[i] += exc[i] * 0.08
  return out
}

// ---------------------------------------------------------------- the bed

const bed = {
  id: 'forest-birds',
  name: 'Forest birds',
  group: 'nature',
  about: 'A spring wood full of birdsong: singers near and far, soft chips, a far dove, wind in the leaves.',
  params: [
    { id: 'intensity', name: 'Birdsong', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent' },
    { id: 'distance', name: 'Distance to the birds', type: 'number', min: 4, max: 80, step: 1, def: 18, unit: 'meters' },
    { id: 'wind', name: 'Wind in the trees', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent' },
    { id: 'trees', name: 'Trees', type: 'choice', def: 'leafy', options: [{ v: 'leafy', name: 'Leafy woods' }, { v: 'pines', name: 'Pine woods' }] },
    { id: 'woodpecker', name: 'Woodpecker', type: 'bool', def: true },
    { id: 'dove', name: 'Far dove', type: 'bool', def: true },
  ],
  generate(seconds, sr, p, rng) {
    const q = resolveParams(bed, p || {})
    const r = rng || makeRng('forest-birds')
    const sc = makeScene(seconds, sr, r)
    if (!sc.n) return { sr: sc.sr, ch: [sc.L, sc.R] }
    const I = q.intensity / 100
    const pines = q.trees === 'pines'
    addAir(sc, {
      hushDb: -60,
      wind: 0.08 + 0.92 * (q.wind / 100),
      gust: 0.6,
      body: pines ? 520 : 420,
      foliage: pines ? 0.75 : 0.45,
      foliageHz: pines ? 5200 : 3000,
      rustle: pines ? 0.15 : 0.45,
      rumble: 0.15,
    }, r.fork('air'))
    // the cast grows with intensity
    const pool = ['carol', 'cascade', 'whistler', 'flute', 'tumbler', 'buzzer', 'carol', 'cascade', 'slurs', 'whistler', 'flute', 'buzzer']
    const count = I <= 0 ? 0 : Math.max(1, Math.round(1 + I * 10))
    const list = pool.slice(0, count)
    if (q.dove && I > 0) list.push('dove')
    const singers = makeSingers(list, r.fork('cast'), { dist: q.distance })
    runSingers(sc, singers, r.fork('songs'), { rate: 0.6 + 0.8 * I, activity: activityCurve(sc, r.fork('act'), 0.45) })
    // contact chips
    if (I > 0) {
      const cr = r.fork('chips')
      const chippers = []
      for (let k = 0; k < 4; k++) chippers.push({ kind: cr.int(3), v: 1 + 0.06 * cr.gauss(), pan: drawPan(cr), dist: drawDist(cr, q.distance * 0.8, 0.5, 2, 300) })
      let t = R(cr, 0.1, 1.2)
      const rate = 0.25 + 1.6 * I
      while (t < sc.dur) {
        const c = chippers[cr.int(chippers.length)]
        const reps = 1 + cr.int(4)
        const gap = R(cr, 0.12, 0.45)
        for (let k = 0; k < reps; k++) {
          const ev = renderNotes(chipNotes(cr, c.kind, c.v), sc.sr, cr)
          emit(sc, ev, (t + k * gap) * sc.sr, c.pan, c.dist, 0.3, 0.45)
        }
        t += reps * gap - Math.log(1 - cr.next()) / rate
      }
    }
    if (q.woodpecker && I > 0) {
      const wr = r.fork('woodpecker')
      const pan = drawPan(wr)
      const dist = drawDist(wr, Math.max(25, q.distance * 2), 0.3, 10, 300)
      let t = R(wr, 1, 7)
      while (t < sc.dur) {
        const ev = drumRoll(sc.sr, wr)
        emit(sc, ev, t * sc.sr, pan, dist, 0.7, 0.8)
        t += ev.length / sc.sr + R(wr, 4, 14) / (0.5 + I)
      }
    }
    return finishScene(sc, pines ? SPACES.pines : SPACES.forest, r.fork('space'), -11)
  },
}

export default bed
