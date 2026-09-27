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
  expectedLook,
  failureClass,
  providerDetail,
  providerProblem,
  realCost,
  visionLimits,
  voices,
} from './providers.ts';
import { MediaError } from './media.ts';
import { folderBytes } from './youtube.ts';

const axios = createRequire(import.meta.url)('axios');
/*
 * The tests written before the tiers ask the standard tier, as every look did then; the tier tests
 * below set their own (KADE_DESCRIPTION_TIER, or the look's own `tier`).
 */
process.env.KADE_DESCRIPTION_TIER = 'standard';
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
      entries.push({ kind, reserve, costUSD: outcome.costUSD, uncertain: outcome.uncertain });
    } catch (error) {
      const { costUSD, costFrom, expectedUSD, generation, interrupted } = error;
      entries.push({ kind, reserve, error, costUSD, costFrom, expectedUSD, generation, interrupted });
      throw error;
    }
  };
  return { entries, meter };
}
/**
 * What the describer expects a look OpenRouter never priced to have cost, worked out from its
 * reserve (the clip at 400 tokens a second, the prompt at 3 characters a token and all its output
 * tokens at the `max_price` ceiling, plus $0.01), which fixes its prompt's length: the clip at 85
 * tokens a second and the prompt at 4 characters a token, and its expected reasoning plus 3,000
 * answer tokens, at the list price ($0.75 and $3.75 per million).
 */
function expectedOf(reserve, { seconds = 10, maxTokens = 12000, reasoning = 6000, price = { prompt: 0.75, completion: 3.75 } } = {}) {
  const characters = ((reserve - 0.01 - maxTokens * 7.5e-6) / 1.5e-6 - seconds * 400) * 3;
  return Math.min(reserve, ((seconds * 85 + characters / 4) * price.prompt + (reasoning + 3000) * price.completion) / 1e6);
}
/** Vertex's flex price for google/gemini-3.8-flash, per million tokens (OpenRouter's endpoint list, Sep 26 2026). */
const flexPrice = { prompt: 0.375, completion: 1.875 };
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
      assert.ok(entry.expectedUSD > 9000 * 3.75e-6, `a typical reply is priced in: ${entry.expectedUSD}`);
      assert.ok(
        Math.abs(entry.expectedUSD - expectedOf(entry.reserve)) < 1e-9,
        `the expected cost is its clip, prompt and a typical reply at the list price: ${entry.expectedUSD} of ${entry.reserve}`,
      );
      assert.ok(entry.expectedUSD < entry.reserve / 3, `${entry.expectedUSD} of ${entry.reserve}`);
      assert.equal(entry.interrupted, false);
    }
    assert.ok(log.some((line) => line.startsWith('vision: no record of what the failed request gen-1 cost; booked at the expected $')), log.join('\n'));
  } finally {
    fake.restore();
  }
});

test('providers: an error OpenRouter sends inside a 200 reply is a provider failure with its message, retried unless its code blames the request, and looked up whatever its code', async () => {
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
    const failure = await limited({ lookupAtMs: [10], lookupMs: 500 }, () =>
      analyze(look, signal, meter).catch((error) => error),
    );
    assert.equal(chats, 1, 'a request the provider called bad is not sent again');
    assert.equal(failureClass(failure), 'input');
    assert.equal(billed(failure), true, 'sent after the headers, so the provider may have charged for reading it');
    assert.equal(lookups, 1, 'looked up, since only OpenRouter’s record can say');
    assert.equal(entries[0].generation, 'gen-bad');
    assert.equal(entries[0].costUSD, 0.02);
    assert.equal(entries[0].costFrom, 'generation');
    assert.equal(entries[0].expectedUSD, undefined);
  } finally {
    fake.restore();
  }
});

test('providers: the mid-stream error shape is a provider failure, never a finished reply at its reserve; its own reported cost is used, and an in-reply timeout gets one more try only', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const look = await clip('midstream.mp4');
  const lookups = [];
  let chats = 0;
  const fake = fakeAxios(({ url, config }) => {
    if (url.includes('/generation')) {
      lookups.push(new URL(url).searchParams.get('id'));
      return httpError(config, 404, { error: { message: 'Generation not found' } });
    }
    return ++chats === 1
      ? {
          headers: { 'x-generation-id': 'gen-mid' },
          data: { choices: [{ message: { content: 'partial output...' }, finish_reason: 'error', error: { code: 504, message: 'Provider timed out' } }] },
        }
      : {
          headers: { 'x-generation-id': 'gen-mid-2' },
          data: {
            error: { code: 504, message: 'Provider timed out again', metadata: { error_type: 'timeout' } },
            choices: [{ message: { content: '' }, finish_reason: 'error' }],
            usage: { cost: 0.004 },
          },
        };
  });
  const { entries, meter } = ledger();
  try {
    const failure = await limited({ lookupAtMs: [10, 30], lookupMs: 200 }, () =>
      analyze(look, signal, meter).catch((error) => error),
    );
    assert.equal(chats, 2, 'a timeout the provider reported inside its reply is tried once more, not four times');
    assert.equal(failure.message, 'Provider timed out again');
    assert.equal(failureClass(failure), 'transient');
    assert.equal(entries.length, 2);
    assert.ok(entries.every((entry) => entry.error), 'neither was read as a finished reply');
    const [first, second] = entries;
    assert.equal(first.generation, 'gen-mid');
    assert.equal(first.costUSD, undefined);
    assert.ok(Math.abs(first.expectedUSD - expectedOf(first.reserve)) < 1e-9, `expected, not the reserve: ${first.expectedUSD} of ${first.reserve}`);
    assert.equal(second.costUSD, 0.004, 'the cost the reply itself reported');
    assert.equal(second.costFrom, undefined);
    assert.deepEqual(lookups, ['gen-mid', 'gen-mid'], 'a reply that reported its cost is not looked up');
  } finally {
    fake.restore();
  }
});

test('providers: a finished reply that reports no cost is priced from OpenRouter’s record, or booked as uncertain at its expected cost, never at its reserve', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const look = await clip('costless.mp4');
  const lookups = [];
  let recorded = true;
  const fake = fakeAxios(({ url, config }) => {
    if (url.includes('/generation')) {
      lookups.push(new URL(url).searchParams.get('id'));
      return recorded ? recordOf(config, 0.017) : httpError(config, 404, { error: { message: 'Generation not found' } });
    }
    return { headers: { 'x-generation-id': 'gen-costless' }, data: { ...good, usage: undefined } };
  });
  try {
    let { entries, meter } = ledger();
    let result = await limited({ lookupAtMs: [10], lookupMs: 200 }, () => analyze(look, signal, meter));
    assert.equal(result.cues.length, 1);
    assert.deepEqual(entries.map((entry) => [entry.costUSD, entry.uncertain]), [[0.017, undefined]]);
    assert.deepEqual(result.vision.map((call) => call.costUSD), [0.017]);
    assert.deepEqual(lookups, ['gen-costless']);

    recorded = false;
    ({ entries, meter } = ledger());
    result = await limited({ lookupAtMs: [10, 30], lookupMs: 200 }, () => analyze(look, signal, meter));
    assert.equal(result.cues.length, 1, 'the reply is still used');
    const [entry] = entries;
    assert.equal(entry.uncertain, true);
    assert.ok(Math.abs(entry.costUSD - expectedOf(entry.reserve)) < 1e-9, `${entry.costUSD} of ${entry.reserve}`);
  } finally {
    fake.restore();
  }
});

test('providers: an in-reply error’s typed code decides over its number: a reply out of room is retried shorter once, a content filter’s decline is a refusal, and both are looked up', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const look = await clip('typed.mp4');
  const lookups = [];
  let chats = 0;
  let fake = fakeAxios(({ url, config }) => {
    if (url.includes('/generation')) {
      lookups.push(new URL(url).searchParams.get('id'));
      return recordOf(config, 0.011);
    }
    return ++chats === 1
      ? { headers: { 'x-generation-id': 'gen-long' }, data: { error: { code: 400, message: 'max tokens reached', metadata: { error_type: 'max_tokens_exceeded' } } } }
      : { data: good };
  });
  let { entries, meter } = ledger();
  try {
    const result = await limited({ lookupAtMs: [10], lookupMs: 200 }, () => analyze(look, signal, meter));
    assert.equal(result.cues.length, 1);
    assert.equal(chats, 2, 'retried once, as a reply cut off at its length is');
    assert.equal(entries[0].error.constructor.name, 'CutOff');
    assert.match(entries[0].error.message, /max tokens reached/, 'the provider’s words stay in the log');
    assert.equal(entries[0].costUSD, 0.011);
    assert.equal(entries[0].costFrom, 'generation');
    assert.deepEqual(lookups, ['gen-long']);
    const retry = fake.calls.filter((call) => call.url.includes('chat'))[1].body;
    assert.match(retry.messages[0].content[1].text, /Give about half as many cues/);
  } finally {
    fake.restore();
  }

  chats = 0;
  lookups.length = 0;
  fake = fakeAxios(({ url, config }) => {
    if (url.includes('/generation')) {
      lookups.push(new URL(url).searchParams.get('id'));
      return recordOf(config, 0.006);
    }
    chats++;
    return {
      headers: { 'x-generation-id': 'gen-flagged' },
      data: { error: { code: 403, message: 'Output flagged by SAFETY', metadata: { error_type: 'content_policy_violation' } } },
    };
  });
  ({ entries, meter } = ledger());
  try {
    const failure = await limited({ lookupAtMs: [10], lookupMs: 200 }, () =>
      analyze(look, signal, meter).catch((error) => error),
    );
    assert.equal(chats, 1, 'the same clip would be declined again');
    assert.equal(failureClass(failure), 'refused');
    assert.equal(providerProblem(failure, 'The video model'), 'The video model declined to describe this scene.');
    assert.equal(entries[0].costUSD, 0.006);
    assert.deepEqual(lookups, ['gen-flagged']);
  } finally {
    fake.restore();
  }
});

test('providers: our stop while a failed request’s cost is looked up ends the wait, and the failure is still priced as its own, not our stop’s', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const look = await clip('stopped-lookup.mp4');
  const controller = new AbortController();
  let lookups = 0;
  const fake = fakeAxios(({ url, config }) => {
    if (url.includes('/generation')) {
      lookups++;
      return recordOf(config, 0.02);
    }
    return { headers: { 'x-generation-id': 'gen-before-stop' }, data: endless() };
  });
  const { entries, meter } = ledger();
  const log = [];
  try {
    const began = Date.now();
    const failure = await limited({ requestMs: 200, lookupAtMs: [400, 800], lookupMs: 5000 }, () => {
      setTimeout(() => controller.abort(new Error('shutdown')), 300);
      return analyze({ ...look, log: (line) => log.push(line) }, controller.signal, meter).catch((error) => error);
    });
    assert.ok(Date.now() - began < 1500, 'the stop ended the wait for the record');
    assert.equal(failure.code, 'ETIMEDOUT');
    assert.equal(lookups, 0);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].interrupted, false, 'it failed before the stop');
    assert.ok(Math.abs(entries[0].expectedUSD - expectedOf(entries[0].reserve)) < 1e-9);
    assert.ok(log.some((line) => line.startsWith('vision: the job stopped before OpenRouter recorded what the failed request gen-before-stop cost')), log.join('\n'));
  } finally {
    fake.restore();
  }
});

test('providers: over real HTTP, our stop or the deadline ends a refused request whose error body stalls', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const look = await clip('stalled-refusal.mp4');
  let status = 503;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.write(' ');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${server.address().port}`;
  const previous = axios.defaults.adapter;
  const http = axios.getAdapter('http');
  axios.defaults.adapter = (config) => http({ ...config, url: config.url.replace('https://openrouter.ai', local) });
  const controller = new AbortController();
  const { entries, meter } = ledger();
  try {
    const began = Date.now();
    setTimeout(() => controller.abort(new Error('shutdown')), 300);
    const failure = await Promise.race([
      analyze(look, controller.signal, meter).catch((error) => error),
      later(3000).then(() => 'still reading'),
    ]);
    assert.notEqual(failure, 'still reading', 'our stop ended it, not the connection dying minutes later');
    assert.ok(Date.now() - began < 2000, `${Date.now() - began} ms`);
    assert.equal(failure.response?.status, 503);
    assert.equal(entries[0].interrupted, true);

    /* No stop this time: a refusal (not retried) whose body stalls ends at the request's deadline. */
    status = 400;
    const deadlined = Date.now();
    const refused = await limited({ requestMs: 300 }, () =>
      Promise.race([
        analyze(look, signal, meter).catch((error) => error),
        later(3000).then(() => 'still reading'),
      ]),
    );
    assert.notEqual(refused, 'still reading', 'the deadline ended it');
    assert.ok(Date.now() - deadlined < 2000, `${Date.now() - deadlined} ms`);
    assert.equal(refused.response?.status, 400);
    assert.equal(failureClass(refused), 'input');
    assert.equal(entries[1].interrupted, false);
  } finally {
    axios.defaults.adapter = previous;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
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
    assert.equal(entries[0].interrupted, true);
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

test('providers: the real cost adds what the provider billed on her own key only when OpenRouter says BYOK', () => {
  /* Not BYOK, as measured on Sep 26: upstream_inference_cost repeats cost and is never added. */
  assert.equal(realCost(0.0000027, false, 0.0000027), 0.0000027);
  assert.equal(realCost(0.036408, undefined, 0.036408), 0.036408);
  /* BYOK: cost is only OpenRouter's fee; Google's charge comes on top. */
  assert.ok(Math.abs(realCost(0.0018, true, 0.0364) - 0.0382) < 1e-12);
  assert.equal(realCost(0.0018, true, 0), 0.0018, 'a stated charge of nothing is a price');
  /* Missing or unusable fields. */
  assert.equal(realCost(0.02), 0.02);
  assert.equal(realCost(0.02, null, null), 0.02);
  /* BYOK without the provider's charge is no price: the fee alone (possibly waived to 0) is not booked. */
  assert.equal(realCost(0.0018, true), undefined);
  assert.equal(realCost(0.0018, true, null), undefined);
  assert.equal(realCost(0, true, null), undefined);
  assert.equal(realCost(0.0018, true, Number.NaN), undefined);
  assert.equal(realCost(0.0018, true, -1), undefined);
});

test('providers: a BYOK reply, in-reply error or record without the provider’s charge is never booked at the fee alone; it is looked up, then booked at its expected cost', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const look = await clip('byok-bare.mp4');
  /* OpenRouter waived its BYOK fee and sent no upstream figure: the reply alone would say $0. */
  const bare = { ...good.usage, cost: 0, is_byok: true, cost_details: null };
  let record = 'priced';
  let mode = 'reply';
  const lookups = [];
  const logs = [];
  const fake = fakeAxios(({ url, config }) => {
    if (url.includes('/generation')) {
      lookups.push(new URL(url).searchParams.get('id'));
      if (record === 'priced')
        return { data: { data: { total_cost: 0.0009, is_byok: true, upstream_inference_cost: 0.05, provider_name: 'Google AI Studio' } } };
      if (record === 'bare')
        return { data: { data: { total_cost: 0, is_byok: true, upstream_inference_cost: null, provider_name: 'Google AI Studio' } } };
      return httpError(config, 404, { error: { message: 'Generation not found' } });
    }
    if (mode === 'reply') return { headers: { 'x-generation-id': 'gen-bare' }, data: { ...good, usage: bare } };
    return {
      headers: { 'x-generation-id': 'gen-bare-err' },
      data: { error: { code: 400, message: 'Invalid video' }, usage: { cost: 0, is_byok: true, cost_details: { upstream_inference_cost: null } } },
    };
  });
  try {
    let { entries, meter } = ledger();
    const withLog = { ...look, log: (line) => logs.push(line) };
    let result = await limited({ lookupAtMs: [10], lookupMs: 200 }, () => analyze(withLog, signal, meter));
    assert.deepEqual(lookups, ['gen-bare'], 'the reply is looked up');
    assert.ok(Math.abs(entries[0].costUSD - 0.0509) < 1e-12, `the record's fee plus Google's charge: ${entries[0].costUSD}`);
    assert.equal(entries[0].uncertain, undefined);
    assert.ok(Math.abs(result.vision[0].costUSD - 0.0509) < 1e-12);
    assert.ok(logs.some((line) => line.includes("gave OpenRouter's fee ($0.0000) but not the provider's charge")), logs.join('\n'));

    /* A BYOK record without the charge is asked for again, then the expected cost is booked as uncertain. */
    record = 'bare';
    lookups.length = 0;
    ({ entries, meter } = ledger());
    result = await limited({ lookupAtMs: [10, 20], lookupMs: 200 }, () => analyze(look, signal, meter));
    assert.deepEqual(lookups, ['gen-bare', 'gen-bare'], 'the unpriced record is asked for again');
    assert.equal(entries[0].uncertain, true);
    assert.ok(entries[0].costUSD > 0.001, `never the fee alone: ${entries[0].costUSD}`);
    assert.ok(Math.abs(entries[0].costUSD - expectedOf(entries[0].reserve)) < 1e-9, `${entries[0].costUSD} of ${entries[0].reserve}`);

    /* The same for an error sent inside a 200 reply. */
    mode = 'error';
    lookups.length = 0;
    ({ entries, meter } = ledger());
    await limited({ lookupAtMs: [10, 20], lookupMs: 200 }, () => analyze(look, signal, meter).catch(() => {}));
    assert.equal(entries.length, 1, 'an error code that blames the request is not retried');
    assert.deepEqual(lookups, ['gen-bare-err', 'gen-bare-err']);
    assert.equal(entries[0].costUSD, undefined, 'the fee alone is not taken as its cost');
    assert.equal(entries[0].costFrom, undefined, 'nor is the unpriced record');
    assert.ok(Math.abs(entries[0].expectedUSD - expectedOf(entries[0].reserve)) < 1e-9, `${entries[0].expectedUSD}`);

    record = 'priced';
    lookups.length = 0;
    ({ entries, meter } = ledger());
    await limited({ lookupAtMs: [10], lookupMs: 200 }, () => analyze(look, signal, meter).catch(() => {}));
    assert.ok(Math.abs(entries[0].costUSD - 0.0509) < 1e-12, `${entries[0].costUSD}`);
    assert.equal(entries[0].costFrom, 'generation');
  } finally {
    fake.restore();
  }
});

test('providers: BYOK replies, in-reply errors and generation records are booked at the fee plus the provider’s charge, others at their cost alone', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const look = await clip('byok.mp4');
  /* The usage shape two live calls returned on Sep 26 (not BYOK), and the same with BYOK. */
  const plain = { ...good.usage, cost: 0.036408, is_byok: false, cost_details: { upstream_inference_cost: 0.036408, upstream_inference_prompt_cost: 0.0255, upstream_inference_completions_cost: 0.010908 } };
  const byok = { ...good.usage, cost: 0.00182, is_byok: true, cost_details: { upstream_inference_cost: 0.036408 } };
  let mode = 'plain';
  const fake = fakeAxios(({ url, config }) => {
    if (url.includes('/generation'))
      return { data: { data: { total_cost: 0.0009, is_byok: true, upstream_inference_cost: 0.018, provider_name: 'Google AI Studio' } } };
    if (mode === 'plain') return { headers: { 'x-generation-id': 'gen-plain' }, data: { ...good, usage: plain } };
    if (mode === 'byok') return { headers: { 'x-generation-id': 'gen-byok' }, data: { ...good, usage: byok } };
    if (mode === 'byok-error')
      return { headers: { 'x-generation-id': 'gen-byok-err' }, data: { error: { code: 400, message: 'Invalid video' }, usage: { cost: 0.0001, is_byok: true, cost_details: { upstream_inference_cost: 0.002 } } } };
    return { headers: { 'x-generation-id': 'gen-byok-rec' }, data: { error: { code: 400, message: 'Invalid video' } } };
  });
  const { entries, meter } = ledger();
  try {
    const first = await analyze(look, signal, meter);
    assert.deepEqual(first.vision.map((call) => call.costUSD), [0.036408], 'not doubled');
    mode = 'byok';
    const second = await analyze(look, signal, meter);
    assert.ok(Math.abs(second.vision[0].costUSD - 0.038228) < 1e-12, `${second.vision[0].costUSD}`);
    mode = 'byok-error';
    await analyze(look, signal, meter).catch(() => {});
    mode = 'byok-record';
    await limited({ lookupAtMs: [10], lookupMs: 200 }, () => analyze(look, signal, meter).catch(() => {}));
    assert.equal(entries.length, 4);
    assert.equal(entries[0].costUSD, 0.036408);
    assert.ok(Math.abs(entries[1].costUSD - 0.038228) < 1e-12);
    assert.ok(Math.abs(entries[2].costUSD - 0.0021) < 1e-12, `the cost the error reply reported: ${entries[2].costUSD}`);
    assert.ok(Math.abs(entries[3].costUSD - 0.0189) < 1e-12, `the record: ${entries[3].costUSD}`);
    assert.equal(entries[3].costFrom, 'generation');
  } finally {
    fake.restore();
  }
});

test('providers: each look thinks as the Sep 26 A/B measured, and its reserve follows its output tokens', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const fake = fakeAxios(() => ({ headers: { 'x-generation-id': 'gen-plan' }, data: good }));
  const { entries, meter } = ledger();
  try {
    const base = await clip('plan.mp4');
    const close = { ...base, seconds: 40, brief: { ...brief, slowed: true } };
    for (const look of [
      { ...base, brief: { ...brief, survey: true } },
      base,
      close,
      { ...close, second: true },
      { ...base, second: true },
    ])
      await analyze(look, signal, meter);
    assert.deepEqual(
      fake.calls.map(({ body }) => [body.reasoning, body.max_tokens]),
      [
        [{ effort: 'low' }, 12000],
        [{ effort: 'medium' }, 12000],
        [{ max_tokens: 8000 }, 24000],
        [{ effort: 'high' }, 48000],
        [{ effort: 'high' }, 48000],
      ],
      'a survey at low effort, a normal look at medium, a close look within 8,000 reasoning tokens, a second look at high effort with room for 48,000',
    );
    assert.ok(
      Math.abs(entries[3].reserve - entries[2].reserve - 24000 * 7.5e-6) < 1e-9,
      `the second close look reserves 24,000 more output tokens at the ceiling for the same clip and prompt: ${entries[2].reserve} and ${entries[3].reserve}`,
    );
    assert.ok(Math.abs(entries[4].reserve - entries[1].reserve - 36000 * 7.5e-6) < 1e-9, `${entries[1].reserve} and ${entries[4].reserve}`);
  } finally {
    fake.restore();
  }
});

/** A reply kept alive with a space and finished after `ms`. */
function finishedAfter(data, ms) {
  let timer;
  return new Readable({
    read() {
      if (timer) return;
      this.push(' ');
      timer = setTimeout(() => {
        this.push(JSON.stringify(data));
        this.push(null);
      }, ms);
    },
    destroy(error, callback) {
      clearTimeout(timer);
      callback(error);
    },
  });
}

test('providers: a second look has longer than a first look to finish its reply before it counts as a timeout', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const look = await clip('deadline.mp4');
  const fake = fakeAxios(({ url, config }) =>
    url.includes('/generation')
      ? recordOf(config, 0.01)
      : { headers: { 'x-generation-id': 'gen-late' }, data: finishedAfter(good, 400) },
  );
  const { entries, meter } = ledger();
  try {
    await limited({ requestMs: 150, secondRequestMs: 3000, lookupAtMs: [10], lookupMs: 200 }, async () => {
      const second = await analyze({ ...look, second: true }, signal, meter);
      assert.equal(second.cues.length, 1, 'a reply that took 400 ms fits the second look’s limit');
      const first = await analyze(look, signal, meter).catch((error) => error);
      assert.equal(failureClass(first), 'transient');
    });
    assert.deepEqual(
      entries.map((entry) => entry.error?.code ?? 'ok'),
      ['ok', 'ETIMEDOUT', 'ETIMEDOUT'],
      'the same reply is past a first look’s limit, and a timeout gets one more try only',
    );
  } finally {
    fake.restore();
  }
});

test('providers: a close look OpenRouter never priced is booked near what close looks cost, about $0.06 for Road Runner’s 74.5 s section, not near its reserve', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const base = await clip('roadrunner.mp4');
  /* Road Runner's section 2 ran from 88.96 to 163.44 s; its close-look clip lasts four times that. */
  const seconds = 4 * (163.44 - 88.96);
  const look = { ...base, seconds, brief: { ...brief, slowed: true } };
  const fake = fakeAxios(({ url, config }) =>
    url.includes('/generation')
      ? httpError(config, 404, { error: { message: 'Generation not found' } })
      : { headers: { 'x-generation-id': 'gen-rr' }, data: { error: { code: 400, message: 'Invalid video' } } },
  );
  const { entries, meter } = ledger();
  try {
    await limited({ lookupAtMs: [10], lookupMs: 100 }, async () => {
      await analyze(look, signal, meter).catch(() => {});
      await analyze({ ...look, second: true }, signal, meter).catch(() => {});
    });
    assert.equal(entries.length, 2, 'an error code that blames the request is not retried');
    const [first, second] = entries;
    assert.equal(first.costUSD, undefined);
    assert.ok(first.reserve > 0.3, `the reserve it is no longer booked at: ${first.reserve}`);
    assert.ok(first.expectedUSD >= 0.04 && first.expectedUSD <= 0.07, `looks like it really cost $0.048 to $0.051: ${first.expectedUSD}`);
    assert.ok(Math.abs(first.expectedUSD - expectedOf(first.reserve, { seconds, maxTokens: 24000, reasoning: 8000 })) < 1e-9, `${first.expectedUSD}`);
    assert.ok(second.reserve > 0.5, `a second look’s reserve: ${second.reserve}`);
    assert.ok(
      Math.abs(second.expectedUSD - expectedOf(second.reserve, { seconds, maxTokens: 48000, reasoning: 16000 })) < 1e-9,
      `a second look is expected to reason about 16,000 tokens at high effort: ${second.expectedUSD}`,
    );
    assert.ok(second.expectedUSD > first.expectedUSD && second.expectedUSD < second.reserve / 5, `${second.expectedUSD} of ${second.reserve}`);
    /* What the engine's re-look gate asks room for, before the second look is sent. */
    assert.ok(Math.abs(expectedLook(look) - first.expectedUSD) < 1e-12, `${expectedLook(look)}`);
    const ahead = expectedLook({ ...look, second: true });
    assert.ok(Math.abs(ahead - second.expectedUSD) < 1e-12, `${ahead}`);
    assert.ok(ahead >= 0.08 && ahead <= 0.11, `about $0.094, where such looks cost $0.086 to $0.103: ${ahead}`);
    assert.ok(ahead > 3 * 0.019, 'more than three times the $0.019 thin look that would call for it');
  } finally {
    fake.restore();
  }
});

test('providers: a cut-off reply its reasoning filled is asked again with the reasoning capped, not for fewer cues; one its answer filled is asked for fewer cues', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const cut = (reasoning, output) => ({
    choices: [{ finish_reason: 'length', native_finish_reason: 'MAX_TOKENS', message: { content: '{"cues":[' } }],
    usage: { cost: output * 3.75e-6, completion_tokens: output, completion_tokens_details: { reasoning_tokens: reasoning } },
  });
  const high = { effort: 'high' };
  const budget = { max_tokens: 8000 };
  const cases = [
    { name: 'a second look whose high-effort reasoning filled its 48,000 tokens', second: true, slowed: true, replies: [cut(46500, 48000)], reasoning: [high, { max_tokens: 16000 }], shorter: false },
    { name: 'a normal look whose medium reasoning filled its 12,000 tokens', replies: [cut(11200, 12000)], reasoning: [{ effort: 'medium' }, { max_tokens: 4000 }], shorter: false },
    { name: 'the same cut-off, reported as an error inside the reply', second: true, slowed: true, replies: [{ error: { code: 400, message: 'max tokens reached', metadata: { error_type: 'max_tokens_exceeded' } }, usage: cut(47000, 48000).usage }], reasoning: [high, { max_tokens: 16000 }], shorter: false },
    { name: 'a second look whose answer filled its room', second: true, slowed: true, replies: [cut(14000, 48000)], reasoning: [high, high], shorter: true },
    { name: 'a close look, whose 8,000-token budget already leaves room', slowed: true, replies: [cut(7900, 24000)], reasoning: [budget, budget], shorter: true },
    { name: 'a close look that reasoned past its budget, which a cap at 8,000 would not lower', slowed: true, replies: [cut(20000, 24000)], reasoning: [budget, budget], shorter: true },
    { name: 'a second look cut off again after its reasoning was capped', second: true, slowed: true, replies: [cut(46500, 48000), cut(16000, 48000)], reasoning: [high, { max_tokens: 16000 }], shorter: false, fails: true },
  ];
  const video = (i) => `data:video/mp4;base64,${Buffer.from(`clip-${i}`).toString('base64')}`;
  const asked = cases.map(() => []);
  const fake = fakeAxios(({ url, config, body }) => {
    if (url.includes('/generation')) return recordOf(config, 0.01);
    const i = cases.findIndex((_item, k) => body.messages[0].content[0].video_url.url === video(k));
    asked[i].push(body);
    const reply = cases[i].replies[asked[i].length - 1] ?? good;
    return { headers: { 'x-generation-id': `gen-cut-${i}-${asked[i].length}` }, data: reply };
  });
  try {
    await Promise.all(
      cases.map(async (item, i) => {
        const file = join(scratch, `cutoff-${i}.mp4`);
        await writeFile(file, Buffer.from(`clip-${i}`));
        const log = [];
        const look = {
          file,
          seconds: item.slowed ? 40 : 10,
          brief: { ...brief, slowed: item.slowed },
          state: null,
          lines: [],
          before: [],
          second: item.second,
          log: (line) => log.push(line),
        };
        const outcome = await analyze(look, signal, meter).catch((error) => error);
        const bodies = asked[i];
        if (item.fails) {
          assert.equal(outcome.constructor.name, 'CutOff', item.name);
          assert.equal(failureClass(outcome), 'input', `${item.name}: the engine keeps the first look`);
        } else assert.equal(outcome.cues.length, 1, item.name);
        assert.equal(bodies.length, 2, `${item.name}: one more try only`);
        assert.deepEqual(bodies.map((body) => body.reasoning), item.reasoning, item.name);
        assert.equal(bodies[1].max_tokens, bodies[0].max_tokens, `${item.name}: the same room`);
        assert.equal(/half as many cues/.test(bodies[1].messages[0].content[1].text), item.shorter, item.name);
        assert.equal(log.some((line) => line.includes('reasoning capped at')), !item.shorter, `${item.name}: ${log.join('\n')}`);
      }),
    );
  } finally {
    fake.restore();
  }
});

/* ------------------------------------------------------------------------------------------
 * Tiers (Sep 26): the same model on Google Vertex's flex tier (the default) or its standard tier,
 * never through Google AI Studio, where Kade's own key bills twice the price.
 * ---------------------------------------------------------------------------------------- */

const flexRoute = {
  only: ['google-vertex/global/flex'],
  ignore: ['google-ai-studio'],
  allow_fallbacks: false,
  max_price: { prompt: 1.5, completion: 7.5 },
};
const standardRoute = { ignore: ['google-ai-studio'], max_price: { prompt: 1.5, completion: 7.5 } };
/** Runs with KADE_DESCRIPTION_TIER set (undefined: unset, the server's default), then puts it back. */
async function onTier(tier, run) {
  const saved = process.env.KADE_DESCRIPTION_TIER;
  if (tier === undefined) delete process.env.KADE_DESCRIPTION_TIER;
  else process.env.KADE_DESCRIPTION_TIER = tier;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.KADE_DESCRIPTION_TIER;
    else process.env.KADE_DESCRIPTION_TIER = saved;
  }
}
/** A reply as OpenRouter reports the tier that served it: flex when the request was pinned there. */
const servedBy = (body) => ({
  ...good,
  model: 'google/gemini-3.8-flash-20260902',
  provider: 'Google',
  service_tier: body.provider?.only ? 'flex' : 'default',
});
/** No request may reach Google AI Studio: every route leaves it out, and none names it. */
function neverAiStudio(bodies, what) {
  for (const body of bodies) {
    assert.deepEqual(body.provider.ignore, ['google-ai-studio'], what);
    assert.equal(body.provider.order, undefined, what);
    assert.ok((body.provider.only ?? []).every((slug) => slug === 'google-vertex/global/flex'), what);
    assert.equal(body.model.endsWith(':floor'), false, what);
  }
}

test('providers: on the flex tier, the default, every look is pinned to Vertex flex with no fallback inside OpenRouter, thinks and answers as on standard, and never reaches AI Studio', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const fake = fakeAxios(({ body }) => ({ headers: { 'x-generation-id': 'gen-tier' }, data: servedBy(body) }));
  const log = [];
  try {
    const base = { ...(await clip('tier.mp4')), log: (line) => log.push(line) };
    const close = { ...base, seconds: 40, brief: { ...brief, slowed: true } };
    const looks = [{ ...base, brief: { ...brief, survey: true } }, base, close, { ...close, second: true }];
    const askAll = async () => {
      const results = [];
      for (const look of looks) results.push(await analyze(look, signal, meter));
      return results;
    };
    const flex = await onTier(undefined, askAll);
    const flexBodies = fake.calls.splice(0).map((call) => call.body);
    const standard = await onTier('standard', askAll);
    const standardBodies = fake.calls.splice(0).map((call) => call.body);
    for (const body of flexBodies) assert.deepEqual(body.provider, flexRoute);
    for (const body of standardBodies) assert.deepEqual(body.provider, standardRoute);
    neverAiStudio([...flexBodies, ...standardBodies], 'every look');
    const withoutRoute = ({ provider: _route, ...rest }) => rest;
    assert.deepEqual(flexBodies.map(withoutRoute), standardBodies.map(withoutRoute), 'the same request on either tier apart from its route');
    assert.deepEqual(
      flexBodies.map((body) => [body.model, body.reasoning, body.max_tokens, body.response_format.type]),
      [
        ['google/gemini-3.8-flash', { effort: 'low' }, 12000, 'json_schema'],
        ['google/gemini-3.8-flash', { effort: 'medium' }, 12000, 'json_schema'],
        ['google/gemini-3.8-flash', { max_tokens: 8000 }, 24000, 'json_schema'],
        ['google/gemini-3.8-flash', { effort: 'high' }, 48000, 'json_schema'],
      ],
      'a survey, a normal look, a close look and a second look each keep their own reasoning and room',
    );
    assert.deepEqual(
      flex.map((result) => result.vision.map((call) => [call.requested, call.tier, call.provider])),
      looks.map(() => [['flex', 'flex', 'Google']]),
      'each call records the tier it asked, the tier that served it and the backend',
    );
    assert.deepEqual(standard.map((result) => result.vision[0].requested), ['standard', 'standard', 'standard', 'standard']);
    assert.match(log[0], /^vision: asked flex \(google-vertex\/global\/flex\), served tier flex, provider Google, finish stop, output 4000 tokens \(3500 reasoning\), \$0\.0310$/);
    assert.match(log[4], /^vision: asked standard, served tier default, provider Google, finish stop/);

    /* A look's own tier (the administrator's choice, or a thin look's re-look) wins over the server's. */
    await onTier('standard', () => analyze({ ...base, tier: 'flex' }, signal, meter));
    await onTier('flex', () => analyze({ ...base, tier: 'standard' }, signal, meter));
    /* A value the server does not know is the default, flex. */
    await onTier('priority', () => analyze(base, signal, meter));
    /* A routing suffix on the model is dropped: :floor would sort her own AI Studio key in by price. */
    process.env.KADE_DESCRIPTION_MODEL = 'google/gemini-3.8-flash:floor';
    await onTier('standard', () => analyze(base, signal, meter));
    /* Only Google's models have a flex tier. */
    process.env.KADE_DESCRIPTION_MODEL = 'qwen/qwen3-vl-flash';
    await onTier('flex', () => analyze(base, signal, meter));
    delete process.env.KADE_DESCRIPTION_MODEL;
    const bodies = fake.calls.map((call) => call.body);
    assert.deepEqual(bodies.map((body) => body.provider), [flexRoute, standardRoute, flexRoute, standardRoute, standardRoute]);
    assert.deepEqual(bodies.map((body) => body.model), [
      'google/gemini-3.8-flash',
      'google/gemini-3.8-flash',
      'google/gemini-3.8-flash',
      'google/gemini-3.8-flash',
      'qwen/qwen3-vl-flash',
    ]);
    neverAiStudio(bodies, 'every choice');
  } finally {
    delete process.env.KADE_DESCRIPTION_MODEL;
    fake.restore();
  }
});

test('providers: a flex try that fails is asked again at once on the standard tier, never AI Studio: rate limited, busy, a server error in the reply, no flex endpoint, a timeout, an unusable reply', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const look = await clip('fallback.mp4');
  const failures = {
    'rate limited, asking to wait 30 s': (config) => {
      const error = httpError(config, 429, { error: { message: 'Resource exhausted' } });
      error.response.headers = { 'retry-after': '30' };
      return error;
    },
    busy: (config) => httpError(config, 503, { error: { message: 'No instances available' } }),
    'a server error inside the reply': () => ({ data: { error: { code: 502, message: 'Upstream error from Google' } } }),
    'no flex endpoint': (config) =>
      httpError(config, 404, { error: { message: 'No endpoints found matching your data policy (Only: google-vertex/global/flex)' } }),
    'a timeout': () => ({ headers: { 'x-generation-id': 'gen-flex-slow' }, data: endless() }),
    'an unusable reply': () => ({ data: { ...good, choices: [{ finish_reason: 'stop', message: { content: 'not a script' } }] } }),
  };
  for (const [name, fail] of Object.entries(failures)) {
    const log = [];
    const fake = fakeAxios(({ url, config, body }) => {
      if (url.includes('/generation')) return recordOf(config, 0.004);
      return body.provider.only ? fail(config) : { headers: { 'x-generation-id': 'gen-standard' }, data: servedBy(body) };
    });
    try {
      const began = Date.now();
      const result = await onTier('flex', () =>
        limited({ requestMs: 300, lookupAtMs: [10], lookupMs: 100, fallbackMs: 20 }, () =>
          analyze({ ...look, log: (line) => log.push(line) }, signal, meter),
        ),
      );
      const bodies = fake.calls.filter((call) => call.body).map((call) => call.body);
      assert.deepEqual(bodies.map((body) => body.provider), [flexRoute, standardRoute], name);
      neverAiStudio(bodies, name);
      assert.equal(result.cues.length, 1, name);
      assert.equal(result.vision.at(-1).requested, 'standard', name);
      assert.equal(result.vision.at(-1).tier, 'default', name);
      assert.ok(
        log.some((line) => /^vision: the flex try failed \(.+\); asking again on the standard tier$/.test(line)),
        `${name}: ${log.join('\n')}`,
      );
      assert.ok(Date.now() - began < 4000, `${name}: standard is another queue, so a Retry-After from flex is not waited out (${Date.now() - began} ms)`);
    } finally {
      fake.restore();
    }
  }
});

test('providers: after the fallback every try stays on standard; a timeout on each tier ends the look; a bad request, an account problem or a refusal on flex is not asked again', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const look = await clip('fallback-more.mp4');
  /* Busy on flex, busy once more on standard, then an answer: never back to flex. */
  let chats = 0;
  let fake = fakeAxios(({ config, body }) =>
    ++chats <= 2 ? httpError(config, 503, { error: { message: 'busy' } }) : { data: servedBy(body) },
  );
  try {
    const result = await onTier('flex', () => limited({ fallbackMs: 10 }, () => analyze(look, signal, meter)));
    assert.equal(result.cues.length, 1);
    assert.deepEqual(fake.calls.map((call) => call.body.provider), [flexRoute, standardRoute, standardRoute]);
  } finally {
    fake.restore();
  }
  /* A timeout on flex, then on standard: the one-retry-after-timeout rule counts both. */
  chats = 0;
  fake = fakeAxios(({ url, config }) =>
    url.includes('/generation') ? recordOf(config, 0.002) : { headers: { 'x-generation-id': `gen-late-${++chats}` }, data: endless() },
  );
  try {
    const failure = await onTier('flex', () =>
      limited({ requestMs: 150, lookupAtMs: [10], lookupMs: 100, fallbackMs: 10 }, () => analyze(look, signal, meter).catch((error) => error)),
    );
    assert.equal(chats, 2, 'one more try after a timeout, in all');
    assert.equal(failureClass(failure), 'transient');
    assert.deepEqual(fake.calls.filter((call) => call.body).map((call) => call.body.provider), [flexRoute, standardRoute]);
  } finally {
    fake.restore();
  }
  /* Failures standard would repeat, or that stop the job, are not asked again on standard. */
  for (const [name, reply] of [
    ['a bad request', (config) => httpError(config, 400, { error: { message: 'Invalid video' } })],
    ['an empty balance', (config) => httpError(config, 402, { error: { message: 'Insufficient credits' } })],
    ['a refused key', (config) => httpError(config, 401, { error: { message: 'No auth credentials found' } })],
    ['a refusal', () => ({ data: { ...good, choices: [{ finish_reason: 'content_filter', native_finish_reason: 'SAFETY', message: { content: '' } }] } })],
  ]) {
    fake = fakeAxios(({ config }) => reply(config));
    try {
      await onTier('flex', () => analyze(look, signal, meter).catch(() => {}));
      assert.equal(fake.calls.length, 1, name);
      assert.deepEqual(fake.calls[0].body.provider, flexRoute, name);
    } finally {
      fake.restore();
    }
  }
});

test('providers: a failed or unpriced try is booked at the list price of the tier it asked, flex at half of standard, while the reserve stays at the standard worst case', async () => {
  process.env.OPENROUTER_KEY = 'test-key';
  const base = await clip('tier-price.mp4');
  const look = { ...base, seconds: 40, brief: { ...brief, slowed: true } };
  const close = { seconds: 40, maxTokens: 24000, reasoning: 8000 };
  let chats = 0;
  let fake = fakeAxios(({ url, config }) =>
    url.includes('/generation')
      ? httpError(config, 404, { error: { message: 'Generation not found' } })
      : { headers: { 'x-generation-id': `gen-price-${++chats}` }, data: endless() },
  );
  let { entries, meter } = ledger();
  try {
    await onTier('flex', () =>
      limited({ requestMs: 150, lookupAtMs: [10], lookupMs: 60, fallbackMs: 10 }, () => analyze(look, signal, meter).catch(() => {})),
    );
    assert.equal(chats, 2);
    const [flex, standard] = entries;
    assert.equal(flex.reserve, standard.reserve, 'the reserve is the standard worst case on either tier');
    assert.ok(Math.abs(flex.expectedUSD - expectedOf(flex.reserve, { ...close, price: flexPrice })) < 1e-9, `flex at $0.375 and $1.875: ${flex.expectedUSD}`);
    assert.ok(Math.abs(standard.expectedUSD - expectedOf(standard.reserve, close)) < 1e-9, `standard at $0.75 and $3.75: ${standard.expectedUSD}`);
    assert.ok(Math.abs(flex.expectedUSD - standard.expectedUSD / 2) < 1e-12, 'flex is half the price per token');
    /* What the engine's re-look gate is told a look will cost, before it is asked. */
    await onTier('flex', () => assert.ok(Math.abs(expectedLook(look) - flex.expectedUSD) < 1e-12, 'the server’s flex'));
    await onTier('standard', () => assert.ok(Math.abs(expectedLook(look) - standard.expectedUSD) < 1e-12, 'the server’s standard'));
    await onTier('standard', () => assert.ok(Math.abs(expectedLook({ ...look, tier: 'flex' }) - flex.expectedUSD) < 1e-12, 'the look’s own flex'));
    const second = { ...look, second: true };
    await onTier('flex', () =>
      assert.ok(Math.abs(2 * expectedLook(second) - expectedLook({ ...second, tier: 'standard' })) < 1e-12, 'a thin look’s standard re-look costs twice a flex one'),
    );
  } finally {
    fake.restore();
  }
  /* A finished flex reply that reported no cost, with no record in time: uncertain at the flex price. */
  fake = fakeAxios(({ url, config, body }) =>
    url.includes('/generation')
      ? httpError(config, 404, { error: { message: 'Generation not found' } })
      : { headers: { 'x-generation-id': 'gen-unpriced' }, data: { ...servedBy(body), usage: { completion_tokens: 4000 } } },
  );
  ({ entries, meter } = ledger());
  try {
    const result = await onTier('flex', () => limited({ lookupAtMs: [10], lookupMs: 60 }, () => analyze(look, signal, meter)));
    assert.equal(entries[0].uncertain, true);
    assert.ok(Math.abs(entries[0].costUSD - expectedOf(entries[0].reserve, { ...close, price: flexPrice })) < 1e-9, `${entries[0].costUSD}`);
    assert.equal(result.vision[0].requested, 'flex');
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
