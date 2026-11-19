// modules/device/scanner.js - device.scanner, Police scanner.
//
// Dispatch traffic heard on a desktop scanner:
// - analog: narrowband FM squeezed through heavy limiting, a little
//   carrier hiss and picket-fence flutter under the voice, the squelch
//   opening with a tiny burst and closing with the short bright "tshk" of
//   a squelch tail at the end of every transmission;
// - digital: the robotic, watery sound of a low-rate trunked-radio voice
//   coder (kit SpecCodec at 8 kHz with heavy envelope quantisation, holes
//   and noisy highs), with bad-frame warble as errors climb, and no hiss or
//   tail at all;
// - data chirps: the short frequency-shift-keyed identifier burst many
//   radios send when the talk button goes down (1200 baud between 1200 Hz
//   and 1800 Hz, the Bell 202 tones used by common signalling formats);
// - the scanner's own small, harsh speaker.
// Transmissions are phrases joined across short pauses (core/segment.js
// offline, the kit talk gate live).

import { makeDevice, Bank, butter, Rand, Squash, SpecCodec, RateHold, Swell, Edges, Tone, Burst, BLOCK, SPEECH, taper, frac, db, codecSize, onePoleCoef } from './_kit.js'

class ScannerCore {
  constructor(sr, p, rng) {
    this.sr = sr
    this.r = new Rand(rng, 'scan-noise')
    this.mic = new Bank(sr, 6)
    this.spk = new Bank(sr, 6)
    this.hissF = new Bank(sr, 1)
    this.lim = new Squash(sr)
    this.codec = new SpecCodec(sr, new Rand(rng, 'scan-codec'))
    this.hold = new RateHold(sr)
    this.fence = new Swell(sr, new Rand(rng, 'scan-fence'))
    this.edges = new Edges()
    this.chirp = new Tone(sr, new Rand(rng, 'scan-chirp'))
    this.openB = new Burst(sr, new Rand(rng, 'scan-open')).color(800, 6000)
    this.tailB = new Burst(sr, new Rand(rng, 'scan-tail')).color(1200, 8000)
    this.tmp = new Float32Array(BLOCK)
    this.ev = new Float32Array(BLOCK)
    this.open = 0
    this.target = 0
    this.closeAt = -1
    this.latency = codecSize(sr)
    this.set(p)
  }

  set(p) {
    this.digital = p.mode === 'digital'
    const h = frac(p.harsh)
    const w = frac(p.warble)
    const mic = this.mic.allOff()
    let j = butter(mic, 0, 'hp', 350, 4)
    butter(mic, j, 'lp', 3100, 8)
    const spk = this.spk.allOff()
    j = butter(spk, 0, 'hp', 450, 4)
    j = butter(spk, j, 'lp', 3300, 2)
    spk.f[j++].peak(2000, 1.5, 4 + 3 * h)
    spk.f[j++].peak(900, 2, 2)
    this.lim.set(-32, 8, 1, 60, 10 + 3 * h, 6)
    this.drive = 1.2 + 5 * h
    this.hissF.allOff()
    this.hissF.f[0].hp(1000, 0.7071)
    this.hissLvl = this.digital ? 0 : taper(p.noise, -16)
    this.fence.set(this.digital ? 0 : 9 * w * w, 3, 8, 14, 0.8, 0.4)
    if (this.digital) {
      this.hold.set(8000, 2, 13, 1)
      this.codec.set(true, 3300, 0.75, 0.25 + 0.15 * w, 1500, 0.25, 18 * w * w, 0.5, 0.45)
    } else {
      this.hold.set(this.sr, 0, 16, 1)
      this.codec.set(false, 3400, 0, 0, 0, 0, 0, 0)
    }
    this.tail = frac(p.tail)
    this.chirps = !!p.chirps
    this.makeup = db(5)
  }

  onRise(i) {
    this.target = 1
    this.closeAt = -1
    this.tailB.stop()
    if (!this.digital) this.openB.trigger(i, 1, 8, 10, SPEECH * 1.4 * (0.3 + this.tail), 0.4)
    if (this.chirps) this.chirp.clear().add(1200, 1800, 170, SPEECH * 1.6, 3).start(i + Math.round(0.01 * this.sr))
  }

  onFall(i) {
    if (!this.digital && this.tail > 0) {
      const t = 50 + 90 * this.tail
      this.tailB.trigger(i, 1, t, 4, SPEECH * 3 * this.tail, 0.5)
      this.closeAt = i + Math.round(((t + 6) * this.sr) / 1000)
    } else this.closeAt = i + Math.round(0.02 * this.sr)
  }

  run(s, n, talk) {
    const r = this.r
    const tmp = this.tmp
    const ev = this.ev
    ev.fill(0, 0, n)
    if (talk) this.edges.scan(talk, n, this)
    else this.target = 1
    this.mic.run(s, n)
    this.lim.run(s, n)
    const d = this.drive
    for (let q = 0; q < n; q++) s[q] = Math.tanh(s[q] * d) / d
    this.chirp.render(s, n)
    this.hold.run(s, n)
    this.codec.run(s, n)
    if (this.hissLvl > 0) {
      r.fill(tmp, n)
      this.hissF.run(tmp, n)
      const g = this.hissLvl * 2
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
      this.fence.render(tmp, n)
      for (let q = 0; q < n; q++) {
        const e = tmp[q]
        if (e > 0) s[q] = s[q] * (1 - 0.8 * e) + r.w() * e * SPEECH
      }
    }
    // squelch gate
    let o = this.open
    let tg = this.target
    let ca = this.closeAt
    const ku = onePoleCoef(500, this.sr)
    const kd = onePoleCoef(400, this.sr)
    for (let q = 0; q < n; q++) {
      if (ca >= 0) {
        if (ca === 0) {
          tg = 0
          ca = -1
        } else ca--
      }
      o += (tg - o) * (tg > o ? ku : kd)
      s[q] *= o
    }
    this.open = o < 1e-6 ? 0 : o
    this.target = tg
    this.closeAt = ca
    this.openB.render(ev, n)
    this.tailB.render(ev, n)
    for (let q = 0; q < n; q++) s[q] += ev[q]
    const mk = this.makeup / 0.7
    for (let q = 0; q < n; q++) s[q] = 0.7 * Math.tanh(s[q] * mk)
    this.spk.run(s, n)
  }

  reset() {
    this.mic.reset()
    this.spk.reset()
    this.hissF.reset()
    this.lim.reset()
    this.codec.reset()
    this.hold.reset()
    this.fence.reset()
    this.edges.reset()
    this.chirp.stop()
    this.openB.stop()
    this.tailB.stop()
    this.open = 0
    this.target = 0
    this.closeAt = -1
  }
}

export default makeDevice({
  id: 'device.scanner',
  name: 'Police scanner',
  about: 'Dispatch chatter on a scanner: squeezed and harsh, with squelch tails, data chirps, or the robotic warble of digital radio.',
  params: [
    {
      id: 'mode', name: 'Radio system', type: 'choice', def: 'analog',
      options: [
        { v: 'analog', name: 'Analog radio' },
        { v: 'digital', name: 'Digital radio' },
      ],
    },
    { id: 'tail', name: 'Squelch tail', type: 'number', min: 0, max: 100, step: 1, def: 70, unit: 'percent', rand: [30, 100] },
    { id: 'warble', name: 'Warble', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [10, 70] },
    { id: 'chirps', name: 'Data chirps', type: 'bool', def: true },
    { id: 'noise', name: 'Static', type: 'number', min: 0, max: 100, step: 1, def: 30, unit: 'percent', rand: [10, 60] },
    { id: 'harsh', name: 'Harshness', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 80] },
  ],
  cost: 2,
  tail: () => 0.4,
  talk: { gapMs: 650, leadMs: 220, holdMs: 500 },
  latency: (sr) => codecSize(sr),
  build: (sr, p, rng) => new ScannerCore(sr, p, rng),
})
