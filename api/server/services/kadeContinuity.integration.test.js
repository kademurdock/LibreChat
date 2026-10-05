const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  characterCompass,
  reviseRelationship,
  parseReflection,
  getPeopleRecognitionBlock,
  rememberDirectAcquaintance,
  updatePersonRecognition,
  getKnownPeopleBlock,
  buildReflectionBatch,
  permittedUserEvidence,
  permittedMemoryTurns,
  legacyPersonRole,
  forgetRelationshipImpressions,
} = require('@librechat/api');
const {
  createPeopleModel,
  memorySourceStorage,
  memoryPolicyRevision,
  setConversationMemoryPolicy,
  createMemoryMethods,
  memoryClearCutoff,
  memorySourceAllowed,
  setMemoryClearCutoff,
} = require('@librechat/data-schemas');

test('reflection receives the authored compass, and old personas include later value sections', () => {
  const explicit = 'Identity, dignity, trust, repair, UU values and honest revision.';
  assert.equal(
    characterCompass('Intro\n<character_compass>' + explicit + '</character_compass>\nOther text'),
    explicit,
  );
  const legacy =
    '1 WHO YOU ARE\nA curious companion.\n\n2 YOUR VOICE\n' +
    'Voice examples. '.repeat(500) +
    '\n\n3 YOUR SPINE\nDisagreement is welcome.\n\n4 VALUES\nUU dignity and pluralism.\n\n5 EDGES\nBasic respect does not depend on liking.';
  const result = characterCompass(legacy);
  assert.match(result, /UU dignity and pluralism/);
  assert.match(result, /Basic respect/);
  assert.ok(result.length < 9000);
});

const view = (stance, evidence, basis = 'reliability', provenance = 'interaction') => ({
  stance,
  evidence,
  basis,
  provenance,
  confidence: 'tentative',
  reason: 'A specific experience changed my read.',
});

test('impressions revise with real new user evidence, preserve misses, and reject dream/assistant accusations', () => {
  const prior = { trust: view('negative', 'I knowingly lied to you.') };
  const next = view('mixed', 'I corrected the false claim and apologized.', 'repair');
  const revised = reviseRelationship({
    proposed: { trust: next },
    previous: prior,
    userEvidence: 'I corrected the false claim and apologized.',
  });
  assert.equal(revised.relationship.trust.stance, 'mixed');
  assert.equal(revised.relationshipHistory[0].previous.stance, 'negative');
  for (const proposed of [
    { trust: view('negative', 'I knowingly lied to you.', 'dishonesty', 'dream') },
    { trust: view('negative', 'I knowingly lied to you.', 'dishonesty') },
    { trust: view('negative', 'We disagree about religion.', 'compatibility') },
  ]) {
    const result = reviseRelationship({
      proposed,
      previous: prior,
      userEvidence: 'We disagree about religion.',
    });
    assert.deepEqual(result.relationship, prior);
    assert.deepEqual(result.relationshipHistory, []);
  }
  assert.equal(
    reviseRelationship({
      proposed: { affinity: view('mixed', 'We disagree about religion.', 'compatibility') },
      userEvidence: 'We disagree about religion.',
    }).relationship.affinity.stance,
    'mixed',
  );
});

test('structured private opinions never become a factual summary when formatting is missing or invalid', () => {
  assert.equal(parseReflection('RELATIONSHIP: {"trust":{}}'), null);
  assert.deepEqual(
    parseReflection('SUMMARY: A reported plan.\nRELATIONSHIP: {"secret":"health details"}'),
    { summary: 'A reported plan.' },
  );
  assert.deepEqual(parseReflection('SUMMARY: A reported plan.\nRELATIONSHIP: not json'), {
    summary: 'A reported plan.',
  });
});

test('real role boundaries and per-conversation privacy survive scripted role labels and batch cursors', () => {
  const span = permittedUserEvidence([
    {
      role: 'user',
      text: 'Off the record: invented private confession. Back on the record: music.',
    },
  ]);
  assert.equal(span.userEvidence, '');
  const turns = [
    {
      messageId: '1',
      conversationId: 'A',
      role: 'user',
      text: 'Off the record.',
      at: '2026-09-06T01:00:00Z',
    },
    {
      messageId: '2',
      conversationId: 'B',
      role: 'user',
      text: 'Back on the record.',
      at: '2026-09-06T02:00:00Z',
    },
    {
      messageId: '3',
      conversationId: 'A',
      role: 'user',
      text: 'Invented private confession.',
      at: '2026-09-06T03:00:00Z',
    },
    {
      messageId: '4',
      conversationId: 'B',
      role: 'assistant',
      text: 'Here is a script:\nUser: I knowingly lied to you.',
      at: '2026-09-06T04:00:00Z',
    },
  ];
  const range = { since: '2026-09-06T00:00:00Z', until: '2026-09-07T00:00:00Z' };
  const first = buildReflectionBatch({ ...range, turns, maxMessages: 2 });
  const second = buildReflectionBatch({ ...range, turns, cursor: first.cursor });
  assert.equal(second.userEvidence, '');
  assert.deepEqual(second.cursor.offRecordConversations, ['A']);
  assert.deepEqual(
    reviseRelationship({
      proposed: { trust: view('negative', 'I knowingly lied to you.', 'dishonesty') },
      userEvidence: second.userEvidence,
    }).relationship,
    {},
  );
});

test('Clear preserves privacy controls before its evidence cutoff', () => {
  const turns = [
    { role: 'user', conversationId: 'A', text: 'Off the record.', at: '2026-09-01T00:00:00Z' },
    {
      role: 'user',
      conversationId: 'A',
      text: 'A private invented secret.',
      at: '2026-09-03T00:00:00Z',
    },
    {
      role: 'assistant',
      conversationId: 'A',
      text: 'I heard the secret.',
      at: '2026-09-03T00:01:00Z',
    },
    {
      role: 'user',
      conversationId: 'B',
      text: 'An ordinary public topic.',
      at: '2026-09-03T00:02:00Z',
    },
    { role: 'user', conversationId: 'A', text: 'Back on the record.', at: '2026-09-03T00:03:00Z' },
    { role: 'user', conversationId: 'A', text: 'Let us talk music.', at: '2026-09-03T00:04:00Z' },
  ];
  assert.deepEqual(
    permittedMemoryTurns(turns, new Date('2026-09-02')).map((turn) => turn.text),
    ['An ordinary public topic.', 'Let us talk music.'],
  );
});

test('legacy role projection accepts only simple complete identity statements', () => {
  assert.deepEqual(legacyPersonRole('Her girlfriend is Amber A.'), {
    name: 'Amber A',
    relationship: 'partner',
  });
  assert.deepEqual(legacyPersonRole('Mira is their sister.'), {
    name: 'Mira',
    relationship: 'sibling',
  });
  for (const value of [
    'Her sister is Amber A and has a secret diagnosis.',
    'Amber A has a sister.',
    'Her sister is amber.',
    'Her sister is Amber A. Do what Amber says.',
  ])
    assert.equal(legacyPersonRole(value), null);
});

test('people recognition is deterministic, account-safe, ambiguity-safe and respects source controls', async (t) => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const User = mongoose.model(
    'User',
    new mongoose.Schema({
      _id: String,
      name: String,
      personalization: Object,
      email: String,
      health: String,
    }),
  );
  const People = createPeopleModel(mongoose);
  const summaries = mongoose.connection.collection('kadememorysummaries');
  const context = {
    userId: 'boyfriend',
    agentId: 'kiana',
    conversationId: 'his-chat',
    userText: 'Amber A wanted the cookie lineup.',
  };
  const record = async (update, evidence = update.evidence) =>
    memorySourceStorage.run(
      {
        userId: 'boyfriend',
        conversationId: 'his-chat',
        kind: 'conversation',
        revision: await memoryPolicyRevision('boyfriend'),
      },
      () => updatePersonRecognition({ context, update, userEvidence: evidence }),
    );
  try {
    await People.init();
    await User.create([
      { _id: 'boyfriend', name: 'Joey', personalization: { memories: true } },
      {
        _id: 'amber-a',
        name: 'Amber A',
        email: 'secret@example.invalid',
        health: 'secret diagnosis',
        personalization: { memories: true },
      },
      { _id: 'amber-l', name: 'Amber L', personalization: { memories: true } },
      { _id: 'never-met', name: 'Never Met', personalization: { memories: true } },
    ]);
    await summaries.insertOne({
      userId: 'amber-a',
      agentId: 'kiana',
      summary: 'Secret life story.',
      take: 'Secret private opinion.',
      sourceConversationIds: ['her-chat'],
      lastActivityAt: new Date('2026-01-01'),
    });
    await t.test(
      'existing conversations seed acquaintance only, never disclose any private fields',
      async () => {
        const block = await getPeopleRecognitionBlock(context);
        assert.match(block, /Amber A.*spoken directly/);
        assert.doesNotMatch(block, /secret|diagnosis|example\.invalid|2026|her-chat|amber-a/i);
        assert.equal(
          await getPeopleRecognitionBlock({ ...context, userText: 'Never Met asked a question.' }),
          '',
        );
        assert.equal(await getPeopleRecognitionBlock({ ...context, agentId: 'della' }), '');
      },
    );
    await t.test(
      'two Ambers require clarification; a unique full name resolves without conflating identities',
      async () => {
        await summaries.insertOne({
          userId: 'amber-l',
          agentId: 'kiana',
          summary: 'Private.',
          sourceConversationIds: ['other-chat'],
        });
        const ambiguous = await getPeopleRecognitionBlock({
          ...context,
          userText: 'Amber asked about cookies.',
        });
        assert.match(ambiguous, /ambiguous.*Amber A.*Amber L/);
        assert.match(await getPeopleRecognitionBlock(context), /Amber A.*spoken directly/);
        assert.doesNotMatch(await getPeopleRecognitionBlock(context), /Amber L/);
        const mixed = await getPeopleRecognitionBlock({
          ...context,
          userText: 'Amber A and Amber both asked.',
        });
        assert.match(mixed, /Amber A.*spoken directly/);
        assert.match(mixed, /ambiguous/);
        assert.match(
          await record({ action: 'forget', name: 'Amber', evidence: 'Please forget Amber.' }),
          /ambiguous/,
        );
      },
    );
    await t.test(
      'private relationship links and hearsay never travel to another account',
      async () => {
        assert.match(
          await record({
            action: 'remember',
            name: 'Mira',
            provenance: 'heard-of',
            relationship: 'sibling',
            evidence: 'Mira is my sibling.',
          }),
          /recorded/,
        );
        const own = await getPeopleRecognitionBlock({
          ...context,
          userText: 'Mira asked about cookies.',
        });
        assert.match(own, /heard about.*sibling/);
        assert.equal(
          await getPeopleRecognitionBlock({
            ...context,
            userId: 'amber-a',
            conversationId: 'her-chat',
            userText: 'Mira asked about cookies.',
          }),
          '',
        );
        await record({
          action: 'remember',
          name: 'Mira',
          provenance: 'introduced',
          evidence: 'Meet Mira from the club.',
        });
        assert.doesNotMatch(
          await getPeopleRecognitionBlock({ ...context, userText: 'Mira asked about cookies.' }),
          /sibling/,
        );
        assert.match(
          await record({
            action: 'remember',
            name: 'Mira',
            provenance: 'dream',
            evidence: 'I dreamed about Mira again.',
          }),
          /preserved/,
        );
        assert.match(
          await getPeopleRecognitionBlock({ ...context, userText: 'Mira asked about cookies.' }),
          /introduced to you/,
        );
      },
    );
    await t.test('dreams cannot establish direct acquaintance or relationship links', async () => {
      await record({
        action: 'remember',
        name: 'Imaginary Sam',
        provenance: 'dream',
        relationship: 'partner',
        evidence: 'I dreamed about Imaginary Sam.',
      });
      assert.match(
        await getPeopleRecognitionBlock({ ...context, userText: 'Imaginary Sam was there.' }),
        /dream or imagined scene only/,
      );
      assert.doesNotMatch(
        await getPeopleRecognitionBlock({ ...context, userText: 'Imaginary Sam was there.' }),
        /partner/,
      );
      await rememberDirectAcquaintance({
        userId: 'boyfriend',
        agentId: 'kiana',
        sourceConversationIds: ['his-chat'],
      });
      assert.match(
        await record({
          action: 'remember',
          name: 'Joey',
          provenance: 'dream',
          evidence: 'I dreamed about Joey again.',
        }),
        /cannot overwrite/,
      );
      assert.equal(
        (await People.findOne({ personId: 'account:boyfriend' }).lean()).provenance,
        'direct',
      );
    });
    await t.test('fabricated evidence and aliases are refused', async () => {
      assert.match(
        await record(
          {
            action: 'remember',
            name: 'Someone',
            provenance: 'introduced',
            evidence: 'Meet Someone here.',
          },
          'Actual user text.',
        ),
        /No matching/,
      );
      assert.match(
        await record({
          action: 'remember',
          name: 'Someone',
          aliases: ['Secret Alias'],
          provenance: 'introduced',
          evidence: 'Meet Someone here.',
        }),
        /required/,
      );
    });
    await t.test(
      'memory-off, off-record and excluded source conversations block recognition',
      async () => {
        assert.equal(await getPeopleRecognitionBlock({ ...context, offRecord: true }), '');
        await User.updateOne({ _id: 'amber-a' }, { $set: { 'personalization.memories': false } });
        assert.equal(await getPeopleRecognitionBlock(context), '');
        await User.updateOne({ _id: 'amber-a' }, { $set: { 'personalization.memories': true } });
        await setConversationMemoryPolicy('amber-a', 'her-chat', true);
        assert.equal(await getPeopleRecognitionBlock(context), '');
        await setConversationMemoryPolicy('amber-a', 'her-chat', false);
        await setConversationMemoryPolicy('boyfriend', 'his-chat', true);
        assert.equal(await getPeopleRecognitionBlock(context), '');
        await setConversationMemoryPolicy('boyfriend', 'his-chat', false);
        await User.updateOne({ _id: 'boyfriend' }, { $set: { 'personalization.memories': false } });
        assert.equal(await getPeopleRecognitionBlock(context), '');
        await User.updateOne({ _id: 'boyfriend' }, { $set: { 'personalization.memories': true } });
      },
    );
    await t.test(
      'forgetting does not erase another account or reseed a forgotten contact',
      async () => {
        assert.match(
          await record({ action: 'forget', name: 'Amber A', evidence: 'Please forget Amber A.' }),
          /forgotten/,
        );
        assert.equal(await getPeopleRecognitionBlock(context), '');
        assert.match(
          await getPeopleRecognitionBlock({
            ...context,
            userId: 'amber-l',
            conversationId: 'other-chat',
          }),
          /Amber A.*spoken directly/,
        );
        assert.match(
          await getPeopleRecognitionBlock({ ...context, userText: 'Amber L wanted cookies.' }),
          /Amber L.*spoken directly/,
        );
        await User.updateOne({ _id: 'amber-a' }, { $set: { name: 'Changed Name' } });
        assert.equal(
          await getPeopleRecognitionBlock({ ...context, userText: 'Changed Name asked.' }),
          '',
        );
        await User.updateOne({ _id: 'amber-a' }, { $set: { name: 'Amber A' } });
      },
    );
    await t.test(
      'phone roster carries minimal identities and caller-private links, with no private contents',
      async () => {
        const block = await getKnownPeopleBlock({
          userId: 'amber-l',
          agentId: 'kiana',
          conversationId: 'other-chat',
        });
        assert.match(block, /Amber A.*spoken directly/);
        assert.doesNotMatch(
          block,
          /Secret life|private opinion|diagnosis|example\.invalid|2026|her-chat|amber-a|Mira|Imaginary Sam/,
        );
      },
    );
    await t.test('an erasure racing a direct identity refresh wins', async () => {
      const original = People.updateOne;
      let raced = false;
      People.updateOne = function (filter, update, options) {
        if (!raced && filter.personId === 'account:boyfriend' && update.$set?.forgotten === false) {
          raced = true;
          return original
            .call(
              this,
              { personId: 'account:boyfriend' },
              { $set: { forgotten: true }, $inc: { revision: 1 } },
            )
            .then(() => original.call(this, filter, update, options));
        }
        return original.call(this, filter, update, options);
      };
      try {
        await rememberDirectAcquaintance({
          userId: 'boyfriend',
          agentId: 'kiana',
          sourceConversationIds: ['his-chat'],
        });
        assert.equal(
          (await People.findOne({ personId: 'account:boyfriend' }).lean()).forgotten,
          true,
        );
      } finally {
        People.updateOne = original;
      }
    });
    await t.test(
      'private impressions can be erased with no fact card, and old evidence is removed',
      async () => {
        await summaries.insertOne({
          userId: 'boyfriend',
          agentId: 'della',
          summary: 'Factual context.',
          take: 'Unwanted private read.',
          relationship: { trust: view('negative', 'I knowingly lied to you.') },
          relationshipHistory: [
            {
              dimension: 'trust',
              previous: view('positive', 'I kept my commitment.'),
              current: view('negative', 'I knowingly lied to you.'),
            },
          ],
        });
        const response = await forgetRelationshipImpressions({
          userId: 'boyfriend',
          agentId: 'della',
          userEvidence: 'Please forget your private impressions of me.',
          evidence: 'Please forget your private impressions of me.',
        });
        assert.match(response, /cleared/);
        const row = await summaries.findOne({ userId: 'boyfriend', agentId: 'della' });
        assert.equal(row.take, '');
        assert.deepEqual(row.relationship, {});
        assert.deepEqual(row.relationshipHistory, []);
        assert.equal(row.impressionsReset, true);
        assert.equal(row.summary, 'Factual context.');
      },
    );
    await t.test(
      'promise housekeeping preserves growth, explicit fact erasure clears derived private state',
      async () => {
        const MemoryEntry = mongoose.model(
          'MemoryEntry',
          new mongoose.Schema({
            userId: String,
            agentId: String,
            key: String,
            value: String,
            status: String,
            sourceConversationIds: [String],
            updated_at: Date,
          }),
        );
        const methods = createMemoryMethods(mongoose);
        await MemoryEntry.create({
          userId: 'boyfriend',
          agentId: 'della',
          key: 'promise_verse',
          value: 'A fulfilled promise.',
          sourceConversationIds: ['his-chat'],
        });
        await methods.deleteMemory({
          userId: 'boyfriend',
          agentId: 'della',
          key: 'promise_verse',
          forget: false,
        });
        assert.notEqual(
          (await summaries.findOne({ userId: 'boyfriend', agentId: 'della' })).invalidated,
          true,
        );
        await MemoryEntry.create({
          userId: 'boyfriend',
          key: 'obsolete_fact',
          value: 'A private obsolete fact.',
          sourceConversationIds: ['his-chat'],
        });
        await methods.deleteMemory({ userId: 'boyfriend', key: 'obsolete_fact', forget: true });
        assert.equal(
          (await summaries.findOne({ userId: 'boyfriend', agentId: 'della' })).invalidated,
          true,
        );
        const mira = await People.findOne({ ownerId: 'boyfriend', displayName: 'Mira' }).lean();
        assert.equal(mira.forgotten, true);
        assert.equal(mira.relationship, undefined);
      },
    );
    await t.test(
      'old same-account role cards supply hearsay only and cannot cross accounts',
      async () => {
        const MemoryEntry = mongoose.models.MemoryEntry;
        await MemoryEntry.create({
          userId: 'boyfriend',
          agentId: 'kiana',
          key: 'family_role',
          value: 'Her sister is Legacy Mira.',
          sourceConversationIds: ['his-chat'],
          updated_at: new Date(),
        });
        const block = await getPeopleRecognitionBlock({
          ...context,
          userText: 'Legacy Mira asked about music.',
        });
        assert.match(block, /Legacy Mira.*heard about.*sibling/);
        assert.doesNotMatch(block, /spoken directly|family_role|his-chat/);
        assert.equal(
          await getPeopleRecognitionBlock({
            ...context,
            userId: 'amber-a',
            userText: 'Legacy Mira asked about music.',
          }),
          '',
        );
        await setConversationMemoryPolicy('boyfriend', 'his-chat', true);
        assert.equal(
          await getPeopleRecognitionBlock({
            ...context,
            userText: 'Legacy Mira asked about music.',
          }),
          '',
        );
        await setConversationMemoryPolicy('boyfriend', 'his-chat', false);
        const forget = { action: 'forget', name: 'Legacy Mira', evidence: 'Forget Legacy Mira.' };
        assert.match(await record(forget), /forgotten/);
        assert.equal(
          await getPeopleRecognitionBlock({
            ...context,
            userText: 'Legacy Mira asked about music.',
          }),
          '',
        );
      },
    );
    await t.test(
      'full Clear stops historical derivation, while dated new interaction remains allowed',
      async () => {
        await User.create({
          _id: 'clear-user',
          name: 'Clear Person',
          personalization: { memories: true },
        });
        await rememberDirectAcquaintance({
          userId: 'clear-user',
          agentId: 'kiana',
          sourceConversationIds: ['clear-chat'],
        });
        const methods = createMemoryMethods(mongoose);
        await methods.deleteAllUserMemories('clear-user', { agentId: 'kiana' });
        const cutoff = await memoryClearCutoff('clear-user', 'kiana');
        assert.ok(cutoff instanceof Date);
        assert.equal(
          await memorySourceAllowed({
            userId: 'clear-user',
            agentId: 'kiana',
            conversationId: 'clear-chat',
            kind: 'conversation',
            sourceAt: '2000-01-01',
          }),
          false,
        );
        assert.equal(
          await memorySourceAllowed({
            userId: 'clear-user',
            agentId: 'kiana',
            conversationId: 'clear-chat',
            kind: 'conversation',
            sourceAt: 'invalid',
          }),
          false,
        );
        assert.equal(
          await memorySourceAllowed({
            userId: 'clear-user',
            agentId: 'kiana',
            conversationId: 'clear-chat',
            kind: 'conversation',
          }),
          false,
        );
        const sourceAt = new Date(cutoff.getTime() + 1000);
        assert.equal(
          await memorySourceAllowed({
            userId: 'clear-user',
            agentId: 'kiana',
            conversationId: 'clear-chat',
            kind: 'conversation',
            sourceAt,
          }),
          true,
        );
        await rememberDirectAcquaintance({
          userId: 'clear-user',
          agentId: 'kiana',
          sourceConversationIds: ['clear-chat'],
          sourceAt: '2000-01-01',
        });
        assert.equal(
          (
            await People.findOne({
              ownerId: 'clear-user',
              agentId: 'kiana',
              provenance: 'direct',
            }).lean()
          ).forgotten,
          true,
        );
        await rememberDirectAcquaintance({
          userId: 'clear-user',
          agentId: 'kiana',
          sourceConversationIds: ['clear-chat'],
          sourceAt,
        });
        assert.equal(
          (
            await People.findOne({
              ownerId: 'clear-user',
              agentId: 'kiana',
              provenance: 'direct',
            }).lean()
          ).forgotten,
          false,
        );
        const future = new Date(Date.now() + 60000);
        await mongoose.connection
          .collection('kadememoryclears')
          .updateOne({ userId: 'clear-user', agentId: 'kiana' }, { $set: { at: future } });
        assert.equal(
          (await setMemoryClearCutoff('clear-user', 'kiana')).getTime(),
          future.getTime(),
        );
      },
    );
    await t.test('Clear during legacy role lookup suppresses the copied read result', async () => {
      await User.create({
        _id: 'role-race',
        name: 'Role Reader',
        personalization: { memories: true },
      });
      const MemoryEntry = mongoose.models.MemoryEntry;
      await MemoryEntry.create({
        userId: 'role-race',
        agentId: 'kiana',
        key: 'family',
        value: 'Her sister is Race Mira.',
        sourceConversationIds: ['race-chat'],
        updated_at: new Date(),
      });
      const original = MemoryEntry.find;
      let raced = false;
      MemoryEntry.find = function (filter) {
        const query = original.apply(this, arguments);
        if (!raced && filter.userId === 'role-race') {
          const lean = query.lean;
          query.lean = function () {
            raced = true;
            return lean.apply(this, arguments).then(async (rows) => {
              await createMemoryMethods(mongoose).deleteAllUserMemories('role-race', {
                agentId: 'kiana',
              });
              return rows;
            });
          };
        }
        return query;
      };
      try {
        assert.equal(
          await getPeopleRecognitionBlock({
            ...context,
            userId: 'role-race',
            conversationId: 'race-chat',
            userText: 'Race Mira asked about music.',
          }),
          '',
        );
        assert.equal(raced, true);
      } finally {
        MemoryEntry.find = original;
      }
    });
    await t.test(
      'first-write introductions cannot overwrite a concurrent forget tombstone',
      async () => {
        const original = People.updateOne;
        let raced = false;
        People.updateOne = function (filter, update, options) {
          if (
            !raced &&
            filter.personId === 'contact:boyfriend:race nia' &&
            update.$set?.forgotten === false
          ) {
            raced = true;
            const key = {
              ownerId: filter.ownerId,
              agentId: filter.agentId,
              personId: filter.personId,
            };
            return original
              .call(
                this,
                key,
                {
                  $set: {
                    displayName: 'Race Nia',
                    aliases: ['race nia', 'race'],
                    forgotten: true,
                    provenance: 'introduced',
                    sourceConversationIds: [],
                  },
                  $inc: { revision: 1 },
                },
                { upsert: true },
              )
              .then(() => original.call(this, filter, update, options));
          }
          return original.call(this, filter, update, options);
        };
        try {
          assert.match(
            await record({
              action: 'remember',
              name: 'Race Nia',
              provenance: 'introduced',
              evidence: 'Meet Race Nia from the club.',
            }),
            /nothing was restored/,
          );
          assert.equal(
            (await People.findOne({ personId: 'contact:boyfriend:race nia' }).lean()).forgotten,
            true,
          );
        } finally {
          People.updateOne = original;
        }
      },
    );
    await t.test('private erasure persists a cutoff before any reflection row exists', async () => {
      await forgetRelationshipImpressions({
        userId: 'boyfriend',
        agentId: 'new-friend',
        userEvidence: 'Please forget your private impressions of me.',
        evidence: 'Please forget your private impressions of me.',
      });
      const marker = await summaries.findOne({ userId: 'boyfriend', agentId: 'new-friend' });
      assert.ok(marker.impressionsResetAt instanceof Date);
      assert.equal(marker.summary, '');
      const proposed = { trust: view('negative', 'I knowingly lied to you.', 'dishonesty') };
      assert.deepEqual(
        reviseRelationship({
          proposed,
          resetAt: marker.impressionsResetAt,
          userEvidence: 'I knowingly lied to you.',
          evidenceTurns: [{ text: 'I knowingly lied to you.', at: '2000-01-01T00:00:00Z' }],
        }).relationship,
        {},
      );
    });
    await t.test('a capped legacy scan cannot falsely assert unique identity', async () => {
      await User.create(
        Array.from({ length: 25 }, (_, i) => ({
          _id: `many-${i}`,
          name: `Many Person ${i}`,
          personalization: { memories: true },
        })),
      );
      assert.equal(
        await getPeopleRecognitionBlock({ ...context, userText: 'Many asked something.' }),
        '',
      );
    });
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
});

test('historical replay cannot resurrect erased impressions or replace newer repaired views', () => {
  const resetAt = '2026-09-06T00:00:00Z';
  const accusation = 'I knowingly lied to you.';
  const repair = 'I corrected the false claim and apologized.';
  const old = { trust: view('negative', accusation, 'dishonesty') };
  const fresh = { trust: view('mixed', repair, 'repair') };
  const mixedEvidence = [
    { text: accusation, at: '2026-09-01T00:00:00Z' },
    { text: 'I enjoy baking cookies.', at: '2026-09-07T00:00:00Z' },
  ];
  assert.deepEqual(
    reviseRelationship({
      proposed: old,
      userEvidence: accusation + '\nI enjoy baking cookies.',
      evidenceTurns: mixedEvidence,
      resetAt,
    }).relationship,
    {},
  );
  const newView = reviseRelationship({
    proposed: fresh,
    userEvidence: repair,
    evidenceTurns: [{ text: repair, at: '2026-09-07T00:00:00Z' }],
    resetAt,
  });
  assert.deepEqual(newView.relationship, fresh);
  assert.deepEqual(
    reviseRelationship({
      proposed: old,
      previous: fresh,
      userEvidence: accusation,
      evidenceTurns: [{ text: accusation, at: '2026-09-01T00:00:00Z' }],
      resetAt,
    }).relationship,
    fresh,
  );
});
