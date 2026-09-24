import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import ffmpegPath from 'ffmpeg-static';
import ffprobePath from 'ffprobe-static';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { S3Client } from '@aws-sdk/client-s3';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createDescriptionRouter } from './router.ts';
import { describeVideo } from './engine.ts';
import { command } from './media.ts';
import {
  clip,
  cleanLabel,
  scriptCues,
  matchFolder,
  editsSchema,
  describedShelf,
  libraryPathSchema,
  defaultLibraryPath,
} from './revision.ts';

process.env.FFMPEG_PATH = ffmpegPath;
process.env.FFPROBE_PATH = ffprobePath.path;
let mongo, external, service, worker, app, Jobs, Budgets, Locks, storage, root, voiceWav;
const objects = new Map();
const uploads = new Map();
const storageLog = [];
/** Storage faults: { method, match, times, status } consumed one request at a time. */
const faults = [];
const settings = { voice: 'Voice 1', rate: 1.5, maxRate: 2.25, mode: 'standard' };
const notices = [];
const libraryCalls = [];
const requests = [];
const calls = { analyze: 0, transcribe: 0, synthesize: 0 };
let failSection = -1;
let failLaterSections = false;
let storageHook = null;
let refuseSection = -1;
process.env.KADE_DESCRIPTION_RETRY_SECONDS = '0';
let voicesDown = false;
let simulateConcurrentCosts = false;
let sampleCost = 0;
let beforeEngine = null;
let librarySaveFails = false;
const videos = new Map();

const xml = (res, body, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/xml' });
  res.end(body);
};
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
/** A small S3-compatible store: multipart uploads, ranged get, head, put, copy, list, delete and faults. */
function fakeStorage() {
  return async (req, res) => {
    const url = new URL(req.url, 'http://storage.test');
    const key = decodeURIComponent(url.pathname);
    const uploadId = url.searchParams.get('uploadId');
    storageLog.push({ method: req.method, key, range: req.headers.range, uploadId });
    if (storageHook) await storageHook({ method: req.method, key, range: req.headers.range });
    const fault = faults.find(
      (item) => item.times > 0 && item.method === req.method && item.match.test(key),
    );
    if (fault) {
      fault.times--;
      await body(req);
      return xml(res, '<Error><Code>InternalError</Code><Message>boom</Message></Error>', fault.status || 500);
    }
    if (req.method === 'POST' && url.searchParams.has('uploads')) {
      const id = randomUUID();
      uploads.set(id, { key, parts: new Map() });
      return xml(
        res,
        `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if (req.method === 'GET' && url.searchParams.has('uploads')) {
      const prefix = url.searchParams.get('prefix') || '';
      const bucketName = key.replace(/^\//, '').replace(/\/$/, '');
      const open = [...uploads.entries()].filter(([, item]) =>
        item.key.startsWith(`/${bucketName}/${prefix}`),
      );
      return xml(
        res,
        `<ListMultipartUploadsResult><Bucket>${bucketName}</Bucket>${open.map(([id, item]) => `<Upload><Key>${item.key.slice(bucketName.length + 2)}</Key><UploadId>${id}</UploadId></Upload>`).join('')}</ListMultipartUploadsResult>`,
      );
    }
    if (req.method === 'PUT' && uploadId) {
      const data = await body(req);
      uploads.get(uploadId).parts.set(Number(url.searchParams.get('partNumber')), data);
      res.setHeader('ETag', '"' + createHash('md5').update(data).digest('hex') + '"');
      return res.end();
    }
    if (req.method === 'POST' && uploadId) {
      await body(req);
      const parts = [...uploads.get(uploadId).parts.entries()].sort((a, b) => a[0] - b[0]);
      objects.set(key, Buffer.concat(parts.map(([, data]) => data)));
      uploads.delete(uploadId);
      return xml(
        res,
        '<CompleteMultipartUploadResult><ETag>"complete"</ETag></CompleteMultipartUploadResult>',
      );
    }
    if (req.method === 'PUT' && req.headers['x-amz-copy-source']) {
      await body(req);
      const from = decodeURIComponent(
        '/' + String(req.headers['x-amz-copy-source']).replace(/^\//, ''),
      );
      if (!objects.has(from)) return xml(res, '<Error><Code>NoSuchKey</Code></Error>', 404);
      objects.set(key, objects.get(from));
      return xml(
        res,
        '<CopyObjectResult><ETag>"copy"</ETag><LastModified>2026-09-24T00:00:00.000Z</LastModified></CopyObjectResult>',
      );
    }
    if (req.method === 'PUT') {
      objects.set(key, await body(req));
      res.setHeader('ETag', '"put"');
      return res.end();
    }
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') || '';
      const bucketName = key.replace(/^\//, '').replace(/\/$/, '');
      const keys = [...objects.keys()]
        .filter((name) => name.startsWith(`/${bucketName}/`))
        .map((name) => name.slice(bucketName.length + 2))
        .filter((name) => name.startsWith(prefix));
      return xml(
        res,
        `<ListBucketResult><Name>${bucketName}</Name><Prefix>${prefix}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>${keys.map((name) => `<Contents><Key>${name}</Key><Size>${objects.get(`/${bucketName}/${name}`).length}</Size></Contents>`).join('')}</ListBucketResult>`,
      );
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const data = objects.get(key);
      if (!data) {
        if (req.method === 'HEAD') {
          res.writeHead(404);
          return res.end();
        }
        return xml(res, '<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>', 404);
      }
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (range && req.method === 'GET') {
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), data.length - 1);
        res.writeHead(206, {
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Content-Type': 'application/octet-stream',
        });
        return res.end(data.subarray(start, end + 1));
      }
      res.writeHead(200, {
        'Content-Length': data.length,
        'Content-Type': 'application/octet-stream',
      });
      return res.end(req.method === 'HEAD' ? undefined : data);
    }
    if (req.method === 'DELETE') {
      if (uploadId) uploads.delete(uploadId);
      else objects.delete(key);
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(400);
    res.end();
  };
}
const axiosFailure = (status) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status },
    config: { url: 'https://openrouter.ai/api/v1/chat/completions' },
  });

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'described-router-test-'));
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  voiceWav = join(root, 'voice.wav');
  await command(
    ffmpegPath,
    ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=24000:duration=2', voiceWav],
    new AbortController().signal,
  );
  const store = fakeStorage();
  external = createServer(async (req, res) => {
    if (req.url === '/voices.json') {
      if (voicesDown) {
        res.writeHead(502);
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          voices: ['Voice 1', 'clear woman · flint'],
          describe: { 'Voice 1': 'Test voice' },
          categories: [{ name: 'Test', voices: ['Voice 1', 'clear woman · flint'] }],
        }),
      );
      return;
    }
    if (req.url === '/v1/audio/speech') {
      await body(req);
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(await readFile(voiceWav));
      return;
    }
    store(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => external.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${external.address().port}`;
  process.env.KADE_TTS_PROXY_URL = base;
  process.env.OPENROUTER_KEY = 'test-only';
  process.env.DEEPGRAM_API_KEY = 'test-only';
  process.env.AWS_BUCKET_NAME = 'test';
  process.env.KADE_DESCRIPTION_DAILY_USD = '5';
  process.env.KADE_DESCRIPTION_JOB_USD = '5';
  process.env.KADE_DESCRIPTION_PREVIEW_SECONDS = '60';
  delete process.env.KADE_DESCRIPTION_PUBLIC;
  delete process.env.KADE_DESCRIBED_VIDEO;
  storage = new S3Client({
    endpoint: base,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const hooks = {
    auth: (req, res, next) => (req.headers['x-user'] ? next() : res.sendStatus(401)),
    actor: (req) => ({
      id: String(req.headers['x-user']),
      role: req.headers['x-role'] === 'user' ? 'USER' : 'ADMIN',
      child: req.headers['x-child'] === '1',
    }),
    storage: () => storage,
    log: () => {},
    usage: async () => {},
    notify: async (owner, title, text, url) => {
      notices.push({ owner, title, text, url });
      return { browser: 1, bridge: 200 };
    },
    library: {
      folders: async () => ['Audio/Commercials/1996'],
      open: async (_req, book, track) => {
        if (book === 'd'.repeat(24))
          return {
            key: `media-library/${book}/huge.mp4`,
            bytes: 9 * 1024 ** 3,
            title: 'Huge tape',
            about: '',
            shared: true,
            grownUpsOnly: false,
            ownerIsActor: true,
          };
        if (book !== 'a'.repeat(24))
          throw Object.assign(new Error('That library video was not found.'), { status: 404 });
        return {
          key: `media-library/${book}/${track}.mp4`,
          bytes: 1,
          title: 'Library​ film\n',
          about: 'From the shelf.',
          shared: false,
          grownUpsOnly: true,
          ownerIsActor: false,
          context: 'Shelf: Video/Ozarks/Station IDs/1990s. Station: KOLR 10.',
          path: 'Video/Ozarks/Station IDs/1990s',
        };
      },
      save: async (input) => {
        libraryCalls.push(input);
        await input.copy(`media-library/${input.id}/described.m4a`);
        if (librarySaveFails) throw new Error('The library database is down.');
        return { id: input.id, path: input.path };
      },
    },
    providers: {
      transcribe: async () => {
        calls.transcribe++;
        return [{ start: 0.2, end: 0.9, word: 'Hello.', speaker: 0 }];
      },
      analyze: async (look, _signal, meter) => {
        calls.analyze++;
        if (failSection === calls.analyze || (failLaterSections && look.state))
          throw axiosFailure(402);
        if (refuseSection === look.brief.position?.index && !look.brief.survey)
          await meter('vision', 0.2, async () => {
            throw axiosFailure(429);
          });
        return {
          kind: 'other',
          setting: 'A test pattern.',
          people: [],
          speakers: [{ speaker: 0, who: 'the host' }],
          protectedSounds: [],
          cues: [
            {
              at: 2,
              until: Math.min(look.seconds, 8),
              pauseAt: 2,
              text: `Section cue ${calls.analyze}.`,
              shortText: 'Cue.',
              importance: 3,
            },
          ].concat(
            simulateConcurrentCosts
              ? [{ at: 5, until: 9, pauseAt: 5, text: 'Another test shape moves.', shortText: 'The shape moves.', importance: 2 }]
              : [],
          ),
        };
      },
      synthesize: async (_text, _voice, _session, file, _speed, _signal, meter) => {
        calls.synthesize++;
        if (simulateConcurrentCosts || sampleCost) {
          await meter('speech', 0.3, async () => {
            await new Promise((resolve) => setTimeout(resolve, 75));
            await copyFile(voiceWav, file);
            return { costUSD: sampleCost || 0.01 };
          });
          return;
        }
        await copyFile(voiceWav, file);
      },
    },
    describe: async (input) => {
      requests.push(input);
      if (beforeEngine) await beforeEngine(input);
      return describeVideo(input);
    },
    timing: { heartbeatMs: 100, tickMs: 0, wedgeMs: 1500 },
  };
  service = createDescriptionRouter({
    ...hooks,
    usage: async () => {
      throw new Error('Route tests make no paid calls.');
    },
  });
  await service.close();
  worker = createDescriptionRouter(hooks);
  app = express();
  app.use(express.json());
  app.use(service.router);
  Jobs = mongoose.models.KadeDescriptionJob;
  Budgets = mongoose.models.KadeDescriptionBudget;
  Locks = mongoose.models.KadeDescriptionLock;
});
after(async () => {
  await service?.close();
  await worker?.close();
  await mongoose.disconnect();
  await mongo?.stop();
  if (external) await new Promise((resolve) => external.close(resolve));
  await rm(root, { recursive: true, force: true });
});
const call = (method, path, owner = 'owner') => request(app)[method](path).set('x-user', owner);
const today = () => new Date().toISOString().slice(0, 10);
const held = async () => (await Budgets.findById(today()).lean())?.held ?? 0;
const stale = { updatedAt: new Date(Date.now() - 10 * 60000), lease: new Date(Date.now() - 60000) };
async function upload(owner, id, bytes = 1000, name = 'episode.mp4') {
  const result = await call('post', '/uploads', owner)
    .send({ requestId: id, name, bytes })
    .expect(200);
  return result.body.job.id;
}
async function video(seconds, extra = []) {
  const key = `${seconds}:${extra.join(' ')}`;
  if (videos.has(key)) return videos.get(key);
  const file = join(root, `source-${videos.size}.mp4`);
  await command(
    ffmpegPath,
    [
      '-nostdin', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=160x120:rate=30:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=48000:duration=${seconds}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      ...extra,
      file,
    ],
    new AbortController().signal,
  );
  videos.set(key, file);
  return file;
}
/** A checked upload ready to describe, without going through the check lane. */
async function readyJob(owner, id, seconds, extra = {}) {
  const bytes = seconds <= 150 ? await readFile(await video(seconds)) : Buffer.alloc(1000, 1);
  const jobId = await upload(owner, id, bytes.length);
  const document = await Jobs.findById(jobId).lean();
  objects.set(`/test/${document.key}`, bytes);
  await Jobs.updateOne(
    { _id: jobId },
    { $set: { state: 'ready', seconds, ...extra }, $unset: { uploadId: 1, parts: 1 } },
  );
  return jobId;
}
/** Drives the worker until the job reaches one of `states`. */
async function settle(id, states, owner = 'owner') {
  const deadline = Date.now() + 5 * 60000;
  while (Date.now() < deadline) {
    await worker.tick();
    const job = (await call('get', `/jobs/${id}`, owner).expect(200)).body;
    if (states.includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The job did not settle.');
}
const keysOf = (id) => [...objects.keys()].filter((key) => key.includes(id));
async function eventually(check) {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

test('the page still opens when the voice list cannot be fetched', async () => {
  voicesDown = true;
  try {
    const config = await call('get', '/config').expect(200);
    assert.equal(config.body.voicesAvailable, false);
    assert.deepEqual(config.body.voices, []);
    assert.equal(config.body.remainingUSD, 5);
    await call('get', '/jobs').expect(200);
    const id = await readyJob('voiceless-owner', 'voiceless-upload-01', 30);
    const start = await call('post', `/jobs/${id}/start`, 'voiceless-owner').send(settings).expect(503);
    assert.match(start.body.error, /voices could not be loaded/);
    await call('delete', `/jobs/${id}`, 'voiceless-owner').expect(200);
  } finally {
    voicesDown = false;
  }
});

test('authentication, the private trial gate and child accounts come before any job data', async () => {
  await request(app).get('/jobs').expect(401);
  await call('get', '/jobs').set('x-role', 'user').expect(403);
  const child = await call('get', '/jobs').set('x-child', '1').expect(403);
  assert.match(child.body.error, /children/);
  const config = (await call('get', '/config').expect(200)).body;
  assert.equal(config.limitUSD, 5);
  assert.equal(config.voicesAvailable, true);
  assert.deepEqual(config.voices, ['Voice 1', 'clear woman · flint']);
  assert.equal(config.defaultVoice, 'clear woman · flint');
  assert.equal(config.categories[0].name, 'Test');
  assert.ok(config.perMinuteUSD.rich > config.perMinuteUSD.essential);
  assert.deepEqual(config.extrasPerMinuteUSD, { closeLook: 0.025, firstLook: 0.021 });
  assert.deepEqual(config.setAside, { factor: 1.1, extraUSD: 0.05 });
  assert.equal(config.previewSeconds, 60);
  assert.equal(config.maxMinutes, 90);
  assert.equal(config.maxSourceMinutes, 360);
  assert.equal(config.remainingUSD, 5);
});

test('uploads are idempotent, owners are isolated, a rename keeps recovery, and up to ten can wait', async () => {
  const id = await upload('owner', 'idempotent-upload-0001');
  assert.equal(await upload('owner', 'idempotent-upload-0001'), id);
  await call('post', '/uploads')
    .send({ requestId: 'idempotent-upload-0001', name: 'different.mp4', bytes: 1000 })
    .expect(409);
  await call('post', `/jobs/${id}/rename`).send({ name: '  KY3​ sign-off\n1994 ' }).expect(200);
  assert.equal((await Jobs.findById(id).lean()).name, 'KY3 sign-off 1994');
  assert.equal(await upload('owner', 'idempotent-upload-0001'), id, 'the renamed upload still resumes');
  for (const path of [`/jobs/${id}`, `/jobs/${id}/files`])
    await call('get', path, 'another-owner').expect(404);
  await call('post', `/jobs/${id}/cancel`, 'another-owner').expect(404);
  await call('delete', `/jobs/${id}`, 'another-owner').expect(404);
  assert.equal((await call('get', '/jobs', 'another-owner').expect(200)).body.jobs.length, 0);
  const more = [];
  for (let i = 1; i < 10; i++)
    more.push(await upload('owner', `queued-upload-${String(i).padStart(6, '0')}`));
  const eleventh = await call('post', '/uploads')
    .send({ requestId: 'eleventh-upload-00001', name: 'episode.mp4', bytes: 1000 })
    .expect(409);
  assert.match(eleventh.body.error, /10 videos/);
  for (const job of [id, ...more]) await call('delete', `/jobs/${job}`).expect(200);
  assert.equal(await Jobs.countDocuments({ owner: 'owner' }), 0);
  assert.equal([...uploads.values()].filter((item) => item.key.includes(id)).length, 0);
});

test('chunk uploads resume, verify repeated bytes, assemble once, and tolerate a retry after they finish', async () => {
  const bytes = 8 * 1024 ** 2;
  const created = await call('post', '/uploads', 'chunk-owner')
    .send({ requestId: 'chunk-upload-0000001', name: 'clip.mp4', bytes: bytes + 3 })
    .expect(200);
  const id = created.body.job.id;
  const chunk = Buffer.alloc(bytes, 42);
  const put = (owner, number, data) =>
    call('post', `/jobs/${id}/chunks`, owner)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Part-Number', String(number))
      .send(data);
  await put('another-owner', 1, chunk).expect(404);
  const oversized = await put('chunk-owner', 1, Buffer.alloc(bytes + 1024)).expect(413);
  assert.match(oversized.body.error, /too large/);
  await put('chunk-owner', 2, Buffer.from('end')).expect(409);
  await put('chunk-owner', 1, chunk).expect(200);
  await put('chunk-owner', 1, chunk).expect(200);
  assert.equal((await Jobs.findById(id)).uploadedBytes, bytes);
  const resumed = await call('post', '/uploads', 'chunk-owner')
    .send({ requestId: 'fresh-tab-upload-0001', resumeId: id, name: 'clip.mp4', bytes: bytes + 3 })
    .expect(200);
  assert.equal(resumed.body.job.uploadedBytes, bytes);
  chunk[0] = 1;
  await put('chunk-owner', 1, chunk).expect(409);
  await put('chunk-owner', 2, Buffer.from('end')).expect(200);
  await call('post', `/jobs/${id}/prepare`, 'chunk-owner').expect(200);
  await call('post', `/jobs/${id}/prepare`, 'chunk-owner').expect(200);
  await put('chunk-owner', 2, Buffer.from('end')).expect(200);
  const stored = await Jobs.findById(id);
  assert.equal(stored.state, 'checking');
  assert.equal(stored.uploadId, undefined);
  await call('post', `/jobs/${id}/cancel`, 'chunk-owner').expect(200);
  await call('delete', `/jobs/${id}`, 'chunk-owner').expect(200);
});

test('errors are plain: 400 for bad input, 404 for a missing job, 500 without server text', async () => {
  await call('get', `/jobs/${'f'.repeat(32)}`).expect(404);
  const id = await readyJob('error-owner', 'error-upload-000001', 30);
  const bad = await call('post', `/jobs/${id}/start`, 'error-owner')
    .send({ ...settings, rate: 'fast' })
    .expect(400);
  assert.equal(bad.body.field, 'rate');
  assert.doesNotMatch(bad.body.error, /Expected|received/);
  const slower = await call('post', `/jobs/${id}/start`, 'error-owner')
    .send({ ...settings, maxRate: 1 })
    .expect(400);
  assert.match(slower.body.error, /fastest narration speed/);
  const invented = await call('post', `/jobs/${id}/start`, 'error-owner')
    .send({ ...settings, voice: 'invented' })
    .expect(400);
  assert.equal(invented.body.field, 'voice');
  await Jobs.updateOne(
    { _id: id },
    { $set: { state: 'done', copies: [{ version: 1, settings, sections: [], spans: [0, 30] }] } },
  );
  faults.push({ method: 'GET', match: /copies\/1\/transcript\.txt$/, times: 3 });
  const broken = await call('get', `/jobs/${id}/text/transcript`, 'error-owner').expect(500);
  assert.equal(broken.body.error, 'The server had a problem with that step. Try again in a minute.');
  faults.length = 0;
  await call('get', `/jobs/${id}/text/transcript`, 'error-owner').expect(404);
  await call('get', `/jobs/${id}/text/secrets`, 'error-owner').expect(404);
  const youtube = await call('post', '/imports', 'error-owner')
    .send({ requestId: 'youtube-import-bad01', url: 'not a link' })
    .expect(400);
  assert.equal(youtube.body.field, 'url');
  await call('delete', `/jobs/${id}`, 'error-owner').expect(200);
});

test('money: each run sets aside its own whole cents, matching the estimate, and gives them back once', async () => {
  await Budgets.deleteMany({});
  const id = await readyJob('owner', 'paid-upload-00000001', 5400);
  const priced = (await call('post', `/jobs/${id}/estimate`).send({ action: 'start', settings }).expect(200)).body;
  const parts = Object.values(priced.breakdown).reduce((sum, value) => sum + value, 0);
  assert.equal(priced.estimateUSD, Math.ceil(parts * 100 - 1e-6) / 100);
  assert.equal(priced.setAsideUSD, Math.min(5, Math.ceil((priced.estimateUSD * 1.1 + 0.05) * 100 - 1e-6) / 100));
  assert.equal(priced.seconds, 5400);
  assert.ok(priced.breakdown.dialogue > 0 && priced.breakdown.firstLook === 0);
  const expensive = (
    await call('post', `/jobs/${id}/estimate`)
      .send({ action: 'start', settings: { ...settings, closeLook: true, firstLook: true, detail: 'rich' } })
      .expect(200)
  ).body;
  assert.equal(expensive.allowed, false);
  assert.match(expensive.reason, /above the \$5\.00 limit/);
  const refused = await call('post', `/jobs/${id}/start`)
    .send({ ...settings, closeLook: true, firstLook: true, detail: 'rich' })
    .expect(409);
  assert.match(refused.body.error, /above the.*limit/);
  assert.equal((await Jobs.findById(id)).state, 'ready');
  const starts = await Promise.all(
    Array.from({ length: 12 }, () => call('post', `/jobs/${id}/start`).send(settings)),
  );
  assert.ok(starts.every((result) => [200, 202].includes(result.status)));
  const queued = await Jobs.findById(id).lean();
  assert.equal(queued.state, 'queued');
  assert.equal(queued.reservation.cents, Math.round(priced.setAsideUSD * 100));
  assert.equal(queued.runEstimateUSD, priced.estimateUSD);
  const budget = await Budgets.findById(today()).lean();
  assert.equal(budget.held, queued.reservation.cents);
  assert.deepEqual(budget.runs, [queued.reservation.runId]);
  const listed = (await call('get', `/jobs/${id}`).expect(200)).body;
  assert.equal(listed.setAsideUSD, priced.setAsideUSD);
  assert.equal(listed.estimatedUSD, priced.estimateUSD);
  assert.equal(listed.runCostUSD, 0);
  assert.equal(listed.queuePosition, 0);

  const second = await readyJob('another-owner', 'paid-upload-00000002', 3000);
  const check = (await call('post', `/jobs/${second}/estimate`, 'another-owner').send({ action: 'start', settings }).expect(200)).body;
  assert.equal(check.allowed, false);
  assert.match(check.reason, /allowance is left/);
  assert.match(check.reason, /Videos still being described have/);
  assert.match(check.reason, /starts fresh at .* Central time/);
  const blocked = await call('post', `/jobs/${second}/start`, 'another-owner').send(settings).expect(409);
  assert.match(blocked.body.error, /allowance is left/);
  assert.equal((await Jobs.findById(second)).state, 'ready');
  await call('delete', `/jobs/${id}`).expect(409);
  await Jobs.updateOne({ _id: id }, { $set: { runCost: 0.3, costUSD: 0.3 } });
  await call('post', `/jobs/${id}/cancel`).expect(200);
  await call('post', `/jobs/${id}/cancel`).expect(200);
  assert.equal(await held(), 30, 'only what the run spent stays against the day');
  assert.deepEqual((await Budgets.findById(today()).lean()).runs, []);
  await call('post', `/jobs/${second}/start`, 'another-owner').send(settings).expect(202);
  const other = await Jobs.findById(second).lean();
  await Budgets.updateOne({ _id: today() }, { $inc: { held: 7 }, $addToSet: { runs: 'someone-elses-run' } });
  await call('post', `/jobs/${second}/cancel`, 'another-owner').expect(200);
  assert.equal(await held(), 37, 'a release touches only its own run');
  assert.deepEqual((await Budgets.findById(today()).lean()).runs, ['someone-elses-run']);
  assert.ok(other.reservation.cents > 0);
  await call('delete', `/jobs/${id}`).expect(200);
  await call('delete', `/jobs/${second}`, 'another-owner').expect(200);
  await Budgets.deleteMany({});
});

test('estimates cover previews, parts, the first look, and refuse what one run cannot do', async () => {
  const id = await readyJob('estimate-owner', 'estimate-upload-0001', 7200);
  const ask = async (action, extra = {}) =>
    (await call('post', `/jobs/${id}/estimate`, 'estimate-owner').send({ action, settings: { ...settings, ...extra } }).expect(200)).body;
  const whole = await ask('start');
  assert.equal(whole.allowed, false);
  assert.match(whole.reason, /2 hours long. One run can describe up to 90 minutes/);
  const tooLong = await call('post', `/jobs/${id}/start`, 'estimate-owner').send(settings).expect(400);
  assert.equal(tooLong.body.field, 'range');
  const part = await ask('start', { range: { start: 100, end: 400 } });
  assert.equal(part.allowed, true);
  assert.equal(part.seconds, 300);
  const surveyed = await ask('start', { range: { start: 100, end: 400 }, firstLook: true });
  assert.ok(surveyed.breakdown.firstLook > 0);
  const tiny = await ask('start', { range: { start: 100, end: 190 }, firstLook: true });
  assert.equal(tiny.breakdown.firstLook, 0, 'no first look for two minutes or less');
  const preview = await ask('preview', { range: { start: 0, end: 600 } });
  assert.equal(preview.seconds, 120, 'the first minute plus about one section');
  assert.equal(preview.breakdown.dialogue, part.breakdown.dialogue * 2, 'dialogue timing covers the whole part');
  const past = await ask('start', { range: { start: 7300, end: 7400 } });
  assert.equal(past.allowed, false);
  const closer = await ask('start', { range: { start: 0, end: 600 }, closeLook: true });
  assert.ok(Math.abs(closer.breakdown.closeLook - 0.25) < 1e-9, 'close look is priced at $0.025 a minute');
  for (const action of ['finish', 'resume', 'redo', 'revoice', 'reanalyze']) {
    const answer = await ask(action);
    assert.equal(answer.allowed, false, action);
    assert.ok(answer.reason, action);
  }
  const started = await call('post', `/jobs/${id}/start`, 'estimate-owner')
    .send({ ...settings, preview: true, range: { start: 60, end: 660 } })
    .expect(202);
  assert.equal(started.body.preview, true);
  assert.deepEqual(started.body.range, { start: 60, end: 660 });
  assert.equal(started.body.estimatedUSD, preview.estimateUSD);
  const stored = await Jobs.findById(id).lean();
  assert.equal(stored.stopAfter, 60);
  assert.equal(stored.runKind, 'preview');
  assert.equal(stored.priority, 0, 'a preview is a short job');
  await call('post', `/jobs/${id}/cancel`, 'estimate-owner').expect(200);
  await call('delete', `/jobs/${id}`, 'estimate-owner').expect(200);
  await Budgets.deleteMany({});
});

test('a stuck reservation goes back to where it came from and returns only its own money', async () => {
  const id = await readyJob('reserving-owner', 'reserving-upload-001', 60);
  await Budgets.deleteMany({});
  await Budgets.create({ _id: today(), held: 60, runs: ['pending-run', 'other-run'] });
  await Jobs.collection.updateOne(
    { _id: id },
    {
      $set: {
        state: 'reserving',
        reservingFrom: 'done',
        pendingRun: { runId: 'pending-run', day: today(), cents: 25 },
        ...stale,
      },
    },
  );
  process.env.KADE_DESCRIBED_VIDEO = '0';
  try {
    await worker.tick();
  } finally {
    delete process.env.KADE_DESCRIBED_VIDEO;
  }
  const job = await Jobs.findById(id).lean();
  assert.equal(job.state, 'done');
  assert.equal(job.pendingRun, undefined);
  const budget = await Budgets.findById(today()).lean();
  assert.equal(budget.held, 35);
  assert.deepEqual(budget.runs, ['other-run']);
  await call('delete', `/jobs/${id}`, 'reserving-owner').expect(200);
  await Budgets.deleteMany({});
});

test('cancel settles at once when the server died; a stale cancel request is swept to cancelled', async () => {
  const dead = await readyJob('cancel-owner', 'cancel-upload-000001', 60);
  const run = { runId: 'dead-run', day: today(), cents: 40 };
  await Budgets.create({ _id: today(), held: 80, runs: ['dead-run', 'swept-run'] });
  await Jobs.collection.updateOne(
    { _id: dead },
    { $set: { state: 'running', worker: 'gone', lease: new Date(Date.now() - 1000), reservation: run, runCost: 0.1, settings } },
  );
  const cancelled = (await call('post', `/jobs/${dead}/cancel`, 'cancel-owner').expect(200)).body;
  assert.equal(cancelled.state, 'cancelled');
  assert.match(cancelled.error, /may still be charged/);
  assert.equal(await held(), 50);
  const swept = await readyJob('cancel-owner', 'cancel-upload-000002', 60);
  await Jobs.collection.updateOne(
    { _id: swept },
    {
      $set: {
        state: 'running',
        worker: 'gone',
        cancelRequested: true,
        cancelAt: new Date(Date.now() - 60000),
        reservation: { runId: 'swept-run', day: today(), cents: 40 },
        runCost: 0,
        settings,
        ...stale,
      },
    },
  );
  const stuck = (await call('get', `/jobs/${swept}`, 'cancel-owner').expect(200)).body;
  assert.equal(stuck.cancelStuck, true, 'the page can offer Cancel again');
  process.env.KADE_DESCRIBED_VIDEO = '0';
  try {
    await worker.tick();
  } finally {
    delete process.env.KADE_DESCRIBED_VIDEO;
  }
  assert.equal((await Jobs.findById(swept).lean()).state, 'cancelled');
  assert.equal(await held(), 10);
  for (const id of [dead, swept]) await call('delete', `/jobs/${id}`, 'cancel-owner').expect(200);
  await Budgets.deleteMany({});
});

test('crashes count per section, three at the same place fail the job with a notice, and Continue then refuses', async () => {
  const id = await readyJob('crash-owner', 'crash-upload-0000001', 60);
  await Budgets.create({ _id: today(), held: 50, runs: ['crash-run'] });
  const crash = () =>
    Jobs.collection.updateOne(
      { _id: id },
      {
        $set: {
          state: 'running',
          worker: 'gone',
          settings,
          done: 1,
          sections: 2,
          reservation: { runId: 'crash-run', day: today(), cents: 50 },
          runCost: 0.05,
          ...stale,
        },
      },
    );
  process.env.KADE_DESCRIBED_VIDEO = '0';
  try {
    for (let i = 1; i <= 2; i++) {
      await crash();
      await worker.tick();
      const job = await Jobs.findById(id).lean();
      assert.equal(job.state, 'queued');
      assert.equal(job.crashes, i);
      assert.equal(job.stage, 'Continuing after a server restart');
    }
    await crash();
    await worker.tick();
  } finally {
    delete process.env.KADE_DESCRIBED_VIDEO;
  }
  const failed = (await call('get', `/jobs/${id}`, 'crash-owner').expect(200)).body;
  assert.equal(failed.state, 'failed');
  assert.equal(failed.resumable, false);
  assert.match(failed.error, /three times/);
  assert.equal(await held(), 5, 'the run keeps only what it spent');
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(notices.at(-1).text, /three times/);
  const refused = await call('post', `/jobs/${id}/resume`, 'crash-owner').send({}).expect(409);
  assert.match(refused.body.error, /three times/);
  await Jobs.updateOne({ _id: id }, { $set: { done: 2 } });
  assert.equal((await call('get', `/jobs/${id}`, 'crash-owner').expect(200)).body.resumable, true, 'progress since clears the lock');
  await call('delete', `/jobs/${id}`, 'crash-owner').expect(200);
  await Budgets.deleteMany({});
});

test('YouTube and library imports: idempotent, privacy and catalog facts kept, size capped', async () => {
  const bad = await call('post', '/imports', 'youtube-owner')
    .send({ requestId: 'youtube-import-00001', url: 'http://127.0.0.1/admin' })
    .expect(400);
  assert.equal(bad.body.field, 'url');
  const first = await call('post', '/imports', 'youtube-owner')
    .send({ requestId: 'youtube-import-00001', url: 'https://youtu.be/aqz-KE-bpKQ?t=10' })
    .expect(202);
  const again = await call('post', '/imports', 'youtube-owner')
    .send({ requestId: 'youtube-import-00001', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' })
    .expect(202);
  assert.equal(first.body.id, again.body.id);
  assert.equal(first.body.state, 'importing');
  await call('post', `/jobs/${first.body.id}/start`, 'youtube-owner').send(settings).expect(409);
  await call('post', `/jobs/${first.body.id}/cancel`, 'youtube-owner').expect(200);
  await call('post', '/library-imports', 'youtube-owner')
    .send({ requestId: 'library-import-00001', book: 'c'.repeat(24), track: 0 })
    .expect(404);
  const huge = await call('post', '/library-imports', 'youtube-owner')
    .send({ requestId: 'library-import-00002', book: 'd'.repeat(24), track: 0 })
    .expect(409);
  assert.match(huge.body.error, /9\.0 GB/);
  const library = await call('post', '/library-imports', 'youtube-owner')
    .send({ requestId: 'library-import-00001', book: 'a'.repeat(24), track: 2 })
    .expect(202);
  assert.equal(library.body.source, 'library');
  assert.equal(library.body.name, 'Library film');
  assert.equal(library.body.sourcePrivate, true);
  assert.equal(library.body.sourceGrownUps, true);
  assert.equal(library.body.sourceOwner, 'someone else');
  assert.equal(library.body.libraryPath, 'Audio/Ozarks/Station IDs/1990s');
  const stored = await Jobs.findById(library.body.id).lean();
  assert.equal(stored.sourceKey, `media-library/${'a'.repeat(24)}/2.mp4`);
  assert.match(stored.context, /KOLR 10/);
  await call('post', `/jobs/${library.body.id}/cancel`, 'youtube-owner').expect(200);
  await call('delete', `/jobs/${library.body.id}`, 'youtube-owner').expect(200);
  await call('delete', `/jobs/${first.body.id}`, 'youtube-owner').expect(200);
});

test('the free check reads a big file only at both ends, keeps a rename, and can be tried again after a storage fault', async () => {
  const file = await video(150);
  const bytes = await readFile(file);
  const created = await call('post', '/uploads', 'check-owner')
    .send({ requestId: 'check-upload-0000001', name: 'VID_20240101.mp4', bytes: bytes.length })
    .expect(200);
  const id = created.body.job.id;
  for (let offset = 0, part = 1; offset < bytes.length; offset += created.body.chunkBytes, part++)
    await call('post', `/jobs/${id}/chunks`, 'check-owner')
      .set('Content-Type', 'application/octet-stream')
      .set('X-Part-Number', String(part))
      .send(bytes.subarray(offset, offset + created.body.chunkBytes))
      .expect(200);
  await call('post', `/jobs/${id}/prepare`, 'check-owner').expect(200);
  const key = (await Jobs.findById(id).lean()).key;
  process.env.KADE_DESCRIPTION_CHECK_WHOLE_MB = String(bytes.length / 3 / 1024 ** 2);
  faults.push({ method: 'GET', match: new RegExp(`${id}/source$`), times: 6 });
  try {
    const failed = await settle(id, ['ready', 'failed'], 'check-owner');
    assert.equal(failed.state, 'failed', 'two storage outages in a row stop the check');
    assert.equal(failed.recheckable, true);
    assert.doesNotMatch(failed.error, /boom|InternalError/);
    assert.match(notices.at(-1).title, /could not be checked/);
    const start = await call('post', `/jobs/${id}/start`, 'check-owner').send(settings).expect(409);
    assert.match(start.body.error, /Press Check again/);
    faults.length = 0;
    storageLog.length = 0;
    await call('post', `/jobs/${id}/recheck`, 'check-owner').expect(200);
    storageHook = async (entry) => {
      if (entry.method !== 'GET' || entry.key !== `/test/${key}`) return;
      storageHook = null;
      await Jobs.updateOne({ _id: id }, { $set: { name: 'KY3 sign-off 1994' } });
    };
    const ready = await settle(id, ['ready', 'failed'], 'check-owner');
    assert.equal(ready.state, 'ready', ready.error);
    assert.ok(Math.abs(ready.seconds - 150) < 0.2);
    assert.equal(ready.name, 'KY3 sign-off 1994', 'a rename during the check is kept');
    const reads = storageLog.filter((item) => item.method === 'GET' && item.key === `/test/${key}`);
    assert.ok(reads.length >= 2 && reads.every((item) => item.range), 'only ranged reads');
  } finally {
    delete process.env.KADE_DESCRIPTION_CHECK_WHOLE_MB;
    faults.length = 0;
    storageHook = null;
  }
  await call('post', `/jobs/${id}/recheck`, 'check-owner').expect(409);
  await call('delete', `/jobs/${id}`, 'check-owner').expect(200);
});

test('a whole job: describe, stop, continue, library, re-voice, script, corrections, fresh look, abandon', async () => {
  await Budgets.deleteMany({});
  const id = await readyJob('film-owner', 'film-upload-00000001', 150, { name: 'My film.mp4' });
  failSection = calls.analyze + 2;
  await call('post', `/jobs/${id}/start`, 'film-owner')
    .send({ ...settings, detail: 'rich', notes: 'The host is Pat.' })
    .expect(202);
  const stopped = await settle(id, ['failed', 'done'], 'film-owner');
  assert.equal(stopped.state, 'failed');
  assert.match(stopped.error, /topped up/);
  assert.equal(stopped.done, 1);
  assert.equal(stopped.sections, 2);
  assert.equal(stopped.resumable, true);
  assert.equal(stopped.abandonable, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(notices.at(-1).title, /stopped/);
  assert.match(notices.at(-1).text, /tries again on parts that could not be described/);
  assert.ok(keysOf(id).some((key) => key.endsWith(`${id}/sections/v1/0.flac`)));
  assert.equal(await held(), 0, 'a failed run gives its money back');

  failSection = -1;
  const analyzedBefore = calls.analyze;
  const resumeEstimate = (await call('post', `/jobs/${id}/estimate`, 'film-owner').send({ action: 'resume' }).expect(200)).body;
  assert.ok(resumeEstimate.seconds > 0 && resumeEstimate.seconds < 150, 'Continue prices only the unfinished part');
  assert.equal(resumeEstimate.breakdown.dialogue, 0);
  await call('post', `/jobs/${id}/resume`, 'film-owner').send({}).expect(202);
  const done = await settle(id, ['done', 'failed'], 'film-owner');
  assert.equal(done.state, 'done', done.error);
  assert.equal(calls.analyze - analyzedBefore, 1, 'only the unfinished section was described again');
  assert.equal(calls.transcribe, 1, 'the dialogue was transcribed once for the whole job');
  assert.equal(done.descriptions, 2);
  assert.ok(Math.abs(done.outputSeconds - 150) < 0.1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(notices.at(-1).title, /ready/);
  assert.match(notices.at(-1).text, /Kept until/);
  assert.equal(notices.at(-1).url, `/described-video?id=${id}`);
  await eventually(async () =>
    assert.equal((await Jobs.findById(id).lean()).lastNotice.kind, 'ready'),
  );
  assert.deepEqual(done.copies.map((copy) => [copy.version, copy.preview]), [[1, false]]);

  const files = (await call('get', `/jobs/${id}/files`, 'film-owner').expect(200)).body;
  for (const kind of ['video', 'audio', 'transcript', 'descriptions', 'captions', 'script'])
    assert.ok(files[kind], kind);
  assert.ok(files.expiresAt);
  assert.match(decodeURIComponent(files.videoDownload), /My film \(described\)\.mp4/);
  const transcript = await call('get', `/jobs/${id}/text/transcript`, 'film-owner').expect(200);
  assert.match(transcript.text, /Description: Section cue/);
  assert.match(transcript.text, /The host: Hello\./);
  await call('get', `/jobs/${id}/text/transcript`, 'another-owner').expect(404);

  const saved = await call('post', `/jobs/${id}/library`, 'film-owner')
    .send({ share: false, path: 'audio/ commercials /1997' })
    .expect(200);
  const saveCall = libraryCalls.at(-1);
  assert.equal(saved.body.savedToLibrary, saveCall.id);
  assert.match(saveCall.id, /^[a-f0-9]{24}$/);
  assert.equal(saveCall.title, 'My film (described)');
  assert.equal(saveCall.share, false);
  assert.equal(saveCall.grownUpsOnly, false);
  assert.equal(saveCall.path, 'Audio/Commercials/1997', 'an existing folder keeps its spelling');
  assert.match(saveCall.transcript, /Description: Section cue/);
  assert.ok(objects.has(`/test/media-library/${saveCall.id}/described.m4a`));

  const analyzed = calls.analyze;
  await call('post', `/jobs/${id}/revoice`, 'film-owner')
    .send({ ...settings, voice: 'clear woman · flint', rate: 2, maxRate: 3 })
    .expect(202);
  const revoiced = await settle(id, ['done', 'failed'], 'film-owner');
  assert.equal(revoiced.state, 'done', revoiced.error);
  assert.equal(revoiced.version, 2);
  assert.equal(calls.analyze, analyzed, 're-voicing reused the saved descriptions');
  assert.equal(revoiced.settings.detail, 'rich');
  assert.equal(revoiced.settings.rate, 2);
  assert.equal(revoiced.savedToLibrary, '');
  assert.ok(keysOf(id).some((key) => key.endsWith('/sections/v2/0.json')), 'each version keeps its own sections');

  const originalTranscript = await call('get', `/jobs/${id}/text/transcript?version=1`, 'film-owner').expect(200);
  assert.equal(originalTranscript.text, transcript.text, 'the previous finished version remains unchanged');
  await call('get', `/jobs/${id}/files?version=99`, 'film-owner').expect(404);
  await call('get', `/jobs/${id}/script`, 'another-owner').expect(404);
  const script = (await call('get', `/jobs/${id}/script`, 'film-owner').expect(200)).body;
  assert.equal(script.version, 2);
  assert.equal(script.cues.length, 2);
  assert.deepEqual(script.cues.map((cue) => cue.section), [0, 1]);
  assert.ok(script.cues.every((cue) => cue.spoken && cue.spokenText));
  assert.ok(script.cues[1].outputAt > script.cues[1].at - 1);
  const oldScript = (await call('get', `/jobs/${id}/script?version=1`, 'film-owner').expect(200)).body;
  assert.equal(oldScript.version, 1);
  const correction = {
    ...script.cues[0],
    text: 'Pat holds a blue folder\n\n[whispering] & a <b>pen</b>.',
    shortText: 'Pat holds a folder.',
    omit: false,
  };
  await call('post', `/jobs/${id}/revoice`, 'film-owner')
    .send({ ...revoiced.settings, expectedVersion: 1, edits: [correction] })
    .expect(409);
  await call('post', `/jobs/${id}/revoice`, 'film-owner')
    .send({ ...revoiced.settings, expectedVersion: 2, edits: [{ ...correction, id: '99:99' }] })
    .expect(409);
  const empty = await call('post', `/jobs/${id}/revoice`, 'film-owner')
    .send({ ...revoiced.settings, expectedVersion: 2, edits: [{ ...correction, text: '[ ]' }] })
    .expect(400);
  assert.equal(empty.body.field, 'edits');
  const correctionPrice = (
    await call('post', `/jobs/${id}/estimate`, 'film-owner')
      .send({ action: 'revoice', settings: revoiced.settings, edits: [correction] })
      .expect(200)
  ).body;
  assert.ok(correctionPrice.estimateUSD < 0.1, 'a one-line correction costs cents');
  const voicedBefore = calls.synthesize;
  await call('post', `/jobs/${id}/revoice`, 'film-owner')
    .send({ ...revoiced.settings, expectedVersion: 2, edits: [correction] })
    .expect(202);
  await call('get', `/jobs/${id}/files?version=2`, 'film-owner').expect(200);
  const corrected = await settle(id, ['done', 'failed'], 'film-owner');
  assert.equal(corrected.state, 'done', corrected.error);
  assert.equal(corrected.version, 3);
  assert.equal(calls.analyze, analyzed, 'correction does not analyze the video again');
  assert.equal(calls.synthesize - voicedBefore, 1, 'only the changed section is voiced again');
  const revisedTranscript = await call('get', `/jobs/${id}/text/transcript`, 'film-owner').expect(200);
  assert.match(revisedTranscript.text, /Description: Pat holds a blue folder whispering and a/);
  assert.doesNotMatch(revisedTranscript.text, /[[\]<>]/);
  const stored = await Jobs.findById(id).lean();
  assert.deepEqual(stored.copies.at(-1).sections, [3, 2], 'the unedited section is read from version 2');
  const dots = await call('post', `/jobs/${id}/library`, 'film-owner').send({ path: 'Audio/../Video' }).expect(400);
  assert.equal(dots.body.field, 'path');
  const broken = await call('post', `/jobs/${id}/library`, 'film-owner').send({ path: 'Audio/\nVideo' }).expect(400);
  assert.match(broken.body.error, /line breaks/);

  const expiry = new Date(corrected.expiresAt).getTime();
  const beforeFresh = calls.analyze;
  await call('post', `/jobs/${id}/reanalyze`, 'film-owner')
    .send({ ...corrected.settings, expectedVersion: 3, firstLook: true, notes: 'The host is Robin.' })
    .expect(202);
  await call('get', `/jobs/${id}/files?version=3`, 'film-owner').expect(200);
  const fresh = await settle(id, ['done', 'failed'], 'film-owner');
  assert.equal(fresh.state, 'done', fresh.error);
  assert.equal(fresh.version, 4);
  assert.equal(calls.analyze - beforeFresh, 4, 'two first-look sections and two fresh descriptions');
  assert.equal(calls.transcribe, 1, 'fresh descriptions reuse the whole-film transcript');
  assert.equal(fresh.settings.notes, 'The host is Robin.');
  assert.ok(keysOf(id).some((key) => key.endsWith(`${id}/first-look-4.json`)));

  await call('post', `/jobs/${id}/revoice`, 'film-owner')
    .send({ ...fresh.settings, voice: 'Voice 1', expectedVersion: 4 })
    .expect(202);
  const cancelled = (await call('post', `/jobs/${id}/cancel`, 'film-owner').expect(200)).body;
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.abandonable, true);
  assert.ok(cancelled.copies.some((copy) => copy.version === 3));
  assert.ok(new Date(cancelled.expiresAt).getTime() >= expiry, 'a cancelled remake does not shorten retention');
  await call('get', `/jobs/${id}/files?version=3`, 'film-owner').expect(200);
  await call('post', `/jobs/${id}/revoice`, 'film-owner').send({ ...fresh.settings, expectedVersion: 4 }).expect(409);
  objects.set(`/test/${folderOf(stored.key)}/sections/v5/0.json`, Buffer.from('{}'));
  const restored = (await call('post', `/jobs/${id}/abandon`, 'film-owner').expect(200)).body;
  assert.equal(restored.state, 'done');
  assert.equal(restored.version, 4);
  assert.equal(restored.settings.voice, fresh.settings.voice);
  assert.ok(!keysOf(id).some((key) => key.includes('/sections/v5/')), 'the stopped attempt is cleared away');
  await call('post', `/jobs/${id}/abandon`, 'film-owner').expect(409);
  await call('post', `/jobs/${id}/revoice`, 'film-owner')
    .send({ ...fresh.settings, voice: 'Voice 1', expectedVersion: 4 })
    .expect(202);
  assert.equal((await Jobs.findById(id).lean()).version, 6, 'an abandoned version number is never reused');
  await call('post', `/jobs/${id}/cancel`, 'film-owner').expect(200);
  await call('post', `/jobs/${id}/abandon`, 'film-owner').expect(200);
  assert.equal(await held(), 0, 'no money is left behind by any of those runs');

  const sample = await call('post', '/sample', 'film-owner').send({ voice: 'Voice 1', rate: 2 }).expect(200);
  assert.equal(sample.headers['content-type'], 'audio/wav');
  assert.ok(sample.body.length > 44 + 48000);

  await call('delete', `/jobs/${id}`, 'film-owner').expect(200);
  assert.equal(keysOf(id).length, 0, 'every stored file of the job is gone');
  assert.ok(objects.has(`/test/media-library/${saveCall.id}/described.m4a`), 'the library copy stays');
});
const folderOf = (key) => key.replace(/\/source$/, '');

test('a preview renders a marked copy, then Describe the rest finishes the same version', async () => {
  await Budgets.deleteMany({});
  const id = await readyJob('preview-owner', 'preview-upload-00001', 150);
  const price = (await call('post', `/jobs/${id}/estimate`, 'preview-owner').send({ action: 'preview', settings }).expect(200)).body;
  assert.ok(price.seconds < 150);
  requests.length = 0;
  await call('post', `/jobs/${id}/start`, 'preview-owner').send({ ...settings, preview: true }).expect(202);
  const preview = await settle(id, ['done', 'failed'], 'preview-owner');
  assert.equal(preview.state, 'done', preview.error);
  assert.equal(preview.preview, true);
  assert.equal(preview.finishable, true);
  assert.deepEqual(preview.copies.map((copy) => [copy.version, copy.preview]), [[1, true]]);
  assert.equal(requests.at(-1).stopAfter, 60);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(notices.at(-1).title, /preview is ready/);
  assert.match(notices.at(-1).text, /Describe the rest/);
  const manifest = (await Jobs.findById(id).lean()).copies[0].sections;
  const rest = (await call('post', `/jobs/${id}/estimate`, 'preview-owner').send({ action: 'finish' }).expect(200)).body;
  assert.equal(rest.allowed, true);
  assert.equal(rest.breakdown.dialogue, 0, 'the dialogue is not paid for twice');
  await call('post', `/jobs/${id}/finish`, 'preview-owner').send({}).expect(202);
  const finished = await settle(id, ['done', 'failed'], 'preview-owner');
  assert.equal(finished.state, 'done', finished.error);
  assert.equal(finished.version, 1, 'the same version is finished');
  assert.equal(finished.finishable, false);
  assert.deepEqual(finished.copies.map((copy) => [copy.version, copy.preview]), [[1, false]]);
  assert.equal(requests.at(-1).stopAfter, undefined);
  assert.equal(
    requests.at(-1).keeper.saved.records.length,
    manifest.filter((entry) => entry !== null).length,
    'every previewed section is reused',
  );
  await call('post', `/jobs/${id}/finish`, 'preview-owner').send({}).expect(409);
  assert.equal(await held(), 0);
  await call('delete', `/jobs/${id}`, 'preview-owner').expect(200);
});

test('failed paid requests that were not billed cost nothing, and redo describes only the failed parts', async () => {
  await Budgets.deleteMany({});
  const id = await readyJob('redo-owner', 'redo-upload-00000001', 150);
  refuseSection = 1;
  await call('post', `/jobs/${id}/start`, 'redo-owner').send(settings).expect(202);
  const done = await settle(id, ['done', 'failed'], 'redo-owner');
  refuseSection = -1;
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.failedSections, 1);
  assert.equal(done.retryableSections, 1);
  assert.equal(done.costUSD, 0, 'a refused request was not booked');
  assert.equal(await held(), 0);
  const stored = await Jobs.findById(id).lean();
  assert.deepEqual(stored.copies[0].failed, [1]);
  assert.equal(stored.spend.vision ?? 0, 0);
  const redoPrice = (await call('post', `/jobs/${id}/estimate`, 'redo-owner').send({ action: 'redo' }).expect(200)).body;
  assert.ok(redoPrice.seconds > 0 && redoPrice.seconds < 150, 'the default is the part that failed');

  requests.length = 0;
  await call('post', `/jobs/${id}/revoice`, 'redo-owner').send({ rate: 2, maxRate: 2.5 }).expect(202);
  const revoiced = await settle(id, ['done', 'failed'], 'redo-owner');
  assert.equal(revoiced.state, 'done', revoiced.error);
  const carried = requests.at(-1).keeper.saved;
  assert.ok(carried.analyses[0], 'the described section is voiced again');
  assert.equal(carried.analyses[1], undefined);
  assert.match(carried.looks[1].failure, /busy/, 'the gap is carried, not hidden');

  const before = calls.analyze;
  requests.length = 0;
  await call('post', `/jobs/${id}/redo`, 'redo-owner')
    .send({ sections: [1], note: 'The sign says Meeks.', expectedVersion: revoiced.version })
    .expect(202);
  const redone = await settle(id, ['done', 'failed'], 'redo-owner');
  assert.equal(redone.state, 'done', redone.error);
  assert.equal(redone.failedSections, 0);
  assert.equal(calls.analyze - before, 1, 'only the failed part was looked at again');
  assert.equal(requests.at(-1).sectionNotes[1], 'The sign says Meeks.');
  assert.equal(requests.at(-1).keeper.saved.records.length, 1);
  const none = await call('post', `/jobs/${id}/redo`, 'redo-owner').send({ expectedVersion: redone.version }).expect(409);
  assert.match(none.body.error, /Every part/);
  await call('delete', `/jobs/${id}`, 'redo-owner').expect(200);
});

test('Continue can change the voice: finished sections are voiced again from their saved descriptions', async () => {
  await Budgets.deleteMany({});
  const id = await readyJob('voice-owner', 'voice-upload-0000001', 150);
  beforeEngine = async (input) => {
    const keepPlan = input.keeper.keepPlan;
    input.keeper.keepPlan = async (plan, words) => {
      await keepPlan(plan, words);
      await input.keeper.keepLook(0, { analysis: null, failure: 'kept look' });
      throw new Error('Stopped by the test.');
    };
  };
  try {
    await call('post', `/jobs/${id}/start`, 'voice-owner').send(settings).expect(202);
    const stopped = await settle(id, ['failed', 'done'], 'voice-owner');
    assert.equal(stopped.error, 'Stopped by the test.');
    assert.ok(objects.has(`/test/${folderOf((await Jobs.findById(id).lean()).key)}/looks/v1/0.json`));
    beforeEngine = null;
    failLaterSections = true;
    await call('post', `/jobs/${id}/resume`, 'voice-owner').send({}).expect(202);
    const partly = await settle(id, ['failed', 'done'], 'voice-owner');
    failLaterSections = false;
    assert.equal(requests.at(-1).keeper.saved.looks[0].failure, 'kept look', 'a paid look is offered again');
    assert.equal(partly.state, 'failed');
    const priced = (
      await call('post', `/jobs/${id}/estimate`, 'voice-owner')
        .send({ action: 'resume', settings: { voice: 'clear woman · flint' } })
        .expect(200)
    ).body;
    assert.ok(priced.breakdown.speech > 0);
    await call('post', `/jobs/${id}/resume`, 'voice-owner').send({ voice: 'clear woman · flint' }).expect(202);
    const finished = await settle(id, ['failed', 'done'], 'voice-owner');
    assert.equal(finished.state, 'done', finished.error);
    assert.equal(finished.version, 2, 'a new voice makes a new version');
    assert.equal(finished.settings.voice, 'clear woman · flint');
    const saved = requests.at(-1).keeper.saved;
    assert.equal(saved.records.length, 0, 'nothing voiced with the old voice is reused');
    assert.ok(saved.analyses[0] || saved.looks[0], 'the finished section keeps its description');
  } finally {
    beforeEngine = null;
    failLaterSections = false;
  }
  assert.equal(await held(), 0);
  await call('delete', `/jobs/${id}`, 'voice-owner').expect(200);
});

test('a heartbeat that fails once does not stop the job; a storage outage re-queues instead of failing', async () => {
  await Budgets.deleteMany({});
  const id = await readyJob('heartbeat-owner', 'heartbeat-upload-001', 150);
  const original = Locks.updateOne;
  let failures = 1;
  Locks.updateOne = function (filter, update, ...rest) {
    if (failures > 0 && filter?.worker && update?.$set?.until > new Date()) {
      failures--;
      return Promise.reject(Object.assign(new Error('not primary'), { name: 'MongoNetworkError' }));
    }
    return original.call(this, filter, update, ...rest);
  };
  beforeEngine = () => new Promise((resolve) => setTimeout(resolve, 400));
  faults.push({ method: 'PUT', match: new RegExp(`${id}/sections/v1/0\\.flac$`), times: 3 });
  try {
    await call('post', `/jobs/${id}/start`, 'heartbeat-owner').send(settings).expect(202);
    const first = await settle(id, ['queued', 'done', 'failed'], 'heartbeat-owner');
    assert.equal(first.state, 'queued', first.error);
    assert.equal(first.stage, 'Continuing after a connection problem');
    const done = await settle(id, ['done', 'failed'], 'heartbeat-owner');
    assert.equal(done.state, 'done', done.error);
    assert.equal(failures, 0, 'the heartbeat did fail once');
  } finally {
    Locks.updateOne = original;
    beforeEngine = null;
    faults.length = 0;
  }
  assert.ok(!notices.some((item) => item.url.endsWith(id) && /stopped/.test(item.title)));
  assert.equal(await held(), 0);
  await call('delete', `/jobs/${id}`, 'heartbeat-owner').expect(200);
});

test('a stopped job whose work never winds down is settled, and its money and its lane are freed', async () => {
  await Budgets.deleteMany({});
  const id = await readyJob('wedge-owner', 'wedge-upload-0000001', 30);
  let unblock = () => {};
  beforeEngine = () => new Promise((resolve) => (unblock = resolve));
  try {
    await call('post', `/jobs/${id}/start`, 'wedge-owner').send(settings).expect(202);
    assert.ok((await held()) > 0);
    const ticking = worker.tick();
    await eventually(async () => assert.equal((await Jobs.findById(id).lean()).state, 'running'));
    const pressed = (await call('post', `/jobs/${id}/cancel`, 'wedge-owner').expect(200)).body;
    assert.equal(pressed.cancelRequested, true);
    await ticking;
    const job = (await call('get', `/jobs/${id}`, 'wedge-owner').expect(200)).body;
    assert.equal(job.state, 'cancelled');
    assert.equal(await held(), 0, 'the set-aside money came back');
  } finally {
    beforeEngine = null;
    unblock();
  }
  await eventually(async () => assert.equal(await held(), 0));
  await call('delete', `/jobs/${id}`, 'wedge-owner').expect(200);
});

test('concurrent paid speech requests settle their reservations without losing a charge', async () => {
  await Budgets.deleteMany({});
  const source = join(root, 'budget-source.mp4');
  await command(
    ffmpegPath,
    ['-nostdin', '-v', 'error', '-y', '-i', await video(150), '-t', '9', '-c', 'copy', source],
    new AbortController().signal,
  );
  const bytes = await readFile(source);
  const id = await upload('cost-owner', 'concurrent-costs-0001', bytes.length);
  const document = await Jobs.findById(id).lean();
  objects.set(`/test/${document.key}`, bytes);
  await Jobs.updateOne({ _id: id }, { $set: { state: 'ready', seconds: 9 }, $unset: { uploadId: 1 } });
  simulateConcurrentCosts = true;
  try {
    await call('post', `/jobs/${id}/start`, 'cost-owner').send(settings).expect(202);
    const initial = (await Jobs.findById(id).lean()).reservation.cents;
    const done = await settle(id, ['done', 'failed'], 'cost-owner');
    assert.equal(done.state, 'done', done.error);
    assert.ok(Math.abs(done.costUSD - 0.02) < 1e-8, `charged ${done.costUSD}`);
    assert.ok(Math.abs(done.runCostUSD - 0.02) < 1e-8);
    assert.equal(await held(), 2);
    const stored = await Jobs.findById(id).lean();
    assert.ok(Math.abs(stored.spend.speech - 0.02) < 1e-8);
    assert.ok(stored.reservation.cents > initial, 'the reservation grew for the requests in flight');
    assert.equal((stored.reservation.cents - initial) % 25, 0, 'in 25-cent steps');

    await Jobs.updateOne({ _id: id }, { $set: { state: 'ready' } });
    await call('post', `/jobs/${id}/start`, 'cost-owner').send(settings).expect(202);
    await Budgets.updateOne({ _id: today() }, { $set: { held: 499 } });
    const halted = await settle(id, ['done', 'failed'], 'cost-owner');
    assert.equal(halted.state, 'failed');
    assert.match(halted.error, /reached its processing allowance/);
    assert.equal(await held(), 499 - (await Jobs.findById(id).lean()).reservation.cents);
  } finally {
    simulateConcurrentCosts = false;
  }
  await call('delete', `/jobs/${id}`, 'cost-owner').expect(200);
  await Budgets.deleteMany({});
});

test('voice samples: any short text, cached per voice, speed and text, counted in the allowance', async () => {
  await Budgets.deleteMany({});
  sampleCost = 0.003;
  try {
    const voiced = calls.synthesize;
    const first = await call('post', '/sample', 'sample-owner').send({ voice: 'Voice 1', rate: 1.5, text: 'KOLR\n[10]' }).expect(200);
    assert.equal(first.headers['content-type'], 'audio/wav');
    await call('post', '/sample', 'sample-owner').send({ voice: 'Voice 1', rate: 1.51, text: 'KOLR [10]' }).expect(200);
    assert.equal(calls.synthesize - voiced, 1, 'the same words at the same speed come from the cache');
    assert.equal(await held(), 1, 'the sample is counted against the day');
    await call('post', '/sample', 'sample-owner').send({ voice: 'Voice 1', rate: 1.5, text: '[]' }).expect(400);
    await call('post', '/sample', 'sample-owner').send({ voice: 'Voice 1', rate: 1.5, text: 'x'.repeat(401) }).expect(400);
    await Budgets.updateOne({ _id: today() }, { $set: { held: 500 } });
    const paused = await call('post', '/sample', 'sample-owner').send({ voice: 'Voice 1', rate: 1.5, text: 'KY3' }).expect(409);
    assert.match(paused.body.error, /paused/);
  } finally {
    sampleCost = 0;
  }
  await Budgets.deleteMany({});
});

test('queue: short jobs go ahead of long ones that have not started, and each is told its place', async () => {
  const long = await readyJob('queue-owner', 'queue-upload-long-01', 1200);
  const short = await readyJob('queue-owner', 'queue-upload-short-1', 30);
  await call('post', `/jobs/${long}/start`, 'queue-owner').send(settings).expect(202);
  await call('post', `/jobs/${short}/start`, 'queue-owner').send(settings).expect(202);
  const jobs = (await call('get', '/jobs', 'queue-owner').expect(200)).body.jobs;
  const place = (id) => jobs.find((job) => job.id === id).queuePosition;
  assert.equal(place(short), 0);
  assert.equal(place(long), 1);
  for (const id of [long, short]) {
    await call('post', `/jobs/${id}/cancel`, 'queue-owner').expect(200);
    await call('delete', `/jobs/${id}`, 'queue-owner').expect(200);
  }
  await Budgets.deleteMany({});
});

test('library save: privacy carried, one book id reused after a crash, version titles', async () => {
  const id = await readyJob('shelf-owner', 'shelf-upload-0000001', 30);
  const key = folderOf((await Jobs.findById(id).lean()).key);
  for (const version of [1, 2]) {
    objects.set(`/test/${key}/copies/${version}/described.m4a`, Buffer.from('audio'));
    objects.set(`/test/${key}/copies/${version}/transcript.txt`, Buffer.from('Description: A logo.'));
  }
  await Jobs.updateOne(
    { _id: id },
    {
      $set: {
        state: 'done',
        version: 2,
        source: 'library',
        library: { book: 'a'.repeat(24), track: 0 },
        sourcePrivacy: { shared: false, grownUpsOnly: true, ownerIsActor: true },
        sourcePath: 'Video/Ozarks (Springfield Area)/Local Commercials/1990s',
        about: 'A Meeks ad.',
        copies: [
          { version: 1, settings, outputSeconds: 30, sections: [1], spans: [0, 30] },
          { version: 2, settings, outputSeconds: 30, sections: [2], spans: [0, 30], range: { start: 5, end: 25 } },
        ],
      },
    },
  );
  librarySaveFails = true;
  await call('post', `/jobs/${id}/library`, 'shelf-owner').send({ version: 2 }).expect(500);
  librarySaveFails = false;
  const firstId = libraryCalls.at(-1).id;
  await Jobs.updateOne({ _id: id }, { $unset: { librarySaving: 1 } });
  const saved = (await call('post', `/jobs/${id}/library`, 'shelf-owner').send({ version: 2 }).expect(200)).body;
  const input = libraryCalls.at(-1);
  assert.equal(input.id, firstId, 'a retry reuses the same book id');
  assert.equal(saved.savedToLibrary, firstId);
  assert.equal(input.share, false, 'a private source stays private');
  assert.equal(input.grownUpsOnly, true);
  assert.equal(input.path, 'Audio/Ozarks (Springfield Area)/Local Commercials/1990s');
  assert.equal(input.title, 'episode, 0:05 to 0:25 (described, version 2)');
  assert.equal(input.sourceBook, 'a'.repeat(24));
  assert.equal(input.description, 'A Meeks ad.');
  assert.equal(input.transcript, 'Description: A logo.');
  assert.equal(saved.copies.find((copy) => copy.version === 2).savedToLibrary, firstId);
  const again = (await call('post', `/jobs/${id}/library`, 'shelf-owner').send({ version: 2 }).expect(200)).body;
  assert.equal(again.savedToLibrary, firstId);
  await call('delete', `/jobs/${id}`, 'shelf-owner').expect(200);
});

test('expiry claims before erasing, keeps a record whose files could not be erased, and warns a day ahead once', async () => {
  const expiring = await readyJob('expiry-owner', 'expiry-upload-000001', 30);
  const warned = await readyJob('expiry-owner', 'expiry-upload-000002', 30);
  const key = folderOf((await Jobs.findById(expiring).lean()).key);
  objects.set(`/test/${key}/copies/1/described.mp4`, Buffer.from('video'));
  await Jobs.collection.updateOne({ _id: expiring }, { $set: { state: 'done', expiresAt: new Date(Date.now() - 1000) } });
  await Jobs.collection.updateOne(
    { _id: warned },
    { $set: { state: 'done', expiresAt: new Date(Date.now() + 12 * 3600000), copies: [{ version: 1, settings }] } },
  );
  faults.push({ method: 'DELETE', match: new RegExp(`${expiring}/`), times: 9 });
  process.env.KADE_DESCRIBED_VIDEO = '0';
  try {
    await worker.tick();
    const kept = await Jobs.findById(expiring).lean();
    assert.equal(kept.state, 'deleting', 'the record stays so the files can still be found');
    assert.ok(new Date(kept.expiresAt).getTime() > Date.now() + 50 * 60000);
    assert.ok(keysOf(expiring).length > 0);
    faults.length = 0;
    await Jobs.collection.updateOne({ _id: expiring }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await worker.tick();
    await worker.tick();
  } finally {
    delete process.env.KADE_DESCRIBED_VIDEO;
    faults.length = 0;
  }
  assert.equal(await Jobs.findById(expiring).lean(), null);
  assert.equal(keysOf(expiring).length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  const warnings = notices.filter((item) => item.url.endsWith(warned) && /removed soon/.test(item.title));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].text, /Save it to your Library/);
  await call('delete', `/jobs/${warned}`, 'expiry-owner').expect(200);
});

test('revision helpers: labels, edits, shelves and the script', () => {
  assert.equal(cleanLabel(' Audio​ ‮odd name­ '), 'Audio odd name');
  assert.equal(cleanLabel('family 👨‍👩‍👧'), 'family 👨‍👩‍👧');
  assert.equal(clip('a😀b', 2), 'a😀');
  assert.equal(cleanLabel(clip('x'.repeat(199) + '😀', 200)), 'x'.repeat(199) + '😀');
  assert.equal(libraryPathSchema.parse(' /Audio / Commercials​/1996/ '), 'Audio/Commercials/1996');
  assert.throws(() => libraryPathSchema.parse('Audio//Commercials'));
  assert.throws(() => libraryPathSchema.parse('Audio/../Video'));
  assert.equal(describedShelf('Video/Ozarks (Springfield Area)/Station IDs/1990s'), 'Audio/Ozarks (Springfield Area)/Station IDs/1990s');
  assert.equal(describedShelf('Movies/Films'), defaultLibraryPath);
  assert.equal(matchFolder('audio/commercials/1997', ['Audio/Commercials/1996']), 'Audio/Commercials/1997');
  const [edit] = editsSchema.parse([
    { id: '0:0', text: 'Pat waves.\n\nThen (quietly) leaves & goes.', shortText: 'Pat waves.' },
  ]);
  assert.equal(edit.text, 'Pat waves. Then quietly leaves and goes.');
  assert.throws(() => editsSchema.parse([{ id: '0:0', text: '[]', shortText: 'x' }]));
  const record = (index, start, placements, skipped) => ({
    index,
    start,
    end: start + 60,
    analysis: {
      kind: 'other',
      setting: '',
      people: [],
      speakers: [],
      protectedSounds: [],
      cues: [
        { at: 5, until: 9, text: 'A long description.', shortText: 'Short.', importance: 3 },
        { at: 20, until: 24, text: 'Left out.', shortText: 'Out.', importance: 1 },
      ],
    },
    placements,
    skipped,
    outputSeconds: 70,
    continuity: { kind: '', setting: '', people: [], speakers: [], recent: [] },
  });
  const place = (at, outputAt, text) => ({ at, outputAt, duration: 1, rate: 1.5, text, pauseAt: at, pause: 0, inserted: false, shortened: false, importance: 3 });
  const cues = scriptCues([
    record(1, 60, [place(5, 5, 'A long description.')], [{ at: 80, text: 'Left out.', reason: 'No room.' }]),
    record(0, 0, [place(6, 8, 'Short.')], []),
  ]);
  assert.deepEqual(cues.map((cue) => cue.id), ['0:0', '0:1', '1:0', '1:1']);
  assert.equal(cues[0].spokenText, 'Short.');
  assert.equal(cues[0].outputAt, 8);
  assert.equal(cues[1].spoken, false);
  assert.equal(cues[2].outputAt, 75, 'the second section starts after the output of the first');
  assert.equal(cues[3].reason, 'No room.');
});

/** Loads the LibreChat wrapper with only the app-level modules stubbed; the Library model and parser are real. */
function loadWrapper() {
  const routes = fileURLToPath(new URL('../../../../api/server/routes/', import.meta.url));
  const books = new Map();
  const state = { hooks: null, pushes: 0, copies: [] };
  const stubs = {
    '@librechat/api': {
      initializeS3: () => storage,
      describedVideoPage: () => '',
      registerShutdownTask: () => {},
      createDescriptionRouter: (hooks) => {
        state.hooks = hooks;
        return { router: express.Router(), close: async () => {}, tick: async () => {} };
      },
    },
    '@librechat/data-schemas': { logger: { info() {}, warn() {}, error() {} } },
    '~/server/middleware': { requireJwtAuth: (_req, _res, next) => next() },
    '~/models/kadeUsage': { logKadeUsage: async () => {} },
    './kadePages': { SHARED_HEAD: '' },
    '~/db/models': { User: { findById: () => ({ lean: async () => ({ name: 'Kade Murdock' }) }) } },
    '~/server/services/kadeNudges': {
      sendPushToUser: async () => {
        state.pushes++;
        return 2;
      },
    },
    './kadeReadingRoom': {
      _internals: {
        openBook: async (_req, id) => books.get(id) ?? null,
        refreshListen: (book) => {
          book.stats = { ...(book.stats ?? {}), listen: '1 recording' };
        },
      },
    },
  };
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request in stubs) return stubs[request];
    if (request === '~/models/kadeBook') return original.call(this, join(routes, '../../models/kadeBook.js'), parent, isMain);
    return original.call(this, request, parent, isMain);
  };
  const signals = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') };
  createRequire(import.meta.url)(join(routes, 'kadeDescribedVideo.js'));
  const restore = () => {
    Module._load = original;
    for (const [name, before] of Object.entries(signals))
      for (const listener of process.listeners(name))
        if (!before.includes(listener)) process.removeListener(name, listener);
  };
  return { state, books, restore, model: createRequire(import.meta.url)(join(routes, '../../models/kadeBook.js')) };
}

test('the LibreChat wrapper: library facts and privacy, one idempotent save with a transcript, children refused', async () => {
  const wrapper = loadWrapper();
  try {
    const { hooks } = wrapper.state;
    const { KadeBook, KadeBookText } = wrapper.model;
    const owner = new mongoose.Types.ObjectId();
    assert.equal(hooks.actor({ user: { id: 'u1', role: 'ADMIN', kadeAccountType: 'child' } }).child, true);
    assert.equal(hooks.actor({ user: { id: 'u1', role: 'ADMIN' } }).child, false);
    const original = await KadeBook.create({
      owner: new mongoose.Types.ObjectId(),
      kind: 'video',
      category: 'vhs',
      path: 'Video/Ozarks (Springfield Area)/Station IDs & Sign-offs/1990s',
      title: 'KOLR 10 sign-off',
      meta: { year: 1993, callSign: 'KOLR', network: 'CBS', market: 'Springfield MO' },
      tags: ['sign-off'],
      shared: false,
      grownUpsOnly: true,
      librarian: { identified: 'KOLR-TV 10 sign-off, 1993', confidence: 'high' },
      tracks: [{ key: 'media-library/x/tape.mp4', bytes: 5, mime: 'video/mp4' }],
    });
    const lean = original.toObject();
    wrapper.books.set(String(original._id), { ...lean, title: 'x'.repeat(199) + '😀😀' });
    const req = { user: { id: String(owner), role: 'ADMIN' } };
    const opened = await hooks.library.open(req, String(original._id), 0);
    assert.equal(opened.shared, false);
    assert.equal(opened.grownUpsOnly, true);
    assert.equal(opened.ownerIsActor, false);
    assert.equal(Array.from(opened.title).length, 200);
    assert.ok(!/[\uD800-\uDBFF]$/.test(opened.title), 'no half emoji at the end');
    assert.match(opened.context, /Station: KOLR, CBS/);
    assert.match(opened.context, /Market: Springfield MO/);
    assert.match(opened.context, /librarian identified it as: KOLR-TV 10 sign-off/);
    wrapper.books.set('low', { ...lean, librarian: { identified: 'A guess', confidence: 'low' } });
    assert.doesNotMatch((await hooks.library.open(req, 'low', 0)).context, /A guess/);
    await assert.rejects(hooks.library.open(req, 'missing', 0), (error) => error.status === 404);
    wrapper.books.set('audio', { ...lean, tracks: [{ key: 'k', mime: 'audio/mp4' }] });
    await assert.rejects(hooks.library.open(req, 'audio', 0), (error) => error.status === 400);

    const id = new mongoose.Types.ObjectId().toString();
    let copies = 0;
    const input = {
      id,
      owner: String(owner),
      title: 'KOLR 10 sign-off (described)',
      seconds: 42,
      bytes: 5,
      share: false,
      grownUpsOnly: true,
      kind: 'logo, ident or bumper',
      path: 'Audio/Ozarks (Springfield Area)/Station IDs & Sign-offs/1990s',
      transcript: 'KOLR 10 sign-off (described) described transcript\n\n0:02 Description: The KOLR 10 logo spins.\n',
      sourceBook: String(original._id),
      sourceTrack: 0,
      description: 'The 1993 sign-off.',
      copy: async () => {
        copies++;
      },
    };
    const saved = await hooks.library.save(input);
    assert.equal(saved.id, id);
    const book = await KadeBook.findById(id).lean();
    assert.equal(book.grownUpsOnly, true);
    assert.equal(book.shared, false);
    assert.equal(book.sharedAt, undefined);
    assert.equal(book.category, 'vhs');
    assert.equal(book.meta.callSign, 'KOLR');
    assert.deepEqual(book.meta.describedFrom, { book: String(original._id), track: 0 });
    assert.deepEqual(book.tags, ['sign-off']);
    assert.match(book.description, /^The 1993 sign-off\.\n\nAudio-described copy made by Kade-AI\.$/);
    assert.equal(book.tracks[0].key, `media-library/${id}/described.m4a`);
    assert.equal((await KadeBook.findById(original._id).lean()).meta.describedCopy, id);
    const transcript = await KadeBook.findOne({ 'meta.describedTranscriptOf': id }).lean();
    assert.equal(transcript.kind, 'text');
    assert.equal(transcript.title, 'KOLR 10 sign-off (described), transcript');
    assert.equal(transcript.grownUpsOnly, true);
    assert.equal(transcript.path, input.path);
    assert.ok(await KadeBookText.exists({ book: transcript._id }));
    assert.deepEqual(await hooks.library.save(input), { id, path: input.path }, 'a retry finds the saved book');
    assert.equal(copies, 1, 'and does not copy the audio again');
    assert.equal(await KadeBook.countDocuments({ 'meta.describedTranscriptOf': id }), 1);
    await KadeBook.deleteMany({ _id: { $in: [original._id, id, transcript._id] } });
    await KadeBookText.deleteMany({ book: transcript._id });

    const before = wrapper.state.pushes;
    delete process.env.BRIDGE_SECRET;
    assert.deepEqual(await hooks.notify(String(owner), 'Title', 'Body', '/described-video'), { browser: 2, bridge: 'off' });
    assert.equal(wrapper.state.pushes - before, 1);
  } finally {
    wrapper.restore();
  }
});
