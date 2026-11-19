// modules/spec/blend.js - Half you, half it: a spectral morph between your voice and another sound.
//
// Technique: spectral interpolation morphing (the magnitude and envelope
// interpolation of Serra's spectral modelling morphs, see Serra 1994,
// "Sound hybridization techniques based on a deterministic plus stochastic
// decomposition model", ICMC; and Slaney, Covell and Lassiter 1996,
// "Automatic audio morphing", ICASSP, for separating the smooth envelope from
// the fine detail). Every STFT frame of the voice and of the other sound is
// split into a cepstral spectral envelope (core/envelope.js, lifter 1.6 ms)
// and the fine detail left after dividing it out. The fine details are
// interpolated geometrically, so at 50 percent you hear a sound halfway
// between the two pitches and textures, and the envelope comes from the
// voice (the result keeps your words and your timing), from the other sound
// (its colour, with your detail inside it), or from both. Phases follow the
// weighted sum of the two unit phasors. The other sound is first matched to
// the voice's overall loudness so the slider means the same with any
// recording. "Keep consonants" leans the hissy consonants back towards the
// voice so the words stay easy to follow.

import { cepstralEnvelope } from '../../core/envelope.js'
import { resolveParams } from '../../core/params.js'
import { makeCarrier, CARRIER_OPTIONS } from './_carriers.js'
import { frameSize, rngOf, progressTo, noteTo, multiSpectral, readSide, cleanSig, sigRms } from './_spectral.js'

class BlendFrame {
  constructor(N, sr) {
    const nb = (N >> 1) + 1
    this.nb = nb
    this.vMag = new Float64Array(nb)
    this.oMag = new Float64Array(nb)
    this.vEnv = new Float32Array(nb)
    this.oEnv = new Float32Array(nb)
    this.vOpts = { out: this.vEnv }
    this.oOpts = { out: this.oEnv }
    this.order = Math.max(4, Math.round(0.0016 * sr))
    const bin = sr / N
    this.lf0 = Math.max(1, Math.round(100 / bin))
    this.lf1 = Math.max(this.lf0 + 1, Math.round(1500 / bin))
    this.hf0 = Math.min(nb - 2, Math.round(3000 / bin))
    this.hf1 = Math.min(nb - 1, Math.round(Math.min(10000, sr * 0.45) / bin))
  }

  run(vRe, vIm, oRe, oIm, gO, b0, envMode, keepCons, yRe, yIm) {
    const { nb, vMag, oMag, vEnv, oEnv } = this
    let eV = 0
    let eO = 0
    for (let k = 0; k < nb; k++) {
      const a = vRe[k] * vRe[k] + vIm[k] * vIm[k]
      const c = (oRe[k] * oRe[k] + oIm[k] * oIm[k]) * gO * gO
      vMag[k] = Math.sqrt(a)
      oMag[k] = Math.sqrt(c)
      eV += a
      eO += c
    }
    if (!(eV > 1e-24) && !(eO > 1e-24)) return
    let b = b0
    if (keepCons && eV > 1e-24) {
      let lf = 0
      let hf = 0
      for (let k = this.lf0; k < this.lf1; k++) lf += vMag[k] * vMag[k]
      for (let k = this.hf0; k < this.hf1; k++) hf += vMag[k] * vMag[k]
      let u = (10 * Math.log10((hf + 1e-30) / (lf + 1e-30)) + 4) / 10
      u = u < 0 ? 0 : u > 1 ? 1 : u
      b = b0 * (1 - 0.7 * u)
    }
    if (eV > 1e-24) cepstralEnvelope(vMag, this.order, this.vOpts)
    else vEnv.fill(1e-15)
    if (eO > 1e-24) cepstralEnvelope(oMag, this.order, this.oOpts)
    else oEnv.fill(1e-15)
    const a1 = 1 - b
    let eY = 0
    for (let k = 1; k < nb - 1; k++) {
      const ev = vEnv[k] > 1e-30 ? vEnv[k] : 1e-30
      const eo = oEnv[k] > 1e-30 ? oEnv[k] : 1e-30
      const fv = vMag[k] / ev + 1e-12
      const fo = oMag[k] / eo + 1e-12
      let E
      if (envMode === 'voice') E = ev
      else if (envMode === 'other') E = eo
      else E = Math.pow(ev, a1) * Math.pow(eo, b)
      const M = E * Math.pow(fv, a1) * Math.pow(fo, b)
      // phase from the weighted unit phasors
      let pr = 0
      let pi = 0
      if (vMag[k] > 0) {
        pr += (a1 * vRe[k]) / vMag[k]
        pi += (a1 * vIm[k]) / vMag[k]
      }
      if (oMag[k] > 0) {
        const s = (b * gO) / oMag[k]
        pr += oRe[k] * s
        pi += oIm[k] * s
      }
      let pm = Math.sqrt(pr * pr + pi * pi)
      if (!(pm > 1e-9)) {
        if (b > 0.5 && oMag[k] > 0) {
          pr = (oRe[k] * gO) / oMag[k]
          pi = (oIm[k] * gO) / oMag[k]
        } else if (vMag[k] > 0) {
          pr = vRe[k] / vMag[k]
          pi = vIm[k] / vMag[k]
        } else {
          pr = 1
          pi = 0
        }
        pm = 1
      }
      const s = M / pm
      yRe[k] = pr * s
      yIm[k] = pi * s
      eY += M * M
    }
    // frame loudness: the voice's, the other sound's, or between the two
    let target
    if (envMode === 'voice') target = eV
    else if (envMode === 'other') target = eO
    else target = eV > 1e-30 && eO > 1e-30 ? Math.pow(eV, a1) * Math.pow(eO, b) : 0
    if (eY > 1e-30 && target > 0) {
      let g = Math.sqrt(target / eY)
      if (g > 100) g = 100
      for (let k = 1; k < nb - 1; k++) {
        yRe[k] *= g
        yIm[k] *= g
      }
    }
  }
}

const OPTIONS = [{ v: 'side', name: 'The other sound' }].concat(CARRIER_OPTIONS)

const blend = {
  id: 'spec.blend',
  name: 'Half you, half it',
  family: 'spec',
  about: 'Melts your voice and another sound into one, from a hint of it to almost all of it.',
  side: true,
  params: [
    { id: 'source', name: 'Blend with', type: 'choice', def: 'side', options: OPTIONS },
    { id: 'blend', name: 'Blend', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [30, 70] },
    {
      id: 'envelope', name: 'Shape from', type: 'choice', def: 'voice',
      options: [
        { v: 'voice', name: 'Your voice' },
        { v: 'other', name: 'The other sound' },
        { v: 'both', name: 'Both' },
      ],
    },
    { id: 'consonants', name: 'Keep consonants', type: 'bool', def: true },
  ],
  stereo: 'make',
  tail: () => 0,
  warps: false,
  cost: 4,
  process(input, params, ctx) {
    const p = resolveParams(blend, params)
    const sr = input.sr
    const len = input.ch[0] ? input.ch[0].length : 0
    if (len === 0) return { sr, ch: [new Float32Array(0), new Float32Array(0)] }
    const rng = rngOf(ctx, 'spec.blend')
    let kind = p.source
    let other = null
    if (kind === 'side') {
      other = readSide(ctx, len, sr)
      if (!other) {
        kind = 'wind'
        noteTo(ctx, 'No other sound was given, so your voice was blended with wind instead.')
      }
    }
    if (!other) other = makeCarrier(kind, len, sr, rng.fork('carrier'))
    const oL = other[0]
    const oR = other[1] || other[0]
    const vL = input.ch[0]
    const stereoVoice = input.ch.length > 1
    const vR = stereoVoice ? input.ch[1] : vL
    const N = frameSize(sr, 42.7)
    const rv = Math.sqrt((sigRms(vL) ** 2 + sigRms(vR) ** 2) / 2)
    const ro = Math.sqrt((sigRms(oL) ** 2 + sigRms(oR) ** 2) / 2)
    let gO = ro > 1e-9 && rv > 1e-9 ? rv / ro : 1
    if (gO > 1000) gO = 1000
    const b = p.blend / 100
    const fL = new BlendFrame(N, sr)
    const fR = new BlendFrame(N, sr)
    const ins = stereoVoice ? [vL, vR, oL, oR] : [vL, oL, oR]
    const outs = multiSpectral(ins, 2, { size: N, hop: N >> 2 }, (I, O) => {
      const vi1 = stereoVoice ? 1 : 0
      const oi = stereoVoice ? 2 : 1
      fL.run(I[0].re, I[0].im, I[oi].re, I[oi].im, gO, b, p.envelope, p.consonants, O[0].re, O[0].im)
      fR.run(I[vi1].re, I[vi1].im, I[oi + 1].re, I[oi + 1].im, gO, b, p.envelope, p.consonants, O[1].re, O[1].im)
    }, ctx, 0, 0.98)
    progressTo(ctx, 1)
    return { sr, ch: [cleanSig(outs[0]), cleanSig(outs[1])] }
  },
}

export default blend
