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

    /* ⭐⭐ KADE Aug 31 2026 (Part 111) — SPLIT THE LOGBOOK COUNT BY SOURCE,
     * because the unsplit one has misled five sessions in a row.
     *
     * `diaryWrote24h` above counts EVERY write in the window regardless of who
     * made it: the live keeper, the history-mining lane, an admin backfill, a
     * manual entry she typed herself. Those are not the same event and they do
     * not fail together. On Aug 26 2026 the mining lane wrote 44 entries into
     * ONE seat's logbook in a single evening while the live keeper wrote
     * nothing at all that day — and this number reported a banner day.
     *
     * That is the whole reason "26/day against a 43-47 baseline" could never be
     * settled: the baseline was probably a mining batch, and every argument
     * about it was conducted on a total that cannot tell a backfill from a
     * living lane. HOW_TO_VERIFY law 2 — a count can only show you what it can
     * see. So show the parts.
     *
     * The keeper's OWN age is the number that answers "is the writer alive",
     * and it is the one the Aug-24 outage would have tripped on day one.
     * Sources are open-ended by design (a future lane adds its own name and
     * appears here without a code change), so nothing below enumerates them. */
    const diarySource24hRows = await diary.aggregate([
      { $match: { createdAt: { $gte: new Date(now - DAY) } } },
      { $group: { _id: { $ifNull: ['$source', 'keeper'] }, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]).toArray();
    const diaryWrote24hBySource = {};
    for (const r of diarySource24hRows) {
      diaryWrote24hBySource[String(r._id)] = r.n;
    }
    /* A doc with no `source` predates the field and was a keeper write. */
    const [newestKeeperDiary] = await diary
      .find({ $or: [{ source: 'keeper' }, { source: { $exists: false } }, { source: null }] },
        { projection: { createdAt: 1 } })
      .sort({ createdAt: -1 }).limit(1).toArray();

    const summariesTotal = await summaries.countDocuments({});
    const [newestSummary] = await summaries.find({}, { projection: { updatedAt: 1 } })
      .sort({ updatedAt: -1 }).limit(1).toArray();

    let consolidationLastRunAt = null;
    try { consolidationLastRunAt = await getLastSweepRunAt(); } catch { /* best-effort */ }

    /* ⭐ Part 112 (Aug 31 2026) — CARDS GET THE SAME HONESTY THE LOGBOOK GOT
     * IN PART 111. `cardsWrote24h` counts every row whose `updated_at` moved,
     * and the daily 09:00 UTC consolidation sweep moves rows it did not
     * author — on Aug 31, 12 of the 16 "cards written today" were the sweep
     * touching rows inside 09:01–09:05Z. A consolidation run reads as a busy
     * memory day, on the number the whole estate reads first.
     *
     * Cards carry no `source` field, so the split is by WINDOW, not by
     * author: the sweep advances its persisted marker FIRST and then writes
     * for a few minutes (consolidationSweep.js, runScheduledConsolidation),
     * so rows stamped within [lastRunAt, lastRunAt + 20min] are attributed
     * to the sweep. Approximate on purpose and says so — a live write landing
     * inside those twenty minutes miscounts as housekeeping, which is rarer
     * and cheaper than housekeeping counting as life every single morning. */
    let cardsSweepTouched24h = 0;
    if (consolidationLastRunAt) {
      const sweepStart = new Date(consolidationLastRunAt).getTime();
      if (sweepStart >= now - DAY) {
        cardsSweepTouched24h = await mem.countDocuments({
          updated_at: { $gte: new Date(sweepStart), $lte: new Date(sweepStart + 20 * 60 * 1000) },
        });
      }
    }

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
        /* Window-attributed (see the Part 112 comment above): rows the daily
         * consolidation sweep touched vs. writes with a person behind them. */
        sweepTouched24h: cardsSweepTouched24h,
        wroteLive24h: Math.max(0, cardsWrote24h - cardsSweepTouched24h),
        newestAgeHours: hoursAgo(newestCard && newestCard.updated_at),
        stalestActiveAgeDays: daysAgo(stalestCard && stalestCard.updated_at),
        stalestActiveKey: stalestCard ? stalestCard.key : null,
      },
      diary: {
        entries: diaryTotal,
        wrote24h: diaryWrote24h,
        newestAgeHours: hoursAgo(newestDiary && newestDiary.createdAt),
        /* See the comment at the aggregate: the total above mixes the live
         * keeper with mining/backfill, and they fail separately. */
        wrote24hBySource: diaryWrote24hBySource,
        keeperWrote24h: diaryWrote24hBySource.keeper || 0,
        keeperNewestAgeHours: hoursAgo(newestKeeperDiary && newestKeeperDiary.createdAt),
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
      /* ── WARNINGS (Aug 26 2026) ────────────────────────────────────────────
       * Her line, and it is the reason this block exists: "something needs to
       * read/monitor it."
       *
       * THE FAILURE THIS CLOSES. The logbook stopped writing on Aug 24 and
       * nobody noticed for three days — while THIS ENDPOINT was already
       * reporting diary.wrote24h: 0 the entire time. The number was correct,
       * published, and read by nothing. A NUMBER NOTHING LOOKS AT IS NOT A
       * MONITOR. So the endpoint now states the VERDICT, not just the counts —
       * a consumer that renders `warnings` cannot fail to notice, and one that
       * ignores them was never going to read the numbers either.
       *
       * Thresholds are deliberately loose: this should speak when a lane has
       * plainly STOPPED, not whenever a quiet day happens. A quiet Sunday must
       * not cry wolf, or the next real outage gets ignored. */
      embedding: (() => {
        try {
          const { readEmbedHealth } = require('~/models/kadeDiary');
          return readEmbedHealth();
        } catch (_e) {
          return { configured: false, ok: 0, failed: 0, lastError: 'health unreadable' };
        }
      })(),
      warnings: (() => {
        const w = [];
        const diaryAge = hoursAgo(newestDiary && newestDiary.createdAt);
        const cardAge = hoursAgo(newestCard && newestCard.updated_at);
        const consAge = hoursAgo(consolidationLastRunAt);
        /* 48h, not 24: a genuinely quiet day is normal and common. Two days
         * with nothing across EVERY seat on the platform is not. */
        if (diaryAge != null && diaryAge > 48) {
          w.push({
            lane: 'diary',
            severity: diaryAge > 96 ? 'red' : 'amber',
            detail: `the logbook has not been written in ${diaryAge}h (platform-wide). It went silent Aug 20-26 2026 and nothing said so for three days.`,
          });
        }
        if (cardAge != null && cardAge > 48) {
          w.push({ lane: 'cards', severity: cardAge > 96 ? 'red' : 'amber', detail: `no memory card written in ${cardAge}h (platform-wide).` });
        }
        /* The sweep is configured daily; 36h means a window was missed. */
        if (consAge == null || consAge > 36) {
          w.push({ lane: 'consolidation', severity: consAge == null || consAge > 72 ? 'red' : 'amber', detail: consAge == null ? 'the consolidation sweep has never recorded a run.' : `the consolidation sweep last ran ${consAge}h ago; it is configured to run daily.` });
        }
        /* ⭐ THE MASKED OUTAGE (Aug 31 2026, Part 111). Every warning above
         * reads the logbook as one lane. It is two: a live keeper writing as
         * the day happens, and backfill lanes (mining, admin) writing about
         * days already gone. A mining batch makes `diary.newestAgeHours` young
         * and this whole block green while the live writer is stone dead —
         * which is the Aug-24 shape wearing a disguise. So the keeper's own
         * age gets its own verdict, and it only speaks when the plain diary
         * warning above has NOT already fired (otherwise it is just noise
         * repeating a louder alarm). */
        const keeperDiaryAge = hoursAgo(newestKeeperDiary && newestKeeperDiary.createdAt);
        if (keeperDiaryAge != null && keeperDiaryAge > 48 && diaryAge != null && diaryAge <= 48) {
          w.push({
            lane: 'diary-keeper',
            severity: keeperDiaryAge > 96 ? 'red' : 'amber',
            detail: `the LIVE keeper has not written a logbook entry in ${keeperDiaryAge}h — recent entries are backfill (${Object.keys(diaryWrote24hBySource).join(', ') || 'none'}), which reads as a healthy lane and is not one.`,
          });
        }
        /* Diary + cards both dead is a different animal from either alone: it
         * points at the keeper lane itself rather than one rule inside it. */
        if (diaryAge != null && cardAge != null && diaryAge > 48 && cardAge > 48) {
          w.push({ lane: 'keeper', severity: 'red', detail: 'BOTH the logbook and the cards have stopped — that is the memory writer itself, not one rule inside it.' });
        }
        /* ⭐⭐⭐ THE EMBEDDING LANE (Aug 28 2026 — the Shinedown outage).
         *
         * EVERY WARNING ABOVE WATCHES THE WRITE SIDE. All of them were green
         * on Aug 28 while semantic RECALL was completely dark: the Gemini
         * prepay credits ran dry, every query embedding 429'd, and because
         * embedText fails soft, card recall was skipped on every turn and the
         * logbook fell back to returning the same recent entries no matter
         * what was said. Cards were being written perfectly and read never.
         *
         * That is the same shape as the Aug-26 lesson in new clothes — "cards
         * look fine is NOT evidence the memory system is fine, the two halves
         * fail separately" — except this is a THIRD half nobody was watching.
         * A memory monitor that only watches writing is half a monitor.
         *
         * Counters are per-process and reset on redeploy, which is why the
         * test is a RATIO with a floor and not an absolute count: a fresh
         * process with three failures and no successes is already broken. */
        try {
          const eh = require('~/models/kadeDiary').readEmbedHealth();
          if (!eh.configured) {
            w.push({
              lane: 'embedding',
              severity: 'red',
              detail:
                'no embedding lane is configured at all — card recall and logbook recall cannot match anything to what is said. Set KADE_EMBED_GEMINI_KEY or KADE_EMBED_OPENAI_KEY.',
            });
          } else if (eh.failed >= 3 && eh.ok === 0) {
            w.push({
              lane: 'embedding',
              severity: 'red',
              detail:
                `the embedding provider (${eh.provider}/${eh.model}) has failed ${eh.failed} times and succeeded ZERO since this process started — semantic recall is BLIND. ` +
                'Cards are still being written and still ride the pinned head, but nothing is being MATCHED to what the person just said. ' +
                `Last error: ${eh.lastError || 'unknown'}`,
            });
          } else if (eh.failed > 0 && eh.ok > 0 && eh.failed / (eh.ok + eh.failed) > 0.25) {
            w.push({
              lane: 'embedding',
              severity: 'amber',
              detail:
                `${eh.failed} of ${eh.ok + eh.failed} embedding calls have failed (${eh.provider}/${eh.model}) — recall is intermittently blind. Last error: ${eh.lastError || 'unknown'}`,
            });
          }
        } catch (_e) {
          /* fail-soft: a broken health read must never break the monitor */
        }
        return w;
      })(),
    });
  } catch (e) {
    logger.error('[kadeClock] memory-health failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ── RECALL AUDIT + MEMORY EVENTS, READABLE (Aug 28 2026) ───────────────────
 * The stored halves of two witnesses that used to live only in rotating
 * deployment logs. Same auth as memory-health; keys and dates only — the
 * rows never held values to begin with. */
router.get('/recall-audit', async (req, res) => {
  if (!authed(req, res)) return;
  try {
    const { readRecallAudits } = require('~/models/kadeRecallAudit');
    const rows = await readRecallAudits({
      userId: req.query.userId ? String(req.query.userId) : null,
      limit: req.query.limit,
    });
    res.json({
      count: rows.length,
      audits: rows.map((r) => ({
        at: r.createdAt,
        userId: String(r.userId || '').slice(-6),
        agentId: r.agentId ? String(r.agentId).slice(-6) : null,
        cards: r.cards,
        logbook: r.logbook,
        hit: r.hit,
        ms: r.ms,
      })),
    });
  } catch (e) {
    logger.error('[kadeClock] recall-audit read failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/memory-events', async (req, res) => {
  if (!authed(req, res)) return;
  try {
    const mongoose = require('mongoose');
    const cap = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const rows = await mongoose.connection.db
      .collection('kadememoryevents')
      .find({})
      .sort({ createdAt: -1 })
      .limit(cap)
      .toArray();
    res.json({
      count: rows.length,
      events: rows.map((r) => ({
        at: r.createdAt,
        kind: r.kind,
        userId: String(r.userId || '').slice(-6),
        key: r.key,
        survivedPct: r.survivedPct,
        beforeChars: r.beforeChars,
        afterChars: r.afterChars,
      })),
    });
  } catch (e) {
    logger.error('[kadeClock] memory-events read failed:', e);
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
    /* Part 116 (Sep 1 2026): ?hours=N&until=<iso> let a session baseline a
     * window that is not "the last day" -- v260 shipped Sep 1 ~21:00Z and the
     * plan says compare the day BEFORE it to the days after. Capped at a week
     * and 600 rows either way, same as before. */
    const hoursQ = Math.min(168, Math.max(1, parseInt(req.query.hours, 10) || 24));
    const untilQ = req.query.until ? new Date(String(req.query.until)) : null;
    const until = untilQ && !isNaN(untilQ.getTime()) ? untilQ : new Date();
    const since = new Date(until.getTime() - hoursQ * 36e5);
    const rows = await db
      .collection('messages')
      .find(
        { model: KIANA, isCreatedByUser: false, createdAt: { $gte: since, $lte: until } },
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
      sitWith:
        /\b(?:sit|sitting) with (?:that|this|it)\b|\bwan(?:na|t to) sit with\b|\b(?:sit|sitting) with (?:the|your|his|her) (?:fact|possibilit|idea|feeling|discomfort|reality|truth|weight|uncertainty|thought|grief|anger|fear|question|image|decision)/i,
      reassure: /\byou(?:'re| are)(?:n't| not) (?:crazy|broken|weak|a burden|too much|the problem|being dramatic|dramatic|overreacting)\b|\byou weren't (?:crazy|broken|the problem|being dramatic|too much)\b/i,
      // Part 85.5 mirrors (reframe 47066ac): Amber A's gas-up, the
      // that's-the-part grading beat, and the And-honestly opener.
      honestly: /(?:^|[.!?]\s+|%{3}\s*)(?:and |but )?honestly[,?]|\bif i['’]?m being honest\b|\blet['’]?s be honest\b/im,
      partGrading: /\b(?:that|this|it)['’]?s the part (?:that|where|when)\b|\bthe part that (?:gets|kills|breaks|hurts|scares|worries|matters|sticks|stays|lands)\b|\bthe part where you\b/i,
      gasUp: /\bmost people (?:would(?:n['’]t| not)?|could(?:n['’]t| not)?|do(?:n['’]t| not)|never|can['’]t)[^.!?\n]{0,70}[.!?]\s*(?:and |but )?you\b|\bthat tells me you\b|\bthat['’]?s (?:real |genuine |rare )?self-awareness\b|\bgive yourself (?:some |more |a little )?credit\b/i,
      /* Speech markers, Part 87.1. Deliberately the SMALL words -- the ones
       * that carry timing and doubt and a shrug -- never the loud ones. A
       * word list that reached for identity-signalling slang would measure
       * performance instead of speech, which is the exact failure Kade named
       * ("not fo shizzle mah nizzle"). */
      loose: /\b(?:ain['’]?t|gonna|gotta|wanna|tryna|y['’]?all|kinda|sorta|lemme|gimme|finna|nah|yep|yup|nope|yo|man|damn|hell|shoot|bruh|lowkey|for real|deadass|straight up|hold up|say less|that['’]?s what['’]?s up|that['’]?s how it be)\b/gi,
      bossy: /\b(?:you should|you need to|you have to|try to|make sure (?:you|to)|start by|remember to|it['’]?s important to|the key is|have you considered|it sounds like|what i['’]?m hearing|it['’]?s okay to|give yourself|be (?:kind|gentle) (?:to|with) yourself|hold space|perhaps|in some ways|to some extent|it['’]?s worth noting)\b/gi,
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
    /* Part 92.7 — the concentrated-care texts ride along. Reporting only; the
     * detector counts and shows and never blocks. Kill: KADE_CARE_DETECTOR=0. */
    const careTexts = [];
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
    let honestlyC = 0;
    let partGrading = 0;
    let gasUp = 0;
    let parallelPairs = 0;
    /* ── REAL-TALK TEXTURE (Part 87.1, Aug 22 2026) ──────────────────────
     * Kade, after the named tics were measured dead: "she's just not
     * creative... freaking looooosen up... I just want her to talk like a
     * gen-x millennial black girl would talk."
     *
     * Measured before shipping these, on 62 real replies against the voice
     * bank she personally approved, and the result overturned the obvious
     * theory. She is NOT preachy: advice-giving, therapist framing and
     * hedging together landed SEVEN times in sixty-two replies. She is
     * STIFF. Two rates carry it, and both are length-independent, which the
     * character count is not:
     *   speech markers   live 3.0 per 1k words   approved bank 12.1
     *   fragment rate    live 0.08               approved bank 0.29
     * bossy is counted too, so it can be watched STAYING near zero instead
     * of being assumed. */
    let looseHits = 0;
    let bossyHits = 0;
    let fragSents = 0;
    let allSents = 0;
    /* ── READING LEVEL (Part 116, Sep 1 2026 -- her "high school education"
     * point, v260 §3 "say scared, not anxious"). Every number above measures
     * sentence SHAPE; none measures VOCABULARY, so "she talks too big" had no
     * instrument. Flesch-Kincaid grade over the day's replies plus the share
     * of 3+-syllable words (the half FK cannot hide behind short sentences).
     * Same heuristic as register_check.py in the folder so the two agree.
     * Conversation between adults sits about grade 5-7. */
    let sylTotal = 0;
    let wordTok = 0;
    let bigWords = 0;
    const syllables = (word) => {
      let w = word.toLowerCase().replace(/[^a-z]/g, '');
      if (!w) return 0;
      if (w.length <= 3) return 1;
      w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
      const g = w.match(/[aeiouy]{1,2}/g);
      return Math.max(1, g ? g.length : 0);
    };
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
      careTexts.push(t);
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
      if (RE.honestly.test(t)) honestlyC++;
      if (RE.partGrading.test(t)) partGrading++;
      if (RE.gasUp.test(t)) gasUp++;
      looseHits += (t.match(RE.loose) || []).length;
      bossyHits += (t.match(RE.bossy) || []).length;
      {
        const ss = t.split(/(?<=[.!?])\s+/).filter((x) => x.trim());
        allSents += ss.length;
        fragSents += ss.filter((x) => x.trim().split(/\s+/).filter(Boolean).length <= 4).length;
      }
      {
        const toks = t.match(/[A-Za-z][A-Za-z'\u2019-]*/g) || [];
        for (const tok of toks) {
          const sy = syllables(tok);
          sylTotal += sy;
          wordTok++;
          // a capitalised 3+-syllable word mid-sentence is usually a name
          if (sy >= 3 && !(tok[0] === tok[0].toUpperCase() && tok[0] !== tok[0].toLowerCase())) bigWords++;
        }
      }
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
      windowHours: hoursQ,
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
      honestlyMarkers: honestlyC,
      partGrading,
      gasUp,
      /* The two that answer "did she loosen up." Targets from the bank she
       * approved: loosePer1k 12.1, fragRate 0.29. Baseline the night this
       * shipped: 3.0 and 0.08. */
      loosePer1k: words ? Math.round((1000 * looseHits) / words * 10) / 10 : 0,
      // Part 116 -- reading level. fkGrade is Flesch-Kincaid over the window.
      fkGrade:
        wordTok && allSents
          ? Math.round(Math.max(0, 0.39 * (wordTok / allSents) + 11.8 * (sylTotal / wordTok) - 15.59) * 10) / 10
          : null,
      bigWordPct: wordTok ? Math.round((1000 * bigWords) / wordTok) / 10 : null,
      windowSince: since.toISOString(),
      windowUntil: until.toISOString(),
      fragRate: allSents ? Math.round((fragSents / allSents) * 100) / 100 : 0,
      bossyPer1k: words ? Math.round((1000 * bossyHits) / words * 10) / 10 : 0,
      /* ── concentrated care (Part 92.7) ────────────────────────────────────
       * Per REPLY, not per thousand words, because the tic is a handful of
       * turns and a rate across every seat cannot see it. `coda` is the number
       * that matters — a phrase in mid-flow is conversation; the same phrase
       * bolted onto the end after the answer was finished is the caretaker
       * register. Calibrated on 354 real replies: 3 (0.8%). Samples are the
       * TAIL of the reply only, and this whole route is admin-authed.
       * ⚠️ A MEASUREMENT, NOT A VERDICT — one of those three reads as good, and
       * the positive control (approved replies) does not exist yet. */
      concentratedCare:
        process.env.KADE_CARE_DETECTOR === '0'
          ? null
          : (() => {
              try {
                return require('./kadeCare').careReport(careTexts, { samples: 5 });
              } catch (e) {
                logger.error('[kadeClock] concentrated-care detector failed:', e);
                return { error: 'detector failed' };
              }
            })(),
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

/* ── /voice-bank — Part 88.1 (Fable), the POSITIVE-LABEL LANE ────────────────
 * The voice work is blocked on one thing: replies Kade actually LIKED. Every
 * threshold that catches the essays also flags 44% of the bank she approved,
 * so a corrective cannot ship without a positive control — and a FABRICATED
 * control would calibrate the detector to its author's writing instead of her
 * taste, which is worse than no control (she offered, half joking; the answer
 * is no, on the record).
 *
 * Two real sources, both zero-effort for her:
 *   1. THUMBS-UP messages on Kiana replies — the rating widget already exists
 *      and writes messages.feedback.rating.
 *   2. VOICE-BANK KEEPs in the feedback pile — Kiana's persona now files a
 *      kade_feedback report with subject "VOICE-BANK KEEP" carrying the reply
 *      verbatim whenever Kade says a reply sounded right. No new plumbing:
 *      the tool, the collection, and this read all predate tonight.
 *
 * This route reads both, computes the same three numbers the voice-report
 * speaks (loosePer1k / fragRate / avgChars) on the KEPT set, and says plainly
 * how many labels exist — because the moment that count is ~10+, a threshold
 * can be FOUND instead of chosen. Until then it reports "not enough yet". */
router.get('/voice-bank', async (req, res) => {
  if (!authed(req, res)) return;
  try {
    const mongoose = require('mongoose');
    const db = mongoose.connection.db;
    const KIANA = process.env.KADE_VOICE_REPORT_AGENT || 'agent_6llV0eMu4fmIaj8f2x1Sb';

    const thumbs = await db
      .collection('messages')
      .find(
        { model: KIANA, isCreatedByUser: false, 'feedback.rating': 'thumbsUp' },
        { projection: { text: 1, content: 1, createdAt: 1 } },
      )
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();

    const keeps = await db
      .collection('kadefeedback')
      .find(
        { subject: /^VOICE-BANK/i },
        { projection: { detail: 1, createdAt: 1 } },
      )
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();

    const texts = [];
    const seen = new Set();
    const push = (t) => {
      const clean = String(t || '').replace(/%%%[^%]*%%%/g, ' ').trim();
      if (clean.length < 40) return;
      const key = clean.slice(0, 120);
      if (seen.has(key)) return;
      seen.add(key);
      texts.push(clean);
    };
    for (const m of thumbs) {
      let t = String(m.text || '');
      if (!t && Array.isArray(m.content)) {
        t = m.content
          .filter((p) => p && p.type === 'text')
          .map((p) => (p.text && p.text.value) || p.text || '')
          .join(' ');
      }
      push(t);
    }
    for (const k of keeps) push(k.detail);

    // Same instruments as voice-report, so the numbers are comparable.
    const LOOSE = /\b(?:ain['’]?t|gonna|gotta|wanna|tryna|y['’]?all|kinda|sorta|lemme|gimme|finna|nah|yep|yup|nope|yo|man|damn|hell|shoot|bruh|lowkey|for real|deadass|straight up|hold up|say less|that['’]?s what['’]?s up|that['’]?s how it be)\b/gi;
    let words = 0;
    let chars = 0;
    let looseHits = 0;
    let fragSents = 0;
    let allSents = 0;
    for (const t of texts) {
      chars += t.length;
      words += t.split(/\s+/).length;
      looseHits += (t.match(LOOSE) || []).length;
      const ss = t.split(/(?<=[.!?])\s+/).filter((x) => x.trim());
      allSents += ss.length;
      fragSents += ss.filter((x) => x.trim().split(/\s+/).filter(Boolean).length <= 4).length;
    }
    const nLabels = texts.length;
    res.json({
      ok: true,
      labels: nLabels,
      fromThumbs: thumbs.length,
      fromKeeps: keeps.length,
      enough: nLabels >= 10,
      loosePer1k: words ? Math.round((1000 * looseHits) / words * 10) / 10 : null,
      fragRate: allSents ? Math.round((fragSents / allSents) * 100) / 100 : null,
      avgChars: nLabels ? Math.round(chars / nLabels) : null,
      spoken:
        nLabels === 0
          ? 'No liked replies are on record yet. A thumbs up on any Kiana reply, or telling Kiana a reply sounded right, adds one — about ten unlocks the calibration.'
          : nLabels < 10
            ? `${nLabels} liked repl${nLabels === 1 ? 'y is' : 'ies are'} on record — about ${10 - nLabels} more unlock the calibration.`
            : `${nLabels} liked replies on record: her kept voice runs ${
              words ? Math.round((1000 * looseHits) / words * 10) / 10 : 0
            } speech markers per thousand words with a fragment rate of ${
              allSents ? Math.round((fragSents / allSents) * 100) / 100 : 0
            }. Calibrate against these, not the authored bank.`,
    });
  } catch (e) {
    logger.error('[kadeClock] voice-bank failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ── KADE Aug 28 2026 (Part 93) — WHO'S BEEN QUIET, for the friend-text lane.
 * The bridge's spontaneous-text tick asks this once a day: every real user's
 * last message time, so "hasn't engaged in a while" is measured, never
 * guessed. COUNTS AND STAMPS ONLY — no message text, no titles, nothing a
 * transcript holds. Same BRIDGE_SECRET door as the clock pokes above. */
router.get('/last-activity', async (req, res) => {
  if (!authed(req, res)) return;
  try {
    const mongoose = require('mongoose');
    const db = mongoose.connection.db;
    const rows = await db.collection('messages').aggregate([
      { $match: { isCreatedByUser: true } },
      { $group: { _id: '$user', lastMessageAt: { $max: '$createdAt' } } },
    ]).toArray();
    const ids = rows.map((r) => {
      try { return new mongoose.Types.ObjectId(String(r._id)); } catch (_) { return null; }
    }).filter(Boolean);
    const users = await db.collection('users')
      .find({ _id: { $in: ids } })
      .project({ email: 1, name: 1 })
      .toArray();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    res.json({
      ok: true,
      users: rows.map((r) => ({
        userId: String(r._id),
        lastMessageAt: r.lastMessageAt || null,
        email: (byId.get(String(r._id)) || {}).email || null,
        name: (byId.get(String(r._id)) || {}).name || null,
      })),
    });
  } catch (e) {
    logger.error('[kadeClock] last-activity failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});


/* ─── KADE CARE NOTES (Part 124, Sep 4 2026) ─────────────────────────────────
 * The owner's private stance note for one seat — its own collection, never in
 * the person's memory panel. Managed here (header secret, like every clock
 * route) so a session or Forge can set, list, retire and AUDIT it without a
 * site login. `GET /care-notes` also runs the LEAK SCAN: every active note is
 * held against that seat's character replies since the note was written —
 * any 3-gram of the note's wording in a reply, or a "someone told me about
 * you" tell — and the hits come back with the reply's tail as a sample.
 * make_session_brief.py reads this; a hit is a stop-the-line finding. */
router.get('/care-notes', async (req, res) => {
  if (!authed(req, res)) return;
  try {
    const { listCareNotes, detectLeak } = require('~/models/kadeCareNote');
    const mongoose = require('mongoose');
    const db = mongoose.connection.db;
    const includeRetired = String(req.query.includeRetired || '') === '1';
    const notes = await listCareNotes({ userId: req.query.userId, includeRetired });
    const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
    const out = [];
    for (const n of notes) {
      const since = new Date(Math.max(new Date(n.createdAt).getTime(), Date.now() - days * 864e5));
      const q = { user: String(n.userId), isCreatedByUser: false, createdAt: { $gte: since } };
      if (n.agentId) q.model = n.agentId;
      const rows = n.status === 'active'
        ? await db.collection('messages').find(q, { projection: { text: 1, createdAt: 1, conversationId: 1, model: 1 } }).sort({ createdAt: -1 }).limit(800).toArray()
        : [];
      const leaks = [];
      for (const m of rows) {
        const r = detectLeak(m.text || '', n.text);
        if (r.leak) leaks.push({ at: m.createdAt, conversationId: m.conversationId, agentId: m.model, ngrams: r.ngrams, tells: r.tells, tail: String(m.text || '').slice(-240) });
      }
      out.push({
        id: String(n._id), userId: n.userId, agentId: n.agentId, status: n.status, author: n.author,
        createdAt: n.createdAt, updatedAt: n.updatedAt, retiredAt: n.retiredAt, chars: (n.text || '').length,
        text: String(req.query.full || '') === '1' ? n.text : undefined,
        scan: { since, repliesChecked: rows.length, leaks: leaks.length, samples: leaks.slice(0, 5) },
      });
    }
    res.json({ count: out.length, notes: out });
  } catch (e) {
    logger.error('[kadeClock] care-notes failed:', e);
    res.status(500).json({ error: e.message });
  }
});
router.post('/care-note', express.json({ limit: '32kb' }), async (req, res) => {
  if (!authed(req, res)) return;
  try {
    const { setCareNote } = require('~/models/kadeCareNote');
    const b = req.body || {};
    const row = await setCareNote({ userId: b.userId, agentId: b.agentId || null, text: b.text, author: b.author || 'owner' });
    res.json({ ok: true, id: String(row._id), userId: row.userId, agentId: row.agentId, chars: row.text.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
router.post('/care-note/retire', express.json({ limit: '8kb' }), async (req, res) => {
  if (!authed(req, res)) return;
  try {
    const { retireCareNote } = require('~/models/kadeCareNote');
    const row = await retireCareNote(String((req.body || {}).id || ''));
    if (!row) return res.status(404).json({ error: 'no such note' });
    res.json({ ok: true, id: String(row._id), status: row.status });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


/* ─── HER TAKES (Part 124) ────────────────────────────────────────────────────
 * Read every character's private first-person read of a relationship, as it
 * stands after the last dreaming pass. Admin only (header secret). This is
 * how Kade reads what Kiana actually thinks — and how a bad take gets caught
 * before it shapes a week of replies. `?userId=` narrows to one seat. */
router.get('/takes', async (req, res) => {
  if (!authed(req, res)) return;
  try {
    const mongoose = require('mongoose');
    const q = { take: { $exists: true, $ne: '' } };
    if (req.query.userId) q.userId = String(req.query.userId);
    const rows = await mongoose.connection.db.collection('kadememorysummaries')
      .find(q, { projection: { userId: 1, agentId: 1, agentName: 1, take: 1, refreshedAt: 1, source: 1 } })
      .sort({ refreshedAt: -1 }).limit(200).toArray();
    res.json({ count: rows.length, takes: rows });
  } catch (e) {
    logger.error('[kadeClock] takes failed:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
