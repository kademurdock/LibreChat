// modules/space/gated.js - space.gated, the 1980s gated reverb: a huge,
// dense burst of room behind every word that stops dead instead of fading.
//
// Offline technique: the "non-linear" reverb programs of the early digital
// reverbs, which replaced the natural exponential tail with a burst of fixed
// length: convolution (core/conv.js) with a synthetic response made of dense
// decorrelated noise (white noise is the densest possible echo pattern) under
// an envelope that is flat, falling or rising for the gate time and then cut
// in 6 ms, with the room's first few wall reflections on its onset (their
// spacing and the burst's build-up follow the room size). Shaped by a high
// pass (230 Hz for a small room down to 100 Hz for a big one, which keeps
// its body) and a brightness low pass, level matched with core/ir.js's
// speech weighting (a 100 Hz high pass and a 700 Hz one-pole), so the burst
// carries the voice's own loudness.
//
// Live technique: the studio method the programs imitated: a dense feedback
// delay network reverb (./reverb.js) behind a noise gate keyed by the voice.
// The gate opens on each word, holds for the gate time after the voice stops
// and slams shut in a few milliseconds; the reverb's decay is set so its
// level over the hold follows the chosen shape. The key threshold follows
// the recent peak level, so loud and quiet talkers both trigger it.

import { white } from '../../core/noise.js'
import { Biquad, OnePole } from '../../core/biquad.js'
import { convolveBuf } from '../../core/conv.js'
import { makeRng } from '../../core/rng.js'
import { FdnEngine, fdnConfig, MixInstance, dryGain, wetGain } from './reverb.js'

const TINY = 1e-20

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

function weightedEnergy(sig, sr) {
  const w = new Float32Array(sig)
  new Biquad('highpass', sr, 100, 0.707).run(w)
  new OnePole(sr, 700, 'lp').run(w)
  let e = 0
  for (let i = 0; i < w.length; i++) e += w[i] * w[i]
  return e
}

/** Room size 0..1: a bigger room builds up slower and keeps more body. */
function sizeOf(p) {
  return clamp(num(p.size, 50), 0, 100) / 100
}

function bodyHz(p) {
  return 230 - 130 * sizeOf(p)
}

// A few strong early reflections (ms at size 0.5, gain, side) before the
// burst fills in: the room's first walls.
const ER = [[4.5, 0.55, -0.6], [7.7, 0.45, 0.7], [11.9, 0.38, -0.2], [16.4, 0.3, 0.5]]

function brightHz(p) {
  return 2500 * Math.pow(2, (clamp(num(p.tone, 60), 0, 100) / 100) * 2.3)
}

/** Envelope level (linear) at fraction u (0..1) of the gate for a shape. */
function shapeLevel(shape, u) {
  if (shape === 'flat') return Math.pow(10, (-3 * u) / 20)
  if (shape === 'rise') return Math.pow(10, (-20 * (1 - u)) / 20)
  return Math.pow(10, (-14 * u) / 20)
}

const CUT_MS = 6

/** The gated burst response, stereo. */
function gatedIR(sr, p, rng) {
  const gate = clamp(num(p.gate, 260), 40, 1000) / 1000
  const pre = clamp(num(p.predelay, 0), 0, 100) / 1000
  const shape = p.shape
  const n0 = Math.round(pre * sr)
  const nG = Math.max(4, Math.round(gate * sr))
  const nCut = Math.max(2, Math.round((CUT_MS / 1000) * sr))
  const z = sizeOf(p)
  const nAtt = Math.max(2, Math.round((0.002 + 0.014 * z) * sr))
  const N = n0 + nG + nCut + 1
  const r = rng && typeof rng.fork === 'function' ? rng : makeRng('gated')
  const out = []
  for (let c = 0; c < 2; c++) {
    const nz = white(nG + nCut, r.fork('burst' + c))
    const h = new Float32Array(N)
    for (let k = 0; k < nG + nCut; k++) {
      const u = Math.min(1, k / nG)
      let a = shapeLevel(shape, u)
      if (k < nAtt) a *= 0.5 - 0.5 * Math.cos((Math.PI * k) / nAtt)
      if (k >= nG) a *= 0.5 + 0.5 * Math.cos((Math.PI * (k - nG)) / nCut)
      h[n0 + k] = nz[k] * a
    }
    // The first walls, as single clicks riding on the burst's onset; a burst
    // sample has about 0.58 of RMS, so these stand a little above it.
    for (let e = 0; e < ER.length; e++) {
      const k = Math.round((ER[e][0] / 1000) * (0.5 + z) * sr)
      if (k >= nG) continue
      const side = c === 0 ? Math.sqrt(0.5 * (1 - ER[e][2])) : Math.sqrt(0.5 * (1 + ER[e][2]))
      h[n0 + k] += ER[e][1] * side * 2.2
    }
    new Biquad('highpass', sr, bodyHz(p), 0.707).run(h)
    new Biquad('lowpass', sr, Math.min(brightHz(p), 0.45 * sr), 0.6).run(h)
    // The filters ring a little past the cut; keep the stop hard.
    for (let k = n0 + nG + nCut; k < N; k++) h[k] = 0
    out.push(h)
  }
  const ref = new Float32Array(Math.round(0.25 * sr))
  ref[0] = 1
  const wr = weightedEnergy(ref, sr)
  const w = 0.5 * (weightedEnergy(out[0], sr) + weightedEnergy(out[1], sr))
  const g = w > 0 ? Math.sqrt((0.9 * wr) / w) : 0
  for (let c = 0; c < 2; c++) {
    const h = out[c]
    for (let i = 0; i < N; i++) h[i] *= g
  }
  return { sr, ch: out }
}

function gatedTailSamples(p, sr) {
  const gate = clamp(num(p.gate, 260), 40, 1000) / 1000
  const pre = clamp(num(p.predelay, 0), 0, 100) / 1000
  return Math.round(pre * sr) + Math.max(4, Math.round(gate * sr)) + Math.max(2, Math.round((CUT_MS / 1000) * sr))
}

// ---------------------------------------------------------------- live

class GatedLiveEngine {
  constructor(sr, rng) {
    this.sr = sr
    this.fdn = new FdnEngine(sr, { lines: 16, maxLineMs: 120, maxPreMs: 140, rng: rng && rng.fork ? rng.fork('gated') : rng })
    this.fdn.setTaps(0, [], [], [])
    this.cfg = fdnConfig()
    this.key = 0
    this.peak = 0
    this.hold = 0
    this.holdN = 0
    this.g = 0
    this.open = false
    this.ramp = 0
    this.rampN = 1
    this.shape = 'fall'
    this.aKey = Math.exp(-1 / (0.001 * sr))
    this.rKey = Math.exp(-1 / (0.02 * sr))
    this.rPeak = Math.exp(-1 / (3 * sr))
    this.aGate = 1 - Math.exp(-1 / (0.002 * sr))
    this.rGate = 1 - Math.exp(-1 / (0.0025 * sr))
  }

  setup(p) {
    const sr = this.sr
    const gate = clamp(num(p.gate, 260), 40, 1000) / 1000
    const shape = p.shape === 'flat' || p.shape === 'rise' ? p.shape : 'fall'
    this.shape = shape
    this.holdN = Math.round(gate * sr)
    this.rampN = Math.max(1, this.holdN)
    const c = this.cfg
    c.minDelayMs = 4 + 10 * sizeOf(p)
    c.spread = 3.1
    // Level over the hold: falling 14 dB, or nearly flat.
    c.decay = shape === 'fall' ? Math.max(0.15, (gate * 60) / 14) : Math.max(0.5, gate * 20)
    c.hiRatio = 0.8
    c.hiHz = 6000
    c.bassRatio = 1
    c.mod = 0.2
    c.modRate = 0.6
    c.predelayMs = clamp(num(p.predelay, 0), 0, 100)
    c.diffusion = 1
    c.sendHp = bodyHz(p)
    c.sendLp = Math.min(brightHz(p), 0.45 * sr)
    c.lateGain = shape === 'fall' ? 1.0 : 0.8
    c.earlyGain = 0
    c.earlyLp = 0
    c.width = 1.1
    c.freeze = 0
    this.fdn.configure(c)
  }

  reset() {
    this.fdn.reset()
    this.key = this.peak = 0
    this.hold = 0
    this.g = 0
    this.open = false
    this.ramp = 0
  }

  run(inL, inR, wl, wr, n, inOff = 0, outOff = 0) {
    this.fdn.run(inL, inR, wl, wr, n, inOff, outOff)
    const rise = this.shape === 'rise'
    for (let t = 0; t < n; t++) {
      let xl = inL[inOff + t]
      let xr = inR ? inR[inOff + t] : xl
      if (!(xl > -1e9 && xl < 1e9)) xl = 0
      if (!(xr > -1e9 && xr < 1e9)) xr = 0
      const a = Math.max(Math.abs(xl), Math.abs(xr))
      this.key = a > this.key ? a + this.aKey * (this.key - a) : a + this.rKey * (this.key - a)
      if (this.key < TINY) this.key = 0
      this.peak = this.key > this.peak ? this.key : this.peak * this.rPeak
      const thr = Math.max(0.0015, 0.12 * this.peak)
      if (this.key > thr) {
        if (!this.open) this.ramp = 0
        this.open = true
        this.hold = this.holdN
      } else if (this.hold > 0) {
        this.hold--
      } else {
        this.open = false
      }
      let target = this.open ? 1 : 0
      if (rise && this.open) {
        const u = Math.min(1, this.ramp / this.rampN)
        target = Math.pow(10, (-20 * (1 - u)) / 20)
        this.ramp++
      }
      this.g += (target - this.g) * (target > this.g ? this.aGate : this.rGate)
      if (this.g < 1e-6) this.g = 0
      wl[outOff + t] *= this.g
      wr[outOff + t] *= this.g
    }
  }
}

function makeGatedLive(sr, p, rng) {
  const eng = new GatedLiveEngine(sr, rng)
  const mix = new MixInstance(sr)
  eng.setup(p)
  mix.dryT = dryGain(p.mix)
  mix.wetT = wetGain(p.mix)
  return {
    process(ins, outs, n) {
      mix.mixBlock(ins, outs, n, eng)
    },
    set(np) {
      eng.setup(np)
      mix.dryT = dryGain(np.mix)
      mix.wetT = wetGain(np.mix)
    },
    reset() {
      eng.reset()
      mix.inited = false
    },
  }
}

export default {
  id: 'space.gated',
  name: 'Gated reverb',
  family: 'space',
  about: 'The huge 1980s drum-room sound on your voice: a big burst of room behind each word that stops dead.',
  params: [
    { id: 'gate', name: 'Gate time', type: 'number', min: 60, max: 800, step: 5, def: 260, unit: 'ms', rand: [150, 450] },
    {
      id: 'shape',
      name: 'Shape',
      type: 'choice',
      def: 'fall',
      options: [
        { v: 'fall', name: 'Gated room, dying away' },
        { v: 'flat', name: 'Flat burst' },
        { v: 'rise', name: 'Reverse swell' },
      ],
    },
    { id: 'size', name: 'Room size', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [25, 85] },
    { id: 'tone', name: 'Brightness', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [35, 85] },
    { id: 'predelay', name: 'Gap before the burst', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'ms', rand: [0, 20] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [30, 60] },
  ],
  stereo: 'make',
  tail: (p, sr) => gatedTailSamples(p, sr || 48000) / (sr || 48000),
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    const sr = input.sr
    const len = input.ch[0] ? input.ch[0].length : 0
    if (len === 0) return { sr, ch: [new Float32Array(0), new Float32Array(0)] }
    const ir = gatedIR(sr, p, ctx && ctx.rng)
    const m = clamp(num(p.mix, 45), 0, 100)
    const wet = convolveBuf(input, ir, m, { law: 'power' })
    const outLen = len + gatedTailSamples(p, sr)
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
      return makeGatedLive(sr, p, rng)
    },
  },
}
