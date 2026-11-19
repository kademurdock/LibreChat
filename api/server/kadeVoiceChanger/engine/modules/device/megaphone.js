// modules/device/megaphone.js - device.megaphone, Megaphone and bullhorn.
//
// - the horn: a horn loudspeaker only works above its cutoff and has strong
//   resonances from its throat and mouth, so the voice turns into a honking
//   midrange beam (a band from about 500 Hz to 4.5 kHz with two peaks and a
//   short comb from the reflection inside the horn; horn behaviour as in
//   Olson, "Acoustical Engineering");
// - the driver: a battery amplifier and compression driver pushed into
//   limiting and clipping;
// - feedback squeal: the mic hears the horn; when the loop gain passes one
//   on loud words the classic howl builds at the loop's favourite pitch and
//   dies away in the pauses (a delayed, band-passed loop with a soft
//   limiter so it can never run away);
// - the siren: the yelping whoop of a bullhorn's siren button, before the
//   first phrase or before every phrase;
// - outdoors: slapback echoes from the buildings across the street and a
//   faint wash of the open air;
// - three kinds: a handheld bullhorn, a cheerleader's cone (purely
//   acoustic, no electronics to clip) and a big rooftop horn on a truck.

import { makeDevice, Bank, butter, Bq, Rand, Squash, SmallRoom, Edges, Tone, BLOCK, SPEECH, frac, db, onePoleCoef } from './_kit.js'
import { DelayLine } from '../../core/delay.js'

const SIZES = ['bullhorn', 'cone', 'roof']

const SIREN_MS = 1050

/**
 * Offline siren times (samples): only into a pause long enough to hold the
 * whole whoop, so it never covers words. 'start' takes the first such pause
 * (or the very start, quieter, when there is none); 'each' every one.
 */
function sirenPlan(phrases, sr, mode) {
  const L = Math.round((SIREN_MS / 1000) * sr)
  const need = L + Math.round(0.08 * sr)
  const at = []
  let quiet = false
  for (let k = 0; k < phrases.length; k++) {
    const gap = k === 0 ? phrases[0].start : phrases[k].start - phrases[k - 1].end
    if (gap >= need) {
      at.push(phrases[k].start - L - Math.round(0.05 * sr))
      if (mode === 'start') break
    }
  }
  if (mode === 'start' && !at.length) {
    at.push(0)
    quiet = true
  }
  return { at: Float64Array.from(at), quiet }
}

class MegaCore {
  constructor(sr, p, rng, info) {
    this.sr = sr
    this.offline = !!(info && info.offline)
    this.phrases = this.offline ? info.phrases : []
    this.plan = { at: new Float64Array(0), quiet: false }
    this.planK = 0
    this.t = 0
    this.r = new Rand(rng, 'mega-noise')
    this.mic = new Bank(sr, 3)
    this.horn = new Bank(sr, 8)
    this.lim = new Squash(sr)
    this.comb = new DelayLine(Math.ceil(0.004 * sr) + 8)
    this.loopD = Math.round(0.012 * sr)
    this.loop = new DelayLine(this.loopD + 8)
    this.loopF = new Bq(sr)
    this.ringHz = 2200 + 1000 * rng.fork('mega-ring').next()
    this.echo = new DelayLine(Math.ceil(0.5 * sr) + 8)
    this.echoF = new Bq(sr).lp(2500, 0.7071)
    this.air = new SmallRoom(sr, 2.5)
    this.edges = new Edges()
    this.siren = new Tone(sr, new Rand(rng, 'mega-siren'))
    this.tmp = new Float32Array(BLOCK)
    this.env = 0
    this.envK = onePoleCoef(8, sr)
    this.sirenDone = false
    this.latency = 0
    this.set(p)
  }

  set(p) {
    let sz = SIZES.indexOf(p.size)
    if (sz < 0) sz = 0
    this.size = sz
    const hornAmt = frac(p.horn)
    const mic = this.mic.allOff()
    mic.f[0].hp(180, 0.7071)
    const h = this.horn.allOff()
    let j
    if (sz === 0) {
      j = butter(h, 0, 'hp', 520, 4)
      j = butter(h, j, 'lp', 4500, 4)
      h.f[j++].peak(1400, 2, 3 + 7 * hornAmt)
      h.f[j++].peak(2600, 2.5, 2 + 6 * hornAmt)
      this.combMs = 1.75
    } else if (sz === 1) {
      j = butter(h, 0, 'hp', 280, 2)
      j = butter(h, j, 'lp', 6000, 2)
      h.f[j++].peak(900, 2, 3 + 5 * hornAmt)
      h.f[j++].peak(1800, 2.5, 2 + 5 * hornAmt)
      h.f[j++].peak(3100, 3, 1 + 3 * hornAmt)
      this.combMs = 2.2
    } else {
      j = butter(h, 0, 'hp', 420, 4)
      j = butter(h, j, 'lp', 5000, 4)
      h.f[j++].peak(1100, 1.8, 3 + 6 * hornAmt)
      h.f[j++].peak(2200, 2.2, 2 + 5 * hornAmt)
      this.combMs = 2.6
    }
    this.combFb = 0.15 + 0.4 * hornAmt
    const push = frac(p.push)
    this.electric = sz !== 1
    this.lim.set(-30, sz === 1 ? 1.5 : 6, 1, 80, sz === 1 ? 4 : 9, 6)
    this.drive = sz === 1 ? 1 + 0.6 * push : 1.5 + (sz === 2 ? 7 : 6) * push
    this.sq = frac(p.squeal)
    this.loopF.bp(this.ringHz, 10)
    this.out = frac(p.outdoors) * (sz === 2 ? 1.3 : 1)
    this.air.set(1, 1.3, 0.5)
    if (this.offline && p.siren !== this.sirenMode) {
      this.plan = p.siren === 'off' ? { at: new Float64Array(0), quiet: false } : sirenPlan(this.phrases, this.sr, p.siren)
      this.planK = 0
    }
    this.sirenMode = p.siren
    this.makeup = db(sz === 1 ? 5 : 3)
  }

  _whoop(i, gain) {
    const a = SPEECH * 3.2 * gain
    this.siren.clear().add(650, 1500, 330, a, 1).add(1500, 650, 230, a, 1).add(650, 1500, 330, a * 0.8, 1).add(1500, 900, 160, a * 0.5, 1).start(i)
  }

  onRise(i, since) {
    // live only: offline the siren follows its plan
    if (this.offline || this.sirenMode === 'off') return
    if (this.sirenMode === 'start' && this.sirenDone) return
    if (this.sirenMode === 'each' && since < 1.5 * this.sr) return
    this.sirenDone = true
    this._whoop(i, 1)
  }

  onFall() {}

  run(s, n, talk) {
    const tmp = this.tmp
    if (talk) this.edges.scan(talk, n, this)
    if (this.offline) {
      const at = this.plan.at
      while (this.planK < at.length && at[this.planK] < this.t + n) {
        this._whoop(Math.max(0, at[this.planK] - this.t), this.plan.quiet ? 0.5 : 1)
        this.planK++
      }
      this.t += n
    }
    this.mic.run(s, n)
    // feedback howl: a self-contained loop (delay + narrow band pass, unity
    // peak gain) whose loop gain rises with the voice level; above one it
    // builds, below one it rings away; a soft limiter caps how loud it gets
    if (this.sq > 0) {
      let env = this.env
      const ek = this.envK
      const D = this.loopD
      const sq = this.sq
      const L = SPEECH * 1.6
      const iL = 1 / L
      for (let q = 0; q < n; q++) {
        const x = s[q]
        env += ((x < 0 ? -x : x) - env) * ek
        let en = env * 12.5
        if (en > 2) en = 2
        const g = sq * (1.1 + 0.55 * en)
        const v = this.loop.read(D - 1)
        let w = this.loopF.tick(x * 0.25 + g * v)
        w = L * Math.tanh(w * iL)
        this.loop.write(w)
        s[q] = x + w
      }
      this.env = env < 1e-9 ? 0 : env
    }
    this.siren.render(s, n)
    // driver: limiter and clipping
    this.lim.run(s, n)
    const d = this.drive
    if (this.electric) for (let q = 0; q < n; q++) s[q] = Math.tanh(s[q] * d) / d
    else for (let q = 0; q < n; q++) s[q] = Math.tanh(s[q] * d * 0.7) / (d * 0.7)
    // the horn: resonances and the internal reflection
    this.horn.run(s, n)
    const cd = this.combMs * 0.001 * this.sr
    const cf = this.combFb
    for (let q = 0; q < n; q++) {
      let y = s[q] + cf * this.comb.read(cd)
      if (y < 1e-20 && y > -1e-20) y = 0
      this.comb.write(y)
      s[q] = y
    }
    // outdoors: slaps off the buildings and a little open air
    if (this.out > 0) {
      const o = this.out
      const sr = this.sr
      for (let q = 0; q < n; q++) {
        this.echo.write(s[q])
        tmp[q] = 0.36 * this.echo.read(0.16 * sr) + 0.22 * this.echo.read(0.29 * sr) + 0.14 * this.echo.read(0.45 * sr)
      }
      this.echoF.run(tmp, n)
      for (let q = 0; q < n; q++) {
        const x = s[q]
        s[q] = x + tmp[q] * o
        tmp[q] = x
      }
      this.air.run(tmp, n, 1, 0)
      for (let q = 0; q < n; q++) s[q] += tmp[q] * 0.12 * o
    }
    const mk = this.makeup
    for (let q = 0; q < n; q++) s[q] *= mk
  }

  reset() {
    this.mic.reset()
    this.horn.reset()
    this.lim.reset()
    this.comb.clear()
    this.loop.clear()
    this.loopF.reset()
    this.echo.clear()
    this.echoF.reset()
    this.air.reset()
    this.edges.reset()
    this.siren.stop()
    this.sirenDone = false
    this.env = 0
    this.t = 0
    this.planK = 0
  }
}

export default makeDevice({
  id: 'device.megaphone',
  name: 'Megaphone',
  about: 'Shouting through a bullhorn: a honking horn, a pushed little amplifier, an optional siren whoop and squeal, and the street echoing back.',
  params: [
    {
      id: 'size', name: 'Kind', type: 'choice', def: 'bullhorn',
      options: [
        { v: 'bullhorn', name: 'Handheld bullhorn' },
        { v: 'cone', name: 'Cheering cone' },
        { v: 'roof', name: 'Rooftop horn' },
      ],
    },
    { id: 'horn', name: 'Horn honk', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [30, 90] },
    { id: 'push', name: 'Push', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    {
      id: 'siren', name: 'Siren', type: 'choice', def: 'off',
      options: [
        { v: 'off', name: 'Off' },
        { v: 'start', name: 'Whoop before talking' },
        { v: 'each', name: 'Whoop before every phrase' },
      ],
    },
    { id: 'squeal', name: 'Feedback squeal', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 30] },
    { id: 'outdoors', name: 'Street echo', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 70] },
  ],
  cost: 2,
  tail: (p) => (p && p.outdoors > 0 ? 1.4 : 0.2),
  talk: { gapMs: 900, leadMs: 0, holdMs: 700 },
  latency: () => 0,
  build: (sr, p, rng, info) => new MegaCore(sr, p, rng, info),
})
