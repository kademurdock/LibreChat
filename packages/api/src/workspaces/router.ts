import { z } from 'zod';
import mongoose from 'mongoose';
import { Router, json } from 'express';

import type { RequestHandler, Request, Response } from 'express';
import type { WorkspaceOwner } from '@librechat/data-schemas';
import type { WorkspaceService } from './service';

import { createWorkspaceService, WorkspaceError } from './service';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const name = z.string().trim().min(1).max(120);
const requestId = identifier;
const capabilities = z.array(z.enum(['inspect', 'codex', 'claude', 'custom'])).max(4);
const deviceInput = z
  .object({
    requestId,
    name,
    platform: z.enum(['windows', 'ios', 'android']),
    capabilities,
  })
  .strict();
const deviceUpdate = z.object({ capabilities, name: name.optional() }).strict();
const projectInput = z
  .object({
    requestId,
    name,
    deviceId: identifier,
    workspaceKey: identifier,
    allowEdits: z.boolean().default(false),
    chatProjectId: z
      .string()
      .regex(/^[a-f0-9]{24}$/i)
      .optional(),
  })
  .strict();
const sessionInput = z
  .object({
    requestId,
    projectId: identifier,
    title: name,
    runtime: z.enum(['inspect', 'codex', 'claude', 'custom']),
    model: z.string().trim().min(1).max(160).optional(),
  })
  .strict();
const runInput = z
  .object({
    requestId,
    sessionId: identifier,
    prompt: z.string().trim().min(1).max(32000),
    mode: z.enum(['inspect', 'edit']).default('inspect'),
  })
  .strict();
const pollInput = z.object({ workerInstanceId: identifier }).strict();
const eventInput = z
  .object({
    eventId: identifier.refine(
      (id) => !id.startsWith('srv_'),
      'Server event identifiers are reserved.',
    ),
    type: z.enum(['status', 'message', 'tool', 'result']),
    text: z.string().max(64000).optional(),
    state: z.enum(['running', 'done', 'failed', 'stopped', 'interrupted']).optional(),
    data: z.record(z.string().max(80), z.string().max(8000)).optional(),
  })
  .strict();
const eventsInput = z
  .object({
    workerInstanceId: identifier,
    leaseId: z.string().regex(/^[a-f0-9]{48}$/),
    events: z.array(eventInput).min(1).max(50),
  })
  .strict();
const seenInput = z
  .object({
    kind: z.literal('run'),
    id: identifier,
    throughSequence: z.number().int().min(0),
  })
  .strict();
const readInput = z
  .object({
    kind: z.enum(['alerts', 'announcements', 'agentWork']),
    seenThrough: z.string().datetime({ offset: true }),
  })
  .strict();

function owner(req: Request): WorkspaceOwner {
  if (!req.user?.id) throw new WorkspaceError(401, 'Sign in to use workspaces.');
  return { userId: String(req.user.id), tenantId: req.user.tenantId || 'default' };
}

function token(req: Request): string {
  const authorization = req.get('authorization') || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

const handle =
  (fn: (req: Request, res: Response) => Promise<object>): RequestHandler =>
  (req, res) => {
    void fn(req, res)
      .then((result) => res.json(result))
      .catch((error: Error) => {
        if (error instanceof WorkspaceError)
          return res
            .status(error.status)
            .json({ error: error.message, ...(error.run ? { run: error.run } : {}) });
        if (error instanceof z.ZodError)
          return res.status(400).json({
            error: 'The workspace request is invalid.',
            details: error.issues.map((issue) => issue.message).slice(0, 5),
          });
        return res.status(503).json({
          error: 'Workspace storage is unavailable. Retry with the same request identifier.',
        });
      });
  };

export function createWorkspaceRouter(options: {
  authenticate: RequestHandler;
  service?: WorkspaceService;
  getProject?: (userId: string, projectId: string) => Promise<object | null>;
}): Router {
  const service =
    options.service ||
    createWorkspaceService(mongoose.connection, { getProject: options.getProject });
  const router = Router();
  router.use(json({ limit: '1mb' }));
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use((req, res, next) => {
    if (req.body && Buffer.byteLength(JSON.stringify(req.body)) > 1024 * 1024) {
      res.status(413).json({ error: 'The workspace request exceeds 1 MiB.' });
      return;
    }
    next();
  });
  router.post(
    '/worker/poll',
    handle(async (req) => {
      const input = pollInput.parse(req.body);
      return service.poll(token(req), input.workerInstanceId);
    }),
  );
  router.post(
    '/worker/runs/:id/events',
    handle(async (req) =>
      service.events(token(req), identifier.parse(req.params.id), eventsInput.parse(req.body)),
    ),
  );
  router.use(options.authenticate);
  router.get(
    '/devices',
    handle(async (req) =>
      service.listDevices(
        owner(req),
        req.query.before === undefined ? undefined : identifier.parse(req.query.before),
      ),
    ),
  );
  router.post(
    '/devices',
    handle(async (req) => service.createDevice(owner(req), deviceInput.parse(req.body))),
  );
  router.post(
    '/devices/:id/token',
    handle(async (req) => service.rotate(owner(req), identifier.parse(req.params.id))),
  );
  router.post(
    '/devices/:id/update',
    handle(async (req) =>
      service.updateDevice(
        owner(req),
        identifier.parse(req.params.id),
        deviceUpdate.parse(req.body),
      ),
    ),
  );
  router.post(
    '/devices/:id/revoke',
    handle(async (req) => service.revoke(owner(req), identifier.parse(req.params.id))),
  );
  router.get(
    '/projects',
    handle(async (req) =>
      service.listProjects(
        owner(req),
        req.query.before === undefined ? undefined : identifier.parse(req.query.before),
      ),
    ),
  );
  router.post(
    '/projects',
    handle(async (req) => service.createProject(owner(req), projectInput.parse(req.body))),
  );
  router.get(
    '/sessions',
    handle(async (req) =>
      service.listSessions(
        owner(req),
        req.query.projectId === undefined ? undefined : identifier.parse(req.query.projectId),
        req.query.before === undefined ? undefined : identifier.parse(req.query.before),
      ),
    ),
  );
  router.post(
    '/sessions',
    handle(async (req) => service.createSession(owner(req), sessionInput.parse(req.body))),
  );
  router.get(
    '/runs',
    handle(async (req) =>
      service.listRuns(
        owner(req),
        req.query.before === undefined ? undefined : identifier.parse(req.query.before),
      ),
    ),
  );
  router.post(
    '/runs',
    handle(async (req) => service.createRun(owner(req), runInput.parse(req.body))),
  );
  router.get(
    '/runs/:id',
    handle(async (req) => service.getRun(owner(req), identifier.parse(req.params.id))),
  );
  router.get(
    '/runs/:id/events',
    handle(async (req) =>
      service.getEvents(
        owner(req),
        identifier.parse(req.params.id),
        z.coerce.number().int().min(0).default(0).parse(req.query.after),
      ),
    ),
  );
  router.post(
    '/runs/:id/stop',
    handle(async (req) => service.stop(owner(req), identifier.parse(req.params.id))),
  );
  router.post(
    '/seen',
    handle(async (req) => {
      const input = seenInput.parse(req.body);
      return service.seen(owner(req), input.id, input.throughSequence);
    }),
  );
  router.get(
    '/read-state',
    handle(async (req) => service.readState(owner(req))),
  );
  router.post(
    '/read-state',
    handle(async (req) => {
      const input = readInput.parse(req.body);
      return service.markRead(owner(req), input.kind, input.seenThrough);
    }),
  );
  return router;
}
