// modules/space/room.js - space.room, the voice heard inside a real place:
// every named space of core/ir.js (CONTRACT section 8), from a closet to a
// cathedral, a tin can to a canyon.
//
// Offline: convolution (core/conv.js) with the space's synthetic impulse
// response (core/ir.js namedIR: image-source early reflections after Allen
// and Berkley 1979, banded exponential tails, springs, echoes and cavity
// resonances). The response is split into three parts so the listener can
// stand nearer or farther away:
// - the direct sound, recovered exactly: the same space is built a second
//   time with its direct path switched off (same seed, so every reflection
//   is identical), the two are matched by least squares over the second
//   half, and the difference is the direct sound with the space's own
//   colouring (a tin can's ring, a helmet's boxiness) still on it;
// - the early reflections (the first tens of milliseconds) and
// - the late tail, split with a 20 ms raised-cosine crossfade.
// Distance then moves the direct-to-reverberant ratio the way walking away
// from a talker does (Kuttruff, "Room Acoustics": the direct level falls
// with distance while the diffuse field stays put), with a touch of air
// absorption on the direct sound when far and of proximity warmth when
// close. The finished response is level matched with the same speech
// weighting core/ir.js uses, so distance changes the sound, not the volume.
// Size rebuilds the space from its description with every length scaled
// (walls, distances, decay, echoes, cavity combs, and resonances inversely),
// which is how a bigger or smaller copy of the same room really behaves.
// Studio spaces with no direct path (plate, spring) get the dry voice as
// their direct sound, about 5 dB above the reverb, as a send would.
//
// Live: a feedback delay network (./reverb.js) tuned to each space from its
// own description: line lengths from the mean free path 4V/S (Kuttruff),
// decay, damping and warmth from the space's numbers, the first image-source
// reflections (orders up to three) as early taps, echoes and scatter for the
// outdoors, the spring engine (./spring.js) for the spring tank, and the
// space's combs, resonances, cuts and EQ on the result. Levels follow the
// statistical early and late energies core/ir.js itself uses (the image
// density argument), so the live room keeps the offline balance. Choosing
// another place live crossfades between two output chains over 40 ms (and
// between the network and the spring tank when needed), so nothing clicks;
// a change that arrives during a crossfade follows it. A few small
// formulas of core/ir.js (room shape defaults, Eyring wall reflectances,
// talker and listener placement, automatic room modes, response length) are
// mirrored here because ir.js keeps them private.

import { namedIR, roomIR, SPACES, SPACE_NAMES, spaceSpec } from '../../core/ir.js'
import { convolveBuf } from '../../core/conv.js'
import { Biquad, OnePole } from '../../core/biquad.js'
import { DelayLine } from '../../core/delay.js'
import { makeRng } from '../../core/rng.js'
import { FdnEngine, fdnConfig, LiveBiquad, MixInstance, renderLive } from './reverb.js'
import { SpringEngine } from './spring.js'

const C = 343
const TINY = 1e-20

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

// ---------------------------------------------------------------- names

const NAMES = {
  closet: 'Closet',
  bathroom: 'Bathroom',
  shower: 'Shower stall',
  kitchen: 'Kitchen',
  'living-room': 'Living room',
  bedroom: 'Bedroom',
  classroom: 'Classroom',
  office: 'Office',
  hallway: 'Hallway',
  stairwell: 'Stairwell',
  elevator: 'Elevator',
  car: 'Car',
  van: 'Cargo van',
  bus: 'City bus',
  'train-car': 'Train carriage',
  'airplane-cabin': 'Airplane cabin',
  'phone-booth': 'Phone booth',
  gym: 'School gym',
  pool: 'Indoor pool',
  church: 'Church',
  cathedral: 'Cathedral',
  'concert-hall': 'Concert hall',
  theater: 'Theater',
  stadium: 'Stadium',
  arena: 'Arena',
  'parking-garage': 'Parking garage',
  tunnel: 'Road tunnel',
  'subway-station': 'Subway station',
  cave: 'Cave',
  canyon: 'Canyon',
  forest: 'Forest',
  field: 'Open field',
  alley: 'Alley',
  warehouse: 'Warehouse',
  factory: 'Factory floor',
  hangar: 'Aircraft hangar',
  'metal-tank': 'Steel tank',
  'sewer-pipe': 'Sewer pipe',
  'oil-drum': 'Oil drum',
  well: 'Stone well',
  'cardboard-box': 'Cardboard box',
  'tin-can': 'Tin can',
  'glass-jar': 'Glass jar',
  bottle: 'Bottle',
  helmet: 'Padded helmet',
  'space-suit': 'Space suit helmet',
  'under-blanket': 'Under a blanket',
  'inside-a-wall': 'Inside a wall',
  plate: 'Studio plate',
  spring: 'Spring tank',
  'small-hall': 'Small hall',
  'large-hall': 'Large hall',
  ambience: 'Just a touch of room',
  infinite: 'Endless wash',
}

function spokenName(id) {
  if (NAMES[id]) return NAMES[id]
  const s = String(id).replace(/-/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const SPACE_OPTIONS = SPACE_NAMES.map((v) => ({ v, name: spokenName(v) }))
const DEFAULT_SPACE = SPACES['living-room'] ? 'living-room' : SPACE_NAMES[0]

// ---------------------------------------------------------------- mirrored ir.js formulas

// Shape defaults (core/ir.js SHAPES), used for the response length and the live tuning.
const SHAPES = {
  room: { decay: 0.6, damping: 0.5, bassRatio: 1, density: 1, early: 'auto' },
  hall: { decay: 1.8, damping: 0.45, bassRatio: 1.15, density: 1, early: 'auto' },
  box: { decay: 0.25, damping: 0.3, bassRatio: 1, density: 1, early: 'auto', modes: 'auto' },
  pipe: { decay: 1.5, damping: 0.4, bassRatio: 1.1, density: 0.8, early: 'auto', modes: 'auto' },
  plate: { decay: 2.2, damping: 0.12, bassRatio: 0.85, density: 1, early: null, direct: 0, dispersionMs: 3.5, lowCut: 120 },
  spring: { decay: 2.5, damping: 0.6, bassRatio: 1, density: 1, early: null, direct: 0, lowCut: 100 },
  outdoor: { decay: 0.6, damping: 0.6, bassRatio: 1, density: 0.7, early: null, tailDb: -24 },
}

function merged(spec) {
  const shape = SHAPES[spec.shape] ? spec.shape : 'room'
  return Object.assign({ shape }, SHAPES[shape], spec, { shape })
}

function roomDims(S) {
  const s = S.size
  if (Array.isArray(s) && s.length >= 3) return [Math.max(0.03, num(s[0], 4)), Math.max(0.03, num(s[1], 5)), Math.max(0.03, num(s[2], 2.5))]
  const v = Math.max(0.03, num(s, 5))
  return [v * 0.8, v, Math.min(v * 0.5, Math.max(2.4, v * 0.3))]
}

const WALLS = ['x0', 'x1', 'y0', 'y1', 'floor', 'ceiling']

function wallBetas(dims, decay, reflect) {
  const [x, y, z] = dims
  const V = x * y * z
  const S = 2 * (x * y + x * z + y * z)
  const a = 1 - Math.exp((-0.161 * V) / (S * Math.max(0.02, decay)))
  const b = Math.sqrt(1 - clamp(a, 0.01, 0.99))
  const out = [b, b, b, b, b, b]
  if (reflect && typeof reflect === 'object') {
    for (let i = 0; i < 6; i++) {
      const v = Array.isArray(reflect) ? reflect[i] : reflect[WALLS[i]]
      if (Number.isFinite(v)) out[i] = clamp(v, 0, 0.999)
    }
  }
  return out
}

function positions(dims, S) {
  const [X, Y, Z] = dims
  const dist = num(S.distance, clamp(0.3 * Math.min(X, Y), 0.3, 6))
  const lisF = Array.isArray(S.lis) ? S.lis : null
  const lis = lisF
    ? [clamp(num(lisF[0], 0.5), 0.02, 0.98) * X, clamp(num(lisF[1], 0.3), 0.02, 0.98) * Y, clamp(num(lisF[2], 0.5), 0.02, 0.98) * Z]
    : [0.57 * X, 0.3 * Y, Math.min(1.5, 0.5 * Z)]
  let src
  if (Array.isArray(S.src)) {
    src = [clamp(num(S.src[0], 0.5), 0.02, 0.98) * X, clamp(num(S.src[1], 0.6), 0.02, 0.98) * Y, clamp(num(S.src[2], 0.5), 0.02, 0.98) * Z]
  } else {
    const dx = -0.12 * X
    const maxY = 0.96 * Y - lis[1]
    let dy = Math.sqrt(Math.max(0, dist * dist - dx * dx))
    if (dy > maxY) dy = Math.max(0.01, maxY)
    src = [lis[0] + dx, lis[1] + dy, lis[2] + Math.min(0.1, 0.05 * Z)]
  }
  return { lis, src }
}

function autoModes(dims, S, sr) {
  const out = []
  const gain = num(S.modeGain, 6)
  const fmax = num(S.modeMax, Math.min(0.4 * sr, Math.max(300, (3 * C) / (2 * Math.min(dims[0], dims[1], dims[2])))))
  const rt = num(S.modeDecay, Math.min(num(S.decay, 0.5) * 1.5, 0.6))
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

/** Length in samples of the response core/ir.js builds for a spec. */
function irSamples(spec, sr) {
  const S = merged(spec)
  const decay = clamp(num(S.decay, 1), 0.02, 120)
  const bassRatio = clamp(num(S.bassRatio, 1), 0.3, 3)
  const pre = Math.max(0, num(S.predelayMs, 0)) / 1000
  let ringExtra = 0
  if (Array.isArray(S.combs)) {
    for (const cb of S.combs) {
      const fb = Math.abs(num(cb && cb[1], 0))
      if (fb > 0.01) ringExtra = Math.max(ringExtra, (6.91 * (num(cb[0], 1) / 1000)) / -Math.log(Math.min(0.97, fb)))
    }
  }
  let lastEcho = 0
  const list = []
  if (Array.isArray(S.early)) for (const e of S.early) list.push(e)
  if (Array.isArray(S.echoes)) for (const e of S.echoes) list.push(e)
  for (const e of list) if (e) lastEcho = Math.max(lastEcho, num(e[0], 0) / 1000 + (num(e[4], 0) * 5) / 1000)
  if (S.scatter) lastEcho = Math.max(lastEcho, num(S.scatter.toMs, 200) / 1000 + 0.08)
  const erGuess = S.early === 'auto' ? Math.max(0.03, num(S.erMs, 120) / 1000) : 0
  const bloom = Math.max(0, num(S.bloomMs, 0)) / 1000
  const longest = decay * Math.max(1, bassRatio) * 1.05
  let seconds = num(S.seconds, pre + Math.max(erGuess, lastEcho) + bloom + longest + ringExtra + 0.05)
  seconds = clamp(seconds, 0.02, 30)
  return Math.max(2, Math.round(seconds * sr))
}

/** A copy of a space's spec with every length scaled by s (and resonances by 1/s). */
function scaledSpec(name, s) {
  const S = spaceSpec(name)
  if (s === 1) return S
  const k = s
  const mulMs = (v) => (Number.isFinite(v) ? v * k : v)
  if (Array.isArray(S.size)) S.size = S.size.map((v) => v * k)
  else if (Number.isFinite(S.size)) S.size *= k
  if (Number.isFinite(S.decay)) S.decay = Math.min(60, S.decay * k)
  S.distance = mulMs(S.distance)
  S.erMs = mulMs(S.erMs)
  S.predelayMs = mulMs(S.predelayMs)
  S.bloomMs = mulMs(S.bloomMs)
  S.tailStartMs = mulMs(S.tailStartMs)
  S.dispersionMs = mulMs(S.dispersionMs)
  S.modeDecay = mulMs(S.modeDecay)
  if (Number.isFinite(S.seconds)) S.seconds = Math.min(30, S.seconds * k)
  if (Array.isArray(S.combs)) S.combs = S.combs.map((c) => [c[0] * k, c[1], c[2]])
  const modes = (list) => list.map((m) => [m[0] / k, m[1], m[2]])
  if (Array.isArray(S.modes)) S.modes = modes(S.modes)
  if (Array.isArray(S.extraModes)) S.extraModes = modes(S.extraModes)
  if (Number.isFinite(S.modeMax)) S.modeMax /= k
  const echoes = (list) => list.map((e) => [e[0] * k, e[1], e[2], e[3], num(e[4], 0) * k])
  if (Array.isArray(S.echoes)) S.echoes = echoes(S.echoes)
  if (Array.isArray(S.early)) S.early = echoes(S.early)
  if (S.scatter) {
    S.scatter = Object.assign({}, S.scatter)
    S.scatter.fromMs = num(S.scatter.fromMs, 5) * k
    S.scatter.toMs = num(S.scatter.toMs, 200) * k
    if (Array.isArray(S.scatter.smearMs)) S.scatter.smearMs = S.scatter.smearMs.map((v) => v * k)
  }
  if (Array.isArray(S.springs)) S.springs = S.springs.map((sp) => Object.assign({}, sp, { ms: num(sp.ms, 36) * k }))
  // Small cavities lose their lows because of their size; a bigger one keeps more.
  if (S.shape === 'box' && S.lowCut) {
    if (Array.isArray(S.lowCut)) S.lowCut = [S.lowCut[0] / k, S.lowCut[1]]
    else S.lowCut = S.lowCut / k
  }
  return S
}

// ---------------------------------------------------------------- offline parts

// Speech weighting for level matching, the same as core/ir.js: a 100 Hz high
// pass and a one-pole low pass at 700 Hz (the long-term speech spectrum).
function weightedEnergy(sig, sr) {
  const w = new Float32Array(sig)
  new Biquad('highpass', sr, 100, 0.707).run(w)
  new OnePole(sr, 700, 'lp').run(w)
  let e = 0
  for (let i = 0; i < w.length; i++) e += w[i] * w[i]
  return e
}

const PARTS = new Map()
const PARTS_LIMIT = 3000000 // samples held at most (about 12 MB), across entries
let partsSamples = 0

function rngFor(rng) {
  return rng && typeof rng.fork === 'function' ? rng : makeRng(1)
}

/**
 * The separated parts of a space at rate sr and size scale s:
 * { D: [L, R] (direct, short), R: [L, R] (all reflections), len, tE, effect }.
 */
function spaceParts(name, sr, rng, s) {
  const r = rngFor(rng)
  const key = name + '|' + sr + '|' + (r.key !== undefined ? r.key : 'x') + '|' + s
  const hit = PARTS.get(key)
  if (hit) {
    PARTS.delete(key)
    PARTS.set(key, hit)
    return hit
  }
  const spec = scaledSpec(name, s)
  const fork = r.fork('space:' + name)
  const full = s === 1 ? namedIR(name, sr, r) : roomIR(sr, spec, fork)
  const nd = roomIR(sr, Object.assign({}, spec, { direct: 0 }), fork)
  const len = full.ch[0].length
  const half = Math.floor(len / 2)
  let sxy = 0, syy = 0, eFull = 0
  for (let c = 0; c < 2; c++) {
    const F = full.ch[c]
    const Nn = nd.ch[c]
    for (let i = half; i < len; i++) {
      sxy += F[i] * Nn[i]
      syy += Nn[i] * Nn[i]
    }
    for (let i = 0; i < len; i++) eFull += F[i] * F[i]
  }
  const k = syy > 0 ? sxy / syy : 0
  const R = [new Float32Array(len), new Float32Array(len)]
  const Dfull = [new Float32Array(len), new Float32Array(len)]
  let eD = 0
  let last = 0
  for (let c = 0; c < 2; c++) {
    const F = full.ch[c]
    const Nn = nd.ch[c]
    const Rc = R[c]
    const Dc = Dfull[c]
    for (let i = 0; i < len; i++) {
      const rv = k * Nn[i]
      Rc[i] = rv
      const d = F[i] - rv
      Dc[i] = d
      eD += d * d
    }
  }
  const effect = !(eD > 1e-4 * eFull)
  let D
  if (effect) {
    D = [new Float32Array(1024), new Float32Array(1024)]
    D[0][0] = 1
    D[1][0] = 1
    // The reverb about 5 dB under the voice, as a send would have it.
    const g = Math.sqrt(0.32)
    for (let c = 0; c < 2; c++) for (let i = 0; i < len; i++) R[c][i] *= g
  } else {
    let pk = 0
    for (let c = 0; c < 2; c++) for (let i = 0; i < len; i++) pk = Math.max(pk, Math.abs(Dfull[c][i]))
    const th = pk * 1e-5
    for (let c = 0; c < 2; c++) for (let i = len - 1; i > last; i--) if (Math.abs(Dfull[c][i]) > th) { last = i; break }
    const dl = Math.min(len, last + 1 + Math.round(0.02 * sr))
    D = [Dfull[0].slice(0, dl), Dfull[1].slice(0, dl)]
  }
  // Early / late boundary: about the image-source window, 15 to 110 ms.
  const S = merged(spec)
  let erMs = Number.isFinite(S.erMs) ? S.erMs * 0.6 : S.shape === 'outdoor' ? 80 : S.shape === 'plate' || S.shape === 'spring' ? 25 : 60
  const tE = Math.round((clamp(erMs, 15, 110) / 1000) * sr)
  const parts = { D, R, len, tE, effect, w0: 0 }
  // Speech-weighted energy of the space as built (the level target).
  {
    const ir = buildResponse(parts, sr, 50, 0, 0)
    parts.w0 = 0.5 * (weightedEnergy(ir[0], sr) + weightedEnergy(ir[1], sr))
  }
  const size = 2 * len + 2 * D[0].length
  if (size <= PARTS_LIMIT) {
    while (partsSamples + size > PARTS_LIMIT && PARTS.size) {
      const oldest = PARTS.keys().next().value
      const ob = PARTS.get(oldest)
      partsSamples -= 2 * ob.len + 2 * ob.D[0].length
      PARTS.delete(oldest)
    }
    PARTS.set(key, parts)
    partsSamples += size
  }
  return parts
}

/**
 * Distance gains into out[0..2]: direct, early, late (linear), from distance
 * 0..100 where 50 is the space as built. Returns out.
 */
export function distanceGainsInto(out, distance) {
  const n = (50 - clamp(num(distance, 50), 0, 100)) / 50 // +1 near, -1 far
  const dDb = n >= 0 ? 6 * n : 14 * n
  const eDb = n >= 0 ? -3 * n : 0
  const lDb = n >= 0 ? -9 * n : -3 * n
  out[0] = Math.pow(10, dDb / 20)
  out[1] = Math.pow(10, eDb / 20)
  out[2] = Math.pow(10, lDb / 20)
  return out
}

/** Distance gains as a new [direct, early, late] array (offline use). */
export function distanceGains(distance) {
  return distanceGainsInto([0, 0, 0], distance)
}

/**
 * Assemble a stereo response from the parts: distance, extra predelay
 * (samples) and brightness (-100..100). Returns [L, R] (not level matched).
 */
function buildResponse(parts, sr, distance, preSamp, tone) {
  const { D, R, len, tE } = parts
  const pre = Math.max(0, Math.round(preSamp))
  const outLen = Math.max(D[0].length, len + pre)
  const out = [new Float32Array(outLen), new Float32Array(outLen)]
  const [gd, ge, gl] = distanceGains(distance)
  const n = (50 - clamp(num(distance, 50), 0, 100)) / 50
  const half = Math.round(0.01 * sr)
  const t = clamp(num(tone, 0), -100, 100) / 100
  for (let c = 0; c < 2; c++) {
    const o = out[c]
    // Reflections with the early/late gain curve, shifted by the predelay.
    const r = new Float32Array(len)
    const src = R[c]
    for (let i = 0; i < len; i++) {
      let w
      if (i <= tE - half) w = 1
      else if (i >= tE + half) w = 0
      else w = 0.5 + 0.5 * Math.cos((Math.PI * (i - (tE - half))) / (2 * half))
      r[i] = src[i] * (ge * w + gl * (1 - w))
    }
    if (t !== 0) {
      new Biquad('highshelf', sr, 3000, 0.707, t > 0 ? 6 * t : 12 * t).run(r)
      new Biquad('lowshelf', sr, 250, 0.707, t > 0 ? -3 * t : -2 * t).run(r)
    }
    for (let i = 0; i < len; i++) o[i + pre] += r[i]
    // Direct sound: air absorption when far, proximity warmth when near.
    const d = new Float32Array(D[c])
    if (n < 0) new Biquad('highshelf', sr, 3500, 0.707, 4.5 * n).run(d)
    else if (n > 0) new Biquad('lowshelf', sr, 200, 0.707, 3 * n).run(d)
    for (let i = 0; i < d.length; i++) o[i] += d[i] * gd
  }
  return out
}

function roomTailSamples(p, sr) {
  const name = SPACES[p.space] ? p.space : DEFAULT_SPACE
  const s = clamp(num(p.size, 1), 0.5, 2)
  const n = irSamples(scaledSpec(name, s), sr)
  return n - 1 + Math.round((clamp(num(p.predelay, 0), 0, 200) / 1000) * sr)
}

// ---------------------------------------------------------------- live plans

const MAX_TAPS = 24
const MAX_SHAPE = 14
const PLANS = new Map()

function speechW(f) {
  const h = (f * f * f * f) / (f * f * f * f + 1e8)
  return h / (1 + (f / 700) * (f / 700))
}

/**
 * Speech-weighted energy of noise low passed at fc (|H|^2 = 1 / (1 + (f/fc)^(2 order)))
 * relative to white noise of the same flat energy. core/ir.js normalises some
 * parts (outdoor tails, plates, springs, rough echoes) by flat energy, and a
 * darker sound of equal flat energy weighs more in the speech band.
 */
function lowpassWeight(fc, order, sr) {
  let a = 0, b = 0, c = 0
  const n = 480
  for (let k = 1; k <= n; k++) {
    const f = (k / n) * 0.5 * sr
    const h = 1 / (1 + Math.pow(f / Math.max(50, fc), 2 * order))
    const w = speechW(f)
    a += w * h
    b += h
    c += w
  }
  return b > 0 && c > 0 ? a / b / (c / n) : 1
}

/** The same for core/ir.js's banded, damped tail (octave bands, per-band decay and weight). */
function tailWeight(S, sr) {
  const decay = clamp(num(S.decay, 1), 0.02, 120)
  const damping = clamp(num(S.damping, 0.5), 0, 1)
  const bassRatio = clamp(num(S.bassRatio, 1), 0.3, 3)
  let eW = 0, eF = 0, wW = 0, wF = 0
  for (let f = 62.5; f <= 16000 && f < 0.42 * sr; f *= 2) {
    let g = 1 / (1 + damping * 1.6 * Math.max(0, Math.log2(f / 1500)))
    if (f < 500) g *= 1 + (bassRatio - 1) * Math.min(1, Math.log2(500 / f) / 2)
    const rt = Math.max(0.02, decay * g)
    const w2 = 1 / (1 + damping * Math.max(0, Math.log2(f / 2000)))
    const e = w2 * f * rt
    const W = speechW(f)
    eW += e * W
    eF += e
    wW += f * W
    wF += f
  }
  return eF > 0 && wF > 0 && wW > 0 ? eW / eF / (wW / wF) : 1
}

/** Speech-weighted energy of the live spring engine's response per unit level squared. */
function springWeight(sr, cfg) {
  const eng = new SpringEngine(sr, { maxSprings: 3 })
  const c = Object.assign({}, cfg, { level: 1 })
  eng.configure(c)
  const n = Math.round(sr * Math.min(8, clamp(num(c.decay, 2.5), 0.3, 10) * 1.3 + 0.2))
  const x = new Float32Array(n)
  x[0] = 1
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  eng.run(x, x, L, R, n, 0, 0)
  return 0.5 * (weightedEnergy(L, sr) + weightedEnergy(R, sr)) / weightedEnergy(x, sr)
}

/** Statistical early and late energies (unit direct) of an image-source space, per core/ir.js. */
function isEnergies(S, dims, betas, d0, erEnd, decay) {
  const [X, Y, Z] = dims
  const V = X * Y * Z
  const Sa = 2 * (X * Y + X * Z + Y * Z)
  const areas = [Y * Z, Y * Z, X * Z, X * Z, X * Y, X * Y]
  let b2 = 0
  for (let i = 0; i < 6; i++) b2 += areas[i] * betas[i] * betas[i]
  b2 /= Sa
  const P = (t) => ((4 * Math.PI * C * d0 * d0) / V) * Math.pow(b2, (C * (t + d0 / C) * Sa) / (4 * V))
  // Early: integrate P with the image fade from 0.6 erEnd.
  let eE = 0
  const steps = 120
  for (let k = 0; k < steps; k++) {
    const t = ((k + 0.5) / steps) * erEnd
    let g = 1
    if (t > 0.6 * erEnd) g = 0.5 + 0.5 * Math.cos((Math.PI * (t - 0.6 * erEnd)) / (0.4 * erEnd))
    eE += P(t) * g * g * (erEnd / steps)
  }
  // Late: amplitude atTm at tm, ramped in (raised cosine squared) from t0, decaying.
  const tm = 0.8 * erEnd
  const t0 = Math.max(0.0005, Math.min(erEnd * 0.15, 0.004))
  const tailGain = Math.max(0, num(S.tailGain, 1))
  const aTm2 = P(tm) * tailGain * tailGain
  let eL = (aTm2 * decay) / 13.82
  const ramp = Math.max(0.002, tm - t0)
  for (let k = 0; k < 60; k++) {
    const t = t0 + ((k + 0.5) / 60) * ramp
    const f = Math.pow(0.5 - 0.5 * Math.cos((Math.PI * (t - t0)) / ramp), 2)
    eL += aTm2 * Math.exp((-13.82 * (t - tm)) / decay) * f * f * (ramp / 60)
  }
  return { eE, eL }
}

/** The live plan for a space at rate sr (size 1). Cached; allocation happens only here. */
function livePlan(name, sr) {
  const key = name + '|' + sr
  const hit = PLANS.get(key)
  if (hit) return hit
  const S = merged(spaceSpec(name))
  const decay = clamp(num(S.decay, 1), 0.03, 60)
  const damping = clamp(num(S.damping, 0.5), 0, 1)
  const plan = {
    kind: S.shape === 'spring' ? 'spring' : 'fdn',
    direct: num(S.direct, 1),
    effect: false,
    decay,
    hiRatio: 1 / (1 + 2.4 * damping),
    hiHz: 3000,
    bassRatio: clamp(num(S.bassRatio, 1), 0.3, 3),
    minDelayMs: 12,
    spread: 3.1,
    diffusion: 1,
    mod: 0.25,
    predelayMs: Math.max(0, num(S.predelayMs, 0)),
    tapN: 0,
    tapMs: new Float64Array(MAX_TAPS),
    tapL: new Float64Array(MAX_TAPS),
    tapR: new Float64Array(MAX_TAPS),
    eEarly: 0,
    eLate: 1,
    tiltDb: 0, // high shelf on the reflections (core/ir.js weakens high tail bands)
    earlyLp: 0,
    springW: 1,
    shape: [], // [type, freq, q, gain]
    combs: [], // [ms, fb, cutoff]
    spring: null,
  }
  const shape = S.shape
  if (shape === 'room' || shape === 'hall' || shape === 'box' || shape === 'pipe') {
    const dims = roomDims(S)
    const [X, Y, Z] = dims
    const V = X * Y * Z
    const Sa = 2 * (X * Y + X * Z + Y * Z)
    const betas = wallBetas(dims, decay, S.reflect)
    const { lis, src } = positions(dims, S)
    const d0 = Math.max(0.02, Math.hypot(src[0] - lis[0], src[1] - lis[1], src[2] - lis[2]))
    let erEnd = num(S.erMs, 0) / 1000
    if (!(erEnd > 0)) erEnd = clamp((6 * 4 * V) / Sa / C, 0.025, 0.12)
    const rCap = Math.cbrt((60000 * V * 3) / (4 * Math.PI))
    if (C * erEnd > rCap) erEnd = rCap / C
    const mfp = (4 * V) / Sa
    // Lines spread around the mean free path's travel time.
    plan.minDelayMs = clamp(((mfp / C) * 1000) / 1.75, 0.08, 140)
    plan.diffusion = clamp(num(S.density, 1), 0.3, 1) * (1 - 0.5 * clamp(num(S.irregular, 0), 0, 1)) + 0.5 * clamp(num(S.irregular, 0), 0, 1)
    const en = isEnergies(S, dims, betas, d0, erEnd, decay)
    // Image sources up to order 3 within the window: the strongest become taps.
    const cand = []
    const [bx0, bx1, by0, by1, bz0, bz1] = betas
    const pw = (b0, b1, q) => (q >= 0 ? Math.pow(b1, Math.ceil(q / 2)) * Math.pow(b0, Math.floor(q / 2)) : Math.pow(b0, Math.ceil(-q / 2)) * Math.pow(b1, Math.floor(-q / 2)))
    for (let qx = -3; qx <= 3; qx++) {
      for (let qy = -3; qy <= 3; qy++) {
        for (let qz = -3; qz <= 3; qz++) {
          const ord = Math.abs(qx) + Math.abs(qy) + Math.abs(qz)
          if (ord === 0 || ord > 3) continue
          const ix = (qx & 1) === 0 ? qx * X + src[0] : (qx + 1) * X - src[0]
          const iy = (qy & 1) === 0 ? qy * Y + src[1] : (qy + 1) * Y - src[1]
          const iz = (qz & 1) === 0 ? qz * Z + src[2] : (qz + 1) * Z - src[2]
          const dx = ix - lis[0]
          const d = Math.hypot(dx, iy - lis[1], iz - lis[2])
          const t = (d - d0) / C
          if (t > erEnd || t < 0) continue
          const g = (pw(bx0, bx1, qx) * pw(by0, by1, qy) * pw(bz0, bz1, qz) * d0) / d
          cand.push([t * 1000, g, (0.85 * dx) / d])
        }
      }
    }
    cand.sort((a, b) => b[1] - a[1])
    const nT = Math.min(MAX_TAPS, cand.length)
    let eT = 0
    for (let k = 0; k < nT; k++) eT += cand[k][1] * cand[k][1]
    const want = 0.6 * en.eE
    const gs = eT > 0 ? Math.sqrt(want / eT) : 0
    for (let k = 0; k < nT; k++) {
      const [ms, g, pan] = cand[k]
      plan.tapMs[k] = ms
      plan.tapL[k] = g * gs * Math.sqrt(1 - clamp(pan, -1, 1))
      plan.tapR[k] = g * gs * Math.sqrt(1 + clamp(pan, -1, 1))
    }
    plan.tapN = nT
    plan.eEarly = eT > 0 ? want : 0
    plan.eLate = en.eL + (eT > 0 ? 0.4 : 1) * en.eE
    plan.tiltDb = -10 * Math.log10(1 + 2 * damping)
  } else if (shape === 'outdoor') {
    // Echoes and scatter: a rough surface returns part of each echo as a
    // short low-passed burst (core/ir.js addEcho), which weighs more in the
    // speech band than a click of the same energy, so live taps carry that.
    const list = []
    let cutSum = 0, cutW = 0
    const smearK = (cut, smear) => (smear > 0 ? Math.sqrt(0.55 + 0.45 * lowpassWeight(cut, 2, sr)) : 1)
    if (Array.isArray(S.echoes)) {
      for (const e of S.echoes) {
        if (!e) continue
        const g = num(e[1], 0.3)
        const cut = num(e[3], 8000)
        list.push([num(e[0], 0), g * smearK(cut, num(e[4], 0)), num(e[2], 0)])
        cutSum += g * g * Math.log(cut)
        cutW += g * g
      }
    }
    let scatE = 0
    if (S.scatter && typeof S.scatter === 'object') {
      const sc = S.scatter
      const r = makeRng('live-scatter:' + name)
      const count = clamp(Math.round(num(sc.count, 30)), 0, 2000)
      const from = num(sc.fromMs, 5)
      const to = Math.max(from, num(sc.toMs, 200))
      const gdb = Array.isArray(sc.gainDb) ? sc.gainDb : [-30, -18]
      const cr = Array.isArray(sc.cutoff) ? sc.cutoff : [2000, 6000]
      const smr = Array.isArray(sc.smearMs) ? sc.smearMs : [0, 0]
      const cutMid = Math.sqrt(cr[0] * cr[1])
      const sk = smearK(cutMid, num(smr[1], 0))
      const room = MAX_TAPS - list.length
      const scat = []
      for (let k = 0; k < count; k++) {
        const u = r.next()
        const t = from + (to - from) * u * u
        const lvl = gdb[0] + (gdb[1] - gdb[0]) * r.next() - 6 * u
        const g = Math.pow(10, lvl / 20) * sk
        scatE += g * g
        scat.push([t, g, r.range(-0.9, 0.9)])
      }
      cutSum += scatE * Math.log(cutMid)
      cutW += scatE
      scat.sort((a, b) => b[1] - a[1])
      let kept = 0
      for (let k = 0; k < Math.min(room, scat.length); k++) kept += scat[k][1] * scat[k][1]
      const up = kept > 0 ? Math.sqrt(scatE / kept) : 0
      for (let k = 0; k < Math.min(room, scat.length); k++) list.push([scat[k][0], scat[k][1] * up, scat[k][2]])
    }
    let e = 0
    for (let k = 0; k < list.length && k < MAX_TAPS; k++) {
      const [ms, g, pan] = list[k]
      plan.tapMs[k] = ms
      plan.tapL[k] = g * Math.sqrt(1 - clamp(pan * 0.9, -1, 1))
      plan.tapR[k] = g * Math.sqrt(1 + clamp(pan * 0.9, -1, 1))
      e += g * g
    }
    plan.tapN = Math.min(MAX_TAPS, list.length)
    plan.eEarly = e
    plan.earlyLp = cutW > 0 ? Math.exp(cutSum / cutW) * 1.3 : 0
    plan.eLate = Math.pow(10, num(S.tailDb, -24) / 10) * Math.pow(Math.max(0, num(S.tailGain, 1)), 2) * tailWeight(S, sr)
    plan.tiltDb = -10 * Math.log10(1 + 2 * damping)
    plan.minDelayMs = 20
    plan.diffusion = clamp(num(S.density, 0.7), 0.2, 1)
    plan.predelayMs += num(S.tailStartMs, 8)
  } else if (shape === 'plate') {
    plan.eLate = Math.pow(10, num(S.tailDb, 0) / 10) * Math.pow(Math.max(0, num(S.tailGain, 1)), 2) * tailWeight(S, sr)
    plan.tiltDb = -10 * Math.log10(1 + 2 * damping)
    plan.minDelayMs = 7
    plan.diffusion = 1
    plan.mod = 0.4
    plan.predelayMs += num(S.bloomMs, 0) * 0.5
  } else {
    // Spring tank.
    const sp = Array.isArray(S.springs) && S.springs.length ? S.springs : [{ ms: 34, a: 0.64 }, { ms: 41.5, a: 0.7 }]
    let a = 0
    for (const s of sp) a += num(s.a, 0.65)
    a /= sp.length
    plan.spring = { springs: Math.min(3, sp.length), drip: clamp((a - 0.3) / 0.5, 0, 1), decay, tone: 0.35, length: 0.5, level: 1 }
    // core/ir.js springs: unit flat energy through two low passes at 1.1 fc,
    // plus a diffuse fill tailDb under them.
    let fc = 0
    for (const s of sp) fc += num(s.fc, 4200)
    fc /= sp.length
    plan.eLate = lowpassWeight(fc * 1.1, 2, sr) + Math.pow(10, num(S.tailDb, -14) / 10) * tailWeight(S, sr)
    plan.springW = springWeight(sr, plan.spring)
  }
  if (!(plan.direct > 0.05)) {
    plan.effect = true
    plan.direct = 1
    // With no direct path, core/ir.js level matches the reflections
    // themselves to unit speech energy; the dry voice then sits about 5 dB
    // above them (the offline send). So the parts share an energy of 0.32.
    const tot = Math.max(1e-9, plan.eLate + plan.eEarly)
    const k = 0.32 / tot
    plan.eLate *= k
    plan.eEarly *= k
    for (let j = 0; j < plan.tapN; j++) {
      plan.tapL[j] *= Math.sqrt(k)
      plan.tapR[j] *= Math.sqrt(k)
    }
  }
  // Whole-response shaping, as in core/ir.js.
  if (Array.isArray(S.combs)) for (const cb of S.combs) if (cb && num(cb[0], 0) > 0) plan.combs.push([num(cb[0], 1), clamp(num(cb[1], 0.5), -0.97, 0.97), num(cb[2], 8000)])
  let modes = []
  if (S.modes === 'auto') modes = autoModes(roomDims(S), S, sr)
  else if (Array.isArray(S.modes)) modes = S.modes.slice()
  if (Array.isArray(S.extraModes)) modes = modes.concat(S.extraModes)
  modes = modes.filter((m) => m && num(m[0], 0) > 20).sort((a, b) => Math.abs(num(b[2], 6)) - Math.abs(num(a[2], 6)))
  const cut = (v) => (Array.isArray(v) ? { hz: num(v[0], 0), order: clamp(Math.round(num(v[1], 12) / 12), 1, 4) } : { hz: num(v, 0), order: 1 })
  const shapeList = []
  if (S.lowCut) {
    const c = cut(S.lowCut)
    if (c.hz > 5) for (let k = 0; k < c.order; k++) shapeList.push(['highpass', c.hz, 0.707, 0])
  }
  if (S.highCut) {
    const c = cut(S.highCut)
    if (c.hz > 20) for (let k = 0; k < c.order; k++) shapeList.push(['lowpass', c.hz, 0.707, 0])
  }
  if (Array.isArray(S.eq)) for (const e of S.eq) if (e && num(e.freq, 0) > 0) shapeList.push([e.type, num(e.freq, 1000), num(e.q, 0.707), num(e.gain, 0)])
  for (let k = 0; k < modes.length && shapeList.length < MAX_SHAPE; k++) {
    const m = modes[k]
    shapeList.push(['peak', num(m[0], 100), clamp(num(m[1], 8), 0.3, 400), clamp(num(m[2], 6), -30, 30), true])
  }
  plan.shape = shapeList
  PLANS.set(key, plan)
  return plan
}

/**
 * Everything after the reflections in the live room: the direct sound and
 * its distance colour, the reflections' brightness and tilt, the space's
 * combs and resonances, and the level match. Two of these exist so a change
 * of place can crossfade from one to the other instead of switching filters
 * under a running signal.
 */
class PostChain {
  constructor(sr) {
    this.sr = sr
    this.shL = []
    this.shR = []
    for (let k = 0; k < MAX_SHAPE; k++) {
      this.shL.push(new LiveBiquad())
      this.shR.push(new LiveBiquad())
    }
    this.nShape = 0
    this.brL = [new LiveBiquad(), new LiveBiquad(), new LiveBiquad()]
    this.brR = [new LiveBiquad(), new LiveBiquad(), new LiveBiquad()]
    this.dsL = new LiveBiquad()
    this.dsR = new LiveBiquad()
    this.combL = []
    this.combR = []
    this.combD = new Float64Array(3)
    this.combDc = new Float64Array(3)
    this.combFb = new Float64Array(3)
    this.combG = new Float64Array(3)
    this.combSL = new Float64Array(3)
    this.combSR = new Float64Array(3)
    for (let k = 0; k < 3; k++) {
      this.combL.push(new DelayLine(Math.ceil(0.06 * sr) + 8))
      this.combR.push(new DelayLine(Math.ceil(0.06 * sr) + 8))
    }
    this.nComb = 0
    this.effect = false
    this.gd = 1
    this.gdT = 1
    this.G = 1
    this.GT = 1
    this.oa = 0
    this.ob = 0
  }

  /**
   * Set the chain for a plan at size s with distance gains gd, ge, gl. The
   * taps (already scaled) are needed for the level match. fresh: values
   * jump instead of gliding (a chain about to fade in).
   */
  configure(plan, s, gd, ge, gl, distance, tone, nT, tMs, tL, tR, preS, fGrid, nGrid, fresh) {
    const sr = this.sr
    this.effect = plan.effect
    const t = clamp(num(tone, 0), -100, 100) / 100
    if (t !== 0) {
      this.brL[0].set('highshelf', sr, 3000, 0.707, t > 0 ? 6 * t : 12 * t)
      this.brR[0].set('highshelf', sr, 3000, 0.707, t > 0 ? 6 * t : 12 * t)
      this.brL[1].set('lowshelf', sr, 250, 0.707, t > 0 ? -3 * t : -2 * t)
      this.brR[1].set('lowshelf', sr, 250, 0.707, t > 0 ? -3 * t : -2 * t)
    } else {
      this.brL[0].off()
      this.brR[0].off()
      this.brL[1].off()
      this.brR[1].off()
    }
    if (plan.tiltDb < -0.05) {
      this.brL[2].set('highshelf', sr, 4000, 0.6, plan.tiltDb)
      this.brR[2].set('highshelf', sr, 4000, 0.6, plan.tiltDb)
    } else {
      this.brL[2].off()
      this.brR[2].off()
    }
    // Direct sound colour with distance (always a shelf, flat when as built,
    // so moving the distance never switches a filter in or out).
    const n = (50 - clamp(num(distance, 50), 0, 100)) / 50
    if (n < 0) {
      this.dsL.set('highshelf', sr, 3500, 0.707, 4.5 * n)
      this.dsR.set('highshelf', sr, 3500, 0.707, 4.5 * n)
    } else {
      this.dsL.set('lowshelf', sr, 200, 0.707, 3 * n)
      this.dsR.set('lowshelf', sr, 200, 0.707, 3 * n)
    }
    // The space's colouring.
    const list = plan.shape
    let ns = 0
    for (let k = 0; k < list.length && ns < MAX_SHAPE; k++) {
      const it = list[k]
      let f = it[1]
      if (it[4]) f = f / s
      if (!(f > 20) || f > 0.45 * sr) continue
      this.shL[ns].set(it[0], sr, f, it[2], it[3])
      this.shR[ns].set(it[0], sr, Math.min(f * 1.004, 0.45 * sr), it[2], it[3])
      ns++
    }
    this.nShape = ns
    let nc = 0
    for (let k = 0; k < plan.combs.length && nc < 3; k++) {
      const cb = plan.combs[k]
      this.combD[nc] = clamp((cb[0] * s * sr) / 1000, 1, Math.ceil(0.06 * sr))
      this.combFb[nc] = cb[1]
      this.combG[nc] = 1 - Math.exp((-2 * Math.PI * Math.min(cb[2], 0.45 * sr)) / sr)
      nc++
    }
    this.nComb = nc
    // Level match, speech weighted, as core/ir.js does for the offline space.
    // On a fine frequency grid: the direct sound and the early taps add as
    // complex numbers (in tiny spaces they arrive together and add in
    // phase), the late tail adds in power, and the space's resonances and
    // combs multiply exactly (a can's combs sit right on its resonances).
    const dAmp = plan.direct * gd
    let acc = 0
    let wsum = 0
    for (let k = 0; k < nGrid; k++) {
      const f = fGrid[k]
      const w = speechW(f) * f
      const om = (2 * Math.PI * f) / sr
      const pB = this.brL[0].power(sr, f) * this.brL[1].power(sr, f) * this.brL[2].power(sr, f)
      const aT = ge * Math.sqrt(pB)
      const dA = dAmp * Math.sqrt(this.dsL.power(sr, f))
      let reL = this.effect ? 0 : dA
      let imL = 0
      let reR = reL
      let imR = 0
      for (let j = 0; j < nT; j++) {
        const d = Math.round(preS + (tMs[j] / 1000) * sr)
        const cw = Math.cos(om * d)
        const sw = Math.sin(om * d)
        reL += aT * tL[j] * cw
        imL -= aT * tL[j] * sw
        reR += aT * tR[j] * cw
        imR -= aT * tR[j] * sw
      }
      const pE = 0.5 * (reL * reL + imL * imL + reR * reR + imR * imR)
      const pLate = gl * gl * plan.eLate * pB
      let pS = 1
      for (let q = 0; q < ns; q++) pS *= this.shL[q].power(sr, f)
      for (let q = 0; q < nc; q++) {
        // 1 / (1 - fb LP(w) e^{-jwD}), LP the one-pole a / (1 - (1 - a) e^{-jw}).
        const a = this.combG[q]
        const b = 1 - a
        const lr0 = 1 - b * Math.cos(om)
        const li0 = b * Math.sin(om)
        const ld = lr0 * lr0 + li0 * li0
        const lpr = (a * lr0) / ld
        const lpi = (-a * li0) / ld
        const D = this.combD[q]
        const er = Math.cos(om * D)
        const ei = -Math.sin(om * D)
        const fb = this.combFb[q]
        const xr = 1 - fb * (lpr * er - lpi * ei)
        const xi = -fb * (lpr * ei + lpi * er)
        pS /= Math.max(1e-6, xr * xr + xi * xi)
      }
      const tot = this.effect ? dA * dA + (pE + pLate) * pS : (pE + pLate) * pS
      acc += w * tot
      wsum += w
    }
    const eTot = acc / Math.max(1e-12, wsum)
    this.gdT = dAmp
    this.GT = 1 / Math.sqrt(Math.max(1e-9, eTot))
    if (fresh) {
      this.gd = this.gdT
      this.G = this.GT
      for (let k = 0; k < 3; k++) this.combDc[k] = this.combD[k]
    }
  }

  reset() {
    for (let k = 0; k < MAX_SHAPE; k++) {
      this.shL[k].reset()
      this.shR[k].reset()
    }
    for (let k = 0; k < 3; k++) {
      this.brL[k].reset()
      this.brR[k].reset()
      this.combL[k].clear()
      this.combR[k].clear()
      this.combSL[k] = this.combSR[k] = 0
      this.combDc[k] = this.combD[k]
    }
    this.dsL.reset()
    this.dsR.reset()
    this.gd = this.gdT
    this.G = this.GT
  }

  /** One stereo sample: reflections ra, rb and the dry xl, xr. Writes oa, ob. */
  tick(ra, rb, xl, xr, sm) {
    this.gd += (this.gdT - this.gd) * sm
    this.G += (this.GT - this.G) * sm
    let a = this.brL[2].tick(this.brL[1].tick(this.brL[0].tick(ra)))
    let b = this.brR[2].tick(this.brR[1].tick(this.brR[0].tick(rb)))
    const dl = this.dsL.tick(xl) * this.gd
    const dr = this.dsR.tick(xr) * this.gd
    if (!this.effect) {
      a += dl
      b += dr
    }
    for (let k = 0; k < this.nComb; k++) {
      const D = (this.combDc[k] += (this.combD[k] - this.combDc[k]) * sm)
      const fb = this.combFb[k]
      const g = this.combG[k]
      const cl = this.combL[k]
      const cr = this.combR[k]
      let s = this.combSL[k]
      s += g * (cl.read(D - 1) - s)
      if (s < TINY && s > -TINY) s = 0
      this.combSL[k] = s
      a += fb * s
      cl.write(a)
      s = this.combSR[k]
      s += g * (cr.read(D * 1.003 - 1) - s)
      if (s < TINY && s > -TINY) s = 0
      this.combSR[k] = s
      b += fb * s
      cr.write(b)
    }
    for (let k = 0; k < this.nShape; k++) {
      a = this.shL[k].tick(a)
      b = this.shR[k].tick(b)
    }
    if (this.effect) {
      a += dl
      b += dr
    }
    this.oa = a * this.G
    this.ob = b * this.G
  }
}

/**
 * The live room: an FDN (or the spring engine) tuned to a named space, its
 * direct sound, and the space's own colouring, level matched. run() writes
 * the full "in the space" signal (direct included) to wl and wr. A change of
 * place or size crossfades between two output chains (and between the
 * network and the spring tank when that changes) over 40 ms; a change that
 * arrives during a crossfade waits for it to finish.
 */
export class RoomLiveEngine {
  constructor(sr, rng, opts = {}) {
    this.sr = sr
    const lines = opts.lines === 8 ? 8 : 16
    this.fdn = new FdnEngine(sr, { lines, maxLineMs: 290, maxPreMs: 3400, rng: rng && rng.fork ? rng.fork('room-fdn') : rng })
    this.spring = new SpringEngine(sr, { maxSprings: 3 })
    this.cfg = fdnConfig()
    this.scfg = { springs: 2, drip: 0.6, decay: 2.5, tone: 0.35, length: 0.5, level: 1 }
    this.max = 2048
    this.rl = new Float32Array(this.max)
    this.rr = new Float32Array(this.max)
    this.ol = new Float32Array(this.max)
    this.or = new Float32Array(this.max)
    this.chains = [new PostChain(sr), new PostChain(sr)]
    this.ci = 0
    this.fade = 0
    this.fadeLen = Math.max(1, Math.round(0.04 * sr))
    this.engFade = false
    this.oldKind = 'fdn'
    this.kind = 'fdn'
    this.tMs = new Float64Array(MAX_TAPS)
    this.tL = new Float64Array(MAX_TAPS)
    this.tR = new Float64Array(MAX_TAPS)
    this.dg = new Float64Array(3)
    this.sm = 1 - Math.exp(-1 / (0.03 * sr))
    this.first = true
    this.name = ''
    this.size = 1
    this.pending = false
    this.pName = ''
    this.pSize = 1
    this.pDist = 50
    this.pPre = 0
    this.pTone = 0
    // Frequency grid for level matching.
    this.nGrid = 160
    this.fGrid = new Float64Array(this.nGrid)
    const top = Math.min(16000, 0.45 * sr)
    for (let k = 0; k < this.nGrid; k++) this.fGrid[k] = 60 * Math.pow(top / 60, k / (this.nGrid - 1))
    // Plans are built here, off the audio thread, for every space.
    for (const nm of SPACE_NAMES) livePlan(nm, sr)
  }

  /** Point the engine at a space. Allocates nothing once plans exist. */
  setSpace(name, size, distance, predelayMs, tone) {
    const sr = this.sr
    const nm = SPACES[name] ? name : DEFAULT_SPACE
    const s = clamp(num(size, 1), 0.5, 2)
    const structural = !this.first && (nm !== this.name || s !== this.size)
    if (structural && this.fade > 0) {
      // Finish the running crossfade first; this change follows it.
      this.pending = true
      this.pName = nm
      this.pSize = s
      this.pDist = num(distance, 50)
      this.pPre = num(predelayMs, 0)
      this.pTone = num(tone, 0)
      return
    }
    const plan = livePlan(nm, sr)
    const kindChanged = !this.first && plan.kind !== this.kind
    if (kindChanged) {
      // The incoming engine has been idle: clear it, and let the outgoing
      // one fade out under it.
      this.oldKind = this.kind
      this.engFade = true
      if (plan.kind === 'spring') this.spring.reset()
      else this.fdn.reset()
    }
    this.kind = plan.kind
    this.name = nm
    this.size = s
    const dg = distanceGainsInto(this.dg, distance)
    const gd = dg[0]
    const ge = dg[1]
    const gl = dg[2]
    const pre = plan.predelayMs * s + clamp(num(predelayMs, 0), 0, 200)
    let nT = 0
    if (plan.kind === 'spring') {
      const sc = this.scfg
      sc.springs = plan.spring.springs
      sc.drip = plan.spring.drip
      sc.decay = clamp(plan.spring.decay * s, 0.3, 10)
      sc.tone = plan.spring.tone
      sc.length = clamp(0.5 + (s - 1) * 0.6, 0, 1)
      sc.level = Math.sqrt(plan.eLate / Math.max(1e-9, plan.springW)) * gl
      this.spring.configure(sc)
    } else {
      const c = this.cfg
      c.minDelayMs = plan.minDelayMs * s
      c.spread = plan.spread
      c.decay = clamp(plan.decay * s, 0.03, 60)
      c.hiRatio = plan.hiRatio
      c.hiHz = plan.hiHz
      c.bassRatio = plan.bassRatio
      c.bassHz = 250
      c.mod = plan.minDelayMs * s < 2 ? 0.05 : plan.mod
      c.modRate = 0.5
      c.predelayMs = pre
      c.diffusion = plan.diffusion
      c.sendHp = 40
      c.sendLp = 0.45 * sr
      c.lateGain = Math.sqrt(plan.eLate) * gl
      c.earlyGain = ge
      c.earlyLp = plan.earlyLp
      c.width = 1
      c.freeze = 0
      this.fdn.configure(c)
      nT = plan.tapN
      for (let k = 0; k < nT; k++) {
        this.tMs[k] = plan.tapMs[k] * s
        this.tL[k] = plan.tapL[k]
        this.tR[k] = plan.tapR[k]
      }
      this.fdn.setTaps(nT, this.tMs, this.tL, this.tR)
    }
    const preS = (pre / 1000) * sr
    if (this.first) {
      this.chains[this.ci].configure(plan, s, gd, ge, gl, distance, tone, nT, this.tMs, this.tL, this.tR, preS, this.fGrid, this.nGrid, true)
      this.chains[this.ci].reset()
    } else if (structural) {
      const next = this.chains[1 - this.ci]
      next.configure(plan, s, gd, ge, gl, distance, tone, nT, this.tMs, this.tL, this.tR, preS, this.fGrid, this.nGrid, true)
      next.reset()
      this.ci = 1 - this.ci
      this.fade = this.fadeLen
    } else {
      this.chains[this.ci].configure(plan, s, gd, ge, gl, distance, tone, nT, this.tMs, this.tL, this.tR, preS, this.fGrid, this.nGrid, false)
    }
    this.first = false
  }

  reset() {
    this.fdn.reset()
    this.spring.reset()
    this.chains[0].reset()
    this.chains[1].reset()
    this.fade = 0
    this.engFade = false
    if (this.pending) {
      this.pending = false
      this.setSpace(this.pName, this.pSize, this.pDist, this.pPre, this.pTone)
    }
  }

  run(inL, inR, wl, wr, n, inOff = 0, outOff = 0) {
    let done = 0
    while (done < n) {
      let m = Math.min(this.max, n - done)
      // Stop a block where a crossfade ends, so a waiting change starts on time.
      if (this.fade > 0 && this.fade < m) m = this.fade
      this._block(inL, inR || inL, wl, wr, m, inOff + done, outOff + done)
      done += m
      if (this.fade === 0 && this.pending) {
        this.pending = false
        this.setSpace(this.pName, this.pSize, this.pDist, this.pPre, this.pTone)
      }
    }
  }

  _block(inL, inR, wl, wr, m, inOff, outOff) {
    const rl = this.rl
    const rr = this.rr
    const fading = this.fade > 0
    if (this.kind === 'spring') this.spring.run(inL, inR, rl, rr, m, inOff, 0)
    else this.fdn.run(inL, inR, rl, rr, m, inOff, 0)
    const ol = this.ol
    const or = this.or
    const engFade = fading && this.engFade
    if (engFade) {
      if (this.oldKind === 'spring') this.spring.run(inL, inR, ol, or, m, inOff, 0)
      else this.fdn.run(inL, inR, ol, or, m, inOff, 0)
    }
    const sm = this.sm
    const cur = this.chains[this.ci]
    const old = this.chains[1 - this.ci]
    for (let t = 0; t < m; t++) {
      let xl = inL[inOff + t]
      let xr = inR[inOff + t]
      if (!(xl > -1e9 && xl < 1e9)) xl = 0
      if (!(xr > -1e9 && xr < 1e9)) xr = 0
      if (this.fade > 0) {
        const x = this.fade / this.fadeLen
        this.fade--
        const a = 0.5 - 0.5 * Math.cos(Math.PI * x) // weight of the outgoing chain
        cur.tick(rl[t], rr[t], xl, xr, sm)
        if (engFade) old.tick(ol[t], or[t], xl, xr, sm)
        else old.tick(rl[t], rr[t], xl, xr, sm)
        wl[outOff + t] = cur.oa * (1 - a) + old.oa * a
        wr[outOff + t] = cur.ob * (1 - a) + old.ob * a
      } else {
        cur.tick(rl[t], rr[t], xl, xr, sm)
        wl[outOff + t] = cur.oa
        wr[outOff + t] = cur.ob
      }
    }
    if (this.fade === 0) this.engFade = false
  }
}

function makeRoomLive(sr, p, rng) {
  const eng = new RoomLiveEngine(sr, rng, { lines: 16 })
  const mix = new MixInstance(sr)
  const apply = (q) => {
    eng.setSpace(q.space, q.size, q.distance, q.predelay, q.tone)
    const m = clamp(num(q.mix, 100), 0, 100) / 100
    mix.dryT = 1 - m
    mix.wetT = m
  }
  apply(p)
  return {
    process(ins, outs, n) {
      mix.mixBlock(ins, outs, n, eng)
    },
    set(np) {
      apply(np)
    },
    reset() {
      eng.reset()
      mix.inited = false
    },
  }
}

export default {
  id: 'space.room',
  name: 'Room',
  family: 'space',
  about: 'Puts your voice inside a real place, from a closet or a tin can to a cathedral or a canyon.',
  params: [
    { id: 'space', name: 'Place', type: 'choice', def: DEFAULT_SPACE, options: SPACE_OPTIONS },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [55, 100] },
    { id: 'distance', name: 'Distance from you', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [25, 75] },
    { id: 'predelay', name: 'Gap before the echoes', type: 'number', min: 0, max: 200, step: 1, def: 0, unit: 'ms', rand: [0, 25] },
    { id: 'size', name: 'Size of the place', type: 'number', min: 0.5, max: 2, step: 0.05, def: 1, unit: 'x', rand: [0.8, 1.3] },
    { id: 'tone', name: 'Brightness of the echoes', type: 'number', min: -100, max: 100, step: 1, def: 0, unit: 'percent', words: { neg: 'darker', pos: 'brighter', zero: 'as built' }, rand: [-40, 30] },
  ],
  stereo: 'make',
  tail: (p, sr) => roomTailSamples(p, sr || 48000) / (sr || 48000),
  warps: false,
  cost: 4,
  process(input, p, ctx) {
    const sr = input.sr
    const len = input.ch[0] ? input.ch[0].length : 0
    if (len === 0) return { sr, ch: [new Float32Array(0), new Float32Array(0)] }
    const name = SPACES[p.space] ? p.space : DEFAULT_SPACE
    const s = clamp(num(p.size, 1), 0.5, 2)
    const parts = spaceParts(name, sr, ctx && ctx.rng, s)
    if (ctx && typeof ctx.progress === 'function') ctx.progress(0.3)
    const preSamp = Math.round((clamp(num(p.predelay, 0), 0, 200) / 1000) * sr)
    const ir = buildResponse(parts, sr, p.distance, preSamp, p.tone)
    const w = 0.5 * (weightedEnergy(ir[0], sr) + weightedEnergy(ir[1], sr))
    const g = w > 0 ? Math.sqrt(parts.w0 / w) : 1
    for (let c = 0; c < 2; c++) {
      const h = ir[c]
      for (let i = 0; i < h.length; i++) h[i] *= g
    }
    const wet = convolveBuf(input, { sr, ch: ir }, num(p.mix, 100), { law: 'linear' })
    const outLen = len + roomTailSamples(p, sr)
    const out = [new Float32Array(outLen), new Float32Array(outLen)]
    for (let c = 0; c < 2; c++) {
      const src = wet.ch[Math.min(c, wet.ch.length - 1)]
      const n = Math.min(outLen, src.length)
      const o = out[c]
      for (let i = 0; i < n; i++) {
        const v = src[i]
        o[i] = v > -1e9 && v < 1e9 ? v : 0
      }
    }
    if (ctx && typeof ctx.progress === 'function') ctx.progress(1)
    return { sr, ch: out }
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p, rng) {
      return makeRoomLive(sr, p, rng)
    },
  },
}

export { SPACE_OPTIONS, livePlan, renderLive, irSamples, weightedEnergy }
