// beds/heartbeat.js - A heartbeat: lub-dub, close and alive.
//
// Technique: the two heart sounds are synthesised from their published
// make-up (Tilkian and Conover, "Understanding Heart Sounds and Murmurs";
// the phonocardiogram synthesis of Almasi, Shamsollahi and Senhadji, "A
// dynamical model for generating synthetic phonocardiogram signals", 2011):
// S1, the "lub", is the closing of the mitral then the tricuspid valve about
// 25 ms apart, low (40 to 140 Hz) and longer; S2, the "dub", is the aortic
// then the pulmonary valve, shorter and a little higher, and its two parts
// split further apart when breathing in. Each component is a damped
// sinusoid whose pitch sags as it rings, plus a short soft thud. Timing:
// the beat-to-beat interval follows the rate with breathing-linked
// variation (respiratory sinus arrhythmia, about 4 percent at a quarter
// hertz) and a little randomness; S1 to S2 shortens as the rate rises
// (roughly 0.1 + 0.2 * sqrt(RR) seconds). A soft saturation adds the upper
// harmonics a small speaker needs to make the thump heard. Patterns: steady,
// speeding up, slowing down, and skipping (now and then an early beat
// followed by a longer pause). The listening place sets the colour: inside
// your own head (dark, with the rush of blood), an ear on a chest, or in
// the room (a muffled beat under the floorboards, with a small room).

import { setup, stereo, finish, clamp, dB, noisePair, norm, addTo, bq, addTone, addBurst, harmonicTable, Fdn } from './car-highway.js'

const PLACES = {
  inside: { lp: 260, blood: 0.5, room: 0, drive: 1.2, presence: 1 },
  chest: { lp: 900, blood: 0.25, room: 0, drive: 1.6, presence: 5 },
  room: { lp: 380, blood: 0.05, room: 0.35, drive: 2.2, presence: 3 },
}

const SOFT = harmonicTable([1, 0.08])

function valve(L, R, t, sr, rng, f, tau, amp, pan) {
  const i0 = Math.round(t * sr)
  addTone(L, R, i0, sr, { f: (x) => f * (1 - 1.8 * Math.min(0.12, x)), attack: 0.004, hold: 0, tau, amp, pan, table: SOFT, maxHarm: 2 })
  addTone(L, R, i0 + Math.round(0.002 * sr), sr, { f: (x) => f * 2.3 * (1 - 1.5 * Math.min(0.1, x)), attack: 0.003, hold: 0, tau: tau * 0.55, amp: amp * 0.6, pan, table: SOFT, maxHarm: 2 })
  addBurst(L, R, i0, sr, rng, { amp: amp * 0.35, pan, tau: tau * 0.4, f: 180, q: 0.7, type: 'lowpass' })
}

const bed = {
  id: 'heartbeat',
  name: 'Heartbeat',
  group: 'spooky',
  about: 'A heartbeat, lub-dub, steady or racing or skipping, heard from inside, on a chest or under the floor.',
  params: [
    { id: 'rate', name: 'Beats per minute', type: 'number', min: 40, max: 180, step: 1, def: 66, unit: 'bpm', rand: [50, 130] },
    { id: 'intensity', name: 'How hard it beats', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [30, 90] },
    {
      id: 'pattern',
      name: 'Rhythm',
      type: 'choice',
      def: 'steady',
      options: [
        { v: 'steady', name: 'Steady' },
        { v: 'faster', name: 'Speeding up' },
        { v: 'slower', name: 'Slowing down' },
        { v: 'skipping', name: 'Skipping beats' },
      ],
    },
    {
      id: 'place',
      name: 'Heard from',
      type: 'choice',
      def: 'chest',
      options: [
        { v: 'inside', name: 'Inside your own head' },
        { v: 'chest', name: 'An ear on a chest' },
        { v: 'room', name: 'Under the floorboards' },
      ],
    },
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
    const k = q.intensity / 100
    const place = PLACES[q.place] || PLACES.chest
    const bpm0 = q.rate
    const rateAt = (t) => {
      const x = clamp(t / Math.max(1, dur), 0, 1)
      if (q.pattern === 'faster') return Math.min(190, bpm0 * (1 + 0.7 * x * x * (3 - 2 * x)))
      if (q.pattern === 'slower') return Math.max(36, bpm0 * (1 - 0.35 * x * x * (3 - 2 * x)))
      return bpm0
    }
    const breathHz = r.range(0.22, 0.3)
    const breathPh = r.next() * Math.PI * 2
    // per-heart character
    const f1 = r.range(42, 52)
    const f2 = r.range(62, 76)
    const beatAmp = 0.5 + 0.6 * k
    let t = r.range(0.05, 0.4)
    let skipDebt = 0
    const blood = new Float32Array(n)
    while (t < dur) {
      const bpm = rateAt(t)
      let rr = 60 / bpm
      const breath = Math.sin(Math.PI * 2 * breathHz * t + breathPh)
      rr *= 1 - 0.04 * breath + 0.015 * r.gauss()
      if (skipDebt > 0) {
        rr += skipDebt
        skipDebt = 0
      } else if (q.pattern === 'skipping' && r.next() < 0.12) {
        // an early beat, then the compensating pause
        const early = rr * r.range(0.35, 0.5)
        skipDebt = early
        rr -= early
      }
      const a = beatAmp * (1 + 0.06 * r.gauss()) * (1 + 0.1 * (bpm - 66) / 66)
      const s12 = 0.1 + 0.2 * Math.sqrt(Math.min(1.5, 60 / bpm))
      // S1: mitral then tricuspid
      valve(L, R, t, SR, r, f1 * r.range(0.97, 1.03), 0.032, a, -0.05)
      valve(L, R, t + r.range(0.018, 0.03), SR, r, f1 * 1.18, 0.024, a * 0.55, 0.05)
      // S2: aortic then pulmonary, split wider when breathing in
      const split = 0.012 + 0.025 * Math.max(0, breath)
      valve(L, R, t + s12, SR, r, f2 * r.range(0.97, 1.03), 0.022, a * 0.72, 0.03)
      valve(L, R, t + s12 + split, SR, r, f2 * 1.12, 0.018, a * 0.4, -0.03)
      // the rush of blood after each beat
      const i0 = Math.round((t + 0.05) * SR)
      const m = Math.round(Math.min(0.45, rr * 0.6) * SR)
      for (let j = 0; j < m && i0 + j < n; j++) {
        const x = j / m
        blood[i0 + j] += Math.sin(Math.PI * Math.sqrt(x)) * a
      }
      t += Math.max(0.25, rr)
    }
    // soft saturation gives a small speaker something to play
    const drive = place.drive * (0.8 + 0.6 * k)
    const nd = Math.tanh(drive)
    for (let i = 0; i < n; i++) {
      L[i] = Math.tanh(L[i] * drive) / nd
      R[i] = Math.tanh(R[i] * drive) / nd
    }
    bq(L, SR, 'lowpass', place.lp, 0.707)
    bq(R, SR, 'lowpass', place.lp * 1.05, 0.707)
    bq(L, SR, 'peak', 130, 1.2, place.presence)
    bq(R, SR, 'peak', 130, 1.2, place.presence)
    bq(L, SR, 'highpass', 25, 0.707)
    bq(R, SR, 'highpass', 25, 0.707)
    if (place.blood > 0) {
      const [bl, br] = noisePair(n, r.fork('blood'), 'pink', 0.6)
      for (const sig of [bl, br]) {
        bq(sig, SR, 'lowpass', 220, 0.707)
        bq(sig, SR, 'highpass', 40, 0.707)
        norm(sig, 1)
        for (let i = 0; i < n; i++) sig[i] *= 0.25 + blood[i]
      }
      const g = dB(-20) * place.blood * 2
      addTo(L, bl, g)
      addTo(R, br, g)
    }
    if (place.room > 0) {
      bq(L, SR, 'lowpass', 300, 0.707)
      bq(R, SR, 'lowpass', 300, 0.707)
      new Fdn(SR, { size: 0.8, rt60: 0.7, damp: 0.6, predelayMs: 6 }).process(L, R, place.room, 1)
      const [hl, hr] = noisePair(n, r.fork('roomtone'), 'brown', 0.3)
      norm(hl, 0.004)
      norm(hr, 0.004)
      addTo(L, hl)
      addTo(R, hr)
    }
    return finish(L, R, SR, -22 + (k - 0.55) * 8, -28)
  },
}

export default bed
