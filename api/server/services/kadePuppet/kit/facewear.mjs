// Facial hair and face marks. Facial hair draws in the `facialHair` layer (after the
// mouth, before front hair) and must follow the jaw: every shape is built with
// morphable() from ctx.mouthAt(p), so a beard drops with the jaw, a mustache rides the
// upper lip, and nothing ever covers the open mouth interior.
//
// Face-group parallax: the `face` group slides 21 px per unit of head.yaw and 15 px per
// unit of head.pitch relative to the head outline (kit.mjs). Points that must stay glued
// to the head outline (beard edges, sideburns) carry head.yaw / head.pitch morphs that
// cancel that slide; points glued to the mouth carry the mouth morphs. Points under the
// nose follow the nose group's own extra slide (9 px yaw, 4 px pitch).
import { ellipse, shade, compound, closedSpline, openSpline, closedMixed, taper, mix, lerp, lerpPt, seeded, luminance } from './geom.mjs';
import { morphable } from './kit.mjs';

const FACE_TX = 21;
const FACE_TY = 15;
const NOSE_TX = 9;
const NOSE_TY = 4;

const MOUTH_CH = [
  ['mouth.open', { open: 1 }],
  ['mouth.smile', { smile: 1 }],
  ['mouth.smile', { smile: -1 }, true],
  ['mouth.wide', { wide: 1 }],
  ['mouth.round', { round: 1 }],
  ['mouth.press', { press: 1 }],
];
const HEAD_CH = [
  ['head.yaw', { turn: 1 }],
  ['head.yaw', { turn: -1 }, true],
  ['head.pitch', { pitch: 1 }],
  ['head.pitch', { pitch: -1 }, true],
];
const ALL_CH = [...MOUTH_CH, ...HEAD_CH];

// morphable() plus pruning of targets that do not move anything.
function build(fn, channels = ALL_CH) {
  const r = morphable(fn, {}, channels);
  const same = (a, b) => a.every((c, i) => c.v.every((v, j) => Math.abs(v - b[i].v[j]) < 0.05));
  r.m = r.m.filter((t) => !same(t.d, r.d));
  return r;
}

// ---------------- geometry helpers ----------------
function bez(a, c1, c2, b, t) {
  const u = 1 - t;
  const k0 = u * u * u;
  const k1 = 3 * u * u * t;
  const k2 = 3 * u * t * t;
  const k3 = t * t * t;
  return [k0 * a[0] + k1 * c1[0] + k2 * c2[0] + k3 * b[0], k0 * a[1] + k1 * c1[1] + k2 * c2[1] + k3 * b[1]];
}

// Point on segment i (points[i] -> points[i+1]) of a closedMixed / closedSpline ring.
function segAt(points, i, t) {
  const n = points.length;
  const k = 1 / 6;
  const p0 = points[(i - 1 + n) % n];
  const p1 = points[i % n];
  const p2 = points[(i + 1) % n];
  const p3 = points[(i + 2) % n];
  const c1 = p1[2] ? [p1[0] + (p2[0] - p1[0]) / 3, p1[1] + (p2[1] - p1[1]) / 3] : [p1[0] + (p2[0] - p0[0]) * k, p1[1] + (p2[1] - p0[1]) * k];
  const c2 = p2[2] ? [p2[0] - (p2[0] - p1[0]) / 3, p2[1] - (p2[1] - p1[1]) / 3] : [p2[0] - (p3[0] - p1[0]) * k, p2[1] - (p3[1] - p1[1]) * k];
  return bez(p1, c1, c2, p2, t);
}

function along(points, first, last, s) {
  const i = Math.max(first, Math.min(last - 1, first + Math.floor(s)));
  return segAt(points, i, s - (i - first));
}

// The head outline exactly as kit.mjs draws it (headPoints), so beards can hug it.
function headRing(f, CX, turn, jaw) {
  const { W, cy, top, chin, hs } = f;
  const H = chin - top;
  const half = [
    [0, top, 0],
    [W * 0.6 * hs.crown, top + H * 0.045, 0.05],
    [W * 0.94 * hs.crown, top + H * 0.22, 0.15],
    [W * hs.cheek, cy + H * 0.02, 0.3],
    [W * 0.95 * hs.cheek, cy + H * 0.19, 0.55],
    [W * 0.79 * hs.jaw, cy + H * 0.34 + jaw * 9, 0.8],
    [W * 0.44 * hs.chinW + 6, chin - H * 0.035 + jaw * 15, 1],
    [0, chin + jaw * 17, 1],
  ];
  const right = half.map(([x, y, d]) => [CX + x * (1 - 0.06 * turn) + turn * d * 15, y]);
  const left = half.slice(1, -1).reverse().map(([x, y, d]) => [CX - x * (1 + 0.06 * turn) + turn * d * 15, y]);
  return [...right, ...left];
}

// u runs down one side of the outline: -1 temple, 0 cheekbone, 1 low cheek, 2 jaw
// corner, 3 chin side, 4 chin bottom. side +1 = viewer's right.
function ringPt(ring, side, u) {
  if (side > 0) {
    const s = Math.min(6, Math.max(2, 3 + Math.floor(u)));
    return segAt(ring, s, u + 3 - s);
  }
  const v = 4 - u;
  const s = Math.min(11, Math.max(7, 7 + Math.floor(v)));
  return segAt(ring, s, v + 7 - s);
}

function rig(ctx) {
  const { f, CX, r } = ctx;
  const nk = 0.85 + 0.35 * (r.nose?.size ?? 0.5);
  const nWide = r.nose?.shape === 'wide' ? 1.3 : r.nose?.shape === 'pointed' ? 0.8 : 1;
  const rg = {
    CX, f, nk,
    noseBot: f.noseY + 9 * nk,
    nostril: 25 * nk * nWide,
    g: (p) => ctx.mouthAt(p),
    // head-outline point (face-group coordinates), pushed out by `puff` along the normal
    H(p, side, u, puff = 0) {
      const turn = p.turn || 0;
      const pitch = p.pitch || 0;
      const ring = headRing(f, CX, turn, p.open || 0);
      const q = ringPt(ring, side, u);
      const a = ringPt(ring, side, u - 0.02);
      const c = ringPt(ring, side, u + 0.02);
      let nx = c[1] - a[1];
      let ny = -(c[0] - a[0]);
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;
      if (nx * (q[0] - CX) + ny * (q[1] - (f.cy - 30)) < 0) { nx = -nx; ny = -ny; }
      return [q[0] + nx * puff - FACE_TX * turn, q[1] + ny * puff - FACE_TY * pitch];
    },
    // nose-glued point (dy measured from noseY)
    N(p, dx, dy) {
      return [CX + dx + NOSE_TX * (p.turn || 0), f.noseY + dy + NOSE_TY * (p.pitch || 0)];
    },
    // upper lip outer curve, s 0 (left corner) .. 3 (centre) .. 6 (right corner)
    lipTop(g, s) {
      const ring = [[...g.CL, true], ...g.upperOuter, [...g.CR, true], ...g.upperEdge.slice().reverse()];
      return along(ring, 0, 6, s);
    },
    // top edge of the mouth opening, s 0 (left corner) .. 2 (centre) .. 4 (right corner)
    edgeTop(g, s) {
      const ring = [[...g.CL, true], ...g.upperEdge, [...g.CR, true], ...g.lowerEdge];
      return along(ring, 0, 4, s);
    },
    // lower lip outer curve, s 0 (right corner) .. 2 (centre) .. 4 (left corner)
    lipBot(g, s) {
      const ring = [[...g.CL, true], ...g.lowerEdge.slice().reverse(), [...g.CR, true], ...g.lowerOuter];
      return along(ring, 4, 8, s);
    },
  };
  return rg;
}

const add2 = (a, dx, dy) => [a[0] + dx, a[1] + dy];
const sharp = (a) => [a[0], a[1], true];
const smooth = (a) => [a[0], a[1]];

function hairPaint(ctx, id) {
  const { b, CX, f, colors } = ctx;
  const col = colors.facialHair;
  b.grad(id, {
    kind: 'linear', start: [CX - 150, f.noseY - 40], end: [CX + 160, f.chin + 70],
    stops: [{ at: 0, color: shade(col, 0.16) }, { at: 0.5, color: col }, { at: 1, color: shade(col, -0.24) }],
  });
  return { fill: id, line: shade(col, -0.42), dark: shade(col, -0.32), shine: shade(col, 0.45), col };
}

// ---------------- mustaches ----------------
// cfg: cover (how much of the upper lip the bottom edge hides, 0..0.8), thick, tipOut,
// tipDrop, endH (height of the end), gap (space under the nose), notch.
function stachePts(rg, p, c) {
  const g = rg.g(p);
  const lt = (s) => rg.lipTop(g, s);
  const ed = (s) => rg.edgeTop(g, s);
  const top = rg.N(p, 0, rg.noseBot - rg.f.noseY + (c.gap ?? 3));
  const minY = (y, lim) => Math.max(y, lim);
  const half = (sd) => {
    const sT = (s) => (sd > 0 ? s : 6 - s);
    const sE = (s) => (sd > 0 ? s : 4 - s);
    const C = sd > 0 ? g.CR : g.CL;
    const b1 = lerpPt(lt(sT(3.9)), ed(sE(2.5)), c.cover);
    const b2 = lerpPt(lt(sT(5)), ed(sE(3.2)), c.cover * 0.85);
    const b3 = [C[0] + sd * 2, C[1] - 2.5];
    const tip = [C[0] + sd * c.tipOut, C[1] + c.tipDrop, true];
    const t3 = [C[0] + sd * c.tipOut * 0.62, minY(C[1] - c.endH, top[1] + 6)];
    const t2 = [b2[0] + sd * 3, minY(b2[1] - c.thick * 0.86, top[1] + 3)];
    const t1 = [lerp(b1[0], top[0] + sd * 14, 0.4), minY(b1[1] - c.thick, top[1] + 1)];
    return { bot: [b1, b2, b3], tip, top: [t3, t2, t1] };
  };
  const R = half(1);
  const L = half(-1);
  const bc = lerpPt(lt(3), ed(2), c.cover);
  bc[1] -= c.notch ?? 2;
  const tc = [lerp(bc[0], top[0], 0.7), minY(bc[1] - c.thick, top[1])];
  return [bc, ...R.bot, R.tip, ...R.top, tc, ...L.top.slice().reverse(), L.tip, ...L.bot.slice().reverse()];
}

function addStache(ctx, rg, id, paint, cfg, strands = true) {
  const { b } = ctx;
  b.add({ id, g: 'face', ...build((p) => closedMixed(stachePts(rg, p, cfg))), fill: paint.fill, stroke: paint.line, sw: 2.6 });
  if (!strands) return;
  // a few combed strokes from the middle out toward the ends
  b.add({
    id: id + '-lines', g: 'face', ...build((p) => {
      const P = stachePts(rg, p, cfg);
      const bc = P[0];
      const tc = P[8];
      const out = [];
      for (const sd of [1, -1]) {
        const tip = sd > 0 ? P[4] : P[12];
        const t3 = sd > 0 ? P[5] : P[11];
        const b2 = sd > 0 ? P[2] : P[14];
        for (const k of [0.3, 0.62]) {
          const a = lerpPt(tc, bc, k);
          const m = lerpPt(lerpPt(t3, b2, k), lerpPt(tc, bc, k), 0.45);
          const e = lerpPt(lerpPt(t3, tip, k), b2, 0.25);
          out.push(openSpline([[a[0] + sd * 7, a[1]], m, e]));
        }
      }
      return compound(...out);
    }), fill: 'none', stroke: paint.dark, sw: 1.8, op: 0.4,
  });
}

// ---------------- beard masses ----------------
// The beard is a U: an outer edge along the head outline from sideburn to sideburn, and
// an inner edge from one sideburn down the cheek, under the lower lip and back up.
function beardEdges(rg, p, c) {
  const g = rg.g(p);
  const outer = (sd) => c.puffs.map(([u, puff]) => rg.H(p, sd, u, puff));
  const inner = (sd) => {
    const C = sd > 0 ? g.CR : g.CL;
    const lb = (s) => rg.lipBot(g, sd > 0 ? s : 4 - s);
    const sb = rg.H(p, sd, c.puffs[0][0] + 0.18, -c.burn);
    const cheekHead = rg.H(p, sd, c.cheekU, -c.cheekIn);
    const cheekMouth = [C[0] + sd * c.cheekOut[0], C[1] + c.cheekOut[1]];
    return [
      sharp(sb),
      smooth(lerpPt(cheekHead, cheekMouth, c.cheekW)),
      [C[0] + sd * c.cornerUp[0], C[1] + c.cornerUp[1]],
      [C[0] + sd * c.corner[0], C[1] + c.corner[1]],
      add2(lb(0.55), sd * 3, c.gap + 1),
      add2(lb(1.25), 0, c.gap),
    ];
  };
  const chin = rg.H(p, 1, 4, c.chinPuff);
  const lipC = add2(rg.lipBot(g, 2), 0, c.gap);
  return { outerR: outer(1), outerL: outer(-1), chin, innerR: inner(1), innerL: inner(-1), lipC };
}

function beardPts(rg, p, c) {
  const E = beardEdges(rg, p, c);
  const oR = E.outerR.map(smooth);
  oR[0] = sharp(oR[0]);
  const oL = E.outerL.map(smooth);
  oL[0] = sharp(oL[0]);
  // ring: right sideburn top -> down right jaw -> chin -> up left jaw -> left sideburn
  //       -> inner left (cheek, corner, under lip) -> inner right back up
  return [
    ...oR, E.chin, ...oL.slice().reverse(),
    ...E.innerL, E.lipC, ...E.innerR.slice().reverse(),
  ];
}

// interior point of the beard: s in [-1, 1] across (0 = chin), t from outer (0) to inner (1)
function beardField(rg, p, c) {
  const E = beardEdges(rg, p, c);
  const outerList = [...E.outerL, E.chin, ...E.outerR.slice().reverse()]; // left top -> chin -> right top
  const innerList = [...E.innerL, E.lipC, ...E.innerR.slice().reverse()];
  const pick = (list, s) => {
    const x = ((s + 1) / 2) * (list.length - 1);
    const i = Math.max(0, Math.min(list.length - 2, Math.floor(x)));
    return lerpPt(list[i], list[i + 1], x - i);
  };
  return (s, t) => lerpPt(pick(outerList, s), pick(innerList, s), t);
}

function strandSet(rg, c, rows) {
  return (p) => {
    const F = beardField(rg, p, c);
    return compound(...rows.map(([s0, s1, t0, t1]) => openSpline([F(s0, t0), F(lerp(s0, s1, 0.5), lerp(t0, t1, 0.5)), F(s1, t1)])));
  };
}

function addBeard(ctx, rg, id, paint, cfg, texture) {
  const { b } = ctx;
  b.add({ id: id + '-mass', g: 'face', ...build((p) => closedMixed(beardPts(rg, p, cfg))), fill: paint.fill, stroke: paint.line, sw: 2.8 });
  if (texture) {
    b.add({ id: id + '-dark', g: 'face', ...build(strandSet(rg, cfg, texture.dark)), fill: 'none', stroke: paint.dark, sw: 2.2, op: 0.42 });
    b.add({ id: id + '-shine', g: 'face', ...build(strandSet(rg, cfg, texture.light)), fill: 'none', stroke: paint.shine, sw: 2, op: 0.24 });
  }
}

// ---------------- stipple (stubble) ----------------
// tiny round-capped dashes: 2 commands per dot, so ~35 dots per shape
function dots(list) {
  const d = [];
  for (const [x, y] of list) {
    d.push({ op: 'M', v: [Math.round(x * 10) / 10, Math.round(y * 10) / 10] });
    d.push({ op: 'L', v: [Math.round((x + 0.7) * 10) / 10, Math.round((y + 0.4) * 10) / 10] });
  }
  return d;
}

// ---------------- facial hair items ----------------
const FULL = {
  puffs: [[0.0, 2], [0.5, 4], [1.1, 9], [1.75, 17], [2.4, 27], [3.1, 37], [3.6, 42]],
  chinPuff: 46, burn: 22, cheekU: 0.95, cheekIn: 30, cheekOut: [36, -28], cheekW: 0.5,
  cornerUp: [17, -12], corner: [9, 3], gap: 4,
};
const SHORT = {
  puffs: [[0.0, 1.5], [0.5, 2.5], [1.1, 4], [1.75, 6], [2.4, 8], [3.1, 10], [3.6, 11]],
  chinPuff: 12, burn: 20, cheekU: 0.95, cheekIn: 28, cheekOut: [32, -24], cheekW: 0.5,
  cornerUp: [14, -10], corner: [8, 3], gap: 4,
};
const STUBBLE = {
  puffs: [[0.05, -1], [0.55, -1], [1.1, -1], [1.75, -1.5], [2.4, -1.5], [3.1, -1.5], [3.6, -1.5]],
  chinPuff: -1.5, burn: 20, cheekU: 0.95, cheekIn: 26, cheekOut: [30, -24], cheekW: 0.5,
  cornerUp: [12, -8], corner: [7, 3], gap: 4,
};

const CLASSIC = { cover: 0.28, thick: 22, tipOut: 13, tipDrop: 7, endH: 10, gap: 3, notch: 2 };

export const FACIAL_HAIR = {
  none: { name: 'None', note: '' },

  stubble: {
    name: 'Stubble', note: 'a shadow of stubble along the jaw and upper lip',
    facialHair(ctx) {
      const { b, colors } = ctx;
      const rg = rig(ctx);
      const tone = mix(colors.facialHair, colors.skinDark, 0.25);
      // soft shadow: U along the jaw plus the upper-lip band
      const lip = (p) => {
        const g = rg.g(p);
        const top = rg.N(p, 0, rg.noseBot - rg.f.noseY + 2);
        const pts = [];
        for (const s of [0.6, 1.5, 2.3, 3, 3.7, 4.5, 5.4]) pts.push(add2(rg.lipTop(g, s), 0, -2.5));
        const R = [g.CR[0] + 6, g.CR[1] - 4];
        const L = [g.CL[0] - 6, g.CL[1] - 4];
        return closedSpline([L, ...pts, R, [lerp(g.CR[0], top[0], 0.3) + 8, lerp(g.CR[1], top[1], 0.55)], [top[0] + 18, top[1] + 1], [top[0], top[1] + 3], [top[0] - 18, top[1] + 1], [lerp(g.CL[0], top[0], 0.3) - 8, lerp(g.CL[1], top[1], 0.55)]]);
      };
      const shadowFn = (p) => compound(closedMixed(beardPts(rg, p, STUBBLE)), lip(p));
      const { f, CX } = ctx;
      b.grad('stubble-g', {
        kind: 'radial', center: [CX, f.mouthY + 16], radius: Math.max(200, (f.chin - f.eyeY) * 1.3),
        stops: [{ at: 0, color: tone, opacity: 0.3 }, { at: 0.5, color: tone, opacity: 0.24 }, { at: 0.8, color: tone, opacity: 0.12 }, { at: 1, color: tone, opacity: 0.02 }],
      });
      b.add({ id: 'stubble-shadow', g: 'face', ...build(shadowFn), fill: 'stubble-g' });
      // stipple dots, deterministic
      const rnd = seeded('stubble');
      const jaw = [];
      for (let i = 0; i < 31; i++) {
        for (let j = 0; j < 4; j++) {
          const s = -0.96 + (1.92 * i) / 30 + (rnd() - 0.5) * 0.04;
          const t = 0.1 + j * 0.24 + (rnd() - 0.5) * 0.12;
          jaw.push([s, t]);
        }
      }
      const band = [];
      for (let i = 0; i < 13; i++) for (let j = 0; j < 2; j++) band.push([0.7 + (i * 4.6) / 12 + (rnd() - 0.5) * 0.15, 0.3 + j * 0.42 + (rnd() - 0.5) * 0.12]);
      const field = (p) => beardField(rg, p, STUBBLE);
      const bandPt = (p, s, t) => {
        const g = rg.g(p);
        const lo = add2(rg.lipTop(g, s), 0, -3);
        const top = rg.N(p, (lo[0] - rg.CX) * 0.9, rg.noseBot - rg.f.noseY + 5 + Math.abs(lo[0] - rg.CX) * 0.08);
        return lerpPt(lo, top, t);
      };
      const chunks = [];
      for (let k = 0; k < jaw.length; k += 31) chunks.push(jaw.slice(k, k + 31));
      chunks.forEach((chunk, n) => {
        b.add({
          id: 'stubble-dots' + n, g: 'face', ...build((p) => { const F = field(p); return dots(chunk.map(([s, t]) => F(s, t))); }),
          fill: 'none', stroke: tone, sw: n % 2 ? 2.5 : 2.1, op: n === 0 || n === 3 ? 0.38 : 0.55,
        });
      });
      b.add({ id: 'stubble-lipdots', g: 'face', ...build((p) => dots(band.map(([s, t]) => bandPt(p, s, t)))), fill: 'none', stroke: tone, sw: 2.3, op: 0.55 });
    },
  },

  mustache: {
    name: 'Mustache', note: 'a full, neatly trimmed mustache',
    facialHair(ctx) {
      const rg = rig(ctx);
      addStache(ctx, rg, 'mustache', hairPaint(ctx, 'mustache-g'), CLASSIC);
    },
  },

  handlebar: {
    name: 'Handlebar mustache', note: 'a handlebar mustache with curled-up ends',
    facialHair(ctx) {
      const { b } = ctx;
      const rg = rig(ctx);
      const paint = hairPaint(ctx, 'handlebar-g');
      const line = (p) => {
        const g = rg.g(p);
        const lt = (s) => rg.lipTop(g, s);
        const top = rg.N(p, 0, rg.noseBot - rg.f.noseY + 3);
        const half = (sd) => {
          const sT = (s) => (sd > 0 ? s : 6 - s);
          const C = sd > 0 ? g.CR : g.CL;
          const a = add2(lt(sT(3.8)), 0, -7);
          const b2 = add2(lt(sT(4.7)), 0, -6);
          return [
            [a[0], Math.max(a[1], top[1] + 7)],
            [b2[0], Math.max(b2[1], top[1] + 8)],
            [C[0] + sd * 6, C[1] - 9],
            [C[0] + sd * 20, C[1] - 13],
            [C[0] + sd * 32, C[1] - 22],
            [C[0] + sd * 37, C[1] - 35],
            [C[0] + sd * 31, C[1] - 45],
            [C[0] + sd * 21, C[1] - 43],
            [C[0] + sd * 19, C[1] - 34],
          ];
        };
        const R = half(1);
        const L = half(-1);
        const mid = add2(lt(3), 0, -7);
        const c = [mid[0], Math.max(mid[1], top[1] + 7)];
        return [...L.slice().reverse(), c, ...R];
      };
      const W = [1.2, 2.6, 4.2, 6, 8, 10.5, 13, 14, 15, 14, 15, 14, 13, 10.5, 8, 6, 4.2, 2.6, 1.2];
      b.add({ id: 'handlebar-body', g: 'face', ...build((p) => taper(line(p), W)), fill: paint.fill, stroke: paint.line, sw: 2.4 });
      b.add({
        id: 'handlebar-shine', g: 'face', ...build((p) => {
          const P = line(p);
          return compound(openSpline([P[8], P[11], P[13]].map((q) => add2(q, 0, -2.5))), openSpline([P[10], P[7], P[5]].map((q) => add2(q, 0, -2.5))));
        }), fill: 'none', stroke: paint.shine, sw: 2, op: 0.35,
      });
    },
  },

  'pencil-mustache': {
    name: 'Pencil mustache', note: 'a thin pencil mustache just above the lip',
    facialHair(ctx) {
      const { b } = ctx;
      const rg = rig(ctx);
      const paint = hairPaint(ctx, 'pencil-mustache-g');
      const fn = (p) => {
        const g = rg.g(p);
        const seg = (sd) => {
          const sT = (s) => (sd > 0 ? s : 6 - s);
          const pts = [3.12, 3.7, 4.4, 5.1, 5.75].map((s) => add2(rg.lipTop(g, sT(s)), 0, -4.5));
          pts[pts.length - 1] = add2(pts[pts.length - 1], sd * 2, 0);
          return taper(pts, [2.6, 5.2, 5.6, 4.4, 1.4]);
        };
        return compound(seg(1), seg(-1));
      };
      b.add({ id: 'pencil-mustache-line', g: 'face', ...build(fn), fill: paint.dark, stroke: paint.line, sw: 1 });
    },
  },

  walrus: {
    name: 'Walrus mustache', note: 'a big, bushy walrus mustache that droops past the lips',
    facialHair(ctx) {
      const { b } = ctx;
      const rg = rig(ctx);
      const paint = hairPaint(ctx, 'walrus-g');
      const pts = (p) => {
        const g = rg.g(p);
        const ed = (s) => rg.edgeTop(g, s);
        const top = rg.N(p, 0, rg.noseBot - rg.f.noseY - 1);
        const half = (sd) => {
          const sE = (s) => (sd > 0 ? s : 4 - s);
          const C = sd > 0 ? g.CR : g.CL;
          const fringe = [];
          // bristle tips sit just above the mouth opening; recesses a little higher
          const marks = [2.35, 2.75, 3.15, 3.55];
          for (const s of marks) {
            const e = ed(sE(s));
            fringe.push([e[0] - sd * 3, e[1] - 6]);
            fringe.push([e[0] + sd * 2, e[1] - 2, true]);
          }
          return {
            fringe,
            outer: [
              [C[0] + sd * 5, C[1] - 1],
              [C[0] + sd * 11, C[1] + 12, true],
              [C[0] + sd * 17, C[1] + 6],
              [C[0] + sd * 25, C[1] + 20, true],
              [C[0] + sd * 34, C[1] + 3],
              [C[0] + sd * 31, C[1] - 14],
              [C[0] + sd * 19, Math.max(top[1] + 9, C[1] - 23)],
              [lerp(C[0], top[0], 0.55), Math.max(top[1] + 3, lerp(C[1], top[1], 0.93))],
            ],
          };
        };
        const R = half(1);
        const L = half(-1);
        const midE = ed(2);
        return [
          [midE[0], midE[1] - 2, true],
          ...R.fringe, ...R.outer,
          [top[0] + 12, top[1]], [top[0], top[1] + 3], [top[0] - 12, top[1]],
          ...L.outer.slice().reverse(), ...L.fringe.slice().reverse(),
        ];
      };
      b.add({ id: 'walrus-body', g: 'face', ...build((p) => closedMixed(pts(p))), fill: paint.fill, stroke: paint.line, sw: 2.6 });
      b.add({
        id: 'walrus-lines', g: 'face', ...build((p) => {
          const P = pts(p);
          const tc = P[18];
          const out = [];
          for (const [a, z] of [[2, 6], [4, 9], [6, 12], [8, 15], [34, 30], [32, 27], [30, 24], [28, 22]]) {
            const q = P[a];
            out.push(openSpline([lerpPt(tc, q, 0.25), lerpPt(lerpPt(tc, q, 0.6), P[z], 0.12), lerpPt(q, tc, 0.12)]));
          }
          return compound(...out);
        }), fill: 'none', stroke: paint.dark, sw: 1.8, op: 0.4,
      });
    },
  },

  goatee: {
    name: 'Goatee', note: 'a neat pointed goatee on the chin',
    facialHair(ctx) {
      const { b } = ctx;
      const rg = rig(ctx);
      const paint = hairPaint(ctx, 'goatee-g');
      const ring = (p) => {
        const g = rg.g(p);
        const lb = (s) => rg.lipBot(g, s);
        const tipH = rg.H(p, 1, 4, 25);
        const side = (sd) => {
          const s = (v) => (sd > 0 ? v : 4 - v);
          return [
            add2(lb(s(0.7)), sd * 2, 4),
            lerpPt(add2(lb(s(0.45)), sd * 10, 18), rg.H(p, sd, 2.95, -4), 0.5),
            rg.H(p, sd, 3.3, 7),
            lerpPt(rg.H(p, sd, 3.75, 16), tipH, 0.25),
          ];
        };
        const R = side(1);
        const L = side(-1);
        return [add2(lb(2), 0, 4.5), add2(lb(1.3), 0, 4.5), ...R, tipH, ...L.slice().reverse(), add2(lb(2.7), 0, 4.5)];
      };
      b.add({ id: 'goatee-tuft', g: 'face', ...build((p) => closedMixed(ring(p))), fill: paint.fill, stroke: paint.line, sw: 2.6 });
      b.add({
        id: 'goatee-lines', g: 'face', ...build((p) => {
          const P = ring(p);
          const tip = P[6];
          return compound(
            openSpline([lerpPt(P[0], P[3], 0.3), lerpPt(lerpPt(P[0], tip, 0.55), P[3], 0.25), lerpPt(tip, P[0], 0.12)]),
            openSpline([lerpPt(P[0], P[9], 0.3), lerpPt(lerpPt(P[0], tip, 0.55), P[9], 0.25), lerpPt(tip, P[0], 0.12)]),
            openSpline([lerpPt(P[0], tip, 0.2), lerpPt(P[0], tip, 0.55), lerpPt(P[0], tip, 0.85)]),
          );
        }), fill: 'none', stroke: paint.dark, sw: 1.8, op: 0.4,
      });
    },
  },

  'soul-patch': {
    name: 'Soul patch', note: 'a small soul patch just under the lower lip',
    facialHair(ctx) {
      const { b } = ctx;
      const rg = rig(ctx);
      const paint = hairPaint(ctx, 'soul-patch-g');
      const fn = (p) => {
        const g = rg.g(p);
        const lb = (s) => rg.lipBot(g, s);
        const topC = add2(lb(2), 0, 4);
        const chinY = rg.H(p, 1, 4, 0)[1];
        const h = Math.max(9, Math.min(24, chinY - 4 - topC[1]));
        const w = Math.max(11, g.hw * 0.29);
        const yR = add2(lb(1.5), 0, 4)[1];
        const yL = add2(lb(2.5), 0, 4)[1];
        return closedSpline([
          topC, [topC[0] + w * 0.62, yR + 0.5], [topC[0] + w, yR + 3], [topC[0] + w * 0.78, topC[1] + h * 0.42], [topC[0] + w * 0.32, topC[1] + h * 0.84],
          [topC[0], topC[1] + h], [topC[0] - w * 0.32, topC[1] + h * 0.84], [topC[0] - w * 0.78, topC[1] + h * 0.42], [topC[0] - w, yL + 3], [topC[0] - w * 0.62, yL + 0.5],
        ]);
      };
      b.add({ id: 'soul-patch-tuft', g: 'face', ...build(fn), fill: paint.fill, stroke: paint.line, sw: 2.2 });
      b.add({
        id: 'soul-patch-lines', g: 'face', ...build((p) => {
          const g = rg.g(p);
          const t = add2(rg.lipBot(g, 2), 0, 4);
          const chinY = rg.H(p, 1, 4, 0)[1];
          const h = Math.max(9, Math.min(24, chinY - 4 - t[1]));
          return compound(openSpline([[t[0] - 4, t[1] + h * 0.2], [t[0] - 3, t[1] + h * 0.55], [t[0] - 1, t[1] + h * 0.8]]), openSpline([[t[0] + 4, t[1] + h * 0.2], [t[0] + 3, t[1] + h * 0.55], [t[0] + 1, t[1] + h * 0.8]]));
        }), fill: 'none', stroke: paint.dark, sw: 1.6, op: 0.45,
      });
    },
  },

  'short-beard': {
    name: 'Short beard', note: 'a short, neatly trimmed beard and mustache',
    facialHair(ctx) {
      const { b } = ctx;
      const rg = rig(ctx);
      const paint = hairPaint(ctx, 'short-beard-g');
      addBeard(ctx, rg, 'short-beard', paint, SHORT, null);
      // fine stipple for a close-cropped texture
      const rnd = seeded('short-beard');
      const pick = [];
      for (let i = 0; i < 34; i++) pick.push([-0.92 + (1.84 * i) / 33 + (rnd() - 0.5) * 0.04, 0.2 + rnd() * 0.6]);
      b.add({ id: 'short-beard-grain', g: 'face', ...build((p) => { const F = beardField(rg, p, SHORT); return dots(pick.map(([s, t]) => F(s, t))); }), fill: 'none', stroke: paint.dark, sw: 2.2, op: 0.4 });
      addStache(ctx, rg, 'short-beard-stache', paint, { ...CLASSIC, thick: 19, tipOut: 16, tipDrop: 6, endH: 9, cover: 0.22 }, false);
    },
  },

  'full-beard': {
    name: 'Full beard', note: 'a full, bushy beard and mustache',
    facialHair(ctx) {
      const rg = rig(ctx);
      const paint = hairPaint(ctx, 'full-beard-g');
      const dark = [
        [-0.8, -0.74, 0.55, 0.12], [-0.55, -0.48, 0.7, 0.12], [-0.3, -0.22, 0.75, 0.1], [-0.08, -0.04, 0.8, 0.08],
        [0.08, 0.04, 0.8, 0.08], [0.3, 0.22, 0.75, 0.1], [0.55, 0.48, 0.7, 0.12], [0.8, 0.74, 0.55, 0.12],
      ];
      const light = [[-0.66, -0.6, 0.6, 0.2], [-0.4, -0.33, 0.62, 0.15], [-0.17, -0.12, 0.62, 0.15], [0.2, 0.15, 0.6, 0.2], [0.45, 0.38, 0.6, 0.18]];
      addBeard(ctx, rg, 'full-beard', paint, FULL, { dark, light });
      addStache(ctx, rg, 'full-beard-stache', paint, { cover: 0.34, thick: 24, tipOut: 20, tipDrop: 10, endH: 12, gap: 2, notch: 2 });
    },
  },

  'chin-strap': {
    name: 'Chin strap', note: 'a thin chin-strap beard that traces the jawline',
    facialHair(ctx) {
      const { b } = ctx;
      const rg = rig(ctx);
      const paint = hairPaint(ctx, 'chin-strap-g');
      const us = [-0.08, 0.5, 1.15, 1.8, 2.5, 3.1, 3.6];
      const fn = (p) => {
        const g = rg.g(p);
        const guard = (q, s) => {
          const lb = rg.lipBot(g, s);
          return [q[0], Math.max(q[1], lb[1] + 5)];
        };
        // the band slides outward toward the chin so it never reaches the open mouth
        const outer = [4, 4, 4, 5, 6, 8, 9];
        const inner = [-17, -15, -14, -13, -10, -6, -5];
        const outR = us.map((u, i) => rg.H(p, 1, u, outer[i]));
        const outL = us.map((u, i) => rg.H(p, -1, u, outer[i]));
        const inn = (sd) => us.map((u, i) => {
          const q = rg.H(p, sd, u, inner[i]);
          return u >= 3 ? guard(q, sd > 0 ? 0.9 : 3.1) : q;
        });
        const inR = inn(1);
        const inL = inn(-1);
        const chinO = rg.H(p, 1, 4, 10);
        const chinI = guard(rg.H(p, 1, 4, -4), 2);
        outR[0] = sharp(outR[0]);
        outL[0] = sharp(outL[0]);
        inR[0] = sharp(inR[0]);
        inL[0] = sharp(inL[0]);
        return closedMixed([...outR, chinO, ...outL.slice().reverse(), ...inL, chinI, ...inR.slice().reverse()]);
      };
      b.add({ id: 'chin-strap-band', g: 'face', ...build(fn), fill: paint.fill, stroke: paint.line, sw: 2.4 });
    },
  },

  'mutton-chops': {
    name: 'Mutton chops', note: 'big mutton-chop sideburns joined by a mustache',
    facialHair(ctx) {
      const { b } = ctx;
      const rg = rig(ctx);
      const paint = hairPaint(ctx, 'mutton-chops-g');
      const chop = (sd) => (p) => {
        const g = rg.g(p);
        const C = sd > 0 ? g.CR : g.CL;
        const at = (dx, dy) => [C[0] + sd * dx, C[1] + dy];
        const o = [[0.0, 2], [0.6, 4], [1.2, 8], [1.75, 11]].map(([u, puff]) => rg.H(p, sd, u, puff));
        o[0] = sharp(o[0]);
        return closedMixed([
          ...o,
          lerpPt(rg.H(p, sd, 2.2, 6), at(28, 12), 0.5),
          at(17, 8),
          at(10, 2),
          at(13, -8),
          lerpPt(rg.H(p, sd, 1.55, -40), at(26, -14), 0.5),
          rg.H(p, sd, 0.75, -30),
          sharp(rg.H(p, sd, 0.18, -22)),
        ]);
      };
      b.add({ id: 'mutton-chops-R', g: 'face', ...build(chop(1)), fill: paint.fill, stroke: paint.line, sw: 2.6 });
      b.add({ id: 'mutton-chops-L', g: 'face', ...build(chop(-1)), fill: paint.fill, stroke: paint.line, sw: 2.6 });
      addStache(ctx, rg, 'mutton-chops-stache', paint, { cover: 0.28, thick: 21, tipOut: 18, tipDrop: 6, endH: 12, gap: 3, notch: 2 });
    },
  },
};

// ---------------- face marks ----------------
function eyeSize(ctx) {
  const { r } = ctx;
  const shapes = { round: [0.8, 1], almond: [0.62, 1], doe: [0.9, 1.12], hooded: [0.66, 1], upturned: [0.62, 1], downturned: [0.66, 1], narrow: [0.46, 1], button: [1, 1] };
  const [h, size] = shapes[r.eyes?.shape] || shapes.round;
  const ew = 74 * (0.86 + 0.28 * (r.eyes?.size ?? 0.5)) * size;
  return { ew, eh: ew * h };
}

function star(cx, cy, R, rIn, rot = 0, n = 5) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = rot - Math.PI / 2 + (i * Math.PI) / n;
    const rr = i % 2 ? rIn : R;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, true]);
  }
  return closedMixed(pts);
}

function sparkle(cx, cy, R) {
  const r = R * 0.2;
  return closedMixed([
    [cx, cy - R, true], [cx + r, cy - r], [cx + R, cy, true], [cx + r, cy + r],
    [cx, cy + R, true], [cx - r, cy + r], [cx - R, cy, true], [cx - r, cy - r],
  ]);
}

function heart(cx, cy, s) {
  return closedMixed([
    [cx, cy + 21 * s, true], [cx + 13 * s, cy + 8 * s], [cx + 22 * s, cy - 5 * s], [cx + 19 * s, cy - 16 * s], [cx + 9 * s, cy - 19 * s],
    [cx, cy - 11 * s, true], [cx - 9 * s, cy - 19 * s], [cx - 19 * s, cy - 16 * s], [cx - 22 * s, cy - 5 * s], [cx - 13 * s, cy + 8 * s],
  ]);
}

// cheeks lift with cheek.raise (like the blush) and a little with a smile
const CHEEK_CH = [['cheek.raise', { up: 1 }], ['mouth.smile', { up: 0.45 }]];

export const FACE_MARKS = {
  none: { name: 'None', note: '' },

  freckles: {
    name: 'Freckles', note: 'a dusting of freckles across the nose and cheeks',
    skin(ctx) {
      const { b, f, CX, colors } = ctx;
      const { eh } = eyeSize(ctx);
      const rnd = seeded('freckles');
      const top = f.eyeY + eh * 0.5 + 10;
      const spots = [];
      for (const sd of [-1, 1]) {
        for (let i = 0; i < 12; i++) {
          const a = rnd() * Math.PI * 2;
          const rr = Math.sqrt(rnd());
          const x = CX + sd * (f.eyeDX * 0.82 + Math.cos(a) * rr * f.eyeDX * 0.48);
          const y = Math.max(top + rnd() * 6, f.eyeY + 54 * f.lScale + Math.sin(a) * rr * 24);
          spots.push({ x, y, s: 1.5 + rnd() * 2.1, cheek: 1 });
        }
      }
      for (let i = 0; i < 7; i++) {
        const x = CX + (rnd() - 0.5) * 50;
        const y = f.noseY - 30 * f.lScale + (rnd() - 0.5) * 18;
        spots.push({ x, y, s: 1.4 + rnd() * 1.6, cheek: 0 });
      }
      const deep = luminance(colors.skin) < 0.12;
      const ink = deep ? shade(colors.skin, -0.55) : mix(shade(colors.skin, -0.42), '#7A3E22', 0.35);
      const sizes = [spots.filter((d) => d.s > 2.7), spots.filter((d) => d.s > 2 && d.s <= 2.7), spots.filter((d) => d.s <= 2)];
      const ops = deep ? [0.55, 0.68, 0.8] : [0.36, 0.5, 0.62];
      sizes.forEach((list, n) => {
        for (let k = 0; k < list.length; k += 13) {
          const part = list.slice(k, k + 13);
          if (!part.length) continue;
          const fn = (p) => compound(...part.map((d) => ellipse(d.x, d.y - (p.up || 0) * 5 * d.cheek, d.s, d.s * 0.88)));
          b.add({ id: 'freckles-' + n + '-' + k, g: 'face', ...build(fn, CHEEK_CH), fill: ink, op: ops[n] });
        }
      });
    },
  },

  'beauty-mark': {
    name: 'Beauty mark', note: 'a small beauty mark above the lip',
    skin(ctx) {
      const { b, f, CX, colors } = ctx;
      const rg = rig(ctx);
      const base = [CX + f.eyeDX * 0.78, f.mouthY - (f.mouthY - f.noseY) * 0.62];
      const at = (p) => lerpPt(base, add2(rg.g(p).CR, 6, -24), 0.4);
      const ink = mix(shade(colors.skin, -0.6), '#2B1914', 0.55);
      b.add({ id: 'beauty-mark-dot', g: 'face', ...build((p) => { const q = at(p); return ellipse(q[0], q[1], 5, 4.6); }, MOUTH_CH), fill: ink });
      b.add({ id: 'beauty-mark-shine', g: 'face', ...build((p) => { const q = at(p); return ellipse(q[0] - 1.4, q[1] - 1.5, 1.3, 1.1); }, MOUTH_CH), fill: '#FFFFFF', op: 0.35 });
    },
  },

  dimples: {
    name: 'Dimples', note: 'dimples that show when they smile',
    skin(ctx) {
      const { b, colors } = ctx;
      const rg = rig(ctx);
      const line = shade(colors.skin, -0.42);
      const arcs = (p) => {
        const g = rg.g(p);
        return compound(...[1, -1].map((sd) => {
          const C = sd > 0 ? g.CR : g.CL;
          return openSpline([[C[0] + sd * 9, C[1] - 11], [C[0] + sd * 14, C[1] - 1], [C[0] + sd * 11, C[1] + 9]]);
        }));
      };
      const pits = (p) => {
        const g = rg.g(p);
        return compound(...[1, -1].map((sd) => {
          const C = sd > 0 ? g.CR : g.CL;
          return ellipse(C[0] + sd * 10, C[1] - 1, 5, 8);
        }));
      };
      b.add({ id: 'dimples-pit', g: 'face', ...build(pits, MOUTH_CH), fill: shade(colors.skin, -0.3), op: 0, oc: [['mouth.smile', 0.3]] });
      b.add({ id: 'dimples-arc', g: 'face', ...build(arcs, MOUTH_CH), fill: 'none', stroke: line, sw: 2.6, op: 0, oc: [['mouth.smile', 0.85]] });
    },
  },

  'laugh-lines': {
    name: 'Laugh lines', note: 'laugh lines that crinkle when they smile',
    skin(ctx) {
      const { b, f, CX, colors } = ctx;
      const rg = rig(ctx);
      const { ew } = eyeSize(ctx);
      const line = shade(colors.skin, -0.4);
      const folds = (p) => {
        const g = rg.g(p);
        return compound(...[1, -1].map((sd) => {
          const C = sd > 0 ? g.CR : g.CL;
          const a = rg.N(p, sd * (rg.nostril + 5), -4);
          const e = [C[0] + sd * 9, C[1] + 7];
          const m = [lerp(a[0], e[0], 0.5) + sd * 13, lerp(a[1], e[1], 0.48)];
          return taper([a, m, e], [1.2, 3.4, 1]);
        }));
      };
      b.add({ id: 'laugh-lines-folds', g: 'face', ...build(folds, [...MOUTH_CH, ['head.yaw', { turn: 1 }], ['head.yaw', { turn: -1 }, true], ['head.pitch', { pitch: 1 }], ['head.pitch', { pitch: -1 }, true]]), fill: line, op: 0, oc: [['mouth.smile', 0.5], ['cheek.raise', 0.15]] });
      const feet = (p) => {
        const out = [];
        for (const sd of [1, -1]) {
          const x0 = CX + sd * (f.eyeDX + ew * 0.5 + 7);
          const y0 = f.eyeY - 2 - (p.up || 0) * 4;
          for (const [dy, ang] of [[-7, -0.38], [1, 0.02], [9, 0.4]]) {
            const L = 13;
            out.push(openSpline([[x0, y0 + dy], [x0 + sd * L * 0.55, y0 + dy + Math.sin(ang) * L * 0.5], [x0 + sd * L, y0 + dy + Math.sin(ang) * L]]));
          }
        }
        return compound(...out);
      };
      b.add({ id: 'laugh-lines-eyes', g: 'face', ...build(feet, [['cheek.raise', { up: 1 }]]), fill: 'none', stroke: line, sw: 2.2, op: 0, oc: [['cheek.raise', 0.4], ['mouth.smile', 0.2], ['eye.squint', 0.25]] });
    },
  },

  whiskers: {
    name: 'Cat whiskers', note: 'playful cat whiskers on the cheeks',
    skin(ctx) {
      const { b, f, CX, colors } = ctx;
      const rg = rig(ctx);
      const ink = luminance(colors.skin) < 0.12 ? '#F6EFE6' : '#2A2124';
      const g0 = rg.g({});
      const startX = Math.max(52, g0.hw + 10);
      const reach = f.W * f.hs.cheek * 0.98;
      const lift = (p) => (p.smile || 0) * 6 + (p.up || 0) * 4;
      const whisk = (p) => {
        const out = [];
        for (const sd of [1, -1]) {
          for (let i = 0; i < 3; i++) {
            const y0 = f.noseY + 10 + i * 9 - lift(p) * 0.5;
            const a = [CX + sd * startX, y0];
            const e = [CX + sd * reach, f.noseY - 12 + i * 22 - lift(p)];
            const m = [lerp(a[0], e[0], 0.5), lerp(a[1], e[1], 0.5) - 6 + i * 2];
            out.push(taper([a, m, e], [4.6, 3.2, 1]));
          }
        }
        return compound(...out);
      };
      const pads = (p) => {
        const out = [];
        for (const sd of [1, -1]) {
          for (const [dx, dy] of [[-16, 6], [-4, 15], [-18, 22]]) out.push(ellipse(CX + sd * (startX + dx), f.noseY + dy - lift(p) * 0.5, 2.6, 2.6));
        }
        return compound(...out);
      };
      const ch = [['mouth.smile', { smile: 1 }], ['cheek.raise', { up: 1 }]];
      b.add({ id: 'whiskers-lines', g: 'face', ...build(whisk, ch), fill: ink, op: 0.9 });
      b.add({ id: 'whiskers-pads', g: 'face', ...build(pads, ch), fill: ink, op: 0.85 });
    },
  },

  'star-face-paint': {
    name: 'Star face paint', note: 'a gold star painted on one cheek',
    skin(ctx) {
      const { b, f, CX } = ctx;
      const cx = CX + f.eyeDX + 18;
      const cy = f.eyeY + 70 * f.lScale;
      const up = (p) => (p.up || 0) * 8;
      b.grad('star-face-paint-g', { kind: 'radial', center: [cx - 6, cy - 8], radius: 34, stops: [{ at: 0, color: '#FFF0A6' }, { at: 0.45, color: '#FFD24D' }, { at: 1, color: '#F2A52E' }] });
      b.add({ id: 'star-face-paint-big', g: 'face', ...build((p) => star(cx, cy - up(p), 27, 12, 0.18), CHEEK_CH), fill: 'star-face-paint-g', stroke: '#C27C12', sw: 2.8 });
      b.add({ id: 'star-face-paint-small', g: 'face', ...build((p) => compound(star(cx + 36, cy - 38 - up(p), 10, 4.4, -0.2), star(cx - 28, cy + 30 - up(p), 7.5, 3.3, 0.35)), CHEEK_CH), fill: '#FFD24D', stroke: '#C27C12', sw: 2 });
      b.add({ id: 'star-face-paint-shine', g: 'face', ...build((p) => compound(ellipse(cx - 7, cy - 9 - up(p), 5, 3.4), sparkle(cx + 20, cy - 18 - up(p), 6)), CHEEK_CH), fill: '#FFFFFF', op: 0.7 });
    },
  },

  'heart-face-paint': {
    name: 'Heart face paint', note: 'a pink heart painted on one cheek',
    skin(ctx) {
      const { b, f, CX } = ctx;
      const cx = CX - f.eyeDX - 16;
      const cy = f.eyeY + 70 * f.lScale;
      const up = (p) => (p.up || 0) * 8;
      b.grad('heart-face-paint-g', { kind: 'radial', center: [cx - 8, cy - 10], radius: 34, stops: [{ at: 0, color: '#FF9DB8' }, { at: 0.5, color: '#F5577F' }, { at: 1, color: '#D93A63' }] });
      b.add({ id: 'heart-face-paint-big', g: 'face', ...build((p) => heart(cx, cy - up(p), 1.2), CHEEK_CH), fill: 'heart-face-paint-g', stroke: '#A8264A', sw: 2.6 });
      b.add({ id: 'heart-face-paint-small', g: 'face', ...build((p) => heart(cx - 30, cy + 28 - up(p), 0.42), CHEEK_CH), fill: '#F5577F', stroke: '#A8264A', sw: 1.8 });
      b.add({ id: 'heart-face-paint-shine', g: 'face', ...build((p) => ellipse(cx - 12, cy - 11 - up(p), 5.5, 3.6), CHEEK_CH), fill: '#FFFFFF', op: 0.6 });
    },
  },

  glitter: {
    name: 'Glitter', note: 'sparkly glitter along the cheekbones',
    skin(ctx) {
      const { b, f, CX } = ctx;
      const { ew } = eyeSize(ctx);
      const up = (p) => (p.up || 0) * 7;
      const outerX = f.eyeDX + ew * 0.5;
      // arc along each cheekbone from the outer eye corner down toward the cheek
      const spots = [];
      for (const sd of [1, -1]) {
        const arc = [[outerX + 14, 4], [outerX + 10, 26], [outerX - 6, 40], [outerX - 26, 50], [outerX + 8, 52], [outerX - 46, 54]];
        arc.forEach(([dx, dy], i) => spots.push({ x: CX + sd * dx, y: f.eyeY + dy * f.lScale, i, sd }));
      }
      for (const sd of [1, -1]) {
        b.grad('glitter-sheen' + sd, { kind: 'radial', center: [CX + sd * (outerX - 6), f.eyeY + 34 * f.lScale], radius: 44, stops: [{ at: 0, color: '#FFF6E0', opacity: 0.55 }, { at: 1, color: '#FFF6E0', opacity: 0 }] });
        b.add({ id: 'glitter-sheen' + sd, g: 'face', ...build((p) => ellipse(CX + sd * (outerX - 6), f.eyeY + 34 * f.lScale - up(p), 46, 30), CHEEK_CH), fill: 'glitter-sheen' + sd, op: 0.8 });
      }
      const gold = spots.filter((s) => s.i % 3 === 0);
      const aqua = spots.filter((s) => s.i % 3 === 1);
      const pink = spots.filter((s) => s.i % 3 === 2);
      const sizes = [10, 7, 6];
      const mk = (list, R) => (p) => compound(...list.map((s) => sparkle(s.x, s.y - up(p), R + (s.i % 2) * 2)));
      b.add({ id: 'glitter-gold', g: 'face', ...build(mk(gold, sizes[0]), CHEEK_CH), fill: '#FFD95A', stroke: '#C9921C', sw: 1.2 });
      b.add({ id: 'glitter-aqua', g: 'face', ...build(mk(aqua, sizes[1]), CHEEK_CH), fill: '#8EEAF5', stroke: '#2F9DB5', sw: 1.1 });
      b.add({ id: 'glitter-pink', g: 'face', ...build(mk(pink, sizes[2]), CHEEK_CH), fill: '#FF9ACB', stroke: '#D0569A', sw: 1.1 });
      const rnd = seeded('glitter');
      const fleck = [];
      for (const sd of [1, -1]) for (let i = 0; i < 6; i++) fleck.push([CX + sd * (outerX - 40 + rnd() * 62), f.eyeY + (6 + rnd() * 52) * f.lScale]);
      b.add({ id: 'glitter-flecks', g: 'face', ...build((p) => compound(...fleck.map(([x, y]) => ellipse(x, y - up(p), 1.8, 1.8))), CHEEK_CH), fill: '#FFFFFF', stroke: '#C9A6E8', sw: 0.8, op: 0.95 });
    },
  },

  'rosy-nose': {
    name: 'Rosy nose', note: 'a rosy pink nose, like coming in from the cold',
    skin(ctx) {
      const { b, f, CX } = ctx;
      const nk = 0.85 + 0.35 * (ctx.r.nose?.size ?? 0.5);
      const cy = f.noseY - 4 * nk;
      b.grad('rosy-nose-g', { kind: 'radial', center: [CX - 2, cy], radius: 32 * nk, stops: [{ at: 0, color: '#F0697C', opacity: 0.62 }, { at: 0.55, color: '#F0697C', opacity: 0.34 }, { at: 1, color: '#F0697C', opacity: 0 }] });
      // the nose group carries its own turn parallax, so the rosy tip stays on the nose
      b.add({ id: 'rosy-nose-tip', g: 'nose', d: ellipse(CX - 2, cy, 33 * nk, 25 * nk), fill: 'rosy-nose-g' });
    },
  },
};

