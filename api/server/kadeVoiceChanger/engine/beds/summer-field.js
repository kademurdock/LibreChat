// beds/summer-field.js - A hot summer field at midday.
//
// Midsummer in the open: cicadas swelling and fading in the tree line (a
// tymbal click train ringing a body resonance, with the falling whine at the
// end; night-crickets.js), grasshoppers rasping in the grass, bees and the
// odd bumblebee flying past with their doppler swoop (beehive.js), a few
// daytime crickets, and now and then a far bird: the accelerating "bouncing
// ball" and sweet slurred whistles (forest-birds.js). The breeze moves the
// tall grass in slow waves; the space is open with only a faint tree-line
// reflection (SPACES.field).

import { makeRng } from '../core/rng.js'
import { resolveParams } from '../core/params.js'
import { makeScene, addAir, finishScene, makeSingers, runSingers, SPACES } from './forest-birds.js'
import { addCicadas, addGrasshoppers, addCrickets } from './night-crickets.js'
import { addFlyBys } from './beehive.js'

const bed = {
  id: 'summer-field',
  name: 'Summer field',
  group: 'nature',
  about: 'A hot summer field: cicadas swelling in the trees, grasshoppers, bees buzzing past, a warm breeze.',
  params: [
    { id: 'intensity', name: 'Insects', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent' },
    { id: 'cicadas', name: 'Cicadas', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent' },
    { id: 'bees', name: 'Bees flying past', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent' },
    { id: 'birds', name: 'Far birds', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent' },
    { id: 'distance', name: 'Distance to the trees', type: 'number', min: 10, max: 150, step: 5, def: 35, unit: 'meters' },
    { id: 'breeze', name: 'Breeze in the grass', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent' },
  ],
  generate(seconds, sr, p, rng) {
    const q = resolveParams(bed, p || {})
    const r = rng || makeRng('summer-field')
    const sc = makeScene(seconds, sr, r)
    if (!sc.n) return { sr: sc.sr, ch: [sc.L, sc.R] }
    const I = q.intensity / 100
    addAir(sc, { hushDb: -62, wind: 0.04 + 0.8 * (q.breeze / 100), gust: 0.6, body: 420, foliage: 0.85, foliageHz: 5000, rustle: 0.12, rumble: 0.05, gustPeriod: 8 }, r.fork('air'))
    const ci = (q.cicadas / 100) * (0.4 + 0.6 * I)
    if (ci > 0) addCicadas(sc, r.fork('cicadas'), { count: 0.6 + ci * 2.6, dist: q.distance, gain: 0.9, send: 0.35 })
    if (I > 0) {
      addGrasshoppers(sc, r.fork('hoppers'), { count: 1 + Math.round(I * 5), dist: 5, gain: 0.3, send: 0.2 })
      addCrickets(sc, r.fork('crickets'), { count: Math.round(I * 4), dist: 6, warmth: 0.85, kind: 'field', gain: 0.18, send: 0.25 })
    }
    const b = q.bees / 100
    if (b > 0) {
      addFlyBys(sc, r.fork('bees'), { kind: 'bee', rate: 2 + 14 * b, closest: 1.6, gain: 1, send: 0.2 })
      addFlyBys(sc, r.fork('bumble'), { kind: 'bumble', rate: 1 + 4 * b, closest: 2, gain: 1, send: 0.2, first: 4 })
    }
    const bi = q.birds / 100
    if (bi > 0) {
      const birds = makeSingers(['bouncer', 'slurs', 'bouncer'].slice(0, 1 + Math.round(bi * 2)), r.fork('birds'), { dist: q.distance * 1.5, sendMul: 0.7 })
      runSingers(sc, birds, r.fork('songs'), { rate: 0.3 + 0.7 * bi, start: [1, 6] })
    }
    return finishScene(sc, SPACES.field, r.fork('space'), -9)
  },
}

export default bed
