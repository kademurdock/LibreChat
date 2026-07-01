const express = require('express');
const { Tokenizer, generateCheckAccess } = require('@librechat/api');
const { PermissionTypes, Permissions } = require('librechat-data-provider');
const {
  getAllUserMemories,
  getFormattedMemories,
  toggleUserMemories,
  getRoleByName,
  createMemory,
  deleteMemory,
  setMemory,
  getUserKey,
  getUserKeyValues,
} = require('~/models');
const {
  consolidateMemoryBucket,
  AGENT_SCOPED_MEMORY_KEY,
  getProviderConfig,
} = require('@librechat/api');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware');

const router = express.Router();

const memoryPayloadLimit = express.json({ limit: '100kb' });

const checkMemoryRead = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.READ],
  getRoleByName,
});
const checkMemoryCreate = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});
const checkMemoryUpdate = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.UPDATE],
  getRoleByName,
});
const checkMemoryDelete = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.UPDATE],
  getRoleByName,
});
const checkMemoryOptOut = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.OPT_OUT],
  getRoleByName,
});

router.use(requireJwtAuth);

/**
 * GET /memories
 * Returns all memories for the authenticated user, sorted by updated_at (newest first).
 * Also includes memory usage percentage based on token limit.
 */
router.get('/', checkMemoryRead, configMiddleware, async (req, res) => {
  try {
    const memories = await getAllUserMemories(req.user.id);

    const sortedMemories = memories.sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );

    const totalTokens = memories.reduce((sum, memory) => {
      return sum + (memory.tokenCount || 0);
    }, 0);

    const appConfig = req.config;
    const memoryConfig = appConfig?.memory;
    const tokenLimit = memoryConfig?.tokenLimit;
    const charLimit = memoryConfig?.charLimit || 10000;

    let usagePercentage = null;
    if (tokenLimit && tokenLimit > 0) {
      usagePercentage = Math.min(100, Math.round((totalTokens / tokenLimit) * 100));
    }

    res.json({
      memories: sortedMemories,
      totalTokens,
      tokenLimit: tokenLimit || null,
      charLimit,
      usagePercentage,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /memories
 * Creates a new memory entry for the authenticated user.
 * Body: { key: string, value: string, agentId?: string } -- agentId scopes the entry to one agent's own bucket; omit for shared.
 * Returns 201 and { created: true, memory: <createdDoc> } when successful.
 */
router.post('/', memoryPayloadLimit, checkMemoryCreate, configMiddleware, async (req, res) => {
  const { key, value, agentId } = req.body;

  if (typeof key !== 'string' || key.trim() === '') {
    return res.status(400).json({ error: 'Key is required and must be a non-empty string.' });
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return res.status(400).json({ error: 'Value is required and must be a non-empty string.' });
  }

  const appConfig = req.config;
  const memoryConfig = appConfig?.memory;
  const charLimit = memoryConfig?.charLimit || 10000;

  if (key.length > 1000) {
    return res.status(400).json({
      error: `Key exceeds maximum length of 1000 characters. Current length: ${key.length} characters.`,
    });
  }

  if (value.length > charLimit) {
    return res.status(400).json({
      error: `Value exceeds maximum length of ${charLimit} characters. Current length: ${value.length} characters.`,
    });
  }

  const scopedAgentId = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : undefined;

  try {
    const tokenCount = Tokenizer.getTokenCount(value, 'o200k_base');

    const memories = await getAllUserMemories(req.user.id);

    const appConfig = req.config;
    const memoryConfig = appConfig?.memory;
    const tokenLimit = memoryConfig?.tokenLimit;

    if (tokenLimit) {
      const currentTotalTokens = memories.reduce(
        (sum, memory) => sum + (memory.tokenCount || 0),
        0,
      );
      if (currentTotalTokens + tokenCount > tokenLimit) {
        return res.status(400).json({
          error: `Adding this memory would exceed the token limit of ${tokenLimit}. Current usage: ${currentTotalTokens} tokens.`,
        });
      }
    }

    const result = await createMemory({
      userId: req.user.id,
      agentId: scopedAgentId,
      key: key.trim(),
      value: value.trim(),
      tokenCount,
    });

    if (!result.ok) {
      return res.status(500).json({ error: 'Failed to create memory.' });
    }

    const updatedMemories = await getAllUserMemories(req.user.id);
    const newMemory = updatedMemories.find(
      (m) => m.key === key.trim() && (m.agentId ?? undefined) === scopedAgentId,
    );

    res.status(201).json({ created: true, memory: newMemory });
  } catch (error) {
    if (error.message && error.message.includes('already exists')) {
      return res.status(409).json({ error: 'Memory with this key already exists in that bucket.' });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /memories/preferences
 * Updates the user's memory preferences (e.g., enabling/disabling memories).
 * Body: { memories: boolean }
 * Returns 200 and { updated: true, preferences: { memories: boolean } } when successful.
 */
router.patch('/preferences', checkMemoryOptOut, async (req, res) => {
  const { memories } = req.body;

  if (typeof memories !== 'boolean') {
    return res.status(400).json({ error: 'memories must be a boolean value.' });
  }

  try {
    const updatedUser = await toggleUserMemories(req.user.id, memories);

    if (!updatedUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json({
      updated: true,
      preferences: {
        memories: updatedUser.personalization?.memories ?? true,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /memories/:key
 * Updates the value of an existing memory entry for the authenticated user.
 * Body: { key?: string, value: string, agentId?: string } -- agentId must match the bucket the existing entry is in; omit for shared.
 * Returns 200 and { updated: true, memory: <updatedDoc> } when successful.
 */
router.patch('/:key', memoryPayloadLimit, checkMemoryUpdate, configMiddleware, async (req, res) => {
  const { key: urlKey } = req.params;
  const { key: bodyKey, value, agentId } = req.body || {};

  if (typeof value !== 'string' || value.trim() === '') {
    return res.status(400).json({ error: 'Value is required and must be a non-empty string.' });
  }

  const newKey = bodyKey || urlKey;
  const appConfig = req.config;
  const memoryConfig = appConfig?.memory;
  const charLimit = memoryConfig?.charLimit || 10000;

  if (newKey.length > 1000) {
    return res.status(400).json({
      error: `Key exceeds maximum length of 1000 characters. Current length: ${newKey.length} characters.`,
    });
  }

  if (value.length > charLimit) {
    return res.status(400).json({
      error: `Value exceeds maximum length of ${charLimit} characters. Current length: ${value.length} characters.`,
    });
  }

  const scopedAgentId = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : undefined;

  try {
    const tokenCount = Tokenizer.getTokenCount(value, 'o200k_base');

    const memories = await getAllUserMemories(req.user.id);
    const existingMemory = memories.find(
      (m) => m.key === urlKey && (m.agentId ?? undefined) === scopedAgentId,
    );

    if (!existingMemory) {
      return res.status(404).json({ error: 'Memory not found.' });
    }

    if (newKey !== urlKey) {
      const keyExists = memories.find(
        (m) => m.key === newKey && (m.agentId ?? undefined) === scopedAgentId,
      );
      if (keyExists) {
        return res.status(409).json({ error: 'Memory with this key already exists in that bucket.' });
      }

      const createResult = await createMemory({
        userId: req.user.id,
        agentId: scopedAgentId,
        key: newKey,
        value,
        tokenCount,
      });

      if (!createResult.ok) {
        return res.status(500).json({ error: 'Failed to create new memory.' });
      }

      const deleteResult = await deleteMemory({
        userId: req.user.id,
        agentId: scopedAgentId,
        key: urlKey,
      });
      if (!deleteResult.ok) {
        return res.status(500).json({ error: 'Failed to delete old memory.' });
      }
    } else {
      const result = await setMemory({
        userId: req.user.id,
        agentId: scopedAgentId,
        key: newKey,
        value,
        tokenCount,
      });

      if (!result.ok) {
        return res.status(500).json({ error: 'Failed to update memory.' });
      }
    }

    const updatedMemories = await getAllUserMemories(req.user.id);
    const updatedMemory = updatedMemories.find(
      (m) => m.key === newKey && (m.agentId ?? undefined) === scopedAgentId,
    );

    res.json({ updated: true, memory: updatedMemory });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /memories/:key
 * Deletes a memory entry for the authenticated user -- removes the ENTIRE lineage
 * for that key (the active entry plus any superseded history behind it), not just
 * the current row. Query param: ?agentId=<id> to target one agent's own bucket;
 * omit for shared.
 * Returns 200 and { deleted: true } when successful.
 */
router.delete('/:key', checkMemoryDelete, async (req, res) => {
  const { key } = req.params;
  const { agentId } = req.query;
  const scopedAgentId = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : undefined;

  try {
    const result = await deleteMemory({ userId: req.user.id, agentId: scopedAgentId, key });

    if (!result.ok) {
      return res.status(404).json({ error: 'Memory not found.' });
    }

    res.json({ deleted: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /memories/consolidate
 * Memory-hygiene consolidation pass (Kade-AI two-tier memory build plan, Part 2):
 * reviews everything currently ACTIVE in ONE bucket and asks the same memory-writer
 * model/instructions used for normal memory writes to merge near-duplicates and
 * tighten stale phrasing -- never to invent new facts. Not wired to an automatic
 * schedule; this is the on-demand trigger (self, or via the Forge proxy action)
 * until/unless an automatic cadence is explicitly turned on.
 * Body: { agentId? } -- omit or null for the shared bucket, or an agent's string
 * id (e.g. "agent_6llV0eMu4fmIaj8f2x1Sb") for just that persona's own bucket.
 * Returns { ran: boolean, attachments? } -- ran:false means the bucket was already
 * empty, so nothing was sent to the model (no cost incurred).
 */
router.post('/consolidate', checkMemoryUpdate, configMiddleware, async (req, res) => {
  const { agentId } = req.body || {};
  const appConfig = req.config;
  const memoryConfig = appConfig?.memory;

  if (!memoryConfig || memoryConfig.disabled === true) {
    return res.status(400).json({ error: 'Memory is disabled; nothing to consolidate.' });
  }
  if (!memoryConfig.agent?.provider || !memoryConfig.agent?.model) {
    return res.status(400).json({
      error:
        'No memory-writer provider/model configured (memory.agent.provider / memory.agent.model in librechat.yaml). Consolidation reuses that same model, so it needs to be set.',
    });
  }

  const targetAgentId = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : undefined;
  const scopeLabel = targetAgentId
    ? `agent ${targetAgentId}'s own (key: ${AGENT_SCOPED_MEMORY_KEY})`
    : 'shared';

  try {
    /**
     * memory.agent.provider (e.g. "OpenRouter") is usually a CUSTOM endpoint name,
     * not a first-party provider -- it needs the same credential/baseURL resolution
     * useMemory() gets for free via initializeAgent() (see client.js). This is the
     * narrow slice of that resolution actually needed here: no tools/files/MCP,
     * just "turn a provider name into a real apiKey + baseURL". Skipping this and
     * hand-building { provider, model } directly is what broke the first version
     * of this route -- it silently had no apiKey/baseURL at all.
     */
    const { getOptions, overrideProvider } = getProviderConfig({
      provider: memoryConfig.agent.provider,
      appConfig,
    });
    const resolved = await getOptions({
      req,
      endpoint: memoryConfig.agent.provider,
      model_parameters: { model: memoryConfig.agent.model, ...memoryConfig.agent.model_parameters },
      db: { getUserKey, getUserKeyValues },
    });
    const llmConfig = {
      provider: resolved.provider ?? overrideProvider,
      ...resolved.llmConfig,
      configuration: resolved.configOptions,
    };

    const result = await consolidateMemoryBucket({
      userId: req.user.id,
      agentId: targetAgentId,
      scopeLabel,
      memoryMethods: { setMemory, deleteMemory, getFormattedMemories },
      llmConfig,
      tokenLimit: memoryConfig.tokenLimit,
      user: req.user,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
