/* KADE WORLD — the DIRECT lane (Aug 8 2026, her correction: "hard to interact
 * seriously via telling someone else to perform your actions"). No LLM in this
 * loop, ever: command in, engine out, ~50ms. MUD hands type n/e/w/s as fast as
 * telnet ever let them; the /world page is the client. Porter and his kin are
 * NPCs inside the world now, not the gate to it. Same engine, same state —
 * a traveler through Porter and a traveler through this lane share the city. */
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { runCommand } = require('~/app/clients/tools/kademoo/engine');

const router = express.Router();
router.use(requireJwtAuth);

router.post('/command', async (req, res) => {
  try {
    const command = String(req.body?.command || '').slice(0, 400);
    if (!command.trim()) {
      return res.status(400).json({ error: 'empty command' });
    }
    const result = await runCommand({
      userId: req.user.id,
      displayName: req.user.name || req.user.username,
      command,
    });
    res.json(result);
  } catch (e) {
    logger.error('[world] direct command failed:', e.message);
    res.status(500).json({ error: 'the world flickered — try again' });
  }
});

module.exports = router;
