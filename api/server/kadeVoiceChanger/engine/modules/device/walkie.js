// modules/device/walkie.js - device.walkie, Walkie-talkie.
//
// A narrowband FM handheld, built the way one behaves:
// - push to talk: every transmission (phrases joined across short pauses,
//   from core/segment.js offline or the kit's live talk gate) opens with a
//   key-up click and a short noise puff, carries a faint carrier hiss under
//   the voice, and closes with an optional roger beep and then the squelch
//   tail: the burst of loud noise you hear for a fifth of a second when the
//   far transmitter drops and before the receiver's squelch shuts. Between
//   transmissions the squelch keeps the speaker silent.
// - the microphone side: a speech bandpass and a hard-working automatic
//   level control that clips when you shout (the "audio processing" of
//   two-way radios).
// - weak signals: more hiss, crackle and "picket fencing", the rapid
//   flutter of an FM signal as the walker moves through dead spots.
// - the receiver: a small loudspeaker with its two resonances.
// Bands: family radio (clean narrow FM), toy (thin, hissy, distorted),
// field radio (heavier processing, narrower, rougher tails) and digital
// (coded voice with robotic warble, no hiss and no tail, just a short
// end-of-call chirp). Squelch tails follow the descriptions of FM squelch
// behaviour in the ARRL Handbook (receiver squelch and noise-operated
// squelch chapters).

import { makeDevice, Bank, butter, Rand, Crackler, Squash, SpecCodec, RateHold, Swell, Edges, Tone, Burst, BLOCK, SPEECH, taper, frac, db, codecSize, onePoleCoef } from './_kit.js'

const BANDS = ['frs', 'toy', 'field', 'digital']
const MAKEUP = [6, 7, 5, 5]

class WalkieCore {
  constructor(sr, p, rng) {
    this.sr = sr
    this.r = new Rand(rng, 'walkie-noise')
    this.mic = new Bank(sr, 6)
    this.spk = new Bank(sr, 7)
    this.hissF = new Bank(sr, 2)
    this.alc = new Squash(sr)
    this.codec = new SpecCodec(sr, new Rand(rng, 'walkie-codec'))
    this.hold = new RateHold(sr)
    this.crk = new Crackler(sr, new Rand(rng, 'walkie-crackle'))
    this.fence = new Swell(sr, new Rand(rng, 'walkie-fence'))
    this.edges = new Edges()
    this.beep = new Tone(sr, new Rand(rng, 'walkie-beep'))
    this.clk = new Burst(sr, new Rand(rng, 'walkie-click'))
    this.puff = new Burst(sr, new Rand(rng, 'walkie-puff'))
    this.tailB = new Burst(sr, new Rand(rng, 'walkie-tail'))
    this.tmp = new Float32Array(BLOCK)
    this.ev = new Float32Array(BLOCK)
    this.open = 0
    this.openTarget = 0
    this.closeAt = -1
    this.latency = codecSize(sr)
    this.set(p)
  }

  set(p) {
    let band = BANDS.indexOf(p.band)
    if (band < 0) band = 0
    this.band = band
    const sig = frac(p.signal)
    const weak = 1 - sig
    const clip = frac(p.clip)
    const mic = this.mic.allOff()
    const spk = this.spk.allOff()
    this.hissF.allOff()
    let j = 0
    let lo = 300
    let hi = 3000
    let hissMax = -22
    let tailMs = 170
    this.digital = band === 3
    if (band === 1) {
      lo = 500
      hi = 2500
      hissMax = -14
      tailMs = 140
    } else if (band === 2) {
      lo = 350
      hi = 2400
      hissMax = -18
      tailMs = 220
    } else if (band === 3) {
      lo = 300
      hi = 3400
    }
    j = butter(mic, 0, 'hp', lo, 4)
    j = butter(mic, j, 'lp', hi + 300, 8)
    // receiver speaker: about 2 inches, two resonances
    j = butter(spk, 0, 'hp', lo + 100, 4)
    j = butter(spk, j, 'lp', hi + 200, 4)
    spk.f[j++].peak(band === 1 ? 1600 : 1200, 1.6, 4)
    spk.f[j++].peak(2500, 2.5, 3)
    // level control: always on, harder with the clip setting
    this.alc.set(-30, 4 + 6 * clip, 1, 120, 9 + 5 * clip, 6)
    this.drive = 1 + (band === 1 ? 5 : band === 2 ? 4 : 2.5) * clip
    // carrier hiss under the voice, brighter than the voice band
    this.hissF.f[0].hp(900, 0.7071)
    this.hissLvl = this.digital ? 0 : taper(p.hiss, hissMax) * (1 + 3 * weak * weak)
    this.sq = frac(p.squelch)
    this.tailMs = tailMs
    this.tailLvl = this.digital ? 0 : SPEECH * 2.3 * this.sq
    this.tailB.color(400, 7000)
    this.puff.color(600, 6000)
    this.clk.color(500, 5000)
    // weak signal: picket fencing and crackle
    this.fence.set(this.digital ? 0 : 6 * Math.pow(weak, 1.5), 4, 10, 18, 0.8, 0.5)
    this.crk.set(this.digital ? 0 : 1 + 25 * weak * weak, 0, 0.04, 0.6, 0.6)
    this.crkLvl = this.digital ? 0 : SPEECH * (0.3 + 1.5 * weak)
    if (this.digital) {
      this.hold.set(8000, 2, 13, 1)
      this.codec.set(true, 3400, 0.65, 0.22 + 0.1 * clip, 1800, 0.3, 16 * Math.pow(weak, 1.4), 0.4, 0.4)
    } else {
      this.hold.set(this.sr, 0, 16, 1)
      this.codec.set(false, 3400, 0, 0, 0, 0, 0, 0)
    }
    this.roger = p.beep
    this.makeup = db(MAKEUP[band])
  }

  onRise(i) {
    // key-up: a click and a short puff of noise as the squelch opens
    this.tailB.stop()
    this.beep.stop()
    this.closeAt = -1
    this.openTarget = 1
    this.clk.trigger(i, 0.3, 1.2, 3, SPEECH * 5 * (0.4 + 0.6 * this.sq), 0)
    if (!this.digital) this.puff.trigger(i, 2, 18 + 25 * this.sq, 20, SPEECH * 1.6 * this.sq, 0.4)
  }

  onFall(i) {
    const sr = this.sr
    let wait = i
    const b = this.beep.clear()
    const lvl = SPEECH * 2.2
    if (this.roger === 'chirp') b.add(1100, 2300, 130, lvl, 0)
    else if (this.roger === 'two') b.add(1800, 1800, 80, lvl, 0).add(1200, 1200, 100, lvl, 0)
    else if (this.roger === 'low') b.add(800, 800, 170, lvl, 1)
    if (this.digital && this.roger === 'none') b.add(2400, 2400, 40, lvl * 0.6, 0).add(0, 0, 25, 0, 0).add(2400, 2400, 40, lvl * 0.6, 0)
    if (b.nseg) {
      b.start(wait + Math.round(0.03 * sr))
      wait += Math.round(0.03 * sr) + b.length
    }
    if (this.tailLvl > 0) {
      const t = this.tailMs * (0.85 + 0.3 * this.r.u())
      this.tailB.trigger(wait, 1, t, 6, this.tailLvl, 0.5)
      wait += Math.round(((t + 8) * sr) / 1000)
    }
    this.closeAt = wait + Math.round(0.01 * sr)
  }

  run(s, n, talk) {
    const r = this.r
    const tmp = this.tmp
    const ev = this.ev
    ev.fill(0, 0, n)
    if (talk) this.edges.scan(talk, n, this)
    else this.openTarget = 1
    // microphone and level control
    this.mic.run(s, n)
    this.alc.run(s, n)
    const d = this.drive
    for (let q = 0; q < n; q++) s[q] = Math.tanh(s[q] * d) / d
    this.hold.run(s, n)
    this.codec.run(s, n)
    // channel: hiss and crackle while the carrier is up, picket fencing
    if (this.hissLvl > 0) {
      r.fill(tmp, n)
      this.hissF.run(tmp, n)
      const g = this.hissLvl * 2
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
    }
    if (this.crkLvl > 0) {
      this.crk.render(tmp, n)
      const g = this.crkLvl
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
    }
    if (!this.digital) {
      this.fence.render(tmp, n)
      for (let q = 0; q < n; q++) {
        const e = tmp[q]
        if (e > 0) s[q] = s[q] * (1 - 0.85 * e) + r.w() * e * SPEECH * 0.9
      }
    }
    // squelch: open while the carrier is up, shut after the tail
    let o = this.open
    const kOpen = onePoleCoef(400, this.sr)
    const kShut = onePoleCoef(300, this.sr)
    let ca = this.closeAt
    let tgt = this.openTarget
    for (let q = 0; q < n; q++) {
      if (ca >= 0) {
        if (ca === 0) {
          tgt = 0
          ca = -1
        } else ca--
      }
      o += (tgt - o) * (tgt > o ? kOpen : kShut)
      s[q] *= o
    }
    if (o < 1e-6) o = 0
    this.open = o
    this.closeAt = ca
    this.openTarget = tgt
    // one-shots ride on top (beep through the radio, tail is pure noise)
    this.beep.render(ev, n)
    this.clk.render(ev, n)
    this.puff.render(ev, n)
    this.tailB.render(ev, n)
    for (let q = 0; q < n; q++) s[q] += ev[q]
    // the little speaker amplifier runs out of room on shouts
    const mk = this.makeup / 0.75
    for (let q = 0; q < n; q++) s[q] = 0.75 * Math.tanh(s[q] * mk)
    this.spk.run(s, n)
  }

  reset() {
    this.mic.reset()
    this.spk.reset()
    this.hissF.reset()
    this.alc.reset()
    this.codec.reset()
    this.hold.reset()
    this.crk.reset()
    this.fence.reset()
    this.edges.reset()
    this.beep.stop()
    this.clk.stop()
    this.puff.stop()
    this.tailB.stop()
    this.open = 0
    this.openTarget = 0
    this.closeAt = -1
  }
}

export default makeDevice({
  id: 'device.walkie',
  name: 'Walkie-talkie',
  about: 'A handheld two-way radio: a click as you key up, hiss under your words and a burst of squelch noise when you let go.',
  params: [
    {
      id: 'band', name: 'Radio', type: 'choice', def: 'frs',
      options: [
        { v: 'frs', name: 'Family radio' },
        { v: 'toy', name: 'Toy walkie-talkie' },
        { v: 'field', name: 'Field radio' },
        { v: 'digital', name: 'Digital radio' },
      ],
    },
    { id: 'squelch', name: 'Squelch bursts', type: 'number', min: 0, max: 100, step: 1, def: 70, unit: 'percent', rand: [40, 100] },
    {
      id: 'beep', name: 'Roger beep', type: 'choice', def: 'none',
      options: [
        { v: 'none', name: 'None' },
        { v: 'chirp', name: 'Rising chirp' },
        { v: 'two', name: 'Two tones' },
        { v: 'low', name: 'Low beep' },
      ],
    },
    { id: 'clip', name: 'Overdrive', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [10, 70] },
    { id: 'hiss', name: 'Hiss', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [10, 60] },
    { id: 'signal', name: 'Signal strength', type: 'number', min: 0, max: 100, step: 1, def: 85, unit: 'percent', rand: [40, 100] },
  ],
  cost: 2,
  tail: () => 0.6,
  talk: { gapMs: 650, leadMs: 40, holdMs: 500 },
  latency: (sr) => codecSize(sr),
  build: (sr, p, rng) => new WalkieCore(sr, p, rng),
})
