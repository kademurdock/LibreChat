import axios from 'axios';
import express from 'express';
import mongoose from 'mongoose';
import { randomBytes } from 'crypto';
import type { Request, RequestHandler, Response, Router } from 'express';
import type { MyVoiceChoice, MyVoiceRange } from './myVoice';
import { checkMyVoiceModel, myVoiceEnabled } from './myVoice';

/* ----------------------------------------------------------------------------
 * THE VOICE LAB (Nov 18 2026)
 *
 * Her words: "I think it would be interesting to be able to clone voices on my platform, like if I wanted to clone
 * someone's voice to sing with me", and then: "so far I'm the only one with access to that. So people would have to
 * consent to me to clone or record them if they wanted a voice on there. But last time I had you clone my voice, there's
 * no current way for me to do that."
 *
 * So: a screen where the account that already has Sing it in my voice makes more voices herself. She names the voice,
 * says whose it is, ticks that she has that person's permission when it is not her own, adds recordings (files or the
 * microphone), and the voice worker learns the voice (its "train" mode: an RVC v2 model and its index). A finished voice
 * shows up in Sing it in my voice under Voice.
 *
 * Rules kept here, on the server:
 *   - Only an account the host says is allowed (the owner check of Sing it in my voice) reaches any route; anyone else
 *     gets the same 404 an unknown address gets.
 *   - A voice that is not her own cannot be made without the permission tick, and the record of it (when, whose, her
 *     note) stays on the voice for good, even after the voice is deleted.
 *   - Recordings live under voice-samples/<user>/<voice>/ and the model under voice-models/<user>/<voice>/; a key the
 *     worker hands back that points anywhere else is refused. The recordings are deleted once the voice is ready.
 *   - One training at a time for an account, and nothing paid is ever retried by itself: a submission whose answer was
 *     lost is marked and left, as on every other booth lane.
 *
 * Behind VOICE_LAB_ENABLED (anything but 0) on top of the voice worker's own switches.
 * -------------------------------------------------------------------------- */

export function voiceLabEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VOICE_LAB_ENABLED !== '0' && myVoiceEnabled(env);
}

const VOICE_ID = /^v[0-9a-f]{15}$/;
const LIMITS = {
  samples: 60,
  sampleBytes: 60 * 1024 * 1024,
  totalSeconds: 90 * 60,
  minSeconds: 60,
  goodSeconds: 10 * 60,
  voices: 40,
};
const EXTENSIONS = ['wav', 'mp3', 'm4a', 'ogg', 'flac', 'webm'];
const TYPES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  webm: 'audio/webm',
};
/** RunPod flex price per second for the voice worker's usual card (the same figure myVoice.ts estimates with). */
const USD_PER_SECOND = 0.000306;
const POLICY = { executionTimeout: 2 * 3600 * 1000, ttl: 6 * 3600 * 1000 };

type Sample = { key: string; name: string; seconds: number; bytes: number };
type Row = {
  id: string;
  user: string;
  name: string;
  whose: 'mine' | 'other';
  person?: string;
  consent: { at: Date; note: string; ticked: boolean };
  state: string;
  samples: Sample[];
  options?: { isolate?: boolean; denoise?: number; epochs?: 'auto' | number };
  providerId?: string;
  progress?: string;
  error?: string;
  model_key?: string;
  model_sha256?: string;
  index_key?: string;
  index_sha256?: string;
  range?: MyVoiceRange;
  minutes?: number;
  epochs?: number;
  costUSD?: number;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  leaseUntil?: Date;
};
const schema = new mongoose.Schema<Row>({
  id: { type: String, unique: true },
  user: { type: String, index: true },
  name: String,
  whose: String,
  person: String,
  consent: { at: Date, note: String, ticked: Boolean },
  state: String,
  samples: { type: [{ key: String, name: String, seconds: Number, bytes: Number, _id: false }], default: [] },
  options: mongoose.Schema.Types.Mixed,
  providerId: String,
  progress: String,
  error: String,
  model_key: String,
  model_sha256: String,
  index_key: String,
  index_sha256: String,
  range: mongoose.Schema.Types.Mixed,
  minutes: Number,
  epochs: Number,
  costUSD: Number,
  createdAt: Date,
  startedAt: Date,
  finishedAt: Date,
  leaseUntil: Date,
});

/** What a screen is told about a voice: never a storage key, never a checksum. */
export type VoiceLabVoice = {
  id: string;
  name: string;
  whose: 'mine' | 'other';
  person: string;
  state: string;
  /** One sentence for the state, ready to be read aloud. */
  status: string;
  samples: Array<{ name: string; seconds: number }>;
  seconds: number;
  minutes?: number;
  canTrain: boolean;
  estimate: string;
  createdAt: Date;
};

/** The epochs "auto" stands for, by minutes of recordings: the worker's own table (voice/voice_train.py), mirrored for the estimate. */
export function voiceLabEpochs(minutes: number): number {
  if (minutes < 5) return 300;
  if (minutes < 15) return 200;
  if (minutes < 30) return 120;
  return 80;
}
/** GPU seconds a training run is likely to take: loading and listening, then about 0.7 s for each epoch of each minute. */
function trainSeconds(seconds: number, isolate: boolean): number {
  const minutes = Math.min(60, seconds / 60);
  return 240 + (isolate ? 0.5 * seconds : 0) + voiceLabEpochs(minutes) * minutes * 0.7;
}
function sayMoney(usd: number): string {
  const cents = Math.max(1, Math.round(usd * 100));
  return cents >= 100 ? `$${usd.toFixed(2)}` : `${cents} cents`;
}
function sayLength(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} seconds`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${m} minute${m === 1 ? '' : 's'}${rest ? ` ${rest} seconds` : ''}`;
}
function estimate(seconds: number, isolate: boolean): string {
  if (seconds < LIMITS.minSeconds)
    return `Add at least one minute of recordings. You have ${sayLength(seconds)}. Ten minutes or more makes a much better voice.`;
  const gpu = trainSeconds(seconds, isolate);
  const low = Math.max(5, Math.round((gpu * 0.7) / 60));
  const high = Math.round((gpu * 1.4) / 60) + 3;
  return `About ${sayMoney(gpu * USD_PER_SECOND)} of GPU time for ${sayLength(seconds)} of recordings, usually ${low} to ${high} minutes. Startup is extra when the voice worker has to wake up. It does not use your credit balance.`;
}

/** A voice's name as she typed it, or the sentence that says why it will not do. */
export function checkVoiceName(value: unknown): string {
  const name = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length < 2 || name.length > 40) throw new Error('Give the voice a name from 2 to 40 characters.');
  if (/[<>"`\\]/.test(name)) throw new Error('Use letters, numbers, spaces and simple punctuation in the name.');
  if (name.toLowerCase() === 'my voice') throw new Error('My voice is already the name of your own voice. Choose another name.');
  return name;
}

function statusLine(row: Row): string {
  const seconds = row.samples.reduce((sum, s) => sum + (s.seconds || 0), 0);
  switch (row.state) {
    case 'collecting':
      return row.samples.length
        ? `${row.samples.length} recording${row.samples.length === 1 ? '' : 's'} added, ${sayLength(seconds)} in all. Not learned yet.`
        : 'No recordings yet. Add recordings of this voice, then choose Learn this voice.';
    case 'submitting':
    case 'training':
      return row.progress ? `Learning this voice. ${row.progress}.` : 'Learning this voice. This usually takes 15 to 40 minutes.';
    case 'ready':
      return `Ready. Choose it under Voice in Sing it in my voice.${row.minutes ? ` Learned from ${sayLength(row.minutes * 60)} of recordings.` : ''}`;
    case 'uncertain':
      return 'It is not known whether learning started. Nothing was retried. Check again in a few minutes, or start again.';
    case 'cancelled':
      return 'Learning was stopped. The recordings are kept, so you can start again.';
    case 'failed':
      return `Learning did not finish. ${row.error || 'The recordings are kept, so you can try again.'}`;
    default:
      return row.state;
  }
}
function view(row: Row): VoiceLabVoice {
  const seconds = row.samples.reduce((sum, s) => sum + (s.seconds || 0), 0);
  const open = ['collecting', 'failed', 'cancelled', 'uncertain'].includes(row.state);
  return {
    id: row.id,
    name: row.name,
    whose: row.whose,
    person: row.person || '',
    state: row.state,
    status: statusLine(row),
    samples: row.samples.map((s) => ({ name: s.name, seconds: Math.round(s.seconds || 0) })),
    seconds: Math.round(seconds),
    ...(row.minutes ? { minutes: row.minutes } : {}),
    canTrain: open && seconds >= LIMITS.minSeconds,
    estimate: open ? estimate(seconds, !!row.options?.isolate) : '',
    createdAt: row.createdAt,
  };
}

/** The words the voice lab page shows, served so a wording fix is one deploy and every client says the same thing. */
export function voiceLabGuide(): Record<string, unknown> {
  return {
    title: 'Voice lab',
    intro:
      'Make a singing voice from recordings. Add at least one minute of one person singing or talking with nothing else in the recording; ten minutes or more makes a much better voice. When it is ready, choose it under Voice in Sing it in my voice.',
    consent:
      'I have this person’s permission to copy their voice, and they know it will be used to sing songs here.',
    consentHint:
      'Needed for any voice that is not your own. When and whose is kept with the voice. Only you can use the voices you make.',
    tips: [
      'Clean recordings matter more than long ones: one voice, no music, no other people, little echo.',
      'Singing teaches a singing voice best. Talking works too, and a mix is fine.',
      'High notes and low notes both help: the voice learns the range it hears.',
      'If the recordings have music in them, turn on These recordings have music in them and the singer is split off first. It costs a little more and is never as clean as a dry voice.',
      'A recording can be a WAV, MP3, M4A, OGG or FLAC file up to 60 megabytes, or you can record here with your microphone.',
    ],
    cost:
      'Learning a voice is GPU time paid by the second: roughly 30 to 90 cents, more for long sets of recordings. The exact estimate is shown before you start. It does not use your credit balance.',
    limits: {
      samples: LIMITS.samples,
      megabytes: LIMITS.sampleBytes / 1024 / 1024,
      minSeconds: LIMITS.minSeconds,
      goodSeconds: LIMITS.goodSeconds,
      extensions: EXTENSIONS,
    },
  };
}

export type VoiceLabHooks = {
  auth: RequestHandler;
  user: (req: Request) => string;
  /** The owner check: may this account make voices at all. */
  allowed: (user: string) => Promise<boolean>;
  /** One uploaded file as multer leaves it (field "clip", memory storage, at most LIMITS.sampleBytes). */
  upload: RequestHandler;
  put: (key: string, body: Buffer, contentType: string) => Promise<void>;
  remove: (keys: string[]) => Promise<void>;
  /** A recording's length in seconds; undefined when it cannot be read as audio. */
  seconds: (body: Buffer) => Promise<number | undefined>;
  /** Said to her once when a voice is ready or did not finish. */
  notify?: (user: string, voice: VoiceLabVoice, ok: boolean) => Promise<void>;
  log?: (line: string) => void;
  /** Test seam: the voice worker. */
  provider?: (path: string, data?: unknown) => Promise<ProviderAnswer>;
};
type TrainOutput = {
  error?: string;
  model_key?: string;
  model_sha256?: string;
  index_key?: string;
  index_sha256?: string;
  range?: MyVoiceRange;
  minutes?: number;
  epochs?: number;
  gpu?: string;
  worker_notes?: string[];
};
type ProviderAnswer = {
  id?: string;
  status?: string;
  output?: TrainOutput | string;
  error?: string;
  executionTime?: number;
};
export type VoiceLab = {
  router: Router;
  /** The account's ready voices, for the Voice choice and the owner check of a job. */
  voices: (user: string) => Promise<MyVoiceChoice[]>;
  advance: () => Promise<void>;
  stop: () => void;
};

async function runpod(path: string, data?: unknown): Promise<ProviderAnswer> {
  const response = await axios.request<ProviderAnswer>({
    url: `https://api.runpod.ai/v2/${process.env.MY_VOICE_ENDPOINT_ID}/${path}`,
    method: data || path.startsWith('cancel/') ? 'POST' : 'GET',
    data,
    headers: { Authorization: `Bearer ${process.env.RUNPOD_API_KEY}` },
    timeout: 30000,
  });
  return response.data;
}

const TRAINING = ['submitting', 'training'];

export function createVoiceLab(hooks: VoiceLabHooks, options: { intervalMs?: number } = {}): VoiceLab {
  const Rows =
    (mongoose.models.KadeBoothVoice as mongoose.Model<Row>) ||
    mongoose.model<Row>('KadeBoothVoice', schema);
  const provider = hooks.provider || runpod;
  const log = hooks.log || (() => undefined);
  const router = express.Router();

  /** Every route: signed in, the lab on, and an account that may make voices. Anyone else sees what a missing page shows. */
  function gate(handler: (req: Request, res: Response, user: string) => Promise<unknown>): RequestHandler {
    return (req, res) =>
      hooks.auth(req, res, () => {
        const user = hooks.user(req);
        void (async () => {
          if (!voiceLabEnabled() || !(await hooks.allowed(user).catch(() => false)))
            return res.status(404).json({ error: 'Not found' });
          return handler(req, res, user);
        })().catch((error: unknown) => {
          log(`[soundbooth/voicelab] ${req.method} ${req.path} failed: ${error instanceof Error ? error.name : 'error'}`);
          if (!res.headersSent) res.status(500).json({ error: 'The voice lab could not do that just now. Nothing was changed.' });
        });
      });
  }
  const refuse = (res: Response, error: string, status = 400) => res.status(status).json({ error });
  async function find(user: string, id: string): Promise<Row | null> {
    if (!VOICE_ID.test(String(id))) return null;
    return Rows.findOne({ id, user, state: { $ne: 'deleted' } }).lean();
  }

  router.get(
    '/voices',
    gate(async (_req, res, user) => {
      const rows = await Rows.find({ user, state: { $ne: 'deleted' } })
        .sort({ createdAt: -1 })
        .lean();
      return res.json({ guide: voiceLabGuide(), voices: rows.map(view) });
    }),
  );

  router.post(
    '/voices',
    express.json({ limit: '16kb' }),
    gate(async (req, res, user) => {
      const body = (req.body || {}) as Record<string, unknown>;
      let name: string;
      try {
        name = checkVoiceName(body.name);
      } catch (error) {
        return refuse(res, (error as Error).message);
      }
      const whose = body.whose === 'other' ? 'other' : body.whose === 'mine' ? 'mine' : null;
      if (!whose) return refuse(res, 'Say whose voice this is: your own, or someone else’s.');
      const person = String(body.person ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
      if (whose === 'other' && body.consent !== true)
        return refuse(res, 'Tick the permission box first. A voice that is not your own needs that person’s permission.');
      if (whose === 'other' && !person)
        return refuse(res, 'Say whose voice this is, such as a first name or how you know them.');
      const existing = await Rows.find({ user, state: { $ne: 'deleted' } })
        .select('name')
        .lean();
      if (existing.length >= LIMITS.voices)
        return refuse(res, `You have ${LIMITS.voices} voices, which is the most the lab keeps. Delete one first.`);
      if (existing.some((r) => r.name.toLowerCase() === name.toLowerCase()))
        return refuse(res, 'You already have a voice with that name. Choose another name.');
      const row = await Rows.create({
        id: `v${randomBytes(8).toString('hex').slice(0, 15)}`,
        user,
        name,
        whose,
        person,
        consent: {
          at: new Date(),
          ticked: whose === 'other',
          note:
            whose === 'other'
              ? `Permission ticked for ${person}. ${String(body.consent_note ?? '').slice(0, 300)}`.trim()
              : 'Her own voice.',
        },
        state: 'collecting',
        samples: [],
        createdAt: new Date(),
      });
      log(`[soundbooth/voicelab] new voice ${row.id} whose=${whose}`);
      return res.status(201).json({ voice: view(row.toObject() as Row) });
    }),
  );

  router.get(
    '/voices/:id',
    gate(async (req, res, user) => {
      let row = await find(user, req.params.id);
      if (!row) return refuse(res, 'That voice is not in your list.', 404);
      if (row.state === 'training') {
        await step(row.id).catch(() => undefined);
        row = (await find(user, req.params.id)) || row;
      }
      return res.json({ voice: view(row) });
    }),
  );

  router.patch(
    '/voices/:id',
    express.json({ limit: '4kb' }),
    gate(async (req, res, user) => {
      const row = await find(user, req.params.id);
      if (!row) return refuse(res, 'That voice is not in your list.', 404);
      let name: string;
      try {
        name = checkVoiceName((req.body || {}).name);
      } catch (error) {
        return refuse(res, (error as Error).message);
      }
      const clash = await Rows.findOne({ user, state: { $ne: 'deleted' }, id: { $ne: row.id }, name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') })
        .select('id')
        .lean();
      if (clash) return refuse(res, 'You already have a voice with that name. Choose another name.');
      await Rows.updateOne({ id: row.id, user }, { $set: { name } });
      return res.json({ voice: view({ ...row, name }) });
    }),
  );

  router.post(
    '/voices/:id/samples',
    (req, res, next) => hooks.auth(req, res, next),
    hooks.upload,
    gate(async (req, res, user) => {
      const row = await find(user, req.params.id);
      if (!row) return refuse(res, 'That voice is not in your list.', 404);
      if (!['collecting', 'failed', 'cancelled', 'uncertain'].includes(row.state))
        return refuse(res, row.state === 'ready' ? 'This voice is already learned. Make a new voice to use more recordings.' : 'This voice is being learned right now. Wait for it to finish.');
      const file = (req as Request & { file?: { buffer?: Buffer; originalname?: string; mimetype?: string } }).file;
      if (!file || !file.buffer || !file.buffer.length) return refuse(res, 'No recording arrived. Choose an audio file and try again.');
      if (file.buffer.length > LIMITS.sampleBytes) return refuse(res, 'That recording is over 60 megabytes. Use a shorter one, or an MP3.');
      if (row.samples.length >= LIMITS.samples) return refuse(res, `A voice takes up to ${LIMITS.samples} recordings. Remove one first.`);
      const original = String(file.originalname || 'recording').slice(0, 120);
      const named = original.toLowerCase().split('.').pop() || '';
      const mime = String(file.mimetype || '').toLowerCase();
      const ext = EXTENSIONS.includes(named)
        ? named
        : mime.includes('webm')
          ? 'webm'
          : mime.includes('ogg')
            ? 'ogg'
            : mime.includes('mp4') || mime.includes('m4a')
              ? 'm4a'
              : mime.includes('mpeg')
                ? 'mp3'
                : mime.includes('wav')
                  ? 'wav'
                  : '';
      if (!ext) return refuse(res, 'That kind of file cannot be used. Use a WAV, MP3, M4A, OGG or FLAC recording.');
      const seconds = await hooks.seconds(file.buffer).catch(() => undefined);
      if (!seconds || seconds < 1) return refuse(res, 'That file could not be read as audio, or it is under a second long.');
      const total = row.samples.reduce((sum, s) => sum + (s.seconds || 0), 0);
      if (total + seconds > LIMITS.totalSeconds)
        return refuse(res, 'That would be over 90 minutes of recordings, which is more than a voice can use. Leave this one out.');
      const key = `voice-samples/${user}/${row.id}/${Date.now().toString(36)}${randomBytes(3).toString('hex')}.${ext}`;
      await hooks.put(key, file.buffer, TYPES[ext]);
      const sample: Sample = { key, name: original.replace(/[<>"`\\]/g, ''), seconds, bytes: file.buffer.length };
      /* The state filter is the guard against a training started in the same moment: the recording is then removed again. */
      const saved = await Rows.findOneAndUpdate(
        { id: row.id, user, state: row.state, [`samples.${LIMITS.samples - 1}`]: { $exists: false } },
        { $push: { samples: sample }, $set: { state: 'collecting' }, $unset: { error: 1, progress: 1 } },
        { new: true },
      ).lean();
      if (!saved) {
        await hooks.remove([key]).catch(() => undefined);
        return refuse(res, 'The voice changed while that recording was arriving. Try adding it again.', 409);
      }
      return res.status(201).json({ voice: view(saved), added: `${sample.name}, ${sayLength(seconds)}.` });
    }),
  );

  router.delete(
    '/voices/:id/samples/:n',
    gate(async (req, res, user) => {
      const row = await find(user, req.params.id);
      if (!row) return refuse(res, 'That voice is not in your list.', 404);
      if (TRAINING.includes(row.state)) return refuse(res, 'This voice is being learned right now. Wait for it to finish.');
      const sample = row.samples[Number(req.params.n)];
      if (!sample) return refuse(res, 'That recording is not on this voice any more.', 404);
      const saved = await Rows.findOneAndUpdate(
        { id: row.id, user, state: row.state },
        { $pull: { samples: { key: sample.key } } },
        { new: true },
      ).lean();
      if (saved) await hooks.remove([sample.key]).catch(() => undefined);
      return res.json({ voice: view(saved || row), removed: sample.name });
    }),
  );

  router.post(
    '/voices/:id/train',
    express.json({ limit: '4kb' }),
    gate(async (req, res, user) => {
      const row = await find(user, req.params.id);
      if (!row) return refuse(res, 'That voice is not in your list.', 404);
      if (!['collecting', 'failed', 'cancelled', 'uncertain'].includes(row.state))
        return refuse(res, row.state === 'ready' ? 'This voice is already learned.' : 'This voice is already being learned.');
      const seconds = row.samples.reduce((sum, s) => sum + (s.seconds || 0), 0);
      if (seconds < LIMITS.minSeconds) return refuse(res, estimate(seconds, false));
      if (row.whose === 'other' && !row.consent?.ticked)
        return refuse(res, 'This voice has no permission on record. Make it again and tick the permission box.');
      const busy = await Rows.findOne({ user, state: { $in: TRAINING } })
        .select('name')
        .lean();
      if (busy) return refuse(res, `${busy.name} is being learned right now. One voice at a time; start this one when it is done.`, 409);
      const body = (req.body || {}) as Record<string, unknown>;
      const denoise = typeof body.denoise === 'number' && body.denoise >= 0 && body.denoise <= 1 ? body.denoise : 0;
      const chosen = { isolate: body.isolate === true, denoise, epochs: 'auto' as const };
      const lease = new Date(Date.now() + 300000);
      const claimed = await Rows.findOneAndUpdate(
        { id: row.id, user, state: row.state },
        { $set: { state: 'submitting', options: chosen, startedAt: new Date(), leaseUntil: lease, progress: '' }, $unset: { error: 1, providerId: 1 } },
        { new: true },
      ).lean();
      if (!claimed) return refuse(res, 'The voice changed just now. Try again.', 409);
      try {
        const answer = await provider('run', {
          input: {
            mode: 'train',
            owner: user,
            voice_id: row.id,
            sample_keys: row.samples.map((s) => s.key),
            options: { epochs: 'auto', isolate: chosen.isolate, denoise: chosen.denoise, dereverb: false },
          },
          policy: POLICY,
        });
        if (!answer.id) throw new Error('Missing job id');
        await Rows.updateOne({ id: row.id }, { $set: { state: 'training', providerId: answer.id }, $unset: { leaseUntil: 1 } });
        log(`[soundbooth/voicelab] training ${row.id} samples=${row.samples.length} seconds=${Math.round(seconds)}`);
        return res.json({ voice: view({ ...claimed, state: 'training' }), started: `Learning ${row.name} has started. ${estimate(seconds, chosen.isolate)} You can leave this page; you will be told when it is ready.` });
      } catch {
        await Rows.updateOne(
          { id: row.id },
          { $set: { state: 'uncertain', error: 'Could not confirm that learning started. No automatic paid retry was made.' }, $unset: { leaseUntil: 1 } },
        );
        return refuse(res, 'Could not confirm that learning started. Nothing was retried. Check the voice in a few minutes.', 502);
      }
    }),
  );

  router.post(
    '/voices/:id/cancel',
    gate(async (req, res, user) => {
      const row = await find(user, req.params.id);
      if (!row) return refuse(res, 'That voice is not in your list.', 404);
      if (row.state !== 'training' || !row.providerId) return refuse(res, 'This voice is not being learned right now.');
      await provider(`cancel/${encodeURIComponent(row.providerId)}`).catch(() => undefined);
      await Rows.updateOne({ id: row.id, state: 'training' }, { $set: { state: 'cancelled', finishedAt: new Date() } });
      return res.json({ voice: view({ ...row, state: 'cancelled' }), stopped: 'Learning was stopped. GPU time already used is still billed. The recordings are kept.' });
    }),
  );

  router.delete(
    '/voices/:id',
    gate(async (req, res, user) => {
      const row = await find(user, req.params.id);
      if (!row) return refuse(res, 'That voice is not in your list.', 404);
      if (TRAINING.includes(row.state)) return refuse(res, 'This voice is being learned right now. Stop it first, then delete it.');
      const keys = row.samples.map((s) => s.key);
      for (const key of [row.model_key, row.index_key]) if (key) keys.push(key);
      await hooks.remove(keys).catch(() => undefined);
      /* The row stays, emptied, as the record of whose voice was made, when, and on what permission. */
      await Rows.updateOne(
        { id: row.id, user },
        { $set: { state: 'deleted', samples: [], finishedAt: new Date() }, $unset: { model_key: 1, model_sha256: 1, index_key: 1, index_sha256: 1, range: 1 } },
      );
      log(`[soundbooth/voicelab] deleted voice ${row.id}`);
      return res.json({ deleted: `${row.name} was deleted, with its recordings and its voice model.` });
    }),
  );

  /* ---------- a training run, walked to its end -------------------------------- */

  async function finish(row: Row, ok: boolean): Promise<void> {
    if (!hooks.notify) return;
    const fresh = await Rows.findOne({ id: row.id }).lean();
    if (fresh) await hooks.notify(row.user, view(fresh), ok).catch(() => undefined);
  }
  async function step(id: string): Promise<void> {
    const lease = new Date(Date.now() + 120000);
    const row = await Rows.findOneAndUpdate(
      { id, state: { $in: TRAINING }, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: new Date() } }] },
      { $set: { leaseUntil: lease } },
      { new: true },
    ).lean();
    if (!row) return;
    try {
      if (row.state === 'submitting') {
        /* A crash between claiming the voice and hearing back from the worker: never guess, never send it again. */
        await Rows.updateOne({ id }, { $set: { state: 'uncertain', error: 'Could not confirm that learning started. No automatic paid retry was made.' } });
        return;
      }
      const answer = await provider(`status/${encodeURIComponent(row.providerId || '')}`);
      const output = answer.output && typeof answer.output === 'object' ? answer.output : undefined;
      const costUSD = ((answer.executionTime || 0) / 1000) * USD_PER_SECOND;
      if (answer.status === 'COMPLETED' && output && !output.error && output.model_key) {
        /* The worker's keys are checked as any registry entry is: they must sit in this account's folder, and in this voice's. */
        const model = checkMyVoiceModel(row.user, output, 'table');
        const home = `voice-models/${row.user}/${row.id}/`;
        if (!model || !model.model_key.startsWith(home) || (model.index_key && !model.index_key.startsWith(home))) {
          await Rows.updateOne({ id }, { $set: { state: 'failed', error: 'The voice worker answered with a file that does not belong to this voice, so it was not used.', costUSD, finishedAt: new Date() } });
          await finish(row, false);
          return;
        }
        await Rows.updateOne(
          { id },
          {
            $set: {
              state: 'ready',
              model_key: model.model_key,
              model_sha256: model.model_sha256,
              index_key: model.index_key,
              index_sha256: model.index_sha256,
              range: model.range,
              minutes: typeof output.minutes === 'number' ? Math.round(output.minutes * 10) / 10 : undefined,
              epochs: output.epochs,
              costUSD,
              finishedAt: new Date(),
              samples: [],
            },
            $unset: { error: 1, progress: 1 },
          },
        );
        /* The recordings have done their work: they are not kept. */
        await hooks.remove(row.samples.map((s) => s.key)).catch(() => undefined);
        log(`[soundbooth/voicelab] ready ${id} cost=${costUSD.toFixed(3)}`);
        await finish(row, true);
      } else if (['FAILED', 'CANCELLED', 'TIMED_OUT', 'COMPLETED'].includes(answer.status || '')) {
        const sentence =
          (output && typeof output.error === 'string' && output.error) ||
          (answer.status === 'TIMED_OUT' ? 'Learning took longer than two hours and was stopped.' : 'The voice worker did not finish.');
        await Rows.updateOne(
          { id },
          { $set: { state: answer.status === 'CANCELLED' ? 'cancelled' : 'failed', error: `${sentence} The recordings are kept, so you can try again.`.slice(0, 600), costUSD, finishedAt: new Date() } },
        );
        log(`[soundbooth/voicelab] ${answer.status} ${id}`);
        await finish(row, false);
      } else {
        const progress = typeof answer.output === 'string' ? answer.output.slice(0, 160) : answer.status === 'IN_QUEUE' ? 'Waiting for the voice worker to wake up' : row.progress || '';
        if (progress !== row.progress) await Rows.updateOne({ id }, { $set: { progress } });
      }
    } finally {
      await Rows.updateOne({ id, leaseUntil: lease }, { $unset: { leaseUntil: 1 } });
    }
  }

  let polling = false;
  async function advance(): Promise<void> {
    if (polling || mongoose.connection.readyState !== 1 || !voiceLabEnabled()) return;
    polling = true;
    try {
      const rows = await Rows.find({ state: { $in: TRAINING } })
        .select('id')
        .lean();
      for (const row of rows) await step(row.id).catch(() => undefined);
    } catch {
      /* the database is away; the rows are durable and the next pass picks them up */
    } finally {
      polling = false;
    }
  }
  const timer = setInterval(() => void advance(), options.intervalMs || 30000);
  timer.unref();

  async function voices(user: string): Promise<MyVoiceChoice[]> {
    if (!voiceLabEnabled() || !user || mongoose.connection.readyState !== 1) return [];
    const rows = await Rows.find({ user, state: 'ready' }).sort({ createdAt: 1 }).lean();
    const out: MyVoiceChoice[] = [];
    for (const row of rows) {
      const model = checkMyVoiceModel(user, row, 'table');
      if (model) out.push({ id: row.id, name: row.name, model });
    }
    return out;
  }

  return { router, voices, advance, stop: () => clearInterval(timer) };
}
