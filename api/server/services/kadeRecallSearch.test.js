/* Nov 11 2026 (card 9): search your own past chats. Plain node:test, no model, no network, no database:
 *   node --test api/server/services/kadeRecallSearch.test.js
 * Meili and the database are stand-ins. Every person, number and line here is made up. */
const test = require('node:test');
const assert = require('node:assert/strict');

const R = require('./kadeRecallSearch');
const lanes = require('./kadeLaneTrustAdapter');

const A = '64a000000000000000000001';
const B = '64b000000000000000000002';
const AGENT = 'agent_harley';

/* ── masking ──────────────────────────────────────────────────────────── */

test('card, bank, social security and code-like numbers are masked; phone numbers, money, years and times are kept', () => {
  const m = R.maskNumbers;
  assert.equal(m('my card is 4111 1111 1111 1234 ok'), 'my card is [card number hidden, ends 1234] ok');
  assert.equal(m('card 4111-1111-1111-1234'), 'card [card number hidden, ends 1234]');
  assert.equal(m('4111111111111234'), '[card number hidden, ends 1234]');
  assert.equal(m('ssn 123-45-6789'), 'ssn [number hidden]');
  assert.equal(m('routing 021000021 account 123456789012'), 'routing [number hidden] account [number hidden]');
  assert.equal(m('the code is 482913'), 'the code is [code hidden]');
  assert.equal(m('PIN: 4821'), 'PIN: [code hidden]');
  assert.equal(m('verification code 0042'), 'verification code [code hidden]');
  assert.equal(m('just 739104 by itself'), 'just [code hidden] by itself');
  /* kept */
  assert.equal(m('the pharmacy is (417) 555-0142'), 'the pharmacy is (417) 555-0142');
  assert.equal(m('call 417-555-0142 or 1-417-555-0199'), 'call 417-555-0142 or 1-417-555-0199');
  assert.equal(m('call 417.555.0142'), 'call 417.555.0142');
  assert.equal(m('it was $1,250.00 in 2024 at 10:30'), 'it was $1,250.00 in 2024 at 10:30');
  assert.equal(m('zip 65804, room 12, born 1958'), 'zip 65804, room 12, born 1958');
  assert.equal(m('on 11/19/2026'), 'on 11/19/2026');
});

test('a snippet is cut around the words asked for, cleaned of voice wrappers and directions, and masked', () => {
  const long = 'x '.repeat(200) + 'The pharmacy number is (417) 555-0142 and my card is 4111 1111 1111 1234. ' + 'y '.repeat(200);
  const s = R.snippetOf(long, 'pharmacy number');
  assert.match(s, /pharmacy number is \(417\) 555-0142/);
  assert.match(s, /\[card number hidden, ends 1234\]/);
  assert.ok(s.length <= 260);
  assert.equal(R.snippetOf('%%%warm%%% Sure thing, the clinic opens at 8.', 'clinic'), 'Sure thing, the clinic opens at 8.');
});

/* ── the search ───────────────────────────────────────────────────────── */

function store() {
  const rows = [
    { messageId: 'a1', conversationId: 'cA1', user: A, isCreatedByUser: true, text: 'The pharmacy number is (417) 555-0142, MARKER-ALPHA.', createdAt: new Date('2026-11-04T15:00:00Z') },
    { messageId: 'a2', conversationId: 'cA1', user: A, isCreatedByUser: false, content: [{ type: 'text', text: 'Got it, the pharmacy is (417) 555-0142. MARKER-ALPHA' }], createdAt: new Date('2026-11-04T15:01:00Z') },
    /* a reply that read a web page: tainted, never returned */
    {
      messageId: 'a3',
      conversationId: 'cA1',
      user: A,
      isCreatedByUser: false,
      content: [
        { type: 'tool_call', tool_call: { name: 'kade_read_page', output: 'page text MARKER-ALPHA call 1-800-555-0100' } },
        { type: 'text', text: 'The page says the pharmacy MARKER-ALPHA hours are 9 to 5.' },
      ],
      createdAt: new Date('2026-11-04T15:02:00Z'),
    },
    /* the same person with another character */
    { messageId: 'a4', conversationId: 'cA2', user: A, isCreatedByUser: true, text: 'Della, the pharmacy MARKER-ALPHA moved.', createdAt: new Date('2026-11-05T15:00:00Z') },
    /* a temporary chat */
    { messageId: 'a5', conversationId: 'cAtemp', user: A, isCreatedByUser: true, text: 'pharmacy MARKER-ALPHA temp', createdAt: new Date('2026-11-05T16:00:00Z') },
    /* the conversation they are in now */
    { messageId: 'a6', conversationId: 'cNow', user: A, isCreatedByUser: true, text: 'what was that pharmacy number MARKER-ALPHA', createdAt: new Date('2026-11-11T15:00:00Z') },
    /* another person's words */
    { messageId: 'b1', conversationId: 'cB1', user: B, isCreatedByUser: true, text: 'My pharmacy MARKER-ALPHA code 482913, card 4111 1111 1111 9999', createdAt: new Date('2026-11-04T15:00:00Z') },
  ];
  const convos = [
    { conversationId: 'cA1', user: A, agent_id: AGENT },
    { conversationId: 'cA2', user: A, agent_id: 'agent_della' },
    { conversationId: 'cAtemp', user: A, agent_id: AGENT, isTemporary: true },
    { conversationId: 'cNow', user: A, agent_id: AGENT },
    { conversationId: 'cB1', user: B, agent_id: AGENT },
  ];
  const s = { rows, convos, meiliCalls: [] };
  s.deps = {
    /* A broken index that ignores the filter: every hit for the words, anyone's. */
    meili: async (q, opts) => {
      s.meiliCalls.push({ q, opts });
      const w = q.toLowerCase().split(/\s+/);
      return { hits: rows.filter((r) => w.some((x) => JSON.stringify(r).toLowerCase().includes(x))).map((r) => ({ messageId: r.messageId, conversationId: r.conversationId, user: r.user })) };
    },
    /* A database read that also ignores the user: the service must still drop what is not theirs. */
    messages: async (_userId, ids) => rows.filter((r) => ids.includes(r.messageId)),
    conversations: async (_userId, ids) => convos.filter((c) => ids.includes(c.conversationId)),
  };
  return s;
}

async function withStore(s, fn) {
  const before = R.__seam.deps;
  R.__seam.deps = s.deps;
  try {
    return await fn();
  } finally {
    R.__seam.deps = before;
  }
}

const textReq = (userId, convo = 'cNow') => ({ user: { id: userId, role: 'USER' }, body: { text: 'what was that pharmacy number', conversationId: convo } });

test('the marker is found by its owner, in this character\'s chats, never the tainted reply, the temporary chat or the chat in view', async () => {
  const s = store();
  await withStore(s, async () => {
    const r = await R.search({ req: textReq(A), agentId: AGENT, query: 'MARKER-ALPHA pharmacy' });
    assert.equal(r.ok, true);
    assert.equal(r.results.length, 2);
    assert.deepEqual(r.results.map((x) => x.who), ['they said', 'you said']);
    assert.match(r.results[0].snippet, /\(417\) 555-0142/);
    assert.match(r.results[0].when, /November 4, 2026/);
    assert.ok(!JSON.stringify(r).includes('1-800-555-0100'), 'page text never comes back');
    assert.ok(!JSON.stringify(r).includes('Della'), 'another character\'s chat is not searched by default');
    assert.ok(!JSON.stringify(r).includes('temp'), 'a temporary chat is not searched');
    assert.equal(s.meiliCalls[0].opts.filter, `user = "${A}"`);
    /* everywhere: their chats with other characters too */
    const all = await R.search({ req: textReq(A), agentId: AGENT, query: 'MARKER-ALPHA pharmacy', everywhere: true });
    assert.equal(all.results.length, 3);
  });
});

test('isolation: another person never sees the marker, even when the index and the database ignore the user', async () => {
  const s = store();
  await withStore(s, async () => {
    const r = await R.search({ req: textReq(B, 'cB-now'), agentId: AGENT, query: 'MARKER-ALPHA pharmacy', everywhere: true });
    assert.equal(r.ok, true);
    assert.equal(r.results.length, 1, 'only B\'s own line');
    assert.ok(!JSON.stringify(r).includes('555-0142'), 'none of A\'s words');
    assert.match(r.results[0].snippet, /\[code hidden\]/);
    assert.match(r.results[0].snippet, /\[card number hidden, ends 9999\]/);
    assert.ok(!JSON.stringify(r).includes('482913'));
    assert.equal(s.meiliCalls[0].opts.filter, `user = "${B}"`);
  });
});

test('only the signed-in app or website: a phone call, a paired phone, a hidden run and an unknown caller search nothing', async () => {
  const s = store();
  await withStore(s, async () => {
    const phone = { user: { id: 'seat', role: 'ADMIN' }, kadeOnBehalfOf: { id: A }, body: { text: 'what was that number', kadeOnBehalfOf: A } };
    assert.equal((await R.search({ req: phone, agentId: AGENT, query: 'pharmacy' })).why, 'phone');
    const hidden = textReq(A);
    hidden.kadeHiddenRun = true;
    assert.equal((await R.search({ req: hidden, agentId: AGENT, query: 'pharmacy' })).why, 'hidden');
    assert.equal((await R.search({ req: { user: { id: 's' }, kadeOnBehalfOfUnresolved: true, body: {} }, agentId: AGENT, query: 'pharmacy' })).why, 'unknown-caller');
    lanes.__seam.laneTrust = () => 'paired-phone';
    try {
      assert.equal((await R.search({ req: textReq(A), agentId: AGENT, query: 'pharmacy' })).why, 'phone');
    } finally {
      lanes.__seam.laneTrust = null;
    }
    assert.equal(s.meiliCalls.length, 0, 'the index was never asked');
  });
});

test('off switch, empty words, a strange id, and a search that is down', async () => {
  const s = store();
  await withStore(s, async () => {
    assert.equal((await R.search({ req: textReq(A), agentId: AGENT, query: 'pharmacy', env: { KADE_RECALL_SEARCH: '0' } })).why, 'off');
    assert.equal((await R.search({ req: textReq(A), agentId: AGENT, query: ' ' })).why, 'empty');
    assert.equal((await R.search({ req: textReq('a" OR user = "x'), agentId: AGENT, query: 'pharmacy' })).why, 'unavailable', 'nothing odd goes into the filter');
    assert.equal(s.meiliCalls.length, 0);
  });
  const down = store();
  down.deps.meili = async () => {
    throw new Error('MeiliSearch plugin not registered on Message model');
  };
  await withStore(down, async () => {
    const r = await R.search({ req: textReq(A), agentId: AGENT, query: 'pharmacy' });
    assert.equal(r.ok, false);
    assert.equal(r.why, 'search-down');
    assert.match(r.tellThem, /do not guess/);
  });
});

test('the default is on, because the live Meili index serves it', () => {
  assert.equal(R.on({}), true);
  assert.equal(R.on({ KADE_RECALL_SEARCH: '0' }), false);
});
