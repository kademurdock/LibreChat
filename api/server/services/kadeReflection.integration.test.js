const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  KadeMemorySummary,
  getMemorySummary,
  setMemorySummary,
} = require('../../models/kadeMemorySummary');

test('nightly memory uses real scoped messages, resumes its backlog and preserves concurrent updates', async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const Conversation = mongoose.model(
    'Conversation',
    new mongoose.Schema({
      conversationId: String,
      user: String,
      agent_id: String,
      updatedAt: Date,
    }),
  );
  const Message = mongoose.model(
    'Message',
    new mongoose.Schema({
      messageId: String,
      conversationId: String,
      user: String,
      text: String,
      content: Array,
      isCreatedByUser: Boolean,
      createdAt: Date,
    }),
  );
  const writes = [];
  const User = mongoose.model(
    'User',
    new mongoose.Schema({ _id: String, personalization: Object }),
  );
  const original = Module._load;
  Module._load = function (id, parent, main) {
    if (id === '~/models')
      return {
        getMessages: (query) => Message.find(query).lean(),
        getAgent: async () => ({ name: 'Test Companion' }),
        getUserById: (id) => User.findById(id).lean(),
      };
    // The paid model is the only external boundary replaced. Storage and selection are real.
    if (id === '~/server/services/kadeMemorySummary')
      return {
        refreshSummaryFromText: async (args) => {
          writes.push(args);
          const prior = await getMemorySummary(args.userId, args.agentId);
          return setMemorySummary(args.userId, args.agentId, {
            ...args,
            summary: args.conversationText,
            expectedRevision: prior?.revision || 0,
          });
        },
      };
    return original.apply(this, arguments);
  };
  try {
    await KadeMemorySummary.init();
    const { runSummarySweep } = require('./kadeMemorySummarySweep');
    const now = new Date();
    const earlier = new Date(now - 3 * 3600000);
    const later = new Date(now - 2 * 3600000);
    await User.insertMany([
      { _id: 'person' },
      { _id: 'other-person' },
      { _id: 'memory-off', personalization: { memories: false } },
    ]);
    await Conversation.insertMany([
      { conversationId: 'morning', user: 'person', agent_id: 'friend', updatedAt: earlier },
      { conversationId: 'evening', user: 'person', agent_id: 'friend', updatedAt: later },
      { conversationId: 'private', user: 'other-person', agent_id: 'friend', updatedAt: later },
      {
        conversationId: 'not-remembered',
        user: 'memory-off',
        agent_id: 'friend',
        updatedAt: later,
      },
    ]);
    await Message.insertMany([
      {
        messageId: 'a',
        conversationId: 'morning',
        user: 'person',
        text: 'The trip is tomorrow.',
        isCreatedByUser: true,
        createdAt: earlier,
      },
      {
        messageId: 'b',
        conversationId: 'evening',
        user: 'person',
        text: 'It has been canceled.',
        isCreatedByUser: true,
        createdAt: later,
      },
      {
        messageId: 'c',
        conversationId: 'evening',
        user: 'person',
        content: [{ type: 'text', text: 'I will remember the correction.' }],
        createdAt: later,
      },
      {
        messageId: 'secret',
        conversationId: 'private',
        user: 'other-person',
        text: 'Other person private text.',
        isCreatedByUser: true,
        createdAt: later,
      },
    ]);
    await setMemorySummary('quiet-person', 'friend', {
      summary: 'An old relationship.',
      learned: 'Something they taught me.',
      lastActivityAt: new Date(now - 90 * 86400000),
    });
    process.env.KADE_SUMMARY_MAX_MSGS = '2';
    await runSummarySweep();
    const first = writes.find((w) => w.userId === 'person');
    assert.equal(
      writes.some((w) => w.userId === 'memory-off'),
      false,
    );
    assert.match(first.conversationText, /The trip is tomorrow/);
    assert.match(first.conversationText, /It has been canceled/);
    assert.doesNotMatch(first.conversationText, /Other person private/);
    assert.equal((await getMemorySummary('person', 'friend')).nightlyCursor.pending, true);
    assert.ok(
      await getMemorySummary('quiet-person', 'friend'),
      'absence does not erase learned history',
    );
    writes.length = 0;
    // Shrink the discovery window past all source activity. Only the pending cursor selects it.
    process.env.KADE_SUMMARY_LOOKBACK_HOURS = '1';
    await runSummarySweep();
    const resumed = writes.find((w) => w.userId === 'person');
    assert.match(resumed.conversationText, /remember the correction/);
    assert.doesNotMatch(resumed.conversationText, /trip is tomorrow/);
    writes.length = 0;
    await runSummarySweep();
    assert.equal(writes.length, 0, 'already summarized turns cost no second model call');
    const prior = await getMemorySummary('person', 'friend');
    await setMemorySummary('person', 'friend', {
      summary: 'Newer update.',
      expectedRevision: prior.revision,
    });
    assert.equal(
      await setMemorySummary('person', 'friend', {
        summary: 'Stale update.',
        expectedRevision: prior.revision,
      }),
      null,
    );
    assert.equal((await getMemorySummary('person', 'friend')).summary, 'Newer update.');
  } finally {
    Module._load = original;
    delete process.env.KADE_SUMMARY_MAX_MSGS;
    delete process.env.KADE_SUMMARY_LOOKBACK_HOURS;
    await mongoose.disconnect();
    await mongo.stop();
  }
});
