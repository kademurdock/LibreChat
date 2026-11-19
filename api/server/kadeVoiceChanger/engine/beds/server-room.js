// beds/server-room.js - Server room: a wall of fans roaring, air handlers, electrical hum, drive clicks.
//
// Techniques and their published sources:
// - Fans: each rack's fans are broadband turbulent noise plus tones at the
//   blade-pass frequency (rpm / 60 times the blade count) and its harmonics
//   (Bies and Hansen, "Engineering Noise Control", fan noise). Every rack
//   runs at a slightly different speed and its controller hunts a little,
//   so the tones of many racks crowd together and beat, the whine that makes
//   a machine room sound like one.
// - The room's air handler adds a deep rumble, compressor hum and the hiss
//   of air through floor tiles; transformers and power supplies add the
//   mains hum and its harmonics (magnetostriction at twice the mains rate).
// - Disk drives seek in bursts of tiny clicks (head actuator taps with a
//   small metallic resonance); now and then a server chirps.
// - A small hard room; from behind the door the walls take the highs away.

import {
  makeScene, emptyBed, finish, roomTone, emit, poisson, clamp, filt, tone, modal, buf, addAt, seed32, trim,
  harmonicTable, periodic, mainsBuzz, dbg,
} from './cafe.js'
import { pink } from '../core/noise.js'

/** A burst of drive seeks. */
function seeks(sr, rng) {
  const dur = rng.range(0.15, 1.2)
  const out = buf(sr, dur + 0.05)
  const res = rng.range(2500, 4500)
  const click = trim(modal(sr, [res, 0.002, 1, res * 1.6, 0.0015, 0.5], { tick: 0.8, tickHz: 2000, tickMs: 0.3, seed: seed32(rng) }))
  for (let t = 0; t < dur; t += rng.range(0.006, 0.05)) addAt(out, click, t * sr, rng.range(0.3, 1))
  return out
}

const bed = {
  id: 'server-room',
  name: 'Server room',
  group: 'places',
  about: 'A server room: a wall of fans roaring, air handlers rumbling, a faint electrical hum and drive clicks.',
  params: [
    { id: 'intensity', name: 'Fan speed', type: 'number', min: 0, max: 100, step: 1, def: 55, unit: 'percent', rand: [25, 95] },
    { id: 'racks', name: 'Racks', type: 'number', min: 1, max: 12, step: 1, def: 6, unit: 'count', noun: ['rack', 'racks'], rand: [3, 10] },
    { id: 'hum', name: 'Electrical hum', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [10, 80] },
    { id: 'clicks', name: 'Drive clicks', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 70] },
    {
      id: 'where',
      name: 'Where you are',
      type: 'choice',
      def: 'inside',
      options: [
        { v: 'inside', name: 'Inside the room' },
        { v: 'door', name: 'Behind the door' },
      ],
    },
  ],
  generate(seconds, sr, p, rng) {
    const sc = makeScene(bed, seconds, sr, p, rng, { send: 0.45, airHz: 16000, airM: 10, roomR: 6 })
    if (!sc.n) return emptyBed(sc.sr)
    const q = sc.q
    const r = sc.rng
    const speed = q.intensity / 100
    const n = sc.n
    const len = sc.dur + 0.2
    // the broadband roar of all the fans, spread across the racks
    const nl = pink(n, r.fork('roarL'))
    const nr = pink(n, r.fork('roarR'))
    const color = [['highpass', 90, 0.7], ['peak', 700 + speed * 900, 0.6, 5], ['lowpass', 6000 + speed * 5000, 0.6], ['highshelf', 8000, 0.7, -4]]
    filt(nl, sc.sr, color)
    filt(nr, sc.sr, color)
    const roarG = (0.4 + 0.6 * speed) * Math.sqrt(q.racks / 6) * 0.6
    for (let i = 0; i < n; i++) {
      const a = nl[i]
      const b = nr[i]
      sc.L[i] += (0.85 * a + 0.3 * b) * roarG
      sc.R[i] += (0.3 * a + 0.85 * b) * roarG
      sc.S[i] += (a + b) * roarG * 0.15
    }
    // each rack's fan tones
    const fr = r.fork('fans')
    // one scratch buffer for every rack's tones (no full-length array per rack)
    const tones = new Float32Array(Math.ceil(len * sc.sr))
    for (let k = 0; k < q.racks; k++) {
      const rk = fr.fork('r' + k)
      const rpm = (5000 + 7000 * speed) * rk.range(0.92, 1.08)
      const blades = rk.pick([5, 7, 7, 9])
      const bpf = (rpm / 60) * blades
      const tbl = harmonicTable([[1, 1, rk.range(0, 6)], [2, 0.45, rk.range(0, 6)], [3, 0.2, rk.range(0, 6)]])
      const pan = q.racks === 1 ? 0 : -0.9 + (1.8 * k) / (q.racks - 1)
      tones.fill(0)
      periodic(tones.length, sc.sr, bpf, tbl, rk.next(), rk.range(0.002, 0.008), tones, 1)
      // the power supply's own little fan, a little quieter
      periodic(tones.length, sc.sr, bpf * rk.range(1.3, 1.7), tbl, rk.next(), 0.01, tones, 0.4)
      emit(sc, tones, 0, clamp(pan + rk.range(-0.05, 0.05), -1, 1), rk.range(1.2, 4), 0.012 * (0.5 + speed))
    }
    // the air handler: rumble, compressor, floor hiss
    roomTone(sc, r.fork('crac'), { db: -38, color: [['highpass', 2500, 0.7], ['lowpass', 9000, 0.7]], rumbleDb: -30 + speed * 4, rumbleHz: 140, hum: [[59.6, -46], [119.2, -48], [178.8, -56]], drift: 0.08, corr: 0.5 })
    // electrical hum
    const hm = q.hum / 100
    if (hm > 0) {
      const hr = r.fork('hum')
      mainsBuzz(sc, hr, 120, dbg(-52 + hm * 18) * 0.5, 0.6)
      const ht = harmonicTable([[1, 1], [2, 0.5], [3, 0.35], [5, 0.15]])
      emit(sc, periodic(Math.ceil(len * sc.sr), sc.sr, 120, ht, hr.next(), 0.0003), 0, hr.range(-0.6, 0.6), 2, dbg(-46 + hm * 16))
    }
    // drive seeks
    const dk = r.fork('drives')
    for (const t of poisson(dk, (q.clicks / 100) * (0.2 + q.racks * 0.08), -1, sc.dur)) emit(sc, seeks(sc.sr, dk), t * sc.sr, dk.range(-0.95, 0.95), dk.range(0.8, 3.5), 0.05)
    // a server chirps now and then
    for (const t of poisson(dk, 0.008, 0, sc.dur)) {
      const hz = dk.pick([2000, 2400, 3100])
      const b = tone(sc.sr, hz, 0.12, { partials: [[1, 1], [3, 0.3]], att: 0.003, rel: 0.02 })
      emit(sc, b, t * sc.sr, dk.range(-0.9, 0.9), dk.range(1, 4), 0.1)
      if (dk.chance(0.5)) emit(sc, b, (t + 0.2) * sc.sr, dk.range(-0.9, 0.9), dk.range(1, 4), 0.1)
    }
    const out = finish(sc, { size: 0.6, rt60: 0.65, rt60High: 0.4, predelayMs: 4, wet: 0.7 }, -22 + (q.intensity - 55) * 0.08)
    if (q.where === 'door') {
      // a heavy fire door: the lows leak through, the highs stop
      for (const c of out.ch) filt(c, out.sr, [['lowpass', 380, 0.7], ['lowpass', 700, 0.7], ['peak', 120, 1, 4], ['highpass', 30, 0.7]])
      let e = 0
      for (const c of out.ch) for (let i = 0; i < c.length; i++) e += c[i] * c[i]
      const rv = Math.sqrt(e / (2 * Math.max(1, out.ch[0].length)))
      const g = rv > 1e-9 ? dbg(-30 + (q.intensity - 55) * 0.08) / rv : 0
      for (const c of out.ch) for (let i = 0; i < c.length; i++) c[i] = Math.max(-0.95, Math.min(0.95, c[i] * g))
    }
    return out
  },
}

export default bed
