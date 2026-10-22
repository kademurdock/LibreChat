import mongoose from 'mongoose';
import { createHash, randomBytes } from 'node:crypto';
import { workspaceCollections } from '@librechat/data-schemas';

import type {
  WorkspaceDeviceRecord,
  WorkspaceProjectRecord,
  WorkspaceSessionRecord,
  WorkspaceRunRecord,
  WorkspaceOwner,
} from '@librechat/data-schemas';
import type {
  WorkspaceDevice,
  WorkspaceProject,
  WorkspaceSession,
  WorkspaceRun,
  WorkspaceWorkerRun,
  WorkspaceEventInput,
  WorkspaceEvent,
  WorkspaceReadState,
  WorkspaceReadKind,
} from 'librechat-data-provider';
import type { Connection } from 'mongoose';

export class WorkspaceError extends Error {
  constructor(
    public status: number,
    message: string,
    public run: WorkspaceRun | undefined = undefined,
  ) {
    super(message);
  }
}

type DeviceInput = Pick<WorkspaceDevice, 'name' | 'platform' | 'capabilities'> & {
  requestId: string;
};
type ProjectInput = Omit<WorkspaceProject, 'id' | 'createdAt'> & { requestId: string };
type SessionInput = Omit<WorkspaceSession, 'id' | 'createdAt'> & { requestId: string };
type RunInput = Pick<WorkspaceRun, 'sessionId' | 'prompt' | 'mode'> & { requestId: string };
type ProjectReader = (userId: string, projectId: string) => Promise<object | null>;

const active = new Set(['queued', 'running', 'stopping']);
const terminal = new Set(['done', 'failed', 'stopped', 'interrupted']);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const fingerprint = (value: object) => digest(JSON.stringify(value));
const identity = (owner: WorkspaceOwner, kind: string, requestId: string) =>
  `${kind}_${digest(JSON.stringify([owner.tenantId, owner.userId, requestId])).slice(0, 40)}`;
const beforeCursor = (row?: { id: string; createdAt: string } | null) =>
  row
    ? {
        $or: [
          { createdAt: { $lt: row.createdAt } },
          { createdAt: row.createdAt, _id: { $lt: row.id } },
        ],
      }
    : {};
const emptyReads = (): WorkspaceReadState => ({
  alerts: null,
  announcements: null,
  agentWork: null,
});
const deviceView = (row: WorkspaceDeviceRecord): WorkspaceDevice => ({
  id: row.id,
  name: row.name,
  platform: row.platform,
  capabilities: row.capabilities,
  createdAt: row.createdAt,
  lastSeenAt: row.lastSeenAt,
  revokedAt: row.revokedAt,
});
const projectView = (row: WorkspaceProjectRecord): WorkspaceProject => ({
  id: row.id,
  name: row.name,
  deviceId: row.deviceId,
  workspaceKey: row.workspaceKey,
  allowEdits: row.allowEdits,
  ...(row.chatProjectId ? { chatProjectId: row.chatProjectId } : {}),
  createdAt: row.createdAt,
});
const sessionView = (row: WorkspaceSessionRecord): WorkspaceSession => ({
  id: row.id,
  projectId: row.projectId,
  title: row.title,
  runtime: row.runtime,
  ...(row.model ? { model: row.model } : {}),
  createdAt: row.createdAt,
});
const runView = (row: WorkspaceRunRecord): WorkspaceRun => ({
  id: row.id,
  sessionId: row.sessionId,
  projectId: row.projectId,
  deviceId: row.deviceId,
  workspaceKey: row.workspaceKey,
  runtime: row.runtime,
  ...(row.model ? { model: row.model } : {}),
  prompt: row.prompt,
  mode: row.mode,
  state: row.state,
  lastSequence: row.lastSequence,
  seenSequence: row.seenSequence,
  unread: row.lastSequence > row.seenSequence,
  needsAttention: row.state === 'failed' || row.state === 'interrupted',
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export interface WorkspaceEventBatch {
  workerInstanceId: string;
  leaseId: string;
  events: WorkspaceEventInput[];
}

export interface WorkspaceService {
  ready: Promise<string[]>;
  createDevice(
    owner: WorkspaceOwner,
    input: DeviceInput,
  ): Promise<{
    device: WorkspaceDevice;
    workerToken: string | null;
  }>;
  updateDevice(
    owner: WorkspaceOwner,
    id: string,
    input: { capabilities: string[]; name?: string },
  ): Promise<{ device: WorkspaceDevice }>;
  rotate(
    owner: WorkspaceOwner,
    id: string,
  ): Promise<{ device: WorkspaceDevice; workerToken: string }>;
  revoke(owner: WorkspaceOwner, id: string): Promise<{ device: WorkspaceDevice }>;
  createProject(owner: WorkspaceOwner, input: ProjectInput): Promise<{ project: WorkspaceProject }>;
  createSession(owner: WorkspaceOwner, input: SessionInput): Promise<{ session: WorkspaceSession }>;
  createRun(owner: WorkspaceOwner, input: RunInput): Promise<{ run: WorkspaceRun }>;
  stop(owner: WorkspaceOwner, id: string): Promise<{ run: WorkspaceRun }>;
  poll(
    token: string,
    workerInstanceId: string,
  ): Promise<{ run: WorkspaceWorkerRun | null; stopRequested: boolean }>;
  events(
    token: string,
    id: string,
    input: WorkspaceEventBatch,
  ): Promise<{ run: WorkspaceRun; accepted: string[]; nextCursor: number }>;
  seen(
    owner: WorkspaceOwner,
    id: string,
    throughSequence: number,
  ): Promise<{ seen: { kind: 'run'; id: string; throughSequence: number } }>;
  readState(owner: WorkspaceOwner): Promise<{ readState: WorkspaceReadState }>;
  markRead(
    owner: WorkspaceOwner,
    kind: WorkspaceReadKind,
    seenThrough: string,
  ): Promise<{ readState: WorkspaceReadState }>;
  listDevices(
    owner: WorkspaceOwner,
    before?: string,
  ): Promise<{ devices: WorkspaceDevice[]; nextCursor: string | null }>;
  listProjects(
    owner: WorkspaceOwner,
    before?: string,
  ): Promise<{ projects: WorkspaceProject[]; nextCursor: string | null }>;
  listSessions(
    owner: WorkspaceOwner,
    projectId?: string,
    before?: string,
  ): Promise<{ sessions: WorkspaceSession[]; nextCursor: string | null }>;
  listRuns(
    owner: WorkspaceOwner,
    before?: string,
  ): Promise<{ runs: WorkspaceRun[]; nextCursor: string | null }>;
  getRun(owner: WorkspaceOwner, id: string): Promise<{ run: WorkspaceRun }>;
  getEvents(
    owner: WorkspaceOwner,
    id: string,
    after: number,
  ): Promise<{ events: WorkspaceEvent[]; nextCursor: number }>;
}

export function createWorkspaceService(
  connection: Connection = mongoose.connection,
  options: { now?: () => Date; staleMs?: number; getProject?: ProjectReader } = {},
): WorkspaceService {
  const db = workspaceCollections(connection);
  const now = () => (options.now?.() || new Date()).toISOString();
  const staleMs = options.staleMs || 90000;

  async function device(owner: WorkspaceOwner, id: string) {
    await db.ready;
    const row = await db.devices.findOne({ ...owner, _id: id });
    if (!row) throw new WorkspaceError(404, 'Device not found.');
    return row;
  }

  async function run(owner: WorkspaceOwner, id: string, includeEvents = true) {
    await db.ready;
    const row = await db.runs.findOne(
      { ...owner, _id: id },
      { projection: includeEvents ? {} : { events: 0 } },
    );
    if (!row) throw new WorkspaceError(404, 'Run not found.');
    return row;
  }

  async function saveRun(previous: WorkspaceRunRecord, next: WorkspaceRunRecord) {
    next.revision = previous.revision + 1;
    next.updatedAt = now();
    if (!active.has(next.state)) {
      delete next.activeDevice;
      delete next.activeWorkspace;
    }
    return (
      (
        await db.runs.replaceOne(
          {
            _id: previous._id,
            userId: previous.userId,
            tenantId: previous.tenantId,
            revision: previous.revision,
          },
          next,
        )
      ).matchedCount === 1
    );
  }

  function statusEvent(row: WorkspaceRunRecord, text: string): WorkspaceEvent {
    return {
      eventId: `srv_${randomBytes(12).toString('hex')}`,
      sequence: row.lastSequence + 1,
      type: 'status',
      text,
      ...(row.state === 'queued' || row.state === 'stopping' ? {} : { state: row.state }),
      at: now(),
    };
  }

  async function interrupt(owner: WorkspaceOwner, id: string, reason: string, cutoff?: string) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const previous = await run(owner, id);
      if (!active.has(previous.state)) return previous;
      if (cutoff && (!previous.heartbeatAt || previous.heartbeatAt >= cutoff)) return previous;
      const next = { ...previous, state: 'interrupted' as const };
      const event = statusEvent(next, reason);
      next.events = [...previous.events, event];
      next.lastSequence = event.sequence;
      if (await saveRun(previous, next)) return next;
    }
    throw new WorkspaceError(409, 'Run changed. Refresh before continuing.');
  }

  async function reap(owner: WorkspaceOwner) {
    await db.ready;
    const cutoff = new Date(Date.parse(now()) - staleMs).toISOString();
    const rows = await db.runs
      .find(
        { ...owner, state: { $in: ['running', 'stopping'] }, heartbeatAt: { $lt: cutoff } },
        { projection: { id: 1 } },
      )
      .limit(100)
      .toArray();
    for (const row of rows) {
      await interrupt(
        owner,
        row.id,
        'The worker stopped responding. Work is interrupted; commands may already have happened. Inspect the saved workspace before starting another run.',
        cutoff,
      );
    }
  }

  async function worker(token: string) {
    await db.ready;
    if (!/^kw_[a-f0-9]{64}$/.test(token)) throw new WorkspaceError(401, 'Worker token required.');
    const row = await db.devices.findOne({ tokenHash: digest(token), revokedAt: null });
    if (!row) throw new WorkspaceError(401, 'Device access was revoked or the token is invalid.');
    return row;
  }

  async function assertWorker(current: WorkspaceDeviceRecord) {
    const row = await db.devices.findOne({
      _id: current.id,
      tokenHash: current.tokenHash,
      revokedAt: null,
    });
    if (!row) throw new WorkspaceError(401, 'Device access was revoked.');
  }

  async function createDevice(owner: WorkspaceOwner, input: DeviceInput) {
    await db.ready;
    const id = identity(owner, 'd', input.requestId);
    const workerToken = `kw_${randomBytes(32).toString('hex')}`;
    const row: WorkspaceDeviceRecord = {
      ...owner,
      ...input,
      _id: id,
      id,
      fingerprint: fingerprint(input),
      createdAt: now(),
      lastSeenAt: null,
      revokedAt: null,
      tokenHash: digest(workerToken),
    };
    try {
      await db.devices.insertOne(row);
      return { device: deviceView(row), workerToken };
    } catch (error) {
      if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) throw error;
      const existing = await device(owner, id);
      if (existing.fingerprint !== row.fingerprint)
        throw new WorkspaceError(
          409,
          'This request identifier belongs to a different device request.',
        );
      return { device: deviceView(existing), workerToken: null };
    }
  }

  async function rotate(owner: WorkspaceOwner, id: string) {
    const row = await device(owner, id);
    if (row.revokedAt) throw new WorkspaceError(409, 'Register a new device after revocation.');
    const running = await db.runs.findOne({ ...owner, activeDevice: id });
    if (running)
      await interrupt(
        owner,
        running.id,
        'The device credential changed. Check its work before continuing.',
      );
    const workerToken = `kw_${randomBytes(32).toString('hex')}`;
    const result = await db.devices.updateOne(
      { ...owner, _id: id, revokedAt: null },
      { $set: { tokenHash: digest(workerToken) } },
    );
    if (!result.matchedCount) throw new WorkspaceError(409, 'Device access changed.');
    return { device: deviceView(row), workerToken };
  }

  async function updateDevice(
    owner: WorkspaceOwner,
    id: string,
    input: {
      capabilities: string[];
      name?: string;
    },
  ) {
    const row = await device(owner, id);
    if (row.revokedAt) throw new WorkspaceError(409, 'That device has been revoked.');
    const patch = { capabilities: input.capabilities, ...(input.name ? { name: input.name } : {}) };
    const updated = await db.devices.updateOne(
      { ...owner, _id: id, revokedAt: null },
      { $set: patch },
    );
    if (!updated.matchedCount) throw new WorkspaceError(409, 'Device access changed.');
    const running = await db.runs.findOne(
      { ...owner, activeDevice: id },
      { projection: { id: 1, runtime: 1 } },
    );
    if (running && !input.capabilities.includes(running.runtime))
      await interrupt(
        owner,
        running.id,
        'The selected runtime is no longer enabled on this computer. Check partial work before continuing.',
      );
    return { device: deviceView({ ...row, ...patch }) };
  }

  async function revoke(owner: WorkspaceOwner, id: string) {
    const row = await device(owner, id);
    row.revokedAt ||= now();
    await db.devices.updateOne({ ...owner, _id: id }, { $set: { revokedAt: row.revokedAt } });
    const pending = await db.runs.find({ ...owner, activeDevice: id }).toArray();
    for (const item of pending)
      await interrupt(
        owner,
        item.id,
        'Device access was revoked. Check any partial work on that device.',
      );
    return { device: deviceView(row) };
  }

  async function createProject(owner: WorkspaceOwner, input: ProjectInput) {
    const current = await device(owner, input.deviceId);
    if (current.revokedAt) throw new WorkspaceError(409, 'That device has been revoked.');
    if (
      input.chatProjectId &&
      (!options.getProject || !(await options.getProject(owner.userId, input.chatProjectId)))
    )
      throw new WorkspaceError(404, 'Chat project not found.');
    const id = identity(owner, 'p', input.requestId);
    const row: WorkspaceProjectRecord = {
      ...owner,
      ...input,
      _id: id,
      id,
      fingerprint: fingerprint(input),
      createdAt: now(),
    };
    try {
      await db.projects.insertOne(row);
      return { project: projectView(row) };
    } catch (error) {
      if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) throw error;
      const existing = await db.projects.findOne({ ...owner, _id: id });
      if (existing?.fingerprint === row.fingerprint) return { project: projectView(existing) };
      const registered =
        !existing &&
        (await db.projects.findOne({
          ...owner,
          deviceId: input.deviceId,
          workspaceKey: input.workspaceKey,
        }));
      if (
        registered &&
        registered.name === input.name &&
        registered.allowEdits === input.allowEdits &&
        (registered.chatProjectId || null) === (input.chatProjectId || null)
      )
        return { project: projectView(registered) };
      throw new WorkspaceError(
        409,
        'This workspace is already registered or this request identifier was reused.',
      );
    }
  }

  async function createSession(owner: WorkspaceOwner, input: SessionInput) {
    await db.ready;
    const project = await db.projects.findOne({ ...owner, _id: input.projectId });
    if (!project) throw new WorkspaceError(404, 'Project not found.');
    const current = await device(owner, project.deviceId);
    if (current.revokedAt) throw new WorkspaceError(409, 'That device has been revoked.');
    const id = identity(owner, 's', input.requestId);
    const row: WorkspaceSessionRecord = {
      ...owner,
      ...input,
      _id: id,
      id,
      fingerprint: fingerprint(input),
      createdAt: now(),
    };
    try {
      await db.sessions.insertOne(row);
      return { session: sessionView(row) };
    } catch (error) {
      if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) throw error;
      const existing = await db.sessions.findOne({ ...owner, _id: id });
      if (!existing || existing.fingerprint !== row.fingerprint)
        throw new WorkspaceError(409, 'This request identifier belongs to a different session.');
      return { session: sessionView(existing) };
    }
  }

  async function createRun(owner: WorkspaceOwner, input: RunInput) {
    await db.ready;
    const id = identity(owner, 'r', input.requestId);
    const old = await db.runs.findOne({ ...owner, _id: id }, { projection: { events: 0 } });
    if (old) {
      if (old.fingerprint !== fingerprint(input))
        throw new WorkspaceError(409, 'This request identifier belongs to a different run.');
      return { run: runView(old) };
    }
    await reap(owner);
    const session = await db.sessions.findOne({ ...owner, _id: input.sessionId });
    if (!session) throw new WorkspaceError(404, 'Session not found.');
    if (session.runtime === 'inspect' && input.mode === 'edit')
      throw new WorkspaceError(
        403,
        'Folder inventory supports inspection only. Choose an agent runtime for editing.',
      );
    const project = await db.projects.findOne({ ...owner, _id: session.projectId });
    if (!project) throw new WorkspaceError(404, 'Project not found.');
    if (input.mode === 'edit' && !project.allowEdits)
      throw new WorkspaceError(403, 'Editing is not enabled for this workspace on its computer.');
    const current = await device(owner, project.deviceId);
    if (current.revokedAt) throw new WorkspaceError(409, 'That device has been revoked.');
    if (!current.capabilities.includes(session.runtime))
      throw new WorkspaceError(409, `This device has not enabled the ${session.runtime} runtime.`);
    const stamp = now();
    const row: WorkspaceRunRecord = {
      ...owner,
      ...input,
      _id: id,
      id,
      fingerprint: fingerprint(input),
      projectId: project.id,
      deviceId: project.deviceId,
      workspaceKey: project.workspaceKey,
      runtime: session.runtime,
      ...(session.model ? { model: session.model } : {}),
      state: 'queued',
      activeDevice: project.deviceId,
      activeWorkspace: `${project.deviceId}:${project.workspaceKey}`,
      createdAt: stamp,
      updatedAt: stamp,
      revision: 0,
      lastSequence: 1,
      seenSequence: 0,
      unread: true,
      needsAttention: false,
      events: [
        {
          eventId: 'srv_created',
          sequence: 1,
          at: stamp,
          type: 'status',
          text: 'Queued for the selected computer.',
        },
      ],
    };
    try {
      await db.runs.insertOne(row);
      await assertWorker(current);
      return { run: runView(row) };
    } catch (error) {
      if (error instanceof WorkspaceError) {
        await interrupt(owner, id, 'Device access changed before work could start.');
        throw error;
      }
      if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) throw error;
      const existing = await db.runs.findOne({ ...owner, _id: id });
      if (existing?.fingerprint === row.fingerprint) return { run: runView(existing) };
      throw new WorkspaceError(
        409,
        'This computer already has active work. Stop it or wait for its result.',
      );
    }
  }

  async function stop(owner: WorkspaceOwner, id: string) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const previous = await run(owner, id);
      if (!active.has(previous.state) || previous.state === 'stopping')
        return { run: runView(previous) };
      const next = {
        ...previous,
        state: previous.state === 'queued' ? ('stopped' as const) : ('stopping' as const),
      };
      const event = statusEvent(
        next,
        next.state === 'stopped'
          ? 'Stopped before the worker started.'
          : 'Stop requested. Completed commands are not undone.',
      );
      next.events = [...previous.events, event];
      next.lastSequence = event.sequence;
      if (await saveRun(previous, next)) return { run: runView(next) };
    }
    throw new WorkspaceError(409, 'Run changed. Refresh before stopping.');
  }

  async function poll(token: string, workerInstanceId: string) {
    const current = await worker(token);
    const owner = { userId: current.userId, tenantId: current.tenantId };
    await reap(owner);
    await db.devices.updateOne(
      { _id: current.id, tokenHash: current.tokenHash, revokedAt: null },
      { $set: { lastSeenAt: now() } },
    );
    for (let attempt = 0; attempt < 12; attempt++) {
      const previous = await db.runs.findOne(
        { ...owner, activeDevice: current.id },
        { projection: { events: 0 } },
      );
      if (!previous) return { run: null, stopRequested: false };
      if (previous.workerInstanceId && previous.workerInstanceId !== workerInstanceId) {
        await interrupt(
          owner,
          previous.id,
          'A different worker process connected. Earlier commands may have run; this job was not started again.',
        );
        return { run: null, stopRequested: false };
      }
      const next = {
        ...previous,
        heartbeatAt: now(),
        workerInstanceId,
        leaseId: previous.leaseId || randomBytes(24).toString('hex'),
      };
      if (previous.state === 'queued') {
        previous.events = (await run(owner, previous.id)).events;
        next.state = 'running';
        const event = statusEvent(next, 'The computer claimed this run.');
        next.events = [...previous.events, event];
        next.lastSequence = event.sequence;
        if (!(await saveRun(previous, next))) continue;
      } else {
        const updated = await db.runs.updateOne(
          {
            ...owner,
            _id: previous.id,
            revision: previous.revision,
            workerInstanceId,
            leaseId: next.leaseId,
          },
          {
            $set: { heartbeatAt: next.heartbeatAt, updatedAt: next.heartbeatAt },
            $inc: { revision: 1 },
          },
        );
        if (!updated.matchedCount) continue;
        next.updatedAt = next.heartbeatAt;
      }
      try {
        await assertWorker(current);
      } catch (error) {
        await interrupt(owner, previous.id, 'Device access changed.');
        throw error;
      }
      const value: WorkspaceWorkerRun = { ...runView(next), leaseId: next.leaseId };
      return { run: value, stopRequested: next.state === 'stopping' };
    }
    throw new WorkspaceError(409, 'Work changed. Poll again.');
  }

  async function events(token: string, id: string, input: WorkspaceEventBatch) {
    const current = await worker(token);
    const owner = { userId: current.userId, tenantId: current.tenantId };
    await reap(owner);
    for (let attempt = 0; attempt < 12; attempt++) {
      await assertWorker(current);
      const previous = await run(owner, id);
      if (
        previous.deviceId !== current.id ||
        previous.leaseId !== input.leaseId ||
        previous.workerInstanceId !== input.workerInstanceId
      )
        throw new WorkspaceError(404, 'Run lease not found.');
      const known = new Map(previous.events.map((event) => [event.eventId, event]));
      const additions: WorkspaceEvent[] = [];
      let state = previous.state;
      for (const event of input.events) {
        const existing = known.get(event.eventId);
        if (existing) {
          const eventKey = (item: WorkspaceEventInput) =>
            fingerprint([
              item.eventId,
              item.type,
              item.text ?? null,
              item.state ?? null,
              Object.entries(item.data || {}).sort(([left], [right]) => left.localeCompare(right)),
            ]);
          if (eventKey(existing) !== eventKey(event))
            throw new WorkspaceError(409, 'An event identifier was reused with different content.');
          continue;
        }
        if (terminal.has(state))
          throw new WorkspaceError(409, 'This run is settled. Its commands were not replayed.');
        if (event.state && !(state === 'stopping' && event.state === 'running'))
          state = event.state;
        const saved = {
          ...event,
          sequence: previous.lastSequence + additions.length + 1,
          at: now(),
        };
        known.set(event.eventId, saved);
        additions.push(saved);
      }
      if (!additions.length)
        return {
          run: runView(previous),
          accepted: input.events.map((event) => event.eventId),
          nextCursor: previous.lastSequence,
        };
      if (
        previous.events.length + additions.length > 2000 ||
        Buffer.byteLength(JSON.stringify([...previous.events, ...additions])) > 8 * 1024 * 1024
      ) {
        const interrupted = await interrupt(
          owner,
          id,
          'Saved output reached this run’s storage limit. Work was interrupted. Check the computer for partial results before continuing.',
        );
        throw new WorkspaceError(
          413,
          'This run reached its saved event limit and was interrupted.',
          runView(interrupted),
        );
      }
      const next = {
        ...previous,
        state,
        heartbeatAt: now(),
        events: [...previous.events, ...additions],
        lastSequence: previous.lastSequence + additions.length,
      };
      if (await saveRun(previous, next))
        return {
          run: runView(next),
          accepted: input.events.map((event) => event.eventId),
          nextCursor: next.lastSequence,
        };
    }
    throw new WorkspaceError(409, 'Run changed. Retry the same event identifiers.');
  }

  async function seen(owner: WorkspaceOwner, id: string, throughSequence: number) {
    const row = await run(owner, id, false);
    const sequence = Math.min(row.lastSequence, throughSequence);
    await db.runs.updateOne(
      { ...owner, _id: id },
      { $max: { seenSequence: sequence }, $inc: { revision: 1 } },
    );
    const saved = await run(owner, id, false);
    return { seen: { kind: 'run' as const, id, throughSequence: saved.seenSequence } };
  }

  async function readState(owner: WorkspaceOwner) {
    await db.ready;
    const row = await db.reads.findOne({ ...owner, _id: identity(owner, 'read', 'account') });
    return { readState: { ...emptyReads(), ...row?.readState } };
  }

  async function markRead(owner: WorkspaceOwner, kind: WorkspaceReadKind, seenThrough: string) {
    await db.ready;
    const stamp = new Date(Math.min(Date.parse(seenThrough), Date.parse(now()))).toISOString();
    const filter = { ...owner, _id: identity(owner, 'read', 'account') };
    const update = { $setOnInsert: owner, $max: { [`readState.${kind}`]: stamp } };
    try {
      await db.reads.updateOne(filter, update, { upsert: true });
    } catch (error) {
      if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) throw error;
      await db.reads.updateOne(filter, update);
    }
    return readState(owner);
  }

  return {
    ready: db.ready,
    createDevice,
    updateDevice,
    rotate,
    revoke,
    createProject,
    createSession,
    createRun,
    stop,
    poll,
    events,
    seen,
    readState,
    markRead,
    async listDevices(owner: WorkspaceOwner, before?: string) {
      await db.ready;
      const cursor = before ? await device(owner, before) : null;
      const rows = await db.devices
        .find({ ...owner, ...beforeCursor(cursor) })
        .sort({ createdAt: -1, _id: -1 })
        .limit(101)
        .toArray();
      return {
        devices: rows.slice(0, 100).map(deviceView),
        nextCursor: rows.length > 100 ? rows[99].id : null,
      };
    },
    async listProjects(owner: WorkspaceOwner, before?: string) {
      await db.ready;
      const cursor = before ? await db.projects.findOne({ ...owner, _id: before }) : null;
      if (before && !cursor) throw new WorkspaceError(404, 'Project cursor not found.');
      const rows = await db.projects
        .find({ ...owner, ...beforeCursor(cursor) })
        .sort({ createdAt: -1, _id: -1 })
        .limit(101)
        .toArray();
      return {
        projects: rows.slice(0, 100).map(projectView),
        nextCursor: rows.length > 100 ? rows[99].id : null,
      };
    },
    async listSessions(owner: WorkspaceOwner, projectId?: string, before?: string) {
      await db.ready;
      const filter = { ...owner, ...(projectId ? { projectId } : {}) };
      const cursor = before ? await db.sessions.findOne({ ...filter, _id: before }) : null;
      if (before && !cursor) throw new WorkspaceError(404, 'Session cursor not found.');
      const rows = await db.sessions
        .find({ ...filter, ...beforeCursor(cursor) })
        .sort({ createdAt: -1, _id: -1 })
        .limit(101)
        .toArray();
      return {
        sessions: rows.slice(0, 100).map(sessionView),
        nextCursor: rows.length > 100 ? rows[99].id : null,
      };
    },
    async listRuns(owner: WorkspaceOwner, before?: string) {
      await reap(owner);
      const cursor = before ? await run(owner, before, false) : null;
      const rows = await db.runs
        .find({ ...owner, ...beforeCursor(cursor) }, { projection: { events: 0 } })
        .sort({ createdAt: -1, _id: -1 })
        .limit(51)
        .toArray();
      return {
        runs: rows.slice(0, 50).map(runView),
        nextCursor: rows.length > 50 ? rows[49].id : null,
      };
    },
    async getRun(owner: WorkspaceOwner, id: string) {
      await reap(owner);
      return { run: runView(await run(owner, id, false)) };
    },
    async getEvents(owner: WorkspaceOwner, id: string, after: number) {
      await reap(owner);
      const row = await db.runs.findOne(
        { ...owner, _id: id },
        {
          projection: {
            lastSequence: 1,
            events: { $slice: [Math.max(0, Math.min(after, 1000000000)), 200] },
          },
        },
      );
      if (!row) throw new WorkspaceError(404, 'Run not found.');
      const page: WorkspaceEvent[] = [];
      let bytes = 0;
      for (const event of row.events) {
        const size = Buffer.byteLength(JSON.stringify(event));
        if (page.length && bytes + size > 1024 * 1024 - 256) break;
        page.push(event);
        bytes += size;
      }
      return {
        events: page,
        nextCursor: page[page.length - 1]?.sequence || Math.min(after, row.lastSequence),
      };
    },
  };
}
