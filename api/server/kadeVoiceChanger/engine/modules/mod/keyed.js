// modules/mod/keyed.js - Keyed by your voice: another sound that plays only
// while you talk, dips under you, or swells with you.
//
// Technique: sidechain keying, the studio trick of letting one signal's level
// drive a gain on another (Giannoulis, Massberg and Reiss, "Digital Dynamic
// Range Compressor Design - A Tutorial and Analysis", JAES 2012, on the
// sidechain and level detection; the broadcaster's "ducking" of music under
// an announcer is the same idea turned upside down). The voice is the key:
// - a fast peak follower (2 ms attack, 40 ms release) measures it;
// - "Plays while you talk" opens a gate with hysteresis (6 dB) and a 120 ms
//   hold, so the sound does not flutter between syllables;
// - "Dips under you" closes when you talk and comes back in the pauses;
// - "Swells with you" follows your loudness continuously (a word 12 dB
//   softer leaves the sound about 9 dB softer); sensitivity lets a quieter
//   voice reach full level.
// The attack setting is how fast the sound answers when you start talking and
// the release how fast it lets go when you stop; depth is how far it falls.
// Sensitivity counts down in decibels from the take's own loud level
// (measured first offline; followed adaptively live), so quiet and loud
// recordings key the same way, and the other sound is set to sit at the
// chosen level relative to the voice's own speaking loudness.
//
// The other sound is either the person's own (CONTRACT "side" input: a
// second recording, a song, a sound from the library) or one of five built-in
// sources synthesised here so they are ours to ship:
// - Warm pad: an open D chord of band-limited sawtooth pairs (polyBLEP,
//   Valimaki and Huovilainen 2007), detuned left and right, through a slowly
//   breathing state-variable low pass, with a soft sine sub.
// - Rain: two decorrelated hiss bands, dense random patter ticks and the
//   occasional ringing drop (damped sine), with slow gusts.
// - Crowd murmur: ten synthetic talkers, each a buzzy glottal source through
//   two moving formant band passes (vowel targets after Peterson and Barney
//   1952), in syllables and pauses of their own, with consonant hiss,
//   spread across the stereo field, which blurs into the babble of a room.
// - Idling engine: firing pulses at about 28 per second with uneven
//   cylinders and a wandering idle, ringing two low body resonances, plus an
//   exhaust puff of filtered noise on every firing.
// - Low drone: a dark A drone of sine and saw partials with slow beating and
//   a faint high shimmer.
// When "The other sound" is chosen but none was given, the warm pad plays
// instead and the module says so through ctx.note. Live mode cannot receive
// the other sound yet, so it plays the warm pad in its place.

import { makeRng } from '../../core/rng.js'
import { resampleTo } from '../../core/resample.js'

const TWO_PI = 2 * Math.PI
const SOURCES = ['side', 'pad', 'rain', 'crowd', 'engine', 'drone']
const MODES = ['gate', 'duck', 'follow']
// Peak-follower reference to speech RMS while talking, measured on real takes.
const RMS_PER_REF = 0.4
const NOMINAL_RMS = 0.1

function num(v, d) {
  return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : d
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

function forkOf(rng, label) {
  return rng && typeof rng.fork === 'function' ? rng.fork(label) : makeRng('mod.keyed.' + label)
}

const params = [
  {
    id: 'source', name: 'Sound', type: 'choice', def: 'side',
    options: [
      { v: 'side', name: 'The other sound' },
      { v: 'pad', name: 'Warm pad' },
      { v: 'rain', name: 'Rain' },
      { v: 'crowd', name: 'Crowd murmur' },
      { v: 'engine', name: 'Idling engine' },
      { v: 'drone', name: 'Low drone' },
    ],
  },
  {
    id: 'mode', name: 'How it follows you', type: 'choice', def: 'gate',
    options: [
      { v: 'gate', name: 'Plays while you talk' },
      { v: 'duck', name: 'Dips under you' },
      { v: 'follow', name: 'Swells with you' },
    ],
  },
  { id: 'attack', name: 'Attack', type: 'number', min: 1, max: 500, step: 1, def: 20, unit: 'ms', rand: [5, 80] },
  { id: 'release', name: 'Release', type: 'number', min: 10, max: 3000, step: 10, def: 300, unit: 'ms', rand: [120, 900] },
  { id: 'depth', name: 'Depth', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [70, 100] },
  { id: 'voice', name: 'Your voice', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [60, 100] },
  { id: 'level', name: 'Sound level', type: 'number', min: -30, max: 6, step: 1, def: -6, unit: 'db', rand: [-14, -2] },
  { id: 'sensitivity', name: 'Sensitivity', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [35, 70] },
]

// ---------------------------------------------------------------- small DSP pieces

function polyblep(t, dt) {
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

// Topology-preserving state-variable filter (Simper / Zavalishin). State in
// st[i], st[i + 1]; coefficients in cf[j..j+3] = a1, g a1, g^2 a1 and k = 1 / Q.
function svfSet(cf, j, sr, f, q) {
  let fr = f < 10 ? 10 : f > sr * 0.45 ? sr * 0.45 : f
  const g = Math.tan((Math.PI * fr) / sr)
  const k = 1 / q
  const a1 = 1 / (1 + g * (g + k))
  cf[j] = a1
  cf[j + 1] = g * a1
  cf[j + 2] = g * g * a1
  cf[j + 3] = k
}

function svfLp(st, i, cf, j, x) {
  const s1 = st[i]
  const s2 = st[i + 1]
  const v3 = x - s2
  const v1 = cf[j] * s1 + cf[j + 1] * v3
  const v2 = s2 + cf[j + 1] * s1 + cf[j + 2] * v3
  let n1 = 2 * v1 - s1
  let n2 = 2 * v2 - s2
  if (n1 < 1e-20 && n1 > -1e-20) n1 = 0
  if (n2 < 1e-20 && n2 > -1e-20) n2 = 0
  st[i] = n1
  st[i + 1] = n2
  return v2
}

/** Band pass with unity peak. */
function svfBp(st, i, cf, j, x) {
  const s1 = st[i]
  const s2 = st[i + 1]
  const v3 = x - s2
  const v1 = cf[j] * s1 + cf[j + 1] * v3
  const v2 = s2 + cf[j + 1] * s1 + cf[j + 2] * v3
  let n1 = 2 * v1 - s1
  let n2 = 2 * v2 - s2
  if (n1 < 1e-20 && n1 > -1e-20) n1 = 0
  if (n2 < 1e-20 && n2 > -1e-20) n2 = 0
  st[i] = n1
  st[i + 1] = n2
  return v1 * cf[j + 3]
}

function onePoleCoef(sr, f) {
  return 1 - Math.exp((-TWO_PI * Math.min(f, sr * 0.45)) / sr)
}

// ---------------------------------------------------------------- built-in sources
// Each source writes one stereo sample into this.l / this.r per next() call.

function makePad(sr, rng) {
  const F = [146.83, 220.0, 293.66, 329.63, 440.0]
  const N = F.length
  const pL = new Float64Array(N), pR = new Float64Array(N), iL = new Float64Array(N), iR = new Float64Array(N)
  for (let k = 0; k < N; k++) {
    const det = (4 + 2.5 * k) / 1200
    iL[k] = (F[k] * Math.pow(2, -det)) / sr
    iR[k] = (F[k] * Math.pow(2, det)) / sr
    pL[k] = rng.next()
    pR[k] = rng.next()
  }
  const subInc = 73.42 / sr
  const st = new Float64Array(4)
  const cf = new Float64Array(4)
  let sub = 0, ctl = 0, t = 0
  return {
    l: 0,
    r: 0,
    gain: 0.0714,
    next() {
      if (ctl === 0) {
        svfSet(cf, 0, sr, 1100 * (1 + 0.35 * Math.sin((TWO_PI * 0.06 * t) / sr)), 0.9)
        ctl = 32
      }
      ctl--
      t++
      let l = 0
      let r = 0
      for (let k = 0; k < N; k++) {
        let q = pL[k]
        l += 2 * q - 1 - polyblep(q, iL[k])
        q += iL[k]
        if (q >= 1) q -= 1
        pL[k] = q
        q = pR[k]
        r += 2 * q - 1 - polyblep(q, iR[k])
        q += iR[k]
        if (q >= 1) q -= 1
        pR[k] = q
      }
      const s = 0.9 * Math.sin(TWO_PI * sub)
      sub += subInc
      if (sub >= 1) sub -= 1
      this.l = svfLp(st, 0, cf, 0, l + s) * this.gain
      this.r = svfLp(st, 2, cf, 0, r + s) * this.gain
    },
  }
}

function makeDrone(sr, rng) {
  const F = [55, 82.41, 110, 164.81]
  const A = [1, 0.6, 0.7, 0.35]
  const N = F.length
  const pL = new Float64Array(N), pR = new Float64Array(N), iL = new Float64Array(N), iR = new Float64Array(N)
  for (let k = 0; k < N; k++) {
    const det = (2 + 1.5 * k) / 1200
    iL[k] = (F[k] * Math.pow(2, -det)) / sr
    iR[k] = (F[k] * Math.pow(2, det)) / sr
    pL[k] = rng.next()
    pR[k] = rng.next()
  }
  const st = new Float64Array(4)
  const cf = new Float64Array(4)
  let shim = 0, ctl = 0, t = 0
  const shimInc = 659.26 / sr
  return {
    l: 0,
    r: 0,
    gain: 0.211,
    next() {
      if (ctl === 0) {
        svfSet(cf, 0, sr, 520 * (1 + 0.25 * Math.sin((TWO_PI * 0.045 * t) / sr + 0.7)), 1.2)
        ctl = 32
      }
      ctl--
      t++
      let l = 0
      let r = 0
      for (let k = 0; k < N; k++) {
        let q = pL[k]
        l += A[k] * (0.7 * Math.sin(TWO_PI * q) + 0.45 * (2 * q - 1 - polyblep(q, iL[k])))
        q += iL[k]
        if (q >= 1) q -= 1
        pL[k] = q
        q = pR[k]
        r += A[k] * (0.7 * Math.sin(TWO_PI * q) + 0.45 * (2 * q - 1 - polyblep(q, iR[k])))
        q += iR[k]
        if (q >= 1) q -= 1
        pR[k] = q
      }
      const sv = 0.05 * Math.sin(TWO_PI * shim) * (0.6 + 0.4 * Math.sin((TWO_PI * 0.13 * t) / sr))
      shim += shimInc
      if (shim >= 1) shim -= 1
      this.l = (svfLp(st, 0, cf, 0, l) + sv) * this.gain
      this.r = (svfLp(st, 2, cf, 0, r) + sv * 0.8) * this.gain
    },
  }
}

function makeRain(sr, rng) {
  const D = 10
  const dAmp = new Float64Array(D), dDec = new Float64Array(D), dPh = new Float64Array(D), dInc = new Float64Array(D)
  const dL = new Float64Array(D), dR = new Float64Array(D)
  const cHp = onePoleCoef(sr, 600)
  const cLp = onePoleCoef(sr, 7000)
  const cTick = onePoleCoef(sr, 2500)
  const pRate = 900 / sr
  // ticks are single samples, so their loudness would fall as the rate rises
  const tickScale = 0.5 * Math.sqrt(sr / 48000)
  // the hiss band holds a smaller share of white noise at higher rates
  const hissScale = 0.32 * Math.sqrt(sr / 48000)
  const dRate = 7 / sr
  let hL = 0, hR = 0, lL = 0, lR = 0, tL = 0, tR = 0
  let ga = 0, gb = 0, gp = 0
  const gInc = 0.12 / sr
  return {
    l: 0,
    r: 0,
    gain: 0.876,
    next() {
      gp += gInc
      if (gp >= 1) {
        gp -= 1
        ga = gb
        gb = rng.next() * 2 - 1
      }
      const gust = 1 + 0.25 * (ga + (gb - ga) * (0.5 - 0.5 * Math.cos(Math.PI * gp)))
      // hiss bands
      const wl = rng.next() * 2 - 1
      const wr = rng.next() * 2 - 1
      hL += (wl - hL) * cHp
      hR += (wr - hR) * cHp
      lL += (wl - hL - lL) * cLp
      lR += (wr - hR - lR) * cLp
      // patter ticks
      let il = 0
      let ir = 0
      if (rng.next() < pRate) il = -Math.log(1 - rng.next() * 0.999) * tickScale * (rng.next() < 0.5 ? -1 : 1)
      if (rng.next() < pRate) ir = -Math.log(1 - rng.next() * 0.999) * tickScale * (rng.next() < 0.5 ? -1 : 1)
      tL += (il - tL) * cTick
      tR += (ir - tR) * cTick
      const ticksL = il - tL
      const ticksR = ir - tR
      // drops
      if (rng.next() < dRate) {
        let s = 0
        for (let k = 0; k < D; k++) if (dAmp[k] < dAmp[s]) s = k
        const f = 1200 * Math.exp(Math.log(4.5 / 1.2) * rng.next())
        dAmp[s] = 0.15 + 0.35 * rng.next()
        dDec[s] = Math.exp(-1 / ((0.015 + 0.025 * rng.next()) * sr))
        dPh[s] = 0
        dInc[s] = (TWO_PI * Math.min(f, sr * 0.45)) / sr
        const th = rng.next() * 0.5 * Math.PI
        dL[s] = Math.cos(th) * Math.SQRT2
        dR[s] = Math.sin(th) * Math.SQRT2
      }
      let dl = 0
      let dr = 0
      for (let k = 0; k < D; k++) {
        const a = dAmp[k]
        if (a === 0) continue
        const v = a * Math.sin(dPh[k])
        dl += v * dL[k]
        dr += v * dR[k]
        dPh[k] += dInc[k]
        if (dPh[k] > TWO_PI) dPh[k] -= TWO_PI
        const na = a * dDec[k]
        dAmp[k] = na < 1e-5 ? 0 : na
      }
      this.l = (lL * hissScale * gust + ticksL * 0.35 + dl * 0.12) * this.gain
      this.r = (lR * hissScale * gust + ticksR * 0.35 + dr * 0.12) * this.gain
      if (hL < 1e-20 && hL > -1e-20) hL = 0
      if (hR < 1e-20 && hR > -1e-20) hR = 0
      if (lL < 1e-20 && lL > -1e-20) lL = 0
      if (lR < 1e-20 && lR > -1e-20) lR = 0
      if (tL < 1e-20 && tL > -1e-20) tL = 0
      if (tR < 1e-20 && tR > -1e-20) tR = 0
    },
  }
}

// Vowel formant targets (F1, F2) in Hz, after Peterson and Barney 1952.
const VOWELS = [
  [730, 1090], [530, 1840], [270, 2290], [570, 840], [300, 870], [500, 1450], [660, 1720], [440, 1020],
]

function makeCrowd(sr, rng) {
  const T = 10
  const f0 = new Float64Array(T), gph = new Float64Array(T), glp = new Float64Array(T)
  const size = new Float64Array(T), gain = new Float64Array(T), panL = new Float64Array(T), panR = new Float64Array(T)
  const F1 = new Float64Array(T), F2 = new Float64Array(T), F1t = new Float64Array(T), F2t = new Float64Array(T)
  const sylLeft = new Float64Array(T), sylLen = new Float64Array(T), pause = new Float64Array(T)
  const env = new Float64Array(T), envStep = new Float64Array(T), burst = new Float64Array(T), pitchOff = new Float64Array(T)
  const intPh = new Float64Array(T), intInc = new Float64Array(T)
  const st = new Float64Array(T * 4)
  const cf = new Float64Array(T * 8)
  const cGl = onePoleCoef(sr, 700)
  const cHp = onePoleCoef(sr, 2200)
  const cDist = onePoleCoef(sr, 3800)
  for (let k = 0; k < T; k++) {
    const female = rng.next() < 0.5
    f0[k] = female ? 170 + 60 * rng.next() : 92 + 45 * rng.next()
    size[k] = female ? 1.08 + 0.1 * rng.next() : 0.9 + 0.1 * rng.next()
    gain[k] = 0.35 + 0.65 * rng.next()
    const pan = rng.next() * 1.8 - 0.9
    const th = (pan + 1) * 0.25 * Math.PI
    panL[k] = Math.cos(th) * Math.SQRT2
    panR[k] = Math.sin(th) * Math.SQRT2
    gph[k] = rng.next()
    const v = VOWELS[Math.floor(rng.next() * VOWELS.length)]
    F1[k] = F1t[k] = v[0] * size[k]
    F2[k] = F2t[k] = v[1] * size[k]
    pause[k] = Math.floor(rng.next() * 0.8 * sr)
    intPh[k] = rng.next()
    intInc[k] = ((0.25 + 0.3 * rng.next()) * 32) / sr
  }
  let ctl = 0
  let nHp = 0, cL = 0, cR = 0
  const fSm = 1 - Math.exp(-32 / (0.035 * sr))
  const burstDec = Math.exp(-1 / (0.014 * sr))
  return {
    l: 0,
    r: 0,
    gain: 0.667,
    next() {
      if (ctl === 0) {
        ctl = 32
        for (let k = 0; k < T; k++) {
          if (pause[k] > 0) {
            pause[k] -= 32
            envStep[k] = -env[k] / 32
            continue
          }
          if (sylLeft[k] <= 0) {
            // a new syllable, or the end of a phrase
            if (sylLen[k] > 0 && rng.next() < 0.14) {
              pause[k] = Math.floor((0.25 + 1.0 * rng.next()) * sr)
              sylLen[k] = 0
              envStep[k] = -env[k] / 32
              continue
            }
            sylLen[k] = Math.floor((0.12 + 0.15 * rng.next()) * sr)
            sylLeft[k] = sylLen[k]
            const v = VOWELS[Math.floor(rng.next() * VOWELS.length)]
            F1t[k] = v[0] * size[k]
            F2t[k] = v[1] * size[k]
            pitchOff[k] = 1 + 0.08 * (rng.next() * 2 - 1)
            if (rng.next() < 0.5) burst[k] = 0.5 + 0.5 * rng.next()
          }
          sylLeft[k] -= 32
          const ph = 1 - sylLeft[k] / sylLen[k]
          const target = ph >= 1 ? 0 : Math.sqrt(Math.sin(Math.PI * (ph < 0 ? 0 : ph)))
          envStep[k] = (target - env[k]) / 32
          F1[k] += (F1t[k] - F1[k]) * fSm
          F2[k] += (F2t[k] - F2[k]) * fSm
          svfSet(cf, k * 8, sr, F1[k], 5)
          svfSet(cf, k * 8 + 4, sr, F2[k], 7)
          let ip = intPh[k] + intInc[k]
          if (ip >= 1) ip -= 1
          intPh[k] = ip
        }
      }
      ctl--
      let l = 0
      let r = 0
      let hiss = 0
      for (let k = 0; k < T; k++) {
        let e = env[k] + envStep[k]
        if (e < 1e-6) e = 0
        env[k] = e
        if (burst[k] > 0) {
          hiss += (rng.next() * 2 - 1) * burst[k] * gain[k]
          burst[k] *= burstDec
          if (burst[k] < 0.02) burst[k] = 0
        }
        if (e === 0) continue
        const fk = f0[k] * pitchOff[k] * (1 + 0.1 * Math.sin(TWO_PI * intPh[k]))
        const dt = fk / sr
        let q = gph[k]
        const saw = 2 * q - 1 - polyblep(q, dt)
        q += dt
        if (q >= 1) q -= 1
        gph[k] = q
        let g = glp[k] + (saw - glp[k]) * cGl
        if (g < 1e-20 && g > -1e-20) g = 0
        glp[k] = g
        const src = g + (rng.next() * 2 - 1) * 0.06
        const y = svfBp(st, k * 4, cf, k * 8, src) + 0.55 * svfBp(st, k * 4 + 2, cf, k * 8 + 4, src)
        const o = y * e * gain[k]
        l += o * panL[k]
        r += o * panR[k]
      }
      nHp += (hiss - nHp) * cHp
      if (nHp < 1e-20 && nHp > -1e-20) nHp = 0
      const cons = (hiss - nHp) * 0.18
      cL += (l + cons - cL) * cDist
      cR += (r + cons - cR) * cDist
      if (cL < 1e-20 && cL > -1e-20) cL = 0
      if (cR < 1e-20 && cR > -1e-20) cR = 0
      this.l = cL * this.gain
      this.r = cR * this.gain
    },
  }
}

function makeEngine(sr, rng) {
  const CYL = [1, 0.82, 0.95, 0.78]
  const st = new Float64Array(8)
  const cf = new Float64Array(8)
  svfSet(cf, 0, sr, 85, 4)
  svfSet(cf, 4, sr, 210, 3)
  const cPuff = onePoleCoef(sr, 900)
  const puffDec = Math.exp(-1 / (0.012 * sr))
  // one-sample firing pulses: scale with the rate so the body rings the same
  const kickScale = (6 * sr) / 48000
  const puffScale = 1.6 * Math.sqrt(sr / 48000)
  let ph = 0, cyl = 0, kick = 0, puff = 0, pL = 0, pR = 0
  let wa = 0, wb = 0, wp = 0
  const wInc = 0.4 / sr
  return {
    l: 0,
    r: 0,
    gain: 1.21,
    next() {
      wp += wInc
      if (wp >= 1) {
        wp -= 1
        wa = wb
        wb = rng.next() * 2 - 1
      }
      const idle = 28 * (1 + 0.035 * (wa + (wb - wa) * (0.5 - 0.5 * Math.cos(Math.PI * wp))))
      ph += idle / sr
      let imp = 0
      if (ph >= 1) {
        ph -= 1
        cyl = (cyl + 1) & 3
        const a = CYL[cyl] * (0.9 + 0.2 * rng.next())
        imp = a
        puff = a
        ph += 0.02 * (rng.next() - 0.5)
      }
      kick = imp * kickScale
      const body = svfBp(st, 0, cf, 0, kick) + 0.6 * svfBp(st, 2, cf, 4, kick)
      puff *= puffDec
      if (puff < 1e-6) puff = 0
      const nl = (rng.next() * 2 - 1) * puff
      const nr = (rng.next() * 2 - 1) * puff
      pL += (nl - pL) * cPuff
      pR += (nr - pR) * cPuff
      if (pL < 1e-20 && pL > -1e-20) pL = 0
      if (pR < 1e-20 && pR > -1e-20) pR = 0
      this.l = (body + pL * puffScale) * this.gain
      this.r = (body * 0.92 + pR * puffScale) * this.gain
    },
  }
}

function makeSource(name, sr, rng) {
  if (name === 'rain') return makeRain(sr, rng)
  if (name === 'crowd') return makeCrowd(sr, rng)
  if (name === 'engine') return makeEngine(sr, rng)
  if (name === 'drone') return makeDrone(sr, rng)
  return makePad(sr, rng)
}

/**
 * One of the built-in sources as a stereo buffer of `seconds` (tests and
 * listening tools use it; each source is calibrated to about 0.1 RMS).
 */
export function builtinSource(name, sr, seconds, rng) {
  const n = Math.max(0, Math.round(seconds * sr))
  const gen = makeSource(name, sr, rng || makeRng('mod.keyed.' + name))
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    gen.next()
    L[i] = gen.l
    R[i] = gen.r
  }
  return { sr, ch: [L, R] }
}

// ---------------------------------------------------------------- the key

function createKeyer(sr, refInit) {
  const att = 1 - Math.exp(-1 / (0.002 * sr))
  const rel = 1 - Math.exp(-1 / (0.04 * sr))
  const refFall = Math.exp(-1 / (8 * sr))
  // the level reference (how loud to play the other sound) forgets far more
  // slowly, so a long pause in live mode does not fade the sound away
  const levFall = Math.exp(-1 / (60 * sr))
  const holdN = Math.round(0.12 * sr)
  const fixed = refInit > 0
  const ref0 = refInit > 1e-4 ? refInit : 0.1
  const k = {
    mode: 0,
    cA: 0,
    cR: 0,
    sens: 0.5,
    openK: 0.05,
    boost: 2,
    env: 0,
    ref: ref0,
    lref: ref0,
    open: false,
    hold: 0,
    c: 0,
    set(p) {
      const m = MODES.indexOf(p.mode)
      this.mode = m >= 0 ? m : 0
      this.cA = 1 - Math.exp(-1000 / (clamp(num(p.attack, 20), 0.5, 5000) * sr))
      this.cR = 1 - Math.exp(-1000 / (clamp(num(p.release, 300), 1, 20000) * sr))
      this.sens = clamp(num(p.sensitivity, 50), 0, 100) / 100
      this.openK = Math.pow(10, -(10 + 30 * this.sens) / 20)
      this.boost = Math.pow(10, (12 * this.sens) / 20)
    },
    reset() {
      this.env = 0
      this.ref = ref0
      this.lref = ref0
      this.open = false
      this.hold = 0
      this.c = this.mode === 1 ? 1 : 0
    },
    /** Feed one voice sample (absolute value); returns the control 0..1. */
    step(a) {
      let e = this.env
      e += (a - e) * (a > e ? att : rel)
      if (e < 1e-12) e = 0
      this.env = e
      if (!fixed) {
        if (e > this.ref) this.ref = e
        else {
          this.ref *= refFall
          if (this.ref < ref0 * 0.03) this.ref = ref0 * 0.03
        }
        if (e > this.lref) this.lref = e
        else {
          this.lref *= levFall
          if (this.lref < ref0 * 0.1) this.lref = ref0 * 0.1
        }
      }
      const ref = this.ref
      const openTh = ref * this.openK
      if (e > openTh) {
        this.open = true
        this.hold = holdN
      } else if (e < openTh * 0.5) {
        if (this.hold > 0) this.hold--
        else this.open = false
      }
      let target
      if (this.mode === 2) {
        // in proportion to your loudness, slightly expanded (1.5 power), so
        // a word 12 dB softer leaves the sound about 9 dB softer
        let u = (e * this.boost) / ref
        u = u > 1 ? 1 : u
        target = u * Math.sqrt(u)
      } else if (this.mode === 1) target = this.open ? 0 : 1
      else target = this.open ? 1 : 0
      const c = this.c
      // attack = how fast it answers your voice starting, release = letting go
      const towardVoice = this.mode === 1 ? target < c : target > c
      this.c = c + (target - c) * (towardVoice ? this.cA : this.cR)
      return this.c
    },
  }
  return k
}

// ---------------------------------------------------------------- offline helpers

/** The take's loud level: the keyer's follower read every 10 ms, 95th percentile. */
function voiceStats(mono, sr) {
  const n = mono.length
  const hop = Math.max(1, Math.round(sr * 0.01))
  const frames = Math.floor(n / hop)
  if (frames < 1) return { ref: 0, rms: 0 }
  const att = 1 - Math.exp(-1 / (0.002 * sr))
  const rel = 1 - Math.exp(-1 / (0.04 * sr))
  const lv = new Float32Array(frames)
  const sq = new Float64Array(frames)
  let env = 0
  let f = 0
  let acc = 0
  for (let i = 0; i < frames * hop; i++) {
    const x = mono[i]
    const a = x < 0 ? -x : x
    env += (a - env) * (a > env ? att : rel)
    acc += x * x
    if ((i + 1) % hop === 0) {
      lv[f] = env
      sq[f] = acc / hop
      acc = 0
      f++
    }
  }
  const sorted = Float32Array.from(lv).sort()
  const ref = sorted[Math.min(frames - 1, Math.floor(frames * 0.95))]
  // speaking loudness: RMS over frames within 20 dB of the loud level
  const th = ref * 0.1
  let s = 0
  let c = 0
  for (let k = 0; k < frames; k++) {
    if (lv[k] > th) {
      s += sq[k]
      c++
    }
  }
  return { ref, rms: c ? Math.sqrt(s / c) : ref * RMS_PER_REF }
}

/**
 * The other sound as two fresh channels of exactly len samples at sr. The
 * host normally hands it over already at the take's rate and length; this
 * also copes with a different rate (resampled) or length (looped or cut),
 * and never touches the host's own arrays.
 */
function sideTo(side, sr, len) {
  if (!side || !Array.isArray(side.ch) || !side.ch.length || !side.ch[0] || !side.ch[0].length) return null
  let chs = side.ch.slice(0, 2)
  if (side.sr > 0 && side.sr !== sr) chs = chs.map((c) => resampleTo(c, side.sr, sr))
  const out = []
  for (let c = 0; c < 2; c++) {
    const s = chs[c < chs.length ? c : 0]
    const m = s.length
    const y = new Float32Array(len)
    if (m > 0) {
      for (let i = 0, j = 0; i < len; i++, j++) {
        if (j >= m) j = 0
        const v = s[j]
        y[i] = v === v && v < 1e30 && v > -1e30 ? v : 0
      }
    }
    out.push(y)
  }
  return out
}

function rmsOf(chs) {
  let s = 0
  let n = 0
  for (const c of chs) {
    for (let i = 0; i < c.length; i++) s += c[i] * c[i]
    n += c.length
  }
  return n ? Math.sqrt(s / n) : 0
}

// ---------------------------------------------------------------- live kernel

function createLive(sr, p0, rngIn) {
  const rng = rngIn || makeRng('mod.keyed')
  const gens = []
  for (let k = 1; k < SOURCES.length; k++) gens.push(makeSource(SOURCES[k], sr, forkOf(rng, SOURCES[k])))
  const keyer = createKeyer(sr, 0)
  const sm = 1 - Math.exp(-1 / (0.03 * sr))
  const xfInc = 1 / (0.05 * sr)
  let cur = 0, prev = 0, xf = 1
  let depthT = 1, voiceT = 1, levelT = 0.5
  let depth = 1, voice = 1, level = 0.5
  function srcIndex(name) {
    const i = SOURCES.indexOf(name)
    return i <= 0 ? 0 : i - 1
  }
  function set(p) {
    keyer.set(p)
    const s = srcIndex(p.source)
    if (s !== cur) {
      prev = cur
      cur = s
      xf = 0
    }
    depthT = clamp(num(p.depth, 100), 0, 100) / 100
    voiceT = clamp(num(p.voice, 100), 0, 100) / 100
    levelT = Math.pow(10, clamp(num(p.level, -6), -60, 20) / 20)
  }
  set(p0)
  prev = cur
  xf = 1
  depth = depthT
  voice = voiceT
  level = levelT
  keyer.reset()
  return {
    set,
    reset() {
      keyer.reset()
      depth = depthT
      voice = voiceT
      level = levelT
      xf = 1
      prev = cur
    },
    process(ins, outs, n) {
      const nIn = ins.length
      const two = outs.length > 1
      for (let i = 0; i < n; i++) {
        depth += (depthT - depth) * sm
        voice += (voiceT - voice) * sm
        level += (levelT - level) * sm
        const x0 = ins[0][i]
        const x1 = nIn > 1 ? ins[1][i] : x0
        let a = 0.5 * (x0 + x1)
        a = a < 0 ? -a : a
        if (!(a < 1e30)) a = 0
        const c = keyer.step(a)
        const g = 1 - depth + depth * c
        const gen = gens[cur]
        gen.next()
        let sl = gen.l
        let sr2 = gen.r
        if (xf < 1) {
          const pg = gens[prev]
          pg.next()
          sl = pg.l + (sl - pg.l) * xf
          sr2 = pg.r + (sr2 - pg.r) * xf
          xf += xfInc
          if (xf > 1) xf = 1
        }
        const sg = ((keyer.lref * RMS_PER_REF) / NOMINAL_RMS) * level * g
        if (two) {
          outs[0][i] = x0 * voice + sl * sg
          outs[1][i] = x1 * voice + sr2 * sg
        } else {
          outs[0][i] = 0.5 * (x0 + x1) * voice + 0.5 * (sl + sr2) * sg
        }
      }
    },
  }
}

// ---------------------------------------------------------------- module

export default {
  id: 'mod.keyed',
  name: 'Keyed by your voice',
  family: 'mod',
  about: 'Another sound that plays only while you talk, dips under you, or swells with you: your own sound, rain, a crowd and more.',
  params,
  side: true,
  stereo: 'make',
  tail: () => 0,
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    const sr = input.sr
    const n = input.ch.length ? input.ch[0].length : 0
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    if (!n) return { sr, ch: [L, R] }
    const rng = (ctx && ctx.rng) || makeRng('mod.keyed')
    const inL = input.ch[0]
    const inR = input.ch.length > 1 ? input.ch[1] : input.ch[0]
    const mono = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const v = 0.5 * (inL[i] + inR[i])
      mono[i] = v === v && v < 1e30 && v > -1e30 ? v : 0
    }
    // the other sound, or a built-in source
    let srcName = SOURCES.indexOf(p.source) >= 0 ? p.source : 'side'
    let src = null
    if (srcName === 'side') {
      src = sideTo(ctx && ctx.side, sr, n)
      if (!src) {
        srcName = 'pad'
        if (ctx && typeof ctx.note === 'function') ctx.note('No other sound was given, so the warm pad plays instead.')
      }
    }
    if (!src) {
      const gen = makeSource(srcName, sr, forkOf(rng, srcName))
      const a = new Float32Array(n)
      const b = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        gen.next()
        a[i] = gen.l
        b[i] = gen.r
      }
      src = [a, b]
    }
    const stats = voiceStats(mono, sr)
    const srcRms = rmsOf(src)
    const lev = Math.pow(10, clamp(num(p.level, -6), -60, 20) / 20)
    // a silent take has no speaking level to follow: assume a typical one
    const voiceRms = stats.rms > 1e-6 ? stats.rms : 0.05
    const sg = srcRms > 1e-9 ? (voiceRms / srcRms) * lev : 0
    const keyer = createKeyer(sr, stats.ref > 1e-9 ? stats.ref : 0)
    keyer.set(p)
    keyer.reset()
    const depth = clamp(num(p.depth, 100), 0, 100) / 100
    const voice = clamp(num(p.voice, 100), 0, 100) / 100
    const sL = src[0]
    const sR = src[1]
    for (let i = 0; i < n; i++) {
      const x = mono[i]
      const c = keyer.step(x < 0 ? -x : x)
      const g = (1 - depth + depth * c) * sg
      const vl = inL[i]
      const vr = inR[i]
      L[i] = (vl === vl && vl < 1e30 && vl > -1e30 ? vl : 0) * voice + sL[i] * g
      R[i] = (vr === vr && vr < 1e30 && vr > -1e30 ? vr : 0) * voice + sR[i] * g
    }
    if (ctx && typeof ctx.progress === 'function') ctx.progress(1)
    return { sr, ch: [L, R] }
  },
  live: {
    latency: () => 0,
    create(sr, p, rng) {
      return createLive(sr, p, rng)
    },
  },
}
