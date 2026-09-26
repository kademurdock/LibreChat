import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  analyze,
  billed,
  failureClass,
  providerDetail,
  providerProblem,
  visionLimits,
  voices,
} from './providers.ts';
import { MediaError } from './media.ts';
import { folderBytes } from './youtube.ts';

const axios = createRequire(import.meta.url)('axios');
const scratch = await mkdtemp(join(tmpdir(), 'described-providers-test-'));
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A streamed reply as OpenRouter sends one: keep-alive spaces first, then the JSON. */
const streamed = (data) => Readable.from([Buffer.from('\n \n'), Buffer.from(JSON.stringify(data))]);
/**
 * A reply OpenRouter keeps alive with a space every 40 ms and never finishes: only the request's
 * own deadline, or our stop, ends it (axios's idle timer never would).
 */
function endless() {
  let timer;
  return new Readable({
    read() {
      timer ??= setInterval(() => this.push(' '), 40);
    },
    destroy(error, callback) {
      clearInterval(timer);
      callback(error);
    },
  });
}
function fakeAxios(handler) {
  const calls = [];
  const previous = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    const call = { url: config.url, body: typeof config.data === 'string' ? JSON.parse(config.data) : undefined, config };
    calls.push(call);
    const reply = await handler(call, calls.length);
    if (reply instanceof Error) throw reply;
    const data =
      config.responseType === 'stream' && !(reply.data instanceof Readable) ? streamed(reply.data) : reply.data;
    return { status: 200, statusText: 'OK', headers: reply.headers ?? {}, data, config };
  };
  return { calls, restore: () => (axios.defaults.adapter = previous) };
}
const httpError = (config, status, data) =>
  new axios.AxiosError(`Request failed with status code ${status}`, status < 500 ? 'ERR_BAD_REQUEST' : 'ERR_BAD_RESPONSE', config, {}, {
    status,
    statusText: '',
    headers: {},
    data,
    config,
  });
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

const good = {
  id: 'gen-ok',
  provider: 'Google',
  choices: [
    {
      finish_reason: 'stop',
      message: { content: JSON.stringify({ cues: [{ at: 1, until: 4, pauseAt: 1, text: 'A cook flips a pancake.', shortText: 'A cook flips.', importance: 2 }] }) },
    },
  ],
  usage: { cost: 0.031, completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 3500 } },
};
const clip = async (name) => {
  const file = join(scratch, name);
  await writeFile(file, Buffer.from('clip'));
  return { file, seconds: 10, brief, state: null, lines: [], before: [] };
};
/** A meter that keeps what each paid call reserved and settled, or what its failure carried. */
function ledger() {
  const entries = [];
  const meter = async (kind, reserve, action) => {
    try {
      const outcome = await action();
      entries.push({ kind, reserve, costUSD: outcome.costUSD });
    } catch (error) {
      const { costUSD, costFrom, expectedUSD, generation } = error;
      entries.push({ kind, reserve, error, costUSD, costFrom, expectedUSD, generation });
      throw error;
    }
  };
  return { entries, meter };
}
/** Shorter request and lookup limits for one test (the real ones: 300 s, and 5, 15 and 40 s within a minute). */
async function limited(values, run) {
  const saved = { ...visionLimits, lookupAtMs: [...visionLimits.lookupAtMs] };
  Object.assign(visionLimits, values);
  try {
    return await run();
  } finally {
    Object.assign(visionLimits, saved);
  }
}
const recordOf = (config, total_cost) => ({
  data: { data: { id: new URL(config.url).searchParams.get('id'), total_cost, provider_name: 'Google', native_tokens_reasoning: 900 } },
});

test('providers: a reply kept alive past the deadline is a timeout; the recorded cost of its generation is booked, and it is tried once more', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const look = await clip('slow.mp4');
  const lookups = [];
  let chats = 0;
  let sent = 0;
  const fake = fakeAxios(({ url, config }) => {
    if (url.includes('/generation')) {
      lookups.push({ url, at: Date.now(), auth: config.headers.Authorization, agent: config.headers['User-Agent'] });
      return lookups.length === 1
        ? httpError(config, 404, { error: { message: 'Generation not found' } })
        : recordOf(config, 0.0123);
    }
    if (++chats === 1) {
      sent = Date.now();
      return { headers: { 'x-generation-id': 'gen-slow' }, data: endless() };
    }
    return { headers: { 'x-generation-id': 'gen-ok' }, data: good };
  });
  const { entries, meter } = ledger();
  const log = [];
  try {
    const result = await limited({ requestMs: 400, lookupAtMs: [30, 120, 300], lookupMs: 1000 }, () =>
      analyze({ ...look, log: (line) => log.push(line) }, signal, meter),
    );
    assert.equal(chats, 2, 'one more try after a timeout');
    assert.equal(result.cues.length, 1);
    assert.deepEqual(result.vision.map((call) => [call.generation, call.costUSD]), [['gen-ok', 0.031]]);
    const [failed, finished] = entries;
    assert.equal(failed.error.code, 'ETIMEDOUT', 'the deadline is a timeout like axios’s own');
    assert.equal(providerProblem(failed.error, 'The video model'), 'The video model took too long to answer.');
    assert.equal(failed.generation, 'gen-slow', 'the id from the headers survives the failure');
    assert.equal(failed.costUSD, 0.0123, 'OpenRouter’s record, not the reserve');
    assert.equal(failed.costFrom, 'generation');
    assert.equal(failed.expectedUSD, undefined);
    assert.equal(finished.costUSD, 0.031);
    assert.ok(failed.reserve > 0.1, `the reserve was ${failed.reserve}`);
    assert.equal(lookups.length, 2, 'asked again after a 404 until the record appeared');
    assert.equal(lookups[0].url, 'https://openrouter.ai/api/v1/generation?id=gen-slow');
    assert.equal(lookups[0].auth, 'Bearer test-key');
    assert.match(lookups[0].agent, /^Mozilla\/5\.0/);
    const cut = lookups[0].at - sent;
    assert.ok(cut >= 400 && cut < 1500, `the whole request was cut at its deadline although spaces kept arriving (${cut} ms)`);
    assert.ok(
      log.some((line) => line.startsWith("vision: the failed request gen-slow cost $0.0123 by OpenRouter's record")),
      log.join('\n'),
    );
  } finally {
    fake.restore();
  }
});

test('providers: over real HTTP, the generation id arrives with the headers, spaces cannot hold the request past its deadline, and the retry reads a spaced reply', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const look = await clip('real.mp4');
  let chats = 0;
  const lookups = [];
  const server = createServer((req, res) => {
    if (req.url.startsWith('/api/v1/generation')) {
      lookups.push({ url: req.url, auth: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: { id: 'gen-real-1', total_cost: 0.0171, provider_name: 'Google' } }));
    }
    req.resume();
    req.on('end', () => {
      const n = ++chats;
      res.writeHead(200, { 'Content-Type': 'application/json', 'x-generation-id': `gen-real-${n}` });
      const spaces = setInterval(() => res.write(' '), 30);
      res.on('close', () => clearInterval(spaces));
      if (n > 1)
        setTimeout(() => {
          clearInterval(spaces);
          res.end(JSON.stringify({ ...good, id: `gen-real-${n}` }));
        }, 150);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${server.address().port}`;
  const previous = axios.defaults.adapter;
  const http = axios.getAdapter('http');
  axios.defaults.adapter = (config) => http({ ...config, url: config.url.replace('https://openrouter.ai', local) });
  const { entries, meter } = ledger();
  try {
    const result = await limited({ requestMs: 500, lookupAtMs: [20], lookupMs: 1000 }, () => analyze(look, signal, meter));
    assert.equal(chats, 2);
    assert.equal(result.cues.length, 1);
    assert.equal(entries[0].error.code, 'ETIMEDOUT');
    assert.equal(entries[0].generation, 'gen-real-1');
    assert.equal(entries[0].costUSD, 0.0171);
    assert.deepEqual(lookups, [{ url: '/api/v1/generation?id=gen-real-1', auth: 'Bearer test-key' }]);
    assert.deepEqual(result.vision.map((call) => [call.generation, call.costUSD]), [['gen-real-2', 0.031]]);
  } finally {
    axios.defaults.adapter = previous;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('providers: a failed look OpenRouter never priced carries its expected cost, well under the reserve, and a second timeout is not tried again', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const look = await clip('unpriced.mp4');
  const lookups = [];
  let chats = 0;
  const fake = fakeAxios(({ url, config }) => {
    if (url.includes('/generation')) {
      lookups.push(new URL(url).searchParams.get('id'));
      return httpError(config, 404, { error: { message: 'Generation not found' } });
    }
    return { headers: { 'x-generation-id': `gen-${++chats}` }, data: endless() };
  });
  const { entries, meter } = ledger();
  const log = [];
  try {
    const failure = await limited({ requestMs: 250, lookupAtMs: [20, 60, 5000], lookupMs: 400 }, () =>
      analyze({ ...look, log: (line) => log.push(line) }, signal, meter).catch((error) => error),
    );
    assert.equal(chats, 2, 'at most one more try after a timeout');
    assert.equal(failureClass(failure), 'transient');
    assert.equal(billed(failure), true);
    assert.deepEqual(lookups, ['gen-1', 'gen-1', 'gen-2', 'gen-2'], 'a lookup planned past the time limit is never asked');
    for (const [i, entry] of entries.entries()) {
      assert.equal(entry.generation, `gen-${i + 1}`);
      assert.equal(entry.costUSD, undefined);
      assert.ok(entry.expectedUSD > 0.045, `a typical reply is priced in: ${entry.expectedUSD}`);
      assert.ok(
        Math.abs(entry.reserve - entry.expectedUSD - (0.01 + (12000 - 6000) * 7.5e-6)) < 1e-9,
        `the expected cost is the reserve less its margin and the reply tokens a look does not usually use: ${entry.expectedUSD} of ${entry.reserve}`,
      );
    }
    assert.ok(log.some((line) => line.startsWith('vision: no record of what the failed request gen-1 cost; booked at the expected $')), log.join('\n'));
  } finally {
    fake.restore();
  }
});

test('providers: an error OpenRouter sends inside a 200 reply is a provider failure with its message, retried unless its code blames the request', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const look = await clip('upstream.mp4');
  let chats = 0;
  let lookups = 0;
  let fake = fakeAxios(({ url, config }) => {
    if (url.includes('/generation')) {
      lookups++;
      return recordOf(config, 0);
    }
    return ++chats === 1
      ? { headers: { 'x-generation-id': 'gen-err' }, data: { error: { code: 502, message: 'Upstream provider timed out after 290 s' } } }
      : { data: good };
  });
  let { entries, meter } = ledger();
  try {
    const result = await limited({ lookupAtMs: [10], lookupMs: 500 }, () => analyze(look, signal, meter));
    assert.equal(result.cues.length, 1);
    assert.equal(chats, 2);
    const failed = entries[0].error;
    assert.notEqual(failed.name, 'ZodError', 'not an unreadable reply');
    assert.equal(failed.message, 'Upstream provider timed out after 290 s');
    assert.equal(failureClass(failed), 'transient');
    assert.match(providerDetail(failed), /^code 502 Upstream provider timed out after 290 s$/);
    assert.equal(
      providerProblem(failed, 'The video model'),
      'The video model stopped with an error before finishing its reply (code 502).',
    );
    assert.equal(lookups, 1);
    assert.equal(entries[0].costUSD, 0, 'OpenRouter’s record says it cost nothing, and that is what is booked');
    assert.equal(entries[0].costFrom, 'generation');
    assert.equal(fake.calls.filter((call) => call.url.includes('chat'))[1].body.response_format.type, 'json_schema', 'the retry keeps the schema');
  } finally {
    fake.restore();
  }

  chats = 0;
  lookups = 0;
  fake = fakeAxios(({ url, config }) => {
    if (url.includes('/generation')) {
      lookups++;
      return recordOf(config, 0.02);
    }
    chats++;
    return { headers: { 'x-generation-id': 'gen-bad' }, data: { error: { code: 400, message: 'Invalid video: could not decode' } } };
  });
  ({ entries, meter } = ledger());
  try {
    const failure = await analyze(look, signal, meter).catch((error) => error);
    assert.equal(chats, 1, 'a request the provider called bad is not sent again');
    assert.equal(lookups, 0, 'nor looked up: a refusal is not billed');
    assert.equal(failureClass(failure), 'input');
    assert.equal(billed(failure), false);
    assert.equal(entries[0].generation, 'gen-bad');
    assert.equal(entries[0].costUSD, undefined);
    assert.equal(entries[0].expectedUSD, undefined);
  } finally {
    fake.restore();
  }
});

test('providers: our stop while the reply is streaming ends the request at once and leaves it unpriced for the meter', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const look = await clip('stopped.mp4');
  const controller = new AbortController();
  let lookups = 0;
  const fake = fakeAxios(({ url, config }) => {
    if (url.includes('/generation')) {
      lookups++;
      return recordOf(config, 0.02);
    }
    setTimeout(() => controller.abort(new Error('shutdown')), 100);
    return { headers: { 'x-generation-id': 'gen-cut' }, data: endless() };
  });
  const { entries, meter } = ledger();
  try {
    const began = Date.now();
    const failure = await analyze(look, controller.signal, meter).catch((error) => error);
    assert.ok(Date.now() - began < 2000, `the stop ended it at once, not the ${visionLimits.requestMs / 1000} s deadline`);
    assert.equal(axios.isCancel(failure), true, 'the same cancel axios gives for our stop');
    assert.equal(fake.calls.length, 1);
    assert.equal(lookups, 0);
    assert.equal(entries[0].generation, 'gen-cut', 'the operator can still look it up');
    assert.equal(entries[0].costUSD, undefined, 'the meter treats it as ours: interrupted, nothing to her');
    assert.equal(entries[0].expectedUSD, undefined);
  } finally {
    fake.restore();
  }
});

test('providers: a finished reply is booked at its reported cost without a lookup, with the generation id from the headers when the body has none', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const look = await clip('finished.mp4');
  let lookups = 0;
  const fake = fakeAxios(({ url, config }) => {
    if (url.includes('/generation')) {
      lookups++;
      return recordOf(config, 0.02);
    }
    return { headers: { 'x-generation-id': 'gen-head' }, data: { ...good, id: null } };
  });
  const { entries, meter } = ledger();
  try {
    const result = await analyze(look, signal, meter);
    assert.equal(fake.calls[0].config.responseType, 'stream');
    assert.deepEqual(entries.map((entry) => entry.costUSD), [0.031]);
    assert.deepEqual(result.vision.map((call) => [call.generation, call.costUSD, call.reasoningTokens]), [['gen-head', 0.031, 3500]]);
    assert.equal(lookups, 0);
  } finally {
    fake.restore();
  }
});

test('providers: a refused request’s streamed body still says what the provider said, and a refusal is never looked up', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const look = await clip('refused-body.mp4');
  let lookups = 0;
  const fake = fakeAxios(({ url, config }) => {
    if (url.includes('/generation')) {
      lookups++;
      return recordOf(config, 0.02);
    }
    return httpError(config, 400, streamed({ error: { message: 'No endpoints found that support video input. key=sk-or-v1-abcdef123456' } }));
  });
  const { entries, meter } = ledger();
  try {
    const failure = await analyze(look, signal, meter).catch((error) => error);
    assert.equal(fake.calls.length, 1);
    assert.equal(failureClass(failure), 'input');
    assert.match(providerDetail(failure), /^400 \{"error":\{"message":"No endpoints found that support video input\. \[hidden\]"\}\}$/);
    assert.equal(lookups, 0);
    assert.equal(entries[0].costUSD, undefined);
    assert.equal(entries[0].expectedUSD, undefined);
  } finally {
    fake.restore();
  }
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
