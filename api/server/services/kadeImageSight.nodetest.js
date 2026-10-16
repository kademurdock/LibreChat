const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function load(post, ledger = []) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./kadeImageSight'), 'utf8'), {
    module, process: { env: { OPENROUTER_KEY: 'fake-local-test' } },
    require(id) {
      if (id === 'axios') return { post };
      if (id === '@librechat/data-schemas') return { logger: { warn() {} } };
      if (id === './kadeRealCost') return require('./kadeRealCost');
      if (id === './kadeMediaRoute') return require('./kadeMediaRoute');
      if (id === '~/models/kadeUsage') return { logKadeUsage: (row) => ledger.push(row) };
      throw Error(id);
    },
  });
  return module.exports;
}
test('Part 295: a BYOK photo bills OpenRouter\'s fee plus what Google charged the key', async () => {
  const ledger = [];
  const sight = load(async () => ({ data: { choices: [{ message: { content: 'A cat.' } }], usage: { cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.0012 } } } }), ledger);
  assert.equal(await sight.describeAttachedImages([{ image_url: { url: 'cat' } }], { userId: 'u1' }), 'A cat.');
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].costUSD, 0.0012);
});
test('Part 295: a normal photo bills its cost once, not the upstream figure that restates it', async () => {
  const ledger = [];
  const sight = load(async () => ({ data: { choices: [{ message: { content: 'A dog.' } }], usage: { cost: 0.0012, is_byok: false, cost_details: { upstream_inference_cost: 0.0012 } } } }), ledger);
  assert.equal(await sight.describeAttachedImages([{ image_url: { url: 'dog' } }], { userId: 'u1' }), 'A dog.');
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].costUSD, 0.0012);
});
test('Part 295 review: a BYOK photo without Google\'s figure is priced from its tokens, never at the fee alone', async () => {
  const ledger = [];
  const usage = { prompt_tokens: 2000, completion_tokens: 500, cost: 0, is_byok: true, cost_details: { upstream_inference_cost: null } };
  const sight = load(async () => ({ data: { choices: [{ message: { content: 'A bird.' } }], usage } }), ledger);
  assert.equal(await sight.describeAttachedImages([{ image_url: { url: 'bird' } }], { userId: 'u1' }), 'A bird.');
  assert.equal(ledger.length, 1);
  /* MiMo Pro: 2,000 in at $0.435/M and 500 out at $0.87/M. */
  assert.ok(Math.abs(ledger[0].costUSD - 0.001305) < 1e-12, String(ledger[0].costUSD));
});
test('photo question reaches vision as user text and is separate from instructions', async () => {
  const calls = [];
  const sight = load(async (_, body) => { calls.push(body); return { data: { choices: [{ message: { content: 'The red mug is on the left.' } }] } }; });
  const result = await sight.describeAttachedImages([{ image_url: { url: 'test-image' } }], { question: [{ type: 'text', text: 'Which side is the red mug on?' }] });
  assert.match(result, /left/);
  assert.equal(calls[0].messages[0].role, 'system');
  assert.equal(calls[0].model, 'xiaomi/mimo-v2.6-pro');
  assert.equal(calls[0].reasoning.enabled, false);
  assert.equal(calls[0].messages[1].content[0].text, 'Which side is the red mug on?');
  assert.match(calls[0].messages[0].content, /answer that first/);
  assert.equal(calls[0].messages[1].content[1].image_url.url, 'test-image');
});
test('a failed first photo does not renumber the second photo', async () => {
  const sight = load(async (_, body) => {
    if (body.messages[1].content[1].image_url.url === 'bad') throw Error('unavailable');
    return { data: { choices: [{ message: { content: 'Blue bowl.' } }] } };
  });
  assert.equal(await sight.describeAttachedImages([{ image_url: { url: 'bad' } }, { image_url: { url: 'good' } }]), 'Photo 2: Blue bowl.');
});
test('Oct 16 2026: a photo goes only to zero-retention hosts, DeepInfra first, never Xiaomi', async () => {
  const calls = [];
  const sight = load(async (_, body) => { calls.push(body); return { data: { provider: 'DeepInfra', choices: [{ message: { content: 'A porch light.' } }] } }; });
  assert.equal(await sight.describeAttachedImages([{ image_url: { url: 'porch' } }]), 'A porch light.');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].provider)), { zdr: true, data_collection: 'deny', order: ['DeepInfra'], allow_fallbacks: true });
});
test('Oct 16 2026: a content_filter refusal is never handed to the companion as what the photo shows', async () => {
  const refusal = { finish_reason: 'content_filter', message: { content: 'The request was rejected because it was considered high risk' } };
  const sight = load(async (_, body) => ({
    data: { provider: 'Novita', choices: [body.messages[1].content[1].image_url.url === 'refused' ? refusal : { message: { content: 'Green kettle.' } }] },
  }));
  assert.equal(await sight.describeAttachedImages([{ image_url: { url: 'refused' } }]), null);
  assert.equal(
    await sight.describeAttachedImages([{ image_url: { url: 'refused' } }, { image_url: { url: 'kettle' } }]),
    'Photo 2: Green kettle.',
  );
});
