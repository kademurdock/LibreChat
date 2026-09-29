import { familyAudioBase, familyAudioExtension, familyFixWav, familyWavInfo } from './story';

/* ----------------------------------------------------------------------------
 * FAMILY HISTORY LISTEN (docs/FAMILY_HISTORY.md, "Stories and Listen")
 *
 * A story is read aloud part by part in the Library's voice. Each part is
 * voiced once, the first time anyone asks for it, and kept in the private
 * bucket under <prefix>/audio/<story hash>/<part hash> (the hashes cover the
 * words and the voice, never a title); after that it is only ever signed.
 * Two parts are voiced at a time at most, and a part being voiced is never
 * asked for twice.
 * THE REPOSITORY IS PUBLIC: no family data belongs here.
 * -------------------------------------------------------------------------- */

export interface FamilyAudioNote {
  /** The audio's file ending: "wav", "mp3"... */
  ext: string;
  mime: string;
  /** Seconds. */
  duration: number;
  bytes: number;
  chars: number;
  made: string;
}

export interface FamilyVoiceDeps {
  /** Voices a part's words: the platform's Inworld path, as the Library reader uses it. */
  speak: (
    text: string,
    options: { session: string; userId: string },
  ) => Promise<{ audio: Buffer; mime: string }>;
  /** Names the voice and its direction, so a new voice makes new audio. */
  voiceTag: () => string;
  putObject: (key: string, body: Buffer, mime: string) => Promise<void>;
  loadObject: (key: string) => Promise<Buffer | null>;
  now: () => number;
}

export interface FamilyListener {
  /** The part's audio, voiced now when it does not exist yet. */
  ensure: (
    prefix: string,
    storyHash: string,
    text: string,
    userId: string,
  ) => Promise<FamilyAudioNote & { key: string }>;
  /** True when this server already knows the part's audio exists. */
  known: (prefix: string, storyHash: string, text: string) => boolean;
}

/** Characters a second, for a length when the voice's file cannot say it. */
export const FAMILY_LISTEN_CHARS_PER_SECOND: number = 14;
export const FAMILY_LISTEN_AT_ONCE: number = 2;
const NOTE_CACHE_LIMIT = 5000;

export function familyListener(deps: FamilyVoiceDeps): FamilyListener {
  const notes = new Map<string, FamilyAudioNote>();
  const making = new Map<string, Promise<FamilyAudioNote>>();
  let running = 0;
  const waiting: (() => void)[] = [];

  const remember = (base: string, note: FamilyAudioNote): void => {
    notes.set(base, note);
    if (notes.size > NOTE_CACHE_LIMIT) {
      const oldest = notes.keys().next().value;
      if (oldest !== undefined) notes.delete(oldest);
    }
  };

  const slot = async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= FAMILY_LISTEN_AT_ONCE) await new Promise<void>((go) => waiting.push(go));
    running++;
    try {
      return await work();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };

  const stored = async (base: string): Promise<FamilyAudioNote | null> => {
    const cached = notes.get(base);
    if (cached) return cached;
    const raw = await deps.loadObject(`${base}.json`);
    if (!raw) return null;
    try {
      const note = JSON.parse(raw.toString('utf8')) as FamilyAudioNote;
      if (!note || typeof note.ext !== 'string' || !/^[a-z0-9]{2,4}$/.test(note.ext)) return null;
      remember(base, note);
      return note;
    } catch {
      return null;
    }
  };

  const voice = async (
    base: string,
    storyHash: string,
    text: string,
    userId: string,
  ): Promise<FamilyAudioNote> => {
    const again = await stored(base);
    if (again) return again;
    const spoken = await deps.speak(text, { session: `family:${storyHash}`, userId });
    if (!spoken || !Buffer.isBuffer(spoken.audio) || spoken.audio.length < 64)
      throw new Error('the voice sent no audio');
    const info = familyWavInfo(spoken.audio);
    const audio = info ? familyFixWav(spoken.audio) : spoken.audio;
    const mime = info ? 'audio/wav' : spoken.mime || 'application/octet-stream';
    const ext = info ? 'wav' : familyAudioExtension(mime);
    const duration = info
      ? info.duration
      : Math.round((text.length / FAMILY_LISTEN_CHARS_PER_SECOND) * 1000) / 1000;
    await deps.putObject(`${base}.${ext}`, audio, mime);
    const note: FamilyAudioNote = {
      ext,
      mime,
      duration,
      bytes: audio.length,
      chars: text.length,
      made: new Date(deps.now()).toISOString(),
    };
    await deps.putObject(`${base}.json`, Buffer.from(JSON.stringify(note)), 'application/json');
    remember(base, note);
    return note;
  };

  return {
    ensure: async (prefix, storyHash, text, userId) => {
      const base = familyAudioBase(prefix, storyHash, deps.voiceTag(), text);
      const have = await stored(base);
      if (have) return { ...have, key: `${base}.${have.ext}` };
      let job = making.get(base);
      if (!job) {
        job = slot(() => voice(base, storyHash, text, userId)).finally(() => making.delete(base));
        making.set(base, job);
      }
      const note = await job;
      return { ...note, key: `${base}.${note.ext}` };
    },
    known: (prefix, storyHash, text) =>
      notes.has(familyAudioBase(prefix, storyHash, deps.voiceTag(), text)),
  };
}
