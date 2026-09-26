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
test('photo question reaches vision as user text and is separate from instructions', async () => {
  const calls = [];
  const sight = load(async (_, body) => { calls.push(body); return { data: { choices: [{ message: { content: 'The red mug is on the left.' } }] } }; });
  const result = await sight.describeAttachedImages([{ image_url: { url: 'test-image' } }], { question: [{ type: 'text', text: 'Which side is the red mug on?' }] });
  assert.match(result, /left/);
  assert.equal(calls[0].messages[0].role, 'system');
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
