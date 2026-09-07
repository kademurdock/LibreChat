import { Schema } from 'mongoose';
import type { Model, Mongoose } from 'mongoose';
import { getTenantId } from '../config/tenantContext';

export type AgentTaskStatus = 'running' | 'completed' | 'stopped' | 'failed' | 'removed';

export interface IAgentTask {
  _id: string;
  tenantId: string;
  userId: string;
  taskId: string;
  fingerprint: string;
  conversationId: string;
  status: AgentTaskStatus;
  temporary: boolean;
  jobCreatedAt?: number;
  userMessageId?: string;
  responseMessageId?: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
}

/** Opaque request receipts only. Conversation text stays in the existing message store. */
export function createAgentTaskModel(mongoose: Mongoose): Model<IAgentTask> {
  if (mongoose.models.AgentTask) {
    return mongoose.models.AgentTask as Model<IAgentTask>;
  }
  const schema = new Schema<IAgentTask>(
    {
      _id: { type: String, required: true },
      tenantId: { type: String, required: true },
      userId: { type: String, required: true },
      taskId: { type: String, required: true },
      fingerprint: { type: String, required: true },
      conversationId: { type: String, required: true },
      status: {
        type: String,
        enum: ['running', 'completed', 'stopped', 'failed', 'removed'],
        default: 'running',
      },
      temporary: { type: Boolean, default: false },
      jobCreatedAt: Number,
      userMessageId: String,
      responseMessageId: String,
      expiresAt: Date,
    },
    { timestamps: true, versionKey: false },
  );
  schema.index({ tenantId: 1, userId: 1, temporary: 1, createdAt: -1, _id: -1 });
  schema.index({ tenantId: 1, userId: 1, conversationId: 1 });
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return mongoose.model<IAgentTask>('AgentTask', schema);
}

export async function removeConversationTaskLinks(
  mongoose: Mongoose,
  userId: string,
  conversationIds: string[],
): Promise<void> {
  await createAgentTaskModel(mongoose).updateMany(
    { userId, tenantId: getTenantId() || 'default', conversationId: { $in: conversationIds } },
    {
      $set: { status: 'removed', conversationId: '' },
      $unset: { userMessageId: '', responseMessageId: '', jobCreatedAt: '' },
    },
  );
}
