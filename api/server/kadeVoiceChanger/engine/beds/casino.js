// beds/casino.js - Casino floor: slot machines chiming, coins and chips, a roulette wheel, a cheer from a table.
//
// Techniques and their published sources:
// - Slot machines: every chime is a struck bar or bell from modal synthesis
//   (van den Doel and Pai 1998), all tuned to one key, the long-standing
//   practice of slot makers so a whole floor of machines rings in harmony.
//   Each machine idles with soft runs, spins its reels (a fast ratchet tick
//   and whirr), stops them one by one with a thunk, and on a win counts up
//   the credits in a rapid string of bells; a jackpot rings its alarm bell
//   (a hammered gong, as in the school bell) and pours coins into the tray.
// - Coins on steel: each coin a small bright modal ring, poured from a
//   hopper at ten to fifteen a second (the pouring-coins texture in Cook
//   2002, "Real Sound Synthesis for Interactive Applications").
// - Clay chips: very short, dull clicks of a dense ceramic; players riffle
//   them in quick runs. Cards are dealt with paper snaps.
// - Roulette: the ball's roll in the bowl is rolling noise whose rattle
//   slows as it loses speed, then bounces over the frets and settles (the
//   rolling model of van den Doel, Kry and Pai 2001).
// - People: babble, and now and then a table bursting into a cheer or a
//   groan (laughter-free reactions).
// - Room: wall-to-wall carpet and a low, padded ceiling over a huge floor:
//   a short, soft decay with the far machines melting together.

import {
  makeScene, emptyBed, finish, roomTone, emit, crowd, makeTalker, reactFrames, voiceAtRate, walker, poisson,
  rexp, logRange, clamp, filt, strike, thump, noiseBurst, modal, buf, addAt, seed32, trim, sizedRoom, sizeSpread,
} from './cafe.js'
import { electricBell } from './school-hall.js'

// the floor's key: C major pentatonic, over three octaves
const KEY = [0, 2, 4, 7, 9]
function noteHz(step) {
  const oct = Math.floor(step / 5)
  return 261.63 * Math.pow(2, oct + KEY[((step % 5) + 5) % 5] / 12)
}

/** A slot machine bell: a bright bar with a soft mallet. */
function slotBell(sr, rng, hz, dec = 0.35) {
  return modal(sr, [hz, dec, 1, hz * 2.756, dec * 0.4, 0.4, hz * 5.404, dec * 0.2, 0.2, hz * 2, dec * 0.6, 0.15], { hard: 9000, tick: 0.08, tickHz: 3000, maxSec: 1.6, seed: seed32(rng) })
}

/** One machine's life: idle runs, spins, stops, wins. */
function slot(sc, rng, pan, d, amount, jackpot, bells) {
  const sr = sc.sr
  const tick = trim(thump(sr, rng, rng.range(700, 1100), 0.003, { noise: 0.6, noiseHz: 3000 }))
  const thunk = trim(thump(sr, rng, rng.range(120, 180), 0.03, { noise: 0.5, noiseHz: 900 }))
  let t = -rng.range(0, 15)
  let guard = 0
  while (t < sc.dur && guard++ < 400) {
    if (rng.chance(0.35 + amount * 0.3)) {
      // a spin: button, reels ticking, three stops
      emit(sc, thump(sr, rng, 400, 0.006, { noise: 0.8, noiseHz: 2000 }), t * sr, pan, d, 0.3)
      const spin = rng.range(1.6, 2.6)
      for (let tt = 0.05; tt < spin; tt += 1 / rng.range(18, 24)) emit(sc, tick, (t + tt) * sr, pan, d, 0.06)
      for (let k = 0; k < 3; k++) emit(sc, thunk, (t + spin + k * rng.range(0.25, 0.35)) * sr, pan, d, 0.35)
      t += spin + 1.1
      const win = rng.next()
      if (jackpot && win < 0.03) {
        // jackpot: the alarm bell rings and coins pour
        emit(sc, electricBell(sr, rng, rng.range(4, 7), { hz: rng.range(1000, 1300), rate: rng.range(24, 30) }), t * sr, pan, d, 0.9, 1.2)
        const n = Math.round(rng.range(40, 90))
        let tc = t + 0.3
        for (let k = 0; k < n; k++) {
          const c = strike(sr, rng, 'coin', { hard: 9000, tick: 0.5, maxSec: 0.6 })
          addAt(c, strike(sr, rng, 'tray', { size: 0.6, hard: 6000, tick: 0.2, maxSec: 0.25 }), 0, 0.2)
          emit(sc, trim(c), tc * sr, pan + rng.range(-0.05, 0.05), d, rng.range(0.08, 0.2))
          tc += rexp(rng, 1 / 13)
        }
        for (let k = 0; k < 24; k++) emit(sc, bells[(k * 3) % bells.length], (t + k * 0.12) * sr, pan, d, 0.25)
        t = tc + 1
      } else if (win < 0.3) {
        // a win: credits count up in quick bells
        const n = 6 + rng.int(40)
        const base = rng.int(6)
        for (let k = 0; k < n; k++) emit(sc, bells[(base + (k % 5) * 2) % bells.length], (t + k * 0.075) * sr, pan, d, 0.12)
        t += n * 0.075 + 0.5
      }
      t += rng.range(1, 6)
    } else {
      // idle: a gentle run to lure players
      const n = 4 + rng.int(8)
      const start = rng.int(8)
      const up = rng.chance(0.6)
      for (let k = 0; k < n; k++) emit(sc, bells[clamp(start + (up ? k : -k + n), 0, bells.length - 1)], (t + k * 0.13) * sr, pan, d, 0.06)
      t += n * 0.13 + rng.range(4, 18)
    }
  }
}

/** A roulette spin: launch, the long roll, frets and the drop. */
function roulette(sc, rng, t, pan, d) {
  const sr = sc.sr
  const dur = rng.range(9, 15)
  const out = buf(sr, dur + 2)
  // roll: noise with a rattle that slows down
  let s = seed32(rng)
  let lp = 0
  let ph = 0
  for (let i = 0; i < Math.round(dur * sr); i++) {
    const u = i / (dur * sr)
    const speed = 1 - 0.8 * u
    ph += (14 * speed) / sr
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    lp += (s / 2147483648 - lp) * 0.15
    const rattle = 0.5 + 0.5 * Math.cos(2 * Math.PI * ph)
    out[i] = lp * (0.4 + 0.6 * rattle * rattle) * speed * Math.min(1, u * 40)
  }
  filt(out, sr, [['bandpass', 2500, 0.8], ['peak', 5000, 2, 4]])
  // frets and the pocket
  let tt = dur
  for (let k = 0; k < 6 + rng.int(6); k++) {
    addAt(out, strike(sr, rng, 'plastic', { size: 0.5, hard: 9000, tick: 1 }), tt * sr, rng.range(0.4, 1) * Math.pow(0.85, k))
    tt += rng.range(0.06, 0.18)
  }
  emit(sc, out, t * sr, pan, d, 0.25)
}

/** A player riffling chips. */
function chipRiffle(sc, rng, t, pan, d) {
  const sr = sc.sr
  const n = 6 + rng.int(14)
  const v = []
  for (let k = 0; k < 3; k++) v.push(trim(strike(sr, rng, 'chip', { hard: 8000, tick: 0.8 })))
  let tt = t
  for (let k = 0; k < n; k++) {
    emit(sc, v[rng.int(3)], tt * sr, pan, d, rng.range(0.1, 0.25))
    tt += rng.range(0.02, 0.06)
  }
}

/** A table cheers or groans: several voices at once, then claps. */
function tableReact(sc, rng, t, pan, d) {
  const sr = sc.sr
  const cheer = rng.chance(0.6)
  const n = 4 + rng.int(6)
  for (let k = 0; k < n; k++) {
    const T = makeTalker(rng, 'adult', { effort: cheer ? 0.95 : 0.7, expr: 0.9 })
    const f = []
    reactFrames(T, rng, f, 0, cheer ? rng.pick(['cheer', 'yeah', 'wow', 'hey']) : rng.pick(['aw', 'oh', 'aw']), { effort: cheer ? 1 : 0.7, level: 1, dur: rng.range(0.6, 1.4) })
    emit(sc, voiceAtRate(sc, T, f), (t + rng.range(0, 0.25)) * sr, clamp(pan + rng.range(-0.1, 0.1), -1, 1), d * rng.range(0.9, 1.15), 1.2)
  }
  if (cheer) {
    for (let k = 0; k < n; k++) {
      const rate = rng.range(3.5, 5)
      const cl = noiseBurst(sr, rng, 0.03, { att: 0.0005, dec: 0.006, hz: rng.range(900, 2000), q: 1.5 })
      for (let tt = t + 0.6 + rng.range(0, 0.2); tt < t + rng.range(2, 3.5); tt += 1 / rate) emit(sc, cl, tt * sr, clamp(pan + rng.range(-0.1, 0.1), -1, 1), d, 0.6)
    }
  }
}

const bed = {
  id: 'casino',
  name: 'Casino floor',
  group: 'places',
  about: 'A casino floor: slot machines chiming, coins and chips clattering, a roulette wheel, and a cheer from a table.',
  params: [
    { id: 'intensity', name: 'How busy', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [30, 95] },
    { id: 'size', name: 'Floor size', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'slots', name: 'Slot machines', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [30, 95] },
    { id: 'tables', name: 'Game tables', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'jackpot', name: 'Jackpots', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 70] },
  ],
  generate(seconds, sr, p, rng) {
    const sc = makeScene(bed, seconds, sr, p, rng, { send: 0.15, airHz: 14000, airM: 12, roomR: 25 })
    if (!sc.n) return emptyBed(sc.sr)
    const q = sc.q
    const sp = sizeSpread(q.size / 100)
    const r = sc.rng
    const busy = q.intensity / 100
    roomTone(sc, r.fork('air'), { db: -48, color: [['lowpass', 1100, 0.7], ['peak', 220, 1, 3]], hum: [[60, -70]], drift: 0.2 })
    crowd(sc, r.fork('people'), { groups: 2 + Math.round(busy * 8), size: [2, 4], dist: [2.5 * sp, 25 * sp], effort: 0.45 + busy * 0.15, react: 0.5, silence: 0.08 })
    // slot machines in banks around you
    const sl = r.fork('slots')
    const nSlots = Math.round((q.slots / 100) * (6 + busy * 18))
    // two banks of bells for the whole floor (it is all in one key anyway)
    const banks = [0, 1].map((b) => {
      const out = []
      for (let s = 5; s < 20; s++) out.push(trim(slotBell(sc.sr, sl, noteHz(s), b ? 0.42 : 0.26)))
      return out
    })
    for (let m = 0; m < nSlots; m++) {
      const mk = sl.fork('s' + m)
      const d = m < 2 ? mk.range(1.5, 3) : logRange(mk, 2.5, 22)
      slot(sc, mk, mk.range(-0.95, 0.95), d, busy, q.jackpot > 0 && mk.chance(0.25 + q.jackpot / 100), banks[m % 2])
    }
    // a guaranteed jackpot somewhere when they are turned up high
    if (q.jackpot >= 60) {
      const jk = r.fork('jackpot')
      const t = jk.range(0.1, 0.6) * sc.dur
      emit(sc, electricBell(sc.sr, jk, jk.range(4, 7), { hz: jk.range(1000, 1300), rate: 26 }), t * sc.sr, jk.range(-0.8, 0.8), jk.range(6, 14), 0.9)
    }
    // the tables
    const tb = r.fork('tables')
    const ta = q.tables / 100
    const tPos = []
    for (let k = 0; k < 4; k++) tPos.push([tb.range(-0.95, 0.95), logRange(tb, 3, 15)])
    for (const t of poisson(tb, ta * (0.15 + busy * 0.5), -1, sc.dur)) {
      const [pan, d] = tPos[tb.int(4)]
      chipRiffle(sc, tb.fork('c' + Math.round(t * 1000)), t, pan, d)
    }
    for (const t of poisson(tb, ta * (0.05 + busy * 0.1), -1, sc.dur)) {
      // cards dealt
      const [pan, d] = tPos[tb.int(4)]
      const n = 2 + tb.int(5)
      for (let k = 0; k < n; k++) emit(sc, noiseBurst(sc.sr, tb, 0.05, { att: 0.001, dec: 0.01, hz: 2500, q: 0.8 }), (t + k * tb.range(0.3, 0.6)) * sc.sr, pan, d, 0.25)
    }
    for (const t of poisson(tb, ta * 0.03, -10, sc.dur)) {
      const [pan, d] = tPos[0]
      roulette(sc, tb.fork('r' + Math.round(t * 100)), t, pan, d)
    }
    for (const t of poisson(tb, ta * (0.01 + busy * 0.03), -1, sc.dur)) {
      const [pan, d] = tPos[tb.int(4)]
      tableReact(sc, tb.fork('x' + Math.round(t * 100)), t, pan, d)
    }
    const wk = r.fork('walk')
    for (const t of poisson(wk, 0.05 + busy * 0.12, -4, sc.dur)) {
      walker(sc, wk.fork('w' + Math.round(t * 1000)), { t, surface: 'carpet', shoe: wk.chance(0.3) ? 'heel' : 'soft', closest: logRange(wk, 1.2, 8), gain: 0.35 })
    }
    return finish(sc, sizedRoom({ size: 1.3, rt60: 0.9, rt60High: 0.4, predelayMs: 10, wet: 0.75 }, q.size / 100), -23 + (q.intensity - 50) * 0.06)
  },
}

export default bed
