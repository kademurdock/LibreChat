// Outfits: what the puppet wears on its torso. Each outfit draws in the `top` layer
// (after the neck and chest skin, before the head) and may also use `behind`
// (e.g. a hood behind the head) or `behindHead` (the back of a collar, seen beside the neck).
//
// Every top is built from the same torso silhouette (shoulders and upper arms) so it fits
// all four builds (ctx.S), and from a neckline measured off the neck (ctx.f.W) so it meets
// the neck skin the kit has already drawn. The main garment is one shape `<id>-main`; the
// recipe's outfit.pattern is drawn as pattern shapes clipped to it, then the garment's
// outline is stroked again on top so the pattern never eats the edge.
import { closedMixed, openSpline, closedSpline, ellipse, shade, mix, luminance, round1 } from './geom.mjs';

const R = round1;

// ---------------------------------------------------------------- small path builders
const pM = (p) => ({ op: 'M', v: [R(p[0]), R(p[1])] });
const pL = (p) => ({ op: 'L', v: [R(p[0]), R(p[1])] });
const pZ = () => ({ op: 'Z', v: [] });
function poly(points, closed = true) {
  const d = [pM(points[0]), ...points.slice(1).map(pL)];
  if (closed) d.push(pZ());
  return d;
}
const rect = (x0, y0, x1, y1) => poly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
// A dot drawn as a near-zero-length stroke with round caps (2 commands per dot).
const dotPath = (x, y) => [pM([x, y]), pL([x + 0.1, y])];
const seg = (a, b) => [pM(a), pL(b)];

function geo(ctx) {
  const { f, S, CX } = ctx;
  return { nb: f.neckBase, n: f.W * 0.5, S, CX };
}
const mirrorPts = (pts, CX) => pts.map(([x, y, c]) => [2 * CX - x, y, c]);
const sym = (ctx, rightPts) => mirrorPts(rightPts, ctx.CX);

// Make a ring clockwise (on screen) so compound shapes never punch holes in each other.
function orient(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a < 0 ? ring.slice().reverse() : ring;
}

// ---------------------------------------------------------------- torso silhouette
// Right-hand outer side, from the shoulder next to the neck down to the hem.
function rightSide(ctx, grow = 0) {
  const { nb, n, S, CX } = geo(ctx);
  return [
    [CX + n * 1.35 + grow * 0.4, nb + 5 - grow * 0.7],
    // keep the shoulder slope gentle even on a wide head over a slim build
    [CX + Math.max(S * 0.62, n * 1.35 + 46) + grow * 0.7, nb + 21 - grow * 0.8],
    [CX + S - 20 + grow, nb + 52 - grow * 0.5],
    [CX + S + 6 + grow, nb + 120],
    [CX + S + 16 + grow, 1060, true],
  ];
}

// Torso ring with a neckline running from the right side of the neck to the left.
function torsoRing(ctx, neckline, grow = 0) {
  const right = rightSide(ctx, grow);
  const left = mirrorPts(right, ctx.CX).reverse();
  const nl = neckline;
  return [nl[0], ...right, ...left, nl[nl.length - 1], ...nl.slice(1, -1).reverse()];
}

// Sample the cubic segments of a closedMixed ring between two point indices.
function sampleRing(points, from, to, steps = 10) {
  const n = points.length;
  const t = 1 / 6;
  const out = [];
  for (let i = from; i < to; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i % n];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    const c1 = p1[2] ? [p1[0] + (p2[0] - p1[0]) / 3, p1[1] + (p2[1] - p1[1]) / 3] : [p1[0] + (p2[0] - p0[0]) * t, p1[1] + (p2[1] - p0[1]) * t];
    const c2 = p2[2] ? [p2[0] - (p2[0] - p1[0]) / 3, p2[1] - (p2[1] - p1[1]) / 3] : [p2[0] - (p3[0] - p1[0]) * t, p2[1] - (p3[1] - p1[1]) * t];
    for (let s = i === from ? 0 : 1; s <= steps; s++) {
      const u = s / steps;
      const a = (1 - u) ** 3;
      const b = 3 * (1 - u) ** 2 * u;
      const c = 3 * (1 - u) * u * u;
      const d = u ** 3;
      out.push([a * p1[0] + b * c1[0] + c * c2[0] + d * p2[0], a * p1[1] + b * c1[1] + c * c2[1] + d * p2[1]]);
    }
  }
  return out;
}

// The top edge (neck to upper arm) of a torso ring, as a polyline on the right side.
function topEdge(ring) {
  return sampleRing(ring, 0, 4, 14);
}
// y of the silhouette top at horizontal distance dx from the centre line.
function edgeY(edge, CX, dx) {
  const x = CX + Math.abs(dx);
  for (let i = 0; i < edge.length - 1; i++) {
    const a = edge[i];
    const b = edge[i + 1];
    if ((x >= a[0] && x <= b[0]) || (x <= a[0] && x >= b[0])) {
      const t = (x - a[0]) / ((b[0] - a[0]) || 1);
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return x < edge[0][0] ? edge[0][1] : edge[edge.length - 1][1];
}

// Offset a polyline sideways by d (positive = to the right of the walking direction).
function offsetPts(pts, d) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    return [p[0] - dy * d, p[1] + dx * d, p[2]];
  });
}
// Point along a polyline at fraction t of its length.
function along(pts, t) {
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = lens[lens.length - 1] * t;
  for (let i = 1; i < pts.length; i++) {
    if (lens[i] >= L) {
      const u = (L - lens[i - 1]) / ((lens[i] - lens[i - 1]) || 1);
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u];
    }
  }
  return pts[pts.length - 1];
}

// Kept for other parts that imported it: the plain torso with a neckline.
export function bodyShape(ctx, neckline) {
  return closedMixed(torsoRing(ctx, neckline));
}

export function clothGradient(ctx, id, hex) {
  const { b, CX, f } = ctx;
  b.grad(id, {
    kind: 'linear', start: [CX - 220, f.neckBase], end: [CX + 260, f.neckBase + 320],
    stops: [{ at: 0, color: shade(hex, 0.12) }, { at: 0.5, color: hex }, { at: 1, color: shade(hex, -0.22) }],
  });
  return id;
}

// ---------------------------------------------------------------- necklines
function crew(ctx, depth = 36, up = 8) {
  const { f, CX } = ctx;
  const n = f.W * 0.5;
  const nb = f.neckBase;
  return [[CX + n * 0.95, nb - up], [CX + n * 0.5, nb + depth * 0.72], [CX, nb + depth], [CX - n * 0.5, nb + depth * 0.72], [CX - n * 0.95, nb - up]];
}

function vneck(ctx, depth = 95) {
  const { f, CX } = ctx;
  const n = f.W * 0.5;
  const nb = f.neckBase;
  return [[CX + n * 0.9, nb - 6], [CX + n * 0.42, nb + depth * 0.5], [CX, nb + depth, true], [CX - n * 0.42, nb + depth * 0.5], [CX - n * 0.9, nb - 6]];
}

// ---------------------------------------------------------------- patterns
export const PATTERNS = {
  solid: { name: 'Solid', note: '' },
  stripes: { name: 'Stripes', note: 'with bold horizontal stripes' },
  plaid: { name: 'Plaid', note: 'in a plaid check' },
  'polka-dots': { name: 'Polka dots', note: 'with polka dots' },
  pinstripes: { name: 'Pinstripes', note: 'with fine pinstripes' },
  floral: { name: 'Floral', note: 'with a little flower print' },
};

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
// The colour a pattern is printed in: the accent, or a tint of the cloth when the accent
// would vanish against it.
function patternInk(hex, accent) {
  if (contrast(hex, accent) >= 1.45) return accent;
  return luminance(hex) > 0.3 ? shade(hex, -0.38) : shade(hex, 0.5);
}
function lineInk(hex) {
  return luminance(hex) > 0.3 ? shade(hex, -0.45) : shade(hex, 0.55);
}

// Point-in-polygon / near-edge test so pattern elements far outside the garment are skipped.
function nearPolys(polys, x, y, m) {
  for (const poly of polys) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi) inside = !inside;
      const dx = xj - xi;
      const dy = yj - yi;
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / l2));
      if (Math.hypot(x - (xi + t * dx), y - (yi + t * dy)) < m) return true;
    }
    if (inside) return true;
  }
  return false;
}

// Split sub-paths into shapes of at most `limit` commands each.
function chunked(b, base, subs, style, limit = 78) {
  let cur = [];
  let count = 0;
  let k = 0;
  const flush = () => {
    if (!cur.length) return;
    b.add({ ...style, id: base + (k ? '-' + k : ''), d: cur.flat() });
    k++;
    cur = [];
    count = 0;
  };
  for (const sp of subs) {
    if (count + sp.length > limit) flush();
    cur.push(sp);
    count += sp.length;
  }
  flush();
}

// Draw the recipe's pattern clipped to `clip`. `polys` are sampled outlines of the clip
// shape (to skip far-away elements). `tag` keeps ids unique when an item patterns
// several shapes (body, collar).
function drawPattern(ctx, id, clip, polys, tag = 'pat', hex = ctx.colors.cloth) {
  const kind = (ctx.r.outfit && ctx.r.outfit.pattern) || 'solid';
  if (kind === 'solid' || !PATTERNS[kind]) return;
  const { b, CX } = ctx;
  const { nb } = geo(ctx);
  const ink = patternInk(hex, ctx.colors.accent);
  const base = `${id}-${tag}`;
  const g = 'body';
  // bounding box of the clip outline, limited to what the bust view can ever show
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
  for (const p of polys.flat()) {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }
  const yMax = Math.min(y1, 860);
  const keep = (x, y, m) => nearPolys(polys, x, y, m);
  if (kind === 'stripes') {
    const pitch = 34;
    const h = 12;
    const sag = 7;
    const subs = [];
    const xm = CX;
    for (let y = nb + 22 - pitch * Math.ceil((nb + 22 - y0 + h) / pitch); y < Math.min(y1, 1060); y += pitch) {
      subs.push(closedMixed([[x0 - 4, y, true], [xm, y + sag], [x1 + 4, y, true], [x1 + 4, y + h, true], [xm, y + h + sag], [x0 - 4, y + h, true]]));
    }
    chunked(b, base, subs, { g, fill: ink, op: 0.9, clip });
  } else if (kind === 'pinstripes') {
    const pitch = 22;
    const subs = [];
    for (let x = CX - pitch * Math.ceil((CX - x0) / pitch) + pitch / 2; x <= x1; x += pitch) subs.push(seg([x, y0 - 4], [x, Math.min(y1, 1060)]));
    chunked(b, base, subs, { g, fill: 'none', stroke: ink, sw: 2.2, op: 0.62, clip, cap: 'butt' });
  } else if (kind === 'plaid') {
    const P = 66;
    const band = 24;
    const hs = [];
    const vs = [];
    const lines = [];
    const yStart = nb + 30 - P * Math.ceil((nb + 30 - y0 + band) / P);
    for (let y = yStart; y < yMax + band; y += P) {
      hs.push(rect(x0 - 4, y - band / 2, x1 + 4, y + band / 2));
      lines.push(seg([x0 - 4, y + P / 2], [x1 + 4, y + P / 2]));
    }
    for (let x = CX - P * Math.ceil((CX - x0 + band) / P); x < x1 + band; x += P) {
      vs.push(rect(x - band / 2, y0 - 4, x + band / 2, yMax + 30));
      lines.push(seg([x + P / 2, y0 - 4], [x + P / 2, yMax + 30]));
    }
    chunked(b, base + 'H', hs, { g, fill: ink, op: 0.3, clip });
    chunked(b, base + 'V', vs, { g, fill: ink, op: 0.3, clip });
    chunked(b, base + 'L', lines, { g, fill: 'none', stroke: lineInk(hex), sw: 2.4, op: 0.5, clip, cap: 'butt' });
  } else if (kind === 'polka-dots') {
    const px = 46;
    const py = 40;
    const subs = [];
    let row = 0;
    for (let y = nb + 30 - py * Math.ceil((nb + 30 - y0 + 10) / py); y < yMax + 10; y += py, row++) {
      const off = row % 2 ? px / 2 : 0;
      for (let x = CX + off - px * Math.ceil((CX + off - x0 + 10) / px); x < x1 + 10; x += px) {
        if (keep(x, y, 9)) subs.push(dotPath(x, y));
      }
    }
    chunked(b, base, subs, { g, fill: 'none', stroke: ink, sw: 15, op: 0.95, clip });
  } else if (kind === 'floral') {
    const px = 74;
    const py = 64;
    const petals = [];
    const hearts = [];
    const buds = [];
    let row = 0;
    let idx = 0;
    for (let y = nb + 34 - py * Math.ceil((nb + 34 - y0 + 14) / py); y < yMax + 14; y += py, row++) {
      const off = row % 2 ? px / 2 : 0;
      for (let x = CX + off - px * Math.ceil((CX + off - x0 + 14) / px); x < x1 + 14; x += px) {
        idx++;
        if (keep(x, y, 14)) {
          const small = (idx + row) % 3 === 0;
          const r = small ? 5 : 6.8;
          const a0 = ((idx * 37) % 72) * (Math.PI / 180);
          const sub = [];
          for (let i = 0; i < 5; i++) {
            const a = a0 + (i * 2 * Math.PI) / 5;
            sub.push(...dotPath(x + Math.cos(a) * r, y + Math.sin(a) * r));
          }
          petals.push(sub);
          hearts.push(dotPath(x, y));
        }
        const bx = x + px / 2;
        const by = y + py / 2 - 6;
        if (keep(bx, by, 6)) buds.push(dotPath(bx, by), dotPath(bx + 7, by + 5));
      }
    }
    chunked(b, base, petals, { g, fill: 'none', stroke: ink, sw: 10.5, op: 0.95, clip });
    const heart = contrast(ink, '#F2C744') > 1.4 ? '#F2C744' : shade(ink, -0.45);
    chunked(b, base + 'C', hearts, { g, fill: 'none', stroke: heart, sw: 6, op: 1, clip });
    chunked(b, base + 'B', buds, { g, fill: 'none', stroke: mix(ink, hex, 0.35), sw: 5, op: 0.8, clip });
  }
}

// ---------------------------------------------------------------- shared garment pieces
// Fill + pattern + soft shadow under the chin + outline. `rings` are closedMixed rings
// (one or several, drawn as one compound shape). Returns the main shape id.
function garment(ctx, id, rings, opts = {}) {
  const { b, CX } = ctx;
  const { nb, n } = geo(ctx);
  const hex = opts.hex || ctx.colors.cloth;
  const rs = rings.map(orient);
  const d = rs.flatMap((r) => closedMixed(r));
  const fill = opts.fill || clothGradient(ctx, `${id}-cloth`, hex);
  const main = `${id}-main`;
  b.add({ id: main, g: 'body', d, fill });
  if (opts.pattern !== false) drawPattern(ctx, id, main, rs.map((r) => sampleRing(r, 0, r.length, 4)), 'pat', hex);
  if (opts.shadow !== false) {
    b.grad(`${id}-chinShade`, { kind: 'radial', center: [CX, nb - 18], radius: n * 1.9, stops: [{ at: 0, color: shade(hex, -0.55), opacity: 0.32 }, { at: 0.55, color: shade(hex, -0.55), opacity: 0.12 }, { at: 1, color: shade(hex, -0.55), opacity: 0 }] });
    b.add({ id: `${id}-chinShade`, g: 'body', d: ellipse(CX, nb - 18, n * 1.9, n * 1.5), fill: `${id}-chinShade`, clip: main });
  }
  b.add({ id: `${id}-mainLine`, g: 'body', d, fill: 'none', stroke: shade(hex, -0.4), sw: opts.sw || 3 });
  return main;
}

// Soft seam lines where the sleeves join, to suggest the arms.
function armSeams(ctx, id, hex, grow = 0, op = 0.42) {
  const { b, CX } = ctx;
  const { nb, S } = geo(ctx);
  const one = (s) => openSpline([[CX + s * (S * 0.8 + grow), nb + 32], [CX + s * (S * 0.75 + grow), nb + 96], [CX + s * (S * 0.765 + grow), nb + 190]]);
  b.add({ id: `${id}-armSeams`, g: 'body', d: [...one(1), ...one(-1)], fill: 'none', stroke: shade(hex, -0.38), sw: 2.4, op });
}

// A small sheen on the shoulder nearest the light (top-left).
function shoulderSheen(ctx, id, op = 0.16) {
  const { b, CX } = ctx;
  const { nb, n, S } = geo(ctx);
  b.add({ id: `${id}-sheen`, g: 'body', d: openSpline([[CX - n * 1.5, nb + 22], [CX - S * 0.66, nb + 38], [CX - S * 0.86, nb + 64]]), fill: 'none', stroke: '#FFFFFF', sw: 7, op });
}

// Buttons as one compound shape plus a shine; `pts` are centres.
function buttons(ctx, id, pts, r, hex, opts = {}) {
  const { b } = ctx;
  b.add({ id: `${id}-buttons`, g: 'body', d: pts.flatMap(([x, y]) => ellipse(x, y, r, r)), fill: hex, stroke: shade(hex, -0.42), sw: opts.sw || 1.8 });
  if (opts.holes) {
    b.add({ id: `${id}-buttonHoles`, g: 'body', d: pts.flatMap(([x, y]) => [...dotPath(x - r * 0.3, y), ...dotPath(x + r * 0.3, y)]), fill: 'none', stroke: shade(hex, -0.5), sw: Math.max(1.6, r * 0.28), op: 0.8 });
  }
  if (opts.shine !== false) {
    b.add({ id: `${id}-buttonShine`, g: 'body', d: pts.flatMap(([x, y]) => dotPath(x - r * 0.35, y - r * 0.38)), fill: 'none', stroke: '#FFFFFF', sw: Math.max(1.8, r * 0.5), op: 0.75 });
  }
}

// Bare shoulders and arms (for sleeveless tops): skin silhouette, shoulder outline,
// collarbones. Returns the ring so straps can sit exactly on the shoulder line.
function bareSkin(ctx, id) {
  const { b, CX, colors } = ctx;
  const { nb, n, S } = geo(ctx);
  const nl = [[CX + n * 0.94, nb - 12], [CX + n * 0.5, nb + 12], [CX, nb + 16], [CX - n * 0.5, nb + 12], [CX - n * 0.94, nb - 12]];
  const ring = torsoRing(ctx, nl, -2);
  // matches the kit's neck at its base (plain skin), then darkens toward the arms
  b.grad(`${id}-skin`, { kind: 'radial', center: [CX - 20, nb + 20], radius: Math.max(S * 1.25, n * 3.2), stops: [{ at: 0, color: colors.skin }, { at: 0.42, color: colors.skin }, { at: 1, color: shade(colors.skin, -0.18) }] });
  b.add({ id: `${id}-skin`, g: 'body', d: closedMixed(ring), fill: `${id}-skin` });
  // outline only along the shoulders and arms (the kit's neck has no outline)
  const edge = topEdge(ring);
  const coarse = sampleRing(ring, 0, 5, 5);
  const right = coarse.filter((p) => p[0] > CX + n * 1.12);
  b.add({ id: `${id}-skinLine`, g: 'body', d: [...poly(right, false), ...poly(mirrorPts(right, CX), false)], fill: 'none', stroke: colors.skinLine, sw: 3 });
  const bone = (s) => openSpline([[CX + s * n * 0.28, nb + 34], [CX + s * n * 0.85, nb + 24], [CX + s * n * 1.5, nb + 24]]);
  b.add({ id: `${id}-collarbones`, g: 'body', d: [...bone(1), ...bone(-1)], fill: 'none', stroke: colors.skinDark, sw: 3, op: 0.32 });
  // a soft shadow where each arm meets the body
  const arm = (s) => openSpline([[CX + s * Math.max(S * 0.74, n * 1.9), nb + 130], [CX + s * Math.max(S * 0.79, n * 2.0), nb + 190], [CX + s * Math.max(S * 0.81, n * 2.05), nb + 280]]);
  b.add({ id: `${id}-armShade`, g: 'body', d: [...arm(1), ...arm(-1)], fill: 'none', stroke: colors.skinDark, sw: 5, op: 0.4 });
  return { ring, edge };
}

// Folded shirt collar leaves (both sides) as one compound shape, plus pattern and outline.
function shirtCollar(ctx, id, opts = {}) {
  const { b, CX } = ctx;
  const { nb, n } = geo(ctx);
  const hex = opts.hex || ctx.colors.cloth;
  const tip = opts.tip || [0.7, 62];
  const inner = opts.inner || [0.06, 34];
  const right = [
    [CX + n * 0.97, nb - 40],
    [CX + n * 1.36, nb + 2],
    [CX + n * tip[0], nb + tip[1], true],
    [CX + n * inner[0], nb + inner[1], true],
    [CX + n * (opts.fold || 0.58), nb - 6],
  ];
  const rings = [right, sym(ctx, right)].map(orient);
  const d = rings.flatMap((r) => closedMixed(r));
  const fill = opts.fill || clothGradient(ctx, `${id}-collarCloth`, hex);
  b.add({ id: `${id}-collar`, g: 'body', d, fill });
  if (opts.pattern !== false) drawPattern(ctx, id, `${id}-collar`, rings.map((r) => sampleRing(r, 0, r.length, 4)), 'cpat', hex);
  b.add({ id: `${id}-collarLine`, g: 'body', d, fill: 'none', stroke: opts.line || shade(hex, -0.42), sw: opts.sw || 2.6 });
  return right;
}

// Back of a collar, seen beside the neck (behindHead layer).
function collarBack(ctx, id, hex, h = 50, w = 1.07) {
  const { b, CX } = ctx;
  const { nb, n } = geo(ctx);
  b.add({ id: `${id}-collarBack`, g: 'body', d: closedSpline([[CX + n * (w + 0.02), nb + 4], [CX + n * w, nb - h * 0.75], [CX, nb - h], [CX - n * w, nb - h * 0.75], [CX - n * (w + 0.02), nb + 4], [CX, nb + 14]]), fill: shade(hex, -0.28), stroke: shade(hex, -0.5), sw: 2.4 });
}

// ---------------------------------------------------------------- the tops
function tee(id, name, note, neckFn, collarW) {
  return {
    name, note,
    top(ctx) {
      const { b, colors } = ctx;
      const hex = colors.cloth;
      const nl = neckFn(ctx);
      garment(ctx, id, [torsoRing(ctx, nl)]);
      armSeams(ctx, id, hex);
      shoulderSheen(ctx, id, 0.1);
      b.add({ id: `${id}-collar`, g: 'body', d: openSpline(nl), fill: 'none', stroke: shade(hex, -0.18), sw: collarW, cap: 'butt' });
      b.add({ id: `${id}-collarLine`, g: 'body', d: openSpline(nl), fill: 'none', stroke: shade(hex, -0.45), sw: 2.5 });
    },
  };
}

export const OUTFITS = {
  'crew-tee': tee('crew-tee', 'Crew-neck T-shirt', 'a crew-neck T-shirt', (ctx) => crew(ctx), 9),
  'v-neck': tee('v-neck', 'V-neck T-shirt', 'a V-neck T-shirt', (ctx) => vneck(ctx), 8),

  hoodie: {
    name: 'Hoodie', note: 'a cosy hoodie with the hood down and drawstrings',
    behind(ctx) {
      const { b, CX, colors } = ctx;
      const { nb, n } = geo(ctx);
      const hex = colors.cloth;
      b.grad('hoodie-hoodGrad', { kind: 'linear', start: [CX - 120, nb - 120], end: [CX + 140, nb + 20], stops: [{ at: 0, color: shade(hex, 0.08) }, { at: 1, color: shade(hex, -0.26) }] });
      const hoodPts = [[CX + n * 2.25, nb + 40], [CX + n * 2.15, nb - 26], [CX + n * 1.6, nb - 92], [CX, nb - 116], [CX - n * 1.6, nb - 92], [CX - n * 2.15, nb - 26], [CX - n * 2.25, nb + 40], [CX, nb + 60]];
      const hood = closedSpline(hoodPts);
      b.add({ id: 'hoodie-hood', g: 'body', d: hood, fill: 'hoodie-hoodGrad' });
      // pattern only where the hood can show (above the shoulders, beside the neck)
      drawPattern(ctx, 'hoodie', 'hoodie-hood', [hoodPts.filter(([, y]) => y < nb + 10).concat([[CX - n * 2.2, nb + 10], [CX + n * 2.2, nb + 10]])], 'hpat');
      b.add({ id: 'hoodie-hoodLine', g: 'body', d: hood, fill: 'none', stroke: shade(hex, -0.42), sw: 3 });
      // the hood's lining, in shadow right behind the neck
      b.add({ id: 'hoodie-hoodIn', g: 'body', d: closedSpline([[CX + n * 1.42, nb], [CX + n * 1.38, nb - 56], [CX + n * 0.8, nb - 92], [CX, nb - 98], [CX - n * 0.8, nb - 92], [CX - n * 1.38, nb - 56], [CX - n * 1.42, nb], [CX, nb + 10]]), fill: shade(hex, -0.48) });
      b.add({ id: 'hoodie-hoodSeam', g: 'body', d: openSpline([[CX + n * 1.85, nb - 60], [CX + n * 1.0, nb - 104], [CX, nb - 110]]), fill: 'none', stroke: shade(hex, -0.38), sw: 2.2, op: 0.6 });
    },
    top(ctx) {
      const { b, CX, colors } = ctx;
      const { nb, n } = geo(ctx);
      const hex = colors.cloth;
      garment(ctx, 'hoodie', [torsoRing(ctx, crew(ctx, 30, 8), 3)]);
      armSeams(ctx, 'hoodie', hex, 3);
      shoulderSheen(ctx, 'hoodie', 0.12);
      // the hood's front edges wrap round the neck and cross at the chest
      // s = 1 is the under band (ends at the centre), s = -1 crosses over it
      const band = (s) => orient([
        [CX + s * n * 1.04, nb - 44],
        [CX + s * n * 1.72, nb - 40],
        [CX + s * n * 1.55, nb + 14],
        [CX + s * n * 0.8, nb + 56],
        [CX - s * n * (s > 0 ? -0.02 : 0.3), nb + (s > 0 ? 60 : 64), true],
        [CX - s * n * (s > 0 ? -0.04 : 0.2), nb + (s > 0 ? 36 : 36), true],
        [CX + s * n * 0.5, nb + 22],
        [CX + s * n * 0.98, nb - 8],
      ]);
      b.grad('hoodie-rimGrad', { kind: 'linear', start: [CX - 140, nb - 40], end: [CX + 140, nb + 60], stops: [{ at: 0, color: shade(hex, 0.1) }, { at: 1, color: shade(hex, -0.14) }] });
      for (const s of [1, -1]) {
        const id = s > 0 ? 'hoodie-rimR' : 'hoodie-rimL';
        b.add({ id, g: 'body', d: closedMixed(band(s)), fill: 'hoodie-rimGrad', stroke: shade(hex, -0.42), sw: 2.8 });
        b.add({ id: id + 'Fold', g: 'body', d: openSpline([[CX + s * n * 1.36, nb - 38], [CX + s * n * 1.2, nb + 12], [CX + s * n * 0.55, nb + 44], [CX - s * n * (s > 0 ? -0.06 : 0.22), nb + 52]]), fill: 'none', stroke: shade(hex, -0.3), sw: 2, op: 0.45 });
      }
      // eyelets and drawstrings
      const eye = (s) => [CX + s * n * 0.42, nb + 44];
      b.add({ id: 'hoodie-eyelets', g: 'body', d: [...ellipse(...eye(1), 5.5, 5.5), ...ellipse(...eye(-1), 5.5, 5.5)], fill: shade(hex, -0.55), stroke: '#D9DCE0', sw: 2.4 });
      const cord = (s) => [eye(s), [CX + s * n * 0.46, nb + 80], [CX + s * n * 0.41, nb + 112], [CX + s * n * 0.45, nb + 138]];
      const ac = colors.accent;
      b.add({ id: 'hoodie-strings', g: 'body', d: [...openSpline(cord(1)), ...openSpline(cord(-1))], fill: 'none', stroke: shade(ac, -0.35), sw: 7 });
      b.add({ id: 'hoodie-stringsIn', g: 'body', d: [...openSpline(cord(1)), ...openSpline(cord(-1))], fill: 'none', stroke: ac, sw: 4.2 });
      const tipA = (s) => seg([CX + s * n * 0.445, nb + 126], [CX + s * n * 0.45, nb + 142]);
      b.add({ id: 'hoodie-aglets', g: 'body', d: [...tipA(1), ...tipA(-1)], fill: 'none', stroke: '#C9CDD3', sw: 7.5 });
    },
  },

  'button-up': {
    name: 'Button-up shirt', note: 'a collared button-up shirt',
    behindHead(ctx) {
      collarBack(ctx, 'button-up', ctx.colors.cloth);
    },
    top(ctx) {
      const { b, CX, colors } = ctx;
      const { nb, n, S } = geo(ctx);
      const hex = colors.cloth;
      const nl = [[CX + n * 0.95, nb - 26], [CX + n * 0.45, nb + 10], [CX, nb + 36, true], [CX - n * 0.45, nb + 10], [CX - n * 0.95, nb - 26]];
      garment(ctx, 'button-up', [torsoRing(ctx, nl)]);
      armSeams(ctx, 'button-up', hex);
      shoulderSheen(ctx, 'button-up', 0.1);
      // placket and buttons
      b.add({ id: 'button-up-placket', g: 'body', d: [...seg([CX - 13, nb + 36], [CX - 13, 1060]), ...seg([CX + 13, nb + 30], [CX + 13, 1060])], fill: 'none', stroke: shade(hex, -0.35), sw: 2, op: 0.7 });
      // breast pocket on the wearer's left
      const px = CX + S * 0.42 + 8;
      const py = nb + 82;
      b.add({ id: 'button-up-pocket', g: 'body', d: closedMixed([[px - 28, py, true], [px + 28, py, true], [px + 28, py + 58], [px, py + 66], [px - 28, py + 58]]), fill: 'none', stroke: shade(hex, -0.38), sw: 2.2, op: 0.85 });
      b.add({ id: 'button-up-pocketHem', g: 'body', d: seg([px - 27, py + 9], [px + 27, py + 9]), fill: 'none', stroke: shade(hex, -0.3), sw: 1.6, op: 0.6 });
      shirtCollar(ctx, 'button-up');
      buttons(ctx, 'button-up', [[CX, nb + 58], [CX, nb + 104], [CX, nb + 150], [CX, nb + 196]], 5.2, mix(hex, '#F7F3EC', 0.7), { holes: true, shine: false });
    },
  },

  'western-shirt': {
    name: 'Western shirt', note: 'a western shirt with pointed yokes, piping and pearl snaps',
    behindHead(ctx) {
      collarBack(ctx, 'western-shirt', ctx.colors.cloth);
    },
    top(ctx) {
      const { b, CX, colors } = ctx;
      const { nb, n, S } = geo(ctx);
      const hex = colors.cloth;
      const pipe = patternInk(hex, colors.accent);
      const nl = [[CX + n * 0.95, nb - 26], [CX + n * 0.45, nb + 10], [CX, nb + 36, true], [CX - n * 0.45, nb + 10], [CX - n * 0.95, nb - 26]];
      const ring = torsoRing(ctx, nl);
      const main = garment(ctx, 'western-shirt', [ring]);
      armSeams(ctx, 'western-shirt', hex, 0, 0.3);
      // front yokes: a pointed seam on each side of the chest
      const yx = Math.max(S * 0.46, n * 1.3);
      const yk = (s) => [[CX + s * 13, nb + 40], [CX + s * (yx - 34), nb + 46], [CX + s * yx, nb + 74, true], [CX + s * (yx + 36), nb + 46], [CX + s * (S * 0.8), nb + 42], [CX + s * (S + 14), nb + 56]];
      const yoke = (s) => orient([...yk(s), [CX + s * (S + 14), nb - 40, true], [CX + s * 13, nb - 40, true]]);
      b.add({ id: 'western-shirt-yoke', g: 'body', d: [...closedMixed(yoke(1)), ...closedMixed(yoke(-1))], fill: shade(hex, -0.5), op: 0.12, clip: main });
      const seamPts = (s) => yk(s).map(([x, y, c]) => [x, y, c]);
      b.add({ id: 'western-shirt-yokeShadow', g: 'body', d: [...openSpline(offsetPts(seamPts(1), -3)), ...openSpline(offsetPts(seamPts(-1), 3))], fill: 'none', stroke: shade(hex, -0.45), sw: 1.6, op: 0.7, clip: main });
      b.add({ id: 'western-shirt-piping', g: 'body', d: [...poly(curvy(seamPts(1)), false), ...poly(curvy(seamPts(-1)), false)], fill: 'none', stroke: pipe, sw: 4, clip: main });
      // placket
      b.add({ id: 'western-shirt-placket', g: 'body', d: [...seg([CX - 13, nb + 36], [CX - 13, 1060]), ...seg([CX + 13, nb + 30], [CX + 13, 1060])], fill: 'none', stroke: shade(hex, -0.35), sw: 2, op: 0.7 });
      // pocket flaps (sawtooth) just under each yoke point
      const flap = (s) => {
        const fx = CX + s * yx;
        const fy = nb + 88;
        return orient([[fx - 30, fy, true], [fx + 30, fy, true], [fx + 30, fy + 14, true], [fx, fy + 28, true], [fx - 30, fy + 14, true]]);
      };
      const flaps = [...closedMixed(flap(1)), ...closedMixed(flap(-1))];
      b.add({ id: 'western-shirt-flapShade', g: 'body', d: flaps.map((c) => (c.v.length ? { op: c.op, v: c.v.map((v, k) => (k % 2 ? v + 4 : v)) } : c)), fill: shade(hex, -0.55), op: 0.18 });
      b.add({ id: 'western-shirt-flapTint', g: 'body', d: flaps, fill: shade(hex, 0.3), op: 0.1 });
      b.add({ id: 'western-shirt-flaps', g: 'body', d: flaps, fill: 'none', stroke: pipe, sw: 3 });
      const collarR = shirtCollar(ctx, 'western-shirt', { tip: [0.78, 74], line: pipe, sw: 3.2 });
      void collarR;
      // pearl snaps on the placket and the flaps
      const snaps = [[CX, nb + 60], [CX, nb + 108], [CX, nb + 156], [CX, nb + 204], [CX + yx, nb + 101], [CX - yx, nb + 101]];
      b.add({ id: 'western-shirt-snaps', g: 'body', d: snaps.flatMap(([x, y]) => ellipse(x, y, 6.6, 6.6)), fill: '#F4EFE8', stroke: '#A9A29A', sw: 1.8 });
      b.add({ id: 'western-shirt-snapGlow', g: 'body', d: snaps.flatMap(([x, y]) => ellipse(x + 1.2, y + 1.6, 4.2, 4.2)), fill: '#D9D0E2', op: 0.55 });
      b.add({ id: 'western-shirt-snapShine', g: 'body', d: snaps.flatMap(([x, y]) => dotPath(x - 2.2, y - 2.4)), fill: 'none', stroke: '#FFFFFF', sw: 3.2 });
    },
  },

  sweater: {
    name: 'Knit sweater', note: 'a chunky knit sweater with a ribbed collar',
    top(ctx) {
      const { b, CX, colors } = ctx;
      const { nb, n, S } = geo(ctx);
      const hex = colors.cloth;
      const inner = [[CX + n * 0.97, nb - 14, true], [CX + n * 0.5, nb + 16], [CX, nb + 22], [CX - n * 0.5, nb + 16], [CX - n * 0.97, nb - 14, true]];
      const main = garment(ctx, 'sweater', [torsoRing(ctx, inner, 4)]);
      void main;
      // rope cables (a column with slanted twists) between plain purl lines
      const y0 = nb + 60;
      const y1 = 880;
      const cols = [CX - n * 0.62, CX + n * 0.62, CX - S * 0.64, CX + S * 0.64];
      const grooves = [];
      const lights = [];
      const rails = [];
      for (const cx of cols) {
        rails.push(seg([cx - 11, y0 - 4], [cx - 11, y1]), seg([cx + 11, y0 - 4], [cx + 11, y1]));
        for (let y = y0; y < y1; y += 13) {
          grooves.push(seg([cx - 9, y], [cx + 9, y + 9]));
          lights.push(seg([cx - 7, y + 5], [cx + 6, y + 12]));
        }
      }
      for (const cx of [CX, CX - (n * 0.62 + S * 0.64) / 2, CX + (n * 0.62 + S * 0.64) / 2]) rails.push(seg([cx, y0 + 4], [cx, y1]));
      b.add({ id: 'sweater-rails', g: 'body', d: rails.flat(), fill: 'none', stroke: shade(hex, -0.32), sw: 2.2, op: 0.4, clip: main });
      chunked(b, 'sweater-cables', grooves, { g: 'body', fill: 'none', stroke: shade(hex, -0.34), sw: 2.6, op: 0.5, clip: main });
      chunked(b, 'sweater-cableLight', lights, { g: 'body', fill: 'none', stroke: shade(hex, 0.4), sw: 2.4, op: 0.22, clip: main });
      armSeams(ctx, 'sweater', hex, 4, 0.35);
      // thick ribbed crew collar
      const outer = [[CX + n * 1.4, nb + 6, true], [CX + n * 0.68, nb + 48], [CX, nb + 56], [CX - n * 0.68, nb + 48], [CX - n * 1.4, nb + 6, true]];
      const ring = [...outer, ...inner.slice().reverse()];
      b.grad('sweater-collarGrad', { kind: 'linear', start: [CX, nb - 14], end: [CX, nb + 56], stops: [{ at: 0, color: shade(hex, 0.06) }, { at: 1, color: shade(hex, -0.12) }] });
      b.add({ id: 'sweater-collar', g: 'body', d: closedMixed(ring), fill: 'sweater-collarGrad' });
      const oo = sampleRing(ring, 0, 4, 8);
      const io = sampleRing(ring, 5, 9, 8).reverse();
      const ribs = [];
      for (let i = 1; i < 18; i++) {
        const t = i / 18;
        ribs.push(seg(along(io, t), along(oo, t)));
      }
      b.add({ id: 'sweater-ribs', g: 'body', d: ribs.flat(), fill: 'none', stroke: shade(hex, -0.34), sw: 2.2, op: 0.5, clip: 'sweater-collar' });
      b.add({ id: 'sweater-collarLine', g: 'body', d: closedMixed(ring), fill: 'none', stroke: shade(hex, -0.42), sw: 2.8 });
      shoulderSheen(ctx, 'sweater', 0.1);
    },
  },

  turtleneck: {
    name: 'Turtleneck', note: 'a snug turtleneck with a rolled collar',
    top(ctx) {
      const { b, CX, colors, f } = ctx;
      const { nb, n } = geo(ctx);
      const hex = colors.cloth;
      const nl = [[CX + n * 1.0, nb - 20], [CX + n * 0.5, nb + 14], [CX, nb + 20], [CX - n * 0.5, nb + 14], [CX - n * 1.0, nb - 20]];
      garment(ctx, 'turtleneck', [torsoRing(ctx, nl, 2)], { shadow: false });
      armSeams(ctx, 'turtleneck', hex, 2, 0.35);
      shoulderSheen(ctx, 'turtleneck', 0.1);
      // the collar tube: covers the neck from under the jaw to the shoulders
      const top = Math.max(f.chin - 34, nb - 108);
      const ringR = [[CX + n * 1.03, top + 4], [CX + n * 1.1, nb - 52], [CX + n * 1.22, nb - 22], [CX + n * 1.42, nb + 6, true], [CX + n * 0.6, nb + 26], [CX, nb + 30]];
      const ring = orient([...ringR, ...sym(ctx, ringR.slice(0, -1)).reverse(), [CX, top - 6]]);
      b.grad('turtleneck-collarGrad', { kind: 'linear', start: [CX - n * 1.2, top], end: [CX + n * 1.3, nb + 30], stops: [{ at: 0, color: shade(hex, 0.1) }, { at: 0.5, color: hex }, { at: 1, color: shade(hex, -0.24) }] });
      b.add({ id: 'turtleneck-collar', g: 'body', d: closedMixed(ring), fill: 'turtleneck-collarGrad' });
      // shadow of the jaw on the collar top, and the folded edge of the roll
      b.add({ id: 'turtleneck-jawShade', g: 'body', d: ellipse(CX, top + 6, n * 1.0, 22), fill: shade(hex, -0.5), op: 0.3, clip: 'turtleneck-collar' });
      const foldY = top + (nb - top) * 0.52;
      b.add({ id: 'turtleneck-foldShade', g: 'body', d: closedMixed(orient([[CX + n * 1.3, foldY - 2, true], [CX, foldY + 12], [CX - n * 1.3, foldY - 2, true], [CX - n * 1.3, foldY + 14, true], [CX, foldY + 26], [CX + n * 1.3, foldY + 14, true]])), fill: shade(hex, -0.5), op: 0.22, clip: 'turtleneck-collar' });
      b.add({ id: 'turtleneck-fold', g: 'body', d: openSpline([[CX + n * 1.17, foldY - 4], [CX + n * 0.6, foldY + 7], [CX, foldY + 10], [CX - n * 0.6, foldY + 7], [CX - n * 1.17, foldY - 4]]), fill: 'none', stroke: shade(hex, -0.42), sw: 2.6 });
      const ribs = [];
      for (let i = -6; i <= 6; i++) {
        const x = CX + i * n * 0.165;
        const bow = (i / 6) ** 2;
        ribs.push(seg([x, top + 12 + bow * 6], [x * 1 + (x - CX) * 0.04, foldY - 2 + 10 * (1 - bow)]));
        ribs.push(seg([x + (x - CX) * 0.06, foldY + 16 + 10 * (1 - bow)], [x + (x - CX) * 0.14, nb + 14 + 10 * (1 - bow)]));
      }
      chunked(b, 'turtleneck-ribs', ribs, { g: 'body', fill: 'none', stroke: shade(hex, -0.3), sw: 2, op: 0.4, clip: 'turtleneck-collar' });
      b.add({ id: 'turtleneck-collarLine', g: 'body', d: closedMixed(ring), fill: 'none', stroke: shade(hex, -0.42), sw: 2.8 });
    },
  },

  'tank-top': {
    name: 'Tank top', note: 'a sleeveless tank top',
    top(ctx) {
      const { b, CX, colors } = ctx;
      const { nb, n, S } = geo(ctx);
      const hex = colors.cloth;
      const { edge } = bareSkin(ctx, 'tank-top');
      const si = n * 1.0;
      const so = n * 1.6;
      const right = [
        [CX + si, edgeY(edge, CX, si) - 1, true],
        [CX + so, edgeY(edge, CX, so) - 1, true],
        [CX + so + 5, nb + 54],
        [CX + Math.max(so + 14, S * 0.66), nb + 112],
        [CX + Math.max(so + 22, S * 0.72), nb + 150],
        [CX + Math.max(so + 26, S * 0.76), 1060, true],
      ];
      const neck = [[CX - n * 0.84, nb + 46], [CX, nb + 70], [CX + n * 0.84, nb + 46]];
      const ring = [...right, ...sym(ctx, right).reverse(), ...neck];
      garment(ctx, 'tank-top', [ring], { shadow: false });
      // ribbed binding round the neck and armholes
      const nbind = [right[0], ...neck.slice().reverse(), sym(ctx, [right[0]])[0]];
      const arm = (s) => (s > 0 ? right.slice(1, 5) : sym(ctx, right.slice(1, 5)));
      const bind = [...openSpline(nbind.map(([x, y]) => [x, y])), ...openSpline(arm(1).map(([x, y]) => [x, y])), ...openSpline(arm(-1).map(([x, y]) => [x, y]))];
      b.add({ id: 'tank-top-binding', g: 'body', d: bind, fill: 'none', stroke: shade(hex, -0.16), sw: 8 });
      b.add({ id: 'tank-top-bindLine', g: 'body', d: bind, fill: 'none', stroke: shade(hex, -0.45), sw: 2.4 });
    },
  },

  sundress: {
    name: 'Sundress', note: 'a light sundress with thin straps',
    top(ctx) {
      const { b, CX, colors } = ctx;
      const { nb, n, S } = geo(ctx);
      const hex = colors.cloth;
      const ac = colors.accent;
      const { edge } = bareSkin(ctx, 'sundress');
      // straps first, so the bodice covers their lower ends
      const strap = (s) => {
        const bx = CX + s * S * 0.4;
        const tx = CX + s * n * 1.5;
        const ty = edgeY(edge, CX, n * 1.5);
        return orient([[tx - 5, ty - 1, true], [tx + 5, ty + 1, true], [bx + 5, nb + 76, true], [bx - 5, nb + 76, true]]);
      };
      b.add({ id: 'sundress-straps', g: 'body', d: [...closedMixed(strap(1)), ...closedMixed(strap(-1))], fill: shade(hex, -0.06), stroke: shade(hex, -0.42), sw: 2 });
      const top = [[CX - S * 0.48, nb + 60], [CX - n * 0.5, nb + 64], [CX, nb + 80, true], [CX + n * 0.5, nb + 64], [CX + S * 0.48, nb + 60]];
      const ring = [[CX + S * 0.74, nb + 90, true], [CX + S * 0.8, 1060, true], [CX - S * 0.8, 1060, true], [CX - S * 0.74, nb + 90, true], ...top];
      const main = garment(ctx, 'sundress', [ring], { shadow: false });
      // soft gathers under the neckline
      const gathers = [];
      for (let i = -5; i <= 5; i++) {
        if (i === 0) continue;
        const x = CX + i * S * 0.12;
        const y = edgeYTop(top, x) + 6;
        gathers.push(openSpline([[x, y], [x + (i > 0 ? 2 : -2), y + 18], [x, y + 34]]));
      }
      b.add({ id: 'sundress-gathers', g: 'body', d: gathers.flat(), fill: 'none', stroke: shade(hex, -0.35), sw: 2, op: 0.4, clip: main });
      b.add({ id: 'sundress-trim', g: 'body', d: openSpline(top.map(([x, y]) => [x, y + 3])), fill: 'none', stroke: ac, sw: 3.4, op: 0.95, clip: main });
      // little bows where the straps meet the bodice
      const bows = [];
      for (const s of [1, -1]) {
        const x = CX + s * S * 0.4;
        const y = nb + 67;
        bows.push(closedSpline([[x, y], [x - 15, y - 11], [x - 18, y + 7]]), closedSpline([[x, y], [x + 15, y - 11], [x + 18, y + 7]]), closedSpline([[x - 3, y + 3], [x - 10, y + 21], [x - 3, y + 18]]), closedSpline([[x + 3, y + 3], [x + 10, y + 21], [x + 3, y + 18]]));
      }
      b.add({ id: 'sundress-bows', g: 'body', d: bows.flat(), fill: ac, stroke: shade(ac, -0.4), sw: 1.6 });
      b.add({ id: 'sundress-knots', g: 'body', d: [...ellipse(CX + S * 0.4, nb + 68, 4.8, 4.8), ...ellipse(CX - S * 0.4, nb + 68, 4.8, 4.8)], fill: shade(ac, -0.12), stroke: shade(ac, -0.45), sw: 1.4 });
    },
  },

  blazer: {
    name: 'Blazer and tie', note: 'a smart blazer over a white shirt and tie',
    behindHead(ctx) {
      collarBack(ctx, 'blazer', '#F4F2EE', 54, 1.05);
    },
    top(ctx) {
      const { b, CX, colors } = ctx;
      const { nb, n, S } = geo(ctx);
      const hex = colors.cloth;
      const white = '#F4F2EE';
      const ac = colors.accent;
      // the white shirt
      clothGradient(ctx, 'blazer-shirtCloth', white);
      b.add({ id: 'blazer-shirt', g: 'body', d: closedMixed(torsoRing(ctx, [[CX + n * 0.95, nb - 28], [CX + n * 0.45, nb], [CX, nb + 12], [CX - n * 0.45, nb], [CX - n * 0.95, nb - 28]])), fill: 'blazer-shirtCloth', stroke: shade(white, -0.4), sw: 2.6 });
      // tie blade, shirt collar, knot
      b.grad('blazer-tie', { kind: 'linear', start: [CX - 20, nb], end: [CX + 24, nb + 170], stops: [{ at: 0, color: shade(ac, 0.12) }, { at: 1, color: shade(ac, -0.2) }] });
      const blade = [[CX - n * 0.13, nb + 30, true], [CX + n * 0.13, nb + 30, true], [CX + n * 0.3, nb + 150], [CX, nb + 182, true], [CX - n * 0.3, nb + 150]];
      b.add({ id: 'blazer-tieBlade', g: 'body', d: closedMixed(blade), fill: 'blazer-tie', stroke: shade(ac, -0.45), sw: 2.2 });
      const stripes = [];
      for (let i = 0; i < 6; i++) stripes.push(seg([CX - 30, nb + 50 + i * 24], [CX + 30, nb + 26 + i * 24]));
      b.add({ id: 'blazer-tieStripes', g: 'body', d: stripes.flat(), fill: 'none', stroke: shade(ac, -0.25), sw: 4, op: 0.55, clip: 'blazer-tieBlade' });
      shirtCollar(ctx, 'blazer', { hex: white, fill: 'blazer-shirtCloth', tip: [0.5, 50], inner: [0.03, 16], fold: 0.5, pattern: false });
      b.add({ id: 'blazer-tieKnot', g: 'body', d: closedMixed([[CX - n * 0.21, nb + 4], [CX + n * 0.21, nb + 4], [CX + n * 0.14, nb + 36, true], [CX - n * 0.14, nb + 36, true]]), fill: 'blazer-tie', stroke: shade(ac, -0.45), sw: 2.2 });
      // the jacket: a deep V opening with lapels
      const V = [[CX + n * 1.12, nb - 22], [CX + n * 0.9, nb + 40], [CX + n * 0.42, nb + 116], [CX + 4, nb + 170, true], [CX - n * 0.42, nb + 116], [CX - n * 0.9, nb + 40], [CX - n * 1.12, nb - 22]];
      const jring = torsoRing(ctx, V, 7);
      const jedge = topEdge(jring);
      const main = garment(ctx, 'blazer', [jring]);
      // lapels: drawn as edges and a soft tint so a patterned jacket still reads
      const lapel = (s) => [
        [CX + s * n * 1.12, nb - 18],
        [CX + s * n * 1.48, Math.max(nb + 10, edgeY(jedge, CX, n * 1.48) + 7)],
        [CX + s * n * 1.36, nb + 36, true],
        [CX + s * n * 1.78, nb + 44, true],
        [CX + s * n * 1.3, nb + 116],
        [CX + s * 6, nb + 168, true],
      ];
      const lapelRing = (s) => orient([...lapel(s), ...[[CX + s * n * 0.42, nb + 116], [CX + s * n * 0.9, nb + 40]]]);
      b.add({ id: 'blazer-lapelTint', g: 'body', d: [...closedMixed(lapelRing(1)), ...closedMixed(lapelRing(-1))], fill: shade(hex, 0.3), op: 0.16 });
      b.add({ id: 'blazer-lapelShadow', g: 'body', d: [...openSpline(offsetPts(lapel(1).slice(3), -4)), ...openSpline(offsetPts(lapel(-1).slice(3), 4))], fill: 'none', stroke: shade(hex, -0.6), sw: 6, op: 0.22, clip: main });
      b.add({ id: 'blazer-lapels', g: 'body', d: [...openSpline(lapel(1).slice(0, 3)), ...openSpline(lapel(1).slice(2, 4)), ...openSpline(lapel(1).slice(3)), ...openSpline(lapel(-1).slice(0, 3)), ...openSpline(lapel(-1).slice(2, 4)), ...openSpline(lapel(-1).slice(3))], fill: 'none', stroke: shade(hex, -0.45), sw: 2.6 });
      b.add({ id: 'blazer-gorge', g: 'body', d: [...seg([CX + n * 1.36, nb + 36], [CX + n * 1.04, nb + 12]), ...seg([CX - n * 1.36, nb + 36], [CX - n * 1.04, nb + 12])], fill: 'none', stroke: shade(hex, -0.45), sw: 2.2, op: 0.8 });
      armSeams(ctx, 'blazer', hex, 7, 0.4);
      shoulderSheen(ctx, 'blazer', 0.12);
      // breast pocket welt with a folded pocket square
      const px = CX + S * 0.52 + 6;
      const py = nb + 112;
      b.add({ id: 'blazer-square', g: 'body', d: closedMixed([[px - 18, py + 2, true], [px - 12, py - 13, true], [px - 4, py - 4, true], [px + 4, py - 16, true], [px + 12, py - 6, true], [px + 20, py - 2, true]]), fill: mix(ac, '#FFFFFF', 0.3), stroke: shade(ac, -0.4), sw: 1.6 });
      b.add({ id: 'blazer-welt', g: 'body', d: closedMixed([[px - 26, py + 2, true], [px + 26, py - 4, true], [px + 26, py + 6, true], [px - 26, py + 12, true]]), fill: shade(hex, -0.12), stroke: shade(hex, -0.45), sw: 2 });
      buttons(ctx, 'blazer', [[CX + 8, nb + 186]], 7, shade(hex, -0.3), { holes: true });
    },
  },

  overalls: {
    name: 'Overalls', note: 'bib overalls over a T-shirt',
    top(ctx) {
      const { b, CX, colors } = ctx;
      const { nb, n, S } = geo(ctx);
      const hex = colors.cloth;
      const ac = colors.accent;
      // the tee underneath, in the accent colour
      const nl = crew(ctx);
      const teeRing = torsoRing(ctx, nl);
      clothGradient(ctx, 'overalls-teeCloth', ac);
      b.add({ id: 'overalls-tee', g: 'body', d: closedMixed(teeRing), fill: 'overalls-teeCloth', stroke: shade(ac, -0.4), sw: 3 });
      armSeams(ctx, 'overalls', ac);
      b.add({ id: 'overalls-teeCollar', g: 'body', d: openSpline(nl), fill: 'none', stroke: shade(ac, -0.18), sw: 9, cap: 'butt' });
      b.add({ id: 'overalls-teeCollarLine', g: 'body', d: openSpline(nl), fill: 'none', stroke: shade(ac, -0.45), sw: 2.5 });
      // bib and straps
      const edge = topEdge(teeRing);
      const bw = n * 1.08;
      const bt = nb + 60;
      const bib = [[CX + bw, bt, true], [CX + bw * 1.06, 1060, true], [CX - bw * 1.06, 1060, true], [CX - bw, bt, true], [CX, bt - 3]];
      const strap = (s) => {
        const xo = Math.max(S * 0.6, n * 1.75);
        const xi = xo - 34;
        return [[CX + s * (bw - 2), bt + 26, true], [CX + s * (bw - 36), bt + 22, true], [CX + s * xi, edgeY(edge, CX, xi) + 1, true], [CX + s * xo, edgeY(edge, CX, xo) + 1, true]];
      };
      const main = garment(ctx, 'overalls', [bib, strap(1), strap(-1)], { shadow: false });
      // topstitching
      const stitch = shade(hex, 0.45);
      const st = [
        ...openSpline([[CX - bw + 7, bt + 7], [CX, bt + 4], [CX + bw - 7, bt + 7]]),
        ...seg([CX + bw - 7, bt + 7], [CX + bw * 1.04 - 7, 1060]),
        ...seg([CX - bw + 7, bt + 7], [CX - bw * 1.04 + 7, 1060]),
      ];
      for (const s of [1, -1]) {
        const p = strap(s);
        st.push(...seg(lerp2(p[1], p[0], -0.0, 6 * s), lerp2(p[2], p[3], 0, 6 * s)), ...seg(lerp2(p[0], p[1], 0, -6 * s), lerp2(p[3], p[2], 0, -6 * s)));
      }
      b.add({ id: 'overalls-stitch', g: 'body', d: st, fill: 'none', stroke: stitch, sw: 1.6, op: 0.6, clip: main });
      // bib pocket
      const pw = bw * 0.58;
      const pocket = closedMixed([[CX - pw, bt + 26, true], [CX + pw, bt + 26, true], [CX + pw, bt + 90], [CX, bt + 98], [CX - pw, bt + 90]]);
      b.add({ id: 'overalls-pocketTint', g: 'body', d: pocket, fill: shade(hex, -0.5), op: 0.1 });
      b.add({ id: 'overalls-pocket', g: 'body', d: pocket, fill: 'none', stroke: shade(hex, -0.42), sw: 2.2 });
      b.add({ id: 'overalls-pocketStitch', g: 'body', d: [...seg([CX - pw + 5, bt + 34], [CX + pw - 5, bt + 34]), ...seg([CX + 8, bt + 34], [CX + 8, bt + 94])], fill: 'none', stroke: stitch, sw: 1.6, op: 0.6 });
      // strap clasps and buttons
      const clasps = [];
      const btns = [];
      for (const s of [1, -1]) {
        const p = strap(s);
        const cx = (p[0][0] + p[1][0]) / 2;
        const cy = (p[0][1] + p[1][1]) / 2 - 4;
        clasps.push(closedMixed([[cx - 17, cy - 10, true], [cx + 17, cy - 10, true], [cx + 15, cy + 10, true], [cx - 15, cy + 10, true]]));
        btns.push([cx, cy + 16]);
      }
      b.add({ id: 'overalls-clasps', g: 'body', d: clasps.flat(), fill: '#C9A24A', stroke: '#7A5C1E', sw: 2 });
      b.add({ id: 'overalls-claspIn', g: 'body', d: clasps.flat(), fill: 'none', stroke: '#F1D78E', sw: 1.4, op: 0.6 });
      b.add({ id: 'overalls-claspSlot', g: 'body', d: btns.flatMap(([x, y]) => rect(x - 9, y - 24, x + 9, y - 19)), fill: '#5A4316', op: 0.75 });
      buttons(ctx, 'overalls', btns, 7.5, '#C9A24A');
    },
  },

  'leather-jacket': {
    name: 'Leather jacket', note: 'a leather jacket with a zip and wide lapels over a T-shirt',
    behindHead(ctx) {
      collarBack(ctx, 'leather-jacket', ctx.colors.cloth, 46, 1.12);
    },
    top(ctx) {
      const { b, CX, colors } = ctx;
      const { nb, n, S } = geo(ctx);
      const hex = colors.cloth;
      const ac = colors.accent;
      const nl = crew(ctx);
      clothGradient(ctx, 'leather-jacket-teeCloth', ac);
      b.add({ id: 'leather-jacket-tee', g: 'body', d: closedMixed(torsoRing(ctx, nl)), fill: 'leather-jacket-teeCloth', stroke: shade(ac, -0.4), sw: 3 });
      b.add({ id: 'leather-jacket-teeCollar', g: 'body', d: openSpline(nl), fill: 'none', stroke: shade(ac, -0.18), sw: 9, cap: 'butt' });
      b.add({ id: 'leather-jacket-teeCollarLine', g: 'body', d: openSpline(nl), fill: 'none', stroke: shade(ac, -0.45), sw: 2.5 });
      const vb = nb + 124;
      const V = [[CX + n * 1.14, nb - 22], [CX + n * 0.96, nb + 40], [CX + n * 0.4, nb + 100], [CX + 3, vb, true], [CX - n * 0.4, nb + 100], [CX - n * 0.96, nb + 40], [CX - n * 1.14, nb - 22]];
      b.grad('leather-jacket-leather', { kind: 'linear', start: [CX - 240, nb - 20], end: [CX + 250, nb + 300], stops: [{ at: 0, color: shade(hex, 0.2) }, { at: 0.45, color: hex }, { at: 1, color: shade(hex, -0.3) }] });
      const jring = torsoRing(ctx, V, 6);
      const jedge = topEdge(jring);
      const main = garment(ctx, 'leather-jacket', [jring], { fill: 'leather-jacket-leather' });
      // wide lapels and a pointed collar
      const lapel = (s) => [
        [CX + s * n * 1.14, nb - 18],
        [CX + s * n * 1.6, edgeY(jedge, CX, n * 1.6) + 7],
        [CX + s * n * 1.52, nb + 44, true],
        [CX + s * n * 2.02, nb + 54, true],
        [CX + s * n * 1.12, nb + 104],
        [CX + s * n * 0.36, nb + 104, true],
      ];
      const lapelRing = (s) => orient([...lapel(s), [CX + s * n * 0.4, nb + 100], [CX + s * n * 0.96, nb + 40]]);
      b.add({ id: 'leather-jacket-lapelTint', g: 'body', d: [...closedMixed(lapelRing(1)), ...closedMixed(lapelRing(-1))], fill: shade(hex, 0.32), op: 0.14 });
      b.add({ id: 'leather-jacket-lapelShadow', g: 'body', d: [...openSpline(offsetPts(lapel(1).slice(3), -4)), ...openSpline(offsetPts(lapel(-1).slice(3), 4))], fill: 'none', stroke: shade(hex, -0.65), sw: 7, op: 0.25, clip: main });
      b.add({ id: 'leather-jacket-lapels', g: 'body', d: [...openSpline(lapel(1).slice(0, 3)), ...openSpline(lapel(1).slice(2, 4)), ...openSpline(lapel(1).slice(3)), ...openSpline(lapel(-1).slice(0, 3)), ...openSpline(lapel(-1).slice(2, 4)), ...openSpline(lapel(-1).slice(3))], fill: 'none', stroke: shade(hex, -0.5), sw: 2.8 });
      armSeams(ctx, 'leather-jacket', hex, 6, 0.45);
      // zip
      const zx = CX + 3;
      const teeth = [];
      for (let y = vb + 6, i = 0; y < 880; y += 5, i++) teeth.push([zx + (i % 2 ? 4 : -4), y]);
      b.add({ id: 'leather-jacket-zipTape', g: 'body', d: seg([zx, vb], [zx, 1060]), fill: 'none', stroke: shade(hex, -0.55), sw: 11, cap: 'butt' });
      b.add({ id: 'leather-jacket-zipTeeth', g: 'body', d: poly(teeth, false), fill: 'none', stroke: '#C8CCD2', sw: 2.4, op: 0.95 });
      b.add({ id: 'leather-jacket-zipPull', g: 'body', d: [...closedMixed([[zx - 6, vb + 4, true], [zx + 6, vb + 4, true], [zx + 5, vb + 16, true], [zx - 5, vb + 16, true]]), ...closedMixed([[zx - 4, vb + 16, true], [zx + 4, vb + 16, true], [zx + 5, vb + 38], [zx, vb + 42], [zx - 5, vb + 38]])], fill: '#D4D8DE', stroke: '#6C7179', sw: 1.8 });
      // studs on the collar points, and leather shine
      const studs = [[CX + n * 1.86, nb + 48], [CX - n * 1.86, nb + 48], [CX + n * 1.5, nb + 34], [CX - n * 1.5, nb + 34]];
      b.add({ id: 'leather-jacket-studs', g: 'body', d: studs.flatMap(([x, y]) => ellipse(x, y, 4.2, 4.2)), fill: '#D9DDE3', stroke: '#6C7179', sw: 1.4 });
      b.add({ id: 'leather-jacket-shine', g: 'body', d: [...openSpline([[CX - n * 1.5, nb + 20], [CX - S * 0.66, nb + 36], [CX - S * 0.86, nb + 66]]), ...openSpline([[CX - S * 0.6, nb + 92], [CX - S * 0.56, nb + 150], [CX - S * 0.58, nb + 210]]), ...openSpline([[CX + S * 0.72, nb + 46], [CX + S * 0.86, nb + 72]])], fill: 'none', stroke: '#FFFFFF', sw: 6, op: 0.2 });
    },
  },

  cardigan: {
    name: 'Cardigan', note: 'an open cardigan over a T-shirt',
    top(ctx) {
      const { b, CX, colors } = ctx;
      const { nb, n, S } = geo(ctx);
      const hex = colors.cloth;
      const ac = colors.accent;
      const nl = crew(ctx);
      clothGradient(ctx, 'cardigan-teeCloth', ac);
      b.add({ id: 'cardigan-tee', g: 'body', d: closedMixed(torsoRing(ctx, nl)), fill: 'cardigan-teeCloth', stroke: shade(ac, -0.4), sw: 3 });
      b.add({ id: 'cardigan-teeCollar', g: 'body', d: openSpline(nl), fill: 'none', stroke: shade(ac, -0.18), sw: 9, cap: 'butt' });
      b.add({ id: 'cardigan-teeCollarLine', g: 'body', d: openSpline(nl), fill: 'none', stroke: shade(ac, -0.45), sw: 2.5 });
      // two front panels with an open front
      const front = (s) => [[CX + s * n * 1.06, nb - 12], [CX + s * n * 0.78, nb + 50], [CX + s * n * 0.5, nb + 140], [CX + s * n * 0.42, 1060, true]];
      const panel = (s) => {
        const side = s > 0 ? rightSide(ctx, 4) : mirrorPts(rightSide(ctx, 4), CX);
        return [front(s)[0], ...side, ...front(s).slice(1).reverse()];
      };
      const main = garment(ctx, 'cardigan', [panel(1), panel(-1)]);
      armSeams(ctx, 'cardigan', hex, 4, 0.38);
      shoulderSheen(ctx, 'cardigan', 0.1);
      // ribbed button bands along the opening
      const bandC = (s) => offsetPts(front(s).map(([x, y]) => [x, y]), s * -10).map(([x, y], i) => [x, i === 0 ? y + 4 : y]);
      b.add({ id: 'cardigan-band', g: 'body', d: [...openSpline(bandC(1)), ...openSpline(bandC(-1))], fill: 'none', stroke: shade(hex, -0.08), sw: 19, cap: 'butt', clip: main });
      const bandEdge = (s) => offsetPts(front(s).map(([x, y]) => [x, y]), s * -20);
      b.add({ id: 'cardigan-bandLine', g: 'body', d: [...openSpline(bandEdge(1)), ...openSpline(bandEdge(-1))], fill: 'none', stroke: shade(hex, -0.38), sw: 2, op: 0.7, clip: main });
      b.add({ id: 'cardigan-mainEdge', g: 'body', d: [...openSpline(front(1)), ...openSpline(front(-1))], fill: 'none', stroke: shade(hex, -0.42), sw: 2.8 });
      // buttons on the wearer's right, buttonholes on the left
      const atY = (pts, y) => [edgeYTop(pts.map(([px, py]) => [py, px]), y), y];
      const ys = [nb + 64, nb + 116, nb + 168, nb + 220];
      const bpts = ys.map((y) => atY(curvy(bandC(-1)), y));
      const hpts = ys.map((y) => atY(curvy(bandC(1)), y));
      b.add({ id: 'cardigan-holes', g: 'body', d: hpts.flatMap(([x, y]) => seg([x - 5, y], [x + 5, y])), fill: 'none', stroke: shade(hex, -0.5), sw: 2.6, op: 0.7 });
      buttons(ctx, 'cardigan', bpts, 6.2, shade(ac, -0.25), { holes: true });
    },
  },

  robe: {
    name: 'Wrap robe', note: 'a flowing wrap robe with a trimmed collar',
    behindHead(ctx) {
      const { b, CX, colors } = ctx;
      const { nb, n } = geo(ctx);
      const ac = colors.accent;
      b.add({ id: 'robe-collarBack', g: 'body', d: closedSpline([[CX + n * 1.34, nb + 6], [CX + n * 1.22, nb - 34], [CX, nb - 50], [CX - n * 1.22, nb - 34], [CX - n * 1.34, nb + 6], [CX, nb + 14]]), fill: shade(ac, -0.3), stroke: shade(ac, -0.5), sw: 2.4 });
    },
    top(ctx) {
      const { b, CX, colors } = ctx;
      const { nb, n, S } = geo(ctx);
      const hex = colors.cloth;
      const ac = colors.accent;
      const cy = nb + 116;
      const V = [[CX + n * 1.08, nb - 24], [CX + n * 0.62, nb + 40], [CX - n * 0.04, cy, true], [CX - n * 0.62, nb + 40], [CX - n * 1.08, nb - 24]];
      const main = garment(ctx, 'robe', [torsoRing(ctx, V, 8)]);
      armSeams(ctx, 'robe', hex, 8, 0.32);
      // soft drape folds
      b.add({ id: 'robe-folds', g: 'body', d: [...openSpline([[CX - n * 0.2, cy + 10], [CX - n * 0.5, cy + 80], [CX - n * 0.62, 1000]]), ...openSpline([[CX + S * 0.5, nb + 120], [CX + S * 0.46, nb + 200], [CX + S * 0.5, 1000]]), ...openSpline([[CX - S * 0.52, nb + 110], [CX - S * 0.5, nb + 200], [CX - S * 0.54, 1000]])], fill: 'none', stroke: shade(hex, -0.38), sw: 2.4, op: 0.35, clip: main });
      // trims: the under edge (wearer's left) first, then the over edge that crosses it
      const tw = 24;
      const under = [[CX + n * 1.08, nb - 30], [CX + n * 0.62, nb + 40], [CX - n * 0.04, cy]];
      const over = [[CX - n * 1.08, nb - 30], [CX - n * 0.62, nb + 40], [CX - n * 0.04, cy], [CX + S * 0.34, 1060]];
      b.grad('robe-trim', { kind: 'linear', start: [CX - 120, nb - 30], end: [CX + 160, nb + 200], stops: [{ at: 0, color: shade(ac, 0.18) }, { at: 1, color: shade(ac, -0.18) }] });
      const bandRing = (pts, d) => orient([...pts, ...offsetPts(pts, d).reverse()].map((p, i, a) => [p[0], p[1], i === 0 || i === pts.length - 1 || i === pts.length || i === a.length - 1]));
      const uRing = bandRing(under, -tw);
      b.add({ id: 'robe-trimUnder', g: 'body', d: closedMixed(uRing), fill: 'robe-trim', stroke: shade(ac, -0.45), sw: 2.4, clip: main });
      const oPts = [over[0], over[1], [CX + n * 0.2, cy + 30], over[3]];
      const oRing = bandRing(oPts, tw);
      b.add({ id: 'robe-overShadow', g: 'body', d: openSpline(offsetPts(oPts, tw + 4)), fill: 'none', stroke: shade(hex, -0.6), sw: 7, op: 0.22, clip: main });
      b.add({ id: 'robe-trimOver', g: 'body', d: closedMixed(oRing), fill: 'robe-trim', stroke: shade(ac, -0.45), sw: 2.4 });
      // a stitched line of dots along the over trim, like embroidery
      const mid = curvy(offsetPts(oPts, tw / 2).map(([x, y]) => [x, y]));
      const dots = [];
      for (let i = 1; i < 26; i++) {
        const p = along(mid, i / 26);
        if (p[1] < 900) dots.push(dotPath(p[0], p[1]));
      }
      b.add({ id: 'robe-trimDots', g: 'body', d: dots.flat(), fill: 'none', stroke: shade(ac, 0.5), sw: 3.4, op: 0.75, clip: 'robe-trimOver' });
      const umid = curvy(offsetPts(under, -tw / 2).map(([x, y]) => [x, y]));
      const udots = [];
      for (let i = 1; i < 10; i++) {
        const p = along(umid, i / 10);
        udots.push(dotPath(p[0], p[1]));
      }
      b.add({ id: 'robe-trimDotsU', g: 'body', d: udots.flat(), fill: 'none', stroke: shade(ac, 0.5), sw: 3.4, op: 0.75, clip: 'robe-trimUnder' });
      shoulderSheen(ctx, 'robe', 0.12);
    },
  },

  scrubs: {
    name: 'Scrubs', note: 'medical scrubs with a V-neck and a chest pocket',
    top(ctx) {
      const { b, CX, colors } = ctx;
      const { nb, n, S } = geo(ctx);
      const hex = colors.cloth;
      const ac = colors.accent;
      const inner = [[CX + n * 0.92, nb - 8], [CX + n * 0.44, nb + 46], [CX, nb + 92, true], [CX - n * 0.44, nb + 46], [CX - n * 0.92, nb - 8]];
      garment(ctx, 'scrubs', [torsoRing(ctx, inner, 2)]);
      armSeams(ctx, 'scrubs', hex, 2, 0.4);
      shoulderSheen(ctx, 'scrubs', 0.1);
      // V band with an overlap at the point
      const outer = [[CX + n * 1.3, nb + 4, true], [CX + n * 0.6, nb + 64], [CX, nb + 114, true], [CX - n * 0.6, nb + 64], [CX - n * 1.3, nb + 4, true]];
      const vring = orient([...outer, ...inner.slice().reverse().map(([x, y], i, a) => [x, y, i === 0 || i === a.length - 1 || i === 2])]);
      clothGradient(ctx, 'scrubs-bandCloth', shade(hex, -0.06));
      b.add({ id: 'scrubs-vband', g: 'body', d: closedMixed(vring), fill: 'scrubs-bandCloth', stroke: shade(hex, -0.42), sw: 2.6 });
      b.add({ id: 'scrubs-overlap', g: 'body', d: seg([CX, nb + 92], [CX + n * 0.3, nb + 92]), fill: 'none', stroke: shade(hex, -0.42), sw: 2.4 });
      b.add({ id: 'scrubs-vStitch', g: 'body', d: openSpline(offsetPts(outer.map(([x, y]) => [x, y]), -5)), fill: 'none', stroke: shade(hex, 0.35), sw: 1.4, op: 0.6 });
      // chest pocket (wearer's left) with a pen
      const px = CX + S * 0.46;
      const py = nb + 78;
      const pw = 34;
      b.add({ id: 'scrubs-pen', g: 'body', d: closedMixed([[px - 18, py - 26, true], [px - 10, py - 26, true], [px - 10, py + 8, true], [px - 18, py + 8, true]]), fill: ac, stroke: shade(ac, -0.45), sw: 1.8 });
      b.add({ id: 'scrubs-penClip', g: 'body', d: seg([px - 14, py - 22], [px - 14, py + 6]), fill: 'none', stroke: '#C8CCD2', sw: 2.4 });
      b.add({ id: 'scrubs-pocket', g: 'body', d: closedMixed([[px - pw, py, true], [px + pw, py, true], [px + pw, py + 72, true], [px - pw, py + 72, true]]), fill: 'scrubs-cloth', stroke: shade(hex, -0.42), sw: 2.4 });
      drawPattern(ctx, 'scrubs', 'scrubs-pocket', [[[px - pw, py], [px + pw, py], [px + pw, py + 72], [px - pw, py + 72]]], 'ppat');
      b.add({ id: 'scrubs-pocketLine', g: 'body', d: closedMixed([[px - pw, py, true], [px + pw, py, true], [px + pw, py + 72, true], [px - pw, py + 72, true]]), fill: 'none', stroke: shade(hex, -0.42), sw: 2.4 });
      b.add({ id: 'scrubs-pocketHem', g: 'body', d: seg([px - pw + 2, py + 9], [px + pw - 2, py + 9]), fill: 'none', stroke: shade(hex, -0.3), sw: 1.8, op: 0.7 });
    },
  },

  jersey: {
    name: 'Sports jersey', note: 'a sporty jersey with contrasting shoulders',
    top(ctx) {
      const { b, CX, colors } = ctx;
      const { nb, n, S } = geo(ctx);
      const hex = colors.cloth;
      const ac = patternInk(hex, colors.accent);
      const nl = vneck(ctx, 74);
      garment(ctx, 'jersey', [torsoRing(ctx, nl, 2)]);
      // raglan shoulder panels in the accent colour
      const seamR = [[CX + n * 0.98, nb - 2], [CX + S * 0.5, nb + 56], [CX + S * 0.72, nb + 150], [CX + S * 0.8, 1060, true]];
      const panel = (s) => {
        const side = s > 0 ? rightSide(ctx, 2) : mirrorPts(rightSide(ctx, 2), CX);
        const seam = s > 0 ? seamR : sym(ctx, seamR);
        return orient([[...seam[0], true], ...side, ...seam.slice(1).reverse()]);
      };
      clothGradient(ctx, 'jersey-panelCloth', ac);
      b.add({ id: 'jersey-panels', g: 'body', d: [...closedMixed(panel(1)), ...closedMixed(panel(-1))], fill: 'jersey-panelCloth', stroke: shade(ac, -0.42), sw: 2.8 });
      const pipe = luminance(hex) > 0.6 && luminance(ac) > 0.6 ? shade(hex, -0.3) : '#F7F4EE';
      b.add({ id: 'jersey-piping', g: 'body', d: [...openSpline(offsetPts(seamR, -4)), ...openSpline(offsetPts(sym(ctx, seamR), 4))], fill: 'none', stroke: pipe, sw: 3, op: 0.9, clip: 'jersey-main' });
      // two-tone V collar
      b.add({ id: 'jersey-collar', g: 'body', d: openSpline(offsetPts(nl.map(([x, y]) => [x, y]), -5)), fill: 'none', stroke: ac, sw: 13 });
      b.add({ id: 'jersey-collarStripe', g: 'body', d: openSpline(offsetPts(nl.map(([x, y]) => [x, y]), -7)), fill: 'none', stroke: pipe, sw: 3 });
      b.add({ id: 'jersey-collarLine', g: 'body', d: [...openSpline(nl), ...openSpline(offsetPts(nl.map(([x, y]) => [x, y]), -12))], fill: 'none', stroke: shade(ac, -0.45), sw: 2.2 });
      b.add({ id: 'jersey-sheen', g: 'body', d: openSpline([[CX - S * 0.6, nb + 70], [CX - S * 0.52, nb + 140], [CX - S * 0.5, nb + 220]]), fill: 'none', stroke: '#FFFFFF', sw: 8, op: 0.1 });
    },
  },
};

// helpers used above that need hoisting-friendly definitions
function curvy(pts) {
  // smooth a polyline with sharp flags into a dense polyline (for clipped piping)
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p0 = pts[Math.max(0, i - 1)];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const t = 1 / 6;
    const c1 = p1[2] || i === 0 ? [p1[0] + (p2[0] - p1[0]) / 3, p1[1] + (p2[1] - p1[1]) / 3] : [p1[0] + (p2[0] - p0[0]) * t, p1[1] + (p2[1] - p0[1]) * t];
    const c2 = p2[2] || i === pts.length - 2 ? [p2[0] - (p2[0] - p1[0]) / 3, p2[1] - (p2[1] - p1[1]) / 3] : [p2[0] - (p3[0] - p1[0]) * t, p2[1] - (p3[1] - p1[1]) * t];
    for (let s = i === 0 ? 0 : 1; s <= 6; s++) {
      const u = s / 6;
      const a = (1 - u) ** 3;
      const b = 3 * (1 - u) ** 2 * u;
      const c = 3 * (1 - u) * u * u;
      const d = u ** 3;
      out.push([a * p1[0] + b * c1[0] + c * c2[0] + d * p2[0], a * p1[1] + b * c1[1] + c * c2[1] + d * p2[1]]);
    }
  }
  return out;
}

function edgeYTop(top, x) {
  for (let i = 0; i < top.length - 1; i++) {
    const a = top[i];
    const b = top[i + 1];
    if ((x >= a[0] && x <= b[0]) || (x <= a[0] && x >= b[0])) return a[1] + ((b[1] - a[1]) * (x - a[0])) / ((b[0] - a[0]) || 1);
  }
  return top[0][1];
}

// point between a and b at t, nudged sideways by d (for topstitching inside an edge)
function lerp2(a, b, t, d) {
  const x = a[0] + (b[0] - a[0]) * t;
  const y = a[1] + (b[1] - a[1]) * t;
  return [x + d, y];
}

export { crew, vneck, closedSpline, mix };
