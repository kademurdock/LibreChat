// Facial hair and face marks. Facial hair draws in the `facialHair` layer (after the
// mouth, before front hair) and must follow the jaw: build shapes with
// morphable(fn, {}, [['mouth.open', { open: 1 }], ...]) using ctx.mouthAt(p) so a beard
// opens with the mouth.
import { ellipse, shade, compound } from './geom.mjs';

export const FACIAL_HAIR = {
  none: { name: 'None', note: '' },
};

export const FACE_MARKS = {
  none: { name: 'None', note: '' },
  freckles: {
    name: 'Freckles', note: 'a dusting of freckles across the nose and cheeks',
    skin(ctx) {
      const { b, f, CX, colors } = ctx;
      const dots = [];
      const spots = [[-70, 40], [-52, 52], [-88, 58], [-34, 46], [-62, 70], [-100, 44], [34, 46], [52, 52], [70, 40], [88, 58], [62, 70], [100, 44], [-14, 38], [14, 38]];
      for (const [dx, dy] of spots) dots.push(ellipse(CX + dx, f.eyeY + dy, 3.4, 3));
      b.add({ id: 'freckles', g: 'face', d: compound(...dots), fill: shade(colors.skin, -0.35), op: 0.55 });
    },
  },
};
