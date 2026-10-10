const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// Angel's original facial geometry is shared with the native iPhone puppet.
const recipes = Object.freeze({
  neutral: [1, 1, 0, 0, 0, 0, 0, 0, 0.25, 0.1, 0],
  smile: [0.82, 0.82, 0.1, 0.1, 0, 0, 0, 0, 0.82, 0.72, 0],
  laugh: [0.1, 0.1, 0.18, 0.18, 0, 0, 0, 0, 1, 1, 0.78],
  surprised: [1.1, 1.1, 0.8, 0.8, 0, 0, 0, 0, 0.02, 0.08, 0.58],
  skeptical: [0.86, 0.6, 0.62, -0.08, 0.24, 0.05, 0.16, 0, -0.1, 0.06, 0],
  angry: [0.76, 0.76, -0.24, -0.24, -0.66, 0.66, 0, 0, -0.62, 0.12, 0],
  sad: [0.74, 0.74, 0.2, 0.2, 0.66, -0.66, 0, 0.15, -0.76, 0.02, 0],
  worried: [0.94, 0.94, 0.42, 0.42, 0.53, -0.53, 0, 0, -0.42, 0.06, 0.04],
  closed: [0, 0, 0, 0, 0, 0, 0, 0, 0.44, 0.18, 0],
  curious: [1, 0.94, 0.36, 0.1, 0.13, 0.04, 0.1, -0.08, 0.36, 0.2, 0],
  thoughtful: [0.92, 0.92, 0.12, 0.12, 0.05, -0.05, -0.18, -0.22, 0.1, 0.1, 0],
  playful: [0.66, 0.95, 0.16, 0.4, 0, 0.1, 0.12, 0, 0.92, 0.62, 0],
  confident: [0.96, 0.96, 0.24, 0.24, 0.04, -0.04, 0, -0.03, 0.65, 0.44, 0],
  tender: [0.83, 0.83, 0.18, 0.18, 0.14, -0.14, 0, 0.04, 0.56, 0.36, 0],
  tired: [0.48, 0.48, -0.06, -0.06, 0.04, -0.04, 0, 0.18, 0.02, 0.03, 0],
  serious: [0.9, 0.9, -0.02, -0.02, 0.12, -0.12, 0, 0, -0.06, 0.04, 0],
  delighted: [0.69, 0.69, 0.48, 0.48, 0, 0, 0, -0.06, 1, 0.92, 0.24],
});

export const ANGEL_FACES = Object.freeze(Object.keys(recipes));
const faceForExpression = Object.freeze({
  warm: 'smile',
  amused: 'smile',
  curious: 'curious',
  thoughtful: 'thoughtful',
  playful: 'playful',
  smug: 'playful',
  confident: 'confident',
  tender: 'tender',
  tired: 'tired',
  serious: 'serious',
  excited: 'delighted',
  skeptical: 'skeptical',
  dry: 'skeptical',
  frustrated: 'angry',
  angry: 'angry',
  disgusted: 'angry',
  surprised: 'surprised',
  sad: 'sad',
  concerned: 'worried',
  afraid: 'worried',
});

export function angelFace(frame) {
  if (!frame.active) return 'neutral';
  if (frame.face?.to === 'laugh' && frame.face.blend >= 0.5) return 'laugh';
  return faceForExpression[frame.expression] ?? 'neutral';
}

export function angelFacial(face, blink, active) {
  const recipe = recipes[active ? face : 'neutral'] ?? recipes.neutral;
  const opening = 1 - (active && Number.isFinite(blink) ? clamp(blink, 0, 1) : 0);
  const [
    leftEye,
    rightEye,
    leftBrow,
    rightBrow,
    leftBrowSlope,
    rightBrowSlope,
    gazeX,
    gazeY,
    smile,
    cheekLift,
    restingMouth,
  ] = recipe;
  return {
    leftEye: leftEye * opening,
    rightEye: rightEye * opening,
    leftBrow,
    rightBrow,
    leftBrowSlope,
    rightBrowSlope,
    gazeX,
    gazeY,
    smile,
    cheekLift,
    restingMouth,
  };
}

const mouthRoles = Object.freeze([
  [0, 1, 0.25, 0, 0, 0],
  [0.18, 0.9, 0.34, 0, 0, 0],
  [0.58, 0.97, 0.46, 0.08, 0, 0.16],
  [0.72, 0.66, 0.98, 0, 0, 0.09],
  [0.28, 0.54, 1, 0, 0, 0],
  [0.27, 1.14, 0.22, 0.2, 0.08, 0],
  [0, 0.88, 0.2, 0, 0, 0],
  [0.14, 1.02, 0.2, 0.26, 0.2, 0],
  [0.95, 1.03, 0.53, 0.14, 0.06, 0.26],
]);

export function angelMouth(role, strength, face, active) {
  const expression = angelFacial(face, 0, active);
  if (active && face === 'laugh')
    return {
      width: 1.1,
      aperture: 0.78,
      roundness: 0.38,
      smile: 1,
      upperTeeth: 0.16,
      lowerTeeth: 0,
      tongue: 0.2,
    };
  const speaking =
    active &&
    Number.isFinite(strength) &&
    strength > 0.06 &&
    Number.isInteger(role) &&
    role > 0 &&
    role < mouthRoles.length;
  if (!speaking)
    return {
      width: active && face === 'surprised' ? 0.64 : 1,
      aperture: active ? expression.restingMouth : 0,
      roundness: active && face === 'surprised' ? 0.95 : 0.25,
      smile: expression.smile,
      upperTeeth: 0,
      lowerTeeth: 0,
      tongue: 0,
    };
  const [opening, width, roundness, upperTeeth, lowerTeeth, tongue] = mouthRoles[role];
  return {
    width,
    aperture: opening * (0.72 + 0.28 * clamp(strength, 0, 1)),
    roundness,
    smile: expression.smile,
    upperTeeth,
    lowerTeeth,
    tongue,
  };
}

export const ANGEL_STILL_ORNAMENTS = Object.freeze({
  leftWingDegrees: 0,
  rightWingDegrees: 0,
  haloOffsetY: 0,
  haloDegrees: 0,
  sparkle: 0.36,
});
const quietExpressions = new Set(['sad', 'concerned', 'afraid', 'tired', 'serious']);

export function angelOrnaments(time, active, expression) {
  if (!active || !Number.isFinite(time) || time < 0) return ANGEL_STILL_ORNAMENTS;
  const energy = quietExpressions.has(expression) ? 0.42 : 1;
  const t = time % (120 * Math.PI);
  const breath = Math.sin(t * 0.48),
    flutter = Math.sin(t * 0.72 + 0.6);
  return {
    leftWingDegrees: (breath * 1.3 + flutter * 0.5) * energy,
    rightWingDegrees: (-breath * 1.3 - flutter * 0.5) * energy,
    haloOffsetY: Math.sin(t * 0.6) * 0.003,
    haloDegrees: Math.sin(t * 0.3 + 0.4) * 0.35,
    sparkle: 0.36 + (Math.sin(t * 0.48 + 1.2) * 0.11 + Math.sin(t * 0.24) * 0.04) * energy,
  };
}
