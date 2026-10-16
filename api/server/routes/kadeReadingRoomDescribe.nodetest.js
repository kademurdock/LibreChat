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
function load(reply, env = {}) {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./kadeReadingRoomDescribe'), 'utf8'), {
    module,
    Buffer,
    setImmediate,
    process: { env: { OPENROUTER_KEY: 'fake-local-test', ...env } },
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
      if (id === '@librechat/data-schemas') return { logger: { warn() {}, info() {} } };
      if (id === '~/models/kadeUsage') return { logKadeUsage() {}, KadeUsage: {} };
      if (id === '~/server/services/kadeRealCost') return require('../services/kadeRealCost');
      if (id === '~/server/services/kadeMediaRoute') return require('../services/kadeMediaRoute');
      throw Error(`Unexpected dependency: ${id}`);
    },
  });
  return { internals: module.exports._internals, calls };
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
  const saved = process.env.KADE_VIDEO_HOSTS;
  process.env.KADE_VIDEO_HOSTS = 'Novita,GMICloud';
  try {
    const { internals, calls } = load(() => answer('GMICloud'));
    await internals.lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.');
    assert.deepEqual(plain(calls[0].body.provider.only), ['Novita', 'GMICloud']);
  } finally {
    if (saved === undefined) delete process.env.KADE_VIDEO_HOSTS;
    else process.env.KADE_VIDEO_HOSTS = saved;
  }
  const google = load(() => answer('Google'), {
    KADE_LIBRARY_VISION_MODEL: 'google/gemini-3.8-flash',
  });
  await google.internals.lookAt(Buffer.from('mp4'), 'video/mp4', 'Describe this.');
  assert.deepEqual(plain(google.calls[0].body.provider), {
    zdr: true,
    data_collection: 'deny',
    ignore: ['google-ai-studio'],
  });
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
  assert.equal(
    library({ KADE_LIBRARY_VISION_MODEL: 'google/gemini-3.8-flash' }).estimate(1800).segments,
    2,
  );
  assert.equal(library({ KADE_DESCRIBE_SEGMENT_SECONDS: '600' }).estimate(1800).segments, 3);
});
