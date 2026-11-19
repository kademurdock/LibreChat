// modules/pitch/correct.js - pitch.correct, "Pitch correction".
//
// Technique: scale-quantised pitch correction with a retune time constant,
// the method published in Hildebrand's pitch-correction patent (US 5,973,252,
// 1999) and taught in every vocal-production text: track the sung pitch,
// pick the nearest note of the chosen key and scale, and move the voice
// toward it at a set speed. Here the move is made cycle by cycle with
// core/voice.js retuneVoiceBuf (TD-PSOLA, Moulines and Charpentier 1990), so
// each glottal cycle lands on exactly the frequency asked for.
//
// For every voiced cycle at time t:
// - the decision pitch m (a MIDI note number) is the pitch track's value at
//   t, lightly smoothed (12 ms) and limited to two semitones of movement per
//   cycle, because one cycle's own period is too noisy to choose a note on
//   and a tracker octave slip must not throw the note;
// - the target note is the nearest scale note (core/pitch.js snapToScale),
//   with a tenth of a semitone of hysteresis so a voice sitting on the line
//   between two notes does not flicker between them;
// - the wanted correction is c = target - m; Humanize lets part of the
//   wobble inside a held note through (it grows over the first 300 ms of a
//   note), so long notes keep some life while note changes stay sharp;
// - the applied correction follows c with a one-pole smoother of time
//   constant "Retune speed", and the cycle's own pitch is moved by it. At 0
//   (with Humanize at 0) every cycle is given exactly the note's frequency
//   and note changes are instant steps, the hard, robotic snap. At 50 to 100 ms the voice is pulled into tune but glides
//   between notes and keeps its natural scoops, the "natural" setting.
// A new voiced run starts already corrected, so every word lands on a note.
//
// Timbre follows (off by default) moves the formants by the same correction,
// which is the cheaper, more synthetic sound of a plain resampling shifter.
// Its curve is simulated once on the pitch track's frames (the same
// corrector, run on the tracked f0), since the formant copy is made before
// the cycles are re-pitched.

import { retuneVoiceBuf } from '../../core/voice.js'
import { noteOf, hzOf, f0At, snapToScale, SCALES } from '../../core/pitch.js'
import { analyse, cleanBuf, usable, KEY_OPTIONS, keyIndex, ControlCurve, progress } from './_lib.js'

const EXTRA_SCALES = {
  power: [0, 7],
  root: [0],
}

const SCALE_OPTIONS = [
  { v: 'chromatic', name: 'Every note' },
  { v: 'major', name: 'Major' },
  { v: 'minor', name: 'Minor' },
  { v: 'pentatonic', name: 'Pentatonic major' },
  { v: 'minor-pentatonic', name: 'Pentatonic minor' },
  { v: 'blues', name: 'Blues' },
  { v: 'dorian', name: 'Dorian' },
  { v: 'mixolydian', name: 'Mixolydian' },
  { v: 'lydian', name: 'Lydian' },
  { v: 'phrygian', name: 'Phrygian' },
  { v: 'harmonic-minor', name: 'Harmonic minor' },
  { v: 'whole-tone', name: 'Whole tone' },
  { v: 'power', name: 'Key note and fifth only' },
  { v: 'root', name: 'Key note only' },
]

const HYST = 0.1 // semitones past the midpoint before a note change
const NEW_RUN = 0.08 // seconds of no voiced cycles that start a new run

function stepsOf(scale) {
  return EXTRA_SCALES[scale] || SCALES[scale] || SCALES.chromatic
}

/**
 * The stateful corrector: call step(t, f0) in time order; returns the
 * semitones to add to f0. f0 is the pitch the decision is made on (the
 * pitch track's smoothed value); this.note is the chosen note afterwards.
 */
export class Corrector {
  constructor(steps, key, tauSec, humanize) {
    this.steps = steps
    this.key = key
    this.tau = tauSec
    this.h = humanize
    this.lastT = -1e9
    this.note = 0
    this.noteStart = 0
    this.applied = 0
    this.m = 0
  }
  step(t, f0) {
    let raw = noteOf(f0)
    if (!(raw > -1e6 && raw < 1e6)) return 0
    const dt = t - this.lastT
    const fresh = dt > NEW_RUN || dt < 0
    // a voice moves at most a couple of semitones from one cycle to the
    // next; a bigger jump is a tracker octave slip and is mostly ignored
    if (!fresh) raw = this.m + Math.max(-2, Math.min(2, raw - this.m))
    // a light 12 ms smoothing of the decision pitch, so measurement noise
    // from one cycle to the next never flips the note
    if (fresh) this.m = raw
    else this.m += (raw - this.m) * (1 - Math.exp(-dt / 0.012))
    const m = this.m
    let cand = snapToScale(m, this.steps, this.key)
    if (fresh) {
      this.note = cand
      this.noteStart = t
    } else if (cand !== this.note) {
      // switch only when clearly nearer the new note
      if (Math.abs(m - this.note) - Math.abs(m - cand) > 2 * HYST) {
        this.note = cand
        this.noteStart = t
      }
    }
    let c = this.note - m
    if (this.h > 0) {
      const x = (t - this.noteStart - 0.06) / 0.3
      const ramp = x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x)
      c *= 1 - 0.75 * this.h * ramp
    }
    if (fresh || !(this.tau > 0)) this.applied = c
    else this.applied += (c - this.applied) * (1 - Math.exp(-dt / this.tau))
    this.lastT = t
    return this.applied
  }
}

export default {
  id: 'pitch.correct',
  name: 'Pitch correction',
  family: 'pitch',
  about: 'Snaps your voice onto the notes of a key. Retune speed 0 is the hard robotic snap; 50 to 100 milliseconds sounds natural.',
  params: [
    { id: 'key', name: 'Key', type: 'choice', def: 'C', options: KEY_OPTIONS },
    { id: 'scale', name: 'Scale', type: 'choice', def: 'chromatic', options: SCALE_OPTIONS },
    { id: 'speed', name: 'Retune speed', type: 'number', min: 0, max: 400, step: 1, def: 0, unit: 'ms', rand: [0, 120] },
    { id: 'humanize', name: 'Humanize', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 50] },
    { id: 'formant', name: 'Timbre follows', type: 'bool', def: false },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    if (!usable(input)) return input
    cleanBuf(input)
    const an = analyse(input)
    const sr = an.sr
    const steps = stepsOf(p.scale)
    const key = keyIndex(p.key)
    const tau = Math.max(0, Number(p.speed) || 0) / 1000
    const hum = Math.min(1, Math.max(0, (Number(p.humanize) || 0) / 100))
    progress(ctx, 0.2)
    const opts = { track: an.track }
    if (p.formant) {
      const tr = an.track
      const frameRate = sr / tr.hop
      const nf = tr.f0.length
      const cc = new ControlCurve(nf / frameRate + 0.1, frameRate)
      const sim = new Corrector(steps, key, tau, hum)
      let last = 0
      for (let f = 0; f < cc.n; f++) {
        if (f < nf && tr.f0[f] > 0) last = sim.step(f / frameRate, tr.f0[f])
        cc.v[f] = Math.max(-12, Math.min(12, last))
      }
      opts.formant = cc.fn()
    }
    const cor = new Corrector(steps, key, tau, hum)
    const tr = an.track
    const exact = !(tau > 0) && !(hum > 0)
    opts.targetFn = (t, f0) => {
      // decide on the track's smooth pitch; a cycle's own period is noisy
      const ft = f0At(tr, t * sr)
      const corr = cor.step(t, ft > 0 ? ft : f0)
      // the hard snap: exactly the note, every cycle
      if (exact) return hzOf(cor.note)
      return f0 * Math.pow(2, corr / 12)
    }
    const out = retuneVoiceBuf(input, opts)
    progress(ctx, 1)
    return cleanBuf(out)
  },
}
