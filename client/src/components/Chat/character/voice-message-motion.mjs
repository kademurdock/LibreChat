import AvatarExpression from './avatar-expression.mjs';
import { presencePose } from './presence.mjs';

// Sep 19 2026 (Kade: "I want it to respond to tags in chat like it does in
// call, I'm surprised it doesn't already"). The call renderer has always fed
// %%%directions%%% to the expression controller; this player never did, so a
// furious reply and a delighted one got the same gentle bob. A saved voice
// message is one audio file with no word timings, so each direction is placed
// by how far through the SPOKEN text it sits (tags, sound and table cues and
// markdown marks are not spoken and do not count). That is an estimate, good
// to about a sentence, which is the grain a change of expression needs. No
// network, no model, no inference about the words themselves: only the
// directions the character wrote for their own voice.
const UNSPOKEN = /%%%[^%\n]{1,160}%%%|\[(?:sound|table):[^\]\n]{0,120}\]|[*_`#>~|]+/g;
const CHARS_PER_SECOND = 14.5;
const LEAD = 0.12; // a face starts to change just before the voice does
const BLEND = 0.55; // seconds to travel between two expressions
const MOMENT = 0.9; // how long a laugh or a gasp holds the face

export function messageSpeechText(message) {
  if (!message || message.isCreatedByUser) return '';
  if (Array.isArray(message.content)) {
    let out = '';
    for (const part of message.content) {
      if (!part || part.type !== 'text') continue;
      const value = typeof part.text === 'string' ? part.text : part.text?.value;
      if (typeof value === 'string' && value) out += (out ? ' ' : '') + value;
    }
    if (out) return out.slice(0, 100000);
  }
  return typeof message.text === 'string' ? message.text.slice(0, 100000) : '';
}

/** Directions and sounds as {at, expression, kind}, `at` in seconds of audio. */
export function expressionSchedule(text, duration) {
  if (typeof text !== 'string' || !text || text.length > 100000) return [];
  const marks = AvatarExpression.timeline(text);
  if (!marks.length) return [];
  const spokenBefore = (end) => text.slice(0, end).replace(UNSPOKEN, '').replace(/\s+/g, ' ').length;
  const total = Math.max(1, spokenBefore(text.length));
  const seconds = Number.isFinite(duration) && duration > 0 ? duration : total / CHARS_PER_SECOND;
  return marks.map((mark) => ({
    at: Math.max(0, (spokenBefore(mark.offset) / total) * seconds - LEAD),
    expression: mark.expression,
    kind: mark.kind,
  }));
}

const smooth = (n) => {
  const x = Math.max(0, Math.min(1, n));
  return x * x * (3 - 2 * x);
};
const mix = (a, b, k) => {
  const out = {};
  for (const key of Object.keys(a)) out[key] = a[key] + (b[key] - a[key]) * k;
  return out;
};

/** The style in force at `time`: the last direction, blended in, with a sound's moment laid over it. */
export function styleAt(cues, time, extended = false) {
  const style = AvatarExpression.expressionStyle;
  let from = 'neutral', to = 'neutral', since = -Infinity, moment = null, name = 'neutral';
  for (const cue of cues || []) {
    if (cue.at > time) break;
    if (cue.kind === 'moment') {
      if (cue.expression && time - cue.at < MOMENT) moment = cue;
    } else {
      from = to; to = cue.expression || 'neutral'; since = cue.at; moment = null;
    }
  }
  name = to;
  const blend = smooth((time - since) / BLEND);
  let face = { from: AvatarExpression.expressionFace(from, extended), to: AvatarExpression.expressionFace(to, extended), blend };
  let current = mix(style(from), style(to), blend);
  if (moment) {
    const age = time - moment.at;
    const weight = Math.min(smooth(age / 0.15), smooth((MOMENT - age) / 0.3));
    current = mix(current, style(moment.expression), weight);
    name = moment.expression;
    // A laugh is the one sound with a face of its own.
    const shown = moment.expression === 'amused' ? 'laugh' : AvatarExpression.expressionFace(moment.expression, extended);
    face = { from: face.blend >= 0.5 ? face.to : face.from, to: shown, blend: weight };
  }
  return { style: current, expression: name, face };
}

// Mouth shapes without phonemes. A saved message has no word timings, so the
// shape follows what the sound itself gives: how loud (how open), how hissy
// (teeth together for s, f, th), and a new pick about every syllable so the
// lips keep moving between round, spread and open the way talking does.
// Index into the mouth sheet; 0 means closed and lets the expression's own mouth show.
export function visemeAt(time, strength, sibilance = 0, seed = 0) {
  if (!(strength > 0.06)) return 0;
  if (sibilance > 0.32 && strength < 0.5) return 7;
  const slot = Math.floor(time / 0.14);
  let h = (Math.imul(slot + 1, 2654435761) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  const r = ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  if (strength < 0.25) return r < 0.6 ? 1 : r < 0.8 ? 4 : 7;
  if (strength < 0.55) return r < 0.45 ? 2 : r < 0.75 ? 5 : 4;
  return r < 0.4 ? 3 : r < 0.75 ? 8 : 2;
}

export function voiceMessagePose({ id, time, level = 0, active, cues, sibilance = 0 }) {
  const still = { characterId: id, active: false, expression: 'neutral', mouth: 0, blink: 0, brow: 0, tilt: 0, nod: 0 };
  if (!active || !Number.isFinite(time) || time < 0) return still;
  let seed = 5381;
  for (const byte of new TextEncoder().encode(id || 'unknown'))
    seed = (Math.imul(seed, 33) + byte) >>> 0;
  const phase = (seed % 1000) / 1000;
  const { style, expression, face } = styleAt(cues, time, true);
  const period = (4.3 + phase * 0.8) * Math.max(0.5, Math.min(1.6, style.blink));
  const t = time + phase * period,
    blinkPhase = t % period;
  const secondBlink =
    Math.floor(t / period) % 3 === 1 && blinkPhase > period - 0.52 && blinkPhase < period - 0.36;
  let blink = 0;
  if (secondBlink) blink = Math.sin(((blinkPhase - period + 0.52) / 0.16) * Math.PI);
  else if (blinkPhase > period - 0.2)
    blink = Math.sin(((blinkPhase - period + 0.2) / 0.2) * Math.PI);
  const strength = Number.isFinite(level) ? Math.max(0, Math.min(1, (level - 0.008) * 5)) : 0;
  const tempo = (id === 'agent_BSOLa3eNEZyjs-7abCjMt' ? 0.8 : 1) * style.tempo;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const presence = presencePose(id, time, strength, expression);
  return {
    characterId: id,
    active: true,
    expression,
    face,
    viseme: visemeAt(time, strength, sibilance, seed),
    brow: clamp(
      style.brow +
        strength * (style.browTalk + 0.25 * Math.sin(t * 0.65 * tempo)) +
        Math.max(0, Math.sin(t * 0.43 * tempo)) * 0.12 * (1 - strength),
      0,
      1,
    ),
    mouth: strength,
    blink,
    tilt: clamp(
      style.tilt * 0.6 + (Math.sin(t * 0.3 * tempo) * 0.28 + Math.sin(t * 0.7 * tempo) * 0.32) * style.sway + presence.tilt,
      -presence.tiltLimit,
      presence.tiltLimit,
    ),
    nod: clamp(Math.sin(t * 1.1 * tempo) * (0.18 + strength * 0.4) * style.nod + style.lift + presence.nod, -presence.nodLimit, presence.nodLimit),
    scale: presence.scale,
  };
}

export function messageCharacterId(message) {
  if (!message || message.isCreatedByUser) return null;
  return (
    [message.agent_id, message.model].find(
      (id) => typeof id === 'string' && /^agent_[A-Za-z0-9_-]{1,100}$/.test(id),
    ) || null
  );
}
