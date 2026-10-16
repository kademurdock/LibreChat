/* Oct 16 2026 — the zero-retention routing rules every media describer shares.
 * Run: node --test api/server/services/kadeMediaRoute.nodetest.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const route = require('./kadeMediaRoute');

test('what a request sends decides its kind: a video part, a picture or document part, or text', () => {
  assert.equal(
    route.contentKind([
      { type: 'text', text: 'x' },
      { type: 'video_url', video_url: { url: 'v' } },
    ]),
    'video',
  );
  assert.equal(route.contentKind([{ type: 'image_url', image_url: { url: 'i' } }]), 'image');
  assert.equal(route.contentKind([{ type: 'file', file: { filename: 'a.pdf' } }]), 'image');
  assert.equal(route.contentKind([{ type: 'text', text: 'x' }]), 'text');
  assert.equal(route.contentKind('plain words'), 'text');
});

test('every route keeps zero retention; MiMo video only on the hosts that hear it, never Xiaomi', () => {
  const env = {};
  assert.deepEqual(route.mediaProvider('xiaomi/mimo-v2.6-pro', 'video', env), {
    zdr: true,
    data_collection: 'deny',
    only: ['Novita'],
    allow_fallbacks: true,
  });
  assert.deepEqual(route.mediaProvider('xiaomi/mimo-v2.6-flash', 'image', env), {
    zdr: true,
    data_collection: 'deny',
    order: ['DeepInfra'],
    allow_fallbacks: true,
  });
  assert.deepEqual(route.mediaProvider('xiaomi/mimo-v2.6-pro', 'text', env), {
    zdr: true,
    data_collection: 'deny',
    order: ['DeepInfra'],
    allow_fallbacks: true,
  });
  assert.deepEqual(route.mediaProvider('google/gemini-3.8-flash', 'video', env), {
    zdr: true,
    data_collection: 'deny',
    ignore: ['google-ai-studio'],
  });
  assert.deepEqual(route.mediaProvider('qwen/qwen3-vl-flash', 'image', env), {
    zdr: true,
    data_collection: 'deny',
  });
  assert.deepEqual(
    route.mediaProvider('xiaomi/mimo-v2.6-pro', 'video', {
      KADE_VIDEO_HOSTS: ' Novita , GMICloud ',
    }).only,
    ['Novita', 'GMICloud'],
  );
});

test('only a video answered by a host outside the hearing list is unheard', () => {
  const env = {};
  assert.equal(route.heardBy('xiaomi/mimo-v2.6-pro', 'video', 'Novita', env), true);
  assert.equal(route.heardBy('xiaomi/mimo-v2.6-pro', 'video', 'DeepInfra', env), false);
  assert.equal(route.heardBy('xiaomi/mimo-v2.6-pro', 'video', 'Venice', env), false);
  assert.equal(route.heardBy('xiaomi/mimo-v2.6-pro', 'video', undefined, env), true);
  assert.equal(route.heardBy('xiaomi/mimo-v2.6-pro', 'image', 'DeepInfra', env), true);
  assert.equal(route.heardBy('google/gemini-3.8-flash', 'video', 'Google', env), true);
});

test('a refusal, by finish or native finish reason, is never read as text', () => {
  const said = 'The request was rejected because it was considered high risk';
  for (const choice of [
    { finish_reason: 'content_filter', message: { content: said } },
    { finish_reason: 'stop', native_finish_reason: 'content_filter', message: { content: said } },
  ]) {
    assert.deepEqual(
      route.readReply(
        { provider: 'Novita', choices: [choice] },
        'xiaomi/mimo-v2.6-pro',
        'image',
        {},
      ),
      {
        text: null,
        refused: true,
        unheard: false,
      },
    );
  }
  assert.deepEqual(
    route.readReply(
      {
        provider: 'Novita',
        choices: [{ finish_reason: 'stop', message: { content: '  A kettle. ' } }],
      },
      'xiaomi/mimo-v2.6-pro',
      'video',
      {},
    ),
    { text: 'A kettle.', refused: false, unheard: false },
  );
  assert.deepEqual(route.readReply({}, 'xiaomi/mimo-v2.6-pro', 'text', {}), {
    text: null,
    refused: false,
    unheard: false,
  });
});
