'use strict';
/* A finished call counts as talking (Nov 10 2026): the "last talked" stamp in
 * kadeCallMemoryWrite.js must run whatever happens to the memory writer below
 * it. Runs bare under node:test on real Node: every dependency of the file is
 * replaced by a stand-in through Module._load, so no database, no model, no
 * packages. (The Deno node shim ignores Module._load; use real Node.) */
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

function load({ appConfig, claimModified = 1, noteCallTalked }) {
  const calls = { stamp: [], processMemory: 0, claim: 0, unset: 0, info: [], warn: [] };
  const stubs = {
    '@librechat/data-schemas': {
      logger: { info: (m) => calls.info.push(m), warn: (m) => calls.warn.push(m) },
      memoryClearCutoff: async () => null,
    },
    '@librechat/api': {
      processMemory: async () => {
        calls.processMemory += 1;
      },
      resolveMemoryAgentLLMConfig: async () => ({}),
      permittedUserEvidence: () => ({ userEvidence: '' }),
      permittedMemoryTurns: (turns) => turns,
    },
    '@librechat/agents/langchain/messages': {
      HumanMessage: class {},
      AIMessage: class {},
      getBufferString: () => 'buffer',
    },
    '~/models': {
      setMemory: async () => {},
      deleteMemory: async () => {},
      getFormattedMemories: async () => ({ withKeys: '', totalTokens: 0 }),
      getUserKey: async () => null,
      getUserKeyValues: async () => null,
    },
    '~/models/kadeCallTranscript': {
      KadeCallTranscript: {
        updateOne: async (_filter, update) => {
          if (update.$unset) calls.unset += 1;
          else calls.claim += 1;
          return { modifiedCount: claimModified };
        },
      },
    },
    '~/server/services/Config': { getAppConfig: async () => appConfig },
    '~/server/services/kadeSoul': {
      noteCallTalked: async (doc) => {
        calls.stamp.push({ id: doc && doc._id, claimsSoFar: calls.claim, writerRunsSoFar: calls.processMemory });
        return noteCallTalked ? noteCallTalked(doc) : { ok: true, at: new Date(0) };
      },
    },
  };
  const realLoad = Module._load;
  Module._load = function patched(request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return realLoad.call(this, request, ...rest);
  };
  const file = require.resolve('./kadeCallMemoryWrite.js');
  delete require.cache[file];
  try {
    return { mod: require(file), calls, restore: () => { Module._load = realLoad; delete require.cache[file]; } };
  } catch (e) {
    Module._load = realLoad;
    throw e;
  }
}

const doc = (extra = {}) => ({
  _id: 'call1',
  user: 'u1',
  agentId: 'agent_x',
  surface: 'phone',
  endedAt: new Date('2026-10-16T22:10:00Z'),
  turns: [
    { role: 'user', text: 'Hi, it is me.' },
    { role: 'assistant', text: 'Good to hear you.' },
  ],
  ...extra,
});

const WRITER = { memory: { agent: { provider: 'p', model: 'm', instructions: 'i' }, tokenLimit: 1000 } };

async function run(opts, d, env = {}) {
  const before = {};
  for (const k of Object.keys(env)) {
    before[k] = process.env[k];
    process.env[k] = env[k];
  }
  const h = load(opts);
  try {
    const result = await h.mod.extractMemoryFromCall(d);
    return { result, calls: h.calls };
  } finally {
    h.restore();
    for (const k of Object.keys(env)) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
}

test('the stamp runs first, before the run-once claim and before the writer', async () => {
  const { result, calls } = await run({ appConfig: WRITER }, doc());
  assert.deepStrictEqual(result, { ran: true });
  assert.deepStrictEqual(calls.stamp, [{ id: 'call1', claimsSoFar: 0, writerRunsSoFar: 0 }]);
  assert.strictEqual(calls.processMemory, 1);
  assert.ok(calls.info.some((m) => /counted as talking/.test(m)));
});

test('the stamp does not need the memory writer: not configured, memory disabled, or switched off', async () => {
  for (const appConfig of [{ memory: {} }, { memory: { disabled: true } }, {}, null]) {
    const { result, calls } = await run({ appConfig }, doc());
    assert.strictEqual(result.ran, false);
    assert.strictEqual(calls.stamp.length, 1, JSON.stringify(appConfig));
    assert.strictEqual(calls.processMemory, 0);
  }
  const off = await run({ appConfig: WRITER }, doc(), { KADE_CALL_MEMORY: '0' });
  assert.deepStrictEqual(off.result, { ran: false, reason: 'disabled' });
  assert.strictEqual(off.calls.stamp.length, 1, 'KADE_CALL_MEMORY=0 stops the writer, not the stamp');
  assert.strictEqual(off.calls.claim, 0);
});

test('a second ingest of the same call stamps again (harmless: the time only moves forward) and files nothing twice', async () => {
  const { result, calls } = await run({ appConfig: WRITER, claimModified: 0 }, doc());
  assert.deepStrictEqual(result, { ran: false, reason: 'already-extracted' });
  assert.strictEqual(calls.stamp.length, 1);
  assert.strictEqual(calls.processMemory, 0);
});

test('a call too short to learn from still counts as talking', async () => {
  const { result, calls } = await run({ appConfig: WRITER }, doc({ turns: [{ role: 'user', text: 'Hi, just checking in, bye.' }] }));
  assert.deepStrictEqual(result, { ran: false, reason: 'too-short' });
  assert.strictEqual(calls.stamp.length, 1);
});

test('a stamp that fails never stops the writer, and a refused stamp is not logged as talking', async () => {
  const thrown = await run({ appConfig: WRITER, noteCallTalked: async () => { throw new Error('db down'); } }, doc());
  assert.deepStrictEqual(thrown.result, { ran: true });
  assert.strictEqual(thrown.calls.processMemory, 1);
  assert.ok(thrown.calls.warn.some((m) => /last-talked stamp skipped: db down/.test(m)));
  const refused = await run({ appConfig: WRITER, noteCallTalked: async () => ({ ok: false, skipped: 'memory-off' }) }, doc());
  assert.deepStrictEqual(refused.result, { ran: true });
  assert.ok(!refused.calls.info.some((m) => /counted as talking/.test(m)));
});

test('nothing with a name, a number or the words of the call goes into the log line', async () => {
  const { calls } = await run({ appConfig: WRITER }, doc({ callerName: 'Robin Example', from: '+15555550100' }));
  const lines = [...calls.info, ...calls.warn].join('\n');
  assert.doesNotMatch(lines, /Robin|5555550100|Hi, it is me/);
});
