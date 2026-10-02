'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * kadeSoundBoothSeedClips.js — a reference clip Seed Audio will take.
 *
 * Oct 2 2026: her Seed Audio renders had stopped coming through at all. Her
 * voice clip was 32.6 seconds. fal's Seed Audio
 * takes reference clips of up to 30 seconds, 10 MB, as WAV, MP3, PCM or Ogg
 * Opus (its schema, audio_urls), and answered 422 to all three renders. The
 * Dockerfile has carried ffmpeg "to auto-trim Seed Audio voice-clone reference
 * clips" since July, but only the chat tool (FalAI.js) ever trimmed; the Sound
 * Booth sent every clip as it was.
 *
 * Now every clip in her own storage is checked before fal sees it. A clip the
 * reference list already knows is short enough, stored as an MP3 or as a WAV
 * of a size fal takes, is sent without fetching it. A clip longer than 29.5
 * seconds is cut, at a pause near the end if there is one, with a short fade,
 * into a 48 kHz mono WAV (the same shape a Seed import is stored in). A clip of
 * 31 seconds or less is only a little over, so a pause counts only in its last
 * 3 seconds; one earlier would throw away more than the cut needs. A file
 * too big, or in a format fal cannot read, is converted the same way. The copy
 * is stored beside the original as <name>-seed.wav and registered with its
 * length, so the next render finds it and does not cut again. The original is
 * never changed, and the project keeps it. The answer says what happened, in
 * a sentence she can hear; a render that uses a copy made earlier says so in
 * a short line.
 *
 * Fails open: anything that goes wrong here, or a check still running after
 * 25 seconds, sends the clip as it was, and the provider's answer
 * (kadeSoundBoothErrors.js) says why in plain words. ffmpeg runs through
 * execFile, never a shell.
 * ───────────────────────────────────────────────────────────────────────── */

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/** fal's own limit, read Oct 2 2026: "Each clip: up to 30s, 10MB, wav/mp3/pcm/ogg_opus." */
const SEED_CLIP_LIMIT_SECONDS = 30;
/** Where a long clip is cut: half a second under the limit, so a decoder that measures a little long still passes. */
const SEED_CLIP_TARGET_SECONDS = 29.5;
/** A cut at a pause keeps at least this much of the clip. */
const SEED_CLIP_EARLIEST_CUT = 20;
/** A clip this long or shorter is only a little over: a pause counts only in its last few seconds. */
const SEED_CLIP_NEAR_SECONDS = 31;
/** How far back from the end of a clip that is only a little over a pause may be. */
const SEED_CLIP_NEAR_PAUSE_SECONDS = 3;
const SEED_CLIP_MAX_BYTES = 10 * 1000 * 1000;
/** Re-encode a little under the limit; fal may count a megabyte either way. */
const SEED_CLIP_SAFE_BYTES = 9.5 * 1000 * 1000;
const SEED_FORMATS = new Set(['wav', 'mp3', 'ogg_opus']);
const SILENCE_FILTER = 'silencedetect=noise=-35dB:d=0.25';
/**
 * All the clips of one render get this long to be checked. fal then has up to
 * 180 seconds, and the phone waits 240 for the whole render, so a stalled
 * download must not eat the difference. Past it, a clip goes as it is.
 */
const SEED_PREP_DEADLINE_MS = 25000;

function run(args, { timeout = 60000, bin = FFMPEG } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '').slice(-1500);
        return reject(err);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** What a clip really is, from its first bytes (a file name or a mime type can say anything). */
function sniffFormat(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const head = buffer.toString('latin1', 0, Math.min(buffer.length, 80));
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE') return 'wav';
  if (head.startsWith('OggS')) return head.includes('OpusHead') ? 'ogg_opus' : 'ogg';
  if (head.startsWith('fLaC')) return 'flac';
  if (head.slice(4, 8) === 'ftyp') return 'm4a';
  if (head.startsWith('ID3')) return 'mp3';
  /* An MPEG audio frame: 11 sync bits, then layer bits 01 (Layer III). ADTS AAC has layer 00. */
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0 && (buffer[1] & 0x06) === 0x02) return 'mp3';
  return null;
}

/**
 * What to do with one clip. `fit` makes a new copy; `cut` says whether that
 * copy is also shortened. A clip whose length could not be read is sent as it
 * is: ffmpeg could not read it either, and fal's answer will say why.
 * @param {{ seconds?: number|null, bytes?: number, format?: string|null }} clip
 */
function seedClipPlan({ seconds, bytes, format }) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return { action: 'keep', cut: false, why: ['length unknown'] };
  }
  const long = seconds > SEED_CLIP_TARGET_SECONDS;
  const big = Number(bytes) > SEED_CLIP_SAFE_BYTES;
  const unreadable = !SEED_FORMATS.has(format);
  if (!long && !big && !unreadable) return { action: 'keep', cut: false, why: [] };
  return {
    action: 'fit',
    cut: long,
    why: [long && 'long', big && 'big', unreadable && 'format'].filter(Boolean),
  };
}

/** ffmpeg silencedetect's report, as [{ start, end }] (end null when the quiet runs past what was read). */
function parseSilences(stderr) {
  const out = [];
  let open = null;
  for (const line of String(stderr || '').split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
    if (start) {
      open = { start: Math.max(0, Number(start[1])), end: null };
      out.push(open);
      continue;
    }
    const end = line.match(/silence_end:\s*(\d+(?:\.\d+)?)/);
    if (end && open) {
      open.end = Number(end[1]);
      open = null;
    }
  }
  return out;
}

/**
 * Where to cut: the latest pause that starts after `earliest` seconds and
 * before the limit, a little way into the quiet; otherwise at the limit.
 * A cut at a pause always lands at least a tenth of a second under the limit,
 * so its length alone says it was one.
 */
function chooseCut(silences, { limit = SEED_CLIP_TARGET_SECONDS, earliest = SEED_CLIP_EARLIEST_CUT, tail = 0.4 } = {}) {
  let best = null;
  for (const s of silences || []) {
    if (!s || !Number.isFinite(s.start) || s.start < earliest || s.start >= limit - 0.15) continue;
    const end = Number.isFinite(s.end) && s.end > s.start ? s.end : limit;
    const at = Math.min(s.start + Math.min(tail, (end - s.start) / 2), limit - 0.1);
    if (at > s.start && (!best || at > best.at)) best = { at: Math.round(at * 100) / 100, pause: true };
  }
  return best || { at: limit, pause: false };
}

/**
 * The earliest a cut at a pause may be, for a clip of `seconds`. A clip of 31
 * seconds or less needs only a little taken off, so a pause counts only in its
 * last 3 seconds (never before 20); otherwise it is cut at 29.5. A longer clip,
 * or one whose length is not known, keeps the 20-second floor.
 */
function earliestCut(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > SEED_CLIP_NEAR_SECONDS) {
    return SEED_CLIP_EARLIEST_CUT;
  }
  return Math.max(SEED_CLIP_EARLIEST_CUT, Math.round((seconds - SEED_CLIP_NEAR_PAUSE_SECONDS) * 100) / 100);
}

function silenceArgs(inFile, limit = SEED_CLIP_TARGET_SECONDS) {
  return ['-nostdin', '-hide_banner', '-nostats', '-t', String(limit), '-i', inFile, '-vn', '-af', SILENCE_FILTER, '-f', 'null', '-'];
}

/** The copy: 48 kHz mono 16-bit WAV, and when `at` is set, cut there with a fade. */
function fitArgs(inFile, outFile, { at = null, fade = 0.3 } = {}) {
  const cut = typeof at === 'number' && at > 0
    ? ['-t', at.toFixed(2), '-af', `afade=t=out:st=${Math.max(0, at - fade).toFixed(2)}:d=${fade}`]
    : [];
  return ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', inFile, '-vn', ...cut, '-ac', '1', '-ar', '48000', '-sample_fmt', 's16', outFile];
}

/**
 * Make the copy Seed Audio will take. `cut: false` only converts. `seconds`,
 * the clip's own length when it is known, sets how early a pause may be
 * (earliestCut).
 * @param {Buffer} buffer
 * @param {{ format?: string|null, cut?: boolean, seconds?: number|null }} [options]
 * @returns {Promise<{ buffer: Buffer, seconds: number|null, at: number|null, pause: boolean }>}
 */
async function fitSeedClip(buffer, { format = null, cut = true, seconds: clipSeconds = null } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-seed-'));
  try {
    const inFile = path.join(dir, `in.${String(format || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin'}`);
    const outFile = path.join(dir, 'seed.wav');
    await fs.writeFile(inFile, buffer);
    let choice = { at: null, pause: false };
    if (cut) {
      let silences = [];
      try {
        silences = parseSilences((await run(silenceArgs(inFile), { timeout: 60000 })).stderr);
      } catch (_) {
        /* no pause found is the same as no pause: cut at the limit */
      }
      choice = chooseCut(silences, { earliest: earliestCut(clipSeconds) });
    }
    await run(fitArgs(inFile, outFile, { at: choice.at, fade: choice.pause ? 0.3 : 0.5 }), { timeout: 120000 });
    const out = await fs.readFile(outFile);
    if (out.length < 1000) throw new Error('ffmpeg made an empty clip');
    let seconds = null;
    try {
      const { stdout } = await run(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', outFile], { timeout: 30000, bin: FFPROBE });
      const n = parseFloat(String(stdout).trim());
      if (Number.isFinite(n) && n > 0) seconds = Math.round(n * 100) / 100;
    } catch (_) {
      seconds = choice.at;
    }
    return { buffer: out, seconds, at: choice.at, pause: choice.pause };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ---------- the words, read aloud ---------------------------------------- */

/** 29.5 -> "29 and a half", 28.04 -> "28". */
function sayHalf(n) {
  const half = Math.round(Number(n) * 2) / 2;
  const whole = Math.floor(half);
  return half === whole ? String(whole) : `${whole} and a half`;
}

/** A length she is told her clip had: whole seconds, unless that would round onto the limit. */
function sayLength(n) {
  return n < 31 ? String(Math.round(n * 10) / 10) : String(Math.round(n));
}

/**
 * A clip of 29.5 to 30 seconds is cut too, to leave room for a decoder that
 * measures a little long. Said as its length ("was 29.8 seconds. Seed Audio
 * takes up to 30") that sounds like a cut for no reason, so it is said as
 * being right at the limit. Rounded as sayLength rounds, so 30.04 is here too.
 */
function atLimit(was) {
  return typeof was === 'number' && was > 0 && Math.round(was * 10) / 10 <= SEED_CLIP_LIMIT_SECONDS;
}

/** "Your clip was 33 seconds. Seed Audio takes up to 30, so the first 29 and a half seconds were used." */
function sayTrimmed(label, was, used, pause) {
  const kept = typeof used === 'number' && used > 0 ? sayHalf(used) : sayHalf(SEED_CLIP_TARGET_SECONDS);
  const ending = pause ? ', ending at a pause' : '';
  if (atLimit(was)) return `${label} was right at Seed Audio's 30-second limit, so to be safe the first ${kept} seconds were used${ending}.`;
  const length = typeof was === 'number' && was > 0 ? `was ${sayLength(was)} seconds` : 'was longer than 30 seconds';
  return `${label} ${length}. Seed Audio takes up to 30, so the first ${kept} seconds were used${ending}.`;
}

/**
 * Said when a render uses a cut copy made for an earlier render. She heard the
 * whole sentence the first time, so this is short:
 * "Using the 28 and a half second cut of your clip."
 */
function sayReused(label, seconds) {
  const kept = typeof seconds === 'number' && seconds > 0 ? sayHalf(seconds) : sayHalf(SEED_CLIP_TARGET_SECONDS);
  return `Using the ${kept} second cut of ${String(label).toLowerCase()}.`;
}

function sayConverted(label, why) {
  const big = why.includes('big');
  const format = why.includes('format');
  if (big && format) return `${label} was too big and in a format Seed Audio cannot read, so a smaller WAV copy was sent.`;
  if (big) return `${label} was too big a file for Seed Audio, so a smaller copy was sent.`;
  return `${label} was in a format Seed Audio cannot read, so a WAV copy was sent.`;
}

/** Said when a Seed import is cut on the way in, so Play plays what Seed will hear. */
function sayImportTrim(was, fitted, { capped = false } = {}) {
  const edge = !capped && atLimit(was);
  let length = `Yours was ${sayLength(was)}`;
  if (capped) length = 'Yours was longer than 45 seconds';
  else if (edge) length = 'Yours was right at that limit';
  return `Seed Audio takes clips up to 30 seconds. ${length}, so ${edge ? 'to be safe ' : ''}the first ${sayHalf(fitted.seconds || fitted.at || SEED_CLIP_TARGET_SECONDS)} seconds were kept${fitted.pause ? ', ending at a pause' : ''}.`;
}

/** Said when a long Seed import could not be cut on the way in; the render cuts it instead. */
function sayImportLong(was) {
  const kept = sayHalf(SEED_CLIP_TARGET_SECONDS);
  if (atLimit(was)) return `Seed Audio takes clips up to 30 seconds. This one is right at that limit, so to be safe, when you render, the first ${kept} seconds are used.`;
  return `Seed Audio takes clips up to 30 seconds. This one is ${sayLength(was)}, so when you render, the first ${kept} seconds are used.`;
}

/* ---------- which clips are hers, and where the copy goes --------------- */

/** "soundbooth-ref-x.wav" -> "soundbooth-ref-x-seed.wav"; a copy keeps its own name. */
function seedCopyName(fileName) {
  const stem = String(fileName || '').replace(/\.[a-z0-9]{1,5}$/i, '');
  return /-seed$/i.test(stem) ? `${stem}.wav` : `${stem}-seed.wav`;
}

/**
 * A clip this booth may open: in our own storage (re-signing it gives back the
 * same address) and in this person's own audio folder. Anything else is sent
 * to fal untouched, so no address a person types is ever fetched by the server.
 * @returns {{ file: string } | null}
 */
function ownClip(url, fresh, userId) {
  try {
    const a = new URL(url);
    const b = new URL(fresh);
    if (a.protocol !== 'https:' || a.origin !== b.origin || a.pathname !== b.pathname) return null;
    const seg = a.pathname.split('/');
    if (seg[seg.length - 2] !== String(userId) || seg[seg.length - 3] !== 'audios') return null;
    const file = decodeURIComponent(seg[seg.length - 1] || '');
    return /^[A-Za-z0-9._-]{1,200}$/.test(file) ? { file } : null;
  } catch (_) {
    return null;
  }
}

/** The end of a stored clip's name, lower case: "wav" for "soundbooth-ref-x.wav". */
function fileExtension(fileName) {
  const m = String(fileName || '').match(/\.([a-z0-9]{1,5})$/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * The render's half. Every dependency is passed in, so the whole path is
 * tested without storage, a database or the network.
 * @param {{
 *   resign: (url: string, key?: string) => Promise<string|undefined>,
 *   seconds: (userId: string, url: string) => Promise<number|undefined>,
 *   peek?: (url: string) => Promise<{ head: Buffer, bytes: number|null }>,
 *   download: (url: string) => Promise<Buffer>,
 *   measure: (buffer: Buffer) => Promise<number|null>,
 *   fit: (buffer: Buffer, options: { format: string|null, cut: boolean, seconds: number }) => Promise<{ buffer: Buffer, seconds: number|null, at: number|null, pause: boolean }>,
 *   save: (userId: string, buffer: Buffer, fileName: string) => Promise<string>,
 *   register: (userId: string, url: string, seconds: number|null) => Promise<void>,
 *   logger?: { info: Function, warn: Function },
 *   deadlineMs?: number,
 * }} deps
 */
function createSeedClipPreparer(deps) {
  const log = deps.logger || { info() {}, warn() {} };
  const deadlineMs = Number.isFinite(deps.deadlineMs) && deps.deadlineMs > 0 ? deps.deadlineMs : SEED_PREP_DEADLINE_MS;
  const quietly = async (work) => {
    try {
      return await work();
    } catch (_) {
      return undefined;
    }
  };
  const LATE = Symbol('late');
  /** The work's answer, or LATE when `ms` runs out first. The work itself carries on. */
  const within = (promise, ms) => {
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(LATE), Math.max(0, ms));
    });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
  };

  async function one(userId, url, label, seen) {
    const fresh = await quietly(() => deps.resign(url));
    const own = fresh ? ownClip(url, fresh, userId) : null;
    if (!own) return { url };
    seen.fresh = fresh;
    /* Every import records its length, so most clips are known without fetching them. */
    const was = await quietly(() => deps.seconds(userId, url));
    if (typeof was === 'number' && was > 0 && was <= SEED_CLIP_TARGET_SECONDS) {
      const ext = fileExtension(own.file);
      /* An MP3 of under 30 seconds is always far under 10 MB. */
      if (ext === 'mp3') return { url: fresh };
      /* A WAV kept as it was imported can be large (29 seconds of 96 kHz, 24-bit stereo is
       * 17 MB), so its first bytes and its size are read, not the whole file. */
      if (ext === 'wav' && typeof deps.peek === 'function') {
        const peek = await quietly(() => deps.peek(fresh));
        const bytes = peek ? Number(peek.bytes) : NaN;
        if (peek && sniffFormat(peek.head) === 'wav' && bytes > 0 && bytes <= SEED_CLIP_SAFE_BYTES) return { url: fresh };
      }
    }
    const copy = seedCopyName(own.file);
    if (copy !== own.file) {
      /* A copy made for an earlier render is used again, without fetching or cutting anything. */
      const copyUrl = await quietly(() => deps.resign(url, `audios/${userId}/${copy}`));
      const copySeconds = copyUrl ? await quietly(() => deps.seconds(userId, copyUrl)) : undefined;
      if (copyUrl && typeof copySeconds === 'number' && copySeconds > 0 && copySeconds <= SEED_CLIP_TARGET_SECONDS + 0.05) {
        const cut = typeof was !== 'number' || was > SEED_CLIP_TARGET_SECONDS;
        return {
          url: copyUrl,
          fitted: true,
          note: cut ? sayReused(label, copySeconds) : null,
          log: `${own.file} -> ${copy} (kept from an earlier render, ${copySeconds}s)`,
        };
      }
    }
    let buffer;
    try {
      buffer = await deps.download(fresh);
    } catch (e) {
      log.warn(`[soundbooth/seed-clip] could not fetch ${own.file} to check it (sending it as it is): ${e && e.message}`);
      return { url: fresh };
    }
    const format = sniffFormat(buffer);
    const seconds = await quietly(() => deps.measure(buffer));
    const plan = seedClipPlan({ seconds, bytes: buffer.length, format });
    if (plan.action === 'keep') {
      if (plan.why.length) log.warn(`[soundbooth/seed-clip] ${own.file}: ${plan.why.join(', ')} (${buffer.length}B, ${format || 'unknown format'}); sending it as it is`);
      return { url: fresh };
    }
    let fitted;
    try {
      fitted = await deps.fit(buffer, { format, cut: plan.cut, seconds });
    } catch (e) {
      log.warn(`[soundbooth/seed-clip] could not fit ${own.file} (${plan.why.join(', ')}; sending it as it is): ${e && e.message} ${String((e && e.stderr) || '').slice(-200)}`);
      return { url: fresh };
    }
    let saved;
    try {
      saved = await deps.save(userId, fitted.buffer, copy);
    } catch (e) {
      log.warn(`[soundbooth/seed-clip] could not store the copy of ${own.file} (sending it as it is): ${e && e.message}`);
      return { url: fresh };
    }
    if (!saved) return { url: fresh };
    await quietly(() => deps.register(userId, saved, fitted.seconds));
    /* The original's length too, so a later render can say how long it was without fetching it. */
    await quietly(() => deps.register(userId, fresh, seconds));
    return {
      url: saved,
      fitted: true,
      note: plan.cut ? sayTrimmed(label, seconds, fitted.seconds || fitted.at, fitted.pause) : sayConverted(label, plan.why),
      log: `${own.file} ${seconds}s ${buffer.length}B ${format || 'unknown'} -> ${copy} ${fitted.seconds}s ${fitted.buffer.length}B (${plan.why.join(', ')}${fitted.pause ? ', cut at a pause' : ''})`,
    };
  }

  /**
   * @param {string} userId
   * @param {string[]} urls up to three, in @Audio order
   * @returns {Promise<{ urls: string[], notes: string[], fitted: number, logs: string[] }>}
   */
  return async function prepareSeedClips(userId, urls) {
    const list = Array.isArray(urls) ? urls : [];
    const out = { urls: [], notes: [], fitted: 0, logs: [] };
    const started = Date.now();
    for (let i = 0; i < list.length; i++) {
      const label = list.length === 1 ? 'Your clip' : `Clip ${i + 1}`;
      const seen = { fresh: null };
      const left = deadlineMs - (Date.now() - started);
      let r = LATE;
      if (left > 0) {
        const work = one(String(userId), list[i], label, seen).catch((e) => {
          log.warn(`[soundbooth/seed-clip] check failed (sending the clip as it is): ${e && e.message}`);
          return { url: seen.fresh || list[i] };
        });
        r = await within(work, left);
      }
      if (r === LATE) {
        /* Fails open on time as it does on errors. A copy the unfinished check goes on to
         * store is still registered, so the next render uses it. */
        log.warn(`[soundbooth/seed-clip] ${label.toLowerCase()} not checked within ${deadlineMs} ms; sending it as it is`);
        if (!seen.fresh) {
          const fresh = await within(quietly(() => deps.resign(list[i])), 2000);
          if (typeof fresh === 'string' && ownClip(list[i], fresh, String(userId))) seen.fresh = fresh;
        }
        r = { url: seen.fresh || list[i] };
      }
      out.urls.push(r.url || list[i]);
      if (r.note) out.notes.push(r.note);
      if (r.fitted) out.fitted += 1;
      if (r.log) out.logs.push(r.log);
    }
    return out;
  };
}

module.exports = {
  SEED_CLIP_LIMIT_SECONDS,
  SEED_CLIP_TARGET_SECONDS,
  SEED_CLIP_EARLIEST_CUT,
  SEED_CLIP_NEAR_SECONDS,
  SEED_CLIP_NEAR_PAUSE_SECONDS,
  SEED_CLIP_MAX_BYTES,
  SEED_CLIP_SAFE_BYTES,
  SEED_PREP_DEADLINE_MS,
  sniffFormat,
  seedClipPlan,
  parseSilences,
  chooseCut,
  earliestCut,
  silenceArgs,
  fitArgs,
  fitSeedClip,
  sayHalf,
  sayLength,
  sayTrimmed,
  sayReused,
  sayConverted,
  sayImportTrim,
  sayImportLong,
  seedCopyName,
  ownClip,
  createSeedClipPreparer,
};
