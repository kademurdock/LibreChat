// modules/time/tapestop.js - time.tapestop, "Tape stop": the voice slows
// down to a dead stop as if someone hit the brake on a turntable or cut the
// power to a tape deck, and (if asked) starts up again from standstill.
//
// Technique: variable-speed playback with a moving, band-limited read head,
// core/resample.js varispeed (Julius O. Smith III's bandlimited
// interpolation, which also fades the level near standstill so the final stop
// never clicks). The head's speed follows a ramp from normal speed to zero
// over the stop time: "Steady" is constant deceleration (a platter coasting
// against its brake, speed 1 - u), "Drops fast, then drags" is (1 - u)^2.6
// (a heavy reel losing power), "Holds, then drops" is 1 - u^2.4 (a motor that
// fights and then gives up). A start-up plays the same ramp backwards. The
// level follows the square root of the speed, because a magnetic playback
// head and a phono stylus both put out a voltage proportional to how fast the
// medium moves past them, which is the gradual fade that makes a stop
// convincing. The stop is placed so the tape halts exactly where the speech
// ends, then the tape stays silent through the pause that follows. Random
// places are brakes in mid-sentence: slow down and snap back, drop out and
// spin up, or both. The ramps join the untouched voice through raised-cosine
// crossfades (renderSegments in _lib.js) at matching read positions, so
// the joins are seamless.

import { mixDown, prepare, renderBuf, forwardSeg, silenceSeg, speedSegment, msToSamples } from './_lib.js'
import { findPhrases } from '../../core/segment.js'
import { makeRng } from '../../core/rng.js'

function shapeAt(curve, u) {
  if (curve === 'quick') return Math.pow(1 - u, 2.6)
  if (curve === 'late') return 1 - Math.pow(u, 2.4)
  return 1 - u
}

const MEAN = { even: 0.5, quick: 1 / 3.6, late: 1 - 1 / 3.4 }

// A stop (up = false) or start-up (up = true) over D output samples, reading
// from source position P at the segment's first sample.
function ramp(P, D, curve, up, xfIn, xfOut) {
  const m = xfIn + D + xfOut
  const rates = new Float32Array(m)
  const gain = new Float32Array(m)
  let I = 0
  for (let k = 0; k < xfIn; k++) {
    rates[k] = up ? 0 : 1
    gain[k] = up ? 0 : 1
  }
  for (let k = 0; k < D; k++) {
    const u = (k + 0.5) / D
    let s = shapeAt(curve, up ? 1 - u : u)
    if (!(s > 0)) s = 0
    rates[xfIn + k] = s
    gain[xfIn + k] = Math.sqrt(s)
    I += s
  }
  for (let k = 0; k < xfOut; k++) {
    rates[xfIn + D + k] = up ? 1 : 0
    gain[xfIn + D + k] = up ? 1 : 0
  }
  return { seg: speedSegment(P, rates, xfIn, D, { xf: xfIn, gainCurve: gain }), I }
}

export default {
  id: 'time.tapestop',
  name: 'Tape stop',
  family: 'time',
  about: 'Your voice slows down to a dead stop, like a turntable losing power, and can start up again from standstill.',
  params: [
    {
      id: 'when',
      name: 'When',
      type: 'choice',
      def: 'end',
      options: [
        { v: 'end', name: 'At the end' },
        { v: 'phrases', name: 'Every phrase' },
        { v: 'random', name: 'Random places' },
      ],
    },
    {
      id: 'motion',
      name: 'Motion',
      type: 'choice',
      def: 'stop',
      options: [
        { v: 'stop', name: 'Slow to a stop' },
        { v: 'start', name: 'Start up from standstill' },
        { v: 'both', name: 'Start up and slow down' },
      ],
    },
    { id: 'stopMs', name: 'Stop time', type: 'number', min: 100, max: 3000, step: 10, def: 900, unit: 'ms', rand: [400, 1500] },
    {
      id: 'curve',
      name: 'Slow-down shape',
      type: 'choice',
      def: 'even',
      options: [
        { v: 'even', name: 'Steady' },
        { v: 'quick', name: 'Drops fast, then drags' },
        { v: 'late', name: 'Holds, then drops' },
      ],
    },
    { id: 'chance', name: 'How often', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [50, 100] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: true,
  cost: 2,
  process(input, p, ctx) {
    const n = prepare(input)
    if (!n) return input
    const sr = input.sr
    const ph = findPhrases(mixDown(input), sr)
    if (!ph.length) return input
    const rng = ctx && ctx.rng ? ctx.rng : makeRng('time.tapestop')
    const curve = p.curve === 'quick' || p.curve === 'late' ? p.curve : 'even'
    const mean = MEAN[curve]
    const wantStop = p.motion !== 'start'
    const wantStart = p.motion !== 'stop'
    const chance = Math.max(0, Math.min(1, (Number(p.chance) || 0) / 100))
    const D0 = msToSamples(p.stopMs, sr, 16)
    const h = msToSamples(5, sr, 1)
    const minRoom = msToSamples(30, sr, 8)
    const last = ph.length - 1
    // the events, in time order
    const events = []
    const addPhrase = (k) => {
      if (wantStart) events.push({ type: 'start', at: ph[k].start, hi: ph[k].end })
      if (wantStop) events.push({ type: 'stop', at: ph[k].end, lo: ph[k].start, gapEnd: k < last ? ph[k + 1].start : n })
    }
    if (p.when === 'phrases') {
      if (chance <= 0) return input
      for (let k = 0; k <= last; k++) if (rng.next() < chance) addPhrase(k)
      if (!events.length) addPhrase(last)
    } else if (p.when === 'random') {
      if (chance <= 0) return input
      for (let k = 0; k <= last; k++) {
        let t = ph[k].start + msToSamples(250, sr) + Math.round(-Math.log(1 - rng.next()) * 1.2 * sr)
        while (t < ph[k].end - msToSamples(150, sr)) {
          if (rng.next() < chance) events.push({ type: 'brake', at: t, hi: ph[k].end })
          t += Math.round((0.8 + -Math.log(1 - rng.next()) * 1.6) * sr)
        }
      }
      if (!events.length) {
        let best = 0
        for (let k = 1; k <= last; k++) if (ph[k].end - ph[k].start > ph[best].end - ph[best].start) best = k
        events.push({ type: 'brake', at: Math.round((ph[best].start + ph[best].end) / 2), hi: ph[best].end })
      }
    } else {
      if (wantStart) events.push({ type: 'start', at: ph[0].start, hi: ph[0].end })
      if (wantStop) events.push({ type: 'stop', at: ph[last].end, lo: ph[last].start, gapEnd: n })
    }
    // the edit list
    const segs = []
    let cur = 0
    const durFor = (room, share) => Math.min(D0, Math.floor((share * room) / mean))
    for (let e = 0; e < events.length; e++) {
      const ev = events[e]
      if (ev.type === 'start') {
        const P = Math.max(cur, ev.at)
        const room = ev.hi - P
        if (room < minRoom) continue
        const D = durFor(room, wantStop && p.when !== 'random' ? 0.45 : 0.85)
        if (D < 16) continue
        if (P > cur) segs.push(forwardSeg(cur, P - cur, h))
        const r = ramp(P, D, curve, true, h, h)
        segs.push(r.seg)
        cur = Math.round(P + r.I)
      } else if (ev.type === 'stop') {
        const lo = Math.max(cur, ev.lo)
        const room = ev.at - lo
        if (room < minRoom) continue
        const D = durFor(room, 0.85)
        if (D < 16) continue
        const r = ramp(0, D, curve, false, h, h)
        const P = Math.round(ev.at - r.I)
        if (P < cur) continue
        r.seg.at = P
        if (P > cur) segs.push(forwardSeg(cur, P - cur, h))
        segs.push(r.seg)
        // the tape stays stopped through the pause
        const gapEnd = Math.max(ev.at, Math.min(n, ev.gapEnd))
        if (gapEnd > ev.at) segs.push(silenceSeg(gapEnd - ev.at, h))
        cur = gapEnd
      } else {
        const P = ev.at
        if (P < cur + 2 * h) continue
        const room = ev.hi - P
        if (room < minRoom) continue
        segs.push(forwardSeg(cur, P - cur, h))
        let pos = P
        if (wantStop) {
          const D = durFor(room, 0.6)
          if (D >= 16) {
            const r = ramp(P, D, curve, false, h, h)
            segs.push(r.seg)
            pos = P + r.I
          }
          if (wantStart) {
            segs.push(silenceSeg(msToSamples(80 + 120 * rng.next(), sr, 1), h))
            const D2 = Math.min(Math.round(D0 * 0.6), Math.floor((0.8 * (ev.hi - pos)) / mean))
            if (D2 >= 16) {
              const r2 = ramp(pos, D2, curve, true, h, h)
              segs.push(r2.seg)
              pos += r2.I
            }
          }
        } else {
          segs.push(silenceSeg(msToSamples(60 + 60 * rng.next(), sr, 1), h))
          const D = durFor(room, 0.6)
          if (D >= 16) {
            const r = ramp(P, Math.round(D * 0.7), curve, true, h, h)
            segs.push(r.seg)
            pos = P + r.I
          }
        }
        cur = Math.round(pos)
      }
    }
    if (cur < n) segs.push(forwardSeg(cur, n - cur, h))
    if (!segs.length) return input
    const out = renderBuf(input, segs)
    if (ctx && typeof ctx.progress === 'function') ctx.progress(1)
    return out
  },
}
