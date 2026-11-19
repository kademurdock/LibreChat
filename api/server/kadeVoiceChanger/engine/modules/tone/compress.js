// modules/tone/compress.js - tone.compress, a voice compressor.
//
// Technique: the feed-forward, log-domain compressor of Giannoulis,
// Massberg and Reiss, "Digital Dynamic Range Compressor Design - A Tutorial
// and Analysis" (JAES 2012): a 2 ms mean-square detector, a static gain
// computer with a quadratic soft knee, and branching attack/release
// smoothing of the gain reduction in decibels, which keeps attack and
// release times the same at every level (the even, unpumped sound speech
// wants). Stereo is channel-linked so the image never wanders.
//
// "Automatic makeup" adds back the reduction the compressor would apply to
// a steady -15 dBFS signal, about where the loud parts of a well recorded
// voice sit, so loud words stay about as loud and the quiet ones come up.
// With it on, "Makeup volume" trims up or down from that automatic level,
// and the two together never add more than 24 dB, the most the makeup knob
// gives on its own. Without that budget a low threshold and a high ratio
// asked for 40 dB of automatic makeup, and the manual makeup stacked on top
// reached 50 to 66 dB: pauses came up by the same amount, and the onsets a
// slow attack lets through ran into the soft ceiling and distorted.
//
// Big jumps are caught quickly. After a long pause the compressor has let
// go entirely, and with a slow attack the first word came through with the
// whole makeup gain and none of the reduction: 25 to 30 dB louder than the
// voice around it. So the reduction is never allowed to lag more than 15 dB
// behind the compression curve: a second, 1 ms follower tracks the curve
// minus 15 dB and the larger of the two reductions wins (program-dependent
// attack, as in the classic optical and FET compressors). Below that gap,
// which covers the defaults and every ordinary setting, the compressor is
// exactly the textbook one; above it a word still punches, by 15 dB.
//
// A backstop limiter sits at the very end: the lookahead brick-wall limiter
// of _dsp.js (Signalsmith design, 1.5 ms lookahead, 60 ms release) with its
// ceiling at +6 dBFS, 6 dB under the soft ceiling every stage has. Sensible
// settings never reach it (the defaults peak near +1.5 dBFS on speech); it
// keeps the makeup knob used as a 24 dB boost, or a hard edit cut straight
// into a loud word, clean instead of distorted.
// "Mix" blends the untouched voice back in (parallel or New York style
// compression: density without squashing); the blend happens before the
// limiter's delay, so it never combs.
//
// Live: the same per-sample code, so the live output equals the offline
// render delayed by the limiter's lookahead (the reported latency); volume
// moves glide over 20 ms.

import { bufLen } from '../../core/buf.js'
import { CompCore, Limiter, clamp, poleCoef, safety, liveCopy, runAligned } from './_dsp.js'

const LN10_20 = Math.LN10 / 20
// The most makeup gain, in dB, the module ever applies: automatic plus manual.
const MAX_MAKEUP_DB = 24
// The steady level, in dBFS, whose reduction automatic makeup gives back.
const AUTO_REF_DB = -15
// The most the smoothed reduction may lag behind the curve, and how fast the catch acts.
const JUMP_DB = 15
const JUMP_ATTACK_MS = 1
// The backstop limiter: lookahead, release and ceiling (dBFS).
const GUARD_LOOK_MS = 1.5
const GUARD_RELEASE_MS = 60
const GUARD_CEILING_DB = 6

function guardLatency(sr) {
  return Math.max(1, Math.round((GUARD_LOOK_MS * sr) / 1000))
}

/** Total makeup in dB for resolved params: manual alone, or automatic plus the manual trim, within the budget. */
function makeupDb(core, p) {
  let mk = clamp(+p.makeup || 0, -12, MAX_MAKEUP_DB)
  if (p.autoMakeup !== false) mk += core.staticGr(AUTO_REF_DB)
  return mk > MAX_MAKEUP_DB ? MAX_MAKEUP_DB : mk
}

class CompProc {
  constructor(sr, p) {
    this.core = new CompCore(sr)
    this.k = 1 - poleCoef(20, sr)
    this.cj = poleCoef(JUMP_ATTACK_MS, sr)
    this.j = 0
    this.lim = new Limiter(sr, GUARD_LOOK_MS, GUARD_RELEASE_MS, GUARD_CEILING_DB)
    this.latency = this.lim.latency
    this.set(p)
    this.mk = this.mkT
    this.mix = this.mixT
  }

  set(p) {
    const T = clamp(+p.threshold, -80, 0)
    const R = clamp(+p.ratio || 1, 1, 100)
    const W = clamp(+p.knee || 0, 0, 40)
    this.core.setup(T, R, W, clamp(+p.attack || 0.1, 0.05, 2000), clamp(+p.release || 10, 1, 10000), 2)
    this.mkT = makeupDb(this.core, p)
    this.mixT = clamp(+p.mix, 0, 100) / 100
  }

  run(chs, nch, n) {
    const core = this.core
    const k = this.k
    const a = chs[0]
    const b = nch > 1 ? chs[1] : null
    let mk = this.mk
    let mix = this.mix
    const mkT = this.mkT
    const mixT = this.mixT
    const cj = this.cj
    const cr = core.cr
    const lim = this.lim
    let j = this.j
    for (let i = 0; i < n; i++) {
      if (mk !== mkT) {
        mk += (mkT - mk) * k
        if (mk - mkT < 1e-7 && mk - mkT > -1e-7) mk = mkT
      }
      if (mix !== mixT) {
        mix += (mixT - mix) * k
        if (mix - mixT < 1e-7 && mix - mixT > -1e-7) mix = mixT
      }
      let xa = a[i]
      if (!(xa < 1e6 && xa > -1e6)) xa = 0
      let x2 = xa * xa
      let xb = 0
      if (b) {
        xb = b[i]
        if (!(xb < 1e6 && xb > -1e6)) xb = 0
        if (xb * xb > x2) x2 = xb * xb
      }
      let gr = core.feed(x2)
      // the catch for big jumps: attacks in 1 ms, lets go at the release time
      const over = core.want - JUMP_DB
      j = over > j ? over + cj * (j - over) : over + cr * (j - over)
      if (j < 1e-9) j = 0
      if (j > gr) gr = j
      const g = Math.exp((mk - gr) * LN10_20)
      const w = 1 - mix + mix * g
      lim.step(xa * w, xb * w)
      a[i] = lim.oL
      if (b) b[i] = lim.oR
    }
    this.mk = mk
    this.mix = mix
    this.j = j
    safety(chs, nch, n)
  }

  reset() {
    this.core.reset()
    this.j = 0
    this.lim.reset()
  }
}

export default {
  id: 'tone.compress',
  name: 'Compressor',
  family: 'tone',
  about: 'Evens out your voice: loud words are turned down, quiet ones come up, for a closer, steadier sound. Mix blends in the untouched voice.',
  params: [
    { id: 'threshold', name: 'Threshold', type: 'number', min: -60, max: 0, step: 0.5, def: -24, unit: 'db' },
    { id: 'ratio', name: 'Ratio', type: 'number', min: 1, max: 20, step: 0.1, def: 3, unit: 'x' },
    { id: 'attack', name: 'Attack', type: 'number', min: 0.1, max: 100, step: 0.1, def: 5, unit: 'ms' },
    { id: 'release', name: 'Release', type: 'number', min: 10, max: 1000, step: 1, def: 120, unit: 'ms' },
    { id: 'knee', name: 'Knee softness', type: 'number', min: 0, max: 24, step: 0.5, def: 6, unit: 'db' },
    { id: 'makeup', name: 'Makeup volume', type: 'number', min: -12, max: 24, step: 0.5, def: 0, unit: 'db' },
    { id: 'autoMakeup', name: 'Automatic makeup', type: 'bool', def: true },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent' },
  ],
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 1,
  surprise: false,
  process(input, p) {
    const n = bufLen(input)
    if (!n) return input
    const proc = new CompProc(input.sr, p)
    const out = runAligned(input.ch, proc.latency, (c, nch, len) => proc.run(c, nch, len))
    for (let c = 0; c < out.length; c++) input.ch[c] = out[c]
    return input
  },
  live: {
    latency(p, sr) {
      return guardLatency(sr)
    },
    create(sr, p) {
      const proc = new CompProc(sr, p)
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
