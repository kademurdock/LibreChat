// Presentation observes existing players. It never starts/stops audio or fetches TTS.
const listeners = new Set();
let current = null;
const observed = new WeakMap();
const emit = value => { current = value; for (const listener of listeners) listener(); };
export const voicePlayback = {
  subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
  snapshot() { return current; },
};
export function watchVoiceAudio(audio, messageId) {
  if (!audio || typeof messageId !== 'string' || !messageId) return () => {};
  const previous = observed.get(audio);
  if (previous?.messageId === messageId) { previous.refresh(); return previous.dispose; }
  previous?.dispose();
  let disposed = false, stalled = false;
  const publish = (claim = false) => {
    if (!claim && current?.audio !== audio) return;
    if (disposed) return;
    if (audio.ended || !audio.currentSrc && !audio.src) return clear();
    // A paused element that has never played must not steal another portrait.
    if (audio.paused && current?.audio !== audio) return;
    const phase = audio.paused ? 'paused' : stalled ? 'waiting' : 'playing';
    if (current?.audio === audio && current.messageId === messageId && current.phase === phase) return;
    emit({ audio, messageId, phase });
  };
  const clear = () => { if (current?.audio === audio) emit(null); };
  const playing = () => { stalled = false; publish(true); };
  const waiting = () => { stalled = true; publish(); };
  const events = { playing, play: waiting, pause: publish, waiting, seeking: waiting, seeked: playing,
    ended: clear, emptied: clear, error: clear, abort: clear };
  for (const [event, handler] of Object.entries(events)) audio.addEventListener(event, handler);
  const dispose = () => {
    if (disposed) return; disposed = true;
    for (const [event, handler] of Object.entries(events)) audio.removeEventListener(event, handler);
    if (observed.get(audio)?.dispose === dispose) observed.delete(audio);
    clear();
  };
  observed.set(audio, { messageId, dispose, refresh: playing });
  publish(!audio.paused);
  return dispose;
}
export function stopWatchingVoiceAudio(audio) { observed.get(audio)?.dispose(); }
