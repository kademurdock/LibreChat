// modules/time/reverse.js - time.reverse, "Backwards": the whole clip played
// last sound first.
//
// Technique: plain time reversal, y[i] = x[n - 1 - i], the oldest tape trick
// there is (turning the reel over; see any history of tape music, for
// example Thom Holmes, "Electronic and Experimental Music", on the tape
// techniques of musique concrete).
// Two small additions: a raised-cosine fade at both ends (a recording that
// was cut off mid-word would otherwise start with a click once reversed),
// and an optional layer of the untouched forward voice underneath, the
// "both ways at once" sound used for haunted messages.
//
// The family's shared splicing tools live in _lib.js.

import { fade } from '../../core/buf.js'
import { prepare } from './_lib.js'

export default {
  id: 'time.reverse',
  name: 'Backwards',
  family: 'time',
  about: 'Plays the whole clip backwards, last sound first. Add some of the forward voice underneath for a haunted message.',
  params: [
    { id: 'forward', name: 'Forward voice underneath', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 35] },
    { id: 'smooth', name: 'Edge smoothing', type: 'number', min: 0, max: 50, step: 1, def: 3, unit: 'ms', rand: [2, 10] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: true,
  cost: 1,
  process(input, p, ctx) {
    const n = prepare(input)
    if (!n) return input
    const fwd = Math.max(0, Math.min(1, (Number(p.forward) || 0) / 100))
    const ch = new Array(input.ch.length)
    for (let c = 0; c < input.ch.length; c++) {
      const x = input.ch[c]
      const y = new Float32Array(n)
      for (let i = 0, j = n - 1; i < n; i++, j--) y[i] = x[j]
      if (fwd > 0) for (let i = 0; i < n; i++) y[i] += fwd * x[i]
      ch[c] = y
    }
    const out = { sr: input.sr, ch }
    const s = Math.max(0, Number(p.smooth) || 0) / 1000
    if (s > 0) fade(out, Math.min(s, n / input.sr / 2), Math.min(s, n / input.sr / 2))
    if (ctx && typeof ctx.progress === 'function') ctx.progress(1)
    return out
  },
}
