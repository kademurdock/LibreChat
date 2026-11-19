// beds/kitchen.js - Restaurant kitchen: sizzling pans, chopping, clanging pots, the hood fan, shouted orders.
//
// Techniques and their published sources:
// - Frying: oil sizzle is a dense stream of tiny bursting bubbles and
//   spitting drops, so it is built as random crackle (many short decaying
//   clicks at a Poisson rate, as in Farnell 2010, "Designing Sound", the fire
//   and bubbling chapters) over a bright hiss; food hitting the pan makes a
//   loud swell that settles back over a few seconds.
// - Chopping: a knife through food into a wooden board, each stroke a short
//   wooden thud (modal synthesis, Cook 2002) with a slice of crunch, in quick
//   runs at four to seven strokes a second.
// - Pots, pans, lids, plates and the steel counter: the places kit's modal
//   objects (van den Doel and Pai 1998), set down, knocked and stacked.
// - The hood fan: a powerful broadband roar with its blade-pass hum and
//   motor hum; the dish machine sprays in the back; the tap runs.
// - People: shouted orders and calls at high effort (the Lombard effect), a
//   service bell, the ticket printer chattering out an order.
// - Room: tile, steel and hard ceilings, lively but not long.

import {
  makeScene, emptyBed, finish, roomTone, emit, crowd, makeTalker, speech, reactFrames, voiceAtRate, walker,
  poisson, logRange, pickW, filt, strike, thump, noiseBurst, modal, buf, addAt, seed32, sinePhasor, trim,
  steadyNoise, sizedRoom, sizeSpread,
} from './cafe.js'

/** A pan sizzling for dur seconds: crackle plus hiss, with a swell when food goes in. */
function sizzle(sr, rng, dur, o = {}) {
  const n = Math.ceil(dur * sr)
  const out = new Float32Array(n)
  let s = seed32(rng)
  const rate0 = o.rate ?? 900
  const drop = o.drop ?? 0
  let y = 0
  const dec = Math.exp(-1 / (0.0004 * sr))
  let hs = 0
  const gh = 1 - Math.exp((-2 * Math.PI * 5000) / sr)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const swell = drop > 0 ? 1 + drop * 3 * Math.exp(-t / 1.6) * Math.min(1, t / 0.05) : 1
    const p = ((rate0 * swell) / sr) * 4294967296
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    let x = 0
    if ((s >>> 0) < p) {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      const u = s / 2147483648
      x = u * u * u * 3
    }
    y = y * dec + x
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const w = s / 2147483648
    hs += (w - hs) * gh
    out[i] = (y + (w - hs) * 0.25 * Math.sqrt(swell)) * Math.min(1, t / 0.2) * Math.min(1, (dur - t) / 0.4)
  }
  filt(out, sr, [['highpass', 1200, 0.7], ['peak', 4500, 0.8, 4], ['lowpass', 12000, 0.7]])
  return out
}

/** A run of knife strokes on a board. */
function chopRun(sc, rng, t, pan, d, g) {
  const sr = sc.sr
  const n = 4 + rng.int(20)
  const rate = rng.range(4, 7)
  const board = [rng.range(140, 220), rng.range(380, 520)]
  for (let k = 0; k < n; k++) {
    const out = buf(sr, 0.09)
    addAt(out, modal(sr, [board[0], 0.018, 1, board[1], 0.01, 0.5, board[1] * 2.3, 0.006, 0.3], { hard: 4000, tick: 0.6, tickHz: 1500, seed: seed32(rng) }), 0, 1)
    addAt(out, noiseBurst(sr, rng, 0.04, { att: 0.002, dec: 0.008, hz: 3500, q: 0.7 }), 0, 0.35)
    emit(sc, trim(out), (t + k / rate + rng.gauss() * 0.012) * sr, pan, d, g * rng.range(0.7, 1.1))
  }
}

/** Pots and pans: a knock, a set-down, a lid, a scrape, a stack. */
function potMoment(sc, rng, t) {
  const sr = sc.sr
  const pan = rng.range(-0.95, 0.95)
  const d = logRange(rng, 1.5, 8)
  const k = pickW(rng, [3, 2, 2, 1, 1.5])
  if (k === 0) {
    // pan banged on the burner grate
    const a = strike(sr, rng, rng.chance(0.5) ? 'pan' : 'pot', { hard: 4000, tick: 0.8 })
    addAt(a, thump(sr, rng, 120, 0.03, { noise: 0.5 }), 0, 0.6)
    emit(sc, a, t * sr, pan, d, rng.range(0.15, 0.35))
  } else if (k === 1) {
    // a lid rattling down
    for (let i = 0; i < 3 + rng.int(4); i++) emit(sc, strike(sr, rng, 'tray', { size: 0.8, hard: 5000, tick: 0.5 }), (t + i * rng.range(0.04, 0.09) * Math.pow(0.8, i)) * sr, pan, d, 0.12 * Math.pow(0.7, i))
  } else if (k === 2) {
    // plates stacked
    for (let i = 0; i < 2 + rng.int(5); i++) emit(sc, strike(sr, rng, 'plate', { hard: 6000, tick: 0.8 }), (t + i * rng.range(0.15, 0.4)) * sr, pan, d, rng.range(0.08, 0.16))
  } else if (k === 3) {
    // a spatula scraping a flat-top
    const sc2 = noiseBurst(sr, rng, rng.range(0.3, 0.8), { att: 0.05, dec: 0.2, hz: rng.range(2500, 4000), q: 2 })
    emit(sc, sc2, t * sr, pan, d, 0.15)
  } else {
    // a sheet pan dropped on steel
    const a = strike(sr, rng, 'metal', { size: 1.3, hard: 5000, tick: 1 })
    emit(sc, a, t * sr, pan, d, rng.range(0.2, 0.4))
    emit(sc, strike(sr, rng, 'metal', { size: 1.3, hard: 5000, tick: 0.6 }), (t + rng.range(0.08, 0.14)) * sr, pan, d, 0.1)
  }
}

/** The ticket printer: a buzzy chatter of print lines and a tear. */
function ticketPrinter(sr, rng) {
  const dur = rng.range(1.5, 3)
  const out = buf(sr, dur + 0.4)
  const lines = Math.round(dur * 9)
  for (let k = 0; k < lines; k++) {
    const b = noiseBurst(sr, rng, 0.07, { att: 0.002, dec: 0.03, hz: 2200, q: 2 })
    addAt(out, b, (k / 9) * sr, 0.6)
    const m = sinePhasor(Math.round(0.05 * sr), sr, 480, 0, 0)
    addAt(out, m, (k / 9) * sr, 0.08)
  }
  addAt(out, noiseBurst(sr, rng, 0.25, { att: 0.01, dec: 0.08, hz: 3000, q: 0.7 }), dur * sr, 0.6)
  return out
}

/** Running water from the tap into the sink. */
function tapWater(sr, rng, dur) {
  const out = noiseBurst(sr, rng, dur, { att: 0.15, dec: dur * 2, hz: 1800, q: 0.5 })
  let s = seed32(rng)
  // bubbles popping in the basin
  for (let k = 0; k < dur * 25; k++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const off = Math.floor(((s >>> 0) / 4294967296) * (out.length - 3000))
    const f0 = 600 + ((s >>> 8) % 2400)
    for (let i = 0; i < 2000; i++) {
      const tt = i / sr
      out[off + i] += Math.sin(2 * Math.PI * f0 * (1 + 3 * tt) * tt) * Math.exp(-tt / 0.008) * 0.25
    }
  }
  const e = Math.min(out.length >> 1, Math.round(0.2 * sr))
  for (let i = 0; i < e; i++) out[out.length - 1 - i] *= i / e
  return out
}

const bed = {
  id: 'kitchen',
  name: 'Restaurant kitchen',
  group: 'places',
  about: 'A restaurant kitchen at full tilt: sizzling pans, chopping, clanging pots, the hood fan and shouted orders.',
  params: [
    { id: 'intensity', name: 'How busy', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [30, 95] },
    { id: 'size', name: 'Kitchen size', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'sizzle', name: 'Frying', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [20, 90] },
    { id: 'chopping', name: 'Chopping', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [10, 85] },
    { id: 'shouts', name: 'Shouted orders', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 80] },
    { id: 'fan', name: 'Hood fan', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
  ],
  generate(seconds, sr, p, rng) {
    const sc = makeScene(bed, seconds, sr, p, rng, { send: 0.6, airHz: 16000, airM: 10, roomR: 6 })
    if (!sc.n) return emptyBed(sc.sr)
    const q = sc.q
    const sp = sizeSpread(q.size / 100)
    const r = sc.rng
    const busy = q.intensity / 100
    const fan = q.fan / 100
    roomTone(sc, r.fork('hood'), {
      db: -44 + fan * 14,
      color: [['lowpass', 2500, 0.6], ['peak', 400, 0.7, 4], ['peak', 1200, 1, 2]],
      rumbleDb: -48 + fan * 12,
      rumbleHz: 140,
      hum: [[r.range(110, 150), -60 + fan * 10], [120, -64 + fan * 6]],
      drift: 0.1,
      corr: 0.5,
    })
    // pans on the line
    const fr = r.fork('fry')
    const nPans = Math.round((q.sizzle / 100) * (1 + busy * 3))
    for (let k = 0; k < nPans; k++) {
      const pk = fr.fork('pan' + k)
      const pan = pk.range(-0.8, 0.8)
      const d = pk.range(1.5, 5)
      let t = -pk.range(0, 10)
      while (t < sc.dur) {
        const dur = pk.range(6, 25)
        emit(sc, sizzle(sc.sr, pk, dur, { rate: pk.range(500, 1600), drop: pk.chance(0.5) ? pk.range(0.5, 1.5) : 0 }), t * sc.sr, pan, d, 0.12 * (0.4 + q.sizzle / 100))
        t += dur + pk.range(-2, 4)
      }
    }
    // the deep fryer bubbling steadily in one corner
    if (q.sizzle > 0) emit(sc, sizzle(sc.sr, fr.fork('fryer'), sc.dur + 1, { rate: 2500 }), -0.5 * sc.sr, fr.range(-0.9, 0.9), 6, 0.08 * (q.sizzle / 100))
    // chopping
    const ch = r.fork('chop')
    const cPan = ch.range(-0.6, 0.6)
    for (const t of poisson(ch, (q.chopping / 100) * (0.08 + busy * 0.15), -3, sc.dur)) chopRun(sc, ch.fork('c' + Math.round(t * 1000)), t, cPan + ch.range(-0.2, 0.2), ch.range(1.5, 4), 0.25)
    // pots and plates
    const pt = r.fork('pots')
    for (const t of poisson(pt, 0.15 + busy * 0.6, -1, sc.dur)) potMoment(sc, pt.fork('p' + Math.round(t * 1000)), t)
    // shouted orders and calls
    const sh = r.fork('shouts')
    for (const t of poisson(sh, (q.shouts / 100) * (0.05 + busy * 0.12), -2, sc.dur)) {
      const s2 = sh.fork('s' + Math.round(t * 1000))
      const T = makeTalker(s2, 'adult', { effort: 0.9, rate: 4.2, expr: 0.7 })
      let sig
      if (s2.chance(0.3)) {
        const f = []
        reactFrames(T, s2, f, 0, s2.pick(['hey', 'yeah', 'oh']), { effort: 0.95, level: 1 })
        sig = voiceAtRate(sc, T, f)
      } else sig = voiceAtRate(sc, T, speech(T, s2, 1 + s2.int(2), { effort: 0.9, syl: [2, 6], pause: [0.15, 0.4] }).fr)
      emit(sc, sig, t * sc.sr, s2.range(-0.9, 0.9), logRange(s2, 2, 9), 2.2)
      // and the answer from the line
      if (s2.chance(0.5)) {
        const T2 = makeTalker(s2, 'adult', { effort: 0.85 })
        const f = []
        reactFrames(T2, s2, f, 0, s2.pick(['yeah', 'hey', 'mhm']), { effort: 0.9, level: 1 })
        emit(sc, voiceAtRate(sc, T2, f), (t + sig.length / sc.sr + s2.range(0.2, 0.6)) * sc.sr, s2.range(-0.9, 0.9), logRange(s2, 2, 8), 1.8)
      }
    }
    // a quieter steady chatter of the crew
    crowd(sc, r.fork('crew'), { groups: Math.round(busy * 3), size: [2, 2], dist: [3 * sp, 9 * sp], effort: 0.6, react: 0.4, silence: 0.3 })
    // ticket printer and service bell
    const tk = r.fork('tickets')
    const tPan = tk.range(-0.9, 0.9)
    for (const t of poisson(tk, 0.02 + busy * 0.05, -2, sc.dur)) {
      emit(sc, ticketPrinter(sc.sr, tk), t * sc.sr, tPan, 4, 0.3)
      if (tk.chance(0.6)) emit(sc, strike(sc.sr, tk, 'bell', { hard: 8000, tick: 0.3 }), (t + tk.range(3, 8)) * sc.sr, tPan * 0.8, 3.5, 0.5)
    }
    // the dish machine in the back, and the tap
    const dm = r.fork('dish')
    for (const t of poisson(dm, 0.012 + busy * 0.02, -60, sc.dur)) {
      const run = steadyNoise(sc, dm, t, dm.range(40, 70), { att: 1.5, rel: 2, hz: 900, q: 0.4 })
      if (run) emit(sc, run.sig, run.start * sc.sr, dm.range(-0.9, 0.9), 9, 0.5)
    }
    for (const t of poisson(dm, 0.03 + busy * 0.03, -4, sc.dur)) emit(sc, tapWater(sc.sr, dm, dm.range(2, 7)), t * sc.sr, dm.range(-0.9, 0.9), logRange(dm, 2.5, 7), 0.3)
    // quick steps on tile, oven and cooler doors
    const wk = r.fork('walk')
    for (const t of poisson(wk, 0.08 + busy * 0.25, -3, sc.dur)) {
      walker(sc, wk.fork('w' + Math.round(t * 1000)), { t, surface: 'tile', shoe: 'soft', pace: wk.range(2.1, 2.6), closest: logRange(wk, 1, 5), gain: 0.4, squeak: 0.12 })
    }
    for (const t of poisson(wk, 0.02 + busy * 0.05, 0, sc.dur)) {
      const a = thump(sc.sr, wk, wk.range(70, 110), 0.07, { noise: 0.5, noiseHz: 600 })
      addAt(a, strike(sc.sr, wk, 'metal', { size: 1.4, hard: 3000, tick: 0.6 }), 0, 0.15)
      emit(sc, a, t * sc.sr, wk.range(-0.9, 0.9), logRange(wk, 3, 9), 1.4)
    }
    return finish(sc, sizedRoom({ size: 0.75, rt60: 0.85, rt60High: 0.55, predelayMs: 6, wet: 0.95 }, q.size / 100), -23 + (q.intensity - 50) * 0.06)
  },
}

export default bed
