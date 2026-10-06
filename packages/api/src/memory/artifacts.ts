import mongoose from 'mongoose';
import {
  logger,
  memorySourceAllowed,
  tenantStorage,
  SYSTEM_TENANT_ID,
} from '@librechat/data-schemas';
import type { MemorySource, TenantContext } from '@librechat/data-schemas';
import type { TAttachment } from 'librechat-data-provider';
import { Tools } from 'librechat-data-provider';

export type MemoryArtifactResult = readonly (Partial<TAttachment> | null)[] | undefined;

export type MemoryArtifactContext = Readonly<MemorySource & {
  messageId: string;
  currentOffRecord: boolean;
  tenant: Readonly<TenantContext>;
}>;

export function captureMemoryArtifactContext(source: MemorySource & {
  messageId: string;
  currentOffRecord?: boolean;
}): MemoryArtifactContext {
  return Object.freeze({
    ...source,
    currentOffRecord: source.currentOffRecord === true,
    tenant: Object.freeze({ ...(tenantStorage.getStore() ?? {}) }),
  });
}

function usableId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value &&
    value !== 'undefined' && value !== 'null';
}

/** Actual keeper receipts only; late tool metadata never chooses the target row. */
export function canonicalMemoryArtifacts(
  context: MemoryArtifactContext,
  attachments: MemoryArtifactResult,
): Partial<TAttachment>[] {
  if (!attachments) return [];
  const seen = new Set<string>();
  const result: Partial<TAttachment>[] = [];
  for (const attachment of attachments.slice(0, 32)) {
    const memory = attachment?.memory;
    if (!memory || !['update', 'delete', 'error'].includes(memory.type) ||
      !usableId(memory.key) || !usableId(attachment.toolCallId) || seen.has(attachment.toolCallId)) continue;
    seen.add(attachment.toolCallId);
    result.push({
      type: Tools.memory,
      toolCallId: attachment.toolCallId,
      messageId: context.messageId,
      conversationId: context.conversationId,
      memory: {
        key: memory.key,
        type: memory.type,
        ...(typeof memory.value === 'string' ? { value: memory.value } : {}),
        ...(typeof memory.tokenCount === 'number' && Number.isFinite(memory.tokenCount)
          ? { tokenCount: memory.tokenCount } : {}),
      },
    });
  }
  return result;
}

/** Append only to an existing authenticated reply. Never rebuild a deleted row. */
export async function persistMemoryArtifacts(
  context: MemoryArtifactContext,
  attachments: MemoryArtifactResult,
): Promise<number> {
  if (context.currentOffRecord || !usableId(context.userId) ||
    !usableId(context.messageId) || !usableId(context.conversationId) ||
    context.tenant.tenantId === SYSTEM_TENANT_ID ||
    (context.tenant.userId && context.tenant.userId !== context.userId)) return 0;
  const receipts = canonicalMemoryArtifacts(context, attachments);
  if (!receipts.length) return 0;
  return tenantStorage.run({ ...context.tenant }, async () => {
    if (!(await memorySourceAllowed(context))) return 0;
    const Message = mongoose.models.Message;
    const Conversation = mongoose.models.Conversation;
    if (!Message || !Conversation) return 0;
    // Null also matches a missing tenant on pre-tenancy rows. Missing ALS must
    // never become a cross-tenant lookup merely because strict mode is off.
    const scope = {
      user: context.userId,
      conversationId: context.conversationId,
      tenantId: context.tenant.tenantId ?? null,
    };
    if (!(await Conversation.exists(scope))) return 0;
    const removeReceipts = () => Message.updateOne(
      { ...scope, messageId: context.messageId, isCreatedByUser: false },
      { $pull: { attachments: { type: Tools.memory, toolCallId: {
        $in: receipts.flatMap((receipt) => receipt.toolCallId ? [receipt.toolCallId] : []),
      } } } },
      { upsert: false },
    );
    let written = 0;
    for (const receipt of receipts) {
      if (!(await memorySourceAllowed(context))) break;
      const changed = await Message.updateOne(
        {
          ...scope,
          messageId: context.messageId,
          isCreatedByUser: false,
          attachments: { $not: { $elemMatch: { type: 'memory', toolCallId: receipt.toolCallId } } },
        },
        { $push: { attachments: receipt } },
        { upsert: false },
      );
      written += changed.modifiedCount;
      // Exclusion/clear can advance while Mongo executes the update. Remove
      // only this receipt if its captured source became disallowed in flight.
      if (!(await memorySourceAllowed(context))) {
        await removeReceipts();
        return 0;
      }
    }
    if (!(await memorySourceAllowed(context))) {
      await removeReceipts();
      return 0;
    }
    return written;
  });
}

/** Observe existing work after the reply save; do not await this on the chat road. */
export function scheduleMemoryArtifactPersistence({
  context,
  memoryResult,
  responseSaved,
}: {
  context?: MemoryArtifactContext;
  memoryResult?: Promise<MemoryArtifactResult>;
  responseSaved: Promise<unknown>;
}): Promise<number> {
  if (!context || !memoryResult) return Promise.resolve(0);
  return Promise.all([memoryResult, responseSaved])
    .then(([attachments]) => persistMemoryArtifacts(context, attachments))
    .catch((error: unknown) => {
      logger.warn('[MemoryArtifact] Could not retain keeper receipt', {
        messageId: context.messageId,
        conversationId: context.conversationId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return 0;
    });
}
