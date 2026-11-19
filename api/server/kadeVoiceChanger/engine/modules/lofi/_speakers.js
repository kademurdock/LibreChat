// modules/lofi/_speakers.js - small loudspeaker models (not a module).
//
// No default export; registry builders skip names that start with an
// underscore. Used by lofi.speaker and by lofi.console's "its own speaker".
//
// The model is the lumped-element view of a moving-coil driver from
// Thiele and Small (A. N. Thiele, "Loudspeakers in vented boxes", 1961; R. H.
// Small, "Closed-box loudspeaker systems", JAES 1972), reduced to what an
// ear notices:
// - Below its resonance a small driver in a small box falls away at 12 dB per
//   octave, with a bump at resonance whose height is set by the total Q
//   (a second-order high pass at the resonance with that Q). Very small
//   drivers also lose a little more below it (an extra first-order section).
// - Above a few kilohertz the cone stops moving as one piece ("break-up"):
//   peaks and dips (peaking filters), then the voice-coil inductance and the
//   cone's mass roll the top off (low pass).
// - Large-signal behaviour: the cone's excursion is roughly the low-frequency
//   part of the drive (a low pass at the resonance stands in for it). When it
//   grows, the suspension stiffens, so the excursion is soft-clipped; the
//   difference between the wanted and the clipped excursion is added to the
//   signal before the speaker's response, which is how a small speaker
//   turns bass it cannot play into a midrange growl.
// - Rattle: past an excursion threshold a loose part (a grille, a cracked
//   housing, the dust cap) slaps. Modelled as the excess excursion with a
//   little random roughness, band passed to the rattling part's ring.
// - Cheap amplifiers (toys, megaphones, horns) clip softly ahead of it all.
// Every size below is a set of those numbers, chosen to sound like the thing
// named; none is a measurement of a particular product.

import { tanhFast } from '../../core/shape.js'
import { makeRng } from '../../core/rng.js'
import { LBiquad, FilterBank, LP, HP, BP, PEAK, LP1, HP1, smoothCoef, dbg, clamp, num } from './_lib.js'

// f: response rows [type, Hz, Q, dB]; disp: excursion corner Hz; sat: how early the
// suspension stiffens; amp: amplifier clipping drive (0 = none); thr: rattle threshold;
// rf: rattle ring Hz; mk: make-up dB so speech comes out near its own loudness.
export const SPEAKERS = {
  earbud: { name: 'Earbud played out loud', f: [[HP, 900, 1.0, 0], [HP1, 600, 0, 0], [PEAK, 2800, 1.2, 6], [PEAK, 6000, 2.5, 4], [LP, 10000, 0.7, 0]], disp: 900, sat: 2.0, amp: 0, thr: 0.22, rf: 5200, mk: 2 },
  phone: { name: 'Phone speaker', f: [[HP, 550, 1.3, 0], [HP1, 350, 0, 0], [PEAK, 1200, 1.4, 3], [PEAK, 3400, 2, 6], [PEAK, 5800, 3, -5], [LP, 7500, 0.8, 0]], disp: 600, sat: 2.5, amp: 0, thr: 0.2, rf: 4200, mk: 0 },
  laptop: { name: 'Laptop speakers', f: [[HP, 320, 1.5, 0], [HP1, 200, 0, 0], [PEAK, 750, 2.5, 4], [PEAK, 2600, 2, 3], [PEAK, 7000, 2, -4], [LP, 12000, 0.7, 0]], disp: 350, sat: 1.8, amp: 0, thr: 0.25, rf: 3300, mk: -1 },
  toy: { name: 'Talking toy', f: [[HP, 700, 2.2, 0], [HP1, 450, 0, 0], [PEAK, 1700, 3, 8], [PEAK, 3300, 4, 7], [LP, 4300, 1.3, 0], [LP1, 5000, 0, 0]], disp: 750, sat: 4, amp: 2.5, thr: 0.12, rf: 2600, mk: 2 },
  radio: { name: 'Pocket radio', f: [[HP, 330, 1.7, 0], [PEAK, 1400, 1.2, 5], [PEAK, 2700, 2.5, 3], [LP, 4200, 0.9, 0], [LP1, 5000, 0, 0]], disp: 380, sat: 2.5, amp: 1.2, thr: 0.18, rf: 2900, mk: -1.5 },
  tv: { name: 'Old television', f: [[HP, 170, 1.2, 0], [PEAK, 420, 2, 3], [PEAK, 1900, 1.4, 3], [PEAK, 3600, 3, -3], [LP, 6500, 0.7, 0]], disp: 200, sat: 1.5, amp: 0, thr: 0.3, rf: 2400, mk: -2.5 },
  portable: { name: 'Little portable speaker', f: [[HP, 110, 2.4, 0], [PEAK, 3500, 2, 2], [LP, 15000, 0.7, 0]], disp: 130, sat: 2.0, amp: 0, thr: 0.35, rf: 3800, mk: -1 },
  handheld: { name: 'Handheld game', f: [[HP, 600, 1.6, 0], [HP1, 400, 0, 0], [PEAK, 1100, 2, 3], [PEAK, 2600, 2.5, 5], [LP, 6800, 0.9, 0]], disp: 650, sat: 2.8, amp: 0.8, thr: 0.18, rf: 3600, mk: 0 },
  cabinet: { name: 'Arcade cabinet', f: [[HP, 110, 1.0, 0], [PEAK, 300, 1.5, 2], [PEAK, 2200, 1.2, 3], [LP, 7500, 0.7, 0]], disp: 120, sat: 1.2, amp: 0.6, thr: 0.4, rf: 2000, mk: -1.5 },
  horn: { name: 'PA horn', f: [[HP, 480, 1.0, 0], [HP1, 350, 0, 0], [PEAK, 1100, 2, 5], [PEAK, 2400, 3, 6], [PEAK, 4600, 4, 4], [LP, 5800, 1.0, 0]], disp: 500, sat: 2, amp: 1.5, thr: 0.25, rf: 3000, mk: 1.5 },
  megaphone: { name: 'Megaphone', f: [[HP, 620, 1.5, 0], [HP1, 450, 0, 0], [PEAK, 1300, 2.5, 7], [PEAK, 2600, 3, 5], [LP, 3900, 1.3, 0]], disp: 650, sat: 3.5, amp: 3, thr: 0.15, rf: 2300, mk: 3 },
}

export const SPEAKER_OPTIONS = Object.keys(SPEAKERS).map((v) => ({ v, name: SPEAKERS[v].name }))

class SpeakerChan {
  constructor(sr, rng) {
    this.sr = sr
    this.rng = rng
    this.bank = new FilterBank(sr, 8)
    this.disp = new LBiquad(sr)
    this.rbp = new LBiquad(sr)
    this.rhp = new LBiquad(sr)
  }

  load(s) {
    this.bank.load(s.f)
    this.disp.set(LP, s.disp, 0.75, 0)
    this.rbp.set(BP, s.rf, 1.3, 0)
    this.rhp.set(HP1, 900, 0, 0)
  }

  reset() {
    this.bank.reset()
    this.disp.reset()
    this.rbp.reset()
    this.rhp.reset()
  }
}

/**
 * Streaming speaker. set({ size, push, rattle }) with push in dB (0..30) and
 * rattle in percent. Live-safe: no allocation after construction.
 */
export class SpeakerKernel {
  constructor(sr, p, rng) {
    this.sr = sr
    const r = rng || makeRng('lofi.speaker')
    this.chs = [new SpeakerChan(sr, r.fork('L')), new SpeakerChan(sr, r.fork('R'))]
    this.k = smoothCoef(20, sr)
    this.kFade = 1 / Math.max(1, Math.round(0.006 * sr))
    this.size = null
    this.pending = null
    this.fade = 1
    this.fadeDir = 0
    this.g = 1
    this.gT = 1
    this.rg = 0
    this.rgT = 0
    this.thrS = 0.2
    this.set(p || {}, true)
  }

  _apply(sizeKey) {
    const s = SPEAKERS[sizeKey] || SPEAKERS.phone
    this.size = sizeKey in SPEAKERS ? sizeKey : 'phone'
    this.s = s
    this.chs[0].load(s)
    this.chs[1].load(s)
    this.sat = s.sat
    this.amp = s.amp
    this.mk = dbg(s.mk)
  }

  set(p, immediate = false) {
    const size = p && p.size in SPEAKERS ? p.size : this.size || 'phone'
    const push = clamp(num(p && p.push, 6), 0, 40)
    const rattle = clamp(num(p && p.rattle, 20), 0, 100) / 100
    this.gT = dbg(push)
    this.rgT = 2.2 * rattle
    this.rattleAmt = rattle
    if (immediate || this.size === null) {
      this._apply(size)
      this.g = this.gT
      this.rg = this.rgT
      this.fade = 1
      this.fadeDir = 0
      this.pending = null
    } else if (size !== this.size) {
      this.pending = size
      this.fadeDir = -1
    }
  }

  reset() {
    this.chs[0].reset()
    this.chs[1].reset()
    this.g = this.gT
    this.rg = this.rgT
    if (this.pending) this._apply(this.pending)
    this.pending = null
    this.fade = 1
    this.fadeDir = 0
  }

  _tick(ch, x, g, rg, thr) {
    const s = this.sat
    const xin = x * g
    const d = ch.disp.tick(xin)
    const dk = d * s
    const v0 = xin + (tanhFast(dk) - dk) / s
    let v = ch.bank.tick(v0)
    if (this.amp > 0) v = tanhFast(v * this.amp) / this.amp
    let r = 0
    const ad = d < 0 ? -d : d
    if (ad > thr) {
      const ex = ad - thr
      const rough = 0.55 + 0.45 * (ch.rng.next() * 2 - 1)
      r = (d > 0 ? ex : -ex) * rough
    }
    r = ch.rhp.tick(ch.rbp.tick(r))
    return ((v + r * rg) * this.mk) / g
  }

  process(ins, outs, n) {
    const nOut = outs.length
    const a0 = ins[0]
    const a1 = ins.length > 1 ? ins[1] : ins[0]
    const o0 = outs[0]
    const o1 = nOut > 1 ? outs[1] : null
    const c0 = this.chs[0]
    const c1 = this.chs[1]
    const k = this.k
    const thrBase = this.s.thr * (1.5 - this.rattleAmt)
    for (let i = 0; i < n; i++) {
      const v0 = a0[i]
      const v1 = a1[i]
      // a host may hand over a stray NaN or Infinity: treat it as silence
      const x0 = v0 > -1e30 && v0 < 1e30 ? v0 : 0
      const x1 = v1 > -1e30 && v1 < 1e30 ? v1 : 0
      this.g += (this.gT - this.g) * k
      this.rg += (this.rgT - this.rg) * k
      if (this.fadeDir !== 0) {
        this.fade += this.fadeDir * this.kFade
        if (this.fade <= 0) {
          this.fade = 0
          if (this.pending) this._apply(this.pending)
          this.pending = null
          this.fadeDir = 1
        } else if (this.fade >= 1) {
          this.fade = 1
          this.fadeDir = 0
        }
      }
      const g = this.g
      const rg = this.rg
      const f = this.fade
      o0[i] = this._tick(c0, x0, g, rg, thrBase) * f
      if (o1) o1[i] = this._tick(c1, x1, g, rg, thrBase) * f
    }
    c0.bank.heal()
    c1.bank.heal()
  }
}
