// beds/rainforest-night.js - A tropical rainforest after dark.
//
// The night shift of the rainforest is a dense wall of small voices, each in
// its own band (Krause's "acoustic niche" idea): high insect trills and
// cricket shimmer up top, raspy katydids, two-note tree frogs ("ko-KEE",
// a short low whistle and a longer rising high one), tiny "tink" frogs,
// short tree-frog trills, water dripping from the leaves, and now and then a
// lonely night bird's slow falling whistles (potoo-like), far off in the
// canopy. Frogs and drips come from frogs-pond.js, insects from
// night-crickets.js, the night bird from the note engine in forest-birds.js;
// the space is the long, damp canopy reverb (SPACES.jungle).

import { makeRng } from '../core/rng.js'
import { resolveParams } from '../core/params.js'
import { makeScene, emit, addAir, finishScene, renderNote, renderNotes, drawPan, drawDist, SPACES } from './forest-birds.js'
import { addCrickets, addTrillers, addKatydids, addCicadas } from './night-crickets.js'
import { addTinks, addTreeFrogs, addDrips } from './frogs-pond.js'

function R(rng, a, b) {
  return a + (b - a) * rng.next()
}

/** Two-note tree frogs: o { count, dist, gain, send }. */
export function addTwoNoteFrogs(sc, rng, o = {}) {
  const sr = sc.sr
  const count = Math.max(0, Math.round(Number(o.count ?? 8)))
  const nt = { t: 0, d: 0.1, f0: 1200, f1: 1200, h2: 0.08, h3: 0.02, att: 0.008, rel: 0.02, a: 1 }
  for (let c = 0; c < count; c++) {
    const r = rng.fork('kokee' + c)
    const lo = R(r, 1050, 1350)
    const hi = lo * R(r, 1.6, 1.85)
    const pan = drawPan(r)
    const dist = drawDist(r, Number(o.dist ?? 10) * (c < 2 ? 1 : 1.5 + c * 0.2), 0.4, 1, 300)
    const per = R(r, 1.2, 2.8)
    let t = R(r, -1, 2)
    while (t < sc.dur) {
      const len = Math.ceil(0.45 * sr)
      const ev = new Float32Array(len)
      const both = r.next() < 0.8
      let st = 0
      if (both) {
        nt.t = 0; nt.d = R(r, 0.08, 0.11); nt.f0 = lo; nt.f1 = lo * 0.99; nt.att = 0.008; nt.rel = 0.02; nt.a = 0.8
        renderNote(ev, sr, nt, r)
        st = nt.d + R(r, 0.03, 0.05)
      }
      nt.t = st; nt.d = R(r, 0.15, 0.24); nt.f0 = hi * 0.97; nt.f1 = hi * 1.03; nt.att = 0.012; nt.rel = 0.04; nt.a = 1
      renderNote(ev, sr, nt, r)
      emit(sc, ev, t * sr, pan, dist, Number(o.gain ?? 0.5), Number(o.send ?? 0.6))
      t += per * (1 + 0.15 * r.gauss())
      if (r.next() < 0.04) t += R(r, 2, 8)
    }
  }
}

/** A night bird's slow, falling whistles, far off. o: { dist, gain, send }. */
export function addNightBird(sc, rng, o = {}) {
  const sr = sc.sr
  const r = rng.fork('nightbird')
  const pan = drawPan(r, 0.8)
  const dist = drawDist(r, Number(o.dist ?? 60), 0.3, 20, 400)
  let t = R(r, 1, 6)
  while (t < sc.dur) {
    const k = 4 + r.int(4)
    const notes = []
    let tt = 0
    let F = R(r, 800, 1000)
    for (let i = 0; i < k; i++) {
      const d = R(r, 0.6, 1.0) * (i === 0 ? 1.2 : 1)
      notes.push({ t: tt, d, f0: F * 1.02, f1: F * 0.94, bend: 1.3, fmR: R(r, 4, 6), fmD: 0.008, h2: 0.1, h3: 0.02, att: 0.06, rel: 0.2, swell: 0.5, noise: 0.08, a: 1 - 0.07 * i })
      tt += d + R(r, 0.35, 0.7)
      F *= R(r, 0.9, 0.95)
    }
    const ev = renderNotes(notes, sr, r, 0.05)
    emit(sc, ev, t * sr, pan, dist, Number(o.gain ?? 1), Number(o.send ?? 0.8))
    t += ev.length / sr + R(r, 10, 25)
  }
}

// ---------------------------------------------------------------- the bed

const bed = {
  id: 'rainforest-night',
  name: 'Rainforest at night',
  group: 'nature',
  about: 'A tropical rainforest after dark: a wall of insects, two-note tree frogs, drips, a lonely night bird.',
  params: [
    { id: 'intensity', name: 'Night chorus', type: 'number', min: 0, max: 100, step: 1, def: 65, unit: 'percent' },
    { id: 'frogs', name: 'Tree frogs', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent' },
    { id: 'insects', name: 'Insects', type: 'number', min: 0, max: 100, step: 1, def: 65, unit: 'percent' },
    { id: 'nightBird', name: 'Night bird', type: 'bool', def: true },
    { id: 'drips', name: 'Dripping leaves', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent' },
    { id: 'distance', name: 'Distance to the frogs', type: 'number', min: 2, max: 60, step: 1, def: 12, unit: 'meters' },
  ],
  generate(seconds, sr, p, rng) {
    const q = resolveParams(bed, p || {})
    const r = rng || makeRng('rainforest-night')
    const sc = makeScene(seconds, sr, r)
    if (!sc.n) return { sr: sc.sr, ch: [sc.L, sc.R] }
    const I = q.intensity / 100
    const d = q.distance
    addAir(sc, { hushDb: -58, wind: 0.04, gust: 0.35, body: 300, foliage: 0.3, foliageHz: 2600, rustle: 0.12, rumble: 0.15 }, r.fork('air'))
    const S = (q.insects / 100) * (0.3 + 0.7 * I)
    if (S > 0) {
      addCrickets(sc, r.fork('crickets'), { count: Math.round(S * 22), dist: d, warmth: 0.85, kind: 'mixed', pitch: 1.25, gain: 0.3, send: 0.6 })
      addTrillers(sc, r.fork('trill'), { count: 2 + Math.round(S * 5), dist: d * 1.5, gain: 0.16, send: 0.55 })
      addKatydids(sc, r.fork('katy'), { count: 1 + Math.round(S * 5), dist: d * 2, gain: 0.4, send: 0.6 })
      addCicadas(sc, r.fork('cicada'), { count: 0.3 + 0.5 * S, dist: d * 3, gain: 0.45, send: 0.6 })
    }
    const F = (q.frogs / 100) * (0.3 + 0.7 * I)
    if (F > 0) {
      addTwoNoteFrogs(sc, r.fork('kokee'), { count: 2 + Math.round(F * 14), dist: d, gain: 0.45, send: 0.6 })
      addTinks(sc, r.fork('tinks'), { count: 2 + Math.round(F * 10), dist: d, gain: 0.3, send: 0.6 })
      addTreeFrogs(sc, r.fork('treefrogs'), { count: Math.round(F * 4), dist: d * 1.3, gain: 0.35, send: 0.6 })
    }
    if (q.nightBird && I > 0) addNightBird(sc, r.fork('bird'), { dist: 70, gain: 2, send: 0.8 })
    const D = q.drips / 100
    if (D > 0) addDrips(sc, r.fork('drips'), { rate: 0.3 + 3 * D, dist: 4, gain: 0.35, send: 0.45 })
    return finishScene(sc, SPACES.jungle, r.fork('space'), -14.5)
  },
}

export default bed
