// A face built from two 3 by 3 sheets made in ONE image each, so every panel
// shares a pose: nine expressions and nine mouth shapes (Sep 19 2026, art by
// Kade through ChatGPT image generation, prompts in the project folder's
// FACE_EXPRESSION_ART_PROMPTS file). The earlier rig could lift a brow a
// little, blink and open one mouth; a sighted person could barely tell
// surprised from neutral. Here the whole brow-eye-cheek-mouth oval dissolves
// to the expression the character's own voice direction calls for, a mouth
// shape rides on top while they talk, and blinks use the closed-eyes panel.
//
// Only feathered local regions are ever composited over the sheet's own
// neutral panel, never whole panels, so hair, jewelry and background cannot
// shimmer. Patches are cut at region size (not canvas size) to stay small.
export const SHEET_GRID = 3;
// Panels are 414 px on a 1254 px sheet with 6 px gutters: origin = index * 420.
export const SHEET_CELL = 414 / 1254;
export const SHEET_PITCH = 420 / 1254;

export const FACE_PANELS = Object.freeze({
  neutral: 0, smile: 1, laugh: 2, surprised: 3, skeptical: 4, angry: 5, sad: 6, worried: 7, closed: 8,
});
// Mouth sheet, as drawn (checked by eye on all three characters):
// 0 closed, 1 slightly open, 2 open, 3 round and wide "oh", 4 pursed "oo",
// 5 spread with teeth "ee", 6 pressed, 7 teeth nearly together, 8 wide open.
export const MOUTH_PANELS = 9;

export function panelRect(index) {
  if (!Number.isInteger(index) || index < 0 || index >= SHEET_GRID * SHEET_GRID) throw new RangeError('panel');
  return [(index % SHEET_GRID) * SHEET_PITCH, Math.floor(index / SHEET_GRID) * SHEET_PITCH, SHEET_CELL, SHEET_CELL];
}

const SIZE = 512;
const q = (n) => Math.round(Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0)) * 12) / 12;

export function createFaceSheetRig(canvas, { id, sheet, onReady = () => {}, onFailure = () => {} }) {
  const ctx = canvas.getContext('2d');
  const faces = new Image(), mouths = new Image();
  const cache = new Map();
  let disposed = false, ready = false, last = null, signature = '';
  canvas.width = canvas.height = SIZE;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.hidden = true;
  function fail() {
    if (disposed) return;
    ready = false; canvas.hidden = true; onFailure();
  }
  // region = [x, y, w, h] inside a panel, 0..1. inner = where the feather starts.
  function patch(image, panel, region, inner, key) {
    const hit = cache.get(key);
    if (hit) return hit;
    const [px, py, pw, ph] = panelRect(panel).map((v) => v * image.naturalWidth);
    const [rx, ry, rw, rh] = region;
    const layer = document.createElement('canvas');
    layer.width = Math.max(2, Math.round(rw * SIZE));
    layer.height = Math.max(2, Math.round(rh * SIZE));
    const c = layer.getContext('2d');
    c.drawImage(image, px + rx * pw, py + ry * ph, rw * pw, rh * ph, 0, 0, layer.width, layer.height);
    c.globalCompositeOperation = 'destination-in';
    c.translate(layer.width / 2, layer.height / 2);
    c.scale(layer.width / 2, layer.height / 2);
    const fade = c.createRadialGradient(0, 0, inner, 0, 0, 1);
    fade.addColorStop(0, '#000');
    fade.addColorStop(1, 'transparent');
    c.fillStyle = fade;
    c.fillRect(-1, -1, 2, 2);
    const made = { image: layer, x: rx * SIZE, y: ry * SIZE };
    cache.set(key, made);
    return made;
  }
  const put = (p, alpha) => {
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha;
    ctx.drawImage(p.image, p.x, p.y);
  };
  function prepare() {
    if (disposed || ready || !faces.complete || !mouths.complete || !faces.naturalWidth || !mouths.naturalWidth) return;
    if (!ctx || faces.naturalWidth !== faces.naturalHeight || mouths.naturalWidth !== mouths.naturalHeight) return fail();
    ready = true;
    onReady();
    if (last) render(last);
  }
  function render(frame) {
    last = frame;
    const show = ready && !disposed && frame.active && frame.characterId === id;
    canvas.hidden = !show;
    if (!show) { signature = ''; return; }
    const face = frame.face || { from: 'neutral', to: 'neutral', blend: 1 };
    const from = FACE_PANELS[face.from] ?? 0, to = FACE_PANELS[face.to] ?? 0;
    const blend = q(face.blend), blink = q(frame.blink);
    const viseme = Number.isInteger(frame.viseme) && frame.viseme > 0 && frame.viseme < MOUTH_PANELS ? frame.viseme : 0;
    const next = `${from}/${to}/${blend}/${viseme}/${blink}`;
    if (next !== signature) {
      const [nx, ny, nw, nh] = panelRect(0).map((v) => v * faces.naturalWidth);
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.drawImage(faces, nx, ny, nw, nh, 0, 0, SIZE, SIZE);
      const facePatch = (panel) => patch(faces, panel, sheet.face, 0.72, 'f' + panel);
      // "from" at full strength then "to" at the blend gives a true dissolve.
      if (from !== 0 && blend < 1) put(facePatch(from), 1);
      if (to !== 0) put(facePatch(to), from === to ? 1 : blend);
      else if (from !== 0 && blend < 1) put(facePatch(0), blend);
      // A laugh keeps its own open mouth; every other face talks with shapes.
      if (viseme && !(to === FACE_PANELS.laugh && blend > 0.5)) put(patch(mouths, viseme, sheet.mouth, 0.5, 'm' + viseme), 1);
      if (blink > 0) put(patch(faces, FACE_PANELS.closed, sheet.eyes, 0.6, 'e'), blink);
      ctx.globalAlpha = 1;
      signature = next;
    }
    canvas.style.transform = `rotate(${Math.max(-1.4, Math.min(1.4, frame.tilt || 0))}deg) translateY(${Math.max(-1.8, Math.min(1.8, frame.nod || 0))}px)`;
  }
  faces.onload = mouths.onload = prepare;
  faces.onerror = mouths.onerror = fail;
  faces.src = sheet.expressions;
  mouths.src = sheet.mouths;
  return {
    render,
    dispose() {
      disposed = true;
      faces.onload = mouths.onload = faces.onerror = mouths.onerror = null;
      canvas.hidden = true;
      cache.clear();
    },
  };
}
