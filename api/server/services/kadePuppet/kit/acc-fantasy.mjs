// Fantasy accessories for the puppet kit (see CONVENTIONS.md): wings and a glow aura
// (slot 'back'), a halo, horns and antennae, and animal ears.
//
// Back pieces draw in `behind` on groups parented to `body`, pivoting at the shoulder
// blade and rotating with extras.flap (mirrored on the left). Head pieces draw in
// `headwear` on groups parented to `head`; they sit on the hair surface, which is
// estimated per hair style (HAIR_LIFT) so nothing floats or sinks on tall or flat hair,
// and they slide outward on the head when the hair is too tall for them to fit in view.
import { closedSpline, openSpline, closedMixed, ellipse, taper, mix, shade, lerp, rotatePt, hexToRgb, luminance } from './geom.mjs';

const CX = 500;
const VIEW_TOP = 40;

// ---------------------------------------------------------------- helpers
function morph(fn, base, channels) {
  const d = fn(base);
  const m = [];
  for (const [c, patch, neg] of channels) {
    const t = fn({ ...base, ...patch });
    if (t.length !== d.length) throw new Error('morph structure mismatch on ' + c);
    m.push(neg ? { c, d: t, n: true } : { c, d: t });
  }
  return { d, m };
}

function group(b, id, parent, pivot, drives) {
  if (!b.groups.some((g) => g.id === id)) b.group(id, parent, pivot, drives);
  return id;
}

const clamp = (v, a, z) => Math.max(a, Math.min(z, v));
const add2 = (a, c) => [a[0] + c[0], a[1] + c[1]];
const mul2 = (a, s) => [a[0] * s, a[1] * s];
const norm = ([x, y]) => {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
};
const lerp2 = (a, c, t) => [lerp(a[0], c[0], t), lerp(a[1], c[1], t)];
const r1 = (n) => Math.round(n * 10) / 10;

function shiftPath(d, dx, dy) {
  return d.map((c) => ({ op: c.op, v: c.v.map((n, i) => r1(n + (i % 2 ? dy : dx))) }));
}

// the half of an ellipse() path: 'bottom' runs right -> bottom -> left, 'top' left -> top -> right
function halfEllipse(cx, cy, rx, ry, which) {
  const e = ellipse(cx, cy, rx, ry);
  if (which === 'bottom') return [e[0], e[1], e[2]];
  return [{ op: 'M', v: [e[2].v[4], e[2].v[5]] }, e[3], e[4]];
}

// four-pointed sparkle
function sparkle(cx, cy, r) {
  const k = r * 0.2;
  return closedMixed([[cx, cy - r, true], [cx + k, cy - k], [cx + r, cy, true], [cx + k, cy + k], [cx, cy + r, true], [cx - k, cy + k], [cx - r, cy, true], [cx - k, cy - k]]);
}

// Catmull-Rom curve through control points, sampled by arc length: s in 0..1 -> point
function curve(ctrl) {
  const dense = [];
  const n = ctrl.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)];
    const p1 = ctrl[i];
    const p2 = ctrl[i + 1];
    const p3 = ctrl[Math.min(n - 1, i + 2)];
    for (let j = 0; j < 16; j++) {
      const t = j / 16;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      dense.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  dense.push(ctrl[n - 1]);
  const acc = [0];
  for (let i = 1; i < dense.length; i++) acc.push(acc[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
  const total = acc[acc.length - 1] || 1;
  return (s) => {
    const want = clamp(s, 0, 1) * total;
    let i = 1;
    while (i < acc.length - 1 && acc[i] < want) i++;
    const t = (want - acc[i - 1]) / (acc[i] - acc[i - 1] || 1);
    return lerp2(dense[i - 1], dense[i], clamp(t, 0, 1));
  };
}

// ---------------------------------------------------------------- colour
function saturation(hex) {
  const [r, g, b] = hexToRgb(hex);
  const mx = Math.max(r, g, b);
  return mx ? (mx - Math.min(r, g, b)) / mx : 0;
}
// the accent when it is a real colour, otherwise a pretty fallback
function vivid(hex, fallback) {
  if (saturation(hex) < 0.3) return fallback;
  if (luminance(hex) < 0.05) return mix(hex, '#FFFFFF', 0.35);
  return hex;
}
// glows must read as light, so dark accents are lifted toward a pastel
function glowColor(hex) {
  const L = luminance(hex);
  return L < 0.3 ? mix(hex, '#FFFFFF', Math.min(0.62, 0.3 + (0.3 - L) * 1.3)) : hex;
}

// ---------------------------------------------------------------- the head and its hair
// How far each hair style rises above the bare skull: [front hair at the centre,
// hair near the top of the temples (about 0.6 of the crown width out), the highest
// point including back masses such as a bun].
const HAIR_LIFT = {
  bald: [0, 0, 0],
  buzz: [12, 16, 12],
  'short-crop': [24, 25, 24],
  'side-part': [34, 31, 34],
  pompadour: [66, 54, 66],
  spiky: [50, 31, 50],
  'curly-short': [36, 36, 36],
  afro: [40, 140, 142],
  bob: [28, 27, 28],
  pixie: [28, 27, 28],
  'shoulder-wavy': [32, 29, 32],
  'long-straight': [26, 26, 26],
  'long-curly': [36, 34, 46],
  bun: [20, 22, 94],
  ponytail: [22, 23, 22],
  braids: [22, 23, 22],
  'curtain-long': [28, 27, 28],
  mohawk: [112, 14, 112],
  locs: [30, 28, 30],
};
const liftOf = (ctx) => HAIR_LIFT[ctx.hairStyle] || [30, 28, 32];
const bareScalp = (ctx) => ['bald', 'buzz', 'mohawk'].includes(ctx.hairStyle);

// superellipse that follows the top of the head plus its hair
function sideDome(ctx) {
  const { k } = ctx;
  if (ctx.hairStyle === 'afro') return { cx: CX, cy: k.top + k.H * 0.28, rx: (k.w + 92) * 0.94, ry: (k.H * 0.55 + 30) * 0.94, p: 2 };
  const s = liftOf(ctx)[1];
  return { cx: CX, cy: k.top + k.H * 0.3, rx: k.w * 0.98 + s * 0.7, ry: k.H * 0.3 + s, p: 2.4 };
}

function domeAt(d, t) {
  const sg = t < 0 ? -1 : 1;
  const at = Math.min(0.96, Math.abs(t));
  const sy = Math.pow(1 - Math.pow(at, d.p), 1 / d.p);
  const p = [d.cx + sg * at * d.rx, d.cy - sy * d.ry];
  const n = norm([(sg * Math.pow(at, d.p - 1)) / d.rx, -Math.pow(sy, d.p - 1) / d.ry]);
  return { p, n };
}

// A seat on the hair at horizontal fraction t (negative = viewer's left). The part's axis
// leans `lean` of the way from straight up toward the surface normal. If a part `reach`
// long would leave the top of the view, the seat slides outward down the dome.
// maxReach says how long the part may be at the final seat.
function seat(ctx, t, lean, reach) {
  const d = sideDome(ctx);
  const sg = t < 0 ? -1 : 1;
  const t0 = Math.abs(t);
  let tt = t0;
  let s;
  for (let i = 0; i < 16; i++) {
    s = domeAt(d, sg * tt);
    // parts pushed down the side of tall hair also splay outward, as they would
    const ln = Math.min(0.85, lean + (tt - t0) * 1.1);
    s.axis = norm([lerp(0, s.n[0], ln), lerp(-1, s.n[1], ln)]);
    s.maxReach = (s.p[1] - (VIEW_TOP + 26)) / Math.max(0.2, -s.axis[1]);
    if (s.maxReach >= reach || tt >= 0.86) break;
    tt += 0.04;
  }
  return s;
}

// perpendicular to an axis, pointing away from the centre line on `side`
const outward = (ax, side) => [side * -ax[1], side * ax[0]];
// local (along, out) -> scene point
const loc = (B, ax, q, a, o) => [B[0] + ax[0] * a + q[0] * o, B[1] + ax[1] * a + q[1] * o];
// head turn squeezes the far side and widens the near side, like the head outline
const yawPt = ([x, y, c], turn, side) => [CX + (x - CX) * (1 - 0.06 * (turn || 0) * side), y, c];

const HEAD_DRIVES = { tx: [['head.yaw', 13]], ty: [['head.pitch', 6]] };
const YAW_CH = [['head.yaw', { turn: 1 }], ['head.yaw', { turn: -1 }, true]];
const SWING_CH = [['hair.swing', { swing: 1 }], ['hair.swing', { swing: -1 }, true]];

// a rotated ellipse as a smooth closed path (8 points), for shadows and plates
function tiltedEllipse(c, ax, q, ra, ro) {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    pts.push(loc(c, ax, q, Math.sin(a) * ra, Math.cos(a) * ro));
  }
  return pts;
}

function bbox(pts) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

// ---------------------------------------------------------------- wings
function wingBox(ctx) {
  const { f, S } = ctx;
  const nb = f.neckBase;
  return { rootDX: S * 0.3, rootY: nb + 70, outer: Math.min(S + 76, 322), top: Math.max(nb - 400, VIEW_TOP + 70) };
}
// wing space: u 0 at the root -> 1 at the outer reach, v 0 at the root -> 1 at the top
function wingMap(box, side) {
  return ([u, v]) => [CX + side * (box.rootDX + u * (box.outer - box.rootDX)), box.rootY - v * (box.rootY - box.top)];
}
function wingGroup(ctx, id, side, box, gain = 0.09) {
  const gid = id + (side > 0 ? '-R' : '-L');
  group(ctx.b, gid, 'body', [CX + side * box.rootDX, box.rootY], { r: [['extras.flap', side * gain]] });
  return gid;
}

function angelWing(ctx, id, side) {
  const { b } = ctx;
  const box = wingBox(ctx);
  const P = wingMap(box, side);
  const g = wingGroup(ctx, id, side, box);
  const sx = g;
  const A = curve([[1.0, 0.84], [0.84, 0.98], [0.62, 1.0], [0.45, 0.87], [0.3, 0.6], [0.15, 0.3], [0, 0]].map(P));
  const E = curve([[1.0, 0.84], [1.03, 0.6], [0.99, 0.36], [0.9, 0.13], [0.74, -0.05], [0.48, -0.14], [0.2, -0.1], [0, 0]].map(P));
  const L = (fr, s) => lerp2(A(s), E(s), fr);
  // primaries (long, deeply split), secondaries, then small rounded coverts on top
  const rows = [
    { f: 1.0, n: 7, d: 0.2, len: 0.3, c0: '#F2F0F8', c1: '#C2BBD6' },
    { f: 0.66, n: 7, d: 0.15, len: 0.22, c0: '#FAF9FD', c1: '#D4CFE5' },
    { f: 0.36, n: 10, d: 0.08, len: 0.1, c0: '#FFFFFF', c1: '#E4E0EF' },
  ];
  const line = '#8C84A0';
  const rowPts = (row) => {
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const p = A(i / 6);
      pts.push(i === 0 || i === 6 ? [p[0], p[1], true] : p);
    }
    for (let i = row.n - 1; i >= 0; i--) {
      pts.push(L(row.f, (i + 0.5) / row.n));
      if (i > 0) {
        const q = L(row.f - row.d, i / row.n);
        pts.push([q[0], q[1], true]);
      }
    }
    return pts;
  };
  const gs = P([0.45, 1.0]);
  const ge = P([0.95, -0.05]);
  rows.forEach((row, j) => {
    const gid = `${sx}-fill${j}`;
    b.grad(gid, { kind: 'linear', start: gs, end: ge, stops: [{ at: 0, color: row.c0 }, { at: 1, color: row.c1 }] });
    const d = closedMixed(rowPts(row));
    if (j > 0) b.add({ id: `${sx}-shadow${j}`, g, d: shiftPath(d, side * 4, 7), fill: '#3E3758', op: 0.16, clip: `${sx}-row${j - 1}` });
    b.add({ id: `${sx}-row${j}`, g, d, fill: gid, stroke: line, sw: 2.6 });
    const lines = [];
    for (let i = 1; i < row.n; i++) {
      const s = i / row.n;
      lines.push(...openSpline([L(row.f - row.d, s), L(row.f - row.d - row.len, s - 0.012)]));
    }
    b.add({ id: `${sx}-quills${j}`, g, d: lines, fill: 'none', stroke: line, sw: 2, op: 0.5, clip: `${sx}-row${j}` });
  });
  const hl = [];
  for (let i = 0; i < 6; i++) hl.push(L(0.08, 0.06 + i * 0.1));
  b.add({ id: `${sx}-shine`, g, d: openSpline(hl), fill: 'none', stroke: '#FFFFFF', sw: 4, op: 0.75, clip: `${sx}-row2` });
}

// bat and dragon: a membrane stretched between finger bones
function membraneWing(ctx, id, side, o) {
  const { b } = ctx;
  const box = wingBox(ctx);
  const P = wingMap(box, side);
  const g = wingGroup(ctx, id, side, box);
  const sx = g;
  const R0 = P([0, 0]);
  const El = P(o.elbow);
  const Wr = P(o.wrist);
  const tips = o.tips.map(P);
  const back = P(o.back);
  const pull = (a, c, k, to) => lerp2(lerp2(a, c, 0.5), to, k);
  const pts = [[Wr[0], Wr[1], true], P(o.lead), [tips[0][0], tips[0][1], true]];
  const mids = [];
  for (let i = 0; i < tips.length - 1; i++) {
    const m = pull(tips[i], tips[i + 1], o.scallop, Wr);
    mids.push(m);
    pts.push(m, [tips[i + 1][0], tips[i + 1][1], true]);
  }
  const mLast = pull(tips[tips.length - 1], back, o.scallop * 0.8, El);
  mids.push(mLast);
  pts.push(mLast, [back[0], back[1], true], [R0[0], R0[1], true], El);
  b.grad(sx + '-fill', { kind: 'linear', start: lerp2(Wr, tips[0], 0.3), end: lerp2(tips[2], back, 0.4), stops: [{ at: 0, color: o.c0 }, { at: 0.55, color: o.c1 }, { at: 1, color: o.c2 }] });
  b.add({ id: sx + '-skin', g, d: closedMixed(pts), fill: sx + '-fill', stroke: shade(o.c2, -0.45), sw: 2.8 });
  // soft folds of the membrane between the fingers
  const folds = [];
  for (const m of mids) folds.push(...openSpline([lerp2(Wr, m, 0.25), lerp2(Wr, m, 0.62), lerp2(Wr, m, 0.92)]));
  b.add({ id: sx + '-folds', g, d: folds, fill: 'none', stroke: shade(o.c0, 0.25), sw: 3, op: 0.22, clip: sx + '-skin' });
  if (o.veins) {
    const vs = [];
    tips.forEach((t, i) => {
      if (i === 0) return;
      const a = lerp2(Wr, t, 0.55);
      const m = mids[i - 1];
      vs.push(...openSpline([a, lerp2(a, m, 0.5), lerp2(a, m, 0.85)]));
    });
    b.add({ id: sx + '-veins', g, d: vs, fill: 'none', stroke: o.bone, sw: 2, op: 0.35, clip: sx + '-skin' });
  }
  // bones: the arm, then each finger, as tapered strokes
  const bones = [taper([R0, El, Wr], [o.arm * 1.3, o.arm, o.arm * 0.85])];
  for (const t of tips) {
    const dir = norm([t[0] - Wr[0], t[1] - Wr[1]]);
    const bow = [-dir[1] * side * -1, dir[0] * side * -1];
    const mid = add2(lerp2(Wr, t, 0.5), mul2(bow, -5));
    bones.push(taper([Wr, mid, t], [o.finger, o.finger * 0.62, o.finger * 0.25]));
  }
  b.add({ id: sx + '-bones', g, d: bones.flat(), fill: o.bone, stroke: shade(o.bone, -0.35), sw: 1.4 });
  // light along the top of the arm
  b.add({ id: sx + '-shine', g, d: openSpline([lerp2(El, Wr, 0.1), lerp2(El, Wr, 0.55), lerp2(El, Wr, 0.95)].map(([x, y]) => [x - side * 2.5, y - 2])), fill: 'none', stroke: '#FFFFFF', sw: 2.6, op: 0.35, clip: sx + '-bones' });
  // thumb claw at the wrist, and spikes at the finger tips for dragons
  const s = o.claw;
  const claw = closedMixed([[Wr[0] - side * 6 * s, Wr[1] + 4 * s, true], [Wr[0] - side * 4 * s, Wr[1] - 14 * s], [Wr[0] - side * 13 * s, Wr[1] - 30 * s, true], [Wr[0] + side * 4 * s, Wr[1] - 16 * s], [Wr[0] + side * 7 * s, Wr[1] + 2 * s, true]]);
  const spikes = [claw];
  if (o.spikes) {
    for (const t of tips) {
      const dir = norm([t[0] - Wr[0], t[1] - Wr[1]]);
      const per = [-dir[1], dir[0]];
      spikes.push(closedMixed([[...add2(t, mul2(per, 4.5)), true], [...add2(t, mul2(dir, 15)), true], [...add2(t, mul2(per, -4.5)), true]]));
    }
    const ed = norm([El[0] - R0[0], El[1] - R0[1]]);
    const ep = [side * -ed[1], side * ed[0]];
    spikes.push(closedMixed([[...add2(El, mul2(ed, -8)), true], [...add2(add2(El, mul2(ep, 14)), mul2(ed, 6)), true], [...add2(El, mul2(ed, 8)), true]]));
  }
  b.add({ id: sx + '-claws', g, d: spikes.flat(), fill: o.claws, stroke: shade(o.claws, -0.45), sw: 1.6 });
}

function butterflyWing(ctx, id, side) {
  const { b, colors, f } = ctx;
  const box = { ...wingBox(ctx), rootY: f.neckBase + 20 };
  const P = wingMap(box, side);
  const g = wingGroup(ctx, id, side, box, 0.1);
  const sx = g;
  const main = vivid(colors.accent, '#EE7C35');
  const dark = mix(shade(main, -0.72), '#1E1A26', 0.4);
  const light = '#FFF6E6';
  const R0 = P([0, 0]);
  b.grad(sx + '-fill', { kind: 'radial', center: P([0.05, 0.12]), radius: Math.hypot(...[0, 1].map((i) => P([1, 1])[i] - R0[i])) * 0.95, stops: [{ at: 0, color: shade(main, -0.45) }, { at: 0.42, color: main }, { at: 1, color: shade(main, 0.32) }] });
  const lobes = {
    hind: { pts: [[0, 0], [0.3, 0.3], [0.62, 0.4], [0.86, 0.36], [1.0, 0.2], [0.98, 0.0], [0.84, -0.14], [0.6, -0.2], [0.34, -0.16], [0.14, -0.06]], margin: [0.2, 0.8], veins: [2, 3, 4, 5, 6, 7] },
    fore: { pts: [[0, 0], [0.12, 0.38], [0.32, 0.75], [0.58, 0.97], [0.84, 1.0], [1.02, 0.86], [1.06, 0.64], [0.96, 0.48], [0.74, 0.38], [0.46, 0.27], [0.2, 0.1]], margin: [0.3, 0.68], veins: [2, 3, 4, 5, 6, 7, 8] },
  };
  for (const name of ['hind', 'fore']) {
    const lb = lobes[name];
    const pts = lb.pts.map(P);
    const d = closedSpline(pts);
    const lid = `${sx}-${name}`;
    b.add({ id: lid, g, d, fill: sx + '-fill', stroke: dark, sw: 3 });
    const cen = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
    const vs = [];
    for (const i of lb.veins) {
      const m = pts[i];
      const mid = lerp2(R0, m, 0.5);
      vs.push(...openSpline([lerp2(R0, m, 0.08), add2(mid, mul2(norm([cen[0] - mid[0], cen[1] - mid[1]]), -6)), lerp2(R0, m, 0.96)]));
    }
    b.add({ id: lid + '-veins', g, d: vs, fill: 'none', stroke: dark, sw: 2.4, op: 0.55, clip: lid });
    b.add({ id: lid + '-edge', g, d, fill: 'none', stroke: dark, sw: 24, clip: lid });
    const edge = curve([...pts, pts[0]]);
    const dots = [];
    const [m0, m1] = lb.margin;
    for (let s = m0; s <= m1 + 1e-6; s += (m1 - m0) / 9) {
      const e = edge(s);
      const p = add2(e, mul2(norm([cen[0] - e[0], cen[1] - e[1]]), 6));
      dots.push(ellipse(p[0], p[1], 3.6, 3.6));
    }
    b.add({ id: lid + '-dots', g, d: dots.flat(), fill: light, op: 0.95, clip: lid });
    if (name === 'hind') {
      const c = P([0.7, 0.06]);
      b.add({ id: lid + '-eye', g, d: ellipse(c[0], c[1], 15, 13), fill: dark });
      b.add({ id: lid + '-eye2', g, d: ellipse(c[0], c[1], 9, 8), fill: shade(main, 0.55) });
      b.add({ id: lid + '-eye3', g, d: ellipse(c[0] - side * 2, c[1] - 2, 3.4, 3.4), fill: '#FFFFFF', op: 0.95 });
    } else {
      const spots = [[0.78, 0.86, 7], [0.88, 0.78, 6], [0.8, 0.74, 4.5]].map(([u, v, r]) => ellipse(...P([u, v]), r, r * 0.85));
      b.add({ id: lid + '-spot', g, d: spots.flat(), fill: light, op: 0.92, clip: lid });
    }
  }
}

function fairyWing(ctx, id, side) {
  const { b } = ctx;
  const box = wingBox(ctx);
  const P = wingMap(box, side);
  const g = wingGroup(ctx, id, side, box, 0.12);
  const sx = g;
  const rim = '#B9A6EE';
  const lobes = {
    low: { pts: [[0.02, 0.02], [0.35, 0.12], [0.66, 0.16], [0.86, 0.08], [0.9, -0.06], [0.74, -0.16], [0.45, -0.14], [0.18, -0.06]], veins: [2, 3, 4, 5], from: [0.86, 0.0] },
    up: { pts: [[0.02, 0.08], [0.22, 0.5], [0.45, 0.86], [0.68, 1.02], [0.86, 1.0], [0.93, 0.86], [0.82, 0.62], [0.55, 0.36], [0.25, 0.14]], veins: [2, 3, 4, 5, 6], from: [0.2, 0.98] },
  };
  for (const name of ['low', 'up']) {
    const lb = lobes[name];
    const pts = lb.pts.map(P);
    const lid = `${sx}-${name}`;
    b.grad(lid + '-fill', { kind: 'linear', start: P([0.05, 0.05]), end: P(lb.from), stops: [
      { at: 0, color: '#FFB8E8', opacity: 0.6 }, { at: 0.35, color: '#CDB8FF', opacity: 0.5 },
      { at: 0.7, color: '#9FEAF4', opacity: 0.5 }, { at: 1, color: '#C6FFD6', opacity: 0.62 }] });
    const d = closedSpline(pts);
    b.add({ id: lid, g, d, fill: lid + '-fill', stroke: rim, sw: 2.6 });
    b.add({ id: lid + '-rim', g, d, fill: 'none', stroke: '#FFFFFF', sw: 7, op: 0.35, clip: lid });
    const R0 = pts[0];
    const vs = [];
    for (const i of lb.veins) {
      const m = pts[i];
      vs.push(...openSpline([lerp2(R0, m, 0.06), lerp2(R0, m, 0.5), lerp2(R0, m, 0.93)]));
    }
    b.add({ id: lid + '-veins', g, d: vs, fill: 'none', stroke: '#FFFFFF', sw: 1.8, op: 0.55, clip: lid });
  }
  const sp = [[0.62, 0.86, 9], [0.4, 0.55, 6], [0.78, 0.66, 5], [0.6, 0.02, 7], [0.82, 0.98, 5]].map(([u, v, r]) => sparkle(...P([u, v]), r));
  b.add({ id: sx + '-sparkles', g, d: sp.flat(), fill: '#FFFFFF', op: 0.8, oc: [['extras.float', 0.2]] });
}

// ---------------------------------------------------------------- halo
function topShape(ctx) {
  const { k } = ctx;
  const st = ctx.hairStyle;
  if (st === 'afro') return { cx: CX, cy: k.top + k.H * 0.28, rx: k.w + 92, ry: k.H * 0.55 + 30 };
  if (st === 'bun') return { cx: CX + 6, cy: k.top - 44, rx: 58, ry: 50 };
  if (st === 'mohawk') return { cx: CX, cy: k.top - 40, rx: 48, ry: 72 };
  const cap = liftOf(ctx)[2];
  return { cx: CX, cy: k.top + k.H * 0.3, rx: k.w + 8, ry: k.H * 0.3 + cap };
}

function haloGeom(ctx) {
  const { k } = ctx;
  const band = 11;
  const rx0 = k.w * 0.62;
  const top = topShape(ctx);
  const hairTop = top.cy - top.ry;
  for (const [rf, gap] of [[0.24, 26], [0.22, 18], [0.19, 11], [0.17, 7]]) {
    const ry = rx0 * rf;
    const cy = hairTop - gap - ry - band / 2;
    if (cy - ry - band / 2 - 8 >= VIEW_TOP) return { cx: CX, cy, rx: rx0, ry, band, wrap: false };
  }
  // No room above the hair inside the view: the ring circles the top of the hair
  // instead, its back half passing behind the hair and its front half in front.
  let rx = rx0;
  let ry = rx * 0.19;
  let cy = 0;
  for (let i = 0; i < 3; i++) {
    ry = Math.min(rx * 0.19, 26);
    cy = VIEW_TOP + ry + band / 2 + 9;
    const yy = cy + ry * 0.6;
    const dy = (top.cy - yy) / top.ry;
    const half = Math.abs(dy) < 1 ? top.rx * Math.sqrt(1 - dy * dy) : 0;
    rx = Math.max(rx0, half + 22);
  }
  return { cx: top.cx, cy, rx, ry, band, wrap: true };
}

function haloParts(ctx, which) {
  const { b } = ctx;
  const h = haloGeom(ctx);
  const g = group(b, 'halo-float', 'head', [h.cx, h.cy], { tx: [['head.yaw', 11]], ty: [['extras.float', 7], ['head.pitch', 4]] });
  b.grad('halo-gold', { kind: 'linear', start: [h.cx - h.rx, h.cy - h.ry * 2], end: [h.cx + h.rx, h.cy + h.ry * 2], stops: [{ at: 0, color: '#FFF2B0' }, { at: 0.45, color: '#F7C846' }, { at: 1, color: '#D38F1A' }] });
  const half = which === 'back' ? 'top' : 'bottom';
  if (which === 'back') {
    // soft glow: stacked wide strokes fading outward
    b.add({ id: 'halo-glow3', g, d: ellipse(h.cx, h.cy, h.rx, h.ry), fill: 'none', stroke: '#FFE58C', sw: h.band * 5, op: 0.06, oc: [['extras.float', 0.03]] });
    b.add({ id: 'halo-glow2', g, d: ellipse(h.cx, h.cy, h.rx, h.ry), fill: 'none', stroke: '#FFE58C', sw: h.band * 3.5, op: 0.08, oc: [['extras.float', 0.03]] });
    b.add({ id: 'halo-glow1', g, d: ellipse(h.cx, h.cy, h.rx, h.ry), fill: 'none', stroke: '#FFEBA6', sw: h.band * 2.2, op: 0.13, oc: [['extras.float', 0.04]] });
  }
  b.add({ id: `halo-${which}-edge`, g, d: halfEllipse(h.cx, h.cy, h.rx, h.ry, half), fill: 'none', stroke: '#A06A14', sw: h.band + 5, cap: 'butt' });
  b.add({ id: `halo-${which}`, g, d: halfEllipse(h.cx, h.cy, h.rx, h.ry, half), fill: 'none', stroke: 'halo-gold', sw: h.band, cap: 'butt' });
  // a bright glint on the upper-left of each half
  const arc = (a0, a1, dy) => {
    const pts = [];
    for (let i = 0; i <= 4; i++) {
      const a = lerp(a0, a1, i / 4);
      pts.push([h.cx + Math.cos(a) * h.rx, h.cy + Math.sin(a) * h.ry + dy]);
    }
    return openSpline(pts);
  };
  if (which === 'back') b.add({ id: 'halo-back-glint', g, d: arc(Math.PI * 1.12, Math.PI * 1.38, -2), fill: 'none', stroke: '#FFFBE6', sw: 3, op: 0.75 });
  else b.add({ id: 'halo-front-glint', g, d: arc(Math.PI * 0.62, Math.PI * 0.86, -2.5), fill: 'none', stroke: '#FFFBE6', sw: 3, op: 0.85 });
}

// ---------------------------------------------------------------- horns
function devilHorns(ctx) {
  const { b, k } = ctx;
  const g = group(b, 'devil-horns-g', 'head', [CX, k.top], HEAD_DRIVES);
  const L0 = k.w * 0.5;
  const red = '#CF353A';
  for (const side of [-1, 1]) {
    const s = seat(ctx, side * 0.42, 0.55, L0 * 0.9);
    const L = clamp(s.maxReach * 1.08, L0 * 0.6, L0);
    const ax = s.axis;
    const q = outward(ax, side);
    const B = add2(s.p, mul2(ax, -L * 0.16));
    const sx = 'devil-horns-' + (side > 0 ? 'R' : 'L');
    const widths = [0.46, 0.38, 0.26, 0.13, 0.03].map((w) => w * L);
    const center = (p) => [[0, 0], [0.32, 0.13], [0.62, 0.16], [0.86, 0.06], [1.0, -0.1]].map(([u, o]) => yawPt(loc(B, ax, q, u * L, o * L), p.turn, side));
    const [x0, y0, x1, y1] = bbox(center({}));
    b.grad(sx + '-fill', { kind: 'linear', start: [x0 - 10, y0], end: [x1 + 10, y1 + 10], stops: [{ at: 0, color: '#F2736A' }, { at: 0.5, color: red }, { at: 1, color: '#8C1D26' }] });
    b.add({ id: sx + '-shadow', g, ...morph((p) => closedSpline(tiltedEllipse(B, ax, q, L * 0.08, L * 0.32).map((pt) => yawPt(pt, p.turn, side))), {}, YAW_CH), fill: '#2A0E14', op: 0.22 });
    b.add({ id: sx, g, ...morph((p) => taper(center(p), widths), {}, YAW_CH), fill: sx + '-fill', stroke: shade(red, -0.45), sw: 2.6 });
    b.add({ id: sx + '-shine', g, ...morph((p) => openSpline(center(p).slice(0, 4).map(([x, y], i) => [x - widths[i] * 0.22, y - widths[i] * 0.04])), {}, YAW_CH), fill: 'none', stroke: '#FFFFFF', sw: 3, op: 0.38, clip: sx });
  }
}

function ramHorns(ctx) {
  const { b, k } = ctx;
  const g = group(b, 'ram-horns-g', 'head', [CX, k.top], HEAD_DRIVES);
  const horn = '#D9C29A';
  const d = sideDome(ctx);
  const n = 15;
  for (const side of [-1, 1]) {
    const sx = 'ram-horns-' + (side > 0 ? 'R' : 'L');
    // rooted on the upper head, hugging the hair outward, then curling down and
    // forward around the ear
    const s0 = seat(ctx, side * 0.46, 0.5, 0);
    const s1 = domeAt(d, side * 0.86);
    const X = (dx) => CX + side * dx;
    const ctrl = [
      add2(s0.p, mul2(s0.axis, -10)),
      add2(s1.p, mul2(s1.n, 10)),
      [X(k.wc + 46), k.temple - 4],
      [X(k.wc + 62), k.ear - 28],
      [X(k.wc + 38), k.ear + 22],
      [X(k.wc + 4), k.ear + 6],
      [X(k.wc + 10), k.ear - 34],
      [X(k.wc + 36), k.ear - 40],
    ];
    const along = curve(ctrl);
    const cen0 = [];
    for (let i = 0; i < n; i++) cen0.push(along(i / (n - 1)));
    const base = (turn) => cen0.map((p) => yawPt(p, turn, side));
    const wid = cen0.map((_, i) => k.w * (0.27 - 0.19 * (i / (n - 1))));
    const [x0, y0, x1, y1] = bbox(cen0);
    b.grad(sx + '-fill', { kind: 'linear', start: [x0, y0], end: [x1, y1], stops: [{ at: 0, color: '#F3E6CC' }, { at: 0.5, color: horn }, { at: 1, color: '#9C8159' }] });
    b.add({ id: sx + '-shadow', g, ...morph((p) => closedSpline(tiltedEllipse(cen0[0], s0.axis, outward(s0.axis, side), 6, wid[0] * 0.7).map((pt) => yawPt(pt, p.turn, side))), {}, YAW_CH), fill: '#2A1C10', op: 0.2 });
    b.add({ id: sx, g, ...morph((p) => taper(base(p.turn), wid), {}, YAW_CH), fill: sx + '-fill', stroke: shade(horn, -0.48), sw: 2.8 });
    const ridges = (p) => {
      const cen = base(p.turn);
      const out = [];
      for (let i = 1; i < cen.length - 1; i++) {
        const a = cen[i - 1];
        const c = cen[i + 1];
        const dir = norm([c[0] - a[0], c[1] - a[1]]);
        const per = [-dir[1], dir[0]];
        const w = wid[i] * 0.5;
        out.push(...openSpline([add2(cen[i], mul2(per, w)), add2(cen[i], mul2(dir, 3)), add2(cen[i], mul2(per, -w))]));
      }
      return out;
    };
    b.add({ id: sx + '-ridges', g, ...morph(ridges, {}, YAW_CH), fill: 'none', stroke: shade(horn, -0.4), sw: 2.2, op: 0.5, clip: sx });
    b.add({ id: sx + '-shine', g, ...morph((p) => openSpline(base(p.turn).slice(0, 7).map(([x, y], i) => [x - 2, y - wid[i] * 0.28])), {}, YAW_CH), fill: 'none', stroke: '#FFFFFF', sw: 3, op: 0.4, clip: sx });
  }
}

function unicornHorn(ctx) {
  const { b, k } = ctx;
  const baseY = k.top + k.H * 0.12;
  const g = group(b, 'unicorn-horn-g', 'head', [CX, baseY], { tx: [['head.yaw', 15]], ty: [['head.pitch', 8]] });
  const L = clamp(baseY - VIEW_TOP - 24, k.w * 0.45, k.w * 0.8);
  const w0 = k.w * 0.24;
  const cen = [[CX, baseY + 6], [CX + 1, baseY - L * 0.35], [CX + 2, baseY - L * 0.7], [CX + 3, baseY - L]];
  const wid = [w0, w0 * 0.72, w0 * 0.42, 2];
  b.grad('unicorn-horn-fill', { kind: 'linear', start: [CX - w0 * 0.6, baseY - L], end: [CX + w0 * 0.6, baseY - L * 0.4], stops: [{ at: 0, color: '#FFFFFF' }, { at: 0.45, color: '#F8EBC8' }, { at: 1, color: '#DDB463' }] });
  b.add({ id: 'unicorn-horn-shadow', g, d: ellipse(CX, baseY + 8, w0 * 0.75, w0 * 0.22), fill: '#3A2A1A', op: 0.2 });
  b.add({ id: 'unicorn-horn', g, d: taper(cen, wid), fill: 'unicorn-horn-fill', stroke: shade('#DDB463', -0.45), sw: 2.6 });
  const grooves = [];
  for (let i = 1; i <= 6; i++) {
    const a = i / 7.2;
    const y = baseY + 6 - a * (L + 6);
    const hw = lerp(w0, 2, a) * 0.6 + 2;
    grooves.push(...openSpline([[CX - hw, y + 4], [CX, y - 2], [CX + hw, y - 10]]));
  }
  b.add({ id: 'unicorn-horn-grooves', g, d: grooves, fill: 'none', stroke: shade('#DDB463', -0.3), sw: 2.4, op: 0.6, clip: 'unicorn-horn' });
  b.add({ id: 'unicorn-horn-shine', g, d: openSpline([[CX - w0 * 0.22, baseY - 4], [CX - w0 * 0.12, baseY - L * 0.5], [CX - 1, baseY - L * 0.86]]), fill: 'none', stroke: '#FFFFFF', sw: 3.2, op: 0.7, clip: 'unicorn-horn' });
  b.add({ id: 'unicorn-horn-sparkle', g, d: sparkle(CX + w0 * 0.75, baseY - L * 0.86, 9), fill: '#FFF6D2', op: 0.75, oc: [['extras.float', 0.25]] });
}

// stalks that bob with hair.swing; `robot` makes a single metal one
function stalks(ctx, id, opt) {
  const { b, k } = ctx;
  const g = group(b, id + '-g', 'head', [CX, k.top], HEAD_DRIVES);
  const sides = opt.sides;
  for (const side of sides) {
    const sx = id + (sides.length > 1 ? (side > 0 ? '-R' : '-L') : '');
    const L0 = k.w * opt.len;
    const s = seat(ctx, side * opt.t, opt.lean, L0 * 0.8 + opt.ball);
    const L = clamp(s.maxReach - opt.ball, L0 * 0.55, L0);
    const ax = s.axis;
    const q = outward(ax, side);
    const B = add2(s.p, mul2(ax, -opt.sink));
    const shape = opt.curve;
    const cen = (p) => shape.map(([u, o]) => {
      const pt = loc(B, ax, q, u * L, o * L);
      const sw = (p.swing || 0) * opt.bob * u * u;
      return yawPt([pt[0] + sw, pt[1] + Math.abs(p.swing || 0) * 3 * u * u], p.turn, side);
    });
    const tip = (p) => cen(p)[shape.length - 1];
    const ch = [...SWING_CH, ...YAW_CH];
    if (opt.plate) {
      b.add({ id: sx + '-plate', g, ...morph((p) => closedSpline(tiltedEllipse(add2(B, mul2(ax, opt.sink * 0.6)), ax, q, 10, 26).map((pt) => yawPt(pt, p.turn, side))), {}, YAW_CH), fill: sx + '-metal', stroke: '#5A626E', sw: 2.4 });
    } else {
      b.add({ id: sx + '-shadow', g, ...morph((p) => closedSpline(tiltedEllipse(B, ax, q, 4, 10).map((pt) => yawPt(pt, p.turn, side))), {}, YAW_CH), fill: '#1E1622', op: 0.25 });
    }
    b.add({ id: sx + '-stalk', g, ...morph((p) => taper(cen(p), opt.widths), {}, ch), fill: opt.stalk, stroke: shade(opt.stalk, -0.35), sw: 1.4 });
    if (opt.collar) b.add({ id: sx + '-collar', g, ...morph((p) => { const c = cen(p)[2]; return ellipse(c[0], c[1], 8, 4.5); }, {}, ch), fill: '#8F99A6', stroke: '#545C68', sw: 1.8 });
    const tone = opt.tip;
    const t0 = tip({});
    if (opt.glow) {
      b.grad(sx + '-glow', { kind: 'radial', center: t0, radius: opt.ball * 2.6, stops: [{ at: 0, color: tone, opacity: 0.7 }, { at: 0.45, color: tone, opacity: 0.25 }, { at: 1, color: tone, opacity: 0 }] });
      b.add({ id: sx + '-halo', g, ...morph((p) => { const c = tip(p); return ellipse(c[0], c[1], opt.ball * 2.6, opt.ball * 2.6); }, {}, ch), fill: sx + '-glow', op: 0.75, oc: [['extras.float', 0.25]] });
    }
    b.grad(sx + '-ball', { kind: 'radial', center: [t0[0] - opt.ball * 0.35, t0[1] - opt.ball * 0.4], radius: opt.ball * 1.3, stops: [{ at: 0, color: shade(tone, 0.55) }, { at: 0.5, color: tone }, { at: 1, color: shade(tone, -0.3) }] });
    b.add({ id: sx + '-ball', g, ...morph((p) => { const c = tip(p); return ellipse(c[0], c[1], opt.ball, opt.ball); }, {}, ch), fill: sx + '-ball', stroke: shade(tone, -0.45), sw: 2.2 });
    b.add({ id: sx + '-glint', g, ...morph((p) => { const c = tip(p); return ellipse(c[0] - opt.ball * 0.36, c[1] - opt.ball * 0.38, opt.ball * 0.28, opt.ball * 0.24); }, {}, ch), fill: '#FFFFFF', op: 0.8 });
  }
}

// ---------------------------------------------------------------- animal ears
// Outlines in local units: u along the ear's axis (0 base, 1 tip), o across it
// (negative toward the centre of the head). `side` runs base-inner -> tip -> base-outer
// with sharp base corners, `bottom` closes the base under the hair line.
const EARS = {
  'cat-ears': {
    name: 'Cat ears', note: 'pointed cat ears', t: 0.56, lean: 0.45, h: 0.56, w: 0.52, sink: 0.16, twitch: 0.1, tufts: true,
    side: [[-0.06, -0.5, 1], [0.45, -0.36], [0.86, -0.12], [1.0, 0.05], [0.88, 0.2], [0.48, 0.42], [-0.06, 0.55, 1]],
    bottom: [[-0.22, 0.02]],
    inner: [[0.04, -0.3, 1], [0.42, -0.22], [0.76, -0.06], [0.84, 0.06], [0.5, 0.25], [0.04, 0.34, 1], [-0.04, 0.02]],
  },
  'fox-ears': {
    name: 'Fox ears', note: 'tall fox ears with dark tips', t: 0.54, lean: 0.42, h: 0.7, w: 0.52, sink: 0.14, twitch: 0.1, tufts: true, darkTip: true,
    side: [[-0.06, -0.5, 1], [0.4, -0.38], [0.8, -0.15], [1.0, 0.03, 1], [0.8, 0.2], [0.42, 0.44], [-0.06, 0.55, 1]],
    bottom: [[-0.2, 0.02]],
    inner: [[0.04, -0.3, 1], [0.38, -0.24], [0.7, -0.09], [0.82, 0.03, 1], [0.62, 0.16], [0.34, 0.3], [0.04, 0.34, 1], [-0.04, 0.02]],
  },
  'bunny-ears': {
    name: 'Bunny ears', note: 'long, soft bunny ears', t: 0.36, lean: 0.3, h: 1.2, w: 0.36, sink: 0.08, twitch: 0.12, fit: 0.62,
    side: [[-0.04, -0.5, 1], [0.3, -0.58], [0.7, -0.52], [0.94, -0.28], [1.0, 0.02], [0.93, 0.32], [0.7, 0.52], [0.3, 0.54], [-0.04, 0.5, 1]],
    bottom: [[-0.16, 0]],
    inner: [[0.1, -0.22, 1], [0.36, -0.3], [0.72, -0.27], [0.9, -0.04], [0.72, 0.22], [0.36, 0.26], [0.1, 0.2, 1], [0.04, 0]],
  },
  'bear-ears': {
    name: 'Bear ears', note: 'small round bear ears', t: 0.62, lean: 0.55, h: 0.38, w: 0.48, sink: 0.2, twitch: 0.07,
    side: [[-0.02, -0.48, 1], [0.42, -0.58], [0.84, -0.42], [1.0, 0.0], [0.84, 0.42], [0.42, 0.58], [-0.02, 0.48, 1]],
    bottom: [[-0.14, 0]],
    inner: [[0.08, -0.26, 1], [0.4, -0.34], [0.72, -0.24], [0.82, 0], [0.72, 0.24], [0.4, 0.34], [0.08, 0.26, 1], [0.02, 0]],
  },
  'mouse-ears': {
    name: 'Mouse ears', note: 'big round mouse ears', t: 0.6, lean: 0.75, h: 0.66, w: 0.6, sink: 0.12, twitch: 0.08,
    side: [[-0.04, -0.3, 1], [0.2, -0.52], [0.55, -0.58], [0.88, -0.42], [1.0, 0.0], [0.88, 0.42], [0.55, 0.58], [0.2, 0.52], [-0.04, 0.3, 1]],
    bottom: [[-0.14, 0]],
    inner: [[0.1, -0.2, 1], [0.26, -0.38], [0.55, -0.44], [0.8, -0.32], [0.88, 0], [0.8, 0.32], [0.55, 0.44], [0.26, 0.38], [0.1, 0.2, 1], [0.04, 0]],
  },
};

function animalEars(ctx, id) {
  const { b, k, colors } = ctx;
  const sp = EARS[id];
  const g = group(b, id + '-g', 'head', [CX, k.top], HEAD_DRIVES);
  const hair = colors.hair;
  const pink = mix('#F3A2B2', colors.skin, 0.25);
  const innerTone = id === 'fox-ears' ? '#F6ECDF' : id === 'bear-ears' ? mix(shade(hair, 0.35), '#E9B9A4', 0.45) : pink;
  const ch = [...SWING_CH, ...YAW_CH];
  for (const side of [-1, 1]) {
    const sx = id + (side > 0 ? '-R' : '-L');
    const H0 = k.w * sp.h;
    const Bw = k.w * sp.w;
    // long ears may shorten a little before they are pushed down the side of tall hair
    const s = seat(ctx, side * sp.t, sp.lean, H0 * (1 - sp.sink) * (sp.fit || 0.85));
    const H = clamp(s.maxReach / (1 - sp.sink), H0 * 0.6, H0);
    const ax = s.axis;
    const q = outward(ax, side);
    const B = add2(s.p, mul2(ax, -H * sp.sink));
    const tw = sp.twitch * (side > 0 ? 1 : 0.7);
    const at = (p) => ([u, o, c]) => {
      const pt = rotatePt(loc(B, ax, q, u * H, o * Bw), B, (p.swing || 0) * tw);
      return yawPt([pt[0], pt[1], c], p.turn, side);
    };
    const tipPt = loc(B, ax, q, H, 0);
    b.grad(sx + '-fill', { kind: 'linear', start: [tipPt[0] - side * Bw * 0.3, tipPt[1]], end: [B[0] + side * Bw * 0.3, B[1]], stops: [{ at: 0, color: shade(hair, 0.2) }, { at: 1, color: shade(hair, -0.12) }] });
    const shadowPts = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      shadowPts.push([sp.sink * 0.9 + 0.07 * Math.sin(a), 0.62 * Math.cos(a)]);
    }
    b.add({ id: sx + '-shadow', g, ...morph((p) => closedSpline(shadowPts.map(at(p))), {}, ch), fill: shade(hair, -0.7), op: 0.2 });
    b.add({ id: sx, g, ...morph((p) => closedMixed([...sp.side, ...sp.bottom].map(at(p))), {}, ch), fill: sx + '-fill' });
    if (sp.darkTip) {
      b.add({ id: sx + '-tip', g, ...morph((p) => closedMixed([[0.66, -0.7, 1], [1.15, -0.7, 1], [1.15, 0.7, 1], [0.6, 0.7, 1], [0.66, 0.25], [0.62, -0.2]].map(at(p))), {}, ch), fill: mix(shade(hair, -0.62), '#201A1E', 0.35), clip: sx });
    }
    b.add({ id: sx + '-inner', g, ...morph((p) => closedMixed(sp.inner.map(at(p))), {}, ch), fill: innerTone, stroke: shade(innerTone, -0.25), sw: 1.4, op: 0.95 });
    if (sp.tufts) {
      const tufts = (p) => [
        [[0.04, -0.14], [0.26, -0.08], [0.44, -0.12]],
        [[0.03, 0.04], [0.3, 0.06], [0.52, 0.12]],
        [[0.06, 0.2], [0.24, 0.22], [0.36, 0.3]],
      ].flatMap((l) => openSpline(l.map(at(p))));
      b.add({ id: sx + '-tufts', g, ...morph(tufts, {}, ch), fill: 'none', stroke: id === 'fox-ears' ? '#FFFFFF' : mix(hair, '#FFFFFF', 0.72), sw: 2.4, op: 0.8 });
    }
    b.add({ id: sx + '-line', g, ...morph((p) => openSpline(sp.side.map(at(p))), {}, ch), fill: 'none', stroke: colors.hairLine, sw: 2.8 });
    if (bareScalp(ctx)) {
      const last = sp.side[sp.side.length - 1];
      b.add({ id: sx + '-base', g, ...morph((p) => openSpline([last, ...sp.bottom, sp.side[0]].map(at(p))), {}, ch), fill: 'none', stroke: colors.hairLine, sw: 2.4, op: 0.55 });
    }
  }
}

// ---------------------------------------------------------------- items
const WING_ITEMS = {
  'angel-wings': { name: 'Angel wings', note: 'a pair of feathered white angel wings', draw: angelWing },
  'bat-wings': {
    name: 'Bat wings', note: 'a pair of leathery bat wings',
    draw: (ctx, id, side) => membraneWing(ctx, id, side, {
      wrist: [0.6, 1.0], elbow: [0.3, 0.6], lead: [0.82, 0.99], back: [0.3, -0.14], scallop: 0.22,
      tips: [[1.0, 0.84], [1.05, 0.47], [0.95, 0.12], [0.72, -0.12]],
      c0: '#8A74A0', c1: '#5B4570', c2: '#35263F', bone: '#2B2033', claws: '#E9E0D2', arm: 13, finger: 8, claw: 0.8,
    }),
  },
  'fairy-wings': { name: 'Fairy wings', note: 'a pair of shimmering, see-through fairy wings', draw: fairyWing },
  'butterfly-wings': { name: 'Butterfly wings', note: 'a pair of bright, patterned butterfly wings', draw: butterflyWing },
  'dragon-wings': {
    name: 'Dragon wings', note: 'a pair of great scaly dragon wings',
    draw: (ctx, id, side) => membraneWing(ctx, id, side, {
      wrist: [0.56, 1.0], elbow: [0.26, 0.62], lead: [0.8, 1.0], back: [0.25, -0.14], scallop: 0.3,
      tips: [[1.02, 0.9], [1.07, 0.55], [1.0, 0.22], [0.82, -0.06], [0.56, -0.16]],
      c0: '#6CC495', c1: '#348A63', c2: '#1F5440', bone: '#1C4031', claws: '#EBDDB0', arm: 18, finger: 10, claw: 1.25, spikes: true, veins: true,
    }),
  },
};

export const ITEMS = {};

for (const [id, w] of Object.entries(WING_ITEMS)) {
  ITEMS[id] = {
    name: w.name, note: w.note, slot: 'back',
    behind(ctx) {
      for (const side of [-1, 1]) w.draw(ctx, id, side);
    },
  };
}

ITEMS['glow-aura'] = {
  name: 'Glowing aura', note: 'a soft glow of light all around them', slot: 'back',
  behind(ctx) {
    const { b, f, colors } = ctx;
    const c = glowColor(colors.accent);
    const g = group(b, 'glow-aura-g', 'root', [CX, f.cy + 60], { sx: [['extras.float', 0.03]], sy: [['extras.float', 0.03]] });
    b.grad('glow-aura-outer', { kind: 'radial', center: [CX, f.cy + 70], radius: 470, stops: [{ at: 0, color: c, opacity: 0.75 }, { at: 0.42, color: c, opacity: 0.42 }, { at: 0.72, color: c, opacity: 0.14 }, { at: 1, color: c, opacity: 0 }] });
    b.add({ id: 'glow-aura-outer', g, d: ellipse(CX, f.cy + 70, 470, 470), fill: 'glow-aura-outer', op: 0.88, oc: [['extras.float', 0.1]] });
    const hi = mix(c, '#FFFFFF', 0.45);
    b.grad('glow-aura-inner', { kind: 'radial', center: [CX, f.cy - 10], radius: 300, stops: [{ at: 0, color: hi, opacity: 0.85 }, { at: 0.6, color: hi, opacity: 0.35 }, { at: 1, color: hi, opacity: 0 }] });
    b.add({ id: 'glow-aura-inner', g, d: ellipse(CX, f.cy - 10, 300, 300), fill: 'glow-aura-inner', op: 0.8, oc: [['extras.float', -0.12]] });
    const gm = group(b, 'glow-aura-motes-g', 'root', [CX, f.cy], { ty: [['extras.float', -12]] });
    const motes = [[-262, -120, 9], [-300, 70, 6], [-220, 210, 7], [268, -150, 7], [306, 30, 9], [240, 200, 6], [-150, -235, 6], [170, -250, 8]];
    b.add({ id: 'glow-aura-motes', g: gm, d: motes.flatMap(([dx, dy, r]) => sparkle(CX + dx, f.cy + dy, r)), fill: mix(c, '#FFFFFF', 0.6), op: 0.7, oc: [['extras.float', 0.25]] });
  },
};

ITEMS.halo = {
  name: 'Halo', note: 'a glowing golden halo floating above their head', slot: 'halo',
  behind(ctx) {
    haloParts(ctx, 'back');
  },
  headwear(ctx) {
    haloParts(ctx, 'front');
  },
};

ITEMS['devil-horns'] = { name: 'Devil horns', note: 'two little red devil horns', slot: 'horns', headwear: devilHorns };
ITEMS['ram-horns'] = { name: 'Ram horns', note: 'a pair of curling ram horns', slot: 'horns', headwear: ramHorns };
ITEMS['unicorn-horn'] = { name: 'Unicorn horn', note: 'a spiralled golden unicorn horn on their forehead', slot: 'horns', headwear: unicornHorn };
ITEMS.antennae = {
  name: 'Antennae', note: 'a pair of bobbing antennae with round tips', slot: 'horns',
  headwear(ctx) {
    const tip = vivid(ctx.colors.accent, '#F2C744');
    stalks(ctx, 'antennae', {
      sides: [-1, 1], t: 0.3, lean: 0.38, len: 0.66, ball: 14, sink: 6, bob: 22,
      curve: [[0, 0], [0.3, 0.02], [0.6, 0.1], [0.84, 0.22], [1.0, 0.3]], widths: [10, 8.5, 7, 6, 5.4],
      stalk: mix(shade(tip, -0.3), '#5A4A66', 0.35), tip,
    });
  },
};
ITEMS['robot-antenna'] = {
  name: 'Robot antenna', note: 'a little robot antenna with a blinking light', slot: 'horns',
  headwear(ctx) {
    const { b, k } = ctx;
    const s = seat(ctx, 0.3, 0.4, k.w * 0.6 + 13);
    b.grad('robot-antenna-metal', { kind: 'linear', start: [s.p[0] - 24, s.p[1] - 30], end: [s.p[0] + 24, s.p[1] + 10], stops: [{ at: 0, color: '#EEF2F6' }, { at: 0.5, color: '#B6BFCA' }, { at: 1, color: '#7C8693' }] });
    stalks(ctx, 'robot-antenna', {
      sides: [1], t: 0.3, lean: 0.4, len: 0.6, ball: 13, sink: 4, bob: 12, plate: true, collar: true, glow: true,
      curve: [[0, 0], [0.33, 0.0], [0.66, 0.0], [1.0, 0.0]], widths: [10, 8, 7, 6.5],
      stalk: '#A9B3BF', tip: vivid(ctx.colors.accent, '#FF5A6E'),
    });
  },
};

for (const id of Object.keys(EARS)) {
  ITEMS[id] = { name: EARS[id].name, note: EARS[id].note, slot: 'animalEars', headwear: (ctx) => animalEars(ctx, id) };
}
