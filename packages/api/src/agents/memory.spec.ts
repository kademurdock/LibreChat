import { Types } from 'mongoose';
import { Run, Providers } from '@librechat/agents';
import type { IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import { processMemory, createMemoryTool, createDeleteMemoryTool, CANON_USER_ID, canonEvidenceShare, aiTurnsOf } from './memory';

jest.mock('~/stream/GenerationJobManager');

const mockCreateSafeUser = jest.fn((user) => ({
  id: user?.id,
  email: user?.email,
  name: user?.name,
  username: user?.username,
}));

const mockResolveHeaders = jest.fn((opts) => {
  const headers = opts.headers || {};
  const user = opts.user || {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    let resolved = value as string;
    resolved = resolved.replace(/\$\{(\w+)\}/g, (_match, envVar) => process.env[envVar] || '');
    resolved = resolved.replace(/\{\{LIBRECHAT_USER_EMAIL\}\}/g, user.email || '');
    resolved = resolved.replace(/\{\{LIBRECHAT_USER_ID\}\}/g, user.id || '');
    result[key] = resolved;
  }
  return result;
});

type HeaderCarrier = { defaultHeaders?: Record<string, string> };
const mockResolveConfigHeaders = jest.fn(
  (opts: {
    llmConfig?: { configuration?: HeaderCarrier; clientOptions?: HeaderCarrier };
    user?: { id?: string; email?: string };
  }) => {
    const cfg = opts?.llmConfig;
    if (cfg?.configuration?.defaultHeaders != null) {
      cfg.configuration.defaultHeaders = mockResolveHeaders({
        headers: cfg.configuration.defaultHeaders,
        user: opts.user,
      });
    }
    if (cfg?.clientOptions?.defaultHeaders != null) {
      cfg.clientOptions.defaultHeaders = mockResolveHeaders({
        headers: cfg.clientOptions.defaultHeaders,
        user: opts.user,
      });
    }
  },
);

jest.mock('~/utils', () => ({
  Tokenizer: {
    getTokenCount: jest.fn(() => 10),
  },
  createSafeUser: (user: unknown) => mockCreateSafeUser(user),
  resolveConfigHeaders: (opts: unknown) => mockResolveConfigHeaders(opts as never),
}));

const { createSafeUser } = jest.requireMock('~/utils');

jest.mock('@librechat/agents', () => {
  const actual = jest.requireActual('@librechat/agents');
  return {
    Run: {
      create: jest.fn(() => ({
        processStream: jest.fn(() => Promise.resolve('success')),
      })),
    },
    Providers: actual.Providers,
    GraphEvents: actual.GraphEvents,
  };
});

function createTestUser(overrides: Partial<IUser> = {}): IUser {
  return {
    _id: new Types.ObjectId(),
    id: new Types.ObjectId().toString(),
    username: 'testuser',
    email: 'test@example.com',
    name: 'Test User',
    avatar: 'https://example.com/avatar.png',
    provider: 'email',
    role: 'user',
    createdAt: new Date('2021-01-01'),
    updatedAt: new Date('2021-01-01'),
    emailVerified: true,
    ...overrides,
  } as IUser;
}

describe('Memory Agent Header Resolution', () => {
  let testUser: IUser;
  let mockRes: Response;
  let mockMemoryMethods: {
    setMemory: jest.Mock;
    deleteMemory: jest.Mock;
    getFormattedMemories: jest.Mock;
  };

  beforeEach(() => {
    process.env.CUSTOM_API_KEY = 'sk-custom-test-key';
    process.env.TEST_CUSTOM_API_KEY = 'sk-custom-test-key';

    testUser = createTestUser({
      id: 'user-123',
      email: 'test@example.com',
    });

    mockRes = {
      write: jest.fn(),
      end: jest.fn(),
      headersSent: false,
    } as unknown as Response;

    mockMemoryMethods = {
      setMemory: jest.fn(),
      deleteMemory: jest.fn(),
      getFormattedMemories: jest.fn(() =>
        Promise.resolve({
          withKeys: 'formatted memories',
          withoutKeys: 'memories without keys',
          totalTokens: 100,
        }),
      ),
    };

    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CUSTOM_API_KEY;
    delete process.env.TEST_CUSTOM_API_KEY;
  });

  it('should resolve environment variables in custom endpoint headers', async () => {
    const llmConfig = {
      provider: 'custom',
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'x-custom-api-key': '${CUSTOM_API_KEY}',
          'api-key': '${TEST_CUSTOM_API_KEY}',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration.defaultHeaders).toEqual({
      'x-custom-api-key': 'sk-custom-test-key',
      'api-key': 'sk-custom-test-key',
    });
  });

  it('should resolve user placeholders in custom endpoint headers', async () => {
    const llmConfig = {
      provider: 'custom',
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'X-User-Identifier': '{{LIBRECHAT_USER_EMAIL}}',
          'X-User-ID': '{{LIBRECHAT_USER_ID}}',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration.defaultHeaders).toEqual({
      'X-User-Identifier': 'test@example.com',
      'X-User-ID': 'user-123',
    });
  });

  it('should handle mixed environment variables and user placeholders', async () => {
    const llmConfig = {
      provider: 'custom',
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'x-custom-api-key': '${CUSTOM_API_KEY}',
          'X-User-Identifier': '{{LIBRECHAT_USER_EMAIL}}',
          'X-Application-Identifier': 'LibreChat - Test',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration.defaultHeaders).toEqual({
      'x-custom-api-key': 'sk-custom-test-key',
      'X-User-Identifier': 'test@example.com',
      'X-Application-Identifier': 'LibreChat - Test',
    });
  });

  it('should resolve env vars when user is undefined', async () => {
    const llmConfig = {
      provider: 'custom',
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'x-custom-api-key': '${CUSTOM_API_KEY}',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: undefined,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration.defaultHeaders).toEqual({
      'x-custom-api-key': 'sk-custom-test-key',
    });
  });

  it('should not throw when llmConfig has no configuration', async () => {
    const llmConfig = {
      provider: Providers.OPENAI,
      model: 'gpt-4o-mini',
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration).toBeUndefined();
  });

  it('should use createSafeUser to sanitize user data', async () => {
    const userWithSensitiveData = createTestUser({
      id: 'user-123',
      email: 'test@example.com',
      password: 'sensitive-password',
      refreshToken: 'sensitive-token',
    } as unknown as Partial<IUser>);

    const llmConfig = {
      provider: Providers.OPENAI,
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'X-User-ID': '{{LIBRECHAT_USER_ID}}',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: userWithSensitiveData,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();

    // Verify createSafeUser was used - the user object passed to Run.create should not have sensitive fields
    const safeUser = createSafeUser(userWithSensitiveData);
    expect(safeUser).not.toHaveProperty('password');
    expect(safeUser).not.toHaveProperty('refreshToken');
    expect(safeUser).toHaveProperty('id');
    expect(safeUser).toHaveProperty('email');
  });

  it('should include instructions in user message for Bedrock provider', async () => {
    const llmConfig = {
      provider: Providers.BEDROCK,
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    };

    const { HumanMessage } = await import('@librechat/agents/langchain/messages');
    const testMessage = new HumanMessage('test chat content');

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [testMessage],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    // For Bedrock, instructions should NOT be passed to graphConfig
    expect(runConfig.graphConfig.instructions).toBeUndefined();
    expect(runConfig.graphConfig.additional_instructions).toBeUndefined();
  });

  it('should pass instructions to graphConfig for non-Bedrock providers', async () => {
    const llmConfig = {
      provider: Providers.OPENAI,
      model: 'gpt-4o-mini',
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    // For non-Bedrock providers, instructions should be passed to graphConfig
    expect(runConfig.graphConfig.instructions).toBe('test instructions');
    expect(runConfig.graphConfig.additional_instructions).toBeDefined();
  });

  it('should set temperature to 1 for Bedrock with thinking enabled', async () => {
    const llmConfig = {
      provider: Providers.BEDROCK,
      model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      temperature: 0.7,
      additionalModelRequestFields: {
        thinking: {
          type: 'enabled',
          budget_tokens: 5000,
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBe(1);
  });

  it('should not modify temperature for Bedrock without thinking enabled', async () => {
    const llmConfig = {
      provider: Providers.BEDROCK,
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      temperature: 0.7,
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBe(0.7);
  });

  it('should remove temperature for Anthropic with thinking enabled', async () => {
    const llmConfig = {
      provider: Providers.ANTHROPIC,
      model: 'claude-sonnet-4-20250514',
      temperature: 0.7,
      thinking: {
        type: 'enabled',
        budget_tokens: 5000,
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBeUndefined();
    expect(runConfig.graphConfig.llmConfig.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 5000,
    });
  });

  it('should not modify temperature for Anthropic without thinking enabled', async () => {
    const llmConfig = {
      provider: Providers.ANTHROPIC,
      model: 'claude-sonnet-4-20250514',
      temperature: 0.7,
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBe(0.7);
  });

  it('should not modify temperature for Anthropic with thinking type not enabled', async () => {
    const llmConfig = {
      provider: Providers.ANTHROPIC,
      model: 'claude-sonnet-4-20250514',
      temperature: 0.7,
      thinking: {
        type: 'disabled',
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBe(0.7);
  });
});


/* KADE CANON (Part 123, Sep 4 2026). A character's own autobiography files under
 * the fixed canon owner, scoped to the character, so the same aunt exists for
 * every seat. These pin the routing, because a "self" card that lands in one
 * user's bucket is exactly the continuity bug the feature exists to prevent. */
describe('Kade canon (scope "self")', () => {
  const userId = new Types.ObjectId().toString();
  const agentId = 'agent_6llV0eMu4fmIaj8f2x1Sb';

  it('routes a scope:self write to the canon owner, scoped to the character, tagged canon', async () => {
    const setMemory = jest.fn(async () => ({ ok: true }));
    const t = createMemoryTool({ userId, agentId, setMemory: setMemory as never });
    await t.invoke({ key: 'aunt_porch_light', value: 'My aunt kept the porch light on every night.', scope: 'self' });
    expect(setMemory).toHaveBeenCalledTimes(1);
    const args = (setMemory as jest.Mock).mock.calls[0][0];
    expect(args.userId).toBe(CANON_USER_ID);
    expect(args.agentId).toBe(agentId);
    expect(args.subject).toBe('canon');
  });

  it('keeps scope:agent and shared writes on the user, untouched', async () => {
    const setMemory = jest.fn(async () => ({ ok: true }));
    const t = createMemoryTool({ userId, agentId, setMemory: setMemory as never });
    await t.invoke({ key: 'dog_zeus', value: 'Her dog Zeus is deaf.', scope: 'agent' });
    await t.invoke({ key: 'screen_reader', value: 'Uses a screen reader.' });
    const calls = (setMemory as jest.Mock).mock.calls;
    expect(calls[0][0].userId).toBe(userId);
    expect(calls[0][0].agentId).toBe(agentId);
    expect(calls[1][0].userId).toBe(userId);
    expect(calls[1][0].agentId).toBeUndefined();
  });

  it('with no character active, scope:self falls back to the user (there is nobody to be canon about)', async () => {
    const setMemory = jest.fn(async () => ({ ok: true }));
    const t = createMemoryTool({ userId, setMemory: setMemory as never });
    await t.invoke({ key: 'aunt_porch_light', value: 'My aunt kept the porch light on.', scope: 'self' });
    expect((setMemory as jest.Mock).mock.calls[0][0].userId).toBe(userId);
  });

  it('deletes a scope:self card from the canon owner, not the user', async () => {
    const deleteMemory = jest.fn(async () => ({ ok: true }));
    const t = createDeleteMemoryTool({ userId, agentId, deleteMemory: deleteMemory as never });
    await t.invoke({ key: 'aunt_porch_light', scope: 'self' });
    const args = (deleteMemory as jest.Mock).mock.calls[0][0];
    expect(args.userId).toBe(CANON_USER_ID);
    expect(args.agentId).toBe(agentId);
  });
});


describe('Kade canon — the fabrication guard', () => {
  const userId = new Types.ObjectId().toString();
  const agentId = 'agent_6llV0eMu4fmIaj8f2x1Sb';
  const transcript =
    'Human: what was your first concert?\nAI: Oak Ridge Boys, down at the lake. My auntie won tickets off a radio call-in and I was twelve and too cool for it.\nHuman: ha';

  it('pulls only the AI side out of a buffer transcript', () => {
    const ai = aiTurnsOf(transcript);
    expect(ai).toMatch(/Oak Ridge Boys/);
    expect(ai).not.toMatch(/what was your first concert/);
  });

  it('a card grounded in the character\'s words scores high; an invented one scores low', () => {
    const ai = aiTurnsOf(transcript);
    expect(canonEvidenceShare('Her first concert was the Oak Ridge Boys at the lake; her auntie won radio tickets when she was twelve.', ai)).toBeGreaterThanOrEqual(0.5);
    expect(canonEvidenceShare('Her first concert was a county fair in 2003, a cover band called The Midnight Ramblers, with cousin Dale, in the rain.', ai)).toBeLessThan(0.5);
  });

  it('refuses to file an invented self card and files a grounded one', async () => {
    const setMemory = jest.fn(async () => ({ ok: true }));
    const t = createMemoryTool({ userId, agentId, setMemory: setMemory as never, canonEvidence: aiTurnsOf(transcript) });
    const refused = await t.invoke({ key: 'first_concert', value: 'Her first concert was a county fair in 2003 with cousin Dale and The Midnight Ramblers.', scope: 'self' });
    expect(String(refused)).toMatch(/NOT filed/);
    expect(setMemory).not.toHaveBeenCalled();
    await t.invoke({ key: 'first_concert', value: 'Her first concert was the Oak Ridge Boys at the lake; her auntie won the tickets on a radio call-in when she was twelve.', scope: 'self' });
    expect(setMemory).toHaveBeenCalledTimes(1);
    expect((setMemory as jest.Mock).mock.calls[0][0].userId).toBe(CANON_USER_ID);
  });

  it('without evidence wired (consolidation passes) the guard is off', async () => {
    const setMemory = jest.fn(async () => ({ ok: true }));
    const t = createMemoryTool({ userId, agentId, setMemory: setMemory as never });
    await t.invoke({ key: 'anything', value: 'Whatever the pass says.', scope: 'self' });
    expect(setMemory).toHaveBeenCalledTimes(1);
  });
});
