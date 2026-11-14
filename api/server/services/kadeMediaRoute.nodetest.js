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

/* Nov 14 2026: background callers (the Library's video describer, the gallery's videos) ask Google
 * Vertex's flex tier first, at half the price with zero retention kept, and once more on standard
 * when flex fails. OpenRouter's endpoint list that day: google-vertex/global/flex at $0.375 and
 * $1.875, on its zero-retention list. */
const FLEX = {
  zdr: true,
  data_collection: 'deny',
  only: ['google-vertex/global/flex'],
  ignore: ['google-ai-studio'],
  allow_fallbacks: false,
};
const STANDARD = { zdr: true, data_collection: 'deny', ignore: ['google-ai-studio'] };

test('a background Google request asks only Vertex flex, with zero retention and no fallback inside OpenRouter', () => {
  assert.equal(route.FLEX_ENDPOINT, 'google-vertex/global/flex');
  assert.deepEqual(route.mediaProvider('google/gemini-3.8-flash', 'video', {}, { flex: true }), FLEX);
  /* Without the option, and for every other caller, the standard route is unchanged. */
  assert.deepEqual(route.mediaProvider('google/gemini-3.8-flash', 'video', {}), STANDARD);
  assert.deepEqual(route.mediaProvider('google/gemini-3.8-flash', 'video', {}, { flex: false }), STANDARD);
  /* MiMo and other models have no flex tier here: the option changes nothing for them. */
  assert.deepEqual(route.mediaProvider('xiaomi/mimo-v2.6-pro', 'video', {}, { flex: true }), {
    zdr: true,
    data_collection: 'deny',
    only: ['Novita'],
    allow_fallbacks: true,
  });
  assert.deepEqual(route.mediaProvider('xiaomi/mimo-v2.6-pro', 'image', {}, { flex: true }), {
    zdr: true,
    data_collection: 'deny',
    order: ['DeepInfra'],
    allow_fallbacks: true,
  });
  assert.deepEqual(route.mediaProvider('qwen/qwen3-vl-flash', 'video', {}, { flex: true }), {
    zdr: true,
    data_collection: 'deny',
  });
});

test('KADE_VIDEO_TIER=standard puts background requests back on the standard tier', () => {
  assert.equal(route.flexFor('google/gemini-3.8-flash', {}), true);
  assert.equal(route.flexFor('xiaomi/mimo-v2.6-pro', {}), false);
  for (const off of ['standard', 'Standard', ' STANDARD ']) {
    assert.equal(route.flexFor('google/gemini-3.8-flash', { KADE_VIDEO_TIER: off }), false, off);
    assert.deepEqual(
      route.mediaProvider('google/gemini-3.8-flash', 'video', { KADE_VIDEO_TIER: off }, { flex: true }),
      STANDARD,
    );
  }
  for (const on of ['', 'flex', 'anything']) {
    assert.equal(route.flexFor('google/gemini-3.8-flash', { KADE_VIDEO_TIER: on }), true, on);
  }
});

test('a flex reply that names no cost is priced at the flex rates, and a reply Google moved to standard at standard', () => {
  assert.deepEqual(route.flexRates({}), { in: 0.375, out: 1.875 });
  assert.deepEqual(
    route.flexRates({ KADE_VIDEO_FLEX_IN_USD_PER_M: '1', KADE_VIDEO_FLEX_OUT_USD_PER_M: '5' }),
    { in: 1, out: 5 },
  );
  assert.deepEqual(route.flexRates({ KADE_VIDEO_FLEX_IN_USD_PER_M: 'x' }), { in: 0.375, out: 1.875 });
  assert.equal(route.servedTier({ service_tier: 'flex' }, 'flex'), 'flex');
  assert.equal(route.servedTier({}, 'flex'), 'flex', 'no word from OpenRouter: the tier asked');
  assert.equal(route.servedTier({ service_tier: 'standard' }, 'flex'), 'standard');
  assert.equal(route.servedTier({ service_tier: 'default' }, 'flex'), 'standard');
  assert.equal(route.servedTier({ service_tier: 'flex' }, 'standard'), 'standard', 'standard is never priced lower');
});

test('which flex failures are asked again on standard, and which would fail there too', () => {
  const failed = (status) => Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status } });
  for (const status of [404, 408, 429, 500, 502, 503, 504, 529]) {
    assert.equal(route.flexRetryable(failed(status)), true, String(status));
  }
  for (const status of [400, 401, 402, 403, 413]) {
    assert.equal(route.flexRetryable(failed(status)), false, String(status));
  }
  const timeout = Object.assign(new Error('timeout of 540000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' });
  assert.equal(route.flexRetryable(timeout), true);
  assert.equal(route.flexRetryable(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), true);
  assert.equal(route.flexRetryable(new TypeError('a bug of ours')), false);
  /* A reply that came back is judged by what is in it. */
  const reply = (choice, extra = {}) => ({ choices: choice ? [choice] : [], ...extra });
  assert.equal(route.flexTrouble(reply({ finish_reason: 'stop', message: { content: '{}' } })), '');
  assert.equal(route.flexTrouble(reply({ finish_reason: 'length', message: { content: '{"sc' } })), 'cut off');
  assert.equal(
    route.flexTrouble(reply({ finish_reason: 'stop', native_finish_reason: 'MAX_TOKENS', message: { content: '' } })),
    'cut off',
  );
  assert.equal(route.flexTrouble({ error: { code: 429, message: 'Resource exhausted' } }), 'error 429 in the reply');
  assert.equal(
    route.flexTrouble(reply({ finish_reason: 'error', error: { code: 502, message: 'Provider returned error' } })),
    'error 502 in the reply',
  );
  assert.equal(route.flexTrouble(reply(null)), 'no answer');
  assert.equal(route.flexTrouble(null), 'no answer');
  /* A refusal is a reply: Google declines the same clip on standard too. */
  assert.equal(
    route.flexTrouble(reply({ finish_reason: 'stop', native_finish_reason: 'SAFETY', message: { content: 'No.' } })),
    '',
  );
  for (const type of ['content_policy_violation', 'refusal']) {
    assert.equal(route.flexTrouble({ error: { code: 400, message: 'Declined', metadata: { error_type: type } } }), '', type);
  }
});

test('askFlexFirst: flex once, then standard once when flex fails; never standard first, never twice', async () => {
  const ok = { data: { choices: [{ finish_reason: 'stop', message: { content: 'A kettle.' } }] } };
  const run = async (flex, flexAnswer) => {
    const asked = [];
    const reasons = [];
    const result = await route.askFlexFirst(
      flex,
      async (tier) => {
        asked.push(tier);
        if (tier === 'flex') {
          if (flexAnswer instanceof Error) {
            throw flexAnswer;
          }
          return flexAnswer;
        }
        return ok;
      },
      (reason) => reasons.push(reason),
    );
    return { asked, reasons, result };
  };
  let r = await run(true, ok);
  assert.deepEqual(r.asked, ['flex']);
  assert.equal(r.result.tier, 'flex');
  assert.equal(r.result.response, ok);
  assert.deepEqual(r.reasons, []);

  r = await run(true, Object.assign(new Error('busy'), { isAxiosError: true, response: { status: 429 } }));
  assert.deepEqual(r.asked, ['flex', 'standard']);
  assert.equal(r.result.tier, 'standard');
  assert.deepEqual(r.reasons, ['HTTP 429']);

  r = await run(true, Object.assign(new Error('timeout of 540000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' }));
  assert.deepEqual(r.asked, ['flex', 'standard']);
  assert.deepEqual(r.reasons, ['ECONNABORTED']);

  r = await run(true, { data: { choices: [{ finish_reason: 'length', message: { content: '{"sum' } }] } });
  assert.deepEqual(r.asked, ['flex', 'standard']);
  assert.deepEqual(r.reasons, ['cut off']);

  r = await run(true, { data: { error: { code: 503, message: 'overloaded' } } });
  assert.deepEqual(r.asked, ['flex', 'standard']);
  assert.deepEqual(r.reasons, ['error 503 in the reply']);

  const noCredit = Object.assign(new Error('no credit'), { isAxiosError: true, response: { status: 402 } });
  await assert.rejects(run(true, noCredit), /no credit/);

  r = await run(false, ok);
  assert.deepEqual(r.asked, ['standard'], 'no flex for a caller that did not ask for it');
  assert.equal(r.result.tier, 'standard');
});
