/* Oct 16 2026 — what share-to-describe sends to OpenRouter (Kade's zero-retention rule).
 * Pictures and documents go only to hosts that keep nothing, DeepInfra first; a video only to the
 * zero-retention host that hears its soundtrack (Novita); a refusal is asked up to twice more and is never
 * a description; a video answered by a host that cannot hear it is not used.
 * Run: node --test api/server/services/kadeDescribe.nodetest.js (no network, no database). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

/* Novita's refusals are waited out 20 s apart in production; not here. */
require('./kadeMediaRoute').limits.refusalMs = 0;

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
/* The MiMo video path, which KADE_VIDEO_MODEL=mimo keeps (Nov 13 2026: off by default). */
const MIMO_VIDEO = { KADE_VIDEO_MODEL: 'mimo' };
const refusal = {
  finish_reason: 'content_filter',
  message: { content: 'The request was rejected because it was considered high risk' },
};

/** Loads kadeDescribe.js with axios answering from `reply(body, n)` (n counts from 1). */
function load(reply, env = {}) {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./kadeDescribe'), 'utf8'), {
    module,
    Buffer,
    setInterval: () => ({ unref() {} }),
    process: { env: { OPENROUTER_KEY: 'fake-local-test', ...env } },
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

test('KADE_VIDEO_MODEL=mimo: a shared video goes only to Novita, the zero-retention host that heard its soundtrack', async () => {
  const { describe, calls } = load(() => answer('A woman sings on a porch.', 'Novita'), MIMO_VIDEO);
  const result = await describe.runDescribe({ buf: Buffer.from('mp4'), mime: 'video/mp4' });
  assert.equal(result.kind, 'video');
  assert.equal(result.description, 'A woman sings on a porch.');
  assert.deepEqual(plain(calls[0].body.provider), HEARING_VIDEO);
  assert.equal(calls[0].body.messages[0].content[1].type, 'video_url');
});

test('KADE_VIDEO_MODEL=mimo: a video answered by a host that cannot hear it is not used, and not asked again', async () => {
  const { describe, calls } = load(() => answer('Upbeat chiptune plays.', 'DeepInfra'), MIMO_VIDEO);
  await assert.rejects(
    describe.runDescribe({ buf: Buffer.from('mp4'), mime: 'video/mp4' }),
    /came back empty/,
  );
  assert.equal(calls.length, 1);
});

test('a refusal is asked again, its text is never the description, and both calls are counted', async () => {
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

test('refused three times: no description at all, and not asked a fourth time', async () => {
  const { describe, calls } = load(() => ({
    provider: 'Novita',
    choices: [refusal],
    usage: { cost: 0.00004 },
  }));
  await assert.rejects(
    describe.runDescribe({ buf: Buffer.from('png'), mime: 'image/png' }),
    /came back empty/,
  );
  assert.equal(calls.length, 3);
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

/* Nov 13 2026: Novita stopped serving MiMo, so by default a shared video goes to the video model
 * (google/gemini-3.8-flash on Google Vertex), which hears its soundtrack with zero retention. */
test('by default a shared video goes to the video model on Google Vertex, never AI Studio, with room for its thinking', async () => {
  const { describe, calls } = load(() => answer('A woman sings on a porch.', 'Google'));
  const result = await describe.runDescribe({ buf: Buffer.from('mp4'), mime: 'video/mp4' });
  assert.equal(result.description, 'A woman sings on a porch.');
  assert.equal(result.model, 'google/gemini-3.8-flash');
  assert.equal(calls[0].body.model, 'google/gemini-3.8-flash');
  assert.deepEqual(plain(calls[0].body.provider), {
    zdr: true,
    data_collection: 'deny',
    ignore: ['google-ai-studio'],
  });
  /* It cannot switch thinking off, so it gets the least thinking and 2,000 tokens of room. */
  assert.deepEqual(plain(calls[0].body.reasoning), { effort: 'minimal', exclude: true });
  assert.equal(calls[0].body.max_tokens, 3000);
  assert.equal(calls[0].body.messages[0].content[1].type, 'video_url');
});

test('a decline from Google is asked once and is never the description', async () => {
  const declined = {
    provider: 'Google',
    choices: [{ finish_reason: 'stop', native_finish_reason: 'SAFETY', message: { content: 'I cannot help.' } }],
    usage: { cost: 0.0002, prompt_tokens: 1000, completion_tokens: 10 },
  };
  const { describe, calls } = load(() => declined);
  await assert.rejects(describe.runDescribe({ buf: Buffer.from('mp4'), mime: 'video/mp4' }), /came back empty/);
  assert.equal(calls.length, 1);
});

test('a shared photo still goes to MiMo on zero-retention hosts, DeepInfra first', async () => {
  const { describe, calls } = load(() => answer('A red barn.'));
  await describe.runDescribe({ buf: Buffer.from('png'), mime: 'image/png' });
  assert.equal(calls[0].body.model, 'xiaomi/mimo-v2.6-pro');
  assert.deepEqual(plain(calls[0].body.provider), ZERO_RETENTION);
});
