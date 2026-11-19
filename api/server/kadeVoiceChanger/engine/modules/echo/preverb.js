// modules/echo/preverb.js - echo.preverb, the reverse reverb swell.
//
// Technique: the studio "reverse reverb" (also called pre-verb), as engineers
// have made it since tape days: turn the recording around, put reverb on it,
// print only the reverb, and turn that around again. Played forwards, every
// word's reverb tail now runs backwards: a ghostly swell that rises out of
// silence and sucks INTO the word, ending right as the word lands. Here the
// reverb is a real space from core/ir.js (roomIR with the named space's
// description, the dry path removed and the decay set from the swell
// length, so the swell rises over about that long), convolved with core/conv.js
// (uniformly partitioned overlap-add). Mathematically the swell at time t is
// the sum over every later sample s of x[s] * h[s - t]: the room run
// backwards in time. A predelay on the response becomes the gap between the
// end of the swell and the word, so the word's own attack stays clear.
//
// "Halo after the word" adds the same space the ordinary way as well, so the
// voice is wrapped on both sides, before and after; that forward part is the
// only sound after the take ends, so it is the only tail.
//
// The dry voice is not moved. A swell that would start before the take begins
// is lost for the very first word when the take starts with speech (a short
// fade keeps that clean). No live version: a swell before a word needs the
// word before it is spoken.

import { convolveMany } from '../../core/conv.js'
import { roomIR, spaceSpec } from '../../core/ir.js'
import { Biquad } from '../../core/biquad.js'
import { makeRng } from '../../core/rng.js'
import { makeBuf, sanitize } from '../../core/buf.js'
import { num, clamp, mixGains } from './_lib.js'

const SPACE = {
  hall: 'large-hall',
  cathedral: 'cathedral',
  church: 'church',
  plate: 'plate',
  cave: 'cave',
  stairwell: 'stairwell',
  spring: 'spring',
}
// Swell level against the voice, measured on speech so that 50 percent mix
// gives a swell that peaks a few decibels under the words.
const WET_GAIN = 0.8

function spaceKey(p) {
  const k = p && p.space
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(SPACE, k) ? k : 'hall'
}

function swellSec(p) {
  return clamp(num(p && p.length, 1.4), 0.3, 4)
}

function gapMs(p) {
  return clamp(num(p && p.gap, 40), 0, 500)
}

function irSeconds(p) {
  return gapMs(p) / 1000 + swellSec(p) + 0.02
}

function tailSec(p) {
  const g = mixGains(p && p.mix)
  if (g.wet === 0 || !(num(p && p.after, 0) > 0)) return 0
  return irSeconds(p)
}

function buildIR(sr, p, rng) {
  const spec = spaceSpec(SPACE[spaceKey(p)])
  const L = swellSec(p)
  spec.direct = 0
  spec.decay = 1.2 * L
  spec.seconds = irSeconds(p)
  spec.predelayMs = gapMs(p)
  delete spec.bloomMs
  return roomIR(sr, spec, rng)
}

export default {
  id: 'echo.preverb',
  name: 'Reverse reverb swell',
  family: 'echo',
  about: 'A ghostly reverb that swells up backwards and rushes into every word, ending just as the word arrives.',
  params: [
    { id: 'length', name: 'Swell length', type: 'number', min: 0.3, max: 4, step: 0.1, def: 1.4, unit: 'seconds', rand: [0.6, 2.2] },
    {
      id: 'space', name: 'Space', type: 'choice', def: 'hall',
      options: [
        { v: 'hall', name: 'Big hall' },
        { v: 'cathedral', name: 'Cathedral' },
        { v: 'church', name: 'Stone church' },
        { v: 'plate', name: 'Bright plate' },
        { v: 'cave', name: 'Cave' },
        { v: 'stairwell', name: 'Stairwell' },
        { v: 'spring', name: 'Spring tank' },
      ],
    },
    { id: 'gap', name: 'Gap before the word', type: 'number', min: 0, max: 500, step: 5, def: 40, unit: 'ms', rand: [0, 120] },
    { id: 'after', name: 'Halo after the word', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 40] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [35, 60] },
  ],
  stereo: 'make',
  warps: false,
  cost: 3,
  tail: (p) => tailSec(p),
  process(input, p, ctx) {
    const sr = input.sr
    const n = input.ch && input.ch.length ? input.ch[0].length : 0
    const tailN = Math.round(tailSec(p) * sr)
    const N = n + tailN
    const out = makeBuf(sr, 2, N)
    const g = mixGains(p.mix)
    const inL = input.ch[0]
    const inR = input.ch.length > 1 ? input.ch[1] : input.ch[0]
    const L = out.ch[0]
    const R = out.ch[1]
    for (let i = 0; i < n; i++) {
      L[i] = g.dry * inL[i]
      R[i] = g.dry * inR[i]
    }
    sanitize(out)
    if (n === 0 || g.wet === 0) return out
    const progress = ctx && typeof ctx.progress === 'function' ? ctx.progress : null
    // the send: the voice in mono, lows trimmed so the swell does not boom
    const send = new Float32Array(n)
    for (let i = 0; i < n; i++) send[i] = 0.5 * (inL[i] + inR[i])
    sanitize(send)
    new Biquad('highpass', sr, 140, 0.707).run(send)
    const rng = ctx && ctx.rng && typeof ctx.rng.fork === 'function' ? ctx.rng : makeRng('echo.preverb')
    const ir = buildIR(sr, p, rng.fork('swell'))
    if (progress) progress(0.15)
    // reverse, reverb, reverse back
    const rev = new Float32Array(n)
    for (let i = 0; i < n; i++) rev[i] = send[n - 1 - i]
    const wet = convolveMany(rev, [ir.ch[0], ir.ch[1]])
    if (progress) progress(0.6)
    const k = g.wet * WET_GAIN
    const fadeN = Math.min(n, Math.round(0.03 * sr))
    for (let t = 0; t < n; t++) {
      let w = k
      if (t < fadeN) w *= 0.5 - 0.5 * Math.cos((Math.PI * (t + 0.5)) / fadeN)
      L[t] += w * wet[0][n - 1 - t]
      R[t] += w * wet[1][n - 1 - t]
    }
    // the halo after each word: the same space played forwards
    const after = clamp(num(p.after, 0) / 100, 0, 1)
    if (after > 0 && tailN > 0) {
      const fwd = convolveMany(send, [ir.ch[0], ir.ch[1]])
      const ka = k * after
      const m = Math.min(N, fwd[0].length)
      for (let t = 0; t < m; t++) {
        L[t] += ka * fwd[0][t]
        R[t] += ka * fwd[1][t]
      }
    }
    sanitize(out)
    if (progress) progress(1)
    return out
  },
}
