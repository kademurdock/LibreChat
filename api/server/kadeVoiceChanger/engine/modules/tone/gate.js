// modules/tone/gate.js - tone.gate, a noise gate for the pauses.
//
// Technique: a downward gate with lookahead, hysteresis and hold, the
// standard design found in broadcast and studio gates (described, for
// example, in Giannoulis, Massberg and Reiss 2012 for the detector side and
// in Udo Zoelzer's "DAFX: Digital Audio Effects", chapter 4, "Noise gate").
// A short mean-square detector (0.5 ms rise, 15 ms fall, so it reads the
// level the way the threshold is measured, not the noise's own spikes)
// reads the sound 3 ms ahead of what you hear, so the gate is already open
// when a word starts and no consonant is clipped. It opens at the
// threshold and closes only after the level has fallen 6 dB below it and
// the hold time has passed. The volume
// moves in a straight line in decibels, all the way in "Opening time" and
// all the way down in "Closing time" (the way an analog gate's exponential
// fade sounds), so pauses fade down naturally instead of chopping, and
// "Quiet the pauses by" sets how far they go (a gentle 20 dB keeps a
// little room tone; 80 dB is silence).
//
// "Set the level for me" measures the take first (offline): the noise
// floor is the quiet tenth of 10 ms levels, the voice is the loud end, and
// the threshold sits a third of the way up from the floor (at least 8 dB
// above it). Live, the same rule runs on a floor and a peak that are
// tracked as you talk.
//
// Live: reports 3 ms of latency. With "Set the level for me" off, the live
// output equals the offline render delayed by that latency.

import { bufLen } from '../../core/buf.js'
import { clamp, poleCoef, frameLevelsDb, percentile, runAligned, liveCopy, powDb } from './_dsp.js'

const LN10_20 = Math.LN10 / 20
const LOOK_MS = 3
const HYST = 6

function lookN(sr) {
  return Math.max(1, Math.round((LOOK_MS * sr) / 1000))
}

class GateProc {
  constructor(sr, p, fixedThr) {
    this.sr = sr
    this.L = lookN(sr)
    this.dlA = new Float64Array(this.L + 1)
    this.dlB = new Float64Array(this.L + 1)
    this.pos = 0
    this.env = 0
    this.da = poleCoef(0.5, sr)
    this.dr = poleCoef(15, sr)
    this.open = false
    this.hold = 0
    this.fixedThr = fixedThr // measured threshold (offline) or NaN
    // live level tracker
    this.blk = Math.max(1, Math.round(0.01 * sr))
    this.acc = 0
    this.cnt = 0
    this.floor = -70
    this.peak = -20
    this.set(p)
    this.gDb = this.floorDb
  }

  set(p) {
    this.auto = p.auto === true
    this.manualThr = clamp(+p.threshold, -90, 0)
    this.floorDb = -clamp(+p.reduce, 0, 120)
    // decibels per sample for a full open or a full close (at least 12 dB
    // worth, so a live change of the depth still glides home)
    const span = Math.max(12, -this.floorDb)
    this.up = span / Math.max(1, (clamp(+p.attack, 0.01, 1000) * this.sr) / 1000)
    this.down = span / Math.max(1, (clamp(+p.release, 1, 10000) * this.sr) / 1000)
    this.holdN = Math.round((clamp(+p.hold, 0, 5000) * this.sr) / 1000)
    this._thr()
  }

  _thr() {
    let T = this.manualThr
    if (this.auto) {
      if (this.fixedThr === this.fixedThr) T = this.fixedThr
      else T = clamp(this.floor + Math.max(8, 0.35 * (this.peak - this.floor)), -80, this.peak - 15)
    }
    // the detector is a mean square, so the thresholds are powers
    this.openP = Math.exp(T * 2 * LN10_20)
    this.closeP = Math.exp((T - HYST) * 2 * LN10_20)
  }

  run(chs, nch, n) {
    const A = chs[0]
    const B = nch > 1 ? chs[1] : null
    const L = this.L
    const dlA = this.dlA
    const dlB = this.dlB
    const tracking = this.auto && !(this.fixedThr === this.fixedThr)
    let env = this.env
    let gDb = this.gDb
    for (let i = 0; i < n; i++) {
      let xa = A[i]
      if (!(xa < 1e6 && xa > -1e6)) xa = 0
      let xb = 0
      let a = xa < 0 ? -xa : xa
      if (B) {
        xb = B[i]
        if (!(xb < 1e6 && xb > -1e6)) xb = 0
        const ab = xb < 0 ? -xb : xb
        if (ab > a) a = ab
      }
      if (tracking) {
        this.acc += a * a
        this.cnt++
        if (this.cnt === this.blk) {
          const lv = powDb(this.acc / this.cnt)
          if (lv > -150) {
            this.floor = lv < this.floor ? lv : this.floor + 0.03
            this.peak = lv > this.peak ? lv : this.peak - 0.06
            if (this.peak < this.floor + 10) this.peak = this.floor + 10
          }
          this.acc = 0
          this.cnt = 0
          this._thr()
        }
      }
      const a2 = a * a
      env = a2 > env ? a2 + this.da * (env - a2) : a2 + this.dr * (env - a2)
      if (env < 1e-30) env = 0
      if (env >= this.openP) {
        this.open = true
        this.hold = this.holdN
      } else if (this.open) {
        if (env < this.closeP) {
          if (this.hold > 0) this.hold--
          else this.open = false
        } else this.hold = this.holdN
      }
      const target = this.open ? 0 : this.floorDb
      if (gDb < target) {
        gDb += this.up
        if (gDb > target) gDb = target
      } else if (gDb > target) {
        gDb -= this.down
        if (gDb < target) gDb = target
      }
      const g = gDb > -1e-6 ? 1 : gDb < -150 ? 0 : Math.exp(gDb * LN10_20)
      // lookahead: the gain lands on the sample read L samples ago
      const w = this.pos % (L + 1)
      const r = (this.pos + 1) % (L + 1)
      dlA[w] = xa
      A[i] = dlA[r] * g
      if (B) {
        dlB[w] = xb
        B[i] = dlB[r] * g
      }
      this.pos++
    }
    this.env = env
    this.gDb = gDb
  }

  reset() {
    this.dlA.fill(0)
    this.dlB.fill(0)
    this.env = 0
    this.open = false
    this.hold = 0
    this.gDb = this.floorDb
  }
}

/** Offline threshold from the take's own noise floor and voice level, or NaN. */
function measureThreshold(chs, sr) {
  const lv = frameLevelsDb(chs, sr, 10, 20)
  const nz = []
  for (let i = 0; i < lv.length; i++) if (lv[i] > -150) nz.push(lv[i])
  if (nz.length < 5) return NaN
  const noise = percentile(nz, 0.1)
  const voice = percentile(nz, 0.97)
  if (voice < -90) return NaN
  return clamp(noise + Math.max(8, 0.35 * (voice - noise)), -80, voice - 15)
}

export default {
  id: 'tone.gate',
  name: 'Noise gate',
  family: 'tone',
  about: 'Quiets the pauses between your words so hiss and room noise drop away, and opens a moment before each word so nothing is clipped.',
  params: [
    { id: 'auto', name: 'Set the level for me', type: 'bool', def: true },
    { id: 'threshold', name: 'Threshold, when set by hand', type: 'number', min: -80, max: -10, step: 0.5, def: -45, unit: 'db' },
    { id: 'reduce', name: 'Quiet the pauses by', type: 'number', min: 0, max: 80, step: 1, def: 36, unit: 'db' },
    { id: 'attack', name: 'Opening time', type: 'number', min: 0.1, max: 50, step: 0.1, def: 1, unit: 'ms' },
    { id: 'hold', name: 'Hold open', type: 'number', min: 0, max: 500, step: 5, def: 60, unit: 'ms' },
    { id: 'release', name: 'Closing time', type: 'number', min: 5, max: 2000, step: 5, def: 120, unit: 'ms' },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 1,
  surprise: false,
  process(input, p) {
    const n = bufLen(input)
    if (!n) return input
    const two = input.ch.length > 1
    const chs = two ? [input.ch[0], input.ch[1]] : [input.ch[0]]
    const thr = p.auto === true ? measureThreshold(chs, input.sr) : NaN
    const proc = new GateProc(input.sr, p, thr)
    const out = runAligned(chs, proc.L, (c, nch, len) => proc.run(c, nch, len))
    input.ch[0] = out[0]
    if (two) input.ch[1] = out[1]
    return input
  },
  live: {
    latency(p, sr) {
      return lookN(sr)
    },
    create(sr, p) {
      const proc = new GateProc(sr, p, NaN)
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
