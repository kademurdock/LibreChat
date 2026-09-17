import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import mongoose, { Schema } from 'mongoose';
import type { Request, RequestHandler } from 'express';
import type { Model } from 'mongoose';

type Actor = { id: string; name?: string; username?: string; email?: string; role?: string };
type Result = { book?: object; skipped?: object[]; jacket?: string; error?: string; ok?: boolean };
type Job = {
  _id: string; owner: string; actor: Actor; fileName: string; bytes: number; key: string;
  private: boolean; grownUpsOnly: boolean; state: string; result?: Result; error?: string;
  lease?: Date; worker?: string; slot?: number; createdAt: Date; updatedAt: Date;
};
type Dependencies = {
  auth: RequestHandler; actor: (req: Request) => Actor;
  sign: (key: string, bytes: number) => Promise<string>;
  head: (key: string) => Promise<{ ContentLength?: number }>;
  download: (key: string) => Promise<Readable>;
  remove: (key: string) => Promise<void>;
  existing: (id: string, owner: string) => Promise<Result | null>;
  importFile: (job: Job, path: string, directory: string) => Promise<Result>;
  log: (message: string) => void;
};

export function validateImport(fileName: unknown, bytes: unknown): { fileName: string; bytes: number } {
  if (typeof fileName !== 'string' || !fileName || fileName.length > 240 || /[\r\n\0]/.test(fileName)) throw new Error('Invalid book filename.');
  const ext = fileName.toLowerCase().split('.').pop();
  if (!ext || !['zip', 'epub', 'txt', 'docx', 'html', 'htm', 'xhtml', 'xml'].includes(ext)) throw new Error('Unsupported book format.');
  const limit = ext === 'zip' ? 4 * 1024 ** 3 : 256 * 1024 ** 2;
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > limit) throw new Error('ZIP books must be at most 4 GB; other text imports at most 256 MB.');
  return { fileName, bytes };
}

export function bookImportId(owner: string, requestId: string): string {
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(requestId)) throw new Error('Invalid upload recovery ID.');
  return createHash('sha256').update(owner + ':' + requestId).digest('hex').slice(0, 24);
}

/** Bytes travel to object storage; HTTP requests only create/check a durable job.
 * A renewable lease plus deterministic book ID recovers process restarts without
 * repeating completed imports. Failed jobs require an explicit commit retry.
 */
export function bookImportRouter(deps: Dependencies): Router {
  const schema = new Schema<Job>({
    _id: String, owner: { type: String, index: true }, actor: Schema.Types.Mixed,
    fileName: String, bytes: Number, key: String, private: Boolean, grownUpsOnly: Boolean,
    slot: Number, state: String, result: Schema.Types.Mixed, error: String, lease: Date, worker: String,
  }, { timestamps: true });
  schema.index({ owner: 1, slot: 1 }, { unique: true, partialFilterExpression: { slot: { $type: 'number' } } });
  const jobs = (mongoose.models.KadeBookImport || mongoose.model<Job>('KadeBookImport', schema)) as Model<Job>;
  const router = Router();
  const worker = randomUUID();
  const active = new Set<string>();
  const owners = new Set<string>();
  const status = (job: Job) => ({ id: job._id, state: job.state, error: job.error, result: job.result });

  async function run(id: string): Promise<void> {
    if (active.has(id) || active.size >= 2) return;
    active.add(id);
    let owner = ''; let directory = ''; let heartbeat: NodeJS.Timeout | undefined;
    try {
      const current = await jobs.findById(id).lean();
      if (!current || owners.has(current.owner)) return;
      owner = current.owner; owners.add(owner);
      const job = await jobs.findOneAndUpdate({ _id: id, $or: [{ state: 'queued' }, { state: 'importing', lease: { $lt: new Date() } }] },
        { $set: { state: 'importing', worker, lease: new Date(Date.now() + 120000) } }, { new: true }).lean();
      if (!job) return;
      heartbeat = setInterval(() => { void jobs.updateOne({ _id: id, worker, state: 'importing' }, { $set: { lease: new Date(Date.now() + 120000) } }).catch(e => deps.log('import lease: ' + e.message)); }, 30000);
      heartbeat.unref();
      let result = await deps.existing(id, job.owner);
      if (!result) {
        directory = await mkdtemp(join(tmpdir(), 'kade-direct-book-'));
        const path = join(directory, 'source');
        let received = 0;
        const limit = new Transform({ transform(chunk: Buffer, _encoding, done) {
          received += chunk.length;
          done(received > job.bytes ? new Error('Stored book exceeds the declared size.') : null, chunk);
        } });
        await pipeline(await deps.download(job.key), limit, createWriteStream(path));
        if (received !== job.bytes) throw new Error('Stored book is incomplete.');
        result = await deps.importFile(job, path, directory);
        if (!result.book) throw new Error(result.error || 'The book could not be imported.');
      }
      await jobs.updateOne({ _id: id, worker }, { $set: { state: 'ready', result, error: '' }, $unset: { lease: 1, slot: 1 } });
      await deps.remove(job.key).catch(e => deps.log('import cleanup: ' + e.message));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Book import failed.';
      deps.log('book import ' + id + ': ' + message);
      await jobs.updateOne({ _id: id, worker }, { $set: { state: 'failed', error: message.slice(0, 400) }, $unset: { lease: 1 } }).catch(() => {});
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      active.delete(id); if (owner) owners.delete(owner);
    }
  }

  // Queued jobs survive a closed client and expired worker leases survive deploys.
  const recover = setInterval(() => {
    if (active.size >= 2) return;
    void jobs.find({ $or: [{ state: 'queued' }, { state: 'importing', lease: { $lt: new Date() } }] }).limit(8).lean()
      .then(pending => { for (const job of pending) void run(job._id); })
      .catch(error => deps.log('import recovery: ' + error.message));
  }, 30000);
  recover.unref();

  router.use(deps.auth);
  router.post('/', async (req, res) => {
    try {
      const actor = deps.actor(req);
      const abandoned = await jobs.find({ owner: actor.id, state: { $in: ['uploading', 'failed'] }, updatedAt: { $lt: new Date(Date.now() - 7 * 86400000) } }).limit(8).lean();
      for (const old of abandoned) {
        await deps.remove(old.key);
        await jobs.updateOne({ _id: old._id, updatedAt: old.updatedAt }, { $unset: { slot: 1 }, $set: { state: 'failed', error: 'Upload expired. Select the same book to restart.' } });
      }
      const input = validateImport(req.body.fileName, req.body.bytes);
      const id = bookImportId(actor.id, req.body.requestId);
      const initial = { _id: id, owner: actor.id, actor, ...input, key: `book-imports/${actor.id}/${id}`,
        private: req.body.private === true, grownUpsOnly: req.body.grownUpsOnly === true, state: 'uploading' };
      let job = await jobs.findOne({ _id: id, owner: actor.id }).lean();
      if (!job) {
        for (let slot = 0; slot < 8 && !job; slot++) {
          try { job = await jobs.findOneAndUpdate({ _id: id, owner: actor.id }, { $setOnInsert: { ...initial, slot } }, { new: true, upsert: true }).lean(); }
          catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 11000) throw error; }
        }
        if (!job) return res.status(429).json({ error: 'Finish or retry an earlier book import before starting another.' });
      }
      if (!job || job.fileName !== input.fileName || job.bytes !== input.bytes || job.private !== initial.private || job.grownUpsOnly !== initial.grownUpsOnly) return res.status(409).json({ error: 'This recovery ID belongs to a different upload. Select the original file and settings.' });
      // A lost PUT receipt is recoverable without resending a multi-gigabyte ZIP.
      if (job.state === 'uploading' || job.state === 'failed') {
        let arrived = false;
        try { arrived = (await deps.head(job.key)).ContentLength === job.bytes; } catch { /* not uploaded yet */ }
        if (!arrived) {
          if (job.state === 'failed') { await jobs.updateOne({ _id: id, state: 'failed' }, { $set: { state: 'uploading', error: '' } }); job.state = 'uploading'; }
          return res.json({ ...status(job), uploadRequired: true, url: await deps.sign(job.key, job.bytes), mime: 'application/octet-stream' });
        }
      }
      res.json({ ...status(job), uploadRequired: false });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Could not prepare book import.' }); }
  });
  router.post('/:id/commit', async (req, res) => {
    try {
      const job = await jobs.findOne({ _id: req.params.id, owner: deps.actor(req).id }).lean();
      if (!job) return res.status(404).json({ error: 'No such import.' });
      if (job.state === 'ready') return res.json(status(job));
      if (!['queued', 'importing'].includes(job.state)) {
        if ((await deps.head(job.key)).ContentLength !== job.bytes) return res.status(400).json({ error: 'The book has not finished uploading.' });
        await jobs.updateOne({ _id: job._id, state: job.state }, { $set: { state: 'queued', error: '', actor: deps.actor(req) } });
      }
      void run(job._id);
      res.status(202).json({ id: job._id, state: 'queued' });
    } catch { res.status(503).json({ error: 'Could not confirm storage. Retry this same import.' }); }
  });
  router.get('/:id', async (req, res) => {
    try {
      const job = await jobs.findOne({ _id: req.params.id, owner: deps.actor(req).id }).lean();
      if (!job) return res.status(404).json({ error: 'No such import.' });
      if (job.state === 'queued' || (job.state === 'importing' && (!job.lease || job.lease.getTime() < Date.now()))) void run(job._id);
      res.json(status(job));
    } catch { res.status(503).json({ error: 'Could not check this import. Retry the same ID.' }); }
  });
  return router;
}
