// beds/construction.js - Construction site: a jackhammer, hammering, a circular saw, a diesel digger, a beeper.
//
// Techniques and their published sources:
// - Jackhammer: a pneumatic breaker fires its piston twenty-odd times a
//   second; each blow is a hard click of steel on concrete with the chisel's
//   ring (modal synthesis, Cook 2002), and the exhaust air hisses in time
//   with the blows. It runs in bursts with pauses to reposition.
// - Hammering nails: each stroke is a ping of the hammer face on the nail
//   head over a thud of the timber, the strokes speeding up and the last one
//   landing heavier, the rhythm of a carpenter driving a nail home.
// - Circular saw: a universal motor's whine (rotation and brush harmonics)
//   that spins up, drops in pitch and screams as the blade loads in the cut,
//   then winds down (motor and cutting noise as in Bies and Hansen,
//   "Engineering Noise Control").
// - Diesel digger: an idling diesel, firing pulses at the firing rate with a
//   rough, uneven burble, that revs as the bucket digs, with hydraulic whine,
//   the scrape of the bucket and rubble tumbling out; a dump truck's tailgate
//   bangs and its reversing beeper sounds.
// - Outdoors among buildings: slap echoes off the nearby facades over a
//   short wash; the city hum behind.

import {
  makeScene, emptyBed, finish, roomTone, emit, makeTalker, speech, reactFrames, voiceAtRate, poisson, rexp,
  filt, strike, thump, noiseBurst, modal, buf, addAt, seed32, trim, TAU, harmonicTable,
} from './cafe.js'
import { beeperRun, airBlast } from './factory.js'
import { vehicleSound, vehicleRate } from './city-street.js'

/** A burst of jackhammering. */
function jackhammer(sr, rng, dur) {
  const out = buf(sr, dur + 0.5)
  const rate = rng.range(18, 26)
  const blows = []
  for (let k = 0; k < 4; k++) {
    const b = buf(sr, 0.2)
    addAt(b, noiseBurst(sr, rng, 0.03, { att: 0.0003, dec: 0.004, hz: rng.range(1500, 2600), q: 1 }), 0, 1)
    addAt(b, thump(sr, rng, rng.range(90, 140), 0.012, { noise: 0.5, noiseHz: 1500 }), 0, 0.7)
    addAt(b, strike(sr, rng, 'bar', { size: 0.5, hard: 7000, tick: 0.4, maxSec: 0.15 }), 0, 0.25)
    blows.push(trim(b))
  }
  const hiss = noiseBurst(sr, rng, dur, { att: 0.05, dec: 1e6, hz: 4000, q: 0.5, rel: 0.1 })
  let t = 0
  while (t < dur) {
    addAt(out, blows[rng.int(4)], t * sr, rng.range(0.7, 1))
    const k0 = Math.round(t * sr)
    const k1 = Math.min(hiss.length, k0 + Math.round(sr / rate))
    // the exhaust puffs with every blow
    for (let i = k0; i < k1; i++) out[i] += hiss[i] * 0.35 * Math.exp(-((i - k0) / sr) / 0.015)
    t += (1 / rate) * (1 + rng.gauss() * 0.03)
  }
  return out
}

/** Driving one nail: strokes speeding up, the last one heavier. */
function nail(sc, rng, t, pan, d) {
  const sr = sc.sr
  const n = 3 + rng.int(5)
  let gap = rng.range(0.5, 0.7)
  const ping = rng.range(2200, 3600)
  for (let k = 0; k < n; k++) {
    const last = k === n - 1
    const a = buf(sr, 0.4)
    addAt(a, modal(sr, [ping, 0.03, 1, ping * 2.7, 0.015, 0.5, ping * 0.45, 0.02, 0.4], { hard: 9000, tick: 0.8, tickHz: 2500, seed: seed32(rng) }), 0, last ? 0.6 : 1)
    addAt(a, thump(sr, rng, rng.range(120, 200), 0.03, { noise: 0.6, noiseHz: 900 }), 0, last ? 1.4 : 0.8)
    emit(sc, trim(a), t * sr, pan, d, rng.range(0.6, 0.9) * (last ? 1.3 : 1))
    t += gap
    gap *= rng.range(0.82, 0.95)
  }
  return t
}

/** One cut with a circular saw: spin up, load, scream, wind down. */
function sawCut(sr, rng) {
  const up = rng.range(0.4, 0.7)
  const cut = rng.range(1.2, 3.5)
  const down = rng.range(1.2, 2.2)
  const dur = up + cut + down + 0.3
  const n = Math.ceil(dur * sr)
  const out = new Float32Array(n)
  const f0 = rng.range(80, 110)
  const tbl = harmonicTable([[1, 1], [2, 0.6], [3, 0.5], [4, 0.3], [6, 0.25], [8, 0.15], [12, 0.1]])
  const blade = rng.range(2600, 3800)
  let ph = 0
  let pb = 0
  let s = seed32(rng)
  let lp = 0
  for (let i = 0; i < n; i++) {
    const t = i / sr
    let sp
    if (t < up) sp = t / up
    else if (t < up + cut) sp = 0.82 + 0.06 * Math.sin(TAU * 1.3 * t)
    else sp = Math.max(0, 1 - (t - up - cut) / down)
    sp = sp * sp * (3 - 2 * sp)
    ph += (f0 * sp) / sr
    if (ph >= 1) ph -= 1
    pb += (blade * sp) / sr
    if (pb >= 1) pb -= 1
    const x = ph * 2048
    const i0 = x | 0
    const motor = tbl[i0] + (tbl[i0 + 1] - tbl[i0]) * (x - i0)
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const w = s / 2147483648
    lp += (w - lp) * 0.3
    const load = t > up && t < up + cut ? Math.min(1, (t - up) / 0.15) * Math.min(1, (up + cut - t) / 0.1) : 0
    const scream = Math.sin(TAU * pb) * (0.3 + 0.7 * load)
    out[i] = (motor * 0.25 * sp + scream * 0.2 * sp + w * 0.1 * sp + lp * load * 0.8) * Math.min(1, t / 0.02)
  }
  filt(out, sr, [['highpass', 70, 0.7], ['peak', blade, 2, 4], ['lowpass', 9000, 0.7]])
  return out
}

/** The digger: diesel idle that revs while it digs, hydraulic whine, bucket scrape and rubble. */
function digger(sc, rng, pan, d, amount) {
  const sr = sc.sr
  const rate = vehicleRate(sr)
  const n = Math.ceil((sc.dur + 0.5) * rate)
  // diesel: pulses at the firing rate with a slow rev curve
  const tbl = harmonicTable([[1, 1], [2, 0.7], [3, 0.5], [4, 0.4], [5, 0.25], [6, 0.2], [8, 0.1]])
  const fire = rng.range(26, 34)
  const eng = new Float32Array(n)
  const revs = []
  for (let t = rng.range(-3, 3); t < sc.dur; t += rng.range(6, 14)) revs.push([t, rng.range(2.5, 6)])
  let ph = 0
  let s = seed32(rng)
  let amp = 1
  let rough = 0
  const hyd = rng.range(380, 520)
  let phh = 0
  for (let i = 0; i < n; i++) {
    const t = i / rate
    let rev = 0
    for (let k = 0; k < revs.length; k++) {
      const [r0, rd] = revs[k]
      if (t > r0 && t < r0 + rd) rev = Math.max(rev, Math.min(1, (t - r0) / 0.8) * Math.min(1, (r0 + rd - t) / 1.2))
    }
    ph += (fire * (1 + 0.6 * rev)) / rate
    if (ph >= 1) {
      ph -= 1
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      amp = 1 + 0.25 * (s / 2147483648)
    }
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    rough += (s / 2147483648 - rough) * 0.05
    const x = ph * 2048
    const i0 = x | 0
    phh += (hyd * (1 + 0.2 * rev)) / rate
    if (phh >= 1) phh -= 1
    eng[i] = (tbl[i0] + (tbl[i0 + 1] - tbl[i0]) * (x - i0)) * amp * (0.6 + 0.6 * rev) + rough * 1.5 * (0.5 + rev) + Math.sin(TAU * phh) * 0.08 * rev
  }
  filt(eng, rate, [['lowpass', 900, 0.7], ['peak', 70, 1, 4], ['highpass', 20, 0.7]])
  // bring it to the scene rate
  const sig = new Float32Array(sc.n)
  const k = sr / rate
  for (let i = 0; i < sc.n; i++) {
    const x = i / k
    const i0 = x | 0
    sig[i] = i0 + 1 < n ? eng[i0] + (eng[i0 + 1] - eng[i0]) * (x - i0) : 0
  }
  emit(sc, sig, 0, pan, d, 0.6 * amount)
  // after each dig: bucket scrape and rubble poured out
  for (const [r0, rd] of revs) {
    const sp = noiseBurst(sr, rng, rd * 0.6, { att: 0.3, dec: rd, hz: rng.range(900, 1500), q: 1.5, rel: 0.3 })
    emit(sc, sp, (r0 + 0.5) * sr, pan, d, 0.6 * amount)
    let tt = r0 + rd + rng.range(0.5, 2)
    const nr = 15 + rng.int(25)
    for (let j = 0; j < nr; j++) {
      const rock = buf(sr, 0.15)
      addAt(rock, thump(sr, rng, rng.range(100, 300), 0.02, { noise: 0.8, noiseHz: rng.range(1000, 3000) }), 0, 1)
      emit(sc, trim(rock), tt * sr, pan + rng.range(-0.1, 0.1), d, rng.range(0.1, 0.5) * amount)
      tt += rexp(rng, 0.05)
    }
  }
}

const bed = {
  id: 'construction',
  name: 'Construction site',
  group: 'places',
  about: 'A building site: a jackhammer, hammering, a circular saw, a diesel digger and a reversing beeper.',
  params: [
    { id: 'intensity', name: 'How busy', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [30, 95] },
    { id: 'jackhammer', name: 'Jackhammer', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [10, 90] },
    { id: 'saw', name: 'Circular saw', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 80] },
    { id: 'hammering', name: 'Hammering', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [10, 90] },
    { id: 'machines', name: 'Diesel machines', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [10, 90] },
    { id: 'distance', name: 'Distance from the work', type: 'number', min: 5, max: 80, step: 1, def: 15, unit: 'meters', rand: [8, 40] },
  ],
  generate(seconds, sr, p, rng) {
    const sc = makeScene(bed, seconds, sr, p, rng, { send: 0.15, airHz: 18000, airM: 50, roomR: 20 })
    if (!sc.n) return emptyBed(sc.sr)
    const q = sc.q
    const r = sc.rng
    const busy = q.intensity / 100
    const D = q.distance
    roomTone(sc, r.fork('city'), { db: -42, color: [['lowpass', 600, 0.7], ['highpass', 35, 0.7]], rumbleDb: -42, rumbleHz: 90, drift: 0.5, corr: 0.2 })
    // the digger
    if (q.machines > 0) digger(sc, r.fork('digger'), r.range(-0.6, 0.6), D * r.range(0.9, 1.4), 0.5 + q.machines / 100)
    // a dump truck coming and going, beeping as it backs up
    const tk = r.fork('truck')
    for (const t of poisson(tk, (q.machines / 100) * 0.03, -10, sc.dur)) {
      const pan = tk.range(-0.9, 0.9)
      const d = D * tk.range(1, 2)
      const dur = tk.range(5, 12)
      const rate = vehicleRate(sc.sr)
      const idle = vehicleSound(rate, tk, dur, { kind: 'truck', speed: 3 })
      const up = new Float32Array(Math.ceil(dur * sc.sr))
      const k = sc.sr / rate
      for (let i = 0; i < up.length; i++) {
        const x = i / k
        const i0 = x | 0
        up[i] = i0 + 1 < idle.length ? idle[i0] + (idle[i0 + 1] - idle[i0]) * (x - i0) : 0
      }
      emit(sc, up, t * sc.sr, pan, d, 1.5)
      emit(sc, beeperRun(sc.sr, tk, dur * 0.7), (t + 0.5) * sc.sr, pan, d, 2.5)
      // the tailgate bangs when it dumps
      const bang = thump(sc.sr, tk, 60, 0.08, { noise: 0.8, noiseHz: 700 })
      addAt(bang, strike(sc.sr, tk, 'metal', { size: 2.5, hard: 3000, tick: 1 }), 0, 0.5)
      emit(sc, bang, (t + dur + tk.range(0.5, 2)) * sc.sr, pan, d, 3)
    }
    // jackhammer bursts
    const jh = r.fork('jackhammer')
    if (q.jackhammer > 0) {
      const pan = jh.range(-0.8, 0.8)
      const d = D * jh.range(0.8, 1.2)
      let t = jh.range(-2, 3)
      while (t < sc.dur) {
        const dur = jh.range(1.5, 6) * (0.5 + q.jackhammer / 100)
        emit(sc, jackhammer(sc.sr, jh, dur), t * sc.sr, pan, d, 2.6)
        t += dur + jh.range(1, 7) / (0.3 + q.jackhammer / 100)
      }
    }
    // carpenters
    const hm = r.fork('hammers')
    const nCarp = Math.round((q.hammering / 100) * (1 + busy * 2))
    for (let c = 0; c < nCarp; c++) {
      const hc = hm.fork('c' + c)
      const pan = hc.range(-0.95, 0.95)
      const d = D * hc.range(0.6, 1.8)
      let t = hc.range(-1, 4)
      while (t < sc.dur) {
        t = nail(sc, hc, t, pan, d) + hc.range(0.6, 4)
        if (hc.chance(0.15)) t += hc.range(4, 12)
      }
    }
    // the saw
    const sw = r.fork('saw')
    for (const t of poisson(sw, (q.saw / 100) * 0.1, -4, sc.dur)) emit(sc, sawCut(sc.sr, sw), t * sc.sr, sw.range(-0.9, 0.9), D * sw.range(0.7, 1.5), 2.2)
    // metal: rebar, scaffold poles, a dropped tool
    const mt = r.fork('metal')
    for (const t of poisson(mt, 0.05 + busy * 0.12, 0, sc.dur)) {
      const a = strike(sc.sr, mt, mt.chance(0.6) ? 'bar' : 'metal', { size: mt.range(0.8, 2), hard: 5000, tick: 1 })
      emit(sc, a, t * sc.sr, mt.range(-0.95, 0.95), D * mt.range(0.6, 2), 1.2)
      if (mt.chance(0.4)) emit(sc, strike(sc.sr, mt, 'bar', { size: 1.5, hard: 4000, tick: 0.5 }), (t + mt.range(0.15, 0.3)) * sc.sr, mt.range(-0.95, 0.95), D, 0.6)
    }
    // air tools and a shout now and then
    const ar = r.fork('air')
    for (const t of poisson(ar, busy * 0.05, 0, sc.dur)) emit(sc, airBlast(sc.sr, ar, ar.range(0.3, 1)), t * sc.sr, ar.range(-0.9, 0.9), D, 1.2)
    const sh = r.fork('shouts')
    for (const t of poisson(sh, 0.015 + busy * 0.03, -1, sc.dur)) {
      const T = makeTalker(sh, 'man', { effort: 1 })
      const f = []
      if (sh.chance(0.4)) reactFrames(T, sh, f, 0, 'hey', { effort: 1, level: 1 })
      else f.push(...speech(T, sh, 1, { effort: 1, syl: [2, 5] }).fr)
      emit(sc, voiceAtRate(sc, T, f), t * sc.sr, sh.range(-0.9, 0.9), D * sh.range(0.8, 1.5), 3)
    }
    const taps = [[34, 0.4, -0.8], [61, 0.35, 0.7], [97, 0.25, -0.5], [150, 0.15, 0.4], [230, 0.08, -0.2]]
    return finish(sc, { size: 1.2, rt60: 0.8, rt60High: 0.4, predelayMs: 25, wet: 0.45, taps }, -22 + (q.intensity - 50) * 0.06)
  },
}

export default bed
