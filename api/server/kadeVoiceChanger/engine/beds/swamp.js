// beds/swamp.js - A warm swamp after dark.
//
// Still, heavy air; deep croakers booming "jug-o-rum" across the water,
// green frogs twanging like loose banjo strings, cricket frogs clicking like
// pebbles knocked together, chorus frogs running their combs, katydids
// rasping in the trees, crickets and long insect trills, and gas bubbling up
// out of the mud. Frogs and bubbles come from frogs-pond.js, insects from
// night-crickets.js; a mosquito can whine past your ear (beehive.js). The
// space is soft and damp (SPACES.swamp).

import { makeRng } from '../core/rng.js'
import { resolveParams } from '../core/params.js'
import { makeScene, addAir, finishScene, SPACES } from './forest-birds.js'
import { addCrickets, addKatydids, addTrillers } from './night-crickets.js'
import { addDeepCroakers, addGreenFrogs, addCricketFrogs, addChorusFrogs, addMudBubbles, addPlops } from './frogs-pond.js'
import { addFlyBys } from './beehive.js'

const bed = {
  id: 'swamp',
  name: 'Swamp at night',
  group: 'nature',
  about: 'A warm swamp after dark: deep frogs booming, twangs and clicks, rasping insects, bubbling mud.',
  params: [
    { id: 'intensity', name: 'Frogs', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent' },
    { id: 'insects', name: 'Insects', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent' },
    { id: 'bubbles', name: 'Bubbling mud', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent' },
    { id: 'distance', name: 'Distance to the frogs', type: 'number', min: 3, max: 80, step: 1, def: 15, unit: 'meters' },
    { id: 'mosquitoes', name: 'Mosquitoes', type: 'bool', def: false },
  ],
  generate(seconds, sr, p, rng) {
    const q = resolveParams(bed, p || {})
    const r = rng || makeRng('swamp')
    const sc = makeScene(seconds, sr, r)
    if (!sc.n) return { sr: sc.sr, ch: [sc.L, sc.R] }
    const I = q.intensity / 100
    const d = q.distance
    addAir(sc, { hushDb: -58, wind: 0.04, gust: 0.35, body: 300, foliage: 0.25, foliageHz: 2600, rustle: 0.05, rumble: 0.2 }, r.fork('air'))
    if (I > 0) {
      addDeepCroakers(sc, r.fork('croakers'), { count: 1 + Math.round(I * 3), dist: Math.max(15, d * 1.6), gain: 1.1, send: 0.6 })
      addGreenFrogs(sc, r.fork('green'), { count: Math.round(I * 4), dist: d, gain: 0.7, send: 0.5 })
      addCricketFrogs(sc, r.fork('clickers'), { count: Math.round(I * 3), dist: d * 0.8, gain: 0.55, send: 0.45 })
      addChorusFrogs(sc, r.fork('chorus'), { count: Math.round(I * 3), dist: d * 1.4, gain: 0.45, send: 0.5 })
    }
    const ins = q.insects / 100
    if (ins > 0) {
      addKatydids(sc, r.fork('katydids'), { count: 1 + Math.round(ins * 5), dist: 18, gain: 0.5, send: 0.5 })
      addCrickets(sc, r.fork('crickets'), { count: Math.round(ins * 12), dist: 10, warmth: 0.75, kind: 'mixed', gain: 0.3, send: 0.45 })
      addTrillers(sc, r.fork('trill'), { count: Math.round(ins * 3), dist: 15, gain: 0.15, send: 0.4 })
    }
    const b = q.bubbles / 100
    if (b > 0) {
      addMudBubbles(sc, r.fork('mud'), { rate: 4 + 26 * b, dist: Math.max(3, d * 0.4), gain: 0.2, send: 0.35 })
      addPlops(sc, r.fork('plops'), { rate: 1 + 4 * b, dist: d, gain: 0.4, send: 0.4 })
    }
    if (q.mosquitoes) addFlyBys(sc, r.fork('mosquito'), { kind: 'mosquito', rate: 5, closest: 0.6, gain: 1, send: 0.1, first: 1.5 })
    return finishScene(sc, SPACES.swamp, r.fork('space'), -6)
  },
}

export default bed
