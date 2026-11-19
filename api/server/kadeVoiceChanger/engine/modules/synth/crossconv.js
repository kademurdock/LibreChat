// modules/synth/crossconv.js - synth.crossconv, your voice inside another sound.
//
// Technique: short-time convolution cross-synthesis, the spectral product of
// two sounds (the "convolve" and "cross-synthesis" processes of the phase
// vocoder tradition: Moorer 1978, "The use of the phase vocoder in computer
// music applications", JAES 26; Serra 1997 on spectral cross-synthesis).
// Frame by frame (Hann windows of about 43 ms at 75 percent overlap, the core
// weighted overlap-add STFT):
// - the voice is spectrally whitened: its smooth envelope (a real-cepstrum
//   envelope of 1.6 ms quefrency, core/envelope.js) is divided out, leaving
//   the fine structure, its pitch harmonics, breath and timing;
// - the other sound's magnitude spectrum, as smooth or as detailed as the
//   Smoothing control asks (a log-domain blend between its raw spectrum and
//   its own cepstral envelope, also eased across frames), is multiplied in;
// - the voice's own phases are kept, so the words keep their rhythm, and each
//   frame is scaled back to the voice's energy, with a little of the other
//   sound's rise and fall (a bell strike, a thunder roll) let through.
// Amount sets how far the voice's own envelope is replaced (a power law on the
// filter, so 50 percent is half way in decibels).
//
// Built-in sources are synthesised, never recorded: a peal of bells (modal
// resonators with church-bell partial ratios, hum, prime, tierce, quint and
// nominal, after Rossing 2000, "Science of Percussion Instruments"), a gong
// (dense inharmonic modes with a swelling shimmer after each stroke), singing
// glasses (sustained inharmonic partials with slow beating), rolling thunder
// (brown noise rumbles with cracks), rain (hiss plus resonant drops), a crowd
// (ten formant-filtered babbling talkers) and an idling engine (firing pulses
// through exhaust resonances). The other sound (ctx.side) can be used too.

import { makeRng } from '../../core/rng.js'
import { bufLen } from '../../core/buf.js'
import { FFT, nextPow2 } from '../../core/fft.js'
import { hann } from '../../core/window.js'
import { spectralProcess } from '../../core/stft.js'
import { cepstralEnvelope } from '../../core/envelope.js'
import { resampleTo } from '../../core/resample.js'
import { brown, white } from '../../core/noise.js'
import { Biquad, OnePole } from '../../core/biquad.js'

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

// ---------------------------------------------------------------- sources

/** Bank of two-pole resonators: impulse in, decaying sine out. */
class Modes {
  constructor(sr, n) {
    this.sr = sr
    this.n = n
    this.c1 = new Float64Array(n)
    this.c2 = new Float64Array(n)
    this.g = new Float64Array(n)
    this.y1 = new Float64Array(n)
    this.y2 = new Float64Array(n)
  }
  set(i, hz, t60, amp) {
    const f = Math.min(hz, this.sr * 0.45)
    const r = Math.pow(10, -3 / (Math.max(0.01, t60) * this.sr))
    const w = (2 * Math.PI * f) / this.sr
    this.c1[i] = 2 * r * Math.cos(w)
    this.c2[i] = -r * r
    this.g[i] = amp * Math.sin(w)
  }
  tick(xs, from, to) {
    // xs: excitation per mode (same value for a range of modes)
    let out = 0
    for (let i = from; i < to; i++) {
      let y = this.g[i] * xs + this.c1[i] * this.y1[i] + this.c2[i] * this.y2[i]
      if (y < 1e-25 && y > -1e-25) y = 0
      this.y2[i] = this.y1[i]
      this.y1[i] = y
      out += y
    }
    return out
  }
}

function genBells(n, sr, rng) {
  const out = new Float32Array(n)
  const notes = [60, 62, 64, 67, 69, 72]
  const ratios = [0.5, 1, 1.2, 1.5, 2, 2.5, 2.67, 3, 4, 5.33, 6.67, 8.1, 10.4, 12.9, 15.8, 19.6]
  // the hum and prime are kept modest and the upper partials ring longer than
  // in a tower bell, so the voice shimmers instead of booming
  const amps = [0.2, 0.45, 0.5, 0.35, 1, 0.6, 0.55, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3, 0.26, 0.22, 0.18]
  const t60 = [3, 3, 2.5, 2.2, 2.5, 2, 1.8, 1.6, 1.4, 1.2, 1.1, 1, 0.9, 0.8, 0.7, 0.6]
  const P = ratios.length
  const B = notes.length
  const m = new Modes(sr, B * P)
  for (let b = 0; b < B; b++) {
    const f = 440 * Math.pow(2, (notes[b] - 69) / 12)
    for (let q = 0; q < P; q++) m.set(b * P + q, f * ratios[q] * (1 + 0.003 * (rng.next() - 0.5)), t60[q], amps[q])
  }
  let next = 0
  const exc = new Float64Array(B)
  for (let i = 0; i < n; i++) {
    if (i >= next) {
      const b = rng.int(B)
      exc[b] = 0.6 + 0.4 * rng.next()
      next = i + Math.round((0.28 + 0.35 * rng.next()) * sr)
    }
    let s = 0
    for (let b = 0; b < B; b++) {
      s += m.tick(exc[b], b * P, b * P + P)
      exc[b] = 0
    }
    out[i] = s * 0.25
  }
  return out
}

function genGong(n, sr, rng) {
  const out = new Float32Array(n)
  const M = 48
  const m = new Modes(sr, M)
  for (let i = 0; i < M; i++) {
    const f = 68 * Math.pow(1 + i, 1.12) * (1 + 0.05 * (rng.next() - 0.5))
    m.set(i, f, 6 * Math.pow(1 + i, -0.22), Math.pow(1 + i, -0.15))
  }
  const lp = new OnePole(sr, 900, 'lp')
  let next = 0
  let since = 1e9
  for (let i = 0; i < n; i++) {
    let x = 0
    if (i >= next) {
      since = 0
      next = i + Math.round((2.6 + 1.6 * rng.next()) * sr)
    }
    const t = since / sr
    if (since < 0.004 * sr) x = 0.5 - 0.5 * Math.cos((2 * Math.PI * since) / (0.004 * sr))
    // shimmer: the stroke keeps feeding the upper modes for a moment
    const bloom = t < 3 ? (t / 0.4) * Math.exp(1 - t / 0.4) * 0.06 : 0
    const nz = (rng.next() * 2 - 1) * bloom
    since++
    let s = m.tick(lp.tick(x) * 0.6, 0, 12)
    s += m.tick(x * 0.4 + nz, 12, M)
    out[i] = s * 0.35
  }
  return out
}

function genGlass(n, sr, rng) {
  const out = new Float32Array(n)
  const notes = [72, 76, 79, 84]
  const parts = [[1, 1], [2.32, 0.22], [4.25, 0.07]]
  const K = notes.length * parts.length * 2
  const cs = new Float64Array(K)
  const sn = new Float64Array(K)
  const xr = new Float64Array(K)
  const xi = new Float64Array(K)
  const amp = new Float64Array(K)
  let k = 0
  for (const nt of notes) {
    const f = 440 * Math.pow(2, (nt - 69) / 12)
    for (const [r, a] of parts) {
      for (let d = 0; d < 2; d++) {
        const hz = Math.min(f * r + (d ? 0.4 + 0.5 * rng.next() : 0), sr * 0.45)
        const w = (2 * Math.PI * hz) / sr
        cs[k] = Math.cos(w)
        sn[k] = Math.sin(w)
        const ph = rng.next() * 2 * Math.PI
        xr[k] = Math.cos(ph)
        xi[k] = Math.sin(ph)
        amp[k] = a * 0.5
        k++
      }
    }
  }
  const trem = rng.next()
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let q = 0; q < K; q++) {
      const a = xr[q] * cs[q] - xi[q] * sn[q]
      const b = xr[q] * sn[q] + xi[q] * cs[q]
      xr[q] = a
      xi[q] = b
      s += a * amp[q]
    }
    if ((i & 1023) === 0) {
      for (let q = 0; q < K; q++) {
        const g = 1 / Math.sqrt(xr[q] * xr[q] + xi[q] * xi[q])
        xr[q] *= g
        xi[q] *= g
      }
    }
    const tm = 0.8 + 0.2 * Math.sin(2 * Math.PI * (0.31 * (i / sr) + trem))
    out[i] = s * 0.12 * tm
  }
  return out
}

function genThunder(n, sr, rng) {
  const out = brown(n, rng.fork ? rng.fork('rumble') : rng)
  const env = new Float32Array(n)
  // a distant floor plus rolling swells every few seconds
  let t = 0.2 + rng.next()
  const dur = n / sr
  while (t < dur) {
    const parts = 2 + rng.int(4)
    let tt = t
    for (let p = 0; p < parts; p++) {
      const a = (0.1 + 0.4 * rng.next()) * sr
      const d = (1.5 + 2.5 * rng.next()) * sr
      const g = 0.5 + 0.5 * rng.next()
      const s0 = Math.round(tt * sr)
      for (let i = 0; i < a + d * 3 && s0 + i < n; i++) {
        const v = i < a ? i / a : Math.exp(-(i - a) / d)
        if (s0 + i >= 0) env[s0 + i] += v * g
      }
      tt += 0.2 + 0.7 * rng.next()
    }
    t += 4 + 4 * rng.next()
  }
  const lp = new Biquad('lowpass', sr, 320, 0.7)
  for (let i = 0; i < n; i++) out[i] *= 0.25 + env[i]
  lp.run(out)
  // cracks: bright noise bursts at some swell starts
  const cr = white(n, rng.fork ? rng.fork('crack') : rng)
  const hp = new Biquad('highpass', sr, 1200, 0.7)
  hp.run(cr)
  t = 0.3 + rng.next() * 2
  while (t < dur) {
    const s0 = Math.round(t * sr)
    const len = Math.round((0.05 + 0.12 * rng.next()) * sr)
    for (let i = 0; i < len && s0 + i < n; i++) out[s0 + i] += cr[s0 + i] * 0.6 * Math.exp(-i / (0.04 * sr))
    t += 5 + 6 * rng.next()
  }
  return out
}

function genRain(n, sr, rng) {
  const out = white(n, rng.fork ? rng.fork('hiss') : rng)
  new Biquad('highpass', sr, 700, 0.7).run(out)
  new Biquad('lowpass', sr, Math.min(9000, sr * 0.45), 0.7).run(out)
  for (let i = 0; i < n; i++) out[i] *= 0.18
  const D = 6
  const m = new Modes(sr, D)
  for (let d = 0; d < D; d++) m.set(d, 2000 + 3000 * rng.next(), 0.02, 1)
  const rate = 140 / sr
  const ex = new Float64Array(D)
  for (let i = 0; i < n; i++) {
    if (rng.next() < rate) {
      const d = rng.int(D)
      m.set(d, 1400 + 3800 * rng.next(), 0.008 + 0.025 * rng.next(), 1)
      ex[d] = -Math.log(1 - rng.next()) * 0.5
    }
    let s = 0
    for (let d = 0; d < D; d++) {
      s += m.tick(ex[d], d, d + 1)
      ex[d] = 0
    }
    out[i] += s * 0.5
  }
  return out
}

const VOW = [[730, 1090], [530, 1840], [270, 2290], [570, 840], [300, 870], [660, 1720], [490, 1350]]

function genCrowd(n, sr, rng) {
  const out = new Float32Array(n)
  const T = 10
  for (let t = 0; t < T; t++) {
    const r = rng.fork ? rng.fork('talker' + t) : rng
    const f0 = 95 + 140 * r.next()
    const gain = 0.4 + 0.6 * r.next()
    const syl = 3.5 + 2.2 * r.next()
    const f1 = new Biquad('bandpass', sr, 600, 4)
    const f2 = new Biquad('bandpass', sr, 1500, 6)
    let ph = r.next()
    let sylPh = r.next()
    let talking = r.next() < 0.7
    let vow = VOW[r.int(VOW.length)]
    let F1 = vow[0]
    let F2 = vow[1]
    let pitch = f0
    let env = 0
    for (let i = 0; i < n; i++) {
      sylPh += syl / sr
      if (sylPh >= 1) {
        sylPh -= 1
        if (r.next() < (talking ? 0.12 : 0.35)) talking = !talking
        vow = VOW[r.int(VOW.length)]
        pitch = f0 * (0.85 + 0.3 * r.next())
      }
      // formants glide toward the syllable's vowel
      if ((i & 31) === 0) {
        F1 += (vow[0] - F1) * 0.08
        F2 += (vow[1] - F2) * 0.08
        f1.set('bandpass', F1, 4)
        f2.set('bandpass', F2, 6)
      }
      const target = talking ? Math.sin(Math.PI * sylPh) : 0
      env += (target - env) * 0.004
      ph += pitch / sr
      if (ph >= 1) ph -= 1
      const src = (2 * ph - 1) * 0.6 + (r.next() * 2 - 1) * 0.08
      const v = f1.tick(src) + 0.6 * f2.tick(src)
      out[i] += v * env * gain * 0.35
    }
  }
  new Biquad('lowpass', sr, Math.min(4500, sr * 0.45), 0.7).run(out)
  return out
}

function genEngine(n, sr, rng) {
  const out = new Float32Array(n)
  const cyl = [1, 0.82, 0.95, 0.78]
  let ph = 0
  let c = 0
  let pulse = 0
  let rpm = 950
  let rpmT = 950
  const dec = Math.exp(-1 / (0.006 * sr))
  const ex1 = new Biquad('bandpass', sr, 170, 3)
  const ex2 = new Biquad('bandpass', sr, Math.min(520, sr * 0.45), 4)
  const lp = new Biquad('lowpass', sr, Math.min(1600, sr * 0.45), 0.7)
  const hp = new Biquad('highpass', sr, Math.min(1500, sr * 0.45), 0.7)
  let tick = 0
  for (let i = 0; i < n; i++) {
    if ((i % Math.round(0.4 * sr)) === 0) rpmT = 850 + 300 * rng.next()
    rpm += (rpmT - rpm) * 0.00002
    const fire = (rpm / 60) * 2
    ph += fire / sr
    if (ph >= 1) {
      ph -= 1
      pulse += cyl[c] * (0.9 + 0.2 * rng.next())
      c = (c + 1) & 3
      tick = c === 0 ? 1 : tick
    }
    pulse *= dec
    tick *= 0.97
    const mech = hp.tick((rng.next() * 2 - 1) * (pulse * 0.3 + tick * 0.6))
    const body = ex1.tick(pulse) * 2 + ex2.tick(pulse) * 1.2 + pulse * 0.3
    out[i] = lp.tick(body) * 0.5 + mech * 0.1
  }
  return out
}

const GEN = { bells: genBells, gong: genGong, glass: genGlass, thunder: genThunder, rain: genRain, crowd: genCrowd, engine: genEngine }

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

// ---------------------------------------------------------------- cross-synthesis

function crossSynth(voice, src, sr, p) {
  const n = voice.length
  let size = nextPow2(Math.round(0.043 * sr))
  size = clamp(size, 256, 8192)
  const hop = size >> 2
  const nb = (size >> 1) + 1
  const fft = new FFT(size)
  const win = hann(size)
  const frame = new Float64Array(size)
  const sRe = new Float64Array(nb)
  const sIm = new Float64Array(nb)
  const mV = new Float64Array(nb)
  const mS = new Float64Array(nb)
  const envV = new Float32Array(nb)
  const envS = new Float32Array(nb)
  const sh = new Float64Array(nb)
  const prev = new Float64Array(nb)
  const W = new Float64Array(nb)
  const qV = Math.max(4, Math.round(0.0016 * sr))
  const qS = Math.max(3, Math.round(0.0012 * sr))
  const a = clamp(Number(p.amount), 0, 100) / 100
  const sm = clamp(Number(p.smoothing), 0, 100) / 100
  const tKeep = 0.65 * sm
  let slow = -1
  let first = true
  return spectralProcess(voice, { size, hop, window: 'hann' }, (re, im, f, info) => {
    const st = info.start
    for (let i = 0; i < size; i++) {
      const j = st + i
      frame[i] = j >= 0 && j < n ? src[j] * win[i] : 0
    }
    fft.realForward(frame, sRe, sIm)
    let eV = 0
    let eS = 0
    let mxS = 0
    for (let k = 0; k < nb; k++) {
      const v = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      const s = Math.sqrt(sRe[k] * sRe[k] + sIm[k] * sIm[k])
      mV[k] = v
      mS[k] = s
      eV += v * v
      eS += s * s
      if (s > mxS) mxS = s
    }
    if (!(eV > 1e-18)) {
      for (let k = 0; k < nb; k++) {
        re[k] = 0
        im[k] = 0
      }
      return
    }
    cepstralEnvelope(mV, qV, { out: envV })
    // the other sound's shape, smoothed as asked, and eased across frames
    const floorS = mxS * 1e-4 + 1e-12
    if (sm > 0.001) cepstralEnvelope(mS, qS, { out: envS })
    for (let k = 0; k < nb; k++) {
      const raw = Math.log(mS[k] + floorS)
      const smooth = sm > 0.001 ? Math.log(envS[k] + floorS) : raw
      let v = Math.exp((1 - sm) * raw + sm * smooth)
      if (!first) v = prev[k] + (v - prev[k]) * (1 - tKeep)
      prev[k] = v
      sh[k] = v
    }
    first = false
    // how loud the other sound is now against its recent average
    if (slow < 0) slow = eS
    slow += (eS - slow) * 0.06
    // (weighed by Amount, so at zero the voice is untouched)
    let dyn = slow > 1e-20 ? Math.pow(eS / slow, 0.3 * a) : a > 0 ? 0 : 1
    dyn = clamp(dyn, 0.2, 2.2)
    // filter: (other / voice envelope)^amount, then back to the voice's energy
    let eY = 0
    let mxEnv = 0
    for (let k = 0; k < nb; k++) if (envV[k] > mxEnv) mxEnv = envV[k]
    const floorV = mxEnv * 1e-4 + 1e-12
    for (let k = 0; k < nb; k++) {
      const w = Math.exp(a * (Math.log(sh[k]) - Math.log(envV[k] + floorV)))
      W[k] = w
      const y = mV[k] * w
      eY += y * y
    }
    let c = eY > 1e-30 ? Math.sqrt(eV / eY) * dyn : 0
    if (!(c < 1e6)) c = 0
    for (let k = 0; k < nb; k++) {
      const g = W[k] * c
      re[k] *= g
      im[k] *= g
    }
  })
}

export default {
  id: 'synth.crossconv',
  name: 'Voice inside a sound',
  family: 'synth',
  about: 'Your voice poured into another sound: it rings through bells, a gong or glasses, rumbles in thunder, patters in rain, or takes on any sound you give it.',
  side: true,
  params: [
    {
      id: 'source', name: 'Sound', type: 'choice', def: 'bells',
      options: [
        { v: 'bells', name: 'Bells' },
        { v: 'gong', name: 'Gong' },
        { v: 'glass', name: 'Singing glasses' },
        { v: 'thunder', name: 'Thunder' },
        { v: 'rain', name: 'Rain' },
        { v: 'crowd', name: 'Crowd' },
        { v: 'engine', name: 'Engine' },
        { v: 'side', name: 'The other sound' },
      ],
    },
    { id: 'amount', name: 'Amount', type: 'number', min: 0, max: 100, step: 1, def: 70, unit: 'percent', rand: [50, 95] },
    { id: 'smoothing', name: 'Smoothing', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [10, 60] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [75, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    const n = bufLen(input)
    if (!n) return input
    const sr = input.sr
    const rng = ctx && ctx.rng ? ctx.rng : makeRng('synth.crossconv')
    const nch = input.ch.length
    let src = null
    if (p.source === 'side') {
      src = sideSignal(ctx, n, sr)
      if (!src) note(ctx, 'Voice inside a sound: no other sound was given, so it used the bells instead.')
    }
    if (!src) {
      const gen = GEN[p.source] || GEN.bells
      src = gen(n, sr, rng.fork ? rng.fork('source') : rng)
    }
    if (ctx && typeof ctx.progress === 'function') ctx.progress(0.3)
    const ins = input.ch.map((c) => {
      const y = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const v = c[i]
        y[i] = v === v && v < 1e6 && v > -1e6 ? v : 0
      }
      return y
    })
    const m = clamp(Number(p.mix), 0, 100) / 100
    const outs = []
    for (let c = 0; c < nch; c++) {
      // a second channel identical to the first is not worked twice
      if (c > 0 && ins[c].every((v, i) => v === ins[0][i])) {
        outs.push(new Float32Array(outs[0]))
        continue
      }
      const wet = crossSynth(ins[c], src, sr, p)
      const o = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        let w = wet[i]
        if (!(w > -8 && w < 8)) w = 0
        o[i] = ins[c][i] + m * (w - ins[c][i])
      }
      outs.push(o)
      if (ctx && typeof ctx.progress === 'function') ctx.progress(0.3 + (0.7 * (c + 1)) / nch)
    }
    return { sr, ch: outs }
  },
}
