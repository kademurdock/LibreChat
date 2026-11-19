// modules/pitch/jitter.js - pitch.jitter, "Cracking voice".
//
// Technique: register breaks, tremor and jitter applied cycle by cycle with
// core/voice.js retuneVoiceBuf (TD-PSOLA, Moulines and Charpentier 1990).
// - Cracks: the sudden jump between chest voice and falsetto (or down into a
//   lower register) heard in a breaking adolescent voice, described as a
//   register transition by Titze ("Principles of Voice Production", 1994).
//   Cracks are scheduled as a Poisson process over voiced time only, each
//   one a fast jump (10 ms in, 18 ms out) held 70 to 220 ms, with a third of
//   them flicking back and forth once. An upward crack also lifts the
//   formants a little and drops the level about 2.5 dB, as falsetto does.
// - Tremble: a vocal tremor near 7.5 Hz (the physiological tremor band, 4 to
//   12 Hz) on pitch and level, its depth and rate drifting a little: nervous,
//   cold, scared, very old.
// - Jitter: independent random cycle-to-cycle pitch perturbation, the
//   "jitter" of voice-quality measurement (Lieberman 1963): unsteady, shaky.

import { retuneVoiceBuf } from '../../core/voice.js'
import { analyse, cleanBuf, usable, rngOf, voicedRuns, ControlCurve, smoothRandom, progress } from './_lib.js'

export default {
  id: 'pitch.jitter',
  name: 'Cracking voice',
  family: 'pitch',
  about: 'Your voice cracks, trembles and shakes: a breaking teenage voice, nerves, fear or old age.',
  params: [
    { id: 'rate', name: 'Cracks per second', type: 'number', min: 0, max: 4, step: 0.1, def: 0.8, unit: 'hz', rand: [0.3, 1.5] },
    { id: 'size', name: 'Crack size', type: 'number', min: 1, max: 12, step: 0.5, def: 7, unit: 'semitones', rand: [4, 10] },
    {
      id: 'direction',
      name: 'Crack direction',
      type: 'choice',
      def: 'up',
      options: [
        { v: 'up', name: 'Up into a squeak' },
        { v: 'down', name: 'Down into a croak' },
        { v: 'both', name: 'Either way' },
      ],
    },
    { id: 'tremble', name: 'Tremble', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 60] },
    { id: 'jitter', name: 'Shakiness', type: 'number', min: 0, max: 100, step: 1, def: 15, unit: 'cents', rand: [5, 40] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    if (!usable(input)) return input
    cleanBuf(input)
    const rate = Math.max(0, Number(p.rate) || 0)
    const size = Math.max(0, Number(p.size) || 0)
    const trem = Math.min(1, Math.max(0, (Number(p.tremble) || 0) / 100))
    const jit = Math.max(0, Number(p.jitter) || 0)
    if ((rate === 0 || size === 0) && trem === 0 && jit === 0) return input
    const an = analyse(input)
    const sr = an.sr
    const n = input.ch[0].length
    const secs = n / sr
    const rng = rngOf(ctx, 'crack')
    const CR = 2000
    const crack = new ControlCurve(secs + 0.5, CR)
    // ---- schedule the cracks over voiced time
    if (rate > 0 && size > 0) {
      const runs = voicedRuns(an.track, sr, 0.06)
      const er = rng.fork('events')
      let next = -Math.log(1 - er.next()) / rate // voiced seconds until the next crack
      for (const [a, b] of runs) {
        let t = a + 0.04
        while (t < b - 0.08) {
          const room = b - 0.05 - t
          if (!(room > 0)) break
          if (next > room) {
            next -= room
            break
          }
          t += next
          const dur = 0.07 + 0.15 * er.next()
          const sgn = p.direction === 'down' ? -1 : p.direction === 'both' ? (er.next() < 0.5 ? -1 : 1) : 1
          const amt = sgn * size * (0.75 + 0.4 * er.next())
          const flick = er.next() < 0.33
          const i0 = Math.floor(t * CR)
          const i1 = Math.min(crack.n, Math.ceil((t + dur + 0.02) * CR))
          for (let i = i0; i < i1; i++) {
            const u = i / CR - t
            let e = u < 0.01 ? u / 0.01 : u < dur ? 1 : 1 - (u - dur) / 0.018
            if (flick && u > 0.45 * dur && u < 0.45 * dur + 0.03) e *= 0.15
            if (e > 0) crack.v[i] += amt * (e > 1 ? 1 : e)
          }
          t += dur + 0.12
          next = -Math.log(1 - er.next()) / rate
        }
      }
    }
    // ---- tremor
    const tremRate = smoothRandom(secs + 1, 0.5, rng.fork('trate'), 500)
    const tremDepth = smoothRandom(secs + 1, 0.7, rng.fork('tdepth'), 500)
    const tremor = new ControlCurve(secs + 0.5, CR)
    if (trem > 0) {
      let ph = 0
      for (let i = 0; i < tremor.n; i++) {
        const t = i / CR
        tremor.v[i] = (0.7 + 0.3 * tremDepth.at(t)) * Math.sin(2 * Math.PI * ph)
        ph += (7.5 * (1 + 0.15 * tremRate.at(t))) / CR
        if (ph >= 1) ph -= 1
      }
    }
    progress(ctx, 0.2)
    const jr = rng.fork('jitter')
    const tremCents = 45 * trem
    const jitSemis = jit / 100
    const out = retuneVoiceBuf(input, {
      track: an.track,
      formant: (t) => {
        const c = crack.at(t)
        return c > 0 ? Math.min(1.5, 0.12 * c) : Math.max(-1, 0.08 * c)
      },
      targetFn: (t, f0) => {
        let g = jitSemis > 0 ? jr.gauss() : 0
        if (g > 2.5) g = 2.5
        else if (g < -2.5) g = -2.5
        const semis = crack.at(t) + (tremCents * tremor.at(t)) / 100 + jitSemis * g
        return f0 * Math.pow(2, semis / 12)
      },
    })
    progress(ctx, 0.9)
    // level: falsetto is softer, and the tremor shakes the level too
    const inv = 1 / sr
    const sz = size > 0 ? size : 1
    for (let c = 0; c < out.ch.length; c++) {
      const s = out.ch[c]
      for (let i = 0; i < n; i++) {
        const t = i * inv
        const cf = Math.min(1, Math.abs(crack.at(t)) / sz)
        s[i] *= (1 - 0.25 * cf) * (1 + 0.12 * trem * tremor.at(t))
      }
    }
    progress(ctx, 1)
    return cleanBuf(out)
  },
}
