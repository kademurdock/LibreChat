// modules/device/tv.js - device.tv, Old TV in the next room.
//
// A television voice heard from somewhere else in the house:
// - the set: broadcast processing, then the TV's own small speaker (a
//   warm, narrow 1950s valve set with its hum; a 1980s console with a
//   wider speaker; a modern flat TV whose tiny downward speakers are thin
//   and heavily compressed), and the high whine of a picture tube's line
//   transformer at 15.7 kHz on the older sets (the NTSC line rate; it is
//   left out when the sample rate cannot carry it);
// - the TV's room: a small room's reverberation (kit SmallRoom);
// - the way to you: in the same room, through an open door (a little
//   duller and more roomy), through a closed door, or through a wall,
//   where only the low murmur and the room's boom get through (the mass
//   law of sound insulation: transmission loss rising with frequency).

import { makeDevice, Bank, butter, Rand, Hum, Squash, SmallRoom, BLOCK, taper, frac, db } from './_kit.js'

const ERAS = ['1950s', '1980s', 'flat']
const WALLS = ['same', 'open', 'closed', 'wall']
const WET = [0.3, 0.6, 0.8, 0.9]
const MAKEUP = [3, 6, 12, 17]

class TVCore {
  constructor(sr, p, rng) {
    this.sr = sr
    this.r = new Rand(rng, 'tv-noise')
    this.comp = new Squash(sr)
    this.spk = new Bank(sr, 6)
    this.hum = new Hum(sr, 60)
    this.room = new SmallRoom(sr, 2)
    this.wallF = new Bank(sr, 5)
    this.tmp = new Float32Array(BLOCK)
    this.wPh = 0
    this.latency = 0
    this.set(p)
  }

  set(p) {
    let e = ERAS.indexOf(p.era)
    if (e < 0) e = 1
    let w = WALLS.indexOf(p.wall)
    if (w < 0) w = 1
    this.era = e
    this.wall = w
    const spk = this.spk.allOff()
    let j
    if (e === 0) {
      j = butter(spk, 0, 'hp', 200, 2)
      j = butter(spk, j, 'lp', 4000, 4)
      spk.f[j++].peak(1000, 1.2, 4)
      this.comp.set(-26, 3, 5, 200, 4, 8)
      this.tube = 1.6
    } else if (e === 1) {
      j = butter(spk, 0, 'hp', 150, 2)
      j = butter(spk, j, 'lp', 6000, 4)
      spk.f[j++].peak(2000, 1.2, 3)
      this.comp.set(-26, 3, 5, 200, 4, 8)
      this.tube = 0
    } else {
      j = butter(spk, 0, 'hp', 250, 4)
      j = butter(spk, j, 'lp', 12000, 2)
      spk.f[j++].peak(4000, 1, 3)
      this.comp.set(-30, 5, 2, 120, 8, 8)
      this.tube = 0
    }
    this.humLvl = e === 2 ? 0 : taper(p.hum, e === 0 ? -14 : -22)
    this.whine = e !== 2 && this.sr > 33000 ? taper(p.whine, -16, 30) * 1.41 : 0
    const rm = frac(p.room)
    this.room.set(0.3 + 0.6 * rm, 0.3 + 0.6 * rm, 0.5)
    this.wet = WET[w] * (0.6 + 0.5 * rm)
    const wf = this.wallF.allOff()
    if (w === 1) {
      wf.f[0].lp(7000, 0.7071)
      wf.f[1].peak(2500, 1, -3)
    } else if (w === 2) {
      j = butter(wf, 0, 'lp', 900, 4)
      wf.f[j++].lp(1800, 0.7071)
      wf.f[j++].peak(200, 1, 3)
    } else if (w === 3) {
      j = butter(wf, 0, 'lp', 450, 4)
      wf.f[j++].lp(900, 0.7071)
      wf.f[j++].peak(120, 1, 4)
    }
    this.makeup = db(MAKEUP[w])
  }

  run(s, n) {
    const tmp = this.tmp
    this.comp.run(s, n)
    this.spk.run(s, n)
    if (this.tube > 0) {
      const k = this.tube
      for (let q = 0; q < n; q++) s[q] = Math.tanh(s[q] * k * 2) / (k * 2)
    }
    if (this.humLvl > 0) {
      this.hum.render(tmp, n, 0.25)
      const g = this.humLvl
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
    }
    if (this.whine > 0) {
      let ph = this.wPh
      const inc = 15734.26 / this.sr
      const g = this.whine
      for (let q = 0; q < n; q++) {
        ph += inc
        if (ph >= 1) ph -= 1
        s[q] += Math.sin(6.283185307 * ph) * g
      }
      this.wPh = ph
    }
    // the set's amplifier runs out of room in the TV, not at your ear
    for (let q = 0; q < n; q++) s[q] = 0.8 * Math.tanh(s[q] * 1.25)
    this.room.run(s, n, this.wet, 1 - 0.6 * this.wet)
    this.wallF.run(s, n)
    const mk = this.makeup
    for (let q = 0; q < n; q++) s[q] *= mk
  }

  reset() {
    this.comp.reset()
    this.spk.reset()
    this.room.reset()
    this.wallF.reset()
  }
}

export default makeDevice({
  id: 'device.tv',
  name: 'TV in the next room',
  about: 'Your voice on a television somewhere else in the house: through an open door, a closed door, or the wall.',
  params: [
    {
      id: 'era', name: 'Television', type: 'choice', def: '1980s',
      options: [
        { v: '1950s', name: '1950s valve set' },
        { v: '1980s', name: '1980s console' },
        { v: 'flat', name: 'Modern flat screen' },
      ],
    },
    {
      id: 'wall', name: 'Where you are', type: 'choice', def: 'open',
      options: [
        { v: 'same', name: 'In the same room' },
        { v: 'open', name: 'Through an open door' },
        { v: 'closed', name: 'Through a closed door' },
        { v: 'wall', name: 'Through the wall' },
      ],
    },
    { id: 'hum', name: 'Hum', type: 'number', min: 0, max: 100, step: 1, def: 25, unit: 'percent', rand: [0, 50] },
    { id: 'whine', name: 'Picture tube whine', type: 'number', min: 0, max: 100, step: 1, def: 15, unit: 'percent', rand: [0, 40] },
    { id: 'room', name: 'Room size', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
  ],
  cost: 2,
  tail: () => 1.0,
  talk: null,
  latency: () => 0,
  build: (sr, p, rng) => new TVCore(sr, p, rng),
})
