// beds/radio-static.js - A radio between stations: hiss, crackle, whistles and
// far-off fragments of stations drifting in and out.
//
// Techniques and published sources:
// - Receiver noise is white noise through the receiver's audio band (about
//   4.5 kHz wide for AM, wider and breathier for shortwave, the full FM band
//   with the 75 microsecond de-emphasis for FM).
// - Atmospheric noise ("sferics") is impulsive: Poisson clicks plus the
//   longer crashes of distant lightning, dense bursts of crackle that decay
//   over a few hundred milliseconds (CCIR Report 322 on atmospheric radio
//   noise describes this impulsive character).
// - Fading: skywave signals swell and sink over seconds, and selective
//   fading drags a notch slowly across the band (Davies, "Ionospheric Radio",
//   1990); polar shortwave paths add a fast flutter.
// - Heterodyne whistles are the beat between two carriers: a steady tone at
//   the difference frequency, drifting a little. Tuning the dial moves every
//   mistuning at once, so whistles slide down to zero beat as a station
//   comes in and back up as it leaves: that slide is computed here from a
//   wandering dial position and a list of station frequencies.
// - Station fragments are a babbling voice-like signal (a pulse train with a
//   wandering pitch through two formant filters that jump at syllable rate,
//   Klatt-style source-filter synthesis, "Software for a cascade/parallel
//   formant synthesizer", JASA 1980) and short bursts of chords, always
//   muffled and faded so no words are ever heard. Shortwave also carries
//   Morse code keyed from random letters, and sideband talk shifted by a
//   single-sideband frequency shifter (core/hilbert.js), the classic
//   mistuned "duck" voice.

import { freqShift } from '../core/hilbert.js'
import {
  setup, stereo, finish, clamp, dB, TAU, wander, whiteArr, noise, norm, normPeak, addTo, bq, sweep, eventTimes,
  harmonicTable, oscInto, SINE, addTone, Fdn,
} from './car-highway.js'
import { crackle } from '../core/noise.js'

const PULSE = harmonicTable([1, 0.75, 0.6, 0.5, 0.42, 0.36, 0.3, 0.26, 0.22, 0.19, 0.16, 0.14])
const VOW = [[300, 870], [520, 900], [730, 1090], [640, 1190], [290, 2250], [450, 1800], [400, 2000], [660, 1700]]

/**
 * A voice-like babble with no words in it. o: { pitch=140, rate=4.5
 * (syllables per second), talk=0.75 (share of time talking) }. Returns a
 * signal with peak 1.
 */
export function babble(n, sr, rng, o = {}) {
  const out = new Float32Array(n)
  if (!n) return out
  const base = o.pitch ?? 140
  const f0 = new Float32Array(n)
  const w1 = wander(n, sr, 2.2, rng.fork('p1'))
  const w2 = wander(n, sr, 7, rng.fork('p2'))
  for (let i = 0; i < n; i++) f0[i] = base * (1 + 0.16 * w1[i] + 0.05 * w2[i])
  const src = new Float32Array(n)
  oscInto(src, sr, f0, 1, PULSE, rng.next(), 12)
  const nz = whiteArr(n, rng.fork('nz'))
  // syllables: an envelope and formant targets that jump per syllable
  const env = new Float32Array(n)
  const F1 = new Float32Array(n)
  const F2 = new Float32Array(n)
  const rate = o.rate ?? 4.5
  const talk = clamp(o.talk ?? 0.75, 0.1, 1)
  let t = 0
  let cur = rng.pick(VOW)
  const dur = n / sr
  while (t < dur) {
    if (rng.next() > talk) {
      t += rng.range(0.25, 0.8)
      continue
    }
    const len = rng.range(0.6, 1.4) / rate
    const next = rng.pick(VOW)
    const i0 = Math.round(t * sr)
    const m = Math.round(len * sr)
    const amp = rng.range(0.5, 1)
    const cons = rng.next() < 0.6
    for (let j = 0; j < m && i0 + j < n; j++) {
      const x = j / m
      const e = Math.sin(Math.PI * Math.min(1, x * 1.15)) * amp
      env[i0 + j] = Math.max(env[i0 + j], e > 0 ? e : 0)
      const s = x * x * (3 - 2 * x)
      F1[i0 + j] = cur[0] + (next[0] - cur[0]) * s
      F2[i0 + j] = cur[1] + (next[1] - cur[1]) * s
      if (cons && j < m * 0.18) src[i0 + j] += nz[i0 + j] * 2.5 * (1 - j / (m * 0.18))
    }
    cur = next
    t += len * rng.range(1.0, 1.25)
  }
  for (let i = 0; i < n; i++) {
    if (F1[i] === 0) {
      F1[i] = cur[0]
      F2[i] = cur[1]
    }
  }
  const a = new Float32Array(src)
  const b = new Float32Array(src)
  sweep(a, sr, 'bandpass', F1, 4)
  sweep(b, sr, 'bandpass', F2, 6)
  for (let i = 0; i < n; i++) out[i] = (a[i] + 0.6 * b[i]) * env[i]
  bq(out, sr, 'highpass', 120, 0.707)
  return normPeak(out, 1)
}

/** Random Morse code keying as an on/off envelope (0..1, soft edges). wpm words per minute. */
function morseEnvelope(n, sr, rng, wpm) {
  const env = new Float32Array(n)
  const dot = 1.2 / wpm
  const codes = ['.-', '-...', '-.-.', '-..', '.', '..-.', '--.', '....', '..', '.---', '-.-', '.-..', '--', '-.', '---', '.--.', '--.-', '.-.', '...', '-', '..-', '...-', '.--', '-..-', '-.--', '--..']
  let t = rng.range(0.2, 2)
  const dur = n / sr
  const edge = Math.max(1, Math.round(0.004 * sr))
  const mark = (t0, len) => {
    const i0 = Math.round(t0 * sr)
    const m = Math.round(len * sr)
    for (let j = 0; j < m && i0 + j < n; j++) {
      const e = j < edge ? j / edge : j > m - edge ? (m - j) / edge : 1
      env[i0 + j] = e
    }
  }
  while (t < dur) {
    const letters = 3 + rng.int(5)
    for (let l = 0; l < letters && t < dur; l++) {
      const c = rng.pick(codes)
      for (const sym of c) {
        const len = sym === '.' ? dot : 3 * dot
        mark(t, len)
        t += len + dot
      }
      t += 2 * dot
    }
    t += 4 * dot + (rng.next() < 0.2 ? rng.range(1, 4) : 0)
  }
  return env
}

const BANDS = {
  am: { lo: 150, hi: 4500, hissTilt: -3, fadeDepth: 0.35, flutter: 0, crackle: 1, whistle: 1 },
  shortwave: { lo: 120, hi: 5500, hissTilt: 0, fadeDepth: 0.55, flutter: 0.35, crackle: 0.8, whistle: 1.3 },
  fm: { lo: 40, hi: 15000, hissTilt: 0, fadeDepth: 0.05, flutter: 0, crackle: 0.1, whistle: 0 },
}

const bed = {
  id: 'radio-static',
  name: 'Radio static',
  group: 'spooky',
  about: 'A radio between stations: hiss and crackle, whistling carriers and faded fragments of far stations.',
  params: [
    {
      id: 'band',
      name: 'Band',
      type: 'choice',
      def: 'am',
      options: [
        { v: 'am', name: 'Medium wave at night' },
        { v: 'shortwave', name: 'Shortwave' },
        { v: 'fm', name: 'Between FM stations' },
      ],
    },
    { id: 'intensity', name: 'Static', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [30, 90] },
    { id: 'crackle', name: 'Crackle and lightning', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [10, 85] },
    { id: 'stations', name: 'Far stations and whistles', type: 'number', min: 0, max: 100, step: 1, def: 45, unit: 'percent', rand: [10, 85] },
    { id: 'tuning', name: 'Turning the dial', type: 'bool', def: false },
  ],

  generate(seconds, sr, p, rng) {
    const s = setup(bed, seconds, sr, p, rng)
    const { n, q } = s
    const SR = s.sr
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    if (n === 0) return stereo(SR, L, R)
    const r = s.rng
    const dur = s.dur
    const band = BANDS[q.band] || BANDS.am
    const k = q.intensity / 100
    const cr = q.crackle / 100
    const st = q.stations / 100
    const M = new Float32Array(n) // the radio is one speaker: build mono, widen a touch at the end

    // fading: slow swell, selective notch, shortwave flutter
    const fadeW = wander(n, SR, 0.18, r.fork('fade'))
    const flut = band.flutter > 0 ? wander(n, SR, 6, r.fork('flutter')) : null
    const fade = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let g = 1 + band.fadeDepth * fadeW[i]
      if (flut) g *= 1 + band.flutter * 0.5 * flut[i]
      fade[i] = g > 0.05 ? g : 0.05
    }

    // receiver hiss
    const hiss = q.band === 'fm' ? whiteArr(n, r.fork('hiss')) : noise(n, r.fork('hiss'), 'white')
    bq(hiss, SR, 'highpass', band.lo, 0.707)
    bq(hiss, SR, 'lowpass', band.hi, 0.707)
    bq(hiss, SR, 'lowpass', band.hi * 1.1, 0.707)
    if (q.band === 'fm') bq(hiss, SR, 'highshelf', 2100, 0.6, -9)
    else bq(hiss, SR, 'peak', 1200, 0.6, 2)
    if (q.band !== 'fm') {
      const notchF = wander(n, SR, 0.07, r.fork('notch'))
      sweep(hiss, SR, 'notch', (i) => 900 * Math.pow(3, notchF[i]), 1.2)
    }
    norm(hiss, 1)
    const hg = dB(-6 + 8 * k)
    for (let i = 0; i < n; i++) M[i] += hiss[i] * hg * (q.band === 'fm' ? 1 : 0.8 + 0.25 * fade[i])

    // sferics: clicks and lightning crashes
    if (cr > 0 && band.crackle > 0) {
      const cl = crackle(n, SR, (8 + 60 * cr) * band.crackle, r.fork('clicks'), { maxWidthMs: 1.5, popChance: 0.03 })
      bq(cl, SR, 'bandpass', 1500, 0.5)
      normPeak(cl, 1)
      addTo(M, cl, dB(-8 + 6 * cr) * 1.6)
      for (const t of eventTimes((0.03 + 0.15 * cr) * band.crackle, dur, r.fork('crash'), 1.5)) {
        const len = r.range(0.15, 0.5)
        const m = Math.round(len * SR)
        const c = crackle(m, SR, r.range(300, 900), r.fork('c' + t), { maxWidthMs: 0.8, popChance: 0.1, minAmp: 0.2 })
        for (let j = 0; j < m; j++) c[j] *= Math.exp((-3 * j) / m)
        bq(c, SR, 'bandpass', 1300, 0.45)
        normPeak(c, 1)
        addTo(M, c, r.range(0.8, 1.6) * (0.5 + cr), Math.round(t * SR))
      }
    }

    // stations: the dial position, the carriers near it, whistles and fragments
    const tuning = q.tuning
    const dial = new Float32Array(n)
    {
      const dw = wander(n, SR, tuning ? 0.35 : 0.04, r.fork('dial'))
      const sweepRate = tuning ? r.range(-0.08, 0.08) : 0
      const d0 = r.range(0, 10)
      for (let i = 0; i < n; i++) dial[i] = d0 + (tuning ? 1.6 : 0.05) * dw[i] + sweepRate * (i / SR)
    }
    if (st > 0 && q.band !== 'fm') {
      // carriers at random places around the dial (units of 1 kHz of mistuning)
      const count = 3 + Math.round(6 * st)
      const station = []
      for (let c = 0; c < count; c++) station.push({ pos: dial[0] + r.range(-6, 6), level: r.range(0.3, 1), kind: r.next() < 0.6 ? 'talk' : 'music', pitch: r.range(100, 210) })
      if (!tuning) {
        // a still dial: park one or two carriers close enough to whistle
        station.push({ pos: dial[0] + r.range(0.3, 2.5) * r.sign(), level: r.range(0.5, 1), kind: 'talk', pitch: r.range(100, 200) })
      }
      const whiG = dB(-22 + 8 * st) * band.whistle
      const fragG = dB(-16 + 8 * st)
      const blk = 64
      const f = new Float32Array(n)
      const aw = new Float32Array(n)
      const af = new Float32Array(n)
      for (const sta of station) {
        // whistle and fragment levels per block; remember the spans where they sound
        let w0 = -1, w1 = -1, f0 = -1, f1 = -1
        for (let i = 0; i < n; i += blk) {
          const mis = dial[i] - sta.pos
          const am = Math.abs(mis)
          const wf = am * 1000 * 0.9
          let wa = wf > 60 && wf < band.hi ? Math.exp(-am / 2.2) * sta.level : 0
          if (wa < 0.06) wa = 0
          const fa = Math.exp(-(mis * mis) / 0.5) * sta.level
          const e = Math.min(n, i + blk)
          for (let j = i; j < e; j++) {
            f[j] = wf
            aw[j] = wa * whiG * fade[j]
            af[j] = fa > 0.01 ? fa * fragG * fade[j] : 0
          }
          if (wa > 0) {
            if (w0 < 0) w0 = i
            w1 = e
          }
          if (fa > 0.01) {
            if (f0 < 0) f0 = i
            f1 = e
          }
        }
        if (w0 >= 0) oscInto(M, SR, f.subarray(w0, w1), aw.subarray(w0, w1), SINE, r.next(), 1, w0, w1 - w0)
        if (f0 >= 0) {
          const m = f1 - f0
          let frag
          if (sta.kind === 'talk') frag = babble(m, SR, r.fork('talk' + sta.pos), { pitch: sta.pitch, rate: r.range(3.8, 5.2) })
          else {
            frag = new Float32Array(m)
            let t = 0
            const root = r.range(180, 300)
            const md = m / SR
            while (t < md) {
              const len = r.range(0.35, 0.9)
              const chord = r.pick([[1, 1.26], [1, 1.19, 1.5], [1.12, 1.68], [0.89, 1.33]])
              for (const c of chord) addTone(frag, frag, Math.round(t * SR), SR, { f: root * c, attack: 0.02, hold: len * 0.6, tau: len * 0.12, amp: 0.4, table: PULSE, maxHarm: 12 })
              t += len
            }
            normPeak(frag, 1)
          }
          bq(frag, SR, 'lowpass', 2200, 0.707)
          bq(frag, SR, 'highpass', 250, 0.707)
          for (let i = 0; i < m; i++) M[f0 + i] += frag[i] * af[f0 + i]
        }
      }
    }
    // shortwave extras: Morse and sideband talk
    if (q.band === 'shortwave' && st > 0) {
      const env = morseEnvelope(n, SR, r.fork('morse'), r.range(14, 24))
      const tone = new Float32Array(n)
      oscInto(tone, SR, r.range(580, 820), 1, SINE, 0, 1)
      const g = dB(-20 + 8 * st)
      for (let i = 0; i < n; i++) M[i] += tone[i] * env[i] * g * fade[i]
      const ssb = babble(n, SR, r.fork('ssb'), { pitch: r.range(95, 150), rate: 4.4, talk: 0.65 })
      const shifted = freqShift(ssb, SR, r.range(250, 450) * r.sign())
      bq(shifted, SR, 'bandpass', 1300, 0.5)
      normPeak(shifted, 1)
      const g2 = dB(-17 + 6 * st)
      for (let i = 0; i < n; i++) M[i] += shifted[i] * g2 * fade[i] * fade[i]
    }
    // FM: a station pops in now and then when the dial is moved
    if (q.band === 'fm' && tuning && st > 0) {
      for (const t of eventTimes(0.15 * st, dur, r.fork('pop'), 1.5)) {
        const len = r.range(0.3, 1.2)
        const m = Math.round(len * SR)
        const frag = babble(m, SR, r.fork('fm' + t), { pitch: r.range(100, 220) })
        for (let j = 0; j < m; j++) frag[j] *= Math.sin((Math.PI * j) / m)
        addTo(M, frag, 0.8, Math.round(t * SR))
        // the hiss ducks while a station captures the receiver
        const i0 = Math.round(t * SR)
        for (let j = 0; j < m && i0 + j < n; j++) M[i0 + j] *= 1 - 0.5 * Math.sin((Math.PI * j) / m)
      }
    }
    // a small speaker cabinet and a hint of width
    bq(M, SR, 'peak', 220, 1.2, 2)
    for (let i = 0; i < n; i++) {
      L[i] = M[i]
      R[i] = M[i]
    }
    const side = whiteArr(n, r.fork('side'))
    bq(side, SR, 'bandpass', 2000, 0.4)
    norm(side, 1)
    addTo(L, side, hg * 0.05)
    addTo(R, side, -hg * 0.05)
    new Fdn(SR, { size: 0.7, rt60: 0.45, damp: 0.55, predelayMs: 3 }).process(L, R, 0.12, 1)
    return finish(L, R, SR, -24 + (k - 0.6) * 6, -10)
  },
}

export default bed
