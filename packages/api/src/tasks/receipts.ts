import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { createAgentTaskModel } from '@librechat/data-schemas';
import type { IAgentTask, AgentTaskStatus } from '@librechat/data-schemas';

export interface TaskOwner {
  userId: string;
  tenantId?: string;
}

export interface TaskClaim extends TaskOwner {
  taskId: string;
  fingerprint: string;
  conversationId?: string;
  temporary?: boolean;
}

export class TaskConflict extends Error {}

export interface TaskReceipts {
  claim(input: TaskClaim): Promise<{ task: IAgentTask; created: boolean }>;
  bind(owner: TaskOwner, taskId: string, jobCreatedAt: number): Promise<void>;
  settle(
    owner: TaskOwner,
    taskId: string,
    status: Exclude<AgentTaskStatus, 'running' | 'removed'>,
    messages?: { userMessageId?: string; responseMessageId?: string },
  ): Promise<void>;
  recordMessages(
    owner: TaskOwner,
    taskId: string,
    messages: { userMessageId: string; responseMessageId: string },
  ): Promise<void>;
  list(owner: TaskOwner, before?: string): Promise<IAgentTask[]>;
  get(owner: TaskOwner, taskId: string): Promise<IAgentTask | null>;
}

export function taskKey(owner: TaskOwner, taskId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([owner.tenantId || 'default', owner.userId, taskId]))
    .digest('hex');
}

export function taskFingerprint(parts: (string | boolean | null)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function validTaskId(value: string): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

export function createTaskReceipts(db: mongoose.Mongoose = mongoose): TaskReceipts {
  const model = createAgentTaskModel(db);
  const scope = (owner: TaskOwner) => ({
    userId: owner.userId,
    tenantId: owner.tenantId || 'default',
  });
  const identity = (owner: TaskOwner, taskId: string) => ({
    ...scope(owner),
    _id: taskKey(owner, taskId),
  });

  async function claim(input: TaskClaim): Promise<{ task: IAgentTask; created: boolean }> {
    if (!validTaskId(input.taskId)) {
      throw new TaskConflict('The request identifier is invalid.');
    }
    const conversationId =
      input.conversationId && input.conversationId !== 'new' ? input.conversationId : randomUUID();
    try {
      const task = await model.create({
        ...identity(input, input.taskId),
        taskId: input.taskId,
        fingerprint: input.fingerprint,
        conversationId,
        status: 'running',
        temporary: !!input.temporary,
        ...(input.temporary && { expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) }),
      });
      return { task: task.toObject(), created: true };
    } catch (error) {
      if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) {
        throw error;
      }
      const task = await model.findOne(identity(input, input.taskId)).lean();
      if (!task || task.fingerprint !== input.fingerprint) {
        throw new TaskConflict('This request identifier already belongs to a different message.');
      }
      if (task.status === 'removed') {
        throw new TaskConflict('This request belongs to a deleted chat. It was not sent again.');
      }
      return { task, created: false };
    }
  }

  async function bind(owner: TaskOwner, taskId: string, jobCreatedAt: number): Promise<void> {
    await model.updateOne(
      { ...identity(owner, taskId), status: 'running' },
      { $set: { jobCreatedAt } },
    );
  }

  async function settle(
    owner: TaskOwner,
    taskId: string,
    status: Exclude<AgentTaskStatus, 'running' | 'removed'>,
    messages: { userMessageId?: string; responseMessageId?: string } = {},
  ): Promise<void> {
    await model.updateOne(
      { ...identity(owner, taskId), status: 'running' },
      { $set: { status, ...messages } },
    );
  }

  async function recordMessages(
    owner: TaskOwner,
    taskId: string,
    messages: { userMessageId: string; responseMessageId: string },
  ): Promise<void> {
    await model.updateOne({ ...identity(owner, taskId), status: 'running' }, { $set: messages });
  }

  async function list(owner: TaskOwner, before?: string): Promise<IAgentTask[]> {
    const cursor =
      before && validTaskId(before) ? await model.findOne(identity(owner, before)).lean() : null;
    return model
      .find({
        ...scope(owner),
        temporary: false,
        status: { $ne: 'removed' },
        ...(cursor && {
          $or: [
            { createdAt: { $lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, _id: { $lt: cursor._id } },
          ],
        }),
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(21)
      .lean();
  }

  return {
    claim,
    bind,
    settle,
    recordMessages,
    list,
    get: async (owner: TaskOwner, taskId: string) => model.findOne(identity(owner, taskId)).lean(),
  };
}

let receipts: TaskReceipts | undefined;
export function getTaskReceipts(): TaskReceipts {
  return (receipts ??= createTaskReceipts());
}
