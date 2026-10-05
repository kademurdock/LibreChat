import mongoose from 'mongoose';
import {
  advanceMemoryPolicyRevision,
  memoryPolicyRevision,
  memorySourceStorage,
} from '@librechat/data-schemas';

/** Explicit private opinion erasure works even when there is no matching fact card. */
export async function forgetRelationshipImpressions({
  userId,
  agentId,
  evidence,
  userEvidence,
}: {
  userId: string;
  agentId: string;
  evidence: string;
  userEvidence: string;
}): Promise<string> {
  const source = memorySourceStorage.getStore();
  if (!userId || !agentId || (source && source.userId !== userId))
    return 'No matching relationship context.';
  if (
    !userEvidence.includes(evidence) ||
    evidence.length < 8 ||
    !/^(?:please\s+)?(?:forget|clear|reset|remove|erase)\b|\b(?:can|could|would|will) you (?:please )?(?:forget|clear|reset|remove|erase)\b|\bI (?:want|need) you to (?:forget|clear|reset|remove|erase)\b/i.test(
      evidence,
    )
  )
    return 'A direct request to forget the private impressions is required.';
  await advanceMemoryPolicyRevision(userId);
  if (source) source.revision = await memoryPolicyRevision(userId);
  await mongoose.connection.collection('kadememorysummaries').updateOne(
    { userId, agentId },
    {
      $set: {
        take: '',
        thread: '',
        learned: '',
        curious: '',
        verdicts: '',
        relationship: {},
        relationshipHistory: [],
        impressionsReset: true,
        impressionsResetAt: new Date(),
      },
      $setOnInsert: { summary: '', sourceConversationIds: [] },
      $inc: { revision: 1 },
    },
    { upsert: true },
  );
  return 'Private relationship impressions and their evidence were cleared. They will not be reconstructed from old context.';
}
