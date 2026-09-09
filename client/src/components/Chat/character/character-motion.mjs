import AvatarExpression from './avatar-expression.mjs';
'use strict';

// Optional presentation only. The caller owns audio, character access and text.
const CharacterMotion = (() => {
  const expressions = AvatarExpression;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const finite = (n) => typeof n === 'number' && Number.isFinite(n);

  function profile(config) {
    if (!config || typeof config.id !== 'string' || !config.id.trim()) throw new TypeError('Character ID required');
    return Object.freeze({
      id: config.id,
      name: String(config.name || config.id),
      // Readiness is explicit. An arbitrary portrait cannot be animated as a rig.
      rigReady: config.rigReady === true,
      nodDegrees: clamp(finite(config.nodDegrees) ? config.nodDegrees : 2, 0, 4),
      tiltDegrees: clamp(finite(config.tiltDegrees) ? config.tiltDegrees : 3, 0, 5),
      mouthGain: clamp(finite(config.mouthGain) ? config.mouthGain : 5, 1, 10),
    });
  }

  // Reuse an ALREADY decoded buffer. No requests, resampling or changes to sound.
  // RMS windows are bounded in duration and work; unknown/live PCM falls back to
  // a closed mouth until the caller supplies an actual audio envelope.
  function envelope(buffer, windowSeconds = 0.02) {
    if (!buffer || !finite(buffer.duration) || buffer.duration <= 0 || buffer.duration > 120 ||
        !finite(buffer.sampleRate) || buffer.sampleRate < 8000 || buffer.sampleRate > 192000 ||
        !Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 8 ||
        !finite(windowSeconds) || windowSeconds < 0.01 || windowSeconds > 0.1) throw new RangeError('Unsupported audio buffer');
    const stride = Math.max(1, Math.round(buffer.sampleRate * windowSeconds));
    const count = Math.ceil(buffer.length / stride);
    if (!Number.isInteger(buffer.length) || buffer.length <= 0 || count > 12000) throw new RangeError('Unsupported audio length');
    const levels = new Float32Array(count);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let i = 0; i < count; i++) {
        const end = Math.min((i + 1) * stride, samples.length);
        let sum = 0;
        for (let j = i * stride; j < end; j++) sum += finite(samples[j]) ? samples[j] * samples[j] : 0;
        // Max channel avoids stereo phase cancellation.
        levels[i] = Math.max(levels[i], Math.sqrt(sum / Math.max(1, end - i * stride)));
      }
    }
    return { levels, step: stride / buffer.sampleRate, duration: buffer.duration };
  }

  function create(config) {
    let character = profile(config), generation = 0, owner = null, mode = 'idle';
    let enabled = false, reduced = false, visible = true, since = 0, lastClock = null;
    let queue = [], current = null, cueIndex = 0, expiry = null;
    const expression = expressions.controller();
    const owns = (token) => token !== null && token === owner;
    const reset = () => { queue = []; current = null; cueIndex = 0; expiry = null; lastClock = null; };
    function begin(state, time = 0) {
      if (!finite(time) || time < 0) throw new RangeError('Clock required');
      if (owner) expression.stop(owner);
      owner = Object.freeze({ generation: ++generation, characterId: character.id });
      reset(); mode = state; since = time; expression.start(owner);
      return owner;
    }
    function preferences(next) {
      if ('enabled' in next) enabled = next.enabled === true;
      if ('reducedMotion' in next) reduced = next.reducedMotion === true;
      if ('visible' in next) visible = next.visible === true;
    }
    function schedule(token, clip) {
      if (!owns(token) || mode !== 'speaking') return false;
      if (!clip || !finite(clip.start) || clip.start < 0 || !finite(clip.duration) || clip.duration <= 0 || clip.duration > 120) throw new RangeError('Audio schedule required');
      const tail = queue.at(-1) || current;
      if (tail && clip.start < tail.start + tail.duration - 0.000001) throw new RangeError('Overlapping or out-of-order audio');
      if (queue.length >= 64) throw new RangeError('Animation queue full');
      const cues = clip.cues || [];
      if (!Array.isArray(cues) || cues.length > 128) throw new RangeError('Too many cues');
      let previous = -1;
      const copied = cues.map(cue => {
        if (!finite(cue.at) || cue.at < previous || cue.at < 0 || cue.at >= clip.duration || typeof cue.tag !== 'string' || cue.tag.length > 160) throw new RangeError('Cue needs an ordered audio-relative time');
        previous = cue.at;
        return { at: cue.at, tag: cue.tag };
      });
      const amp = clip.envelope;
      if (amp && (!(amp.levels instanceof Float32Array) || amp.levels.length > 12000 || !finite(amp.step) || amp.step <= 0)) throw new RangeError('Invalid audio envelope');
      queue.push({ start: clip.start, duration: clip.duration, cues: copied,
        envelope: amp ? { step: amp.step, levels: amp.levels.slice() } : null,
        speech: clip.speech !== false });
      return true;
    }
    function sample(time) {
      if (!finite(time) || time < 0) throw new RangeError('Clock required');
      // Never replay old cues if a caller supplies a stale clock.
      time = Math.max(lastClock ?? time, time); lastClock = time;
      if (mode === 'speaking') {
        while (true) {
          if (!current && queue.length && queue[0].start <= time) { current = queue.shift(); cueIndex = 0; }
          if (!current) break;
          const offset = time - current.start;
          while (cueIndex < current.cues.length && current.cues[cueIndex].at <= offset) {
            const cue = current.cues[cueIndex++];
            const state = expression.apply(owner, cue.tag);
            expiry = state.moment ? { at: Math.min(current.start + current.duration, current.start + cue.at + 0.7), revision: state.revision } : null;
          }
          if (expiry && time >= expiry.at) { expression.endMoment(owner, expiry.revision); expiry = null; }
          if (offset < current.duration) break;
          current = null;
        }
      }
      const active = enabled && !reduced && visible && character.rigReady;
      const state = expression.state();
      const frame = { characterId: character.id, mode, active, expression: active ? state.expression : 'neutral',
        mouth: 0, blink: 0, nod: 0, tilt: 0, needsFrame: active && ['listening', 'thinking', 'speaking'].includes(mode) };
      if (!active || !frame.needsFrame) return frame;
      const elapsed = Math.max(0, time - since);
      const blinkPhase = elapsed % 4.7;
      frame.blink = blinkPhase > 4.5 ? Math.sin((blinkPhase - 4.5) / 0.2 * Math.PI) : 0;
      if (mode === 'listening') {
        const nodPhase = elapsed % 7.3;
        frame.nod = nodPhase > 6.5 ? Math.sin((nodPhase - 6.5) / 0.8 * Math.PI) * character.nodDegrees : 0;
        frame.tilt = Math.sin(elapsed * 0.35) * character.tiltDegrees;
      }
      if (mode === 'speaking' && current?.speech && current.envelope) {
        const index = Math.floor((time - current.start) / current.envelope.step);
        const rms = current.envelope.levels[index] || 0;
        frame.mouth = finite(rms) ? clamp((rms - 0.008) * character.mouthGain, 0, 1) : 0;
      }
      return frame;
    }
    return {
      listen: (time) => begin('listening', time),
      think: (time) => begin('thinking', time),
      speak: (time) => begin('speaking', time),
      schedule, sample, preferences,
      finish(token) { if (!owns(token)) return false; begin('idle'); return true; },
      interrupt(token) { if (!owns(token)) return false; begin('interrupted'); return true; },
      select(config) { character = profile(config); begin('idle'); },
      dispose() { begin('idle'); enabled = false; owner = null; },
    };
  }
  return { create, envelope, profile };
})();
export default CharacterMotion;
