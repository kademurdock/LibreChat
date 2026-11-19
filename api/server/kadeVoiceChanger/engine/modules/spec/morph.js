// modules/spec/morph.js - Cross-synthesis: your words spoken BY a storm, a fire, a song.
//
// Technique: source-filter cross-synthesis in the STFT domain (the "spectral
// mutation" and cross-synthesis of Serra and Smith's spectral modelling, and
// Zolzer, ed., "DAFX", cross-synthesis section). Frame by frame:
// 1. The voice's spectral envelope comes from the real cepstrum
//    (core/envelope.js, lifter 1.6 ms), sharpened a little (raised to a power
//    above 1) so the formants, which carry the words, stand out.
// 2. The other sound is whitened: divided by its own, much smoother envelope
//    (lifter 0.7 ms). Its broad colour goes, but its fine detail stays: the
//    whistle of the wind, the crackle of the fire, the notes of a song.
// 3. The whitened sound is shaped by the voice envelope, blended (in the log
//    domain) with a little of the other sound's own colour; "Clarity" sets
//    how little. The frame is then scaled to the voice frame's energy, times
//    part of the other sound's own loudness swing, so gusts, drops, waves and
//    drum hits still move the words.
// 4. In hissy consonants ("s", "t", "sh", detected by the share of energy
//    above 3 kHz) a pitched sound gets some flat noise mixed into its fine
//    structure, so consonants stay sharp even when the voice is made of an
//    organ or bells. Where the other sound falls silent, noise fills in so
//    words never vanish.
// The built-in sounds are synthesised in stereo (_carriers.js), so the result
// is a stereo storm, fire or choir; "The other sound" may be any recording.
// "Background" keeps the plain sound playing softly under your words.

import { cepstralEnvelope } from '../../core/envelope.js'
import { resolveParams } from '../../core/params.js'
import { Biquad } from '../../core/biquad.js'
import { makeCarrier, CARRIER_OPTIONS } from './_carriers.js'
import { frameSize, rngOf, progressTo, noteTo, multiSpectral, readSide, cleanSig, sigRms, TWO_PI, PH_COS, PH_SIN } from './_spectral.js'

// per carrier: [loudness swing kept, colour kept at clarity 0, consonant help, breath floor]
const CHAR = {
  wind: [0.35, 0.45, 0.35, 0],
  rain: [0.5, 0.4, 0.3, 0],
  fire: [0.6, 0.5, 0.3, 0],
  engine: [0.2, 0.3, 1, 0.1],
  ocean: [0.4, 0.45, 0.35, 0],
  crowd: [0.3, 0.3, 0.6, 0.05],
  pad: [0, 0.2, 1, 0.08],
  organ: [0.1, 0.25, 1, 0.12],
  bells: [0.6, 0.35, 1, 0.15],
  side: [0.45, 0.35, 1, 0.06],
}
const SMOOTH_NOISE = { wind: true, fire: true, ocean: true }

/** Voice-side analysis of one frame, reused for both output channels when the voice is mono. */
class VoiceFrame {
  constructor(N, sr, gamma) {
    const nb = (N >> 1) + 1
    this.nb = nb
    this.mag = new Float64Array(nb)
    this.env = new Float32Array(nb)
    this.envOpts = { out: this.env }
    this.order = Math.max(4, Math.round(0.0016 * sr))
    this.gamma = gamma
    this.energy = 0
    this.unvoiced = 0
    const bin = sr / N
    this.lf0 = Math.max(1, Math.round(100 / bin))
    this.lf1 = Math.max(this.lf0 + 1, Math.round(1500 / bin))
    this.hf0 = Math.min(nb - 2, Math.round(3000 / bin))
    this.hf1 = Math.min(nb - 1, Math.round(Math.min(10000, sr * 0.45) / bin))
  }

  analyse(re, im) {
    const { nb, mag, env } = this
    let e = 0
    for (let k = 0; k < nb; k++) {
      const m2 = re[k] * re[k] + im[k] * im[k]
      mag[k] = Math.sqrt(m2)
      e += m2
    }
    this.energy = e
    if (!(e > 1e-24)) {
      this.unvoiced = 0
      env.fill(0)
      return
    }
    cepstralEnvelope(mag, this.order, this.envOpts)
    if (this.gamma > 0) {
      const g = 1 + this.gamma
      for (let k = 0; k < nb; k++) env[k] = env[k] > 0 ? Math.pow(env[k], g) : 0
    }
    let lf = 0
    let hf = 0
    for (let k = this.lf0; k < this.lf1; k++) lf += mag[k] * mag[k]
    for (let k = this.hf0; k < this.hf1; k++) hf += mag[k] * mag[k]
    const r = 10 * Math.log10((hf + 1e-30) / (lf + 1e-30))
    const u = (r + 4) / 10
    this.unvoiced = u < 0 ? 0 : u > 1 ? 1 : u
  }
}

class CarrierShaper {
  constructor(N, sr, kind, clarity, expectE, rng) {
    const nb = (N >> 1) + 1
    this.nb = nb
    this.mag = new Float64Array(nb)
    this.env = new Float32Array(nb)
    this.envOpts = { out: this.env }
    this.order = Math.max(3, Math.round(0.0007 * sr))
    const ch = CHAR[kind] || CHAR.wind
    this.beta = ch[0]
    this.kappa = ch[1] * (1 - clarity / 100)
    this.help = ch[2] * (0.4 + 0.6 * (clarity / 100))
    this.floor = ch[3] * (0.5 + clarity / 100)
    this.expectE = expectE
    this.rng = rng
    // A voice has almost nothing below its own pitch, but a cepstral envelope
    // smears the low formant down to 0 Hz; without this the carrier's rumble
    // would come through at full level under every word.
    this.lowCut = new Float64Array(nb)
    for (let k = 0; k < nb; k++) {
      const f = (k * sr) / N
      this.lowCut[k] = f >= 160 ? 1 : (f / 160) * (f / 160)
    }
  }

  shape(cRe, cIm, vf, oRe, oIm) {
    const { nb, mag, env, rng } = this
    const vEnv = vf.env
    if (!(vf.energy > 1e-24)) return
    let eC = 0
    for (let k = 0; k < nb; k++) {
      const m2 = cRe[k] * cRe[k] + cIm[k] * cIm[k]
      mag[k] = Math.sqrt(m2)
      eC += m2
    }
    // whiten the carrier
    let fr = 0
    if (eC > 1e-24) {
      cepstralEnvelope(mag, this.order, this.envOpts)
      for (let k = 0; k < nb; k++) {
        const e = env[k] > 1e-30 ? env[k] : 1e-30
        oRe[k] = cRe[k] / e
        oIm[k] = cIm[k] / e
        fr += (mag[k] / e) * (mag[k] / e)
      }
      fr = Math.sqrt(fr / nb)
    } else {
      for (let k = 0; k < nb; k++) {
        env[k] = 1
        oRe[k] = 0
        oIm[k] = 0
      }
      fr = 1
    }
    // noise where the carrier is silent, and in hissy consonants
    const quiet = this.expectE > 0 ? eC / (this.expectE * 3.2e-4) : 1
    let z = quiet < 1 ? 1 - quiet : 0
    const u = vf.unvoiced * this.help
    if (u > z) z = u
    if (this.floor > z) z = this.floor
    if (z > 0) {
      const keep = 1 - z
      const nz = z * (fr > 0 ? fr : 1)
      for (let k = 0; k < nb; k++) {
        const j = (rng.next() * 4096) | 0
        oRe[k] = oRe[k] * keep + nz * PH_COS[j]
        oIm[k] = oIm[k] * keep + nz * PH_SIN[j]
      }
    }
    // shape with the voice envelope (plus a little of the carrier's colour)
    const ka = this.kappa
    let eY = 0
    for (let k = 0; k < nb; k++) {
      let t = vEnv[k]
      if (ka > 0 && t > 0) t = Math.pow(t, 1 - ka) * Math.pow(env[k] > 1e-30 ? env[k] : 1e-30, ka)
      t *= this.lowCut[k]
      const a = oRe[k] * t
      const b = oIm[k] * t
      oRe[k] = a
      oIm[k] = b
      eY += a * a + b * b
    }
    if (!(eY > 1e-30)) {
      oRe.fill(0)
      oIm.fill(0)
      return
    }
    let swing = 1
    if (this.beta > 0 && this.expectE > 0 && eC > 0) {
      swing = Math.pow(eC / this.expectE, this.beta / 2)
      if (swing < 0.3) swing = 0.3
      if (swing > 2.5) swing = 2.5
    }
    const g = Math.sqrt(vf.energy / eY) * swing
    for (let k = 0; k < nb; k++) {
      oRe[k] *= g
      oIm[k] *= g
    }
    oIm[0] = 0
    oIm[nb - 1] = 0
  }
}

const OPTIONS = [{ v: 'side', name: 'The other sound' }].concat(CARRIER_OPTIONS)

const morph = {
  id: 'spec.morph',
  name: 'Words made of sound',
  family: 'spec',
  about: 'Your words spoken by the wind, rain, fire, the sea, an organ, bells or any sound you give it.',
  side: true,
  params: [
    { id: 'carrier', name: 'Made of', type: 'choice', def: 'wind', options: OPTIONS },
    { id: 'amount', name: 'Amount', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [80, 100] },
    { id: 'clarity', name: 'Clarity', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [35, 80] },
    { id: 'background', name: 'Background', type: 'number', min: -60, max: 0, step: 1, def: -20, unit: 'db', rand: [-30, -12] },
  ],
  stereo: 'make',
  tail: () => 0,
  warps: false,
  cost: 4,
  process(input, params, ctx) {
    const p = resolveParams(morph, params)
    const sr = input.sr
    const len = input.ch[0] ? input.ch[0].length : 0
    if (len === 0) return { sr, ch: [new Float32Array(0), new Float32Array(0)] }
    const rng = rngOf(ctx, 'spec.morph')
    let kind = p.carrier
    let car = null
    if (kind === 'side') {
      car = readSide(ctx, len, sr)
      if (!car) {
        kind = 'wind'
        noteTo(ctx, 'No other sound was given, so your words were made of wind instead.')
      }
    }
    if (!car) car = makeCarrier(kind, len, sr, rng.fork('carrier'))
    const cL = car[0]
    const cR = car[1] || car[0]
    const vL = input.ch[0]
    const stereoVoice = input.ch.length > 1
    const vR = stereoVoice ? input.ch[1] : vL
    // Short frames track the mouth best (measured: pitched sounds and rain
    // are clearly more intelligible at 10.7 ms); the smooth noises keep a
    // calmer texture at 21 ms.
    const N = frameSize(sr, SMOOTH_NOISE[kind] ? 21.3 : 10.7)
    const hop = N >> 2
    const gamma = 0.15 + 0.35 * (p.clarity / 100)
    const vfL = new VoiceFrame(N, sr, gamma)
    const vfR = stereoVoice ? new VoiceFrame(N, sr, gamma) : vfL
    // expected carrier frame energy (Parseval over the half spectrum)
    let sw2 = 0
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((TWO_PI * i) / N)
      sw2 += w * w
    }
    const rL = sigRms(cL)
    const rR = sigRms(cR)
    const shL = new CarrierShaper(N, sr, kind, p.clarity, (N / 2) * rL * rL * sw2, rng.fork('noiseL'))
    const shR = new CarrierShaper(N, sr, kind, p.clarity, (N / 2) * rR * rR * sw2, rng.fork('noiseR'))
    const ins = stereoVoice ? [vL, vR, cL, cR] : [vL, cL, cR]
    const outs = multiSpectral(ins, 2, { size: N, hop }, (I, O) => {
      vfL.analyse(I[0].re, I[0].im)
      if (stereoVoice) vfR.analyse(I[1].re, I[1].im)
      const ci = stereoVoice ? 2 : 1
      shL.shape(I[ci].re, I[ci].im, vfL, O[0].re, O[0].im)
      shR.shape(I[ci + 1].re, I[ci + 1].im, vfR, O[1].re, O[1].im)
    }, ctx, 0, 0.95)
    const [mL, mR] = outs
    // a voice band: the short frames cannot shape the lowest octave finely, so
    // a 4th-order 90 Hz high-pass keeps carrier rumble out of the words
    for (const m of outs) {
      new Biquad('highpass', sr, 90, 0.707).run(m)
      new Biquad('highpass', sr, 90, 0.707).run(m)
    }
    // background: the plain sound under the words
    if (p.background > -60) {
      const rm = Math.sqrt((sigRms(mL) ** 2 + sigRms(mR) ** 2) / 2)
      const rc = Math.sqrt((rL * rL + rR * rR) / 2)
      if (rm > 1e-9 && rc > 1e-9) {
        const g = (Math.pow(10, p.background / 20) * rm) / rc
        for (let i = 0; i < len; i++) {
          mL[i] += cL[i] * g
          mR[i] += cR[i] * g
        }
      }
    }
    const a = p.amount / 100
    if (a < 1) {
      for (let i = 0; i < len; i++) {
        mL[i] = mL[i] * a + vL[i] * (1 - a)
        mR[i] = mR[i] * a + vR[i] * (1 - a)
      }
    }
    progressTo(ctx, 1)
    return { sr, ch: [cleanSig(mL), cleanSig(mR)] }
  },
}

export default morph
