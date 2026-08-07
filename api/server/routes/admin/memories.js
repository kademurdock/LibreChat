const express = require('express');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const { getAllUserMemories, deleteMemory } = require('~/models');
const db = require('~/models');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireReadUsers = requireCapability(SystemCapabilities.READ_USERS);

/**
 * Aug 7 2026 — the owner's MEMORY-housekeeping lane, the sibling to
 * /api/admin/convos. Her ask this session put the weight on memory
 * specifically: "it's the memory stuff that persists, I kinda don't need
 * that junk" — test conversations agents generated left persistent cards
 * that ride every future turn (cost + quality), so the owner needs a way to
 * see and prune any user's cards, not just her own.
 *
 * Same guardrails and spirit as the convos lane:
 *   - LIST returns the cards for a user (memory cards are extracted FACTS,
 *     not private chat transcripts — you cannot judge a card as junk without
 *     seeing its text, so the value rides through; still owner-gated).
 *   - DELETE returns the removed card in its response so the calling tool can
 *     archive it to disk before it is gone.
 *   - Every mutation logs a loud [admin-memories] line + a fail-soft audit
 *     entry (a broken audit shape must never block housekeeping).
 *
 * Gated ACCESS_ADMIN + READ_USERS, the exact pair the users and convos
 * routers use.
 */
router.use(requireJwtAuth, requireAdminAccess, requireReadUsers);

function auditFailSoft(req, action, targetUserId, key, detail) {
  try {
    if (typeof db.recordAuditEntry === 'function') {
      void db
        .recordAuditEntry({
          category: 'admin',
          action,
          outcome: 'success',
          severity: 'info',
          actor: { id: String(req.user.id), type: 'user' },
          target: { id: String(key), type: 'memory', userId: String(targetUserId) },
          metadata: detail || {},
        })
        .catch((e) => logger.warn(`[admin-memories] audit entry failed (non-blocking): ${e.message}`));
    }
  } catch (e) {
    logger.warn(`[admin-memories] audit entry failed (non-blocking): ${e.message}`);
  }
}

/** GET /?userId=<id> — every memory card belonging to one user, newest first. */
router.get('/', async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ error: 'userId query parameter is required' });
    }
    const memories = await getAllUserMemories(userId);
    const sorted = (memories || []).sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
    res.json({
      memories: sorted.map((m) => ({
        key: m.key,
        value: m.value,
        agentId: m.agentId || null,
        tokenCount: m.tokenCount || null,
        updated_at: m.updated_at,
      })),
      count: sorted.length,
    });
  } catch (error) {
    logger.error('[admin-memories] list failed', error);
    res.status(500).json({ error: 'Failed to list memories' });
  }
});

/** DELETE /:key?userId=<id>&agentId=<id> — delete-with-export: the response
 * carries the removed card for the caller to archive; then it is gone. A card
 * scoped to an agent bucket needs that agentId to match; omit for shared. */
router.delete('/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const userId = String(req.query.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ error: 'userId query parameter is required' });
    }
    const agentId =
      typeof req.query.agentId === 'string' && req.query.agentId.trim()
        ? req.query.agentId.trim()
        : undefined;
    const all = await getAllUserMemories(userId);
    const card = (all || []).find(
      (m) => m.key === key && (agentId ? m.agentId === agentId : !m.agentId),
    );
    if (!card) {
      return res.status(404).json({ error: 'Memory card not found for that user/bucket' });
    }
    const result = await deleteMemory({ userId, agentId, key });
    if (!result || !result.ok) {
      return res.status(404).json({ error: 'Memory card not found for that user/bucket' });
    }
    logger.info(
      `[admin-memories] DELETE by ${req.user.id}: user=${userId} key="${key}" agent=${agentId || 'SHARED'}`,
    );
    auditFailSoft(req, 'memory.delete', userId, key, { agentId: agentId || null });
    res.json({ ok: true, deleted: true, archived: card });
  } catch (error) {
    logger.error('[admin-memories] delete failed', error);
    res.status(500).json({ error: 'Failed to delete memory' });
  }
});

module.exports = router;
