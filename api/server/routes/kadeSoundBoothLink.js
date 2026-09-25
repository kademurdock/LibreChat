/* ============================================================================
 * A YOUTUBE LINK FOR A YUE2 COVER (Part 293, Sep 25 2026)
 *
 * Her ask, verbatim: "The soundbooth needs a youtube paste link in the yue2
 * workflow so people can cover songs from youtube videos."
 *
 * POST /sound-booth/reference/link {engine:'yue2', url} brings in one YouTube
 * video's SOUND and hands it to the very same storage and advice path a file
 * import takes (storeReference in kadeSoundBooth.js), so the answer has the
 * same shape plus the video's title and length.
 *
 * - The yt-dlp work is the describer's (packages/api description/youtube.ts
 *   youtubeAudio): the same client ladder, cookies and PO-token sidecar, the
 *   Part 290 ffmpeg fix, and the length read from the metadata BEFORE any
 *   download. A video over six minutes is refused with its length and nothing
 *   is fetched.
 * - Playlist, radio-mix and start-time parts of a link are dropped, so exactly
 *   one video comes in.
 * - The whole import has DEADLINE_MS (95 s) so the request answers well inside
 *   the phone's timeout, and a person who leaves stops the download.
 * - App Review: downloading YouTube audio is an App Store risk (guideline
 *   5.2.3), so the review seat is refused here with a neutral sentence and the
 *   guide it is served carries no link field or mention (guideFor). Child
 *   accounts may use it.
 * - One import at a time per person, a few at a time for the whole server, and
 *   a daily cap in the same shape as the booth's other caps.
 * - Log lines carry the video id and yt-dlp's reasons, never cookies.
 *
 * Kill switch: KADE_SOUNDBOOTH_YT_LINKS=0 hides and refuses it for everyone.
 * ========================================================================== */
const express = require('express');

const LINK_PATH = '/api/kade/sound-booth/reference/link';
const COVER_MAX_SECONDS = 360; // musicReferenceError's six minutes
const COVER_MAX_BYTES = 20 * 1024 * 1024; // the file import's own cap
const DEADLINE_MS = Number(process.env.KADE_SOUNDBOOTH_LINK_DEADLINE_MS || 95000);
const LINK_DAILY_CAP = Number(process.env.KADE_SOUNDBOOTH_LINK_CAP || 20);
const MAX_RUNNING = Number(process.env.KADE_SOUNDBOOTH_LINK_RUNNING || 3);

/** The sentence added to the YuE2 cover hint, and taken out again for anyone without links. */
const LINK_HINT_SENTENCE = ' You can also paste a YouTube link to a song.';
const REVIEW_WORDS = 'Importing from a link is not available on this account. Import an audio file instead.';
const FILE_INSTEAD = 'If you have the song, import the file instead.';

function linksSwitchedOn(env = process.env) {
  return String(env.KADE_SOUNDBOOTH_YT_LINKS || '').trim() !== '0';
}

/** True when this person may paste a YouTube link. Never the App Review seat. */
function linkImportAvailable(user, reviewSeat, env = process.env) {
  if (!user || !linksSwitchedOn(env)) return false;
  try {
    return !reviewSeat(user);
  } catch (e) {
    return false; // unsure means hidden: a reviewer must never be shown it by accident
  }
}

/** "3 minutes 12 seconds", the way musicReferenceError says a length. */
function spokenMinutes(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (!m) return `${s} second${s === 1 ? '' : 's'}`;
  return `${m} minute${m === 1 ? '' : 's'}${s ? ` ${s} second${s === 1 ? '' : 's'}` : ''}`;
}

/** "3:12", for the screen. */
function clock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const WORDS = {
  'not-link': 'That does not look like a link. Paste a YouTube video link, for example from the Share button on YouTube.',
  'not-youtube': 'That is not a YouTube link. Paste a link to a YouTube video, or import the song as a file.',
  'not-video': 'That link is a channel or a playlist. Paste a link to one YouTube video.',
  private: `This YouTube video is private, so the server cannot get it. ${FILE_INSTEAD}`,
  copyright: `YouTube has blocked this video over a copyright claim, so the server cannot get it. ${FILE_INSTEAD}`,
  removed: 'This YouTube video has been removed, or its channel was closed.',
  age: `This YouTube video is age-restricted, and YouTube will not hand it to the server. ${FILE_INSTEAD}`,
  members: `This YouTube video is for channel members only. ${FILE_INSTEAD}`,
  region: `YouTube does not offer this video in the server's country. ${FILE_INSTEAD}`,
  premium: `This YouTube video needs a YouTube Premium account. ${FILE_INSTEAD}`,
  unavailable: 'YouTube says this video is unavailable. Check the link, or import the song as a file.',
  live: 'That is a live or upcoming stream. Paste a link to a finished video.',
  processing: 'YouTube is still processing this video. Try again later, or import the song as a file.',
  'no-length': "YouTube has not published this video's length yet. Try again later, or import the song as a file.",
  'too-large': 'The sound from that video is over twenty megabytes. Choose a shorter video, or import the song as a file.',
  bot: 'YouTube is blocking the server right now. Try again in a few minutes, or download the song and import the file.',
  timeout: 'YouTube took too long to answer. Try again in a few minutes, or download the song and import the file.',
  unreadable: 'YouTube sent details the server could not read. Try again later, or download the song and import the file.',
  tools: 'Importing from YouTube is not set up on this server yet. Download the song and import the file.',
  failed: 'The song could not be brought in from YouTube. Try again in a few minutes, or download the song and import the file.',
};
const STATUS = {
  'not-link': 400, 'not-youtube': 400, 'not-video': 400, 'too-long': 400, live: 400,
  private: 422, copyright: 422, removed: 422, age: 422, members: 422, region: 422, premium: 422, unavailable: 422,
  processing: 422, 'no-length': 422, 'too-large': 413,
  bot: 503, timeout: 504, tools: 503, unreadable: 502, failed: 502,
};

/** The words for a failed import, in the booth's voice (never the describer's). */
function linkWords(error) {
  const kind = error && error.kind;
  if (kind === 'too-long') {
    return `This YouTube video is ${spokenMinutes(error.seconds)} long. Covers support up to 6 minutes. Choose a shorter video, or download the song and import an excerpt as a file; nothing is trimmed automatically.`;
  }
  return WORDS[kind] || WORDS.failed;
}

function linkStatus(error) {
  return STATUS[error && error.kind] || 502;
}

/** A per-person count that starts again each Chicago day, like the booth's other caps. */
function dailyCap(limit, today = chicagoDay) {
  let stamp = '';
  const counts = new Map();
  return {
    limit,
    take(user) {
      const day = today();
      if (day !== stamp) {
        stamp = day;
        counts.clear();
      }
      const used = counts.get(user) || 0;
      if (used >= limit) return false;
      counts.set(user, used + 1);
      return true;
    },
  };
}
function chicagoDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
}

/**
 * The guide for THIS person: the YuE2 cover field carries `link` (label, hint, button, path) when
 * they may paste a YouTube link, and neither the field nor its hint mentions links otherwise.
 * The shared GUIDE object is never changed.
 */
function guideFor(guide, user, reviewSeat, env = process.env) {
  const yue = guide && guide.engines && guide.engines.yue2;
  if (!yue || !Array.isArray(yue.settings)) return guide;
  const available = linkImportAvailable(user, reviewSeat, env);
  const settings = yue.settings.map((setting) => {
    if (setting.key !== 'reference_voice_url') return setting;
    if (!available) return { ...setting, hint: String(setting.hint || '').replace(LINK_HINT_SENTENCE, '') };
    return {
      ...setting,
      link: {
        site: 'youtube',
        label: 'Or paste a YouTube link',
        hint: 'One video, up to six minutes. The server brings in only its sound. A link from a playlist or mix brings in just that one video.',
        button: 'Import from YouTube',
        path: LINK_PATH,
        maxSeconds: COVER_MAX_SECONDS,
      },
    };
  });
  return { ...guide, engines: { ...guide.engines, yue2: { ...yue, settings } } };
}

/**
 * deps: auth (middleware), store(req, {buffer, ext, engine, name, source}) -> {status, body},
 * youtube() -> { youtubeAudio, readYouTubeLink }, reviewSeat(user) -> boolean, logger,
 * and optionally cap, running (Set), deadlineMs, env.
 */
function createReferenceLinkRouter(deps) {
  const router = express.Router();
  const state = {
    cap: deps.cap || dailyCap(LINK_DAILY_CAP),
    running: deps.running || new Set(),
  };
  router.post('/reference/link', deps.auth, express.json({ limit: '8kb' }), (req, res) =>
    handleReferenceLink(req, res, deps, state),
  );
  return router;
}

async function handleReferenceLink(req, res, deps, state) {
  const { logger } = deps;
  const userId = String(req.user.id);
  const body = req.body || {};
  if (!linkImportAvailable(req.user, deps.reviewSeat, deps.env || process.env)) {
    logger.warn(`[soundbooth/reference] link REFUSED user=${userId}: link import is not offered to this account`);
    return res.status(403).json({ error: REVIEW_WORDS });
  }
  if (body.engine !== 'yue2') {
    return res.status(400).json({ error: 'YouTube links are for YuE2 covers. For this engine, import an audio file.' });
  }
  const raw = typeof body.url === 'string' ? body.url.slice(0, 2000) : '';
  if (!raw.trim()) return res.status(400).json({ error: 'Paste a YouTube link first.' });
  const api = deps.youtube();
  const link = api.readYouTubeLink(raw);
  if (!link.url) {
    logger.warn(`[soundbooth/reference] link REFUSED user=${userId}: ${link.problem}`);
    return res.status(400).json({ error: WORDS[link.problem] || WORDS['not-link'], kind: link.problem });
  }
  if (state.running.has(userId)) {
    return res.status(409).json({ error: 'A YouTube import is already running for you. Wait for it to finish.' });
  }
  if (state.running.size >= MAX_RUNNING) {
    return res.status(429).json({ error: 'The server is bringing in other songs right now. Try again in a minute.' });
  }
  if (!state.cap.take(userId)) {
    return res.status(429).json({ error: `That's ${state.cap.limit} YouTube imports today. Import a file, or try again tomorrow.` });
  }
  state.running.add(userId);
  const started = Date.now();
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(new Error('deadline')), deps.deadlineMs || DEADLINE_MS);
  const hangUp = () => {
    if (!res.writableEnded) stop.abort(new Error('the person left'));
  };
  res.on('close', hangUp);
  try {
    const got = await api.youtubeAudio(link.url, {
      maxSeconds: COVER_MAX_SECONDS,
      maxBytes: COVER_MAX_BYTES,
      signal: stop.signal,
      log: (line) => logger.info(`[soundbooth/reference] link user=${userId} video=${link.id} ${line}`),
    });
    if (res.writableEnded || res.destroyed) return undefined;
    const stored = await deps.store(req, {
      buffer: got.buffer,
      ext: 'mp3',
      engine: 'yue2',
      name: got.title,
      source: { site: 'youtube', title: got.title, seconds: got.seconds, link: got.link, id: got.id },
    });
    logger.info(`[soundbooth/reference] link user=${userId} video=${link.id} status=${stored.status} ${got.buffer.length}B ${Math.round(got.seconds)}s ${Date.now() - started}ms`);
    return res.status(stored.status).json(stored.body);
  } catch (error) {
    const kind = (error && error.kind) || 'failed';
    logger.warn(`[soundbooth/reference] link FAILED user=${userId} video=${link.id} kind=${kind} ${Date.now() - started}ms: ${String((error && error.message) || error).replace(/\s+/g, ' ').slice(0, 300)}`);
    if (res.writableEnded || res.destroyed) return undefined;
    return res.status(linkStatus(error)).json({ error: linkWords(error), kind });
  } finally {
    clearTimeout(timer);
    res.removeListener('close', hangUp);
    state.running.delete(userId);
  }
}

module.exports = {
  createReferenceLinkRouter,
  handleReferenceLink,
  guideFor,
  linkImportAvailable,
  linkWords,
  linkStatus,
  spokenMinutes,
  clock,
  dailyCap,
  LINK_PATH,
  LINK_HINT_SENTENCE,
  REVIEW_WORDS,
  COVER_MAX_SECONDS,
  COVER_MAX_BYTES,
  WORDS,
};
