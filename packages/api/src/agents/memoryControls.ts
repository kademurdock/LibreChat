import { Router } from 'express';
import mongoose from 'mongoose';
import {
  advanceMemoryPolicyRevision,
  getConversationMemoryPolicy,
  setConversationMemoryPolicy,
} from '@librechat/data-schemas';
import type { RequestHandler, Request, Response } from 'express';
import type { IMemoryEntryLean } from '@librechat/data-schemas';

const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    void fn(req, res).catch(next);
  };

/** Owner-scoped controls. Exclusion never deletes the original conversation. */
export function createMemoryControlsRouter({
  getConvo,
  setMemory,
  countTokens,
  canRead,
  canUpdate,
  canOptOut,
}: {
  getConvo: (userId: string, conversationId: string) => Promise<unknown>;
  setMemory: (input: {
    userId: string;
    key: string;
    value: string;
    agentId?: string;
    tokenCount: number;
    userCorrection: boolean;
  }) => Promise<{ ok: boolean }>;
  countTokens: (value: string) => number;
  canRead: RequestHandler;
  canUpdate: RequestHandler;
  canOptOut: RequestHandler;
}): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get(
    '/conversation/:conversationId',
    canRead,
    handle(async (req, res) => {
      try {
        const userId = String((req.user as { id?: string })?.id);
        if (!(await getConvo(userId, req.params.conversationId)))
          return res.status(404).json({ error: 'Conversation not found' });
        return res.json({
          excluded: await getConversationMemoryPolicy(userId, req.params.conversationId),
        });
      } catch {
        return res.status(503).json({ error: 'Memory controls are unavailable. Try again.' });
      }
    }),
  );
  router.patch(
    '/conversation/:conversationId',
    canOptOut,
    handle(async (req, res) => {
      try {
        const userId = String((req.user as { id?: string })?.id);
        if (typeof req.body?.excluded !== 'boolean')
          return res.status(400).json({ error: 'excluded must be a boolean' });
        if (!(await getConvo(userId, req.params.conversationId)))
          return res.status(404).json({ error: 'Conversation not found' });
        await setConversationMemoryPolicy(userId, req.params.conversationId, req.body.excluded);
        // Bump summary revisions to prevent an in-flight writer restoring the old derived summary.
        if (req.body.excluded)
          await mongoose.connection
            .collection('kadememorysummaries')
            .updateMany(
              { userId, sourceConversationIds: req.params.conversationId },
              { $set: { invalidated: true }, $inc: { revision: 1 } },
            );
        return res.json({ excluded: req.body.excluded });
      } catch {
        return res
          .status(503)
          .json({ error: 'Could not confirm the memory setting. Refresh before continuing.' });
      }
    }),
  );
  router.get(
    '/source/:memoryId',
    canRead,
    handle(async (req, res) => {
      try {
        const userId = String((req.user as { id?: string })?.id);
        if (!mongoose.isValidObjectId(req.params.memoryId))
          return res.status(404).json({ error: 'Memory not found' });
        const row = await mongoose.models.MemoryEntry.findOne({
          _id: req.params.memoryId,
          userId,
        }).lean<IMemoryEntryLean>();
        if (!row) return res.status(404).json({ error: 'Memory not found' });
        const sources = [];
        for (const conversationId of row.sourceConversationIds || []) {
          if (await getConvo(userId, conversationId))
            sources.push({
              conversationId,
              excluded: await getConversationMemoryPolicy(userId, conversationId),
            });
        }
        const related = await mongoose.models.MemoryEntry.find({
          userId,
          status: { $ne: 'superseded' },
          $or: [{ key: row.key }, ...(row.subject ? [{ subject: row.subject }] : [])],
        })
          .select('_id key value agentId subject correctionLocked')
          .limit(50)
          .lean();
        return res.json({
          memory: row,
          sources,
          related,
          sourceEvidence: sources.length ? 'recorded' : 'unavailable',
        });
      } catch {
        return res.status(503).json({ error: 'Could not load memory sources.' });
      }
    }),
  );
  router.post(
    '/correct',
    canUpdate,
    handle(async (req, res) => {
      try {
        const userId = String((req.user as { id?: string })?.id);
        const { ids, value } = req.body || {};
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          ids.length > 50 ||
          ids.some((id) => typeof id !== 'string' || !mongoose.isValidObjectId(id)) ||
          typeof value !== 'string' ||
          !value.trim() ||
          value.length > 10000
        )
          return res.status(400).json({
            error: 'Choose up to 50 memories and enter a correction of at most 10,000 characters.',
          });
        const rows = await mongoose.models.MemoryEntry.find({
          _id: { $in: ids },
          userId,
          status: { $ne: 'superseded' },
        }).lean();
        if (rows.length !== new Set(ids).size)
          return res.status(409).json({
            error: 'A selected memory changed or is unavailable. Refresh before correcting.',
          });
        await advanceMemoryPolicyRevision(userId);
        const completed: string[] = [];
        // Every selected record retains its own bucket, key and superseded history.
        for (const row of rows) {
          const result = await setMemory({
            userId,
            key: row.key,
            agentId: row.agentId || undefined,
            value: value.trim(),
            tokenCount: countTokens(value.trim()),
            userCorrection: true,
          });
          if (!result.ok)
            return res.status(409).json({
              error: 'Some corrections could not be saved. Refresh to review.',
              completed,
            });
          completed.push(String(row._id));
        }
        await mongoose.connection
          .collection('kadememorysummaries')
          .updateMany({ userId }, { $set: { invalidated: true }, $inc: { revision: 1 } });
        return res.json({ corrected: completed.length });
      } catch {
        return res.status(503).json({
          error: 'Could not confirm all corrections. Refresh to review the saved records.',
        });
      }
    }),
  );
  return router;
}
