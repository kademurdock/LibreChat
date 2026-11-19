// modules/tone/character.js - tone.character, one-choice voice colours.
//
// Technique: each shape is a short recipe of second-order sections from the
// RBJ audio EQ cookbook (bells, shelves, cuts), the kind of starting curves
// a broadcast or film mixer reaches for: a radio voice with chest and
// presence, close and warm, nasal, boomy, telephone, behind a pillow and so
// on. "Strength" scales every bell and shelf gain in decibels and slides
// every cut along a log axis from out of the way (10 Hz or the top of the
// band) to its place, so 0 percent is flat and 100 percent is the full
// shape. "Keep the volume steady" measures the shape's own response against
// a typical speech spectrum (about -6 dB per octave above 500 Hz, flat
// below, the long-term average shape of talking) at 32 points and corrects
// the level (modules/tone/_dsp.js SpeechWeight), so the colour changes and
// the loudness does not. Offline the take's own integrated loudness (BS.1770)
// is measured before and after and matched exactly, which also suits a deep
// voice or a bright one that is far from the average speech shape.
//
// Live: same bank, coefficients glide on a fixed grid, so a shape change
// morphs smoothly. Live cannot measure the whole take, so with "Keep the
// volume steady" on it starts from the speech-weighted estimate and then
// matches loudness as you talk (modules/tone/_dsp.js LoudMatch), settling
// within a second or two; with it off, live equals the offline render.

import { bufLen } from '../../core/buf.js'
import { lufs, kWeightingCoefs } from '../../core/loudness.js'
import { EqBank, GainGlide, SpeechWeight, LoudMatch, BELL, LOWSHELF, HIGHSHELF, LOWCUT, HIGHCUT, OFF, safety, matchLoudness, liveCopy } from './_dsp.js'

const B = BELL
const LS = LOWSHELF
const HS = HIGHSHELF
const HP = LOWCUT
const LP = HIGHCUT

// [type, freq, q, gainDb]
const SHAPES = {
  radio: { name: 'Radio voice', bands: [[HP, 75, 0.71, 0], [LS, 140, 0.7, 3], [B, 400, 1, -3], [B, 2800, 0.9, 3.5], [HS, 8500, 0.7, 2.5]] },
  warm: { name: 'Warm and close', bands: [[LS, 200, 0.6, 4.5], [B, 450, 1, 1], [B, 3200, 1.2, -2.5], [HS, 7500, 0.7, -3.5]] },
  bright: { name: 'Bright and airy', bands: [[HP, 90, 0.71, 0], [B, 300, 1, -2], [B, 4500, 1, 2], [HS, 8000, 0.6, 6]] },
  presence: { name: 'Presence', bands: [[B, 250, 1.2, -2], [B, 4200, 0.8, 5.5], [HS, 10000, 0.7, 1.5]] },
  deep: { name: 'Deep and full', bands: [[LS, 120, 0.7, 5], [B, 300, 0.8, 2], [B, 2500, 1, -1.5]] },
  forward: { name: 'Loud and forward', bands: [[LS, 150, 0.7, -2], [B, 1800, 0.9, 4], [B, 5000, 1.2, 3]] },
  scooped: { name: 'Scooped', bands: [[LS, 140, 0.7, 5], [B, 900, 0.6, -6], [HS, 6000, 0.7, 5]] },
  nasal: { name: 'Nasal', bands: [[LS, 300, 0.7, -6], [B, 900, 3, 9], [B, 2000, 4, 4], [HS, 5000, 0.7, -5]] },
  honky: { name: 'Honky', bands: [[HP, 180, 0.71, 0], [B, 650, 2, 10], [B, 1300, 3, 4], [HS, 4000, 0.7, -4]] },
  boxy: { name: 'Boxy', bands: [[B, 200, 1, -2], [B, 450, 1.6, 8], [HS, 6000, 0.7, -3]] },
  thin: { name: 'Thin', bands: [[HP, 350, 0.9, 0], [LS, 700, 0.7, -6], [B, 3000, 1, 3]] },
  tinny: { name: 'Tinny', bands: [[HP, 900, 0.8, 0], [B, 2800, 1.5, 8], [LP, 7000, 0.71, 0]] },
  boomy: { name: 'Boomy', bands: [[B, 110, 1.1, 7], [LS, 220, 0.7, 4], [HS, 4500, 0.7, -5]] },
  phone: { name: 'Telephone', bands: [[HP, 320, 0.71, 0], [HP, 320, 0.71, 0], [LP, 3300, 0.71, 0], [LP, 3300, 0.71, 0], [B, 1700, 1, 4]] },
  muffled: { name: 'Muffled, behind a pillow', bands: [[LP, 1100, 0.71, 0], [LP, 1100, 0.71, 0], [LS, 250, 0.7, 2]] },
  dark: { name: 'Dark', bands: [[LS, 200, 0.7, 2], [HS, 2500, 0.5, -12]] },
}
const SHAPE_IDS = Object.keys(SHAPES)
const SLOTS = 5

class CharProc {
  constructor(sr, p) {
    this.sr = sr
    this.bank = new EqBank(sr, SLOTS, 2, 30)
    this.out = new GainGlide(sr, 30)
    this.meter = new SpeechWeight(sr)
    this.match = null
    this.est = 1
    this.steady = true
    this.set(p)
    this.bank.snap()
    this.out.to(this.out.gt, true)
  }

  set(p) {
    const sh = SHAPES[p.shape] || SHAPES.radio
    const a = Math.max(0, Math.min(1, (+p.amount || 0) / 100))
    const top = Math.min(22000, 0.47 * this.sr)
    const bands = sh.bands
    for (let s = 0; s < SLOTS; s++) {
      if (s >= bands.length || a === 0) {
        this.bank.design(s, OFF, 1000, 1, 0)
        continue
      }
      const bd = bands[s]
      const type = bd[0]
      let f = bd[1]
      if (type === HP) f = Math.exp(Math.log(10) + (Math.log(f) - Math.log(10)) * a)
      else if (type === LP) f = Math.exp(Math.log(top) + (Math.log(Math.min(f, top)) - Math.log(top)) * a)
      this.bank.design(s, type, f, bd[2], bd[3] * a)
    }
    // speech-weighted level of the target response
    this.steady = p.steady !== false && a > 0
    this.est = this.steady ? this.meter.correction(this.bank.tgt, SLOTS) : 1
    if (this.match) this.match.restart(this.est)
    this.out.to(this.est)
  }

  run(chs, nch, n) {
    const m = this.steady ? this.match : null
    if (!m) {
      this.bank.run(chs, nch, n)
      this.out.apply(chs, nch, n)
      safety(chs, nch, n)
      return
    }
    // live: work in pieces that end on the loudness window grid
    let off = 0
    while (off < n) {
      let len = m.toBoundary()
      if (len > n - off) len = n - off
      m.measureIn(chs, nch, len, off)
      this.bank.run(chs, nch, len, off)
      m.measureRaw(chs, nch, len, off)
      this.out.apply(chs, nch, len, off)
      if (m.endWindow()) this.out.to(m.gain())
      off += len
    }
    safety(chs, nch, n)
  }

  reset() {
    this.bank.reset()
  }
}

export default {
  id: 'tone.character',
  name: 'Character',
  family: 'tone',
  about: 'Instant voice colours in one choice: radio voice, warm and close, bright and airy, nasal, boomy, telephone, muffled and more.',
  params: [
    { id: 'shape', name: 'Colour', type: 'choice', def: 'radio', options: SHAPE_IDS.map((v) => ({ v, name: SHAPES[v].name })) },
    { id: 'amount', name: 'Strength', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [60, 100] },
    { id: 'steady', name: 'Keep the volume steady', type: 'bool', def: true },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 1,
  process(input, p) {
    const n = bufLen(input)
    if (!n) return input
    const steady = p.steady !== false && +p.amount > 0
    const before = steady ? lufs(input) : -200
    new CharProc(input.sr, p).run(input.ch, input.ch.length, n)
    if (steady) matchLoudness(input, before, lufs)
    return input
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p) {
      const proc = new CharProc(sr, p)
      proc.match = new LoudMatch(sr, kWeightingCoefs(sr))
      proc.match.restart(proc.est)
      return {
        process(ins, outs, n) {
          proc.run(outs, liveCopy(ins, outs, n), n)
        },
        set(np) {
          proc.set(np)
        },
        reset() {
          proc.reset()
        },
      }
    },
  },
}
