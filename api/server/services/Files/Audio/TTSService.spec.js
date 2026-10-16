/* Oct 16 2026: the listener's "Filler words and little sounds" switch reaches
 * the speech proxy body on both TTS lanes (/tts/manual multipart or JSON, and
 * the /tts auto-play stream), as a real boolean, and is left out when absent. */
jest.mock('axios', () => ({ post: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  genAzureEndpoint: jest.fn(),
  logAxiosError: jest.fn(),
  applyAxiosProxyConfig: jest.fn(),
  pipeSpeechAudio: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./streamAudio', () => ({
  getRandomVoiceId: jest.fn((voices) => voices[0]),
  createChunkProcessor: jest.fn(),
  splitTextIntoChunks: jest.fn(),
}));
jest.mock('./voiceCatalog', () => ({
  fetchLiveVoices: jest.fn().mockResolvedValue(['Kiana']),
  getCachedLiveVoices: jest.fn(() => ['Kiana']),
  getCachedLiveHidden: jest.fn(() => []),
  getCachedLiveAliases: jest.fn(() => []),
}));
jest.mock('~/models/kadeUsage', () => ({ logKadeUsage: jest.fn() }));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));
jest.mock('~/models/kadePronunciation', () => ({
  getUserDictionary: jest.fn().mockResolvedValue([]),
  applyPronunciationRespellings: jest.fn((text) => text),
}));

const axios = require('axios');
const { createChunkProcessor } = require('./streamAudio');
const { textToSpeech, streamAudio, parseKadeTtsFillers } = require('./TTSService');

const config = {
  speech: {
    tts: {
      openai: {
        url: 'http://speech-proxy.test/v1/audio/speech',
        apiKey: 'test-key',
        model: 'tts-1',
        voices: ['Kiana'],
      },
    },
  },
};

function makeRes() {
  const res = { headersSent: false };
  res.status = jest.fn(() => res);
  res.send = jest.fn(() => res);
  res.end = jest.fn(() => res);
  return res;
}

function manualReq(body) {
  return {
    body: { input: 'Hello there, friend.', voice: 'Kiana', ...body },
    user: { id: 'user-1' },
    config,
  };
}

function streamReq(body) {
  return {
    body: { voice: 'Kiana', messageId: 'message-1', ...body },
    user: { id: 'user-1' },
    config,
    on: jest.fn(),
  };
}

function lastProxyBody() {
  expect(axios.post).toHaveBeenCalled();
  const call = axios.post.mock.calls[axios.post.mock.calls.length - 1];
  return call[1];
}

function lastProxyHeaders() {
  const call = axios.post.mock.calls[axios.post.mock.calls.length - 1];
  return call[2].headers;
}

beforeEach(() => {
  axios.post.mockReset();
  axios.post.mockResolvedValue({ data: 'audio', headers: { 'content-type': 'audio/wav' } });
  createChunkProcessor.mockReset();
  createChunkProcessor.mockImplementation(() =>
    jest.fn().mockResolvedValue([{ text: 'Hello there, friend.', isFinished: true }]),
  );
});

describe('parseKadeTtsFillers', () => {
  it('reads booleans and the usual form spellings', () => {
    expect(parseKadeTtsFillers(true)).toBe(true);
    expect(parseKadeTtsFillers(false)).toBe(false);
    for (const on of ['true', '1', 'on', ' TRUE ', 'On']) {
      expect(parseKadeTtsFillers(on)).toBe(true);
    }
    for (const off of ['false', '0', 'off', ' False ', 'OFF']) {
      expect(parseKadeTtsFillers(off)).toBe(false);
    }
  });

  it('never guesses at anything else', () => {
    for (const odd of [undefined, null, '', 'yes', 'no', '2', 1, 0, {}, []]) {
      expect(parseKadeTtsFillers(odd)).toBeUndefined();
    }
  });
});

describe('/tts/manual sends the filler switch to the proxy', () => {
  it('sends fillers:false from a multipart form string', async () => {
    await textToSpeech(manualReq({ fillers: 'false', speed: '1.2' }), makeRes());
    const body = lastProxyBody();
    expect(body.fillers).toBe(false);
    expect(body.speed).toBe(1.2);
    expect(body.voice).toBe('Kiana');
  });

  it('sends fillers:true from a multipart form string', async () => {
    await textToSpeech(manualReq({ fillers: 'true' }), makeRes());
    expect(lastProxyBody().fillers).toBe(true);
  });

  it('sends a JSON boolean as it came', async () => {
    await textToSpeech(manualReq({ fillers: false }), makeRes());
    expect(lastProxyBody().fillers).toBe(false);
  });

  it('leaves fillers out when the caller did not send it, or sent nonsense', async () => {
    await textToSpeech(manualReq({}), makeRes());
    expect(lastProxyBody()).not.toHaveProperty('fillers');
    await textToSpeech(manualReq({ fillers: 'maybe' }), makeRes());
    expect(lastProxyBody()).not.toHaveProperty('fillers');
  });
});

describe('/tts auto-play stream matches the manual lane', () => {
  it('sends fillers:false, delivery and the seat key', async () => {
    await streamAudio(streamReq({ fillers: false, delivery: 'balanced', speed: 0.9 }), makeRes());
    const body = lastProxyBody();
    expect(body.fillers).toBe(false);
    expect(body.delivery).toBe('BALANCED');
    expect(body.speed).toBe(0.9);
    expect(lastProxyHeaders()['x-kade-tts-session']).toBe('user-1');
  });

  it('sends fillers:true', async () => {
    await streamAudio(streamReq({ fillers: true }), makeRes());
    expect(lastProxyBody().fillers).toBe(true);
  });

  it('leaves fillers and delivery out when absent', async () => {
    await streamAudio(streamReq({}), makeRes());
    const body = lastProxyBody();
    expect(body).not.toHaveProperty('fillers');
    expect(body).not.toHaveProperty('delivery');
    expect(lastProxyHeaders()['x-kade-tts-session']).toBe('user-1');
  });

  it('drops a delivery that is not one of the three', async () => {
    await streamAudio(streamReq({ delivery: 'LOUD' }), makeRes());
    expect(lastProxyBody()).not.toHaveProperty('delivery');
  });
});
