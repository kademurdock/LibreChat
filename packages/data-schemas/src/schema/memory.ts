import { Schema } from 'mongoose';
import type { IMemoryEntry } from '~/types/memory';

const MemoryEntrySchema: Schema<IMemoryEntry> = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    required: true,
  },
  /**
   * Scopes this entry to a single agent's own memory bucket (e.g. Kiana, Forge),
   * on top of the shared bucket every agent already saw. Stores the agent's
   * application-level string `id` (e.g. "agent_FFecOqZ6hHCVpY507-VAD") -- NOT a
   * Mongo ObjectId, since Agent documents in this codebase are keyed by a custom
   * string `id` field, not `_id`. Absent/null = shared/global entry, visible to
   * every agent -- this is the pre-existing behavior for every memory that
   * existed before this field was added, completely unchanged.
   */
  agentId: {
    type: String,
    index: true,
    required: false,
  },
  key: {
    type: String,
    required: true,
    validate: {
      validator: (v: string) => /^[a-z_]+$/.test(v),
      message: 'Key must only contain lowercase letters and underscores',
    },
  },
  value: {
    type: String,
    required: true,
  },
  tokenCount: {
    type: Number,
    default: 0,
  },
  /**
   * 'active' entries are the current facts an agent sees; 'superseded' entries
   * are kept for history when a fact changes, instead of being overwritten or
   * deleted in place. Reads only ever surface 'active' entries by default.
   * Entries written before this field existed have no `status` in the database
   * at all (not merely defaulted) -- every read filters with `{ $ne: 'superseded' }`
   * rather than `{ status: 'active' }` so those legacy rows keep showing up.
   */
  status: {
    type: String,
    enum: ['active', 'superseded'],
    default: 'active',
    index: true,
  },
  /** Points at the entry this one replaced, when it exists because of a supersede. */
  supersedes: {
    type: Schema.Types.ObjectId,
    ref: 'MemoryEntry',
    required: false,
  },
  /**
   * 'reminder' entries are data-layer groundwork for a future reminder agent
   * (not built yet). Default 'fact' means nothing changes for normal memories.
   */
  type: {
    type: String,
    enum: ['fact', 'reminder'],
    default: 'fact',
  },
  /** Reminder-only fields below; all optional, unused by type: 'fact' entries. */
  dueAt: {
    type: Date,
    required: false,
  },
  recurrence: {
    type: String,
    required: false,
  },
  completed: {
    type: Boolean,
    required: false,
  },
  updated_at: {
    type: Date,
    default: Date.now,
  },
  tenantId: {
    type: String,
    index: true,
  },
});

/** Supports the (userId, agentId, key) scoping every read/write now filters on. */
MemoryEntrySchema.index({ userId: 1, agentId: 1, key: 1 });
/** Supports the future reminder-agent query: `{ type: 'reminder', dueAt: { $lte: now }, completed: false }`. */
MemoryEntrySchema.index({ userId: 1, type: 1, dueAt: 1, completed: 1 });

export default MemoryEntrySchema;
