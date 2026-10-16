// Puppet motion engine: turns time, speech and expression into channel values.
// Deterministic for a given seed and the same sequence of update() calls, frame-rate
// independent, no timers of its own. The iPhone port must match this file line for line.
//
// Layers, summed each frame:
//   idle     breathing, slow head drift, glances (saccade + fixation), coupled blinks,
//            occasional micro-expressions
//   speech   jaw from the audio level, shape changes per syllable, emphasis nods and
//            brow lifts, more eye contact
//   listen   attentive nods and a soft smile while the person is talking
//   emotion  eased channel targets for the current expression
//   physics  hair follow-through, wing flap, halo float

export const CHANNELS = [
  'head.yaw', 'head.pitch', 'head.roll', 'body.breath', 'body.shrug',
  'gaze.x', 'gaze.y', 'eye.blink', 'eye.wink', 'eye.squint', 'eye.wide',
  'brow.raise', 'brow.furrow', 'brow.sad', 'brow.asym',
  'mouth.open', 'mouth.wide', 'mouth.round', 'mouth.smile', 'mouth.press',
  'cheek.raise', 'cheek.blush', 'hair.swing', 'extras.flap', 'extras.float',
];

// Channel targets per expression. Values are offsets from neutral.
export const EXPRESSIONS = {
  neutral: {},
  happy: { 'mouth.smile': 0.7, 'cheek.raise': 0.6, 'eye.squint': 0.25, 'brow.raise': 0.15 },
  joyful: { 'mouth.smile': 1, 'mouth.open': 0.35, 'cheek.raise': 1, 'eye.squint': 0.55, 'brow.raise': 0.3, 'head.pitch': -0.15 },
  laughing: { 'mouth.smile': 1, 'mouth.open': 0.6, 'cheek.raise': 1, 'eye.squint': 0.75, 'brow.raise': 0.35, 'head.roll': 0.25, 'head.pitch': -0.25 },
  warm: { 'mouth.smile': 0.45, 'eye.squint': 0.2, 'head.roll': 0.18, 'brow.sad': 0.12 },
  excited: { 'mouth.smile': 0.8, 'mouth.open': 0.3, 'eye.wide': 0.6, 'brow.raise': 0.7, 'cheek.raise': 0.6 },
  surprised: { 'brow.raise': 1, 'eye.wide': 1, 'mouth.open': 0.5, 'mouth.round': 0.6, 'head.pitch': -0.2 },
  curious: { 'brow.asym': 0.7, 'head.roll': 0.35, 'mouth.smile': 0.15, 'eye.wide': 0.2 },
  thinking: { 'brow.asym': 0.4, 'mouth.press': 0.35, 'head.roll': -0.2, 'gaze.x': -0.55, 'gaze.y': -0.55 },
  confused: { 'brow.furrow': 0.35, 'brow.asym': 0.55, 'mouth.smile': -0.2, 'head.roll': 0.3 },
  skeptical: { 'brow.asym': 0.9, 'mouth.smile': 0.25, 'eye.squint': 0.35, 'mouth.press': 0.2 },
  sad: { 'brow.sad': 1, 'mouth.smile': -0.7, 'gaze.y': 0.45, 'head.pitch': 0.35, 'eye.squint': 0.1 },
  worried: { 'brow.sad': 0.75, 'mouth.press': 0.4, 'mouth.smile': -0.25, 'eye.wide': 0.25 },
  scared: { 'brow.sad': 0.5, 'brow.raise': 0.6, 'eye.wide': 0.95, 'mouth.open': 0.25, 'mouth.wide': 0.3, 'body.shrug': 0.4 },
  angry: { 'brow.furrow': 1, 'mouth.press': 0.6, 'mouth.smile': -0.45, 'eye.squint': 0.35, 'head.pitch': 0.15 },
  annoyed: { 'brow.furrow': 0.5, 'mouth.press': 0.45, 'mouth.smile': -0.2, 'gaze.x': 0.45, 'eye.squint': 0.2 },
  disgusted: { 'brow.furrow': 0.6, 'mouth.smile': -0.55, 'eye.squint': 0.5, 'mouth.wide': 0.3, 'head.roll': -0.15, 'head.pitch': -0.1 },
  embarrassed: { 'mouth.smile': 0.4, 'gaze.y': 0.5, 'gaze.x': 0.4, 'head.pitch': 0.3, 'cheek.blush': 1, 'body.shrug': 0.3 },
  proud: { 'mouth.smile': 0.5, 'head.pitch': -0.3, 'eye.squint': 0.2, 'brow.raise': 0.1 },
  sleepy: { 'eye.blink': 0.45, 'brow.raise': -0.3, 'head.pitch': 0.2, 'mouth.press': 0.1 },
  playful: { 'mouth.smile': 0.6, 'head.roll': 0.25, 'brow.asym': 0.4, 'eye.squint': 0.2 },
  affectionate: { 'mouth.smile': 0.55, 'eye.squint': 0.3, 'head.roll': 0.3, 'brow.sad': 0.15, 'cheek.blush': 0.5 },
  determined: { 'brow.furrow': 0.35, 'mouth.press': 0.5, 'head.pitch': 0.1 },
  calm: { 'mouth.smile': 0.2, 'eye.squint': 0.12 },
  whisper: { 'mouth.press': 0.25, 'head.pitch': 0.15, 'gaze.x': 0.3, 'head.roll': -0.12 },
};

const ENERGY = {
  calm: { breath: 4.6, drift: 0.7, glance: 1.35, nod: 0.7 },
  steady: { breath: 3.9, drift: 1, glance: 1, nod: 1 },
  lively: { breath: 3.3, drift: 1.35, glance: 0.75, nod: 1.35 },
};
const BLINK_MEAN = { normal: 4.2, slow: 5.6, quick: 2.8 };

function rng(seed) {
  let a = 0x9e3779b9 ^ seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(text) {
  let h = 2166136261;
  for (const c of String(text)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

// smooth deterministic noise in [-1, 1]: three detuned sines
function makeNoise(r) {
  const f = [0.07 + r() * 0.05, 0.13 + r() * 0.07, 0.29 + r() * 0.1];
  const p = [r() * 6.28, r() * 6.28, r() * 6.28];
  return (t) => (Math.sin(t * f[0] * 6.283 + p[0]) * 0.55 + Math.sin(t * f[1] * 6.283 + p[1]) * 0.3 + Math.sin(t * f[2] * 6.283 + p[2]) * 0.15);
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const approach = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / Math.max(1e-3, tau)));

export function createMotion(options = {}) {
  const seed = options.seed ?? 1;
  const r = rng(seed);
  const energy = ENERGY[options.energy] || ENERGY.steady;
  const expressiveness = clamp(options.expressiveness ?? 0.6, 0, 1);
  const blinkMean = BLINK_MEAN[options.blink] || BLINK_MEAN.normal;
  const baseSmile = options.baseSmile ?? 0.12;
  const n = { yaw: makeNoise(r), pitch: makeNoise(r), roll: makeNoise(r), smile: makeNoise(r), brow: makeNoise(r) };
  const s = {
    t: 0,
    breath: r(),
    gaze: [0, 0], gazeFrom: [0, 0], gazeTo: [0, 0], sacT: 1, sacDur: 0.07, fixUntil: 0.6 + r(),
    blinkAt: 1 + r() * 2, blinkT: -1, blinkDouble: false,
    headFollow: [0, 0],
    emo: {}, emoTarget: {}, emoUntil: 0,
    level: 0, prevLevel: 0, onsetCooldown: 0, shape: [0, 0, 0], shapeTarget: [0, 0, 0],
    nod: 0, nodV: 0, browLift: 0,
    nodAt: 2 + r() * 3,
    hair: 0, hairV: 0, prevYaw: 0, prevRoll: 0,
    micro: 0, microAt: 4 + r() * 6, microKind: 0,
    out: {},
  };
  for (const c of CHANNELS) s.out[c] = 0;

  function scheduleBlink(now) {
    const u = Math.max(1e-4, r());
    s.blinkAt = now + clamp(-Math.log(u) * blinkMean, 1.1, blinkMean * 2.6);
  }

  function startSaccade(target, now) {
    const dist = Math.hypot(target[0] - s.gaze[0], target[1] - s.gaze[1]);
    s.gazeFrom = s.gaze.slice();
    s.gazeTo = target;
    s.sacT = 0;
    s.sacDur = 0.045 + dist * 0.06;
    // people often blink with a big gaze shift
    if (dist > 0.45 && s.blinkT < 0 && r() < 0.6) s.blinkAt = now + 0.02;
    // and the brows sometimes lift a little with a fresh glance
    if (dist > 0.5 && r() < 0.3) s.browLift = 0.18 * (0.5 + expressiveness);
  }

  return {
    setExpression(name, strength = 1, holdSeconds = 4) {
      const e = EXPRESSIONS[name] || {};
      const k = clamp(strength, 0, 1.2) * (0.55 + 0.6 * expressiveness);
      s.emoTarget = {};
      for (const [c, v] of Object.entries(e)) s.emoTarget[c] = v * k;
      s.emoUntil = s.t + holdSeconds;
      if (name === 'playful') s.winkAt = s.t + 0.25;
    },
    // dt seconds; input: { speaking, level 0..1, listening, reduceMotion, look:[x,y] }
    update(dt, input = {}) {
      dt = clamp(dt, 0, 0.1);
      const t = (s.t += dt);
      const out = s.out;
      const reduce = !!input.reduceMotion;
      const speaking = !!input.speaking;

      // ---- breathing (inhale 40%, exhale 60%)
      s.breath = (s.breath + dt / energy.breath) % 1;
      const ph = s.breath;
      const breath = ph < 0.4 ? Math.sin((ph / 0.4) * Math.PI * 0.5) : Math.cos(((ph - 0.4) / 0.6) * Math.PI * 0.5);
      out['body.breath'] = reduce ? 0 : breath * 2 - 1;

      // ---- gaze: fixations and saccades
      if (t >= s.fixUntil && s.sacT >= 1) {
        let target;
        if (input.look) target = input.look;
        else if (speaking) target = r() < 0.7 ? [(r() - 0.5) * 0.25, (r() - 0.5) * 0.15] : [(r() - 0.5) * 1.3, (r() - 0.6) * 0.8];
        else if (input.listening) target = [(r() - 0.5) * 0.2, (r() - 0.4) * 0.15];
        else target = r() < 0.45 ? [(r() - 0.5) * 0.3, (r() - 0.5) * 0.2] : [(r() - 0.5) * 1.5, (r() - 0.5) * 0.9];
        startSaccade(target, t);
        s.fixUntil = t + (0.5 + r() * 2.6) * energy.glance * (speaking ? 1.3 : 1);
      }
      if (s.sacT < 1) {
        s.sacT = Math.min(1, s.sacT + dt / s.sacDur);
        const e = 1 - (1 - s.sacT) ** 3;
        s.gaze = [s.gazeFrom[0] + (s.gazeTo[0] - s.gazeFrom[0]) * e, s.gazeFrom[1] + (s.gazeTo[1] - s.gazeFrom[1]) * e];
      }
      // micro-saccade jitter during fixations
      const jitter = reduce ? 0 : 0.015;
      const gx = s.gaze[0] + Math.sin(t * 13.1 + seed) * jitter;
      const gy = s.gaze[1] + Math.sin(t * 11.3 + seed * 0.7) * jitter;

      // ---- head: drift + follows the eyes + nods
      s.headFollow[0] = approach(s.headFollow[0], s.gaze[0] * 0.38, dt, 0.42);
      s.headFollow[1] = approach(s.headFollow[1], s.gaze[1] * 0.3, dt, 0.5);
      const d = reduce ? 0 : energy.drift;
      let yaw = n.yaw(t) * 0.11 * d + s.headFollow[0];
      let pitch = n.pitch(t) * 0.06 * d + s.headFollow[1];
      let roll = n.roll(t) * 0.07 * d;

      // ---- speech
      const level = clamp(input.level || 0, 0, 1);
      s.level = approach(s.level, speaking ? level : 0, dt, level > s.level ? 0.035 : 0.085);
      s.onsetCooldown -= dt;
      if (speaking && s.level - s.prevLevel > 0.06 && s.onsetCooldown <= 0 && s.level > 0.18) {
        // a syllable onset: pick a new mouth shape, sometimes nod and lift the brows
        s.onsetCooldown = 0.11;
        const pick = r();
        s.shapeTarget = pick < 0.3 ? [0.7, 0, 0] : pick < 0.52 ? [0, 0.75, 0] : pick < 0.66 ? [0, 0, 0.6] : [0.2, 0.2, 0];
        if (r() < 0.35 * energy.nod && !reduce) s.nodV += 2.2 * (0.6 + expressiveness * 0.6);
        if (r() < 0.25) s.browLift = Math.max(s.browLift, 0.3 * expressiveness + 0.08);
      }
      s.prevLevel = s.level;
      if (!speaking) s.shapeTarget = [0, 0, 0];
      for (let i = 0; i < 3; i++) s.shape[i] = approach(s.shape[i], s.shapeTarget[i], dt, 0.06);
      // nod spring (pitch down then back)
      s.nodV += (-s.nod * 60 - s.nodV * 9) * dt;
      s.nod += s.nodV * dt;
      pitch += s.nod * 0.12;

      // ---- listening nods
      if (input.listening && !speaking && t >= s.nodAt && !reduce) {
        s.nodV += 1.6;
        s.nodAt = t + 2.5 + r() * 3.5;
      }

      // ---- blinks
      if (s.blinkT < 0 && t >= s.blinkAt) s.blinkT = 0;
      let blink = 0;
      if (s.blinkT >= 0) {
        s.blinkT += dt;
        const b = s.blinkT;
        blink = b < 0.07 ? b / 0.07 : b < 0.11 ? 1 : b < 0.22 ? 1 - (b - 0.11) / 0.11 : 0;
        pitch += blink * 0.025; // the head dips a hair with a blink
        if (b >= 0.22) {
          s.blinkT = -1;
          if (!s.blinkDouble && r() < 0.16) {
            s.blinkDouble = true;
            s.blinkAt = t + 0.09;
          } else {
            s.blinkDouble = false;
            scheduleBlink(t);
          }
        }
      }

      // ---- micro-expressions while idle: a small smile flicker, a lip press, a brow twitch
      if (!speaking && t >= s.microAt && !reduce) {
        s.microKind = 1 + Math.floor(r() * 3);
        s.micro = 0;
        s.microAt = t + 5 + r() * 9;
      }
      let microSmile = 0;
      let microPress = 0;
      let microBrow = 0;
      if (s.microKind) {
        s.micro += dt;
        const env = Math.sin(Math.min(1, s.micro / 1.4) * Math.PI);
        if (s.microKind === 1) microSmile = 0.22 * env;
        else if (s.microKind === 2) microPress = 0.3 * env;
        else microBrow = 0.16 * env;
        if (s.micro >= 1.4) s.microKind = 0;
      }

      // ---- emotion easing
      if (t > s.emoUntil) s.emoTarget = {};
      for (const c of CHANNELS) {
        const target = s.emoTarget[c] || 0;
        s.emo[c] = approach(s.emo[c] || 0, target, dt, target ? 0.22 : 0.6);
      }
      const E = (c) => s.emo[c] || 0;
      s.browLift = approach(s.browLift, 0, dt, 0.35);

      // ---- compose
      out['head.yaw'] = clamp(yaw + E('head.yaw'), -1, 1);
      out['head.pitch'] = clamp(pitch + E('head.pitch'), -1, 1);
      out['head.roll'] = clamp(roll + E('head.roll'), -1, 1);
      out['body.shrug'] = clamp(E('body.shrug'), 0, 1);
      out['gaze.x'] = clamp(gx + E('gaze.x') - (speaking ? 0 : 0), -1, 1);
      out['gaze.y'] = clamp(gy + E('gaze.y'), -1, 1);
      out['eye.blink'] = clamp(Math.max(blink, E('eye.blink')), 0, 1);
      let wink = 0;
      if (s.winkAt !== undefined) {
        const w = t - s.winkAt;
        if (w >= 0 && w < 0.45) wink = w < 0.1 ? w / 0.1 : w < 0.3 ? 1 : 1 - (w - 0.3) / 0.15;
        if (w >= 0.45) s.winkAt = undefined;
      }
      out['eye.wink'] = wink;
      out['eye.squint'] = clamp(E('eye.squint') + s.level * 0.08, 0, 1);
      out['eye.wide'] = clamp(E('eye.wide'), 0, 1);
      out['brow.raise'] = clamp(E('brow.raise') + s.browLift + microBrow + n.brow(t) * 0.03, -1, 1);
      out['brow.furrow'] = clamp(E('brow.furrow'), 0, 1);
      out['brow.sad'] = clamp(E('brow.sad'), 0, 1);
      out['brow.asym'] = clamp(E('brow.asym'), 0, 1);
      const jaw = s.level ** 0.75 * 0.95;
      out['mouth.open'] = clamp(jaw * (1 - s.shape[2] * 0.5) + E('mouth.open') * (speaking ? 0.4 : 1), 0, 1);
      out['mouth.wide'] = clamp(s.shape[0] * jaw * 1.2 + E('mouth.wide'), 0, 1);
      out['mouth.round'] = clamp(s.shape[1] * Math.min(1, jaw * 1.6) + E('mouth.round'), 0, 1);
      out['mouth.press'] = clamp(s.shape[2] * 0.6 + E('mouth.press') + microPress, 0, 1);
      out['mouth.smile'] = clamp(baseSmile + n.smile(t) * 0.04 + E('mouth.smile') + microSmile + (input.listening ? 0.12 : 0), -1, 1);
      out['cheek.raise'] = clamp(E('cheek.raise') + Math.max(0, out['mouth.smile'] - 0.4) * 0.6, 0, 1);
      out['cheek.blush'] = clamp(E('cheek.blush'), 0, 1);

      // ---- physics: hair follows head motion with lag
      const vYaw = (out['head.yaw'] - s.prevYaw) / Math.max(dt, 1e-3);
      const vRoll = (out['head.roll'] - s.prevRoll) / Math.max(dt, 1e-3);
      s.prevYaw = out['head.yaw'];
      s.prevRoll = out['head.roll'];
      if (!reduce) {
        s.hairV += (-s.hair * 38 - s.hairV * 5.5 - (vYaw * 0.9 + vRoll * 1.4) * 9) * dt;
        s.hair = clamp(s.hair + s.hairV * dt, -1, 1);
      } else s.hair = 0;
      out['hair.swing'] = s.hair + (reduce ? 0 : out['head.roll'] * 0.5);
      out['extras.flap'] = reduce ? 0 : Math.sin(t * 1.4) * 0.5 + 0.5 * Math.sin(t * 0.37);
      out['extras.float'] = reduce ? 0 : Math.sin(t * 0.9);
      return out;
    },
  };
}
