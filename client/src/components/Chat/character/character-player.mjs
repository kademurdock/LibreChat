import CharacterMotion from './character-motion.mjs';
'use strict';

const CharacterPlayer = (() => {
  const motion = CharacterMotion;

  // Observes the caller's playback clock. Never starts/stops/connects audio,
  // opens a microphone, or modifies the caller's callbacks or speech text.
  function create({ character, clock, render, requestFrame, cancelFrame }) {
    const state = motion.create(character);
    let frameId = null, disposed = false, failed = false;
    function cancel() { if (frameId !== null) cancelFrame(frameId); frameId = null; }
    function update() {
      cancel();
      if (disposed || failed) return;
      try {
        const frame = state.sample(clock());
        render(frame);
        if (frame.needsFrame) frameId = requestFrame(update);
      } catch {
        failed = true;
        state.preferences({ enabled: false });
        // A renderer failure must reveal its static portrait, not break audio.
        try { render(state.sample(0)); } catch { /* caller's fallback may also be unavailable */ }
      }
    }
    return {
      preferences(value) { state.preferences(value); update(); },
      select(value) { state.select(value); failed = false; update(); },
      listen() { const token = state.listen(clock()); update(); return token; },
      think() { const token = state.think(clock()); update(); return token; },
      speak() { const token = state.speak(clock()); update(); return token; },
      schedule(token, segment) {
        try { const accepted = state.schedule(token, segment); update(); return accepted; }
        catch { return false; } // malformed visual metadata never prevents speech
      },
      finish(token) { const accepted = state.finish(token); update(); return accepted; },
      interrupt(token) { const accepted = state.interrupt(token); update(); return accepted; },
      dispose() { disposed = true; cancel(); state.dispose(); },
    };
  }
  return { create };
})();
export default CharacterPlayer;
