// modules/device/cb.js - device.cb, CB radio: the 27 MHz citizens band, AM.
//
// The chain of a trucker's rig, end to end:
// - a punchy hand mic and, optionally, the echo box many drivers wired in
//   (a bucket-brigade style delay: about 110 ms, darkening repeats);
// - an amplitude-modulated transmitter driven hard: positive peaks round
//   off while the negative ones pinch the carrier off and clip flat, the
//   lopsided "splatter" of overmodulated AM (described in the ARRL Handbook
//   chapter on AM transmitters);
// - the band itself: skip fading when signals bounce off the ionosphere
//   (a slow deep fade plus a moving two-path comb, the selective fading of
//   long-distance propagation) with a faint far station bleeding through,
//   constant crackly static, and the heterodyne whistle of two carriers
//   beating on the same channel;
// - squelch: open, the static runs all the time; tight, the receiver is
//   quiet between transmissions and each one starts with a carrier thump
//   and ends with a short burst of static; static drops under a strong
//   carrier (receiver quieting) and swells back as the skip fades;
// - an optional roger beep, and the radio's own small speaker.

import { makeDevice, Ctl, Bank, butter, Bq, Rand, Crackler, Edges, Tone, Burst, Shift, BLOCK, SPEECH, taper, frac, db, onePoleCoef } from './_kit.js'
import { DelayLine } from '../../core/delay.js'

class CBCore {
  constructor(sr, p, rng) {
    this.sr = sr
    this.r = new Rand(rng, 'cb-noise')
    this.mic = new Bank(sr, 6)
    this.spk = new Bank(sr, 6)
    this.ifF = new Bank(sr, 4)
    this.staticF = new Bank(sr, 2)
    this.echo = new DelayLine(Math.ceil(0.14 * sr) + 8)
    this.echoLp = new Bq(sr).lp(2400, 0.7071)
    this.echoHp = new Bq(sr).hp(250, 0.7071)
    this.path = new DelayLine(Math.ceil(0.004 * sr) + 8)
    this.far = new DelayLine(Math.ceil(1.0 * sr) + 8)
    this.farShift = new Shift(sr)
    this.farShift.set(170)
    this.farF = new Bank(sr, 2)
    butter(this.farF, 0, 'lp', 2200, 4)
    this.fadeL = new Ctl(sr, { shape: 'smooth', rate: 0.12, rng: rng.fork('cb-fade') })
    this.combL = new Ctl(sr, { shape: 'smooth', rate: 0.2, rng: rng.fork('cb-comb') })
    this.hetL = new Ctl(sr, { shape: 'smooth', rate: 0.3, rng: rng.fork('cb-het') })
    this.crk = new Crackler(sr, new Rand(rng, 'cb-crackle'))
    this.edges = new Edges()
    this.roger = new Tone(sr, new Rand(rng, 'cb-roger'))
    this.thump = new Burst(sr, new Rand(rng, 'cb-thump')).color(150, 1200)
    this.burst = new Burst(sr, new Rand(rng, 'cb-burst')).color(300, 5000)
    this.tmp = new Float32Array(BLOCK)
    this.ev = new Float32Array(BLOCK)
    this.hetPh = 0
    this.hetHz = 700 + 1100 * rng.fork('cb-hetf').next()
    this.carrier = 0
    this.carrierT = 0
    this.closeAt = -1
    this.latency = 0
    this.set(p)
  }

  set(p) {
    const sr = this.sr
    const sp = frac(p.splatter)
    this.sk = frac(p.skip)
    this.sq = frac(p.squelch)
    this.ech = frac(p.echo)
    const mic = this.mic.allOff()
    let j = butter(mic, 0, 'hp', 280, 4)
    j = butter(mic, j, 'lp', 3200, 4)
    mic.f[j++].peak(1800, 1.2, 3 + 4 * sp)
    const spk = this.spk.allOff()
    j = butter(spk, 0, 'hp', 350, 4)
    j = butter(spk, j, 'lp', 3300, 2)
    spk.f[j++].peak(1000, 1.2, 3)
    // receiver IF filter: about 3 kHz audio
    this.ifF.allOff()
    butter(this.ifF, 0, 'lp', 3000, 8)
    this.staticF.allOff()
    this.staticF.f[0].lp(3800, 0.7071)
    this.staticF.f[1].hp(250, 0.7071)
    this.drive = 1 + 7 * sp
    this.staticLvl = taper(p.static, -9)
    this.crk.set(5 + 60 * frac(p.static), 0.3 * frac(p.static), 0.03, 0.8, 0.5)
    this.hetLvl = taper(p.whistle, -10, 30)
    this.rogerKind = p.roger
    this.echoFb = 0.35 + 0.3 * this.ech
    this.fadeL.rate = 0.06 + 0.25 * this.sk
    this.combL.rate = 0.1 + 0.3 * this.sk
    this.makeup = db(5)
    this.kc = onePoleCoef(60, sr)
  }

  onRise(i) {
    this.carrierT = 1
    this.closeAt = -1
    this.roger.stop()
    this.burst.stop()
    this.thump.trigger(i, 2, 10, 25, SPEECH * 3 * (0.3 + 0.7 * this.sq), 0.2)
  }

  onFall(i) {
    const sr = this.sr
    let wait = i
    const b = this.roger.clear()
    const lvl = SPEECH * 2.4
    if (this.rogerKind === 'beep') b.add(1000, 1000, 160, lvl, 0)
    else if (this.rogerKind === 'tones') b.add(700, 700, 70, lvl, 0).add(1000, 1000, 70, lvl, 0).add(1400, 1400, 90, lvl, 0)
    if (b.nseg) {
      b.start(wait + Math.round(0.02 * sr))
      wait += Math.round(0.02 * sr) + b.length
    }
    this.closeAt = wait
    if (this.sq > 0.05) this.burst.trigger(wait, 2, 70 + 60 * this.sq, 20, SPEECH * 2.2 * this.sq, 0.6)
  }

  run(s, n, talk) {
    const r = this.r
    const tmp = this.tmp
    const ev = this.ev
    ev.fill(0, 0, n)
    if (talk) this.edges.scan(talk, n, this)
    this.mic.run(s, n)
    // echo box
    if (this.ech > 0) {
      const dl = this.echo
      const D = 0.11 * this.sr
      const fb = this.echoFb
      const mix = this.ech * 0.9
      for (let q = 0; q < n; q++) {
        const e = dl.read(D)
        let w = s[q] + e * fb
        w = this.echoHp.tick(this.echoLp.tick(w))
        dl.write(w)
        s[q] += e * mix
      }
    }
    // overmodulated AM: lopsided clipping
    const d = this.drive
    for (let q = 0; q < n; q++) {
      const v = s[q] * d * 2.5
      const y = v > 0 ? Math.tanh(v / 1.6) * 1.6 : v < -0.75 ? -0.75 - 0.05 * Math.tanh((-v - 0.75) * 4) : v
      s[q] = y / (d * 2.5)
    }
    this.roger.render(s, n)
    // skip: a slow fade and a moving two-path comb, a far station under it
    const sk = this.sk
    const path = this.path
    const far = this.far
    const farLvl = sk > 0.3 ? ((sk - 0.3) / 0.7) * 0.16 : 0
    for (let q = 0; q < n; q++) {
      const x = s[q]
      path.write(x)
      const dd = (1.4 + 1.1 * this.combL.next()) * 0.001 * this.sr
      const f = 0.5 + 0.5 * this.fadeL.next()
      const fade = 1 - sk * 0.92 * f * f
      tmp[q] = fade
      s[q] = (x + sk * 0.7 * path.read(dd)) * fade
      far.write(x)
      ev[q] = far.read(0.83 * this.sr)
    }
    if (farLvl > 0) {
      const ff = this.farF
      // reuse the event buffer for the far station
      this.farShift.run(ev, n)
      ff.run(ev, n)
      for (let q = 0; q < n; q++) s[q] += ev[q] * farLvl * (0.5 + (1 - tmp[q]))
    }
    ev.fill(0, 0, n)
    // carrier state, static, heterodyne whistle
    let c = this.carrier
    let ct = this.carrierT
    let ca = this.closeAt
    const kc = this.kc
    const sq = this.sq
    const st = this.staticLvl * 4.3
    const het = this.hetLvl * 1.41
    this.crk.render(ev, n)
    const cl = this.staticLvl * 4
    let hp = this.hetPh
    for (let q = 0; q < n; q++) {
      if (ca >= 0) {
        if (ca === 0) {
          ct = 0
          ca = -1
        } else ca--
      }
      c += (ct - c) * kc
      const fade = tmp[q]
      const open = (1 - sq) * (1 - c) + c * (0.55 + 1.2 * (1 - fade))
      const hz = this.hetHz + 18 * this.hetL.next()
      hp += hz / this.sr
      if (hp >= 1) hp -= 1
      const w = Math.sin(6.283185307 * hp)
      tmp[q] = (r.w() * st + ev[q] * cl) * open + w * het * (c + (1 - sq) * (1 - c))
    }
    this.hetPh = hp
    this.carrier = c
    this.carrierT = ct
    this.closeAt = ca
    this.staticF.run(tmp, n)
    for (let q = 0; q < n; q++) s[q] += tmp[q]
    ev.fill(0, 0, n)
    this.thump.render(ev, n)
    this.burst.render(ev, n)
    for (let q = 0; q < n; q++) s[q] += ev[q]
    this.ifF.run(s, n)
    this.spk.run(s, n)
    const mk = this.makeup
    for (let q = 0; q < n; q++) s[q] *= mk
  }

  reset() {
    this.mic.reset()
    this.spk.reset()
    this.ifF.reset()
    this.staticF.reset()
    this.echo.clear()
    this.path.clear()
    this.far.clear()
    this.farShift.reset()
    this.farF.reset()
    this.crk.reset()
    this.edges.reset()
    this.roger.stop()
    this.thump.stop()
    this.burst.stop()
    this.carrier = 0
    this.carrierT = 0
    this.closeAt = -1
  }
}

export default makeDevice({
  id: 'device.cb',
  name: 'CB radio',
  about: 'A trucker on the citizens band: crackling static, a whistle on the channel, skip fading and an overdriven mic.',
  params: [
    { id: 'skip', name: 'Skip fading', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [0, 70] },
    { id: 'whistle', name: 'Whistle', type: 'number', min: 0, max: 100, step: 1, def: 20, unit: 'percent', rand: [0, 50] },
    { id: 'splatter', name: 'Splatter', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [15, 80] },
    { id: 'squelch', name: 'Squelch', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [0, 100] },
    { id: 'static', name: 'Static', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [15, 70] },
    { id: 'echo', name: 'Echo mic', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 60] },
    {
      id: 'roger', name: 'Roger beep', type: 'choice', def: 'none',
      options: [
        { v: 'none', name: 'None' },
        { v: 'beep', name: 'Beep' },
        { v: 'tones', name: 'Three rising tones' },
      ],
    },
  ],
  cost: 2,
  tail: () => 0.6,
  talk: { gapMs: 650, leadMs: 30, holdMs: 500 },
  latency: () => 0,
  build: (sr, p, rng) => new CBCore(sr, p, rng),
})
