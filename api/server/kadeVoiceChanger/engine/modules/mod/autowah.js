// modules/mod/autowah.js - Envelope filter: a wah that opens and closes with
// how loudly you speak.
//
// Technique: the envelope-controlled filter (Zolzer, "DAFX", 2nd ed. 2011,
// chapter 3 on filters and chapter 12 on adaptive effects; the effect first
// sold as the envelope-following "auto-wah" pedals of the early 1970s). A
// peak follower measures the voice; its level, taken in decibels against the
// voice's own loud level, sweeps the cutoff of a resonant filter on a log
// scale between the lowest and highest frequency. The filter is the
// topology-preserving state-variable filter of Vadim Zavalishin, "The Art of
// VA Filter Design" (2012), in Andrew Simper's form, which stays stable and
// zipper-free when its cutoff moves on every sample. The band-pass output
// is the classic wah; the low-pass output is the rounder funk envelope
// filter. "Direction" flips the sweep so loud syllables close the filter.
//
// Loudness reference: an envelope filter tuned for one microphone level is
// dead on a quieter take. The offline render therefore measures the take's
// own loud level first (the 95th percentile of its envelope, in dB) and
// sensitivity counts down from there, so a whisper and a shout of the same
// sentence both sweep the whole range. Live mode cannot look ahead, so it
// starts from a typical speaking level and follows the loudest recent level
// (instant rise, about 8 seconds to fall), which settles on the same
// reference within the first loud word.

const TWO_PI = 2 * Math.PI

function num(v, d) {
  return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : d
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

const params = [
  { id: 'sensitivity', name: 'Sensitivity', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [40, 85] },
  { id: 'low', name: 'Lowest', type: 'number', min: 100, max: 2000, step: 10, def: 300, unit: 'hz', rand: [200, 500] },
  { id: 'high', name: 'Highest', type: 'number', min: 500, max: 6000, step: 10, def: 2200, unit: 'hz', rand: [1500, 3500] },
  { id: 'resonance', name: 'Resonance', type: 'number', min: 0, max: 100, step: 1, def: 60, unit: 'percent', rand: [35, 80] },
  {
    id: 'direction', name: 'Direction', type: 'choice', def: 'up',
    options: [{ v: 'up', name: 'Opens when you get louder' }, { v: 'down', name: 'Closes when you get louder' }],
  },
  { id: 'sound', name: 'Filter', type: 'choice', def: 'wah', options: [{ v: 'wah', name: 'Wah' }, { v: 'low', name: 'Round low pass' }] },
  { id: 'speed', name: 'Response speed', type: 'number', min: 0, max: 100, step: 1, def: 50, unit: 'percent', rand: [30, 80] },
  { id: 'mix', name: 'Mix', type: 'number', min: 0, max: 100, step: 1, def: 100, unit: 'percent', rand: [70, 100] },
]

function timing(p, sr) {
  const sp = clamp(num(p.speed, 50), 0, 100) / 100
  const aMs = 2 + 18 * (1 - sp)
  const rMs = 40 + 360 * (1 - sp)
  return [1 - Math.exp(-1000 / (aMs * sr)), 1 - Math.exp(-1000 / (rMs * sr))]
}

/**
 * The take's loud level: the same follower the filter uses, run over the
 * whole take, read every 10 ms, 95th percentile (linear).
 */
function loudLevel(chs, sr, p) {
  const n = chs[0].length
  const hop = Math.max(1, Math.round(sr * 0.01))
  const frames = Math.floor(n / hop)
  if (frames < 1) return 0
  const [att, rel] = timing(p, sr)
  const lv = new Float32Array(frames)
  const nc = chs.length
  const g = 1 / nc
  let env = 0
  let f = 0
  for (let i = 0; i < frames * hop; i++) {
    let x = 0
    for (let c = 0; c < nc; c++) x += chs[c][i]
    x *= g
    x = x < 0 ? -x : x
    if (!(x < 1e30)) x = 0
    env += (x - env) * (x > env ? att : rel)
    if ((i + 1) % hop === 0) lv[f++] = env
  }
  lv.sort()
  return lv[Math.min(frames - 1, Math.floor(frames * 0.95))]
}

function createKernel(sr, p0, refInit) {
  const fMax = sr * 0.45
  const refFall = Math.exp(-1 / (8 * sr))
  const fCoef = 1 - Math.exp(-1 / (0.0015 * sr))
  const sm = 1 - Math.exp(-1 / (0.03 * sr))
  const ic1 = new Float64Array(2)
  const ic2 = new Float64Array(2)
  let sensT = 0.6, lowT = 300, highT = 2200, resT = 0.6, down = false, lowpass = false, mixT = 1
  let sens = 0.6, low = 300, high = 2200, res = 0.6, mix = 1
  let att = 0, rel = 0
  let env = 0, ref = refInit > 1e-4 ? refInit : 0.1
  const ref0 = ref
  let fSm = 300

  function set(p) {
    sensT = clamp(num(p.sensitivity, 60), 0, 100) / 100
    lowT = clamp(num(p.low, 300), 20, fMax)
    highT = clamp(num(p.high, 2200), 20, fMax)
    resT = clamp(num(p.resonance, 60), 0, 100) / 100
    down = p.direction === 'down'
    lowpass = p.sound === 'low'
    mixT = clamp(num(p.mix, 100), 0, 100) / 100
    const sp = clamp(num(p.speed, 50), 0, 100) / 100
    att = 1 - Math.exp(-1000 / ((2 + 18 * (1 - sp)) * sr))
    rel = 1 - Math.exp(-1000 / ((40 + 360 * (1 - sp)) * sr))
  }
  function reset() {
    ic1[0] = ic1[1] = ic2[0] = ic2[1] = 0
    env = 0
    ref = ref0
    sens = sensT
    low = lowT
    high = highT
    res = resT
    mix = mixT
    fSm = down ? high : low
  }
  set(p0)
  reset()

  return {
    set,
    reset,
    process(ins, outs, n) {
      const nc = outs.length < 2 ? outs.length : 2
      const nIn = ins.length
      for (let i = 0; i < n; i++) {
        sens += (sensT - sens) * sm
        low += (lowT - low) * sm
        high += (highT - high) * sm
        res += (resT - res) * sm
        mix += (mixT - mix) * sm
        const x0 = ins[0][i]
        const x1 = nIn > 1 ? ins[1][i] : x0
        let a = 0.5 * (x0 + x1)
        a = a < 0 ? -a : a
        if (!(a < 1e30)) a = 0
        env += (a - env) * (a > env ? att : rel)
        if (env < 1e-12) env = 0
        if (env > ref) ref = env
        else {
          ref *= refFall
          if (ref < ref0 * 0.03) ref = ref0 * 0.03
        }
        // level against the loud reference, 0 (quiet) .. 1 (loud)
        const span = 14 + 30 * sens
        const db = env > 1e-9 ? 8.685889638 * Math.log(env / ref) : -200
        let u = (db + span) / span
        u = u < 0 ? 0 : u > 1 ? 1 : u
        if (down) u = 1 - u
        const lo = low < high ? low : high
        const hi = low < high ? high : low
        const f = lo * Math.exp(Math.log(hi / lo) * u)
        fSm += (f - fSm) * fCoef
        const Q = 0.7 + 11 * res * res
        const k = 1 / Q
        const g = Math.tan((Math.PI * (fSm < fMax ? fSm : fMax)) / sr)
        const a1 = 1 / (1 + g * (g + k))
        const a2 = g * a1
        const a3 = g * a2
        // band-pass peak is Q; this keeps the average level near the dry voice
        const bpGain = 3.5 * k * Math.sqrt(Q)
        const dry = 1 - mix
        for (let c = 0; c < nc; c++) {
          const x = c === 0 ? x0 : x1
          const s1 = ic1[c]
          const s2 = ic2[c]
          const v3 = x - s2
          const v1 = a1 * s1 + a2 * v3
          const v2 = s2 + a2 * s1 + a3 * v3
          let n1 = 2 * v1 - s1
          let n2 = 2 * v2 - s2
          if (n1 < 1e-20 && n1 > -1e-20) n1 = 0
          if (n2 < 1e-20 && n2 > -1e-20) n2 = 0
          if (!(n1 < 1e9 && n1 > -1e9 && n2 < 1e9 && n2 > -1e9)) {
            n1 = 0
            n2 = 0
          }
          ic1[c] = n1
          ic2[c] = n2
          const y = lowpass ? v2 + v1 * k * 0.5 : v1 * bpGain
          outs[c][i] = x * dry + y * mix
        }
      }
    },
  }
}

export default {
  id: 'mod.autowah',
  name: 'Envelope filter',
  family: 'mod',
  about: 'A wah that opens and closes by itself as you speak louder and softer, the funky talking filter sound.',
  params,
  stereo: 'keep',
  tail: () => 0,
  warps: false,
  cost: 2,
  process(input, p, ctx) {
    const sr = input.sr
    const nch = Math.min(2, input.ch.length)
    const len = nch ? input.ch[0].length : 0
    if (!len) return input
    const chs = input.ch.slice(0, nch)
    const outs = []
    for (let c = 0; c < nch; c++) outs.push(new Float32Array(len))
    const k = createKernel(sr, p, loudLevel(chs, sr, p))
    k.process(chs, outs, len)
    if (ctx && typeof ctx.progress === 'function') ctx.progress(1)
    return { sr, ch: outs }
  },
  live: {
    latency: () => 0,
    create(sr, p) {
      return createKernel(sr, p, 0.1)
    },
  },
}
