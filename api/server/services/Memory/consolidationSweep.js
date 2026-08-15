const { logger, runAsSystem } = require('@librechat/data-schemas');
const {
  sweepMemoryConsolidation: sweepMemoryConsolidationWithDeps,
  startMemoryConsolidationSweep: startMemoryConsolidationSweepWithDeps,
} = require('@librechat/api');
const db = require('~/models');
const { getLastSweepRunAt, setLastSweepRunAt } = require('~/models/memoryConsolidationSweepState');

/**
 * Binds the platform-wide weekly memory-consolidation sweep
 * (packages/api/src/agents/memory.ts) to this app's concrete Mongo-backed
 * methods -- mirrors api/server/services/Files/process.js's
 * sweepExpiredFiles/startExpiredFileSweep wrapper pattern exactly.
 *
 * Entirely server-side: no Claude/Cowork session, no external scheduler.
 * Must keep running on its own even if Kade's Claude credit runs out, and it
 * covers every user's memory buckets on the platform, not just one account.
 *
 * KADE Aug 15 2026 (Part 70, her word at checkpoint: "Wire V2 in now"): the
 * scheduled sweep now runs CONSOLIDATE-V2 — the connection pass (entity
 * linking + honest inference + contradiction trails + voice repair + all of
 * v1's housekeeping, every edit ledgered) — instead of v1. The v1 engine
 * stays fully wired one env flip away: KADE_SWEEP_ENGINE=v1 restores the old
 * scheduler byte-for-byte, and if KADE_CONSOLIDATE_V2=0 kills the v2 pass the
 * due window falls back to a v1 sweep rather than silently doing nothing.
 * Cadence, window, and the persisted last-run marker are IDENTICAL in both
 * engines (same envs, same Mongo state doc) — the engines can never
 * double-fire in one window.
 *
 * @param {object} [options]
 * @param {import('@librechat/data-schemas').AppConfig} [options.appConfig]
 * @param {() => Promise<import('@librechat/data-schemas').AppConfig>} [options.loadAppConfig]
 */
/** KADE Aug 8 2026: logbook demotion — the sweep can move episodic cards into
 * dated entries. Bound per bucket so scope can never leak across characters. */
function createLogDiary(userId, agentId) {
  return async ({ text, scope, salience }) => {
    const { logDiaryEntry } = require('~/models/kadeDiary');
    return logDiaryEntry({ userId, agentId: agentId || null, text, scope, salience, source: 'keeper' });
  };
}

async function sweepMemoryConsolidation(options = {}) {
  return sweepMemoryConsolidationWithDeps(options, {
    memoryMethods: {
      setMemory: db.setMemory,
      deleteMemory: db.deleteMemory,
      getFormattedMemories: db.getFormattedMemories,
      getActiveMemoryBuckets: db.getActiveMemoryBuckets,
    },
    db: { getUserKey: db.getUserKey, getUserKeyValues: db.getUserKeyValues },
    logger,
    createLogDiary,
  });
}

/** The pre-Part-70 scheduler, unchanged: the TS engine runs v1 housekeeping. */
function startV1Scheduler(options = {}) {
  return startMemoryConsolidationSweepWithDeps(options, {
    memoryMethods: {
      setMemory: db.setMemory,
      deleteMemory: db.deleteMemory,
      getFormattedMemories: db.getFormattedMemories,
      getActiveMemoryBuckets: db.getActiveMemoryBuckets,
    },
    db: { getUserKey: db.getUserKey, getUserKeyValues: db.getUserKeyValues },
    getLastSweepRunAt,
    setLastSweepRunAt,
    runAsSystem,
    logger,
    createLogDiary,
  });
}

/* ---- V2 scheduler (Part 70) ----------------------------------------------
 * Mirrors packages/api/src/agents/memory.ts's wall-clock semantics EXACTLY:
 * hourly check (MEMORY_CONSOLIDATION_SWEEP_INTERVAL_MS, 0 = disabled), target
 * UTC day (MEMORY_CONSOLIDATION_SWEEP_DAY, 'daily' = every day) and hour
 * (MEMORY_CONSOLIDATION_SWEEP_HOUR, default 9), persisted last-run marker
 * gated by MEMORY_CONSOLIDATION_SWEEP_MIN_GAP_MS (default 6 days). Those
 * helpers aren't exported from the package, so the ~20 lines are mirrored
 * here; if the TS defaults ever change, change these too. */
const V2_DEFAULT_CHECK_MS = 60 * 60 * 1000;
const V2_DEFAULT_MIN_GAP_MS = 6 * 24 * 60 * 60 * 1000;
const V2_DEFAULT_UTC_DAY = 0;
const V2_DEFAULT_UTC_HOUR = 9;

function v2IntEnv(raw, dflt, min, max) {
  if (raw == null || String(raw).trim() === '') {
    return dflt;
  }
  const v = Number(String(raw).trim());
  if (!Number.isInteger(v) || v < min || v > max) {
    return dflt;
  }
  return v;
}

function v2CheckIntervalMs() {
  const raw = process.env.MEMORY_CONSOLIDATION_SWEEP_INTERVAL_MS;
  if (raw == null || raw.trim() === '') {
    return V2_DEFAULT_CHECK_MS;
  }
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || (v > 0 && v < 1)) {
    return V2_DEFAULT_CHECK_MS;
  }
  return v;
}

function v2TargetUtcDay() {
  const raw = process.env.MEMORY_CONSOLIDATION_SWEEP_DAY;
  if (raw != null && ['daily', '*', 'everyday', 'every-day'].includes(raw.trim().toLowerCase())) {
    return -1;
  }
  return v2IntEnv(raw, V2_DEFAULT_UTC_DAY, 0, 6);
}

function v2MinGapMs() {
  const raw = process.env.MEMORY_CONSOLIDATION_SWEEP_MIN_GAP_MS;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : V2_DEFAULT_MIN_GAP_MS;
}

function v2Due(now, lastRunAt) {
  const day = v2TargetUtcDay();
  const hour = v2IntEnv(process.env.MEMORY_CONSOLIDATION_SWEEP_HOUR, V2_DEFAULT_UTC_HOUR, 0, 23);
  if ((day !== -1 && now.getUTCDay() !== day) || now.getUTCHours() !== hour) {
    return false;
  }
  if (lastRunAt && now.getTime() - lastRunAt.getTime() < v2MinGapMs()) {
    return false;
  }
  return true;
}

function startV2Scheduler(options = {}) {
  const intervalMs = v2CheckIntervalMs();
  if (intervalMs === 0) {
    logger.info('[sweepMemoryConsolidation] Disabled by MEMORY_CONSOLIDATION_SWEEP_INTERVAL_MS=0');
    return null;
  }

  let isSweeping = false;
  const checkAndMaybeRun = async () => {
    if (isSweeping) {
      return;
    }
    isSweeping = true;
    try {
      const now = new Date();
      const lastRunAt = await runAsSystem(() => getLastSweepRunAt());
      if (!v2Due(now, lastRunAt)) {
        return;
      }
      await runAsSystem(() => setLastSweepRunAt(now));
      const { consolidateV2AllBuckets } = require('~/server/services/Memory/consolidateV2');
      if (process.env.KADE_CONSOLIDATE_V2 === '0') {
        logger.info(
          '[sweepMemoryConsolidation] engine=v2 window reached but KADE_CONSOLIDATE_V2=0 — falling back to a v1 sweep.',
        );
        await runAsSystem(() => sweepMemoryConsolidation(options));
        return;
      }
      logger.info(
        '[sweepMemoryConsolidation] engine=v2 window reached — starting platform-wide CONNECTION pass (consolidate-v2, all buckets, ledgered).',
      );
      const r = await runAsSystem(() => consolidateV2AllBuckets());
      logger.info(`[sweepMemoryConsolidation] engine=v2 kick: ${JSON.stringify(r)}`);
    } catch (error) {
      logger.error('[sweepMemoryConsolidation] engine=v2 background sweep failed:', error);
    } finally {
      isSweeping = false;
    }
  };

  const interval = setInterval(checkAndMaybeRun, intervalMs);
  interval.unref?.();
  logger.info(
    `[sweepMemoryConsolidation] engine=v2 scheduler started -- checking hourly, fires on UTC day ${v2TargetUtcDay()} (0=Sunday, -1=daily) at hour ${v2IntEnv(process.env.MEMORY_CONSOLIDATION_SWEEP_HOUR, V2_DEFAULT_UTC_HOUR, 0, 23)} UTC (connection pass; KADE_SWEEP_ENGINE=v1 restores the old engine).`,
  );
  return interval;
}

function startMemoryConsolidationSweep(options = {}) {
  const engine = (process.env.KADE_SWEEP_ENGINE || 'v2').trim().toLowerCase();
  if (engine === 'v1') {
    logger.info('[sweepMemoryConsolidation] engine=v1 (KADE_SWEEP_ENGINE) — TS housekeeping engine.');
    return startV1Scheduler(options);
  }
  return startV2Scheduler(options);
}

module.exports = { sweepMemoryConsolidation, startMemoryConsolidationSweep };
