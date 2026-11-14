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

/* Nov 13 2026: Novita stopped serving MiMo, and no zero-retention MiMo host is known to hear a
 * video's soundtrack, so a MiMo lane's videos go to the video model (KADE_VIDEO_MODEL, by default
 * google/gemini-3.8-flash on Google Vertex). */
test('a MiMo lane sends its videos to the video model; pictures, text and other models are unchanged', () => {
  assert.equal(route.VIDEO_MODEL, 'google/gemini-3.8-flash');
  assert.equal(route.mediaModel('xiaomi/mimo-v2.6-pro', 'video', {}), 'google/gemini-3.8-flash');
  assert.equal(route.mediaModel('xiaomi/mimo-v2.6-flash', 'video', {}), 'google/gemini-3.8-flash');
  assert.equal(route.mediaModel('xiaomi/mimo-v2.6-pro', 'image', {}), 'xiaomi/mimo-v2.6-pro');
  assert.equal(route.mediaModel('xiaomi/mimo-v2.6-pro', 'text', {}), 'xiaomi/mimo-v2.6-pro');
  assert.equal(route.mediaModel('google/gemini-3.8-flash', 'video', {}), 'google/gemini-3.8-flash');
  assert.equal(
    route.mediaModel('xiaomi/mimo-v2.6-pro', 'video', { KADE_VIDEO_MODEL: 'google/gemini-4-carbon' }),
    'google/gemini-4-carbon',
  );
  /* KADE_VIDEO_MODEL=mimo (any case) keeps the lane's own MiMo model, pinned to the hearing hosts. */
  for (const keep of ['mimo', 'MiMo', ' mimo ']) {
    const model = route.mediaModel('xiaomi/mimo-v2.6-pro', 'video', { KADE_VIDEO_MODEL: keep });
    assert.equal(model, 'xiaomi/mimo-v2.6-pro');
    assert.deepEqual(route.mediaProvider(model, 'video', { KADE_VIDEO_MODEL: keep }).only, ['Novita']);
  }
  /* The default video model keeps zero retention and never reaches Google AI Studio. */
  const model = route.mediaModel('xiaomi/mimo-v2.6-pro', 'video', {});
  assert.deepEqual(route.mediaProvider(model, 'video', {}), {
    zdr: true,
    data_collection: 'deny',
    ignore: ['google-ai-studio'],
  });
  assert.equal(route.heardBy(model, 'video', 'Google', {}), true);
});

test('a model that cannot switch thinking off gets the least thinking and room for it', () => {
  /* Live Nov 13 2026: google/gemini-3.8-flash answers HTTP 400 "Reasoning is mandatory for this
   * endpoint and cannot be disabled." to reasoning off, and took effort minimal (0 thinking tokens). */
  assert.deepEqual(route.plainAnswer('google/gemini-3.8-flash'), {
    reasoning: { effort: 'minimal', exclude: true },
    room: 2000,
  });
  assert.deepEqual(route.plainAnswer('google/gemini-3.5-pro'), {
    reasoning: { effort: 'low', exclude: true },
    room: 2000,
  });
  assert.deepEqual(route.plainAnswer('xiaomi/mimo-v2.6-pro'), { reasoning: { enabled: false }, room: 0 });
  assert.deepEqual(route.plainAnswer('google/gemini-3.8-flash-lite'), {
    reasoning: { enabled: false },
    room: 0,
  });
});

test('declines from Google are refusals and are asked once; MiMo refusals are asked three times', () => {
  assert.equal(route.refusedChoice({ finish_reason: 'stop', native_finish_reason: 'SAFETY' }), true);
  assert.equal(route.refusedChoice({ finish_reason: 'stop', native_finish_reason: 'prohibited_content' }), true);
  assert.equal(route.refusedChoice({ finish_reason: 'stop', native_finish_reason: 'STOP' }), false);
  assert.equal(route.refusedChoice(undefined), false);
  assert.equal(route.refusalTries('google/gemini-3.8-flash'), 1);
  assert.equal(route.refusalTries('xiaomi/mimo-v2.6-pro'), route.limits.refusalTries);
  const declined = {
    provider: 'Google',
    choices: [{ finish_reason: 'stop', native_finish_reason: 'SAFETY', message: { content: 'No.' } }],
  };
  assert.deepEqual(route.readReply(declined, 'google/gemini-3.8-flash', 'video', {}), {
    text: null,
    refused: true,
    unheard: false,
  });
});

test('a reply from the video model that names no cost is priced at the rates of that model', () => {
  assert.deepEqual(route.videoRates({}), { in: 0.825, out: 4.125 });
  assert.deepEqual(route.videoRates({ KADE_VIDEO_IN_USD_PER_M: '1', KADE_VIDEO_OUT_USD_PER_M: '2' }), {
    in: 1,
    out: 2,
  });
  assert.deepEqual(route.videoRates({ KADE_VIDEO_IN_USD_PER_M: 'x', KADE_VIDEO_OUT_USD_PER_M: '-3' }), {
    in: 0.825,
    out: 4.125,
  });
});
