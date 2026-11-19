// modules/synth/vocoder.js - synth.vocoder, the classic channel vocoder.
//
// Technique: Homer Dudley's channel vocoder (Bell Labs, 1939; "Remaking
// speech", JASA 11), in the form every studio vocoder since has used:
// - Analysis: the voice is split into log-spaced bands (90 Hz to 7.6 kHz) by
//   fourth-order bandpass filters (two identical RBJ-cookbook constant-peak
//   biquads in cascade; each pair is a little narrower than the band spacing,
//   which an envelope-correlation intelligibility ruler on real speech
//   preferred to touching bands), and each band's level is taken by a
//   rectifying envelope follower with an attack and a release, plus a second
//   smoothing pole set from the band's own frequency so low bands do not
//   ripple at twice their frequency.
// - Synthesis: the carrier (an instrument, a chord, noise, or The other
//   sound) goes through an identical filter bank, and each carrier band is
//   multiplied by the matching voice band level and summed, with a gentle
//   presence lift (up to +3.5 dB from 1.5 to 5 kHz) in the classic voicing.
// - Carrier flattening: each carrier band is first divided by its own slow
//   level (an 80 ms follower), so a dark saw or a bass-heavy song still lets
//   every voice band through at the voice's own level. This is the spectral
//   "whitening" of the carrier that modern vocoders use for intelligibility;
//   a floor tied to the average band level stops empty bands from being
//   pulled up out of the noise.
// - Unvoiced pass-through (the sibilance switch of hardware vocoders): an
//   unvoiced detector compares high-band and low-band energy of the voice;
//   during "s", "sh", "t" and "k" the real voice above about 4 kHz is mixed
//   in and the carrier's top bands are ducked, so consonants stay crisp
//   instead of turning into buzz.
// - A level gate silences the carrier in the pauses between words.
// - The band envelopes trail the voice by 10 to 30 ms (filter group delay and
//   follower lag), so the dry voice, the consonants and the detectors are
//   delayed to match; that delay is the live latency, and offline drops it so
//   the result lines up with the take.
// The live version is this same engine, run block by block; offline is the
// same engine run once over the whole take. The other sound is offline only
// (live falls back to the bright saw).

import { Biquad } from '../../core/biquad.js'
import { makeRng } from '../../core/rng.js'
import { bufLen } from '../../core/buf.js'
import { resampleTo } from '../../core/resample.js'

const MAX_BANDS = 64
const TINY = 1e-25
const SUBG = 16

const KEYS = [
  { v: 'c', name: 'C' }, { v: 'cs', name: 'C sharp' }, { v: 'd', name: 'D' }, { v: 'eb', name: 'E flat' },
  { v: 'e', name: 'E' }, { v: 'f', name: 'F' }, { v: 'fs', name: 'F sharp' }, { v: 'g', name: 'G' },
  { v: 'ab', name: 'A flat' }, { v: 'a', name: 'A' }, { v: 'bb', name: 'B flat' }, { v: 'b', name: 'B' },
]
const KEY_PC = {}
KEYS.forEach((k, i) => (KEY_PC[k.v] = i))

const CHORDS = {
  single: [0],
  octaves: [0, 12],
  power: [0, 7, 12],
  major: [0, 4, 7],
  minor: [0, 3, 7],
  sus: [0, 5, 7],
  seventh: [0, 4, 7, 10],
  minor7: [0, 3, 7, 10],
  stack: [-12, 0, 7, 16],
}
const REGISTER = { low: 36, middle: 48, high: 60 }

const SUPER_DETUNE = [-21, -13, -6, 0, 6, 13, 21]
const SUPER_LEVEL = [0.55, 0.7, 0.85, 1, 0.85, 0.7, 0.55]
// organ drawbars: frequency ratio and level
const ORGAN = [[0.5, 0.55], [1, 1], [1.5, 0.5], [2, 0.75], [3, 0.45], [4, 0.45], [6, 0.25], [8, 0.2]]
const TABLE = 2048

let ORGAN_TABLE = null
function organTable() {
  if (ORGAN_TABLE) return ORGAN_TABLE
  // one cycle of the 16-foot (sub-octave) period, so the 0.5 ratio fits
  const t = new Float32Array(TABLE + 1)
  let pk = 0
  for (let i = 0; i < TABLE; i++) {
    const ph = (2 * Math.PI * i) / TABLE
    let v = 0
    for (const [r, l] of ORGAN) v += l * Math.sin(ph * r * 2)
    t[i] = v
    if (Math.abs(v) > pk) pk = Math.abs(v)
  }
  for (let i = 0; i < TABLE; i++) t[i] /= pk
  t[TABLE] = t[0]
  ORGAN_TABLE = t
  return t
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

function blep(t, dt) {
  if (t < dt) {
    t /= dt
    return t + t - t * t - 1
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt
    return t * t + t + t + 1
  }
  return 0
}

function midiHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12)
}

/** Built-in carriers and The other sound, one sample at a time. */
class Carrier {
  constructor(sr, rng) {
    this.sr = sr
    this.rng = rng
    this.ph = new Float64Array(32)
    this.inc = new Float64Array(32)
    this.lvl = new Float64Array(32)
    this.vib = new Float64Array(32)
    this.vibInc = new Float64Array(32)
    for (let i = 0; i < 32; i++) {
      this.ph[i] = rng.next()
      this.vib[i] = rng.next()
      this.vibInc[i] = (4.6 + 1.2 * rng.next()) / sr
    }
    this.nOsc = 0
    this.type = 'saw'
    this.side = null
    this.sidePos = 0
    this.noise = (rng.uint32 ? rng.uint32() : 12345) >>> 0 || 1
    this.lfo = 0
    this.lfoInc = 0.37 / sr
    this.drift = 0
    this.driftTarget = 0
    this.driftCount = 0
    this.lpS1 = 0
    this.lpS2 = 0
    this.lpG = Math.tan((Math.PI * Math.min(3500, sr * 0.45)) / sr)
    this.windBp = { ic1: 0, ic2: 0 }
    this.windLp = 0
    this.windF = 700
    this.windFt = 700
    this.gust = 0.7
    this.gustT = 0.7
    this.wg = Math.tan((Math.PI * 700) / sr)
    this.wa1 = 1 / (1 + this.wg * (this.wg + 0.2))
    this.cWind = 1 - Math.exp(-1 / (0.4 * sr))
    this.cGust = 1 - Math.exp(-1 / (0.7 * sr))
    this.cWlp = 1 - Math.exp((-2 * Math.PI * 160) / sr)
    this.cDrift = 1 - Math.exp(-1 / (1.2 * sr))
    this.gain = 1
  }

  configure(type, notes, count, side) {
    this.type = type
    this.side = side || null
    const nn = count
    let k = 0
    const perNote = type === 'supersaw' ? 7 : type === 'saw' || type === 'choir' ? (type === 'choir' ? 3 : 2) : 1
    for (let a = 0; a < nn && k < 32; a++) {
      const f = midiHz(notes[a])
      for (let b = 0; b < perNote && k < 32; b++) {
        let cents = 0
        let lv = 1
        if (type === 'supersaw') {
          cents = SUPER_DETUNE[b]
          lv = SUPER_LEVEL[b]
        } else if (type === 'saw') cents = b === 0 ? -4 : 4
        else if (type === 'choir') cents = (b - 1) * 9
        this.inc[k] = (f * Math.pow(2, cents / 1200)) / this.sr
        if (type === 'organ') this.inc[k] *= 0.5 // table holds the sub-octave period
        this.lvl[k] = lv
        k++
      }
    }
    this.nOsc = k
    let sum = 0
    for (let i = 0; i < k; i++) sum += this.lvl[i] * this.lvl[i]
    this.gain = sum > 0 ? 0.45 / Math.sqrt(sum) : 1
    if (type === 'organ') this.gain *= 1.4
  }

  _white() {
    let s = this.noise
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    this.noise = s
    return s / 2147483648 - 1
  }

  next() {
    const type = this.type
    if (type === 'side') {
      const sd = this.side
      if (!sd || !sd.length) return 0
      const v = sd[this.sidePos]
      this.sidePos++
      if (this.sidePos >= sd.length) this.sidePos = 0
      return v
    }
    if (type === 'noise') return this._white() * 0.5
    if (type === 'wind') {
      if (--this.driftCount <= 0) {
        this.driftCount = (this.sr * 0.25) | 0
        this.windFt = 350 + 1100 * this.rng.next()
        this.gustT = 0.35 + 0.65 * this.rng.next()
      }
      this.windF += (this.windFt - this.windF) * this.cWind
      this.gust += (this.gustT - this.gust) * this.cGust
      const w = this._white()
      if ((this.driftCount & 31) === 0) {
        // the whistle's resonance wanders; its coefficients move every 32 samples
        const g = Math.tan((Math.PI * this.windF) / this.sr)
        this.wg = g
        this.wa1 = 1 / (1 + g * (g + 0.2))
      }
      const g = this.wg
      const a1 = this.wa1
      const st = this.windBp
      const v3 = w - st.ic2
      const v1 = a1 * st.ic1 + g * a1 * v3
      const v2 = st.ic2 + g * a1 * st.ic1 + g * g * a1 * v3
      st.ic1 = 2 * v1 - st.ic1
      st.ic2 = 2 * v2 - st.ic2
      if (st.ic1 < TINY && st.ic1 > -TINY) st.ic1 = 0
      if (st.ic2 < TINY && st.ic2 > -TINY) st.ic2 = 0
      this.windLp += (w - this.windLp) * this.cWlp
      return (v1 * 1.2 + this.windLp * 1.5 + w * 0.08) * this.gust
    }
    const n = this.nOsc
    const ph = this.ph
    const inc = this.inc
    const lvl = this.lvl
    let out = 0
    if (type === 'saw' || type === 'supersaw') {
      for (let i = 0; i < n; i++) {
        const dt = inc[i]
        let p = ph[i] + dt
        if (p >= 1) p -= 1
        ph[i] = p
        out += lvl[i] * (2 * p - 1 - blep(p, dt))
      }
      return out * this.gain
    }
    if (type === 'square' || type === 'pulse') {
      let w = 0.5
      if (type === 'pulse') {
        this.lfo += this.lfoInc
        if (this.lfo >= 1) this.lfo -= 1
        w = 0.3 + 0.15 * Math.sin(2 * Math.PI * this.lfo)
      }
      for (let i = 0; i < n; i++) {
        const dt = inc[i]
        let p = ph[i] + dt
        if (p >= 1) p -= 1
        ph[i] = p
        let q = p + w
        if (q >= 1) q -= 1
        const s1 = 2 * p - 1 - blep(p, dt)
        const s2 = 2 * q - 1 - blep(q, dt)
        out += lvl[i] * (s1 - s2 + (2 * w - 1))
      }
      return out * this.gain * 0.8
    }
    if (type === 'organ') {
      const tab = organTable()
      for (let i = 0; i < n; i++) {
        let p = ph[i] + inc[i]
        if (p >= 1) p -= 1
        ph[i] = p
        const x = p * TABLE
        const j = x | 0
        const f = x - j
        out += tab[j] + f * (tab[j + 1] - tab[j])
      }
      out *= this.gain
      return out > 1.2 ? 1.2 : out < -1.2 ? -1.2 : out - 0.08 * out * out * out
    }
    // choir pad: detuned saws with their own vibrato, a little breath, softened
    if (--this.driftCount <= 0) {
      this.driftCount = (this.sr * 0.5) | 0
      this.driftTarget = (this.rng.next() * 2 - 1) * 0.004
    }
    this.drift += (this.driftTarget - this.drift) * this.cDrift
    for (let i = 0; i < n; i++) {
      let v = this.vib[i] + this.vibInc[i]
      if (v >= 1) v -= 1
      this.vib[i] = v
      const sv = v < 0.5 ? 4 * v - 1 : 3 - 4 * v // triangle, cheap
      const dt = inc[i] * (1 + 0.007 * sv + this.drift)
      let p = ph[i] + dt
      if (p >= 1) p -= 1
      ph[i] = p
      out += lvl[i] * (2 * p - 1 - blep(p, dt))
    }
    out = out * this.gain + this._white() * 0.04
    // two one-pole lowpass steps (TPT) soften the pad
    const G = this.lpG / (1 + this.lpG)
    let v1 = (out - this.lpS1) * G
    const l1 = v1 + this.lpS1
    this.lpS1 = l1 + v1
    v1 = (l1 - this.lpS2) * G
    const l2 = v1 + this.lpS2
    this.lpS2 = l2 + v1
    if (this.lpS1 < TINY && this.lpS1 > -TINY) this.lpS1 = 0
    if (this.lpS2 < TINY && this.lpS2 > -TINY) this.lpS2 = 0
    return l2 * 1.6
  }
}

/**
 * How far (samples) the band envelopes trail the voice: band group delay plus
 * the follower's lag, fitted to the best alignment that an envelope
 * correlation ruler found on real speech (about 12 ms at 10 ms smoothing,
 * 15 at 20, 25 at 80; a little more with many narrow bands).
 */
function lagSamples(p, sr) {
  const sm = clamp(Number(p.smoothing) || 20, 2, 1000)
  const nb = clamp(Number(p.bands) || 24, 4, MAX_BANDS)
  const ms = 10.5 + 0.18 * sm + 0.1 * (nb - 24)
  return Math.max(0, Math.round((clamp(ms, 4, 80) * sr) / 1000))
}

/** Notes of the carrier chord as MIDI numbers, written into out; returns how many. */
function chordNotes(p, out) {
  const root = (REGISTER[p.register] !== undefined ? REGISTER[p.register] : 48) + (KEY_PC[p.key] || 0)
  const iv = CHORDS[p.chord] || CHORDS.single
  const n = Math.min(iv.length, out.length)
  for (let i = 0; i < n; i++) out[i] = root + iv[i]
  return n
}

class VocoderEngine {
  constructor(sr, p, rng, side) {
    this.sr = sr > 0 ? sr : 48000
    this.rng = rng || makeRng('synth.vocoder')
    this.side = side || null
    const B = MAX_BANDS
    this.b0 = new Float64Array(B)
    this.a1 = new Float64Array(B)
    this.a2 = new Float64Array(B)
    this.cs = new Float64Array(B)
    this.duck = new Float64Array(B)
    this.lift = new Float64Array(B)
    // filter states: 4 per stage, two stages, voice and carrier
    this.ms = new Float64Array(B * 8)
    this.cst = new Float64Array(B * 8)
    this.e1 = new Float64Array(B)
    this.e2 = new Float64Array(B)
    this.ce = new Float64Array(B)
    this.carrier = new Carrier(this.sr, this.rng.fork ? this.rng.fork('carrier') : this.rng)
    const nyq = this.sr * 0.45
    this.vLp = new Biquad('lowpass', this.sr, Math.min(1000, nyq), 0.707)
    this.vHp = new Biquad('highpass', this.sr, Math.min(3000, this.sr * 0.4), 0.707)
    const fb = Math.min(4200, this.sr * 0.38)
    this.bHp1 = new Biquad('highpass', this.sr, fb, 0.54)
    this.bHp2 = new Biquad('highpass', this.sr, fb, 1.31)
    this.eLo = 0
    this.eHi = 0
    this.u = 0
    this.lev = 0
    this.runPk = 1e-6
    this.gate = 0
    this.gateT = 0
    this.sub = 0
    this.carRef = 0.1
    this.mixNow = 1
    this.consNow = 0.6
    this.wetG = 1
    this.dipLeft = 0
    this.cE = 1 - Math.exp(-1 / (0.01 * this.sr))
    this.cUa = 1 - Math.exp(-1 / (0.002 * this.sr))
    this.cUr = 1 - Math.exp(-1 / (0.03 * this.sr))
    this.cLev = 1 - Math.exp(-1 / (0.02 * this.sr))
    this.cPk = Math.pow(10, -20 / 10 / (2 * this.sr / SUBG)) // power peak falls 20 dB in 2 s
    this.cGa = 1 - Math.exp(-1 / (0.003 * this.sr))
    this.cGr = 1 - Math.exp(-1 / (0.08 * this.sr))
    this.cC = 1 - Math.exp(-1 / (0.08 * this.sr))
    this.cS = 1 - Math.exp(-1 / (0.02 * this.sr))
    this.cW = 1 - Math.exp(-1 / (0.005 * this.sr))
    // the band envelopes lag the voice by a few tens of milliseconds; the dry
    // voice and the consonant pass-through are delayed to match
    let rs = 64
    while (rs < 0.1 * this.sr) rs <<= 1
    this.ringA = new Float32Array(rs)
    this.ringB = new Float32Array(rs)
    this.ringM = new Float32Array(rs)
    this.rMask = rs - 1
    this.rPos = 0
    this.lag = 0
    this.notes = new Float64Array(8)
    this.cType = ''
    this.cChord = ''
    this.cKey = ''
    this.cReg = ''
    this.p = null
    this.set(p)
    this.mixNow = this.mixT
    this.consNow = this.consT
    this.wetG = 1
    this.dipLeft = 0
  }

  set(p) {
    const old = this.p
    this.p = p
    this.mixT = clamp(Number(p.mix), 0, 100) / 100
    this.consT = clamp(Number(p.consonants), 0, 100) / 100
    let type = p.carrier
    if (type === 'side' && !(this.side && this.side.length)) type = 'saw'
    if (!old || type !== this.cType || p.chord !== this.cChord || p.key !== this.cKey || p.register !== this.cReg) {
      const nn = chordNotes(p, this.notes)
      this.carrier.configure(type, this.notes, nn, this.side)
      this.cType = type
      this.cChord = p.chord
      this.cKey = p.key
      this.cReg = p.register
      if (old) this.dipLeft = Math.round(0.012 * this.sr)
    }
    const nb = clamp(Math.round(Number(p.bands) || 24), 4, MAX_BANDS)
    const rel = clamp(Number(p.smoothing) || 20, 2, 1000)
    if (!old || nb !== this.nb) {
      this._layout(nb)
      if (old) this.dipLeft = Math.round(0.012 * this.sr)
    }
    this.nb = nb
    const att = Math.min(4, rel / 3)
    this.ca = Math.exp(-1 / (att * 0.001 * this.sr))
    this.cr = Math.exp(-1 / (rel * 0.001 * this.sr))
    this.lag = Math.min(this.rMask - 1, lagSamples(p, this.sr))
  }

  _layout(nb) {
    const sr = this.sr
    const fLo = 90
    const fHi = Math.min(7600, sr * 0.42)
    const r = Math.pow(fHi / fLo, 1 / nb)
    const qSingle = Math.sqrt(r) / (r - 1)
    const q = Math.max(0.5, qSingle * 0.642 * 1.8)
    for (let k = 0; k < nb; k++) {
      const fc = fLo * Math.pow(r, k + 0.5)
      const w0 = (2 * Math.PI * fc) / sr
      const alpha = Math.sin(w0) / (2 * q)
      const a0 = 1 + alpha
      this.b0[k] = alpha / a0
      this.a1[k] = (-2 * Math.cos(w0)) / a0
      this.a2[k] = (1 - alpha) / a0
      const tau = Math.max(1.5 / fc, 0.0015)
      this.cs[k] = 1 - Math.exp(-1 / (tau * sr))
      this.duck[k] = fc > 2500 ? 1 : fc > 1800 ? (fc - 1800) / 700 : 0
      // the classic vocoder presence lift: up to +3.5 dB from 1.5 to 5 kHz
      let t = (fc - 1500) / 3500
      t = t < 0 ? 0 : t > 1 ? 1 : t
      this.lift[k] = 1 + 0.5 * t * t * (3 - 2 * t)
    }
  }

  reset() {
    this.ms.fill(0)
    this.cst.fill(0)
    this.e1.fill(0)
    this.e2.fill(0)
    this.ce.fill(0)
    this.vLp.reset()
    this.vHp.reset()
    this.bHp1.reset()
    this.bHp2.reset()
    this.eLo = this.eHi = this.u = this.lev = 0
    this.runPk = 1e-6
    this.gate = this.gateT = 0
    this.carrier.sidePos = 0
    this.ringA.fill(0)
    this.ringB.fill(0)
    this.ringM.fill(0)
  }

  process(ins, outs, n) {
    const nin = ins.length
    const nout = outs.length
    const nb = this.nb
    const b0 = this.b0, a1 = this.a1, a2 = this.a2, cs = this.cs, duck = this.duck, lift = this.lift
    const ms = this.ms, cst = this.cst, e1 = this.e1, e2 = this.e2, ce = this.ce
    const ca = this.ca, cr = this.cr, cC = this.cC
    const car = this.carrier
    for (let i = 0; i < n; i++) {
      const xl0 = ins[0][i]
      const xr0 = nin > 1 ? ins[1][i] : xl0
      const xa = xl0 === xl0 && xl0 < 1e6 && xl0 > -1e6 ? xl0 : 0
      const xb = xr0 === xr0 && xr0 < 1e6 && xr0 > -1e6 ? xr0 : 0
      const x = nin > 1 ? 0.5 * (xa + xb) : xa
      let c = car.next()
      if (!(c > -100 && c < 100)) c = 0
      // delayed copies line the dry voice, the consonants and the detectors
      // up with the band envelopes, which lag the voice a little
      const rp = this.rPos
      this.ringA[rp] = xa
      this.ringB[rp] = xb
      this.ringM[rp] = x
      const rd = (rp - this.lag) & this.rMask
      this.rPos = (rp + 1) & this.rMask
      const xd = this.ringM[rd]
      // unvoiced detector and level gate
      const lo = this.vLp.tick(xd)
      const hi = this.vHp.tick(xd)
      this.eLo += (lo * lo - this.eLo) * this.cE
      this.eHi += (hi * hi - this.eHi) * this.cE
      this.lev += (xd * xd - this.lev) * this.cLev
      if (this.eLo < TINY) this.eLo = 0
      if (this.eHi < TINY) this.eHi = 0
      if (this.lev < TINY) this.lev = 0
      if (this.sub === 0) {
        this.runPk *= this.cPk
        if (this.lev > this.runPk) this.runPk = this.lev
        if (this.runPk < 1e-9) this.runPk = 1e-9
        const rel = this.lev > 1e-14 ? 10 * Math.log10(this.lev / this.runPk) : -140
        const abs = this.lev > 1e-14 ? 10 * Math.log10(this.lev) : -140
        let gt = (rel + 52) / 12
        gt = gt < 0 ? 0 : gt > 1 ? 1 : gt
        let ga = (abs + 80) / 10
        ga = ga < 0 ? 0 : ga > 1 ? 1 : ga
        this.gateT = gt * ga
      }
      this.sub = (this.sub + 1) % SUBG
      this.gate += (this.gateT - this.gate) * (this.gateT > this.gate ? this.cGa : this.cGr)
      const ratio = this.eHi / (this.eLo + 1e-12)
      let ut = (ratio - 0.25) / 0.95
      ut = ut < 0 ? 0 : ut > 1 ? 1 : ut
      ut *= this.gateT > 0.05 ? 1 : 0
      this.u += (ut - this.u) * (ut > this.u ? this.cUa : this.cUr)
      this.mixNow += (this.mixT - this.mixNow) * this.cS
      this.consNow += (this.consT - this.consNow) * this.cS
      // a short smooth dip hides a change of instrument or band layout
      this.wetG += ((this.dipLeft > 0 ? 0.2 : 1) - this.wetG) * this.cW
      if (this.dipLeft > 0) this.dipLeft--
      const uc = this.u * this.consNow
      const duckAmt = 0.75 * uc
      const floor = 0.03 * this.carRef + 1e-7
      let sum = 0
      let ceSum = 0
      for (let k = 0; k < nb; k++) {
        const o = k * 8
        const bk = b0[k], ak1 = a1[k], ak2 = a2[k]
        // voice, stage 1 and 2
        let y = bk * (x - ms[o + 1]) - ak1 * ms[o + 2] - ak2 * ms[o + 3]
        ms[o + 1] = ms[o]
        ms[o] = x
        ms[o + 3] = ms[o + 2]
        ms[o + 2] = y < TINY && y > -TINY ? 0 : y
        let z = bk * (y - ms[o + 5]) - ak1 * ms[o + 6] - ak2 * ms[o + 7]
        ms[o + 5] = ms[o + 4]
        ms[o + 4] = y
        ms[o + 7] = ms[o + 6]
        ms[o + 6] = z < TINY && z > -TINY ? 0 : z
        const az = z < 0 ? -z : z
        let ev = e1[k]
        ev = az > ev ? az + ca * (ev - az) : az + cr * (ev - az)
        if (ev < TINY) ev = 0
        e1[k] = ev
        let ev2 = e2[k] + (ev - e2[k]) * cs[k]
        if (ev2 < TINY) ev2 = 0
        e2[k] = ev2
        // carrier, stage 1 and 2
        y = bk * (c - cst[o + 1]) - ak1 * cst[o + 2] - ak2 * cst[o + 3]
        cst[o + 1] = cst[o]
        cst[o] = c
        cst[o + 3] = cst[o + 2]
        cst[o + 2] = y < TINY && y > -TINY ? 0 : y
        z = bk * (y - cst[o + 5]) - ak1 * cst[o + 6] - ak2 * cst[o + 7]
        cst[o + 5] = cst[o + 4]
        cst[o + 4] = y
        cst[o + 7] = cst[o + 6]
        cst[o + 6] = z < TINY && z > -TINY ? 0 : z
        const ac = z < 0 ? -z : z
        let cev = ce[k] + (ac - ce[k]) * cC
        if (cev < TINY) cev = 0
        ce[k] = cev
        ceSum += cev
        const g = ev2 / (cev > floor ? cev : floor)
        sum += z * g * lift[k] * (1 - duckAmt * duck[k])
      }
      this.carRef = ceSum / nb
      if (!(sum > -1e3 && sum < 1e3)) {
        sum = 0
        ms.fill(0)
        cst.fill(0)
      }
      const da = this.ringA[rd]
      const db = this.ringB[rd]
      // consonants: the real voice above about 4 kHz while unvoiced
      const bl = this.bHp2.tick(this.bHp1.tick(xd)) * uc * 1.3
      const wet = (sum * 1.1 * this.gate + bl) * this.wetG
      const m = this.mixNow
      for (let ch = 0; ch < nout; ch++) {
        const dry = ch === 0 ? da : nin > 1 ? db : da
        outs[ch][i] = dry + m * (wet - dry)
      }
    }
  }
}

/** The other sound as a mono Float32Array of exactly n samples at sr, or null. */
function sideSignal(ctx, n, sr) {
  const s = ctx && ctx.side
  if (!s || !s.ch || !s.ch.length || !s.ch[0] || !s.ch[0].length) return null
  let chans = s.ch
  if (s.sr && sr && s.sr !== sr) chans = chans.map((c) => resampleTo(c, s.sr, sr))
  const m = chans[0].length
  if (!m) return null
  const out = new Float32Array(n)
  const nc = chans.length
  let e = 0
  for (let i = 0; i < n; i++) {
    const j = i % m
    let v = 0
    for (let c = 0; c < nc; c++) v += chans[c][j]
    v /= nc
    if (!(v > -100 && v < 100)) v = 0
    out[i] = v
    e += v * v
  }
  return e > 1e-12 ? out : null
}

function note(ctx, text) {
  if (ctx && typeof ctx.note === 'function') ctx.note(text)
}

const BLOCK = 8192

export default {
  id: 'synth.vocoder',
  name: 'Vocoder',
  family: 'synth',
  about: 'The classic robot choir: your words played by a synth chord, an organ, a choir pad, the wind, or any other sound.',
  side: true,
  params: [
    {
      id: 'carrier', name: 'Instrument', type: 'choice', def: 'saw',
      options: [
        { v: 'saw', name: 'Bright saw' },
        { v: 'supersaw', name: 'Big detuned saws' },
        { v: 'square', name: 'Hollow square' },
        { v: 'pulse', name: 'Thin pulse' },
        { v: 'organ', name: 'Organ' },
        { v: 'choir', name: 'Choir pad' },
        { v: 'noise', name: 'Noise whisper' },
        { v: 'wind', name: 'Wind' },
        { v: 'side', name: 'The other sound' },
      ],
    },
    {
      id: 'chord', name: 'Chord', type: 'choice', def: 'minor',
      options: [
        { v: 'single', name: 'One note' },
        { v: 'octaves', name: 'Octaves' },
        { v: 'power', name: 'Power chord' },
        { v: 'major', name: 'Major chord' },
        { v: 'minor', name: 'Minor chord' },
        { v: 'sus', name: 'Suspended chord' },
        { v: 'seventh', name: 'Seventh chord' },
        { v: 'minor7', name: 'Minor seventh chord' },
        { v: 'stack', name: 'Big open chord' },
      ],
    },
    { id: 'key', name: 'Key', type: 'choice', def: 'c', options: KEYS },
    {
      id: 'register', name: 'Range', type: 'choice', def: 'middle',
      options: [{ v: 'low', name: 'Low' }, { v: 'middle', name: 'Middle' }, { v: 'high', name: 'High' }],
    },
    { id: 'bands', name: 'Bands', type: 'number', min: 8, max: 64, step: 4, def: 24, unit: 'count', noun: ['band', 'bands'], rand: [16, 40] },
    { id: 'smoothing', name: 'Smoothing', type: 'number', min: 5, max: 300, step: 5, def: 20, unit: 'ms', rand: [10, 60] },
    { id: 'consonants', name: 'Consonants', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [40, 80] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [85, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    const n = bufLen(input)
    if (!n) return input
    const sr = input.sr
    let side = null
    if (p.carrier === 'side') {
      side = sideSignal(ctx, n, sr)
      if (!side) note(ctx, 'Vocoder: no other sound was given, so it played the bright saw instead.')
    }
    const rng = ctx && ctx.rng ? ctx.rng : makeRng('synth.vocoder')
    const eng = new VocoderEngine(sr, p, rng, side)
    const lag = eng.lag
    // the other sound starts `lag` samples early so it stays in time with the take
    if (side) eng.carrier.sidePos = (n - (lag % n)) % n
    // run the live engine over the take plus `lag` samples of silence, then
    // drop the first `lag` output samples so everything lines up with the input
    const nch = input.ch.length
    const total = n + lag
    const ins = input.ch.slice(0, 2).map((x) => {
      const y = new Float32Array(total)
      y.set(x)
      return y
    })
    const tmp = ins.map(() => new Float32Array(total))
    for (let s = 0; s < total; s += BLOCK) {
      const m = Math.min(BLOCK, total - s)
      eng.process(ins.map((x) => x.subarray(s, s + m)), tmp.map((x) => x.subarray(s, s + m)), m)
      if (ctx && typeof ctx.progress === 'function') ctx.progress((s + m) / total)
      if (ctx && typeof ctx.cancelled === 'function' && ctx.cancelled()) break
    }
    const outs = []
    for (let c = 0; c < nch; c++) outs.push(tmp[Math.min(c, tmp.length - 1)].slice(lag, lag + n))
    return { sr, ch: outs }
  },
  live: {
    latency(p, sr) {
      return lagSamples(p, sr > 0 ? sr : 48000)
    },
    create(sr, p, rng) {
      return new VocoderEngine(sr, p, rng, null)
    },
  },
}

export { VocoderEngine }
