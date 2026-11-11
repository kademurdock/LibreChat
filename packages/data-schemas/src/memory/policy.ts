import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose from 'mongoose';
import { tombstoneCovers, tombstoneHashes } from './tombstoneMatch';

export interface MemorySource {
  userId: string;
  conversationId: string;
  messageId?: string;
  conversationIds?: string[];
  revision?: number;
  agentId?: string;
  sourceAt?: string | Date;
  kind: 'conversation' | 'user-correction';
}

interface MemoryPolicy {
  userId: string;
  conversationId: string;
  excluded: boolean;
  updatedAt: Date;
}

interface MemoryClear {
  userId: string;
  agentId: string;
  at: Date;
}

export const memorySourceStorage: AsyncLocalStorage<MemorySource> =
  new AsyncLocalStorage<MemorySource>();
const policies = () => mongoose.connection.collection<MemoryPolicy>('kadememorypolicies');
const epochs = () =>
  mongoose.connection.collection<{ _id: string; revision: number }>('kadememoryepochs');
const clears = () => mongoose.connection.collection<MemoryClear>('kadememoryclears');

export async function setMemoryClearCutoff(userId: string, agentId?: string | null): Promise<Date> {
  const at = new Date();
  await clears().createIndex({ userId: 1, agentId: 1 }, { unique: true });
  const scope = { userId, agentId: agentId === undefined ? '*' : agentId || '' };
  await clears().updateOne(scope, { $max: { at } }, { upsert: true });
  await advanceMemoryPolicyRevision(userId);
  return (await clears().findOne(scope))?.at || at;
}

export async function memoryClearCutoff(userId: string, agentId?: string): Promise<Date | null> {
  const row = await clears()
    .find({ userId, agentId: { $in: ['*', '', ...(agentId ? [agentId] : [])] } })
    .sort({ at: -1 })
    .limit(1)
    .next();
  return row?.at || null;
}

export async function memoryPolicyRevision(userId: string): Promise<number> {
  return (await epochs().findOne({ _id: userId }))?.revision || 0;
}

export async function advanceMemoryPolicyRevision(userId: string): Promise<void> {
  await epochs().updateOne({ _id: userId }, { $inc: { revision: 1 } }, { upsert: true });
}

export async function excludedMemoryConversations(userId: string): Promise<string[]> {
  // Canon is shared, so an excluded original conversation must be hidden there too.
  const rows = await policies()
    .find({ ...(userId === '000000000000000000000ca0' ? {} : { userId }), excluded: true })
    .project<{ conversationId: string }>({ conversationId: 1 })
    .toArray();
  return rows.map((row) => row.conversationId);
}

export async function memorySourceAllowed(source?: MemorySource): Promise<boolean> {
  if (!source || source.kind === 'user-correction') return true;
  const cutoff = await memoryClearCutoff(source.userId, source.agentId);
  const at = source.sourceAt ? new Date(source.sourceAt).getTime() : NaN;
  if (
    cutoff &&
    (!Number.isFinite(cutoff.getTime()) || !Number.isFinite(at) || at <= cutoff.getTime())
  )
    return false;
  if (
    source.revision !== undefined &&
    source.revision !== (await memoryPolicyRevision(source.userId))
  )
    return false;
  const excluded = await policies().findOne({
    ...(source.userId === '000000000000000000000ca0' ? {} : { userId: source.userId }),
    conversationId: { $in: source.conversationIds || [source.conversationId] },
    excluded: true,
  });
  if (excluded) return false;
  const user = await mongoose.models.User?.findById(source.userId)
    .select('personalization')
    .lean<{ personalization?: { memories?: boolean } }>();
  return user?.personalization?.memories !== false;
}

export async function memoryDerivationSources(userId: string, agentId?: string): Promise<string[]> {
  const excluded = await excludedMemoryConversations(userId);
  const rows = await mongoose.models.MemoryEntry.find({
    userId,
    status: { $ne: 'superseded' },
    sourceConversationIds: { $nin: excluded },
    $or: [{ agentId: null }, ...(agentId ? [{ agentId }] : [])],
  })
    .select('sourceConversationIds')
    .lean<{ sourceConversationIds?: string[] }[]>();
  return [...new Set(rows.flatMap((row) => row.sourceConversationIds || []))];
}

export async function setConversationMemoryPolicy(
  userId: string,
  conversationId: string,
  excluded: boolean,
): Promise<void> {
  await policies().createIndex({ userId: 1, conversationId: 1 }, { unique: true });
  await policies().updateOne(
    { userId, conversationId },
    { $set: { excluded, updatedAt: new Date() } },
    { upsert: true },
  );
  await advanceMemoryPolicyRevision(userId);
}

/* KADE Nov 11 2026 (card 8): a fact the person asked to forget is not written back by the keeper.
 * The tombstone holds the forgotten words hashed with the person's id (./tombstoneMatch.ts); it is
 * written by api/server/services/kadeKnownTombstones.js. Fails open: a database hiccup never
 * blocks an ordinary write. KADE_KNOWN_TOMBSTONE=0 stops the check. */
interface MemoryTombstone {
  userId: string;
  hashes: string[];
  expiresAt?: Date;
}
const tombstones = () => mongoose.connection.collection<MemoryTombstone>('kadeknowntombstones');

export async function memoryTombstoned(userId: string, value: string): Promise<boolean> {
  if (process.env.KADE_KNOWN_TOMBSTONE === '0') return false;
  try {
    const rows = await tombstones()
      .find({
        userId: String(userId),
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
      })
      .project<{ hashes: string[] }>({ hashes: 1 })
      .limit(500)
      .toArray();
    if (!rows.length) return false;
    const candidate = tombstoneHashes(String(userId), String(value || ''));
    return rows.some((row) => tombstoneCovers(row.hashes, candidate));
  } catch {
    return false;
  }
}

export async function getConversationMemoryPolicy(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  return !!(await policies().findOne({ userId, conversationId, excluded: true }));
}
