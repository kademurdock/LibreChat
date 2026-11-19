// modules/space/muffle.js - space.muffle, a voice heard through a wall: from
// the next room, behind a closed door, upstairs through the floor, outside
// the car window, out of a heating vent.
//
// Technique: building acoustics, after the sound transmission models in
// Fahy, "Sound and Structural Vibration", and the mass law of partitions
// (transmission loss rising about 6 dB per octave per single leaf, faster for
// double walls above their mass-spring-mass resonance), as three stages:
// 1. The room behind: the talker is in a real room, so the wall is driven
//    by that room's whole sound field, reverb and all (core/ir.js namedIR
//    offline; the tuned feedback delay network of ./room.js live).
// 2. The partition, per wall type: steep low passes for the mass law (two
//    sections), the panel or mass-spring-mass resonance as a low peak (the
//    boom of a wall or floor), the coincidence region where a light panel
//    lets some upper mids through (a peak around 2.5 to 3.5 kHz for doors and
//    glass), duct modes and a comb for a vent, and a second, much quieter
//    path for leaks: the gap under a door, a closet's louvres, a window's
//    seals, which pass a thin band of highs and keep words just barely
//    understandable, the way real doors do.
// 3. Your side: the wall radiates into the room you are in, so a little of
//    that small room (or the car, for a car window) is mixed in.
// Offline all three are folded into one stereo response and convolved
// (core/conv.js); live they run as filters and two small networks. The
// result is level matched in the speech band (core/ir.js's weighting).

import { namedIR, SPACES, spaceSpec } from '../../core/ir.js'
import { convolve, convolveBuf } from '../../core/conv.js'
import { Biquad } from '../../core/biquad.js'
import { DelayLine } from '../../core/delay.js'
import { makeRng } from '../../core/rng.js'
import { LiveBiquad, MixInstance } from './reverb.js'
import { RoomLiveEngine, irSamples, weightedEnergy } from './room.js'

const TINY = 1e-20

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

function speechW(f) {
  const h = (f * f * f * f) / (f * f * f * f + 1e8)
  return h / (1 + (f / 700) * (f / 700))
}

// Each wall: main path [type, Hz, Q, dB] (low passes follow "Muffling"),
// leak path and its level, an optional comb [ms, feedback, low pass Hz], the
// room the talker is usually in, and the room you are in.
const WALLS = {
  door: {
    main: [['lowpass', 450, 0.6, 0], ['lowpass', 1500, 0.5, 0], ['peak', 180, 1.4, 4], ['peak', 2800, 1.5, 6]],
    leak: [['highpass', 800, 0.7, 0], ['lowpass', 6000, 0.7, 0], ['peak', 2500, 2, 3]],
    leakDb: -24,
    room: 'living-room',
    you: 'bedroom',
  },
  closet: {
    main: [['lowpass', 700, 0.6, 0], ['lowpass', 2500, 0.5, 0], ['peak', 250, 1.2, 3]],
    leak: [['highpass', 500, 0.7, 0], ['lowpass', 5000, 0.7, 0]],
    leakDb: -17,
    room: 'closet',
    you: 'bedroom',
  },
  thin: {
    main: [['lowpass', 320, 0.7, 0], ['lowpass', 900, 0.5, 0], ['peak', 120, 1.5, 5], ['peak', 2500, 1.5, 5]],
    leak: [['highpass', 400, 0.7, 0], ['lowpass', 3000, 0.7, 0]],
    leakDb: -36,
    room: 'bedroom',
    you: 'bedroom',
  },
  thick: {
    main: [['lowpass', 180, 0.7, 0], ['lowpass', 180, 0.7, 0], ['peak', 75, 1.3, 5]],
    leak: [],
    leakDb: -90,
    room: 'living-room',
    you: 'bedroom',
  },
  floor: {
    main: [['lowpass', 230, 0.8, 0], ['lowpass', 520, 0.6, 0], ['peak', 55, 1.5, 7], ['peak', 120, 2, 4], ['peak', 85, 6, 4]],
    leak: [['highpass', 600, 0.7, 0], ['lowpass', 2500, 0.7, 0]],
    leakDb: -40,
    room: 'living-room',
    you: 'living-room',
  },
  window: {
    main: [['lowpass', 650, 0.7, 0], ['lowpass', 2200, 0.6, 0], ['peak', 3200, 2.5, 9], ['peak', 130, 1.5, 3]],
    leak: [['highpass', 1200, 0.7, 0], ['lowpass', 7000, 0.7, 0]],
    leakDb: -28,
    room: 'field',
    you: 'car',
  },
  vent: {
    main: [['highpass', 250, 0.7, 0], ['lowpass', 4000, 0.7, 0], ['peak', 700, 4, 7], ['peak', 1450, 5, 6], ['peak', 2900, 6, 4]],
    leak: [],
    leakDb: -90,
    comb: [6.5, 0.5, 3500],
    room: 'kitchen',
    you: 'bedroom',
  },
}

const ROOM_CHOICES = ['auto', 'none', 'bedroom', 'living-room', 'kitchen', 'bathroom', 'hallway', 'classroom', 'gym', 'church', 'field']

const MAX_MAIN = 6
const MAX_LEAK = 3

/** Resolve the talker's room name (or null for no room). */
function roomOf(p) {
  const w = WALLS[p.wall] || WALLS.door
  const r = p.room === 'auto' || !p.room ? w.room : p.room
  if (r === 'none' || !SPACES[r]) return null
  return r
}

function youOf(p) {
  const w = WALLS[p.wall] || WALLS.door
  return SPACES[w.you] ? w.you : null
}

/** Low-pass scale for the main path from "Muffling" (0 light .. 100 heavy). */
function muffleK(p) {
  return Math.pow(2, ((50 - clamp(num(p.muffling, 50), 0, 100)) / 50) * 1.3)
}

/** Linear level of the leak path from the wall, "Muffling" and "Gaps". */
function leakGain(p) {
  const w = WALLS[p.wall] || WALLS.door
  const gaps = clamp(num(p.gaps, 50), 0, 100)
  if (gaps <= 0 || w.leakDb < -80) return 0
  const db = w.leakDb + ((gaps - 50) / 50) * 12 + ((50 - clamp(num(p.muffling, 50), 0, 100)) / 50) * 6
  return Math.pow(10, db / 20)
}

function freqOf(it, k, sr) {
  const f = it[0] === 'lowpass' ? it[1] * k : it[1]
  return Math.min(f, 0.45 * sr)
}

const PAD_SEC = 0.3

function muffleTailSamples(p, sr) {
  const r = roomOf(p)
  const y = youOf(p)
  const a = r ? irSamples(spaceSpec(r), sr) : 1
  const b = y ? irSamples(spaceSpec(y), sr) : 1
  return a - 1 + Math.round(PAD_SEC * sr) + b - 1
}

// ---------------------------------------------------------------- offline

function muffleIR(sr, p, rng) {
  const w = WALLS[p.wall] || WALLS.door
  const r = rng && typeof rng.fork === 'function' ? rng : makeRng('muffle')
  const k = muffleK(p)
  const room = roomOf(p)
  const pad = Math.round(PAD_SEC * sr)
  let src
  if (room) {
    const ir = namedIR(room, sr, r)
    const n = ir.ch[0].length
    src = new Float32Array(n + pad)
    for (let i = 0; i < n; i++) src[i] = 0.5 * (ir.ch[0][i] + ir.ch[1][i])
  } else {
    src = new Float32Array(1 + pad)
    src[0] = 1
  }
  const main = new Float32Array(src)
  for (const it of w.main) new Biquad(it[0], sr, freqOf(it, k, sr), it[2], it[3]).run(main)
  if (w.comb) {
    const D = Math.max(1, (w.comb[0] / 1000) * sr)
    const line = new DelayLine(Math.ceil(D) + 4)
    const a = 1 - Math.exp((-2 * Math.PI * Math.min(w.comb[2], 0.45 * sr)) / sr)
    let s = 0
    for (let i = 0; i < main.length; i++) {
      s += a * (line.read(D - 1) - s)
      if (s < TINY && s > -TINY) s = 0
      const y = main[i] + w.comb[1] * s
      line.write(y)
      main[i] = y
    }
  }
  const lg = leakGain(p)
  if (lg > 0 && w.leak.length) {
    const leak = new Float32Array(src)
    for (const it of w.leak) new Biquad(it[0], sr, Math.min(it[1], 0.45 * sr), it[2], it[3]).run(leak)
    for (let i = 0; i < main.length; i++) main[i] += leak[i] * lg
  }
  // Your side of the wall.
  const amt = clamp(num(p.yours, 35), 0, 100) / 100
  const you = youOf(p)
  const out = []
  if (you && amt > 0) {
    const yir = namedIR(you, sr, r)
    for (let c = 0; c < 2; c++) {
      const h = new Float32Array(yir.ch[c].length)
      for (let i = 0; i < h.length; i++) h[i] = yir.ch[c][i] * amt
      h[0] += 1 - amt
      out.push(convolve(main, h))
    }
  } else {
    out.push(new Float32Array(main), new Float32Array(main))
  }
  const ref = new Float32Array(Math.round(0.25 * sr))
  ref[0] = 1
  const wr = weightedEnergy(ref, sr)
  const we = 0.5 * (weightedEnergy(out[0], sr) + weightedEnergy(out[1], sr))
  const g = we > 0 ? Math.sqrt(wr / we) : 0
  for (const h of out) for (let i = 0; i < h.length; i++) h[i] *= g
  return { sr, ch: out }
}

// ---------------------------------------------------------------- live

/** One partition for live use: the main path, the leak path, a comb, and its level. */
class WallChain {
  constructor(sr) {
    this.sr = sr
    this.main = []
    this.leak = []
    for (let k = 0; k < MAX_MAIN; k++) this.main.push(new LiveBiquad())
    for (let k = 0; k < MAX_LEAK; k++) this.leak.push(new LiveBiquad())
    this.nMain = 0
    this.nLeak = 0
    this.comb = new DelayLine(Math.ceil(0.01 * sr) + 8)
    this.combOn = false
    this.combD = 1
    this.combFb = 0
    this.combG = 0
    this.combS = 0
    this.lg = 0
    this.lgT = 0
    this.G = 1
    this.GT = 1
  }

  configure(p, fGrid, nGrid, fresh) {
    const sr = this.sr
    const w = WALLS[p.wall] || WALLS.door
    const k = muffleK(p)
    let nm = 0
    for (let j = 0; j < w.main.length && nm < MAX_MAIN; j++) {
      const it = w.main[j]
      this.main[nm++].set(it[0], sr, freqOf(it, k, sr), it[2], it[3])
    }
    this.nMain = nm
    let nl = 0
    for (let j = 0; j < w.leak.length && nl < MAX_LEAK; j++) {
      const it = w.leak[j]
      this.leak[nl++].set(it[0], sr, Math.min(it[1], 0.45 * sr), it[2], it[3])
    }
    this.nLeak = nl
    this.lgT = nl ? leakGain(p) : 0
    if (w.comb) {
      this.combOn = true
      this.combD = Math.max(1, (w.comb[0] / 1000) * sr)
      this.combFb = w.comb[1]
      this.combG = 1 - Math.exp((-2 * Math.PI * Math.min(w.comb[2], 0.45 * sr)) / sr)
    } else this.combOn = false
    // Level: the partition's speech-band power (the rooms level themselves).
    let acc = 0
    let ws = 0
    for (let q = 0; q < nGrid; q++) {
      const f = fGrid[q]
      const wt = speechW(f) * f
      let pm = 1
      for (let j = 0; j < nm; j++) pm *= this.main[j].power(sr, f)
      if (this.combOn) {
        const om = (2 * Math.PI * f) / sr
        const a = this.combG
        const b = 1 - a
        const lr0 = 1 - b * Math.cos(om)
        const li0 = b * Math.sin(om)
        const ld = lr0 * lr0 + li0 * li0
        const lpr = (a * lr0) / ld
        const lpi = (-a * li0) / ld
        const er = Math.cos(om * this.combD)
        const ei = -Math.sin(om * this.combD)
        const xr = 1 - this.combFb * (lpr * er - lpi * ei)
        const xi = -this.combFb * (lpr * ei + lpi * er)
        pm /= Math.max(1e-6, xr * xr + xi * xi)
      }
      let pl = this.lgT * this.lgT
      for (let j = 0; j < nl; j++) pl *= this.leak[j].power(sr, f)
      acc += wt * (pm + (nl ? pl : 0))
      ws += wt
    }
    this.GT = 1 / Math.sqrt(Math.max(1e-9, acc / ws))
    if (fresh) {
      this.lg = this.lgT
      this.G = this.GT
    }
  }

  reset() {
    for (let j = 0; j < MAX_MAIN; j++) this.main[j].reset()
    for (let j = 0; j < MAX_LEAK; j++) this.leak[j].reset()
    this.comb.clear()
    this.combS = 0
    this.lg = this.lgT
    this.G = this.GT
  }

  tick(x, sm) {
    let y = x
    for (let j = 0; j < this.nMain; j++) y = this.main[j].tick(y)
    if (this.combOn) {
      let s = this.combS
      s += this.combG * (this.comb.read(this.combD - 1) - s)
      if (s < TINY && s > -TINY) s = 0
      this.combS = s
      y += this.combFb * s
      this.comb.write(y)
    }
    this.lg += (this.lgT - this.lg) * sm
    this.G += (this.GT - this.G) * sm
    if (this.nLeak) {
      let z = x
      for (let j = 0; j < this.nLeak; j++) z = this.leak[j].tick(z)
      y += z * this.lg
    }
    return y * this.G
  }
}

/**
 * The live wall: the room behind (a tuned network, blended in or out so it
 * never cuts), the partition (two chains that crossfade over 40 ms when the
 * wall or its muffling changes; a change during a crossfade waits for it),
 * and your side of the wall.
 */
class MuffleEngine {
  constructor(sr, rng) {
    this.sr = sr
    const r = rng && typeof rng.fork === 'function' ? rng : makeRng('muffle')
    this.src = new RoomLiveEngine(sr, r.fork('room'), { lines: 8 })
    this.you = new RoomLiveEngine(sr, r.fork('yours'), { lines: 8 })
    this.max = 2048
    this.sL = new Float32Array(this.max)
    this.sR = new Float32Array(this.max)
    this.mono = new Float32Array(this.max)
    this.yL = new Float32Array(this.max)
    this.yR = new Float32Array(this.max)
    this.walls = [new WallChain(sr), new WallChain(sr)]
    this.wi = 0
    this.fade = 0
    this.fadeLen = Math.max(1, Math.round(0.04 * sr))
    this.roomMix = 1
    this.roomMixT = 1
    this.amt = 0
    this.amtT = 0
    this.sm = 1 - Math.exp(-1 / (0.03 * sr))
    this.first = true
    this.wall = ''
    this.muff = 50
    // A change waiting for the crossfade to end (kept without allocating).
    this.pending = false
    this.pp = { wall: 'door', room: 'auto', muffling: 50, gaps: 50, yours: 35 }
    this.cur = { wall: 'door', room: 'auto', muffling: 50, gaps: 50, yours: 35 }
    this.nGrid = 96
    this.fGrid = new Float64Array(this.nGrid)
    const top = Math.min(16000, 0.45 * sr)
    for (let k = 0; k < this.nGrid; k++) this.fGrid[k] = 40 * Math.pow(top / 40, k / (this.nGrid - 1))
  }

  setup(p) {
    const wall = WALLS[p.wall] ? p.wall : 'door'
    const muff = clamp(num(p.muffling, 50), 0, 100)
    const structural = !this.first && (wall !== this.wall || muff !== this.muff)
    if (structural && this.fade > 0) {
      const q = this.pp
      q.wall = wall
      q.room = p.room
      q.muffling = muff
      q.gaps = p.gaps
      q.yours = p.yours
      this.pending = true
      return
    }
    const c = this.cur
    c.wall = wall
    c.room = p.room
    c.muffling = muff
    c.gaps = num(p.gaps, 50)
    c.yours = num(p.yours, 35)
    const room = roomOf(c)
    if (room) {
      this.src.setSpace(room, 1, 50, 0, 0)
      this.roomMixT = 1
    } else {
      this.roomMixT = 0
      if (this.first) this.src.setSpace('living-room', 1, 50, 0, 0)
    }
    const you = youOf(c)
    if (you) this.you.setSpace(you, 1, 50, 0, 0)
    this.amtT = you ? clamp(c.yours, 0, 100) / 100 : 0
    if (this.first) {
      this.walls[this.wi].configure(c, this.fGrid, this.nGrid, true)
      this.walls[this.wi].reset()
      this.roomMix = this.roomMixT
      this.amt = this.amtT
    } else if (structural) {
      const next = this.walls[1 - this.wi]
      next.configure(c, this.fGrid, this.nGrid, true)
      next.reset()
      this.wi = 1 - this.wi
      this.fade = this.fadeLen
    } else {
      this.walls[this.wi].configure(c, this.fGrid, this.nGrid, false)
    }
    this.wall = wall
    this.muff = muff
    this.first = false
  }

  reset() {
    this.src.reset()
    this.you.reset()
    this.walls[0].reset()
    this.walls[1].reset()
    this.fade = 0
    this.roomMix = this.roomMixT
    this.amt = this.amtT
    if (this.pending) {
      this.pending = false
      this.setup(this.pp)
    }
  }

  run(inL, inR, wl, wr, n, inOff = 0, outOff = 0) {
    let done = 0
    while (done < n) {
      let m = Math.min(this.max, n - done)
      if (this.fade > 0 && this.fade < m) m = this.fade
      this._block(inL, inR || inL, wl, wr, m, inOff + done, outOff + done)
      done += m
      if (this.fade === 0 && this.pending) {
        this.pending = false
        this.setup(this.pp)
      }
    }
  }

  _block(inL, inR, wl, wr, m, inOff, outOff) {
    const mono = this.mono
    const sm = this.sm
    this.src.run(inL, inR, this.sL, this.sR, m, inOff, 0)
    for (let t = 0; t < m; t++) {
      let a = inL[inOff + t]
      let b = inR[inOff + t]
      if (!(a > -1e9 && a < 1e9)) a = 0
      if (!(b > -1e9 && b < 1e9)) b = 0
      this.roomMix += (this.roomMixT - this.roomMix) * sm
      const dry = 0.5 * (a + b)
      const inRoom = 0.5 * (this.sL[t] + this.sR[t])
      const x = inRoom * this.roomMix + dry * (1 - this.roomMix)
      const cur = this.walls[this.wi]
      if (this.fade > 0) {
        const f = this.fade / this.fadeLen
        this.fade--
        const g = 0.5 - 0.5 * Math.cos(Math.PI * f)
        const old = this.walls[1 - this.wi]
        mono[t] = cur.tick(x, sm) * (1 - g) + old.tick(x, sm) * g
      } else {
        mono[t] = cur.tick(x, sm)
      }
    }
    this.you.run(mono, mono, this.yL, this.yR, m, 0, 0)
    for (let t = 0; t < m; t++) {
      this.amt += (this.amtT - this.amt) * sm
      const d = mono[t] * (1 - this.amt)
      wl[outOff + t] = d + this.yL[t] * this.amt
      wr[outOff + t] = d + this.yR[t] * this.amt
    }
  }
}

function makeMuffleLive(sr, p, rng) {
  const eng = new MuffleEngine(sr, rng)
  const mix = new MixInstance(sr)
  eng.setup(p)
  mix.dryT = 0
  mix.wetT = 1
  return {
    process(ins, outs, n) {
      mix.mixBlock(ins, outs, n, eng)
    },
    set(np) {
      eng.setup(np)
    },
    reset() {
      eng.reset()
      mix.inited = false
    },
  }
}

const ROOM_NAMES = {
  auto: 'Matches the wall',
  none: 'No room, just the wall',
  bedroom: 'Bedroom',
  'living-room': 'Living room',
  kitchen: 'Kitchen',
  bathroom: 'Bathroom',
  hallway: 'Hallway',
  classroom: 'Classroom',
  gym: 'School gym',
  church: 'Church',
  field: 'Outdoors',
}

export default {
  id: 'space.muffle',
  name: 'Through a wall',
  family: 'space',
  about: 'Your voice from the next room: through a door, a wall, the floor upstairs, a car window or a heating vent.',
  params: [
    {
      id: 'wall',
      name: 'What is in between',
      type: 'choice',
      def: 'door',
      options: [
        { v: 'door', name: 'A closed door' },
        { v: 'closet', name: 'From inside a closet' },
        { v: 'thin', name: 'A thin wall' },
        { v: 'thick', name: 'A thick brick wall' },
        { v: 'floor', name: 'The floor, from upstairs' },
        { v: 'window', name: 'A car window' },
        { v: 'vent', name: 'A heating vent' },
      ],
    },
    { id: 'room', name: 'Room behind it', type: 'choice', def: 'auto', options: ROOM_CHOICES.map((v) => ({ v, name: ROOM_NAMES[v] })) },
    { id: 'muffling', name: 'Muffling', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [25, 75] },
    { id: 'gaps', name: 'Gaps and cracks', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
    { id: 'yours', name: 'Your side of the wall', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [15, 55] },
  ],
  stereo: 'make',
  tail: (p, sr) => muffleTailSamples(p, sr || 48000) / (sr || 48000),
  warps: false,
  cost: 4,
  process(input, p, ctx) {
    const sr = input.sr
    const len = input.ch[0] ? input.ch[0].length : 0
    if (len === 0) return { sr, ch: [new Float32Array(0), new Float32Array(0)] }
    const ir = muffleIR(sr, p, ctx && ctx.rng)
    if (ctx && typeof ctx.progress === 'function') ctx.progress(0.3)
    const wet = convolveBuf(input, ir, 100, { law: 'linear' })
    const outLen = len + muffleTailSamples(p, sr)
    const out = [new Float32Array(outLen), new Float32Array(outLen)]
    for (let c = 0; c < 2; c++) {
      const src = wet.ch[Math.min(c, wet.ch.length - 1)]
      const n = Math.min(outLen, src.length)
      for (let i = 0; i < n; i++) {
        const v = src[i]
        out[c][i] = v > -1e9 && v < 1e9 ? v : 0
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
      return makeMuffleLive(sr, p, rng)
    },
  },
}
