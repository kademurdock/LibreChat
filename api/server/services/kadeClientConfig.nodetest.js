'use strict';
/* Nov 12 2026 (phase 3 A3): the pacing config the server owns.
 * Run: node --test api/server/services/kadeClientConfig.nodetest.js */
const test = require('node:test');
const assert = require('node:assert');
const { clientConfig } = require('./kadeClientConfig');
const { createKadeMessagesHandler } = require('./kadeMessagesRead');

test('legacy (default) answers exactly what the apps do today', () => {
  const config = clientConfig({});
  assert.strictEqual(config.version, 1);
  assert.strictEqual(config.pacing.mode, 'legacy');
  for (const lane of ['message', 'auth', 'speech', 'bulk', 'standard']) {
    assert.strictEqual(config.pacing.lanes[lane].minGapMs, 1500, lane);
  }
  assert.deepStrictEqual(config.pacing.unpaced, [
    '/api/agents/chat/stream/',
    '/api/agents/chat/abort',
  ]);
  assert.deepStrictEqual(config.limits, { ttsPerMinute: 200, messagesPerMinute: 40 });
});

test('lanes mode answers the verified IOS-13 numbers with default limits', () => {
  const config = clientConfig({ KADE_CLIENT_PACING: 'lanes' });
  assert.strictEqual(config.pacing.mode, 'lanes');
  assert.deepStrictEqual(config.pacing.lanes, {
    message: { minGapMs: 1500 },
    auth: { minGapMs: 1500 },
    speech: { minGapMs: 350 },
    bulk: { minGapMs: 1100 },
    standard: { minGapMs: 500 },
  });
});

test('lanes mode never goes faster than the real limiters', () => {
  const config = clientConfig({
    KADE_CLIENT_PACING: 'lanes',
    TTS_USER_MAX: '60',
    MESSAGE_USER_MAX: '20',
  });
  assert.strictEqual(config.pacing.lanes.speech.minGapMs, 1000);
  assert.strictEqual(config.pacing.lanes.message.minGapMs, 3000);
  assert.deepStrictEqual(config.limits, { ttsPerMinute: 60, messagesPerMinute: 20 });
  // nonsense values fall back to the defaults
  assert.deepStrictEqual(clientConfig({ TTS_USER_MAX: 'x', MESSAGE_USER_WINDOW: '-3' }).limits, {
    ttsPerMinute: 200,
    messagesPerMinute: 40,
  });
});

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('kade messages route: own rows, after filter, readableText added', async () => {
  let seen;
  const handler = createKadeMessagesHandler({
    getMessages: async (filter, select) => {
      seen = { filter, select };
      return [
        { messageId: 'a', text: '%%%warm%%% Hello **there**.' },
        { messageId: 'b', text: '', content: [{ type: 'tool_call' }] },
      ];
    },
    logger: { error() {} },
  });
  const res = fakeRes();
  await handler(
    {
      params: { conversationId: 'c-1' },
      query: { after: '2026-11-12T00:00:00Z' },
      user: { id: 'u1' },
    },
    res,
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(seen.filter.user, 'u1');
  assert.strictEqual(seen.filter.conversationId, 'c-1');
  /* Sweep 4.5 (Nov 13 2026): rows changed after the cursor come back too, not only new rows. */
  assert.strictEqual(seen.filter.createdAt, undefined);
  assert.strictEqual(seen.filter.$or.length, 2);
  assert.ok(seen.filter.$or[0].updatedAt.$gt instanceof Date);
  assert.ok(seen.filter.$or[1].createdAt.$gt instanceof Date);
  assert.strictEqual(seen.filter.$or[0].updatedAt.$gt.toISOString(), '2026-11-12T00:00:00.000Z');

  // KADE_MESSAGES_AFTER=created is the old filter; a bad date adds no filter at all.
  process.env.KADE_MESSAGES_AFTER = 'created';
  try {
    await handler(
      { params: { conversationId: 'c-1' }, query: { after: '2026-11-12T00:00:00Z' }, user: { id: 'u1' } },
      fakeRes(),
    );
    assert.ok(seen.filter.createdAt.$gt instanceof Date);
    assert.strictEqual(seen.filter.$or, undefined);
  } finally {
    delete process.env.KADE_MESSAGES_AFTER;
  }
  await handler(
    { params: { conversationId: 'c-1' }, query: { after: 'not a date' }, user: { id: 'u1' } },
    fakeRes(),
  );
  assert.strictEqual(seen.filter.createdAt, undefined);
  assert.strictEqual(seen.filter.$or, undefined);
  assert.strictEqual(seen.select, '-_id -__v -user');
  assert.strictEqual(res.body.messages[0].kade.readableText, 'Hello there.');
  assert.strictEqual(res.body.messages[0].text, '%%%warm%%% Hello **there**.');
  assert.strictEqual(res.body.messages[1].kade, undefined);

  const bad = fakeRes();
  await handler({ params: { conversationId: '{"$ne":1}' }, query: {}, user: { id: 'u1' } }, bad);
  assert.strictEqual(bad.statusCode, 400);

  const noAfter = fakeRes();
  await handler(
    { params: { conversationId: 'c-1' }, query: { after: 'not a date' }, user: { id: 'u1' } },
    noAfter,
  );
  assert.strictEqual(seen.filter.createdAt, undefined);
});
