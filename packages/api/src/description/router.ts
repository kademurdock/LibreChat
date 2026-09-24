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
  PutObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
  UploadPartCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import type { Request, RequestHandler } from 'express';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Analysis, Meter, Plan, SectionRecord, Settings, Word } from './types';
import type { Keeper, Providers } from './engine';
import { speechPerByte, transcriptionPerMinute, voices, synthesize } from './providers';
import { describeVideo, productionProviders } from './engine';
import { decodeVoice, probe, stretch } from './media';
import { importYouTube, youtubeURL } from './youtube';
import { storeAudioStream } from '../library/stream';
import { settingsSchema, Halt } from './types';
import { spokenLength } from './transcript';
import { sampleRate } from './mix';

type Actor = { id: string; role?: string };
/** A library track the owner may describe, found and checked by the library's own access rules. */
type LibrarySource = { key: string; bytes: number; title: string; about: string };
type LibraryHooks = {
  open: (req: Request, book: string, track: number) => Promise<LibrarySource>;
  save: (input: {
    owner: string;
    title: string;
    seconds: number;
    bytes: number;
    share: boolean;
    kind: string;
    copy: (target: string) => Promise<void>;
  }) => Promise<{ id: string; path: string }>;
};
type Hooks = {
  auth: RequestHandler;
  actor: (req: Request) => Actor;
  storage: () => S3Client;
  log: (message: string) => void;
  usage: (owner: string, job: string, kind: string, costUSD: number) => Promise<void>;
  notify?: (owner: string, title: string, body: string, url: string) => Promise<void>;
  library?: LibraryHooks;
  providers?: Providers;
};
type Part = { number: number; etag: string; bytes: number; hash: string };
type Job = {
  _id: string;
  owner: string;
  name: string;
  bytes: number;
  state: string;
  active: boolean;
  key: string;
  source?: 'upload' | 'youtube' | 'library';
  sourceKey?: string;
  about?: string;
  seconds?: number;
  settings?: Settings;
  stage?: string;
  progress: number;
  costUSD: number;
  /** Spent and set aside in the current run, against `budgetDay`'s allowance. */
  runCost?: number;
  reserved?: number;
  limitUSD?: number;
  budgetDay?: string;
  cancelRequested: boolean;
  worker?: string;
  lease?: Date;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  startedAt?: Date;
  runAt?: Date;
  runFrom?: number;
  finishedAt?: Date;
  outputSeconds?: number;
  count?: number;
  skipped?: number;
  failedSections?: number;
  sections?: number;
  done?: number;
  resumes?: number;
  version?: number;
  revoice?: boolean;
  kind?: string;
  savedToLibrary?: string;
  uploadId?: string;
  uploadedBytes: number;
  parts: Part[];
  youtube?: string;
  library?: { book: string; track: number };
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
    source: String,
    sourceKey: String,
    about: String,
    seconds: Number,
    settings: mongoose.Schema.Types.Mixed,
    stage: String,
    progress: Number,
    costUSD: Number,
    runCost: Number,
    reserved: Number,
    limitUSD: Number,
    budgetDay: String,
    cancelRequested: Boolean,
    worker: String,
    lease: Date,
    error: String,
    expiresAt: Date,
    startedAt: Date,
    runAt: Date,
    runFrom: Number,
    finishedAt: Date,
    outputSeconds: Number,
    count: Number,
    skipped: Number,
    failedSections: Number,
    sections: Number,
    done: Number,
    resumes: Number,
    version: Number,
    revoice: Boolean,
    kind: String,
    savedToLibrary: String,
    uploadId: String,
    uploadedBytes: { type: Number, default: 0 },
    parts: [{ number: Number, etag: String, bytes: Number, hash: String, _id: false }],
    youtube: String,
    library: { book: String, track: Number },
  },
  { timestamps: true },
);
jobSchema.index({ owner: 1, createdAt: -1 });
jobSchema.index({ state: 1, createdAt: 1 });
const requestId = z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/);
const uploadSchema = z.object({
  requestId,
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
const busy = ['reserving', 'queued', 'running'];
const chunkBytes = 8 * 1024 ** 2;
const maxUnfinished = 10;
const day = 86400000;
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
const today = () => new Date().toISOString().slice(0, 10);
const cents = (value: number) => Math.ceil(value * 100) / 100;

/** Descriptions per minute of video at each detail level, for estimates only. */
const cuesPerMinute: Record<Settings['detail'], number> = { essential: 8, standard: 13, rich: 20 };
const speechPerMinute = (detail: Settings['detail']) => cuesPerMinute[detail] * 130 * speechPerByte;
/** Conservative processing estimate: vision, speech at Fish's price, and dialogue timing. */
export const descriptionEstimate = (
  seconds: number,
  detail: Settings['detail'] = 'standard',
): number =>
  cents((seconds / 60) * (0.022 + speechPerMinute(detail) + transcriptionPerMinute) + 0.03);
const revoiceEstimate = (seconds: number, detail: Settings['detail']) =>
  cents((seconds / 60) * speechPerMinute(detail) + 0.02);
export function descriptionJobId(owner: string, id: string): string {
  return createHash('sha256')
    .update(owner + ':' + id)
    .digest('hex')
    .slice(0, 32);
}
const folder = (job: Pick<Job, 'key'>) => job.key.replace(/\/source$/, '');
const plainName = (name: string) =>
  name
    .replace(/\.(mp4|m4v|mov|mkv|webm|avi|wmv|mpg|mpeg|flv|3gp|ts)$/i, '')
    .replace(/[\r\n\0]/g, ' ')
    .trim()
    .slice(0, 200) || 'Video';
const outputs = [
  { kind: 'video', file: 'described.mp4', mime: 'video/mp4', label: 'described', ext: 'mp4' },
  { kind: 'audio', file: 'described.m4a', mime: 'audio/mp4', label: 'described audio', ext: 'm4a' },
  {
    kind: 'transcript',
    file: 'transcript.txt',
    mime: 'text/plain; charset=utf-8',
    label: 'described transcript',
    ext: 'txt',
  },
  {
    kind: 'descriptions',
    file: 'descriptions.vtt',
    mime: 'text/vtt; charset=utf-8',
    label: 'descriptions',
    ext: 'vtt',
  },
  {
    kind: 'captions',
    file: 'captions.vtt',
    mime: 'text/vtt; charset=utf-8',
    label: 'captions',
    ext: 'vtt',
  },
  {
    kind: 'script',
    file: 'description.json',
    mime: 'application/json',
    label: 'timing report',
    ext: 'json',
  },
] as const;
const sampleText =
  'A woman in a yellow raincoat hurries across the wet street, glances back once, and ducks into a small bookshop.';
class Shutdown extends Error {}

export function createDescriptionRouter(hooks: Hooks): {
  router: Router;
  close: () => Promise<void>;
  tick: () => Promise<void>;
} {
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
  const lanes = {
    check: { lock: 'video-check', states: ['checking', 'importing'], running: false },
    render: { lock: 'video', states: ['queued'], running: false },
  };
  let initialized: Promise<void> | undefined;
  let closed = false;
  const inflight = new Set<Promise<void>>();
  const controllers = new Map<string, AbortController>();
  const samples = new Map<string, Buffer>();
  const sampleUse = new Map<string, number[]>();
  const initialize = () =>
    (initialized ||= (async () => {
      await Jobs.collection.dropIndex('owner_1_active_1').catch(() => {});
      await Promise.all([Jobs.createIndexes(), Locks.createIndexes(), Budgets.createIndexes()]);
    })().catch((error: Error) => {
      initialized = undefined;
      throw error;
    }));
  const storage = () => hooks.storage();

  const eta = (job: Job) => {
    if (job.state !== 'running' || !job.runAt) return undefined;
    const done = job.progress - (job.runFrom || 0);
    if (done < 3) return undefined;
    const elapsed = (Date.now() - new Date(job.runAt).getTime()) / 1000;
    return Math.round((elapsed * (100 - job.progress)) / done);
  };
  const publicJob = (job: Job) => ({
    id: job._id,
    name: job.name,
    bytes: job.bytes,
    state: job.state,
    source: job.source || (job.youtube ? 'youtube' : 'upload'),
    seconds: job.seconds,
    stage: job.stage,
    progress: job.progress,
    etaSeconds: eta(job),
    error: job.error,
    settings: job.settings,
    costUSD: job.costUSD,
    limitUSD: job.reserved ?? job.limitUSD,
    estimatedUSD: job.seconds ? descriptionEstimate(job.seconds, job.settings?.detail) : undefined,
    outputSeconds: job.outputSeconds,
    descriptions: job.count,
    skipped: job.skipped,
    failedSections: job.failedSections,
    sections: job.sections,
    done: job.done,
    resumable: ['failed', 'cancelled'].includes(job.state) && !!job.settings && !!job.seconds,
    version: job.version || 1,
    kind: job.kind,
    savedToLibrary: job.savedToLibrary,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
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
  async function roomFor(owner: string): Promise<void> {
    if ((await Jobs.countDocuments({ owner, active: true })) >= maxUnfinished)
      throw new Error(
        `You have ${maxUnfinished} videos waiting or in progress. Finish, cancel or delete one first.`,
      );
  }
  /** Creates a job once per request ID; a repeated request returns the same job. */
  async function createOnce(id: string, owner: string, fields: Partial<Job>): Promise<Job> {
    const existing = await Jobs.findOne({ _id: id, owner }).lean();
    if (existing) return existing;
    await roomFor(owner);
    try {
      return (
        await Jobs.create({
          _id: id,
          owner,
          key: `described-video/${owner}/${id}/source`,
          active: true,
          progress: 0,
          costUSD: 0,
          cancelRequested: false,
          version: 1,
          resumes: 0,
          expiresAt: new Date(Date.now() + day),
          ...fields,
        })
      ).toObject();
    } catch (error) {
      const again = await Jobs.findOne({ _id: id, owner }).lean();
      if (again) return again;
      throw error;
    }
  }

  async function abortUpload(job: Job): Promise<void> {
    if (!job.uploadId) return;
    await storage()
      .send(
        new AbortMultipartUploadCommand({ Bucket: bucket(), Key: job.key, UploadId: job.uploadId }),
      )
      .catch((error: Error) => hooks.log('description upload cleanup: ' + error.message));
  }
  /** Removes everything this job stored. A library original is never touched. */
  async function eraseAll(job: Job): Promise<void> {
    const prefix = folder(job) + '/';
    let token: string | undefined;
    do {
      const page = await storage().send(
        new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }),
      );
      for (const item of page.Contents || [])
        if (item.Key && item.Key.startsWith(prefix) && item.Key !== job.sourceKey)
          await storage().send(new DeleteObjectCommand({ Bucket: bucket(), Key: item.Key }));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
  async function readText(key: string): Promise<string | null> {
    try {
      const output = await storage().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
      if (!output.Body || !(output.Body instanceof Readable)) return null;
      const chunks: Buffer[] = [];
      for await (const chunk of output.Body) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (status === 404 || (error as Error).name === 'NoSuchKey') return null;
      throw error;
    }
  }
  const putText = (key: string, body: string, mime = 'application/json') =>
    storage().send(
      new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: mime }),
    );
  async function exists(key: string): Promise<boolean> {
    return storage()
      .send(new HeadObjectCommand({ Bucket: bucket(), Key: key }))
      .then(() => true)
      .catch(() => false);
  }
  async function fetchObject(key: string, file: string, signal: AbortSignal, bytes?: number) {
    const output = await storage().send(new GetObjectCommand({ Bucket: bucket(), Key: key }), {
      abortSignal: signal,
    });
    if (!(output.Body instanceof Readable)) throw new Error('Video storage returned no stream.');
    if (bytes !== undefined && output.ContentLength !== bytes) {
      output.Body.destroy();
      throw new Error('The stored video size changed.');
    }
    let received = 0;
    const limit = bytes ?? 8 * 1024 ** 3;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        done(
          received > limit ? new Error('The stored file is larger than expected.') : null,
          chunk,
        );
      },
    });
    await pipeline(output.Body, limiter, createWriteStream(file), { signal });
    if (bytes !== undefined && received !== bytes)
      throw new Error('The stored video was incomplete.');
  }
  const putFile = (key: string, file: string, mime: string) =>
    storeAudioStream(storage(), bucket(), key, createReadStream(file), mime);

  async function releaseBudget(job: Job): Promise<void> {
    const reserved = job.reserved ?? job.limitUSD;
    if (!job.budgetDay || !reserved) return;
    const spent = job.runCost ?? job.costUSD;
    await Budgets.updateOne(
      { _id: job.budgetDay, jobs: job._id },
      { $inc: { reserved: -Math.max(0, reserved - spent) }, $pull: { jobs: job._id } },
    );
  }
  async function remaining(): Promise<number> {
    const budget = await Budgets.findById(today()).lean();
    return Math.max(0, dailyLimit() - (budget?.reserved || 0));
  }
  /** Sets money aside from one day's allowance, all or nothing. */
  async function setAside(job: Job, amount: number, date: string): Promise<boolean> {
    await Budgets.updateOne(
      { _id: date },
      { $setOnInsert: { reserved: 0, jobs: [] } },
      { upsert: true },
    );
    const taken = await Budgets.updateOne(
      { _id: date, reserved: { $lte: dailyLimit() - amount + 1e-8 } },
      { $inc: { reserved: amount }, $addToSet: { jobs: job._id } },
    );
    return taken.modifiedCount > 0;
  }

  /**
   * Moves a job from one of `from` into the paid queue once, whatever the number of clicks,
   * setting aside its estimated cost from today's allowance.
   */
  async function enqueue(
    req: Request,
    from: string[],
    settings: Settings,
    estimate: number,
    patch: Partial<Job>,
  ): Promise<Job> {
    const job = await owned(req);
    const date = today();
    const claimed = await Jobs.findOneAndUpdate(
      { _id: job._id, state: { $in: from } },
      { $set: { state: 'reserving', cancelRequested: false } },
      { new: true },
    ).lean();
    if (!claimed) return owned(req);
    const amount = Math.min(jobLimit(), cents(Math.max(0.1, estimate * 1.25 + 0.05)));
    if (!(await setAside(claimed, amount, date))) {
      await Jobs.updateOne({ _id: job._id, state: 'reserving' }, { $set: { state: job.state } });
      const left = await remaining();
      throw new Error(
        `This needs about $${amount.toFixed(2)} set aside, and $${left.toFixed(2)} of today's $${dailyLimit().toFixed(2)} processing allowance is left. Try a shorter video or another day.`,
      );
    }
    const queued = await Jobs.findOneAndUpdate(
      { _id: job._id, state: 'reserving', cancelRequested: false },
      {
        $set: {
          ...patch,
          state: 'queued',
          active: true,
          settings,
          budgetDay: date,
          reserved: amount,
          runCost: 0,
          stage: 'Waiting for its turn',
          error: '',
          expiresAt: new Date(Date.now() + 3 * day),
        },
        $unset: { limitUSD: 1 },
      },
      { new: true },
    ).lean();
    if (!queued) await releaseBudget({ ...claimed, budgetDay: date, reserved: amount, runCost: 0 });
    void tick();
    return queued || owned(req);
  }

  route('get', '/config', async (_req, res) => {
    const catalog = await voices();
    res.json({
      enabled: configured(),
      maxBytes: 2 * 1024 ** 3,
      chunkBytes,
      maxMinutes: maxMinutes(),
      limitUSD: jobLimit(),
      dailyUSD: dailyLimit(),
      remainingUSD: await remaining(),
      perMinuteUSD: {
        essential: descriptionEstimate(60, 'essential') - 0.03,
        standard: descriptionEstimate(60, 'standard') - 0.03,
        rich: descriptionEstimate(60, 'rich') - 0.03,
      },
      library: !!hooks.library,
      defaultVoice:
        catalog.voices.find((voice) => /^clear woman . flint$/.test(voice)) || catalog.voices[0],
      ...catalog,
    });
  });
  route('get', '/jobs', async (req, res) => {
    const jobs = await Jobs.find({ owner: hooks.actor(req).id })
      .sort({ createdAt: -1 })
      .limit(40)
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
    if (input.resumeId && !(await Jobs.exists({ _id: id, owner })))
      throw new Error('Video upload not found.');
    let job = await createOnce(id, owner, {
      name: input.name,
      bytes: input.bytes,
      source: 'upload',
      state: 'uploading',
    });
    if (job.bytes !== input.bytes || job.name !== input.name)
      throw new Error('This upload recovery ID belongs to another file.');
    if (job.state === 'uploading' && !job.uploadId) {
      const opened = await storage().send(
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
    const input = z.object({ url: z.string().min(1).max(2048), requestId }).parse(req.body);
    const url = youtubeURL(input.url);
    const owner = hooks.actor(req).id;
    const job = await createOnce(descriptionJobId(owner, 'youtube:' + input.requestId), owner, {
      name: 'YouTube video',
      bytes: 0,
      youtube: url,
      source: 'youtube',
      state: 'importing',
      stage: 'Waiting to import the YouTube video',
    });
    if (job.youtube !== url) throw new Error('This import recovery ID belongs to another video.');
    res.status(202).json(publicJob(job));
    void tick();
  });
  route('post', '/library-imports', async (req, res) => {
    if (!configured() || !hooks.library) throw new Error('Library videos are not available here.');
    const input = z
      .object({
        book: z.string().regex(/^[a-f0-9]{24}$/),
        track: z.number().int().min(0).max(5000),
        requestId,
      })
      .parse(req.body);
    const owner = hooks.actor(req).id;
    const found = await hooks.library.open(req, input.book, input.track);
    const job = await createOnce(descriptionJobId(owner, `library:${input.requestId}`), owner, {
      name: found.title,
      bytes: found.bytes,
      about: found.about,
      source: 'library',
      sourceKey: found.key,
      library: { book: input.book, track: input.track },
      state: 'checking',
      stage: 'Waiting to check the library video',
    });
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
    const uploaded = await storage().send(
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
      if (!(await exists(job.key)))
        await storage().send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket(),
            Key: job.key,
            UploadId: job.uploadId,
            MultipartUpload: {
              Parts: job.parts.map((part) => ({ PartNumber: part.number, ETag: part.etag })),
            },
          }),
        );
      const stored = await storage().send(
        new HeadObjectCommand({ Bucket: bucket(), Key: job.key }),
      );
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
    if ([...busy, 'done'].includes(job.state)) {
      res.json(publicJob(job));
      return;
    }
    if (job.state !== 'ready' || !job.seconds)
      throw new Error('Wait for the video to finish checking.');
    const settings = settingsSchema.parse(req.body);
    if (!(await voices()).voices.includes(settings.voice))
      throw new Error('Choose an existing platform voice.');
    const queued = await enqueue(
      req,
      ['ready'],
      settings,
      descriptionEstimate(job.seconds, settings.detail),
      {
        startedAt: new Date(),
        revoice: false,
      },
    );
    res.status(202).json(publicJob(queued));
  });
  route('post', '/jobs/:id/resume', async (req, res) => {
    const job = await owned(req);
    if (busy.includes(job.state)) {
      res.json(publicJob(job));
      return;
    }
    if (!['failed', 'cancelled'].includes(job.state) || !job.settings || !job.seconds)
      throw new Error('Only a stopped job can be continued.');
    const left = 1 - Math.min(1, (job.done || 0) / Math.max(1, job.sections || 1));
    const estimate =
      (job.revoice ? revoiceEstimate : descriptionEstimate)(job.seconds, job.settings.detail) *
      left;
    const queued = await enqueue(req, ['failed', 'cancelled'], job.settings, estimate, {
      cancelRequested: false,
      resumes: 0,
    });
    res.status(202).json(publicJob(queued));
  });
  route('post', '/jobs/:id/revoice', async (req, res) => {
    const job = await owned(req);
    if (busy.includes(job.state)) {
      res.json(publicJob(job));
      return;
    }
    if (job.state !== 'done' || !job.seconds || !job.settings)
      throw new Error('Only a finished described copy can be made again with new narration.');
    const settings = settingsSchema.parse({
      ...req.body,
      detail: job.settings.detail,
      notes: job.settings.notes,
    });
    if (!(await voices()).voices.includes(settings.voice))
      throw new Error('Choose an existing platform voice.');
    const queued = await enqueue(
      req,
      ['done'],
      settings,
      revoiceEstimate(job.seconds, settings.detail),
      {
        revoice: true,
        version: (job.version || 1) + 1,
        done: 0,
        cancelRequested: false,
        resumes: 0,
        savedToLibrary: '',
      },
    );
    res.status(202).json(publicJob(queued));
  });
  route('post', '/jobs/:id/rename', async (req, res) => {
    const job = await owned(req);
    const name = z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => !/[\r\n\0]/.test(value))
      .parse(req.body?.name);
    await Jobs.updateOne({ _id: job._id }, { $set: { name } });
    res.json(publicJob(await owned(req)));
  });
  route('post', '/jobs/:id/cancel', async (req, res) => {
    const job = await owned(req);
    if (!terminal.includes(job.state)) {
      const idle = await Jobs.findOneAndUpdate(
        {
          _id: job._id,
          state: { $nin: [...terminal, 'running', 'deleting'] },
          $or: [{ worker: { $exists: false } }, { lease: { $lt: new Date() } }],
        },
        {
          $set: {
            state: 'cancelled',
            active: false,
            cancelRequested: true,
            stage: 'Cancelled',
            expiresAt: new Date(Date.now() + 3 * day),
          },
        },
        { new: true },
      ).lean();
      if (idle) {
        await releaseBudget(idle);
        await abortUpload(idle);
      } else {
        await Jobs.updateOne({ _id: job._id, active: true }, { $set: { cancelRequested: true } });
        controllers.get(job._id)?.abort();
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
    await eraseAll(job);
    await Jobs.deleteOne({ _id: job._id, owner: job.owner });
    res.json({ ok: true });
  });
  route('get', '/jobs/:id/files', async (req, res) => {
    const job = await owned(req);
    if (job.state !== 'done') throw new Error('The described copy is not ready yet.');
    const base = plainName(job.name);
    const result: Record<string, string> = {};
    for (const item of outputs) {
      const key = `${folder(job)}/${item.file}`;
      if (!['video', 'audio', 'script'].includes(item.kind) && !(await exists(key))) continue;
      const name = `${base} (${item.label}).${item.ext}`;
      const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      const command = { Bucket: bucket(), Key: key, ResponseContentType: item.mime };
      result[item.kind] = await getSignedUrl(storage(), new GetObjectCommand(command), {
        expiresIn: 6 * 3600,
      });
      result[item.kind + 'Download'] = await getSignedUrl(
        storage(),
        new GetObjectCommand({
          ...command,
          ResponseContentDisposition: `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        }),
        { expiresIn: 6 * 3600 },
      );
    }
    res.json(result);
  });
  route('get', '/jobs/:id/text/:kind', async (req, res) => {
    const job = await owned(req);
    const item = outputs.find(
      (entry) => entry.kind === req.params.kind && entry.ext !== 'mp4' && entry.ext !== 'm4a',
    );
    if (!item || job.state !== 'done') throw new Error('That text is not available.');
    const text = await readText(`${folder(job)}/${item.file}`);
    if (text === null) throw new Error('That text is not available for this copy.');
    res.type(item.mime).send(text);
  });
  route('post', '/jobs/:id/library', async (req, res) => {
    const job = await owned(req);
    if (!hooks.library) throw new Error('The library is not available here.');
    if (job.state !== 'done') throw new Error('The described copy is not ready yet.');
    if (job.savedToLibrary) {
      res.json({ ...publicJob(job), path: '' });
      return;
    }
    const share = z.boolean().default(true).parse(req.body?.share);
    const source = `${folder(job)}/described.m4a`;
    const head = await storage().send(new HeadObjectCommand({ Bucket: bucket(), Key: source }));
    const saved = await hooks.library.save({
      owner: job.owner,
      title: `${plainName(job.name)} (described)`,
      seconds: job.outputSeconds || job.seconds || 0,
      bytes: head.ContentLength || 0,
      share,
      kind: job.kind || '',
      copy: async (target) => {
        const copied = await storage()
          .send(
            new CopyObjectCommand({
              Bucket: bucket(),
              Key: target,
              CopySource: `${bucket()}/${source.split('/').map(encodeURIComponent).join('/')}`,
              ContentType: 'audio/mp4',
              MetadataDirective: 'REPLACE',
            }),
          )
          .then(() => true)
          .catch((error: Error) => {
            hooks.log('description library copy: ' + error.message);
            return false;
          });
        if (copied) return;
        const output = await storage().send(
          new GetObjectCommand({ Bucket: bucket(), Key: source }),
        );
        if (!(output.Body instanceof Readable))
          throw new Error('The described audio could not be read.');
        await storeAudioStream(storage(), bucket(), target, output.Body, 'audio/mp4');
      },
    });
    await Jobs.updateOne({ _id: job._id }, { $set: { savedToLibrary: saved.id } });
    res.json({ ...publicJob(await owned(req)), path: saved.path });
  });
  route('post', '/sample', async (req, res) => {
    const owner = hooks.actor(req).id;
    const input = z
      .object({ voice: z.string().min(1).max(120), rate: z.number().min(1).max(3) })
      .parse(req.body);
    if (!(await voices()).voices.includes(input.voice))
      throw new Error('Choose an existing platform voice.');
    const cacheKey = `${input.voice}|${input.rate}`;
    let audio = samples.get(cacheKey);
    if (!audio) {
      const recent = (sampleUse.get(owner) || []).filter((at) => Date.now() - at < 3600000);
      if (recent.length >= 40)
        throw new Error('That is a lot of samples for one hour. Try again a little later.');
      sampleUse.set(owner, [...recent, Date.now()]);
      const directory = await mkdtemp(join(tmpdir(), 'kade-voice-sample-'));
      try {
        const signal = AbortSignal.timeout(90000);
        const native = Math.min(1.5, input.rate);
        const file = join(directory, 'sample.wav');
        await synthesize(
          sampleText,
          input.voice,
          `sample:${owner}`,
          file,
          native,
          signal,
          async (kind, _reserve, action) => {
            const result = await action();
            await hooks.usage(owner, 'voice-sample', kind, result.costUSD).catch(() => {});
          },
        );
        audio = wav(await stretch(await decodeVoice(file, signal), input.rate / native, signal));
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
      samples.set(cacheKey, audio);
      if (samples.size > 60) samples.delete(samples.keys().next().value as string);
    }
    res.type('audio/wav').send(audio);
  });

  function keeperFor(
    job: Job,
    stored: { plan?: { plan: Plan; words: Word[] }; records: StoredSection[] },
  ): Keeper {
    const prefix = folder(job);
    const version = job.version || 1;
    const analyses: (Analysis | null)[] = [];
    if (job.revoice)
      for (const item of stored.records) analyses[item.record.index] = item.record.analysis;
    return {
      saved: {
        plan: stored.plan?.plan,
        words: stored.plan?.words,
        records: stored.records
          .filter((item) => item.version === version)
          .map((item) => item.record),
        analyses: job.revoice ? analyses : undefined,
      },
      keepPlan: async (plan, words) => {
        await putText(`${prefix}/plan.json`, JSON.stringify({ plan, words }));
        await Jobs.updateOne(
          { _id: job._id, worker },
          { $set: { sections: plan.sections.length } },
        );
      },
      keepSection: async (record, files) => {
        await putFile(`${prefix}/sections/${record.index}.flac`, files.sound, 'audio/flac');
        if (files.picture)
          await putFile(`${prefix}/sections/${record.index}.mp4`, files.picture, 'video/mp4');
        await putText(
          `${prefix}/sections/${record.index}.json`,
          JSON.stringify({ version, record }),
        );
        await Jobs.updateOne({ _id: job._id, worker }, { $set: { done: record.index + 1 } });
      },
      restore: async (index, directory) => {
        const signal = controllers.get(job._id)?.signal ?? new AbortController().signal;
        const sound = join(directory, 'sound.flac');
        await fetchObject(`${prefix}/sections/${index}.flac`, sound, signal);
        const pictureKey = `${prefix}/sections/${index}.mp4`;
        if (!(await exists(pictureKey))) return { sound };
        const picture = join(directory, `part-${index}.mp4`);
        await fetchObject(pictureKey, picture, signal);
        return { sound, picture };
      },
    };
  }
  type StoredSection = { version: number; record: SectionRecord };
  async function loadStored(job: Job) {
    const prefix = folder(job);
    const planText = await readText(`${prefix}/plan.json`);
    if (!planText) return { records: [] };
    const records: StoredSection[] = [];
    for (let i = 0; i < (job.sections || 0); i++) {
      const text = await readText(`${prefix}/sections/${i}.json`);
      if (text) records.push(JSON.parse(text) as StoredSection);
    }
    return { plan: JSON.parse(planText) as { plan: Plan; words: Word[] }, records };
  }

  /** Runs one job with a lease, heartbeat, cancellation and a clean temporary folder. */
  async function lease(
    job: Job,
    lock: string,
    task: (
      directory: string,
      signal: AbortSignal,
      progress: (stage: string, value: number) => Promise<void>,
    ) => Promise<void>,
  ): Promise<void> {
    const controller = new AbortController();
    controllers.set(job._id, controller);
    const deadline = setTimeout(
      () => controller.abort(new Error('The job exceeded its processing time limit.')),
      8 * 3600000,
    );
    deadline.unref();
    const heartbeat = setInterval(() => {
      void (async () => {
        const current = await Jobs.findById(job._id).lean();
        if (!current || current.cancelRequested || !configured() || current.worker !== worker) {
          controller.abort();
          return;
        }
        const until = new Date(Date.now() + 90000);
        const held = await Locks.updateOne({ _id: lock, worker }, { $set: { until } });
        if (!held.modifiedCount) {
          controller.abort();
          return;
        }
        await Jobs.updateOne({ _id: job._id, worker }, { $set: { lease: until } });
      })().catch(() => controller.abort());
    }, 10000);
    heartbeat.unref();
    let directory = '';
    try {
      directory = await mkdtemp(join(tmpdir(), 'kade-described-video-'));
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
      await task(directory, controller.signal, progress);
    } catch (error) {
      const current = await Jobs.findById(job._id).lean();
      const cancelled = !!current?.cancelRequested;
      const detail = error instanceof Error ? error.message : 'Video processing failed.';
      hooks.log(`description ${job._id}: ${detail}`);
      if (controller.signal.reason instanceof Shutdown && !cancelled) {
        await Jobs.updateOne(
          { _id: job._id, worker },
          {
            $set: {
              state: job.state === 'running' ? 'queued' : job.state,
              stage: 'Continuing after a server restart',
            },
            $inc: { resumes: 1 },
            $unset: { worker: 1, lease: 1 },
          },
        );
        return;
      }
      const message = axios.isAxiosError(error)
        ? `A processing service did not complete the request (${error.response?.status || 'connection interrupted'}).`
        : detail.slice(0, 500);
      await Jobs.updateOne(
        { _id: job._id, worker },
        {
          $set: {
            state: cancelled ? 'cancelled' : 'failed',
            active: false,
            stage: cancelled ? 'Cancelled' : 'Stopped before finishing',
            error: cancelled
              ? 'Processing stopped. Work already sent to providers may still be charged.'
              : message,
            finishedAt: new Date(),
            expiresAt: new Date(Date.now() + 3 * day),
          },
          $unset: { worker: 1, lease: 1 },
        },
      );
      if (!cancelled && hooks.notify && job.state === 'running')
        await hooks
          .notify(
            job.owner,
            'Your described video stopped',
            `${plainName(job.name)}: ${message} Finished sections are kept, so you can continue from the page.`,
            `/described-video?id=${job._id}`,
          )
          .catch((failure: Error) => hooks.log('description notify: ' + failure.message));
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      controllers.delete(job._id);
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      const current = await Jobs.findById(job._id).lean();
      if (current && terminal.includes(current.state)) await releaseBudget(current);
    }
  }

  async function check(job: Job): Promise<void> {
    await lease(job, lanes.check.lock, async (directory, signal, progress) => {
      let source = join(directory, 'source');
      let about = job.about || '';
      if (job.state === 'importing' && job.youtube) {
        await progress('Importing the YouTube video', 1);
        const imported = await importYouTube(
          job.youtube,
          directory,
          maxMinutes() * 60,
          signal,
          hooks.log,
        );
        source = imported.file;
        job.bytes = imported.bytes;
        job.name = imported.name;
        about = imported.about;
        await progress('Saving your imported video', 5);
        await putFile(job.key, source, 'video/mp4');
      } else {
        await progress(
          job.sourceKey ? 'Reading the library video' : 'Reading your uploaded video',
          1,
        );
        await fetchObject(
          job.sourceKey || job.key,
          source,
          signal,
          job.sourceKey ? undefined : job.bytes,
        );
        job.bytes = (await stat(source)).size;
      }
      const media = await probe(source, signal);
      if (media.seconds > maxMinutes() * 60)
        throw new Error(`Videos are limited to ${maxMinutes()} minutes for now.`);
      const saved = await Jobs.updateOne(
        { _id: job._id, worker, cancelRequested: false },
        {
          $set: {
            state: 'ready',
            name: job.name,
            bytes: job.bytes,
            about,
            seconds: media.seconds,
            stage: 'Ready to describe',
            progress: 0,
            expiresAt: new Date(Date.now() + 3 * day),
          },
          $unset: { worker: 1, lease: 1 },
        },
      );
      if (!saved.matchedCount) throw new Error('Video checking was cancelled.');
    });
  }

  async function render(job: Job): Promise<void> {
    await lease(job, lanes.render.lock, async (directory, signal, progress) => {
      if (!job.settings) throw new Error('This job has no saved narration settings.');
      const settings = settingsSchema.parse(job.settings);
      await Jobs.updateOne(
        { _id: job._id, worker },
        { $set: { runAt: new Date(), runFrom: job.progress || 0, error: '' } },
      );
      const source = join(directory, 'source');
      await progress('Getting the video ready', Math.max(1, job.progress || 0));
      await fetchObject(
        job.sourceKey || job.key,
        source,
        signal,
        job.sourceKey ? undefined : job.bytes,
      );
      const stored = await loadStored(job);
      const keeper = keeperFor(job, stored);
      const reserved = () => job.reserved ?? job.limitUSD ?? 0;
      const grow = async (needed: number): Promise<boolean> => {
        const amount = cents(Math.min(jobLimit() - reserved(), Math.max(needed, 0.25)));
        if (amount < needed || !(await setAside(job, amount, job.budgetDay || today())))
          return false;
        await Jobs.updateOne({ _id: job._id }, { $inc: { reserved: amount } });
        job.reserved = reserved() + amount;
        return true;
      };
      const meter: Meter = async (kind, reserve, action) => {
        signal.throwIfAborted();
        if (!Number.isFinite(reserve) || reserve < 0)
          throw new Halt('A cost estimate was invalid.');
        const spent = job.runCost ?? 0;
        if (spent + reserve > reserved() && !(await grow(spent + reserve - reserved())))
          throw new Halt(
            'The job reached its processing allowance, so no further paid requests were sent. Finished sections are kept.',
          );
        job.runCost = spent + reserve;
        job.costUSD += reserve;
        const held = await Jobs.updateOne(
          { _id: job._id, worker, cancelRequested: false },
          { $set: { runCost: job.runCost, costUSD: job.costUSD } },
        );
        if (!held.matchedCount) throw new Halt('Processing stopped before the next paid request.');
        let result: { costUSD: number };
        try {
          result = await action();
        } catch (error) {
          await hooks.usage(job.owner, job._id, `${kind}-uncertain`, reserve).catch(() => {});
          throw error;
        }
        job.runCost = Math.max(0, job.runCost - reserve + result.costUSD);
        job.costUSD = Math.max(0, job.costUSD - reserve + result.costUSD);
        await Jobs.updateOne(
          { _id: job._id, worker },
          { $set: { runCost: job.runCost, costUSD: job.costUSD } },
        );
        await hooks
          .usage(job.owner, job._id, kind, result.costUSD)
          .catch((error: Error) => hooks.log('description usage: ' + error.message));
      };
      const output = await describeVideo({
        source,
        directory,
        title: plainName(job.name),
        about: job.about || '',
        settings,
        session: `video:${job._id}`,
        signal,
        meter,
        progress,
        providers: hooks.providers ?? productionProviders,
        keeper,
        voices: Math.min(4, Math.max(1, Number(process.env.KADE_DESCRIPTION_VOICES) || 2)),
      });
      await progress('Saving the described copy', 97);
      const files: Record<string, string> = {
        'described.mp4': output.video,
        'described.m4a': output.audio,
        'description.json': output.files.report,
        'transcript.txt': output.files.transcript,
        'descriptions.vtt': output.files.descriptions,
        'captions.vtt': output.files.captions,
      };
      for (const item of outputs) {
        signal.throwIfAborted();
        if ((await stat(files[item.file])).size > 6 * 1024 ** 3)
          throw new Error('The described copy exceeded the storage limit.');
        await putFile(`${folder(job)}/${item.file}`, files[item.file], item.mime);
      }
      signal.throwIfAborted();
      const report = output.report;
      const saved = await Jobs.updateOne(
        { _id: job._id, worker, cancelRequested: false },
        {
          $set: {
            state: 'done',
            active: false,
            stage: 'Your described copy is ready',
            progress: 100,
            outputSeconds: report.outputSeconds,
            count: report.descriptions.length,
            skipped: report.skipped.length,
            failedSections: report.failedSections.length,
            kind: report.kind,
            finishedAt: new Date(),
            expiresAt: new Date(Date.now() + 7 * day),
          },
          $unset: { worker: 1, lease: 1 },
        },
      );
      if (!saved.matchedCount) throw new Error('Video processing was cancelled.');
      if (hooks.notify)
        await hooks
          .notify(
            job.owner,
            'Your described video is ready',
            `${plainName(job.name)}: ${spokenLength(report.outputSeconds)} with ${report.descriptions.length} descriptions. Open Make a described video on the website to listen or download.`,
            `/described-video?id=${job._id}`,
          )
          .catch((error: Error) => hooks.log('description notify: ' + error.message));
    });
  }

  /** Jobs whose worker vanished: rendering continues from its saved sections, checks restart. */
  async function sweep(lane: 'check' | 'render'): Promise<void> {
    const stale = {
      updatedAt: { $lt: new Date(Date.now() - 120000) },
      $or: [{ lease: { $lt: new Date() } }, { lease: { $exists: false } }],
    };
    if (lane === 'check') {
      await Jobs.updateMany(
        { state: { $in: lanes.check.states }, ...stale },
        { $unset: { worker: 1, lease: 1 } },
      );
      const expired = await Jobs.find({
        expiresAt: { $lt: new Date() },
        state: { $nin: [...busy, 'checking', 'importing'] },
      })
        .limit(10)
        .lean();
      for (const job of expired) {
        await abortUpload(job);
        await eraseAll(job).catch((error: Error) =>
          hooks.log('description expiry: ' + error.message),
        );
        await Jobs.deleteOne({ _id: job._id });
      }
      return;
    }
    for (const job of await Jobs.find({ state: 'reserving', ...stale }).lean()) {
      await releaseBudget(job);
      await Jobs.updateOne(
        { _id: job._id, state: 'reserving' },
        { $set: { state: job.revoice ? 'done' : 'ready' }, $unset: { budgetDay: 1, reserved: 1 } },
      );
    }
    for (const job of await Jobs.find({ state: 'running', ...stale }).lean()) {
      if ((job.resumes || 0) < 3) {
        await Jobs.updateOne(
          { _id: job._id, state: 'running' },
          {
            $set: { state: 'queued', stage: 'Continuing after a server restart' },
            $inc: { resumes: 1 },
            $unset: { worker: 1, lease: 1 },
          },
        );
        continue;
      }
      await Jobs.updateOne(
        { _id: job._id },
        {
          $set: {
            state: 'failed',
            active: false,
            error:
              'The server restarted several times during this job. Finished sections are kept; continue it from the page.',
            finishedAt: new Date(),
            expiresAt: new Date(Date.now() + 3 * day),
          },
          $unset: { worker: 1, lease: 1 },
        },
      );
      await releaseBudget(job);
    }
  }

  async function runLane(name: 'check' | 'render'): Promise<void> {
    const lane = lanes[name];
    if (closed || lane.running || mongoose.connection.readyState !== 1) return;
    lane.running = true;
    try {
      await initialize();
      await Locks.updateOne(
        { _id: lane.lock },
        { $setOnInsert: { worker: '', until: new Date(0) } },
        { upsert: true },
      );
      const lock = await Locks.findOneAndUpdate(
        { _id: lane.lock, until: { $lt: new Date() } },
        { $set: { worker, until: new Date(Date.now() + 90000) } },
        { new: true },
      ).lean();
      if (!lock) return;
      await sweep(name);
      if (!configured()) return;
      const job = await Jobs.findOneAndUpdate(
        {
          state: { $in: lane.states },
          cancelRequested: false,
          $or: [{ worker: { $exists: false } }, { lease: { $lt: new Date() } }],
        },
        { $set: { worker, lease: new Date(Date.now() + 90000) } },
        { new: true, sort: { createdAt: 1 } },
      ).lean();
      if (!job) return;
      if (name === 'render') {
        job.state = 'running';
        await Jobs.updateOne({ _id: job._id, worker }, { $set: { state: 'running' } });
      }
      const work = name === 'check' ? check(job) : render(job);
      inflight.add(work);
      await work.finally(() => inflight.delete(work));
    } catch (error) {
      hooks.log(`description ${name} lane: ` + (error instanceof Error ? error.message : 'failed'));
    } finally {
      await Locks.updateOne({ _id: lane.lock, worker }, { $set: { until: new Date(0) } }).catch(
        () => {},
      );
      lane.running = false;
    }
  }
  async function tick(): Promise<void> {
    await Promise.all([runLane('check'), runLane('render')]);
  }
  const timer = setInterval(() => {
    void tick();
  }, 15000);
  timer.unref();
  return {
    router,
    tick,
    close: async () => {
      closed = true;
      clearInterval(timer);
      for (const controller of controllers.values())
        controller.abort(new Shutdown('The server is restarting.'));
      await Promise.race([
        Promise.allSettled([...inflight]),
        new Promise((resolve) => setTimeout(resolve, 20000).unref()),
      ]);
    },
  };
}

/** 16-bit mono WAV for voice samples. */
function wav(pcm: Float32Array): Buffer {
  const data = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++)
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
