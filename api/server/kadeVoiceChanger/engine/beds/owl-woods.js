// beds/owl-woods.js - Owls calling in dark woods.
//
// Owl hoots are low, soft, breathy and nearly pure, which is exactly what
// the bird note engine in forest-birds.js does well (a sine sweep with small
// overtones and a breath band around the pitch). Four kinds of caller, each
// built from published descriptions of their rhythm and pitch:
// - a deep hooting pair: a five-note "hoo, hoo-hoo, hoo, hoo" from the lower
//   voiced bird, answered by the higher one with a longer phrase (pairs
//   duet like this through the night);
// - eight-note callers: "who cooks for you, who cooks for you all", fuller
//   and more vocal, the last note sliding down with a tremble;
// - small owls: a falling, quavering whinny and a long even trill;
// - tooters: a patient run of single high "too" notes about twice a second.
// Callers answer one another across the wood; the night has a few insects,
// a slow wind in the trees and the forest's soft reverb.

import { makeRng } from '../core/rng.js'
import { resolveParams } from '../core/params.js'
import { makeScene, emit, addAir, finishScene, renderNotes, drawPan, drawDist, SPACES } from './forest-birds.js'
import { addCrickets } from './night-crickets.js'

function R(rng, a, b) {
  return a + (b - a) * rng.next()
}

function hoot(t, d, F, o = {}) {
  return Object.assign({ t, d, f0: F * 0.94, f1: F * 0.97, arch: 0.04, bend: 0.5, h2: 0.12, h3: 0.03, att: 0.04, rel: 0.09, swell: 0.5, noise: 0.25, a: 1 }, o)
}

// One phrase for a caller kind; F is the caller's pitch.
function phrase(kind, rng, F, female) {
  const notes = []
  if (kind === 'deep') {
    if (!female) {
      const ds = [0.36, 0.15, 0.15, 0.45, 0.45]
      const gs = [0.28, 0.05, 0.32, 0.3]
      let t = 0
      for (let i = 0; i < ds.length; i++) {
        notes.push(hoot(t, ds[i] * R(rng, 0.92, 1.08), F * (i === 1 ? 1.03 : 1)))
        t += ds[i] + (gs[i] || 0)
      }
    } else {
      let t = 0
      const k = 6 + rng.int(3)
      for (let i = 0; i < k; i++) {
        const d = i < 3 ? 0.14 : 0.3
        notes.push(hoot(t, d * R(rng, 0.9, 1.1), F * (i < 3 ? 1.04 : 1)))
        t += d + (i < 3 ? 0.04 : 0.22)
      }
    }
  } else if (kind === 'eight') {
    const v = { h2: 0.35, h3: 0.15, noise: 0.18, att: 0.03, rel: 0.06 }
    let t = 0
    const part = (last) => {
      notes.push(hoot(t, 0.2, F, v))
      t += 0.24
      notes.push(hoot(t, 0.15, F * 1.06, v))
      t += 0.18
      notes.push(hoot(t, 0.12, F, v))
      t += 0.15
      if (last) {
        notes.push(hoot(t, 0.32, F * 1.08, Object.assign({}, v, { f0: F * 1.12, f1: F * 0.9, bend: 1.6 })))
        t += 0.42
        notes.push(hoot(t, R(rng, 0.8, 1.1), F * 1.1, Object.assign({}, v, { f0: F * 1.18, f1: F * 0.7, bend: 1.8, fmR: R(rng, 5, 7), fmD: 0.03 })))
      } else {
        notes.push(hoot(t, 0.38, F * 1.1, Object.assign({}, v, { f0: F * 1.14, f1: F * 0.86, bend: 1.5 })))
        t += 0.38 + R(rng, 0.45, 0.7)
      }
    }
    part(false)
    part(true)
  } else if (kind === 'whinny') {
    if (rng.next() < 0.55) {
      notes.push({ t: 0, d: R(rng, 1, 1.5), f0: F * 1.25, f1: F * 0.85, bend: 0.8, fmR: R(rng, 11, 16), fmD: 0.035, amR: R(rng, 11, 16), amD: 0.5, h2: 0.08, att: 0.05, rel: 0.25, noise: 0.08, a: 1 })
    } else {
      notes.push({ t: 0, d: R(rng, 1.8, 3), f0: F, f1: F * 0.97, amR: R(rng, 13, 18), amD: 0.9, h2: 0.06, att: 0.25, rel: 0.2, noise: 0.06, a: 0.9 })
    }
  } else {
    // tooter: a run of single notes
    const k = 8 + rng.int(20)
    const per = R(rng, 0.42, 0.52)
    for (let i = 0; i < k; i++) {
      notes.push({ t: i * per * R(rng, 0.97, 1.03), d: R(rng, 0.07, 0.09), f0: F * 1.02, f1: F * 0.99, h2: 0.05, att: 0.012, rel: 0.03, noise: 0.05, a: 0.9 + 0.1 * rng.next() })
    }
  }
  return notes
}

const PITCH = { deep: [255, 300], eight: [370, 450], whinny: [620, 760], toot: [1080, 1260] }

/**
 * Owls calling. o: { kinds: ['deep', 'eight', 'whinny', 'toot'], dist,
 * busy 0..1, gain, send }.
 */
export function addOwls(sc, rng, o = {}) {
  const sr = sc.sr
  const busy = Math.max(0, Number(o.busy ?? 0.5))
  if (!(busy > 0)) return
  const kinds = o.kinds || ['deep']
  const callers = []
  kinds.forEach((kind, i) => {
    const r = rng.fork('owl' + i + kind)
    const pr = PITCH[kind] || PITCH.deep
    const F = R(r, pr[0], pr[1])
    const twoOf = kind === 'deep' || kind === 'eight'
    callers.push({ kind, r, F, female: false, pan: drawPan(r, 0.85), dist: drawDist(r, Number(o.dist ?? 50), 0.35, 8, 500) })
    if (twoOf) {
      const r2 = rng.fork('mate' + i + kind)
      callers.push({ kind, r: r2, F: F * (kind === 'deep' ? R(r2, 1.18, 1.3) : R(r2, 1.08, 1.15)), female: true, pan: drawPan(r2, 0.85), dist: drawDist(r2, Number(o.dist ?? 50) * 1.3, 0.35, 8, 600) })
    }
  })
  // the wood takes turns: one caller, then often an answer
  const tr = rng.fork('turns')
  let t = R(tr, 0.3, 2)
  let last = -1
  let guard = 0
  while (t < sc.dur && guard++ < 500) {
    let ci = tr.int(callers.length)
    // answer: the mate of the last caller, if there is one
    if (last >= 0 && tr.next() < 0.6) {
      const lc = callers[last]
      const mate = callers.findIndex((c, i) => i !== last && c.kind === lc.kind)
      if (mate >= 0) ci = mate
    }
    const c = callers[ci]
    const notes = phrase(c.kind, c.r, c.F * R(c.r, 0.98, 1.02), c.female)
    const ev = renderNotes(notes, sr, c.r, 0.05)
    emit(sc, ev, t * sr, c.pan, c.dist, Number(o.gain ?? 1) * (c.kind === 'toot' ? 0.5 : 1), Number(o.send ?? 0.6))
    last = ci
    t += ev.length / sr + R(tr, 0.8, 4.5) / (0.3 + busy)
  }
}

// ---------------------------------------------------------------- the bed

const MIX = { mixed: ['deep', 'eight', 'whinny'], deep: ['deep'], eight: ['eight'], small: ['whinny', 'toot'] }

const bed = {
  id: 'owl-woods',
  name: 'Owls in the woods',
  group: 'nature',
  about: 'Dark woods at night: owls hooting and answering, a slow wind in the trees, a few insects.',
  params: [
    { id: 'intensity', name: 'Owls calling', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent' },
    { id: 'distance', name: 'Distance to the owls', type: 'number', min: 10, max: 200, step: 5, def: 45, unit: 'meters' },
    { id: 'owls', name: 'Owls', type: 'choice', def: 'mixed', options: [{ v: 'mixed', name: 'Mixed owls' }, { v: 'deep', name: 'Deep hooting pair' }, { v: 'eight', name: 'Eight-note callers' }, { v: 'small', name: 'Small owls trilling and tooting' }] },
    { id: 'wind', name: 'Wind in the trees', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent' },
    { id: 'insects', name: 'Night insects', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent' },
  ],
  generate(seconds, sr, p, rng) {
    const q = resolveParams(bed, p || {})
    const r = rng || makeRng('owl-woods')
    const sc = makeScene(seconds, sr, r)
    if (!sc.n) return { sr: sc.sr, ch: [sc.L, sc.R] }
    const I = q.intensity / 100
    addAir(sc, { hushDb: -60, wind: 0.05 + 0.85 * (q.wind / 100), gust: 0.6, body: 400, foliage: 0.7, foliageHz: 4800, rustle: 0.25, rumble: 0.12, gustPeriod: 10 }, r.fork('air'))
    if (I > 0) addOwls(sc, r.fork('owls'), { kinds: MIX[q.owls] || MIX.mixed, dist: q.distance, busy: I, gain: 2.2, send: 0.6 })
    const ins = q.insects / 100
    if (ins > 0) addCrickets(sc, r.fork('crickets'), { count: Math.round(ins * 12), dist: 10, warmth: 0.3, kind: 'mixed', gain: 0.25, send: 0.45 })
    return finishScene(sc, SPACES.night, r.fork('space'), -8.5)
  },
}

export default bed
