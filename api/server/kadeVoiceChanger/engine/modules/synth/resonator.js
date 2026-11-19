// modules/synth/resonator.js - modal resonator bank (synth.resonator).
//
// Technique: modal synthesis (Adrien, "The missing link: modal synthesis",
// in De Poli, Piccialli and Roads (eds.), Representations of Musical Signals,
// MIT Press 1991; and the two-pole resonator of J. O. Smith, "Introduction
// to Digital Filters", 2007, "The two-pole resonator"). A struck or
// excited object rings as a sum of exponentially decaying sines, one per
// vibration mode, each with its own frequency, strength and decay time.
// Each mode here is a two-pole resonator
//     y[n] = b x[n] + 2 r cos(w) y[n-1] - r^2 y[n-2],
// with the pole radius r set from the mode's own 60 dB decay time,
// r = 10^(-3 / (T60 sr)), so every mode dies away at the rate the real
// object's does: a bell's hum rings longest and its high partials fade
// first, wood dies in a fraction of a second, a singing bowl sings for ten.
// The input gain b normalises each mode to unit power gain for white noise,
// b = amp sqrt((1 - r^2)(1 + r^4 - 2 r^2 cos 2w) / (1 + r^2)), so a long,
// narrow mode is as loud as a short, wide one.
//
// The objects use published mode ratios:
// - church bell: hum, prime, minor-third tierce, quint, nominal and the
//   upper partials of a tuned bell (Rossing and Perrin, "Vibrations of
//   bells", Applied Acoustics 20, 1987);
// - wine glass: the (2,0)..(6,0) shell modes (Rossing, "Wine glasses, bell
//   modes, and Lord Rayleigh", The Physics Teacher 28, 1990);
// - metal plate: a simply supported rectangular plate, f(m,n) ~ (m/a)^2 +
//   (n/b)^2 with sides 1 : 1.37 (Fletcher and Rossing, The Physics of
//   Musical Instruments, 2nd ed. 1998, ch. 3);
// - singing bowl: the bowl modes measured by Inacio, Henrique and Antunes,
//   "The dynamics of Tibetan singing bowls", Acta Acustica 92, 2006, each as
//   a close pair (a doublet) that beats, the bowl's slow shimmer;
// - steel drum: note areas tuned to fundamental, octave and twelfth, with
//   the neighbouring fifth and octave notes ringing along;
// - gong: a dense set of inharmonic plate modes with doublets;
// - wind chimes and music box: free-free bar modes 1 : 2.756 : 5.404 :
//   8.933 and clamped-free (cantilever) tine modes 1 : 6.267 : 17.55
//   (Fletcher and Rossing ch. 2), several tubes or tines per chord;
// - wooden bars: marimba bars tuned 1 : 3.99 : 9.14 (same source, ch. 19);
// - wooden box: a lossy air mode plus panel modes;
// - strings in a chord: stiff-string partials h sqrt(1 + B h^2), B = 0.0003,
//   on six chord notes with a slight unison detune that beats, the sound
//   of talking into a piano with the sustain pedal down;
// - long tube: the near-harmonic air resonances of an open pipe.
// Doublets (two resonators a fraction of a hertz apart) give bells, bowls
// and gongs their characteristic slow beating.
//
// Excitation: the voice, with first-order pre-emphasis (x[n] - 0.7 x[n-1])
// so its weaker high frequencies still reach the upper modes. "Strike"
// makes word onsets hit harder: a fast and a slow envelope follower find
// attacks, and the excitation is raised in proportion, so every syllable
// strikes the object and it rings on between words.
//
// The ring after the take: offline, the output is the take plus the
// object's tail, the 60 dB ring time of its longest mode (Ring length times
// the object's own ring; brightness only shortens the other modes), so a
// bell or a glass rings all the way out after the last word. The tail is
// capped at 15 s; when the longest mode would ring longer (a gong or a
// singing bowl at three or four times the ring length), the last 40
// percent of the tail fades out with a raised cosine, like a hand damping
// the object, and otherwise the last tenth (at most half a second) fades
// so the take never ends on a step. Once the voice is over, modes that
// have died below 1e-10 are dropped, which keeps long tails cheap.
//
// Level: offline, the ringing is matched in RMS to the dry voice over the
// take, so every object comes out about as loud as the voice. Live
// mode uses the same bank and a slow gated level matcher that converges to
// the same match within a couple of seconds and holds still in pauses.
// Mix is equal power (dry and ringing are uncorrelated). The bank runs
// mode by mode over 256-sample chunks (fast in JavaScript), and every state
// is flushed below 1e-20 after each chunk so silent tails stay fast.
// Changing the object in live mode fades the ringing out over 15 ms,
// swaps the bank and fades back in; pitch, ring length and brightness glide.

import { bufLen, fade } from '../../core/buf.js'
import { makeRng } from '../../core/rng.js'

const TWO_PI = 2 * Math.PI
const LN1000 = Math.log(1000)
const CHUNK = 256
const MAXM = 96
const TAIL_MAX = 15
const ZERO = new Float32Array(CHUNK)

// ---------------------------------------------------------------- objects

function notesTimes(notes, noteAmps, partials) {
  // partials: [[ratio, amp, decayRel], ...] per note
  const out = []
  for (let k = 0; k < notes.length; k++) {
    const f = Math.pow(2, notes[k] / 12)
    for (const [r, a, d] of partials) out.push([f * r, a * noteAmps[k], d])
  }
  return out
}

function plateModes() {
  const rng = makeRng('synth.resonator.plate')
  const list = []
  const ly = 1.37
  const f11 = 1 + 1 / (ly * ly)
  for (let m = 1; m <= 8; m++) {
    for (let n = 1; n <= 8; n++) {
      const r = (m * m + (n * n) / (ly * ly)) / f11
      if (r <= 40) list.push(r)
    }
  }
  list.sort((a, b) => a - b)
  return list.slice(0, 30).map((r) => [r, Math.pow(r, -0.35) * (0.55 + 0.45 * rng.next()), 1 / (1 + 0.06 * (r - 1))])
}

function gongModes() {
  const rng = makeRng('synth.resonator.gong')
  const ratios = [1, 1.52, 2.14, 2.67, 3.3, 3.96, 4.3, 5.1, 5.65, 6.2, 6.9, 7.6, 8.3, 9.1, 9.9, 10.8, 11.6, 12.7, 13.9, 15.2, 16.8, 18.5]
  return ratios.map((r) => [r, Math.pow(r, -0.3) * (0.45 + 0.55 * rng.next()), 1 / (1 + 0.035 * (r - 1))])
}

function stringModes(chord) {
  const B = 0.0003
  const amps = [1, 0.8, 0.8, 0.7, 0.6, 0.55]
  const out = []
  for (let k = 0; k < chord.length; k++) {
    const f = Math.pow(2, chord[k] / 12)
    for (let h = 1; h <= 6; h++) {
      out.push([f * h * Math.sqrt(1 + B * h * h), amps[k] * Math.pow(h, -0.9), 1 / (1 + 0.22 * (h - 1))])
    }
  }
  return out
}

function tubeModes() {
  const out = []
  for (let h = 1; h <= 12; h++) out.push([h * (1 - 0.003 * (h - 1)), Math.pow(h, -0.6), 1 / (1 + 0.12 * (h - 1))])
  return out
}

const OBJECT_LIST = [
  {
    v: 'bell', name: 'Church bell', base: 220, decay: 7, doublet: 0.6,
    modes: [
      [0.5, 0.55, 1], [1, 0.7, 0.8], [1.183, 0.6, 0.62], [1.506, 0.35, 0.55], [2, 1, 0.5], [2.514, 0.45, 0.36],
      [2.662, 0.4, 0.33], [3.011, 0.3, 0.28], [4.166, 0.25, 0.2], [5.433, 0.15, 0.15], [6.796, 0.1, 0.12], [8.215, 0.06, 0.1],
    ],
  },
  {
    v: 'glass', name: 'Wine glass', base: 784, decay: 4, doublet: 0.35,
    modes: [[1, 1, 1], [2.32, 0.3, 0.6], [4.25, 0.12, 0.42], [6.63, 0.05, 0.3], [9.38, 0.025, 0.22]],
  },
  { v: 'metal-plate', name: 'Metal plate', base: 110, decay: 3, doublet: 0, modes: plateModes() },
  {
    v: 'wood-box', name: 'Wooden box', base: 190, decay: 0.35, doublet: 0,
    modes: [[1, 1, 1], [1.48, 0.7, 0.8], [2.06, 0.6, 0.7], [2.71, 0.55, 0.6], [3.4, 0.4, 0.5], [4.45, 0.35, 0.42], [5.7, 0.25, 0.36], [7.3, 0.15, 0.3]],
  },
  {
    v: 'singing-bowl', name: 'Singing bowl', base: 220, decay: 9, doublet: 1.3,
    modes: [[1, 1, 1], [2.76, 0.55, 0.62], [5.12, 0.3, 0.42], [8.07, 0.15, 0.3], [11.6, 0.08, 0.22]],
  },
  { v: 'strings-major', name: 'Strings, major chord', base: 110, decay: 4, doublet: 0.25, modes: stringModes([0, 4, 7, 12, 16, 19]) },
  { v: 'strings-minor', name: 'Strings, minor chord', base: 110, decay: 4, doublet: 0.25, modes: stringModes([0, 3, 7, 12, 15, 19]) },
  {
    v: 'steel-drum', name: 'Steel drum', base: 294, decay: 1.6, doublet: 0.8,
    modes: notesTimes([0, 7, 12], [1, 0.45, 0.35], [[1, 1, 1], [1.995, 0.65, 0.7], [3.005, 0.4, 0.5], [4.02, 0.2, 0.4], [5.03, 0.1, 0.3]]),
  },
  { v: 'gong', name: 'Gong', base: 82, decay: 8, doublet: 0.5, modes: gongModes() },
  {
    v: 'wind-chimes', name: 'Wind chimes', base: 523.25, decay: 5, doublet: 0.3,
    modes: notesTimes([0, 2, 4, 7, 9], [1, 0.9, 0.85, 0.8, 0.75], [[1, 1, 1], [2.756, 0.6, 0.6], [5.404, 0.35, 0.4], [8.933, 0.18, 0.3]]),
  },
  {
    v: 'music-box', name: 'Music box', base: 523.25, decay: 2.5, doublet: 0,
    modes: notesTimes([0, 4, 7, 12, 16], [1, 0.9, 0.85, 0.8, 0.7], [[1, 1, 1], [6.267, 0.22, 0.3], [17.55, 0.07, 0.15]]),
  },
  {
    v: 'wood-bars', name: 'Wooden bars', base: 196, decay: 1, doublet: 0,
    modes: notesTimes([0, 7, 12, 16], [1, 0.8, 0.75, 0.65], [[1, 1, 1], [3.99, 0.3, 0.35], [9.14, 0.1, 0.2]]),
  },
  { v: 'long-tube', name: 'Long tube', base: 140, decay: 1.2, doublet: 0, modes: tubeModes() },
]

// pack each object's modes into typed arrays (doublets expanded)
for (const o of OBJECT_LIST) {
  const k = o.modes.length * (o.doublet > 0 ? 2 : 1)
  if (k > MAXM) throw new Error('synth.resonator: too many modes in ' + o.v)
  o.ratio = new Float64Array(k)
  o.amp = new Float64Array(k)
  o.drel = new Float64Array(k)
  o.split = new Float64Array(k)
  let j = 0
  for (const [r, a, d] of o.modes) {
    if (o.doublet > 0) {
      // unequal halves (power still a^2): the beat swings about 15 dB, a
      // shimmer rather than a full stop
      for (const s of [-0.5, 0.5]) {
        o.ratio[j] = r
        o.amp[j] = a * (s < 0 ? 0.82 : 0.572)
        o.drel[j] = d
        o.split[j] = s * o.doublet * (0.6 + 0.4 * Math.min(2, r))
        j++
      }
    } else {
      o.ratio[j] = r
      o.amp[j] = a
      o.drel[j] = d
      o.split[j] = 0
      j++
    }
  }
  o.count = k
}
const OBJECTS = {}
for (const o of OBJECT_LIST) OBJECTS[o.v] = o

function objectOf(v) {
  return OBJECTS[v] || OBJECTS.bell
}

/**
 * 60 dB ring time (s) of the object's longest mode. Every object's longest
 * mode has a relative decay of 1, and brightness raises the others' relative
 * decay (at most 1) to a power, so none rings longer; _build clamps a mode's
 * T60 to 0.02..40 s.
 */
function ringSeconds(p) {
  const o = objectOf(p && p.object)
  let d = Number(p && p.decay)
  if (!(d > 0)) d = 1
  const t = d * o.decay
  return t < 0.02 ? 0.02 : t > 40 ? 40 : t
}

function ringTail(p) {
  return Math.min(TAIL_MAX, ringSeconds(p))
}

// ---------------------------------------------------------------- the bank

class ResonatorCore {
  constructor(sr, nch) {
    this.sr = sr
    this.nch = Math.max(1, nch)
    this.a1 = new Float64Array(MAXM)
    this.a2 = new Float64Array(MAXM)
    this.b = new Float64Array(MAXM)
    this.y1 = new Float64Array(MAXM * this.nch)
    this.y2 = new Float64Array(MAXM * this.nch)
    this.exc = new Float64Array(CHUNK)
    this.acc = new Float64Array(CHUNK)
    this.pre = new Float64Array(this.nch)
    this.eF = new Float64Array(this.nch)
    this.eS = new Float64Array(this.nch)
    this.cFa = Math.exp(-1 / (0.0005 * sr))
    this.cFr = Math.exp(-1 / (0.015 * sr))
    this.cSa = Math.exp(-1 / (0.03 * sr))
    this.cSr = Math.exp(-1 / (0.12 * sr))
    this.obj = OBJECTS.bell
    this.count = 0
    this.wg = 1
    this.strike = 0.35
    // current (smoothed) and target shape of the bank
    this.pitch = 0
    this.pitchT = 0
    this.decay = 1
    this.decayT = 1
    this.bright = 50
    this.brightT = 50
  }

  _build() {
    const o = this.obj
    const sr = this.sr
    const ratioP = Math.pow(2, this.pitch / 12)
    const bt = (this.bright - 50) / 50
    const tilt = 0.6 * bt
    const dexp = 1 - 0.6 * bt
    const nyq = 0.45 * sr
    let sum = 0
    const r0 = o.ratio[0]
    for (let m = 0; m < o.count; m++) {
      const f = o.base * ratioP * o.ratio[m] + o.split[m]
      if (!(f > 20 && f < nyq)) {
        this.a1[m] = 0
        this.a2[m] = 0
        this.b[m] = 0
        continue
      }
      let t60 = this.decay * o.decay * Math.pow(o.drel[m], dexp)
      if (t60 < 0.02) t60 = 0.02
      if (t60 > 40) t60 = 40
      const r = Math.exp(-LN1000 / (t60 * sr))
      const w = (TWO_PI * f) / sr
      const r2 = r * r
      const amp = o.amp[m] * Math.pow(o.ratio[m] / r0, tilt)
      const G = (1 + r2) / ((1 - r2) * (1 + r2 * r2 - 2 * r2 * Math.cos(2 * w)))
      this.a1[m] = 2 * r * Math.cos(w)
      this.a2[m] = r2
      this.b[m] = amp / Math.sqrt(G)
      sum += amp * amp
    }
    this.count = o.count
    this.wg = sum > 0 ? 1 / Math.sqrt(sum) : 0
  }

  configure(p, instant) {
    this.objT = objectOf(p.object)
    let ps = Number(p.pitch)
    if (!Number.isFinite(ps)) ps = 0
    this.pitchT = ps
    let d = Number(p.decay)
    if (!(d > 0)) d = 1
    this.decayT = d
    let bb = Number(p.brightness)
    if (!Number.isFinite(bb)) bb = 50
    this.brightT = bb
    let s = Number(p.strike)
    if (!(s >= 0)) s = 0
    this.strike = Math.min(1, s / 100)
    if (instant) {
      this.obj = this.objT
      this.pitch = this.pitchT
      this.decay = this.decayT
      this.bright = this.brightT
      this._build()
    }
  }

  /** Glide pitch, decay and brightness toward their targets (per chunk). */
  glide(k) {
    let moved = false
    if (this.pitch !== this.pitchT) {
      const d = this.pitchT - this.pitch
      this.pitch = Math.abs(d) < 0.01 ? this.pitchT : this.pitch + d * k
      moved = true
    }
    if (this.decay !== this.decayT) {
      const d = this.decayT - this.decay
      this.decay = Math.abs(d) < 0.002 ? this.decayT : this.decay + d * k
      moved = true
    }
    if (this.bright !== this.brightT) {
      const d = this.brightT - this.bright
      this.bright = Math.abs(d) < 0.1 ? this.brightT : this.bright + d * k
      moved = true
    }
    if (moved) this._build()
  }

  swapObject() {
    this.obj = this.objT
    this.y1.fill(0)
    this.y2.fill(0)
    this._build()
  }

  resetState() {
    this.y1.fill(0)
    this.y2.fill(0)
    this.pre.fill(0)
    this.eF.fill(0)
    this.eS.fill(0)
  }

  /**
   * Ring channel k: x[xOff..xOff+len) in, wet[wOff..wOff+len) out
   * (len <= CHUNK). idle: the input is known to be silent from here on and
   * the excitation is already zero (after the take), so modes that have
   * died below 1e-10 are zeroed and skipped.
   */
  chunk(x, xOff, wet, wOff, len, k, idle) {
    const exc = this.exc
    const acc = this.acc
    let pre = this.pre[k]
    let eF = this.eF[k]
    let eS = this.eS[k]
    const cFa = this.cFa
    const cFr = this.cFr
    const cSa = this.cSa
    const cSr = this.cSr
    const st = 2 * this.strike
    for (let i = 0; i < len; i++) {
      let v = x[xOff + i]
      if (!(v > -1e9 && v < 1e9)) v = 0
      let e = v - 0.7 * pre
      pre = v
      const av = v < 0 ? -v : v
      eF = av + (av > eF ? cFa : cFr) * (eF - av)
      eS = av + (av > eS ? cSa : cSr) * (eS - av)
      if (st > 0) {
        let tr = eF / (eS + 1e-4) - 1
        if (tr < 0) tr = 0
        if (tr > 5) tr = 5
        e *= 1 + st * tr
      }
      exc[i] = e
      acc[i] = 0
    }
    this.pre[k] = pre
    this.eF[k] = eF < 1e-20 ? 0 : eF
    this.eS[k] = eS < 1e-20 ? 0 : eS
    const a1 = this.a1
    const a2 = this.a2
    const b = this.b
    const Y1 = this.y1
    const Y2 = this.y2
    const base = k * MAXM
    const M = this.count
    for (let m = 0; m < M; m++) {
      const bm = b[m]
      if (bm === 0) continue
      const c1 = a1[m]
      const c2 = a2[m]
      let y1 = Y1[base + m]
      let y2 = Y2[base + m]
      if (idle && y1 === 0 && y2 === 0) continue
      for (let i = 0; i < len; i++) {
        const y = bm * exc[i] + c1 * y1 - c2 * y2
        y2 = y1
        y1 = y
        acc[i] += y
      }
      if (y1 < 1e-20 && y1 > -1e-20) y1 = 0
      if (y2 < 1e-20 && y2 > -1e-20) y2 = 0
      if (idle && y1 < 1e-10 && y1 > -1e-10 && y2 < 1e-10 && y2 > -1e-10) {
        y1 = 0
        y2 = 0
      }
      if (!(y1 > -1e12 && y1 < 1e12) || !(y2 > -1e12 && y2 < 1e12)) {
        y1 = 0
        y2 = 0
      }
      Y1[base + m] = y1
      Y2[base + m] = y2
    }
    const wg = this.wg
    for (let i = 0; i < len; i++) wet[wOff + i] = acc[i] * wg
  }
}

function mixGains(mixPct) {
  const m = Math.min(1, Math.max(0, mixPct / 100))
  return [Math.cos((m * Math.PI) / 2), Math.sin((m * Math.PI) / 2)]
}

export default {
  id: 'synth.resonator',
  name: 'Resonator bank',
  family: 'synth',
  about: 'Your voice rings a real object: a church bell, a wine glass, a gong, a singing bowl, chimes, a steel drum or strings.',
  params: [
    {
      id: 'object',
      name: 'Object',
      type: 'choice',
      def: 'bell',
      options: OBJECT_LIST.map((o) => ({ v: o.v, name: o.name })),
    },
    { id: 'pitch', name: 'Pitch', type: 'number', min: -24, max: 24, step: 0.5, def: 0, unit: 'semitones', rand: [-7, 7] },
    { id: 'decay', name: 'Ring length', type: 'number', min: 0.1, max: 4, step: 0.05, def: 1, unit: 'x', rand: [0.5, 2] },
    { id: 'brightness', name: 'Brightness', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [25, 80] },
    { id: 'strike', name: 'Strike on words', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [0, 80] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [35, 75] },
  ],
  stereo: 'keep',
  // the longest mode's 60 dB ring time, capped at 15 s (see the header)
  tail: (p) => ringTail(p),
  warps: false,
  cost: 2,
  process(input, p, ctx) {
    const n = bufLen(input)
    if (!n) return input
    const sr = input.sr || (ctx && ctx.sr) || 48000
    const nch = input.ch.length
    const ring = ringSeconds(p)
    const tailSec = ringTail(p)
    const total = n + Math.round(tailSec * sr)
    const core = new ResonatorCore(sr, nch)
    core.configure(p, true)
    const wets = new Array(nch)
    let ed = 0
    let ew = 0
    for (let c = 0; c < nch; c++) {
      const x = input.ch[c]
      const w = new Float32Array(total)
      for (let off = 0; off < n; off += CHUNK) core.chunk(x, off, w, off, Math.min(CHUNK, n - off), c, false)
      // after the take: the first chunk still carries the last pre-emphasis
      // step, after that the excitation is exactly zero
      for (let off = n; off < total; off += CHUNK) core.chunk(ZERO, 0, w, off, Math.min(CHUNK, total - off), c, off > n)
      // level is matched over the take itself, so the tail cannot change it
      for (let i = 0; i < n; i++) {
        const v = x[i]
        if (v > -1e9 && v < 1e9) ed += v * v
        ew += w[i] * w[i]
      }
      wets[c] = w
      if (ctx && typeof ctx.progress === 'function') ctx.progress((c + 1) / nch)
    }
    // match the ringing to the voice's level
    let g = ew > 1e-20 && ed > 1e-20 ? Math.sqrt(ed / ew) : 1
    if (g > 300) g = 300
    if (g < 0.01) g = 0.01
    const [gd, gw] = mixGains(p.mix)
    for (let c = 0; c < nch; c++) {
      const x = input.ch[c]
      const w = wets[c]
      const k = gw * g
      for (let i = 0; i < n; i++) {
        let v = x[i]
        if (!(v > -1e9 && v < 1e9)) v = 0
        w[i] = gd * v + k * w[i]
      }
      for (let i = n; i < total; i++) w[i] *= k
    }
    const out = { sr, ch: wets }
    // a capped ring is damped over the last 40 percent of the tail; a full
    // one is 60 dB down by its end and gets only a short fade
    fade(out, 0, ring > tailSec ? 0.4 * tailSec : Math.min(0.5, 0.1 * tailSec))
    return out
  },
  live: {
    latency() {
      return 0
    },
    create(sr, p) {
      const core = new ResonatorCore(sr, 2)
      core.configure(p, true)
      const wet0 = new Float32Array(CHUNK)
      const wet1 = new Float32Array(CHUNK)
      const glideK = 1 - Math.exp(-CHUNK / (0.08 * sr))
      const fadeStep = 1 / Math.max(1, Math.round(0.015 * sr))
      const kMix = 1 - Math.exp(-1 / (0.02 * sr))
      const kPow = 1 - Math.exp(-1 / (2 * sr))
      const kGain = 1 - Math.exp(-1 / (0.4 * sr))
      const st = {
        fade: 1,
        swapping: false,
        gd: 0,
        gw: 0,
        gdT: 0,
        gwT: 0,
        pd: 0,
        pw: 0,
        gain: 1,
        lvl: 0,
      }
      const setMix = (q, instant) => {
        const m = Math.min(1, Math.max(0, (Number(q.mix) >= 0 ? Number(q.mix) : 50) / 100))
        st.gdT = Math.cos((m * Math.PI) / 2)
        st.gwT = Math.sin((m * Math.PI) / 2)
        if (instant) {
          st.gd = st.gdT
          st.gw = st.gwT
        }
      }
      setMix(p, true)
      return {
        process(ins, outs, n) {
          const in0 = ins[0]
          const in1 = ins.length > 1 ? ins[1] : null
          const out0 = outs[0]
          const out1 = outs.length > 1 ? outs[1] : null
          const stereo = !!(in1 && out1)
          for (let off = 0; off < n; off += CHUNK) {
            const len = Math.min(CHUNK, n - off)
            if (st.swapping && st.fade <= 0) {
              core.swapObject()
              st.swapping = false
            } else if (!st.swapping) core.glide(glideK)
            core.chunk(in0, off, wet0, 0, len, 0, false)
            if (stereo) core.chunk(in1, off, wet1, 0, len, 1, false)
            for (let i = 0; i < len; i++) {
              const j = off + i
              let x0 = in0[j]
              if (!(x0 > -1e9 && x0 < 1e9)) x0 = 0
              let x1 = 0
              if (stereo) {
                x1 = in1[j]
                if (!(x1 > -1e9 && x1 < 1e9)) x1 = 0
              }
              const w0 = wet0[i]
              const w1 = stereo ? wet1[i] : 0
              // gated slow level match (holds still in pauses)
              const dp = stereo ? 0.5 * (x0 * x0 + x1 * x1) : x0 * x0
              const wp = stereo ? 0.5 * (w0 * w0 + w1 * w1) : w0 * w0
              st.lvl += (dp - st.lvl) * kMix
              if (st.lvl > 1e-6) {
                st.pd += (dp - st.pd) * kPow
                st.pw += (wp - st.pw) * kPow
                if (st.pw > 1e-12 && st.pd > 1e-9) {
                  let tg = Math.sqrt(st.pd / st.pw)
                  if (tg > 300) tg = 300
                  if (tg < 0.01) tg = 0.01
                  st.gain += (tg - st.gain) * kGain
                }
              }
              if (st.swapping) {
                st.fade -= fadeStep
                if (st.fade < 0) st.fade = 0
              } else if (st.fade < 1) {
                st.fade += fadeStep
                if (st.fade > 1) st.fade = 1
              }
              st.gd += (st.gdT - st.gd) * kMix
              st.gw += (st.gwT - st.gw) * kMix
              const k = st.gw * st.gain * st.fade
              out0[j] = st.gd * x0 + k * w0
              if (stereo) out1[j] = st.gd * x1 + k * w1
              else if (out1) out1[j] = out0[j]
            }
          }
        },
        set(q) {
          core.configure(q, false)
          // a new object fades the old ringing out first; going back cancels
          st.swapping = core.objT !== core.obj
          setMix(q, false)
        },
        reset() {
          core.resetState()
          st.pd = 0
          st.pw = 0
          st.lvl = 0
          st.fade = 1
          if (st.swapping) {
            core.swapObject()
            st.swapping = false
          }
        },
      }
    },
  },
}
