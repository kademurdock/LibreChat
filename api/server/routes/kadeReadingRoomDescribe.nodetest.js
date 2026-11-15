/* Oct 16 2026 — what the Library's video describer sends to OpenRouter (Kade's zero-retention
 * rule). A shrunk segment, soundtrack included, goes only to the zero-retention host that hears it
 * (Novita for MiMo; DeepInfra drops the soundtrack), as plain JSON (Novita refuses a strict
 * schema). A refusal is asked up to twice more and never becomes scenes; a segment still refused is
 * marked as not described and the job carries on; an answer from a host that cannot hear the
 * soundtrack stops the job. Run: node --test
 * api/server/routes/kadeReadingRoomDescribe.nodetest.js (no network, no database, no ffmpeg). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { Readable } = require('node:stream');

/* Novita's refusals are waited out 20 s apart in production; not here. */
require('../services/kadeMediaRoute').limits.refusalMs = 0;

const plain = (value) => JSON.parse(JSON.stringify(value));
const refusal = {
  finish_reason: 'content_filter',
  message: { content: 'The request was rejected because it was considered high risk' },
};
const scenes = JSON.stringify({
  summary: 'A furniture store ad.',
  scenes: [{ t: 2, text: 'A sofa on sale.' }],
});

/** Loads the describer with axios answering from `reply(body, n)` (n counts from 1). */
function load(reply, env = {}, usage = { logKadeUsage() {}, KadeUsage: {} }) {
  const calls = [];
  const warnings = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./kadeReadingRoomDescribe'), 'utf8'), {
    module,
    Buffer,
    setImmediate,
    /* Nov 13 2026: the older tests in this file cover the MiMo path, which KADE_VIDEO_MODEL=mimo
     * keeps; pass KADE_VIDEO_MODEL: '' to test the default. */
    process: { env: { OPENROUTER_KEY: 'fake-local-test', KADE_VIDEO_MODEL: 'mimo', ...env } },
    require(id) {
      if (['fs/promises', 'fs', 'os', 'path'].includes(id)) return require(id);
      if (id === 'child_process')
        return {
          /* Stand-in tools: ffprobe says the track runs 600 s (two MiMo segments of 300 s); ffmpeg
           * writes a tiny clip where it was told to. */
          execFile(_bin, args, _opts, done) {
            if (args.includes('-show_entries')) return done(null, '600\n', '');
            fs.writeFileSync(args[args.length - 1], Buffer.from('mp4'));
            return done(null, '', '');
          },
        };
      if (id === 'axios') {
        return {
          get: async () => ({ data: Readable.from([Buffer.from('original')]) }),
          post: async (url, body, config) => {
            calls.push({ url, body, config });
            return { data: await reply(body, calls.length) };
          },
        };
      }
      if (id === '@librechat/data-schemas') return { logger: { warn: (line) => warnings.push(line), info() {} } };
      if (id === '~/models/kadeUsage') return usage;
      if (id === '~/server/services/kadeRealCost') return require('../services/kadeRealCost');
      if (id === '~/server/services/kadeMediaRoute') return require('../services/kadeMediaRoute');
      throw Error(`Unexpected dependency: ${id}`);
    },
  });
  return { internals: module.exports._internals, library: module.exports, calls, warnings };
}
const answer = (
  provider,
  choice = { finish_reason: 'stop', message: { content: scenes } },
  cost = 0.002,
) => ({
  provider,
  choices: [choice],
  usage: { cost, prompt_tokens: 3582, completion_tokens: 400 },
});
/* Nov 14 2026: what a Google segment sends on Vertex's flex tier, and on the standard tier. */
const FLEX = {
  zdr: true,
  data_collection: 'deny',
  only: ['google-vertex/global/flex'],
  ignore: ['google-ai-studio'],
  allow_fallbacks: false,
};
const STANDARD = { zdr: true, data_collection: 'deny', ignore: ['google-ai-studio'] };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
/** An HTTP failure as axios throws it. */
const httpError = (status) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status, data: {} } });

test('a Library segment goes only to Novita with zero retention, as plain JSON, and its scenes are kept', async () => {
  const { internals, calls } = load(() => answer('Novita'));
  const result = await internals.lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.');
  assert.equal(calls.length, 1);
  const { body } = calls[0];
  assert.equal(body.model, 'xiaomi/mimo-v2.6-pro');
  assert.deepEqual(plain(body.provider), {
    zdr: true,
    data_collection: 'deny',
    only: ['Novita'],
    allow_fallbacks: true,
  });
  assert.equal(body.provider.order, undefined, 'never Xiaomi first, which keeps data');
  assert.deepEqual(
    plain(body.response_format),
    { type: 'json_object' },
    'Novita refuses a json_schema (HTTP 400)',
  );
  assert.equal(body.messages[0].content[1].type, 'video_url');
  assert.equal(internals.parseScenes(result.text).scenes[0].text, 'A sofa on sale.');
  assert.equal(result.costUSD, 0.002);
});

test('a refused segment is asked again; the refusal never becomes a scene and both calls count', async () => {
  const { internals, calls } = load((_body, n) =>
    n === 1 ? answer('Novita', refusal, 0.00004) : answer('Novita'),
  );
  const result = await internals.lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.');
  assert.equal(calls.length, 2);
  assert.ok(!result.text.includes('high risk'));
  assert.ok(Math.abs(result.costUSD - 0.00204) < 1e-9, String(result.costUSD));
});

test('refused three times, the segment comes back marked refused with no text, carrying what the calls cost', async () => {
  const { internals, calls } = load(() => answer('Novita', refusal, 0.00004));
  const result = await internals.lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.');
  assert.equal(calls.length, 3, 'not asked a fourth time');
  assert.equal(result.refused, true);
  assert.equal(result.text, '');
  assert.ok(Math.abs(result.costUSD - 0.00012) < 1e-9);
});

test('a segment still refused is marked where it falls and the job carries on; the paid segments are kept', async () => {
  /* Segment one is refused all three times; segment two (300 s on) is described. */
  const { internals, calls } = load((_body, n) =>
    n <= 3 ? answer('Novita', refusal, 0.00004) : answer('Novita'),
  );
  const out = await internals.describeTrack({
    signedUrl: 'https://example.invalid/track',
    mime: 'video/mp4',
    title: 'Furniture ad',
    category: 'commercial',
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(plain(out.scenes.map((s) => [s.t, s.text])), [
    [0, 'The describing service would not describe this part, from 0 to 300 seconds.'],
    [302, 'A sofa on sale.'],
  ]);
  assert.equal(out.summary, 'A furniture store ad.');
  assert.ok(Math.abs(out.costUSD - 0.00212) < 1e-9, String(out.costUSD));
});

test('a track refused in every segment fails with a plain reason, carrying its cost', async () => {
  const { internals, calls } = load(() => answer('Novita', refusal, 0.00004));
  const failure = await internals
    .describeTrack({ signedUrl: 'https://example.invalid/track', mime: 'video/mp4', title: 'Ad' })
    .catch((e) => e);
  assert.equal(calls.length, 6);
  assert.match(failure.message, /would not describe this video/);
  assert.ok(Math.abs(failure.costUSD - 0.00024) < 1e-9);
});

test('an answer from a host that cannot hear the soundtrack is never used, and not asked again', async () => {
  const { internals, calls } = load(() => answer('DeepInfra'));
  const failure = await internals
    .lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.')
    .catch((e) => e);
  assert.equal(calls.length, 1);
  assert.match(failure.message, /DeepInfra, which cannot hear its soundtrack/);
  assert.equal(failure.costUSD, 0.002);
});

test('KADE_VIDEO_HOSTS overrides the hearing hosts; a Google model never reaches AI Studio', async () => {
  /* Nov 13 2026: the lane hands its own env to the route, so the setting travels in it. */
  const { internals, calls } = load(() => answer('GMICloud'), { KADE_VIDEO_HOSTS: 'Novita,GMICloud' });
  await internals.lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.');
  assert.deepEqual(plain(calls[0].body.provider.only), ['Novita', 'GMICloud']);
  const google = load(() => answer('Google'), {
    KADE_LIBRARY_VISION_MODEL: 'google/gemini-3.8-flash',
  });
  await google.internals.lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.');
  /* Nov 14 2026: Vertex's flex tier first (half the price, zero retention kept). */
  assert.deepEqual(plain(google.calls[0].body.provider), FLEX);
  const standard = load(() => answer('Google'), {
    KADE_LIBRARY_VISION_MODEL: 'google/gemini-3.8-flash',
    KADE_VIDEO_TIER: 'standard',
  });
  await standard.internals.lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.');
  assert.deepEqual(plain(standard.calls[0].body.provider), STANDARD);
});

test('MiMo segments default to five minutes and each look may take ten; the env setting still wins', async () => {
  /* Novita looks at about 150 frames whatever the length: a 15-minute segment had not answered in
   * ten minutes on Oct 16 2026, a 5-minute one answered in 51 s. */
  const mimo = load(() => answer('Novita'));
  await mimo.internals.lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.');
  assert.equal(mimo.calls[0].config.timeout, 600000);
  const stubs = {
    '~/server/services/kadeMediaRoute': require('../services/kadeMediaRoute'),
    '~/server/services/kadeRealCost': require('../services/kadeRealCost'),
    '~/models/kadeUsage': { logKadeUsage() {}, KadeUsage: {} },
    '@librechat/data-schemas': { logger: { warn() {}, info() {} } },
  };
  const library = (env) => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('./kadeReadingRoomDescribe'), 'utf8'), {
      module,
      process: { env },
      require: (id) => stubs[id] || require(id),
    });
    return module.exports;
  };
  assert.equal(library({}).estimate(1800).segments, 6);
  /* Nov 13 2026: Google segments are five minutes too (they were fifteen), so a look's timeline
   * stays short; the soundtrack and the frames cost the same either way. */
  assert.equal(
    library({ KADE_LIBRARY_VISION_MODEL: 'google/gemini-3.8-flash' }).estimate(1800).segments,
    6,
  );
  assert.equal(library({}).estimate(1800).model, 'google/gemini-3.8-flash');
  assert.equal(library({ KADE_VIDEO_MODEL: 'mimo' }).estimate(1800).model, 'xiaomi/mimo-v2.6-pro');
  assert.equal(library({ KADE_DESCRIBE_SEGMENT_SECONDS: '600' }).estimate(1800).segments, 3);
});

/* Nov 13 2026: Novita stopped serving MiMo, so by default a Library segment goes to the video model.
 * Nov 14 2026: on Vertex's flex tier first, with two minutes more for Google's queue. */
test('by default a Library segment goes to the video model on Google Vertex flex: zero retention, 8,000 thinking tokens, a nine-minute deadline', async () => {
  const { internals, calls } = load(() => answer('Google'), { KADE_VIDEO_MODEL: '' });
  const result = await internals.lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.');
  assert.ok(result.text.includes('furniture store'), JSON.stringify(result));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, 'google/gemini-3.8-flash');
  assert.deepEqual(plain(calls[0].body.provider), FLEX);
  assert.deepEqual(plain(calls[0].body.reasoning), { max_tokens: 8000 });
  assert.equal(calls[0].config.timeout, 540000);
});

test('a decline from Google of a Library segment is asked once and never becomes a scene', async () => {
  const declined = { finish_reason: 'stop', native_finish_reason: 'SAFETY', message: { content: 'I cannot.' } };
  const { internals, calls } = load(() => answer('Google', declined, 0.00004), { KADE_VIDEO_MODEL: '' });
  const result = await internals.lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.');
  assert.equal(calls.length, 1);
  assert.equal(result.refused, true);
  assert.equal(result.text, '');
});

/* Nov 14 2026: a flex try that fails is asked once more on the standard tier. OpenRouter never
 * moves a flex request to standard by itself (flex is pinned with no fallback). */
test('a Library segment that flex turns away (429) is asked once more on the standard tier, and its scenes are kept', async () => {
  const { internals, calls, warnings } = load(
    (_body, n) => {
      if (n === 1) throw httpError(429);
      return answer('Google');
    },
    { KADE_VIDEO_MODEL: '' },
  );
  const result = await internals.lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.');
  assert.equal(calls.length, 2);
  assert.deepEqual(plain(calls[0].body.provider), FLEX);
  assert.equal(calls[0].config.timeout, 540000);
  assert.deepEqual(plain(calls[1].body.provider), STANDARD);
  assert.equal(calls[1].config.timeout, 420000);
  assert.equal(internals.parseScenes(result.text).scenes[0].text, 'A sofa on sale.');
  assert.equal(result.costUSD, 0.002);
  assert.deepEqual(warnings, [
    '[library/describe] the flex try failed (HTTP 429); asking again on the standard tier',
  ]);
});

test('server errors, a missing flex endpoint, a timeout and an error inside the reply each get one standard try', async () => {
  const timeout = Object.assign(new Error('timeout of 540000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' });
  for (const failure of [httpError(503), httpError(500), httpError(404), timeout, { error: { code: 502, message: 'Provider returned error' } }]) {
    const { internals, calls } = load(
      (_body, n) => {
        if (n > 1) return answer('Google');
        if (failure instanceof Error) throw failure;
        return failure;
      },
      { KADE_VIDEO_MODEL: '' },
    );
    const result = await internals.lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.');
    assert.equal(calls.length, 2, failure.message || JSON.stringify(failure));
    assert.deepEqual(plain(calls[1].body.provider), STANDARD);
    assert.ok(result.text.includes('furniture store'));
  }
});

/* Nov 14 2026 review: a cut-off reply is read as it was before flex (parseScenes salvages what it
 * can). Standard would be cut off at the same limit, at twice the price. */
test('a flex reply cut off at its token limit is read as before and not asked again on standard', async () => {
  const cut = { finish_reason: 'length', native_finish_reason: 'MAX_TOKENS', message: { content: '{"summary": "A furn' } };
  const { internals, calls, warnings } = load(
    (_body, n) => (n === 1 ? answer('Google', cut, 0.01) : answer('Google')),
    { KADE_VIDEO_MODEL: '' },
  );
  const result = await internals.lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.');
  assert.equal(calls.length, 1);
  assert.equal(result.text, '{"summary": "A furn');
  near(result.costUSD, 0.01);
  assert.deepEqual(warnings, []);
});

test('a timed-out flex try is logged as one that may still be billed', async () => {
  const timeout = Object.assign(new Error('timeout of 540000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' });
  const { internals, calls, warnings } = load(
    (_body, n) => {
      if (n === 1) throw timeout;
      return answer('Google');
    },
    { KADE_VIDEO_MODEL: '' },
  );
  await internals.lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.');
  assert.equal(calls.length, 2);
  assert.deepEqual(warnings, [
    '[library/describe] the flex try failed (ECONNABORTED: timed out; the flex try may still be billed); asking again on the standard tier',
  ]);
});

test('a Google model with no known flex tier is asked on standard only, and estimated at its own rates', async () => {
  const argon = { KADE_VIDEO_MODEL: 'google/gemini-4-argon', KADE_VIDEO_IN_USD_PER_M: '2', KADE_VIDEO_OUT_USD_PER_M: '10' };
  const { internals, calls, library } = load(() => answer('Google'), argon);
  await internals.lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, 'google/gemini-4-argon');
  assert.deepEqual(plain(calls[0].body.provider), STANDARD);
  /* Ten minutes: 60,000 tokens in and 18,440 out at $2 and $10 a million: $0.3044. */
  assert.equal(library.estimate(600).usd, 0.3044);
});

test('a bad request or no credit on flex is not asked again on standard, and a decline stands', async () => {
  for (const status of [400, 402]) {
    const { internals, calls } = load(() => { throw httpError(status); }, { KADE_VIDEO_MODEL: '' });
    const failure = await internals.lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.').catch((e) => e);
    assert.equal(failure.response.status, status);
    assert.equal(calls.length, 1, String(status));
  }
  const declined = { finish_reason: 'stop', native_finish_reason: 'SAFETY', message: { content: 'I cannot.' } };
  const { internals, calls } = load(() => answer('Google', declined, 0.00004), { KADE_VIDEO_MODEL: '' });
  const result = await internals.lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.');
  assert.equal(calls.length, 1, 'Google declines the same clip on standard too');
  assert.equal(result.refused, true);
});

test('when the standard try fails too, the flex reply already paid for rides on the failure', async () => {
  const cut = { finish_reason: 'error', error: { code: 502, message: 'Provider returned error' }, message: { content: '' } };
  const { internals, calls } = load(
    (_body, n) => {
      if (n === 1) return answer('Google', cut, 0.01);
      throw httpError(500);
    },
    { KADE_VIDEO_MODEL: '' },
  );
  const failure = await internals.lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.').catch((e) => e);
  assert.equal(calls.length, 2);
  assert.deepEqual(plain(calls[1].body.provider), STANDARD);
  assert.equal(failure.response.status, 500);
  /* describeTrack adds it to what the job spent before, for the server log. */
  near(failure.costUSD, 0.01);
});

test('the estimate is priced at the flex tier; KADE_VIDEO_TIER=standard and a MiMo library keep their own prices', () => {
  const stubs = {
    '~/server/services/kadeMediaRoute': require('../services/kadeMediaRoute'),
    '~/server/services/kadeRealCost': require('../services/kadeRealCost'),
    '~/models/kadeUsage': { logKadeUsage() {}, KadeUsage: {} },
    '@librechat/data-schemas': { logger: { warn() {}, info() {} } },
  };
  const library = (env) => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('./kadeReadingRoomDescribe'), 'utf8'), {
      module,
      process: { env },
      require: (id) => stubs[id] || require(id),
    });
    return module.exports;
  };
  /* Ten minutes: two segments, 60,000 tokens in, and 2,440 of words plus 16,000 of thinking out.
   * On flex at $0.375 and $1.875 a million: $0.0571. On standard at $0.825 and $4.125: $0.1256. */
  assert.equal(library({}).estimate(600).usd, 0.0571);
  assert.equal(library({ KADE_VIDEO_TIER: 'standard' }).estimate(600).usd, 0.1256);
  assert.equal(
    library({ KADE_VIDEO_FLEX_IN_USD_PER_M: '0.75', KADE_VIDEO_FLEX_OUT_USD_PER_M: '3.75' }).estimate(600).usd,
    0.1142,
  );
  /* A MiMo library has no flex tier: 240,000 tokens in, 2,440 out, at MiMo Pro's $0.435 and $0.87. */
  assert.equal(library({ KADE_VIDEO_MODEL: 'mimo' }).estimate(600).usd, 0.1065);
});

test('the $2 daily cap: a run on flex is booked at what flex cost, and a day already at $2 starts nothing', async () => {
  const rows = [];
  let spent = 0;
  const usage = {
    logKadeUsage: (row) => rows.push(row),
    KadeUsage: { aggregate: async () => [{ usd: spent }] },
  };
  /* A reply that names no cost (as a BYOK reply without Google's figure does). */
  const unpriced = {
    provider: 'Google',
    choices: [{ finish_reason: 'stop', message: { content: scenes } }],
    usage: { prompt_tokens: 30000, completion_tokens: 4000 },
  };
  const { library, calls } = load(() => unpriced, { KADE_VIDEO_MODEL: '' }, usage);
  const run = (bookId) =>
    new Promise((resolve) => {
      library.enqueue({
        bookId,
        t: 0,
        userId: 'u1',
        signedUrl: 'https://example.invalid/track',
        mime: 'video/mp4',
        title: 'Ad',
        category: 'commercial',
        /* Answered after the queue has logged the run's usage row. */
        onDone: async (err, result) => setImmediate(() => resolve({ err, result })),
      });
    });
  const first = await run('b1');
  assert.equal(first.err, null);
  assert.equal(calls.length, 2, 'two five-minute segments');
  /* Each segment: 30,000 tokens in and 4,000 out at $0.375 and $1.875 a million is $0.01875. */
  near(first.result.costUSD, 0.0375);
  assert.equal(rows.length, 1);
  near(rows[0].costUSD, 0.0375);
  assert.equal(rows[0].metadata.source, 'library');
  spent = 2;
  const second = await run('b2');
  assert.match(second.err.message, /Today's description allowance \(\$2\.00\) is used up/);
  assert.equal(calls.length, 2, 'no model call once the day is spent');
  assert.equal(rows.length, 1);
});
