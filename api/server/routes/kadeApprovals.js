/**
 * KADE Oct 16 2026: /api/kade/approvals — Kade's yes before Forge ships
 * (services/kadeApprovals.js).
 *
 *   GET  /                 (admin sign-in) pending and recent requests, newest first
 *   GET  /:id              (admin sign-in, or machine x-kade-secret) one request
 *   POST /:id/decide       (admin sign-in) { decision: "approve" | "deny" }
 *   POST /create           (machine) the voice server records a held action
 *   POST /:id/followup     (machine) the voice server's went-live report
 *
 * Machine = x-kade-secret equal to BRIDGE_SECRET. Approving needs Kade's own
 * admin sign-in; no machine secret can approve.
 */
const crypto = require('crypto');
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const approvals = require('~/server/services/kadeApprovals');

const router = express.Router();

function machine(req) {
  const expected = String(process.env.BRIDGE_SECRET || '');
  const given = String(req.get('x-kade-secret') || '');
  if (!expected || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function adminOnly(req, res, next) {
  if (!req.user || String(req.user.role || '').toUpperCase() !== 'ADMIN') {
    return res.status(403).json({ error: 'Only Kade can see or decide approvals.' });
  }
  return next();
}

const ID = /^a[0-9a-f]{10}$/;

router.post('/create', express.json({ limit: '2mb' }), async (req, res) => {
  if (!machine(req)) return res.status(403).json({ error: 'Unauthorized' });
  try {
    const b = req.body || {};
    return res.json(await approvals.create({ kind: b.kind, params: b.params, summary: b.summary, revert: b.revert, agentId: b.agentId }));
  } catch (e) {
    logger.warn('[kadeApprovals] create failed: ' + e.message);
    return res.status(400).json({ error: e.message });
  }
});

router.post('/:id/followup', async (req, res) => {
  if (!machine(req)) return res.status(403).json({ error: 'Unauthorized' });
  if (!ID.test(req.params.id)) return res.status(400).json({ error: 'not an approval id' });
  try {
    return res.json(await approvals.followup({ approvalId: req.params.id, deploy: (req.body || {}).deploy }));
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
});

/* GET /:id answers the machine (the voice server, for Forge) without a sign-in. */
router.get('/:id', (req, res, next) => (machine(req) ? next('route') : next()), requireJwtAuth, adminOnly, async (req, res) => {
  if (!ID.test(req.params.id)) return res.status(400).json({ error: 'not an approval id' });
  const a = await approvals.get(req.params.id);
  return a ? res.json(a) : res.status(404).json({ error: 'no such request' });
});
router.get('/:id', async (req, res) => {
  if (!ID.test(req.params.id)) return res.status(400).json({ error: 'not an approval id' });
  const a = await approvals.get(req.params.id);
  return a ? res.json(a) : res.status(404).json({ error: 'no such request' });
});

router.get('/', requireJwtAuth, adminOnly, async (req, res) => {
  try {
    return res.json({ approvals: await approvals.list({ limit: 30 }) });
  } catch (e) {
    return res.status(500).json({ error: 'could not read approvals right now' });
  }
});

router.post('/:id/decide', requireJwtAuth, adminOnly, async (req, res) => {
  if (!ID.test(req.params.id)) return res.status(400).json({ error: 'not an approval id' });
  const decision = (req.body || {}).decision;
  if (decision !== 'approve' && decision !== 'deny') return res.status(400).json({ error: 'decision must be approve or deny' });
  try {
    return res.json(await approvals.decide({ approvalId: req.params.id, decision, by: 'button' }));
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
