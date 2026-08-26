/* Aug 8 2026 — owner lane for the HISTORY MINER (her ask: retro-fill cards +
 * logbook from every user's past chats). Same gates as the other admin lanes. */
const express = require('express');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const { startMining, stopMining, minerStatus, resetMining } = require('~/server/services/kadeHistoryMiner');

const router = express.Router();
router.use(
  requireJwtAuth,
  requireCapability(SystemCapabilities.ACCESS_ADMIN),
  requireCapability(SystemCapabilities.READ_USERS),
);

router.post('/start', async (req, res) => {
  const { scope = 'all', maxPerRun = 150 } = req.body || {};
  res.json(await startMining({ scope, maxPerRun }));
});

router.post('/stop', (_req, res) => {
  res.json(stopMining());
});

/* Aug 26 2026 — clear the run-once claims for a date window so the miner can
 * walk those days again. Deletes claim rows ONLY; never a diary entry, card or
 * message. Requires from/to; pass dry:true to count first. */
router.post('/reset', async (req, res) => {
  const { from, to, scope = 'all', dry = false } = req.body || {};
  const result = await resetMining({ from, to, scope, dry });
  res.status(result.ok ? 200 : 400).json(result);
});

router.get('/status', async (_req, res) => {
  res.json(await minerStatus());
});

module.exports = router;
