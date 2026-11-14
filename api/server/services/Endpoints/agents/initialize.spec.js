const mongoose = require('mongoose');
const {
  ResourceType,
  PermissionBits,
  PrincipalType,
  PrincipalModel,
  MAX_SUBAGENT_DEPTH,
  MAX_SUBAGENT_GRAPH_NODES,
  Constants,
} = require('librechat-data-provider');
const { MongoMemoryServer } = require('mongodb-memory-server');

const mockInitializeAgent = jest.fn();
const mockValidateAgentModel = jest.fn();

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  createContentAggregator: jest.fn(() => ({
    contentParts: [],
    aggregateContent: jest.fn(),
  })),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  initializeAgent: (...args) => mockInitializeAgent(...args),
  validateAgentModel: (...args) => mockValidateAgentModel(...args),
  GenerationJobManager: { setCollectedUsage: jest.fn() },
  getCustomEndpointConfig: jest.fn(),
  createSequentialChainEdges: jest.fn(),
}));

/** Captured by the `getDefaultHandlers` mock so tests can drive the
 *  `ON_TOOL_EXECUTE` pipeline with a real subagent id and observe whether
 *  the tool context (agent, tool_resources, skill ACLs) was preserved. */
let capturedToolExecuteOptions;
jest.mock('~/server/controllers/agents/callbacks', () => ({
  createToolEndCallback: jest.fn(() => jest.fn()),
  getDefaultHandlers: jest.fn((opts) => {
    capturedToolExecuteOptions = opts?.toolExecuteOptions;
    return {};
  }),
}));

const mockLoadToolsForExecution = jest.fn();
jest.mock('~/server/services/ToolService', () => ({
  loadAgentTools: jest.fn(),
  loadToolsForExecution: (...args) => mockLoadToolsForExecution(...args),
}));

jest.mock('~/server/controllers/ModelController', () => ({
  getModelsConfig: jest.fn().mockResolvedValue({}),
}));

let agentClientArgs;
jest.mock('~/server/controllers/agents/client', () => {
  return jest.fn().mockImplementation((args) => {
    agentClientArgs = args;
    return {};
  });
});

jest.mock('./addedConvo', () => ({
  processAddedConvo: jest.fn().mockResolvedValue({ userMCPAuthMap: undefined }),
}));

jest.mock('~/cache', () => ({
  logViolation: jest.fn(),
}));

const { initializeClient } = require('./initialize');
const { getSkillToolDeps } = require('./skillDeps');
const { logger } = require('@librechat/data-schemas');
const { User, AclEntry } = require('~/db/models');
const { createAgent, createSkill } = require('~/models');

jest.spyOn(logger, 'warn').mockImplementation(() => {});

const PRIMARY_ID = 'agent_primary';
const TARGET_ID = 'agent_target';
const AUTHORIZED_ID = 'agent_authorized';

describe('initializeClient — processAgent ACL gate', () => {
  let mongoServer;
  let testUser;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    jest.clearAllMocks();
    agentClientArgs = undefined;

    testUser = await User.create({
      email: 'test@example.com',
      name: 'Test User',
      username: 'testuser',
      role: 'USER',
    });

    mockValidateAgentModel.mockResolvedValue({ isValid: true });
  });

  const makeReq = () => ({
    user: { id: testUser._id.toString(), role: 'USER' },
    body: { conversationId: 'conv_1', files: [] },
    config: { endpoints: {} },
    _resumableStreamId: null,
  });

  const makeEndpointOption = () => ({
    agent: Promise.resolve({
      id: PRIMARY_ID,
      name: 'Primary',
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
    }),
    model_parameters: { model: 'gpt-4' },
    endpoint: 'agents',
  });

  const makePrimaryConfig = (edges) => ({
    id: PRIMARY_ID,
    endpoint: 'agents',
    edges,
    toolDefinitions: [],
    toolRegistry: new Map(),
    userMCPAuthMap: null,
    tool_resources: {},
    resendFiles: true,
    maxContextTokens: 4096,
  });

  it('should skip handoff agent and filter its edge when user lacks VIEW access', async () => {
    await createAgent({
      id: TARGET_ID,
      name: 'Target Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [],
    });

    const edges = [{ from: PRIMARY_ID, to: TARGET_ID, edgeType: 'handoff' }];
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig(edges));

    await initializeClient({
      req: makeReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
    expect(agentClientArgs.agent.edges).toEqual([]);
  });

  it('should initialize handoff agent and keep its edge when user has VIEW access', async () => {
    const authorizedAgent = await createAgent({
      id: AUTHORIZED_ID,
      name: 'Authorized Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [],
    });

    await AclEntry.create({
      principalType: PrincipalType.USER,
      principalId: testUser._id,
      principalModel: PrincipalModel.USER,
      resourceType: ResourceType.AGENT,
      resourceId: authorizedAgent._id,
      permBits: PermissionBits.VIEW,
      grantedBy: testUser._id,
    });

    const edges = [{ from: PRIMARY_ID, to: AUTHORIZED_ID, edgeType: 'handoff' }];
    const requestAttachment = { file_id: 'request_file', filename: 'request.txt' };
    const primaryContextAttachment = { file_id: 'primary_context', filename: 'primary.txt' };
    const handoffContextAttachment = { file_id: 'handoff_context', filename: 'handoff.txt' };
    const primaryConfig = {
      ...makePrimaryConfig(edges),
      attachments: [primaryContextAttachment, requestAttachment],
      requestAttachments: [requestAttachment],
      agentContextAttachments: [primaryContextAttachment],
    };
    const handoffConfig = {
      id: AUTHORIZED_ID,
      edges: [],
      toolDefinitions: [],
      toolRegistry: new Map(),
      userMCPAuthMap: null,
      tool_resources: {},
      agentContextAttachments: [handoffContextAttachment],
    };

    let callCount = 0;
    mockInitializeAgent.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? Promise.resolve(primaryConfig) : Promise.resolve(handoffConfig);
    });

    await initializeClient({
      req: makeReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(mockInitializeAgent).toHaveBeenCalledTimes(2);
    expect(agentClientArgs.agent.edges).toHaveLength(1);
    expect(agentClientArgs.agent.edges[0].to).toBe(AUTHORIZED_ID);
    expect(agentClientArgs.attachments).toEqual([requestAttachment]);
    expect(agentClientArgs.agentContextAttachmentsByAgentId.get(PRIMARY_ID)).toEqual([
      primaryContextAttachment,
    ]);
    expect(agentClientArgs.agentContextAttachmentsByAgentId.get(AUTHORIZED_ID)).toEqual([
      handoffContextAttachment,
    ]);
  });

  it('does not enable skill authoring for VIEW-only shared skills', async () => {
    const { skill } = await createSkill({
      name: 'shared-view-only',
      description: 'Use for read-only sharing.',
      body: '# Shared view-only skill\n',
      author: new mongoose.Types.ObjectId(),
      authorName: 'Skill Owner',
    });
    await AclEntry.create({
      principalType: PrincipalType.USER,
      principalId: testUser._id,
      principalModel: PrincipalModel.USER,
      resourceType: ResourceType.SKILL,
      resourceId: skill._id,
      permBits: PermissionBits.VIEW,
      grantedBy: testUser._id,
    });

    const endpointOption = makeEndpointOption();
    endpointOption.agent = Promise.resolve({
      id: PRIMARY_ID,
      name: 'Primary',
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
      skills_enabled: true,
    });
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig([]));
    const req = makeReq();
    req.config.endpoints.agents = { capabilities: ['skills'] };
    const canCreateSkillSpy = jest
      .spyOn(getSkillToolDeps(), 'canCreateSkill')
      .mockResolvedValue(false);

    try {
      await initializeClient({
        req,
        res: {},
        signal: new AbortController().signal,
        endpointOption,
      });
    } finally {
      canCreateSkillSpy.mockRestore();
    }

    const initializeParams = mockInitializeAgent.mock.calls[0][0];
    expect(initializeParams.accessibleSkillIds.map(String)).toContain(skill._id.toString());
    expect(initializeParams.skillAuthoringAvailable).toBe(false);
  });

  it('enables skill authoring when model specs enable skills for an ephemeral agent', async () => {
    const endpointOption = makeEndpointOption();
    endpointOption.spec = 'spec-skills';
    endpointOption.agent = Promise.resolve({
      id: Constants.EPHEMERAL_AGENT_ID,
      name: 'Ephemeral Primary',
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
    });
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig([]));
    const req = makeReq();
    req.config.endpoints.agents = { capabilities: ['skills'] };
    req.config.modelSpecs = {
      list: [{ name: 'spec-skills', skills: true }],
    };
    const canCreateSkillSpy = jest
      .spyOn(getSkillToolDeps(), 'canCreateSkill')
      .mockResolvedValue(true);

    try {
      await initializeClient({
        req,
        res: {},
        signal: new AbortController().signal,
        endpointOption,
      });
    } finally {
      canCreateSkillSpy.mockRestore();
    }

    const initializeParams = mockInitializeAgent.mock.calls[0][0];
    expect(initializeParams.agent.skills_enabled).toBe(true);
    expect(initializeParams.skillAuthoringAvailable).toBe(true);
  });
});

describe('initializeClient — subagent loading', () => {
  const SUBAGENT_ID = 'agent_subagent_1';
  const DUPLICATE_SUBAGENT_ID = 'agent_subagent_dup';
  const HANDOFF_AND_SUB_ID = 'agent_handoff_and_sub';

  let mongoServer;
  let testUser;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    jest.clearAllMocks();
    agentClientArgs = undefined;
    capturedToolExecuteOptions = undefined;
    mockLoadToolsForExecution.mockReset();
    mockLoadToolsForExecution.mockResolvedValue({ loadedTools: [] });

    testUser = await User.create({
      email: 'subagent@example.com',
      name: 'Subagent User',
      username: 'subuser',
      role: 'USER',
    });

    mockValidateAgentModel.mockResolvedValue({ isValid: true });
  });

  /** Grant the test user VIEW on an agent so processAgent loads it. */
  const grantView = async (agentDoc) => {
    await AclEntry.create({
      principalType: PrincipalType.USER,
      principalId: testUser._id,
      principalModel: PrincipalModel.USER,
      resourceType: ResourceType.AGENT,
      resourceId: agentDoc._id,
      permBits: PermissionBits.VIEW,
      grantedBy: testUser._id,
    });
  };

  /** Build a request with the `subagents` capability enabled. */
  const makeSubagentReq = () => ({
    user: { id: testUser._id.toString(), role: 'USER' },
    body: { conversationId: 'conv_sub', files: [] },
    config: {
      endpoints: {
        agents: {
          capabilities: ['subagents'],
        },
      },
    },
    _resumableStreamId: null,
  });

  const makeEndpointOption = () => ({
    agent: Promise.resolve({
      id: PRIMARY_ID,
      name: 'Primary',
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
    }),
    model_parameters: { model: 'gpt-4' },
    endpoint: 'agents',
  });

  const makePrimaryConfig = ({ edges = [], subagents, agent_ids }) => ({
    id: PRIMARY_ID,
    endpoint: 'agents',
    edges,
    toolDefinitions: [],
    toolRegistry: new Map(),
    userMCPAuthMap: null,
    tool_resources: {},
    resendFiles: true,
    maxContextTokens: 4096,
    subagents,
    agent_ids,
  });

  const makeSubagentConfig = (id) => ({
    id,
    endpoint: 'agents',
    edges: [],
    toolDefinitions: [{ name: 'web', description: 'web', parameters: {} }],
    toolRegistry: new Map([['web', { name: 'web' }]]),
    userMCPAuthMap: null,
    tool_resources: { file_search: { file_ids: ['file_1'] } },
    accessibleSkillIds: ['skill_1'],
    actionsEnabled: true,
    resendFiles: false,
    maxContextTokens: 4096,
  });

  const makeNestedSubagentConfig = (id, childIds = []) => ({
    ...makeSubagentConfig(id),
    subagents: { enabled: true, allowSelf: false, agent_ids: childIds },
  });

  const createViewableAgent = async (id) => {
    const agent = await createAgent({
      id,
      name: id,
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [],
    });
    await grantView(agent);
    return agent;
  };

  it('loads a configured subagent, populates `subagentAgentConfigs`, and keeps it out of `agentConfigs`', async () => {
    const subAgent = await createAgent({
      id: SUBAGENT_ID,
      name: 'Explicit Subagent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: ['web'],
    });
    await grantView(subAgent);

    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: true, agent_ids: [SUBAGENT_ID] },
    });
    const subagentConfig = makeSubagentConfig(SUBAGENT_ID);

    let call = 0;
    let subagentConvoFileIds;
    mockInitializeAgent.mockImplementation(async (params, dbDeps) => {
      call += 1;
      if (call === 1) {
        return primaryConfig;
      }
      subagentConvoFileIds = await dbDeps.getConvoFiles(params.conversationId);
      return subagentConfig;
    });

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(mockInitializeAgent).toHaveBeenCalledTimes(2);
    const subagentDbDeps = mockInitializeAgent.mock.calls[1][1];
    expect(subagentDbDeps.getConvoFiles).toBeInstanceOf(Function);
    expect(subagentDbDeps.db).toBeUndefined();
    expect(subagentConvoFileIds).toEqual([]);

    /** The subagent's AgentConfig is attached to the primary for run.ts to
     *  turn into `SubagentConfig[]` on the parent's `AgentInputs`. */
    expect(agentClientArgs.agent.subagentAgentConfigs).toHaveLength(1);
    expect(agentClientArgs.agent.subagentAgentConfigs[0].id).toBe(SUBAGENT_ID);

    /** Subagent-only agents must NOT appear in `agentConfigs` — otherwise the
     *  graph would treat them as a parallel/handoff node. */
    expect(agentClientArgs.agentConfigs).toBeDefined();
    expect(agentClientArgs.agentConfigs.has(SUBAGENT_ID)).toBe(false);
  });

  it('preserves subagent tool context for ON_TOOL_EXECUTE (Codex P1 regression guard)', async () => {
    /** Verifies the Codex P1 fix: `agentToolContexts.delete(subagentId)` is
     *  NOT called for subagent-only agents, so when the child dispatches
     *  `ON_TOOL_EXECUTE` the parent can still resolve its tool context
     *  (agent, tool_resources, skill ACLs, actionsEnabled) to run tools
     *  with the right scope. We drive the real `loadTools` closure that
     *  `initializeClient` wires into `toolExecuteOptions`. */
    const subAgent = await createAgent({
      id: SUBAGENT_ID,
      name: 'Explicit Subagent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: ['web'],
    });
    await grantView(subAgent);

    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: [SUBAGENT_ID] },
    });
    const subagentConfig = makeSubagentConfig(SUBAGENT_ID);

    let call = 0;
    mockInitializeAgent.mockImplementation(() =>
      Promise.resolve(++call === 1 ? primaryConfig : subagentConfig),
    );

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(capturedToolExecuteOptions?.loadTools).toBeInstanceOf(Function);

    /** Invoke the real closure with the subagent's id. If `agentToolContexts`
     *  had been deleted (as in the pre-fix code), this would call
     *  `loadToolsForExecution` with `agent: undefined` — actions/resource-
     *  scoped tools would silently drop. */
    await capturedToolExecuteOptions.loadTools(['web'], SUBAGENT_ID);

    expect(mockLoadToolsForExecution).toHaveBeenCalledTimes(1);
    const arg = mockLoadToolsForExecution.mock.calls[0][0];
    expect(arg.agent).toBeDefined();
    expect(arg.agent.id).toBe(SUBAGENT_ID);
    expect(arg.toolRegistry).toBeInstanceOf(Map);
    expect(arg.tool_resources).toEqual({ file_search: { file_ids: ['file_1'] } });
    expect(arg.actionsEnabled).toBe(true);
  });

  it('threads run-scoped MCP tool definitions into ON_TOOL_EXECUTE loading', async () => {
    /** Regression guard for the request-scoped MCP/PTC handoff: the
     *  `mcpAvailableTools` discovered at run start must survive
     *  `buildAgentToolContext` and reach `loadToolsForExecution`, otherwise
     *  request-scoped servers reinitialize on every programmatic tool call
     *  and can trip the MCP circuit breaker under parallel calls. */
    const mcpTool = 'list_tables_mcp_ClickHouse';
    const mcpAvailableTools = {
      ClickHouse: {
        [mcpTool]: {
          type: 'function',
          function: {
            name: mcpTool,
            description: 'List tables',
            parameters: { type: 'object', properties: {} },
          },
        },
      },
    };
    const primaryConfig = {
      ...makePrimaryConfig({}),
      toolRegistry: new Map([[mcpTool, { name: mcpTool }]]),
      mcpAvailableTools,
    };
    mockInitializeAgent.mockResolvedValue(primaryConfig);

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(capturedToolExecuteOptions?.loadTools).toBeInstanceOf(Function);
    await capturedToolExecuteOptions.loadTools([mcpTool], PRIMARY_ID);

    expect(mockLoadToolsForExecution).toHaveBeenCalledTimes(1);
    expect(mockLoadToolsForExecution).toHaveBeenCalledWith(
      expect.objectContaining({ mcpAvailableTools }),
    );
  });

  it('deduplicates repeated ids in subagents.agent_ids', async () => {
    const subAgent = await createAgent({
      id: DUPLICATE_SUBAGENT_ID,
      name: 'Dup Subagent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [],
    });
    await grantView(subAgent);

    const primaryConfig = makePrimaryConfig({
      subagents: {
        enabled: true,
        allowSelf: false,
        /** Same id three times — the backend must not load the agent
         *  repeatedly and must not emit three SubagentConfig entries. */
        agent_ids: [DUPLICATE_SUBAGENT_ID, DUPLICATE_SUBAGENT_ID, DUPLICATE_SUBAGENT_ID],
      },
    });
    const subagentConfig = makeSubagentConfig(DUPLICATE_SUBAGENT_ID);

    let initCalls = 0;
    mockInitializeAgent.mockImplementation(() => {
      initCalls += 1;
      return Promise.resolve(initCalls === 1 ? primaryConfig : subagentConfig);
    });

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    /** One call for primary, one for the subagent — not four. */
    expect(mockInitializeAgent).toHaveBeenCalledTimes(2);
    expect(agentClientArgs.agent.subagentAgentConfigs).toHaveLength(1);
  });

  it('rejects nested subagent chains deeper than MAX_SUBAGENT_DEPTH', async () => {
    const ids = Array.from(
      { length: MAX_SUBAGENT_DEPTH + 1 },
      (_, index) => `agent_depth_${index}`,
    );
    for (const id of ids) {
      await createViewableAgent(id);
    }

    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: [ids[0]] },
    });
    const nestedConfigs = new Map(
      ids.map((id, index) => [
        id,
        makeNestedSubagentConfig(id, index < ids.length - 1 ? [ids[index + 1]] : []),
      ]),
    );

    mockInitializeAgent.mockImplementation(({ agent }) =>
      Promise.resolve(agent.id === PRIMARY_ID ? primaryConfig : nestedConfigs.get(agent.id)),
    );

    await expect(
      initializeClient({
        req: makeSubagentReq(),
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      }),
    ).rejects.toThrow(`maximum depth of ${MAX_SUBAGENT_DEPTH}`);
    expect(logger.warn).toHaveBeenCalledWith(
      '[initializeClient] Subagent graph depth limit exceeded',
      expect.objectContaining({
        agentId: `agent_depth_${MAX_SUBAGENT_DEPTH - 1}`,
        primaryAgentId: PRIMARY_ID,
        depth: MAX_SUBAGENT_DEPTH,
        maxSubagentDepth: MAX_SUBAGENT_DEPTH,
        childCount: 1,
      }),
    );
    expect(agentClientArgs).toBeUndefined();
  });

  it('preserves deeper path depth when a handoff root is also a nested subagent', async () => {
    const chainIds = Array.from(
      { length: MAX_SUBAGENT_DEPTH },
      (_, index) => `agent_overlap_depth_${index}`,
    );
    const allIds = [HANDOFF_AND_SUB_ID, ...chainIds];
    for (const id of allIds) {
      await createViewableAgent(id);
    }

    const edges = [{ from: PRIMARY_ID, to: HANDOFF_AND_SUB_ID, edgeType: 'handoff' }];
    const primaryConfig = makePrimaryConfig({
      edges,
      subagents: { enabled: true, allowSelf: false, agent_ids: [HANDOFF_AND_SUB_ID] },
    });
    const nestedConfigs = new Map([
      [HANDOFF_AND_SUB_ID, makeNestedSubagentConfig(HANDOFF_AND_SUB_ID, [chainIds[0]])],
      ...chainIds.map((id, index) => [
        id,
        makeNestedSubagentConfig(id, index < chainIds.length - 1 ? [chainIds[index + 1]] : []),
      ]),
    ]);

    mockInitializeAgent.mockImplementation(({ agent }) =>
      Promise.resolve(agent.id === PRIMARY_ID ? primaryConfig : nestedConfigs.get(agent.id)),
    );

    await expect(
      initializeClient({
        req: makeSubagentReq(),
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      }),
    ).rejects.toThrow(`maximum depth of ${MAX_SUBAGENT_DEPTH}`);
    expect(logger.warn).toHaveBeenCalledWith(
      '[initializeClient] Subagent graph depth limit exceeded',
      expect.objectContaining({
        primaryAgentId: PRIMARY_ID,
        depth: MAX_SUBAGENT_DEPTH,
        maxSubagentDepth: MAX_SUBAGENT_DEPTH,
        childCount: 1,
      }),
    );
    expect(agentClientArgs).toBeUndefined();
  });

  it('lets two agents that list each other (and a B <-> C pair below them) answer normally', async () => {
    const B = 'agent_mutual_b';
    const C = 'agent_mutual_c';
    for (const id of [B, C]) {
      await createViewableAgent(id);
    }
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: [B] },
    });
    const nestedConfigs = new Map([
      [B, makeNestedSubagentConfig(B, [PRIMARY_ID, C])],
      [C, makeNestedSubagentConfig(C, [B])],
    ]);
    mockInitializeAgent.mockImplementation(({ agent }) =>
      Promise.resolve(agent.id === PRIMARY_ID ? primaryConfig : nestedConfigs.get(agent.id)),
    );

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(agentClientArgs).toBeDefined();
    expect(agentClientArgs.agent.subagentAgentConfigs.map((config) => config.id)).toEqual([B]);
  });

  it('rejects subagent graphs that exceed MAX_SUBAGENT_GRAPH_NODES unique agents', async () => {
    const firstLevelIds = Array.from({ length: 10 }, (_, index) => `agent_graph_${index}`);
    const secondLevelIdsByParent = new Map(
      firstLevelIds.map((id) => [
        id,
        Array.from({ length: 5 }, (_, index) => `${id}_child_${index}`),
      ]),
    );
    const allIds = [...firstLevelIds, ...Array.from(secondLevelIdsByParent.values()).flat()];

    for (const id of allIds) {
      await createViewableAgent(id);
    }

    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: firstLevelIds },
    });
    const nestedConfigs = new Map(
      firstLevelIds.map((id) => [id, makeNestedSubagentConfig(id, secondLevelIdsByParent.get(id))]),
    );
    for (const id of Array.from(secondLevelIdsByParent.values()).flat()) {
      nestedConfigs.set(id, makeNestedSubagentConfig(id));
    }

    mockInitializeAgent.mockImplementation(({ agent }) =>
      Promise.resolve(agent.id === PRIMARY_ID ? primaryConfig : nestedConfigs.get(agent.id)),
    );

    await expect(
      initializeClient({
        req: makeSubagentReq(),
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      }),
    ).rejects.toThrow(`maximum of ${MAX_SUBAGENT_GRAPH_NODES} unique agents`);
    expect(logger.warn).toHaveBeenCalledWith(
      '[initializeClient] Subagent graph node limit exceeded',
      expect.objectContaining({
        primaryAgentId: PRIMARY_ID,
        loadedSubagentCount: MAX_SUBAGENT_GRAPH_NODES,
        maxSubagentGraphNodes: MAX_SUBAGENT_GRAPH_NODES,
      }),
    );
    expect(agentClientArgs).toBeUndefined();
  });

  it('keeps an agent in `agentConfigs` when it is BOTH a handoff target and a subagent', async () => {
    /** Overlap case: the same child is used both via handoff edges (needs to
     *  be in agentConfigs) and as a subagent (needs to be in
     *  subagentAgentConfigs, and its tool context preserved). The pipeline
     *  shouldn't silently drop it from the handoff map. */
    const shared = await createAgent({
      id: HANDOFF_AND_SUB_ID,
      name: 'Shared Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [],
    });
    await grantView(shared);

    const edges = [{ from: PRIMARY_ID, to: HANDOFF_AND_SUB_ID, edgeType: 'handoff' }];
    const primaryConfig = makePrimaryConfig({
      edges,
      subagents: {
        enabled: true,
        allowSelf: false,
        agent_ids: [HANDOFF_AND_SUB_ID],
      },
    });
    const sharedConfig = makeSubagentConfig(HANDOFF_AND_SUB_ID);

    let call = 0;
    mockInitializeAgent.mockImplementation(() =>
      Promise.resolve(++call === 1 ? primaryConfig : sharedConfig),
    );

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(agentClientArgs.agent.subagentAgentConfigs).toHaveLength(1);
    /** Shared agent must stay in agentConfigs — it's still the handoff target. */
    expect(agentClientArgs.agentConfigs.has(HANDOFF_AND_SUB_ID)).toBe(true);
  });

  it('clears subagents config on primary when the capability is disabled', async () => {
    /** Admin can turn subagents off at the endpoint level even if an agent was
     *  configured for them. The primary's `subagents` field should be
     *  suppressed so run.ts never builds a SubagentConfig. */
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: true, agent_ids: [] },
    });
    mockInitializeAgent.mockResolvedValue(primaryConfig);

    const req = makeSubagentReq();
    /** Remove the capability from the admin config. */
    req.config.endpoints.agents.capabilities = [];

    await initializeClient({
      req,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(agentClientArgs.agent.subagents).toBeUndefined();
    expect(agentClientArgs.agent.subagentAgentConfigs).toEqual([]);
  });

  it('clears subagents on handoff agents too when capability is disabled (Codex P2 regression)', async () => {
    /** Codex P2: the capability gate must suppress `subagents` on EVERY
     *  loaded config, not just the primary. `run.ts` iterates all agents
     *  and calls `buildSubagentConfigs` per agent, so a handoff target
     *  with `subagents.enabled: true` persisted on its document would
     *  otherwise still expose self-spawn even when the admin has disabled
     *  the capability globally. */
    const authorized = await createAgent({
      id: AUTHORIZED_ID,
      name: 'Handoff Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [],
    });
    await grantView(authorized);

    const edges = [{ from: PRIMARY_ID, to: AUTHORIZED_ID, edgeType: 'handoff' }];
    const primaryConfig = makePrimaryConfig({
      edges,
      subagents: { enabled: true, allowSelf: true, agent_ids: [] },
    });
    const handoffConfig = {
      id: AUTHORIZED_ID,
      endpoint: 'agents',
      edges: [],
      toolDefinitions: [],
      toolRegistry: new Map(),
      userMCPAuthMap: null,
      tool_resources: {},
      /** Handoff agent document has subagents enabled of its own accord. */
      subagents: { enabled: true, allowSelf: true, agent_ids: [] },
    };

    let callCount = 0;
    mockInitializeAgent.mockImplementation(() =>
      Promise.resolve(++callCount === 1 ? primaryConfig : handoffConfig),
    );

    const req = makeSubagentReq();
    /** Capability OFF at endpoint level. */
    req.config.endpoints.agents.capabilities = [];

    await initializeClient({
      req,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    /** Primary cleared. */
    expect(agentClientArgs.agent.subagents).toBeUndefined();
    /** Handoff target must ALSO be cleared — otherwise its self-spawn
     *  would still fire when run.ts iterates agentConfigs. */
    const handoffLoaded = agentClientArgs.agentConfigs.get(AUTHORIZED_ID);
    expect(handoffLoaded).toBeDefined();
    expect(handoffLoaded.subagents).toBeUndefined();
    expect(handoffLoaded.subagentAgentConfigs).toBeUndefined();
  });

  it('skips subagent loading entirely when the feature is disabled on the agent', async () => {
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: false, allowSelf: true, agent_ids: [SUBAGENT_ID] },
    });
    mockInitializeAgent.mockResolvedValue(primaryConfig);

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    /** Only one initializeAgent call — for the primary. No subagent loaded. */
    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
    expect(agentClientArgs.agent.subagentAgentConfigs).toEqual([]);
  });
});

/** KADE Sep 24 2026: agents asking Mrs. Witherspoon (library consultation). */
describe('initializeClient — library consultation', () => {
  const LIBRARIAN_ID = 'agent_o7TKU3lK0Euo0MKgpNpvZ';
  const SPECIALIST_ID = 'agent_specialist';
  const LIBRARIAN_TOOLS = [
    'kade_library',
    'kade_library_requests',
    'kade_research',
    'kade_wikipedia',
    'kade_help',
  ];
  const { loadAgentTools } = require('~/server/services/ToolService');
  const { consultationDescription } = require('@librechat/api');

  let mongoServer;
  let reader;
  let serviceSeat;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    jest.clearAllMocks();
    agentClientArgs = undefined;
    reader = await User.create({
      email: 'reader@example.com',
      name: 'Reader',
      username: 'reader',
      role: 'USER',
    });
    serviceSeat = await User.create({
      email: 'service@example.com',
      name: 'Service',
      username: 'service',
      role: 'ADMIN',
    });
    mockValidateAgentModel.mockResolvedValue({ isValid: true });
  });

  const grantView = async (agentDoc, user) => {
    await AclEntry.create({
      principalType: PrincipalType.USER,
      principalId: user._id,
      principalModel: PrincipalModel.USER,
      resourceType: ResourceType.AGENT,
      resourceId: agentDoc._id,
      permBits: PermissionBits.VIEW,
      grantedBy: user._id,
    });
  };

  const createLibrarian = async (viewer = reader) => {
    const doc = await createAgent({
      id: LIBRARIAN_ID,
      name: 'Mrs. Witherspoon',
      description: 'Her public description',
      instructions: 'You are Mrs. Witherspoon. %%%warm and bookish%%% Welcome readers.',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: LIBRARIAN_TOOLS,
    });
    await grantView(doc, viewer);
    return doc;
  };

  /** A fresh conversation per request: the consultation stays with a
   *  conversation once asked, and these tests must not share one. */
  let conversationCount = 0;
  const makeReq = (text, overrides = {}) => ({
    user: { id: reader._id.toString(), role: 'USER', kadeAccountType: 'child' },
    body: {
      conversationId: `conv_consult_${++conversationCount}`,
      parentMessageId: 'msg_parent',
      text,
      files: [{ file_id: 'photo' }],
    },
    config: { endpoints: { agents: { capabilities: ['subagents'] } } },
    _resumableStreamId: null,
    ...overrides,
  });

  const makeEndpointOption = (id = PRIMARY_ID) => ({
    agent: Promise.resolve({
      id,
      name: 'Kiana',
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
      instructions: 'You are Kiana.',
    }),
    model_parameters: { model: 'gpt-4' },
    endpoint: 'agents',
  });

  const makeConfig = (id, extra = {}) => ({
    id,
    name: id === PRIMARY_ID ? 'Kiana' : id,
    endpoint: 'agents',
    edges: [],
    model: 'gpt-4',
    instructions: 'You are Kiana.',
    toolDefinitions: [],
    toolRegistry: new Map(),
    userMCPAuthMap: null,
    tool_resources: {},
    resendFiles: true,
    maxContextTokens: 4096,
    ...extra,
  });

  /** Primary first; every later call is a child. Records each child's params. */
  const childParams = new Map();
  const runWith = async ({ req, primary, endpointOption = makeEndpointOption() }) => {
    childParams.clear();
    let call = 0;
    mockInitializeAgent.mockImplementation(async (params) => {
      call += 1;
      if (call === 1) {
        return primary;
      }
      childParams.set(params.agent.id, params);
      return makeConfig(params.agent.id, {
        name: params.agent.name,
        description: params.agent.description,
        instructions: params.agent.instructions,
      });
    });
    await initializeClient({ req, res: {}, signal: new AbortController().signal, endpointOption });
  };

  const toolsLoadedBy = async (params) => {
    loadAgentTools.mockClear();
    await params.loadTools({
      req: params.req,
      res: {},
      tools: params.agent.tools,
      model: 'gpt-4',
      agentId: params.agent.id,
      provider: 'openai',
    });
    return loadAgentTools.mock.calls[0][0].agent.tools;
  };

  it('offers the librarian on a library-shaped turn with the consultation profile', async () => {
    await createLibrarian();
    const primary = makeConfig(PRIMARY_ID);
    await runWith({ req: makeReq('Can you ask the librarian about Animorphs books?'), primary });

    expect(agentClientArgs.agent.subagents).toEqual({
      enabled: true,
      allowSelf: false,
      agent_ids: [LIBRARIAN_ID],
    });
    /** No standing instruction block rides the calling agent. */
    expect(agentClientArgs.agent.instructions).toBe('You are Kiana.');
    expect(agentClientArgs.agent.subagentAgentConfigs).toHaveLength(1);
    const librarian = agentClientArgs.agent.subagentAgentConfigs[0];
    expect(librarian.id).toBe(LIBRARIAN_ID);
    expect(librarian.description).toBe(consultationDescription());
    expect(librarian.subagents).toBeUndefined();
    expect(librarian.subagentMaxTurns).toBe(6);
    expect(agentClientArgs.agentConfigs.has(LIBRARIAN_ID)).toBe(false);

    const params = childParams.get(LIBRARIAN_ID);
    /** None of the person's attachments or conversation files. */
    expect(params.requestFiles).toEqual([]);
    expect(params.conversationId).toBeNull();
    expect(params.parentMessageId).toBeNull();
    /** Same request, so the same person's library access. */
    expect(params.req.user.id).toBe(reader._id.toString());
    /** Her persona without voice markup, the child note, then the consultation note. */
    expect(params.agent.instructions).not.toMatch(/%%%/);
    expect(params.agent.instructions).toMatch(/AUDIENCE NOTE[^]*CONSULTATION[^]*Kiana/);
    expect(await toolsLoadedBy(params)).toEqual(['kade_library', 'kade_wikipedia', 'kade_help']);
  });

  it('runs only her read-only tools, whatever tool name her model produces', async () => {
    await createLibrarian();
    mockLoadToolsForExecution.mockResolvedValue({ loadedTools: [] });
    await runWith({
      req: makeReq('Any audiobooks by Gary Paulsen?'),
      primary: makeConfig(PRIMARY_ID),
    });

    await capturedToolExecuteOptions.loadTools(
      ['kade_library', 'kade_research', 'kade_call_me'],
      LIBRARIAN_ID,
    );
    expect(mockLoadToolsForExecution.mock.calls[0][0].toolNames).toEqual(['kade_library']);

    /** The agent the person is talking to keeps its own tools. */
    await capturedToolExecuteOptions.loadTools(['kade_research'], PRIMARY_ID);
    expect(mockLoadToolsForExecution.mock.calls[1][0].toolNames).toEqual(['kade_research']);
  });

  it('leaves ordinary chat alone', async () => {
    await createLibrarian();
    await runWith({ req: makeReq('Tell me a joke'), primary: makeConfig(PRIMARY_ID) });
    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
    expect(agentClientArgs.agent.subagents).toBeUndefined();
  });

  it('never offers the librarian to herself', async () => {
    await createLibrarian();
    await runWith({
      req: makeReq('What old books do you have?'),
      primary: makeConfig(LIBRARIAN_ID),
      endpointOption: makeEndpointOption(LIBRARIAN_ID),
    });
    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
    expect(agentClientArgs.agent.subagents).toBeUndefined();
  });

  it('keeps configured specialists beside her, with their own tools and the audience notes', async () => {
    await createLibrarian();
    const specialist = await createAgent({
      id: SPECIALIST_ID,
      name: 'Specialist',
      instructions: 'You are a specialist.',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: ['kade_weather'],
    });
    await grantView(specialist, reader);
    const primary = makeConfig(PRIMARY_ID, {
      subagents: { enabled: true, allowSelf: false, agent_ids: [SPECIALIST_ID] },
    });
    const req = makeReq('Any old radio shows in the library?');
    await runWith({ req, primary });

    expect(agentClientArgs.agent.subagents.agent_ids).toEqual([SPECIALIST_ID, LIBRARIAN_ID]);
    const params = childParams.get(SPECIALIST_ID);
    expect(params.conversationId).toBe(req.body.conversationId);
    expect(params.agent.instructions).toMatch(/AUDIENCE NOTE/);
    expect(params.agent.instructions).not.toMatch(/CONSULTATION/);
    const tools = await toolsLoadedBy(params);
    expect(tools).toContain('kade_weather');
    expect(tools).toContain('kade_feedback');
    const specialistConfig = agentClientArgs.agent.subagentAgentConfigs.find(
      (config) => config.id === SPECIALIST_ID,
    );
    expect(specialistConfig.subagentMaxTurns).toBeUndefined();
  });

  it('loads children for the person really talking on the voice lane', async () => {
    await createLibrarian(reader);
    const specialist = await createAgent({
      id: SPECIALIST_ID,
      name: 'Service-only specialist',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [],
    });
    await grantView(specialist, serviceSeat);
    const req = makeReq('Any cassettes of old radio?', {
      user: { id: serviceSeat._id.toString(), role: 'ADMIN' },
      kadeOnBehalfOf: { id: reader._id.toString(), name: 'Reader', email: 'reader@example.com' },
    });
    const primary = makeConfig(PRIMARY_ID, {
      subagents: { enabled: true, allowSelf: false, agent_ids: [SPECIALIST_ID] },
    });
    await runWith({ req, primary });

    const loaded = agentClientArgs.agent.subagentAgentConfigs.map((config) => config.id);
    expect(loaded).toEqual([LIBRARIAN_ID]);
  });

  it('does nothing while the subagents capability is off', async () => {
    await createLibrarian();
    const req = makeReq('Do we have any VHS tapes?');
    req.config.endpoints.agents.capabilities = [];
    await runWith({ req, primary: makeConfig(PRIMARY_ID) });
    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
    expect(agentClientArgs.agent.subagents).toBeUndefined();
  });

  it("keeps the primary agent's no-web note when a child's tool selection differs", async () => {
    await createLibrarian();
    const req = makeReq('Is there an audiobook of Holes?');
    let call = 0;
    mockInitializeAgent.mockImplementation(async (params) => {
      call += 1;
      if (call === 1) {
        params.req._kadeToolRagNote = 'primary note';
        return makeConfig(PRIMARY_ID);
      }
      params.req._kadeToolRagNote = 'child note';
      return makeConfig(params.agent.id, { name: params.agent.name });
    });
    await initializeClient({
      req,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });
    expect(mockInitializeAgent).toHaveBeenCalledTimes(2);
    expect(req._kadeToolRagNote).toBe('primary note');
  });

  it("loads children without tool retrieval, so the caller's retrieval state is untouched", async () => {
    await createLibrarian();
    const specialist = await createAgent({
      id: SPECIALIST_ID,
      name: 'Specialist',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: ['kade_weather'],
    });
    await grantView(specialist, reader);
    const rag = require('~/server/services/kadeToolRetrieval');
    const selectTools = jest
      .spyOn(rag, 'selectTools')
      .mockResolvedValue({ keep: new Set(['kade_weather']), reason: 'test' });
    loadAgentTools.mockResolvedValue({ toolDefinitions: [{ name: 'kade_weather' }] });
    try {
      const primary = makeConfig(PRIMARY_ID, {
        subagents: { enabled: true, allowSelf: false, agent_ids: [SPECIALIST_ID] },
      });
      await runWith({ req: makeReq('Any old radio shows in the library?'), primary });
      for (const id of [SPECIALIST_ID, LIBRARIAN_ID]) {
        const params = childParams.get(id);
        await params.loadTools({
          req: params.req,
          res: {},
          tools: params.agent.tools,
          model: 'gpt-4',
          agentId: id,
          provider: 'openai',
        });
      }
      expect(selectTools).not.toHaveBeenCalled();
    } finally {
      selectTools.mockRestore();
      loadAgentTools.mockReset();
    }
  });

  /** A side-by-side chat stores the added agent under '<id>____1' (loadAddedAgent). */
  const ADDED_LIBRARIAN_ID = `${LIBRARIAN_ID}____1`;

  it('never turns a librarian already in the run (side-by-side chat) into a consultation', async () => {
    await createLibrarian();
    const { processAddedConvo } = require('./addedConvo');
    const sideBySide = makeConfig(ADDED_LIBRARIAN_ID, {
      name: 'Mrs. Witherspoon',
      tools: ['kade_library'],
    });
    processAddedConvo.mockImplementationOnce(async ({ agentConfigs }) => {
      agentConfigs.set(ADDED_LIBRARIAN_ID, sideBySide);
      return { userMCPAuthMap: undefined };
    });
    await runWith({
      req: makeReq('Do we have any Animorphs books?'),
      primary: makeConfig(PRIMARY_ID),
    });

    expect(agentClientArgs.agent.subagents).toBeUndefined();
    expect(agentClientArgs.agentConfigs.get(ADDED_LIBRARIAN_ID)).toBe(sideBySide);
    expect(agentClientArgs.agentConfigs.has(LIBRARIAN_ID)).toBe(false);
    expect(sideBySide.subagentMaxTurns).toBeUndefined();
  });

  it('keeps her in the run when a configured list names her while she is already there', async () => {
    await createLibrarian();
    const { processAddedConvo } = require('./addedConvo');
    const sideBySide = makeConfig(ADDED_LIBRARIAN_ID, { name: 'Mrs. Witherspoon' });
    processAddedConvo.mockImplementationOnce(async ({ agentConfigs }) => {
      agentConfigs.set(ADDED_LIBRARIAN_ID, sideBySide);
      return { userMCPAuthMap: undefined };
    });
    const primary = makeConfig(PRIMARY_ID, {
      subagents: { enabled: true, allowSelf: false, agent_ids: [LIBRARIAN_ID] },
    });
    await runWith({ req: makeReq('Tell me a joke'), primary });

    expect(agentClientArgs.agent.subagentAgentConfigs).toEqual([]);
    expect(agentClientArgs.agentConfigs.get(ADDED_LIBRARIAN_ID)).toBe(sideBySide);
  });

  it('turns self-spawn off unless KADE_SUBAGENT_ALLOW_SELF=1', async () => {
    const primary = () =>
      makeConfig(PRIMARY_ID, { subagents: { enabled: true, allowSelf: true, agent_ids: [] } });
    const first = primary();
    await runWith({ req: makeReq('Tell me a joke'), primary: first });
    expect(agentClientArgs.agent.subagents).toEqual({
      enabled: true,
      allowSelf: false,
      agent_ids: [],
    });

    process.env.KADE_SUBAGENT_ALLOW_SELF = '1';
    try {
      await runWith({ req: makeReq('Tell me a joke'), primary: primary() });
      expect(agentClientArgs.agent.subagents.allowSelf).toBe(true);
    } finally {
      delete process.env.KADE_SUBAGENT_ALLOW_SELF;
    }
  });

  it('remembers a phone caller between call turns, whose conversation ids are all fresh', async () => {
    await createLibrarian(reader);
    const onBehalf = {
      user: { id: serviceSeat._id.toString(), role: 'ADMIN' },
      kadeOnBehalfOf: { id: reader._id.toString(), name: 'Reader', email: 'reader@example.com' },
    };
    await runWith({
      req: makeReq('Do we have any Goosebumps books?', onBehalf),
      primary: makeConfig(PRIMARY_ID),
    });
    expect(agentClientArgs.agent.subagentAgentConfigs.map((config) => config.id)).toEqual([
      LIBRARIAN_ID,
    ]);

    await runWith({ req: makeReq('The second one', onBehalf), primary: makeConfig(PRIMARY_ID) });
    expect(agentClientArgs.agent.subagentAgentConfigs.map((config) => config.id)).toEqual([
      LIBRARIAN_ID,
    ]);
  });
});

/* KADE Nov 14 2026 — THE STABLE TOOL SET (KADE_CLAUDE_STABLE_TOOLS). A turn whose head carries the
 * verified-adult note goes to Claude, and any change to the tools throws Claude's whole prompt cache
 * away. With the switch at exactly "1", such a turn gets every tool the loader loaded, sorted by
 * name, every turn; every other account and lane narrows exactly as before, and what the loader
 * takes away for other reasons stays away. The unit half is services/kadeStableTools.nodetest.js. */
describe('initializeClient — stable tool set (KADE_CLAUDE_STABLE_TOOLS)', () => {
  const { loadAgentTools } = require('~/server/services/ToolService');
  const { applyKadeAudience } = require('./build');
  const rag = require('~/server/services/kadeToolRetrieval');

  /** Kiana's own list as saved Nov 13 2026 (agent_6llV0eMu4fmIaj8f2x1Sb), and the lookup browser
   *  she was given later that day. */
  const KIANA_TOOLS = [
    'context',
    'flux',
    'kade_phone_call',
    'kade_notify',
    'kade_weather',
    'kade_wikipedia',
    'kade_joke',
    'kade_news',
    'kade_read_page',
    'kade_adventure',
    'kade_games',
    'kade_feedback',
    'kade_code',
    'kade_help',
    'kade_transcribe',
    'kade_location',
    'kade_memory_search',
    'kade_research',
    'kade_drive_pc',
    'kade_living_memory',
    'kade_errand',
    'kade_council',
    'kade_make_file',
    'file_search',
    'web_search',
    'kade_lookup',
  ];
  /** Today's narrowing for these words, from the code before this change (no embed lane in tests,
   *  so the keywords decide). The same for every account that may have the tools. */
  const TODAY = {
    'tell me a joke': [
      'kade_notify',
      'kade_weather',
      'kade_joke',
      'kade_feedback',
      'kade_help',
      'kade_memory_search',
    ],
    'call my mom and tell her I will be late': [
      'kade_phone_call',
      'kade_notify',
      'kade_weather',
      'kade_feedback',
      'kade_help',
      'kade_memory_search',
      'kade_message',
    ],
  };
  const ENV = [
    'KADE_CLAUDE_STABLE_TOOLS',
    'KADE_LOOKUP_BROWSER_URL',
    'KADE_LOOKUP_BROWSER_SECRET',
    'KADE_ERRAND_WEB',
    'KADE_APP_REVIEW_USER_IDS',
    'KADE_NO_TOOLS_MODELS',
    'KADE_ADULT_NOTE',
  ];
  let mongoServer;
  let saved;
  let infoSpy;
  let personId;
  let conversations = 0;

  const ACCOUNTS = {
    adult: () => ({ id: personId, role: 'USER', kadeAccountType: 'adult' }),
    /* Kade's own seat: the admin, no type recorded. Gets the adult note; is not adult-TYPED. */
    admin: () => ({ id: personId, role: 'ADMIN' }),
    child: () => ({ id: personId, role: 'USER', kadeAccountType: 'child' }),
    teen: () => ({ id: personId, role: 'USER', kadeAccountType: 'teen' }),
    untyped: () => ({ id: personId, role: 'USER' }),
  };

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    jest.clearAllMocks();
    saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
    for (const name of ENV) {
      delete process.env[name];
    }
    /* The lookup browser is set up (a made-up address and secret). */
    process.env.KADE_LOOKUP_BROWSER_URL = 'https://lookup.example.test';
    process.env.KADE_LOOKUP_BROWSER_SECRET = 'made-up-secret-for-tests-0123456789';
    const person = await User.create({
      email: 'stable@example.com',
      name: 'Stable',
      username: 'stable',
      role: 'USER',
    });
    personId = person._id.toString();
    rag._resetForTests();
    mockValidateAgentModel.mockResolvedValue({ isValid: true });
    /* ToolService stands in: a definition for every name it is asked for except the context marker,
     * in the order asked (the record's order), with web_search's text when it is there. */
    loadAgentTools.mockImplementation(async ({ agent }) => {
      const names = agent.tools.filter((name) => name !== 'context');
      return {
        toolDefinitions: names.map((name) => ({
          name,
          description: `${name} does ${name} things`,
          parameters: { type: 'object', properties: {} },
        })),
        toolRegistry: new Map(names.map((name) => [name, { name }])),
        toolContextMap: names.includes('web_search') ? { web_search: 'web_search head block' } : {},
        dynamicToolContextMap: names.includes('web_search')
          ? { web_search: 'web_search runtime text' }
          : {},
      };
    });
    infoSpy = jest.spyOn(logger, 'info');
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    loadAgentTools.mockReset();
    infoSpy.mockRestore();
  });

  const setSwitch = (value) => {
    if (value === undefined) {
      delete process.env.KADE_CLAUDE_STABLE_TOOLS;
    } else {
      process.env.KADE_CLAUDE_STABLE_TOOLS = value;
    }
  };

  /** One turn: the agent gets its audience notes as build.js gives them, the client is set up, and
   *  the primary agent's own loader runs. Returns what that turn hands the run. */
  const turn = async ({
    user,
    text,
    tools = KIANA_TOOLS,
    conversationId,
    extra = {},
    body = {},
    instructions = 'You are Kiana.',
  }) => {
    const req = {
      user,
      body: {
        conversationId: conversationId || `conv_stable_${++conversations}`,
        parentMessageId: 'msg_parent',
        text,
        files: [],
        ...body,
      },
      config: { endpoints: {} },
      _resumableStreamId: null,
      ...extra,
    };
    const agent = applyKadeAudience(req)({
      id: PRIMARY_ID,
      name: 'Kiana',
      provider: 'openai',
      model: 'gpt-4',
      tools: [...tools],
      instructions,
    });
    let primary;
    mockInitializeAgent.mockImplementation(async (params) => {
      primary = primary || params;
      return {
        id: PRIMARY_ID,
        name: 'Kiana',
        endpoint: 'agents',
        edges: [],
        model: 'gpt-4',
        instructions: agent.instructions,
        toolDefinitions: [],
        toolRegistry: new Map(),
        userMCPAuthMap: null,
        tool_resources: {},
        resendFiles: true,
        maxContextTokens: 4096,
      };
    });
    await initializeClient({
      req,
      res: {},
      signal: new AbortController().signal,
      endpointOption: {
        agent: Promise.resolve(agent),
        model_parameters: { model: 'gpt-4' },
        endpoint: 'agents',
      },
    });
    loadAgentTools.mockClear();
    infoSpy.mockClear();
    const loaded = await primary.loadTools({
      req,
      res: {},
      tools: agent.tools,
      model: 'gpt-4',
      agentId: PRIMARY_ID,
      provider: 'openai',
    });
    const lines = infoSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => /^\[kade(ToolRag|StableTools)\]/.test(line));
    const asked = loadAgentTools.mock.calls[0][0].agent.tools;
    return {
      req,
      loaded,
      asked,
      names: (loaded?.toolDefinitions || []).map((definition) => definition.name),
      note: req._kadeToolRagNote,
      lines,
      /** Everything this turn hands the run, for byte-for-byte comparisons (timings taken out). */
      snapshot: JSON.stringify({
        asked,
        definitions: loaded?.toolDefinitions,
        toolContextMap: loaded?.toolContextMap,
        dynamicToolContextMap: loaded?.dynamicToolContextMap,
        note: req._kadeToolRagNote ?? null,
        lines: lines.map((line) => line.replace(/ \d+ms\b/, ' <ms>')),
      }),
    };
  };

  const everyAccount = () => [
    ...Object.entries(ACCOUNTS).map(([kind, make]) => ({ kind, user: make() })),
    /* a call from a number that names nobody known: the service seat, nobody's notes */
    { kind: 'unknown caller', user: ACCOUNTS.admin(), extra: { kadeOnBehalfOfUnresolved: true } },
  ];

  it('with the switch anything but exactly "1", every kind of account narrows exactly as today', async () => {
    for (const account of everyAccount()) {
      for (const text of Object.keys(TODAY)) {
        const snapshots = new Set();
        for (const value of [undefined, '', '0', 'true', ' 1', '1 ']) {
          setSwitch(value);
          rag._resetForTests();
          const result = await turn({
            user: account.user,
            text,
            conversationId: `conv_off_${account.kind}`,
            extra: account.extra,
          });
          expect(result.names).toEqual(TODAY[text]);
          expect(result.lines).toHaveLength(1);
          expect(result.lines[0]).toMatch(/^\[kadeToolRag\] agent=agent_primary kept=/);
          /* web_search was left off, so its text went with it and the no-web note rides the tail */
          expect(result.loaded.toolContextMap).toEqual({});
          expect(result.note).toBe(rag.noWebNote(new Set(TODAY[text])));
          snapshots.add(result.snapshot);
        }
        /* byte for byte the same, whatever the switch says when it is not exactly "1" */
        expect(snapshots.size).toBe(1);
      }
    }
  });

  it('switched on, a verified adult gets the same whole set in the same order on turns of different wording', async () => {
    setSwitch('1');
    const voiceAdult = {
      user: ACCOUNTS.admin(),
      extra: { kadeOnBehalfOf: { id: personId, name: 'Stable', kadeAccountType: 'adult' } },
    };
    for (const [kind, account, count] of [
      ['adult-typed account', { user: ACCOUNTS.adult() }, 35],
      [
        'the admin, no type recorded (no lookup tool: not adult-TYPED)',
        { user: ACCOUNTS.admin() },
        34,
      ],
      ['a call naming an adult-typed person', voiceAdult, 35],
    ]) {
      const conversationId = `conv_on_${kind}`;
      const one = await turn({ ...account, text: 'tell me a joke', conversationId });
      /* a later turn: other words, and the record's list in another order (an edit in the builder) */
      const two = await turn({
        ...account,
        text: "What's going on in the news tonight? And remind me to call Mom at six.",
        tools: [...KIANA_TOOLS].reverse(),
        conversationId,
      });
      const three = await turn({ ...account, text: 'ugh, long day. night night', conversationId });
      for (const later of [two, three]) {
        expect(later.names).toEqual(one.names);
        expect(JSON.stringify(later.loaded.toolDefinitions)).toBe(
          JSON.stringify(one.loaded.toolDefinitions),
        );
        expect(later.lines).toEqual(one.lines);
      }
      /* the whole loaded set, in name order: keyword-only tools and web_search included */
      expect(one.names).toEqual(one.asked.filter((name) => name !== 'context').sort());
      expect(one.names).toHaveLength(count);
      expect(one.names).toEqual(
        expect.arrayContaining([
          'web_search',
          'kade_studio',
          'kade_known',
          'kade_recall',
          'kade_phone_pairing',
          'kade_research',
        ]),
      );
      expect(one.names.includes('kade_lookup')).toBe(count === 35);
      /* the tool text that goes with the whole set: web_search's block in the head, no no-web note */
      expect(one.loaded.toolContextMap).toEqual({ web_search: 'web_search head block' });
      expect(one.loaded.dynamicToolContextMap).toEqual({ web_search: 'web_search runtime text' });
      expect([one.note, two.note, three.note]).toEqual([undefined, undefined, undefined]);
      /* one line a turn: the agent, the count and the set's fingerprint, none of the words */
      expect(one.lines).toEqual([
        expect.stringMatching(
          new RegExp(`^\\[kadeStableTools\\] agent=agent_primary tools=${count} set=[0-9a-f]{8}$`),
        ),
      ]);
    }
  });

  it('switched on, a child, a teen, an untyped account, an unknown caller and a probe still narrow as before', async () => {
    const probe = {
      kind: 'health probe (admin)',
      user: ACCOUNTS.admin(),
      instructions: 'KADE BARE PROBE: answer OK.',
    };
    const others = everyAccount().filter((account) => !['adult', 'admin'].includes(account.kind));
    for (const account of [...others, probe]) {
      for (const text of Object.keys(TODAY)) {
        const run = async (value) => {
          setSwitch(value);
          rag._resetForTests();
          return turn({
            user: account.user,
            text,
            conversationId: `conv_narrow_${account.kind}`,
            extra: account.extra,
            instructions: account.instructions,
          });
        };
        const off = await run(undefined);
        const on = await run('1');
        expect(on.snapshot).toBe(off.snapshot);
        expect(on.names).toEqual(TODAY[text]);
        expect(on.lines[0]).toMatch(/^\[kadeToolRag\]/);
      }
    }
  });

  it('switched on, what the loader takes away for other reasons stays away', async () => {
    setSwitch('1');
    const stableLine = /^\[kadeStableTools\] agent=agent_primary tools=\d+ set=/;
    const withoutLookup = async () => {
      const result = await turn({ user: ACCOUNTS.adult(), text: 'tell me a joke' });
      expect(result.lines).toEqual([expect.stringMatching(stableLine)]);
      expect(result.asked).not.toContain('kade_lookup');
      expect(result.names).not.toContain('kade_lookup');
      expect(result.names).toHaveLength(34);
    };
    /* the lookup browser switched off, then not set up at all */
    process.env.KADE_ERRAND_WEB = '0';
    await withoutLookup();
    delete process.env.KADE_ERRAND_WEB;
    delete process.env.KADE_LOOKUP_BROWSER_URL;
    await withoutLookup();
    process.env.KADE_LOOKUP_BROWSER_URL = 'https://lookup.example.test';

    /* the App Review seat never gets the funding tool */
    process.env.KADE_APP_REVIEW_USER_IDS = personId;
    const review = await turn({ user: ACCOUNTS.adult(), text: 'tell me a joke' });
    expect(review.lines).toEqual([expect.stringMatching(stableLine)]);
    expect(review.asked).not.toContain('kade_funding_balance');
    expect(review.names).not.toContain('kade_funding_balance');
    delete process.env.KADE_APP_REVIEW_USER_IDS;

    /* a model with no tools host gets no tools at all */
    process.env.KADE_NO_TOOLS_MODELS = 'gpt-4';
    const toolless = await turn({ user: ACCOUNTS.adult(), text: 'tell me a joke' });
    expect(toolless.asked).toEqual([]);
    expect(toolless.names).toEqual([]);
    expect(toolless.lines).toEqual([]);
    delete process.env.KADE_NO_TOOLS_MODELS;

    /* the adult note switched off: no verified-adult head, so the narrowing */
    process.env.KADE_ADULT_NOTE = '0';
    const noNote = await turn({ user: ACCOUNTS.adult(), text: 'tell me a joke' });
    expect(noNote.names).toEqual(TODAY['tell me a joke']);
    expect(noNote.lines[0]).toMatch(/^\[kadeToolRag\]/);
  });

  it('switched on, a background run still loses kade_lookup and keeps the narrowing; so does the morning brief', async () => {
    setSwitch('1');
    const background = await turn({
      user: ACCOUNTS.adult(),
      text: 'tell me a joke',
      extra: { kadeHiddenRun: true, kadeBackground: true },
    });
    expect(background.asked).not.toContain('kade_lookup');
    expect(background.names).not.toContain('kade_lookup');
    expect(background.names).toEqual(TODAY['tell me a joke']);
    expect(background.lines[0]).toMatch(/^\[kadeToolRag\]/);
    /* the same account with a person there gets the lookup browser and the whole set */
    const person = await turn({ user: ACCOUNTS.adult(), text: 'tell me a joke' });
    expect(person.names).toContain('kade_lookup');
    expect(person.lines[0]).toMatch(/^\[kadeStableTools\]/);

    const brief = await turn({
      user: ACCOUNTS.adult(),
      text: 'Write my morning brief: the weather and the news.',
      body: { kadeToolPolicy: 'morning-brief' },
    });
    expect(brief.asked.every((name) => ['kade_weather', 'kade_news'].includes(name))).toBe(true);
    expect(brief.lines[0]).toMatch(/^\[kadeToolRag\]/);
  });
});
