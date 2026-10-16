// Recipe layer: normalize (repair any input), random bodies, plain-words descriptions and
// the catalog that drives every editor. Pure functions, deterministic.
import {
  compileScene, defaultRecipe, RECIPE_SCHEMA, HEAD_SHAPES, EYE_SHAPES, MOUTH_SHAPES, BROW_SHAPES, NOSE_SHAPES,
  HAIR_STYLES, OUTFITS, ACCESSORIES, FACIAL_HAIR, FACE_MARKS,
} from './kit.mjs';
import { SLOTS } from './accessories.mjs';
import { SKIN, HAIR, EYES, CLOTH, LIPS, BACKDROPS } from './palette.mjs';
import { seeded } from './geom.mjs';

export const PATTERNS = {
  solid: { name: 'Solid', note: '' },
  stripes: { name: 'Stripes', note: 'striped' },
  plaid: { name: 'Plaid', note: 'plaid' },
  'polka-dots': { name: 'Polka dots', note: 'polka-dot' },
  pinstripes: { name: 'Pinstripes', note: 'pinstriped' },
  floral: { name: 'Floral', note: 'flowered' },
};
export const BUILDS = {
  slim: { name: 'Slim', note: 'slim' },
  average: { name: 'Average', note: 'average' },
  broad: { name: 'Broad', note: 'broad-shouldered' },
  round: { name: 'Round', note: 'round and soft' },
};
export const EAR_SHAPES = {
  round: { name: 'Round', note: 'rounded ears' },
  pointed: { name: 'Pointed', note: 'pointed elf ears' },
  big: { name: 'Big', note: 'big ears' },
  hidden: { name: 'Hidden', note: '' },
};
export const LASHES = {
  none: { name: 'Light', note: 'light lashes' },
  soft: { name: 'Soft', note: 'soft lashes' },
  full: { name: 'Full', note: 'full lashes' },
  liner: { name: 'Winged liner', note: 'winged eyeliner' },
};
export const ENERGY = {
  calm: { name: 'Calm', note: 'calm, unhurried' },
  steady: { name: 'Steady', note: 'easygoing' },
  lively: { name: 'Lively', note: 'lively, animated' },
};
export const BLINKS = {
  normal: { name: 'Normal', note: '' },
  slow: { name: 'Slow and sleepy', note: 'slow blinks' },
  quick: { name: 'Quick', note: 'quick blinks' },
};

const pick = (reg, id, fallback) => (Object.hasOwn(reg, id) ? id : fallback);
const pickList = (list, id, fallback) => (list.some((c) => c.id === id) ? id : fallback);
const unit = (v, d = 0.5) => (Number.isFinite(+v) ? Math.max(0, Math.min(1, +v)) : d);

// Repair any input into a valid recipe. Unknown ids fall back to defaults; numbers clamp.
export function normalizeRecipe(input) {
  const d = defaultRecipe();
  const r = input && typeof input === 'object' ? input : {};
  const g = (k) => (r[k] && typeof r[k] === 'object' ? r[k] : {});
  const out = {
    schema: RECIPE_SCHEMA,
    head: { shape: pick(HEAD_SHAPES, g('head').shape, d.head.shape), width: unit(g('head').width), length: unit(g('head').length) },
    skin: { tone: pickList(SKIN, g('skin').tone, d.skin.tone), blush: unit(g('skin').blush, d.skin.blush) },
    eyes: {
      shape: pick(EYE_SHAPES, g('eyes').shape, d.eyes.shape), size: unit(g('eyes').size), spacing: unit(g('eyes').spacing),
      color: pickList(EYES, g('eyes').color, d.eyes.color), lashes: pick(LASHES, g('eyes').lashes, d.eyes.lashes),
    },
    brows: { shape: pick(BROW_SHAPES, g('brows').shape, d.brows.shape), thickness: unit(g('brows').thickness), color: g('brows').color && HAIR.some((c) => c.id === g('brows').color) ? g('brows').color : 'auto' },
    nose: { shape: pick(NOSE_SHAPES, g('nose').shape, d.nose.shape), size: unit(g('nose').size) },
    mouth: { shape: pick(MOUTH_SHAPES, g('mouth').shape, d.mouth.shape), width: unit(g('mouth').width), fullness: unit(g('mouth').fullness), color: pickList(LIPS, g('mouth').color, 'natural') },
    ears: { shape: pick(EAR_SHAPES, g('ears').shape, d.ears.shape) },
    hair: { style: pick(HAIR_STYLES, g('hair').style, d.hair.style), color: pickList(HAIR, g('hair').color, d.hair.color) },
    facialHair: { style: pick(FACIAL_HAIR, g('facialHair').style, 'none'), color: g('facialHair').color && HAIR.some((c) => c.id === g('facialHair').color) ? g('facialHair').color : 'auto' },
    marks: { style: pick(FACE_MARKS, g('marks').style, 'none') },
    body: { build: pick(BUILDS, g('body').build, d.body.build) },
    outfit: {
      top: pick(OUTFITS, g('outfit').top, d.outfit.top), color: pickList(CLOTH, g('outfit').color, d.outfit.color),
      accent: pickList(CLOTH, g('outfit').accent, d.outfit.accent), pattern: pick(PATTERNS, g('outfit').pattern, 'solid'),
    },
    accessories: [],
    motion: { energy: pick(ENERGY, g('motion').energy, 'steady'), expressiveness: unit(g('motion').expressiveness, 0.6), blink: pick(BLINKS, g('motion').blink, 'normal') },
    backdrop: pickList(BACKDROPS, r.backdrop, d.backdrop),
  };
  const bySlot = new Map();
  for (const id of Array.isArray(r.accessories) ? r.accessories.slice(0, 16) : []) {
    const a = ACCESSORIES[id];
    if (a) bySlot.set(a.slot || id, id);
  }
  out.accessories = [...bySlot.values()].slice(0, 8);
  return out;
}

const HUMAN_SKIN = SKIN.filter((c) => !c.fantasy).map((c) => c.id);
const NATURAL_HAIR = HAIR.filter((c) => !c.fantasy).map((c) => c.id);
const NATURAL_EYES = EYES.filter((c) => !c.fantasy).map((c) => c.id);

export function randomRecipe(seed = 1, { fantasy = false } = {}) {
  const rnd = seeded('kade-puppet-' + seed);
  const one = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
  const keys = (o) => Object.keys(o).filter((k) => k !== 'none');
  const wild = fantasy || rnd() < 0.12;
  const r = {
    head: { shape: one(Object.keys(HEAD_SHAPES)), width: 0.25 + rnd() * 0.5, length: 0.25 + rnd() * 0.5 },
    skin: { tone: wild && rnd() < 0.5 ? one(SKIN.filter((c) => c.fantasy).map((c) => c.id)) : one(HUMAN_SKIN), blush: rnd() * 0.8 },
    eyes: { shape: one(Object.keys(EYE_SHAPES).filter((k) => k !== 'button' || wild)), size: rnd(), spacing: 0.3 + rnd() * 0.4, color: wild && rnd() < 0.4 ? one(EYES.map((c) => c.id)) : one(NATURAL_EYES), lashes: one(Object.keys(LASHES)) },
    brows: { shape: one(Object.keys(BROW_SHAPES)), thickness: rnd() },
    nose: { shape: one(Object.keys(NOSE_SHAPES)), size: rnd() },
    mouth: { shape: one(Object.keys(MOUTH_SHAPES)), width: rnd(), fullness: rnd(), color: rnd() < 0.7 ? 'natural' : one(LIPS.map((c) => c.id)) },
    ears: { shape: wild && rnd() < 0.3 ? 'pointed' : 'round' },
    hair: { style: one(Object.keys(HAIR_STYLES)), color: wild && rnd() < 0.5 ? one(HAIR.filter((c) => c.fantasy).map((c) => c.id)) : one(NATURAL_HAIR) },
    facialHair: { style: rnd() < 0.25 ? one(keys(FACIAL_HAIR).length ? keys(FACIAL_HAIR) : ['none']) : 'none' },
    marks: { style: rnd() < 0.2 ? one(keys(FACE_MARKS).length ? keys(FACE_MARKS) : ['none']) : 'none' },
    body: { build: one(Object.keys(BUILDS)) },
    outfit: { top: one(Object.keys(OUTFITS)), color: one(CLOTH.map((c) => c.id)), accent: one(CLOTH.map((c) => c.id)), pattern: rnd() < 0.7 ? 'solid' : one(Object.keys(PATTERNS)) },
    accessories: [],
    motion: { energy: one(Object.keys(ENERGY)), expressiveness: 0.35 + rnd() * 0.55, blink: 'normal' },
    backdrop: one(BACKDROPS.filter((b) => b.id !== 'none').map((b) => b.id)),
  };
  const accIds = Object.keys(ACCESSORIES).filter((id) => wild || !['back', 'halo', 'horns', 'animalEars'].includes(ACCESSORIES[id].slot));
  const n = Math.floor(rnd() * 3);
  for (let i = 0; i < n && accIds.length; i++) r.accessories.push(one(accIds));
  return normalizeRecipe(r);
}

// ---------- plain words ----------
const lc = (s) => String(s || '').toLowerCase();
const nameOf = (list, id) => lc((list.find((c) => c.id === id) || {}).name || id);
const article = (phrase) => (/^[aeiou]/i.test(phrase) ? 'an ' : 'a ') + phrase;
const joinList = (items) => (items.length <= 1 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]);

export function describeRecipe(input) {
  const r = normalizeRecipe(input);
  const s = [];
  const skin = SKIN.find((c) => c.id === r.skin.tone);
  const face = HEAD_SHAPES[r.head.shape];
  s.push(`${cap(article(lc(face.name)))} face with ${lc(skin.name)} skin${skin.fantasy ? '' : ''}${r.skin.blush > 0.6 ? ' and rosy cheeks' : ''}.`);
  const eyes = EYE_SHAPES[r.eyes.shape];
  const size = r.eyes.size > 0.7 ? 'big ' : r.eyes.size < 0.25 ? 'small ' : '';
  const eyePart = r.eyes.shape === 'button' ? 'shiny button eyes' : `${size}${lc(eyes.name)} ${nameOf(EYES, r.eyes.color)} eyes${r.eyes.lashes === 'liner' ? ' with winged liner' : r.eyes.lashes === 'full' ? ' with full lashes' : ''}`;
  s.push(cap(`${eyePart}, ${lc(BROW_SHAPES[r.brows.shape].note)}, ${lc(NOSE_SHAPES[r.nose.shape].note)} and ${MOUTH_SHAPES[r.mouth.shape].note.replace(/^a /, 'a ')}${r.mouth.color !== 'natural' ? ` in ${nameOf(LIPS, r.mouth.color)}` : ''}.`));
  const hair = HAIR_STYLES[r.hair.style];
  if (r.hair.style === 'bald') s.push('A smooth bald head.');
  else s.push(`Hair: ${hair.note.replace(/^(a |an )/, '')}, ${nameOf(HAIR, r.hair.color)}.`);
  if (r.facialHair.style !== 'none' && FACIAL_HAIR[r.facialHair.style]) s.push(cap(`${FACIAL_HAIR[r.facialHair.style].note || lc(FACIAL_HAIR[r.facialHair.style].name)}.`));
  if (r.marks.style !== 'none' && FACE_MARKS[r.marks.style]) s.push(cap(`${FACE_MARKS[r.marks.style].note || lc(FACE_MARKS[r.marks.style].name)}.`));
  if (r.ears.shape === 'pointed' || r.ears.shape === 'big') s.push(cap(`${EAR_SHAPES[r.ears.shape].note}.`));
  const top = OUTFITS[r.outfit.top];
  const pat = r.outfit.pattern !== 'solid' ? PATTERNS[r.outfit.pattern].note + ' ' : '';
  const wear = [`${article(`${nameOf(CLOTH, r.outfit.color)} ${pat}${lc(top.note || top.name).replace(/^(a |an )/, '')}`)}`];
  for (const id of r.accessories) {
    const a = ACCESSORIES[id];
    if (a && a.slot !== 'back' && a.slot !== 'halo') wear.push(a.note || lc(a.name));
  }
  s.push(`Wearing ${joinList(wear)}.`);
  const extras = r.accessories.map((id) => ACCESSORIES[id]).filter((a) => a && (a.slot === 'back' || a.slot === 'halo'));
  if (extras.length) s.push(cap(`${joinList(extras.map((a) => a.note || lc(a.name)))}.`));
  s.push(`${BUILDS[r.body.build].name} build; moves in ${article(ENERGY[r.motion.energy].note)} way.`);
  return s.join(' ').replace(/\s+/g, ' ').trim();
}

function cap(t) {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ---------- catalog for editors ----------
const opts = (reg) => Object.entries(reg).map(([id, v]) => ({ id, name: v.name, note: v.note || '' }));
const colors = (list) => list.map((c) => ({ id: c.id, name: c.name, hex: c.hex || null, fantasy: !!c.fantasy }));

export function buildCatalog() {
  const accBySlot = {};
  for (const [id, a] of Object.entries(ACCESSORIES)) (accBySlot[a.slot || 'other'] ||= []).push({ id, name: a.name, note: a.note || '' });
  return {
    schema: 1,
    sections: [
      { id: 'face', name: 'Face', controls: [
        { path: 'head.shape', kind: 'choice', name: 'Face shape', options: opts(HEAD_SHAPES) },
        { path: 'head.width', kind: 'slider', name: 'Face width', ends: ['Narrow', 'Wide'] },
        { path: 'head.length', kind: 'slider', name: 'Face length', ends: ['Short', 'Long'] },
        { path: 'skin.tone', kind: 'color', name: 'Skin', options: colors(SKIN) },
        { path: 'skin.blush', kind: 'slider', name: 'Rosy cheeks', ends: ['None', 'Very rosy'] },
        { path: 'marks.style', kind: 'choice', name: 'Freckles and face accents', options: opts(FACE_MARKS) },
      ] },
      { id: 'eyes', name: 'Eyes and brows', controls: [
        { path: 'eyes.shape', kind: 'choice', name: 'Eye shape', options: opts(EYE_SHAPES) },
        { path: 'eyes.color', kind: 'color', name: 'Eye colour', options: colors(EYES) },
        { path: 'eyes.size', kind: 'slider', name: 'Eye size', ends: ['Small', 'Big'] },
        { path: 'eyes.spacing', kind: 'slider', name: 'Eye spacing', ends: ['Close', 'Wide apart'] },
        { path: 'eyes.lashes', kind: 'choice', name: 'Lashes', options: opts(LASHES) },
        { path: 'brows.shape', kind: 'choice', name: 'Brow shape', options: opts(BROW_SHAPES) },
        { path: 'brows.thickness', kind: 'slider', name: 'Brow thickness', ends: ['Thin', 'Thick'] },
      ] },
      { id: 'nose-mouth', name: 'Nose and mouth', controls: [
        { path: 'nose.shape', kind: 'choice', name: 'Nose', options: opts(NOSE_SHAPES) },
        { path: 'nose.size', kind: 'slider', name: 'Nose size', ends: ['Small', 'Large'] },
        { path: 'mouth.shape', kind: 'choice', name: 'Lips', options: opts(MOUTH_SHAPES) },
        { path: 'mouth.width', kind: 'slider', name: 'Mouth width', ends: ['Narrow', 'Wide'] },
        { path: 'mouth.fullness', kind: 'slider', name: 'Lip fullness', ends: ['Thin', 'Full'] },
        { path: 'mouth.color', kind: 'color', name: 'Lip colour', options: colors(LIPS) },
        { path: 'facialHair.style', kind: 'choice', name: 'Facial hair', options: opts(FACIAL_HAIR) },
        { path: 'facialHair.color', kind: 'color', name: 'Facial hair colour', options: [{ id: 'auto', name: 'Same as hair', hex: null }, ...colors(HAIR)] },
      ] },
      { id: 'hair', name: 'Hair and ears', controls: [
        { path: 'hair.style', kind: 'choice', name: 'Hairstyle', options: opts(HAIR_STYLES) },
        { path: 'hair.color', kind: 'color', name: 'Hair colour', options: colors(HAIR) },
        { path: 'brows.color', kind: 'color', name: 'Brow colour', options: [{ id: 'auto', name: 'Match the hair', hex: null }, ...colors(HAIR)] },
        { path: 'ears.shape', kind: 'choice', name: 'Ears', options: opts(EAR_SHAPES) },
      ] },
      { id: 'clothes', name: 'Body and clothes', controls: [
        { path: 'body.build', kind: 'choice', name: 'Build', options: opts(BUILDS) },
        { path: 'outfit.top', kind: 'choice', name: 'Top', options: opts(OUTFITS) },
        { path: 'outfit.color', kind: 'color', name: 'Main colour', options: colors(CLOTH) },
        { path: 'outfit.accent', kind: 'color', name: 'Accent colour', options: colors(CLOTH) },
        { path: 'outfit.pattern', kind: 'choice', name: 'Pattern', options: opts(PATTERNS) },
      ] },
      { id: 'extras', name: 'Accessories and extras', controls: Object.entries(SLOTS).map(([slot, name]) => ({
        path: 'accessories', slot, kind: 'accessory', name, options: [{ id: '', name: 'None', note: '' }, ...(accBySlot[slot] || [])],
      })).filter((c) => c.options.length > 1) },
      { id: 'motion', name: 'Movement and backdrop', controls: [
        { path: 'motion.energy', kind: 'choice', name: 'Energy', options: opts(ENERGY) },
        { path: 'motion.expressiveness', kind: 'slider', name: 'Expressiveness', ends: ['Subtle', 'Big feelings'] },
        { path: 'motion.blink', kind: 'choice', name: 'Blinking', options: opts(BLINKS) },
        { path: 'backdrop', kind: 'choice', name: 'Backdrop', options: BACKDROPS.map((b) => ({ id: b.id, name: b.name, note: '' })) },
      ] },
    ],
  };
}

// Scene for clients: compiled geometry plus motion options and the description.
export function buildScene(input) {
  const recipe = normalizeRecipe(input);
  const scene = compileScene(recipe);
  scene.motion = { energy: recipe.motion.energy, expressiveness: recipe.motion.expressiveness, blink: recipe.motion.blink, baseSmile: 0.12 };
  scene.description = describeRecipe(recipe);
  return { recipe, scene };
}
