// modules/pitch/arp.js - pitch.arp, "Melody voice".
//
// Technique: an arpeggiator (the step sequencer of synthesizers since the
// 1970s) driving a cycle-by-cycle re-pitcher, core/voice.js retuneVoiceBuf
// (TD-PSOLA, Moulines and Charpentier 1990). Your words keep their timing
// and timbre, but every voiced cycle is sung on the current note of a
// pattern that steps at a fixed rate through a chord or scale. The pattern
// is placed near your own middle pitch, so it stays in your range; with
// "start each phrase" on, every phrase (speech between pauses of a quarter
// second or more) begins again on the key note, so the melody fits your
// sentences. Glide is portamento: a one-pole slide in log frequency.

import { retuneVoiceBuf } from '../../core/voice.js'
import { noteOf, hzOf } from '../../core/pitch.js'
import { analyse, cleanBuf, usable, rngOf, voicedRuns, runAt, KEY_OPTIONS, keyIndex, progress } from './_lib.js'

const POOLS = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  seventh: [0, 4, 7, 10],
  'major-scale': [0, 2, 4, 5, 7, 9, 11],
  'minor-scale': [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
  blues: [0, 3, 5, 6, 7, 10],
  'whole-tone': [0, 2, 4, 6, 8, 10],
  octaves: [0],
}

export default {
  id: 'pitch.arp',
  name: 'Melody voice',
  family: 'pitch',
  about: 'Sings your speech along a stepping melody: your words, but on the notes of a chord or scale.',
  params: [
    {
      id: 'pattern',
      name: 'Pattern',
      type: 'choice',
      def: 'updown',
      options: [
        { v: 'up', name: 'Climbing' },
        { v: 'down', name: 'Falling' },
        { v: 'updown', name: 'Up and down' },
        { v: 'random', name: 'Random' },
        { v: 'pedal', name: 'Back to the key note between notes' },
      ],
    },
    {
      id: 'notes',
      name: 'Notes',
      type: 'choice',
      def: 'major',
      options: [
        { v: 'major', name: 'Major chord' },
        { v: 'minor', name: 'Minor chord' },
        { v: 'seventh', name: 'Seventh chord' },
        { v: 'major-scale', name: 'Major scale' },
        { v: 'minor-scale', name: 'Minor scale' },
        { v: 'pentatonic', name: 'Pentatonic scale' },
        { v: 'blues', name: 'Blues scale' },
        { v: 'whole-tone', name: 'Whole tone scale' },
        { v: 'octaves', name: 'Octaves' },
      ],
    },
    { id: 'key', name: 'Key', type: 'choice', def: 'auto', options: [{ v: 'auto', name: 'Near your own pitch' }].concat(KEY_OPTIONS) },
    { id: 'rate', name: 'Notes per second', type: 'number', min: 0.5, max: 16, step: 0.1, def: 5, unit: 'hz', rand: [2, 9] },
    { id: 'glide', name: 'Glide', type: 'number', min: 0, max: 300, step: 1, def: 25, unit: 'ms', rand: [0, 80] },
    { id: 'range', name: 'Range', type: 'number', min: 1, max: 3, step: 1, def: 1, unit: 'count', noun: ['octave', 'octaves'] },
    { id: 'restart', name: 'Start each phrase on the key note', type: 'bool', def: true },
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
    const rng = rngOf(ctx, 'melody')
    const med = an.median > 0 ? an.median : 140
    const mMed = noteOf(med)
    // the root: the key note just under the middle pitch, so the pattern
    // climbs through the voice's own range
    let root
    if (p.key === 'auto' || !p.key) root = Math.round(mMed) - 3
    else {
      const pc = keyIndex(p.key)
      root = pc + 12 * Math.floor((mMed - 4 - pc) / 12)
      if (mMed - root > 9) root += 12
    }
    const pool = POOLS[p.notes] || POOLS.major
    const range = Math.max(1, Math.min(3, Math.round(Number(p.range) || 1)))
    const notes = []
    for (let o = 0; o < range; o++) for (const s of pool) notes.push(root + 12 * o + s)
    notes.push(root + 12 * range)
    const N = notes.length
    const randSeq = new Int16Array(4096)
    {
      let prev = -1
      for (let i = 0; i < randSeq.length; i++) {
        let k = rng.int(N)
        if (k === prev && N > 1) k = (k + 1 + rng.int(N - 1)) % N
        randSeq[i] = k
        prev = k
      }
    }
    const pattern = p.pattern
    const noteAt = (k) => {
      const kk = k < 0 ? 0 : k
      switch (pattern) {
        case 'up':
          return notes[kk % N]
        case 'down':
          return notes[N - 1 - (kk % N)]
        case 'random':
          return notes[randSeq[kk % randSeq.length]]
        case 'pedal':
          return kk % 2 === 0 || N < 2 ? notes[0] : notes[1 + ((kk >> 1) % (N - 1))]
        default: {
          if (N < 2) return notes[0]
          const per = 2 * N - 2
          const q = kk % per
          return notes[q < N ? q : per - q]
        }
      }
    }
    const rate = Math.max(0.1, Number(p.rate) || 5)
    const tau = Math.max(0, Number(p.glide) || 0) / 1000
    const phrases = p.restart ? voicedRuns(an.track, sr, 0.25) : null
    let cur = 0
    let lastT = -1e9
    progress(ctx, 0.2)
    const out = retuneVoiceBuf(input, {
      track: an.track,
      targetFn: (t) => {
        let t0 = 0
        if (phrases && phrases.length) {
          const r = runAt(phrases, t)
          if (r >= 0) t0 = phrases[r][0]
        }
        const want = noteAt(Math.floor((t - t0) * rate))
        const dt = t - lastT
        if (dt > 0.08 || dt < 0 || !(tau > 0)) cur = want
        else cur += (want - cur) * (1 - Math.exp(-dt / tau))
        lastT = t
        return hzOf(cur)
      },
    })
    progress(ctx, 1)
    return cleanBuf(out)
  },
}
