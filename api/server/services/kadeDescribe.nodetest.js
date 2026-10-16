/* Oct 16 2026 — what share-to-describe sends to OpenRouter (Kade's zero-retention rule).
 * Pictures and documents go only to hosts that keep nothing, DeepInfra first; a video only to the
 * zero-retention host that hears its soundtrack (Novita); a refusal is asked once more and is never
 * a description; a video answered by a host that cannot hear it is not used.
 * Run: node --test api/server/services/kadeDescribe.nodetest.js (no network, no database). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const plain = (value) => JSON.parse(JSON.stringify(value));
const ZERO_RETENTION = {
  zdr: true,
  data_collection: 'deny',
  order: ['DeepInfra'],
  allow_fallbacks: true,
};
const HEARING_VIDEO = {
  zdr: true,
  data_collection: 'deny',
  only: ['Novita'],
  allow_fallbacks: true,
};
const refusal = {
  finish_reason: 'content_filter',
  message: { content: 'The request was rejected because it was considered high risk' },
};

/** Loads kadeDescribe.js with axios answering from `reply(body, n)` (n counts from 1). */
function load(reply) {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./kadeDescribe'), 'utf8'), {
    module,
    Buffer,
    setInterval: () => ({ unref() {} }),
    process: { env: { OPENROUTER_KEY: 'fake-local-test' } },
    require(id) {
      if (id === 'crypto') return require('crypto');
      if (id === 'axios') {
        return {
          post: async (url, body) => {
            calls.push({ url, body });
            return { data: await reply(body, calls.length) };
          },
        };
      }
      if (id === '@librechat/data-schemas') return { logger: { warn() {}, info() {} } };
      if (id === './kadeRealCost') return require('./kadeRealCost');
      if (id === './kadeMediaRoute') return require('./kadeMediaRoute');
      throw Error(`Unexpected dependency: ${id}`);
    },
  });
  return { describe: module.exports, calls };
}
const answer = (content, provider = 'DeepInfra', cost = 0.001) => ({
  provider,
  choices: [{ finish_reason: 'stop', message: { content } }],
  usage: { cost, prompt_tokens: 1000, completion_tokens: 100 },
});

test('a shared photo goes only to zero-retention hosts, DeepInfra first, never Xiaomi', async () => {
  const { describe, calls } = load(() => answer('A red barn under a grey sky.'));
  const result = await describe.runDescribe({ buf: Buffer.from('png'), mime: 'image/png' });
  assert.equal(result.description, 'A red barn under a grey sky.');
  assert.equal(calls.length, 1, 'no dates to look for in words without digits');
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].body.model, 'xiaomi/mimo-v2.6-pro');
  assert.deepEqual(plain(calls[0].body.provider), ZERO_RETENTION);
  assert.equal(calls[0].body.messages[0].content[1].type, 'image_url');
});

test('a shared video goes only to Novita, the zero-retention host that hears its soundtrack', async () => {
  const { describe, calls } = load(() => answer('A woman sings on a porch.', 'Novita'));
  const result = await describe.runDescribe({ buf: Buffer.from('mp4'), mime: 'video/mp4' });
  assert.equal(result.kind, 'video');
  assert.equal(result.description, 'A woman sings on a porch.');
  assert.deepEqual(plain(calls[0].body.provider), HEARING_VIDEO);
  assert.equal(calls[0].body.messages[0].content[1].type, 'video_url');
});

test('a video answered by a host that cannot hear it is not used, and not asked again', async () => {
  const { describe, calls } = load(() => answer('Upbeat chiptune plays.', 'DeepInfra'));
  await assert.rejects(
    describe.runDescribe({ buf: Buffer.from('mp4'), mime: 'video/mp4' }),
    /came back empty/,
  );
  assert.equal(calls.length, 1);
});

test('a refusal is asked once more, its text is never the description, and both calls are counted', async () => {
  const { describe, calls } = load((_body, n) =>
    n === 1
      ? { provider: 'Novita', choices: [refusal], usage: { cost: 0.00004 } }
      : answer('A blue bowl.', 'DeepInfra', 0.001),
  );
  const result = await describe.runDescribe({ buf: Buffer.from('png'), mime: 'image/png' });
  assert.equal(result.description, 'A blue bowl.');
  assert.equal(calls.length, 2);
  assert.ok(Math.abs(result.costUSD - 0.00104) < 1e-9, String(result.costUSD));
});

test('refused twice: no description at all, and not asked a third time', async () => {
  const { describe, calls } = load(() => ({
    provider: 'Novita',
    choices: [refusal],
    usage: { cost: 0.00004 },
  }));
  await assert.rejects(
    describe.runDescribe({ buf: Buffer.from('png'), mime: 'image/png' }),
    /came back empty/,
  );
  assert.equal(calls.length, 2);
});

test('a shared text document is summarized on zero-retention hosts too', async () => {
  const { describe, calls } = load(() => answer('A note about a picnic.'));
  const words =
    'Bring the lemonade and the folding chairs to the park by the river after church. '.repeat(3);
  const result = await describe.runDescribe({
    buf: Buffer.from(words),
    mime: 'text/plain',
    name: 'note.txt',
  });
  assert.equal(result.description, 'A note about a picnic.');
  assert.deepEqual(plain(calls[0].body.provider), ZERO_RETENTION);
  assert.equal(calls[0].body.messages[0].content.length, 1, 'text only');
});
