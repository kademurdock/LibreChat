// modules/device/babymonitor.js - device.babymonitor, Baby monitor.
//
// An old analog baby monitor, nursery to kitchen:
// - the nursery: the talker is across a small soft room from the unit, so
//   the voice arrives with a little room around it (kit SmallRoom);
// - voice activation: the transmitter only keys up when it hears sound,
//   so every phrase starts with a hiss burst and loses its first moment,
//   and the line goes quiet between phrases (turn it off for a hiss that
//   never stops);
// - the radio link: a 2:1 compressor before the FM hop and a 1:2 expander
//   after it, with slightly mismatched timing, so the hiss breathes and
//   pumps with every syllable (the companding of cheap analog links);
// - crackle and interference: static ticks and a neighbour's cordless
//   phone bleeding in as garbled, pitch-shifted chatter with a buzz;
// - the parent unit's tiny speaker.

import { makeDevice, Bank, butter, Rand, Crackler, Compander, SmallRoom, Edges, Burst, Shift, BLOCK, SPEECH, taper, frac, db, onePoleCoef } from './_kit.js'
import { DelayLine } from '../../core/delay.js'

class MonitorCore {
  constructor(sr, p, rng) {
    this.sr = sr
    this.r = new Rand(rng, 'baby-noise')
    this.room = new SmallRoom(sr, 1.3)
    this.mic = new Bank(sr, 4)
    this.spk = new Bank(sr, 5)
    this.tx = new Compander(sr)
    this.rx = new Compander(sr)
    this.hissF = new Bank(sr, 2)
    this.crk = new Crackler(sr, new Rand(rng, 'baby-crackle'))
    this.edges = new Edges()
    this.keyB = new Burst(sr, new Rand(rng, 'baby-key')).color(700, 7000)
    this.other = new DelayLine(Math.ceil(1.3 * sr) + 8)
    this.otherShift = new Shift(sr)
    this.otherShift.set(310)
    this.otherF = new Bank(sr, 3)
    butter(this.otherF, 0, 'lp', 2400, 4)
    this.otherF.f[2].hp(400, 0.7071)
    this.tmp = new Float32Array(BLOCK)
    this.tmp2 = new Float32Array(BLOCK)
    this.gate = 0
    this.target = 0
    this.vox = 0
    this.voxFrom = 0
    this.closeAt = -1
    this.bPh = 0
    this.latency = 0
    this.set(p)
  }

  set(p) {
    const rm = frac(p.room)
    this.roomWet = 0.15 + 0.6 * rm
    this.room.set(0.3 + 0.3 * rm, 0.35 + 0.25 * rm, 0.6)
    const mic = this.mic.allOff()
    let j = butter(mic, 0, 'hp', 200, 2)
    butter(mic, j, 'lp', 4000, 4)
    const spk = this.spk.allOff()
    j = butter(spk, 0, 'hp', 350, 2)
    j = butter(spk, j, 'lp', 3500, 4)
    spk.f[j++].peak(1500, 1.2, 3)
    const pump = frac(p.pumping)
    this.tx.set(2, SPEECH, 3, 50, 24, 1)
    this.rx.set(1 + 1.2 * pump, SPEECH * 0.8, 10 + 10 * pump, 25, 24, -1)
    this.hissF.allOff()
    this.hissF.f[0].hp(1000, 0.7071)
    this.hissF.f[1].lp(8000, 0.7071)
    this.hissLvl = taper(p.hiss, -10)
    this.hissPct = frac(p.hiss)
    const c = frac(p.crackle)
    this.crk.set(c > 0 ? 2 + 40 * c : 0, 0.3 * c, 0.03, 0.8, 0.5)
    this.crkLvl = taper(p.crackle, 4)
    this.voxOn = !!p.vox
    this.inter = taper(p.interference, -6, 30)
    this.makeup = db(6)
  }

  onRise(i) {
    if (!this.voxOn) return
    this.target = 1
    this.closeAt = -1
    // the transmitter keys up: a hiss burst, and the first moment is lost
    this.keyB.trigger(i, 1, 40, 30, SPEECH * 0.7 * (0.3 + this.hissPct), 0.4)
    this.vox = Math.round(0.07 * this.sr)
    this.voxFrom = i
  }

  onFall(i) {
    if (!this.voxOn) return
    this.closeAt = i + Math.round(0.25 * this.sr)
  }

  run(s, n, talk) {
    const r = this.r
    const tmp = this.tmp
    const tmp2 = this.tmp2
    if (talk) this.edges.scan(talk, n, this)
    if (!this.voxOn) this.target = 1
    this.room.run(s, n, this.roomWet, 1 - 0.5 * this.roomWet)
    this.mic.run(s, n)
    // voice activation clips the first moment of each phrase
    if (this.vox > 0) {
      const a = this.voxFrom
      const m = Math.min(n, a + this.vox)
      for (let q = a; q < m; q++) s[q] *= 0.05
      this.vox -= m - a
      this.voxFrom = 0
    }
    this.tx.run(s, n)
    for (let q = 0; q < n; q++) s[q] = Math.tanh(s[q] * 2.5) / 2.5
    // the radio hop: hiss, crackle and the neighbour's phone
    r.fill(tmp, n)
    this.hissF.run(tmp, n)
    const hl = this.hissLvl * 2.2
    for (let q = 0; q < n; q++) s[q] += tmp[q] * hl
    if (this.crkLvl > 0) {
      this.crk.render(tmp, n)
      const g = this.crkLvl
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
    }
    if (this.inter > 0) {
      for (let q = 0; q < n; q++) {
        this.other.write(s[q])
        tmp2[q] = this.other.read(1.2 * this.sr)
      }
      this.otherShift.run(tmp2, n)
      this.otherF.run(tmp2, n)
      let ph = this.bPh
      const g = this.inter * 5
      const bz = this.inter * 0.6
      for (let q = 0; q < n; q++) {
        ph += 120 / this.sr
        if (ph >= 1) ph -= 1
        s[q] += tmp2[q] * g + (ph < 0.1 ? bz : -bz * 0.111)
      }
      this.bPh = ph
    }
    this.rx.run(s, n)
    // the receiver squelch follows the transmitter
    let gt = this.gate
    let tg = this.target
    let ca = this.closeAt
    const ku = onePoleCoef(300, this.sr)
    const kd = onePoleCoef(60, this.sr)
    for (let q = 0; q < n; q++) {
      if (ca >= 0) {
        if (ca === 0) {
          tg = 0
          ca = -1
        } else ca--
      }
      gt += (tg - gt) * (tg > gt ? ku : kd)
      s[q] *= gt
    }
    this.gate = gt < 1e-6 ? 0 : gt
    this.target = tg
    this.closeAt = ca
    this.keyB.render(s, n)
    const mk = this.makeup / 0.8
    for (let q = 0; q < n; q++) s[q] = 0.8 * Math.tanh(s[q] * mk)
    this.spk.run(s, n)
  }

  reset() {
    this.room.reset()
    this.mic.reset()
    this.spk.reset()
    this.tx.reset()
    this.rx.reset()
    this.hissF.reset()
    this.crk.reset()
    this.edges.reset()
    this.keyB.stop()
    this.other.clear()
    this.otherShift.reset()
    this.otherF.reset()
    this.gate = 0
    this.target = 0
    this.closeAt = -1
    this.vox = 0
  }
}

export default makeDevice({
  id: 'device.babymonitor',
  name: 'Baby monitor',
  about: 'Your voice over an old baby monitor: a hiss that breathes with every word, crackle, and the nursery around you.',
  params: [
    { id: 'hiss', name: 'Hiss', type: 'number', min: 0, max: 100, step: 1, def: 40, unit: 'percent', rand: [15, 70] },
    { id: 'pumping', name: 'Pumping', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
    { id: 'crackle', name: 'Crackle', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 60] },
    { id: 'room', name: 'Distance from the monitor', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [10, 80] },
    { id: 'vox', name: 'Voice activated', type: 'bool', def: true },
    { id: 'interference', name: 'Neighbor interference', type: 'number', min: 0, max: 100, step: 1, def: 15, unit: 'percent', rand: [0, 50] },
  ],
  cost: 2,
  tail: () => 0.6,
  talk: { gapMs: 400, leadMs: 0, holdMs: 350 },
  latency: () => 0,
  build: (sr, p, rng) => new MonitorCore(sr, p, rng),
})
