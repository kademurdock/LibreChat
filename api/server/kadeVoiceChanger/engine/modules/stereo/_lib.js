// modules/stereo/_lib.js - shared helpers for the stereo family. NOT a module:
// it has no default export, and the registry tool should skip files whose
// name starts with an underscore.
//
// What lives here:
// - Small math helpers (clamping, mono mix-down, cubic array reads).
// - Smooth random wander (cosine-interpolated random knots, the "smooth
//   random" of analogue modular systems) used for human timing and tuning.
// - Phrase-aware timing tracks for copies of a voice (stereo.double,
//   stereo.crowd): each copy may change its timing offset only in the pauses
//   between phrases (core/segment.js findPhrases), and only slowly inside a
//   phrase, so the read speed never moves by more than a few cents while
//   anybody is talking. That is how real double tracks and crowds differ:
//   people start each line at a slightly different moment.
// - A static binaural pan (interaural time difference by Woodworth's sphere
//   formula and the head-shadow filter of Brown and Duda 1998, "A structural
//   model for binaural sound synthesis") cheap enough for forty people.
// - Binaural: a streaming, sample-by-sample port of core/space3d.js place()
//   for live mode (the same Brown and Duda model, the same formulas: ITD,
//   head shadow, two pinna notches, the behind cue, distance and air), so the
//   live versions of stereo.place and stereo.orbit sound like the offline ones.
// - Room sends for "how far away" cues: a named space from core/ir.js with
//   its direct sound removed and its energy set to one, played at 1/dc of
//   the voice, where dc is the space's critical distance (the distance at
//   which direct and reverberant sound are equally loud; Kuttruff, "Room
//   Acoustics"). Walking away therefore gets wetter exactly as it does in a
//   real hallway.
// - LiveRoom: a small 8-line feedback delay network (Jot and Chaigne 1991,
//   "Digital delay networks for designing artificial reverberators"; Hadamard
//   feedback matrix, one-pole damping in each loop) standing in for the
//   convolution rooms in live mode.

import { DelayLine } from '../../core/delay.js'
import { namedIR } from '../../core/ir.js'
import { convolveBuf } from '../../core/conv.js'
import { place } from '../../core/space3d.js'

export const DEG = Math.PI / 180
export const SPEED_OF_SOUND = 343
const TINY = 1e-25

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

export function finite(v, d) {
  const x = Number(v)
  return x === x && x !== Infinity && x !== -Infinity ? x : d
}

/** The input's channels averaged into one new Float32Array, non-finite samples zeroed. */
export function monoOf(input) {
  const ch = input && input.ch ? input.ch : []
  const n = ch.length ? ch[0].length : 0
  const out = new Float32Array(n)
  if (!ch.length) return out
  const g = 1 / ch.length
  for (let c = 0; c < ch.length; c++) {
    const s = ch[c]
    for (let i = 0; i < n; i++) {
      const v = s[i]
      if (v > -1e30 && v < 1e30) out[i] += v * g
    }
  }
  return out
}

/** Cubic Hermite read of sig at fractional position pos (zero outside). */
export function readCubic(sig, pos) {
  const n = sig.length
  if (!(pos > -2 && pos < n + 1)) return 0
  const i = Math.floor(pos)
  const f = pos - i
  const ym1 = i - 1 >= 0 && i - 1 < n ? sig[i - 1] : 0
  const y0 = i >= 0 && i < n ? sig[i] : 0
  const y1 = i + 1 >= 0 && i + 1 < n ? sig[i + 1] : 0
  const y2 = i + 2 >= 0 && i + 2 < n ? sig[i + 2] : 0
  const c1 = 0.5 * (y1 - ym1)
  const c2 = ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2
  const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1)
  return ((c3 * f + c2) * f + c1) * f + y0
}

/** Equal-power pan gains for pan -1 (left) .. +1 (right), written into out[0], out[1]. */
export function panGains(pan, out) {
  const p = clamp(finite(pan, 0), -1, 1)
  const a = (p + 1) * 0.25 * Math.PI
  out[0] = Math.cos(a)
  out[1] = Math.sin(a)
  return out
}

/** Make a buffer that is safe to return: every sample finite. */
export function cleanSig(s) {
  for (let i = 0; i < s.length; i++) {
    const v = s[i]
    if (!(v > -1e30 && v < 1e30)) s[i] = 0
    else if (v < 1e-30 && v > -1e-30) s[i] = 0
  }
  return s
}

// ---------------------------------------------------------------- smooth wander

/**
 * Smooth random wander: knots of uniform -1..1 every `spacing` seconds,
 * cosine-interpolated. at(t) costs one lookup. Allocation happens here only.
 */
export function makeWander(rng, seconds, spacing) {
  const sp = Math.max(0.01, finite(spacing, 0.5))
  const nk = Math.max(2, Math.ceil(Math.max(0, finite(seconds, 0)) / sp) + 3)
  const k = new Float32Array(nk)
  for (let i = 0; i < nk; i++) k[i] = rng.next() * 2 - 1
  const inv = 1 / sp
  return {
    knots: k,
    spacing: sp,
    at(t) {
      let x = t * inv
      if (!(x > 0)) x = 0
      let i = x | 0
      if (i >= nk - 1) return k[nk - 1]
      const f = x - i
      const w = 0.5 - 0.5 * Math.cos(Math.PI * f)
      return k[i] + (k[i + 1] - k[i]) * w
    },
  }
}

// ---------------------------------------------------------------- phrase timing

export const CTL = 32

/**
 * A delay track (samples, one value every CTL output samples) for one copy of
 * a voice. Each phrase gets its own offset: base + perPhrase * u (u in -1..1),
 * at least `minDelay`. The offset only moves in the pauses (a raised-cosine
 * glide across the pause, the step held within 20 percent of the pause so the
 * read head never runs backwards or races), plus a slow wander inside phrases
 * whose slope stays under maxSlope (0.004 is about 7 cents).
 * @param {number} nOut output length in samples
 * @param {Array<{start:number,end:number}>} phrases from findPhrases, input samples
 * @returns {{ track: Float32Array, max: number }}
 */
export function phraseDelayTrack(nOut, sr, phrases, rng, opts) {
  const base = Math.max(0, finite(opts.base, 0))
  const per = Math.max(0, finite(opts.perPhrase, 0))
  const wanderAmp = Math.max(0, finite(opts.wander, 0))
  const minDelay = Math.max(0, finite(opts.minDelay, 0))
  const maxSlope = Math.max(1e-4, finite(opts.maxSlope, 0.004))
  const nCtl = Math.ceil(nOut / CTL) + 2
  const track = new Float32Array(nCtl)
  const P = Array.isArray(phrases) && phrases.length ? phrases : [{ start: 0, end: nOut }]
  const np = P.length
  const d = new Float64Array(np)
  for (let k = 0; k < np; k++) {
    let v = base + per * (rng.next() * 2 - 1)
    if (k > 0) {
      const gap = Math.max(0, P[k].start - P[k - 1].end)
      const lim = 0.2 * gap
      if (v > d[k - 1] + lim) v = d[k - 1] + lim
      if (v < d[k - 1] - lim) v = d[k - 1] - lim
    }
    d[k] = Math.max(minDelay, v)
  }
  // Slow wander: knot spacing so that pi * amp / spacing <= maxSlope.
  const ampS = wanderAmp
  const spacing = ampS > 0 ? Math.max(1.5, (Math.PI * ampS) / (maxSlope * sr)) : 10
  const wander = makeWander(rng, nOut / sr + 1, spacing)
  let k = 0
  for (let c = 0; c < nCtl; c++) {
    const t = c * CTL
    // the last phrase whose output start is at or before t
    while (k < np - 1 && t >= P[k + 1].start + d[k + 1]) k++
    let v
    if (k < np - 1 && t > P[k].end + d[k]) {
      // in the pause between phrase k and k + 1
      const a = P[k].end + d[k]
      const b = P[k + 1].start + d[k + 1]
      const f = b > a ? clamp((t - a) / (b - a), 0, 1) : 1
      v = d[k] + (d[k + 1] - d[k]) * (0.5 - 0.5 * Math.cos(Math.PI * f))
    } else {
      v = d[k]
    }
    const w = ampS > 0 ? ampS * wander.at(t / sr) : 0
    let out = v + w
    if (out < minDelay) out = minDelay
    track[c] = out
  }
  let mx = 0
  for (let c = 0; c < nCtl; c++) if (track[c] > mx) mx = track[c]
  return { track, max: mx }
}

/** Linear read of a CTL-step control track at output sample i. */
export function trackAt(track, i) {
  const x = i / CTL
  const c = x | 0
  if (c >= track.length - 1) return track[track.length - 1]
  const f = x - c
  return track[c] + (track[c + 1] - track[c]) * f
}

// ---------------------------------------------------------------- static binaural pan

const HEAD = 0.0875

function shadowAlpha(theta) {
  const amin = 0.1
  const thMin = 150 * DEG
  return 1 + amin / 2 + (1 - amin / 2) * Math.cos((theta / thMin) * Math.PI)
}

function wrapDelay(theta) {
  if (theta < Math.PI / 2) return (HEAD / SPEED_OF_SOUND) * (1 - Math.cos(theta))
  return (HEAD / SPEED_OF_SOUND) * (1 + theta - Math.PI / 2)
}

/**
 * Cues for a fixed direction: { itdL, itdR (seconds), aL, aR (head shadow
 * alpha, frontal-equalised), back (0..1) } written into `out`.
 */
export function directionCues(azDeg, elDeg, out) {
  const az = finite(azDeg, 0) * DEG
  const el = clamp(finite(elDeg, 0), -90, 90) * DEG
  const ce = Math.cos(el)
  const x = ce * Math.sin(az)
  const y = ce * Math.cos(az)
  const thR = Math.acos(clamp(x, -1, 1))
  const thL = Math.acos(clamp(-x, -1, 1))
  out.itdR = wrapDelay(thR)
  out.itdL = wrapDelay(thL)
  const sinS = Math.sin(100 * DEG)
  const cosS = Math.cos(100 * DEG)
  const aF = shadowAlpha(100 * DEG)
  out.aR = shadowAlpha(Math.acos(clamp(x * sinS + y * cosS, -1, 1))) / aF
  out.aL = shadowAlpha(Math.acos(clamp(-x * sinS + y * cosS, -1, 1))) / aF
  out.back = y < 0 ? -y : 0
  return out
}

/** Head-shadow biquad-free coefficients for the bilinear one-pole one-zero at rate sr. */
export function shadowCoefs(sr) {
  const tau = HEAD / (2 * SPEED_OF_SOUND)
  const K2 = 2 * sr
  const den = 1 + tau * K2
  return { p0: 1 / den, q0: (tau * K2) / den, p1: 1 / den, q1: -(tau * K2) / den, a1: (1 - tau * K2) / den }
}

/** Distance gain law of core/space3d.js (1 m = unity, softened near the head). */
export function distGain(d) {
  const r0sq = 0.0625
  const dd = Math.max(0, finite(d, 1))
  return Math.sqrt((1 + r0sq) / (dd * dd + r0sq))
}

/**
 * The behind cue of core/space3d.js applied in place: a first-order high
 * shelf at 2.5 kHz down to -9 dB times `back` (0..1).
 */
export function applyBackShelf(sig, sr, back) {
  if (!(back > 0.001)) return sig
  const G = Math.pow(10, (-9 * clamp(back, 0, 1)) / 20)
  const g = Math.tan((Math.PI * Math.min(2500, 0.45 * sr)) / sr)
  const Gs = g / (1 + g)
  let s = 0
  for (let i = 0; i < sig.length; i++) {
    const x = sig[i]
    const v = (x - s) * Gs
    const lp = v + s
    s = lp + v
    if (s < TINY && s > -TINY) s = 0
    sig[i] = x + (G - 1) * (x - lp)
  }
  return sig
}

// ---------------------------------------------------------------- rear correction

// The head-shadow filter of the spherical model is symmetric about ear axes
// set 100 degrees round from the nose, and core/space3d.js equalises it to the
// front. A source straight behind is 80 degrees from both axes, a source
// ahead 100 degrees, so the shadow alone makes a rear source about 4.4 dB
// BRIGHTER than a frontal one above 1.2 kHz, undoing half of the -9 dB
// "behind" shelf. Real heads do the opposite (the pinna shadows the rear;
// Blauert's directional bands). rearCompDb gives the correction for a
// direction: the shadow a source would have at its mirror image in front
// (same side, same height) divided by the one it has behind, plus 3 dB more
// of rear dulling, as a high shelf at the shadow filter's own corner
// (2 c / a, about 1.25 kHz). Front sources are untouched.
export const REAR_HZ = 1250

export function rearCompDb(azDeg, elDeg) {
  const az = finite(azDeg, 0) * DEG
  const el = clamp(finite(elDeg, 0), -90, 90) * DEG
  const ce = Math.cos(el)
  const x = ce * Math.sin(az)
  const y = ce * Math.cos(az)
  if (!(y < 0)) return 0
  const sinS = Math.sin(100 * DEG)
  const cosS = Math.cos(100 * DEG)
  // shadow alphas at the real (behind) and mirrored (in front) positions, both ears
  const bR = shadowAlpha(Math.acos(clamp(x * sinS + y * cosS, -1, 1)))
  const bL = shadowAlpha(Math.acos(clamp(-x * sinS + y * cosS, -1, 1)))
  const fR = shadowAlpha(Math.acos(clamp(x * sinS - y * cosS, -1, 1)))
  const fL = shadowAlpha(Math.acos(clamp(-x * sinS - y * cosS, -1, 1)))
  const ratio = Math.sqrt((fR * fL) / (bR * bL))
  return 20 * Math.log10(ratio) - 3 * -y
}

/**
 * Apply the rear correction in place along a path ((t) => {az, el} or a
 * fixed {az, el}): a first-order high shelf at REAR_HZ whose gain follows
 * rearCompDb, updated every 64 samples and interpolated in between.
 */
export function applyRearFix(sig, sr, path) {
  const n = sig.length
  if (!n) return sig
  const fn = typeof path === 'function' ? path : null
  const fixed = fn ? null : path || {}
  const g = Math.tan((Math.PI * Math.min(REAR_HZ, 0.45 * sr)) / sr)
  const G = g / (1 + g)
  const STEP = 64
  const gainAt = (i) => {
    const p = fn ? fn(i / sr) || {} : fixed
    return Math.pow(10, rearCompDb(p.az, p.el) / 20)
  }
  let g0 = gainAt(0)
  if (!fn && Math.abs(g0 - 1) < 1e-6) return sig
  let s = 0
  for (let i0 = 0; i0 < n; i0 += STEP) {
    const g1 = fn ? gainAt(Math.min(n, i0 + STEP)) : g0
    const e = Math.min(n, i0 + STEP)
    for (let i = i0; i < e; i++) {
      const x = sig[i]
      const v = (x - s) * G
      const lp = v + s
      s = lp + v
      if (s < TINY && s > -TINY) s = 0
      const gg = g0 + ((g1 - g0) * (i - i0)) / STEP
      sig[i] = x + (gg - 1) * (x - lp)
    }
    g0 = g1
  }
  return sig
}

// ---------------------------------------------------------------- rooms

/**
 * Rooms a stereo module may offer. space: the core/ir.js named space;
 * dc: critical distance in metres; rt, damp: decay and damping for the live
 * network; spread: how wide its live output is.
 */
// Rooms are played a little under the critical-distance level (0.6 / dc):
// a voice effect should read as clear at a metre or two, roomy only far away.
export const ROOM_LEVEL = 0.6

export const ROOMS = {
  none: { name: 'No room' },
  'small-room': { name: 'Small room', space: 'living-room', dc: 1.4, rt: 0.45, damp: 0.6, tail: 0.8 },
  hallway: { name: 'Hallway', space: 'hallway', dc: 2.0, rt: 1.0, damp: 0.35, tail: 1.4 },
  'big-hall': { name: 'Big hall', space: 'concert-hall', dc: 3.5, rt: 2.0, damp: 0.42, tail: 2.8 },
  church: { name: 'Church', space: 'church', dc: 4.5, rt: 2.6, damp: 0.45, tail: 3.6 },
  outdoors: { name: 'Outdoors', space: 'field', dc: 12, rt: 0.5, damp: 0.8, tail: 1.2 },
  alley: { name: 'City alley', space: 'alley', dc: 4, rt: 0.9, damp: 0.3, tail: 1.4 },
  tunnel: { name: 'Tunnel', space: 'tunnel', dc: 2.5, rt: 3.2, damp: 0.4, tail: 4.5 },
  stadium: { name: 'Stadium', space: 'stadium', dc: 7, rt: 2.4, damp: 0.5, tail: 4.7 },
  cave: { name: 'Cave', space: 'cave', dc: 2.5, rt: 3.4, damp: 0.5, tail: 5.0 },
}

/** Choice options for a list of room ids. */
export function roomOptions(ids) {
  return ids.map((id) => ({ v: id, name: ROOMS[id].name }))
}

/** Seconds of tail a room adds: its response is never longer than this. */
export function roomTail(id) {
  const r = ROOMS[id]
  if (!r || !r.space) return 0
  return r.tail
}

const ROOM_CACHE = new Map()

/**
 * The room's response without its direct sound, scaled to unit energy per
 * channel. Returns null for 'none' or a space the core does not know.
 */
export function roomResponse(id, sr, rng) {
  const r = ROOMS[id]
  if (!r || !r.space) return null
  const key = id + '|' + sr + '|' + (rng && rng.key !== undefined ? rng.key : 'x')
  if (ROOM_CACHE.has(key)) return ROOM_CACHE.get(key)
  let ir
  try {
    ir = namedIR(r.space, sr, rng)
  } catch {
    return null
  }
  const z0 = Math.max(1, Math.round(0.0015 * sr))
  const zf = Math.max(1, Math.round(0.0015 * sr))
  let e = 0
  for (let c = 0; c < ir.ch.length; c++) {
    const s = ir.ch[c]
    for (let i = 0; i < s.length; i++) {
      if (i < z0) s[i] = 0
      else if (i < z0 + zf) s[i] *= 0.5 - 0.5 * Math.cos((Math.PI * (i - z0)) / zf)
      e += s[i] * s[i]
    }
  }
  e /= Math.max(1, ir.ch.length)
  if (!(e > 1e-12)) return null
  const g = 1 / Math.sqrt(e)
  for (let c = 0; c < ir.ch.length; c++) {
    const s = ir.ch[c]
    for (let i = 0; i < s.length; i++) s[i] *= g
  }
  if (ROOM_CACHE.size > 8) ROOM_CACHE.delete(ROOM_CACHE.keys().next().value)
  ROOM_CACHE.set(key, ir)
  return ir
}

/**
 * Convolve a mono send with the room and add it into L and R (in place),
 * scaled by gain. The wet sound is cut at the room's declared tail (with a
 * short fade) and at the end of L and R.
 */
export function addRoom(L, R, send, id, sr, rng, gain) {
  const ir = roomResponse(id, sr, rng)
  if (!ir || !(gain > 0) || !send.length) return
  const wet = convolveBuf({ sr, ch: [send] }, ir, 100, { tail: true })
  const wl = wet.ch[0]
  const wr = wet.ch[1] || wet.ch[0]
  const lim = send.length + Math.round(roomTail(id) * sr)
  const n = Math.min(L.length, R.length, wl.length, lim)
  const nf = Math.min(n, Math.round(0.05 * sr))
  for (let i = 0; i < n; i++) {
    let g = gain
    if (i >= n - nf && wl.length > lim) g *= (n - i) / nf
    L[i] += wl[i] * g
    R[i] += wr[i] * g
  }
}

/**
 * Put a mono voice on a path (core/space3d.js place) and, when a room is
 * chosen, add that room heard from the moving source. The reverb send is the
 * placed voice with its distance loss partly undone (comp 1 = fully, so the
 * room stays equally loud however far the voice goes; 0.5 = half), and it is
 * played at 1/dc of the voice: past the critical distance a voice is more
 * room than voice, as in a real space.
 * Returns a stereo buffer: input length + longest path delay + room tail.
 */
export function spatialize(mono, sr, path, o) {
  const opts = o || {}
  if (opts.rearFix !== false) applyRearFix(mono, sr, path)
  const { L, R } = place(mono, sr, path, { tail: true, doppler: opts.doppler !== false })
  const room = ROOMS[opts.room]
  if (!room || !room.space || !mono.length) return { sr, ch: [cleanSig(L), cleanSig(R)] }
  const extra = Math.round(roomTail(opts.room) * sr)
  const n = L.length
  const oL = new Float32Array(n + extra)
  const oR = new Float32Array(n + extra)
  oL.set(L)
  oR.set(R)
  const comp = clamp(finite(opts.comp, 1), 0, 1)
  const send = new Float32Array(n)
  const step = 64
  const fn = typeof path === 'function' ? path : () => path
  let gPrev = 1
  let gNext = 1
  for (let i = 0; i < n; i++) {
    if (i % step === 0) {
      const t0 = i / sr
      const t1 = Math.min(n, i + step) / sr
      const p0 = fn(t0) || {}
      const p1 = fn(t1) || {}
      gPrev = Math.pow(distGain(clamp(finite(p0.dist, 1), 0, 1000)), -comp)
      gNext = Math.pow(distGain(clamp(finite(p1.dist, 1), 0, 1000)), -comp)
    }
    const f = (i % step) / step
    send[i] = 0.5 * (L[i] + R[i]) * (gPrev + (gNext - gPrev) * f)
  }
  const wet = clamp(finite(opts.wet, ROOM_LEVEL / room.dc), 0, 4)
  addRoom(oL, oR, send, opts.room, sr, opts.rng, wet)
  return { sr, ch: [cleanSig(oL), cleanSig(oR)] }
}

// ---------------------------------------------------------------- live binaural

const BCTL = 16

/**
 * Streaming port of core/space3d.js place() for live mode. Set az, el, dist
 * (degrees, degrees, metres) at any time; tick(x) filters one sample and
 * leaves the two ears in this.l and this.r. No doppler (live sources keep
 * their distance), no allocation after construction.
 */
export class Binaural {
  constructor(sr) {
    this.sr = sr
    this.az = 0
    this.el = 0
    this.dist = 1
    const maxItd = (HEAD / SPEED_OF_SOUND) * (1 + Math.PI / 2) * sr
    this.line = new DelayLine(Math.ceil(maxItd) + 8)
    this.raw = new Float64Array(15)
    this.sm = new Float64Array(15)
    this.cur = new Float64Array(15)
    this.step = new Float64Array(15)
    this.cS = Math.exp(-1 / (0.004 * (sr / BCTL)))
    const c = shadowCoefs(sr)
    this.hp0 = c.p0; this.hq0 = c.q0; this.hp1 = c.p1; this.hq1 = c.q1; this.ha1 = c.a1
    this.kN = 1 / 4
    const gBell = Math.tan((Math.PI * Math.min(1100, 0.45 * sr)) / sr)
    const kBell = 1 / 1.2
    this.kBell = kBell
    this.bA1 = 1 / (1 + gBell * (gBell + kBell))
    this.bA2 = gBell * this.bA1
    this.bA3 = gBell * this.bA2
    const gSh = Math.tan((Math.PI * Math.min(2500, 0.45 * sr)) / sr)
    this.GSh = gSh / (1 + gSh)
    const gRf = Math.tan((Math.PI * Math.min(REAR_HZ, 0.45 * sr)) / sr)
    this.rfG = gRf / (1 + gRf)
    this.ctr = 0
    this.l = 0
    this.r = 0
    this.reset()
  }

  _targets() {
    const sr = this.sr
    const raw = this.raw
    const az = finite(this.az, 0) * DEG
    const elD = clamp(finite(this.el, 0), -90, 90)
    const el = elD * DEG
    const dist = clamp(finite(this.dist, 1), 0, 1000)
    const ce = Math.cos(el)
    const x = ce * Math.sin(az)
    const y = ce * Math.cos(az)
    const z = Math.sin(el)
    const thR = Math.acos(clamp(x, -1, 1))
    const thL = Math.acos(clamp(-x, -1, 1))
    raw[0] = wrapDelay(thL) * sr
    raw[1] = wrapDelay(thR) * sr
    const sinS = Math.sin(100 * DEG)
    const cosS = Math.cos(100 * DEG)
    const aF = shadowAlpha(100 * DEG)
    raw[4] = shadowAlpha(Math.acos(clamp(-x * sinS + y * cosS, -1, 1))) / aF
    raw[5] = shadowAlpha(Math.acos(clamp(x * sinS + y * cosS, -1, 1))) / aF
    const px = x * dist, py = y * dist, pz = z * dist
    const dr = Math.sqrt((px - HEAD) * (px - HEAD) + py * py + pz * pz)
    const dl = Math.sqrt((px + HEAD) * (px + HEAD) + py * py + pz * pz)
    raw[2] = distGain(dl)
    raw[3] = distGain(dr)
    const nyqLim = 0.42 * sr
    let f1 = 7500 * Math.pow(2, elD / 75)
    f1 = clamp(f1, 4000, 14000)
    const depth = -15 + 12 * Math.max(0, elD / 90)
    const f2 = f1 * 1.55
    raw[6] = Math.tan((Math.PI * Math.min(f1, nyqLim)) / sr)
    raw[7] = Math.pow(10, (depth * (f1 < nyqLim ? 1 : 0)) / 20)
    raw[8] = Math.tan((Math.PI * Math.min(f2, nyqLim)) / sr)
    raw[9] = Math.pow(10, (depth * 0.6 * (f2 < nyqLim ? 1 : 0)) / 20)
    const back = y < 0 ? -y : 0
    raw[10] = Math.pow(10, (-9 * back) / 20)
    raw[11] = Math.pow(10, (2 * back) / 20)
    const fcRaw = 43300 / Math.sqrt(Math.max(dist, 1e-3))
    const fc = Math.min(fcRaw, 0.45 * sr)
    const g = Math.tan((Math.PI * fc) / sr)
    raw[12] = g / (1 + g)
    raw[13] = fcRaw <= 0.45 * sr ? 1 : Math.pow((0.45 * sr) / fcRaw, 2)
    raw[14] = Math.pow(10, rearCompDb(this.az, elD) / 20)
  }

  /** Jump straight to the current position (no glide). */
  snap() {
    this._targets()
    for (let j = 0; j < 15; j++) {
      this.sm[j] = this.raw[j]
      this.cur[j] = this.raw[j]
      this.step[j] = 0
    }
    this.ctr = 0
  }

  reset() {
    this.line.clear()
    this.n1a = this.n1b = this.n2a = this.n2b = this.ba = this.bb = this.shS = this.airS = this.rfS = 0
    this.xL1 = this.yL1 = this.xR1 = this.yR1 = 0
    this.snap()
  }

  /** Smallest ear delay, in samples, at the current position. */
  minDelay() {
    this._targets()
    return Math.min(this.raw[0], this.raw[1])
  }

  tick(xIn) {
    if (this.ctr === 0) {
      this._targets()
      const raw = this.raw, sm = this.sm, cur = this.cur, st = this.step, cS = this.cS
      for (let j = 0; j < 15; j++) {
        sm[j] = raw[j] + (sm[j] - raw[j]) * cS
        st[j] = (sm[j] - cur[j]) / BCTL
      }
    }
    this.ctr = this.ctr + 1 === BCTL ? 0 : this.ctr + 1
    const cur = this.cur, st = this.step
    let x = xIn > -1e30 && xIn < 1e30 ? xIn : 0
    // rear correction (see rearCompDb)
    {
      const v0 = (x - this.rfS) * this.rfG
      const lp0 = v0 + this.rfS
      this.rfS = lp0 + v0
      if (this.rfS < TINY && this.rfS > -TINY) this.rfS = 0
      x += (cur[14] - 1) * (x - lp0)
    }
    const kN = this.kN
    // pinna notch 1
    let g = cur[6]
    let c1 = 1 / (1 + g * (g + kN))
    let c2 = g * c1
    let c3 = g * c2
    let v3 = x - this.n1b
    let v1 = c1 * this.n1a + c2 * v3
    let v2 = this.n1b + c2 * this.n1a + c3 * v3
    this.n1a = 2 * v1 - this.n1a
    this.n1b = 2 * v2 - this.n1b
    if (this.n1a < TINY && this.n1a > -TINY) this.n1a = 0
    if (this.n1b < TINY && this.n1b > -TINY) this.n1b = 0
    x += (cur[7] - 1) * kN * v1
    // pinna notch 2
    g = cur[8]
    c1 = 1 / (1 + g * (g + kN))
    c2 = g * c1
    c3 = g * c2
    v3 = x - this.n2b
    v1 = c1 * this.n2a + c2 * v3
    v2 = this.n2b + c2 * this.n2a + c3 * v3
    this.n2a = 2 * v1 - this.n2a
    this.n2b = 2 * v2 - this.n2b
    if (this.n2a < TINY && this.n2a > -TINY) this.n2a = 0
    if (this.n2b < TINY && this.n2b > -TINY) this.n2b = 0
    x += (cur[9] - 1) * kN * v1
    // back bell
    v3 = x - this.bb
    v1 = this.bA1 * this.ba + this.bA2 * v3
    v2 = this.bb + this.bA2 * this.ba + this.bA3 * v3
    this.ba = 2 * v1 - this.ba
    this.bb = 2 * v2 - this.bb
    if (this.ba < TINY && this.ba > -TINY) this.ba = 0
    if (this.bb < TINY && this.bb > -TINY) this.bb = 0
    x += (cur[11] - 1) * this.kBell * v1
    // back shelf
    let v = (x - this.shS) * this.GSh
    let lp = v + this.shS
    this.shS = lp + v
    if (this.shS < TINY && this.shS > -TINY) this.shS = 0
    x += (cur[10] - 1) * (x - lp)
    // air
    v = (x - this.airS) * cur[12]
    lp = v + this.airS
    this.airS = lp + v
    if (this.airS < TINY && this.airS > -TINY) this.airS = 0
    x += cur[13] * (lp - x)

    this.line.write(x)
    const sl = this.line.read(cur[0])
    const sr2 = this.line.read(cur[1])
    let yl = (this.hp0 + cur[4] * this.hq0) * sl + (this.hp1 + cur[4] * this.hq1) * this.xL1 - this.ha1 * this.yL1
    this.xL1 = sl
    if (yl < TINY && yl > -TINY) yl = 0
    this.yL1 = yl
    let yr = (this.hp0 + cur[5] * this.hq0) * sr2 + (this.hp1 + cur[5] * this.hq1) * this.xR1 - this.ha1 * this.yR1
    this.xR1 = sr2
    if (yr < TINY && yr > -TINY) yr = 0
    this.yR1 = yr
    this.l = yl * cur[2]
    this.r = yr * cur[3]
    for (let j = 0; j < 15; j++) cur[j] += st[j]
  }
}

// ---------------------------------------------------------------- live room

const FDN_MS = [29.7, 37.1, 41.1, 43.7, 53.3, 59.9, 67.3, 73.1]

/**
 * An 8-line feedback delay network room for live mode. setRoom(id) picks the
 * decay and damping of one of ROOMS (no allocation; the output level is
 * pre-measured per room so its energy matches the convolution rooms).
 * tick(x) leaves the two sides in this.l and this.r.
 */
export class LiveRoom {
  constructor(sr, roomIds) {
    this.sr = sr
    this.N = 8
    this.len = new Int32Array(8)
    this.bufs = []
    this.pos = new Int32Array(8)
    for (let k = 0; k < 8; k++) {
      const L = Math.max(8, Math.round((FDN_MS[k] / 1000) * sr))
      this.len[k] = L
      this.bufs.push(new Float32Array(L))
    }
    this.lpS = new Float64Array(8)
    this.fb = new Float64Array(8)
    this.gain = new Float64Array(8)
    this.tmp = new Float64Array(8)
    this.pre = new DelayLine(Math.round(0.03 * sr) + 8)
    this.preD = Math.round(0.008 * sr)
    this.damp = 0.3
    this.norm = 1
    this.l = 0
    this.r = 0
    this.calib = Object.create(null)
    const ids = Array.isArray(roomIds) ? roomIds : Object.keys(ROOMS)
    for (const id of ids) {
      if (!ROOMS[id] || !ROOMS[id].space) continue
      this._apply(id)
      this.norm = 1
      this.clear()
      const n = Math.min(Math.round(Math.min(4, ROOMS[id].rt * 1.3 + 0.1) * sr), 4 * sr)
      let e = 0
      for (let i = 0; i < n; i++) {
        this._tick(i === 0 ? 1 : 0)
        e += 0.5 * (this.l * this.l + this.r * this.r)
      }
      this.calib[id] = e > 1e-12 ? 1 / Math.sqrt(e) : 1
    }
    this.room = 'none'
    this.clear()
  }

  _apply(id) {
    const r = ROOMS[id]
    const rt = r && r.rt ? r.rt : 1
    const damp = r && r.damp !== undefined ? r.damp : 0.4
    for (let k = 0; k < 8; k++) {
      this.gain[k] = Math.pow(10, (-3 * this.len[k]) / (rt * this.sr))
    }
    // loop lowpass: brighter rooms barely filter
    const fc = 12000 - 9000 * damp
    const g = Math.tan((Math.PI * Math.min(fc, 0.45 * this.sr)) / this.sr)
    this.damp = g / (1 + g)
  }

  setRoom(id) {
    if (id === this.room) return
    this.room = id
    if (!ROOMS[id] || !ROOMS[id].space) return
    this._apply(id)
    this.norm = this.calib[id] !== undefined ? this.calib[id] : 1
  }

  clear() {
    for (let k = 0; k < 8; k++) {
      this.bufs[k].fill(0)
      this.pos[k] = 0
      this.lpS[k] = 0
      this.fb[k] = 0
    }
    this.pre.clear()
    this.l = 0
    this.r = 0
  }

  _tick(x) {
    const t = this.tmp
    this.pre.write(x > -1e30 && x < 1e30 ? x : 0)
    const xin = this.pre.read(this.preD) * 0.35355339
    for (let k = 0; k < 8; k++) {
      const b = this.bufs[k]
      let v = b[this.pos[k]]
      // one-pole lowpass inside the loop
      const s = this.lpS[k]
      const vv = (v - s) * this.damp
      const lp = vv + s
      let ns = lp + vv
      if (ns < TINY && ns > -TINY) ns = 0
      this.lpS[k] = ns
      t[k] = lp * this.gain[k]
    }
    this.l = (t[0] - t[2] + t[4] - t[6]) * this.norm
    this.r = (t[1] - t[3] + t[5] - t[7]) * this.norm
    // fast Walsh-Hadamard, scaled to stay lossless
    for (let h = 1; h < 8; h <<= 1) {
      for (let i = 0; i < 8; i += h << 1) {
        for (let j = i; j < i + h; j++) {
          const a = t[j], b = t[j + h]
          t[j] = a + b
          t[j + h] = a - b
        }
      }
    }
    for (let k = 0; k < 8; k++) {
      let w = t[k] * 0.35355339 + xin
      if (w < TINY && w > -TINY) w = 0
      const b = this.bufs[k]
      b[this.pos[k]] = w
      this.pos[k] = this.pos[k] + 1 === this.len[k] ? 0 : this.pos[k] + 1
    }
  }

  tick(x) {
    if (!ROOMS[this.room] || !ROOMS[this.room].space) {
      this.l = 0
      this.r = 0
      return
    }
    this._tick(x)
  }
}

// ---------------------------------------------------------------- live io helpers

/** Read the mono input sample i from 1 or 2 input views. */
export function inMono(ins, i) {
  if (ins.length > 1) {
    const a = ins[0][i], b = ins[1][i]
    return 0.5 * ((a > -1e30 && a < 1e30 ? a : 0) + (b > -1e30 && b < 1e30 ? b : 0))
  }
  const a = ins[0][i]
  return a > -1e30 && a < 1e30 ? a : 0
}

/** Write a stereo sample to 2 outputs, or its mono fold to 1. */
export function outStereo(outs, i, l, r) {
  if (outs.length > 1) {
    outs[0][i] = l
    outs[1][i] = r
  } else {
    outs[0][i] = 0.5 * (l + r)
  }
}
