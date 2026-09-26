/* ============================================================================
 * A MEDIA LINK FOR A YUE2 COVER (Part 293, Sep 25 2026)
 *
 * Her ask, verbatim: "The soundbooth needs a youtube paste link in the yue2
 * workflow so people can cover songs from youtube videos." Then: "it's not
 * just a youtube link it's a media in general link."
 *
 * POST /sound-booth/reference/link {engine:'yue2', url} brings in one song's
 * SOUND from YouTube, another big media site (Vimeo, SoundCloud, Bandcamp,
 * TikTok, Instagram, Facebook, X, Reddit, Dailymotion, Twitch clips, the
 * Internet Archive) or a direct audio/video file link, and hands it to the
 * very same storage and advice path a file import takes (storeReference in
 * kadeSoundBooth.js), so the answer has the same shape plus the title, length
 * and site.
 *
 * - The fetching is packages/api description/links.ts (mediaAudio): YouTube
 *   keeps the describer's yt-dlp ladder (youtube.ts youtubeAudio); other sites
 *   run yt-dlp with only allowlisted extractors, never the generic one; direct
 *   files are fetched by our code behind the fork's SSRF guard. The length is
 *   read before any download wherever the site lists it; six minutes or more is
 *   refused with its length and nothing is trimmed.
 * - The FAMILY FEATURE PACK (her words: "if I let bob down the fictional street
 *   have an account on here, I'm not going to let him have access to the
 *   downloader"): only an account with familyFeatures(user).mediaLinks may use
 *   it. Everyone else, the App Review seat included, is shown the field greyed
 *   out with "Part of the Family feature pack" (never hidden: Apple's 2.3.1),
 *   and the route answers 403 with PACK_REFUSAL. Child accounts in the pack may
 *   use it, but never for an age-restricted video.
 * - A YouTube playlist, radio-mix or start-time part is dropped, so exactly one
 *   video comes in; an album, playlist or profile on another site is refused.
 * - The whole import has DEADLINE_MS (95 s) so the request answers well inside
 *   the phone's timeout, and a person who leaves stops the download.
 * - One import at a time per person, a few at a time for the whole server, and
 *   a daily cap in the same shape as the booth's other caps.
 * - Log lines carry a short id (the YouTube id, "soundcloud:" and a short hash
 *   of the link, or "file:host/name") and the tools' reasons, never cookies, a
 *   link's query or a private link's key.
 *
 * Kill switch: KADE_SOUNDBOOTH_YT_LINKS=0 takes the field away and refuses it
 * for everyone.
 * ========================================================================== */
const express = require('express');

const LINK_PATH = '/api/kade/sound-booth/reference/link';
const COVER_MAX_SECONDS = 360; // musicReferenceError's six minutes
const COVER_MAX_BYTES = 20 * 1024 * 1024; // the file import's own cap
const DEADLINE_MS = Number(process.env.KADE_SOUNDBOOTH_LINK_DEADLINE_MS || 95000);
const LINK_DAILY_CAP = Number(process.env.KADE_SOUNDBOOTH_LINK_CAP || 20);
const MAX_RUNNING = Number(process.env.KADE_SOUNDBOOTH_LINK_RUNNING || 3);

/** The sentence added to the YuE2 cover hint, and taken out again for anyone without the pack. */
const LINK_HINT_SENTENCE = ' You can also paste a media link to a song, from YouTube or another media site.';
/** packages/api family/pack.ts FAMILY_PACK_NOTE and FAMILY_PACK_REFUSAL (the tests hold them equal). */
const PACK_NOTE = 'Part of the Family feature pack';
const PACK_REFUSAL = 'Media links are part of the Family feature pack. Ask Kade to add it to your account.';
const SWITCHED_OFF = 'Importing from a link is turned off on this server right now. Import an audio file instead.';
const FILE_INSTEAD = 'If you have the song, import the file instead.';

function linksSwitchedOn(env = process.env) {
  return String(env.KADE_SOUNDBOOTH_YT_LINKS || '').trim() !== '0';
}

/**
 * True when this person may paste a media link: the switch is on and their Family feature pack
 * map says mediaLinks. `features(user)` is packages/api familyFeatures.
 */
function linkImportAvailable(user, features, env = process.env) {
  if (!user || !linksSwitchedOn(env)) return false;
  try {
    return features(user).mediaLinks === true;
  } catch (e) {
    return false; // unsure means greyed out: the downloader is never opened by accident
  }
}

/** A child's account, the way the describer tells (kadeDescribedVideo.js actor). */
function isChildAccount(user) {
  return !!user && user.kadeAccountType === 'child';
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

/** What a site is called in a sentence. */
const SITE_NAMES = {
  youtube: 'YouTube',
  vimeo: 'Vimeo',
  soundcloud: 'SoundCloud',
  bandcamp: 'Bandcamp',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  facebook: 'Facebook',
  x: 'X',
  dailymotion: 'Dailymotion',
  twitch: 'Twitch',
  reddit: 'Reddit',
  archive: 'the Internet Archive',
  file: 'the link',
};
function siteLabel(site) {
  return SITE_NAMES[site] || 'the link';
}
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** Problems with the link itself, the same whatever the site. */
const LINK_WORDS = {
  'not-link': 'That does not look like a link. Paste a link to a song, for example from the Share button on YouTube or SoundCloud.',
  'not-supported': 'The booth cannot bring songs in from that site. Paste a link from YouTube, SoundCloud, Bandcamp, Vimeo or another big media site, a direct link to an audio file, or import the song as a file.',
  'not-video': 'That link is a channel, playlist or album. Paste a link to one song or video.',
  'blocked-address': 'The server will not fetch that link: it points to a private or internal address, or carries a sign-in or a port number. Paste an ordinary public link.',
  'not-found': "That link's site could not be found. Check the link and try again.",
  redirects: 'That link sends the server on too many hops. Paste the link where the song finally is.',
  'not-media': 'That link did not send an audio or video file. Paste a link from a media site, or a link straight to the file.',
  live: 'That is a live or upcoming stream. Paste a link to a finished song or video.',
  tools: 'Importing from links is not set up on this server yet. Download the song and import the file.',
};

/** YouTube's own words (Part 293's first round), kept as they were. */
const WORDS = {
  private: `This YouTube video is private, so the server cannot get it. ${FILE_INSTEAD}`,
  copyright: `YouTube has blocked this video over a copyright claim, so the server cannot get it. ${FILE_INSTEAD}`,
  removed: 'This YouTube video has been removed, or its channel was closed.',
  age: `This YouTube video is age-restricted, and YouTube will not hand it to the server. ${FILE_INSTEAD}`,
  'age-child': 'This YouTube video is age-restricted, so it cannot be brought in on this account. Choose a different video.',
  members: `This YouTube video is for channel members only. ${FILE_INSTEAD}`,
  region: `YouTube does not offer this video in the server's country. ${FILE_INSTEAD}`,
  premium: `This YouTube video needs a YouTube Premium account. ${FILE_INSTEAD}`,
  unavailable: 'YouTube says this video is unavailable. Check the link, or import the song as a file.',
  processing: 'YouTube is still processing this video. Try again later, or import the song as a file.',
  'no-length': "YouTube has not published this video's length yet. Try again later, or import the song as a file.",
  'too-large': 'The sound from that video is over twenty megabytes. Choose a shorter video, or import the song as a file.',
  bot: 'YouTube is blocking the server right now. Try again in a few minutes, or download the song and import the file.',
  timeout: 'YouTube took too long to answer. Try again in a few minutes, or download the song and import the file.',
  unreadable: 'YouTube sent details the server could not read. Try again later, or download the song and import the file.',
  failed: 'The song could not be brought in from YouTube. Try again in a few minutes, or download the song and import the file.',
};

/** Another media site's words, with its name ("SoundCloud", "the Internet Archive"). */
const SITE_WORDS = {
  private: (n) => `This is private on ${n}, or needs a sign-in there, so the server cannot get it. ${FILE_INSTEAD}`,
  copyright: (n) => `${capital(n)} has blocked this over a copyright claim, so the server cannot get it. ${FILE_INSTEAD}`,
  removed: (n) => `This has been removed from ${n}, or the link is wrong.`,
  age: (n) => `This is age-restricted on ${n}, and the server cannot get it. ${FILE_INSTEAD}`,
  members: (n) => `This is for subscribers only on ${n}. ${FILE_INSTEAD}`,
  region: (n) => `${capital(n)} does not offer this in the server's country. ${FILE_INSTEAD}`,
  premium: (n) => `This needs a paid ${n} account. ${FILE_INSTEAD}`,
  unavailable: (n) => `${capital(n)} says this is unavailable right now. Check the link, or import the song as a file.`,
  processing: (n) => `${capital(n)} is still processing this. Try again later, or import the song as a file.`,
  'too-large': () => 'The sound from that link is over twenty megabytes. Choose a shorter song, or import the song as a file.',
  bot: (n) => `${capital(n)} is blocking the server right now. Try again in a few minutes, or download the song and import the file.`,
  timeout: (n) => `${capital(n)} took too long to answer. Try again in a few minutes, or download the song and import the file.`,
  unreadable: (n) => `${capital(n)} sent details the server could not read. Try again later, or download the song and import the file.`,
  failed: (n) => `The song could not be brought in from ${n}. Try again in a few minutes, or download the song and import the file.`,
};

/** A direct file link's words. */
const FILE_WORDS = {
  private: 'That link needs a sign-in, so the server cannot get the file. If you have the song, import the file instead.',
  removed: 'Nothing is at that link any more. Check the link, or import the song as a file.',
  unavailable: 'The site with that file is not answering properly right now. Try again later, or import the song as a file.',
  'too-large': 'That file is too big to bring in. Choose a shorter song, or import the song as a file.',
  timeout: 'That link took too long to send the file. Try again in a few minutes, or download the song and import the file.',
  failed: 'The file could not be brought in from that link. Try again in a few minutes, or download the song and import the file.',
};

const CHILD_AGE = 'This is age-restricted, so it cannot be brought in on this account. Choose a different song.';

const STATUS = {
  'not-link': 400, 'not-supported': 400, 'not-video': 400, 'blocked-address': 400, 'not-found': 400, 'too-long': 400, live: 400,
  private: 422, copyright: 422, removed: 422, age: 422, members: 422, region: 422, premium: 422, unavailable: 422,
  processing: 422, 'no-length': 422, 'not-media': 422, redirects: 422, 'too-large': 413,
  bot: 503, timeout: 504, tools: 503, unreadable: 502, failed: 502,
};

/** "This YouTube video", "This song from SoundCloud", "This file". */
function thing(site) {
  if (site === 'youtube') return 'This YouTube video';
  if (site === 'file') return 'This file';
  return `This song from ${siteLabel(site)}`;
}

/**
 * The words for a failed import, in the booth's voice (never the describer's). A song listed at
 * exactly six minutes is refused too (YouTube's whole seconds may hide a fraction more), so the
 * limit is said as "shorter than", never "up to". `site` is the link's site (YouTube by default).
 */
function linkWords(error, user, site = 'youtube') {
  const kind = error && error.kind;
  if (kind === 'too-long') {
    const from = site === 'youtube' ? 'YouTube' : 'a link';
    const shorter = site === 'youtube' ? 'video' : 'song';
    return `${thing(site)} is ${spokenMinutes(error.seconds)} long, and covers from ${from} must be shorter than 6 minutes. Choose a shorter ${shorter}, or download the song and import an excerpt as a file; nothing is trimmed automatically.`;
  }
  if (kind === 'age' && isChildAccount(user)) return site === 'youtube' ? WORDS['age-child'] : CHILD_AGE;
  if (LINK_WORDS[kind]) return LINK_WORDS[kind];
  if (site === 'youtube') return WORDS[kind] || WORDS.failed;
  if (site === 'file') return FILE_WORDS[kind] || FILE_WORDS.failed;
  return (SITE_WORDS[kind] || SITE_WORDS.failed)(siteLabel(site));
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

/** The words beside the link field, for everyone who is shown it. */
const LINK_FIELD = {
  site: 'media',
  label: 'Or paste a media link (YouTube and other sites)',
  hint: 'One song or video, shorter than six minutes, from YouTube, SoundCloud, Bandcamp, Vimeo, TikTok, Instagram, Facebook, X, Reddit, Dailymotion, Twitch clips or the Internet Archive, or a direct link to an audio or video file. The server brings in only its sound. A YouTube link from a playlist or mix brings in just that one video.',
  button: 'Import from link',
  path: LINK_PATH,
  maxSeconds: COVER_MAX_SECONDS,
};

/**
 * The guide for THIS person. While the switch is on, the YuE2 cover field always carries `link`
 * (label, hint, button, path, maxSeconds, available): `available: true` for the Family feature
 * pack, and for everyone else `available: false` with `locked: "Part of the Family feature pack"`,
 * so the field is shown greyed out, never hidden. The cover hint mentions links only when they
 * can be used. The switch off takes the field away for everyone. The shared GUIDE is never changed.
 */
function guideFor(guide, user, features, env = process.env) {
  const yue = guide && guide.engines && guide.engines.yue2;
  if (!yue || !Array.isArray(yue.settings)) return guide;
  const switchedOn = linksSwitchedOn(env);
  const available = linkImportAvailable(user, features, env);
  const settings = yue.settings.map((setting) => {
    if (setting.key !== 'reference_voice_url') return setting;
    const hint = available ? setting.hint : String(setting.hint || '').replace(LINK_HINT_SENTENCE, '');
    if (!switchedOn) return { ...setting, hint };
    const link = available ? { ...LINK_FIELD, available: true } : { ...LINK_FIELD, available: false, locked: PACK_NOTE };
    return { ...setting, hint, link };
  });
  return { ...guide, engines: { ...guide.engines, yue2: { ...yue, settings } } };
}

/**
 * deps: auth (middleware), store(req, {buffer, ext, engine, name, source}) -> {status, body},
 * media() -> { readMediaLink, mediaAudio } (packages/api description/links.ts),
 * features(user) -> familyFeatures map, logger, and optionally cap, running (Set), deadlineMs, env.
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
  const env = deps.env || process.env;
  if (!linksSwitchedOn(env)) return res.status(403).json({ error: SWITCHED_OFF });
  if (!linkImportAvailable(req.user, deps.features, env)) {
    logger.warn(`[soundbooth/reference] link REFUSED user=${userId}: not in the Family feature pack`);
    return res.status(403).json({ error: PACK_REFUSAL, pack: true });
  }
  if (body.engine !== 'yue2') {
    return res.status(400).json({ error: 'Media links are for YuE2 covers. For this engine, import an audio file.' });
  }
  const raw = typeof body.url === 'string' ? body.url.slice(0, 2000) : '';
  if (!raw.trim()) return res.status(400).json({ error: 'Paste a media link first.' });
  const api = deps.media();
  const link = api.readMediaLink(raw);
  if (!link.url) {
    logger.warn(`[soundbooth/reference] link REFUSED user=${userId}: ${link.problem}`);
    return res.status(400).json({ error: LINK_WORDS[link.problem] || LINK_WORDS['not-link'], kind: link.problem });
  }
  if (state.running.has(userId)) {
    return res.status(409).json({ error: 'A link import is already running for you. Wait for it to finish.' });
  }
  if (state.running.size >= MAX_RUNNING) {
    return res.status(429).json({ error: 'The server is bringing in other songs right now. Try again in a minute.' });
  }
  if (!state.cap.take(userId)) {
    return res.status(429).json({ error: `That's ${state.cap.limit} link imports today. Import a file, or try again tomorrow.` });
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
    const got = await api.mediaAudio(link, {
      maxSeconds: COVER_MAX_SECONDS,
      maxBytes: COVER_MAX_BYTES,
      /* The server's signed-in YouTube account must never carry a child past
       * YouTube's own age gate, and no site's age-restricted item comes in on
       * a child's account: those are for grown-ups only. */
      allowAgeRestricted: !isChildAccount(req.user),
      signal: stop.signal,
      log: (line) => logger.info(`[soundbooth/reference] link user=${userId} video=${link.id} ${line}`),
    });
    if (res.writableEnded || res.destroyed) return undefined;
    const site = got.site || link.site;
    const stored = await deps.store(req, {
      buffer: got.buffer,
      ext: 'mp3',
      engine: 'yue2',
      name: got.title,
      source: { site, title: got.title, seconds: got.seconds, link: got.link, id: got.id },
    });
    logger.info(`[soundbooth/reference] link user=${userId} video=${link.id} status=${stored.status} ${got.buffer.length}B ${Math.round(got.seconds)}s ${Date.now() - started}ms`);
    return res.status(stored.status).json(stored.body);
  } catch (error) {
    const kind = (error && error.kind) || 'failed';
    logger.warn(`[soundbooth/reference] link FAILED user=${userId} video=${link.id} kind=${kind} ${Date.now() - started}ms: ${String((error && error.message) || error).replace(/\s+/g, ' ').slice(0, 300)}`);
    if (res.writableEnded || res.destroyed) return undefined;
    return res.status(linkStatus(error)).json({ error: linkWords(error, req.user, link.site), kind });
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
  siteLabel,
  spokenMinutes,
  clock,
  dailyCap,
  LINK_PATH,
  LINK_FIELD,
  LINK_HINT_SENTENCE,
  PACK_NOTE,
  PACK_REFUSAL,
  SWITCHED_OFF,
  COVER_MAX_SECONDS,
  COVER_MAX_BYTES,
  WORDS,
  LINK_WORDS,
  SITE_WORDS,
  FILE_WORDS,
};
