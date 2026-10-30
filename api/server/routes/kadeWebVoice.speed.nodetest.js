'use strict';
/* Oct 30 2026: a web call's ticket carries the character's speed only with the character's own
 * builder voice. Before this, a listener's own voice kept the character's number, because the ticket
 * read it first and only overwrote it when the resolver answered with a number.
 * Run: node --test api/server/routes/kadeWebVoice.speed.nodetest.js */
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

let agent;
let resolve;
let personalPick;
const STUBS = {
  '@librechat/data-schemas': { logger: { warn() {}, error() {}, info() {} } },
  '~/server/middleware': { requireJwtAuth: (_req, _res, next) => next() },
  '~/models': { getAgent: async () => agent, findUser: async () => null },
  '~/models/kadeVoicePref': { getUserVoicePref: async () => personalPick },
  '~/models/kadeSpotter': { getSpotter: async () => null },
  '~/models/kadeSpotterAgent': { ensureSpotterAgent: async () => null },
  '~/server/services/kadeVoiceResolver': { resolveVoice: async () => resolve() },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return STUBS[request] ?? realLoad.call(this, request, parent, isMain);
};
process.env.KADE_CALL_INGEST_SECRET = 'test-only';
const router = require('./kadeWebVoice'); // the route also requires lazily, so the stubs stay on

const route = router.stack.find((layer) => layer.route?.path === '/ticket').route;
const handler = route.stack[route.stack.length - 1].handle;

const ticket = async () => {
  let body;
  await handler(
    { query: { agentId: 'agent_della' }, user: { id: 'u1', kadeAccountType: 'adult' } },
    {
      status() {
        return this;
      },
      json(value) {
        body = value;
      },
    },
  );
  return JSON.parse(Buffer.from(body.ticket.split('.')[0], 'base64url').toString());
};

const builderAgent = { name: 'Della', tts: { voiceId: 'Builder', speakingRate: 1.2 } };

test('the builder voice carries the character speed', async () => {
  agent = builderAgent;
  resolve = () => ({ voice: 'Builder', source: 'builder', rate: 1.2 });
  const got = await ticket();
  assert.deepStrictEqual([got.voiceId, got.rate], ['Builder', 1.2]);
});

test("a listener's own voice does not, even though the character has a speed", async () => {
  agent = builderAgent;
  resolve = () => ({ voice: 'Mine', source: 'personal', rate: null });
  const got = await ticket();
  assert.deepStrictEqual([got.voiceId, got.rate], ['Mine', null]);
});

test('with the resolver down, the fallback path keeps the same rule', async () => {
  agent = builderAgent;
  resolve = () => {
    throw new Error('resolver down');
  };
  personalPick = 'Mine';
  let got = await ticket();
  assert.deepStrictEqual([got.voiceId, got.rate], ['Mine', null]);

  personalPick = 'Builder';
  got = await ticket();
  assert.deepStrictEqual([got.voiceId, got.rate], ['Builder', 1.2]);

  personalPick = null;
  got = await ticket();
  assert.deepStrictEqual([got.voiceId, got.rate], ['Builder', 1.2]);
});
