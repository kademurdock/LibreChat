import type { IAgentTask, AgentTaskStatus } from '@librechat/data-schemas';

export interface TaskJob {
  createdAt: number;
  status: string;
}

export interface TaskMessage {
  messageId: string;
  unfinished?: boolean;
  error?: boolean;
  isCreatedByUser?: boolean;
}

/** A missing stream is not proof of a saved reply or a completed external action. */
export function taskStatus(
  task: IAgentTask,
  job: TaskJob | null,
  reply?: TaskMessage,
): AgentTaskStatus | 'starting' | 'interrupted' {
  if (task.status !== 'running') {
    return task.status;
  }
  if (job && job.createdAt === task.jobCreatedAt && job.status === 'running') {
    return 'running';
  }
  if (reply && reply.messageId === task.responseMessageId && !reply.isCreatedByUser) {
    if (reply.error) {
      return 'failed';
    }
    if (reply.unfinished === false) {
      return 'completed';
    }
  }
  if (!task.jobCreatedAt && Date.now() - task.createdAt.getTime() < 30_000) {
    return 'starting';
  }
  return 'interrupted';
}
