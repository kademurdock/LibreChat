// core/conv.js - convolution: putting a voice into a recorded or synthesized space.
//
// Short impulse responses (32 taps or fewer, or tiny jobs) use plain direct
// convolution: it is exact and, at that size, faster than any transform.
//
// Everything else uses uniformly partitioned overlap-add convolution in the
// frequency domain (the "UPOLS" scheme; see Wefers 2015, "Partitioned
// convolution algorithms for real-time auralization", and the earlier
// Kulp 1988 / Soo and Pang 1990 frequency-domain delay line). The impulse
// response is cut into P partitions of B samples; each partition is
// transformed once, zero padded to 2B, into a kernel spectrum. The input is
// read in blocks of B samples, each block transformed once and kept in a
// frequency-domain delay line (a ring of the last P block spectra). Output
// block k is the inverse transform of the sum over p of
// input-spectrum(k - p) times kernel-spectrum(p), overlap-added into the
// output. The cost per output sample is one forward and one inverse
// transform of size 2B divided by B, plus P complex multiply-adds, so long
// responses are cheap and memory stays at a few megabytes even for 30 s of
// input (no transform ever spans the whole signal, which matters on iPhone).
//
// B is chosen from the response length (the next power of two, between 64
// and 8192; 8192 was measured fastest for multi-second responses in Node,
// ahead of 4096, 16384 and 32768, because its working set stays in cache).
// Input spectra that are entirely zero (silence, and the blocks after the
// input ends) are skipped. Leading and trailing near-silence in the response
// is trimmed before partitioning and accounted for in the output offset, so
// a response with a long predelay costs nothing extra.
//
// One input transform is shared by every response channel: a mono voice
// through a stereo response pays for one forward transform per block, not
// two. Kernel spectra are stored as Float32 (about -140 dB of rounding,
// far below audibility) and accumulated in Float64.
//
// Non-finite samples in the input or the response are read as zero, so a
// stray NaN cannot poison a whole block.

import { fftOf } from './fft.js'

const BMIN = 64
const BMAX = 8192

function isFiniteSample(x) {
  return x > -1e30 && x < 1e30
}

function nextPow2(n) {
  let p = 1
  while (p < n) p <<= 1
  return p
}

/** Index range [lead, end) of the response worth convolving (above about -140 dB of its peak). */
function activeRange(ir) {
  let pk = 0
  for (let i = 0; i < ir.length; i++) {
    const v = ir[i]
    if (isFiniteSample(v)) {
      const a = v < 0 ? -v : v
      if (a > pk) pk = a
    }
  }
  if (!(pk > 0)) return { lead: 0, end: 0 }
  const th = pk * 1e-7
  let lead = 0
  while (lead < ir.length && !(Math.abs(ir[lead]) > th && isFiniteSample(ir[lead]))) lead++
  let end = ir.length
  while (end > lead && !(Math.abs(ir[end - 1]) > th && isFiniteSample(ir[end - 1]))) end--
  return { lead, end }
}

/** Block size for a response of `len` active samples. */
export function chooseBlock(len) {
  let b = nextPow2(Math.max(1, len))
  if (b < BMIN) b = BMIN
  if (b > BMAX) b = BMAX
  return b
}

/**
 * A response prepared for partitioned convolution at block size B.
 * irLen is the full (untrimmed) length so output lengths follow the contract.
 */
export class ConvKernel {
  constructor(ir, B) {
    this.irLen = ir.length
    const { lead, end } = activeRange(ir)
    this.lead = lead
    this.active = end - lead
    this.B = B || chooseBlock(this.active)
    const Bk = this.B
    const nb = Bk + 1
    const P = this.active > 0 ? Math.ceil(this.active / Bk) : 0
    this.P = P
    this.nb = nb
    this.hRe = new Float32Array(Math.max(1, P * nb))
    this.hIm = new Float32Array(Math.max(1, P * nb))
    if (P === 0) return
    const fft = fftOf(2 * Bk)
    const buf = new Float64Array(2 * Bk)
    const re = new Float64Array(nb)
    const im = new Float64Array(nb)
    for (let p = 0; p < P; p++) {
      buf.fill(0)
      const s0 = lead + p * Bk
      const s1 = Math.min(end, s0 + Bk)
      for (let i = s0; i < s1; i++) {
        const v = ir[i]
        buf[i - s0] = isFiniteSample(v) ? v : 0
      }
      fft.realForward(buf, re, im)
      const o = p * nb
      for (let k = 0; k < nb; k++) {
        this.hRe[o + k] = re[k]
        this.hIm[o + k] = im[k]
      }
    }
  }
}

function directConvolve(sig, ir, out, lead, end) {
  const n = sig.length
  for (let i = 0; i < n; i++) {
    const x = sig[i]
    if (x === 0 || !isFiniteSample(x)) continue
    for (let j = lead; j < end; j++) {
      const h = ir[j]
      if (isFiniteSample(h)) out[i + j] += x * h
    }
  }
  return out
}

/**
 * Convolve one input signal with several kernels that share a block size,
 * computing each input block's spectrum once. outs[k] must have length
 * at least sig.length + kernels[k].irLen - 1 (extra length is fine).
 */
function runPartitioned(sig, kernels, outs) {
  const len = sig.length
  if (len === 0 || kernels.length === 0) return outs
  const B = kernels[0].B
  const nb = B + 1
  const N2 = 2 * B
  const fft = fftOf(N2)
  let P = 1
  for (let k = 0; k < kernels.length; k++) {
    if (kernels[k].B !== B) throw new RangeError('All convolution kernels in one run must share a block size.')
    if (kernels[k].P > P) P = kernels[k].P
  }
  const fdlRe = new Float32Array(P * nb)
  const fdlIm = new Float32Array(P * nb)
  const nz = new Uint8Array(P)
  const inBuf = new Float64Array(N2)
  const sRe = new Float64Array(nb)
  const sIm = new Float64Array(nb)
  const aRe = new Float64Array(nb)
  const aIm = new Float64Array(nb)
  const tmp = new Float64Array(N2)
  const inBlocks = Math.ceil(len / B)
  let maxP = 0
  for (let k = 0; k < kernels.length; k++) if (kernels[k].P > maxP) maxP = kernels[k].P
  const totalBlocks = inBlocks + maxP
  for (let blk = 0; blk < totalBlocks; blk++) {
    const slot = blk % P
    if (blk < inBlocks) {
      const s0 = blk * B
      const s1 = Math.min(len, s0 + B)
      let any = false
      for (let i = s0; i < s1; i++) {
        let v = sig[i]
        if (!isFiniteSample(v)) v = 0
        if (v !== 0) any = true
        inBuf[i - s0] = v
      }
      for (let i = s1 - s0; i < N2; i++) inBuf[i] = 0
      if (any) {
        fft.realForward(inBuf, sRe, sIm)
        const o = slot * nb
        for (let i = 0; i < nb; i++) {
          fdlRe[o + i] = sRe[i]
          fdlIm[o + i] = sIm[i]
        }
        nz[slot] = 1
      } else {
        nz[slot] = 0
      }
    } else {
      nz[slot] = 0
    }
    for (let k = 0; k < kernels.length; k++) {
      const ker = kernels[k]
      const kp = ker.P
      if (kp === 0) continue
      let used = false
      for (let p = 0; p < kp; p++) {
        const src = blk - p
        if (src < 0) break
        if (src >= inBlocks) continue
        const s = src % P
        if (!nz[s]) continue
        const xo = s * nb
        const ho = p * nb
        const hRe = ker.hRe
        const hIm = ker.hIm
        if (!used) {
          for (let i = 0; i < nb; i++) {
            const xr = fdlRe[xo + i], xi = fdlIm[xo + i]
            const hr = hRe[ho + i], hi = hIm[ho + i]
            aRe[i] = xr * hr - xi * hi
            aIm[i] = xr * hi + xi * hr
          }
          used = true
        } else {
          for (let i = 0; i < nb; i++) {
            const xr = fdlRe[xo + i], xi = fdlIm[xo + i]
            const hr = hRe[ho + i], hi = hIm[ho + i]
            aRe[i] += xr * hr - xi * hi
            aIm[i] += xr * hi + xi * hr
          }
        }
      }
      if (!used) continue
      fft.realInverse(aRe, aIm, tmp)
      const out = outs[k]
      const base = blk * B + ker.lead
      const lim = Math.min(N2, out.length - base)
      for (let i = 0; i < lim; i++) out[base + i] += tmp[i]
    }
  }
  return outs
}

function useDirect(sigLen, activeLen) {
  return activeLen <= 32 || sigLen * activeLen <= 65536
}

/**
 * Linear convolution of sig with ir. Returns Float32Array(len + irLen - 1),
 * or an empty array when either is empty.
 */
export function convolve(sig, ir) {
  const len = sig.length
  const irLen = ir.length
  if (len === 0 || irLen === 0) return new Float32Array(0)
  const out = new Float32Array(len + irLen - 1)
  const { lead, end } = activeRange(ir)
  if (end <= lead) return out
  if (useDirect(len, end - lead)) return directConvolve(sig, ir, out, lead, end)
  const ker = new ConvKernel(ir)
  runPartitioned(sig, [ker], [out])
  return out
}

/**
 * Convolve one signal with several responses at once (one input transform
 * per block shared by all). Returns one Float32Array(len + irLen_k - 1) per response.
 */
export function convolveMany(sig, irs) {
  const len = sig.length
  const outs = irs.map((ir) => new Float32Array(len === 0 || ir.length === 0 ? 0 : len + ir.length - 1))
  if (len === 0) return outs
  let maxActive = 0
  const ranges = irs.map((ir) => {
    const r = activeRange(ir)
    if (r.end - r.lead > maxActive) maxActive = r.end - r.lead
    return r
  })
  if (maxActive === 0) return outs
  if (useDirect(len, maxActive)) {
    for (let k = 0; k < irs.length; k++) {
      if (outs[k].length) directConvolve(sig, irs[k], outs[k], ranges[k].lead, ranges[k].end)
    }
    return outs
  }
  const B = chooseBlock(maxActive)
  const kernels = []
  const kOuts = []
  for (let k = 0; k < irs.length; k++) {
    if (!outs[k].length) continue
    kernels.push(new ConvKernel(irs[k], B))
    kOuts.push(outs[k])
  }
  runPartitioned(sig, kernels, kOuts)
  return outs
}

/**
 * Convolve a buffer with a response buffer and blend with the dry signal.
 *
 * Channels: mono in with a stereo response gives stereo out; stereo in with a
 * mono response runs each side through it; stereo with stereo pairs left with
 * left and right with right. Only the first two channels of either are used.
 *
 * mix is percent 0..100 (100 = all space). The dry signal is aligned with the
 * response's time zero. opts: { law: 'linear' | 'power' (equal-power blend),
 * tail: true (keep the ringing after the input ends; false cuts to the input
 * length), wetGain: 1 }.
 *
 * Returns a new buffer of length len + irLen - 1 (or len when tail is false).
 */
export function convolveBuf(b, irBuf, mix = 100, opts = {}) {
  if (irBuf.sr !== b.sr) {
    throw new RangeError('The space was made at ' + irBuf.sr + ' samples per second but the sound is at ' + b.sr + '. Make the space at the sound\'s rate.')
  }
  const inCh = b.ch.slice(0, 2)
  const irCh = irBuf.ch.slice(0, 2)
  const len = inCh.length ? inCh[0].length : 0
  const irLen = irCh.length ? irCh[0].length : 0
  const keepTail = opts.tail !== false
  const outLen = keepTail ? Math.max(len, len + irLen - 1) : len
  const nOut = Math.max(inCh.length, irCh.length)
  let m = Number(mix)
  if (!Number.isFinite(m)) m = 100
  m = Math.min(100, Math.max(0, m)) / 100
  let dryG, wetG
  if (opts.law === 'power' || opts.law === 'equal-power') {
    dryG = Math.cos((m * Math.PI) / 2)
    wetG = Math.sin((m * Math.PI) / 2)
  } else {
    dryG = 1 - m
    wetG = m
  }
  const wg = Number.isFinite(opts.wetGain) ? opts.wetGain : 1
  wetG *= wg
  if (m === 0) wetG = 0
  if (m === 1) dryG = 0
  const out = new Array(nOut)
  for (let c = 0; c < nOut; c++) out[c] = new Float32Array(outLen)

  if (wetG !== 0 && len > 0 && irLen > 0) {
    let wets
    if (inCh.length === 1) {
      wets = convolveMany(inCh[0], irCh)
    } else if (irCh.length === 1) {
      const both = []
      // Same response for each side: build the kernel once.
      const ir = irCh[0]
      const r = activeRange(ir)
      const active = r.end - r.lead
      if (active > 0 && !useDirect(len, active)) {
        const ker = new ConvKernel(ir)
        for (let c = 0; c < inCh.length; c++) {
          const o = new Float32Array(len + irLen - 1)
          runPartitioned(inCh[c], [ker], [o])
          both.push(o)
        }
      } else {
        for (let c = 0; c < inCh.length; c++) both.push(convolve(inCh[c], ir))
      }
      wets = both
    } else {
      wets = [convolveMany(inCh[0], [irCh[0]])[0], convolveMany(inCh[1], [irCh[1]])[0]]
    }
    for (let c = 0; c < nOut; c++) {
      const w = wets[Math.min(c, wets.length - 1)]
      const o = out[c]
      const n = Math.min(outLen, w.length)
      for (let i = 0; i < n; i++) o[i] = w[i] * wetG
    }
  }
  if (dryG !== 0) {
    for (let c = 0; c < nOut; c++) {
      const d = inCh[Math.min(c, inCh.length - 1)]
      if (!d) continue
      const o = out[c]
      const n = Math.min(len, outLen)
      for (let i = 0; i < n; i++) {
        const v = d[i]
        if (isFiniteSample(v)) o[i] += v * dryG
      }
    }
  }
  return { sr: b.sr, ch: out }
}
