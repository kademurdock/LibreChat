// beds/meadow-dawn.js - An open meadow at first light.
//
// The dawn chorus in open country: a skylark pouring out its endless song
// high overhead (a continuous stream of quick, varied syllables from a large
// personal repertoire, with short repeats, drifting slowly across the sky),
// sweet slurred whistles from the grass, the accelerating "bouncing ball"
// song, a sparrow's notes-buzz-trill, far doves, and the last few crickets of
// the night. Birdsong comes from the note engine in forest-birds.js; the
// lark's stream is built here. The chorus can build up over the first
// minute, the way dawn fills in. The air is calm with a light breeze in the
// grass and almost no reverb: an open field gives only the ground and a far
// tree line (SPACES.meadow).

import { makeRng } from '../core/rng.js'
import { resolveParams } from '../core/params.js'
import { makeScene, emitPath, addAir, finishScene, renderNotes, makeSingers, runSingers, SPACES, clamp } from './forest-birds.js'
import { addCrickets } from './night-crickets.js'

function R(rng, a, b) {
  return a + (b - a) * rng.next()
}

/** The skylark's continuous song, dur seconds. Returns a list of notes. */
export function larkNotes(rng, dur, v = 1) {
  const reps = []
  const nr = 18 + rng.int(14)
  for (let k = 0; k < nr; k++) {
    const kind = rng.int(5)
    const F = v * R(rng, 2600, 6800)
    if (kind === 0) reps.push([{ d: R(rng, 0.03, 0.07), f0: F * 1.2, f1: F * 0.8, h2: 0.2 }])
    else if (kind === 1) reps.push([{ d: R(rng, 0.04, 0.09), f0: F * 0.85, f1: F * 1.2, arch: 0.15, h2: 0.25 }])
    else if (kind === 2) {
      const n = 3 + rng.int(6)
      const d = R(rng, 0.018, 0.03)
      const s = []
      for (let i = 0; i < n; i++) s.push({ t: i * (d + 0.012), d, f0: F * 1.1, f1: F * 0.9, h2: 0.15 })
      reps.push(s)
    } else if (kind === 3) reps.push([{ d: R(rng, 0.08, 0.16), f0: F, f1: F * R(rng, 0.9, 1.1), fmR: R(rng, 30, 60), fmD: R(rng, 0.04, 0.1), h2: 0.15 }])
    else reps.push([{ d: R(rng, 0.05, 0.1), f0: F * 0.9, f1: F * 0.95, arch: -0.12, h2: 0.3, h3: 0.08 }])
  }
  const notes = []
  let t = 0
  while (t < dur) {
    const s = reps[rng.int(reps.length)]
    const times = rng.next() < 0.3 ? 2 + rng.int(3) : 1
    for (let k = 0; k < times && t < dur; k++) {
      let end = 0
      for (const nt of s) {
        const st = t + (nt.t || 0)
        notes.push(Object.assign({ att: 0.004, rel: 0.012, a: 0.75 + 0.25 * rng.next(), h3: 0.04 }, nt, { t: st }))
        end = Math.max(end, (nt.t || 0) + nt.d)
      }
      t += end + R(rng, 0.008, 0.04)
    }
    if (rng.next() < 0.06) t += R(rng, 0.1, 0.4)
  }
  return notes
}

/** A skylark singing overhead, drifting across the sky. o: { dist, gain, send }. */
export function addLark(sc, rng, o = {}) {
  const sr = sc.sr
  const r = rng.fork('lark')
  const v = 1 + 0.05 * r.gauss()
  let t = R(r, -10, 0.5)
  while (t < sc.dur) {
    const dur = R(r, 15, 45)
    const ev = renderNotes(larkNotes(r, dur, v), sr, r)
    const p0 = R(r, -0.7, 0.7)
    const per = R(r, 14, 30)
    const ph = r.next() * 6.28
    const d0 = Number(o.dist ?? 60)
    emitPath(sc, ev, t * sr, (x, out) => {
      out.pan = clamp(p0 + 0.35 * Math.sin((6.2832 * x) / per + ph), -0.95, 0.95)
      out.dist = d0 * (1 + 0.25 * Math.sin((6.2832 * x) / (per * 1.7) + ph * 2))
    }, Number(o.gain ?? 0.5), Number(o.send ?? 0.35))
    t += dur + R(r, 4, 20)
  }
}

// ---------------------------------------------------------------- the bed

const bed = {
  id: 'meadow-dawn',
  name: 'Meadow at dawn',
  group: 'nature',
  about: 'First light in an open meadow: a skylark high above, sweet whistles in the grass, doves far off.',
  params: [
    { id: 'intensity', name: 'Dawn chorus', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent' },
    { id: 'distance', name: 'Distance to the birds', type: 'number', min: 5, max: 100, step: 1, def: 28, unit: 'meters' },
    { id: 'lark', name: 'Skylark overhead', type: 'bool', def: true },
    { id: 'doves', name: 'Far doves', type: 'bool', def: true },
    { id: 'build', name: 'Chorus builds up', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent' },
    { id: 'breeze', name: 'Breeze in the grass', type: 'number', min: 0, max: 100, step: 1, def: 15, unit: 'percent' },
  ],
  generate(seconds, sr, p, rng) {
    const q = resolveParams(bed, p || {})
    const r = rng || makeRng('meadow-dawn')
    const sc = makeScene(seconds, sr, r)
    if (!sc.n) return { sr: sc.sr, ch: [sc.L, sc.R] }
    const I = q.intensity / 100
    const build = q.build / 100
    addAir(sc, { hushDb: -62, wind: 0.04 + 0.7 * (q.breeze / 100), gust: 0.5, body: 380, foliage: 0.7, foliageHz: 6000, rustle: 0.06, rumble: 0.06 }, r.fork('air'))
    if (I > 0) {
      const pool = ['slurs', 'bouncer', 'sparrowSong', 'carol', 'slurs', 'bouncer', 'whistler', 'sparrowSong', 'carol']
      const list = pool.slice(0, Math.max(1, Math.round(1 + I * 8)))
      if (q.doves) list.push('dove', 'dove')
      const singers = makeSingers(list, r.fork('cast'), { dist: q.distance, sendMul: 0.8 })
      const ramp = Math.min(sc.dur, 60)
      runSingers(sc, singers, r.fork('songs'), {
        rate: 0.55 + 0.8 * I,
        activity: (t) => clamp(1 - build * 0.7 * (1 - Math.min(1, t / ramp)), 0.2, 1.6),
      })
      if (q.lark) addLark(sc, r.fork('lark'), { dist: Math.max(35, q.distance * 2), gain: 1.3, send: 0.3 })
      addCrickets(sc, r.fork('crickets'), { count: 2 + Math.round(3 * (1 - I)), dist: 8, warmth: 0.15, kind: 'field', gain: 0.12, send: 0.3 })
    }
    return finishScene(sc, SPACES.meadow, r.fork('space'), -9.5)
  },
}

export default bed
