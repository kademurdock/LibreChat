// beds/subway-platform.js - Subway platform: trains rumble in and out, doors chime, announcements echo.
//
// Techniques and their published sources:
// - A train is a line of moving sources, one per pair of cars, each heard
//   with its true travel time (so the pitch slides as it passes; Smith,
//   Serafin, Abel and Berners 2002). Wheel and rail roar is noise in three
//   bands growing with speed (the rolling-noise picture of Thompson,
//   "Railway Noise and Vibration", 2009); motor cars add gear-mesh whine
//   proportional to speed and, while pulling away, the stepped tones of the
//   traction inverter; braking below walking pace brings flange squeal,
//   high partials that come and go (Thompson's curve-squeal chapter).
// - The train obeys simple kinematics: constant speed out of the tunnel,
//   steady braking to a stop at the end of the platform, a dwell, then
//   steady acceleration away. The clickety-clack is computed, not looped:
//   every axle of every car is followed to the exact moment it crosses each
//   rail joint, so the da-dum pairs slow down and stop with the train and
//   come from where the joints are.
// - Doors, chimes and the brake release are short synthesized events at the
//   doors' places along the train; the in-car voice comes through open
//   doors, the station voice through ceiling horns (places kit babble, so no
//   word is ever said).
// - The station: hard tiles and a long vault, a bright two-second decay from
//   the kit's feedback delay network, a far line rumbling through the walls,
//   an escalator, and people waiting.

import {
  makeScene, emptyBed, finish, roomTone, emit, emitMoving, crowd, walker, announce, poisson, logRange, pickW,
  thump, strike, noiseBurst, chime, makeTalker, speech, voiceAtRate, paColor, seed32, lp1, buf, addAt, trim,
} from './cafe.js'
import { vehicleRate } from './city-street.js'

const SIN = new Float32Array(2049)
for (let i = 0; i <= 2048; i++) SIN[i] = Math.sin((2 * Math.PI * i) / 2048)

/** Train motion: front position f(t) and speed v(t), stopping with the front at xs. */
function motion(o) {
  const v0 = o.v0 ?? 14
  const a = o.decel ?? 1.1
  const D = (v0 * v0) / (2 * a)
  const Tb = v0 / a
  const xs = o.xs ?? 60
  const tstop = o.tstop
  const tb0 = tstop - Tb
  const xb0 = xs - D
  const tdep = o.tdep
  const a2 = o.accel ?? 0.9
  const vmax = o.vmax ?? 20
  const Ta = vmax / a2
  const f = (t) => {
    if (t < tb0) return xb0 + v0 * (t - tb0)
    if (t < tstop) {
      const u = t - tb0
      return xb0 + v0 * u - 0.5 * a * u * u
    }
    if (t < tdep) return xs
    const u = t - tdep
    if (u < Ta) return xs + 0.5 * a2 * u * u
    return xs + 0.5 * a2 * Ta * Ta + vmax * (u - Ta)
  }
  const v = (t) => {
    if (t < tb0) return v0
    if (t < tstop) return v0 - a * (t - tb0)
    if (t < tdep) return 0
    const u = t - tdep
    return u < Ta ? a2 * u : vmax
  }
  const acc = (t) => (t >= tb0 && t < tstop ? -1 : t >= tdep && t < tdep + Ta ? 1 : 0)
  // when the front passes x on the way in (null once past the stop) ...
  const arriveAt = (x) => {
    if (x <= xb0) return tb0 + (x - xb0) / v0
    if (x > xs) return null
    const disc = v0 * v0 - 2 * a * (x - xb0)
    return tb0 + (v0 - Math.sqrt(Math.max(0, disc))) / a
  }
  // ... and on the way out
  const leaveAt = (x) => {
    if (x < xs) return null
    const d = x - xs
    const dA = 0.5 * a2 * Ta * Ta
    return d <= dA ? tdep + Math.sqrt((2 * d) / a2) : tdep + Ta + (d - dA) / vmax
  }
  return { f, v, acc, tb0, tstop, tdep, xs, v0, Ta, arriveAt, leaveAt }
}

/** Sound of one pair of cars as it leaves the train (mono, at rate). */
function carSound(rate, rng, ta, tb, M, motor, o) {
  const n = Math.max(2, Math.ceil((tb - ta) * rate))
  const out = new Float32Array(n)
  let s = seed32(rng)
  let lo = 0, b1 = 0, b2 = 0, hi = 0
  const gL = 1 - Math.exp((-2 * Math.PI * 120) / rate)
  const gB1 = 1 - Math.exp((-2 * Math.PI * 900) / rate)
  const gB2 = 1 - Math.exp((-2 * Math.PI * 260) / rate)
  const gH = 1 - Math.exp((-2 * Math.PI * 2600) / rate)
  const gearK = rng.range(38, 50)
  const invBase = rng.range(260, 330)
  let pg = rng.next(), pg2 = rng.next(), pinv = rng.next(), psq = rng.next(), psq2 = rng.next(), ph = rng.next()
  const sqF = rng.range(2400, 4200)
  const sqF2 = sqF * rng.range(1.48, 1.62)
  let sqOn = 0
  let sqT = 0
  let v = 0
  let ac = 0
  let roar = 0
  let invF = invBase
  let sqA = 0
  const hum = 120 / rate
  for (let i = 0; i < n; i++) {
    if ((i & 127) === 0) {
      const t = ta + i / rate
      v = M.v(t)
      ac = M.acc(t)
      const u = v / 14
      roar = Math.pow(u, 1.6)
      if (ac > 0 && v < 13) invF = invBase * Math.pow(2, (2 * Math.floor(v / 1.3)) / 12)
      // flange squeal while braking slowly
      if (ac < 0 && v < 9 && v > 0.3) {
        sqT -= 128 / rate
        if (sqT <= 0) {
          sqOn = rng.chance(o.squeal) ? 1 : 0
          sqT = rng.range(0.25, 1.4)
        }
      } else sqOn = 0
    }
    sqA += (sqOn * 0.22 - sqA) * 0.0008
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const w = s / 2147483648
    lo += (w - lo) * gL
    b1 += (w - b1) * gB1
    b2 += (b1 - b2) * gB2
    hi += (w - hi) * gH
    let x = (lo * 3.2 + (b1 - b2) * 1.6 + (w - hi) * 0.5) * (roar + 0.015)
    // rooftop air conditioning keeps humming when the train stands
    ph += hum
    if (ph >= 1) ph -= 1
    x += SIN[(ph * 2048) | 0] * 0.012 + lo * 0.25
    if (motor && v > 0.2) {
      const fg = gearK * v
      pg += fg / rate
      if (pg >= 1) pg -= 1
      pg2 += (2.02 * fg) / rate
      if (pg2 >= 1) pg2 -= 1
      x += (SIN[(pg * 2048) | 0] * 0.05 + SIN[(pg2 * 2048) | 0] * 0.025) * Math.min(1, v / 3) * (ac !== 0 ? 1.6 : 0.6)
      if (ac > 0 && v < 13) {
        pinv += invF / rate
        if (pinv >= 1) pinv -= 1
        x += SIN[(pinv * 2048) | 0] * 0.07 * (1 - v / 13)
      }
    }
    if (sqA > 0.001) {
      psq += (sqF * (1 + 0.004 * SIN[((i * 6.5) / rate * 2048) & 2047])) / rate
      if (psq >= 1) psq -= 1
      psq2 += sqF2 / rate
      if (psq2 >= 1) psq2 -= 1
      x += (SIN[(psq * 2048) | 0] + 0.4 * SIN[(psq2 * 2048) | 0]) * sqA
    }
    out[i] = x
  }
  // soft ends where the take's window cuts the train's sound
  const f = Math.min(n >> 1, Math.round(0.4 * rate))
  for (let i = 0; i < f; i++) {
    const w = i / f
    out[i] *= w
    out[n - 1 - i] *= w
  }
  return out
}

/** One clack of a wheel over a rail joint: a dull hit and a short ring of the rail. */
function clack(sr, rng) {
  const out = thump(sr, rng, rng.range(55, 85), 0.03, { noise: 0.8, noiseHz: 1500, drop: 0.6 })
  const ring = strike(sr, rng, 'bar', { size: 1.2, hard: 3000, tick: 0.6, maxSec: 0.35 })
  addAt(out, ring, 0, 0.15)
  return trim(out)
}

/** A whole train: arrive, open, close, leave (any part may lie outside the take). */
function train(sc, rng, o) {
  const sr = sc.sr
  const dir = o.dir
  const d = o.track
  const M = motion({ tstop: o.tstop, tdep: o.tstop + o.dwell, xs: 60 })
  const cars = 6
  const carLen = 18
  // audible window: front 350 m out until the rear is 350 m gone
  const tA = M.arriveAt(-350)
  const tB = M.leaveAt(350 + cars * carLen)
  const ta = Math.max(tA ?? M.tstop - 40, -2)
  const tb = Math.min(tB, sc.dur + 1)
  const rate = vehicleRate(sr)
  if (tb - ta > 0.5) {
    for (let k = 0; k < cars / 2; k++) {
      const off = -(carLen * (2 * k + 1))
      const sig = carSound(rate, rng.fork('car' + k), ta, tb, M, k !== 1, { squeal: o.squeal })
      const pos = (t, p) => {
        p.x = dir * (M.f(t) + off)
        p.y = d
      }
      emitMoving(sc, sig, ta, pos, 9 * o.gain, 1, rate)
    }
    // the push of air ahead of the train out of the tunnel mouth
    const gust = noiseBurst(sr, rng, 7, { att: 3.5, dec: 1.4, hz: 160, q: 0.5, type: 'lowpass' })
    emit(sc, gust, (M.tb0 - 5) * sr, -0.85 * dir, 30, 4 * o.gain, 1.5)
  }
  // clickety-clack at rail joints along the platform and into the tunnels
  const joints = []
  for (let x = -96 + rng.range(-4, 4); x < 100; x += 18 + rng.range(-1, 1)) joints.push(x)
  const axles = []
  for (let c = 0; c < cars; c++) {
    const mid = -(c * carLen + carLen / 2)
    axles.push(mid - 7.6, mid - 5.4, mid + 5.4, mid + 7.6)
  }
  const cr = rng.fork('clacks')
  // each joint has its own voice; every wheel over it sounds much the same
  for (const xj of joints) {
    const voices = [clack(sr, cr), clack(sr, cr), clack(sr, cr)]
    for (const ax of axles) {
      // arriving
      const t1 = M.arriveAt(xj - ax)
      const t2 = M.leaveAt(xj - ax)
      for (const t of [t1, t2]) {
        if (t === null || t < -1 || t > sc.dur + 0.5) continue
        const v = M.v(t)
        if (v < 0.8) continue
        const r = Math.hypot(xj, d)
        emit(sc, voices[cr.int(3)], (t + r / 343) * sr, (dir * xj) / r, r, 1.4 * o.gain * Math.pow(v / 14, 1.2) * cr.range(0.7, 1.1), 1)
      }
    }
  }
  // nothing more to hear if the stop lies outside the take
  if (M.tstop > sc.dur + 1 || M.tdep < -1) return
  // brakes let go of their air as the train stops
  const doorX = []
  for (let c = 0; c < cars; c++) for (let k = 0; k < 3; k++) doorX.push(M.xs - c * carLen - 3 - k * 6)
  const hiss = noiseBurst(sr, rng, 1.6, { att: 0.02, dec: 0.45, hz: 3800, q: 0.5, hz2: 10000 })
  emit(sc, hiss, (M.tstop + 0.4) * sr, dir * 0.3, d + 1, 2.2 * o.gain, 1.2)
  // doors open
  const tOpen = M.tstop + rng.range(1.2, 2)
  const dr = rng.fork('doors')
  for (const x of doorX) {
    const r = Math.hypot(x, d)
    if (r > 70) continue
    const t = tOpen + dr.range(0, 0.25)
    emit(sc, doorSlide(sr, dr, false), t * sr, (dir * x) / r, r, 1.5 * o.gain)
  }
  // the in-car voice through the open doors, then the closing chime and doors
  const tClose = M.tdep - rng.range(3, 4)
  const T = makeTalker(rng.fork('car voice'), 'adult', { effort: 0.5, rate: 4.4 })
  const { fr, dur } = speech(T, rng.fork('car words'), 1 + rng.int(2), { effort: 0.5 })
  if (tClose - 4 - dur > tOpen) {
    const sig = paColor(voiceAtRate(sc, T, fr), sr, { lo: 450, hi: 3200, drive: 3 })
    for (let c = 0; c < 3; c++) {
      const x = M.xs - (c * 2 + 1) * carLen
      const r = Math.hypot(x, d)
      emit(sc, sig, (tClose - 4 - dur + r / 343) * sr, (dir * x) / r, r, 0.9 * o.gain)
    }
  }
  const ch = chime(sr, rng.fork('chime'), [[o.chimeHi, 0], [o.chimeLo, 0.45]], { decay: 0.35 })
  for (let c = 0; c < cars; c += 2) {
    const x = M.xs - (c + 0.5) * carLen
    const r = Math.hypot(x, d)
    emit(sc, ch, (tClose - 2.4) * sr, (dir * x) / r, r, 0.8 * o.gain)
  }
  for (const x of doorX) {
    const r = Math.hypot(x, d)
    if (r > 70) continue
    emit(sc, doorSlide(sr, dr, true), (tClose + dr.range(0, 0.3)) * sr, (dir * x) / r, r, 1.6 * o.gain)
  }
}

/** A sliding door: a puff of air, the slide, and the stop (a bang when closing). */
function doorSlide(sr, rng, closing) {
  const out = buf(sr, 1.2)
  addAt(out, noiseBurst(sr, rng, 0.35, { att: 0.01, dec: 0.08, hz: 2500, q: 0.6 }), 0, 0.12)
  addAt(out, noiseBurst(sr, rng, 0.7, { att: 0.1, dec: 0.2, hz: 260, q: 0.8 }), 0.05 * sr, 0.25)
  const end = thump(sr, rng, closing ? 70 : 110, closing ? 0.06 : 0.03, { noise: 0.6, noiseHz: 900 })
  addAt(out, end, 0.62 * sr, closing ? 0.8 : 0.25)
  if (closing) addAt(out, strike(sr, rng, 'metal', { size: 1.6, hard: 2500, tick: 0.4 }), 0.62 * sr, 0.06)
  return out
}

/** A long low rumble of another line through the walls. */
function farLine(sc, rng, t) {
  const dur = rng.range(8, 16)
  const sig = noiseBurst(sc.sr, rng, dur, { att: dur * 0.45, dec: dur * 0.18, hz: 110, q: 0.5, type: 'lowpass' })
  lp1(sig, sc.sr, 220)
  emit(sc, sig, t * sc.sr, rng.range(-0.6, 0.6), 40, 30, 0.8)
}

const bed = {
  id: 'subway-platform',
  name: 'Subway platform',
  group: 'places',
  about: 'An underground platform: trains rumble in and out, doors chime, announcements echo off the tiles.',
  params: [
    { id: 'intensity', name: 'How crowded', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'trains', name: 'Trains', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [30, 100] },
    { id: 'announcements', name: 'Announcements', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 80] },
    { id: 'distance', name: 'Distance from the track', type: 'number', min: 1, max: 12, step: 0.5, def: 3, unit: 'meters', rand: [2, 6] },
    { id: 'squeal', name: 'Wheel squeal', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [0, 80] },
  ],
  generate(seconds, sr, p, rng) {
    const sc = makeScene(bed, seconds, sr, p, rng, { send: 0.25, airHz: 15000, airM: 25, roomR: 30 })
    if (!sc.n) return emptyBed(sc.sr)
    const q = sc.q
    const r = sc.rng
    const busy = q.intensity / 100
    roomTone(sc, r.fork('vent'), { db: -44, color: [['lowpass', 900, 0.7], ['peak', 150, 1, 5]], rumbleDb: -42, rumbleHz: 70, hum: [[60, -62], [120, -64]], drift: 0.35, corr: 0.3 })
    crowd(sc, r.fork('waiting'), { groups: 1 + Math.round(busy * 8), size: [1, 3], dist: [2.5, 30], effort: 0.35 + busy * 0.15, react: 0.3, silence: 0.15 })
    const wk = r.fork('walk')
    for (const t of poisson(wk, 0.05 + busy * 0.25, -4, sc.dur)) {
      walker(sc, wk.fork('w' + Math.round(t * 1000)), { t, surface: 'concrete', shoe: ['hard', 'heel', 'soft'][pickW(wk, [5, 2, 3])], closest: logRange(wk, 1.2, 12), gain: 0.5, squeak: 0.05 })
    }
    // an escalator far down the platform: motor hum and the steps' tick
    const es = r.fork('escalator')
    const ePan = es.range(-0.8, 0.8)
    const tick = thump(sc.sr, es, 180, 0.01, { noise: 0.5, noiseHz: 2000 })
    for (let t = es.range(0, 0.5); t < sc.dur; t += 0.45 + es.gauss() * 0.004) emit(sc, tick, t * sc.sr, ePan, 25, 0.4, 0.8)
    // other lines through the walls
    const fl = r.fork('far lines')
    for (const t of poisson(fl, 0.025, -10, sc.dur)) farLine(sc, fl.fork('l' + Math.round(t * 100)), t)
    // trains on this platform's two tracks
    const tr = r.fork('trains')
    if (q.trains > 0) {
      const period = 240 - (q.trains / 100) * 190
      for (let track = 0; track < 2; track++) {
        const tt = tr.fork('track' + track)
        const dwell = () => tt.range(16, 26)
        let tstop
        if (track === 0) {
          // make sure a short take hears this train arrive or leave
          if (tt.chance(0.6)) tstop = tt.range(sc.dur * 0.35, Math.max(sc.dur * 0.35 + 0.5, sc.dur * 0.9))
          else tstop = tt.range(1.5, Math.max(2, sc.dur * 0.6)) - 20
        } else {
          tstop = tt.range(-period, period) + sc.dur * 0.5
        }
        let guard = 0
        while (tstop < sc.dur + 40 && guard++ < 200) {
          const dw = dwell()
          train(sc, tt.fork('t' + Math.round(tstop * 10)), {
            tstop,
            dwell: dw,
            dir: track === 0 ? 1 : -1,
            track: q.distance + (track === 0 ? 0 : 4.5),
            gain: track === 0 ? 1 : 0.8,
            squeal: q.squeal / 100,
            chimeHi: tt.pick([659, 698, 784]),
            chimeLo: tt.pick([523, 554, 587]),
          })
          tstop += dw + period * tt.range(0.7, 1.3)
        }
      }
    }
    // station announcements
    const an = r.fork('announce')
    for (const t of poisson(an, (q.announcements / 100) * 0.03, -6, sc.dur)) {
      announce(sc, an.fork('a' + Math.round(t * 100)), t, {
        speakers: [[-0.7, 6], [0.2, 14], [0.8, 28], [-0.3, 40]],
        chime: an.chance(0.6) ? [[523, 0], [659, 0.35], [784, 0.7]] : null,
        phrases: 2 + an.int(3),
        gain: 0.5,
        send: 1.6,
        drive: 2.5,
      })
    }
    return finish(sc, { size: 1.7, rt60: 2.2, rt60High: 1.1, rt60Low: 2.4, predelayMs: 14, wet: 1.0 }, -23 + (q.intensity - 50) * 0.05)
  },
}

export default bed
