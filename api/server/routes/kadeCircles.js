/**
 * KADE Oct 29 2026: /api/kade/circles — the owner circles behind every character's WHO line
 * (services/kadeCircle.js). Admin only: a circle names real people and how they are related.
 *
 *   GET  /                    every circle, counted (owner, people, family flag, unresolved notes)
 *   GET  /preview/:userId     the exact WHO block that person's characters get right now
 *   GET  /:ownerUserId        one owner's whole circle
 *   PUT  /:ownerUserId        replace one owner's circle. Body: { ownerName, ownerRole?, people:
 *                             [{ key, name, userId?, aliases?, family, isOwners?, ownerIsTheir? }],
 *                             links: [{ a, b, aIsBs }], unresolved: [text] }. "a is b's aIsBs".
 *
 * Kill switch for the injection itself: KADE_WHO_LINE=0 (these routes keep working).
 */
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const circles = require('~/server/services/kadeCircle');

const ID = /^[a-f0-9]{24}$/;

function createCircleRouter({ requireAuth, requireAdmin }) {
  const router = express.Router();
  router.use(requireAuth, requireAdmin);

  router.get('/', async (_req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ circles: await circles.listCircles() });
    } catch (e) {
      logger.warn('[kadeCircles] list failed: ' + e.message);
      return res.status(500).json({ error: 'Could not read the circles right now.' });
    }
  });

  router.get('/preview/:userId', async (req, res) => {
    const userId = String(req.params.userId || '');
    if (!ID.test(userId)) return res.status(400).json({ error: 'That is not an account id.' });
    try {
      const user = await require('mongoose')
        .connection.collection('users')
        .findOne({ _id: new (require('mongoose').Types.ObjectId)(userId) }, { projection: { name: 1, username: 1, role: 1 } });
      if (!user) return res.status(404).json({ error: 'No account with that id.' });
      circles.forget();
      const block = await circles.getWhoBlock({ user: { id: userId, name: user.name, username: user.username, role: user.role }, body: {} });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ userId, block });
    } catch (e) {
      logger.warn('[kadeCircles] preview failed: ' + e.message);
      return res.status(500).json({ error: 'Could not build the preview right now.' });
    }
  });

  router.get('/:ownerUserId', async (req, res) => {
    const owner = String(req.params.ownerUserId || '');
    if (!ID.test(owner)) return res.status(400).json({ error: 'That is not an account id.' });
    try {
      const circle = await circles.getCircle(owner);
      if (!circle) return res.status(404).json({ error: 'That account has no circle yet.' });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ circle });
    } catch (e) {
      logger.warn('[kadeCircles] read failed: ' + e.message);
      return res.status(500).json({ error: 'Could not read that circle right now.' });
    }
  });

  router.put('/:ownerUserId', express.json({ limit: '64kb' }), async (req, res) => {
    const owner = String(req.params.ownerUserId || '');
    if (!ID.test(owner)) return res.status(400).json({ error: 'That is not an account id.' });
    try {
      const out = await circles.saveCircle(owner, req.body, req.user && req.user.id);
      if (out.error) return res.status(400).json({ error: out.error });
      logger.info(`[kadeCircles] circle for ${owner} saved by ${req.user && req.user.id} (revision ${out.circle.revision})`);
      return res.json(out);
    } catch (e) {
      logger.warn('[kadeCircles] save failed: ' + e.message);
      return res.status(500).json({ error: 'Could not save that circle right now.' });
    }
  });

  return router;
}

function defaultRouter() {
  const { SystemCapabilities } = require('@librechat/data-schemas');
  const { requireCapability } = require('~/server/middleware/roles/capabilities');
  const { requireJwtAuth } = require('~/server/middleware');
  return createCircleRouter({
    requireAuth: requireJwtAuth,
    requireAdmin: requireCapability(SystemCapabilities.ACCESS_ADMIN),
  });
}

/* Built on first use, so tests can take createCircleRouter without the app's auth stack. */
let built = null;
function kadeCircles(req, res, next) {
  built = built || defaultRouter();
  return built(req, res, next);
}
kadeCircles.createCircleRouter = createCircleRouter;

module.exports = kadeCircles;
