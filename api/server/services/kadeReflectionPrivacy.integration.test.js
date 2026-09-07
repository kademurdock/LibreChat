const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
require('module-alias').addAlias('~', require('node:path').resolve(__dirname, '../..'));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const librechatApi = require('@librechat/api');
const {
  KadeMemorySummary,
  setMemorySummary,
  getMemorySummary,
} = require('../../models/kadeMemorySummary');

test('memory-off blocks relationship reads and writes, including an opt-out during generation', async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const User = mongoose.model(
    'User',
    new mongoose.Schema({ _id: String, personalization: Object }),
  );
  const original = Module._load;
  let calls = 0;
  let result = 'SUMMARY: New factual context.\nMY TAKE: My private view.';
  let turnOffDuringGeneration = false;
  Module._load = function (id, parent, main) {
    if (id === '~/models')
      return {
        getUserById: (userId) => User.findById(userId).lean(),
        getAgent: async () => ({ instructions: 'An invented test companion.' }),
      };
    if (id === '~/server/services/Config')
      return {
        getAppConfig: async () => ({
          memory: { agent: { provider: 'fixture', model: 'fixture' } },
        }),
      };
    if (id === '~/models/kadeCareNote') return { getCareNoteBlock: async () => '' };
    if (id === '@librechat/api')
      return { ...librechatApi, resolveMemoryAgentLLMConfig: async () => ({}) };
    if (id === '@librechat/agents/langchain/messages')
      return {
        HumanMessage: class {
          constructor(text) {
            this.content = text;
          }
        },
      };
    if (id === '@librechat/agents')
      return {
        Run: {
          create: async () => ({
            processStream: async () => {
              calls++;
              if (turnOffDuringGeneration)
                await User.updateOne(
                  { _id: 'person' },
                  { $set: { 'personalization.memories': false } },
                );
              return result;
            },
          }),
        },
      };
    return original.apply(this, arguments);
  };
  try {
    await KadeMemorySummary.init();
    await User.create({ _id: 'person', personalization: { memories: false } });
    await setMemorySummary('person', 'friend', {
      summary: 'Previous context.',
      take: 'Previous private view.',
    });
    const writer = require('./kadeMemorySummary');
    const args = {
      userId: 'person',
      agentId: 'friend',
      conversationText: 'User: An invented long enough conversation for the reflection writer.',
    };
    assert.equal(await writer.getRelationshipSummaryText('person', 'friend'), '');
    assert.equal(await writer.getRelationshipSummaryBlock('person', 'friend'), '');
    assert.equal(await writer.refreshSummaryFromText(args), null);
    assert.equal(calls, 0, 'memory-off incurs no writer call');
    await User.updateOne({ _id: 'person' }, { $set: { 'personalization.memories': true } });
    result = 'MY TAKE: Private view without the required summary.';
    assert.equal(await writer.refreshSummaryFromText(args), null);
    assert.equal((await getMemorySummary('person', 'friend')).summary, 'Previous context.');
    result = 'SUMMARY: New factual context.\nMY TAKE: My private view.';
    turnOffDuringGeneration = true;
    assert.equal(await writer.refreshSummaryFromText(args), null);
    assert.equal((await getMemorySummary('person', 'friend')).summary, 'Previous context.');
    turnOffDuringGeneration = false;
    await User.updateOne({ _id: 'person' }, { $set: { 'personalization.memories': true } });
    assert.equal(await writer.refreshSummaryFromText(args), 'New factual context.');
    assert.equal(
      await writer.getRelationshipSummaryText('person', 'friend'),
      'New factual context.',
    );
    assert.doesNotMatch(
      await writer.getRelationshipSummaryText('person', 'friend'),
      /private view/,
    );
  } finally {
    Module._load = original;
    await mongoose.disconnect();
    await mongo.stop();
  }
});
