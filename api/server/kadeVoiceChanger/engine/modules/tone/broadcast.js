// modules/tone/broadcast.js - tone.broadcast, an on-air voice processor.
//
// Technique: the classic layout of a broadcast audio processor, built from
// published parts:
// 1. A rumble cut, then a slow, gated automatic gain control (AGC) that rides
//    the voice toward -20 dBFS over seconds and freezes in pauses, so the
//    processor hits a quiet take and a hot take the same way and never
//    pumps up room noise between words.
// 2. A four-band split with Linkwitz-Riley 4th-order crossovers (two
//    cascaded Butterworth sections per side; Linkwitz 1976, "Active
//    crossover networks for noncoincident drivers"). The tree is made phase
//    coherent with allpass compensation (each branch gets the allpass of the
//    crossover it did not pass through), so the four bands add back to a
//    flat magnitude response.
// 3. A compressor per band (the Giannoulis-Massberg-Reiss log-domain design
//    in modules/tone/_dsp.js CompCore), with slower timing in the lows and
//    faster in the highs, thresholds set from each band's typical share of
//    a voice, automatic makeup and a per-style band balance. This is what
//    makes the sound dense and close: every band is held near full level.
// 4. Warmth (low shelf) and presence (bell) to taste, after the bands.
// 5. A lookahead brick-wall limiter (Signalsmith design, _dsp.js Limiter)
//    with a 1.5 ms lookahead that holds peaks at -1 dBFS. A slow, gated
//    level tracker in front of it learns how loud the bands came out and
//    corrects the drive, so the voice always meets the limiter at the
//    planned level (louder as density rises), whatever the voice.
// Density moves thresholds, ratios, release times and limiter drive
// together, from a light polish to the squeezed, loud on-air sound.
//
// Live: the same code on the same fixed sample grid; it reports 1.5 ms of
// latency (the limiter's lookahead). The offline render starts the AGC at
// the take's measured level, learns the drive correction on the first four
// seconds before rendering, and removes the latency; live starts both at 0
// dB and lets them settle during the first seconds.

import { bufLen } from '../../core/buf.js'
import {
  EqBank, CompCore, Limiter, LOWCUT, HIGHCUT, ALLPASS, LOWSHELF, BELL,
  clamp, poleCoef, powDb, dbLin, frameLevelsDb, percentile, runAligned, liveCopy,
} from './_dsp.js'

const LN10_20 = Math.LN10 / 20
const BW = 0.7071067811865476
const BLOCK = 128
const AGC_TARGET = -20

// band levels of a voice relative to its full-band level (measured on speech)
const REF = [-12, -2.5, -13, -28]

const STYLES = {
  announcer: { name: 'Radio announcer', hp: 70, x: [180, 1000, 4500], drive: [3, -0.5, 2.5, 4], att: [20, 10, 5, 3], rel: [320, 200, 130, 90], ratio: 1, lim: 2 },
  talk: { name: 'Talk radio', hp: 90, x: [200, 1100, 4000], drive: [1, 1, 3, 1], att: [15, 8, 4, 2], rel: [220, 140, 90, 70], ratio: 1.2, lim: 2 },
  news: { name: 'News desk', hp: 80, x: [180, 1000, 4500], drive: [0, 0, 1.5, 1], att: [25, 12, 6, 4], rel: [450, 300, 200, 160], ratio: 0.8, lim: 1 },
  late: { name: 'Late night, deep and smooth', hp: 55, x: [160, 900, 4000], drive: [5, 1, -1, -1.5], att: [30, 15, 8, 5], rel: [550, 380, 260, 200], ratio: 0.9, lim: 1 },
  sports: { name: 'Sports call', hp: 110, x: [220, 1200, 4200], drive: [0, 1, 4, 4], att: [10, 6, 3, 2], rel: [150, 90, 60, 45], ratio: 1.4, lim: 3 },
  podcast: { name: 'Podcast, gentle', hp: 75, x: [180, 1000, 5000], drive: [0.5, 0, 1, 1], att: [25, 15, 8, 5], rel: [500, 350, 250, 200], ratio: 0.6, lim: 0 },
}
const STYLE_IDS = Object.keys(STYLES)

class BroadcastProc {
  constructor(sr, p, agcDb = 0, corrDb = 0) {
    this.sr = sr
    const G = 30
    this.hp = new EqBank(sr, 1, 2, G)
    this.lo = new EqBank(sr, 3, 2, G) // LR4 low at f2, then allpass at f3
    this.hi = new EqBank(sr, 3, 2, G) // LR4 high at f2, then allpass at f1
    this.b0 = new EqBank(sr, 2, 2, G)
    this.b1 = new EqBank(sr, 2, 2, G)
    this.b2 = new EqBank(sr, 2, 2, G)
    this.b3 = new EqBank(sr, 2, 2, G)
    this.post = new EqBank(sr, 2, 2, G)
    this.comp = [new CompCore(sr), new CompCore(sr), new CompCore(sr), new CompCore(sr)]
    this.mkT = new Float64Array(4)
    this.mk = new Float64Array(4)
    this.lim = new Limiter(sr, 1.5, 60, -1)
    this.latency = this.lim.latency
    this.k = 1 - poleCoef(30, sr)
    // AGC
    this.agcP = 0
    this.agcC = poleCoef(100, sr)
    this.agcUp = 1 - Math.exp(-16 / (3 * sr))
    this.agcDown = 1 - Math.exp(-16 / (0.8 * sr))
    this.agc = clamp(agcDb, -12, 24)
    this.agcLin = dbLin(this.agc)
    this.t = 0
    // output level tracker: learns how much louder or quieter the bands
    // came out than planned, so the limiter is always driven by the same amount
    this.oP = 0
    this.oC = poleCoef(300, sr)
    this.oUp = 1 - Math.exp(-16 / (1.5 * sr))
    this.oDown = 1 - Math.exp(-16 / (0.6 * sr))
    this.corr = clamp(corrDb, -12, 12)
    this.t2 = 0
    // scratch: [channel][stage]
    const mk = () => [new Float64Array(BLOCK), new Float64Array(BLOCK)]
    this.s = mk()
    this.l = mk()
    this.h = mk()
    this.c0 = mk()
    this.c2 = mk()
    this.set(p)
    this.hp.snap()
    this.lo.snap()
    this.hi.snap()
    this.b0.snap()
    this.b1.snap()
    this.b2.snap()
    this.b3.snap()
    this.post.snap()
    this.mk.set(this.mkT)
    this.drive = this.driveT
    this.drvLin = dbLin(this.drive + this.corr)
  }

  set(p) {
    const st = STYLES[p.style] || STYLES.announcer
    const d = clamp(+p.density || 0, 0, 100) / 100
    const sr = this.sr
    const x1 = st.x[0]
    const x2 = st.x[1]
    const x3 = Math.min(st.x[2], 0.4 * sr)
    this.hp.design(0, LOWCUT, st.hp, BW, 0)
    this.lo.design(0, HIGHCUT, x2, BW, 0)
    this.lo.design(1, HIGHCUT, x2, BW, 0)
    this.lo.design(2, ALLPASS, x3, BW, 0)
    this.hi.design(0, LOWCUT, x2, BW, 0)
    this.hi.design(1, LOWCUT, x2, BW, 0)
    this.hi.design(2, ALLPASS, x1, BW, 0)
    this.b0.design(0, HIGHCUT, x1, BW, 0)
    this.b0.design(1, HIGHCUT, x1, BW, 0)
    this.b1.design(0, LOWCUT, x1, BW, 0)
    this.b1.design(1, LOWCUT, x1, BW, 0)
    this.b2.design(0, HIGHCUT, x3, BW, 0)
    this.b2.design(1, HIGHCUT, x3, BW, 0)
    this.b3.design(0, LOWCUT, x3, BW, 0)
    this.b3.design(1, LOWCUT, x3, BW, 0)
    this.post.design(0, LOWSHELF, 160, 0.7, clamp(+p.warmth || 0, -12, 12))
    this.post.design(1, BELL, 3500, 0.9, clamp(+p.presence || 0, -12, 12))
    const relScale = 1.2 - 0.7 * d
    for (let b = 0; b < 4; b++) {
      const T = AGC_TARGET + REF[b] + 4 - 20 * d
      const R = Math.max(1, (1.5 + 6 * d) * st.ratio)
      const c = this.comp[b]
      c.setup(T, R, 8, st.att[b], st.rel[b] * relScale, b === 0 ? 8 : b === 1 ? 4 : 2)
      this.mkT[b] = c.staticGr(AGC_TARGET + REF[b] + 4) + st.drive[b]
    }
    // planned level into the limiter (dBFS RMS of the voice): louder with density
    this.outT = -16 + st.lim + 8 * d
    this.driveT = this.outT - AGC_TARGET
    this.lim.setup(60 * relScale, -1)
  }

  run(chs, nch, n) {
    const two = nch > 1
    for (let i0 = 0; i0 < n; i0 += BLOCK) {
      const m = n - i0 < BLOCK ? n - i0 : BLOCK
      this._block(chs[0], two ? chs[1] : null, i0, m)
    }
  }

  _block(A, B, i0, m) {
    const nc = B ? 2 : 1
    const s = this.s
    const l = this.l
    const h = this.h
    const c0 = this.c0
    const c2 = this.c2
    for (let i = 0; i < m; i++) {
      const xa = A[i0 + i]
      s[0][i] = xa < 1e6 && xa > -1e6 ? xa : 0
      if (B) {
        const xb = B[i0 + i]
        s[1][i] = xb < 1e6 && xb > -1e6 ? xb : 0
      }
    }
    this.hp.run(s, nc, m)
    // slow gated AGC, gain updated on a fixed 16-sample grid
    const s0 = s[0]
    const s1 = s[1]
    let P = this.agcP
    const cP = this.agcC
    let gA = this.agc
    let gL = this.agcLin
    for (let i = 0; i < m; i++) {
      let x2 = s0[i] * s0[i]
      if (B) x2 = 0.5 * (x2 + s1[i] * s1[i])
      P = x2 + cP * (P - x2)
      if (P < 1e-30) P = 0
      if ((this.t & 15) === 0) {
        const lev = powDb(P) + gA
        if (lev > AGC_TARGET - 25) {
          const err = AGC_TARGET - lev
          gA += err * (err > 0 ? this.agcUp : this.agcDown)
          if (gA > 24) gA = 24
          else if (gA < -12) gA = -12
          gL = Math.exp(gA * LN10_20)
        }
      }
      this.t++
      s0[i] *= gL
      if (B) s1[i] *= gL
    }
    this.agcP = P
    this.agc = gA
    this.agcLin = gL
    // split into four bands
    for (let c = 0; c < nc; c++) {
      l[c].set(s[c])
      h[c].set(s[c])
    }
    this.lo.run(l, nc, m)
    this.hi.run(h, nc, m)
    for (let c = 0; c < nc; c++) {
      c0[c].set(l[c])
      c2[c].set(h[c])
    }
    this.b0.run(c0, nc, m) // lows
    this.b1.run(l, nc, m) // low mids
    this.b2.run(c2, nc, m) // high mids
    this.b3.run(h, nc, m) // highs
    // band compressors, linked over channels
    const k = this.k
    const mk = this.mk
    const mkT = this.mkT
    const cp0 = this.comp[0]
    const cp1 = this.comp[1]
    const cp2 = this.comp[2]
    const cp3 = this.comp[3]
    for (let i = 0; i < m; i++) {
      for (let b = 0; b < 4; b++) {
        if (mk[b] !== mkT[b]) {
          mk[b] += (mkT[b] - mk[b]) * k
          if (mk[b] - mkT[b] < 1e-7 && mk[b] - mkT[b] > -1e-7) mk[b] = mkT[b]
        }
      }
      let v0 = c0[0][i]
      let v1 = l[0][i]
      let v2 = c2[0][i]
      let v3 = h[0][i]
      let q0 = v0 * v0
      let q1 = v1 * v1
      let q2 = v2 * v2
      let q3 = v3 * v3
      if (B) {
        v0 = c0[1][i]
        v1 = l[1][i]
        v2 = c2[1][i]
        v3 = h[1][i]
        if (v0 * v0 > q0) q0 = v0 * v0
        if (v1 * v1 > q1) q1 = v1 * v1
        if (v2 * v2 > q2) q2 = v2 * v2
        if (v3 * v3 > q3) q3 = v3 * v3
      }
      const g0 = Math.exp((mk[0] - cp0.feed(q0)) * LN10_20)
      const g1 = Math.exp((mk[1] - cp1.feed(q1)) * LN10_20)
      const g2 = Math.exp((mk[2] - cp2.feed(q2)) * LN10_20)
      const g3 = Math.exp((mk[3] - cp3.feed(q3)) * LN10_20)
      s0[i] = g0 * c0[0][i] + g1 * l[0][i] + g2 * c2[0][i] + g3 * h[0][i]
      if (B) s1[i] = g0 * c0[1][i] + g1 * l[1][i] + g2 * c2[1][i] + g3 * h[1][i]
    }
    this.post.run(s, nc, m)
    // drive into the lookahead limiter: the planned drive (glides 30 ms)
    // plus the slowly learned correction, updated on a 16-sample grid
    const lim = this.lim
    let dr = this.drive
    const drT = this.driveT
    let oP = this.oP
    const oC = this.oC
    let corr = this.corr
    let gD = this.drvLin
    for (let i = 0; i < m; i++) {
      if (dr !== drT) {
        dr += (drT - dr) * k
        if (dr - drT < 1e-7 && dr - drT > -1e-7) dr = drT
      }
      let x2 = s0[i] * s0[i]
      if (B) x2 = 0.5 * (x2 + s1[i] * s1[i])
      oP = x2 + oC * (oP - x2)
      if (oP < 1e-30) oP = 0
      if ((this.t2 & 15) === 0) {
        const lev = powDb(oP)
        if (lev > AGC_TARGET - 25) {
          const err = this.outT - (lev + dr + corr)
          corr += err * (err > 0 ? this.oUp : this.oDown)
          if (corr > 12) corr = 12
          else if (corr < -12) corr = -12
        }
        gD = Math.exp((dr + corr) * LN10_20)
      }
      this.t2++
      lim.step(s0[i] * gD, B ? s1[i] * gD : 0)
      A[i0 + i] = lim.oL
      if (B) B[i0 + i] = lim.oR
    }
    this.drive = dr
    this.oP = oP
    this.corr = corr
    this.drvLin = gD
  }

  reset() {
    this.hp.reset()
    this.lo.reset()
    this.hi.reset()
    this.b0.reset()
    this.b1.reset()
    this.b2.reset()
    this.b3.reset()
    this.post.reset()
    for (let b = 0; b < 4; b++) this.comp[b].reset()
    this.lim.reset()
    this.agcP = 0
    this.oP = 0
    this.t = 0
    this.t2 = 0
  }
}

/** The AGC gain that puts the take's active speech at the AGC target. */
function primeAgc(chs, sr) {
  const lv = frameLevelsDb(chs, sr, 10, 30)
  const top = percentile(lv, 0.95)
  if (top < -90) return 0
  let e = 0
  let cnt = 0
  for (let i = 0; i < lv.length; i++) {
    if (lv[i] > top - 25) {
      e += Math.pow(10, lv[i] / 10)
      cnt++
    }
  }
  if (!cnt) return 0
  return clamp(AGC_TARGET - powDb(e / cnt), -12, 24)
}

export default {
  id: 'tone.broadcast',
  name: 'Broadcast processor',
  family: 'tone',
  about: 'The loud, close, on-air radio sound: steady level riding, four-band compression, presence and a peak limiter, from a light polish to full squeeze.',
  params: [
    { id: 'style', name: 'Station sound', type: 'choice', def: 'announcer', options: STYLE_IDS.map((v) => ({ v, name: STYLES[v].name })) },
    { id: 'density', name: 'Density', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [30, 90] },
    { id: 'warmth', name: 'Warmth', type: 'number', min: -6, max: 9, step: 0.5, def: 0, unit: 'db', rand: [-2, 4] },
    { id: 'presence', name: 'Presence', type: 'number', min: -6, max: 9, step: 0.5, def: 0, unit: 'db', rand: [-2, 4] },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 3,
  process(input, p) {
    const n = bufLen(input)
    if (!n) return input
    const two = input.ch.length > 1
    const chs = two ? [input.ch[0], input.ch[1]] : [input.ch[0]]
    const agc = primeAgc(chs, input.sr)
    // learn the output correction on the first seconds, then render for real
    const nPre = Math.min(n, Math.round(4 * input.sr))
    const pre = new BroadcastProc(input.sr, p, agc, 0)
    pre.run(chs.map((c) => c.slice(0, nPre)), chs.length, nPre)
    const proc = new BroadcastProc(input.sr, p, agc, pre.corr)
    const out = runAligned(chs, proc.latency, (c, nch, len) => proc.run(c, nch, len))
    input.ch[0] = out[0]
    if (two) input.ch[1] = out[1]
    return input
  },
  live: {
    latency(p, sr) {
      return Math.max(1, Math.round((1.5 * sr) / 1000))
    },
    create(sr, p) {
      const proc = new BroadcastProc(sr, p, 0)
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
