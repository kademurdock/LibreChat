'use strict';
/* Nov 13 2026 (sweep): a recording with no words in it. The voice proxy answers
 * { text: '', reason: 'no_speech', message }; the site hands that on as an empty transcript with
 * the plain message, never a 500. The service is loaded with its libraries replaced by stand-ins.
 * Run: node --test api/server/services/Files/Audio/STTService.noSpeech.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

let answer = { status: 200, data: {} };
function load() {
  const original = Module._load;
  Module._load = function (id, parent, isMain) {
    if (id === 'axios') return { post: async () => answer };
    if (id === 'form-data') return class {};
    if (id === '@librechat/data-schemas') return { logger: { debug() {}, warn() {}, error() {}, info() {} } };
    if (id === '@librechat/api') return { genAzureEndpoint() {}, logAxiosError() {}, applyAxiosProxyConfig() {} };
    if (id === 'librechat-data-provider') return { extractEnvVariable: (v) => v, STTProviders: { OPENAI: 'openai' } };
    if (id === '~/server/services/Config') return { getAppConfig: async () => ({}) };
    return original.call(this, id, parent, isMain);
  };
  try {
    const file = path.join(__dirname, 'STTService.js');
    delete require.cache[file];
    return require(file);
  } finally {
    Module._load = original;
  }
}
const S = load();

test('the proxy\'s "nothing was said" answer is read as an answer', () => {
  assert.deepEqual(S.noSpeechAnswer({ text: '', reason: 'no_speech', message: 'I did not hear any words.' }), { text: '', reason: 'no_speech', message: 'I did not hear any words.' });
  assert.deepEqual(S.noSpeechAnswer({ text: '  ', reason: 'no_speech' }), { text: '', reason: 'no_speech', message: S.NO_SPEECH_MESSAGE });
  assert.equal(S.noSpeechAnswer({ reason: 'no_speech', message: `${'long '.repeat(200)}` }).message.length <= 300, true);
  for (const other of [{ text: 'hello', reason: 'no_speech' }, { text: '' }, { text: '', reason: 'error' }, null, undefined, 'x', {}]) {
    assert.equal(S.noSpeechAnswer(other), null, JSON.stringify(other));
  }
});

function service() {
  const svc = Object.create(S.STTService.prototype);
  svc.providerStrategies = { openai: () => ['https://proxy.example/stt', {}, {}] };
  svc.getProviderSchema = async () => ['openai', {}];
  return svc;
}
const call = async (data, status = 200) => {
  answer = { status, data };
  const sent = {};
  const res = { json: (b) => ((sent.json = b), res), status: (c) => ((sent.status = c), res), sendStatus: (c) => ((sent.status = c), res) };
  const fs = require('fs').promises;
  const os = require('os');
  const file = path.join(os.tmpdir(), `kade-stt-${process.pid}-${Date.now()}.webm`);
  await fs.writeFile(file, Buffer.from([1, 2, 3]));
  await service().processSpeechToText({ file: { path: file, originalname: 'a.webm', mimetype: 'audio/webm', size: 3 }, body: {} }, res);
  return sent;
};

test('no words: an empty transcript with the plain message, not an error', async () => {
  assert.deepEqual(await call({ text: '', reason: 'no_speech', message: "I didn't catch any words. Try again a little closer to the microphone." }), {
    json: { text: '', reason: 'no_speech', message: "I didn't catch any words. Try again a little closer to the microphone." },
  });
});

test('words: the transcript, exactly as before', async () => {
  assert.deepEqual(await call({ text: '  hello there  ' }), { json: { text: 'hello there' } });
});

test('a truly empty or broken answer is still a failure, as before', async () => {
  assert.deepEqual(await call({ text: '' }), { status: 500 });
  assert.deepEqual(await call({}), { status: 500 });
  assert.deepEqual(await call({ text: 'x' }, 502), { status: 500 });
});
