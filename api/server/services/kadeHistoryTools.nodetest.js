'use strict';
/* PAST TOOL CALLS NOT ON HAND THIS TURN, and the echo they taught (Nov 13 2026). Unit tests.
 *
 * What happened: a reply was read aloud with "Tool: kade_research, === Deep Research Context ..."
 * at the end of it. No tool ran on that turn; the model wrote the line, copying how its own
 * earlier replies had been shown to it (reply text, then "Tool: web_search, <thousands of
 * characters of search output>"). services/kadeHistoryTools.js stops both halves: the earlier
 * calls to tools that are not attached this turn are left out before the history is formatted,
 * and a reply already saved with an echo has the echo left out of what the model reads.
 *
 * Plain node:test. No model, no network, no database, no packages:
 *   node --test api/server/services/kadeHistoryTools.nodetest.js
 * The same checks against the real @librechat/agents formatter are in
 * kadeHistoryTools.reallib.nodetest.js. Everything said in these messages is made up. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const H = require('./kadeHistoryTools');

const ON = {};
const OFF = { KADE_HISTORY_TOOL_DROP: '0' };

const user = (words) => ({ role: 'user', content: words });
const asst = (...parts) => ({ role: 'assistant', content: parts });
const text = (words, ids) =>
  ids ? { type: 'text', text: words, tool_call_ids: ids } : { type: 'text', text: words };
const think = (words) => ({ type: 'think', think: words });
const call = (id, name, output = `result of ${name}`) => ({
  type: 'tool_call',
  tool_call: { id, name, args: '{"query":"x"}', output },
});

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** Milliseconds one call takes. */
function timed(work) {
  const started = process.hrtime.bigint();
  work();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

/* Generous: each of these takes a few milliseconds. A rule that went quadratic takes seconds. */
const FAST_MS = 1000;

const SEARCH_OUTPUT =
  '=== Web Results, Turn 0 ===\n' + 'Source 1: a page about described video. '.repeat(210);
const NOV13_REPLY =
  "Right now there's tons of content with no description available and people left sitting in the dark.";
const NOV13_ECHO =
  'Tool: kade_research, === Deep Research Context ===\n\n# Your Question, Stated\n' +
  'Someone asked: If an app lets a phone listen to a TV playing a film ... Could it be sold, or does it have to be free?';

/* ------------------------------------------------------------------ stripToolEcho */

test('the Nov 13 reply: the echo goes, the reply stays, word for word', () => {
  const saved = `${NOV13_REPLY}\n${NOV13_ECHO}`;
  const out = H.stripToolEcho(saved, ['kade_research', 'kade_weather'], ON);
  assert.equal(out, NOV13_REPLY);
  assert.equal(out.includes('Tool:'), false);
  /* no names handed in: kade_research is still a platform name */
  assert.equal(H.stripToolEcho(saved, undefined, ON), NOV13_REPLY);
});

test('the Oct 15 shape: a web_search echo with a long made-up result', () => {
  const saved = `Here is what I found about the trial.\n\nTool: web_search, ${SEARCH_OUTPUT}`;
  assert.equal(H.stripToolEcho(saved, null, ON), 'Here is what I found about the trial.');
});

test('every platform tool name is recognised with no names handed in', () => {
  const names = [
    'web_search',
    'file_search',
    'execute_code',
    'tool_search',
    'subagent',
    'flux',
    'kade_research',
    'kade_news',
    'kade_weather',
    'kade_lookup',
    'kade_read_page',
    'kade_media',
    'kade_notify',
    'kade_help',
    'kade_memory_search',
    'kade_wikipedia',
    'kade_location',
    'kade_feedback',
    'kade_something_new',
  ];
  for (const name of names) {
    assert.equal(H.stripToolEcho(`Words.\nTool: ${name}, made up`, null, ON), 'Words.', name);
    assert.deepEqual(H.findToolEcho(`Words.\nTool: ${name}, made up`), { index: 7, name }, name);
  }
});

test('an identifier with an underscore is tool-like; a plain word is not, unless it is known', () => {
  assert.equal(H.stripToolEcho('Words.\nTool: lookup_mcp_server, made up', null, ON), 'Words.');
  assert.equal(H.stripToolEcho('Words.\nTool: getIssues_action_api, made up', null, ON), 'Words.');
  const plain = 'Words.\nTool: calculator, 2 + 2';
  assert.equal(H.stripToolEcho(plain, null, ON), plain);
  assert.equal(H.stripToolEcho(plain, ['calculator'], ON), 'Words.');
  assert.equal(H.stripToolEcho(plain, new Set(['calculator']), ON), 'Words.');
  /* a name with a hyphen is only tool-like when this request knows it */
  const hyphen = 'Words.\nTool: azure-ai-search, made up';
  assert.equal(H.stripToolEcho(hyphen, null, ON), hyphen);
  assert.equal(H.stripToolEcho(hyphen, ['azure-ai-search'], ON), 'Words.');
});

test('ordinary sentences are never touched, and come back as the very same string', () => {
  const lines = [
    'Tool: hammer, nails',
    'Tools: a list',
    'Tools: web_search, kade_news',
    'Tool: web_search is the one I would use.',
    'My favourite Tool: web_search, by far.',
    ' Tool: web_search, indented so not at the start of a line',
    'tool: web_search, lower case',
    'TOOL: web_search, upper case',
    'Tool:web_search, no space after the colon',
    'Tool:  web_search, two spaces',
    'Tool: web search, a space in the name',
    'Tool: web_search,and no space after the comma',
    'Tool: , nothing named',
    'Tool: kade_ is my friend, he said',
    `Tool: ${'a_'.repeat(80)}, a name longer than any tool name`,
    'Tool: web_search\n, the comma is on the next line',
    'She said "Tool: web_search, go" and laughed.',
    'A reply with no tool in it at all.   \n\n',
    '',
  ];
  for (const line of lines) {
    const out = H.stripToolEcho(line, ['web_search'], ON);
    assert.equal(out, line, JSON.stringify(line));
    assert.equal(H.findToolEcho(line, ['web_search']), null, JSON.stringify(line));
  }
  /* and inside a longer reply */
  const reply = 'First.\nTool: hammer, nails\nTools: a list\nLast.';
  assert.equal(H.stripToolEcho(reply, null, ON), reply);
});

test('white space before the echo is trimmed; a text with no echo is not trimmed', () => {
  assert.equal(H.stripToolEcho('Hi there.  \n\n\nTool: kade_news, made up', null, ON), 'Hi there.');
  assert.equal(
    H.stripToolEcho('Hi there.\r\nTool: kade_news, made up\r\nmore', null, ON),
    'Hi there.',
  );
  assert.equal(H.stripToolEcho('Hi there.  \n\n', null, ON), 'Hi there.  \n\n');
});

test('the echo may be the whole text, may end at its comma, and may break the line after it', () => {
  assert.equal(H.stripToolEcho('Tool: kade_research, === Deep Research Context ===', null, ON), '');
  assert.equal(H.stripToolEcho('Hi.\nTool: kade_research, ', null, ON), 'Hi.');
  assert.equal(H.stripToolEcho('Hi.\nTool: kade_research,', null, ON), 'Hi.');
  assert.equal(
    H.stripToolEcho('Hi.\nTool: kade_research,\n=== Deep Research Context ===', null, ON),
    'Hi.',
  );
  assert.equal(H.stripToolEcho('Hi.\nTool: kade_research,\tmade up', null, ON), 'Hi.');
});

test('everything from the first echo line to the end goes; what is before it stays', () => {
  const saved = 'A.\nTool: hammer, nails\nB.\nTool: flux, made up\nC.\nTool: web_search, made up';
  assert.equal(H.stripToolEcho(saved, null, ON), 'A.\nTool: hammer, nails\nB.');
  assert.deepEqual(H.findToolEcho(saved), { index: 26, name: 'flux' });
});

test('what is not a string comes back as it is', () => {
  for (const value of [null, undefined, 5, true, { text: 'Tool: flux, x' }, ['Tool: flux, x']]) {
    assert.equal(H.stripToolEcho(value, null, ON), value);
    assert.equal(H.findToolEcho(value), null);
  }
});

test('the off switch: KADE_HISTORY_TOOL_DROP=0 leaves the echo in', () => {
  const saved = `${NOV13_REPLY}\n${NOV13_ECHO}`;
  assert.equal(H.stripToolEcho(saved, null, OFF), saved);
  assert.equal(H.on(OFF), false);
  assert.equal(H.on(ON), true);
  assert.equal(H.on({ KADE_HISTORY_TOOL_DROP: '1' }), true);
  assert.equal(H.on({ KADE_HISTORY_TOOL_DROP: '' }), true);
});

test('200,000 characters: the echo scan is linear on the inputs that make a pattern crawl', () => {
  const n = 200000;
  const cases = {
    'no echo at all': 'a'.repeat(n),
    'only line breaks': '\n'.repeat(n),
    'the mark over and over on one line': 'Tool: '.repeat(n / 6),
    'the mark at every line start, never a comma': 'Tool: web_search\n'.repeat(n / 17),
    'the mark at every line start, a plain word': 'Tool: hammer, nails\n'.repeat(n / 20),
    'one mark and a name that never ends': 'Tool: ' + 'a_'.repeat(n / 2),
    'commas everywhere': ('Tool: ' + ','.repeat(40) + '\n').repeat(n / 47),
    'a real echo after a long run of spaces': 'Words.' + ' '.repeat(n) + '\nTool: flux, made up',
    'a real echo in front of a long result': 'Words.\nTool: web_search, ' + 'x'.repeat(n),
    'a real echo at the very end': 'word '.repeat(n / 5) + '\nTool: kade_news, made up',
  };
  for (const [label, input] of Object.entries(cases)) {
    let out;
    const ms = timed(() => {
      out = H.stripToolEcho(input, ['web_search'], ON);
    });
    assert.ok(ms < FAST_MS, `${label}: ${ms.toFixed(1)} ms`);
    if (label.startsWith('a real echo')) {
      assert.equal(out.includes('Tool:'), false, label);
      assert.ok(out.length > 0 && out.length < input.length, label);
    } else {
      assert.equal(out, input, label);
    }
  }
  assert.equal(
    H.stripToolEcho('Words.' + ' '.repeat(n) + '\nTool: flux, made up', null, ON),
    'Words.',
  );
});

/* ------------------------------------------------------------------ dropUnattachedToolCalls */

/** The Nov 13 conversation as it was stored: two earlier replies that each searched the web. */
function nov13Payload() {
  return [
    user('Is there an app that describes films for blind people?'),
    asst(
      think('I should search.'),
      call('call_1', 'web_search', SEARCH_OUTPUT),
      text('A few exist, mostly for cinemas.'),
    ),
    user('What about TV at home?'),
    asst(think('Search again.'), call('call_2', 'web_search', SEARCH_OUTPUT), text(NOV13_REPLY)),
    user('If she built one, could she sell it?'),
  ];
}
/* What was attached on the third turn: research and the core set, not web_search. */
const NOV13_TOOLS = new Set([
  'kade_research',
  'kade_memory_search',
  'kade_notify',
  'kade_weather',
  'kade_help',
  'kade_feedback',
]);

test('the Nov 13 history: both web_search calls go, the replies stay, nothing stored is touched', () => {
  const payload = deepFreeze(nov13Payload());
  const before = JSON.stringify(payload);
  const out = H.dropUnattachedToolCalls(payload, NOV13_TOOLS, ON);

  assert.notEqual(out, payload, 'a new payload');
  assert.equal(out.length, payload.length, 'same length, so the token map stays in step');
  assert.equal(JSON.stringify(payload), before, 'the input is as it was');
  assert.equal(JSON.stringify(out).includes('Web Results'), false, 'no search output left');

  for (const i of [0, 2, 4])
    assert.equal(out[i], payload[i], `the person's message ${i} is the very same object`);
  for (const i of [1, 3]) {
    assert.notEqual(out[i], payload[i], `assistant message ${i} is a copy`);
    assert.equal(out[i].role, 'assistant');
    assert.deepEqual(
      out[i].content.map((part) => part.type),
      ['think', 'text'],
    );
    assert.equal(out[i].content[0], payload[i].content[0], 'the thinking part is the same object');
    assert.equal(out[i].content[1], payload[i].content[2], 'the text part is the same object');
  }
  assert.equal(out[3].content[1].text, NOV13_REPLY);
});

test('several calls in one message: only the ones not attached go, in place, and the pointers follow', () => {
  const pre = text('Let me check a few things.', ['c1', 'c2', 'c3']);
  const payload = deepFreeze([
    user('Weather and news, please.'),
    asst(
      pre,
      call('c1', 'web_search'),
      call('c2', 'kade_weather'),
      call('c3', 'kade_news'),
      text('Only one of these was mine to keep.', ['c4']),
      call('c4', 'kade_lookup'),
      text('Sunny, and the headlines are quiet.'),
    ),
    user('Thanks.'),
  ]);
  const out = H.dropUnattachedToolCalls(payload, new Set(['kade_weather']), ON);
  const parts = out[1].content;
  assert.deepEqual(
    parts.map((part) => (part.type === 'tool_call' ? part.tool_call.name : part.type)),
    ['text', 'kade_weather', 'text', 'text'],
  );
  /* the first pointer keeps only the call that stayed, on a copy */
  assert.deepEqual(parts[0].tool_call_ids, ['c2']);
  assert.notEqual(parts[0], pre);
  assert.deepEqual(pre.tool_call_ids, ['c1', 'c2', 'c3'], 'the stored part still has all three');
  assert.equal(parts[0].text, 'Let me check a few things.');
  /* the second pointer pointed only at a call that went: the list is removed, as the formatter does */
  assert.equal('tool_call_ids' in parts[2], false);
  assert.equal(parts[2].text, 'Only one of these was mine to keep.');
  /* untouched parts are the same objects */
  assert.equal(parts[1], payload[1].content[2]);
  assert.equal(parts[3], payload[1].content[6]);
});

test('a tool that is attached is left alone: the very same payload comes back', () => {
  const payload = deepFreeze([
    user('Weather?'),
    asst(text('Checking.', ['c1']), call('c1', 'kade_weather'), text('Sunny.')),
    user('And tomorrow?'),
  ]);
  assert.equal(H.dropUnattachedToolCalls(payload, new Set(['kade_weather']), ON), payload);
  assert.equal(
    H.dropUnattachedToolCalls(payload, ['kade_weather', 'web_search'], ON),
    payload,
    'an array works as a set',
  );
});

test('no tool set at all: the formatter filters nothing, so nothing is dropped', () => {
  const payload = deepFreeze(nov13Payload());
  assert.equal(H.dropUnattachedToolCalls(payload, undefined, ON), payload);
  assert.equal(H.dropUnattachedToolCalls(payload, null, ON), payload);
});

test('an empty tool set: every past call goes (the formatter would have written all of them out)', () => {
  const out = H.dropUnattachedToolCalls(deepFreeze(nov13Payload()), new Set(), ON);
  assert.deepEqual(
    out[1].content.map((part) => part.type),
    ['think', 'text'],
  );
  assert.deepEqual(
    out[3].content.map((part) => part.type),
    ['think', 'text'],
  );
});

test('names found through tool_search: usable from that result on, not before it', () => {
  const listed = JSON.stringify({
    tools: [{ name: 'lookup_mcp_x' }, { name: 'other_mcp_y' }, { nope: 1 }],
  });
  const payload = deepFreeze([
    user('q'),
    asst(
      call('early', 'lookup_mcp_x'),
      call('s1', 'tool_search', listed),
      call('c1', 'lookup_mcp_x'),
      call('c2', 'web_search'),
      text('Found it.'),
    ),
    user('q2'),
    asst(call('c3', 'other_mcp_y'), call('c4', 'never_listed_tool'), text('And again.')),
    user('q3'),
  ]);
  const out = H.dropUnattachedToolCalls(payload, new Set(['tool_search']), ON);
  const ids = (message) =>
    message.content.filter((part) => part.type === 'tool_call').map((part) => part.tool_call.id);
  assert.deepEqual(
    ids(out[1]),
    ['s1', 'c1'],
    'the call before the search result goes; the one after stays',
  );
  assert.deepEqual(ids(out[3]), ['c3'], 'a name learned in an earlier message still counts later');
});

test('a tool_search result with warnings in front of its JSON is still read', () => {
  const noisy =
    'Warning: two servers were slow.\n' +
    JSON.stringify({ tools: [{ name: 'lookup_mcp_x' }] }) +
    '\n';
  const payload = deepFreeze([
    user('q'),
    asst(call('s1', 'tool_search', noisy), call('c1', 'lookup_mcp_x'), text('Ok.')),
  ]);
  assert.equal(
    H.dropUnattachedToolCalls(payload, new Set(['tool_search']), ON),
    payload,
    'nothing to drop',
  );
  /* results that list nothing usable */
  for (const output of [
    'not json at all',
    '{"tools": "nope"}',
    '[1,2,3]',
    '{"tools":[null]}',
    '{ broken',
    '} {',
  ]) {
    const p = deepFreeze([
      user('q'),
      asst(call('s1', 'tool_search', output), call('c1', 'lookup_mcp_x'), text('Ok.')),
    ]);
    const out = H.dropUnattachedToolCalls(p, new Set(['tool_search']), ON);
    assert.deepEqual(
      out[1].content.map((part) => (part.tool_call ? part.tool_call.id : part.type)),
      ['s1', 'text'],
      output,
    );
  }
});

test('tool_search not attached: its call goes, and so do the calls only it had listed', () => {
  /* The formatter learns names by reading the result. With the call gone there is nothing to
   * read, so a call it alone made usable would be written out as text after all. */
  const listed = JSON.stringify({ tools: [{ name: 'lookup_mcp_x' }] });
  const payload = deepFreeze([
    user('q'),
    asst(
      call('s1', 'tool_search', listed),
      call('c1', 'lookup_mcp_x'),
      call('c2', 'kade_weather'),
      text('Found.'),
    ),
  ]);
  const out = H.dropUnattachedToolCalls(payload, new Set(['kade_weather']), ON);
  assert.deepEqual(
    out[1].content.map((part) => (part.tool_call ? part.tool_call.id : part.type)),
    ['c2', 'text'],
  );
});

test('malformed tool calls and odd parts are left exactly where they are', () => {
  const noCall = { type: 'tool_call' };
  const noName = { type: 'tool_call', tool_call: { id: 'm1', output: 'x' } };
  const emptyName = { type: 'tool_call', tool_call: { id: 'm2', name: '', output: 'x' } };
  const words = text('Words.', ['m1', 'm2', 'c1']);
  const payload = deepFreeze([
    user('q'),
    asst(null, noCall, noName, emptyName, undefined, words, call('c1', 'web_search'), {
      type: 'error',
      error: 'boom',
    }),
    { role: 'assistant', content: 'A plain string reply.' },
    { role: 'assistant' },
    { role: 'assistant', content: null },
    {
      role: 'user',
      content: [call('u1', 'web_search'), text('Tool: web_search, typed by the person')],
    },
    { role: 'system', content: [call('s1', 'web_search')] },
    { role: 'tool', content: [call('t1', 'web_search')] },
    null,
  ]);
  const out = H.dropUnattachedToolCalls(payload, new Set(['kade_weather']), ON);
  const parts = out[1].content;
  assert.equal(parts.length, 7, 'only the one well-formed, unattached call went');
  assert.equal(parts[0], null);
  assert.equal(parts[1], noCall);
  assert.equal(parts[2], noName);
  assert.equal(parts[3], emptyName);
  assert.equal(parts[4], undefined);
  /* the malformed ids are the formatter's to remove; only the dropped call's id leaves here */
  assert.deepEqual(parts[5].tool_call_ids, ['m1', 'm2']);
  assert.equal(parts[6].type, 'error');
  for (let i = 2; i < payload.length; i++)
    assert.equal(out[i], payload[i], `message ${i} is the very same object`);
});

test('a reply that was only a tool call: nothing is invented, the message is handed on empty', () => {
  const payload = deepFreeze([
    user('q1'),
    asst(call('c1', 'web_search')),
    user('q2'),
    asst(think('Search.'), call('c2', 'web_search')),
    user('q3'),
    asst(text('', ['c3']), call('c3', 'web_search')),
    user('q4'),
    asst(text('   \n', ['c4', 'c5']), call('c4', 'web_search'), call('c5', 'kade_weather')),
    user('q5'),
  ]);
  const out = H.dropUnattachedToolCalls(payload, new Set(['kade_weather']), ON);
  assert.equal(out.length, payload.length);
  assert.deepEqual(out[1], { role: 'assistant', content: [] });
  assert.deepEqual(out[3], { role: 'assistant', content: [think('Search.')] });
  /* no words and its only call gone: the pointer goes too, so no empty assistant message is opened */
  assert.deepEqual(out[5], { role: 'assistant', content: [{ type: 'text', text: '' }] });
  /* no words but one of its calls stays: the pointer stays, on that call */
  assert.deepEqual(out[7].content[0], { type: 'text', text: '   \n', tool_call_ids: ['c5'] });
  assert.equal(JSON.stringify(out).includes('Tool:'), false);
});

test('an empty text part pointing at a call that is not there loses the pointer when a call was dropped', () => {
  /* Without this the formatter opens an assistant message with nothing in it (proved in the
   * real-library test). Before this file, the formatter's own "Tool: ..." text filled that part. */
  const payload = deepFreeze([
    user('q'),
    asst(text('', ['gone']), call('', 'web_search')),
    user('q2'),
  ]);
  const out = H.dropUnattachedToolCalls(payload, new Set(['kade_weather']), ON);
  assert.deepEqual(out[1].content, [{ type: 'text', text: '' }]);
  /* with words the pointer is the formatter's business, as before */
  const worded = deepFreeze([
    user('q'),
    asst(text('Hi.', ['gone']), call('', 'web_search')),
    user('q2'),
  ]);
  assert.deepEqual(H.dropUnattachedToolCalls(worded, new Set(['kade_weather']), ON)[1].content, [
    text('Hi.', ['gone']),
  ]);
  /* Nov 13 review: an empty pointer on a part that is not the last text part goes too, in a
   * message the pass changed. The formatter opened an empty assistant message for it before as
   * well (its line went into "Reply."); now it opens none. */
  const earlier = deepFreeze([
    user('q'),
    asst(text('', ['gone']), call('', 'web_search'), text('Reply.')),
    user('q2'),
  ]);
  assert.deepEqual(H.dropUnattachedToolCalls(earlier, new Set(['kade_weather']), ON)[1].content, [
    { type: 'text', text: '' },
    text('Reply.'),
  ]);
  /* a message the pass does not change is handed on as it came, pointer and all */
  const untouched = deepFreeze([user('q'), asst(text('', ['gone']), text('Reply.')), user('q2')]);
  assert.equal(H.dropUnattachedToolCalls(untouched, new Set(['kade_weather']), ON), untouched);
  assert.equal(H.prepareHistory(untouched, new Set(['kade_weather']), ON).payload, untouched);
});

test('an empty pointer stays when words are waiting in front of it, or a call that stays comes after it', () => {
  const tools = new Set(['kade_weather']);
  /* words waiting: the formatter closes them into a message at the pointer, and the call after hangs on it */
  const waiting = deepFreeze([
    user('q'),
    asst(
      call('', 'web_search'),
      text('Some words.'),
      text('', ['gone']),
      think('Hm.'),
      call('c5', 'kade_weather'),
    ),
    user('q2'),
  ]);
  assert.deepEqual(H.dropUnattachedToolCalls(waiting, tools, ON)[1].content, [
    text('Some words.'),
    text('', ['gone']),
    think('Hm.'),
    call('c5', 'kade_weather'),
  ]);
  /* a call after it: the message it opens carries that call, whatever the pointer names */
  const carried = deepFreeze([
    user('q'),
    asst(call('', 'web_search'), text('', ['gone']), call('c5', 'kade_weather')),
    user('q2'),
  ]);
  assert.deepEqual(H.dropUnattachedToolCalls(carried, tools, ON)[1].content, [
    text('', ['gone']),
    call('c5', 'kade_weather'),
  ]);
  /* the call that stays is BEFORE it, nothing after: it would open an empty message, so it goes */
  const behind = deepFreeze([
    user('q'),
    asst(call('c5', 'kade_weather'), text('', ['c5']), call('', 'web_search')),
    user('q2'),
  ]);
  assert.deepEqual(H.dropUnattachedToolCalls(behind, tools, ON)[1].content, [
    call('c5', 'kade_weather'),
    { type: 'text', text: '' },
  ]);
  /* a later part that points at calls takes the call after it for itself */
  const taken = deepFreeze([
    user('q'),
    asst(
      text('Tool: flux, made up', ['gone']),
      text('Next.', ['c5']),
      call('c5', 'kade_weather'),
      call('', 'web_search'),
    ),
    user('q2'),
  ]);
  assert.deepEqual(H.prepareHistory(taken, tools, ON).payload[1].content, [
    { type: 'text', text: '' },
    text('Next.', ['c5']),
    call('c5', 'kade_weather'),
  ]);
  /* something that is not text is waiting (a picture): kept, the formatter would put the empty
   * part into that message as an empty text block, so the pointer goes even with a call after it */
  const picture = { type: 'image_url', image_url: { url: 'https://example.test/made-up.png' } };
  const beside = deepFreeze([
    user('q'),
    asst(picture, call('', 'web_search'), text('', ['gone']), call('c5', 'kade_weather')),
    user('q2'),
  ]);
  assert.deepEqual(H.dropUnattachedToolCalls(beside, tools, ON)[1].content, [
    picture,
    { type: 'text', text: '' },
    call('c5', 'kade_weather'),
  ]);
});

test('history before the newest summary is not read by the formatter, and is not touched here', () => {
  const listed = JSON.stringify({ tools: [{ name: 'old_mcp_tool' }] });
  const payload = deepFreeze([
    user('long ago'),
    asst(call('s0', 'tool_search', listed), call('o1', 'web_search'), text('Old reply.')),
    user('q1'),
    asst(
      call('b1', 'web_search'),
      { type: 'summary', content: [{ type: 'text', text: 'What was said so far.' }] },
      call('c1', 'old_mcp_tool'),
      call('c2', 'kade_weather'),
      text('After the summary.'),
    ),
    user('q2'),
  ]);
  const out = H.dropUnattachedToolCalls(payload, new Set(['tool_search', 'kade_weather']), ON);
  assert.equal(out[1], payload[1], 'the message before the summary is the very same object');
  const parts = out[3].content;
  /* b1 sits before the summary part: left. c1 was only listed before the summary: goes. */
  assert.deepEqual(
    parts.map((part) => (part.tool_call ? part.tool_call.id : part.type)),
    ['b1', 'summary', 'c2', 'text'],
  );
  /* a summary with no words is not a boundary */
  const empty = deepFreeze([
    user('q'),
    asst(
      call('x1', 'web_search'),
      { type: 'summary', content: [{ type: 'text', text: '  ' }] },
      text('Reply.'),
    ),
  ]);
  assert.deepEqual(
    H.dropUnattachedToolCalls(empty, new Set(), ON)[1].content.map((part) => part.type),
    ['summary', 'text'],
  );
  /* the older shape, with the words on the part itself */
  const legacy = deepFreeze([
    user('q'),
    asst(
      call('x1', 'web_search'),
      { type: 'summary', text: 'Words.' },
      call('x2', 'web_search'),
      text('Reply.'),
    ),
  ]);
  assert.deepEqual(
    H.dropUnattachedToolCalls(legacy, new Set(), ON)[1].content.map((part) =>
      part.tool_call ? part.tool_call.id : part.type,
    ),
    ['x1', 'summary', 'text'],
  );
});

test("a handoff call is left alone: its output is the other agent's reply", () => {
  const handoff = call(
    'h1',
    'lc_transfer_to_agent_x',
    '--- Transfer to X ---\n\nX: hello\n\n--- End of X response ---',
  );
  const payload = deepFreeze([
    user('q'),
    asst(text('Passing you over.'), handoff, call('c1', 'web_search')),
    user('q2'),
  ]);
  const out = H.dropUnattachedToolCalls(payload, new Set(['kade_weather']), ON);
  assert.deepEqual(out[1].content, [text('Passing you over.'), handoff]);
  const only = deepFreeze([user('q'), asst(text('Passing you over.'), handoff), user('q2')]);
  assert.equal(H.dropUnattachedToolCalls(only, new Set(['kade_weather']), ON), only);
});

test('a message that is not a plain object is handed on as it is', () => {
  class Stored {
    constructor() {
      this.role = 'assistant';
      this.content = [call('c1', 'web_search'), text('Reply.\nTool: flux, made up')];
    }
  }
  const odd = new Stored();
  const payload = [user('q'), odd, user('q2')];
  assert.equal(H.dropUnattachedToolCalls(payload, new Set(), ON), payload);
  const prepared = H.prepareHistory(payload, new Set(), ON);
  assert.equal(prepared.payload, payload);
  assert.equal(prepared.line, '');
  assert.equal(odd.content.length, 2);
});

test('the off switch and any failure hand back the very payload that came in', () => {
  const payload = deepFreeze(nov13Payload());
  assert.equal(H.dropUnattachedToolCalls(payload, NOV13_TOOLS, OFF), payload);
  assert.equal(H.prepareHistory(payload, NOV13_TOOLS, OFF).payload, payload);
  assert.equal(H.prepareHistory(payload, NOV13_TOOLS, OFF).line, '');

  const throwing = [
    user('q'),
    {
      role: 'assistant',
      get content() {
        throw new Error('boom');
      },
    },
  ];
  assert.equal(H.dropUnattachedToolCalls(throwing, new Set(), ON), throwing);
  assert.equal(H.prepareHistory(throwing, new Set(), ON).payload, throwing);
  /* a tool set that is no set: the formatter itself would throw on it; here the history is handed on */
  assert.equal(H.dropUnattachedToolCalls(payload, 5, ON), payload);
  assert.equal(H.dropUnattachedToolCalls(payload, {}, ON), payload);
  for (const notAPayload of [null, undefined, 'text', 5, {}]) {
    assert.equal(H.dropUnattachedToolCalls(notAPayload, new Set(), ON), notAPayload);
    assert.equal(H.prepareHistory(notAPayload, new Set(), ON).payload, notAPayload);
  }
  assert.deepEqual(H.dropUnattachedToolCalls([], new Set(), ON), []);
});

test('200,000 characters of history: the drop is fast, and so is a search result with no closing brace', () => {
  const big = 'x'.repeat(200000);
  const payload = [
    user(big),
    asst(think(big), call('c1', 'web_search', big), text(big + '\nTool: web_search, ' + big)),
    asst(
      call('s1', 'tool_search', '{'.repeat(200000)),
      call('s2', 'tool_search', 'warning ' + '{"a":'.repeat(40000)),
      text('Done.'),
    ),
    asst(
      ...Array.from({ length: 2000 }, (_, i) =>
        call(`m${i}`, i % 2 ? 'web_search' : 'kade_weather', 'short'),
      ),
    ),
    user('q'),
  ];
  let out;
  const ms = timed(() => {
    out = H.prepareHistory(payload, new Set(['kade_weather', 'tool_search']), ON);
  });
  assert.ok(ms < FAST_MS, `${ms.toFixed(1)} ms`);
  assert.equal(out.dropped, 1001);
  assert.equal(out.stripped, 1);
  assert.equal(out.payload[1].content[1].text, big);
  assert.equal(out.payload[3].content.length, 1000);
});

/* ------------------------------------------------------------------ prepareHistory (what the call sites run) */

test('prepareHistory: drop, then strip, and one log line with counts and tool names only', () => {
  const secret = 'ORCHID-MARKER-5521 the person banks at Example Savings';
  const payload = deepFreeze([
    user(`Something private: ${secret}`),
    asst(
      think('Search.'),
      call('c1', 'web_search', `=== Web Results ===\n${secret}`),
      text(`An answer about ${secret}.`),
    ),
    user('More?'),
    asst(call('c2', 'web_search', SEARCH_OUTPUT), text(`${NOV13_REPLY}\n${NOV13_ECHO}`)),
    user('Tool: web_search, this line was typed by the person and must stay'),
  ]);
  const before = JSON.stringify(payload);
  const out = H.prepareHistory(payload, NOV13_TOOLS, ON);
  assert.equal(
    out.line,
    '[kadeHistoryTools] dropped 2 past tool call(s) not on hand this turn (web_search); stripped 1 echoed tool line.',
  );
  assert.equal(out.dropped, 2);
  assert.deepEqual(out.droppedNames, ['web_search']);
  assert.equal(out.stripped, 1);
  assert.equal(out.line.includes('ORCHID'), false, 'never any text in the log line');
  assert.equal(JSON.stringify(payload), before, 'the input is as it was');
  assert.equal(out.payload[3].content.at(-1).text, NOV13_REPLY);
  assert.equal(out.payload[4], payload[4], "the person's own message is the very same object");
  assert.equal(out.payload[4].content.startsWith('Tool: web_search, '), true);
  assert.equal(out.payload[0], payload[0]);
});

test('prepareHistory: only a drop, only a strip, and nothing at all', () => {
  const dropOnly = H.prepareHistory(deepFreeze(nov13Payload()), NOV13_TOOLS, ON);
  assert.equal(
    dropOnly.line,
    '[kadeHistoryTools] dropped 2 past tool call(s) not on hand this turn (web_search).',
  );

  const echoes = deepFreeze([
    user('q'),
    asst(text(`First.\n${NOV13_ECHO}`), text('Second.\nTool: flux, made up')),
    { role: 'assistant', content: 'A string reply.\nTool: kade_news, made up' },
    user('q2'),
  ]);
  const stripOnly = H.prepareHistory(echoes, NOV13_TOOLS, ON);
  assert.equal(stripOnly.line, '[kadeHistoryTools] stripped 3 echoed tool lines.');
  assert.deepEqual(stripOnly.payload[1].content, [text('First.'), text('Second.')]);
  assert.equal(stripOnly.payload[2].content, 'A string reply.');
  assert.equal(
    echoes[2].content,
    'A string reply.\nTool: kade_news, made up',
    'the stored message still has it',
  );

  const clean = deepFreeze([
    user('q'),
    asst(text('Checking.', ['c1']), call('c1', 'kade_weather'), text('Sunny.')),
    user('q2'),
  ]);
  const nothing = H.prepareHistory(clean, NOV13_TOOLS, ON);
  assert.equal(nothing.payload, clean, 'the very same payload');
  assert.deepEqual(
    { ...nothing, payload: null },
    { payload: null, dropped: 0, droppedNames: [], stripped: 0, line: '' },
  );
});

test('prepareHistory: with no tool set the echo is still stripped, and a used tool name counts as known', () => {
  const payload = deepFreeze([
    user('q'),
    asst(call('c1', 'calculator', '4'), text('Four.')),
    user('q2'),
    asst(text('Five.\nTool: calculator, 5')),
    user('q3'),
  ]);
  const out = H.prepareHistory(payload, undefined, ON);
  assert.equal(out.dropped, 0);
  assert.equal(out.stripped, 1);
  assert.equal(out.payload[1], payload[1], 'no filtering without a tool set');
  assert.deepEqual(out.payload[3].content, [text('Five.')]);
});

test('prepareHistory: a reply that is only an echo ends with no words, and a pointer on it goes', () => {
  const payload = deepFreeze([
    user('q'),
    asst(text('Tool: kade_research, made up', ['gone'])),
    user('q2'),
  ]);
  const out = H.prepareHistory(payload, NOV13_TOOLS, ON);
  assert.deepEqual(out.payload[1].content, [{ type: 'text', text: '' }]);
  /* a pointer at a call that is still there stays */
  const live = deepFreeze([
    user('q'),
    asst(text('Tool: kade_research, made up', ['c1']), call('c1', 'kade_weather')),
    user('q2'),
  ]);
  assert.deepEqual(H.prepareHistory(live, NOV13_TOOLS, ON).payload[1].content[0], {
    type: 'text',
    text: '',
    tool_call_ids: ['c1'],
  });
});

test('prepareHistory: a strange tool name is counted, not printed', () => {
  const odd = 'a name with spaces and "quotes" in it';
  const names = Array.from({ length: 12 }, (_, i) => `tool_number_${i}`);
  const payload = deepFreeze([
    user('q'),
    asst(
      call('c0', odd),
      call('c00', 'x'.repeat(80)),
      ...names.map((name, i) => call(`c${i + 1}`, name)),
      text('Reply.'),
    ),
  ]);
  const out = H.prepareHistory(payload, new Set(), ON);
  assert.equal(out.dropped, 14);
  assert.equal(out.line.includes('quotes'), false);
  assert.equal(out.line.includes('xxxx'), false);
  assert.match(out.line, /\(tool_number_0, tool_number_1, .*tool_number_7, 6 other\)\.$/);
  assert.equal(H.loggableName('kade_research'), 'kade_research');
  assert.equal(H.loggableName(odd), 'other');
  assert.equal(H.loggableName(undefined), 'other');
});

/* ------------------------------------------------------------------ cutReplyEcho (the saved reply) */

const reply = (...parts) => ({ messageId: 'm1', isCreatedByUser: false, text: '', content: parts });

test('the saved reply: the Nov 13 message is saved without its echo', () => {
  const message = deepFreeze(
    reply(think('She asked about selling it.'), text(`${NOV13_REPLY}\n${NOV13_ECHO}`)),
  );
  const out = H.cutReplyEcho(message, ON);
  assert.equal(out.name, 'kade_research');
  assert.notEqual(out.message, message);
  assert.deepEqual(out.message.content, [think('She asked about selling it.'), text(NOV13_REPLY)]);
  assert.equal(out.message.content[0], message.content[0]);
  assert.equal(
    message.content[1].text.includes('Tool: kade_research'),
    true,
    'the message handed in is as it was',
  );
});

test('the saved reply: every text part, never the person, never down to nothing', () => {
  const same = (message, label) => {
    const out = H.cutReplyEcho(message, ON);
    assert.equal(out.message, message, label);
    assert.equal(out.name, '', label);
  };
  same(deepFreeze(reply(text('A reply with no echo.'))), 'nothing to cut');
  /* Nov 13 review: an echo in an earlier part is cut too, to the end of that part only */
  const earlier = deepFreeze(
    reply(text('First.\nTool: flux, made up'), text('The last part is clean.')),
  );
  const cutEarlier = H.cutReplyEcho(earlier, ON);
  assert.equal(cutEarlier.name, 'flux');
  assert.deepEqual(
    cutEarlier.message.content.map((part) => part.text),
    ['First.', 'The last part is clean.'],
  );
  assert.equal(cutEarlier.message.content[1], earlier.content[1]);
  same(
    deepFreeze(reply(text('Tool: kade_research, made up'))),
    'a reply that is only an echo is left as it is',
  );
  same(
    deepFreeze(reply(think('Hm.'), text('  '), text('Tool: kade_research, made up'))),
    'no words anywhere else',
  );
  same(
    deepFreeze({ ...reply(text('Hi.\nTool: flux, made up')), isCreatedByUser: true }),
    'a message the person wrote',
  );
  same(
    deepFreeze({ role: 'assistant', content: [text('Hi.\nTool: flux, made up')] }),
    'not marked as a reply',
  );
  same(deepFreeze(reply(call('c1', 'web_search'))), 'no text part');
  same(deepFreeze(reply()), 'no parts');
  for (const value of [null, undefined, 'text', 5]) same(value, String(value));

  /* an echo that is the whole last part goes when an earlier part has the words */
  const two = deepFreeze(
    reply(text('The answer.'), call('c1', 'kade_weather'), text('Tool: kade_weather, made up')),
  );
  const out = H.cutReplyEcho(two, ON);
  assert.equal(out.name, 'kade_weather');
  assert.deepEqual(
    out.message.content.map((part) => part.text),
    ['The answer.', undefined, ''],
  );
});

test('the saved reply: a tool the reply really called is no reason to cut for good, and `text` is read when there are no parts', () => {
  /* Nov 13 review: the cut on the way out takes only the platform's names and kade_ names.
   * "calculator" is a name the reply called, so the history pass still keeps the line from the
   * model; the saved copy keeps it. */
  const called = deepFreeze(
    reply(call('c1', 'calculator', '4'), text('Four.\nTool: calculator, 4')),
  );
  assert.equal(H.cutReplyEcho(called, ON).message, called);
  const history = [user('q'), { ...called, role: 'assistant' }, user('q2')];
  assert.equal(H.prepareHistory(history, undefined, ON).payload[1].content[1].text, 'Four.');
  const plain = deepFreeze({ isCreatedByUser: false, text: 'Four.\n\nTool: web_search, made up' });
  assert.deepEqual(H.cutReplyEcho(plain, ON), {
    message: {
      isCreatedByUser: false,
      text: 'Four.',
      metadata: { kadeToolEcho: { tool: 'web_search', chars: 27, parts: 1 } },
    },
    name: 'web_search',
    chars: 27,
  });
  const onlyEcho = deepFreeze({ isCreatedByUser: false, text: 'Tool: web_search, made up' });
  assert.equal(H.cutReplyEcho(onlyEcho, ON).message, onlyEcho);
});

test('the saved reply: both switches', () => {
  const message = deepFreeze(reply(text(`${NOV13_REPLY}\n${NOV13_ECHO}`)));
  assert.equal(H.cutReplyEcho(message, OFF).message, message);
  assert.equal(H.cutReplyEcho(message, { KADE_REPLY_TOOL_ECHO: '0' }).message, message);
  assert.equal(H.replyCutOn(ON), true);
  assert.equal(H.replyCutOn(OFF), false);
  assert.equal(H.replyCutOn({ KADE_REPLY_TOOL_ECHO: '0' }), false);
  /* the history side does not listen to the reply switch */
  assert.equal(
    H.stripToolEcho('Hi.\nTool: flux, made up', null, { KADE_REPLY_TOOL_ECHO: '0' }),
    'Hi.',
  );
});

test('the final frame: scrubMessageForTransmit sends the reply without its echo, and leaves the person alone', () => {
  const { scrubMessageForTransmit } = require('../utils/stripAiTells');
  const message = deepFreeze(reply(think('Hm.'), text(`${NOV13_REPLY}\n${NOV13_ECHO}`)));
  const sent = scrubMessageForTransmit(message);
  assert.equal(sent.content[1].text, NOV13_REPLY);
  assert.equal(message.content[1].text.includes('Tool: kade_research'), true);
  const typed = deepFreeze({
    isCreatedByUser: true,
    text: 'Tool: web_search, typed by the person',
    content: [text('Tool: web_search, typed by the person')],
  });
  assert.equal(scrubMessageForTransmit(typed), typed);
  const clean = reply(text('The bus leaves at six.'));
  assert.deepEqual(scrubMessageForTransmit(clean), clean);
});

/* ------------------------------------------------------------------ the Nov 13 review */

/* Finding 1: the voice proxy (inworld-tts-proxy/tool-echo.js) passes over voice directions in
 * front of "Tool:" and treats a carriage return, U+2028 and U+2029 as line starts; the website
 * did neither, so "%%%calm%%% Tool: kade_research, ..." was cut by the voice and kept here. */

test('review 1: voice directions in front of the echo are passed over, and the cut starts at the line start', () => {
  const cases = [
    ['Said it.\n%%%calm%%% Tool: kade_research, === Deep Research Context ===', 'Said it.', 9],
    ['Said it.\n%%%calm%%%Tool: kade_research, made up', 'Said it.', 9],
    ['Said it.\n%%%warm%%%\t%%%slow%%%  Tool: web_search, made up', 'Said it.', 9],
    ['Said it.\n%%%%%% Tool: flux, an empty direction', 'Said it.', 9],
    ['%%%calm%%% Tool: kade_research, the whole text', '', 0],
  ];
  for (const [input, kept, index] of cases) {
    assert.equal(H.stripToolEcho(input, null, ON), kept, JSON.stringify(input));
    assert.equal(H.findToolEcho(input).index, index, JSON.stringify(input));
  }
  /* in the history the model reads, and in the saved reply */
  const history = deepFreeze([
    user('q'),
    asst(text('Here you go.\n%%%calm%%% Tool: kade_research, made up')),
    user('q2'),
  ]);
  assert.deepEqual(H.prepareHistory(history, null, ON).payload[1].content, [text('Here you go.')]);
  const saved = H.cutReplyEcho(
    deepFreeze(reply(text('Here you go.\n%%%calm%%% Tool: kade_research, made up'))),
    ON,
  );
  assert.equal(saved.name, 'kade_research');
  assert.equal(saved.message.content[0].text, 'Here you go.');
});

test('review 1: a carriage return, U+2028 and U+2029 start a line, as they do for the voice proxy', () => {
  for (const breakChar of ['\r', ' ', ' ', '\r\n', '\n']) {
    const input = `Said it.${breakChar}Tool: kade_research, made up`;
    assert.equal(H.stripToolEcho(input, null, ON), 'Said it.', JSON.stringify(breakChar));
    assert.equal(H.findToolEcho(input).index, input.indexOf('Tool:'), JSON.stringify(breakChar));
    const saved = H.cutReplyEcho(deepFreeze(reply(text(input))), ON);
    assert.equal(saved.message.content[0].text, 'Said it.', JSON.stringify(breakChar));
  }
  /* a name stops at any of them: no comma on the line, no echo */
  for (const breakChar of ['\r', ' ', ' ']) {
    assert.equal(H.findToolEcho(`Tool: kade_research${breakChar}, made up`), null);
  }
  /* and any of them right after the comma counts, as a blank does */
  for (const after of ['\r', ' ', ' ', '\t', ' ']) {
    assert.equal(
      H.stripToolEcho(`Hi.\nTool: kade_research,${after}made up`, null, ON),
      'Hi.',
      JSON.stringify(after),
    );
  }
});

test('review 1: what may stand in front of "Tool:" is bounded, and only a voice direction opens it', () => {
  const never = [
    'Said it.\n Tool: kade_research, blanks with no direction',
    'Said it.\n\tTool: kade_research, a tab with no direction',
    'Said it.\n%%%calm Tool: kade_research, a direction never closed',
    'Said it.\n%%%calm\n%%% Tool: kade_research, a direction across a line break',
    'Said it.\n%% Tool: kade_research, two marks are no direction',
    'Said it.\nwords %%%calm%%% Tool: kade_research, words in front',
    `Said it.\n%%%${'x'.repeat(240)}%%% Tool: kade_research, a direction too long`,
    `Said it.\n%%%a%%%${' '.repeat(240)}Tool: kade_research, too many blanks`,
    `Said it.\n${'%%%a%%% '.repeat(40)}Tool: kade_research, too many directions`,
  ];
  for (const input of never) {
    assert.equal(H.findToolEcho(input), null, JSON.stringify(input.slice(0, 50)));
    assert.equal(H.stripToolEcho(input, null, ON), input);
  }
  /* just inside the bound */
  assert.equal(
    H.stripToolEcho(`Said it.\n%%%${'x'.repeat(230)}%%% Tool: kade_research, made up`, null, ON),
    'Said it.',
  );
  assert.equal(H.LEAD_MAX, 240);
});

test('review 1: 200,000 characters of directions and line starts keep the scan linear', () => {
  const n = 200000;
  const fill = (unit) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const cases = {
    'a direction just inside the bound on every line, then no comma': fill(
      '%%%' + 'x'.repeat(233) + '%%% Tool: a\n',
    ),
    'a direction never closed on every line': fill('%%%' + 'x'.repeat(300) + '\n'),
    'nothing but percent signs': '%'.repeat(n),
    'directions all along one line': fill('%%%a%%% '),
    'a direction, then the mark, then no comma, over and over': fill('%%%a%%% Tool: kade_x '),
    'a carriage return before every mark': fill('\rTool: kade_x'),
    'U+2028 before every mark': fill(' Tool: a'),
    'line starts and nothing else': fill('\r\n  '),
  };
  for (const [label, input] of Object.entries(cases)) {
    let out;
    let saved;
    const ms = timed(() => {
      out = H.stripToolEcho(input, null, ON);
      saved = H.cutReplyEcho(reply(text(input)), ON);
    });
    assert.ok(ms < FAST_MS, `${label}: ${ms.toFixed(1)} ms`);
    assert.equal(out, input, label);
    assert.equal(saved.name, '', label);
  }
  const late = fill('%%%a%%% ') + '\nSaid it.\n%%%calm%%% Tool: kade_research, made up';
  const ms = timed(() => assert.equal(H.stripToolEcho(late, null, ON).endsWith('Said it.'), true));
  assert.ok(ms < FAST_MS, `a real echo after them: ${ms.toFixed(1)} ms`);
});

/* Finding 2: only the last text part was cut on the way out, so a made-up line in a lead-in,
 * with a real call and the real answer after it, was saved; the voice later cut from that line
 * to the end of the whole text and the answer went unspoken. */

test('review 2: a made-up line in a lead-in is cut to the end of that part, and the answer after the real call stays', () => {
  const { messageBodyText } = require('../utils/kadeReadableText');
  const lead =
    'Let me look into it.\nTool: kade_research, === Deep Research Context ===\nSomeone asked: made up';
  const message = deepFreeze(
    reply(
      text(lead, ['c1']),
      call('c1', 'kade_research', 'the real result'),
      text('Here is the real answer, after the real call.'),
    ),
  );
  /* before: what a read-aloud is sent has the line ahead of the answer, and the voice cuts there */
  const before = messageBodyText(message);
  assert.ok(before.indexOf('Tool: kade_research') < before.indexOf('Here is the real answer'));
  const out = H.cutReplyEcho(message, ON);
  assert.equal(out.name, 'kade_research');
  assert.deepEqual(out.message.content[0], text('Let me look into it.', ['c1']));
  assert.equal(out.message.content[1], message.content[1], 'the real call is the very same part');
  assert.equal(out.message.content[2], message.content[2], 'the answer is the very same part');
  assert.equal(
    messageBodyText(out.message),
    'Let me look into it.\n\nHere is the real answer, after the real call.',
  );
  assert.equal(H.findToolEcho(messageBodyText(out.message)), null);
});

test('review 2: every part with an echo is cut, each to its own end; never to no words; never the person', () => {
  const first = 'First.\nTool: flux, made up';
  const second = 'Second.\n%%%calm%%% Tool: web_search, made up\nmore made up';
  const message = deepFreeze(
    reply(text(first), call('c1', 'kade_weather'), text(second), text('Third, and clean.')),
  );
  const out = H.cutReplyEcho(message, ON);
  assert.equal(out.name, 'flux');
  assert.deepEqual(
    out.message.content.map((part) => part.text),
    ['First.', undefined, 'Second.', 'Third, and clean.'],
  );
  assert.equal(out.chars, first.length - 'First.'.length + second.length - 'Second.'.length);
  assert.deepEqual(out.message.metadata.kadeToolEcho, { tool: 'flux', chars: out.chars, parts: 2 });
  /* every part an echo, a call between: nothing would be left to say, so nothing is cut */
  const all = deepFreeze(
    reply(
      text('Tool: kade_research, made up', ['c1']),
      call('c1', 'kade_research'),
      text('Tool: kade_research, made up too'),
    ),
  );
  assert.equal(H.cutReplyEcho(all, ON).message, all);
  /* the person's own words are never cut, in any part */
  const typed = deepFreeze({
    isCreatedByUser: true,
    content: [text('Hi.\nTool: kade_research, typed'), text('More.\nTool: flux, typed')],
  });
  assert.equal(H.cutReplyEcho(typed, ON).message, typed);
});

/* Finding 3: the real formatter put an empty text block into an assistant message (43 of 50,000
 * realistic made-up histories): a lead-in with no words beside a picture, once an earlier
 * lead-in lost its pointer or its words. Providers turn those away. The same checks against the
 * real formatter are in kadeHistoryTools.reallib.nodetest.js. */

const imageFile = { type: 'image_file', image_file: { file_id: 'f1', filepath: '/made-up.png' } };

test('review 3: every lead-in with no words beside a waiting picture loses its pointer (fuzz seed 2470)', () => {
  const tools = new Set(['kade_weather', 'kade_notify', 'skill', 'flux']);
  const payload = deepFreeze([
    user('q'),
    asst(
      text('Lead.', ['c7', 'c8', 'c9']),
      call('c7', 'skill'),
      call('c8', 'flux'),
      imageFile,
      call('c9', 'kade_research'),
      text('Tool: kade_research, made up', ['c10', 'c11', 'c12']),
      call('c10', 'kade_news'),
      call('c11', 'flux'),
      call('c12', 'kade_notify'),
      think('Hm.'),
      text('', ['c13', 'c14']),
      call('c13', 'kade_research'),
      call('c14', 'skill'),
      text('The answer.'),
    ),
    user('q2'),
  ]);
  assert.deepEqual(H.prepareHistory(payload, tools, ON).payload[1].content, [
    text('Lead.', ['c7', 'c8']),
    call('c7', 'skill'),
    call('c8', 'flux'),
    imageFile,
    /* emptied by the echo strip, the picture still waiting: no pointer */
    { type: 'text', text: '' },
    call('c11', 'flux'),
    call('c12', 'kade_notify'),
    think('Hm.'),
    /* not cut and not the last text part, but the picture is still waiting here too */
    { type: 'text', text: '' },
    call('c14', 'skill'),
    text('The answer.'),
  ]);
});

test('review 3: a server tool result waiting counts as content that is not text (fuzz seed 107)', () => {
  const result = {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_c10',
    content: [{ type: 'web_search_result', url: 'https://example.test/made-up', title: 'Made up' }],
  };
  const payload = deepFreeze([
    user('q'),
    asst(text('Words.'), text('', ['c9']), call('c9', 'other_mcp_y'), result, text('', ['c12'])),
    user('q2'),
  ]);
  assert.deepEqual(H.dropUnattachedToolCalls(payload, new Set(['kade_weather']), ON)[1].content, [
    text('Words.'),
    { type: 'text', text: '' },
    result,
    { type: 'text', text: '' },
  ]);
  /* a server answer the formatter leaves out holds nothing back: the words are still waiting,
   * so the pointer stays and the formatter closes them into a message there */
  const skipped = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_c10', content: 'no' };
  const words = deepFreeze([
    user('q'),
    asst(text('Words.'), call('c9', 'other_mcp_y'), skipped, text('', ['c12'])),
    user('q2'),
  ]);
  assert.deepEqual(H.dropUnattachedToolCalls(words, new Set(['kade_weather']), ON)[1].content, [
    text('Words.'),
    skipped,
    text('', ['c12']),
  ]);
});

test('review 3: a lead-in with no words after words the echo strip took away opens no empty message (fuzz seed 510)', () => {
  const payload = deepFreeze([
    user('q'),
    asst(text('Tool: kade_research, made up', ['c3']), text('', ['c6', 'c7']), text('The answer.')),
    user('q2'),
  ]);
  assert.deepEqual(H.prepareHistory(payload, new Set(), ON).payload[1].content, [
    { type: 'text', text: '' },
    { type: 'text', text: '' },
    text('The answer.'),
  ]);
});

test('review 3: the pointers the formatter takes away itself are read as it reads them', () => {
  const tools = new Set(['kade_weather']);
  /* "m1" belongs to a call with no name: the formatter drops it and takes "m1" out of every
   * pointer, so "Words." is plain words to it and the picture is still waiting at the lead-in
   * after it */
  const noName = { type: 'tool_call', tool_call: { id: 'm1', output: 'x' } };
  const waiting = deepFreeze([
    user('q'),
    asst(
      imageFile,
      text('Words.', ['m1']),
      noName,
      call('c1', 'web_search'),
      text('', ['c5']),
      call('c5', 'kade_weather'),
    ),
    user('q2'),
  ]);
  assert.deepEqual(H.dropUnattachedToolCalls(waiting, tools, ON)[1].content, [
    imageFile,
    text('Words.', ['m1']),
    noName,
    { type: 'text', text: '' },
    call('c5', 'kade_weather'),
  ]);
  /* a handoff to an agent that is not attached: the formatter writes its line into the last
   * text part, so that part has words and keeps what it points at */
  const handoff = call('h1', 'lc_transfer_to_agent_x', 'the other agent said hello');
  const handed = deepFreeze([
    user('q'),
    asst(text('', ['h1', 'c1']), handoff, call('c1', 'web_search')),
    user('q2'),
  ]);
  assert.deepEqual(H.dropUnattachedToolCalls(handed, tools, ON)[1].content, [
    text('', ['h1']),
    handoff,
  ]);
});

test('review 3: a lead-in with no words stays when a call that stays is hung on it, and only then', () => {
  const tools = new Set(['kade_weather']);
  const carried = deepFreeze([
    user('q'),
    asst(
      call('c0', 'web_search'),
      text('', ['c5']),
      think('Hm.'),
      text('Aside.'),
      call('c5', 'kade_weather'),
    ),
    user('q2'),
  ]);
  assert.deepEqual(H.dropUnattachedToolCalls(carried, tools, ON)[1].content, [
    text('', ['c5']),
    think('Hm.'),
    text('Aside.'),
    call('c5', 'kade_weather'),
  ]);
  /* a provider-run call is held apart by Anthropic, never hung there: not a reason to stay */
  const server = deepFreeze([
    user('q'),
    asst(call('c0', 'web_search'), text('', ['x']), call('srvtoolu_1', 'kade_weather')),
    user('q2'),
  ]);
  assert.deepEqual(H.dropUnattachedToolCalls(server, tools, ON)[1].content, [
    { type: 'text', text: '' },
    call('srvtoolu_1', 'kade_weather'),
  ]);
  /* of two parts with one id Anthropic hangs the one with a result: the first one here is not it */
  const twice = deepFreeze([
    user('q'),
    asst(
      call('c0', 'web_search'),
      text('', ['x']),
      call('c5', 'kade_weather', ''),
      text('Next.', ['c6']),
      call('c5', 'kade_weather', 'the result'),
    ),
    user('q2'),
  ]);
  assert.deepEqual(H.dropUnattachedToolCalls(twice, tools, ON)[1].content[0], {
    type: 'text',
    text: '',
  });
});

/* Finding 4: the cut on the way out is for good, so it takes only the platform's tool names and
 * kade_ names, and it leaves a note in the saved message's metadata so a wrong cut can be found. */

test('review 4: the saved reply keeps a line that only looks like a tool echo; the model still does not read it', () => {
  const lines = [
    'Here is how I keep notes.\nTool: lookup_mcp_x, the lookup server I use',
    'Your helpers:\nTool: snake_case_name, a helper you wrote',
    'Four.\nTool: calculator, 4',
    'Odd one.\nTool: kade_web-fetch, a name with a hyphen',
  ];
  for (const words of lines) {
    const message = deepFreeze(reply(call('c1', 'calculator', '4'), text(words)));
    const out = H.cutReplyEcho(message, ON);
    assert.equal(out.message, message, words);
    assert.equal(out.name, '', words);
    const history = deepFreeze([user('q'), { ...message, role: 'assistant' }, user('q2')]);
    assert.equal(H.prepareHistory(history, undefined, ON).stripped, 1, words);
  }
  for (const name of [...H.PLATFORM_TOOL_NAMES, 'kade_research', 'kade_weather', 'kade_new_tool']) {
    const out = H.cutReplyEcho(deepFreeze(reply(text(`Words.\nTool: ${name}, made up`))), ON);
    assert.equal(out.name, name);
    assert.equal(out.message.content[0].text, 'Words.');
    assert.deepEqual(H.findReplyEcho(`Words.\nTool: ${name}, made up`), { index: 7, name });
  }
  assert.equal(H.findReplyEcho('Words.\nTool: lookup_mcp_x, made up'), null);
});

test('review 4: the cut leaves a note in the metadata, the tool and the count, never the words', () => {
  const echo = 'Tool: kade_research, ORCHID-MARKER-5521 === Deep Research Context ===';
  const message = deepFreeze({
    ...reply(text(`Answer.\n${echo}`)),
    metadata: { usage: { output_tokens: 7 } },
  });
  const out = H.cutReplyEcho(message, ON);
  assert.equal(out.chars, echo.length + 1);
  assert.deepEqual(out.message.metadata, {
    usage: { output_tokens: 7 },
    kadeToolEcho: { tool: 'kade_research', chars: echo.length + 1, parts: 1 },
  });
  assert.equal(JSON.stringify(out.message.metadata).includes('ORCHID'), false);
  assert.equal(JSON.stringify(out.message.metadata).includes('Deep Research'), false);
  assert.deepEqual(
    message.metadata,
    { usage: { output_tokens: 7 } },
    'the message handed in is as it was',
  );
  /* no metadata yet: a note is made */
  const bare = H.cutReplyEcho(deepFreeze(reply(text(`Answer.\n${echo}`))), ON);
  assert.deepEqual(bare.message.metadata, {
    kadeToolEcho: { tool: 'kade_research', chars: echo.length + 1, parts: 1 },
  });
  /* metadata that is not an object is left as it is */
  const odd = H.cutReplyEcho(deepFreeze({ ...reply(text(`Answer.\n${echo}`)), metadata: 'x' }), ON);
  assert.equal(odd.message.metadata, 'x');
  assert.equal(odd.message.content[0].text, 'Answer.');
  /* nothing cut: no note */
  const clean = deepFreeze(reply(text('Answer.')));
  assert.equal(H.cutReplyEcho(clean, ON).message, clean);
  /* the final frame carries the same note */
  const { scrubMessageForTransmit } = require('../utils/stripAiTells');
  assert.deepEqual(scrubMessageForTransmit(message).metadata.kadeToolEcho, {
    tool: 'kade_research',
    chars: echo.length + 1,
    parts: 1,
  });
});

/* ------------------------------------------------------------------ the wiring */

const read = (...segments) =>
  fs.readFileSync(path.join(__dirname, ...segments), 'utf8').replace(/\r\n/g, '\n');
const CONTROLLERS = ['client.js', 'openai.js', 'responses.js'];

test('every place that formats chat history for a model hands it the prepared history', () => {
  let calls = 0;
  for (const name of CONTROLLERS) {
    const source = read('..', 'controllers', 'agents', name);
    let at = source.indexOf('formatAgentMessages(');
    while (at !== -1) {
      calls += 1;
      const firstArgument = source.slice(at + 'formatAgentMessages('.length).trimStart();
      assert.ok(
        firstArgument.startsWith('kadeHistoryForModel(') ||
          firstArgument.startsWith('kadeHistory,'),
        `${name}: formatAgentMessages is called on a history that was not prepared: ${firstArgument.slice(0, 40)}`,
      );
      at = source.indexOf('formatAgentMessages(', at + 1);
    }
    assert.ok(
      source.includes("require('~/server/services/kadeHistoryTools').prepareHistory("),
      `${name}: prepareHistory`,
    );
  }
  assert.equal(
    calls,
    4,
    'the main reply, the memory keeper, the OpenAI-compatible route and the Responses route',
  );

  const client = read('..', 'controllers', 'agents', 'client.js');
  assert.ok(
    client.includes('kadeHistoryForModel(payload, toolSet, true),'),
    'the reply logs the one line',
  );
  assert.ok(
    client.includes('kadeHistoryForModel(memoryEvidence, toolSet, false),'),
    'the keeper does not log a second one',
  );
  assert.ok(
    read('..', 'controllers', 'agents', 'openai.js').includes(
      'prepareHistory(\n        openaiMessages,\n        toolSet,',
    ),
  );
  assert.ok(
    read('..', 'controllers', 'agents', 'responses.js').includes(
      'prepareHistory(\n        allMessages,\n        toolSet,',
    ),
  );
});

test('the saved reply, the final frame and a stopped reply all take the echo cut', () => {
  const base = read('..', '..', 'app', 'clients', 'BaseClient.js');
  const save = base.slice(
    base.indexOf('async saveMessageToDatabase('),
    base.indexOf('const savedMessage = await db.saveMessage('),
  );
  assert.ok(
    save.includes('kadeHistoryTools.cutReplyEcho(scrubbed)'),
    'BaseClient.saveMessageToDatabase',
  );
  assert.ok(
    save.indexOf('stripAiTells(part.text)') < save.indexOf('cutReplyEcho(scrubbed)'),
    'after the tell scrub, on its result',
  );
  const tells = read('..', 'utils', 'stripAiTells.js');
  assert.ok(
    tells.includes("require('../services/kadeHistoryTools').cutReplyEcho(message).message"),
    'stripAiTells.js',
  );
  assert.ok(tells.includes('return cutToolEcho(out);'), 'scrubMessageForTransmit');
  /* Nov 13 review: a stopped reply's plain text field is cut too, before the save and the frame
   * (abortMiddleware.spec.js runs it against the real parseTextParts) */
  const abort = read('..', 'middleware', 'abortMiddleware.js');
  assert.ok(
    abort.includes("require('~/server/services/kadeHistoryTools').cutReplyEcho(message)"),
    'abortMiddleware.js',
  );
  assert.ok(
    abort.includes('text: parseTextParts(cut.message.content)'),
    'the text field is joined again',
  );
  const stop = abort.slice(abort.indexOf('async function abortMessage('));
  assert.ok(
    stop.indexOf('const stoppedMessage = cutStoppedReplyEcho(responseMessage);') <
      stop.indexOf('await db.saveMessage('),
    'cut before the save',
  );
  assert.ok(
    stop.includes('{ ...scrubMessageForTransmit(stoppedMessage), user: userId }'),
    'the save',
  );
  assert.ok(
    stop.includes('responseMessage: scrubMessageForTransmit(stoppedMessage),'),
    'the frame',
  );
  assert.equal(stop.includes('scrubMessageForTransmit(responseMessage)'), false);
});
