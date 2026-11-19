// core/ir.js - synthetic impulse responses: rooms, halls, boxes, pipes, plates,
// springs and the outdoors, plus the engine's catalog of named spaces.
//
// Nothing here is a recording; every response is built from a description,
// so it is ours to ship and it works at any sample rate. A response is the
// sum of up to five parts, then shaped and normalised:
//
// 1. The direct sound: one impulse at time zero (both ears).
//
// 2. Early reflections from the image-source method for a shoebox room
//    (Allen and Berkley 1979, "Image method for efficiently simulating
//    small-room acoustics", JASA 65). Each mirror image of the talker is one
//    reflection: delay from its distance, level from the product of the wall
//    reflection coefficients it bounced off and the 1/r law, side from its
//    direction (equal-power pan plus up to 0.66 ms of interaural delay).
//    Walls lose highs at every bounce: each reflection is drawn as a
//    unit-area Gaussian pulse whose width grows with the square root of its
//    bounce count (Gaussian blurs add in variance), plus the air absorption
//    of its path, so late, many-bounce reflections are duller, as in real
//    rooms. Wall coefficients come from the requested decay time by
//    Eyring's formula unless given wall by wall (open sky, water, glass).
//    An "irregular" amount jitters times and levels for caves, furnished
//    rooms and anything that is not a clean box.
//
// 3. The late tail: decorrelated stereo noise in octave bands
//    (63 Hz to 16 kHz), each band decaying exponentially at its own rate.
//    The decay time falls above 1.5 kHz with "damping" (soft surfaces and air
//    eat highs), and rises or falls below 500 Hz with "bassRatio" (warm
//    halls hold their bass). Every band is independent noise through an
//    octave filter (RBJ cookbook biquads), so the bands add in power to a
//    flat spectrum. "density" below 1 replaces white noise with sparse
//    random impulses (grainy, fluttery tails). For image-source rooms the
//    tail level is not a guess: it continues the statistical power of the
//    image-source field, 4 pi c d0^2 / (V fs) times the mean energy
//    reflectivity raised to the number of bounces (Kuttruff, "Room
//    Acoustics", the image density argument), so early and late join
//    without a step. Plates add frequency-dependent onset delay (bending
//    waves travel faster at high frequencies, so highs arrive first).
//
// 4. Springs: the parametric spring model of Valimaki, Parker and Abel 2010
//    ("Parametric spring reverberation effect", JAES 58(7)): a feedback loop
//    holding a delay and a cascade of stretched first-order allpass
//    sections, (a + z^-K) / (1 + a z^-K), whose group delay rises toward the
//    spring's transition frequency, so every echo is a chirp and each trip
//    round the loop spreads it further. That is the "drip". Two springs of
//    different lengths feed the two sides.
//
// 5. Discrete echoes and scatter for the outdoors and big open spaces:
//    canyon walls, stadium stands, a tree line, the ground. Each echo is a
//    Gaussian pulse (darker when farther) plus a short decaying burst of
//    filtered noise for rough surfaces.
//
// Then, over the whole response: feedback comb filters for the flutter of
// tiny hard cavities (a can, a jar, a bottle, a drum), peaking filters for
// room modes and shell resonances ('auto' derives axial modes n c / 2L from
// the box), the high and low cut and any extra EQ, a raised-cosine fade
// over the end, and a speech-weighted level match (see speechGain): speech
// has the same energy through the response as through a bare impulse, so a
// voice keeps about its loudness in every space (measured within -10..+5 dB
// for male and female test voices across all named spaces).
//
// Randomness: every part draws from rng.fork(label), so a response depends
// only on the seed key and the spec, never on what else drew numbers.

import { Biquad, OnePole, filterChain } from './biquad.js'
import { DelayLine } from './delay.js'
import { makeRng } from './rng.js'

const C = 343

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

function rngOf(rng, label) {
  if (rng && typeof rng.fork === 'function') return rng.fork(label)
  return makeRng('ir:' + label)
}

// ---------- drawing pulses ----------

/** Add a unit-area Gaussian pulse (or a two-tap linear splat when narrow). */
function splat(buf, pos, amp, sigma) {
  const n = buf.length
  if (!(pos >= 0) || pos >= n - 1 || amp === 0) return
  if (sigma < 0.6) {
    const i = pos | 0
    const f = pos - i
    buf[i] += amp * (1 - f)
    if (i + 1 < n) buf[i + 1] += amp * f
    return
  }
  const half = Math.ceil(3 * sigma)
  const i0 = Math.max(0, Math.floor(pos) - half)
  const i1 = Math.min(n - 1, Math.ceil(pos) + half)
  // Gaussian weights by recurrence: w(d+1) = w(d) exp(k(2d+1)), and that
  // ratio itself grows by exp(2k) per step, so only three exp calls are needed.
  const k = -0.5 / (sigma * sigma)
  const d0 = i0 - pos
  const w0 = Math.exp(k * d0 * d0)
  const r0 = Math.exp(k * (2 * d0 + 1))
  const q = Math.exp(2 * k)
  let sum = 0
  let w = w0
  let r = r0
  for (let i = i0; i <= i1; i++) {
    sum += w
    w *= r
    r *= q
  }
  if (!(sum > 0)) return
  const g = amp / sum
  w = w0
  r = r0
  for (let i = i0; i <= i1; i++) {
    buf[i] += g * w
    w *= r
    r *= q
  }
}

/** Gaussian width in samples for a -3 dB point at fc. */
function sigmaFor(sr, fc) {
  return (0.1325 * sr) / Math.max(20, fc)
}

function panGains(pan) {
  const p = clamp(pan, -1, 1)
  return [Math.sqrt(1 - p), Math.sqrt(1 + p)]
}

/**
 * One discrete echo: Gaussian pulse plus an optional rough-surface burst.
 * gain is linear relative to the direct sound, pan -1..1, cutoff Hz.
 */
function addEcho(L, R, sr, tSec, gain, pan, cutoff, smearMs, rng) {
  const itd = 0.00066 * sr
  const [gl, gr] = panGains(pan * 0.9)
  const pos = tSec * sr
  const sig = sigmaFor(sr, cutoff)
  const smear = Math.max(0, num(smearMs, 0))
  const pulseShare = smear > 0 ? 0.55 : 1
  const pa = gain * Math.sqrt(pulseShare)
  splat(L, pos + Math.max(0, pan) * itd, pa * gl, sig)
  splat(R, pos + Math.max(0, -pan) * itd, pa * gr, sig)
  if (smear > 0) {
    const tau = (smear / 1000) * sr
    const len = Math.min(Math.ceil(tau * 5), L.length)
    const start = Math.floor(pos)
    if (start >= L.length || len < 2) return
    const burst = new Float32Array(len)
    const chans = [[L, gl], [R, gr]]
    for (let c = 0; c < 2; c++) {
      const r = rng.fork('smear' + c)
      const m = Math.exp(-1 / tau)
      let env = 1
      let e = 0
      for (let i = 0; i < len; i++) {
        burst[i] = (r.next() * 2 - 1) * env
        env *= m
      }
      new Biquad('lowpass', sr, Math.min(cutoff, 0.45 * sr), 0.6).run(burst)
      for (let i = 0; i < len; i++) e += burst[i] * burst[i]
      if (!(e > 0)) continue
      const g = (gain * Math.sqrt(1 - pulseShare)) / Math.sqrt(e)
      const [dst, pg] = chans[c]
      const end = Math.min(dst.length, start + len)
      for (let i = start; i < end; i++) dst[i] += burst[i - start] * g * pg
    }
  }
}

// ---------- room geometry ----------

const WALLS = ['x0', 'x1', 'y0', 'y1', 'floor', 'ceiling']

function roomDims(spec) {
  const s = spec.size
  if (Array.isArray(s) && s.length >= 3) return [Math.max(0.03, num(s[0], 4)), Math.max(0.03, num(s[1], 5)), Math.max(0.03, num(s[2], 2.5))]
  const v = Math.max(0.03, num(s, 5))
  return [v * 0.8, v, Math.min(v * 0.5, Math.max(2.4, v * 0.3))]
}

function eyringBeta(dims, decay) {
  const [x, y, z] = dims
  const V = x * y * z
  const S = 2 * (x * y + x * z + y * z)
  const a = 1 - Math.exp((-0.161 * V) / (S * Math.max(0.02, decay)))
  return Math.sqrt(1 - clamp(a, 0.01, 0.99))
}

function wallBetas(dims, decay, reflect) {
  const b = eyringBeta(dims, decay)
  const out = [b, b, b, b, b, b]
  if (reflect && typeof reflect === 'object') {
    if (Array.isArray(reflect)) {
      for (let i = 0; i < 6 && i < reflect.length; i++) if (Number.isFinite(reflect[i])) out[i] = clamp(reflect[i], 0, 0.999)
    } else {
      for (let i = 0; i < 6; i++) {
        const v = reflect[WALLS[i]]
        if (Number.isFinite(v)) out[i] = clamp(v, 0, 0.999)
      }
    }
  }
  return out
}

function positions(dims, spec) {
  const [X, Y, Z] = dims
  let dist = num(spec.distance, clamp(0.3 * Math.min(X, Y), 0.3, 6))
  const lisF = Array.isArray(spec.lis) ? spec.lis : null
  const lis = lisF
    ? [clamp(num(lisF[0], 0.5), 0.02, 0.98) * X, clamp(num(lisF[1], 0.3), 0.02, 0.98) * Y, clamp(num(lisF[2], 0.5), 0.02, 0.98) * Z]
    : [0.57 * X, 0.3 * Y, Math.min(1.5, 0.5 * Z)]
  let src
  if (Array.isArray(spec.src)) {
    src = [clamp(num(spec.src[0], 0.5), 0.02, 0.98) * X, clamp(num(spec.src[1], 0.6), 0.02, 0.98) * Y, clamp(num(spec.src[2], 0.5), 0.02, 0.98) * Z]
  } else {
    const dx = -0.12 * X
    const maxY = 0.96 * Y - lis[1]
    let dy = Math.sqrt(Math.max(0, dist * dist - dx * dx))
    if (dy > maxY) dy = Math.max(0.01, maxY)
    src = [lis[0] + dx, lis[1] + dy, lis[2] + Math.min(0.1, 0.05 * Z)]
  }
  return { lis, src }
}

/** Image-source early reflections into L and R. Returns stats for the tail. */
function imageSource(L, R, sr, spec, dims, betas, rng, startSamp) {
  const [X, Y, Z] = dims
  const { lis, src } = positions(dims, spec)
  const d0 = Math.max(0.02, Math.hypot(src[0] - lis[0], src[1] - lis[1], src[2] - lis[2]))
  const V = X * Y * Z
  let erEnd = num(spec.erMs, 0) / 1000
  if (!(erEnd > 0)) {
    const S = 2 * (X * Y + X * Z + Y * Z)
    erEnd = clamp(((6 * 4 * V) / S / C), 0.025, 0.12)
  }
  // Keep the image count bounded for tiny, very reflective spaces.
  const maxImages = 60000
  const rCap = Math.cbrt((maxImages * V * 3) / (4 * Math.PI))
  if (C * erEnd > rCap) erEnd = rCap / C
  const rMax = d0 + C * erEnd
  const nx = Math.min(64, Math.ceil(rMax / X) + 1)
  const ny = Math.min(64, Math.ceil(rMax / Y) + 1)
  const nz = Math.min(64, Math.ceil(rMax / Z) + 1)
  const damping = clamp(num(spec.damping, 0.5), 0, 1)
  const fWall = 16000 * Math.pow(2, -4 * damping)
  const s1sq = Math.pow(sigmaFor(sr, fWall), 2)
  // Real absorbers stop darkening a reflection at some point; no reflection
  // is blurred below a 350 Hz corner.
  const sigMax = sigmaFor(sr, 350)
  const irregular = clamp(num(spec.irregular, 0), 0, 1)
  const itd = 0.00066 * sr
  const fadeStart = 0.6 * erEnd
  const rMax2 = rMax * rMax
  const [bx0, bx1, by0, by1, bz0, bz1] = betas
  const gMin = 1e-4
  let count = 0
  for (let qx = -nx; qx <= nx; qx++) {
    const ix = (qx & 1) === 0 ? qx * X + src[0] : (qx + 1) * X - src[0]
    const ax = qx >= 0 ? Math.pow(bx1, Math.ceil(qx / 2)) * Math.pow(bx0, Math.floor(qx / 2)) : Math.pow(bx0, Math.ceil(-qx / 2)) * Math.pow(bx1, Math.floor(-qx / 2))
    const dx = ix - lis[0]
    if (dx * dx > rMax2 || ax < gMin) continue
    for (let qy = -ny; qy <= ny; qy++) {
      const iy = (qy & 1) === 0 ? qy * Y + src[1] : (qy + 1) * Y - src[1]
      const ay = qy >= 0 ? Math.pow(by1, Math.ceil(qy / 2)) * Math.pow(by0, Math.floor(qy / 2)) : Math.pow(by0, Math.ceil(-qy / 2)) * Math.pow(by1, Math.floor(-qy / 2))
      const dy = iy - lis[1]
      const dxy = dx * dx + dy * dy
      if (dxy > rMax2 || ax * ay < gMin) continue
      for (let qz = -nz; qz <= nz; qz++) {
        if (qx === 0 && qy === 0 && qz === 0) continue
        const iz = (qz & 1) === 0 ? qz * Z + src[2] : (qz + 1) * Z - src[2]
        const dz = iz - lis[2]
        const d2 = dxy + dz * dz
        if (d2 > rMax2) continue
        const az = qz >= 0 ? Math.pow(bz1, Math.ceil(qz / 2)) * Math.pow(bz0, Math.floor(qz / 2)) : Math.pow(bz0, Math.ceil(-qz / 2)) * Math.pow(bz1, Math.floor(-qz / 2))
        const d = Math.sqrt(d2)
        let g = (ax * ay * az * d0) / d
        if (g < gMin) continue
        let t = (d - d0) / C
        if (t > erEnd) continue
        if (irregular > 0) {
          t += irregular * (rng.next() - 0.5) * (0.04 * t + 0.0006)
          if (t < 0) t = 0
          g *= 1 + irregular * (rng.next() - 0.5)
        }
        if (t > fadeStart) g *= 0.5 + 0.5 * Math.cos((Math.PI * (t - fadeStart)) / (erEnd - fadeStart))
        const order = (qx < 0 ? -qx : qx) + (qy < 0 ? -qy : qy) + (qz < 0 ? -qz : qz)
        const sAir = sigmaFor(sr, 43300 / Math.sqrt(Math.max(1, d)))
        let sigma = Math.sqrt(s1sq * order + sAir * sAir)
        if (sigma > sigMax) sigma = sigMax
        const pan = (0.85 * dx) / d
        const [gl, gr] = panGains(pan)
        const pos = startSamp + t * sr
        splat(L, pos + Math.max(0, pan) * itd, g * gl, sigma)
        splat(R, pos + Math.max(0, -pan) * itd, g * gr, sigma)
        count++
      }
    }
  }
  const S = 2 * (X * Y + X * Z + Y * Z)
  const areas = [Y * Z, Y * Z, X * Z, X * Z, X * Y, X * Y]
  let b2 = 0
  for (let i = 0; i < 6; i++) b2 += areas[i] * betas[i] * betas[i]
  b2 /= S
  return { d0, V, S, b2, erEnd, count }
}

// ---------- late tail ----------

const BAND_NORM = new Map()

function bandPlan(sr) {
  const centers = []
  for (let f = 62.5; f <= 16000 && f < 0.42 * sr; f *= 2) centers.push(f)
  if (centers.length < 2) centers.push(Math.min(0.3 * sr, 125))
  const specs = centers.map((f, i) => {
    if (i === 0) return { type: 'lowpass', f: f * Math.SQRT2, q: 0.707 }
    if (i === centers.length - 1) return { type: 'highpass', f: f / Math.SQRT2, q: 0.707 }
    return { type: 'bandpass', f, q: Math.SQRT2 }
  })
  let norm = BAND_NORM.get(sr)
  if (!norm) {
    const filters = specs.map((s) => new Biquad(s.type, sr, s.f, s.q))
    let acc = 0
    const pts = 400
    for (let k = 1; k <= pts; k++) {
      const hz = (k / (pts + 1)) * 0.5 * sr
      let p = 0
      for (let b = 0; b < filters.length; b++) p += Math.pow(10, filters[b].magnitudeDb(hz) / 10)
      acc += p
    }
    norm = 1 / Math.sqrt(acc / pts)
    BAND_NORM.set(sr, norm)
  }
  return { centers, specs, norm }
}

function bandDecay(f, decay, damping, bassRatio) {
  let g = 1 / (1 + damping * 1.6 * Math.max(0, Math.log2(f / 1500)))
  if (f < 500) g *= 1 + (bassRatio - 1) * Math.min(1, Math.log2(500 / f) / 2)
  return Math.max(0.02, decay * g)
}

/**
 * One channel of banded, exponentially decaying noise, unit level at onset
 * (mid band amplitude 1 at t0). opts: { t0, ramp, rampPow, decay, damping,
 * bassRatio, density, dispersionMs }.
 */
function bandTail(N, sr, o, rng) {
  const out = new Float32Array(N)
  const plan = bandPlan(sr)
  const tmp = new Float32Array(N)
  const density = clamp(num(o.density, 1), 0, 1)
  const p = density >= 1 ? 1 : Math.min(1, (300 * Math.pow(sr / 300, density)) / sr)
  const pulseAmp = 1 / Math.sqrt(p)
  // Uniform noise of unit variance from a 32-bit xorshift (Marsaglia 2003)
  // seeded per band from the forked rng: the tail is the heaviest loop in
  // the file, and an inline integer generator is several times faster than
  // a function call per sample. Reverb noise needs no better statistics.
  const uScale = Math.sqrt(3) / 2147483648
  const pThresh = Math.floor(p * 2147483648)
  const fTop = plan.centers[plan.centers.length - 1]
  for (let b = 0; b < plan.centers.length; b++) {
    const fc = plan.centers[b]
    const rt = bandDecay(fc, o.decay, o.damping, o.bassRatio)
    const w = plan.norm / Math.sqrt(1 + o.damping * Math.max(0, Math.log2(fc / 2000)))
    const disp = o.dispersionMs > 0 ? (o.dispersionMs / 1000) * (Math.sqrt(1000 / fc) - Math.sqrt(1000 / fTop)) : 0
    const t0 = o.t0 + disp
    const s0 = Math.max(0, Math.floor(t0 * sr))
    if (s0 >= N) continue
    const m = Math.exp(-6.91 / (rt * sr))
    const ramp = Math.max(1, Math.round(o.ramp * sr))
    let x = (rng.fork('band' + b).uint32() | 1) | 0
    // Each band starts at full level when it arrives (later for low bands
    // on a dispersive plate) and decays from there.
    let env = w
    const stopLevel = env * 1e-6
    let i = s0
    tmp.fill(0, s0)
    for (; i < N; i++) {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      let nz
      if (p >= 1) nz = x * uScale
      else {
        // Compare the low 31 bits against p; the top bit picks the sign.
        nz = (x & 0x7fffffff) < pThresh ? (x < 0 ? -pulseAmp : pulseAmp) : 0
      }
      let fade = 1
      const k = i - s0
      if (k < ramp) {
        fade = 0.5 - 0.5 * Math.cos((Math.PI * k) / ramp)
        if (o.rampPow !== 1) fade = Math.pow(fade, o.rampPow)
      }
      tmp[i] = nz * env * fade
      env *= m
      if (env < stopLevel) break
    }
    const end = Math.min(N, i + Math.ceil(sr * 0.05))
    const seg = tmp.subarray(s0, end)
    const spec = plan.specs[b]
    new Biquad(spec.type, sr, spec.f, spec.q).run(seg)
    for (let j = s0; j < end; j++) out[j] += tmp[j]
  }
  return out
}

function stereoTail(N, sr, o, rng, width) {
  const A = bandTail(N, sr, o, rng.fork('tailA'))
  const B = bandTail(N, sr, o, rng.fork('tailB'))
  const w = clamp(num(width, 1), 0, 1)
  if (w < 1) {
    const c = 1 - w
    const s = Math.sqrt(1 - c * c)
    for (let i = 0; i < N; i++) B[i] = c * A[i] + s * B[i]
  }
  return [A, B]
}

// ---------- springs ----------

function springChannel(N, sr, sp, decay, startSamp) {
  const out = new Float32Array(N)
  const fc = Math.min(num(sp.fc, 4200), 0.45 * sr)
  const K = Math.max(1, Math.round(sr / (2 * fc)))
  const M = Math.max(1, Math.round(num(sp.sections, 40)))
  const a = clamp(num(sp.a, 0.65), -0.95, 0.95)
  const T = Math.max(2, Math.round((num(sp.ms, 36) / 1000) * sr))
  // Loop time = delay plus the cascade's group delay near 1 kHz.
  const w = (2 * Math.PI * 1000 * K) / sr
  const gdSec = (K * (1 - a * a)) / (1 + a * a + 2 * a * Math.cos(w))
  const loop = (T + M * gdSec) / sr
  const g = Math.pow(10, (-3 * loop) / Math.max(0.05, decay))
  const xs = new Float64Array(M * K)
  const ys = new Float64Array(M * K)
  const dl = new DelayLine(T + 4)
  let p = 0
  let lp1 = 0, lp2 = 0, hpS = 0
  const aLp = 1 - Math.exp((-2 * Math.PI * fc * 1.1) / sr)
  const aHp = 1 - Math.exp((-2 * Math.PI * 90) / sr)
  let quiet = 0
  for (let n = startSamp; n < N; n++) {
    let v = (n === startSamp ? 1 : 0) + g * dl.read(T - 1)
    for (let m = 0; m < M; m++) {
      const o = m * K + p
      const xd = xs[o]
      const yd = ys[o]
      let y = a * v + xd - a * yd
      if (y < 1e-25 && y > -1e-25) y = 0
      xs[o] = v
      ys[o] = y
      v = y
    }
    p++
    if (p === K) p = 0
    lp1 += aLp * (v - lp1)
    lp2 += aLp * (lp1 - lp2)
    hpS += aHp * (lp2 - hpS)
    let y = lp2 - hpS
    if (y < 1e-25 && y > -1e-25) y = 0
    dl.write(y)
    out[n] = y
    if (y < 1e-7 && y > -1e-7) {
      if (++quiet > T * 3 && n > startSamp + T * 4) break
    } else quiet = 0
  }
  return out
}

// ---------- whole-response shaping ----------

function applyComb(sig, sr, ms, fb, cutoff) {
  const D = Math.max(1, (ms / 1000) * sr)
  const line = new DelayLine(Math.ceil(D) + 4)
  const a = 1 - Math.exp((-2 * Math.PI * Math.min(num(cutoff, 0.45 * sr), 0.45 * sr)) / sr)
  const f = clamp(fb, -0.97, 0.97)
  let s = 0
  for (let i = 0; i < sig.length; i++) {
    const back = line.read(D - 1)
    s += a * (back - s)
    if (s < 1e-25 && s > -1e-25) s = 0
    const y = sig[i] + f * s
    line.write(y)
    sig[i] = y
  }
}

function autoModes(dims, spec, sr) {
  const out = []
  const gain = num(spec.modeGain, 6)
  const fmax = num(spec.modeMax, Math.min(0.4 * sr, Math.max(300, (3 * C) / (2 * Math.min(dims[0], dims[1], dims[2])))))
  const rt = num(spec.modeDecay, Math.min(num(spec.decay, 0.5) * 1.5, 0.6))
  for (let ax = 0; ax < 3; ax++) {
    const f1 = C / (2 * dims[ax])
    for (let k = 1; k <= 8; k++) {
      const f = f1 * k
      if (f > fmax || f > 0.42 * sr) break
      if (f < 40) continue
      const q = clamp((Math.PI * f * rt) / 6.91, 3, 80)
      out.push([f, q, gain / Math.sqrt(k)])
    }
  }
  return out.slice(0, 24)
}

function applyModes(L, R, sr, modes) {
  for (let i = 0; i < modes.length; i++) {
    const m = modes[i]
    if (!m) continue
    const f = num(m[0], 0)
    if (!(f > 20) || f > 0.45 * sr) continue
    const q = clamp(num(m[1], 8), 0.3, 400)
    const g = clamp(num(m[2], 6), -30, 30)
    new Biquad('peak', sr, f, q, g).run(L)
    new Biquad('peak', sr, Math.min(f * 1.004, 0.45 * sr), q, g).run(R)
  }
}

function cutSpec(v) {
  // [Hz, dB per octave]: each second-order section adds 12 dB per octave.
  if (Array.isArray(v)) return { hz: num(v[0], 0), order: clamp(Math.round(num(v[1], 12) / 12), 1, 4) }
  return { hz: num(v, 0), order: 1 }
}

function energy(ch) {
  let e = 0
  for (let c = 0; c < ch.length; c++) {
    const s = ch[c]
    for (let i = 0; i < s.length; i++) e += s[i] * s[i]
  }
  return e / ch.length
}

// Speech weighting for level matching: a 100 Hz high pass and a gentle
// -6 dB per octave slope above 700 Hz, roughly the long-term spectrum of
// speech (Byrne and colleagues 1994, the LTASS). Responses are scaled so
// that speech-shaped sound has the same energy through them as through a
// bare impulse: a voice keeps about its loudness in every space, whether
// the space is a bright hall or a muffled blanket.
function weightedEnergy(sig, sr) {
  const w = new Float32Array(sig)
  new Biquad('highpass', sr, 100, 0.707).run(w)
  new OnePole(sr, 700, 'lp').run(w)
  let e = 0
  for (let i = 0; i < w.length; i++) e += w[i] * w[i]
  return e
}

const REF_ENERGY = new Map()

function speechGain(L, R, sr) {
  let ref = REF_ENERGY.get(sr)
  if (!ref) {
    const d = new Float32Array(Math.round(sr * 0.25))
    d[0] = 1
    ref = weightedEnergy(d, sr)
    REF_ENERGY.set(sr, ref)
  }
  const e = 0.5 * (weightedEnergy(L, sr) + weightedEnergy(R, sr))
  return e > 0 ? Math.sqrt(ref / e) : 0
}

// ---------- shapes ----------

const SHAPES = {
  room: { decay: 0.6, damping: 0.5, bassRatio: 1, density: 1, early: 'auto' },
  hall: { decay: 1.8, damping: 0.45, bassRatio: 1.15, density: 1, early: 'auto' },
  box: { decay: 0.25, damping: 0.3, bassRatio: 1, density: 1, early: 'auto', modes: 'auto' },
  pipe: { decay: 1.5, damping: 0.4, bassRatio: 1.1, density: 0.8, early: 'auto', modes: 'auto' },
  plate: { decay: 2.2, damping: 0.12, bassRatio: 0.85, density: 1, early: null, direct: 0, dispersionMs: 3.5, lowCut: 120 },
  spring: { decay: 2.5, damping: 0.6, bassRatio: 1, density: 1, early: null, direct: 0, lowCut: 100 },
  outdoor: { decay: 0.6, damping: 0.6, bassRatio: 1, density: 0.7, early: null, tailDb: -24 },
}

/**
 * Build a stereo impulse response from a description.
 *
 * spec (all optional): { shape: 'room'|'hall'|'plate'|'spring'|'pipe'|'box'|'outdoor',
 *   seconds, decay (RT60 s), predelayMs, direct (gain of the dry path, default 1;
 *   0 for plate and spring), early: 'auto' | [[ms, gain, pan, cutoffHz?, smearMs?]...] | null,
 *   size (m, or [width, depth, height]), distance (talker to listener, m),
 *   lis / src ([fx, fy, fz] fractions of the room), reflect ({x0,x1,y0,y1,floor,ceiling}
 *   or a 6-array of wall reflection coefficients), erMs (image-source window),
 *   irregular 0..1, damping 0..1, bassRatio, density 0..1, width 0..1,
 *   tailGain (x the matched level), tailDb (tail energy re the direct, for shapes
 *   without image sources), bloomMs (slow swell of the tail), dispersionMs,
 *   echoes: [[ms, gain, pan, cutoffHz, smearMs]...], scatter: { count, fromMs, toMs,
 *   gainDb: [lo, hi], cutoff: [lo, hi], smearMs: [lo, hi] },
 *   springs: [{ ms, a, sections, fc }...], combs: [[ms, feedback, cutoffHz]...],
 *   modes: 'auto' | [[hz, q, gainDb]...], modeGain, modeDecay, modeMax,
 *   lowCut, highCut (Hz, or [Hz, dB per octave 12|24|36]), eq: [{type, freq, q, gain}...] }
 */
export function roomIR(sr, spec = {}, rng) {
  const shapeName = SHAPES[spec.shape] ? spec.shape : 'room'
  const S = Object.assign({}, SHAPES[shapeName], spec)
  const decay = clamp(num(S.decay, 1), 0.02, 120)
  const damping = clamp(num(S.damping, 0.5), 0, 1)
  const bassRatio = clamp(num(S.bassRatio, 1), 0.3, 3)
  const density = clamp(num(S.density, 1), 0, 1)
  const pre = Math.max(0, num(S.predelayMs, 0)) / 1000
  const preSamp = pre * sr
  const R0 = rngOf(rng, 'room')
  const dims = roomDims(S)

  // Length.
  let ringExtra = 0
  if (Array.isArray(S.combs)) {
    for (const cb of S.combs) {
      const fb = Math.abs(num(cb && cb[1], 0))
      if (fb > 0.01) ringExtra = Math.max(ringExtra, (6.91 * (num(cb[0], 1) / 1000)) / -Math.log(Math.min(0.97, fb)))
    }
  }
  let lastEcho = 0
  const echoList = []
  if (Array.isArray(S.early)) for (const e of S.early) echoList.push(e)
  if (Array.isArray(S.echoes)) for (const e of S.echoes) echoList.push(e)
  for (const e of echoList) if (e) lastEcho = Math.max(lastEcho, num(e[0], 0) / 1000 + (num(e[4], 0) * 5) / 1000)
  if (S.scatter) lastEcho = Math.max(lastEcho, num(S.scatter.toMs, 200) / 1000 + 0.08)
  const erGuess = S.early === 'auto' ? Math.max(0.03, num(S.erMs, 120) / 1000) : 0
  const bloom = Math.max(0, num(S.bloomMs, 0)) / 1000
  const longest = decay * Math.max(1, bassRatio) * 1.05
  let seconds = num(S.seconds, pre + Math.max(erGuess, lastEcho) + bloom + longest + ringExtra + 0.05)
  seconds = clamp(seconds, 0.02, 30)
  const N = Math.max(2, Math.round(seconds * sr))
  const L = new Float32Array(N)
  const R = new Float32Array(N)

  // 1. Direct sound.
  const direct = num(S.direct, 1)
  L[0] += direct
  R[0] += direct

  // 2. Early reflections.
  let isStats = null
  if (S.early === 'auto' && (shapeName === 'room' || shapeName === 'hall' || shapeName === 'box' || shapeName === 'pipe')) {
    const betas = wallBetas(dims, decay, S.reflect)
    const eL = new Float32Array(N)
    const eR = new Float32Array(N)
    isStats = imageSource(eL, eR, sr, S, dims, betas, R0.fork('images'), preSamp)
    // Thousands of positive, wall-blurred pulses add up to a slow pressure
    // hump that no mouth can radiate. A high pass (24 dB per octave) at 60 Hz,
    // or at a third of the lowest mode for tiny spaces, keeps the room's boom
    // and removes the hump. The tail carries the low end of big rooms.
    const fHp = clamp((0.35 * C) / (2 * Math.max(dims[0], dims[1], dims[2])), 60, 250)
    for (let k = 0; k < 2; k++) {
      new Biquad('highpass', sr, fHp, 0.707).run(eL)
      new Biquad('highpass', sr, fHp, 0.707).run(eR)
    }
    for (let i = 0; i < N; i++) {
      L[i] += eL[i]
      R[i] += eR[i]
    }
  }
  const echoRng = R0.fork('echoes')
  for (let k = 0; k < echoList.length; k++) {
    const e = echoList[k]
    if (!e) continue
    addEcho(L, R, sr, pre + num(e[0], 0) / 1000, num(e[1], 0.3), num(e[2], 0), num(e[3], 8000), num(e[4], 0), echoRng.fork('e' + k))
  }
  if (S.scatter && typeof S.scatter === 'object') {
    const sc = S.scatter
    const r = R0.fork('scatter')
    const count = clamp(Math.round(num(sc.count, 30)), 0, 2000)
    const from = num(sc.fromMs, 5)
    const to = Math.max(from, num(sc.toMs, 200))
    const gdb = Array.isArray(sc.gainDb) ? sc.gainDb : [-30, -18]
    const cut = Array.isArray(sc.cutoff) ? sc.cutoff : [2000, 6000]
    const sm = Array.isArray(sc.smearMs) ? sc.smearMs : [0, 0]
    for (let k = 0; k < count; k++) {
      // Times cluster early (square-root spread), levels fall with time.
      const u = r.next()
      const t = from + (to - from) * u * u
      const lvl = gdb[0] + (gdb[1] - gdb[0]) * r.next() - 6 * u
      addEcho(L, R, sr, pre + t / 1000, Math.pow(10, lvl / 20), r.range(-0.9, 0.9), Math.exp(r.range(Math.log(cut[0]), Math.log(cut[1]))), r.range(sm[0], sm[1]), r.fork('s' + k))
    }
  }

  // 3/4. Tail.
  const tailGain = Math.max(0, num(S.tailGain, 1))
  let tail = null
  if (shapeName === 'spring') {
    const springs = Array.isArray(S.springs) && S.springs.length ? S.springs : [{ ms: 34, a: 0.64 }, { ms: 41.5, a: 0.7 }]
    const parts = springs.map((sp) => springChannel(N, sr, sp, decay, Math.max(0, Math.round(preSamp))))
    const sL = new Float32Array(N)
    const sR = new Float32Array(N)
    for (let k = 0; k < parts.length; k++) {
      const wl = parts.length === 1 ? 1 : k % 2 === 0 ? 0.85 : 0.35
      const wr = parts.length === 1 ? 1 : k % 2 === 0 ? 0.35 : 0.85
      const pk = parts[k]
      for (let i = 0; i < N; i++) {
        sL[i] += pk[i] * wl
        sR[i] += pk[i] * wr
      }
    }
    const e = energy([sL, sR])
    const g = e > 0 ? 1 / Math.sqrt(e) : 0
    for (let i = 0; i < N; i++) {
      L[i] += sL[i] * g
      R[i] += sR[i] * g
    }
    // A little diffuse fill under the chirps.
    const fillDb = num(S.tailDb, -14)
    tail = { db: fillDb, o: { t0: pre + 0.01, ramp: 0.02, rampPow: 1, decay, damping, bassRatio, density, dispersionMs: 0 } }
  } else if (isStats) {
    const t0 = Math.max(0.0005, Math.min(isStats.erEnd * 0.15, 0.004)) + pre
    const tm = pre + isStats.erEnd * 0.8
    const tEmit = tm - pre + isStats.d0 / C
    const bounces = (C * tEmit * isStats.S) / (4 * isStats.V)
    const P = ((4 * Math.PI * C * isStats.d0 * isStats.d0) / (isStats.V * sr)) * Math.pow(isStats.b2, bounces)
    const atTm = Math.sqrt(P)
    const A0 = atTm * Math.exp((6.91 * (tm - t0)) / decay) * tailGain
    tail = { A0, o: { t0, ramp: Math.max(0.002, tm - t0) + bloom, rampPow: 2, decay, damping, bassRatio, density, dispersionMs: 0 } }
  } else {
    const t0 = pre + Math.max(0.001, num(S.tailStartMs, shapeName === 'outdoor' ? 8 : 0.5) / 1000)
    tail = { db: num(S.tailDb, shapeName === 'plate' ? 0 : -24), o: { t0, ramp: (shapeName === 'plate' ? 0.0015 : 0.02) + bloom, rampPow: bloom > 0 ? 1.5 : 1, decay, damping, bassRatio, density, dispersionMs: num(S.dispersionMs, 0) } }
  }
  if (tail && (tail.A0 === undefined || tail.A0 > 0)) {
    const [tA, tB] = stereoTail(N, sr, tail.o, R0.fork('tail'), S.width)
    let g
    if (tail.A0 !== undefined) g = tail.A0
    else {
      // Tail energy relative to a unit direct impulse (or to the unit-energy springs).
      const e = energy([tA, tB])
      g = e > 0 ? Math.sqrt(Math.pow(10, tail.db / 10) / e) * tailGain : 0
    }
    for (let i = 0; i < N; i++) {
      L[i] += tA[i] * g
      R[i] += tB[i] * g
    }
  }

  // Whole-response shaping.
  if (Array.isArray(S.combs)) {
    for (const cb of S.combs) {
      if (!cb) continue
      const ms = num(cb[0], 0)
      if (!(ms > 0)) continue
      applyComb(L, sr, ms, num(cb[1], 0.5), num(cb[2], 8000))
      applyComb(R, sr, ms * 1.003, num(cb[1], 0.5), num(cb[2], 8000))
    }
  }
  let modes = []
  if (S.modes === 'auto') modes = autoModes(dims, S, sr)
  else if (Array.isArray(S.modes)) modes = S.modes
  if (Array.isArray(S.extraModes)) modes = modes.concat(S.extraModes)
  if (modes.length) applyModes(L, R, sr, modes)
  if (S.lowCut) {
    const c = cutSpec(S.lowCut)
    if (c.hz > 5) for (let k = 0; k < c.order; k++) { new Biquad('highpass', sr, c.hz, 0.707).run(L); new Biquad('highpass', sr, c.hz, 0.707).run(R) }
  }
  if (S.highCut) {
    const c = cutSpec(S.highCut)
    if (c.hz > 20 && c.hz < 0.49 * sr) for (let k = 0; k < c.order; k++) { new Biquad('lowpass', sr, c.hz, 0.707).run(L); new Biquad('lowpass', sr, c.hz, 0.707).run(R) }
  }
  if (Array.isArray(S.eq) && S.eq.length) {
    const eq = S.eq.filter((e) => e && num(e.freq, 0) > 0 && num(e.freq, 0) < 0.45 * sr)
    filterChain(L, sr, eq)
    filterChain(R, sr, eq)
  }

  // Fade the end, then normalise.
  for (let i = 0; i < N; i++) {
    if (!(L[i] > -1e30 && L[i] < 1e30)) L[i] = 0
    if (!(R[i] > -1e30 && R[i] < 1e30)) R[i] = 0
  }
  const fadeN = Math.min(N - 1, Math.max(Math.round(0.01 * sr), Math.min(Math.round(0.25 * N), Math.round(4 * sr))))
  for (let k = 0; k < fadeN; k++) {
    const w = 0.5 - 0.5 * Math.cos((Math.PI * (k + 0.5)) / fadeN)
    L[N - 1 - k] *= w
    R[N - 1 - k] *= w
  }
  const g = speechGain(L, R, sr)
  for (let i = 0; i < N; i++) {
    let l = L[i] * g
    let r = R[i] * g
    if (l < 1e-30 && l > -1e-30) l = 0
    if (r < 1e-30 && r > -1e-30) r = 0
    L[i] = l
    R[i] = r
  }
  return { sr, ch: [L, R] }
}

// ---------- the named spaces ----------

/**
 * Every named space: a plain spoken description and the spec that builds it.
 * Sizes are [width, depth, height] in metres.
 */
export const SPACES = {
  closet: {
    about: 'A small closet full of clothes: close, boxy and muffled.',
    spec: { shape: 'box', size: [1.0, 0.8, 2.4], decay: 0.18, damping: 0.85, distance: 0.45, irregular: 0.4, erMs: 30, modeGain: 3, lowCut: 90, highCut: 6500, tailGain: 0.7, eq: [{ type: 'peak', freq: 260, q: 1, gain: 3 }] },
  },
  bathroom: {
    about: 'A tiled bathroom: bright, ringing and close.',
    spec: { shape: 'room', size: [2.6, 1.9, 2.4], decay: 0.85, damping: 0.12, distance: 1.0, erMs: 50, modes: 'auto', modeGain: 4, eq: [{ type: 'peak', freq: 3500, q: 0.9, gain: 2 }] },
  },
  shower: {
    about: 'Inside a glass and tile shower stall: splashy, bright and boomy.',
    spec: { shape: 'box', size: [0.95, 0.9, 2.2], decay: 0.75, damping: 0.06, distance: 0.4, erMs: 35, modeGain: 7, combs: [[5.54, 0.5, 9000]], eq: [{ type: 'peak', freq: 4500, q: 0.8, gain: 3 }] },
  },
  kitchen: {
    about: 'A kitchen with hard counters and cabinets: lively and clear.',
    spec: { shape: 'room', size: [4.2, 3.4, 2.5], decay: 0.6, damping: 0.3, distance: 1.6, erMs: 60, irregular: 0.2, eq: [{ type: 'peak', freq: 2000, q: 1, gain: 1.5 }] },
  },
  'living-room': {
    about: 'A furnished living room: warm, soft and natural.',
    spec: { shape: 'room', size: [5.8, 4.6, 2.5], decay: 0.45, damping: 0.6, bassRatio: 1.15, distance: 2.0, irregular: 0.35, highCut: 12000 },
  },
  bedroom: {
    about: 'A carpeted bedroom with a bed and curtains: quiet and soft.',
    spec: { shape: 'room', size: [4.0, 3.4, 2.5], decay: 0.32, damping: 0.75, bassRatio: 1.1, distance: 1.2, irregular: 0.3, highCut: 10000, reflect: { floor: 0.55 } },
  },
  classroom: {
    about: 'An empty classroom with hard walls: echoey speech, a slap between walls.',
    spec: { shape: 'room', size: [9, 7.5, 3.1], decay: 0.95, damping: 0.35, distance: 4, erMs: 90, reflect: { x0: 0.9, x1: 0.9 }, eq: [{ type: 'peak', freq: 1500, q: 1, gain: 1 }] },
  },
  office: {
    about: 'An office with a tiled ceiling and carpet: dry and businesslike.',
    spec: { shape: 'room', size: [6.5, 5, 2.7], decay: 0.5, damping: 0.5, distance: 2.2, reflect: { ceiling: 0.4, floor: 0.6 }, irregular: 0.25 },
  },
  hallway: {
    about: 'A long narrow hallway: fluttering slaps between close walls.',
    spec: { shape: 'room', size: [1.9, 16, 2.6], decay: 1.0, damping: 0.35, distance: 3, erMs: 220, reflect: { x0: 0.93, x1: 0.93 }, density: 0.7, lis: [0.55, 0.25, 0.6] },
  },
  stairwell: {
    about: 'A tall concrete stairwell: hard, ringing, rising echoes.',
    spec: { shape: 'room', size: [3.2, 4.5, 16], decay: 2.8, damping: 0.25, distance: 2, erMs: 250, irregular: 0.35, density: 0.75, lis: [0.5, 0.3, 0.1], src: [0.4, 0.7, 0.1], modes: [[1250, 40, 4], [2900, 60, 3]] },
  },
  elevator: {
    about: 'A small metal elevator: tight, metallic and boxy.',
    spec: { shape: 'box', size: [1.6, 1.4, 2.4], decay: 0.4, damping: 0.2, distance: 0.7, erMs: 40, modeGain: 7, combs: [[9.33, 0.35, 7000]], lowCut: 80, eq: [{ type: 'peak', freq: 3000, q: 2, gain: 2 }] },
  },
  car: {
    about: 'Inside a car with the windows up: close, dead and a little boomy.',
    spec: { shape: 'box', size: [1.45, 1.9, 1.15], decay: 0.1, damping: 0.75, distance: 0.6, erMs: 20, modeGain: 7, lowCut: 60, highCut: 9000 },
  },
  van: {
    about: 'The back of an empty cargo van: hollow metal boom.',
    spec: { shape: 'box', size: [1.75, 3.0, 1.45], decay: 0.3, damping: 0.3, distance: 1.2, erMs: 40, modeGain: 8, combs: [[10.2, 0.4, 6000]] },
  },
  bus: {
    about: 'On a city bus: long, narrow and full of seats.',
    spec: { shape: 'room', size: [2.5, 11, 2.2], decay: 0.55, damping: 0.55, distance: 2.5, erMs: 120, reflect: { x0: 0.9, x1: 0.9 }, irregular: 0.4, modes: [[78, 6, 3]] },
  },
  'train-car': {
    about: 'Inside a train carriage: a long metal tube with seats.',
    spec: { shape: 'room', size: [2.9, 20, 2.4], decay: 0.75, damping: 0.5, distance: 3.5, erMs: 150, reflect: { x0: 0.88, x1: 0.88, ceiling: 0.8 }, irregular: 0.3, eq: [{ type: 'peak', freq: 120, q: 1.2, gain: 2 }] },
  },
  'airplane-cabin': {
    about: 'An airplane cabin: padded, dull and close, with a low hum of body.',
    spec: { shape: 'room', size: [3.6, 28, 2.1], decay: 0.35, damping: 0.8, bassRatio: 1.3, distance: 1.5, irregular: 0.5, highCut: 6500, modes: [[95, 4, 3], [190, 5, 2]] },
  },
  'phone-booth': {
    about: 'A glass phone booth: tight glassy ring, thin low end.',
    spec: { shape: 'box', size: [0.95, 0.95, 2.25], decay: 0.32, damping: 0.18, distance: 0.35, erMs: 30, modeGain: 5, combs: [[5.54, 0.35, 8000]], modes: 'auto', extraModes: [[620, 25, 5], [1720, 30, 4]], lowCut: 160 },
  },
  gym: {
    about: 'A school gym: big, hard and boomy, with a long slap between the walls.',
    spec: { shape: 'hall', size: [32, 20, 9], decay: 2.1, damping: 0.4, bassRatio: 1.1, distance: 6, erMs: 350, reflect: { y0: 0.92, y1: 0.92 }, density: 0.85, eq: [{ type: 'peak', freq: 250, q: 1, gain: 2 }] },
  },
  pool: {
    about: 'An indoor swimming pool: bright, splashy and very long.',
    spec: { shape: 'hall', size: [25, 14, 7], decay: 3.0, damping: 0.15, bassRatio: 1.0, distance: 5, erMs: 150, irregular: 0.3, reflect: { floor: 0.95 }, eq: [{ type: 'highshelf', freq: 5000, q: 0.7, gain: 3 }] },
  },
  church: {
    about: 'A stone church: warm, long and reverent.',
    spec: { shape: 'hall', size: [32, 15, 13], decay: 2.6, damping: 0.45, bassRatio: 1.2, distance: 8, erMs: 120 },
  },
  cathedral: {
    about: 'A vast cathedral: huge, dark, many seconds of sound.',
    spec: { shape: 'hall', size: [95, 35, 32], decay: 6.5, damping: 0.55, bassRatio: 1.3, distance: 12, erMs: 150, lowCut: 40 },
  },
  'concert-hall': {
    about: 'A concert hall: rich, smooth and even.',
    spec: { shape: 'hall', size: [45, 26, 18], decay: 2.0, damping: 0.42, bassRatio: 1.2, distance: 14, erMs: 110, irregular: 0.5 },
  },
  theater: {
    about: 'A theater with velvet seats: warm, medium and clear.',
    spec: { shape: 'hall', size: [24, 20, 12], decay: 1.25, damping: 0.55, bassRatio: 1.1, distance: 9, erMs: 90, irregular: 0.4 },
  },
  stadium: {
    about: 'An open stadium: the voice flies out and comes back from the stands.',
    spec: {
      shape: 'outdoor', decay: 2.4, damping: 0.5, density: 0.7, tailDb: -9, tailStartMs: 60, highCut: 12000,
      echoes: [[4.5, 0.4, 0, 3000, 0], [420, 0.25, -0.5, 3500, 120], [640, 0.2, 0.6, 2800, 160], [910, 0.12, 0.1, 2000, 220]],
      scatter: { count: 30, fromMs: 60, toMs: 400, gainDb: [-30, -20], cutoff: [1500, 4000], smearMs: [10, 40] },
    },
  },
  arena: {
    about: 'A huge roofed arena: a big boomy wash and a late slap from the far wall.',
    spec: { shape: 'hall', size: [120, 90, 30], decay: 3.6, damping: 0.45, bassRatio: 1.25, distance: 15, erMs: 450, reflect: { ceiling: 0.85 }, density: 0.85 },
  },
  'parking-garage': {
    about: 'An underground parking garage: concrete, low ceiling, a hard zingy echo.',
    spec: { shape: 'room', size: [55, 40, 2.6], decay: 2.3, damping: 0.3, distance: 4, erMs: 250, reflect: { floor: 0.95, ceiling: 0.95 }, density: 0.8, irregular: 0.25, modes: [[66, 8, 3]] },
  },
  tunnel: {
    about: 'A long road tunnel: rolling echoes along a curved tube.',
    spec: { shape: 'hall', size: [8, 200, 6], decay: 3.2, damping: 0.4, bassRatio: 1.2, distance: 5, erMs: 350, reflect: { y0: 0.3, y1: 0.3 }, density: 0.8, lis: [0.55, 0.5, 0.3] },
  },
  'subway-station': {
    about: 'A tiled underground station: bright, long and echoing.',
    spec: { shape: 'hall', size: [20, 120, 8], decay: 2.5, damping: 0.3, distance: 6, erMs: 250, irregular: 0.3, density: 0.85, lis: [0.4, 0.45, 0.2], eq: [{ type: 'peak', freq: 2500, q: 1, gain: 2 }] },
  },
  cave: {
    about: 'A deep rock cave: dark, irregular, dripping wet echoes.',
    spec: { shape: 'hall', size: [28, 40, 12], decay: 3.4, damping: 0.5, bassRatio: 1.3, distance: 6, erMs: 220, irregular: 0.9, density: 0.55, highCut: 9000, eq: [{ type: 'lowshelf', freq: 200, q: 0.7, gain: 2 }] },
  },
  canyon: {
    about: 'A rock canyon: a few long echoes that answer back, each one fainter and darker.',
    spec: {
      shape: 'outdoor', decay: 3.5, damping: 0.6, density: 0.4, tailDb: -16, tailStartMs: 250, seconds: 4.2,
      echoes: [[310, 0.5, -0.65, 6500, 30], [560, 0.36, 0.7, 5000, 45], [940, 0.24, -0.25, 3600, 70], [1420, 0.15, 0.45, 2500, 100], [2050, 0.09, -0.55, 1700, 140], [2800, 0.05, 0.2, 1100, 190]],
    },
  },
  forest: {
    about: 'In a forest: soft scattered reflections from the trees, almost no echo.',
    spec: {
      shape: 'outdoor', decay: 1.0, damping: 0.7, density: 0.6, tailDb: -15, tailStartMs: 10, highCut: 11000,
      echoes: [[3.2, 0.45, 0, 2500, 0]],
      scatter: { count: 70, fromMs: 6, toMs: 220, gainDb: [-30, -17], cutoff: [1800, 5000], smearMs: [3, 15] },
    },
  },
  field: {
    about: 'An open field: only the ground and a faint tree line far away.',
    spec: { shape: 'outdoor', decay: 0.5, damping: 0.8, density: 0.5, tailDb: -32, tailStartMs: 20, echoes: [[4.0, 0.5, 0, 2200, 0], [260, 0.035, -0.4, 1500, 60]] },
  },
  alley: {
    about: 'A brick alley between tall buildings: a quick fluttering slap, open sky above.',
    spec: { shape: 'room', size: [3.2, 40, 12], decay: 0.9, damping: 0.3, distance: 3, erMs: 300, reflect: { x0: 0.92, x1: 0.92, y0: 0.3, y1: 0.35, floor: 0.9, ceiling: 0 }, density: 0.6, lis: [0.55, 0.4, 0.13] },
  },
  warehouse: {
    about: 'An empty warehouse with a metal roof: big, boomy and bare.',
    spec: { shape: 'hall', size: [50, 32, 10], decay: 2.7, damping: 0.35, bassRatio: 1.25, distance: 7, erMs: 200, reflect: { ceiling: 0.9 }, density: 0.85, modes: [[60, 6, 3], [118, 8, 2]] },
  },
  factory: {
    about: 'A factory floor among machines: hard, cluttered and metallic.',
    spec: { shape: 'hall', size: [70, 40, 12], decay: 2.2, damping: 0.3, distance: 8, irregular: 0.7, density: 0.75, modes: [[440, 30, 3], [1310, 50, 3], [2630, 60, 2]], eq: [{ type: 'peak', freq: 2000, q: 1, gain: 2 }] },
  },
  hangar: {
    about: 'A giant aircraft hangar: enormous metal space, deep and slow.',
    spec: { shape: 'hall', size: [90, 70, 25], decay: 5.0, damping: 0.4, bassRatio: 1.4, distance: 12, erMs: 400, reflect: { ceiling: 0.92, floor: 0.95 }, density: 0.8, modes: [[48, 5, 3]] },
  },
  'metal-tank': {
    about: 'Inside a big steel tank: clanging metal flutter that rings for seconds.',
    spec: { shape: 'box', size: [3, 3, 4], decay: 3.5, damping: 0.08, distance: 1.2, erMs: 120, modeGain: 5, combs: [[17.5, 0.55, 9000], [23.3, 0.4, 8000]], extraModes: [[310, 60, 6], [735, 80, 5], [1460, 120, 4], [2380, 150, 3]] },
  },
  'sewer-pipe': {
    about: 'Down a big concrete sewer pipe: wet, hollow and rumbling away into the dark.',
    spec: { shape: 'pipe', size: [1.3, 60, 1.3], decay: 2.2, damping: 0.5, bassRatio: 1.3, distance: 3, erMs: 300, reflect: { y0: 0.6, y1: 0.6 }, combs: [[7.6, 0.5, 4000]], highCut: 8000, lis: [0.5, 0.5, 0.5], src: [0.45, 0.55, 0.5] },
  },
  'oil-drum': {
    about: 'Shouting into an empty oil drum: a booming metal ring.',
    spec: { shape: 'box', size: [0.57, 0.57, 0.88], decay: 0.9, damping: 0.12, distance: 0.3, erMs: 25, modes: [[195, 20, 6], [353, 25, 6], [390, 25, 4], [1150, 120, 4], [2600, 150, 3]], combs: [[3.32, 0.62, 7000]] },
  },
  well: {
    about: 'Calling down a deep stone well: a tight flutter and the answer from the water below.',
    spec: { shape: 'pipe', size: [1.2, 1.2, 15], decay: 1.8, damping: 0.45, bassRatio: 1.2, erMs: 600, reflect: { floor: 0.95, ceiling: 0.05 }, density: 0.7, modes: null, lis: [0.5, 0.5, 0.96], src: [0.42, 0.55, 0.95] },
  },
  'cardboard-box': {
    about: 'Head inside a cardboard box: a short papery honk.',
    spec: { shape: 'box', size: [0.55, 0.45, 0.4], decay: 0.12, damping: 0.65, distance: 0.25, erMs: 12, modeGain: 8, combs: [[2.6, 0.35, 4000]], highCut: 6000, lowCut: 120 },
  },
  'tin-can': {
    about: 'A voice in a tin can: small, nasal and metallic.',
    spec: { shape: 'box', size: [0.1, 0.1, 0.12], decay: 0.15, damping: 0.05, distance: 0.08, direct: 0.8, erMs: 5, modes: [[1429, 12, 8], [2010, 15, 8], [2858, 18, 6], [3150, 150, 5], [4700, 180, 4], [6300, 200, 3]], combs: [[0.7, 0.72, 12000]], lowCut: 350, highCut: 9000 },
  },
  'glass-jar': {
    about: 'Talking into a glass jar: hollow, close and glassy.',
    spec: { shape: 'box', size: [0.09, 0.09, 0.15], decay: 0.25, damping: 0.1, distance: 0.05, erMs: 5, modes: [[1143, 10, 7], [2235, 14, 6], [2286, 12, 4], [1900, 220, 4], [4300, 260, 4], [7400, 300, 3]], combs: [[0.875, 0.6, 10000]], lowCut: 250 },
  },
  bottle: {
    about: 'Hooting into a bottle: a deep hollow hum with an odd nasal ring.',
    spec: { shape: 'box', size: [0.08, 0.08, 0.3], decay: 0.3, damping: 0.2, distance: 0.03, erMs: 5, modes: [[118, 14, 10], [286, 10, 6], [858, 12, 4]], combs: [[1.75, -0.7, 6000]], lowCut: 80, highCut: 5000 },
  },
  helmet: {
    about: 'Inside a padded helmet: your voice right at your ears, boxy and close.',
    spec: { shape: 'box', size: [0.24, 0.28, 0.26], decay: 0.07, damping: 0.75, distance: 0.06, erMs: 6, modes: [[650, 4, 5], [1250, 5, 4], [2400, 6, 3]], combs: [[1.5, 0.3, 5000]], highCut: 7000, lowCut: 150 },
  },
  'space-suit': {
    about: 'Inside a space suit fishbowl helmet: hard glass ring all around your head.',
    spec: { shape: 'box', size: [0.34, 0.38, 0.36], decay: 0.22, damping: 0.12, distance: 0.08, erMs: 8, modes: [[470, 10, 6], [930, 12, 4], [1850, 14, 3], [5200, 80, 3]], combs: [[2.1, 0.55, 12000]], lowCut: 180, eq: [{ type: 'highshelf', freq: 6000, q: 0.7, gain: 2 }] },
  },
  'under-blanket': {
    about: 'Under a thick blanket: smothered, warm and muffled.',
    spec: { shape: 'room', size: [1.2, 1.0, 0.5], decay: 0.06, damping: 0.95, distance: 0.2, erMs: 15, tailGain: 0.3, modes: [[210, 3, 4]], highCut: [1400, 24], lowCut: 140, eq: [{ type: 'peak', freq: 400, q: 1, gain: 2 }] },
  },
  'inside-a-wall': {
    about: 'Heard from inside a hollow wall: thick, boomy and muffled.',
    spec: { shape: 'box', size: [0.09, 2.4, 2.6], decay: 0.28, damping: 0.7, distance: 0.4, erMs: 12, modes: [[160, 6, 6], [290, 7, 4]], combs: [[0.52, 0.4, 2000]], highCut: [1100, 24], lowCut: [70, 24], eq: [{ type: 'peak', freq: 180, q: 1, gain: 3 }] },
  },
  plate: {
    about: 'A classic studio plate: dense, bright and smooth from the first moment.',
    spec: { shape: 'plate', decay: 2.3, damping: 0.1, bassRatio: 0.85, dispersionMs: 3.5, predelayMs: 2, lowCut: 140, highCut: 13000, eq: [{ type: 'highshelf', freq: 7000, q: 0.7, gain: 1.5 }] },
  },
  spring: {
    about: 'A spring tank: twangy, drippy, bouncing chirps.',
    spec: { shape: 'spring', decay: 2.6, damping: 0.6, springs: [{ ms: 34, a: 0.64, sections: 40, fc: 4200 }, { ms: 41.5, a: 0.7, sections: 40, fc: 4000 }], lowCut: 120, highCut: 4800, tailDb: -14 },
  },
  'small-hall': {
    about: 'A small recital hall: sweet, medium length and even.',
    spec: { shape: 'hall', size: [22, 15, 9], decay: 1.35, damping: 0.45, bassRatio: 1.15, distance: 6, erMs: 90 },
  },
  'large-hall': {
    about: 'A large hall: long, lush and spacious.',
    spec: { shape: 'hall', size: [52, 32, 20], decay: 2.9, damping: 0.5, bassRatio: 1.25, distance: 15, erMs: 130, irregular: 0.4 },
  },
  ambience: {
    about: 'Just a touch of room around the voice: short and natural, no obvious echo.',
    spec: { shape: 'room', size: [7, 5.5, 3.2], decay: 0.3, damping: 0.5, distance: 2.5, erMs: 70, tailGain: 0.6, irregular: 0.4 },
  },
  infinite: {
    about: 'A wash that almost never ends: the voice hangs in the air for many seconds.',
    spec: { shape: 'plate', decay: 45, damping: 0.3, bassRatio: 1.0, dispersionMs: 0, predelayMs: 20, direct: 0.4, bloomMs: 400, lowCut: 70, highCut: 10000, seconds: 12 },
  },
}

/** The named spaces in the contract's order. */
export const SPACE_NAMES = Object.keys(SPACES)

/** A copy of a named space's spec (for showing or tweaking). */
export function spaceSpec(name) {
  const s = SPACES[name]
  if (!s) throw new RangeError('There is no space called "' + name + '".')
  return JSON.parse(JSON.stringify(s.spec))
}

const CACHE = new Map()
const CACHE_LIMIT = 6000000 // samples held at most, across entries
let cacheSamples = 0

function cloneIR(b) {
  return { sr: b.sr, ch: b.ch.map((c) => new Float32Array(c)) }
}

/**
 * The impulse response for a named space (see SPACE_NAMES) at rate sr.
 * Deterministic for a given seed: the rng is used only through fork(), so its
 * draw position does not matter. Results are cached; each call returns a copy.
 */
export function namedIR(name, sr, rng) {
  const s = SPACES[name]
  if (!s) throw new RangeError('There is no space called "' + name + '". Try one of: ' + SPACE_NAMES.join(', ') + '.')
  const r = rng && typeof rng.fork === 'function' ? rng : makeRng(1)
  const key = name + '|' + sr + '|' + (r.key !== undefined ? r.key : 'x')
  const hit = CACHE.get(key)
  if (hit) {
    CACHE.delete(key)
    CACHE.set(key, hit)
    return cloneIR(hit)
  }
  const ir = roomIR(sr, s.spec, r.fork('space:' + name))
  const size = ir.ch[0].length * ir.ch.length
  if (size <= CACHE_LIMIT) {
    while (cacheSamples + size > CACHE_LIMIT && CACHE.size) {
      const oldest = CACHE.keys().next().value
      const ob = CACHE.get(oldest)
      cacheSamples -= ob.ch[0].length * ob.ch.length
      CACHE.delete(oldest)
    }
    CACHE.set(key, ir)
    cacheSamples += size
    return cloneIR(ir)
  }
  return ir
}

/** Forget cached named responses (for memory pressure). */
export function clearIRCache() {
  CACHE.clear()
  cacheSamples = 0
}

/**
 * Broadband decay time estimate (seconds to fall 60 dB) of a response by
 * Schroeder backward integration, fitted from -5 to -25 dB (T20 x 3), or to
 * the deepest level reached above -5 dB when shorter. Returns 0 for silence.
 */
export function estimateRT60(sig, sr) {
  const n = sig.length
  if (!n) return 0
  const edc = new Float64Array(n)
  let acc = 0
  for (let i = n - 1; i >= 0; i--) {
    acc += sig[i] * sig[i]
    edc[i] = acc
  }
  if (!(acc > 0)) return 0
  const tot = edc[0]
  let i5 = -1, i25 = -1
  for (let i = 0; i < n; i++) {
    const db = 10 * Math.log10(edc[i] / tot + 1e-30)
    if (i5 < 0 && db <= -5) i5 = i
    if (db <= -25) {
      i25 = i
      break
    }
  }
  if (i5 < 0) return 0
  let iEnd = i25
  let dbEnd = -25
  if (iEnd < 0) {
    // Fit to the level reached at 90 percent of the length.
    iEnd = Math.floor(n * 0.9)
    dbEnd = 10 * Math.log10(edc[iEnd] / tot + 1e-30)
    if (iEnd <= i5 || dbEnd > -6) return Infinity
  }
  // Least squares line over the range.
  let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0
  const step = Math.max(1, Math.floor((iEnd - i5) / 2000))
  for (let i = i5; i <= iEnd; i += step) {
    const x = i / sr
    const y = 10 * Math.log10(edc[i] / tot + 1e-30)
    sx += x; sy += y; sxx += x * x; sxy += x * y; m++
  }
  const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx)
  if (!(slope < 0)) return Infinity
  return -60 / slope
}
