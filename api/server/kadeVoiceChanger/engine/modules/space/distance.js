// modules/space/distance.js - space.distance, a voice far away: across a
// field, down the street, at the other end of a huge hall.
//
// Technique: outdoor sound propagation as in ISO 9613 and Embleton 1996
// ("Tutorial on sound propagation outdoors", JASA 100), plus the diffuse
// field of a big hall indoors (Kuttruff, "Room Acoustics"), run directly on
// the voice so live mode and the offline render are the same code.
// - Air absorption: the ISO 9613-1 attenuation at 20 C and 50 percent
//   humidity grows close to f^1.7 (about 3.7 dB per kilometre at 1 kHz,
//   33 dB at 4 kHz); it is matched by a second-order low pass whose 3 dB
//   point is where the path loses 3 dB.
// - The ground reflection: a second copy of the voice from the ground,
//   arriving later by sqrt(d^2 + (h1 + h2)^2) - d (talker and listener at
//   1.6 m), inverted and dulled the more grazing it is (soft ground near
//   grazing incidence reflects with a coefficient near -1). Far away it
//   cancels the lows: the "ground effect" that makes distant voices thin.
// - Turbulence: wind and warm air bend the path, so distant sound wavers. A
//   smoothly random delay (a few tenths of a millisecond, growing with the
//   square root of distance) and a slow amplitude flutter, both from the
//   stage's seeded random stream.
// - Surroundings: outdoors, a few late echoes off buildings and trees and a
//   short, dark, sparse tail; indoors, the long dense tail of a big hall. The
//   reverberant share grows with the square of the distance over the
//   critical distance (about 70 m outdoors, 6 m in a hall), capped.
// The result is level matched in the speech band, so far means far, not
// silent. The direct path carries a fixed 1.6 ms of delay (room for the
// wavering), reported as live latency and removed offline.

import { LFO } from '../../core/lfo.js'
import { makeRng } from '../../core/rng.js'
import { FdnEngine, fdnConfig, LiveBiquad, MixInstance, renderLive } from './reverb.js'

const C = 343
const TINY = 1e-20

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

function nextPow2(n) {
  let p = 16
  while (p < n) p <<= 1
  return p
}

function speechW(f) {
  const h = (f * f * f * f) / (f * f * f * f + 1e8)
  return h / (1 + (f / 700) * (f / 700))
}

const NTAP = 10

/** Fixed direct-path delay in samples (the live latency). */
function baseDelay(sr) {
  return Math.ceil(0.0016 * sr) + 3
}

export class DistanceEngine {
  constructor(sr, rng) {
    this.sr = sr
    const r = rng && typeof rng.fork === 'function' ? rng : makeRng('distance')
    this.fdn = new FdnEngine(sr, { lines: 8, maxLineMs: 200, maxPreMs: 1300, rng: r.fork('fdn') })
    this.cfg = fdnConfig()
    this.base = baseDelay(sr)
    this.dN = nextPow2(2 * this.base + Math.ceil(0.009 * sr) + 16)
    this.dMask = this.dN - 1
    this.dBuf = new Float32Array(this.dN)
    this.dw = 0
    this.lfoA = new LFO(sr, { shape: 'smooth', rate: 0.55, rng: r.fork('turbA') })
    this.lfoB = new LFO(sr, { shape: 'smooth', rate: 1.9, rng: r.fork('turbB') })
    this.lfoC = new LFO(sr, { shape: 'smooth', rate: 1.2, rng: r.fork('flutter') })
    this.air = new LiveBiquad()
    this.hp = new LiveBiquad()
    this.gLp = 0
    this.gLpS = 0
    this.tapR = r.fork('taps')
    this.tMs = new Float64Array(NTAP)
    this.tL = new Float64Array(NTAP)
    this.tR = new Float64Array(NTAP)
    this.tU = new Float64Array(NTAP * 3)
    for (let k = 0; k < NTAP * 3; k++) this.tU[k] = this.tapR.next()
    // Targets and smoothed values.
    this.depth = 0
    this.depthT = 0
    this.flut = 0
    this.flutT = 0
    this.gDel = 1
    this.gDelT = 1
    this.gCoef = 0
    this.gCoefT = 0
    this.dirG = 1
    this.dirGT = 1
    this.sm = 1 - Math.exp(-1 / (0.03 * sr))
    this.first = true
    this.nGrid = 64
    this.fGrid = new Float64Array(this.nGrid)
    const top = Math.min(16000, 0.45 * sr)
    for (let k = 0; k < this.nGrid; k++) this.fGrid[k] = 60 * Math.pow(top / 60, k / (this.nGrid - 1))
  }

  setup(p) {
    const sr = this.sr
    const d = clamp(num(p.distance, 40), 1, 1000)
    const outdoors = p.outdoors !== false && p.outdoors !== 'off' && p.outdoors !== 0
    const wind = clamp(num(p.wind, 35), 0, 100) / 100
    const echoes = clamp(num(p.echoes, 50), 0, 100) / 100
    const baseMs = (this.base / sr) * 1000
    // Air absorption and the far-voice thinning.
    const fcA = 1000 * Math.pow(3 / (0.0037 * d), 1 / 1.7)
    if (fcA < 0.45 * sr) this.air.set('lowpass', sr, Math.max(500, fcA), 0.6)
    else this.air.off()
    this.hp.set('highpass', sr, 55 * Math.pow(d, 0.18), 0.6)
    // Ground reflection.
    if (outdoors) {
      const h = 3.2
      const extra = Math.sqrt(d * d + h * h) - d
      const theta = Math.atan2(h, d)
      this.gDelT = clamp((extra / C) * sr, 0.5, Math.ceil(0.0085 * sr))
      this.gCoefT = -0.85 + 0.55 * Math.sin(theta)
      this.gLp = 1 - Math.exp((-2 * Math.PI * 3500) / sr)
    } else {
      this.gCoefT = 0
      this.gDelT = 1
    }
    // Turbulence.
    this.depthT = wind * Math.min(0.0012 * sr, 0.00004 * sr * Math.sqrt(d))
    this.flutT = wind * Math.min(6, 0.6 * Math.sqrt(d / 10))
    // Surroundings.
    let rd
    const c = this.cfg
    if (outdoors) {
      rd = Math.min(4, Math.max(0.015, 2 * echoes * (d / 70) * (d / 70)))
      c.decay = Math.min(3, 0.7 + 0.8 * echoes + d / 1500)
      c.hiRatio = 0.4
      c.hiHz = 2500
      c.bassRatio = 1
      c.minDelayMs = 18
      c.diffusion = 0.6
      c.predelayMs = baseMs + 10 + Math.min(60, d / 10)
      c.sendLp = Math.min(0.45 * sr, Math.max(700, fcA * 1.3))
    } else {
      rd = Math.min(30, Math.max(0.05, (0.5 + echoes) * (d / 6) * (d / 6)))
      c.decay = 2.2 + 1.2 * echoes
      c.hiRatio = 0.55
      c.hiHz = 3500
      c.bassRatio = 1.15
      c.minDelayMs = 22
      c.diffusion = 1
      c.predelayMs = baseMs + 6 + Math.min(40, d / 4)
      c.sendLp = Math.min(0.45 * sr, Math.max(1500, fcA * 1.5))
    }
    const tapShare = outdoors ? 0.4 : 0.15
    c.spread = 3.1
    c.bassHz = 250
    c.mod = 0.25
    c.modRate = 0.5
    c.sendHp = 90
    c.lateGain = Math.sqrt(rd * (1 - tapShare))
    c.earlyGain = 1
    c.earlyLp = outdoors ? 2500 : 5000
    c.width = 1
    c.freeze = 0
    this.fdn.configure(c)
    // Echo taps: outdoors a few late answers, indoors early wall reflections.
    const spreadK = outdoors ? 0.5 + 0.5 * Math.min(1, d / 200) : 1
    let e = 0
    for (let k = 0; k < NTAP; k++) {
      const u = this.tU[3 * k]
      const t = outdoors ? (80 + 620 * Math.pow((k + u) / NTAP, 1.4)) * spreadK : 12 + 80 * Math.pow((k + u) / NTAP, 1.2)
      const g = Math.pow(10, (outdoors ? -9 - 11 * (k / NTAP) - 4 * this.tU[3 * k + 1] : -6 - 10 * (k / NTAP)) / 20)
      const pan = (this.tU[3 * k + 2] * 2 - 1) * 0.85
      this.tMs[k] = t
      this.tL[k] = g * Math.sqrt(1 - pan)
      this.tR[k] = g * Math.sqrt(1 + pan)
      e += g * g
    }
    const ts = e > 0 ? Math.sqrt((rd * tapShare) / e) : 0
    for (let k = 0; k < NTAP; k++) {
      this.tL[k] *= ts
      this.tR[k] *= ts
    }
    this.fdn.setTaps(NTAP, this.tMs, this.tL, this.tR)
    // Level match: the direct path's speech-band power plus the surroundings.
    let acc = 0
    let ws = 0
    for (let k = 0; k < this.nGrid; k++) {
      const f = this.fGrid[k]
      const w = speechW(f) * f
      const om = (2 * Math.PI * f) / sr
      // Direct plus the ground copy: |1 + R LP e^{-jwD}|^2 (LP magnitude only).
      const lpm = this.gCoefT !== 0 ? this.gLp / Math.sqrt(1 + (1 - this.gLp) * (1 - this.gLp) - 2 * (1 - this.gLp) * Math.cos(om)) : 0
      const rr = 1 + this.gCoefT * lpm * Math.cos(om * this.gDelT)
      const ri = -this.gCoefT * lpm * Math.sin(om * this.gDelT)
      const pd = (rr * rr + ri * ri) * this.air.power(sr, f) * this.hp.power(sr, f)
      acc += w * (pd + rd * (outdoors ? 0.6 : 0.8))
      ws += w
    }
    this.dirGT = 1 / Math.sqrt(Math.max(1e-9, acc / ws))
    if (this.first) {
      this.depth = this.depthT
      this.flut = this.flutT
      this.gDel = this.gDelT
      this.gCoef = this.gCoefT
      this.dirG = this.dirGT
      this.first = false
    }
  }

  reset() {
    this.fdn.reset()
    this.dBuf.fill(0)
    this.air.reset()
    this.hp.reset()
    this.gLpS = 0
    this.depth = this.depthT
    this.flut = this.flutT
    this.gDel = this.gDelT
    this.gCoef = this.gCoefT
    this.dirG = this.dirGT
  }

  run(inL, inR, wl, wr, n, inOff = 0, outOff = 0) {
    this.fdn.run(inL, inR, wl, wr, n, inOff, outOff)
    const buf = this.dBuf
    const mask = this.dMask
    const base = this.base
    const sm = this.sm
    for (let t = 0; t < n; t++) {
      let xl = inL[inOff + t]
      let xr = inR ? inR[inOff + t] : xl
      if (!(xl > -1e9 && xl < 1e9)) xl = 0
      if (!(xr > -1e9 && xr < 1e9)) xr = 0
      buf[this.dw] = (xl + xr) * 0.5
      const w = this.dw
      this.dw = (w + 1) & mask
      this.depth += (this.depthT - this.depth) * sm
      this.flut += (this.flutT - this.flut) * sm
      this.gDel += (this.gDelT - this.gDel) * sm
      this.gCoef += (this.gCoefT - this.gCoef) * sm
      this.dirG += (this.dirGT - this.dirG) * sm
      const m = 0.65 * this.lfoA.next() + 0.35 * this.lfoB.next()
      // Direct read at the base delay, wavering.
      let D = base + this.depth * m
      let di = D | 0
      let f = D - di
      let q = w - di
      const y0 = buf[q & mask]
      const ym1 = buf[(q + 1) & mask]
      const y1 = buf[(q - 1) & mask]
      const y2 = buf[(q - 2) & mask]
      const c1 = 0.5 * (y1 - ym1)
      const c2 = ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2
      const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1)
      let s = ((c3 * f + c2) * f + c1) * f + y0
      // Ground copy, a little later (linear read is plenty for it).
      if (this.gCoef !== 0) {
        D = base + this.gDel + this.depth * m * 1.1
        di = D | 0
        f = D - di
        q = w - di
        const a = buf[q & mask]
        const b = buf[(q - 1) & mask]
        let g = a + (b - a) * f
        this.gLpS += this.gLp * (g - this.gLpS)
        if (this.gLpS < TINY && this.gLpS > -TINY) this.gLpS = 0
        s += this.gCoef * this.gLpS
      }
      s = this.hp.tick(this.air.tick(s))
      const fl = Math.pow(10, (this.flut * this.lfoC.next()) / 20)
      const dv = s * fl * this.dirG
      const o = outOff + t
      wl[o] = wl[o] * this.dirG + dv
      wr[o] = wr[o] * this.dirG + dv
    }
  }
}

function makeDistanceLive(sr, p, rng) {
  const eng = new DistanceEngine(sr, rng)
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

function distanceTail(p) {
  const outdoors = p.outdoors !== false && p.outdoors !== 'off' && p.outdoors !== 0
  const echoes = clamp(num(p.echoes, 50), 0, 100) / 100
  const d = clamp(num(p.distance, 40), 1, 1000)
  if (outdoors) return Math.min(4.5, 0.8 + 0.07 + Math.min(0.06, d / 10000) + Math.min(3, 0.7 + 0.8 * echoes + d / 1500) * 1.05)
  return 0.2 + (2.2 + 1.2 * echoes) * 1.2
}

export default {
  id: 'space.distance',
  name: 'Far away',
  family: 'space',
  about: 'Your voice from far off: across a field, down the street, or the far end of a huge hall.',
  params: [
    { id: 'distance', name: 'Distance', type: 'number', min: 1, max: 1000, step: 1, def: 40, unit: 'meters', rand: [15, 250] },
    { id: 'outdoors', name: 'Outdoors', type: 'bool', def: true },
    { id: 'wind', name: 'Wavering air', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [10, 60] },
    { id: 'echoes', name: 'Echoes from around', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
  ],
  stereo: 'make',
  tail: (p) => distanceTail(p),
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    const sr = input.sr
    const len = input.ch[0] ? input.ch[0].length : 0
    if (len === 0) return { sr, ch: [new Float32Array(0), new Float32Array(0)] }
    const inst = makeDistanceLive(sr, p, ctx && ctx.rng)
    const tailN = Math.round(distanceTail(p) * sr)
    const base = baseDelay(sr)
    const y = renderLive(inst, input, (tailN + base) / sr, ctx, 0.08)
    // Remove the direct path's fixed delay so the voice lines up with the input.
    const outLen = len + tailN
    const ch = []
    for (let c = 0; c < 2; c++) ch.push(y.ch[c].slice(base, base + outLen))
    return { sr, ch }
  },
  live: {
    latency(p, sr) {
      return baseDelay(sr || 48000)
    },
    create(sr, p, rng) {
      return makeDistanceLive(sr, p, rng)
    },
  },
}
