// modules/tone/declick.js - tone.declick, click and pop removal.
//
// Technique: the autoregressive method of Godsill and Rayner, "Digital
// Audio Restoration" (Springer 1998), chapters 5 and 6.
// Detection: every 20 ms block gets a linear prediction model (order about
// sr / 2000 + 8, autocorrelation method, core/envelope.js lpc) fitted over a
// 40 ms window. Speech and music are predictable from their recent past; a
// click is not, so it stands out in the prediction error. A sample is a
// candidate when its error exceeds a multiple of the block's robust spread
// (1.4826 times the median absolute error). Voiced speech also leaves
// spikes in the error, one per glottal pulse, so a candidate must also be
// isolated: within 20 ms on either side (skipping its own 1.5 ms), at most
// two samples may come within a factor of it. A pulse train always has
// company; a mouth click or a record tick does not.
// Repair: each click (merged and padded a little, and no longer than
// "Longest click") is filled by least-squares AR interpolation (Janssen,
// Veldhuis and Vries, "Adaptive interpolation of discrete-time signals that
// can be modeled as autoregressive processes", IEEE ASSP 1986): with the
// model refitted on the good samples around the gap, the missing samples
// are the ones that make the prediction error smallest. The normal
// equations are a banded Toeplitz system (bandwidth = model order), solved
// with a banded Cholesky factorisation, so even a 20 ms pop costs little.
// A click's prediction error is sharpest at its start while the click may
// ring on, so after each fill the error just past it is measured again and
// the fill grows until nothing of the click is left (or it would pass
// "Longest click", which means it is a word sound). A burst that rises out
// of quiet into sustained sound is a plosive ("t", "k", "p") or the start
// of a word, never a click, and is left alone.
// "Hear what is removed" plays only the clicks that were taken out.
//
// Offline only.

import { bufLen } from '../../core/buf.js'
import { lpc } from '../../core/envelope.js'

function order(sr) {
  return Math.max(8, Math.min(40, Math.round(sr / 2000) + 8))
}

function median(arr, n, tmp) {
  for (let i = 0; i < n; i++) tmp[i] = arr[i]
  const v = tmp.subarray(0, n).sort()
  return n ? v[n >> 1] : 0
}

/** Solve the banded symmetric system M x = b (M given as R(|i-j|), |i-j| <= p) in place in b. */
function solveBanded(R, p, m, b, Lb) {
  // Lb: m * (p + 1), Lb[i * (p + 1) + k] = L(i, i - k)
  const w = p + 1
  for (let i = 0; i < m; i++) {
    const j0 = i - p > 0 ? i - p : 0
    for (let j = j0; j <= i; j++) {
      let s = R[i - j]
      // L(i, k) is zero for k < i - p, and j <= i, so k starts at i - p
      for (let k = j0; k < j; k++) s -= Lb[i * w + (i - k)] * Lb[j * w + (j - k)]
      if (i === j) Lb[i * w] = Math.sqrt(s > 1e-30 ? s : 1e-30)
      else Lb[i * w + (i - j)] = s / Lb[j * w]
    }
  }
  // forward: L z = b
  for (let i = 0; i < m; i++) {
    let s = b[i]
    const k0 = i - p > 0 ? i - p : 0
    for (let k = k0; k < i; k++) s -= Lb[i * w + (i - k)] * b[k]
    b[i] = s / Lb[i * w]
  }
  // back: L^T x = z
  for (let i = m - 1; i >= 0; i--) {
    let s = b[i]
    const k1 = i + p < m - 1 ? i + p : m - 1
    for (let k = i + 1; k <= k1; k++) s -= Lb[k * w + (k - i)] * b[k]
    b[i] = s / Lb[i * w]
  }
}

/**
 * Least-squares AR interpolation of y[r0..r1] (inclusive) from the samples
 * around it. Leaves the filled values in work.rhs and the model in work.a.
 * Returns false when there is not enough context or the answer is not sane.
 */
function lsarFill(y, n, r0, r1, P, K, work) {
  const m = r1 - r0 + 1
  const s0 = Math.max(0, r0 - K)
  const s1 = Math.min(n - 1, r1 + K)
  if (r0 - s0 < P || s1 - r1 < P) return false
  const seg = work.seg
  const L = s1 - s0 + 1
  if (L > seg.length || m + 2 > work.rhs.length) return false
  for (let i = s0; i <= s1; i++) seg[i - s0] = i >= r0 && i <= r1 ? 0 : y[i]
  // model from the context with the gap left out
  const a = lpc(seg.subarray(0, L), P).a
  work.a = a
  const R = work.R
  for (let d = 0; d <= P; d++) {
    let s = 0
    for (let q = 0; q + d <= P; q++) s += a[q] * a[q + d]
    R[d] = s
  }
  R[0] += 1e-9 * R[0] + 1e-20
  // prediction error of the known samples alone (unknowns set to zero)
  const e0 = work.e0
  for (let q = 0; q < m + P; q++) {
    const tt = r0 + q
    let s = 0
    for (let d = 0; d <= P; d++) s += a[d] * seg[tt - d - s0]
    e0[q] = s
  }
  const rhs = work.rhs
  for (let i = 0; i < m; i++) {
    let s = 0
    for (let d = 0; d <= P; d++) s += a[d] * e0[i + d]
    rhs[i] = -s
  }
  solveBanded(R, P, m, rhs, work.Lb)
  // never put back something wilder than the surroundings
  let ctxPk = 0
  for (let i = s0; i <= s1; i++) {
    if (i >= r0 && i <= r1) continue
    const v = y[i] < 0 ? -y[i] : y[i]
    if (v > ctxPk) ctxPk = v
  }
  const lim = 2 * ctxPk + 1e-6
  for (let i = 0; i < m; i++) {
    const v = rhs[i]
    if (!(v === v) || v > lim || v < -lim) return false
  }
  return true
}

function rmsOf(y, a, b) {
  let e = 0
  for (let i = a; i < b; i++) e += y[i] * y[i]
  return b > a ? Math.sqrt(e / (b - a)) : 0
}

function repairChannel(x, sr, p) {
  const n = x.length
  const P = order(sr)
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const v = x[i]
    y[i] = v < 1e6 && v > -1e6 ? v : 0
  }
  if (n < 4 * P) return y
  const sens = Math.max(0, Math.min(1, (+p.sensitivity || 0) / 100))
  const thr = 12 - 8 * sens
  const kiso = 2.6 - 1.4 * sens
  const maxLen = Math.max(2, Math.round(((+p.maxLen || 3) * sr) / 1000))
  // ---- residual with block-wise models
  const B = Math.max(64, Math.round(0.02 * sr))
  const nB = Math.ceil(n / B)
  const e = new Float64Array(n)
  const sig = new Float64Array(nB)
  const ae = new Float64Array(B)
  const tmp = new Float64Array(B)
  for (let b = 0; b < nB; b++) {
    const t0 = b * B
    const t1 = Math.min(n, t0 + B)
    const w0 = Math.max(0, t0 - (B >> 1))
    const w1 = Math.min(n, t1 + (B >> 1))
    const a = lpc(y.subarray(w0, w1), P, { window: 'hann' }).a
    for (let t = t0; t < t1; t++) {
      let s = y[t]
      const top = t < P ? t : P
      for (let j = 1; j <= top; j++) s += a[j] * y[t - j]
      e[t] = s
      ae[t - t0] = s < 0 ? -s : s
    }
    sig[b] = 1.4826 * median(ae, t1 - t0, tmp)
  }
  // a floor for nearly silent blocks, so a click in a pause is still found
  const live = []
  for (let b = 0; b < nB; b++) if (sig[b] > 1e-9) live.push(sig[b])
  live.sort((u, v) => u - v)
  const sFloor = Math.max(1e-6, live.length ? 0.05 * live[live.length >> 1] : 1e-6)
  // ---- detection
  const flag = new Uint8Array(n)
  const ex = Math.max(1, Math.round(0.0015 * sr))
  const nbR = Math.round(0.02 * sr)
  for (let t = 0; t < n; t++) {
    const s = sig[(t / B) | 0]
    const sg = s > sFloor ? s : sFloor
    const v = e[t] < 0 ? -e[t] : e[t]
    if (v <= thr * sg) continue
    // isolation: count close rivals in the neighbourhood
    const lim = v / kiso
    let cnt = 0
    const a0 = t - nbR > 0 ? t - nbR : 0
    const b1 = t + nbR < n ? t + nbR : n - 1
    for (let j = a0; j <= b1 && cnt <= 2; j++) {
      if (j > t - ex && j < t + ex) {
        j = t + ex - 1
        continue
      }
      const u = e[j] < 0 ? -e[j] : e[j]
      if (u > lim) cnt++
    }
    if (cnt <= 2) flag[t] = 1
  }
  // ---- regions, each repaired and then checked: a click's prediction
  // error is sharpest at its start while the click itself may ring on, so
  // after every fill the error just past the fill is measured again and
  // the fill grows until nothing of the click is left
  const gap = Math.max(P >> 1, Math.round(0.0005 * sr))
  const padPre = 2
  const padPost = 2
  const step = Math.max(2, Math.round(0.0002 * sr))
  const K = Math.max(3 * P, Math.round(0.004 * sr))
  const mMax = maxLen + padPre + padPost
  const guardN = Math.max(8, Math.round(0.005 * sr))
  const work = {
    R: new Float64Array(P + 1),
    Lb: new Float64Array((mMax + 2) * (P + 1)),
    rhs: new Float64Array(mMax + 2),
    e0: new Float64Array(mMax + 2 + P),
    seg: new Float64Array(mMax + 2 * K + 4),
    a: null,
  }
  let t = 0
  while (t < n) {
    if (!flag[t]) {
      t++
      continue
    }
    let r0 = t
    let r1 = t
    let j = t + 1
    while (j < n && j - r1 <= gap) {
      if (flag[j]) r1 = j
      j++
    }
    t = r1 + 1
    r0 = Math.max(0, r0 - padPre)
    r1 = Math.min(n - 1, r1 + padPost)
    if (r1 - r0 + 1 > mMax) continue // too long for a click: a word sound
    const sgm = sig[(r0 / B) | 0] > sFloor ? sig[(r0 / B) | 0] : sFloor
    let done = false
    for (let iter = 0; iter < 24 && !done; iter++) {
      if (!lsarFill(y, n, r0, r1, P, K, work)) break
      // prediction error just after the fill, with the filled samples as past
      const a = work.a
      let last = -1
      const tEnd = Math.min(n - 1, r1 + P)
      for (let q = r1 + 1; q <= tEnd; q++) {
        let s = 0
        for (let d = 0; d <= P; d++) {
          const idx = q - d
          s += a[d] * (idx >= r0 && idx <= r1 ? work.rhs[idx - r0] : y[idx])
        }
        if ((s < 0 ? -s : s) > 0.5 * thr * sgm) last = q
      }
      if (last < 0) done = true
      else {
        const nr1 = Math.min(n - 1, Math.max(last, r1 + step))
        if (nr1 - r0 + 1 > mMax) break
        r1 = nr1
      }
    }
    if (!done) continue
    // onset guard: quiet before, a burst, then sustained sound after is a
    // plosive ("t", "k", "p") or the start of a word, not a click
    let dPk = 0
    for (let i = r0; i <= r1; i++) {
      const d = y[i] - work.rhs[i - r0]
      const ad = d < 0 ? -d : d
      if (ad > dPk) dPk = ad
    }
    const after = rmsOf(y, r1 + 1, Math.min(n, r1 + 1 + guardN))
    const before = rmsOf(y, Math.max(0, r0 - guardN), r0)
    if (after > 0.1 * dPk && before < 0.3 * after) continue
    for (let i = r0; i <= r1; i++) y[i] = work.rhs[i - r0]
    if (t <= r1) t = r1 + 1
  }
  return y
}

export default {
  id: 'tone.declick',
  name: 'Click and pop removal',
  family: 'tone',
  about: 'Finds mouth clicks, lip smacks and record ticks and fills each one in from the sound around it, leaving your words untouched.',
  params: [
    { id: 'sensitivity', name: 'Sensitivity', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent' },
    { id: 'maxLen', name: 'Longest click', type: 'number', min: 0.5, max: 20, step: 0.5, def: 3, unit: 'ms' },
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
    const progress = ctx && typeof ctx.progress === 'function' ? ctx.progress : null
    const cancelled = ctx && typeof ctx.cancelled === 'function' ? ctx.cancelled : null
    const nch = input.ch.length
    for (let c = 0; c < nch; c++) {
      if (cancelled && cancelled()) return input
      const x = input.ch[c]
      const y = repairChannel(x, input.sr, p)
      const out = new Float32Array(n)
      if (p.listen === true) for (let i = 0; i < n; i++) out[i] = (x[i] < 1e6 && x[i] > -1e6 ? x[i] : 0) - y[i]
      else for (let i = 0; i < n; i++) out[i] = y[i]
      input.ch[c] = out
      if (progress) progress((c + 1) / nch)
    }
    return input
  },
}
