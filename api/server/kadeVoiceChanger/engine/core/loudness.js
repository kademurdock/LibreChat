// core/loudness.js - programme loudness and true peak for the Voice Changer engine.
//
// lufs() follows ITU-R BS.1770-4 ("Algorithms to measure audio programme
// loudness and true-peak audio level") with the gating of EBU R 128 / EBU
// Tech 3341:
// - K-weighting is the two-stage filter of the standard: a high-shelf
//   "pre-filter" (about +4 dB above 1.5 kHz, the acoustic effect of the head)
//   followed by the RLB high-pass (about 38 Hz). The standard only prints
//   coefficients for 48 kHz, so here both stages are rebuilt for any sample
//   rate from their analog prototypes with the bilinear transform. The
//   prototype values (shelf corner 1681.97 Hz, gain 3.9998 dB, Q 0.70718;
//   high-pass corner 38.135 Hz, Q 0.50033) are the ones fitted to the 48 kHz
//   table by Brecht De Man and used by libebur128 (Jan Kokemueller); at
//   48 kHz they reproduce the published coefficients to about seven digits.
// - Mean square is taken over 400 ms blocks with 75 percent overlap (100 ms
//   hop), built from 100 ms partial sums so every sample is filtered once.
// - Block loudness is -0.691 + 10 log10(sum of channel-weighted mean squares).
//   Channel weights are 1 for left, right and centre and 1.41 for surrounds.
//   A mono buffer is one channel (so a full-scale 1 kHz sine reads -3.01).
// - Gating: blocks at or below -70 LUFS are dropped (absolute gate), then
//   blocks more than 10 LU below the loudness of the survivors are dropped
//   (relative gate), and the integrated value is the loudness of what is left.
// - A clip shorter than one block is measured as a single block over its
//   whole length, so a short preview still gets a number. Silence, or a clip
//   with nothing above the absolute gate, reads -200 (never -Infinity, so it
//   survives JSON), and normalizeLufs leaves such a clip alone.
//
// truePeakDb() estimates the inter-sample peak by 4x oversampling as in
// BS.1770-4 Annex 2, with our own interpolator instead of the Annex table: a
// 12-tap Kaiser-windowed sinc (beta 6, cutoff 0.9 of Nyquist) for each of the
// three in-between positions (0.25, 0.5, 0.75), each phase normalised to unit
// DC gain. Measured over-read is under 0.01 dB for sines up to 0.4 of the
// sample rate; the only under-read is the inherent 4x grid error near Nyquist
// (about 0.45 dB at 0.45 fs), the same as the Annex method.
// Speed trick, exact rather than approximate: an interpolated value can never
// exceed (sum of |taps|) times the largest sample under the taps, so stretches
// whose local maximum times that bound cannot beat the current peak are never
// interpolated. On speech this skips most of the signal.

// ---------------------------------------------------------------- K-weighting

/** K-weighting biquad coefficients for any sample rate. */
export function kWeightingCoefs(sr) {
  // stage 1: high shelf (pre-filter)
  let f0 = 1681.974450955533
  const G = 3.999843853973347
  let Q = 0.7071752369554196
  let K = Math.tan((Math.PI * Math.min(f0, 0.49 * sr)) / sr)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  let a0 = 1 + K / Q + K * K
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  }
  // stage 2: RLB high-pass
  f0 = 38.13547087602444
  Q = 0.5003270373238773
  K = Math.tan((Math.PI * f0) / sr)
  a0 = 1 + K / Q + K * K
  const hp = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  }
  return { shelf, hp }
}

function channelWeight(c, nch) {
  if (nch === 5) return c >= 3 ? 1.41 : 1
  if (nch === 6) return c === 3 ? 0 : c >= 4 ? 1.41 : 1
  return 1
}

// Filter one channel through K-weighting and add squared output into 100 ms
// partial sums (seg, length nSeg) and into a whole-clip total (returned).
function kWeightedSums(sig, sr, hop, seg, nSeg, w) {
  const { shelf: s, hp: h } = kWeightingCoefs(sr)
  const sb0 = s.b0, sb1 = s.b1, sb2 = s.b2, sa1 = s.a1, sa2 = s.a2
  const ha1 = h.a1, ha2 = h.a2
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0 // shelf state
  let z1 = 0, z2 = 0 // high-pass output state (its input is y)
  let total = 0
  const n = sig.length
  let i = 0
  for (let k = 0; k <= nSeg; k++) {
    const end = k < nSeg ? Math.min(n, (k + 1) * hop) : n
    let acc = 0
    for (; i < end; i++) {
      let x = sig[i]
      if (!(x <= 1e30 && x >= -1e30)) x = 0
      const y = sb0 * x + sb1 * x1 + sb2 * x2 - sa1 * y1 - sa2 * y2
      // high-pass: b = [1, -2, 1] on the shelf output
      const z = y - 2 * y1 + y2 - ha1 * z1 - ha2 * z2
      x2 = x1; x1 = x
      y2 = y1; y1 = y < 1e-25 && y > -1e-25 ? 0 : y
      z2 = z1; z1 = z < 1e-25 && z > -1e-25 ? 0 : z
      acc += z * z
    }
    if (k < nSeg) seg[k] += acc * w
    total += acc * w
  }
  return total
}
/**
 * Full measurement: { integrated, momentaryMax, blocks, gated } where values
 * are LUFS (-200 for nothing measurable), blocks is the number of 400 ms
 * blocks and gated how many survived both gates.
 */
export function lufsDetail(b) {
  const out = { integrated: -200, momentaryMax: -200, blocks: 0, gated: 0 }
  if (!b || !b.ch || !b.ch.length) return out
  const sr = b.sr
  const n = b.ch[0].length
  if (!n || !(sr > 0)) return out
  const hop = Math.max(1, Math.round(sr * 0.1))
  const blockLen = 4 * hop
  const nSeg = Math.floor(n / hop)
  const seg = new Float64Array(nSeg)
  let total = 0
  const nch = b.ch.length
  for (let c = 0; c < nch; c++) {
    total += kWeightedSums(b.ch[c], sr, hop, seg, nSeg, channelWeight(c, nch))
  }
  const toL = (ms) => (ms > 1e-20 ? -0.691 + 10 * Math.log10(ms) : -200)
  const nBlocks = nSeg >= 4 ? nSeg - 3 : 0
  if (!nBlocks) {
    // shorter than one block: one block over the whole clip
    const L = toL(total / n)
    out.blocks = 1
    out.momentaryMax = L
    if (L > -70) {
      out.integrated = L
      out.gated = 1
    }
    return out
  }
  const blk = new Float64Array(nBlocks)
  let mMax = -200
  for (let j = 0; j < nBlocks; j++) {
    const ms = (seg[j] + seg[j + 1] + seg[j + 2] + seg[j + 3]) / blockLen
    blk[j] = ms
    const L = toL(ms)
    if (L > mMax) mMax = L
  }
  out.blocks = nBlocks
  out.momentaryMax = mMax
  // absolute gate
  const absMs = Math.pow(10, (-70 + 0.691) / 10)
  let sum = 0
  let cnt = 0
  for (let j = 0; j < nBlocks; j++) {
    if (blk[j] > absMs) {
      sum += blk[j]
      cnt++
    }
  }
  if (!cnt) return out
  const relL = toL(sum / cnt) - 10
  const relMs = Math.pow(10, (relL + 0.691) / 10)
  let sum2 = 0
  let cnt2 = 0
  for (let j = 0; j < nBlocks; j++) {
    if (blk[j] > absMs && blk[j] > relMs) {
      sum2 += blk[j]
      cnt2++
    }
  }
  out.gated = cnt2
  out.integrated = cnt2 ? toL(sum2 / cnt2) : -200
  return out
}

/** Integrated loudness in LUFS (BS.1770-4, gated). -200 when nothing is measurable. */
export function lufs(b) {
  return lufsDetail(b).integrated
}

/**
 * Scale b in place so its integrated loudness is `target` LUFS. A clip with
 * nothing above the -70 LUFS gate is left alone. opts.maxGainDb caps the boost
 * (default 60 dB). Returns b. The gain used is stored on lufsGainUsed.db.
 */
export function normalizeLufs(b, target = -16, opts = {}) {
  lufsGainUsed.db = 0
  const L = lufs(b)
  if (!(L > -70)) return b
  const t = Number.isFinite(Number(target)) ? Number(target) : -16
  let gDb = t - L
  const cap = opts.maxGainDb !== undefined ? Number(opts.maxGainDb) : 60
  if (gDb > cap) gDb = cap
  const g = Math.pow(10, gDb / 20)
  for (let c = 0; c < b.ch.length; c++) {
    const s = b.ch[c]
    for (let i = 0; i < s.length; i++) s[i] *= g
  }
  lufsGainUsed.db = gDb
  return b
}

/** The gain in dB applied by the latest normalizeLufs call. */
export const lufsGainUsed = { db: 0 }

// ---------------------------------------------------------------- true peak

const TP_TAPS = 12
const TP_HALF = TP_TAPS / 2
const TP_BLOCK = 16 // block size for the local-maximum bound (must be >= TP_TAPS)

function besselI0(x) {
  let s = 1
  let t = 1
  for (let k = 1; k < 60; k++) {
    const h = x / (2 * k)
    t *= h * h
    s += t
    if (t < 1e-17 * s) break
  }
  return s
}

// Three fractional-delay phases flattened into one Float64Array (phase-major).
const TP_PHASES = (() => {
  const fc = 0.9
  const beta = 6
  const out = new Float64Array(3 * TP_TAPS)
  const i0b = besselI0(beta)
  for (let p = 0; p < 3; p++) {
    const d = (p + 1) / 4
    let sum = 0
    for (let j = 0; j < TP_TAPS; j++) {
      const t = j - (TP_HALF - 1) - d
      const x = Math.PI * fc * t
      const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(x) / x
      const r = t / TP_HALF
      const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b
      out[p * TP_TAPS + j] = fc * sinc * w
      sum += out[p * TP_TAPS + j]
    }
    for (let j = 0; j < TP_TAPS; j++) out[p * TP_TAPS + j] /= sum
  }
  return out
})()

/** Largest possible |interpolated value| per unit of local sample peak. */
export const TP_BOUND = (() => {
  let m = 0
  for (let p = 0; p < 3; p++) {
    let s = 0
    for (let j = 0; j < TP_TAPS; j++) s += Math.abs(TP_PHASES[p * TP_TAPS + j])
    if (s > m) m = s
  }
  return m
})()

function blockMaxima(sig) {
  const n = sig.length
  const nb = Math.ceil(n / TP_BLOCK)
  const bm = new Float32Array(nb)
  for (let b = 0; b < nb; b++) {
    let m = 0
    const e = Math.min(n, (b + 1) * TP_BLOCK)
    for (let i = b * TP_BLOCK; i < e; i++) {
      const v = sig[i] < 0 ? -sig[i] : sig[i]
      if (v > m && v <= 1e30) m = v
    }
    bm[b] = m
  }
  return bm
}

// Largest |value| at the three in-between positions of interval (j, j+1).
function intervalPeak(sig, j) {
  const n = sig.length
  const base = j - (TP_HALF - 1)
  let m = 0
  if (base >= 0 && base + TP_TAPS <= n) {
    for (let p = 0; p < 3; p++) {
      const o = p * TP_TAPS
      let acc = 0
      for (let k = 0; k < TP_TAPS; k++) acc += TP_PHASES[o + k] * sig[base + k]
      if (acc < 0) acc = -acc
      if (acc > m) m = acc
    }
  } else {
    for (let p = 0; p < 3; p++) {
      const o = p * TP_TAPS
      let acc = 0
      for (let k = 0; k < TP_TAPS; k++) {
        const idx = base + k
        if (idx >= 0 && idx < n) acc += TP_PHASES[o + k] * sig[idx]
      }
      if (acc < 0) acc = -acc
      if (acc > m) m = acc
    }
  }
  return m === m && m <= 1e30 ? m : 0
}

function localBound(bm, j, n) {
  let lo = j - (TP_HALF - 1)
  let hi = j + TP_HALF
  if (lo < 0) lo = 0
  if (hi > n - 1) hi = n - 1
  const b0 = (lo / TP_BLOCK) | 0
  const b1 = (hi / TP_BLOCK) | 0
  const m = bm[b0] > bm[b1] ? bm[b0] : bm[b1]
  return m * TP_BOUND
}

/** True peak (linear) of one Float32Array, 4x oversampled. */
export function truePeakSig(sig) {
  const n = sig ? sig.length : 0
  if (!n) return 0
  let m = 0
  for (let i = 0; i < n; i++) {
    const v = sig[i] < 0 ? -sig[i] : sig[i]
    if (v > m && v <= 1e30) m = v
  }
  if (m === 0) return 0
  const bm = blockMaxima(sig)
  for (let j = 0; j < n - 1; j++) {
    if (localBound(bm, j, n) <= m) continue
    const v = intervalPeak(sig, j)
    if (v > m) m = v
  }
  return m
}

/**
 * Per-sample peak including inter-sample overs, for limiters: out[i] is the
 * largest of |x[i]| and the interpolated peaks of the intervals on each side
 * of i, but intervals that provably stay at or under `thresh` are not
 * interpolated (their samples just get |x[i]|). Returns out (allocated when
 * not given).
 */
export function interSamplePeaks(sig, thresh, out) {
  const n = sig.length
  const o = out || new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = sig[i] < 0 ? -sig[i] : sig[i]
    o[i] = v <= 1e30 ? v : 0
  }
  if (n < 2) return o
  const bm = blockMaxima(sig)
  const t = Number.isFinite(thresh) ? thresh : 0
  for (let j = 0; j < n - 1; j++) {
    if (localBound(bm, j, n) <= t) continue
    const v = intervalPeak(sig, j)
    if (v > o[j]) o[j] = v
    if (v > o[j + 1]) o[j + 1] = v
  }
  return o
}

/** True peak of a buffer (or Float32Array) in dBTP; -200 for silence. */
export function truePeakDb(b) {
  const chs = b instanceof Float32Array || b instanceof Float64Array ? [b] : b && b.ch ? b.ch : []
  let m = 0
  for (let c = 0; c < chs.length; c++) {
    const v = truePeakSig(chs[c])
    if (v > m) m = v
  }
  return m > 1e-10 ? 20 * Math.log10(m) : -200
}
