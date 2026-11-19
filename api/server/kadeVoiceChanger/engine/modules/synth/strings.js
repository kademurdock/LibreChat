// modules/synth/strings.js - sympathetic strings (synth.strings).
//
// Technique: the Karplus-Strong plucked string (Karplus and Strong,
// "Digital synthesis of plucked-string and drum timbres", Computer Music
// Journal 7(2), 1983) with the extensions of Jaffe and Smith ("Extensions of
// the Karplus-Strong plucked-string algorithm", CMJ 7(2), 1983): a delay
// loop one period long, a two-point lowpass in the loop
//     H(z) = (1 - S) + S z^-1
// whose weight S sets how fast the upper harmonics die (S = 0.5 is the
// classic dark string, smaller S is brighter and more metallic), a loss
// gain per pass set from the wanted 60 dB ring time, and a first-order
// allpass for the fraction of a sample the integer delay cannot give,
//     A(z) = (c + z^-1) / (1 + c z^-1),
// so every string is in tune at any sample rate. The allpass coefficient
// is solved exactly for the fundamental, c = sin((1 - d) w / 2) /
// sin((1 + d) w / 2), with the lowpass's own phase delay at w taken off
// the loop length first, and the fractional part kept in 0.618..1.618
// samples where the allpass behaves best (Valimaki, Huopaniemi, Karjalainen
// and Janosy, "Physical modeling of plucked string instruments with
// application to real-time sound synthesis", JAES 44(5), 1996).
//
// Six strings tuned to a chord are excited two ways:
// - sympathetically: the voice flows into every loop, so the strings ring
//   with whatever notes of the voice match them, like singing into a piano
//   with the sustain pedal down or past the drone strings of a sitar;
// - plucked: syllable onsets (a fast and a slow envelope follower, with a
//   re-arm so one word gives one pluck) strum the chord, string by string
//   10 ms apart, alternating down and up strokes. Each pluck is a burst of
//   noise one period long, lowpassed by "pluck brightness" (a soft finger or
//   a bright pick), the classic Karplus-Strong excitation.
// Bridge buzz imitates the flat curved bridge of a sitar or tanpura, where
// the string grazes the bridge and buzzes. In the spirit of the
// displacement-dependent string-length models of the sitar (Siddiq, "A
// physical model of the nonlinear sitar string", Archives of Acoustics
// 37(1), 2012; and the nonlinear strings surveyed by Valimaki, Pakarinen,
// Erkut and Karjalainen, "Discrete-time modelling of musical instruments",
// Reports on Progress in Physics 69, 2006), the string gets shorter while it
// presses past the bridge line: the loop is read up to 20 percent of a
// period earlier (cubic Hermite, Niemitalo 2001) in proportion to how far
// it reaches, which folds energy from the low harmonics into a bright,
// buzzing top that is strongest on loud notes and fades as they die. The
// contact itself (how far past the line the string goes), high passed at
// 1.2 kHz, is mixed in as the bridge's rattle. An in-loop 5 Hz DC blocker
// (its phase lead included in the tuning) keeps the string centred on its
// rest line. A length that moves in step with the
// string's own motion can pump energy into it (parametric gain), so a
// buzzing string also carries an energy ceiling: the energy put in (voice
// and plucks) decaying exactly as fast as the designed string loses it;
// a sample that would push the string's power past 30 times that ceiling's
// average is scaled back to it. A healthy string never touches the ceiling;
// a pumping one cannot run away and dies away at the designed rate.
//
// The ring after the take: the output is the take plus the strings' tail
// (the ring time plus a tenth of a second for the last strum), so the chord
// rings out instead of being cut off. Plain strings fall 60 dB in the ring
// time by design. A buzzing string does not: the eased loop and the bridge
// trade energy, and measured on speech and synthetic voices it rang on for
// up to 2.5 times the ring time at moderate buzz. So once the take is over
// (a tenth of a second after its end, when the last strum has landed) a
// buzzing string also has a ring-time governor: its own smoothed power may
// not rise more than 3 dB above an envelope that starts at its level then
// and falls 60 dB in the ring time. Above it, the loop gain is lowered by
// 0.5 (1 - envelope / power), at most 6 dB per trip round the loop and
// nothing once the string is back under the envelope; the power follower
// moves smoothly, so this is an extra damping and not a clip. Inside the
// take nothing changes. Measured on two speech takes and two synthetic
// voices, every chord, pluck and buzz setting then falls 60 dB within 1.06
// ring times (plus the tenth of a second), so the tail is 1.1 ring times
// plus 0.15 s, and its last tenth (at most half a second) has a
// raised-cosine fade so the take never ends on a step. At full buzz with a
// long ring time the bridge may drain the string sooner; the rest of the
// tail is then quiet.
//
// Level: the strings are matched in RMS to the voice over the take
// and mixed with equal power. A 20 Hz DC blocker follows the strings (the
// buzz is one-sided).

import { bufLen, fade } from '../../core/buf.js'
import { makeRng } from '../../core/rng.js'

const TWO_PI = 2 * Math.PI
const LN1000 = Math.log(1000)
const TAIL_MAX = 15

/** Seconds the strings ring on after the take (the module's tail). */
function ringTail(p) {
  let d = Number(p && p.decay)
  if (!(d > 0)) d = 3
  if (d < 0.2) d = 0.2
  // plain and buzzing strings both obey the ring time (the governor);
  // measured, the last string falls 60 dB within 1.06 ring times plus 0.1 s
  return Math.min(TAIL_MAX, 1.1 * d + 0.15)
}

const CHORDS = {
  major: [0, 4, 7, 12, 16, 19],
  minor: [0, 3, 7, 12, 15, 19],
  fifths: [0, 7, 12, 19, 24, 31],
  sus: [0, 5, 7, 12, 17, 19],
  seventh: [0, 4, 7, 10, 12, 16],
  minor7: [0, 3, 7, 10, 12, 15],
  octaves: [0, 0.08, 12, 12.06, 24, 36],
  drone: [-12, 0, 7, 12, 19, 24],
  wholetone: [0, 2, 4, 6, 8, 10],
  cluster: [0, 1, 6, 11, 12, 13],
}
const STRING_AMP = [1, 0.85, 0.85, 0.75, 0.7, 0.65]

const KEYS = [
  ['C', 'C'], ['C#', 'C sharp'], ['D', 'D'], ['Eb', 'E flat'], ['E', 'E'], ['F', 'F'],
  ['F#', 'F sharp'], ['G', 'G'], ['Ab', 'A flat'], ['A', 'A'], ['Bb', 'B flat'], ['B', 'B'],
]
const KEY_PC = {}
KEYS.forEach(([v], i) => (KEY_PC[v] = i))
const REGISTER_OCT = { low: 2, middle: 3, high: 4 }

/** Frequencies (Hz) of the six strings for the params. */
export function stringFreqs(p) {
  const chord = CHORDS[p.chord] || CHORDS.major
  const pc = KEY_PC[p.key] !== undefined ? KEY_PC[p.key] : 0
  const oct = REGISTER_OCT[p.register] !== undefined ? REGISTER_OCT[p.register] : 3
  const root = 12 * (oct + 1) + pc
  return chord.map((s) => {
    let f = 440 * Math.pow(2, (root + s - 69) / 12)
    while (f < 40) f *= 2
    return f
  })
}

/**
 * Loop design for one string: integer delay, allpass coefficient, lowpass
 * weight, loss. hpR > 0 adds an in-loop DC blocker (1 - z^-1)/(1 - R z^-1),
 * whose phase lead and loss at the fundamental are taken into account.
 */
function designString(f, sr, S, t60, hpR = 0) {
  const L = sr / f
  const w = (TWO_PI * f) / sr
  const pd1 = Math.atan2(S * Math.sin(w), 1 - S + S * Math.cos(w)) / w
  let pdH = 0
  let magH = 1
  if (hpR > 0) {
    const ang = (Math.PI - w) / 2 - Math.atan2(hpR * Math.sin(w), 1 - hpR * Math.cos(w))
    pdH = -ang / w
    const num = Math.sqrt(2 - 2 * Math.cos(w))
    const den = Math.sqrt(1 + hpR * hpR - 2 * hpR * Math.cos(w))
    magH = num / den
  }
  let N = Math.floor(L - pd1 - pdH - 0.618)
  if (N < 2) N = 2
  let d = L - pd1 - pdH - N
  if (d < 0.05) d = 0.05
  const c = Math.sin(((1 - d) * w) / 2) / Math.sin(((1 + d) * w) / 2)
  const mag = Math.sqrt((1 - S) * (1 - S) + S * S + 2 * S * (1 - S) * Math.cos(w)) * magH
  let g = Math.exp(-LN1000 / (f * t60)) / mag
  if (g > 0.99999) g = 0.99999
  return { N, c: Math.max(-0.999, Math.min(0.999, c)), S, g }
}

/** Syllable onsets: [{ i, a }] with a the level at the onset. */
function findPlucks(x, sr) {
  const n = x.length
  const out = []
  const cFa = Math.exp(-1 / (0.001 * sr))
  const cFr = Math.exp(-1 / (0.025 * sr))
  const cSa = Math.exp(-1 / (0.06 * sr))
  const cSr = Math.exp(-1 / (0.2 * sr))
  let eF = 0
  let eS = 0
  let peakF = 0
  const fast = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let v = x[i]
    if (!(v > -1e9 && v < 1e9)) v = 0
    const av = v < 0 ? -v : v
    eF = av + (av > eF ? cFa : cFr) * (eF - av)
    fast[i] = eF
    if (eF > peakF) peakF = eF
  }
  const floor = peakF * 0.06
  const cool = Math.round(0.11 * sr)
  let armed = true
  let last = -cool
  for (let i = 0; i < n; i++) {
    let v = x[i]
    if (!(v > -1e9 && v < 1e9)) v = 0
    const av = v < 0 ? -v : v
    eS = av + (av > eS ? cSa : cSr) * (eS - av)
    const f = fast[i]
    const ratio = f / (eS + 1e-6)
    if (armed && ratio > 1.8 && f > floor && i - last >= cool) {
      // strength: the highest fast level over the next 20 ms
      let a = f
      const end = Math.min(n, i + Math.round(0.02 * sr))
      for (let k = i; k < end; k++) if (fast[k] > a) a = fast[k]
      out.push({ i, a })
      last = i
      armed = false
    } else if (!armed && ratio < 1.2) armed = true
  }
  return out
}

/**
 * The six strings over x (the take) and on into the tail: returns `total`
 * samples (total >= x.length; the voice is silent after x ends).
 */
export function ringStrings(x, sr, p, rng, total = x.length) {
  const n = x.length
  if (!(total >= n)) total = n
  const freqs = stringFreqs(p)
  const ns = freqs.length
  const bright = Math.min(1, Math.max(0, (Number(p.brightness) || 0) / 100))
  const t60 = Math.max(0.1, Number(p.decay) || 3)
  const pluck = Math.min(1, Math.max(0, (Number(p.pluck) || 0) / 100))
  const buzz = Math.min(1, Math.max(0, (Number(p.buzz) || 0) / 100))
  // a buzzing string is a bright steel one: less loop damping
  const S = (0.5 - 0.32 * bright) * (1 - 0.8 * buzz)
  const cont = 1 - 0.75 * pluck
  const fc = Math.min(0.45 * sr, 300 * Math.pow(2, bright * 5.5))
  const kN = 1 - Math.exp((-TWO_PI * fc) / sr)
  const nGain = Math.sqrt((2 - kN) / kN) * Math.sqrt(3) * 0.5
  const plucks = pluck > 0 ? findPlucks(x, sr) : []
  const strum = Math.round(0.01 * sr)
  const wet = new Float64Array(total)
  // ring-time governor for buzzing strings, after the take (see the header)
  const gov = buzz > 0
  const gStart = n + Math.round(0.1 * sr)
  const gsK = Math.exp((-2 * LN1000) / (t60 * sr))
  // the bridge line sits at thr times the string's recent peak (1.4 times a
  // power follower, 10 ms attack and 200 ms release); a buzzing string is
  // made brighter (less loop damping) and its loss is eased (ring time times
  // 1 + 3 buzz) because the bridge itself pours energy into the high
  // harmonics, which die faster; it keeps about 20 dB more top end. On its
  // own it can then ring up to 2.5 times too long, which the governor
  // above trims after the take
  const thr = 1 - 0.8 * buzz
  const msRel = Math.exp(-1 / (0.2 * sr))
  const kAtt = 1 - Math.exp(-1 / (0.01 * sr))
  const bz = 0.5 * buzz
  const bR = Math.exp((-TWO_PI * Math.min(1200, 0.2 * sr)) / sr)
  const hpR = buzz > 0 ? Math.exp((-TWO_PI * 5) / sr) : 0
  for (let s = 0; s < ns; s++) {
    const f = freqs[s]
    if (!(f < 0.45 * sr)) continue
    const { N, c, g } = designString(f, sr, S, t60 * (1 + 3 * buzz), hpR)
    let size = 4
    while (size < N + 4) size <<= 1
    const mask = size - 1
    const buf = new Float32Array(size)
    const inGain = Math.sqrt(Math.max(0, 1 - g * g)) * cont
    const amp = STRING_AMP[s] / Math.sqrt(ns)
    const L = Math.max(2, Math.round(sr / f))
    const nr = rng.fork('string' + s)
    // this string's pluck schedule (strummed, alternating direction)
    const starts = []
    for (let e = 0; e < plucks.length; e++) {
      const k = e % 2 === 0 ? s : ns - 1 - s
      starts.push(plucks[e].i + k * strum, plucks[e].a)
    }
    let ev = 0
    let left = 0
    let pAmp = 0
    let lpN = 0
    let w = 0
    let vPrev = 0
    let apX = 0
    let apY = 0
    let ms = 0
    let bx = 0
    let by = 0
    let rattle = 0
    let yPrev = 0
    let hx = 0
    let hy = 0
    const maxShift = Math.min(buzz * 0.2 * N, N - 2)
    // energy ceiling for the buzzing string (see the header): what was put
    // in, decaying exactly as fast as the designed string would lose it
    const Lf = sr / f
    const gs = Math.pow(g, 2 / Lf)
    let Ea = 0
    // governor state: smoothed power over about two periods, its envelope
    const kP = 1 - Math.exp(-1 / (Math.max(0.01, 2 / f) * sr))
    let ps = 0
    let psMax = 0
    let glim = 0
    for (let i = 0; i < total; i++) {
      let v
      if (buzz > 0) {
        // the bridge shortens the string while it presses against it
        const pk = 1.4 * Math.sqrt(ms)
        const T = thr * pk
        let press = (-yPrev - T) / ((1 - thr) * pk + 1e-12)
        if (press < 0) press = 0
        if (press > 1) press = 1
        const D = N - maxShift * press
        const Di = D | 0
        const fr = D - Di
        // cubic Hermite read (Niemitalo 2001): far less high loss than linear
        const ym1 = buf[(w - Di + 1) & mask]
        const y0 = buf[(w - Di) & mask]
        const y1 = buf[(w - Di - 1) & mask]
        const y2 = buf[(w - Di - 2) & mask]
        const c1 = 0.5 * (y1 - ym1)
        const c2 = ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2
        const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1)
        v = ((c3 * fr + c2) * fr + c1) * fr + y0
      } else v = buf[(w - N) & mask]
      const lp = (1 - S) * v + S * vPrev
      vPrev = v
      let ap = c * lp + apX - c * apY
      if (ap < 1e-20 && ap > -1e-20) ap = 0
      apX = lp
      apY = ap
      let y = ap * g
      if (buzz > 0) {
        // in-loop DC blocker: the string stays centred on its rest line, so
        // the one-sided bridge cannot simply push it off to one side
        let h = y - hx + hpR * hy
        if (h < 1e-20 && h > -1e-20) h = 0
        hx = y
        hy = h
        y = h
        // contact: how far the string reaches past the bridge line
        const T = thr * 1.4 * Math.sqrt(ms)
        const cs = y < -T ? -y - T : 0
        // the rattle itself: the contact pulses, high passed, are heard too
        const hb = cs - bx + bR * by
        bx = cs
        by = hb < 1e-20 && hb > -1e-20 ? 0 : hb
        rattle = by
        const y2 = y * y
        ms = y2 > ms ? ms + (y2 - ms) * kAtt : ms * msRel
        if (ms < 1e-30) ms = 0
        yPrev = y
      }
      let pin = 0
      while (ev < starts.length && starts[ev] <= i) {
        left = L
        pAmp = 3.5 * pluck * starts[ev + 1]
        ev += 2
      }
      if (left > 0) {
        lpN += (nr.next() * 2 - 1 - lpN) * kN
        pin = lpN * nGain * pAmp
        left--
      }
      let xi = i < n ? x[i] : 0
      if (!(xi > -1e9 && xi < 1e9)) xi = 0
      const inj = xi * inGain + pin
      if (buzz > 0) {
        Ea = Ea * gs + inj * inj
        if (Ea < 1e-30) Ea = 0
        const lim2 = (30 * Ea) / Lf + 1e-24
        if (y * y > lim2) {
          y *= Math.sqrt(lim2 / (y * y))
          yPrev = y
        }
      }
      if (gov && i >= n) {
        ps += (y * y - ps) * kP
        if (ps < 1e-30) ps = 0
        if (i < gStart) {
          if (ps > psMax) psMax = ps
        } else {
          if (i === gStart) glim = 2 * (ps > psMax ? ps : psMax)
          else {
            glim *= gsK
            if (glim < 1e-36) glim = 0
          }
          if (ps > glim) {
            // each sample passes here once per trip, so this is per trip
            y *= 0.5 + 0.5 * (glim / ps)
            yPrev = y
          }
        }
      }
      buf[w] = y + inj
      w = (w + 1) & mask
      wet[i] += (y + bz * rattle) * amp
    }
  }
  // DC blocker on the strings (the buzz is one-sided)
  const out = new Float32Array(total)
  const R = Math.exp((-TWO_PI * 20) / sr)
  let x1 = 0
  let y1 = 0
  for (let i = 0; i < total; i++) {
    const v = wet[i]
    let y = v - x1 + R * y1
    if (y < 1e-20 && y > -1e-20) y = 0
    x1 = v
    y1 = y
    out[i] = y
  }
  return out
}

export default {
  id: 'synth.strings',
  name: 'Sympathetic strings',
  family: 'synth',
  about: 'Six tuned strings ring along with your voice, and every word plucks the chord: a harp, a piano with the pedal down, or a buzzing sitar.',
  params: [
    {
      id: 'chord',
      name: 'Chord',
      type: 'choice',
      def: 'major',
      options: [
        { v: 'major', name: 'Major' },
        { v: 'minor', name: 'Minor' },
        { v: 'fifths', name: 'Open fifths' },
        { v: 'sus', name: 'Suspended' },
        { v: 'seventh', name: 'Seventh' },
        { v: 'minor7', name: 'Minor seventh' },
        { v: 'octaves', name: 'Octaves' },
        { v: 'drone', name: 'Drone' },
        { v: 'wholetone', name: 'Whole tone' },
        { v: 'cluster', name: 'Spooky cluster' },
      ],
    },
    { id: 'key', name: 'Key', type: 'choice', def: 'C', options: KEYS.map(([v, name]) => ({ v, name })) },
    {
      id: 'register',
      name: 'Register',
      type: 'choice',
      def: 'middle',
      options: [
        { v: 'low', name: 'Low' },
        { v: 'middle', name: 'Middle' },
        { v: 'high', name: 'High' },
      ],
    },
    { id: 'decay', name: 'Ring time', type: 'number', min: 0.2, max: 12, step: 0.1, def: 3, unit: 'seconds', rand: [1, 6] },
    { id: 'brightness', name: 'Pluck brightness', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [25, 85] },
    { id: 'pluck', name: 'Pluck on words', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [20, 90] },
    { id: 'buzz', name: 'Bridge buzz', type: 'number', min: 0, max: 100, step: 1, def: 0, unit: 'percent', rand: [0, 50] },
    { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [35, 70] },
  ],
  stereo: 'keep',
  tail: (p) => ringTail(p),
  warps: false,
  cost: 2,
  process(input, p, ctx) {
    const n = bufLen(input)
    if (!n) return input
    const sr = input.sr || (ctx && ctx.sr) || 48000
    const base = ctx && ctx.rng ? ctx.rng : makeRng('synth.strings')
    const nch = input.ch.length
    const tailSec = ringTail(p)
    const total = n + Math.round(tailSec * sr)
    const wets = new Array(nch)
    let ed = 0
    let ew = 0
    for (let c = 0; c < nch; c++) {
      const x = input.ch[c]
      const w = ringStrings(x, sr, p, base.fork('ch' + c), total)
      // level is matched over the take itself, so the tail cannot change it
      for (let i = 0; i < n; i++) {
        const v = x[i]
        if (v > -1e9 && v < 1e9) ed += v * v
        ew += w[i] * w[i]
      }
      wets[c] = w
      if (ctx && typeof ctx.progress === 'function') ctx.progress((c + 1) / nch)
    }
    let g = ew > 1e-20 && ed > 1e-20 ? Math.sqrt(ed / ew) : 1
    if (g > 300) g = 300
    if (g < 0.01) g = 0.01
    const m = Math.min(1, Math.max(0, p.mix / 100))
    const gd = Math.cos((m * Math.PI) / 2)
    const gw = Math.sin((m * Math.PI) / 2) * g
    const outCh = new Array(nch)
    for (let c = 0; c < nch; c++) {
      const x = input.ch[c]
      const w = wets[c]
      for (let i = 0; i < n; i++) {
        let v = x[i]
        if (!(v > -1e9 && v < 1e9)) v = 0
        w[i] = gd * v + gw * w[i]
      }
      for (let i = n; i < total; i++) w[i] *= gw
      outCh[c] = w
    }
    const out = { sr, ch: outCh }
    // a short fade on the very end of the ring (60 dB down by then)
    fade(out, 0, Math.min(0.5, 0.1 * tailSec))
    return out
  },
}
