// modules/spec/whisper.js - Whisperizer: the voice with its pitch taken away.
//
// Technique: STFT "whisperization" (Zolzer, ed., "DAFX: Digital Audio Effects",
// time-frequency processing chapter): keep each frame's magnitudes, replace
// the phases with random ones, so the voiced buzz becomes breath noise. Plain
// phase randomisation still leaves the voice's harmonics standing in the
// magnitudes (a rough, half-pitched sound), so here the magnitudes are first
// replaced by the cepstral spectral envelope (core/envelope.js, a lifter
// below 1.6 ms, which removes the harmonic ripple of any voice up to about
// 600 Hz). What is left is noise shaped exactly like the vowels and
// consonants: a true voiceless whisper. Real whispers have no low end and a
// brighter, flatter top (turbulent noise instead of the glottal buzz), so a
// gentle low cut and a brightness tilt follow. Each frame is energy-matched
// to the input frame, and the fixed overlap-add loss of random-phase frames
// is undone (_spectral.js noiseOlaGain, a factor of 2 for Hann at a quarter
// hop).
// Live: the same per-frame process on a 512-point streaming STFT at 48 kHz
// (hop 128, latency one frame, 10.7 ms).

import { cepstralEnvelope } from '../../core/envelope.js'
import { hann } from '../../core/window.js'
import { spectralProcess } from '../../core/stft.js'
import { resolveParams } from '../../core/params.js'
import { makeRng } from '../../core/rng.js'
import { frameSize, frameSizeAtMost, rngOf, progressTo, noiseOlaGain, StreamSTFT, DryDelay, cleanSig, PH_COS, PH_SIN } from './_spectral.js'

const FRAME_MS = { small: 10.7, medium: 21.3, large: 42.7 }
const LIVE_MS = 12

function tiltCurve(N, sr, brightness) {
  const nb = (N >> 1) + 1
  const t = new Float64Array(nb)
  const b = brightness / 100
  for (let k = 0; k < nb; k++) {
    const f = (k * sr) / N
    let g = 1
    if (f < 280) {
      const x = Math.max(f, 1) / 280
      g = x * Math.sqrt(x)
    } else if (f > 1000) {
      g = Math.pow(f / 1000, 0.6 * b)
      if (g > 4) g = 4
    }
    t[k] = g
  }
  return t
}

// Per-frame whisper state (shared by offline and live).
class WhisperFrame {
  constructor(N, sr, brightness, rng) {
    const nb = (N >> 1) + 1
    this.N = N
    this.nb = nb
    this.mag = new Float64Array(nb)
    this.env = new Float32Array(nb)
    this.envOpts = { out: this.env }
    this.order = Math.max(4, Math.round(0.0016 * sr))
    this.tilt = tiltCurve(N, sr, brightness)
    this.gain = noiseOlaGain(hann(N), N >> 2)
    this.rng = rng
  }

  spectrum(re, im) {
    const { nb, mag, env, tilt, rng } = this
    let e1 = 0
    for (let k = 0; k < nb; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      mag[k] = m
      e1 += m * m
    }
    if (!(e1 > 1e-24)) {
      for (let k = 0; k < nb; k++) {
        re[k] = 0
        im[k] = 0
      }
      return
    }
    cepstralEnvelope(mag, this.order, this.envOpts)
    let e2 = 0
    for (let k = 0; k < nb; k++) {
      const v = env[k] * tilt[k]
      mag[k] = v
      e2 += v * v
    }
    const g = e2 > 1e-30 ? Math.sqrt(e1 / e2) * this.gain : 0
    for (let k = 0; k < nb; k++) {
      const j = (rng.next() * 4096) | 0
      const m = mag[k] * g
      re[k] = m * PH_COS[j]
      im[k] = m * PH_SIN[j]
    }
    im[0] = 0
    im[nb - 1] = 0
  }
}

class WhisperLive {
  constructor(sr, p, rng) {
    const N = frameSizeAtMost(sr, LIVE_MS)
    this.N = N
    this.sr = sr
    this.st = []
    const r = rng && typeof rng.next === 'function' ? rng : makeRng('spec.whisper.live')
    for (let c = 0; c < 2; c++) {
      this.st.push({
        stft: new StreamSTFT(N, N >> 2),
        fr: new WhisperFrame(N, sr, p.brightness, r.fork ? r.fork('ch' + c) : r),
        dry: new DryDelay(N),
      })
    }
    this.amtC = 1 - Math.exp(-1 / (0.02 * sr))
    this.amt = p.amount / 100
    this.set(p)
  }

  set(p) {
    this.tAmt = p.amount / 100
    // brightness changes rebuild the tilt curve in place (no allocation)
    if (p.brightness !== this.bright) {
      this.bright = p.brightness
      for (let s = 0; s < this.st.length; s++) {
        const st = this.st[s]
        const t = st.fr.tilt
        const N = st.fr.N
        const b = p.brightness / 100
        for (let k = 0; k < t.length; k++) {
          const f = (k * this.sr) / N
          let g = 1
          if (f < 280) {
            const x = Math.max(f, 1) / 280
            g = x * Math.sqrt(x)
          } else if (f > 1000) {
            g = Math.pow(f / 1000, 0.6 * b)
            if (g > 4) g = 4
          }
          t[k] = g
        }
      }
    }
  }

  reset() {
    for (let s = 0; s < this.st.length; s++) {
      this.st[s].stft.reset()
      this.st[s].dry.reset()
    }
  }

  process(ins, outs, n) {
    const nc = outs.length
    let amt = this.amt
    for (let c = 0; c < nc && c < 2; c++) {
      const x = ins[c < ins.length ? c : ins.length - 1]
      const y = outs[c]
      const st = this.st[c]
      amt = this.amt
      for (let i = 0; i < n; i++) {
        let v = x[i]
        if (!(v > -1e30 && v < 1e30)) v = 0
        const w = st.stft.tick(v, st.fr)
        const d = st.dry.tick(v)
        amt += (this.tAmt - amt) * this.amtC
        const r = w * amt + d * (1 - amt)
        y[i] = r > -8 && r < 8 ? r : r > 0 ? 8 : r < 0 ? -8 : 0
      }
    }
    this.amt = amt
  }
}

const whisper = {
  id: 'spec.whisper',
  name: 'Whisperizer',
  family: 'spec',
  about: 'Takes the pitch out of your voice so every word comes out as a breathy whisper.',
  params: [
    { id: 'amount', name: 'Whisper amount', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [70, 100] },
    {
      id: 'size', name: 'Texture', type: 'choice', def: 'medium',
      options: [
        { v: 'small', name: 'Crisp' },
        { v: 'medium', name: 'Soft' },
        { v: 'large', name: 'Watery' },
      ],
    },
    { id: 'brightness', name: 'Breathiness', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 2,
  process(input, params, ctx) {
    const p = resolveParams(whisper, params)
    const sr = input.sr
    const nch = input.ch.length
    const len = input.ch[0] ? input.ch[0].length : 0
    if (len === 0) return { sr, ch: input.ch.map(() => new Float32Array(0)) }
    const N = frameSize(sr, FRAME_MS[p.size] || FRAME_MS.medium)
    const rng = rngOf(ctx, 'spec.whisper')
    const amt = p.amount / 100
    const ch = []
    for (let c = 0; c < nch; c++) {
      const src = input.ch[c]
      const fr = new WhisperFrame(N, sr, p.brightness, rng.fork('ch' + c))
      const wet = spectralProcess(src, { size: N, hop: N >> 2 }, (re, im) => fr.spectrum(re, im))
      if (amt < 1) for (let i = 0; i < len; i++) wet[i] = wet[i] * amt + src[i] * (1 - amt)
      ch.push(cleanSig(wet))
      progressTo(ctx, (c + 1) / nch)
    }
    return { sr, ch }
  },
  live: {
    latency(p, sr) {
      return frameSizeAtMost(sr || 48000, LIVE_MS)
    },
    create(sr, p, rng) {
      return new WhisperLive(sr, resolveParams(whisper, p), rng)
    },
  },
}

export default whisper
