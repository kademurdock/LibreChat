// modules/tone/loudness.js - tone.loudness, set the take to a loudness target.
//
// Technique: integrated loudness by ITU-R BS.1770-4 with EBU R 128 gating
// (core/loudness.js lufs), one gain to the target, then a lookahead
// brick-wall limiter at the chosen peak ceiling (core/dyn.js limitBuf, with
// inter-sample peaks checked by 4x oversampling). Limiting a loud target
// takes a little loudness away, so the gain is measured and corrected and
// the limiter runs again, up to four more rounds. Common targets: -16 for podcasts and
// spoken word on phones, -14 for streaming music, -23 for broadcast, -19
// for quieter voiceover.
//
// Offline only: loudness is a measure of the whole take.

import { bufLen } from '../../core/buf.js'
import { lufs } from '../../core/loudness.js'
import { limitBuf } from '../../core/dyn.js'

function scale(b, db) {
  if (!(db === db) || db === 0) return
  const g = Math.pow(10, db / 20)
  for (let c = 0; c < b.ch.length; c++) {
    const a = b.ch[c]
    for (let i = 0; i < a.length; i++) a[i] *= g
  }
}

export default {
  id: 'tone.loudness',
  name: 'Loudness',
  family: 'tone',
  about: 'Sets the whole take to a loudness target, like minus 16 for podcasts, and keeps the peaks under a ceiling.',
  params: [
    { id: 'target', name: 'Target loudness', type: 'number', min: -36, max: -6, step: 0.5, def: -16, unit: 'db' },
    { id: 'ceiling', name: 'Peak ceiling', type: 'number', min: -9, max: 0, step: 0.1, def: -1, unit: 'db' },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 1,
  surprise: false,
  process(input, p) {
    const n = bufLen(input)
    if (!n) return input
    const target = +p.target
    const L0 = lufs(input)
    if (!(L0 > -70)) return input
    let gain = target - L0
    if (gain > 40) gain = 40
    scale(input, gain)
    const lim = { ceilingDb: +p.ceiling, lookaheadMs: 3, releaseMs: 80, truePeak: true }
    limitBuf(input, lim)
    // limiting a loud target takes some loudness away: measure and correct
    // again (a loud target against a low ceiling may need a few rounds)
    for (let round = 0; round < 4; round++) {
      const L1 = lufs(input)
      if (!(L1 > -70)) break
      let fix = target - L1
      if (fix > 6) fix = 6
      if (fix < 0.1 && fix > -0.1) break
      scale(input, fix)
      limitBuf(input, lim)
    }
    return input
  },
}
