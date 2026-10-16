'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const axios = require('axios');
const filename = path.resolve(__dirname, '../../../packages/api/src/music/lyrics.ts');
const loaded = new Module(filename, module);
loaded.paths = module.paths;
loaded.require = (id) => id === '@librechat/data-schemas' ? { logger: { info() {}, warn() {}, error() {} } } : Module.prototype.require.call(loaded, id);
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const lyrics = loaded.exports;
process.env.OPENROUTER_KEY = 'test-only';
delete process.env.KADE_MUSIC_LISTENER_MODEL;
const audio = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(3000)]);

test('the default listener uses native MiMo Flash audio, preserves sung words/tags and never reads the Google key', async () => {
  const old = axios.defaults.adapter;
  let seen;
  axios.defaults.adapter = async (config) => {
    seen = { url: config.url, body: JSON.parse(config.data), auth: config.headers.Authorization };
    return { status: 200, statusText: 'OK', headers: {}, config,
      data: { choices: [{ finish_reason: 'stop', message: { content: '[Verse]\nKeep the fire low\n(Keep it low)' } }],
        usage: { prompt_tokens: 500, completion_tokens: 20 } } };
  };
  try {
    const result = await lyrics.transcribeMusicLyrics(audio, 'audio/mpeg', 12);
    assert.equal(seen.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(seen.body.model, 'xiaomi/mimo-v2.6-flash');
    assert.equal(seen.body.messages[0].content[1].input_audio.format, 'mp3');
    assert.equal(seen.body.reasoning.enabled, false);
    assert.equal(seen.body.provider.max_price.prompt, 0.14);
    // Kade's zero-retention rule: only zero-retention hosts that really hear Flash's audio.
    assert.equal(seen.body.provider.zdr, true);
    assert.equal(seen.body.provider.data_collection, 'deny');
    assert.deepEqual(seen.body.provider.only, ['Makora', 'Novita']);
    assert.match(result.transcript, /\[Verse\]\nKeep the fire low\n\(Keep it low\)/);
    assert.equal(result.model, 'xiaomi/mimo-v2.6-flash');
    assert.match(lyrics.lyricsWarning(result.model), /section tags are guesses/);
  } finally { axios.defaults.adapter = old; }
});

test('MiMo sound descriptions pass the same checker, and provider failures cannot trigger a Google key alarm', async () => {
  const old = axios.defaults.adapter;
  let failed = false;
  let alarms = 0;
  axios.defaults.adapter = async (config) => {
    if (failed) throw new axios.AxiosError('quota', 'ERR_BAD_REQUEST', config, {}, { status: 429, data: { error: { message: 'quota' } } });
    return { status: 200, statusText: 'OK', headers: {}, config,
      data: { choices: [{ finish_reason: 'stop', message: { content: 'English, R&B, Slow tempo, Female lead vocal, Warm voice, Electric piano, Deep bass, Soft drums' } }] } };
  };
  try {
    const result = await lyrics.describeMusicSound(audio, 'audio/mpeg', 12, () => alarms++);
    assert.equal(result.model, 'xiaomi/mimo-v2.6-flash');
    assert.match(result.direction, /electric piano/i);
    failed = true;
    assert.equal(await lyrics.describeMusicSound(audio, 'audio/mpeg', 12, () => alarms++), null);
    assert.equal(alarms, 0);
  } finally { axios.defaults.adapter = old; }
});
