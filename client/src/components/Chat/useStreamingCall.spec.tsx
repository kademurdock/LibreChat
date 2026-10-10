import { act, renderHook } from '@testing-library/react';
import useStreamingCall from './useStreamingCall';
import type { StreamingStartArgs } from './useStreamingCall';

jest.mock('./character/call-presentation.mjs', () => ({ characterAudioIdentity: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  close = jest.fn();
  send = jest.fn();
  onopen?: () => void;
  onmessage?: (event: { data: string | ArrayBuffer }) => void;
  onclose?: () => void;
  constructor() {
    Socket.instances.push(this);
  }

  ready() {
    this.onmessage?.({ data: '{"type":"ready"}' });
  }
}

class MicContext {
  state = 'running';
  destination = {};
  sampleRate = 48000;
  close = jest.fn(async () => {});
  createMediaStreamSource() {
    return { connect: jest.fn() };
  }

  createScriptProcessor() {
    return {
      onaudioprocess: null,
      connect: jest.fn(() => ({ connect: jest.fn() })),
      disconnect: jest.fn(),
    };
  }

  createGain() {
    return { gain: { value: 0 }, connect: jest.fn() };
  }
}

const media = () => {
  const stop = jest.fn();
  return { stream: { getTracks: () => [{ stop }] } as unknown as MediaStream, stop };
};
const ticket = () =>
  Promise.resolve({
    ok: true,
    json: async () => ({ ticket: 'test-ticket', wsUrl: 'wss://test.invalid' }),
  });
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
};
function args(): StreamingStartArgs {
  return {
    ctx: { currentTime: 0 } as AudioContext,
    analyser: null,
    handlers: {
      onStatus: jest.fn(),
      onUserCaption: jest.fn(),
      onAgentCaption: jest.fn(),
      onError: jest.fn(),
      onEnded: jest.fn(),
    },
  };
}

let fetchMock: jest.Mock;
let micMock: jest.Mock;
beforeEach(() => {
  Socket.instances = [];
  fetchMock = jest.fn(ticket);
  micMock = jest.fn(async () => media().stream);
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: MicContext });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: micMock },
  });
});

test('a stale ticket failure cannot stop a newer connected session', async () => {
  const stale = deferred<Response>();
  fetchMock.mockImplementationOnce(() => stale.promise);
  const { result, unmount } = renderHook(() => useStreamingCall());
  const first = result.current.start(args());
  result.current.stop(false);
  const current = result.current.start(args());
  await settle();
  Socket.instances[0].ready();
  await current;
  stale.reject(new Error('old ticket failed'));
  await first;
  expect(result.current.isActive()).toBe(true);
  expect(Socket.instances[0].close).not.toHaveBeenCalled();
  unmount();
});

test('a microphone granted after hangup is stopped without replacing the newer microphone', async () => {
  const stale = deferred<MediaStream>();
  const oldMic = media();
  const newMic = media();
  micMock.mockImplementationOnce(() => stale.promise).mockResolvedValueOnce(newMic.stream);
  const { result, unmount } = renderHook(() => useStreamingCall());
  const first = result.current.start(args());
  await settle();
  result.current.stop(false);
  const current = result.current.start(args());
  await settle();
  Socket.instances[0].ready();
  await current;
  stale.resolve(oldMic.stream);
  await first;
  expect(oldMic.stop).toHaveBeenCalledTimes(1);
  expect(newMic.stop).not.toHaveBeenCalled();
  expect(Socket.instances).toHaveLength(1);
  expect(result.current.isActive()).toBe(true);
  unmount();
  expect(newMic.stop).toHaveBeenCalledTimes(1);
});

test('late close from an old socket cannot end or clear a newer call; unmount releases the current session', async () => {
  const { result, unmount } = renderHook(() => useStreamingCall());
  const firstArgs = args();
  const first = result.current.start(firstArgs);
  await settle();
  const oldSocket = Socket.instances[0];
  oldSocket.ready();
  await first;
  result.current.stop(false);
  const currentArgs = args();
  const current = result.current.start(currentArgs);
  await settle();
  const newSocket = Socket.instances[1];
  newSocket.ready();
  await current;
  oldSocket.onclose?.();
  expect(currentArgs.handlers.onEnded).not.toHaveBeenCalled();
  expect(result.current.isActive()).toBe(true);
  expect(newSocket.close).not.toHaveBeenCalled();
  unmount();
  expect(newSocket.close).toHaveBeenCalledTimes(1);
  expect(result.current.isActive()).toBe(false);
});
