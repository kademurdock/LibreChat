import CharacterMotion from './character-motion.mjs';
import CharacterPlayer from './character-player.mjs';
import { readCues } from './cues.mjs';

/** Keeps speaker ownership on the audio timeline, independently of visual frames. */
export function createCallCharacter({ resolveProfile, render, requestFrame, cancelFrame,
  setTimer = setTimeout, cancelTimer = clearTimeout }) {
  let agentId = null, token = null, wanted = 'idle', clock = () => performance.now() / 1000;
  let disposed = false, refreshPending = false, wake = null, current = null, speaking = false;
  let queue = [];
  const fallback = () => ({ id: agentId || 'unknown', rigReady: false });
  const player = CharacterPlayer.create({ character: fallback(), clock: () => clock(),
    render, requestFrame, cancelFrame });

  function cancelWake() { if (wake !== null) cancelTimer(wake); wake = null; }
  function profile() {
    let value;
    try { value = resolveProfile(agentId); } catch { /* Unknown rigs remain static. */ }
    try { player.select(value || fallback()); } catch { player.select(fallback()); }
    token = null; speaking = false; refreshPending = false;
  }
  function clear() {
    cancelWake(); queue = []; current = null;
    if (token) player.interrupt(token);
    token = null; speaking = false;
  }
  function rest() {
    if (disposed || current || queue.length) return;
    if (refreshPending) profile();
    if (token) player.finish(token);
    speaking = false;
    token = wanted === 'listening' ? player.listen() : wanted === 'thinking' ? player.think() : null;
  }
  function reconcile() {
    cancelWake();
    if (disposed) return;
    const now = clock();
    if (!Number.isFinite(now) || now < 0) return;
    if (current && now >= current.end) {
      current = null;
    }
    let next = null;
    while (queue.length && queue[0].start <= now) next = queue.shift();
    if (next) {
      if (next.agentId !== agentId || refreshPending) { agentId = next.agentId; profile(); }
      if (next.end > now) {
        current = next;
        if (!speaking) { token = player.speak(); speaking = true; }
        player.schedule(token, next);
      }
    }
    rest();
    const boundary = current?.end ?? queue[0]?.start;
    if (boundary === undefined) return;
    // Boundary wakes also run with motion off. Suspended audio is rechecked
    // slowly; neither wall time nor captions are allowed to advance a face.
    const scheduledAt = now;
    wake = setTimer(() => {
      wake = null;
      if (clock() <= scheduledAt) { wake = setTimer(reconcile, 1000); return; }
      reconcile();
    }, Math.max(16, (boundary - now) * 1000));
  }
  return {
    select(id) {
      if (disposed) return;
      clear(); agentId = id; profile(); rest();
    },
    clear,
    refreshProfile() { if (!disposed) { refreshPending = true; rest(); } },
    preferences(value) { if (!disposed) { reconcile(); player.preferences(value); } },
    status(value) {
      if (disposed) return;
      wanted = value;
      if (value === 'idle' || value === 'connecting') clear();
      reconcile();
    },
    scheduled(segment) {
      if (disposed || !segment || typeof segment.clock !== 'function') return;
      const duration = segment.buffer?.duration, start = segment.start;
      const tail = queue.at(-1) || current;
      if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 ||
          duration > 120 || queue.length >= 64 || (tail && start < tail.end - .000001)) return;
      let envelope;
      try { if (segment.speech) envelope = CharacterMotion.envelope(segment.buffer); }
      catch { /* Invalid envelopes render closed mouths; speech continues. */ }
      const nextId = segment.agentId === undefined ? (tail?.agentId ?? agentId) : segment.agentId;
      const clip = { start, duration, end: start + duration, speech: segment.speech, envelope,
        cues: [{ at: 0, tag: 'reset' }, ...(segment.speech ? readCues(segment.cues, duration) : [])],
        agentId: typeof nextId === 'string' && nextId.length <= 128 ? nextId : null };
      clock = segment.clock;
      queue.push(clip); reconcile();
      return () => {
        if (disposed || (current !== clip && !queue.includes(clip))) return;
        // Audio ended can precede device playout. clear() cancels interruptions.
        reconcile();
      };
    },
    dispose() { clear(); disposed = true; player.dispose(); },
  };
}
