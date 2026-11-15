/* Nov 15 2026 (Amber A's report 6ac95f1a): on Oct 9 Lux asked /v1/flux-pro-1.1 for a 1024x1536
 * picture and BFL refused it (height must be at most 1440), so that try made no picture. The
 * FLUX.1 endpoints now get a size inside 256-1440 in steps of 32, with the picture's shape kept;
 * FLUX.2 and ultra keep what the model asked for. The real FluxAPI.js runs here; BFL, the image
 * download and the usage log are stand-ins, so nothing is spent.
 *
 * Run: node --test api/app/clients/tools/structured/FluxAPI.size.nodetest.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { stubModules } = require('../../../../test/kadeFakeMongo.cjs');

let posts = [];

const axios = {
  post: async (url, body) => {
    posts.push({ url, body });
    return { data: { id: 'task-1' } };
  },
  get: async () => ({ data: { status: 'Ready', result: { sample: 'https://bfl.invalid/x.png' } } }),
};

stubModules({
  axios,
  'node-fetch': async () => ({ arrayBuffer: async () => new ArrayBuffer(4) }),
  uuid: { v4: () => 'uuid-1' },
  '@librechat/data-schemas': { logger: { debug() {}, warn() {}, info() {}, error() {} } },
  '~/models/kadeUsage': { logKadeUsage: () => {}, fluxCost: () => 0.04 },
  '~/models/kadeAsset': { logKadeAsset: async () => {} },
  '@librechat/agents/langchain/tools': { Tool: class {} },
  '@librechat/api': {
    applyAxiosProxyConfig: (c) => c,
    createMinimalRetentionRequest: () => ({}),
    getHttpsProxyAgent: () => undefined,
  },
  'librechat-data-provider': {
    FileContext: { image_generation: 'image_generation' },
    ContentTypes: { IMAGE_URL: 'image_url', TEXT: 'text' },
  },
});

const FluxAPI = require('./FluxAPI');
const { fitFluxSize } = FluxAPI;

/* The 2-second poll wait is real in the tool; skip it here. */
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args);

function tool() {
  return new FluxAPI({
    FLUX_API_KEY: 'test-key',
    isAgent: true,
    userId: 'u1',
    processFileURL: async () => ({ filepath: '/images/u1/x.png' }),
  });
}

beforeEach(() => {
  posts = [];
});

test('her Oct 9 call: 1024x1536 on flux-pro-1.1 is sent as 960x1440, shape kept', async () => {
  await tool()._call({
    action: 'generate',
    prompt: 'A labelled two-panel diagram.',
    endpoint: '/v1/flux-pro-1.1',
    width: 1024,
    height: 1536,
  });
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/v1\/flux-pro-1\.1$/);
  assert.equal(posts[0].body.width, 960);
  assert.equal(posts[0].body.height, 1440);
});

test('her second call (1024x1408) already fits and is sent unchanged', async () => {
  await tool()._call({ action: 'generate', prompt: 'p', endpoint: '/v1/flux-pro-1.1', width: 1024, height: 1408 });
  assert.equal(posts[0].body.width, 1024);
  assert.equal(posts[0].body.height, 1408);
});

test('FLUX.2 (the default) keeps the size the model asked for', async () => {
  await tool()._call({ action: 'generate', prompt: 'p', width: 1024, height: 1536 });
  assert.match(posts[0].url, /\/v1\/flux-2-pro$/);
  assert.equal(posts[0].body.width, 1024);
  assert.equal(posts[0].body.height, 1536);
});

test('no size asked: none is sent', async () => {
  await tool()._call({ action: 'generate', prompt: 'p', endpoint: '/v1/flux-dev' });
  assert.equal('width' in posts[0].body, false);
  assert.equal('height' in posts[0].body, false);
});

test('finetuned generation is fitted too', async () => {
  await tool()._call({
    action: 'generate_finetuned',
    prompt: 'p',
    finetune_id: 'ft-1',
    endpoint: '/v1/flux-pro-finetuned',
    width: 2048,
    height: 2048,
  });
  assert.match(posts[0].url, /\/v1\/flux-pro-finetuned$/);
  assert.equal(posts[0].body.width, 1440);
  assert.equal(posts[0].body.height, 1440);
});

test('fitFluxSize: rounding, floor, one side, junk', () => {
  assert.deepEqual(fitFluxSize('/v1/flux-pro-1.1', 1000, 750), { width: 992, height: 736 });
  assert.deepEqual(fitFluxSize('/v1/flux-pro', 100, 3000), { width: 256, height: 1440 });
  assert.deepEqual(fitFluxSize('/v1/flux-dev', undefined, 2000), { width: undefined, height: 1440 });
  assert.deepEqual(fitFluxSize('/v1/flux-dev', '1536', '1024'), { width: 1440, height: 960 });
  assert.deepEqual(fitFluxSize('/v1/flux-dev', 0, -5), { width: undefined, height: undefined });
  assert.deepEqual(fitFluxSize('/v1/flux-dev', 'wide', NaN), { width: undefined, height: undefined });
  assert.deepEqual(fitFluxSize('/v1/flux-pro-1.1-ultra', 3000, 2000), { width: 3000, height: 2000 });
});
