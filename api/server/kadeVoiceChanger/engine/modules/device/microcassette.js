// modules/device/microcassette.js - device.microcassette, Answering machine tape.
//
// A message left on an answering machine's tiny tape:
// - the call: the caller came in over a phone line (300 Hz to 3.4 kHz,
//   a little line hiss), when the phone line setting is on;
// - the machine: the beep (a single tone of about 1 kHz) before the
//   message, recorded onto the tape with it, and an optional pair of short
//   end beeps after the last words;
// - recording: an automatic level control that pumps the room noise up in
//   the pauses, then a very slow tape (2.4 cm a second or less) with a dull
//   top end, a lot of hiss, and a cheap motor's speed wobble;
// - the motor: the whine of a small DC motor and its brushes, picked up by
//   the machine's own microphone circuit;
// - tape age: the top end fades, the hiss and dropouts grow;
// - playback through the machine's little speaker.
// Offline, the start beep sits in the pause before the first phrase that
// core/segment.js finds; live it plays when you first start talking after
// a long silence.

import { makeDevice, Bank, butter, Bq, Rand, Swell, LookSquash, Wobble, Edges, Tone, Burst, BLOCK, SPEECH, taper, frac, db, onePoleCoef } from './_kit.js'

const WOB_MS = 10
// The level control listens 5 ms ahead of the gain it sets, with a 1 ms
// attack, so the gain it built up in a pause is down again before the next
// word reaches it (no 6 ms overshoot at every word after a pause).
const ALC_AHEAD_MS = 5
const ALC_ATTACK_MS = 1

function latencyAt(sr) {
  return Math.max(4, Math.round(WOB_MS * 0.001 * sr)) + Math.max(1, Math.round(ALC_AHEAD_MS * 0.001 * sr))
}

class MicroCore {
  constructor(sr, p, rng, info) {
    this.sr = sr
    this.r = new Rand(rng, 'micro-noise')
    this.line = new Bank(sr, 4)
    this.rec = new Bank(sr, 5)
    this.spk = new Bank(sr, 5)
    this.alc = new LookSquash(sr, ALC_AHEAD_MS)
    this.wob = new Wobble(sr, WOB_MS, rng, 'micro')
    this.drop = new Swell(sr, new Rand(rng, 'micro-drop'))
    this.hissF = new Bank(sr, 2)
    this.motorF = new Bq(sr).bp(2200, 1.2)
    this.edges = new Edges()
    this.beep = new Tone(sr, new Rand(rng, 'micro-beep'))
    this.endBeep = new Tone(sr, new Rand(rng, 'micro-end'))
    this.stopClick = new Burst(sr, new Rand(rng, 'micro-stop')).color(200, 3000)
    this.tmp = new Float32Array(BLOCK)
    this.env = new Float32Array(BLOCK)
    this.mPh = 0
    this.motorHz = 95 + 30 * rng.fork('micro-motor').next()
    this.falls = 0
    this.phrases = info && info.offline ? info.phrases.length : -1
    this.started = false
    // offline: the beep fits the pause before the first words (shorter when
    // the take starts right away, never under the words if it can help it)
    this.t = 0
    this.beepAt = -1
    this.beepMs = 650
    if (this.phrases >= 0) {
      const first = info.phrases.length ? info.phrases[0].start / sr : 0
      this.beepMs = Math.round(1000 * Math.max(0.15, Math.min(0.65, first - 0.12)))
      this.beepAt = Math.max(0, Math.round((first - this.beepMs / 1000 - 0.08) * sr))
    }
    this.dl = 0
    this.latency = this.wob.latency + this.alc.latency
    this.set(p)
    this.wob.settle()
  }

  set(p) {
    const sr = this.sr
    const age = frac(p.age)
    this.lineOn = !!p.line
    const ln = this.line.allOff()
    let j = butter(ln, 0, 'hp', 300, 2)
    butter(ln, j, 'lp', 3400, 4)
    const rec = this.rec.allOff()
    j = butter(rec, 0, 'hp', 250, 2)
    j = butter(rec, j, 'lp', 4200 - 1800 * age, 4)
    rec.f[j++].hs(2000, 0.7071, -2 - 6 * age)
    this.alc.set(-34, 6, ALC_ATTACK_MS, 400, 10, 8)
    const w = frac(p.wobble)
    this.wob.set(0.017 * w, 1.6, 0.015 * w, 0.4, 0.0065 * w, 12, 0.002 * w, 32)
    this.drop.set(0.02 + 1.2 * age * age, 5, 40, 50, 0.8, 0.4)
    this.hissF.allOff()
    this.hissF.f[0].hp(600, 0.7071)
    this.hissF.f[1].lp(6000, 0.7071)
    this.hissLvl = taper(p.hiss, -14) * (1 + 0.6 * age)
    this.roomLvl = SPEECH * 0.01
    this.motorLvl = taper(p.motor, -14)
    this.beepMode = p.beep
    const spk = this.spk.allOff()
    j = butter(spk, 0, 'hp', 320, 2)
    j = butter(spk, j, 'lp', 4500, 2)
    spk.f[j++].peak(1500, 1.2, 3)
    this.dropK = onePoleCoef(1200, sr)
    this.makeup = db(6)
  }

  onRise(i, since) {
    // live only: a new message is talk after a long silence
    if (this.beepMode === 'none' || this.phrases >= 0) return
    if (this.started && since < 3 * this.sr) return
    this.started = true
    this.beep.clear().add(1040, 1040, 650, SPEECH * 3.2, 0).start(i)
  }

  onFall(i) {
    this.falls++
    if (this.beepMode !== 'both' || this.phrases < 0 || this.falls !== this.phrases) return
    const sr = this.sr
    const a = SPEECH * 2.6
    this.endBeep.clear().add(0, 0, 250, 0, 0).add(1040, 1040, 120, a, 0).add(0, 0, 90, 0, 0).add(1040, 1040, 120, a, 0).start(i)
    this.stopClick.trigger(i + Math.round(0.85 * sr), 0.5, 3, 15, SPEECH * 4, 0.1)
  }

  run(s, n, talk) {
    const r = this.r
    const tmp = this.tmp
    const env = this.env
    if (talk) this.edges.scan(talk, n, this)
    if (this.beepAt >= 0 && this.beepAt < this.t + n) {
      if (this.beepMode !== 'none') this.beep.clear().add(1040, 1040, this.beepMs, SPEECH * 3.2, 0).start(this.beepAt - this.t)
      this.beepAt = -1
    }
    this.t += n
    if (this.lineOn) {
      this.line.run(s, n)
      const g = SPEECH * 0.004
      for (let q = 0; q < n; q++) s[q] += r.w() * g
    }
    // the machine's beeps go onto the tape with the voice
    this.beep.render(s, n)
    this.endBeep.render(s, n)
    // room noise, then the level control that pumps it
    const rl = this.roomLvl
    for (let q = 0; q < n; q++) s[q] += r.w() * rl
    this.alc.run(s, n)
    // the motor whine and brushes, picked up while recording
    if (this.motorLvl > 0) {
      let ph = this.mPh
      const inc = this.motorHz / this.sr
      const g = this.motorLvl * 1.2
      r.fill(tmp, n)
      this.motorF.run(tmp, n)
      for (let q = 0; q < n; q++) {
        ph += inc
        if (ph >= 1) ph -= 1
        const a = 6.283185307 * ph
        const brush = Math.sin(6 * a)
        s[q] += g * (0.6 * Math.sin(a) + 0.35 * Math.sin(2 * a) + 0.25 * brush + tmp[q] * 2 * (0.6 + 0.4 * brush))
      }
      this.mPh = ph
    }
    this.rec.run(s, n)
    this.wob.run(s, n, null)
    this.drop.render(env, n)
    let dl = this.dl
    const dk = this.dropK
    for (let q = 0; q < n; q++) {
      const e = env[q]
      dl += (s[q] - dl) * dk
      if (e > 0) s[q] = (s[q] * (1 - e) + dl * e * 0.6) * (1 - 0.7 * e)
    }
    this.dl = dl
    r.fill(tmp, n)
    this.hissF.run(tmp, n)
    const hl = this.hissLvl * 2.2
    for (let q = 0; q < n; q++) s[q] += tmp[q] * hl
    this.stopClick.render(s, n)
    const mk = this.makeup / 0.85
    for (let q = 0; q < n; q++) s[q] = 0.85 * Math.tanh(s[q] * mk)
    this.spk.run(s, n)
  }

  reset() {
    this.line.reset()
    this.rec.reset()
    this.spk.reset()
    this.alc.reset()
    this.wob.reset()
    this.drop.reset()
    this.hissF.reset()
    this.motorF.reset()
    this.edges.reset()
    this.beep.stop()
    this.endBeep.stop()
    this.stopClick.stop()
    this.started = false
    this.falls = 0
    this.dl = 0
  }
}

export default makeDevice({
  id: 'device.microcassette',
  name: 'Answering machine tape',
  about: 'A message on an old answering machine: the beep, a phone-line voice on a tiny wobbly tape, hiss and motor whine.',
  params: [
    { id: 'wobble', name: 'Speed wobble', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [15, 70] },
    { id: 'hiss', name: 'Hiss', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [15, 70] },
    { id: 'motor', name: 'Motor whine', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 60] },
    {
      id: 'beep', name: 'Beeps', type: 'choice', def: 'start',
      options: [
        { v: 'none', name: 'No beep' },
        { v: 'start', name: 'Beep before the message' },
        { v: 'both', name: 'Beeps before and after' },
      ],
    },
    { id: 'line', name: 'Phone line', type: 'bool', def: true },
    { id: 'age', name: 'Tape age', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [10, 70] },
  ],
  cost: 2,
  tail: (p) => (p && p.beep === 'both' ? 1.1 : 0.2),
  talk: { gapMs: 400, leadMs: 0, holdMs: 400 },
  latency: latencyAt,
  build: (sr, p, rng, info) => new MicroCore(sr, p, rng, info),
})
