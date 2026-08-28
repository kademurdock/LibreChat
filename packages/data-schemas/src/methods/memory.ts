import { Types } from 'mongoose';
import type * as t from '~/types';
import logger from '~/config/winston';

/* Once-per-process TTL-index ensure for the overwrite-watch receipts. */
let memoryEventsIndexEnsured = false;

/**
 * Formats a date in YYYY-MM-DD format
 */
const formatDate = (date: Date): string => {
  return date.toISOString().split('T')[0];
};

/**
 * Normalizes an agentId filter value for Mongo queries. `undefined` means "no
 * agentId filter at all" (match every bucket); `null` or a real agent id string
 * both resolve to an explicit value Mongo can equality-match on. Querying with
 * `null` matches BOTH documents explicitly set to `agentId: null` and legacy
 * documents that predate this field entirely (Mongo treats "missing" and
 * "null" as equivalent for equality queries) -- so this needs no data migration.
 */
const toAgentFilterValue = (agentId?: string | null): string | null => agentId ?? null;

// Factory function that takes mongoose instance and returns the methods
export function createMemoryMethods(mongoose: typeof import('mongoose')): {
  setMemory: (params: t.SetMemoryParams) => Promise<t.MemoryResult>;
  createMemory: (params: t.SetMemoryParams) => Promise<t.MemoryResult>;
  deleteMemory: (params: t.DeleteMemoryParams) => Promise<t.MemoryResult>;
  getAllUserMemories: (
    userId: string | Types.ObjectId,
    options?: t.GetAllUserMemoriesOptions,
  ) => Promise<t.IMemoryEntryLean[]>;
  getFormattedMemories: (
    params: t.GetFormattedMemoriesParams,
  ) => Promise<t.FormattedMemoriesResult>;
  deleteAllUserMemories: (
    userId: string | Types.ObjectId,
    options?: t.DeleteAllUserMemoriesOptions,
  ) => Promise<number>;
  getActiveMemoryBuckets: () => Promise<t.MemoryBucketRef[]>;
} {
  /**
   * Creates a new memory entry for a user (and optionally, one agent's bucket).
   * Throws an error if an ACTIVE memory with the same key already exists in that bucket.
   */
  async function createMemory({
    userId,
    agentId,
    key,
    value,
    tokenCount = 0,
    type = 'fact',
    dueAt,
    recurrence,
    completed,
  }: t.SetMemoryParams): Promise<t.MemoryResult> {
    try {
      if (key?.toLowerCase() === 'nothing') {
        return { ok: false };
      }

      const MemoryEntry = mongoose.models.MemoryEntry;
      const existingMemory = await MemoryEntry.findOne({
        userId,
        agentId: toAgentFilterValue(agentId),
        key,
        status: { $ne: 'superseded' },
      });
      if (existingMemory) {
        throw new Error('Memory with this key already exists');
      }

      await MemoryEntry.create({
        userId,
        agentId: agentId ?? undefined,
        key,
        value,
        tokenCount,
        status: 'active',
        type,
        dueAt,
        recurrence,
        completed,
        updated_at: new Date(),
      });

      return { ok: true };
    } catch (error) {
      throw new Error(
        `Failed to create memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Sets or updates a memory entry for a user (and optionally, one agent's bucket).
   *
   * Hygiene behavior: if an ACTIVE entry already exists for this (userId, agentId, key)
   * and the value is genuinely changing, the old entry is marked `status: 'superseded'`
   * (kept, not deleted) and a new `active` entry is created with `supersedes` pointing
   * at it -- a changelog instead of a silent overwrite. If the value is unchanged
   * (aside from whitespace), this just touches `updated_at` in place with no new
   * history row, so re-affirming an existing fact doesn't create churn.
   */
  async function setMemory({
    userId,
    agentId,
    key,
    value,
    tokenCount = 0,
    type,
    dueAt,
    recurrence,
    completed,
    staleAfter,
    subject,
  }: t.SetMemoryParams): Promise<t.MemoryResult> {
    try {
      if (key?.toLowerCase() === 'nothing') {
        return { ok: false };
      }

      const MemoryEntry = mongoose.models.MemoryEntry;
      const scopedAgentId = toAgentFilterValue(agentId);
      /** Aug 22 2026 (Part 85.5): fetch ALL non-superseded rows for this key,
       * not one. Two ACTIVE rows with the same key were found live (Amber L's
       * bucket held duplicate ptsd_triggers + marionville cards) — a race or a
       * failed save had left a sibling behind, and findOne() then superseded
       * only whichever it happened to grab, making the duplicate permanent.
       * Newest row stays the inherit source; every older sibling is retired. */
      const existingRows = await MemoryEntry.find({
        userId,
        agentId: scopedAgentId,
        key,
        status: { $ne: 'superseded' },
      }).sort({ updated_at: -1 });
      const existing = existingRows[0];

      if (existing && existing.value.trim() === value.trim()) {
        existing.updated_at = new Date();
        if (tokenCount) {
          existing.tokenCount = tokenCount;
        }
        await existing.save();
        /* July 13 2026 (Kade: "updated memory bubble before every message,
         * same Kasper card"): identical re-saves are a silent refresh, NOT an
         * update — flag it so the tool can skip the UI bubble. */
        return { ok: true, unchanged: true };
      }

      /* ── OVERWRITE WATCH (Aug 26 2026) ────────────────────────────────────
       * Forge asked for a "contradiction guard on writes". ⚠️ THIS IS NOT ONE,
       * AND THE DIFFERENCE MATTERS ENOUGH TO SAY IN CODE: deciding that a new
       * value CONTRADICTS an old one is a semantic judgement, and doing it
       * properly costs a model call on the write path of every turn. Doing it
       * with a word list is how the last five detectors on this platform died.
       *
       * What IS cheap and honest is noticing the SHAPE of a dangerous write: a
       * substantial card being replaced by something that shares almost nothing
       * with it. That is what an overwrite-by-confabulation looks like from the
       * outside, and it is exactly the Amber A case — a card reading "has an
       * associate's degree and has never had a job" being displaced by nursing
       * school.
       *
       * It BLOCKS NOTHING. The old value is already kept (status: superseded),
       * so nothing is ever lost; this only makes the event visible in the logs
       * instead of silent. Turning it into a real gate needs her word and a
       * corpus pass first. KADE_OVERWRITE_WATCH=0 silences it. */
      if (existing && process.env.KADE_OVERWRITE_WATCH !== '0') {
        try {
          const words = (t: string) =>
            new Set(
              String(t || '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, ' ')
                .split(' ')
                .filter((w) => w.length > 3),
            );
          const before = words(existing.value);
          const after = words(value);
          if (before.size >= 8) {
            let shared = 0;
            for (const w of before) {
              if (after.has(w)) shared += 1;
            }
            const survived = shared / before.size;
            if (survived < 0.34) {
              logger.warn(
                `[memory] LARGE OVERWRITE key="${key}" user=${String(userId).slice(-6)} — only ${Math.round(survived * 100)}% of the old card survived (${existing.value.length} chars -> ${String(value).length}). Old value kept as superseded. This is the shape a confabulated overwrite makes.`,
              );
              /* ⭐ AUG 28 2026 — THE WATCH'S EVIDENCE NOW OUTLIVES THE LOGS.
               *
               * The contradiction guard Forge asked for is gated on "read the
               * overwrite-watch hits first — they're free evidence." Two days
               * after the watch shipped, the honest count of its hits was
               * UNKNOWABLE: it warned into deployment logs, the fork deploys
               * several times a day, and every rotation took the evidence
               * with it. "Zero hits on the current deployment" is not zero
               * hits — it is the mining gauge's arithmetic in new clothes,
               * a number that reads as an answer and measures only the
               * window.
               *
               * Same privacy rule as the recall audit: key, sizes and the
               * survival ratio — NEVER either value. The superseded row
               * already keeps the old text for anyone with admin rights; the
               * event row only has to prove the event happened. TTL 60 days
               * via the index below. Fail-soft: a watch must never block a
               * write, and neither may its receipt. */
              try {
                const eventsDb = mongoose.connection.db;
                if (!eventsDb) {
                  throw new Error('no db handle');
                }
                const eventsCol = eventsDb.collection('kadememoryevents');
                if (!memoryEventsIndexEnsured) {
                  memoryEventsIndexEnsured = true;
                  eventsCol
                    .createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 86400 })
                    .catch(() => {});
                }
                eventsCol
                  .insertOne({
                    kind: 'large_overwrite',
                    userId: String(userId),
                    agentId: scopedAgentId == null ? null : String(scopedAgentId),
                    key: String(key).slice(0, 120),
                    survivedPct: Math.round(survived * 100),
                    beforeChars: existing.value.length,
                    afterChars: String(value).length,
                    createdAt: new Date(),
                  })
                  .catch(() => {});
              } catch (_e) {
                /* receipt lost, write unharmed */
              }
            }
          }
        } catch (_e) {
          /* a watch must never block a write */
        }
      }

      for (const row of existingRows) {
        row.status = 'superseded';
        await row.save();
      }

      /** KADE July 13 2026 — WIPE-BUG GUARD: rewriting a card's text must never
       * silently strip its reminder scheduling. Any field the caller does NOT
       * explicitly provide is inherited from the entry being superseded, so a
       * value-only rewrite (panel edit, writer tighten, consolidation pass)
       * keeps type/dueAt/recurrence/completed intact. A caller that DOES pass
       * dueAt is setting a fresh schedule: completed resets to false unless
       * stated, and recurrence: null explicitly clears an inherited repeat. */
      const explicitDueAt = dueAt !== undefined;
      /* KADE Aug 26 2026 — staleAfter and subject ride the SAME wipe guard as
       * dueAt: a value-only rewrite (panel edit, writer tighten, consolidation
       * pass) must never silently strip a declared open loop or its subject. */
      const explicitStale = staleAfter !== undefined;
      const explicitSubject = subject !== undefined;
      await MemoryEntry.create({
        userId,
        agentId: agentId ?? undefined,
        key,
        value,
        tokenCount,
        status: 'active',
        type: type ?? existing?.type ?? 'fact',
        dueAt: explicitDueAt ? (dueAt ?? undefined) : existing?.dueAt,
        recurrence: recurrence !== undefined ? (recurrence ?? undefined) : existing?.recurrence,
        completed:
          completed !== undefined ? completed : explicitDueAt ? false : existing?.completed,
        staleAfter: explicitStale ? (staleAfter ?? undefined) : existing?.staleAfter,
        subject: explicitSubject ? (subject ?? undefined) : existing?.subject,
        supersedes: existing ? existing._id : undefined,
        updated_at: new Date(),
      });

      return { ok: true };
    } catch (error) {
      throw new Error(
        `Failed to set memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Deletes a memory entry for a user -- the explicit "I actually want this gone"
   * action. Removes the ENTIRE lineage for this (userId, agentId, key): the active
   * entry plus any superseded history behind it, not just the current row. This is
   * the one place data actually disappears; `setMemory` never deletes anything.
   */
  async function deleteMemory({
    userId,
    agentId,
    key,
  }: t.DeleteMemoryParams): Promise<t.MemoryResult> {
    try {
      const MemoryEntry = mongoose.models.MemoryEntry;
      const result = await MemoryEntry.deleteMany({
        userId,
        agentId: toAgentFilterValue(agentId),
        key,
      });
      return { ok: (result.deletedCount ?? 0) > 0 };
    } catch (error) {
      throw new Error(
        `Failed to delete memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Gets memory entries for a user.
   * - No `options.agentId` passed at all -> every bucket (shared + every agent's), matching
   *   the original pre-agentId behavior exactly. This is what the self-service /memories
   *   REST route uses, so a user's memory management page still shows everything.
   * - `options.agentId: null` -> shared bucket only.
   * - `options.agentId: '<agent id>'` -> just that one agent's bucket.
   * - `options.includeSuperseded` -> include history rows (default: active-only).
   */
  async function getAllUserMemories(
    userId: string | Types.ObjectId,
    options: t.GetAllUserMemoriesOptions = {},
  ): Promise<t.IMemoryEntryLean[]> {
    try {
      const MemoryEntry = mongoose.models.MemoryEntry;
      const filter: Record<string, unknown> = { userId };
      if (Object.prototype.hasOwnProperty.call(options, 'agentId')) {
        filter.agentId = toAgentFilterValue(options.agentId);
      }
      if (!options.includeSuperseded) {
        filter.status = { $ne: 'superseded' };
      }
      return (await MemoryEntry.find(filter).lean()) as t.IMemoryEntryLean[];
    } catch (error) {
      throw new Error(
        `Failed to get all memories: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Gets and formats memories for a user in two different formats, merging the
   * shared bucket with one agent's own bucket (when `agentId` is passed) into a
   * single result. When no agent-scoped entries exist (or no `agentId` was passed),
   * the output is byte-for-byte the same plain, unlabeled list as before this
   * feature existed. Only once BOTH buckets have content does either format add
   * section headers, so the agent's own context understands which is which.
   * Pass `onlyThisBucket: true` (with a real `agentId`) to skip the shared fetch
   * entirely and get back just that agent's own bucket -- used by consolidation.
   */
  async function getFormattedMemories({
    userId,
    agentId,
    onlyThisBucket = false,
  }: t.GetFormattedMemoriesParams): Promise<t.FormattedMemoriesResult> {
    try {
      const includeShared = !(onlyThisBucket && agentId);
      const [sharedMemories, agentMemories] = await Promise.all([
        includeShared
          ? getAllUserMemories(userId, { agentId: null })
          : Promise.resolve([] as t.IMemoryEntryLean[]),
        agentId
          ? getAllUserMemories(userId, { agentId })
          : Promise.resolve([] as t.IMemoryEntryLean[]),
      ]);

      const allMemories = [...sharedMemories, ...agentMemories];
      if (allMemories.length === 0) {
        return { withKeys: '', withoutKeys: '', totalTokens: 0 };
      }

      const totalTokens = allMemories.reduce((sum, memory) => sum + (memory.tokenCount || 0), 0);

      const sortAsc = (list: t.IMemoryEntryLean[]) =>
        [...list].sort(
          (a, b) => new Date(a.updated_at!).getTime() - new Date(b.updated_at!).getTime(),
        );

      /** KADE July 13 2026: reminder cards carry live scheduling — surface it so
       * the memory writer (and consolidation passes) can SEE which cards are
       * scheduled alarms, and so personas can answer "when's my reminder?". */
      const describeReminder = (memory: t.IMemoryEntryLean, compact = false) => {
        if (memory.type !== 'reminder' || !memory.dueAt) {
          return '';
        }
        const fires = new Date(memory.dueAt).toLocaleString('en-US', {
          timeZone: 'America/Chicago',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
        const repeat = memory.recurrence ? `, repeats ${memory.recurrence}` : '';
        const fired = memory.completed ? ', already fired' : '';
        return compact
          ? ` (reminder fires ${fires} CT${repeat}${fired})`
          : ` ["reminder": fires ${fires} CT${repeat}${fired}]`;
      };

      const formatWithKeys = (list: t.IMemoryEntryLean[]) =>
        sortAsc(list)
          .map((memory, index) => {
            const date = formatDate(new Date(memory.updated_at!));
            const tokenInfo = memory.tokenCount ? ` [${memory.tokenCount} tokens]` : '';
            return `${index + 1}. [${date}]. ["key": "${memory.key}"]${tokenInfo}. ["value": "${memory.value}"]${describeReminder(memory)}`;
          })
          .join('\n\n');

      const formatWithoutKeys = (list: t.IMemoryEntryLean[]) =>
        sortAsc(list)
          .map((memory, index) => {
            const date = formatDate(new Date(memory.updated_at!));
            return `${index + 1}. [${date}]. ${memory.value}${describeReminder(memory, true)}`;
          })
          .join('\n\n');

      const joinSections = (sections: Array<{ label: string; body: string }>) => {
        const nonEmpty = sections.filter((section) => section.body);
        return nonEmpty
          .map((section) =>
            nonEmpty.length > 1 ? `# ${section.label}\n${section.body}` : section.body,
          )
          .join('\n\n');
      };

      const withKeys = joinSections([
        { label: 'Shared memory (known to every assistant)', body: formatWithKeys(sharedMemories) },
        {
          label: 'Agent-specific memory (known only to this assistant)',
          body: formatWithKeys(agentMemories),
        },
      ]);

      const withoutKeys = joinSections([
        { label: 'What you generally know about the user', body: formatWithoutKeys(sharedMemories) },
        {
          label: 'What you specifically remember on your own',
          body: formatWithoutKeys(agentMemories),
        },
      ]);

      return { withKeys, withoutKeys, totalTokens };
    } catch (error) {
      logger.error('Failed to get formatted memories:', error);
      return { withKeys: '', withoutKeys: '', totalTokens: 0 };
    }
  }

  /**
   * Deletes all memory entries for a user. No `options.agentId` -> wipes every
   * bucket (original behavior, used by the full memory opt-out flow). Pass
   * `agentId` (or `null` for shared) to scope the wipe to just one bucket.
   */
  async function deleteAllUserMemories(
    userId: string | Types.ObjectId,
    options: t.DeleteAllUserMemoriesOptions = {},
  ): Promise<number> {
    try {
      const MemoryEntry = mongoose.models.MemoryEntry;
      const filter: Record<string, unknown> = { userId };
      if (Object.prototype.hasOwnProperty.call(options, 'agentId')) {
        filter.agentId = toAgentFilterValue(options.agentId);
      }
      const result = await MemoryEntry.deleteMany(filter);
      return result.deletedCount;
    } catch (error) {
      throw new Error(
        `Failed to delete all user memories: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Returns every distinct (userId, agentId) bucket that currently has at least
   * one ACTIVE memory entry, across EVERY user on the platform -- not scoped to
   * a single caller. Used only by the platform-wide weekly consolidation sweep
   * (api/server/services/Memory/consolidationSweep.js), which wraps this in
   * runAsSystem() so tenant isolation (if ever enabled) doesn't silently filter
   * it down to nothing.
   */
  async function getActiveMemoryBuckets(): Promise<t.MemoryBucketRef[]> {
    try {
      const MemoryEntry = mongoose.models.MemoryEntry;
      const results = (await MemoryEntry.aggregate([
        { $match: { status: { $ne: 'superseded' } } },
        { $group: { _id: { userId: '$userId', agentId: '$agentId' } } },
      ])) as Array<{ _id: { userId: Types.ObjectId; agentId?: string | null } }>;
      return results.map((r) => ({
        userId: r._id.userId,
        agentId: r._id.agentId ?? null,
      }));
    } catch (error) {
      throw new Error(
        `Failed to get active memory buckets: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  return {
    setMemory,
    createMemory,
    deleteMemory,
    getAllUserMemories,
    getFormattedMemories,
    deleteAllUserMemories,
    getActiveMemoryBuckets,
  };
}

export type MemoryMethods = ReturnType<typeof createMemoryMethods>;
