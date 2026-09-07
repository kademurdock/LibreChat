import { Router } from 'express';
import type { IAgentTask } from '@librechat/data-schemas';
import type { Request } from 'express';
import type { TaskMessage } from './status';
import { GenerationJobManager } from '../stream/GenerationJobManager';
import { getTaskReceipts, validTaskId } from './receipts';
import { taskStatus } from './status';

interface TaskQueries {
  getConvo: (
    userId: string,
    conversationId: string,
  ) => Promise<{
    conversationId: string;
    title?: string;
  } | null>;
  getMessages: (filter: {
    user: string;
    conversationId: string;
    messageId: string;
  }) => Promise<TaskMessage[]>;
}

export function createTaskRouter(queries: TaskQueries): Router {
  const router = Router();
  const owner = (req: Request) => ({ userId: req.user!.id, tenantId: req.user!.tenantId });

  async function view(req: Request, task: IAgentTask) {
    const conversation = await queries.getConvo(req.user!.id, task.conversationId);
    const job = await GenerationJobManager.getJob(task.conversationId);
    const ownedJob =
      job?.metadata.userId === req.user!.id &&
      (job.metadata.tenantId == null || job.metadata.tenantId === req.user!.tenantId)
        ? job
        : null;
    const replies =
      task.responseMessageId && conversation
        ? await queries.getMessages({
            user: req.user!.id,
            conversationId: task.conversationId,
            messageId: task.responseMessageId,
          })
        : [];
    return {
      taskId: task.taskId,
      conversationId: task.conversationId,
      status: taskStatus(task, ownedJob, replies[0]),
      title: conversation?.title || 'Agent request',
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      responseMessageId: conversation ? task.responseMessageId : undefined,
      canOpenConversation: !!conversation,
    };
  }

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/', async (req, res) => {
    try {
      const before = typeof req.query.before === 'string' ? req.query.before : undefined;
      if (before && !validTaskId(before)) {
        return res.status(400).json({ error: 'Invalid page cursor.' });
      }
      const rows = await getTaskReceipts().list(owner(req), before);
      const page = rows.slice(0, 20);
      const tasks = await Promise.all(page.map((task) => view(req, task)));
      return res.json({ tasks, nextCursor: rows.length > 20 ? page[19].taskId : null });
    } catch {
      return res
        .status(503)
        .json({ error: 'Your request history could not be loaded. Try Refresh.' });
    }
  });
  router.get('/:taskId', async (req, res) => {
    const taskId = String(req.params.taskId);
    if (!validTaskId(taskId)) {
      return res.status(404).json({ error: 'Request not found.' });
    }
    try {
      const task = await getTaskReceipts().get(owner(req), taskId);
      if (!task || task.status === 'removed') {
        return res.status(404).json({ error: 'Request not found.' });
      }
      return res.json(await view(req, task));
    } catch {
      return res.status(503).json({ error: 'This request could not be checked. Try Refresh.' });
    }
  });
  return router;
}
