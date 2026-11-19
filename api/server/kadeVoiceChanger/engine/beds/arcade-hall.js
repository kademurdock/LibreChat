// beds/arcade-hall.js - Game arcade: machines bleeping and blasting, coins dropping, buttons mashed, kids.
//
// Techniques and their published sources:
// - Every cabinet runs its own little sound chip: pulse waves with a chosen
//   duty cycle, a triangle bass and a noise channel, the voice set of the
//   classic programmable sound generators of 1980s arcade and home
//   hardware. Pulses are band-limited with PolyBLEP corrections (Valimaki
//   and Huovilainen 2007, "Antialiasing oscillators in subtractive
//   synthesis") so high notes do not alias.
// - Music is generated, not stored: each machine picks a tempo, a key and a
//   scale, then writes bars of bass on the chord roots, a lead line walking
//   the scale and fast chord arpeggios, and plays them through its cabinet
//   speaker (a band-limited, slightly resonant box). Attract-mode tunes
//   come and go with new material, and while someone plays, game effects
//   fire: laser zaps (fast falling sweeps), explosions (noise with a
//   closing lowpass), jumps, collect chimes and power-up runs.
// - Coins, tokens and tickets are modal metal hits and rattles; the air
//   hockey table is a plastic puck clacking between strikers over the
//   table's blower; kids talk and react (places kit babble).
// - The hall: a big carpeted room with a low ceiling, a medium, damped
//   decay.

import {
  makeScene, emptyBed, finish, roomTone, emit, crowd, makeTalker, reactFrames, voiceAtRate, walker, poisson,
  rexp, logRange, clamp, filt, strike, thump, noiseBurst, buf, addAt, seed32, trim, hp1, lp1, sizedRoom, sizeSpread,
} from './cafe.js'

const MAJOR = [0, 2, 4, 5, 7, 9, 11]
const MINOR = [0, 2, 3, 5, 7, 8, 10]
const PROG_MAJ = [[0, 5, 3, 4], [0, 3, 4, 0], [0, 4, 5, 3], [5, 3, 0, 4]]
const PROG_MIN = [[0, 5, 6, 4], [0, 6, 5, 4], [0, 3, 4, 0], [0, 5, 3, 6]]

function midiHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12)
}

function blep(t, dt) {
  if (t < dt) {
    const x = t / dt
    return x + x - x * x - 1
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt
    return x * x + x + x + 1
  }
  return 0
}

/**
 * Add a chip voice note into out: wave 'pulse' (duty) or 'tri' or 'noise',
 * frequency glide from hz to hz2, decay time constant, at offset off.
 */
function chipNote(out, sr, off, len, hz, o) {
  const wave = o.wave || 'pulse'
  const duty = o.duty ?? 0.5
  const amp = o.amp ?? 0.3
  const hz2 = o.hz2 ?? hz
  const dec = o.dec ?? 0.25
  const sus = o.sus ?? 0.5
  const kd = Math.exp(-1 / (dec * sr))
  let ph = o.phase ?? 0
  let env = 1
  let s = o.seed | 0 || 0x2f6b
  let held = 0
  const n = Math.min(len, out.length - off)
  const relN = Math.min(n, Math.round(0.008 * sr))
  for (let i = 0; i < n; i++) {
    if (off + i < 0) continue
    const f = hz + ((hz2 - hz) * i) / n
    const dt = f / sr
    let y
    if (wave === 'pulse') {
      y = (ph < duty ? 1 : -1) + blep(ph, dt) - blep(ph - duty < 0 ? ph - duty + 1 : ph - duty, dt)
    } else if (wave === 'tri') {
      y = ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph
    } else {
      // noise channel: a new random level each period, like a shift-register noise
      if (ph + dt >= 1) {
        s ^= s << 13
        s ^= s >>> 17
        s ^= s << 5
        held = s / 2147483648
      }
      y = held
    }
    ph += dt
    if (ph >= 1) ph -= 1
    const a = Math.min(1, i / (0.002 * sr)) * (sus + (1 - sus) * env) * (i > n - relN ? (n - i) / relN : 1)
    env *= kd
    out[off + i] += y * a * amp
  }
}

/** A stretch of attract-mode music for one machine: returns a mono buffer. */
function tune(sr, rng, bars, M, from = 0, to = 1e9) {
  const beat = 60 / M.bpm
  const bar = beat * 4
  const out = buf(sr, Math.max(0.05, Math.min(bars * bar + 0.5, to) - from))
  const scale = M.minor ? MINOR : MAJOR
  const prog = rng.pick(M.minor ? PROG_MIN : PROG_MAJ)
  const deg = (d) => M.root + 12 * Math.floor(d / 7) + scale[((d % 7) + 7) % 7]
  let leadDeg = 7 + rng.int(5)
  for (let b = 0; b < bars; b++) {
    if ((b + 1) * bar < from - 0.5 || b * bar > to) continue
    const chord = prog[b % prog.length]
    const t0 = b * bar
    // bass: root and fifth in eighths or quarters
    const eighth = rng.chance(0.6)
    const steps = eighth ? 8 : 4
    for (let k = 0; k < steps; k++) {
      const d = chord + (k % 2 && rng.chance(0.6) ? 4 : 0)
      const m = deg(d) - 12
      const len = Math.round(((bar / steps) * 0.85) * sr)
      chipNote(out, sr, Math.round((t0 + (k * bar) / steps - from) * sr), len, midiHz(m), { wave: 'tri', amp: 0.35, dec: 1, sus: 1 })
    }
    // lead: a walk over the scale with held notes and leaps to chord tones
    let t = t0
    while (t < t0 + bar - 1e-6) {
      const dur = beat * rng.pick([0.25, 0.5, 0.5, 0.5, 1, 1, 1.5])
      if (rng.chance(0.85)) {
        if (rng.chance(0.3)) leadDeg = chord + 7 + rng.pick([0, 2, 4])
        else leadDeg += rng.pick([-2, -1, -1, 1, 1, 2])
        leadDeg = clamp(leadDeg, 3, 15)
        chipNote(out, sr, Math.round((t - from) * sr), Math.round(dur * 0.9 * sr), midiHz(deg(leadDeg) + 12), { wave: 'pulse', duty: M.duty, amp: 0.22, dec: 0.3, sus: 0.45 })
      }
      t += dur
    }
    // chord arpeggio on the beat, very fast, the chip way of playing chords
    if (M.arp) {
      for (let k = 0; k < 4; k++) {
        const tb = t0 + k * beat
        for (let a = 0; a < 6; a++) {
          const m = deg(chord + [0, 2, 4][a % 3]) + 12
          chipNote(out, sr, Math.round((tb + a * 0.025 - from) * sr), Math.round(0.025 * sr), midiHz(m), { wave: 'pulse', duty: 0.25, amp: 0.08, dec: 1, sus: 1 })
        }
      }
    }
    // drums on the noise channel
    for (let k = 0; k < 8; k++) {
      const tk = t0 + (k * bar) / 8
      if (k % 4 === 0) chipNote(out, sr, Math.round((tk - from) * sr), Math.round(0.12 * sr), 3000, { wave: 'noise', hz2: 600, amp: 0.25, dec: 0.04, sus: 0, seed: seed32(rng) })
      else if (k % 2 === 0) chipNote(out, sr, Math.round((tk - from) * sr), Math.round(0.1 * sr), 9000, { wave: 'noise', amp: 0.18, dec: 0.03, sus: 0, seed: seed32(rng) })
      else if (rng.chance(0.5)) chipNote(out, sr, Math.round((tk - from) * sr), Math.round(0.04 * sr), 14000, { wave: 'noise', amp: 0.08, dec: 0.01, sus: 0, seed: seed32(rng) })
    }
  }
  return out
}

/** One game effect. */
function sfx(sr, rng, kind) {
  const out = buf(sr, 1.2)
  switch (kind) {
    case 'laser':
      chipNote(out, sr, 0, Math.round(rng.range(0.08, 0.2) * sr), rng.range(1200, 2400), { hz2: rng.range(150, 400), duty: 0.25, amp: 0.35, dec: 0.1, sus: 0.2 })
      break
    case 'boom':
      chipNote(out, sr, 0, Math.round(rng.range(0.4, 0.9) * sr), rng.range(2000, 4000), { wave: 'noise', hz2: 150, amp: 0.5, dec: 0.25, sus: 0, seed: seed32(rng) })
      break
    case 'jump':
      chipNote(out, sr, 0, Math.round(0.14 * sr), rng.range(250, 400), { hz2: rng.range(800, 1300), duty: 0.5, amp: 0.3, dec: 0.2, sus: 0.5 })
      break
    case 'collect': {
      const f = rng.range(900, 1300)
      chipNote(out, sr, 0, Math.round(0.07 * sr), f, { duty: 0.5, amp: 0.3, dec: 1, sus: 1 })
      chipNote(out, sr, Math.round(0.07 * sr), Math.round(0.25 * sr), f * 1.335, { duty: 0.5, amp: 0.3, dec: 0.12, sus: 0.3 })
      break
    }
    default: {
      // power-up: a fast rising run
      const f = rng.range(300, 500)
      for (let k = 0; k < 10; k++) chipNote(out, sr, Math.round(k * 0.035 * sr), Math.round(0.035 * sr), f * Math.pow(2, k / 5), { duty: 0.125, amp: 0.25, dec: 1, sus: 1 })
    }
  }
  return trim(out)
}

/** Colour of a cabinet's speaker. */
function cabinet(sig, sr, rng) {
  return filt(sig, sr, [['highpass', rng.range(150, 260), 0.7], ['lowpass', rng.range(4500, 7000), 0.7], ['peak', rng.range(900, 2400), 2, rng.range(3, 6)]])
}

/** The same speaker, cheaply, for the many short effects (two one-pole filters). */
function cabinetFast(sig, sr, rng) {
  hp1(sig, sr, rng.range(180, 300))
  return lp1(sig, sr, rng.range(4000, 6000))
}

/** A machine: attract tunes between plays, effects while someone plays. */
function machine(sc, rng, pan, d, gain) {
  const sr = sc.sr
  const M = { bpm: rng.range(108, 168), root: 52 + rng.int(12), minor: rng.chance(0.45), duty: rng.pick([0.125, 0.25, 0.5]), arp: rng.chance(0.5) }
  let t = -rng.range(0, 20)
  let guard = 0
  while (t < sc.dur && guard++ < 200) {
    if (rng.chance(0.55)) {
      const bars = 4 + rng.int(9)
      const len = (bars * 4 * 60) / M.bpm
      if (t + len > -0.5) {
        const from = Math.max(0, -0.5 - t)
        const m = cabinet(tune(sr, rng, bars, M, from, sc.dur + 0.5 - t), sr, rng)
        emit(sc, m, (t + from) * sr, pan, d, gain * 0.5)
      }
      t += len + rng.range(1, 6)
      if (rng.chance(0.3)) M.root = 52 + rng.int(12)
    } else {
      // someone playing: effects at a busy rate
      const len = rng.range(6, 25)
      const kinds = rng.pick([['laser', 'boom', 'laser', 'power'], ['jump', 'collect', 'collect', 'power'], ['laser', 'laser', 'boom', 'collect']])
      for (let tt = t + rexp(rng, 0.4); tt < t + len; tt += rexp(rng, 0.45)) {
        if (tt < -1 || tt > sc.dur) continue
        emit(sc, cabinetFast(sfx(sr, rng, rng.pick(kinds)), sr, rng), tt * sr, pan, d, gain * 0.55)
        // the player's buttons
        if (rng.chance(0.4)) emit(sc, button(sr, rng), (tt - 0.01) * sr, pan, Math.max(0.8, d - 0.6), gain * 0.25)
      }
      t += len + rng.range(1, 5)
    }
  }
}

function button(sr, rng) {
  const out = buf(sr, 0.05)
  addAt(out, thump(sr, rng, rng.range(300, 600), 0.004, { noise: 0.8, noiseHz: 2500 }), 0, 1)
  return trim(out)
}

/** Coins: one into a slot, or a handful of tokens into a cup. */
function coins(sc, rng, t, pan, d) {
  const sr = sc.sr
  if (rng.chance(0.6)) {
    emit(sc, strike(sr, rng, 'coin', { hard: 9000, tick: 0.5, maxSec: 0.6 }), t * sr, pan, d, 0.2)
    let tt = t + 0.05
    for (let k = 0; k < 4 + rng.int(4); k++) {
      emit(sc, strike(sr, rng, 'coin', { size: 1.2, hard: 7000, tick: 0.3, maxSec: 0.25 }), tt * sr, pan, d, 0.08 * Math.pow(0.75, k))
      tt += rng.range(0.03, 0.08)
    }
    emit(sc, thump(sr, rng, 220, 0.02, { noise: 0.6, noiseHz: 2000 }), (tt + 0.05) * sr, pan, d, 0.25)
  } else {
    const n = 6 + rng.int(15)
    let tt = t
    for (let k = 0; k < n; k++) {
      emit(sc, strike(sr, rng, 'coin', { hard: 9000, tick: 0.4, maxSec: 0.5 }), tt * sr, pan, d, rng.range(0.06, 0.15))
      tt += rng.range(0.04, 0.11)
    }
  }
}

/** An air hockey game: clacks back and forth over the blower. */
function airHockey(sc, rng, t, pan, d) {
  const sr = sc.sr
  const len = rng.range(10, 30)
  const h0 = Math.max(t, 0)
  const h1 = Math.min(t + len, sc.dur + 0.5)
  if (h1 - h0 > 0.2) {
    const hiss = noiseBurst(sr, rng, h1 - h0, { att: h0 === t ? 0.3 : 0.001, dec: 1e6, hz: 3000, q: 0.4, rel: 0.3 })
    emit(sc, hiss, h0 * sr, pan, d, 0.12)
  }
  let tt = t
  let side = 1
  while (tt < t + len && tt < sc.dur) {
    const clack = buf(sr, 0.1)
    addAt(clack, strike(sr, rng, 'plastic', { size: 0.6, hard: 9000, tick: 1.2 }), 0, 1)
    addAt(clack, thump(sr, rng, 180, 0.015, { noise: 0.4 }), 0, 0.6)
    emit(sc, trim(clack), tt * sr, clamp(pan + side * 0.12, -1, 1), d, rng.range(0.3, 0.6))
    if (rng.chance(0.3)) emit(sc, trim(strike(sr, rng, 'plastic', { size: 0.8, hard: 7000, tick: 1 })), (tt + rng.range(0.05, 0.15)) * sr, pan, d, 0.2)
    tt += rng.range(0.25, 0.8)
    side = -side
    if (rng.chance(0.08)) {
      // a goal: puck drops, a buzzer
      emit(sc, thump(sr, rng, 150, 0.04, { noise: 0.6 }), tt * sr, pan, d, 0.5)
      const bz = buf(sr, 0.7)
      chipNote(bz, sr, 0, Math.round(0.6 * sr), rng.range(180, 240), { duty: 0.4, amp: 0.4, dec: 1, sus: 1 })
      emit(sc, cabinet(bz, sr, rng), (tt + 0.2) * sr, pan, d, 0.5)
      tt += rng.range(2, 4)
    }
  }
}

const bed = {
  id: 'arcade-hall',
  name: 'Game arcade',
  group: 'places',
  about: 'A busy game arcade: machines bleeping and blasting, coins dropping, buttons mashed, and kids chattering.',
  params: [
    { id: 'intensity', name: 'How busy', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [30, 95] },
    { id: 'size', name: 'Hall size', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'machines', name: 'Machines', type: 'number', min: 2, max: 20, step: 1, def: 10, unit: 'count', noun: ['machine', 'machines'], rand: [5, 16] },
    { id: 'coins', name: 'Coins and tickets', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 80] },
    { id: 'crowd', name: 'Kids talking', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 80] },
  ],
  generate(seconds, sr, p, rng) {
    const sc = makeScene(bed, seconds, sr, p, rng, { send: 0.3, airHz: 15000, airM: 10, roomR: 15 })
    if (!sc.n) return emptyBed(sc.sr)
    const q = sc.q
    const sp = sizeSpread(q.size / 100)
    const r = sc.rng
    const busy = q.intensity / 100
    roomTone(sc, r.fork('air'), { db: -50, color: [['lowpass', 1200, 0.7]], hum: [[60, -66], [120, -66]], buzzDb: -66, drift: 0.2 })
    const mr = r.fork('machines')
    for (let m = 0; m < q.machines; m++) {
      const mk = mr.fork('m' + m)
      const d = m < 2 ? mk.range(1.5, 3.5) : logRange(mk, 2.5, 16)
      machine(sc, mk, mk.range(-0.95, 0.95), d, 1)
    }
    const k = q.crowd / 100
    if (k > 0) {
      crowd(sc, r.fork('kids'), { groups: Math.round(1 + k * (2 + busy * 6)), size: [2, 3], dist: [2 * sp, 14 * sp], kinds: { teen: 2, child: 2, man: 0.5, woman: 0.5 }, effort: 0.6 + busy * 0.2, rate: 5.4, expr: 0.8, react: 0.7, silence: 0.08 })
      const rx = r.fork('reactions')
      for (const t of poisson(rx, k * (0.05 + busy * 0.15), -1, sc.dur)) {
        const T = makeTalker(rx, rx.chance(0.5) ? 'teen' : 'child', { effort: 0.9, expr: 0.9 })
        const f = []
        reactFrames(T, rx, f, 0, rx.pick(['yeah', 'oh', 'wow', 'hey', 'aw', 'cheer']), { effort: 0.95, level: 1, dur: rx.range(0.4, 0.9) })
        emit(sc, voiceAtRate(sc, T, f), t * sc.sr, rx.range(-0.95, 0.95), logRange(rx, 2, 12), 1.3)
      }
    }
    const cn = r.fork('coins')
    for (const t of poisson(cn, (q.coins / 100) * (0.1 + busy * 0.3), -1, sc.dur)) coins(sc, cn.fork('c' + Math.round(t * 1000)), t, cn.range(-0.95, 0.95), logRange(cn, 1.5, 12))
    // ticket dispensers chattering out a win
    for (const t of poisson(cn, (q.coins / 100) * (0.02 + busy * 0.05), -1, sc.dur)) {
      const pan = cn.range(-0.95, 0.95)
      const d = logRange(cn, 2, 10)
      const n = 5 + cn.int(30)
      const tick = trim(thump(sc.sr, cn, 500, 0.004, { noise: 0.9, noiseHz: 3000 }))
      for (let i = 0; i < n; i++) emit(sc, tick, (t + i * 0.09) * sc.sr, pan, d, 0.3)
    }
    // air hockey
    const ah = r.fork('hockey')
    if (busy > 0.2) {
      for (const t of poisson(ah, 0.02 + busy * 0.03, -20, sc.dur)) airHockey(sc, ah.fork('h' + Math.round(t * 100)), t, ah.range(-0.9, 0.9), logRange(ah, 3, 9))
    }
    const wk = r.fork('walk')
    for (const t of poisson(wk, 0.05 + busy * 0.15, -4, sc.dur)) {
      walker(sc, wk.fork('w' + Math.round(t * 1000)), { t, surface: 'carpet', shoe: 'soft', closest: logRange(wk, 1.2, 6), gain: 0.4 })
    }
    return finish(sc, sizedRoom({ size: 1.1, rt60: 0.85, rt60High: 0.4, predelayMs: 8, wet: 0.8 }, q.size / 100), -23 + (q.intensity - 50) * 0.06)
  },
}

export default bed
