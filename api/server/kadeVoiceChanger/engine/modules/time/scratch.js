// modules/time/scratch.js - time.scratch, "Record scratch": a DJ grabs the
// first word of each phrase on the record and scratches it in time before
// letting it play, or spins the record backwards at the end.
//
// Technique: a virtual turntable. The record position follows a hand motion
// and the sound is read through core/resample.js varispeed, Julius O. Smith
// III's bandlimited interpolation, which plays at any speed, forwards or
// backwards, without aliasing. The motions are the standard scratch
// techniques as Kjetil Falkenberg Hansen and Roberto Bresin measured and
// modelled them from DJ performances (KTH; "The Skipproof virtual turntable
// for high-level control of scratching", Computer Music Journal 2010):
// - baby scratch: the record pushed forward and pulled back, one stroke each
//   half beat, crossfader open;
// - chirp: the fader closes during the push and opens during the pull, so
//   only the start of each sound is heard, a bird-like chirp;
// - transformer: slow strokes while the fader chops on and off on sixteenth
//   notes;
// - scribble: a tense hand shaking the record very fast in small moves;
// - tear: each push is broken in two by a short stall;
// - flare: the fader clicks shut for a moment in the middle of every stroke;
// - backspin: the record is thrown backwards and coasts to a stop.
// The strokes are smooth (raised-cosine position curves), the fader moves in
// about 2 ms (a zero-phase one-pole smoother on the on and off pattern) so it
// never clicks, and the level follows the square root of the record's speed,
// because a phono stylus puts out a voltage proportional to how fast the
// groove moves. The stroke depth grows with "Hand speed", and the scratch is
// inserted in tempo, after which the phrase plays normally (or, at the end,
// the final word is scratched as an outro).

import { findUnits, mixDown, prepare, renderBuf, forwardSeg, speedSegment, msToSamples } from './_lib.js'
import { findPhrases } from '../../core/segment.js'
import { makeRng } from '../../core/rng.js'

const STROKES = ['baby', 'chirp', 'transformer', 'scribble', 'tear', 'flare']

function smooth01(x) {
  const t = x < 0 ? 0 : x > 1 ? 1 : x
  return 0.5 - 0.5 * Math.cos(Math.PI * t)
}

function frac(x) {
  return x - Math.floor(x)
}

// Zero-phase one-pole smoothing of a 0/1 fader pattern (about tauMs each way).
function smoothFader(f, sr, tauMs) {
  const c = Math.exp(-1000 / (tauMs * sr))
  let y = f[0]
  for (let i = 0; i < f.length; i++) {
    y = f[i] + c * (y - f[i])
    f[i] = y
  }
  y = f[f.length - 1]
  for (let i = f.length - 1; i >= 0; i--) {
    y = f[i] + c * (y - f[i])
    f[i] = y
  }
}

/**
 * A scratch passage of T samples: record position (samples from the start of
 * the material, T + 1 values) and fader level (T values).
 */
function strokeMotion(pattern, T, sr, beat, A, hand) {
  const pos = new Float64Array(T + 1)
  const fader = new Float32Array(T)
  const beats = Math.max(1, Math.round(T / beat))
  const slow = beats % 2 === 0 ? 2 * beat : beat // a slow stroke that still ends at rest
  for (let k = 0; k <= T; k++) {
    const t = k // in samples
    let x = 0
    let f = 1
    if (pattern === 'baby' || pattern === 'flare' || pattern === 'chirp') {
      x = A * 0.5 * (1 - Math.cos((2 * Math.PI * t) / beat))
      const ph = frac(t / beat)
      const u = frac(2 * ph)
      if (pattern === 'chirp') f = ph < 0.5 ? (u < 0.5 ? 1 : 0) : u > 0.5 ? 1 : 0
      else if (pattern === 'flare') f = Math.abs(u - 0.5) < 0.12 ? 0 : 1
    } else if (pattern === 'transformer') {
      x = A * 0.5 * (1 - Math.cos((2 * Math.PI * t) / slow))
      f = frac(t / (beat / 4)) < 0.5 ? 1 : 0
    } else if (pattern === 'scribble') {
      const fs = 16 / sr
      const a = Math.min(0.03 * sr, A * 0.15) * Math.min(2, hand)
      x = A * 0.35 * (1 - Math.cos((2 * Math.PI * t) / slow)) + a * 0.5 * (1 - Math.cos(2 * Math.PI * fs * t))
    } else if (pattern === 'tear') {
      const ph = frac(t / beat)
      if (ph < 0.5) {
        const u = 2 * ph
        const g = u < 0.45 ? 0.5 * smooth01(u / 0.45) : u < 0.55 ? 0.5 : 0.5 + 0.5 * smooth01((u - 0.55) / 0.45)
        x = A * g
      } else {
        x = A * (1 - smooth01(2 * ph - 1))
      }
    }
    pos[k] = x
    if (k < T) fader[k] = f
  }
  smoothFader(fader, sr, 1)
  return { pos, fader }
}

// A backspin: the hand throws the record backwards from normal play and it
// coasts to a stop. Returns per-sample speeds.
function backspinRates(sr, hand) {
  const vmax = Math.max(1.5, Math.min(8, 3.2 * hand))
  const grab = Math.round(0.035 * sr)
  const tau = 0.22 * sr
  const T = grab + Math.round(tau * Math.log(vmax / 0.02))
  const r = new Float32Array(T)
  for (let k = 0; k < T; k++) {
    if (k < grab) r[k] = 1 - (1 + vmax) * smooth01(k / grab)
    else r[k] = -vmax * Math.exp(-(k - grab) / tau)
  }
  return r
}

export default {
  id: 'time.scratch',
  name: 'Record scratch',
  family: 'time',
  about: 'A DJ scratches the first word of each phrase in time before letting it play, or spins the record backwards.',
  params: [
    {
      id: 'pattern',
      name: 'Scratch',
      type: 'choice',
      def: 'baby',
      options: [
        { v: 'baby', name: 'Back and forth' },
        { v: 'chirp', name: 'Chirp' },
        { v: 'transformer', name: 'Fader chops' },
        { v: 'scribble', name: 'Fast shake' },
        { v: 'tear', name: 'Broken stroke' },
        { v: 'flare', name: 'Fader flicks' },
        { v: 'backspin', name: 'Backspin' },
        { v: 'mixed', name: 'A bit of everything' },
      ],
    },
    {
      id: 'where',
      name: 'Where',
      type: 'choice',
      def: 'phrases',
      options: [
        { v: 'phrases', name: 'Each phrase' },
        { v: 'words', name: 'Words' },
        { v: 'end', name: 'At the end' },
      ],
    },
    { id: 'tempo', name: 'Tempo', type: 'number', min: 70, max: 160, step: 1, def: 92, unit: 'bpm', rand: [80, 110] },
    { id: 'beats', name: 'Length', type: 'number', min: 1, max: 8, step: 1, def: 2, unit: 'count', noun: ['beat', 'beats'], rand: [1, 3] },
    { id: 'hand', name: 'Hand speed', type: 'number', min: 0.5, max: 3, step: 0.1, def: 1, unit: 'x', rand: [0.8, 1.8] },
    { id: 'chance', name: 'How often', type: 'number', min: 0, max: 100, step: 1, def: 70, unit: 'percent', rand: [40, 90] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: true,
  cost: 2,
  process(input, p, ctx) {
    const n = prepare(input)
    if (!n) return input
    const sr = input.sr
    const mono = mixDown(input)
    const rng = ctx && ctx.rng ? ctx.rng : makeRng('time.scratch')
    const chance = Math.max(0, Math.min(1, (Number(p.chance) || 0) / 100))
    if (chance <= 0) return input
    const units = p.where === 'words' ? findUnits(mono, sr, 'words') : findPhrases(mono, sr)
    if (!units.length) return input
    const hand = Math.max(0.25, Number(p.hand) || 1)
    const beat = Math.max(16, Math.round((60 / Math.max(30, Number(p.tempo) || 92)) * sr))
    const beats = Math.max(1, Math.round(Number(p.beats) || 1))
    const h = msToSamples(3, sr, 1)
    const spinOnly = p.pattern === 'backspin'
    // which units get a scratch (at least one)
    let picks = []
    if (p.where === 'end') picks = [units.length - 1]
    else {
      for (let k = 0; k < units.length; k++) if (rng.next() < chance) picks.push(k)
      if (!picks.length) picks = [0]
    }
    // scratches never grow the take past three times its length (or 10 s)
    const budget = Math.max(10 * sr, 3 * n)
    let added = 0
    const segs = []
    let cur = 0
    for (let q = 0; q < picks.length; q++) {
      if (added > budget) break
      const u = units[picks[q]]
      let pattern = p.pattern
      if (pattern === 'mixed') pattern = p.where === 'end' && rng.next() < 0.35 ? 'backspin' : STROKES[rng.int(STROKES.length)]
      if (pattern === 'backspin' || spinOnly) {
        // play the unit, then throw the record back over it
        const E = u.end
        if (E <= cur) continue
        segs.push(forwardSeg(cur, E - cur, h))
        const core = backspinRates(sr, hand)
        const m = h + core.length + h
        const rates = new Float32Array(m)
        const gain = new Float32Array(m)
        for (let k = 0; k < h; k++) {
          rates[k] = 1
          gain[k] = 1
        }
        for (let k = 0; k < core.length; k++) {
          rates[h + k] = core[k]
          gain[h + k] = Math.min(1, Math.sqrt(Math.abs(core[k])))
        }
        segs.push(speedSegment(E, rates, h, core.length, { xf: h, gainCurve: gain }))
        cur = E
        added += core.length
        continue
      }
      // scratch the material at the start of the unit (or its end, as an outro)
      const avail = u.end - u.start
      const A = Math.max(msToSamples(30, sr, 8), Math.min(Math.round(0.3 * hand * sr), avail))
      const M0 = p.where === 'end' ? Math.max(u.start, u.end - A - msToSamples(20, sr)) : u.start
      const insertAt = p.where === 'end' ? u.end : u.start
      if (insertAt < cur) continue
      const T = beats * beat
      const mo = strokeMotion(pattern, T, sr, beat, A, hand)
      const m = h + T + h
      const rates = new Float32Array(m)
      const gain = new Float32Array(m)
      for (let k = 0; k < T; k++) {
        const r = mo.pos[k + 1] - mo.pos[k]
        rates[h + k] = r
        gain[h + k] = mo.fader[k] * Math.min(1, Math.sqrt(Math.abs(r) / 0.8))
      }
      if (insertAt > cur) segs.push(forwardSeg(cur, insertAt - cur, h))
      segs.push(speedSegment(M0, rates, h, T, { xf: h, gainCurve: gain, stopFade: 0.02 }))
      cur = insertAt
      added += T
    }
    if (cur < n) segs.push(forwardSeg(cur, n - cur, h))
    const out = renderBuf(input, segs)
    if (ctx && typeof ctx.progress === 'function') ctx.progress(1)
    return out
  },
}
