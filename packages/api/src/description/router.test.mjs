import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { S3Client } from '@aws-sdk/client-s3';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createDescriptionRouter } from './router.ts';

let mongo, external, service, app, Jobs, Budgets;
const settings = { voice: 'Voice 1', rate: 1.5, maxRate: 2.25, mode: 'standard' };
before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const uploads = new Map();
  const objects = new Map();
  external = createServer(async (req, res) => {
    if (req.url === '/voices.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ voices: ['Voice 1'], describe: { 'Voice 1': 'Test voice' } }));
      return;
    }
    const url = new URL(req.url, 'http://storage.test');
    const uploadId = url.searchParams.get('uploadId');
    if (req.method === 'POST' && url.searchParams.has('uploads')) {
      const id = randomUUID();
      uploads.set(id, new Map());
      res.setHeader('Content-Type', 'application/xml');
      res.end(
        `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
      return;
    }
    if (req.method === 'PUT' && uploadId) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const etag = '"' + createHash('md5').update(body).digest('hex') + '"';
      uploads.get(uploadId).set(Number(url.searchParams.get('partNumber')), body);
      res.setHeader('ETag', etag);
      res.end();
      return;
    }
    if (req.method === 'POST' && uploadId) {
      req.resume();
      objects.set(
        url.pathname,
        Buffer.concat(
          [...uploads.get(uploadId).entries()].sort((a, b) => a[0] - b[0]).map(([, body]) => body),
        ),
      );
      uploads.delete(uploadId);
      res.setHeader('Content-Type', 'application/xml');
      res.end(
        '<CompleteMultipartUploadResult><ETag>"complete"</ETag></CompleteMultipartUploadResult>',
      );
      return;
    }
    if (req.method === 'HEAD') {
      const body = objects.get(url.pathname);
      res.writeHead(body ? 200 : 404, body ? { 'Content-Length': body.length } : {});
      res.end();
      return;
    }
    if (req.method === 'DELETE') {
      if (uploadId) uploads.delete(uploadId);
      else objects.delete(url.pathname);
    }
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => external.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${external.address().port}`;
  process.env.KADE_TTS_PROXY_URL = base;
  process.env.OPENROUTER_KEY = 'test-only';
  process.env.DEEPGRAM_API_KEY = 'test-only';
  process.env.AWS_BUCKET_NAME = 'test';
  process.env.KADE_DESCRIPTION_DAILY_USD = '5';
  process.env.KADE_DESCRIPTION_JOB_USD = '5';
  delete process.env.KADE_DESCRIPTION_PUBLIC;
  const storage = new S3Client({
    endpoint: base,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  service = createDescriptionRouter({
    auth: (req, res, next) => (req.headers['x-user'] ? next() : res.sendStatus(401)),
    actor: (req) => ({
      id: String(req.headers['x-user']),
      role: req.headers['x-role'] === 'user' ? 'USER' : 'ADMIN',
    }),
    storage: () => storage,
    log: () => {},
    usage: async () => {
      throw new Error('No paid provider calls are allowed in route tests.');
    },
  });
  service.close();
  app = express();
  app.use(express.json());
  app.use(service.router);
  Jobs = mongoose.models.KadeDescriptionJob;
  Budgets = mongoose.models.KadeDescriptionBudget;
});
after(async () => {
  service?.close();
  await mongoose.disconnect();
  await mongo?.stop();
  if (external) await new Promise((resolve) => external.close(resolve));
});
const call = (method, path, owner = 'owner') => request(app)[method](path).set('x-user', owner);
async function upload(owner, requestId) {
  const result = await call('post', '/uploads', owner)
    .send({ requestId, name: 'episode.mp4', bytes: 1000 })
    .expect(200);
  return result.body.job.id;
}

test('authentication and private trial gate run before returning job data', async () => {
  await request(app).get('/jobs').expect(401);
  await call('get', '/jobs').set('x-role', 'user').expect(403);
  const config = await call('get', '/config').expect(200);
  assert.equal(config.body.limitUSD, 5);
  assert.deepEqual(config.body.voices, ['Voice 1']);
});
test('upload recovery is idempotent, validates metadata, and isolates owners', async () => {
  const id = await upload('owner', 'idempotent-upload-0001');
  assert.equal(await upload('owner', 'idempotent-upload-0001'), id);
  assert.equal(await Jobs.countDocuments({ owner: 'owner' }), 1);
  await call('post', '/uploads')
    .send({ requestId: 'idempotent-upload-0001', name: 'different.mp4', bytes: 1000 })
    .expect(409);
  await call('post', '/uploads')
    .send({ requestId: 'second-upload-0000001', name: 'episode.mp4', bytes: 1000 })
    .expect(409);
  await call('get', `/jobs/${id}`, 'another-owner').expect(409);
  await call('get', `/jobs/${id}/files`, 'another-owner').expect(409);
  await call('post', `/jobs/${id}/cancel`, 'another-owner').expect(409);
  await call('delete', `/jobs/${id}`, 'another-owner').expect(409);
  assert.equal((await call('get', '/jobs', 'another-owner').expect(200)).body.jobs.length, 0);
  await call('post', `/jobs/${id}/cancel`).expect(200);
});
test('concurrent starts reserve spending once and daily allowance blocks another job', async () => {
  const id = await upload('owner', 'paid-upload-00000001');
  await Jobs.updateOne({ _id: id }, { $set: { state: 'ready', seconds: 60 } });
  await call('post', `/jobs/${id}/start`)
    .send({ ...settings, maxRate: 1 })
    .expect(400);
  await call('post', `/jobs/${id}/start`)
    .send({ ...settings, voice: 'invented' })
    .expect(409);
  const starts = await Promise.all(
    Array.from({ length: 12 }, () => call('post', `/jobs/${id}/start`).send(settings)),
  );
  assert.ok(starts.every((result) => [200, 202].includes(result.status)));
  assert.equal((await Jobs.findById(id)).state, 'queued');
  const budget = await Budgets.findById(new Date().toISOString().slice(0, 10));
  assert.equal(budget.reserved, 5);
  assert.deepEqual([...budget.jobs], [id]);
  const second = await upload('another-owner', 'paid-upload-00000002');
  await Jobs.updateOne({ _id: second }, { $set: { state: 'ready', seconds: 60 } });
  await call('post', `/jobs/${second}/start`, 'another-owner').send(settings).expect(409);
  assert.equal((await Jobs.findById(second)).state, 'ready');
  await call('delete', `/jobs/${id}`).expect(409);
  await Jobs.updateOne({ _id: id }, { $set: { costUSD: 0.3 } });
  await call('post', `/jobs/${id}/cancel`).expect(200);
  await call('post', `/jobs/${id}/cancel`).expect(200);
  const spent = await Budgets.findById(budget._id);
  assert.ok(Math.abs(spent.reserved - 0.3) < 0.00001);
  assert.equal(spent.jobs.length, 0);
  await call('post', `/jobs/${second}/start`, 'another-owner').send(settings).expect(202);
  assert.ok(Math.abs((await Jobs.findById(second)).limitUSD - 4.7) < 0.02);
  await call('post', `/jobs/${second}/cancel`, 'another-owner').expect(200);
  await call('post', `/jobs/${id}/start`).send(settings).expect(409);
  await call('delete', `/jobs/${id}`).expect(200);
  assert.equal(await Jobs.findById(id), null);
});

test('chunk uploads resume, verify repeated bytes, and assemble exactly once', async () => {
  const bytes = 8 * 1024 ** 2;
  const created = await call('post', '/uploads', 'chunk-owner')
    .send({ requestId: 'chunk-upload-0000001', name: 'clip.mp4', bytes: bytes + 3 })
    .expect(200);
  const id = created.body.job.id;
  const chunk = Buffer.alloc(bytes, 42);
  const put = (owner, number, body) =>
    call('post', `/jobs/${id}/chunks`, owner)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Part-Number', String(number))
      .send(body);
  await put('another-owner', 1, chunk).expect(409);
  await put('chunk-owner', 2, Buffer.from('end')).expect(409);
  await put('chunk-owner', 1, chunk).expect(200);
  await put('chunk-owner', 1, chunk).expect(200);
  assert.equal((await Jobs.findById(id)).uploadedBytes, bytes);
  assert.equal((await Jobs.findById(id)).parts.length, 1);
  const resumed = await call('post', '/uploads', 'chunk-owner')
    .send({ requestId: 'fresh-tab-upload-0001', resumeId: id, name: 'clip.mp4', bytes: bytes + 3 })
    .expect(200);
  assert.equal(resumed.body.job.uploadedBytes, bytes);
  chunk[0] = 1;
  await put('chunk-owner', 1, chunk).expect(409);
  await put('chunk-owner', 2, Buffer.from('end')).expect(200);
  await call('post', `/jobs/${id}/prepare`, 'chunk-owner').expect(200);
  await call('post', `/jobs/${id}/prepare`, 'chunk-owner').expect(200);
  const stored = await Jobs.findById(id);
  assert.equal(stored.state, 'checking');
  assert.equal(stored.uploadId, undefined);
  await call('post', `/jobs/${id}/cancel`, 'chunk-owner').expect(200);
  await call('delete', `/jobs/${id}`, 'chunk-owner').expect(200);
});

test('YouTube imports are idempotent and never accept arbitrary fetch URLs', async () => {
  await call('post', '/imports', 'youtube-owner')
    .send({ requestId: 'youtube-import-00001', url: 'http://127.0.0.1/admin' })
    .expect(409);
  const first = await call('post', '/imports', 'youtube-owner')
    .send({ requestId: 'youtube-import-00001', url: 'https://youtu.be/aqz-KE-bpKQ?t=10' })
    .expect(202);
  const again = await call('post', '/imports', 'youtube-owner')
    .send({ requestId: 'youtube-import-00001', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' })
    .expect(202);
  assert.equal(first.body.id, again.body.id);
  assert.equal(first.body.state, 'importing');
  assert.equal(await Jobs.countDocuments({ owner: 'youtube-owner' }), 1);
  await call('post', `/jobs/${first.body.id}/start`, 'youtube-owner').send(settings).expect(409);
  await call('post', `/jobs/${first.body.id}/cancel`, 'youtube-owner').expect(200);
});
