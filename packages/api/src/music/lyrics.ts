import axios from 'axios';
import express from 'express';
import mongoose from 'mongoose';
import type { Request, RequestHandler, Router } from 'express';

type Transcript = { transcript: string; seconds: number; model: string };
type Reference = {
  user: string;
  key: string;
  url: string;
  transcript?: Transcript;
  leaseUntil?: Date;
};
const schema = new mongoose.Schema<Reference>({
  user: String,
  key: String,
  url: String,
  transcript: mongoose.Schema.Types.Mixed,
  leaseUntil: Date,
});
schema.index({ user: 1, key: 1 }, { unique: true });
const References =
  (mongoose.models.KadeMusicReference as mongoose.Model<Reference>) ||
  mongoose.model<Reference>('KadeMusicReference', schema);
function identity(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new Error('Use an imported recording.');
  return parsed.origin + parsed.pathname;
}
export async function registerMusicReference(user: string, url: string): Promise<void> {
  await References.updateOne({ user, key: identity(url) }, { $set: { url } }, { upsert: true });
}
type Hooks = {
  auth: RequestHandler;
  user: (req: Request) => string;
  savedSources: (user: string) => Promise<string[]>;
  refresh: (url: string) => Promise<string>;
  duration: (buffer: Buffer) => Promise<number>;
  transcribe: (buffer: Buffer, mime: string) => Promise<Transcript>;
};

export function createLyricsRouter(hooks: Hooks): Router {
  const router = express.Router();
  router.post(
    '/reference/lyrics',
    hooks.auth,
    express.json({ limit: '16kb' }),
    async (req, res) => {
      let key: string;
      const user = hooks.user(req);
      try {
        if (typeof req.body.url !== 'string' || req.body.url.length > 12000)
          throw new Error('No recording.');
        key = identity(req.body.url);
      } catch {
        res.status(400).json({ error: 'Import a cover recording first.' });
        return;
      }
      try {
        let reference = await References.findOne({ user, key }).lean();
        if (!reference) {
          const sources = await hooks.savedSources(user);
          const owned = sources.find((url) => {
            try {
              return identity(url) === key;
            } catch {
              return false;
            }
          });
          if (!owned) {
            res
              .status(404)
              .json({ error: 'That recording is not saved on your account. Import it again.' });
            return;
          }
          await registerMusicReference(user, owned);
          reference = await References.findOne({ user, key }).lean();
        }
        const warning =
          'Draft lyrics only: singing, backing vocals and instruments can cause wrong or missing words. Listen and correct the Lyrics box before generating. Add section tags where useful.';
        if (reference?.transcript) {
          res.json({ ...reference.transcript, warning, cached: true });
          return;
        }
        const claim = await References.findOneAndUpdate(
          {
            user,
            key,
            $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: new Date() } }],
          },
          { $set: { leaseUntil: new Date(Date.now() + 240000) } },
          { new: true },
        ).lean();
        if (!claim) {
          res
            .status(409)
            .json({ error: 'This recording is already being transcribed. Wait for it to finish.' });
          return;
        }
        try {
          const url = await hooks.refresh(claim.url);
          const audio = await axios.get<ArrayBuffer>(url, {
            responseType: 'arraybuffer',
            maxRedirects: 0,
            maxContentLength: 20 * 1024 * 1024,
            timeout: 45000,
          });
          const buffer = Buffer.from(audio.data);
          const seconds = await hooks.duration(buffer);
          if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 360) {
            res.status(400).json({ error: 'Use a readable recording up to six minutes long.' });
            return;
          }
          const result = await hooks.transcribe(
            buffer,
            String(audio.headers['content-type'] || 'audio/mpeg'),
          );
          if (!result.transcript?.trim()) {
            res
              .status(422)
              .json({ error: 'No clear words were detected. Your existing lyrics are kept.' });
            return;
          }
          result.transcript = result.transcript.slice(0, 8000);
          await References.updateOne({ user, key }, { $set: { transcript: result } });
          res.json({ ...result, warning, cached: false });
        } finally {
          await References.updateOne({ user, key }, { $unset: { leaseUntil: 1 } });
        }
      } catch {
        res.status(502).json({
          error:
            'Could not transcribe this recording. Your existing lyrics are kept. Try a clearer recording or type the words.',
        });
      }
    },
  );
  return router;
}
