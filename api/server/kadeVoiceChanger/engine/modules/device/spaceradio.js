// modules/device/spaceradio.js - device.spaceradio, Space radio.
//
// Mission audio between the ground and a spacecraft:
// - the beep tones: a 250 ms tone of 2525 Hz when a transmission starts
//   and 2475 Hz when it ends, the in-band signalling tones that keyed the
//   distant transmitters during the crewed lunar flights (the "intro" and
//   "outro" tones of that era's ground network, as documented in NASA's
//   mission communications histories). Offline, the intro tone sits just
//   before each phrase when the pause allows; live it rides the first word;
// - the link: a headset microphone, speech-band limiting, compression,
//   hiss, and brief signal dropouts; low orbit is clean, from the moon is
//   narrower and noisier, a deep space probe is thin, faint and fragile;
// - the echo: on lunar calls the ground often heard its own voice come
//   back about 2.6 seconds later, after the round trip to the moon (here as
//   an optional faint, band-limited echo; orbit and deep space use 0.35 s
//   and 4 s).

import { makeDevice, Bank, butter, Bq, Rand, Crackler, Squash, Swell, Edges, Tone, BLOCK, SPEECH, taper, frac, db } from './_kit.js'
import { DelayLine } from '../../core/delay.js'

const BANDS = ['orbit', 'moon', 'deep']
const ECHO_S = [0.35, 2.6, 4.0]

class SpaceCore {
  constructor(sr, p, rng) {
    this.sr = sr
    this.r = new Rand(rng, 'space-noise')
    this.mic = new Bank(sr, 7)
    this.comp = new Squash(sr)
    this.hissF = new Bank(sr, 2)
    this.toneF = new Bq(sr).lp(4500, 0.7071)
    this.crk = new Crackler(sr, new Rand(rng, 'space-crackle'))
    this.drop = new Swell(sr, new Rand(rng, 'space-drop'))
    this.edges = new Edges()
    this.intro = new Tone(sr, new Rand(rng, 'space-intro'))
    this.outro = new Tone(sr, new Rand(rng, 'space-outro'))
    this.echo = new DelayLine(Math.ceil(4.1 * sr) + 8)
    this.echoF = new Bank(sr, 3)
    this.tmp = new Float32Array(BLOCK)
    this.ev = new Float32Array(BLOCK)
    this.latency = 0
    this.set(p)
  }

  set(p) {
    let band = BANDS.indexOf(p.band)
    if (band < 0) band = 1
    this.band = band
    const mic = this.mic.allOff()
    let j
    if (band === 0) {
      j = butter(mic, 0, 'hp', 300, 4)
      j = butter(mic, j, 'lp', 3200, 6)
    } else if (band === 1) {
      j = butter(mic, 0, 'hp', 320, 4)
      j = butter(mic, j, 'lp', 2900, 6)
    } else {
      j = butter(mic, 0, 'hp', 420, 4)
      j = butter(mic, j, 'lp', 2400, 6)
    }
    mic.f[j++].peak(1500, 1.5, 3)
    this.comp.set(-28, band === 2 ? 8 : 4, 2, 120, band === 2 ? 9 : 6, 6)
    this.drive = band === 0 ? 1.2 : band === 1 ? 2 : 2.6
    this.hissF.allOff()
    this.hissF.f[0].lp(band === 2 ? 4000 : 6000, 0.7071)
    this.hissF.f[1].hp(300, 0.7071)
    const hm = band === 0 ? -22 : band === 1 ? -16 : -11
    this.hissLvl = taper(p.hiss, hm)
    this.crk.set(band === 0 ? 2 : band === 1 ? 8 : 20, 0, 0.03, 0.4, 0.7)
    this.crkLvl = this.hissLvl * 3
    const dr = frac(p.dropouts)
    this.drop.set(dr * (band === 2 ? 1.2 : 0.5), 6, 120, 60, 0.7, 0.6)
    this.beeps = p.beeps
    this.beepAmp = SPEECH * db(p.beepLevel) * 1.41
    this.echoS = ECHO_S[band]
    this.echoLvl = taper(p.echo, -4, 14)
    this.echoF.allOff()
    j = butter(this.echoF, 0, 'hp', 400, 2)
    butter(this.echoF, j, 'lp', 2400, 4)
    this.voiceG = band === 2 ? db(-3) : 1
    this.makeup = db(4)
  }

  onRise(i) {
    if (this.beeps === 'both' || this.beeps === 'start') {
      this.intro.clear().add(2525, 2525, 250, this.beepAmp, 0).start(i)
    }
  }

  onFall(i) {
    if (this.beeps === 'both' || this.beeps === 'end') {
      this.outro.clear().add(2475, 2475, 250, this.beepAmp, 0).start(i + Math.round(0.03 * this.sr))
    }
  }

  run(s, n, talk) {
    const r = this.r
    const tmp = this.tmp
    const ev = this.ev
    if (talk) this.edges.scan(talk, n, this)
    this.mic.run(s, n)
    this.comp.run(s, n)
    const d = this.drive
    const vg = this.voiceG
    for (let q = 0; q < n; q++) s[q] = (Math.tanh(s[q] * d) / d) * vg
    // the far echo of the voice
    if (this.echoLvl > 0) {
      const D = this.echoS * this.sr
      for (let q = 0; q < n; q++) {
        this.echo.write(s[q])
        tmp[q] = this.echo.read(D)
      }
      this.echoF.run(tmp, n)
      const g = this.echoLvl * 10
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
    }
    // dropouts
    this.drop.render(ev, n)
    r.fill(tmp, n)
    this.hissF.run(tmp, n)
    const hl = this.hissLvl * 3.2
    for (let q = 0; q < n; q++) {
      const e = ev[q]
      s[q] = s[q] * (1 - 0.95 * e) + tmp[q] * hl * (1 + 2.5 * e)
    }
    if (this.crkLvl > 0) {
      this.crk.render(tmp, n)
      const g = this.crkLvl
      for (let q = 0; q < n; q++) s[q] += tmp[q] * g
    }
    // the tones, crisp on top of the link
    ev.fill(0, 0, n)
    this.intro.render(ev, n)
    this.outro.render(ev, n)
    this.toneF.run(ev, n)
    const mk = this.makeup
    for (let q = 0; q < n; q++) s[q] = (s[q] + ev[q]) * mk
  }

  reset() {
    this.mic.reset()
    this.comp.reset()
    this.hissF.reset()
    this.crk.reset()
    this.drop.reset()
    this.edges.reset()
    this.intro.stop()
    this.outro.stop()
    this.echo.clear()
    this.echoF.reset()
  }
}

export default makeDevice({
  id: 'device.spaceradio',
  name: 'Space radio',
  about: 'Mission control and the astronauts: a beep tone at the start and end of every transmission, hiss, and the long echo from the moon.',
  params: [
    {
      id: 'beeps', name: 'Beep tones', type: 'choice', def: 'both',
      options: [
        { v: 'both', name: 'At the start and the end' },
        { v: 'start', name: 'At the start' },
        { v: 'end', name: 'At the end' },
        { v: 'none', name: 'No beeps' },
      ],
    },
    { id: 'beepLevel', name: 'Beep volume', type: 'number', min: -30, max: 0, step: 1, def: -8, unit: 'db', rand: [-14, -4] },
    { id: 'hiss', name: 'Hiss', type: 'number', min: 0, max: 100, step: 1, def: 35, unit: 'percent', rand: [15, 65] },
    {
      id: 'band', name: 'Distance', type: 'choice', def: 'moon',
      options: [
        { v: 'orbit', name: 'Low orbit' },
        { v: 'moon', name: 'From the moon' },
        { v: 'deep', name: 'Deep space probe' },
      ],
    },
    { id: 'echo', name: 'Echo from space', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 40] },
    { id: 'dropouts', name: 'Dropouts', type: 'number', min: 0, max: 100, step: 1, def: 10, unit: 'percent', rand: [0, 40] },
  ],
  cost: 2,
  tail: (p) => (p && p.echo > 0 ? ECHO_S[Math.max(0, BANDS.indexOf(p.band))] + 0.5 : 0.45),
  talk: { gapMs: 500, leadMs: 300, holdMs: 400 },
  latency: () => 0,
  build: (sr, p, rng) => new SpaceCore(sr, p, rng),
})
