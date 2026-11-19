// core/space3d.js - put a mono voice at a place around the listener's head.
//
// The model is the structural spherical-head model of Brown and Duda 1998,
// "A structural model for binaural sound synthesis" (IEEE Trans. Speech and
// Audio Processing 6(5)), built from separate, cheap pieces that each carry
// one cue, so every cue moves smoothly when the source moves:
//
// Interaural time difference: Woodworth's formula for a rigid sphere
// (Woodworth and Schlosberg 1954) in Brown and Duda's per-ear form. With
// theta the angle between the source direction and an ear's axis, that
// ear's delay is (a/c)(1 - cos theta) while the ear can see the source and
// (a/c)(1 + theta - pi/2) once the path wraps round the head, with head
// radius a = 8.75 cm and c = 343 m/s. The largest difference is about
// 0.66 ms, at 90 degrees.
//
// Head shadow: Brown and Duda's one-pole, one-zero filter
// H(s) = (1 + alpha s / 2w0) / (1 + s / 2w0), w0 = c/a, with
// alpha(theta) = (1 + amin/2) + (1 - amin/2) cos(180 deg theta / theta_min),
// amin = 0.1 and theta_min = 150 deg, theta measured from an ear axis set
// 100 degrees round from the nose as in the paper. It is digitised by the
// bilinear transform. alpha is divided by its value for a source straight
// ahead, so a frontal source is not dulled (frontal equalisation, the usual
// practice with head models): the near ear brightens by up to about 10 dB
// and the far ear darkens by about 10 dB above 2 kHz, matching measured heads.
// alpha moves every sample and the filter coefficients are linear in alpha,
// so a circling source never zips.
//
// Elevation: the pinna notch. Measured head-related responses show a deep
// first notch that rises from about 5 kHz below the horizon to 11-13 kHz
// above it (Hebrank and Wright 1974; Iida and colleagues 2007; Raykar,
// Duraiswami and Yegnanarayana 2005). Two time-varying bell cuts model the
// first and second notches; their depth fades as the source goes overhead
// and when the notch would sit above 0.42 of the sample rate.
//
// Front and back: sources behind lose highs to the pinna and gain a little
// around 1 kHz (Blauert's "directional bands", Blauert 1969/70). A gentle
// first-order high shelf (down to -9 dB) and a +2 dB bell at 1.1 kHz,
// both scaled by how far behind the source is, carry that cue.
//
// Rear model (opts.rear). The head shadow's ear axes sit 100 degrees round
// from the nose, so a source straight behind is 80 degrees from both axes
// while a source ahead is 100 degrees away; equalised to the front, the
// shadow alone therefore makes a rear source BRIGHTER than a frontal one
// (+4.4 dB above about 1.2 kHz), which undoes half of the behind shelf: in
// the classic model a source straight behind ends up only 0.5 dB duller
// above 2 kHz than the same source ahead. Real heads do the opposite (the
// pinna shadows the rear). rear: 'natural' fixes that: the shadow of a source
// behind the ears is taken at its mirror image in front (same side, same
// height), so the head itself adds no front/back difference, the behind shelf
// then sets the rear loss (about -5 dB above 2 kHz at 180 degrees, growing
// smoothly from nothing at 90 degrees), and a gentle bell cut at 7.8 kHz
// (Q 1.5, down to -4 dB straight behind) adds the rear dip in the 6 to 10 kHz
// band where measured heads lose most. Front and side sources (90 degrees or
// less off the nose) are identical in both models, and every new value is
// smoothed like the others, so motion stays smooth. The default stays
// 'classic' because the stereo family (modules/stereo/_lib.js spatialize)
// already applies its own rear correction before calling place; once it
// passes rear: 'natural' instead, that correction must go.
//
// Distance: each ear's own distance to the source sets its gain with a
// softened inverse law, g = sqrt((1 + r0^2) / (d^2 + r0^2)), r0 = 0.25 m,
// so 1 m is unity, every doubling far away is -6 dB, and a source at the
// head saturates near +12 dB instead of blowing up. Because each ear has
// its own distance, a close source on one side also gets the extra level
// difference of the near field. Air absorption grows with the square of
// frequency (ISO 9613-1); a one-pole lowpass at 43.3 kHz / sqrt(d)
// (21 kHz at 4 m, 4.3 kHz at 100 m) approximates it, faded out for near
// sources.
//
// Doppler: the whole signal runs through one fractional delay line (cubic
// Hermite reads) whose delay is distance / c. When the distance changes the
// read point speeds up or slows down, which is exactly the doppler pitch
// change heard by a still listener, approaching sounds higher. The smallest
// distance delay over the whole path is removed, so a source that stays at
// one distance adds no latency.
//
// Smoothness: the path is read every 16 samples; every derived value (two
// delays, two gains, two shadows, the notch tuning and depths, the back cue
// and the air filter) is smoothed with a 4 ms one-pole over those control
// points and then interpolated linearly sample by sample.

import { DelayLine } from './delay.js'

const C = 343
const DEG = Math.PI / 180
const TINY = 1e-25
const CTRL = 16
// natural rear model (see the header)
const REAR_SHELF_DB = -9
const REAR_DIP_HZ = 7800
const REAR_DIP_Q = 1.5
const REAR_DIP_DB = -4

function num(v, d) {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}

function shadowAlpha(theta) {
  // theta in radians from the shadow axis, 0..pi
  const amin = 0.1
  const thMin = 150 * DEG
  return 1 + amin / 2 + (1 - amin / 2) * Math.cos((theta / thMin) * Math.PI)
}

function wrapDelay(theta, a) {
  // Brown and Duda per-ear delay (seconds), theta from the ear axis.
  if (theta < Math.PI / 2) return (a / C) * (1 - Math.cos(theta))
  return (a / C) * (1 + theta - Math.PI / 2)
}

/**
 * Place a mono signal in space.
 * @param {Float32Array} mono
 * @param {number} sr
 * @param {function|object} path  (tSeconds) => { az, el, dist } or one fixed { az, el, dist }.
 *   az degrees (0 ahead, +90 right, -90 left, 180 behind), el degrees (+90 overhead),
 *   dist metres.
 * @param {object} [opts] { headRadius=0.0875, doppler=true, air=true, nearField=true,
 *   smoothMs=4, tail=false (true adds room for the longest delay at the end),
 *   rear='classic' | 'natural' (natural: sources behind come out duller than
 *   the same source ahead, see the header; front and side are unchanged) }
 * @returns {{ L: Float32Array, R: Float32Array }}
 */
export function place(mono, sr, path, opts = {}) {
  if (!(sr > 0)) sr = 48000
  if (!opts || typeof opts !== 'object') opts = {}
  const n = mono.length
  const a = num(opts.headRadius, 0.0875)
  const doppler = opts.doppler !== false
  const air = opts.air !== false
  const nearField = opts.nearField !== false
  const natural = opts.rear === 'natural'
  const fn = typeof path === 'function' ? path : () => path || {}
  const nCtl = Math.ceil(n / CTRL) + 2

  // Control-point tracks.
  const dL = new Float64Array(nCtl)
  const dR = new Float64Array(nCtl)
  const gL = new Float64Array(nCtl)
  const gR = new Float64Array(nCtl)
  const aL = new Float64Array(nCtl)
  const aR = new Float64Array(nCtl)
  const n1g = new Float64Array(nCtl) // notch 1 tan coefficient
  const n1G = new Float64Array(nCtl) // notch 1 linear gain at centre
  const n2g = new Float64Array(nCtl)
  const n2G = new Float64Array(nCtl)
  const bkS = new Float64Array(nCtl) // back shelf linear gain
  const bkB = new Float64Array(nCtl) // back bell linear gain
  const airG = new Float64Array(nCtl) // air one-pole G
  const airW = new Float64Array(nCtl) // air blend weight
  const bkD = natural ? new Float64Array(nCtl) : null // rear dip linear gain (natural model)
  const dipLive = natural && REAR_DIP_HZ < 0.42 * sr

  const sinS = Math.sin(100 * DEG)
  const cosS = Math.cos(100 * DEG)
  const alphaFront = shadowAlpha(100 * DEG)
  const r0sq = 0.0625
  const nyqLim = 0.42 * sr
  let minCommon = Infinity
  let maxCommon = 0

  for (let k = 0; k < nCtl; k++) {
    const t = (k * CTRL) / sr
    let p = fn(t)
    if (!p || typeof p !== 'object') p = {}
    const az = num(p.az, 0) * DEG
    let elD = num(p.el, 0)
    if (elD > 90) elD = 90
    if (elD < -90) elD = -90
    const el = elD * DEG
    let dist = num(p.dist, 1)
    if (dist < 0) dist = 0
    if (dist > 1000) dist = 1000
    const ce = Math.cos(el)
    const x = ce * Math.sin(az) // right
    const y = ce * Math.cos(az) // front
    const z = Math.sin(el) // up

    // Interaural delays from the interaural axis (+-x).
    const thR = Math.acos(Math.max(-1, Math.min(1, x)))
    const thL = Math.acos(Math.max(-1, Math.min(1, -x)))
    const common = doppler ? (dist / C) * sr : 0
    if (common < minCommon) minCommon = common
    if (common > maxCommon) maxCommon = common
    dR[k] = common + wrapDelay(thR, a) * sr
    dL[k] = common + wrapDelay(thL, a) * sr

    // Head shadow from axes 100 degrees round from the nose (natural rear
    // model: a source behind uses its mirror image in front).
    const yS = natural && y < 0 ? -y : y
    const cR = Math.max(-1, Math.min(1, x * sinS + yS * cosS))
    const cL = Math.max(-1, Math.min(1, -x * sinS + yS * cosS))
    aR[k] = shadowAlpha(Math.acos(cR)) / alphaFront
    aL[k] = shadowAlpha(Math.acos(cL)) / alphaFront

    // Distance gains per ear.
    let dr, dl
    if (nearField) {
      const px = x * dist, py = y * dist, pz = z * dist
      dr = Math.sqrt((px - a) * (px - a) + py * py + pz * pz)
      dl = Math.sqrt((px + a) * (px + a) + py * py + pz * pz)
    } else {
      dr = dl = dist
    }
    gR[k] = Math.sqrt((1 + r0sq) / (dr * dr + r0sq))
    gL[k] = Math.sqrt((1 + r0sq) / (dl * dl + r0sq))

    // Pinna notches by elevation.
    let f1 = 7500 * Math.pow(2, elD / 75)
    if (f1 < 4000) f1 = 4000
    if (f1 > 14000) f1 = 14000
    let depth = -15 + 12 * Math.max(0, elD / 90)
    const f2 = f1 * 1.55
    const fade1 = f1 < nyqLim ? 1 : 0
    const fade2 = f2 < nyqLim ? 1 : 0
    n1g[k] = Math.tan((Math.PI * Math.min(f1, nyqLim)) / sr)
    n2g[k] = Math.tan((Math.PI * Math.min(f2, nyqLim)) / sr)
    n1G[k] = Math.pow(10, (depth * fade1) / 20)
    n2G[k] = Math.pow(10, (depth * 0.6 * fade2) / 20)

    // Behind cue.
    const back = y < 0 ? -y : 0
    bkS[k] = Math.pow(10, ((natural ? REAR_SHELF_DB : -9) * back) / 20)
    bkB[k] = Math.pow(10, (2 * back) / 20)
    if (natural) bkD[k] = dipLive ? Math.pow(10, (REAR_DIP_DB * back) / 20) : 1

    // Air absorption.
    if (air) {
      const fcRaw = 43300 / Math.sqrt(Math.max(dist, 1e-3))
      const fc = Math.min(fcRaw, 0.45 * sr)
      const g = Math.tan((Math.PI * fc) / sr)
      airG[k] = g / (1 + g)
      airW[k] = fcRaw <= 0.45 * sr ? 1 : Math.pow((0.45 * sr) / fcRaw, 2)
    } else {
      airG[k] = 0.5
      airW[k] = 0
    }
  }
  if (!Number.isFinite(minCommon)) minCommon = 0
  for (let k = 0; k < nCtl; k++) {
    dL[k] -= minCommon
    dR[k] -= minCommon
  }

  // Smooth every track over the control points (forward one-pole).
  const smoothMs = Math.max(0, num(opts.smoothMs, 4))
  if (smoothMs > 0) {
    const ctlRate = sr / CTRL
    const cS = Math.exp(-1 / ((smoothMs / 1000) * ctlRate))
    const tracks = [dL, dR, gL, gR, aL, aR, n1g, n1G, n2g, n2G, bkS, bkB, airG, airW]
    if (bkD) tracks.push(bkD)
    for (let t = 0; t < tracks.length; t++) {
      const tr = tracks[t]
      let s = tr[0]
      for (let k = 1; k < nCtl; k++) {
        s = tr[k] + (s - tr[k]) * cS
        tr[k] = s
      }
    }
  }

  const maxDelay = maxCommon - minCommon + ((a / C) * (1 + Math.PI / 2)) * sr + 8
  const extra = opts.tail ? Math.ceil(maxDelay) : 0
  const outLen = n + extra
  const L = new Float32Array(outLen)
  const R = new Float32Array(outLen)
  if (outLen === 0) return { L, R }
  const line = new DelayLine(Math.ceil(maxDelay) + 8)

  // Head shadow bilinear pieces: b0 = p0 + alpha q0, b1 = p1 + alpha q1, a1 fixed.
  const tau = a / (2 * C)
  const K2 = 2 * sr
  const den = 1 + tau * K2
  const hp0 = 1 / den
  const hq0 = (tau * K2) / den
  const hp1 = 1 / den
  const hq1 = -(tau * K2) / den
  const ha1 = (1 - tau * K2) / den

  // Fixed back-bell tuning (1.1 kHz, Q 1.2) and back shelf one-pole at 2.5 kHz.
  const kN = 1 / 4 // notch Q 4
  const gBell = Math.tan((Math.PI * Math.min(1100, 0.45 * sr)) / sr)
  const kBell = 1 / 1.2
  const bA1 = 1 / (1 + gBell * (gBell + kBell))
  const bA2 = gBell * bA1
  const bA3 = gBell * bA2
  const gSh = Math.tan((Math.PI * Math.min(2500, 0.45 * sr)) / sr)
  const GSh = gSh / (1 + gSh)
  // Natural rear model: the 6-10 kHz rear dip, a fixed bell (TPT SVF).
  const gDip = Math.tan((Math.PI * Math.min(REAR_DIP_HZ, 0.42 * sr)) / sr)
  const kDip = 1 / REAR_DIP_Q
  const dA1 = 1 / (1 + gDip * (gDip + kDip))
  const dA2 = gDip * dA1
  const dA3 = gDip * dA2

  // Filter states.
  let n1a = 0, n1b = 0, n2a = 0, n2b = 0, ba = 0, bb = 0, shS = 0, airS = 0, da = 0, db = 0
  let xL1 = 0, yL1 = 0, xR1 = 0, yR1 = 0

  // Walk control segment by segment: every track starts at its control value
  // and steps by a constant per-sample increment to the next one.
  const inv = 1 / CTRL
  for (let seg = 0; seg * CTRL < outLen; seg++) {
    const k0 = seg < nCtl ? seg : nCtl - 1
    const k1 = seg + 1 < nCtl ? seg + 1 : nCtl - 1
    let vdL = dL[k0], vdR = dR[k0], vgL = gL[k0], vgR = gR[k0], vaL = aL[k0], vaR = aR[k0]
    let vn1g = n1g[k0], vn1G = n1G[k0], vn2g = n2g[k0], vn2G = n2G[k0]
    let vbkS = bkS[k0], vbkB = bkB[k0], vairG = airG[k0], vairW = airW[k0]
    let vbkD = bkD ? bkD[k0] : 1
    const sbkD = bkD ? (bkD[k1] - vbkD) * inv : 0
    const sdL = (dL[k1] - vdL) * inv, sdR = (dR[k1] - vdR) * inv
    const sgL = (gL[k1] - vgL) * inv, sgR = (gR[k1] - vgR) * inv
    const saL = (aL[k1] - vaL) * inv, saR = (aR[k1] - vaR) * inv
    const sn1g = (n1g[k1] - vn1g) * inv, sn1G = (n1G[k1] - vn1G) * inv
    const sn2g = (n2g[k1] - vn2g) * inv, sn2G = (n2G[k1] - vn2G) * inv
    const sbkS = (bkS[k1] - vbkS) * inv, sbkB = (bkB[k1] - vbkB) * inv
    const sairG = (airG[k1] - vairG) * inv, sairW = (airW[k1] - vairW) * inv
    const iEnd = Math.min(outLen, (seg + 1) * CTRL)
    for (let i = seg * CTRL; i < iEnd; i++) {
      let x = i < n ? mono[i] : 0
      if (!(x > -1e30 && x < 1e30)) x = 0

      // Pinna notch 1 (bell cut), TPT state-variable filter.
      let g = vn1g
      let c1 = 1 / (1 + g * (g + kN))
      let c2 = g * c1
      let c3 = g * c2
      let v3 = x - n1b
      let v1 = c1 * n1a + c2 * v3
      let v2 = n1b + c2 * n1a + c3 * v3
      n1a = 2 * v1 - n1a
      n1b = 2 * v2 - n1b
      if (n1a < TINY && n1a > -TINY) n1a = 0
      if (n1b < TINY && n1b > -TINY) n1b = 0
      x += (vn1G - 1) * kN * v1

      // Pinna notch 2.
      g = vn2g
      c1 = 1 / (1 + g * (g + kN))
      c2 = g * c1
      c3 = g * c2
      v3 = x - n2b
      v1 = c1 * n2a + c2 * v3
      v2 = n2b + c2 * n2a + c3 * v3
      n2a = 2 * v1 - n2a
      n2b = 2 * v2 - n2b
      if (n2a < TINY && n2a > -TINY) n2a = 0
      if (n2b < TINY && n2b > -TINY) n2b = 0
      x += (vn2G - 1) * kN * v1

      // Back bell at 1.1 kHz.
      v3 = x - bb
      v1 = bA1 * ba + bA2 * v3
      v2 = bb + bA2 * ba + bA3 * v3
      ba = 2 * v1 - ba
      bb = 2 * v2 - bb
      if (ba < TINY && ba > -TINY) ba = 0
      if (bb < TINY && bb > -TINY) bb = 0
      x += (vbkB - 1) * kBell * v1

      // Back shelf: x + (G - 1) * highpass.
      let v = (x - shS) * GSh
      let lp = v + shS
      shS = lp + v
      if (shS < TINY && shS > -TINY) shS = 0
      x += (vbkS - 1) * (x - lp)

      // Rear dip (natural rear model only).
      if (dipLive) {
        v3 = x - db
        v1 = dA1 * da + dA2 * v3
        v2 = db + dA2 * da + dA3 * v3
        da = 2 * v1 - da
        db = 2 * v2 - db
        if (da < TINY && da > -TINY) da = 0
        if (db < TINY && db > -TINY) db = 0
        x += (vbkD - 1) * kDip * v1
        vbkD += sbkD
      }

      // Air absorption, blended out for near sources.
      v = (x - airS) * vairG
      lp = v + airS
      airS = lp + v
      if (airS < TINY && airS > -TINY) airS = 0
      x += vairW * (lp - x)

      line.write(x)
      const sl = line.read(vdL)
      const sr2 = line.read(vdR)

      // Head shadow per ear (coefficients linear in alpha).
      let yl = (hp0 + vaL * hq0) * sl + (hp1 + vaL * hq1) * xL1 - ha1 * yL1
      xL1 = sl
      if (yl < TINY && yl > -TINY) yl = 0
      yL1 = yl
      let yr = (hp0 + vaR * hq0) * sr2 + (hp1 + vaR * hq1) * xR1 - ha1 * yR1
      xR1 = sr2
      if (yr < TINY && yr > -TINY) yr = 0
      yR1 = yr

      L[i] = yl * vgL
      R[i] = yr * vgR

      vdL += sdL; vdR += sdR; vgL += sgL; vgR += sgR; vaL += saL; vaR += saR
      vn1g += sn1g; vn1G += sn1G; vn2g += sn2g; vn2G += sn2G
      vbkS += sbkS; vbkB += sbkB; vairG += sairG; vairW += sairW
    }
  }
  return { L, R }
}

/** Turn a Cartesian path (t) => { x, y, z } (metres; x right, y ahead, z up) into an az/el/dist path. */
export function cartesianPath(fnXYZ) {
  return (t) => {
    const p = fnXYZ(t) || {}
    const x = num(p.x, 0), y = num(p.y, 1), z = num(p.z, 0)
    const h = Math.sqrt(x * x + y * y)
    const dist = Math.sqrt(h * h + z * z)
    return { az: Math.atan2(x, y) / DEG, el: Math.atan2(z, h) / DEG, dist }
  }
}

/**
 * A circling path: one turn every `period` seconds (negative = anticlockwise
 * seen from above), at distance `dist`, elevation `el`, starting at `startAz`.
 */
export function circlePath({ period = 4, dist = 1.5, el = 0, startAz = 0 } = {}) {
  const p = Number(period) || 4
  return (t) => ({ az: startAz + (360 * t) / p, el, dist })
}

/**
 * A straight fly-by: the source travels along a line `offset` metres in front
 * of the listener (x from -halfLength to +halfLength) at `speed` m/s,
 * passing the nose at time `passAt` seconds. Height `z` metres.
 */
export function flyByPath({ speed = 15, offset = 3, passAt = 2, z = 0 } = {}) {
  return cartesianPath((t) => ({ x: speed * (t - passAt), y: offset, z }))
}
