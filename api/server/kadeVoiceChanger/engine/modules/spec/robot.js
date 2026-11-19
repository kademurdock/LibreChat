// modules/spec/robot.js - Robotizer: phase zeroing at a steady buzz pitch.
//
// Technique: STFT "robotization" (Zolzer, ed., "DAFX: Digital Audio Effects",
// Wiley 2002 and 2011, time-frequency processing chapter, after Arfib and
// Delprat). Every frame keeps its magnitudes and loses its phases, so it
// becomes one zero-phase pulse shaped like the voice's spectrum at that
// moment. Emitting those pulses at a steady rate gives a monotone buzz that
// still speaks every vowel and consonant.
// Here the pulses sit exactly one buzz period apart (pitch-synchronous
// overlap-add of zero-phase impulse responses). The impulse responses come
// from a fixed analysis grid (a quarter frame apart) and are interpolated
// between grid frames, so the cost does not grow with the buzz pitch. A
// smoothness control blends the raw magnitudes (the voice's own harmonics
// ring through as a metallic shimmer) with the cepstral spectral envelope
// (core/envelope.js: a clean buzz that only carries the vowels). The wet
// signal is level-matched to the input over the whole take.
//
// Peak factor (Oct 22 2026). Zero-phase pulses put all of a period's energy in
// one instant: the buzz had a crest factor of about 24 dB against 16 dB for
// speech, so the final limiter took about 8 dB off every robot chain. The
// pulse train is now passed through one fixed allpass dispersion: the
// low-peak-factor phases of Schroeder 1970 ("Synthesis of low-peak-factor
// signals and binary sequences with low autocorrelation", IEEE Trans.
// Information Theory 16) for an arbitrary power spectrum, where the group
// delay at each frequency is the share of the signal's power below that
// frequency times a time span, so equal energy is spread over equal time.
// The power spectrum is the robot's own long-term spectrum for this take
// (Welch average, smoothed over a sixth of an octave), the span is 0.7 of a
// buzz period but at most 12 ms (so slow buzzes stay a train of short events
// rather than audible sweeps), and the filter is centred (zero mean delay).
// Being an allpass it leaves the spectrum, the buzz pitch and the level
// alone; measured on 10 s of real speech the crest factor drops from 21-27 dB
// to 16-20 dB across every setting, within 4 dB of the input's 16.2 dB.
// Live: the same pulses from a sliding frame of 512 samples at 48 kHz (the
// largest power of two within 12 ms at any rate), one pulse per period,
// latency one frame (10.7 ms at 48 kHz), with a slow gated level matcher. The
// live version keeps zero-phase pulses (it has no whole take to measure and
// no loudness stage to protect), so it sounds a little buzzier.

import { FFT } from '../../core/fft.js'
import { hann } from '../../core/window.js'
import { cepstralEnvelope } from '../../core/envelope.js'
import { resolveParams } from '../../core/params.js'
import { convolve } from '../../core/conv.js'
import { frameSize, frameSizeAtMost, progressTo, stopAsked, DryDelay, cleanSig, sigRms, blendInto } from './_spectral.js'

const FRAME_MS = { small: 10.7, medium: 21.3, large: 42.7 }
const LIVE_MS = 12
const SPREAD_PERIODS = 0.7 // dispersion span, in buzz periods
const SPREAD_MAX_SEC = 0.012 // and never longer than this

/**
 * Schroeder low-peak-factor allpass for the power spectrum of chs (summed over
 * the channels so a stereo robot keeps one phase response), spanning D samples
 * of group delay centred on zero. Returns { h, centre } or null when there is
 * nothing to shape (silence). Exported for the tests.
 */
export function dispersionFir(chs, D) {
  let Nf = 1024
  while (Nf < 4 * D + 64) Nf *= 2
  const half = Nf >> 1
  const fft = new FFT(Nf)
  const re = new Float64Array(Nf)
  const im = new Float64Array(Nf)
  const S = new Float64Array(half + 1)
  const win = hann(Nf)
  for (let c = 0; c < chs.length; c++) {
    const y = chs[c]
    for (let s = 0; ; s += half) {
      for (let i = 0; i < Nf; i++) {
        const j = s + i
        re[i] = j < y.length ? y[j] * win[i] : 0
        im[i] = 0
      }
      fft.forward(re, im)
      for (let k = 0; k <= half; k++) S[k] += re[k] * re[k] + im[k] * im[k]
      if (s + Nf >= y.length) break
    }
  }
  // smooth over a sixth of an octave (plus or minus 6 percent) so no single
  // harmonic sets the curve, with a tiny floor so empty bands still get a slot
  const pre = new Float64Array(half + 2)
  for (let k = 0; k <= half; k++) pre[k + 1] = pre[k] + S[k]
  if (!(pre[half + 1] > 1e-20) || !Number.isFinite(pre[half + 1])) return null
  const Sm = new Float64Array(half + 1)
  let tot = 0
  for (let k = 0; k <= half; k++) {
    const a = Math.max(0, Math.floor(k / 1.06) - 1)
    const b = Math.min(half, Math.ceil(k * 1.06) + 1)
    Sm[k] = (pre[b + 1] - pre[a]) / (b - a + 1)
    tot += Sm[k]
  }
  const floor = (tot / (half + 1)) * 1e-4
  tot = 0
  for (let k = 0; k <= half; k++) {
    Sm[k] += floor
    tot += Sm[k]
  }
  // group delay = D * (power share below this bin - 1/2); phase = -its integral
  const dw = (2 * Math.PI) / Nf
  let cum = 0
  let ph = 0
  for (let k = 0; k <= half; k++) {
    const tau = D * ((cum + 0.5 * Sm[k]) / tot - 0.5)
    cum += Sm[k]
    re[k] = Math.cos(ph)
    im[k] = Math.sin(ph)
    ph -= tau * dw
  }
  im[0] = 0
  re[0] = 1
  re[half] = re[half] < 0 ? -1 : 1 // a real response needs a real Nyquist bin
  im[half] = 0
  for (let k = 1; k < half; k++) {
    re[Nf - k] = re[k]
    im[Nf - k] = -im[k]
  }
  fft.inverse(re, im)
  // centre the response (it is non-causal around 0) and taper the far ends
  const h = new Float32Array(Nf)
  const edge = Nf >> 3
  for (let n = 0; n < Nf; n++) {
    let v = re[(n - half + Nf) % Nf]
    const e = n < Nf - 1 - n ? n : Nf - 1 - n
    if (e < edge) v *= 0.5 - 0.5 * Math.cos((Math.PI * e) / edge)
    h[n] = v
  }
  return { h, centre: half }
}

/** Spread every period's energy (see the header), in place; levels kept exactly. */
function disperse(chs, sr, pitch) {
  const P = sr / pitch
  const D = Math.min(SPREAD_PERIODS * P, SPREAD_MAX_SEC * sr)
  if (!(D >= 4) || !chs.length || !chs[0].length) return chs
  const fir = dispersionFir(chs, D)
  if (!fir) return chs
  for (let c = 0; c < chs.length; c++) {
    const y = chs[c]
    const r0 = sigRms(y)
    const full = convolve(y, fir.h)
    const n = y.length
    for (let i = 0; i < n; i++) {
      const v = full[i + fir.centre]
      y[i] = v === v ? v : 0
    }
    const r1 = sigRms(y)
    if (r1 > 1e-12 && r0 > 1e-12) {
      const k = r0 / r1
      for (let i = 0; i < n; i++) y[i] *= k
    }
    cleanSig(y)
  }
  return chs
}

function makeWork(N, sr) {
  const nb = (N >> 1) + 1
  const env = new Float32Array(nb)
  return {
    N,
    fft: new FFT(N),
    w: hann(N),
    frame: new Float64Array(N),
    re: new Float64Array(nb),
    im: new Float64Array(nb),
    mag: new Float64Array(nb),
    env,
    envOpts: { out: env },
    order: Math.max(4, Math.round(0.0016 * sr)),
  }
}

// The windowed zero-phase impulse response of the frame already in wk.frame
// (windowed), written into ir (length N, centred at N/2). Returns nothing.
function irFromFrame(wk, smooth, ir) {
  const { N, fft, frame, re, im, mag, env, w } = wk
  const nb = (N >> 1) + 1
  fft.realForward(frame, re, im)
  let e1 = 0
  for (let k = 0; k < nb; k++) {
    const m = Math.sqrt(re[k] * re[k] + im[k] * im[k])
    mag[k] = m
    e1 += m * m
  }
  if (smooth > 0 && e1 > 1e-24) {
    cepstralEnvelope(mag, wk.order, wk.envOpts)
    let e2 = 0
    for (let k = 0; k < nb; k++) e2 += env[k] * env[k]
    const g = e2 > 1e-30 ? Math.sqrt(e1 / e2) : 0
    const a = 1 - smooth
    const b = smooth * g
    for (let k = 0; k < nb; k++) mag[k] = a * mag[k] + b * env[k]
  }
  for (let k = 0; k < nb; k++) {
    re[k] = k & 1 ? -mag[k] : mag[k]
    im[k] = 0
  }
  fft.realInverse(re, im, ir)
  for (let i = 0; i < N; i++) ir[i] *= w[i]
}

function frameAt(src, center, wk) {
  const { N, frame, w } = wk
  const len = src.length
  const s0 = center - (N >> 1)
  for (let i = 0; i < N; i++) {
    const j = s0 + i
    frame[i] = j >= 0 && j < len ? src[j] * w[i] : 0
  }
}

function robotChannel(src, sr, p, wk, ctx, progBase, progSpan) {
  const len = src.length
  const N = wk.N
  const half = N >> 1
  const H = N >> 2
  const P = sr / p.pitch
  let sumW2 = 0
  for (let i = 0; i < N; i++) sumW2 += wk.w[i] * wk.w[i]
  const g = Math.sqrt(P / sumW2)
  const smooth = p.smooth / 100
  const out = new Float32Array(len)
  let irA = new Float64Array(N)
  let irB = new Float64Array(N)
  let fA = -10
  let fB = -10
  const pulses = Math.ceil(len / P)
  const every = Math.max(1, Math.floor(pulses / 10))
  let j = 0
  for (let t = 0; t < len; t += P, j++) {
    const tc = Math.round(t)
    const pos = t / H
    const fa = Math.floor(pos)
    const frac = pos - fa
    if (fa !== fA) {
      if (fa === fB) {
        const tmp = irA
        irA = irB
        irB = tmp
        fA = fB
      } else {
        frameAt(src, fa * H, wk)
        irFromFrame(wk, smooth, irA)
        fA = fa
      }
      frameAt(src, (fa + 1) * H, wk)
      irFromFrame(wk, smooth, irB)
      fB = fa + 1
    }
    const a = (1 - frac) * g
    const b = frac * g
    const o0 = tc - half
    const i0 = o0 < 0 ? -o0 : 0
    const i1 = o0 + N > len ? len - o0 : N
    for (let i = i0; i < i1; i++) out[o0 + i] += a * irA[i] + b * irB[i]
    if (j % every === 0) {
      progressTo(ctx, progBase + (progSpan * t) / len)
      if (stopAsked(ctx)) break
    }
  }
  // level match the wet signal to the input over the take
  const ri = sigRms(src)
  const ro = sigRms(out)
  if (ro > 1e-12 && ri > 1e-12) {
    let k = ri / ro
    if (k > 30) k = 30
    for (let i = 0; i < len; i++) out[i] *= k
  }
  return cleanSig(out)
}

class RobotLive {
  constructor(sr, p) {
    this.sr = sr
    const N = frameSizeAtMost(sr, LIVE_MS)
    this.N = N
    this.mask = N - 1
    this.mask2 = 2 * N - 1
    this.wk = makeWork(N, sr)
    this.ir = new Float64Array(N)
    let s = 0
    for (let i = 0; i < N; i++) s += this.wk.w[i] * this.wk.w[i]
    this.sumW2 = s
    this.st = []
    for (let c = 0; c < 2; c++) {
      this.st.push({
        ring: new Float64Array(N),
        w: 0,
        acc: new Float64Array(2 * N),
        r: 0,
        ph: 0,
        P: sr / p.pitch,
        pin: 0,
        pout: 0,
        dry: new DryDelay(N),
      })
    }
    this.lvA = Math.exp(-1 / (1.5 * sr))
    this.mixC = 1 - Math.exp(-1 / (0.02 * sr))
    this.mix = p.mix / 100
    this.set(p)
  }

  set(p) {
    this.pitch = p.pitch > 1 ? p.pitch : 110
    this.smooth = p.smooth / 100
    this.tMix = p.mix / 100
  }

  reset() {
    for (let s = 0; s < this.st.length; s++) {
      const st = this.st[s]
      st.ring.fill(0)
      st.acc.fill(0)
      st.w = 0
      st.r = 0
      st.ph = 0
      st.pin = 0
      st.pout = 0
      st.dry.reset()
    }
  }

  _pulse(st) {
    const { N, mask, mask2, wk, ir } = this
    const w = wk.w
    const frame = wk.frame
    const ring = st.ring
    for (let i = 0; i < N; i++) frame[i] = ring[(st.w + i) & mask] * w[i]
    irFromFrame(wk, this.smooth, ir)
    const g = Math.sqrt(st.P / this.sumW2)
    const acc = st.acc
    for (let i = 0; i < N; i++) acc[(st.r + i) & mask2] += g * ir[i]
  }

  process(ins, outs, n) {
    const nc = outs.length
    const lvA = this.lvA
    const lvB = 1 - lvA
    for (let c = 0; c < nc && c < 2; c++) {
      const x = ins[c < ins.length ? c : ins.length - 1]
      const y = outs[c]
      const st = this.st[c]
      let mix = this.mix
      for (let i = 0; i < n; i++) {
        let v = x[i]
        if (!(v > -1e30 && v < 1e30)) v = 0
        st.ring[st.w] = v
        st.w = (st.w + 1) & this.mask
        st.ph += 1
        if (st.ph >= st.P) {
          st.ph -= st.P
          this._pulse(st)
          st.P = this.sr / this.pitch
        }
        let o = st.acc[st.r]
        st.acc[st.r] = 0
        st.r = (st.r + 1) & this.mask2
        const d = st.dry.tick(v)
        if (d * d > 1e-7) {
          st.pin = lvA * st.pin + lvB * d * d
          st.pout = lvA * st.pout + lvB * o * o
        }
        let gl = st.pout > 1e-12 && st.pin > 1e-12 ? Math.sqrt(st.pin / st.pout) : 1
        if (gl > 2.8) gl = 2.8
        if (gl < 0.35) gl = 0.35
        o *= gl
        mix += (this.tMix - mix) * this.mixC
        const r = o * mix + d * (1 - mix)
        y[i] = r > -8 && r < 8 ? r : r > 0 ? 8 : r < 0 ? -8 : 0
      }
      if (c === nc - 1 || c === 1) this.mix = mix
    }
  }
}

const robot = {
  id: 'spec.robot',
  name: 'Robotizer',
  family: 'spec',
  about: 'Turns your voice into a steady robot buzz that still says every word.',
  params: [
    { id: 'pitch', name: 'Buzz pitch', type: 'number', min: 40, max: 400, step: 1, def: 110, unit: 'hz', rand: [70, 190] },
    {
      id: 'frame', name: 'Frame size', type: 'choice', def: 'medium',
      options: [
        { v: 'small', name: 'Small and buzzy' },
        { v: 'medium', name: 'Medium' },
        { v: 'large', name: 'Large and ringing' },
      ],
    },
    { id: 'smooth', name: 'Smoothness', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [20, 90] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [80, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 2,
  process(input, params, ctx) {
    const p = resolveParams(robot, params)
    const sr = input.sr
    const nch = input.ch.length
    const len = input.ch[0] ? input.ch[0].length : 0
    if (len === 0) return { sr, ch: input.ch.map(() => new Float32Array(0)) }
    const N = frameSize(sr, FRAME_MS[p.frame] || FRAME_MS.medium)
    const wk = makeWork(N, sr)
    const wets = []
    for (let c = 0; c < nch; c++) wets.push(robotChannel(input.ch[c], sr, p, wk, ctx, (0.9 * c) / nch, 0.9 / nch))
    if (p.mix > 0 && !stopAsked(ctx)) disperse(wets, sr, p.pitch)
    const ch = []
    for (let c = 0; c < nch; c++) ch.push(blendInto(wets[c], input.ch[c], p.mix / 100))
    progressTo(ctx, 1)
    return { sr, ch }
  },
  live: {
    latency(p, sr) {
      return frameSizeAtMost(sr || 48000, LIVE_MS)
    },
    create(sr, p) {
      return new RobotLive(sr, resolveParams(robot, p))
    },
  },
}

export default robot
