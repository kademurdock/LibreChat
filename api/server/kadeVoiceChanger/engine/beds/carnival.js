// beds/carnival.js - Carnival at night: a band organ far off, crowd chatter, game bells, rides and distant screams.
//
// Techniques and their published sources:
// - The band organ: pipe-organ tones from additive harmonic tables (flue
//   and reed pipes are close to harmonic; Fletcher and Rossing, "The Physics
//   of Musical Instruments", 1998), with the gentle tremolo of the organ's
//   wind, playing a generated waltz: a bass note on one and chords on two
//   and three under a melody that leans on chord tones and steps between
//   them, over a common sixteen-bar progression. It sits on the carousel, so
//   it swings slowly nearer and farther as the carousel turns.
// - Rides: a coaster's lift chain clanks up (the anti-rollback ratchet at a
//   few clicks a second), then the train roars down and around, heard with
//   its true travel time (Doppler included, Smith and others 2002), while its
//   riders shout long rising vowels (laughter-free); a generator hums.
// - Games: the strength tester's hammer and bell, balloons popping at the
//   dart stand, a race game's bell and buzzer, glass bottles at the ring
//   toss, a barker through a small megaphone, popcorn popping (modal hits and
//   noise bursts from the places kit).
// - Outdoors among tents and rides: short reflections and a light wash.

import {
  makeScene, emptyBed, finish, roomTone, emit, emitPath, emitMoving, crowd, makeTalker, speech, reactFrames,
  voiceAtRate, walker, poisson, logRange, pickW, clamp, filt, strike, thump, noiseBurst, modal, buf, addAt,
  trim, harmonicTable, bandTable, paColor, TAU, lp1,
} from './cafe.js'
import { electricBell } from './school-hall.js'
import { motorHum } from './factory.js'

const MAJ = [0, 2, 4, 5, 7, 9, 11]
// sixteen bars of a waltz in scale degrees of the chord root (0 = I, 3 = IV, 4 = V)
const FORM = [0, 0, 4, 4, 4, 4, 0, 0, 0, 0, 3, 3, 0, 4, 0, 0]
const PIPE = harmonicTable([[1, 1], [2, 0.55], [3, 0.4], [4, 0.22], [5, 0.16], [6, 0.1], [7, 0.06], [8, 0.04]])
const FLUTE = harmonicTable([[1, 1], [2, 0.25], [3, 0.08], [4, 0.03]])

function mhz(m) {
  return 440 * Math.pow(2, (m - 69) / 12)
}

/** Add a pipe note: table oscillator with wind tremolo, soft attack and release. */
function pipe(out, sr, t, dur, hz, amp, tableIn) {
  const table = bandTable(tableIn, hz * 1.003, sr)
  const off = Math.round(t * sr)
  const n = Math.round(dur * sr)
  const att = Math.round(0.02 * sr)
  const rel = Math.round(0.05 * sr)
  let ph = 0
  const inc = hz / sr
  // the wind's tremolo as a rotating phasor (no sine call per sample)
  const w = (TAU * 6.2) / sr
  const cr = Math.cos(w)
  const sn = Math.sin(w)
  let tc = 1
  let ts = 0
  for (let i = 0; i < n + rel; i++) {
    const nc = tc * cr - ts * sn
    ts = ts * cr + tc * sn
    tc = nc
    const j = off + i
    if (j < 0) continue
    if (j >= out.length) break
    const x = ph * 2048
    const i0 = x | 0
    const v = table[i0] + (table[i0 + 1] - table[i0]) * (x - i0)
    ph += inc * (1 + 0.002 * ts)
    if (ph >= 1) ph -= 1
    const e = i < att ? i / att : i < n ? 1 : 1 - (i - n) / rel
    out[j] += v * e * amp * (1 + 0.06 * ts)
  }
}

/** The band organ playing waltzes for dur seconds. */
function bandOrgan(sr, rng, dur) {
  const out = buf(sr, dur + 1)
  let t = -rng.range(0, 6)
  while (t < dur) {
    const key = 53 + rng.pick([0, 2, 5, 7, 10])
    const beat = 60 / rng.range(150, 185)
    const deg = (d) => key + 12 * Math.floor(d / 7) + MAJ[((d % 7) + 7) % 7]
    let mel = 7 + 2
    const reps = 1 + rng.int(2)
    for (let rp = 0; rp < reps; rp++) {
      for (let b = 0; b < FORM.length && t < dur; b++) {
        const root = FORM[b]
        const seventh = root === 4 && b % 2 === 1
        // oom
        if (t + 3 * beat > 0) pipe(out, sr, t, beat * 0.9, mhz(deg(root) - 12), 0.32, PIPE)
        // pah pah
        for (let k = 1; k < 3; k++) {
          for (const c of [2, 4, seventh ? 6 : 7]) pipe(out, sr, t + k * beat, beat * 0.6, mhz(deg(root + c)), 0.07, PIPE)
        }
        // bass drum on one, a cymbal tap on two now and then
        if (rng.chance(0.8)) addAt(out, thump(sr, rng, 65, 0.07, { noise: 0.4, noiseHz: 400 }), Math.round(t * sr), 0.25)
        if (rng.chance(0.4)) addAt(out, noiseBurst(sr, rng, 0.2, { att: 0.001, dec: 0.05, hz: 7000, q: 0.6 }), Math.round((t + beat) * sr), 0.06)
        // melody: three beats as half+quarter, three quarters, or a dotted half
        const rhythm = rng.pick([[2, 1], [1, 1, 1], [3], [2, 1], [1, 2]])
        let tb = t
        for (let k = 0; k < rhythm.length; k++) {
          if (k === 0) {
            const tones = [root + 7, root + 9, root + 11, root + 14].filter((d) => Math.abs(d - mel) <= 4)
            mel = tones.length ? rng.pick(tones) : root + 9
          } else mel += rng.pick([-2, -1, 1, 1, 2])
          mel = clamp(mel, 6, 16)
          pipe(out, sr, tb, rhythm[k] * beat * 0.92, mhz(deg(mel) + 12), 0.2, rng.chance(0.3) ? FLUTE : PIPE)
          tb += rhythm[k] * beat
        }
        t += 3 * beat
      }
    }
    t += rng.range(2, 6)
  }
  filt(out, sr, [['highpass', 70, 0.7], ['peak', 1200, 0.8, 2]])
  return out
}

/** A coaster ride: the lift chain, the drop and the riders. */
function coaster(sc, rng, t, amount) {
  const sr = sc.sr
  const pan0 = rng.range(-0.9, 0.9)
  const d0 = rng.range(60, 110)
  const lift = rng.range(10, 18)
  // lift chain: ratchet clanks
  const clank = trim(strike(sr, rng, 'metal', { size: 1.5, hard: 4000, tick: 0.8, maxSec: 0.4 }))
  for (let tt = 0; tt < lift; tt += 1 / rng.range(4, 6)) emit(sc, clank, (t + tt) * sr, pan0, d0, 1.2 * amount)
  emit(sc, motorHum(sr, rng, lift, { rot: 20, rough: 0.5 }), t * sr, pan0, d0, 0.5 * amount)
  // the run: wheels roaring on steel, moving fast along the track
  const runT = t + lift
  const run = rng.range(8, 14)
  const roar = noiseBurst(sr, rng, run, { att: 0.6, dec: 1e6, hz: 450, q: 0.5, rel: 1.5 })
  for (let tt = 0; tt < run; tt += rng.range(0.04, 0.12)) addAt(roar, noiseBurst(sr, rng, 0.02, { att: 0.0005, dec: 0.004, hz: 1500, q: 1 }), tt * sr, 0.3)
  // riders: a crowd of long rising shouts, loudest on the first drop
  const riders = 10 + rng.int(14)
  for (let k = 0; k < riders; k++) {
    const T = makeTalker(rng, rng.pick(['teen', 'adult', 'child']), { effort: 1, expr: 1 })
    const f = []
    reactFrames(T, rng, f, 0, 'cheer', { effort: 1, level: 1, dur: rng.range(1.2, 2.6) })
    const v = voiceAtRate(sc, T, f)
    addAt(roar, v, Math.round(rng.range(0.4, 1.2) * sr), 1.6 * T.gain)
    if (rng.chance(0.5)) {
      const f2 = []
      reactFrames(T, rng, f2, 0, 'cheer', { effort: 1, level: 1, dur: rng.range(0.8, 1.6) })
      addAt(roar, voiceAtRate(sc, T, f2), Math.round(rng.range(4, Math.max(4.5, run - 2)) * sr), 1.2 * T.gain)
    }
  }
  const speed = rng.range(18, 26)
  const dir = rng.chance(0.5) ? 1 : -1
  const x0 = Math.sin(pan0) * d0
  const pos = (te, p) => {
    const u = te - runT
    p.x = x0 + dir * speed * u * 0.7
    p.y = d0 * Math.cos(pan0) + 20 * Math.sin(u * 0.6)
  }
  emitMoving(sc, roar, runT, pos, 1.6 * amount, 1)
}

/** A barker calling out through a little megaphone. */
function barker(sc, rng, t, pan, d) {
  const T = makeTalker(rng, 'adult', { effort: 0.85, rate: 5, expr: 0.9 })
  const sig = paColor(voiceAtRate(sc, T, speech(T, rng, 1 + rng.int(3), { effort: 0.85, pause: [0.2, 0.5] }).fr), sc.sr, { lo: 500, hi: 3500, drive: 3 })
  emit(sc, sig, t * sc.sr, pan, d, 1.5)
}

const bed = {
  id: 'carnival',
  name: 'Carnival',
  group: 'places',
  about: 'A fairground at night: a band organ playing far off, crowd chatter, game bells, rides rumbling and distant screams.',
  params: [
    { id: 'intensity', name: 'How busy', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [30, 95] },
    { id: 'music', name: 'Band organ', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'rides', name: 'Rides', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'games', name: 'Games', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
  ],
  generate(seconds, sr, p, rng) {
    const sc = makeScene(bed, seconds, sr, p, rng, { send: 0.12, airHz: 18000, airM: 50, roomR: 20 })
    if (!sc.n) return emptyBed(sc.sr)
    const q = sc.q
    const r = sc.rng
    const busy = q.intensity / 100
    roomTone(sc, r.fork('night'), { db: -50, color: [['lowpass', 700, 0.7]], rumbleDb: -52, rumbleHz: 80, drift: 0.4, corr: 0.15 })
    // a generator droning behind the tents
    const gn = r.fork('generator')
    emit(sc, motorHum(sc.sr, gn, sc.dur + 0.5, { rot: gn.range(28, 31), rotLevel: 1, rough: 0.6, whine: gn.range(700, 900), whineLevel: 0.03 }), 0, gn.range(-0.9, 0.9), gn.range(25, 45), 0.8)
    // the band organ on the carousel
    if (q.music > 0) {
      const og = r.fork('organ')
      const sig = bandOrgan(sc.sr, og, sc.dur + 1)
      const pan0 = og.range(-0.7, 0.7)
      const d0 = og.range(30, 55)
      const turn = og.range(0.05, 0.09)
      emitPath(sc, sig, 0, (t, pos) => {
        pos.pan = pan0 + 0.08 * Math.sin(TAU * turn * t)
        pos.dist = d0 * (1 + 0.18 * Math.sin(TAU * turn * t + 1))
      }, 7 * (q.music / 100) + 1, 0.8)
    }
    // the crowd on the midway
    crowd(sc, r.fork('people'), { groups: 2 + Math.round(busy * 9), size: [2, 4], dist: [2, 20], kinds: { man: 1, woman: 1, child: 0.8, teen: 0.6 }, effort: 0.5 + busy * 0.15, react: 0.55, silence: 0.08, expr: 0.7 })
    crowd(sc, r.fork('far'), { groups: Math.round(busy * 6), size: [2, 4], dist: [20, 45], effort: 0.55 })
    const wk = r.fork('walk')
    for (const t of poisson(wk, 0.08 + busy * 0.3, -4, sc.dur)) {
      walker(sc, wk.fork('w' + Math.round(t * 1000)), { t, surface: 'gravel', shoe: 'hard', closest: logRange(wk, 1, 7), gain: 0.35 })
    }
    // rides
    const rd = r.fork('rides')
    const ra = q.rides / 100
    if (ra > 0) {
      const ts = poisson(rd, ra * 0.025, -25, sc.dur)
      if (!ts.length && sc.dur < 90 && rd.chance(0.5 + ra * 0.5)) ts.push(rd.range(-14, Math.max(-13, sc.dur * 0.5 - 12)))
      for (const t of ts) coaster(sc, rd.fork('c' + Math.round(t * 100)), t, 0.5 + ra)
      // a spinning ride's motor rising and falling, and its bell
      for (const t of poisson(rd, ra * 0.02, -30, sc.dur)) {
        const dur = rd.range(25, 45)
        const pan = rd.range(-0.9, 0.9)
        const d = rd.range(30, 60)
        const hum = motorHum(sc.sr, rd, dur, { harm: [[1, 0.2], [2, 0.4]], rot: rd.range(8, 14), rotLevel: 1, whine: rd.range(500, 800), whineLevel: 0.4, rough: 0.5 })
        for (let i = 0; i < hum.length; i++) {
          const u = i / hum.length
          hum[i] *= Math.min(1, u * 6) * Math.min(1, (1 - u) * 6)
        }
        emit(sc, hum, t * sc.sr, pan, d, 1.2 * ra)
        emit(sc, electricBell(sc.sr, rd, 1.5, { hz: 1100 }), t * sc.sr, pan, d, 0.8)
      }
    }
    // games
    const gm = r.fork('games')
    const ga = q.games / 100
    const stand = [gm.range(-0.9, 0.9), gm.range(6, 15)]
    for (const t of poisson(gm, ga * (0.04 + busy * 0.08), -2, sc.dur)) {
      const k = pickW(gm, [1.5, 2, 1, 1.5, 1])
      const pan = gm.range(-0.95, 0.95)
      const d = logRange(gm, 5, 30)
      if (k === 0) {
        // strength tester: thump, then maybe the bell
        emit(sc, thump(sc.sr, gm, 70, 0.06, { noise: 0.7, noiseHz: 700 }), t * sc.sr, pan, d, 2)
        if (gm.chance(0.5)) emit(sc, strike(sc.sr, gm, 'bell', { size: 2.2, hard: 8000, tick: 0.5, maxSec: 3 }), (t + 0.35) * sc.sr, pan, d, 1.2)
      } else if (k === 1) {
        // balloons popping at the dart stand
        const n = 1 + gm.int(3)
        for (let j = 0; j < n; j++) {
          const pop = noiseBurst(sc.sr, gm, 0.05, { att: 0.0002, dec: 0.006, hz: 2500, q: 0.4 })
          addAt(pop, thump(sc.sr, gm, 120, 0.01, { noise: 0 }), 0, 0.6)
          emit(sc, pop, (t + j * gm.range(0.8, 2)) * sc.sr, stand[0], stand[1], 1.4)
        }
      } else if (k === 2) {
        // the race game: a bell for the winner, a buzzer for the rest
        emit(sc, electricBell(sc.sr, gm, gm.range(1, 2), { hz: gm.range(1200, 1500) }), t * sc.sr, pan, d, 0.8)
        const bz = buf(sc.sr, 1)
        let ph = 0
        for (let i = 0; i < 0.8 * sc.sr; i++) {
          ph += 210 / sc.sr
          bz[i] = (ph % 1 < 0.5 ? 0.3 : -0.3) * Math.min(1, i / 200)
        }
        lp1(bz, sc.sr, 3000)
        emit(sc, bz, (t + 1.8) * sc.sr, pan, d, 0.6)
      } else if (k === 3) {
        // ring toss: rings clinking on glass bottles
        const n = 2 + gm.int(4)
        for (let j = 0; j < n; j++) emit(sc, strike(sc.sr, gm, 'bottle', { hard: 8000, tick: 0.6 }), (t + j * gm.range(0.6, 1.5)) * sc.sr, pan, d, 0.5)
      } else barker(sc, gm, t, pan, d * 0.5)
    }
    // popcorn at the food stand
    const pc = r.fork('popcorn')
    if (busy > 0.15) {
      const pan = pc.range(-0.9, 0.9)
      const d = pc.range(5, 12)
      for (const t of poisson(pc, 8 + busy * 10, 0, sc.dur)) {
        const pop = noiseBurst(sc.sr, pc, 0.02, { att: 0.0003, dec: 0.003, hz: pc.range(800, 2000), q: 1 })
        emit(sc, pop, t * sc.sr, pan, d, pc.range(0.05, 0.15), 0.6)
      }
    }
    const taps = [[22, 0.3, -0.7], [41, 0.25, 0.7], [73, 0.15, -0.3], [120, 0.08, 0.4]]
    return finish(sc, { size: 1.1, rt60: 0.6, rt60High: 0.3, predelayMs: 15, wet: 0.4, taps }, -23 + (q.intensity - 50) * 0.06)
  },
}

export default bed
