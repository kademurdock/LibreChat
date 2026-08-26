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
  /**
   * KADE OPEN LOOPS (Aug 26 2026). The date this card's claim GOES STALE on.
   * Set by the memory writer when — and only when — it files a forward-looking
   * commitment ("surgery is Thursday August 27"). Absent on every ordinary fact,
   * which is almost all of them.
   *
   * ⚠️ WHY THE WRITER SETS THIS AND NOT A PARSER: version one of the recall flag
   * inferred the loop from card text and was run over 192 real cards. It fired
   * 15 times and was right ONCE — it flagged a dead parrot, a dead dog, a CPR
   * certificate and a Shinedown concert. A DATE IS NOT A TENSE. Only the writer,
   * holding the conversation, knows whether it is filing a plan or a record.
   */
  staleAfter: {
    type: Date,
    required: false,
  },
  /**
   * KADE SUBJECT GROUPING (Aug 26 2026). The real-world thing this card is about
   * ("mom_foot_surgery"). Optional and free-form, shaped like a key.
   *
   * THE BUG IT EXISTS FOR: one surgery lived across SEVEN cards under seven keys
   * — date, pre-op, anaesthesia, recovery, surgical detail, calendar, and a
   * family aside. The correction rule says to update "the SAME key", which has no
   * answer at seven, so a perfectly obedient update left six stale. Consolidation
   * was right not to merge them (they are seven different true facts, not
   * duplicates). A subject is the missing handle: it makes "update the surgery"
   * addressable without destroying any of the seven.
   */
  subject: {
    type: String,
    required: false,
    index: true,
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
/** Supports the open-loop sweep: which declared loops have come due for this user. */
MemoryEntrySchema.index({ userId: 1, staleAfter: 1 });
/** Supports "every card about this thing" — the handle the correction rule needs. */
MemoryEntrySchema.index({ userId: 1, agentId: 1, subject: 1 });

export default MemoryEntrySchema;
