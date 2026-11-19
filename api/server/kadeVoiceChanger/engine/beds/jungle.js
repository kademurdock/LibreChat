// beds/jungle.js - A tropical forest by day.
//
// Layers, each from published descriptions of rainforest soundscapes
// (the "acoustic niche" picture of Krause, "The Great Animal Orchestra",
// 2012: every animal finds its own band and time):
// - tropical birds built with the note engine of forest-birds.js:
//   tremulous falling whistles (tinamou-like), a loud ringing
//   "pee-pee-YO" whistle (piha-like), mellow repeated "cow-cow-cow" notes
//   (trogon-like), a short loud "bock" with a metallic overtone
//   (bellbird-like), quick tumbling songs, and chips;
// - distant whooping calls: far primates' "great call", a run of rising
//   pure notes that speeds up and climbs to a peak, then falls away,
//   heard across the canopy with long reverb;
// - insects (night-crickets.js): accelerating tropical cicadas that wind
//   up into a whistle, steady cicada whines, high trills and a far shimmer
//   of crickets;
// - tree frogs and "tink" frogs, and drips from wet leaves (frogs-pond.js);
// - humid, heavy air with a broad-leaf rustle and a long, dense canopy
//   reverb (SPACES.jungle).

import { makeRng } from '../core/rng.js'
import { resolveParams } from '../core/params.js'
import { makeScene, emit, addAir, finishScene, renderNotes, makeSingers, runSingers, activityCurve, drawPan, drawDist, SPECIES, SPACES } from './forest-birds.js'
import { addCicadas, addTrillers, addCrickets, addKatydids } from './night-crickets.js'
import { addTreeFrogs, addTinks, addDrips } from './frogs-pond.js'

function R(rng, a, b) {
  return a + (b - a) * rng.next()
}

function n(o) {
  return Object.assign({ t: 0, d: 0.2, f0: 2000, f1: 2000, bend: 1, arch: 0, h2: 0.12, h3: 0.03, att: 0.01, rel: 0.03, a: 1 }, o)
}

// Tropical voices in the same shape as forest-birds.js SPECIES.
export const TROPICAL = {
  tremolo: {
    gain: 0.55, dist: 1.6, period: [4, 10], bout: [2, 4], types: 2, send: 0.75,
    type(rng, v) {
      const k = 2 + rng.int(3)
      const notes = []
      let t = 0
      let F = v * R(rng, 1050, 1350)
      for (let i = 0; i < k; i++) {
        const d = R(rng, 0.6, 1.1)
        notes.push(n({ t, d, f0: F, f1: F * 0.86, fmR: R(rng, 6.5, 9), fmD: 0.018, amR: R(rng, 6.5, 9), amD: 0.25, h2: 0.05, att: 0.08, rel: 0.25, swell: 0.4, noise: 0.05 }))
        t += d + R(rng, 0.8, 1.6)
        F *= R(rng, 1.01, 1.06)
      }
      return notes
    },
  },
  ringer: {
    gain: 0.75, dist: 1.4, period: [4, 9], bout: [3, 6], types: 2, send: 0.65,
    type(rng, v) {
      const F = v * R(rng, 2500, 3200)
      return [
        n({ t: 0, d: 0.22, f0: F * 0.9, f1: F * 1.05, arch: 0.08, h2: 0.15, att: 0.02, rel: 0.04 }),
        n({ t: 0.32, d: 0.22, f0: F * 0.9, f1: F * 1.05, arch: 0.08, h2: 0.15, att: 0.02, rel: 0.04 }),
        n({ t: 0.66, d: R(rng, 0.35, 0.45), f0: F * 1.35, f1: F * 0.7, bend: 0.6, arch: 0.1, h2: 0.2, h3: 0.05, att: 0.01, rel: 0.06 }),
      ]
    },
  },
  cooer: {
    gain: 0.5, dist: 1.2, period: [4, 9], bout: [2, 5], types: 2, send: 0.65,
    type(rng, v) {
      const F = v * R(rng, 950, 1300)
      const k = 6 + rng.int(7)
      const notes = []
      let t = 0
      let per = R(rng, 0.2, 0.26)
      for (let i = 0; i < k; i++) {
        notes.push(n({ t, d: 0.1, f0: F * 0.96, f1: F * 0.92, arch: 0.05, h2: 0.3, h3: 0.08, att: 0.012, rel: 0.04, noise: 0.08, a: i < 2 ? 0.7 : 1 }))
        t += per
        per *= 0.985
      }
      return notes
    },
  },
  bocker: {
    gain: 0.85, dist: 1.5, period: [3, 8], bout: [2, 6], types: 1, send: 0.7,
    type(rng, v) {
      const F = v * R(rng, 1600, 2300)
      return [
        n({ t: 0, d: 0.12, f0: F, f1: F * 0.97, h2: 0.6, h3: 0.4, h4: 0.2, att: 0.002, rel: 0.09, swell: 0 }),
        n({ t: 0, d: 0.1, f0: F * 2.31, f1: F * 2.28, h2: 0.1, att: 0.002, rel: 0.08, a: 0.35 }),
      ]
    },
  },
}

/** Far whooping great calls. o: { dist, rate (per minute), gain, send }. */
export function addWhoops(sc, rng, o = {}) {
  const sr = sc.sr
  const rate = Math.max(0, Number(o.rate ?? 2)) / 60
  if (!(rate > 0)) return
  const r = rng.fork('whoops')
  const pan = drawPan(r, 0.8)
  let t = R(r, 1, 6)
  while (t < sc.dur) {
    const k = 8 + r.int(9)
    const notes = []
    let tt = 0
    let per = R(r, 0.65, 0.85)
    let F = R(r, 520, 680)
    const peak = Math.floor(k * R(r, 0.6, 0.8))
    for (let i = 0; i < k; i++) {
      const d = Math.max(0.16, per * 0.75)
      const up = i <= peak
      notes.push(n({ t: tt, d, f0: F, f1: F * (up ? R(r, 1.35, 1.6) : 0.8), bend: up ? 1.4 : 0.8, arch: 0.05, h2: 0.12, h3: 0.03, att: 0.03, rel: 0.06, noise: 0.06, a: up ? 0.6 + 0.4 * (i / peak) : 0.8 }))
      tt += per
      if (up) {
        per = Math.max(0.24, per * 0.9)
        F *= 1.04
      } else F *= 0.95
    }
    const ev = renderNotes(notes, sr, r, 0.05)
    emit(sc, ev, t * sr, pan, drawDist(r, Number(o.dist ?? 250), 0.25, 80, 1500), Number(o.gain ?? 1), Number(o.send ?? 0.8))
    t += ev.length / sr - Math.log(1 - r.next()) / rate
  }
}

/** Singers drawn from the tropical voices plus the forest ones (same runner as the forest). */
export function tropicalSingers(names, rng, opts = {}) {
  return makeSingers(names, rng, Object.assign({}, opts, { species: Object.assign({}, SPECIES, TROPICAL) }))
}

// ---------------------------------------------------------------- the bed

const bed = {
  id: 'jungle',
  name: 'Jungle by day',
  group: 'nature',
  about: 'A steamy rainforest by day: strange bird calls, whooping far off, winding cicadas, frogs and drips.',
  params: [
    { id: 'intensity', name: 'Wildlife', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent' },
    { id: 'birds', name: 'Birds', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent' },
    { id: 'insects', name: 'Insects', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent' },
    { id: 'calls', name: 'Distant whooping calls', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent' },
    { id: 'drips', name: 'Dripping leaves', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent' },
    { id: 'distance', name: 'Distance to the animals', type: 'number', min: 5, max: 100, step: 1, def: 25, unit: 'meters' },
  ],
  generate(seconds, sr, p, rng) {
    const q = resolveParams(bed, p || {})
    const r = rng || makeRng('jungle')
    const sc = makeScene(seconds, sr, r)
    if (!sc.n) return { sr: sc.sr, ch: [sc.L, sc.R] }
    const I = q.intensity / 100
    const d = q.distance
    addAir(sc, { hushDb: -56, wind: 0.08, gust: 0.4, body: 320, foliage: 0.5, foliageHz: 2600, rustle: 0.3, rumble: 0.18 }, r.fork('air'))
    const B = (q.birds / 100) * (0.3 + 0.7 * I)
    if (B > 0) {
      const pool = ['tremolo', 'ringer', 'cooer', 'bocker', 'tumbler', 'ringer', 'cooer', 'bocker', 'tremolo', 'carol']
      const list = pool.slice(0, Math.max(1, Math.round(1 + B * 9)))
      const singers = tropicalSingers(list, r.fork('cast'), { dist: d, sendMul: 1 })
      runSingers(sc, singers, r.fork('songs'), { rate: 0.6 + 0.7 * B, activity: activityCurve(sc, r.fork('act'), 0.4) })
    }
    const S = (q.insects / 100) * (0.3 + 0.7 * I)
    if (S > 0) {
      addCicadas(sc, r.fork('risers'), { count: 0.5 + S * 1.5, dist: d * 1.6, kind: 'rise', gain: 0.8, send: 0.6 })
      addCicadas(sc, r.fork('whiners'), { count: 0.4 + S, dist: d * 2, gain: 0.6, send: 0.6 })
      addTrillers(sc, r.fork('trill'), { count: 1 + Math.round(S * 3), dist: d, gain: 0.18, send: 0.5 })
      addCrickets(sc, r.fork('shimmer'), { count: Math.round(S * 10), dist: d * 2, warmth: 0.9, kind: 'field', pitch: 1.3, gain: 0.18, send: 0.6 })
      addKatydids(sc, r.fork('katy'), { count: Math.round(S * 2), dist: d * 1.5, gain: 0.35, send: 0.6 })
    }
    if (I > 0) {
      addTreeFrogs(sc, r.fork('treefrogs'), { count: Math.round(I * 3), dist: d, gain: 0.35, send: 0.6 })
      addTinks(sc, r.fork('tinks'), { count: Math.round(I * 4), dist: d * 0.8, gain: 0.3, send: 0.6 })
    }
    const C = q.calls / 100
    if (C > 0) addWhoops(sc, r.fork('whoops'), { dist: 200 + 6 * d, rate: 1 + 4 * C, gain: 3 * Math.sqrt(C), send: 0.85 })
    const D = q.drips / 100
    if (D > 0) addDrips(sc, r.fork('drips'), { rate: 0.3 + 3 * D, dist: 5, gain: 0.35, send: 0.45 })
    return finishScene(sc, SPACES.jungle, r.fork('space'), -12)
  },
}

export default bed
