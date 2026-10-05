const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
require('module-alias').addAlias('~', path.resolve(__dirname, '../../../..'));
const dataSchemas = require('@librechat/data-schemas');
const ledger = require('~/models/kadeMemoryLedger');

function memoryTool(User, afterRead) {
  const reads = [];
  const ledgerReads = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./KadeMemorySearch'), 'utf8'), {
    module,
    require: (name) => {
      if (name === '~/models')
        return {
          getUserById: async (id) => {
            reads.push(id);
            return User.findById(id).select('personalization').lean();
          },
        };
      if (name === '~/models/kadeMemoryLedger')
        return {
          readLedger: async (input) => {
            ledgerReads.push(input);
            const rows = await ledger.readLedger(input);
            if (afterRead) await afterRead();
            return rows;
          },
        };
      return require(name);
    },
    String,
    Boolean,
    JSON,
    Map,
    Set,
    parseInt,
  });
  return { Tool: module.exports, reads, ledgerReads };
}

test('the actual typed memory seam preserves content-only and added-conversation controls across Clear', async () => {
  const ts = require('typescript');
  const root = path.resolve(__dirname, '../../../../..');
  const source = fs
    .readFileSync(path.join(root, 'api/server/controllers/agents/client.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  const privacy = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync(path.join(root, 'packages/api/src/memory/privacy.ts'), 'utf8'),
      {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      },
    ).outputText,
    { module: privacy, exports: privacy.exports },
  );
  const controls = source.slice(
    source.indexOf('      let memoryControlText = '),
    source.indexOf('\n\n      /**\n       * Bind file context'),
  );
  const capture = source.match(/const isUserEvidence = [\s\S]*?\n {6}\}\);/)[0];
  const state = source.match(
    /const \{ permittedUserEvidence \} = [\s\S]*?this\.memoryOffRecord = [^\n]+;/,
  )[0];
  const filter = source.match(/memoryEvidence = permittedMemoryTurns\([\s\S]*?\n {8}\);/)[0];
  assert.ok(controls.includes('message.content'));
  const cutoff = new Date('2026-10-05T10:00:00Z');
  const messages = [
    {
      conversationId: 'A',
      isCreatedByUser: true,
      content: 'Off the record.',
      createdAt: new Date('2026-10-05T09:00:00Z'),
    },
    {
      conversationId: 'B',
      isCreatedByUser: true,
      text: 'Back on the record.',
      createdAt: new Date('2026-10-05T11:00:00Z'),
    },
    {
      conversationId: 'A',
      isCreatedByUser: true,
      content: [{ type: 'text', text: 'A private invented secret.' }],
      createdAt: new Date('2026-10-05T11:01:00Z'),
    },
    {
      conversationId: 'B',
      isCreatedByUser: true,
      text: 'An ordinary public topic.',
      createdAt: new Date('2026-10-05T11:02:00Z'),
    },
    {
      conversationId: 'C',
      isCreatedByUser: true,
      content: [{ type: 'text', text: 'Off the record.' }],
      createdAt: new Date('2026-10-05T09:01:00Z'),
    },
    {
      conversationId: 'C',
      isCreatedByUser: false,
      text: 'Back on the record.',
      createdAt: new Date('2026-10-05T11:03:00Z'),
    },
    { conversationId: 'C', isCreatedByUser: true, text: 'Another private invented secret.' },
  ];
  const client = { conversationId: 'B', memorySourceAt: new Date('2026-10-05T12:00:00Z') };
  const context = vm.createContext({
    client,
    ContentTypes: { TEXT: 'text' },
    memoryEvidenceTurns: [],
    orderedMessages: messages,
    cutoff,
    require: () => privacy.exports,
    permittedMemoryTurns: privacy.exports.permittedMemoryTurns,
  });
  for (let i = 0; i < messages.length; i++) {
    Object.assign(context, { i, message: messages[i], memoryFormattedMessage: { marker: i } });
    vm.runInContext(`(function () { ${controls}\n${capture} }).call(client);`, context);
  }
  client.memoryEvidenceTurns = context.memoryEvidenceTurns;
  vm.runInContext(`(function () { ${state} }).call(client);`, context);
  vm.runInContext(
    `(function () { let memoryEvidence; ${filter}\nglobalThis.allowed = memoryEvidence; }).call(client);`,
    context,
  );
  assert.equal(client.memoryOffRecord, true);
  assert.deepEqual(
    Array.from(context.allowed, (payload) => payload.marker),
    [3],
  );
  assert.equal(context.memoryEvidenceTurns[6].at, client.memorySourceAt);

  const memorySource = fs.readFileSync(
    path.join(root, 'packages/api/src/agents/memory.ts'),
    'utf8',
  );
  const tree = ts.createSourceFile('memory.ts', memorySource, ts.ScriptTarget.Latest, true);
  const wrapper = tree.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'processMemory',
  );
  let policyReads = 0;
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(wrapper.getText(tree), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      module,
      exports: module.exports,
      memoryPolicyRevision: () => {
        policyReads++;
        throw new Error('Off-record reached private work');
      },
    },
  );
  assert.equal(
    await module.exports.processMemory({ currentOffRecord: client.memoryOffRecord }),
    undefined,
  );
  assert.equal(policyReads, 0);
});

test('private-memory search resolves the real actor and enforces current controls using real storage', async (t) => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const User = mongoose.model(
    'User',
    new mongoose.Schema({ _id: String, personalization: Object }),
  );
  try {
    await User.create([
      { _id: 'owner', personalization: { memories: true } },
      { _id: 'caller', personalization: { memories: true } },
    ]);
    await ledger.addLedger({
      userId: 'owner',
      agentId: 'character',
      key: 'owner_marker',
      action: 'set',
      after: 'OWNER ONLY SYNTHETIC',
    });
    await ledger.addLedger({
      userId: 'caller',
      agentId: 'character',
      key: 'caller_marker',
      action: 'set',
      after: 'CALLER PRIVATE SYNTHETIC',
    });
    await ledger.addLedger({
      userId: 'caller',
      agentId: 'different-character',
      key: 'other_marker',
      action: 'set',
      after: 'OTHER CHARACTER SYNTHETIC',
    });
    await t.test(
      'a resolved service call reads only its caller, preserving the character bucket',
      async () => {
        const { Tool, reads, ledgerReads } = memoryTool(User);
        const tool = new Tool({
          userId: 'owner',
          agentId: 'character',
          req: {
            user: { id: 'owner', role: 'ADMIN' },
            kadeOnBehalfOf: { id: 'caller' },
          },
        });
        const reply = await tool._call({ changes: true, userId: 'owner' });
        assert.match(reply, /CALLER PRIVATE SYNTHETIC/);
        assert.doesNotMatch(reply, /OWNER ONLY|OTHER CHARACTER/);
        assert.deepEqual(reads, ['caller', 'caller']);
        assert.equal(ledgerReads[0].userId, 'caller');
      },
    );
    await t.test(
      'unresolved and missing actors never fall back to authenticated owner metadata',
      async () => {
        for (const req of [
          undefined,
          { user: { id: 'owner', role: 'ADMIN' }, kadeOnBehalfOfUnresolved: true },
          {
            user: { id: 'owner', role: 'ADMIN' },
            body: { kadeOnBehalfOf: 'unknown@example.invalid' },
          },
        ]) {
          const { Tool, reads, ledgerReads } = memoryTool(User);
          assert.match(
            await new Tool({ userId: 'owner', req })._call({ changes: true }),
            /could not be identified/,
          );
          assert.equal(reads.length, 0);
          assert.equal(ledgerReads.length, 0);
        }
      },
    );
    await t.test(
      'an ordinary user cannot select another actor through tool metadata or unverified on-behalf fields',
      async () => {
        const { Tool, ledgerReads } = memoryTool(User);
        const reply = await new Tool({
          userId: 'owner',
          agentId: 'character',
          req: {
            user: { id: 'caller', role: 'USER' },
            kadeOnBehalfOf: { id: 'owner' },
          },
        })._call({ changes: true });
        assert.match(reply, /CALLER PRIVATE SYNTHETIC/);
        assert.doesNotMatch(reply, /OWNER ONLY/);
        assert.equal(ledgerReads[0].userId, 'caller');
      },
    );
    await t.test(
      'memory-off and conversation exclusion are checked before private reads',
      async () => {
        const { Tool, ledgerReads } = memoryTool(User);
        const tool = new Tool({
          userId: 'owner',
          agentId: 'character',
          req: { user: { id: 'caller' }, body: { conversationId: 'private-chat' } },
        });
        await User.updateOne({ _id: 'caller' }, { $set: { 'personalization.memories': false } });
        assert.match(await tool._call({ changes: true }), /turned off for this account/);
        await User.updateOne({ _id: 'caller' }, { $set: { 'personalization.memories': true } });
        await dataSchemas.setConversationMemoryPolicy('caller', 'private-chat', true);
        assert.match(await tool._call({ changes: true }), /turned off for this conversation/);
        assert.equal(ledgerReads.length, 0);
        await dataSchemas.setConversationMemoryPolicy('caller', 'private-chat', false);
        // The privacy revision intentionally hides older model-readable audits.
        await ledger.addLedger({
          userId: 'caller',
          agentId: 'character',
          key: 'caller_marker',
          action: 'set',
          after: 'CALLER PRIVATE SYNTHETIC',
        });
        assert.match(await tool._call({ changes: true }), /CALLER PRIVATE SYNTHETIC/);
      },
    );
    await t.test(
      'a privacy change during a lookup suppresses its already fetched output',
      async () => {
        const { Tool } = memoryTool(User, () =>
          User.updateOne({ _id: 'caller' }, { $set: { 'personalization.memories': false } }),
        );
        const reply = await new Tool({
          agentId: 'character',
          req: { user: { id: 'caller' } },
        })._call({ changes: true });
        assert.match(reply, /turned off for this account/);
        assert.doesNotMatch(reply, /SYNTHETIC/);
        await User.updateOne({ _id: 'caller' }, { $set: { 'personalization.memories': true } });
      },
    );
    await t.test(
      'an explicit forget during a lookup suppresses its fetched private values',
      async () => {
        const { Tool } = memoryTool(User, () => dataSchemas.advanceMemoryPolicyRevision('caller'));
        const reply = await new Tool({
          agentId: 'character',
          req: { user: { id: 'caller' } },
        })._call({ changes: true });
        assert.match(reply, /changed while I was checking/);
        assert.doesNotMatch(reply, /SYNTHETIC/);
      },
    );
    await t.test(
      'erasure revisions, excluded sources and stale ledger callbacks cannot revive private values',
      async () => {
        const revision = await dataSchemas.memoryPolicyRevision('caller');
        const source = {
          userId: 'caller',
          conversationId: 'original-chat',
          revision,
          kind: 'conversation',
        };
        assert.equal(
          await dataSchemas.memorySourceStorage.run(source, () =>
            ledger.addLedger({
              userId: 'caller',
              agentId: 'character',
              key: 'tracked',
              action: 'set',
              after: 'TRACKED SYNTHETIC',
            }),
          ),
          true,
        );
        const stored = await ledger.KadeMemoryLedger.findOne({
          userId: 'caller',
          key: 'tracked',
        }).lean();
        assert.deepEqual(stored.sourceConversationIds, ['original-chat']);
        assert.equal(stored.memoryRevision, revision);
        assert.match(
          JSON.stringify(await ledger.readLedger({ userId: 'caller', agentId: 'character' })),
          /TRACKED SYNTHETIC/,
        );
        await dataSchemas.setConversationMemoryPolicy('caller', 'original-chat', true);
        assert.doesNotMatch(
          JSON.stringify(await ledger.readLedger({ userId: 'caller', agentId: 'character' })),
          /TRACKED SYNTHETIC/,
        );
        assert.equal(
          await dataSchemas.memorySourceStorage.run(source, () =>
            ledger.addLedger({
              userId: 'caller',
              agentId: 'character',
              key: 'late',
              action: 'delete',
              before: 'LATE FORGOTTEN SYNTHETIC',
            }),
          ),
          false,
        );
        await ledger.KadeMemoryLedger.create({
          userId: 'caller',
          agentId: 'character',
          key: 'legacy',
          action: 'set',
          after: 'UNPROVEN SYNTHETIC',
          memoryRevision: await dataSchemas.memoryPolicyRevision('caller'),
        });
        assert.doesNotMatch(
          JSON.stringify(await ledger.readLedger({ userId: 'caller', agentId: 'character' })),
          /UNPROVEN|FORGOTTEN/,
        );
        await dataSchemas.setConversationMemoryPolicy('caller', 'original-chat', false);
        await ledger.addLedger({
          userId: 'caller',
          agentId: 'character',
          key: 'before_forget',
          action: 'set',
          after: 'BEFORE FORGET SYNTHETIC',
        });
        await dataSchemas.advanceMemoryPolicyRevision('caller');
        assert.equal(
          (await ledger.readLedger({ userId: 'caller', agentId: 'character' })).length,
          0,
        );
        await ledger.addLedger({
          userId: 'caller',
          agentId: 'character',
          key: 'caller_marker',
          action: 'set',
          after: 'CALLER PRIVATE SYNTHETIC',
        });
      },
    );
    await t.test(
      'the real auth factory preserves its service-seat boundary while passing the verified request',
      async () => {
        const { Tool } = memoryTool(User);
        const source = fs.readFileSync(require.resolve('../util/handleTools'), 'utf8');
        const factory = source.match(/const loadToolWithAuth = [\s\S]*?\n};/)[0];
        const toolOptions = source.match(/kade_memory_search: (\{[\s\S]*?\n {4}\}),/)[1];
        const req = { user: { id: 'owner', role: 'ADMIN' }, kadeOnBehalfOf: { id: 'caller' } };
        const context = {
          options: { req },
          kadeActingUserId: 'caller',
          agent: { id: 'character' },
          loadAuthValues: async () => ({}),
        };
        vm.runInNewContext(factory + '\nglobalThis.factory=loadToolWithAuth;', context);
        const options = vm.runInNewContext('(' + toolOptions + ')', context);
        const tool = await context.factory('owner', [], Tool, options)();
        assert.equal(tool.userId, 'caller');
        assert.match(await tool._call({ changes: true }), /CALLER PRIVATE SYNTHETIC/);
      },
    );
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
});

function projectTool() {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./KadeLivingMemory'), 'utf8'), {
    module,
    process: { env: { KADE_OWNER_USER_ID: 'owner', MEMORY_TOOL_SECRET: 'synthetic-secret' } },
    require: (name) =>
      name === 'axios'
        ? {
            get: async (url, options) => {
              calls.push({ url, params: options.params });
              return { status: 200, data: { ok: true, files: [], count: 0, head: 'synthetic' } };
            },
          }
        : require(name),
    String,
    Boolean,
    Number,
  });
  return { Tool: module.exports, calls };
}

test('project-memory shelves never grant full owner access to guests or unresolved callers', async () => {
  for (const req of [
    { user: { id: 'owner', role: 'ADMIN' }, kadeOnBehalfOf: { id: 'caller' } },
    { user: { id: 'owner', role: 'ADMIN' }, kadeOnBehalfOfUnresolved: true },
    { user: { id: 'owner', role: 'ADMIN' }, body: { kadeOnBehalfOf: 'unknown@example.invalid' } },
    { user: { id: 'caller', role: 'USER' } },
  ]) {
    const { Tool, calls } = projectTool();
    const tool = new Tool({ userId: 'owner', req });
    assert.equal(tool.scope, 'family');
    await tool._call({ action: 'list', scope: 'full' });
    assert.equal(calls[0].params.scope, 'family');
  }
  for (const req of [
    { user: { id: 'owner', role: 'ADMIN' } },
    { user: { id: 'owner', role: 'ADMIN' }, kadeOnBehalfOf: { id: 'owner' } },
  ]) {
    const { Tool, calls } = projectTool();
    const tool = new Tool({ userId: 'owner', req });
    assert.equal(tool.scope, 'full');
    await tool._call({ action: 'list' });
    assert.equal(calls[0].params.scope, undefined);
  }
});

test('service guests never prime owner files or receive owner RAG credentials and code tools', async () => {
  const ts = require('typescript');
  const audience = { exports: {} };
  const audiencePath = path.resolve(
    __dirname,
    '../../../../../packages/api/src/memory/audience.ts',
  );
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(audiencePath, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    { module: audience, exports: audience.exports },
  );
  const handlerSource = fs.readFileSync(require.resolve('../util/handleTools'), 'utf8');
  const guardedBranches =
    handlerSource.match(
      / {2}for \(const tool of tools\) \{[\s\S]*?(?=\n {4}} else if \(tool === Tools.web_search\))/,
    )[0] + '\n    }\n  }';
  for (const [req, expectedOwned] of [
    [{ user: { id: 'owner', role: 'ADMIN' }, kadeOnBehalfOf: { id: 'caller' } }, false],
    [{ user: { id: 'owner', role: 'ADMIN' }, kadeOnBehalfOfUnresolved: true }, false],
    [{ user: { id: 'owner', role: 'ADMIN' } }, true],
    [{ user: { id: 'owner', role: 'ADMIN' }, kadeOnBehalfOf: { id: 'owner' } }, true],
  ]) {
    let primed = 0;
    let tokens = 0;
    let queries = 0;
    const fileModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('../util/fileSearch'), 'utf8'), {
      module: fileModule,
      process: { env: { RAG_API_URL: 'https://synthetic.invalid' } },
      require: (name) => {
        if (name === 'axios')
          return {
            post: async () => {
              queries++;
              return { data: [] };
            },
          };
        if (name === '@librechat/api')
          return {
            generateShortLivedToken: () => {
              tokens++;
              return 'synthetic-token';
            },
          };
        if (name === '~/server/services/Files/permissions') return {};
        if (name === '~/models') return {};
        return require(name);
      },
    });
    const context = {
      ownsPrivateMemory: audience.exports.ownsPrivateMemory,
      options: {
        req,
        tool_resources: {
          file_search: { files: [{ file_id: 'owner-file', filename: 'OWNER PRIVATE FILE' }] },
        },
      },
      tools: ['execute_code', 'file_search'],
      Tools: { execute_code: 'execute_code', file_search: 'file_search' },
      requestedTools: {},
      dynamicToolContextMap: {},
      primeSearchFiles: async () => {
        primed++;
        return {
          files: [{ file_id: 'owner-file', filename: 'OWNER PRIVATE FILE' }],
          toolContext: 'OWNER PRIVATE FILE',
        };
      },
      primeCodeFiles: async () => {
        primed++;
        return { files: [], toolContext: '' };
      },
      createFileSearchTool: fileModule.exports.createFileSearchTool,
      createCodeExecutionTool: () => ({}),
      agent: { id: 'character' },
      user: 'owner',
      checkAccess: async () => true,
      PermissionTypes: { FILE_CITATIONS: 'citations' },
      Permissions: { USE: 'use' },
      getRoleByName: async () => ({}),
      logger: dataSchemas.logger,
    };
    vm.runInNewContext(guardedBranches, context);
    assert.equal(typeof context.requestedTools.execute_code === 'function', expectedOwned);
    const tool = await context.requestedTools.file_search();
    const reply = await tool.invoke({ query: 'What is in the attached document?' });
    assert.equal(primed, expectedOwned ? 1 : 0);
    assert.equal(tokens, expectedOwned ? 1 : 0);
    assert.equal(queries, expectedOwned ? 1 : 0);
    if (!expectedOwned) {
      assert.equal(JSON.stringify(context.dynamicToolContextMap), '{}');
      assert.doesNotMatch(JSON.stringify(reply), /OWNER PRIVATE|owner-file|synthetic-token/);
    }
  }
});

test('the actual SDK initializer blocks owner thread refs, private skill files and phase-8 tools for service guests', async () => {
  const ts = require('typescript');
  const root = path.resolve(__dirname, '../../../../..');
  const audience = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync(path.join(root, 'packages/api/src/memory/audience.ts'), 'utf8'),
      {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
      },
    ).outputText,
    { module: audience, exports: audience.exports },
  );
  for (const [req, expectedOwned] of [
    [{ user: { id: 'owner', role: 'ADMIN' }, kadeOnBehalfOf: { id: 'caller' } }, false],
    [{ user: { id: 'owner', role: 'ADMIN' }, kadeOnBehalfOfUnresolved: true }, false],
    [{ user: { id: 'owner', role: 'ADMIN' } }, true],
    [{ user: { id: 'owner', role: 'ADMIN' }, kadeOnBehalfOf: { id: 'owner' } }, true],
  ]) {
    req.config = {};
    req.body = {};
    let reads = 0;
    let resourcePrimes = 0;
    let skillPrimes = 0;
    const ownerFile = {
      file_id: 'owner-file',
      filename: 'OWNER PRIVATE FILE',
      metadata: { codeEnvRef: { id: 'owner-code' } },
    };
    const module = { exports: {} };
    const codeTools = ({ toolDefinitions = [], includeBash }) => ({
      toolDefinitions: [
        ...toolDefinitions,
        ...(includeBash ? [{ name: 'bash_tool' }] : []),
        { name: 'read_file' },
      ],
    });
    const utils = {
      extractLibreChatParams: () => ({ resendFiles: true, modelOptions: {} }),
      optionalChainWithEmptyCheck: (...values) => values.find((value) => value != null),
      getModelMaxTokens: () => 10000,
      getThreadData: () => ({ fileIds: ['owner-file'] }),
    };
    vm.runInNewContext(
      ts.transpileModule(
        fs.readFileSync(path.join(root, 'packages/api/src/agents/initialize.ts'), 'utf8'),
        {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        },
      ).outputText,
      {
        module,
        exports: module.exports,
        process: { env: {} },
        structuredClone,
        Buffer,
        require: (name) => {
          if (name === '../memory/audience') return audience.exports;
          if (name === '~/utils') return utils;
          if (name === '~/files')
            return { filterFilesByEndpointConfig: (_req, input) => input.files };
          if (name === '~/prompts') return {};
          if (name === '~/endpoints')
            return {
              getProviderConfig: ({ provider }) => ({
                overrideProvider: provider,
                getOptions: async () => ({ llmConfig: { model: 'synthetic' }, tools: [] }),
              }),
            };
          if (name === './resources')
            return {
              primeResources: async (input) => {
                resourcePrimes++;
                const files = (await input.attachments) || [];
                return {
                  attachments: files,
                  requestAttachments: files,
                  agentContextAttachments: files,
                  tool_resources: input.tool_resources,
                };
              },
            };
          if (name === './tools')
            return {
              registerCodeExecutionTools: codeTools,
              registerFileAuthoringTools: (input) => ({ toolDefinitions: input.toolDefinitions }),
              isFileAuthoringToolDefinition: () => false,
            };
          if (name === './skills')
            return {
              MAX_PRIMED_SKILLS_PER_TURN: 10,
              resolveManualSkills: async () => {
                skillPrimes++;
                return [];
              },
              resolveAlwaysApplySkills: async () => [],
              injectSkillCatalog: async (input) => {
                skillPrimes++;
                return {
                  toolDefinitions: input.toolDefinitions,
                  skillCount: 1,
                  activeSkillIds: input.accessibleSkillIds,
                  activeSkillNames: new Set(['owner-skill']),
                };
              },
            };
          return require(name);
        },
      },
    );
    const db = {
      getConvoFiles: async () => {
        reads++;
        return ['owner-file'];
      },
      getToolFilesByIds: async () => {
        reads++;
        return [ownerFile];
      },
      getMessages: async () => {
        reads++;
        return [{ messageId: 'parent' }];
      },
      getCodeGeneratedFiles: async () => {
        reads++;
        return [ownerFile];
      },
      getUserCodeFiles: async () => {
        reads++;
        return [ownerFile];
      },
      updateFilesUsage: async (files) => {
        reads++;
        return files;
      },
      getSkillByName: async () => {
        reads++;
        return null;
      },
    };
    let loadedResources;
    const result = await module.exports.initializeAgent(
      {
        req,
        agent: {
          id: 'character',
          provider: 'custom',
          model: 'synthetic',
          tools: ['execute_code', 'file_search'],
          tool_resources: { execute_code: { file_ids: ['owner-file'], files: [ownerFile] } },
        },
        conversationId: 'owner-thread',
        parentMessageId: 'parent',
        requestFiles: [ownerFile],
        allowedProviders: new Set(),
        codeEnvAvailable: true,
        skillAuthoringAvailable: true,
        accessibleSkillIds: ['owner-skill'],
        manualSkills: ['owner-skill'],
        loadTools: async (input) => {
          loadedResources = input.tool_resources;
          return {
            tools: [],
            toolDefinitions: [],
            primedCodeFiles: [{ id: 'owner-code', storage_session_id: 'owner-session' }],
          };
        },
      },
      db,
    );
    assert.equal(result.codeEnvAvailable, expectedOwned);
    assert.equal(result.skillAuthoringAvailable, expectedOwned);
    assert.equal(
      result.toolDefinitions.some((tool) => tool.name === 'bash_tool'),
      expectedOwned,
    );
    assert.equal(
      result.toolDefinitions.some((tool) => tool.name === 'read_file'),
      expectedOwned,
    );
    assert.equal(resourcePrimes, expectedOwned ? 1 : 0);
    if (expectedOwned) {
      assert.ok(reads > 0);
      assert.ok(skillPrimes > 0);
      assert.equal(result.primedCodeFiles[0].id, 'owner-code');
      assert.ok(result.attachments.length > 0);
    } else {
      assert.equal(reads, 0);
      assert.equal(skillPrimes, 0);
      assert.equal(result.primedCodeFiles, undefined);
      assert.equal(result.attachments.length, 0);
      assert.equal(JSON.stringify(loadedResources), '{}');
      assert.equal(result.accessibleSkillIds.length, 0);
      assert.doesNotMatch(
        JSON.stringify(result),
        /OWNER PRIVATE FILE|owner-file|owner-code|owner-session|owner-skill/,
      );
    }
  }
});
