// stereo.double - Double-track: the same line sung or said again, panned apart.
//
// Technique: the studio double track, and its tape imitation, automatic
// double tracking (Townsend's varispeed tape delay, 1966; described in every
// recording handbook). A second take of a voice differs from the first by a
// few tens of milliseconds of timing, which moves word by word, and by a few
// cents of tuning, which wanders. Panned apart, the two takes make one wide,
// thick voice.
//
// Offline, each copy is made the way a real second take differs:
// - tuning: core/voice.js shiftVoice (pitch-synchronous overlap-add) by a
//   fixed few cents plus a slow wander, with a hair of timbre change, so the
//   copy is a slightly different singer rather than a chorus;
// - timing: a phrase-aware delay track (see _lib.js phraseDelayTrack) that
//   re-draws each copy's lateness in every pause and only drifts slowly
//   inside phrases, so the read speed never bends the pitch audibly.
// Live, the copies are delay lines whose delay wanders smoothly (short
// delays only, at most about 60 ms): the slow wander gives the timing and a
// faster, tiny wander gives the tuning, as tape double tracking did.
// Copies sit evenly across the stereo field with equal-power panning; with
// one copy the original goes left and the copy right, the classic hard double.

import { shiftVoice } from '../../core/voice.js'
import { trackPitch } from '../../core/pitch.js'
import { findPhrases } from '../../core/segment.js'
import { DelayLine } from '../../core/delay.js'
import { makeRng } from '../../core/rng.js'
import { clamp, finite, monoOf, makeWander, phraseDelayTrack, trackAt, readCubic, panGains, cleanSig } from './_lib.js'

const MAX_COPIES = 4

function slotPans(voices, spread) {
  const s = clamp(spread, 0, 100) / 100
  const out = new Float64Array(voices)
  for (let k = 0; k < voices; k++) out[k] = voices === 1 ? 0 : s * (-1 + (2 * k) / (voices - 1))
  return out
}

function originalSlot(voices) {
  return Math.floor((voices - 1) / 2)
}

function copyLevel(p) {
  return Math.pow(10, clamp(finite(p.level, -2), -18, 0) / 20)
}

function maxDelayMs(timing) {
  return 6 + 1.75 * timing
}

// ---------------------------------------------------------------- live

class DoubleLive {
  constructor(sr, p, rng) {
    this.sr = sr
    this.rng = rng.fork('double-live')
    const maxMs = maxDelayMs(30) + 12
    this.lines = []
    for (let c = 0; c < MAX_COPIES; c++) this.lines.push(new DelayLine(Math.ceil((maxMs / 1000) * sr) + 8))
    this.orig = new DelayLine(16)
    // per copy: base delay (target, current), wander states (timing, tuning)
    this.tBase = new Float64Array(MAX_COPIES)
    this.cBase = new Float64Array(MAX_COPIES)
    this.tAmp = new Float64Array(MAX_COPIES) // timing wander amplitude, samples
    this.pAmp = new Float64Array(MAX_COPIES) // tuning wander amplitude, samples
    this.tPh = new Float64Array(MAX_COPIES)
    this.tA = new Float64Array(MAX_COPIES)
    this.tB = new Float64Array(MAX_COPIES)
    this.tInc = new Float64Array(MAX_COPIES)
    this.pPh = new Float64Array(MAX_COPIES)
    this.pA = new Float64Array(MAX_COPIES)
    this.pB = new Float64Array(MAX_COPIES)
    this.pInc = new Float64Array(MAX_COPIES)
    this.tgL = new Float64Array(MAX_COPIES + 1)
    this.tgR = new Float64Array(MAX_COPIES + 1)
    this.cgL = new Float64Array(MAX_COPIES + 1)
    this.cgR = new Float64Array(MAX_COPIES + 1)
    this.pan = new Float64Array(2)
    this.rand = new Float64Array(MAX_COPIES)
    for (let c = 0; c < MAX_COPIES; c++) {
      this.rand[c] = this.rng.next()
      this.tPh[c] = this.rng.next()
      this.pPh[c] = this.rng.next()
      this.tA[c] = this.rng.next() * 2 - 1
      this.tB[c] = this.rng.next() * 2 - 1
      this.pA[c] = this.rng.next() * 2 - 1
      this.pB[c] = this.rng.next() * 2 - 1
    }
    this.gc = Math.exp(-1 / (0.02 * sr))
    this.dc = Math.exp(-1 / (0.08 * sr))
    this.set(p, true)
  }

  set(p, snap) {
    const sr = this.sr
    const copies = clamp(Math.round(finite(p.copies, 2)), 1, MAX_COPIES)
    const timing = clamp(finite(p.timing, 18), 0, 60)
    const tl = Math.min(timing, 30)
    const cents = clamp(finite(p.pitch, 10), 0, 40)
    const r = Math.pow(2, cents / 1200) - 1
    const voices = copies + 1
    const pans = slotPans(voices, finite(p.spread, 85))
    const os = originalSlot(voices)
    const lvl = copyLevel(p)
    const norm = 1 / Math.sqrt(1 + 0.5 * copies * lvl * lvl)
    panGains(pans[os], this.pan)
    this.tgL[MAX_COPIES] = this.pan[0] * norm
    this.tgR[MAX_COPIES] = this.pan[1] * norm
    let slot = 0
    for (let c = 0; c < MAX_COPIES; c++) {
      if (c < copies) {
        if (slot === os) slot++
        panGains(pans[slot], this.pan)
        slot++
        this.tgL[c] = this.pan[0] * lvl * norm
        this.tgR[c] = this.pan[1] * lvl * norm
      } else {
        this.tgL[c] = 0
        this.tgR[c] = 0
      }
      this.tBase[c] = ((5 + tl * (0.35 + 0.65 * this.rand[c])) / 1000) * sr
      // timing wander: amplitude 0.4 * timing, slope held under 0.3 percent
      const aT = (0.4 * tl) / 1000
      const spT = Math.max(1.5, (Math.PI * aT) / 0.003)
      this.tAmp[c] = aT * sr
      this.tInc[c] = 1 / (spT * sr)
      // tuning wander: a smooth random whose slope reaches the wanted cents
      const spP = 0.9 + 0.5 * this.rand[c]
      this.pAmp[c] = ((r * spP) / Math.PI) * sr
      this.pInc[c] = 1 / (spP * sr)
    }
    if (snap) {
      for (let c = 0; c <= MAX_COPIES; c++) {
        this.cgL[c] = this.tgL[c]
        this.cgR[c] = this.tgR[c]
      }
      for (let c = 0; c < MAX_COPIES; c++) this.cBase[c] = this.tBase[c]
    }
  }

  reset() {
    for (let c = 0; c < MAX_COPIES; c++) this.lines[c].clear()
  }

  process(ins, outs, n) {
    const two = ins.length > 1
    const outTwo = outs.length > 1
    const gc = this.gc, dc = this.dc
    const rng = this.rng
    for (let i = 0; i < n; i++) {
      let x = ins[0][i]
      if (!(x > -1e30 && x < 1e30)) x = 0
      if (two) {
        let y = ins[1][i]
        if (!(y > -1e30 && y < 1e30)) y = 0
        x = 0.5 * (x + y)
      }
      this.cgL[MAX_COPIES] = this.tgL[MAX_COPIES] + (this.cgL[MAX_COPIES] - this.tgL[MAX_COPIES]) * gc
      this.cgR[MAX_COPIES] = this.tgR[MAX_COPIES] + (this.cgR[MAX_COPIES] - this.tgR[MAX_COPIES]) * gc
      let l = x * this.cgL[MAX_COPIES]
      let r = x * this.cgR[MAX_COPIES]
      for (let c = 0; c < MAX_COPIES; c++) {
        const line = this.lines[c]
        line.write(x)
        this.cgL[c] = this.tgL[c] + (this.cgL[c] - this.tgL[c]) * gc
        this.cgR[c] = this.tgR[c] + (this.cgR[c] - this.tgR[c]) * gc
        this.cBase[c] = this.tBase[c] + (this.cBase[c] - this.tBase[c]) * dc
        // timing wander
        let ph = this.tPh[c] + this.tInc[c]
        if (ph >= 1) {
          ph -= 1
          this.tA[c] = this.tB[c]
          this.tB[c] = rng.next() * 2 - 1
        }
        this.tPh[c] = ph
        const wt = this.tA[c] + (this.tB[c] - this.tA[c]) * (0.5 - 0.5 * Math.cos(Math.PI * ph))
        // tuning wander
        let pp = this.pPh[c] + this.pInc[c]
        if (pp >= 1) {
          pp -= 1
          this.pA[c] = this.pB[c]
          this.pB[c] = rng.next() * 2 - 1
        }
        this.pPh[c] = pp
        const wp = this.pA[c] + (this.pB[c] - this.pA[c]) * (0.5 - 0.5 * Math.cos(Math.PI * pp))
        if (this.cgL[c] < 1e-6 && this.cgR[c] < 1e-6) continue
        let d = this.cBase[c] + this.tAmp[c] * wt + this.pAmp[c] * (1 + wp)
        if (d < 1) d = 1
        const v = line.read(d)
        l += v * this.cgL[c]
        r += v * this.cgR[c]
      }
      if (outTwo) {
        outs[0][i] = l
        outs[1][i] = r
      } else {
        outs[0][i] = 0.5 * (l + r)
      }
    }
  }
}

// ---------------------------------------------------------------- module

export default {
  id: 'stereo.double',
  name: 'Double-track',
  family: 'stereo',
  about: 'Your voice recorded again and again, each take a little early or late and a little off pitch, spread wide.',
  params: [
    { id: 'copies', name: 'Extra takes', type: 'number', min: 1, max: 4, step: 1, def: 2, unit: 'count', noun: ['take', 'takes'], rand: [1, 3] },
    { id: 'timing', name: 'Timing looseness', type: 'number', min: 0, max: 60, step: 1, def: 18, unit: 'ms', rand: [8, 35] },
    { id: 'pitch', name: 'Tuning looseness', type: 'number', min: 0, max: 40, step: 1, def: 10, unit: 'cents', rand: [4, 18] },
    { id: 'spread', name: 'Spread', type: 'number', min: 0, max: 100, step: 1, def: 85, unit: 'percent', rand: [55, 100] },
    { id: 'level', name: 'Extra takes level', type: 'number', min: -18, max: 0, step: 0.5, def: -2, unit: 'db', rand: [-6, 0] },
  ],
  stereo: 'make',
  tail: (p) => maxDelayMs(clamp(finite(p && p.timing, 18), 0, 60)) / 1000 + 0.01,
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    const sr = input.sr
    const x = monoOf(input)
    const n = x.length
    if (n === 0) return { sr, ch: [new Float32Array(0), new Float32Array(0)] }
    const R0 = (ctx && ctx.rng ? ctx.rng : makeRng('stereo.double')).fork('double')
    const copies = clamp(Math.round(finite(p.copies, 2)), 1, MAX_COPIES)
    const timing = clamp(finite(p.timing, 18), 0, 60)
    const cents = clamp(finite(p.pitch, 10), 0, 40)
    const voices = copies + 1
    const pans = slotPans(voices, finite(p.spread, 85))
    const os = originalSlot(voices)
    const lvl = copyLevel(p)
    const norm = 1 / Math.sqrt(1 + 0.5 * copies * lvl * lvl)
    const extra = Math.ceil((maxDelayMs(timing) / 1000) * sr) + 4
    const nOut = n + extra
    const L = new Float32Array(nOut)
    const R = new Float32Array(nOut)
    const g2 = new Float64Array(2)
    // the original
    panGains(pans[os], g2)
    if (input.ch.length > 1) {
      // a stereo original keeps its own image
      const a = input.ch[0], b = input.ch[1]
      for (let i = 0; i < n; i++) {
        const va = a[i], vb = b[i]
        L[i] = (va > -1e30 && va < 1e30 ? va : 0) * norm
        R[i] = (vb > -1e30 && vb < 1e30 ? vb : 0) * norm
      }
    } else {
      for (let i = 0; i < n; i++) {
        L[i] = x[i] * g2[0] * norm
        R[i] = x[i] * g2[1] * norm
      }
    }
    const track = trackPitch(x, sr)
    const phrases = findPhrases(x, sr)
    let slot = 0
    for (let c = 0; c < copies; c++) {
      if (ctx && typeof ctx.cancelled === 'function' && ctx.cancelled()) break
      const cr = R0.fork('copy' + c)
      const sign = c % 2 === 0 ? 1 : -1
      const off = sign * cents * (0.55 + 0.45 * cr.next())
      const wc = 0.5 * cents
      const wander = makeWander(cr, n / sr + 1, 0.5 + 0.3 * cr.next())
      const fmt = cents > 0 ? -sign * Math.min(0.35, cents / 60) * (0.5 + 0.5 * cr.next()) : 0
      const semis = cents > 0 ? (t) => (off + wc * wander.at(t)) / 100 : 0
      const y = cents > 0 || fmt !== 0 ? shiftVoice(x, sr, { semitones: semis, formant: fmt, track, seed: 'double' + c }) : x
      const base = ((5 + timing * (0.35 + 0.65 * cr.next())) / 1000) * sr
      const dt = phraseDelayTrack(nOut, sr, phrases, cr, {
        base,
        perPhrase: ((0.5 * timing) / 1000) * sr,
        wander: ((0.25 * timing) / 1000) * sr,
        minDelay: 0.003 * sr,
        maxSlope: 0.003,
      })
      if (slot === os) slot++
      panGains(pans[slot], g2)
      slot++
      const gv = lvl * norm * Math.pow(10, (cr.next() * 2 - 1) / 20)
      const gl = g2[0] * gv, gr = g2[1] * gv
      const tr = dt.track
      for (let i = 0; i < nOut; i++) {
        const v = readCubic(y, i - trackAt(tr, i))
        L[i] += v * gl
        R[i] += v * gr
      }
      if (ctx && typeof ctx.progress === 'function') ctx.progress((c + 1) / copies)
    }
    return { sr, ch: [cleanSig(L), cleanSig(R)] }
  },
  live: {
    latency: () => 0,
    create(sr, p, rng) {
      const r = rng && typeof rng.fork === 'function' ? rng : makeRng('stereo.double')
      return new DoubleLive(sr, p, r)
    },
  },
}
