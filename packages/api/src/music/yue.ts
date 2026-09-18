import { randomUUID } from 'crypto';
import axios from 'axios';
import express from 'express';
import mongoose from 'mongoose';
import type { Request, Response, RequestHandler, Router } from 'express';

type Input = { style: string; lyrics: string; abc?: string; cot: 'full' | 'melody'; seed: number };
type Output = { url?: string; wav_url?: string; duration_s?: number; bytes?: number; truncated?: boolean; error?: string; score_key?: string };
type Provider = { id?: string; status?: string; output?: Output; executionTime?: number; error?: string };
type Job = { id: string; user: string; projectId: string; providerId?: string; state: string; input: Input; output?: Output; error?: string; createdAt: Date; leaseUntil?: Date; costUSD?: number; active: boolean };
type Hooks = {
  auth: RequestHandler;
  user: (req: Request) => string;
  project: (user: string, input: Input, sourceText: string) => Promise<string>;
  update: (job: Job) => Promise<void>;
  complete: (job: Job) => Promise<void>;
};
const schema = new mongoose.Schema<Job>({
  id: { type: String, unique: true }, user: String, projectId: String, providerId: String,
  state: String, input: mongoose.Schema.Types.Mixed, output: mongoose.Schema.Types.Mixed,
  error: String, createdAt: Date, leaseUntil: Date, costUSD: Number, active: Boolean,
});
schema.index({ user: 1 }, { unique: true, partialFilterExpression: { active: true } });
const Jobs = mongoose.models.KadeYueJob as mongoose.Model<Job> || mongoose.model<Job>('KadeYueJob', schema);
const rate = 1.22;
const spokenCost = 'YuE2 uses a sleeping GPU at about $1.22 an hour. Startup, generation and ten minutes awake after the last job are billed. There is no reliable per-song estimate yet.';

export function yueInput(body: { script?: string; lyrics?: string; abc?: string; cot?: string; seed?: number }): Input {
  if (typeof body.script !== 'string' || body.script.trim().length < 3 || body.script.length > 3000) throw new Error('Describe the music in 3 to 3000 characters.');
  if (typeof body.lyrics !== 'string' || !body.lyrics.trim() || body.lyrics.length > 8000) throw new Error('Add the words to sing in Lyrics, up to 8000 characters.');
  if (body.abc != null && (typeof body.abc !== 'string' || body.abc.length > 40000)) throw new Error('The score must be ABC text, up to 40000 characters.');
  if (body.seed != null && (!Number.isInteger(body.seed) || body.seed < 0 || body.seed > 2147483647)) throw new Error('Seed must be a whole number from 0 to 2147483647.');
  return { style: body.script.trim(), lyrics: body.lyrics.trim(), abc: body.abc || undefined,
    cot: body.abc && body.cot !== 'full' ? 'melody' : 'full', seed: body.seed ?? Math.floor(Math.random() * 2147483647) };
}
export function yueConfigured(): boolean { return !!(process.env.YUE_ENDPOINT_ID && process.env.RUNPOD_API_KEY); }
async function provider(path: string, data?: { input: Input; policy: { executionTimeout: number; ttl: number } }): Promise<Provider> {
  const base = `https://api.runpod.ai/v2/${process.env.YUE_ENDPOINT_ID}`;
  const response = await axios.request<Provider>({ url: `${base}/${path}`, method: data || path.startsWith('cancel/') ? 'POST' : 'GET', data,
    headers: { Authorization: `Bearer ${process.env.RUNPOD_API_KEY}` }, timeout: 30000 });
  return response.data;
}

export function createYueRouter(hooks: Hooks): Router {
  const router = express.Router();
  let indexes: Promise<void> | undefined;
  function authorize(req: Request, res: Response, action: () => Promise<Response | void>) {
    return hooks.auth(req, res, () => {
      void action().catch(() => { if (!res.headersSent) res.status(503).json({ error: 'The music service is temporarily unavailable. No automatic retry was made.' }); });
    });
  }
  const activeStates = ['queued', 'running', 'saving'];
  async function advance(id: string) {
    const job = await Jobs.findOneAndUpdate({ id, state: { $in: activeStates }, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: new Date() } }] },
      { $set: { leaseUntil: new Date(Date.now() + 120000) } }, { new: true }).lean();
    if (!job) return;
    try {
      if (job.state !== 'saving') {
        if (!job.providerId) return;
        const response = await provider(`status/${encodeURIComponent(job.providerId)}`);
        if (response.status === 'COMPLETED' && response.output?.url && !response.output.error) {
          job.state = 'saving'; job.output = response.output;
          job.costUSD = (response.executionTime || 0) / 3600000 * rate;
        } else if (['FAILED', 'CANCELLED', 'TIMED_OUT', 'COMPLETED'].includes(response.status || '')) {
          job.state = response.status === 'CANCELLED' ? 'cancelled' : 'failed';
          job.error = response.output?.error || 'The music worker did not finish. Your writing is saved.';
        } else {
          job.state = response.status === 'IN_PROGRESS' ? 'running' : 'queued';
        }
        await Jobs.updateOne({ id }, { $set: { state: job.state, output: job.output, costUSD: job.costUSD, error: job.error } });
      }
      if (job.state === 'saving') {
        await hooks.complete(job);
        job.state = 'done';
      }
      await hooks.update(job);
      await Jobs.updateOne({ id }, { $set: { state: job.state, active: activeStates.includes(job.state) } });
    } finally { await Jobs.updateOne({ id }, { $unset: { leaseUntil: 1 } }); }
  }
  let polling = false;
  const timer = setInterval(async () => {
    if (polling || mongoose.connection.readyState !== 1 || !yueConfigured()) return;
    polling = true;
    try {
      const jobs = await Jobs.find({ state: { $in: activeStates } }).select('id').lean();
      for (const job of jobs) await advance(job.id).catch(() => {});
    } catch { /* Keep pending jobs durable through temporary database outages. */ }
    finally { polling = false; }
  }, 20000);
  timer.unref();
  router.post('/render', express.json({ limit: '128kb' }), (req, res, next) => {
    if (req.body?.engine !== 'yue2') return next();
    return authorize(req, res, async () => {
      if (!yueConfigured()) return res.status(503).json({ error: 'YuE2 is being prepared. Lyria is available now.' });
      let input: Input;
      try { input = yueInput(req.body); } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : 'Check the song inputs.' }); }
      if (req.body.referenceExpected || req.body.reference_voice_url || req.body.audio_urls?.length) return res.status(400).json({ error: 'Audio covers need transcription first. Use an ABC melody score; direct recording import is not enabled yet.' });
      if (req.body.estimateOnly) return res.json({ ok: true, estimate: { spoken: spokenCost } });
      const user = hooks.user(req), id = `yue_${randomUUID()}`;
      let created = false;
      try {
        indexes ??= Jobs.createIndexes();
        await indexes;
        await Jobs.create({ id, user, projectId: '', state: 'submitting', active: true, input, createdAt: new Date() });
        created = true;
        const projectId = await hooks.project(user, input, String(req.body.sourceText || ''));
        await Jobs.updateOne({ id }, { $set: { projectId } });
        const response = await provider('run', { input, policy: { executionTimeout: 1200000, ttl: 3600000 } });
        if (!response.id) throw new Error('Missing job id');
        const job = await Jobs.findOneAndUpdate({ id }, { $set: { providerId: response.id, state: 'queued' } }, { new: true }).lean();
        if (job) await hooks.update(job);
        return res.json({ ok: true, queued: true, engine: 'yue2', projectId, jobId: id, estimate: { spoken: spokenCost } });
      } catch (error) {
        if (!created) {
          const duplicate = error instanceof Error && 'code' in error && error.code === 11000;
          return res.status(duplicate ? 409 : 503).json({ error: duplicate ? 'You already have a YuE2 request in progress. Wait for it before making another.' : 'The music queue is unavailable. No request was sent.' });
        }
        // A lost provider response must never cause an automatic second paid submission.
        const job = await Jobs.findOneAndUpdate({ id }, { $set: { state: 'uncertain', error: 'Could not confirm whether the request started. No automatic retry was made. Contact Kade before retrying.' } }, { new: true }).lean();
        if (job?.projectId) await hooks.update(job).catch(() => {});
        return res.status(502).json({ error: job?.error, jobId: id });
      }
    });
  });
  router.get('/status/:jobId', (req, res, next) => {
    if (!req.params.jobId.startsWith('yue_')) return next();
    return authorize(req, res, async () => {
      const id = req.params.jobId;
      let job = await Jobs.findOne({ id, user: hooks.user(req) }).lean();
      if (!job) return res.status(404).json({ error: 'No such music request on your account.' });
      await advance(id).catch(() => {});
      job = await Jobs.findOne({ id, user: hooks.user(req) }).lean();
      if (!job) return res.sendStatus(404);
      const state = job.state === 'saving' ? 'running' : job.state === 'uncertain' ? 'failed' : job.state;
      return res.json({ jobId: id, projectId: job.projectId, state, error: job.error,
        url: job.output?.url, durationS: job.output?.duration_s,
        spoken: state === 'done' ? `Your song is ready in your library.${job.output?.truncated ? ' It reached a generation limit and may end early.' : ''}` : state === 'queued' ? 'Waiting for the music GPU to wake. The first song can take several minutes.' : state === 'running' ? 'YuE2 is composing and recording your song.' : job.error || 'Stopped.' });
    });
  });
  router.post('/cancel/:jobId', (req, res, next) => {
    if (!req.params.jobId.startsWith('yue_')) return next();
    return authorize(req, res, async () => {
      const job = await Jobs.findOne({ id: req.params.jobId, user: hooks.user(req) }).lean();
      if (!job) return res.sendStatus(404);
      if (!job.providerId) return res.status(409).json({ error: 'This request needs its provider status checked before it can be stopped.' });
      try {
        await provider(`cancel/${encodeURIComponent(job.providerId)}`);
        await advance(job.id);
        return res.json({ ok: true, spoken: 'Stop requested. GPU time already used is still billed.' });
      } catch { return res.status(502).json({ error: 'Could not confirm the stop. Try Stop again.' }); }
    });
  });
  return router;
}
