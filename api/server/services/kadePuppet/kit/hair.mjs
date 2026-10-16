// Hair styles for the puppet kit. Each style may draw a `back` mass (behind the head,
// neck and shoulders) and a `front` layer (over the forehead and face edges). Loose
// ends respond to the hair.swing channel through morph targets.
import { closedSpline, openSpline, closedMixed, ellipse, shade } from './geom.mjs';

const CX = 500;

export function skull(f) {
  const H = f.chin - f.top;
  return {
    H,
    w: f.W * f.hs.crown,
    wc: f.W * f.hs.cheek,
    top: f.top,
    temple: f.top + H * 0.3,
    ear: f.earY,
    chin: f.chin,
    nb: f.neckBase,
  };
}

// swing displacement grows with distance below the ears
const sw = (k, y, s) => s * Math.max(0, Math.min(1, (y - k.ear + 40) / 260));

function add(b, id, group, fn, fill, ctx, opts = {}) {
  const base = fn({ swing: 0 });
  const m = [];
  if (opts.swing !== false) {
    m.push({ c: 'hair.swing', d: fn({ swing: 1 }) });
    m.push({ c: 'hair.swing', d: fn({ swing: -1 }), n: true });
  }
  b.add({ id, g: group, d: base, m, fill, stroke: opts.noStroke ? undefined : ctx.line, sw: opts.noStroke ? undefined : 2.6, op: opts.op });
}

function strands(b, id, group, lines, ctx, op = 0.3, w = 3) {
  if (!lines.length) return;
  b.add({ id, g: group, d: lines.flatMap((l) => openSpline(l)), fill: 'none', stroke: ctx.shine, sw: w, op });
}

// ---- reusable masses ----
function backMass(k, bottom, extra = 0, vol = 0, scallop = 0) {
  return (p) => {
    const s = (p.swing || 0) * 24;
    const pts = [
      [CX, k.top - 22 - vol],
      [CX + k.w * 0.85 + extra * 0.3, k.top + 6 - vol * 0.5],
      [CX + k.w + 30 + extra, k.temple + 16],
      [CX + k.wc + 40 + extra, k.ear + 70],
      [CX + k.wc + 46 + extra, bottom - 70],
      [CX + k.wc + 26 + extra, bottom],
      [CX + 70, bottom - 14],
      [CX - 70, bottom - 14],
      [CX - k.wc - 26 - extra, bottom],
      [CX - k.wc - 46 - extra, bottom - 70],
      [CX - k.wc - 40 - extra, k.ear + 70],
      [CX - k.w - 30 - extra, k.temple + 16],
      [CX - k.w * 0.85 - extra * 0.3, k.top + 6 - vol * 0.5],
    ].map(([x, y]) => [x + sw(k, y, s), y]);
    return scallop ? closedSpline(scallopRing(pts, scallop)) : closedSpline(pts);
  };
}

function scallopRing(pts, depth) {
  // insert a bump between every pair of points, pushed outward from the centre
  const out = [];
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const c = pts[(i + 1) % pts.length];
    out.push(a);
    const mx = (a[0] + c[0]) / 2;
    const my = (a[1] + c[1]) / 2;
    const dx = mx - cx;
    const dy = my - cy;
    const len = Math.hypot(dx, dy) || 1;
    out.push([mx + (dx / len) * depth, my + (dy / len) * depth]);
  }
  return out;
}

function sideLock(k, sgn, bottom, width = 1, inset = 14) {
  return (p) => {
    const s = (p.swing || 0) * 20;
    const x = (dx) => CX + sgn * dx;
    const pts = [
      [x(k.w + 2), k.temple - 18],
      [x(k.wc + 26 * width), k.ear + 40],
      [x(k.wc + 32 * width), bottom - 70],
      [x(k.wc + 14 * width), bottom],
      [x(k.wc - 6), bottom - 50],
      [x(k.wc - inset), k.ear + 46],
      [x(k.w * 0.9), k.temple + 14],
    ].map(([px, py]) => [px + sw(k, py, s), py]);
    return closedSpline(pts);
  };
}

function cap(k, kind, vol = 0, partX = 0.42) {
  // top mass with a hairline; kind: swept | center | bangs | curtain | crop | slick
  return () => {
    const T = k.top;
    const H = k.H;
    const outer = [
      [CX - k.w - 7, k.temple + 14],
      [CX - k.w * 0.8, T + 8 - vol * 0.4],
      [CX - k.w * 0.15, T - 16 - vol],
      [CX + k.w * 0.6, T - 6 - vol * 0.6],
      [CX + k.w + 7, k.temple + 10],
    ];
    let line;
    if (kind === 'swept') {
      line = [
        [CX + k.w * 0.9, k.temple - 2],
        [CX + k.w * partX, T + H * 0.11],
        [CX + k.w * 0.02, T + H * 0.2],
        [CX - k.w * 0.48, T + H * 0.245],
        [CX - k.w * 0.86, k.temple + 16],
      ];
    } else if (kind === 'center') {
      line = [
        [CX + k.w * 0.9, k.temple + 8],
        [CX + k.w * 0.48, T + H * 0.17],
        [CX, T + H * 0.1],
        [CX - k.w * 0.48, T + H * 0.17],
        [CX - k.w * 0.9, k.temple + 8],
      ];
    } else if (kind === 'bangs') {
      line = [
        [CX + k.w * 0.95, k.temple + 26],
        [CX + k.w * 0.6, T + H * 0.3],
        [CX, T + H * 0.31],
        [CX - k.w * 0.6, T + H * 0.3],
        [CX - k.w * 0.95, k.temple + 26],
      ];
    } else if (kind === 'curtain') {
      line = [
        [CX + k.w * 0.92, k.temple + 30],
        [CX + k.w * 0.42, T + H * 0.27],
        [CX, T + H * 0.13],
        [CX - k.w * 0.42, T + H * 0.27],
        [CX - k.w * 0.92, k.temple + 30],
      ];
    } else if (kind === 'slick') {
      line = [
        [CX + k.w * 0.88, k.temple - 8],
        [CX + k.w * 0.5, T + H * 0.15],
        [CX, T + H * 0.135],
        [CX - k.w * 0.5, T + H * 0.15],
        [CX - k.w * 0.88, k.temple - 8],
      ];
    } else {
      // crop
      line = [
        [CX + k.w * 0.86, k.temple - 6],
        [CX + k.w * 0.45, T + H * 0.17],
        [CX, T + H * 0.185],
        [CX - k.w * 0.45, T + H * 0.17],
        [CX - k.w * 0.86, k.temple - 6],
      ];
    }
    return closedSpline([...outer, ...line]);
  };
}

function sideburns(b, k, ctx, len = 40) {
  for (const sgn of [-1, 1]) {
    const x = (dx) => CX + sgn * dx;
    b.add({
      id: 'burn' + sgn, g: 'hairFront',
      d: closedSpline([[x(k.w + 6), k.temple + 4], [x(k.wc + 2), k.ear - 20], [x(k.wc - 4), k.ear - 20 + len], [x(k.wc - 16), k.ear - 24 + len * 0.5], [x(k.w * 0.86), k.temple + 6]]),
      fill: 'hair', stroke: ctx.line, sw: 2,
    });
  }
}

function capStrands(k, kind) {
  const T = k.top;
  if (kind === 'swept')
    return [
      [[CX + k.w * 0.4, T + k.H * 0.06], [CX - k.w * 0.1, T + k.H * 0.1], [CX - k.w * 0.6, T + k.H * 0.17]],
      [[CX + k.w * 0.55, T + k.H * 0.02], [CX + k.w * 0.1, T], [CX - k.w * 0.45, T + k.H * 0.06]],
    ];
  return [
    [[CX - 8, T + k.H * 0.02], [CX - k.w * 0.4, T + k.H * 0.06], [CX - k.w * 0.75, T + k.H * 0.17]],
    [[CX + 8, T + k.H * 0.02], [CX + k.w * 0.4, T + k.H * 0.06], [CX + k.w * 0.75, T + k.H * 0.17]],
  ];
}

function curlRing(b, id, group, cx, cy, rx, ry, n, ctx, swing = true, k = null) {
  const fn = (p) => {
    const s = (p.swing || 0) * 14;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = i % 2 ? 1.0 : 0.88;
      const y = cy + Math.sin(a) * ry * rr;
      pts.push([cx + Math.cos(a) * rx * rr + (k ? sw(k, y, s) : 0), y]);
    }
    return closedSpline(pts);
  };
  add(b, id, group, fn, 'hair', ctx, { swing });
}

export const HAIR_STYLES = {
  bald: { name: 'Bald', note: 'a smooth bald head', front: (b, f, k, ctx) => {
    b.add({ id: 'scalpShine', g: 'hairFront', d: ellipse(CX - k.w * 0.3, k.top + 34, 44, 16), fill: '#FFFFFF', op: 0.18 });
  } },
  buzz: { name: 'Buzz cut', note: 'a very short buzz cut', front: (b, f, k, ctx) => {
    add(b, 'hairCap', 'hairFront', cap(k, 'crop', -6), 'hair', ctx, { swing: false, op: 0.78, noStroke: true });
    sideburns(b, k, ctx, 24);
  } },
  'short-crop': { name: 'Short crop', note: 'short, neatly cropped hair', front: (b, f, k, ctx) => {
    add(b, 'hairCap', 'hairFront', cap(k, 'crop', 6), 'hair', ctx, { swing: false });
    sideburns(b, k, ctx, 34);
    strands(b, 'hairLines', 'hairFront', capStrands(k, 'crop'), ctx, 0.28);
  } },
  'side-part': { name: 'Side part', note: 'short hair with a side part and a swept fringe', front: (b, f, k, ctx) => {
    add(b, 'hairCap', 'hairFront', cap(k, 'swept', 16), 'hair', ctx, { swing: false });
    sideburns(b, k, ctx, 30);
    strands(b, 'hairLines', 'hairFront', capStrands(k, 'swept'), ctx, 0.32);
  } },
  pompadour: { name: 'Pompadour', note: 'a tall, swept-back pompadour', front: (b, f, k, ctx) => {
    add(b, 'hairCap', 'hairFront', () => {
      const T = k.top;
      return closedSpline([
        [CX - k.w - 6, k.temple + 6], [CX - k.w * 0.85, T - 4], [CX - k.w * 0.35, T - 52], [CX + k.w * 0.25, T - 66], [CX + k.w * 0.8, T - 34],
        [CX + k.w + 6, k.temple + 4], [CX + k.w * 0.82, k.temple - 10], [CX + k.w * 0.35, T + k.H * 0.1], [CX - k.w * 0.3, T + k.H * 0.11], [CX - k.w * 0.85, k.temple - 6],
      ]);
    }, 'hair', ctx, { swing: false });
    sideburns(b, k, ctx, 30);
    strands(b, 'hairLines', 'hairFront', [[[CX - k.w * 0.5, k.top + 4], [CX - k.w * 0.1, k.top - 40], [CX + k.w * 0.5, k.top - 36]], [[CX - k.w * 0.3, k.top + 20], [CX + k.w * 0.1, k.top - 20], [CX + k.w * 0.7, k.top - 10]]], ctx, 0.35);
  } },
  spiky: { name: 'Spiky', note: 'short spiky hair', front: (b, f, k, ctx) => {
    add(b, 'hairCap', 'hairFront', () => {
      const T = k.top;
      const pts = [[CX - k.w - 6, k.temple + 6, true]];
      const n = 7;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = CX - k.w * 0.95 + t * k.w * 1.9;
        const arc = Math.sin(Math.PI * t);
        pts.push([x + (i % 2 ? 0 : -6), T + 30 - arc * 44 - (i % 2 ? 34 : 0), i % 2 === 1]);
      }
      pts.push([CX + k.w + 6, k.temple + 6, true], [CX + k.w * 0.8, k.temple - 8, true], [CX + k.w * 0.3, T + k.H * 0.14, true], [CX - k.w * 0.2, T + k.H * 0.17, true], [CX - k.w * 0.7, T + k.H * 0.12, true]);
      return closedMixed(pts);
    }, 'hair', ctx, { swing: false });
    sideburns(b, k, ctx, 24);
  } },
  'curly-short': { name: 'Short curls', note: 'short, springy curls', front: (b, f, k, ctx) => {
    add(b, 'hairCap', 'hairFront', () => closedSpline(scallopRing([
      [CX - k.w - 10, k.temple + 16], [CX - k.w * 0.85, k.top - 2], [CX - k.w * 0.25, k.top - 24], [CX + k.w * 0.35, k.top - 22], [CX + k.w * 0.88, k.top],
      [CX + k.w + 10, k.temple + 16], [CX + k.w * 0.72, k.temple], [CX + k.w * 0.2, k.top + k.H * 0.17], [CX - k.w * 0.3, k.top + k.H * 0.17], [CX - k.w * 0.75, k.temple],
    ], 12)), 'hair', ctx, { swing: false });
    const lines = [];
    for (let i = 0; i < 9; i++) {
      const x = CX - k.w * 0.7 + (i % 5) * k.w * 0.35;
      const y = k.top + 6 + Math.floor(i / 5) * 34;
      lines.push([[x - 9, y + 4], [x, y - 6], [x + 9, y + 4]]);
    }
    strands(b, 'hairLines', 'hairFront', lines, ctx, 0.35, 3);
  } },
  afro: { name: 'Afro', note: 'a big, round afro', back: (b, f, k, ctx) => {
    curlRing(b, 'hairBack', 'hairBack', CX, k.top + k.H * 0.28, k.w + 92, k.H * 0.55 + 30, 26, { ...ctx, line: ctx.line }, false);
  }, front: (b, f, k, ctx) => {
    add(b, 'hairCap', 'hairFront', () => closedSpline(scallopRing([
      [CX - k.w - 14, k.temple + 26], [CX - k.w * 0.9, k.top - 6], [CX, k.top - 30], [CX + k.w * 0.9, k.top - 6],
      [CX + k.w + 14, k.temple + 26], [CX + k.w * 0.75, k.temple + 4], [CX + k.w * 0.25, k.top + k.H * 0.17], [CX - k.w * 0.25, k.top + k.H * 0.17], [CX - k.w * 0.75, k.temple + 4],
    ], 10)), 'hair', ctx, { swing: false });
  }, hidesEars: true },
  bob: { name: 'Bob with bangs', note: 'a chin-length bob with straight bangs', hidesEars: true,
    back: (b, f, k, ctx) => add(b, 'hairBack', 'hairBack', backMass(k, k.chin + 20, -8), 'hairBack', ctx),
    front: (b, f, k, ctx) => {
      add(b, 'lockR', 'hairFront', sideLock(k, 1, k.chin + 24, 0.9, 6), 'hair', ctx);
      add(b, 'lockL', 'hairFront', sideLock(k, -1, k.chin + 24, 0.9, 6), 'hair', ctx);
      add(b, 'hairCap', 'hairFront', cap(k, 'bangs', 10), 'hair', ctx, { swing: false });
      strands(b, 'hairLines', 'hairFront', [[[CX - k.w * 0.4, k.top + 8], [CX - k.w * 0.45, k.top + k.H * 0.22]], [[CX + k.w * 0.1, k.top + 2], [CX + k.w * 0.12, k.top + k.H * 0.22]], [[CX + k.w * 0.55, k.top + 12], [CX + k.w * 0.6, k.top + k.H * 0.21]]], ctx, 0.3);
    } },
  pixie: { name: 'Pixie', note: 'a short pixie cut with a long swept fringe', front: (b, f, k, ctx) => {
    add(b, 'hairCap', 'hairFront', cap(k, 'swept', 10, 0.6), 'hair', ctx, { swing: false });
    sideburns(b, k, ctx, 44);
    strands(b, 'hairLines', 'hairFront', capStrands(k, 'swept'), ctx, 0.32);
  } },
  'shoulder-wavy': { name: 'Shoulder-length waves', note: 'soft waves that fall to the shoulders', hidesEars: true,
    back: (b, f, k, ctx) => add(b, 'hairBack', 'hairBack', backMass(k, k.nb + 50, 6), 'hairBack', ctx),
    front: (b, f, k, ctx) => {
      add(b, 'lockR', 'hairFront', sideLock(k, 1, k.nb + 46), 'hair', ctx);
      add(b, 'lockL', 'hairFront', sideLock(k, -1, k.nb + 46), 'hair', ctx);
      add(b, 'hairCap', 'hairFront', cap(k, 'swept', 14), 'hair', ctx, { swing: false });
      strands(b, 'hairLines', 'hairFront', [...capStrands(k, 'swept'),
        [[CX + k.w + 8, k.temple + 20], [CX + k.wc + 18, k.ear + 70], [CX + k.wc + 22, k.nb]],
        [[CX - k.w - 8, k.temple + 20], [CX - k.wc - 18, k.ear + 70], [CX - k.wc - 22, k.nb]]], ctx, 0.3);
    } },
  'long-straight': { name: 'Long and straight', note: 'long straight hair with a centre part', hidesEars: true,
    back: (b, f, k, ctx) => add(b, 'hairBack', 'hairBack', backMass(k, k.nb + 230, 4), 'hairBack', ctx),
    front: (b, f, k, ctx) => {
      add(b, 'lockR', 'hairFront', sideLock(k, 1, k.nb + 200, 1.1), 'hair', ctx);
      add(b, 'lockL', 'hairFront', sideLock(k, -1, k.nb + 200, 1.1), 'hair', ctx);
      add(b, 'hairCap', 'hairFront', cap(k, 'center', 8), 'hair', ctx, { swing: false });
      strands(b, 'hairLines', 'hairFront', [...capStrands(k, 'center'),
        [[CX + k.w + 6, k.temple + 30], [CX + k.wc + 22, k.ear + 120], [CX + k.wc + 24, k.nb + 150]],
        [[CX - k.w - 6, k.temple + 30], [CX - k.wc - 22, k.ear + 120], [CX - k.wc - 24, k.nb + 150]]], ctx, 0.3);
    } },
  'long-curly': { name: 'Long curls', note: 'long, voluminous curls', hidesEars: true,
    back: (b, f, k, ctx) => add(b, 'hairBack', 'hairBack', backMass(k, k.nb + 200, 30, 10, 14), 'hairBack', ctx),
    front: (b, f, k, ctx) => {
      add(b, 'hairCap', 'hairFront', () => closedSpline(scallopRing([
        [CX - k.w - 16, k.temple + 30], [CX - k.w * 0.85, k.top - 4], [CX, k.top - 26], [CX + k.w * 0.85, k.top - 4],
        [CX + k.w + 16, k.temple + 30], [CX + k.w * 0.8, k.temple + 2], [CX + k.w * 0.3, k.top + k.H * 0.16], [CX - k.w * 0.3, k.top + k.H * 0.16], [CX - k.w * 0.8, k.temple + 2],
      ], 10)), 'hair', ctx, { swing: false });
      for (const sgn of [-1, 1]) {
        const lock = (p) => {
          const s = (p.swing || 0) * 18;
          const pts = [];
          const x0 = CX + sgn * (k.wc + 10);
          for (let i = 0; i < 10; i++) {
            const t = i / 9;
            const y = k.temple + 10 + t * (k.nb + 150 - k.temple);
            pts.push([x0 + sgn * (i % 2 ? 26 : 8) + sw(k, y, s), y]);
          }
          for (let i = 9; i >= 0; i--) {
            const t = i / 9;
            const y = k.temple + 20 + t * (k.nb + 140 - k.temple);
            pts.push([x0 - sgn * (i % 2 ? 22 : 34) + sw(k, y, s), y]);
          }
          return closedSpline(pts);
        };
        add(b, 'curlLock' + sgn, 'hairFront', lock, 'hair', ctx);
      }
    } },
  bun: { name: 'Top bun', note: 'hair pulled up into a round bun on top', back: (b, f, k, ctx) => {
    add(b, 'bun', 'hairBack', () => ellipse(CX + 6, k.top - 44, 58, 50), 'hairBack', ctx, { swing: false });
  }, front: (b, f, k, ctx) => {
    add(b, 'hairCap', 'hairFront', cap(k, 'slick', 2), 'hair', ctx, { swing: false });
    strands(b, 'hairLines', 'hairFront', capStrands(k, 'center'), ctx, 0.3);
  } },
  ponytail: { name: 'Ponytail', note: 'a high ponytail that swings behind', back: (b, f, k, ctx) => {
    add(b, 'tail', 'hairBack', (p) => {
      const s = (p.swing || 0) * 40;
      const T = k.top;
      return closedSpline([
        [CX + k.w * 0.55, T + 4],
        [CX + k.w + 34 + s * 0.2, T + 10],
        [CX + k.wc + 78 + s * 0.5, k.ear - 10],
        [CX + k.wc + 90 + s * 0.85, k.ear + 120],
        [CX + k.wc + 62 + s, k.nb + 60],
        [CX + k.wc + 40 + s * 0.9, k.nb + 20],
        [CX + k.wc + 40 + s * 0.6, k.ear + 70],
        [CX + k.w + 14, k.temple + 10],
        [CX + k.w * 0.7, T + 40],
      ]);
    }, 'hairBack', ctx);
    b.add({ id: 'tailTie', g: 'hairBack', d: ellipse(CX + k.w + 22, k.top + 24, 16, 20), fill: ctx.accent, stroke: ctx.line, sw: 2 });
  }, front: (b, f, k, ctx) => {
    add(b, 'hairCap', 'hairFront', cap(k, 'slick', 4), 'hair', ctx, { swing: false });
    strands(b, 'hairLines', 'hairFront', capStrands(k, 'center'), ctx, 0.3);
  } },
  braids: { name: 'Two braids', note: 'two long braids resting in front of the shoulders', front: (b, f, k, ctx) => {
    add(b, 'hairCap', 'hairFront', cap(k, 'center', 4), 'hair', ctx, { swing: false });
    for (const sgn of [-1, 1]) {
      const segs = 7;
      const fn = (p) => {
        const s = (p.swing || 0) * 16;
        const pts = [];
        const x0 = CX + sgn * (k.wc + 4);
        const y0 = k.ear;
        const y1 = k.nb + 210;
        for (let i = 0; i <= segs; i++) {
          const y = y0 + ((y1 - y0) * i) / segs;
          pts.push([x0 + sgn * (30 - 10 * (i / segs)) + sw(k, y, s), y]);
        }
        for (let i = segs; i >= 0; i--) {
          const y = y0 + ((y1 - y0) * i) / segs;
          pts.push([x0 - sgn * (26 - 9 * (i / segs)) + sw(k, y, s), y]);
        }
        return closedSpline(pts);
      };
      add(b, 'braid' + sgn, 'hairFront', fn, 'hair', ctx);
      const ch = (p) => {
        const s = (p.swing || 0) * 16;
        const out = [];
        const x0 = CX + sgn * (k.wc + 6);
        for (let i = 0; i < segs; i++) {
          const y = k.ear + 20 + ((k.nb + 190 - k.ear) * i) / segs;
          out.push(...openSpline([[x0 - 18 + sw(k, y, s), y - 10], [x0 + sw(k, y, s), y + 6], [x0 + 18 + sw(k, y, s), y - 10]]));
        }
        return out;
      };
      b.add({ id: 'braidLines' + sgn, g: 'hairFront', d: ch({}), m: [{ c: 'hair.swing', d: ch({ swing: 1 }) }, { c: 'hair.swing', d: ch({ swing: -1 }), n: true }], fill: 'none', stroke: ctx.line, sw: 2.5, op: 0.55 });
      b.add({ id: 'tie' + sgn, g: 'hairFront', d: ellipse(CX + sgn * (k.wc + 6), k.nb + 196, 14, 8), fill: ctx.accent });
    }
  } },
  'curtain-long': { name: 'Long with curtain bangs', note: 'long hair with soft curtain bangs', hidesEars: true,
    back: (b, f, k, ctx) => add(b, 'hairBack', 'hairBack', backMass(k, k.nb + 180, 10), 'hairBack', ctx),
    front: (b, f, k, ctx) => {
      add(b, 'lockR', 'hairFront', sideLock(k, 1, k.nb + 150, 1.15, 4), 'hair', ctx);
      add(b, 'lockL', 'hairFront', sideLock(k, -1, k.nb + 150, 1.15, 4), 'hair', ctx);
      add(b, 'hairCap', 'hairFront', cap(k, 'curtain', 10), 'hair', ctx, { swing: false });
      strands(b, 'hairLines', 'hairFront', capStrands(k, 'center'), ctx, 0.3);
    } },
  mohawk: { name: 'Mohawk', note: 'a tall spiky mohawk with shaved sides', front: (b, f, k, ctx) => {
    add(b, 'hairShave', 'hairFront', cap(k, 'crop', -8), 'hair', ctx, { swing: false, op: 0.32, noStroke: true });
    add(b, 'hairCap', 'hairFront', (p) => {
      const s = (p.swing || 0) * 10;
      const T = k.top;
      const pts = [[CX - 30, T + k.H * 0.15, true]];
      const tips = [[-46, 10], [-40, -38], [-24, -78], [-4, -112], [18, -96], [36, -60], [46, -14]];
      tips.forEach(([dx, dy], i) => {
        pts.push([CX + dx * 0.9 + s * (1 + dy / -110), T + dy, true]);
        if (i < tips.length - 1) pts.push([CX + (dx + tips[i + 1][0]) * 0.36 + s * 0.4, T + (dy + tips[i + 1][1]) / 2 + 26, true]);
      });
      pts.push([CX + 30, T + k.H * 0.15, true]);
      return closedMixed(pts);
    }, 'hair', ctx);
    strands(b, 'hairLines', 'hairFront', [[[CX - 6, k.top + 30], [CX - 2, k.top - 40], [CX + 4, k.top - 90]]], ctx, 0.35, 4);
  } },
  locs: { name: 'Locs', note: 'long locs gathered loosely', hidesEars: true,
    back: (b, f, k, ctx) => add(b, 'hairBack', 'hairBack', backMass(k, k.nb + 160, 20, 8), 'hairBack', ctx),
    front: (b, f, k, ctx) => {
      add(b, 'hairCap', 'hairFront', cap(k, 'center', 12), 'hair', ctx, { swing: false });
      for (let i = 0; i < 6; i++) {
        const sgn = i < 3 ? -1 : 1;
        const j = i % 3;
        const fn = (p) => {
          const s = (p.swing || 0) * 16;
          const x0 = CX + sgn * (k.wc - 8 + j * 16);
          const y0 = k.temple + 10 + j * 8;
          const y1 = k.nb + 120 - j * 20;
          const pts = [];
          for (let q = 0; q <= 4; q++) {
            const y = y0 + ((y1 - y0) * q) / 4;
            pts.push([x0 + 9 + sw(k, y, s), y]);
          }
          for (let q = 4; q >= 0; q--) {
            const y = y0 + ((y1 - y0) * q) / 4;
            pts.push([x0 - 9 + sw(k, y, s), y]);
          }
          return closedSpline(pts);
        };
        add(b, 'loc' + i, 'hairFront', fn, 'hair', ctx);
      }
    } },
};

export function hairContext(hairHex, accentHex) {
  return { line: shade(hairHex, -0.38), shine: shade(hairHex, 0.42), accent: accentHex };
}
