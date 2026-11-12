import { claimVoice, silenceAllVoices } from './voiceFocus';

function player(connected = true) {
  const audio = document.createElement('audio');
  let paused = false;
  Object.defineProperty(audio, 'paused', { get: () => paused });
  Object.defineProperty(audio, 'isConnected', { get: () => connected });
  const pause = jest.fn(() => {
    if (paused) return;
    paused = true;
    audio.dispatchEvent(new Event('pause'));
  });
  audio.pause = pause;
  audio.load = jest.fn();
  return { audio, pause, resume: () => (paused = false) };
}

afterEach(() => {
  silenceAllVoices();
  localStorage.removeItem('kadeOneVoice');
});

test('the player that starts pauses the one that was speaking', () => {
  const a = player();
  const b = player();
  claimVoice(a.audio);
  claimVoice(a.audio); // 'playing' fires again after a stall
  claimVoice(b.audio);
  expect(a.pause).toHaveBeenCalledTimes(1);
  expect(b.pause).not.toHaveBeenCalled();
  a.resume();
  claimVoice(a.audio);
  expect(b.pause).toHaveBeenCalledTimes(1);
  expect(a.pause).toHaveBeenCalledTimes(1);
});

test('silenceAllVoices pauses and empties a clip that is not in the page', () => {
  const c = player(false);
  claimVoice(c.audio);
  silenceAllVoices();
  expect(c.pause).toHaveBeenCalledTimes(1);
  expect(c.audio.load).toHaveBeenCalledTimes(1);
  silenceAllVoices();
  expect(c.pause).toHaveBeenCalledTimes(1);
});

test('a missing element is ignored', () => {
  expect(() => claimVoice(null)).not.toThrow();
});

test('the kadeOneVoice undo switch leaves both voices alone', () => {
  localStorage.setItem('kadeOneVoice', '0');
  const a = player();
  const b = player();
  claimVoice(a.audio);
  claimVoice(b.audio);
  expect(a.pause).not.toHaveBeenCalled();
});
