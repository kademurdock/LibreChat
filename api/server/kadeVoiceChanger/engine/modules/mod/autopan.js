// modules/mod/autopan.js - Auto-pan: the voice travels from ear to ear.
//
// Technique: a low-frequency oscillator drives a constant-power pan law
// (gains cos and sin of a quarter-circle angle, scaled so the centre is
// unity), as in Zolzer, "DAFX" (2nd ed. 2011), chapter on spatial effects.
// On headphones a level difference alone sounds as if the voice sits inside
// the head, so the optional head cues add the two things a real head does to
// a voice off to one side (Brown and Duda, "A structural model for binaural
// sound synthesis", IEEE TSAP 1998): the far ear hears it up to 0.35 ms
// later (interaural time difference, a cubic-interpolated fractional delay)
// and slightly duller (head shadow, a one-pole low pass blended in by how far
// to the side the voice is). The waves are smooth (sine), even (triangle),
// jumping side to side (square, slewed over 25 ms so the jumps glide instead
// of clicking) and wandering (smooth random: cosine interpolation between
// random positions, one per cycle). A stereo input is folded to its middle
// for the moving voice, and its side part stays in, narrowing as the voice
// moves out to an edge.

import { DelayLine } from '../../core/delay.js'
import { makeRng } from '../../core/rng.js'

const TWO_PI = 2 * Math.PI
const SHAPES = ['sine', 'triangle', 'square', 'random']

function num(v, d) {
  return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : d
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

const params = [
  { id: 'rate', name: 'Speed', type: 'number', min: 0.05, max: 10, step: 0.05, def: 0.4, unit: 'hz', rand: [0.1, 1.5] },
  { id: 'width', name: 'Width', type: 'number', min: 0, max: 100, step: 1, def: 80, unit: 'percent', rand: [50, 100] },
  {
    id: 'shape', name: 'Movement', type: 'choice', def: 'sine',
    options: [
      { v: 'sine', name: 'Smooth' },
      { v: 'triangle', name: 'Even' },
      { v: 'square', name: 'Jumps side to side' },
      { v: 'random', name: 'Wanders' },
    ],
  },
  { id: 'start', name: 'Starts toward', type: 'choice', def: 'right', options: [{ v: 'right', name: 'Right' }, { v: 'left', name: 'Left' }] },
  { id: 'head', name: 'Headphone depth', type: 'bool', def: true },
]

function createKernel(sr, p0, rngIn) {
  const rng = rngIn || makeRng('mod.autopan')
  const itdMax = 0.00035 * sr
  const dl = new DelayLine(Math.ceil(itdMax) + 8)
  const shadowC = 1 - Math.exp((-TWO_PI * Math.min(2500, sr * 0.4)) / sr)
  const smFast = 1 - Math.exp(-1 / (0.003 * sr))
  const smSquare = 1 - Math.exp(-1 / (0.025 * sr))
  const smP = 1 - Math.exp(-1 / (0.03 * sr))
  let inc = 0.4 / sr, widthT = 0.8, shape = 0, dir = 1, headT = 1
  let width = 0.8, head = 1
  let q = 0, ra = 0, rb = 0, pan = 0, lpL = 0, lpR = 0

  function set(p) {
    inc = clamp(num(p.rate, 0.4), 0, 40) / sr
    widthT = clamp(num(p.width, 80), 0, 100) / 100
    const s = SHAPES.indexOf(p.shape)
    shape = s >= 0 ? s : 0
    dir = p.start === 'left' ? -1 : 1
    headT = p.head === false ? 0 : 1
  }
  function raw(phase) {
    switch (shape) {
      case 1:
        return phase < 0.25 ? 4 * phase : phase < 0.75 ? 2 - 4 * phase : 4 * phase - 4
      case 2:
        return phase < 0.5 ? 1 : -1
      case 3:
        return ra + (rb - ra) * (0.5 - 0.5 * Math.cos(Math.PI * phase))
      default:
        return Math.sin(TWO_PI * phase)
    }
  }
  function reset() {
    dl.clear()
    q = 0
    ra = 0
    rb = rng.next() * 2 - 1
    width = widthT
    head = headT
    pan = 0
    lpL = lpR = 0
  }
  set(p0)
  reset()

  return {
    set,
    reset,
    process(ins, outs, n) {
      const nIn = ins.length
      const two = outs.length > 1
      const sm = shape === 2 ? smSquare : smFast
      for (let i = 0; i < n; i++) {
        const x0 = ins[0][i]
        const x1 = nIn > 1 ? ins[1][i] : x0
        width += (widthT - width) * smP
        head += (headT - head) * smP
        let nq = q + inc
        if (nq >= 1) {
          nq -= Math.floor(nq)
          ra = rb
          rb = rng.next() * 2 - 1
        }
        q = nq
        const target = dir * width * raw(q)
        pan += (target - pan) * sm
        const m = 0.5 * (x0 + x1)
        const s = 0.5 * (x0 - x1)
        dl.write(m)
        const th = (pan + 1) * 0.25 * Math.PI
        const gl = Math.cos(th) * Math.SQRT2
        const gr = Math.sin(th) * Math.SQRT2
        const right = pan > 0 ? pan : 0
        const left = pan < 0 ? -pan : 0
        const dL = itdMax * right * head
        const dR = itdMax * left * head
        const vL = dL > 0 ? dl.read(dL) : m
        const vR = dR > 0 ? dl.read(dR) : m
        lpL += (vL - lpL) * shadowC
        lpR += (vR - lpR) * shadowC
        if (lpL < 1e-20 && lpL > -1e-20) lpL = 0
        if (lpR < 1e-20 && lpR > -1e-20) lpR = 0
        const shL = 0.55 * right * head
        const shR = 0.55 * left * head
        const eL = vL + (lpL - vL) * shL
        const eR = vR + (lpR - vR) * shR
        const keep = 1 - (pan < 0 ? -pan : pan)
        if (two) {
          outs[0][i] = eL * gl + s * keep
          outs[1][i] = eR * gr - s * keep
        } else {
          outs[0][i] = 0.5 * (eL * gl + eR * gr)
        }
      }
    },
  }
}

export default {
  id: 'mod.autopan',
  name: 'Auto-pan',
  family: 'mod',
  about: 'Your voice travels from ear to ear and back, smoothly, in jumps, or wandering around your head.',
  params,
  stereo: 'make',
  tail: () => 0,
  warps: false,
  cost: 1,
  process(input, p, ctx) {
    const sr = input.sr
    const len = input.ch.length ? input.ch[0].length : 0
    const outs = [new Float32Array(len), new Float32Array(len)]
    if (!len) return { sr, ch: outs }
    const k = createKernel(sr, p, ctx && ctx.rng)
    k.process(input.ch, outs, len)
    if (ctx && typeof ctx.progress === 'function') ctx.progress(1)
    return { sr, ch: outs }
  },
  live: {
    latency: () => 0,
    create(sr, p, rng) {
      return createKernel(sr, p, rng)
    },
  },
}
