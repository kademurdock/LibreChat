// test/space.nodetest.mjs - the space family: rooms, reverbs, walls and distance.
//
// Every module is checked against the contract (shape, robustness at min,
// default and max, stereo in, every sample rate, determinism), then proved
// to do what its name says by measurement: decay times against the setting,
// direct-to-reverberant ratio against distance, octaves in the shimmer tail,
// a hard stop after the gate, the spring's rising chirps, highs removed
// through a wall, highs and directness lost with distance. Live versions are
// run in small blocks, mono and stereo, in place, with parameter changes, and
// the ones built on the same code as the offline render must match it.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

import { makeRng } from '../core/rng.js'
import { resolveParams, validateModuleShape } from '../core/params.js'
import { estimateRT60, namedIR, SPACE_NAMES } from '../core/ir.js'
import { Biquad, OnePole } from '../core/biquad.js'
import { decodeWav } from '../core/wav.js'
import { synthVoice, impulse, silence } from './fixtures.mjs'
import { assertSane, bandEnergyDb } from './measure.mjs'

import room from '../modules/space/room.js'
import reverb from '../modules/space/reverb.js'
import shimmer from '../modules/space/shimmer.js'
import gated from '../modules/space/gated.js'
import spring from '../modules/space/spring.js'
import muffle from '../modules/space/muffle.js'
import distance from '../modules/space/distance.js'

const MODULES = [room, reverb, shimmer, gated, spring, muffle, distance]
const SPEECH = 'F:/Kade ai info/Fish talking listen (Oct 16)/02 Crisp Quartz, today.wav'

function ctxOf(sr, seed = 1) {
  return { sr, rng: makeRng(seed), progress() {}, cancelled: () => false, note() {} }
}

function run(mod, input, p = {}, seed = 1) {
  const params = resolveParams(mod, p)
  return mod.process(input, params, ctxOf(input.sr, seed))
}

function energy(a, from = 0, to = a.length) {
  let e = 0
  for (let i = from; i < to; i++) e += a[i] * a[i]
  return e
}

function db(x) {
  return 10 * Math.log10(x + 1e-30)
}

function weighted(sig, sr) {
  const w = new Float32Array(sig)
  new Biquad('highpass', sr, 100, 0.707).run(w)
  new OnePole(sr, 700, 'lp').run(w)
  return energy(w)
}

/** Render a live instance in blocks of B; mono or stereo in, stereo out. */
function runLive(mod, input, p = {}, opts = {}) {
  const sr = input.sr
  const params = resolveParams(mod, p)
  const inst = mod.live.create(sr, params, makeRng(opts.seed || 1))
  const tailN = opts.tail !== undefined ? opts.tail : Math.round(mod.tail(params, sr) * sr)
  const len = input.ch[0].length + tailN
  const B = opts.block || 128
  const L = new Float32Array(len)
  const R = new Float32Array(len)
  const inL = new Float32Array(len)
  inL.set(input.ch[0])
  let inR = null
  if (input.ch.length > 1) {
    inR = new Float32Array(len)
    inR.set(input.ch[1])
  }
  for (let s = 0; s < len; s += B) {
    const n = Math.min(B, len - s)
    if (opts.setAt !== undefined && s <= opts.setAt && opts.setAt < s + n) inst.set(resolveParams(mod, opts.setTo))
    const ins = inR ? [inL.subarray(s, s + n), inR.subarray(s, s + n)] : [inL.subarray(s, s + n)]
    inst.process(ins, [L.subarray(s, s + n), R.subarray(s, s + n)], n)
  }
  return { sr, ch: [L, R] }
}

const V48 = synthVoice(48000, 3, { seed: 11 })
const V24 = synthVoice(24000, 2, { seed: 12, f0: 210 })

let realSpeech = null
try {
  if (existsSync(SPEECH)) realSpeech = decodeWav(new Uint8Array(readFileSync(SPEECH)))
} catch {
  realSpeech = null
}

// ---------------------------------------------------------------- contract

describe('space family: contract shape', () => {
  for (const mod of MODULES) {
    test(mod.id + ' passes the module shape check and has live', () => {
      assert.deepEqual(validateModuleShape(mod), [])
      assert.equal(mod.family, 'space')
      assert.ok(mod.live && typeof mod.live.create === 'function')
      assert.ok(mod.params.length >= 2 && mod.params.length <= 8)
      assert.equal(mod.stereo, 'make')
    })
  }

  test('space.room offers every named space, with plain names', () => {
    const opt = room.params.find((p) => p.id === 'space').options
    assert.deepEqual(
      opt.map((o) => o.v),
      SPACE_NAMES,
    )
    for (const o of opt) assert.ok(/^[A-Z][a-z ]+$/.test(o.name), o.name)
  })
})

function extremes(mod) {
  const lo = {}
  const hi = {}
  for (const p of mod.params) {
    if (p.type === 'number') {
      lo[p.id] = p.min
      hi[p.id] = p.max
    } else if (p.type === 'bool') {
      lo[p.id] = false
      hi[p.id] = true
    } else {
      lo[p.id] = p.options[0].v
      hi[p.id] = p.options[p.options.length - 1].v
    }
  }
  return [lo, {}, hi]
}

describe('space family: robustness', () => {
  for (const mod of MODULES) {
    test(mod.id + ': empty, silence, click and speech at min, default and max', () => {
      const sr = 24000
      const empty = run(mod, { sr, ch: [new Float32Array(0)] })
      assert.equal(empty.ch[0].length, 0)
      for (const p of extremes(mod)) {
        const params = resolveParams(mod, p)
        const tailN = Math.round(mod.tail(params, sr) * sr)
        for (const input of [silence(sr, 0.5), impulse(sr, 0.3, 0.05), V24]) {
          const y = run(mod, input, p)
          assertSane(y)
          assert.equal(y.ch.length, 2)
          assert.equal(y.ch[0].length, input.ch[0].length + tailN, mod.id + ' length follows tail for ' + JSON.stringify(p))
        }
        const sil = run(mod, silence(sr, 0.5), p)
        assert.ok(energy(sil.ch[0]) === 0 && energy(sil.ch[1]) === 0, 'silence stays silent')
      }
    })

    test(mod.id + ': stereo in, other rates, determinism', () => {
      const st = { sr: 24000, ch: [new Float32Array(V24.ch[0]), new Float32Array(V24.ch[0].length)] }
      for (let i = 0; i < st.ch[1].length; i++) st.ch[1][i] = 0.5 * V24.ch[0][(i + 37) % V24.ch[0].length]
      assertSane(run(mod, st))
      for (const sr of [8000, 44100, 96000]) {
        const v = synthVoice(sr, 0.8, { seed: 3 })
        const y = run(mod, v)
        assertSane(y)
        assert.ok(energy(y.ch[0]) > 0)
      }
      const a = run(mod, V24, {}, 5)
      const b = run(mod, V24, {}, 5)
      assert.deepEqual(a.ch[0], b.ch[0])
      assert.deepEqual(a.ch[1], b.ch[1])
    })
  }

  test('space.room: every named space at 24 kHz on speech', () => {
    for (const space of SPACE_NAMES) {
      const y = run(room, V24, { space })
      const { peak } = assertSane(y)
      assert.ok(peak > 0.01, space + ' is not silent')
      const wIn = weighted(V24.ch[0], 24000)
      const wOut = 0.5 * (weighted(y.ch[0], 24000) + weighted(y.ch[1], 24000))
      const d = db(wOut / wIn)
      assert.ok(d > -12 && d < 9, space + ' keeps about the voice level (' + d.toFixed(1) + ' dB)')
    }
  })

  test('long input: 30 s of speech through each module at defaults', () => {
    const v = synthVoice(48000, 30, { seed: 7 })
    for (const mod of MODULES) assertSane(run(mod, v))
  })
})

// ---------------------------------------------------------------- prove it

describe('space family: each does what its name says', () => {
  const sr = 48000
  const click = impulse(sr, 0.2)

  test('space.reverb: decay time within 30 percent of the setting', () => {
    for (const decay of [0.8, 1.8, 4, 9]) {
      for (const damping of [0, 40]) {
        const y = run(reverb, click, { decay, damping, mix: 100, predelay: 0 })
        const rt = estimateRT60(y.ch[0], sr)
        assert.ok(Math.abs(rt / decay - 1) < 0.3, 'decay ' + decay + ' damping ' + damping + ' measured ' + rt.toFixed(2))
      }
    }
  })

  test('space.reverb: size spreads the first echoes, width decorrelates, mix 0 is dry', () => {
    const small = run(reverb, click, { size: 0, mix: 100, predelay: 0 })
    const big = run(reverb, click, { size: 100, mix: 100, predelay: 0 })
    const firstAbove = (a) => {
      let pk = 0
      for (const v of a) pk = Math.max(pk, Math.abs(v))
      for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > 0.1 * pk) return i
      return a.length
    }
    assert.ok(firstAbove(big.ch[0]) > firstAbove(small.ch[0]) * 3)
    const corr = (b) => {
      const L = b.ch[0], R = b.ch[1]
      let xy = 0, xx = 0, yy = 0
      for (let i = 0; i < L.length; i++) {
        xy += L[i] * R[i]
        xx += L[i] * L[i]
        yy += R[i] * R[i]
      }
      return xy / Math.sqrt(xx * yy)
    }
    assert.ok(corr(run(reverb, V48, { width: 1, mix: 100 })) < 0.5)
    assert.ok(corr(run(reverb, V48, { width: 0, mix: 100 })) > 0.99)
    const dry = run(reverb, V48, { mix: 0 })
    for (let i = 0; i < V48.ch[0].length; i += 997) assert.ok(Math.abs(dry.ch[0][i] - V48.ch[0][i]) < 1e-6)
  })

  test('space.room: the tail decays like the space (RT60 within 30 percent of core/ir.js)', () => {
    for (const space of ['classroom', 'church', 'cathedral', 'bathroom', 'plate']) {
      const y = run(room, click, { space })
      const ref = estimateRT60(namedIR(space, sr, makeRng(1)).ch[0], sr)
      const rt = estimateRT60(y.ch[0], sr)
      assert.ok(Math.abs(rt / ref - 1) < 0.3, space + ': ' + rt.toFixed(2) + ' vs ' + ref.toFixed(2))
    }
    const one = estimateRT60(run(room, click, { space: 'church' }).ch[0], sr)
    const two = estimateRT60(run(room, click, { space: 'church', size: 2 }).ch[0], sr)
    assert.ok(two / one > 1.5 && two / one < 2.6, 'twice the size, about twice the decay: ' + (two / one).toFixed(2))
  })

  test('space.room: distance moves the direct-to-reverberant ratio, mix 0 is dry', () => {
    const n3 = Math.round(0.0025 * sr)
    const drr = (y) => db(energy(y.ch[0], 0, n3) / energy(y.ch[0], n3))
    for (const space of ['classroom', 'concert-hall', 'cave']) {
      const near = drr(run(room, click, { space, distance: 0 }))
      const mid = drr(run(room, click, { space, distance: 50 }))
      const far = drr(run(room, click, { space, distance: 100 }))
      assert.ok(near > mid + 6 && mid > far + 6, space + ': near ' + near.toFixed(1) + ', as built ' + mid.toFixed(1) + ', far ' + far.toFixed(1))
    }
    const dry = run(room, V48, { mix: 0 })
    for (let i = 0; i < V48.ch[0].length; i += 991) assert.ok(Math.abs(dry.ch[0][i] - V48.ch[0][i]) < 1e-6)
    const pre = run(room, click, { space: 'church', predelay: 100 })
    const e1 = energy(pre.ch[0], Math.round(0.003 * sr), Math.round(0.095 * sr))
    const e2 = energy(pre.ch[0], Math.round(0.1 * sr), Math.round(0.2 * sr))
    assert.ok(e2 > e1 * 20, 'the predelay opens a gap before the echoes')
  })

  test('space.room: the plate and spring keep the dry voice on top', () => {
    for (const space of ['plate', 'spring']) {
      const y = run(room, click, { space })
      const d = energy(y.ch[0], 0, 8)
      const r = energy(y.ch[0], 8)
      assert.ok(d > r, space + ': direct above reverb')
    }
  })

  test('space.room live: level and decay close to the offline space', () => {
    for (const space of ['classroom', 'bathroom', 'cathedral', 'car', 'canyon', 'plate', 'tin-can', 'forest']) {
      const off = run(room, V48, { space })
      const live = runLive(room, V48, { space })
      const wo = weighted(off.ch[0], sr) + weighted(off.ch[1], sr)
      const wl = weighted(live.ch[0], sr) + weighted(live.ch[1], sr)
      assert.ok(Math.abs(db(wl / wo)) < 7, space + ' live level ' + db(wl / wo).toFixed(1) + ' dB from offline')
      const ro = estimateRT60(run(room, click, { space }).ch[0], sr)
      const rl = estimateRT60(runLive(room, click, { space }).ch[0], sr)
      if (ro > 0.3) assert.ok(Math.abs(rl / ro - 1) < 0.45, space + ' live decay ' + rl.toFixed(2) + ' vs ' + ro.toFixed(2))
    }
  })

  test('space.shimmer: the tail climbs the interval', () => {
    const n = Math.round(0.5 * sr)
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 300 * i) / sr) * Math.min(1, i / 480, (n - i) / 480)
    const tone = { sr, ch: [x] }
    const band = (y, lo, hi) => bandEnergyDb(y.ch[0].subarray(Math.round(1.0 * sr), Math.round(3 * sr)), sr, lo, hi)
    const plain = run(shimmer, tone, { amount: 0, mix: 100 })
    const oct = run(shimmer, tone, { mix: 100 })
    const fifth = run(shimmer, tone, { interval: 'fifth', mix: 100 })
    const down = run(shimmer, tone, { interval: 'down', mix: 100 })
    assert.ok(band(oct, 570, 630) > band(plain, 570, 630) + 30, 'an octave up appears')
    assert.ok(band(oct, 570, 630) > band(oct, 300, 330) - 12, 'and is strong')
    assert.ok(band(fifth, 420, 480) > band(plain, 420, 480) + 30, 'a fifth up appears')
    assert.ok(band(down, 135, 165) > band(plain, 135, 165) + 30, 'an octave down appears')
    const wild = run(shimmer, V48, { amount: 100, decay: 20, size: 100, tone: 100, interval: 'twooct', mix: 100 })
    assert.ok(assertSane(wild).peak < 3, 'full shimmer stays bounded')
  })

  test('space.gated: a burst behind each word that stops dead', () => {
    for (const shape of ['fall', 'flat', 'rise']) {
      const gate = 250
      const y = run(gated, click, { gate, shape, mix: 100 })
      const ms = (t) => Math.round((t / 1000) * sr)
      const during = energy(y.ch[0], ms(5), ms(gate - 5))
      const after = energy(y.ch[0], ms(gate + 8), y.ch[0].length)
      assert.ok(during > 0 && after < during * 1e-6, shape + ': silent after the gate')
      const early = energy(y.ch[0], ms(20), ms(70))
      const late = energy(y.ch[0], ms(180), ms(230))
      if (shape === 'fall') assert.ok(late < early * 0.5, 'falling shape falls')
      if (shape === 'rise') assert.ok(late > early * 2, 'reverse swell rises')
      if (shape === 'flat') assert.ok(late > early * 0.3 && late < early * 3, 'flat stays level')
    }
    // Live: the wet stops soon after the voice stops.
    const v = synthVoice(sr, 1.5, { seed: 4 })
    const pad = { sr, ch: [new Float32Array(v.ch[0].length + sr)] }
    pad.ch[0].set(v.ch[0])
    const live = runLive(gated, pad, { mix: 100, gate: 200 }, { tail: 0 })
    const endV = v.ch[0].length
    const lateE = energy(live.ch[0], endV + Math.round(0.4 * sr), endV + sr)
    const busyE = energy(live.ch[0], 0, endV)
    assert.ok(lateE < busyE * 1e-5, 'live gate closes')
  })

  test('space.spring: decay follows the setting and the echoes are rising chirps', () => {
    for (const decay of [1.2, 2.4, 4]) {
      const y = run(spring, click, { decay, mix: 100 })
      const rt = estimateRT60(y.ch[0], sr)
      assert.ok(Math.abs(rt / decay - 1) < 0.35, 'decay ' + decay + ' measured ' + rt.toFixed(2))
    }
    // Dispersion: within the first trip, highs arrive before lows.
    const y = run(spring, click, { springs: 1, drip: 100, mix: 100 })
    const centroid = (lo, hi) => {
      const b = new Float32Array(y.ch[0].subarray(0, Math.round(0.03 * sr)))
      new Biquad('bandpass', sr, Math.sqrt(lo * hi), Math.sqrt(lo * hi) / (hi - lo)).run(b)
      let a = 0, w = 0
      for (let i = 0; i < b.length; i++) {
        a += i * b[i] * b[i]
        w += b[i] * b[i]
      }
      return a / w
    }
    // Theory for 40 sections at a = 0.8: about 0.6 ms at 450 Hz, 2 ms at 2.6 kHz.
    const lag = (centroid(2000, 3200) - centroid(300, 600)) / sr
    assert.ok(lag > 0.0007, 'highs arrive later (the rising chirp of a drip): ' + (lag * 1000).toFixed(2) + ' ms')
    const none = run(spring, click, { springs: 1, drip: 0, mix: 100 })
    // Time spread (energy-weighted deviation) of the first trip, before the
    // spring's 33 ms loop brings the second one.
    const spreadOf = (b) => {
      const s = b.ch[0].subarray(0, Math.round(0.03 * sr))
      let e = 0, m = 0
      for (let i = 0; i < s.length; i++) {
        e += s[i] * s[i]
        m += i * s[i] * s[i]
      }
      m /= e
      let v = 0
      for (let i = 0; i < s.length; i++) v += (i - m) * (i - m) * s[i] * s[i]
      return Math.sqrt(v / e) / sr
    }
    assert.ok(spreadOf(y) > spreadOf(none) * 1.3, 'more drip, longer chirp: ' + (spreadOf(y) * 1000).toFixed(1) + ' vs ' + (spreadOf(none) * 1000).toFixed(1) + ' ms')
  })

  test('space.muffle: walls remove highs, thicker walls more, gaps let some back', () => {
    const v = V48
    const tilt = (b) => bandEnergyDb(b.ch[0], sr, 2500, 6000) - bandEnergyDb(b.ch[0], sr, 150, 500)
    const t0 = tilt(v)
    const res = {}
    for (const wall of ['door', 'closet', 'thin', 'thick', 'floor', 'window', 'vent']) {
      res[wall] = tilt(run(muffle, v, { wall }))
      if (wall !== 'vent' && wall !== 'window' && wall !== 'closet') assert.ok(res[wall] < t0 - 15, wall + ' removes highs: ' + (res[wall] - t0).toFixed(1) + ' dB')
    }
    assert.ok(res.thick < res.door - 6, 'a thick wall muffles more than a door')
    assert.ok(res.closet < t0 - 8 && res.window < t0 - 8, 'closet and car window muffle too')
    const tight = tilt(run(muffle, v, { wall: 'door', gaps: 0 }))
    const leaky = tilt(run(muffle, v, { wall: 'door', gaps: 100 }))
    assert.ok(leaky > tight + 6, 'gaps let highs through')
    // Muffling works on the wall itself (the voice band); gaps own the thin highs.
    const mids = (b) => bandEnergyDb(b.ch[0], sr, 700, 2500) - bandEnergyDb(b.ch[0], sr, 150, 500)
    const heavy = mids(run(muffle, v, { wall: 'door', muffling: 100 }))
    const light = mids(run(muffle, v, { wall: 'door', muffling: 0 }))
    assert.ok(light > heavy + 6, 'muffling moves the tone: ' + (light - heavy).toFixed(1) + ' dB')
    const live = runLive(muffle, v, { wall: 'thin' })
    assert.ok(tilt(live) < t0 - 15, 'live thin wall removes highs too: ' + (tilt(live) - t0).toFixed(1))
  })

  test('space.distance: farther is duller and less direct; live is the offline render', () => {
    const v = V48
    const hi = (b) => bandEnergyDb(b.ch[0], sr, 4000, 9000) - bandEnergyDb(b.ch[0], sr, 300, 1500)
    const near = run(distance, v, { distance: 5 })
    const far = run(distance, v, { distance: 500 })
    assert.ok(hi(far) < hi(near) - 10, 'air absorption')
    const n3 = Math.round(0.004 * sr)
    const drr = (y) => db(energy(y.ch[0], 0, n3) / energy(y.ch[0], n3))
    const dn = drr(run(distance, click, { distance: 5, wind: 0 }))
    const df = drr(run(distance, click, { distance: 300, wind: 0 }))
    const di = drr(run(distance, click, { distance: 300, wind: 0, outdoors: false }))
    assert.ok(dn > df + 6, 'less direct sound when far: ' + dn.toFixed(1) + ' vs ' + df.toFixed(1))
    assert.ok(df > di + 3, 'a far voice indoors is more reverberant than outdoors')
    // The direct sound lines up with the input (latency removed offline).
    const y = run(distance, click, { distance: 2, wind: 0, echoes: 0 })
    let pk = 0, at = 0
    for (let i = 0; i < 200; i++) if (Math.abs(y.ch[0][i]) > pk) { pk = Math.abs(y.ch[0][i]); at = i }
    assert.ok(at < 8, 'direct sound at the input time, found at ' + at)
  })
})

// ---------------------------------------------------------------- live

describe('space family: live versions', () => {
  const sr = 48000
  for (const mod of MODULES) {
    test(mod.id + ' live: blocks, mono and stereo, in place, parameter changes', () => {
      const params = resolveParams(mod, {})
      assert.ok(Number.isFinite(mod.live.latency(params, sr)) && mod.live.latency(params, sr) >= 0)
      for (const block of [128, 480, 37]) {
        const y = runLive(mod, V48, {}, { block, tail: 0 })
        assertSane(y)
        assert.ok(energy(y.ch[0]) > 0)
      }
      const st = { sr, ch: [V48.ch[0], new Float32Array(V48.ch[0])] }
      assertSane(runLive(mod, st, {}, { tail: 0 }))
      // In place: outs alias ins (stereo).
      const inst = mod.live.create(sr, params, makeRng(2))
      const a = new Float32Array(V48.ch[0])
      const b = new Float32Array(V48.ch[0])
      for (let s = 0; s < a.length; s += 128) {
        const n = Math.min(128, a.length - s)
        const va = a.subarray(s, s + n)
        const vb = b.subarray(s, s + n)
        inst.process([va, vb], [va, vb], n)
      }
      assertSane({ sr, ch: [a, b] })
      inst.reset()
      // One mono output.
      const m = new Float32Array(4800)
      inst.process([V48.ch[0].subarray(0, 4800)], [m], 4800)
      assertSane({ sr, ch: [m] })
      // Every extreme, switched mid-stream, never blows up or clicks hard.
      for (const p of extremes(mod)) {
        const y = runLive(mod, V48, {}, { setAt: Math.round(0.8 * sr), setTo: p, tail: Math.round(0.5 * sr) })
        const { peak } = assertSane(y)
        assert.ok(peak < 4, mod.id + ' after set ' + JSON.stringify(p) + ' peak ' + peak.toFixed(2))
      }
    })
  }

  // A steady noise through the effect; at 1 s the settings change. The
  // sample-to-sample step right after the change must stay in line with the
  // steps elsewhere (no click), whatever the change.
  const CHANGES = [
    [room, { space: 'cathedral' }, { space: 'spring' }],
    [room, { space: 'spring' }, { space: 'bathroom', distance: 80 }],
    [room, { space: 'tin-can' }, { space: 'tin-can', size: 2, predelay: 60, tone: -80 }],
    [reverb, {}, { size: 100, decay: 9, predelay: 200, mix: 80 }],
    [shimmer, {}, { interval: 'down', size: 10, mix: 90 }],
    [gated, {}, { gate: 700, shape: 'flat', predelay: 60 }],
    [spring, {}, { springs: 3, drip: 0, decay: 5, mix: 80 }],
    [muffle, {}, { wall: 'thick', room: 'gym', muffling: 90 }],
    [muffle, { wall: 'vent' }, { wall: 'window', yours: 100 }],
    [muffle, { wall: 'thick' }, { wall: 'vent', room: 'none' }],
    [muffle, { wall: 'door', gaps: 0 }, { wall: 'closet', muffling: 0, gaps: 100 }],
    [distance, {}, { distance: 900, outdoors: false, wind: 100 }],
  ]
  for (const [mod, from, to] of CHANGES) {
    test(mod.id + ' live: no click when ' + JSON.stringify(from) + ' becomes ' + JSON.stringify(to), () => {
      const n = Math.round(2 * sr)
      const x = new Float32Array(n)
      const r = makeRng('steady')
      // Smooth noise (two one-poles near 200 Hz): its own steps are tiny, so
      // a click would stand far above them.
      let lp = 0
      let lp2 = 0
      for (let i = 0; i < n; i++) {
        lp += 0.026 * (r.range(-1, 1) - lp)
        lp2 += 0.026 * (lp - lp2)
        x[i] = 3 * lp2
      }
      const at = Math.round(1 * sr)
      const y = runLive(mod, { sr, ch: [x] }, from, { setAt: at, setTo: to, tail: 0 })
      const steps = (a, b) => {
        let m = 0
        for (let c = 0; c < 2; c++) for (let i = Math.max(1, a); i < b; i++) m = Math.max(m, Math.abs(y.ch[c][i] - y.ch[c][i - 1]))
        return m
      }
      const before = steps(Math.round(0.5 * sr), at - 128)
      const after = steps(Math.round(1.3 * sr), n)
      const around = steps(at - 128, at + Math.round(0.01 * sr))
      assert.ok(around < 2.5 * Math.max(before, after), 'step ' + around.toFixed(4) + ' against ' + before.toFixed(4) + ' and ' + after.toFixed(4))
    })
  }

  // A dragged slider: a new value every 128 samples for half a second.
  const DRAGS = [
    [room, (k) => ({ space: 'church', size: 0.6 + k * 0.02 })],
    [room, (k) => ({ space: k % 16 < 8 ? 'spring' : 'cathedral', distance: k })],
    [muffle, (k) => ({ wall: 'door', muffling: k * 1.5 })],
    [reverb, (k) => ({ size: k * 1.5, decay: 0.5 + k * 0.1 })],
    [distance, (k) => ({ distance: 10 + k * 12 })],
  ]
  for (const [mod, at] of DRAGS) {
    test(mod.id + ' live: a dragged slider stays smooth', () => {
      const n = Math.round(2 * sr)
      const x = new Float32Array(n)
      const r = makeRng('drag')
      let lp = 0
      let lp2 = 0
      for (let i = 0; i < n; i++) {
        lp += 0.026 * (r.range(-1, 1) - lp)
        lp2 += 0.026 * (lp - lp2)
        x[i] = 3 * lp2
      }
      const inst = mod.live.create(sr, resolveParams(mod, at(0)), makeRng(1))
      const L = new Float32Array(n)
      const R = new Float32Array(n)
      const start = Math.round(0.5 * sr)
      for (let s = 0, k = 0; s < n; s += 128) {
        const m = Math.min(128, n - s)
        if (s >= start && k < 64) inst.set(resolveParams(mod, at(++k)))
        inst.process([x.subarray(s, s + m)], [L.subarray(s, s + m), R.subarray(s, s + m)], m)
      }
      assertSane({ sr, ch: [L, R] })
      const steps = (a, b) => {
        let m = 0
        for (const c of [L, R]) for (let i = Math.max(1, a); i < b; i++) m = Math.max(m, Math.abs(c[i] - c[i - 1]))
        return m
      }
      const quiet = Math.max(steps(Math.round(0.2 * sr), start), steps(Math.round(1.5 * sr), n))
      const during = steps(start, start + 64 * 128 + Math.round(0.05 * sr))
      assert.ok(during < 2.5 * quiet, 'step ' + during.toFixed(4) + ' against ' + quiet.toFixed(4))
    })
  }

  for (const mod of [reverb, shimmer, spring, distance]) {
    test(mod.id + ' live matches the offline render sample for sample', () => {
      const p = mod === distance ? { distance: 120 } : {}
      const off = run(mod, V48, p, 3)
      const params = resolveParams(mod, p)
      const lat = mod.live.latency(params, sr)
      const live = runLive(mod, V48, p, { seed: 3, tail: Math.round(mod.tail(params, sr) * sr) + lat })
      const n = V48.ch[0].length
      let err = 0, ref = 0
      for (let c = 0; c < 2; c++) {
        for (let i = 0; i < n; i++) {
          const d = live.ch[c][i + lat] - off.ch[c][i]
          err += d * d
          ref += off.ch[c][i] * off.ch[c][i]
        }
      }
      assert.ok(err <= ref * 1e-10, mod.id + ' differs by ' + db(err / ref).toFixed(1) + ' dB')
    })
  }
})

// ---------------------------------------------------------------- speed and real speech

describe('space family: speed and real speech', () => {
  test('speed per second of 48 kHz mono (generous bounds)', () => {
    const v = synthVoice(48000, 10, { seed: 9 })
    const rows = []
    for (const mod of MODULES) {
      run(mod, synthVoice(48000, 0.5, { seed: 1 }))
      const t0 = performance.now()
      run(mod, v)
      const ms = (performance.now() - t0) / 10
      rows.push(mod.id + ' ' + ms.toFixed(1) + ' ms/s')
      assert.ok(ms < 450, mod.id + ' took ' + ms.toFixed(0) + ' ms per second')
    }
    console.log('speed: ' + rows.join(', '))
  })

  test('real speech (24 kHz) through every module at defaults', { skip: realSpeech ? false : 'speech file missing' }, () => {
    const v = { sr: realSpeech.sr, ch: [realSpeech.ch[0].subarray(0, Math.min(realSpeech.ch[0].length, realSpeech.sr * 8))] }
    for (const mod of MODULES) {
      const y = run(mod, v)
      const { peak } = assertSane(y)
      assert.ok(peak > 0.01)
    }
    const tilt = (b) => bandEnergyDb(b.ch[0], v.sr, 2500, 6000) - bandEnergyDb(b.ch[0], v.sr, 150, 500)
    assert.ok(tilt(run(muffle, v)) < tilt(v) - 15, 'the door muffles real speech')
  })
})
