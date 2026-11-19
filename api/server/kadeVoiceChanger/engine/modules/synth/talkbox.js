// modules/synth/talkbox.js - synth.talkbox, a talk box: the instrument talks.
//
// A real talk box sends an instrument through a tube into the player's mouth;
// the mouth shapes it and a microphone picks it up. So the instrument carries
// the pitch and the tone, and the mouth adds only the vowel and consonant
// shapes. This module does the same thing with linear prediction, the vocal
// tract model of Atal and Hanauer 1971 ("Speech analysis and synthesis by
// linear prediction of the speech wave", JASA 50) and Makhoul 1975 ("Linear
// prediction: a tutorial review"):
// - Mouth analysis: every 5 ms a 30 ms Hann frame of the pre-emphasised voice
//   (1 - 0.95 z^-1, which removes the glottal tilt so only the tract is left)
//   gives an all-pole model of order sr/1000 + 4 by the autocorrelation method
//   and the Levinson-Durbin recursion. A Gaussian lag window on the
//   autocorrelation widens each formant to about 45 Hz and a -40 dB noise floor
//   keeps the model gentle, so the mouth never whistles.
// - Mouth movement: the model is held as reflection coefficients converted to
//   log area ratios (Viswanathan and Makhoul 1975, "Quantization properties of
//   transmission parameters in linear predictive systems"), and those glide
//   toward each new frame with an 8 ms time constant. Log area ratios move like
//   tube sections, so the formants slide like a real mouth opening and closing,
//   and the lattice filter that applies them stays stable however they move.
// - Instrument: a rich carrier (detuned saws through a resonant low-pass with
//   portamento, a pulse with slow pulse-width sweep, a plucked string by the
//   Karplus-Strong method (Karplus and Strong 1983, "Digital synthesis of
//   plucked-string and drum timbres", CMJ 7) through a fuzz and an amp and
//   cabinet voicing, drawbar organ, bass synth, an 8-bit chip pulse, or The
//   other sound). Saws and pulses are band-limited with polyBLEP (Valimaki and
//   Huovilainen 2007, "Antialiasing oscillators in subtractive synthesis").
//   The instrument is partly whitened by its own low-order prediction filter
//   with bandwidth expansion, A(z / g) as in CELP perceptual weighting, so a
//   dark guitar still lets the mouth's upper formants through; Brightness sets
//   how much.
// - Tube and mouth colour: a gentle high-pass for the driver, a broad 1 kHz
//   lift for the tube, a 7 kHz roll-off.
// - Consonants: unvoiced frames are found by the voice's mean frequency (from
//   the first difference against the level, so it does not depend on the
//   sample rate). During them the instrument ducks a little and the player's
//   breath (white noise) hisses through the same mouth shape, and, as a real
//   talk-box microphone does, the actual "s", "t" and "k" above 2.5 kHz bleed
//   in, about -12 dB at the default setting.
// - Level: the instrument follows the loudness of the voice frame by frame
//   (the prediction error power), and a slow level match keeps the result as
//   loud as the voice, whether the voice is high or low.
// - Notes: follow my voice (the tracked pitch snapped to a key and scale with
//   hysteresis, glide, and the last note held through consonants), a held
//   chord, chord changes, a funk riff, an arpeggio, or one held note, all in
//   time with Tempo.
// Offline and live are the same engine, 25 ms behind the voice (15 ms of
// analysis lookahead plus 10 ms for the mouth glide, measured as the best
// alignment); offline removes that delay. Offline tracks pitch with the core
// tracker over the whole take; live uses a small YIN (de Cheveigne and
// Kawahara 2002) on the lookahead that the mouth analysis needs anyway. The
// other sound is offline only (live falls back to the funk synth lead).

import { Biquad, SVF } from '../../core/biquad.js'
import { makeRng } from '../../core/rng.js'
import { bufLen } from '../../core/buf.js'
import { resampleTo } from '../../core/resample.js'
import { trackPitch, f0At, SCALES, snapToScale } from '../../core/pitch.js'

const TINY = 1e-25
const SUB = 16
const MAXV = 5

const KEYS = [
  { v: 'c', name: 'C' }, { v: 'cs', name: 'C sharp' }, { v: 'd', name: 'D' }, { v: 'eb', name: 'E flat' },
  { v: 'e', name: 'E' }, { v: 'f', name: 'F' }, { v: 'fs', name: 'F sharp' }, { v: 'g', name: 'G' },
  { v: 'ab', name: 'A flat' }, { v: 'a', name: 'A' }, { v: 'bb', name: 'B flat' }, { v: 'b', name: 'B' },
]
const KEY_PC = {}
KEYS.forEach((k, i) => (KEY_PC[k.v] = i))

const SCALE_OF = {
  major: 'major', minor: 'minor', dorian: 'dorian', mixolydian: 'mixolydian', majorpent: 'pentatonic',
  minorpent: 'minor-pentatonic', blues: 'blues', harmonic: 'harmonic-minor', chromatic: 'chromatic',
}

const CHORDS = {
  power: [0, 7, 12], octave: [0, 12], major: [0, 4, 7], minor: [0, 3, 7],
  seventh: [0, 4, 7, 10], minor7: [0, 3, 7, 10], ninth: [0, 4, 10, 14], sus: [0, 5, 7],
}
const BASE = { low: 31, middle: 43, high: 55 }
const SHIFT = { low: -12, middle: 0, high: 12 }

// Two bars of sixteenths: [start step, length in steps, semitones above the key note].
const RIFF_MINOR = [
  [0, 2, 0], [3, 1, 0], [4, 1, -2], [5, 1, 0], [7, 1, 3], [8, 2, 5], [10, 1, 3], [11, 1, 0], [12, 4, 7],
  [16, 2, 12], [18, 1, 10], [19, 1, 7], [22, 1, 5], [23, 1, 3], [24, 3, 0], [27, 1, -2], [28, 4, 0],
]
const RIFF_MAJOR = [
  [0, 2, 0], [3, 1, 0], [4, 1, 2], [5, 1, 4], [7, 1, 7], [8, 2, 9], [10, 1, 7], [11, 1, 4], [12, 4, 7],
  [16, 2, 12], [18, 1, 9], [19, 1, 7], [22, 1, 4], [23, 1, 2], [24, 3, 0], [27, 1, -3], [28, 4, 0],
]
// Chord changes, one chord per bar: [root semitones, quality].
const PROG_MAJOR = [[0, 'maj'], [9, 'min'], [5, 'maj'], [7, 'maj']]
const PROG_MINOR = [[0, 'min'], [8, 'maj'], [3, 'maj'], [10, 'maj']]
const PROG_DORIAN = [[0, 'min'], [5, 'maj']]

// drawbar organ: ratio, level (one table cycle holds the sub-octave period)
const ORGAN = [[0.5, 0.55], [1, 1], [1.5, 0.5], [2, 0.75], [3, 0.45], [4, 0.45], [6, 0.25], [8, 0.2]]
const TABLE = 2048
let ORGAN_TABLE = null
function organTable() {
  if (ORGAN_TABLE) return ORGAN_TABLE
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

/**
 * A second-order section whose coefficients can be redesigned without
 * allocating (RBJ cookbook lowpass, highpass and peaking EQ, Direct Form I),
 * for filters that live set() calls retune.
 */
class Bq {
  constructor(sr) {
    this.sr = sr
    this.b0 = 1
    this.b1 = 0
    this.b2 = 0
    this.a1 = 0
    this.a2 = 0
    this.x1 = 0
    this.x2 = 0
    this.y1 = 0
    this.y2 = 0
  }

  /** kind: 0 lowpass, 1 highpass, 2 peaking (gainDb). */
  design(kind, freq, q, gainDb) {
    let f = freq > 1 ? freq : 1
    if (f > this.sr * 0.49) f = this.sr * 0.49
    const w0 = (2 * Math.PI * f) / this.sr
    const cs = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * (q > 0.01 ? q : 0.01))
    let b0, b1, b2, a0, a1, a2
    if (kind === 2) {
      const A = Math.pow(10, (gainDb || 0) / 40)
      b0 = 1 + alpha * A
      b1 = -2 * cs
      b2 = 1 - alpha * A
      a0 = 1 + alpha / A
      a1 = -2 * cs
      a2 = 1 - alpha / A
    } else {
      b1 = kind === 1 ? -(1 + cs) : 1 - cs
      b0 = Math.abs(b1) / 2
      b2 = b0
      a0 = 1 + alpha
      a1 = -2 * cs
      a2 = 1 - alpha
    }
    this.b0 = b0 / a0
    this.b1 = b1 / a0
    this.b2 = b2 / a0
    this.a1 = a1 / a0
    this.a2 = a2 / a0
    return this
  }

  tick(x) {
    let y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    if (y < 1e-25 && y > -1e-25) y = 0
    if (!(y > -1e6 && y < 1e6)) y = 0
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }

  reset() {
    this.x1 = this.x2 = this.y1 = this.y2 = 0
  }
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

function hasMinorThird(steps) {
  return steps.indexOf(3) >= 0 && steps.indexOf(4) < 0
}

// ---------------------------------------------------------------- instrument

class Instrument {
  constructor(sr, rng) {
    this.sr = sr
    this.type = 'funk'
    this.side = null
    this.sidePos = 0
    this.nv = 1
    this.logf = new Float64Array(MAXV).fill(Math.log2(110))
    this.logfT = new Float64Array(MAXV).fill(Math.log2(110))
    this.ph = new Float64Array(MAXV * 3)
    for (let i = 0; i < this.ph.length; i++) this.ph[i] = rng.next()
    this.env = new Float64Array(MAXV)
    this.gateT = new Float64Array(MAXV)
    this.age = new Float64Array(MAXV)
    this.pluckIn = new Int32Array(MAXV).fill(-1)
    this.ksLen = Math.ceil(sr / 25) + 8
    this.ks = new Float32Array(MAXV * this.ksLen)
    this.ksW = new Int32Array(MAXV)
    this.ksPrev = new Float64Array(MAXV)
    this.ksExc = new Int32Array(MAXV)
    this.ksPick = new Float64Array(MAXV)
    this.noise = (rng.uint32 ? rng.uint32() : 99991) >>> 0 || 1
    this.lp1 = new SVF(sr)
    this.lp2 = new SVF(sr)
    this.fzPeak = new Bq(sr).design(2, Math.min(750, sr * 0.45), 0.8, 5)
    this.fzLp1 = new Bq(sr).design(0, Math.min(4200, sr * 0.45), 0.8, 0)
    this.fzLp2 = new Bq(sr).design(0, Math.min(5200, sr * 0.45), 0.6, 0)
    this.fzHp = new Bq(sr).design(1, 90, 0.7, 0)
    this.fenv = 0
    this.pwm = rng.next()
    this.vib = 0
    this.bright = 0.5
    this.drive = 0.2
    this.cGlide = 1
    this.cAtt = 1 - Math.exp(-1 / (0.003 * sr))
    this.cRel = 1 - Math.exp(-1 / (0.03 * sr))
    this.cFenv = Math.exp(-1 / (0.12 * sr))
    this.nyq = sr * 0.45
  }

  configure(type, bright, drive, glideMs, side) {
    if (type !== this.type) {
      this.ks.fill(0)
      this.lp1.reset()
      this.lp2.reset()
    }
    this.type = type
    this.side = side || null
    this.bright = bright
    this.drive = drive
    this.cGlide = glideMs > 0.5 ? 1 - Math.exp(-1 / (glideMs * 0.001 * this.sr)) : 1
    const cab = Math.min(4200 * Math.pow(2, bright - 0.5), this.nyq)
    this.fzLp1.design(0, cab, 0.8, 0)
    this.fzLp2.design(0, Math.min(cab * 1.25, this.nyq), 0.6, 0)
  }

  /** Set a voice's note. retrig plucks the string and restarts envelopes. */
  note(v, midi, retrig, delaySamples) {
    if (v >= MAXV) return
    const lf = Math.log2(midiHz(midi))
    this.logfT[v] = lf
    if (this.gateT[v] < 0.5 || this.env[v] < 0.01) this.logf[v] = lf // no slide from silence
    this.gateT[v] = 1
    if (retrig) {
      this.age[v] = 0
      this.fenv = 1
      this.pluckIn[v] = delaySamples > 0 ? delaySamples : 0
    }
  }

  off(v) {
    if (v < MAXV) this.gateT[v] = 0
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
    const sr = this.sr
    const nv = this.nv
    const ph = this.ph
    let sum = 0
    this.vib += 5.5 / sr
    if (this.vib >= 1) this.vib -= 1
    const vibS = this.vib < 0.5 ? 4 * this.vib - 1 : 3 - 4 * this.vib
    this.pwm += 0.23 / sr
    if (this.pwm >= 1) this.pwm -= 1
    for (let v = 0; v < nv; v++) {
      // glide in log frequency
      this.logf[v] += (this.logfT[v] - this.logf[v]) * this.cGlide
      const g = this.gateT[v]
      this.env[v] += (g - this.env[v]) * (g > this.env[v] ? this.cAtt : this.cRel)
      if (this.env[v] < 1e-6 && g === 0) {
        this.env[v] = 0
        if (type !== 'fuzz') continue
      }
      this.age[v] += 1
      // delayed vibrato on held notes (leads and chip)
      let vibAmt = 0
      if (type === 'funk' || type === 'square') vibAmt = this.age[v] > 0.35 * sr ? 0.0045 : 0
      else if (type === 'chip') vibAmt = this.age[v] > 0.2 * sr ? 0.017 : 0
      const f = Math.pow(2, this.logf[v] + vibAmt * vibS)
      const dt = f / sr
      const o = v * 3
      let s = 0
      if (type === 'funk') {
        const d1 = dt * 0.99654
        const d2 = dt * 1.00347
        const d3 = dt * 0.5
        let p = ph[o] + d1
        if (p >= 1) p -= 1
        ph[o] = p
        s += 2 * p - 1 - blep(p, d1)
        p = ph[o + 1] + d2
        if (p >= 1) p -= 1
        ph[o + 1] = p
        s += 2 * p - 1 - blep(p, d2)
        p = ph[o + 2] + d3
        if (p >= 1) p -= 1
        ph[o + 2] = p
        s += 0.5 * (2 * p - 1 - blep(p, d3))
        s *= 0.4
      } else if (type === 'square' || type === 'bass') {
        const w = type === 'square' ? 0.5 + 0.36 * Math.sin(2 * Math.PI * (this.pwm + v * 0.21)) : 0.5
        let p = ph[o] + dt
        if (p >= 1) p -= 1
        ph[o] = p
        if (type === 'square') {
          let q = p + w
          if (q >= 1) q -= 1
          s = (2 * p - 1 - blep(p, dt)) - (2 * q - 1 - blep(q, dt)) + (2 * w - 1)
          s *= 0.5
        } else {
          // bass: saw plus a square an octave down
          s = 2 * p - 1 - blep(p, dt)
          const d2 = dt * 0.5
          let p2 = ph[o + 1] + d2
          if (p2 >= 1) p2 -= 1
          ph[o + 1] = p2
          let q = p2 + 0.5
          if (q >= 1) q -= 1
          s += 0.7 * ((2 * p2 - 1 - blep(p2, d2)) - (2 * q - 1 - blep(q, d2)))
          s *= 0.45
        }
      } else if (type === 'organ') {
        const tab = organTable()
        let p = ph[o] + dt * 0.5
        if (p >= 1) p -= 1
        ph[o] = p
        const x = p * TABLE
        const j = x | 0
        s = (tab[j] + (x - j) * (tab[j + 1] - tab[j])) * 0.6
      } else if (type === 'chip') {
        let p = ph[o] + dt
        if (p >= 1) p -= 1
        ph[o] = p
        s = (p < 0.25 ? 1.5 : -0.5) * 0.45
      } else {
        // fuzz guitar: a plucked string, Karplus-Strong
        const L = this.ksLen
        const base = v * L
        if (this.pluckIn[v] >= 0) {
          if (this.pluckIn[v] === 0) {
            this.ksExc[v] = Math.min(L - 4, Math.round(sr / f))
            this.ksPick[v] = 0
          }
          this.pluckIn[v]--
        }
        let d = sr / f - 0.5
        if (d < 2) d = 2
        if (d > L - 3) d = L - 3
        const w = this.ksW[v]
        const di = d | 0
        const fr = d - di
        const r0 = this.ks[base + ((w - di + L) % L)]
        const r1 = this.ks[base + ((w - di - 1 + L + L) % L)]
        const y = r0 + fr * (r1 - r0)
        const filt = 0.5 * (y + this.ksPrev[v])
        this.ksPrev[v] = y
        const loss = Math.pow(10, -2.5 / 20 / f) // about 2.5 dB of decay per second
        let inj = 0
        if (this.ksExc[v] > 0) {
          // pick: noise softened by a one-pole, so the attack is not a hiss
          const wn = this._white()
          this.ksPick[v] += (wn - this.ksPick[v]) * 0.45
          inj = this.ksPick[v] * 0.9
          this.ksExc[v]--
        }
        let nw = filt * loss + inj
        if (nw < TINY && nw > -TINY) nw = 0
        if (!(nw > -10 && nw < 10)) nw = 0
        this.ks[base + w] = nw
        this.ksW[v] = (w + 1) % L
        s = filt * (0.35 + 0.65 * this.env[v])
      }
      sum += s * (type === 'fuzz' ? 1 : this.env[v])
    }
    sum *= 1 / Math.sqrt(nv)
    // voicing per instrument
    const b = this.bright
    if (type === 'funk' || type === 'bass' || type === 'square') {
      this.fenv *= this.cFenv
      let fc
      let q
      if (type === 'funk') {
        fc = 600 * Math.pow(2, 4.2 * b) * (1 + 0.9 * this.fenv)
        q = 1.1
      } else if (type === 'bass') {
        fc = 320 * Math.pow(2, 3.6 * b) * (1 + 2 * this.fenv)
        q = 1.4
      } else {
        fc = 1100 * Math.pow(2, 3 * b)
        q = 0.75
      }
      if (fc > this.nyq) fc = this.nyq
      sum = this.lp1.tick(sum, fc, q).lp
      if (type !== 'square') sum = this.lp2.tick(sum, fc * 1.5 > this.nyq ? this.nyq : fc * 1.5, 0.6).lp
    } else if (type === 'fuzz') {
      // fuzz pedal, then amp mids and a closed-back cabinet
      const g = 9 + 40 * this.drive
      let x = sum * g
      x = Math.tanh(x + 0.18) - 0.17808 // asymmetric, offset removed (tanh 0.18)
      x = this.fzPeak.tick(x)
      x = this.fzLp1.tick(x)
      x = this.fzLp2.tick(x)
      x = this.fzHp.tick(x)
      return x * 0.5
    } else if (type === 'chip') {
      // 4-bit volume steps
      sum = Math.round(sum * 7) / 7
      return sum
    }
    // overdrive
    const k = 0.5 + 6 * this.drive
    const tk = Math.tanh(k)
    return Math.tanh(k * sum) / tk
  }
}

// ---------------------------------------------------------------- engine

class TalkboxEngine {
  /**
   * opts: { track: core pitch track for offline follow mode (or null),
   *         side: Float32Array of The other sound at sr (or null),
   *         clock: first carrier sample index (offline uses -latency) }
   */
  constructor(sr, p, rng, opts = {}) {
    this.sr = sr > 0 ? sr : 48000
    sr = this.sr
    this.rng = rng || makeRng('synth.talkbox')
    this.track = opts.track || null
    this.side = opts.side || null
    const P = clamp(Math.round(sr / 1000) + 4, 10, 72)
    this.P = P
    this.D = Math.round(0.015 * sr)
    // the output runs a further 10 ms behind the analysis centre, because the
    // mouth glides toward each new frame with an 8 ms time constant
    this.A = Math.round(0.01 * sr)
    this.L = this.D + this.A
    this.W = 2 * this.D
    this.H = Math.max(8, Math.round(0.005 * sr))
    let R = 64
    while (R < this.W + this.A + this.H + 16) R <<= 1
    this.R = R
    this.mask = R - 1
    this.ringX = new Float32Array(R)
    this.ringA = new Float32Array(R)
    this.ringB = new Float32Array(R)
    this.ringC = new Float32Array(R)
    this.pos = 0
    this.hopCount = 0
    this.sub = 0
    this.tIn = 0
    // analysis work
    const W = this.W
    this.win = new Float64Array(W)
    let w2 = 0
    for (let i = 0; i < W; i++) {
      this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / W)
      w2 += this.win[i] * this.win[i]
    }
    this.w2 = w2
    this.frame = new Float64Array(W)
    this.r = new Float64Array(P + 1)
    this.lagWin = new Float64Array(P + 1)
    const bw = 45 // Hz, Gaussian lag window
    for (let l = 0; l <= P; l++) {
      const a = (2 * Math.PI * bw * l) / sr
      this.lagWin[l] = Math.exp(-0.5 * a * a)
    }
    this.la = new Float64Array(P + 1)
    this.lt = new Float64Array(P + 1)
    this.kk = new Float64Array(P + 1)
    this.larT = new Float64Array(P + 1)
    this.larC = new Float64Array(P + 1)
    this.kC = new Float64Array(P + 1)
    this.bst = new Float64Array(P + 1)
    this.lgT = -20
    this.lgC = -20
    this.gC = 0
    // carrier whitening (order 8)
    const PC = 8
    this.PC = PC
    this.rc = new Float64Array(PC + 1)
    this.ac = new Float64Array(PC + 1)
    this.at = new Float64Array(PC + 1)
    this.acT = new Float64Array(PC + 1)
    this.acC = new Float64Array(PC + 1)
    this.cHist = new Float64Array(PC + 1)
    this.gnT = 1
    this.gnC = 1
    this.carPow = 0.25
    // detectors
    this.uT = 0
    this.uC = 0
    this.levT = 0
    this.levA = 0
    this.uA = 0
    this.gate = 0
    this.runPk = -100
    // pitch (live follow): decimated, low-passed copy
    this.Dd = Math.max(1, Math.floor(sr / 12000))
    this.srd = sr / this.Dd
    this.tauMax = Math.ceil(this.srd / 70)
    this.tauMin = Math.max(2, Math.floor(this.srd / 650))
    this.Wy = this.tauMax
    let RP = 64
    while (RP < 2 * (this.Wy + this.tauMax) + 8) RP <<= 1
    this.ringP = new Float32Array(RP)
    this.pMask = RP - 1
    this.pPos = 0
    this.pDec = 0
    this.pLp1 = new Biquad('lowpass', sr, 1000, 0.54)
    this.pLp2 = new Biquad('lowpass', sr, 1000, 1.31)
    this.yinD = new Float64Array(this.tauMax + 2)
    this.yinBuf = new Float64Array(this.Wy + this.tauMax + 2)
    this.pHist = new Float64Array(3)
    this.pHop = 0
    this.f0Live = 0
    // follow-note state
    this.curNote = -1
    this.pend = -1
    this.pendN = 0
    this.unvHops = 1000
    // tempo clock and the worked-out chords
    this.clock = Number.isFinite(opts.clock) ? opts.clock : 0
    this.stepPos = 0
    this.step = -1
    this.noteEnd = -1
    this.progIv = new Int32Array(4 * MAXV)
    this.progLen = new Int32Array(4)
    this.progN = 1
    this.arpT = new Int32Array(8)
    this.arpN = 1
    // colour and bleed
    const nyq = sr * 0.45
    this.tHp = new Biquad('highpass', sr, 110, 0.707)
    this.tPk = new Biquad('peak', sr, Math.min(1000, nyq), 0.7, 3)
    this.tLp = new Biquad('lowpass', sr, Math.min(7000, nyq), 0.6)
    const fb = Math.min(2500, sr * 0.38)
    this.bHp1 = new Biquad('highpass', sr, fb, 0.54)
    this.bHp2 = new Biquad('highpass', sr, fb, 1.31)
    this.inst = new Instrument(sr, this.rng.fork ? this.rng.fork('instrument') : this.rng)
    this.nz = (this.rng.uint32 ? this.rng.uint32() : 777) >>> 0 || 1
    // smoothing constants
    this.aLar = 1 - Math.exp(-SUB / (0.008 * sr))
    this.aGu = 1 - Math.exp(-SUB / (0.003 * sr))
    this.aGd = 1 - Math.exp(-SUB / (0.012 * sr))
    this.aAc = 1 - Math.exp(-SUB / (0.01 * sr))
    this.cGa = 1 - Math.exp(-1 / (0.003 * sr))
    this.cGr = 1 - Math.exp(-1 / (0.05 * sr))
    this.cU = 1 - Math.exp(-1 / (0.006 * sr))
    this.cCar = 1 - Math.exp(-1 / (0.4 * sr))
    this.cS = 1 - Math.exp(-1 / (0.02 * sr))
    this.cAgc = 1 - Math.exp(-1 / (0.4 * sr))
    this.aAgc = 1 - Math.exp(-SUB / (0.5 * sr))
    this.pIn = 0
    this.pOut = 0
    this.agc = 2.2
    this.p = null
    this.set(p)
    this.mixC = this.mixT
    this.consC = this.consT
  }

  set(p) {
    const old = this.p
    this.p = p
    this.mixT = clamp(Number(p.mix), 0, 100) / 100
    this.consT = clamp(Number(p.consonants), 0, 100) / 100
    const bright = clamp(Number(p.brightness), 0, 100) / 100
    this.gamma = 0.92 * bright
    let type = p.instrument
    if (type === 'side' && !(this.side && this.side.length)) type = 'funk'
    this.instType = type
    this.inst.configure(type, bright, clamp(Number(p.drive), 0, 100) / 100, clamp(Number(p.glide), 0, 2000), this.side)
    this.keyPc = KEY_PC[p.key] !== undefined ? KEY_PC[p.key] : 9
    this.steps = SCALES[SCALE_OF[p.scale]] || SCALES.chromatic
    this.minorish = hasMinorThird(this.steps) || p.scale === 'chromatic'
    const base = BASE[p.register] !== undefined ? BASE[p.register] : 43
    this.root = base + ((this.keyPc - (base % 12) + 12) % 12) + (type === 'bass' ? -12 : 0)
    this.shift = (SHIFT[p.register] || 0) + (type === 'bass' ? -12 : 0)
    // riffs and arpeggios sit where a singer would: the key note from D3 up to C sharp 4
    this.melRoot = 50 + ((this.keyPc - 2 + 12) % 12) + this.shift
    this.tempo = clamp(Number(p.tempo) || 100, 20, 400)
    this.stepLen = (this.sr * 60) / this.tempo / 4
    this.chordIv = CHORDS[p.chord] || CHORDS.minor7
    const modeChanged = !old || old.notes !== p.notes || old.chord !== p.chord || old.key !== p.key || old.scale !== p.scale || old.register !== p.register || old.instrument !== p.instrument
    this.mode = p.notes
    this._prepareChords()
    if (modeChanged) {
      for (let v = 0; v < MAXV; v++) this.inst.off(v)
      this.curNote = -1
      this.step = -1
      this.stepPos = 0
      this._startMode()
    }
  }

  reset() {
    this.ringX.fill(0)
    this.ringA.fill(0)
    this.ringB.fill(0)
    this.ringC.fill(0)
    this.ringP.fill(0)
    this.bst.fill(0)
    this.cHist.fill(0)
    this.lgC = this.lgT = -20
    this.gate = 0
    this.uC = this.uT = this.uA = 0
    this.pIn = this.pOut = 0
    this.agc = 2.2
    this.levT = this.levA = 0
    this.runPk = -100
    this.tHp.reset()
    this.tPk.reset()
    this.tLp.reset()
    this.bHp1.reset()
    this.bHp2.reset()
    this.inst.ks.fill(0)
    this.inst.sidePos = 0
    this.clock = 0
    this.step = -1
    this.stepPos = 0
    this.curNote = -1
    this._startMode()
  }

  // -------------------------------------------------------------- notes

  // Chord changes and the arpeggio, worked out into fixed arrays so that
  // neither set() nor the audio loop ever allocates.
  _prepareChords() {
    const fl = this.p.chord
    const prog = this.p.scale === 'dorian' ? PROG_DORIAN : this.minorish ? PROG_MINOR : PROG_MAJOR
    this.progN = prog.length
    for (let b = 0; b < prog.length; b++) {
      const r = prog[b][0]
      const q = prog[b][1]
      let iv
      if (fl === 'power') iv = CHORDS.power
      else if (fl === 'octave') iv = CHORDS.octave
      else if (fl === 'sus') iv = CHORDS.sus
      else if (fl === 'seventh' || fl === 'minor7' || fl === 'ninth') iv = q === 'min' ? CHORDS.minor7 : CHORDS.seventh
      else iv = q === 'min' ? CHORDS.minor : CHORDS.major
      const off = r > 6 ? r - 12 : r
      const n = Math.min(MAXV, iv.length)
      this.progLen[b] = n
      for (let v = 0; v < n; v++) this.progIv[b * MAXV + v] = iv[v] + off
    }
    // arpeggio: the chord tones (already rising) and the octave, up then down
    const iv = this.chordIv
    let k = 0
    for (let i = 0; i < iv.length && k < 7; i++) this.arpT[k++] = iv[i]
    if (this.arpT[k - 1] < iv[0] + 12) this.arpT[k++] = iv[0] + 12
    this.arpN = k
  }

  _playChord(buf, off, n, retrig) {
    const inst = this.inst
    inst.nv = n
    const strum = Math.round(0.012 * this.sr)
    for (let v = 0; v < MAXV; v++) {
      if (v < n) inst.note(v, this.root + buf[off + v], retrig, retrig ? v * strum : 0)
      else inst.off(v)
    }
  }

  _playBar(bar, retrig) {
    if (this.mode === 'changes') {
      const b = bar % this.progN
      this._playChord(this.progIv, b * MAXV, this.progLen[b], retrig)
    } else this._playChord(this.chordIv, 0, Math.min(MAXV, this.chordIv.length), retrig)
  }

  _startMode() {
    const inst = this.inst
    const m = this.mode
    if (m === 'held') {
      inst.nv = 1
      inst.note(0, this.root, true, 0)
    } else if (m === 'chord' || m === 'changes') {
      this._playBar(0, true)
    } else if (m === 'follow') {
      inst.nv = 1
      inst.note(0, this.melRoot, true, 0)
    } else {
      inst.nv = 1
    }
  }

  // Called once per sixteenth step for the tempo modes.
  _onStep(step) {
    const m = this.mode
    const inst = this.inst
    const fuzz = this.instType === 'fuzz'
    if (m === 'held') {
      if (fuzz && step % 8 === 0) inst.note(0, this.root, true, 0)
    } else if (m === 'chord') {
      if (fuzz && step % 8 === 0) this._playBar(0, true)
    } else if (m === 'changes') {
      if (step % 16 === 0 || (fuzz && step % 8 === 0)) this._playBar(Math.floor(step / 16), true)
    } else if (m === 'riff') {
      const riff = this.minorish ? RIFF_MINOR : RIFF_MAJOR
      const s = step % 32
      let hit = -1
      for (let i = 0; i < riff.length; i++) if (riff[i][0] === s) hit = i
      if (hit >= 0) {
        const midi = snapToScale(this.melRoot + riff[hit][2], this.steps, this.keyPc)
        inst.note(0, midi, true, 0)
        this.noteEnd = step + riff[hit][1]
      } else if (this.noteEnd >= 0 && step >= this.noteEnd) inst.off(0)
    } else if (m === 'arp') {
      if (step % 2 === 0) {
        const n = this.arpN
        const seqLen = n > 1 ? n * 2 - 2 : 1
        const k = (step / 2) % seqLen
        const idx = k < n ? k : seqLen - k
        inst.note(0, this.melRoot + this.arpT[idx], true, 0)
      }
    }
  }

  // Follow my voice: called every hop with the pitch at the output time.
  _follow(f0) {
    const inst = this.inst
    if (f0 > 0) {
      const midi = 69 + 12 * Math.log2(f0 / 440) + this.shift
      const cand = snapToScale(midi, this.steps, this.keyPc)
      const onset = this.unvHops > 12 || this.curNote < 0
      if (onset) {
        this.curNote = cand
        inst.note(0, cand, true, 0)
        this.pendN = 0
      } else if (cand !== this.curNote) {
        if (Math.abs(midi - this.curNote) > 0.85) {
          if (cand === this.pend) this.pendN++
          else {
            this.pend = cand
            this.pendN = 1
          }
          if (this.pendN >= 3) {
            this.curNote = cand
            inst.note(0, cand, this.instType === 'fuzz', 0)
            this.pendN = 0
          }
        } else this.pendN = 0
      } else this.pendN = 0
      this.unvHops = 0
    } else this.unvHops++
  }

  // -------------------------------------------------------------- analysis

  _levinson(r, P, a, tmp, k) {
    a.fill(0)
    a[0] = 1
    let err = r[0]
    if (!(err > 1e-20)) return 0
    for (let i = 1; i <= P; i++) {
      let acc = r[i]
      for (let j = 1; j < i; j++) acc += a[j] * r[i - j]
      let ki = -acc / err
      if (!(ki > -0.9995 && ki < 0.9995)) {
        for (let q = i; q <= P; q++) k[q] = 0
        break
      }
      k[i] = ki
      for (let j = 0; j < i; j++) tmp[j] = a[j]
      for (let j = 1; j < i; j++) a[j] = tmp[j] + ki * tmp[i - j]
      a[i] = ki
      err *= 1 - ki * ki
    }
    return err > 0 ? err : 0
  }

  _analyse() {
    const W = this.W
    const P = this.P
    const mask = this.mask
    const ring = this.ringX
    const fr = this.frame
    const win = this.win
    const start = this.pos - W + 1
    let prev = ring[(start - 1) & mask]
    let r0 = 0
    let d0 = 0
    for (let i = 0; i < W; i++) {
      const v = ring[(start + i) & mask]
      r0 += v * v
      const dv = v - prev
      d0 += dv * dv
      fr[i] = (v - 0.95 * prev) * win[i]
      prev = v
    }
    const r = this.r
    for (let l = 0; l <= P; l++) {
      let s = 0
      for (let i = l; i < W; i++) s += fr[i] * fr[i - l]
      r[l] = s * this.lagWin[l]
    }
    r[0] *= 1.0001
    const lvl = r0 / W
    const lvlDb = lvl > 1e-14 ? 10 * Math.log10(lvl) : -140
    // gate from level, relative to a slowly falling running peak
    this.runPk -= 10 * (this.H / this.sr)
    if (lvlDb > this.runPk) this.runPk = lvlDb
    let g1 = (lvlDb - (this.runPk - 48)) / 12
    g1 = g1 < 0 ? 0 : g1 > 1 ? 1 : g1
    let g2 = (lvlDb + 75) / 10
    g2 = g2 < 0 ? 0 : g2 > 1 ? 1 : g2
    // the targets from the previous hop are the ones applied now: one hop of
    // delay lines the level gate and the consonant gate up with the output,
    // which runs 10 ms behind the analysis centre
    this.levA = this.levT
    this.uA = this.uT
    this.levT = g1 * g2
    // unvoiced: mean frequency from the first difference, independent of rate
    const fMean = r0 > 1e-14 ? (this.sr / (2 * Math.PI)) * Math.sqrt(d0 / r0) : 0
    let u = (fMean - 1500) / 1300
    u = u < 0 ? 0 : u > 1 ? 1 : u
    this.uT = u * (this.levT > 0.3 ? 1 : 0)
    if (r[0] > 1e-12) {
      const err = this._levinson(r, P, this.la, this.lt, this.kk)
      for (let i = 1; i <= P; i++) {
        const k = this.kk[i]
        this.larT[i] = Math.log((1 + k) / (1 - k))
      }
      const G = Math.sqrt(err / this.w2)
      this.lgT = Math.log(G + 1e-9)
    } else {
      this.lgT = -20.7
    }
  }

  _analyseCarrier() {
    const W = this.W
    const PC = this.PC
    const mask = this.mask
    const ring = this.ringC
    const fr = this.frame
    const win = this.win
    const start = this.pos - W + 1
    for (let i = 0; i < W; i++) fr[i] = ring[(start + i) & mask] * win[i]
    const rc = this.rc
    for (let l = 0; l <= PC; l++) {
      let s = 0
      for (let i = l; i < W; i++) s += fr[i] * fr[i - l]
      rc[l] = s
    }
    const g = this.gamma
    if (!(rc[0] > 1e-10) || g <= 0.001) {
      this.acT.fill(0)
      this.acT[0] = 1
      this.gnT = 1
      return
    }
    rc[0] *= 1.001
    this._levinson(rc, PC, this.ac, this.at, this.kk)
    let gp = 1
    for (let i = 0; i <= PC; i++) {
      this.acT[i] = this.ac[i] * gp
      gp *= g
    }
    let q = 0
    for (let i = 0; i <= PC; i++) {
      for (let j = 0; j <= PC; j++) {
        const l = i > j ? i - j : j - i
        q += this.acT[i] * this.acT[j] * rc[l]
      }
    }
    this.gnT = q > 1e-20 ? clamp(Math.sqrt(rc[0] / q), 0.05, 20) : 1
  }

  _yin() {
    // window centred on the output time, from the decimated ring
    const Wy = this.Wy
    const T = this.tauMax
    const N = Wy + T
    const buf = this.yinBuf
    const centreLagD = Math.round(this.D / this.Dd)
    const end = this.pPos - 1 - (centreLagD - (N >> 1)) // newest sample used
    let e = 0
    for (let i = 0; i < N; i++) {
      const v = this.ringP[(end - N + 1 + i) & this.pMask]
      buf[i] = v
      e += v * v
    }
    if (!(e > 1e-9 * N) || this.levT < 0.2) return 0
    const d = this.yinD
    let run = 0
    let best = -1
    let bestV = 1
    let prevN = 1
    let found = -1
    for (let tau = 1; tau <= T; tau++) {
      let s = 0
      for (let j = 0; j < Wy; j++) {
        const df = buf[j] - buf[j + tau]
        s += df * df
      }
      run += s
      const dn = run > 0 ? (s * tau) / run : 1
      d[tau] = dn
      if (tau >= this.tauMin) {
        if (dn < bestV) {
          bestV = dn
          best = tau
        }
        if (found < 0 && prevN < 0.2 && dn > prevN) found = tau - 1
      }
      prevN = dn
    }
    let t = found > 0 ? found : bestV < 0.3 ? best : -1
    if (t < 1 || t >= T) return 0
    const a = d[t - 1], b = d[t], c = d[t + 1]
    const den = a - 2 * b + c
    let off = den > 0 ? (0.5 * (a - c)) / den : 0
    if (off > 1) off = 1
    else if (off < -1) off = -1
    return this.srd / (t + off)
  }

  // -------------------------------------------------------------- audio

  process(ins, outs, n) {
    const nin = ins.length
    const nout = outs.length
    const P = this.P
    const PC = this.PC
    const mask = this.mask
    const D = this.D
    const L = this.L
    const kC = this.kC
    const bst = this.bst
    const acC = this.acC
    const cHist = this.cHist
    const inst = this.inst
    const follow = this.mode === 'follow'
    const tempoMode = !follow
    for (let i = 0; i < n; i++) {
      const xl0 = ins[0][i]
      const xr0 = nin > 1 ? ins[1][i] : xl0
      const xa = xl0 === xl0 && xl0 < 1e6 && xl0 > -1e6 ? xl0 : 0
      const xb = xr0 === xr0 && xr0 < 1e6 && xr0 > -1e6 ? xr0 : 0
      const x = nin > 1 ? 0.5 * (xa + xb) : xa
      const pos = (this.pos + 1) & mask
      this.pos = pos
      this.ringX[pos] = x
      this.ringA[pos] = xa
      this.ringB[pos] = xb
      // pitch copy (live follow only)
      if (follow && !this.track) {
        const lp = this.pLp2.tick(this.pLp1.tick(x))
        if (++this.pDec >= this.Dd) {
          this.pDec = 0
          this.ringP[this.pPos] = lp
          this.pPos = (this.pPos + 1) & this.pMask
        }
      }
      this.tIn++
      // tempo clock at the output time
      if (tempoMode) {
        const c = this.clock
        if (c >= 0) {
          const st = Math.floor(c / this.stepLen)
          if (st !== this.step) {
            this.step = st
            this._onStep(st)
          }
        }
      }
      this.clock++
      // a hop: analyse the newest window, centred on the output time
      if (++this.hopCount >= this.H) {
        this.hopCount = 0
        this._analyse()
        this._analyseCarrier()
        if (follow) {
          let f0 = 0
          const mOut = this.tIn - 1 - D
          if (this.track) f0 = mOut >= 0 ? f0At(this.track, mOut) : 0
          else {
            this.pHop ^= 1
            if (this.pHop) {
              let f = this._yin()
              // median of three against octave slips
              this.pHist[2] = this.pHist[1]
              this.pHist[1] = this.pHist[0]
              this.pHist[0] = f
              const a = this.pHist[0], b = this.pHist[1], c = this.pHist[2]
              if (a > 0 && b > 0 && c > 0) f = a > b ? (b > c ? b : a > c ? c : a) : a > c ? a : b > c ? c : b
              this.f0Live = f
            }
            f0 = this.f0Live
          }
          this._follow(f0)
        }
      }
      // every few samples the mouth and the instrument whitening glide on
      if (++this.sub >= SUB) {
        this.sub = 0
        const aL = this.aLar
        for (let q = 1; q <= P; q++) {
          const lv = this.larC[q] + (this.larT[q] - this.larC[q]) * aL
          this.larC[q] = lv
          const e = Math.exp(lv)
          kC[q] = (e - 1) / (e + 1)
        }
        const aG = this.lgT > this.lgC ? this.aGu : this.aGd
        this.lgC += (this.lgT - this.lgC) * aG
        this.gC = Math.exp(this.lgC)
        const aA = this.aAc
        for (let q = 0; q <= PC; q++) acC[q] += (this.acT[q] - acC[q]) * aA
        this.gnC += (this.gnT - this.gnC) * aA
      }
      this.mixC += (this.mixT - this.mixC) * this.cS
      this.consC += (this.consT - this.consC) * this.cS
      this.uC += (this.uA - this.uC) * this.cU
      this.gate += (this.levA - this.gate) * (this.levA > this.gate ? this.cGa : this.cGr)
      // instrument, level-normalised slowly, then partly whitened
      let c = inst.next()
      if (!(c > -50 && c < 50)) c = 0
      this.carPow += (c * c - this.carPow) * this.cCar
      if (this.carPow < 1e-12) this.carPow = 1e-12
      let cg = 1 / Math.sqrt(this.carPow)
      if (cg > 40) cg = 40
      c *= cg
      this.ringC[pos] = c
      let cw = c
      for (let q = 1; q <= PC; q++) cw += acC[q] * cHist[q]
      for (let q = PC; q > 1; q--) cHist[q] = cHist[q - 1]
      cHist[1] = c
      cw *= this.gnC
      // the mouth: a lattice all-pole filter driven by the instrument
      const uc = this.uC * this.consC
      // in "s" and "t" the player's breath hisses through the same mouth shape
      let ns = this.nz
      ns ^= ns << 13
      ns ^= ns >>> 17
      ns ^= ns << 5
      ns >>>= 0
      this.nz = ns
      const hiss = (ns / 2147483648 - 1) * 1.7
      let f = this.gC * (cw * (1 - 0.7 * uc) + hiss * 1.2 * uc)
      for (let q = P; q >= 1; q--) {
        f -= kC[q] * bst[q - 1]
        let bq = kC[q] * f + bst[q - 1]
        if (bq < TINY && bq > -TINY) bq = 0
        bst[q] = bq
      }
      if (!(f > -1e4 && f < 1e4)) {
        f = 0
        bst.fill(0)
      }
      bst[0] = f
      let y = this.tHp.tick(f)
      y = this.tPk.tick(y)
      y = this.tLp.tick(y)
      y *= this.gate
      // the microphone hears the real consonants
      const rd = (pos - L) & mask
      const xd = this.ringX[rd]
      // a slow level match keeps the talking instrument as loud as the voice
      // (pre-emphasis takes more from a low voice than from a high one)
      this.pIn += (xd * xd - this.pIn) * this.cAgc
      this.pOut += (y * y - this.pOut) * this.cAgc
      if (this.pIn < TINY) this.pIn = 0
      if (this.pOut < TINY) this.pOut = 0
      if (this.sub === 0 && this.pIn > 1e-7 && this.gate > 0.5) {
        let tg = Math.sqrt(this.pIn / (this.pOut + 1e-12))
        tg = tg < 0.7 ? 0.7 : tg > 6 ? 6 : tg
        this.agc += (tg - this.agc) * this.aAgc
      }
      y *= this.agc
      const bl = this.bHp2.tick(this.bHp1.tick(xd)) * this.uC * this.consC * this.consC
      const wet = y + bl
      const m = this.mixC
      const da = this.ringA[rd]
      const db = this.ringB[rd]
      for (let ch = 0; ch < nout; ch++) {
        const dry = ch === 0 ? da : nin > 1 ? db : da
        outs[ch][i] = dry + m * (wet - dry)
      }
    }
  }
}

// ---------------------------------------------------------------- module

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

/** Samples the talk box delays its output: 15 ms analysis lookahead plus 10 ms for the mouth glide (the alignment an envelope-correlation ruler found best on real speech). */
function latencyOf(sr) {
  return Math.round(0.015 * sr) + Math.round(0.01 * sr)
}

function note(ctx, text) {
  if (ctx && typeof ctx.note === 'function') ctx.note(text)
}

const BLOCK = 8192

export default {
  id: 'synth.talkbox',
  name: 'Talk box',
  family: 'synth',
  about: 'A real talk box: a funk synth, fuzz guitar, organ or any other sound is shaped by your mouth, so the instrument says your words.',
  side: true,
  params: [
    {
      id: 'instrument', name: 'Instrument', type: 'choice', def: 'funk',
      options: [
        { v: 'funk', name: 'Funk synth lead' },
        { v: 'square', name: 'Square lead' },
        { v: 'fuzz', name: 'Fuzz guitar' },
        { v: 'organ', name: 'Organ' },
        { v: 'bass', name: 'Bass synth' },
        { v: 'chip', name: 'Eight bit lead' },
        { v: 'side', name: 'The other sound' },
      ],
    },
    {
      id: 'notes', name: 'Notes', type: 'choice', def: 'follow',
      options: [
        { v: 'follow', name: 'Follow my voice' },
        { v: 'chord', name: 'Held chord' },
        { v: 'changes', name: 'Chord changes' },
        { v: 'riff', name: 'Funk riff' },
        { v: 'arp', name: 'Arpeggio' },
        { v: 'held', name: 'One held note' },
      ],
    },
    { id: 'key', name: 'Key', type: 'choice', def: 'a', options: KEYS },
    {
      id: 'scale', name: 'Scale', type: 'choice', def: 'minorpent',
      options: [
        { v: 'minorpent', name: 'Minor pentatonic' },
        { v: 'majorpent', name: 'Major pentatonic' },
        { v: 'major', name: 'Major' },
        { v: 'minor', name: 'Minor' },
        { v: 'dorian', name: 'Dorian' },
        { v: 'mixolydian', name: 'Mixolydian' },
        { v: 'blues', name: 'Blues' },
        { v: 'harmonic', name: 'Harmonic minor' },
        { v: 'chromatic', name: 'Every note' },
      ],
    },
    {
      id: 'register', name: 'Range', type: 'choice', def: 'middle',
      options: [{ v: 'low', name: 'Low' }, { v: 'middle', name: 'Middle' }, { v: 'high', name: 'High' }],
    },
    {
      id: 'chord', name: 'Chord', type: 'choice', def: 'minor7',
      options: [
        { v: 'minor7', name: 'Minor seventh' },
        { v: 'seventh', name: 'Seventh' },
        { v: 'ninth', name: 'Funky ninth' },
        { v: 'major', name: 'Major' },
        { v: 'minor', name: 'Minor' },
        { v: 'power', name: 'Power chord' },
        { v: 'sus', name: 'Suspended' },
        { v: 'octave', name: 'Octaves' },
      ],
    },
    { id: 'tempo', name: 'Tempo', type: 'number', min: 60, max: 180, step: 1, def: 100, unit: 'bpm', rand: [84, 120] },
    { id: 'glide', name: 'Glide', type: 'number', min: 0, max: 300, step: 5, def: 40, unit: 'ms', rand: [10, 120] },
    { id: 'brightness', name: 'Brightness', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [35, 80] },
    { id: 'consonants', name: 'Consonants', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [35, 70] },
    { id: 'drive', name: 'Drive', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [0, 60] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [90, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 4,
  process(input, p, ctx) {
    const n = bufLen(input)
    if (!n) return input
    const sr = input.sr
    let side = null
    if (p.instrument === 'side') {
      side = sideSignal(ctx, n, sr)
      if (!side) note(ctx, 'Talk box: no other sound was given, so the funk synth lead played instead.')
    }
    const rng = ctx && ctx.rng ? ctx.rng : makeRng('synth.talkbox')
    const nch = input.ch.length
    const ins2 = input.ch.slice(0, 2)
    let track = null
    if (p.notes === 'follow' && !(p.instrument === 'side' && side)) {
      const mono = new Float32Array(n)
      for (let c = 0; c < ins2.length; c++) {
        const s = ins2[c]
        for (let i = 0; i < n; i++) {
          const v = s[i]
          mono[i] += (v === v && v < 1e6 && v > -1e6 ? v : 0) / ins2.length
        }
      }
      track = trackPitch(mono, sr, { minHz: 60, maxHz: 800 })
    }
    const D = latencyOf(sr)
    const eng = new TalkboxEngine(sr, p, rng, { track, side, clock: -D })
    if (side) eng.inst.sidePos = (n - (D % n)) % n
    // run over the take plus the lookahead, then drop the lookahead
    const total = n + D
    const ins = ins2.map((x) => {
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
    for (let c = 0; c < nch; c++) outs.push(tmp[Math.min(c, tmp.length - 1)].slice(D, D + n))
    return { sr, ch: outs }
  },
  live: {
    latency(p, sr) {
      return latencyOf(sr > 0 ? sr : 48000)
    },
    create(sr, p, rng) {
      return new TalkboxEngine(sr, p, rng, {})
    },
  },
}

export { TalkboxEngine }
