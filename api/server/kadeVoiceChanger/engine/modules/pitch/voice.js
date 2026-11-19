// modules/pitch/voice.js - pitch.voice, "Pitch and timbre".
//
// Technique: pitch and formants moved independently. The natural method is
// core/voice.js shiftVoiceBuf: TD-PSOLA (Moulines and Charpentier 1990,
// "Pitch-synchronous waveform processing techniques for text-to-speech
// synthesis using diphones") after a resampling formant move, the "change
// gender" approach of Praat (Boersma and Weenink). The smooth method is the
// phase vocoder with identity phase locking (Laroche and Dolson 1999) and a
// cepstral envelope correction (core/pv.js pvShift), which suits singing,
// music and sound effects that cannot be pitch-marked.
//
// This is the stage render.js adds the Pitch and Timbre macros to, so its
// parameter ids (semitones, formant) are fixed and its defaults do nothing.
// One analysis of the channels' mix drives every channel, so stereo stays put.

import { shiftVoiceBuf } from '../../core/voice.js'
import { analyse, cleanBuf, usable, progress } from './_lib.js'

export default {
  id: 'pitch.voice',
  name: 'Pitch and timbre',
  family: 'pitch',
  about: 'Moves your voice up or down. Timbre makes the person sound bigger or smaller, without changing the note.',
  params: [
    { id: 'semitones', name: 'Pitch', type: 'number', min: -24, max: 24, step: 0.5, def: 0, unit: 'semitones', rand: [-9, 9] },
    { id: 'formant', name: 'Timbre', type: 'number', min: -12, max: 12, step: 0.5, def: 0, unit: 'semitones', rand: [-5, 5] },
    {
      id: 'mode',
      name: 'Method',
      type: 'choice',
      def: 'natural',
      options: [
        { v: 'natural', name: 'Natural, best for speech' },
        { v: 'fast', name: 'Smooth, best for music and sounds' },
      ],
    },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    if (!usable(input)) return input
    cleanBuf(input)
    const semis = Number(p.semitones) || 0
    const formant = Number(p.formant) || 0
    if (semis === 0 && formant === 0) return input
    progress(ctx, 0.05)
    const quality = p.mode === 'fast' ? 'fast' : 'best'
    const opts = { semitones: semis, formant, quality }
    if (quality === 'best') opts.track = analyse(input).track
    const out = shiftVoiceBuf(input, opts)
    progress(ctx, 1)
    return cleanBuf(out)
  },
}
