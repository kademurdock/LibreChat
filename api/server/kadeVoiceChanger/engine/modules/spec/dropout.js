// modules/spec/dropout.js - Glitchy call: lost packets and the tricks that hide them.
//
// Technique: packet loss with concealment, as on internet calls.
// - Loss pattern: the two-state Gilbert-Elliott model (Gilbert 1960, "Capacity
//   of a burst-noise channel"; Elliott 1963), the standard model of bursty
//   network loss. 20 ms packets; the chance of staying lost sets the mean
//   burst length, and the chance of falling into loss is solved so the
//   long-run loss rate equals the setting.
// - Concealment, chosen per gap:
//   "Repeat the last bit" plays the last good packet again and again with
//   short crossfades, fading out over a long gap (the packet-repetition
//   method of early voice-over-IP, ITU-T G.711 Appendix I in its simplest form);
//   "Robot buzz" holds the last good frame's spectrum and plays it as a
//   monotone pulse train at that frame's own pitch (estimated by
//   autocorrelation): the zero-phase pulses of spec.robot, which is the
//   metallic "robot" sound of model-based concealment on weak calls;
//   "Silence" simply drops the packet with tiny fades.
//   "A bit of each" picks one of the three for every gap.
// Every gap is crossfaded in and out over 2.5 ms against the real signal.

import { FFT } from '../../core/fft.js'
import { hann } from '../../core/window.js'
import { cepstralEnvelope } from '../../core/envelope.js'
import { resolveParams } from '../../core/params.js'
import { frameSize, rngOf, progressTo, cleanSig } from './_spectral.js'

const MODES = ['repeat', 'robot', 'silence']

function lossPattern(nPk, lossPct, burstMs, packetMs, rng) {
  const lost = new Uint8Array(nPk)
  const L = Math.min(0.95, lossPct / 100)
  if (!(L > 0)) return lost
  const r = Math.min(1, packetMs / Math.max(packetMs, burstMs))
  let pIn = (L * r) / (1 - L)
  if (pIn > 1) pIn = 1
  let bad = false
  for (let i = 0; i < nPk; i++) {
    if (bad) bad = rng.next() >= r
    else bad = rng.next() < pIn
    lost[i] = bad ? 1 : 0
  }
  return lost
}

function estimatePitch(seg, sr) {
  const n = seg.length
  const lo = Math.max(2, Math.floor(sr / 400))
  const hi = Math.min(n - 2, Math.ceil(sr / 70))
  let r0 = 0
  for (let i = 0; i < n; i++) r0 += seg[i] * seg[i]
  if (!(r0 > 1e-12) || hi <= lo) return 0
  let best = 0
  let bl = 0
  for (let l = lo; l <= hi; l++) {
    let s = 0
    for (let i = l; i < n; i++) s += seg[i] * seg[i - l]
    const v = s / r0
    if (v > best) {
      best = v
      bl = l
    }
  }
  return best > 0.3 ? sr / bl : 0
}

// Robot-buzz concealment signal of `count` samples from the frame ending at `end`.
function robotFill(src, end, count, sr, N, fft, w, rng) {
  const out = new Float32Array(count)
  const nb = (N >> 1) + 1
  const frame = new Float64Array(N)
  const s0 = end - N
  for (let i = 0; i < N; i++) {
    const j = s0 + i
    frame[i] = j >= 0 && j < src.length ? src[j] : 0
  }
  let f0 = estimatePitch(frame, sr)
  if (!(f0 > 0)) f0 = 110 + 60 * rng.next()
  for (let i = 0; i < N; i++) frame[i] *= w[i]
  const re = new Float64Array(nb)
  const im = new Float64Array(nb)
  fft.realForward(frame, re, im)
  const mag = new Float64Array(nb)
  let e1 = 0
  for (let k = 0; k < nb; k++) {
    mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k])
    e1 += mag[k] * mag[k]
  }
  if (!(e1 > 1e-20)) return out
  const env = cepstralEnvelope(mag, Math.max(4, Math.round(0.0016 * sr)))
  let e2 = 0
  for (let k = 0; k < nb; k++) e2 += env[k] * env[k]
  const g = e2 > 0 ? Math.sqrt(e1 / e2) : 0
  for (let k = 0; k < nb; k++) {
    const m = 0.4 * mag[k] + 0.6 * g * env[k]
    re[k] = k & 1 ? -m : m
    im[k] = 0
  }
  const ir = new Float64Array(N)
  fft.realInverse(re, im, ir)
  for (let i = 0; i < N; i++) ir[i] *= w[i]
  const P = sr / f0
  let sw2 = 0
  for (let i = 0; i < N; i++) sw2 += w[i] * w[i]
  const gain = Math.sqrt(P / sw2) * 0.8
  const half = N >> 1
  for (let t = 0; t < count + half; t += P) {
    const tc = Math.round(t)
    // a slow fade, about -1.5 dB per 20 ms
    const fade = Math.pow(10, (-1.5 * (t / sr / 0.02)) / 20)
    for (let i = 0; i < N; i++) {
      const o = tc - half + i
      if (o >= 0 && o < count) out[o] += gain * fade * ir[i]
    }
  }
  return out
}

function repeatFill(src, start, count, pk) {
  const out = new Float32Array(count)
  const s0 = Math.max(0, start - pk)
  const seg = src.subarray(s0, start)
  const L = seg.length
  if (L < 8) return out
  const xf = Math.max(2, Math.min(L >> 2, Math.round(L * 0.12)))
  const stepLen = L - xf
  let rep = 0
  for (let pos = 0; pos < count; pos += stepLen, rep++) {
    const g = rep < 2 ? 1 : Math.pow(10, (-2.5 * (rep - 1)) / 20)
    if (g < 0.02) break
    for (let i = 0; i < L && pos + i < count; i++) {
      let w = 1
      if (pos > 0 && i < xf) w = Math.sin((0.5 * Math.PI * (i + 0.5)) / xf)
      if (i >= stepLen) w *= Math.cos((0.5 * Math.PI * (i - stepLen + 0.5)) / xf)
      out[pos + i] += seg[i] * g * w
    }
  }
  return out
}

const dropout = {
  id: 'spec.dropout',
  name: 'Glitchy call',
  family: 'spec',
  about: 'Bits of your voice drop out like a bad call, hidden by stutters, robot buzz or silence.',
  params: [
    { id: 'loss', name: 'Packet loss', type: 'number', min: 0, max: 60, step: 1, def: 15, unit: 'percent', rand: [6, 30] },
    { id: 'burst', name: 'Burst length', type: 'number', min: 20, max: 500, step: 10, def: 60, unit: 'ms', rand: [20, 160] },
    {
      id: 'conceal', name: 'Gaps filled with', type: 'choice', def: 'robot',
      options: [
        { v: 'robot', name: 'Robot buzz' },
        { v: 'repeat', name: 'Repeat the last bit' },
        { v: 'silence', name: 'Silence' },
        { v: 'mixed', name: 'A bit of each' },
      ],
    },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 2,
  process(input, params, ctx) {
    const p = resolveParams(dropout, params)
    const sr = input.sr
    const nch = input.ch.length
    const len = input.ch[0] ? input.ch[0].length : 0
    if (len === 0) return { sr, ch: input.ch.map(() => new Float32Array(0)) }
    const rng = rngOf(ctx, 'spec.dropout')
    const pk = Math.max(16, Math.round(0.02 * sr))
    const nPk = Math.ceil(len / pk)
    const lost = lossPattern(nPk, p.loss, p.burst, 20, rng.fork('loss'))
    // gaps as runs of lost packets, each with its concealment
    const gaps = []
    const mr = rng.fork('modes')
    for (let i = 0; i < nPk; ) {
      if (!lost[i]) {
        i++
        continue
      }
      let j = i
      while (j < nPk && lost[j]) j++
      const mode = p.conceal === 'mixed' ? MODES[mr.int(3)] : p.conceal
      gaps.push({ s: i * pk, e: Math.min(len, j * pk), mode, seed: mr.next() })
      i = j
    }
    const N = frameSize(sr, 21.3)
    const fft = new FFT(N)
    const w = hann(N)
    const xf = Math.max(2, Math.round(0.0025 * sr))
    const ch = []
    for (let c = 0; c < nch; c++) {
      const src = input.ch[c]
      const out = new Float32Array(src)
      const fr = rng.fork('fill' + c)
      for (const gp of gaps) {
        const count = gp.e - gp.s + xf
        let fill
        if (gp.mode === 'robot') fill = robotFill(src, gp.s, count, sr, N, fft, w, fr)
        else if (gp.mode === 'repeat') fill = repeatFill(src, gp.s, count, pk)
        else fill = new Float32Array(count)
        for (let i = 0; i < count; i++) {
          const o = gp.s + i
          if (o >= len) break
          let a
          if (i < xf) a = (i + 0.5) / xf
          else if (o >= gp.e) a = 1 - (o - gp.e + 0.5) / xf
          else a = 1
          out[o] = src[o] * (1 - a) + fill[i] * a
        }
      }
      ch.push(cleanSig(out))
      progressTo(ctx, (c + 1) / nch)
    }
    return { sr, ch }
  },
}

export default dropout
