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
const { angelBuild, angelLines } = require('~/app/clients/tools/kademoo/angel');

const router = express.Router();
router.use(requireJwtAuth);

router.post('/command', async (req, res) => {
  try {
    const command = String(req.body?.command || '').slice(0, 400);
    if (!command.trim()) {
      return res.status(400).json({ error: 'empty command' });
    }
    /* THE ANGEL PREFIX (Aug 9 2026): "angel: carve a bakery north of the
     * gate" typed into ANY existing world client — the web page, the native
     * World screen behind the admin door — wakes the Angel Lane with zero
     * client changes. Wizards only; everyone else's "angel..." is just a
     * word the parser will shrug at. */
    const angelAsk = /^angel[,:]?\s+(.+)$/is.exec(command);
    if (angelAsk && req.user.role === 'ADMIN') {
      /* "angel preview: ..." shows the plan without executing it. */
      const preview = /^preview[,:]?\s+(.+)$/is.exec(angelAsk[1].trim());
      const out = await angelBuild((preview ? preview[1] : angelAsk[1]).trim(), { dryRun: !!preview });
      return res.json({ ok: true, lines: angelLines(out) });
    }
    const result = await runCommand({
      userId: req.user.id,
      displayName: req.user.name || req.user.username,
      command,
      /* Wizard tier = platform admins (the Founder and deputies) — the #2
       * workflow: walk with NVDA, build as you go. */
      isWizard: req.user.role === 'ADMIN',
    });
    res.json(result);
  } catch (e) {
    logger.error('[world] direct command failed:', e.message);
    res.status(500).json({ error: 'the world flickered — try again' });
  }
});

/* THE ANGEL LANE, direct (Aug 9 2026 — last session's designed opener,
 * built): plain English in, the city changed, a chronicle out. Admin-only —
 * the Angel answers the Founder. One K3 call per ask, zero idle cost; the
 * execution half is the same chronicled runCommand as every traveler.
 * Body: { instruction } (or { command } — the native box sends that). */
router.post('/angel', async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'the angel answers only the Founder' });
    }
    const instruction = String(req.body?.instruction || req.body?.command || '').slice(0, 2000);
    if (!instruction.trim()) {
      return res.status(400).json({ error: 'tell the angel what to build' });
    }
    const dryRun = req.body?.dryRun === true;
    const out = await angelBuild(instruction.trim(), { dryRun });
    res.json({ ok: true, dryRun: dryRun || undefined, note: out.note, results: out.results, lines: angelLines(out) });
  } catch (e) {
    logger.error('[world] angel failed:', e.message);
    res.status(500).json({ error: 'the angel lost the thread — try again' });
  }
});

/** The sound manifest — her designed audio as data. Clients merge this over
 *  their synth defaults; installing a sound in-world (@sound) needs no deploy. */
router.get('/sounds', async (_req, res) => {
  try {
    const { MooSound } = require('~/models/kadeMoo');
    const rows = await MooSound.find({}).lean();
    const manifest = { event: {}, room: {}, district: {} };
    for (const r of rows) {
      if (manifest[r.scopeType]) {
        manifest[r.scopeType][r.scopeId] = r.url;
      }
    }
    res.json(manifest);
  } catch (e) {
    logger.error('[world] sounds manifest failed:', e.message);
    res.status(500).json({ error: 'no sounds today' });
  }
});

module.exports = router;
