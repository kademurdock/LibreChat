// Eyewear for the puppet kit (see CONVENTIONS.md). Every frame sits over the eyes at
// ctx.f.eyeY / eyeDX and is sized from the recipe's eye size, so it fits every face.
// Frames live in the 'face' group. The temple arms run back to the side of the head and
// carry head.yaw / head.pitch morph targets so their far ends stay at the ears (or tuck
// under side locks of hair) while the face moves with its parallax.
import { closedSpline, openSpline, closedMixed, ellipse, compound, shade, round1, rotatePt } from './geom.mjs';

const CX = 500;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

// Hair styles whose side locks fall over the temples; arms tuck under them.
const LOCKS = new Set(['bob', 'shoulder-wavy', 'long-straight', 'long-curly', 'curtain-long', 'locs']);
// Eye opening height as a fraction of eye width (mirrors the kit's eye shapes).
const EYE_H = { round: 0.8, almond: 0.62, doe: 0.9, hooded: 0.66, upturned: 0.62, downturned: 0.66, narrow: 0.46, button: 1 };

// Base path from fn({}) plus morph targets fn(patch); identical structure guaranteed.
function morph(fn, channels) {
  const d = fn({});
  const m = [];
  for (const [c, patch, neg] of channels) {
    const t = fn(patch);
    if (t.length !== d.length) throw new Error('eyewear morph mismatch on ' + c);
    m.push(neg ? { c, d: t, n: true } : { c, d: t });
  }
  return { d, m };
}

// Rounded polygon: corners [x, y, radius]. Straight edges joined by cubic corners.
function roundedPoly(pts) {
  const n = pts.length;
  const ins = [];
  const outs = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[(i - 1 + n) % n];
    const c = pts[(i + 1) % n];
    const r = p[2] || 0;
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]) || 1;
    const lc = Math.hypot(c[0] - p[0], c[1] - p[1]) || 1;
    const ta = Math.min(0.48, r / la);
    const tc = Math.min(0.48, r / lc);
    ins.push([p[0] + (a[0] - p[0]) * ta, p[1] + (a[1] - p[1]) * ta]);
    outs.push([p[0] + (c[0] - p[0]) * tc, p[1] + (c[1] - p[1]) * tc]);
  }
  const d = [{ op: 'M', v: [round1(outs[0][0]), round1(outs[0][1])] }];
  for (let j = 1; j <= n; j++) {
    const i = j % n;
    const p = pts[i];
    d.push({ op: 'L', v: [round1(ins[i][0]), round1(ins[i][1])] });
    d.push({ op: 'C', v: [
      round1(lerp(ins[i][0], p[0], 0.55)), round1(lerp(ins[i][1], p[1], 0.55)),
      round1(lerp(outs[i][0], p[0], 0.55)), round1(lerp(outs[i][1], p[1], 0.55)),
      round1(outs[i][0]), round1(outs[i][1]),
    ] });
  }
  d.push({ op: 'Z', v: [] });
  return d;
}

// Lens box from the recipe's eyes: half-width a, half-height b, centre y, eye centres.
function lensBox(ctx, opt = {}) {
  const { f } = ctx;
  const e = (ctx.r && ctx.r.eyes) || {};
  const size = typeof e.size === 'number' ? e.size : 0.5;
  const ew = 74 * (0.86 + 0.28 * size) * (e.shape === 'doe' ? 1.12 : 1);
  const eh = ew * (EYE_H[e.shape] || 0.8);
  const a = clamp((ew * 0.5 + 11) * (opt.w || 1), 34, f.eyeDX - (opt.gap ?? 7));
  const b = Math.max(eh * 0.5 + 9, a * (opt.ratio || 0.76)) * (opt.h || 1);
  const cy = f.eyeY + (opt.dy ?? 3);
  const cx = (s) => CX + s * f.eyeDX;
  // local lens point -> world, x measured outward from the nose
  const P = (s, x, y) => [cx(s) + s * x, cy + y];
  return { a, b, cy, cx, P, ew, eh };
}

// Where the arms end: the side of the head at ear-top height, or under side locks.
function armEnd(ctx) {
  const { f, k } = ctx;
  const locks = LOCKS.has(ctx.hairStyle);
  const edge = f.W * f.hs.cheek - 3;
  const x = locks ? Math.min(edge, k.w * 0.9 + 4) : edge;
  // face group moves 21 px per unit yaw; the head outline moves about -0.06*W + 4.5;
  // front hair (locks) moves 13. The arm end cancels the difference.
  const yaw = locks ? -8 : -(21 + 0.06 * f.W * f.hs.cheek - 4.5);
  const pitch = locks ? -9 : -15;
  return { x, y: f.earY - 20, yaw, pitch };
}

// Two temple arms from hinge(s) back toward the ears (drawn first, under the rims).
function temples(ctx, id, hinge, color, w) {
  const { b } = ctx;
  const E = armEnd(ctx);
  const fn = (p) => {
    const yaw = p.yaw || 0;
    const pitch = p.pitch || 0;
    const paths = [];
    for (const s of [-1, 1]) {
      const [hx, hy] = hinge(s);
      const room = Math.max(0, E.x - Math.abs(hx - CX) - 6);
      // the arm on the side turning away shrinks; never let it cross the hinge
      const shrinking = (s > 0 && yaw > 0) || (s < 0 && yaw < 0);
      const dx = shrinking ? Math.sign(yaw) * Math.max(E.yaw, -room) * Math.abs(yaw) : yaw * E.yaw;
      const ex = CX + s * E.x + dx;
      const ey = E.y + pitch * E.pitch;
      const mx = lerp(hx, ex, 0.5);
      const my = lerp(hy, ey, 0.5) - 3;
      paths.push(openSpline([[hx, hy], [mx, my], [ex, ey]]));
    }
    return compound(...paths);
  };
  const shape = morph(fn, [
    ['head.yaw', { yaw: 1 }], ['head.yaw', { yaw: -1 }, true],
    ['head.pitch', { pitch: 1 }], ['head.pitch', { pitch: -1 }, true],
  ]);
  b.add({ id: id + '-arms-o', g: 'face', ...shape, fill: 'none', stroke: shade(color, -0.45), sw: w + 3 });
  b.add({ id: id + '-arms', g: 'face', ...shape, fill: 'none', stroke: color, sw: w });
}

// Standard frame stack: arms, lens fill, rim outline + rim colour, rim shine, glints.
function frames(ctx, id, o) {
  const { b } = ctx;
  temples(ctx, id, o.hinge, o.armColor || o.color, o.armW || Math.max(3, o.rimW * 0.62));
  b.add({ id: id + '-lens', g: 'face', d: compound(...o.lenses), fill: o.lensFill, op: o.lensOp ?? 1 });
  const rim = compound(...o.lenses, ...(o.bridge || []));
  b.add({ id: id + '-rim-o', g: 'face', d: rim, fill: 'none', stroke: o.outline || shade(o.color, -0.45), sw: o.rimW + 3 });
  b.add({ id: id + '-rim', g: 'face', d: rim, fill: 'none', stroke: o.color, sw: o.rimW });
  if (o.shine && o.shine.length) {
    b.add({ id: id + '-rimShine', g: 'face', d: compound(...o.shine.map((l) => openSpline(l))), fill: 'none', stroke: o.shineColor || shade(o.color, 0.55), sw: Math.max(1.4, o.rimW * 0.28), op: 0.65 });
  }
  if (o.glints && o.glints.length) {
    b.add({ id: id + '-glint', g: 'face', d: compound(...o.glints.map((l) => openSpline(l))), fill: 'none', stroke: '#FFFFFF', sw: o.glintW || 4.5, op: o.glintOp ?? 0.42 });
  }
}

// Two diagonal glint streaks in the upper-left of a lens (light comes from top-left).
function glintPair(cx, cy, a, b, k = 1) {
  return [
    [[cx - a * 0.52, cy - b * 0.08 * k], [cx - a * 0.2, cy - b * 0.52 * k]],
    [[cx - a * 0.34, cy + b * 0.18 * k], [cx - a * 0.12, cy - b * 0.1 * k]],
  ];
}

// Gentle lens tint gradient (top a touch darker), shared by both lenses.
function tint(ctx, id, cy, b, top, bottom, opTop, opBottom) {
  ctx.b.grad(id, {
    kind: 'linear', start: [CX, cy - b], end: [CX, cy + b],
    stops: [{ at: 0, color: top, opacity: opTop }, { at: 1, color: bottom, opacity: opBottom }],
  });
  return id;
}

export const ITEMS = {
  'square-glasses': {
    name: 'Square glasses', slot: 'eyewear', note: 'bold square-framed glasses',
    eyewear(ctx) {
      const id = 'square-glasses';
      const L = lensBox(ctx, { ratio: 0.76 });
      const { a, b, cy, P } = L;
      const color = '#3B3442';
      const lens = (s) => roundedPoly([
        [...P(s, -a, -b), b * 0.24], [...P(s, a, -b), b * 0.24],
        [...P(s, a * 0.97, b), b * 0.42], [...P(s, -a * 0.93, b * 0.97), b * 0.42],
      ]);
      const xi = (s) => P(s, -a, 0)[0];
      frames(ctx, id, {
        color, rimW: 6.5,
        lenses: [lens(-1), lens(1)],
        bridge: [openSpline([[xi(-1) - 1, cy - b * 0.5], [CX, cy - b * 0.68], [xi(1) + 1, cy - b * 0.5]])],
        hinge: (s) => P(s, a - 2, -b * 0.62),
        lensFill: tint(ctx, id + '-tint', cy, b, '#CFE3F2', '#EAF3FA', 0.2, 0.1),
        shine: [-1, 1].map((s) => [[L.cx(s) - a * 0.72, cy - b - 1], [L.cx(s) + a * 0.12, cy - b - 1.5]]),
        glints: [-1, 1].flatMap((s) => glintPair(L.cx(s), cy, a, b)),
      });
    },
  },

  'cat-eye-glasses': {
    name: 'Cat-eye glasses', slot: 'eyewear', note: 'cat-eye glasses with swept-up corners',
    eyewear(ctx) {
      const { b: B } = ctx;
      const id = 'cat-eye-glasses';
      const L = lensBox(ctx, { ratio: 0.72, dy: 4 });
      const { a, b, cy, P } = L;
      const color = '#A3324E';
      const shape = [[-0.96, -0.62], [-0.2, -0.8], [0.62, -0.92], [1.16, -1.22, true], [1.0, -0.32], [0.72, 0.6], [0.05, 0.9], [-0.62, 0.8], [-0.98, 0.14]];
      const lens = (s) => closedMixed(shape.map(([x, y, c]) => [...P(s, x * a, y * b), c]));
      frames(ctx, id, {
        color, rimW: 6.5,
        lenses: [lens(-1), lens(1)],
        bridge: [openSpline([P(-1, -a * 0.97, -b * 0.42), [CX, cy - b * 0.62], P(1, -a * 0.97, -b * 0.42)])],
        hinge: (s) => P(s, a * 1.0, -b * 0.8),
        lensFill: tint(ctx, id + '-tint', cy, b, '#F6D7E2', '#FBEFF3', 0.22, 0.1),
        shine: [
          [P(-1, a * 0.98, -b * 1.04), P(-1, a * 0.5, -b * 0.9), P(-1, 0, -b * 0.82)],
          [P(1, -a * 0.9, -b * 0.66), P(1, -a * 0.4, -b * 0.78), P(1, a * 0.1, -b * 0.84)],
        ],
        glints: [-1, 1].flatMap((s) => glintPair(L.cx(s), cy, a, b)),
      });
      // little gold studs at the swept-up corners
      const studs = [-1, 1].map((s) => {
        const [x, y] = P(s, a * 1.0, -b * 1.04);
        return ellipse(x, y, 4.2, 4.2);
      });
      B.add({ id: id + '-studs', g: 'face', d: compound(...studs), fill: '#F3CF6E', stroke: '#9A6E1E', sw: 1.4 });
    },
  },

  aviators: {
    name: 'Aviators', slot: 'eyewear', note: 'gold-rimmed aviator sunglasses with tinted teardrop lenses',
    eyewear(ctx) {
      const id = 'aviators';
      const L = lensBox(ctx, { w: 1.08, ratio: 0.84, gap: 5 });
      const { a, b, cy, P } = L;
      const color = '#C49A3C';
      const drop = [[-0.92, -0.8], [-0.2, -0.98], [0.6, -0.97], [1.02, -0.72], [1.06, -0.05], [0.82, 0.66], [0.3, 1.02], [-0.3, 0.94], [-0.8, 0.5], [-1.0, -0.16]];
      const lens = (s) => closedSpline(drop.map(([x, y]) => P(s, x * a, y * b)));
      frames(ctx, id, {
        color, rimW: 3.6, outline: '#7A5A1E',
        lenses: [lens(-1), lens(1)],
        bridge: [
          openSpline([P(-1, -a * 0.86, -b * 0.84), [CX, cy - b * 0.9], P(1, -a * 0.86, -b * 0.84)]),
          openSpline([P(-1, -a * 0.98, -b * 0.3), [CX, cy - b * 0.5], P(1, -a * 0.98, -b * 0.3)]),
        ],
        hinge: (s) => P(s, a * 1.0, -b * 0.74),
        armW: 3,
        lensFill: tint(ctx, id + '-tint', cy, b, '#4E6E8A', '#B7D2E3', 0.78, 0.4),
        shineColor: '#FFF1C2',
        shine: [-1, 1].map((s) => [P(s, s < 0 ? a * 0.55 : -a * 0.6, -b * 0.99), P(s, s < 0 ? -a * 0.3 : a * 0.2, -b * 1.0)]),
        glints: [-1, 1].flatMap((s) => glintPair(L.cx(s), cy, a, b)),
        glintOp: 0.5,
      });
    },
  },

  sunglasses: {
    name: 'Sunglasses', slot: 'eyewear', note: 'classic dark sunglasses',
    eyewear(ctx) {
      const { b: B } = ctx;
      const id = 'sunglasses';
      const L = lensBox(ctx, { w: 1.06, ratio: 0.78, gap: 5 });
      const { a, b, cy, P } = L;
      const color = '#2B2731';
      const lens = (s) => roundedPoly([
        [...P(s, -a, -b * 0.92), 7],
        [...P(s, a * 1.1, -b * 1.06), 7],
        [...P(s, a * 0.88, b * 0.92), b * 0.6],
        [...P(s, -a * 0.84, b * 0.86), b * 0.52],
      ]);
      B.grad(id + '-dark', {
        kind: 'linear', start: [CX - 80, cy - b], end: [CX + 60, cy + b],
        stops: [{ at: 0, color: '#4A5470' }, { at: 0.5, color: '#262B3A' }, { at: 1, color: '#12141C' }],
      });
      frames(ctx, id, {
        color, rimW: 7.5, outline: '#15121A',
        lenses: [lens(-1), lens(1)],
        bridge: [openSpline([[P(-1, -a, 0)[0], cy - b * 0.62], [CX, cy - b * 0.74], [P(1, -a, 0)[0], cy - b * 0.62]])],
        hinge: (s) => P(s, a * 1.04, -b * 0.88),
        armW: 5,
        lensFill: id + '-dark', lensOp: 0.96,
        shineColor: '#8E8798',
        shine: [-1, 1].map((s) => [P(s, s < 0 ? a * 0.72 : -a * 0.72, s < 0 ? -b * 1.04 : -b * 0.95), P(s, s < 0 ? -a * 0.2 : a * 0.3, s < 0 ? -b * 0.96 : -b * 1.06)]),
        glints: [-1, 1].flatMap((s) => [
          [[L.cx(s) - a * 0.6, cy + b * 0.05], [L.cx(s) - a * 0.18, cy - b * 0.6]],
          [[L.cx(s) - a * 0.32, cy + b * 0.36], [L.cx(s) + a * 0.02, cy - b * 0.18]],
        ]),
        glintW: 5, glintOp: 0.5,
      });
      // a cool reflection along the bottom of each lens + silver rivets
      B.add({ id: id + '-reflect', g: 'face', d: compound(...[-1, 1].map((s) => openSpline([[L.cx(s) - a * 0.4, cy + b * 0.66], [L.cx(s) + a * 0.1, cy + b * 0.72], [L.cx(s) + a * 0.5, cy + b * 0.56]]))), fill: 'none', stroke: '#9FC4E8', sw: 3, op: 0.28 });
      B.add({ id: id + '-rivets', g: 'face', d: compound(...[-1, 1].map((s) => { const [x, y] = P(s, a * 0.86, -b * 0.92); return ellipse(x, y, 3.4, 3.4); })), fill: '#D7DBE2' });
    },
  },

  'heart-sunglasses': {
    name: 'Heart sunglasses', slot: 'eyewear', note: 'playful heart-shaped pink sunglasses',
    eyewear(ctx) {
      const id = 'heart-sunglasses';
      const L = lensBox(ctx, { w: 1.14, ratio: 0.98, gap: 4, dy: 1 });
      const { a, b, cy, cx } = L;
      const color = '#E2457A';
      const heart = [[0, -0.52, true], [0.44, -1.02], [0.94, -0.8], [1.02, -0.2], [0.64, 0.42], [0, 1.0, true], [-0.64, 0.42], [-1.02, -0.2], [-0.94, -0.8], [-0.44, -1.02]];
      const pt = (s, x, y) => rotatePt([cx(s) + x * a, cy + y * b], [cx(s), cy], s * 0.1);
      const lens = (s) => closedMixed(heart.map(([x, y, c]) => [...pt(s, x, y).slice(0, 2), c]));
      frames(ctx, id, {
        color, rimW: 6,
        lenses: [lens(-1), lens(1)],
        bridge: [openSpline([pt(-1, 0.9, -0.5), [CX, cy - b * 0.7], pt(1, -0.9, -0.5)])],
        hinge: (s) => pt(s, s * 0.96, -0.62),
        lensFill: tint(ctx, id + '-tint', cy, b, '#FF4F8B', '#FF9BBE', 0.66, 0.5),
        shineColor: '#FFC1D6',
        shine: [-1, 1].map((s) => [pt(s, -0.86, -0.72), pt(s, -0.58, -0.98), pt(s, -0.24, -0.92)]),
        glints: [-1, 1].flatMap((s) => glintPair(cx(s), cy, a * 0.9, b * 0.9)),
        glintOp: 0.55,
      });
    },
  },

  'reading-glasses': {
    name: 'Reading glasses', slot: 'eyewear', note: 'half-moon reading glasses perched low on the nose',
    eyewear(ctx) {
      const id = 'reading-glasses';
      const L = lensBox(ctx, { w: 0.94 });
      const { a, cx, eh } = L;
      const ty = ctx.f.eyeY + eh * 0.5 + 7;
      const h = clamp(a * 0.66, 24, 36);
      const color = '#B8913F';
      const lens = (s) => closedMixed([
        [cx(s) - a, ty, true], [cx(s) + a, ty, true],
        [cx(s) + a * 0.8, ty + h * 0.72], [cx(s), ty + h], [cx(s) - a * 0.8, ty + h * 0.72],
      ]);
      const inner = (s) => cx(s) - s * a;
      frames(ctx, id, {
        color, rimW: 3.4, outline: '#7C5E22',
        lenses: [lens(-1), lens(1)],
        bridge: [openSpline([[inner(-1) - 1, ty + 2], [CX, ty - 10], [inner(1) + 1, ty + 2]])],
        hinge: (s) => [cx(s) + s * (a - 1), ty + 1],
        armW: 2.8,
        lensFill: tint(ctx, id + '-tint', ty + h / 2, h / 2, '#DDEBF5', '#EEF5FA', 0.22, 0.12),
        shineColor: '#FFF0C4',
        shine: [-1, 1].map((s) => [[cx(s) - a * 0.8, ty - 0.8], [cx(s) + a * 0.1, ty - 0.8]]),
        glints: [-1, 1].map((s) => [[cx(s) - a * 0.46, ty + h * 0.62], [cx(s) - a * 0.22, ty + h * 0.2]]),
        glintW: 3.6,
      });
    },
  },

  monocle: {
    name: 'Monocle', slot: 'eyewear', note: 'a gold monocle on a fine chain',
    eyewear(ctx) {
      const { b, f } = ctx;
      const id = 'monocle';
      const L = lensBox(ctx, { gap: 4 });
      const s = 1;
      const R = clamp(Math.max(L.a, L.b) + 4, 38, f.eyeDX + 4);
      const cx = L.cx(s);
      const cy = f.eyeY + 2;
      const gold = '#C9A043';
      const E = armEnd(ctx);
      // the chain droops from the rim and loops back to the ear
      const start = [cx + R * 0.72, cy + R * 0.7];
      const chainPts = (p) => {
        const yaw = p.yaw || 0;
        const pitch = p.pitch || 0;
        const room = Math.max(0, E.x - (start[0] - CX) - 6);
        const dx = yaw > 0 ? -Math.min(-E.yaw, room) * yaw : E.yaw * yaw;
        const end = [CX + E.x + dx, E.y + 14 + pitch * E.pitch];
        const out = [];
        const n = 10;
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const x = lerp(start[0], end[0], t);
          const sag = Math.sin(Math.PI * t) * (64 + R * 0.25);
          out.push([x, lerp(start[1], end[1], t) + sag]);
        }
        return out;
      };
      const ch = [['head.yaw', { yaw: 1 }], ['head.yaw', { yaw: -1 }, true], ['head.pitch', { pitch: 1 }], ['head.pitch', { pitch: -1 }, true]];
      const line = morph((p) => openSpline(chainPts(p)), ch);
      b.add({ id: id + '-chain', g: 'face', ...line, fill: 'none', stroke: '#8E6A22', sw: 2.6 });
      const beads = morph((p) => compound(...chainPts(p).slice(1).map(([x, y]) => ellipse(x, y, 3.2, 3.2))), ch);
      b.add({ id: id + '-beads', g: 'face', ...beads, fill: '#E6C46A', stroke: '#8E6A22', sw: 1.2 });
      b.grad(id + '-tint', { kind: 'radial', center: [cx - R * 0.3, cy - R * 0.3], radius: R * 1.3, stops: [{ at: 0, color: '#F4FAFF', opacity: 0.08 }, { at: 1, color: '#BFD7EA', opacity: 0.3 }] });
      b.add({ id: id + '-lens', g: 'face', d: ellipse(cx, cy, R, R), fill: id + '-tint' });
      b.add({ id: id + '-rim-o', g: 'face', d: ellipse(cx, cy, R, R), fill: 'none', stroke: '#7A5A1E', sw: 8.5 });
      b.add({ id: id + '-rim', g: 'face', d: ellipse(cx, cy, R, R), fill: 'none', stroke: gold, sw: 5.5 });
      b.add({ id: id + '-rimShine', g: 'face', d: openSpline([[cx - R * 0.94, cy - R * 0.3], [cx - R * 0.66, cy - R * 0.76], [cx - R * 0.2, cy - R * 0.98]]), fill: 'none', stroke: '#FFF0BE', sw: 1.8, op: 0.8 });
      b.add({ id: id + '-loop', g: 'face', d: ellipse(start[0], start[1], 5, 5), fill: gold, stroke: '#7A5A1E', sw: 2 });
      b.add({ id: id + '-glint', g: 'face', d: compound(...glintPair(cx, cy, R * 0.95, R * 0.95).map((l) => openSpline(l))), fill: 'none', stroke: '#FFFFFF', sw: 4.5, op: 0.45 });
    },
  },

  'star-glasses': {
    name: 'Star glasses', slot: 'eyewear', note: 'sparkly star-shaped party glasses',
    eyewear(ctx) {
      const { f } = ctx;
      const id = 'star-glasses';
      const L = lensBox(ctx, { ratio: 0.76, dy: 1 });
      const { a, b, cy, cx } = L;
      const R = clamp(Math.max(a, b) * 1.3, 40, f.eyeDX - 3);
      const color = '#F2B92E';
      const corners = (s) => {
        const out = [];
        for (let i = 0; i < 10; i++) {
          const ang = -Math.PI / 2 + (i * Math.PI) / 5 + s * 0.1;
          const rr = i % 2 ? R * 0.56 : R;
          out.push([cx(s) + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, i % 2 ? 4 : 7]);
        }
        return out;
      };
      const lens = (s) => roundedPoly(corners(s));
      const tips = (s) => corners(s).filter((_, i) => i % 2 === 0);
      const near = (s) => tips(s).reduce((m, p) => (Math.abs(p[0] - CX) < Math.abs(m[0] - CX) ? p : m));
      const far = (s) => tips(s).reduce((m, p) => (Math.abs(p[0] - CX) > Math.abs(m[0] - CX) ? p : m));
      const nl = near(-1);
      const nr = near(1);
      frames(ctx, id, {
        color, rimW: 6, outline: '#A8721A',
        lenses: [lens(-1), lens(1)],
        bridge: [openSpline([[nl[0] - 3, nl[1] + 3], [CX, Math.min(nl[1], nr[1]) - 4], [nr[0] + 3, nr[1] + 3]])],
        hinge: (s) => { const p = far(s); return [p[0] - s * 6, p[1] + 3]; },
        armColor: '#E4A82A', armW: 4,
        lensFill: tint(ctx, id + '-tint', cy, R, '#FF6FB0', '#FFB3D6', 0.38, 0.22),
        shineColor: '#FFF3C4',
        shine: [-1, 1].map((s) => { const c = corners(s); return [c[8].slice(0, 2), c[9].slice(0, 2), c[0].slice(0, 2)]; }),
        glints: [-1, 1].flatMap((s) => glintPair(cx(s), cy, a * 0.8, b * 0.8)),
        glintOp: 0.5,
      });
      // a tiny sparkle on the frame
      const sp = (x, y, r) => closedMixed([[x, y - r, true], [x + r * 0.28, y - r * 0.28, true], [x + r, y, true], [x + r * 0.28, y + r * 0.28, true], [x, y + r, true], [x - r * 0.28, y + r * 0.28, true], [x - r, y, true], [x - r * 0.28, y - r * 0.28, true]]);
      const t1 = tips(-1)[0];
      const t2 = far(1);
      ctx.b.add({ id: id + '-sparkle', g: 'face', d: compound(sp(t1[0] - 10, t1[1] - 6, 9), sp(t2[0] + 4, t2[1] + 14, 6)), fill: '#FFFFFF', op: 0.9 });
    },
  },
};

