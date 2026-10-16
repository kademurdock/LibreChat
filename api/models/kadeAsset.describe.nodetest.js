/* Oct 16 2026 — what the gallery describer sends to OpenRouter. MiMo Pro is the
 * default, only Gemini's Pro models get the low-effort reasoning pass, and
 * every request carries the zero-retention provider block.
 * Run: node --test api/models/kadeAsset.describe.nodetest.js (no network, no database). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mongoose = require('mongoose');

const source = fs.readFileSync(path.join(__dirname, 'kadeAsset.js'), 'utf8');
/* Objects built inside the vm carry its own prototypes; compare them as plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

function fixture(env = {}, { realCost = null, choice = { message: { content: 'A described scene.' } } } = {}) {
  const calls = { post: [], usage: [], updates: [] };
  const modelModule = { exports: {} };
  const stubs = {
    mongoose: new mongoose.Mongoose(),
    axios: {
      get: async () => ({ data: Buffer.from('media'), headers: {} }),
      post: async (...args) => {
        calls.post.push(args);
        return {
          data: {
            choices: [choice],
            usage: { prompt_tokens: 1e6, completion_tokens: 1e6 },
          },
        };
      },
    },
    '@librechat/data-schemas': { logger: { info() {}, warn() {} } },
    '@librechat/api': { saveURLToS3: async () => null },
    '~/server/services/kadeRealCost': { openRouterCost: () => realCost },
    '~/models/kadeUsage': { logKadeUsage: (row) => calls.usage.push(row) },
  };
  vm.runInNewContext(source + '\nmodule.exports.enrichAsset = enrichAsset;', {
    require: (id) => {
      assert.ok(id in stubs, `Unexpected dependency: ${id}`);
      return stubs[id];
    },
    module: modelModule,
    process: { env: { OPENROUTER_KEY: 'test-only', KADE_ASSET_MIRROR: '0', ...env } },
    setImmediate: () => {},
    Buffer,
  }, { filename: 'kadeAsset.js' });
  const { KadeAsset, logKadeAsset, enrichAsset } = modelModule.exports;
  KadeAsset.create = async (values) => new KadeAsset(values);
  KadeAsset.updateOne = async (...args) => { calls.updates.push(plain(args)); };
  const describe = async (kind, extra = {}, { modelCalls = 1 } = {}) => {
    const doc = await logKadeAsset({
      userId: new mongoose.Types.ObjectId(), kind, service: 'fal_' + kind,
      url: `https://example.invalid/${kind}`, prompt: 'A red barn at dusk.', ...extra,
    });
    await enrichAsset(doc);
    assert.equal(calls.post.length, modelCalls, 'model calls');
    const [url, body] = calls.post[0];
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    return { body, usage: calls.usage, updates: calls.updates };
  };
  return { describe };
}

const ZERO_RETENTION = { zdr: true, data_collection: 'deny', order: ['DeepInfra'], allow_fallbacks: true };

test('MiMo Pro is the default and describes a picture with reasoning off, the normal limit and zero retention', async () => {
  const { body, usage } = await fixture().describe('image');
  assert.equal(body.model, 'xiaomi/mimo-v2.6-pro');
  assert.equal(body.max_tokens, 260);
  assert.deepEqual(plain(body.reasoning), { enabled: false });
  assert.deepEqual(plain(body.provider), ZERO_RETENTION);
  assert.equal(body.messages[0].content[1].type, 'image_url');
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(usage[0].metadata.model, 'xiaomi/mimo-v2.6-pro');
});

test('a video goes to MiMo Pro as a video part under the same settings', async () => {
  const { body } = await fixture().describe('video');
  assert.equal(body.model, 'xiaomi/mimo-v2.6-pro');
  assert.equal(body.max_tokens, 260);
  assert.deepEqual(plain(body.reasoning), { enabled: false });
  assert.deepEqual(plain(body.provider), ZERO_RETENTION);
  assert.equal(body.messages[0].content[1].type, 'video_url');
  assert.match(body.messages[0].content[1].video_url.url, /^data:video\/mp4;base64,/);
});

test('an audio clip, described from its direction, keeps reasoning off and zero retention', async () => {
  const { body } = await fixture().describe('audio', { metadata: { aukTask: 'speech' } });
  assert.equal(body.model, 'xiaomi/mimo-v2.6-pro');
  assert.equal(body.max_tokens, 900);
  assert.deepEqual(plain(body.reasoning), { enabled: false });
  assert.deepEqual(plain(body.provider), ZERO_RETENTION);
});

for (const model of ['xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-flash', 'example/vision-pro']) {
  test(`${model} set on Railway is not treated as a Gemini Pro: no reasoning pass`, async () => {
    const { body } = await fixture({ KADE_ASSET_DESCRIBE_MODEL: model }).describe('image');
    assert.equal(body.model, model);
    assert.equal(body.max_tokens, 260);
    assert.deepEqual(plain(body.reasoning), { enabled: false });
    assert.deepEqual(plain(body.provider), ZERO_RETENTION);
  });
}

for (const model of ['google/gemini-3.1-pro-preview', 'google/gemini-2.5-pro']) {
  test(`${model} cannot switch reasoning off: brief hidden thinking with room for it`, async () => {
    const { body } = await fixture({ KADE_ASSET_DESCRIBE_MODEL: model }).describe('image');
    assert.equal(body.model, model);
    assert.equal(body.max_tokens, 2260);
    assert.deepEqual(plain(body.reasoning), { effort: 'low', exclude: true });
    assert.deepEqual(plain(body.provider), ZERO_RETENTION);
  });
}

test('Gemini Flash is not a Pro either', async () => {
  const { body } = await fixture({ KADE_ASSET_DESCRIBE_MODEL: 'google/gemini-3.8-flash' }).describe('image');
  assert.deepEqual(plain(body.reasoning), { enabled: false });
  assert.equal(body.max_tokens, 260);
});

test('a reply naming no cost is priced at the running model rates', async () => {
  /* 1M tokens in and 1M out, so the cost is the two per-million rates added. */
  const pro = await fixture().describe('image');
  near(pro.usage[0].costUSD, 1.305);
  const flash = await fixture({ KADE_ASSET_DESCRIBE_MODEL: 'xiaomi/mimo-v2.6-flash' }).describe('image');
  near(flash.usage[0].costUSD, 0.42);
  const tuned = await fixture({ KADE_ASSET_DESCRIBE_IN_USD_PER_M: '1', KADE_ASSET_DESCRIBE_OUT_USD_PER_M: '2' }).describe('image');
  near(tuned.usage[0].costUSD, 3);
  const reported = await fixture({}, { realCost: 0.0123 }).describe('image');
  assert.equal(reported.usage[0].costUSD, 0.0123);
});

test('a content_filter refusal is never saved as the description', async () => {
  const refusal = { finish_reason: 'content_filter', message: { content: 'The request was rejected because it was considered high risk' } };
  // The refused look is followed by the usual fallback call, which here is refused too.
  const { updates } = await fixture({}, { choice: refusal }).describe('image', {}, { modelCalls: 2 });
  assert.ok(!JSON.stringify(updates).includes('considered high risk'), JSON.stringify(updates));
  const ok = await fixture().describe('image');
  assert.ok(JSON.stringify(ok.updates).includes('A described scene.'));
});
