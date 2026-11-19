// modules/mod/rotary.js - Rotating speaker: the voice through a spinning
// horn-and-drum organ cabinet.
//
// Technique: the rotating-loudspeaker model of Julius O. Smith III, Stefania
// Serafin, Jonathan Abel and David Berners, "Doppler Simulation and the
// Leslie" (DAFx 2002), with the rotor speeds and spin-up behaviour reported
// for real cabinets (Herrera, Hanson and Abel, "Discrete Time Emulation of
// the Leslie Speaker", AES 127th Convention 2009). The cabinet has two
// rotors fed by a crossover:
// - A fourth-order Linkwitz-Riley crossover at 800 Hz (two cascaded
//   Butterworth biquads per side, so the two bands sum back flat) splits the
//   voice. Before it, an optional tube-style drive (tanh) stands in for the
//   cabinet's valve amplifier.
// - The treble horn spins about 0.8 times a second on the slow setting and
//   6.75 times a second on fast. Its mouth moves on a circle of about 15 cm,
//   so the path to each microphone gets longer and shorter every turn: a
//   fractional delay line read at base + (r / c)(1 - cos angle) gives the
//   Doppler pitch wobble exactly. While the horn faces a microphone it is
//   louder and brighter, facing away it is quieter and duller: the level is
//   (1 - a) + a * facing and the treble is blended in by facing squared,
//   between a full and a low-passed copy read at the same delay. A second,
//   weaker path models the horn sound bouncing off the cabinet wall it faces
//   away from, with its own longer delay and opposite Doppler, which is what
//   makes the real thing swirl rather than just wobble.
// - The bass drum (a rotating baffle in front of a fixed woofer) turns a
//   little slower than the horn on both settings and carries a smaller
//   Doppler shift and gentler level change.
// - The rotors have mass: on a speed change the horn reaches its new speed
//   in about a second, the heavy drum takes several, so during the ramp the
//   two drift against each other, the signature sound of the switch.
// - Two microphones, left and right of the cabinet, hear the rotors at
//   different angles; the width setting moves them from one spot (mono) to
//   opposite sides (widest swirl).
// The dry path is delayed to the rotors' average delay so mixing stays in
// phase; live mode reports that as its latency and the offline render
// removes it.

import { Biquad } from '../../core/biquad.js'
import { DelayLine } from '../../core/delay.js'

const TWO_PI = 2 * Math.PI
const C = 343
const HORN_R = 0.15
const DRUM_R = 0.12
const HORN_SLOW = 0.83
const HORN_FAST = 6.75
const DRUM_SLOW = 0.67
const DRUM_FAST = 5.83
const HORN_UP = 0.45
const HORN_DOWN = 0.75
const DRUM_UP = 1.7
const DRUM_DOWN = 2.1
const AM_HORN = 0.6
const AM_DRUM = 0.45
const REFL_GAIN = 0.32
const REFL_MS = 0.8
const MODES = ['slow', 'fast', 'up', 'down', 'toggle']
const CTL = 32

function num(v, d) {
  return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : d
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

const params = [
  {
    id: 'speed', name: 'Speed', type: 'choice', def: 'up',
    options: [
      { v: 'slow', name: 'Slow' },
      { v: 'fast', name: 'Fast' },
      { v: 'up', name: 'Speeding up' },
      { v: 'down', name: 'Slowing down' },
      { v: 'toggle', name: 'Back and forth' },
    ],
  },
  { id: 'switchAt', name: 'Switch after', type: 'number', min: 0.5, max: 20, step: 0.5, def: 2, unit: 'seconds', rand: [1, 4] },
  {
    id: 'balance', name: 'Horn and drum balance', type: 'number', min: -100, max: 100, step: 1, def: 0, unit: 'percent',
    words: { neg: 'more drum', pos: 'more horn', zero: 'even' }, rand: [-30, 40],
  },
  { id: 'drive', name: 'Drive', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 60] },
  { id: 'width', name: 'Stereo width', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [60, 100] },
  { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [70, 100] },
]

function baseLatency(sr) {
  return Math.ceil((0.0006 + HORN_R / C) * sr) + 1
}

function targetsFor(mode, el, sw, out) {
  let fast
  if (mode === 1) fast = true
  else if (mode === 2) fast = el >= sw
  else if (mode === 3) fast = el < sw
  else if (mode === 4) fast = (Math.floor(el / sw) & 1) === 1
  else fast = false
  out[0] = fast ? HORN_FAST : HORN_SLOW
  out[1] = fast ? DRUM_FAST : DRUM_SLOW
}

function createKernel(sr, p0) {
  const lb = baseLatency(sr)
  const hornS = (HORN_R / C) * sr
  const drumS = (DRUM_R / C) * sr
  const hornBase = lb - hornS
  const drumBase = lb - drumS
  const reflS = (REFL_MS / 1000) * sr
  const maxD = lb + hornS * 2 + reflS + 8
  const dlFull = new DelayLine(maxD)
  const dlDark = new DelayLine(maxD)
  const dlDrum = new DelayLine(maxD)
  const dry0 = new DelayLine(lb + 4)
  const dry1 = new DelayLine(lb + 4)
  const lp1 = new Biquad('lowpass', sr, 800, Math.SQRT1_2)
  const lp2 = new Biquad('lowpass', sr, 800, Math.SQRT1_2)
  const hp1 = new Biquad('highpass', sr, 800, Math.SQRT1_2)
  const hp2 = new Biquad('highpass', sr, 800, Math.SQRT1_2)
  const hornPeak = new Biquad('peak', sr, Math.min(1600, sr * 0.3), 1.0, 3)
  const hornTop = new Biquad('lowpass', sr, Math.min(5500, sr * 0.45), 0.707)
  const darkC = 1 - Math.exp((-TWO_PI * Math.min(1800, sr * 0.4)) / sr)
  const kHup = 1 - Math.exp(-1 / (HORN_UP * sr))
  const kHdn = 1 - Math.exp(-1 / (HORN_DOWN * sr))
  const kDup = 1 - Math.exp(-1 / (DRUM_UP * sr))
  const kDdn = 1 - Math.exp(-1 / (DRUM_DOWN * sr))
  const sm = 1 - Math.exp(-1 / (0.03 * sr))
  const smC = 1 - Math.exp(-CTL / (0.05 * sr))
  const tg = new Float64Array(2)
  const hornNorm = 1 / (1 - AM_HORN * 0.5 + REFL_GAIN * 0.35)
  const drumNorm = 1 / (1 - AM_DRUM * 0.5)
  let mode = 2, sw = 2 * sr, el = 0
  let balT = 0, driveT = 0.25, widthT = 1, mixT = 1
  let hornG = 1, drumG = 1, kDrive = 0.66, width = 1, mix = 1
  let cL = 1, sL = 0, cR = 1, sR = 0
  let wH = HORN_SLOW, wD = DRUM_SLOW, aH = 0, aD = 0.31
  let dark = 0
  let ctl = 0

  function set(p) {
    const m = MODES.indexOf(p.speed)
    const nm = m >= 0 ? m : 2
    const nsw = Math.max(0.5, num(p.switchAt, 2)) * sr
    if (nm !== mode || nsw !== sw) el = 0
    mode = nm
    sw = nsw
    balT = clamp(num(p.balance, 0), -100, 100) / 100
    driveT = clamp(num(p.drive, 25), 0, 100) / 100
    widthT = clamp(num(p.width, 100), 0, 100) / 100
    mixT = clamp(num(p.mix, 100), 0, 100) / 100
  }
  function gainsFromBalance(b) {
    hornG = (b < 0 ? 1 + b : 1) * hornNorm
    drumG = (b > 0 ? 1 - b : 1) * drumNorm
  }
  function mics() {
    const a = 0.5 * Math.PI * width
    cL = Math.cos(-a)
    sL = Math.sin(-a)
    cR = Math.cos(a)
    sR = Math.sin(a)
  }
  let bal = 0, drv = 0.25
  function snap() {
    bal = balT
    drv = driveT
    width = widthT
    mix = mixT
    gainsFromBalance(bal)
    kDrive = 0.3 + 5.7 * drv * drv
    mics()
    targetsFor(mode, 0, sw, tg)
    wH = tg[0]
    wD = tg[1]
  }
  function reset() {
    dlFull.clear()
    dlDark.clear()
    dlDrum.clear()
    dry0.clear()
    dry1.clear()
    lp1.reset()
    lp2.reset()
    hp1.reset()
    hp2.reset()
    hornPeak.reset()
    hornTop.reset()
    dark = 0
    el = 0
    aH = 0
    aD = 0.31
    ctl = 0
    snap()
  }
  set(p0)
  reset()

  return {
    set,
    reset,
    process(ins, outs, n) {
      const nIn = ins.length
      const two = outs.length > 1
      for (let i = 0; i < n; i++) {
        if (ctl === 0) {
          targetsFor(mode, el, sw, tg)
          bal += (balT - bal) * smC
          drv += (driveT - drv) * smC
          width += (widthT - width) * smC
          gainsFromBalance(bal)
          kDrive = 0.3 + 5.7 * drv * drv
          mics()
          ctl = CTL
        }
        ctl--
        el++
        mix += (mixT - mix) * sm
        const x0 = ins[0][i]
        const x1 = nIn > 1 ? ins[1][i] : x0
        dry0.write(x0)
        dry1.write(x1)
        const x = 0.5 * (x0 + x1)
        // valve drive: unity slope for small signals, rounding the peaks
        let kd = kDrive * x
        kd = kd > 12 ? 12 : kd < -12 ? -12 : kd
        const xd = Math.tanh(kd) / kDrive
        const lo = lp2.tick(lp1.tick(xd))
        let hi = hp2.tick(hp1.tick(xd))
        hi = hornTop.tick(hornPeak.tick(hi))
        dark += (hi - dark) * darkC
        if (dark < 1e-20 && dark > -1e-20) dark = 0
        dlFull.write(hi)
        dlDark.write(dark)
        dlDrum.write(lo)
        // rotor speeds with inertia
        const tH = tg[0]
        const tD = tg[1]
        wH += (tH - wH) * (tH > wH ? kHup : kHdn)
        wD += (tD - wD) * (tD > wD ? kDup : kDdn)
        aH += wH / sr
        if (aH >= 1) aH -= 1
        aD += wD / sr
        if (aD >= 1) aD -= 1
        const hc = Math.cos(TWO_PI * aH)
        const hs = Math.sin(TWO_PI * aH)
        const dc = Math.cos(TWO_PI * aD)
        const ds = Math.sin(TWO_PI * aD)
        // left microphone
        let wl, wr
        {
          const c = hc * cL + hs * sL
          const face = 0.5 + 0.5 * c
          const back = 1 - face
          const d1 = hornBase + hornS * (1 - c)
          const f1 = dlFull.read(d1)
          const k1 = dlDark.read(d1)
          const h1 = k1 + (f1 - k1) * (0.15 + 0.85 * face * face)
          const d2 = hornBase + reflS + hornS * (1 + c)
          const f2 = dlFull.read(d2)
          const k2 = dlDark.read(d2)
          const h2 = k2 + (f2 - k2) * (0.15 + 0.85 * back * back)
          const horn = h1 * (1 - AM_HORN + AM_HORN * face) + h2 * REFL_GAIN * (1 - AM_HORN + AM_HORN * back)
          const cd = dc * cL + ds * sL
          const drum = dlDrum.read(drumBase + drumS * (1 - cd)) * (1 - AM_DRUM * (0.5 - 0.5 * cd))
          wl = horn * hornG + drum * drumG
        }
        {
          const c = hc * cR + hs * sR
          const face = 0.5 + 0.5 * c
          const back = 1 - face
          const d1 = hornBase + hornS * (1 - c)
          const f1 = dlFull.read(d1)
          const k1 = dlDark.read(d1)
          const h1 = k1 + (f1 - k1) * (0.15 + 0.85 * face * face)
          const d2 = hornBase + reflS + hornS * (1 + c)
          const f2 = dlFull.read(d2)
          const k2 = dlDark.read(d2)
          const h2 = k2 + (f2 - k2) * (0.15 + 0.85 * back * back)
          const horn = h1 * (1 - AM_HORN + AM_HORN * face) + h2 * REFL_GAIN * (1 - AM_HORN + AM_HORN * back)
          const cd = dc * cR + ds * sR
          const drum = dlDrum.read(drumBase + drumS * (1 - cd)) * (1 - AM_DRUM * (0.5 - 0.5 * cd))
          wr = horn * hornG + drum * drumG
        }
        const dl0 = dry0.read(lb)
        const dl1 = dry1.read(lb)
        const dry = 1 - mix
        if (two) {
          outs[0][i] = dl0 * dry + wl * mix
          outs[1][i] = dl1 * dry + wr * mix
        } else {
          outs[0][i] = dl0 * dry + 0.5 * (wl + wr) * mix
        }
      }
    },
  }
}

export default {
  id: 'mod.rotary',
  name: 'Rotating speaker',
  family: 'mod',
  about: 'Your voice through a spinning organ speaker cabinet: swirling horn and drum, slow or fast, with the speed-up ramp.',
  params,
  stereo: 'make',
  tail: () => 0,
  warps: false,
  cost: 3,
  process(input, p, ctx) {
    const sr = input.sr
    const len = input.ch.length ? input.ch[0].length : 0
    if (!len) return { sr, ch: [new Float32Array(0), new Float32Array(0)] }
    const lb = baseLatency(sr)
    const total = len + lb
    const ins = input.ch.slice(0, 2).map((c) => {
      const y = new Float32Array(total)
      y.set(c)
      return y
    })
    const full = [new Float32Array(total), new Float32Array(total)]
    const k = createKernel(sr, p)
    const B = 1 << 15
    for (let a = 0; a < total; a += B) {
      const b = Math.min(total, a + B)
      k.process(ins.map((c) => c.subarray(a, b)), full.map((c) => c.subarray(a, b)), b - a)
      if (ctx && typeof ctx.progress === 'function') ctx.progress(b / total)
      if (ctx && typeof ctx.cancelled === 'function' && ctx.cancelled()) break
    }
    return { sr, ch: [full[0].slice(lb), full[1].slice(lb)] }
  },
  live: {
    latency: (p, sr) => baseLatency(sr || 48000),
    create(sr, p) {
      return createKernel(sr, p)
    },
  },
}
