/* Sweep 5.0 (Nov 13 2026): with automatic read-aloud on, a voice request that hangs or is
 * cancelled after it was claimed must not leave the reply unspoken and unannounced. */
import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import type { MutableSnapshot } from 'recoil';
import { act, render } from '@testing-library/react';
import StreamAudio from '../StreamAudio';
import store from '~/store';

let mockParamId = 'new';
const mockAnnounce = jest.fn();
const mockPauseGlobalAudio = jest.fn();
const mockLatestMessage = {
  messageId: 'reply-1',
  conversationId: 'chat-1',
  isCreatedByUser: false,
  createdAt: new Date().toISOString(),
  text: 'Hello there.',
  sender: 'Kiana',
};

jest.mock('react-router-dom', () => ({
  useParams: () => ({ conversationId: mockParamId }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ getQueryData: () => [] }),
}));
jest.mock('~/hooks/Audio', () => ({
  useCustomAudioRef: () => ({ audioRef: { current: null } }),
  MediaSourceAppender: jest.fn(),
  usePauseGlobalAudio: () => ({ pauseGlobalAudio: mockPauseGlobalAudio }),
}));
jest.mock('~/hooks/Messages/useLatestMessage', () => ({
  useLatestMessage: () => mockLatestMessage,
}));
jest.mock('~/utils', () => ({
  getLatestText: (message?: { text?: string }) => message?.text ?? '',
  getAllContentText: (message?: { text?: string }) => message?.text ?? '',
  logger: { log: jest.fn(), error: jest.fn() },
}));
jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ token: 'test-token' }),
  useLocalize: () => (key: string) => key,
}));
jest.mock('~/Providers', () => ({
  useLiveAnnouncer: () => ({ announcePolite: mockAnnounce }),
}));
jest.mock('~/utils/voicePace', () => ({
  generationRate: () => undefined,
  voiceCacheKey: () => 'cache-key',
  voiceCacheText: (message?: { text?: string }) => message?.text ?? '',
  storeVoiceAudio: jest.fn(),
  deliveryFor: () => undefined,
}));
jest.mock('~/hooks/Audio/speech', () => ({
  consumeSpeechAudio: jest.fn(),
  speechAudioBlob: jest.fn(),
  playOrReport: jest.fn(),
}));
jest.mock('~/hooks/Audio/voiceFocus', () => ({ claimVoice: jest.fn() }));
jest.mock('../../character/voice-playback.mjs', () => ({
  watchVoiceAudio: jest.fn(),
  stopWatchingVoiceAudio: jest.fn(),
}));
jest.mock('../../character/voice-message-motion.mjs', () => ({
  messageCharacterId: () => null,
}));
jest.mock('../../character/timing-track.mjs', () => ({ faceTimingsAllowed: () => false }));
jest.mock('../../character/useVoicePortraitPreference', () => ({
  useVoicePortraitPreference: () => [false],
}));

const seen: { audioRun: string | null; fetching: boolean } = { audioRun: null, fetching: false };
function Probe() {
  seen.audioRun = useRecoilValue(store.audioRunFamily(0));
  seen.fetching = useRecoilValue(store.globalAudioFetchingFamily(0));
  return null;
}
const startState = ({ set }: MutableSnapshot) => {
  set(store.activeRunFamily(0), 'run-1');
  set(store.automaticPlayback, true);
};
const tree = () => (
  <RecoilRoot initializeState={startState}>
    <StreamAudio />
    <Probe />
  </RecoilRoot>
);
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
};

let fetchMock: jest.Mock;
let signals: AbortSignal[];
beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  mockParamId = 'new';
  mockAnnounce.mockReset();
  mockPauseGlobalAudio.mockReset();
  seen.audioRun = null;
  seen.fetching = false;
  signals = [];
  // A speech host that accepts the request and never answers.
  fetchMock = jest.fn((_url: string, init: { signal: AbortSignal }) => {
    signals.push(init.signal);
    return new Promise(() => undefined);
  });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { open: async () => ({ match: async () => undefined }) },
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
  jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('a speech request that never answers is given up after 25 s and the reply is announced', async () => {
  const { unmount } = render(tree());
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(seen.fetching).toBe(true);
  expect(seen.audioRun).toBe(null); // not claimed: no clip has been shown

  await act(async () => {
    jest.advanceTimersByTime(24000);
  });
  await settle();
  expect(mockAnnounce).not.toHaveBeenCalled();

  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  await settle();
  expect(mockAnnounce).toHaveBeenCalledWith({
    message: 'com_ui_read_aloud_failed',
    isStatus: true,
  });
  expect(mockAnnounce).toHaveBeenCalledWith({ message: 'Hello there.' });
  expect(seen.fetching).toBe(false);
  expect(seen.audioRun).toBe('run-1'); // marked as tried, so it does not loop
  expect(signals[0].aborted).toBe(true); // the dead request is dropped after the announcement
  expect(fetchMock).toHaveBeenCalledTimes(1);
  unmount();
});

test('a request cancelled by the new chat getting its address is asked again, not left claimed', async () => {
  const { rerender, unmount } = render(tree());
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  mockParamId = 'chat-1'; // /c/new -> /c/chat-1: the scope of the speech request changes
  rerender(tree());
  await settle();
  expect(signals[0].aborted).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2); // the voice tries again for the same reply
  expect(seen.fetching).toBe(true);
  expect(signals[1].aborted).toBe(false);
  unmount();
});

test('with the kadeVoiceFallback undo switch off, the old early claim and endless wait are back', async () => {
  localStorage.setItem('kadeVoiceFallback', '0');
  const { rerender, unmount } = render(tree());
  await settle();
  expect(seen.audioRun).toBe('run-1'); // claimed before the request
  await act(async () => {
    jest.advanceTimersByTime(120000);
  });
  await settle();
  expect(mockAnnounce).not.toHaveBeenCalled(); // no timeout
  mockParamId = 'chat-1';
  rerender(tree());
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(1); // and no retry after the cancel
  unmount();
});

test('the address change of the same chat does not pause its reply voice; another chat does', async () => {
  const { rerender, unmount } = render(tree());
  await settle();
  const onMount = mockPauseGlobalAudio.mock.calls.length;
  mockParamId = 'chat-1'; // the chat on screen (mockLatestMessage.conversationId)
  rerender(tree());
  await settle();
  expect(mockPauseGlobalAudio).toHaveBeenCalledTimes(onMount);
  mockParamId = 'chat-2'; // she opened a different chat
  rerender(tree());
  await settle();
  expect(mockPauseGlobalAudio).toHaveBeenCalledTimes(onMount + 1);
  unmount();
});
