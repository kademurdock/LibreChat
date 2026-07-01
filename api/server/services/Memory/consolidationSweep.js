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
 * @param {object} [options]
 * @param {import('@librechat/data-schemas').AppConfig} [options.appConfig]
 * @param {() => Promise<import('@librechat/data-schemas').AppConfig>} [options.loadAppConfig]
 */
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
  });
}

function startMemoryConsolidationSweep(options = {}) {
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
  });
}

module.exports = { sweepMemoryConsolidation, startMemoryConsolidationSweep };
