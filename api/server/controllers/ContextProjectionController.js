const { logger } = require('@librechat/data-schemas');
const { resolveContextProjection } = require('@librechat/api');
const db = require('~/models');

/**
 * Returns a server-side context-usage projection for the viewed branch + config
 * (agents SDK, no model call) — powers the gauge for snapshot-less branches and
 * after a model/window switch. Resolution lives in `@librechat/api`; this
 * controller only injects request-scoped model accessors.
 * @param {ServerRequest} req
 * @param {ServerResponse} res
 */
async function contextProjectionController(req, res) {
  try {
    const params = req.body ?? {};
    if (!params.conversationId || !params.messageId) {
      res.json(null);
      return;
    }
    const projection = await resolveContextProjection(
      {
        userId: req.user?.id,
        getMessages: db.getMessages,
        getMessageTextStats: db.getMessageTextStats,
        /** KADE Aug 4 2026: lets the projection resolve the agent's real
         *  effective window (configured value clamped to the model's own
         *  limit) instead of trusting the client-pinned constant. */
        getAgent: db.getAgent,
      },
      params,
    );
    res.json(projection ?? null);
  } catch (error) {
    logger.error('[contextProjectionController]', error);
    res.status(500).json({ error: 'Failed to resolve context projection' });
  }
}

module.exports = contextProjectionController;
