const mongoose = require('mongoose');

/**
 * MemoryConsolidationSweepState — a single singleton document persisting when the
 * platform-wide weekly memory-consolidation sweep last actually ran (see
 * packages/api/src/agents/memory.ts: startMemoryConsolidationSweep). Exists so a
 * server restart/redeploy never causes a double-fire within the same week -- the
 * in-process setInterval check alone can't tell "did this already run" across a
 * process restart, only this persisted marker can.
 *
 * Bespoke, lives outside @librechat/data-schemas so it needs no TS build step
 * (mirrors api/models/kadeUsage.js's pattern exactly).
 */
const SINGLETON_ID = 'memory-consolidation-sweep';

const memoryConsolidationSweepStateSchema = new mongoose.Schema({
  _id: { type: String, default: SINGLETON_ID },
  lastRunAt: { type: Date },
});

const MemoryConsolidationSweepState =
  mongoose.models.MemoryConsolidationSweepState ||
  mongoose.model(
    'MemoryConsolidationSweepState',
    memoryConsolidationSweepStateSchema,
    'memoryconsolidationsweepstate',
  );

/** Returns the last confirmed sweep run time, or null if the sweep has never run. */
async function getLastSweepRunAt() {
  try {
    const doc = await MemoryConsolidationSweepState.findById(SINGLETON_ID).lean();
    return doc && doc.lastRunAt ? doc.lastRunAt : null;
  } catch (error) {
    throw new Error(
      `Failed to read memory consolidation sweep state: ${error && error.message}`,
    );
  }
}

/** Persists a new last-run marker (upserts the singleton doc). */
async function setLastSweepRunAt(date) {
  try {
    await MemoryConsolidationSweepState.findByIdAndUpdate(
      SINGLETON_ID,
      { lastRunAt: date },
      { upsert: true, new: true },
    );
  } catch (error) {
    throw new Error(
      `Failed to persist memory consolidation sweep state: ${error && error.message}`,
    );
  }
}

module.exports = { MemoryConsolidationSweepState, getLastSweepRunAt, setLastSweepRunAt };
