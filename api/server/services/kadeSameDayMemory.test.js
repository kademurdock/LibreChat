/* Nov 10 2026 (N1): same-day memory. Plain node:test, no model, no network, no database:
 *   node --test api/server/services/kadeSameDayMemory.test.js
 * Storage and the model are stand-ins handed in through the module's test seam; the model
 * stand-in records what it was sent and answers with fixed text. Everything said here is made up. */
const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('./kadeSameDayMemory');

const NOW = new Date('2026-11-10T21:00:00Z'); // Tuesday 3:00 p.m. Central
const MORNING = new Date('2026-11-10T15:00:00Z'); // 9:00 a.m. Central

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

/** `n` exchanges in one conversation, a minute apart, starting at `from`. */
function talk(n, { from = MORNING, conversationId = 'c1', size = 60 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const at = new Date(from.getTime() + i * 60000);
    out.push({ messageId: `${conversationId}-u${i}`, isCreatedByUser: true, text: `person line ${i} ` + 'x'.repeat(size), createdAt: at });
    out.push({
      messageId: `${conversationId}-a${i}`,
      isCreatedByUser: false,
      content: [{ type: 'text', text: `%%%warm%%% companion line ${i} ` + 'y'.repeat(size) }],
      createdAt: new Date(at.getTime() + 20000),
    });
  }
  return out;
}

function world({ messages = { c1: talk(12) }, prior = null, caps = [], answer = 'SUMMARY:\nShe spent Tuesday November 10 planning the garden beds and settled on raised boxes along the south fence.', excluded = [], memoryOn = true, cutoff = null } = {}) {
  const w = {
    calls: [],
    saved: [],
    logs: [],
    caps,
    memoryOn,
    revision: 1,
    prior,
    deps: {
      log: (l) => w.logs.push(l),
      warn: (l) => w.logs.push(l),
      memoryAllowed: async () => w.memoryOn,
      getSummary: async () => w.prior,
      saveSummary: async (userId, agentId, fields) => {
        if (w.prior && fields.expectedRevision !== (w.prior.revision || 0)) return null;
        w.saved.push({ userId, agentId, fields });
        return fields.summary;
      },
      policyRevision: async () => w.revision,
      clearCutoff: async () => cutoff,
      conversations: async () => Object.keys(messages),
      conversationExcluded: async (_u, id) => excluded.includes(id),
      messages: async (_u, id) => messages[id] || [],
      permitted: (turns, cut) => turns.filter((t) => !/off the record/i.test(t.text) && (!cut || t.at > cut)),
      corrections: async () => [],
      agentName: async () => 'Companion',
      readCap: async ({ userId, agentId, day }) => w.caps.find((c) => c.userId === userId && c.agentId === agentId && c.day === day) || null,
      claimCap: async ({ userId, agentId, day, cap }) => {
        let row = w.caps.find((c) => c.userId === userId && c.agentId === agentId && c.day === day);
        if (!row) {
          row = { userId, agentId, day, count: 0 };
          w.caps.push(row);
        }
        if (row.count >= cap) return false;
        row.count += 1;
        return true;
      },
      markDone: async ({ userId, agentId, day, lastMessageAt }) => {
        const row = w.caps.find((c) => c.userId === userId && c.agentId === agentId && c.day === day);
        if (row) row.lastMessageAt = lastMessageAt;
      },
      complete: async (args) => {
        w.calls.push(args);
        return typeof answer === 'function' ? answer(args) : answer;
      },
    },
  };
  return w;
}

async function run(w, args = {}) {
  const seam = M.__seam;
  const before = seam.deps;
  seam.deps = w.deps;
  try {
    return await M.refreshQuiet({ userId: 'u1', agentId: 'agent_x', now: NOW, ...args });
  } finally {
    seam.deps = before;
  }
}

/* ── pure pieces ──────────────────────────────────────────────────────── */

test('the Central day and the moment it began', () => {
  const d = M.centralDay(NOW);
  assert.equal(d.day, '2026-11-10');
  assert.equal(d.start.toISOString(), '2026-11-10T06:00:00.000Z');
  /* 11:30 p.m. Central is still the same day though it is already tomorrow in UTC */
  const late = M.centralDay(new Date('2026-11-11T05:30:00Z'));
  assert.equal(late.day, '2026-11-10');
  assert.equal(late.start.toISOString(), '2026-11-10T06:00:00.000Z');
});

test('a message is read wherever its words live, without the voice wrapper or voice directions', () => {
  assert.equal(M.messageText({ text: 'plain words' }), 'plain words');
  assert.equal(M.messageText({ content: [{ type: 'text', text: '%%%soft%%% hello' }, { type: 'tool_call' }, { type: 'text', text: { value: 'there' } }] }), 'hello\nthere');
  assert.equal(M.messageText({ text: '[EARLIER IN THIS CONVERSATION old turns. Reply ONLY to what follows.] the new words' }), 'the new words');
  assert.equal(M.messageText(null), '');
  assert.equal(M.messageText({ content: [] }), '');
});

test('the transcript is bounded: newest messages, each cut, oldest dropped until it fits', () => {
  const at = (i) => new Date(MORNING.getTime() + i * 60000);
  const turns = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `line ${i} ` + 'z'.repeat(300), at: at(i) }));
  const byCount = M.boundedTranscript(turns, { limit: 40, charLimit: 1000000 });
  assert.equal(byCount.used.length, 40);
  assert.match(byCount.text, /line 99 /);
  assert.doesNotMatch(byCount.text, /line 59 /);
  const byChars = M.boundedTranscript(turns, { limit: 40, charLimit: 3000 });
  assert.ok(byChars.chars <= 3000, String(byChars.chars));
  assert.match(byChars.text, /line 99 /, 'the newest words are the ones kept');
  assert.ok(byChars.used.length < 40 && byChars.used.length > 0);
  /* one huge message is cut, never sent whole */
  const huge = M.boundedTranscript([{ role: 'user', text: 'q'.repeat(50000), at: at(0) }], { limit: 40, charLimit: 24000 });
  assert.ok(huge.chars < 1600, String(huge.chars));
  assert.match(huge.text, /\[cut\]$/);
  assert.match(huge.text, /^\[2026-11-10T15:00:00\.000Z\] User: q/);
  assert.equal(M.boundedTranscript([], {}).text, '');
});

test('only a SUMMARY section is ever taken from the answer', () => {
  const body = 'She spent Tuesday November 10 planning the garden beds along the south fence.';
  assert.equal(M.parseSummary(`SUMMARY:\n${body}`), body);
  assert.equal(M.parseSummary(`Here you go.\n**SUMMARY:**\n${body}`), body);
  assert.equal(M.parseSummary(`SUMMARY: ${body}\n\nMY TAKE:\nI think she should not.`), body, 'a take is never saved from this pass');
  assert.equal(M.parseSummary(body), null, 'no label, nothing saved');
  assert.equal(M.parseSummary('SUMMARY:\ntoo short'), null);
  assert.equal(M.parseSummary(''), null);
  assert.equal(M.parseSummary(null), null);
  assert.equal(M.parseSummary(`SUMMARY:\n%%%warm%%% ${body}`), body);
});

test('which turns may start a quiet timer', async () => {
  const ok = { userId: 'u1', agentId: 'agent_x', req: { body: {} } };
  assert.equal(M.turnCounts(ok), true);
  assert.equal(M.turnCounts({ ...ok, offRecord: true }), false);
  assert.equal(M.turnCounts({ ...ok, agentId: 'ephemeral_1' }), false);
  assert.equal(M.turnCounts({ ...ok, userId: '' }), false);
  assert.equal(M.turnCounts({ ...ok, req: { kadeHiddenRun: true } }), false, 'the character speaking first is not a conversation');
  assert.equal(M.turnCounts({ ...ok, req: { body: { isTemporary: true } } }), false);
  assert.equal(M.turnCounts({ ...ok, req: { kadeOnBehalfOf: { id: 'someone-else' } } }), false, 'a turn run for another person');
  assert.equal(M.turnCounts({ ...ok, req: { kadeOnBehalfOf: { id: 'u1' } } }), true);
  assert.equal(M.turnCounts({ ...ok, req: { kadeOnBehalfOfUnresolved: true } }), false);
  await withEnv({ KADE_SAME_DAY_MEMORY: '0' }, () => assert.equal(M.turnCounts(ok), false));
  await withEnv({ KADE_MEMORY_SUMMARY: '0' }, () => assert.equal(M.turnCounts(ok), false));
});

test('the daily cap is 2 and a setting can only lower it', async () => {
  assert.equal(M.HARD_CAP_PER_DAY, 2);
  assert.equal(M.dailyCap(), 2);
  await withEnv({ KADE_SAME_DAY_MAX_PER_DAY: '1' }, () => assert.equal(M.dailyCap(), 1));
  await withEnv({ KADE_SAME_DAY_MAX_PER_DAY: '0' }, () => assert.equal(M.dailyCap(), 0));
  await withEnv({ KADE_SAME_DAY_MAX_PER_DAY: '9' }, () => assert.equal(M.dailyCap(), 2));
  await withEnv({ KADE_SAME_DAY_MAX_PER_DAY: 'lots' }, () => assert.equal(M.dailyCap(), 2));
});

/* ── one refresh ──────────────────────────────────────────────────────── */

test('a quiet relationship with enough turns gets its summary refreshed, and only its summary', async () => {
  const prior = { summary: 'She has been thinking about a garden.', take: 'private take', thread: 'a thread', revision: 4, sourceConversationIds: ['c0'], nightlyCursor: { at: '2026-11-10T09:00:00.000Z', messageId: 'm' } };
  const w = world({ prior });
  const r = await run(w);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(w.calls.length, 1, 'one model call');
  const sent = w.calls[0];
  assert.equal(sent.userId, 'u1');
  assert.equal(sent.agentId, 'agent_x');
  assert.match(sent.userContent, /TODAY IS: Tuesday, November 10, 2026 \(US Central\)/);
  assert.match(sent.userContent, /PREVIOUS SUMMARY \(may be empty\):\nShe has been thinking about a garden\./);
  assert.match(sent.userContent, /\[2026-11-10T15:00:00\.000Z\] User: person line 0 /);
  assert.match(sent.userContent, /Companion: companion line 11 /);
  assert.doesNotMatch(sent.userContent, /%%%/, 'voice directions never reach the model');
  assert.doesNotMatch(sent.userContent, /private take|a thread/, 'the private sections are not sent and not rewritten');
  assert.match(sent.instructions, /never write relative time/);
  /* the save names the summary and nothing private */
  assert.equal(w.saved.length, 1);
  const f = w.saved[0].fields;
  assert.deepEqual(Object.keys(f).sort(), ['agentName', 'expectedRevision', 'lastActivityAt', 'source', 'sourceConversationIds', 'summary']);
  assert.match(f.summary, /raised boxes along the south fence/);
  assert.equal(f.expectedRevision, 4);
  assert.equal(f.source, 'sameday');
  assert.deepEqual(f.sourceConversationIds, ['c0', 'c1']);
  assert.equal(new Date(f.lastActivityAt).toISOString(), '2026-11-10T15:11:20.000Z', 'the last turn used, not the clock');
  /* the cap row counts it and remembers where it stopped */
  assert.equal(w.caps.length, 1);
  assert.equal(w.caps[0].count, 1);
  assert.equal(w.caps[0].day, '2026-11-10');
  assert.ok(w.logs.some((l) => /\[kadeSameDay\] refreshed user=u1 agent=gent_x turns=24 said=12 chars=\d+ refresh=1\/2/.test(l)), w.logs.join('\n'));
  assert.ok(!w.logs.some((l) => /person line|companion line|raised boxes/.test(l)), 'no chat text in a log line');
});

test('too few turns that day: no model call, no cap spent', async () => {
  const w = world({ messages: { c1: talk(9) } });
  const r = await run(w);
  assert.deepEqual(r, { ok: false, skipped: 'few-turns', turns: 9 });
  assert.equal(w.calls.length, 0);
  assert.equal(w.caps.length, 0);
  /* the floor is a setting */
  await withEnv({ KADE_SAME_DAY_MIN_TURNS: '5' }, async () => {
    const w2 = world({ messages: { c1: talk(5) } });
    assert.equal((await run(w2)).ok, true);
  });
});

test('yesterday does not count, and neither does what the night already folded in', async () => {
  const yesterday = talk(30, { from: new Date('2026-11-09T20:00:00Z') });
  const w = world({ messages: { c1: yesterday } });
  assert.equal((await run(w)).skipped, 'few-turns');
  /* twelve turns just after midnight Central, all before the night's cursor */
  const early = talk(12, { from: new Date('2026-11-10T06:30:00Z') });
  const w2 = world({ messages: { c1: early }, prior: { summary: 's', revision: 1, nightlyCursor: { at: '2026-11-10T08:05:00.000Z', messageId: 'm' } } });
  assert.equal((await run(w2)).skipped, 'few-turns');
  assert.equal(w2.calls.length, 0);
});

test('the hard cap: a third refresh the same day is refused before any model call', async () => {
  const w = world({ messages: { c1: talk(12) } });
  assert.equal((await run(w)).ok, true);
  /* more talk, later the same day */
  w.deps.messages = async () => [...talk(12), ...talk(12, { from: new Date('2026-11-10T17:00:00Z'), conversationId: 'c1b' })];
  assert.equal((await run(w)).ok, true);
  assert.equal(w.caps[0].count, 2);
  w.deps.messages = async () => [...talk(12), ...talk(40, { from: new Date('2026-11-10T19:00:00Z'), conversationId: 'c1c' })];
  const third = await run(w);
  assert.deepEqual(third, { ok: false, skipped: 'cap' });
  assert.equal(w.calls.length, 2, 'two model calls that day, never three');
  /* a new Central day starts a new count */
  const tomorrow = new Date('2026-11-11T21:00:00Z');
  w.deps.messages = async () => talk(12, { from: new Date('2026-11-11T15:00:00Z') });
  assert.equal((await run(w, { now: tomorrow })).ok, true);
  assert.equal(w.calls.length, 3);
});

test('the second refresh only counts and sends what came after the first', async () => {
  const w = world({ messages: { c1: talk(12) } });
  assert.equal((await run(w)).ok, true);
  /* three more exchanges: under the floor, so nothing happens */
  w.deps.messages = async () => [...talk(12), ...talk(3, { from: new Date('2026-11-10T17:00:00Z'), conversationId: 'later' })];
  assert.deepEqual(await run(w), { ok: false, skipped: 'few-turns', turns: 3 });
  /* twelve more: a second refresh, and the morning is not sent again */
  w.deps.messages = async () => [...talk(12), ...talk(12, { from: new Date('2026-11-10T17:00:00Z'), conversationId: 'later' })];
  assert.equal((await run(w)).ok, true);
  assert.match(w.calls[1].userContent, /\[2026-11-10T17:00:00\.000Z\] User: person line 0 /);
  assert.doesNotMatch(w.calls[1].userContent, /2026-11-10T15:0/);
});

test('two servers at once cannot both spend the same refresh', async () => {
  const w = world({ messages: { c1: talk(12) }, caps: [{ userId: 'u1', agentId: 'agent_x', day: '2026-11-10', count: 1 }] });
  /* both read the row at 1, then both try to claim the last place */
  const [a, b] = await Promise.all([run(w), run(w)]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  assert.equal(w.calls.length, 1);
  assert.equal(w.caps[0].count, 2);
});

test('the input is bounded however long the day was', async () => {
  const w = world({ messages: { c1: talk(200, { size: 3000 }) } });
  const r = await run(w);
  assert.equal(r.ok, true);
  assert.equal(r.turns <= 40, true);
  assert.ok(r.chars <= 24000, String(r.chars));
  const sent = w.calls[0].userContent;
  assert.ok(sent.length < 24000 + 8000 + 1500, `whole message ${sent.length}`);
  assert.match(sent, /person line 199 /, 'the newest turns are the ones sent');
  /* the previous summary is capped too */
  const w2 = world({ prior: { summary: 'p'.repeat(20000), revision: 1 } });
  await run(w2);
  assert.ok(w2.calls[0].userContent.length < 8000 + 24000 + 1500);
});

test('memory off, a conversation kept out of memory, off the record, and a clear are all obeyed', async () => {
  const off = world({ memoryOn: false });
  assert.deepEqual(await run(off), { ok: false, skipped: 'memory-off' });
  assert.equal(off.calls.length, 0);
  const excluded = world({ messages: { c1: talk(12), c2: talk(12, { conversationId: 'c2', from: new Date('2026-11-10T16:00:00Z') }) }, excluded: ['c2'] });
  assert.equal((await run(excluded)).ok, true);
  assert.doesNotMatch(excluded.calls[0].userContent, /2026-11-10T16:/);
  assert.deepEqual(excluded.saved[0].fields.sourceConversationIds, ['c1']);
  const secret = talk(12);
  secret[4].text = 'off the record, the surprise is a trip';
  const hush = world({ messages: { c1: secret } });
  assert.equal((await run(hush)).ok, true);
  assert.doesNotMatch(hush.calls[0].userContent, /surprise is a trip/);
  const cleared = world({ cutoff: new Date('2026-11-10T20:00:00Z') });
  assert.equal((await run(cleared)).skipped, 'few-turns', 'everything said before the clear is gone');
  assert.equal(cleared.calls.length, 0);
});

test('memory switched off or cleared while the model was writing: nothing is saved', async () => {
  const w = world();
  w.deps.complete = async (args) => {
    w.calls.push(args);
    w.memoryOn = false;
    return 'SUMMARY:\nShe spent Tuesday November 10 planning the garden beds along the south fence.';
  };
  assert.deepEqual(await run(w), { ok: false, skipped: 'policy-changed' });
  assert.equal(w.saved.length, 0);
  const w2 = world();
  w2.deps.complete = async () => {
    w2.revision = 2;
    return 'SUMMARY:\nShe spent Tuesday November 10 planning the garden beds along the south fence.';
  };
  assert.deepEqual(await run(w2), { ok: false, skipped: 'policy-changed' });
  assert.equal(w2.saved.length, 0);
});

test('a bad answer, a failed model, or a summary the night rewrote meanwhile leaves the stored one alone', async () => {
  const noLabel = world({ answer: 'I could not do that.' });
  assert.deepEqual(await run(noLabel), { ok: false, skipped: 'no-summary' });
  assert.equal(noLabel.saved.length, 0);
  const dead = world({ answer: null });
  assert.equal((await run(dead)).skipped, 'no-summary');
  const thrown = world({ answer: () => { throw new Error('model down'); } });
  const t = await run(thrown);
  assert.equal(t.ok, false);
  assert.equal(t.error, 'model down');
  assert.equal(thrown.saved.length, 0);
  /* the nightly pass bumped the revision while this one was writing */
  const raced = world({ prior: { summary: 'old', revision: 3 } });
  raced.deps.complete = async () => {
    raced.prior = { summary: 'the night wrote this', revision: 4 };
    return 'SUMMARY:\nShe spent Tuesday November 10 planning the garden beds along the south fence.';
  };
  assert.deepEqual(await run(raced), { ok: false, skipped: 'raced' });
  assert.equal(raced.saved.length, 0);
});

test('switched off: no model call at all', async () => {
  await withEnv({ KADE_SAME_DAY_MEMORY: '0' }, async () => {
    const w = world();
    assert.deepEqual(await run(w), { ok: false, skipped: 'off' });
    assert.equal(w.calls.length, 0);
  });
  await withEnv({ KADE_SAME_DAY_MAX_PER_DAY: '0' }, async () => {
    const w = world();
    assert.deepEqual(await run(w), { ok: false, skipped: 'cap' });
    assert.equal(w.calls.length, 0);
  });
});

/* ── the quiet timer ──────────────────────────────────────────────────── */

test('a reply only sets a timer; each new reply starts the quiet wait over; nothing runs until it is quiet', async () => {
  const set = [];
  const cleared = [];
  const setTimer = (fn, ms) => {
    const t = { fn, ms, unref() { this.unrefed = true; } };
    set.push(t);
    return t;
  };
  const clearTimer = (t) => cleared.push(t);
  M.__watched.clear();
  const args = { userId: 'u1', agentId: 'agent_x', req: { body: {} }, setTimer, clearTimer };
  assert.equal(M.noteTurn(args), true);
  assert.equal(set.length, 1);
  assert.equal(set[0].ms, 20 * 60 * 1000);
  assert.equal(set[0].unrefed, true, 'a waiting timer never keeps the server alive');
  assert.equal(M.noteTurn(args), true);
  assert.equal(set.length, 2);
  assert.deepEqual(cleared, [set[0]], 'the first wait was cancelled');
  assert.equal(M.__watched.size, 1);
  /* another character is its own relationship */
  assert.equal(M.noteTurn({ ...args, agentId: 'agent_y' }), true);
  assert.equal(M.__watched.size, 2);
  /* turns that may not count set nothing */
  assert.equal(M.noteTurn({ ...args, offRecord: true }), false);
  assert.equal(M.noteTurn({ ...args, req: { kadeHiddenRun: true } }), false);
  assert.equal(set.length, 3);
  /* when it finally fires, the refresh runs once and the watch is dropped */
  const w = world();
  const seam = M.__seam;
  const before = seam.deps;
  seam.deps = w.deps;
  try {
    set[1].fn();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    seam.deps = before;
  }
  assert.equal(M.__watched.size, 1);
  await withEnv({ KADE_SAME_DAY_QUIET_MIN: '45' }, () => {
    M.noteTurn(args);
    assert.equal(set[set.length - 1].ms, 45 * 60 * 1000);
  });
  await withEnv({ KADE_SAME_DAY_MEMORY: '0' }, () => {
    const n = set.length;
    assert.equal(M.noteTurn(args), false);
    assert.equal(set.length, n);
  });
  M.__watched.clear();
});
