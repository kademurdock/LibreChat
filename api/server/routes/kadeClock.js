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
const { runScheduledConsolidation } = require('~/server/services/Memory/consolidationSweep');
const { getAppConfig } = require('~/server/services/Config');
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
    /* KADE Aug 16 2026 (Part 71): run through the SAME engine chooser the
     * in-process scheduler uses (v2 connection pass by default, env-reverting
     * to v1) and hand it the app config -- the bare v1 call this replaced had
     * neither, so every bridge-clock fire skipped on "No app config". */
    const result = await runScheduledConsolidation({ loadAppConfig: getAppConfig });
    res.json({ ok: true, result: result || null });
  } catch (e) {
    logger.error('[kadeClock] consolidation job failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/files', async (req, res) => {
  if (!authed(req, res)) return;
  try {
    /* KADE Aug 16 2026 (Part 71): same class as the consolidation fix above --
     * bare call had no app config, so any expired file needing the storage
     * strategy (this platform's files live on S3/B2) would fail its delete.
     * Mirror index.js's in-process wiring exactly. */
    const result = await sweepExpiredFiles({ loadAppConfig: getAppConfig });
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


/* ── KADE Aug 21 2026 (Part 76) — MEMORY HEALTH, read-only ────────────────────
 * Forge's report, item 9: "memory failures are silent by nature; make them
 * loud." The Part-71 lesson earns it: the consolidation sweep once no-opped
 * for a MONTH while returning ok:true to the bridge. This endpoint gives that
 * silence a number. The bridge folds it into /platform-status (same
 * BRIDGE_SECRET the clock pokes already ride).
 *
 * COUNTS AND AGES ONLY by default — no card/diary text leaves this route
 * unless KADE_MEMORY_HEALTH_ECHO_PREVIEW=1 (her flip; payload is admin-gated
 * either way; previews are clipped to 80 chars).
 *
 * ECHOES = Forge's anniversary item, DETECTION ONLY: diary entries and active
 * cards whose month-day matches today (US Central), at least ~28 days back.
 * The platform is ~2 months old, so these speak in months; year phrasing
 * comes free with age (monthsAgo % 12). NOTHING is injected into any
 * conversation from here — surfacing echoes as companion openers stays
 * parked for her word (and for after the Aug-27 drift re-measure, so the
 * measurement window stays clean).
 *
 * Kill switch: KADE_MEMORY_HEALTH=0 (route answers {disabled:true}).
 * All reads are tiny (hundreds of rows, count + single-doc sorts + one
 * $dateToString aggregate capped at 20). */
router.get('/memory-health', async (req, res) => {
  if (!authed(req, res)) return;
  if (process.env.KADE_MEMORY_HEALTH === '0') {
    return res.json({ ok: false, disabled: true });
  }
  try {
    const mongoose = require('mongoose');
    const { getLastSweepRunAt } = require('~/models/memoryConsolidationSweepState');
    const db = mongoose.connection.db;
    const now = Date.now();
    const DAY = 864e5;
    const hoursAgo = (t) => (t ? Math.round(((now - new Date(t).getTime()) / 36e5) * 10) / 10 : null);
    const daysAgo = (t) => (t ? Math.round((now - new Date(t).getTime()) / DAY) : null);
    const centralParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const cp = (t) => centralParts.find((p) => p.type === t).value;
    const todayKey = `${cp('year')}-${cp('month')}-${cp('day')}`;
    const previewOn = process.env.KADE_MEMORY_HEALTH_ECHO_PREVIEW === '1';
    const clip = (s) => (typeof s === 'string' && s.length > 80 ? `${s.slice(0, 77)}...` : s);
    const monthsBetween = (thenMs) => Math.max(1, Math.round((now - thenMs) / (30.44 * DAY)));

    const mem = db.collection('memoryentries');
    const diary = db.collection('kadediaryentries');
    const summaries = db.collection('kadememorysummaries');

    const [cardsActive, cardsSuperseded, cardsWrote24h] = await Promise.all([
      mem.countDocuments({ status: 'active' }),
      mem.countDocuments({ status: 'superseded' }),
      mem.countDocuments({ updated_at: { $gte: new Date(now - DAY) } }),
    ]);
    const [newestCard] = await mem.find({}, { projection: { updated_at: 1 } })
      .sort({ updated_at: -1 }).limit(1).toArray();
    const [stalestCard] = await mem.find({ status: 'active' }, { projection: { updated_at: 1, key: 1 } })
      .sort({ updated_at: 1 }).limit(1).toArray();

    const [diaryTotal, diaryWrote24h] = await Promise.all([
      diary.countDocuments({}),
      diary.countDocuments({ createdAt: { $gte: new Date(now - DAY) } }),
    ]);
    const [newestDiary] = await diary.find({}, { projection: { createdAt: 1 } })
      .sort({ createdAt: -1 }).limit(1).toArray();

    const summariesTotal = await summaries.countDocuments({});
    const [newestSummary] = await summaries.find({}, { projection: { updatedAt: 1 } })
      .sort({ updatedAt: -1 }).limit(1).toArray();

    let consolidationLastRunAt = null;
    try { consolidationLastRunAt = await getLastSweepRunAt(); } catch { /* best-effort */ }

    /* Echoes match on DAY-OF-MONTH, not month-day: the platform is ~2 months
     * old, so a strict "same date last year" check would stay silent until
     * June 2027. Day-of-month marks ("a month ago today", "three months ago
     * today") fire on the history the family actually has; when the estate is
     * old enough, monthsAgo % 12 === 0 phrases them as years for free. Both
     * lanes exclude the young (< ~28 days) so yesterday's card is not an
     * "anniversary", return the OLDEST first (the deepest echoes are the
     * point), and cap at 8 each. */
    const dd = cp('day');
    const cutoffKey = new Date(now - 28 * DAY).toISOString().slice(0, 10);
    const diaryEchoRows = await diary.find(
      { entryDate: { $regex: `-${dd}$`, $lte: cutoffKey, $ne: todayKey } },
      { projection: { entryDate: 1, userId: 1, agentId: 1, text: 1 } },
    ).sort({ entryDate: 1 }).limit(8).toArray();
    const cardEchoRows = await mem.aggregate([
      { $match: { status: 'active', updated_at: { $lte: new Date(now - 28 * DAY) } } },
      { $addFields: { dom: { $dateToString: { format: '%d', date: '$updated_at', timezone: 'America/Chicago' } } } },
      { $match: { dom: dd } },
      { $sort: { updated_at: 1 } },
      { $project: { key: 1, updated_at: 1, userId: 1, agentId: 1, value: 1 } },
      { $limit: 8 },
    ]).toArray();
    const echoes = [
      ...diaryEchoRows.map((r) => ({
        kind: 'diary', when: r.entryDate, monthsAgo: monthsBetween(Date.parse(`${r.entryDate}T12:00:00Z`)),
        userId: String(r.userId || '').slice(-6), agentId: r.agentId || null,
        ...(previewOn ? { preview: clip(r.text) } : {}),
      })),
      ...cardEchoRows.map((r) => ({
        kind: 'card', when: new Date(r.updated_at).toISOString().slice(0, 10),
        monthsAgo: monthsBetween(new Date(r.updated_at).getTime()),
        userId: String(r.userId || '').slice(-6), agentId: r.agentId || null, key: r.key,
        ...(previewOn ? { preview: clip(r.value) } : {}),
      })),
    ];

    res.json({
      ok: true,
      todayCentral: todayKey,
      cards: {
        active: cardsActive,
        superseded: cardsSuperseded,
        wrote24h: cardsWrote24h,
        newestAgeHours: hoursAgo(newestCard && newestCard.updated_at),
        stalestActiveAgeDays: daysAgo(stalestCard && stalestCard.updated_at),
        stalestActiveKey: stalestCard ? stalestCard.key : null,
      },
      diary: {
        entries: diaryTotal,
        wrote24h: diaryWrote24h,
        newestAgeHours: hoursAgo(newestDiary && newestDiary.createdAt),
      },
      summaries: {
        rows: summariesTotal,
        newestRefreshAgeHours: hoursAgo(newestSummary && newestSummary.updatedAt),
      },
      consolidation: {
        lastRunAt: consolidationLastRunAt,
        ageHours: hoursAgo(consolidationLastRunAt),
        engine: (process.env.KADE_SWEEP_ENGINE || 'v2').trim().toLowerCase(),
      },
      echoes,
      echoPreviews: previewOn,
    });
  } catch (e) {
    logger.error('[kadeClock] memory-health failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
