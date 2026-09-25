import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { analyze, failureClass, providerProblem, voices } from './providers.ts';
import { MediaError } from './media.ts';
import { folderBytes } from './youtube.ts';

const axios = createRequire(import.meta.url)('axios');
const scratch = await mkdtemp(join(tmpdir(), 'described-providers-test-'));
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function fakeAxios(handler) {
  const calls = [];
  const previous = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    const call = { url: config.url, body: typeof config.data === 'string' ? JSON.parse(config.data) : undefined, config };
    calls.push(call);
    const reply = await handler(call, calls.length);
    if (reply instanceof Error) throw reply;
    return { status: 200, statusText: 'OK', headers: reply.headers ?? {}, data: reply.data, config };
  };
  return { calls, restore: () => (axios.defaults.adapter = previous) };
}
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const signal = new AbortController().signal;
const meter = async (_kind, _reserve, action) => {
  await action();
};
const brief = {
  title: 'Test',
  about: '',
  notes: '',
  detail: 'rich',
  rate: 1.5,
  maxRate: 2.25,
  mode: 'standard',
};

test('providers: a full disk or a crashed tool is worth another try, a damaged clip is not', () => {
  assert.equal(failureClass(new MediaError('disk', 'exit 1: No space left on device')), 'transient');
  assert.equal(failureClass(new MediaError('tools', 'exit null: ')), 'transient');
  assert.equal(failureClass(new MediaError('damaged', 'exit 1: moov atom not found')), 'input');
  assert.equal(failureClass(new MediaError('too-detailed', 'clip over')), 'input');
});

test('providers: a reply cut off twice is not paid for again and says the part had too much to describe', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const file = join(scratch, 'dense.mp4');
  await writeFile(file, Buffer.from('clip'));
  const fake = fakeAxios(() => ({
    data: {
      choices: [{ finish_reason: 'length', native_finish_reason: 'MAX_TOKENS', message: { content: '{"cues":[' } }],
      usage: { cost: 0.12 },
    },
  }));
  try {
    const failure = await analyze(
      { file, seconds: 10, brief, state: null, lines: [], before: [] },
      signal,
      meter,
    ).catch((error) => error);
    assert.equal(fake.calls.length, 2);
    assert.equal(failureClass(failure), 'input');
    assert.equal(
      providerProblem(failure, 'The video model'),
      'The video model had too much to say about this part to fit in one reply. Describe this part again with less detail, or without the closer look.',
    );
  } finally {
    fake.restore();
  }
  assert.equal(failureClass(new SyntaxError('The visual description came back incomplete.')), 'transient');
});

test('providers: a voice list that hangs is asked for once, remembered for a minute, and a stale copy answers at once', async () => {
  process.env.KADE_TTS_PROXY_URL = 'http://voices.test';
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;
  let mode = 'down';
  const list = (name) => ({ data: { voices: [name] } });
  const fake = fakeAxios(async ({ config }) => {
    if (mode === 'down')
      return new axios.AxiosError('Request failed with status code 502', 'ERR_BAD_RESPONSE', config, {}, {
        status: 502,
        statusText: '',
        headers: {},
        data: '',
        config,
      });
    await later(300);
    if (mode === 'hung') return new axios.AxiosError('timeout of 15000ms exceeded', 'ECONNABORTED', config);
    return list(mode);
  });
  try {
    await assert.rejects(voices());
    await assert.rejects(voices());
    assert.equal(fake.calls.length, 2, 'a quick refusal is not remembered');

    mode = 'hung';
    const both = await Promise.allSettled([voices(), voices()]);
    assert.deepEqual(both.map((result) => result.status), ['rejected', 'rejected']);
    assert.equal(fake.calls.length, 3, 'callers waiting together share one request');
    let began = realNow();
    await assert.rejects(voices());
    assert.ok(realNow() - began < 200, 'a hang is remembered instead of waited out again');
    assert.equal(fake.calls.length, 3);

    shift += 61000;
    mode = 'Voice 1';
    assert.deepEqual((await voices()).voices, ['Voice 1']);
    assert.equal(fake.calls.length, 4);

    shift += 6 * 60000;
    mode = 'Voice 2';
    began = realNow();
    assert.deepEqual((await voices()).voices, ['Voice 1'], 'the stale copy answers first');
    assert.deepEqual((await voices()).voices, ['Voice 1']);
    assert.ok(realNow() - began < 200);
    assert.equal(fake.calls.length, 5, 'one refresh in the background');
    await later(500);
    assert.deepEqual((await voices()).voices, ['Voice 2']);
    assert.equal(fake.calls.length, 5);
  } finally {
    Date.now = realNow;
    fake.restore();
  }
});

test('providers: the voice list keeps old spellings and the fish.audio labels, and a bad field is dropped, not fatal', async () => {
  process.env.KADE_TTS_PROXY_URL = 'http://voices.test';
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;
  let reply = {
    voices: ['clear woman · flint', 'clear high-ish young woman · dory', 'Kade Murdock'],
    describe: { 'Kade Murdock': 'warm and natural' },
    renames: { 'Voice 541': 'clear high-ish young woman · dory', 'Voice 650': 'clear woman · flint' },
    fish: ['Kade Murdock'],
    custom: [541],
  };
  const fake = fakeAxios(async () => ({ data: reply }));
  const fresh = async () => {
    shift += 30 * 60000; // past any copy an earlier test left, even one stamped in its own shifted time
    await voices().catch(() => {});
    await later(50);
    return voices();
  };
  try {
    let list = await fresh();
    assert.deepEqual(list.renames, {
      'Voice 541': 'clear high-ish young woman · dory',
      'Voice 650': 'clear woman · flint',
    });
    assert.deepEqual(list.fish, ['Kade Murdock']);
    assert.equal(list.custom, undefined, 'only the fields the describer reads are kept');

    reply = { voices: ['Voice 1'], renames: 'not a map', fish: [42] };
    list = await fresh();
    assert.deepEqual(list.voices, ['Voice 1']);
    assert.equal(list.renames, undefined);
    assert.equal(list.fish, undefined);

    reply = { voices: ['Voice 1'] };
    list = await fresh();
    assert.equal(list.renames, undefined, 'an older proxy without the new fields still works');
    assert.equal(list.fish, undefined);
  } finally {
    Date.now = realNow;
    fake.restore();
  }
});

test('youtube: the size watch skips a file renamed or removed while it counts', async () => {
  const folder = await mkdtemp(join(scratch, 'download-'));
  await writeFile(join(folder, 'youtube.mp4'), Buffer.alloc(1234));
  const listed = async () => ['youtube.f137.mp4.part', 'youtube.mp4'];
  assert.equal(await folderBytes(folder, listed), 1234);
  assert.equal(await folderBytes(folder), 1234);
});
