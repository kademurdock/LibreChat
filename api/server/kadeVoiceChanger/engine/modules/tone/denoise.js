// modules/tone/denoise.js - tone.denoise, noise reduction without musical noise.
//
// Technique: short-time spectral attenuation in the STFT domain (about 21 ms
// Hann frames, 75 percent overlap, core/stft.js weighted overlap-add), with
// the three published ingredients that keep it from "twinkling":
// 1. Decision-directed a priori SNR estimation and the log-spectral
//    amplitude gain of Ephraim and Malah ("Speech enhancement using a
//    minimum mean-square error log-spectral amplitude estimator", IEEE
//    ASSP 1985). Cappe ("Elimination of the musical noise phenomenon with
//    the Ephraim and Malah noise suppressor", IEEE SAP 1994) showed that
//    the decision-directed estimate is what removes musical noise: it
//    follows speech quickly but changes slowly in noise-only bins. The
//    exponential integral in the gain uses the Swamee-Ohija approximation.
// 2. Frame-adaptive smoothing of the gains across frequency after Esch and
//    Vary ("Efficient musical noise suppression for speech enhancement
//    systems", ICASSP 2009): when a frame is mostly noise (little of its
//    power survives the gains) the gains are averaged over a wide band, so
//    lone surviving bins (the tones of musical noise) are flattened; in
//    speech frames the smoothing stays narrow so words keep their detail.
// 3. A slow release on each gain (it may rise at once but falls only by a
//    set amount per frame) and a floor ("Reduce noise by"), so the noise
//    that remains is the same noise, quieter, never a warble.
// The noise profile is learned from the take itself: by default from its
// quiet moments (the average spectrum of the quietest 15 percent of
// frames), or from the single quietest half second, or from the first half
// second (room tone recorded before talking), or tracked continuously with
// minimum statistics (Rainer Martin, "Noise power spectral density
// estimation based on optimal smoothing and minimum statistics", IEEE SAP
// 2001: the minimum of the smoothed power over a sliding 2.4 s window,
// corrected for its bias) for noise that changes.
// Stereo is linked: one set of gains from both channels' power, applied to
// both, so the image never wobbles. "Hear what is removed" plays the
// complement (one minus the gain), which is exactly the part taken away.

import { bufLen } from '../../core/buf.js'
import { fftOf } from '../../core/fft.js'
import { stftLayout, spectralProcess } from '../../core/stft.js'
import { hann } from '../../core/window.js'

function frameSize(sr) {
  const want = sr * 0.0213
  let n = 128
  while (n * 1.4142 < want) n <<= 1
  return Math.min(4096, n)
}

// E1(x), Swamee and Ohija 2003, good to about half a percent
function expint(x) {
  const v = x < 1e-12 ? 1e-12 : x
  if (v > 60) return 0
  const A = Math.log((0.56146 / v + 0.65) * (1 + v))
  const B = v * v * v * v * Math.exp(7.7 * v) * Math.pow(2 + v, 3.7)
  return Math.pow(Math.pow(A, -7.7) + B, -0.13)
}

const MS_BIAS = 3.1 // mean over minimum of the smoothed periodogram, 2.4 s window (measured on white noise)

function boxSmooth(src, dst, nb, h, tmp) {
  if (h <= 0) {
    for (let k = 0; k < nb; k++) dst[k] = src[k]
    return
  }
  // prefix sums
  tmp[0] = 0
  for (let k = 0; k < nb; k++) tmp[k + 1] = tmp[k] + src[k]
  for (let k = 0; k < nb; k++) {
    const a = k - h < 0 ? 0 : k - h
    const b = k + h + 1 > nb ? nb : k + h + 1
    dst[k] = (tmp[b] - tmp[a]) / (b - a)
  }
}

export default {
  id: 'tone.denoise',
  name: 'Noise reduction',
  family: 'tone',
  about: 'Removes steady hiss, hum and room noise. It learns the noise from your own pauses and smooths the result so nothing warbles.',
  params: [
    { id: 'reduce', name: 'Reduce noise by', type: 'number', min: 0, max: 40, step: 1, def: 15, unit: 'db' },
    {
      id: 'learn', name: 'Learn the noise from', type: 'choice', def: 'quiet',
      options: [
        { v: 'quiet', name: 'The quiet moments' },
        { v: 'stretch', name: 'The quietest half second' },
        { v: 'start', name: 'The first half second' },
        { v: 'follow', name: 'Keep listening, for changing noise' },
      ],
    },
    { id: 'sensitivity', name: 'Sensitivity', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent' },
    { id: 'smoothing', name: 'Smoothing', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent' },
    { id: 'listen', name: 'Hear what is removed', type: 'bool', def: false },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 3,
  surprise: false,
  process(input, p, ctx) {
    const n = bufLen(input)
    if (!n) return input
    const sr = input.sr
    const chs = input.ch
    const nch = chs.length
    const progress = ctx && typeof ctx.progress === 'function' ? ctx.progress : null
    const cancelled = ctx && typeof ctx.cancelled === 'function' ? ctx.cancelled : null
    const N = frameSize(sr)
    const hop = N >> 2
    const opts = { size: N, hop, window: 'hann' }
    const lay = stftLayout(n, opts)
    const frames = lay.frames
    const pad = lay.pad
    const nb = (N >> 1) + 1
    const win = hann(N)
    const fft = fftOf(N)
    const frame = new Float64Array(N)
    const re = new Float64Array(nb)
    const im = new Float64Array(nb)

    // ---- pass A: power spectra, mean over channels
    const P = new Float32Array(frames * nb)
    const E = new Float64Array(frames) // total power, to spot digital silence
    const EL = new Float64Array(frames) // mean log power: every bin votes equally
    for (let f = 0; f < frames; f++) {
      const start = f * hop - pad
      const o = f * nb
      for (let c = 0; c < nch; c++) {
        const x = chs[c]
        for (let i = 0; i < N; i++) {
          const j = start + i
          let v = j >= 0 && j < n ? x[j] : 0
          if (!(v < 1e6 && v > -1e6)) v = 0
          frame[i] = v * win[i]
        }
        fft.realForward(frame, re, im)
        for (let k = 0; k < nb; k++) P[o + k] += (re[k] * re[k] + im[k] * im[k]) / nch
      }
      let e = 0
      let el = 0
      for (let k = 0; k < nb; k++) {
        e += P[o + k]
        el += Math.log(P[o + k] + 1e-30)
      }
      E[f] = e
      EL[f] = el / nb
      if (cancelled && (f & 255) === 0 && cancelled()) return input
    }
    if (progress) progress(0.3)

    // ---- noise profile
    const reduceDb = Math.max(0, Math.min(60, +p.reduce || 0))
    const gMin = Math.pow(10, -reduceDb / 20)
    const sens = Math.max(0, Math.min(1, (+p.sensitivity || 0) / 100))
    const smooth = Math.max(0, Math.min(1, (+p.smoothing || 0) / 100))
    const beta = Math.pow(2, 2 * sens - 0.5)
    const alpha = 0.96 + 0.025 * smooth
    const hNarrow = Math.round(2 * smooth)
    const hWide = Math.round(4 + 12 * smooth)
    const rel = Math.exp(-hop / (((10 + 50 * smooth) / 1000) * sr))
    const listen = p.listen === true
    let meanAll = 0
    for (let f = 0; f < frames; f++) meanAll += E[f]
    meanAll /= frames * nb
    if (!(meanAll > 1e-24) || reduceDb === 0) {
      if (listen) for (let c = 0; c < nch; c++) chs[c].fill(0)
      return input
    }
    const floorN = 1e-12 * meanAll + 1e-30
    const noise = new Float64Array(nb)
    const avgFrames = (pick) => {
      noise.fill(0)
      let cnt = 0
      for (let f = 0; f < frames; f++) {
        if (!pick(f)) continue
        const o = f * nb
        for (let k = 0; k < nb; k++) noise[k] += P[o + k]
        cnt++
      }
      if (cnt) for (let k = 0; k < nb; k++) noise[k] /= cnt
      return cnt
    }
    // quietest 15 percent of frames, ranked by mean log power so that a
    // noise whose power sits in a few bins (pink, rumble) is not picked
    // only where those bins happen to dip
    const quietMoments = () => {
      const vals = []
      for (let f = 0; f < frames; f++) if (E[f] > 1e-18) vals.push(EL[f])
      if (!vals.length) return 0
      vals.sort((a, b) => a - b)
      const lim = vals[Math.min(vals.length - 1, Math.max(0, Math.round(0.15 * (vals.length - 1))))]
      return avgFrames((f) => E[f] > 1e-18 && EL[f] <= lim)
    }
    const mode = p.learn
    const follow = mode === 'follow'
    if (mode === 'stretch') {
      const W = Math.max(1, Math.min(frames, Math.round((0.5 * sr) / hop)))
      let best = -1
      let bestE = Infinity
      let s = 0
      let zeros = 0
      for (let f = 0; f < frames; f++) {
        s += EL[f]
        if (!(E[f] > 1e-18)) zeros++
        if (f >= W) {
          s -= EL[f - W]
          if (!(E[f - W] > 1e-18)) zeros--
        }
        if (f >= W - 1 && zeros === 0 && s < bestE) {
          bestE = s
          best = f - W + 1
        }
      }
      if (best < 0 || !avgFrames((f) => f >= best && f < best + W)) quietMoments()
    } else if (mode === 'start') {
      const endS = 0.5 * sr
      const cnt = avgFrames((f) => f * hop - pad + N / 2 < endS && E[f] > 1e-18)
      if (!cnt) quietMoments()
    } else if (!follow) {
      quietMoments()
    }
    for (let k = 0; k < nb; k++) if (!(noise[k] > floorN)) noise[k] = floorN

    // minimum statistics state (follow mode)
    const U = 8
    const V = Math.max(1, Math.round((0.3 * sr) / hop))
    const aS = Math.exp(-hop / (0.03 * sr))
    const S = follow ? new Float64Array(nb) : null
    const minCur = follow ? new Float64Array(nb).fill(Infinity) : null
    const ring = follow ? new Float64Array(U * nb).fill(Infinity) : null
    const nRaw = follow ? new Float64Array(nb) : null
    let ringPos = 0
    let vCount = 0

    // ---- pass B: gains (written over P)
    const aPrev = new Float64Array(nb)
    const gRaw = new Float64Array(nb)
    const gSm = new Float64Array(nb)
    const gOld = new Float64Array(nb).fill(1)
    const tmp = new Float64Array(nb + 1)
    let firstLive = true
    // frames that hang over either end of the take are partly zeros; the
    // tracker only learns from whole frames, and starts from the first one
    const fFirst = Math.ceil(pad / hop)
    const fLast = Math.floor((n - N + pad) / hop)
    if (follow && fFirst < frames) {
      const o0 = Math.min(fFirst, frames - 1) * nb
      for (let k = 0; k < nb; k++) noise[k] = P[o0 + k] > floorN ? P[o0 + k] : floorN
    }
    for (let f = 0; f < frames; f++) {
      const o = f * nb
      if (follow && f >= fFirst && f <= fLast) {
        for (let k = 0; k < nb; k++) {
          const pk = P[o + k]
          S[k] = firstLive ? pk : aS * S[k] + (1 - aS) * pk
          if (S[k] < minCur[k]) minCur[k] = S[k]
        }
        if (E[f] > 1e-18) firstLive = false
        if (++vCount >= V) {
          vCount = 0
          ring.set(minCur, ringPos * nb)
          ringPos = (ringPos + 1) % U
          minCur.fill(Infinity)
        }
        for (let k = 0; k < nb; k++) {
          let m = minCur[k]
          for (let u = 0; u < U; u++) {
            const r = ring[u * nb + k]
            if (r < m) m = r
          }
          nRaw[k] = m === Infinity ? S[k] : MS_BIAS * m
        }
        // a minimum is a noisy estimate bin by bin; average it over 7 bins
        boxSmooth(nRaw, noise, nb, 3, tmp)
        for (let k = 0; k < nb; k++) if (!(noise[k] > floorN)) noise[k] = floorN
      }
      let sumP = 0
      let sumOut = 0
      for (let k = 0; k < nb; k++) {
        const pk = P[o + k]
        const nk = beta * noise[k]
        const gam = pk / nk
        let xi = alpha * (aPrev[k] / nk) + (1 - alpha) * (gam > 1 ? gam - 1 : 0)
        if (xi < 1e-3) xi = 1e-3
        const v = (xi * gam) / (1 + xi)
        let g = (xi / (1 + xi)) * Math.exp(0.5 * expint(v))
        if (!(g < 1)) g = 1
        if (g < gMin) g = gMin
        gRaw[k] = g
        aPrev[k] = g * g * pk
        sumP += pk
        sumOut += g * g * pk
      }
      // frame-adaptive smoothing across frequency
      const zeta = sumP > 0 ? sumOut / sumP : 0
      const zT = 0.5
      const h = zeta >= zT ? hNarrow : hNarrow + Math.round((1 - zeta / zT) * (hWide - hNarrow))
      // noise frames are smoothed in decibels (a geometric mean), so a few
      // loud noise bins cannot lift the whole band above the floor; speech
      // frames are smoothed plainly, which keeps weak harmonics
      const logDomain = h > hNarrow
      if (logDomain) for (let k = 0; k < nb; k++) gRaw[k] = Math.log(gRaw[k])
      boxSmooth(gRaw, gSm, nb, h, tmp)
      for (let k = 0; k < nb; k++) {
        let g = logDomain ? Math.exp(gSm[k]) : gSm[k]
        const held = gOld[k] * rel
        if (g < held) g = held
        if (g < gMin) g = gMin
        if (g > 1) g = 1
        gOld[k] = g
        P[o + k] = listen ? 1 - g : g
      }
      if (cancelled && (f & 255) === 0 && cancelled()) return input
    }
    if (progress) progress(0.5)

    // ---- pass C: apply the gains to every channel
    for (let c = 0; c < nch; c++) {
      chs[c] = spectralProcess(chs[c], opts, (r, i, f) => {
        const o = f * nb
        for (let k = 0; k < nb; k++) {
          const g = P[o + k]
          r[k] *= g
          i[k] *= g
        }
      })
      if (progress) progress(0.5 + (0.5 * (c + 1)) / nch)
    }
    return input
  },
}
