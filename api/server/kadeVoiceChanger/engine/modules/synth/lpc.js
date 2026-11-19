// modules/synth/lpc.js - synth.lpc, the speech chip: your voice rebuilt from a few numbers.
//
// Technique: linear predictive coding as the 1970s and 1980s speech chips and
// secure telephones used it (Atal and Hanauer 1971; Markel and Gray 1976,
// "Linear Prediction of Speech"; the 2400 bit-per-second LPC-10 vocoder of
// US Federal Standard 1015, described by Tremain 1982, "The government
// standard linear predictive coding algorithm: LPC-10"):
// - The voice is taken down to the chip's own rate (8 or 10 kHz) with the
//   core anti-aliased resampler, high-passed at 100 Hz and pre-emphasised
//   (1 - 0.9375 z^-1, the LPC-10 value).
// - Every frame (25 ms for the toy, 22.5 ms for the secure phone, 20 ms for
//   the arcade chip) a Hamming window one and a half frames long gives
//   ten reflection coefficients by the autocorrelation method and the
//   Levinson-Durbin recursion, the frame's energy, and from the core pitch
//   tracker its pitch and a voiced or unvoiced decision.
// - Every parameter is then squeezed into a few bits, the way the chips stored
//   them. The secure phone uses the LPC-10 allocation (log area ratios for the
//   first two coefficients at 5 bits, then 5, 5, 4, 4, 4, 4, 3 and 2 bits; 5
//   bits of energy; 60 pitch values; 54 bits a frame, 44.4 frames a second:
//   exactly 2400 bits per second). The toy and the arcade chip use arcsine
//   steps for the first two coefficients and fewer bits for the rest, a 4-bit
//   energy, and a pitch table that is even in period, so high notes come out
//   in coarse steps. Unvoiced frames keep only the first four coefficients,
//   as both designs did to save bits.
// - Decoding is a ten-pole lattice filter (stable for any quantised
//   coefficient below one) driven by a pulse train at the decoded pitch or by
//   a 15-bit shift-register noise source. The toy's pulse is a short falling
//   chirp, the secure phone's an allpass-smeared click, the arcade chip's a
//   bare impulse. Parameters are stepped toward each new frame eight times a
//   frame on the toy, at every pitch pulse on the secure phone, and not at all
//   on the arcade chip, which is why the three move so differently.
// - The toy and the arcade chip end in an 8-bit converter with a
//   sample-and-hold output, whose images above 4 kHz give the metallic
//   sizzle; the arcade cabinet's amplifier is driven hard. The secure phone
//   is reconstructed cleanly and band-limited like a handset.

import { Biquad } from '../../core/biquad.js'
import { makeRng } from '../../core/rng.js'
import { bufLen } from '../../core/buf.js'
import { resampleTo } from '../../core/resample.js'
import { trackPitch } from '../../core/pitch.js'

const CHIPS = {
  toy: {
    rate: 8000, frameMs: 25, interp: 8, exc: 'chirp', kBits: [5, 5, 4, 4, 4, 4, 4, 3, 3, 3], lar: 0,
    eBits: 4, pitch: { kind: 'linear', codes: 63, tMin: 16, tMax: 160 }, out: 'hold', dac: 8, hp: 250, lp: 5200, drive: 0,
  },
  secure: {
    rate: 8000, frameMs: 22.5, interp: 'pitch', exc: 'pulse', kBits: [5, 5, 5, 5, 4, 4, 4, 4, 3, 2], lar: 2,
    eBits: 5, pitch: { kind: 'log', codes: 60, tMin: 20, tMax: 156 }, out: 'smooth', dac: 0, hp: 200, lp: 3400, drive: 0,
  },
  arcade: {
    rate: 10000, frameMs: 20, interp: 1, exc: 'impulse', kBits: [5, 5, 4, 4, 4, 3, 3, 3, 3, 2], lar: 0,
    eBits: 4, pitch: { kind: 'linear', codes: 31, tMin: 20, tMax: 200 }, out: 'hold', dac: 8, hp: 160, lp: 6500, drive: 2.5,
  },
}
const KMAX = [0.98, 0.98, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55]
const UNVOICED_K = 4
const LAR_MAX = Math.log((1 + 0.985) / (1 - 0.985))

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

/** Mid-rise uniform quantiser with 2^bits levels over [-m, m]. */
function quant(v, m, bits) {
  const L = 1 << bits
  let idx = Math.floor(((v + m) / (2 * m)) * L)
  if (idx < 0) idx = 0
  if (idx > L - 1) idx = L - 1
  return -m + ((idx + 0.5) * 2 * m) / L
}

function quantK(k, i, bits, chip) {
  const kmax = i < KMAX.length ? KMAX[i] : 0.5
  if (i < 2) {
    if (chip.lar > i) {
      // log area ratio, uniform
      const kk = clamp(k, -0.985, 0.985)
      const g = quant(Math.log((1 + kk) / (1 - kk)), LAR_MAX, bits)
      const e = Math.exp(g)
      return (e - 1) / (e + 1)
    }
    // arcsine steps: finer near plus and minus one, where hearing cares most
    const th = Math.asin(clamp(k, -kmax, kmax))
    return Math.sin(quant(th, Math.asin(kmax), bits))
  }
  return quant(clamp(k, -kmax, kmax), kmax, bits)
}

// Own excitation shapes (one pitch period's pulse, at the chip rate).
function pulseShape(kind, R) {
  let s
  if (kind === 'chirp') {
    // a short falling chirp: 4 ms sweeping 3.4 kHz down to 200 Hz at an even
    // level (a linear sweep spends equal time on every frequency, so its
    // spectrum is nearly flat), with half-millisecond tapers at both ends
    const n = Math.round(0.004 * R)
    const tap = Math.max(1, Math.round(0.0005 * R))
    s = new Float64Array(n)
    let ph = 0
    for (let i = 0; i < n; i++) {
      const f = 3400 + (200 - 3400) * (i / n)
      ph += (2 * Math.PI * Math.min(f, 0.45 * R)) / R
      let w = 1
      if (i < tap) w = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / tap)
      else if (i >= n - tap) w = 0.5 - 0.5 * Math.cos((Math.PI * (n - i - 0.5)) / tap)
      s[i] = Math.sin(ph) * w
    }
  } else if (kind === 'pulse') {
    // a click smeared by a second-order allpass (pole 0.7 at 1 kHz), 25 samples
    const n = 25
    s = new Float64Array(n)
    const r = 0.7
    const th = (2 * Math.PI * 1000) / R
    const a1 = -2 * r * Math.cos(th)
    const a2 = r * r
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    for (let i = 0; i < n; i++) {
      const x = i === 0 ? 1 : 0
      const y = a2 * x + a1 * x1 + x2 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = x
      y2 = y1
      y1 = y
      s[i] = y
    }
  } else {
    s = Float64Array.of(1)
  }
  // shaped pulses lose their DC; a bare impulse keeps it (it has nothing else)
  let mean = 0
  if (s.length > 4) {
    for (let i = 0; i < s.length; i++) mean += s[i]
    mean /= s.length
  }
  let e = 0
  for (let i = 0; i < s.length; i++) {
    s[i] -= mean
    e += s[i] * s[i]
  }
  return { s, e: e > 0 ? e : 1 }
}

function levinson(r, p, a, tmp, k) {
  a.fill(0)
  a[0] = 1
  k.fill(0)
  let err = r[0]
  if (!(err > 1e-20)) return 0
  for (let i = 1; i <= p; i++) {
    let acc = r[i]
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j]
    const ki = -acc / err
    if (!(ki > -0.999 && ki < 0.999)) break
    k[i] = ki
    for (let j = 0; j < i; j++) tmp[j] = a[j]
    for (let j = 1; j < i; j++) a[j] = tmp[j] + ki * tmp[i - j]
    a[i] = ki
    err *= 1 - ki * ki
  }
  return err > 0 ? err : 0
}

/** Analyse and quantise: returns { frames: [{ k, rms, T (period in samples), voiced }], F, order }. */
function encode(sigR, R, chip, p, f0track) {
  const n = sigR.length
  const rough = clamp(Number(p.roughness) || 0, 0, 100) / 100
  const F = Math.max(40, Math.round(((chip.frameMs * R) / 1000) * (1 + rough)))
  const Wa = Math.round(1.5 * F)
  const order = clamp(Math.round(Number(p.order) || 10), 2, 20)
  const less = Math.round(rough * 3)
  const nf = Math.max(1, Math.ceil(n / F))
  // pre-emphasised copy
  const pre = new Float64Array(n)
  let prev = 0
  for (let i = 0; i < n; i++) {
    pre[i] = sigR[i] - 0.9375 * prev
    prev = sigR[i]
  }
  const ham = new Float64Array(Wa)
  for (let i = 0; i < Wa; i++) ham[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * (i + 0.5)) / Wa)
  const fr = new Float64Array(Wa)
  const r = new Float64Array(order + 1)
  const a = new Float64Array(order + 1)
  const tmp = new Float64Array(order + 1)
  const kk = new Float64Array(order + 1)
  // reference level for the energy code: the loudest frame
  const frames = []
  let maxRms = 0
  const ptab = chip.pitch
  // pitch semitone shift and monotone
  const shift = Math.pow(2, clamp(Number(p.pitch) || 0, -24, 24) / 12)
  let median = 0
  {
    const v = []
    for (let i = 0; i < f0track.f0.length; i++) if (f0track.f0[i] > 0) v.push(f0track.f0[i])
    v.sort((x, y) => x - y)
    median = v.length ? v[v.length >> 1] : 120
  }
  const src = p.source
  for (let f = 0; f < nf; f++) {
    const c = f * F + F / 2
    const s0 = Math.round(c - Wa / 2)
    let e = 0
    for (let i = 0; i < Wa; i++) {
      const j = s0 + i
      const v = j >= 0 && j < n ? pre[j] : 0
      fr[i] = v * ham[i]
    }
    for (let i = f * F; i < Math.min(n, (f + 1) * F); i++) e += pre[i] * pre[i]
    const rms = Math.sqrt(e / F)
    for (let l = 0; l <= order; l++) {
      let s = 0
      for (let i = l; i < Wa; i++) s += fr[i] * fr[i - l]
      r[l] = s
    }
    r[0] *= 1.0001
    levinson(r, order, a, tmp, kk)
    // pitch: median of the tracker's voiced hops inside the frame
    const h0 = Math.floor((f * F) / f0track.hop)
    const h1 = Math.max(h0 + 1, Math.floor(((f + 1) * F) / f0track.hop))
    let sum = 0
    let cnt = 0
    let tot = 0
    for (let h = h0; h < h1 && h < f0track.f0.length; h++) {
      tot++
      if (f0track.f0[h] > 0) {
        sum += f0track.f0[h]
        cnt++
      }
    }
    let voiced = cnt > 0 && cnt * 2 >= tot
    let f0 = cnt ? sum / cnt : 0
    if (src === 'buzz') voiced = true
    else if (src === 'noise') voiced = false
    if (src === 'monotone') f0 = median
    frames.push({ k: Float64Array.from(kk), rms, f0, voiced })
    if (rms > maxRms) maxRms = rms
  }
  // quantise
  const eLevels = (1 << Math.max(2, chip.eBits - less)) - 1
  const eTop = maxRms > 0 ? 20 * Math.log10(maxRms) : -100
  const eRange = 54
  let lastF0 = median
  const out = []
  for (let f = 0; f < nf; f++) {
    const fr2 = frames[f]
    // energy: code 0 is silence
    let rmsQ = 0
    const db = fr2.rms > 0 ? 20 * Math.log10(fr2.rms) - eTop : -200
    if (db > -eRange - 1) {
      const step = eRange / Math.max(1, eLevels - 1)
      const code = clamp(Math.round((db + eRange) / step) + 1, 1, eLevels)
      rmsQ = Math.pow(10, (eTop - eRange + (code - 1) * step) / 20)
    }
    // pitch
    let f0 = fr2.f0 > 0 ? fr2.f0 : lastF0
    if (fr2.f0 > 0) lastF0 = fr2.f0
    f0 *= shift
    let T = R / f0
    const codes = Math.max(3, ptab.codes >> less)
    T = clamp(T, ptab.tMin, ptab.tMax)
    if (ptab.kind === 'log') {
      const lo = Math.log(ptab.tMin)
      const hi = Math.log(ptab.tMax)
      const idx = Math.round(((Math.log(T) - lo) / (hi - lo)) * (codes - 1))
      T = Math.exp(lo + (idx / (codes - 1)) * (hi - lo))
    } else {
      const idx = Math.round(((T - ptab.tMin) / (ptab.tMax - ptab.tMin)) * (codes - 1))
      T = ptab.tMin + (idx / (codes - 1)) * (ptab.tMax - ptab.tMin)
    }
    const voiced = fr2.voiced
    const keep = voiced || src === 'noise' ? order : Math.min(order, UNVOICED_K)
    const kq = new Float64Array(order + 1)
    for (let i = 1; i <= order; i++) {
      if (i > keep) break
      const bits = Math.max(1, (i - 1 < chip.kBits.length ? chip.kBits[i - 1] : 3) - less)
      kq[i] = quantK(fr2.k[i], i - 1, bits, chip)
    }
    out.push({ k: kq, rms: rmsQ, T, voiced })
  }
  return { frames: out, F, order }
}

/** Decode the frames at the chip rate. */
function decode(enc, chip, rng, n, mixed) {
  const { frames, F, order } = enc
  const out = new Float32Array(n)
  const shape = pulseShape(chip.exc, chip.rate)
  const ps = shape.s
  const kCur = new Float64Array(order + 1)
  const kFrom = new Float64Array(order + 1)
  const bst = new Float64Array(order + 1)
  let gCur = 0
  let gFrom = 0
  let TCur = frames.length ? frames[0].T : 80
  let TFrom = TCur
  let lfsr = ((rng.uint32 ? rng.uint32() : 12345) & 0x7fff) || 1
  let epochCount = 0
  let pulsePos = ps.length
  let pulseAmp = 0
  let deemph = 0
  let prevVoiced = frames.length ? frames[0].voiced : false
  const interp = chip.interp
  const subLen = typeof interp === 'number' ? Math.max(1, Math.floor(F / interp)) : Math.max(1, Math.floor(F / 4))
  const gainOf = (k, rms) => {
    let pr = 1
    for (let i = 1; i <= order; i++) pr *= 1 - k[i] * k[i]
    return rms * Math.sqrt(pr > 0 ? pr : 0)
  }
  for (let f = 0; f < frames.length; f++) {
    const fr = frames[f]
    const gTarget = gainOf(fr.k, fr.rms)
    const jump = fr.voiced !== prevVoiced || interp === 1
    for (let i = 0; i <= order; i++) kFrom[i] = jump ? fr.k[i] : kCur[i]
    gFrom = jump ? gTarget : gCur
    TFrom = jump ? fr.T : TCur
    prevVoiced = fr.voiced
    const start = f * F
    const end = Math.min(n, start + F)
    let nextUpdate = start
    for (let t = start; t < end; t++) {
      // parameter steps: on a sub-frame grid, or at each pitch pulse
      const epoch = fr.voiced && epochCount <= 0
      if (interp === 'pitch' ? (fr.voiced ? epoch : t >= nextUpdate) : t >= nextUpdate) {
        let w
        if (interp === 1) w = 1
        else if (interp === 'pitch') w = (t - start + 1) / F
        else w = Math.min(1, (Math.floor((t - start) / subLen) + 1) / interp)
        for (let i = 1; i <= order; i++) kCur[i] = kFrom[i] + w * (fr.k[i] - kFrom[i])
        gCur = gFrom + w * (gTarget - gFrom)
        TCur = TFrom + w * (fr.T - TFrom)
        nextUpdate = t + subLen
      }
      // excitation
      let ex = 0
      let buzz = 0
      if (fr.voiced || mixed) {
        if (epochCount <= 0) {
          epochCount += TCur
          pulsePos = 0
          pulseAmp = Math.sqrt(TCur / shape.e)
        }
        epochCount -= 1
        if (pulsePos < ps.length) buzz = ps[pulsePos++] * pulseAmp
      }
      // 15-bit shift register noise (taps 15 and 14)
      const bit = ((lfsr >> 0) ^ (lfsr >> 1)) & 1
      lfsr = (lfsr >> 1) | (bit << 14)
      const noise = lfsr & 1 ? 1 : -1
      if (mixed) ex = 0.8 * buzz + (fr.voiced ? 0.35 : 1) * noise
      else ex = fr.voiced ? buzz : noise
      // lattice synthesis
      let fv = ex * gCur
      for (let q = order; q >= 1; q--) {
        fv -= kCur[q] * bst[q - 1]
        let bq = kCur[q] * fv + bst[q - 1]
        if (bq < 1e-25 && bq > -1e-25) bq = 0
        bst[q] = bq
      }
      if (!(fv > -1e3 && fv < 1e3)) {
        fv = 0
        bst.fill(0)
      }
      bst[0] = fv
      // de-emphasis
      deemph = fv + 0.9375 * deemph
      if (deemph < 1e-25 && deemph > -1e-25) deemph = 0
      out[t] = deemph
    }
  }
  return out
}

export default {
  id: 'synth.lpc',
  name: 'Speech chip',
  family: 'synth',
  about: 'Your voice rebuilt by an old speech chip: a talking learning toy, an arcade game announcer, or a 2400 bit-per-second secure military phone.',
  params: [
    {
      id: 'chip', name: 'Chip', type: 'choice', def: 'toy',
      options: [
        { v: 'toy', name: 'Talking learning toy' },
        { v: 'arcade', name: 'Arcade speech chip' },
        { v: 'secure', name: 'Secure military phone' },
      ],
    },
    {
      id: 'source', name: 'Voice source', type: 'choice', def: 'auto',
      options: [
        { v: 'auto', name: 'Buzz and hiss' },
        { v: 'buzz', name: 'Buzz only' },
        { v: 'noise', name: 'Whisper' },
        { v: 'mixed', name: 'Buzz with breath' },
        { v: 'monotone', name: 'Monotone' },
      ],
    },
    { id: 'pitch', name: 'Pitch', type: 'number', min: -12, max: 12, step: 1, def: 0, unit: 'semitones', rand: [-5, 7] },
    { id: 'order', name: 'Detail', type: 'number', min: 4, max: 16, step: 1, def: 10, unit: 'count', rand: [8, 12] },
    { id: 'roughness', name: 'Roughness', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 50] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [100, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 2,
  process(input, p, ctx) {
    const n = bufLen(input)
    if (!n) return input
    const sr = input.sr
    const chip = CHIPS[p.chip] || CHIPS.toy
    const R = chip.rate
    const rng = ctx && ctx.rng ? ctx.rng : makeRng('synth.lpc')
    const nch = input.ch.length
    const mono = new Float32Array(n)
    for (let c = 0; c < nch; c++) {
      const s = input.ch[c]
      for (let i = 0; i < n; i++) {
        const v = s[i]
        mono[i] += (v === v && v < 1e6 && v > -1e6 ? v : 0) / nch
      }
    }
    let inE = 0
    for (let i = 0; i < n; i++) inE += mono[i] * mono[i]
    const inRms = Math.sqrt(inE / n)
    const outs = input.ch.map((c) => new Float32Array(c))
    const m = clamp(Number(p.mix), 0, 100) / 100
    if (!(inRms > 1e-7)) {
      // nothing to encode: the chip stays silent, the dry part passes
      for (let c = 0; c < nch; c++) {
        const o = outs[c]
        for (let i = 0; i < n; i++) o[i] = o[i] === o[i] && o[i] < 1e6 && o[i] > -1e6 ? o[i] * (1 - m) : 0
      }
      return { sr, ch: outs }
    }
    // to the chip's rate, with a 100 Hz high-pass
    let sigR = resampleTo(mono, sr, R)
    if (sigR.length < 4) sigR = new Float32Array(4)
    new Biquad('highpass', R, 100, 0.707).run(sigR)
    if (ctx && typeof ctx.progress === 'function') ctx.progress(0.2)
    const track = trackPitch(sigR, R, { minHz: 50, maxHz: 400 })
    if (ctx && typeof ctx.progress === 'function') ctx.progress(0.5)
    const enc = encode(sigR, R, chip, p, track)
    let y = decode(enc, chip, rng, sigR.length, p.source === 'mixed')
    if (ctx && typeof ctx.progress === 'function') ctx.progress(0.8)
    // level: as loud as the voice
    let e = 0
    let eIn = 0
    for (let i = 0; i < y.length; i++) {
      e += y[i] * y[i]
      eIn += sigR[i] * sigR[i]
    }
    const g = e > 1e-20 ? Math.sqrt(eIn / e) : 0
    for (let i = 0; i < y.length; i++) y[i] *= g
    // output stage of the chip
    if (chip.drive > 0) {
      const k = chip.drive
      const tk = Math.tanh(k)
      for (let i = 0; i < y.length; i++) y[i] = Math.tanh(k * y[i] * 1.6) / tk / 1.6
    }
    if (chip.dac) {
      const L = (1 << (chip.dac - 1)) - 1
      for (let i = 0; i < y.length; i++) {
        let v = Math.round(y[i] * 2 * L) / (2 * L)
        if (v > 1) v = 1
        else if (v < -1) v = -1
        y[i] = v
      }
    }
    let wet
    if (chip.out === 'hold') {
      // sample-and-hold back up to the take's rate (the chip had no smoothing filter)
      wet = new Float32Array(n)
      const ratio = R / sr
      for (let i = 0; i < n; i++) {
        const j = Math.floor(i * ratio)
        wet[i] = j < y.length ? y[j] : 0
      }
    } else {
      wet = resampleTo(y, R, sr)
      if (wet.length !== n) {
        const w2 = new Float32Array(n)
        w2.set(wet.subarray(0, Math.min(n, wet.length)))
        wet = w2
      }
    }
    const nyq = sr * 0.45
    new Biquad('highpass', sr, chip.hp, 0.707).run(wet)
    new Biquad('lowpass', sr, Math.min(chip.lp, nyq), 0.707).run(wet)
    if (chip.out === 'smooth') {
      new Biquad('highpass', sr, chip.hp, 0.707).run(wet)
      new Biquad('lowpass', sr, Math.min(chip.lp, nyq), 0.707).run(wet)
    }
    for (let i = 0; i < n; i++) if (!(wet[i] > -8 && wet[i] < 8)) wet[i] = 0
    for (let c = 0; c < nch; c++) {
      const o = outs[c]
      for (let i = 0; i < n; i++) {
        const d = o[i] === o[i] && o[i] < 1e6 && o[i] > -1e6 ? o[i] : 0
        o[i] = d + m * (wet[i] - d)
      }
    }
    if (ctx && typeof ctx.progress === 'function') ctx.progress(1)
    return { sr, ch: outs }
  },
}
