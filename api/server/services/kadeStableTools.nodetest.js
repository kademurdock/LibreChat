'use strict';
/* THE STABLE TOOL SET (Nov 14 2026, KADE_CLAUDE_STABLE_TOOLS). Unit tests for the parts that live in
 * services/kadeToolRetrieval.js: the switch, who it applies to, the order, the selection and the
 * log line.
 *
 * Why it exists: character chat for verified adults goes to Claude through the gateway, and any
 * change to the tool definitions throws Claude's whole prompt cache away. The narrowing picked a
 * different set from turn to turn (10 tools, then 32), so four of six turns were written again at
 * $8 a million tokens instead of read at $0.20.
 *
 * Who carries the verified-adult note, what the loader still takes away (the lookup gate, the review
 * seat, a background run) and "off is today, byte for byte" for every kind of account are held in
 * Endpoints/agents/initialize.spec.js ("stable tool set").
 *
 * Plain node:test. No model, no network, no database:
 *   node --test api/server/services/kadeStableTools.nodetest.js
 * Everything said in these messages is made up. */
const test = require('node:test');
const assert = require('node:assert/strict');

const R = require('./kadeToolRetrieval');

/** Kiana's whole loaded set (her own list as saved Nov 13 2026, the tools every character is given,
 *  and the lookup browser), in the order her record and the loader hand it over. */
const KIANA = [
  'flux',
  'kade_phone_call',
  'kade_notify',
  'kade_weather',
  'kade_wikipedia',
  'kade_joke',
  'kade_news',
  'kade_read_page',
  'kade_adventure',
  'kade_games',
  'kade_feedback',
  'kade_code',
  'kade_help',
  'kade_transcribe',
  'kade_location',
  'kade_memory_search',
  'kade_research',
  'kade_drive_pc',
  'kade_living_memory',
  'kade_errand',
  'kade_council',
  'kade_make_file',
  'file_search',
  'web_search',
  'kade_lookup',
  'kade_message',
  'kade_call_me',
  'kade_lyrics',
  'kade_media',
  'kade_funding_balance',
  'kade_task',
  'kade_studio',
  'kade_phone_pairing',
  'kade_known',
  'kade_recall',
];
const SORTED = [...KIANA].sort();

const def = (name) => ({
  name,
  description: `${name} does ${name} things`,
  parameters: { type: 'object', properties: { action: { type: 'string' } } },
});

/** The same list in another order, the same way for the same seed. */
function shuffled(list, seed) {
  const out = [...list];
  let s = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A loadAgentTools result for these names, in this order, with the tool text in this key order. */
function loadedFor(names, textOrder = ['web_search', 'file_search']) {
  const dynamic = {};
  for (const key of textOrder) {
    if (names.includes(key)) dynamic[key] = `${key} runtime text`;
  }
  return {
    toolDefinitions: names.map(def),
    toolRegistry: new Map(names.map((n) => [n, def(n)])),
    toolContextMap: names.includes('web_search') ? { web_search: 'web_search head block' } : {},
    dynamicToolContextMap: dynamic,
  };
}

const ENV = ['KADE_CLAUDE_STABLE_TOOLS', 'KADE_TOOLS_RAG_STRICT', 'KADE_TOOLS_EMBED_WAIT_MS'];
/** Run `fn` (sync or async) with these variables set, and put them back when it has finished. */
async function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the switch is on only for exactly "1"', async () => {
  for (const value of [undefined, '', '0', 'true', 'yes', 'on', ' 1', '1 ', '01', '2', 'TRUE']) {
    assert.equal(R.stableToolsOn({ KADE_CLAUDE_STABLE_TOOLS: value }), false, String(value));
  }
  assert.equal(R.stableToolsOn({ KADE_CLAUDE_STABLE_TOOLS: '1' }), true);
  assert.equal(R.stableToolsOn({}), false);
  await withEnv({ KADE_CLAUDE_STABLE_TOOLS: undefined }, () =>
    assert.equal(R.stableToolsOn(), false),
  );
  await withEnv({ KADE_CLAUDE_STABLE_TOOLS: '1' }, () => assert.equal(R.stableToolsOn(), true));
});

test('it applies only to a verified-adult head, with a person there and no tool policy', () => {
  const on = { KADE_CLAUDE_STABLE_TOOLS: '1' };
  const person = { body: { text: 'hi' } };
  assert.equal(R.stableApplies(person, true, on), true);
  /* switched off, or the switch not exactly "1" */
  assert.equal(R.stableApplies(person, true, {}), false);
  assert.equal(R.stableApplies(person, true, { KADE_CLAUDE_STABLE_TOOLS: '0' }), false);
  /* no verified-adult note on this agent's head (child, teen, untyped, an unknown caller, a probe) */
  for (const head of [false, undefined, null, 'true', 1]) {
    assert.equal(R.stableApplies(person, head, on), false, String(head));
  }
  /* a background run: nobody waiting, never sent to Claude */
  assert.equal(R.stableApplies({ ...person, kadeHiddenRun: true }, true, on), false);
  assert.equal(R.stableApplies({ ...person, kadeBackground: true }, true, on), false);
  /* the morning brief composes from its own list */
  assert.equal(
    R.stableApplies({ body: { text: 'brief', kadeToolPolicy: 'morning-brief' } }, true, on),
    false,
  );
  for (const req of [null, undefined, 'req']) {
    assert.equal(R.stableApplies(req, true, on), false, String(req));
  }
});

test('the whole set rides in name order, whatever order it was loaded in', () => {
  const seen = new Set();
  for (const seed of [1, 7, 42, 99, 2026]) {
    const result = loadedFor(shuffled(KIANA, seed));
    const names = R.applyStable(result);
    assert.deepEqual(names, SORTED, `seed ${seed}`);
    assert.deepEqual(
      result.toolDefinitions.map((d) => d.name),
      SORTED,
    );
    /* nothing taken away, nothing changed inside a definition */
    assert.equal(result.toolDefinitions.length, KIANA.length);
    assert.deepEqual(
      result.toolDefinitions.find((d) => d.name === 'web_search'),
      def('web_search'),
    );
    assert.equal(result.toolRegistry.size, KIANA.length);
    seen.add(JSON.stringify(result.toolDefinitions));
  }
  /* byte for byte the same definitions every time */
  assert.equal(seen.size, 1);
});

test('the tool text that goes with the whole set is kept, in one order', () => {
  const a = loadedFor(KIANA, ['web_search', 'file_search']);
  const b = loadedFor(shuffled(KIANA, 5), ['file_search', 'web_search']);
  R.applyStable(a);
  R.applyStable(b);
  /* web_search's block stays in the head and its runtime text in the tail */
  assert.deepEqual(a.toolContextMap, { web_search: 'web_search head block' });
  assert.deepEqual(Object.keys(a.dynamicToolContextMap), ['file_search', 'web_search']);
  assert.deepEqual(Object.keys(b.dynamicToolContextMap), ['file_search', 'web_search']);
  /* everything the run reads, byte for byte */
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('tools handed over as instances are sorted too; odd results never throw', () => {
  const result = { tools: shuffled(KIANA, 3).map((name) => ({ name, invoke() {} })) };
  assert.deepEqual(R.applyStable(result), SORTED);
  assert.deepEqual(
    result.tools.map((t) => t.name),
    SORTED,
  );
  assert.deepEqual(R.applyStable(null), []);
  assert.deepEqual(R.applyStable({}), []);
  assert.deepEqual(R.applyStable({ toolDefinitions: [] }), []);
  const nameless = { toolDefinitions: [def('b'), {}, def('a')] };
  assert.deepEqual(R.applyStable(nameless), ['a', 'b']);
  assert.equal(nameless.toolDefinitions.length, 3);
});

test('the selection keeps every tool and never narrows, whatever the words', () => {
  R._resetForTests();
  const tools = KIANA.map(def);
  for (const text of [
    'tell me a joke',
    'call my mom for me',
    'ugh work was rough today and my back hurts',
    "what's the weather tomorrow?",
    'Tell me about the Clancy trial. Apparently, it is all over socials',
    '',
  ]) {
    const sel = R.selectStable({ tools, text, conversationId: 'c-words', embed: async () => null });
    assert.deepEqual([...sel.keep], KIANA, text);
    assert.deepEqual(sel.dropped, []);
    assert.equal(sel.reason, 'stable');
  }
});

test('the selection starts the memory embed early, with the exact string the narrowing starts', async () => {
  const previous = 'I keep thinking about my sister Amy and her new job in Denver';
  const later = ['what about her?', 'tell me something nice about the ocean tonight please'];
  const tools = KIANA.map(def);
  const asksDuring = async (run) => {
    R._resetForTests();
    const calls = [];
    const embed = async (text, opts) => {
      calls.push({ text, purpose: opts && opts.purpose });
      return null;
    };
    await run(embed);
    await tick();
    return calls;
  };
  const narrowed = await asksDuring((embed) =>
    withEnv({ KADE_TOOLS_EMBED_WAIT_MS: '0' }, async () => {
      for (const text of [previous, ...later]) {
        await R.selectTools({ tools, text, conversationId: 'c-mem', agentId: 'a', embed });
      }
    }),
  );
  const stable = await asksDuring(async (embed) => {
    for (const text of [previous, ...later]) {
      R.selectStable({ tools, text, conversationId: 'c-mem', embed });
    }
  });
  const memory = (calls) => calls.filter((c) => c.purpose === undefined).map((c) => c.text);
  assert.deepEqual(memory(stable), memory(narrowed));
  assert.equal(memory(stable).length, 3);
  /* a short turn carries the message before it, as recall expects */
  assert.equal(memory(stable)[1], `${previous}\nwhat about her?`);
  /* and nothing else: no tools embed, no description embeds */
  assert.deepEqual(
    stable.filter((c) => c.purpose !== undefined),
    [],
  );
  assert.ok(
    narrowed.some((c) => c.purpose === 'tools'),
    'the narrowing asks for its tools embed',
  );
});

test('the selection leaves the narrowing alone: no sticky tools, no pending search', async () => {
  const tools = KIANA.map(def);
  const first = 'tell me a joke and call my mom, then what is the price of eggs right now?';
  const narrow = (text, conversationId) =>
    withEnv({ KADE_TOOLS_RAG_STRICT: '1', KADE_TOOLS_EMBED_WAIT_MS: '0' }, () =>
      R.selectTools({ tools, text, conversationId, agentId: 'a', embed: async () => null }),
    );
  /* a stable turn, then the same conversation narrows again (the switch turned off) */
  R._resetForTests();
  R.selectStable({ tools, text: first, conversationId: 'c-sticky', embed: async () => null });
  const after = await narrow('yes', 'c-sticky');
  for (const name of ['kade_joke', 'kade_phone_call', 'web_search']) {
    assert.ok(!after.keep.has(name), name);
  }
  /* the same two turns narrowed from the start keep what the first one asked for */
  R._resetForTests();
  await narrow(first, 'c-sticky-2');
  const sticky = await narrow('yes', 'c-sticky-2');
  for (const name of ['kade_joke', 'kade_phone_call', 'web_search']) {
    assert.ok(sticky.keep.has(name), name);
  }
});

test('the log line names the agent, the count and the set, never anything anybody said', () => {
  const line = R.stableLogLine('agent_6llV0eMu4fmIaj8f2x1Sb', SORTED);
  assert.match(
    line,
    /^\[kadeStableTools\] agent=agent_6llV0eMu4fmIaj8f2x1Sb tools=35 set=[0-9a-f]{8}$/,
  );
  /* the same set in the same order prints the same fingerprint; another order does not */
  assert.equal(R.stableLogLine('agent_6llV0eMu4fmIaj8f2x1Sb', [...SORTED]), line);
  assert.notEqual(R.stableLogLine('agent_6llV0eMu4fmIaj8f2x1Sb', [...SORTED].reverse()), line);
  assert.match(
    R.stableLogLine('a', undefined),
    /^\[kadeStableTools\] agent=a tools=0 set=[0-9a-f]{8}$/,
  );
});
