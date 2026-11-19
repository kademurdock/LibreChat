// modules/time/_lib.js - shared splicing tools for the time family (not a
// module: files whose names start with an underscore hold helpers).
//
// The time modules rearrange audio rather than filter it, so they share one
// way of describing and playing an edit. The tools:
// - mixDown(buf): the channels' average, the one signal every analysis in
//   this family runs on, so all channels get the same edit and a stereo
//   image survives.
// - findUnits(sig, sr, unit, sliceMs): speech units for rearranging. Phrases
//   and syllables come straight from core/segment.js (an energy detector
//   with hysteresis after Rabiner and Sambur 1975, and syllable nuclei after
//   de Jong and Wempe 2009). Words are approximated: stretches between
//   pauses of 70 ms or more, and any stretch longer than 0.6 s is cut at
//   syllable boundaries into pieces of about a third of a second, which is
//   about the length of a spoken English word. Slices are even pieces of a
//   fixed length across the whole clip.
// - unitCore(sig, sr, unit): the loud middle of a unit (within 30 dB of its
//   own peak), so the quiet padding at phrase edges can stay put.
// - renderSegments(sig, sr, segs): an edit list player. The output is a
//   chain of segments laid end to end; each reads the source along a
//   straight line (forward, backward, at any playback rate), plays silence,
//   or plays a precomputed variable-speed path through core/resample.js
//   varispeed. Every join is a short raised-cosine crossfade whose two
//   halves sum to exactly one, and each segment keeps reading its source
//   past its own edges inside the crossfade, so joining a segment to the
//   material that really follows it reproduces the input exactly and other
//   joins are smooth, never clicks. Rates above one read from a copy that is
//   low-passed first (fourth-order Butterworth at 0.45 of the new Nyquist
//   frequency) so pitched-up pieces do not alias. Fractional positions use
//   four-point cubic Hermite interpolation.
// - speedSegment(at, rates, pre, len, opts) describes one of those
//   variable-speed segments (tape stops and scratches build theirs with it);
//   forwardSeg, reverseSeg and silenceSeg describe the plain ones, and
//   renderBuf plays one edit list on every channel.
// - Small helpers: prepare (sanitize in place, return the length),
//   msToSamples, dbGain, speechSpan (first phrase start to last phrase end).

import { bufLen, sanitize } from '../../core/buf.js'
import { findPhrases, findSyllables } from '../../core/segment.js'
import { Biquad } from '../../core/biquad.js'
import { varispeed } from '../../core/resample.js'

/** Average of all channels (the channel itself when mono). */
export function mixDown(input) {
  const ch = input.ch
  if (ch.length === 1) return ch[0]
  const n = ch[0].length
  const m = new Float32Array(n)
  const g = 1 / ch.length
  for (let c = 0; c < ch.length; c++) {
    const s = ch[c]
    for (let i = 0; i < n; i++) m[i] += s[i] * g
  }
  return m
}

/** Clean the input in place (NaN, Infinity, denormals) and say how long it is. */
export function prepare(input) {
  if (!input || !input.ch || !input.ch.length) return 0
  sanitize(input)
  return bufLen(input)
}

/** Word-sized units: pause-separated stretches, long ones cut at syllables. */
export function wordUnits(sig, sr) {
  const chunks = findPhrases(sig, sr, { minSilenceMs: 70, minPhraseMs: 50, padStartMs: 15, padEndMs: 25 })
  if (!chunks.length) return []
  const syl = findSyllables(sig, sr, { phrases: chunks })
  const out = []
  const maxLen = Math.round(0.6 * sr)
  const target = Math.round(0.32 * sr)
  const minRest = Math.round(0.12 * sr)
  let si = 0
  for (let k = 0; k < chunks.length; k++) {
    const c = chunks[k]
    // the syllables that belong to this stretch
    while (si < syl.length && syl[si].end <= c.start) si++
    let sj = si
    while (sj < syl.length && syl[sj].start < c.end) sj++
    if (c.end - c.start <= maxLen || sj - si < 2) {
      out.push({ start: c.start, end: c.end })
    } else {
      let cur = c.start
      for (let q = si; q < sj - 1; q++) {
        const b = syl[q].end
        if (b - cur >= target && c.end - b >= minRest && b > cur) {
          out.push({ start: cur, end: b })
          cur = b
        }
      }
      if (c.end > cur) out.push({ start: cur, end: c.end })
    }
    si = sj
  }
  return out
}

/**
 * Units of speech in time order: [{ start, end }] in samples.
 * unit: 'phrases' | 'words' | 'syllables' | 'slices'.
 */
export function findUnits(sig, sr, unit, sliceMs = 150) {
  const n = sig.length
  if (!n) return []
  if (unit === 'slices') {
    const L = Math.max(16, Math.round((sliceMs * sr) / 1000))
    const out = []
    for (let s = 0; s < n; s += L) out.push({ start: s, end: Math.min(n, s + L) })
    // a sliver at the end joins the slice before it
    if (out.length > 1 && out[out.length - 1].end - out[out.length - 1].start < L / 3) {
      out[out.length - 2].end = n
      out.pop()
    }
    return out
  }
  if (unit === 'phrases') return findPhrases(sig, sr)
  if (unit === 'syllables') return findSyllables(sig, sr)
  return wordUnits(sig, sr)
}

/**
 * The sounding middle of a unit: from the first to the last 5 ms block whose
 * level is within rangeDb of the unit's own loudest block, plus 3 ms either
 * side. The quiet lead-in and decay outside it (the padding segment.js puts
 * round every phrase) stay where they are when a unit is turned around or
 * moved, so phrase edges and pauses keep their places.
 */
export function unitCore(sig, sr, u, rangeDb = 30) {
  const a = Math.max(0, u.start)
  const b = Math.min(sig.length, u.end)
  const hop = Math.max(1, Math.round(0.005 * sr))
  const nb = Math.ceil((b - a) / hop)
  if (nb < 3) return { start: a, end: b }
  const e = new Float64Array(nb)
  let top = 0
  for (let k = 0; k < nb; k++) {
    const i0 = a + k * hop
    const i1 = Math.min(b, i0 + hop)
    let acc = 0
    for (let i = i0; i < i1; i++) acc += sig[i] * sig[i]
    e[k] = acc / Math.max(1, i1 - i0)
    if (e[k] > top) top = e[k]
  }
  if (!(top > 0)) return { start: a, end: b }
  const thr = top * Math.pow(10, -rangeDb / 10)
  let f = 0
  while (f < nb - 1 && e[f] < thr) f++
  let l = nb - 1
  while (l > f && e[l] < thr) l--
  const pad = Math.round(0.003 * sr)
  const s = Math.max(a, a + f * hop - pad)
  const t = Math.min(b, a + (l + 1) * hop + pad)
  return t > s ? { start: s, end: t } : { start: a, end: b }
}

/** Samples for a time in milliseconds, at least lo. */
export function msToSamples(ms, sr, lo = 0) {
  const v = Math.round((Number(ms) || 0) * sr * 0.001)
  return v < lo ? lo : v
}

/** dB to linear gain (finite for any input). */
export function dbGain(db) {
  const d = Number(db)
  return Number.isFinite(d) ? Math.pow(10, d / 20) : 1
}

// A low-passed copy of sig[a, b) for reading it faster than normal speed
// (fourth-order Butterworth: two biquads with Q 0.541 and 1.307). The caller
// starts a little early so the filter has settled where reading begins.
function lowpassed(sig, a, b, sr, rate) {
  const y = sig.slice(a, b)
  const fc = Math.min(0.45 * sr, (0.45 * sr) / rate)
  new Biquad('lowpass', sr, fc, 0.5412).run(y)
  new Biquad('lowpass', sr, fc, 1.3066).run(y)
  return y
}

/**
 * A variable-speed segment: the read head starts at source sample `at` at the
 * segment's first output sample and moves by rates[k] samples per output
 * sample. rates covers pre + len + post samples (pre before the segment's
 * start, for the crossfade into it, and post after its end). gainCurve, when
 * given, multiplies the result sample by sample (same length as rates).
 */
export function speedSegment(at, rates, pre, len, opts = {}) {
  return {
    kind: 'speed',
    at,
    rates,
    pre,
    len,
    xf: opts.xf || 0,
    gain: opts.gain === undefined ? 1 : opts.gain,
    gainCurve: opts.gainCurve || null,
    stopFade: opts.stopFade === undefined ? 0.04 : opts.stopFade,
  }
}

// Render one variable-speed segment of one channel through core varispeed.
function renderSpeed(sig, sr, seg) {
  const rates = seg.rates
  const m = rates.length
  let pos0 = seg.at
  for (let i = 0; i < seg.pre && i < m; i++) pos0 -= rates[i]
  let p = pos0
  let lo = p
  let hi = p
  let maxS = 1
  for (let i = 0; i < m; i++) {
    const r = rates[i]
    p += r
    if (p < lo) lo = p
    if (p > hi) hi = p
    const a = r < 0 ? -r : r
    if (a > maxS) maxS = a
  }
  const n = sig.length
  const margin = Math.ceil(32 * Math.min(16, maxS)) + 8
  const a = Math.max(0, Math.floor(lo) - margin)
  const b = Math.min(n, Math.ceil(hi) + margin + 1)
  let data
  if (b - a < 2 || !(Number.isFinite(lo) && Number.isFinite(hi))) data = new Float32Array(m)
  else {
    data = varispeed(sig.subarray(a, b), rates, sr, { start: (pos0 - a) / sr, length: m, stopFade: seg.stopFade })
    if (data.length !== m) {
      const d2 = new Float32Array(m)
      d2.set(data.subarray(0, Math.min(m, data.length)))
      data = d2
    }
  }
  const g = seg.gainCurve
  if (g) for (let i = 0; i < m; i++) data[i] *= g[i]
  return data
}

/**
 * Play an edit list. segs: [{ len, kind = 'src' | 'silence' | 'speed',
 *   src (source sample at the segment's first output sample), dir = 1 | -1,
 *   rate = 1, gain = 1, gainEnd = gain, xf = half crossfade into this segment
 *   (samples) }]. The output is the segments' lengths added up.
 */
export function renderSegments(sig, sr, segs) {
  const K = segs.length
  const n = sig.length
  let total = 0
  const starts = new Float64Array(K)
  for (let k = 0; k < K; k++) {
    const L = Math.max(0, Math.round(segs[k].len) || 0)
    starts[k] = total
    total += L
  }
  const out = new Float32Array(total)
  if (!total) return out
  // crossfade half widths at each join, never more than half a neighbour
  const hb = new Int32Array(K + 1)
  for (let k = 1; k < K; k++) {
    const want = Math.max(0, Math.round(segs[k].xf || 0))
    const la = Math.max(0, Math.round(segs[k - 1].len) || 0)
    const lb = Math.max(0, Math.round(segs[k].len) || 0)
    hb[k] = Math.min(want, la >> 1, lb >> 1)
  }
  for (let k = 0; k < K; k++) {
    const s = segs[k]
    const L = Math.max(0, Math.round(s.len) || 0)
    if (!L) continue
    const kind = s.kind || 'src'
    if (kind === 'silence') continue
    const h0 = hb[k]
    const h1 = hb[k + 1]
    const o0 = starts[k]
    const j0 = -h0
    const j1 = L + h1
    const g0 = s.gain === undefined ? 1 : s.gain
    const g1 = s.gainEnd === undefined ? g0 : s.gainEnd
    const dg = L > 1 ? (g1 - g0) / L : 0
    let data = null
    let dOff = 0
    if (kind === 'speed') {
      data = renderSpeed(sig, sr, s)
      dOff = s.pre
    }
    const dir = s.dir === -1 ? -1 : 1
    let rate = Number(s.rate) > 0 ? Number(s.rate) : 1
    if (rate > 16) rate = 16
    const step = dir * rate
    const integral = data === null && rate === 1 && Number.isInteger(s.src)
    const src = Number(s.src) || 0
    // x holds source samples base..top-1 (the whole channel, or a low-passed
    // stretch of it around what a faster-than-normal segment reads)
    let x = sig
    let base = 0
    let top = n
    if (data === null && rate > 1.02) {
      const pA = src + step * j0
      const pB = src + step * (j1 - 1)
      const lo = Math.floor(Math.min(pA, pB)) - 3
      const hi = Math.ceil(Math.max(pA, pB)) + 4
      base = Math.max(0, lo - 512)
      top = Math.min(n, Math.max(base, hi))
      x = lowpassed(sig, base, top, sr, rate)
    }
    for (let j = j0; j < j1; j++) {
      const p = o0 + j
      if (p < 0 || p >= total) continue
      let v
      if (data !== null) {
        const q = j + dOff
        v = q >= 0 && q < data.length ? data[q] : 0
      } else if (integral) {
        const q = src + dir * j
        v = q >= 0 && q < n ? x[q] : 0
      } else {
        const pos = src + step * j
        const i = Math.floor(pos)
        if (i < base - 2 || i > top + 1) v = 0
        else {
          const t = pos - i
          const xm1 = i - 1 >= base && i - 1 < top ? x[i - 1 - base] : 0
          const x0 = i >= base && i < top ? x[i - base] : 0
          const x1 = i + 1 >= base && i + 1 < top ? x[i + 1 - base] : 0
          const x2 = i + 2 >= base && i + 2 < top ? x[i + 2 - base] : 0
          const c1 = 0.5 * (x1 - xm1)
          const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2
          const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1)
          v = ((c3 * t + c2) * t + c1) * t + x0
        }
      }
      let w = 1
      if (j < h0) w = 0.5 - 0.5 * Math.cos((Math.PI * (j + h0 + 0.5)) / (2 * h0))
      else if (j >= L - h1) w = 0.5 + 0.5 * Math.cos((Math.PI * (j - (L - h1) + 0.5)) / (2 * h1))
      const jj = j < 0 ? 0 : j > L ? L : j
      out[p] += v * w * (g0 + dg * jj)
    }
  }
  return out
}

/** renderSegments over every channel of a buffer. */
export function renderBuf(input, segs) {
  const sr = input.sr
  const ch = new Array(input.ch.length)
  for (let c = 0; c < input.ch.length; c++) ch[c] = renderSegments(input.ch[c], sr, segs)
  return { sr, ch }
}

/** A segment that plays the source forward from sample src for len samples. */
export function forwardSeg(src, len, xf) {
  return { kind: 'src', src: Math.round(src), len: Math.round(len), dir: 1, rate: 1, xf }
}

/** A segment that plays source start..end backwards (from end - 1 down to start). */
export function reverseSeg(start, end, xf, gain = 1) {
  return { kind: 'src', src: Math.round(end) - 1, len: Math.round(end - start), dir: -1, rate: 1, xf, gain }
}

/** A stretch of silence len samples long. */
export function silenceSeg(len, xf) {
  return { kind: 'silence', len: Math.round(len), xf }
}

/** Where speech starts and ends (first and last phrase), or the whole clip. */
export function speechSpan(sig, sr) {
  const ph = findPhrases(sig, sr)
  if (!ph.length) return { start: 0, end: sig.length, phrases: ph }
  return { start: ph[0].start, end: ph[ph.length - 1].end, phrases: ph }
}
