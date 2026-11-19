// beds/cafe.js - Coffee shop: chatter at the tables, cups and spoons, the espresso machine.
//
// This file also holds the places kit that every bed in the places group
// (city street, subway, office, kitchen, stadium and the rest) is built from:
// the scene, the room reverberator, room tone, babble talkers, struck
// objects, footsteps and tones. Techniques and their published sources:
//
// - Scene. Every sound is a mono source placed by angle and distance: level
//   falls as 1/r, highs fall with distance (a one-pole stand-in for air
//   absorption, ISO 9613-1, and for people and furniture in the way), the
//   side comes from an equal-power pan plus an interaural time difference of
//   up to 0.63 ms (Woodworth's spherical head), and every source inside the
//   room feeds the reverberation by the same amount whatever its distance,
//   so far sounds are mostly room and near sounds mostly direct, the ear's
//   main distance cue (each place sets its feed from its critical distance,
//   0.057 * sqrt(volume / decay time), as in Kuttruff's "Room Acoustics").
//   Sources beyond the room's own radius feed it less and less. Moving
//   sources are heard with their true travel time, which gives the Doppler
//   shift for free.
// - Room. A feedback delay network of eight lines with a Hadamard feedback
//   matrix (Stautner and Puckette 1982, "Designing multi-channel
//   reverberators"), per-line one-pole absorption filters that give a
//   longer decay in the lows than in the highs (Jot and Chaigne 1991,
//   "Digital delay networks for designing artificial reverberators"), four
//   Schroeder allpass diffusers in front (Schroeder 1962, "Natural sounding
//   artificial reverberation"), two slowly modulated lines against metallic
//   ringing, and a handful of early reflection taps for the room's shape.
// - Babble. Talkers are small formant synthesisers in the manner of Klatt
//   1980 ("Software for a cascade/parallel formant synthesizer"): a
//   KLGLOTT88 glottal pulse (Klatt and Klatt 1990, "Analysis, synthesis, and
//   perception of voice quality variations among female and male talkers")
//   with jitter, shimmer, breathiness and an effort-dependent spectral tilt,
//   through three cascade resonators that glide between vowel targets
//   (Peterson and Barney 1952 averages, scaled for women and children) and a
//   fixed fourth, plus
//   stop bursts, fricative noise and nasal murmurs. Syllables come at four to
//   six a second with stress, declination over each phrase and final falls or
//   question rises, phrases make turns and turns pass between the people at a
//   table with the short gaps and overlaps of real conversation (Stivers and
//   others 2009, "Universals and cultural variation in turn-taking in
//   conversation"). People talk louder and higher in loud places (the
//   Lombard effect, 1911). The syllables are random, so no word is ever
//   spoken. Talkers (and dark steady room tones) are rendered at about
//   16 kHz and brought to the scene rate by a polyphase windowed-sinc
//   interpolator (Crochiere and Rabiner, "Multirate Digital Signal
//   Processing", 1983): murmur has little above 7 kHz that a room would let
//   through, and this keeps a room full of people cheap.
// - Struck objects: modal synthesis, a sum of exponentially decaying
//   sinusoids at each object's own mode ratios, softened by the hardness of
//   the strike, with a contact tick (van den Doel and Pai 1998, "The sounds
//   of physical shapes"; Cook 2002, "Real Sound Synthesis for Interactive
//   Applications"). Footsteps follow Cook's heel-and-toe model with surface
//   colours, as in Farnell 2010, "Designing Sound".
//
// The cafe itself: tables of talkers around you, cups set on saucers,
// spoons stirring, glasses touching, a chair scraping, and the espresso
// machine at the counter (grinder, knock box, pump and the steam wand
// stretching milk), in a lively room with hard floors and big windows.

import { makeRng } from '../core/rng.js'
import { resolveParams } from '../core/params.js'
import { limitBuf } from '../core/dyn.js'
import { Biquad } from '../core/biquad.js'
import { pink, brown } from '../core/noise.js'

export const TAU = 2 * Math.PI
export const SOUND_SPEED = 343

// ---------------------------------------------------------------- small helpers

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}
export function dbg(db) {
  return Math.pow(10, db / 20)
}
export function semis(s) {
  return Math.pow(2, s / 12)
}
/** Exponential draw with the given mean. */
export function rexp(rng, mean) {
  return -Math.log(1 - rng.next()) * mean
}
/** Log-uniform draw between lo and hi. */
export function logRange(rng, lo, hi) {
  return lo * Math.pow(hi / lo, rng.next())
}
/** A non-zero 32-bit seed for the inline xorshift generators. */
export function seed32(rng) {
  const s = rng.uint32() | 0
  return s === 0 ? 0x2545f491 : s
}
/** Event times of a Poisson process, `rate` per second, between t0 and t1. */
export function poisson(rng, rate, t0, t1, max = 200000) {
  const out = []
  if (!(rate > 0) || !(t1 > t0)) return out
  let t = t0 + rexp(rng, 1 / rate)
  while (t < t1 && out.length < max) {
    out.push(t)
    t += rexp(rng, 1 / rate)
  }
  return out
}
/** Pick an index from a list of weights. */
export function pickW(rng, w) {
  let s = 0
  for (let i = 0; i < w.length; i++) s += w[i]
  let u = rng.next() * s
  for (let i = 0; i < w.length; i++) {
    u -= w[i]
    if (u < 0) return i
  }
  return w.length - 1
}

/** Smooth random wander in -1..1, one value every dt seconds, knots about `period` s apart. */
export function wander(rng, dur, dt, period) {
  const m = Math.max(2, Math.ceil(Math.max(0, dur) / dt) + 2)
  const out = new Float32Array(m)
  const per = Math.max(dt * 2, period)
  let a = rng.range(-1, 1)
  let b = rng.range(-1, 1)
  let seg = per * rng.range(0.6, 1.4)
  let ts = 0
  for (let i = 0; i < m; i++) {
    const tt = i * dt
    while (tt - ts >= seg) {
      ts += seg
      a = b
      b = rng.range(-1, 1)
      seg = per * rng.range(0.6, 1.4)
    }
    const u = (tt - ts) / seg
    out[i] = a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * u))
  }
  return out
}
/** Linear read of a control curve sampled every dt seconds. */
export function curveAt(c, t, dt) {
  const x = t / dt
  const i = Math.floor(x)
  if (i < 0) return c[0]
  if (i >= c.length - 1) return c[c.length - 1]
  return c[i] + (c[i + 1] - c[i]) * (x - i)
}

// ---------------------------------------------------------------- filters

/** TPT one-pole coefficient for cutoff fc. */
export function onePoleG(fc, sr) {
  const g = Math.tan((Math.PI * clamp(fc, 1, 0.49 * sr)) / sr)
  return g / (1 + g)
}
/** One-pole lowpass in place. */
export function lp1(sig, sr, fc) {
  if (fc >= 0.48 * sr) return sig
  const G = onePoleG(fc, sr)
  let s = 0
  for (let i = 0; i < sig.length; i++) {
    const v = (sig[i] - s) * G
    const y = v + s
    s = y + v
    sig[i] = y
  }
  return sig
}
/** One-pole highpass in place. */
export function hp1(sig, sr, fc) {
  const G = onePoleG(fc, sr)
  let s = 0
  for (let i = 0; i < sig.length; i++) {
    const x = sig[i]
    const v = (x - s) * G
    const y = v + s
    s = y + v
    sig[i] = x - y
  }
  return sig
}
/**
 * Run RBJ biquads over sig in place: [[type, hz, q, gainDb]...]. Filters
 * whose corner is past 0.45 of the rate are skipped (a lowpass up there does
 * nothing; a highpass or band up there would remove everything).
 */
export function filt(sig, sr, list) {
  for (let i = 0; i < list.length; i++) {
    const f = list[i]
    if (!f) continue
    const hz = f[1]
    if (!(hz > 0)) continue
    if (hz >= 0.45 * sr) {
      if (f[0] === 'lowpass' || f[0] === 'peak' || f[0] === 'highshelf' || f[0] === 'notch') continue
      if (f[0] === 'highpass' || f[0] === 'bandpass') {
        sig.fill(0)
        return sig
      }
    }
    bq(sig, sr, f[0], hz, f[2] || 0.707, f[3] || 0)
  }
  return sig
}

/** One RBJ cookbook biquad (core/biquad.js) over sig in place. */
export function bq(sig, sr, type, hz, q = 0.707, gainDb = 0) {
  return new Biquad(type, sr, hz, q, gainDb).run(sig)
}

// ---------------------------------------------------------------- the scene

/**
 * Common start of every place bed: safe length and rate, resolved params,
 * rng, and the scene buffers (direct left and right, one reverb send).
 * o: { send (room feed, default 0.5), airHz, airM (distance dulling) }
 */
export function makeScene(bed, seconds, sr, p, rng, o = {}) {
  let rate = Number(sr)
  if (!(rate >= 1000 && rate <= 384000)) rate = 48000
  let secs = Number(seconds)
  if (!(secs > 0) || !Number.isFinite(secs)) secs = 0
  if (secs > 3600) secs = 3600
  const n = Math.max(0, Math.round(secs * rate))
  const q = resolveParams(bed, p && typeof p === 'object' ? p : {})
  const r = rng && typeof rng.fork === 'function' ? rng : makeRng(bed.id)
  return {
    sr: rate,
    n,
    dur: n / rate,
    q,
    rng: r,
    L: new Float32Array(n),
    R: new Float32Array(n),
    S: new Float32Array(n),
    send: o.send ?? 0.5,
    airHz: o.airHz ?? 20000,
    airM: o.airM ?? 15,
    roomR: o.roomR ?? 12,
    low: null,
  }
}

/** Highs left after `d` metres in this scene. */
export function airCut(sc, d) {
  return Math.max(350, sc.airHz / (1 + d / sc.airM))
}

/**
 * Room feed for a source d metres away: the same for everything inside the
 * room (its reverberant level does not depend on where it stands), falling
 * as 1/r beyond the room's own radius (a siren streets away hardly excites
 * the space you are in).
 */
export function sendAt(sc, d) {
  return sc.send / Math.max(1, d / sc.roomR)
}

/**
 * Place a mono sound in the scene: start (samples, may be negative), pan
 * -1..1, distance m, gain (level at 1 m), send (room feed multiplier).
 */
export function emit(sc, sig, start, pan, dist, gain = 1, send = 1) {
  const n = sc.n
  if (!n || !sig || !sig.length || !(gain > 0)) return
  const sr = sc.sr
  const off = Math.round(start)
  if (off >= n || off + sig.length + 64 <= 0) return
  const d = dist > 0.2 ? dist : 0.2
  const g = gain / (d > 1 ? d : 1)
  const p = clamp(pan || 0, -1, 1)
  const a = ((p + 1) * Math.PI) / 4
  const gl = Math.cos(a) * g
  const gr = Math.sin(a) * g
  const itd = Math.round(Math.abs(p) * 0.00063 * sr)
  const dl = p > 0 ? itd : 0
  const dr = p < 0 ? itd : 0
  const gs = gain * send * sendAt(sc, d)
  const fc = airCut(sc, d)
  const G = fc < 0.45 * sr ? onePoleG(fc, sr) : 0
  const L = sc.L
  const R = sc.R
  const S = sc.S
  const m = sig.length
  let s = 0
  let i0 = 0
  if (off < 0) i0 = -off - Math.max(dl, dr)
  if (i0 < 0) i0 = 0
  const i1 = Math.min(m, n - off)
  for (let i = i0; i < i1; i++) {
    let x = sig[i]
    if (G) {
      const v = (x - s) * G
      const y = v + s
      s = y + v
      x = y
    }
    const j = off + i
    const jl = j + dl
    const jr = j + dr
    if (jl >= 0 && jl < n) L[jl] += x * gl
    if (jr >= 0 && jr < n) R[jr] += x * gr
    if (j >= 0) S[j] += x * gs
  }
}

/**
 * Place a moving mono sound: path(tSec, pos) sets pos.pan and pos.dist for
 * scene time tSec. Gains glide across blocks of 64 samples. No time
 * difference between the ears (a moving one would need fractional delays).
 */
export function emitPath(sc, sig, start, path, gain = 1, send = 1) {
  const n = sc.n
  if (!n || !sig || !sig.length || !(gain > 0)) return
  const sr = sc.sr
  const off = Math.round(start)
  if (off >= n || off + sig.length <= 0) return
  const L = sc.L
  const R = sc.R
  const S = sc.S
  const m = sig.length
  const B = 64
  const pos = { pan: 0, dist: 1 }
  let pl = -1
  let pr = 0
  let s = 0
  for (let b0 = 0; b0 < m; b0 += B) {
    const b1 = Math.min(m, b0 + B)
    if (off + b1 <= 0) continue
    if (off + b0 >= n) break
    path((off + b1) / sr, pos)
    const d = pos.dist > 0.2 ? pos.dist : 0.2
    const g = gain / (d > 1 ? d : 1)
    const gs = gain * send * sendAt(sc, d)
    const a = ((clamp(pos.pan || 0, -1, 1) + 1) * Math.PI) / 4
    const tl = Math.cos(a) * g
    const tr = Math.sin(a) * g
    if (pl < 0) {
      pl = tl
      pr = tr
    }
    const fc = airCut(sc, d)
    const G = fc < 0.45 * sr ? onePoleG(fc, sr) : 0.999
    const inv = 1 / (b1 - b0)
    const dl = (tl - pl) * inv
    const dr = (tr - pr) * inv
    let gl = pl
    let gr = pr
    for (let i = b0; i < b1; i++) {
      const v = (sig[i] - s) * G
      const y = v + s
      s = y + v
      gl += dl
      gr += dr
      const j = off + i
      if (j >= 0 && j < n) {
        L[j] += y * gl
        R[j] += y * gr
        S[j] += y * gs
      }
    }
    pl = tl
    pr = tr
  }
}

/**
 * A moving source heard with its true travel time, so the pitch rises as it
 * comes and falls as it goes (the Doppler shift falls out of the changing
 * delay, as in Smith, Serafin, Abel and Berners 2002, "Doppler simulation
 * and the Leslie"). sig is the sound as it leaves the source, sig[0] at
 * scene time t0 (s). pos(tEmit, p) sets p.x (metres to the right) and p.y
 * (metres in front) for the moment the sound left. Level falls as 1/r, highs
 * with distance, and the side follows the bearing.
 */
export function emitMoving(sc, sig, t0, pos, gain = 1, send = 1, sigRate = 0) {
  const n = sc.n
  const sr = sc.sr
  const m = sig.length
  if (!n || m < 2 || !(gain > 0)) return
  const qr = sigRate > 0 ? sigRate : sr
  const p = { x: 0, y: 1 }
  const tEnd = t0 + m / qr
  pos(t0, p)
  const rA = Math.max(0.5, Math.hypot(p.x, p.y))
  pos(tEnd, p)
  const rB = Math.max(0.5, Math.hypot(p.x, p.y))
  const o0 = Math.max(0, Math.floor((t0 + rA / SOUND_SPEED) * sr))
  const o1 = Math.min(n, Math.ceil((tEnd + rB / SOUND_SPEED) * sr))
  if (o1 <= o0) return
  const L = sc.L
  const R = sc.R
  const S = sc.S
  const B = 64
  const solve = (tOut) => {
    let x = tOut - rA / SOUND_SPEED
    for (let it = 0; it < 4; it++) {
      pos(x, p)
      x = tOut - Math.max(0.5, Math.hypot(p.x, p.y)) / SOUND_SPEED
    }
    return x
  }
  let teA = solve(o0 / sr)
  pos(teA, p)
  let rr = Math.max(0.5, Math.hypot(p.x, p.y))
  let aa = ((clamp(p.x / rr, -1, 1) + 1) * Math.PI) / 4
  let pl = (Math.cos(aa) * gain) / Math.max(1, rr)
  let pr = (Math.sin(aa) * gain) / Math.max(1, rr)
  let s = 0
  for (let b0 = o0; b0 < o1; b0 += B) {
    const b1 = Math.min(o1, b0 + B)
    const teB = solve(b1 / sr)
    pos(teB, p)
    rr = Math.max(0.5, Math.hypot(p.x, p.y))
    aa = ((clamp(p.x / rr, -1, 1) + 1) * Math.PI) / 4
    const tl = (Math.cos(aa) * gain) / Math.max(1, rr)
    const tr = (Math.sin(aa) * gain) / Math.max(1, rr)
    const fc = airCut(sc, rr)
    const G = fc < 0.45 * sr ? onePoleG(fc, sr) : 0.999
    const gs = gain * send * sendAt(sc, rr)
    const inv = 1 / (b1 - b0)
    const dgl = (tl - pl) * inv
    const dgr = (tr - pr) * inv
    const dte = (teB - teA) * inv
    let gl = pl
    let gr = pr
    let te = teA
    for (let i = b0; i < b1; i++) {
      te += dte
      gl += dgl
      gr += dgr
      const idx = (te - t0) * qr
      if (idx < 0 || idx >= m - 1) continue
      const i0 = idx | 0
      const a = sig[i0]
      const x = a + (sig[i0 + 1] - a) * (idx - i0)
      const v = (x - s) * G
      const y = v + s
      s = y + v
      L[i] += y * gl
      R[i] += y * gr
      S[i] += y * gs
    }
    teA = teB
    pl = tl
    pr = tr
  }
}

/** Distance and pan of a source moving in a straight line past the listener. */
export function passPath(x0, speed, closest, side = 1) {
  return (t, pos) => {
    const x = x0 + speed * t
    const d = Math.sqrt(x * x + closest * closest)
    pos.pan = (side * x) / d
    pos.dist = d
  }
}

// ---------------------------------------------------------------- the room

/** Early reflection taps: count taps from ms0 to ms1, falling gains, random sides. */
export function autoTaps(rng, count, ms0, ms1, gain = 0.5) {
  const out = []
  for (let i = 0; i < count; i++) {
    const u = (i + rng.next() * 0.8) / count
    const ms = ms0 + (ms1 - ms0) * u * u
    out.push([ms, gain * Math.pow(0.55, u * 3) * rng.range(0.6, 1), rng.range(-0.9, 0.9)])
  }
  return out
}

const FDN_MS = [23.1, 28.7, 33.4, 39.1, 44.9, 51.3, 58.6, 66.2]

/**
 * Eight-line feedback delay network with frequency-dependent decay, input
 * diffusion, early taps and two modulated lines.
 * o: { size (delay scale, 0.15..4), rt60 (s, mid), rt60High, rt60Low,
 *   predelayMs, taps: [[ms, gain, pan]...], tapGain, wet, modMs, modHz, width }
 */
export class Fdn {
  constructor(sr, o = {}, rng) {
    const r = rng || makeRng('fdn')
    this.sr = sr
    const size = clamp(o.size ?? 1, 0.12, 4)
    const rt = clamp(o.rt60 ?? 1, 0.05, 20)
    const rtHi = clamp(o.rt60High ?? rt * 0.5, 0.03, rt)
    const rtLo = clamp(o.rt60Low ?? rt * 1.1, 0.05, 30)
    this.wet = o.wet ?? 1
    this.tapGain = o.tapGain ?? 1
    this.width = clamp(o.width ?? 1, 0, 1)
    const lens = new Int32Array(8)
    let maxLen = 0
    for (let k = 0; k < 8; k++) {
      let d = Math.round(((FDN_MS[k] * size * r.range(0.97, 1.03)) / 1000) * sr)
      if (d < 8) d = 8 + k * 3
      if ((d & 1) === 0) d++
      for (let j = 0; j < k; j++) if (lens[j] === d) d += 2
      lens[k] = d
      if (d > maxLen) maxLen = d
    }
    this.lens = lens
    const modMs = o.modMs ?? 0.35 * Math.min(1.5, size)
    this.modD = (modMs / 1000) * sr
    this.modHz = o.modHz ?? 0.23
    let S = 4
    while (S < maxLen + this.modD + 8) S <<= 1
    this.S = S
    this.mem = new Float32Array(S * 8)
    // absorption: one-pole lowpass per line with DC gain gLo and Nyquist gain gHi
    this.fa = new Float64Array(8)
    this.fb = new Float64Array(8)
    let gm = 0
    for (let k = 0; k < 8; k++) {
      const gLo = Math.pow(10, (-3 * lens[k]) / (rtLo * sr))
      const gMid = Math.pow(10, (-3 * lens[k]) / (rt * sr))
      const gHi = Math.pow(10, (-3 * lens[k]) / (rtHi * sr))
      const g0 = Math.max(gLo, gMid)
      const a = (g0 - gHi) / (g0 + gHi)
      this.fa[k] = a
      this.fb[k] = g0 * (1 - a)
      gm += gMid / 8
    }
    this.og = Math.sqrt(2 * (1 - gm * gm))
    // diffusers
    const apMs = [4.77, 3.59, 12.73, 9.31]
    this.apLen = new Int32Array(4)
    this.ap = []
    for (let k = 0; k < 4; k++) {
      const d = Math.max(3, Math.round(((apMs[k] * Math.min(1.6, Math.max(0.4, size))) / 1000) * sr))
      this.apLen[k] = d
      this.ap.push(new Float32Array(d))
    }
    this.apG = o.diffusion ?? 0.62
    // early taps and predelay share one line
    const taps = Array.isArray(o.taps) ? o.taps : autoTaps(r, 6, 4 * size, 38 * size, 0.45)
    let maxTap = 0
    for (const t of taps) if (t[0] > maxTap) maxTap = t[0]
    const pre = Math.max(0, o.predelayMs ?? 8 * size)
    let E = 4
    const need = Math.ceil(((Math.max(maxTap, pre) + 2) / 1000) * sr) + 4
    while (E < need) E <<= 1
    this.E = E
    this.er = new Float32Array(E)
    this.pre = Math.round((pre / 1000) * sr)
    this.tapD = new Int32Array(taps.length)
    this.tapL = new Float64Array(taps.length)
    this.tapR = new Float64Array(taps.length)
    for (let i = 0; i < taps.length; i++) {
      const [ms, g, pan] = taps[i]
      this.tapD[i] = Math.max(1, Math.round((ms / 1000) * sr))
      const a = ((clamp(pan, -1, 1) * this.width + 1) * Math.PI) / 4
      this.tapL[i] = Math.cos(a) * g * Math.SQRT2
      this.tapR[i] = Math.sin(a) * g * Math.SQRT2
    }
  }

  /** Feed mono send x; add the stereo room into L and R. */
  process(x, L, R) {
    const n = Math.min(x.length, L.length, R.length)
    const S = this.S
    const M = S - 1
    const mem = this.mem
    const lens = this.lens
    const fa = this.fa
    const fb = this.fb
    const er = this.er
    const EM = this.E - 1
    const pre = this.pre
    const tapD = this.tapD
    const tapL = this.tapL
    const tapR = this.tapR
    const nt = tapD.length
    const ap0 = this.ap[0], ap1 = this.ap[1], ap2 = this.ap[2], ap3 = this.ap[3]
    const n0 = this.apLen[0], n1 = this.apLen[1], n2 = this.apLen[2], n3 = this.apLen[3]
    let i0 = 0, i1 = 0, i2 = 0, i3 = 0
    const g = this.apG
    const og = this.og * this.wet
    const tg = this.tapGain
    const wd = this.width
    const mid = 0.5 * (1 - wd)
    const d0 = lens[0], d1 = lens[1], d2 = lens[2], d3 = lens[3], d4 = lens[4], d5 = lens[5], d6 = lens[6], d7 = lens[7]
    const o1 = S, o2 = 2 * S, o3 = 3 * S, o4 = 4 * S, o5 = 5 * S, o6 = 6 * S, o7 = 7 * S
    const md = this.modD
    const rot = (TAU * this.modHz) / this.sr
    const cr = Math.cos(rot)
    const sn = Math.sin(rot)
    let mc = 1
    let ms = 0
    let ew = 0
    let w = 0
    let z0 = 0, z1 = 0, z2 = 0, z3 = 0, z4 = 0, z5 = 0, z6 = 0, z7 = 0
    const a0 = fa[0], a1 = fa[1], a2 = fa[2], a3 = fa[3], a4 = fa[4], a5 = fa[5], a6 = fa[6], a7 = fa[7]
    const b0 = fb[0], b1 = fb[1], b2 = fb[2], b3 = fb[3], b4 = fb[4], b5 = fb[5], b6 = fb[6], b7 = fb[7]
    const h = 0.35355339059327373
    let silent = 0
    for (let i = 0; i < n; i++) {
      let xin = x[i]
      if (!(xin > -1e6 && xin < 1e6)) xin = 0
      if (xin === 0) silent++
      else silent = 0
      er[ew] = xin
      let el = 0
      let erR = 0
      for (let t = 0; t < nt; t++) {
        const v = er[(ew - tapD[t]) & EM]
        el += v * tapL[t]
        erR += v * tapR[t]
      }
      let u = er[(ew - pre) & EM]
      ew = (ew + 1) & EM
      // allpass diffusers
      let dv = ap0[i0]
      let y = dv - g * u
      ap0[i0] = u + g * y
      if (++i0 >= n0) i0 = 0
      u = y
      dv = ap1[i1]
      y = dv - g * u
      ap1[i1] = u + g * y
      if (++i1 >= n1) i1 = 0
      u = y
      dv = ap2[i2]
      y = dv - g * u
      ap2[i2] = u + g * y
      if (++i2 >= n2) i2 = 0
      u = y
      dv = ap3[i3]
      y = dv - g * u
      ap3[i3] = u + g * y
      if (++i3 >= n3) i3 = 0
      u = y
      // modulation phasor
      const nc = mc * cr - ms * sn
      ms = ms * cr + mc * sn
      mc = nc
      if ((i & 4095) === 0) {
        const k = 1 / Math.sqrt(mc * mc + ms * ms)
        mc *= k
        ms *= k
      }
      // reads (lines 1 and 6 modulated)
      const r0 = mem[(w - d0) & M]
      let rp = d1 + md * (1 + mc)
      let ri = rp | 0
      let fr = rp - ri
      let p0 = mem[o1 + ((w - ri) & M)]
      const r1 = p0 + (mem[o1 + ((w - ri - 1) & M)] - p0) * fr
      const r2 = mem[o2 + ((w - d2) & M)]
      const r3 = mem[o3 + ((w - d3) & M)]
      const r4 = mem[o4 + ((w - d4) & M)]
      const r5 = mem[o5 + ((w - d5) & M)]
      rp = d6 + md * (1 + ms)
      ri = rp | 0
      fr = rp - ri
      p0 = mem[o6 + ((w - ri) & M)]
      const r6 = p0 + (mem[o6 + ((w - ri - 1) & M)] - p0) * fr
      const r7 = mem[o7 + ((w - d7) & M)]
      z0 = b0 * r0 + a0 * z0
      z1 = b1 * r1 + a1 * z1
      z2 = b2 * r2 + a2 * z2
      z3 = b3 * r3 + a3 * z3
      z4 = b4 * r4 + a4 * z4
      z5 = b5 * r5 + a5 * z5
      z6 = b6 * r6 + a6 * z6
      z7 = b7 * r7 + a7 * z7
      if (silent > 4096) {
        // flush tiny tails so silence stays cheap and denormal free
        if (z0 < 1e-20 && z0 > -1e-20) z0 = 0
        if (z1 < 1e-20 && z1 > -1e-20) z1 = 0
        if (z2 < 1e-20 && z2 > -1e-20) z2 = 0
        if (z3 < 1e-20 && z3 > -1e-20) z3 = 0
        if (z4 < 1e-20 && z4 > -1e-20) z4 = 0
        if (z5 < 1e-20 && z5 > -1e-20) z5 = 0
        if (z6 < 1e-20 && z6 > -1e-20) z6 = 0
        if (z7 < 1e-20 && z7 > -1e-20) z7 = 0
      }
      // Hadamard 8
      const c0 = z0 + z1, c1 = z0 - z1, c2 = z2 + z3, c3 = z2 - z3
      const c4 = z4 + z5, c5 = z4 - z5, c6 = z6 + z7, c7 = z6 - z7
      const e0 = c0 + c2, e2 = c0 - c2, e1 = c1 + c3, e3 = c1 - c3
      const e4 = c4 + c6, e6 = c4 - c6, e5 = c5 + c7, e7 = c5 - c7
      const ui = u * h
      mem[w & M] = (e0 + e4) * h + ui
      mem[o1 + (w & M)] = (e1 + e5) * h - ui
      mem[o2 + (w & M)] = (e2 + e6) * h + ui
      mem[o3 + (w & M)] = (e3 + e7) * h - ui
      mem[o4 + (w & M)] = (e0 - e4) * h + ui
      mem[o5 + (w & M)] = (e1 - e5) * h + ui
      mem[o6 + (w & M)] = (e2 - e6) * h - ui
      mem[o7 + (w & M)] = (e3 - e7) * h - ui
      w = (w + 1) & M
      const ol = (z0 - z2 + z4 - z6) * og
      const orr = (z1 - z3 + z5 - z7) * og
      L[i] += ol * (1 - mid) + orr * mid + el * tg
      R[i] += orr * (1 - mid) + ol * mid + erR * tg
    }
  }
}

// ---------------------------------------------------------------- room tone

/**
 * Steady room tone straight into L and R.
 * o: { db (level), color: filter list for the air noise, rumbleDb, rumbleHz,
 *   hum: [[hz, db]...], buzzDb (mains buzz with odd harmonics), drift (0..1
 *   slow level wander), corr (0..1 left/right likeness) }
 */
export function roomTone(sc, rng, o = {}) {
  const n = sc.n
  if (!n) return
  const corr = clamp(o.corr ?? 0.3, 0, 0.95)
  const a = Math.sqrt(1 - corr * 0.5)
  const b = Math.sqrt(corr * 0.5)
  if (o.db !== undefined && o.db > -150) {
    const color = o.color || [['lowpass', 2500, 0.7]]
    // a dark tone is made at the talker rate (the interpolator brings it up)
    let top = 0.5 * sc.sr
    for (const f of color) if (f && f[0] === 'lowpass' && f[1] < top) top = f[1]
    for (const f of color) if (f && (f[0] === 'highpass' || f[0] === 'bandpass' || f[0] === 'peak' || f[0] === 'highshelf') && f[1] > top) top = f[1]
    const T = target(sc, top)
    const nl = pink(T.n, rng.fork('tl'))
    const nr = pink(T.n, rng.fork('tr'))
    filt(nl, T.sr, color)
    filt(nr, T.sr, color)
    // pink noise piles up energy below hearing's interest; the rumble part
    // (rumbleDb) is where a place's deliberate low end lives
    const hp = o.hp ?? 45
    if (hp > 0 && !color.some((f) => f && f[0] === 'highpass')) {
      hp1(nl, T.sr, hp)
      hp1(nr, T.sr, hp)
      hp1(nl, T.sr, hp)
      hp1(nr, T.sr, hp)
    }
    const g = dbg(o.db) * 5
    const dr = o.drift ?? 0.2
    const dt = 0.05
    const wv = dr > 0 ? wander(rng.fork('td'), sc.dur, dt, 7) : null
    for (let i = 0; i < T.n; i++) {
      const k = wv ? g * (1 + dr * 0.5 * curveAt(wv, i / T.sr, dt)) : g
      const l = nl[i]
      const r = nr[i]
      T.L[i] += (a * l + b * r) * k
      T.R[i] += (b * l + a * r) * k
    }
  }
  if (o.rumbleDb !== undefined && o.rumbleDb > -150) {
    const rh = o.rumbleHz ?? 120
    const T = target(sc, rh * 2)
    const r1 = brown(T.n, rng.fork('rb1'), 0.9995)
    const r2 = brown(T.n, rng.fork('rb2'), 0.9995)
    filt(r1, T.sr, [['lowpass', rh, 0.7]])
    filt(r2, T.sr, [['lowpass', rh, 0.7]])
    hp1(r1, T.sr, 18)
    hp1(r2, T.sr, 18)
    const g = dbg(o.rumbleDb) * 5
    for (let i = 0; i < T.n; i++) {
      T.L[i] += (0.8 * r1[i] + 0.2 * r2[i]) * g
      T.R[i] += (0.2 * r1[i] + 0.8 * r2[i]) * g
    }
  }
  if (Array.isArray(o.hum) && o.hum.length) {
    const hr = rng.fork('hum')
    for (const [hz, db] of o.hum) addSine(sc, hz * (1 + hr.gauss() * 0.0004), dbg(db), hr.range(0, TAU), hr.range(-0.3, 0.3), 0.002)
  }
  if (o.buzzDb !== undefined && o.buzzDb > -150) mainsBuzz(sc, rng.fork('buzz'), o.buzzHz ?? 120, dbg(o.buzzDb), o.buzzBright ?? 0.5)
}

/**
 * Where a steady sound whose content stops below `topHz` should be made:
 * the talker buses (about 16 kHz, brought up with the talkers) when they can
 * carry it, else the scene itself. Returns { L, R, n, sr }.
 */
export function target(sc, topHz) {
  const lo = lowBus(sc)
  if (lo.k > 1 && topHz <= 0.35 * lo.wr) {
    lo.used = true
    return { L: lo.L, R: lo.R, n: lo.n, sr: lo.wr }
  }
  return { L: sc.L, R: sc.R, n: sc.n, sr: sc.sr }
}

/** A steady sine straight into L and R with a slow wobble of `wob` relative pitch. */
export function addSine(sc, hz, amp, phase = 0, pan = 0, wob = 0) {
  if (!(hz > 0) || hz >= 0.45 * sc.sr) return
  const T = target(sc, hz * 1.1)
  const a = ((pan + 1) * Math.PI) / 4
  const gl = Math.cos(a) * amp * Math.SQRT2
  const gr = Math.sin(a) * amp * Math.SQRT2
  const sig = sinePhasor(T.n, T.sr, hz, phase, wob)
  for (let i = 0; i < T.n; i++) {
    const v = sig[i]
    T.L[i] += v * gl
    T.R[i] += v * gr
  }
}

/**
 * n samples of a sine by a rotating phasor (no sine call per sample); the
 * rotation is recomputed every 256 samples, so `wob` (relative pitch
 * wander at 0.07 Hz) costs nothing per sample.
 */
export function sinePhasor(n, sr, hz, phase = 0, wob = 0) {
  const out = new Float32Array(n)
  let c = Math.cos(phase)
  let s = Math.sin(phase)
  let wp = phase * 3
  for (let b = 0; b < n; b += 256) {
    const f = hz * (1 + wob * Math.sin(wp))
    wp += (TAU * 0.07 * 256) / sr
    const w = (TAU * f) / sr
    const cr = Math.cos(w)
    const sn = Math.sin(w)
    const e = Math.min(n, b + 256)
    for (let i = b; i < e; i++) {
      out[i] = s
      const nc = c * cr - s * sn
      s = s * cr + c * sn
      c = nc
    }
    const k = 1 / Math.sqrt(c * c + s * s)
    c *= k
    s *= k
  }
  return out
}

const SIN_T = new Float32Array(4097)
for (let i = 0; i <= 4096; i++) SIN_T[i] = Math.sin((2 * Math.PI * i) / 4096)

/** sin(2 pi ph) from a table (ph in cycles, any value), for per-sample oscillators. */
export function sinCycles(ph) {
  const x = (ph - Math.floor(ph)) * 4096
  const i = x | 0
  return SIN_T[i] + (SIN_T[i + 1] - SIN_T[i]) * (x - i)
}

/** One cycle (2048 points plus a guard point) of a sum of harmonics [[k, amp, phase]...]. */
export function harmonicTable(harm) {
  const t = new Float32Array(2049)
  let maxK = 0
  for (const h of harm) {
    const k = h[0]
    const a = h[1]
    const p = h[2] || 0
    if (k > maxK) maxK = k
    for (let i = 0; i < 2048; i++) t[i] += a * Math.sin((2 * Math.PI * k * i) / 2048 + p)
  }
  t[2048] = t[0]
  t.harm = harm
  t.maxK = maxK
  return t
}

/**
 * The version of a harmonicTable that is safe to play at hz: harmonics that
 * would pass 0.45 of the rate are left out (so nothing folds back), cached.
 */
export function bandTable(table, hz, sr) {
  if (!table.harm || !(hz > 0)) return table
  const kmax = Math.floor((0.45 * sr) / hz)
  if (kmax >= table.maxK) return table
  if (!table.bl) table.bl = new Map()
  let t = table.bl.get(kmax)
  if (!t) {
    const keep = table.harm.filter((h) => h[0] <= kmax)
    t = harmonicTable(keep.length ? keep : [[1, 0]])
    table.bl.set(kmax, t)
  }
  return t
}

/**
 * n samples of a periodic wave from a harmonicTable at hz, with a slow
 * relative pitch wander `wob` (recomputed every 256 samples). With `into`
 * the wave is added (times `gain`) into that array instead of a new one,
 * so long steady machines need no extra full-length buffers.
 */
export function periodic(n, sr, hz, tableIn, phase = 0, wob = 0, into = null, gain = 1) {
  const table = bandTable(tableIn, hz * (1 + Math.abs(wob)), sr)
  const out = into || new Float32Array(n)
  const g = into ? gain : 1
  const m = Math.min(n, out.length)
  let ph = phase - Math.floor(phase)
  let wp = phase * 7
  for (let b = 0; b < m; b += 256) {
    const inc = (hz * (1 + wob * Math.sin(wp))) / sr
    wp += (2 * Math.PI * 0.07 * 256) / sr
    const e = Math.min(m, b + 256)
    if (into) {
      for (let i = b; i < e; i++) {
        const x = ph * 2048
        const i0 = x | 0
        out[i] += (table[i0] + (table[i0 + 1] - table[i0]) * (x - i0)) * g
        ph += inc
        if (ph >= 1) ph -= 1
      }
    } else {
      for (let i = b; i < e; i++) {
        const x = ph * 2048
        const i0 = x | 0
        out[i] = table[i0] + (table[i0 + 1] - table[i0]) * (x - i0)
        ph += inc
        if (ph >= 1) ph -= 1
      }
    }
  }
  return out
}

/**
 * A periodic wave whose pitch drifts at random (smooth wander of relative
 * size `depth`, changing over about `period` seconds), the way a loaded
 * motor's speed breathes; recomputed every 256 samples.
 */
export function drifting(n, sr, hz, tableIn, rng, depth = 0.002, period = 3) {
  const table = bandTable(tableIn, hz * (1 + 2 * depth), sr)
  const out = new Float32Array(n)
  const dt = 0.05
  const wv = wander(rng, n / sr + 1, dt, period)
  let ph = rng.next()
  for (let b = 0; b < n; b += 256) {
    const inc = (hz * (1 + depth * curveAt(wv, b / sr, dt))) / sr
    const e = Math.min(n, b + 256)
    for (let i = b; i < e; i++) {
      const x = ph * 2048
      const i0 = x | 0
      out[i] = table[i0] + (table[i0 + 1] - table[i0]) * (x - i0)
      ph += inc
      if (ph >= 1) ph -= 1
    }
  }
  return out
}

/** Cheap smooth saturation (a rational fit of tanh, exact at 0 and settling to 1 at 3). */
export function soft(x) {
  if (x > 3) return 1
  if (x < -3) return -1
  const x2 = x * x
  return (x * (27 + x2)) / (27 + 9 * x2)
}

/** Fluorescent or transformer buzz: a clipped hum rich in harmonics, gently lowpassed. */
export function mainsBuzz(sc, rng, hz, amp, bright = 0.5) {
  const T = target(sc, 900 + 3000 * bright)
  const n = T.n
  const sr = T.sr
  const sig = sinePhasor(n, sr, hz, rng.range(0, TAU), 0.001)
  const k = 1 + 2 * bright
  const nk = 1 / soft(k)
  for (let i = 0; i < n; i++) sig[i] = soft(k * sig[i]) * nk
  filt(sig, sr, [['highpass', hz * 0.7, 0.7], ['lowpass', 900 + 3000 * bright, 0.7]])
  for (let i = 0; i < n; i++) {
    T.L[i] += sig[i] * amp
    T.R[i] += sig[i] * amp * 0.9
  }
}

// ---------------------------------------------------------------- finishing

/**
 * Bring in the babble talkers, run the room, set the level and keep peaks
 * safe. room: Fdn options (or null for none). targetDb: RMS of the bed.
 * Returns { sr, ch: [L, R] }.
 */
export function finish(sc, room, targetDb = -24) {
  const { L, R, sr, n } = sc
  if (!n) return { sr, ch: [L, R] }
  flushLow(sc)
  if (room) {
    const f = new Fdn(sr, room, sc.rng.fork('room'))
    f.process(sc.S, L, R)
  }
  let e = 0
  for (let i = 0; i < n; i++) {
    let a = L[i]
    let b = R[i]
    if (!(a > -1e6 && a < 1e6)) a = L[i] = 0
    if (!(b > -1e6 && b < 1e6)) b = R[i] = 0
    e += a * a + b * b
  }
  const rmsv = Math.sqrt(e / (2 * n))
  let g = rmsv > 1e-9 ? dbg(targetDb) / rmsv : 0
  if (!Number.isFinite(g)) g = 0
  let pk = 0
  const kn = 0.9
  const w = 1 - kn
  for (let c = 0; c < 2; c++) {
    const s = c === 0 ? L : R
    for (let i = 0; i < n; i++) {
      let v = s[i] * g
      if (v > kn) v = kn + w * Math.tanh((v - kn) / w)
      else if (v < -kn) v = -kn - w * Math.tanh((-v - kn) / w)
      else if (v < 1e-30 && v > -1e-30) v = 0
      s[i] = v
      const av = v < 0 ? -v : v
      if (av > pk) pk = av
    }
  }
  const out = { sr, ch: [L, R] }
  if (pk > 0.89) limitBuf(out, { ceilingDb: -1.2, lookaheadMs: 3, releaseMs: 90, truePeak: false })
  sc.S = null
  sc.low = null
  return out
}

/**
 * A room scaled by a size control (0..1, 0.5 = as designed): bigger rooms
 * have longer delays, longer decays, later reflections. Returns a new spec.
 */
export function sizedRoom(room, s01) {
  const s = clamp(s01, 0, 1)
  const f = 0.55 + 0.9 * s
  const out = Object.assign({}, room)
  out.size = (room.size ?? 1) * f
  out.rt60 = (room.rt60 ?? 1) * (0.65 + 0.7 * s)
  out.rt60High = (room.rt60High ?? (room.rt60 ?? 1) * 0.5) * (0.7 + 0.6 * s)
  out.predelayMs = (room.predelayMs ?? 8) * f
  if (Array.isArray(room.taps)) out.taps = room.taps.map(([ms, g, p]) => [ms * f, g, p])
  return out
}

/** How far people and things sit in a room of this size control (0.5 = 1). */
export function sizeSpread(s01) {
  return 0.7 + 0.6 * clamp(s01, 0, 1)
}

/** An empty stereo bed. */
export function emptyBed(sr) {
  return { sr, ch: [new Float32Array(0), new Float32Array(0)] }
}

// ---------------------------------------------------------------- low-rate talker buses

/** The talker buses at about 16 kHz (created on first use). */
export function lowBus(sc) {
  if (sc.low) return sc.low
  const k = Math.max(1, Math.floor(sc.sr / 14000))
  const wr = sc.sr / k
  const n = Math.ceil(sc.n / k) + 4
  sc.low = { k, wr, n, L: new Float32Array(n), R: new Float32Array(n), S: new Float32Array(n), used: false }
  return sc.low
}

const UP = new Map()
function upKernel(k) {
  let h = UP.get(k)
  if (h) return h
  const T = 12
  const len = k * T + 1
  const mid = (len - 1) / 2
  h = new Float64Array(len)
  const fc = 0.46 / k
  for (let i = 0; i < len; i++) {
    const x = i - mid
    const s = x === 0 ? 2 * fc : Math.sin(TAU * fc * x) / (Math.PI * x)
    const wv = 0.42 - 0.5 * Math.cos((TAU * i) / (len - 1)) + 0.08 * Math.cos((2 * TAU * i) / (len - 1))
    h[i] = s * wv * k
  }
  UP.set(k, h)
  return h
}

/** Polyphase interpolation of x by k, added into dst (same start time). */
export function upAdd(x, dst, k, gain = 1) {
  const n = dst.length
  if (k === 1) {
    const m = Math.min(n, x.length)
    for (let i = 0; i < m; i++) dst[i] += x[i] * gain
    return
  }
  const h = upKernel(k)
  const len = h.length
  const mid = (len - 1) / 2
  const nx = x.length
  const CH = 64
  const nch = Math.ceil(nx / CH)
  const live = new Uint8Array(nch + 1)
  for (let c = 0; c < nch; c++) {
    const e = Math.min(nx, (c + 1) * CH)
    for (let j = c * CH; j < e; j++) {
      if (x[j] !== 0) {
        live[c] = 1
        break
      }
    }
  }
  const T = Math.ceil(len / k)
  let o = 0
  while (o < n) {
    const q = o + mid
    const j = (q / k) | 0
    const cj = (j / CH) | 0
    const jl = j - T + 1
    const cl = jl > 0 ? (jl / CH) | 0 : 0
    if (cl >= nch) break
    if (!live[cj] && !live[cl]) {
      // the whole support of this output is silent: jump to the next chunk
      const nextO = (cj + 1) * CH * k - mid
      o = nextO > o + 1 ? nextO : o + 1
      continue
    }
    const p = q - j * k
    let acc = 0
    for (let t = p, jj = j; t < len && jj >= 0; t += k, jj--) {
      if (jj < nx) acc += h[t] * x[jj]
    }
    dst[o] += acc * gain
    o++
  }
}

/** Upsample the three talker buses into the scene in one pass. */
export function flushLow(sc) {
  const lo = sc.low
  if (!lo || !lo.used) return
  lo.used = false
  const k = lo.k
  if (k === 1) {
    upAdd(lo.L, sc.L, 1)
    upAdd(lo.R, sc.R, 1)
    upAdd(lo.S, sc.S, 1)
    return
  }
  const h = upKernel(k)
  const len = h.length
  const mid = (len - 1) / 2
  const xL = lo.L
  const xR = lo.R
  const xS = lo.S
  const nx = xL.length
  const dL = sc.L
  const dR = sc.R
  const dS = sc.S
  const n = dL.length
  const CH = 64
  const nch = Math.ceil(nx / CH)
  const live = new Uint8Array(nch + 1)
  for (let c = 0; c < nch; c++) {
    const e = Math.min(nx, (c + 1) * CH)
    for (let j = c * CH; j < e; j++) {
      if (xL[j] !== 0 || xR[j] !== 0 || xS[j] !== 0) {
        live[c] = 1
        break
      }
    }
  }
  const T = Math.ceil(len / k)
  let o = 0
  while (o < n) {
    const q = o + mid
    const j = (q / k) | 0
    const cj = (j / CH) | 0
    const jl = j - T + 1
    const cl = jl > 0 ? (jl / CH) | 0 : 0
    if (cl >= nch) break
    if (!live[cj] && !live[cl]) {
      const nextO = (cj + 1) * CH * k - mid
      o = nextO > o + 1 ? nextO : o + 1
      continue
    }
    const p = q - j * k
    let aL = 0
    let aR = 0
    let aS = 0
    let t = p
    let jj = j
    if (jj >= nx) {
      const skip = jj - nx + 1
      t += skip * k
      jj -= skip
    }
    for (; t < len && jj >= 0; t += k, jj--) {
      const hv = h[t]
      aL += hv * xL[jj]
      aR += hv * xR[jj]
      aS += hv * xS[jj]
    }
    dL[o] += aL
    dR[o] += aR
    dS[o] += aS
    o++
  }
}

/** Mix a mono signal at the talker rate into the talker buses. */
export function mixLow(sc, sig, off, pan, dist, gain = 1, send = 1) {
  const lo = lowBus(sc)
  const n = lo.n
  const wr = lo.wr
  if (!sig.length || off >= n || off + sig.length <= 0) return
  lo.used = true
  const d = dist > 0.2 ? dist : 0.2
  const g = gain / (d > 1 ? d : 1)
  const p = clamp(pan || 0, -1, 1)
  const a = ((p + 1) * Math.PI) / 4
  const gl = Math.cos(a) * g
  const gr = Math.sin(a) * g
  const itd = Math.round(Math.abs(p) * 0.00063 * wr)
  const dl = p > 0 ? itd : 0
  const dr = p < 0 ? itd : 0
  const gs = gain * send * sendAt(sc, d)
  const fc = airCut(sc, d)
  const G = fc < 0.45 * wr ? onePoleG(fc, wr) : 0
  const L = lo.L
  const R = lo.R
  const S = lo.S
  let s = 0
  for (let i = 0; i < sig.length; i++) {
    let x = sig[i]
    if (G) {
      const v = (x - s) * G
      const y = v + s
      s = y + v
      x = y
    }
    const j = off + i
    const jl = j + dl
    const jr = j + dr
    if (jl >= 0 && jl < n) L[jl] += x * gl
    if (jr >= 0 && jr < n) R[jr] += x * gr
    if (j >= 0 && j < n) S[j] += x * gs
  }
}

// ---------------------------------------------------------------- talkers

// Vowel targets F1 F2 F3 (Hz) for men, Peterson and Barney 1952 averages.
const VOW = [
  [270, 2290, 3010],
  [390, 1990, 2550],
  [530, 1840, 2480],
  [660, 1720, 2410],
  [730, 1090, 2440],
  [570, 840, 2410],
  [440, 1020, 2240],
  [300, 870, 2240],
  [640, 1190, 2390],
  [490, 1350, 1690],
]
const SCHWA = [500, 1450, 2450]
// stops: voiced, burst Hz, locus F1 F2 F3
const STOPS = [
  [0, 900, 280, 850, 2200],
  [0, 4000, 280, 1750, 2700],
  [0, 2300, 280, 1950, 2350],
  [1, 900, 220, 850, 2200],
  [1, 3800, 220, 1750, 2700],
  [1, 2100, 220, 1950, 2350],
]
// fricatives: voiced, centre Hz, q, level, locus F1 F2 F3. The renderer
// picks the band's sharpness from the centre: above 4.5 kHz narrow (s, z),
// 2.6 to 4.5 kHz medium (sh), below that broad and weak (f, th, v).
const FRICS = [
  [0, 5800, 2.5, 0.75, 280, 1700, 2700],
  [0, 3000, 2.0, 1.0, 280, 1900, 2450],
  [0, 1800, 0.7, 0.3, 280, 1000, 2300],
  [0, 2300, 0.7, 0.25, 280, 1450, 2600],
  [1, 5600, 2.5, 0.45, 260, 1700, 2700],
  [1, 1600, 0.7, 0.2, 260, 1000, 2300],
]
// sonorants: kind (0 nasal, 1 liquid, 2 glide), level, F1 F2 F3
const SONOR = [
  [0, 0.42, 280, 1050, 2250],
  [0, 0.42, 280, 1550, 2650],
  [1, 0.65, 360, 1100, 2750],
  [1, 0.6, 360, 1150, 1650],
  [2, 0.7, 300, 700, 2250],
  [2, 0.7, 280, 2150, 2950],
]

/**
 * A person. kind: man, woman, child, adult (man or woman), or teen.
 * o: { rate (syllables per second), effort 0..1, expr 0..1, whisper }
 */
export function makeTalker(rng, kind = 'adult', o = {}) {
  let k = kind
  if (k === 'adult') k = rng.chance(0.5) ? 'man' : 'woman'
  if (k === 'teen') k = rng.chance(0.5) ? 'teenboy' : 'teengirl'
  let f0
  let fs
  if (k === 'man') {
    f0 = 112 * Math.exp(rng.gauss() * 0.14)
    fs = 1 + rng.gauss() * 0.045
  } else if (k === 'woman') {
    f0 = 205 * Math.exp(rng.gauss() * 0.12)
    fs = 1.16 + rng.gauss() * 0.045
  } else if (k === 'teenboy') {
    f0 = 140 * Math.exp(rng.gauss() * 0.15)
    fs = 1.08 + rng.gauss() * 0.04
  } else if (k === 'teengirl') {
    f0 = 225 * Math.exp(rng.gauss() * 0.1)
    fs = 1.2 + rng.gauss() * 0.04
  } else {
    f0 = 275 * Math.exp(rng.gauss() * 0.09)
    fs = 1.3 + rng.gauss() * 0.05
  }
  return {
    kind: k,
    f0: clamp(f0, 70, 420),
    fs: clamp(fs, 0.88, 1.48),
    rate: clamp((o.rate ?? 4.8) * Math.exp(rng.gauss() * 0.12), 2.5, 8),
    effort: clamp((o.effort ?? 0.4) + rng.gauss() * 0.1, 0, 1),
    expr: clamp((o.expr ?? 0.5) + rng.gauss() * 0.15, 0, 1),
    jitter: 0.006 + rng.next() * 0.014,
    breath: clamp(0.06 + rng.next() * 0.2 + (k === 'woman' || k === 'teengirl' ? 0.08 : 0), 0, 0.6),
    whisper: !!o.whisper,
    gain: Math.exp(rng.gauss() * 0.18),
    seed: seed32(rng),
  }
}

const FW = 9 // values per frame: t av ah af fc F1 F2 F3 f0

function P(fr, t, av, ah, af, fc, f1, f2, f3, f0) {
  const k = fr.length
  if (k >= FW && t < fr[k - FW]) t = fr[k - FW]
  fr.push(t, av, ah, af, fc, f1, f2, f3, f0)
}

/**
 * Append one talker frame: time (s), voicing, aspiration, frication levels,
 * frication centre (Hz), formants F1 F2 F3 (Hz) and pitch (Hz). Frames are
 * joined by straight lines; times never run backwards.
 */
export function pushFrame(fr, t, av, ah, af, fc, f1, f2, f3, f0) {
  P(fr, t, av, ah, af, fc, f1, f2, f3, f0)
}

/** Vowel targets for sung or shouted vowels, men's values (scale by the talker's fs). */
export const VOWELS = { ee: VOW[0], eh: VOW[2], a: VOW[3], ah: VOW[4], aw: VOW[5], oo: VOW[7], uh: VOW[8], oh: [450, 800, 2600] }

function last(fr, i) {
  return fr[fr.length - FW + i]
}

/**
 * Frames for one phrase of nSyl random syllables starting at t (s).
 * o: { effort, level, rateMul, question, f0Mul }. Returns the end time.
 */
export function phraseFrames(T, rng, fr, t, nSyl, o = {}) {
  const fs = T.fs
  const eff = o.effort ?? T.effort
  const f0base = T.f0 * semis(eff * 5) * (o.f0Mul ?? 1)
  const rate = T.rate * (o.rateMul ?? 1)
  const f0a = f0base * semis(rng.range(0.5, 2.5))
  const f0b = f0base * semis(rng.range(-3.5, -1))
  const question = rng.chance(o.question ?? 0.18)
  const lvl = o.level ?? 1
  const stressEvery = 2 + rng.int(2)
  const fcMax = 6400
  if (!fr.length) P(fr, t, 0, 0, 0, 3000, SCHWA[0] * fs, SCHWA[1] * fs, SCHWA[2] * fs, f0a)
  else P(fr, t, 0, 0, 0, last(fr, 4), last(fr, 5), last(fr, 6), last(fr, 7), f0a)
  let tt = t
  for (let s = 0; s < nSyl; s++) {
    const isLast = s === nSyl - 1
    const stressed = s % stressEvery === 0 ? !rng.chance(0.15) : rng.chance(0.15)
    const u = nSyl > 1 ? s / (nSyl - 1) : 0
    const f0 = f0a * Math.pow(f0b / f0a, u) * semis(rng.gauss() * 0.5)
    const acc = stressed ? semis(rng.range(1, 3.5) * (0.5 + T.expr)) : 1
    let f0end = f0 * Math.pow(acc, 0.3)
    if (isLast) f0end = question ? f0 * semis(rng.range(3, 6)) : f0 * semis(-rng.range(1, 3))
    const A = lvl * (stressed ? 1 : rng.range(0.55, 0.8))
    const sd = (1 / rate) * rng.range(0.75, 1.3) * (stressed ? 1.2 : 0.85) * (isLast ? 1.45 : 1)
    const vw = stressed || rng.chance(0.4) ? VOW[rng.int(VOW.length)] : SCHWA
    const j = 1 + rng.gauss() * 0.04
    const V1 = vw[0] * fs * j
    const V2 = vw[1] * fs * j
    const V3 = vw[2] * fs * j
    let W1 = V1
    let W2 = V2
    let W3 = V3
    if (stressed && rng.chance(0.25)) {
      const w2 = VOW[rng.int(VOW.length)]
      W1 = w2[0] * fs
      W2 = w2[1] * fs
      W3 = w2[2] * fs
    }
    const t0 = tt
    const fc0 = last(fr, 4)
    const r = rng.next()
    if (r < 0.33) {
      const c = STOPS[rng.int(STOPS.length)]
      const vo = c[0] === 1
      const cl = rng.range(0.03, 0.055)
      const L1 = c[2] * fs, L2 = c[3] * fs, L3 = c[4] * fs
      const bf = Math.min(fcMax, c[1] * fs)
      P(fr, tt + 0.012, vo ? 0.1 * A : 0, 0, 0, bf, L1, L2, L3, f0)
      P(fr, tt + cl, vo ? 0.08 * A : 0, 0, 0, bf, L1, L2, L3, f0)
      P(fr, tt + cl + 0.002, vo ? 0.15 * A : 0, 0, (vo ? 0.35 : 0.8) * A, bf, L1, L2, L3, f0)
      P(fr, tt + cl + 0.012, vo ? 0.5 * A : 0, vo ? 0 : 0.42 * A, 0.12 * A, bf, (L1 + V1) / 2, (L2 + V2) / 2, (L3 + V3) / 2, f0)
      tt += cl + 0.012
      if (!vo) {
        const asp = rng.range(0.02, 0.045)
        P(fr, tt + asp, 0.12 * A, 0.3 * A, 0, bf, V1, V2, V3, f0)
        tt += asp
      }
    } else if (r < 0.53) {
      const c = FRICS[rng.int(FRICS.length)]
      const vo = c[0] === 1
      const fd = rng.range(0.06, 0.11)
      const fc = Math.min(fcMax, c[1])
      const am = c[3] * A
      const L1 = c[4] * fs, L2 = c[5] * fs, L3 = c[6] * fs
      P(fr, tt + 0.015, vo ? 0.25 * A : 0, 0, am * 0.5, fc, L1, L2, L3, f0)
      P(fr, tt + 0.035, vo ? 0.3 * A : 0, 0, am, fc, L1, L2, L3, f0)
      P(fr, tt + fd - 0.012, vo ? 0.3 * A : 0, 0, am * 0.9, fc, L1, L2, L3, f0)
      P(fr, tt + fd, 0.3 * A, 0, am * 0.1, fc, (L1 + V1) / 2, (L2 + V2) / 2, (L3 + V3) / 2, f0)
      tt += fd
    } else if (r < 0.58) {
      const hd = rng.range(0.04, 0.07)
      P(fr, tt + 0.02, 0, 0.5 * A, 0, fc0, V1, V2, V3, f0)
      P(fr, tt + hd, 0.15 * A, 0.45 * A, 0, fc0, V1, V2, V3, f0)
      tt += hd
    } else if (r < 0.8) {
      const c = SONOR[rng.int(SONOR.length)]
      const nd = rng.range(0.04, 0.075)
      P(fr, tt + 0.02, c[1] * A, 0, 0, fc0, c[2] * fs, c[3] * fs, c[4] * fs, f0)
      P(fr, tt + nd, c[1] * A, 0, 0, fc0, c[2] * fs, c[3] * fs, c[4] * fs, f0)
      tt += nd
    } else if (last(fr, 1) < 0.05) {
      P(fr, tt + 0.012, 0.3 * A, 0.05 * A, 0, fc0, V1, V2, V3, f0)
      tt += 0.012
    }
    // coda choice decides the nucleus length
    const cr = rng.next()
    const coda = cr < 0.18 ? 1 : cr < 0.34 ? 2 : cr < 0.46 ? 3 : 0
    const codaDur = coda === 1 ? 0.06 : coda === 2 ? 0.05 : coda === 3 ? 0.1 : 0
    const vd = Math.max(0.06, sd - (tt - t0) - codaDur)
    const br = T.breath * A * 0.25
    P(fr, tt + Math.min(0.04, vd * 0.3), A, br, 0, fc0, V1, V2, V3, f0 * Math.sqrt(acc))
    P(fr, tt + vd * 0.55, A * 0.97, br, 0, fc0, V1 * 0.7 + W1 * 0.3, V2 * 0.7 + W2 * 0.3, V3 * 0.7 + W3 * 0.3, f0 * acc)
    P(fr, tt + vd, A * 0.8, br, 0, fc0, W1, W2, W3, f0end)
    tt += vd
    if (coda === 1) {
      const c = SONOR[rng.int(2)]
      P(fr, tt + 0.02, 0.4 * A, 0, 0, fc0, c[2] * fs, c[3] * fs, c[4] * fs, f0end)
      P(fr, tt + 0.06, 0.3 * A, 0, 0, fc0, c[2] * fs, c[3] * fs, c[4] * fs, f0end)
      tt += 0.06
    } else if (coda === 2) {
      const c = STOPS[rng.int(3)]
      P(fr, tt + 0.015, 0, 0, 0, c[1], c[2] * fs, c[3] * fs, c[4] * fs, f0end)
      P(fr, tt + 0.04, 0, 0, 0, c[1], c[2] * fs, c[3] * fs, c[4] * fs, f0end)
      if (rng.chance(0.5)) {
        P(fr, tt + 0.042, 0, 0, 0.3 * A, Math.min(fcMax, c[1]), c[2] * fs, c[3] * fs, c[4] * fs, f0end)
        P(fr, tt + 0.05, 0, 0, 0, Math.min(fcMax, c[1]), c[2] * fs, c[3] * fs, c[4] * fs, f0end)
      }
      tt += 0.05
    } else if (coda === 3) {
      const c = FRICS[rng.int(2)]
      P(fr, tt + 0.02, 0.1 * A, 0, 0.5 * c[3] * A, Math.min(fcMax, c[1]), V1, V2, V3, f0end)
      P(fr, tt + 0.08, 0, 0, 0.6 * c[3] * A, Math.min(fcMax, c[1]), V1, V2, V3, f0end)
      P(fr, tt + 0.1, 0, 0, 0, Math.min(fcMax, c[1]), V1, V2, V3, f0end)
      tt += 0.1
    }
  }
  P(fr, tt + 0.07, 0, 0, 0, last(fr, 4), last(fr, 5), last(fr, 6), last(fr, 7), last(fr, 8) * 0.95)
  return tt + 0.07
}

/**
 * Frames for a short reaction (no laughter): mhm, yeah, oh, ooh, aw, wow,
 * hey, or a cheer (a long shouted vowel). Returns the end time.
 * o: { effort, level, dur (cheer length) }
 */
export function reactFrames(T, rng, fr, t, type, o = {}) {
  const fs = T.fs
  const eff = o.effort ?? T.effort
  const f0 = T.f0 * semis(eff * 5)
  const A = o.level ?? 0.8
  const N = SONOR[0]
  const v = (i) => VOW[i]
  const seq = (list) => {
    // list of [dt, av, ah, F (triple), f0mul]
    let tt = t
    P(fr, tt, 0, 0, 0, 3000, list[0][3][0] * fs, list[0][3][1] * fs, list[0][3][2] * fs, f0 * list[0][4])
    for (const [dt, av, ah, F, fm] of list) {
      tt += dt
      P(fr, tt, av * A, ah * A, 0, 3000, F[0] * fs, F[1] * fs, F[2] * fs, f0 * fm)
    }
    tt += 0.06
    P(fr, tt, 0, 0, 0, 3000, last(fr, 5), last(fr, 6), last(fr, 7), last(fr, 8) * 0.95)
    return tt
  }
  const nas = [N[2], N[3], N[4]]
  switch (type) {
    case 'mhm':
      return seq([[0.03, 0.4, 0, nas, 0.95], [0.13, 0.32, 0, nas, 0.9], [0.05, 0.05, 0.1, nas, 0.95], [0.05, 0.42, 0, nas, 1.12], [0.17, 0.32, 0, nas, 1.25]])
    case 'yeah':
      return seq([[0.03, 0.5, 0, [280, 2150, 2950], 1.15], [0.06, 1, 0.05, v(2), 1.2], [0.12, 0.9, 0.05, v(3), 1.05], [0.1, 0.6, 0.05, SCHWA, 0.85]])
    case 'oh':
      return seq([[0.04, 0.9, 0.05, v(5), 1.3], [0.12, 1, 0.05, v(6), semis(4)], [0.14, 0.7, 0.05, v(7), 1.0]])
    case 'ooh':
      return seq([[0.06, 0.8, 0.1, v(7), 1], [0.25, 1, 0.1, v(7), semis(5)], [0.35, 0.8, 0.1, v(7), semis(2)], [0.2, 0.5, 0.1, v(6), 0.9]])
    case 'aw':
      return seq([[0.06, 0.9, 0.08, v(5), semis(3)], [0.35, 0.9, 0.08, v(5), 1], [0.25, 0.6, 0.08, v(6), semis(-3)]])
    case 'wow':
      return seq([[0.03, 0.6, 0, [300, 700, 2250], 1.1], [0.1, 1, 0.05, v(4), semis(5)], [0.16, 0.9, 0.05, v(5), semis(3)], [0.08, 0.6, 0, [300, 700, 2250], 1]])
    case 'hey':
      return seq([[0.05, 0.1, 0.6, v(2), semis(2)], [0.05, 1, 0.05, v(2), semis(4)], [0.18, 0.95, 0.05, v(1), semis(5)], [0.1, 0.7, 0.05, v(0), semis(2)]])
    default: {
      // cheer: a long shouted vowel that rises, holds with a wobble, and falls away
      const d = o.dur ?? rng.range(0.8, 2)
      const vv = rng.pick([v(4), v(3), v(2), v(7), v(5)])
      const list = [[0.08, 0.7, 0.15, vv, semis(rng.range(0, 3))]]
      const steps = Math.max(2, Math.round(d / 0.15))
      for (let s = 0; s < steps; s++) {
        const u = s / (steps - 1)
        const up = rng.range(5, 9) * Math.sin(Math.PI * Math.min(1, u * 1.4)) + rng.gauss() * 0.6
        list.push([d / steps, 1 - 0.3 * u * u, 0.18, vv, semis(up)])
      }
      list.push([0.15, 0.4, 0.15, vv, semis(1)])
      return seq(list)
    }
  }
}

/** Mono samples at rate wr for a talker's frames (times from 0). */
export function renderFrames(T, fr, wr, seed) {
  const nf = (fr.length / FW) | 0
  if (nf < 2) return new Float32Array(0)
  const tEnd = fr[(nf - 1) * FW]
  const len = Math.max(1, Math.ceil(tEnd * wr) + 1)
  const out = new Float32Array(len)
  const CB = 24
  const nyq = 0.45 * wr
  const fcMax = 0.42 * wr
  let s = seed | 0 || 0x1234567
  let ph = ((s >>> 0) % 1000) / 1000
  let y11 = 0, y12 = 0, y21 = 0, y22 = 0, y31 = 0, y32 = 0, y41 = 0, y42 = 0
  let tl = 0
  let fx1 = 0, fx2 = 0, fy1 = 0, fy2 = 0
  let jit = 1
  let shim = 1
  const oq = clamp(0.62 - 0.15 * T.effort + 0.1 * T.breath, 0.4, 0.75)
  const ioq = 1 / oq
  const tg = 1 - Math.exp((-TAU * (600 + 2600 * T.effort)) / wr)
  const bw = 1 + T.breath
  const r1 = Math.exp((-Math.PI * 80 * bw) / wr)
  const r2 = Math.exp((-Math.PI * 110 * (1 + T.breath * 0.5)) / wr)
  const r3 = Math.exp((-Math.PI * 170) / wr)
  const c1 = -r1 * r1
  const c2 = -r2 * r2
  const c3 = -r3 * r3
  // a fixed fourth formant (Klatt 1980 keeps F4 near 3.3 kHz, scaled here by vocal tract length)
  const F4 = Math.min(0.45 * wr, 3350 * T.fs)
  const r4 = Math.exp((-Math.PI * 280) / wr)
  const c4 = -r4 * r4
  const b4 = 2 * r4 * Math.cos((TAU * F4) / wr)
  const a4 = 1 - b4 - c4
  const jamt = T.jitter * 2
  const vg = T.gain * 0.24
  const fg = T.gain * 0.125
  const whisper = T.whisper
  const brm = T.breath * 0.12
  let k = 0
  let k2 = 0
  for (let i0 = 0; i0 < len; i0 += CB) {
    const i1 = Math.min(len, i0 + CB)
    const ta = i0 / wr
    const tb = i1 / wr
    while (k < nf - 2 && fr[(k + 1) * FW] <= ta) k++
    if (k2 < k) k2 = k
    while (k2 < nf - 2 && fr[(k2 + 1) * FW] <= tb) k2++
    const ka = k * FW
    const kb = ka + FW
    const spa = fr[kb] - fr[ka]
    const ua = spa > 1e-9 ? clamp((ta - fr[ka]) / spa, 0, 1) : 1
    const kc = k2 * FW
    const kd = kc + FW
    const spb = fr[kd] - fr[kc]
    const ub = spb > 1e-9 ? clamp((tb - fr[kc]) / spb, 0, 1) : 1
    let av0 = fr[ka + 1] + (fr[kb + 1] - fr[ka + 1]) * ua
    let av1 = fr[kc + 1] + (fr[kd + 1] - fr[kc + 1]) * ub
    let ah0 = fr[ka + 2] + (fr[kb + 2] - fr[ka + 2]) * ua
    let ah1 = fr[kc + 2] + (fr[kd + 2] - fr[kc + 2]) * ub
    const af0 = fr[ka + 3] + (fr[kb + 3] - fr[ka + 3]) * ua
    const af1 = fr[kc + 3] + (fr[kd + 3] - fr[kc + 3]) * ub
    if (whisper) {
      ah0 += av0 * 0.8
      ah1 += av1 * 0.8
      av0 = 0
      av1 = 0
    }
    if (av0 === 0 && av1 === 0 && ah0 === 0 && ah1 === 0 && af0 === 0 && af1 === 0) {
      // silent stretch: the source is off, so the old block's resonances
      // simply die away; after a few blocks the states are flushed to zero
      if (y41 !== 0 || y31 !== 0) {
        for (let i = i0; i < i1; i++) {
          y41 *= 0.9
          out[i] = y41 * vg
        }
        if (y41 < 1e-6 && y41 > -1e-6) y11 = y12 = y21 = y22 = y31 = y32 = y41 = y42 = 0
      }
      tl = 0
      fy1 = fy2 = fx1 = fx2 = 0
      continue
    }
    const fc = Math.min(fcMax, fr[ka + 4] + (fr[kb + 4] - fr[ka + 4]) * ua)
    const F1 = Math.min(nyq, fr[ka + 5] + (fr[kb + 5] - fr[ka + 5]) * ua)
    const F2 = Math.min(nyq, fr[ka + 6] + (fr[kb + 6] - fr[ka + 6]) * ua)
    const F3 = Math.min(nyq, fr[ka + 7] + (fr[kb + 7] - fr[ka + 7]) * ua)
    const f0 = fr[ka + 8] + (fr[kb + 8] - fr[ka + 8]) * ua
    const b1 = 2 * r1 * Math.cos((TAU * F1) / wr)
    const b2 = 2 * r2 * Math.cos((TAU * F2) / wr)
    const b3 = 2 * r3 * Math.cos((TAU * F3) / wr)
    const a1 = 1 - b1 - c1
    const a2 = 1 - b2 - c2
    const a3 = 1 - b3 - c3
    const fq = fc > 4500 ? 2.5 : fc > 2600 ? 2 : 0.7
    const rF = Math.exp((-Math.PI * (fc / fq)) / wr)
    const bF = 2 * rF * Math.cos((TAU * fc) / wr)
    const cF = -rF * rF
    const gF = 1 - rF
    const dph = clamp(f0, 30, 1200) / wr
    const inv = 1 / (i1 - i0)
    const dav = (av1 - av0) * inv
    const dah = (ah1 - ah0) * inv
    const daf = (af1 - af0) * inv
    let av = av0
    let ah = ah0
    let af = af0
    for (let i = i0; i < i1; i++) {
      ph += dph * jit
      if (ph >= 1) {
        ph -= 1
        s ^= s << 13
        s ^= s >>> 17
        s ^= s << 5
        jit = 1 + jamt * (s / 2147483648)
        s ^= s << 13
        s ^= s >>> 17
        s ^= s << 5
        shim = 1 + 0.12 * (s / 2147483648)
      }
      let g = 0
      const open = ph < oq
      if (open) {
        const x = ph * ioq
        g = 2 * x - 3 * x * x
      }
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      const nz = s / 2147483648
      tl += (g * av * shim - tl) * tg
      const src = tl + nz * (ah + av * brm) * (open ? 0.2 : 0.08)
      let y = a1 * src + b1 * y11 + c1 * y12
      y12 = y11
      y11 = y
      y = a2 * y + b2 * y21 + c2 * y22
      y22 = y21
      y21 = y
      y = a3 * y + b3 * y31 + c3 * y32
      y32 = y31
      y31 = y
      y = a4 * y + b4 * y41 + c4 * y42
      y42 = y41
      y41 = y
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      const n2 = s / 2147483648
      const f = gF * (n2 - fx2) + bF * fy1 + cF * fy2
      fx2 = fx1
      fx1 = n2
      fy2 = fy1
      fy1 = f
      out[i] = y * vg + f * af * fg
      av += dav
      ah += dah
      af += daf
    }
    if (!(y41 > -1e6 && y41 < 1e6) || !(fy1 > -1e6 && fy1 < 1e6)) {
      y11 = y12 = y21 = y22 = y31 = y32 = y41 = y42 = fy1 = fy2 = fx1 = fx2 = tl = 0
    }
  }
  return out
}

/**
 * Turns for a table of talkers from t0 to t1 (s). Returns, per talker, a
 * list of { t, fr } spurts. o: { react (0..1 chance of a backchannel),
 * gap (mean pause between turns), phrases [min, max] per turn,
 * syl [min, max] syllables per phrase, silence (chance of a lull) }
 */
export function conversation(rng, talkers, t0, t1, o = {}) {
  const N = talkers.length
  const out = talkers.map(() => [])
  const ends = new Float64Array(N).fill(-1e9)
  if (!N) return out
  const react = o.react ?? 0.35
  const types = ['mhm', 'yeah', 'oh', 'mhm', 'yeah', 'wow', 'aw', 'ooh']
  let t = t0
  let cur = rng.int(N)
  let guard = 0
  const sylMin = o.syl ? o.syl[0] : 3
  const sylMax = o.syl ? o.syl[1] : 11
  const phMin = o.phrases ? o.phrases[0] : 1
  const phMax = o.phrases ? o.phrases[1] : 3
  while (t < t1 && guard++ < 5000) {
    if (rng.chance(o.silence ?? (N === 1 ? 0.35 : 0.08))) {
      t += rng.range(1, N === 1 ? 6 : 3.5)
      continue
    }
    const T = talkers[cur]
    const nph = phMin + rng.int(phMax - phMin + 1)
    for (let p = 0; p < nph && t < t1; p++) {
      const fr = []
      const nSyl = sylMin + rng.int(sylMax - sylMin + 1)
      const d = phraseFrames(T, rng, fr, 0, nSyl, o.phrase)
      if (t + d > -0.5) out[cur].push({ t, fr })
      ends[cur] = t + d
      if (N > 1 && rng.chance(react * 0.5)) {
        let who = rng.int(N - 1)
        if (who >= cur) who++
        const tr = t + d * rng.range(0.35, 0.95)
        if (tr > ends[who] + 0.2) {
          const rf = []
          const rd = reactFrames(talkers[who], rng, rf, 0, rng.pick(types), { level: rng.range(0.4, 0.8) })
          out[who].push({ t: tr, fr: rf })
          ends[who] = tr + rd
        }
      }
      t += d + rng.range(0.12, 0.55)
    }
    t += rng.range(-0.25, 0.25) + (o.gap ?? 0.25) * rng.next() * 2
    if (N > 1) {
      let nx = rng.int(N - 1)
      if (nx >= cur) nx++
      cur = nx
    }
  }
  return out
}

/** Render talkers' spurts at the talker rate and mix them into the scene. */
export function addTalker(sc, T, spurts, pan, dist, gain = 1, send = 1) {
  const lo = lowBus(sc)
  for (const sp of spurts) {
    const off = Math.round(sp.t * lo.wr)
    if (off >= lo.n) continue
    const sig = renderFrames(T, sp.fr, lo.wr, T.seed ^ (off * 2654435761))
    if (off + sig.length <= 0) continue
    mixLow(sc, sig, off, pan, dist, gain * T.gain, send)
  }
}

/**
 * Tables of people talking around the listener.
 * o: { groups, size: [min, max], dist: [near, far] m, width (pan spread),
 *   kinds: { man, woman, child, teen } weights, effort, rate, expr, react,
 *   gain, send, whisper, t0, t1, silence, gap, phrase }
 */
export function crowd(sc, rng, o = {}) {
  const groups = Math.max(0, Math.round(o.groups ?? 4))
  const size = o.size || [2, 3]
  const dist = o.dist || [2, 10]
  const width = o.width ?? 0.95
  const kinds = o.kinds || { man: 1, woman: 1 }
  const names = Object.keys(kinds)
  const weights = names.map((k) => kinds[k])
  const t0 = o.t0 ?? -rng.range(0, 4)
  const t1 = o.t1 ?? sc.dur
  for (let g = 0; g < groups; g++) {
    const gr = rng.fork('table' + g)
    const m = size[0] + gr.int(size[1] - size[0] + 1)
    const d = logRange(gr, dist[0], dist[1])
    const pan = gr.range(-width, width)
    const list = []
    for (let i = 0; i < m; i++) {
      list.push(makeTalker(gr, names[pickW(gr, weights)], { effort: o.effort, rate: o.rate, expr: o.expr, whisper: o.whisper }))
    }
    const spurts = conversation(gr, list, t0 - gr.range(0, 3), t1, o)
    for (let i = 0; i < m; i++) {
      const pi = clamp(pan + gr.range(-0.12, 0.12), -1, 1)
      const di = d * gr.range(0.85, 1.2)
      addTalker(sc, list[i], spurts[i], pi, di, o.gain ?? 1, o.send ?? 1)
    }
  }
}

/** A talker's frames rendered to a mono signal at the scene rate (for PA, shouts and phones). */
export function voiceAtRate(sc, T, fr) {
  const lo = lowBus(sc)
  const sig = renderFrames(T, fr, lo.wr, T.seed)
  if (lo.k === 1) return sig
  const out = new Float32Array(sig.length * lo.k)
  upAdd(sig, out, lo.k)
  return out
}

/** Several phrases from one talker as one frames list. Returns { fr, dur }. */
export function speech(T, rng, nPhrases, o = {}) {
  const fr = []
  let t = 0
  for (let p = 0; p < nPhrases; p++) {
    t = phraseFrames(T, rng, fr, t, (o.syl ? o.syl[0] : 4) + rng.int(o.syl ? o.syl[1] - o.syl[0] + 1 : 7), o)
    if (p < nPhrases - 1) {
      const pause = rng.range(o.pause ? o.pause[0] : 0.25, o.pause ? o.pause[1] : 0.6)
      P(fr, t + pause, 0, 0, 0, last(fr, 4), last(fr, 5), last(fr, 6), last(fr, 7), last(fr, 8))
      t += pause
    }
  }
  return { fr, dur: t }
}

/** Public-address colouring: horn speaker band, a little push, cone resonances. */
export function paColor(sig, sr, o = {}) {
  filt(sig, sr, [
    ['highpass', o.lo ?? 380, 0.7],
    ['highpass', o.lo ?? 380, 0.7],
    ['lowpass', o.hi ?? 3800, 0.7],
    ['lowpass', o.hi ?? 3800, 0.7],
    ['peak', 1400, 1.2, 4],
    ['peak', 2600, 2, 3],
  ])
  let pk = 0
  for (let i = 0; i < sig.length; i++) if (Math.abs(sig[i]) > pk) pk = Math.abs(sig[i])
  const drive = o.drive ?? 2
  const k = pk > 0 ? drive / pk : 1
  for (let i = 0; i < sig.length; i++) sig[i] = Math.tanh(sig[i] * k) * (pk / Math.tanh(drive))
  return sig
}

/**
 * An announcement over loudspeakers: an optional chime, then garbled
 * phrases from one talker through horn speakers at several places (each
 * arriving at its own time). o: { kind, phrases, speakers: [[pan, dist]...],
 * chime: [[hz, delay]...], gain, send, effort, rate, drive }
 */
export function announce(sc, rng, t, o = {}) {
  const T = makeTalker(rng, o.kind || 'adult', { effort: o.effort ?? 0.55, rate: o.rate ?? 4.4, expr: 0.35 })
  let start = t
  const spk = o.speakers || [[-0.5, 12], [0.6, 20], [0.1, 35]]
  if (o.chime) {
    const c = chime(sc.sr, rng.fork('chime'), o.chime, o.chimeTone)
    for (const [pan, d] of spk) emit(sc, c, (start + d / SOUND_SPEED) * sc.sr, pan, d, (o.gain ?? 1) * 0.9 * Math.sqrt(d), o.send ?? 1.5)
    start += o.chime[o.chime.length - 1][1] + 1.1
  }
  const { fr } = speech(T, rng, o.phrases ?? 3, { effort: T.effort, pause: [0.3, 0.7] })
  const sig = paColor(voiceAtRate(sc, T, fr), sc.sr, { drive: o.drive ?? 2 })
  for (const [pan, d] of spk) emit(sc, sig, (start + d / SOUND_SPEED) * sc.sr, pan, d, (o.gain ?? 1) * Math.sqrt(d) * 1.5, o.send ?? 1.5)
  return start + sig.length / sc.sr
}

// ---------------------------------------------------------------- struck objects

/**
 * Modal strike: modes is a flat list [hz, decaySeconds, amp, ...].
 * o: { hard (Hz above which modes are softened), tick (contact noise level),
 *   tickHz, tickMs, maxSec, seed }
 */
export function modal(sr, modes, o = {}) {
  const hard = o.hard ?? 8000
  let longest = 0
  for (let m = 0; m < modes.length; m += 3) if (modes[m] < 0.45 * sr && modes[m + 1] > longest) longest = modes[m + 1]
  const tickMs = o.tickMs ?? 2
  const sec = Math.min(o.maxSec ?? 3, longest * 6.9 + 0.01, 8)
  const len = Math.max(8, Math.ceil(Math.max(sec, (tickMs * 4) / 1000) * sr))
  const out = new Float32Array(len)
  for (let m = 0; m < modes.length; m += 3) {
    const f = modes[m]
    if (!(f > 10) || f >= 0.45 * sr) continue
    const dec = Math.max(0.0005, modes[m + 1])
    const amp = modes[m + 2] / (1 + (f / hard) * (f / hard))
    const w = (TAU * f) / sr
    const r = Math.exp(-1 / (dec * sr))
    const cw = 2 * r * Math.cos(w)
    const r2 = r * r
    let y1 = amp * Math.sin(w) * r
    let y2 = 0
    out[1] += y1
    const mEnd = Math.min(len, Math.ceil(dec * sr * 7))
    for (let i = 2; i < mEnd; i++) {
      const y = cw * y1 - r2 * y2
      y2 = y1
      y1 = y
      out[i] += y
    }
  }
  const tick = o.tick ?? 0.3
  if (tick > 0) {
    let s = o.seed | 0 || 0x51ed27
    const tl = Math.max(4, Math.round((tickMs / 1000) * sr))
    const tk = new Float32Array(tl * 4)
    for (let i = 0; i < tk.length; i++) {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      tk[i] = (s / 2147483648) * Math.exp(-i / tl)
    }
    hp1(tk, sr, o.tickHz ?? 1500)
    for (let i = 0; i < tk.length && i < len; i++) out[i] += tk[i] * tick
  }
  return out
}

/**
 * Mode tables for everyday objects with natural spread: returns a flat
 * [hz, decay, amp, ...] list. kind: mug, saucer, glass, wineglass, spoon,
 * plate, pot, pan, locker, coin, chip, bell, wood, plastic, cutlery, bar,
 * bottle, metal (sheet), tray, ice, porcelain.
 */
export function objectModes(kind, rng, size = 1) {
  let f1
  let ratios
  let decays
  let amps
  switch (kind) {
    case 'mug':
      f1 = rng.range(1500, 2300)
      ratios = [1, 1.62, 2.43, 3.36, 4.4]
      decays = [0.16, 0.11, 0.08, 0.06, 0.04]
      amps = [1, 0.7, 0.5, 0.35, 0.22]
      break
    case 'porcelain':
      f1 = rng.range(2400, 3600)
      ratios = [1, 1.55, 2.2, 3.1]
      decays = [0.22, 0.15, 0.1, 0.06]
      amps = [1, 0.6, 0.4, 0.25]
      break
    case 'saucer':
      f1 = rng.range(1000, 1500)
      ratios = [1, 1.7, 2.9, 3.9, 5.2]
      decays = [0.3, 0.22, 0.16, 0.1, 0.07]
      amps = [1, 0.8, 0.55, 0.35, 0.2]
      break
    case 'glass':
      f1 = rng.range(1800, 3000)
      ratios = [1, 2.4, 4.3, 6.6]
      decays = [0.55, 0.3, 0.18, 0.1]
      amps = [1, 0.5, 0.3, 0.15]
      break
    case 'wineglass':
      f1 = rng.range(650, 1100)
      ratios = [1, 2.32, 4.25, 6.63]
      decays = [1.6, 0.8, 0.4, 0.2]
      amps = [1, 0.45, 0.25, 0.1]
      break
    case 'spoon':
      f1 = rng.range(2600, 4400)
      ratios = [1, 2.76, 5.4]
      decays = [0.07, 0.04, 0.02]
      amps = [1, 0.5, 0.25]
      break
    case 'plate':
      f1 = rng.range(600, 1000)
      ratios = [1, 1.59, 2.14, 2.65, 3.6, 4.2]
      decays = [0.35, 0.28, 0.2, 0.15, 0.1, 0.07]
      amps = [1, 0.8, 0.6, 0.5, 0.35, 0.2]
      break
    case 'pot':
      f1 = rng.range(170, 380)
      ratios = [1, 1.59, 2.14, 2.3, 2.65, 2.92, 3.5, 4.06, 4.9]
      decays = [1.2, 1, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2]
      amps = [0.6, 1, 0.8, 0.6, 0.6, 0.5, 0.4, 0.3, 0.2]
      break
    case 'pan':
      f1 = rng.range(260, 480)
      ratios = [1, 1.59, 2.14, 2.65, 3.2, 3.9]
      decays = [0.6, 0.45, 0.35, 0.25, 0.18, 0.12]
      amps = [1, 0.8, 0.6, 0.45, 0.3, 0.2]
      break
    case 'locker':
      f1 = rng.range(110, 220)
      ratios = [1, 1.43, 2.1, 2.7, 3.4, 4.6, 6.1, 8.3, 11.2]
      decays = [0.3, 0.26, 0.2, 0.16, 0.12, 0.1, 0.07, 0.05, 0.035]
      amps = [1, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2]
      break
    case 'metal':
      f1 = rng.range(300, 700)
      ratios = [1, 1.37, 1.92, 2.56, 3.3, 4.2, 5.3]
      decays = [0.5, 0.4, 0.3, 0.22, 0.16, 0.12, 0.08]
      amps = [1, 0.8, 0.7, 0.5, 0.4, 0.3, 0.2]
      break
    case 'coin':
      f1 = rng.range(3800, 6000)
      ratios = [1, 1.47, 2.08, 2.5]
      decays = [0.45, 0.3, 0.2, 0.12]
      amps = [1, 0.6, 0.4, 0.3]
      break
    case 'chip':
      f1 = rng.range(2200, 3400)
      ratios = [1, 1.8, 2.7]
      decays = [0.022, 0.016, 0.01]
      amps = [1, 0.6, 0.3]
      break
    case 'bell':
      f1 = rng.range(2100, 2700)
      ratios = [1, 2.03, 2.74, 3.66, 5.1]
      decays = [1.6, 1.0, 0.7, 0.4, 0.25]
      amps = [1, 0.5, 0.45, 0.25, 0.15]
      break
    case 'wood':
      f1 = rng.range(160, 360)
      ratios = [1, 2.3, 3.9, 5.6]
      decays = [0.035, 0.02, 0.014, 0.01]
      amps = [1, 0.6, 0.4, 0.25]
      break
    case 'plastic':
      f1 = rng.range(1600, 3200)
      ratios = [1, 1.8, 2.9, 4.1]
      decays = [0.012, 0.008, 0.006, 0.004]
      amps = [1, 0.7, 0.4, 0.2]
      break
    case 'cutlery':
      f1 = rng.range(2400, 4800)
      ratios = [1, 2.76, 5.4, 8.9]
      decays = [0.25, 0.12, 0.06, 0.03]
      amps = [1, 0.6, 0.35, 0.2]
      break
    case 'bar':
      f1 = rng.range(300, 900)
      ratios = [1, 2.76, 5.4, 8.93]
      decays = [1.1, 0.6, 0.3, 0.15]
      amps = [1, 0.6, 0.4, 0.25]
      break
    case 'bottle':
      f1 = rng.range(1200, 2400)
      ratios = [1, 2.2, 3.7, 5.3]
      decays = [0.5, 0.3, 0.18, 0.1]
      amps = [1, 0.5, 0.3, 0.15]
      break
    case 'tray':
      f1 = rng.range(400, 800)
      ratios = [1, 1.5, 2.3, 3.1, 4.4, 5.9]
      decays = [0.25, 0.2, 0.15, 0.1, 0.07, 0.05]
      amps = [1, 0.8, 0.6, 0.5, 0.3, 0.2]
      break
    case 'ice':
      f1 = rng.range(1800, 3600)
      ratios = [1, 1.7, 2.6]
      decays = [0.012, 0.009, 0.006]
      amps = [1, 0.6, 0.3]
      break
    default:
      f1 = rng.range(400, 900)
      ratios = [1, 2.1, 3.4]
      decays = [0.1, 0.06, 0.03]
      amps = [1, 0.6, 0.3]
  }
  const out = []
  const f = f1 / Math.max(0.2, size)
  // the table's decays are relative; this scale makes them time constants
  // (seconds to fall by e) that match how long each object really rings
  const ds = (DECAY_SCALE[kind] ?? 0.5) * Math.sqrt(Math.max(0.3, size))
  for (let i = 0; i < ratios.length; i++) {
    out.push(f * ratios[i] * (1 + rng.gauss() * 0.015), decays[i] * ds * rng.range(0.8, 1.25), amps[i] * rng.range(0.6, 1.2))
  }
  return out
}

const DECAY_SCALE = {
  mug: 0.55, porcelain: 0.55, saucer: 0.4, glass: 0.35, wineglass: 0.3, spoon: 0.6, plate: 0.45, pot: 0.4,
  pan: 0.5, locker: 0.4, metal: 0.5, coin: 0.4, chip: 1, bell: 0.35, wood: 0.7, plastic: 1, cutlery: 0.5,
  bar: 0.4, bottle: 0.45, tray: 0.5, ice: 1,
}

const TICKS = {
  mug: [1800, 0.25], porcelain: [2500, 0.25], saucer: [1500, 0.25], glass: [3000, 0.15], wineglass: [3000, 0.1],
  spoon: [3500, 0.3], plate: [1500, 0.3], pot: [800, 0.25], pan: [900, 0.25], locker: [500, 0.6], metal: [900, 0.3],
  coin: [4000, 0.2], chip: [2500, 0.6], bell: [3000, 0.08], wood: [300, 0.8], plastic: [1800, 0.8], cutlery: [3000, 0.25],
  bar: [800, 0.2], bottle: [2000, 0.2], tray: [900, 0.3], ice: [2500, 0.8],
}

/** One strike of an object (see objectModes). o: { size, hard, tick, maxSec } */
export function strike(sr, rng, kind, o = {}) {
  const modes = objectModes(kind, rng, o.size ?? 1)
  const t = TICKS[kind] || [1000, 0.3]
  return modal(sr, modes, { hard: o.hard ?? 9000, tick: (o.tick ?? 1) * t[1], tickHz: t[0], tickMs: o.tickMs ?? 1.5, maxSec: o.maxSec ?? 2.5, seed: seed32(rng) })
}

/** A dull body thump: a damped low sine with a soft noise attack. */
export function thump(sr, rng, hz, decay, o = {}) {
  const len = Math.ceil((decay * 6 + 0.01) * sr)
  const out = new Float32Array(len)
  const w0 = hz / sr
  const kd = Math.exp(-1 / (decay * sr))
  const ka = Math.exp(-1 / (0.0015 * sr))
  const kp = Math.exp(-1 / (decay * 0.5 * sr))
  const drop = o.drop ?? 0.3
  let ed = 1
  let ea = 1
  let ep = 1
  let ph = 0
  for (let i = 0; i < len; i++) {
    ph += w0 * (1 + drop * ep)
    if (ph >= 1) ph -= 1
    out[i] = sinCycles(ph) * ed * (1 - ea)
    ed *= kd
    ea *= ka
    ep *= kp
  }
  const nz = o.noise ?? 0.3
  if (nz > 0) {
    let s = seed32(rng)
    const nl = Math.min(len, Math.ceil(0.02 * sr))
    let lp = 0
    const G = onePoleG(o.noiseHz ?? 1200, sr)
    for (let i = 0; i < nl; i++) {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      const v = (s / 2147483648 - lp) * G
      lp += 2 * v
      out[i] += lp * nz * Math.exp(-i / (0.004 * sr))
    }
  }
  return out
}

/** A burst of coloured noise: attack, decay, band. o: { att, dec, hz, q, type, amp } */
export function noiseBurst(sr, rng, dur, o = {}) {
  const len = Math.max(4, Math.ceil(dur * sr))
  const out = new Float32Array(len)
  let s = seed32(rng)
  const att = Math.max(0.0005, o.att ?? 0.002)
  const dec = Math.max(0.001, o.dec ?? dur / 4)
  const na = Math.max(1, Math.round(att * sr))
  const kd = Math.exp(-1 / (dec * sr))
  let e = 1
  for (let i = 0; i < len; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    let env
    if (i < na) env = i / na
    else {
      env = e
      e *= kd
    }
    out[i] = (s / 2147483648) * env
  }
  if (o.hz) filt(out, sr, [[o.type || 'bandpass', o.hz, o.q ?? 1]])
  if (o.hz2) filt(out, sr, [[o.type2 || 'lowpass', o.hz2, o.q2 ?? 0.7]])
  if (o.amp !== undefined && o.amp !== 1) for (let i = 0; i < len; i++) out[i] *= o.amp
  if (o.rel > 0) {
    const nr = Math.min(len, Math.round(o.rel * sr))
    for (let i = 0; i < nr; i++) out[len - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / nr)
  }
  return out
}

/**
 * A long steady noise that runs from t to t + dur (s), made only for the
 * part inside the take: attack and release where they fall inside.
 * o: { att, rel, hz, q, type, hz2 }. Returns { sig, start } (start in s) or null.
 */
export function steadyNoise(sc, rng, t, dur, o = {}) {
  const a = Math.max(t, -0.2)
  const b = Math.min(t + dur, sc.dur + 0.2)
  if (b - a < 0.05) return null
  const att = a === t ? o.att ?? 0.5 : 0.0005
  const rel = b === t + dur ? o.rel ?? 0.5 : 0
  const sig = noiseBurst(sc.sr, rng, b - a, { att, dec: 1e6, hz: o.hz, q: o.q, type: o.type, hz2: o.hz2, q2: o.q2, rel })
  return { sig, start: a }
}

/** The part of sig before it falls silent for good (below rel times its peak). */
export function trim(sig, rel = 2e-4) {
  let pk = 0
  for (let i = 0; i < sig.length; i++) {
    const v = sig[i] < 0 ? -sig[i] : sig[i]
    if (v > pk) pk = v
  }
  const th = pk * rel
  let e = sig.length
  while (e > 1 && !(Math.abs(sig[e - 1]) > th)) e--
  return e < sig.length ? sig.subarray(0, e) : sig
}

/** Add b into a at sample offset off (a grows never). */
export function addAt(a, b, off, g = 1) {
  const o = Math.round(off)
  const e = Math.min(a.length, o + b.length)
  for (let i = Math.max(0, o); i < e; i++) a[i] += b[i - o] * g
  return a
}

/** Make a buffer of given seconds. */
export function buf(sr, sec) {
  return new Float32Array(Math.max(1, Math.ceil(sec * sr)))
}

// ---------------------------------------------------------------- footsteps

const SURF = {
  tile: { hz: 95, dec: 0.018, nz: 0.9, nhz: 2600, q: 0.8, click: 0.6, scuff: 0.25, shz: 3500 },
  concrete: { hz: 85, dec: 0.02, nz: 0.8, nhz: 1800, q: 0.7, click: 0.5, scuff: 0.35, shz: 2500 },
  wood: { hz: 130, dec: 0.03, nz: 0.6, nhz: 1100, q: 0.9, click: 0.35, scuff: 0.2, shz: 2000 },
  carpet: { hz: 105, dec: 0.022, nz: 0.35, nhz: 500, q: 0.7, click: 0, scuff: 0.12, shz: 900, thud: 0.4 },
  vinyl: { hz: 100, dec: 0.02, nz: 0.6, nhz: 1600, q: 0.8, click: 0.25, scuff: 0.2, shz: 2600 },
  gravel: { hz: 90, dec: 0.03, nz: 1.0, nhz: 2200, q: 0.5, click: 0.1, scuff: 0.8, shz: 3000 },
}

/** One footstep. o: { surface, shoe: hard|soft|heel, weight 0..1, squeak 0..1 } */
export function footstep(sr, rng, o = {}) {
  const S = SURF[o.surface] || SURF.tile
  const shoe = o.shoe || 'hard'
  const w = o.weight ?? 0.5
  const out = buf(sr, 0.32)
  const heel = thump(sr, rng, S.hz * rng.range(0.85, 1.2) * (1.2 - 0.4 * w), S.dec * rng.range(0.8, 1.2), { noise: 0, drop: 0.5 })
  addAt(out, heel, 0, (0.6 + 0.6 * w) * (S.thud ?? 1))
  const soft = shoe === 'soft' ? 0.4 : 1
  const cl = noiseBurst(sr, rng, 0.03, { att: 0.0004, dec: 0.004, hz: S.nhz * rng.range(0.8, 1.25), q: S.q })
  addAt(out, cl, 0, S.nz * soft * rng.range(0.6, 1.1))
  if (shoe === 'heel') {
    const hc = modal(sr, [rng.range(2800, 4200), 0.012, 1, rng.range(5500, 7000), 0.006, 0.5], { tick: 0.4, tickHz: 3000, seed: seed32(rng) })
    addAt(out, hc, 0, 0.5)
  } else if (S.click > 0 && shoe !== 'soft') {
    const hc = noiseBurst(sr, rng, 0.012, { att: 0.0002, dec: 0.0015, hz: 4000, q: 1.2 })
    addAt(out, hc, 0, S.click * 0.6)
  }
  const toeT = rng.range(0.05, 0.1)
  const toe = noiseBurst(sr, rng, 0.08, { att: 0.006, dec: 0.02, hz: S.shz * rng.range(0.7, 1.2), q: 0.8 })
  addAt(out, toe, toeT * sr, S.scuff * soft * rng.range(0.5, 1.1))
  const toeThump = thump(sr, rng, S.hz * 1.4, S.dec * 0.6, { noise: 0, drop: 0.3 })
  addAt(out, toeThump, toeT * sr, 0.25 + 0.3 * w)
  if ((o.squeak ?? 0) > 0 && rng.chance(o.squeak)) addAt(out, squeak(sr, rng), toeT * sr, 0.6)
  return trim(out)
}

/** A rubber sole squeak on a polished floor: a short gliding tone with harmonics. */
export function squeak(sr, rng) {
  const d = rng.range(0.05, 0.16)
  const out = buf(sr, d)
  const f0 = rng.range(900, 2400)
  const f1 = f0 * rng.range(0.7, 1.5)
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const u = i / out.length
    const f = f0 + (f1 - f0) * u
    ph += (TAU * f) / sr
    const env = Math.sin(Math.PI * u)
    out[i] = (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph)) * env * env * 0.5
  }
  return out
}

/**
 * Someone walking past: steps along a straight line. o: { t (start s), pace
 * (steps/s), x0, speed (m/s), closest (m), side, surface, shoe, gain, weight }
 */
export function walker(sc, rng, o = {}) {
  const sr = sc.sr
  const pace = o.pace ?? rng.range(1.7, 2.1)
  const speed = o.speed ?? pace * 0.7
  const dir = o.dir ?? (rng.chance(0.5) ? 1 : -1)
  const x0 = o.x0 ?? -dir * rng.range(6, 12)
  const close = o.closest ?? rng.range(1.5, 5)
  const t0 = o.t ?? 0
  const dur = o.dur ?? (Math.abs(x0) * 2) / speed
  const weight = o.weight ?? rng.range(0.3, 0.8)
  const steps = Math.floor(dur * pace)
  for (let k = 0; k < steps; k++) {
    const t = t0 + k / pace + rng.gauss() * 0.008
    if (t > sc.dur + 0.5) break
    if (t < -0.5) continue
    const x = x0 + dir * speed * (k / pace)
    const d = Math.sqrt(x * x + close * close)
    const st = footstep(sr, rng, { surface: o.surface, shoe: o.shoe, weight: weight * (k % 2 ? 0.9 : 1), squeak: o.squeak })
    emit(sc, st, t * sr, ((o.side ?? 1) * x) / d, d, (o.gain ?? 0.5) * rng.range(0.8, 1.1), o.send ?? 1)
  }
}

// ---------------------------------------------------------------- tones

/** A tone: additive partials [ratio, amp] below Nyquist, attack and release. o: { partials, att, rel, vib, vibHz } */
export function tone(sr, hz, dur, o = {}) {
  const len = Math.max(4, Math.ceil(dur * sr))
  const out = new Float32Array(len)
  const parts = o.partials || [[1, 1]]
  const att = Math.max(0.0005, o.att ?? 0.005)
  const rel = Math.max(0.0005, o.rel ?? 0.01)
  const vib = o.vib ?? 0
  const vhz = o.vibHz ?? 5
  for (const [rt, amp] of parts) {
    const f = hz * rt
    if (f >= 0.45 * sr) continue
    let ph = 0
    const inc = f / sr
    const vinc = vhz / sr
    let vp = 0
    for (let i = 0; i < len; i++) {
      if (vib) {
        ph += inc * (1 + vib * sinCycles(vp))
        vp += vinc
      } else ph += inc
      if (ph >= 1) ph -= Math.floor(ph)
      out[i] += sinCycles(ph) * amp
    }
  }
  for (let i = 0; i < len; i++) {
    const t = i / sr
    const e = Math.min(1, t / att) * Math.min(1, (dur - t) / rel)
    out[i] *= e > 0 ? e : 0
  }
  return out
}

/** Square-ish partials (odd harmonics) for beeps and buzzers. */
export function squareParts(n = 7, bright = 1) {
  const out = []
  for (let k = 1; k <= 2 * n; k += 2) out.push([k, Math.pow(1 / k, 1.6 - 0.6 * bright)])
  return out
}

/** Vibraphone-like chime notes [[hz, startSec]...]. o: { decay (time constant s) } */
export function chime(sr, rng, notes, o = {}) {
  const lastT = notes.length ? notes[notes.length - 1][1] : 0
  const dec = o.decay ?? 0.45
  const out = buf(sr, lastT + dec * 7)
  for (const [hz, t] of notes) {
    const m = modal(sr, [hz, dec, 1, hz * 4, dec * 0.25, 0.25, hz * 10, 0.03, 0.06, hz * 2, dec * 0.4, 0.1], { tick: 0.05, tickHz: 2000, hard: 12000, seed: seed32(rng) })
    addAt(out, m, t * sr, 1)
  }
  return out
}

/** One electronic phone ring burst: two tones alternating fast. o: { f1, f2, rate, dur } */
export function ringBurst(sr, rng, o = {}) {
  const f1 = o.f1 ?? 1100
  const f2 = o.f2 ?? 1300
  const rate = o.rate ?? 16
  const dur = o.dur ?? 1.2
  const out = buf(sr, dur)
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / sr
    const f = Math.floor(t * rate * 2) % 2 ? f2 : f1
    ph += (TAU * f) / sr
    const v = Math.sin(ph) + 0.3 * Math.sin(3 * ph) + 0.12 * Math.sin(5 * ph)
    const e = Math.min(1, t / 0.01) * Math.min(1, (dur - t) / 0.02)
    out[i] = v * e * 0.5
  }
  return out
}

/** A ringing phone: bursts on a 2 s on, 4 s off cadence, n rings. */
export function phoneRings(sc, rng, t, rings, pan, dist, gain = 1, o = {}) {
  const b = ringBurst(sc.sr, rng, { f1: o.f1 ?? rng.pick([950, 1050, 1150]), f2: o.f2 ?? rng.pick([1200, 1300, 1400]), rate: o.rate ?? rng.range(14, 20), dur: o.dur ?? 1.4 })
  filt(b, sc.sr, [['highpass', 400, 0.7], ['peak', 2200, 2, 4]])
  const period = o.period ?? rng.range(3.5, 5)
  for (let k = 0; k < rings; k++) emit(sc, b, (t + k * period) * sc.sr, pan, dist, gain)
  return t + rings * period
}

// ---------------------------------------------------------------- the cafe bed

const SEATS = {
  middle: { near: 1.6, far: 9, machine: 6, pan: 0.55 },
  counter: { near: 2.5, far: 11, machine: 2.4, pan: 0.75 },
  corner: { near: 3.5, far: 14, machine: 10, pan: 0.45 },
}

/** Grinder: a buzzing motor with a crunchy grind that thins as the beans run out. */
function grinder(sr, rng, dur) {
  const out = buf(sr, dur)
  const f = rng.range(150, 200)
  let ph = 0
  let s = seed32(rng)
  for (let i = 0; i < out.length; i++) {
    const t = i / sr
    const spin = Math.min(1, t / 0.25)
    ph += (TAU * f * (0.6 + 0.4 * spin)) / sr
    const motor = Math.sin(ph) + 0.6 * Math.sin(2 * ph + 0.3) + 0.45 * Math.sin(3 * ph) + 0.3 * Math.sin(5 * ph)
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const nz = s / 2147483648
    const load = t < dur * 0.8 ? 1 : 1 - (t - dur * 0.8) / (dur * 0.2)
    const crunch = nz * (0.6 + 0.4 * Math.sin(TAU * 31 * t + Math.sin(TAU * 7 * t))) * load
    const e = Math.min(1, t / 0.05) * Math.min(1, (dur - t) / 0.15)
    out[i] = (motor * 0.25 + crunch * 0.6) * e
  }
  filt(out, sr, [['highpass', 120, 0.7], ['peak', 2500, 0.8, 5], ['lowpass', 7000, 0.7]])
  return out
}

/** Steam wand stretching milk: a hiss that tears and gurgles at first, then smooths and rises. */
function steamWand(sr, rng, dur) {
  const out = buf(sr, dur)
  let s = seed32(rng)
  let lp = 0
  const squealHz = rng.range(1400, 2400)
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / sr
    const u = t / dur
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const nz = s / 2147483648
    lp += (nz - lp) * 0.2
    const tear = u < 0.35 ? (0.5 + 0.5 * Math.sin(TAU * (9 + 6 * Math.sin(TAU * 1.3 * t)) * t)) * (1 - u / 0.35) : 0
    const hiss = nz * (0.55 + 0.25 * u) + lp * tear * 1.6
    ph += (TAU * squealHz * (1 + 0.15 * u)) / sr
    const sq = u > 0.6 ? Math.sin(ph) * 0.05 * (u - 0.6) / 0.4 : 0
    const e = Math.min(1, t / 0.08) * Math.min(1, (dur - t) / 0.12)
    out[i] = (hiss + sq) * e
  }
  filt(out, sr, [['highpass', 900, 0.7], ['peak', 4500, 1, 3]])
  return out
}

/** Espresso pump: a vibratory pump buzz at mains rate, softened by the machine body. */
function pump(sr, rng, dur) {
  const out = buf(sr, dur)
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / sr
    ph += (TAU * 60) / sr
    const v = Math.sin(ph)
    const e = Math.min(1, t / 0.1) * Math.min(1, (dur - t) / 0.2)
    out[i] = Math.tanh(3 * v) * e * 0.4
  }
  filt(out, sr, [['lowpass', 900, 0.7], ['highpass', 50, 0.7]])
  return out
}

/** A chair dragged on a hard floor: stick-slip judder through the chair's wood. */
function chairScrape(sr, rng) {
  const dur = rng.range(0.25, 0.7)
  const out = buf(sr, dur)
  const f0 = rng.range(35, 90)
  let ph = 0
  let s = seed32(rng)
  for (let i = 0; i < out.length; i++) {
    const t = i / sr
    const u = t / dur
    ph += (f0 * (1 + 0.4 * Math.sin(Math.PI * u))) / sr
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const slip = ph % 1 < 0.15 ? 1 : 0.15
    const e = Math.sin(Math.PI * u)
    out[i] = (s / 2147483648) * slip * e
  }
  filt(out, sr, [['bandpass', rng.range(500, 1100), 1.6], ['peak', rng.range(1800, 2600), 3, 6]])
  return out
}

/** Dishes and cups: one random little moment at the tables or the bus tub. */
function dishMoment(sc, rng, t, seat) {
  const sr = sc.sr
  const k = pickW(rng, [3, 2, 1.2, 1, 0.8, 0.5])
  const d = logRange(rng, seat.near, seat.far)
  const pan = rng.range(-0.95, 0.95)
  if (k === 0) {
    // cup set down on a saucer
    const a = strike(sr, rng, 'saucer', { hard: 6000 })
    addAt(a, strike(sr, rng, 'mug', { hard: 5000, tick: 0.5 }), 0.004 * sr, 0.6)
    addAt(a, thump(sr, rng, 180, 0.012, { noise: 0.2 }), 0, 0.5)
    emit(sc, a, t * sr, pan, d, rng.range(0.08, 0.2))
  } else if (k === 1) {
    // spoon stirring: a run of small tinks on the inside of a cup
    const nt = 4 + rng.int(9)
    const rate = rng.range(4.5, 7.5)
    const modes = objectModes('mug', rng)
    for (let i = 0; i < nt; i++) {
      const m = modal(sr, modes.map((v, j) => (j % 3 === 2 ? v * rng.range(0.4, 1) : v)), { hard: 9000, tick: 0.2, tickHz: 3500, seed: seed32(rng) })
      emit(sc, m, (t + i / rate + rng.gauss() * 0.01) * sr, pan, d, rng.range(0.02, 0.05))
    }
  } else if (k === 2) {
    // two glasses touch
    const a = strike(sr, rng, rng.chance(0.4) ? 'wineglass' : 'glass', { hard: 7000, tick: 0.4 })
    addAt(a, strike(sr, rng, 'glass', { hard: 7000, tick: 0.3 }), rng.range(0, 0.003) * sr, 0.7)
    emit(sc, a, t * sr, pan, d, rng.range(0.04, 0.1))
  } else if (k === 3) {
    // fork and knife on a plate
    const n = 1 + rng.int(3)
    for (let i = 0; i < n; i++) {
      const a = strike(sr, rng, 'plate', { hard: 5000, tick: 0.6 })
      addAt(a, strike(sr, rng, 'cutlery', { hard: 7000 }), 0, 0.4)
      emit(sc, a, (t + i * rng.range(0.15, 0.6)) * sr, pan, d, rng.range(0.03, 0.08))
    }
  } else if (k === 4) {
    // dishes stacked into the bus tub at the counter
    const n = 3 + rng.int(6)
    const bp = seat.pan * rng.range(0.7, 1)
    let tt = t
    for (let i = 0; i < n; i++) {
      const kind = rng.pick(['plate', 'mug', 'saucer', 'cutlery', 'glass'])
      emit(sc, strike(sr, rng, kind, { hard: 5000, tick: 0.7 }), tt * sr, bp, seat.machine * rng.range(0.8, 1.3), rng.range(0.08, 0.25))
      tt += rng.range(0.05, 0.35)
    }
  } else {
    emit(sc, chairScrape(sr, rng), t * sr, pan, d, rng.range(0.05, 0.12))
  }
}

/** The espresso machine's day: shots, grinding, knocking, steaming, in a loose cycle. */
function espressoMachine(sc, rng, amount, seat) {
  if (amount <= 0) return
  const sr = sc.sr
  const pan = seat.pan
  const d = seat.machine
  const g = 0.35 * (0.5 + amount)
  let t = rng.range(0.3, 4)
  const gapMean = 40 / (0.3 + amount * 1.4)
  let guard = 0
  while (t < sc.dur && guard++ < 1000) {
    const which = pickW(rng, [1, 1.3, 0.8])
    if (which === 0) {
      const gd = rng.range(2.5, 4.5)
      emit(sc, grinder(sr, rng, gd), t * sr, pan, d, g * 0.5)
      t += gd + rng.range(0.4, 1.2)
      // knock the old puck out, tamp, lock in
      for (let i = 0; i < 2 + rng.int(2); i++) {
        emit(sc, thump(sr, rng, rng.range(110, 160), 0.03, { noise: 0.6, noiseHz: 900 }), t * sr, pan, d, g * 0.7)
        t += rng.range(0.18, 0.3)
      }
      emit(sc, strike(sr, rng, 'metal', { hard: 3000, size: 1.6 }), (t + 0.6) * sr, pan, d, g * 0.15)
      t += 1.2
      const pd = rng.range(5, 9)
      emit(sc, pump(sr, rng, pd), t * sr, pan, d, g * 0.25)
      t += pd
    } else if (which === 1) {
      const sd = rng.range(6, 12)
      emit(sc, steamWand(sr, rng, sd), t * sr, pan, d, g * 0.45)
      t += sd
      // the jug knocked on the counter to settle the foam
      for (let i = 0; i < 2; i++) emit(sc, strike(sr, rng, 'pan', { size: 2.2, hard: 2500 }), (t + 0.4 + i * 0.25) * sr, pan, d, g * 0.12)
      t += 1
    } else {
      // card reader beeps or the register drawer
      if (rng.chance(0.6)) {
        const b = tone(sr, rng.pick([1800, 2400, 2700]), 0.12, { partials: [[1, 1], [3, 0.2]], att: 0.003, rel: 0.02 })
        emit(sc, b, t * sr, pan * 0.9, d * 1.1, g * 0.25)
      } else {
        emit(sc, thump(sr, rng, 140, 0.05, { noise: 0.5 }), t * sr, pan, d, g * 0.3)
        emit(sc, strike(sr, rng, 'bell', { size: 0.8 }), (t + 0.05) * sr, pan, d, g * 0.05)
      }
      t += 1
    }
    t += rexp(rng, gapMean)
  }
}

const bed = {
  id: 'cafe',
  name: 'Coffee shop',
  group: 'places',
  about: 'A busy coffee shop: chatter at the tables, cups and spoons clinking, the espresso machine hissing.',
  params: [
    { id: 'intensity', name: 'How busy', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [25, 90] },
    { id: 'dishes', name: 'Cups and dishes', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 85] },
    { id: 'espresso', name: 'Espresso machine', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    {
      id: 'seat',
      name: 'Where you sit',
      type: 'choice',
      def: 'middle',
      options: [
        { v: 'middle', name: 'In the middle of the room' },
        { v: 'counter', name: 'By the counter' },
        { v: 'corner', name: 'In a quiet corner' },
      ],
    },
  ],
  generate(seconds, sr, p, rng) {
    const sc = makeScene(bed, seconds, sr, p, rng, { send: 0.55, airHz: 16000, airM: 10, roomR: 8 })
    if (!sc.n) return emptyBed(sc.sr)
    const q = sc.q
    const seat = SEATS[q.seat] || SEATS.middle
    const busy = q.intensity / 100
    roomTone(sc, sc.rng.fork('tone'), { db: -52, color: [['lowpass', 700, 0.7], ['peak', 180, 1, 4]], hum: [[60, -66], [120, -70]], drift: 0.15 })
    crowd(sc, sc.rng.fork('tables'), {
      groups: 1 + Math.round(busy * 9),
      size: [2, 3],
      dist: [seat.near, seat.far * 0.7],
      effort: 0.3 + busy * 0.3,
      react: 0.4,
      gain: 1,
    })
    if (busy > 0.25) {
      crowd(sc, sc.rng.fork('far'), { groups: Math.round((busy - 0.2) * 10), size: [2, 4], dist: [seat.far * 0.7, seat.far * 1.4], effort: 0.35 + busy * 0.3, gain: 1 })
    }
    const dr = sc.rng.fork('dishes')
    const rate = (q.dishes / 100) * (0.3 + 1.4 * busy)
    for (const t of poisson(dr, rate, -1, sc.dur)) dishMoment(sc, dr.fork('d' + Math.round(t * 1000)), t, seat)
    espressoMachine(sc, sc.rng.fork('machine'), q.espresso / 100, seat)
    const wk = sc.rng.fork('walk')
    for (const t of poisson(wk, 0.04 + busy * 0.1, -3, sc.dur)) {
      walker(sc, wk.fork('w' + Math.round(t * 1000)), { t, surface: 'wood', shoe: wk.chance(0.3) ? 'heel' : 'hard', closest: logRange(wk, seat.near, seat.far * 0.6), gain: 0.25 })
    }
    return finish(sc, { size: 0.8, rt60: 0.85, rt60High: 0.45, predelayMs: 6, wet: 0.9 }, -24 + (q.intensity - 50) * 0.08)
  },
}

export default bed
