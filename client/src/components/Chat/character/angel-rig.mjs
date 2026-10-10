import art from './angel-vector.json' with { type: 'json' };
import { angelFace, angelFacial, angelMouth, angelOrnaments } from './angel-motion.mjs';

export const ANGEL_ID = 'agent_NkG_Fb8_xLz8HFJyx4gNv';
export const ANGEL_PORTRAIT_FILE = 'agent-agent_NkG_Fb8_xLz8HFJyx4gNv-avatar-1791586815115.png';
export const ANGEL_SOURCE_SHA256 =
  '805783c577c0beb332256fd8786fefa6b42d8a24a2f499b4e1a3de9e26f7f1e0';
export const ANGEL_GROUPS = Object.freeze(['leftWing', 'rightWing', 'body', 'head', 'halo']);
const commandLengths = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
const finiteRange = (value, low, high) => Number.isFinite(value) && value >= low && value <= high;
const colorValid = (value) =>
  typeof value === 'string' && /^#(?:[a-f\d]{3}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value);
const fraction = (value) => value === undefined || finiteRange(value, 0, 1);

export function validAngelArt(value) {
  if (
    !value ||
    value.schema !== 1 ||
    value.canvas !== 1024 ||
    !Array.isArray(value.shapes) ||
    !value.shapes.length ||
    value.shapes.length > 1500 ||
    !value.gradients ||
    !value.pivots ||
    !value.features ||
    !Array.isArray(value.features.eyes) ||
    !Array.isArray(value.features.cheeks)
  )
    return false;
  const point = (v) =>
    Array.isArray(v) && v.length === 2 && v.every((n) => finiteRange(n, 0, 1024));
  const groups = new Set(value.shapes.map((shape) => shape?.group));
  if (
    new Set(value.shapes.map((shape) => shape?.id)).size !== value.shapes.length ||
    groups.size !== ANGEL_GROUPS.length ||
    ANGEL_GROUPS.some((group) => !groups.has(group)) ||
    Object.keys(value.pivots).length !== ANGEL_GROUPS.length ||
    ANGEL_GROUPS.some((group) => !point(value.pivots[group])) ||
    Object.keys(value.gradients).length > 64
  )
    return false;
  for (const paint of Object.values(value.gradients)) {
    if (
      !paint ||
      !Array.isArray(paint.stops) ||
      paint.stops.length < 2 ||
      paint.stops.length > 12 ||
      paint.stops.some(
        (stop, i) =>
          !stop ||
          !finiteRange(stop.at, 0, 1) ||
          !colorValid(stop.color) ||
          !fraction(stop.opacity) ||
          (i > 0 && stop.at < paint.stops[i - 1].at),
      )
    )
      return false;
    if (paint.kind === 'linear') {
      if (
        !point(paint.start) ||
        !point(paint.end) ||
        (paint.start[0] === paint.end[0] && paint.start[1] === paint.end[1])
      )
        return false;
    } else if (
      paint.kind !== 'radial' ||
      !point(paint.center) ||
      !finiteRange(paint.radius, Number.MIN_VALUE, 2048)
    )
      return false;
  }
  const paintValid = (fill) => colorValid(fill) || Object.hasOwn(value.gradients, fill);
  for (const shape of value.shapes) {
    if (
      !shape ||
      typeof shape.id !== 'string' ||
      !shape.id.length ||
      shape.id.length > 128 ||
      !Array.isArray(shape.path) ||
      shape.path.length < 2 ||
      shape.path.length > 80 ||
      shape.path[0]?.op !== 'M' ||
      !fraction(shape.opacity) ||
      (shape.fill !== 'none' && !paintValid(shape.fill)) ||
      (shape.stroke !== undefined && !paintValid(shape.stroke)) ||
      (shape.strokeWidth !== undefined && !finiteRange(shape.strokeWidth, Number.MIN_VALUE, 30)) ||
      (shape.stroke === undefined) !== (shape.strokeWidth === undefined)
    )
      return false;
    for (const command of shape.path) {
      if (
        !command ||
        !Object.hasOwn(commandLengths, command.op) ||
        !Array.isArray(command.v) ||
        command.v.length !== commandLengths[command.op] ||
        command.v.some((n) => !finiteRange(n, -128, 1152))
      )
        return false;
    }
  }
  if (value.features.eyes.length !== 2 || value.features.cheeks.length !== 2) return false;
  for (const eye of value.features.eyes) {
    if (
      !eye ||
      !point([eye.cx, eye.cy]) ||
      !finiteRange(eye.width, 60, 200) ||
      !finiteRange(eye.height, 35, 150) ||
      !finiteRange(eye.irisRadius, 10, 70) ||
      eye.irisRadius >= eye.width / 2
    )
      return false;
  }
  const mouth = value.features.mouth;
  if (
    !mouth ||
    !point([mouth.cx, mouth.cy]) ||
    !finiteRange(mouth.width, 60, 200) ||
    !finiteRange(mouth.height, 30, 160)
  )
    return false;
  return value.features.cheeks.every(
    (cheek) =>
      cheek &&
      point([cheek.cx, cheek.cy]) &&
      finiteRange(cheek.rx, 10, 100) &&
      finiteRange(cheek.ry, 10, 70),
  );
}

const validMaster = validAngelArt(art);
const safeNumber = (value, low, high) =>
  Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : 0;
const jewel = (id) =>
  /^(?:sparkle|robe-jewel-|robe-sequin-|halo-pearl-|hair-pearl-)/.test(id) || id === 'heart-star';
const groups = new Map(
  ANGEL_GROUPS.map((name) => [name, art.shapes.filter((shape) => shape.group === name)]),
);

function trace(context, commands) {
  context.beginPath();
  for (const { op, v } of commands) {
    if (op === 'M') context.moveTo(v[0], v[1]);
    else if (op === 'L') context.lineTo(v[0], v[1]);
    else if (op === 'Q') context.quadraticCurveTo(v[0], v[1], v[2], v[3]);
    else if (op === 'C') context.bezierCurveTo(v[0], v[1], v[2], v[3], v[4], v[5]);
    else context.closePath();
  }
}

function tint(value, opacity = 1) {
  const hex = value.slice(1);
  const digits = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
  const rgb = digits.slice(0, 6);
  const alpha = digits.length === 8 ? parseInt(digits.slice(6), 16) / 255 : 1;
  return `rgba(${parseInt(rgb.slice(0, 2), 16)},${parseInt(rgb.slice(2, 4), 16)},${parseInt(rgb.slice(4, 6), 16)},${alpha * opacity})`;
}

function gradient(context, stops, start, end, radius = 0) {
  const result = radius
    ? context.createRadialGradient(start[0], start[1], 0, start[0], start[1], radius)
    : context.createLinearGradient(start[0], start[1], end[0], end[1]);
  for (const stop of stops) result.addColorStop(stop.at, tint(stop.color, stop.opacity ?? 1));
  return result;
}

function rotate(context, degrees, pivot) {
  context.translate(pivot[0], pivot[1]);
  context.rotate((degrees * Math.PI) / 180);
  context.translate(-pivot[0], -pivot[1]);
}

function drawGroup(context, group, sparkle) {
  const paints = new Map();
  const paint = (name) => {
    if (paints.has(name)) return paints.get(name);
    const source = art.gradients[name];
    let result = name;
    if (source?.kind === 'radial')
      result = gradient(context, source.stops, source.center, source.center, source.radius);
    else if (source) result = gradient(context, source.stops, source.start, source.end);
    paints.set(name, result);
    return result;
  };
  for (const shape of groups.get(group)) {
    context.globalAlpha =
      (shape.opacity ?? 1) * (jewel(shape.id) ? 1 - Math.abs(sparkle - 0.36) * 0.7 : 1);
    trace(context, shape.path);
    if (shape.fill !== 'none') {
      context.fillStyle = paint(shape.fill);
      context.fill();
    }
    if (shape.stroke) {
      context.strokeStyle = paint(shape.stroke);
      context.lineWidth = shape.strokeWidth;
      context.stroke();
    }
  }
  context.globalAlpha = 1;
}

function ellipse(context, x, y, rx, ry, fill) {
  context.beginPath();
  context.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  context.fillStyle = fill;
  context.fill();
}

function eyePath(context, eye, opening) {
  context.beginPath();
  context.moveTo(eye.cx - eye.width / 2, eye.cy);
  context.quadraticCurveTo(
    eye.cx,
    eye.cy - eye.height * 0.92 * opening,
    eye.cx + eye.width / 2,
    eye.cy,
  );
  context.quadraticCurveTo(
    eye.cx,
    eye.cy + eye.height * 0.72 * opening,
    eye.cx - eye.width / 2,
    eye.cy,
  );
  context.closePath();
}

function drawEye(context, eye, opening, facial) {
  if (opening <= 0.025) {
    context.beginPath();
    context.moveTo(eye.cx - eye.width / 2, eye.cy);
    context.quadraticCurveTo(eye.cx, eye.cy + 10, eye.cx + eye.width / 2, eye.cy);
    context.strokeStyle = '#694735';
    context.lineWidth = 4.5;
    context.stroke();
    return;
  }
  eyePath(context, eye, opening);
  context.fillStyle = gradient(
    context,
    [
      { at: 0, color: '#fffcf5' },
      { at: 1, color: '#eee2d4' },
    ],
    [eye.cx, eye.cy - eye.height / 2],
    [eye.cx, eye.cy + eye.height / 2],
  );
  context.fill();
  context.save();
  context.clip();
  const r = eye.irisRadius,
    x = eye.cx + facial.gazeX * r,
    y = eye.cy + facial.gazeY * r;
  const iris = context.createRadialGradient(x, y + r * 0.1, r * 0.15, x, y + r * 0.1, r);
  iris.addColorStop(0, '#ae8644');
  iris.addColorStop(0.5, '#756337');
  iris.addColorStop(1, '#40331e');
  ellipse(context, x, y, r, r, iris);
  ellipse(context, x, y - r * 0.03, r * 0.47, r * 0.55, '#251c17');
  ellipse(context, x - r * 0.22, y - r * 0.31, r * 0.2, r * 0.17, tint('#ffffff', 0.95));
  ellipse(context, x + r * 0.265, y + r * 0.3, r * 0.085, r * 0.07, tint('#fff7db', 0.75));
  context.restore();
  eyePath(context, eye, opening);
  context.strokeStyle = tint('#805d43', 0.76);
  context.lineWidth = 2.3;
  context.stroke();
  context.beginPath();
  context.moveTo(eye.cx - eye.width / 2, eye.cy);
  context.quadraticCurveTo(
    eye.cx,
    eye.cy - eye.height * 0.92 * opening,
    eye.cx + eye.width / 2,
    eye.cy,
  );
  context.strokeStyle = '#684735';
  context.lineWidth = 4;
  context.stroke();
}

function drawMouth(context, mouth) {
  const box = art.features.mouth,
    w = box.width * mouth.width,
    h = box.height * mouth.aperture;
  const corners = -mouth.smile * 10;
  context.beginPath();
  context.moveTo(box.cx - w / 2, box.cy + corners);
  if (h <= 1) {
    context.quadraticCurveTo(box.cx, box.cy + mouth.smile * 48, box.cx + w / 2, box.cy + corners);
    context.strokeStyle = '#aa6860';
    context.lineWidth = 4;
    context.stroke();
    return;
  }
  const handle = w * (0.26 + mouth.roundness * 0.2);
  context.bezierCurveTo(
    box.cx - handle,
    box.cy - h * 0.48,
    box.cx + handle,
    box.cy - h * 0.48,
    box.cx + w / 2,
    box.cy + corners,
  );
  context.bezierCurveTo(
    box.cx + handle,
    box.cy + h * 0.78,
    box.cx - handle,
    box.cy + h * 0.78,
    box.cx - w / 2,
    box.cy + corners,
  );
  context.closePath();
  context.fillStyle = gradient(
    context,
    [
      { at: 0, color: '#724335' },
      { at: 1, color: '#a5695b' },
    ],
    [box.cx, box.cy - h / 2],
    [box.cx, box.cy + h],
  );
  context.fill();
  context.save();
  context.clip();
  if (mouth.upperTeeth > 0) {
    context.beginPath();
    context.roundRect(
      box.cx - w * 0.38,
      box.cy - h * 0.46,
      w * 0.76,
      box.height * mouth.upperTeeth,
      6,
    );
    context.fillStyle = '#fff7e9';
    context.fill();
  }
  if (mouth.lowerTeeth > 0) {
    context.beginPath();
    context.roundRect(
      box.cx - w * 0.3,
      box.cy + h * 0.44 - box.height * mouth.lowerTeeth,
      w * 0.6,
      box.height * mouth.lowerTeeth,
      5,
    );
    context.fillStyle = '#ede4d7';
    context.fill();
  }
  if (mouth.tongue > 0)
    ellipse(
      context,
      box.cx,
      box.cy + h * 0.24 + (box.height * mouth.tongue) / 2,
      w * 0.26,
      (box.height * mouth.tongue) / 2,
      '#d99691',
    );
  context.restore();
  // Clipped teeth and tongue replaced the current path, so restore the lip contour.
  context.beginPath();
  context.moveTo(box.cx - w / 2, box.cy + corners);
  context.bezierCurveTo(
    box.cx - handle,
    box.cy - h * 0.48,
    box.cx + handle,
    box.cy - h * 0.48,
    box.cx + w / 2,
    box.cy + corners,
  );
  context.bezierCurveTo(
    box.cx + handle,
    box.cy + h * 0.78,
    box.cx - handle,
    box.cy + h * 0.78,
    box.cx - w / 2,
    box.cy + corners,
  );
  context.closePath();
  context.strokeStyle = '#b77b71';
  context.lineWidth = 3.5;
  context.stroke();
}

function drawFace(context, facial, mouth) {
  for (const cheek of art.features.cheeks) {
    const y = cheek.cy - facial.cheekLift * 5;
    context.globalAlpha = 0.58 + facial.cheekLift * 0.12;
    ellipse(
      context,
      cheek.cx,
      y,
      cheek.rx,
      cheek.ry,
      gradient(
        context,
        [
          { at: 0, color: '#ee9fa0', opacity: 0.66 },
          { at: 1, color: '#ee9fa0', opacity: 0 },
        ],
        [cheek.cx, y],
        [cheek.cx, y],
        cheek.rx,
      ),
    );
  }
  context.globalAlpha = 1;
  for (let i = 0; i < art.features.eyes.length; i++) {
    const eye = art.features.eyes[i],
      opening = i ? facial.rightEye : facial.leftEye;
    const brow = i ? facial.rightBrow : facial.leftBrow,
      slope = i ? facial.rightBrowSlope : facial.leftBrowSlope;
    drawEye(context, eye, opening, facial);
    const y = eye.cy - eye.height * 0.72 - brow * eye.height * 0.12;
    context.beginPath();
    context.moveTo(eye.cx - eye.width * 0.41, y + slope * 9);
    context.quadraticCurveTo(eye.cx, y - 8, eye.cx + eye.width * 0.41, y - slope * 9);
    context.strokeStyle = '#684126';
    context.lineWidth = 6;
    context.stroke();
  }
  drawMouth(context, mouth);
}

/** Consumes the caller's audio clock and policy; owns no timers or audio. */
export function drawAngel(context, frame, size = 512) {
  const face = angelFace(frame),
    facial = angelFacial(face, frame.blink, frame.active);
  const mouth = angelMouth(frame.viseme, frame.mouth, face, frame.active);
  const ornaments = angelOrnaments(frame.time, frame.active, frame.expression);
  context.clearRect(0, 0, size, size);
  context.save();
  context.scale(size / art.canvas, size / art.canvas);
  context.lineCap = context.lineJoin = 'round';
  const tilt = frame.active ? safeNumber(frame.tilt, -1.8, 1.8) : 0;
  const nod = frame.active ? safeNumber(frame.nod, -2, 2) : 0;
  rotate(context, safeNumber(tilt * 0.12, -0.4, 0.4), art.pivots.body);
  context.translate(0, safeNumber(nod * 0.35, -1.5, 1.5));
  for (const [group, degrees] of [
    ['leftWing', ornaments.leftWingDegrees],
    ['rightWing', ornaments.rightWingDegrees],
  ]) {
    context.save();
    rotate(context, degrees, art.pivots[group]);
    drawGroup(context, group, ornaments.sparkle);
    context.restore();
  }
  drawGroup(context, 'body', ornaments.sparkle);
  rotate(context, safeNumber(tilt * 0.8, -1.8, 1.8), art.pivots.head);
  context.translate(0, safeNumber(nod * 0.55, -2, 2));
  drawGroup(context, 'head', ornaments.sparkle);
  drawFace(context, facial, mouth);
  rotate(context, ornaments.haloDegrees, art.pivots.halo);
  context.translate(0, ornaments.haloOffsetY * art.canvas);
  drawGroup(context, 'halo', ornaments.sparkle);
  context.restore();
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ id: string, onReady?: () => void, onFailure?: () => void,
 *   onVisibilityChange?: (show: boolean) => void }} options
 */
export function createAngelRig(
  canvas,
  { id, onReady = () => {}, onFailure = () => {}, onVisibilityChange = () => {} },
) {
  const context = canvas.getContext('2d');
  let disposed = false,
    failed = !validMaster || !context || id !== ANGEL_ID;
  canvas.width = canvas.height = 512;
  canvas.hidden = true;
  canvas.setAttribute('aria-hidden', 'true');
  if (failed) onFailure();
  else onReady();
  return {
    render(frame) {
      const show = !disposed && !failed && frame.active && frame.characterId === ANGEL_ID;
      canvas.hidden = !show;
      onVisibilityChange(show);
      if (!show) return;
      try {
        drawAngel(context, frame);
      } catch {
        failed = true;
        canvas.hidden = true;
        onVisibilityChange(false);
        onFailure();
      }
    },
    dispose() {
      disposed = true;
      canvas.hidden = true;
      onVisibilityChange(false);
    },
  };
}
