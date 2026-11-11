/* Nov 10 2026 (N7): the nightly card check. Plain node:test, no model, no network, no database:
 *   node --test api/server/services/kadeCardCheck.test.js
 * Storage and the model are stand-ins handed in through the module's test seam; the model stand-in
 * records what it was sent and answers with fixed JSON. Every person and fact here is made up. */
const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('./kadeCardCheck');

const NOW = new Date('2026-11-11T08:05:00Z');
const TALK = new Date('2026-11-10T20:00:00Z');

const withEnv = async (vars, fn) => {
  const old = {};
  for (const k of Object.keys(vars)) {
    old[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(old)) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
};

const card = (key, value, extra = {}) => ({
  key,
  value,
  agentId: 'agent_x',
  type: 'fact',
  sourceKind: 'conversation',
  sourceConversationIds: ['c1'],
  sourceMessageId: 'a1',
  updated_at: new Date(TALK.getTime() + 5 * 60000),
  ...extra,
});

/** A short made-up conversation: u0 a0 u1 a1 ... */
function convo(lines, { from = TALK } = {}) {
  return lines.map((text, i) => ({
    messageId: `${i % 2 ? 'a' : 'u'}${Math.floor(i / 2)}`,
    isCreatedByUser: i % 2 === 0,
    ...(i % 2 === 0 ? { text } : { content: [{ type: 'text', text }] }),
    createdAt: new Date(from.getTime() + i * 30000),
  }));
}

const TALK_LINES = [
  'My sister Dana is visiting on Friday the 14th, she is driving up from Tulsa.',
  '%%%warm%%% That sounds lovely. You should bake the lemon cake for her.',
  'Maybe. I start the new job at the library on Monday.',
  'Big week then. I will ask how the first day went.',
  'Also the cat finally let me trim her nails.',
  'A miracle.',
  'Yep.',
  'Ha.',
];

function world({ cards = [], messages = { c1: convo(TALK_LINES) }, checks = [], answer, memoryOn = true, excluded = [], cutoffs = {} } = {}) {
  const w = {
    cards,
    checks,
    calls: [],
    sets: [],
    ledger: [],
    logs: [],
    deletes: 0,
    memoryOn,
    revision: 1,
    clockAt: 0,
    deps: {
      log: (l) => w.logs.push(l),
      warn: (l) => w.logs.push(l),
      clock: () => w.clockAt,
      people: async () => ['u1'],
      memoryAllowed: async () => w.memoryOn,
      policyRevision: async () => w.revision,
      cards: async () => w.cards.map((c) => ({ ...c })),
      liveCard: async (_u, agentId, key) => w.cards.find((c) => c.key === key && (c.agentId || null) === (agentId || null)) || null,
      setCard: async ({ agentId, key, value }) => {
        const live = w.cards.find((c) => c.key === key && (c.agentId || null) === (agentId || null));
        w.sets.push({ agentId, key, value, before: live && live.value });
        if (live) live.value = value;
        return { ok: true };
      },
      ledger: async (row) => w.ledger.push(row),
      checks: async () => w.checks,
      conversationExcluded: async (_u, id) => excluded.includes(id),
      excludedConversations: async () => excluded,
      messages: async (_u, id) => messages[id] || [],
      clearCutoff: async (_u, agentId) => cutoffs[agentId || ''] || null,
      permitted: (turns, cutoff) => turns.filter((t) => !/off the record/i.test(t.text) && (!cutoff || t.at > cutoff)),
      claim: async ({ agentId, key, runId, now }) => {
        let row = w.checks.find((c) => c.key === key && (c.agentId || null) === (agentId || null));
        if (row && row.claimedUntil && row.claimedUntil > now) return false;
        if (!row) {
          row = { userId: 'u1', agentId: agentId || null, key };
          w.checks.push(row);
        }
        row.claimedUntil = new Date(now.getTime() + 900000);
        row.claimedBy = runId;
        return true;
      },
      release: async ({ agentId, key, runId }) => {
        const row = w.checks.find((c) => c.key === key && (c.agentId || null) === (agentId || null) && c.claimedBy === runId);
        if (row) {
          delete row.claimedUntil;
          delete row.claimedBy;
        }
      },
      mark: async ({ agentId, key, runId, fields }) => {
        const row = w.checks.find((c) => c.key === key && (c.agentId || null) === (agentId || null) && c.claimedBy === runId);
        if (row) Object.assign(row, fields);
      },
      prune: async ({ keep, excluded: ex }) => {
        const before = w.checks.length;
        w.checks = w.checks.filter((r) => keep.has(`${r.agentId || ''}::${r.key}`) && !(r.conversationId && ex.includes(r.conversationId)));
        w.deps.checks = async () => w.checks;
        return before - w.checks.length;
      },
      complete: async (args) => {
        w.calls.push(args);
        return typeof answer === 'function' ? answer(args, w) : answer;
      },
    },
  };
  return w;
}

async function run(w, args = {}) {
  const seam = C.__seam;
  const before = seam.deps;
  seam.deps = w.deps;
  try {
    return await C.runCardCheck({ now: NOW, ...args });
  } finally {
    seam.deps = before;
  }
}

const json = (cards) => JSON.stringify({ cards });
const mark = (w, key) => w.checks.find((c) => c.key === key);

/* ── pure pieces ──────────────────────────────────────────────────────── */

test('a quote is found only if it was really said, and what is kept is the speaker\'s own characters', () => {
  const turns = [
    { role: 'user', text: 'My sister Dana is visiting on   Friday the 14th, she’s driving up.', at: TALK },
    { role: 'assistant', text: 'You should bake the lemon cake for her.', at: TALK },
  ];
  /* case and spacing do not matter; the saved text is the conversation's own */
  assert.deepEqual(C.findQuote('my SISTER dana is visiting on friday the 14th', turns), {
    quote: 'My sister Dana is visiting on Friday the 14th', speaker: 'them', at: TALK,
  });
  assert.equal(C.findQuote("she's driving up.", turns).quote, "she's driving up.", 'a curly apostrophe is the same apostrophe');
  assert.equal(C.findQuote('"visiting on Friday the 14th."', turns).quote, 'visiting on Friday the 14th', 'wrapping quote marks and a stray full stop are forgiven');
  /* invented, stitched or tidied words are not found */
  assert.equal(C.findQuote('My sister Dana is visiting on Saturday', turns), null);
  assert.equal(C.findQuote('Dana is visiting, she is driving up', turns), null);
  assert.equal(C.findQuote('Friday', turns), null, 'too short to prove anything');
  assert.equal(C.findQuote('', turns), null);
  /* who said it matters */
  assert.equal(C.findQuote('bake the lemon cake', turns).speaker, 'me');
  assert.equal(C.findQuote('bake the lemon cake', turns, { onlyUser: true }), null);
});

test('which cards are looked at: fresh plain cards from a conversation, once per wording', () => {
  const since = new Date(NOW.getTime() - 30 * 3600000);
  const fresh = card('sister_visit', 'Sister Dana visits Friday the 14th.');
  const list = [
    fresh,
    card('old_fact', 'An older card.', { updated_at: new Date('2026-11-01T00:00:00Z') }),
    card('alarm', 'Remind her at nine.', { type: 'reminder' }),
    card('her_fix', 'She corrected this herself.', { correctionLocked: true }),
    card('her_fix_two', 'Also hers.', { sourceKind: 'user-correction' }),
    card('from_call', 'Filed after a phone call.', { sourceKind: 'call' }),
    card('no_source', 'No conversation recorded.', { sourceConversationIds: [] }),
    card('blank', '   '),
  ];
  assert.deepEqual(C.eligibleCards(list, { since }).map((c) => c.key), ['sister_visit']);
  /* already checked in this wording: skipped. Reworded since: looked at again. */
  const done = [{ agentId: 'agent_x', key: 'sister_visit', status: 'checked', valueHash: C.valueHash(fresh.value) }];
  assert.deepEqual(C.eligibleCards(list, { since, checks: done }), []);
  const reworded = [{ ...done[0], valueHash: C.valueHash('Sister Dana visits Saturday.') }];
  assert.equal(C.eligibleCards(list, { since, checks: reworded }).length, 1);
  /* a claim row with no verdict yet is not "checked" */
  assert.equal(C.eligibleCards(list, { since, checks: [{ agentId: 'agent_x', key: 'sister_visit', valueHash: C.valueHash(fresh.value) }] }).length, 1);
  /* the same key in another bucket is another card */
  assert.equal(C.eligibleCards(list, { since, checks: [{ ...done[0], agentId: null }] }).length, 1);
});

test('cards are grouped by the conversation they were last written from', () => {
  const groups = C.groupBySource([
    card('a', 'A.', { sourceConversationIds: ['c0', 'c2'] }),
    card('b', 'B.'),
    card('c', 'C.', { sourceConversationIds: ['c2'] }),
  ]);
  assert.deepEqual(groups.map(([id, list]) => [id, list.map((c) => c.key)]), [['c2', ['a', 'c']], ['c1', ['b']]]);
});

test('the evidence is the few turns before the reply a card was filed after, bounded', () => {
  const at = (i) => new Date(TALK.getTime() + i * 30000);
  const turns = Array.from({ length: 60 }, (_, i) => ({ messageId: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `line ${i} ` + 'w'.repeat(200), at: at(i) }));
  const one = C.evidenceWindow(turns, [card('k', 'v', { sourceMessageId: 'm41' })], { charLimit: 100000 });
  assert.equal(one.turns.length, 10);
  assert.match(one.text, /line 32 /);
  assert.match(one.text, /line 41 /);
  assert.doesNotMatch(one.text, /line 31 /);
  assert.doesNotMatch(one.text, /line 42 /, 'nothing said after the card was filed');
  /* two cards: both windows, in order, no line twice */
  const two = C.evidenceWindow(turns, [card('k', 'v', { sourceMessageId: 'm41' }), card('j', 'v', { sourceMessageId: 'm45' })], { charLimit: 100000 });
  assert.equal(two.turns.length, 14);
  /* the size cap drops the oldest lines */
  const small = C.evidenceWindow(turns, [card('k', 'v', { sourceMessageId: 'm41' })], { charLimit: 700 });
  assert.ok(small.chars <= 700, String(small.chars));
  assert.match(small.text, /line 41 /);
  /* a reply id that is gone falls back to the time the card was written */
  const byTime = C.evidenceWindow(turns, [card('k', 'v', { sourceMessageId: 'gone', updated_at: at(9) })], { charLimit: 100000 });
  assert.match(byTime.text, /line 9 /);
  assert.doesNotMatch(byTime.text, /line 10 /);
  /* a huge message is cut, and a quote can only be found in the part that was sent */
  const huge = C.evidenceWindow([{ messageId: 'm0', role: 'user', text: 'a'.repeat(1490) + ' the secret tail ' + 'b'.repeat(4000), at: at(0) }], [card('k', 'v', { sourceMessageId: 'm0' })], { charLimit: 100000 });
  assert.ok(huge.chars < 1600);
  assert.equal(huge.turns[0].text.length, 1500);
  assert.deepEqual(C.evidenceWindow([], [card('k', 'v')], {}).turns, []);
});

test('the answer must be the asked-for JSON; anything else is no answer', () => {
  const ids = ['c1', 'c2'];
  const ok = C.parseVerdicts('Sure.\n' + json([{ id: 'c1', verdict: 'confirmed', quote: 'q' }, { id: 'c9', verdict: 'wrong' }, { id: 'c2', verdict: 'maybe' }]), ids);
  assert.deepEqual([...ok.keys()], ['c1', 'c2'], 'an id that was never sent is ignored');
  assert.equal(ok.get('c1').verdict, 'confirmed');
  assert.equal(ok.get('c2').verdict, 'unconfirmed', 'an unknown verdict is the safe one');
  assert.equal(C.parseVerdicts('I think they are all fine.', ids), null);
  assert.equal(C.parseVerdicts('{"cards": "none"}', ids), null);
  assert.equal(C.parseVerdicts('{broken', ids), null);
  assert.equal(C.parseVerdicts(null, ids), null);
});

test('a rewrite must keep the card and may only add what the person said', () => {
  const old = 'Sister Dana visits on Saturday the 15th, driving up from Tulsa.';
  const said = 'My sister Dana is visiting on Friday the 14th, she is driving up from Tulsa.';
  assert.equal(C.keepsDetail(old, 'Sister Dana visits on Friday the 14th, driving up from Tulsa.'), true);
  assert.equal(C.keepsDetail(old, 'Dana visits.'), false, 'most of the card is gone');
  assert.equal(C.keepsDetail(old, 'Friday the 14th.'), false);
  assert.equal(C.addsOnlyWhatWasSaid(old, 'Sister Dana visits on Friday the 14th, driving up from Tulsa.', said), true);
  assert.equal(C.addsOnlyWhatWasSaid(old, 'Sister Dana visits on Friday the 21st, driving up from Tulsa.', said), false, 'a number she never said');
  assert.equal(C.addsOnlyWhatWasSaid(old, 'Sister Dana visits on Friday the 14th with her husband Marcus and their twins.', said), false, 'people she never mentioned');
});

test('the model proposes, the code decides', () => {
  const turns = [
    { role: 'user', text: 'My sister Dana is visiting on Friday the 14th, she is driving up from Tulsa.', at: TALK },
    { role: 'assistant', text: 'You should bake the lemon cake for her.', at: TALK },
  ];
  const wrongCard = card('sister_visit', 'Sister Dana visits on Saturday the 15th, driving up from Tulsa.');
  const good = { verdict: 'wrong', quote: 'visiting on Friday the 14th', fixed: 'Sister Dana visits on Friday the 14th, driving up from Tulsa.' };
  assert.deepEqual(C.decide(wrongCard, good, turns, { allowFix: true }), {
    action: 'fix', quote: 'visiting on Friday the 14th', speaker: 'them', quoteAt: TALK, fixed: 'Sister Dana visits on Friday the 14th, driving up from Tulsa.',
  });
  /* fixing switched off: marked, never rewritten */
  assert.equal(C.decide(wrongCard, good, turns, { allowFix: false }).action, 'unconfirmed');
  /* "wrong" on the companion's word alone is not enough */
  assert.equal(C.decide(wrongCard, { ...good, quote: 'bake the lemon cake for her' }, turns, { allowFix: true }).action, 'unconfirmed');
  /* a quote that was never said */
  assert.equal(C.decide(wrongCard, { ...good, quote: 'visiting on Sunday the 16th' }, turns, { allowFix: true }).action, 'unconfirmed');
  /* a rewrite that erases the card, adds an invention, or changes nothing is refused */
  assert.equal(C.decide(wrongCard, { ...good, fixed: 'Friday the 14th.' }, turns, { allowFix: true }).action, 'refused');
  assert.equal(C.decide(wrongCard, { ...good, fixed: 'Sister Dana visits on Friday the 14th, driving up from Tulsa with her new husband Marcus.' }, turns, { allowFix: true }).action, 'refused');
  assert.equal(C.decide(wrongCard, { ...good, fixed: wrongCard.value }, turns, { allowFix: true }).action, 'refused');
  assert.equal(C.decide(wrongCard, { ...good, fixed: '' }, turns, { allowFix: true }).action, 'refused');
  /* confirmed needs the person's own words */
  assert.deepEqual(C.decide(wrongCard, { verdict: 'confirmed', quote: 'driving up from Tulsa' }, turns), { action: 'checked', quote: 'driving up from Tulsa', speaker: 'them', quoteAt: TALK });
  const companionOnly = C.decide(card('cake', 'She will bake a lemon cake.'), { verdict: 'confirmed', quote: 'bake the lemon cake' }, turns);
  assert.equal(companionOnly.action, 'unconfirmed');
  assert.equal(companionOnly.speaker, 'me');
  assert.equal(C.decide(wrongCard, { verdict: 'confirmed', quote: 'something never said at all' }, turns).action, 'unconfirmed');
  assert.equal(C.decide(wrongCard, { verdict: 'unconfirmed' }, turns).action, 'unconfirmed');
  assert.equal(C.decide(wrongCard, undefined, turns).action, 'unconfirmed', 'a card the model skipped');
});

/* ── the nightly run ──────────────────────────────────────────────────── */

test('one night: a true card is checked with the exact quote, a wrong one is fixed, an unbacked one is marked, none is deleted', async () => {
  const cards = [
    card('sister_visit', 'Sister Dana visits on Saturday the 15th, driving up from Tulsa.'),
    card('new_job', 'Starts a new job at the library on Monday.'),
    card('lemon_cake', 'Is going to bake a lemon cake for the visit.'),
    card('dog_name', 'Her dog is called Biscuit.'),
  ];
  const w = world({
    cards,
    answer: json([
      { id: 'c1', verdict: 'wrong', quote: 'My sister Dana is visiting on Friday the 14th', fixed: 'Sister Dana visits on Friday the 14th, driving up from Tulsa.' },
      { id: 'c2', verdict: 'confirmed', quote: 'i start the new job at the library on monday' },
      { id: 'c3', verdict: 'confirmed', quote: 'You should bake the lemon cake for her.' },
      { id: 'c4', verdict: 'unconfirmed' },
    ]),
  });
  const r = await run(w);
  assert.equal(r.ran, true);
  assert.deepEqual([r.calls, r.cards, r.checked, r.fixed, r.unconfirmed, r.refused, r.failed], [1, 4, 1, 1, 2, 0, 0], JSON.stringify(r));
  /* the model saw the cards and the conversation, bounded, with no voice directions */
  const sent = w.calls[0];
  assert.match(sent.userContent, /^CARDS:\n\[c1\] Sister Dana visits on Saturday the 15th/);
  assert.match(sent.userContent, /CONVERSATION:\n\[2026-11-10T20:00:00\.000Z\] User: My sister Dana is visiting/);
  assert.doesNotMatch(sent.userContent, /%%%/);
  assert.doesNotMatch(sent.userContent, /Yep\./, 'nothing said after the card was filed');
  assert.match(sent.instructions, /Never drop a true detail/);
  /* the fix: one write, through the card store, old wording ledgered */
  assert.deepEqual(w.sets, [{ agentId: 'agent_x', key: 'sister_visit', value: 'Sister Dana visits on Friday the 14th, driving up from Tulsa.', before: 'Sister Dana visits on Saturday the 15th, driving up from Tulsa.' }]);
  assert.equal(w.ledger.length, 1);
  assert.equal(w.ledger[0].action, 'set');
  assert.equal(w.ledger[0].before, 'Sister Dana visits on Saturday the 15th, driving up from Tulsa.');
  assert.equal(w.ledger[0].after, 'Sister Dana visits on Friday the 14th, driving up from Tulsa.');
  /* the marks */
  const fixed = mark(w, 'sister_visit');
  assert.equal(fixed.status, 'checked');
  assert.equal(fixed.fixed, true);
  assert.equal(fixed.quote, 'My sister Dana is visiting on Friday the 14th');
  assert.equal(fixed.quoteSpeaker, 'them');
  assert.equal(fixed.valueHash, C.valueHash('Sister Dana visits on Friday the 14th, driving up from Tulsa.'));
  const job = mark(w, 'new_job');
  assert.equal(job.status, 'checked');
  assert.equal(job.quote, 'I start the new job at the library on Monday', 'her characters, not the model\'s lower-case copy');
  assert.equal(job.fixed, false);
  const cake = mark(w, 'lemon_cake');
  assert.equal(cake.status, 'unconfirmed', 'only the companion suggested it');
  assert.equal(cake.quoteSpeaker, 'me');
  assert.equal(mark(w, 'dog_name').status, 'unconfirmed');
  assert.equal(mark(w, 'dog_name').quote, '');
  /* every card is still there, three of them untouched */
  assert.equal(w.cards.length, 4);
  assert.equal(w.cards[1].value, 'Starts a new job at the library on Monday.');
  assert.equal(w.cards[2].value, 'Is going to bake a lemon cake for the visit.');
  assert.equal(w.cards[3].value, 'Her dog is called Biscuit.');
  /* no claim is left held */
  assert.ok(w.checks.every((c) => !c.claimedBy && !c.claimedUntil));
  /* the log line is counts only */
  const line = w.logs.find((l) => l.startsWith('[kadeCardCheck] done:'));
  assert.equal(line, '[kadeCardCheck] done: 1 calls, 4 cards for 1 people: 1 checked, 1 fixed, 2 unconfirmed, 0 refused, 0 stepped back, 0 failed');
  assert.ok(!w.logs.some((l) => /Dana|library|lemon|Biscuit/.test(l)), 'nothing anyone said is logged');
});

test('the next night nothing is asked again: a card is checked once per wording', async () => {
  const cards = [card('new_job', 'Starts a new job at the library on Monday.')];
  const w = world({ cards, answer: json([{ id: 'c1', verdict: 'confirmed', quote: 'I start the new job at the library on Monday' }]) });
  await run(w);
  assert.equal(w.calls.length, 1);
  await run(w);
  assert.equal(w.calls.length, 1, 'no second model call');
  /* the keeper rewords the card: it is looked at again */
  w.cards[0].value = 'Starts the library job on Monday and is nervous about it.';
  await run(w);
  assert.equal(w.calls.length, 2);
});

test('a rewrite that would erase true detail is refused, ledgered, and the card is left exactly as it was', async () => {
  const cards = [card('sister_visit', 'Sister Dana visits on Saturday the 15th, driving up from Tulsa.')];
  const w = world({ cards, answer: json([{ id: 'c1', verdict: 'wrong', quote: 'My sister Dana is visiting on Friday the 14th', fixed: 'Visit Friday.' }]) });
  const r = await run(w);
  assert.equal(r.refused, 1);
  assert.equal(r.fixed, 0);
  assert.equal(w.sets.length, 0);
  assert.equal(w.cards[0].value, 'Sister Dana visits on Saturday the 15th, driving up from Tulsa.');
  assert.equal(w.ledger[0].action, 'refused');
  assert.match(w.ledger[0].note, /drops too much/);
  assert.equal(mark(w, 'sister_visit').status, 'unconfirmed');
  assert.equal(mark(w, 'sister_visit').quote, '');
});

test('one writer: a card someone else changed while the model was reading is not written', async () => {
  const cards = [card('sister_visit', 'Sister Dana visits on Saturday the 15th, driving up from Tulsa.')];
  const w = world({
    cards,
    answer: (_args, world_) => {
      /* the live keeper rewrites the card during the model call */
      world_.cards[0].value = 'Sister Dana visits on Friday the 14th now, plans changed.';
      return json([{ id: 'c1', verdict: 'wrong', quote: 'My sister Dana is visiting on Friday the 14th', fixed: 'Sister Dana visits on Friday the 14th, driving up from Tulsa.' }]);
    },
  });
  const r = await run(w);
  assert.equal(r.steppedBack, 1);
  assert.equal(w.sets.length, 0);
  assert.equal(w.cards[0].value, 'Sister Dana visits on Friday the 14th now, plans changed.');
  assert.equal(mark(w, 'sister_visit').status, undefined, 'no verdict is recorded for wording that no longer exists');
});

test('one writer: a card another server holds is not sent to the model at all', async () => {
  const cards = [card('sister_visit', 'Sister Dana visits on Saturday the 15th.'), card('new_job', 'Starts a new job at the library on Monday.')];
  const held = { userId: 'u1', agentId: 'agent_x', key: 'sister_visit', claimedBy: 'other-server', claimedUntil: new Date(NOW.getTime() + 600000) };
  const w = world({ cards, checks: [held], answer: json([{ id: 'c1', verdict: 'confirmed', quote: 'I start the new job at the library on Monday' }]) });
  await run(w);
  assert.equal(w.calls.length, 1);
  assert.doesNotMatch(w.calls[0].userContent, /Saturday the 15th/);
  assert.equal(held.claimedBy, 'other-server', 'their claim is still theirs');
  assert.equal(held.status, undefined);
  /* everything held: no call */
  const w2 = world({ cards: [cards[0]], checks: [{ ...held }], answer: json([]) });
  await run(w2);
  assert.equal(w2.calls.length, 0);
});

test('a card the person corrected themselves, and a reminder, are never sent or touched', async () => {
  const cards = [
    card('her_word', 'Her own correction of an earlier card.', { correctionLocked: true }),
    card('alarm', 'Remind her at nine about the visit.', { type: 'reminder' }),
  ];
  const w = world({ cards, answer: json([]) });
  const r = await run(w);
  assert.equal(w.calls.length, 0);
  assert.equal(r.cards, 0);
  /* corrected by the person DURING the model call: the fix steps back */
  const live = [card('sister_visit', 'Sister Dana visits on Saturday the 15th, driving up from Tulsa.')];
  const w2 = world({
    cards: live,
    answer: (_a, world_) => {
      world_.cards[0].correctionLocked = true;
      return json([{ id: 'c1', verdict: 'wrong', quote: 'My sister Dana is visiting on Friday the 14th', fixed: 'Sister Dana visits on Friday the 14th, driving up from Tulsa.' }]);
    },
  });
  assert.equal((await run(w2)).steppedBack, 1);
  assert.equal(w2.sets.length, 0);
});

test('the input is bounded: cards per call, calls per person, calls per night, and a time budget', async () => {
  const many = Array.from({ length: 30 }, (_, i) => card('k' + String.fromCharCode(97 + (i % 26)) + (i > 25 ? 'x' : ''), `Card number ${i} says something long enough to count. ` + 'z'.repeat(900)));
  const w = world({ cards: many, answer: json([]) });
  await run(w);
  assert.equal(w.calls.length, 1, 'one conversation, one call');
  const sent = w.calls[0].userContent;
  assert.equal((sent.match(/^\[c\d+\] /gm) || []).length, 8, 'eight cards at most');
  assert.ok(sent.length < 8 * 620 + 16000 + 200, `whole message ${sent.length}`);
  /* five conversations for one person: three calls */
  const spread = Array.from({ length: 5 }, (_, i) => card('conv_' + String.fromCharCode(97 + i), `A card from conversation ${i}.`, { sourceConversationIds: ['c' + i], sourceMessageId: 'a0' }));
  const messages = Object.fromEntries(Array.from({ length: 5 }, (_, i) => ['c' + i, convo(['Something she said that day, number ' + i, 'A reply.'])]));
  const w2 = world({ cards: spread, messages, answer: json([]) });
  await run(w2);
  assert.equal(w2.calls.length, 3);
  /* the nightly ceiling */
  await withEnv({ KADE_CARD_CHECK_MAX_PER_RUN: '2' }, async () => {
    const w3 = world({ cards: spread, messages, answer: json([]) });
    w3.deps.people = async () => ['u1', 'u2', 'u3'];
    const r = await run(w3);
    assert.equal(w3.calls.length, 2);
    assert.equal(r.stopped, 'run-cap');
  });
  /* out of time: stop before the next person */
  const w4 = world({ cards: spread, messages, answer: (_a, world_) => { world_.clockAt += 31 * 60000; return json([]); } });
  w4.deps.people = async () => ['u1', 'u2'];
  const r4 = await run(w4);
  assert.equal(w4.calls.length, 1);
  assert.equal(r4.stopped, 'time');
  /* a long conversation is cut to the size cap */
  const long = convo(Array.from({ length: 40 }, (_, i) => `Line ${i} ` + 'q'.repeat(1400)));
  const w5 = world({ cards: [card('late', 'A card filed late in a long talk.', { sourceMessageId: 'a19' })], messages: { c1: long }, answer: json([]) });
  await run(w5);
  const conversationPart = w5.calls[0].userContent.split('CONVERSATION:\n')[1];
  assert.ok(conversationPart.length <= 16000 + 20, String(conversationPart.length));
});

test('the memory rules are obeyed, and no kind of account is left out', async () => {
  const cards = [card('new_job', 'Starts a new job at the library on Monday.')];
  const ok = json([{ id: 'c1', verdict: 'confirmed', quote: 'I start the new job at the library on Monday' }]);
  /* memory switched off: nothing read, nothing asked */
  const off = world({ cards, answer: ok, memoryOn: false });
  await run(off);
  assert.equal(off.calls.length, 0);
  /* the conversation is kept out of memory */
  const out = world({ cards, answer: ok, excluded: ['c1'] });
  await run(out);
  assert.equal(out.calls.length, 0);
  /* said off the record: not evidence, so no judgment and no mark */
  const hush = world({
    cards: [{ ...cards[0], sourceMessageId: 'a0' }],
    answer: ok,
    messages: { c1: convo(['off the record, I start the new job at the library on Monday', 'Understood.']) },
  });
  await run(hush);
  assert.equal(hush.calls.length, 0);
  assert.equal(hush.checks.length, 0);
  /* a memory clear after the talk: nothing before it is read */
  const cleared = world({ cards, answer: ok, cutoffs: { agent_x: new Date('2026-11-11T00:00:00Z') } });
  await run(cleared);
  assert.equal(cleared.calls.length, 0);
  /* memory switched off while the model was reading: nothing is written */
  const during = world({ cards, answer: (_a, world_) => { world_.memoryOn = false; return ok; } });
  const r = await run(during);
  assert.equal(r.steppedBack, 1);
  assert.equal(mark(during, 'new_job').status, undefined);
  /* the module never asks what kind of account this is: the stand-in has no such answer to give */
  const plain = world({ cards, answer: ok });
  assert.equal((await run(plain)).checked, 1);
  assert.ok(!Object.keys(plain.deps).some((k) => /role|admin|family|child|account/i.test(k)));
});

test('a model that fails or answers in the wrong shape marks nothing', async () => {
  const cards = [card('new_job', 'Starts a new job at the library on Monday.')];
  const prose = world({ cards, answer: 'They all look right to me.' });
  const r = await run(prose);
  assert.equal(r.failed, 1);
  assert.equal(mark(prose, 'new_job').status, undefined);
  assert.ok(!mark(prose, 'new_job').claimedBy, 'the claim is let go');
  const dead = world({ cards, answer: null });
  assert.equal((await run(dead)).failed, 1);
  const thrown = world({ cards, answer: () => { throw new Error('model down'); } });
  const t = await run(thrown);
  assert.equal(t.failed, 1);
  assert.equal(thrown.sets.length, 0);
  assert.ok(thrown.checks.every((c) => !c.claimedBy));
});

test('the switches: off runs nothing; fixes off keeps the marks and rewrites nothing', async () => {
  const cards = [card('sister_visit', 'Sister Dana visits on Saturday the 15th, driving up from Tulsa.')];
  const answer = json([{ id: 'c1', verdict: 'wrong', quote: 'My sister Dana is visiting on Friday the 14th', fixed: 'Sister Dana visits on Friday the 14th, driving up from Tulsa.' }]);
  await withEnv({ KADE_CARD_CHECK: '0' }, async () => {
    const w = world({ cards, answer });
    assert.deepEqual(await run(w), { ran: false, reason: 'disabled' });
    assert.equal(w.calls.length, 0);
    assert.equal(await C.nightlyCardCheck(NOW), null);
  });
  await withEnv({ KADE_CARD_CHECK_FIX: '0' }, async () => {
    const w = world({ cards: [{ ...cards[0] }], answer });
    const r = await run(w);
    assert.equal(r.fixed, 0);
    assert.equal(w.sets.length, 0);
    assert.equal(mark(w, 'sister_visit').status, 'unconfirmed');
  });
});

test('marks whose card is gone, or whose quote came from a conversation now kept out of memory, are tidied away', async () => {
  const cards = [card('new_job', 'Starts a new job at the library on Monday.')];
  const checks = [
    { userId: 'u1', agentId: 'agent_x', key: 'forgotten_card', status: 'checked', quote: 'words from a card she deleted', conversationId: 'c7' },
    { userId: 'u1', agentId: 'agent_x', key: 'new_job', status: 'checked', quote: 'old words', conversationId: 'c9', valueHash: 'stale' },
  ];
  const w = world({ cards, checks, excluded: ['c9'], answer: json([{ id: 'c1', verdict: 'confirmed', quote: 'I start the new job at the library on Monday' }]) });
  await run(w);
  assert.deepEqual(w.checks.map((c) => c.key), ['new_job']);
  assert.equal(mark(w, 'new_job').quote, 'I start the new job at the library on Monday');
  assert.equal(w.cards.length, 1, 'only side rows were tidied; the card store was not touched');
});

test('a reader gets only marks that match the card as it is worded now', async () => {
  const live = [card('new_job', 'Starts a new job at the library on Monday.'), card('dog_name', 'Her dog is called Biscuit.')];
  const checks = [
    { agentId: 'agent_x', key: 'new_job', status: 'checked', quote: 'I start the new job at the library on Monday', quoteSpeaker: 'them', valueHash: C.valueHash(live[0].value), checkedAt: NOW, conversationId: 'c1' },
    { agentId: 'agent_x', key: 'dog_name', status: 'checked', quote: 'x', valueHash: C.valueHash('An older wording.'), checkedAt: NOW, conversationId: 'c1' },
  ];
  const w = world({ checks });
  const seam = C.__seam;
  const before = seam.deps;
  seam.deps = w.deps;
  try {
    const marks = await C.getCardChecks('u1', live);
    assert.deepEqual([...marks.keys()], ['agent_x::new_job']);
    assert.equal(marks.get('agent_x::new_job').quote, 'I start the new job at the library on Monday');
    /* cleared since, or from a conversation now kept out of memory: no mark */
    w.deps.clearCutoff = async () => new Date(NOW.getTime() + 1000);
    assert.equal((await C.getCardChecks('u1', live)).size, 0);
    w.deps.clearCutoff = async () => null;
    w.deps.excludedConversations = async () => ['c1'];
    assert.equal((await C.getCardChecks('u1', live)).size, 0);
  } finally {
    seam.deps = before;
  }
});

test('the nightly hook runs once, in the dreaming hour only', async () => {
  const w = world({ cards: [], answer: json([]) });
  const seam = C.__seam;
  const before = seam.deps;
  seam.deps = w.deps;
  try {
    assert.equal(await C.nightlyCardCheck(new Date('2026-12-01T07:59:00Z')), null, 'not the hour');
    const first = await C.nightlyCardCheck(new Date('2026-12-01T08:10:00Z'));
    assert.equal(first.ran, true);
    assert.equal(await C.nightlyCardCheck(new Date('2026-12-01T08:50:00Z')), null, 'already ran tonight');
    assert.equal((await C.nightlyCardCheck(new Date('2026-12-02T08:01:00Z'))).ran, true);
  } finally {
    seam.deps = before;
  }
});

test('this file cannot delete a card: there is no such call in it', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'kadeCardCheck.js'), 'utf8');
  assert.doesNotMatch(src, /deleteMemory|deleteAllUserMemories|MemoryEntry\.(delete|remove|findOneAndDelete)/);
  /* the only deletes are of its own side collection */
  const deletes = src.match(/\.delete(One|Many)\(/g) || [];
  assert.equal(deletes.length, 2);
  assert.match(src, /const CHECKS = 'kadecardchecks'/);
});
