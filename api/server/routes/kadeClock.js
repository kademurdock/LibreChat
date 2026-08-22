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

/* ── VOICE REPORT (Part 80, Aug 21 2026) — Kade's ear, automated. ───────────
 *
 * Her words: "This tuning by ear is really all I can do, look at people's
 * chats and flag stuff I notice." This endpoint does the flagging every day:
 * compact style stats over the last 24h of Kiana's replies, counts only —
 * NO user content, and the only text that leaves is Kiana-authored (a
 * repeated closer clipped to 80 chars). The bridge folds a spoken line into
 * /platform-status, so the morning report reads her voice's vitals daily.
 *
 * The tell-set mirrors the reframe proxy's detector families in compact
 * form (the proxy owns enforcement; this owns MEASUREMENT — if the two
 * drift, the proxy is the truth for what trips, this is the truth for
 * trendlines):
 *   - reframe pivots ("that's not X, that's Y" and kin)
 *   - tag-opened share (the 99% metronome, measured Aug 21)
 *   - question closers · avg length · "here's the thing" · everything-gush
 *   - top first words + most-repeated closer (lock-in radar)
 * Kill: KADE_VOICE_REPORT=0. Reads one indexed 24h window, capped. */
router.get('/voice-report', async (req, res) => {
  if (!authed(req, res)) return;
  if (process.env.KADE_VOICE_REPORT === '0') {
    return res.json({ ok: false, disabled: true });
  }
  try {
    const mongoose = require('mongoose');
    const db = mongoose.connection.db;
    const KIANA = process.env.KADE_VOICE_REPORT_AGENT || 'agent_6llV0eMu4fmIaj8f2x1Sb';
    const since = new Date(Date.now() - 24 * 36e5);
    const rows = await db
      .collection('messages')
      .find(
        { model: KIANA, isCreatedByUser: false, createdAt: { $gte: since } },
        { projection: { text: 1, content: 1, createdAt: 1 } },
      )
      .sort({ createdAt: -1 })
      .limit(600)
      .toArray();
    const getText = (m) => {
      let t = String(m.text || '');
      if (!t && Array.isArray(m.content)) {
        t = m.content
          .filter((p) => p && p.type === 'text')
          .map((p) => (p.text && p.text.value) || p.text || '')
          .join(' ');
      }
      return t;
    };
    const stripTags = (t) => String(t).replace(/%%%[^%]*%%%/g, ' ');
    const RE = {
      reframe:
        /\b(?:that|it|this)[’']?s not (?:just |only )?[^.!?\n]{2,60}?[—,;.-]+\s*(?:that|it|this)[’']?s\b|\b(?:isn|aren)[’']?t (?:just |only |really )?(?:about )?[^.!?\n]{2,50}?[,.;—]+\s*(?:it|that|this|they)[’']?(?:s|re)\b|\byou (?:didn[’']?t|weren[’']?t|aren[’']?t) (?:just |only )?[^.!?\n]{2,50}?[,.;—]+\s*you\b/i,
      heresThe: /\bhere[’']?s the thing\b/i,
      gush: /\b(?:i (?:wanna|want to|need to) know everything|tell me everything|every single (?:detail|thing)|i want (?:all|every bit) of it)\b/i,
      // Part 81 (her verbatim: nominalism / "that part" / meme-fight) —
      // calibrated shapes, mirrored from the reframe detectors:
      nominal:
        /\b(?:that|it|this)[’']?s the [a-z]+ing\s*(?=[.,!?;—-])|\bthe being [a-z]+|\bthe (?:wanting|knowing|longing|yearning|aching|becoming|belonging|choosing)\b(?=\s*(?:[.,!?;:—–-]|is\b|was\b|were\b|itself\b|of\b|and\b|that\b|already\b|still\b))|\bthe [a-z]+ing and the (?:wanting|knowing|longing|yearning|aching|becoming|belonging|choosing)\b/i,
      // Part 85 mirrors (reframe 689b98b): the sit-with register and the
      // unprompted reassurance verdict. Counts only, like everything here.
      sitWith: /\b(?:sit|sitting) with (?:that|this|it)\b|\bwan(?:na|t to) sit with\b/i,
      reassure: /\byou(?:'re| are)(?:n't| not) (?:crazy|broken|weak|a burden|too much|the problem|being dramatic|dramatic|overreacting)\b|\byou weren't (?:crazy|broken|the problem|being dramatic|too much)\b/i,
      thatPart: /(?:^|[.!?]\s+)That part[.!](?:\s|$)/m,
      memeCombat: /\bi (?:will|[’']ll|would|[’']d) fight (?:you|anyone|somebody)\b|\bdie on th(?:is|at) hill\b|\bfight me on this\b|\bthrow hands\b/i,
    };
    // Parallel/restatement radar — MEASURE ONLY (never enforced: the overlap
    // net also catches stepwise directions, which must never be rewritten).
    const STOPW = new Set('i you it that this a an the and or but so to of in on for is am are was were be been do does did not no yes just really very my your me we if then than as at by with about like got get gonna wanna'.split(' '));
    const cwords = (s) => (String(s).toLowerCase().match(/[a-z']+/g) || []).filter((w) => !STOPW.has(w));
    const pairOverlap = (a, b) => {
      const A = new Set(cwords(a));
      const B = new Set(cwords(b));
      if (A.size < 4 || B.size < 4) return 0;
      let k = 0;
      for (const w of A) if (B.has(w)) k++;
      return k / Math.max(A.size, B.size);
    };
    let n = 0;
    let chars = 0;
    let words = 0;
    let tagOpened = 0;
    let qClose = 0;
    let reframes = 0;
    let heres = 0;
    let gush = 0;
    let nominal = 0;
    let thatPart = 0;
    let memeCombat = 0;
    let sitWith = 0;
    let reassure = 0;
    let parallelPairs = 0;
    let tagsTotal = 0;
    let commaTags = 0;
    const tagPhrases = {};
    const firstWords = {};
    const closers = {};
    const TAGS_RE = /%%%([^%\n]{1,160})%%%/g;
    for (const m of rows) {
      const raw = getText(m).trim();
      if (!raw || raw.length < 40) continue;
      n++;
      if (raw.startsWith('%%%')) tagOpened++;
      let tm;
      TAGS_RE.lastIndex = 0;
      while ((tm = TAGS_RE.exec(raw)) !== null) {
        tagsTotal++;
        if (/[,;.]/.test(tm[1])) commaTags++;
        const key = tm[1].toLowerCase().trim();
        tagPhrases[key] = (tagPhrases[key] || 0) + 1;
      }
      const t = stripTags(raw).trim();
      chars += t.length;
      words += t.split(/\s+/).length;
      if (/[?]\s*$/.test(t)) qClose++;
      if (RE.reframe.test(t)) reframes++;
      if (RE.heresThe.test(t)) heres++;
      if (RE.gush.test(t)) gush++;
      if (RE.nominal.test(t)) nominal++;
      if (RE.thatPart.test(t)) thatPart++;
      if (RE.memeCombat.test(t)) memeCombat++;
      if (RE.sitWith.test(t)) sitWith++;
      if (RE.reassure.test(t)) reassure++;
      const fw = ((t.match(/^[A-Za-z']+/) || [''])[0] || '').toLowerCase();
      if (fw) firstWords[fw] = (firstWords[fw] || 0) + 1;
      const sentences = t.split(/(?<=[.!?])\s+/).filter(Boolean);
      for (let si = 1; si < sentences.length; si++) {
        if (
          sentences[si - 1].split(/\s+/).length >= 8 &&
          sentences[si].split(/\s+/).length >= 8 &&
          pairOverlap(sentences[si - 1], sentences[si]) >= 0.5
        ) {
          parallelPairs++;
          break;
        }
      }
      const last = (sentences[sentences.length - 1] || '').toLowerCase().replace(/[^a-z ?]/g, '').trim();
      if (last.length >= 12) closers[last] = (closers[last] || 0) + 1;
    }
    const pct = (x) => (n ? Math.round((100 * x) / n) : 0);
    const topFirst = Object.entries(firstWords)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([w, c]) => ({ word: w, count: c, pct: pct(c) }));
    const topCloser = Object.entries(closers).sort((a, b) => b[1] - a[1])[0] || null;
    res.json({
      ok: true,
      windowHours: 24,
      agentId: KIANA,
      replies: n,
      avgChars: n ? Math.round(chars / n) : 0,
      avgWords: n ? Math.round(words / n) : 0,
      tagOpenedPct: pct(tagOpened),
      questionCloserPct: pct(qClose),
      reframePivots: reframes,
      heresTheThing: heres,
      everythingGush: gush,
      nominalizations: nominal,
      thatPartMeme: thatPart,
      memeCombat,
      sitWith,
      reassuranceVerdicts: reassure,
      parallelPairs,
      tagsTotal,
      commaTags,
      avgTagsPerReply: n ? Math.round((tagsTotal / n) * 10) / 10 : 0,
      topTagPhrase: (() => {
        const top = Object.entries(tagPhrases).sort((a, b) => b[1] - a[1])[0];
        return top && top[1] >= 4 ? { text: top[0].slice(0, 60), count: top[1] } : null;
      })(),
      topFirstWords: topFirst,
      repeatedCloser:
        topCloser && topCloser[1] >= 3
          ? { text: topCloser[0].slice(0, 80), count: topCloser[1] }
          : null,
    });
  } catch (e) {
    logger.error('[kadeClock] voice-report failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
