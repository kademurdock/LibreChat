// modules/pitch/harmony.js - pitch.harmony, "Harmony voices".
//
// Technique: an intelligent-harmony stack made of whole extra singers rather
// than delayed copies. Each harmony voice is the lead re-pitched by its chord
// interval with core/voice.js shiftVoiceBuf (TD-PSOLA after a resampling
// formant move, Moulines and Charpentier 1990), and is then given the
// differences that make an ensemble sound like separate people, the ones
// measured in choir studies (Ternstrom, "Choir acoustics: an overview of
// scientific research published to date", 2003, and Sundberg's ensemble
// work: section singers scatter by about 10 to 20 cents and by tens of
// milliseconds in their onsets):
// - its own timbre: a formant offset that follows the interval (a voice an
//   octave up sounds like a smaller singer, an octave down like a bigger one,
//   a little over a semitone either way) plus a random personal offset of up
//   to about half a semitone;
// - its own tuning: a fixed detune plus a slow, independent pitch drift
//   (smooth random near 0.3 to 0.6 Hz), so voices beat against each other
//   the way people do instead of combing like one signal;
// - its own timing: a personal lag or lead (offline we can read ahead, so a
//   singer may come in slightly early) that wanders slowly, read with cubic
//   Hermite interpolation;
// - its own level, drifting by about a decibel and a half;
// - its own place in the stereo picture (constant-power panning), spread
//   evenly and interleaved across the parts, with the lead in the centre.
// The lead (the dry voice) is never moved. Mix 50 keeps the lead and the
// harmony at full level; below that the harmony fades, above it the lead.
// The output runs past the end of the take by the latest any singer can be
// (its personal lag, up to the timing spread, plus its wander, up to a
// quarter more), so the late singers finish their last word; tail() reports
// exactly that, and process() returns input + round(tail * sr) samples.

import { shiftVoiceBuf } from '../../core/voice.js'
import { analyse, cleanBuf, usable, rngOf, smoothRandom, panGains, progress } from './_lib.js'

const CHORDS = {
  major: [4, 7],
  minor: [3, 7],
  'third-up': [4],
  'fifth-up': [7],
  'fourth-down': [-5],
  'octave-up': [12],
  'octave-down': [-12],
  octaves: [-12, 12],
  power: [7, -12],
  sus: [5, 7],
  seventh: [4, 7, 10],
  diminished: [3, 6],
  augmented: [4, 8],
  barbershop: [4, -5, -12],
  'big-choir': [-12, 4, 7, 12],
  unison: [0],
}

const CHORD_OPTIONS = [
  { v: 'major', name: 'Major chord' },
  { v: 'minor', name: 'Minor chord' },
  { v: 'third-up', name: 'A third above' },
  { v: 'fifth-up', name: 'A fifth above' },
  { v: 'fourth-down', name: 'A fourth below' },
  { v: 'octave-up', name: 'An octave above' },
  { v: 'octave-down', name: 'An octave below' },
  { v: 'octaves', name: 'Octaves above and below' },
  { v: 'power', name: 'Power chord' },
  { v: 'sus', name: 'Suspended chord' },
  { v: 'seventh', name: 'Seventh chord' },
  { v: 'diminished', name: 'Diminished chord' },
  { v: 'augmented', name: 'Augmented chord' },
  { v: 'barbershop', name: 'Barbershop quartet' },
  { v: 'big-choir', name: 'Big choir' },
  { v: 'unison', name: 'Same note, more singers' },
]

const MAX_VOICES = 12

// The latest a singer can sound after the lead, in seconds: the personal
// offset reaches a full timing spread late and the slow wander adds up to a
// quarter of the spread more; one millisecond more covers the interpolator's
// reach. With the mix at 0 there are no singers and so no tail. tail() and
// process() read timing and mix the same way (a missing value reads as its
// default, as resolveParams would), so the two always agree.
function timingOf(p) {
  const v = p && p.timing != null ? Number(p.timing) : 25
  return v > 0 && v < Infinity ? Math.min(v, 80) / 1000 : 0
}
function mixOf(p) {
  const v = p && p.mix != null ? Number(p.mix) : 50
  return v > 0 ? Math.min(1, v / 100) : 0
}
function tailOf(p) {
  const timing = timingOf(p)
  if (!(timing > 0) || !(mixOf(p) > 0)) return 0
  return 1.25 * timing + 0.001
}

export default {
  id: 'pitch.harmony',
  name: 'Harmony voices',
  family: 'pitch',
  about: 'Extra singers made from your voice join in on a chord, each with its own timing, tuning and timbre.',
  params: [
    { id: 'chord', name: 'Chord', type: 'choice', def: 'major', options: CHORD_OPTIONS },
    { id: 'voices', name: 'Singers per note', type: 'number', min: 1, max: 4, step: 1, def: 2, unit: 'count', noun: ['singer', 'singers'], rand: [1, 3] },
    { id: 'spread', name: 'Stereo spread', type: 'number', min: 0, max: 100, step: 1, def: 70, unit: 'percent', rand: [40, 100] },
    { id: 'detune', name: 'Detune', type: 'number', min: 0, max: 50, step: 1, def: 12, unit: 'cents', rand: [5, 25] },
    { id: 'timing', name: 'Timing spread', type: 'number', min: 0, max: 80, step: 1, def: 25, unit: 'ms', rand: [10, 45] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [35, 65] },
  ],
  stereo: 'make',
  tail: (p) => tailOf(p),
  warps: false,
  cost: 5,
  process(input, p, ctx) {
    if (!usable(input)) {
      const z = input && input.ch && input.ch[0] ? input.ch[0].length : 0
      return { sr: input && input.sr ? input.sr : 48000, ch: [new Float32Array(z), new Float32Array(z)] }
    }
    cleanBuf(input)
    const an = analyse(input)
    const sr = an.sr
    const n = input.ch[0].length
    const secs = n / sr
    const rng = rngOf(ctx, 'harmony')
    const parts = CHORDS[p.chord] || CHORDS.major
    let per = Math.max(1, Math.round(Number(p.voices) || 1))
    while (per > 1 && parts.length * per > MAX_VOICES) per--
    const spread = Math.min(1, Math.max(0, (Number(p.spread) || 0) / 100))
    const detune = Math.max(0, Number(p.detune) || 0)
    const timing = timingOf(p)
    const mix = mixOf(p)
    const dryG = mix <= 0.5 ? 1 : 2 * (1 - mix)
    const wetG = mix >= 0.5 ? 1 : 2 * mix
    // the take plus the tail, so the latest singer finishes
    const nOut = n + Math.round(tailOf(p) * sr)
    const L = new Float32Array(nOut)
    const R = new Float32Array(nOut)
    // the lead, untouched, in the centre (a stereo take keeps its own image)
    if (dryG > 0) {
      const a = input.ch[0]
      const b = input.ch.length > 1 ? input.ch[1] : input.ch[0]
      for (let i = 0; i < n; i++) {
        L[i] = dryG * a[i]
        R[i] = dryG * b[i]
      }
    }
    if (wetG <= 0) return cleanBuf({ sr: input.sr, ch: [L, R] })
    const monoBuf = { sr, ch: [an.mono] }
    const total = parts.length * per
    // seats across the stage, interleaving the parts: voice k of part j
    // sits at slot k * parts + j
    const seats = new Float32Array(total)
    for (let s = 0; s < total; s++) seats[s] = total === 1 ? (rng.next() < 0.5 ? -0.35 : 0.35) : -1 + (2 * s) / (total - 1)
    // timing slots: the singers' personal offsets are spread over the whole
    // timing range (stratified, then shuffled), so no two singers sit on the
    // same offset and the stack never collapses into one comb-filtered copy
    const slots = new Float32Array(total)
    for (let s = 0; s < total; s++) slots[s] = (s + 0.25 + 0.5 * rng.next()) / total
    for (let s = total - 1; s > 0; s--) {
      const q = rng.int(s + 1)
      const tmp = slots[s]
      slots[s] = slots[q]
      slots[q] = tmp
    }
    // each part sounds about as loud as 0.8 of the lead
    const g0 = (0.8 * wetG) / Math.sqrt(per)
    let done = 0
    for (let j = 0; j < parts.length; j++) {
      const s = parts[j]
      for (let k = 0; k < per; k++) {
        const vr = rng.fork('voice-' + j + '-' + k)
        const fixed = detune * (vr.next() * 2 - 1) * 0.6
        const driftHz = 0.3 + 0.3 * vr.next()
        const drift = smoothRandom(secs + 1, driftHz, vr.fork('drift'), 200)
        const semis = (t) => s + (fixed + detune * 0.7 * drift.at(t)) / 100
        let formant = Math.max(-1.6, Math.min(1.6, s * 0.12)) + (vr.next() * 2 - 1) * 0.55
        if (s === 0 && Math.abs(formant) < 0.2) formant = formant < 0 ? -0.3 : 0.3
        const sv = shiftVoiceBuf(monoBuf, { semitones: semis, formant, track: an.track, seed: 'harmony-' + j + '-' + k }).ch[0]
        // the singer with one zero before and two after, so the interpolator
        // can read right up to (and past) both ends: v[m + 1] is sample m
        const v = new Float32Array(n + 3)
        v.set(sv.length > n ? sv.subarray(0, n) : sv, 1)
        // timing: a personal offset, from slightly early to a full spread late
        const base = timing * (-0.35 + 1.35 * slots[k * parts.length + j]) * sr
        const wanderAmt = 0.25 * timing * sr
        const wander = smoothRandom(secs + 1, 0.12 + 0.1 * vr.next(), vr.fork('time'), 200)
        const level = smoothRandom(secs + 1, 0.2, vr.fork('level'), 200)
        const lvBase = 0.85 + 0.15 * vr.next()
        const pan = panGains(seats[k * parts.length + j] * spread)
        const gl = g0 * pan[0] * lvBase
        const gr = g0 * pan[1] * lvBase
        const inv = 1 / sr
        for (let i = 0; i < nOut; i++) {
          const t = i * inv
          const pos = i - (base + wanderAmt * wander.at(t))
          const i1 = Math.floor(pos)
          // sample i1 is v[i1 + 1]; outside 0..n-1 the singer is silent
          if (i1 < 0 || i1 >= n) continue
          const fr = pos - i1
          const y0 = v[i1]
          const y1 = v[i1 + 1]
          const y2 = v[i1 + 2]
          const y3 = v[i1 + 3]
          // cubic Hermite (Catmull-Rom)
          const c1 = 0.5 * (y2 - y0)
          const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3
          const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2)
          const y = ((c3 * fr + c2) * fr + c1) * fr + y1
          // about plus or minus 1.5 dB of drift
          const lv = 1 + 0.17 * level.at(t)
          L[i] += gl * lv * y
          R[i] += gr * lv * y
        }
        done++
        progress(ctx, done / total)
      }
    }
    return cleanBuf({ sr: input.sr, ch: [L, R] })
  },
}
