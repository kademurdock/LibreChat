// Outfits: what the puppet wears on its torso. Each outfit draws in the `top` layer
// (after the neck and chest skin, before the head) and may also use `behind`
// (e.g. a hood behind the head) or `neckwear`.
import { closedMixed, openSpline, closedSpline, shade, mix } from './geom.mjs';

// Torso silhouette with a custom neckline. `neckline` is three or more points from the
// right shoulder side of the neck, through the lowest point, to the left side.
export function torsoRing(ctx, neckline) {
  const { f, S, CX } = ctx;
  const nb = f.neckBase;
  const n = f.W * 0.5;
  const right = [
    [CX + n * 1.35, nb + 6],
    [CX + S * 0.62, nb + 24],
    [CX + S - 20, nb + 52],
    [CX + S + 6, nb + 120],
    [CX + S + 16, 1060, true],
  ];
  const left = right.slice().reverse().map(([x, y, c]) => [2 * CX - x, y, c]);
  return [neckline[0], ...right, [CX - S - 16, 1060, true], ...left.slice(1), ...neckline.slice(1).reverse().slice(0, 1), ...neckline.slice(1, -1).reverse()];
}

// The ring above is fiddly to reason about; this simpler helper is what outfits use.
export function bodyShape(ctx, neckline) {
  const { f, S, CX } = ctx;
  const nb = f.neckBase;
  const n = f.W * 0.5;
  const right = [
    [CX + n * 1.35, nb + 6],
    [CX + S * 0.62, nb + 24],
    [CX + S - 20, nb + 52],
    [CX + S + 6, nb + 120],
    [CX + S + 16, 1060, true],
  ];
  const left = [
    [CX - S - 16, 1060, true],
    [CX - S - 6, nb + 120],
    [CX - S + 20, nb + 52],
    [CX - S * 0.62, nb + 24],
    [CX - n * 1.35, nb + 6],
  ];
  // neckline runs right -> left; the ring goes neckline-right, right side, bottom,
  // left side, neckline-left, then back along the neckline to close.
  const nl = neckline;
  return closedMixed([nl[0], ...right, ...left, nl[nl.length - 1], ...nl.slice(1, -1).reverse()]);
}

export function clothGradient(ctx, id, hex) {
  const { b, CX, f } = ctx;
  b.grad(id, {
    kind: 'linear', start: [CX - 220, f.neckBase], end: [CX + 260, f.neckBase + 320],
    stops: [{ at: 0, color: shade(hex, 0.12) }, { at: 0.5, color: hex }, { at: 1, color: shade(hex, -0.22) }],
  });
  return id;
}

function crew(ctx) {
  const { f, CX } = ctx;
  const n = f.W * 0.5;
  const nb = f.neckBase;
  return [[CX + n * 0.95, nb - 8], [CX + n * 0.5, nb + 26], [CX, nb + 36], [CX - n * 0.5, nb + 26], [CX - n * 0.95, nb - 8]];
}

function vneck(ctx, depth = 95) {
  const { f, CX } = ctx;
  const n = f.W * 0.5;
  const nb = f.neckBase;
  return [[CX + n * 0.9, nb - 6], [CX + n * 0.42, nb + depth * 0.5], [CX, nb + depth, true], [CX - n * 0.42, nb + depth * 0.5], [CX - n * 0.9, nb - 6]];
}

export const OUTFITS = {
  'crew-tee': {
    name: 'Crew-neck T-shirt', note: 'a crew-neck T-shirt',
    top(ctx) {
      const { b, colors } = ctx;
      const g = clothGradient(ctx, 'cloth', colors.cloth);
      const nl = crew(ctx);
      b.add({ id: 'shirt', g: 'body', d: bodyShape(ctx, nl), fill: g, stroke: shade(colors.cloth, -0.4), sw: 3 });
      b.add({ id: 'collar', g: 'body', d: openSpline(nl), fill: 'none', stroke: shade(colors.cloth, -0.18), sw: 9 });
      b.add({ id: 'collarLine', g: 'body', d: openSpline(nl), fill: 'none', stroke: shade(colors.cloth, -0.45), sw: 2.5 });
    },
  },
  'v-neck': {
    name: 'V-neck T-shirt', note: 'a V-neck T-shirt',
    top(ctx) {
      const { b, colors } = ctx;
      const g = clothGradient(ctx, 'cloth', colors.cloth);
      const nl = vneck(ctx);
      b.add({ id: 'shirt', g: 'body', d: bodyShape(ctx, nl), fill: g, stroke: shade(colors.cloth, -0.4), sw: 3 });
      b.add({ id: 'collar', g: 'body', d: openSpline(nl), fill: 'none', stroke: shade(colors.cloth, -0.18), sw: 8 });
      b.add({ id: 'collarLine', g: 'body', d: openSpline(nl), fill: 'none', stroke: shade(colors.cloth, -0.45), sw: 2.5 });
    },
  },
};

export { crew, vneck, closedSpline, mix };
