import { act, renderHook } from '@testing-library/react';
import useStreamingCall from './useStreamingCall';
import type { StreamingStartArgs } from './useStreamingCall';

jest.mock('./character/call-presentation.mjs', () => ({
  characterAudioIdentity: (m: { speakerId?: string }) =>
    m && m.speakerId
      ? { speakerId: m.speakerId, speech: true, expression: 'neutral', moment: null }
      : null,
}));
// Nov 11 2026: the real reader is ESM (.mjs is not transformed here); this stand-in reads the same
// `kdtm` chunk position the proxy writes, so the test checks the wiring, not the parser (which has
// its own node:test suite, timing-track.test.mjs).
jest.mock('./character/timing-track.mjs', () => ({
  faceTimingsAllowed: () => true,
  trackFits: (track: { dur: number } | null, seconds: number) =>
    !!track && Math.abs(track.dur - seconds * 1000) <= 250,
  readTimingTrack: (buffer: ArrayBuffer) => {
    const bytes = new Uint8Array(buffer);
    const id = String.fromCharCode(...bytes.subarray(36, 40));
    if (id !== 'kdtm') return null;
    const size = new DataView(buffer).getUint32(40, true);
    return JSON.parse(String.fromCharCode(...bytes.subarray(44, 44 + size))); // ASCII JSON
  },
}));

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

// A WAV the way the voice proxy writes it with a face track: fmt, kdtm, data.
function wavWithTrack(track: object | null) {
  // jsdom has no TextEncoder; the track JSON here is ASCII
  const json = track
    ? Uint8Array.from(JSON.stringify(track), (c) => c.charCodeAt(0))
    : new Uint8Array(0);
  const pad = json.length % 2;
  const extra = track ? 8 + json.length + pad : 0;
  const out = new Uint8Array(44 + extra + 48);
  const view = new DataView(out.buffer);
  const put = (at: number, text: string) => {
    for (let i = 0; i < 4; i++) out[at + i] = text.charCodeAt(i);
  };
  put(0, 'RIFF');
  view.setUint32(4, out.length - 8, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  let at = 36;
  if (track) {
    put(at, 'kdtm');
    view.setUint32(at + 4, json.length, true);
    out.set(json, at + 8);
    at += 8 + json.length + pad;
  }
  put(at, 'data');
  view.setUint32(at + 4, 48, true);
  return out.buffer;
}

test('a WAV carrying a face track still decodes and plays, and its track reaches the presentation', async () => {
  const track = {
    v: 1,
    src: 'inworld',
    set: 'oxr',
    dur: 1000,
    vis: [[0, 1000, 'aa']],
    cov: [[0, 1000]],
  };
  const decoded: ArrayBuffer[] = [];
  const started: number[] = [];
  const ctx = {
    currentTime: 0,
    destination: {},
    decodeAudioData: jest.fn(async (ab: ArrayBuffer) => {
      decoded.push(ab);
      return { duration: 1 } as AudioBuffer;
    }),
    createBufferSource: () => ({
      buffer: null,
      connect: jest.fn(),
      start: (t: number) => started.push(t),
      onended: null,
    }),
  } as unknown as AudioContext;
  const presentation = {
    token: () => 1,
    clear: jest.fn(),
    schedule: jest.fn(() => 7),
    finish: jest.fn(),
  };
  const { result, unmount } = renderHook(() => useStreamingCall());
  const call = result.current.start({
    ...args(),
    ctx,
    presentation: presentation as unknown as StreamingStartArgs['presentation'],
  });
  await settle();
  const socket = Socket.instances[0];
  socket.ready();
  await call;
  const speak = () =>
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'character-audio',
        version: 1,
        speech: true,
        speakerId: 'agent_x',
      }),
    });
  speak();
  socket.onmessage?.({ data: wavWithTrack(track) });
  speak();
  socket.onmessage?.({ data: wavWithTrack(null) });
  await settle();
  await settle();
  expect(decoded).toHaveLength(2);
  expect(started).toHaveLength(2);
  expect(presentation.schedule).toHaveBeenCalledTimes(2);
  const [first, second] = presentation.schedule.mock.calls as unknown as unknown[][];
  expect(first[4]).toEqual(track);
  expect(second[4]).toBeNull();
  unmount();
});
