// Oct 16 2026: the rig for characters with a saved puppet body. The server compiles the
// body recipe into a scene (SCENE_SPEC kade-puppet-scene/1); this file only animates and
// draws it, behind the same render(frame) seam the hand-made rigs use, so neither the
// voice-message card nor the call screen needs to know which kind of face it is showing.
// The frame is the pose those drivers already build (voice-message-motion.mjs): `active`,
// `mouth` (0..1 loudness), `viseme`, `expression` (one of the 22 avatar-expression names)
// and `face`. The motion engine owns breathing, glances, blinks and the jaw; the pose's own
// timer blink and degree-sized tilt are ignored so the two never double up.
import { drawScene, createSceneCache } from './puppet-render.mjs';
import { createMotion, EXPRESSIONS, hashSeed } from './puppet-motion.mjs';

export const PUPPET_SCENE_SCHEMA = 'kade-puppet-scene/1';

// The 22 voice-direction expressions onto the engine's expression names, with a strength.
export const PUPPET_EXPRESSIONS = Object.freeze({
  neutral: ['neutral', 1],
  warm: ['warm', 1],
  tender: ['affectionate', 0.8],
  calm: ['calm', 1],
  confident: ['proud', 0.8],
  amused: ['happy', 1],
  playful: ['playful', 1],
  excited: ['excited', 1],
  smug: ['skeptical', 0.7],
  curious: ['curious', 1],
  thoughtful: ['thinking', 0.8],
  skeptical: ['skeptical', 1],
  dry: ['skeptical', 0.45],
  serious: ['determined', 0.8],
  frustrated: ['annoyed', 1],
  angry: ['angry', 1],
  disgusted: ['disgusted', 1],
  surprised: ['surprised', 1],
  afraid: ['scared', 1],
  concerned: ['worried', 1],
  sad: ['sad', 1],
  tired: ['sleepy', 1],
});

/** The engine expression for a pose: a laugh moment shows its own face. */
export function puppetExpression(name, face) {
  if (face && face.to === 'laugh' && face.blend > 0.5) return ['laughing', 1];
  return PUPPET_EXPRESSIONS[name] || PUPPET_EXPRESSIONS.neutral;
}

const OPS = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
function pathValid(d) {
  if (!Array.isArray(d) || !d.length || d.length > 600) return false;
  for (const c of d) {
    if (!c || !Object.hasOwn(OPS, c.op) || !Array.isArray(c.v) || c.v.length !== OPS[c.op])
      return false;
    for (const n of c.v) if (!finite(n) || Math.abs(n) > 1e5) return false;
  }
  return true;
}
const sameShape = (a, b) => a.length === b.length && a.every((c, i) => c.op === b[i].op);
const driveValid = (list) =>
  list === undefined ||
  (Array.isArray(list) &&
    list.every((p) => Array.isArray(p) && typeof p[0] === 'string' && finite(p[1])));

/** A defensive check of a server scene: a bad one leaves the plain portrait, never a crash. */
export function validPuppetScene(scene) {
  if (!scene || scene.schema !== PUPPET_SCENE_SCHEMA) return false;
  if (
    !Array.isArray(scene.size) ||
    scene.size.length !== 2 ||
    !scene.size.every((n) => finite(n) && n > 0)
  )
    return false;
  if (
    scene.view !== undefined &&
    (!Array.isArray(scene.view) ||
      scene.view.length !== 4 ||
      !scene.view.every(finite) ||
      scene.view[2] <= 0 ||
      scene.view[3] <= 0)
  )
    return false;
  if (!scene.gradients || typeof scene.gradients !== 'object') return false;
  for (const g of Object.values(scene.gradients)) {
    if (
      !g ||
      !Array.isArray(g.stops) ||
      !g.stops.length ||
      g.stops.some((s) => !finite(s.at) || typeof s.color !== 'string')
    )
      return false;
    if (
      g.kind === 'linear'
        ? !(g.start?.every(finite) && g.end?.every(finite))
        : !(g.kind === 'radial' && g.center?.every(finite) && finite(g.radius))
    )
      return false;
  }
  if (
    !Array.isArray(scene.groups) ||
    scene.groups.length > 500 ||
    !Array.isArray(scene.shapes) ||
    !scene.shapes.length ||
    scene.shapes.length > 4000
  )
    return false;
  const groups = new Set();
  for (const g of scene.groups) {
    if (!g || typeof g.id !== 'string' || groups.has(g.id)) return false;
    if (g.parent != null && !groups.has(g.parent)) return false; // parents come first
    if (
      g.pivot !== undefined &&
      !(Array.isArray(g.pivot) && g.pivot.length === 2 && g.pivot.every(finite))
    )
      return false;
    if (![g.tx, g.ty, g.r, g.sx, g.sy].every(driveValid)) return false;
    groups.add(g.id);
  }
  const shapes = new Set();
  for (const s of scene.shapes) {
    if (!s || typeof s.id !== 'string' || !groups.has(s.g) || !pathValid(s.d)) return false;
    if (
      s.m !== undefined &&
      (!Array.isArray(s.m) ||
        s.m.some((m) => !m || typeof m.c !== 'string' || !pathValid(m.d) || !sameShape(m.d, s.d)))
    )
      return false;
    if (s.clip !== undefined && !shapes.has(s.clip)) return false;
    if (!driveValid(s.oc) || !driveValid(s.hide)) return false;
    shapes.add(s.id);
  }
  return true;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
// Index into the mouth sheet (voice-message-motion visemeAt) -> a nudge to the engine's shape.
const VISEMES = {
  3: { 'mouth.round': 0.35 },
  4: { 'mouth.round': 0.6, 'mouth.wide': -0.2 },
  5: { 'mouth.wide': 0.45 },
  6: { 'mouth.press': 0.4 },
  7: { 'mouth.wide': 0.25, 'mouth.open': -0.15 },
  8: { 'mouth.open': 0.15 },
};
const SPEECH_HANGOVER_MS = 450; // gaps between syllables still count as talking

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ id: string, scene: object, onReady?: () => void, onFailure?: () => void,
 *   onVisibilityChange?: (show: boolean) => void }} options
 */
export function createPuppetRig(
  canvas,
  { id, scene, onReady = () => {}, onFailure = () => {}, onVisibilityChange = () => {} },
) {
  const ctx = canvas.getContext('2d');
  let current = scene,
    disposed = false,
    failed = !ctx || !validPuppetScene(scene),
    shown = false,
    lastAt = 0,
    voiceAt = -Infinity,
    expression = '',
    playUntil = 0,
    playName = '',
    signature = '',
    backdrop = null;
  let cache = createSceneCache();
  const engine = (s) =>
    createMotion({ seed: hashSeed(id || 'puppet'), ...(s && s.motion ? s.motion : {}) });
  let motion = engine(current);
  canvas.setAttribute('aria-hidden', 'true');
  canvas.hidden = true;
  if (failed) onFailure();
  else onReady();

  function show(value) {
    canvas.hidden = !value;
    if (shown !== value) {
      shown = value;
      onVisibilityChange(value);
    }
  }
  function fit() {
    const dpr = clamp((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 1, 3);
    const w = Math.max(64, Math.round((canvas.clientWidth || 256) * dpr));
    const h = Math.max(64, Math.round((canvas.clientHeight || canvas.clientWidth || 256) * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      backdrop = null;
      signature = '';
    }
    return [w, h];
  }
  // A still, settled face: the resting smile plus the expression held at full strength.
  function rest(name, strength = 1) {
    const ch = { 'mouth.smile': current.motion?.baseSmile ?? 0.12 };
    const k = strength * (0.55 + 0.6 * clamp(current.motion?.expressiveness ?? 0.6, 0, 1));
    for (const [c, v] of Object.entries(EXPRESSIONS[name] || {})) ch[c] = (ch[c] || 0) + v * k;
    return ch;
  }
  function draw(ch, w, h) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);
    if (current.backdrop) {
      if (!backdrop) {
        backdrop = ctx.createLinearGradient(0, 0, 0, h);
        backdrop.addColorStop(0, current.backdrop.top);
        backdrop.addColorStop(1, current.backdrop.bottom);
      }
      ctx.fillStyle = backdrop;
      ctx.fillRect(0, 0, w, h);
    }
    drawScene(ctx, current, ch, { x: 0, y: 0, w, h }, cache);
  }
  function render(frame) {
    if (disposed || failed) return;
    if (!frame || frame.characterId !== id) {
      show(false);
      signature = '';
      return;
    }
    try {
      const t = now();
      const dt = lastAt ? (t - lastAt) / 1000 : 0;
      lastAt = t;
      const [w, h] = fit();
      const playing = t < playUntil ? playName : '';
      if (!frame.active) {
        // Paused, finished, off screen or reduced motion: one still frame, drawn once.
        const [name, strength] = playing
          ? [playing, 1]
          : puppetExpression(frame.expression, frame.face);
        const key = `${w}x${h}/${name}/${strength}`;
        if (key !== signature) {
          draw(rest(name, strength), w, h);
          signature = key;
        }
        lastAt = 0;
        voiceAt = -Infinity;
        show(true);
        return;
      }
      signature = '';
      if (!playing) {
        const [name, strength] = puppetExpression(frame.expression, frame.face);
        if (name !== expression) {
          expression = name;
          motion.setExpression(name, strength, 3600);
        }
      }
      const level = Number.isFinite(frame.mouth) ? clamp(frame.mouth, 0, 1) : 0;
      if (level > 0.05) voiceAt = t;
      const speaking = t - voiceAt < SPEECH_HANGOVER_MS;
      const out = motion.update(dt, {
        speaking,
        level,
        listening: !speaking && frame.listening === true,
      });
      let ch = out;
      const nudge = speaking && level > 0.06 ? VISEMES[frame.viseme] : null;
      if (nudge) {
        ch = { ...out };
        for (const [c, v] of Object.entries(nudge))
          ch[c] = clamp((ch[c] || 0) + v * Math.min(1, level * 1.5), 0, 1);
      }
      draw(ch, w, h);
      show(true);
    } catch {
      failed = true;
      show(false);
      onFailure();
    }
  }
  return {
    render,
    /** Swap in a newly compiled scene (the editor's live preview); motion carries on. */
    setScene(next) {
      if (disposed || !validPuppetScene(next)) return false;
      const energyChanged =
        JSON.stringify(next.motion || {}) !== JSON.stringify(current.motion || {});
      current = next;
      cache = createSceneCache();
      backdrop = null;
      signature = '';
      failed = !ctx;
      if (energyChanged) {
        motion = engine(current);
        expression = '';
      }
      return true;
    },
    /** Hold an engine expression (EXPRESSIONS key) for a few seconds over the pose's own. */
    play(name, seconds = 2) {
      if (!Object.hasOwn(EXPRESSIONS, name)) return;
      playName = name;
      playUntil = now() + seconds * 1000;
      expression = '';
      motion.setExpression(name, 1, seconds);
      signature = '';
    },
    dispose() {
      disposed = true;
      show(false);
      cache = createSceneCache();
    },
  };
}
