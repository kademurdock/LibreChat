// Geometry and colour helpers for the puppet kit. Pure functions, no dependencies.
// Paths use the Angel vector command format: { op: 'M'|'L'|'Q'|'C'|'Z', v: [...] }.

export const round1 = (n) => Math.round(n * 10) / 10;

export function pt(x, y) {
  return [x, y];
}

// Closed Catmull-Rom spline through points -> cubic Bezier path. Fixed structure for
// a fixed number of points, so two calls with the same count can be morphed.
export function closedSpline(points, tension = 1) {
  const n = points.length;
  const d = [{ op: 'M', v: [round1(points[0][0]), round1(points[0][1])] }];
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    const t = tension / 6;
    d.push({
      op: 'C',
      v: [
        round1(p1[0] + (p2[0] - p0[0]) * t),
        round1(p1[1] + (p2[1] - p0[1]) * t),
        round1(p2[0] - (p3[0] - p1[0]) * t),
        round1(p2[1] - (p3[1] - p1[1]) * t),
        round1(p2[0]),
        round1(p2[1]),
      ],
    });
  }
  d.push({ op: 'Z', v: [] });
  return d;
}

// Open Catmull-Rom spline (end tangents mirrored) for strokes.
export function openSpline(points, tension = 1) {
  const n = points.length;
  const d = [{ op: 'M', v: [round1(points[0][0]), round1(points[0][1])] }];
  for (let i = 0; i < n - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const p0 = i === 0 ? [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]] : points[i - 1];
    const p3 = i + 2 < n ? points[i + 2] : [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]];
    const t = tension / 6;
    d.push({
      op: 'C',
      v: [
        round1(p1[0] + (p2[0] - p0[0]) * t),
        round1(p1[1] + (p2[1] - p0[1]) * t),
        round1(p2[0] - (p3[0] - p1[0]) * t),
        round1(p2[1] - (p3[1] - p1[1]) * t),
        round1(p2[0]),
        round1(p2[1]),
      ],
    });
  }
  return d;
}

// Mixed corners: points may carry a third element `true` marking a sharp corner.
// Sharp corners use straight tangents; everything else is smooth. Closed.
export function closedMixed(points, tension = 1) {
  const n = points.length;
  const t = tension / 6;
  const d = [{ op: 'M', v: [round1(points[0][0]), round1(points[0][1])] }];
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    const c1 = p1[2] ? [p1[0] + (p2[0] - p1[0]) / 3, p1[1] + (p2[1] - p1[1]) / 3] : [p1[0] + (p2[0] - p0[0]) * t, p1[1] + (p2[1] - p0[1]) * t];
    const c2 = p2[2] ? [p2[0] - (p2[0] - p1[0]) / 3, p2[1] - (p2[1] - p1[1]) / 3] : [p2[0] - (p3[0] - p1[0]) * t, p2[1] - (p3[1] - p1[1]) * t];
    d.push({ op: 'C', v: [round1(c1[0]), round1(c1[1]), round1(c2[0]), round1(c2[1]), round1(p2[0]), round1(p2[1])] });
  }
  d.push({ op: 'Z', v: [] });
  return d;
}

const K = 0.5522847498;

export function ellipse(cx, cy, rx, ry) {
  return [
    { op: 'M', v: [round1(cx + rx), round1(cy)] },
    { op: 'C', v: [round1(cx + rx), round1(cy + ry * K), round1(cx + rx * K), round1(cy + ry), round1(cx), round1(cy + ry)] },
    { op: 'C', v: [round1(cx - rx * K), round1(cy + ry), round1(cx - rx), round1(cy + ry * K), round1(cx - rx), round1(cy)] },
    { op: 'C', v: [round1(cx - rx), round1(cy - ry * K), round1(cx - rx * K), round1(cy - ry), round1(cx), round1(cy - ry)] },
    { op: 'C', v: [round1(cx + rx * K), round1(cy - ry), round1(cx + rx), round1(cy - ry * K), round1(cx + rx), round1(cy)] },
    { op: 'Z', v: [] },
  ];
}

// Several sub-paths concatenated into one compound path (filled together).
export function compound(...paths) {
  return paths.flat();
}

export function mirrorX(points, cx) {
  return points.map((p) => [2 * cx - p[0], p[1], p[2]]);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function lerpPt(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
}

export function rotatePt(p, c, angle) {
  const s = Math.sin(angle);
  const k = Math.cos(angle);
  const x = p[0] - c[0];
  const y = p[1] - c[1];
  return [c[0] + x * k - y * s, c[1] + x * s + y * k, p[2]];
}

// Tapered stroke as a closed shape: centre line points + width profile (one per point).
export function taper(center, widths) {
  const n = center.length;
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    const a = center[Math.max(0, i - 1)];
    const b = center[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const w = widths[i] / 2;
    left.push([center[i][0] - dy * w, center[i][1] + dx * w]);
    right.push([center[i][0] + dy * w, center[i][1] - dx * w]);
  }
  return closedSpline([...left, ...right.reverse()], 0.9);
}

// ---------- colour ----------
export function hexToRgb(hex) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

export function mix(a, b, t) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([lerp(x[0], y[0], t), lerp(x[1], y[1], t), lerp(x[2], y[2], t)]);
}

export function shade(hex, amount) {
  // amount < 0 darkens toward a warm dark, > 0 lightens toward a warm white.
  return amount < 0 ? mix(hex, '#1a0f14', -amount) : mix(hex, '#fffaf2', amount);
}

export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Deterministic PRNG (mulberry32) from a string or number seed.
export function seeded(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (const ch of String(seed)) {
    h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
