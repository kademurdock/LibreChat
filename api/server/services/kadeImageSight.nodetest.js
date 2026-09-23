const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function load(post) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./kadeImageSight'), 'utf8'), {
    module, process: { env: { OPENROUTER_KEY: 'fake-local-test' } },
    require(id) {
      if (id === 'axios') return { post };
      if (id === '@librechat/data-schemas') return { logger: { warn() {} } };
      throw Error(id);
    },
  });
  return module.exports;
}
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
