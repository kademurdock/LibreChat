// A stationary portrait with registered, feathered local facial layers.
// Never swap the full generated frames: their backgrounds/head poses drift.
export const KIANA_ID = 'agent_6llV0eMu4fmIaj8f2x1Sb';
export const KIANA_PORTRAIT_FILE = 'agent-agent_6llV0eMu4fmIaj8f2x1Sb-avatar-1788871984269.png';
export const DELLA_ID = 'agent_BSOLa3eNEZyjs-7abCjMt';
export const DELLA_PORTRAIT_FILE = 'agent-agent_BSOLa3eNEZyjs-7abCjMt-avatar-1788941611099.png';
export function hasPreparedPortrait(id, url) {
  return !!preparedPortrait(id, url);
}

export function preparedPortrait(id, url) {
  try {
    const file = new URL(url, 'https://local.invalid').pathname.split('/').pop();
    if (id === KIANA_ID && file === KIANA_PORTRAIT_FILE)
      return {
        portrait: '/assets/characters/kiana/portrait.png',
        atlas: '/assets/characters/kiana/facial-source.png',
        blink: '/assets/characters/kiana/eyes-closed.png',
        expression: '/assets/characters/kiana/expression.png',
        browFeatures: [
          { kind: 'brow', from: [0.357, 0.235, 0.13, 0.066], to: [0.357, 0.235, 0.13, 0.066] },
          { kind: 'brow', from: [0.505, 0.151, 0.143, 0.086], to: [0.505, 0.151, 0.143, 0.086] },
        ],
      };
    if (id === DELLA_ID && file === DELLA_PORTRAIT_FILE)
      return {
        portrait: '/assets/characters/della/portrait.png',
        atlas: '/assets/characters/della/facial-source.png',
        blink: '/assets/characters/della/facial-source.png',
        expression: '/assets/characters/della/expression.png',
        browFeatures: [
          { kind: 'brow', from: [0.35, 0.221, 0.132, 0.073], to: [0.35, 0.221, 0.132, 0.073] },
          { kind: 'brow', from: [0.53, 0.215, 0.13, 0.071], to: [0.53, 0.215, 0.13, 0.071] },
        ],
        features: [
          { kind: 'mouth', from: [0.4, 0.462, 0.195, 0.115], to: [0.4, 0.462, 0.195, 0.115] },
        ],
        eyeFeatures: [
          { kind: 'blink', from: [0.364, 0.295, 0.117, 0.082], to: [0.364, 0.295, 0.117, 0.082] },
          { kind: 'blink', from: [0.535, 0.295, 0.11, 0.082], to: [0.535, 0.295, 0.11, 0.082] },
        ],
      };
    return null;
  } catch {
    return null;
  }
}

export function facialBlend(value) {
  if (!Number.isFinite(value)) return 0;
  const n = Math.max(0, Math.min(1, value));
  return Math.round(n * n * (3 - 2 * n) * 16) / 16;
}

// Normalized source atlas rectangles -> portrait rectangles. Only these local
// regions may differ. Source files are untouched; registration is renderer data.
const FEATURES = [
  { kind: 'mouth', from: [0.764, 0.217, 0.097, 0.064], to: [0.457, 0.376, 0.175, 0.122] },
];
const EYES = [
  { kind: 'blink', from: [0.355, 0.265, 0.125, 0.09], to: [0.355, 0.265, 0.125, 0.09] },
  { kind: 'blink', from: [0.518, 0.219, 0.125, 0.08], to: [0.518, 0.219, 0.125, 0.08] },
];

export function createPortraitRig(
  canvas,
  {
    id,
    portrait,
    atlas,
    blink,
    features = FEATURES,
    eyeFeatures = EYES,
    expression,
    browFeatures = [],
    onReady = () => {},
    onFailure = () => {},
  },
) {
  const ctx = canvas.getContext('2d');
  let disposed = false,
    ready = false,
    last = null,
    signature = '';
  const base = new Image(),
    sheet = new Image(),
    eyes = new Image(),
    brows = new Image();
  const layers = [];
  canvas.width = canvas.height = 512;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.hidden = true;
  function fail() {
    if (!disposed) {
      ready = false;
      canvas.hidden = true;
      onFailure();
    }
  }
  function addLayers(image, features) {
    for (const feature of features) {
      const layer = document.createElement('canvas');
      layer.width = layer.height = 512;
      const c = layer.getContext('2d');
      const [sx, sy, sw, sh] = feature.from.map((v) => v * image.naturalWidth);
      const [x, y, w, h] = feature.to.map((v) => v * 512);
      c.drawImage(image, sx, sy, sw, sh, x, y, w, h);
      c.globalCompositeOperation = 'destination-in';
      c.save();
      c.translate(x + w / 2, y + h / 2);
      c.scale(w / 2, h / 2);
      const fade = c.createRadialGradient(0, 0, 0.6, 0, 0, 1);
      fade.addColorStop(0, '#000');
      fade.addColorStop(1, 'transparent');
      c.fillStyle = fade;
      c.fillRect(-1, -1, 2, 2);
      c.restore();
      layers.push({ kind: feature.kind, image: layer });
    }
  }
  function prepareEyes() {
    if (
      disposed ||
      !ready ||
      !eyes.complete ||
      !eyes.naturalWidth ||
      eyes.naturalWidth !== eyes.naturalHeight ||
      layers.some((layer) => layer.kind === 'blink')
    )
      return;
    addLayers(eyes, eyeFeatures);
    signature = '';
    if (last) render(last);
  }
  function prepareBrows() {
    if (
      disposed ||
      !ready ||
      !brows.complete ||
      !brows.naturalWidth ||
      layers.some((l) => l.kind === 'brow')
    )
      return;
    addLayers(brows, browFeatures);
    signature = '';
    if (last) render(last);
  }
  function prepare() {
    if (
      disposed ||
      ready ||
      !base.complete ||
      !sheet.complete ||
      !base.naturalWidth ||
      !sheet.naturalWidth
    )
      return;
    if (
      !ctx ||
      base.naturalWidth !== base.naturalHeight ||
      sheet.naturalWidth !== sheet.naturalHeight
    )
      return fail();
    addLayers(sheet, features);
    ready = true;
    onReady();
    if (last) render(last);
    prepareEyes();
    prepareBrows();
  }
  function render(frame) {
    last = frame;
    const show = ready && !disposed && frame.active && frame.characterId === id;
    canvas.hidden = !show;
    if (!show) {
      signature = '';
      return;
    }
    const mouth = facialBlend(frame.mouth),
      blink = facialBlend(frame.blink);
    const brow = facialBlend(frame.brow || 0);
    const next = `${mouth}/${blink}/${brow}`;
    if (signature !== next) {
      ctx.clearRect(0, 0, 512, 512);
      ctx.drawImage(base, 0, 0, 512, 512);
      for (const layer of layers) {
        ctx.globalAlpha = { mouth, brow, blink }[layer.kind] ?? blink;
        if (ctx.globalAlpha > 0) ctx.drawImage(layer.image, 0, 0);
      }
      ctx.globalAlpha = 1;
      signature = next;
    }
    // The portrait registration stays fixed; listening motion moves the whole
    // decorative surface by less than a degree, with no React frame updates.
    canvas.style.transform = `rotate(${Math.max(-0.7, Math.min(0.7, frame.tilt || 0))}deg) translateY(${Math.max(-1, Math.min(1, frame.nod || 0))}px)`;
  }
  base.onload = sheet.onload = prepare;
  base.onerror = sheet.onerror = fail;
  eyes.onload = prepareEyes;
  brows.onload = prepareBrows;
  base.src = portrait;
  sheet.src = atlas;
  if (blink) eyes.src = blink;
  if (expression) brows.src = expression;
  return {
    render,
    dispose() {
      disposed = true;
      base.onload = sheet.onload = base.onerror = sheet.onerror = eyes.onload = brows.onload = null;
      canvas.hidden = true;
      layers.length = 0;
    },
  };
}
