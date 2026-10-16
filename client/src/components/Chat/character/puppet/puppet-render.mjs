// Generic renderer for a compiled puppet scene on a Canvas 2D context.
// The scene is data: shapes with optional morph targets, groups with channel-driven
// transforms. Every platform renderer must follow these exact rules:
//  1. A morph moves each coordinate by weight * (target - base); weight is
//     max(0, value) for a normal morph and max(0, -value) when `n` (negative) is set.
//  2. A group's local transform is translate(tx, ty) * translate(pivot) * rotate(r)
//     * scale(sx, sy) * translate(-pivot); tx/ty/r are sums of gain*value, sx/sy are
//     1 + sum of gain*value. A child's transform is parent * local.
//  3. Shapes draw in array order. `clip` names an earlier shape whose morphed path, in
//     its own group's transform, clips this shape.

const ident = [1, 0, 0, 1, 0, 0];

function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function drive(list, ch) {
  let s = 0;
  if (list) for (const [name, gain] of list) s += (ch[name] || 0) * gain;
  return s;
}

export function groupMatrices(scene, ch) {
  const out = {};
  for (const g of scene.groups) {
    const tx = drive(g.tx, ch);
    const ty = drive(g.ty, ch);
    const r = drive(g.r, ch);
    const sx = 1 + drive(g.sx, ch);
    const sy = 1 + drive(g.sy, ch);
    const [px, py] = g.pivot || [0, 0];
    const c = Math.cos(r);
    const s = Math.sin(r);
    // translate(tx+px, ty+py) * rotate * scale * translate(-px,-py)
    const a = c * sx;
    const b = s * sx;
    const cc = -s * sy;
    const d = c * sy;
    const e = tx + px - (a * px + cc * py);
    const f = ty + py - (b * px + d * py);
    const local = [a, b, cc, d, e, f];
    out[g.id] = g.parent ? mul(out[g.parent], local) : local;
  }
  return out;
}

export function morphPath(shape, ch) {
  if (!shape.m || !shape.m.length) return shape.d;
  let weights = null;
  for (let i = 0; i < shape.m.length; i++) {
    const mm = shape.m[i];
    const v = ch[mm.c] || 0;
    const w = mm.n ? Math.max(0, -v) : Math.max(0, v);
    if (w > 0) (weights ||= []).push([mm.d, w]);
  }
  if (!weights) return shape.d;
  return shape.d.map((cmd, k) => {
    if (!cmd.v.length) return cmd;
    const v = cmd.v.slice();
    for (const [target, w] of weights) {
      const tv = target[k].v;
      for (let j = 0; j < v.length; j++) v[j] += (tv[j] - cmd.v[j]) * w;
    }
    return { op: cmd.op, v };
  });
}

function trace(ctx, d) {
  ctx.beginPath();
  commands(ctx, d);
}

// The path commands alone, onto a context or a Path2D (which has no beginPath).
function commands(ctx, d) {
  for (const c of d) {
    const v = c.v;
    if (c.op === 'M') ctx.moveTo(v[0], v[1]);
    else if (c.op === 'L') ctx.lineTo(v[0], v[1]);
    else if (c.op === 'Q') ctx.quadraticCurveTo(v[0], v[1], v[2], v[3]);
    else if (c.op === 'C') ctx.bezierCurveTo(v[0], v[1], v[2], v[3], v[4], v[5]);
    else if (c.op === 'Z') ctx.closePath();
  }
}

function paint(ctx, scene, value, cache) {
  if (!value || value === 'none') return null;
  const grad = scene.gradients[value];
  if (!grad) return value;
  if (cache[value]) return cache[value];
  let g;
  if (grad.kind === 'linear') g = ctx.createLinearGradient(grad.start[0], grad.start[1], grad.end[0], grad.end[1]);
  else {
    const f = grad.focal || grad.center;
    g = ctx.createRadialGradient(f[0], f[1], 0, grad.center[0], grad.center[1], grad.radius);
  }
  for (const s of grad.stops) g.addColorStop(s.at, withAlpha(s.color, s.opacity ?? 1));
  cache[value] = g;
  return g;
}

function withAlpha(hex, a) {
  if (a >= 1) return hex;
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Opacity = clamp(op (default 1) + sum of gain * channel over the `oc` pairs, 0, 1).
export function shapeOpacity(shape, ch) {
  let alpha = shape.op ?? 1;
  if (shape.oc) for (const [name, gain] of shape.oc) alpha += (ch[name] || 0) * gain;
  return Math.max(0, Math.min(1, alpha));
}

// Web only: one cache per scene keeps its gradients (they belong to one context) and a
// Path2D for every path drawn unmorphed, so a resting face rebuilds nothing per frame.
// Pass the same object on every frame; it resets itself when the scene or context changes.
export function createSceneCache() {
  return { scene: null, ctx: null, grads: {}, paths: new WeakMap() };
}

function outline(ctx, d, cache) {
  if (!cache || typeof Path2D === 'undefined') {
    trace(ctx, d);
    return null;
  }
  let p = cache.paths.get(d);
  if (!p) {
    p = new Path2D();
    commands(p, d);
    cache.paths.set(d, p);
  }
  return p;
}

// Draw the scene into a box (x, y, w, h). `ch` is the channel map from the motion engine.
export function drawScene(ctx, scene, ch = {}, box = null, cache = null) {
  const [vx, vy, vw, vh] = scene.view || [0, 0, scene.size[0], scene.size[1]];
  const base = box ? [box.w / vw, 0, 0, box.h / vh, box.x - (vx * box.w) / vw, box.y - (vy * box.h) / vh] : ident;
  const mats = groupMatrices(scene, ch);
  const byId = {};
  if (cache && (cache.scene !== scene || cache.ctx !== ctx)) {
    if (cache.scene !== scene) cache.paths = new WeakMap();
    cache.scene = scene;
    cache.ctx = ctx;
    cache.grads = {};
  }
  const gradCache = cache ? cache.grads : {};
  for (const shape of scene.shapes) {
    byId[shape.id] = shape;
    if (shape.hide && shape.hide.some(([name, above]) => (ch[name] || 0) > above)) continue;
    const m = mul(base, mats[shape.g] || ident);
    ctx.save();
    if (shape.clip) {
      const clipShape = byId[shape.clip];
      const cm = mul(base, mats[clipShape.g] || ident);
      ctx.setTransform(cm[0], cm[1], cm[2], cm[3], cm[4], cm[5]);
      const cd = morphPath(clipShape, ch);
      // Only unmorphed paths are cached: a morphed path is a fresh array every frame.
      const cp = cd === clipShape.d ? outline(ctx, cd, cache) : (trace(ctx, cd), null);
      if (cp) ctx.clip(cp);
      else ctx.clip();
    }
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    const d = morphPath(shape, ch);
    const p = d === shape.d ? outline(ctx, d, cache) : (trace(ctx, d), null);
    ctx.globalAlpha = shapeOpacity(shape, ch);
    const fill = paint(ctx, scene, shape.fill, gradCache);
    if (fill) {
      ctx.fillStyle = fill;
      if (p) ctx.fill(p, 'nonzero');
      else ctx.fill('nonzero');
    }
    const stroke = paint(ctx, scene, shape.stroke, gradCache);
    if (stroke && shape.sw) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = shape.sw;
      ctx.lineCap = shape.cap || 'round';
      ctx.lineJoin = 'round';
      if (p) ctx.stroke(p);
      else ctx.stroke();
    }
    ctx.restore();
  }
}
