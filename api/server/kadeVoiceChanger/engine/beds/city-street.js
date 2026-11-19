// beds/city-street.js - City street: cars swishing past, horns, a far siren, people walking by.
//
// This file also holds the road sounds other place beds borrow (passing
// vehicles, horns, sirens). Techniques and their published sources:
// - Vehicles follow the standard road-noise picture (Sandberg and Ejsmont,
//   "Tyre/Road Noise Reference Book", 2002): above walking pace a car is
//   mostly tyre roar, a broad band peaking near 1 kHz that grows steeply
//   with speed, over an engine note at the firing rate (rpm / 60 times half
//   the cylinders) with its harmonics, shaped by the exhaust. Every firing
//   is a smooth pulse with its own strength, so the engine burbles rather
//   than buzzes. A wet road adds the hiss of spray.
// - Each vehicle drives a straight lane past the listener and is heard with
//   its true travel time, so the Doppler drop as it passes comes from the
//   physics (Smith, Serafin, Abel and Berners 2002), with level falling as
//   1/r and highs as distance grows.
// - Horns: two diaphragm horns a major third apart, rich in harmonics.
//   Sirens: an electronic siren's wail and yelp sweeps (rounded square wave
//   through a horn speaker), far away behind buildings.
// - Traffic comes in a Poisson stream mixed with platoons released by a
//   light; footsteps and passing pairs of talkers use the places kit.
// - Buildings give slap echoes and a short wash: early reflection taps and
//   the kit's feedback delay network.

import {
  makeScene, emptyBed, finish, roomTone, emit, emitMoving, emitPath, walker, poisson, logRange, pickW, clamp,
  filt, hp1, lp1, tone, thump, strike, noiseBurst, makeTalker, conversation, voiceAtRate, passPath, seed32, TAU,
  soft,
} from './cafe.js'

const KINDS = {
  car: { cyl: 4, rpm: [1500, 2600], pulse: 6, tyre: 1, eng: 0.35, ex: 700, muf: 160, gain: 1.6 },
  truck: { cyl: 6, rpm: [1100, 1700], pulse: 4, tyre: 1.3, eng: 1, ex: 480, muf: 90, gain: 3.5 },
  bus: { cyl: 6, rpm: [1000, 1600], pulse: 4, tyre: 1.2, eng: 0.8, ex: 450, muf: 80, gain: 3 },
  bike: { cyl: 2, rpm: [2800, 4800], pulse: 10, tyre: 0.4, eng: 1.5, ex: 1500, muf: 220, gain: 3 },
  electric: { cyl: 0, tyre: 1, eng: 0, gain: 1.4 },
}

const PULSE = new Map()
function pulseTable(p) {
  let t = PULSE.get(p)
  if (t) return t
  t = new Float32Array(1025)
  let mean = 0
  for (let i = 0; i < 1024; i++) {
    t[i] = Math.pow(0.5 - 0.5 * Math.cos((TAU * i) / 1024), p)
    mean += t[i] / 1024
  }
  for (let i = 0; i < 1024; i++) t[i] -= mean
  t[1024] = t[0]
  PULSE.set(p, t)
  return t
}

/**
 * The sound of one vehicle as it leaves the vehicle (mono, RMS about 1),
 * at `rate` samples per second. o: { kind, speed (m/s), wet, rev (0..1 hard
 * acceleration) }
 */
export function vehicleSound(rate, rng, dur, o = {}) {
  const K = KINDS[o.kind] || KINDS.car
  const n = Math.max(2, Math.ceil(dur * rate))
  const out = new Float32Array(n)
  const sp = clamp((o.speed ?? 12) / 12, 0.2, 3)
  let s = seed32(rng)
  if (K.cyl) {
    const eng = new Float32Array(n)
    const tbl = pulseTable(K.pulse)
    const fe0 = ((rng.range(K.rpm[0], K.rpm[1]) / 60) * K.cyl) / 2
    const camp = new Float32Array(K.cyl)
    for (let c = 0; c < K.cyl; c++) camp[c] = 1 + rng.gauss() * 0.12
    const rev = o.rev ?? 0
    const shift = rng.range(2, 3.5)
    let ph = rng.next()
    let amp = 1
    let cy = 0
    let wv = 0
    let wt = 0
    for (let i = 0; i < n; i++) {
      const t = i / rate
      if ((i & 255) === 0) {
        s ^= s << 13
        s ^= s >>> 17
        s ^= s << 5
        wt = wt * 0.9 + (s / 2147483648) * 0.1
        wv = wv * 0.95 + wt * 0.05
      }
      let f = fe0 * (1 + 0.6 * wv)
      if (rev > 0) {
        const u = (t % shift) / shift
        f *= 1 + rev * (0.15 + 0.55 * u)
      }
      ph += f / rate
      if (ph >= 1) {
        ph -= 1
        cy = cy + 1 >= K.cyl ? 0 : cy + 1
        s ^= s << 13
        s ^= s >>> 17
        s ^= s << 5
        amp = camp[cy] * (1 + 0.22 * (s / 2147483648)) * (1 + rev * 0.8)
      }
      const x = ph * 1024
      const i0 = x | 0
      eng[i] = (tbl[i0] + (tbl[i0 + 1] - tbl[i0]) * (x - i0)) * amp
    }
    hp1(eng, rate, 25)
    filt(eng, rate, [['lowpass', K.ex, 0.6], ['peak', K.muf, 1.2, 6]])
    lp1(eng, rate, K.ex * 1.6)
    let e = 0
    for (let i = 0; i < n; i++) e += eng[i] * eng[i]
    const g = e > 0 ? K.eng / Math.sqrt(e / n) : 0
    for (let i = 0; i < n; i++) out[i] += eng[i] * g
  } else {
    // electric: a faint motor whine that follows speed
    const w = tone(rate, rng.range(600, 1100) * sp, dur, { partials: [[1, 1], [2, 0.3]], att: 0.3, rel: 0.3 })
    for (let i = 0; i < n; i++) out[i] += w[i] * 0.05
  }
  // tyres: a broad roar peaking near a kilohertz, plus road rumble
  const ty = new Float32Array(n)
  const ru = new Float32Array(n)
  let br = 0
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const w = s / 2147483648
    ty[i] = w
    br = br * 0.995 + w * 0.05
    ru[i] = br
  }
  filt(ty, rate, [['bandpass', rng.range(800, 1200) * Math.sqrt(sp), 0.6], ['lowshelf', 300, 0.7, 4]])
  filt(ru, rate, [['lowpass', 220, 0.7]])
  const tl = K.tyre * Math.pow(sp, 1.6)
  let et = 0
  let er = 0
  for (let i = 0; i < n; i++) {
    et += ty[i] * ty[i]
    er += ru[i] * ru[i]
  }
  const gt = et > 0 ? tl / Math.sqrt(et / n) : 0
  const gr = er > 0 ? (tl * 0.6) / Math.sqrt(er / n) : 0
  for (let i = 0; i < n; i++) out[i] += ty[i] * gt + ru[i] * gr
  if (o.wet) {
    const sw = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      sw[i] = s / 2147483648
    }
    filt(sw, rate, [['highpass', 2200, 0.7], ['peak', 5000, 0.7, 3], ['lowpass', Math.min(0.45 * rate, 11000), 0.7]])
    let e = 0
    for (let i = 0; i < n; i++) e += sw[i] * sw[i]
    const g = e > 0 ? (0.9 * sp) / Math.sqrt(e / n) : 0
    for (let i = 0; i < n; i++) out[i] += sw[i] * g
  }
  let e = 0
  for (let i = 0; i < n; i++) e += out[i] * out[i]
  const g = e > 0 ? 1 / Math.sqrt(e / n) : 0
  for (let i = 0; i < n; i++) out[i] *= g
  // fade the very ends (the vehicle is far away there anyway)
  const f = Math.min(n >> 1, Math.round(0.3 * rate))
  for (let i = 0; i < f; i++) {
    const w = i / f
    out[i] *= w
    out[n - 1 - i] *= w
  }
  return out
}

/** Source rate for vehicles: half the scene rate when that is plenty. */
export function vehicleRate(sr) {
  return sr >= 32000 ? sr / 2 : sr
}

/**
 * A vehicle driving past in a straight lane. o: { tc (s, closest approach),
 * speed, dir (+1 left to right), lane (m), kind, wet, rev, gain, range (m
 * audible each way) }
 */
export function drivePast(sc, rng, o = {}) {
  const speed = o.speed ?? 12
  const range = o.range ?? 75
  const span = range / speed
  const tc = o.tc ?? 0
  let t0 = tc - span
  let t1 = tc + span
  const maxDelay = range / 343
  if (t1 < -0.5 || t0 > sc.dur + 0.5) return
  t0 = Math.max(t0, -maxDelay - 1)
  t1 = Math.min(t1, sc.dur + 0.5)
  if (t1 - t0 < 0.3) return
  const rate = vehicleRate(sc.sr)
  const K = KINDS[o.kind] || KINDS.car
  const sig = vehicleSound(rate, rng, t1 - t0, o)
  const dir = o.dir ?? 1
  const lane = o.lane ?? 5
  const pos = (t, p) => {
    p.x = dir * speed * (t - tc)
    p.y = lane
  }
  emitMoving(sc, sig, t0, pos, (o.gain ?? 1) * K.gain * Math.pow(speed / 12, 0.8), o.send ?? 1, rate)
}

/** A car horn: two tones a major third apart. pattern: tap, double, lean, truck */
export function horn(sr, rng, pattern = 'tap') {
  const truck = pattern === 'truck'
  const f1 = truck ? rng.range(210, 260) : rng.range(380, 450)
  const ratios = truck ? [1, 1.26, 1.5] : [1, 1.25]
  const parts = []
  for (let k = 1; k <= 14; k++) parts.push([k, Math.pow(1 / k, 0.75) * (k % 2 ? 1 : 0.6)])
  const notes = pattern === 'double' ? [[0, rng.range(0.1, 0.18)], [rng.range(0.22, 0.3), rng.range(0.12, 0.25)]] : [[0, pattern === 'lean' ? rng.range(1, 2) : truck ? rng.range(0.8, 1.6) : rng.range(0.15, 0.6)]]
  const total = notes[notes.length - 1][0] + notes[notes.length - 1][1] + 0.1
  const out = new Float32Array(Math.ceil(total * sr))
  for (const [t, d] of notes) {
    for (const r of ratios) {
      const tn = tone(sr, f1 * r * (1 + rng.gauss() * 0.004), d, { partials: parts, att: 0.012, rel: 0.03 })
      for (let i = 0; i < tn.length; i++) {
        const j = Math.round(t * sr) + i
        if (j < out.length) out[j] += tn[i] * 0.4
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = soft(out[i] * 1.5)
  filt(out, sr, [['highpass', 250, 0.7], ['peak', 2400, 1.5, 6], ['lowpass', 6000, 0.7]])
  return out
}

/** An electronic siren sweep: wail or yelp, at `rate`. */
export function sirenSound(rate, rng, dur, o = {}) {
  const n = Math.max(2, Math.ceil(dur * rate))
  const out = new Float32Array(n)
  const lo = rng.range(620, 720)
  const hi = rng.range(1300, 1500)
  const wailP = rng.range(4, 6)
  const yelpP = rng.range(0.28, 0.36)
  let mode = rng.chance(0.6) ? 0 : 1
  let next = rng.range(4, 9)
  let ph = 0
  let sw = 0
  for (let i = 0; i < n; i++) {
    const t = i / rate
    if (t > next && !o.wailOnly) {
      mode = 1 - mode
      next = t + (mode ? rng.range(2, 5) : rng.range(5, 10))
    }
    const per = mode ? yelpP : wailP
    sw += 1 / (per * rate)
    if (sw >= 1) sw -= 1
    // the rise is slower than the fall in a wail; a yelp is nearly a saw
    const u = mode ? sw : sw < 0.6 ? sw / 0.6 : 1 - (sw - 0.6) / 0.4
    const shaped = mode ? Math.sin((Math.PI / 2) * u) : 0.5 - 0.5 * Math.cos(Math.PI * u)
    const f = lo + (hi - lo) * shaped
    ph += f / rate
    if (ph >= 1) ph -= 1
    out[i] = soft(3 * Math.sin(TAU * ph))
  }
  filt(out, rate, [['highpass', 400, 0.7], ['peak', 1800, 1, 5], ['lowpass', 5000, 0.7]])
  return out
}

/** A siren vehicle crossing far away. */
export function farSiren(sc, rng, t, o = {}) {
  const dur = o.dur ?? rng.range(16, 30)
  const t0 = Math.max(-2, t)
  const t1 = Math.min(sc.dur + 1, t + dur)
  if (t1 - t0 < 1) return
  const rate = vehicleRate(sc.sr)
  const sig = sirenSound(rate, rng, t1 - t0, o)
  const n = sig.length
  // swell in and out as it turns corners behind buildings
  const fi = Math.min(n >> 1, Math.round(rate * Math.min(6, (t1 - t0) / 3)))
  for (let i = 0; i < fi; i++) {
    const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / fi)
    sig[i] *= w
    sig[n - 1 - i] *= w
  }
  const speed = rng.range(12, 22)
  const off = o.dist ?? rng.range(180, 450)
  const dir = rng.chance(0.5) ? 1 : -1
  const tc = t + dur * rng.range(0.35, 0.65)
  const pos = (te, p) => {
    p.x = dir * speed * (te - tc)
    p.y = off
  }
  emitMoving(sc, sig, t0, pos, (o.gain ?? 1) * 22, o.send ?? 1.6, rate)
}

const STREETS = {
  downtown: { room: { size: 1.4, rt60: 1.3, rt60High: 0.55, predelayMs: 18, wet: 0.55, taps: [[24, 0.55, -0.8], [37, 0.45, 0.75], [61, 0.35, -0.6], [88, 0.3, 0.55], [130, 0.18, -0.3], [175, 0.12, 0.4]] }, send: 0.25, speed: [9, 15], tone: -36, traffic: 1, people: 1 },
  avenue: { room: { size: 1.1, rt60: 0.9, rt60High: 0.4, predelayMs: 30, wet: 0.35, taps: [[48, 0.3, -0.7], [79, 0.25, 0.7], [140, 0.15, -0.2]] }, send: 0.15, speed: [11, 17], tone: -38, traffic: 1.2, people: 0.8 },
  side: { room: { size: 0.9, rt60: 0.8, rt60High: 0.35, predelayMs: 12, wet: 0.45, taps: [[18, 0.45, -0.8], [29, 0.4, 0.8], [52, 0.25, -0.4], [80, 0.15, 0.5]] }, send: 0.2, speed: [6, 11], tone: -42, traffic: 0.35, people: 0.6 },
}

const bed = {
  id: 'city-street',
  name: 'City street',
  group: 'places',
  about: 'A busy city sidewalk: cars swishing past, horns, a far-off siren, and people walking by.',
  params: [
    { id: 'intensity', name: 'Traffic', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'distance', name: 'Distance from the road', type: 'number', min: 2, max: 40, step: 1, def: 5, unit: 'meters', rand: [3, 15] },
    { id: 'horns', name: 'Horns', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [10, 70] },
    { id: 'sirens', name: 'Sirens', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 70] },
    { id: 'people', name: 'People walking by', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'wet', name: 'Wet road', type: 'bool', def: false },
    { id: 'crossing', name: 'Crossing signal ticking', type: 'bool', def: false },
    {
      id: 'street',
      name: 'Street',
      type: 'choice',
      def: 'downtown',
      options: [
        { v: 'downtown', name: 'Downtown between tall buildings' },
        { v: 'avenue', name: 'A wide avenue' },
        { v: 'side', name: 'A quiet side street' },
      ],
    },
  ],
  generate(seconds, sr, p, rng) {
    const sc = makeScene(bed, seconds, sr, p, rng, { send: 0.4, airHz: 18000, airM: 60, roomR: 15 })
    if (!sc.n) return emptyBed(sc.sr)
    const q = sc.q
    const st = STREETS[q.street] || STREETS.downtown
    sc.send = st.send
    const busy = q.intensity / 100
    const r = sc.rng
    // the far city: a low steady roar that breathes
    roomTone(sc, r.fork('roar'), {
      db: st.tone + busy * 6,
      color: [['lowpass', 650, 0.7], ['lowpass', 1400, 0.7], ['highpass', 35, 0.7]],
      rumbleDb: st.tone - 2 + busy * 6,
      rumbleHz: 90,
      drift: 0.6,
      corr: 0.2,
    })
    // traffic
    const tr = r.fork('traffic')
    const rate = (0.03 + busy * 0.55) * st.traffic
    const lanes = [q.distance, q.distance + 3.4, q.distance + 7, q.distance + 10.4]
    const cars = []
    for (const t of poisson(tr, rate, -6, sc.dur + 6)) cars.push(t)
    // platoons released by a light
    for (const t of poisson(tr, (0.012 + busy * 0.03) * st.traffic, -6, sc.dur + 6)) {
      const k = 2 + tr.int(4)
      for (let i = 0; i < k; i++) cars.push(t + i * tr.range(1.2, 2.4))
    }
    cars.sort((a, b) => a - b)
    for (let i = 0; i < cars.length; i++) {
      const cr = tr.fork('car' + i)
      const kind = ['car', 'truck', 'bus', 'bike', 'electric'][pickW(cr, [75, 8, 5, 5, 7])]
      const li = cr.int(q.street === 'side' ? 2 : 4)
      const dir = li % 2 === 0 ? 1 : -1
      const speed = cr.range(st.speed[0], st.speed[1]) * (kind === 'bike' ? 1.15 : kind === 'bus' ? 0.8 : 1)
      drivePast(sc, cr, { tc: cars[i], speed, dir, lane: lanes[li], kind, wet: q.wet, rev: cr.chance(0.18) ? cr.range(0.3, 1) : 0, gain: 1 })
      if ((kind === 'bus' || kind === 'truck') && cr.chance(0.35)) {
        // air brakes letting go
        const hiss = noiseBurst(sc.sr, cr, 0.9, { att: 0.01, dec: 0.25, hz: 3500, q: 0.6, hz2: 9000 })
        emit(sc, hiss, (cars[i] + cr.range(-1, 1)) * sc.sr, dir * cr.range(-0.6, 0.6), lanes[li] + 3, 1.2)
      }
    }
    // horns
    const hr = r.fork('horns')
    for (const t of poisson(hr, (q.horns / 100) * (0.02 + busy * 0.08), -1, sc.dur)) {
      const pat = ['tap', 'double', 'lean', 'truck'][pickW(hr, [5, 3, 1, 1])]
      const h = horn(sc.sr, hr, pat)
      const d = logRange(hr, q.distance + 6, 90)
      emit(sc, h, t * sc.sr, hr.range(-0.9, 0.9), d, hr.range(4, 12), 1.2)
      if (hr.chance(0.25)) emit(sc, horn(sc.sr, hr, 'tap'), (t + hr.range(0.5, 1.5)) * sc.sr, hr.range(-0.9, 0.9), d * hr.range(0.7, 1.5), hr.range(3, 8), 1.2)
    }
    // sirens
    const sr2 = r.fork('sirens')
    if (q.sirens > 0) {
      const ts = poisson(sr2, (q.sirens / 100) / 45, -20, sc.dur)
      if (!ts.length && sc.dur < 90 && sr2.chance(clamp(q.sirens / 100 + 0.35, 0, 1))) ts.push(sr2.range(-6, Math.max(0, sc.dur * 0.6)))
      for (const t of ts) farSiren(sc, sr2.fork('s' + Math.round(t * 100)), t, { gain: 0.6 + q.sirens / 150 })
    }
    // people on the sidewalk
    const pr = r.fork('people')
    const pRate = (q.people / 100) * (0.08 + busy * 0.12) * st.people
    for (const t of poisson(pr, pRate, -8, sc.dur)) {
      const wr = pr.fork('w' + Math.round(t * 1000))
      const close = wr.range(0.8, 3)
      const dir = wr.chance(0.5) ? 1 : -1
      const pace = wr.range(1.7, 2.1)
      const speed = pace * wr.range(0.62, 0.75)
      const x0 = -dir * wr.range(8, 14)
      const shoe = ['hard', 'heel', 'soft'][pickW(wr, [5, 2, 3])]
      walker(sc, wr, { t, pace, speed, dir, x0, closest: close, surface: 'concrete', shoe, gain: 0.45 })
      if (wr.chance(0.35)) {
        // a pair talking as they pass
        walker(sc, wr, { t: t + 0.25, pace, speed, dir, x0: x0 - dir * 0.5, closest: close + 0.6, surface: 'concrete', shoe: 'hard', gain: 0.4 })
        const talkers = [makeTalker(wr, 'adult', { effort: 0.5 }), makeTalker(wr, 'adult', { effort: 0.5 })]
        const span = (Math.abs(x0) * 2) / speed
        const sp = conversation(wr, talkers, t, t + span, { silence: 0.02 })
        for (let k = 0; k < 2; k++) {
          for (const s of sp[k]) {
            const sig = voiceAtRate(sc, talkers[k], s.fr)
            const path = passPath(x0 + dir * speed * (s.t - t), dir * speed, close + 0.3 * k, 1)
            const pathAbs = (tt, pos) => path(tt - s.t, pos)
            emitPath(sc, sig, s.t * sc.sr, pathAbs, 0.9 * talkers[k].gain)
          }
        }
      }
    }
    // a car door now and then
    const dr = r.fork('doors')
    for (const t of poisson(dr, 0.015 + busy * 0.02, 0, sc.dur)) {
      const a = thump(sc.sr, dr, dr.range(70, 100), 0.05, { noise: 0.5, noiseHz: 700 })
      const m = strike(sc.sr, dr, 'metal', { size: 1.8, hard: 2000, tick: 0.5 })
      for (let i = 0; i < m.length && i < a.length; i++) a[i] += m[i] * 0.25
      emit(sc, a, t * sc.sr, dr.range(-0.9, 0.9), logRange(dr, q.distance + 2, 40), 2.5)
    }
    // crossing signal locator tick
    if (q.crossing) {
      const cr = r.fork('crossing')
      const pan = cr.range(-0.6, 0.6)
      const tick = tone(sc.sr, 880, 0.035, { partials: [[1, 1], [3, 0.4], [5, 0.2]], att: 0.001, rel: 0.02 })
      const click = noiseBurst(sc.sr, cr, 0.01, { att: 0.0003, dec: 0.0015, hz: 3000, q: 1 })
      for (let i = 0; i < click.length; i++) tick[i] += click[i] * 0.6
      let t = cr.range(0, 1)
      let walk = cr.range(8, 30)
      while (t < sc.dur) {
        emit(sc, tick, t * sc.sr, pan, 3.5, 0.5, 0.6)
        if (t > walk && t < walk + 7) t += 0.12
        else {
          if (t >= walk + 7) walk += cr.range(45, 80)
          t += 1
        }
      }
    }
    return finish(sc, st.room, -24 + (q.intensity - 50) * 0.08)
  },
}

export default bed
