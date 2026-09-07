import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose from 'mongoose';

export interface MemorySource {
  userId: string;
  conversationId: string;
  messageId?: string;
  conversationIds?: string[];
  revision?: number;
  kind: 'conversation' | 'user-correction';
}

interface MemoryPolicy {
  userId: string;
  conversationId: string;
  excluded: boolean;
  updatedAt: Date;
}

export const memorySourceStorage: AsyncLocalStorage<MemorySource> =
  new AsyncLocalStorage<MemorySource>();
const policies = () => mongoose.connection.collection<MemoryPolicy>('kadememorypolicies');
const epochs = () =>
  mongoose.connection.collection<{ _id: string; revision: number }>('kadememoryepochs');

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
  const user = await mongoose.models.User?.findById(source.userId).select('personalization').lean();
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

export async function getConversationMemoryPolicy(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  return !!(await policies().findOne({ userId, conversationId, excluded: true }));
}
