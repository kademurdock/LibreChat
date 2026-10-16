// Jewelry, neckwear and small face piercings for the puppet kit (see CONVENTIONS.md).
// Earrings draw in `earwear` (only when the ears show) inside the `ears` group; dangling
// earrings hang from a small group pivoted at the lobe that counter-rotates against
// head roll and sways with hair.swing so they keep hanging down. Neckwear draws in
// `neckwear` (over any top) inside `body`. Face accents draw in `skin`.
// Metals default per item; a recipe may set `jewelry: { metal: 'gold' | 'silver' }`.
// Fabric pieces (scarf, ties, bandana, lanyard) take the outfit accent colour.
import { ellipse, openSpline, closedSpline, closedMixed, compound, shade, lerp, hexToRgb, luminance, round1 } from './geom.mjs';
import { morphable, BROW_SHAPES, EYE_SHAPES } from './kit.mjs';

// ---------------------------------------------------------------- helpers
const METALS = {
  gold: { hi: '#FFF2C2', base: '#E3B547', lo: '#A3701C', line: '#7A5316' },
  silver: { hi: '#FFFFFF', base: '#C8CED7', lo: '#808895', line: '#59606C' },
};

function metalOf(ctx, fallback) {
  const m = ctx.r && ctx.r.jewelry && ctx.r.jewelry.metal;
  return METALS[m] ? m : fallback;
}

function metalGrad(ctx, id, metal, x0, y0, x1, y1) {
  const M = METALS[metal];
  ctx.b.grad(id, { kind: 'linear', start: [x0, y0], end: [x1, y1], stops: [{ at: 0, color: M.hi }, { at: 0.42, color: M.base }, { at: 1, color: M.lo }] });
  return id;
}

function satOf(hex) {
  const c = hexToRgb(hex);
  const mx = Math.max(...c);
  const mn = Math.min(...c);
  return mx ? (mx - mn) / mx : 0;
}

function dist(a, b) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

// Fabric colour: the outfit accent, nudged away from the shirt when they are too close.
function fabricOf(ctx) {
  const { accent, cloth } = ctx.colors;
  if (dist(accent, cloth) > 80) return accent;
  return luminance(cloth) > 0.3 ? shade(accent, -0.5) : shade(accent, 0.55);
}

function contrastOf(hex) {
  return luminance(hex) > 0.35 ? shade(hex, -0.42) : shade(hex, 0.6);
}

function fabricGrad(ctx, id, hex, x0, y0, x1, y1) {
  ctx.b.grad(id, { kind: 'linear', start: [x0, y0], end: [x1, y1], stops: [{ at: 0, color: shade(hex, 0.16) }, { at: 0.5, color: hex }, { at: 1, color: shade(hex, -0.2) }] });
  return id;
}

// A gem colour: the accent when it is a real colour, otherwise the fallback.
function gemOf(ctx, fallback) {
  const a = ctx.colors.accent;
  return satOf(a) > 0.45 && luminance(a) > 0.03 ? a : fallback;
}

const K = 0.5522847498;
// Ellipse traced the other way round, so compound(ellipse, ellipseRev) is a ring.
function ellipseRev(cx, cy, rx, ry) {
  const r = round1;
  return [
    { op: 'M', v: [r(cx + rx), r(cy)] },
    { op: 'C', v: [r(cx + rx), r(cy - ry * K), r(cx + rx * K), r(cy - ry), r(cx), r(cy - ry)] },
    { op: 'C', v: [r(cx - rx * K), r(cy - ry), r(cx - rx), r(cy - ry * K), r(cx - rx), r(cy)] },
    { op: 'C', v: [r(cx - rx), r(cy + ry * K), r(cx - rx * K), r(cy + ry), r(cx), r(cy + ry)] },
    { op: 'C', v: [r(cx + rx * K), r(cy + ry), r(cx + rx), r(cy + ry * K), r(cx + rx), r(cy)] },
    { op: 'Z', v: [] },
  ];
}

function ring(cx, cy, rx, ry, t) {
  return compound(ellipse(cx, cy, rx, ry), ellipseRev(cx, cy, rx - t, ry - t));
}

// Ellipse rotated by angle a (radians) about its centre.
function rotEllipse(cx, cy, rx, ry, a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return ellipse(cx, cy, rx, ry).map((cmd) => {
    const v = [];
    for (let i = 0; i < cmd.v.length; i += 2) {
      const dx = cmd.v[i] - cx;
      const dy = cmd.v[i + 1] - cy;
      v.push(round1(cx + dx * c - dy * s), round1(cy + dx * s + dy * c));
    }
    return { op: cmd.op, v };
  });
}

// Points along an elliptical arc (angles in degrees, 0 = +x, 90 = down).
function arcPts(cx, cy, rx, ry, a0, a1, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / (n - 1)) * Math.PI) / 180;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}

function rrect(x, y, w, h, rad) {
  const r = Math.min(rad, w / 2, h / 2);
  const k = r * (1 - K);
  const R = round1;
  return [
    { op: 'M', v: [R(x + r), R(y)] },
    { op: 'L', v: [R(x + w - r), R(y)] },
    { op: 'C', v: [R(x + w - k), R(y), R(x + w), R(y + k), R(x + w), R(y + r)] },
    { op: 'L', v: [R(x + w), R(y + h - r)] },
    { op: 'C', v: [R(x + w), R(y + h - k), R(x + w - k), R(y + h), R(x + w - r), R(y + h)] },
    { op: 'L', v: [R(x + r), R(y + h)] },
    { op: 'C', v: [R(x + k), R(y + h), R(x), R(y + h - k), R(x), R(y + h - r)] },
    { op: 'L', v: [R(x), R(y + r)] },
    { op: 'C', v: [R(x), R(y + k), R(x + k), R(y), R(x + r), R(y)] },
    { op: 'Z', v: [] },
  ];
}

function heartPath(cx, cy, w, h) {
  const hw = w / 2;
  const R = round1;
  return [
    { op: 'M', v: [R(cx), R(cy + h * 0.5)] },
    { op: 'C', v: [R(cx + hw * 0.32), R(cy + h * 0.3), R(cx + hw), R(cy + h * 0.06), R(cx + hw), R(cy - h * 0.2)] },
    { op: 'C', v: [R(cx + hw), R(cy - h * 0.46), R(cx + hw * 0.42), R(cy - h * 0.6), R(cx), R(cy - h * 0.28)] },
    { op: 'C', v: [R(cx - hw * 0.42), R(cy - h * 0.6), R(cx - hw), R(cy - h * 0.46), R(cx - hw), R(cy - h * 0.2)] },
    { op: 'C', v: [R(cx - hw), R(cy + h * 0.06), R(cx - hw * 0.32), R(cy + h * 0.3), R(cx), R(cy + h * 0.5)] },
    { op: 'Z', v: [] },
  ];
}

// Teardrop with its point at (cx, top) and a round body of radius r below.
function dropPath(cx, top, r) {
  const cy = top + r * 1.9;
  const R = round1;
  return [
    { op: 'M', v: [R(cx), R(top)] },
    { op: 'C', v: [R(cx + r * 0.22), R(top + r * 0.55), R(cx + r), R(cy - r * 0.8), R(cx + r), R(cy)] },
    { op: 'C', v: [R(cx + r), R(cy + r * K), R(cx + r * K), R(cy + r), R(cx), R(cy + r)] },
    { op: 'C', v: [R(cx - r * K), R(cy + r), R(cx - r), R(cy + r * K), R(cx - r), R(cy)] },
    { op: 'C', v: [R(cx - r), R(cy - r * 0.8), R(cx - r * 0.22), R(top + r * 0.55), R(cx), R(top)] },
    { op: 'Z', v: [] },
  ];
}

function starPath(cx, cy, ro, ri) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? ri : ro;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, i % 2 === 0]);
  }
  return closedMixed(pts);
}

// A four-point twinkle for glints on gems.
function twinkle(cx, cy, r) {
  const t = r * 0.22;
  return closedMixed([[cx, cy - r, true], [cx + t, cy - t], [cx + r, cy, true], [cx + t, cy + t], [cx, cy + r, true], [cx - t, cy + t], [cx - r, cy, true], [cx - t, cy - t]]);
}

// Several small paths as a few compound shapes (each under the command budget).
function addChunks(b, idBase, paths, props, per = 12) {
  for (let i = 0; i * per < paths.length; i++) {
    b.add({ id: idBase + '-' + i, d: compound(...paths.slice(i * per, (i + 1) * per)), ...props });
  }
}

// Points spaced evenly along a necklace curve: a half ellipse from the left side of
// the neck, down through the lowest point at the centre, up to the right side.
function drape(ctx, ex, ey, depth, n, span = 0.96) {
  const { f, CX } = ctx;
  const nb = f.neckBase;
  const N = 240;
  const raw = [];
  const cum = [0];
  let L = 0;
  for (let i = 0; i <= N; i++) {
    const u = (-1 + (2 * i) / N) * span * (Math.PI / 2);
    raw.push([CX + ex * Math.sin(u), nb + ey + (depth - ey) * Math.cos(u)]);
    if (i) {
      L += Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]);
      cum.push(L);
    }
  }
  const pts = [];
  const ang = [];
  for (let j = 0; j < n; j++) {
    const target = (L * j) / (n - 1);
    let i = 1;
    while (i < N && cum[i] < target) i++;
    const t = (target - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    pts.push([lerp(raw[i - 1][0], raw[i][0], t), lerp(raw[i - 1][1], raw[i][1], t)]);
    ang.push(Math.atan2(raw[i][1] - raw[i - 1][1], raw[i][0] - raw[i - 1][0]));
  }
  return { pts, ang, len: L };
}

function neckOf(ctx) {
  return { nb: ctx.f.neckBase, nw: ctx.f.W * 0.46 };
}

// Ear lobes (empty when the ears are hidden). Matches the ear drawn by kit.mjs.
function lobes(ctx) {
  const { f, r, CX } = ctx;
  const shape = r.ears && r.ears.shape;
  if (shape === 'hidden') return [];
  const big = shape === 'big' ? 1.25 : 1;
  return [-1, 1].map((side) => {
    const x0 = CX + side * (f.W * f.hs.cheek - 10);
    return { side, s: side > 0 ? 'R' : 'L', x: x0 + side * 15 * big, y: f.earY + 33 * big, big };
  });
}

// A pivot group at the lobe so dangling earrings keep hanging down.
function dangle(ctx, id, L, gain = 1) {
  ctx.b.group(id, 'ears', [L.x, L.y], { r: [['head.roll', -0.08 * gain], ['hair.swing', -0.1 * gain], ['head.yaw', 0.03 * gain]] });
  return id;
}

// Fine chain: dark under-stroke, metal stroke, faint highlight.
function fineChain(ctx, id, pts, metal, w = 2.4) {
  const { b, f, CX } = ctx;
  const M = METALS[metal];
  const g = metalGrad(ctx, id + '-g', metal, CX - 90, f.neckBase - 30, CX + 90, f.neckBase + 70);
  b.add({ id: id + '-under', g: 'body', d: openSpline(pts), fill: 'none', stroke: M.line, sw: w + 1.6, op: 0.85 });
  b.add({ id: id + '-wire', g: 'body', d: openSpline(pts), fill: 'none', stroke: g, sw: w });
}

// ---------------------------------------------------------------- items
export const ITEMS = {
  // ------------------------------------------------------------ earrings
  'stud-earrings': {
    name: 'Stud earrings', slot: 'earwear', note: 'small sparkling stud earrings',
    earwear(ctx) {
      const { b } = ctx;
      const metal = metalOf(ctx, 'silver');
      const M = METALS[metal];
      for (const L of lobes(ctx)) {
        const id = 'stud-earrings-' + L.s;
        const R = 7.2;
        const x = L.x;
        const y = L.y;
        metalGrad(ctx, id + '-g', metal, x - R, y - R, x + R, y + R);
        b.add({ id: id + '-set', g: 'ears', d: ellipse(x, y, R, R), fill: id + '-g', stroke: M.line, sw: 1.6 });
        b.grad(id + '-gem', { kind: 'radial', center: [x, y], focal: [x - 1.6, y - 1.8], radius: R * 0.7, stops: [{ at: 0, color: '#FFFFFF' }, { at: 0.45, color: '#DDF2FF' }, { at: 1, color: '#86BCE6' }] });
        b.add({ id: id + '-gem', g: 'ears', d: ellipse(x, y, R * 0.64, R * 0.64), fill: id + '-gem', stroke: '#5E8FB8', sw: 0.8 });
        b.add({ id: id + '-glint', g: 'ears', d: twinkle(x - 1.8, y - 2, 3.4), fill: '#FFFFFF', op: 0.95 });
      }
    },
  },
  'hoop-earrings': {
    name: 'Hoop earrings', slot: 'earwear', note: 'shiny hoop earrings',
    earwear(ctx) {
      const { b } = ctx;
      const metal = metalOf(ctx, 'gold');
      const M = METALS[metal];
      for (const L of lobes(ctx)) {
        const id = 'hoop-earrings-' + L.s;
        const g = dangle(ctx, id, L);
        const ry = 17 * L.big;
        const rx = 14 * L.big;
        const cx = L.x + L.side * 1;
        const cy = L.y - 3 + ry;
        metalGrad(ctx, id + '-g', metal, cx - rx, cy - ry, cx + rx, cy + ry);
        b.add({ id: id + '-ring', g, d: ring(cx, cy, rx, ry, 4.4), fill: id + '-g', stroke: M.line, sw: 1.3 });
        b.add({ id: id + '-shine', g, d: openSpline(arcPts(cx, cy, rx - 2.2, ry - 2.2, 195, 255, 4)), fill: 'none', stroke: '#FFFFFF', sw: 1.5, op: 0.6 });
      }
    },
  },
  'drop-earrings': {
    name: 'Drop earrings', slot: 'earwear', note: 'dangling teardrop gem earrings',
    earwear(ctx) {
      const { b } = ctx;
      const metal = metalOf(ctx, 'gold');
      const M = METALS[metal];
      const gem = gemOf(ctx, '#3A7BD5');
      for (const L of lobes(ctx)) {
        const id = 'drop-earrings-' + L.s;
        const g = dangle(ctx, id, L);
        const x = L.x;
        const y = L.y - 2;
        const r = 7.5 * L.big;
        const top = y + 11;
        metalGrad(ctx, id + '-g', metal, x - 10, y - 4, x + 10, top + r * 3);
        b.add({ id: id + '-link', g, d: openSpline([[x, y], [x, top + 2]]), fill: 'none', stroke: M.line, sw: 3.4 });
        b.add({ id: id + '-link2', g, d: openSpline([[x, y], [x, top + 2]]), fill: 'none', stroke: id + '-g', sw: 1.8 });
        b.add({ id: id + '-cap', g, d: ellipse(x, y, 3.8, 3.8), fill: id + '-g', stroke: M.line, sw: 1.2 });
        const cy = top + r * 1.9;
        b.grad(id + '-gem', { kind: 'radial', center: [x, cy], focal: [x - r * 0.35, cy - r * 0.4], radius: r * 1.4, stops: [{ at: 0, color: shade(gem, 0.6) }, { at: 0.45, color: gem }, { at: 1, color: shade(gem, -0.45) }] });
        b.add({ id: id + '-gem', g, d: dropPath(x, top, r), fill: id + '-gem', stroke: id + '-g', sw: 2.2 });
        b.add({ id: id + '-glint', g, d: ellipse(x - r * 0.35, cy - r * 0.3, r * 0.22, r * 0.36), fill: '#FFFFFF', op: 0.75 });
      }
    },
  },
  'pearl-earrings': {
    name: 'Pearl earrings', slot: 'earwear', note: 'little pearl drop earrings',
    earwear(ctx) {
      const { b } = ctx;
      const metal = metalOf(ctx, 'gold');
      const M = METALS[metal];
      for (const L of lobes(ctx)) {
        const id = 'pearl-earrings-' + L.s;
        const g = dangle(ctx, id, L, 0.8);
        const x = L.x;
        const y = L.y - 3;
        const r = 8.4 * L.big;
        const cy = y + 4 + r;
        metalGrad(ctx, id + '-g', metal, x - 4, y - 4, x + 4, y + 5);
        b.grad(id + '-p', { kind: 'radial', center: [x, cy], focal: [x - r * 0.38, cy - r * 0.42], radius: r * 1.3, stops: [{ at: 0, color: '#FFFFFF' }, { at: 0.3, color: '#F6F1EA' }, { at: 0.62, color: '#E9DFD8' }, { at: 0.85, color: '#D2C4B6' }, { at: 1, color: '#B8A998' }] });
        b.add({ id: id + '-pearl', g, d: ellipse(x, cy, r, r), fill: id + '-p', stroke: '#A2927F', sw: 1.2 });
        b.add({ id: id + '-cap', g, d: closedSpline([[x - 4.2, y + 4.6], [x - 3, y - 1], [x, y - 2.6], [x + 3, y - 1], [x + 4.2, y + 4.6], [x, y + 6]]), fill: id + '-g', stroke: M.line, sw: 1.1 });
      }
    },
  },
  'star-earrings': {
    name: 'Star earrings', slot: 'earwear', note: 'little star-shaped stud earrings',
    earwear(ctx) {
      const { b } = ctx;
      const metal = metalOf(ctx, 'gold');
      const M = METALS[metal];
      for (const L of lobes(ctx)) {
        const id = 'star-earrings-' + L.s;
        const x = L.x + L.side * 1;
        const y = L.y + 1;
        const ro = 11.5;
        metalGrad(ctx, id + '-g', metal, x - ro, y - ro, x + ro * 0.8, y + ro);
        b.add({ id: id + '-star', g: 'ears', d: starPath(x, y, ro, ro * 0.45), fill: id + '-g', stroke: M.line, sw: 1.4 });
        b.add({ id: id + '-shine', g: 'ears', d: ellipse(x - 2.4, y - 2.6, 2.6, 1.8), fill: '#FFFFFF', op: 0.7 });
      }
    },
  },

  // ------------------------------------------------------------ neckwear
  'chain-necklace': {
    name: 'Chain necklace', slot: 'neckwear', note: 'a chunky chain necklace',
    neckwear(ctx) {
      const { b, f, CX } = ctx;
      const metal = metalOf(ctx, 'gold');
      const M = METALS[metal];
      const { nw } = neckOf(ctx);
      const probe = drape(ctx, nw * 0.98, -12, 56, 2, 0.92);
      const n = Math.max(12, Math.round(probe.len / 12));
      const { pts, ang } = drape(ctx, nw * 0.98, -12, 56, n, 0.92);
      const g = metalGrad(ctx, 'chain-necklace-g', metal, CX - 90, f.neckBase - 30, CX + 90, f.neckBase + 70);
      b.add({ id: 'chain-necklace-core', g: 'body', d: openSpline(pts), fill: 'none', stroke: M.line, sw: 2.2, op: 0.7 });
      const rings = [];
      const bars = [];
      pts.forEach(([x, y], i) => {
        if (i % 2 === 0) rings.push(rotEllipse(x, y, 8.2, 4.8, ang[i]));
        else bars.push(rotEllipse(x, y, 7.4, 2.3, ang[i]));
      });
      addChunks(b, 'chain-necklace-bars', bars, { g: 'body', fill: g, stroke: M.line, sw: 1.2 });
      addChunks(b, 'chain-necklace-rings', rings, { g: 'body', fill: 'none', stroke: M.line, sw: 4.6 });
      addChunks(b, 'chain-necklace-ringsLit', rings, { g: 'body', fill: 'none', stroke: g, sw: 2.6 });
    },
  },
  'pearl-necklace': {
    name: 'Pearl necklace', slot: 'neckwear', note: 'a classic string of pearls',
    neckwear(ctx) {
      const { b } = ctx;
      const { nw } = neckOf(ctx);
      const r = 8.2;
      const probe = drape(ctx, nw * 0.99, -20, 44, 2);
      const n = Math.max(9, Math.round(probe.len / (2 * r * 0.97)) + 1);
      const { pts } = drape(ctx, nw * 0.99, -20, 44, n);
      pts.forEach(([x, y], i) => {
        const id = 'pearl-necklace-p' + i;
        b.grad(id, { kind: 'radial', center: [x, y], focal: [x - r * 0.38, y - r * 0.42], radius: r * 1.3, stops: [{ at: 0, color: '#FFFFFF' }, { at: 0.3, color: '#F6F1EA' }, { at: 0.62, color: '#EADFD9' }, { at: 0.85, color: '#D3C5B7' }, { at: 1, color: '#B9AA99' }] });
        b.add({ id, g: 'body', d: ellipse(x, y, r, r), fill: id, stroke: '#A39380', sw: 1.2 });
      });
    },
  },
  'heart-pendant': {
    name: 'Heart pendant', slot: 'neckwear', note: 'a fine chain with a little heart pendant',
    neckwear(ctx) {
      const { b, CX } = ctx;
      const metal = metalOf(ctx, 'gold');
      const M = METALS[metal];
      const { nb, nw } = neckOf(ctx);
      const depth = 60;
      const { pts } = drape(ctx, nw * 0.97, -14, depth, 9, 0.93);
      fineChain(ctx, 'heart-pendant-chain', pts, metal, 2.2);
      const hy = nb + depth + 16;
      const w = 28;
      const h = 27;
      metalGrad(ctx, 'heart-pendant-g', metal, CX - w / 2, hy - h / 2, CX + w / 2, hy + h / 2);
      b.add({ id: 'heart-pendant-bail', g: 'body', d: ring(CX, nb + depth + 1, 4, 4.4, 1.9), fill: 'heart-pendant-g', stroke: M.line, sw: 1 });
      b.add({ id: 'heart-pendant-heart', g: 'body', d: heartPath(CX, hy, w, h), fill: 'heart-pendant-g', stroke: M.line, sw: 1.8 });
      b.add({ id: 'heart-pendant-inner', g: 'body', d: heartPath(CX, hy + 0.5, w * 0.62, h * 0.62), fill: 'none', stroke: M.lo, sw: 1.2, op: 0.55 });
      b.add({ id: 'heart-pendant-shine', g: 'body', d: openSpline([[CX - w * 0.36, hy - h * 0.18], [CX - w * 0.3, hy - h * 0.34], [CX - w * 0.16, hy - h * 0.38]]), fill: 'none', stroke: '#FFFFFF', sw: 2, op: 0.65 });
    },
  },
  choker: {
    name: 'Choker', slot: 'neckwear', note: 'a velvet choker with a small gem',
    neckwear(ctx) {
      const { b, CX } = ctx;
      const metal = metalOf(ctx, 'silver');
      const M = METALS[metal];
      const { nb, nw } = neckOf(ctx);
      const velvet = '#2C2433';
      const top = (dy) => [[CX - nw * 1.4, nb - 48 + dy], [CX - nw * 0.7, nb - 40 + dy], [CX, nb - 37 + dy], [CX + nw * 0.7, nb - 40 + dy], [CX + nw * 1.4, nb - 48 + dy]];
      const band = [...top(0).map(([x, y], i) => [x, y, i === 0 || i === 4]), ...top(15).reverse().map(([x, y], i) => [x, y, i === 0 || i === 4])];
      b.grad('choker-v', { kind: 'linear', start: [CX, nb - 46], end: [CX, nb - 22], stops: [{ at: 0, color: shade(velvet, 0.22) }, { at: 0.55, color: velvet }, { at: 1, color: shade(velvet, -0.3) }] });
      b.add({ id: 'choker-band', g: 'body', d: closedMixed(band), fill: 'choker-v', stroke: shade(velvet, -0.4), sw: 2, clip: 'neck' });
      b.add({ id: 'choker-sheen', g: 'body', d: openSpline(top(4).slice(0, 4).map(([x, y]) => [x, y])), fill: 'none', stroke: '#FFFFFF', sw: 2, op: 0.16, clip: 'neck' });
      const gy = nb - 30;
      metalGrad(ctx, 'choker-g', metal, CX - 8, gy - 8, CX + 8, gy + 18);
      b.add({ id: 'choker-loop', g: 'body', d: ring(CX, gy + 8, 3.6, 3.6, 1.6), fill: 'choker-g', stroke: M.line, sw: 0.8 });
      b.add({ id: 'choker-set', g: 'body', d: ellipse(CX, gy, 7.4, 7.4), fill: 'choker-g', stroke: M.line, sw: 1.3 });
      b.grad('choker-gem', { kind: 'radial', center: [CX, gy], focal: [CX - 1.6, gy - 1.8], radius: 5.2, stops: [{ at: 0, color: '#FFFFFF' }, { at: 0.45, color: '#DDF2FF' }, { at: 1, color: '#86BCE6' }] });
      b.add({ id: 'choker-gem', g: 'body', d: ellipse(CX, gy, 4.8, 4.8), fill: 'choker-gem', stroke: '#5E8FB8', sw: 0.8 });
      b.add({ id: 'choker-drop', g: 'body', d: dropPath(CX, gy + 10, 3.6), fill: 'choker-g', stroke: M.line, sw: 1 });
      b.add({ id: 'choker-glint', g: 'body', d: twinkle(CX - 1.6, gy - 1.8, 3), fill: '#FFFFFF', op: 0.95 });
    },
  },
  'bead-necklace': {
    name: 'Bead necklace', slot: 'neckwear', note: 'a necklace of bright, chunky beads',
    neckwear(ctx) {
      const { b } = ctx;
      const { nw } = neckOf(ctx);
      const r = 9;
      const probe = drape(ctx, nw * 0.99, -20, 48, 2);
      const n = Math.max(9, Math.round(probe.len / (2 * r * 0.98)) + 1);
      const { pts } = drape(ctx, nw * 0.99, -20, 48, n);
      const colors = ['#EF7B67', '#2FA49C', '#F2C14A'];
      colors.forEach((c, k) => {
        const beads = pts.filter((_, i) => i % 3 === k).map(([x, y]) => ellipse(x, y, r, r));
        addChunks(b, 'bead-necklace-c' + k, beads, { g: 'body', fill: c, stroke: shade(c, -0.4), sw: 1.6 });
      });
      addChunks(b, 'bead-necklace-shade', pts.map(([x, y]) => ellipseRev(x + 1.6, y + 2.2, r * 0.82, r * 0.78)), { g: 'body', fill: '#1a0f14', op: 0.12 }, 12);
      addChunks(b, 'bead-necklace-shine', pts.map(([x, y]) => ellipse(x - r * 0.36, y - r * 0.4, r * 0.3, r * 0.24)), { g: 'body', fill: '#FFFFFF', op: 0.7 }, 12);
    },
  },
  'bow-tie': {
    name: 'Bow tie', slot: 'neckwear', note: 'a neat bow tie',
    neckwear(ctx) {
      const { b, CX } = ctx;
      const { nb, nw } = neckOf(ctx);
      const c = fabricOf(ctx);
      const line = shade(c, -0.45);
      const y = nb - 8;
      fabricGrad(ctx, 'bow-tie-g', c, CX - 46, y - 22, CX + 46, y + 22);
      b.add({ id: 'bow-tie-band', g: 'body', d: closedSpline([[CX - nw * 1.3, y - 16], [CX, y - 8], [CX + nw * 1.3, y - 16], [CX + nw * 1.3, y - 8], [CX, y + 1], [CX - nw * 1.3, y - 8]]), fill: shade(c, -0.18), stroke: line, sw: 1.6, clip: 'neck' });
      for (const side of [-1, 1]) {
        const x = (dx) => CX + side * dx;
        const wing = closedMixed([[x(7), y - 8, true], [x(22), y - 17], [x(40), y - 21], [x(48), y - 12], [x(49), y + 1], [x(47), y + 14], [x(38), y + 22], [x(21), y + 17], [x(7), y + 8, true]]);
        b.add({ id: 'bow-tie-wing' + side, g: 'body', d: wing, fill: 'bow-tie-g', stroke: line, sw: 2.4 });
        b.add({ id: 'bow-tie-fold' + side, g: 'body', d: compound(openSpline([[x(12), y - 3], [x(26), y - 8], [x(38), y - 10]]), openSpline([[x(12), y + 4], [x(26), y + 9], [x(36), y + 13]])), fill: 'none', stroke: line, sw: 1.8, op: 0.4 });
      }
      b.add({ id: 'bow-tie-knot', g: 'body', d: closedSpline([[CX - 9, y - 10], [CX, y - 12], [CX + 9, y - 10], [CX + 10, y], [CX + 9, y + 10], [CX, y + 12], [CX - 9, y + 10], [CX - 10, y]]), fill: shade(c, -0.06), stroke: line, sw: 2.2 });
      b.add({ id: 'bow-tie-shine', g: 'body', d: compound(openSpline([[CX - 40, y - 12], [CX - 30, y - 15], [CX - 20, y - 12]]), openSpline([[CX - 5, y - 6], [CX - 5, y + 2]])), fill: 'none', stroke: '#FFFFFF', sw: 2, op: 0.3 });
    },
  },
  necktie: {
    name: 'Necktie', slot: 'neckwear', note: 'a striped necktie',
    neckwear(ctx) {
      const { b, CX } = ctx;
      const { nb, nw } = neckOf(ctx);
      const c = fabricOf(ctx);
      const line = shade(c, -0.45);
      const stripe = contrastOf(c);
      const y = nb - 12;
      fabricGrad(ctx, 'necktie-g', c, CX - 40, y, CX + 40, y + 200);
      b.add({ id: 'necktie-band', g: 'body', d: closedSpline([[CX - nw * 1.3, y - 14], [CX, y - 6], [CX + nw * 1.3, y - 14], [CX + nw * 1.3, y - 6], [CX, y + 3], [CX - nw * 1.3, y - 6]]), fill: shade(c, -0.18), stroke: line, sw: 1.6, clip: 'neck' });
      const blade = closedMixed([[CX - 9, y + 20, true], [CX + 9, y + 20, true], [CX + 17, y + 100], [CX + 23, y + 168, true], [CX, y + 190, true], [CX - 23, y + 168, true], [CX - 17, y + 100]]);
      b.add({ id: 'necktie-blade', g: 'body', d: blade, fill: 'necktie-g', stroke: line, sw: 2.4 });
      const stripes = [];
      for (let i = 0; i < 6; i++) {
        const sy = y + 34 + i * 26;
        stripes.push(closedMixed([[CX - 30, sy, true], [CX + 30, sy - 22, true], [CX + 30, sy - 15, true], [CX - 30, sy + 7, true]]));
      }
      b.add({ id: 'necktie-stripes', g: 'body', d: compound(...stripes), fill: stripe, op: 0.85, clip: 'necktie-blade' });
      b.add({ id: 'necktie-crease', g: 'body', d: openSpline([[CX + 2, y + 26], [CX + 4, y + 100], [CX + 3, y + 180]]), fill: 'none', stroke: line, sw: 1.6, op: 0.25, clip: 'necktie-blade' });
      b.add({ id: 'necktie-knot', g: 'body', d: closedMixed([[CX - 15, y - 6, true], [CX, y - 9], [CX + 15, y - 6, true], [CX + 10, y + 22, true], [CX, y + 24], [CX - 10, y + 22, true]]), fill: 'necktie-g', stroke: line, sw: 2.4 });
      b.add({ id: 'necktie-knotFold', g: 'body', d: openSpline([[CX - 9, y - 2], [CX + 2, y + 8], [CX + 6, y + 19]]), fill: 'none', stroke: line, sw: 1.6, op: 0.35 });
      b.add({ id: 'necktie-shine', g: 'body', d: openSpline([[CX - 9, y + 30], [CX - 12, y + 80], [CX - 15, y + 130]]), fill: 'none', stroke: '#FFFFFF', sw: 2.4, op: 0.22, clip: 'necktie-blade' });
    },
  },
  scarf: {
    name: 'Knitted scarf', slot: 'neckwear', note: 'a cosy knitted scarf wrapped around the neck',
    neckwear(ctx) {
      const { b, CX } = ctx;
      const { nb, nw } = neckOf(ctx);
      const c = fabricOf(ctx);
      const line = shade(c, -0.42);
      const stripe = contrastOf(c);
      const rib = { g: 'body', fill: 'none', stroke: shade(c, -0.35), sw: 2, op: 0.35 };
      fabricGrad(ctx, 'scarf-g', c, CX - 120, nb - 60, CX + 120, nb + 120);
      // upper roll, snug under the chin
      const roll1 = [[CX - nw * 1.42, nb - 26], [CX - nw * 1.08, nb - 56], [CX - nw * 0.4, nb - 50], [CX + nw * 0.4, nb - 50], [CX + nw * 1.08, nb - 56], [CX + nw * 1.45, nb - 24], [CX + nw * 1.2, nb + 4], [CX + nw * 0.4, nb + 12], [CX - nw * 0.4, nb + 12], [CX - nw * 1.2, nb + 4]];
      b.add({ id: 'scarf-roll1', g: 'body', d: closedSpline(roll1), fill: 'scarf-g', stroke: line, sw: 2.6 });
      const ribs1 = [];
      for (let i = -7; i <= 7; i++) ribs1.push(openSpline([[CX + i * nw * 0.19, nb - 70], [CX + i * nw * 0.2, nb - 20], [CX + i * nw * 0.21, nb + 20]]));
      b.add({ id: 'scarf-ribs1', ...rib, d: compound(...ribs1), clip: 'scarf-roll1' });
      // hanging ends, coming out from under the lower roll
      const end = (x0, x1, top, bot, w0, w1) => closedMixed([[x0 - w0 / 2, top], [x0 + w0 / 2, top], [lerp(x0, x1, 0.5) + (w0 + w1) / 4, (top + bot) / 2], [x1 + w1 / 2, bot, true], [x1 - w1 / 2, bot, true], [lerp(x0, x1, 0.5) - (w0 + w1) / 4, (top + bot) / 2]]);
      const backX0 = CX - nw * 0.12;
      const backX1 = CX - nw * 0.02;
      b.add({ id: 'scarf-endB', g: 'body', d: end(backX0, backX1, nb + 4, nb + 108, 44, 46), fill: shade(c, -0.16), stroke: line, sw: 2.4 });
      const fx0 = CX - nw * 0.62;
      const fx1 = CX - nw * 0.78;
      const fBot = nb + 120;
      b.add({ id: 'scarf-endA', g: 'body', d: end(fx0, fx1, nb + 8, fBot, 52, 56), fill: 'scarf-g', stroke: line, sw: 2.4 });
      const bands = [];
      for (const dy of [-34, -20]) bands.push(closedMixed([[fx1 - 40, fBot + dy, true], [fx1 + 40, fBot + dy, true], [fx1 + 40, fBot + dy + 8, true], [fx1 - 40, fBot + dy + 8, true]]));
      b.add({ id: 'scarf-stripes', g: 'body', d: compound(...bands), fill: stripe, op: 0.9, clip: 'scarf-endA' });
      const ribsA = [];
      for (let i = -2; i <= 2; i++) ribsA.push(openSpline([[fx0 + i * 10, nb], [lerp(fx0, fx1, 0.5) + i * 10.5, nb + 64], [fx1 + i * 11, fBot + 6]]));
      b.add({ id: 'scarf-ribsA', ...rib, d: compound(...ribsA), clip: 'scarf-endA' });
      const fringe = [];
      for (let i = 0; i < 6; i++) {
        const fx = fx1 - 23 + i * 9.2;
        fringe.push(openSpline([[fx, fBot - 1], [fx - 1, fBot + 8], [fx - 2.5, fBot + 15]]));
      }
      b.add({ id: 'scarf-fringe', g: 'body', d: compound(...fringe), fill: 'none', stroke: line, sw: 4.2 });
      b.add({ id: 'scarf-fringeLit', g: 'body', d: compound(...fringe), fill: 'none', stroke: c, sw: 2.4 });
      // lower roll draping over the front
      const roll2 = [[CX - nw * 1.55, nb - 6], [CX - nw * 1.15, nb - 24], [CX - nw * 0.2, nb - 10], [CX + nw * 0.9, nb - 22], [CX + nw * 1.52, nb - 8], [CX + nw * 1.34, nb + 20], [CX + nw * 0.5, nb + 34], [CX - nw * 0.6, nb + 36], [CX - nw * 1.36, nb + 22]];
      b.add({ id: 'scarf-roll2', g: 'body', d: closedSpline(roll2), fill: 'scarf-g', stroke: line, sw: 2.6 });
      const ribs2 = [];
      for (let i = -8; i <= 8; i++) ribs2.push(openSpline([[CX + i * nw * 0.18 - 4, nb - 34], [CX + i * nw * 0.185, nb + 8], [CX + i * nw * 0.19 + 3, nb + 46]]));
      b.add({ id: 'scarf-ribs2', ...rib, d: compound(...ribs2), clip: 'scarf-roll2' });
      b.add({ id: 'scarf-shine', g: 'body', d: compound(openSpline([[CX - nw * 1.2, nb - 36], [CX - nw * 0.8, nb - 46], [CX - nw * 0.3, nb - 44]]), openSpline([[CX - nw * 1.3, nb - 2], [CX - nw * 0.9, nb - 14], [CX - nw * 0.4, nb - 6]])), fill: 'none', stroke: '#FFFFFF', sw: 3, op: 0.18 });
    },
  },
  'bandana-neck': {
    name: 'Neck bandana', slot: 'neckwear', note: 'a polka-dot bandana knotted around the neck',
    neckwear(ctx) {
      const { b, CX } = ctx;
      const { nb, nw } = neckOf(ctx);
      const c = fabricOf(ctx);
      const line = shade(c, -0.45);
      const dot = contrastOf(c);
      fabricGrad(ctx, 'bandana-neck-g', c, CX - 100, nb - 40, CX + 100, nb + 100);
      const tri = [[CX - nw * 1.24, nb - 30, true], [CX, nb - 18], [CX + nw * 1.24, nb - 30, true], [CX + nw * 0.86, nb + 22], [CX + 4, nb + 86, true], [CX - nw * 0.8, nb + 24]];
      b.add({ id: 'bandana-neck-tri', g: 'body', d: closedMixed(tri), fill: 'bandana-neck-g', stroke: line, sw: 2.6 });
      const dots = [];
      for (let row = 0; row < 6; row++) {
        for (let col = -5; col <= 5; col++) {
          const x = CX + col * 20 + (row % 2 ? 10 : 0);
          const y = nb - 12 + row * 18;
          const t = (y - (nb - 28)) / 114;
          const half = nw * 1.15 * (1 - t);
          if (Math.abs(x - CX - 2) < half - 6) dots.push(ellipse(x, y, 3.2, 3.2));
        }
      }
      addChunks(b, 'bandana-neck-dots', dots, { g: 'body', fill: dot, op: 0.9, clip: 'bandana-neck-tri' });
      const inset = tri.map(([x, y]) => [CX + (x - CX) * 0.84, nb + 10 + (y - nb - 10) * 0.84]);
      b.add({ id: 'bandana-neck-border', g: 'body', d: openSpline([inset[0], inset[5], inset[4], inset[3], inset[2]].map(([x, y]) => [x, y])), fill: 'none', stroke: dot, sw: 1.8, op: 0.75, clip: 'bandana-neck-tri' });
      b.add({ id: 'bandana-neck-folds', g: 'body', d: compound(openSpline([[CX - nw * 0.6, nb - 10], [CX - nw * 0.25, nb + 30], [CX - 2, nb + 70]]), openSpline([[CX + nw * 0.55, nb - 12], [CX + nw * 0.3, nb + 24]])), fill: 'none', stroke: line, sw: 2, op: 0.35 });
      const band = [[CX - nw * 1.16, nb - 46], [CX, nb - 36], [CX + nw * 1.16, nb - 46], [CX + nw * 1.22, nb - 26], [CX, nb - 14], [CX - nw * 1.22, nb - 26]];
      b.add({ id: 'bandana-neck-band', g: 'body', d: closedSpline(band), fill: 'bandana-neck-g', stroke: line, sw: 2.4 });
      b.add({ id: 'bandana-neck-twist', g: 'body', d: compound(openSpline([[CX - nw * 0.9, nb - 40], [CX - nw * 0.7, nb - 26]]), openSpline([[CX - nw * 0.3, nb - 34], [CX - nw * 0.1, nb - 20]]), openSpline([[CX + nw * 0.3, nb - 34], [CX + nw * 0.5, nb - 21]]), openSpline([[CX + nw * 0.8, nb - 40], [CX + nw * 1.0, nb - 27]])), fill: 'none', stroke: line, sw: 1.8, op: 0.4 });
    },
  },
  lanyard: {
    name: 'Lanyard', slot: 'neckwear', note: 'a lanyard with a blank name badge',
    neckwear(ctx) {
      const { b, CX } = ctx;
      const metal = metalOf(ctx, 'silver');
      const M = METALS[metal];
      const { nb, nw } = neckOf(ctx);
      const c = fabricOf(ctx);
      const line = shade(c, -0.45);
      const clipY = nb + 50;
      for (const side of [-1, 1]) {
        const pts = [[CX + side * nw * 0.99, nb - 26], [CX + side * nw * 0.9, nb + 2], [CX + side * nw * 0.55, nb + 30], [CX + side * 5, clipY - 2]];
        b.add({ id: 'lanyard-strap' + side, g: 'body', d: openSpline(pts), fill: 'none', stroke: line, sw: 11.5 });
        b.add({ id: 'lanyard-strapLit' + side, g: 'body', d: openSpline(pts), fill: 'none', stroke: c, sw: 8.5 });
        b.add({ id: 'lanyard-stitch' + side, g: 'body', d: openSpline(pts), fill: 'none', stroke: shade(c, 0.45), sw: 1.4, op: 0.55 });
      }
      metalGrad(ctx, 'lanyard-g', metal, CX - 8, clipY - 6, CX + 8, clipY + 22);
      b.add({ id: 'lanyard-ring', g: 'body', d: ring(CX, clipY, 6.5, 6.5, 2.4), fill: 'lanyard-g', stroke: M.line, sw: 1 });
      b.add({ id: 'lanyard-clip', g: 'body', d: rrect(CX - 4.5, clipY + 4, 9, 16, 3), fill: 'lanyard-g', stroke: M.line, sw: 1.2 });
      const cy0 = clipY + 18;
      const cw = 58;
      const chh = 74;
      b.add({ id: 'lanyard-card', g: 'body', d: rrect(CX - cw / 2, cy0, cw, chh, 7), fill: '#F7F6F2', stroke: '#8E959E', sw: 2 });
      b.add({ id: 'lanyard-band', g: 'body', d: rrect(CX - cw / 2, cy0, cw, 17, 7), fill: c, clip: 'lanyard-card' });
      b.add({ id: 'lanyard-slot', g: 'body', d: rrect(CX - 8, cy0 + 5, 16, 4.5, 2.2), fill: '#5B6068', op: 0.75 });
      b.add({ id: 'lanyard-photo', g: 'body', d: rrect(CX - 21, cy0 + 24, 19, 23, 3), fill: '#C9D6E3', stroke: '#9AA7B5', sw: 1.2 });
      b.add({ id: 'lanyard-lines', g: 'body', d: compound(rrect(CX + 2, cy0 + 27, 19, 4.5, 2.2), rrect(CX + 2, cy0 + 36, 14, 4.5, 2.2), rrect(CX - 21, cy0 + 55, 42, 4.5, 2.2)), fill: '#B9BEC6' });
      b.add({ id: 'lanyard-gloss', g: 'body', d: openSpline([[CX - cw / 2 + 6, cy0 + 22], [CX - cw / 2 + 6, cy0 + chh - 8]]), fill: 'none', stroke: '#FFFFFF', sw: 2.4, op: 0.5 });
    },
  },

  // ------------------------------------------------------------ face accents
  'nose-stud': {
    name: 'Nose stud', slot: 'face', note: 'a tiny sparkling nose stud',
    skin(ctx) {
      const { b, f, r, CX } = ctx;
      const metal = metalOf(ctx, 'silver');
      const M = METALS[metal];
      const k = 0.85 + 0.35 * (r.nose ? r.nose.size : 0.5);
      const ns = r.nose && r.nose.shape;
      const wide = ns === 'wide' ? 1.3 : ns === 'pointed' ? 0.8 : 1;
      const x = CX + 19 * k * wide;
      const y = f.noseY - 8 * k;
      metalGrad(ctx, 'nose-stud-g', metal, x - 4, y - 4, x + 4, y + 4);
      b.add({ id: 'nose-stud-set', g: 'nose', d: ellipse(x, y, 4.4, 4.4), fill: 'nose-stud-g', stroke: M.line, sw: 1.1 });
      b.add({ id: 'nose-stud-gem', g: 'nose', d: ellipse(x - 0.3, y - 0.3, 2.6, 2.6), fill: '#E6F5FF' });
      b.add({ id: 'nose-stud-glint', g: 'nose', d: twinkle(x - 1, y - 1.2, 2.6), fill: '#FFFFFF', op: 0.95 });
    },
  },
  'nose-ring': {
    name: 'Nose ring', slot: 'face', note: 'a small hoop nose ring',
    skin(ctx) {
      const { b, f, r, CX } = ctx;
      const metal = metalOf(ctx, 'silver');
      const M = METALS[metal];
      const k = 0.85 + 0.35 * (r.nose ? r.nose.size : 0.5);
      const ns = r.nose && r.nose.shape;
      const wide = ns === 'wide' ? 1.3 : ns === 'pointed' ? 0.8 : 1;
      const cx = CX + 24 * k * wide;
      const cy = f.noseY + 1;
      const rr = 7.5;
      const pts = arcPts(cx, cy, rr, rr, -125, 150, 7);
      metalGrad(ctx, 'nose-ring-g', metal, cx - rr, cy - rr, cx + rr, cy + rr);
      b.add({ id: 'nose-ring-under', g: 'nose', d: openSpline(pts), fill: 'none', stroke: M.line, sw: 4.2 });
      b.add({ id: 'nose-ring-wire', g: 'nose', d: openSpline(pts), fill: 'none', stroke: 'nose-ring-g', sw: 2.4 });
      b.add({ id: 'nose-ring-glint', g: 'nose', d: ellipse(cx + rr * 0.72, cy - rr * 0.35, 1.3, 1.6), fill: '#FFFFFF', op: 0.85 });
    },
  },
  'brow-piercing': {
    name: 'Eyebrow piercing', slot: 'face', note: 'a small barbell piercing through one eyebrow',
    skin(ctx) {
      const { b, f, r, CX } = ctx;
      const metal = metalOf(ctx, 'silver');
      const M = METALS[metal];
      const bs = BROW_SHAPES[r.brows && r.brows.shape] || BROW_SHAPES['soft-arch'];
      const es = EYE_SHAPES[r.eyes && r.eyes.shape] || EYE_SHAPES.round;
      const ew = 74 * (0.86 + 0.28 * (r.eyes ? r.eyes.size : 0.5)) * (es.size || 1);
      const len = ew * 1.12;
      const th = 11 * (0.7 + 0.6 * (r.brows ? r.brows.thickness : 0.5)) * bs.t;
      const side = 1;
      const cx = CX + side * f.eyeDX;
      // the same centre line kit.mjs draws the brow on (viewer's right brow)
      const at = (t, p) => {
        const raise = p.raise || 0;
        const lower = p.lower || 0;
        const furrow = p.furrow || 0;
        const sad = p.sad || 0;
        const x = cx + side * (-len * 0.48 + len * t) + side * furrow * 7 * (1 - t) * -1;
        const archY = -bs.arch * Math.sin(Math.PI * Math.min(1, t / bs.peak) * 0.5) * (t <= bs.peak ? 1 : 1 - ((t - bs.peak) / (1 - bs.peak)) * 0.55);
        let y = f.browY + archY + bs.inner * (1 - t) + t * 4;
        y -= raise * (14 - 3 * t);
        y += lower * (7 + 3 * (1 - t));
        y += furrow * 11 * (1 - t) * (1 - t);
        y -= sad * 13 * (1 - t) * (1 - t);
        y += sad * 5 * t;
        return [x, y];
      };
      const T = 0.8;
      const half = th * 0.33 + 2.6;
      const ball = 3.8;
      const ends = (p) => {
        const [x, y] = at(T, p);
        const [x2, y2] = at(T + 0.04, p);
        const l = Math.hypot(x2 - x, y2 - y) || 1;
        let nx = -(y2 - y) / l;
        let ny = (x2 - x) / l;
        if (ny < 0) {
          nx = -nx;
          ny = -ny;
        }
        return [[x - nx * half, y - ny * half], [x + nx * half, y + ny * half]];
      };
      const balls = (p) => compound(...ends(p).map(([x, y]) => ellipse(x, y, ball, ball)));
      const glints = (p) => compound(...ends(p).map(([x, y]) => ellipse(x - 1.2, y - 1.3, 1.3, 1.1)));
      const ch = [['brow.raise', { raise: 1 }], ['brow.raise', { lower: 1 }, true], ['brow.furrow', { furrow: 1 }], ['brow.sad', { sad: 1 }], ['brow.asym', { raise: 0.9 }]];
      const [px, py] = at(T, {});
      metalGrad(ctx, 'brow-piercing-g', metal, px - 6, py - half - 6, px + 6, py + half + 6);
      b.add({ id: 'brow-piercing-balls', g: 'face', ...morphable(balls, {}, ch), fill: 'brow-piercing-g', stroke: M.line, sw: 1.2 });
      b.add({ id: 'brow-piercing-glint', g: 'face', ...morphable(glints, {}, ch), fill: '#FFFFFF', op: 0.85 });
    },
  },
};

