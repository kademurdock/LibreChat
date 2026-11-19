// beds/laundromat.js - Laundromat: washers sloshing, dryers tumbling with buttons ticking, a spin cycle, coins.
//
// Techniques and their published sources:
// - Dryers: a drum turning a little under once a second lifts the load and
//   drops it, so every turn brings one or two soft thumps of falling cloth and
//   now and then the tick of a button or zip against the steel, over the
//   blower's broadband rush and its motor hum (motor and fan sounds from the
//   kit in factory.js; Bies and Hansen, "Engineering Noise Control").
// - Front-loading washers move through their program: filling (water hiss
//   and a valve's buzz), washing (the drum turns a while, pauses, reverses,
//   each turn a slosh of water), draining (pump hum and gurgle) and the
//   spin, whose motor whine climbs for many seconds with a rumble and a
//   rattle of the cabinet.
// - Coins drop through the slot mechanism (modal metal, van den Doel and
//   Pai 1998); doors slam on their latches; the end-of-cycle buzzer is a
//   harsh square buzz; someone shakes out a shirt.
// - Tile floor, glass front: a short bright room; fluorescent hum overhead,
//   a TV talking quietly in the corner.

import {
  makeScene, emptyBed, finish, roomTone, emit, crowd, makeTalker, conversation, voiceAtRate, walker, paColor,
  poisson, logRange, pickW, clamp, filt, strike, thump, noiseBurst, buf, addAt, seed32, trim, steadyNoise,
  sinCycles, sizedRoom, sizeSpread,
} from './cafe.js'
import { motorHum, fanSound } from './factory.js'

/**
 * A dryer running through the take. air is the shared blower rush (every
 * dryer's blower sounds alike, so each reads it from its own place in the
 * take); this dryer adds its own blade tone and motor hum.
 */
function dryer(sc, rng, pan, d, air) {
  const sr = sc.sr
  const len = sc.dur + 0.5
  const hum = motorHum(sr, rng, len, { rot: rng.range(28, 30), rotLevel: 0.5, rough: 0, whine: rng.range(110, 160), whineLevel: 0.6 })
  const na = air.length
  const off = rng.int(na)
  for (let i = 0; i < hum.length; i++) {
    let j = i + off
    if (j >= na) j -= na
    hum[i] = air[j] * 0.06 + hum[i] * 0.03
  }
  emit(sc, hum, 0, pan, d, 1)
  const rot = 1 / rng.range(0.75, 0.9)
  const heavy = rng.range(0.4, 1)
  const buttons = rng.chance(0.75)
  const thuds = [0, 1, 2].map(() => trim(thump(sr, rng, rng.range(70, 110), 0.05, { noise: 0.8, noiseHz: 350 })))
  for (let t = -rng.range(0, rot); t < sc.dur; t += rot * (1 + rng.gauss() * 0.02)) {
    // the load falls once or twice a turn
    emit(sc, thuds[rng.int(3)], (t + rng.range(0.3, 0.45) * rot) * sr, pan, d, 0.25 * heavy * rng.range(0.6, 1.1))
    if (rng.chance(0.5)) emit(sc, thuds[rng.int(3)], (t + rng.range(0.55, 0.75) * rot) * sr, pan, d, 0.12 * heavy)
    if (buttons && rng.chance(0.55)) emit(sc, strike(sr, rng, rng.chance(0.6) ? 'coin' : 'cutlery', { size: 1.6, hard: 7000, tick: 0.6, maxSec: 0.15 }), (t + rng.range(0.25, 0.8) * rot) * sr, pan, d, 0.04)
  }
}

/** A washer somewhere in its program during the take. */
function washer(sc, rng, pan, d, spinChance) {
  const sr = sc.sr
  const phase = rng.chance(spinChance) ? 'spin' : pickW(rng, [1, 4, 1]) === 0 ? 'fill' : 'wash'
  const t0 = -rng.range(0, 8)
  const len = sc.dur - t0 + 0.5
  if (phase === 'fill') {
    const w = steadyNoise(sc, rng, t0, rng.range(15, 40), { att: 0.3, rel: 0.5, hz: 2200, q: 0.5 })
    if (w) emit(sc, w.sig, w.start * sr, pan, d, 0.08)
    const buzz = motorHum(sr, rng, Math.min(len, 40), { harm: [[1, 0.3], [2, 1], [4, 0.3]], rough: 0 })
    emit(sc, buzz, Math.max(0, t0) * sr, pan, d, 0.01)
  }
  if (phase === 'wash' || phase === 'fill') {
    // turns, pause, turns the other way
    let t = phase === 'fill' ? t0 + rng.range(8, 20) : t0
    const rot = rng.range(0.9, 1.3)
    let dir = 1
    while (t < sc.dur) {
      const turns = 6 + rng.int(8)
      const motor = motorHum(sr, rng, turns * rot, { harm: [[1, 0.2]], rot: rng.range(9, 13), rotLevel: 0.4, whine: rng.range(350, 550) * (dir > 0 ? 1 : 1.04), whineLevel: 0.2, rough: 0.2 })
      for (let i = 0; i < motor.length; i++) motor[i] *= Math.min(1, i / (0.4 * sr)) * Math.min(1, (motor.length - i) / (0.4 * sr))
      emit(sc, motor, t * sr, pan, d, 0.06)
      for (let k = 0; k < turns; k++) {
        const sl = noiseBurst(sr, rng, rot * 0.8, { att: rot * 0.35, dec: rot * 0.2, hz: rng.range(400, 900), q: 0.7 })
        emit(sc, sl, (t + k * rot) * sr, pan, d, 0.12)
        if (rng.chance(0.3)) emit(sc, trim(thump(sr, rng, 90, 0.05, { noise: 0.6, noiseHz: 300 })), (t + k * rot + rot * 0.5) * sr, pan, d, 0.1)
      }
      t += turns * rot + rng.range(2, 4)
      dir = -dir
    }
  } else {
    // the spin: whine climbing for many seconds, rumble, rattle
    const ramp = rng.range(10, 25)
    const n = Math.ceil(len * sr)
    const out = new Float32Array(n)
    const top = rng.range(13, 18)
    let ph = 0
    let pw = 0
    let s = seed32(rng)
    let lp = 0
    for (let i = 0; i < n; i++) {
      const t = i / sr
      const u = Math.min(1, t / ramp)
      const f = 2 + (top - 2) * u * u * (3 - 2 * u)
      ph += f / sr
      if (ph >= 1) ph -= 1
      const drum = sinCycles(ph)
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      lp += (s / 2147483648 - lp) * 0.02
      pw += (f * 37) / sr
      const whine = sinCycles(pw) * 0.25 + sinCycles(2 * pw) * 0.1
      const rattle = drum > 0.85 && u > 0.6 ? (s / 2147483648) * 0.3 : 0
      out[i] = drum * 0.15 * u + lp * 3 * (0.3 + u) + whine * u + rattle
    }
    filt(out, sr, [['highpass', 18, 0.7], ['lowpass', 5000, 0.7]])
    emit(sc, out, t0 * sr, pan, d, 0.2)
  }
}

/** Quarters fed into a coin slot, one by one. */
function feedCoins(sc, rng, t, pan, d) {
  const sr = sc.sr
  const n = 3 + rng.int(6)
  let tt = t
  for (let k = 0; k < n; k++) {
    emit(sc, strike(sr, rng, 'coin', { hard: 9000, tick: 0.5, maxSec: 0.4 }), tt * sr, pan, d, 0.18)
    emit(sc, trim(thump(sr, rng, 260, 0.012, { noise: 0.7, noiseHz: 2500 })), (tt + 0.12) * sr, pan, d, 0.25)
    tt += rng.range(0.5, 1.1)
  }
  // push the slide in
  emit(sc, trim(thump(sr, rng, 160, 0.03, { noise: 0.7, noiseHz: 1500 })), (tt + 0.3) * sr, pan, d, 0.5)
  emit(sc, strike(sr, rng, 'metal', { size: 0.6, hard: 6000, tick: 1, maxSec: 0.4 }), (tt + 0.32) * sr, pan, d, 0.12)
}

const bed = {
  id: 'laundromat',
  name: 'Laundromat',
  group: 'places',
  about: 'A laundromat: washers sloshing, dryers tumbling with buttons ticking, a spin cycle whining, coins and buzzers.',
  params: [
    { id: 'intensity', name: 'How busy', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'size', name: 'Room size', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'washers', name: 'Washers running', type: 'number', min: 0, max: 6, step: 1, def: 3, unit: 'count', noun: ['washer', 'washers'], rand: [1, 5] },
    { id: 'dryers', name: 'Dryers running', type: 'number', min: 0, max: 6, step: 1, def: 3, unit: 'count', noun: ['dryer', 'dryers'], rand: [1, 5] },
    { id: 'spin', name: 'Spin cycle', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [0, 80] },
  ],
  generate(seconds, sr, p, rng) {
    const sc = makeScene(bed, seconds, sr, p, rng, { send: 0.5, airHz: 15000, airM: 10, roomR: 8 })
    if (!sc.n) return emptyBed(sc.sr)
    const q = sc.q
    const sp = sizeSpread(q.size / 100)
    const r = sc.rng
    const busy = q.intensity / 100
    roomTone(sc, r.fork('air'), { db: -54, color: [['lowpass', 1200, 0.7]], hum: [[120, -62], [240, -70]], buzzDb: -60, buzzBright: 0.7, drift: 0.15 })
    // a wall of dryers on one side, washers in rows on the other
    const dr = r.fork('dryers')
    const air = q.dryers > 0 ? fanSound(sc.sr, dr.fork('air'), sc.dur + 0.5, { color: [['lowpass', 1600, 0.6], ['peak', 300, 0.8, 4], ['highpass', 60, 0.7]] }) : null
    for (let k = 0; k < q.dryers; k++) dryer(sc, dr.fork('d' + k), clamp(-0.85 + k * 0.22 + dr.range(-0.05, 0.05), -1, 1), dr.range(1.8, 5), air)
    const ws = r.fork('washers')
    for (let k = 0; k < q.washers; k++) washer(sc, ws.fork('w' + k), clamp(0.85 - k * 0.25 + ws.range(-0.05, 0.05), -1, 1), ws.range(1.8, 6), q.spin / 100)
    // people: a couple talking, a TV, coins, doors, shirts shaken out
    if (busy > 0.1) crowd(sc, r.fork('people'), { groups: Math.round(busy * 2.5), size: [2, 2], dist: [2.5 * sp, 7 * sp], effort: 0.4, react: 0.4, silence: 0.3 })
    const tv = r.fork('tv')
    const T = makeTalker(tv, 'adult', { effort: 0.5, rate: 5 })
    const tvPan = tv.range(-0.9, 0.9)
    for (const s of conversation(tv, [T], -2, sc.dur, { silence: 0.1, phrases: [1, 4] })[0]) {
      emit(sc, paColor(voiceAtRate(sc, T, s.fr), sc.sr, { lo: 300, hi: 4500, drive: 1.3 }), s.t * sc.sr, tvPan, 6, 0.25, 0.8)
    }
    const ev = r.fork('events')
    for (const t of poisson(ev, 0.02 + busy * 0.06, -1, sc.dur)) feedCoins(sc, ev.fork('c' + Math.round(t * 1000)), t, ev.range(-0.9, 0.9), logRange(ev, 2, 7))
    for (const t of poisson(ev, 0.02 + busy * 0.05, 0, sc.dur)) {
      // a door slammed on its latch
      const a = thump(sc.sr, ev, ev.range(80, 120), 0.05, { noise: 0.6, noiseHz: 800 })
      addAt(a, strike(sc.sr, ev, 'metal', { size: 1.1, hard: 5000, tick: 0.8 }), 0, 0.25)
      emit(sc, trim(a), t * sc.sr, ev.range(-0.95, 0.95), logRange(ev, 1.5, 6), 0.7)
    }
    for (const t of poisson(ev, 0.006 + busy * 0.01, 0, sc.dur)) {
      // the end-of-cycle buzzer
      const bz = buf(sc.sr, 1.6)
      let ph = 0
      for (let i = 0; i < 1.4 * sc.sr; i++) {
        ph += 230 / sc.sr
        bz[i] = (ph % 1 < 0.4 ? 0.3 : -0.2) * Math.min(1, i / 300) * Math.min(1, (1.4 * sc.sr - i) / 300)
      }
      filt(bz, sc.sr, [['lowpass', 4000, 0.7], ['peak', 1500, 2, 5]])
      emit(sc, bz, t * sc.sr, ev.range(-0.9, 0.9), logRange(ev, 2, 6), 0.4)
    }
    for (const t of poisson(ev, busy * 0.05, 0, sc.dur)) {
      // a shirt shaken out
      emit(sc, noiseBurst(sc.sr, ev, 0.12, { att: 0.01, dec: 0.03, hz: 1500, q: 0.5 }), t * sc.sr, ev.range(-0.9, 0.9), logRange(ev, 1.5, 5), 0.5)
    }
    const wk = r.fork('walk')
    for (const t of poisson(wk, 0.02 + busy * 0.08, -4, sc.dur)) {
      walker(sc, wk.fork('w' + Math.round(t * 1000)), { t, surface: 'tile', shoe: 'soft', closest: logRange(wk, 1, 5), gain: 0.4 })
    }
    return finish(sc, sizedRoom({ size: 0.75, rt60: 0.8, rt60High: 0.45, predelayMs: 5, wet: 0.85 }, q.size / 100), -25 + (q.intensity - 50) * 0.04)
  },
}

export default bed
