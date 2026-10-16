// Headwear for the puppet kit (see CONVENTIONS.md). Hats and headpieces draw in the
// 'headwear' layer (after the front hair) inside their own group, a child of 'head'
// with the same yaw/pitch parallax as the front hair. Each piece measures the hair it
// sits on (fit(ctx)): the outline of the head plus hair is treated as an ellipse, so a
// hat seats lower on a buzz cut, rides higher and wider on an afro or long curls, and
// tall crowns grow to swallow a top bun or a mohawk crest.
import { closedSpline, openSpline, closedMixed, ellipse, compound, taper, shade, mix, hexToRgb, round1, rotatePt } from './geom.mjs';

const CX = 500;
const VIEW_TOP = 44; // top of the visible bust framing (view y 40) plus a hair of margin
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

function morph(fn, channels) {
  const d = fn({});
  const m = [];
  for (const [c, patch, neg] of channels) {
    const t = fn(patch);
    if (t.length !== d.length) throw new Error('headwear morph mismatch on ' + c);
    m.push(neg ? { c, d: t, n: true } : { c, d: t });
  }
  return { d, m };
}
const YAW = [['head.yaw', { yaw: 1 }], ['head.yaw', { yaw: -1 }, true]];
const SWING = [['hair.swing', { swing: 1 }], ['hair.swing', { swing: -1 }, true]];

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
    ins.push([p[0] + (a[0] - p[0]) * Math.min(0.48, r / la), p[1] + (a[1] - p[1]) * Math.min(0.48, r / la)]);
    outs.push([p[0] + (c[0] - p[0]) * Math.min(0.48, r / lc), p[1] + (c[1] - p[1]) * Math.min(0.48, r / lc)]);
  }
  const d = [{ op: 'M', v: [round1(outs[0][0]), round1(outs[0][1])] }];
  for (let j = 1; j <= n; j++) {
    const i = j % n;
    const p = pts[i];
    d.push({ op: 'L', v: [round1(ins[i][0]), round1(ins[i][1])] });
    d.push({ op: 'C', v: [round1(lerp(ins[i][0], p[0], 0.55)), round1(lerp(ins[i][1], p[1], 0.55)), round1(lerp(outs[i][0], p[0], 0.55)), round1(lerp(outs[i][1], p[1], 0.55)), round1(outs[i][0]), round1(outs[i][1])] });
  }
  d.push({ op: 'Z', v: [] });
  return d;
}

// ---- colour helpers ----
function dist(a, b) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}
// Use `want` unless it nearly matches one of `avoid`; then fall back to `alt`.
function pick(want, avoid, alt) {
  return avoid.some((c) => dist(want, c) < 70) ? alt : want;
}
function grad(ctx, id, hex, x0, y0, x1, y1, lift = 0.22, drop = -0.24) {
  ctx.b.grad(id, { kind: 'linear', start: [x0, y0], end: [x1, y1], stops: [{ at: 0, color: shade(hex, lift) }, { at: 0.5, color: hex }, { at: 1, color: shade(hex, drop) }] });
  return id;
}

// ---- fitting to the hair ----
// top: how far the hair rises above the skull top (px); side: how far the head+hair
// outline reaches past the skull half-width; spire: a narrow tall shape on top.
const PROFILE = {
  bald: { top: 2, side: 2 },
  buzz: { top: 10, side: 8 },
  'short-crop': { top: 22, side: 9 },
  'side-part': { top: 32, side: 9 },
  pompadour: { top: 68, side: 8 },
  spiky: { top: 50, side: 8 },
  'curly-short': { top: 38, side: 22 },
  bob: { top: 26, side: 24 },
  pixie: { top: 26, side: 9 },
  'shoulder-wavy': { top: 30, side: 36 },
  'long-straight': { top: 24, side: 34 },
  'long-curly': { top: 50, side: 76, big: true },
  bun: { top: 20, side: 9, spire: { top: 98, w: 64, dx: 6, kind: 'bun' } },
  ponytail: { top: 20, side: 9 },
  braids: { top: 20, side: 9 },
  'curtain-long': { top: 26, side: 40 },
  mohawk: { top: 12, side: 9, spire: { top: 116, w: 50, dx: 0, kind: 'crest' } },
  locs: { top: 30, side: 50 },
};

function fit(ctx) {
  const { k } = ctx;
  let P = PROFILE[ctx.hairStyle];
  if (ctx.hairStyle === 'afro') P = { top: k.H * 0.27 + 38, side: 100, big: true };
  if (!P) P = { top: 30, side: 24 };
  const hairTop = k.top - P.top;
  const E = { cx: CX, cy: k.temple, rx: k.w + P.side, ry: k.temple - hairTop };
  const spire = P.spire ? { top: k.top - P.spire.top, w: P.spire.w, dx: P.spire.dx, kind: P.spire.kind } : null;
  // the top a hat crown must reach; kinds lists which spires this hat swallows
  const cover = (kinds = ['bun', 'crest']) => (spire && kinds.includes(spire.kind) ? Math.min(hairTop, spire.top) : hairTop);
  // hair taller than the bust framing (an afro): hats grow, sit lower and run off the top
  const crop = hairTop < VIEW_TOP + 24;
  const maxW = (mult) => k.w * (crop ? 1.45 : mult);
  return { P, E, hairTop, spire, big: !!P.big, cover, crop, limit: crop ? -80 : VIEW_TOP, maxW };
}

// A seat on the hair outline: sinPhi 0 = widest point, 1 = very top. A seat wider than
// maxW slides up the outline until it fits (big hair lifts the hat).
function seat(E, sinPhi, maxW) {
  let s = sinPhi;
  let w = E.rx * Math.sqrt(1 - s * s);
  if (w > maxW) {
    w = maxW;
    s = Math.sqrt(1 - (maxW / E.rx) ** 2);
  }
  return { y: E.cy - E.ry * s, w };
}
function onOutline(E, ang, inset = 1) {
  return [E.cx + E.rx * Math.sin(ang) * inset, E.cy - E.ry * Math.cos(ang) * inset];
}

function hatGroup(ctx, id, tx = 13, ty = 6, pivot) {
  const gid = id + '-g';
  if (!ctx.b.groups.some((g) => g.id === gid)) ctx.b.group(gid, 'head', pivot || [CX, ctx.k.top], { tx: [['head.yaw', tx]], ty: [['head.pitch', ty]] });
  return gid;
}

// Sides of close-fitting hats hug the head when it turns: points far from the centre
// slide the way the head outline does (relative to the front hair's parallax).
function hugX(x, yaw, W) {
  const dx = Math.abs(x - CX);
  return x + yaw * (-0.06 * dx - 13 * Math.min(1, dx / W) ** 2);
}

// Soft shadow a brim or cap edge casts on the forehead (clipped to the face).
function edgeShadow(ctx, id, g, pts, depth) {
  const ys = pts.map((p) => p[1]);
  ctx.b.grad(id + '-shadeG', { kind: 'linear', start: [CX, Math.min(...ys)], end: [CX, Math.max(...ys) + depth], stops: [{ at: 0, color: '#2A1720', opacity: 0.34 }, { at: 1, color: '#2A1720', opacity: 0 }] });
  const lower = pts.slice().reverse().map(([x, y]) => [x, y + depth]);
  ctx.b.add({ id: id + '-shade', g, d: closedSpline([...pts, ...lower]), fill: id + '-shadeG', clip: 'head' });
}

// Five-point star (sharp) and a scalloped puff, both closed paths.
function starPath(x, y, r, rot = 0, inner = 0.45) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + rot + (i * Math.PI) / 5;
    const rr = i % 2 ? r * inner : r;
    pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr, true]);
  }
  return closedMixed(pts);
}
function puff(x, y, r, n = 12, depth = 0.14) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2;
    const rr = i % 2 ? r : r * (1 - depth);
    pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]);
  }
  return closedSpline(pts);
}
// A flower of n rounded petals around (x, y): each petal is a soft lobe, valleys between.
function blossom(x, y, r, n = 5, rot = 0, inner = 0.5) {
  const pts = [];
  const step = (Math.PI * 2) / n;
  for (let i = 0; i < n; i++) {
    const a = rot + i * step;
    for (const [da, rr] of [[-0.3, 0.9], [0, 1], [0.3, 0.9], [0.5, inner]]) {
      pts.push([x + Math.cos(a + da * step) * r * rr, y + Math.sin(a + da * step) * r * rr]);
    }
  }
  return closedSpline(pts);
}
function leaf(x, y, len, wid, ang) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const P = (u, v) => [x + c * u - s * v, y + s * u + c * v];
  return closedMixed([[...P(0, 0), true], P(len * 0.45, -wid), [...P(len, 0), true], P(len * 0.5, wid * 0.9)]);
}

// Arch across the top of the head (headbands, tiaras, wreaths): u in -1..1.
function arch(cx, yc, ye, AW) {
  return (u) => [cx + u * AW, yc + (ye - yc) * (0.55 * u * u + 0.45 * (1 - Math.sqrt(Math.max(0, 1 - u * u))))];
}

// Superellipse dome from (CX - W, baseY) over the top (topY) to (CX + W, baseY).
function domePts(W, baseY, topY, n = 2.4, count = 9) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const t = Math.PI - (i / (count - 1)) * Math.PI;
    const c = Math.cos(t);
    const x = Math.sign(c) * Math.abs(c) ** (2 / n);
    const y = Math.abs(Math.sin(t)) ** (2 / n);
    pts.push([CX + x * W, baseY - y * (baseY - topY)]);
  }
  return pts;
}

export const ITEMS = {
  'cowboy-hat': {
    name: 'Cowboy hat', slot: 'headwear', note: 'a wide-brimmed cowboy hat',
    headwear(ctx) {
      const { b, k, colors } = ctx;
      const id = 'cowboy-hat';
      const g = hatGroup(ctx, id);
      const F = fit(ctx);
      const st = seat(F.E, 0.3, F.maxW(1.24));
      const bw = Math.max(st.w + 4, k.w * 0.95);
      const by = st.y;
      const cw = bw * 0.95;
      const ct = Math.max(F.limit, Math.min(by - bw * 0.78, F.cover() - 10));
      const h = by - ct;
      const B = Math.min(bw * 1.52, 362);
      const col = '#A8723E';
      const line = shade(col, -0.45);
      const T = bw; // brim thickness unit
      const brimTop = [[-B, -0.36], [-0.84 * B, -0.17], [-0.56 * B, -0.1], [0, -0.02], [0.56 * B, -0.1], [0.84 * B, -0.17], [B, -0.36]].map(([x, y]) => [CX + x, by + y * T]);
      const brimBot = [[0.9 * B, -0.15], [0.55 * B, 0.1], [0, 0.18], [-0.55 * B, 0.1], [-0.9 * B, -0.15]].map(([x, y]) => [CX + x, by + y * T]);
      edgeShadow(ctx, id, g, brimBot.slice(1, 4).reverse(), 30);
      grad(ctx, id + '-crownG', col, CX - cw, ct, CX + cw, by);
      b.add({ id: id + '-crown', g, d: closedSpline([
        [CX - cw, by + 6], [CX - cw * 0.97, by - h * 0.45], [CX - cw * 0.8, ct + h * 0.13], [CX - cw * 0.44, ct], [CX, ct + h * 0.12],
        [CX + cw * 0.44, ct], [CX + cw * 0.8, ct + h * 0.13], [CX + cw * 0.97, by - h * 0.45], [CX + cw, by + 6], [CX, by + 10],
      ]), fill: id + '-crownG', stroke: line, sw: 3 });
      b.add({ id: id + '-crease', g, d: compound(
        openSpline([[CX - cw * 0.17, ct + h * 0.14], [CX - cw * 0.12, ct + h * 0.3], [CX - cw * 0.14, ct + h * 0.46]]),
        openSpline([[CX + cw * 0.17, ct + h * 0.14], [CX + cw * 0.12, ct + h * 0.3], [CX + cw * 0.14, ct + h * 0.46]]),
      ), fill: 'none', stroke: line, sw: 2.6, op: 0.45 });
      b.add({ id: id + '-crownShine', g, d: taper([[CX - cw * 0.66, by - h * 0.3], [CX - cw * 0.72, by - h * 0.58], [CX - cw * 0.6, ct + h * 0.2]], [4, 10, 3]), fill: '#FFF4E0', op: 0.2 });
      const bandCol = pick(colors.accent, [col], '#5A3A22');
      const bh = Math.min(h * 0.2, 30);
      b.add({ id: id + '-band', g, d: closedMixed([[CX - cw, by + 4, true], [CX - cw * 0.995, by - bh - 3, true], [CX, by - bh + 3], [CX + cw * 0.995, by - bh - 3, true], [CX + cw, by + 4, true], [CX, by + 8]]), fill: bandCol, stroke: shade(bandCol, -0.45), sw: 2.5 });
      b.add({ id: id + '-concho', g, d: ellipse(CX - cw * 0.42, by - bh * 0.6, 7.5, 6.5), fill: '#D9DDE3', stroke: '#7D8490', sw: 2 });
      grad(ctx, id + '-brimG', col, CX - B, by - 0.36 * T, CX + B * 0.6, by + 0.2 * T, 0.16, -0.3);
      b.add({ id: id + '-brim', g, d: closedSpline([...brimTop, ...brimBot]), fill: id + '-brimG', stroke: line, sw: 3.2 });
      b.add({ id: id + '-brimShine', g, d: openSpline([[lerp(brimTop[0][0], brimTop[1][0], 0.45), lerp(brimTop[0][1], brimTop[1][1], 0.45) + 5], [brimTop[1][0], brimTop[1][1] + 5], [brimTop[2][0], brimTop[2][1] + 5]]), fill: 'none', stroke: shade(col, 0.45), sw: 2.6, op: 0.6 });
      b.add({ id: id + '-brimEdge', g, d: openSpline(brimBot.slice(1, 4).map(([x, y]) => [x, y - 6])), fill: 'none', stroke: line, sw: 2, op: 0.35 });
    },
  },

  beanie: {
    name: 'Beanie', slot: 'headwear', note: 'a cosy knit beanie with a pom-pom',
    headwear(ctx) {
      const { b, k, colors } = ctx;
      const id = 'beanie';
      const g = hatGroup(ctx, id);
      const F = fit(ctx);
      const st = seat(F.E, 0.2, F.maxW(1.3));
      const by = st.y;
      const W = st.w + 8;
      const sideY = by + k.H * 0.1;
      const cuffH = k.H * 0.1;
      const col = pick(colors.accent, [colors.hair], '#D8574A');
      const line = shade(col, -0.45);
      const want = Math.min(by - cuffH - W * 0.62, F.cover() - 14);
      const ct = Math.max(F.limit, want);
      const pr = Math.min(30, (ct - 42) / 1.72);
      const yAt = (x) => by + (sideY - by) * Math.min(1, ((x - CX) / W) ** 2);
      const base = sideY - cuffH + 6;
      const hD = base - ct;
      const dome = (p) => {
        const pts = [...domePts(W * 1.01, base, ct, 2.5, 9), [CX + W * 0.5, yAt(CX + W * 0.5) - cuffH + 12], [CX - W * 0.5, yAt(CX - W * 0.5) - cuffH + 12]];
        return closedSpline(pts.map(([x, y]) => [hugX(x, p.yaw || 0, W), y]));
      };
      grad(ctx, id + '-domeG', col, CX - W, ct, CX + W, base, 0.2, -0.22);
      b.add({ id: id + '-dome', g, ...morph(dome, YAW), fill: id + '-domeG', stroke: line, sw: 3 });
      const knit = (p) => compound(...[-0.64, -0.32, 0, 0.32, 0.64].map((u) => openSpline([
        [CX + u * W, yAt(CX + u * W) - cuffH + 2], [CX + u * W * 0.94, lerp(base, ct, 0.5)], [CX + u * W * 0.6, lerp(base, ct, 0.9)],
      ].map(([x, y]) => [hugX(x, p.yaw || 0, W), y]))));
      b.add({ id: id + '-knit', g, ...morph(knit, YAW), fill: 'none', stroke: line, sw: 2.4, op: 0.22 });
      const cuff = (p) => {
        const yw = p.yaw || 0;
        const xs = [-1, -0.62, 0, 0.62, 1];
        const low = xs.map((u) => [hugX(CX + u * W * 1.03, yw, W), yAt(CX + u * W) + (Math.abs(u) === 1 ? 2 : 4)]);
        const high = xs.slice().reverse().map((u) => [hugX(CX + u * W * 1.04, yw, W), yAt(CX + u * W) - cuffH]);
        return closedMixed([[...low[0], true], ...low.slice(1, -1), [...low[4], true], [...high[0], true], ...high.slice(1, -1), [...high[4], true]]);
      };
      const cuffCol = shade(col, -0.1);
      b.grad(id + '-cuffG', { kind: 'linear', start: [CX, by - cuffH], end: [CX, sideY + 4], stops: [{ at: 0, color: shade(cuffCol, 0.12) }, { at: 1, color: shade(cuffCol, -0.16) }] });
      b.add({ id: id + '-cuff', g, ...morph(cuff, YAW), fill: id + '-cuffG', stroke: line, sw: 3 });
      const ribs = (p) => {
        const out = [];
        for (let i = -7; i <= 7; i++) {
          const x = CX + (i / 7.6) * W;
          const xx = hugX(x, p.yaw || 0, W);
          out.push(openSpline([[xx, yAt(x) - cuffH + 6], [xx, yAt(x) - 2]]));
        }
        return compound(...out);
      };
      b.add({ id: id + '-ribs', g, ...morph(ribs, YAW), fill: 'none', stroke: line, sw: 2.6, op: 0.3 });
      if (pr >= 15) {
        const pc = mix(col, '#FFFFFF', 0.55);
        b.grad(id + '-pomG', { kind: 'radial', center: [CX - 8, ct - pr - 8], radius: pr * 1.4, stops: [{ at: 0, color: shade(pc, 0.3) }, { at: 1, color: shade(pc, -0.14) }] });
        b.add({ id: id + '-pom', g, d: puff(CX + 3, ct - pr * 0.72, pr, 15, 0.09), fill: id + '-pomG', stroke: shade(pc, -0.4), sw: 2.6 });
      }
      b.add({ id: id + '-shine', g, d: taper([[CX - W * 0.72, base - hD * 0.24], [CX - W * 0.62, base - hD * 0.6], [CX - W * 0.34, ct + hD * 0.1]], [5, 12, 4]), fill: '#FFFFFF', op: 0.16 });
    },
  },

  'baseball-cap': {
    name: 'Baseball cap', slot: 'headwear', note: 'a baseball cap with a curved bill',
    headwear(ctx) {
      const { b, k, colors } = ctx;
      const id = 'baseball-cap';
      const g = hatGroup(ctx, id);
      const F = fit(ctx);
      const st = seat(F.E, 0.3, F.maxW(1.22));
      const by = st.y + 4;
      const W = st.w + 6;
      const sideY = by + k.H * 0.07;
      const ct = Math.max(F.limit, Math.min(by - W * 0.74, F.cover(['crest']) - 8));
      const hD = sideY - ct;
      const col = pick(colors.accent, [colors.hair], '#2F6FB5');
      const line = shade(col, -0.45);
      const dome = (p) => closedSpline([...domePts(W, sideY, ct, 2.3, 9), [CX + W * 0.5, by + 4], [CX - W * 0.5, by + 4]].map(([x, y]) => [hugX(x, p.yaw || 0, W), y]));
      grad(ctx, id + '-domeG', col, CX - W, ct, CX + W, by, 0.22, -0.22);
      b.add({ id: id + '-dome', g, ...morph(dome, YAW), fill: id + '-domeG', stroke: line, sw: 3 });
      const seams = (p) => compound(...[-0.62, 0, 0.62].map((u) => openSpline([
        [CX, ct + 3], [CX + u * W * 0.66, lerp(sideY, ct, 0.62)], [CX + u * W * 0.94, by - 6],
      ].map(([x, y]) => [hugX(x, p.yaw || 0, W), y]))));
      b.add({ id: id + '-seams', g, ...morph(seams, YAW), fill: 'none', stroke: line, sw: 2.2, op: 0.42 });
      b.add({ id: id + '-eyelets', g, d: compound(ellipse(CX - W * 0.38, lerp(sideY, ct, 0.66), 4, 4), ellipse(CX + W * 0.38, lerp(sideY, ct, 0.66), 4, 4)), fill: shade(col, -0.5), op: 0.55 });
      b.add({ id: id + '-button', g, d: ellipse(CX, ct + 2, 12, 6.5), fill: shade(col, -0.08), stroke: line, sw: 2.4 });
      b.add({ id: id + '-shine', g, d: taper([[CX - W * 0.74, by - hD * 0.25], [CX - W * 0.64, by - hD * 0.58], [CX - W * 0.34, ct + hD * 0.1]], [4, 11, 3]), fill: '#FFFFFF', op: 0.18 });
      // bill: a crescent reaching toward the viewer, its front edge curving down
      const billTop = [[-0.98, -2], [-0.5, -10], [0, -12], [0.5, -10], [0.98, -2]].map(([u, dy]) => [CX + u * W, by + dy]);
      const billBot = [[1.04, 14], [0.6, 44], [0, 52], [-0.6, 44], [-1.04, 14]].map(([u, dy]) => [CX + u * W, by + dy]);
      edgeShadow(ctx, id, g, billBot.slice(1, 4).reverse(), 26);
      const billCol = shade(col, -0.06);
      grad(ctx, id + '-billG', billCol, CX - W, by - 12, CX + W * 0.4, by + 52, 0.2, -0.22);
      const billPath = closedMixed([[...billTop[0], true], ...billTop.slice(1, -1), [...billTop[4], true], [...billBot[0], true], ...billBot.slice(1, -1), [...billBot[4], true]]);
      b.add({ id: id + '-bill', g, d: billPath, fill: id + '-billG', stroke: line, sw: 3 });
      b.add({ id: id + '-billUnder', g, d: closedSpline([...billBot.map(([x, y]) => [CX + (x - CX) * 0.99, y - 1]), ...billBot.slice().reverse().map(([x, y]) => [CX + (x - CX) * 0.97, y - 10])]), fill: shade(col, -0.5), op: 0.55, clip: id + '-bill' });
      b.add({ id: id + '-billEdge', g, d: openSpline(billBot.slice(1, 4).reverse().map(([x, y]) => [CX + (x - CX) * 0.96, y - 12])), fill: 'none', stroke: shade(col, 0.5), sw: 2.2, op: 0.55 });
      b.add({ id: id + '-billStitch', g, d: openSpline(billTop.map(([x, y]) => [CX + (x - CX) * 0.92, y + 9])), fill: 'none', stroke: line, sw: 1.8, op: 0.35 });
    },
  },

  'top-hat': {
    name: 'Top hat', slot: 'headwear', note: 'a tall, elegant top hat',
    headwear(ctx) {
      const { b, k, colors } = ctx;
      const id = 'top-hat';
      const g = hatGroup(ctx, id);
      const F = fit(ctx);
      const st = seat(F.E, 0.32, F.maxW(1.16));
      const bw = Math.max(st.w + 2, k.w * 0.94);
      const by = st.y;
      const cw = bw * 0.9;
      const cwt = cw * 1.05;
      const ct = Math.max(F.limit, Math.min(by - bw * 1.25, F.cover() - 10));
      const h = by - ct;
      const col = '#2F2B37';
      const line = '#17121C';
      grad(ctx, id + '-crownG', col, CX - cw, ct, CX + cw, by, 0.2, -0.2);
      b.add({ id: id + '-crown', g, d: closedMixed([
        [CX - cw, by + 8, true], [CX - cw * 0.965, by - h * 0.5], [CX - cwt, ct + 5, true], [CX, ct - 3], [CX + cwt, ct + 5, true], [CX + cw * 0.965, by - h * 0.5], [CX + cw, by + 8, true],
      ]), fill: id + '-crownG', stroke: line, sw: 3 });
      b.add({ id: id + '-lid', g, d: openSpline([[CX - cwt + 4, ct + 6], [CX, ct + 11], [CX + cwt - 4, ct + 6]]), fill: 'none', stroke: shade(col, 0.3), sw: 2.2, op: 0.5 });
      b.add({ id: id + '-satin', g, d: taper([[CX - cw * 0.58, by - h * 0.22], [CX - cw * 0.62, by - h * 0.55], [CX - cw * 0.6, ct + h * 0.12]], [6, 13, 5]), fill: '#FFFFFF', op: 0.13 });
      const bandCol = pick(colors.accent, [col], '#B8334A');
      const bh = Math.min(h * 0.18, 34);
      b.add({ id: id + '-band', g, d: closedMixed([[CX - cw, by + 4, true], [CX - cw * 0.99, by - bh - 3, true], [CX, by - bh + 3], [CX + cw * 0.99, by - bh - 3, true], [CX + cw, by + 4, true], [CX, by + 8]]), fill: bandCol, stroke: shade(bandCol, -0.45), sw: 2.4 });
      b.add({ id: id + '-bandShine', g, d: openSpline([[CX - cw * 0.9, by - bh + 2], [CX - cw * 0.4, by - bh + 6]]), fill: 'none', stroke: shade(bandCol, 0.45), sw: 2, op: 0.55 });
      const B = bw * 1.26;
      edgeShadow(ctx, id, g, [[CX - B * 0.55, by + 15], [CX, by + 19], [CX + B * 0.55, by + 15]], 24);
      grad(ctx, id + '-brimG', col, CX - B, by - 20, CX + B, by + 18, 0.18, -0.2);
      b.add({ id: id + '-brim', g, d: closedSpline([
        [CX - B, by - 22], [CX - B * 0.8, by - 5], [CX, by - 1], [CX + B * 0.8, by - 5], [CX + B, by - 22],
        [CX + B * 0.93, by - 4], [CX + B * 0.6, by + 14], [CX, by + 19], [CX - B * 0.6, by + 14], [CX - B * 0.93, by - 4],
      ]), fill: id + '-brimG', stroke: line, sw: 3 });
      b.add({ id: id + '-brimShine', g, d: openSpline([[CX - B * 0.94, by - 18], [CX - B * 0.72, by - 4], [CX - B * 0.35, by - 1]]), fill: 'none', stroke: shade(col, 0.45), sw: 2.2, op: 0.55 });
    },
  },

  beret: {
    name: 'Beret', slot: 'headwear', note: 'a soft beret tilted to one side',
    headwear(ctx) {
      const { b, k } = ctx;
      const id = 'beret';
      const g = hatGroup(ctx, id);
      const F = fit(ctx);
      const st = seat(F.E, 0.5, F.maxW(1.12));
      const by = st.y;
      const bw = st.w + 4;
      const topY = Math.max(F.crop ? F.limit : VIEW_TOP + 2, Math.min(F.cover(['crest']) - 14, by - bw * 0.42));
      const h = by - topY;
      const col = '#B8394A';
      const line = shade(col, -0.45);
      b.grad(id + '-g1', { kind: 'radial', center: [CX - bw * 0.3, topY + h * 0.2], focal: [CX - bw * 0.4, topY + h * 0.1], radius: bw * 1.6, stops: [{ at: 0, color: shade(col, 0.3) }, { at: 0.5, color: col }, { at: 1, color: shade(col, -0.32) }] });
      const body = [
        [CX - bw * 0.9, by + 4], [CX - bw * 1.04, by - h * 0.34], [CX - bw * 0.74, topY + h * 0.16], [CX - bw * 0.2, topY + h * 0.02], [CX + bw * 0.5, topY + h * 0.06],
        [CX + bw * 1.12, by - h * 0.46], [CX + bw * 1.36, by + h * 0.06], [CX + bw * 1.18, by + h * 0.3], [CX + bw * 0.86, by + h * 0.12], [CX, by + 9],
      ];
      b.add({ id: id + '-body', g, d: closedSpline(body), fill: id + '-g1', stroke: line, sw: 3 });
      b.add({ id: id + '-fold', g, d: openSpline([[CX + bw * 0.56, by - h * 0.14], [CX + bw * 0.96, by - h * 0.02], [CX + bw * 1.24, by + h * 0.16]]), fill: 'none', stroke: line, sw: 2.4, op: 0.35 });
      b.add({ id: id + '-piping', g, d: openSpline([[CX - bw * 0.88, by + 1], [CX - bw * 0.4, by + 6], [CX + bw * 0.2, by + 7], [CX + bw * 0.78, by + 1]]), fill: 'none', stroke: shade(col, -0.25), sw: 7 });
      b.add({ id: id + '-pipingLine', g, d: openSpline([[CX - bw * 0.86, by - 3], [CX - bw * 0.4, by + 2], [CX + bw * 0.2, by + 3], [CX + bw * 0.76, by - 3]]), fill: 'none', stroke: line, sw: 1.6, op: 0.6 });
      const sx = CX - bw * 0.16;
      b.add({ id: id + '-stem', g, d: taper([[sx, topY + 6], [sx + 3, topY - 6], [sx + 8, topY - 13]], [9, 7, 5]), fill: shade(col, -0.1), stroke: line, sw: 2 });
      b.add({ id: id + '-shine', g, d: taper([[CX - bw * 0.72, by - h * 0.32], [CX - bw * 0.5, topY + h * 0.24], [CX - bw * 0.12, topY + h * 0.1]], [3, 9, 3]), fill: '#FFFFFF', op: 0.2 });
    },
  },

  'sun-hat': {
    name: 'Sun hat', slot: 'headwear', note: 'a floppy straw sun hat with a ribbon',
    headwear(ctx) {
      const { b, k, colors } = ctx;
      const id = 'sun-hat';
      const g = hatGroup(ctx, id);
      const F = fit(ctx);
      const st = seat(F.E, 0.3, F.maxW(1.2));
      const bw = Math.max(st.w + 4, k.w * 0.95);
      const by = st.y;
      const B = Math.min(bw * 1.95, 362);
      const ct = Math.max(F.limit, Math.min(by - bw * 0.6, F.cover() - 8));
      const h = by - ct;
      const col = '#E9CD8C';
      const line = shade(col, -0.48);
      const T = bw;
      // brim: back edge (seen beyond the crown) and a wavy, drooping front edge
      const back = [[-1, 0.13], [-0.75, -0.1], [-0.4, -0.12], [0, -0.07], [0.4, -0.12], [0.75, -0.1], [1, 0.13]].map(([u, v]) => [CX + u * B, by + v * T]);
      const front = [];
      for (let i = 0; i <= 10; i++) {
        const u = 0.94 - (i / 10) * 1.88;
        const v = 0.3 + 0.14 * (1 - u * u) + (i % 2 ? 0.03 : -0.01);
        front.push([CX + u * B, by + v * T]);
      }
      edgeShadow(ctx, id, g, front.slice(3, 8).reverse(), 34);
      grad(ctx, id + '-crownG', col, CX - bw, ct, CX + bw, by, 0.25, -0.2);
      b.add({ id: id + '-crown', g, d: closedSpline([[CX - bw * 0.9, by + 6], [CX - bw * 0.9, lerp(by, ct, 0.5)], [CX - bw * 0.64, ct + h * 0.1], [CX, ct], [CX + bw * 0.64, ct + h * 0.1], [CX + bw * 0.9, lerp(by, ct, 0.5)], [CX + bw * 0.9, by + 6], [CX, by + 10]]), fill: id + '-crownG', stroke: line, sw: 3 });
      b.add({ id: id + '-weave', g, d: compound(
        openSpline([[CX - bw * 0.74, lerp(by, ct, 0.62)], [CX, lerp(by, ct, 0.72)], [CX + bw * 0.74, lerp(by, ct, 0.62)]]),
        openSpline([[CX - bw * 0.48, ct + h * 0.14], [CX, ct + h * 0.08], [CX + bw * 0.48, ct + h * 0.14]]),
      ), fill: 'none', stroke: line, sw: 2, op: 0.3 });
      const rib = pick(colors.accent, [col], '#E0637A');
      const bh = Math.min(h * 0.26, 26);
      b.add({ id: id + '-ribbon', g, d: closedMixed([[CX - bw * 0.91, by + 4, true], [CX - bw * 0.91, by - bh - 2, true], [CX, by - bh + 3], [CX + bw * 0.91, by - bh - 2, true], [CX + bw * 0.91, by + 4, true], [CX, by + 8]]), fill: rib, stroke: shade(rib, -0.42), sw: 2.4 });
      grad(ctx, id + '-brimG', col, CX - B, by - 0.12 * T, CX + B * 0.5, by + 0.45 * T, 0.2, -0.26);
      b.add({ id: id + '-brim', g, d: closedSpline([...back, ...front]), fill: id + '-brimG', stroke: line, sw: 3 });
      const rings = [0.1, 0.2].map((dv) => openSpline(front.slice(1, 10).filter((_, i) => i % 2 === 0).map(([x, y]) => [CX + (x - CX) * (1 - dv * 0.8), y - dv * T * 0.9])));
      b.add({ id: id + '-straw', g, d: compound(...rings), fill: 'none', stroke: line, sw: 2, op: 0.28 });
      // ribbon bow on the left side, its tails dangling over the brim
      const bx = CX - bw * 0.7;
      const byy = by - bh * 0.5;
      const tails = (p) => {
        const s = (p.swing || 0) * 10;
        return compound(
          closedMixed([[bx - 4, byy + 4, true], [bx - 22 + s * 0.6, byy + 40], [bx - 30 + s, byy + 70, true], [bx - 20 + s, byy + 62, true], [bx - 12 + s, byy + 72, true], [bx - 4 + s * 0.6, byy + 38], [bx + 6, byy + 6, true]]),
          closedMixed([[bx + 4, byy + 4, true], [bx + 14 + s * 0.6, byy + 34], [bx + 12 + s, byy + 58, true], [bx + 20 + s, byy + 51, true], [bx + 28 + s, byy + 58, true], [bx + 24 + s * 0.6, byy + 30], [bx + 12, byy + 4, true]]),
        );
      };
      b.add({ id: id + '-tails', g, ...morph(tails, SWING), fill: shade(rib, -0.08), stroke: shade(rib, -0.42), sw: 2.2 });
      b.add({ id: id + '-loops', g, d: compound(
        closedSpline([[bx, byy], [bx - 20, byy - 18], [bx - 34, byy - 8], [bx - 30, byy + 10], [bx - 12, byy + 8]]),
        closedSpline([[bx, byy], [bx + 18, byy - 20], [bx + 33, byy - 10], [bx + 30, byy + 9], [bx + 12, byy + 8]]),
      ), fill: rib, stroke: shade(rib, -0.42), sw: 2.2 });
      b.add({ id: id + '-knot', g, d: ellipse(bx, byy + 1, 8, 9), fill: shade(rib, -0.12), stroke: shade(rib, -0.42), sw: 2 });
      b.add({ id: id + '-brimShine', g, d: openSpline([back[0], back[1], back[2]].map(([x, y]) => [x + 4, y + 3])), fill: 'none', stroke: shade(col, 0.5), sw: 2.4, op: 0.55 });
    },
  },

  crown: {
    name: 'Crown', slot: 'headwear', note: 'a golden crown set with jewels',
    headwear(ctx) {
      const { b, k } = ctx;
      const id = 'crown';
      const g = hatGroup(ctx, id);
      const F = fit(ctx);
      const big = F.big ? 1.12 : 1;
      const cw = k.w * 0.66 * big;
      const ratio = Math.min(0.95, (cw * 1.1) / F.E.rx);
      const tipH = 58 * big;
      const bandH = 26 * big;
      const yb = Math.max(VIEW_TOP + tipH + bandH + 18, F.E.cy - F.E.ry * Math.sqrt(1 - ratio * ratio) + 8);
      const sag = (x) => 8 * (1 - (x / cw) ** 2);
      const bandTop = (x) => yb - bandH + sag(x) - 4;
      const yT = (f) => yb - bandH - tipH * f;
      const gold = '#E9B949';
      const line = '#8A5A12';
      b.grad(id + '-gold', { kind: 'linear', start: [CX - cw, yT(1)], end: [CX + cw, yb + 6], stops: [{ at: 0, color: '#FFE89A' }, { at: 0.45, color: gold }, { at: 1, color: '#B07A22' }] });
      b.grad(id + '-velvet', { kind: 'radial', center: [CX - cw * 0.3, yT(0.7)], radius: cw * 1.2, stops: [{ at: 0, color: '#D0405A' }, { at: 1, color: '#7E1730' }] });
      b.add({ id: id + '-velvet', g, d: closedSpline([[CX - cw * 0.94, bandTop(-cw * 0.94) + 4], [CX - cw * 0.8, yT(0.5)], [CX - cw * 0.3, yT(0.82)], [CX + cw * 0.3, yT(0.82)], [CX + cw * 0.8, yT(0.5)], [CX + cw * 0.94, bandTop(cw * 0.94) + 4], [CX, yb - bandH * 0.4]]), fill: id + '-velvet', stroke: '#5E1024', sw: 2.4 });
      const pts = [
        [CX - cw, yb - 4, true], [CX, yb + 6], [CX + cw, yb - 4, true],
        [CX + cw * 1.08, yT(0.72), true], [CX + cw * 0.74, bandTop(cw * 0.74) - 4, true], [CX + cw * 0.5, yT(0.86), true], [CX + cw * 0.25, bandTop(cw * 0.25) - 4, true],
        [CX, yT(1), true], [CX - cw * 0.25, bandTop(-cw * 0.25) - 4, true], [CX - cw * 0.5, yT(0.86), true], [CX - cw * 0.74, bandTop(-cw * 0.74) - 4, true], [CX - cw * 1.08, yT(0.72), true],
      ];
      b.add({ id: id + '-body', g, d: closedMixed(pts), fill: id + '-gold', stroke: line, sw: 3 });
      b.add({ id: id + '-trim', g, d: compound(
        openSpline([-1, -0.5, 0, 0.5, 1].map((u) => [CX + u * cw * 0.99, bandTop(u * cw) + 3])),
        openSpline([-1, -0.5, 0, 0.5, 1].map((u) => [CX + u * cw * 0.99, yb - 9 + sag(u * cw)])),
      ), fill: 'none', stroke: line, sw: 2, op: 0.55 });
      const balls = [[1.08, 0.72], [0.5, 0.86], [0, 1], [-0.5, 0.86], [-1.08, 0.72]].map(([u, f]) => ellipse(CX + u * cw, yT(f) - 5 * big, 7 * big, 7 * big));
      b.add({ id: id + '-pearls', g, d: compound(...balls), fill: '#FFF3D6', stroke: line, sw: 2 });
      const midY = (x) => (bandTop(x) + yb - 4 + sag(x)) / 2 + 2;
      b.add({ id: id + '-ruby', g, d: closedSpline([[CX, midY(0) - 11 * big], [CX + 8 * big, midY(0)], [CX, midY(0) + 11 * big], [CX - 8 * big, midY(0)]]), fill: '#D2304A', stroke: '#7A1426', sw: 2 });
      b.add({ id: id + '-sapphires', g, d: compound(ellipse(CX - cw * 0.55, midY(cw * 0.55), 6.5 * big, 6.5 * big), ellipse(CX + cw * 0.55, midY(cw * 0.55), 6.5 * big, 6.5 * big)), fill: '#2E6FD0', stroke: '#173F80', sw: 2 });
      b.add({ id: id + '-emeralds', g, d: compound(ellipse(CX - cw * 0.28, midY(cw * 0.28), 4.5 * big, 4.5 * big), ellipse(CX + cw * 0.28, midY(cw * 0.28), 4.5 * big, 4.5 * big)), fill: '#2FA36B', stroke: '#145A39', sw: 1.6 });
      b.add({ id: id + '-sparkle', g, d: compound(ellipse(CX - 3 * big, midY(0) - 5 * big, 2.6, 2.6), ellipse(CX - cw * 0.55 - 2, midY(cw * 0.55) - 2.5, 2, 2), ellipse(CX + cw * 0.55 - 2, midY(cw * 0.55) - 2.5, 2, 2)), fill: '#FFFFFF', op: 0.85 });
      b.add({ id: id + '-shine', g, d: taper([[CX - cw * 0.92, yT(0.55)], [CX - cw * 0.86, bandTop(cw) + 2], [CX - cw * 0.5, yb - 6]], [3, 6, 2.5]), fill: '#FFFBEA', op: 0.5 });
    },
  },

  tiara: {
    name: 'Tiara', slot: 'headwear', note: 'a sparkling silver tiara',
    headwear(ctx) {
      const { b, k } = ctx;
      const id = 'tiara';
      const g = hatGroup(ctx, id);
      const F = fit(ctx);
      const AW = k.w * 0.92 + Math.min(F.P.side, 20) * 0.3;
      const yc = k.top + k.H * 0.1 - Math.min(F.P.top, 26) * 0.35;
      const A = arch(CX, yc, k.temple + 8, AW);
      const silver = '#DDE2EA';
      const line = '#7D8596';
      b.grad(id + '-silver', { kind: 'linear', start: [CX - AW * 0.4, yc - 50], end: [CX + AW * 0.4, yc + 10], stops: [{ at: 0, color: '#FFFFFF' }, { at: 0.5, color: silver }, { at: 1, color: '#A9B1BF' }] });
      const us = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];
      b.add({ id: id + '-band', g, d: taper(us.map(A), us.map((u) => 9 - 4 * Math.abs(u))), fill: id + '-silver', stroke: line, sw: 2 });
      const o = (u, dy) => { const [x, y] = A(u); return [x, y + dy]; };
      const W = 0.44;
      const orn = [
        [...o(-W, 3), true], [...o(-0.36, -13)], [...o(-0.28, -9), true], [...o(-0.19, -27), true], [...o(-0.11, -14), true],
        [...o(0, -48), true], [...o(0.11, -14), true], [...o(0.19, -27), true], [...o(0.28, -9), true], [...o(0.36, -13)], [...o(W, 3), true], [...o(0, 5)],
      ];
      b.add({ id: id + '-ornament', g, d: closedMixed(orn), fill: id + '-silver', stroke: line, sw: 2.4 });
      b.add({ id: id + '-filigree', g, d: compound(
        openSpline([o(-0.34, -4), o(-0.26, -12), o(-0.18, -6)]),
        openSpline([o(0.34, -4), o(0.26, -12), o(0.18, -6)]),
        openSpline([o(-0.07, -8), o(0, -26), o(0.07, -8)]),
      ), fill: 'none', stroke: line, sw: 1.8, op: 0.6 });
      const [gx, gy] = o(0, -20);
      b.add({ id: id + '-gem', g, d: closedSpline([[gx, gy - 13], [gx + 8, gy + 1], [gx, gy + 10], [gx - 8, gy + 1]]), fill: '#E8679A', stroke: '#9A2E5A', sw: 2 });
      b.add({ id: id + '-gems', g, d: compound(ellipse(...o(-0.19, -14), 4.6, 4.6), ellipse(...o(0.19, -14), 4.6, 4.6)), fill: '#6FD3E8', stroke: '#2C7F92', sw: 1.6 });
      b.add({ id: id + '-pearls', g, d: compound(ellipse(...o(0, -51), 4.4, 4.4), ellipse(...o(-0.19, -30), 3.6, 3.6), ellipse(...o(0.19, -30), 3.6, 3.6), ellipse(...o(-0.36, -16), 3, 3), ellipse(...o(0.36, -16), 3, 3)), fill: '#FFFDF7', stroke: line, sw: 1.4 });
      b.add({ id: id + '-sparkle', g, d: compound(ellipse(gx - 2.5, gy - 4, 2.4, 2.4), starPath(...o(-0.08, -40), 7, 0, 0.3), starPath(...o(0.3, -30), 5, 0.3, 0.3)), fill: '#FFFFFF', op: 0.9 });
    },
  },

  'flower-crown': {
    name: 'Flower crown', slot: 'headwear', note: 'a crown of fresh flowers and leaves',
    headwear(ctx) {
      const { b, k } = ctx;
      const id = 'flower-crown';
      const g = hatGroup(ctx, id);
      const F = fit(ctx);
      const AW = k.w + 6 + Math.min(F.P.side, 30) * 0.4;
      const yc = k.top + k.H * 0.13 - Math.min(F.P.top, 30) * 0.3;
      const A = arch(CX, yc, k.temple + 2, AW);
      const us = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];
      b.add({ id: id + '-vine', g, d: openSpline(us.map(A)), fill: 'none', stroke: '#4F7F3C', sw: 6 });
      const tan = (u) => { const p = A(u - 0.02); const q = A(u + 0.02); return Math.atan2(q[1] - p[1], q[0] - p[0]); };
      const leafAt = [-0.82, -0.48, -0.16, 0.16, 0.48, 0.82];
      b.add({ id: id + '-leaves', g, d: compound(...leafAt.map((u, i) => { const [x, y] = A(u); const t = tan(u); return leaf(x, y, 36, 11, t + (i % 2 ? -0.95 : Math.PI + 0.95)); })), fill: '#7DBA67', stroke: '#3E6F3A', sw: 2 });
      const flowers = [[-0.97, 23], [-0.64, 27], [-0.32, 22], [0, 30], [0.32, 22], [0.64, 27], [0.97, 23]];
      const palette = [['#F48FB1', '#C2507A'], ['#FFF4EC', '#B99A8E'], ['#FFD45C', '#B98A1E'], ['#B9A0E6', '#6F55A6']];
      const centres = [];
      palette.forEach(([fill, stroke], ci) => {
        const ring = flowers.filter((_, i) => i % palette.length === ci).map(([u, r], j) => { const [x, y] = A(u); centres.push([x, y, r]); return blossom(x, y - 2, r, 5, u * 2 + j, 0.5); });
        if (ring.length) b.add({ id: id + '-petals' + ci, g, d: compound(...ring), fill, stroke, sw: 2 });
      });
      b.add({ id: id + '-centres', g, d: compound(...centres.map(([x, y, r]) => ellipse(x, y - 2, r * 0.3, r * 0.3))), fill: '#F2A93B', stroke: '#9A5A16', sw: 1.6 });
      b.add({ id: id + '-glow', g, d: compound(...centres.map(([x, y, r]) => ellipse(x - r * 0.35, y - r * 0.45, r * 0.22, r * 0.16))), fill: '#FFFFFF', op: 0.45 });
    },
  },

  headband: {
    name: 'Headband', slot: 'headwear', note: 'a smooth headband',
    headwear(ctx) {
      const { b, k, colors } = ctx;
      const id = 'headband';
      const g = hatGroup(ctx, id);
      const F = fit(ctx);
      const AW = k.w + 4 + Math.min(F.P.side, 20) * 0.4;
      const yc = k.top - Math.min(F.P.top, 26) + k.H * 0.09;
      const A = arch(CX, yc, k.temple + 30, AW);
      const col = pick(colors.accent, [colors.hair, colors.skin], '#E2557A');
      const us = [-1, -0.8, -0.55, -0.3, 0, 0.3, 0.55, 0.8, 1];
      const ws = us.map((u) => 20 - 8 * Math.abs(u) ** 2);
      grad(ctx, id + '-g1', col, CX - AW * 0.6, yc - 20, CX + AW * 0.6, yc + 60, 0.25, -0.2);
      b.add({ id: id + '-band', g, d: taper(us.map(A), ws), fill: id + '-g1', stroke: shade(col, -0.45), sw: 2.6 });
      b.add({ id: id + '-shine', g, d: openSpline([-0.78, -0.55, -0.3, -0.05].map((u) => { const [x, y] = A(u); return [x, y - 3]; })), fill: 'none', stroke: shade(col, 0.55), sw: 3, op: 0.6 });
    },
  },

  'hair-bow': {
    name: 'Hair bow', slot: 'headwear', note: 'a big ribbon bow in the hair',
    headwear(ctx) {
      const { b, k, colors } = ctx;
      const id = 'hair-bow';
      const F = fit(ctx);
      let at;
      let rot;
      let sc = F.big ? 1.55 : 1.35;
      let g;
      if (ctx.hairStyle === 'bun') {
        at = [CX + 6, k.top - 16];
        rot = 0;
        g = hatGroup(ctx, id);
      } else if (ctx.hairStyle === 'ponytail') {
        at = [CX + k.w + 18, k.top + 20];
        rot = 0.45;
        sc = 1.1;
        g = hatGroup(ctx, id, -9, -5);
      } else {
        at = onOutline(F.E, 0.8, 0.9);
        rot = 0.5;
        g = hatGroup(ctx, id);
      }
      const col = pick(colors.accent, [colors.hair], '#E8506E');
      const line = shade(col, -0.45);
      const T = (x, y) => { const p = rotatePt([at[0] + x * sc, at[1] + y * sc], at, rot); return [p[0], p[1]]; };
      const loop = (s) => closedSpline([[6, -3], [24, -27], [48, -26], [56, -4], [44, 18], [10, 7]].map(([x, y]) => T(s * x, y)));
      const tail = (s, p) => {
        const w = (p.swing || 0) * 6;
        return closedMixed([[...T(s * 4, 6), true], [...T(s * 18 + w, 30), false], [...T(s * 26 + w * 1.5, 52), true], [...T(s * 15 + w * 1.5, 45), true], [...T(s * 8 + w * 1.5, 54), true], [...T(s * 4 + w, 28), false], [...T(-s * 4, 8), true]]);
      };
      grad(ctx, id + '-g1', col, at[0] - 50 * sc, at[1] - 30 * sc, at[0] + 50 * sc, at[1] + 40 * sc, 0.28, -0.22);
      b.add({ id: id + '-tails', g, ...morph((p) => compound(tail(-1, p), tail(1, p)), SWING), fill: shade(col, -0.1), stroke: line, sw: 2.4 });
      b.add({ id: id + '-loops', g, d: compound(loop(-1), loop(1)), fill: id + '-g1', stroke: line, sw: 2.6 });
      b.add({ id: id + '-folds', g, d: compound(
        openSpline([T(-12, -6), T(-26, -14), T(-40, -12)]), openSpline([T(-12, 4), T(-30, 6)]),
        openSpline([T(12, -6), T(26, -14), T(40, -12)]), openSpline([T(12, 4), T(30, 6)]),
      ), fill: 'none', stroke: line, sw: 2, op: 0.4 });
      b.add({ id: id + '-knot', g, d: closedSpline([T(-9, -9), T(9, -9), T(11, 9), T(-11, 9)]), fill: shade(col, -0.06), stroke: line, sw: 2.4 });
      b.add({ id: id + '-shine', g, d: compound(openSpline([T(-22, -20), T(-38, -20)]), openSpline([T(-4, -5), T(-4, 2)])), fill: 'none', stroke: shade(col, 0.6), sw: 3, op: 0.6 });
    },
  },

  bandana: {
    name: 'Bandana', slot: 'headwear', note: 'a red bandana knotted at the back',
    behindHead(ctx) {
      const { b, k, f } = ctx;
      const id = 'bandana';
      const g = hatGroup(ctx, id + '-back', -9, -5);
      const col = '#C2403C';
      const line = shade(col, -0.45);
      const kx = CX - (f.W * f.hs.cheek + 6);
      const ky = k.temple + 22;
      const tails = (p) => {
        const s = (p.swing || 0) * 16;
        return compound(
          closedMixed([[kx + 6, ky - 4, true], [kx - 26 + s * 0.4, ky + 40], [kx - 34 + s, ky + 96, true], [kx - 12 + s, ky + 84, true], [kx - 4 + s * 0.4, ky + 34], [kx + 12, ky + 6, true]]),
          closedMixed([[kx + 4, ky + 2, true], [kx + 2 + s * 0.4, ky + 52], [kx + 8 + s, ky + 110, true], [kx + 22 + s, ky + 96, true], [kx + 14 + s * 0.4, ky + 46], [kx + 14, ky + 8, true]]),
        );
      };
      b.add({ id: id + '-tails', g, ...morph(tails, SWING), fill: shade(col, -0.12), stroke: line, sw: 2.6 });
      b.add({ id: id + '-knot', g, d: closedSpline([[kx - 14, ky - 6], [kx - 2, ky - 18], [kx + 14, ky - 8], [kx + 12, ky + 10], [kx - 6, ky + 12]]), fill: shade(col, -0.05), stroke: line, sw: 2.6 });
    },
    headwear(ctx) {
      const { b, k } = ctx;
      const id = 'bandana';
      const g = hatGroup(ctx, id);
      const F = fit(ctx);
      const st = seat(F.E, 0.25, F.maxW(1.26));
      const by = st.y;
      const W = st.w + 5;
      const sideY = by + k.H * 0.13;
      const ct = Math.max(F.limit, Math.min(by - W * 0.6, F.hairTop - 8));
      const col = '#C2403C';
      const line = shade(col, -0.45);
      const yAt = (x) => by + (sideY - by) * Math.min(1, Math.abs((x - CX) / W)) ** 2;
      const base = sideY - 8;
      const hD = base - ct;
      const dome = (p) => {
        const pts = [...domePts(W * 1.01, base, ct, 2.7, 9), [CX + W * 0.55, yAt(CX + W * 0.55) - 4], [CX, by - 4], [CX - W * 0.55, yAt(CX - W * 0.55) - 4]];
        return closedSpline(pts.map(([x, y]) => [hugX(x, p.yaw || 0, W), y]));
      };
      grad(ctx, id + '-g1', col, CX - W, ct, CX + W, by, 0.22, -0.22);
      b.add({ id: id + '-dome', g, ...morph(dome, YAW), fill: id + '-g1', stroke: line, sw: 3 });
      const dots = [];
      const rings = [];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 6; c++) {
          const u = -0.78 + c * 0.31 + (r % 2 ? 0.155 : 0);
          if (u > 0.85) continue;
          const y = lerp(by - 30, ct + hD * 0.2, r / 2.3);
          const x = CX + u * W * (1 - 0.28 * (r / 2));
          if ((r + c) % 2) rings.push(ellipse(x, y, 7, 7));
          else dots.push(ellipse(x, y, 4.5, 4.5));
        }
      }
      b.add({ id: id + '-dots', g, d: compound(...dots), fill: '#FFF6EE', op: 0.85, clip: id + '-dome' });
      b.add({ id: id + '-rings', g, d: compound(...rings), fill: 'none', stroke: '#FFF6EE', sw: 2.4, op: 0.75, clip: id + '-dome' });
      const hem = (p) => {
        const yw = p.yaw || 0;
        const xs = [-1, -0.6, 0, 0.6, 1];
        const low = xs.map((u) => [hugX(CX + u * W * 1.02, yw, W), yAt(CX + u * W) + (Math.abs(u) === 1 ? 0 : 3)]);
        const high = xs.slice().reverse().map((u) => [hugX(CX + u * W * 1.03, yw, W), yAt(CX + u * W) - 16]);
        return closedMixed([[...low[0], true], ...low.slice(1, -1), [...low[4], true], [...high[0], true], ...high.slice(1, -1), [...high[4], true]]);
      };
      b.add({ id: id + '-hem', g, ...morph(hem, YAW), fill: shade(col, -0.12), stroke: line, sw: 2.6 });
      b.add({ id: id + '-folds', g, d: compound(
        openSpline([[CX - W * 0.5, ct + hD * 0.3], [CX - W * 0.2, ct + hD * 0.5], [CX - W * 0.1, by - 24]]),
        openSpline([[CX + W * 0.62, ct + hD * 0.34], [CX + W * 0.4, ct + hD * 0.62]]),
      ), fill: 'none', stroke: line, sw: 2.2, op: 0.35 });
      b.add({ id: id + '-shine', g, d: taper([[CX - W * 0.76, base - hD * 0.28], [CX - W * 0.64, base - hD * 0.62], [CX - W * 0.32, ct + hD * 0.1]], [4, 10, 3]), fill: '#FFFFFF', op: 0.18 });
    },
  },

  headphones: {
    name: 'Headphones', slot: 'headwear', note: 'big over-ear headphones',
    headwear(ctx) {
      const { b, f, k, colors } = ctx;
      const id = 'headphones';
      const F = fit(ctx);
      // cups ride the side of the head (head outline parallax); the band's top follows the hair
      const g = hatGroup(ctx, id, -6, 0, [CX, f.earY]);
      const col = pick(colors.accent, [colors.hair], '#3E8FD8');
      const line = shade(col, -0.45);
      const xs = f.W * f.hs.cheek + 6;
      const cy = f.earY + 6;
      const topY = Math.max(VIEW_TOP + 6, F.hairTop - 6);
      const capY = cy - 62;
      const band = (p) => {
        const yaw = p.yaw || 0;
        const pitch = p.pitch || 0;
        const pts = [];
        const n = 9;
        for (let i = 0; i < n; i++) {
          const a = -Math.PI / 2 + (i / (n - 1)) * Math.PI; // -90..90 deg, left to right
          const x = Math.sin(a);
          const up = Math.cos(a);
          const w = up ** 1.4;
          const yy = lerp(capY, topY, up ** 0.8);
          pts.push([CX + x * (xs - 2) * (1 + 0.06 * up) + yaw * 19 * w, yy + pitch * 6 * w]);
        }
        return taper(pts, pts.map((_, i) => (i === 0 || i === n - 1 ? 14 : 17)));
      };
      const ch = [...YAW, ['head.pitch', { pitch: 1 }], ['head.pitch', { pitch: -1 }, true]];
      grad(ctx, id + '-bandG', col, CX - xs, topY, CX + xs, capY, 0.25, -0.22);
      b.add({ id: id + '-band', g, ...morph(band, ch), fill: id + '-bandG', stroke: line, sw: 2.8 });
      const shineBand = (p) => {
        const yaw = p.yaw || 0;
        const pitch = p.pitch || 0;
        const pts = [-0.78, -0.55, -0.3].map((t) => {
          const a = (t * Math.PI) / 2;
          const up = Math.cos(a);
          const w = up ** 1.4;
          return [CX + Math.sin(a) * (xs - 2) * (1 + 0.06 * up) + yaw * 19 * w, lerp(capY, topY, up ** 0.8) - 3 + pitch * 6 * w];
        });
        return openSpline(pts);
      };
      b.add({ id: id + '-bandShine', g, ...morph(shineBand, ch), fill: 'none', stroke: shade(col, 0.55), sw: 3, op: 0.55 });
      const cushion = '#33343C';
      b.add({ id: id + '-yokes', g, d: compound(...[-1, 1].map((s) => roundedPoly([[CX + s * (xs - 4), capY - 6, 4], [CX + s * (xs + 6), capY - 6, 4], [CX + s * (xs + 6), cy - 36, 4], [CX + s * (xs - 4), cy - 36, 4]]))), fill: '#9EA4AE', stroke: '#5A606B', sw: 2.2 });
      b.add({ id: id + '-pads', g, d: compound(...[-1, 1].map((s) => roundedPoly([[CX + s * (xs - 16), cy - 48, 12], [CX + s * (xs + 4), cy - 48, 12], [CX + s * (xs + 4), cy + 48, 12], [CX + s * (xs - 16), cy + 48, 12]]))), fill: cushion, stroke: '#1E1F25', sw: 2.4 });
      grad(ctx, id + '-cupG', col, CX - xs - 30, cy - 50, CX + xs + 30, cy + 50, 0.22, -0.25);
      b.add({ id: id + '-cups', g, d: compound(...[-1, 1].map((s) => roundedPoly([[CX + s * (xs - 2), cy - 52, 22], [CX + s * (xs + 30), cy - 46, 18], [CX + s * (xs + 30), cy + 46, 18], [CX + s * (xs - 2), cy + 52, 22]]))), fill: id + '-cupG', stroke: line, sw: 3 });
      b.add({ id: id + '-cupShine', g, d: compound(...[-1, 1].map((s) => openSpline([[CX + s * (xs + 6) - 4, cy - 30], [CX + s * (xs + 8) - 4, cy + 10]]))), fill: 'none', stroke: shade(col, 0.55), sw: 3.2, op: 0.55 });
    },
  },

  'wizard-hat': {
    name: 'Wizard hat', slot: 'headwear', note: 'a tall starry wizard hat with a floppy tip',
    headwear(ctx) {
      const { b, k } = ctx;
      const id = 'wizard-hat';
      const g = hatGroup(ctx, id);
      const F = fit(ctx);
      const st = seat(F.E, 0.3, F.maxW(1.22));
      const bw = Math.max(st.w + 4, k.w * 0.95);
      const by = st.y;
      const cb = bw * 0.9;
      const h = F.crop ? Math.min(bw * 1.5, by + 80) : Math.max(70, by - VIEW_TOP - 2);
      const top = by - h;
      const col = '#463FA8';
      const line = shade(col, -0.5);
      // a bun or crest gets a fuller cone so it stays inside
      const sp = F.spire;
      const need = sp ? clamp((sp.w + 10) / cb, 0, 0.9) : 0;
      const midW = Math.max(0.68, need) * cb;
      const midY = sp ? Math.min(by - h * 0.42, sp.top + 18) : by - h * 0.42;
      const shY = by - h * 0.17;
      const cone = (p) => {
        const s = (p.swing || 0) * 12;
        return closedMixed([
          [CX - cb, by + 6, true], [CX - cb * 0.94, shY], [CX - midW, midY], [CX - cb * 0.34, by - h * 0.8], [CX - cb * 0.02 + s * 0.2, top],
          [CX + cb * 0.42 + s * 0.6, top + h * 0.06], [CX + cb * 0.8 + s, top + h * 0.3, true], [CX + cb * 0.46 + s * 0.6, top + h * 0.2], [CX + cb * 0.18 + s * 0.3, by - h * 0.74, true],
          [CX + midW * 0.98, midY + 6], [CX + cb * 0.94, shY], [CX + cb, by + 6, true],
        ]);
      };
      b.grad(id + '-coneG', { kind: 'linear', start: [CX - cb, top], end: [CX + cb, by], stops: [{ at: 0, color: shade(col, 0.28) }, { at: 0.55, color: col }, { at: 1, color: shade(col, -0.28) }] });
      b.add({ id: id + '-cone', g, ...morph(cone, SWING), fill: id + '-coneG', stroke: line, sw: 3 });
      const fold = (p) => {
        const s = (p.swing || 0) * 12;
        return openSpline([[CX + cb * 0.18 + s * 0.3, by - h * 0.74], [CX + cb * 0.3 + s * 0.45, by - h * 0.82], [CX + cb * 0.46 + s * 0.6, top + h * 0.2]]);
      };
      b.add({ id: id + '-fold', g, ...morph(fold, SWING), fill: 'none', stroke: line, sw: 2.4, op: 0.5 });
      const stars = [starPath(CX - cb * 0.42, by - h * 0.3, 13, 0.2), starPath(CX + cb * 0.3, by - h * 0.5, 10, -0.3), starPath(CX - cb * 0.1, by - h * 0.62, 8, 0.5)];
      b.add({ id: id + '-stars', g, d: compound(...stars), fill: '#F7D45E', stroke: '#A97A12', sw: 1.6, clip: id + '-cone' });
      const mx = CX + cb * 0.36;
      const my = by - h * 0.24;
      b.add({ id: id + '-moon', g, d: closedMixed([[mx, my - 13, true], [mx + 12, my - 4], [mx + 10, my + 8], [mx - 2, my + 13, true], [mx + 4, my + 3], [mx + 4, my - 6]]), fill: '#F3E7B0', stroke: '#A98F3A', sw: 1.6, clip: id + '-cone' });
      b.add({ id: id + '-shine', g, d: taper([[CX - cb * 0.62, by - h * 0.18], [CX - cb * 0.42, by - h * 0.5], [CX - cb * 0.14, by - h * 0.8]], [5, 10, 3]), fill: '#FFFFFF', op: 0.16 });
      const bandH = 18;
      b.add({ id: id + '-band', g, d: closedMixed([[CX - cb, by + 4, true], [CX - cb * 0.97, by - bandH, true], [CX, by - bandH + 5], [CX + cb * 0.97, by - bandH, true], [CX + cb, by + 4, true], [CX, by + 8]]), fill: '#E9B949', stroke: '#8A5A12', sw: 2.4 });
      const B = Math.min(bw * 1.45, 330);
      edgeShadow(ctx, id, g, [[CX - B * 0.5, by + 18], [CX, by + 24], [CX + B * 0.5, by + 18]], 26);
      grad(ctx, id + '-brimG', col, CX - B, by - 16, CX + B * 0.6, by + 24, 0.2, -0.3);
      b.add({ id: id + '-brim', g, d: closedSpline([
        [CX - B, by + 8], [CX - B * 0.78, by - 8], [CX, by - 2], [CX + B * 0.78, by - 8], [CX + B, by + 8],
        [CX + B * 0.8, by + 18], [CX, by + 25], [CX - B * 0.8, by + 18],
      ]), fill: id + '-brimG', stroke: line, sw: 3 });
      b.add({ id: id + '-brimShine', g, d: openSpline([[CX - B * 0.94, by + 4], [CX - B * 0.7, by - 5], [CX - B * 0.3, by - 2]]), fill: 'none', stroke: shade(col, 0.5), sw: 2.2, op: 0.55 });
    },
  },

  'party-hat': {
    name: 'Party hat', slot: 'headwear', note: 'a striped party hat with a pom-pom',
    headwear(ctx) {
      const { b, k, colors } = ctx;
      const id = 'party-hat';
      const g = hatGroup(ctx, id);
      const F = fit(ctx);
      let ph = k.w * 0.95 * (F.big ? 0.9 : 1);
      // sits on the crown of the hair with a jaunty lean; on hair taller than the frame
      // it leans further out over the side so the pom stays in view
      let ang = -0.28;
      let base = onOutline(F.E, ang, 0.8);
      if (F.crop) {
        for (const a of [-0.6, -0.75, -0.9, -1.0]) {
          ang = a;
          base = onOutline(F.E, a, 0.94);
          if (base[1] - (ph + 22) * Math.cos(a) >= VIEW_TOP + 4) break;
        }
      }
      const room = (base[1] - VIEW_TOP - 4) / Math.cos(ang) - 22;
      if (room < ph) ph = Math.max(70, room);
      const pb = Math.max(44, ph * 0.45);
      const T = (x, y) => { const p = rotatePt([base[0] + x, base[1] + y], base, ang); return [p[0], p[1]]; };
      const col = '#4FA9E2';
      const line = shade(col, -0.45);
      const stripe = pick(colors.accent, [col], '#FFD447');
      b.grad(id + '-coneG', { kind: 'linear', start: T(-pb, -ph * 0.5), end: T(pb, 0), stops: [{ at: 0, color: shade(col, 0.25) }, { at: 1, color: shade(col, -0.2) }] });
      const cone = closedMixed([[...T(-pb, 0), true], [...T(0, -ph), true], [...T(pb, 0), true], T(0, 10)]);
      b.add({ id: id + '-cone', g, d: cone, fill: id + '-coneG', stroke: line, sw: 3 });
      const bands = [-0.18, -0.46, -0.74].map((f) => {
        const y = ph * f;
        return closedMixed([[...T(-pb * 1.3, y + 10), true], [...T(pb * 1.3, y - 14), true], [...T(pb * 1.3, y - 30), true], [...T(-pb * 1.3, y - 6), true]]);
      });
      b.add({ id: id + '-stripes', g, d: compound(...bands), fill: stripe, op: 0.95, clip: id + '-cone' });
      b.add({ id: id + '-coneLine', g, d: cone, fill: 'none', stroke: line, sw: 3 });
      b.add({ id: id + '-shine', g, d: taper([T(-pb * 0.6, -ph * 0.12), T(-pb * 0.34, -ph * 0.48), T(-pb * 0.1, -ph * 0.8)], [6, 7, 3]), fill: '#FFFFFF', op: 0.25 });
      const trim = [];
      for (let i = 0; i < 7; i++) {
        const u = -1 + (i / 6) * 2;
        trim.push(ellipse(...T(u * pb * 1.02, 3 + 7 * (1 - u * u)), 10, 9));
      }
      b.add({ id: id + '-trim', g, d: compound(...trim), fill: '#FFF8EE', stroke: '#B9A99A', sw: 2 });
      const pc = '#FF6F9C';
      b.add({ id: id + '-pom', g, d: puff(...T(0, -ph - 8), 17, 10, 0.18), fill: pc, stroke: shade(pc, -0.42), sw: 2.4 });
      b.add({ id: id + '-pomShine', g, d: ellipse(...T(-5, -ph - 14), 5, 4), fill: '#FFFFFF', op: 0.5 });
    },
  },

  'hair-flower': {
    name: 'Hair flower', slot: 'headwear', note: 'a big tropical flower tucked behind one ear',
    headwear(ctx) {
      const { b } = ctx;
      const id = 'hair-flower';
      const g = hatGroup(ctx, id);
      const F = fit(ctx);
      const sc = F.big ? 1.4 : 1.22;
      const [x, y] = onOutline(F.E, -1.02, F.big ? 0.84 : 0.92);
      const R = 36 * sc;
      b.add({ id: id + '-leaves', g, d: compound(leaf(x + 6, y + 6, 52 * sc, 15 * sc, 2.3), leaf(x + 4, y - 2, 46 * sc, 13 * sc, -2.2)), fill: '#5FA05A', stroke: '#2F5E2E', sw: 2.2 });
      b.add({ id: id + '-veins', g, d: compound(openSpline([[x + 6, y + 6], rotatePt([x + 6 + 40 * sc, y + 6], [x + 6, y + 6], 2.3).slice(0, 2)]), openSpline([[x + 4, y - 2], rotatePt([x + 4 + 36 * sc, y - 2], [x + 4, y - 2], -2.2).slice(0, 2)])), fill: 'none', stroke: '#2F5E2E', sw: 1.6, op: 0.6 });
      const petal = (i) => {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / 5 + 0.2;
        const P = (u, v) => [x + Math.cos(a) * u - Math.sin(a) * v, y + Math.sin(a) * u + Math.cos(a) * v];
        return closedSpline([P(3, 0), P(R * 0.45, -R * 0.4), P(R * 0.92, -R * 0.36), P(R * 1.06, -R * 0.08), P(R * 1.0, R * 0.2), P(R * 0.86, R * 0.4), P(R * 0.42, R * 0.38)]);
      };
      b.grad(id + '-petalG', { kind: 'radial', center: [x, y], radius: R * 1.05, stops: [{ at: 0, color: '#D9365F' }, { at: 0.35, color: '#F2607F' }, { at: 1, color: '#FFB0BE' }] });
      b.add({ id: id + '-petals', g, d: compound(petal(0), petal(1), petal(2), petal(3), petal(4)), fill: id + '-petalG', stroke: '#A8284A', sw: 2.2 });
      b.add({ id: id + '-veinsP', g, d: compound(...[0, 1, 2, 3, 4].map((i) => { const a = -Math.PI / 2 + (i * Math.PI * 2) / 5 + 0.2; return openSpline([[x + Math.cos(a) * R * 0.25, y + Math.sin(a) * R * 0.25], [x + Math.cos(a) * R * 0.6, y + Math.sin(a) * R * 0.6]]); })), fill: 'none', stroke: '#B52A50', sw: 1.8, op: 0.45 });
      const sa = -0.9;
      const tip = [x + Math.cos(sa) * R * 0.75, y + Math.sin(sa) * R * 0.75];
      b.add({ id: id + '-stamen', g, d: openSpline([[x, y], [lerp(x, tip[0], 0.5) + 3, lerp(y, tip[1], 0.5)], tip]), fill: 'none', stroke: '#F6C343', sw: 3.4 });
      b.add({ id: id + '-pollen', g, d: compound(ellipse(tip[0], tip[1], 4.6, 4.6), ellipse(tip[0] - 6, tip[1] + 3, 3, 3), ellipse(tip[0] + 4, tip[1] + 5, 3, 3)), fill: '#FFD45C', stroke: '#B98A1E', sw: 1.2 });
      b.add({ id: id + '-heart', g, d: ellipse(x, y, R * 0.16, R * 0.16), fill: '#FFD45C', stroke: '#B98A1E', sw: 1.6 });
      b.add({ id: id + '-shine', g, d: compound(openSpline([[x - R * 0.7, y - R * 0.2], [x - R * 0.5, y - R * 0.55]]), openSpline([[x - R * 0.1, y - R * 0.86], [x + R * 0.25, y - R * 0.8]])), fill: 'none', stroke: '#FFFFFF', sw: 3, op: 0.5 });
    },
  },
};
