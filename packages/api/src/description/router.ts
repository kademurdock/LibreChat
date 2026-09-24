import { z } from 'zod';
import axios from 'axios';
import mongoose from 'mongoose';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router, raw } from 'express';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, stat, statfs } from 'node:fs/promises';
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
  ListObjectVersionsCommand,
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import type { Request, RequestHandler, ErrorRequestHandler } from 'express';
import type { S3Client, CompletedPart } from '@aws-sdk/client-s3';
import type {
  Analysis,
  Chapter,
  Continuity,
  Interval,
  Meter,
  Plan,
  SectionRecord,
  Settings,
  Word,
} from './types';
import type { Keeper, Outcome, Providers, SavedLook, Request as EngineRequest } from './engine';
import type { Edit } from './revision';
import {
  billed,
  voices,
  voiceBase,
  synthesize,
  speechPerByte,
  providerProblem,
  transcriptionPerMinute,
} from './providers';
import {
  clip,
  revise,
  cleanLabel,
  scriptCues,
  matchFolder,
  cleanSpoken,
  editsSchema,
  describedShelf,
  libraryPathSchema,
  defaultLibraryPath,
} from './revision';
import { describeVideo, productionProviders } from './engine';
import { importYouTube, youtubeURL } from './youtube';
import { rehearsalProviders } from './rehearsal';
import { MediaError, decodeVoice, probe, stretch } from './media';
import { clock, spokenLength } from './transcript';
import { settingsSchema, Halt } from './types';
import { sampleRate } from './mix';

type RunKind = 'fresh' | 'preview' | 'finish' | 'revoice' | 'correction' | 'redo' | 'rehearsal';
/** How a rehearsal ended; every ending leaves the video ready to describe. */
type RehearsalOutcome = 'finished' | 'stopped' | 'cancelled';
/** Money one paid run set aside from one day's allowance, in whole cents. */
type Run = { runId: string; day: string; cents: number };
/** Where each section of a version is stored: manifest[i] is the version folder (0 = the old flat layout). */
type Manifest = (number | null)[];
type FinishedCopy = {
  version: number;
  legacy?: boolean;
  settings?: Settings;
  outputSeconds?: number;
  count?: number;
  skipped?: number;
  failedSections?: number;
  savedToLibrary?: string;
  libraryPending?: string;
  finishedAt?: Date;
  preview?: boolean;
  range?: Interval;
  kind?: string;
  sections?: Manifest;
  failed?: number[];
  spans?: number[];
  firstLook?: number;
  /** Made by a free rehearsal: a test tone and numbered placeholder descriptions. */
  rehearsal?: boolean;
};
type Actor = { id: string; role?: string; child?: boolean };
/** A library track the owner may describe, found and checked by the library's own access rules. */
type LibrarySource = {
  key: string;
  bytes: number;
  title: string;
  about: string;
  shared: boolean;
  grownUpsOnly: boolean;
  ownerIsActor: boolean;
  /** Plain catalog facts for the prompt: shelf, category, year, station, brand, market. */
  context?: string;
  /** The source's own shelf, so a described copy can be filed beside its Audio mirror. */
  path?: string;
};
type LibraryHooks = {
  folders?: (req: Request) => Promise<string[]>;
  open: (req: Request, book: string, track: number) => Promise<LibrarySource>;
  save: (input: {
    id: string;
    owner: string;
    title: string;
    seconds: number;
    bytes: number;
    share: boolean;
    grownUpsOnly: boolean;
    kind: string;
    path: string;
    transcript?: string;
    sourceBook?: string;
    sourceTrack?: number;
    description?: string;
    copy: (target: string) => Promise<void>;
  }) => Promise<{ id: string; path: string }>;
};
type NoticeResult = {
  browser?: number;
  bridge?: number | string;
  sent?: number;
  deferred?: boolean;
  blocked?: string;
} | void;
/** Which job and which event a notice is about, so the phone can open the right screen. */
type NoticeDetail = { job: string; kind: string };
type RunKeeper = Keeper;
type RunRequest = EngineRequest & { keeper: Keeper };
type Hooks = {
  auth: RequestHandler;
  actor: (req: Request) => Actor;
  storage: () => S3Client;
  log: (message: string) => void;
  warn?: (message: string) => void;
  usage: (owner: string, job: string, kind: string, costUSD: number) => Promise<void>;
  notify?: (
    owner: string,
    title: string,
    body: string,
    url: string,
    detail?: NoticeDetail,
  ) => Promise<NoticeResult>;
  library?: LibraryHooks;
  providers?: Providers;
  /** Tests wrap the engine to watch what a run was asked to do. */
  describe?: (request: RunRequest) => Promise<Outcome>;
  /** Tests use a fast heartbeat and drive ticks themselves (tickMs 0). */
  timing?: { heartbeatMs?: number; tickMs?: number; wedgeMs?: number };
};
type Part = { number: number; etag: string; bytes: number; hash: string };
type SourcePrivacy = { shared: boolean; grownUpsOnly: boolean; ownerIsActor: boolean };
type Spend = { vision?: number; speech?: number; transcription?: number; uncertain?: number };
type Job = {
  _id: string;
  owner: string;
  name: string;
  /** The file name the upload started with; recovery matches on it even after a rename. */
  originalName?: string;
  bytes: number;
  state: string;
  active: boolean;
  key: string;
  source?: 'upload' | 'youtube' | 'library';
  sourceKey?: string;
  sourcePrivacy?: SourcePrivacy;
  sourcePath?: string;
  context?: string;
  chapters?: Chapter[];
  about?: string;
  seconds?: number;
  settings?: Settings;
  stage?: string;
  progress: number;
  /** Everything every run of this video has cost. */
  costUSD: number;
  /** What the current run has spent (or holds for a request in flight). */
  runCost?: number;
  runKind?: RunKind;
  /** How the latest rehearsal ended, so the page can say so when the video is ready again. */
  lastRehearsal?: { outcome: RehearsalOutcome; version: number; at: Date };
  runEstimateUSD?: number;
  /** What she agreed this run may cost: the estimate she was shown plus headroom. */
  approvedUSD?: number;
  /** The run stopped before a paid request that would have gone past what she agreed. */
  overQuote?: { spentUSD: number; quotedUSD: number };
  reservation?: Run;
  /** A reservation being taken; kept so a crash in between can give it back. */
  pendingRun?: Run;
  reservingFrom?: string;
  spend?: Spend;
  cancelRequested: boolean;
  cancelAt?: Date;
  worker?: string;
  lease?: Date;
  error?: string;
  checkFailure?: 'transient' | 'permanent';
  checkRetries?: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  expiryWarned?: boolean;
  startedAt?: Date;
  queuedAt?: Date;
  /** 0 for short parts and runs that already started, so they are not stuck behind a film. */
  priority?: number;
  runAt?: Date;
  runFrom?: number;
  finishedAt?: Date;
  outputSeconds?: number;
  count?: number;
  skipped?: number;
  failedSections?: number;
  sections?: number;
  done?: number;
  spans?: number[];
  planKey?: string;
  plans?: string[];
  manifest?: Manifest;
  /** Sections of this attempt whose look failed on a passing problem; Continue looks again. */
  retry?: number[];
  firstLookThrough?: number;
  restarts?: number;
  crashes?: number;
  crashAt?: number;
  retries?: number;
  version?: number;
  lastVersion?: number;
  base?: number;
  carry?: Manifest;
  revoice?: boolean;
  edits?: Edit[];
  reuseUnchanged?: boolean;
  redo?: number[];
  sectionNotes?: Record<string, string>;
  stopAfter?: number;
  preview?: boolean;
  firstLookVersion?: number;
  copies?: FinishedCopy[];
  kind?: string;
  savedToLibrary?: string;
  libraryPending?: string;
  librarySaving?: Date;
  uploadId?: string;
  uploadedBytes: number;
  parts: Part[];
  youtube?: string;
  library?: { book: string; track: number };
  lastNotice?: { at: Date; kind: string; result: string };
};
type Lock = { _id: string; worker: string; until: Date };
/** One day's allowance: cents held by open runs and spent by closed ones. */
type Budget = { _id: string; held: number; runs: string[] };
const run = { runId: String, day: String, cents: Number };
const jobSchema = new mongoose.Schema<Job>(
  {
    _id: String,
    owner: String,
    name: String,
    originalName: String,
    bytes: Number,
    state: String,
    active: Boolean,
    key: String,
    source: String,
    sourceKey: String,
    sourcePrivacy: { shared: Boolean, grownUpsOnly: Boolean, ownerIsActor: Boolean },
    sourcePath: String,
    context: String,
    chapters: mongoose.Schema.Types.Mixed,
    about: String,
    seconds: Number,
    settings: mongoose.Schema.Types.Mixed,
    stage: String,
    progress: Number,
    costUSD: Number,
    runCost: Number,
    runKind: String,
    lastRehearsal: { outcome: String, version: Number, at: Date },
    runEstimateUSD: Number,
    approvedUSD: Number,
    overQuote: { spentUSD: Number, quotedUSD: Number },
    reservation: run,
    pendingRun: run,
    reservingFrom: String,
    spend: { vision: Number, speech: Number, transcription: Number, uncertain: Number },
    cancelRequested: Boolean,
    cancelAt: Date,
    worker: String,
    lease: Date,
    error: String,
    checkFailure: String,
    checkRetries: Number,
    expiresAt: Date,
    expiryWarned: Boolean,
    startedAt: Date,
    queuedAt: Date,
    priority: Number,
    runAt: Date,
    runFrom: Number,
    finishedAt: Date,
    outputSeconds: Number,
    count: Number,
    skipped: Number,
    failedSections: Number,
    sections: Number,
    done: Number,
    spans: [Number],
    planKey: String,
    plans: [String],
    manifest: mongoose.Schema.Types.Mixed,
    retry: [Number],
    firstLookThrough: Number,
    restarts: Number,
    crashes: Number,
    crashAt: Number,
    retries: Number,
    version: Number,
    lastVersion: Number,
    base: Number,
    carry: mongoose.Schema.Types.Mixed,
    revoice: Boolean,
    edits: mongoose.Schema.Types.Mixed,
    reuseUnchanged: Boolean,
    redo: [Number],
    sectionNotes: mongoose.Schema.Types.Mixed,
    stopAfter: Number,
    preview: Boolean,
    firstLookVersion: Number,
    copies: [mongoose.Schema.Types.Mixed],
    kind: String,
    savedToLibrary: String,
    libraryPending: String,
    librarySaving: Date,
    uploadId: String,
    uploadedBytes: { type: Number, default: 0 },
    parts: [{ number: Number, etag: String, bytes: Number, hash: String, _id: false }],
    youtube: String,
    library: { book: String, track: Number },
    lastNotice: { at: Date, kind: String, result: String },
  },
  { timestamps: true },
);
jobSchema.index({ owner: 1, createdAt: -1 });
jobSchema.index({ state: 1, createdAt: 1 });
jobSchema.index({ state: 1, priority: 1, queuedAt: 1 });
jobSchema.index({ expiresAt: 1 });
jobSchema.index({ owner: 1, 'library.book': 1, 'library.track': 1 });
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
const voiceFields = ['voice', 'rate', 'maxRate', 'mode', 'volume'] as const;
/** The narration choices a re-voice or a Continue may change; absent ones keep the saved value. */
const voiceSchema = z
  .object({
    voice: z.string().min(1).max(120).optional(),
    rate: z.number().min(1).max(3).optional(),
    maxRate: z.number().min(1).max(3).optional(),
    mode: z.enum(['standard', 'extended']).optional(),
    volume: z.enum(['softer', 'balanced', 'louder']).optional(),
  })
  .transform((value) =>
    Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)),
  );
const terminal = ['done', 'failed', 'cancelled'];
const busy = ['reserving', 'queued', 'running'];
const checking = ['checking', 'importing'];
const describing: RunKind[] = ['fresh', 'preview', 'finish', 'rehearsal'];
const chunkBytes = 8 * 1024 ** 2;
const maxUnfinished = 10;
const second = 1000;
const minute = 60 * second;
const hour = 60 * minute;
const day = 24 * hour;
const envNumber = (name: string, fallback: number, low: number, high: number): number => {
  const value = Number(process.env[name]);
  return Math.min(high, Math.max(low, Number.isFinite(value) && value > 0 ? value : fallback));
};
const bucket = () => process.env.KADE_MEDIA_BUCKET || process.env.AWS_BUCKET_NAME || '';
const maxMinutes = () => envNumber('KADE_DESCRIPTION_MAX_MINUTES', 90, 1, 180);
const maxSourceMinutes = () =>
  Math.max(maxMinutes(), envNumber('KADE_DESCRIPTION_MAX_SOURCE_MINUTES', 360, 1, 720));
const maxSourceBytes = () =>
  envNumber('KADE_DESCRIPTION_MAX_BYTES', 6 * 1024 ** 3, 1, 64 * 1024 ** 3);
const previewSeconds = () => envNumber('KADE_DESCRIPTION_PREVIEW_SECONDS', 180, 30, 600);
/** Sources up to this size are read whole by the free check; bigger ones only at both ends. */
const checkWholeBytes = () =>
  envNumber('KADE_DESCRIPTION_CHECK_WHOLE_MB', 256, 0.1, 4096) * 1024 ** 2;
const jobLimit = () => envNumber('KADE_DESCRIPTION_JOB_USD', 5, 0.1, 20);
const dailyLimit = () => envNumber('KADE_DESCRIPTION_DAILY_USD', 5, 0.1, 100);
const configured = () =>
  !!(process.env.OPENROUTER_KEY && process.env.DEEPGRAM_API_KEY && bucket()) &&
  process.env.KADE_DESCRIBED_VIDEO !== '0';
const today = () => new Date().toISOString().slice(0, 10);
const toCents = (usd: number): number => Math.max(0, Math.ceil(usd * 100 - 1e-6));
const money = (usd: number): string => `$${usd.toFixed(2)}`;
const retain = (job: Pick<Job, 'expiresAt'>, days: number): Date =>
  new Date(Math.max(new Date(job.expiresAt).getTime(), Date.now() + days * day));

/** Measured provider costs per minute of video (Sep 2026 samples, rounded up), for estimates only. */
const rates = { vision: 0.021, closeLook: 0.025, firstLook: 0.021 };
/** Fixed overhead per run: prompts and joins for a description run, a re-voice, a correction. */
const overhead = { describe: 0.03, revoice: 0.02, correction: 0.05 };
const setAsideRule = { factor: 1.1, extraUSD: 0.05 };
/** A run stops and asks before a paid request once it has cost this much: the quote plus headroom. */
const approvalRule = { factor: 1.5, extraUSD: 0.1 };
const growCents = 25;
/** Each Keep adds a week, up to a month from now. */
const keepDays = 7;
const keepMaxDays = 30;
/** Descriptions per minute of video at each detail level, for estimates only. */
const cuesPerMinute: Record<Settings['detail'], number> = { essential: 8, standard: 13, rich: 20 };
const speechPerMinute = (detail: Settings['detail']) => cuesPerMinute[detail] * 130 * speechPerByte;
type Work = {
  /** Seconds of video the model looks at. */
  looks: number;
  /** Seconds of video whose descriptions are voiced. */
  voiced: number;
  /** Seconds of soundtrack sent to speech recognition. */
  dialogue: number;
  /** Seconds the first look surveys. */
  firstLook: number;
  /** Exact bytes to voice, for corrections. */
  bytes?: number;
  fixed: number;
};
type Breakdown = {
  vision: number;
  speech: number;
  dialogue: number;
  closeLook: number;
  firstLook: number;
};
type Price = { estimateUSD: number; setAsideUSD: number; breakdown: Breakdown; seconds: number };
const setAsideFor = (estimate: number): number =>
  Math.min(jobLimit(), toCents(estimate * setAsideRule.factor + setAsideRule.extraUSD) / 100);
const approvalFor = (estimate: number): number =>
  Math.min(jobLimit(), toCents(estimate * approvalRule.factor + approvalRule.extraUSD) / 100);
/**
 * What continuing a run that went over its quote asks her to allow: the rest of the work priced
 * at the rate the stopped run really cost, with the usual headroom, never above one run's limit.
 */
function askFor(estimate: number, over: { spentUSD: number; quotedUSD: number }): number {
  const overrun = Math.max(1, over.spentUSD / Math.max(0.01, over.quotedUSD));
  return Math.min(
    jobLimit(),
    toCents(estimate * overrun * approvalRule.factor + approvalRule.extraUSD) / 100,
  );
}
/**
 * The ask she is shown and the most Continue will allow: never more than today has left, so it
 * can always be accepted, and never less than the usual approval for the rest of the work.
 */
const askWithin = (
  estimate: number,
  over: { spentUSD: number; quotedUSD: number },
  leftUSD: number,
): number => Math.max(approvalFor(estimate), Math.min(askFor(estimate, over), leftUSD));
function priceFor(work: Work, settings: Settings): Price {
  const per = (seconds: number, rate: number) => (seconds / 60) * rate;
  const looked = work.looks > 0;
  const breakdown: Breakdown = {
    vision: per(work.looks, rates.vision) + (looked ? work.fixed : 0),
    closeLook: settings.closeLook ? per(work.looks, rates.closeLook) : 0,
    firstLook: settings.firstLook ? per(work.firstLook, rates.firstLook) : 0,
    speech:
      (work.bytes === undefined
        ? per(work.voiced, speechPerMinute(settings.detail))
        : work.bytes * speechPerByte) + (looked ? 0 : work.fixed),
    dialogue: per(work.dialogue, transcriptionPerMinute),
  };
  const total = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  const estimateUSD = toCents(total) / 100;
  const round = (value: number) => Math.round(value * 10000) / 10000;
  return {
    estimateUSD,
    setAsideUSD: setAsideFor(estimateUSD),
    breakdown: {
      vision: round(breakdown.vision),
      speech: round(breakdown.speech),
      dialogue: round(breakdown.dialogue),
      closeLook: round(breakdown.closeLook),
      firstLook: round(breakdown.firstLook),
    },
    seconds: Math.round(Math.max(work.looks, work.voiced)),
  };
}

export function descriptionJobId(owner: string, id: string): string {
  return createHash('sha256')
    .update(owner + ':' + id)
    .digest('hex')
    .slice(0, 32);
}
const ownerTag = (owner: string) => createHash('sha256').update(owner).digest('hex').slice(0, 8);
const folder = (job: Pick<Job, 'key'>) => job.key.replace(/\/source$/, '');
const plainName = (name: string) =>
  clip(
    cleanLabel(name.replace(/\.(mp4|m4v|mov|mkv|webm|avi|wmv|mpg|mpeg|flv|3gp|ts)$/i, '')),
    200,
  ) || 'Video';
/** The name a copy is given: "Title" or "Title, 1:12:30 to 1:16:00" for a part. */
const copyName = (job: Pick<Job, 'name'>, range?: Interval) =>
  range
    ? `${plainName(job.name)}, ${clock(range.start)} to ${clock(range.end)}`
    : plainName(job.name);
const workingSeconds = (seconds: number, range?: Interval) =>
  range ? range.end - range.start : seconds;
/** A rehearsal keeps its own plan, so its made-up dialogue is never reused by a paid run. */
const planKey = (range?: Interval, rehearsal: boolean = false) =>
  (rehearsal ? 'rehearsal-' : '') +
  (range ? `plan-${Math.round(range.start * 1000)}-${Math.round(range.end * 1000)}` : 'plan');
const sameVoice = (a: Settings, b: Settings) => voiceFields.every((key) => a[key] === b[key]);
const doneCount = (manifest: Manifest) =>
  manifest.filter((entry) => entry !== null && entry !== undefined).length;
/** Seconds covered by the given sections of a plan whose boundaries are `spans`. */
const lengths = (spans: number[], indexes: number[]) =>
  indexes.reduce((sum, i) => sum + Math.max(0, (spans[i + 1] ?? spans[i]) - spans[i]), 0);
const allSections = (count: number) => Array.from({ length: count }, (_, i) => i);
/** Sections a preview renders: those starting before `stopAfter`. */
const inScope = (spans: number[], stopAfter?: number) =>
  allSections(Math.max(0, spans.length - 1)).filter(
    (i) => stopAfter === undefined || spans[i] < stopAfter,
  );
/** Seconds a run covers when the plan is not known yet: a preview reaches about one section past its end. */
const roughCover = (seconds: number, stopAfter?: number) =>
  stopAfter === undefined ? seconds : Math.min(seconds, stopAfter + 60);
const crashLocked = (job: Job) => (job.crashes ?? 0) >= 3 && job.crashAt === (job.done ?? 0);
const crashText =
  'The server stopped three times while working on the same part of this video, so it will not try that part again. Go back to the last finished version, or delete this video and describe it again with other settings or as a shorter part.';

function copiesFor(job: Job): FinishedCopy[] {
  if (job.copies?.length) return job.copies;
  if (job.state !== 'done') return [];
  return [
    {
      version: job.version || 1,
      legacy: true,
      settings: job.settings,
      outputSeconds: job.outputSeconds,
      count: job.count,
      skipped: job.skipped,
      failedSections: job.failedSections,
      savedToLibrary: job.savedToLibrary,
      finishedAt: job.finishedAt,
    },
  ];
}
/** Copies with real descriptions; rehearsal copies are never the base of a paid version. */
const realCopies = (job: Job): FinishedCopy[] => copiesFor(job).filter((copy) => !copy.rehearsal);
const latestCopy = (job: Job): FinishedCopy | undefined => realCopies(job).at(-1);
function selectCopy(job: Job, value?: string): FinishedCopy {
  const copies = copiesFor(job);
  const copy = value
    ? copies.find((item) => String(item.version) === value)
    : copies[copies.length - 1];
  if (!copy) throw new Problem('That finished version is not available.', 404);
  return copy;
}
/** The storage manifest of a finished copy; copies from before per-version storage read the flat folder. */
const manifestOf = (job: Job, copy: FinishedCopy): Manifest =>
  copy.sections ?? allSections(job.sections || 0).map(() => 0);
const publicCopy = (copy: FinishedCopy) => ({
  version: copy.version,
  preview: !!copy.preview,
  settings: copy.settings,
  outputSeconds: copy.outputSeconds,
  count: copy.count,
  skipped: copy.skipped,
  failedSections: copy.failedSections,
  savedToLibrary: copy.savedToLibrary,
  finishedAt: copy.finishedAt,
  range: copy.range,
  rehearsal: !!copy.rehearsal,
});
const nextVersion = (job: Job) =>
  Math.max(job.lastVersion ?? 0, job.version ?? 1, ...copiesFor(job).map((copy) => copy.version)) +
  1;

/** A refusal written for her, with the HTTP status that fits it. */
class Problem extends Error {
  status: number;
  field?: string;
  constructor(message: string, status: number = 409, field?: string) {
    super(message);
    this.status = status;
    this.field = field;
  }
}
class Shutdown extends Error {}
class Cancelled extends Error {}
/** This worker can no longer prove it owns the job: the database stopped answering, or another server took over. */
class LeaseLost extends Error {}
class StorageStall extends Error {}
/** A paid request refused because the run already cost what she agreed to. */
class OverQuote extends Halt {
  spentUSD: number;
  quotedUSD: number;
  constructor(spentUSD: number, quotedUSD: number) {
    super(
      `This is costing more than quoted: ${money(spentUSD)} spent of about ${money(quotedUSD)}.`,
    );
    this.spentUSD = spentUSD;
    this.quotedUSD = quotedUSD;
  }
}

const statusOf = (error: unknown) =>
  (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
/** Storage, database and connection failures that are worth continuing after, as opposed to a bad video or a provider refusal. */
function infrastructure(error: unknown, jobAborted: boolean): boolean {
  if (!(error instanceof Error) || axios.isAxiosError(error) || error instanceof Halt) return false;
  if (error instanceof StorageStall || error instanceof LeaseLost) return true;
  if (
    /^(Mongo(Network|NetworkTimeout|ServerSelection|NotConnected)Error|MongooseServerSelectionError)$/.test(
      error.name,
    )
  )
    return true;
  if (/buffering timed out/i.test(error.message)) return true;
  const status = statusOf(error);
  if (status !== undefined) return status >= 500 || status === 429;
  if (!jobAborted && error.name === 'AbortError') return true;
  const code = (error as { code?: string }).code;
  return ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(
    code || '',
  );
}
function serviceFor(error: unknown): string {
  const url = axios.isAxiosError(error) ? String(error.config?.url || '') : '';
  if (/deepgram\.com/.test(url)) return 'Dialogue timing (Deepgram)';
  if (/openrouter\.ai/.test(url)) return 'The video model (OpenRouter)';
  if (url && url.startsWith(voiceBase())) return 'The voice service';
  return 'A processing service';
}
/** Drops file paths and trims, so nothing from the server's disk is read aloud. */
const scrub = (message: string) =>
  clip(
    cleanLabel(
      message.replace(/(?:[A-Za-z]:)?[\\/](?:[^\s\\/]+[\\/])+[^\s]*/g, 'a temporary file'),
    ),
    300,
  );
/** The sentence she hears for a stopped job. Raw storage, database and tool text only goes to the log. */
function plainProblem(error: unknown, reason: unknown): string {
  if (reason instanceof Halt) return reason.message;
  if (error instanceof Halt || error instanceof Problem) return error.message;
  if (error instanceof MediaError) return scrub(error.message);
  if (axios.isAxiosError(error)) return providerProblem(error, serviceFor(error));
  if (!(error instanceof Error)) return 'Processing stopped unexpectedly.';
  if ((error as { code?: string }).code === 'ENOSPC')
    return 'The server ran out of temporary disk space. Try Continue later, or describe a shorter part.';
  if (infrastructure(error, false))
    return 'The server kept losing its connection to video storage or the job database.';
  if (error.name === 'AbortError') return 'Processing was interrupted.';
  if (/^Media processing failed/.test(error.message))
    return 'The video tools could not process part of this video.';
  const own = error.constructor === Error && !(error as { code?: string }).code;
  return own ? scrub(error.message) : 'Processing stopped unexpectedly.';
}
const fieldHelp: Record<string, string> = {
  voice: 'Choose one of the listed voices.',
  rate: 'Choose a narration speed from 1 to 3 times.',
  maxRate: 'Choose a fastest speed from 1 to 3 times, at least your usual speed.',
  mode: 'Choose one of the listed options.',
  detail: 'Choose one of the listed options.',
  volume: 'Choose one of the listed options.',
  notes: 'Notes can be up to 600 characters.',
  range: 'Check the From and To times of the part to describe.',
  name: 'Give the video a name of up to 200 characters.',
  path: 'Choose a folder name without empty parts or dots.',
  text: 'Type up to 200 characters to try.',
  sections: 'Choose parts of this copy to describe again.',
  note: 'Keep the note to 300 characters.',
  url: 'Enter a YouTube video link.',
  expectedVersion: 'Reopen this video and try again.',
  allowUpToUSD: 'Choose an amount in dollars, up to the limit for one run.',
};
function zodMessage(error: z.ZodError): { error: string; field?: string } {
  const issue = error.issues[0];
  const field = issue?.path.length ? String(issue.path[0]) : undefined;
  if (
    issue?.code === 'custom' ||
    (issue && /^(A description|The part|The fastest)/.test(issue.message))
  )
    return { error: issue.message, field };
  return {
    error:
      (field && fieldHelp[field]) ||
      'Something in that request was not valid. Reload the page and try again.',
    field,
  };
}
type LogValue = string | number | boolean | undefined | null | number[] | Record<string, number>;
const line = (event: string, fields: Record<string, LogValue>) =>
  JSON.stringify({ event, ...fields });
/** Seven PM Central in summer: when the UTC day, and so the allowance, starts fresh. */
function resetText(): string {
  const next = new Date();
  next.setUTCHours(24, 0, 0, 0);
  const time = next.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  });
  return `${time.replace(':00', '')} Central time`;
}
const dateText = (date: Date) =>
  new Date(date).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  });
const counted = (value: number, word: string) => `${value} ${word}${value === 1 ? '' : 's'}`;
/** Every push says where to go, since a tap may open the app on a phone or nothing at all. */
const place = 'Open Make a described video on the website or the app.';
/** The phone bridge keeps 300 characters, so the first part gives way and the rest is kept whole. */
function pushBody(head: string, ...rest: string[]): string {
  const tail = rest.filter(Boolean).join(' ');
  const room = Math.max(40, 300 - tail.length - 1);
  const first = Array.from(head).length > room ? `${clip(head, room - 1).trimEnd()}…` : head;
  return [first, tail].filter(Boolean).join(' ');
}
const keepable = (job: Job): boolean =>
  terminal.includes(job.state) &&
  !!latestCopy(job) &&
  new Date(job.expiresAt).getTime() < Date.now() + keepMaxDays * day - hour;
const sampleText =
  'A woman in a yellow raincoat hurries across the wet street, glances back once, and ducks into a small bookshop.';

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
      new mongoose.Schema<Budget>({ _id: String, held: Number, runs: [String] }),
    );
  const router = Router();
  const worker = randomUUID();
  const heartbeatMs = hooks.timing?.heartbeatMs ?? 10 * second;
  const wedgeMs = hooks.timing?.wedgeMs ?? 2 * minute;
  const lanes = {
    check: { lock: 'video-check', states: checking, running: false },
    render: { lock: 'video', states: ['queued'], running: false },
  };
  let initialized: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let lastCatalog: Awaited<ReturnType<typeof voices>> | undefined;
  const inflight = new Set<Promise<void>>();
  const controllers = new Map<string, AbortController>();
  /** Resolves when a stopped job did not wind down in time, so its lane can move on. */
  const wedges = new Map<string, Promise<void>>();
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
  const warn = (message: string) => (hooks.warn ?? hooks.log)(message);
  /** Every storage call gives up after two minutes, and sooner when the job is stopped. */
  const within = (signal?: AbortSignal, ms: number = 2 * minute) => ({
    abortSignal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(ms)])
      : AbortSignal.timeout(ms),
  });

  /* ---------- storage ---------- */
  async function abortUpload(job: Job): Promise<void> {
    if (!job.uploadId) return;
    await storage()
      .send(
        new AbortMultipartUploadCommand({ Bucket: bucket(), Key: job.key, UploadId: job.uploadId }),
        within(),
      )
      .catch((error: Error) => hooks.log('description upload cleanup: ' + error.message));
  }
  async function listKeys(prefix: string, signal?: AbortSignal): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await storage().send(
        new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }),
        within(signal),
      );
      for (const item of page.Contents || [])
        if (item.Key && item.Key.startsWith(prefix)) keys.push(item.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }
  /**
   * Every stored version under a prefix, delete markers included. B2 keeps each overwrite and
   * turns a plain delete into a hidden file that is still billed, so erasing means removing
   * each version by its id. Stores that do not keep versions answer with the version "null".
   */
  async function listVersions(prefix: string): Promise<{ key: string; version: string }[]> {
    const found: { key: string; version: string }[] = [];
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    for (;;) {
      const page = await storage().send(
        new ListObjectVersionsCommand({
          Bucket: bucket(),
          Prefix: prefix,
          KeyMarker: keyMarker,
          VersionIdMarker: versionMarker,
        }),
        within(),
      );
      for (const item of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])])
        if (item.Key?.startsWith(prefix) && item.VersionId)
          found.push({ key: item.Key, version: item.VersionId });
      const nextKey = page.IsTruncated ? page.NextKeyMarker : undefined;
      const nextVersion = page.NextVersionIdMarker;
      if (!nextKey || (nextKey === keyMarker && nextVersion === versionMarker)) return found;
      keyMarker = nextKey;
      versionMarker = nextVersion;
    }
  }
  /** Removes every version of everything under a prefix, and unfinished multipart uploads. A library original is never touched. */
  async function erasePrefix(prefix: string, keep?: string): Promise<void> {
    const versions = await listVersions(prefix).catch(async (error: unknown) => {
      if (statusOf(error) !== 501 && (error as Error).name !== 'NotImplemented') throw error;
      return (await listKeys(prefix)).map((key) => ({ key, version: '' }));
    });
    for (const item of versions)
      if (item.key !== keep)
        await storage().send(
          new DeleteObjectCommand({
            Bucket: bucket(),
            Key: item.key,
            ...(item.version ? { VersionId: item.version } : {}),
          }),
          within(),
        );
    const open = await storage()
      .send(new ListMultipartUploadsCommand({ Bucket: bucket(), Prefix: prefix }), within())
      .catch((error: Error) => {
        hooks.log('description multipart listing: ' + error.message);
        return undefined;
      });
    for (const upload of open?.Uploads ?? [])
      if (upload.Key?.startsWith(prefix) && upload.UploadId)
        await storage()
          .send(
            new AbortMultipartUploadCommand({
              Bucket: bucket(),
              Key: upload.Key,
              UploadId: upload.UploadId,
            }),
            within(),
          )
          .catch((error: Error) => hooks.log('description multipart cleanup: ' + error.message));
  }
  const eraseAll = (job: Job) => erasePrefix(folder(job) + '/', job.sourceKey);
  async function readText(key: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const output = await storage().send(
        new GetObjectCommand({ Bucket: bucket(), Key: key }),
        within(signal),
      );
      if (!output.Body || !(output.Body instanceof Readable)) return null;
      const chunks: Buffer[] = [];
      for await (const chunk of output.Body) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      if (statusOf(error) === 404 || (error as Error).name === 'NoSuchKey') return null;
      throw error;
    }
  }
  async function readJson<T>(key: string, signal?: AbortSignal): Promise<T | undefined> {
    const text = await readText(key, signal);
    return text ? (JSON.parse(text) as T) : undefined;
  }
  const putText = (key: string, body: string, signal?: AbortSignal, mime = 'application/json') =>
    storage().send(
      new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: mime }),
      within(signal),
    );
  async function exists(key: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await storage().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }), within(signal));
      return true;
    } catch (error) {
      if (statusOf(error) === 404 || (error as Error).name === 'NotFound') return false;
      throw error;
    }
  }
  /**
   * Downloads an object, or a byte range of it written at `offset`, giving up when storage
   * sends nothing for a minute. A whole download is checked against the expected size.
   */
  async function download(
    key: string,
    file: string,
    signal: AbortSignal,
    options: { bytes?: number; range?: [number, number]; offset?: number; limit?: number } = {},
  ): Promise<number> {
    const stall = new AbortController();
    const combined = AbortSignal.any([signal, stall.signal]);
    let timer = setTimeout(
      () => stall.abort(new StorageStall('Video storage stopped sending data.')),
      minute,
    );
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => stall.abort(new StorageStall('Video storage stopped sending data.')),
        minute,
      );
    };
    try {
      const output = await storage().send(
        new GetObjectCommand({
          Bucket: bucket(),
          Key: key,
          ...(options.range ? { Range: `bytes=${options.range[0]}-${options.range[1]}` } : {}),
        }),
        { abortSignal: combined },
      );
      bump();
      if (!(output.Body instanceof Readable)) throw new Error('Video storage returned no stream.');
      if (options.bytes !== undefined && output.ContentLength !== options.bytes) {
        output.Body.destroy();
        throw new Error('The stored video size changed.');
      }
      let received = 0;
      const limit = options.limit ?? options.bytes ?? maxSourceBytes();
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          received += chunk.length;
          bump();
          done(
            received > limit ? new Error('The stored file is larger than expected.') : null,
            chunk,
          );
        },
      });
      const target =
        options.offset === undefined
          ? createWriteStream(file)
          : createWriteStream(file, { flags: 'r+', start: options.offset });
      await pipeline(output.Body, counter, target, { signal: combined });
      if (options.bytes !== undefined && received !== options.bytes)
        throw new Error('The stored video was incomplete.');
      return received;
    } catch (error) {
      if (stall.signal.aborted && !signal.aborted) throw stall.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  /** Bounded-memory upload that a stopped job can interrupt; small bodies go up in one request. */
  async function upload(
    key: string,
    body: Readable,
    mime: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const base = { Bucket: bucket(), Key: key };
    const parts: CompletedPart[] = [];
    let pending: Buffer[] = [];
    let size = 0;
    let total = 0;
    let uploadId: string | undefined;
    const flush = async () => {
      if (!uploadId) {
        const created = await storage().send(
          new CreateMultipartUploadCommand({ ...base, ContentType: mime }),
          within(signal),
        );
        if (!created.UploadId) throw new Error('Storage did not open the upload.');
        uploadId = created.UploadId;
      }
      const buffer = Buffer.concat(pending, size);
      pending = [];
      size = 0;
      const part = parts.length + 1;
      const sent = await storage().send(
        new UploadPartCommand({ ...base, UploadId: uploadId, PartNumber: part, Body: buffer }),
        within(signal, 5 * minute),
      );
      parts.push({ PartNumber: part, ETag: sent.ETag });
    };
    try {
      for await (const chunk of body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        pending.push(buffer);
        size += buffer.length;
        total += buffer.length;
        if (size >= chunkBytes) await flush();
      }
      if (!uploadId) {
        await storage().send(
          new PutObjectCommand({ ...base, ContentType: mime, Body: Buffer.concat(pending, size) }),
          within(signal, 5 * minute),
        );
        return total;
      }
      if (size) await flush();
      await storage().send(
        new CompleteMultipartUploadCommand({
          ...base,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        }),
        within(signal),
      );
      return total;
    } catch (error) {
      body.destroy();
      if (uploadId)
        await storage()
          .send(new AbortMultipartUploadCommand({ ...base, UploadId: uploadId }), within())
          .catch(() => {});
      throw error;
    }
  }
  const putFile = (key: string, file: string, mime: string, signal?: AbortSignal) =>
    upload(key, createReadStream(file, { highWaterMark: 1024 * 1024 }), mime, signal);
  /** Reads a source for the free check: whole when small, otherwise its first and last parts at their real offsets. */
  async function fetchForCheck(
    key: string,
    file: string,
    signal: AbortSignal,
    known?: number,
  ): Promise<{ bytes: number; partial: boolean }> {
    const size =
      known ||
      (await storage().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }), within(signal)))
        .ContentLength ||
      0;
    if (size > maxSourceBytes())
      throw new Problem(
        `This video is ${(size / 1024 ** 3).toFixed(1)} GB. Videos up to ${(maxSourceBytes() / 1024 ** 3).toFixed(0)} GB can be described.`,
      );
    const whole = checkWholeBytes();
    if (!size || size <= whole) {
      const bytes = await download(key, file, signal, { bytes: known || undefined });
      return { bytes, partial: false };
    }
    const head = Math.floor(whole / 4);
    const tail = Math.floor(whole / 8);
    await download(key, file, signal, { range: [0, head - 1], limit: head });
    await download(key, file, signal, {
      range: [size - tail, size - 1],
      offset: size - tail,
      limit: tail,
    });
    return { bytes: size, partial: true };
  }
  /** Refuses a render the temporary disk cannot hold: the source, a working copy and the outputs. */
  async function checkRoom(bytes: number): Promise<void> {
    const info = await statfs(tmpdir()).catch(() => null);
    if (!info) return;
    if (info.bavail * info.bsize < bytes * 2.5 + 512 * 1024 ** 2)
      throw new Problem(
        'The server is short of temporary space for this video right now. Press Continue later, or describe a shorter part.',
      );
  }

  /* ---------- the daily allowance, in cents, one reservation per paid run ---------- */
  async function dayDocument(date: string): Promise<void> {
    await Budgets.updateOne(
      { _id: date },
      { $setOnInsert: { held: 0, runs: [] } },
      { upsert: true },
    );
    await Budgets.updateOne(
      { _id: date, held: { $exists: false } },
      { $set: { held: 0, runs: [] } },
    );
  }
  async function takeFromDay(reservation: Run): Promise<boolean> {
    await dayDocument(reservation.day);
    const taken = await Budgets.updateOne(
      { _id: reservation.day, held: { $lte: Math.round(dailyLimit() * 100) - reservation.cents } },
      { $inc: { held: reservation.cents }, $addToSet: { runs: reservation.runId } },
    );
    return taken.modifiedCount > 0;
  }
  async function growRun(reservation: Run, cents: number): Promise<boolean> {
    const taken = await Budgets.updateOne(
      {
        _id: reservation.day,
        runs: reservation.runId,
        held: { $lte: Math.round(dailyLimit() * 100) - cents },
      },
      { $inc: { held: cents } },
    );
    return taken.modifiedCount > 0;
  }
  /**
   * Closes a run: the day keeps exactly what it spent (more than was set aside, if a provider
   * charged above its estimate). Keyed by the run, so it happens once and never touches another run's money.
   */
  async function release(reservation: Run | undefined, spentUSD: number): Promise<void> {
    if (!reservation?.runId) return;
    await Budgets.updateOne(
      { _id: reservation.day, runs: reservation.runId },
      { $inc: { held: toCents(spentUSD) - reservation.cents }, $pull: { runs: reservation.runId } },
    );
  }
  async function remaining(): Promise<number> {
    const budget = await Budgets.findById(today()).lean();
    return Math.max(0, Math.round(dailyLimit() * 100) - (budget?.held || 0)) / 100;
  }
  /** What open runs hold today, to say why the allowance looks spent. */
  async function heldByOpenRuns(): Promise<number> {
    const open = await Jobs.find(
      { state: { $in: busy }, 'reservation.day': today() },
      { reservation: 1, runCost: 1 },
    ).lean();
    return (
      open.reduce(
        (sum, job) => sum + Math.max(0, (job.reservation?.cents ?? 0) - toCents(job.runCost ?? 0)),
        0,
      ) / 100
    );
  }
  async function allowanceText(setAside: number): Promise<string> {
    const left = await remaining();
    const held = await heldByOpenRuns();
    return [
      `This needs about ${money(setAside)} set aside, and ${money(left)} of today's ${money(dailyLimit())} processing allowance is left.`,
      held > 0
        ? `Videos still being described have ${money(held)} of it set aside; what they do not use comes back when they finish.`
        : '',
      `The allowance starts fresh at ${resetText()}.`,
    ]
      .filter(Boolean)
      .join(' ');
  }

  /* ---------- notices and logs ---------- */
  function tell(job: Pick<Job, '_id' | 'owner'>, kind: string, title: string, body: string): void {
    if (!hooks.notify) return;
    void hooks
      .notify(job.owner, title, body, `/described-video?id=${job._id}`, { job: job._id, kind })
      .then(async (result) => {
        const text = result ? JSON.stringify(result) : 'sent';
        hooks.log(line('dv.notify', { id: job._id, kind, result: text }));
        await Jobs.updateOne(
          { _id: job._id },
          { $set: { lastNotice: { at: new Date(), kind, result: text.slice(0, 200) } } },
        );
      })
      .catch((error: Error) =>
        warn(line('dv.notify', { id: job._id, kind, error: scrub(error.message) })),
      );
  }
  const continueText =
    'Finished sections are kept. Press Continue to carry on; it also tries again on parts that could not be described.';
  /**
   * A rehearsal that ends for any reason leaves the video ready to describe, with the reason kept
   * and how it ended, so the page can say "Rehearsal finished" rather than "Video checked".
   */
  const rehearsalStop = (
    job: Pick<Job, 'version'>,
    outcome: RehearsalOutcome,
    error: string = '',
  ) =>
    split({
      state: 'ready',
      active: true,
      stage: 'Ready to describe',
      progress: 0,
      error,
      lastRehearsal: { outcome, version: job.version || 1, at: new Date() },
      cancelRequested: false,
      worker: undefined,
      lease: undefined,
      cancelAt: undefined,
      runKind: undefined,
      approvedUSD: undefined,
      runEstimateUSD: undefined,
      reservation: undefined,
      stopAfter: undefined,
      preview: undefined,
    });
  const rehearsing = (job: Pick<Job, 'runKind' | 'state'>) =>
    job.runKind === 'rehearsal' && busy.includes(job.state);
  /**
   * Erases what a rehearsal that did not finish wrote under its version: its looks, first look,
   * sections and any half-saved copy, so no placeholder can reach a paid copy.
   */
  async function eraseRehearsal(job: Job): Promise<void> {
    const version = job.version || 1;
    if (copiesFor(job).some((copy) => copy.version === version)) return;
    const prefix = folder(job);
    await Promise.all([
      erasePrefix(`${prefix}/looks/v${version}/`),
      erasePrefix(`${prefix}/sections/v${version}/`),
      erasePrefix(`${prefix}/copies/${version}/`),
      erasePrefix(`${prefix}/first-look-${version}.json`),
    ]).catch((error: Error) => hooks.log('description rehearsal cleanup: ' + error.message));
  }

  /* ---------- the job as the page sees it ---------- */
  const eta = (job: Job) => {
    if (job.state !== 'running' || !job.runAt) return undefined;
    const done = job.progress - (job.runFrom || 0);
    if (done < 3) return undefined;
    const elapsed = (Date.now() - new Date(job.runAt).getTime()) / 1000;
    return Math.round((elapsed * (100 - job.progress)) / done);
  };
  async function queueAhead(): Promise<Map<string, number>> {
    const waiting = await Jobs.find(
      { state: { $in: ['queued', 'running'] } },
      { _id: 1, state: 1, priority: 1, queuedAt: 1, createdAt: 1 },
    )
      .sort({ priority: 1, queuedAt: 1, createdAt: 1 })
      .lean();
    const ahead = new Map<string, number>();
    let count = waiting.filter((job) => job.state === 'running').length;
    for (const job of waiting) if (job.state === 'queued') ahead.set(job._id, count++);
    return ahead;
  }
  const publicJob = (job: Job, ahead?: Map<string, number>) => {
    const copies = copiesFor(job);
    const latest = latestCopy(job);
    const stopped = ['failed', 'cancelled'].includes(job.state);
    const library = job.source === 'library' ? job.sourcePrivacy : undefined;
    return {
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
      costUSD: Math.round((job.costUSD || 0) * 10000) / 10000,
      runCostUSD: Math.round((job.runCost ?? 0) * 10000) / 10000,
      setAsideUSD: (job.reservation?.cents ?? 0) / 100,
      estimatedUSD: job.runEstimateUSD,
      approvedUSD: job.approvedUSD,
      overQuote: job.state === 'failed' && !!job.overQuote,
      outputSeconds: job.outputSeconds,
      descriptions: job.count,
      skipped: job.skipped,
      failedSections: job.failedSections,
      sections: job.sections,
      done: job.done,
      resumable: stopped && !!job.settings && !!job.seconds && !crashLocked(job),
      abandonable: stopped && !!latest,
      keepable: keepable(job),
      finishable:
        job.state === 'done' && !!latest?.preview && latest.version === (job.version || 1),
      retryableSections: job.state === 'done' ? (latest?.failed?.length ?? 0) : 0,
      recheckable: job.state === 'failed' && !job.settings && job.checkFailure === 'transient',
      copies: copies.map(publicCopy),
      version: job.version || 1,
      kind: job.kind,
      savedToLibrary: job.savedToLibrary,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      expiresAt: job.expiresAt,
      cancelRequested: job.cancelRequested,
      cancelStuck:
        !!job.cancelRequested &&
        !terminal.includes(job.state) &&
        !!job.cancelAt &&
        Date.now() - new Date(job.cancelAt).getTime() > 30 * second,
      uploadedBytes: job.uploadedBytes || 0,
      queuePosition: job.state === 'queued' ? ahead?.get(job._id) : undefined,
      sourcePrivate: library ? !library.shared : undefined,
      sourceGrownUps: library ? !!library.grownUpsOnly : undefined,
      sourceOwner: library ? (library.ownerIsActor ? 'you' : 'someone else') : undefined,
      range: job.settings?.range,
      preview: !!job.preview,
      libraryPath: job.source === 'library' ? describedShelf(job.sourcePath) : defaultLibraryPath,
      restarts: job.restarts ?? 0,
      lastRehearsal: job.lastRehearsal?.outcome
        ? {
            outcome: job.lastRehearsal.outcome,
            version: job.lastRehearsal.version,
            at: job.lastRehearsal.at,
          }
        : undefined,
    };
  };
  const single = async (job: Job) =>
    publicJob(job, job.state === 'queued' ? await queueAhead() : undefined);

  /* ---------- requests ---------- */
  router.use(hooks.auth);
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const actor = hooks.actor(req);
    if (actor.child) {
      res.status(403).json({ error: "Described video is not available on children's accounts." });
      return;
    }
    if (actor.role !== 'ADMIN' && process.env.KADE_DESCRIPTION_PUBLIC !== '1') {
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
      Promise.resolve(action(req, res, next)).catch((error: unknown) => {
        if (res.headersSent) {
          warn(line('dv.request', { path, error: scrub(String((error as Error)?.message)) }));
          return;
        }
        if (error instanceof z.ZodError) {
          res.status(400).json(zodMessage(error));
          return;
        }
        const status = (error as { status?: unknown }).status;
        if (
          error instanceof Problem ||
          (typeof status === 'number' && [400, 403, 404, 409, 503].includes(status))
        ) {
          const known = error as Error & { status: number; field?: string };
          res.status(known.status).json({
            error: known.message,
            ...(known.field ? { field: known.field } : {}),
          });
          return;
        }
        warn(
          line('dv.request', {
            path,
            error:
              error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 500) : 'unknown',
          }),
        );
        res
          .status(500)
          .json({ error: 'The server had a problem with that step. Try again in a minute.' });
      });
    });
  }
  async function owned(req: Request): Promise<Job> {
    const id = String(req.params.id || '');
    const job = /^[a-f0-9]{32}$/.test(id)
      ? await Jobs.findOne({ _id: id, owner: hooks.actor(req).id }).lean()
      : null;
    if (!job) throw new Problem('Video job not found.', 404);
    return job;
  }
  async function roomFor(owner: string): Promise<void> {
    if ((await Jobs.countDocuments({ owner, active: true })) >= maxUnfinished)
      throw new Problem(
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
  async function voiceCatalog(): Promise<
    Awaited<ReturnType<typeof voices>> & { available: boolean }
  > {
    try {
      lastCatalog = await voices();
      return { ...lastCatalog, available: true };
    } catch (error) {
      warn(line('dv.voices', { error: scrub((error as Error).message || 'failed') }));
      return lastCatalog ? { ...lastCatalog, available: true } : { voices: [], available: false };
    }
  }
  async function requireVoice(voice: string): Promise<void> {
    const catalog = await voiceCatalog();
    if (!catalog.available)
      throw new Problem(
        'The list of voices could not be loaded right now. Try again in a minute.',
        503,
      );
    if (!catalog.voices.includes(voice))
      throw new Problem('Choose one of the listed voices.', 400, 'voice');
  }
  const whenConfigured = () => {
    if (!configured()) throw new Problem('Video description is not available right now.', 503);
  };

  /* ---------- what each paid action would do and cost ---------- */
  type Launch = {
    kind: RunKind;
    from: string[];
    settings: Settings;
    price: Price;
    patch: Partial<Job>;
    expectedVersion?: number;
    /** A raised approval she chose for this run; otherwise the quote plus headroom. */
    approvedUSD?: number;
  };
  const storedSpans = (job: Job, range?: Interval) =>
    job.planKey === planKey(range) && (job.spans?.length ?? 0) > 1 ? job.spans : undefined;
  function readSettings(job: Job, body: unknown): { settings: Settings; preview: boolean } {
    const settings = settingsSchema.parse(body);
    const preview =
      z.object({ preview: z.boolean().optional() }).parse(body ?? {}).preview === true;
    const seconds = job.seconds || 0;
    if (settings.range) {
      const start = settings.range.start;
      const end = Math.min(settings.range.end, seconds);
      if (start >= seconds - 1 || end - start < 1)
        throw new Problem(
          'The part to describe must start before the video ends and last at least a second.',
          400,
          'range',
        );
      settings.range = start <= 0.5 && end >= seconds - 0.5 ? undefined : { start, end };
      if (!settings.range) delete settings.range;
    }
    const length = workingSeconds(seconds, settings.range);
    if (length > maxMinutes() * 60)
      throw new Problem(
        settings.range
          ? `The part to describe can be up to ${maxMinutes()} minutes long.`
          : `This video is ${spokenLength(seconds)} long. One run can describe up to ${maxMinutes()} minutes, so choose a part of it.`,
        400,
        'range',
      );
    return { settings, preview: preview && length > previewSeconds() };
  }
  const priorityFor = (seconds: number) => (seconds <= 5 * 60 ? 0 : 1);
  function freshPatch(job: Job, version: number, stopAfter?: number): Partial<Job> {
    return {
      version,
      lastVersion: Math.max(version, job.lastVersion ?? 0),
      firstLookVersion: version,
      firstLookThrough: undefined,
      revoice: false,
      reuseUnchanged: false,
      edits: [],
      redo: [],
      sectionNotes: {},
      manifest: [],
      retry: [],
      base: undefined,
      carry: undefined,
      done: 0,
      crashes: 0,
      crashAt: undefined,
      stopAfter,
      preview: stopAfter !== undefined,
      savedToLibrary: '',
    };
  }
  function launchStart(job: Job, body: unknown, from: string[], version: number): Launch {
    if (!job.seconds) throw new Problem('Wait for the video to finish checking.');
    const { settings, preview } = readSettings(job, body);
    const whole = workingSeconds(job.seconds, settings.range);
    const spans = storedSpans(job, settings.range);
    const stopAfter = preview ? previewSeconds() : undefined;
    const covered = spans
      ? lengths(spans, inScope(spans, stopAfter))
      : roughCover(whole, stopAfter);
    return {
      kind: preview ? 'preview' : 'fresh',
      from,
      settings,
      price: priceFor(
        {
          looks: covered,
          voiced: covered,
          dialogue: spans ? 0 : whole,
          firstLook: whole > 120 ? covered : 0,
          fixed: overhead.describe,
        },
        settings,
      ),
      patch: { ...freshPatch(job, version, stopAfter), startedAt: new Date() },
    };
  }
  function expected(job: Job, body: unknown, required: boolean): number | undefined {
    const value = z
      .number()
      .int()
      .positive()
      .optional()
      .parse((body as { expectedVersion?: unknown } | undefined)?.expectedVersion);
    if (value === undefined && required)
      throw new Problem('Reopen this video before making a new version.', 400, 'expectedVersion');
    if (value !== undefined && value !== (job.version || 1))
      throw new Problem('This video has a newer version. Reopen it before making another.');
    return value;
  }
  function launchReanalyze(job: Job, body: unknown): Launch {
    if (job.state !== 'done' || !job.seconds)
      throw new Problem('Wait for this video to finish before describing it again.');
    const expectedVersion = expected(job, body, true);
    const launch = launchStart(job, body, ['done'], nextVersion(job));
    return {
      ...launch,
      expectedVersion,
      patch: { ...launch.patch, ...(!job.copies?.length ? { copies: copiesFor(job) } : {}) },
    };
  }
  async function baseRecords(job: Job, copy: FinishedCopy, signal?: AbortSignal) {
    const manifest = manifestOf(job, copy);
    const records = new Map<number, SectionRecord>();
    for (const [index, from] of manifest.entries()) {
      if (from === null || from === undefined) continue;
      const record = await readSection(job, from, index, signal);
      if (record) records.set(index, record);
    }
    return records;
  }
  function parseEdits(value: unknown): Edit[] {
    try {
      return editsSchema.parse(value ?? []);
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      const issue = error.issues[0];
      throw new Problem(
        issue?.code === 'custom' ||
          issue?.path.includes('text') ||
          issue?.path.includes('shortText')
          ? issue.message
          : 'A correction could not be read. Reopen the script and try again.',
        400,
        'edits',
      );
    }
  }
  async function launchRevoice(job: Job, body: unknown, strict: boolean): Promise<Launch> {
    if (job.state !== 'done' || !job.seconds || !job.settings)
      throw new Problem('Only a finished described copy can be made again with new narration.');
    const base = latestCopy(job);
    if (!base) throw new Problem('There is no finished version to narrate again.');
    const input = voiceSchema.parse(body ?? {});
    const settings = settingsSchema.parse({ ...job.settings, ...input });
    const edits = parseEdits((body as { edits?: unknown } | undefined)?.edits);
    const expectedVersion = expected(job, body, edits.length > 0);
    if (strict && edits.length) {
      const known = new Set(
        scriptCues([...(await baseRecords(job, base)).values()]).map((cue) => cue.id),
      );
      if (edits.some((edit) => !known.has(edit.id)))
        throw new Problem('A description no longer exists. Reopen the script.');
    }
    const reuseUnchanged = edits.length > 0 && sameVoice(settings, job.settings);
    const manifest = manifestOf(job, base);
    const edited = new Set(edits.map((edit) => Number(edit.id.split(':')[0])));
    const whole = workingSeconds(job.seconds, base.range);
    const stopAfter = base.preview ? previewSeconds() : undefined;
    const spans = base.spans;
    const failed = new Set(base.failed ?? []);
    const voiced = spans
      ? lengths(
          spans,
          allSections(spans.length - 1).filter((i) => manifest[i] != null && !failed.has(i)),
        )
      : roughCover(whole, stopAfter);
    const price = reuseUnchanged
      ? priceFor(
          {
            looks: 0,
            voiced: 0,
            dialogue: 0,
            firstLook: 0,
            bytes: edits.reduce(
              (sum, edit) =>
                sum + (edit.omit ? 0 : Buffer.byteLength(edit.text + edit.shortText, 'utf8')),
              0,
            ),
            fixed: overhead.correction,
          },
          settings,
        )
      : priceFor(
          { looks: 0, voiced, dialogue: 0, firstLook: 0, fixed: overhead.revoice },
          settings,
        );
    const version = nextVersion(job);
    return {
      kind: reuseUnchanged ? 'correction' : 'revoice',
      from: ['done'],
      settings,
      price,
      expectedVersion: expectedVersion ?? (job.version || 1),
      patch: {
        ...freshPatch(job, version, stopAfter),
        firstLookVersion: job.firstLookVersion,
        firstLookThrough: job.firstLookThrough,
        revoice: true,
        reuseUnchanged,
        edits,
        base: base.version,
        manifest: reuseUnchanged ? manifest.map((entry, i) => (edited.has(i) ? null : entry)) : [],
        ...(!job.copies?.length ? { copies: copiesFor(job) } : {}),
      },
    };
  }
  function launchRedo(job: Job, body: unknown): Launch {
    if (job.state !== 'done' || !job.seconds || !job.settings)
      throw new Problem('Wait for this video to finish before describing parts of it again.');
    const expectedVersion = expected(job, body, true);
    const base = latestCopy(job);
    if (!base?.sections || !base.spans)
      throw new Problem(
        'This copy was made before parts could be described again. Use Write fresh descriptions instead.',
      );
    const input = z
      .object({
        sections: z.array(z.number().int().min(0).max(999)).max(500).optional(),
        note: z.string().max(600).optional(),
      })
      .parse(body ?? {});
    const manifest = base.sections;
    const sections = [
      ...new Set(input.sections?.length ? input.sections : (base.failed ?? [])),
    ].sort((a, b) => a - b);
    if (sections.some((i) => manifest[i] === null || manifest[i] === undefined))
      throw new Problem('That part is not in this copy.', 400, 'sections');
    if (!sections.length)
      throw new Problem(
        'Every part of this copy was described. Choose the parts to describe again.',
      );
    const note = clip(cleanLabel(input.note ?? ''), 300);
    const seconds = lengths(base.spans, sections);
    const version = nextVersion(job);
    return {
      kind: 'redo',
      from: ['done'],
      settings: job.settings,
      expectedVersion,
      price: priceFor(
        { looks: seconds, voiced: seconds, dialogue: 0, firstLook: 0, fixed: overhead.describe },
        job.settings,
      ),
      patch: {
        ...freshPatch(job, version, base.preview ? previewSeconds() : undefined),
        firstLookVersion: job.firstLookVersion,
        firstLookThrough: job.firstLookThrough,
        base: base.version,
        redo: sections,
        sectionNotes: note ? Object.fromEntries(sections.map((i) => [String(i), note])) : {},
        manifest: manifest.map((entry, i) => (sections.includes(i) ? null : entry)),
      },
    };
  }
  function launchFinish(job: Job): Launch {
    const copy = latestCopy(job);
    if (
      job.state !== 'done' ||
      !job.seconds ||
      !job.settings ||
      !copy?.preview ||
      copy.version !== (job.version || 1)
    )
      throw new Problem('Only a preview can be continued to the whole video.');
    const whole = workingSeconds(job.seconds, copy.range);
    const manifest = copy.sections ?? [];
    const count = copy.spans ? copy.spans.length - 1 : 0;
    const pending = allSections(count).filter(
      (i) => manifest[i] === null || manifest[i] === undefined,
    );
    const seconds = copy.spans
      ? lengths(copy.spans, pending)
      : whole - roughCover(whole, previewSeconds());
    const surveyed = (job.firstLookThrough ?? 0) >= count && count > 0;
    return {
      kind: 'finish',
      from: ['done'],
      settings: job.settings,
      price: priceFor(
        {
          looks: seconds,
          voiced: seconds,
          dialogue: 0,
          firstLook: whole > 120 && !surveyed ? seconds : 0,
          fixed: overhead.revoice,
        },
        job.settings,
      ),
      patch: {
        stopAfter: undefined,
        preview: false,
        manifest,
        retry: [],
        crashes: 0,
        crashAt: undefined,
        done: doneCount(manifest),
        base: undefined,
        carry: undefined,
        redo: [],
        sectionNotes: {},
      },
    };
  }
  function launchResume(job: Job, body: unknown): Launch {
    if (!['failed', 'cancelled'].includes(job.state) || !job.settings || !job.seconds)
      throw new Problem('Only a stopped job can be continued.');
    if (crashLocked(job)) throw new Problem(crashText);
    const settings = settingsSchema.parse({ ...job.settings, ...voiceSchema.parse(body ?? {}) });
    const kind: RunKind =
      job.runKind ?? (job.revoice ? (job.reuseUnchanged ? 'correction' : 'revoice') : 'fresh');
    const whole = workingSeconds(job.seconds, settings.range);
    const spans = storedSpans(job, settings.range);
    const retry = new Set(job.retry ?? []);
    const manifest = (job.manifest ?? []).map((entry, i) => (retry.has(i) ? null : entry));
    const changed = !sameVoice(settings, job.settings) && doneCount(manifest) > 0;
    const redo = new Set(job.redo ?? []);
    const scope = spans ? (kind === 'redo' ? [...redo] : inScope(spans, job.stopAfter)) : [];
    const pending = scope.filter((i) => manifest[i] === null || manifest[i] === undefined);
    const firstLook =
      describing.includes(kind) && whole > 120 && (job.firstLookThrough ?? 0) < scope.length;
    let work: Work;
    if (!spans) {
      const covered = roughCover(whole, job.stopAfter);
      work =
        describing.includes(kind) || kind === 'redo'
          ? {
              looks: covered,
              voiced: covered,
              dialogue: whole,
              firstLook: covered,
              fixed: overhead.describe,
            }
          : { looks: 0, voiced: covered, dialogue: 0, firstLook: 0, fixed: overhead.revoice };
    } else if (changed) {
      const all = inScope(spans, job.stopAfter);
      const unlooked = pending.filter((i) => describing.includes(kind) || redo.has(i));
      work = {
        looks: lengths(spans, unlooked),
        voiced: lengths(spans, all),
        dialogue: 0,
        firstLook: firstLook ? lengths(spans, unlooked) : 0,
        fixed: overhead.revoice,
      };
    } else if (kind === 'correction') {
      const open = new Set(pending);
      work = {
        looks: 0,
        voiced: 0,
        dialogue: 0,
        firstLook: 0,
        bytes: (job.edits ?? []).reduce(
          (sum, edit) =>
            sum +
            (edit.omit || !open.has(Number(edit.id.split(':')[0]))
              ? 0
              : Buffer.byteLength(edit.text + edit.shortText, 'utf8')),
          0,
        ),
        fixed: overhead.correction,
      };
    } else if (kind === 'revoice') {
      work = {
        looks: 0,
        voiced: lengths(spans, pending),
        dialogue: 0,
        firstLook: 0,
        fixed: overhead.revoice,
      };
    } else {
      const seconds = lengths(spans, pending);
      work = {
        looks: seconds,
        voiced: seconds,
        dialogue: 0,
        firstLook: firstLook ? seconds : 0,
        fixed: overhead.describe,
      };
    }
    const patch: Partial<Job> = changed
      ? {
          version: nextVersion(job),
          lastVersion: nextVersion(job),
          revoice: true,
          reuseUnchanged: false,
          carry: manifest,
          manifest: [],
          retry: [],
          done: 0,
          crashes: 0,
          crashAt: undefined,
        }
      : { manifest, retry: [], done: doneCount(manifest) };
    return {
      kind: changed ? 'revoice' : kind,
      from: ['failed', 'cancelled'],
      settings,
      price: priceFor(work, settings),
      patch,
    };
  }
  /** What continuing a stopped run would be quoted now; 0 when it could not be continued. */
  function restEstimate(job: Job): number {
    try {
      return launchResume({ ...job, state: 'failed' }, {}).price.estimateUSD;
    } catch {
      return 0;
    }
  }
  /**
   * The ask a run that stopped over its quote names, cut to what today will have left once the
   * run closes and the day keeps what it really spent, as the estimate for Continue does.
   */
  async function askAfterHalt(job: Job, over: OverQuote): Promise<number> {
    const closing = (job.reservation?.cents ?? 0) - toCents(job.runCost ?? 0);
    const left = await remaining().then(
      (value) => Math.max(0, Math.round(value * 100) + closing) / 100,
      () => jobLimit(),
    );
    return askWithin(restEstimate(job), over, left);
  }
  /**
   * A ready video's first copy is version 1. Once any run has used a number (a rehearsal, even
   * one that stopped), the next run takes a fresh one, so it never finds that run's looks.
   */
  const readyVersion = (job: Job) =>
    job.copies?.length || job.lastVersion ? nextVersion(job) : job.version || 1;
  /**
   * A free run of the whole pipeline through real storage and the real media tools, with
   * stand-in providers. Nothing is set aside and no paid request is ever sent.
   */
  function launchRehearsal(job: Job, body: unknown): Launch {
    if (job.state !== 'ready')
      throw new Problem('A rehearsal runs on a checked video that is ready to describe.');
    const input = {
      voice: job.settings?.voice || 'Rehearsal tone',
      ...(body && typeof body === 'object' ? body : {}),
    };
    const launch = launchStart(job, input, ['ready'], readyVersion(job));
    return {
      ...launch,
      kind: 'rehearsal',
      approvedUSD: 0,
      price: {
        ...launch.price,
        estimateUSD: 0,
        setAsideUSD: 0,
        breakdown: { vision: 0, speech: 0, dialogue: 0, closeLook: 0, firstLook: 0 },
      },
    };
  }
  async function launchFor(
    job: Job,
    action: string,
    body: unknown,
    strict: boolean,
  ): Promise<Launch> {
    if (action === 'start' || action === 'preview') {
      if (job.state === 'failed' && !job.settings)
        throw new Problem(
          job.checkFailure === 'transient'
            ? 'Checking this video was interrupted. Press Check again first.'
            : 'This video could not be checked, so it cannot be described.',
        );
      if (job.state !== 'ready') throw new Problem('Wait for the video to finish checking.');
      const input = { ...((body as object) ?? {}), preview: action === 'preview' };
      return launchStart(job, action === 'start' ? body : input, ['ready'], readyVersion(job));
    }
    if (action === 'reanalyze') return launchReanalyze(job, body);
    if (action === 'revoice') return launchRevoice(job, body, strict);
    if (action === 'redo') return launchRedo(job, body);
    if (action === 'finish') return launchFinish(job);
    return launchResume(job, body);
  }

  /**
   * Moves a job from one of `from` into the paid queue once, whatever the number of clicks,
   * setting aside this run's money under its own reservation.
   */
  async function enqueue(req: Request, job: Job, launch: Launch): Promise<Job> {
    const { price, settings } = launch;
    if (price.estimateUSD > jobLimit())
      throw new Problem(
        `This is estimated at ${money(price.estimateUSD)}, above the ${money(jobLimit())} limit for one run. Choose less detail, turn off the extra passes, or describe a shorter part.`,
      );
    const rehearsal = launch.kind === 'rehearsal';
    const reservation: Run = {
      runId: randomUUID(),
      day: today(),
      cents: rehearsal ? 0 : toCents(price.setAsideUSD),
    };
    const approvedUSD = rehearsal ? 0 : (launch.approvedUSD ?? approvalFor(price.estimateUSD));
    const guard =
      launch.expectedVersion === undefined
        ? {}
        : { version: launch.expectedVersion === 1 ? { $in: [1, null] } : launch.expectedVersion };
    let claimed: Job | null = null;
    for (const state of launch.from) {
      claimed = await Jobs.findOneAndUpdate(
        { _id: job._id, state, ...guard },
        {
          $set: {
            state: 'reserving',
            reservingFrom: state,
            cancelRequested: false,
            pendingRun: reservation,
          },
          $unset: { cancelAt: 1 },
        },
        { new: true },
      ).lean();
      if (claimed) break;
    }
    if (!claimed) {
      if (launch.expectedVersion !== undefined)
        throw new Problem(
          'This video changed in another tab. Reopen it before making a new version.',
        );
      return owned(req);
    }
    const restore = (to: string) =>
      Jobs.updateOne(
        { _id: job._id, state: 'reserving', 'pendingRun.runId': reservation.runId },
        {
          $set: { state: to, cancelRequested: false },
          $unset: { pendingRun: 1, reservingFrom: 1 },
        },
      );
    if (!rehearsal && !(await takeFromDay(reservation))) {
      await restore(claimed.reservingFrom || job.state);
      throw new Problem(await allowanceText(price.setAsideUSD));
    }
    const { set, unset } = split({
      ...launch.patch,
      state: 'queued',
      active: true,
      settings,
      reservation,
      runCost: 0,
      runKind: launch.kind,
      runEstimateUSD: price.estimateUSD,
      approvedUSD,
      overQuote: undefined,
      stage: rehearsal ? 'Waiting for its turn to rehearse' : 'Waiting for its turn',
      error: '',
      retries: 0,
      queuedAt: new Date(),
      priority: priorityFor(price.seconds),
      expiresAt: retain(job, 3),
    });
    const queued = await Jobs.findOneAndUpdate(
      {
        _id: job._id,
        state: 'reserving',
        cancelRequested: false,
        'pendingRun.runId': reservation.runId,
      },
      { $set: set, $unset: { ...unset, pendingRun: 1, reservingFrom: 1 } },
      { new: true },
    ).lean();
    if (!queued) {
      await release(reservation, 0);
      await restore(claimed.reservingFrom || job.state);
    } else
      hooks.log(
        line('dv.queue', {
          id: job._id,
          owner: ownerTag(job.owner),
          kind: launch.kind,
          version: queued.version || 1,
          estimateUSD: price.estimateUSD,
          setAsideUSD: reservation.cents / 100,
          approvedUSD,
        }),
      );
    void tick();
    return queued || owned(req);
  }
  function split(patch: Partial<Job>): { set: Partial<Job>; unset: Partial<Record<keyof Job, 1>> } {
    const set: Partial<Job> = {};
    const unset: Partial<Record<keyof Job, 1>> = {};
    for (const key of Object.keys(patch) as (keyof Job)[]) {
      if (patch[key] === undefined) unset[key] = 1;
      else Object.assign(set, { [key]: patch[key] });
    }
    return { set, unset };
  }

  route('get', '/config', async (req, res) => {
    const catalog = await voiceCatalog();
    const perMinute = (detail: Settings['detail']) =>
      Math.round((rates.vision + speechPerMinute(detail) + transcriptionPerMinute) * 10000) / 10000;
    res.json({
      enabled: configured(),
      maxBytes: 2 * 1024 ** 3,
      chunkBytes,
      maxMinutes: maxMinutes(),
      maxSourceMinutes: maxSourceMinutes(),
      limitUSD: jobLimit(),
      dailyUSD: dailyLimit(),
      remainingUSD: await remaining(),
      perMinuteUSD: {
        essential: perMinute('essential'),
        standard: perMinute('standard'),
        rich: perMinute('rich'),
      },
      extrasPerMinuteUSD: { closeLook: rates.closeLook, firstLook: rates.firstLook },
      setAside: setAsideRule,
      approval: approvalRule,
      keep: { days: keepDays, maxDays: keepMaxDays },
      ...(hooks.actor(req).role === 'ADMIN' ? { rehearsal: true } : {}),
      previewSeconds: previewSeconds(),
      library: !!hooks.library,
      defaultLibraryPath,
      defaultVoice:
        catalog.voices.find((voice) => /^clear woman . flint$/.test(voice)) || catalog.voices[0],
      voicesAvailable: catalog.available,
      voices: catalog.voices,
      describe: catalog.describe,
      categories: catalog.categories,
    });
  });
  route('get', '/library-folders', async (req, res) => {
    const folders = (await hooks.library?.folders?.(req)) ?? [];
    res.json({ folders: [...new Set([defaultLibraryPath, ...folders])].sort() });
  });
  route('get', '/jobs', async (req, res) => {
    const jobs = await Jobs.find({ owner: hooks.actor(req).id })
      .sort({ createdAt: -1 })
      .limit(40)
      .lean();
    const ahead = jobs.some((job) => job.state === 'queued') ? await queueAhead() : undefined;
    res.json({ jobs: jobs.map((job) => publicJob(job, ahead)), remainingUSD: await remaining() });
  });
  route('get', '/jobs/:id', async (req, res) => {
    res.json(await single(await owned(req)));
  });
  route('post', '/uploads', async (req, res) => {
    whenConfigured();
    const input = uploadSchema.parse(req.body);
    const owner = hooks.actor(req).id;
    const id = input.resumeId || descriptionJobId(owner, input.requestId);
    if (input.resumeId && !(await Jobs.exists({ _id: id, owner })))
      throw new Problem('Video upload not found.', 404);
    let job = await createOnce(id, owner, {
      name: clip(cleanLabel(input.name), 240) || 'Video',
      originalName: input.name,
      bytes: input.bytes,
      source: 'upload',
      state: 'uploading',
    });
    if (job.bytes !== input.bytes || (job.originalName ?? job.name) !== input.name)
      throw new Problem('This upload recovery ID belongs to another file.');
    if (job.state === 'uploading' && !job.uploadId) {
      const opened = await storage().send(
        new CreateMultipartUploadCommand({
          Bucket: bucket(),
          Key: job.key,
          ContentType: 'application/octet-stream',
        }),
        within(),
      );
      if (!opened.UploadId) throw new Error('Storage did not open the upload.');
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
    whenConfigured();
    const input = z.object({ url: z.string().min(1).max(2048), requestId }).parse(req.body);
    let url: string;
    try {
      url = youtubeURL(input.url);
    } catch (error) {
      throw new Problem(
        error instanceof Error && !(error instanceof TypeError) && !(error instanceof z.ZodError)
          ? scrub(error.message)
          : 'Enter a YouTube video link.',
        400,
        'url',
      );
    }
    const owner = hooks.actor(req).id;
    const job = await createOnce(descriptionJobId(owner, 'youtube:' + input.requestId), owner, {
      name: 'YouTube video',
      bytes: 0,
      youtube: url,
      source: 'youtube',
      state: 'importing',
      stage: 'Waiting to import the YouTube video',
    });
    if (job.youtube !== url) throw new Problem('This import recovery ID belongs to another video.');
    res.status(202).json(publicJob(job));
    void tick();
  });
  route('post', '/library-imports', async (req, res) => {
    whenConfigured();
    if (!hooks.library) throw new Problem('Library videos are not available here.', 503);
    const input = z
      .object({
        book: z.string().regex(/^[a-f0-9]{24}$/),
        track: z.number().int().min(0).max(5000),
        requestId,
      })
      .parse(req.body);
    const owner = hooks.actor(req).id;
    const id = descriptionJobId(owner, `library:${input.requestId}`);
    const earlier = await Jobs.findOne({
      owner,
      'library.book': input.book,
      'library.track': input.track,
      state: { $ne: 'deleting' },
    })
      .sort({ createdAt: -1 })
      .lean();
    if (earlier && earlier._id !== id) {
      res.json({ ...(await single(earlier)), existing: true });
      return;
    }
    const found = await hooks.library.open(req, input.book, input.track);
    if (found.bytes > maxSourceBytes())
      throw new Problem(
        `This library video is ${(found.bytes / 1024 ** 3).toFixed(1)} GB. Videos up to ${(maxSourceBytes() / 1024 ** 3).toFixed(0)} GB can be described.`,
      );
    const job = await createOnce(id, owner, {
      name: clip(cleanLabel(found.title), 200) || 'Library video',
      bytes: found.bytes,
      about: clip(found.about || '', 2000),
      source: 'library',
      sourceKey: found.key,
      sourcePrivacy: {
        shared: !!found.shared,
        grownUpsOnly: !!found.grownUpsOnly,
        ownerIsActor: !!found.ownerIsActor,
      },
      sourcePath: found.path ? clip(found.path, 400) : undefined,
      context: found.context ? clip(cleanLabel(found.context), 600) : undefined,
      library: { book: input.book, track: input.track },
      state: 'checking',
      stage: 'Waiting to check the library video',
    });
    res.status(202).json({ ...publicJob(job), existing: false });
    void tick();
  });
  router.use('/jobs/:id/chunks', raw({ type: 'application/octet-stream', limit: chunkBytes }));
  route('post', '/jobs/:id/chunks', async (req, res) => {
    const job = await owned(req);
    if (job.state !== 'uploading' || !job.uploadId) {
      if (job.uploadedBytes === job.bytes && job.state !== 'deleting') {
        res.json(publicJob(job));
        return;
      }
      throw new Problem('This upload is no longer active.');
    }
    const number = Number(req.get('X-Part-Number'));
    if (
      !Number.isInteger(number) ||
      number < 1 ||
      number > Math.ceil(job.bytes / chunkBytes) ||
      !Buffer.isBuffer(req.body)
    )
      throw new Problem('Invalid video upload chunk.', 400);
    const bytes = req.body.length;
    const expectedBytes = Math.min(chunkBytes, job.bytes - (number - 1) * chunkBytes);
    if (bytes !== expectedBytes) throw new Problem('The video chunk has an unexpected size.', 400);
    const hash = createHash('sha256').update(req.body).digest('hex');
    const previous = job.parts.find((part) => part.number === number);
    if (previous) {
      if (previous.hash !== hash)
        throw new Problem('Choose the original file to resume this upload.');
      res.json(publicJob(job));
      return;
    }
    if (number !== job.parts.length + 1)
      throw new Problem('Resume the upload from its last saved chunk.');
    const uploaded = await storage().send(
      new UploadPartCommand({
        Bucket: bucket(),
        Key: job.key,
        UploadId: job.uploadId,
        PartNumber: number,
        Body: req.body,
      }),
      within(undefined, 5 * minute),
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
        throw new Problem('The upload is incomplete. Choose the same file to resume.');
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
          within(),
        );
      const stored = await storage().send(
        new HeadObjectCommand({ Bucket: bucket(), Key: job.key }),
        within(),
      );
      if (stored.ContentLength !== job.bytes)
        throw new Problem('The upload is incomplete. Choose the file again to retry.');
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
  route('post', '/jobs/:id/recheck', async (req, res) => {
    const job = await owned(req);
    if (job.state !== 'failed' || job.settings || job.checkFailure !== 'transient')
      throw new Problem('Only a video whose check was interrupted can be checked again.');
    const source = job.sourceKey || job.key;
    const imported = !!job.youtube && !(await exists(job.key));
    if (!imported && !(await exists(source)))
      throw new Problem('The stored video is gone. Add it again to describe it.');
    await Jobs.updateOne(
      { _id: job._id, state: 'failed' },
      {
        $set: {
          state: imported ? 'importing' : 'checking',
          active: true,
          cancelRequested: false,
          error: '',
          checkRetries: 0,
          stage: imported
            ? 'Waiting to import the YouTube video'
            : 'Waiting to check the video again',
          expiresAt: retain(job, 1),
        },
        $unset: { checkFailure: 1, cancelAt: 1 },
      },
    );
    res.json(publicJob(await owned(req)));
    void tick();
  });
  route('post', '/jobs/:id/estimate', async (req, res) => {
    const input = z
      .object({
        action: z.enum(['start', 'preview', 'reanalyze', 'revoice', 'resume', 'finish', 'redo']),
        settings: z.unknown().optional(),
        sections: z.unknown().optional(),
        edits: z.unknown().optional(),
        note: z.unknown().optional(),
      })
      .parse(req.body ?? {});
    const job = await owned(req);
    const settings = (input.settings ?? {}) as object;
    const body = {
      ...(['start', 'preview', 'reanalyze'].includes(input.action)
        ? { voice: job.settings?.voice || 'estimate' }
        : {}),
      ...settings,
      expectedVersion: job.version || 1,
      edits: input.edits,
      sections: input.sections,
      note: input.note,
    };
    const remainingUSD = await remaining();
    const limits = { remainingUSD, dailyUSD: dailyLimit(), limitUSD: jobLimit() };
    try {
      const launch = await launchFor(job, input.action, body, false);
      const { estimateUSD, setAsideUSD, breakdown, seconds } = launch.price;
      const approvedUSD =
        input.action === 'resume' && job.state === 'failed' && job.overQuote
          ? askWithin(estimateUSD, job.overQuote, remainingUSD)
          : approvalFor(estimateUSD);
      const reason =
        estimateUSD > jobLimit()
          ? `This is estimated at ${money(estimateUSD)}, above the ${money(jobLimit())} limit for one run.`
          : setAsideUSD > remainingUSD
            ? await allowanceText(setAsideUSD)
            : undefined;
      res.json({
        estimateUSD,
        setAsideUSD,
        approvedUSD,
        ...limits,
        allowed: !reason,
        reason,
        seconds,
        breakdown,
      });
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      res.json({
        estimateUSD: 0,
        setAsideUSD: 0,
        approvedUSD: 0,
        ...limits,
        allowed: false,
        reason: error.message,
        field: error.field,
        seconds: 0,
        breakdown: { vision: 0, speech: 0, dialogue: 0, closeLook: 0, firstLook: 0 },
      });
    }
  });
  route('post', '/jobs/:id/start', async (req, res) => {
    whenConfigured();
    const job = await owned(req);
    if ([...busy, 'done'].includes(job.state)) {
      res.json(await single(job));
      return;
    }
    const preview = z.object({ preview: z.boolean().optional() }).parse(req.body ?? {}).preview;
    const launch = await launchFor(job, preview ? 'preview' : 'start', req.body, true);
    await requireVoice(launch.settings.voice);
    res.status(202).json(await single(await enqueue(req, job, launch)));
  });
  route('post', '/jobs/:id/finish', async (req, res) => {
    whenConfigured();
    const job = await owned(req);
    if (busy.includes(job.state)) {
      res.json(await single(job));
      return;
    }
    const launch = launchFinish(job);
    await requireVoice(launch.settings.voice);
    res.status(202).json(await single(await enqueue(req, job, launch)));
  });
  route('post', '/jobs/:id/resume', async (req, res) => {
    whenConfigured();
    const job = await owned(req);
    if (busy.includes(job.state)) {
      res.json(await single(job));
      return;
    }
    const launch = launchResume(job, req.body);
    const allow = z
      .object({ allowUpToUSD: z.number().finite().positive().optional() })
      .parse(req.body ?? {}).allowUpToUSD;
    if (allow !== undefined) {
      if (allow > jobLimit() + 1e-9)
        throw new Problem(
          `You can allow up to ${money(jobLimit())} for one run.`,
          400,
          'allowUpToUSD',
        );
      const left = await remaining();
      launch.approvedUSD = Math.max(
        approvalFor(launch.price.estimateUSD),
        Math.min(toCents(allow) / 100, left),
      );
    }
    await requireVoice(launch.settings.voice);
    res.status(202).json(await single(await enqueue(req, job, launch)));
  });
  route('post', '/jobs/:id/rehearse', async (req, res) => {
    whenConfigured();
    if (hooks.actor(req).role !== 'ADMIN')
      throw new Problem('Rehearsals are only for the site administrator.', 403);
    const job = await owned(req);
    if (busy.includes(job.state)) {
      res.json(await single(job));
      return;
    }
    res.status(202).json(await single(await enqueue(req, job, launchRehearsal(job, req.body))));
  });
  route('post', '/jobs/:id/keep', async (req, res) => {
    const job = await owned(req);
    if (!terminal.includes(job.state) || !latestCopy(job))
      throw new Problem('Only a finished described copy can be kept longer.');
    const longest = Date.now() + keepMaxDays * day;
    if (!keepable(job))
      throw new Problem(
        `It is already kept until ${dateText(job.expiresAt)}, the longest a copy is kept. Download it or save it to your Library to keep it for good.`,
      );
    const expiresAt = new Date(
      Math.min(new Date(job.expiresAt).getTime() + keepDays * day, longest),
    );
    const kept = await Jobs.findOneAndUpdate(
      { _id: job._id, state: job.state, expiresAt: job.expiresAt },
      { $set: { expiresAt }, $unset: { expiryWarned: 1 } },
      { new: true },
    ).lean();
    if (!kept) throw new Problem('This video changed in another tab. Reopen it and try again.');
    hooks.log(line('dv.keep', { id: job._id, until: expiresAt.toISOString() }));
    res.json(await single(kept));
  });
  route('post', '/jobs/:id/abandon', async (req, res) => {
    const job = await owned(req);
    if (!['failed', 'cancelled'].includes(job.state))
      throw new Problem('Only a stopped attempt can be set aside.');
    const copy = latestCopy(job);
    if (!copy) throw new Problem('There is no finished version to go back to.');
    const { set, unset } = split({
      state: 'done',
      active: false,
      version: copy.version,
      lastVersion: Math.max(job.lastVersion ?? 0, job.version ?? 1),
      settings: copy.settings ?? job.settings,
      revoice: false,
      reuseUnchanged: false,
      edits: [],
      redo: [],
      sectionNotes: {},
      manifest: copy.sections ?? [],
      retry: [],
      spans: copy.spans,
      planKey: planKey(copy.range),
      firstLookVersion: copy.firstLook ?? job.firstLookVersion,
      kind: copy.kind ?? job.kind,
      count: copy.count,
      skipped: copy.skipped,
      failedSections: copy.failedSections,
      outputSeconds: copy.outputSeconds,
      finishedAt: copy.finishedAt,
      savedToLibrary: copy.savedToLibrary ?? '',
      stage: 'Your described copy is ready',
      progress: 100,
      error: '',
      preview: !!copy.preview,
      stopAfter: copy.preview ? previewSeconds() : undefined,
      crashes: 0,
      crashAt: undefined,
      runKind: undefined,
      base: undefined,
      carry: undefined,
      cancelRequested: false,
      cancelAt: undefined,
      expiresAt: retain(job, 3),
    });
    const restored = await Jobs.findOneAndUpdate(
      { _id: job._id, state: job.state },
      { $set: set, $unset: unset },
      { new: true },
    ).lean();
    if (!restored) throw new Problem('This video changed in another tab. Reopen it and try again.');
    const abandoned = job.version || 1;
    if (abandoned !== copy.version)
      await Promise.all([
        erasePrefix(`${folder(job)}/sections/v${abandoned}/`),
        erasePrefix(`${folder(job)}/looks/v${abandoned}/`),
      ]).catch((error: Error) => hooks.log('description abandon cleanup: ' + error.message));
    res.json(publicJob(restored));
  });
  route('get', '/jobs/:id/script', async (req, res) => {
    const job = await owned(req);
    const copy = selectCopy(
      job,
      typeof req.query.version === 'string' ? req.query.version : undefined,
    );
    const records = await baseRecords(job, copy);
    res.json({ version: copy.version, cues: scriptCues([...records.values()]) });
  });
  route('post', '/jobs/:id/reanalyze', async (req, res) => {
    whenConfigured();
    const job = await owned(req);
    const launch = launchReanalyze(job, req.body);
    await requireVoice(launch.settings.voice);
    res.status(202).json(await single(await enqueue(req, job, launch)));
  });
  route('post', '/jobs/:id/revoice', async (req, res) => {
    whenConfigured();
    const job = await owned(req);
    if (busy.includes(job.state)) {
      if (req.body?.expectedVersion !== undefined)
        throw new Problem(
          'A new version is already running. Your draft has been kept; reopen the script when it finishes.',
        );
      res.json(await single(job));
      return;
    }
    const launch = await launchRevoice(job, req.body, true);
    await requireVoice(launch.settings.voice);
    res.status(202).json(await single(await enqueue(req, job, launch)));
  });
  route('post', '/jobs/:id/redo', async (req, res) => {
    whenConfigured();
    const job = await owned(req);
    const launch = launchRedo(job, req.body);
    await requireVoice(launch.settings.voice);
    res.status(202).json(await single(await enqueue(req, job, launch)));
  });
  route('post', '/jobs/:id/rename', async (req, res) => {
    const job = await owned(req);
    const name = z
      .string()
      .max(400)
      .transform((value) => clip(cleanLabel(value), 200))
      .pipe(z.string().min(1))
      .parse(req.body?.name);
    await Jobs.updateOne({ _id: job._id }, { $set: { name } });
    res.json(await single(await owned(req)));
  });
  route('post', '/jobs/:id/cancel', async (req, res) => {
    const job = await owned(req);
    if (terminal.includes(job.state) || job.state === 'deleting') {
      res.json(publicJob(job));
      return;
    }
    const now = new Date();
    const back = rehearsing(job) ? rehearsalStop(job, 'cancelled') : undefined;
    const idle = await Jobs.findOneAndUpdate(
      {
        _id: job._id,
        state: { $in: ['uploading', 'ready', 'queued', 'running', ...checking] },
        $or: [{ worker: { $exists: false } }, { lease: { $lt: now } }],
      },
      back
        ? { $set: back.set, $unset: back.unset }
        : {
            $set: {
              state: 'cancelled',
              active: false,
              cancelRequested: true,
              stage: 'Cancelled',
              expiresAt: retain(job, 3),
              ...(job.state === 'running'
                ? {
                    error:
                      'Processing stopped. Work already sent to providers may still be charged.',
                  }
                : {}),
            },
            $unset: { worker: 1, lease: 1 },
          },
      { new: true },
    ).lean();
    if (idle) {
      await release(idle.reservation, idle.runCost ?? 0);
      await abortUpload(idle);
      if (back) await eraseRehearsal(idle);
    } else {
      await Jobs.updateOne(
        { _id: job._id, state: { $in: [...busy, ...checking] } },
        { $set: { cancelRequested: true, cancelAt: job.cancelAt ?? now } },
      );
      controllers.get(job._id)?.abort(new Cancelled('Cancelled.'));
    }
    res.json(await single(await owned(req)));
  });
  route('delete', '/jobs/:id', async (req, res) => {
    const job = await owned(req);
    const deleting = await Jobs.findOneAndUpdate(
      {
        _id: job._id,
        state: { $in: [...terminal, 'ready', 'uploading', 'deleting'] },
        $or: [
          { librarySaving: { $exists: false } },
          { librarySaving: { $lt: new Date(Date.now() - 10 * minute) } },
        ],
      },
      { $set: { state: 'deleting', active: false, expiresAt: new Date(Date.now() + hour) } },
      { new: true },
    ).lean();
    if (!deleting)
      throw new Problem(
        'Wait for any Library save, or cancel processing and wait for it to stop, before deleting.',
      );
    try {
      await abortUpload(job);
      await eraseAll(job);
    } catch (error) {
      warn(line('dv.delete', { id: job._id, error: scrub((error as Error).message || 'failed') }));
      throw new Problem(
        'Some of its files could not be removed yet. Press Delete again to finish.',
        503,
      );
    }
    await Jobs.deleteOne({ _id: job._id, owner: job.owner, state: 'deleting' });
    res.json({ ok: true });
  });
  /** A download name that cannot break the header: ASCII fallback plus RFC 5987 UTF-8. */
  const disposition = (name: string) => {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const utf8 = encodeURIComponent(name.replace(/[\uD800-\uDFFF]/g, '')).replace(
      /['()*]/g,
      (letter) => '%' + letter.charCodeAt(0).toString(16).toUpperCase(),
    );
    return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
  };
  const outputs = [
    { kind: 'video', file: 'described.mp4', mime: 'video/mp4', label: 'described', ext: 'mp4' },
    {
      kind: 'audio',
      file: 'described.m4a',
      mime: 'audio/mp4',
      label: 'described audio',
      ext: 'm4a',
    },
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
  const copyFolder = (job: Job, copy: FinishedCopy): string =>
    copy.legacy ? folder(job) : `${folder(job)}/copies/${copy.version}`;
  route('get', '/jobs/:id/files', async (req, res) => {
    const job = await owned(req);
    const copy = selectCopy(
      job,
      typeof req.query.version === 'string' ? req.query.version : undefined,
    );
    const base = copyName(job, copy.range);
    const expiresIn = 6 * 3600;
    const result: Record<string, string> = {};
    for (const item of outputs) {
      const key = `${copyFolder(job, copy)}/${item.file}`;
      if (!['video', 'audio', 'script'].includes(item.kind) && !(await exists(key))) continue;
      const command = { Bucket: bucket(), Key: key, ResponseContentType: item.mime };
      result[item.kind] = await getSignedUrl(storage(), new GetObjectCommand(command), {
        expiresIn,
      });
      result[item.kind + 'Download'] = await getSignedUrl(
        storage(),
        new GetObjectCommand({
          ...command,
          ResponseContentDisposition: disposition(`${base} (${item.label}).${item.ext}`),
        }),
        { expiresIn },
      );
    }
    res.json({ ...result, expiresAt: new Date(Date.now() + expiresIn * 1000) });
  });
  route('get', '/jobs/:id/text/:kind', async (req, res) => {
    const job = await owned(req);
    const item = outputs.find(
      (entry) => entry.kind === req.params.kind && entry.ext !== 'mp4' && entry.ext !== 'm4a',
    );
    if (!item) throw new Problem('That text is not available.', 404);
    const copy = selectCopy(
      job,
      typeof req.query.version === 'string' ? req.query.version : undefined,
    );
    const text = await readText(`${copyFolder(job, copy)}/${item.file}`);
    if (text === null) throw new Problem('That text is not available for this copy.', 404);
    res.type(item.mime).send(text);
  });
  route('post', '/jobs/:id/library', async (req, res) => {
    const job = await owned(req);
    if (!hooks.library) throw new Problem('The library is not available here.', 503);
    if (job.state === 'deleting') throw new Problem('This video is being deleted.');
    const input = z
      .object({
        share: z.boolean().optional(),
        path: z.unknown().optional(),
        version: z.union([z.number(), z.string()]).optional(),
      })
      .parse(req.body ?? {});
    const copy = selectCopy(job, input.version === undefined ? undefined : String(input.version));
    if (copy.rehearsal)
      throw new Problem('A rehearsal copy is a test tone, so it is not saved to the Library.');
    if (copy.savedToLibrary) {
      res.json({ ...publicJob(job), savedToLibrary: copy.savedToLibrary, path: '' });
      return;
    }
    const privacy = job.source === 'library' ? job.sourcePrivacy : undefined;
    const restricted = !!privacy && (!privacy.shared || !privacy.ownerIsActor);
    const share = hooks.actor(req).role === 'ADMIN' ? (input.share ?? !restricted) : false;
    const typed = libraryPathSchema.safeParse(
      input.path ??
        (job.source === 'library' ? describedShelf(job.sourcePath) : defaultLibraryPath),
    );
    if (!typed.success)
      throw new Problem(typed.error.issues[0]?.message ?? fieldHelp.path, 400, 'path');
    const path = matchFolder(
      typed.data,
      (await hooks.library.folders?.(req).catch(() => [])) ?? [],
    );
    const source = `${copyFolder(job, copy)}/described.m4a`;
    const savingAt = new Date();
    const pending =
      (job.copies?.length ? copy.libraryPending : job.libraryPending) ||
      new mongoose.Types.ObjectId().toString();
    const held = await Jobs.updateOne(
      {
        _id: job._id,
        state: { $ne: 'deleting' },
        ...(job.copies?.length ? { 'copies.version': copy.version } : {}),
        $or: [
          { librarySaving: { $exists: false } },
          { librarySaving: { $lt: new Date(Date.now() - 10 * minute) } },
        ],
      },
      {
        $set: {
          librarySaving: savingAt,
          ...(job.copies?.length
            ? { 'copies.$.libraryPending': pending }
            : { libraryPending: pending }),
        },
      },
    );
    if (!held.modifiedCount)
      throw new Problem('A Library save is already in progress. Wait a moment, then refresh.');
    try {
      const fresh = selectCopy(await owned(req), String(copy.version));
      if (fresh.savedToLibrary) {
        res.json({ ...publicJob(job), savedToLibrary: fresh.savedToLibrary, path: '' });
        return;
      }
      const head = await storage().send(
        new HeadObjectCommand({ Bucket: bucket(), Key: source }),
        within(),
      );
      const base = copyName(job, copy.range);
      const first = Math.min(...realCopies(job).map((item) => item.version));
      const saved = await hooks.library.save({
        id: pending,
        owner: job.owner,
        title:
          copy.version > first
            ? `${base} (described, version ${copy.version})`
            : `${base} (described)`,
        seconds: copy.outputSeconds || job.seconds || 0,
        bytes: head.ContentLength || 0,
        share,
        grownUpsOnly: privacy?.grownUpsOnly === true,
        path,
        kind: copy.kind || job.kind || '',
        transcript: (await readText(`${copyFolder(job, copy)}/transcript.txt`)) ?? undefined,
        sourceBook: job.library?.book,
        sourceTrack: job.library?.track,
        description: job.about ? clip(job.about, 1900) : undefined,
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
              within(undefined, 10 * minute),
            )
            .then(() => true)
            .catch((error: Error) => {
              hooks.log('description library copy: ' + error.message);
              return false;
            });
          if (copied) return;
          const output = await storage().send(
            new GetObjectCommand({ Bucket: bucket(), Key: source }),
            within(),
          );
          if (!(output.Body instanceof Readable))
            throw new Error('The described audio could not be read.');
          await upload(target, output.Body, 'audio/mp4');
        },
      });
      if (job.copies?.length)
        await Jobs.updateOne(
          { _id: job._id, 'copies.version': copy.version },
          {
            $set: { 'copies.$.savedToLibrary': saved.id },
            $unset: { 'copies.$.libraryPending': 1 },
          },
        );
      if (copy.version === (job.version || 1))
        await Jobs.updateOne(
          { _id: job._id },
          { $set: { savedToLibrary: saved.id }, $unset: { libraryPending: 1 } },
        );
      hooks.log(
        line('dv.library', { id: job._id, version: copy.version, book: saved.id, shared: share }),
      );
      res.json({ ...publicJob(await owned(req)), savedToLibrary: saved.id, path: saved.path });
    } finally {
      await Jobs.updateOne(
        { _id: job._id, librarySaving: savingAt },
        { $unset: { librarySaving: 1 } },
      );
    }
  });
  route('post', '/sample', async (req, res) => {
    whenConfigured();
    const owner = hooks.actor(req).id;
    const input = z
      .object({
        voice: z.string().min(1).max(120),
        rate: z.number().min(1).max(3),
        text: z.string().max(400).optional(),
      })
      .parse(req.body);
    await requireVoice(input.voice);
    const text = input.text === undefined ? sampleText : clip(cleanSpoken(input.text), 200);
    if (!text) throw new Problem('Type a word or name to try.', 400, 'text');
    const rate = Math.round(input.rate * 20) / 20;
    const cacheKey = `${input.voice}|${rate}|${text}`;
    let audio = samples.get(cacheKey);
    if (!audio) {
      const recent = (sampleUse.get(owner) || []).filter((at) => Date.now() - at < hour);
      if (recent.length >= 40)
        throw new Problem('That is a lot of samples for one hour. Try again a little later.');
      const reservation: Run = {
        runId: randomUUID(),
        day: today(),
        cents: Math.max(1, toCents(Buffer.byteLength(text, 'utf8') * speechPerByte * 2)),
      };
      if (!(await takeFromDay(reservation)))
        throw new Problem(
          `Today's processing allowance is used up, so voice samples are paused until it starts fresh at ${resetText()}.`,
        );
      sampleUse.set(owner, [...recent, Date.now()]);
      let spent = 0;
      const directory = await mkdtemp(join(tmpdir(), 'kade-voice-sample-'));
      try {
        const signal = AbortSignal.timeout(90 * second);
        const native = Math.min(1.5, rate);
        const file = join(directory, 'sample.wav');
        await (hooks.providers?.synthesize ?? synthesize)(
          text,
          input.voice,
          `sample:${owner}`,
          file,
          native,
          signal,
          async (kind, _reserve, action) => {
            const result = await action();
            spent += result.costUSD;
            await hooks.usage(owner, 'voice-sample', kind, result.costUSD).catch(() => {});
          },
        );
        audio = wav(await stretch(await decodeVoice(file, signal), rate / native, signal));
      } finally {
        await release(reservation, spent).catch((error: Error) =>
          hooks.log('description sample release: ' + error.message),
        );
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
      samples.set(cacheKey, audio);
      let cached = [...samples.values()].reduce((sum, item) => sum + item.length, 0);
      for (const key of samples.keys()) {
        if (cached <= 16 * 1024 ** 2) break;
        cached -= samples.get(key)?.length ?? 0;
        samples.delete(key);
      }
    }
    res.type('audio/wav').send(audio);
  });

  /** Body-parser refusals (an oversized chunk, unreadable JSON) answer in words, not an HTML page. */
  const bodyProblem: ErrorRequestHandler = (
    error: { status?: number; type?: string },
    _req,
    res,
    next,
  ) => {
    if (res.headersSent) return next(error);
    const status = error.status === 413 ? 413 : 400;
    res.status(status).json({
      error:
        status === 413
          ? 'That piece of the upload was too large. Reload the page and choose the file again.'
          : 'The request could not be read. Reload the page and try again.',
    });
  };
  router.use(bodyProblem);

  /* ---------- per-version section storage ---------- */
  const sectionKey = (job: Job, version: number, index: number, ext: string) =>
    version === 0
      ? `${folder(job)}/sections/${index}.${ext}`
      : `${folder(job)}/sections/v${version}/${index}.${ext}`;
  async function readSection(job: Job, version: number, index: number, signal?: AbortSignal) {
    const stored = await readJson<{ version?: number; record: SectionRecord }>(
      sectionKey(job, version, index, 'json'),
      signal,
    );
    return stored?.record;
  }
  const retryable = (record: SectionRecord) =>
    !record.analysis && !!record.failure && (record.failureClass ?? 'transient') === 'transient';

  type KeeperState = {
    keeper: RunKeeper;
    manifest: Manifest;
    failures: Map<number, string | undefined>;
    spans: () => number[] | undefined;
  };
  /** The engine's view of what is already done and what it may reuse, for this run's version. */
  async function keeperFor(job: Job, signal: AbortSignal): Promise<KeeperState> {
    const prefix = folder(job);
    const version = job.version || 1;
    const range = job.settings?.range;
    const rehearsal = job.runKind === 'rehearsal';
    const stored = await readJson<{ plan: Plan; words: Word[] }>(
      `${prefix}/${planKey(range, rehearsal)}.json`,
      signal,
    );
    const firstLookKey = `${prefix}/first-look-${job.firstLookVersion || 1}.json`;
    const firstLook = await readJson<{ through: number; state: Continuity }>(firstLookKey, signal);
    const count = stored?.plan.sections.length ?? 0;
    const manifest: Manifest = (job.manifest ?? []).slice(0, count);
    const failures = new Map<number, string | undefined>();
    const records: SectionRecord[] = [];
    for (const [index, from] of manifest.entries()) {
      if (from === null || from === undefined) continue;
      const record = await readSection(job, from, index, signal);
      if (!record) {
        manifest[index] = null;
        continue;
      }
      records.push(record);
      failures.set(index, record.failure);
    }
    const kind = job.runKind ?? (job.revoice ? 'revoice' : 'fresh');
    const redo = new Set(job.redo ?? []);
    const edits = job.edits ?? [];
    const reusing = !describing.includes(kind) || !!job.carry;
    const analyses: (Analysis | null)[] = [];
    const looks: (SavedLook | undefined)[] = [];
    if (reusing && count) {
      const carry = new Map<number, SectionRecord>();
      for (const [index, from] of (job.carry ?? []).entries()) {
        if (from === null || from === undefined || manifest[index] != null) continue;
        const record = await readSection(job, from, index, signal);
        if (record) carry.set(index, record);
      }
      const baseCopy =
        job.base === undefined
          ? undefined
          : copiesFor(job).find((copy) => copy.version === job.base);
      const base = baseCopy
        ? await baseRecords(job, baseCopy, signal)
        : new Map<number, SectionRecord>();
      for (let i = 0; i < count; i++) {
        if (manifest[i] !== null && manifest[i] !== undefined) continue;
        const fromCarry = carry.get(i);
        const source = fromCarry ?? (redo.has(i) ? undefined : base.get(i));
        if (!source) continue;
        if (source.analysis) {
          analyses[i] = fromCarry ? source.analysis : revise(source.analysis, i, edits);
          continue;
        }
        if (source.failure && !(fromCarry && retryable(fromCarry)))
          looks[i] = { analysis: null, failure: source.failure, failureClass: source.failureClass };
      }
    }
    for (const key of await listKeys(`${prefix}/looks/v${version}/`, signal)) {
      const index = Number(
        key
          .split('/')
          .pop()
          ?.replace(/\.json$/, ''),
      );
      if (
        !Number.isInteger(index) ||
        index >= count ||
        (manifest[index] !== null && manifest[index] !== undefined)
      )
        continue;
      const look = await readJson<SavedLook>(key, signal);
      if (look) looks[index] = look;
    }
    let spans = job.spans;
    const record = (update: mongoose.UpdateQuery<Job>) =>
      Jobs.updateOne({ _id: job._id, worker }, update);
    const keeper: RunKeeper = {
      saved: {
        firstLook,
        plan: stored?.plan,
        words: stored?.words,
        records,
        analyses: reusing ? analyses : undefined,
        looks,
      },
      keepFirstLook: async (look) => {
        await putText(firstLookKey, JSON.stringify(look), signal);
        await record({ $set: { firstLookThrough: look.through } });
      },
      keepPlan: async (plan, words) => {
        const key = planKey(plan.range ?? range, rehearsal);
        await putText(`${prefix}/${key}.json`, JSON.stringify({ plan, words }), signal);
        spans = [
          ...plan.sections.map((section) => section.start),
          plan.sections.at(-1)?.end ?? plan.seconds,
        ];
        await record({
          $set: { sections: plan.sections.length, spans, planKey: key },
          $addToSet: { plans: key },
        });
        hooks.log(
          line('dv.plan', {
            id: job._id,
            sections: plan.sections.length,
            words: words.length,
            seconds: Math.round(plan.seconds),
            language: plan.language,
          }),
        );
      },
      keepLook: async (index, look) => {
        await putText(
          `${prefix}/looks/v${version}/${index}.json`,
          JSON.stringify(look),
          signal,
        ).catch((error: Error) =>
          warn(line('dv.look', { id: job._id, index, error: scrub(error.message) })),
        );
      },
      keepSection: async (section, files) => {
        const started = Date.now();
        let bytes = await putFile(
          sectionKey(job, version, section.index, 'flac'),
          files.sound,
          'audio/flac',
          signal,
        );
        if (files.picture)
          bytes += await putFile(
            sectionKey(job, version, section.index, 'mp4'),
            files.picture,
            'video/mp4',
            signal,
          );
        await putText(
          sectionKey(job, version, section.index, 'json'),
          JSON.stringify({ version, record: section }),
          signal,
        );
        manifest[section.index] = version;
        failures.set(section.index, section.failure);
        await record({
          $set: { manifest, done: doneCount(manifest) },
          ...(retryable(section)
            ? { $addToSet: { retry: section.index } }
            : { $pull: { retry: section.index } }),
        });
        (section.failure ? warn : hooks.log)(
          line('dv.section', {
            id: job._id,
            index: section.index,
            cues: section.analysis?.cues.length ?? 0,
            placed: section.placements.length,
            skipped: section.skipped.length,
            failure: section.failure ? scrub(section.failure) : undefined,
            failureClass: section.failureClass,
            uploadMs: Date.now() - started,
            bytes,
          }),
        );
      },
      restore: async (index, directory) => {
        const from = manifest[index] ?? version;
        const sound = join(directory, 'sound.flac');
        await download(sectionKey(job, from, index, 'flac'), sound, signal);
        const pictureKey = sectionKey(job, from, index, 'mp4');
        if (!(await exists(pictureKey, signal))) return { sound };
        const picture = join(directory, `part-${index}.mp4`);
        await download(pictureKey, picture, signal);
        return { sound, picture };
      },
    };
    return { keeper, manifest, failures, spans: () => spans };
  }

  /* ---------- running a job ---------- */
  /** A stopped job whose work never wound down: settle it, so its money and its lane are freed. */
  async function unwedge(job: Job, reason: unknown): Promise<void> {
    warn(
      line('dv.wedged', {
        id: job._id,
        reason: reason instanceof Error ? reason.constructor.name : 'unknown',
      }),
    );
    const current = await Jobs.findOne({ _id: job._id, worker })
      .lean()
      .catch(() => null);
    if (!current) return;
    const cancelled = !!current.cancelRequested;
    const back = rehearsing(current)
      ? cancelled
        ? rehearsalStop(current, 'cancelled')
        : rehearsalStop(current, 'stopped', 'The rehearsal stopped and did not wind down.')
      : undefined;
    const settled = await Jobs.findOneAndUpdate(
      { _id: job._id, worker },
      back
        ? { $set: back.set, $unset: back.unset }
        : {
            $set: {
              state: cancelled ? 'cancelled' : 'failed',
              active: false,
              stage: cancelled ? 'Cancelled' : 'Stopped before finishing',
              error: cancelled
                ? 'Processing stopped. Work already sent to providers may still be charged.'
                : 'Processing stopped and did not wind down. Press Continue to try again.',
              finishedAt: new Date(),
              expiresAt: retain(current, 3),
              ...(checking.includes(current.state) ? { checkFailure: 'transient' } : {}),
            },
            $unset: { worker: 1, lease: 1 },
          },
      { new: true },
    )
      .lean()
      .catch(() => null);
    if (!settled) return;
    await release(settled.reservation, settled.runCost ?? 0).catch(() => {});
    if (back) await eraseRehearsal(settled);
  }
  /**
   * Runs one job with a lease, a heartbeat that survives a slow database for a minute,
   * cancellation and a clean temporary folder. `settle` gives back money before any notice.
   */
  async function lease(
    job: Job,
    lane: 'check' | 'render',
    task: (
      directory: string,
      signal: AbortSignal,
      progress: (stage: string, value: number) => Promise<void>,
    ) => Promise<void>,
    settle: () => Promise<void> = async () => {},
  ): Promise<'done' | 'requeued' | 'stopped'> {
    const lock = lanes[lane].lock;
    const controller = new AbortController();
    controllers.set(job._id, controller);
    let loose = () => {};
    const wedge = new Promise<void>((resolve) => (loose = resolve));
    wedges.set(job._id, wedge);
    /**
     * Set once the work has wound down. A heartbeat still in flight at that moment must not stop
     * or settle anything: the same worker may already be running the job's next attempt.
     */
    let finished = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: Error) => {
      if (!finished) controller.abort(reason);
    };
    controller.signal.addEventListener(
      'abort',
      () => {
        if (finished) return;
        watchdog = setTimeout(
          () => void unwedge(job, controller.signal.reason).finally(loose),
          wedgeMs,
        );
        watchdog.unref();
      },
      { once: true },
    );
    const deadline = setTimeout(
      () => stop(new Halt('The job exceeded its processing time limit.')),
      lane === 'render' ? 8 * hour : 2 * hour,
    );
    deadline.unref();
    let renewed = Date.now();
    let beating = false;
    const beat = async () => {
      try {
        const current = await Jobs.findById(job._id, { cancelRequested: 1, worker: 1 }).lean();
        if (finished) return;
        if (!current || current.cancelRequested) return stop(new Cancelled('Cancelled.'));
        if (!configured())
          return stop(
            new Halt(
              'Video description was switched off, so processing stopped. Finished sections are kept.',
            ),
          );
        if (current.worker !== worker)
          return stop(new LeaseLost('Another server took over this job.'));
        const until = new Date(Date.now() + 90 * second);
        const held = await Locks.updateOne({ _id: lock, worker }, { $set: { until } });
        if (!held.matchedCount) return stop(new LeaseLost('Another server took over the queue.'));
        await Jobs.updateOne({ _id: job._id, worker }, { $set: { lease: until } });
        renewed = Date.now();
      } catch (error) {
        warn(
          line('dv.heartbeat', { id: job._id, error: scrub((error as Error).message || 'failed') }),
        );
        if (Date.now() - renewed > minute)
          stop(new LeaseLost('The job database stopped answering.'));
      }
    };
    let beatInFlight: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (beating || controller.signal.aborted) return;
      beating = true;
      beatInFlight = beat().finally(() => {
        beating = false;
      });
    }, heartbeatMs);
    heartbeat.unref();
    let directory = '';
    let settled = false;
    const settleOnce = async () => {
      if (settled) return;
      settled = true;
      await settle().catch((error: Error) =>
        warn(line('dv.release', { id: job._id, error: scrub(error.message) })),
      );
    };
    try {
      directory = await mkdtemp(join(tmpdir(), 'kade-described-video-'));
      const progress = async (stage: string, value: number) => {
        controller.signal.throwIfAborted();
        const updated = await Jobs.updateOne(
          { _id: job._id, worker, cancelRequested: false },
          { $set: { stage, progress: Math.round(value) } },
        );
        if (!updated.matchedCount) {
          controller.abort(new Cancelled('Cancelled.'));
          controller.signal.throwIfAborted();
        }
      };
      await task(directory, controller.signal, progress);
      return 'done';
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : undefined;
      const current = await Jobs.findById(job._id)
        .lean()
        .catch(() => null);
      const cancelled = !!current?.cancelRequested || reason instanceof Cancelled;
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : 'failed';
      const passing =
        reason instanceof LeaseLost || infrastructure(error, controller.signal.aborted);
      const requeue = async (
        why: string,
        stage: string,
        counter: 'restarts' | 'retries' | 'checkRetries',
      ) => {
        await Jobs.updateOne(
          { _id: job._id, worker },
          {
            $set: { state: lane === 'render' ? 'queued' : job.state, stage, priority: 0 },
            $inc: { [counter]: 1 },
            $unset: { worker: 1, lease: 1 },
          },
        );
        hooks.log(line('dv.requeue', { id: job._id, lane, why, detail: scrub(detail) }));
        return 'requeued' as const;
      };
      if (!cancelled && reason instanceof Shutdown)
        return requeue('shutdown', 'Continuing after a server restart', 'restarts');
      const retries = lane === 'render' ? (current?.retries ?? 0) : (current?.checkRetries ?? 0);
      if (!cancelled && passing && retries < (lane === 'render' ? 3 : 1))
        return requeue(
          'connection',
          'Continuing after a connection problem',
          lane === 'render' ? 'retries' : 'checkRetries',
        );
      const over = !cancelled && error instanceof OverQuote ? error : undefined;
      const rehearsal = lane === 'render' && job.runKind === 'rehearsal';
      const ask = over ? await askAfterHalt(current ?? job, over) : 0;
      const message = cancelled
        ? 'Processing stopped. Work already sent to providers may still be charged.'
        : over
          ? `${over.message} Continue up to ${money(ask)} more? Finished sections are kept.`
          : plainProblem(error, reason);
      warn(
        line('dv.fail', { id: job._id, lane, cancelled, message, detail: detail.slice(0, 800) }),
      );
      if (over)
        hooks.log(
          line('dv.halt', {
            id: job._id,
            reason: 'over-quote',
            spentUSD: Math.round(over.spentUSD * 10000) / 10000,
            quotedUSD: over.quotedUSD,
            approvedUSD: job.approvedUSD,
            askUSD: ask,
          }),
        );
      const back = rehearsal
        ? cancelled
          ? rehearsalStop(current ?? job, 'cancelled')
          : rehearsalStop(current ?? job, 'stopped', `The rehearsal stopped: ${message}`)
        : undefined;
      const ended = await Jobs.updateOne(
        { _id: job._id, worker },
        back
          ? { $set: back.set, $unset: back.unset }
          : {
              $set: {
                state: cancelled ? 'cancelled' : 'failed',
                active: false,
                stage: cancelled ? 'Cancelled' : 'Stopped before finishing',
                error: message,
                finishedAt: new Date(),
                expiresAt: retain(job, 3),
                ...(lane === 'check' && !cancelled
                  ? { checkFailure: passing ? 'transient' : 'permanent' }
                  : {}),
                ...(over
                  ? { overQuote: { spentUSD: over.spentUSD, quotedUSD: over.quotedUSD } }
                  : {}),
              },
              $unset: { worker: 1, lease: 1 },
            },
      ).catch((failure: Error) => {
        warn(line('dv.fail', { id: job._id, error: scrub(failure.message) }));
        return null;
      });
      await settleOnce();
      if (back && ended?.matchedCount) await eraseRehearsal(current ?? job);
      if (!cancelled) {
        const name = plainName(job.name);
        if (rehearsal)
          tell(
            job,
            'rehearsal-stopped',
            'Rehearsal stopped',
            pushBody(`${name}: ${message}`, place),
          );
        else if (over)
          tell(
            job,
            'over-quote',
            'Your described video needs your OK',
            pushBody(`${name}: ${message}`, place),
          );
        else if (lane === 'render')
          tell(
            job,
            'stopped',
            'Your described video stopped',
            pushBody(`${name}: ${message}`, continueText, place),
          );
        else
          tell(
            job,
            'check-failed',
            job.youtube
              ? 'Your YouTube video could not be imported'
              : 'Your video could not be checked',
            pushBody(`${name}: ${message}`, place),
          );
      }
      return 'stopped';
    } finally {
      finished = true;
      clearTimeout(watchdog);
      clearInterval(heartbeat);
      clearTimeout(deadline);
      await beatInFlight;
      if (controllers.get(job._id) === controller) controllers.delete(job._id);
      if (wedges.get(job._id) === wedge) wedges.delete(job._id);
      await settleOnce();
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function check(job: Job): Promise<void> {
    const started = Date.now();
    const outcome = await lease(job, 'check', async (directory, signal, progress) => {
      let source = join(directory, 'source');
      let about = job.about || '';
      let title: string | undefined;
      let chapters: Chapter[] | undefined;
      let bytes = job.bytes;
      let partial = false;
      if (job.state === 'importing' && job.youtube) {
        await progress('Importing the YouTube video', 1);
        const imported = await importYouTube(
          job.youtube,
          directory,
          maxSourceMinutes() * 60,
          signal,
          hooks.log,
        );
        source = imported.file;
        bytes = imported.bytes;
        title = clip(cleanLabel(imported.name), 200);
        about = clip(imported.about, 2000);
        chapters = imported.chapters;
        await progress('Saving your imported video', 5);
        await putFile(job.key, source, 'video/mp4', signal);
      } else {
        await progress(
          job.sourceKey ? 'Reading the library video' : 'Reading your uploaded video',
          1,
        );
        const fetched = await fetchForCheck(
          job.sourceKey || job.key,
          source,
          signal,
          job.sourceKey ? job.bytes || undefined : job.bytes,
        );
        bytes = fetched.bytes;
        partial = fetched.partial;
      }
      let media: Awaited<ReturnType<typeof probe>>;
      try {
        media = await probe(source, signal);
      } catch (error) {
        if (!partial || signal.aborted) throw error;
        hooks.log(
          line('dv.check', { id: job._id, note: 'ends-only probe failed; reading the whole file' }),
        );
        await rm(source, { force: true });
        await download(job.sourceKey || job.key, source, signal, { bytes });
        media = await probe(source, signal);
      }
      if (media.seconds > maxSourceMinutes() * 60)
        throw new Problem(
          `This video is ${spokenLength(media.seconds)} long. Videos up to ${spokenLength(maxSourceMinutes() * 60)} can be checked.`,
        );
      const saved = await Jobs.updateOne(
        { _id: job._id, worker, cancelRequested: false },
        {
          $set: {
            state: 'ready',
            bytes,
            about,
            seconds: media.seconds,
            stage: 'Ready to describe',
            progress: 0,
            error: '',
            expiresAt: retain(job, 3),
            ...(chapters?.length ? { chapters: chapters.slice(0, 200) } : {}),
          },
          $unset: { worker: 1, lease: 1, checkFailure: 1 },
        },
      );
      if (!saved.matchedCount) throw new Cancelled('Video checking was cancelled.');
      if (title)
        await Jobs.updateOne({ _id: job._id, name: 'YouTube video' }, { $set: { name: title } });
      hooks.log(
        line('dv.checked', {
          id: job._id,
          owner: ownerTag(job.owner),
          source: job.source,
          seconds: Math.round(media.seconds),
          bytes,
          partial,
          ms: Date.now() - started,
        }),
      );
    });
    if (outcome === 'done' && Date.now() - started > minute) {
      const fresh = await Jobs.findById(job._id).lean();
      if (fresh?.state === 'ready')
        tell(
          fresh,
          'ready-to-describe',
          'Your video is ready to describe',
          pushBody(
            `${plainName(fresh.name)}: ${spokenLength(fresh.seconds || 0)}, checked and ready to describe.`,
            place,
          ),
        );
    }
  }

  async function render(job: Job): Promise<void> {
    const reservation = job.reservation;
    /** `usd` counts requests in flight at their reserve; `pending` is that in-flight part. */
    const spend = { usd: job.runCost ?? 0, pending: 0 };
    const rehearsal = job.runKind === 'rehearsal';
    let notice: (() => void) | undefined;
    const settle = async () => {
      if (!reservation) return;
      const current = await Jobs.findById(job._id).lean();
      if (
        current &&
        current.reservation?.runId === reservation.runId &&
        busy.includes(current.state)
      )
        return;
      await release(reservation, spend.usd);
    };
    await lease(
      job,
      'render',
      async (directory, signal, progress) => {
        if (!job.settings || !reservation)
          throw new Error('This job has no saved narration settings.');
        const started = Date.now();
        const settings = settingsSchema.parse(job.settings);
        const kind = job.runKind ?? (job.revoice ? 'revoice' : 'fresh');
        const runSettings: Settings = describing.includes(kind)
          ? settings
          : { ...settings, firstLook: false };
        await Jobs.updateOne(
          { _id: job._id, worker },
          { $set: { runAt: new Date(), runFrom: job.progress || 0, error: '' } },
        );
        hooks.log(
          line('dv.claim', {
            id: job._id,
            owner: ownerTag(job.owner),
            kind,
            version: job.version || 1,
            source: job.source,
            seconds: Math.round(job.seconds || 0),
            bytes: job.bytes,
            mode: settings.mode,
            detail: settings.detail,
            closeLook: !!settings.closeLook,
            firstLook: !!runSettings.firstLook,
            estimateUSD: job.runEstimateUSD,
            setAsideUSD: reservation.cents / 100,
            approvedUSD: job.approvedUSD,
            restarts: job.restarts ?? 0,
            crashes: job.crashes ?? 0,
          }),
        );
        await checkRoom(job.bytes);
        const source = join(directory, 'source');
        await progress('Getting the video ready', Math.max(1, job.progress || 0));
        await download(job.sourceKey || job.key, source, signal, {
          bytes: job.sourceKey ? undefined : job.bytes,
        });
        const state = await keeperFor(job, signal);
        const grow = async (needed: number): Promise<boolean> => {
          const room = Math.round(jobLimit() * 100) - reservation.cents;
          const cents = Math.min(room, Math.ceil(toCents(needed) / growCents) * growCents);
          if (cents < toCents(needed) || cents <= 0 || !(await growRun(reservation, cents)))
            return false;
          await Jobs.updateOne(
            { _id: job._id, 'reservation.runId': reservation.runId },
            { $inc: { 'reservation.cents': cents } },
          );
          reservation.cents += cents;
          return true;
        };
        let accounting = Promise.resolve();
        const account = (action: () => Promise<void>): Promise<void> => {
          const next = accounting.then(action);
          accounting = next.catch(() => {});
          return next;
        };
        const quoted = job.runEstimateUSD ?? 0;
        const approved = job.approvedUSD ?? approvalFor(quoted || jobLimit());
        const settleCost = (kindKey: keyof Spend, reserve: number, actual: number) =>
          account(async () => {
            spend.usd = Math.max(0, spend.usd - reserve + actual);
            spend.pending = Math.max(0, spend.pending - reserve);
            job.costUSD = Math.max(0, job.costUSD - reserve + actual);
            await Jobs.updateOne(
              { _id: job._id, worker },
              {
                $set: { runCost: spend.usd, costUSD: job.costUSD },
                $inc: { [`spend.${kindKey}`]: actual },
              },
            );
          });
        /**
         * Her approval limits what the run is charged: once the settled charges reach it, no
         * further paid request starts. A reserve is only a provider's worst case, so requests in
         * flight may still hold more of the day (up to one run's limit) until they settle.
         */
        const paidMeter: Meter = async (kind, reserve, action) => {
          await account(async () => {
            signal.throwIfAborted();
            if (!Number.isFinite(reserve) || reserve < 0)
              throw new Halt('A cost estimate was invalid.');
            const charged = spend.usd - spend.pending;
            if (charged >= approved - 1e-9) throw new OverQuote(charged, quoted);
            const held = reservation.cents / 100;
            if (spend.usd + reserve > held && !(await grow(spend.usd + reserve - held)))
              throw new Halt(
                'The job reached its processing allowance, so no further paid requests were sent. Finished sections are kept.',
              );
            spend.usd += reserve;
            spend.pending += reserve;
            job.costUSD += reserve;
            const saved = await Jobs.updateOne(
              { _id: job._id, worker, cancelRequested: false },
              { $set: { runCost: spend.usd, costUSD: job.costUSD } },
            );
            if (!saved.matchedCount)
              throw new Halt('Processing stopped before the next paid request.');
          });
          let result: { costUSD: number };
          try {
            result = await action();
          } catch (error) {
            const reported = (error as { costUSD?: unknown }).costUSD;
            const actual =
              typeof reported === 'number' && Number.isFinite(reported) && reported >= 0
                ? reported
                : billed(error)
                  ? reserve
                  : 0;
            const uncertain = actual === reserve && typeof reported !== 'number';
            await settleCost(uncertain ? 'uncertain' : kind, reserve, actual);
            if (actual > 0)
              await hooks
                .usage(job.owner, job._id, uncertain ? `${kind}-uncertain` : kind, actual)
                .catch(() => {});
            hooks.log(
              line('dv.paid-failure', {
                id: job._id,
                kind,
                settled: actual,
                status: axios.isAxiosError(error) ? error.response?.status : undefined,
              }),
            );
            throw error;
          }
          await settleCost(kind, reserve, result.costUSD);
          await hooks
            .usage(job.owner, job._id, kind, result.costUSD)
            .catch((error: Error) => hooks.log('description usage: ' + error.message));
        };
        const rehearsalMeter: Meter = async () => {
          throw new Halt('A rehearsal never sends paid requests.');
        };
        const meter = rehearsal ? rehearsalMeter : paidMeter;
        const request: RunRequest = {
          source,
          directory,
          title: copyName(job, settings.range),
          about: [
            job.about || '',
            job.context
              ? `Library catalog (may be wrong; use only to recognise what is visible or spoken): ${job.context}`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
          settings: runSettings,
          session: `video:${job._id}`,
          signal,
          meter,
          progress,
          providers: rehearsal ? rehearsalProviders : (hooks.providers ?? productionProviders),
          keeper: state.keeper,
          voices: Math.min(4, Math.max(1, Number(process.env.KADE_DESCRIPTION_VOICES) || 2)),
          stopAfter: job.stopAfter,
          chapters: job.chapters,
          sectionNotes: Object.fromEntries(
            Object.entries(job.sectionNotes ?? {}).map(([index, note]) => [Number(index), note]),
          ),
          log: (message) => hooks.log(line('dv.engine', { id: job._id, message: scrub(message) })),
        };
        const output = await (hooks.describe ?? describeVideo)(request);
        await progress('Saving the described copy', 97);
        const version = job.version || 1;
        const files: Record<string, string> = {
          'described.mp4': output.video,
          'described.m4a': output.audio,
          'description.json': output.files.report,
          'transcript.txt': output.files.transcript,
          'descriptions.vtt': output.files.descriptions,
          'captions.vtt': output.files.captions,
        };
        let uploadedBytes = 0;
        for (const item of outputs) {
          signal.throwIfAborted();
          if ((await stat(files[item.file])).size > 6 * 1024 ** 3)
            throw new Problem('The described copy is larger than the storage limit.');
          uploadedBytes += await putFile(
            `${folder(job)}/copies/${version}/${item.file}`,
            files[item.file],
            item.mime,
            signal,
          );
        }
        signal.throwIfAborted();
        const report = output.report;
        const failed = [...state.failures.entries()]
          .filter(([, failure]) => !!failure)
          .map(([index]) => index)
          .sort((a, b) => a - b);
        const current = await Jobs.findOne({ _id: job._id, worker }).lean();
        if (!current) throw new Cancelled('Video processing was cancelled.');
        const copy: FinishedCopy = {
          version,
          preview: job.stopAfter !== undefined,
          settings,
          outputSeconds: report.outputSeconds,
          count: report.descriptions.length,
          skipped: report.skipped.length,
          failedSections: report.failedSections.length,
          finishedAt: new Date(),
          ...(settings.range ? { range: settings.range } : {}),
          kind: report.kind,
          sections: state.manifest,
          failed,
          spans: state.spans(),
          firstLook: job.firstLookVersion,
          ...(rehearsal ? { rehearsal: true } : {}),
        };
        const copies = [...(current.copies ?? []).filter((item) => item.version !== version), copy];
        const expiresAt = retain(current, rehearsal ? 3 : 7);
        const back = rehearsal ? rehearsalStop(job, 'finished') : undefined;
        const saved = await Jobs.updateOne(
          { _id: job._id, worker, cancelRequested: false },
          back
            ? {
                $set: { ...back.set, copies, expiresAt, done: 0, crashes: 0 },
                $unset: {
                  ...back.unset,
                  manifest: 1,
                  sections: 1,
                  spans: 1,
                  planKey: 1,
                  carry: 1,
                  crashAt: 1,
                },
              }
            : {
                $set: {
                  state: 'done',
                  active: false,
                  stage:
                    job.stopAfter !== undefined
                      ? 'Your preview is ready'
                      : 'Your described copy is ready',
                  progress: 100,
                  outputSeconds: report.outputSeconds,
                  count: report.descriptions.length,
                  skipped: report.skipped.length,
                  failedSections: report.failedSections.length,
                  kind: report.kind,
                  finishedAt: new Date(),
                  expiresAt,
                  copies,
                  manifest: state.manifest,
                  savedToLibrary: '',
                  crashes: 0,
                },
                $unset: {
                  worker: 1,
                  lease: 1,
                  expiryWarned: 1,
                  carry: 1,
                  crashAt: 1,
                  cancelAt: 1,
                },
              },
        );
        if (!saved.matchedCount) throw new Cancelled('Video processing was cancelled.');
        const runUSD = Math.round(spend.usd * 10000) / 10000;
        hooks.log(
          line(rehearsal ? 'dv.rehearsal' : 'dv.done', {
            id: job._id,
            owner: ownerTag(job.owner),
            kind,
            version,
            outcome: 'done',
            preview: copy.preview,
            runUSD,
            estimateUSD: job.runEstimateUSD,
            approvedUSD: job.approvedUSD,
            overran: !rehearsal && runUSD > (job.runEstimateUSD ?? 0),
            outputSeconds: Math.round(report.outputSeconds),
            descriptions: report.descriptions.length,
            skipped: report.skipped.length,
            failedSections: report.failedSections.length,
            elapsedMin: Math.round((Date.now() - started) / 6000) / 10,
            uploadedBytes,
          }),
        );
        const name = copyName(job, settings.range);
        const extras = [
          report.failedSections.length
            ? `${counted(report.failedSections.length, 'part')} could not be described`
            : '',
          report.skipped.length ? `${report.skipped.length} left out for lack of room` : '',
        ].filter(Boolean);
        const summary = `${name}: ${spokenLength(report.outputSeconds)} with ${counted(report.descriptions.length, 'description')}${extras.length ? `, ${extras.join(' and ')}` : ''}.`;
        const until = `Kept until ${dateText(expiresAt)}.`;
        if (rehearsal)
          notice = () =>
            tell(
              job,
              'rehearsal',
              'Rehearsal finished',
              pushBody(summary, 'Made with a test tone, at no cost.', place),
            );
        else if (copy.preview)
          notice = () =>
            tell(
              job,
              'preview',
              'Your preview is ready',
              pushBody(
                summary,
                `It cost ${money(spend.usd)}. Listen, then choose Describe the rest. ${until}`,
                place,
              ),
            );
        else
          notice = () =>
            tell(job, 'ready', 'Your described video is ready', pushBody(summary, until, place));
      },
      settle,
    );
    notice?.();
  }

  /* ---------- recovery ---------- */
  const staleFilter = () => ({
    updatedAt: { $lt: new Date(Date.now() - 2 * minute) },
    $or: [{ lease: { $lt: new Date() } }, { lease: { $exists: false } }],
  });
  /** Stuck mid-reservation (a crash between two writes): back where it came from, and the pending money returned. */
  async function sweepReserving(): Promise<void> {
    const stuck = await Jobs.find({
      state: 'reserving',
      updatedAt: { $lt: new Date(Date.now() - 2 * minute) },
    })
      .limit(20)
      .lean();
    for (const job of stuck) {
      const restored = await Jobs.findOneAndUpdate(
        { _id: job._id, state: 'reserving', updatedAt: job.updatedAt },
        {
          $set: {
            state: job.reservingFrom || (job.revoice ? 'done' : 'ready'),
            cancelRequested: false,
          },
          $unset: { pendingRun: 1, reservingFrom: 1 },
        },
        { new: true },
      ).lean();
      if (restored) {
        await release(job.pendingRun, 0);
        hooks.log(line('dv.reserving-restored', { id: job._id, to: restored.state }));
      }
    }
  }
  /** A job she cancelled whose worker died settles as cancelled, with its money returned. */
  async function settleCancelled(job: Job): Promise<void> {
    const back = rehearsing(job) ? rehearsalStop(job, 'cancelled') : undefined;
    const cancelled = await Jobs.findOneAndUpdate(
      { _id: job._id, state: job.state, cancelRequested: true, updatedAt: job.updatedAt },
      back
        ? { $set: back.set, $unset: back.unset }
        : {
            $set: {
              state: 'cancelled',
              active: false,
              stage: 'Cancelled',
              error: 'Processing stopped. Work already sent to providers may still be charged.',
              expiresAt: retain(job, 3),
            },
            $unset: { worker: 1, lease: 1 },
          },
      { new: true },
    ).lean();
    if (!cancelled) return;
    await release(cancelled.reservation, cancelled.runCost ?? 0);
    if (back) await eraseRehearsal(cancelled);
  }
  /** Jobs whose worker vanished: rendering continues from its saved sections, checks restart. */
  async function sweep(lane: 'check' | 'render'): Promise<void> {
    if (lane === 'check') {
      for (const job of await Jobs.find({
        state: { $in: checking },
        cancelRequested: true,
        ...staleFilter(),
      })
        .limit(20)
        .lean())
        await settleCancelled(job);
      await Jobs.updateMany(
        { state: { $in: checking }, cancelRequested: false, ...staleFilter() },
        { $unset: { worker: 1, lease: 1 } },
      );
      await expire();
      await warnExpiring();
      return;
    }
    for (const job of await Jobs.find({
      state: { $in: ['queued', 'running'] },
      cancelRequested: true,
      ...staleFilter(),
    })
      .limit(20)
      .lean())
      await settleCancelled(job);
    for (const job of await Jobs.find({
      state: 'running',
      cancelRequested: false,
      ...staleFilter(),
    })
      .limit(20)
      .lean()) {
      const at = job.done ?? 0;
      const crashes = job.crashAt === at ? (job.crashes ?? 0) + 1 : 1;
      if (crashes < 3) {
        await Jobs.updateOne(
          { _id: job._id, state: 'running', updatedAt: job.updatedAt },
          {
            $set: {
              state: 'queued',
              stage: 'Continuing after a server restart',
              crashes,
              crashAt: at,
              priority: 0,
            },
            $unset: { worker: 1, lease: 1 },
          },
        );
        hooks.log(line('dv.requeue', { id: job._id, lane: 'render', why: 'crash', crashes }));
        continue;
      }
      const back = rehearsing(job)
        ? rehearsalStop(
            job,
            'stopped',
            'The rehearsal stopped: the server restarted three times at the same place.',
          )
        : undefined;
      const failed = await Jobs.findOneAndUpdate(
        { _id: job._id, state: 'running', updatedAt: job.updatedAt },
        back
          ? { $set: back.set, $unset: back.unset }
          : {
              $set: {
                state: 'failed',
                active: false,
                crashes,
                crashAt: at,
                stage: 'Stopped before finishing',
                error: crashText,
                finishedAt: new Date(),
                expiresAt: retain(job, 3),
              },
              $unset: { worker: 1, lease: 1 },
            },
        { new: true },
      ).lean();
      if (!failed) continue;
      await release(failed.reservation, failed.runCost ?? 0);
      if (back) await eraseRehearsal(failed);
      warn(line('dv.fail', { id: job._id, lane: 'render', why: 'crashes', crashes }));
      if (back)
        tell(
          failed,
          'rehearsal-stopped',
          'Rehearsal stopped',
          pushBody(`${plainName(failed.name)}: ${failed.error ?? ''}`, place),
        );
      else
        tell(
          failed,
          'stopped',
          'Your described video stopped',
          pushBody(`${plainName(failed.name)}: ${crashText}`, place),
        );
    }
  }
  /** Removes expired jobs, claiming each first; a failed erase keeps the record and is tried again in an hour. */
  async function expire(): Promise<void> {
    const due = {
      expiresAt: { $lt: new Date() },
      state: { $nin: [...busy, ...checking] },
      $or: [
        { librarySaving: { $exists: false } },
        { librarySaving: { $lt: new Date(Date.now() - 10 * minute) } },
      ],
    };
    for (const job of await Jobs.find(due).sort({ expiresAt: 1 }).limit(10).lean()) {
      const claimed = await Jobs.findOneAndUpdate(
        { _id: job._id, ...due },
        { $set: { state: 'deleting', active: false } },
        { new: true },
      ).lean();
      if (!claimed) continue;
      try {
        await abortUpload(claimed);
        await eraseAll(claimed);
        await Jobs.deleteOne({ _id: job._id, state: 'deleting' });
        hooks.log(line('dv.expired', { id: job._id }));
      } catch (error) {
        warn(
          line('dv.expiry_failed', {
            id: job._id,
            error: scrub((error as Error).message || 'failed'),
          }),
        );
        await Jobs.updateOne(
          { _id: job._id, state: 'deleting' },
          { $set: { expiresAt: new Date(Date.now() + hour) } },
        );
      }
    }
  }
  /** One push, about a day ahead, before a finished copy she never saved to the Library is removed. */
  async function warnExpiring(): Promise<void> {
    const soon = await Jobs.find({
      state: 'done',
      expiryWarned: { $ne: true },
      expiresAt: { $gt: new Date(), $lt: new Date(Date.now() + day) },
    })
      .limit(20)
      .lean();
    for (const job of soon) {
      if (!realCopies(job).some((copy) => !copy.savedToLibrary)) continue;
      const claimed = await Jobs.updateOne(
        { _id: job._id, expiryWarned: { $ne: true } },
        { $set: { expiryWarned: true } },
      );
      if (!claimed.modifiedCount) continue;
      tell(
        job,
        'expiring',
        'A described copy will be removed soon',
        pushBody(
          `${plainName(job.name)}: kept until ${dateText(job.expiresAt)}.`,
          `Save it to your Library, or press Keep ${keepDays} more days.`,
          place,
        ),
      );
    }
  }

  async function runLane(name: 'check' | 'render'): Promise<void> {
    const lane = lanes[name];
    if (closing || lane.running || mongoose.connection.readyState !== 1) return;
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
        { $set: { worker, until: new Date(Date.now() + 90 * second) } },
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
        { $set: { worker, lease: new Date(Date.now() + 90 * second) } },
        {
          new: true,
          sort: name === 'render' ? { priority: 1, queuedAt: 1, createdAt: 1 } : { createdAt: 1 },
        },
      ).lean();
      if (!job) return;
      if (name === 'render') {
        job.state = 'running';
        await Jobs.updateOne({ _id: job._id, worker }, { $set: { state: 'running' } });
      }
      const work = name === 'check' ? check(job) : render(job);
      inflight.add(work);
      const tracked = work.finally(() => inflight.delete(work));
      await Promise.race([tracked, wedges.get(job._id) ?? tracked]);
    } catch (error) {
      warn(
        line('dv.lane', {
          lane: name,
          error: scrub(error instanceof Error ? error.message : 'failed'),
        }),
      );
    } finally {
      await Locks.updateOne({ _id: lane.lock, worker }, { $set: { until: new Date(0) } }).catch(
        () => {},
      );
      lane.running = false;
    }
  }
  async function tick(): Promise<void> {
    if (closing || mongoose.connection.readyState !== 1) return;
    await sweepReserving().catch((error: Error) =>
      warn(line('dv.sweep', { error: scrub(error.message) })),
    );
    await Promise.all([runLane('check'), runLane('render')]);
  }
  const tickMs = hooks.timing?.tickMs ?? 15 * second;
  const timer = tickMs > 0 ? setInterval(() => void tick(), tickMs) : undefined;
  timer?.unref();
  return {
    router,
    tick,
    close: () =>
      (closing ||= (async () => {
        if (timer) clearInterval(timer);
        for (const controller of controllers.values())
          controller.abort(new Shutdown('The server is restarting.'));
        await Promise.race([
          Promise.allSettled([...inflight]),
          new Promise((resolve) => setTimeout(resolve, 20 * second).unref()),
        ]);
      })()),
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
