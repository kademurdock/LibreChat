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
    await librechatApi.forgetRelationshipImpressions({
      userId: 'person',
      agentId: 'friend',
      userEvidence: 'Please forget your private impressions of me.',
      evidence: 'Please forget your private impressions of me.',
    });
    const oldEvidence = 'I knowingly lied to you.';
    result =
      'SUMMARY: Factual context from old history.\nMY TAKE: An erased private accusation.\nRELATIONSHIP: ' +
      JSON.stringify({
        trust: {
          stance: 'negative',
          confidence: 'tentative',
          basis: 'dishonesty',
          reason: 'An old accusation.',
          evidence: oldEvidence,
          provenance: 'interaction',
        },
      });
    await writer.refreshSummaryFromText({
      ...args,
      userEvidence: oldEvidence,
      evidenceTurns: [{ text: oldEvidence, at: '2000-01-01T00:00:00Z' }],
    });
    const reset = await getMemorySummary('person', 'friend');
    assert.equal(reset.take, '');
    assert.deepEqual(reset.relationship, {});
    assert.equal(reset.impressionsReset, true);
    const { setMemoryClearCutoff } = require('@librechat/data-schemas');
    const cutoff = await setMemoryClearCutoff('person', 'friend');
    const oldCalls = calls;
    const freshAt = new Date(cutoff.getTime() + 1000);
    const freshEvidence = 'I enjoy talking about music with you.';
    assert.equal(
      await writer.refreshSummaryFromText({
        ...args,
        lastActivityAt: freshAt,
        userEvidence: oldEvidence,
        evidenceTurns: [{ text: oldEvidence, at: '2000-01-01' }],
      }),
      null,
    );
    assert.equal(
      await writer.refreshSummaryFromText({
        ...args,
        lastActivityAt: freshAt,
        userEvidence: oldEvidence + freshEvidence,
        evidenceTurns: [
          { text: oldEvidence, at: '2000-01-01' },
          { text: freshEvidence, at: freshAt },
        ],
      }),
      null,
    );
    assert.equal(
      await writer.refreshSummaryFromText({
        ...args,
        lastActivityAt: freshAt,
        userEvidence: oldEvidence,
        evidenceTurns: [{ text: oldEvidence, at: 'invalid' }],
      }),
      null,
    );
    assert.equal(calls, oldCalls, 'pre-Clear and mixed historical payloads incur no writer call');
    result = 'SUMMARY: Fresh factual music context.\nMY TAKE: A fresh conversation.';
    assert.equal(
      await writer.refreshSummaryFromText({
        ...args,
        lastActivityAt: freshAt,
        userEvidence: freshEvidence,
        evidenceTurns: [{ text: freshEvidence, at: freshAt }],
      }),
      'Fresh factual music context.',
    );
    assert.equal(calls, oldCalls + 1);
  } finally {
    Module._load = original;
    await mongoose.disconnect();
    await mongo.stop();
  }
});
