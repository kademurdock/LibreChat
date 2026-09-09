import CharacterMotion from './character-motion.mjs';
import CharacterPlayer from './character-player.mjs';

/** Adapts observed playback to the existing engine without retaining AudioBuffers. */
export function createCallCharacter({ resolveProfile, render, requestFrame, cancelFrame }) {
  let agentId = null, generation = 0, token = null, wanted = 'idle', clock = () => performance.now() / 1000;
  let disposed = false;
  let notBefore = 0;
  let refreshPending = false;
  const pending = new Set();
  const fallback = () => ({ id: agentId || 'unknown', rigReady: false });
  const player = CharacterPlayer.create({ character: fallback(), clock: () => clock(),
    render: frame => render(clock() < notBefore ? { ...frame, active: false, mouth: 0, blink: 0 } : frame),
    requestFrame, cancelFrame });

  function clear() {
    generation++;
    notBefore = 0;
    pending.clear();
    if (token) player.interrupt(token);
    token = null;
  }
  function rest() {
    if (pending.size || disposed) return;
    if (refreshPending) {
      refreshPending = false;
      let profile;
      try { profile = resolveProfile(agentId); } catch { /* static */ }
      player.select(profile || fallback()); token = null;
    }
    if (token) player.finish(token);
    token = wanted === 'listening' ? player.listen() : wanted === 'thinking' ? player.think() : null;
  }
  function select(id, start = 0) {
    if (disposed) return;
    clear();
    notBefore = start;
    agentId = id;
    let profile;
    try { profile = resolveProfile(id); } catch { /* Unknown rigs remain static. */ }
    try { player.select(profile || fallback()); }
    catch { player.select(fallback()); }
    rest();
  }
  return {
    select, clear,
    refreshProfile() { if (!disposed) { refreshPending = true; rest(); } },
    preferences(value) { if (!disposed) player.preferences(value); },
    status(value) {
      if (disposed) return;
      wanted = value;
      if (value === 'idle' || value === 'connecting') clear();
      rest();
    },
    scheduled(segment) {
      if (disposed) return;
      const nextId = segment.agentId === undefined ? agentId : segment.agentId;
      clock = segment.clock;
      if (nextId !== agentId) {
        select(nextId, segment.start);
      }
      if (!pending.size) token = player.speak();
      const owner = generation, currentToken = token, key = {};
      let envelope;
      try { if (segment.speech) envelope = CharacterMotion.envelope(segment.buffer); }
      catch { /* Invalid envelopes render closed mouths; speech continues. */ }
      if (!player.schedule(token, { start: segment.start, duration: segment.buffer?.duration,
        speech: segment.speech, envelope })) {
        if (!pending.size) { player.finish(token); token = null; }
        return;
      }
      pending.add(key);
      return () => {
        if (disposed || owner !== generation || token !== currentToken) return;
        pending.delete(key);
        rest();
      };
    },
    dispose() { clear(); disposed = true; player.dispose(); },
  };
}
