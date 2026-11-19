// modules/pitch/harmonizer.js - pitch.harmonizer, "Harmony in a key".
//
// Technique: a diatonic ("intelligent") harmonizer, the kind built into
// vocal harmony processors since the late 1980s. A plain pitch shifter moves
// every note by the same number of semitones, so "a third above" is always a
// major third and half the harmony notes fall outside the song's key. Here
// the interval is counted in steps of the chosen scale instead:
// - the sung pitch is tracked (core/pitch.js, YIN) and, cycle by cycle, the
//   nearest note of the key and scale is chosen with a little hysteresis
//   (the Corrector of ./correct.js, the scale-quantising method of
//   Hildebrand's pitch-correction patent, US 5,973,252);
// - the harmony note is that note moved up or down the scale by the asked
//   number of steps (a third is two steps, a fifth four, an octave the whole
//   scale), so a third above C in C major is E (four semitones) but a third
//   above D is F (three semitones): the harmony stays in key;
// - each harmony singer is the lead re-pitched to that note with
//   core/voice.js retuneVoiceBuf (TD-PSOLA, Moulines and Charpentier 1990),
//   every glottal cycle multiplied by the interval, so it keeps the lead's
//   own scoops, vibrato and timing. "Snap to the notes" also pulls the
//   harmony onto the exact note (pitch correction for the harmony only),
//   which is the tight sound of a produced backing vocal;
// - a small timbre move that follows the interval (a higher part sounds like
//   a slightly smaller singer, a lower part like a bigger one) keeps the
//   parts from sounding like one person copied.
// The lead is never touched. Two harmony parts are available; they are placed
// left and right by the stereo spread, the lead stays in the middle. Sounds
// with no pitch (breath, s and t) are sung by the harmony parts unchanged.
//
// Five- and six-note scales have wider steps, so the named intervals are
// scaled to them (a "third" is the scale step nearest two sevenths of the
// way up the octave); with seven-note scales they are the textbook ones.

import { retuneVoiceBuf } from '../../core/voice.js'
import { f0At, SCALES } from '../../core/pitch.js'
import { Corrector } from './correct.js'
import { analyse, cleanBuf, usable, monoMix, KEY_OPTIONS, keyIndex, panGains, progress, clamp } from './_lib.js'

const SCALE_OPTIONS = [
  { v: 'major', name: 'Major' },
  { v: 'minor', name: 'Minor' },
  { v: 'harmonic-minor', name: 'Harmonic minor' },
  { v: 'dorian', name: 'Dorian' },
  { v: 'mixolydian', name: 'Mixolydian' },
  { v: 'pentatonic', name: 'Pentatonic major' },
  { v: 'minor-pentatonic', name: 'Pentatonic minor' },
  { v: 'blues', name: 'Blues' },
]

// interval choice -> steps of a seven-note scale (0 with off=false is a unison double)
const PARTS = {
  off: null,
  'third-up': 2,
  'fourth-up': 3,
  'fifth-up': 4,
  'sixth-up': 5,
  'octave-up': 7,
  'third-down': -2,
  'fourth-down': -3,
  'fifth-down': -4,
  'sixth-down': -5,
  'octave-down': -7,
  unison: 0,
}

const PART_OPTIONS = [
  { v: 'off', name: 'Off' },
  { v: 'third-up', name: 'A third above' },
  { v: 'fourth-up', name: 'A fourth above' },
  { v: 'fifth-up', name: 'A fifth above' },
  { v: 'sixth-up', name: 'A sixth above' },
  { v: 'octave-up', name: 'An octave above' },
  { v: 'third-down', name: 'A third below' },
  { v: 'fourth-down', name: 'A fourth below' },
  { v: 'fifth-down', name: 'A fifth below' },
  { v: 'sixth-down', name: 'A sixth below' },
  { v: 'octave-down', name: 'An octave below' },
  { v: 'unison', name: 'The same note, a second singer' },
]

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

/** Steps to move in this scale for an interval given in seven-note-scale steps. */
function scaleSteps(sevenths, len) {
  if (len === 7) return sevenths
  return Math.round((sevenths * len) / 7)
}

/** The scale note `steps` scale steps away from `note` (a note of the scale, as a MIDI number). */
export function moveInScale(note, steps, scale, key) {
  const L = scale.length
  const rel = Math.round(note) - key
  const oct = Math.floor(rel / 12)
  const pc = rel - 12 * oct
  let idx = 0
  let bd = Infinity
  for (let i = 0; i < L; i++) {
    const d = Math.abs(scale[i] - pc)
    if (d < bd) {
      bd = d
      idx = i
    }
  }
  const j = idx + steps
  const o2 = Math.floor(j / L)
  return key + 12 * (oct + o2) + scale[j - o2 * L]
}

/** One harmony part: the mono lead re-pitched, as a Float32Array. */
function singPart(mono, sr, track, scale, key, sevenths, snap, timbre, seed) {
  const steps = scaleSteps(sevenths, scale.length)
  // the note decision: 30 ms retune, so the snap is firm but not a hard step
  const cor = new Corrector(scale, key, 0.03, 0)
  let semis = 0
  let have = false
  const targetFn = (t, f0) => {
    const ft = f0At(track, t * sr)
    const corr = cor.step(t, ft > 0 ? ft : f0)
    const want = moveInScale(cor.note, steps, scale, key) - cor.note
    // an interval change lands with the lead's own note change; glide the few
    // cycles around it so a tracker flicker cannot make the part yodel
    if (!have) {
      semis = want
      have = true
    } else semis += (want - semis) * 0.5
    return f0 * Math.pow(2, (semis + snap * corr) / 12)
  }
  const typical = (steps / scale.length) * 12
  const formant = clamp((typical / 12) * 1.4 * timbre, -3, 3)
  const out = retuneVoiceBuf({ sr, ch: [mono] }, { track, targetFn, formant, seed })
  return out.ch[0]
}

export default {
  id: 'pitch.harmonizer',
  name: 'Harmony in a key',
  family: 'pitch',
  about: 'Adds one or two harmony singers who stay in the key of the song: a third above in C major is sometimes four semitones and sometimes three, as a real singer would do it.',
  params: [
    { id: 'key', name: 'Key', type: 'choice', def: 'C', options: KEY_OPTIONS },
    { id: 'scale', name: 'Scale', type: 'choice', def: 'major', options: SCALE_OPTIONS },
    { id: 'part1', name: 'First harmony', type: 'choice', def: 'third-up', options: PART_OPTIONS },
    { id: 'part2', name: 'Second harmony', type: 'choice', def: 'off', options: PART_OPTIONS },
    { id: 'snap', name: 'Snap the harmony to the notes', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [30, 90] },
    { id: 'timbre', name: 'Different singers', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [30, 80] },
    { id: 'spread', name: 'Stereo spread', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [30, 90] },
    { id: 'level', name: 'Harmony level', type: 'number', min: -24, max: 6, step: 0.5, def: -4, unit: 'db', rand: [-9, -2] },
    { id: 'lead', name: 'Keep your own voice', type: 'bool', def: true },
  ],
  stereo: 'make',
  tail: () => 0,
  warps: false,
  cost: 5,
  process(input, p, ctx) {
    if (!usable(input)) return { sr: input.sr, ch: [new Float32Array(0), new Float32Array(0)] }
    cleanBuf(input)
    const n = input.ch[0].length
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    if (!(p && p.lead === false)) {
      L.set(input.ch[0])
      R.set(input.ch.length > 1 ? input.ch[1] : input.ch[0])
    }
    const parts = []
    for (const id of ['part1', 'part2']) {
      const v = p ? p[id] : null
      if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(PARTS, v) && PARTS[v] !== null) parts.push(PARTS[v])
    }
    if (!parts.length) {
      progress(ctx, 1)
      return { sr: input.sr, ch: [L, R] }
    }
    const an = analyse(input)
    const sr = an.sr
    const mono = monoMix(input)
    progress(ctx, 0.15)
    const scale = SCALES[p.scale] || SCALES.major
    const key = keyIndex(p.key)
    const snap = clamp(num(p.snap, 60) / 100, 0, 1)
    const timbre = clamp(num(p.timbre, 50) / 100, 0, 1)
    const spread = clamp(num(p.spread, 60) / 100, 0, 1)
    const gain = Math.pow(10, clamp(num(p.level, -4), -24, 6) / 20)
    for (let k = 0; k < parts.length; k++) {
      const y = singPart(mono, sr, an.track, scale, key, parts[k], snap, timbre, 'harmonizer-' + k)
      // one part sits a little to the left; two sit left and right
      const pos = parts.length === 1 ? -0.5 * spread : (k === 0 ? -1 : 1) * spread
      const pg = panGains(pos)
      const gl = gain * pg[0] * Math.SQRT2
      const gr = gain * pg[1] * Math.SQRT2
      const m = Math.min(n, y.length)
      for (let i = 0; i < m; i++) {
        const v = y[i]
        if (v > -1e9 && v < 1e9) {
          L[i] += v * gl
          R[i] += v * gr
        }
      }
      progress(ctx, 0.15 + (0.85 * (k + 1)) / parts.length)
    }
    return cleanBuf({ sr: input.sr, ch: [L, R] })
  },
}
