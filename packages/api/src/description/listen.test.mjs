/*
 * Nov 14 2026: the describer's repeat check (listen.ts) hears back a narration take that ran long.
 * Novita no longer serves MiMo and Makora's price rose over the old cap, so by OpenRouter's endpoint
 * list no host could take the call and every take fell back to length alone, silently. The take is
 * the platform's own narration, so it may go to a host that keeps it but never to one that trains:
 * Makora first, then Xiaomi, at most Makora's price, and the log says which host heard it, or why
 * none did. No model is called: axios answers through a fake adapter.
 * Run (see the lane's tooling): node --import tsx --test src/description/listen.test.mjs
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createRequire } from 'node:module';
import { listen } from './listen.ts';
import { sampleRate } from './mix.ts';

const axios = createRequire(import.meta.url)('axios');
const signal = new AbortController().signal;
/** A take of `seconds` of sound at the engine's own sample rate. */
const take = (seconds) => new Float32Array(Math.round(seconds * sampleRate)).fill(0.1);
const ENV = [
  'OPENROUTER_KEY',
  'KADE_VOICE_LISTEN',
  'KADE_VOICE_LISTEN_HOSTS',
  'KADE_VOICE_LISTEN_MODEL',
];
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
const realAdapter = axios.defaults.adapter;
afterEach(() => {
  axios.defaults.adapter = realAdapter;
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

/** Answers every request from `handler(n, config)` (n counts from 1), until the test ends. */
function fakeAxios(handler) {
  const calls = [];
  axios.defaults.adapter = async (config) => {
    calls.push({ url: config.url, body: JSON.parse(config.data), config });
    const reply = await handler(calls.length, config);
    if (reply instanceof Error) throw reply;
    return { status: 200, statusText: 'OK', headers: {}, data: reply, config };
  };
  return calls;
}
const heard = (provider, text = 'A red square. A red square.', promptTokens = 61) => ({
  provider,
  choices: [{ finish_reason: 'stop', message: { content: text } }],
  usage: { prompt_tokens: promptTokens },
});
const httpError = (config, status, data) =>
  new axios.AxiosError(
    `Request failed with status code ${status}`,
    'ERR_BAD_REQUEST',
    config,
    {},
    {
      status,
      statusText: '',
      headers: {},
      data,
      config,
    },
  );

test("the repeat check asks Makora, then Xiaomi, keeps out hosts that train, and pays at most Makora's price", async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  delete process.env.KADE_VOICE_LISTEN_HOSTS;
  const calls = fakeAxios(() => heard('Makora'));
  const lines = [];
  const words = await listen(take(2), signal, (line) => lines.push(line));
  assert.equal(words, 'A red square. A red square.');
  assert.equal(calls.length, 1);
  const { body, config, url } = calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(body.model, 'xiaomi/mimo-v2.6-flash');
  assert.deepEqual(body.provider, {
    order: ['Makora', 'Xiaomi'],
    only: ['Makora', 'Xiaomi'],
    allow_fallbacks: true,
    data_collection: 'deny',
    max_price: { prompt: 0.18, completion: 0.36 },
  });
  assert.equal(
    body.provider.zdr,
    undefined,
    "the platform's own narration may be kept, never trained on",
  );
  assert.equal(body.user, undefined, 'no user id goes with it');
  assert.equal(body.messages[0].content[1].type, 'input_audio');
  assert.equal(config.timeout, 15000);
  assert.deepEqual(lines, ['listen: Makora heard the take (61 prompt tokens)']);
});

test('a host that did not hear the take, a refusal and a failure each answer null, and the log says why', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const lines = [];
  const log = (line) => lines.push(line);
  /* 46 prompt tokens is the prompt's words alone: the audio never reached the model. */
  fakeAxios(() => heard('Xiaomi', 'A red square.', 46));
  assert.equal(await listen(take(2), signal, log), null);
  fakeAxios(() => ({
    provider: 'Makora',
    choices: [{ finish_reason: 'content_filter', message: { content: 'No.' } }],
    usage: { prompt_tokens: 61 },
  }));
  assert.equal(await listen(take(2), signal, log), null);
  fakeAxios((_n, config) =>
    httpError(config, 404, {
      error: { message: 'No allowed providers are available for the selected model.' },
    }),
  );
  assert.equal(await listen(take(2), signal, log), null);
  fakeAxios(
    (_n, config) => new axios.AxiosError('timeout of 15000ms exceeded', 'ECONNABORTED', config),
  );
  assert.equal(await listen(take(2), signal, log), null);
  assert.deepEqual(lines, [
    'listen: Xiaomi answered without the words (46 prompt tokens); length decides',
    'listen: Makora answered without the words (content_filter); length decides',
    'listen: no host heard the take (HTTP 404: No allowed providers are available for the selected model.); length decides',
    'listen: no host heard the take (ECONNABORTED); length decides',
  ]);
  assert.ok(
    lines.every((line) => !line.includes('test-key')),
    'never the key',
  );
});

test('our own stop still ends the run: an aborted take throws instead of answering null', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  fakeAxios(() => heard('Makora'));
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(listen(take(2), stop.signal, () => {}));
});

test('KADE_VOICE_LISTEN_HOSTS picks the hosts in its order; no key, a take too short, or KADE_VOICE_LISTEN=0 asks nobody', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  process.env.KADE_VOICE_LISTEN_HOSTS = ' Cohere , Makora ';
  const calls = fakeAxios(() => heard('Cohere'));
  assert.ok(await listen(take(2), signal));
  assert.deepEqual(calls[0].body.provider.order, ['Cohere', 'Makora']);
  assert.deepEqual(calls[0].body.provider.only, ['Cohere', 'Makora']);
  assert.equal(await listen(take(0.1), signal), null);
  process.env.KADE_VOICE_LISTEN = '0';
  assert.equal(await listen(take(2), signal), null);
  delete process.env.KADE_VOICE_LISTEN;
  delete process.env.OPENROUTER_KEY;
  assert.equal(await listen(take(2), signal), null);
  assert.equal(calls.length, 1);
});
