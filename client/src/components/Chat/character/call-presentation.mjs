import AvatarExpression from './avatar-expression.mjs';
import { voiceMessagePose } from './voice-message-motion.mjs';

const expressions = new Set(AvatarExpression.expressions);
const identityValid = (id) => typeof id === 'string' && /^agent_[A-Za-z0-9_-]{1,100}$/.test(id);

export function characterAudioIdentity(value) {
  if (
    !value ||
    value.type !== 'character-audio' ||
    value.version !== 1 ||
    typeof value.speech !== 'boolean' ||
    (value.speech && !identityValid(value.speakerId))
  )
    return null;
  return {
    speakerId: identityValid(value.speakerId) ? value.speakerId : null,
    speech: value.speech,
    expression: expressions.has(value.expression) ? value.expression : 'neutral',
    moment: expressions.has(value.moment) ? value.moment : null,
  };
}

export function authoredCallIdentity(speakerId, text) {
  if (!identityValid(speakerId)) return null;
  let expression = 'neutral',
    moment = null,
    rest = typeof text === 'string' ? text.slice(0, 1024) : '';
  for (let i = 0; i < 8; i++) {
    const match = rest.match(/^\s*%%%([^%\n]{1,160})%%%/);
    if (!match) break;
    const cue = AvatarExpression.cue(match[1]);
    if (cue.kind === 'moment') moment = cue.expression;
    else {
      expression = cue.expression;
      moment = null;
    }
    rest = rest.slice(match[0].length);
  }
  return { speakerId, speech: true, expression, moment };
}

export function outputLevel(samples) {
  let energy = 0,
    crossings = 0;
  if (!samples?.length) return { level: 0, sibilance: 0 };
  for (let i = 0; i < samples.length; i++) {
    const value = Number.isFinite(samples[i]) ? samples[i] : 0;
    energy += value * value;
    if (i > 0 && value >= 0 !== samples[i - 1] >= 0) crossings++;
  }
  return { level: Math.sqrt(energy / samples.length), sibilance: crossings / samples.length };
}

/** A bounded observation of successfully scheduled audio; never owns playback. */
export function createCallPresentation() {
  let generation = 0,
    serial = 0,
    clips = [],
    lastClock = null;
  function clear() {
    generation++;
    clips = [];
    lastClock = null;
  }
  function current(time) {
    if (!Number.isFinite(time) || time < 0) return null;
    const now = Math.max(time, lastClock ?? time);
    lastClock = now;
    clips = clips.filter((clip) => clip.start + clip.duration > now);
    return clips.find((clip) => clip.start <= now) ?? null;
  }
  return {
    token: () => generation,
    clear,
    schedule(token, start, duration, identity) {
      if (
        token !== generation ||
        !Number.isFinite(start) ||
        start < 0 ||
        !Number.isFinite(duration) ||
        duration <= 0 ||
        duration > 120
      )
        return null;
      const tail = clips.at(-1);
      if (clips.length >= 64 || (tail && start < tail.start + tail.duration - 0.000001))
        return null;
      const observedIdentity = identity
        ? Object.freeze({ ...identity })
        : null;
      const clip = Object.freeze({ start, duration, identity: observedIdentity, token: ++serial });
      clips.push(clip);
      return clip.token;
    },
    finish(token) {
      clips = clips.filter((clip) => clip.token !== token);
    },
    current,
    pose({
      id,
      time,
      level = 0,
      sibilance = 0,
      enabled,
      visible,
      reducedMotion,
      running,
      status,
      live,
    }) {
      const clip = current(time);
      const identity = clip?.identity;
      const ownsSpeech = !!identity?.speech && identity.speakerId === id;
      const waitingForSpeech = !!clip && !ownsSpeech;
      const usable = enabled && visible && !reducedMotion && running && !live;
      const active =
        usable &&
        !waitingForSpeech &&
        (ownsSpeech || status === 'listening' || status === 'thinking');
      const cues = [];
      if (ownsSpeech) {
        cues.push({ at: clip.start, expression: identity.expression, kind: 'direction' });
        if (identity.moment)
          cues.push({ at: clip.start, expression: identity.moment, kind: 'moment' });
      }
      return voiceMessagePose({ id, time, level: ownsSpeech ? level : 0, sibilance, active, cues });
    },
  };
}
