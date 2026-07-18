/**
 * KADE CLOCK ENDPOINTS (July 18 2026) — Phase 1 of pulling every timer out of
 * the app into the always-on bridge ("clock" service). The bridge now owns
 * WHEN; this file owns WHAT. Each route runs one sweep pass on demand and
 * returns its stats. Auth: x-kade-secret must equal BRIDGE_SECRET (the secret
 * the fork and bridge already share — no new plumbing).
 *
 * The in-process schedulers still exist and start unless KADE_CLOCK_EXTERNAL=1
 * is set on this service (see api/server/index.js) — that env is the migration
 * switch AND the instant revert: delete it and the app schedules itself again.
 *
 * Jobs:
 *   POST /api/kade/clock/nudges         — reminder/birthday/phone-prompt sweep (bridge pokes every 60s)
 *   POST /api/kade/clock/summary        — nightly "dreaming" relationship-summary sweep
 *   POST /api/kade/clock/consolidation  — platform-wide weekly memory consolidation
 *   POST /api/kade/clock/files          — expired-file sweep
 *   POST /api/kade/clock/restart        — memory-hygiene process exit (refused within 2h of boot)
 *   GET  /api/kade/clock/status         — uptime + whether internal timers are externalized
 *
 * NOTE (App Sleeping, the end goal): the 60s nudge poke keeps the app awake,
 * so sleeping is NOT enabled by this phase. Phase 2 = move nudge due-times to
 * the bridge so pokes only happen when something is due.
 */
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { runNudgeSweepOnce, computeNextDueAt } = require('~/server/services/kadeNudges');
const { runSummarySweep } = require('~/server/services/kadeMemorySummarySweep');
const { sweepMemoryConsolidation } = require('~/server/services/Memory/consolidationSweep');
const { sweepExpiredFiles } = require('~/server/services/Files/process');

const router = express.Router();

function authed(req, res) {
  const expected = process.env.BRIDGE_SECRET;
  /* Header-only on purpose (query secrets land in edge logs — July 13 rule). */
  if (!expected || req.get('x-kade-secret') !== expected) {
    res.status(403).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

router.get('/status', (req, res) => {
  if (!authed(req, res)) return;
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    external: process.env.KADE_CLOCK_EXTERNAL === '1',
  });
});

router.post('/nudges', async (req, res) => {
  if (!authed(req, res)) return;
  try {
    const stats = await runNudgeSweepOnce();
    /* Phase 2 (App Sleeping): tell the clock when to poke next, in the same
     * breath — the bridge stores this and stays quiet until then. */
    const nextDueAt = await computeNextDueAt().catch(() => null);
    res.json({ ok: true, ...stats, nextDueAt });
  } catch (e) {
    logger.error('[kadeClock] nudges job failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/summary', async (req, res) => {
  if (!authed(req, res)) return;
  try {
    const stats = await runSummarySweep();
    res.json({ ok: true, stats: stats || null });
  } catch (e) {
    logger.error('[kadeClock] summary job failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/consolidation', async (req, res) => {
  if (!authed(req, res)) return;
  try {
    const result = await sweepMemoryConsolidation();
    res.json({ ok: true, result: result || null });
  } catch (e) {
    logger.error('[kadeClock] consolidation job failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/files', async (req, res) => {
  if (!authed(req, res)) return;
  try {
    const result = await sweepExpiredFiles();
    res.json({ ok: true, result: result || null });
  } catch (e) {
    logger.error('[kadeClock] files job failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/restart', (req, res) => {
  if (!authed(req, res)) return;
  /* Same guard the in-process timer had: never restart within 2h of boot —
   * covers deploy bounces and guarantees no restart loop. */
  if (process.uptime() < 2 * 60 * 60) {
    return res.json({ ok: true, restarted: false, reason: 'booted <2h ago' });
  }
  logger.info('[kadeClock] restart poke accepted — exiting for a clean restart (memory hygiene).');
  res.json({ ok: true, restarted: true });
  setTimeout(() => process.exit(1), 1500);
});

module.exports = router;
