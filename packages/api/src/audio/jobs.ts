import { randomUUID } from 'crypto';
import express from 'express';
import mongoose from 'mongoose';
import type { Request, Response, RequestHandler, Router } from 'express';
import type { MyVoiceJob } from '../music/myVoice';

export type Input = {
  duration?: number;
  style: string;
  title: string;
  count: number;
  weirdness?: number;
  steps?: number;
  soundModel?: '3_medium' | '3_small_sfx';
  guidance?: number;
  lyrics?: string;
  abc?: string;
  reference_voice_url?: string;
  cot?: 'full' | 'melody' | 'off';
  band?: string;
  lora_key?: string;
  lora_scale?: number;
  /* Part 295 YuE2 worker fields, sent only behind YUE_COVERS_V2 (music/yue.ts). */
  instrumental?: boolean;
  keep_harmony?: boolean;
  match_score_tempo?: boolean;
  length_guard?: boolean;
  /* Sing it in my voice (music/myVoice.ts): YuE2's automatic choice, and a voice job's own fields. Both are set or cleared on
   * the server by the owner check (Hooks.prepare), never trusted from the client alone. */
  my_voice?: boolean;
  voice?: MyVoiceJob;
  /* Lyric sync worker fields, sent only behind YUE_FIT_LYRICS and YUE_MEASURE_FIT (music/yue.ts). */
  fit_lyrics?: 'timing';
  measure_fit?: boolean;
  /* A/B only, behind YUE_SCORE_TOUCHUP with YUE_FIT_LYRICS (music/yue.ts). */
  fit_score_touchup?: boolean;
  /* Fit by tempo, sent only for a cover of a recording behind YUE_FIT_TEMPO (music/yue.ts). */
  fit_tempo?: boolean;
  seed: number;
};
type LyricFitRow = {
  score_section?: string | null;
  lyrics_section?: string | null;
  sung_notes?: number | null;
  syllables?: number | null;
  fit?: string;
};
type HitCount = { hits?: number; of?: number };
type LyricSyncReport = {
  applied?: boolean;
  reason?: string | null;
  lyrics_fitted?: boolean;
  phrases?: number;
  phrases_with_words?: number;
  lines?: number;
  words_without_tune?: Array<{ section?: string | null; words?: number; lines?: number }>;
  fit_score?: number | null;
  held_words_on_note?: HitCount;
  /* Held notes the recording itself was not heard clearly on: reported apart, never spoken. */
  held_unverified?: HitCount;
  phrase_starts_after_pause?: HitCount;
  words_heard?: HitCount;
  /* Her sections: fitted to the tune, or kept as she wrote them (too few words heard clearly). */
  sections?: Array<{ index?: number; section?: string | null; words?: number; heard?: number; fitted?: boolean }>;
  repeats?: Array<{ section?: string | null; instances?: number[]; source?: number; fitted?: boolean }>;
  score_touchup?: {
    applied?: boolean;
    ties?: number;
    folds?: number;
    places?: Array<{ section?: string | null; phrase?: number; held_note?: number; kind?: string }>;
  } | null;
};
type TempoFitReport = {
  applied?: boolean;
  reason?: string;
  factor?: number;
  percent?: number;
  from_bpm?: number;
  to_bpm?: number;
  score_seconds_before?: number;
  score_seconds_after?: number;
  limit_seconds?: number;
  fit_seconds?: number;
  source_seconds?: number | null;
  /* Each BPM Music direction named, [as written, as sung]. */
  style_bpm?: number[][];
};
export type Output = {
  url?: string;
  wav_url?: string;
  duration_s?: number;
  bytes?: number;
  truncated?: boolean;
  /* Which YuE2 limit a truncated take reached: its written score (abc) or the song itself (semantic). */
  truncation_flags?: { abc?: boolean; semantic?: boolean } | null;
  error?: string;
  score_key?: string;
  queue_ms?: number;
  execution_ms?: number;
  /* Part 295 YuE2 worker report; an older worker sends none of these, and `features` says which exist. */
  gpu?: string | null;
  features?: string[];
  cover_mode?: string | null;
  instrumental?: boolean;
  lyric_fit?: { sections?: LyricFitRow[]; same_order?: boolean } | null;
  worker_notes?: string[];
  /* The voice worker's extra files (music/myVoice.ts MyVoiceOutput). */
  vocal_url?: string;
  vocal_wav_url?: string;
  /* Lyric sync report (worker features lyric-sync and fit-score): counts and indices only. */
  lyric_sync?: LyricSyncReport | null;
  lyrics_used?: string;
  /* Worker feature meter-check: the style names a meter the score contradicts. */
  meter_check?: { style_meter?: string; score_meter?: string } | null;
  /* Worker feature fit-tempo: a score too long for six minutes sung faster to fit (its Q: line only). */
  tempo_fit?: TempoFitReport | null;
};
export type Provider = {
  id?: string;
  statusUrl?: string;
  responseUrl?: string;
  cancelUrl?: string;
  costUSD?: number;
  status?: string;
  output?: Output;
  executionTime?: number;
  delayTime?: number;
  error?: string;
};
export type Take = {
  id: string;
  seed: number;
  providerId?: string;
  statusUrl?: string;
  responseUrl?: string;
  cancelUrl?: string;
  state: string;
  output?: Output;
  error?: string;
  costUSD?: number;
};
type Notification = { at: Date; accepted?: number; deferred?: boolean; blocked?: string };
export type Job = {
  takes?: Take[];
  notification?: Notification;
  notifyEnabled?: boolean;
  id: string;
  user: string;
  projectId: string;
  providerId?: string;
  statusUrl?: string;
  responseUrl?: string;
  cancelUrl?: string;
  state: string;
  input: Input;
  output?: Output;
  error?: string;
  createdAt: Date;
  leaseUntil?: Date;
  costUSD?: number;
  active: boolean;
};
export type Hooks = {
  auth: RequestHandler;
  user: (req: Request) => string;
  validateReference?: (user: string, url: string) => Promise<string>;
  project: (user: string, input: Input, sourceText: string) => Promise<string>;
  update: (job: Job) => Promise<void>;
  complete: (job: Job) => Promise<void>;
  notify?: (job: Job) => Promise<Notification>;
  /** Runs after parse and the reference check, before the estimate: can refuse (throw, said as a 400) or complete the input with
   * what only the server knows, such as the account's voice model. */
  prepare?: (user: string, input: Input) => Promise<Input>;
};
export type Config = {
  engine: string;
  prefix: string;
  model: string;
  name: string;
  configured: () => boolean;
  parse: (body: InputBody) => Input;
  estimate: (input: Input) => { spoken: string; costUSD?: number };
  submit: (input: Input) => Promise<Provider>;
  status: (take: Take, input: Input) => Promise<Provider>;
  cancel: (take: Take) => Promise<void>;
  working: string;
  stopping: string;
  /** A short sentence about one finished take, said when the batch is done; '' for none. */
  takeNote?: (output: Output, input: Input) => string;
  /** True when takeNote itself says a take that stopped at its length limit (the worker's
   * `truncated`), on the take and in the library, so the batch's general sentence is not said too. */
  notesTruncated?: boolean;
};
export type InputBody = {
  soundModel?: string;
  title?: string;
  count?: number;
  duration?: number;
  weirdness?: number;
  steps?: number;
  guidance?: number;
  script?: string;
  lyrics?: string;
  abc?: string;
  cot?: string;
  band?: string;
  seed?: number;
  reference_voice_url?: string;
  referenceExpected?: boolean;
  singing?: string | boolean;
  keep_chords?: string | boolean;
  /* Sing it in my voice: YuE2's automatic choice, and the voice engine's own settings. */
  my_voice?: string | boolean;
  voice_source?: string;
  pitch?: number | string;
  extractor?: string;
  lead_split?: boolean | string;
  dereverb?: boolean | string;
  soft_s?: boolean | string;
  index_rate?: number;
  protect?: number;
  rms_mix_rate?: number;
  vocal_fx?: string;
};
/** Each finished take's note, said once when every finished take has the same one. Said once for
 * several takes, a note about "this take" (a YuE2 take cut at its length limit) speaks of each take. */
function sayTakeNotes(takes: Take[], input: Input, note?: Config['takeNote']): string {
  if (!note) return '';
  const finished = takes
    .map((take, index) => ({ number: index + 1, output: take.state === 'done' ? take.output : undefined }))
    .filter((take) => take.output);
  const said = finished
    .map((take) => ({ number: take.number, text: take.output ? note(take.output, input).trim() : '' }))
    .filter((take) => take.text);
  if (!said.length) return '';
  const distinct = new Set(said.map((take) => take.text));
  if (distinct.size === 1 && said.length === finished.length)
    return ` ${finished.length > 1 ? said[0].text.replace(/\bthis take\b/g, 'each take') : said[0].text}`;
  return ` ${said.map((take) => `Take ${take.number}: ${take.text}`).join(' ')}`;
}
const takeSchema = new mongoose.Schema<Take>(
  {
    id: String,
    seed: Number,
    providerId: String,
    statusUrl: String,
    responseUrl: String,
    cancelUrl: String,
    state: String,
    output: mongoose.Schema.Types.Mixed,
    error: String,
    costUSD: Number,
  },
  { _id: false },
);
const schema = new mongoose.Schema<Job>({
  id: { type: String, unique: true },
  user: String,
  projectId: String,
  providerId: String,
  state: String,
  input: mongoose.Schema.Types.Mixed,
  output: mongoose.Schema.Types.Mixed,
  takes: { type: [takeSchema], default: undefined },
  notification: mongoose.Schema.Types.Mixed,
  notifyEnabled: Boolean,
  error: String,
  createdAt: Date,
  leaseUntil: Date,
  costUSD: Number,
  active: Boolean,
});
schema.index({ user: 1 }, { unique: true, partialFilterExpression: { active: true } });

export function createAudioRouter(hooks: Hooks, config: Config): Router {
  const Jobs =
    (mongoose.models[config.model] as mongoose.Model<Job>) ||
    mongoose.model<Job>(config.model, schema);
  const router = express.Router();
  let indexes: Promise<void> | undefined;
  function authorize(req: Request, res: Response, action: () => Promise<Response | void>) {
    return hooks.auth(req, res, () => {
      void action().catch(() => {
        if (!res.headersSent)
          res.status(503).json({
            error: 'The sound service is temporarily unavailable. No automatic retry was made.',
          });
      });
    });
  }
  const activeStates = ['queued', 'running', 'saving'];
  function takesFor(job: Job): Take[] {
    return (
      job.takes || [
        {
          id: job.id,
          seed: job.input.seed,
          providerId: job.providerId,
          state: job.state,
          output: job.output,
          error: job.error,
          costUSD: job.costUSD,
        },
      ]
    );
  }
  function aggregate(job: Job, takes: Take[]) {
    job.takes = takes;
    job.costUSD = takes.reduce((sum, take) => sum + (take.costUSD || 0), 0);
    job.output = takes.find((take) => take.state === 'done')?.output;
    const unfinished = takes.some((take) => activeStates.includes(take.state));
    const uncertain = takes.some((take) => take.state === 'uncertain');
    const done = takes.filter((take) => take.state === 'done').length;
    job.state = 'cancelled';
    if (done) job.state = 'done';
    if (takes.some((take) => take.state === 'failed')) job.state = 'failed';
    if (uncertain) job.state = 'uncertain';
    if (unfinished)
      job.state = takes.some((take) => ['running', 'saving'].includes(take.state))
        ? 'running'
        : 'queued';
    job.active = unfinished || uncertain;
    const errors = takes.filter((take) => take.error).map((take) => take.error);
    job.error = errors.length
      ? `${done} of ${takes.length} takes saved. ${[...new Set(errors)].join(' ')}`
      : undefined;
  }
  async function notify(job: Job) {
    if (
      !hooks.notify ||
      !job.notifyEnabled ||
      activeStates.includes(job.state) ||
      job.state === 'submitting'
    )
      return;
    // Claim before sending: a lost delivery response must never cause duplicate pushes.
    const claim = await Jobs.updateOne(
      { id: job.id, notification: { $exists: false } },
      { $set: { notification: { at: new Date(), blocked: 'Delivery started; receipt pending' } } },
    );
    if (!claim.modifiedCount) return;
    let notification: Notification;
    try {
      notification = await hooks.notify(job);
    } catch {
      notification = {
        at: new Date(),
        accepted: 0,
        blocked: 'Notification service unavailable; delivery unconfirmed',
      };
    }
    await Jobs.updateOne({ id: job.id }, { $set: { notification } });
  }
  async function advance(id: string) {
    const lease = new Date(Date.now() + 300000);
    const job = await Jobs.findOneAndUpdate(
      {
        id,
        state: { $in: [...activeStates, 'submitting'] },
        $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: new Date() } }],
      },
      { $set: { leaseUntil: lease } },
      { new: true },
    ).lean();
    if (!job) {
      const terminal = await Jobs.findOne({
        id,
        notifyEnabled: true,
        notification: { $exists: false },
        state: { $in: ['done', 'failed', 'cancelled', 'uncertain'] },
      }).lean();
      if (terminal) await notify(terminal);
      return;
    }
    try {
      job.notifyEnabled = true;
      const takes = takesFor(job);
      for (const take of takes) {
        try {
          if (take.state === 'submitting') {
            take.state = 'uncertain';
            take.error =
              'Submission was interrupted. Contact Kade before retrying; no automatic paid retry was made.';
          }
          if (take.state === 'pending') take.state = 'cancelled';
          if (!activeStates.includes(take.state)) continue;
          if (take.state !== 'saving') {
            if (!take.providerId) continue;
            const response = await config.status(take, job.input);
            if (response.status === 'COMPLETED' && response.output?.url && !response.output.error) {
              take.state = 'saving';
              take.output = response.output;
            } else if (
              ['FAILED', 'CANCELLED', 'TIMED_OUT', 'COMPLETED'].includes(response.status || '')
            ) {
              take.state = response.status === 'CANCELLED' ? 'cancelled' : 'failed';
              take.error =
                response.output?.error ||
                response.error ||
                'The sound provider did not finish. Your writing is saved.';
            } else {
              take.state = response.status === 'IN_PROGRESS' ? 'running' : 'queued';
            }
            take.costUSD = response.costUSD || 0;
            await Jobs.updateOne({ id }, { $set: { takes } });
          }
          if (take.state === 'saving') {
            await hooks.complete({ ...job, ...take, input: { ...job.input, seed: take.seed } });
            take.state = 'done';
            await Jobs.updateOne({ id }, { $set: { takes } });
          }
        } catch {
          /* Keep this take pending; other takes can still finish. */
        }
      }
      aggregate(job, takes);
      await hooks.update(job);
      await Jobs.updateOne(
        { id },
        {
          $set: {
            state: job.state,
            notifyEnabled: job.notifyEnabled,
            active: job.active,
            output: job.output,
            error: job.error,
            costUSD: job.costUSD,
            takes,
          },
        },
      );
      await notify(job);
    } finally {
      await Jobs.updateOne({ id, leaseUntil: lease }, { $unset: { leaseUntil: 1 } });
    }
  }
  let polling = false;
  const timer = setInterval(async () => {
    if (polling || mongoose.connection.readyState !== 1 || !config.configured()) return;
    polling = true;
    try {
      const jobs = await Jobs.find({
        $or: [
          { state: { $in: [...activeStates, 'submitting'] } },
          { notifyEnabled: true, notification: { $exists: false } },
        ],
      })
        .select('id')
        .lean();
      for (const job of jobs) await advance(job.id).catch(() => {});
    } catch {
      /* Keep pending jobs durable through temporary database outages. */
    } finally {
      polling = false;
    }
  }, 20000);
  timer.unref();
  router.post('/render', express.json({ limit: '128kb' }), (req, res, next) => {
    if (req.body?.engine !== config.engine) return next();
    return authorize(req, res, async () => {
      if (!config.configured())
        return res.status(503).json({ error: `${config.name} is not configured yet.` });
      let input: Input;
      try {
        input = config.parse(req.body);
        if (input.reference_voice_url && hooks.validateReference)
          input.reference_voice_url = await hooks.validateReference(
            hooks.user(req),
            input.reference_voice_url,
          );
        if (hooks.prepare) input = await hooks.prepare(hooks.user(req), input);
      } catch (error) {
        return res
          .status(400)
          .json({ error: error instanceof Error ? error.message : 'Check the sound inputs.' });
      }
      const estimate = config.estimate(input);
      if (req.body.estimateOnly) return res.json({ ok: true, estimate });
      const user = hooks.user(req),
        id = `${config.prefix}${randomUUID()}`;
      const takes: Take[] = Array.from({ length: input.count }, (_, index) => ({
        id: `${id}_${index + 1}`,
        seed: (input.seed + index) % 2147483648,
        state: 'pending',
      }));
      try {
        indexes ??= Jobs.createIndexes();
        await indexes;
        await Jobs.create({
          id,
          user,
          projectId: '',
          state: 'submitting',
          active: true,
          input,
          takes,
          createdAt: new Date(),
          leaseUntil: new Date(Date.now() + 300000),
          notifyEnabled: true,
        });
      } catch (error) {
        const duplicate = error instanceof Error && 'code' in error && error.code === 11000;
        return res.status(duplicate ? 409 : 503).json({
          error: duplicate
            ? `You already have a ${config.name} request in progress. Wait for it before making another.`
            : 'The sound queue is unavailable. No request was sent.',
        });
      }
      let projectId: string;
      try {
        projectId = await hooks.project(user, input, String(req.body.sourceText || ''));
        await Jobs.updateOne({ id }, { $set: { projectId } });
      } catch {
        await Jobs.updateOne(
          { id },
          {
            $set: {
              state: 'failed',
              active: false,
              notifyEnabled: false,
              error: 'Could not save the draft. No request was sent.',
            },
            $unset: { leaseUntil: 1 },
          },
        );
        return res.status(503).json({ error: 'Could not save the draft. No request was sent.' });
      }
      try {
        for (const take of takes) {
          take.state = 'submitting';
          await Jobs.updateOne({ id }, { $set: { takes } });
          try {
            const response = await config.submit({ ...input, seed: take.seed });
            if (!response.id) throw new Error('Missing job id');
            take.providerId = response.id;
            take.statusUrl = response.statusUrl;
            take.responseUrl = response.responseUrl;
            take.cancelUrl = response.cancelUrl;
            take.state = 'queued';
          } catch {
            take.state = 'uncertain';
            take.error =
              'Could not confirm whether one take started. Contact Kade before retrying. No automatic paid retry was made.';
            for (const pending of takes)
              if (pending.state === 'pending') pending.state = 'cancelled';
          }
          await Jobs.updateOne({ id }, { $set: { takes } });
          if (take.state === 'uncertain') break;
        }
        const job = await Jobs.findOne({ id }).lean();
        if (!job) throw new Error('Missing job');
        aggregate(job, takes);
        await hooks.update(job);
        await Jobs.updateOne(
          { id },
          {
            $set: { state: job.state, active: job.active, error: job.error, takes },
            $unset: { leaseUntil: 1 },
          },
        );
        await notify(job);
        return res.status(job.state === 'uncertain' ? 502 : 200).json({
          ok: job.state !== 'uncertain',
          queued: activeStates.includes(job.state),
          engine: config.engine,
          projectId,
          jobId: id,
          error: job.error,
          estimate,
        });
      } finally {
        await Jobs.updateOne({ id }, { $unset: { leaseUntil: 1 } });
      }
    });
  });
  router.get('/status/:jobId', (req, res, next) => {
    if (!req.params.jobId.startsWith(config.prefix)) return next();
    return authorize(req, res, async () => {
      const id = req.params.jobId;
      let job = await Jobs.findOne({ id, user: hooks.user(req) }).lean();
      if (!job) return res.status(404).json({ error: 'No such sound request on your account.' });
      await advance(id).catch(() => {});
      job = await Jobs.findOne({ id, user: hooks.user(req) }).lean();
      if (!job) return res.sendStatus(404);
      let state = job.state;
      if (state === 'saving') state = 'running';
      if (state === 'submitting') state = 'queued';
      if (state === 'uncertain') state = 'failed';
      const takes = takesFor(job),
        completed = takes.filter((take) => take.state === 'done').length;
      const progress = `${completed} of ${takes.length} takes ready.`;
      let spoken = job.error || 'Stopped. Completed takes are kept.';
      if (state === 'done')
        spoken = `${progress} Open your library to compare them.${!config.notesTruncated && takes.some((take) => take.output?.truncated) ? ' A take reached a generation limit and may end early.' : ''}${sayTakeNotes(takes, job.input, config.takeNote)}`;
      if (['queued', 'running'].includes(state))
        spoken = `${progress} ${config.working} You can leave this screen; a notification will open the Sound Booth when the batch finishes.`;
      return res.json({
        jobId: id,
        projectId: job.projectId,
        state,
        error: job.error,
        completed,
        total: takes.length,
        url: job.output?.url,
        durationS: job.output?.duration_s,
        spoken,
      });
    });
  });
  router.post('/cancel/:jobId', (req, res, next) => {
    if (!req.params.jobId.startsWith(config.prefix)) return next();
    return authorize(req, res, async () => {
      const job = await Jobs.findOne({ id: req.params.jobId, user: hooks.user(req) }).lean();
      if (!job) return res.sendStatus(404);
      if (job.state === 'submitting' || takesFor(job).some((take) => take.state === 'uncertain'))
        return res.status(409).json({
          error: 'This request needs its provider status checked before it can be stopped.',
        });
      try {
        for (const take of takesFor(job))
          if (take.providerId && ['queued', 'running'].includes(take.state))
            await config.cancel(take);
        await advance(job.id);
        return res.json({
          ok: true,
          spoken: config.stopping,
        });
      } catch {
        return res.status(502).json({ error: 'Could not confirm the stop. Try Stop again.' });
      }
    });
  });
  return router;
}
