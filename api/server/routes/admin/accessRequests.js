const express = require('express');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const { KadeAccessRequest } = require('~/models/kadeAccessRequest');

const router = express.Router();
router.use(requireJwtAuth, requireCapability(SystemCapabilities.ACCESS_ADMIN));

/**
 * Aug 9 2026 — the APPROVAL half of the front-door overhaul. Approve picks
 * the audience (adult or child), and the response hands back a READY-TO-SEND
 * message carrying the right registration code — Kade texts the blessing
 * herself, which keeps the last step human and the codes out of email.
 */
router.get('/', async (req, res) => {
  try {
    const status = String(req.query.status || 'pending');
    const filter = status === 'all' ? {} : { status };
    const requests = await KadeAccessRequest.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    res.json({
      requests: requests.map((r) => ({
        id: String(r._id),
        name: r.name,
        contact: r.contact,
        whoYouAre: r.whoYouAre,
        whyHere: r.whyHere,
        status: r.status,
        audience: r.audience,
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
      })),
    });
  } catch (error) {
    logger.error('[admin-access] list failed', error);
    res.status(500).json({ error: 'Failed to list requests' });
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    const audience = req.body?.audience === 'child' ? 'child' : 'adult';
    const doc = await KadeAccessRequest.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'approved', audience, decidedAt: new Date(), decidedNote: String(req.body?.note || '').slice(0, 500) } },
      { new: true },
    ).lean();
    if (!doc) return res.status(404).json({ error: 'Request not found' });
    const code = audience === 'child' ? process.env.KADE_REG_CODE_CHILD : process.env.KADE_REG_CODE_ADULT;
    const domain = process.env.DOMAIN_CLIENT || 'https://kademurdock.com';
    const readyMessage =
      `Hey ${doc.name} — you're in. Go to ${domain}/register, make your account, ` +
      `and when it asks for the code, it's ${code}. Welcome to the family's corner of the internet.`;
    logger.info(`[admin-access] APPROVED "${doc.name}" as ${audience} by ${req.user.id}`);
    res.json({ ok: true, id: String(doc._id), audience, readyMessage, contact: doc.contact });
  } catch (error) {
    logger.error('[admin-access] approve failed', error);
    res.status(500).json({ error: 'Approve failed' });
  }
});

router.post('/:id/deny', async (req, res) => {
  try {
    const doc = await KadeAccessRequest.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'denied', decidedAt: new Date(), decidedNote: String(req.body?.note || '').slice(0, 500) } },
      { new: true },
    ).lean();
    if (!doc) return res.status(404).json({ error: 'Request not found' });
    logger.info(`[admin-access] denied "${doc.name}" by ${req.user.id}`);
    res.json({ ok: true, id: String(doc._id) });
  } catch (error) {
    logger.error('[admin-access] deny failed', error);
    res.status(500).json({ error: 'Deny failed' });
  }
});

module.exports = router;
