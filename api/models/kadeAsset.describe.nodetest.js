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

function fixture(env = {}, { realCost = null, choice = { message: { content: 'A described scene.' } }, provider, answer } = {}) {
  const calls = { post: [], usage: [], updates: [], warnings: [] };
  const modelModule = { exports: {} };
  const stubs = {
    mongoose: new mongoose.Mongoose(),
    axios: {
      get: async () => ({ data: Buffer.from('media'), headers: {} }),
      post: async (...args) => {
        calls.post.push(args);
        /* `answer(n)` scripts each reply (n counts from 1); it may throw as axios does. */
        if (answer) return { data: answer(calls.post.length) };
        return {
          data: {
            ...(provider ? { provider } : {}),
            choices: [choice],
            usage: { prompt_tokens: 1e6, completion_tokens: 1e6 },
          },
        };
      },
    },
    '@librechat/data-schemas': { logger: { info() {}, warn: (line) => calls.warnings.push(line) } },
    '@librechat/api': { saveURLToS3: async () => null },
    '~/server/services/kadeRealCost': { openRouterCost: () => realCost },
    '~/models/kadeUsage': { logKadeUsage: (row) => calls.usage.push(row) },
    '~/server/services/kadeMediaRoute': require('../server/services/kadeMediaRoute'),
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
    return {
      body,
      bodies: calls.post.map(([, sent]) => sent),
      configs: calls.post.map(([, , config]) => config),
      usage: calls.usage,
      updates: calls.updates,
      warnings: calls.warnings,
    };
  };
  return { describe };
}

const ZERO_RETENTION = { zdr: true, data_collection: 'deny', order: ['DeepInfra'], allow_fallbacks: true };
/* A video only to Novita, the one zero-retention host that hears a MiMo video's soundtrack
 * (Oct 16 2026 probe: DeepInfra drops it and looks at a fixed handful of frames). */
const HEARING_VIDEO = { zdr: true, data_collection: 'deny', only: ['Novita'], allow_fallbacks: true };

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

test('KADE_VIDEO_MODEL=mimo: a video goes to MiMo Pro as a video part, only to the zero-retention host that heard it', async () => {
  const { body } = await fixture({ KADE_VIDEO_MODEL: 'mimo' }).describe('video');
  assert.equal(body.model, 'xiaomi/mimo-v2.6-pro');
  assert.equal(body.max_tokens, 260);
  assert.deepEqual(plain(body.reasoning), { enabled: false });
  assert.deepEqual(plain(body.provider), HEARING_VIDEO);
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
    assert.deepEqual(
      plain(body.provider),
      model.startsWith('xiaomi/') ? ZERO_RETENTION : { zdr: true, data_collection: 'deny' },
    );
  });
}

for (const model of ['google/gemini-3.1-pro-preview', 'google/gemini-2.5-pro']) {
  test(`${model} cannot switch reasoning off: brief hidden thinking with room for it`, async () => {
    const { body } = await fixture({ KADE_ASSET_DESCRIBE_MODEL: model }).describe('image');
    assert.equal(body.model, model);
    assert.equal(body.max_tokens, 2260);
    assert.deepEqual(plain(body.reasoning), { effort: 'low', exclude: true });
    /* Vertex is zero-retention; AI Studio (her own key, billed double) is never asked. */
    assert.deepEqual(plain(body.provider), { zdr: true, data_collection: 'deny', ignore: ['google-ai-studio'] });
  });
}

test('Gemini Flash cannot switch thinking off, so it gets the least thinking and room for it', async () => {
  /* Live Nov 13 2026: reasoning off answers HTTP 400 "Reasoning is mandatory for this endpoint". */
  const { body } = await fixture({ KADE_ASSET_DESCRIBE_MODEL: 'google/gemini-3.8-flash' }).describe('image');
  assert.deepEqual(plain(body.reasoning), { effort: 'minimal', exclude: true });
  assert.equal(body.max_tokens, 2260);
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

test('a video answered by a host that cannot hear its soundtrack is never saved; the prompt fallback runs', async () => {
  /* Two calls: the video's answer was thrown away, and the second is the text-only fallback. */
  const deaf = await fixture({ KADE_VIDEO_MODEL: 'mimo' }, { provider: 'DeepInfra' }).describe('video', {}, { modelCalls: 2 });
  assert.equal(deaf.bodies[0].messages[0].content[1].type, 'video_url');
  assert.equal(deaf.bodies[1].messages[0].content.length, 1);
  assert.match(deaf.bodies[1].messages[0].content[0].text, /Likely shows:/);
  /* The fallback sends only the prompt's words, so any zero-retention host may answer it. */
  assert.deepEqual(plain(deaf.bodies[1].provider), ZERO_RETENTION);
  const heard = await fixture({ KADE_VIDEO_MODEL: 'mimo' }, { provider: 'Novita' }).describe('video');
  assert.ok(JSON.stringify(heard.updates).includes('A described scene.'));
});

/* Nov 14 2026: what a gallery video sends on Google Vertex's flex tier, and on the standard tier. */
const FLEX = {
  zdr: true,
  data_collection: 'deny',
  only: ['google-vertex/global/flex'],
  ignore: ['google-ai-studio'],
  allow_fallbacks: false,
};
const STANDARD = { zdr: true, data_collection: 'deny', ignore: ['google-ai-studio'] };
const described = { provider: 'Google', choices: [{ finish_reason: 'stop', message: { content: 'A described scene.' } }], usage: { prompt_tokens: 1e6, completion_tokens: 1e6 } };
const httpError = (status) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status, data: {} } });

/* Nov 13 2026: Novita stopped serving MiMo, so by default a gallery video goes to the video model.
 * Nov 14 2026: on Vertex's flex tier first, half the price, zero retention kept. */
test('by default a gallery video goes to the video model on Google Vertex flex, and its usage row names that model', async () => {
  const { body, configs, usage } = await fixture({}, { provider: 'Google' }).describe('video');
  assert.equal(body.model, 'google/gemini-3.8-flash');
  assert.deepEqual(plain(body.reasoning), { effort: 'minimal', exclude: true });
  assert.equal(body.max_tokens, 2260);
  assert.deepEqual(plain(body.provider), FLEX);
  assert.equal(configs[0].timeout, 210000, 'two minutes more for Google\'s queue');
  assert.equal(body.messages[0].content[1].type, 'video_url');
  assert.equal(usage[0].metadata.model, 'google/gemini-3.8-flash');
  /* 1M tokens in and 1M out at the video model's flex rates, not MiMo's. */
  near(usage[0].costUSD, 0.375 + 1.875);
});

test('a gallery video that flex turns away is asked once more on the standard tier, and its description is kept', async () => {
  const { bodies, configs, usage, updates, warnings } = await fixture({}, {
    answer: (n) => {
      if (n === 1) throw httpError(503);
      return described;
    },
  }).describe('video', {}, { modelCalls: 2 });
  assert.deepEqual(plain(bodies[0].provider), FLEX);
  assert.deepEqual(plain(bodies[1].provider), STANDARD);
  assert.equal(configs[1].timeout, 90000);
  assert.equal(bodies[1].messages[0].content[1].type, 'video_url', 'the same video, not the prompt fallback');
  assert.ok(JSON.stringify(updates).includes('A described scene.'));
  /* The flex try never answered, so only the standard reply is booked, at the standard video rates. */
  assert.equal(usage.length, 1);
  near(usage[0].costUSD, 0.825 + 4.125);
  assert.deepEqual(warnings, ['[kadeAsset] the flex try failed (HTTP 503); asking again on the standard tier']);
});

test('a flex reply cut off at its limit is booked and asked again on standard', async () => {
  const cut = { provider: 'Google', choices: [{ finish_reason: 'length', message: { content: 'A described sc' } }], usage: { prompt_tokens: 1e6, completion_tokens: 1e6 } };
  const { bodies, usage, updates } = await fixture({}, { answer: (n) => (n === 1 ? cut : described) }).describe('video', {}, { modelCalls: 2 });
  assert.deepEqual(plain(bodies[1].provider), STANDARD);
  assert.ok(JSON.stringify(updates).includes('A described scene.'));
  assert.equal(usage.length, 2, 'both replies are paid for');
  near(usage[0].costUSD, 0.375 + 1.875);
  near(usage[1].costUSD, 0.825 + 4.125);
});

test('a bad request on flex goes to the prompt fallback, never to a second video request', async () => {
  const { bodies } = await fixture({}, {
    answer: (n) => {
      if (n === 1) throw httpError(400);
      return described;
    },
  }).describe('video', {}, { modelCalls: 2 });
  assert.equal(bodies[1].messages[0].content.length, 1);
  assert.match(bodies[1].messages[0].content[0].text, /Likely shows:/);
});

test('a gallery picture never asks flex, even on a Google model; KADE_VIDEO_TIER=standard keeps videos on standard', async () => {
  const picture = await fixture({ KADE_ASSET_DESCRIBE_MODEL: 'google/gemini-3.8-flash' }, { provider: 'Google' }).describe('image');
  assert.deepEqual(plain(picture.body.provider), STANDARD);
  assert.equal(picture.configs[0].timeout, 90000);
  const video = await fixture({ KADE_VIDEO_TIER: 'standard' }, { provider: 'Google' }).describe('video');
  assert.deepEqual(plain(video.body.provider), STANDARD);
  assert.equal(video.configs[0].timeout, 90000);
  near(video.usage[0].costUSD, 0.825 + 4.125);
});

test('a gallery picture still goes to MiMo Pro with reasoning off and the normal limit', async () => {
  const { body } = await fixture().describe('image');
  assert.equal(body.model, 'xiaomi/mimo-v2.6-pro');
  assert.deepEqual(plain(body.reasoning), { enabled: false });
  assert.equal(body.max_tokens, 260);
});
