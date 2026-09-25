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
import { createDescriptionWallet } from './wallet.ts';
import { command, decodeVoice } from './media.ts';
import { sampleRate } from './mix.ts';
import { quietSpot, rehearsalProviders } from './rehearsal.ts';
import { transcribe } from './providers.ts';
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
let walletMode = false;
const billing = createDescriptionWallet();
process.env.FFPROBE_PATH = ffprobePath.path;
let mongo, external, service, worker, app, Jobs, Budgets, Locks, storage, root, voiceWav, hooks;
/** Like B2: every write keeps a version, and a delete without a version id only hides the file. */
class Versioned extends Map {
  versions = new Map();
  add(key, entry) {
    const list = this.versions.get(key) ?? [];
    list.push({ id: randomUUID().replaceAll('-', ''), ...entry });
    this.versions.set(key, list);
  }
  set(key, data) {
    this.add(key, { data });
    return super.set(key, data);
  }
  hide(key) {
    this.add(key, { marker: true });
    super.delete(key);
  }
  remove(key, id) {
    const list = (this.versions.get(key) ?? []).filter((entry) => entry.id !== id);
    if (list.length) this.versions.set(key, list);
    else this.versions.delete(key);
    const latest = list.at(-1);
    if (latest && !latest.marker) super.set(key, latest.data);
    else super.delete(key);
  }
}
const objects = new Versioned();
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
let realTranscribe = false;
let simulateConcurrentCosts = false;
let sampleCost = 0;
let beforeEngine = null;
let librarySaveFails = false;
/** When set, each look is billed this many times its $0.05 reserve. */
let overbill = 0;
/** When set ({ started }), the next look holds a $0.35 paid request open until the job's signal aborts it. */
let holdVision = null;
const usageLog = [];
/** Every line the worker logged, parsed, so a test can read the operator's view. */
const logLines = [];
const logged = (from, event) =>
  logLines.slice(from).map((text) => { try { return JSON.parse(text); } catch { return null; } }).filter((entry) => entry?.event === event);
const videos = new Map();
/** The fake proxy's list: flint (Voice 650), dory (Voice 541, Kade's professional clone), a Fish voice, and enough for the favourites cap. */
const catalogVoices = [
  'Voice 1',
  'clear woman · flint',
  'clear high-ish young woman · dory',
  'Kade Murdock',
  ...Array.from({ length: 12 }, (_, i) => `Voice ${i + 2}`),
];

const xml = (res, body, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/xml' });
  res.end(body);
};
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
/** Every version under a prefix, keys in order and each key's newest version first, five to a page. */
function listVersions(res, url, key) {
  const prefix = url.searchParams.get('prefix') || '';
  const bucketName = key.replace(/^\//, '').replace(/\/$/, '');
  const entries = [...objects.versions.entries()]
    .filter(([name]) => name.startsWith(`/${bucketName}/${prefix}`))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([name, list]) =>
      [...list]
        .reverse()
        .map((entry, index) => ({ ...entry, key: name.slice(bucketName.length + 2), latest: index === 0 })),
    );
  const keyMarker = url.searchParams.get('key-marker');
  const versionMarker = url.searchParams.get('version-id-marker');
  const from = keyMarker
    ? entries.findIndex((entry) => entry.key === keyMarker && entry.id === versionMarker) + 1
    : 0;
  const page = entries.slice(from, from + 5);
  const truncated = from + 5 < entries.length;
  const last = page.at(-1);
  const next = truncated
    ? `<NextKeyMarker>${last.key}</NextKeyMarker><NextVersionIdMarker>${last.id}</NextVersionIdMarker>`
    : '';
  const items = page
    .map((entry) =>
      entry.marker
        ? `<DeleteMarker><Key>${entry.key}</Key><VersionId>${entry.id}</VersionId><IsLatest>${entry.latest}</IsLatest></DeleteMarker>`
        : `<Version><Key>${entry.key}</Key><VersionId>${entry.id}</VersionId><IsLatest>${entry.latest}</IsLatest><Size>${entry.data.length}</Size></Version>`,
    )
    .join('');
  return xml(
    res,
    `<ListVersionsResult><Name>${bucketName}</Name><Prefix>${prefix}</Prefix><MaxKeys>5</MaxKeys><IsTruncated>${truncated}</IsTruncated>${next}${items}</ListVersionsResult>`,
  );
}
/** A small S3-compatible store: multipart uploads, ranged get, head, put, copy, list, versions, delete and faults. */
function fakeStorage() {
  return async (req, res) => {
    const url = new URL(req.url, 'http://storage.test');
    const key = decodeURIComponent(url.pathname);
    const uploadId = url.searchParams.get('uploadId');
    storageLog.push({
      method: req.method,
      key,
      range: req.headers.range,
      uploadId,
      versions: url.searchParams.has('versions'),
      versionId: url.searchParams.get('versionId'),
    });
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
    if (req.method === 'GET' && url.searchParams.has('versions')) return listVersions(res, url, key);
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
      const versionId = url.searchParams.get('versionId');
      if (uploadId) uploads.delete(uploadId);
      else if (versionId) objects.remove(key, versionId);
      else objects.hide(key);
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
          voices: catalogVoices,
          describe: { 'Voice 1': 'Test voice' },
          categories: [{ name: 'Test', voices: ['Voice 1', 'clear woman · flint'] }],
          renames: { 'Voice 541': 'clear high-ish young woman · dory', 'Voice 650': 'clear woman · flint', 'Voice 652': 'Kade Murdock' },
          fish: ['Kade Murdock'],
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
  hooks = {
    get wallet() { return walletMode ? billing : undefined; },
    auth: (req, res, next) => (req.headers['x-user'] ? next() : res.sendStatus(401)),
    actor: (req) => ({
      id: String(req.headers['x-user']),
      role: req.headers['x-role'] === 'user' ? 'USER' : 'ADMIN',
      child: req.headers['x-child'] === '1',
    }),
    storage: () => storage,
    log: (message) => logLines.push(message),
    usage: async (owner, job, kind, costUSD) => {
      usageLog.push({ owner, job, kind, costUSD });
    },
    notify: async (owner, title, text, url, detail) => {
      notices.push({ owner, title, text, url, detail });
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
      transcribe: async (file, seconds, signal, meter) => {
        if (realTranscribe) return transcribe(file, seconds, signal, meter);
        calls.transcribe++;
        return [{ start: 0.2, end: 0.9, word: 'Hello.', speaker: 0 }];
      },
      analyze: async (look, _signal, meter) => {
        calls.analyze++;
        if (failSection === calls.analyze || (failLaterSections && look.state))
          throw axiosFailure(402);
        if (holdVision && !look.brief.survey) {
          const hold = holdVision;
          holdVision = null;
          await meter('vision', 0.35, () =>
            new Promise((_resolve, reject) => {
              /* What axios throws when the request's own signal aborts it. */
              const cut = () =>
                reject(Object.assign(new Error('canceled'), { name: 'CanceledError', isAxiosError: true, code: 'ERR_CANCELED' }));
              if (_signal.aborted) return cut();
              _signal.addEventListener('abort', cut, { once: true });
              hold.started();
            }),
          );
        }
        if (refuseSection === look.brief.position?.index && !look.brief.survey)
          await meter('vision', 0.2, async () => {
            throw axiosFailure(429);
          });
        if (overbill && !look.brief.survey)
          await meter('vision', 0.05, async () => ({ costUSD: 0.05 * overbill }));
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
    get wallet() { return walletMode ? billing : undefined; },
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
/** Stored versions and delete markers left anywhere under a job, hidden or not. */
const versionsOf = (id) =>
  [...objects.versions.entries()].filter(([key]) => key.includes(id)).flatMap(([, list]) => list);
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

test('a Deepgram account problem reaches her in words that name it', async () => {
  const axios = createRequire(import.meta.url)('axios');
  const previous = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    if (!/deepgram\.com/.test(config.url)) return axios.getAdapter(previous)(config);
    config.data?.destroy?.();
    throw new axios.AxiosError('Request failed with status code 402', 'ERR_BAD_REQUEST', config, {}, {
      status: 402,
      statusText: '',
      headers: {},
      data: {},
      config,
    });
  };
  realTranscribe = true;
  try {
    const id = await readyJob('deepgram-owner', 'deepgram-upload-01', 30);
    await call('post', `/jobs/${id}/start`, 'deepgram-owner').send(settings).expect(202);
    const stopped = await settle(id, ['failed', 'done'], 'deepgram-owner');
    assert.equal(stopped.state, 'failed');
    assert.equal(stopped.error, 'Dialogue timing (Deepgram) needs its account balance topped up (HTTP 402).');
    assert.match(notices.filter((notice) => notice.owner === 'deepgram-owner').at(-1).text, /topped up/);
    await call('delete', `/jobs/${id}`, 'deepgram-owner').expect(200);
  } finally {
    realTranscribe = false;
    axios.defaults.adapter = previous;
  }
});

test('authenticated adult testers have access; authentication and child restrictions still apply', async () => {
  await request(app).get('/jobs').expect(401);
  await call('get', '/jobs').set('x-role', 'user').expect(200);
  process.env.KADE_DESCRIPTION_PUBLIC = '0';
  await call('get', '/jobs').set('x-role', 'user').expect(403);
  delete process.env.KADE_DESCRIPTION_PUBLIC;
  const child = await call('get', '/jobs').set('x-child', '1').expect(403);
  assert.match(child.body.error, /children/);
  const config = (await call('get', '/config').expect(200)).body;
  assert.equal(config.limitUSD, 5);
  assert.equal(config.voicesAvailable, true);
  assert.deepEqual(config.voices, catalogVoices);
  assert.equal(config.defaultVoice, 'clear high-ish young woman · dory', 'Kade’s professional voice reads until she chooses');
  assert.equal(config.categories[0].name, 'Test');
  assert.equal(config.perMinuteUSD.rich, config.perMinuteUSD.essential, 'extra narration is included');
  assert.deepEqual(config.extrasPerMinuteUSD, { closeLook: 0.025, firstLook: 0.021 });
  assert.deepEqual(config.setAside, { factor: 1.1, extraUSD: 0.05 });
  assert.deepEqual(config.approval, { factor: 1.5, extraUSD: 0.1 });
  assert.deepEqual(config.keep, { days: 7, maxDays: 30 });
  assert.equal(config.rehearsal, true, 'the administrator can rehearse for free');
  assert.equal(config.previewSeconds, 60);
  assert.equal(config.maxMinutes, 90);
  assert.equal(config.maxSourceMinutes, 360);
  assert.equal(config.remainingUSD, 5);
});

const dory = 'clear high-ish young woman · dory';
const flint = 'clear woman · flint';
const prefsRow = (owner) => mongoose.models.KadeDescriptionPrefs.findById(owner).lean();

test('narrators: Kade’s professional voice reads until she chooses; her default and favourites follow her, old spellings too', async () => {
  const fresh = (await call('get', '/config', 'narrator-a').expect(200)).body;
  assert.equal(fresh.houseVoice, dory, 'Voice 541 is found through renames');
  assert.equal(fresh.defaultVoice, dory);
  assert.equal(fresh.myDefaultVoice, null);
  assert.deepEqual(fresh.suggested, [dory, flint], 'the seed list, in order, keeping only listed Inworld voices');
  assert.deepEqual(fresh.fish, ['Kade Murdock']);
  assert.match(fresh.fishNote, /sped up/);
  assert.deepEqual(fresh.favorites, []);
  assert.deepEqual(fresh.recent, []);
  assert.equal(fresh.maxFavorites, 12);
  assert.equal(fresh.curate, true, 'the administrator can curate');
  const member = (await call('get', '/config', 'narrator-a').set('x-role', 'user').expect(200)).body;
  assert.equal(member.curate, undefined);
  assert.deepEqual(member.suggested, [dory, flint]);

  const wrong = await call('post', '/prefs/default', 'narrator-a').send({ voice: 'Not a voice' }).expect(400);
  assert.equal(wrong.body.field, 'voice');
  await call('post', '/prefs/default', 'narrator-a').send({}).expect(400);
  const chosen = (await call('post', '/prefs/default', 'narrator-a').send({ voice: 'Voice 1' }).expect(200)).body;
  assert.equal(chosen.defaultVoice, 'Voice 1');
  assert.equal(chosen.myDefaultVoice, 'Voice 1');
  assert.equal(chosen.houseVoice, dory);
  assert.equal((await call('get', '/config', 'narrator-a').expect(200)).body.defaultVoice, 'Voice 1');
  assert.equal((await call('get', '/config', 'narrator-b').expect(200)).body.defaultVoice, dory, 'another person still gets the house voice');
  assert.equal((await call('get', '/prefs', 'narrator-a').expect(200)).body.defaultVoice, 'Voice 1');

  const old = (await call('post', '/prefs/default', 'narrator-a').send({ voice: 'Voice 650' }).expect(200)).body;
  assert.equal(old.myDefaultVoice, flint, 'an old spelling is saved and shown as its current label');
  await call('post', '/prefs/default', 'narrator-a').send({ voice: dory }).expect(200);
  assert.equal((await prefsRow('narrator-a')).voice, 'Voice 541', 'the stable number is stored, so a relabel cannot lose it');
  const cleared = (await call('post', '/prefs/default', 'narrator-a').send({ voice: null }).expect(200)).body;
  assert.equal(cleared.myDefaultVoice, null);
  assert.equal(cleared.defaultVoice, dory);

  const star = (voice, favorite = true, owner = 'narrator-a') =>
    call('post', '/prefs/favorites', owner).send({ voice, favorite });
  await star('Voice 1').expect(200);
  assert.deepEqual((await star('Voice 1').expect(200)).body.favorites, ['Voice 1'], 'starred twice, kept once');
  await star('Voice 650').expect(200);
  assert.deepEqual((await star(flint).expect(200)).body.favorites, ['Voice 1', flint], 'two spellings of one voice are one favourite');
  assert.deepEqual((await star(flint, false).expect(200)).body.favorites, ['Voice 1']);
  assert.deepEqual((await prefsRow('narrator-a')).favorites, ['Voice 1'], 'un-starring removes every spelling');
  await star('Not a voice').expect(400);
  assert.deepEqual((await star('Not a voice', false).expect(200)).body.favorites, ['Voice 1'], 'un-starring something unknown is harmless');
  await call('post', '/prefs/favorites', 'narrator-a').send({ voice: 'Voice 1' }).expect(400);

  for (let n = 2; n <= 12; n++) await star(`Voice ${n}`).expect(200);
  assert.equal((await call('get', '/config', 'narrator-a').expect(200)).body.favorites.length, 12);
  const full = await star('Voice 13').expect(409);
  assert.match(full.body.error, /up to 12 favourite narrators\. Remove one first\./);
  assert.equal((await star('Voice 12').expect(200)).body.favorites.length, 12, 'starring one already kept is not refused');
  await star('Voice 2', false).expect(200);
  assert.equal((await star('Voice 13').expect(200)).body.favorites.at(-1), 'Voice 13');
  assert.equal((await call('get', '/config', 'narrator-b').expect(200)).body.favorites.length, 0, 'favourites are per person');
  await call('post', '/prefs/default', 'narrator-a').set('x-child', '1').send({ voice: 'Voice 1' }).expect(403);
});

test('narrators: a retired voice falls back to the house voice; old spellings in her lists map to today’s labels', async () => {
  await mongoose.models.KadeDescriptionPrefs.collection.insertOne({
    _id: 'stale-owner',
    voice: 'retired · quill',
    favorites: ['Voice 650', 'Voice 1', 'gone · wren', 'clear woman · flint'],
    recent: ['Voice 541', 'retired · quill', dory],
  });
  const config = (await call('get', '/config', 'stale-owner').expect(200)).body;
  assert.equal(config.myDefaultVoice, null);
  assert.equal(config.defaultVoice, dory);
  assert.deepEqual(config.favorites, [flint, 'Voice 1']);
  assert.deepEqual(config.recent, [dory]);
});

test('narrators: KADE_DESCRIPTION_HOUSE_VOICE chooses the house voice, skipping names that are not listed', async () => {
  try {
    process.env.KADE_DESCRIPTION_HOUSE_VOICE = 'Voice 999';
    assert.equal((await call('get', '/config', 'house-owner').expect(200)).body.houseVoice, flint, 'flint when nothing named is listed');
    process.env.KADE_DESCRIPTION_HOUSE_VOICE = 'Voice 999, Voice 652';
    const config = (await call('get', '/config', 'house-owner').expect(200)).body;
    assert.equal(config.houseVoice, 'Kade Murdock');
    assert.equal(config.defaultVoice, 'Kade Murdock');
  } finally {
    delete process.env.KADE_DESCRIPTION_HOUSE_VOICE;
  }
  assert.equal((await call('get', '/config', 'house-owner').expect(200)).body.houseVoice, dory);
});

test('narrators: only the administrator curates Good for describing; the first change starts from the seed, Fish voices stay off', async () => {
  const suggest = (voice, suggested, role) => {
    const r = call('post', '/prefs/suggested', 'curator').send({ voice, suggested });
    return role ? r.set('x-role', role) : r;
  };
  try {
    const refused = await suggest('Voice 1', true, 'user').expect(403);
    assert.match(refused.body.error, /Only the administrator/);
    assert.deepEqual((await suggest('Voice 1', true).expect(200)).body.suggested, [dory, flint, 'Voice 1']);
    assert.deepEqual((await suggest('Voice 650', false).expect(200)).body.suggested, [dory, 'Voice 1'], 'an old spelling removes the voice');
    const fish = await suggest('Kade Murdock', true).expect(400);
    assert.match(fish.body.error, /Fish voices sound less natural sped up/);
    await suggest('Not a voice', true).expect(400);
    await suggest(dory, false).expect(200);
    assert.deepEqual((await suggest('Voice 1', false).expect(200)).body.suggested, [], 'an emptied list stays empty instead of going back to the seed');
    assert.deepEqual((await call('get', '/config', 'anyone').set('x-role', 'user').expect(200)).body.suggested, []);
    assert.deepEqual((await suggest('Voice 541', true).expect(200)).body.suggested, [dory]);
    assert.deepEqual((await prefsRow('__describing__')).suggested, ['Voice 541']);
  } finally {
    await mongoose.models.KadeDescriptionPrefs.deleteOne({ _id: '__describing__' });
  }
});

test('narrators: a run that names no voice starts with her default, or the house voice; every run joins Recently used', async () => {
  await Budgets.deleteMany({});
  const { voice: _unused, ...unvoiced } = settings;
  try {
    await call('post', '/prefs/default', 'narrator-start').send({ voice: 'Voice 2' }).expect(200);
    const mine = await readyJob('narrator-start', 'narrator-upload-000001', 30);
    const started = (await call('post', `/jobs/${mine}/start`, 'narrator-start').send(unvoiced).expect(202)).body;
    assert.equal(started.settings.voice, 'Voice 2');
    assert.deepEqual((await call('get', '/config', 'narrator-start').expect(200)).body.recent, ['Voice 2']);
    await call('post', `/jobs/${mine}/cancel`, 'narrator-start').expect(200);

    const house = await readyJob('narrator-house', 'narrator-upload-000002', 30);
    const housed = (await call('post', `/jobs/${house}/start`, 'narrator-house').send({ ...unvoiced, voice: '' }).expect(202)).body;
    assert.equal(housed.settings.voice, dory, 'nobody chose, so Kade’s professional voice reads');
    await call('post', `/jobs/${house}/cancel`, 'narrator-house').expect(200);

    const spelled = await readyJob('narrator-house', 'narrator-upload-000003', 30);
    const renamed = (await call('post', `/jobs/${spelled}/start`, 'narrator-house').send({ ...unvoiced, voice: 'Voice 650' }).expect(202)).body;
    assert.equal(renamed.settings.voice, flint, 'an old spelling starts with the voice it now names');
    assert.deepEqual((await call('get', '/config', 'narrator-house').expect(200)).body.recent, [flint, dory]);
    assert.deepEqual((await prefsRow('narrator-house')).recent, ['Voice 650', 'Voice 541']);
    await call('post', `/jobs/${spelled}/cancel`, 'narrator-house').expect(200);
    for (const [owner, id] of [['narrator-start', mine], ['narrator-house', house], ['narrator-house', spelled]])
      await call('delete', `/jobs/${id}`, owner).expect(200);
  } finally {
    await Budgets.deleteMany({});
  }
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

  const second = await readyJob('another-owner', 'paid-upload-00000002', 5400);
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
  assert.match(notices.at(-1).text, /Open Make a described video on the website or the app\.$/);
  assert.equal(notices.at(-1).url, `/described-video?id=${id}`);
  assert.deepEqual(notices.at(-1).detail, { job: id, kind: 'ready' }, 'the phone push knows its job');
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
  assert.equal(versionsOf(id).length, 0, 'no older version or delete marker is left to bill');
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
  let started;
  beforeEngine = async () => {
    const job = await Jobs.findById(id).lean();
    started = { progress: job.progress, runFrom: job.runFrom };
  };
  let finished;
  try {
    const queued = await call('post', `/jobs/${id}/finish`, 'preview-owner').send({}).expect(202);
    assert.equal(
      queued.body.progress,
      0,
      'the finished preview does not leave the new run at 100 percent',
    );
    finished = await settle(id, ['done', 'failed'], 'preview-owner');
  } finally {
    beforeEngine = null;
  }
  assert.ok(
    started.progress < 25 && started.runFrom < 25,
    `the run started at ${started.progress} percent`,
  );
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

test('a preview that turns out to cover the whole video is kept as the finished copy', async () => {
  await Budgets.deleteMany({});
  const id = await readyJob('whole-owner', 'whole-preview-upload1', 100);
  await call('post', `/jobs/${id}/start`, 'whole-owner')
    .send({ ...settings, preview: true })
    .expect(202);
  assert.equal((await Jobs.findById(id).lean()).stopAfter, 60);
  const done = await settle(id, ['done', 'failed'], 'whole-owner');
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.preview, false);
  assert.equal(done.finishable, false);
  assert.equal(done.stage, 'Your described copy is ready');
  assert.deepEqual(
    done.copies.map((copy) => [copy.version, copy.preview]),
    [[1, false]],
  );
  assert.equal((await Jobs.findById(id).lean()).stopAfter, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notices.at(-1).title, 'Your described video is ready');
  await call('post', `/jobs/${id}/finish`, 'whole-owner').send({}).expect(409);
  await Jobs.updateOne({ _id: id }, { $set: { preview: true, 'copies.0.preview': true } });
  const covered = await call('post', `/jobs/${id}/finish`, 'whole-owner').send({}).expect(409);
  assert.match(
    covered.body.error,
    /already covers the whole video/,
    'a copy stored with the old label is not finished again',
  );
  await call('delete', `/jobs/${id}`, 'whole-owner').expect(200);
});

test('a part of a long video is cut once: later runs download the kept part, not the whole source', async () => {
  await Budgets.deleteMany({});
  const id = await readyJob('part-owner', 'part-upload-000000001', 150);
  await call('post', `/jobs/${id}/start`, 'part-owner')
    .send({ ...settings, range: { start: 10, end: 100 } })
    .expect(202);
  const done = await settle(id, ['done', 'failed'], 'part-owner');
  assert.equal(done.state, 'done', done.error);
  assert.ok(!requests.at(-1).workingCopy);
  const job = await Jobs.findById(id).lean();
  const kept = `/test/${folderOf(job.key)}/working/10000-100000.mkv`;
  assert.ok(objects.has(kept), 'the cut part is kept');
  storageLog.length = 0;
  await call('post', `/jobs/${id}/revoice`, 'part-owner')
    .send({ rate: 2, maxRate: 2.5 })
    .expect(202);
  const revoiced = await settle(id, ['done', 'failed'], 'part-owner');
  assert.equal(revoiced.state, 'done', revoiced.error);
  assert.equal(requests.at(-1).workingCopy, true);
  const reads = storageLog.filter((item) => item.method === 'GET');
  assert.ok(reads.some((item) => item.key === kept));
  assert.ok(
    !reads.some((item) => item.key === `/test/${job.key}`),
    'the whole source was not downloaded again',
  );
  assert.ok(Math.abs(revoiced.outputSeconds - 90) < 0.5);
  await call('delete', `/jobs/${id}`, 'part-owner').expect(200);
  assert.equal(keysOf(id).length, 0);
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
  const lookedBefore = calls.analyze;
  await call('post', `/jobs/${id}/revoice`, 'redo-owner').send({ rate: 2, maxRate: 2.5 }).expect(202);
  const revoiced = await settle(id, ['done', 'failed'], 'redo-owner');
  assert.equal(revoiced.state, 'done', revoiced.error);
  assert.equal(calls.analyze, lookedBefore, 'a re-voice never pays to look at the picture again');
  assert.equal(revoiced.failedSections, 1, 'and keeps the gap for a redo');
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
    assert.equal(priced.breakdown.speech, 0, 'narration is included');
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

test('a heartbeat still in flight when a run ends cannot stop the next run of the same video', async () => {
  await Budgets.deleteMany({});
  const id = await readyJob('beat-owner', 'beat-upload-00000001', 150);
  const original = Jobs.findById;
  Jobs.findById = function (filter, projection, ...rest) {
    const query = original.call(this, filter, projection, ...rest);
    if (filter !== id || !projection?.cancelRequested) return query;
    return { lean: () => new Promise((resolve) => setTimeout(() => resolve(query.lean()), 300)) };
  };
  try {
    failSection = calls.analyze + 1;
    await call('post', `/jobs/${id}/start`, 'beat-owner').send(settings).expect(202);
    const stopped = await settle(id, ['failed', 'done'], 'beat-owner');
    assert.equal(stopped.state, 'failed');
    failSection = -1;
    await call('post', `/jobs/${id}/resume`, 'beat-owner').send({}).expect(202);
    const done = await settle(id, ['failed', 'done'], 'beat-owner');
    assert.equal(done.state, 'done', done.error);
  } finally {
    Jobs.findById = original;
    failSection = -1;
  }
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal((await Jobs.findById(id).lean()).state, 'done', 'no late watchdog settles a finished run');
  await call('delete', `/jobs/${id}`, 'beat-owner').expect(200);
  await Budgets.deleteMany({});
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

test('voice samples: the picker’s listen-as-you-move has its own hourly allowance; a voice already heard plays free', async () => {
  await Budgets.deleteMany({});
  process.env.KADE_DESCRIPTION_AUDITIONS_PER_HOUR = '2';
  try {
    const voiced = calls.synthesize;
    const hear = (voice, extra = {}) =>
      call('post', '/sample', 'audition-owner').send({ voice, rate: 2, audition: true, ...extra });
    await hear('Voice 3').expect(200);
    await hear('Voice 4').expect(200);
    const quiet = await hear('Voice 5').expect(409);
    assert.match(quiet.body.error, /quiet for now\. Picking a voice still works/);
    await hear('Voice 3').expect(200);
    assert.equal(calls.synthesize - voiced, 2, 'a voice already heard comes from the cache');
    await call('post', '/sample', 'audition-owner').send({ voice: 'Voice 5', rate: 2 }).expect(200);
    await hear('Voice 6', { text: 'Meeks Lumber' }).expect(200);
    assert.equal(calls.synthesize - voiced, 4, 'typed words and the sample buttons keep their own allowance');
    await call('post', '/sample', 'another-listener').send({ voice: 'Voice 7', rate: 2, audition: true }).expect(200);
  } finally {
    delete process.env.KADE_DESCRIPTION_AUDITIONS_PER_HOUR;
    await Budgets.deleteMany({});
  }
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
  assert.equal(versionsOf(expiring).length, 0, 'expiry leaves no version or delete marker');
  await new Promise((resolve) => setImmediate(resolve));
  const warnings = notices.filter((item) => item.url.endsWith(warned) && /removed soon/.test(item.title));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].text, /Save it to your Library, or press Keep 7 more days\./);
  assert.match(warnings[0].text, /Open Make a described video on the website or the app\.$/);
  assert.deepEqual(warnings[0].detail, { job: warned, kind: 'expiring' });
  await call('delete', `/jobs/${warned}`, 'expiry-owner').expect(200);
});

test('the price she approves is a limit: a run billed nine times over stops and asks, and Continue can raise it once', async () => {
  await Budgets.deleteMany({});
  const id = await readyJob('quote-owner', 'quote-upload-0000001', 150);
  const price = (await call('post', `/jobs/${id}/estimate`, 'quote-owner').send({ action: 'start', settings }).expect(200)).body;
  assert.equal(price.approvedUSD, Math.min(5, Math.ceil((price.estimateUSD * 1.5 + 0.1) * 100 - 1e-6) / 100));
  const usageBefore = usageLog.length;
  overbill = 9;
  try {
    await call('post', `/jobs/${id}/start`, 'quote-owner').send(settings).expect(202);
    assert.equal((await Jobs.findById(id).lean()).approvedUSD, price.approvedUSD);
    const stopped = await settle(id, ['failed', 'done'], 'quote-owner');
    assert.equal(stopped.state, 'failed', 'it stopped instead of finishing at nine times the price');
    assert.equal(stopped.overQuote, true);
    assert.equal(stopped.resumable, true);
    assert.equal(stopped.approvedUSD, price.approvedUSD);
    assert.ok(stopped.runCostUSD > price.approvedUSD, 'the stop came after the charges passed the approval');
    assert.ok(stopped.runCostUSD <= price.approvedUSD + 0.45 + 1e-9, 'and no more than one request later');
    assert.ok(
      usageLog.slice(usageBefore).every((item) => item.costUSD === 0.45),
      'every request it made was booked at what it cost',
    );
    const ask = (await call('post', `/jobs/${id}/estimate`, 'quote-owner').send({ action: 'resume' }).expect(200)).body;
    assert.ok(ask.approvedUSD > Math.ceil((ask.estimateUSD * 1.5 + 0.1) * 100 - 1e-6) / 100, 'the ask allows for the real rate');
    assert.ok(ask.approvedUSD <= 5);
    const spent = `\\$${stopped.runCostUSD.toFixed(2)}`;
    const quoted = `\\$${price.estimateUSD.toFixed(2)}`;
    assert.match(
      stopped.error,
      new RegExp(`^This is costing more than quoted: ${spent} spent of about ${quoted}\\. Continue up to \\$${ask.approvedUSD.toFixed(2)} more\\? Finished sections are kept\\.$`),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const notice = notices.at(-1);
    assert.equal(notice.title, 'Your described video needs your OK');
    assert.ok(notice.text.includes(stopped.error));
    assert.match(notice.text, /Open Make a described video on the website or the app\.$/);
    assert.ok(notice.text.length <= 300);
    assert.deepEqual(notice.detail, { job: id, kind: 'over-quote' });

    const tooMuch = await call('post', `/jobs/${id}/resume`, 'quote-owner').send({ allowUpToUSD: 5.01 }).expect(400);
    assert.equal(tooMuch.body.field, 'allowUpToUSD');
    assert.match(tooMuch.body.error, /up to \$5\.00 for one run/);
    await call('post', `/jobs/${id}/resume`, 'quote-owner').send({ allowUpToUSD: 'lots' }).expect(400);
    assert.equal((await Jobs.findById(id).lean()).state, 'failed');
    const resumed = (await call('post', `/jobs/${id}/resume`, 'quote-owner').send({ allowUpToUSD: ask.approvedUSD }).expect(202)).body;
    assert.equal(resumed.approvedUSD, ask.approvedUSD, 'the raised approval holds for this run');
    assert.equal(resumed.overQuote, false);
    assert.equal((await Jobs.findById(id).lean()).overQuote, undefined);
    const done = await settle(id, ['failed', 'done'], 'quote-owner');
    assert.equal(done.state, 'done', done.error);
    assert.ok(done.runCostUSD <= ask.approvedUSD + 0.45 + 1e-9);
  } finally {
    overbill = 0;
  }
  assert.deepEqual((await Budgets.findById(today()).lean()).runs, [], 'both runs gave back what they did not spend');
  await call('delete', `/jobs/${id}`, 'quote-owner').expect(200);
  await Budgets.deleteMany({});
});

test('a free rehearsal runs the real pipeline and storage with stand-ins, costs nothing, and leaves the video ready', async () => {
  await Budgets.deleteMany({});
  await Budgets.create({ _id: today(), held: 12, runs: ['other-run'] });
  const id = await readyJob('rehearsal-owner', 'rehearsal-upload-001', 30, { name: 'KOLR sign-off.mp4' });
  process.env.KADE_DESCRIPTION_PUBLIC = '1';
  try {
    const config = await call('get', '/config', 'rehearsal-owner').set('x-role', 'user').expect(200);
    assert.equal(config.body.rehearsal, undefined, 'only the administrator sees the rehearsal');
    const refused = await call('post', `/jobs/${id}/rehearse`, 'rehearsal-owner').set('x-role', 'user').send({}).expect(403);
    assert.match(refused.body.error, /administrator/);
  } finally {
    delete process.env.KADE_DESCRIPTION_PUBLIC;
  }
  const before = { ...calls, usage: usageLog.length };
  const queued = (await call('post', `/jobs/${id}/rehearse`, 'rehearsal-owner').send({ volume: 'louder' }).expect(202)).body;
  assert.equal(queued.setAsideUSD, 0);
  assert.equal(queued.estimatedUSD, 0);
  assert.deepEqual(await Budgets.findById(today()).lean().then((budget) => [budget.held, budget.runs]), [12, ['other-run']]);
  const ready = await settle(id, ['ready', 'failed', 'done'], 'rehearsal-owner');
  assert.equal(ready.state, 'ready', 'a rehearsal leaves the video ready to describe');
  assert.equal(ready.error, '');
  assert.equal(ready.costUSD, 0);
  assert.equal(ready.copies.length, 1);
  assert.equal(ready.copies[0].rehearsal, true);
  assert.equal(ready.copies[0].settings.volume, 'louder');
  assert.equal(ready.abandonable, false);
  assert.equal(ready.keepable, false);
  assert.deepEqual(
    [calls.analyze, calls.transcribe, calls.synthesize, usageLog.length],
    [before.analyze, before.transcribe, before.synthesize, before.usage],
    'no provider and no usage was touched',
  );
  const budget = await Budgets.findById(today()).lean();
  assert.deepEqual([budget.held, budget.runs], [12, ['other-run']], 'the allowance never moved');
  await new Promise((resolve) => setImmediate(resolve));
  const notice = notices.at(-1);
  assert.equal(notice.title, 'Rehearsal finished');
  assert.match(notice.text, /^KOLR sign-off: .* with 1 description\. Made with a test tone, at no cost\. Open Make a described video on the website or the app\.$/);
  assert.deepEqual(notice.detail, { job: id, kind: 'rehearsal' });
  const version = ready.copies[0].version;
  const files = (await call('get', `/jobs/${id}/files?version=${version}`, 'rehearsal-owner').expect(200)).body;
  assert.ok(files.video && files.audio && files.transcript);
  assert.ok(objects.get(`/test/${folderOf((await Jobs.findById(id).lean()).key)}/copies/${version}/described.m4a`).length > 1000);
  const transcript = await call('get', `/jobs/${id}/text/transcript?version=${version}`, 'rehearsal-owner').expect(200);
  assert.match(transcript.text, /Description: Rehearsal description 1\./);
  const script = (await call('get', `/jobs/${id}/script?version=${version}`, 'rehearsal-owner').expect(200)).body;
  assert.deepEqual(script.cues.map((cue) => [cue.text, cue.spoken]), [['Rehearsal description 1.', true]]);
  const shelf = await call('post', `/jobs/${id}/library`, 'rehearsal-owner').send({ version }).expect(409);
  assert.match(shelf.body.error, /rehearsal copy/);

  const price = (await call('post', `/jobs/${id}/estimate`, 'rehearsal-owner').send({ action: 'start', settings }).expect(200)).body;
  assert.ok(price.allowed && price.breakdown.dialogue > 0, 'the paid run still pays for its own dialogue timing');
  await call('post', `/jobs/${id}/start`, 'rehearsal-owner').send(settings).expect(202);
  const real = await settle(id, ['done', 'failed'], 'rehearsal-owner');
  assert.equal(real.state, 'done', real.error);
  assert.equal(calls.transcribe - before.transcribe, 1, 'the made-up words of the rehearsal were not reused');
  assert.deepEqual(real.copies.map((copy) => [copy.version, copy.rehearsal]), [[version, true], [version + 1, false]]);
  assert.equal(real.version, version + 1);
  const saved = await call('post', `/jobs/${id}/library`, 'rehearsal-owner').send({ share: false }).expect(200);
  assert.equal(libraryCalls.at(-1).title, 'KOLR sign-off (described)', 'the first real copy is not called version 2');
  assert.ok(saved.body.savedToLibrary);
  await call('delete', `/jobs/${id}`, 'rehearsal-owner').expect(200);
  assert.equal(versionsOf(id).length, 0);
  await Budgets.deleteMany({});
});

test('a rehearsal that is cancelled or stops goes back to ready, never to a paid state', async () => {
  const id = await readyJob('rehearsal-owner', 'rehearsal-upload-002', 30);
  await call('post', `/jobs/${id}/rehearse`, 'rehearsal-owner').send({}).expect(202);
  const cancelled = (await call('post', `/jobs/${id}/cancel`, 'rehearsal-owner').expect(200)).body;
  assert.equal(cancelled.state, 'ready');
  assert.equal(cancelled.error, '');
  faults.push({ method: 'GET', match: new RegExp(`${id}/source$`), times: 20 });
  try {
    await call('post', `/jobs/${id}/rehearse`, 'rehearsal-owner').send({}).expect(202);
    const stopped = await settle(id, ['ready', 'failed', 'done', 'cancelled'], 'rehearsal-owner');
    assert.equal(stopped.state, 'ready');
    assert.match(stopped.error, /^The rehearsal stopped: /);
    assert.equal(stopped.resumable, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(notices.at(-1).title, 'Rehearsal stopped');
  } finally {
    faults.length = 0;
  }
  await call('delete', `/jobs/${id}`, 'rehearsal-owner').expect(200);
});

test('Keep 7 more days extends a finished copy a week at a time, up to a month from now', async () => {
  const id = await readyJob('keep-owner', 'keep-upload-00000001', 30);
  const early = await call('post', `/jobs/${id}/keep`, 'keep-owner').expect(409);
  assert.match(early.body.error, /Only a finished described copy/);
  const soon = new Date(Date.now() + 2 * 86400000);
  await Jobs.updateOne(
    { _id: id },
    { $set: { state: 'done', expiresAt: soon, expiryWarned: true, copies: [{ version: 1, settings, sections: [], spans: [0, 30] }] } },
  );
  assert.equal((await call('get', `/jobs/${id}`, 'keep-owner').expect(200)).body.keepable, true);
  const kept = (await call('post', `/jobs/${id}/keep`, 'keep-owner').expect(200)).body;
  assert.equal(new Date(kept.expiresAt).getTime(), soon.getTime() + 7 * 86400000);
  assert.equal((await Jobs.findById(id).lean()).expiryWarned, undefined, 'a new warning will come before the new date');
  for (let i = 0; i < 5; i++) await call('post', `/jobs/${id}/keep`, 'keep-owner');
  const capped = (await call('get', `/jobs/${id}`, 'keep-owner').expect(200)).body;
  const left = new Date(capped.expiresAt).getTime() - Date.now();
  assert.ok(left <= 30 * 86400000 && left > 29.9 * 86400000, 'never more than a month from now');
  assert.equal(capped.keepable, false);
  const refused = await call('post', `/jobs/${id}/keep`, 'keep-owner').expect(409);
  assert.match(refused.body.error, /the longest a copy is kept/);
  await call('delete', `/jobs/${id}`, 'keep-owner').expect(200);
});

test('a Library video she already has returns that job instead of starting another', async () => {
  const ask = (owner, requestId, track = 3) =>
    call('post', '/library-imports', owner).send({ requestId, book: 'a'.repeat(24), track });
  const first = (await ask('repeat-owner', 'library-repeat-00001').expect(202)).body;
  assert.equal(first.existing, false);
  const retried = (await ask('repeat-owner', 'library-repeat-00001').expect(202)).body;
  assert.equal(retried.id, first.id);
  assert.equal(retried.existing, false, 'the same request repeated is not an earlier video');
  const again = (await ask('repeat-owner', 'library-repeat-00002').expect(200)).body;
  assert.equal(again.existing, true);
  assert.equal(again.id, first.id);
  assert.equal(again.state, 'checking');
  const otherTrack = (await ask('repeat-owner', 'library-repeat-00003', 4).expect(202)).body;
  assert.notEqual(otherTrack.id, first.id);
  const otherOwner = (await ask('another-repeat-owner', 'library-repeat-00004').expect(202)).body;
  assert.equal(otherOwner.existing, false);
  for (const [owner, job] of [['repeat-owner', first.id], ['repeat-owner', otherTrack.id], ['another-repeat-owner', otherOwner.id]]) {
    await call('post', `/jobs/${job}/cancel`, owner).expect(200);
    await call('delete', `/jobs/${job}`, owner).expect(200);
  }
  const fresh = (await ask('repeat-owner', 'library-repeat-00005').expect(202)).body;
  assert.equal(fresh.existing, false, 'a deleted job does not count');
  assert.notEqual(fresh.id, first.id);
  await call('post', `/jobs/${fresh.id}/cancel`, 'repeat-owner').expect(200);
  await call('delete', `/jobs/${fresh.id}`, 'repeat-owner').expect(200);
});

test('delete and expiry erase every stored version and delete marker, page by page, never a Library original', async () => {
  const id = await readyJob('version-owner', 'version-upload-00001', 30);
  const base = `/test/${folderOf((await Jobs.findById(id).lean()).key)}`;
  for (let i = 0; i < 4; i++) objects.set(`${base}/plan.json`, Buffer.from(`plan ${i}`));
  for (let i = 0; i < 7; i++) objects.set(`${base}/sections/v1/${i}.flac`, Buffer.from('sound'));
  objects.hide(`${base}/sections/v1/6.flac`);
  const original = `media-library/${'e'.repeat(24)}/tape.mp4`;
  objects.set(`/test/${original}`, Buffer.from('tape'));
  objects.set(`/test/${original}`, Buffer.from('tape, second version'));
  await Jobs.updateOne({ _id: id }, { $set: { source: 'library', sourceKey: original } });
  assert.ok(versionsOf(id).length >= 13);
  storageLog.length = 0;
  await call('delete', `/jobs/${id}`, 'version-owner').expect(200);
  assert.equal(versionsOf(id).length, 0, 'no version or delete marker is left after Delete');
  assert.ok(storageLog.filter((item) => item.versions).length >= 3, 'the listing was read page by page');
  const deletes = storageLog.filter((item) => item.method === 'DELETE' && !item.uploadId);
  assert.ok(deletes.length >= 13 && deletes.every((item) => item.versionId), 'each delete names its version');
  assert.equal(objects.versions.get(`/test/${original}`).length, 2, 'the Library original keeps every version');

  const expiring = await readyJob('version-owner', 'version-upload-00002', 30);
  const folder = `/test/${folderOf((await Jobs.findById(expiring).lean()).key)}`;
  for (let i = 0; i < 3; i++) objects.set(`${folder}/copies/1/described.mp4`, Buffer.from(`video ${i}`));
  objects.hide(`${folder}/copies/1/described.mp4`);
  await Jobs.collection.updateOne({ _id: expiring }, { $set: { state: 'done', expiresAt: new Date(Date.now() - 1000) } });
  process.env.KADE_DESCRIBED_VIDEO = '0';
  try {
    await worker.tick();
  } finally {
    delete process.env.KADE_DESCRIBED_VIDEO;
  }
  assert.equal(await Jobs.findById(expiring).lean(), null);
  assert.equal(versionsOf(expiring).length, 0, 'no version or delete marker is left after expiry');
  objects.remove(`/test/${original}`, objects.versions.get(`/test/${original}`)[0].id);
  objects.remove(`/test/${original}`, objects.versions.get(`/test/${original}`)[0].id);
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

  const tagged = (id, at, outputAt, text) => ({ ...place(at, outputAt, text), id });
  const exact = scriptCues([
    record(0, 0, [tagged('0:0', 5, 5, 'The host holds a folder.')], []),
    record(1, 60, [tagged('0:1', 0, 1, 'Out.'), tagged('1:0', 20, 22, 'Left out.')], []),
  ]);
  assert.deepEqual(
    exact.map((cue) => [cue.id, cue.spoken, cue.spokenText, cue.outputAt]),
    [
      ['0:0', true, 'The host holds a folder.', 5],
      ['0:1', true, 'Out.', 71],
      ['1:0', true, 'Left out.', 92],
      ['1:1', false, '', 70 + 20],
    ],
    'ids match the voiced line even when names changed its words, or it was carried into the next section',
  );
});

test('the script never gives one description the line another one spoke, and keeps every reason', () => {
  const room = 'No gap was long enough at the fastest narration speed chosen.';
  const record = (index, start, cues, placements, skipped) => ({
    index,
    start,
    end: start + 10,
    analysis: { kind: 'other', setting: '', people: [], speakers: [], protectedSounds: [], cues },
    placements,
    skipped,
    outputSeconds: 10,
    continuity: { kind: '', setting: '', people: [], speakers: [], recent: [] },
  });
  const line = (at, text, id) => ({
    at,
    outputAt: at,
    duration: 1,
    rate: 1.5,
    text,
    pauseAt: at,
    pause: 0,
    inserted: false,
    shortened: false,
    importance: 3,
    ...(id ? { id } : {}),
  });
  const door = {
    at: 5,
    until: 9,
    text: 'A woman opens the door.',
    shortText: 'A door opens.',
    importance: 2,
  };
  const logo = {
    at: 6,
    until: 8,
    text: 'A red logo appears.',
    shortText: 'A logo.',
    importance: 3,
  };
  const truck = {
    at: 8,
    until: 10,
    text: 'The truck drives off.',
    shortText: 'It drives off.',
    importance: 2,
  };
  const view = (cues) =>
    cues.map((cue) => [cue.id, cue.spoken, cue.spokenText, cue.outputAt, cue.reason]);

  const older = scriptCues([
    record(0, 0, [door, logo], [line(6.2, logo.text)], [{ at: 5, text: door.text, reason: room }]),
  ]);
  assert.deepEqual(
    view(older),
    [
      ['0:0', false, '', 5, room],
      ['0:1', true, logo.text, 6.2, undefined],
    ],
    'a copy without ids: a left-out description does not take the next line spoken near it',
  );

  const carried = scriptCues([
    record(0, 0, [door, truck], [line(5, door.text, '0:0')], []),
    record(
      1,
      10,
      [{ ...logo, at: 0.5, until: 3 }],
      [line(0.1, truck.text, '0:1')],
      [{ at: 10.5, text: logo.text, reason: room, id: '1:0' }],
    ),
  ]);
  assert.deepEqual(view(carried), [
    ['0:0', true, door.text, 5, undefined],
    ['0:1', true, truck.text, 10.1, undefined],
    ['1:0', false, '', 10.5, room],
  ]);

  const hidden = scriptCues([
    record(
      0,
      0,
      [{ ...door, text: 'Pat opens the door.', shortText: 'Pat opens it.' }],
      [],
      [{ at: 5, text: 'The host opens the door.', reason: room, id: '0:0' }],
    ),
  ]);
  assert.equal(hidden[0].reason, room, 'the reason survives a name being hidden');
});

test('rehearsal stand-ins: fixed words, one numbered description at the first quiet spot, a local tone', async () => {
  const paid = async () => {
    throw new Error('A rehearsal must not use the meter.');
  };
  const signal = new AbortController().signal;
  let language = '';
  const words = await rehearsalProviders.transcribe('unused', 30, signal, paid, {
    onLanguage: (code) => (language = code),
  });
  assert.equal(words.map((word) => word.word).join(' '), 'This is a rehearsal.');
  assert.equal(language, 'en');
  assert.deepEqual(await rehearsalProviders.transcribe('unused', 0.9, signal, paid), [
    { start: 0.3, end: 0.6, word: 'This', speaker: 0 },
  ]);
  assert.equal(quietSpot([], 30), 0.5);
  assert.equal(quietSpot([{ start: 0.3, end: 1.7, text: 'Hi.' }, { start: 9, end: 10, text: 'Bye.' }], 30), 2);
  assert.equal(quietSpot([{ start: 0, end: 29.5, text: 'Talk.' }], 30), 29);
  const look = (index, survey = false) => ({
    file: 'unused',
    seconds: 40,
    brief: { position: { index, count: 3, start: 0, end: 40, total: 120 }, survey },
    state: null,
    lines: [{ start: 0.2, end: 3, text: 'Hello there.' }],
    before: [],
  });
  const analysis = await rehearsalProviders.analyze(look(2), signal, paid);
  assert.deepEqual(
    analysis.cues.map((cue) => [cue.at, cue.until, cue.text]),
    [[3.3, 6.3, 'Rehearsal description 3.']],
  );
  assert.equal((await rehearsalProviders.analyze(look(0, true), signal, paid)).cues.length, 0);
  const file = join(root, 'rehearsal-tone.wav');
  await rehearsalProviders.synthesize('Rehearsal description 1.', 'any voice', 'session', file, 1.5, signal, paid);
  const pcm = await decodeVoice(file, signal);
  assert.ok(Math.abs(pcm.length / sampleRate - (25 * 0.0625) / 1.5) < 0.05, 'as long as the words would take');
  assert.ok(pcm.some((sample) => Math.abs(sample) > 0.1), 'an audible tone');
});

/** Loads the LibreChat wrapper with only the app-level modules stubbed; the Library model and parser are real. */
function loadWrapper() {
  const routes = fileURLToPath(new URL('../../../../api/server/routes/', import.meta.url));
  const books = new Map();
  const state = { hooks: null, pushes: 0, copies: [], posts: [], bridgeReply: { ok: true, sent: 1 } };
  const stubs = {
    axios: {
      post: async (url, body, options) => {
        state.posts.push({ url, body, options });
        return { status: 200, data: state.bridgeReply };
      },
    },
    '@librechat/api': {
      createDescriptionWallet,
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
    const secret = process.env.BRIDGE_SECRET;
    delete process.env.BRIDGE_SECRET;
    assert.deepEqual(await hooks.notify(String(owner), 'Title', 'Body', '/described-video'), { browser: 2, bridge: 'off' });
    assert.equal(wrapper.state.pushes - before, 1);
    assert.equal(wrapper.state.posts.length, 0, 'no bridge secret, no phone push');

    process.env.BRIDGE_SECRET = 'test-only';
    try {
      const job = 'b'.repeat(32);
      const receipt = await hooks.notify(String(owner), 'Your described video is ready', 'Body', `/described-video?id=${job}`, { job, kind: 'ready' });
      const post = wrapper.state.posts.at(-1);
      assert.match(post.url, /\/notify$/);
      assert.equal(post.body.route, 'described-video', 'a tap opens the described-video screen, not a new chat');
      assert.equal(post.body.runId, job, 'the job id rides in the field the bridge accepts');
      assert.equal(post.body.agentId, 'described-video');
      assert.equal(post.body.requested, true);
      assert.equal(post.options.headers['x-bridge-secret'], 'test-only');
      assert.deepEqual(receipt, { browser: 2, bridge: 200, sent: 1 });
      wrapper.state.bridgeReply = { ok: true, sent: 0, deferred: true, blocked: 'quiet hours (Central) — queued for morning' };
      const deferred = await hooks.notify(String(owner), 'Title', 'Body', '/described-video', { job, kind: 'stopped' });
      assert.deepEqual(deferred, { browser: 2, bridge: 200, sent: 0, deferred: true, blocked: 'quiet hours (Central) — queued for morning' });
    } finally {
      if (secret === undefined) delete process.env.BRIDGE_SECRET;
      else process.env.BRIDGE_SECRET = secret;
    }
  } finally {
    wrapper.restore();
  }
});

/** Stored keys and versions under a job's folder, relative to it. */
const storedUnder = (prefix) =>
  [...objects.versions.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
const rehearsalLeftovers = (prefix, version) =>
  storedUnder(prefix).filter((key) =>
    [`looks/v${version}/`, `sections/v${version}/`, `copies/${version}/`, `first-look-${version}.json`].some((start) =>
      key.startsWith(start),
    ),
  );

test('a rehearsal that stops leaves nothing a paid run can reuse: its looks and first look are erased and the paid run takes a new version', async () => {
  await Budgets.deleteMany({});
  const id = await readyJob('rehearsal-owner', 'rehearsal-upload-003', 150);
  const prefix = `/test/${folderOf((await Jobs.findById(id).lean()).key)}/`;
  const written = new Set();
  storageHook = ({ method, key }) => {
    if ((method === 'PUT' || method === 'POST') && key.startsWith(prefix)) written.add(key.slice(prefix.length));
  };
  faults.push(
    { method: 'PUT', match: new RegExp(`${id}/copies/1/described`), times: 1000 },
    { method: 'POST', match: new RegExp(`${id}/copies/1/described`), times: 1000 },
  );
  let stopped;
  try {
    await call('post', `/jobs/${id}/rehearse`, 'rehearsal-owner').send({ firstLook: true }).expect(202);
    stopped = await settle(id, ['ready', 'failed', 'done', 'cancelled'], 'rehearsal-owner');
  } finally {
    faults.length = 0;
    storageHook = null;
  }
  assert.equal(stopped.state, 'ready');
  assert.match(stopped.error, /^The rehearsal stopped: /);
  assert.equal(stopped.copies.length, 0);
  assert.deepEqual([stopped.lastRehearsal.outcome, stopped.lastRehearsal.version], ['stopped', 1]);
  assert.ok([...written].some((key) => key.startsWith('looks/v1/')), 'the rehearsal kept its looks while it ran');
  assert.ok(written.has('first-look-1.json'), 'and its first look');
  await eventually(() => assert.deepEqual(rehearsalLeftovers(prefix, 1), [], 'every stored version of them is erased'));

  const seen = [];
  beforeEngine = (input) => {
    seen.push({ firstLook: input.keeper.saved.firstLook, looks: [...input.keeper.saved.looks] });
  };
  const before = calls.analyze;
  try {
    await call('post', `/jobs/${id}/start`, 'rehearsal-owner').send({ ...settings, firstLook: true, preview: true }).expect(202);
    const preview = await settle(id, ['done', 'failed'], 'rehearsal-owner');
    assert.equal(preview.state, 'done', preview.error);
    assert.equal(preview.version, 2, 'the paid run never takes the number the rehearsal wrote under');
    await call('post', `/jobs/${id}/finish`, 'rehearsal-owner').send({}).expect(202);
    const done = await settle(id, ['done', 'failed'], 'rehearsal-owner');
    assert.equal(done.state, 'done', done.error);
    assert.equal(done.version, 2);
    assert.ok(!seen[0].firstLook, 'the paid first look starts fresh instead of from the rehearsal survey');
    for (const pass of seen)
      assert.ok(
        pass.looks.every((look) => !look || !/Rehearsal/.test(JSON.stringify(look))),
        'no rehearsal look is handed to a paid pass',
      );
    const script = (await call('get', `/jobs/${id}/script`, 'rehearsal-owner').expect(200)).body;
    assert.ok(script.cues.length > 0);
    assert.ok(
      script.cues.every((cue) => /^Section cue \d+\.$/.test(cue.text)),
      JSON.stringify(script.cues.map((cue) => cue.text)),
    );
    assert.ok(calls.analyze - before >= done.sections, 'every section was looked at by a paid call');
  } finally {
    beforeEngine = null;
  }
  await call('delete', `/jobs/${id}`, 'rehearsal-owner').expect(200);
  await Budgets.deleteMany({});
});

test('a rehearsal cancelled while it runs erases what it wrote and says it was cancelled', async () => {
  const id = await readyJob('rehearsal-owner', 'rehearsal-upload-004', 150);
  const prefix = `/test/${folderOf((await Jobs.findById(id).lean()).key)}/`;
  let asked = false;
  storageHook = async ({ method, key }) => {
    if (asked || method !== 'PUT' || !key.startsWith(prefix + 'looks/v1/')) return;
    asked = true;
    await call('post', `/jobs/${id}/cancel`, 'rehearsal-owner').expect(200);
  };
  let back;
  try {
    await call('post', `/jobs/${id}/rehearse`, 'rehearsal-owner').send({ firstLook: true }).expect(202);
    back = await settle(id, ['ready', 'failed', 'done', 'cancelled'], 'rehearsal-owner');
  } finally {
    storageHook = null;
  }
  assert.ok(asked, 'the cancel came while the rehearsal was looking');
  assert.equal(back.state, 'ready');
  assert.equal(back.error, '');
  assert.deepEqual([back.lastRehearsal.outcome, back.lastRehearsal.version], ['cancelled', 1]);
  await eventually(() => assert.deepEqual(rehearsalLeftovers(prefix, 1), []));
  const price = (await call('post', `/jobs/${id}/estimate`, 'rehearsal-owner').send({ action: 'start', settings }).expect(200)).body;
  assert.equal(price.allowed, true);
  await call('delete', `/jobs/${id}`, 'rehearsal-owner').expect(200);
});

test('over the quote on a day already partly used: the ask fits what is left, and Continue never refuses a larger ask', async () => {
  await Budgets.deleteMany({});
  await Budgets.create({ _id: today(), held: 430, runs: [] });
  const id = await readyJob('quote-owner', 'quote-upload-0000002', 150);
  const approval = (usd) => Math.min(5, Math.ceil((usd * 1.5 + 0.1) * 100 - 1e-6) / 100);
  overbill = 9;
  try {
    await call('post', `/jobs/${id}/start`, 'quote-owner').send(settings).expect(202);
    const stopped = await settle(id, ['failed', 'done'], 'quote-owner');
    assert.equal(stopped.overQuote, true, stopped.error);
    const over = (await Jobs.findById(id).lean()).overQuote;
    const ask = (await call('post', `/jobs/${id}/estimate`, 'quote-owner').send({ action: 'resume' }).expect(200)).body;
    const rate = Math.max(1, over.spentUSD / Math.max(0.01, over.quotedUSD));
    const full = Math.min(5, Math.ceil((ask.estimateUSD * rate * 1.5 + 0.1) * 100 - 1e-6) / 100);
    assert.ok(ask.remainingUSD < full, 'today has less left than the full ask');
    assert.ok(ask.setAsideUSD <= ask.remainingUSD, 'but enough for the set-aside');
    assert.equal(ask.allowed, true, 'so carrying on is offered');
    assert.equal(ask.approvedUSD, Math.max(approval(ask.estimateUSD), ask.remainingUSD), 'and the ask is cut to what is left');
    assert.match(
      stopped.error,
      new RegExp(`Continue up to \\$${ask.approvedUSD.toFixed(2)} more\\?`),
      'the stop names the same ask as the estimate',
    );

    const heldThen = await held();
    await Budgets.updateOne({ _id: today() }, { $set: { held: 500 - Math.round(ask.setAsideUSD * 100) + 1 } });
    const short = (await call('post', `/jobs/${id}/estimate`, 'quote-owner').send({ action: 'resume' }).expect(200)).body;
    assert.equal(short.allowed, false, 'when the set-aside does not fit, the estimate says so');
    const refused = await call('post', `/jobs/${id}/resume`, 'quote-owner').send({ allowUpToUSD: short.approvedUSD }).expect(409);
    assert.equal(refused.body.error, short.reason, 'and Continue refuses with the same words');
    assert.equal((await Jobs.findById(id).lean()).state, 'failed');

    await Budgets.updateOne({ _id: today() }, { $set: { held: heldThen } });
    overbill = 0;
    const resumed = (await call('post', `/jobs/${id}/resume`, 'quote-owner').send({ allowUpToUSD: full }).expect(202)).body;
    assert.equal(resumed.approvedUSD, ask.approvedUSD, 'an ask above what is left is cut to it, not refused');
    const done = await settle(id, ['failed', 'done'], 'quote-owner');
    assert.equal(done.state, 'done', done.error);
  } finally {
    overbill = 0;
  }
  assert.deepEqual((await Budgets.findById(today()).lean()).runs, [], 'both runs gave back what they did not spend');
  await call('delete', `/jobs/${id}`, 'quote-owner').expect(200);
  await Budgets.deleteMany({});
});


test('beta members use only their own balance, included speech, and an uncapped accepted price', async () => {
  walletMode = true;
  const user = new mongoose.Types.ObjectId();
  const owner = String(user);
  try {
    await mongoose.connection.collection('users').insertOne({ _id: user, role: 'USER' });
    await mongoose.connection.collection('balances').insertOne({ user, tokenCredits: 20e6 });
    const config = (await call('get', '/config', owner).set('x-role', 'user').expect(200)).body;
    assert.equal(config.billingMode, 'balance');
    assert.equal(config.limitUSD, null);
    assert.equal(config.dailyUSD, null);
    assert.equal(config.remainingUSD, 20);
    assert.equal(config.speechIncluded, true);
    const id = await readyJob(owner, 'wallet-long-000001', 5000);
    const rich = { ...settings, detail: 'rich', firstLook: true, closeLook: true };
    const quote = (await call('post', `/jobs/${id}/estimate`, owner).set('x-role', 'user').send({ action: 'start', settings: rich }).expect(200)).body;
    assert.ok(quote.estimateUSD > 5);
    assert.equal(quote.allowed, true);
    assert.equal(quote.breakdown.speech, 0);
    assert.equal(quote.setAsideUSD, quote.approvedUSD);
    await Promise.all(Array.from({ length: 5 }, () => call('post', `/jobs/${id}/start`, owner).set('x-role', 'user').send(rich)));
    assert.ok(Math.abs(await billing.available(owner) - (20 - quote.approvedUSD)) < 1e-8);
    await call('get', `/jobs/${id}`, String(new mongoose.Types.ObjectId())).set('x-role', 'user').expect(404);
    await call('post', `/jobs/${id}/cancel`, owner).expect(200);
    await call('post', `/jobs/${id}/cancel`, owner).expect(200);
    assert.equal(await billing.available(owner), 20);
    await call('delete', `/jobs/${id}`, owner).expect(200);
    const short = await readyJob(owner, 'wallet-short-00001', 10);
    await mongoose.connection.collection('balances').updateOne({ user }, { $set: { tokenCredits: 0 } });
    const noMoney = (await call('post', `/jobs/${short}/estimate`, owner).set('x-role', 'user').send({ action: 'start', settings }).expect(200)).body;
    assert.equal(noMoney.allowed, false);
    const before = calls.analyze;
    await call('post', `/jobs/${short}/start`, owner).send(settings).expect(409);
    assert.equal(calls.analyze, before);
    await mongoose.connection.collection('balances').updateOne({ user }, { $set: { tokenCredits: 1e6 } });
    const price = (await call('post', `/jobs/${short}/estimate`, owner).send({ action: 'start', settings }).expect(200)).body;
    overbill = 100;
    await call('post', `/jobs/${short}/start`, owner).send(settings).expect(202);
    await settle(short, ['failed', 'done'], owner);
    assert.ok(await billing.available(owner) >= 1 - price.approvedUSD - 1e-8);
    await call('delete', `/jobs/${short}`, owner).expect(200);
  } finally { overbill = 0; walletMode = false; }
});

test('wallet refunds survive a restart after completion or midway through reserving, and before deletion', async () => {
  walletMode = true;
  const user = new mongoose.Types.ObjectId();
  const owner = String(user);
  const balances = mongoose.connection.collection('balances');
  try {
    await mongoose.connection.collection('users').insertOne({ _id: user, role: 'USER' });
    await balances.insertOne({ user, tokenCredits: 10e6 });
    for (const state of ['done', 'reserving', 'deleting']) {
      const id = await readyJob(owner, randomUUID(), 10);
      const reservation = { runId: randomUUID(), walletOwner: owner, day: today(), cents: 200 };
      await billing.reserve(owner, reservation.runId, 2);
      assert.equal(await billing.available(owner), state === 'done' ? 8 : 7.6);
      const pending = state === 'reserving';
      await Jobs.collection.updateOne({ _id: id }, { $set: {
        state, active: false, runCost: state === 'done' ? 0.4 : 0,
        [pending ? 'pendingRun' : 'reservation']: reservation,
        ...(pending ? { reservingFrom: 'ready' } : {}), ...stale,
      } });
      if (state === 'deleting') await call('delete', `/jobs/${id}`, owner).expect(200);
      else {
        await worker.tick();
        await worker.tick();
        assert.equal((await Jobs.findById(id).lean()).state, pending ? 'ready' : 'done');
        await call('delete', `/jobs/${id}`, owner).expect(200);
      }
      assert.equal(await billing.available(owner), 9.6);
    }
  } finally { walletMode = false; }
});

/** A failed assertion must not leave a queued job behind for the next test's worker to pick up. */
const park = (id) =>
  Jobs.updateOne(
    { _id: id, state: { $in: ['queued', 'running'] } },
    { $set: { state: 'failed', active: false }, $unset: { worker: 1, lease: 1 } },
  );

test('a restart that cuts off a paid request does not charge its reserve, and the next server finishes within the approval', async () => {
  await Budgets.deleteMany({});
  const id = await readyJob('restart-owner', 'restart-upload-00001', 150);
  const doomed = createDescriptionRouter({ ...hooks, timing: { heartbeatMs: 100, tickMs: 0, wedgeMs: 1500 } });
  await call('post', `/jobs/${id}/start`, 'restart-owner').send(settings).expect(202);
  const approved = (await Jobs.findById(id).lean()).approvedUSD;
  const usageBefore = usageLog.length;
  const logsBefore = logLines.length;
  try {
    assert.ok(approved < 0.35, `the cut-off reserve alone is more than she approved (${approved})`);
    let started = () => {};
    const inFlight = new Promise((resolve) => (started = resolve));
    holdVision = { started };
    const running = doomed.tick();
    await inFlight;
    const holding = await Jobs.findById(id).lean();
    await doomed.close();
    await running;
    assert.ok(Math.abs(holding.runCost - 0.35) < 1e-9, 'the reserve is held while the request is out');
    const requeued = await Jobs.findById(id).lean();
    assert.equal(requeued.state, 'queued');
    assert.equal(requeued.stage, 'Continuing after a server restart');
    assert.equal(requeued.runCost, 0, 'the request our restart cut off was not charged');
    assert.equal(requeued.costUSD, 0);
    assert.equal(requeued.spend?.uncertain ?? 0, 0);
    assert.ok(!usageLog.slice(usageBefore).some((item) => item.job === id), 'nothing was booked to her');
    const [cut] = logged(logsBefore, 'dv.paid-interrupted');
    assert.equal(cut?.reserveUSD, 0.35, 'the operator still sees what the provider may bill');
    assert.equal(cut.why, 'shutdown');
    assert.equal(cut.providerMayBill, true);
    assert.equal(cut.settled, 0);
    assert.ok(Math.abs(holding.runPending - 0.35) < 1e-9, 'while it was out it was recorded as in flight');
    assert.equal(requeued.runPending, 0);
    overbill = 1;
    const done = await settle(id, ['done', 'failed'], 'restart-owner');
    assert.equal(done.state, 'done', done.error);
    assert.equal(done.overQuote, false, 'the next server did not stop over the quote');
    assert.ok(done.runCostUSD > 0 && done.runCostUSD <= approved);
    assert.deepEqual((await Budgets.findById(today()).lean()).runs, []);
  } finally {
    holdVision = null;
    overbill = 0;
    await doomed.close();
    await park(id);
  }
  await call('delete', `/jobs/${id}`, 'restart-owner').expect(200);
  await Budgets.deleteMany({});
});

test('her cancel while a paid request is out charges nothing for it', async () => {
  await Budgets.deleteMany({});
  const id = await readyJob('cut-owner', 'cut-upload-00000001', 150);
  await call('post', `/jobs/${id}/start`, 'cut-owner').send(settings).expect(202);
  const usageBefore = usageLog.length;
  const logsBefore = logLines.length;
  try {
    let started = () => {};
    const inFlight = new Promise((resolve) => (started = resolve));
    holdVision = { started };
    const ticking = worker.tick();
    await inFlight;
    await call('post', `/jobs/${id}/cancel`, 'cut-owner').expect(200);
    await ticking;
    const job = (await call('get', `/jobs/${id}`, 'cut-owner').expect(200)).body;
    assert.equal(job.state, 'cancelled');
    assert.equal(job.runCostUSD, 0);
    assert.equal(job.costUSD, 0);
    assert.equal(await held(), 0, 'the whole set-aside came back');
    assert.ok(!usageLog.slice(usageBefore).some((item) => item.job === id));
    assert.equal(logged(logsBefore, 'dv.paid-interrupted')[0]?.why, 'cancel');
  } finally {
    holdVision = null;
    await park(id);
  }
  await call('delete', `/jobs/${id}`, 'cut-owner').expect(200);
  await Budgets.deleteMany({});
});

test('reserves a dead worker left unsettled are never charged: the next claim and a release both drop them', async () => {
  await Budgets.deleteMany({});
  const id = await readyJob('orphan-owner', 'orphan-upload-00001', 150);
  await call('post', `/jobs/${id}/start`, 'orphan-owner').send(settings).expect(202);
  const approved = (await Jobs.findById(id).lean()).approvedUSD;
  /* The server died mid-request: $0.05 settled, a $0.35 vision reserve never did. */
  await Jobs.collection.updateOne(
    { _id: id },
    { $set: { state: 'running', worker: 'gone', runCost: 0.4, runPending: 0.35, costUSD: 0.4, ...stale } },
  );
  const logsBefore = logLines.length;
  try {
    process.env.KADE_DESCRIBED_VIDEO = '0';
    try {
      await worker.tick();
    } finally {
      delete process.env.KADE_DESCRIBED_VIDEO;
    }
    assert.equal((await Jobs.findById(id).lean()).state, 'queued');
    overbill = 1;
    const done = await settle(id, ['done', 'failed'], 'orphan-owner');
    assert.equal(done.state, 'done', done.error);
    assert.ok(Math.abs(done.runCostUSD - 0.15) < 1e-9, `run cost ${done.runCostUSD} of ${approved} approved`);
    assert.ok(Math.abs(done.costUSD - 0.15) < 1e-9);
    assert.equal((await Jobs.findById(id).lean()).runPending, 0);
    assert.equal(logged(logsBefore, 'dv.paid-orphaned')[0]?.reserveUSD, 0.35);
    assert.equal(await held(), 15, 'the day keeps only what was really spent');
  } finally {
    overbill = 0;
    await park(id);
  }

  const other = await readyJob('orphan-owner', 'orphan-upload-00002', 60);
  await Budgets.updateOne({ _id: today() }, { $inc: { held: 40 }, $addToSet: { runs: 'orphan-run' } }, { upsert: true });
  const heldBefore = await held();
  await Jobs.collection.updateOne(
    { _id: other },
    {
      $set: {
        state: 'running',
        worker: 'gone',
        lease: new Date(Date.now() - 1000),
        reservation: { runId: 'orphan-run', day: today(), cents: 40 },
        runCost: 0.4,
        runPending: 0.35,
        costUSD: 0.4,
        settings,
      },
    },
  );
  const cancelled = (await call('post', `/jobs/${other}/cancel`, 'orphan-owner').expect(200)).body;
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(await held(), heldBefore - 35, 'the cancelled run keeps only its settled 5 cents');
  assert.equal(cancelled.runCostUSD, 0.05);
  assert.equal(cancelled.costUSD, 0.05);
  for (const job of [id, other]) await call('delete', `/jobs/${job}`, 'orphan-owner').expect(200);
  await Budgets.deleteMany({});
});

test('free dialogue: Deepgram is logged for the operator, never quoted, charged or counted against the approval', async () => {
  const axios = createRequire(import.meta.url)('axios');
  const previous = axios.defaults.adapter;
  const deepgram = {
    metadata: { duration: 30 },
    results: { channels: [{ alternatives: [{ words: [{ word: 'hello', punctuated_word: 'Hello.', start: 0.2, end: 0.9, speaker: 0 }] }] }] },
  };
  axios.defaults.adapter = async (config) => {
    if (!/deepgram\.com/.test(config.url)) return axios.getAdapter(previous)(config);
    config.data?.destroy?.();
    return { status: 200, statusText: 'OK', headers: {}, data: deepgram, config };
  };
  realTranscribe = true;
  await Budgets.deleteMany({});
  const run = async (name) => {
    const id = await readyJob('dialogue-owner', name, 30);
    const price = (await call('post', `/jobs/${id}/estimate`, 'dialogue-owner').send({ action: 'start', settings }).expect(200)).body;
    const usageBefore = usageLog.length;
    const logsBefore = logLines.length;
    await call('post', `/jobs/${id}/start`, 'dialogue-owner').send(settings).expect(202);
    try {
      const done = await settle(id, ['done', 'failed'], 'dialogue-owner');
      assert.equal(done.state, 'done', done.error);
      const booked = usageLog.slice(usageBefore).filter((item) => item.job === id);
      const stored = await Jobs.findById(id).lean();
      return { price, done, booked, stored, logsBefore };
    } finally {
      await park(id);
      await call('delete', `/jobs/${id}`, 'dialogue-owner').expect(200);
    }
  };
  try {
    const paidConfig = (await call('get', '/config', 'dialogue-owner').expect(200)).body;
    assert.equal(paidConfig.dialogueIncluded, false);
    const paid = await run('dialogue-paid-000001');
    assert.ok(paid.price.breakdown.dialogue > 0);
    assert.deepEqual(paid.booked.map((item) => item.kind), ['transcription']);
    assert.ok(Math.abs(paid.done.runCostUSD - 0.0026) < 1e-9, 'without the flag she pays for 30 s of dialogue timing');
    assert.equal(await held(), 1);
    await Budgets.deleteMany({});

    process.env.KADE_DESCRIPTION_FREE_DIALOGUE = '1';
    const config = (await call('get', '/config', 'dialogue-owner').expect(200)).body;
    assert.equal(config.dialogueIncluded, true);
    assert.ok(
      Math.abs(paidConfig.perMinuteUSD.standard - config.perMinuteUSD.standard - 0.0052) < 1e-9,
      'the per-minute price drops by the Deepgram rate',
    );
    const free = await run('dialogue-free-000001');
    assert.equal(free.price.breakdown.dialogue, 0);
    assert.equal(free.price.dialogueIncluded, true);
    assert.ok(free.price.estimateUSD <= paid.price.estimateUSD);
    assert.equal(free.done.runCostUSD, 0, 'she is not charged');
    assert.equal(free.done.costUSD, 0);
    assert.equal(free.stored.spend?.transcription ?? 0, 0);
    assert.deepEqual(free.booked.map((item) => item.kind), ['transcription-included'], 'the operator still sees it');
    assert.ok(Math.abs(free.booked[0].costUSD - 0.0026) < 1e-9);
    assert.ok(Math.abs(logged(free.logsBefore, 'dv.included')[0]?.costUSD - 0.0026) < 1e-9);
    assert.equal(await held(), 0);
  } finally {
    delete process.env.KADE_DESCRIPTION_FREE_DIALOGUE;
    realTranscribe = false;
    axios.defaults.adapter = previous;
    await Budgets.deleteMany({});
  }
});
