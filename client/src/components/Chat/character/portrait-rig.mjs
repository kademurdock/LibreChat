// A stationary portrait with registered, feathered local facial layers.
// Never swap the full generated frames: their backgrounds/head poses drift.
export const KIANA_ID = 'agent_6llV0eMu4fmIaj8f2x1Sb';
export const KIANA_PORTRAIT_FILE = 'agent-agent_6llV0eMu4fmIaj8f2x1Sb-avatar-1788871984269.png';
export function hasPreparedPortrait(id, url) {
  try { return id === KIANA_ID && new URL(url, 'https://local.invalid').pathname.endsWith('/' + KIANA_PORTRAIT_FILE); }
  catch { return false; }
}

// Normalized source atlas rectangles -> portrait rectangles. Only these local
// regions may differ. Source files are untouched; registration is renderer data.
const FEATURES = [
  { kind: 'mouth', from: [.764, .217, .097, .064], to: [.457, .376, .175, .122] },
];
const EYES = [
  { kind: 'blink', from: [.355, .265, .125, .09], to: [.355, .265, .125, .09] },
  { kind: 'blink', from: [.518, .219, .125, .08], to: [.518, .219, .125, .08] },
];

export function createPortraitRig(canvas, { id, portrait, atlas, blink, onReady = () => {}, onFailure = () => {} }) {
  const ctx = canvas.getContext('2d');
  let disposed = false, ready = false, last = null, signature = '';
  const base = new Image(), sheet = new Image(), eyes = new Image();
  const layers = [];
  canvas.width = canvas.height = 512;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.hidden = true;
  function fail() { if (!disposed) { ready = false; canvas.hidden = true; onFailure(); } }
  function addLayers(image, features) {
    for (const feature of features) {
      const layer = document.createElement('canvas'); layer.width = layer.height = 512;
      const c = layer.getContext('2d');
      const [sx,sy,sw,sh] = feature.from.map(v => v * image.naturalWidth);
      const [x,y,w,h] = feature.to.map(v => v * 512);
      c.drawImage(image,sx,sy,sw,sh,x,y,w,h);
      c.globalCompositeOperation = 'destination-in';
      c.save(); c.translate(x+w/2,y+h/2); c.scale(w/2,h/2);
      const fade = c.createRadialGradient(0,0,.60,0,0,1);
      fade.addColorStop(0,'#000'); fade.addColorStop(1,'transparent');
      c.fillStyle=fade; c.fillRect(-1,-1,2,2); c.restore();
      layers.push({ kind: feature.kind, image: layer });
    }
  }
  function prepareEyes() {
    if (disposed || !ready || !eyes.complete || !eyes.naturalWidth ||
        eyes.naturalWidth !== eyes.naturalHeight || layers.some(layer => layer.kind === 'blink')) return;
    addLayers(eyes, EYES); signature = ''; if (last) render(last);
  }
  function prepare() {
    if (disposed || ready || !base.complete || !sheet.complete || !base.naturalWidth || !sheet.naturalWidth) return;
    if (!ctx || base.naturalWidth !== base.naturalHeight || sheet.naturalWidth !== sheet.naturalHeight) return fail();
    addLayers(sheet, FEATURES);
    ready = true; onReady(); if (last) render(last);
    prepareEyes();
  }
  function render(frame) {
    last=frame;
    const show=ready && !disposed && frame.active && frame.characterId === id;
    canvas.hidden=!show;
    if (!show) { signature=''; return; }
    const mouth=frame.mouth > .12, blink=frame.blink > .5;
    const next=`${mouth}/${blink}`;
    if (signature !== next) {
      ctx.clearRect(0,0,512,512); ctx.drawImage(base,0,0,512,512);
      for(const layer of layers) if(layer.kind === 'mouth' ? mouth : blink) ctx.drawImage(layer.image,0,0);
      signature=next;
    }
    // The portrait registration stays fixed; listening motion moves the whole
    // decorative surface by less than a degree, with no React frame updates.
    canvas.style.transform=`rotate(${Math.max(-.7,Math.min(.7,frame.tilt || 0))}deg) translateY(${Math.max(-1,Math.min(1,frame.nod || 0))}px)`;
  }
  base.onload=sheet.onload=prepare; base.onerror=sheet.onerror=fail;
  eyes.onload=prepareEyes;
  base.src=portrait; sheet.src=atlas;
  if (blink) eyes.src=blink;
  return { render, dispose() { disposed=true; base.onload=sheet.onload=base.onerror=sheet.onerror=eyes.onload=null; canvas.hidden=true; layers.length=0; } };
}
