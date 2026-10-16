// Kade puppet kit: compiles a body recipe into a morphable vector scene.
// Stage 1: head, face, neck, torso, simple outfit, a few hair styles.
import { closedSpline, openSpline, closedMixed, ellipse, taper, mix, shade, compound, lerp } from './geom.mjs';
import { SKIN, HAIR, EYES, CLOTH, LIPS, BACKDROPS, byId } from './palette.mjs';
import { HAIR_STYLES, skull, hairContext } from './hair.mjs';
import { OUTFITS } from './outfits.mjs';
import { ACCESSORIES } from './accessories.mjs';
import { FACIAL_HAIR, FACE_MARKS } from './facewear.mjs';
export { HAIR_STYLES, OUTFITS, ACCESSORIES, FACIAL_HAIR, FACE_MARKS };
export { morphable, Builder };

export const SCENE_SCHEMA = 'kade-puppet-scene/1';
export const RECIPE_SCHEMA = 1;
const CX = 500;

class Builder {
  constructor() {
    this.gradients = {};
    this.groups = [];
    this.shapes = [];
    this.ids = new Set();
  }
  grad(id, def) {
    this.gradients[id] = def;
    return id;
  }
  group(id, parent, pivot, drives = {}) {
    this.groups.push({ id, parent: parent || null, pivot, ...drives });
  }
  add(shape) {
    if (this.ids.has(shape.id)) throw new Error('duplicate shape ' + shape.id);
    this.ids.add(shape.id);
    this.shapes.push(shape);
    return shape.id;
  }
}

// Build a shape whose path comes from fn(params); morphs are fn(params with one
// channel pushed to its extreme). Guarantees identical command structure.
function morphable(fn, base, channels) {
  const d = fn(base);
  const m = [];
  for (const [c, patch, neg] of channels) {
    const t = fn({ ...base, ...patch });
    if (t.length !== d.length) throw new Error('morph structure mismatch on ' + c);
    m.push(neg ? { c, d: t, n: true } : { c, d: t });
  }
  return { d, m };
}

// ---------------- head ----------------
export const HEAD_SHAPES = {
  oval: { name: 'Oval', crown: 0.95, cheek: 1.0, jaw: 0.8, chinW: 0.42, len: 1.0, note: 'a balanced oval face' },
  round: { name: 'Round', crown: 1.0, cheek: 1.06, jaw: 0.92, chinW: 0.6, len: 0.95, note: 'a soft round face with full cheeks' },
  square: { name: 'Square', crown: 0.97, cheek: 1.0, jaw: 0.98, chinW: 0.66, len: 0.98, note: 'a strong square jaw' },
  heart: { name: 'Heart', crown: 1.02, cheek: 1.0, jaw: 0.72, chinW: 0.26, len: 1.0, note: 'a wide forehead and a narrow pointed chin' },
  long: { name: 'Long', crown: 0.9, cheek: 0.93, jaw: 0.8, chinW: 0.42, len: 1.1, note: 'a long, slender face' },
  pear: { name: 'Pear', crown: 0.88, cheek: 1.0, jaw: 1.02, chinW: 0.62, len: 1.0, note: 'a narrow forehead and a wide jaw' },
  diamond: { name: 'Diamond', crown: 0.86, cheek: 1.05, jaw: 0.76, chinW: 0.3, len: 1.02, note: 'high wide cheekbones and a narrow chin' },
};

function frame(r) {
  const hs = HEAD_SHAPES[r.head.shape] || HEAD_SHAPES.oval;
  const wScale = 0.9 + 0.2 * r.head.width;
  const lScale = (0.93 + 0.14 * r.head.length) * hs.len;
  const W = 168 * wScale;
  const cy = 372;
  const top = cy - 200 * lScale;
  const chin = cy + 205 * lScale;
  const eyeY = cy + 22 * lScale;
  const span = chin - eyeY;
  return {
    hs, W, cy, top, chin, lScale,
    eyeY,
    eyeDX: W * (0.36 + 0.1 * r.eyes.spacing),
    browY: eyeY - 46 * lScale,
    noseY: eyeY + span * 0.43,
    mouthY: eyeY + span * 0.68,
    earY: cy + 22 * lScale,
    jawY: cy + (chin - cy) * 0.66,
    neckBase: chin + 74,
  };
}

function headPoints(f, p) {
  const { W, cy, top, chin, hs } = f;
  const H = chin - top;
  const turn = p.turn || 0;
  const jaw = p.jaw || 0;
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

// ---------------- eyes ----------------
export const EYE_SHAPES = {
  round: { name: 'Round', h: 0.8, outer: 0, peak: 0, lid: 0, note: 'big round eyes' },
  almond: { name: 'Almond', h: 0.62, outer: -0.12, peak: -0.12, lid: 0, note: 'almond-shaped eyes' },
  doe: { name: 'Doe', h: 0.9, outer: 0.05, peak: 0, lid: 0, size: 1.12, note: 'large doe eyes' },
  hooded: { name: 'Hooded', h: 0.66, outer: 0, peak: 0, lid: 0.28, note: 'hooded, heavy-lidded eyes' },
  upturned: { name: 'Upturned', h: 0.62, outer: -0.3, peak: 0.08, lid: 0, note: 'upturned cat-like eyes' },
  downturned: { name: 'Downturned', h: 0.66, outer: 0.2, peak: -0.06, lid: 0.08, note: 'gentle downturned eyes' },
  narrow: { name: 'Narrow', h: 0.46, outer: -0.06, peak: 0, lid: 0.05, note: 'narrow, smiling eyes' },
  button: { name: 'Button', h: 1, outer: 0, peak: 0, lid: 0, cartoon: true, note: 'simple shiny button eyes, like a plush toy' },
};

function eyePoints(cx, cy, w, h, side, es, p) {
  // side = +1 for the eye on the viewer's right (outer corner at +x).
  const blink = p.blink || 0;
  const squint = p.squint || 0;
  const wide = p.wide || 0;
  const ox = cx + side * w * 0.5;
  const ix = cx - side * w * 0.5;
  const oy = cy + es.outer * h;
  const iy = cy + 0.04 * h;
  const lidDrop = es.lid * h;
  const up = [
    [cx + side * w * 0.3, cy - h * 0.44 + lidDrop * 0.8 - wide * h * 0.16],
    [cx + side * w * 0.02, cy - h * (0.56 + es.peak * 0.4) + lidDrop - wide * h * 0.2],
    [cx - side * w * 0.27, cy - h * (0.47 - es.peak) + lidDrop * 0.7 - wide * h * 0.14],
  ];
  const low = [
    [cx - side * w * 0.26, cy + h * 0.35 - squint * h * 0.22 + wide * h * 0.04],
    [cx + side * w * 0.02, cy + h * 0.44 - squint * h * 0.32 + wide * h * 0.06],
    [cx + side * w * 0.28, cy + h * 0.36 + es.outer * h * 0.4 - squint * h * 0.26 + wide * h * 0.04],
  ];
  // closed line just under the middle, curving down
  const closedY = (x) => {
    const t = (x - ix) / (ox - ix);
    return lerp(iy, oy, t) + h * 0.2 * Math.sin(Math.PI * t) + h * 0.06;
  };
  const upB = up.map(([x, y]) => [x, lerp(y, closedY(x) - 0.8, blink)]);
  const lowB = low.map(([x, y]) => [x, lerp(y, Math.max(closedY(x) + 0.8, y - (y - closedY(x)) * 0.85), blink)]);
  return [[ox, oy, true], ...upB, [ix, iy, true], ...lowB];
}

// ---------------- mouth ----------------
export const MOUTH_SHAPES = {
  natural: { name: 'Natural', w: 1, upper: 1, lower: 1, bow: 1, note: 'natural, medium lips' },
  full: { name: 'Full', w: 1.02, upper: 1.35, lower: 1.4, bow: 1.1, note: 'full lips' },
  thin: { name: 'Thin', w: 0.98, upper: 0.55, lower: 0.65, bow: 0.6, note: 'thin lips' },
  wide: { name: 'Wide', w: 1.22, upper: 0.95, lower: 1.0, bow: 0.9, note: 'a wide, generous mouth' },
  small: { name: 'Small', w: 0.78, upper: 1.0, lower: 1.05, bow: 1.15, note: 'a small, neat mouth' },
  heart: { name: 'Heart', w: 0.9, upper: 1.2, lower: 1.15, bow: 1.5, note: 'heart-shaped lips with a strong bow' },
};

function mouthGeom(x0, y0, mw, ms, fullness, p) {
  const open = p.open || 0;
  const wide = p.wide || 0;
  const round = p.round || 0;
  const smile = p.smile || 0;
  const press = p.press || 0;
  const hw = (mw / 2) * (1 + 0.2 * wide - 0.36 * round + 0.07 * Math.max(0, smile));
  const cornerY = y0 - smile * 12 + open * 3;
  const gapTop = open * mw * 0.06 + round * mw * 0.05;
  const gapBot = open * mw * 0.44 + round * mw * 0.13;
  const tU = mw * 0.105 * ms.upper * fullness * (1 - 0.55 * press);
  const tL = mw * 0.15 * ms.lower * fullness * (1 - 0.5 * press);
  const sideU = y0 - gapTop * 0.8 - smile * 4;
  const midU = y0 - gapTop;
  const sideL = y0 + gapBot * 0.78 - smile * 5;
  const midL = y0 + gapBot;
  const CL = [x0 - hw, cornerY];
  const CR = [x0 + hw, cornerY];
  const upperEdge = [[x0 - hw * 0.52, sideU], [x0, midU], [x0 + hw * 0.52, sideU]];
  const lowerEdge = [[x0 + hw * 0.52, sideL], [x0, midL], [x0 - hw * 0.52, sideL]];
  const upperOuter = [
    [x0 - hw * 0.56, sideU - tU * 0.78],
    [x0 - hw * 0.2, midU - tU * (1.05 + 0.12 * ms.bow)],
    [x0, midU - tU * (0.95 - 0.25 * ms.bow)],
    [x0 + hw * 0.2, midU - tU * (1.05 + 0.12 * ms.bow)],
    [x0 + hw * 0.56, sideU - tU * 0.78],
  ];
  const lowerOuter = [
    [x0 + hw * 0.55, sideL + tL * 0.8],
    [x0, midL + tL],
    [x0 - hw * 0.55, sideL + tL * 0.8],
  ];
  return { CL, CR, upperEdge, lowerEdge, upperOuter, lowerOuter, hw, mw, midU, midL, gapBot, x0 };
}

// ---------------- recipe ----------------
export function defaultRecipe() {
  return {
    schema: RECIPE_SCHEMA,
    head: { shape: 'oval', width: 0.5, length: 0.5 },
    skin: { tone: 'warm-beige', blush: 0.45, freckles: 0 },
    eyes: { shape: 'round', size: 0.5, spacing: 0.5, color: 'brown', lashes: 'soft' },
    brows: { shape: 'soft-arch', thickness: 0.5 },
    nose: { shape: 'button', size: 0.5 },
    mouth: { shape: 'natural', width: 0.5, fullness: 0.5, color: 'natural' },
    ears: { shape: 'round' },
    hair: { style: 'shoulder-wavy', color: 'chestnut' },
    facialHair: { style: 'none', color: 'auto' },
    marks: { style: 'none' },
    body: { build: 'average' },
    outfit: { top: 'crew-tee', color: 'denim', accent: 'cream', pattern: 'solid' },
    accessories: [],
    motion: { energy: 'steady', expressiveness: 0.6, blink: 'normal' },
    backdrop: 'dusk',
  };
}

// ---------------- compile ----------------
export function compileScene(input) {
  const r = { ...defaultRecipe(), ...input };
  const f = frame(r);
  const b = new Builder();
  const skin = byId(SKIN, r.skin.tone, 3).hex;
  const skinDark = shade(skin, -0.22);
  const skinLine = shade(skin, -0.42);
  const hairHex = byId(HAIR, r.hair.color, 3).hex;
  const irisHex = byId(EYES, r.eyes.color, 1).hex;
  const cloth = byId(CLOTH, r.outfit.color, 6).hex;
  const lipBase = (byId(LIPS, r.mouth.color, 0).hex) || mix(skin, '#C0505E', 0.42);

  // groups
  b.group('root', null, [CX, 1000]);
  b.group('body', 'root', [CX, 1000], { sy: [['body.breath', 0.011]], ty: [['body.shrug', -9]] });
  b.group('head', 'root', [CX, f.chin + 40], {
    r: [['head.roll', 0.13]],
    tx: [['head.yaw', 10]],
    ty: [['head.pitch', 9], ['body.breath', -3.2], ['body.shrug', -6]],
  });
  b.group('hairBack', 'head', [CX, f.top], { tx: [['head.yaw', -9]], ty: [['head.pitch', -5]] });
  b.group('ears', 'head', [CX, f.earY], { tx: [['head.yaw', -11]] });
  b.group('face', 'head', [CX, f.eyeY], { tx: [['head.yaw', 21]], ty: [['head.pitch', 15]] });
  b.group('nose', 'face', [CX, f.noseY], { tx: [['head.yaw', 9]], ty: [['head.pitch', 4]] });
  b.group('irisL', 'face', [CX - f.eyeDX, f.eyeY], { tx: [['gaze.x', 13]], ty: [['gaze.y', 8]] });
  b.group('irisR', 'face', [CX + f.eyeDX, f.eyeY], { tx: [['gaze.x', 13]], ty: [['gaze.y', 8]] });
  b.group('hairFront', 'head', [CX, f.top], { tx: [['head.yaw', 13]], ty: [['head.pitch', 6]] });

  // gradients
  b.grad('skin', {
    kind: 'radial', center: [CX - 40, f.cy - 70], focal: [CX - 55, f.cy - 95], radius: 330,
    stops: [{ at: 0, color: shade(skin, 0.14) }, { at: 0.55, color: skin }, { at: 1, color: shade(skin, -0.16) }],
  });
  b.grad('neck', {
    kind: 'linear', start: [CX, f.jawY], end: [CX, f.neckBase],
    stops: [{ at: 0, color: shade(skin, -0.2) }, { at: 0.45, color: shade(skin, -0.06) }, { at: 1, color: skin }],
  });
  b.grad('hair', {
    kind: 'linear', start: [CX - 160, f.top - 20], end: [CX + 170, f.chin + 120],
    stops: [{ at: 0, color: shade(hairHex, 0.22) }, { at: 0.45, color: hairHex }, { at: 1, color: shade(hairHex, -0.28) }],
  });
  b.grad('hairBack', {
    kind: 'linear', start: [CX, f.top], end: [CX, 960],
    stops: [{ at: 0, color: shade(hairHex, -0.12) }, { at: 1, color: shade(hairHex, -0.38) }],
  });
  b.grad('cloth', {
    kind: 'linear', start: [CX - 200, 760], end: [CX + 240, 1020],
    stops: [{ at: 0, color: shade(cloth, 0.12) }, { at: 0.5, color: cloth }, { at: 1, color: shade(cloth, -0.22) }],
  });
  b.grad('sclera', {
    kind: 'radial', center: [0, 0], radius: 1, stops: [{ at: 0, color: '#FFFFFF' }, { at: 1, color: '#E7DFDA' }],
  });
  b.grad('blush', {
    kind: 'radial', center: [0, 0], radius: 1, stops: [{ at: 0, color: '#F06A7A', opacity: 0.55 }, { at: 1, color: '#F06A7A', opacity: 0 }],
  });

  const hairStyle = HAIR_STYLES[r.hair.style] || HAIR_STYLES['short-crop'];
  const k = skull(f);
  const accentHex = byId(CLOTH, r.outfit.accent, 1).hex;
  const hctx = hairContext(hairHex, accentHex);
  const S = { slim: 225, average: 262, broad: 300, round: 285 }[r.body.build] || 262;
  const fh = FACIAL_HAIR[r.facialHair?.style] || null;
  const fhColor = r.facialHair?.color && r.facialHair.color !== 'auto' ? byId(HAIR, r.facialHair.color, 3).hex : hairHex;
  const ms = MOUTH_SHAPES[r.mouth.shape] || MOUTH_SHAPES.natural;
  const mw = 98 * ms.w * (0.86 + 0.28 * r.mouth.width);
  const ctx = {
    b, f, k, r, CX, S,
    colors: { skin, skinDark, skinLine, hair: hairHex, hairLine: hctx.line, iris: irisHex, cloth, accent: accentHex, lip: lipBase, facialHair: fhColor },
    hasHairOver: (part) => !!(hairStyle.covers || []).includes(part),
    hairStyle: r.hair.style,
    mouthAt: (p) => mouthGeom(CX, f.mouthY, mw, ms, 0.75 + 0.5 * r.mouth.fullness, p),
    hairShine: hctx.shine,
  };
  const outfit = OUTFITS[r.outfit.top] || OUTFITS['crew-tee'];
  const acc = (r.accessories || []).map((id) => ACCESSORIES[id]).filter(Boolean);
  const layer = (name) => {
    if (outfit && typeof outfit[name] === 'function') outfit[name](ctx);
    for (const a of acc) if (typeof a[name] === 'function') a[name](ctx);
    if (fh && typeof fh[name] === 'function') fh[name](ctx);
    const mk = FACE_MARKS[r.marks?.style];
    if (mk && typeof mk[name] === 'function') mk[name](ctx);
  };

  // ---- things behind the whole puppet (wings, capes, hoods)
  layer('behind');
  // ---- back hair
  if (hairStyle.back) hairStyle.back(b, f, k, hctx);
  layer('behindHead');

  // ---- neck + torso
  const neckW = f.W * 0.46;
  b.add({ id: 'neck', g: 'body', d: closedMixed([
    [CX - neckW, f.jawY - 10], [CX + neckW, f.jawY - 10],
    [CX + neckW * 1.04, f.neckBase - 14], [CX + neckW * 1.3, f.neckBase + 30, true], [CX - neckW * 1.3, f.neckBase + 30, true], [CX - neckW * 1.04, f.neckBase - 14],
  ]), fill: 'neck' });
  b.grad('chest', { kind: 'linear', start: [CX, f.neckBase - 10], end: [CX, f.neckBase + 160], stops: [{ at: 0, color: skin }, { at: 1, color: shade(skin, 0.05) }] });
  b.add({ id: 'chest', g: 'body', d: closedSpline([[CX - f.W * 0.62, f.neckBase + 4], [CX + f.W * 0.62, f.neckBase + 4], [CX + f.W * 0.9, f.neckBase + 120], [CX, f.neckBase + 190], [CX - f.W * 0.9, f.neckBase + 120]]), fill: 'chest' });
  layer('top');
  layer('neckwear');

  // ---- ears
  if (!hairStyle.hidesEars) {
    ear(b, f, r, 1, skin, skinDark);
    ear(b, f, r, -1, skin, skinDark);
    layer('earwear');
  }

  // ---- head
  const hp = (p) => closedSpline(headPoints(f, p));
  const head = morphable(hp, {}, [
    ['head.yaw', { turn: 1 }],
    ['head.yaw', { turn: -1 }, true],
    ['mouth.open', { jaw: 1 }],
  ]);
  b.add({ id: 'head', g: 'head', ...head, fill: 'skin', stroke: skinLine, sw: 3.2 });
  layer('skin');

  // jaw shadow onto neck is part of neck gradient; cheek blush
  for (const side of [-1, 1]) {
    const cx = CX + side * (f.eyeDX + 18);
    const cy = f.eyeY + 62 * f.lScale;
    const bl = (p) => ellipse(cx + (p.up || 0) * side * 3, cy - (p.up || 0) * 9, 40, 26);
    const blush = morphable(bl, {}, [['cheek.raise', { up: 1 }]]);
    b.grad('blush' + side, { kind: 'radial', center: [cx, cy], radius: 42, stops: [{ at: 0, color: '#EE6F7E', opacity: 0.5 }, { at: 1, color: '#EE6F7E', opacity: 0 }] });
    b.add({ id: 'blush' + side, g: 'face', ...blush, fill: 'blush' + side, op: 0.25 + 0.6 * r.skin.blush, oc: [['mouth.smile', 0.25], ['cheek.blush', 0.6]] });
  }

  // ---- eyes
  const es = EYE_SHAPES[r.eyes.shape] || EYE_SHAPES.round;
  const ew = 74 * (0.86 + 0.28 * r.eyes.size) * (es.size || 1);
  const eh = ew * es.h;
  for (const side of [-1, 1]) {
    eye(b, f, r, side, ew, eh, es, irisHex, skin, skinLine);
  }

  // ---- brows
  for (const side of [-1, 1]) brow(b, f, r, side, ew, hairHex);

  // ---- nose
  nose(b, f, r, skin);

  // ---- mouth
  mouth(b, f, r, lipBase, skin);

  layer('facialHair');
  // ---- front hair
  if (hairStyle.front) hairStyle.front(b, f, k, hctx);
  layer('eyewear');
  layer('headwear');

  const bd = byId(BACKDROPS, r.backdrop, 0);
  return {
    schema: SCENE_SCHEMA,
    size: [1000, 1000],
    view: [130, 40, 740, 740],
    backdrop: bd.a ? { top: bd.a, bottom: bd.b } : null,
    gradients: b.gradients,
    groups: b.groups,
    shapes: b.shapes,
    rig: { eyeY: f.eyeY, eyeDX: f.eyeDX, mouthY: f.mouthY, top: f.top, chin: f.chin },
  };
}

function ear(b, f, r, side, skin, skinDark) {
  const x0 = CX + side * (f.W * f.hs.cheek - 10);
  const y0 = f.earY;
  const pointed = r.ears.shape === 'pointed';
  const big = r.ears.shape === 'big' ? 1.25 : 1;
  const pts = [
    [x0 - side * 4, y0 - 34 * big],
    [x0 + side * 20 * big, y0 - (pointed ? 70 : 40) * big],
    [x0 + side * (pointed ? 46 : 33) * big, y0 - (pointed ? 62 : 8) * big],
    [x0 + side * 24 * big, y0 + 30 * big],
    [x0 + side * 6, y0 + 44 * big],
    [x0 - side * 8, y0 + 30 * big],
  ];
  if (r.ears.shape === 'hidden') return;
  b.add({ id: 'ear' + side, g: 'ears', d: closedSpline(pts), fill: 'skin', stroke: shade(skin, -0.42), sw: 3 });
  b.add({ id: 'earIn' + side, g: 'ears', d: openSpline([[x0 + side * 4, y0 - 22 * big], [x0 + side * 20 * big, y0 - 20 * big], [x0 + side * 18 * big, y0 + 12 * big], [x0 + side * 8, y0 + 22 * big]]), fill: 'none', stroke: skinDark, sw: 4, op: 0.7 });
}

function eye(b, f, r, side, ew, eh, es, irisHex, skin, skinLine) {
  const cx = CX + side * f.eyeDX;
  const cy = f.eyeY;
  const s = side > 0 ? 'R' : 'L';
  if (es.cartoon) {
    const btn = (p) => ellipse(cx, cy + (p.blink || 0) * 2, ew * 0.26, eh * 0.3 * (1 - 0.92 * (p.blink || 0)));
    const bm = [['eye.blink', { blink: 1 }]];
    if (side > 0) bm.push(['eye.wink', { blink: 1 }]);
    b.add({ id: 'eye' + s, g: 'face', ...morphable(btn, {}, bm), fill: '#1B1418' });
    b.add({ id: 'shine' + s, g: 'face', d: ellipse(cx + 7, cy - 9, 7, 7), fill: '#FFFFFF', op: 0.95, hide: [['eye.blink', 0.6]] });
    return;
  }
  const open = (p) => closedMixed(eyePoints(cx, cy, ew, eh, side, es, p));
  const ch = [
    ['eye.blink', { blink: 1 }],
    ['eye.squint', { squint: 1 }],
    ['eye.wide', { wide: 1 }],
  ];
  if (side > 0) ch.push(['eye.wink', { blink: 1 }]);
  const opening = morphable(open, {}, ch);
  b.grad('sclera' + s, { kind: 'radial', center: [cx, cy + eh * 0.15], radius: ew * 0.62, stops: [{ at: 0, color: '#FFFFFF' }, { at: 0.7, color: '#F6F1EE' }, { at: 1, color: '#D9CFCB' }] });
  b.add({ id: 'eye' + s, g: 'face', ...opening, fill: 'sclera' + s });
  // iris + pupil + shine, clipped to the opening
  const ir = Math.min(eh * 0.5, ew * 0.31);
  const ix = cx + side * ew * 0.02;
  const iy = cy + eh * 0.04;
  b.grad('iris' + s, { kind: 'radial', center: [ix, iy], focal: [ix, iy + ir * 0.35], radius: ir, stops: [
    { at: 0, color: shade(irisHex, 0.45) }, { at: 0.55, color: irisHex }, { at: 0.86, color: shade(irisHex, -0.25) }, { at: 1, color: shade(irisHex, -0.6) } ] });
  b.add({ id: 'iris' + s, g: 'iris' + s, d: ellipse(ix, iy, ir, ir), fill: 'iris' + s, clip: 'eye' + s });
  b.add({ id: 'pupil' + s, g: 'iris' + s, d: ellipse(ix, iy, ir * 0.46, ir * 0.46), fill: '#120C0E', clip: 'eye' + s });
  // shadow under the upper lid
  const shadeFn = (p) => {
    const pts = eyePoints(cx, cy, ew, eh, side, es, p);
    const up = pts.slice(0, 5);
    const lower = up.slice(1, 4).map(([x, y]) => [x, y + eh * 0.26]).reverse();
    return closedMixed([...up, ...lower]);
  };
  b.add({ id: 'lidShade' + s, g: 'face', ...morphable(shadeFn, {}, ch), fill: shade(skin, -0.5), op: 0.22, clip: 'eye' + s });
  b.add({ id: 'shine' + s, g: 'iris' + s, d: ellipse(ix + ir * 0.32, iy - ir * 0.36, ir * 0.24, ir * 0.24), fill: '#FFFFFF', op: 0.92, clip: 'eye' + s });
  b.add({ id: 'shine2' + s, g: 'iris' + s, d: ellipse(ix - ir * 0.3, iy + ir * 0.38, ir * 0.1, ir * 0.1), fill: '#FFFFFF', op: 0.6, clip: 'eye' + s });
  // lash line along the upper edge
  const lashW = { none: 3, soft: 5.2, full: 7.5, liner: 7.5 }[r.eyes.lashes] || 5.2;
  const lash = (p) => {
    const pts = eyePoints(cx, cy, ew, eh, side, es, p);
    return openSpline([pts[0], pts[1], pts[2], pts[3], pts[4]].map(([x, y]) => [x, y]));
  };
  b.add({ id: 'lash' + s, g: 'face', ...morphable(lash, {}, ch), fill: 'none', stroke: mix(skinLine, '#140C10', 0.75), sw: lashW });
  if (r.eyes.lashes === 'full' || r.eyes.lashes === 'liner') {
    const wing = (p) => {
      const pts = eyePoints(cx, cy, ew, eh, side, es, p);
      const [ox, oy] = pts[0];
      const [ux, uy] = pts[1];
      return closedMixed([[ox - side * 6, oy - 3, true], [ox + side * 15, oy - 11 - (p.blink || 0) * -6, true], [lerp(ox, ux, 0.5), lerp(oy, uy, 0.5) + 1, true]]);
    };
    b.add({ id: 'wing' + s, g: 'face', ...morphable(wing, {}, ch), fill: '#140C10' });
  }
  // crease
  const crease = (p) => {
    const pts = eyePoints(cx, cy, ew, eh, side, es, p);
    const lift = eh * (0.3 + 0.12 * (1 - (p.blink || 0))) - es.lid * eh * 0.5;
    return openSpline([pts[1], pts[2], pts[3]].map(([x, y], i) => [x + side * (i === 0 ? -3 : 0), y - lift]));
  };
  b.add({ id: 'crease' + s, g: 'face', ...morphable(crease, {}, ch), fill: 'none', stroke: shade(skin, -0.4), sw: 2.6, op: 0.45 });
  // lower lash line, faint
  const lower = (p) => {
    const pts = eyePoints(cx, cy, ew, eh, side, es, p);
    return openSpline([pts[5], pts[6], pts[7]].map(([x, y]) => [x, y + 1.5]));
  };
  b.add({ id: 'lowLine' + s, g: 'face', ...morphable(lower, {}, ch), fill: 'none', stroke: shade(skin, -0.45), sw: 2, op: 0.35 });
}

export const BROW_SHAPES = {
  'soft-arch': { name: 'Soft arch', arch: 11, peak: 0.6, inner: 0, t: 1, note: 'softly arched brows' },
  straight: { name: 'Straight', arch: 3, peak: 0.5, inner: 0, t: 1, note: 'straight brows' },
  'high-arch': { name: 'High arch', arch: 21, peak: 0.66, inner: 2, t: 0.9, note: 'dramatic high-arched brows' },
  bushy: { name: 'Bushy', arch: 6, peak: 0.55, inner: 0, t: 1.55, note: 'thick, bushy brows' },
  thin: { name: 'Thin', arch: 12, peak: 0.6, inner: 0, t: 0.55, note: 'thin, delicate brows' },
  worried: { name: 'Worried', arch: 6, peak: 0.35, inner: -10, t: 0.95, note: 'brows that tilt up in the middle, a little worried' },
  stern: { name: 'Stern', arch: 4, peak: 0.6, inner: 9, t: 1.15, note: 'low, stern brows' },
};

function brow(b, f, r, side, ew, hairHex) {
  const bs = BROW_SHAPES[r.brows.shape] || BROW_SHAPES['soft-arch'];
  const cx = CX + side * f.eyeDX;
  const y0 = f.browY;
  const len = ew * 1.12;
  const th = 11 * (0.7 + 0.6 * r.brows.thickness) * bs.t;
  const s = side > 0 ? 'R' : 'L';
  const fn = (p) => {
    const raise = p.raise || 0;
    const lower = p.lower || 0;
    const furrow = p.furrow || 0;
    const sad = p.sad || 0;
    const center = [];
    for (let i = 0; i < 5; i++) {
      const t = i / 4; // 0 inner -> 1 outer
      const x = cx + side * (-len * 0.48 + len * t) + side * furrow * 7 * (1 - t) * -1;
      const archY = -bs.arch * Math.sin(Math.PI * Math.min(1, t / bs.peak) * 0.5) * (t <= bs.peak ? 1 : 1 - (t - bs.peak) / (1 - bs.peak) * 0.55);
      let y = y0 + archY + bs.inner * (1 - t) + t * 4;
      y -= raise * (14 - 3 * t);
      y += lower * (7 + 3 * (1 - t));
      y += furrow * 11 * (1 - t) * (1 - t);
      y -= sad * 13 * (1 - t) * (1 - t);
      y += sad * 5 * t;
      center.push([x, y]);
    }
    return taper(center, [th * 0.9, th * 1.05, th, th * 0.72, th * 0.34]);
  };
  const m = [
    ['brow.raise', { raise: 1 }],
    ['brow.raise', { lower: 1 }, true],
    ['brow.furrow', { furrow: 1 }],
    ['brow.sad', { sad: 1 }],
  ];
  if (side > 0) m.push(['brow.asym', { raise: 0.9 }]);
  const browColor = r.brows.color && r.brows.color !== 'auto' ? byId(HAIR, r.brows.color, 2).hex : shade(hairHex, -0.08);
  b.add({ id: 'brow' + s, g: 'face', ...morphable(fn, {}, m), fill: browColor, stroke: shade(browColor, -0.25), sw: 1.2 });
}

export const NOSE_SHAPES = {
  button: { name: 'Button', note: 'a small button nose' },
  soft: { name: 'Soft', note: 'a soft, rounded nose' },
  straight: { name: 'Straight', note: 'a straight nose with a defined bridge' },
  roman: { name: 'Roman', note: 'a strong roman nose with a curved bridge' },
  wide: { name: 'Broad', note: 'a broad nose with wide nostrils' },
  pointed: { name: 'Pointed', note: 'a narrow pointed nose' },
  snub: { name: 'Snub', note: 'a small upturned nose' },
};

function nose(b, f, r, skin) {
  const ns = r.nose.shape;
  const k = 0.85 + 0.35 * r.nose.size;
  const y = f.noseY;
  const line = shade(skin, -0.38);
  const wide = ns === 'wide' ? 1.3 : ns === 'pointed' ? 0.8 : 1;
  // tip highlight + shadow
  b.grad('noseTip', { kind: 'radial', center: [CX - 4, y - 8 * k], radius: 26 * k, stops: [{ at: 0, color: shade(skin, 0.3), opacity: 0.7 }, { at: 1, color: shade(skin, 0.3), opacity: 0 }] });
  b.add({ id: 'noseTip', g: 'nose', d: ellipse(CX - 4, y - 8 * k, 24 * k, 18 * k), fill: 'noseTip' });
  b.add({ id: 'noseUnder', g: 'nose', d: openSpline([[CX - 20 * k * wide, y + 2], [CX, y + 9 * k], [CX + 20 * k * wide, y + 2]]), fill: 'none', stroke: line, sw: 3.4, op: 0.55 });
  b.add({ id: 'nostrils', g: 'nose', d: compound(
    openSpline([[CX - 25 * k * wide, y - 6 * k], [CX - 23 * k * wide, y + 4], [CX - 12 * k, y + 5]]),
    openSpline([[CX + 25 * k * wide, y - 6 * k], [CX + 23 * k * wide, y + 4], [CX + 12 * k, y + 5]]),
  ), fill: 'none', stroke: line, sw: 3.6, op: 0.8 });
  if (ns === 'straight' || ns === 'roman' || ns === 'pointed') {
    const bridge = ns === 'roman'
      ? [[CX + 10, f.eyeY + 8], [CX + 16, y - 52 * k], [CX + 18, y - 22 * k], [CX + 12, y - 4]]
      : [[CX + 9, f.eyeY + 10], [CX + 12, y - 46 * k], [CX + 15, y - 20 * k], [CX + 10, y - 4]];
    b.add({ id: 'bridge', g: 'nose', d: openSpline(bridge), fill: 'none', stroke: line, sw: 3.2, op: 0.42 });
  } else if (ns === 'soft') {
    b.add({ id: 'bridge', g: 'nose', d: openSpline([[CX + 14, y - 34 * k], [CX + 18, y - 16 * k], [CX + 13, y - 3]]), fill: 'none', stroke: line, sw: 3, op: 0.38 });
  }
}

function mouth(b, f, r, lipHex, skin) {
  const ms = MOUTH_SHAPES[r.mouth.shape] || MOUTH_SHAPES.natural;
  const mw = 98 * ms.w * (0.86 + 0.28 * r.mouth.width);
  const fullness = 0.75 + 0.5 * r.mouth.fullness;
  const y0 = f.mouthY;
  const G = (p) => mouthGeom(CX, y0, mw, ms, fullness, p);
  const ch = [
    ['mouth.open', { open: 1 }],
    ['mouth.wide', { wide: 1 }],
    ['mouth.round', { round: 1 }],
    ['mouth.smile', { smile: 1 }],
    ['mouth.smile', { smile: -1 }, true],
    ['mouth.press', { press: 1 }],
  ];
  const interior = (p) => {
    const g = G(p);
    return closedMixed([[...g.CL, true], ...g.upperEdge, [...g.CR, true], ...g.lowerEdge]);
  };
  const teeth = (p) => {
    const g = G(p);
    const drop = g.mw * 0.12;
    const lowEdge = g.upperEdge.map(([x, y]) => [x, y + drop]).reverse();
    return closedMixed([[g.CL[0] + 4, g.CL[1], true], ...g.upperEdge, [g.CR[0] - 4, g.CR[1], true], ...lowEdge]);
  };
  const tongue = (p) => {
    const g = G(p);
    return ellipse(g.x0, g.midL + 2, g.hw * 0.55, g.mw * 0.13);
  };
  const upper = (p) => {
    const g = G(p);
    return closedMixed([[...g.CL, true], ...g.upperOuter, [...g.CR, true], ...g.upperEdge.slice().reverse()]);
  };
  const lower = (p) => {
    const g = G(p);
    return closedMixed([[...g.CL, true], ...g.lowerEdge.slice().reverse(), [...g.CR, true], ...g.lowerOuter]);
  };
  const seam = (p) => {
    const g = G(p);
    return openSpline([g.CL, ...g.upperEdge, g.CR]);
  };
  b.add({ id: 'mouthIn', g: 'face', ...morphable(interior, {}, ch), fill: '#4A1A22' });
  b.add({ id: 'tongue', g: 'face', ...morphable(tongue, {}, ch), fill: '#C25563', clip: 'mouthIn' });
  b.add({ id: 'teeth', g: 'face', ...morphable(teeth, {}, ch), fill: '#F7F2EA', clip: 'mouthIn' });
  b.grad('lipU', { kind: 'linear', start: [CX, y0 - 20], end: [CX, y0], stops: [{ at: 0, color: shade(lipHex, -0.05) }, { at: 1, color: shade(lipHex, -0.2) }] });
  b.grad('lipL', { kind: 'linear', start: [CX, y0], end: [CX, y0 + 26], stops: [{ at: 0, color: shade(lipHex, 0.06) }, { at: 1, color: shade(lipHex, -0.08) }] });
  b.add({ id: 'lipUpper', g: 'face', ...morphable(upper, {}, ch), fill: 'lipU', stroke: shade(lipHex, -0.3), sw: 1.4 });
  b.add({ id: 'lipLower', g: 'face', ...morphable(lower, {}, ch), fill: 'lipL', stroke: shade(lipHex, -0.3), sw: 1.4 });
  const shine = (p) => {
    const g = G(p);
    return ellipse(g.x0 - g.hw * 0.12, g.midL + g.mw * 0.07 * fullness, g.hw * 0.28, g.mw * 0.035);
  };
  b.add({ id: 'lipShine', g: 'face', ...morphable(shine, {}, ch), fill: '#FFFFFF', op: 0.22, clip: 'lipLower' });
  b.add({ id: 'seam', g: 'face', ...morphable(seam, {}, ch), fill: 'none', stroke: shade(lipHex, -0.55), sw: 2.6, op: 0.85 });
  void skin;
}

