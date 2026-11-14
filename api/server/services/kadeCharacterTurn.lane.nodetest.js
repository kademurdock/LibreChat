'use strict';
/* Nov 14 2026: a character's own message is marked for the speak-first writing lane; a background task is not.
 * Her words: "Change the lyric desk etc to it too, whatever benefits from better writing than Mimo". compose() runs
 * one hidden turn over loopback; here the site is a stand-in, so only the headers it sends are read.
 * Run: node --test api/server/services/kadeCharacterTurn.lane.nodetest.js (no network, no database). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const stubs = {
  '@librechat/data-schemas': { logger: { info() {}, warn() {}, error() {} } },
  'librechat-data-provider': { Constants: { NO_PARENT: '00000000-0000-0000-0000-000000000000' } },
  '~/models': {
    getUserById: async (id) => ({ _id: id, username: 'u', email: 'u@example.com', provider: 'local', role: 'USER' }),
    generateToken: async () => 'token',
    deleteConvos: async () => ({}),
  },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};
const turn = require('./kadeCharacterTurn');

const starts = [];
global.fetch = async (url, options = {}) => {
  if (String(url).endsWith('/api/agents/chat')) {
    starts.push(options.headers);
    return { ok: true, status: 200, json: async () => ({ streamId: 's1', conversationId: 'c1' }) };
  }
  const final = `data: ${JSON.stringify({ final: true, responseMessage: { text: 'Hey, the horses are fine.' } })}\n`;
  return { ok: true, status: 200, body: (async function* () { yield new TextEncoder().encode(final); })() };
};

test('a one-message turn (no step budget) carries the speak-first mark; a task with steps does not', async () => {
  starts.length = 0;
  const one = await turn.compose({ userId: 'u1', agentId: 'agent_test_123456', note: 'text them about the horses' });
  assert.equal(one.text, 'Hey, the horses are fine.');
  assert.equal(starts[0]['x-kade-claude-lane'], 'speak-first');
  assert.ok(starts[0]['x-kade-hidden-run'], 'still a hidden run');
  const task = await turn.compose({ userId: 'u1', agentId: 'agent_test_123456', note: 'BACKGROUND JOB', steps: 30 });
  assert.equal(task.text, 'Hey, the horses are fine.');
  assert.equal(starts[1]['x-kade-claude-lane'], undefined, 'a background task stays unmarked until Kade decides');
  assert.equal(starts[1]['x-kade-steps'], '30');
});

/* Nov 14 2026: once the site has started a turn, an error carries the throwaway chat's id, so reach-out can
 * count what a turn that was written and then failed really cost (services/kadeReachOut.js). */
test('a turn that started and then gave no reply throws with its throwaway chat id', async () => {
  const saved = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith('/api/agents/chat')) {
      return { ok: true, status: 200, json: async () => ({ streamId: 's9', conversationId: 'c9' }) };
    }
    const final = `data: ${JSON.stringify({ final: true, responseMessage: { text: '' } })}\n`;
    return { ok: true, status: 200, body: (async function* () { yield new TextEncoder().encode(final); })() };
  };
  try {
    await assert.rejects(
      turn.compose({ userId: 'u1', agentId: 'agent_test_123456', note: 'text them about the horses' }),
      (e) => /no reply/.test(e.message) && e.composeConversationId === 'c9',
    );
  } finally {
    global.fetch = saved;
  }
});

test('a turn the site would not start carries no id (nothing was spent)', async () => {
  const saved = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'down' });
  try {
    await assert.rejects(
      turn.compose({ userId: 'u1', agentId: 'agent_test_123456', note: 'text them about the horses' }),
      (e) => /would not start/.test(e.message) && e.composeConversationId === undefined,
    );
  } finally {
    global.fetch = saved;
  }
});

test('withTurnId: tags an error once, never overwrites, and leaves anything else alone', () => {
  const e = turn.withTurnId(new Error('x'), 'c1');
  assert.equal(e.composeConversationId, 'c1');
  assert.equal(turn.withTurnId(e, 'c2').composeConversationId, 'c1');
  assert.equal(turn.withTurnId(new Error('y'), '').composeConversationId, undefined);
  assert.equal(turn.withTurnId('a string', 'c1'), 'a string');
  const frozen = Object.freeze(new Error('z'));
  assert.equal(turn.withTurnId(frozen, 'c1'), frozen);
});

test('a turn the site refused (4xx) or that is switched off is tagged never started; a 5xx stays unknown', async () => {
  const saved = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, status: 403, text: async () => 'no access' });
    await assert.rejects(
      turn.compose({ userId: 'u1', agentId: 'agent_test_123456', note: 'text them about the horses' }),
      (e) => /would not start the turn \(403\)/.test(e.message) && e.composeStarted === false,
    );
    global.fetch = async () => ({ ok: false, status: 502, text: async () => 'bad gateway' });
    await assert.rejects(
      turn.compose({ userId: 'u1', agentId: 'agent_test_123456', note: 'text them about the horses' }),
      (e) => /\(502\)/.test(e.message) && e.composeStarted === undefined,
    );
  } finally {
    global.fetch = saved;
  }
  const e = turn.notStarted(new Error('x'));
  assert.equal(e.composeStarted, false);
});

/* Nov 14 2026 (review of the phone-call reports, bridge call-report.js). A call report carries what the other
 * person on the phone said: it stays off the speak-first Claude lane unless KADE_CLAUDE_CALL_REPORTS=1 (the privacy
 * page names Claude for check-ins, reach-outs and research or errand write-ups, not call write-ups, and it would
 * cost about 20 cents instead of 1 to 2), and its run is marked as carrying outside text. beforePost returning
 * false stops speakFirst before it writes anything, so only the turn's headers are read here. */
test('a phone-call report: no Claude lane unless switched on, always marked as outside text; other kinds unchanged', async () => {
  const saved = process.env.KADE_CLAUDE_CALL_REPORTS;
  const stop = async () => false;
  try {
    delete process.env.KADE_CLAUDE_CALL_REPORTS;
    starts.length = 0;
    await turn.speakFirst({ userId: 'u1', agentId: 'agent_test_123456', note: 'the call ended', kind: 'call', requested: true, beforePost: stop });
    assert.equal(starts[0]['x-kade-claude-lane'], undefined, 'a call report is written on MiMo');
    assert.equal(starts[0]['x-kade-outside-text'], '1');
    await turn.speakFirst({ userId: 'u1', agentId: 'agent_test_123456', note: 'research done', kind: 'research', requested: true, beforePost: stop });
    assert.equal(starts[1]['x-kade-claude-lane'], 'speak-first', 'research write-ups keep the lane Kade turned on');
    assert.equal(starts[1]['x-kade-outside-text'], undefined);
    process.env.KADE_CLAUDE_CALL_REPORTS = '1';
    await turn.speakFirst({ userId: 'u1', agentId: 'agent_test_123456', note: 'the call ended', kind: 'call', requested: true, beforePost: stop });
    assert.equal(starts[2]['x-kade-claude-lane'], 'speak-first', 'the switch puts call reports on the lane');
    assert.equal(starts[2]['x-kade-outside-text'], '1');
  } finally {
    if (saved === undefined) delete process.env.KADE_CLAUDE_CALL_REPORTS;
    else process.env.KADE_CLAUDE_CALL_REPORTS = saved;
  }
});

test('an urgent push says so to the bridge (quiet hours do not hold a call report); an ordinary one does not', async () => {
  const savedFetch = global.fetch;
  const savedSecret = process.env.BRIDGE_SECRET;
  const bodies = [];
  try {
    process.env.BRIDGE_SECRET = 'test-only';
    global.fetch = async (url, options = {}) => {
      bodies.push({ url: String(url), body: JSON.parse(options.body || '{}') });
      return { ok: true, json: async () => ({ ok: true, sent: 1 }) };
    };
    await turn.notifyPost({ userId: 'u1', agentId: 'agent_test_123456', agentName: 'Kiana', text: 'I called Shell.', conversationId: 'c1', requested: true, urgent: true });
    await turn.notifyPost({ userId: 'u1', agentId: 'agent_test_123456', agentName: 'Kiana', text: 'Research is done.', conversationId: 'c1', requested: true });
    assert.ok(bodies[0].url.endsWith('/notify'));
    assert.equal(bodies[0].body.urgent, true);
    assert.equal(bodies[0].body.requested, true);
    assert.equal('urgent' in bodies[1].body, false);
  } finally {
    global.fetch = savedFetch;
    if (savedSecret === undefined) delete process.env.BRIDGE_SECRET;
    else process.env.BRIDGE_SECRET = savedSecret;
  }
});

/* Verification round, Nov 14 2026: a call placed from a temporary chat sends that chat's id, but a post never
 * goes into a temporary chat, so the report went into the newest saved chat with that character from the last
 * 3 days (maybe about something else entirely), and the tap opened that chat. A call report whose chat is
 * temporary or gone now starts a new chat named for the call. The database is a stand-in here. */
test('VERIFY 16: a call report from a temporary or deleted chat starts a new chat named for the call, never an older one', async () => {
  const TEMP = '11111111-2222-4333-8444-555555555555';
  const GONE = '99999999-2222-4333-8444-555555555555';
  const OLDER = 'older-chat-about-something-else';
  const chats = { [TEMP]: { conversationId: TEMP, isTemporary: true } };
  const saved = [];
  const savedWait = process.env.KADE_POST_WAIT_MS;
  stubs.mongoose = { models: {
    Agent: { findOne: () => ({ select: () => ({ lean: async () => ({ id: 'agent_test_123456', name: 'Kiana', model: 'm' }) }) }) },
    Conversation: { findOne: (q) => ({
      select: () => ({ lean: async () => chats[q.conversationId] || null }),
      sort: () => ({ select: () => ({ lean: async () => ({ conversationId: OLDER }) }) }),
    }) },
    Message: { findOne: () => ({ sort: () => ({ select: () => ({ lean: async () => null }) }) }) },
  } };
  stubs['~/models'].saveConvo = async (_who, convo) => { saved.push(convo); return convo; };
  stubs['~/models'].saveMessage = async () => ({});
  stubs['@librechat/api'] = { GenerationJobManager: { getJobStatus: async () => undefined } };
  process.env.KADE_POST_WAIT_MS = '0';
  try {
    const post = (over) => turn.post({ userId: 'u1', agentId: 'agent_test_123456', text: 'I called Shell. They closed down last week.', kind: 'call', ...over });
    const fromTemp = await post({ conversationId: TEMP, title: 'Call to Shell' });
    assert.notEqual(fromTemp.conversationId, OLDER, 'not the older chat (before: it went there)');
    assert.equal(fromTemp.created, true);
    assert.equal(saved.find((c) => c.conversationId === fromTemp.conversationId && c.title).title, 'Call to Shell');
    const fromGone = await post({ conversationId: GONE });
    assert.notEqual(fromGone.conversationId, OLDER);
    assert.equal(saved.find((c) => c.conversationId === fromGone.conversationId && c.title).title, 'Phone call');
    // Unchanged: a call placed from a voice call has no chat id, so it goes to the newest chat (as the notes say),
    // and other kinds of message from a temporary chat go where they always went.
    assert.equal((await post({ conversationId: undefined })).conversationId, OLDER);
    assert.equal((await post({ conversationId: TEMP, kind: 'research' })).conversationId, OLDER);
  } finally {
    delete stubs.mongoose;
    delete stubs['@librechat/api'];
    if (savedWait === undefined) delete process.env.KADE_POST_WAIT_MS;
    else process.env.KADE_POST_WAIT_MS = savedWait;
  }
});
