// modules/pitch/subharmonic.js - pitch.subharmonic, "Growl and fry".
//
// Technique: the irregular voice qualities of voice science, rebuilt on a
// cycle-by-cycle re-pitcher (core/voice.js retuneVoiceBuf, TD-PSOLA,
// Moulines and Charpentier 1990). The vocabulary is Laver's "The Phonetic
// Description of Voice Quality" (1980) and the growl studies of Sakakibara
// et al. ("Growl voice in ethnic and pop styles", 2004):
// - Undertone (period doubling, diplophonia): neighbouring glottal cycles
//   alternate long and short, and an amplitude modulation at half the pitch,
//   phase-continuous along the pitch track, makes alternate cycles alternate
//   loud and soft, which puts energy at f0/2 and its odd multiples; a clean
//   octave-down copy of the result deepens it. This is the demon and the
//   throat-singer's undertone.
// - Roughness: random cycle-to-cycle pitch jitter plus a fast random level
//   flutter (slewed random near 55 Hz, the false-fold flutter of a growl):
//   hoarse, gravelly, zombie.
// - Creak (vocal fry): the pitch is pulled toward the creaky register near
//   55 Hz with large irregular jitter, so the voice breaks into separate
//   crackling pulses (PSOLA spreading the grains apart is exactly the gap
//   between fry pulses).
// - Grit: a level-independent hyperbolic-tangent saturation that hardens the
//   edges of all of the above.

import { retuneVoiceBuf, shiftVoiceBuf } from '../../core/voice.js'
import { analyse, cleanBuf, usable, rngOf, ControlCurve, smoothRandom, progress } from './_lib.js'

const FRY_HZ = 55

export default {
  id: 'pitch.subharmonic',
  name: 'Growl and fry',
  family: 'pitch',
  about: 'Adds a growling undertone, gravel and creak to your voice: demons, zombies, monsters.',
  params: [
    { id: 'sub', name: 'Undertone', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [20, 90] },
    { id: 'rough', name: 'Roughness', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [10, 70] },
    { id: 'fry', name: 'Creak', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 60] },
    { id: 'grit', name: 'Grit', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [0, 50] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 4,
  process(input, p, ctx) {
    if (!usable(input)) return input
    cleanBuf(input)
    const sub = Math.min(1, Math.max(0, (Number(p.sub) || 0) / 100))
    const rough = Math.min(1, Math.max(0, (Number(p.rough) || 0) / 100))
    const fry = Math.min(1, Math.max(0, (Number(p.fry) || 0) / 100))
    const grit = Math.min(1, Math.max(0, (Number(p.grit) || 0) / 100))
    if (sub === 0 && rough === 0 && fry === 0 && grit === 0) return input
    const an = analyse(input)
    const sr = an.sr
    const n = input.ch[0].length
    const secs = n / sr
    const rng = rngOf(ctx, 'growl')
    const lFry = Math.log2(FRY_HZ)
    const pull = 0.9 * fry
    const jitSd = 0.35 * rough + 1.6 * fry // semitones, cycle to cycle
    const alt = 0.07 * sub // alternate cycles plus and minus 7 percent at most
    const jr = rng.fork('jitter')
    let out = input
    progress(ctx, 0.1)
    if (sub > 0 || rough > 0 || fry > 0) {
      let flip = 1
      let lastT = -1
      out = retuneVoiceBuf(input, {
        track: an.track,
        targetFn: (t, f0) => {
          const lf = Math.log2(f0)
          let l = lf + pull * (lFry - lf)
          if (jitSd > 0) {
            let g = jr.gauss()
            if (g > 2.5) g = 2.5
            else if (g < -2.5) g = -2.5
            l += (jitSd * g) / 12
          }
          if (t - lastT > 0.08) flip = 1
          lastT = t
          flip = -flip
          return Math.pow(2, l) * (1 + alt * flip)
        },
      })
    }
    progress(ctx, 0.45)
    // the output pitch (without the jitter) on the track's frames, for the
    // half-pitch modulator, and a smoothed voicing gate so it fades at edges
    const tr = an.track
    const frameRate = sr / tr.hop
    const nf = tr.f0.length
    const hz = new ControlCurve(nf / frameRate + 0.1, frameRate)
    const vg = new ControlCurve(nf / frameRate + 0.1, frameRate)
    {
      let last = 0
      let g = 0
      const a = 1 - Math.exp(-1 / (0.02 * frameRate))
      for (let f = 0; f < hz.n; f++) {
        const f0 = f < nf ? tr.f0[f] : 0
        if (f0 > 0) {
          const lf = Math.log2(f0)
          last = Math.pow(2, lf + pull * (lFry - lf))
        }
        hz.v[f] = last
        g += ((f0 > 0 ? 1 : 0) - g) * a
        vg.v[f] = g
      }
    }
    const flutter = rough > 0 ? smoothRandom(secs + 1, 55, rng.fork('flutter'), 2000) : null
    const amD = 0.6 * sub
    const flD = 0.45 * rough
    let below = null
    if (sub > 0) {
      // a clean octave below the growl, from the growl itself
      below = shiftVoiceBuf(out, { semitones: -12, formant: -1.5 })
    }
    progress(ctx, 0.85)
    const inv = 1 / sr
    const res = []
    for (let c = 0; c < out.ch.length; c++) {
      const s = out.ch[c]
      const o = new Float32Array(n)
      let phi = 0
      for (let i = 0; i < n; i++) {
        const t = i * inv
        let g = 1
        if (amD > 0) {
          const h = hz.at(t)
          phi += (Math.PI * h) * inv
          if (phi > 6.283185307179586) phi -= 6.283185307179586
          g += amD * vg.at(t) * Math.sin(phi)
        }
        if (flutter) g *= 1 + flD * flutter.at(t)
        let y = s[i] * g
        if (below) y += 0.45 * sub * below.ch[c][i]
        o[i] = y
      }
      res.push(o)
    }
    if (grit > 0) {
      let pk = 0
      for (const o of res) for (let i = 0; i < n; i++) if (Math.abs(o[i]) > pk) pk = Math.abs(o[i])
      if (pk > 1e-9) {
        const k = 1 + 4 * grit
        const norm = pk / Math.tanh(k)
        const ip = 1 / pk
        for (const o of res) for (let i = 0; i < n; i++) o[i] = norm * Math.tanh(k * o[i] * ip)
      }
    }
    progress(ctx, 1)
    return cleanBuf({ sr: input.sr, ch: res })
  },
}
