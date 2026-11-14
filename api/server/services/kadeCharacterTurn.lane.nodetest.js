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
