// modules/lofi/speaker.js - lofi.speaker, "Small speaker".
//
// Technique: a lumped-element loudspeaker model after Thiele and Small
// (A. N. Thiele 1961; R. H. Small, "Closed-box loudspeaker systems", JAES
// 1972): a second-order high pass at the driver's resonance with its total Q
// (the bump and the 12 dB per octave fall below it), cone break-up peaks and
// a voice-coil low pass on top, a soft-clipped cone excursion whose overload
// is fed back in as midrange growl, an optional cheap-amplifier clipper, and
// a rattle of loose parts past an excursion threshold. The numbers for each
// size live in _speakers.js. The same streaming kernel runs offline and live.

import { SpeakerKernel, SPEAKER_OPTIONS } from './_speakers.js'
import { runStream } from './_lib.js'

export default {
  id: 'lofi.speaker',
  name: 'Small speaker',
  family: 'lofi',
  about: 'Plays your voice through a tiny speaker: an earbud, a phone, a laptop, a toy, a pocket radio, an old TV, a horn or a megaphone.',
  params: [
    { id: 'size', name: 'Speaker', type: 'choice', def: 'phone', options: SPEAKER_OPTIONS },
    { id: 'push', name: 'Volume push', type: 'number', min: 0, max: 30, step: 0.5, def: 6, unit: 'db', rand: [0, 18] },
    { id: 'rattle', name: 'Rattle', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [0, 60] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 1,
  process(input, p, ctx) {
    const k = new SpeakerKernel(input.sr, p, ctx && ctx.rng ? ctx.rng.fork('speaker') : null)
    return runStream(k, input, 0, 0, ctx)
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p, rng) {
      return new SpeakerKernel(sr, p, rng ? rng.fork('speaker') : null)
    },
  },
}
