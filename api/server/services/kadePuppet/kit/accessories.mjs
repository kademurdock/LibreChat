// Accessories. Each has a `slot` (one item per slot) and draws in one or more layers:
// behind, behindHead, top, neckwear, earwear, skin, facialHair, eyewear, headwear.
import { ellipse, openSpline, closedSpline, shade } from './geom.mjs';
import { ITEMS as EYEWEAR } from './acc-eyewear.mjs';
import { ITEMS as HEADWEAR } from './acc-headwear.mjs';
import { ITEMS as JEWELRY } from './acc-jewelry.mjs';
import { ITEMS as FANTASY } from './acc-fantasy.mjs';

export const SLOTS = {
  eyewear: 'Glasses',
  earwear: 'Earrings',
  neckwear: 'Neckwear',
  headwear: 'Hat or headpiece',
  halo: 'Halo',
  back: 'Wings or back piece',
  horns: 'Horns or antennae',
  animalEars: 'Animal ears',
  face: 'Face accent',
};

export const ACCESSORIES = {
  'round-glasses': {
    name: 'Round glasses', slot: 'eyewear', note: 'round wire-rimmed glasses',
    eyewear(ctx) {
      const { b, f, CX } = ctx;
      const r = 44;
      const frame = '#3A2A22';
      for (const side of [-1, 1]) {
        const cx = CX + side * f.eyeDX;
        b.add({ id: 'lens' + side, g: 'face', d: ellipse(cx, f.eyeY + 2, r, r), fill: '#DDEBF5', op: 0.14, stroke: frame, sw: 4.5 });
      }
      b.add({ id: 'bridgeGlasses', g: 'face', d: openSpline([[CX - f.eyeDX + r, f.eyeY - 4], [CX, f.eyeY - 12], [CX + f.eyeDX - r, f.eyeY - 4]]), fill: 'none', stroke: frame, sw: 4 });
      b.add({ id: 'templeL', g: 'face', d: openSpline([[CX - f.eyeDX - r, f.eyeY - 6], [CX - f.W * 0.98, f.eyeY - 12]]), fill: 'none', stroke: frame, sw: 4 });
      b.add({ id: 'templeR', g: 'face', d: openSpline([[CX + f.eyeDX + r, f.eyeY - 6], [CX + f.W * 0.98, f.eyeY - 12]]), fill: 'none', stroke: frame, sw: 4 });
    },
  },
};

Object.assign(ACCESSORIES, EYEWEAR, HEADWEAR, JEWELRY, FANTASY);
export { closedSpline, shade };
