/* node --test api/server/services/kadeSeedAudio.nodetest.js
 * The Seed Audio door (Oct 22 2026): which provider runs, what each is sent,
 * and what callers get back. No network: the http client is a stand-in. */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateSeed,
  seedProvider,
  seedUsdPerMin,
  seedWhere,
  byteplusBody,
  falBody,
  rateFrom,
  BYTEPLUS_URL,
  FAL_URL,
} = require('./kadeSeedAudio');

const BP = { BYTEPLUS_SEED_KEY: 'bp-test' };
const FAL = { FAL_KEY: 'fal-test' };
const BOTH = { ...BP, ...FAL };

function fakeHttp(answer) {
  const calls = [];
  return {
    calls,
    post: async (url, body, opts) => {
      calls.push({ method: 'post', url, body, opts });
      return typeof answer === 'function' ? answer(url, body, opts) : answer;
    },
    get: async (url, opts) => {
      calls.push({ method: 'get', url, opts });
      return { data: Buffer.alloc(4000, 7) };
    },
  };
}

test('provider choice: BytePlus first, fal second, a forced choice needs its key', () => {
  assert.equal(seedProvider(BOTH), 'byteplus');
  assert.equal(seedProvider(FAL), 'fal');
  assert.equal(seedProvider(BP), 'byteplus');
  assert.equal(seedProvider({}), null);
  assert.equal(seedProvider({ ...BOTH, KADE_SEED_PROVIDER: 'fal' }), 'fal');
  assert.equal(seedProvider({ ...FAL, KADE_SEED_PROVIDER: 'byteplus' }), null);
  assert.equal(seedProvider({ ...BOTH, KADE_SEED_PROVIDER: ' BytePlus ' }), 'byteplus');
});

test('price and wording follow the provider', () => {
  assert.equal(seedUsdPerMin(BP), 0.15);
  assert.equal(seedUsdPerMin(FAL), 0.1875);
  assert.equal(seedUsdPerMin({}), 0.1875);
  assert.match(seedWhere(BP), /BytePlus/);
  assert.match(seedWhere(FAL), /fal/);
});

test('times become BytePlus rates: half is -50, normal is 0, double is 100, clamped', () => {
  assert.equal(rateFrom(0.5), -50);
  assert.equal(rateFrom(1), 0);
  assert.equal(rateFrom(1.25), 25);
  assert.equal(rateFrom(2), 100);
  assert.equal(rateFrom(3), 100);
  assert.equal(rateFrom(0.1), -50);
  assert.equal(rateFrom(NaN), 0);
});

test('BytePlus body: model, prompt, audio config, clips beat a preset voice', () => {
  const b = byteplusBody({
    prompt: 'A diner at night. Marcus (the actor is @Audio1) says: "Coffee?"',
    format: 'mp3',
    sampleRate: 48000,
    speed: 1.2,
    volume: 1,
    pitch: -3,
    audioUrls: ['https://b2.example/a.wav', 'https://b2.example/b.wav'],
    voice: 'kian_en_zh',
  }, {});
  assert.equal(b.model, 'seed-audio-1.0');
  assert.match(b.text_prompt, /@Audio1/);
  assert.deepEqual(b.audio_config, { format: 'mp3', sample_rate: 48000, speech_rate: 20, pitch_rate: -3 });
  assert.deepEqual(b.references, [{ audio_url: 'https://b2.example/a.wav' }, { audio_url: 'https://b2.example/b.wav' }]);
  assert.deepEqual(b.watermark, { aigc_watermark: false });
});

test('BytePlus body: preset voice as a speaker, image alone, at most three clips, multilingual model', () => {
  assert.deepEqual(byteplusBody({ prompt: 'x', voice: 'kian_en_zh' }, {}).references, [{ speaker: 'kian_en_zh' }]);
  assert.deepEqual(byteplusBody({ prompt: 'x', imageUrl: 'https://b2.example/p.png', voice: 'v' }, {}).references, [{ image_url: 'https://b2.example/p.png' }]);
  assert.equal(byteplusBody({ prompt: 'x', audioUrls: ['https://a/1', 'https://a/2', 'https://a/3', 'https://a/4'] }, {}).references.length, 3);
  assert.equal(byteplusBody({ prompt: 'x', multilingual: true }, {}).model, 'seed-audio-1.0-multilingual');
  assert.equal(byteplusBody({ prompt: 'x' }, { KADE_SEED_MODEL: 'seed-audio-1.5' }).model, 'seed-audio-1.5');
  assert.equal(byteplusBody({ prompt: 'x', format: 'flac', sampleRate: 22050 }, {}).audio_config.format, 'wav');
  assert.equal(byteplusBody({ prompt: 'x', format: 'flac', sampleRate: 22050 }, {}).audio_config.sample_rate, 48000);
  assert.equal(byteplusBody({ prompt: 'x' }, {}).references, undefined);
});

test('fal body is exactly what the callers sent before', () => {
  assert.deepEqual(
    falBody({ prompt: 'p', format: 'wav', sampleRate: 48000, speed: 1.5, volume: 0.8, pitch: 2, multilingual: true, audioUrls: ['https://a/1'], voice: 'v' }),
    { prompt: 'p', output_format: 'wav', sample_rate: 48000, speed: 1.5, volume: 0.8, pitch: 2, multilingual: true, audio_urls: ['https://a/1'] },
  );
  assert.deepEqual(falBody({ prompt: 'p', format: 'mp3', voice: 'v' }), { prompt: 'p', output_format: 'mp3', sample_rate: 48000, voice: 'v' });
});

test('BytePlus answer: base64 audio becomes a Buffer, billed on original_duration', async () => {
  const audio = Buffer.alloc(9000, 3).toString('base64');
  const http = fakeHttp({ status: 200, data: { code: 0, audio, duration: 41.2, original_duration: 40.4, url: 'https://cdn.example/x.wav' } });
  const r = await generateSeed({ prompt: 'scene', format: 'wav' }, { env: BP, http });
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, BYTEPLUS_URL);
  assert.equal(http.calls[0].opts.headers['X-Api-Key'], 'bp-test');
  assert.match(http.calls[0].opts.headers['X-Api-Request-Id'], /^[0-9a-f-]{36}$/);
  assert.equal(r.provider, 'byteplus');
  assert.equal(r.service, 'byteplus_audio');
  assert.equal(r.buffer.length, 9000);
  assert.equal(r.url, null);
  assert.equal(r.seconds, 40);
  assert.equal(r.costUSD, 0.101); // 40.4 s at $0.15 a minute
  assert.equal(r.ext, 'wav');
  assert.equal(r.mime, 'audio/wav');
});

test('BytePlus answer with only a link: the file is fetched at once (the link dies in two hours)', async () => {
  const http = fakeHttp({ status: 200, data: { code: 0, original_duration: 12, url: 'https://cdn.example/x.mp3' } });
  const r = await generateSeed({ prompt: 'scene', format: 'mp3' }, { env: BP, http });
  assert.equal(http.calls[1].method, 'get');
  assert.equal(http.calls[1].url, 'https://cdn.example/x.mp3');
  assert.equal(r.buffer.length, 4000);
  assert.equal(r.ext, 'mp3');
});

test('BytePlus answer with a provider error and no audio throws in its own words', async () => {
  const http = fakeHttp({ status: 200, data: { code: 45000010, message: 'invalid api key' } });
  await assert.rejects(generateSeed({ prompt: 'scene' }, { env: BP, http }), (e) => {
    assert.equal(e.message, 'invalid api key');
    assert.equal(e.response.data.code, 45000010);
    return true;
  });
});

test('an empty answer is "no clip" (null), not an exception', async () => {
  assert.equal(await generateSeed({ prompt: 'scene' }, { env: BP, http: fakeHttp({ status: 200, data: {} }) }), null);
  assert.equal(await generateSeed({ prompt: 'scene' }, { env: FAL, http: fakeHttp({ status: 200, data: {} }) }), null);
});

test('fal answer: a durable link, priced at fal\'s rate', async () => {
  const http = fakeHttp({ status: 200, data: { audio: { url: 'https://fal.media/x.wav', duration: 60 } } });
  const r = await generateSeed({ prompt: 'scene', format: 'wav' }, { env: FAL, http });
  assert.equal(http.calls[0].url, FAL_URL);
  assert.equal(http.calls[0].opts.headers.Authorization, 'Key fal-test');
  assert.equal(r.provider, 'fal');
  assert.equal(r.url, 'https://fal.media/x.wav');
  assert.equal(r.buffer, null);
  assert.equal(r.costUSD, 0.188);
  assert.equal(r.service, 'fal_audio');
});

test('no key at all: a plain sentence, marked unavailable', async () => {
  await assert.rejects(generateSeed({ prompt: 'x' }, { env: {}, http: fakeHttp({}) }), (e) => {
    assert.equal(e.seedUnavailable, true);
    assert.match(e.message, /not configured/);
    return true;
  });
});

test('transport errors pass through untouched for providerError', async () => {
  const boom = Object.assign(new Error('Request failed with status code 401'), { response: { status: 401, data: { code: 45000010, message: 'unauthorized' } } });
  const http = { post: async () => { throw boom; } };
  await assert.rejects(generateSeed({ prompt: 'x' }, { env: BP, http }), (e) => e === boom);
});
