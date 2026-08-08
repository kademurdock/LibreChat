/* Aug 8 2026 — owner lane for the HISTORY MINER (her ask: retro-fill cards +
 * logbook from every user's past chats). Same gates as the other admin lanes. */
const express = require('express');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const { startMining, stopMining, minerStatus } = require('~/server/services/kadeHistoryMiner');

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

router.get('/status', async (_req, res) => {
  res.json(await minerStatus());
});

module.exports = router;
