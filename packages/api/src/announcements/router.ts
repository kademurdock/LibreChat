import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { Types } from 'mongoose';
import type { RequestHandler } from 'express';
import type { Connection } from 'mongoose';

type Database = NonNullable<Connection['db']>;
type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
type PublicAgent = { id: string; name: string; isPublic: true };
type Payload = {
  id: string;
  title: string;
  body: string;
  agentId: string;
  url: string;
  payloadHash: string;
};
type PushRow = { _id: Types.ObjectId; userId: Types.ObjectId; subscription: PushSubscription };
type UserRow = { _id: Types.ObjectId };
type AgentRow = { _id: Types.ObjectId; id: string; name: string };
type Operation = {
  _id: string;
  id: string;
  payloadHash: string;
  state: 'sending' | 'complete' | 'failed' | 'unknown' | 'skipped';
  configured: boolean;
  eligibleUsers: number;
  subscriptions: number;
  attempted: number;
  accepted: number;
  failed: number;
  unknown: number;
  startedAt: Date;
  updatedAt: Date;
  reason?: string;
};
export type AnnouncementDependencies = {
  db: () => Database | undefined;
  secret: () => string | undefined;
  configured: () => boolean;
  excludedUser: (id: string) => boolean;
  readBan: (id: string) => Promise<{ expiresAt?: number | string | null } | null | undefined>;
  send: (subscription: PushSubscription, payload: string) => Promise<unknown>;
};

const agentPattern = /^agent_[A-Za-z0-9_-]{1,100}$/;
const operationPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const objectIdPattern = /^[a-f0-9]{24}$/i;
const operationCollection = 'kadeannouncementweboperations';

export function announcementURL(agentId: string): string {
  return 'https://kademurdock.com/c/new?agent_id=' + encodeURIComponent(agentId);
}

export function announcementPayloadHash(
  value: Pick<Payload, 'id' | 'title' | 'body' | 'agentId' | 'url'>,
): string {
  const { id, title, body, agentId, url } = value;
  return createHash('sha256')
    .update(JSON.stringify({ id, title, body, agentId, url }), 'utf8')
    .digest('hex');
}

function parsePayload(value: Partial<Payload> | undefined): Payload | null {
  if (
    !value ||
    typeof value.id !== 'string' ||
    !operationPattern.test(value.id) ||
    typeof value.agentId !== 'string' ||
    !agentPattern.test(value.agentId) ||
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    value.title.length > 120 ||
    typeof value.body !== 'string' ||
    !value.body.trim() ||
    value.body.length > 3000 ||
    value.url !== announcementURL(value.agentId) ||
    typeof value.payloadHash !== 'string'
  )
    return null;
  const payload = value as Payload;
  return payload.payloadHash === announcementPayloadHash(payload) ? payload : null;
}

function response(operation: Operation) {
  const {
    id,
    payloadHash,
    state,
    configured,
    eligibleUsers,
    subscriptions,
    attempted,
    accepted,
    failed,
    unknown,
    reason,
  } = operation;
  return {
    ok: true,
    id,
    payloadHash,
    state,
    configured,
    eligibleUsers,
    subscriptions,
    attempted,
    accepted,
    failed,
    unknown,
    ...(reason ? { reason } : {}),
  };
}

async function publicAgent(db: Database, agentId: string): Promise<PublicAgent | null> {
  if (!agentPattern.test(agentId)) return null;
  const agent = await db
    .collection<AgentRow>('agents')
    .findOne({ id: agentId }, { projection: { _id: 1, id: 1, name: 1 } });
  if (!agent) return null;
  const access = await db.collection('aclentries').findOne({
    principalType: 'public',
    resourceType: 'agent',
    resourceId: agent._id,
    permBits: { $bitsAllSet: 1 },
    $or: [
      { expiredAt: { $exists: false } },
      { expiredAt: null },
      { expiredAt: { $gt: new Date() } },
    ],
  });
  return access ? { id: agent.id, name: agent.name, isPublic: true } : null;
}

async function audience(db: Database, deps: AnnouncementDependencies) {
  const rows = await db
    .collection<UserRow>('users')
    .find({}, { projection: { _id: 1 } })
    .toArray();
  const eligible = new Set<string>();
  let excludedTest = 0;
  for (const row of rows) {
    const id = row._id.toString();
    if (deps.excludedUser(id)) {
      excludedTest++;
      continue;
    }
    const ban = await deps.readBan(id);
    if (
      ban &&
      (!ban.expiresAt ||
        !Number.isFinite(Number(ban.expiresAt)) ||
        Number(ban.expiresAt) > Date.now())
    )
      continue;
    eligible.add(id);
  }
  const subscriptions = await db
    .collection<PushRow>('kadepushsubs')
    .find({ userId: { $in: [...eligible].map((id) => new Types.ObjectId(id)) } })
    .toArray();
  return { total: rows.length, excludedTest, eligible, subscriptions };
}

function statusCode(error: unknown): number | null {
  if (
    !error ||
    typeof error !== 'object' ||
    !('statusCode' in error) ||
    typeof error.statusCode !== 'number'
  )
    return null;
  return error.statusCode;
}

export function createAnnouncementRouter(
  deps: AnnouncementDependencies,
): ReturnType<typeof Router> {
  const router = Router();
  const running = new Set<string>();
  const authorize: RequestHandler = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const expected = deps.secret(),
      supplied = req.get('x-bridge-secret');
    if (!expected) {
      res.status(503).json({ error: 'Announcement delivery is not configured.' });
      return;
    }
    const valid =
      typeof supplied === 'string' &&
      Buffer.byteLength(supplied) === Buffer.byteLength(expected) &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (!valid) {
      res.status(403).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
  const readAudience: RequestHandler = async (req, res) => {
    try {
      const db = deps.db();
      if (!db) {
        res.status(503).json({ error: 'Account storage is unavailable.' });
        return;
      }
      const agentId = req.method === 'POST' ? req.body?.agentId : req.query.agentId;
      if (typeof agentId !== 'string') {
        res.status(400).json({ error: 'agentId required' });
        return;
      }
      const agent = await publicAgent(db, agentId);
      if (!agent) {
        res.status(404).json({ error: 'A public agent is required.' });
        return;
      }
      const nativeUserIds: string[] = req.method === 'POST' ? req.body?.nativeUserIds : [];
      if (
        !Array.isArray(nativeUserIds) ||
        nativeUserIds.length > 20000 ||
        nativeUserIds.some((id) => typeof id !== 'string' || !objectIdPattern.test(id))
      ) {
        res.status(400).json({ error: 'nativeUserIds must be a bounded account ID list.' });
        return;
      }
      const found = await audience(db, deps);
      const indexes = nativeUserIds.flatMap((id, index) =>
        found.eligible.has(id.toLowerCase()) ? [index] : [],
      );
      res.json({
        ok: true,
        publicAgent: agent,
        accounts: {
          eligible: found.eligible.size,
          total: found.total,
          excludedTest: found.excludedTest,
        },
        web: {
          configured: deps.configured(),
          subscriptions: found.subscriptions.length,
          users: new Set(found.subscriptions.map((sub) => sub.userId.toString())).size,
        },
        ...(req.method === 'POST' ? { nativeEligibleIndexes: indexes } : {}),
      });
    } catch {
      res.status(503).json({ error: 'Announcement audience is unavailable.' });
    }
  };
  router.get('/announcement-audience', authorize, readAudience);
  router.post('/announcement-audience', authorize, readAudience);
  router.get('/announcement-web-push/:id', authorize, async (req, res) => {
    try {
      const db = deps.db();
      if (!db) {
        res.status(503).json({ error: 'Delivery storage is unavailable.' });
        return;
      }
      const operation = await db
        .collection<Operation>(operationCollection)
        .findOne({ _id: String(req.params.id) });
      if (!operation) {
        res.status(404).json({ error: 'No announcement delivery with that ID.' });
        return;
      }
      if (
        operation.state === 'sending' &&
        !running.has(operation.id) &&
        Date.now() - operation.updatedAt.getTime() > 600000
      ) {
        operation.state = 'unknown';
        operation.reason = 'An earlier delivery did not finish; do not retry it.';
      }
      res.json(response(operation));
    } catch {
      res.status(503).json({ error: 'Delivery status is unavailable.' });
    }
  });
  router.post('/announcement-web-push', authorize, async (req, res) => {
    const payload = parsePayload(req.body);
    if (!payload) {
      res
        .status(400)
        .json({ error: 'A canonical announcement and matching payloadHash are required.' });
      return;
    }
    const db = deps.db();
    if (!db) {
      res.status(503).json({ error: 'Delivery storage is unavailable.' });
      return;
    }
    const store = db.collection<Operation>(operationCollection);
    let claimed = false;
    try {
      const previous = await store.findOne({ _id: payload.id });
      if (previous) {
        if (previous.payloadHash !== payload.payloadHash) {
          res.status(409).json({ error: 'Announcement ID already has different content.' });
          return;
        }
        res.json(response(previous));
        return;
      }
      if (!(await publicAgent(db, payload.agentId))) {
        res.status(404).json({ error: 'A public agent is required.' });
        return;
      }
      const found = await audience(db, deps),
        configured = deps.configured();
      const operation: Operation = {
        _id: payload.id,
        id: payload.id,
        payloadHash: payload.payloadHash,
        state: configured ? 'sending' : 'skipped',
        configured,
        eligibleUsers: found.eligible.size,
        subscriptions: found.subscriptions.length,
        attempted: 0,
        accepted: 0,
        failed: 0,
        unknown: 0,
        startedAt: new Date(),
        updatedAt: new Date(),
        ...(configured ? {} : { reason: 'Web Push is not configured.' }),
      };
      try {
        await store.insertOne(operation);
      } catch {
        const concurrent = await store.findOne({ _id: payload.id });
        if (!concurrent) throw new Error('Delivery could not be reserved.');
        if (concurrent.payloadHash !== payload.payloadHash) {
          res.status(409).json({ error: 'Announcement ID already has different content.' });
          return;
        }
        res.json(response(concurrent));
        return;
      }
      claimed = true;
      if (!configured) {
        res.json(response(operation));
        return;
      }
      running.add(payload.id);
      const pushPayload = JSON.stringify({
        title: payload.title,
        body: payload.body,
        url: payload.url,
        announcementId: payload.id,
        kadeRoute: 'agent-chat',
        kadeAgentId: payload.agentId,
      });
      for (const sub of found.subscriptions) {
        operation.attempted++;
        operation.unknown++;
        operation.updatedAt = new Date();
        await store.updateOne(
          { _id: payload.id },
          {
            $set: {
              attempted: operation.attempted,
              unknown: operation.unknown,
              updatedAt: operation.updatedAt,
            },
          },
        );
        try {
          await deps.send(sub.subscription, pushPayload);
          operation.accepted++;
          operation.unknown--;
        } catch (error) {
          const code = statusCode(error);
          if (code !== null) {
            operation.failed++;
            operation.unknown--;
          }
          if (code === 404 || code === 410)
            await db.collection('kadepushsubs').deleteOne({ _id: sub._id });
        }
        operation.updatedAt = new Date();
        await store.updateOne(
          { _id: payload.id },
          {
            $set: {
              accepted: operation.accepted,
              failed: operation.failed,
              unknown: operation.unknown,
              updatedAt: operation.updatedAt,
            },
          },
        );
      }
      operation.state = 'complete';
      if (operation.failed && !operation.accepted) operation.state = 'failed';
      if (operation.unknown) operation.state = 'unknown';
      if (operation.unknown)
        operation.reason = 'Some provider outcomes were uncertain; no automatic resend.';
      await store.updateOne(
        { _id: payload.id },
        {
          $set: {
            state: operation.state,
            ...(operation.reason ? { reason: operation.reason } : {}),
            updatedAt: new Date(),
          },
        },
      );
      res.json(response(operation));
    } catch {
      if (claimed)
        await store
          .updateOne(
            { _id: payload.id },
            {
              $set: {
                state: 'unknown',
                reason: 'Delivery was interrupted; reconcile this ID without resending.',
                updatedAt: new Date(),
              },
            },
          )
          .catch(() => {});
      res.status(503).json({
        error: 'Announcement delivery could not finish. Reconcile this ID; do not resend.',
      });
    } finally {
      running.delete(payload.id);
    }
  });
  return router;
}
