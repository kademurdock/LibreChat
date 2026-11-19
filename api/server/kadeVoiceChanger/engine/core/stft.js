// core/stft.js - short-time Fourier analysis and weighted overlap-add resynthesis.
//
// Method: weighted overlap-add (WOLA) as described by Crochiere 1980,
// "A weighted overlap-add method of short-time Fourier analysis/synthesis",
// and Allen and Rabiner 1977. Each frame is multiplied by an analysis window
// wa, transformed with the real FFT (core/fft.js), handed to the caller,
// inverse transformed, multiplied by a synthesis window ws, and added into
// the output. The output is then divided, sample by sample, by the summed
// window product sum_f wa[t - f*hop] * ws[t - f*hop]. That exact division
// (instead of a single constant) makes the identity hold for any hop, any
// window pair and right up to the first and last samples.
//
// Edges: the signal is treated as if padded with size - hop zeros on the
// left and enough zeros on the right that every real sample, including the
// very first and very last, sits under the full number of overlapping frames.
// Frames are still read straight from the input (no padded copy is made);
// the zeros are implicit.
//
// Windows: 'hann' (the default) uses Hann for both analysis and synthesis,
// whose squared overlap at hop size/4 sums to a flat 1.5 (3/8 * size/hop),
// a constant the division removes. 'sqrthann' uses square-root Hann on both sides
// (the textbook choice at hop size/2). 'hamming', 'blackman', 'kaiser' and
// 'rect' use that window on both sides. A Float64Array may be passed as
// the window (used on both sides), or { analysis, synthesis } arrays.
//
// The callback receives (re, im, frameIndex, info) where re and im are the
// n/2+1 bins of the current frame, REUSED between frames (copy them if you
// keep them), and info = { start, center, size, hop, frames } gives the
// frame's position in input samples. The callback edits re/im in place.
// Phase convention: bin phases are relative to the start of the frame.

import { FFT, fftOf } from './fft.js'
import { windowByName } from './window.js'

function resolve(opts) {
  const o = opts || {}
  let size = Math.floor(o.size || 2048)
  if (size < 16) size = 16
  if ((size & (size - 1)) !== 0) {
    let p = 16
    while (p < size) p <<= 1
    size = p
  }
  let hop = Math.floor(o.hop || size / 4)
  if (hop < 1) hop = 1
  if (hop > size) hop = size
  let wa
  let ws
  const w = o.window === undefined ? 'hann' : o.window
  if (w instanceof Float64Array || w instanceof Float32Array) {
    wa = Float64Array.from(w.subarray ? w.subarray(0, size) : w)
    ws = wa
  } else if (w && typeof w === 'object' && w.analysis) {
    wa = Float64Array.from(w.analysis)
    ws = Float64Array.from(w.synthesis || w.analysis)
  } else {
    wa = windowByName(w, size)
    ws = wa
  }
  if (wa.length !== size || ws.length !== size) throw new RangeError('STFT window length must equal size')
  return { size, hop, wa, ws, pad: size - hop }
}

/** Frame layout for a signal of `len` samples: { size, hop, pad, frames }. */
export function stftLayout(len, opts) {
  const r = resolve(opts)
  const frames = len > 0 ? Math.floor((len - 1 + r.pad) / r.hop) + 1 : 0
  return { size: r.size, hop: r.hop, pad: r.pad, frames }
}

/** Sample index (in the input) of the centre of frame f. */
export function frameCenter(f, opts) {
  const r = resolve(opts)
  return f * r.hop - r.pad + r.size / 2
}

function finish(out, norm, len) {
  const res = new Float32Array(len)
  let mx = 0
  for (let i = 0; i < len; i++) if (norm[i] > mx) mx = norm[i]
  const eps = mx * 1e-9 + 1e-300
  for (let i = 0; i < len; i++) {
    const v = norm[i] > eps ? out[i] / norm[i] : 0
    res[i] = v === v && v !== Infinity && v !== -Infinity ? v : 0
  }
  return res
}

/**
 * Analyse, let the callback edit each frame's spectrum, resynthesise.
 * @param {Float32Array} sig
 * @param {{size?:number, hop?:number, window?:string|Float64Array|{analysis,synthesis}}} opts
 * @param {(re:Float64Array, im:Float64Array, frame:number, info:object)=>void} cb
 * @returns {Float32Array} same length as sig
 */
export function spectralProcess(sig, opts, cb) {
  const len = sig.length
  if (len === 0) return new Float32Array(0)
  const { size, hop, wa, ws, pad } = resolve(opts)
  const fft = fftOf(size)
  const frames = Math.floor((len - 1 + pad) / hop) + 1
  const nb = (size >> 1) + 1
  const re = new Float64Array(nb)
  const im = new Float64Array(nb)
  const frame = new Float64Array(size)
  const out = new Float64Array(len)
  const norm = new Float64Array(len)
  const info = { start: 0, center: 0, size, hop, frames }
  for (let f = 0; f < frames; f++) {
    const start = f * hop - pad
    const i0 = start < 0 ? -start : 0
    const i1 = start + size > len ? len - start : size
    for (let i = 0; i < i0; i++) frame[i] = 0
    for (let i = i0; i < i1; i++) frame[i] = sig[start + i] * wa[i]
    for (let i = i1; i < size; i++) frame[i] = 0
    fft.realForward(frame, re, im)
    if (cb) {
      info.start = start
      info.center = start + (size >> 1)
      cb(re, im, f, info)
    }
    fft.realInverse(re, im, frame)
    for (let i = i0; i < i1; i++) {
      const j = start + i
      out[j] += frame[i] * ws[i]
      norm[j] += wa[i] * ws[i]
    }
  }
  return finish(out, norm, len)
}

/**
 * All frames as an array of { re, im } (fresh Float64Arrays each). The array
 * also carries .layout = { size, hop, pad, frames, length }.
 */
export function stftFrames(sig, opts) {
  const len = sig.length
  const { size, hop, wa, pad } = resolve(opts)
  const fft = fftOf(size)
  const frames = len > 0 ? Math.floor((len - 1 + pad) / hop) + 1 : 0
  const nb = (size >> 1) + 1
  const frame = new Float64Array(size)
  const res = new Array(frames)
  for (let f = 0; f < frames; f++) {
    const start = f * hop - pad
    const i0 = start < 0 ? -start : 0
    const i1 = start + size > len ? len - start : size
    frame.fill(0)
    for (let i = i0; i < i1; i++) frame[i] = sig[start + i] * wa[i]
    const re = new Float64Array(nb)
    const im = new Float64Array(nb)
    fft.realForward(frame, re, im)
    res[f] = { re, im }
  }
  res.layout = { size, hop, pad, frames, length: len }
  return res
}

/**
 * Resynthesise frames (as made by stftFrames, possibly edited, possibly a
 * different count) into `length` samples with the same options.
 */
export function istftFrames(frames, opts, length) {
  const len = Math.max(0, Math.floor(length))
  if (len === 0) return new Float32Array(0)
  const { size, hop, wa, ws, pad } = resolve(opts)
  const fft = fftOf(size)
  const frame = new Float64Array(size)
  const out = new Float64Array(len)
  const norm = new Float64Array(len)
  // Normalise with every frame position that would cover the output, even
  // past the supplied frames, so a short frame list fades instead of booming.
  const need = Math.floor((len - 1 + pad) / hop) + 1
  const total = Math.max(need, frames.length)
  for (let f = 0; f < total; f++) {
    const start = f * hop - pad
    if (start >= len) break
    const i0 = start < 0 ? -start : 0
    const i1 = start + size > len ? len - start : size
    if (f < frames.length && frames[f]) {
      fft.realInverse(frames[f].re, frames[f].im, frame)
      for (let i = i0; i < i1; i++) out[start + i] += frame[i] * ws[i]
    }
    for (let i = i0; i < i1; i++) norm[start + i] += wa[i] * ws[i]
  }
  return finish(out, norm, len)
}

export { FFT }
