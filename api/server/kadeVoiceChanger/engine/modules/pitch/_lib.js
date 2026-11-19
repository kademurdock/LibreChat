// modules/pitch/_lib.js - shared helpers for the pitch family (not a module).
//
// This file has no default export: it is a helper library that the pitch
// modules import. A registry builder should skip files whose name starts with
// an underscore.
//
// What is here:
// - analyse(buf): the channels' mix and one pitch track of it
//   (core/pitch.js trackPitch, YIN with a Viterbi path), shared by every
//   module so a stereo voice is analysed once and its channels stay coherent.
// - voicedRuns(track): voiced stretches in seconds, with short gaps bridged,
//   so "the start of a note" means the start of a sung or spoken vowel run.
// - ControlCurve: a control signal sampled at a fixed control rate (default
//   1 kHz) in one Float32Array and read back with linear interpolation, so a
//   function of time handed to core/voice.js costs a lookup, not a recompute.
// - smoothRandom(): slewed random values (cosine interpolation between
//   uniform random points, the "smooth random" of analogue modular systems),
//   written into a control curve; the drift of a real singer's pitch.
// - panGains(): constant-power panning (sine/cosine law).
// - KEY_OPTIONS / keyIndex: the twelve key notes as spoken choices.
// - Pitch classes are counted from C = 0; MIDI note numbers from 69 = A 440.

import { trackPitch, medianPitch } from '../../core/pitch.js'
import { makeRng } from '../../core/rng.js'

export const KEY_OPTIONS = [
  { v: 'C', name: 'C' },
  { v: 'C#', name: 'C sharp' },
  { v: 'D', name: 'D' },
  { v: 'D#', name: 'E flat' },
  { v: 'E', name: 'E' },
  { v: 'F', name: 'F' },
  { v: 'F#', name: 'F sharp' },
  { v: 'G', name: 'G' },
  { v: 'G#', name: 'A flat' },
  { v: 'A', name: 'A' },
  { v: 'A#', name: 'B flat' },
  { v: 'B', name: 'B' },
]

/** Pitch class (0 = C) of a key choice value. */
export function keyIndex(v) {
  for (let i = 0; i < KEY_OPTIONS.length; i++) if (KEY_OPTIONS[i].v === v) return i
  return 0
}

/** A usable rate: anything odd reads as 48 kHz. */
export function rateOf(buf) {
  const r = Number(buf && buf.sr)
  return r > 0 && r < Infinity ? r : 48000
}

/** The ctx rng, or a fixed fallback so the module stays deterministic. */
export function rngOf(ctx, label) {
  const r = ctx && ctx.rng && typeof ctx.rng.next === 'function' ? ctx.rng : makeRng('pitch-family')
  return label && typeof r.fork === 'function' ? r.fork(label) : r
}

export function progress(ctx, f) {
  if (ctx && typeof ctx.progress === 'function') {
    try {
      ctx.progress(f < 0 ? 0 : f > 1 ? 1 : f)
    } catch {
      // a host's progress callback must never break a render
    }
  }
}

/** Replace NaN and Infinity in every channel, in place. Returns buf. */
export function cleanBuf(buf) {
  for (let c = 0; c < buf.ch.length; c++) {
    const s = buf.ch[c]
    for (let i = 0; i < s.length; i++) {
      const v = s[i]
      if (!(v === v && v < 1e30 && v > -1e30)) s[i] = 0
    }
  }
  return buf
}

/** True when the buffer can be processed at all (has channels, has samples). */
export function usable(buf) {
  return !!(buf && Array.isArray(buf.ch) && buf.ch.length && buf.ch[0] && buf.ch[0].length > 0)
}

/** Mix of the channels as one Float32Array (the channel itself for mono). */
export function monoMix(buf) {
  if (buf.ch.length === 1) return buf.ch[0]
  const n = buf.ch[0].length
  const m = new Float32Array(n)
  const g = 1 / buf.ch.length
  for (let c = 0; c < buf.ch.length; c++) {
    const s = buf.ch[c]
    for (let i = 0; i < n; i++) m[i] += s[i] * g
  }
  return m
}

/** One analysis for the whole buffer: { sr, mono, track, median }. */
export function analyse(buf, opts) {
  const sr = rateOf(buf)
  const mono = monoMix(buf)
  const track = trackPitch(mono, sr, opts || {})
  const median = medianPitch(track)
  return { sr, mono, track, median: median > 0 ? median : 0 }
}

/**
 * Voiced stretches of a track as [startSec, endSec] pairs. Gaps shorter than
 * bridgeSec are bridged, so a quick consonant inside a word does not count as
 * a new note.
 */
export function voicedRuns(track, sr, bridgeSec = 0.06) {
  const runs = []
  if (!track || !track.f0) return runs
  const f0 = track.f0
  const hs = track.hop / sr
  let f = 0
  const nf = f0.length
  while (f < nf) {
    if (f0[f] > 0) {
      let g = f
      while (g < nf && f0[g] > 0) g++
      const a = f * hs
      const b = g * hs
      if (runs.length && a - runs[runs.length - 1][1] < bridgeSec) runs[runs.length - 1][1] = b
      else runs.push([a, b])
      f = g
    } else f++
  }
  return runs
}

/** Index of the run containing t (or the last run starting before t), -1 if none. */
export function runAt(runs, t) {
  let lo = 0
  let hi = runs.length - 1
  if (hi < 0 || t < runs[0][0]) return -1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (runs[mid][0] <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** A control signal at a fixed rate, read with linear interpolation. */
export class ControlCurve {
  constructor(seconds, rate = 1000) {
    this.rate = rate
    this.n = Math.max(2, Math.ceil(Math.max(0, seconds) * rate) + 2)
    this.v = new Float32Array(this.n)
  }
  /** Fill from fn(tSeconds). */
  fill(fn) {
    const v = this.v
    const r = this.rate
    for (let i = 0; i < this.n; i++) {
      const x = fn(i / r)
      v[i] = x === x && x < 1e30 && x > -1e30 ? x : 0
    }
    return this
  }
  at(t) {
    let p = t * this.rate
    if (!(p > 0)) return this.v[0]
    if (p >= this.n - 1) return this.v[this.n - 1]
    const i = p | 0
    const a = p - i
    return this.v[i] + a * (this.v[i + 1] - this.v[i])
  }
  /** A plain function of time for core/voice.js. */
  fn() {
    return (t) => this.at(t)
  }
}

/**
 * Slewed random in -1..1 written into a new ControlCurve: a fresh random
 * point every 1/hz seconds, cosine-interpolated between points.
 */
export function smoothRandom(seconds, hz, rng, rate = 1000) {
  const cc = new ControlCurve(seconds, rate)
  const h = hz > 0.001 ? hz : 0.001
  const pts = Math.ceil(seconds * h) + 3
  const p = new Float32Array(pts)
  for (let i = 0; i < pts; i++) p[i] = rng.next() * 2 - 1
  const v = cc.v
  for (let i = 0; i < cc.n; i++) {
    const x = (i / rate) * h
    const k = Math.floor(x)
    const a = x - k
    const w = 0.5 - 0.5 * Math.cos(Math.PI * a)
    const k0 = k < pts ? k : pts - 1
    const k1 = k + 1 < pts ? k + 1 : pts - 1
    v[i] = p[k0] + (p[k1] - p[k0]) * w
  }
  return cc
}

/** Constant-power pan: pos -1 (left) .. +1 (right) -> [gainL, gainR]. */
export function panGains(pos) {
  const p = pos < -1 ? -1 : pos > 1 ? 1 : pos
  const a = ((p + 1) * Math.PI) / 4
  return [Math.cos(a), Math.sin(a)]
}

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x
}

/** Copy of the buffer's channel list as new Float32Arrays of length n (zeros). */
export function zerosLike(nch, n) {
  const ch = []
  for (let c = 0; c < nch; c++) ch.push(new Float32Array(n))
  return ch
}
