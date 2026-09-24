import { z } from 'zod';
import axios from 'axios';
import mongoose from 'mongoose';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router, raw } from 'express';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  GetObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { Request, RequestHandler } from 'express';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Meter, Settings } from './types';
import { describeVideo, productionProviders } from './engine';
import { importYouTube, youtubeURL } from './youtube';
import { storeAudioStream } from '../library/stream';
import { settingsSchema } from './types';
import { voices } from './providers';
import { probe } from './media';

type Actor = { id: string; role?: string };
type Hooks = {
  auth: RequestHandler;
  actor: (req: Request) => Actor;
  storage: () => S3Client;
  log: (message: string) => void;
  usage: (owner: string, job: string, kind: string, costUSD: number) => Promise<void>;
};
type Job = {
  _id: string;
  owner: string;
  name: string;
  bytes: number;
  state: string;
  active: boolean;
  key: string;
  seconds?: number;
  settings?: Settings;
  stage?: string;
  progress: number;
  costUSD: number;
  limitUSD?: number;
  budgetDay?: string;
  cancelRequested: boolean;
  worker?: string;
  lease?: Date;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  outputSeconds?: number;
  count?: number;
  skipped?: number;
  uploadId?: string;
  uploadedBytes: number;
  parts: { number: number; etag: string; bytes: number; hash: string }[];
  youtube?: string;
};
type Lock = { _id: string; worker: string; until: Date };
type Budget = { _id: string; reserved: number; jobs: string[] };
const jobSchema = new mongoose.Schema<Job>(
  {
    _id: String,
    owner: String,
    name: String,
    bytes: Number,
    state: String,
    active: Boolean,
    key: String,
    seconds: Number,
    settings: mongoose.Schema.Types.Mixed,
    stage: String,
    progress: Number,
    costUSD: Number,
    limitUSD: Number,
    budgetDay: String,
    cancelRequested: Boolean,
    worker: String,
    lease: Date,
    error: String,
    expiresAt: Date,
    outputSeconds: Number,
    count: Number,
    skipped: Number,
    uploadId: String,
    uploadedBytes: { type: Number, default: 0 },
    parts: [{ number: Number, etag: String, bytes: Number, hash: String, _id: false }],
    youtube: String,
  },
  { timestamps: true },
);
jobSchema.index(
  { owner: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);
jobSchema.index({ state: 1, createdAt: 1 });
const uploadSchema = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/),
  resumeId: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
  name: z
    .string()
    .min(1)
    .max(240)
    .refine((name) => !/[\r\n\0]/.test(name)),
  bytes: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 ** 3),
});
const terminal = ['done', 'failed', 'cancelled'];
const chunkBytes = 8 * 1024 ** 2;
const bucket = () => process.env.KADE_MEDIA_BUCKET || process.env.AWS_BUCKET_NAME || '';
const maxMinutes = () =>
  Math.min(180, Math.max(1, Number(process.env.KADE_DESCRIPTION_MAX_MINUTES) || 90));
const jobLimit = () =>
  Math.min(20, Math.max(0.1, Number(process.env.KADE_DESCRIPTION_JOB_USD) || 5));
const dailyLimit = () =>
  Math.min(100, Math.max(0.1, Number(process.env.KADE_DESCRIPTION_DAILY_USD) || 5));
const configured = () =>
  !!(process.env.OPENROUTER_KEY && process.env.DEEPGRAM_API_KEY && bucket()) &&
  process.env.KADE_DESCRIBED_VIDEO !== '0';
export const descriptionEstimate = (seconds: number): number =>
  Math.ceil(((seconds / 60) * 0.06 + 0.05) * 100) / 100;
export function descriptionJobId(owner: string, requestId: string): string {
  return createHash('sha256')
    .update(owner + ':' + requestId)
    .digest('hex')
    .slice(0, 32);
}

export function createDescriptionRouter(hooks: Hooks): { router: Router; close: () => void } {
  const Jobs =
    (mongoose.models.KadeDescriptionJob as mongoose.Model<Job>) ||
    mongoose.model<Job>('KadeDescriptionJob', jobSchema);
  const Locks =
    (mongoose.models.KadeDescriptionLock as mongoose.Model<Lock>) ||
    mongoose.model<Lock>(
      'KadeDescriptionLock',
      new mongoose.Schema<Lock>({ _id: String, worker: String, until: Date }),
    );
  const Budgets =
    (mongoose.models.KadeDescriptionBudget as mongoose.Model<Budget>) ||
    mongoose.model<Budget>(
      'KadeDescriptionBudget',
      new mongoose.Schema<Budget>({ _id: String, reserved: Number, jobs: [String] }),
    );
  const router = Router();
  const worker = randomUUID();
  let running = false;
  let initialized: Promise<void> | undefined;
  let closed = false;
  const controllers = new Map<string, AbortController>();
  const initialize = () =>
    (initialized ||= Promise.all([
      Jobs.createIndexes(),
      Locks.createIndexes(),
      Budgets.createIndexes(),
    ])
      .then(() => undefined)
      .catch((error: Error) => {
        initialized = undefined;
        throw error;
      }));
  const publicJob = (job: Job) => ({
    id: job._id,
    name: job.name,
    bytes: job.bytes,
    state: job.state,
    seconds: job.seconds,
    stage: job.stage,
    progress: job.progress,
    error: job.error,
    settings: job.settings,
    costUSD: job.costUSD,
    limitUSD: job.limitUSD,
    estimatedUSD: job.seconds ? descriptionEstimate(job.seconds) : undefined,
    outputSeconds: job.outputSeconds,
    descriptions: job.count,
    skipped: job.skipped,
    expiresAt: job.expiresAt,
    cancelRequested: job.cancelRequested,
    uploadedBytes: job.uploadedBytes || 0,
  });
  router.use(hooks.auth);
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (hooks.actor(req).role !== 'ADMIN' && process.env.KADE_DESCRIPTION_PUBLIC !== '1') {
      res.status(403).json({ error: 'Described video is currently a private owner trial.' });
      return;
    }
    next();
  });
  router.use((_req, res, next) => {
    initialize()
      .then(() => next())
      .catch(() => res.status(503).json({ error: 'Video jobs are temporarily unavailable.' }));
  });
  function route(method: 'get' | 'post' | 'delete', path: string, action: RequestHandler) {
    router[method](path, (req, res, next) => {
      Promise.resolve(action(req, res, next)).catch((error: Error) => {
        hooks.log(`description request: ${error.message}`);
        if (!res.headersSent)
          res.status(error instanceof z.ZodError ? 400 : 409).json({
            error:
              error instanceof z.ZodError
                ? error.issues.map((issue) => issue.message).join(' ')
                : error.message,
          });
      });
    });
  }
  async function owned(req: Request): Promise<Job> {
    const id = String(req.params.id || '');
    const job = /^[a-f0-9]{32}$/.test(id)
      ? await Jobs.findOne({ _id: id, owner: hooks.actor(req).id }).lean()
      : null;
    if (!job) throw new Error('Video job not found.');
    return job;
  }
  async function abortUpload(job: Job): Promise<void> {
    if (!job.uploadId) return;
    await hooks
      .storage()
      .send(
        new AbortMultipartUploadCommand({ Bucket: bucket(), Key: job.key, UploadId: job.uploadId }),
      )
      .catch((error: Error) => hooks.log('description upload cleanup: ' + error.message));
  }
  async function erase(key: string): Promise<void> {
    await hooks.storage().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  }
  async function releaseBudget(job: Job): Promise<void> {
    if (!job.budgetDay || !job.limitUSD) return;
    await Budgets.updateOne(
      { _id: job.budgetDay, jobs: job._id },
      { $inc: { reserved: -Math.max(0, job.limitUSD - job.costUSD) }, $pull: { jobs: job._id } },
    );
  }
  route('get', '/config', async (_req, res) => {
    res.json({
      enabled: configured(),
      maxBytes: 2 * 1024 ** 3,
      chunkBytes,
      maxMinutes: maxMinutes(),
      limitUSD: jobLimit(),
      dailyUSD: dailyLimit(),
      ...(await voices()),
    });
  });
  route('get', '/jobs', async (req, res) => {
    const jobs = await Jobs.find({ owner: hooks.actor(req).id })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();
    res.json({ jobs: jobs.map(publicJob) });
  });
  route('get', '/jobs/:id', async (req, res) => {
    res.json(publicJob(await owned(req)));
  });
  route('post', '/uploads', async (req, res) => {
    if (!configured()) throw new Error('Video description is not configured yet.');
    const input = uploadSchema.parse(req.body);
    const owner = hooks.actor(req).id;
    const id = input.resumeId || descriptionJobId(owner, input.requestId);
    let job = await Jobs.findOne({ _id: id, owner }).lean();
    if (input.resumeId && !job) throw new Error('Video upload not found.');
    if (!job) {
      try {
        job = (
          await Jobs.create({
            _id: id,
            owner,
            name: input.name,
            bytes: input.bytes,
            key: `described-video/${owner}/${id}/source`,
            state: 'uploading',
            active: true,
            progress: 0,
            costUSD: 0,
            cancelRequested: false,
            expiresAt: new Date(Date.now() + 86400000),
          })
        ).toObject();
      } catch {
        throw new Error('Finish or cancel your existing video job before uploading another.');
      }
    }
    if (job.bytes !== input.bytes || job.name !== input.name)
      throw new Error('This upload recovery ID belongs to another file.');
    if (job.state === 'uploading' && !job.uploadId) {
      const opened = await hooks.storage().send(
        new CreateMultipartUploadCommand({
          Bucket: bucket(),
          Key: job.key,
          ContentType: 'application/octet-stream',
        }),
      );
      if (!opened.UploadId) throw new Error('Could not begin the video upload.');
      const saved = await Jobs.updateOne(
        { _id: job._id, state: 'uploading', uploadId: { $exists: false } },
        { $set: { uploadId: opened.UploadId } },
      );
      if (!saved.modifiedCount) await abortUpload({ ...job, uploadId: opened.UploadId });
      job = (await Jobs.findById(job._id).lean()) || job;
    }
    res.json({ job: publicJob(job), chunkBytes });
  });
  route('post', '/imports', async (req, res) => {
    if (!configured()) throw new Error('Video description is not configured yet.');
    const input = z
      .object({
        url: z.string().min(1).max(2048),
        requestId: z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/),
      })
      .parse(req.body);
    const url = youtubeURL(input.url);
    const owner = hooks.actor(req).id;
    const id = descriptionJobId(owner, 'youtube:' + input.requestId);
    let job = await Jobs.findOne({ _id: id, owner }).lean();
    if (!job) {
      try {
        job = (
          await Jobs.create({
            _id: id,
            owner,
            name: 'YouTube video',
            bytes: 0,
            youtube: url,
            key: `described-video/${owner}/${id}/source`,
            state: 'importing',
            active: true,
            progress: 0,
            costUSD: 0,
            cancelRequested: false,
            stage: 'Waiting to import the YouTube video',
            expiresAt: new Date(Date.now() + 86400000),
          })
        ).toObject();
      } catch {
        throw new Error('Finish or cancel your existing video job before importing another.');
      }
    }
    if (job.youtube !== url) throw new Error('This import recovery ID belongs to another video.');
    res.status(202).json(publicJob(job));
    void tick();
  });
  router.use('/jobs/:id/chunks', raw({ type: 'application/octet-stream', limit: chunkBytes }));
  route('post', '/jobs/:id/chunks', async (req, res) => {
    const job = await owned(req);
    if (job.state !== 'uploading' || !job.uploadId)
      throw new Error('This upload is no longer active.');
    const number = Number(req.get('X-Part-Number'));
    if (
      !Number.isInteger(number) ||
      number < 1 ||
      number > Math.ceil(job.bytes / chunkBytes) ||
      !Buffer.isBuffer(req.body)
    )
      throw new Error('Invalid video upload chunk.');
    const bytes = req.body.length;
    const expected = Math.min(chunkBytes, job.bytes - (number - 1) * chunkBytes);
    if (bytes !== expected) throw new Error('The video chunk has an unexpected size.');
    const hash = createHash('sha256').update(req.body).digest('hex');
    const previous = job.parts.find((part) => part.number === number);
    if (previous) {
      if (previous.hash !== hash)
        throw new Error('Choose the original file to resume this upload.');
      res.json(publicJob(job));
      return;
    }
    if (number !== job.parts.length + 1)
      throw new Error('Resume the upload from its last saved chunk.');
    const uploaded = await hooks.storage().send(
      new UploadPartCommand({
        Bucket: bucket(),
        Key: job.key,
        UploadId: job.uploadId,
        PartNumber: number,
        Body: req.body,
      }),
    );
    if (!uploaded.ETag) throw new Error('Storage did not acknowledge the video chunk.');
    await Jobs.updateOne(
      { _id: job._id, state: 'uploading', uploadedBytes: job.uploadedBytes },
      {
        $push: { parts: { number, etag: uploaded.ETag, bytes, hash } },
        $inc: { uploadedBytes: bytes },
      },
    );
    res.json(publicJob(await owned(req)));
  });
  route('post', '/jobs/:id/prepare', async (req, res) => {
    const job = await owned(req);
    if (job.state === 'uploading') {
      if (job.uploadedBytes !== job.bytes || !job.uploadId)
        throw new Error('The upload is incomplete. Choose the same file to resume.');
      const existing = await hooks
        .storage()
        .send(new HeadObjectCommand({ Bucket: bucket(), Key: job.key }))
        .catch(() => null);
      if (!existing)
        await hooks.storage().send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket(),
            Key: job.key,
            UploadId: job.uploadId,
            MultipartUpload: {
              Parts: job.parts.map((part) => ({ PartNumber: part.number, ETag: part.etag })),
            },
          }),
        );
      const stored = await hooks
        .storage()
        .send(new HeadObjectCommand({ Bucket: bucket(), Key: job.key }));
      if (stored.ContentLength !== job.bytes)
        throw new Error('The upload is incomplete. Choose the file again to retry.');
      await Jobs.updateOne(
        { _id: job._id, state: 'uploading' },
        {
          $set: { state: 'checking', stage: 'Waiting to check the uploaded video' },
          $unset: { uploadId: 1, parts: 1 },
        },
      );
    }
    res.json(publicJob(await owned(req)));
    void tick();
  });
  route('post', '/jobs/:id/start', async (req, res) => {
    if (!configured()) throw new Error('Video description is not available.');
    const job = await owned(req);
    if (['reserving', 'queued', 'running', 'done'].includes(job.state)) {
      res.json(publicJob(job));
      return;
    }
    if (job.state !== 'ready' || !job.seconds)
      throw new Error('Wait for the uploaded video to finish checking.');
    const settings = settingsSchema.parse(req.body);
    if (!(await voices()).voices.includes(settings.voice))
      throw new Error('Choose an existing platform voice.');
    const day = new Date().toISOString().slice(0, 10);
    let limit = jobLimit();
    const claimed = await Jobs.findOneAndUpdate(
      { _id: job._id, state: 'ready' },
      { $set: { state: 'reserving', settings, budgetDay: day, limitUSD: limit } },
      { new: true },
    ).lean();
    if (!claimed) {
      res.json(publicJob(await owned(req)));
      return;
    }
    await Budgets.updateOne(
      { _id: day },
      { $setOnInsert: { reserved: 0, jobs: [] } },
      { upsert: true },
    );
    const currentBudget = await Budgets.findById(day).lean();
    limit = Math.min(
      limit,
      Math.floor((dailyLimit() - (currentBudget?.reserved || 0)) * 100) / 100,
    );
    if (limit < 0.1) {
      await Jobs.updateOne(
        { _id: job._id, state: 'reserving' },
        { $set: { state: 'ready' }, $unset: { budgetDay: 1, limitUSD: 1 } },
      );
      throw new Error(
        'The daily processing allowance is currently reserved or used. Try another day.',
      );
    }
    claimed.limitUSD = limit;
    await Jobs.updateOne({ _id: job._id, state: 'reserving' }, { $set: { limitUSD: limit } });
    const reservation = await Budgets.updateOne(
      { _id: day, jobs: { $ne: job._id }, reserved: { $lte: dailyLimit() - limit + 1e-8 } },
      { $inc: { reserved: limit }, $push: { jobs: job._id } },
    );
    if (!reservation.modifiedCount) {
      await Jobs.updateOne(
        { _id: job._id, state: 'reserving' },
        { $set: { state: 'ready' }, $unset: { budgetDay: 1, limitUSD: 1 } },
      );
      throw new Error(
        'The daily processing allowance is currently reserved or used. Try another day.',
      );
    }
    const queued = await Jobs.updateOne(
      { _id: job._id, state: 'reserving', cancelRequested: false },
      { $set: { state: 'queued', stage: 'Waiting to create your described copy' } },
    );
    if (!queued.matchedCount) await releaseBudget(claimed);
    res.status(202).json(publicJob(await owned(req)));
    void tick();
  });
  route('post', '/jobs/:id/cancel', async (req, res) => {
    const job = await owned(req);
    if (!terminal.includes(job.state)) {
      if (job.worker && job.lease && job.lease > new Date()) {
        await Jobs.updateOne({ _id: job._id }, { $set: { cancelRequested: true } });
        controllers.get(job._id)?.abort();
      } else {
        const cancelled = await Jobs.findOneAndUpdate(
          {
            _id: job._id,
            state: { $nin: [...terminal, 'running', 'deleting'] },
            $or: [{ worker: { $exists: false } }, { lease: { $lt: new Date() } }],
          },
          {
            $set: { state: 'cancelled', active: false, cancelRequested: true, stage: 'Cancelled' },
          },
          { new: true },
        ).lean();
        if (cancelled) {
          await releaseBudget(cancelled);
          await abortUpload(cancelled);
        } else {
          await Jobs.updateOne({ _id: job._id, active: true }, { $set: { cancelRequested: true } });
          controllers.get(job._id)?.abort();
        }
      }
    }
    res.json(publicJob(await owned(req)));
  });
  route('delete', '/jobs/:id', async (req, res) => {
    const job = await owned(req);
    const deleting = await Jobs.findOneAndUpdate(
      { _id: job._id, state: { $in: [...terminal, 'ready', 'uploading', 'deleting'] } },
      { $set: { state: 'deleting', active: false } },
      { new: true },
    ).lean();
    if (!deleting) throw new Error('Cancel processing and wait for it to stop before deleting.');
    await abortUpload(job);
    for (const suffix of ['source', 'described.mp4', 'described.m4a', 'description.json'])
      await erase(job.key.replace(/source$/, suffix));
    await Jobs.deleteOne({ _id: job._id, owner: job.owner });
    res.json({ ok: true });
  });
  route('get', '/jobs/:id/files', async (req, res) => {
    const job = await owned(req);
    if (job.state !== 'done') throw new Error('The described copy is not ready yet.');
    const client = hooks.storage();
    const result: Record<string, string> = {};
    for (const [kind, suffix, mime] of [
      ['video', 'described.mp4', 'video/mp4'],
      ['audio', 'described.m4a', 'audio/mp4'],
      ['script', 'description.json', 'application/json'],
    ]) {
      const base = {
        Bucket: bucket(),
        Key: job.key.replace(/source$/, suffix),
        ResponseContentType: mime,
      };
      result[kind] = await getSignedUrl(client, new GetObjectCommand(base), { expiresIn: 3600 });
      result[kind + 'Download'] = await getSignedUrl(
        client,
        new GetObjectCommand({
          ...base,
          ResponseContentDisposition: `attachment; filename="${suffix}"`,
        }),
        { expiresIn: 3600 },
      );
    }
    res.json(result);
  });

  async function download(job: Job, file: string, signal: AbortSignal): Promise<void> {
    const output = await hooks
      .storage()
      .send(new GetObjectCommand({ Bucket: bucket(), Key: job.key }), { abortSignal: signal });
    if (!(output.Body instanceof Readable)) throw new Error('Video storage returned no stream.');
    if (output.ContentLength !== job.bytes) {
      output.Body.destroy();
      throw new Error('The stored video size changed.');
    }
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        done(received > job.bytes ? new Error('Video exceeds declared size.') : null, chunk);
      },
    });
    await pipeline(output.Body, limiter, createWriteStream(file), { signal });
    if (received !== job.bytes) throw new Error('The stored video was incomplete.');
  }
  async function work(job: Job): Promise<void> {
    const controller = new AbortController();
    controllers.set(job._id, controller);
    const deadline = setTimeout(
      () => controller.abort(new Error('The job exceeded its processing time limit.')),
      4 * 3600000,
    );
    deadline.unref();
    const heartbeat = setInterval(() => {
      void (async () => {
        const current = await Jobs.findById(job._id).lean();
        if (!current || current.cancelRequested || !configured() || current.worker !== worker) {
          controller.abort();
          return;
        }
        const lease = new Date(Date.now() + 90000);
        const lock = await Locks.updateOne({ _id: 'video', worker }, { $set: { until: lease } });
        if (!lock.modifiedCount) {
          controller.abort();
          return;
        }
        await Jobs.updateOne({ _id: job._id, worker }, { $set: { lease } });
      })().catch(() => controller.abort());
    }, 10000);
    heartbeat.unref();
    let directory = '';
    try {
      directory = await mkdtemp(join(tmpdir(), 'kade-described-video-'));
      let source = join(directory, 'source');
      const progress = async (stage: string, value: number) => {
        controller.signal.throwIfAborted();
        const updated = await Jobs.updateOne(
          { _id: job._id, worker, cancelRequested: false },
          { $set: { stage, progress: Math.round(value) } },
        );
        if (!updated.matchedCount) {
          controller.abort();
          controller.signal.throwIfAborted();
        }
      };
      if (job.state === 'importing' && job.youtube) {
        await progress('Importing the YouTube video', 1);
        const imported = await importYouTube(
          job.youtube,
          directory,
          maxMinutes() * 60,
          controller.signal,
        );
        source = imported.file;
        job.bytes = imported.bytes;
        job.name = imported.name;
        await progress('Saving your imported video', 5);
        await storeAudioStream(
          hooks.storage(),
          bucket(),
          job.key,
          createReadStream(source),
          'video/mp4',
        );
      } else {
        await progress('Reading your uploaded video', 1);
        await download(job, source, controller.signal);
      }
      const media = await probe(source, controller.signal);
      if (media.seconds > maxMinutes() * 60)
        throw new Error(`Videos are limited to ${maxMinutes()} minutes in this trial.`);
      if (['checking', 'importing'].includes(job.state)) {
        const saved = await Jobs.updateOne(
          { _id: job._id, worker, cancelRequested: false },
          {
            $set: {
              state: 'ready',
              name: job.name,
              bytes: job.bytes,
              seconds: media.seconds,
              stage: 'Ready to describe',
              progress: 0,
            },
            $unset: { worker: 1, lease: 1 },
          },
        );
        if (!saved.matchedCount) throw new Error('Video checking was cancelled.');
        return;
      }
      if (!job.settings || !job.limitUSD)
        throw new Error('This job has no saved narration settings or spending allowance.');
      const meter: Meter = async (kind, reserveUSD, action) => {
        controller.signal.throwIfAborted();
        if (
          !Number.isFinite(reserveUSD) ||
          reserveUSD < 0 ||
          job.costUSD + reserveUSD > job.limitUSD!
        )
          throw new Error(
            'The job reached its processing allowance. No further paid requests were sent.',
          );
        job.costUSD += reserveUSD;
        const reserved = await Jobs.updateOne(
          { _id: job._id, worker, cancelRequested: false },
          { $set: { costUSD: job.costUSD } },
        );
        if (!reserved.matchedCount)
          throw new Error('Processing stopped before the next paid request.');
        let result: { costUSD: number };
        try {
          result = await action();
        } catch (error) {
          await hooks.usage(job.owner, job._id, `${kind}-uncertain`, reserveUSD).catch(() => {});
          throw error;
        }
        job.costUSD = Math.max(0, job.costUSD - reserveUSD + result.costUSD);
        await Jobs.updateOne({ _id: job._id, worker }, { $set: { costUSD: job.costUSD } });
        await hooks
          .usage(job.owner, job._id, kind, result.costUSD)
          .catch((error: Error) => hooks.log('description usage: ' + error.message));
      };
      const output = await describeVideo(
        source,
        directory,
        job.settings,
        `video:${job._id}`,
        controller.signal,
        meter,
        progress,
        productionProviders,
      );
      for (const [file, suffix, mime] of [
        [output.video, 'described.mp4', 'video/mp4'],
        [output.audio, 'described.m4a', 'audio/mp4'],
        [output.reportFile, 'description.json', 'application/json'],
      ]) {
        controller.signal.throwIfAborted();
        if ((await stat(file)).size > 4 * 1024 ** 3)
          throw new Error('The described output exceeded the storage limit.');
        await storeAudioStream(
          hooks.storage(),
          bucket(),
          job.key.replace(/source$/, suffix),
          createReadStream(file),
          mime,
        );
      }
      controller.signal.throwIfAborted();
      const saved = await Jobs.updateOne(
        { _id: job._id, worker, cancelRequested: false },
        {
          $set: {
            state: 'done',
            active: false,
            stage: 'Your described copy is ready',
            progress: 100,
            outputSeconds: output.report.outputSeconds,
            count: output.report.descriptions.length,
            skipped: output.report.skipped.length,
            expiresAt: new Date(Date.now() + 7 * 86400000),
          },
          $unset: { worker: 1, lease: 1 },
        },
      );
      if (!saved.matchedCount) throw new Error('Video processing was cancelled.');
      await erase(job.key).catch((error: Error) =>
        hooks.log('description source cleanup: ' + error.message),
      );
    } catch (error) {
      const current = await Jobs.findById(job._id).lean();
      const cancelled = !!current?.cancelRequested;
      const detail = error instanceof Error ? error.message : 'Video processing failed.';
      hooks.log(`description ${job._id}: ${detail}`);
      const message = axios.isAxiosError(error)
        ? `A processing provider did not complete the request (${error.response?.status || 'connection interrupted'}). No automatic paid retry was made.`
        : detail.slice(0, 500);
      await Jobs.updateOne(
        { _id: job._id, worker },
        {
          $set: {
            state: cancelled ? 'cancelled' : 'failed',
            active: false,
            stage: cancelled ? 'Cancelled' : 'Could not finish the described copy',
            error: cancelled
              ? 'Processing stopped. Work already sent to providers may still be charged.'
              : message,
          },
          $unset: { worker: 1, lease: 1 },
        },
      );
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      controllers.delete(job._id);
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      const current = await Jobs.findById(job._id).lean();
      if (current && terminal.includes(current.state)) await releaseBudget(current);
    }
  }
  async function tick(): Promise<void> {
    if (closed || running || mongoose.connection.readyState !== 1) return;
    running = true;
    try {
      await initialize();
      await Locks.updateOne(
        { _id: 'video' },
        { $setOnInsert: { worker: '', until: new Date(0) } },
        { upsert: true },
      );
      const lock = await Locks.findOneAndUpdate(
        { _id: 'video', until: { $lt: new Date() } },
        { $set: { worker, until: new Date(Date.now() + 90000) } },
        { new: true },
      ).lean();
      if (!lock) return;
      const interrupted = await Jobs.find({
        state: { $in: ['running', 'checking', 'importing', 'reserving'] },
        updatedAt: { $lt: new Date(Date.now() - 120000) },
        $or: [{ lease: { $lt: new Date() } }, { lease: { $exists: false } }],
      }).lean();
      for (const job of interrupted) {
        if (['checking', 'importing'].includes(job.state)) {
          await Jobs.updateOne({ _id: job._id }, { $unset: { worker: 1, lease: 1 } });
          continue;
        }
        await Jobs.updateOne(
          { _id: job._id },
          {
            $set: {
              state: 'failed',
              active: false,
              error:
                'Processing was interrupted by a server restart. No paid work was automatically repeated.',
            },
            $unset: { worker: 1, lease: 1 },
          },
        );
        await releaseBudget(job);
      }
      const expired = await Jobs.find({
        expiresAt: { $lt: new Date() },
        state: { $nin: ['running', 'checking', 'importing', 'queued', 'reserving'] },
      })
        .limit(10)
        .lean();
      for (const job of expired) {
        await abortUpload(job);
        for (const suffix of ['source', 'described.mp4', 'described.m4a', 'description.json'])
          await erase(job.key.replace(/source$/, suffix));
        await Jobs.deleteOne({ _id: job._id });
      }
      if (!configured()) return;
      const job = await Jobs.findOneAndUpdate(
        {
          state: { $in: ['checking', 'importing', 'queued'] },
          cancelRequested: false,
          $or: [{ worker: { $exists: false } }, { lease: { $lt: new Date() } }],
        },
        { $set: { worker, lease: new Date(Date.now() + 90000) } },
        { new: true, sort: { createdAt: 1 } },
      ).lean();
      if (!job) return;
      if (job.state === 'queued') {
        job.state = 'running';
        await Jobs.updateOne({ _id: job._id, worker }, { $set: { state: 'running' } });
      }
      await work(job);
    } catch (error) {
      hooks.log('description worker: ' + (error instanceof Error ? error.message : 'failed'));
    } finally {
      await Locks.updateOne({ _id: 'video', worker }, { $set: { until: new Date(0) } }).catch(
        () => {},
      );
      running = false;
    }
  }
  const timer = setInterval(() => {
    void tick();
  }, 15000);
  timer.unref();
  return {
    router,
    close: () => {
      closed = true;
      clearInterval(timer);
      for (const controller of controllers.values()) controller.abort();
    },
  };
}
