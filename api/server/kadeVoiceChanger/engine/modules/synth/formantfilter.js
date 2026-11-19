// modules/synth/formantfilter.js - synth.formantfilter, the vowel filter (talking wah, mouth harp).
//
// Technique: a parallel bank of four formant resonators, the parallel branch
// of Klatt's formant synthesiser (Klatt 1980, "Software for a cascade/parallel
// formant synthesizer", JASA 67), laid over the voice instead of over a buzz
// source. Each resonator is a topology-preserving-transform state-variable
// bandpass (Zavalishin, "The Art of VA Filter Design", in Andrew Simper's
// closed-form solution), which stays stable and click-free while its centre
// frequency moves on every sample. The four centre frequencies glide between
// vowel targets taken from Peterson and Barney 1952 ("Control methods used in
// a study of the vowels", JASA 24), interpolated on a log-frequency axis so a
// move from "oo" to "ah" sounds like a mouth opening rather than a filter
// sweep. A light pre-emphasis feeds the upper formants, and a slow level
// follower (in the manner of an automatic gain control) keeps the filtered
// voice as loud as the dry one, so sweeping vowels never collapses the level.
//
// Patterns step through vowels at the chosen speed; "Follows your loudness"
// instead opens the mouth with the voice's own level (quiet "oo", loud "ah"),
// the envelope-controlled talking wah. The live version is the same engine.

import { makeRng } from '../../core/rng.js'
import { bufLen } from '../../core/buf.js'

// Peterson and Barney 1952 averages for men (F1..F3), typical F4. Hz.
const VOWELS = {
  a: [730, 1090, 2440, 3400],
  e: [530, 1840, 2480, 3500],
  i: [270, 2290, 3010, 3700],
  o: [570, 840, 2410, 3300],
  u: [300, 870, 2240, 3200],
}
const VOWEL_KEYS = ['a', 'e', 'i', 'o', 'u']
const LOG_V = {}
for (const k of VOWEL_KEYS) LOG_V[k] = Float64Array.from(VOWELS[k], Math.log)

const PATTERNS = {
  aeiou: ['a', 'e', 'i', 'o', 'u'],
  wah: ['u', 'a'],
  wow: ['u', 'a', 'u', 'o'],
  yoy: ['i', 'o'],
  harp: ['u', 'i'],
  ai: ['a', 'i'],
  ou: ['o', 'u', 'a', 'u'],
}
const ENV_PATH = ['u', 'o', 'a']

// Formant weights (amplitude) and Q spread for F1..F4.
const F_GAIN = [1, 0.8, 0.45, 0.25]
const Q_SPREAD = [1, 1.25, 1.5, 1.7]
const SUB = 8 // samples between coefficient updates
const TINY = 1e-25

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

class FormantEngine {
  constructor(sr, p, rng) {
    this.sr = sr > 0 ? sr : 48000
    this.rng = rng || makeRng('synth.formantfilter')
    // filter state: [channel][formant]
    this.ic1 = new Float64Array(8)
    this.ic2 = new Float64Array(8)
    this.a1 = new Float64Array(4)
    this.a2 = new Float64Array(4)
    this.a3 = new Float64Array(4)
    this.kq = new Float64Array(4)
    this.F = new Float64Array(4)
    this.x1 = new Float64Array(2)
    // random vowel sequence (made once, here, never inside process)
    this.randSeq = new Uint8Array(64)
    let prev = -1
    for (let i = 0; i < 64; i++) {
      let v = this.rng.int(5)
      if (v === prev) v = (v + 1 + this.rng.int(4)) % 5
      this.randSeq[i] = v
      prev = v
    }
    this.seqKeys = new Array(8)
    this.phase = 0
    this.rateNow = 2
    this.envLevel = 0
    this.envPeak = 1e-4
    this.pIn = 0
    this.pOut = 0
    this.agc = 2.5
    this.mixNow = 1
    this.resNow = 0.6
    this.sub = 0
    this.p = null
    this.set(p)
    this.rateNow = this.p.rate
    this.mixNow = this.p.mix / 100
    this.resNow = this.p.resonance / 100
    // time constants
    const sr2 = this.sr
    this.cPow = 1 - Math.exp(-1 / (0.25 * sr2))
    this.cAgc = 1 - Math.exp(-SUB / (0.04 * sr2))
    this.cAtt = Math.exp(-1 / (0.008 * sr2))
    this.cRel = Math.exp(-1 / (0.12 * sr2))
    this.cPeak = Math.pow(10, -20 / 20 / (3 * sr2)) // peak falls 20 dB in 3 s
    this.cSmooth = 1 - Math.exp(-SUB / (0.02 * sr2))
    this._update()
  }

  set(p) {
    // copied field by field into an object made once, so set() never allocates
    if (!this.p) this.p = { pattern: 'wah', rate: 2, resonance: 60, glide: 70, mix: 100 }
    const q = this.p
    q.pattern = PATTERNS[p.pattern] || p.pattern === 'random' || p.pattern === 'envelope' ? p.pattern : 'wah'
    q.rate = clamp(Number(p.rate) || 2, 0.05, 40)
    q.resonance = clamp(Number(p.resonance) || 0, 0, 100)
    q.glide = clamp(Number(p.glide) || 0, 0, 100)
    q.mix = clamp(Number(p.mix) || 0, 0, 100)
    const pat = PATTERNS[q.pattern]
    if (pat) {
      this.seqLen = pat.length
      for (let i = 0; i < pat.length; i++) this.seqKeys[i] = pat[i]
    } else this.seqLen = 0
  }

  reset() {
    this.ic1.fill(0)
    this.ic2.fill(0)
    this.x1.fill(0)
    this.phase = 0
    this.envLevel = 0
    this.envPeak = 1e-4
    this.pIn = 0
    this.pOut = 0
    this.agc = 2.5
    this.sub = 0
  }

  _vowelAt(idx) {
    if (this.p.pattern === 'random') return LOG_V[VOWEL_KEYS[this.randSeq[idx & 63]]]
    return LOG_V[this.seqKeys[idx % this.seqLen]]
  }

  // Formant targets and filter coefficients for the current moment.
  _update() {
    const F = this.F
    let A
    let B
    let w
    if (this.p.pattern === 'envelope') {
      let rel = this.envLevel > 1e-9 ? 20 * Math.log10(this.envLevel / this.envPeak) : -120
      const pos = clamp((rel + 30) / 30, 0, 1) * 2
      const i = pos >= 2 ? 1 : Math.floor(pos)
      w = pos - i
      w = w * w * (3 - 2 * w)
      A = LOG_V[ENV_PATH[i]]
      B = LOG_V[ENV_PATH[i + 1]]
    } else {
      const ph = this.phase
      const idx = Math.floor(ph)
      const frac = ph - idx
      const g = 0.05 + 0.95 * (this.p.glide / 100)
      if (frac < 1 - g) w = 0
      else {
        const u = (frac - (1 - g)) / g
        w = u * u * (3 - 2 * u)
      }
      A = this._vowelAt(idx)
      B = this._vowelAt(idx + 1)
    }
    const r = this.resNow
    const qBase = 2.5 + 15 * Math.pow(r, 1.3)
    const nyq = this.sr * 0.45
    for (let j = 0; j < 4; j++) {
      let f = Math.exp(A[j] + w * (B[j] - A[j]))
      if (f > nyq) f = nyq
      F[j] = f
      const q = qBase * Q_SPREAD[j]
      const g = Math.tan((Math.PI * f) / this.sr)
      const k = 1 / q
      const a1 = 1 / (1 + g * (g + k))
      this.a1[j] = a1
      this.a2[j] = g * a1
      this.a3[j] = g * g * a1
      this.kq[j] = k * F_GAIN[j]
    }
  }

  process(ins, outs, n) {
    const nin = ins.length
    const nout = outs.length
    const nch = nout < 2 ? 1 : 2
    const p = this.p
    const mixT = p.mix / 100
    const resT = p.resonance / 100
    const rateT = p.rate
    const envMode = p.pattern === 'envelope'
    const ic1 = this.ic1
    const ic2 = this.ic2
    const a1 = this.a1, a2 = this.a2, a3 = this.a3, kq = this.kq
    const x1 = this.x1
    const inv = 1 / this.sr
    for (let i = 0; i < n; i++) {
      // read every input before writing any output (outs may alias ins)
      const xl = ins[0][i]
      const xr = nin > 1 ? ins[1][i] : xl
      const xa = xl === xl && xl < 1e6 && xl > -1e6 ? xl : 0
      const xb = xr === xr && xr < 1e6 && xr > -1e6 ? xr : 0
      const mono = nin > 1 ? 0.5 * (xa + xb) : xa
      if (this.sub === 0) {
        this.mixNow += (mixT - this.mixNow) * this.cSmooth
        this.resNow += (resT - this.resNow) * this.cSmooth
        this._update()
      }
      this.sub = (this.sub + 1) % SUB
      // vowel clock and loudness follower
      this.rateNow += (rateT - this.rateNow) * 0.001
      this.phase += this.rateNow * inv
      if (this.phase > 1e6) this.phase -= 1e6
      if (envMode) {
        const ax = mono < 0 ? -mono : mono
        const c = ax > this.envLevel ? this.cAtt : this.cRel
        this.envLevel = ax + c * (this.envLevel - ax)
        if (this.envLevel < TINY) this.envLevel = 0
        this.envPeak *= this.cPeak
        if (this.envLevel > this.envPeak) this.envPeak = this.envLevel
        if (this.envPeak < 1e-4) this.envPeak = 1e-4
      }
      const dryKeep = 0.15 * (1 - this.resNow)
      let sumSq = 0
      let inSq = 0
      let w0 = 0
      let w1 = 0
      for (let c = 0; c < nch; c++) {
        const x = c === 0 ? (nch === 1 ? mono : xa) : xb
        const y = x - 0.65 * x1[c]
        x1[c] = x
        let s = dryKeep * y
        const base = c * 4
        for (let j = 0; j < 4; j++) {
          const q = base + j
          const v3 = y - ic2[q]
          const v1 = a1[j] * ic1[q] + a2[j] * v3
          const v2 = ic2[q] + a2[j] * ic1[q] + a3[j] * v3
          let n1 = 2 * v1 - ic1[q]
          let n2 = 2 * v2 - ic2[q]
          if (n1 < TINY && n1 > -TINY) n1 = 0
          if (n2 < TINY && n2 > -TINY) n2 = 0
          ic1[q] = n1
          ic2[q] = n2
          s += kq[j] * v1
        }
        if (!(s > -1e4 && s < 1e4)) {
          s = 0
          for (let j = 0; j < 4; j++) {
            ic1[base + j] = 0
            ic2[base + j] = 0
          }
        }
        sumSq += s * s
        inSq += x * x
        if (c === 0) w0 = s
        else w1 = s
      }
      // level follower keeps the wet as loud as the dry
      this.pIn += (inSq - this.pIn) * this.cPow
      this.pOut += (sumSq - this.pOut) * this.cPow
      if (this.pIn < TINY) this.pIn = 0
      if (this.pOut < TINY) this.pOut = 0
      if (this.sub === 1 && this.pIn > 1e-8) {
        let tgt = Math.sqrt((this.pIn + 1e-12) / (this.pOut + 1e-12))
        tgt = clamp(tgt, 0.25, 24)
        this.agc += (tgt - this.agc) * this.cAgc
      }
      const g = this.agc
      const m = this.mixNow
      const wl = w0 * g
      const wr = nch > 1 ? w1 * g : wl
      for (let c = 0; c < nout; c++) {
        const dry = c === 0 ? xa : nin > 1 ? xb : xa
        const wet = c === 0 ? wl : nch > 1 ? wr : wl
        outs[c][i] = dry + m * (wet - dry)
      }
    }
  }
}

const BLOCK = 8192

function runOffline(Engine, input, p, ctx) {
  const n = bufLen(input)
  if (!n) return input
  const rng = ctx && ctx.rng ? ctx.rng : makeRng('synth.formantfilter')
  const nch = input.ch.length
  const outs = []
  for (let c = 0; c < nch; c++) outs.push(new Float32Array(n))
  // channels go through in pairs (a buffer normally has one or two)
  const engines = []
  for (let c = 0; c < nch; c += 2) engines.push(new Engine(input.sr, p, rng))
  for (let s = 0; s < n; s += BLOCK) {
    const m = Math.min(BLOCK, n - s)
    for (let c = 0, e = 0; c < nch; c += 2, e++) {
      const iv = input.ch.slice(c, c + 2).map((x) => x.subarray(s, s + m))
      const ov = outs.slice(c, c + 2).map((x) => x.subarray(s, s + m))
      engines[e].process(iv, ov, m)
    }
    if (ctx && typeof ctx.progress === 'function') ctx.progress((s + m) / n)
    if (ctx && typeof ctx.cancelled === 'function' && ctx.cancelled()) break
  }
  return { sr: input.sr, ch: outs }
}

export default {
  id: 'synth.formantfilter',
  name: 'Vowel filter',
  family: 'synth',
  about: 'Lays moving vowels over your voice: a talking wah, a mouth harp boing, or a vowel that opens as you get louder.',
  params: [
    {
      id: 'pattern', name: 'Vowels', type: 'choice', def: 'wah',
      options: [
        { v: 'wah', name: 'Wah wah' },
        { v: 'aeiou', name: 'A E I O U' },
        { v: 'wow', name: 'Wow wow' },
        { v: 'yoy', name: 'Yoy yoy' },
        { v: 'harp', name: 'Mouth harp boing' },
        { v: 'ai', name: 'Ah ee' },
        { v: 'ou', name: 'Oh oo ah' },
        { v: 'random', name: 'Random vowels' },
        { v: 'envelope', name: 'Follows your loudness' },
      ],
    },
    { id: 'rate', name: 'Speed', type: 'number', min: 0.2, max: 12, step: 0.1, def: 2, unit: 'hz', rand: [0.6, 5] },
    { id: 'resonance', name: 'Resonance', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [35, 85] },
    { id: 'glide', name: 'Glide', type: 'number', min: 0, max: 100, step: 1, def: 70, unit: 'percent', rand: [30, 100] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [70, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 1,
  process(input, p, ctx) {
    return runOffline(FormantEngine, input, p, ctx)
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p, rng) {
      return new FormantEngine(sr, p, rng)
    },
  },
}

export { FormantEngine }
