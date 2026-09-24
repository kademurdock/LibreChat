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
import { S3Client } from '@aws-sdk/client-s3';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createDescriptionRouter } from './router.ts';
import { command } from './media.ts';

process.env.FFMPEG_PATH = ffmpegPath;
process.env.FFPROBE_PATH = ffprobePath.path;
let mongo, external, service, worker, app, Jobs, Budgets, storage, root, voiceWav;
const objects = new Map();
const settings = { voice: 'Voice 1', rate: 1.5, maxRate: 2.25, mode: 'standard' };
const notices = [];
const libraryCalls = [];
const calls = { analyze: 0, transcribe: 0, synthesize: 0 };
let failSection = -1;
let simulateConcurrentCosts = false;

const xml = (res, body, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/xml' });
  res.end(body);
};
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
/** A small S3-compatible store: multipart uploads, get, head, put, copy, list and delete. */
function fakeStorage(uploads) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://storage.test');
    const key = decodeURIComponent(url.pathname);
    const uploadId = url.searchParams.get('uploadId');
    if (req.method === 'POST' && url.searchParams.has('uploads')) {
      const id = randomUUID();
      uploads.set(id, new Map());
      return xml(
        res,
        `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if (req.method === 'PUT' && uploadId) {
      const data = await body(req);
      uploads.get(uploadId).set(Number(url.searchParams.get('partNumber')), data);
      res.setHeader('ETag', '"' + createHash('md5').update(data).digest('hex') + '"');
      return res.end();
    }
    if (req.method === 'POST' && uploadId) {
      await body(req);
      const parts = [...uploads.get(uploadId).entries()].sort((a, b) => a[0] - b[0]);
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

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'described-router-test-'));
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  voiceWav = join(root, 'voice.wav');
  await command(
    ffmpegPath,
    [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=660:sample_rate=24000:duration=2',
      voiceWav,
    ],
    new AbortController().signal,
  );
  const store = fakeStorage(new Map());
  external = createServer(async (req, res) => {
    if (req.url === '/voices.json') {
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
  delete process.env.KADE_DESCRIPTION_PUBLIC;
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
    }),
    storage: () => storage,
    log: () => {},
    usage: async () => {},
    notify: async (owner, title, text, url) => {
      notices.push({ owner, title, text, url });
    },
    library: {
      folders: async () => ['Audio/Commercials/1996'],
      open: async (_req, book, track) => {
        if (book !== 'a'.repeat(24)) throw new Error('That library video was not found.');
        return {
          key: `media-library/${book}/${track}.mp4`,
          bytes: 1,
          title: 'Library film',
          about: 'From the shelf.',
        };
      },
      save: async (input) => {
        libraryCalls.push(input);
        await input.copy('media-library/new-book/described.m4a');
        return { id: 'b'.repeat(24), path: input.path };
      },
    },
    providers: {
      transcribe: async () => {
        calls.transcribe++;
        return [{ start: 0.2, end: 0.9, word: 'Hello.', speaker: 0 }];
      },
      analyze: async (look) => {
        calls.analyze++;
        if (failSection === calls.analyze)
          throw Object.assign(new Error('Request failed with status code 402'), {
            isAxiosError: true,
            response: { status: 402 },
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
              ? [
                  {
                    at: 5,
                    until: 9,
                    pauseAt: 5,
                    text: 'Another test shape moves.',
                    shortText: 'The shape moves.',
                    importance: 2,
                  },
                ]
              : [],
          ),
        };
      },
      synthesize: async (_text, _voice, _session, file, _speed, _signal, meter) => {
        calls.synthesize++;
        if (simulateConcurrentCosts) {
          await meter('speech', 0.3, async () => {
            await new Promise((resolve) => setTimeout(resolve, 75));
            await copyFile(voiceWav, file);
            return { costUSD: 0.01 };
          });
          return;
        }
        await copyFile(voiceWav, file);
      },
    },
  };
  service = createDescriptionRouter({
    ...hooks,
    usage: async () => {
      throw new Error('Route tests make no paid calls.');
    },
  });
  service.close();
  worker = createDescriptionRouter(hooks);
  app = express();
  app.use(express.json());
  app.use(service.router);
  Jobs = mongoose.models.KadeDescriptionJob;
  Budgets = mongoose.models.KadeDescriptionBudget;
});
after(async () => {
  service?.close();
  worker?.close();
  await mongoose.disconnect();
  await mongo?.stop();
  if (external) await new Promise((resolve) => external.close(resolve));
  await rm(root, { recursive: true, force: true });
});
const call = (method, path, owner = 'owner') => request(app)[method](path).set('x-user', owner);
async function upload(owner, id, bytes = 1000) {
  const result = await call('post', '/uploads', owner)
    .send({ requestId: id, name: 'episode.mp4', bytes })
    .expect(200);
  return result.body.job.id;
}
/** Drives the worker until the job reaches one of `states`; its own timer may also pick jobs up. */
async function settle(id, states, owner = 'owner') {
  const deadline = Date.now() + 5 * 60000;
  while (Date.now() < deadline) {
    await worker.tick();
    const job = (await call('get', `/jobs/${id}`, owner).expect(200)).body;
    if (states.includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The job did not settle.');
}

test('authentication and private trial gate run before returning job data', async () => {
  await request(app).get('/jobs').expect(401);
  await call('get', '/jobs').set('x-role', 'user').expect(403);
  const config = await call('get', '/config').expect(200);
  assert.equal(config.body.limitUSD, 5);
  assert.deepEqual(config.body.voices, ['Voice 1', 'clear woman · flint']);
  assert.equal(config.body.defaultVoice, 'clear woman · flint');
  assert.equal(config.body.categories[0].name, 'Test');
  assert.ok(config.body.perMinuteUSD.rich > config.body.perMinuteUSD.essential);
  assert.equal(config.body.remainingUSD, 5);
});

test('uploads are idempotent, owners are isolated, and up to ten videos can wait at once', async () => {
  const id = await upload('owner', 'idempotent-upload-0001');
  assert.equal(await upload('owner', 'idempotent-upload-0001'), id);
  await call('post', '/uploads')
    .send({ requestId: 'idempotent-upload-0001', name: 'different.mp4', bytes: 1000 })
    .expect(409);
  await call('get', `/jobs/${id}`, 'another-owner').expect(409);
  await call('get', `/jobs/${id}/files`, 'another-owner').expect(409);
  await call('post', `/jobs/${id}/cancel`, 'another-owner').expect(409);
  await call('delete', `/jobs/${id}`, 'another-owner').expect(409);
  assert.equal((await call('get', '/jobs', 'another-owner').expect(200)).body.jobs.length, 0);
  const more = [];
  for (let i = 1; i < 10; i++)
    more.push(await upload('owner', `queued-upload-${String(i).padStart(6, '0')}`));
  await call('post', '/uploads')
    .send({ requestId: 'eleventh-upload-00001', name: 'episode.mp4', bytes: 1000 })
    .expect(409);
  for (const job of [id, ...more]) await call('delete', `/jobs/${job}`).expect(200);
  assert.equal(await Jobs.countDocuments({ owner: 'owner' }), 0);
});

test('concurrent starts set money aside once; the daily allowance blocks what it cannot cover', async () => {
  const id = await upload('owner', 'paid-upload-00000001');
  await Jobs.updateOne({ _id: id }, { $set: { state: 'ready', seconds: 5400 } });
  await call('post', `/jobs/${id}/start`)
    .send({ ...settings, maxRate: 1 })
    .expect(400);
  await call('post', `/jobs/${id}/start`)
    .send({ ...settings, voice: 'invented' })
    .expect(409);
  const expensive = await call('post', `/jobs/${id}/start`)
    .send({ ...settings, closeLook: true, firstLook: true })
    .expect(409);
  assert.match(expensive.body.error, /above the.*limit/);
  assert.equal((await Jobs.findById(id)).state, 'ready');
  const starts = await Promise.all(
    Array.from({ length: 12 }, () => call('post', `/jobs/${id}/start`).send(settings)),
  );
  assert.ok(starts.every((result) => [200, 202].includes(result.status)));
  assert.equal((await Jobs.findById(id)).state, 'queued');
  const budget = await Budgets.findById(new Date().toISOString().slice(0, 10));
  assert.equal(budget.reserved, 5);
  assert.deepEqual([...budget.jobs], [id]);
  const second = await upload('another-owner', 'paid-upload-00000002');
  await Jobs.updateOne({ _id: second }, { $set: { state: 'ready', seconds: 600 } });
  const refused = await call('post', `/jobs/${second}/start`, 'another-owner')
    .send(settings)
    .expect(409);
  assert.match(refused.body.error, /allowance is left/);
  assert.equal((await Jobs.findById(second)).state, 'ready');
  await call('delete', `/jobs/${id}`).expect(409);
  await Jobs.updateOne({ _id: id }, { $set: { runCost: 0.3, costUSD: 0.3 } });
  await call('post', `/jobs/${id}/cancel`).expect(200);
  await call('post', `/jobs/${id}/cancel`).expect(200);
  const spent = await Budgets.findById(budget._id);
  assert.ok(Math.abs(spent.reserved - 0.3) < 0.00001);
  assert.equal(spent.jobs.length, 0);
  await call('post', `/jobs/${second}/start`, 'another-owner').send(settings).expect(202);
  assert.ok((await Jobs.findById(second)).reserved < 1);
  await call('post', `/jobs/${second}/cancel`, 'another-owner').expect(200);
  await call('delete', `/jobs/${id}`).expect(200);
  await call('delete', `/jobs/${second}`, 'another-owner').expect(200);
  await Budgets.deleteMany({});
});

test('chunk uploads resume, verify repeated bytes, and assemble exactly once', async () => {
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
  await put('another-owner', 1, chunk).expect(409);
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
  const stored = await Jobs.findById(id);
  assert.equal(stored.state, 'checking');
  assert.equal(stored.uploadId, undefined);
  await call('post', `/jobs/${id}/cancel`, 'chunk-owner').expect(200);
  await call('delete', `/jobs/${id}`, 'chunk-owner').expect(200);
});

test('YouTube and library imports are idempotent and accept only what they should', async () => {
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
  await call('post', `/jobs/${first.body.id}/start`, 'youtube-owner').send(settings).expect(409);
  await call('post', `/jobs/${first.body.id}/cancel`, 'youtube-owner').expect(200);
  await call('post', '/library-imports', 'youtube-owner')
    .send({ requestId: 'library-import-00001', book: 'c'.repeat(24), track: 0 })
    .expect(409);
  const library = await call('post', '/library-imports', 'youtube-owner')
    .send({ requestId: 'library-import-00001', book: 'a'.repeat(24), track: 2 })
    .expect(202);
  assert.equal(library.body.source, 'library');
  assert.equal(library.body.name, 'Library film');
  const stored = await Jobs.findById(library.body.id);
  assert.equal(stored.sourceKey, `media-library/${'a'.repeat(24)}/2.mp4`);
  await call('post', `/jobs/${library.body.id}/cancel`, 'youtube-owner').expect(200);
  await call('delete', `/jobs/${library.body.id}`, 'youtube-owner').expect(200);
  await call('delete', `/jobs/${first.body.id}`, 'youtube-owner').expect(200);
});

test('a whole job: check, describe, stop halfway, continue from saved sections, re-voice, library and notices', async () => {
  const video = join(root, 'source.mp4');
  await command(
    ffmpegPath,
    [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x120:rate=30:duration=150',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:sample_rate=48000:duration=150',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      video,
    ],
    new AbortController().signal,
  );
  const bytes = await readFile(video);
  const created = await call('post', '/uploads', 'film-owner')
    .send({ requestId: 'film-upload-00000001', name: 'My film.mp4', bytes: bytes.length })
    .expect(200);
  const id = created.body.job.id;
  for (let offset = 0, part = 1; offset < bytes.length; offset += created.body.chunkBytes, part++)
    await call('post', `/jobs/${id}/chunks`, 'film-owner')
      .set('Content-Type', 'application/octet-stream')
      .set('X-Part-Number', String(part))
      .send(bytes.subarray(offset, offset + created.body.chunkBytes))
      .expect(200);
  await call('post', `/jobs/${id}/prepare`, 'film-owner').expect(200);
  const ready = await settle(id, ['ready', 'failed'], 'film-owner');
  assert.equal(ready.state, 'ready', ready.error);
  assert.ok(Math.abs(ready.seconds - 150) < 0.2);

  failSection = 2;
  await call('post', `/jobs/${id}/start`, 'film-owner')
    .send({ ...settings, detail: 'rich', notes: 'The host is Pat.' })
    .expect(202);
  const stopped = await settle(id, ['failed', 'done'], 'film-owner');
  assert.equal(stopped.state, 'failed');
  assert.match(stopped.error, /topped up/);
  assert.equal(stopped.done, 1);
  assert.equal(stopped.sections, 2);
  assert.equal(stopped.resumable, true);
  assert.match(notices.at(-1).title, /stopped/);
  assert.ok([...objects.keys()].some((key) => key.endsWith(`${id}/sections/0.flac`)));

  failSection = -1;
  const analyzedBefore = calls.analyze;
  await call('post', `/jobs/${id}/resume`, 'film-owner').send({}).expect(202);
  const done = await settle(id, ['done', 'failed'], 'film-owner');
  assert.equal(done.state, 'done', done.error);
  assert.equal(
    calls.analyze - analyzedBefore,
    1,
    'only the unfinished section was described again',
  );
  assert.equal(calls.transcribe, 1, 'the dialogue was transcribed once for the whole job');
  assert.equal(done.descriptions, 2);
  assert.ok(Math.abs(done.outputSeconds - 150) < 0.1);
  assert.match(notices.at(-1).title, /ready/);
  assert.equal(notices.at(-1).url, `/described-video?id=${id}`);

  const files = (await call('get', `/jobs/${id}/files`, 'film-owner').expect(200)).body;
  for (const kind of ['video', 'audio', 'transcript', 'descriptions', 'captions', 'script'])
    assert.ok(files[kind], kind);
  assert.match(decodeURIComponent(files.videoDownload), /My film \(described\)\.mp4/);
  const transcript = await call('get', `/jobs/${id}/text/transcript`, 'film-owner').expect(200);
  assert.match(transcript.text, /Description: Section cue/);
  assert.match(transcript.text, /the host: Hello\./);
  await call('get', `/jobs/${id}/text/transcript`, 'another-owner').expect(409);

  const saved = await call('post', `/jobs/${id}/library`, 'film-owner')
    .send({ share: false, path: 'Audio/Commercials/1996' })
    .expect(200);
  assert.equal(saved.body.savedToLibrary, 'b'.repeat(24));
  assert.equal(libraryCalls[0].title, 'My film (described)');
  assert.equal(libraryCalls[0].share, false);
  assert.equal(libraryCalls[0].path, 'Audio/Commercials/1996');
  const folders = await call('get', '/library-folders', 'film-owner').expect(200);
  assert.ok(folders.body.folders.includes('Audio/Commercials/1996'));
  assert.ok(objects.has('/test/media-library/new-book/described.m4a'));

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

  const originalTranscript = await call(
    'get',
    `/jobs/${id}/text/transcript?version=1`,
    'film-owner',
  ).expect(200);
  assert.equal(
    originalTranscript.text,
    transcript.text,
    'the previous finished version remains unchanged',
  );
  await call('get', `/jobs/${id}/files?version=99`, 'film-owner').expect(409);
  await call('get', `/jobs/${id}/script`, 'another-owner').expect(409);
  const script = (await call('get', `/jobs/${id}/script`, 'film-owner').expect(200)).body;
  assert.equal(script.version, 2);
  assert.equal(script.cues.length, 2);
  const correction = {
    ...script.cues[0],
    text: 'Pat holds a blue folder.',
    shortText: 'Pat holds a folder.',
    omit: false,
  };
  await call('post', `/jobs/${id}/revoice`, 'film-owner')
    .send({ ...revoiced.settings, expectedVersion: 1, edits: [correction] })
    .expect(409);
  await call('post', `/jobs/${id}/revoice`, 'film-owner')
    .send({ ...revoiced.settings, expectedVersion: 2, edits: [{ ...correction, id: '99:99' }] })
    .expect(409);
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
  const revisedTranscript = await call('get', `/jobs/${id}/text/transcript`, 'film-owner').expect(
    200,
  );
  assert.match(revisedTranscript.text, /Pat holds a blue folder/);
  assert.doesNotMatch(originalTranscript.text, /Pat holds a blue folder/);
  await call('post', `/jobs/${id}/library`, 'film-owner')
    .send({ path: 'Audio/../Video' })
    .expect(400);
  const expiry = new Date(corrected.expiresAt).getTime();
  const beforeFresh = calls.analyze;
  await call('post', `/jobs/${id}/reanalyze`, 'film-owner')
    .send({
      ...corrected.settings,
      expectedVersion: 3,
      firstLook: true,
      notes: 'The host is Robin.',
    })
    .expect(202);
  await call('get', `/jobs/${id}/files?version=3`, 'film-owner').expect(200);
  const fresh = await settle(id, ['done', 'failed'], 'film-owner');
  assert.equal(fresh.state, 'done', fresh.error);
  assert.equal(fresh.version, 4);
  assert.equal(
    calls.analyze - beforeFresh,
    4,
    'two first-look sections and two fresh descriptions',
  );
  assert.equal(calls.transcribe, 1, 'fresh descriptions reuse the whole-film transcript');
  assert.equal(fresh.settings.notes, 'The host is Robin.');
  assert.ok([...objects.keys()].some((key) => key.endsWith(`${id}/first-look-4.json`)));
  await call('post', `/jobs/${id}/revoice`, 'film-owner')
    .send({ ...fresh.settings, expectedVersion: 4 })
    .expect(202);
  await call('post', `/jobs/${id}/cancel`, 'film-owner').expect(200);
  const cancelled = await settle(id, ['cancelled', 'failed', 'done'], 'film-owner');
  assert.ok(cancelled.copies.some((copy) => copy.version === 3));
  assert.ok(
    new Date(cancelled.expiresAt).getTime() >= expiry,
    'a cancelled new version does not shorten retention of finished copies',
  );
  await call('get', `/jobs/${id}/files?version=3`, 'film-owner').expect(200);

  const sample = await call('post', '/sample', 'film-owner')
    .send({ voice: 'Voice 1', rate: 2 })
    .expect(200);
  assert.equal(sample.headers['content-type'], 'audio/wav');
  assert.ok(sample.body.length > 44 + 48000);

  await call('delete', `/jobs/${id}`, 'film-owner').expect(200);
  assert.equal(
    [...objects.keys()].filter((key) => key.includes(id)).length,
    0,
    'every stored file of the job is gone',
  );
  assert.ok(objects.has('/test/media-library/new-book/described.m4a'), 'the library copy stays');
});

test('concurrent paid speech requests settle their reservations without losing a charge', async () => {
  await Budgets.deleteMany({});
  const source = join(root, 'budget-source.mp4');
  await command(
    ffmpegPath,
    [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-i',
      join(root, 'source.mp4'),
      '-t',
      '9',
      '-c',
      'copy',
      source,
    ],
    new AbortController().signal,
  );
  const bytes = await readFile(source);
  const id = await upload('cost-owner', 'concurrent-costs-0001', bytes.length);
  const document = await Jobs.findById(id).lean();
  objects.set(`/test/${document.key}`, bytes);
  await Jobs.updateOne({ _id: id }, { $set: { state: 'ready', seconds: 9 } });
  simulateConcurrentCosts = true;
  try {
    await call('post', `/jobs/${id}/start`, 'cost-owner').send(settings).expect(202);
    const done = await settle(id, ['done', 'failed'], 'cost-owner');
    assert.equal(done.state, 'done', done.error);
    assert.ok(Math.abs(done.costUSD - 0.02) < 1e-8, `charged ${done.costUSD}`);
    const budget = await Budgets.findById(new Date().toISOString().slice(0, 10));
    assert.ok(Math.abs(budget.reserved - 0.02) < 1e-8, `reserved ${budget.reserved}`);
  } finally {
    simulateConcurrentCosts = false;
  }
  await call('delete', `/jobs/${id}`, 'cost-owner').expect(200);
});

test('a cancelled job can be continued and goes back in the queue', async () => {
  const id = await upload('resume-owner', 'cancelled-upload-0001');
  await Jobs.updateOne(
    { _id: id },
    {
      $set: {
        state: 'cancelled',
        active: false,
        cancelRequested: true,
        seconds: 120,
        settings: { ...settings, detail: 'standard', volume: 'balanced', notes: '' },
        sections: 2,
        done: 1,
      },
    },
  );
  const listed = (await call('get', `/jobs/${id}`, 'resume-owner').expect(200)).body;
  assert.equal(listed.resumable, true);
  const resumed = await call('post', `/jobs/${id}/resume`, 'resume-owner').send({}).expect(202);
  assert.equal(resumed.body.state, 'queued');
  assert.equal(resumed.body.cancelRequested, false);
  await call('post', `/jobs/${id}/cancel`, 'resume-owner').expect(200);
  assert.equal((await Jobs.findById(id)).state, 'cancelled');
  await call('delete', `/jobs/${id}`, 'resume-owner').expect(200);
  await Budgets.deleteMany({});
});
