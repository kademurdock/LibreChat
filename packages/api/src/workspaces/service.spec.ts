import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';

import type { WorkspaceOwner } from '@librechat/data-schemas';
import type { RequestHandler } from 'express';
import type { Connection } from 'mongoose';

import { createWorkspaceService } from './service';
import { createWorkspaceRouter } from './router';

const owner: WorkspaceOwner = { userId: 'alice', tenantId: 'home' };
const stranger: WorkspaceOwner = { userId: 'bob', tenantId: 'home' };
const otherTenant: WorkspaceOwner = { userId: 'alice', tenantId: 'elsewhere' };
let mongo: MongoMemoryServer;
let connection: Connection;
let clock: Date;
let serial = 0;
const key = () => `request_${++serial}`;
const service = () => createWorkspaceService(connection, { now: () => clock });

async function fixture(allowEdits = false) {
  const current = service();
  const registered = await current.createDevice(owner, {
    requestId: key(),
    name: 'My Windows computer',
    platform: 'windows',
    capabilities: ['inspect', 'codex'],
  });
  const { project } = await current.createProject(owner, {
    requestId: key(),
    name: 'Old CD',
    deviceId: registered.device.id,
    workspaceKey: key(),
    allowEdits,
  });
  const { session } = await current.createSession(owner, {
    requestId: key(),
    projectId: project.id,
    title: 'Understand this software',
    runtime: allowEdits ? 'codex' : 'inspect',
  });
  if (!registered.workerToken) throw new Error('Fixture did not receive its worker credential');
  return { current, project, session, device: registered.device, token: registered.workerToken };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(mongo.getUri()).asPromise();
}, 120000);
beforeEach(async () => {
  clock = new Date('2026-10-22T15:00:00.000Z');
  await Promise.all(
    [
      'kadeworkspacedevices',
      'kadeworkspaceprojects',
      'kadeworkspacesessions',
      'kadeworkspaceruns',
      'kadeworkspacereads',
    ].map((name) => connection.collection(name).deleteMany({})),
  );
});
afterAll(async () => {
  await connection?.close();
  await mongo?.stop();
});

test('normal HTTP endpoints require account auth; worker routes require a scoped token', async () => {
  const authenticate: RequestHandler = (req, res, next) => {
    const id = req.get('x-test-user');
    if (!id) {
      res.status(401).json({ error: 'Sign in' });
      return;
    }
    Object.assign(req, { user: { id, tenantId: 'http' } });
    next();
  };
  const app = express()
    .use(express.json({ limit: '3mb' }))
    .use('/api/kade/workspaces', createWorkspaceRouter({ authenticate, service: service() }));
  await request(app).get('/api/kade/workspaces/devices').expect(401);
  await request(app)
    .post('/api/kade/workspaces/worker/poll')
    .send({ workerInstanceId: key() })
    .expect(401);
  const registration = {
    requestId: key(),
    name: 'PC',
    platform: 'windows',
    capabilities: ['inspect'],
  };
  const registered = await request(app)
    .post('/api/kade/workspaces/devices')
    .set('x-test-user', 'alice')
    .send(registration)
    .expect(200);
  expect(registered.body.workerToken).toMatch(/^kw_[a-f0-9]{64}$/);
  expect(registered.body.device).not.toHaveProperty('tokenHash');
  const retried = await request(app)
    .post('/api/kade/workspaces/devices')
    .set('x-test-user', 'alice')
    .send(registration)
    .expect(200);
  expect(retried.body.device.id).toBe(registered.body.device.id);
  expect(retried.body.workerToken).toBeNull();
  await request(app)
    .post('/api/kade/workspaces/devices')
    .set('x-test-user', 'alice')
    .send({ ...registration, name: 'Changed' })
    .expect(409);
  const listed = await request(app)
    .get('/api/kade/workspaces/devices')
    .set('x-test-user', 'alice')
    .expect(200);
  expect(JSON.stringify(listed.body)).not.toContain(registered.body.workerToken);
  await request(app)
    .post('/api/kade/workspaces/devices')
    .set('x-test-user', 'alice')
    .send({
      requestId: key(),
      name: 'PC',
      platform: 'windows',
      capabilities: ['inspect'],
      userId: 'bob',
    })
    .expect(400);
  const hidden = await request(app)
    .get('/api/kade/workspaces/devices')
    .set('x-test-user', 'bob')
    .expect(200);
  expect(hidden.body.devices).toEqual([]);
  await request(app)
    .post('/api/kade/workspaces/devices')
    .set('x-test-user', 'alice')
    .send({ ...registration, extra: 'x'.repeat(1024 * 1024) })
    .expect(413);
});

test('ownership and tenant boundaries cover registry, sessions, jobs, events and seen', async () => {
  const { current, project, session } = await fixture();
  const { run } = await current.createRun(owner, {
    requestId: key(),
    sessionId: session.id,
    prompt: 'Inspect',
    mode: 'inspect',
  });
  for (const outsider of [stranger, otherTenant]) {
    expect((await current.listProjects(outsider)).projects).toEqual([]);
    expect((await current.listSessions(outsider)).sessions).toEqual([]);
    expect((await current.listRuns(outsider)).runs).toEqual([]);
    await expect(
      current.createSession(outsider, {
        requestId: key(),
        projectId: project.id,
        title: 'No',
        runtime: 'inspect',
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(current.getRun(outsider, run.id)).rejects.toMatchObject({ status: 404 });
    await expect(current.getEvents(outsider, run.id, 0)).rejects.toMatchObject({ status: 404 });
    await expect(current.stop(outsider, run.id)).rejects.toMatchObject({ status: 404 });
    await expect(current.seen(outsider, run.id, 99)).rejects.toMatchObject({ status: 404 });
  }
});

test('run creation is durable and idempotent; the unique active slot wins concurrent requests', async () => {
  const { current, session } = await fixture();
  const input = {
    requestId: key(),
    sessionId: session.id,
    prompt: 'Inspect',
    mode: 'inspect' as const,
  };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => current.createRun(owner, input)),
  );
  expect(new Set(results.map((result) => result.run.id)).size).toBe(1);
  await expect(current.createRun(owner, { ...input, prompt: 'Different' })).rejects.toMatchObject({
    status: 409,
  });
  const restarted = service();
  expect((await restarted.getRun(owner, results[0].run.id)).run.state).toBe('queued');
  await restarted.stop(owner, results[0].run.id);
  const racing = await Promise.allSettled(
    Array.from({ length: 8 }, () => restarted.createRun(owner, { ...input, requestId: key() })),
  );
  expect(racing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(racing.filter((result) => result.status === 'rejected')).toHaveLength(7);
});

test('worker leases survive server recreation, event retries deduplicate, conflicting replays fail', async () => {
  const { current, token, session } = await fixture();
  const { run } = await current.createRun(owner, {
    requestId: key(),
    sessionId: session.id,
    prompt: 'Inspect',
    mode: 'inspect',
  });
  const instance = key();
  const claimed = await current.poll(token, instance);
  expect(claimed.run?.id).toBe(run.id);
  if (!claimed.run) throw new Error('No claimed job');
  const lease = { workerInstanceId: instance, leaseId: claimed.run.leaseId };
  const event = {
    eventId: key(),
    type: 'message' as const,
    text: 'Read directory listing',
    data: { count: '12' },
  };
  const first = await current.events(token, run.id, { ...lease, events: [event] });
  const restarted = service();
  expect((await restarted.poll(token, instance)).run?.leaseId).toBe(lease.leaseId);
  const retry = await restarted.events(token, run.id, { ...lease, events: [event] });
  expect(retry.nextCursor).toBe(first.nextCursor);
  await expect(
    restarted.events(token, run.id, { ...lease, events: [{ ...event, text: 'Changed' }] }),
  ).rejects.toMatchObject({ status: 409 });
  const final = {
    eventId: key(),
    type: 'result' as const,
    state: 'done' as const,
    text: 'Inventory ready.',
  };
  await restarted.events(token, run.id, { ...lease, events: [final] });
  await restarted.events(token, run.id, { ...lease, events: [final] });
  expect(
    (await restarted.getEvents(owner, run.id, 0)).events.filter(
      (item) => item.eventId === final.eventId,
    ),
  ).toHaveLength(1);
  await expect(
    restarted.events(token, run.id, {
      ...lease,
      events: [{ eventId: key(), type: 'tool', text: 'Late command' }],
    }),
  ).rejects.toMatchObject({ status: 409 });
});

test('simultaneous events and read acknowledgements retain every event and monotonic seen state', async () => {
  const { current, token, session } = await fixture();
  const { run } = await current.createRun(owner, {
    requestId: key(),
    sessionId: session.id,
    prompt: 'Inspect',
    mode: 'inspect',
  });
  const instance = key();
  const claimed = await current.poll(token, instance);
  if (!claimed.run) throw new Error('No claimed job');
  const lease = { workerInstanceId: instance, leaseId: claimed.run.leaseId };
  await Promise.all([
    ...Array.from({ length: 6 }, () =>
      current.events(token, run.id, {
        ...lease,
        events: [{ eventId: key(), type: 'message', text: 'Progress' }],
      }),
    ),
    current.seen(owner, run.id, 2),
    current.seen(owner, run.id, 1),
  ]);
  const saved = (await current.getRun(owner, run.id)).run;
  expect(saved.lastSequence).toBe(8);
  expect(saved.seenSequence).toBe(2);
  expect((await current.getEvents(owner, run.id, 0)).events.map((event) => event.sequence)).toEqual(
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  await current.seen(owner, run.id, 999999);
  expect((await service().getRun(owner, run.id)).run.unread).toBe(false);
});

test('new worker processes and stale heartbeats interrupt work without executing it again', async () => {
  const { current, token, session } = await fixture();
  const { run } = await current.createRun(owner, {
    requestId: key(),
    sessionId: session.id,
    prompt: 'Inspect',
    mode: 'inspect',
  });
  await current.poll(token, key());
  expect((await current.poll(token, key())).run).toBeNull();
  expect((await current.getRun(owner, run.id)).run.state).toBe('interrupted');
  const next = await current.createRun(owner, {
    requestId: key(),
    sessionId: session.id,
    prompt: 'New explicit job',
    mode: 'inspect',
  });
  const instance = key();
  const claimed = await current.poll(token, instance);
  if (!claimed.run) throw new Error('No claimed job');
  clock = new Date(clock.getTime() + 91000);
  expect((await service().getRun(owner, next.run.id)).run.state).toBe('interrupted');
  expect((await current.poll(token, instance)).run).toBeNull();
  await expect(
    current.events(token, next.run.id, {
      workerInstanceId: instance,
      leaseId: claimed.run.leaseId,
      events: [{ eventId: key(), type: 'result', text: 'Late', state: 'done' }],
    }),
  ).rejects.toMatchObject({ status: 409 });
});

test('stop persists across server recreation; queued work never reaches the worker', async () => {
  const { current, token, session } = await fixture();
  const queued = await current.createRun(owner, {
    requestId: key(),
    sessionId: session.id,
    prompt: 'Inspect',
    mode: 'inspect',
  });
  expect((await current.stop(owner, queued.run.id)).run.state).toBe('stopped');
  expect((await service().poll(token, key())).run).toBeNull();
  const running = await current.createRun(owner, {
    requestId: key(),
    sessionId: session.id,
    prompt: 'Inspect',
    mode: 'inspect',
  });
  const instance = key();
  const claimed = await current.poll(token, instance);
  if (!claimed.run) throw new Error('No claimed job');
  await current.stop(owner, running.run.id);
  expect((await service().poll(token, instance)).stopRequested).toBe(true);
  const saved = await current.events(token, running.run.id, {
    workerInstanceId: instance,
    leaseId: claimed.run.leaseId,
    events: [{ eventId: key(), type: 'status', state: 'running' }],
  });
  expect(saved.run.state).toBe('stopping');
});

test('revocation and token rotation immediately reject old worker access and preserve partial history', async () => {
  const { current, token, device, session } = await fixture();
  const run = await current.createRun(owner, {
    requestId: key(),
    sessionId: session.id,
    prompt: 'Inspect',
    mode: 'inspect',
  });
  const instance = key();
  const claimed = await current.poll(token, instance);
  if (!claimed.run) throw new Error('No claimed job');
  const rotated = await current.rotate(owner, device.id);
  await expect(current.poll(token, instance)).rejects.toMatchObject({ status: 401 });
  expect((await current.getRun(owner, run.run.id)).run.state).toBe('interrupted');
  await current.revoke(owner, device.id);
  await expect(service().poll(rotated.workerToken, instance)).rejects.toMatchObject({
    status: 401,
  });
  await expect(
    current.events(token, run.run.id, {
      workerInstanceId: instance,
      leaseId: claimed.run.leaseId,
      events: [{ eventId: key(), type: 'message', text: 'Rejected' }],
    }),
  ).rejects.toMatchObject({ status: 401 });
  await expect(
    current.createRun(owner, {
      requestId: key(),
      sessionId: session.id,
      prompt: 'No',
      mode: 'inspect',
    }),
  ).rejects.toMatchObject({ status: 409 });
});

test('edit grants and advertised runtimes are enforced before queuing; unrelated devices cannot write', async () => {
  const first = await fixture();
  await expect(
    first.current.createRun(owner, {
      requestId: key(),
      sessionId: first.session.id,
      prompt: 'Edit',
      mode: 'edit',
    }),
  ).rejects.toMatchObject({ status: 403 });
  const unsupported = await first.current.createSession(owner, {
    requestId: key(),
    projectId: first.project.id,
    title: 'Custom',
    runtime: 'custom',
  });
  await expect(
    first.current.createRun(owner, {
      requestId: key(),
      sessionId: unsupported.session.id,
      prompt: 'No',
      mode: 'inspect',
    }),
  ).rejects.toMatchObject({ status: 409 });
  const granted = await fixture(true);
  const run = await granted.current.createRun(owner, {
    requestId: key(),
    sessionId: granted.session.id,
    prompt: 'Edit',
    mode: 'edit',
  });
  const instance = key();
  const claimed = await granted.current.poll(granted.token, instance);
  if (!claimed.run) throw new Error('No claimed job');
  await expect(
    first.current.events(first.token, run.run.id, {
      workerInstanceId: instance,
      leaseId: claimed.run.leaseId,
      events: [{ eventId: key(), type: 'message', text: 'Wrong computer' }],
    }),
  ).rejects.toMatchObject({ status: 404 });
});

test('account read cursors persist, advance monotonically, cap future times and remain owner scoped', async () => {
  const current = service();
  await current.markRead(owner, 'alerts', '2026-10-22T14:30:00.000Z');
  await current.markRead(owner, 'alerts', '2026-10-22T14:00:00.000Z');
  await current.markRead(owner, 'announcements', '2099-01-01T00:00:00.000Z');
  const saved = (await service().readState(owner)).readState;
  expect(saved.alerts).toBe('2026-10-22T14:30:00.000Z');
  expect(saved.announcements).toBe(clock.toISOString());
  expect(saved.agentWork).toBeNull();
  expect((await current.readState(otherTenant)).readState.alerts).toBeNull();
});

test('event storage exhaustion preserves a small interruption receipt and releases the worker slot', async () => {
  const { current, token, session } = await fixture();
  const { run } = await current.createRun(owner, {
    requestId: key(),
    sessionId: session.id,
    prompt: 'Inspect',
    mode: 'inspect',
  });
  const instance = key();
  const claimed = await current.poll(token, instance);
  if (!claimed.run) throw new Error('No claimed job');
  const lease = { workerInstanceId: instance, leaseId: claimed.run.leaseId };
  for (let index = 0; index < 39; index++) {
    await current.events(token, run.id, {
      ...lease,
      events: Array.from({ length: 50 }, () => ({
        eventId: key(),
        type: 'message',
        text: 'Output',
      })),
    });
  }
  await current.events(token, run.id, {
    ...lease,
    events: Array.from({ length: 48 }, () => ({ eventId: key(), type: 'message', text: 'Output' })),
  });
  await expect(
    current.events(token, run.id, {
      ...lease,
      events: [{ eventId: key(), type: 'message', text: 'Over limit' }],
    }),
  ).rejects.toMatchObject({ status: 413, run: { state: 'interrupted', lastSequence: 2001 } });
  expect((await current.poll(token, instance)).run).toBeNull();
  expect((await current.getRun(owner, run.id)).run.state).toBe('interrupted');
  const lastPage = await current.getEvents(owner, run.id, 1999);
  expect(lastPage.events[lastPage.events.length - 1]?.text).toMatch(/storage limit/);
});

test('simultaneous initial read acknowledgements never move an account cursor backward', async () => {
  const current = service();
  const reader = { userId: key(), tenantId: 'home' };
  await Promise.all([
    current.markRead(reader, 'alerts', '2026-10-22T14:00:00Z'),
    current.markRead(reader, 'alerts', '2026-10-22T14:59:00Z'),
    current.markRead(reader, 'announcements', '2026-10-22T14:30:00Z'),
  ]);
  expect((await current.readState(reader)).readState).toEqual({
    alerts: '2026-10-22T14:59:00.000Z',
    announcements: '2026-10-22T14:30:00.000Z',
    agentWork: null,
  });
});

test('existing folder registration is reused without changing its grant and session pages retain older records', async () => {
  const { current, project, device } = await fixture();
  const duplicate = await current.createProject(owner, {
    requestId: key(),
    name: project.name,
    deviceId: device.id,
    workspaceKey: project.workspaceKey,
    allowEdits: false,
  });
  expect(duplicate.project.id).toBe(project.id);
  await expect(
    current.createProject(owner, {
      requestId: key(),
      name: project.name,
      deviceId: device.id,
      workspaceKey: project.workspaceKey,
      allowEdits: true,
    }),
  ).rejects.toMatchObject({ status: 409 });
  for (let index = 0; index < 101; index++)
    await current.createSession(owner, {
      requestId: key(),
      projectId: project.id,
      title: `Conversation ${index}`,
      runtime: 'inspect',
    });
  const first = await current.listSessions(owner, project.id);
  expect(first.sessions).toHaveLength(100);
  expect(first.nextCursor).not.toBeNull();
  const second = await current.listSessions(owner, project.id, first.nextCursor || undefined);
  expect(second.sessions).toHaveLength(2);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.sessions, ...second.sessions].map((session) => session.id)).size).toBe(
    102,
  );
  await expect(
    current.listSessions(stranger, project.id, first.nextCursor || undefined),
  ).rejects.toMatchObject({ status: 404 });
});

test('large event receipts page by bytes while heartbeat updates preserve the journal', async () => {
  const { current, token, session } = await fixture();
  const { run } = await current.createRun(owner, {
    requestId: key(),
    sessionId: session.id,
    prompt: 'Inspect',
    mode: 'inspect',
  });
  const instance = key();
  const claimed = await current.poll(token, instance);
  if (!claimed.run) throw new Error('No claimed job');
  const lease = { workerInstanceId: instance, leaseId: claimed.run.leaseId };
  for (let batch = 0; batch < 2; batch++)
    await current.events(token, run.id, {
      ...lease,
      events: Array.from({ length: 10 }, () => ({
        eventId: key(),
        type: 'message',
        text: 'x'.repeat(64000),
      })),
    });
  await current.poll(token, instance);
  const first = await current.getEvents(owner, run.id, 0);
  expect(first.events.length).toBeLessThan(22);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(1024 * 1024);
  const second = await current.getEvents(owner, run.id, first.nextCursor);
  expect([...first.events, ...second.events]).toHaveLength(22);
  expect((await current.getRun(owner, run.id)).run.lastSequence).toBe(22);
});

test('explicit device refresh enables newly installed runtimes and removing one interrupts active work', async () => {
  const current = service();
  const paired = await current.createDevice(owner, {
    requestId: key(),
    name: 'PC',
    platform: 'windows',
    capabilities: ['inspect'],
  });
  if (!paired.workerToken) throw new Error('No worker token');
  const { project } = await current.createProject(owner, {
    requestId: key(),
    name: 'Code',
    deviceId: paired.device.id,
    workspaceKey: key(),
    allowEdits: true,
  });
  const { session } = await current.createSession(owner, {
    requestId: key(),
    projectId: project.id,
    title: 'Code',
    runtime: 'codex',
  });
  const input = { requestId: key(), sessionId: session.id, prompt: 'Edit', mode: 'edit' as const };
  await expect(current.createRun(owner, input)).rejects.toMatchObject({ status: 409 });
  await expect(
    current.updateDevice(stranger, paired.device.id, { capabilities: ['codex'] }),
  ).rejects.toMatchObject({ status: 404 });
  const refreshed = await current.updateDevice(owner, paired.device.id, {
    capabilities: ['inspect', 'codex'],
    name: 'My PC',
  });
  expect(refreshed.device.name).toBe('My PC');
  const { run } = await current.createRun(owner, input);
  const instance = key();
  expect((await current.poll(paired.workerToken, instance)).run?.runtime).toBe('codex');
  await current.updateDevice(owner, paired.device.id, { capabilities: ['inspect'] });
  expect((await service().getRun(owner, run.id)).run.state).toBe('interrupted');
  expect((await current.poll(paired.workerToken, instance)).run).toBeNull();
});
