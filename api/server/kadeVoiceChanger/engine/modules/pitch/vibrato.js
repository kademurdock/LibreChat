// modules/pitch/vibrato.js - pitch.vibrato, "Vibrato".
//
// Technique: a singer's vibrato, applied cycle by cycle. Every glottal cycle
// is re-pitched through core/voice.js retuneVoiceBuf (TD-PSOLA, Moulines and
// Charpentier 1990), so the timbre stays where it is and only the note
// swings, which is what real vibrato does (Sundberg, "The Science of the
// Singing Voice", 1987: a rate near 5.5 to 6 Hz and an extent of about plus or
// minus a semitone in classical singing). Like a singer, each vowel run starts
// steady and the vibrato fades in after the onset delay; the rate drifts by a
// few percent so it never sounds like a machine; and the level swings a
// little with the pitch (the amplitude vibrato that comes from harmonics
// moving across the formants), set by Throb.
//
// The modulation (onset envelope times the oscillator) is computed once at a
// 1 kHz control rate from the voiced runs of the pitch track, and both the
// pitch and the level read that one curve.

import { retuneVoiceBuf } from '../../core/voice.js'
import { analyse, cleanBuf, usable, rngOf, voicedRuns, ControlCurve, smoothRandom, progress } from './_lib.js'

const RISE = 0.15 // seconds for the vibrato to fade in after the delay

export default {
  id: 'pitch.vibrato',
  name: 'Vibrato',
  family: 'pitch',
  about: 'Makes your voice waver up and down like a singer holding a note.',
  params: [
    { id: 'rate', name: 'Speed', type: 'number', min: 1, max: 12, step: 0.1, def: 5.5, unit: 'hz', rand: [4, 7.5] },
    { id: 'depth', name: 'Depth', type: 'number', min: 0, max: 300, step: 1, def: 70, unit: 'cents', rand: [30, 140] },
    { id: 'delay', name: 'Onset delay', type: 'number', min: 0, max: 2000, step: 10, def: 80, unit: 'ms', rand: [0, 250] },
    {
      id: 'shape',
      name: 'Shape',
      type: 'choice',
      def: 'sine',
      options: [
        { v: 'sine', name: 'Smooth' },
        { v: 'triangle', name: 'Triangle' },
        { v: 'random', name: 'Wandering' },
      ],
    },
    { id: 'throb', name: 'Throb', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 50] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    if (!usable(input)) return input
    cleanBuf(input)
    const depth = Number(p.depth) || 0
    const throb = (Number(p.throb) || 0) / 100
    if (depth === 0 && throb === 0) return input
    const an = analyse(input)
    const sr = an.sr
    const n = input.ch[0].length
    const secs = n / sr
    const rng = rngOf(ctx, 'vibrato')
    const runs = voicedRuns(an.track, sr, 0.06)
    const rate = Math.max(0.1, Number(p.rate) || 5.5)
    const delay = Math.max(0, Number(p.delay) || 0) / 1000
    const shape = p.shape
    const drift = smoothRandom(secs + 1, 0.8, rng.fork('drift'))
    const wander = shape === 'random' ? smoothRandom(secs + 1, rate, rng.fork('wander')) : null
    const mod = new ControlCurve(secs + 0.5, 1000)
    {
      const v = mod.v
      const cr = mod.rate
      let r = 0
      let phase = 0
      let curRun = -1
      for (let i = 0; i < mod.n; i++) {
        const t = i / cr
        while (r + 1 < runs.length && runs[r + 1][0] <= t) r++
        let env = 0
        if (runs.length && t >= runs[r][0] && t <= runs[r][1] + 0.05) {
          if (curRun !== r) {
            curRun = r
            phase = 0
          }
          const tin = t - runs[r][0]
          const x = (tin - delay) / RISE
          env = x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x)
        }
        let lfo
        if (wander) lfo = wander.at(t)
        else if (shape === 'triangle') lfo = phase < 0.25 ? 4 * phase : phase < 0.75 ? 2 - 4 * phase : 4 * phase - 4
        else lfo = Math.sin(2 * Math.PI * phase)
        v[i] = env * lfo
        phase += (rate * (1 + 0.04 * drift.at(t))) / cr
        if (phase >= 1) phase -= Math.floor(phase)
      }
    }
    progress(ctx, 0.2)
    let out = input
    if (depth > 0) {
      const k = depth / 1200
      out = retuneVoiceBuf(input, {
        track: an.track,
        targetFn: (t, f0) => f0 * Math.pow(2, k * mod.at(t)),
      })
    }
    progress(ctx, 0.9)
    if (throb > 0) {
      const a = 0.3 * throb
      const inv = 1 / sr
      for (let c = 0; c < out.ch.length; c++) {
        const s = out.ch[c]
        for (let i = 0; i < n; i++) s[i] *= 1 + a * mod.at(i * inv)
      }
    }
    progress(ctx, 1)
    return cleanBuf(out)
  },
}
