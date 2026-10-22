import express from 'express';
import mongoose from 'mongoose';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Server } from 'node:http';
import type { Connection } from 'mongoose';
import type { AddressInfo } from 'node:net';
import type { RequestHandler } from 'express';
import type { WorkspaceRunRecord } from '@librechat/data-schemas';
import { createWorkspaceRouter } from './router';
import { createWorkspaceService } from './service';

let mongo: MongoMemoryServer;
let connection: Connection;
let server: Server;
let origin: string;
// Optional cross-repository Windows acceptance test. Ordinary backend CI has
// neither the sibling Windows checkout nor its DPAPI/Python dependencies.
const fixture =
  process.env.KADE_WORKER_SMOKE_FIXTURE ||
  resolve(__dirname, '../../../../../windows/tests/workspace_http_smoke.py');
const available = process.platform === 'win32' && existsSync(fixture);

beforeAll(async () => {
  if (!available) return;
  mongo = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(mongo.getUri()).asPromise();
  const authenticate: RequestHandler = (req, _res, next) => {
    Object.assign(req, { user: { id: 'smoke-user', tenantId: 'smoke-e2e' } });
    next();
  };
  const service = createWorkspaceService(connection);
  await service.ready;
  const app = express().use(
    '/api/kade/workspaces',
    createWorkspaceRouter({ authenticate, service }),
  );
  await new Promise<void>((done, reject) => {
    server = app.listen(0, '127.0.0.1', (error?: Error) => (error ? reject(error) : done()));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120000);

afterAll(async () => {
  if (server)
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  await connection?.close();
  await mongo?.stop();
});

if (available) {
  test('Python Windows worker pairs, inspects real fixture files, uploads events and acknowledges them over HTTP', async () => {
    const result = await new Promise<string>((done, reject) => {
      const child = spawn(process.env.KADE_WORKER_TEST_PYTHON || 'python', [fixture, origin], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let errors = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('The synthetic Python worker smoke test timed out.'));
      }, 45000);
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errors += chunk.toString();
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0)
          reject(new Error(`Synthetic Python worker exited ${code}: ${errors.slice(-4000)}`));
        else done(output);
      });
    });
    const summary = JSON.parse(result) as {
      state: string;
      unread: boolean;
      eventCount: number;
      runId: string;
      projectId: string;
      deviceId: string;
      modelCalls: number;
      fixtureOnly: boolean;
    };
    expect(summary).toMatchObject({
      state: 'done',
      unread: false,
      modelCalls: 0,
      fixtureOnly: true,
    });
    expect(summary.eventCount).toBeGreaterThanOrEqual(6);
    const saved = await connection
      .collection<WorkspaceRunRecord>('kadeworkspaceruns')
      .findOne({ _id: summary.runId });
    expect(saved?.state).toBe('done');
    expect(saved?.seenSequence).toBe(saved?.lastSequence);
    expect(saved?.workerInstanceId).toBeTruthy();
    expect(saved?.leaseId).toMatch(/^[a-f0-9]{48}$/);
  }, 60000);
} else {
  // eslint-disable-next-line jest/expect-expect -- The absent optional fixture is explicitly skipped.
  test.skip('Python Windows worker smoke requires the sibling Windows fixture', () => {});
}
