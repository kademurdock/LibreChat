/* Sound Booth: AuK HQ speech/editing, fal Seed Audio scenes, and Lyria music.
 * The stored engine key and bridge route "scenema" remain compatibility names
 * so existing clients, projects, receipts and saved takes continue to work.
 * AuK translates screenplay XML inside the worker; it is not the model API.
 * All routes below use the signed-in user; provider keys stay server-side.
 */
const axios = require('axios');
const multer = require('multer');
const express = require('express');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const jevJudges = require('~/server/services/kadeJevJudges');
const { needsRefresh, getNewS3URL, saveBufferToS3, writingCost, musicWritingPrompt, musicWritingSettings, lyricTells, lyricRepairRequest, mergeRepairedLyrics, lyricShapeIssue, lyricEndingTells, lyricKissOffTells, songSectionMap, sectionMapNote, chorusShapeFor, chorusShapeNote, lyricRepeatIssues, lyricRepeatRequest, applyRepeatRewrite, lyricAuditRequest, fixStageDirections, labelReadback, lyricWritingModel, lyricAgentId, songIdeaSparks, songIdeaSystemFor, songIdeaRequest, songIdeaTitle, cleanSongIdea, tooCloseToShelf, createEffectsRouter, effectsGuide, effectsConfigured, effectsPrice, effectsModel, effectsVariant, effectsVariants, downloadEffects, createYueRouter, yueConfigured, yueCost, yueStyles, yueStylesEnabled, yueStyleHint, yueStyleAccess, FAMILY_PACK_STYLES_REFUSAL, yueCoverSettings, yueCoverOptions, yueSavedOptions, yueProjectWhy, yueTakeFacts, notifyMusic, createLyricsRouter, registerMusicReference, transcribeMusicLyrics, validateMusicReference, musicReferenceError, musicReferenceSeconds, findMyVoiceModel, withMyVoiceGuide, createMyVoiceRouter, createMyVoiceFollowUps, myVoiceAutoOptions, myVoiceTakeNote, myVoiceEffectLinks, myVoiceProjectOptions, myVoiceProjectWhy, musicReferenceSpeedNote, musicCoverLengthGuide } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const { logKadeUsage, KadeUsage } = require('~/models/kadeUsage');
const { getAgent } = require('~/models');
const { songAudience, hasExplicitWords, explicitSungLines } = require('~/server/utils/kadeSongAudience');
const { logKadeAsset, KadeAsset } = require('~/models/kadeAsset');
const { KadeSoundBoothProject } = require('~/models/kadeSoundBoothProject');
const { splitSpeakScript, saySplit, previewExcerpt } = require('./kadeSoundBoothSplit');
/* Part 126: the person reads and writes a SCREENPLAY; the engine reads XML. */
const { parseScreenplay, screenplayToSpeak, speakToScreenplay, isSpeakXml, SCREENPLAY_HELP, speakAttrs, withSpeakVoice, liftBodyHeaders, speakerClause, voicesDisagree, voiceTraits, NEUTRAL_VOICE, VOICE_HEADER_WORDS } = require('./kadeSoundBoothScreenplay');
const carry = require('./kadeSoundBoothCarry');
const songPaste = require('./kadeSoundBoothPaste');
const chain = require('./kadeSoundBoothChain');
/* Oct 2 2026: a provider's failure in plain words, and logged whole ("[object Object]" was all she heard). */
const { providerError, errorText } = require('./kadeSoundBoothErrors');

const router = express.Router();
const musicReferenceHooks = {
  auth: requireJwtAuth, user: req => String(req.user.id), refresh: freshAssetUrl,
  duration: buffer => require('./kadeSoundBoothStitch').durationOf(buffer),
  /* Part 295: a Gemini refusal that is the key's own trouble reaches the Google key alarm; the
   * transcriber still falls back to scribe_v2 as before. */
  transcribe: (buffer, mime, seconds) => transcribeMusicLyrics(buffer, mime, seconds, (error) =>
    googleKeyAlarm('the lyric transcriber', error, process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : 'KADE_EMBED_GEMINI_KEY')),
  savedSources: async user => {
    const projects = await KadeSoundBoothProject.find({ user, 'options.reference_voice_url': { $exists: true } }).select('options.reference_voice_url').lean();
    const assets = await KadeAsset.find({ user, kind: 'audio' }).select('url metadata.wavUrl').lean();
    return [...projects.map(p => p.options.reference_voice_url), ...assets.flatMap(a => [a.url, a.metadata?.wavUrl])].filter(Boolean);
  },
};
/* Sep 25 2026: a song pasted whole from ChatGPT ("Lyrics Box", "Tag Box",
 * "Negative Tag Box") is sorted before any render route reads it -- YuE2's
 * below and Lyria's further down -- so the engine gets the direction and the
 * words and never the negative tags. The web page sorts a paste the moment it
 * lands; this is for the phone and for a paste rendered straight away. Auth
 * stays with the render routes themselves.
 *
 * Whatever route answers, the answer says what the sorting did (`note`, and
 * in front of `estimate.spoken` and `spoken`) and hands back the sorted boxes
 * (`pasteSorted`), so a phone that sent the paste unsorted can say so and put
 * the sorted direction and words in its own fields. YuE2's router knows
 * nothing about pastes; this is how its answer carries the note too. Adding
 * the note is idempotent, so the Lyria route saying it itself is harmless. */
function withSongPasteNote(data, applied) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const note = applied.note;
  const says = (s) => typeof s === 'string' && s.includes(note);
  const out = { ...data };
  if (note && !says(out.note)) out.note = [note, out.note].filter(Boolean).join(' ');
  if (note && out.estimate && typeof out.estimate.spoken === 'string' && !says(out.estimate.spoken)) {
    out.estimate = { ...out.estimate, spoken: note + ' ' + out.estimate.spoken };
  }
  if (note && typeof out.spoken === 'string' && !says(out.spoken)) out.spoken = note + ' ' + out.spoken;
  out.pasteSorted = { script: applied.script, lyrics: typeof applied.lyrics === 'string' ? applied.lyrics : null };
  return out;
}
router.post('/render', express.json({ limit: '128kb' }), (req, res, next) => {
  const applied = songPaste.applySongPasteToBody(req.body);
  if (applied) {
    req.songPaste = applied;
    const json = res.json.bind(res);
    res.json = (data) => json(withSongPasteNote(data, applied));
  }
  next();
});
router.use(createLyricsRouter(musicReferenceHooks));
/* Part 295 (Sep 27 2026): the trained styles are part of the Family feature pack. The Soul style
 * was taught from commercial soul and R&B records, so only an account with the pack
 * (familyFeatures(user).trainedStyles; never the App Review seats) may render in a style. The
 * guide greys the Style choice out for everyone else (withStyleAccess), and an older client that
 * still shows it live is refused here, on the server, before the YuE2 router queues anything,
 * with words that say what to change. An unreadable pack answer counts as outside the pack. */
/** Any Style but None, for YuE2: yueInput's own reading of `band`. */
function asksForStyle(body) {
  const b = body || {};
  return b.engine === 'yue2' && !!b.band && b.band !== 'none';
}
function styleAllowed(user) {
  try {
    return boothFeatures(user).trainedStyles === true;
  } catch (e) {
    return false;
  }
}
router.post('/render', express.json({ limit: '128kb' }), (req, res, next) => {
  if (!asksForStyle(req.body)) return next();
  return requireJwtAuth(req, res, () => {
    if (styleAllowed(req.user)) return next();
    logger.warn(`[soundbooth/render] trained style REFUSED user=${req.user && req.user.id}: not in the Family feature pack`);
    return res.status(403).json({ error: FAMILY_PACK_STYLES_REFUSAL, pack: true });
  });
});
/* Sep 27 2026, her word: "It's also kinda stupid that the soundbooth says kids choir has to have
 * clean lyrics ... I hate assumptions like that on an uncensored platform." The Kids style is a
 * sound, not an audience: its lyrics follow the account like every other song (the child account
 * and the App Review seat stay clean through kadeSongAudience), so there is no render refusal. */
/* ============== Sing it in my voice (Sep 27 2026; packages/api music/myVoice.ts) ==============
 * A personal feature: only an account with a voice model registered for its user id (MY_VOICE_MODELS, or the KadeVoiceModel
 * table with a consent record) sees or reaches any of it. myVoiceOwner answers null for everyone else, and while
 * MY_VOICE_ENABLED is off. The YuE2 choice below is cleared on the server for an account without a model; the engine's own
 * router lets such a request fall through as an unknown engine; the guide, the upload lane and /health add nothing for them. */
/* Without the voice module (a test harness with its own @librechat/api stand-ins) the feature is simply off: nothing is
 * mounted, every owner check answers null, and the booth still loads. */
const MY_VOICE_READY = [findMyVoiceModel, createMyVoiceFollowUps, createMyVoiceRouter, withMyVoiceGuide].every((f) => typeof f === 'function');
function myVoiceOwner(userId) {
  return MY_VOICE_READY ? findMyVoiceModel(String(userId || '')) : Promise.resolve(null);
}
const MY_VOICE_OFF = { queue: async () => ({ queued: false, reason: 'off' }), advance: async () => undefined, stop: () => undefined };
/* A version in her voice is named after its project with this ending, so it never reads exactly like the take it came from.
 * Renaming the project (PATCH /projects/:id) keeps the ending on it. */
const voiceVersionTitle = (title) => `${title} (in my voice)`.slice(0, 120);
const myVoiceFollowUps = !MY_VOICE_READY ? MY_VOICE_OFF : createMyVoiceFollowUps({
  find: myVoiceOwner,
  /* A finished voice version: its own take, beside the one it was made from, in the same project. Idempotent: the asset is
   * keyed by the follow-up's id and the project only gains it (and its cost) once. */
  complete: async (row) => {
    /* Sep 29 2026: the project's name as it is now, as a YuE2 take reads it, so a rename while the version was being made
     * is not undone when it lands. */
    const project = await KadeSoundBoothProject.findOne({ _id: row.projectId, user: row.user }).select('title').lean();
    const title = voiceVersionTitle(project?.title || row.title);
    const out = row.output || {};
    const asset = await KadeAsset.findOneAndUpdate({ user: row.user, service: 'runpod_myvoice', 'metadata.jobId': row.id }, {
      $setOnInsert: { user: row.user, service: 'runpod_myvoice', kind: 'audio', url: out.url, model: 'RVC v2 voice model',
        prompt: 'Sing it in my voice', description: title, costUSD: row.costUSD || 0,
        metadata: { title, jobId: row.id, projectId: row.projectId, via: 'sound-booth', voiceOf: row.sourceAssetId,
          wavUrl: out.wav_url, vocalUrl: out.vocal_url, vocalWavUrl: out.vocal_wav_url, seconds: Math.round(out.duration_s || 0),
          ...myVoiceEffectLinks(out),
          gpu: out.gpu, takeNote: myVoiceTakeNote(out), costScope: 'execution estimate; startup and idle are additional' } },
    }, { upsert: true, new: true });
    await KadeSoundBoothProject.updateOne({ _id: row.projectId, user: row.user, assets: { $ne: String(asset._id) } },
      { $push: { assets: String(asset._id) }, $inc: { voiceCostUSD: row.costUSD || 0 } });
    await KadeAsset.updateOne({ _id: row.sourceAssetId, user: row.user }, { $set: { 'metadata.myVoice': { state: 'done', assetId: String(asset._id) } } });
  },
  failed: async (row) => {
    await KadeAsset.updateOne({ _id: row.sourceAssetId, user: row.user }, { $set: { 'metadata.myVoice': { state: 'failed', error: row.error || '' } } });
  },
  notify: async (row, done, total) => {
    const receipt = await notifyMusic(row.user, `${row.title}, in your voice`, done, total, done < total);
    logger.info(`[soundbooth/myvoice] notification batch=${row.batchId} done=${done}/${total} accepted=${receipt.accepted}`);
  },
  /* The one notification waits while the YuE2 request can still finish takes (its batch id is the YuE2 job's id). */
  batchOpen: async (row) => {
    const Jobs = mongoose.models.KadeYueJob;
    if (!Jobs) return false;
    const job = await Jobs.findOne({ id: row.batchId, user: row.user }).select('state').lean();
    return !!job && ['submitting', 'queued', 'running', 'saving'].includes(job.state);
  },
  log: (line) => logger.info(line),
});
router.use(createYueRouter({
  auth: requireJwtAuth,
  user: req => String(req.user.id),
  /* A YuE2 cover's limit: up to 6:40 while YUE_FIT_TEMPO=1 (the worker sings it a little faster to fit). */
  validateReference: (user, url) => validateMusicReference(user, url, musicReferenceHooks, { yueCover: true }),
  /* Sing it in my voice: the automatic choice only stands for an account with a voice model; anyone else's is dropped quietly. */
  prepare: async (user, input) => {
    if (!input.my_voice) return input;
    if (await myVoiceOwner(user)) return input;
    const { my_voice: _dropped, ...rest } = input;
    return rest;
  },
  project: async (user, input, sourceText) => {
    const p = await KadeSoundBoothProject.create({ user, engine: 'yue2', title: input.title, script: input.style,
      sourceText: sourceText.slice(0, 8000), options: { lyrics: input.lyrics, abc: input.abc, cot: input.cot, band: input.band, seed: input.seed, reference_voice_url: input.reference_voice_url, count: input.count, weirdness: input.weirdness, steps: input.steps, guidance: input.guidance, ...yueCoverOptions(input), ...(input.my_voice ? { my_voice: myVoiceAutoOptions.on } : {}) }, state: 'queued' });
    return String(p._id);
  },
  update: async job => {
    await KadeSoundBoothProject.updateOne({ _id: job.projectId, user: job.user }, {
      $set: { state: job.state === 'uncertain' ? 'failed' : job.state === 'saving' ? 'running' : job.state,
        lastError: job.error, costUSD: job.costUSD || 0 }, $addToSet: { jobs: job.id },
    });
  },
  notify: async job => {
    const project = await KadeSoundBoothProject.findOne({ _id: job.projectId, user: job.user }).select('title').lean();
    const completed = (job.takes || []).filter(take => take.state === 'done').length;
    const receipt = await notifyMusic(job.user, project?.title || job.input.title || 'Your song', completed, job.takes?.length || 1, job.state !== 'done');
    logger.info(`[soundbooth/music] notification job=${job.id} accepted=${receipt.accepted} deferred=${receipt.deferred === true} blocked=${receipt.blocked || 'none'}`);
    return receipt;
  },
  complete: async job => {
    const scoreUrl = job.output.score_key ? await getNewS3URL(job.output.wav_url, job.output.score_key) : undefined;
    const project = await KadeSoundBoothProject.findOne({ _id: job.projectId, user: job.user }).select('title').lean();
    const title = project?.title || job.input.title || job.input.style.slice(0, 80);
    const asset = await KadeAsset.findOneAndUpdate({ user: job.user, service: 'runpod_yue2', 'metadata.jobId': job.id }, {
      $setOnInsert: { user: job.user, service: 'runpod_yue2', kind: 'audio', url: job.output.url,
        model: 'm-a-p/YuE2-3B', prompt: job.input.style, description: title,
        costUSD: job.costUSD || 0, metadata: { title, seed: job.input.seed, weirdness: job.input.weirdness, steps: job.input.steps, guidance: job.input.guidance, jobId: job.id, projectId: job.projectId, via: 'sound-booth',
          wavUrl: job.output.wav_url, seconds: Math.round(job.output.duration_s || 0), lyrics: job.input.lyrics,
          scoreKey: job.output.score_key, scoreUrl, truncated: job.output.truncated, costScope: 'execution estimate; startup and idle are additional',
          /* Part 295: instrumental, cover mode, the card it ran on and a short note, from a worker that reports them. */
          ...yueTakeFacts(job.output, job.input) } },
    }, { upsert: true, new: true });
    await KadeSoundBoothProject.updateOne({ _id: job.projectId, user: job.user }, { $addToSet: { assets: String(asset._id) } });
    /* Sing it in my voice, automatic: a version of this take in the owner's voice. It never holds up or fails the take itself;
     * a take saved twice after a crash is queued once (the follow-up is unique per source take). */
    if (job.input.my_voice === true) {
      try {
        const queued = await myVoiceFollowUps.queue({ user: job.user, projectId: job.projectId, sourceAssetId: String(asset._id),
          sourceJobId: job.id, audioKey: job.output.wav_key, title });
        if (queued.queued) await KadeAsset.updateOne({ _id: asset._id, user: job.user }, { $set: { 'metadata.myVoice': { state: 'queued' } } });
        logger.info(`[soundbooth/myvoice] take=${job.id} queued=${queued.queued}${queued.reason ? ` reason=${queued.reason}` : ''}`);
      } catch (error) {
        logger.warn('[soundbooth/myvoice] could not queue a voice version: ' + (error && error.message));
      }
    }
  },
}));

router.use(createEffectsRouter({
  auth: requireJwtAuth,
  user: req => String(req.user.id),
  project: async (user, input, sourceText) => {
    const project = await KadeSoundBoothProject.create({ user, engine: 'stable', title: input.title,
      script: input.style, sourceText: sourceText.slice(0, 8000), state: 'queued',
      options: { soundModel: input.soundModel, duration: input.duration, count: input.count, steps: input.steps, seed: input.seed } });
    return String(project._id);
  },
  update: async job => {
    await KadeSoundBoothProject.updateOne({ _id: job.projectId, user: job.user }, {
      $set: { state: job.state === 'uncertain' ? 'failed' : job.state === 'saving' ? 'running' : job.state,
        lastError: job.error, costUSD: job.costUSD || 0 }, $addToSet: { jobs: job.id },
    });
  },
  notify: async job => {
    const project = await KadeSoundBoothProject.findOne({ _id: job.projectId, user: job.user }).select('title').lean();
    const completed = (job.takes || []).filter(take => take.state === 'done').length;
    const receipt = await notifyMusic(job.user, project?.title || job.input.title, completed, job.takes?.length || 1, job.state !== 'done', 'effects');
    logger.info(`[soundbooth/effects] notification job=${job.id} accepted=${receipt.accepted} deferred=${receipt.deferred === true} blocked=${receipt.blocked || 'none'}`);
    return receipt;
  },
  complete: async job => {
    const query = { user: job.user, service: 'fal_stable_audio', 'metadata.jobId': job.id };
    let asset = await KadeAsset.findOne(query);
    if (!asset) {
      const buffer = await downloadEffects(job.output.wav_url || job.output.url);
      const seconds = await require('./kadeSoundBoothStitch').durationOf(buffer);
      if (!(seconds > 0)) throw new Error('Could not verify Stable Audio duration');
      const url = await saveBufferToS3({ userId: job.user, buffer, fileName: `${job.id}.wav`, basePath: 'audios' });
      const project = await KadeSoundBoothProject.findOne({ _id: job.projectId, user: job.user }).select('title').lean();
      const title = project?.title || job.input.title;
      asset = await KadeAsset.findOneAndUpdate(query, { $setOnInsert: {
        user: job.user, service: 'fal_stable_audio', kind: 'audio', url, model: effectsVariant(job.input).model,
        prompt: job.input.style, description: title, costUSD: effectsVariant(job.input).price,
        metadata: { title, soundModel: job.input.soundModel || '3_small_sfx', seed: job.input.seed, steps: job.input.steps, seconds, wavUrl: url,
          jobId: job.id, projectId: job.projectId, via: 'sound-booth', format: 'wav',
          costScope: 'provider cost; no credit balance deduction during trial' },
      } }, { upsert: true, new: true });
    }
    job.output.url = asset.url;
    job.output.wav_url = asset.metadata.wavUrl;
    job.output.duration_s = asset.metadata.seconds;
    await KadeSoundBoothProject.updateOne({ _id: job.projectId, user: job.user }, { $addToSet: { assets: String(asset._id) } });
  },
}));

/* Sing it in my voice, the engine: she imports a song or a dry vocal and gets it back in her voice. Mounted before the main
 * /render, which would otherwise read the unknown engine as AuK; for an account with no voice model the request falls through
 * to it exactly as any unknown engine does. */
if (MY_VOICE_READY) router.use(createMyVoiceRouter({
  auth: requireJwtAuth,
  user: req => String(req.user.id),
  find: myVoiceOwner,
  seconds: (user, url) => musicReferenceSeconds(user, url),
  validateReference: (user, url) => validateMusicReference(user, url, musicReferenceHooks),
  project: async (user, input, sourceText) => {
    const p = await KadeSoundBoothProject.create({ user, engine: 'myvoice', title: input.title, script: input.style,
      sourceText: sourceText.slice(0, 8000), options: myVoiceProjectOptions(input), state: 'queued' });
    return String(p._id);
  },
  update: async job => {
    await KadeSoundBoothProject.updateOne({ _id: job.projectId, user: job.user }, {
      $set: { state: job.state === 'uncertain' ? 'failed' : job.state === 'saving' ? 'running' : job.state,
        lastError: job.error, costUSD: job.costUSD || 0 }, $addToSet: { jobs: job.id },
    });
  },
  notify: async job => {
    const project = await KadeSoundBoothProject.findOne({ _id: job.projectId, user: job.user }).select('title').lean();
    const completed = (job.takes || []).filter(take => take.state === 'done').length;
    const receipt = await notifyMusic(job.user, project?.title || job.input.title || 'Your song', completed, job.takes?.length || 1, job.state !== 'done');
    logger.info(`[soundbooth/myvoice] notification job=${job.id} accepted=${receipt.accepted} deferred=${receipt.deferred === true} blocked=${receipt.blocked || 'none'}`);
    return receipt;
  },
  complete: async job => {
    const project = await KadeSoundBoothProject.findOne({ _id: job.projectId, user: job.user }).select('title').lean();
    const title = project?.title || job.input.title;
    const out = job.output || {};
    const asset = await KadeAsset.findOneAndUpdate({ user: job.user, service: 'runpod_myvoice', 'metadata.jobId': job.id }, {
      $setOnInsert: { user: job.user, service: 'runpod_myvoice', kind: 'audio', url: out.url, model: 'RVC v2 voice model',
        prompt: job.input.style, description: title, costUSD: job.costUSD || 0,
        metadata: { title, jobId: job.id, projectId: job.projectId, via: 'sound-booth', wavUrl: out.wav_url, vocalUrl: out.vocal_url,
          vocalWavUrl: out.vocal_wav_url, seconds: Math.round(out.duration_s || 0), gpu: out.gpu, takeNote: myVoiceTakeNote(out, job.input),
          /* A vocal effect: the voice with it, beside the dry voice (vocalUrl), which is always kept; in vocal mode the take
           * itself is the voice with the effect, so no second link to the same file. */
          ...myVoiceEffectLinks(out),
          voiceSource: job.input.voice && job.input.voice.source, costScope: 'execution estimate; startup and idle are additional' } },
    }, { upsert: true, new: true });
    await KadeSoundBoothProject.updateOne({ _id: job.projectId, user: job.user }, { $addToSet: { assets: String(asset._id) } });
  },
}));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MODEL = process.env.KADE_SOUNDBOOTH_MODEL || 'nousresearch/hermes-4-405b';
const SCRIPT_DAILY_CAP = Number(process.env.KADE_SOUNDBOOTH_SCRIPT_CAP || 40);
const MAX_SCENEMA_CHARS = 4000; // the bridge's own cap; mirrored so we fail early and kindly
const MAX_SEED_CHARS = 2048; // Seed Audio's hard cap per clip
const SEED_USD_PER_MIN = 0.1875; // fal's listed price, read Sep 2 2026 (Part 119.2)
const MAX_LYRIA_CHARS = 3000; // the brief, not the lyrics; Lyria reads a description
/* Sep 25 2026: the words have their own cap, the same 8,000 YuE2 and a carry
 * already use. A 45-65 line song with section tags runs about 2,000-4,000
 * characters; the old render cut Your own lyrics at 4,000 without saying so,
 * and a desk draft that left them inside the brief hit the 3,000 brief cap.
 * Google documents no character cap for lyria-3.5, only a 131,072-token input
 * limit (models page, read Sep 25 2026); the whole wire prompt here is at most
 * about 11,000 characters, a few thousand tokens. */
const MAX_LYRIA_LYRICS_CHARS = 8000;
const LYRIA_USD_PER_SONG = 0.08; // Google bills Lyria 3.5 PER SONG, not per minute

/* ---------- the model id, and the wall everybody walks into ------------------
 * Sep 10 2026, her words: "in the api it's 3-5 which makes people hit a wall a
 * lot of the time." Checked against the live model list on her own key, and it
 * is worse than a typo -- Google broke their own naming on this one model:
 *
 *   lyria-3-clip-preview   hyphen
 *   lyria-3-pro-preview    hyphen
 *   lyria-3.5              DOT
 *   lyria-realtime-exp     hyphen
 *
 * So the habit every sibling model teaches you is the habit that fails, and
 * half the third-party writeups slug it "lyria-3-5" in their URLs on top of
 * that. Rather than being right once and brittle forever, this accepts every
 * spelling a person or an env var could reasonably carry and lands on the one
 * the API answers to. A wrong id is a 404 with no audio and no refund of the
 * person's attention, so the normalizing happens here, once, at the door. */
const LYRIA_KNOWN = ['lyria-3.5', 'lyria-3-pro-preview', 'lyria-3-clip-preview'];
function normalizeLyriaModel(raw) {
  const t = String(raw || '').trim().toLowerCase().replace(/^models\//, '');
  if (!t) return 'lyria-3.5';
  if (LYRIA_KNOWN.includes(t)) return t;
  const digits = t.replace(/[^0-9]/g, '');
  if (/pro/.test(t)) return 'lyria-3-pro-preview';
  if (/clip/.test(t)) return 'lyria-3-clip-preview';
  if (digits === '35') return 'lyria-3.5';
  return 'lyria-3.5';
}
const LYRIA_MODEL = normalizeLyriaModel(process.env.KADE_LYRIA_MODEL);
/* Overridable for the self-test the same way BRIDGE_URL is for the AuK
 * lane -- law 17: production knocks on the same door the bench does. */
function lyriaBase() {
  return (process.env.KADE_LYRIA_BASE || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
}
/* One dedicated key if she ever wants Lyria billed apart from the rest, and
 * the Gemini key already on this service if she does not. */
function lyriaKey() {
  return process.env.KADE_LYRIA_KEY || process.env.KADE_EMBED_GEMINI_KEY ||
    process.env.GEMINI_API_KEY || process.env.KADE_VISION_KEY || '';
}
/* Part 295: which of those it was, by NAME only, for the Google key alarm's line. */
function lyriaKeyName() {
  return ['KADE_LYRIA_KEY', 'KADE_EMBED_GEMINI_KEY', 'GEMINI_API_KEY', 'KADE_VISION_KEY'].find((n) => process.env[n]) || 'none';
}
/* Part 295: a Google refusal that is the key's own trouble (an empty prepaid balance, billing,
 * permission) tells Kade, at most once every few hours. Fire-and-forget, never throws. */
function googleKeyAlarm(lane, error, keyName) {
  try {
    require('~/server/services/kadeGoogleKeyAlarm')
      .reportGoogleKeyTrouble(lane, error, { keyName })
      .catch(() => {});
  } catch (_) {
    /* the alarm must never break a render */
  }
}

function bridgeBase() {
  return (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(
    /\/$/,
    '',
  );
}

/* ---------- a small daily cap on the WRITING desk, not the rendering ---------
 * Rendering is capped in dollars by the bridge (AuK) and the wallet (fal).
 * The script button is cheap but not free, and a stuck client could hammer it,
 * so it gets the same shape of cap the character builder uses. */
let scriptDayStamp = '';
const scriptCounts = new Map();
function scriptCapHit(userId) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  if (scriptDayStamp !== today) {
    scriptDayStamp = today;
    scriptCounts.clear();
  }
  const used = scriptCounts.get(userId) || 0;
  if (used >= SCRIPT_DAILY_CAP) return true;
  scriptCounts.set(userId, used + 1);
  return false;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Spoken words -> rough seconds of audio, at 2.6 words a second.
 *
 * ⚠️ The first live render caught this being wrong: stripping only the TAGS
 * left the words INSIDE a direction in the count, so a two-line script with a
 * long <action> was quoted at 12 seconds and came back 5.3. A direction is
 * never spoken, so the whole block goes before anything is counted -- same for
 * a <sound> line and for Seed Audio's [bracketed] cues. The bridge still
 * counts the old way, which is why the fork's audioSeconds is the one that
 * reaches her. */
function spokenSeconds(script) {
  const words = String(script || '')
    .replace(/<action>[\s\S]*?<\/action>/gi, ' ')
    .replace(/<sound>[\s\S]*?<\/sound>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return { words, seconds: Math.max(1, Math.round(words / 2.6)) };
}

/* ---------- the moods, in her words ----------------------------------------
 * A mood is not a knob on the audio -- it is a note to the ACTOR. AuK's
 * own rule (and the tool description's) is that a direction says what the
 * speaker is DOING and FEELING, never how the recording should sound, so each
 * mood below is written as a person, not as an EQ setting. */
const MOODS = {
  tender: {
    label: 'Tender',
    scenema: 'softening, speaking to someone they love',
    seed: 'warm, unhurried, affectionate',
  },
  wry: {
    label: 'Wry',
    scenema: 'holding back a smile, enjoying the joke they are not telling',
    seed: 'dry, amused, understated',
  },
  urgent: {
    label: 'Urgent',
    scenema: 'leaning in, needing to be understood right now',
    seed: 'fast, pressing, tightly controlled',
  },
  bedtime: {
    label: 'Sleepy bedtime',
    scenema: 'winding down, letting the pace fall away, nearly whispering',
    seed: 'hushed, slow, drowsy',
  },
  matter_of_fact: {
    label: 'Matter of fact',
    scenema: 'plain and level, telling it straight',
    seed: 'even, plain, unhurried',
  },
};

/* ---------- the two grammars, rebuilt from the engines' own documentation ----
 * Part 121 (Sep 3 2026), her ask: "look up everything you can about prompting
 * both, make sure the settings align." Speech now uses github.com/Tencent-Hunyuan/AuK. The XML below
 * remains our internal screenplay interchange, not the AuK API. Seed Audio: fal's llms.txt + the Morphic guide (the
 * SCENE checklist, the `Name (traits) says manner: "line."` shape, spelled-out
 * sounds, @Audio tagging, [start:end] timestamps). Every rule below is one
 * the docs state, not one guessed. */
const SCENEMA_GRAMMAR = `KADE SCREENPLAY INTERCHANGE FORMAT (translated into AuK instructions by our worker):

<speak voice="THE VOICE: who is speaking, in one specific sentence" gender="male|female">
The spoken words, as natural prose.
More spoken words.
</speak>

HOW THIS ENGINE WORKS, so you write for it:
- ONE speaker. Write only the words that speaker says. Do not invent repeated acting directions between sentences.
- THE VOICE. When the request says THE VOICE IS CHOSEN, put that description in voice= exactly as given. When you are writing the words yourself, write every one of them for that speaker: their age, sex and character decide what they talk about, how long their sentences run and which words they know. A young child talks like a young child, never like a grown-up looking back; a grown-up never talks like a small child. If the request does not fit the speaker, keep the speaker and fit the request to them. When no voice is chosen, choose one that suits the request and describe it in voice= in one natural sentence: age, sex, accent, texture and overall delivery.
- With no imported reference, voice= sets the voice for the opening section, and later sections reuse that voice. Keep the voice in the attribute: never among the spoken words, and never as a VOICE: or SEX: line.
- With an imported reference, speech mode follows that recording's voice and accent. Do not claim that a different voice= description or stage direction changes its accent. Changing an existing recording belongs in Edit, then the user can use the edited take as a reference. Adding a new accent is experimental; the documented accent task removes a regional accent.
- Do not add <action> tags of your own, except the one opening direction a picked mood asks for. Existing user-supplied directions can be kept as metadata, but reference-voice speech cannot promise per-line delivery changes. Never turn directions into spoken dialogue.
- Nothing outside a tag is a note; it is SPOKEN ALOUD. No headings, labels, speaker names, or markdown outside a tag.
- Do not add <sound> elements. Generated backgrounds and effects use Seed Audio; this lane performs speech.
- Each segment is at most about 15 seconds; sentences are split there automatically. Keep sentences a natural length.
- Difficult proper nouns get garbled; spell a hard word phonetically inside the spoken text if it matters.
- NEVER use %%%…%%% markers — that is a different engine's syntax and this one would read it out loud. Never leave a cue in parentheses or square brackets on its own line; convert it to an <action>.
- Output the XML and nothing else. No code fence, no preamble.`;

const SEED_GRAMMAR = `SEED AUDIO 1.0 SCRIPT FORMAT (the only format you may output):

Use a brief [Setting: place and audible surroundings] and bracketed sound cues where the sound changes. Music is optional; keep it out when the request excludes it.
For speech, use Name (concise voice traits) says, manner and emotion: "the exact spoken words." Give each voice its traits on its first turn; later turns can use the name and a short delivery cue.
Repeat speaker turns as the piece needs. This is notation, not a fixed plot, a two-line exchange or a checklist that every piece must follow.

HOW THIS ENGINE WORKS, so you write for it:
- It makes a WHOLE SCENE in one pass: voices, music, sound effects, and ambience, mixed. Write the actual piece to perform, not a synopsis of one.
- Keep spoken lines in quotes, separate from directions. Do not substitute a synopsis of people talking for their supplied words.
- For music, ambience or effects without speech, use only the requested sound directions: no voices, narrator, dialogue or sung words. Do not invent speech to fill out the format.
- A speaker's first turn uses the shape: Name (traits) says, manner: "words." Later turns can use Name: "words." or a short delivery cue. The manner goes before the colon — "lowers her voice, flustered:", "coaxes, dragging his words:", "can't help laughing:". Emotion words in parentheses after the name also work: Emma (whispering): "...".
- The whole script, all directions included, must fit within 2,048 characters. Keep setting, repeated voice traits and delivery cues concise so the spoken exchanges have room. When cuts are needed, remove redundant descriptions before meaningful dialogue or the ending. Two minutes is the model's maximum per generation, not a guaranteed duration for a given character count.
- SPELL THE SOUNDS OUT. Onomatopoeia is more reliable than naming: a bell "ring-a-ling" fading from near to far; a blade's "whoom, whoom".
- Music by MOOD, never by music-theory terms.
- Match the language: write the whole prompt in the language the lines are spoken in.
- Keep the cast manageable and the voices distinct. Up to three reference clips may be given as @Audio1, @Audio2, @Audio3 — tag a clip to a speaker inline: Marcus (warm broadcaster, the actor is @Audio1) says: "...".
- Optional exact timing: put [start:end] at the front of a line, e.g. "[5.5s:8.0s] Maya! Wait." and that line is fitted to that window.
- Longer pieces require separate clips; this format does not remove the per-clip limit.
- NEVER use %%%…%%% markers. That is a different engine's syntax. A delivery note goes in parentheses after the name, or as the manner before the colon — nowhere else.
- Output the script and nothing else. No code fence, no preamble.`;

const MUSIC_GRAMMAR = `LYRIA 3.5 MUSIC BRIEF FORMAT (the only format you may output):

Plain prose, a few short sentences, in THIS order. NOT a screenplay, NOT lines of dialogue, NOT XML. This engine reads a description of a piece of music and writes the whole record: arrangement, performance and, if asked, sung words. Google's own prompt guide for it (read September 11 2026) rewards specifics in a fixed order, so write them in that order:

1. GENRE WITH ERA, first and plainly: "1970s Memphis soul", "a 2010s bedroom-pop song", "a modern Nashville country ballad". A genre with a decade beats a feeling. Put the feeling AFTER the genre, never instead of it.
2. INSTRUMENTS you actually want to hear, and what each one does: "a Rhodes piano carries the chords, brushed drums keep it soft, an upright bass walks underneath, a horn section answers the vocal in the last chorus".
3. STRUCTURE as section tags joined by arrows, then a few words on what changes at each: [Intro] -> [Verse 1] -> [Chorus] -> [Verse 2] -> [Chorus] -> [Bridge] -> [Chorus] -> [Outro]. Say what drops out at the bridge, where it lifts, how it ends. For an exact timeline use timestamps instead: [0:00 - 0:10] piano alone, [0:10 - 0:40] the band comes in.
4. VOCAL PROFILE if anyone sings: sex, timbre, range and delivery. "A female vocalist, warm alto, breathy and close to the microphone, confiding rather than belting." "A male tenor, raspy, pushing hard on the chorus."
5. MOOD in two or three adjectives: "melancholy, hopeful, intimate".
6. THE TECHNICAL LINE last: BPM as a number, the key, and the length in plain words. "Around 70 BPM, in D minor, a two-minute song." This engine reads the length from the prompt, so always say how long.

LYRICS: if the person supplied their own words, the booth attaches them under a "Lyrics:" heading after your prose, so do not repeat or paraphrase them. If they did not, either write the words yourself under a final "Lyrics:" heading with [Verse 1] / [Chorus] / [Bridge] tags on their own lines and (parentheses) for echoes and backing vocals, or ask for the mood of the words -- but never quietly invent a subject they did not name.

INSTRUMENTAL: if no one sings, the last line is exactly: Instrumental only, no vocals.

Do not use %%% markers, <speak> tags, or "Name (traits) says:" lines. Those belong to the other two engines and this one will not read them. No code fence, no preamble, no headings other than "Lyrics:".`;

/* Part 293 review. The desk notes say there is no house voice and not to reach for the same shape
 * every time, and her rule is that a prompt may name a shape but never demonstrate one. Three of
 * the samples above did demonstrate one (a warm breathy alto close to the microphone, one fixed
 * section map, a two-minute song), and this grammar sits in the last and weightiest block of every
 * desk draft and audit. So the writing lane gets those three steps described without a sample.
 * Formatting her own words, and Lyria's plain brief, keep the grammar as it was. */
const MUSIC_GRAMMAR_WRITE_STEPS = [
  [/^3\. STRUCTURE.*$/m, '3. STRUCTURE as the section tags this song uses, in order, joined by arrows, then a few words on what changes at each: what drops out, where it lifts, how it ends. For an exact timeline, give each section a [start - end] timestamp instead.'],
  [/^4\. VOCAL PROFILE.*$/m, '4. VOCAL PROFILE if anyone sings: sex, timbre, range and delivery, chosen for this genre and this singer.'],
  [/^6\. THE TECHNICAL LINE.*$/m, '6. THE TECHNICAL LINE last: BPM as a number, the key, and the length in plain words. This engine reads the length from the prompt, so always say how long.'],
];
const MUSIC_GRAMMAR_WRITE = MUSIC_GRAMMAR_WRITE_STEPS.reduce((grammar, [step, plain]) => grammar.replace(step, plain), MUSIC_GRAMMAR);

/* ---- Lyria wire-prompt helpers (Part 179, Sep 11 2026) ---------------------
 * Google's prompt guide wants supplied words under a "Lyrics:" heading with
 * section tags, and the phrase "Instrumental only, no vocals." for an
 * instrumental. The render lane used to append "Sing these exact lyrics,
 * unchanged:" and "Instrumental only. No singing, no vocals, no spoken
 * words.", which Lyria tolerated but the guide never asked for. */
const LYRIA_INSTRUMENTAL_LINE = 'Instrumental only, no vocals.';
const LYRIA_SECTION_TAG_RE = /^\s*\[(?:intro|verse|chorus|pre-chorus|bridge|hook|outro|refrain|interlude|breakdown|solo|drop)[^\]]*\]\s*$/im;

function withLyricsBlock(brief, lyrics) {
  const words = String(lyrics || '').trim();
  if (!words) return brief;
  const body = /^\s*lyrics\s*:/i.test(words) ? words.replace(/^\s*lyrics\s*:\s*/i, '') : words;
  return String(brief || '').trimEnd() + '\n\nLyrics:\n' + body;
}

function withInstrumentalLine(brief) {
  const b = String(brief || '').trimEnd();
  if (/instrumental only,? no vocals/i.test(b)) return b;
  return b + '\n\n' + LYRIA_INSTRUMENTAL_LINE;
}

/* The whole wire prompt: brief, the person's words under "Lyrics:", then the
 * instrumental line last so it wins if both were set.
 *
 * Sep 25 2026: exactly ONE Lyrics block. A desk draft used to leave its words
 * under "Lyrics:" inside the brief on both screens; with the lyrics box also
 * filled, Lyria got two Lyrics blocks. When the box has words, the box wins
 * and the brief's block is taken out. When the box is empty, a Lyrics block in
 * the brief goes as it always did. */
function lyriaWirePrompt(script, { lyrics, instrumental } = {}) {
  let brief = String(script || '');
  if (String(lyrics || '').trim()) {
    const inBrief = carry.splitLyricsBlock(brief);
    if (inBrief.lyrics) brief = inBrief.prose;
    brief = withLyricsBlock(brief, lyrics);
  }
  if (instrumental) brief = withInstrumentalLine(brief);
  return brief;
}

/* Sep 25 2026, her words: "with lyria it's putting lyrics in a style
 * description I think". It was: every sung Lyria take wrote the words it sang
 * into `readback`, the slot every screen reads as "what you will hear" (the
 * phone says exactly that), and the render after it carried the sheet forward
 * even with No singing on. The words now live in `sungLyrics`.
 *
 * This tells a sung-words readback from a real one, so the ones already saved
 * stop showing and stop being carried forward. A real readback is one line:
 * the desk collapses its whitespace, and so does every other path that writes
 * one. A lyric sheet is many lines (13 to 19 in the rows saved before this
 * fix). A readback that is the start of the saved sung words is caught too. */
function readbackIsSungWords(readback, sungLyrics) {
  const r = String(readback || '').trim();
  if (!r) return false;
  if ((r.match(/\n/g) || []).length >= 2) return true;
  const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const sung = flat(sungLyrics);
  return !!sung && flat(r).length >= 20 && sung.startsWith(flat(r));
}

/* What Lyria hands back as "lyrics" carries its own structure markers --
 * [[A0]] [[B1]] section ids and a [:] at the head of every sung line (read
 * off the Part 175 render). Saved raw into readback, VoiceOver reads
 * "left bracket left bracket A zero" to a blind listener. This strips the
 * machine markers and turns any [Verse 1]-style tag into a spoken "Verse 1:"
 * line. The raw text stays in the asset's metadata. */
function cleanLyrics(raw) {
  const text = String(raw || '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return '';
  const out = [];
  for (const line of text.split('\n')) {
    /* Part 175's render carried [[A0]] section ids and a bare [:] per line;
     * the Part 179 render (with the Lyrics: block and responseModalities)
     * came back with a timestamp per line instead -- "[12.8:] The porch
     * light stays on past midnight". Any bracket holding only digits,
     * dots, colons, dashes or spaces is a machine marker, not a word. */
    let l = line
      .replace(/\[\[[^\]]*\]\]/g, ' ')
      .replace(/\[\s*[\d.:\s-]*\]/g, ' ');
    const tag = l.match(/^\s*\[([A-Za-z][A-Za-z0-9 \-']{0,30})\]\s*$/);
    if (tag) l = tag[1].trim() + ':';
    l = l.replace(/[ \t]+/g, ' ').trim();
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function systemPrompt({ engine, mode }) {
  const music = mode === 'write' ? MUSIC_GRAMMAR_WRITE : MUSIC_GRAMMAR;
  const grammar = engine === 'yue2' ? music + '\nFor YuE2, output a short style direction followed by a Lyrics: heading and complete original lyrics with verse and chorus tags. Always provide both. Do not include lyrics in the style paragraph.' : engine === 'lyria' ? music : engine === 'seed' ? SEED_GRAMMAR : SCENEMA_GRAMMAR;
  const job =
    mode === 'write'
      ? (engine === 'lyria' || engine === 'yue2')
        ? `The user has given you a DESCRIPTION of a piece of music they want made. Write the brief for them in the format below. If they did not say how long, make it a full song of about four minutes when it has sung words, or two minutes when it is instrumental, and say so in the technical line. If they asked for singing and gave no words, write the words under the "Lyrics:" heading.`
        : engine === 'seed'
          ? `The user has given you a DESCRIPTION of a piece of audio they want made. Write the actual piece in the format below. Honor their requested form and length, including a short ident, jingle or a single narrated voice. When they ask for a story, scene or conversation with people, and have not asked for narration, a monologue or no dialogue, write a developed scene carried by sustained, natural dialogue, with a complete action and ending. Give the people distinct wants and concrete things to do; let their replies change what happens instead of narrating a synopsis of their conversation. Unless they ask for a short piece, use the available space: usually 1,600 to 2,000 characters including concise directions, within the 2,048-character cap. Vary the action and pacing to suit this particular idea; do not impose a two-turn exchange, an obligatory twist or a stock closing line. For music, ambience or effects without speech, keep it wordless and do not pad the description to reach that character range. Do not claim an exact output duration.`
          : `The user has given you a DESCRIPTION of something they want made. Write it for them: invent the words, keep it the length they asked for (if they did not say, aim for 30 to 60 seconds of speech, which is roughly 80 to 160 words), and shape it into the format below.`
      : engine === 'scenema'
        /* Oct 2 2026: AuK's grammar says no invented directions between sentences, and the
         * old job told the desk to add them there. Her own cues are kept; nothing is added. */
        ? `The user has written THEIR OWN WORDS and wants them formatted. THEIR WORDS ARE THE SCRIPT. Keep every sentence they wrote, in their order, in their wording -- do not rewrite, tighten, improve, correct, or add sentences of your own. A voice line they wrote (VOICE:, SEX:) goes in the <speak> attributes. A delivery cue they wrote in brackets or parentheses on its own line becomes an <action> where they put it. Do not add directions, speaker names, sound effects or pauses of your own, and keep ordinary words in parentheses as spoken words. Nothing about the voice may end up among the spoken words.`
        : `The user has written THEIR OWN WORDS and wants them formatted. THEIR WORDS ARE THE SCRIPT. Keep every sentence they wrote, in their order, in their wording -- do not rewrite, tighten, improve, correct, or add sentences of your own. Your entire job is to wrap their words in the format below and add the structural tags BETWEEN their sentences. If they left cues in parentheses or brackets ("(whispering)", "[thunder]"), convert those into proper tags and remove the prose cue.`;
  const who = engine === 'scenema' ? 'who is speaking (the person in voice=, the same age and sex)' : 'who is speaking';

  return `You are the script desk in Kade-AI's Sound Booth. You turn what a person typed into a script an audio engine can perform.

${job}

${grammar}

AFTER the script, on a new line, output exactly:
READBACK: one or two plain sentences saying what a listener will hear -- ${who}, roughly how long, and where the mood turns. Write it for someone who is blind and will hear this read aloud before they spend money on a render. No markdown, no lists, no jargon, no restating the format.`;
}

function splitScriptAndReadback(raw) {
  /* A callModel reply is { text, ... }; taking the object whole once saved
   * "[object Object]" as a script (Sep 25 2026). Read its text either way. */
  const text = String((raw && typeof raw === 'object' ? raw.text : raw) || '').trim();
  const idx = text.lastIndexOf('READBACK:');
  if (idx === -1) return { script: stripFence(text), readback: '' };
  return {
    script: stripFence(text.slice(0, idx).trim()),
    readback: text
      .slice(idx + 'READBACK:'.length)
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 600),
  };
}

/** Models fence things even when told not to. Take the fence off rather than
 * hand a `\`\`\`xml` line to an engine that will read it out loud. */
function stripFence(s) {
  let t = String(s || '').trim();
  const fence = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence) t = fence[1].trim();
  return t;
}

async function callModel({ system, user, maxTokens = 2200, model = MODEL, temperature = 0.7, top_p, reasoning, timeoutMs = 90000 }) {
  const gatewayUrl =
    process.env.KADE_LLM_GATEWAY_URL ||
    'https://reframe-proxy-production.up.railway.app/chat/completions';
  const key = process.env.REFRAME_PROXY_SECRET || process.env.OPENROUTER_KEY;
  if (!key) {
    const e = new Error('The script desk is not configured on this server.');
    e.status = 503;
    throw e;
  }
  const r = await axios.post(
    gatewayUrl,
    {
      model,
      max_tokens: maxTokens,
      temperature,
      ...(top_p !== undefined ? { top_p } : {}),
      ...(reasoning ? { reasoning } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
    {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': UA },
      timeout: timeoutMs,
    },
  );
  const out = r.data?.choices?.[0]?.message?.content;
  const usage = r.data?.usage || {};
  return { text: String(out || ''), usage, ...writingCost(usage, model, system.length + user.length, String(out || '').length) };
}

/* ---------- AuK XML: build one, and check one ------------------------- */
function wrapSpeak({ body, voice_description, gender, scene, shot, pace, language }) {
  const raw = String(body || '').trim();
  if (/<speak[\s>]/i.test(raw)) return raw;
  /* Oct 2 2026 (review 1): the fallback used to be "Warm, clear adult woman with a natural
   * American accent", which pushed an unnamed AuK voice toward a woman. */
  const voice = String(voice_description || NEUTRAL_VOICE)
    .trim()
    .slice(0, 600);
  const attrs = [`voice="${escapeXml(voice)}"`, `gender="${gender === 'male' ? 'male' : 'female'}"`];
  if (scene) attrs.push(`scene="${escapeXml(String(scene).slice(0, 200))}"`);
  if (['closeup', 'wide', 'scene'].includes(shot)) attrs.push(`shot="${shot}"`);
  /* Part 126: `pace` used to be written here as an ATTRIBUTE. The engine's
   * validator allows exactly {voice, scene, language, gender, shot} on <speak>
   * and fails the whole render on anything else ("Unknown attribute 'pace'").
   * Pace is a REQUEST field and already rides the bridge body; `pace` is kept
   * in the signature so callers do not break, and ignored. */
  void pace;
  if (language) attrs.push(`language="${escapeXml(String(language).slice(0, 40))}"`);
  return `<speak ${attrs.join(' ')}>\n${raw}\n</speak>`;
}

/* ---------- a desk draft, made into AuK XML with the voice in ONE place ------
 * Oct 2 2026, her report: "it writes things in the wrong places like voice
 * descriptions". The desk used to wrap any reply that was not XML as spoken
 * words, so a reply in the screenplay format had its VOICE: and SEX: lines and
 * its [cues] performed aloud (the Oct 1 Codex finding), and a voice line inside
 * the XML body was spoken too. Now every reply ends as the screenplay the
 * script box shows, compiled exactly the way /render compiles that box, so the
 * XML handed back is the XML the render will send, and the desk and the render
 * read one format one way:
 *   - XML (or bare <action>/<sound> pieces, wrapped first) loses tags AuK does
 *     not know (an SSML <break/> or <emphasis> would be read out as text once it
 *     passes through the script box), anything after </speak>, and header lines
 *     inside the body, which move up into the tag;
 *   - a reply with no XML in it is read as a screenplay (headers into the tag,
 *     [brackets] into directions); a cue alone on its line in (parentheses) is
 *     a direction too, as it always was for this desk;
 *   - when she chose a voice, the tag carries HER words for it, and the writer's
 *     own voice= line is handed back separately so the handler can check that the
 *     words were written for the same person. gender= follows the voice when the
 *     voice plainly says (the worker does not read it, but a screen shows it);
 *   - `voice` is empty when the voice came from neither the writer nor her: the
 *     XML then carries the neutral voice, and nothing is put in her voice box as
 *     though someone had chosen it (review 1: bare <action> pieces used to come
 *     back as "Warm, clear adult woman...", which the page put in the box). */
function shapeAukDraft(body, b = {}) {
  let text = String(body || '').trim();
  const notes = [];
  const chosen = String(b.voice_description || '').trim().slice(0, 600);
  let writerVoice = '';
  if (isSpeakXml(text) || /<(?:action|sound)\b/i.test(text)) {
    /* Bare pieces get a bare tag: the settings fill it below, as /render fills a script box. */
    let xml = (isSpeakXml(text) ? text : `<speak>\n${text}\n</speak>`).replace(/(<\/speak>)[\s\S]*$/i, '$1');
    let unknown = /<!--/.test(xml);
    xml = xml.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<\/?([a-zA-Z][\w:-]*)\b[^<>]*>/g, (tag, name) => {
      if (/^(?:speak|action|sound)$/i.test(name)) return tag;
      unknown = true;
      return ' ';
    });
    if (unknown) notes.push('took out markup the engine would have read aloud');
    const own = speakAttrs(xml).voice || '';
    const lifted = liftBodyHeaders(xml);
    if (Object.keys(lifted.lifted).length) {
      xml = lifted.xml;
      notes.push('moved a voice line out of the spoken words');
    }
    writerVoice = own || lifted.lifted.voice || '';
    text = speakToScreenplay(xml);
  } else {
    text = text.replace(/^[ \t]*\((?!\()(.+)\)[ \t]*$/gm, '[$1]');
    writerVoice = parseScreenplay(text).headers.voice || '';
  }
  const compiled = screenplayToSpeak(text, {
    voice: chosen || undefined, gender: b.gender, scene: b.scene, shot: b.shot, language: b.language,
  });
  const cleaned = sanitizeScenema(compiled.xml);
  let script = cleaned.script;
  notes.push(...(compiled.notes || []), ...cleaned.notes);
  if (chosen) script = withSpeakVoice(script, chosen);
  const sex = voiceTraits(chosen || writerVoice).sex;
  if (sex) script = script.replace(/<speak\b[^>]*>/i, (tag) => tag.replace(/\sgender\s*=\s*"[^"]*"/i, ` gender="${sex}"`));
  return { script, notes: [...new Set(notes)], writerVoice, voice: chosen || writerVoice };
}

/** Who the draft was written for, when that plainly is not the voice she chose (her voice= words
 *  against the writer's own voice= line, then against who the readback says is speaking):
 *  { who, by: 'voice'|'readback' }, `by` saying which of the two named someone else, or null. */
function aukVoiceOff(chosen, writerVoice, readback) {
  if (!chosen) return null;
  const byVoice = voicesDisagree(chosen, writerVoice);
  if (byVoice) return { who: byVoice, by: 'voice' };
  const byReadback = voicesDisagree(chosen, speakerClause(readback));
  return byReadback ? { who: byReadback, by: 'readback' } : null;
}

/** What she is told when a draft is still off after the second ask. In "Turn my words into a
 *  script" the words are hers, so a readback that alone names someone else is the description
 *  being off, never her script (review 1). */
function aukVoiceWarning(voiceOff, mode) {
  if (!voiceOff) return '';
  /* Turn my words into a script keeps her words and renders her voice, so a
   * mismatch there can only be the writer's description, whichever caught it. */
  if (mode === 'format') {
    return `The description of what you will hear says ${voiceOff.who} is speaking, but your words are kept as you wrote them and the voice you chose is used. Only that description is off.`;
  }
  return `The writer wrote this for ${voiceOff.who}, not the voice you chose. Ask for the script again, or change the voice, before you generate.`;
}

/* An AuK edit performs no script: the imported recording is changed as the
 * instruction says. The instruction used to be saved as the readback too, so
 * the library read a command out as "What you will hear". */
const EDIT_READBACK_LEAD = 'Your imported recording, edited: ';
function editReadback(instruction) {
  return (EDIT_READBACK_LEAD + String(instruction || '').trim()).slice(0, 600);
}
const flatText = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/* ---------- the %%% scar ----------------------------------------------------
 * FOUND IN THE FIRST LIVE SMOKE (Part 120). Asked to format her words, the
 * model wrote `%%%gentle and low like she is talking to someone half asleep%%%`
 * between the lines -- Inworld's paragraph-tag syntax, which is all over this
 * estate's prompts and personas and which the model has plainly learned.
 *
 * AuK has never heard of it. Anything not inside a tag is SPOKEN, so that
 * line would have been read ALOUD in the finished audio, in the middle of her
 * sentence, and the only way to find that out is to listen to a render she
 * paid for. The structural check could not see it either: `%%%` is not an XML
 * tag, so every bracket balanced and the script "passed".
 *
 * So it is converted, not refused: `%%%…%%%` says exactly what an <action>
 * says, and the model's instinct was right about the CONTENT. Same for a
 * bare parenthetical or bracketed cue sitting alone on its own line, which is
 * how a person writes a stage direction when they are not thinking about tags
 * -- her own probe text had "(softly)" in it.
 *
 * Only ever applied to AuK. Seed Audio's format IS bracketed cues on
 * their own lines, and rewriting those would break the engine that wants them.
 */
function sanitizeScenema(script) {
  let s = String(script || '');
  const notes = [];
  /* Part 126: attributes the engine does not know fail the render. Strip them
   * off the <speak> tag (pace= was the one this booth itself used to write). */
  s = s.replace(/<speak\b([^>]*)>/i, (m, attrs) => {
    let changed = false;
    const kept = String(attrs).replace(/\s+([a-zA-Z_:-]+)\s*=\s*"[^"]*"/g, (a, name) => {
      if (['voice', 'gender', 'scene', 'shot', 'language'].includes(String(name).toLowerCase())) return a;
      changed = true;
      return '';
    });
    if (changed) notes.push('removed a setting from the <speak> line the engine does not accept (pace and the like ride as settings, not in the script)');
    return `<speak${kept}>`;
  });
  // %%%anything%%% -> <action>anything</action>
  s = s.replace(/%%%\s*([^%]+?)\s*%%%/g, (_m, inner) => {
    notes.push('turned a %%% tag into a stage direction');
    return `<action>${inner.trim()}</action>`;
  });
  // A line that is ONLY (a parenthetical) or [a bracket] -> a direction.
  s = s
    .split('\n')
    .map((line) => {
      const t = line.trim();
      const paren = t.match(/^\((.+)\)$/);
      const brack = t.match(/^\[(.+)\]$/);
      if (paren) {
        notes.push('turned a written cue into a stage direction');
        return `<action>${paren[1].trim()}</action>`;
      }
      if (brack) {
        notes.push('turned a written cue into a stage direction');
        return `<action>${brack[1].trim()}</action>`;
      }
      return line;
    })
    .join('\n');
  // Any stray %%% left over (an unpaired one) is deleted rather than spoken.
  if (s.includes('%%%')) {
    s = s.replace(/%%%/g, '');
    notes.push('removed a stray tag marker');
  }
  return { script: s, notes: [...new Set(notes)] };
}

/* Seed Audio's own delivery notes are parentheticals after the speaker and
 * the manner before the colon — so a stray %%%note%%% becomes (note) in place,
 * which Seed reads, instead of being spoken or dropped. Found in the first
 * Seed smoke (Part 121): the model wrote %%%easygoing morning pace%%% between
 * "says, warmly:" and the quoted line. */
function sanitizeSeed(script) {
  let s = String(script || '');
  const notes = [];
  s = s.replace(/%%%\s*([^%]+?)\s*%%%/g, (_m, inner) => {
    notes.push('turned a %%% tag into a delivery note');
    return `(${inner.trim()})`;
  });
  if (s.includes('%%%')) {
    s = s.replace(/%%%/g, '');
    notes.push('removed a stray tag marker');
  }
  return { script: s, notes: [...new Set(notes)] };
}

/** Cheap structural checks so a bad script is refused HERE, in a sentence she
 * can act on, instead of failing on the GPU two minutes and a wake-up later. */
function checkScenema(script, { allowLong = false, allowEmpty = false } = {}) {
  const s = String(script || '').trim();
  if (!/^<speak[\s>]/i.test(s)) return 'A AuK script has to start with a <speak> tag.';
  if (!/<\/speak>\s*$/i.test(s)) return 'A AuK script has to end with </speak>.';
  if (!/voice="/i.test(s)) return 'The <speak> tag needs a voice="..." description.';
  if (s.includes('%%%')) {
    return 'That script still has %%% tag markers in it. AuK would read them out loud — use <action> directions instead.';
  }
  const opens = (s.match(/<action>/gi) || []).length;
  const closes = (s.match(/<\/action>/gi) || []).length;
  if (opens !== closes) return 'One of the <action> directions is missing its closing tag.';
  const sOpens = (s.match(/<sound>/gi) || []).length;
  const sCloses = (s.match(/<\/sound>/gi) || []).length;
  if (sOpens !== sCloses) return 'One of the <sound> lines is missing its closing tag.';
  const spoken = s
    .replace(/<speak[^>]*>/i, '')
    .replace(/<\/speak>/i, '')
    .replace(/<action>[\s\S]*?<\/action>/gi, '')
    .replace(/<sound>[\s\S]*?<\/sound>/gi, '')
    .trim();
  /* allowEmpty is for a PREVIEW: with no script yet, the sample falls back to
   * a plain line, so an empty body is a legitimate thing to audition. Removing
   * the page's old hardcoded "Here is how I sound." left this check refusing
   * the very case the preview button exists for. */
  if (!spoken && !allowEmpty) return 'There are no spoken words in that script — only directions.';
  /* Part 122: length is only a PROBLEM for a caller that cannot split. /render
   * can, so it passes allowLong and the splitter handles it; the script desk
   * still reports it, but as a plan rather than a refusal. */
  if (!allowLong && s.length > MAX_SCENEMA_CHARS) {
    return `That script is ${s.length} characters; one render tops out at ${MAX_SCENEMA_CHARS} (about 600 spoken words), so it will be rendered in parts and joined into one recording.`;
  }
  return null;
}

/* Part 180.3 (Sep 11 2026, her tornado skit): the desk wrote 2,099 characters
 * against Seed's 2,048 cap and the booth called it a PROBLEM and stopped —
 * nothing was sent, nothing was made, and the page had no way forward but
 * "shorten it". Length is a thing the booth can fix by itself. This cuts a
 * long Seed script at the last line break that fits under the cap (a scene
 * line is the unit Seed reads), keeps the closing bracket line if there was
 * one and it fits, and says exactly what it did. Any other structural
 * problem still stops the render. */
function fitSeed(script) {
  const s = String(script || '').trim();
  if (s.length <= MAX_SEED_CHARS) return { script: s, note: null, cut: 0 };
  const lines = s.split('\n');
  const closing = lines.length > 1 && /^\[.*\]$/.test(lines[lines.length - 1].trim()) ? lines.pop().trim() : null;
  const budget = MAX_SEED_CHARS - 8 - (closing ? closing.length + 1 : 0);
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const add = line.length + (kept.length ? 1 : 0);
    if (used + add > budget) break;
    kept.push(line);
    used += add;
  }
  if (kept.length < 2) {
    /* one enormous line: cut at the last sentence end under the budget */
    const flat = lines.join('\n').slice(0, budget);
    const end = Math.max(flat.lastIndexOf('. '), flat.lastIndexOf('." '), flat.lastIndexOf('."'), flat.lastIndexOf('! '), flat.lastIndexOf('? '));
    kept.length = 0;
    kept.push(end > budget / 2 ? flat.slice(0, end + 1) : flat);
  }
  if (closing) kept.push(closing);
  const out = kept.join('\n').trim();
  const dropped = lines.length - (kept.length - (closing ? 1 : 0));
  return {
    script: out,
    cut: s.length - out.length,
    note: `Cut to fit Seed Audio: ${s.length} characters became ${out.length} (the cap is ${MAX_SEED_CHARS}, about two minutes) — ${dropped > 0 ? `the last ${dropped} line${dropped === 1 ? '' : 's'} came off the end` : 'the end of the last line came off'}${closing ? ', the closing sound line kept' : ''}. Read it back before you render.`,
  };
}

function checkSeed(script) {
  const s = String(script || '').trim();
  if (!s) return 'There is nothing to render.';
  if (s.includes('%%%')) {
    return 'That script still has %%% tag markers in it. Seed Audio does not know them — put delivery notes in parentheses after the name instead.';
  }
  if (s.length > MAX_SEED_CHARS) {
    return `That script is ${s.length} characters; Seed Audio tops out at ${MAX_SEED_CHARS} (about two minutes). Shorten it, or render it in parts.`;
  }
  return null;
}

function checkMusic(script, lyrics) {
  const s = String(script || '').trim();
  if (!s) return 'There is nothing to make yet. Describe the piece of music you want.';
  if (s.includes('%%%')) {
    return 'That brief still has %%% tag markers in it. Lyria does not know them - describe the music in plain sentences instead.';
  }
  if (/<speak/i.test(s)) {
    return 'That is an AuK speech script, not a music brief. Lyria reads a description of a piece of music. Switch engines, or describe the music you want.';
  }
  /* Sep 25 2026: the brief cap is for the description. Words left under a
   * "Lyrics:" heading in the brief (an older draft, or the phone before its
   * next build) are measured against the lyrics cap instead, so a full song
   * is not refused by a cap sized for a paragraph. */
  const inBrief = carry.splitLyricsBlock(s);
  if (inBrief.prose.length > MAX_LYRIA_CHARS) {
    return `That brief is ${inBrief.prose.length} characters; Lyria tops out at ${MAX_LYRIA_CHARS} here. Tighten it - the description should be rich, but it is still a description.`;
  }
  const words = String(lyrics || '').trim() || inBrief.lyrics;
  if (words.length > MAX_LYRIA_LYRICS_CHARS) {
    return `Those lyrics are ${words.length} characters; the booth sends Lyria at most ${MAX_LYRIA_LYRICS_CHARS}. Cut a verse or a repeated chorus and try again.`;
  }
  return null;
}

/* ---------- THE GUIDE — one explainer, served to both screens -----------------
 * Her ask (Part 121): "I don't think people will know the difference between
 * seedaudio and scenema, much less how to use the settings and prompt it."
 * So the explanation lives HERE, once, and the phone and the web both render
 * it — a wording fix is one deploy, not two builds. Every line is written to
 * be read aloud. Sources: the AuK README and Seed Audio's own guide. */
const GUIDE = {
  starters: [
    { id: 'stable-cabin', engine: 'stable', title: 'Rain at a wooden cabin', script: 'A continuous natural stereo field recording from inside a small wooden cabin. Gentle rain patters on the roof, a fire softly crackles nearby, and occasional low thunder rolls far away. Cozy enclosed acoustics, distinct quiet layers, no speech, no music.' },
    { id: 'stable-harbor', engine: 'stable', title: 'A quiet harbor', script: 'A continuous natural stereo field recording at a quiet harbor. Small waves lap against wooden pilings in the foreground, rigging gently taps against distant sailboat masts, and occasional seagulls call far away. Soft open-air ambience. No speech, no music.' },
    { id: 'stable-stream', engine: 'stable', title: 'Forest stream', script: 'A continuous natural stereo field recording beside a shallow forest stream. Clear water trickles over stones nearby, leaves rustle gently above, and scattered birds sing in the distance. Calm, spacious, realistic, no speech, no music.' },
  {"id":"lyria-bed","title":"A warm instrumental theme","engine":"lyria","script":"1970s soul instrumental, warm and relaxed. Electric piano carries a four-note melody, rounded bass and brushed drums leave room for a spoken introduction. Start with piano alone, bring in the rhythm section, then finish on a soft resolved chord. About 88 BPM, around 90 seconds. Instrumental only, no vocals."},
  {"id":"lyria-song","title":"An original song with a singer","engine":"lyria","script":"Modern acoustic folk with a hopeful, intimate mood. Fingerpicked guitar, upright bass and soft percussion. A warm alto sings an original song about finding a familiar place after a long journey. [Intro] -> [Verse 1] -> [Chorus] -> [Verse 2] -> [Chorus] -> [Outro]. The chorus opens up with gentle harmonies. Around 92 BPM, about two minutes long."},
  {"id":"radio","title":"Two-person radio mystery","engine":"seed","script":"A 25-second radio mystery in a small train station after closing. Distant rain and a softly humming fluorescent lamp. Two adult voices, naturally timed turns, clear dialogue, no music.\nMara (a dry, low female voice, trying to sound casual): There is a suitcase on platform three.\nEli (a tired male voice, half listening): Then put it in lost property.\nMara (quieter, very certain): I did. Twice.\nA single heavy knock from inside the suitcase. The lamp hum stops.\nEli (fully awake now): Do not pick it up again."},
  {"id":"station","title":"Radio station ID","engine":"seed","script":"A 12-second playful radio station ident. A tight funk bass riff, a dry snare, a short brass answer, clean professional stereo production. One warm adult female announcer, smiling without shouting.\nAnnouncer (confident and friendly): You found the good part of the dial. Fresh tracks, familiar voices, and one more song before you go.\nThe brass repeats a memorable three-note sting. The music ends cleanly."},
  {"id":"story","title":"A story told close up","engine":"scenema","script":"VOICE: A warm adult woman with a low conversational register, a little rasp, and dry humor.\nSEX: female\nSHOT: closeup\n[casual, letting the joke sneak up]\nMy uncle claimed he could fix anything with a butter knife. The toaster disagreed. So did the landlord.\n[more private, affectionate]\nBut when my bike chain came off, he sat on the curb with me until it was back on. Never charged me a thing.\n[amused, certain]\nStill kept the butter knife, though."},
  {"id":"comedy","title":"A small comic meltdown","engine":"scenema","script":"VOICE: An adult male with a clear midrange voice, quick dry delivery, and a stubbornly polite manner.\nSEX: male\nSHOT: closeup\n[carefully courteous]\nI am not upset about the printer.\n[trying to maintain control]\nI am interested in why it printed my resignation when I asked for a shipping label.\n[bright, brittle laugh]\nAnd why it made six copies.\n[quietly conceding]\nThe formatting is excellent."},
  {"id":"atmosphere","title":"A place you can hear","engine":"seed","script":"Twenty seconds of realistic stereo ambience inside a small wooden cabin during a steady evening rain. Rain patters on the roof and trickles down a nearby drain. A small fire settles with occasional gentle crackles. One distant low roll of thunder halfway through. Intimate, natural dynamics, no startling hits, no speech, no singing, no music. Hold the same atmosphere through the end."},
  {"id":"music","title":"A short instrumental bed","engine":"seed","script":"A 20-second instrumental music bed for a relaxed spoken introduction. Warm electric piano plays a simple memorable four-note figure, with rounded bass, brushed drums, and a light muted guitar answer. About 88 BPM, unhurried soul groove, gentle dynamics, plenty of space in the middle for a voice. No vocals, no spoken words, no choir, no abrupt dramatic rise. End on a soft resolved chord."}
],
  /* What the box is holding, and therefore which button exists. The screens
   * render this ABOVE the text box so there is only ever one button. */
  input: {
    question: 'What are you putting in the box?',
    modes: [
      {
        key: 'words',
        label: 'I am writing the words',
        boxLabel: 'The words to perform',
        boxHint: 'Type what you want said, exactly as you want to hear it. Every word here gets spoken.',
        button: 'Turn my words into a script',
        buttonHint: 'Keeps every word you wrote, in your order, and only adds the directions around them.',
      },
      {
        key: 'brief',
        label: 'I am describing what I want',
        boxLabel: 'Describe what you want made',
        boxHint: 'Say what the piece is — "a two minute bedtime story about a fox who is scared of the dark". None of this gets spoken; it is the brief.',
        button: 'Write me one',
        buttonHint: 'Writes the whole piece from your description, then you can edit it.',
      },
    ],
  },
  chooser: {
    question: 'Which engine should I use?',
    answer:
      'Ask yourself what the piece IS. A song — anything sung, or a piece of music that stands on its own — is Lyria. One person reading a story, a letter, a monologue, a bedtime tale, with real acting, is AuK. Two people talking, or a scene with effects and a place you can hear around the voices, is Seed Audio.',
    rules: [
      { pick: 'lyria', when: 'it is a song, or a piece of music that stands on its own' },
      { pick: 'lyria', when: 'somebody sings — start with Lyria for simple, fixed-price songs' },
      { pick: 'lyria', when: 'you want a theme, an intro bed, or something to play under a finished piece' },
      { pick: 'scenema', when: 'one voice and the acting matters — the feeling shifts mid-sentence, it breathes, it pauses' },
      { pick: 'scenema', when: 'you want to clone a specific person from a short clip and use the AuK rendering lane' },
      { pick: 'scenema', when: 'it is longer narration — the booth splits supported scripts into parts' },
      { pick: 'seed', when: 'two or more people talk to each other' },
      { pick: 'seed', when: 'you want music, sound effects, or a place you can hear around the voices' },
      { pick: 'seed', when: 'you need it back in seconds, and it is under two minutes' },
    ],
  },
  engines: {
    // "scenema" remains the stored project/API key for existing clients.
    scenema: {
      name: 'AuK HQ',
      tagline: 'Create a voice or reshape a recording.',
      recipes: [
        { label: 'Design a storyteller voice', task: 'speech', text: 'An adult woman with a warm lower register, a gentle Southern American accent, textured but clear speech, and expressive storytelling inflection.' },
        { label: 'Change mood and inflection', task: 'edit', text: 'Make the delivery cheerful and animated, with expressive inflection. Preserve the words and speaker identity.' },
        { label: 'Try a new accent (experimental)', task: 'edit', text: 'Give the speaker a gentle Southern American accent. Preserve the words and overall voice identity.' },
        { label: 'Remove a regional accent', task: 'edit', text: 'Remove the regional accent while preserving the speaker\'s voice and content.' },
        { label: 'Change voice texture', task: 'edit', text: 'Make the voice warmer and slightly huskier. Preserve the words and timing.' },
        { label: 'Change words', task: 'edit', text: 'Replace "Tuesday" with "Thursday". Preserve the speaker, delivery and all other words.' },
        { label: 'Whisper', task: 'edit', text: 'Turn the speech into a natural whisper. Preserve the words and speaker identity.' },
        { label: 'Adjust pitch', task: 'edit', text: 'Raise the pitch by two semitones while preserving the words and speaking speed.' },
        { label: 'Clean noise and room echo', task: 'edit', text: 'Remove background noise and reverberation. Preserve the voice and every spoken word.' },
        { label: 'Separate speech from background', task: 'edit', text: 'Isolate the main speaking voice and remove background sounds and music. Preserve every spoken word.' },
      ],
      where: 'Runs on a rented GPU that sleeps between jobs. Your recording stays in your library.',
      cost: 'Billed by GPU time, including startup and ten minutes awake after the last job. No total estimate yet.',
      bestFor: ['expressive speech, in a described or imported voice', 'editing the words, mood, pitch or pace of a recording', 'removing noise or echo, or separating a voice'],
      notFor: ['a whole scene with sounds: use Seed Audio', 'exact accents or word edits without listening back'],
      howToWrite: [
        'For speech, put only the words to say in the script. With no reference, Describe a new voice sets the voice.',
        'With a reference, speech uses its voice and accent. For another accent, edit the recording first and use that take as the reference; adding an accent is experimental.',
        'To edit, choose edit under Task, import the recording and write Edit instructions, such as: Remove background noise; Raise pitch by two semitones; Replace one word with another. If the edit changes speed or adds or removes words, set Target seconds for edit.',
        'Long recordings are made in sections and joined, so listen to the joins. Each take keeps a WAV master and an MP3.',
      ],
      /* Part 296: `advanced` settings sit in one collapsed "More settings" group on both screens. */
      settings: [
        { key: 'auk_task', label: 'Task', hint: 'Speech creates a performance. Edit changes the imported recording.', kind: 'choice', options: ['speech', 'edit'], default: 'speech' },
        { key: 'instruction', label: 'Edit instructions', hint: 'What to change and what to keep. Used only for edit.', kind: 'text' },
        { key: 'voice_description', label: 'Describe a new voice (without a reference)', hint: 'Accent, age, texture and delivery, used when no reference is attached.', kind: 'text' },
        { key: 'reference_voice_url', label: 'Import voice or recording', hint: 'Speech copies its voice and accent; Edit changes the recording. WAV, MP3 or M4A.', kind: 'clip', max: 1 },
        { key: 'gen_seconds', label: 'Target seconds for edit', hint: 'Leave blank to keep the length; set it when changing speed or word count.', kind: 'number', min: 0.1, advanced: true },
        { key: 'pace', label: 'Speech pace allowance', hint: 'One is normal; higher is slower, lower is quicker.', kind: 'number', min: 0.5, max: 3, default: 1, advanced: true },
        { key: 'seed', label: 'Seed', hint: 'Reuse a number to repeat a take. A reference keeps a voice steadier than a seed.', kind: 'number', min: 0, max: 4294967295, advanced: true },
      ],
    },
    stable: effectsGuide,
    yue2: {
      name: 'YuE2', tagline: 'Songs with your own lyrics, and covers of a recording.',
      where: 'Runs on a music GPU that sleeps between songs.',
      cost: yueCost,
      bestFor: ['songs with your own lyrics', 'a cover in a new style', 'an arrangement of an ABC score'],
      notFor: ['cloning a singer’s voice', 'an exact copy of the original melody'],
      howToWrite: ['Describe the style, instruments and singing voice in Music direction.', 'Put the exact words under Lyrics, with [Verse] and [Chorus] tags. After importing a cover, Transcribe reference lyrics drafts them for you to correct.', 'A cover takes one recording up to six minutes. YuE2 hears its melody and makes a new arrangement, so listen for wrong notes.', 'A song laid out as Lyrics Box, Tag Box and Negative Tag Box can be pasted whole into Music direction. The booth sorts it and leaves out the Negative Tag Box, because naming things to avoid tends to add them.'],
      settings: [
        { key: 'lyrics', label: 'Lyrics', hint: 'The words to sing, with [Verse] and [Chorus] tags. Write my song idea can draft them.', kind: 'text' },
        { key: 'reference_voice_url', label: 'Recording to cover (optional)', hint: 'Import one song, up to six minutes. Or paste a media link. YuE2 uses its melody, not the singer’s voice.', kind: 'clip', max: 1 },
        { key: 'abc', label: 'Optional composition (ABC)', hint: 'An ABC melody score, used instead of a recording.', kind: 'text', advanced: true },
        /* Part 295: the hint lives in packages/api music/yue.ts (yueStyleHint); /health greys the
         * choice out for anyone outside the Family feature pack (withStyleAccess). */
        ...(yueStylesEnabled() ? [{ key: 'band', label: 'Style', hint: yueStyleHint, kind: 'choice', options: ['none', ...Object.keys(yueStyles)], default: 'none' }] : []),
        /* Shown only while YUE_COVERS_V2 is off; with it on, Keep the original chords covers a score too (yue.ts). */
        { key: 'cot', label: 'Following a score (ABC only)', hint: 'Only for an ABC score; a recording always uses Melody. Melody follows the tune with a new arrangement; Full keeps the chords too.', kind: 'choice', options: ['melody','full'], default: 'melody', advanced: true },
        { key: 'count', label: 'Number of takes', hint: '1 to 4 variations; up to two are made at once. Each take uses more GPU time.', kind: 'number', min: 1, max: 4, step: 1, default: 1 },
        { key: 'weirdness', label: 'Creative variation (weirdness)', hint: '50 is normal. Lower is more predictable; higher is more surprising and can lose its way.', kind: 'range', min: 0, max: 100, step: 1, default: 50, advanced: true },
        { key: 'steps', label: 'Inference steps', hint: '32 is normal. 16 is faster; up to 64 takes longer and is not always better.', kind: 'number', min: 16, max: 64, step: 1, default: 32, advanced: true },
        { key: 'guidance', label: 'Prompt guidance', hint: '1 is normal. Higher follows your direction and lyrics more strictly but can sound less natural.', kind: 'range', min: 1, max: 3, step: 0.1, default: 1, advanced: true },
        { key: 'seed', label: 'Optional seed', hint: 'Leave blank for a new take; reuse a number for a similar start.', kind: 'number', min: 0, max: 2147483647, advanced: true },
      ],
    },
    lyria: {
      name: 'Lyria',
      tagline: 'It writes the song and sings it.',
      where: "Made on Google's servers, so your brief leaves the house.",
      cost: 'About eight cents a song, whatever its length. Usually back in under a minute.',
      bestFor: ['a song with a singer and words', 'an instrumental theme or a bed under a voice', 'a full arrangement in one pass'],
      notFor: ['speech: it sings and plays, it does not read', 'a specific existing voice', 'an exact edit of an earlier take'],
      howToWrite: [
        'Write in this order, one idea per sentence. Genre and era first, such as "1970s Memphis soul", then the feeling.',
        'Then the instruments and what each does: "a Rhodes piano carries the chords, brushed drums keep it soft, horns answer in the last chorus".',
        'Then the shape, as tags with arrows: [Intro] -> [Verse 1] -> [Chorus] -> [Bridge] -> [Outro]. For exact timing use timestamps: [0:00 - 0:10] piano alone.',
        'For a singer, describe the voice: "a warm alto, breathy and close, confiding rather than belting".',
        'End with the mood in two or three words, then BPM, key and length: "Around 70 BPM, in D minor, a two-minute song." Always say how long.',
        'Your own words go in Your own lyrics, with [Verse 1], [Chorus] and [Bridge] on their own lines and backing vocals in (parentheses). Leave it empty and it writes the words.',
        'A song laid out as Lyrics Box, Tag Box and Negative Tag Box can be pasted whole into Music direction. The booth sorts it and leaves out the Negative Tag Box, because naming things to avoid tends to add them.',
        'There is no seed, so the same brief twice gives two different records.',
      ],
      settings: [
        { key: 'instrumental', label: 'No singing', hint: 'Makes an instrumental. Leave it off for a singer.', kind: 'toggle', default: false },
        { key: 'lyrics', label: 'Your own lyrics', hint: 'Words for it to sing, with [Verse 1] and [Chorus] on their own lines. Leave it empty and it writes its own.', kind: 'text' },
        { key: 'keep_lyrics', label: 'Keep the words it wrote', hint: 'Saves the lyrics it wrote with the recording, to read or reuse.', kind: 'toggle', default: true, advanced: true },
      ],
    },
    seed: {
      name: 'Seed Audio',
      tagline: 'A whole scene in one pass.',
      where: "Made on fal's servers, so your words and clips leave the house.",
      cost: 'About nineteen cents a minute. Back in seconds. Up to two minutes a pass.',
      bestFor: ['two or three people talking', 'music, sound effects and a place you can hear', 'a radio play or an ad', 'anything you need back fast'],
      notFor: ['more than two minutes in one pass', 'the finest acting from one voice: use AuK', 'keeping your audio in the house'],
      howToWrite: [
        'Write a short scene brief: the setting, who is there and what they do, the music and sounds, each voice, and the exact lines in quotes.',
        'Each line: the name, the voice in parentheses, how they say it, a colon, then the words. Emma (teenage, soft, shy) lowers her voice: “I still haven’t finished.”',
        'Write long, and spell sounds out: a door "slap", a zipper "zzzip". Whatever you leave out, it decides.',
        'Describe music by mood, not genre: "soft piano that swells".',
        'Write in the language the lines are spoken in, and turn on Multilingual for any language but English. Imported clips are @Audio1 to @Audio3: "the actor is @Audio1".',
      ],
      settings: [
        { key: 'voice', label: 'Preset voice', hint: 'A built-in voice for a single narrator. Leave it off when you describe the voices or import clips.', kind: 'choice', options: ['', 'vivi_mixed_en_zh_ja_es_id', 'mindy_en_es_id_pt_zh', 'kian_en_zh', 'cedric_en_zh', 'sophie_en_zh', 'jean_en_zh', 'magnus_en_zh', 'mabel_en_zh', 'nadia_en_zh', 'opal_en_zh', 'pearl_en_zh', 'quentin_en_zh', 'corinne_mixed_en_zh', 'esther_mixed_en_zh', 'lyla_mixed_en_zh', 'tracy_es_zh', 'sandy_es_mixed_en_zh', 'felix_zh', 'celeste_zh', 'monkey_king_zh'], default: '' },
        { key: 'audio_urls', label: 'Import clips to clone', hint: 'Up to three clean clips, one person each: WAV, MP3, M4A or OGG. An imported clip over 30 seconds is shortened to fit. Name them @Audio1 to @Audio3.', kind: 'clip', max: 3 },
        { key: 'speed', label: 'Speed', hint: 'One is normal, from half to double.', kind: 'number', min: 0.5, max: 2, default: 1, advanced: true },
        { key: 'pitch', label: 'Pitch', hint: 'In semitones: zero is normal; twelve is an octave up, minus twelve an octave down.', kind: 'number', min: -12, max: 12, default: 0, advanced: true },
        { key: 'volume', label: 'Volume', hint: 'One is normal, from half to double.', kind: 'number', min: 0.5, max: 2, default: 1, advanced: true },
        { key: 'multilingual', label: 'Multilingual', hint: 'Turn on for a language other than English, or a mix. Twenty languages.', kind: 'toggle', default: false, advanced: true },
        { key: 'audio_quality', label: 'Studio quality', hint: 'On gives a WAV, off a smaller MP3. Same price.', kind: 'toggle', default: true, advanced: true },
      ],
    },
  },
};

/* ---------- "is this the WORDS, or a DESCRIPTION of them?" -------------------
 * Part 121.1, her question: "do you think users will get confused between
 * write one for me and turn my words into a script?"
 *
 * The buttons are not really the problem. ONE TEXT BOX MEANS TWO DIFFERENT
 * THINGS depending on which one you press, and the box cannot say which it is
 * holding. Type "a bedtime story about a fox who is scared of the dark" and
 * press "Turn my words into a script", and the engine performs those twelve
 * words, out loud, exactly as typed. It succeeds. It costs money. It is not
 * remotely what anyone meant — and for someone listening rather than looking,
 * a plausible script and a plausible read-back come back, so nothing about
 * the result announces the mistake.
 *
 * A silent wrong answer is the failure this platform's record hates most, so:
 * the screens put the choice ABOVE the box (one button at a time, and the box
 * says what it wants), and this is the backstop for a wrong pick — asked as a
 * question, never as a refusal, because the classifier can be wrong and she
 * is allowed to mean it. */
function looksLikeDescription(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  const words = t.split(/\s+/).filter(Boolean).length;
  const reasons = [];
  let score = 0;
  if (/^(write|make|generate|create|do|give)\b/.test(lower)) { score += 3; reasons.push('it starts with an instruction'); }
  if (/\b(write|make|generate|create) me\b/.test(lower)) { score += 3; reasons.push('it asks for something to be made'); }
  if (/^(a|an|the)\s+[\w\s-]{2,40}\b(story|ad|advert|commercial|scene|poem|song|monologue|letter|speech|intro|trailer|jingle|piece|clip|narration)\b/.test(lower)) {
    score += 3; reasons.push('it names a kind of piece rather than saying anything');
  }
  if (/\b\d+\s*(second|sec|minute|min)\b/.test(lower)) { score += 2; reasons.push('it gives a length'); }
  if (/\b(about|for|where|in which|that says)\b/.test(lower) && words < 60) { score += 1; }
  // Signals it IS the words: real sentences, quoted speech, someone addressed.
  const sentences = (t.match(/[.!?]["')\]]?(\s|$)/g) || []).length;
  if (sentences >= 2) { score -= 3; reasons.push('it reads as finished sentences'); }
  if (/["“”]/.test(t)) { score -= 2; }
  if (/\b(i|you|we|my|your)\b/i.test(lower) && sentences >= 1) score -= 1;
  if (words > 80) { score -= 2; }
  if (score < 3) return null;
  return {
    /* Said, not shown — and phrased as a question, because being told you
     * pressed the wrong button is worse than being asked. */
    question:
      `That reads like a description of what you want, not the words themselves — ${reasons.slice(0, 2).join(' and ')}. ` +
      'Pressed this way it will perform that sentence out loud, word for word. Did you mean "Write me one"?',
    reasons,
  };
}

/* A free, instant, explainable answer to "which one?" — read off the text she
 * typed, so the screen can suggest before she spends anything. Not a model
 * call: the reasons have to be sayable, and the same text must always get
 * the same answer. */
function suggestEngine(text) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  const reasons = [];
  let seed = 0;
  let scenema = 0;
  /* Sep 10 2026: music used to score for Seed, because Seed was the only
   * engine that could make any. Now Lyria can make a RECORD, so the word
   * "music" has to be read more carefully than it was: a song, or a piece
   * that stands on its own, is Lyria; music AROUND dialogue is still Seed. */
  let lyria = 0;
  const speakerLines = (t.match(/^\s*[A-Z][a-zA-Z' ]{1,30}\s*(\([^)]*\))?\s*:/gm) || []).length;
  const quotedSpeakers = (t.match(/\b[A-Z][a-z]+ (says|said|asks|asked|replies|replied|answers|whispers|shouts)\b/g) || []).length;
  if (speakerLines >= 2 || quotedSpeakers >= 2) { seed += 3; reasons.push('more than one person talks'); }
  if (/\b(song|sing|sung|singer|vocals?|chorus|verse|hook|lyrics?|anthem|ballad|album|track)\b/.test(lower)) { lyria += 3; reasons.push('it is a song'); }
  if (/\b(instrumental|music bed|theme (tune|song|music)|underscore|beat|melody|groove|bpm)\b/.test(lower)) { lyria += 2; reasons.push('it is a piece of music on its own'); }
  if (/\b(music|soundtrack|jingle|theme|piano|guitar|drums|orchestra|strings)\b/.test(lower)) { seed += 2; lyria += 1; reasons.push('you asked for music'); }
  if (/\b(sound effects?|sfx|thunder|rain|traffic|crowd|footsteps|door|wind|birds|ambience|ambient|background sounds?)\b/.test(lower)) { seed += 1; reasons.push('there are sounds in it'); }
  if (/\b(radio play|radio drama|commercial|advert|ad spot|podcast intro|trailer)\b/.test(lower)) { seed += 2; reasons.push('it is a produced scene'); }
  if (/\b(story|bedtime|chapter|monologue|letter|poem|narrat|read (this|it|me)|audiobook|speech|eulogy|confession|diary)\b/.test(lower)) { scenema += 2; reasons.push('one voice telling or reading'); }
  if (/\b(clone|sounds? like (my|her|his)|in (my|her|his) voice|my (mom|dad|grandma|grandpa|sister|brother)'?s voice)\b/.test(lower)) { scenema += 2; reasons.push('you want a specific person\'s voice'); }
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words > 320) { scenema += 2; reasons.push('it is long — over two minutes'); }
  if (/\b(whisper|breath|pause|voice (breaks|cracks)|tearful|choking up|trembl)\b/.test(lower)) { scenema += 1; reasons.push('the acting matters'); }
  /* Spoken lines in the text mean people TALKING, which is not what Lyria
   * makes, however much music is also named. Dialogue outranks the word
   * "music" every time. */
  if (speakerLines >= 2 || quotedSpeakers >= 2) lyria = 0;
  if (seed === 0 && scenema === 0 && lyria === 0) {
    return { engine: 'scenema', sure: false, reason: 'One voice is the usual case, so AuK. If two people talk or you want a place you can hear, switch to Seed Audio; if it is a song, switch to Lyria.' };
  }
  const NAMES = { lyria: 'Lyria', seed: 'Seed Audio', scenema: 'AuK' };
  const scores = { lyria, seed, scenema };
  const engine = ['lyria', 'seed', 'scenema'].reduce((best, k) => (scores[k] > scores[best] ? k : best), 'scenema');
  const runnerUp = Math.max(...['lyria', 'seed', 'scenema'].filter((k) => k !== engine).map((k) => scores[k]));
  const why = reasons.filter((r) => (engine === 'lyria'
    ? /song|music/.test(r)
    : engine === 'seed'
      ? /person talks|music|sounds|produced/.test(r)
      : /telling|specific person|long|acting/.test(r)));
  return {
    engine,
    sure: scores[engine] - runnerUp >= 2,
    reason: `${NAMES[engine]}, because ${why.join(' and ') || reasons.join(' and ')}.`,
  };
}

/* ---------- what a person pays: the price factor (Part 295) ---------------
 * Her words, Sep 26 2026: "Yes, double everything." Everyone but the
 * administrator pays the platform factor times the real price for a render
 * (logKadeUsage charges it), so every quote, render answer and project price
 * they are shown is multiplied the same way; she is quoted the real price.
 * YuE2 and Stable Audio are trials Kade pays for, so their prices stay real.
 * A test that stubs the module gets 1. */
function priceFactor(user) {
  try {
    return require('../services/kadeRealCost').userPriceFactor(user && user.role);
  } catch (_) {
    return 1;
  }
}
const KADE_PAYS_ENGINES = ['yue2', 'stable', 'myvoice'];
const isKade = (user) => String((user && user.role) || '').toUpperCase() === 'ADMIN';
const priced = (usd, factor) => Math.round(usd * (factor || 1) * 1000) / 1000;

/* ---------- estimates, said out loud before anything is spent ------------- */
function estimateFor(engine, script, factor = 1) {
  const { words, seconds } = spokenSeconds(script);
  if (engine === 'lyria') {
    /* The only per-SONG price in the booth. The brief's length says nothing
     * about how long the record will be, so this deliberately does not guess
     * an audio length it cannot know -- it quotes the flat price and says so.
     * Quoting a fake duration here would be the silent wrong answer this
     * file's own header warns about. */
    const costUSD = priced(LYRIA_USD_PER_SONG, factor);
    return {
      engine: 'lyria',
      words,
      audioSeconds: null,
      renderSeconds: 45,
      costUSD,
      spoken: `About ${Math.round(costUSD * 100)} cents for the song, whatever length it comes out — Lyria is priced per song, not per minute. Usually back in under a minute.`,
    };
  }
  if (engine === 'seed') {
    const costUSD = priced(Math.round((seconds / 60) * SEED_USD_PER_MIN * 1000) / 1000, factor);
    return {
      engine,
      words,
      audioSeconds: seconds,
      renderSeconds: Math.max(10, Math.round(seconds * 0.5)),
      costUSD,
      spoken: sayEstimate(seconds, Math.max(10, Math.round(seconds * 0.5)), costUSD, false),
    };
  }
  const renderSeconds = null;
  const costUSD = null;
  return {
    engine: 'scenema',
    words,
    audioSeconds: seconds,
    renderSeconds,
    costUSD,
    spoken: `AuK HQ has no reliable total price estimate yet. GPU time costs up to $${(Number(process.env.AUK_RATE_PER_HR || 1.22) * (factor || 1)).toFixed(2)} per hour, including startup, processing and ten minutes awake after the last job. This is time the GPU is active, not the length of your recording. Longer work runs in sections.`,
  };
}

/** The guide's price lines at this person's factor; the shared GUIDE is never changed. */
function guidePriced(guide, factor) {
  if (!factor || factor === 1) return guide;
  const cents = (usd) => `${Math.round(usd * factor * 100)} cents`;
  return {
    ...guide,
    engines: {
      ...guide.engines,
      lyria: { ...guide.engines.lyria, cost: `About ${cents(LYRIA_USD_PER_SONG)} a song, whatever its length. Usually back in under a minute.` },
      seed: { ...guide.engines.seed, cost: `About ${cents(SEED_USD_PER_MIN)} a minute. Back in seconds. Up to two minutes a pass.` },
    },
  };
}

/** The estimate as a sentence, because it is read aloud. Her standing rule:
 * the cost is SAID before the render runs, not shown in a corner. */
function sayEstimate(audioS, renderS, costUSD, queued) {
  const len =
    audioS >= 60
      ? `${Math.floor(audioS / 60)} minute${Math.floor(audioS / 60) === 1 ? '' : 's'} ${audioS % 60} seconds`
      : `${audioS} seconds`;
  const wait =
    renderS >= 90
      ? `roughly ${Math.max(1, Math.round(renderS / 60))} minute${Math.round(renderS / 60) === 1 ? '' : 's'}`
      : `about ${renderS} seconds`;
  const cents = Math.round(costUSD * 100);
  const money = cents >= 100 ? `about $${costUSD.toFixed(2)}` : `about ${Math.max(1, cents)} cent${cents === 1 ? '' : 's'}`;
  return `About ${len} of audio, ${wait} to make, ${money}.${queued ? ' Longer if the graphics card has to wake up.' : ''}`;
}

/* ---------- projects ------------------------------------------------------ *
 * A project's TAKES are the finished recordings hanging off it. They are read
 * from the same KadeAsset rows My Creations shows -- not copied -- so a clip
 * has one home and one description. The URL is re-signed at read time exactly
 * as /my-assets does it, which is what lets a phone play a stored link that
 * was signed days ago. */
async function freshAssetUrl(url) {
  let u = String(url || '');
  if (u && !/^https?:\/\//i.test(u) && !u.startsWith('/')) u = '/' + u;
  try {
    if (/[?&]X-Amz-/.test(u) && typeof needsRefresh === 'function' && needsRefresh(u, 3600)) {
      u = await getNewS3URL(u);
    }
  } catch (e) {
    logger.warn('[soundbooth] URL re-sign failed (serving stored URL): ' + e.message);
  }
  return u;
}

// Signing a saved clip again must not turn an unchanged retry into a new take.
function stableOption(value) {
  if (Array.isArray(value)) return value.map(stableOption);
  if (typeof value === 'string' && /[?&]X-Amz-/.test(value)) {
    try { const u = new URL(value); return u.origin + u.pathname; } catch (_) { /* leave malformed input intact */ }
  }
  return value;
}
async function refreshReferences(view) {
  if (view.options?.reference_voice_url) view.options.reference_voice_url = await freshAssetUrl(view.options.reference_voice_url);
  if (Array.isArray(view.options?.audio_urls)) view.options.audio_urls = await Promise.all(view.options.audio_urls.map(freshAssetUrl));
}

/* ---------- linking a AuK take back to its project ----------------------
 * A queued render finishes on the BRIDGE, which posts the MP3 to the fork's
 * /asset-event lane. That lane knows the user and the job, but not the project
 * -- so the asset arrives with `metadata.jobId` and nothing else to hang it
 * on. Rather than teach the bridge about projects (a second service that would
 * then have to be kept in step), the join happens HERE, on read, by job id.
 * Idempotent: an id already on the row is not added twice. */
async function linkJobAssets(projects, userId) {
  const jobIds = [];
  for (const p of projects) for (const j of p.jobs || []) jobIds.push(j);
  if (!jobIds.length) return 0;
  const docs = await KadeAsset.find({ user: userId, 'metadata.jobId': { $in: jobIds } })
    .select('_id metadata')
    .lean();
  if (!docs.length) return 0;
  const byJob = new Map();
  for (const d of docs) byJob.set(String(d.metadata.jobId), String(d._id));
  let linked = 0;
  for (const p of projects) {
    const have = new Set((p.assets || []).map(String));
    const add = [];
    for (const j of p.jobs || []) {
      const id = byJob.get(String(j));
      if (id && !have.has(id)) {
        add.push(id);
        have.add(id);
      }
    }
    if (add.length) {
      p.assets = [...(p.assets || []), ...add];
      linked += add.length;
      try {
        await KadeSoundBoothProject.updateOne({ _id: p._id }, { $set: { assets: p.assets } });
      } catch (e) {
        logger.warn('[soundbooth] take link save failed: ' + e.message);
      }
    }
  }
  return linked;
}

/* Part 295: `paid` (everyone but Kade) shows each take at what its owner paid, the asset's
 * chargedUSD; a take from before Part 295 or a trial Kade pays for has none and shows costUSD. */
async function takesFor(projects, userId, paid = false) {
  const ids = [];
  for (const p of projects) for (const a of p.assets || []) ids.push(a);
  if (!ids.length) return new Map();
  const valid = ids.filter((i) => mongoose.Types.ObjectId.isValid(String(i)));
  if (!valid.length) return new Map();
  const docs = await KadeAsset.find({ _id: { $in: valid }, user: userId })
    .select('_id kind url backupUrl description createdAt costUSD chargedUSD metadata')
    .lean();
  const map = new Map();
  for (const d of docs) {
    map.set(String(d._id), {
      id: String(d._id),
      url: await freshAssetUrl(d.url),
      backupUrl: d.backupUrl ? await freshAssetUrl(d.backupUrl) : '',
      masterUrl: d.metadata?.wavUrl ? await freshAssetUrl(d.metadata.wavUrl) : null,
      scoreUrl: d.metadata?.scoreUrl ? await freshAssetUrl(d.metadata.scoreUrl) : null,
      /* The blind-friendly description the gallery writes, when it has landed
       * yet -- enrichment runs detached, so a brand-new take often has none. */
      title: d.metadata?.title || '',
      description: d.description || '',
      seconds: (d.metadata && (d.metadata.seconds || d.metadata.durationS)) || null,
      costUSD: paid && typeof d.chargedUSD === 'number' ? d.chargedUSD : d.costUSD || 0,
      /* Part 295: a YuE2 take's short note (chords not heard, words that may not fit the tune). */
      note: d.metadata?.takeNote || '',
      createdAt: d.createdAt,
      /* Sep 27 2026, Sing it in my voice: the converted voice on its own, the take a version was made from, and on a source
       * take a word about its automatic version. Only ever on the owner's own takes, and only when there is something to say. */
      ...(d.metadata?.vocalUrl ? { vocalUrl: await freshAssetUrl(d.metadata.vocalUrl) } : {}),
      ...(d.metadata?.vocalFxUrl ? { vocalFxUrl: await freshAssetUrl(d.metadata.vocalFxUrl) } : {}),
      ...(d.metadata?.voiceOf ? { voiceOf: d.metadata.voiceOf } : {}),
      ...(d.metadata?.myVoice?.state === 'queued' ? { voiceNote: 'A version in your voice is being made.' }
        : d.metadata?.myVoice?.state === 'failed' ? { voiceNote: `The version in your voice did not finish. ${d.metadata.myVoice.error || ''}`.trim() } : {}),
    });
  }
  return map;
}

function projectView(p, factor = 1) {
  /* Part 295: stored costs are real; a person is shown what they paid (not for Kade's trials). */
  const paid = KADE_PAYS_ENGINES.includes(p.engine) ? 1 : factor;
  /* Sep 25 2026: a Lyria row saved before sungLyrics existed keeps the sung
   * words in `readback`. Show them as what they are, never as "what you will
   * hear"; on an instrumental project they describe a take it no longer sings,
   * so they are not shown as its words either. */
  const oldSungReadback = p.engine === 'lyria' && readbackIsSungWords(p.readback, p.sungLyrics);
  /* Oct 2 2026: an AuK edit has no script to show; its instruction lives in Edit instructions.
   * A speech project shows its voice in Describe a new voice: `performance` is the script box
   * without header lines and `voice_description` is the voice the script carries. A screen that
   * only knows `screenplay` (iPhone 2.2.2) keeps the VOICE: line when the project has no voice in
   * its settings, because then that line is the only place the voice is. It never gets a SEX:
   * line: the AuK worker does not read gender (review 1). */
  const aukEdit = p.engine === 'scenema' && (p.options || {}).auk_task === 'edit';
  const instruction = aukEdit ? String((p.options || {}).instruction || p.script || '').trim() : '';
  const voiceInSettings = p.engine === 'scenema' && !!String((p.options || {}).voice_description || '').trim();
  return {
    id: String(p._id),
    title: p.title,
    engine: p.engine,
    mode: p.mode,
    sourceText: p.sourceText,
    script: p.script,
    screenplay: p.engine === 'scenema' ? (aukEdit ? '' : speakToScreenplay(p.script || '', { includeHeaders: !voiceInSettings, includeSex: false })) : p.script,
    ...(p.engine === 'scenema' ? {
      performance: aukEdit ? '' : speakToScreenplay(p.script || '', { includeHeaders: false }),
      voice_description: aukEdit ? '' : speakAttrs(p.script).voice || '',
    } : {}),
    /* A Lyria row is a brief, not a script; there is no screenplay view of it. */
    /* Part 126 (carried ask): a library row says what made it and why, so an
     * old project explains itself instead of leaving her to guess. */
    why: p.engine === 'stable' ? effectsVariant(p.options).name + ' — sound effects and ambience' : p.engine === 'myvoice' ? myVoiceProjectWhy(p.options) : p.engine === 'yue2' ? yueProjectWhy(p.options) : p.engine === 'lyria'
      ? 'Lyria — a song made from a brief' + ((p.options || {}).instrumental ? ', instrumental' : '') + ((p.options || {}).lyrics ? ', to your own lyrics' : '')
      : p.engine === 'seed'
      ? 'Seed Audio — a whole scene in one pass' + ((p.options || {}).audio_urls && p.options.audio_urls.length ? `, cloning ${p.options.audio_urls.length} clip${p.options.audio_urls.length === 1 ? '' : 's'}` : '')
      : aukEdit ? 'AuK — an edit of an imported recording'
      : 'AuK — one actor performing' + ((p.options || {}).reference_voice_url ? ', cloning a clip' : ', voice from the description') + (Number.isInteger(p.voiceSeed) ? `, voice ${p.voiceSeed}` : ''),
    /* Edits saved before Oct 2 2026 kept the bare instruction here. */
    readback: oldSungReadback ? '' : aukEdit && p.readback && flatText(p.readback) === flatText(instruction) ? editReadback(instruction) : p.readback,
    /* Lyria: the words the latest take sang ("Words it sang" on the web). */
    sungLyrics: p.sungLyrics || (oldSungReadback && !(p.options || {}).instrumental ? p.readback : '') || '',
    /* Part 296: a YuE2 score opens with its chords choice under Keep the original chords (yue.ts). */
    options: p.engine === 'stable' ? { ...p.options, soundModel: p.options?.soundModel || '3_small_sfx' } : p.engine === 'yue2' ? yueSavedOptions(p.options || {}) : p.options || {},
    /* Where this one could go next, so a client never has to know the rules. */
    carryTo: carry.destinationsFor(p.engine),
    carriedFrom: (p.options || {}).carriedFrom || null,
    voiceSeed: p.voiceSeed,
    hasRecoverableAudio: (p.parts || []).some((part) => part.state === 'done' && part.url) || (p.assets || []).length > 0,
    parts: (p.parts || []).map(({ index, state, durationS, costUSD }) => ({ index, state, durationS, costUSD: typeof costUSD === 'number' ? priced(costUSD, paid) : costUSD })),
    jobs: p.jobs || [],
    assets: p.assets || [],
    state: p.state,
    lastError: p.lastError || null,
    /* Sep 27 2026: a YuE2 project's versions in her voice are paid apart from its takes (voiceCostUSD) and counted here. */
    costUSD: priced((p.costUSD || 0) + (p.voiceCostUSD || 0), paid),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    lastRenderAt: p.lastRenderAt || null,
  };
}

function titleFrom(script, fallback) {
  const words = String(script || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 7)
    .join(' ');
  return (words || fallback || 'Untitled').slice(0, 80);
}

/* ============================ POST /script ================================ */
/* Part 218: the deep lane. A sung draft asked for with background:true becomes a
 * job: the request returns at once, the writer takes the minutes it needs, and
 * the page or phone asks GET /script/job/:id until it is done. Jobs live in
 * memory for an hour; a restart loses one and the client says so plainly. */
const scriptJobs = new Map();
const SCRIPT_JOB_TTL_MS = 60 * 60 * 1000;
function sweepScriptJobs() {
  const now = Date.now();
  for (const [id, job] of scriptJobs) if (now - job.started > SCRIPT_JOB_TTL_MS) scriptJobs.delete(id);
}
async function notifyDraft(userId, ok) {
  const secret = process.env.BRIDGE_SECRET;
  if (!secret) return;
  await axios.post(
    `${bridgeBase()}/notify`,
    {
      secret,
      userId: String(userId),
      agentId: 'soundbooth',
      agentName: 'Sound Booth',
      title: ok ? 'Your song draft is ready' : 'Your song draft did not finish',
      body: ok ? 'The lyrics are waiting in the Sound Booth. Nothing has been recorded yet.' : 'The writer could not finish. Your idea is kept; try again.',
      urgent: false,
      requested: true,
      route: 'sound-booth',
    },
    { headers: { 'User-Agent': UA }, timeout: 15000 },
  );
}

router.post('/script', requireJwtAuth, express.json({ limit: '128kb' }), (req, res) => {
  const b = req.body || {};
  const deep = b.background === true && b.mode === 'write' && ['lyria', 'yue2'].includes(b.engine) && String(b.text || '').trim().length >= 3;
  /* A pasted three-box song needs no writer, so it is answered at once. */
  if (!deep || songPaste.splitSongPaste(b.text)) return scriptHandler(req, res);
  sweepScriptJobs();
  const userId = String(req.user.id);
  for (const job of scriptJobs.values()) {
    if (job.userId === userId && job.state === 'working') {
      return res.status(409).json({ error: 'The writer is already working on a song for you. Wait for that draft first.', job: job.id });
    }
  }
  const id = require('crypto').randomBytes(12).toString('hex');
  const job = { id, userId, state: 'working', started: Date.now(), result: null, error: null };
  scriptJobs.set(id, job);
  const shim = {
    code: 200,
    status(code) { this.code = code; return this; },
    json(body) {
      job.ms = Date.now() - job.started;
      if (this.code >= 400) { job.state = 'failed'; job.error = (body && body.error) || 'The script desk had trouble. Try again.'; }
      else { job.state = 'done'; job.result = body; }
      return this;
    },
  };
  scriptHandler(req, shim)
    .catch((e) => { job.state = 'failed'; job.error = 'The script desk had trouble. Try again.'; logger.error('[soundbooth/script] deep job crashed:', e); })
    .then(() => { if (b.notify !== false) return notifyDraft(userId, job.state === 'done'); })
    .catch((e) => logger.warn('[soundbooth/script] draft notice failed: ' + e.message));
  return res.status(202).json({ job: id, state: 'working', spoken: 'The writer has your idea and is taking its time, about five minutes. You can leave this page; you will get a notice when the draft is ready.' });
});

router.get('/script/job/:id', requireJwtAuth, (req, res) => {
  const job = scriptJobs.get(String(req.params.id));
  if (!job || job.userId !== String(req.user.id)) {
    return res.status(404).json({ error: 'That draft is gone. The server restarted while the writer was working. Your idea is kept; try again.' });
  }
  if (job.state === 'done') return res.json({ state: 'done', seconds: Math.round(job.ms / 1000), result: job.result });
  if (job.state === 'failed') return res.json({ state: 'failed', error: job.error });
  return res.json({ state: 'working', seconds: Math.round((Date.now() - job.started) / 1000) });
});

/* Sep 25 2026: a song pasted whole from ChatGPT's three boxes is already
 * written. It is sorted here with no model call, no charge and no draft
 * counted against the day, and handed back in the same "direction, then
 * Lyrics:" shape both screens already split into their two boxes. The
 * Negative Tag Box goes nowhere (see kadeSoundBoothPaste.js). */
function songPasteScriptResult(engine, mode, pasted, b, field = 'script', factor = 1) {
  /* Pasted as the text to write up, whatever sat above its first heading is
   * the direction she had; pasted into the lyrics box, the text is her
   * direction and whatever sat above the heading there is her words. The
   * words go back to her editor, not to an engine, so with No singing on
   * they are held there rather than dropped (the page does the same). */
  const existingLyrics = typeof b.lyrics === 'string' ? b.lyrics : '';
  const placed = songPaste.placeSongPaste(pasted, {
    field,
    direction: field === 'lyrics' ? String(b.text || '') : pasted.before,
    lyrics: field === 'lyrics' ? pasted.before : existingLyrics,
    instrumental: b.instrumental === true,
    holdLyrics: true,
  });
  const draft = songPaste.songPasteDraft({ tags: placed.script, lyrics: pasted.lyrics ? placed.lyrics : '' });
  const direction = placed.script.replace(/\s+/g, ' ').trim();
  const readback = (direction.match(/^(?:[^.!?]+[.!?]){1,2}/) || [direction])[0].trim().slice(0, 400);
  const problem = engine === 'lyria'
    ? checkMusic(placed.script, placed.lyrics)
    : !placed.lyrics.trim() ? 'YuE2 will not sing without words, and the paste had no Lyrics Box. Add the words under Lyrics before you generate.' : null;
  return {
    engine,
    mode,
    script: draft,
    screenplay: draft,
    readback,
    estimate: engine === 'yue2' ? { spoken: 'The draft is ready. Generating the song is a separate paid action.' } : estimateFor('lyria', placed.script, factor),
    problem,
    repairs: [],
    mismatch: null,
    pasted: true,
    note: placed.note + ' Nothing was sent to the writer, and nothing was charged.',
  };
}

/** How many [Verse] sections a draft's sung words have (tags below "Lyrics:", before READBACK),
 *  counted the way lyricShapeIssue counts them. */
function verseCount(script) {
  const text = String(script || '');
  const at = text.search(/^\s*lyrics\s*:/im);
  if (at === -1) return 0;
  let verses = 0;
  for (const raw of text.slice(at).split('\n').slice(1)) {
    const line = raw.trim();
    if (/^READBACK:/i.test(line)) break;
    const tag = /^\[([^\]]*)\]$/.exec(line);
    if (tag && /^\s*verse/i.test(tag[1])) verses += 1;
  }
  return verses;
}

async function scriptHandler(req, res) {
  try {
    let b = req.body || {};
    const engine = ['seed', 'lyria', 'yue2'].includes(b.engine) ? b.engine : 'scenema';
    const mode = b.mode === 'write' ? 'write' : 'format';
    /* A whole song pasted into the lyrics box: with no idea to write up it is
     * answered as a paste; with one, the writer gets only the Lyrics Box as her
     * words (never the headings or the negative tags), and the answer says so
     * and hands back the sorted words (`pasteSorted`). */
    let lyricsPaste = null;
    if (engine === 'lyria' || engine === 'yue2') {
      const pasted = songPaste.splitSongPaste(b.text);
      if (pasted) {
        logger.info(`[soundbooth/script] ${engine}/${mode} user=${req.user.id} pasted song sorted without the writer: boxes=${pasted.boxes.join(',')}`);
        return res.json(songPasteScriptResult(engine, mode, pasted, b, 'script', priceFactor(req.user)));
      }
      const pastedWords = songPaste.splitSongPaste(b.lyrics);
      if (pastedWords) {
        logger.info(`[soundbooth/script] ${engine}/${mode} user=${req.user.id} song pasted into the lyrics box sorted: boxes=${pastedWords.boxes.join(',')}`);
        if (String(b.text || '').trim().length < 3) {
          return res.json(songPasteScriptResult(engine, mode, pastedWords, b, 'lyrics', priceFactor(req.user)));
        }
        lyricsPaste = songPaste.placeSongPaste(pastedWords, {
          field: 'lyrics', direction: String(b.text || ''), lyrics: pastedWords.before, holdLyrics: true,
        });
        b = { ...b, lyrics: lyricsPaste.lyrics };
      }
    }
    const text = String(b.text || '').trim().slice(0, 6000);
    if (text.length < 3) {
      return res.status(400).json({
        error:
          mode === 'write'
            ? 'Say what you want made — even one sentence is enough.'
            : 'Type the words you want performed first.',
      });
    }
    if (scriptCapHit(req.user.id)) {
      return res
        .status(429)
        .json({ error: `That's ${SCRIPT_DAILY_CAP} scripts today — the writing desk reopens tomorrow.` });
    }

    /* The backstop: formatting a brief performs the brief. Ask, do not refuse. */
    const mismatch = mode === 'format' ? looksLikeDescription(text) : null;

    const mood = MOODS[b.mood] || null;
    const lines = [];
    lines.push(mode === 'write' ? `WHAT THEY WANT MADE:\n${text}` : `THEIR WORDS:\n${text}`);
    if (['lyria', 'yue2'].includes(engine) && typeof b.lyrics === 'string' && b.lyrics.trim()) {
      lines.push(`THEIR EXISTING LYRICS: Keep these words exactly and shape the music around them.\n${b.lyrics.slice(0, 8000)}`);
    }
    /* Oct 2 2026: AuK's voice is a sentence she wrote (or picked off the voice wheel). The desk
     * used to get it as "WHO IS SPEAKING" beside a template slot of the same name, and on Oct 1
     * it wrote a grown woman's story, voice line and readback for a voice described as a little
     * girl around five. It is now said as a fixed choice the words are written for. Neither
     * screen has a sex setting for AuK, so both always sent "female", which pushed every voice
     * the desk chose toward a woman; for AuK that line is left out and the voice says it. */
    const aukVoice = engine === 'scenema' ? String(b.voice_description || '').trim().slice(0, 600) : '';
    const aukReference = engine === 'scenema' && !!(b.reference_voice_url || (Array.isArray(b.audio_urls) && b.audio_urls.length));
    if (engine === 'scenema') {
      if (aukVoice && aukReference) {
        /* Review 1: with a clip the worker clones the clip and never reads voice=, so the box is
         * a note about who is speaking, not a voice the draft can be held to. */
        lines.push(`THE SPEAKER, AS DESCRIBED: ${aukVoice}\nThe reference clip supplies the voice itself. Put this description in voice= as written, ${mode === 'write' ? 'and let the words suit this speaker.' : 'and keep their words as they are.'}`);
      } else if (aukVoice) {
        lines.push(`THE VOICE IS CHOSEN: ${aukVoice}\nPut it in voice= exactly as written. ${mode === 'write' ? 'Write every word for this speaker, at their age,' : 'Keep their words as they are,'} and make the READBACK name this same speaker.`);
      } else if (!aukReference) {
        lines.push('THE VOICE IS NOT CHOSEN YET: choose the voice that suits this and describe it in voice=.');
      }
    } else if (b.voice_description) {
      lines.push(`WHO IS SPEAKING: ${String(b.voice_description).slice(0, 600)}`);
    }
    if (engine !== 'scenema' && (b.gender === 'male' || b.gender === 'female')) lines.push(`VOICE SEX: ${b.gender}`);
    if (mood) {
      /* AuK's grammar forbids directions between sentences, and this line used to ask for them. */
      const moodUse = engine !== 'scenema' ? 'Work this into the directions.'
        : aukReference ? 'The imported recording sets the delivery, so let the words suit this mood and add no directions.'
        : 'Give it once, as one short <action> direction before the first spoken word: not between sentences, and never as spoken words.';
      lines.push(
        `MOOD THEY PICKED: ${mood.label} — ${engine === 'seed' ? mood.seed : mood.scenema}. ${moodUse}`,
      );
    }
    if (b.scene) lines.push(`SCENE: ${String(b.scene).slice(0, 200)}`);
    if (['closeup', 'wide', 'scene'].includes(b.shot)) lines.push(`SHOT: ${b.shot}`);
    if (engine === 'seed') {
      const n = Array.isArray(b.audio_urls) ? Math.min(3, b.audio_urls.filter((u) => /^https?:\/\//i.test(String(u))).length) : 0;
      if (n > 0) {
        lines.push(`REFERENCE CLIPS IMPORTED: ${n}. Tag them to speakers in the script as @Audio1${n > 1 ? ', @Audio2' : ''}${n > 2 ? ', @Audio3' : ''} ("the actor is @Audio1").`);
      }
      if (b.language && b.language !== 'en') lines.push(`LANGUAGE: ${String(b.language).slice(0, 40)} — write the whole prompt in it.`);
    } else if (aukReference) {
      /* The worker's reference mode says only "the same voice" and the words; voice= and any
       * direction are not read at all (auk_contract.py model_instruction). */
      lines.push('A REFERENCE CLIP WILL BE CLONED: the clip supplies the voice, accent and delivery. Write only the spoken words; voice= does not change that recording. Do not add per-line acting directions or promise an accent change.');
    } else if (b.reference_voice_url) {
      lines.push('A REFERENCE CLIP WILL BE CLONED: the clip supplies the identity, so spend the voice= description on the CHARACTER and the emotional archetype rather than on physical timbre.');
    }

    const started = Date.now();
    const writingSettings = musicWritingSettings({ engine, mode, patient: b.patient === true, deep: b.background === true });
    /* Part 216: the kill scan. Only for lyrics the desk originated -- supplied
     * lyrics are hers and are never scanned or touched. */
    const ownsLyrics = !!writingSettings.model && !(typeof b.lyrics === 'string' && b.lyrics.trim());
    const wantsWords = ownsLyrics && !/\binstrumental\b|\bno (?:vocals|singing|lyrics)\b/i.test(text);
    /* Part 293 follow-up: a list of shapes in the prompt came back as one house shape
     * ([Final Chorus] in 10 of 10 songs), so the desk draws ONE section map per request,
     * seeded by the idea, who asked and when (asking again draws again), and the length
     * check below holds the song to that same map. None when the brief sets its own shape. */
    const sectionMap = wantsWords && typeof songSectionMap === 'function' ? songSectionMap(text, `${req.user.id}\n${started}`) : null;
    if (sectionMap) lines.splice(1, 0, sectionMapNote(sectionMap));
    /* Part 296: her "the chorus is horrible... over and over, nothing else". One chorus
     * shape drawn in code with the same salt, said in words under the map. None for the
     * story song's refrain or a brief that asks for a chant or no chorus.
     * KADE_LYRIC_REPEATS=0 stands down the shape, the audit's REPEATS gate and the rewrite. */
    const repeatsOn = wantsWords && process.env.KADE_LYRIC_REPEATS !== '0';
    const chorusShape = repeatsOn && typeof chorusShapeFor === 'function' ? chorusShapeFor(text, `${req.user.id}\n${started}`, sectionMap) : null;
    if (chorusShape) lines.splice(sectionMap ? 2 : 1, 0, chorusShapeNote(chorusShape, sectionMap));
    /* Part 293: who the song is for. A grown-up's desk is told explicit lyrics
     * are welcome; the child, the App Review seat, the Kids choir style and
     * anyone unknown get a clean note. Never throws; fails clean. The audit
     * below reuses this same system prompt, so it keeps the same note. */
    const audience = mode === 'write' && ['lyria', 'yue2'].includes(engine) ? await songAudience(req.user, { band: b.band }) : null;
    const writingSystem = await musicWritingPrompt(systemPrompt({ engine, mode }), { engine, mode }, getAgent, audience);
    const first = await callModel({
      ...writingSettings,
      system: writingSystem,
      user: lines.join('\n\n'),
      maxTokens: writingSettings.maxTokens || (engine === 'seed' ? 1200 : 2200),
    });
    let raw = first.text;
    const usage = first.usage;
    let totalCost = first.costUSD;
    let costMeasured = first.measured;
    let repairs = [];
    /* One surgical rewrite of the flagged lines, and only if it fits inside what
     * is left of the phone's patience; a draft with a Tuesday in it still beats
     * a timeout. Seen once in testing: the writer answered with only a
     * one-paragraph description and no song. A sung request that comes back
     * without a Lyrics: heading is a failed draft, not something to hand her;
     * ask once more. */
    if (wantsWords && !/^\s*lyrics\s*:/im.test(raw) && (writingSettings.timeoutMs || 0) - (Date.now() - started) >= 45000) {
      try {
        const again = await callModel({
          ...writingSettings,
          system: writingSystem,
          user: lines.join('\n\n') + '\n\nWrite the complete draft now: the music direction, then the Lyrics: heading with every sung line, then the READBACK line.',
          maxTokens: writingSettings.maxTokens,
          timeoutMs: (writingSettings.timeoutMs || 0) - (Date.now() - started) - 4000,
        });
        totalCost += again.costUSD;
        costMeasured = costMeasured && again.measured;
        if (/^\s*lyrics\s*:/im.test(again.text)) raw = again.text;
      } catch (e) {
        logger.warn('[soundbooth/script] retry for missing lyrics failed: ' + e.message);
      }
    }
    if (ownsLyrics) raw = labelReadback(raw);
    let tells = ownsLyrics && typeof lyricTells === 'function' ? lyricTells(raw, text) : [];
    /* Part 238: Jev reads the same sung lines and gives the word list a second
     * opinion — it vetoes a flag on a line that is plainly hers ("I scrubbed
     * the truck bed clean") and flags stock writing the list has no word for
     * ("the weight of everything we never said"). Costs well under a tenth of
     * a cent a song. Fails OPEN: if Jev is off, slow or broken the word list's
     * answer stands untouched, which is exactly the behaviour before this. */
    if (ownsLyrics) {
      try {
        const before = tells;
        const r = await jevJudges.lyricTellsJev(raw, before);
        tells = r.tells;
        jevJudges.lyricTellsLog(before, tells, { asked: r.asked, costUSD: r.costUSD, log: (m) => logger.info(m) });
      } catch (e) {
        logger.warn('[soundbooth/script] jev tell pass skipped: ' + e.message);
      }
    }
    /* Part 293 follow-up: a tidy moral ending in the last four sung lines is not "stock
     * writing", which is all Jev is asked about, so no Jev veto can drop one. */
    if (ownsLyrics && typeof lyricEndingTells === 'function') {
      const flagged = new Set(tells.map((t) => t.line));
      tells = [...tells, ...lyricEndingTells(raw, text).filter((t) => !flagged.has(t.line))];
    }
    /* Part 296 follow-up: her "keep your this, keep your that, I don't need blah blah blah". A
     * kiss-off line is often concrete (a tip jar, the keys), which Jev reads as not stock, so
     * no Jev veto can drop one either. Counted before and after for the log and the ledger. */
    const kissOffsOf = (script) => (ownsLyrics && typeof lyricKissOffTells === 'function' ? lyricKissOffTells(script, text) : []);
    const kissOffsInDraft = kissOffsOf(raw);
    if (kissOffsInDraft.length) {
      const flagged = new Set(tells.map((t) => t.line));
      tells = [...tells, ...kissOffsInDraft.filter((t) => !flagged.has(t.line))];
    }
    /* Part 293 review: a clean song is held to clean in code, not by the prompt alone (the hit
     * system in the same prompt says profanity is on by default). Every sung line the desk wrote
     * with a swear or sexual word joins the flagged lines, after Jev so no veto can drop it, and
     * the audit rewrites it; a draft that still has one is refused below. */
    const swearing = (script) => (ownsLyrics && audience === 'clean' ? explicitSungLines(script) : []);
    if (ownsLyrics && audience === 'clean') {
      const flagged = new Set(tells.map((t) => t.line));
      tells = [...tells, ...swearing(raw).filter((t) => !flagged.has(t.line))];
    }
    const shape = wantsWords ? lyricShapeIssue(raw, text, sectionMap) : null;
    /* Part 296: what repeats instead of saying something, measured in code, rides into the
     * audit as its own gate (the audit used to be told the hook lands four to eight times
     * and left every collapsed chorus alone). */
    const measuresRepeats = repeatsOn && typeof lyricRepeatIssues === 'function';
    const repeatsInDraft = measuresRepeats ? lyricRepeatIssues(raw, text) : [];
    const timeLeft = (writingSettings.timeoutMs || 0) - (Date.now() - started) - 4000;
    /* Part 217: every originated song gets the producer's audit when there is time
     * for it; flagged tells and a missing verse ride in the same call. */
    if (wantsWords && timeLeft >= 45000) {
      try {
        const fixed = await callModel({
          ...writingSettings,
          system: writingSystem,
          user: lyricAuditRequest(raw, tells, shape, repeatsInDraft, text),
          maxTokens: writingSettings.maxTokens,
          /* the deep lane thinks hard on the draft; the audit is an edit, not a rewrite */
          reasoning: writingSettings.reasoning ? { ...writingSettings.reasoning, effort: 'low' } : undefined,
          timeoutMs: Math.min(timeLeft, 225000),
        });
        totalCost += fixed.costUSD;
        costMeasured = costMeasured && fixed.measured;
        /* Only the sung words come from the repair; her direction and READBACK
         * stay exactly as first written (the repair is careless with them). */
        const merged = mergeRepairedLyrics(raw, fixed.text);
        const swore = swearing(raw).length;
        const stillSwears = merged ? swearing(merged).length : swore;
        const remaining = merged ? lyricTells(merged, text).length + stillSwears : tells.length;
        const grew = !!merged && !!shape && !lyricShapeIssue(merged, text, sectionMap);
        logger.info(`[soundbooth/script] audit: merged=${!!merged} tells ${tells.length}->${remaining} kissoff ${kissOffsInDraft.length}->${merged ? kissOffsOf(merged).length : kissOffsInDraft.length} shape=${shape ? 'short' : 'ok'} map=${sectionMap ? sectionMap.id : 'none'} grew=${grew} ${Date.now() - started}ms`);
        if (merged && remaining <= tells.length) {
          const versesBefore = verseCount(raw);
          const versesAfter = verseCount(merged);
          raw = merged;
          repairs = [...repairs, "second pass: the producer's audit"];
          const stock = tells.length - swore - (remaining - stillSwears);
          if (stock > 0) repairs = [...repairs, `rewrote ${stock} line${stock === 1 ? '' : 's'} that leaned on stock images`];
          if (stillSwears < swore) repairs = [...repairs, `made ${swore - stillSwears} line${swore - stillSwears === 1 ? '' : 's'} clean`];
          /* Two short verses grown into two long ones is not a third verse (review). */
          if (grew) repairs = [...repairs, versesAfter <= versesBefore ? 'lengthened the verses' : versesAfter - versesBefore > 1 ? 'added verses' : versesAfter === 3 ? 'added a third verse' : 'added a verse'];
        }
      } catch (e) {
        logger.warn('[soundbooth/script] tell repair skipped (first draft kept): ' + e.message);
      }
    }
    /* Part 296: a chorus still sung over and over, or lines still opening the same way,
     * after the audit get ONE targeted rewrite of just those sections, written in by code
     * (a new chorus into every pass). It is kept only if it weighs less on the same gate,
     * adds no stock-image line and, for a clean song, no explicit line; otherwise the
     * song stays as it was. Never a second try: a draft that still repeats beats a timeout. */
    let repeatsLeft = measuresRepeats ? lyricRepeatIssues(raw, text) : [];
    let repeatRewrite = repeatsLeft.length ? 'skipped' : undefined;
    const repeatTime = (writingSettings.timeoutMs || 0) - (Date.now() - started) - 4000;
    if (repeatsLeft.length && repeatTime >= 25000 && typeof lyricRepeatRequest === 'function' && typeof applyRepeatRewrite === 'function') {
      const before = repeatsLeft.reduce((n, issue) => n + issue.weight, 0);
      try {
        const answer = await callModel({
          ...writingSettings,
          system: writingSystem,
          user: lyricRepeatRequest(raw, repeatsLeft),
          maxTokens: writingSettings.maxTokens,
          reasoning: writingSettings.reasoning ? { ...writingSettings.reasoning, effort: 'low' } : undefined,
          timeoutMs: Math.min(repeatTime, 150000),
        });
        totalCost += answer.costUSD;
        costMeasured = costMeasured && answer.measured;
        const candidate = applyRepeatRewrite(raw, answer.text, repeatsLeft, text);
        const after = candidate ? lyricRepeatIssues(candidate, text) : repeatsLeft;
        const weight = after.reduce((n, issue) => n + issue.weight, 0);
        const noNewTells = !!candidate && lyricTells(candidate, text).length <= lyricTells(raw, text).length;
        const noNewSwears = !!candidate && swearing(candidate).length <= swearing(raw).length;
        const kept = !!candidate && weight < before && noNewTells && noNewSwears;
        logger.info(`[soundbooth/script] repeats: ${repeatsLeft.map((i) => i.tag).join(',')} weight ${before}->${candidate ? weight : 'none'} tells=${noNewTells ? 'ok' : 'more'} clean=${noNewSwears ? 'ok' : 'more'} kept=${kept} ${Date.now() - started}ms`);
        repeatRewrite = kept ? (weight ? 'better' : 'fixed') : 'kept the draft';
        if (kept) {
          const choruses = repeatsLeft.some((issue) => issue.chorus) && !after.some((issue) => issue.chorus);
          raw = candidate;
          repeatsLeft = after;
          repairs = [...repairs, choruses ? 'rewrote the chorus so it says more than its hook' : 'rewrote lines that kept repeating themselves'];
        }
      } catch (e) {
        repeatRewrite = 'failed';
        logger.warn('[soundbooth/script] repeat rewrite skipped (song kept): ' + e.message);
      }
    }
    const unclean = swearing(raw).length;
    if (unclean) {
      /* No time for the audit, or the audit kept a swear: a clean song is never handed over dirty. */
      logger.warn(`[soundbooth/script] clean song refused: ${unclean} sung line(s) still explicit user=${req.user.id} ${Date.now() - started}ms`);
      logKadeUsage({
        userId: req.user.id, service: 'soundbooth_script', quantity: 1, unit: 'calls', costUSD: totalCost,
        metadata: { engine, mode, costMeasured, writingPersona: lyricAgentId, audience, sectionMap: sectionMap ? sectionMap.id : undefined, refused: 'explicit words in a clean song', model: writingSettings.model || MODEL, ms: Date.now() - started },
      }).catch(() => {});
      return res.status(422).json({ error: 'This song has to be clean, and the draft came back with words it cannot have. Your idea is kept. Try again.' });
    }
    if (ownsLyrics) raw = fixStageDirections(raw);
    let { script, readback } = splitScriptAndReadback(raw);
    /* Sep 25 2026: when she gave Lyria her own words, her lyrics box keeps
     * them. Lyric's delivery contract asks for a Lyrics: heading with the
     * words, so the desk may hand back a copy -- sometimes reformatted -- and
     * both screens now move a draft's Lyrics block into the lyrics box, which
     * would quietly replace hers. Her words already go under "Lyrics:" at
     * render (lyriaWirePrompt: the box wins), so the desk's copy is taken out
     * here, the same rule as a carry, and she is told when it differed. */
    let lyricsKeptNote = '';
    if (engine === 'lyria' && typeof b.lyrics === 'string' && b.lyrics.trim()) {
      const inDraft = carry.splitLyricsBlock(script);
      if (inDraft.lyrics) {
        const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        script = inDraft.prose;
        if (flat(inDraft.lyrics) !== flat(b.lyrics)) {
          lyricsKeptNote = lyricsPaste
            ? 'The words from your pasted Lyrics Box were kept; the copy the desk put in its draft was left out.'
            : 'Your own lyrics were kept as you wrote them; the copy the desk put in its draft was left out.';
        }
      }
    }
    if (!script) {
      return res.status(502).json({ error: 'The script desk came back empty. Try again.' });
    }
    /* Part 216: she hears the readback before she spends on a render. When the
     * writer gives none, say the music direction's opening instead of nothing. */
    if (!readback && writingSettings.model) {
      const direction = script.split(/^\s*lyrics\s*:/im)[0].replace(/\[[^\]]*\]|->/g, ' ').replace(/\s+/g, ' ').trim();
      readback = (direction.match(/^(?:[^.!?]+[.!?]){1,2}/) || [direction])[0].trim().slice(0, 400);
    }
    if (engine === 'seed') {
      const cleaned = sanitizeSeed(script);
      script = cleaned.script;
      repairs = cleaned.notes;
    }
    /* AuK: the voice in one place (shapeAukDraft), and the words written for it. A draft whose
     * own voice line or readback plainly names someone else (a grown-up for a child's voice, a man
     * for a woman's) is asked for once more with the mismatch named, which costs about a fifth of
     * a cent and saves a paid render of the wrong person. If it is still off, she is told before
     * she spends. KADE_AUK_VOICE_RETRY=0 skips the second ask; the warning stays. With a
     * reference clip there is no check at all: the clip is the voice, whatever the box says. */
    let shapedVoice = '';
    let voiceOff = null;
    let voiceCheck;
    if (engine === 'scenema') {
      let shaped = shapeAukDraft(script, b);
      voiceOff = aukReference ? null : aukVoiceOff(aukVoice, shaped.writerVoice, readback);
      voiceCheck = !aukVoice ? undefined : aukReference ? 'clip' : voiceOff ? 'off' : 'ok';
      if (voiceOff && process.env.KADE_AUK_VOICE_RETRY !== '0') {
        try {
          const again = await callModel({
            ...writingSettings,
            system: writingSystem,
            user: `${lines.join('\n\n')}\n\nYOUR LAST DRAFT WAS WRITTEN FOR ${voiceOff.who.toUpperCase()}, but the voice is chosen and cannot change: ${aukVoice}\nWrite it again for exactly this speaker${mode === 'write' ? ', at their age' : ''}, and make the READBACK name this same speaker.`,
            maxTokens: writingSettings.maxTokens || 2200,
          });
          totalCost += again.costUSD;
          costMeasured = costMeasured && again.measured;
          const split = splitScriptAndReadback(again);
          const reshaped = split.script ? shapeAukDraft(split.script, b) : null;
          const stillOff = reshaped ? aukVoiceOff(aukVoice, reshaped.writerVoice, split.readback) : voiceOff;
          logger.info(`[soundbooth/script] auk voice: first draft written for ${voiceOff.who} (${voiceOff.by}); second draft ${reshaped ? (stillOff ? 'still for ' + stillOff.who : 'matches') : 'empty'} ${Date.now() - started}ms`);
          if (reshaped && !stillOff) {
            shaped = { ...reshaped, notes: [...reshaped.notes, 'wrote it again for the voice you chose'] };
            readback = split.readback;
            voiceOff = null;
            voiceCheck = 'rewritten';
          }
        } catch (e) {
          logger.warn('[soundbooth/script] auk voice retry skipped: ' + e.message);
        }
      }
      script = shaped.script;
      repairs = shaped.notes;
      shapedVoice = shaped.voice;
    }
    if (engine === 'seed' && script.length > MAX_SEED_CHARS) {
      /* one cheap second pass asks the writer to choose its own cuts; the
       * trim below is the guarantee if it still runs over */
      try {
        const shorter = await callModel({
          system: `You are the script desk in Kade-AI's Sound Booth. The Seed Audio script below is ${script.length} characters; the engine's cap is ${MAX_SEED_CHARS} and the target is under 2000. Cut it to fit by removing redundant setting descriptions, repeated voice traits and unnecessary delivery cues before cutting meaningful dialogue. Keep the distinct voices, the conversation's progression, the requested sound constraints and its complete ending. Keep a wordless piece wordless; never invent speech. Output the script and nothing else — no fence, no preamble, no READBACK.`,
          user: script,
          maxTokens: 1400,
        });
        const candidate = stripFence(shorter.text).trim();
        totalCost += shorter.costUSD;
        costMeasured = costMeasured && shorter.measured;
        if (candidate.length >= 200 && candidate.length < script.length && !/READBACK:/i.test(candidate)) {
          repairs = [...repairs, `cut to fit Seed's cap: ${script.length} → ${candidate.length} characters`];
          script = sanitizeSeed(candidate).script;
        }
      } catch (e) {
        logger.warn('[soundbooth/script] cut-to-fit pass failed (trimming instead): ' + e.message);
      }
      if (script.length > MAX_SEED_CHARS) {
        const fitted = fitSeed(script);
        script = fitted.script;
        repairs = [...repairs, fitted.note];
      }
    }
    /* Both screens say `problem` after "Turn my words into a script" and `note` after "Help write
     * this", so a voice still off after the second ask is said on either path, and beside a
     * structural problem rather than instead of it (review 1). */
    const voiceWarning = aukVoiceWarning(voiceOff, mode);
    const problem = ['lyria', 'yue2'].includes(engine) ? null : engine === 'seed' ? checkSeed(script)
      : [checkScenema(script), voiceWarning].filter(Boolean).join(' ') || null;
    const estimate = engine === 'yue2' ? { spoken: 'The draft is ready. Generating the song is a separate paid action.' } : estimateFor(engine, script, priceFactor(req.user));
    logKadeUsage({
      userId: req.user.id,
      service: 'soundbooth_script',
      quantity: 1,
      unit: 'calls',
      costUSD: totalCost,
      metadata: {
        engine,
        mode,
        costMeasured,
        writingPersona: mode === 'write' && ['lyria', 'yue2'].includes(engine) ? lyricAgentId : undefined,
        audience: audience || undefined,
        sectionMap: sectionMap ? sectionMap.id : undefined,
        chorusShape: chorusShape ? chorusShape.id : undefined,
        /* Part 296: sections that repeated in the draft, still repeat in what she gets, and what the rewrite did. */
        repeats: measuresRepeats ? { draft: repeatsInDraft.length, left: repeatsLeft.length, rewrite: repeatRewrite } : undefined,
        /* Part 296 follow-up: stock kiss-off lines in the first draft and in what she gets. */
        kissOffs: wantsWords && typeof lyricKissOffTells === 'function' ? { draft: kissOffsInDraft.length, left: kissOffsOf(raw).length } : undefined,
        model: writingSettings.model || MODEL,
        /* Oct 2 2026, AuK with a chosen voice: ok, rewritten (the second ask fixed it), off, or
         * clip (a reference clip is the voice, so nothing was checked). */
        voiceCheck,
        ms: Date.now() - started,
        inTok: usage.prompt_tokens,
        outTok: usage.completion_tokens,
      },
    }).catch(() => {});
    logger.info(
      `[soundbooth/script] ${engine}/${mode} user=${req.user.id} ${script.length}ch ${Date.now() - started}ms${problem ? ' PROBLEM: ' + problem : ''}`,
    );
    return res.json({
      engine,
      mode,
      script,
      /* Part 126: the same script as a screenplay — what the page shows. Oct 2 2026: for AuK
       * this is for screens that predate `performance` (iPhone 2.2.2). With a voice she chose,
       * it has no header lines, because her box wins at render; with none, its VOICE: line is
       * the only way the writer's voice reaches that screen's render. Review 1: no SEX: line
       * (the AuK worker does not read gender), and no VOICE: line when no one named a voice
       * (that screen's render falls back to the same neutral voice by itself). */
      screenplay: engine === 'scenema' ? speakToScreenplay(script, { includeHeaders: !aukVoice, includeVoice: !!shapedVoice, includeSex: false }) : script,
      /* Oct 2 2026, AuK only: the script box (directions in square brackets and spoken words,
       * never a header line) and the voice it was written for, which goes in Describe a new voice. */
      ...(engine === 'scenema' ? { performance: speakToScreenplay(script, { includeHeaders: false }), voice_description: shapedVoice } : {}),
      readback,
      estimate,
      problem: problem || null,
      repairs,
      mismatch: mismatch ? mismatch.question : null,
      note: [lyricsPaste && lyricsPaste.note, lyricsKeptNote, voiceWarning].filter(Boolean).join(' ') || null,
      /* only when a song pasted into the lyrics box was sorted: the words to
       * put in the lyrics box (script null: the draft above is the direction) */
      pasteSorted: lyricsPaste ? { script: null, lyrics: lyricsPaste.lyrics } : undefined,
    });
  } catch (error) {
    const status = error.status || 500;
    logger.error('[soundbooth/script] failed:', error);
    return res
      .status(status)
      .json({ error: status === 503 ? error.message : error.code === 'ECONNABORTED' ? 'The writer ran out of time on that one. Your idea is kept; nothing was recorded. Try again.' : 'The script desk had trouble. Try again.' });
  }
}

/* Oct 2 2026: Seed Audio's reference clips, made to fit before fal sees them
 * (kadeSoundBoothSeedClips.js). Built on first use from the storage and
 * reference-registry helpers every other import already uses. */
let seedClipPreparer = null;
function seedClips() {
  if (seedClipPreparer) return seedClipPreparer;
  const clips = require('./kadeSoundBoothSeedClips');
  seedClipPreparer = clips.createSeedClipPreparer({
    resign: async (url, key) => (typeof getNewS3URL === 'function' ? getNewS3URL(url, key) : undefined),
    seconds: async (user, url) => (typeof musicReferenceSeconds === 'function' ? musicReferenceSeconds(user, url) : undefined),
    /* A clip's first bytes and its size in one small ranged read, so a clip known to fit is not fetched whole.
     * Storage that ignores the range sends the file; anything over 256 KB then counts as unknown. */
    peek: async (url) => {
      const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000, maxRedirects: 0, maxContentLength: 256 * 1024, headers: { Range: 'bytes=0-63' } });
      const head = Buffer.from(r.data);
      const range = String((r.headers && r.headers['content-range']) || '');
      const total = Number((range.match(/\/(\d+)\s*$/) || [])[1]);
      if (r.status !== 206) return { head, bytes: head.length };
      return { head, bytes: total > 0 ? total : null };
    },
    download: async (url) => {
      const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 45000, maxRedirects: 0, maxContentLength: 25 * 1024 * 1024 });
      return Buffer.from(r.data);
    },
    measure: (buffer) => require('./kadeSoundBoothStitch').durationOf(buffer),
    fit: (buffer, options) => clips.fitSeedClip(buffer, options),
    save: (user, buffer, fileName) => saveBufferToS3({ userId: user, buffer, fileName, basePath: 'audios' }),
    register: (user, url, seconds) => registerMusicReference(user, url, seconds),
    logger,
  });
  return seedClipPreparer;
}

/* ============================ POST /render ================================ */
router.post('/render', requireJwtAuth, express.json({ limit: '128kb' }), async (req, res) => {
  const b = req.body || {};
  const engine = ['seed', 'lyria'].includes(b.engine) ? b.engine : 'scenema';
  if (b.referenceExpected === true && engine !== 'lyria' && !(engine === 'seed' ? Array.isArray(b.audio_urls) && b.audio_urls.length && b.audio_urls.every(url => typeof url === 'string' && url.trim()) : typeof b.reference_voice_url === 'string' && b.reference_voice_url.trim())) {
    return res.status(400).json({ error: 'The expected reference clip is missing. Import it again before generating.' });
  }
  const editing = engine === 'scenema' && b.auk_task === 'edit';
  if (editing && (!b.reference_voice_url || !String(b.instruction || '').trim())) return res.status(400).json({ error: 'Import a recording and describe what you want to change.' });
  if (editing && b.gen_seconds != null && (!Number.isFinite(b.gen_seconds) || b.gen_seconds <= 0)) return res.status(400).json({ error: 'Target seconds must be positive.' });
  let script = String(editing ? b.instruction : b.script || '').trim();
  const mode = b.mode === 'advanced' ? 'advanced' : 'easy';
  if (!script) return res.status(400).json({ error: 'There is nothing to render yet.' });
  /* The same repair runs on the way to the GPU, because a script can reach
   * here without passing the script desk at all -- she can type one by hand in
   * Advanced, or paste one in. A %%% line is never legitimate AuK, so
   * converting it can only help; nothing else about her text is touched. */
  let compileNotes = [];
  if (engine === 'scenema' && !editing) {
    /* Part 126: a AuK script that is not XML is a SCREENPLAY — brackets for
     * directions, double parentheses for sounds, optional VOICE:/SEX:/SCENE:/
     * SHOT: headers — and it is compiled here, behind the scenes, with the
     * booth's settings filling any header left out. Raw XML still works. */
    if (!isSpeakXml(script)) {
      const compiled = screenplayToSpeak(script, {
        voice: b.voice_description,
        gender: b.gender,
        scene: b.scene,
        shot: b.shot,
        language: b.language,
      });
      script = compiled.xml;
      compileNotes = compiled.notes || [];
    }
    script = sanitizeScenema(script).script;
    /* A VOICE: line typed inside raw XML would be spoken; it moves into the tag (see liftBodyHeaders).
     * Only VOICE:, SEX: and GENDER: here: "Who: is there at the door?" is a spoken line (review 1). */
    script = liftBodyHeaders(script, { strict: true }).xml;
    const chosenVoice = String(b.voice_description || '').trim().slice(0, 600);
    if (chosenVoice) {
      /* Describe a new voice wins over a voice written in the script, as it always has. Oct 2 2026:
       * it no longer wins silently. With no reference (a reference sets the voice by itself), the
       * render's spoken line says the script's own voice was not used. */
      const written = speakAttrs(script).voice || '';
      const referenced = !!(b.reference_voice_url || (Array.isArray(b.audio_urls) && b.audio_urls.length));
      if (written && !referenced && flatText(written) !== flatText(chosenVoice)) {
        compileNotes = [...compileNotes, 'The voice in Describe a new voice was used. The voice written in the script was not.'];
      }
      script = withSpeakVoice(script, chosenVoice);
    }
  } else if (engine === 'seed') {
    script = sanitizeSeed(script).script;
  }
  /* Lyria's brief is prose a person wrote about music. There is no grammar to
   * sanitize it into, so it goes to the engine as written. */
  /* allowLong: a AuK script over the cap is not refused here any more —
   * the splitter below turns it into parts. Every other structural problem
   * still stops the render before it spends. */
  let fitNote = null;
  if (engine === 'seed' && script.length > MAX_SEED_CHARS) {
    const fitted = fitSeed(script);
    script = fitted.script;
    fitNote = fitted.note;
    compileNotes = [...(compileNotes || []), fitted.note];
    logger.info(`[soundbooth/render] seed script cut to fit: ${fitted.cut} characters off, user=${req.user.id}`);
  }
  const problem = editing ? null :
    engine === 'lyria'
      ? checkMusic(script, b.lyrics)
      : engine === 'seed'
        ? checkSeed(script)
        : checkScenema(script, { allowLong: true, allowEmpty: b.preview === true });
  if (problem) return res.status(400).json({ error: problem });

  if (b.estimateOnly === true) {
    const quoteScript = b.preview === true && engine === 'scenema'
      ? previewExcerpt(script, { maxWords: 40 }).prompt : script;
    const estimate = estimateFor(engine, quoteScript, priceFactor(req.user));
    if (editing) { estimate.audioSeconds = b.gen_seconds || null; estimate.spoken = 'AuK will edit your imported recording and save a new take. GPU time is billed; the cost depends on recording length and startup. ' + estimate.spoken; }
    /* A pasted song is said to have been sorted before anything is spent. */
    const pasteNote = req.songPaste && req.songPaste.note;
    if (pasteNote) estimate.spoken = pasteNote + ' ' + estimate.spoken;
    return res.json({ ok: true, estimate, preview: b.preview === true, note: [pasteNote, fitNote].filter(Boolean).join(' ') || null, script: fitNote ? script : undefined });
  }

  let project = null;
  let projectLease = null;
  try {
    const opts = {};
    if (editing) { opts.auk_task = 'edit'; opts.instruction = script; if (b.gen_seconds != null) opts.gen_seconds = b.gen_seconds; }
    const isUrl = (u) => typeof u === 'string' && /^https?:\/\/\S+$/i.test(u) && u.length < 2048;
    if (isUrl(b.reference_voice_url)) opts.reference_voice_url = b.reference_voice_url;
    /* Seed takes up to three clips (@Audio1–3); AuK takes one. A single
     * imported clip is accepted under either name so the two screens can
     * share one import row. */
    if (Array.isArray(b.audio_urls)) opts.audio_urls = b.audio_urls.filter(isUrl).slice(0, 3);
    if (engine === 'seed' && !opts.audio_urls?.length && opts.reference_voice_url) opts.audio_urls = [opts.reference_voice_url];
    if (engine === 'scenema' && !opts.reference_voice_url && opts.audio_urls?.length) opts.reference_voice_url = opts.audio_urls[0];
    if (b.background_sfx === true) opts.background_sfx = true;
    /* Lyria's three knobs. It has no clips, no seed and no voice presets, so
     * nothing else on this list means anything to it. */
    if (b.instrumental === true) opts.instrumental = true;
    if (typeof b.lyrics === 'string' && b.lyrics.trim()) opts.lyrics = b.lyrics.trim().slice(0, MAX_LYRIA_LYRICS_CHARS);
    if (b.keep_lyrics === false) opts.keep_lyrics = false;
    if (Number.isInteger(b.seed) && b.seed >= 0) opts.seed = b.seed;
    /* AuK's pace: 1.5 is the ENGINE'S normal (its README: "accounts for
     * LTX's naturally slower speaking pace"); higher = slower. The first booth
     * told her 1.0 was normal — that was wrong, and it is fixed in the guide. */
    if (typeof b.pace === 'number' && b.pace >= 0.5 && b.pace <= 3) opts.pace = b.pace;
    if (b.keep_wav === true) opts.keep_wav = true;
    if (b.validate === false) opts.validate = false;
    /* Part 126 — the knobs the engine actually has (its README, Sep 4 2026 read):
     * there is NO temperature. Eight fixed distilled diffusion steps; the dice
     * is the seed. What is tunable: pace (duration allowance), validate +
     * min_match_ratio (Whisper re-check, up to 3 regenerations), and the clone
     * stage — vc_cfg_rate (how hard the clip's identity is pressed on; higher =
     * more the person, less natural), vc_steps (clone quality, 10–50), skip_vc
     * (anchor mode: no SeedVC, every chunk seeded from the clip's tail). */
    if (typeof b.identity === 'string') {
      const map = { natural: 0.35, balanced: 0.5, strong: 0.7 };
      if (map[b.identity] !== undefined) opts.vc_cfg_rate = map[b.identity];
    }
    if (typeof b.vc_cfg_rate === 'number' && b.vc_cfg_rate >= 0 && b.vc_cfg_rate <= 1) opts.vc_cfg_rate = b.vc_cfg_rate;
    if (Number.isInteger(b.vc_steps) && b.vc_steps >= 10 && b.vc_steps <= 50) opts.vc_steps = b.vc_steps;
    if (typeof b.min_match_ratio === 'number' && b.min_match_ratio >= 0.5 && b.min_match_ratio <= 1) opts.min_match_ratio = b.min_match_ratio;
    if (b.skip_vc === true) opts.skip_vc = true;
    /* Part 180.4 (Sep 11 2026, her ask: "make sure the seed audio tool and
     * company are using the high quality output settings"). The web page
     * posts a toggle as `true`, the phone posts 'high'; the server only ever
     * knew 'high', so the web switch did nothing. Both spellings count, and
     * the default is the engine's best — 48 kHz always, WAV unless the
     * person turns studio quality off, in which case a 48 kHz MP3. fal's
     * schema (read Sep 11): sample_rate up to 48000, formats wav/mp3/pcm/
     * ogg_opus, no bitrate knob; neither changes the price. */
    if (b.audio_quality === 'high' || b.audio_quality === true || b.audio_quality === '1') opts.audio_quality = 'high';
    else if (b.audio_quality === 'low' || b.audio_quality === false || b.audio_quality === '0' || b.audio_quality === 'mp3') opts.audio_quality = 'low';
    if (typeof b.speed === 'number' && b.speed >= 0.5 && b.speed <= 2) opts.speed = b.speed;
    if (typeof b.volume === 'number' && b.volume >= 0.5 && b.volume <= 2) opts.volume = b.volume;
    if (Number.isInteger(b.pitch) && b.pitch >= -12 && b.pitch <= 12) opts.pitch = b.pitch;
    if (b.multilingual === true) opts.multilingual = true;
    if (typeof b.voice === 'string' && b.voice.trim()) opts.voice = b.voice.trim().slice(0, 64);
    if (['female', 'male'].includes(b.gender)) opts.gender = b.gender;
    if (typeof b.language === 'string') opts.language = b.language.slice(0, 12);
    if (['natural', 'balanced', 'strong'].includes(b.identity)) opts.identity = b.identity;
    if (b.voice_description) opts.voice_description = String(b.voice_description).slice(0, 600);
    if (['closeup', 'wide', 'scene'].includes(b.shot)) opts.shot = b.shot;
    if (b.scene) opts.scene = String(b.scene).slice(0, 200);
    /* PREVIEW (her "how do I know what I'll get"): AuK's voice_design mode
     * renders ONE fifteen-second sample of the voice description — no
     * chunking, about a penny — so she can hear the actor before spending
     * on the whole piece. It is a real render on the same lane; it lands in
     * the library as a take like any other, flagged. */
    const preview = engine === 'scenema' && !editing && b.preview === true;

    /* One row per piece of work. Re-rendering an existing project appends to
     * it rather than making a second row -- the Library should show a piece
     * once, with its takes, not the same script five times. */
    if (b.projectId && mongoose.Types.ObjectId.isValid(String(b.projectId))) {
      project = await KadeSoundBoothProject.findOne({ _id: b.projectId, user: req.user.id });
    }
    if (!project) {
      project = new KadeSoundBoothProject({ user: req.user.id });
      await project.save();
    }
    projectLease = await chain.acquire(project);
    if (!projectLease) return res.status(409).json({ error: 'This project is updating. Wait a moment before starting another take.' });
    project = await KadeSoundBoothProject.findById(project._id);
    if (['queued', 'running'].includes(project.state)) {
      return res.status(409).json({ error: 'This project already has a render in progress. Wait for it or stop it before starting another take.', projectId: String(project._id), jobId: project.jobs?.at(-1) });
    }
    const previousScript = project.script;
    const previousOptions = project.options || {};
    if (engine === 'scenema') {
      if (b.newVoice === true) { project.voiceSeed = undefined; delete opts.seed; }
      if (!Number.isInteger(project.voiceSeed) && project.parts?.length && !b.newVoice) {
        project.voiceSeed = chain.deterministicSeed(previousScript);
        previousOptions.seed = project.voiceSeed;
      }
      if (Number.isInteger(opts.seed)) project.voiceSeed = opts.seed;
      else if (!Number.isInteger(project.voiceSeed)) project.voiceSeed = Math.floor(Math.random() * 1000000);
      opts.seed = project.voiceSeed;
    }
    project.title = String(b.title || (project.title !== 'Untitled' && project.title) || titleFrom(script)).slice(0, 80) || 'Untitled';
    project.engine = engine;
    project.mode = mode;
    project.sourceText = String(b.sourceText || project.sourceText || '').slice(0, 8000);
    project.script = script; // Keep the entire accepted script so resume compares the same work.
    /* An edit is described as an edit, not as a script to hear (editReadback); a speech take never
     * carries an edit's description forward from the screen it was opened on. */
    let readback = String(editing ? editReadback(script) : b.readback || project.readback || '');
    if (!editing && readback.startsWith(EDIT_READBACK_LEAD)) readback = '';
    /* Sep 25 2026: sung words are never carried forward as the description --
     * least of all into a take with No singing on. */
    if (engine === 'lyria' && readbackIsSungWords(readback, project.sungLyrics)) readback = '';
    project.readback = readback.slice(0, 600);
    project.options = opts;
    project.lastRenderAt = new Date();
    project.lastError = undefined;

    /* ---- Part 122: TOO LONG IS NO LONGER A REFUSAL ---------------------
     * This used to hand back "split it into parts" — work given to the person
     * least able to do it by eye. Now it cuts at sentence boundaries, renders
     * the parts in order on the same pinned voice, and joins them into one
     * recording. A preview is exempt: it is one fixed fifteen-second line. */
    if (engine === 'scenema' && !editing && !preview && script.length > MAX_SCENEMA_CHARS) {
      const secret = process.env.BRIDGE_SECRET;
      if (!secret) return res.status(503).json({ error: 'The render lane is not configured here.' });
      const pieces = splitSpeakScript(script, MAX_SCENEMA_CHARS);
      if (pieces.length > chain.MAX_PARTS) {
        return res.status(400).json({
          error: `That script would take ${pieces.length} separate renders, which is past the ${chain.MAX_PARTS}-part limit. Cut it roughly in half and make it as two pieces.`,
        });
      }
      const sameOptions = Object.keys({ ...previousOptions, ...opts }).every((key) =>
        JSON.stringify(stableOption(previousOptions[key])) === JSON.stringify(stableOption(opts[key])));
      const resume = ['failed', 'cancelled'].includes(project.state) && !b.newVoice &&
        previousScript === script && sameOptions && project.parts?.length === pieces.length &&
        project.parts.every((part, i) => part.script === pieces[i]);
      project.parts = pieces.map((sc, i) => {
        const previous = resume && project.parts[i];
        return previous?.state === 'done' ? previous.toObject() : { index: i, script: sc, state: 'pending' };
      });
      project.stitchedAssetId = undefined;
      project.state = 'queued';
      await project.save();
      const step = await chain.advanceLocked(project);
      if (step.state === 'failed') {
        return res.status(400).json({ error: project.lastError, projectId: String(project._id) });
      }
      const est = estimateFor('scenema', script, priceFactor(req.user));
      logger.info(`[soundbooth/render] scenema SPLIT into ${pieces.length} parts project=${project._id} user=${req.user.id}`);
      return res.json({
        ok: true,
        jobId: step.jobId || null,
        projectId: String(project._id),
        engine: 'scenema',
        queued: step.state !== 'done',
        voiceSeed: project.voiceSeed,
        resumed: resume,
        multipart: { total: pieces.length, index: 0 },
        estimate: { ...est, spoken: [saySplit(pieces, 'AuK'), est.spoken, ...compileNotes].join(' ') },
        spoken: saySplit(pieces, 'AuK'),
      });
    }

    project.parts = [];
    project.stitchedAssetId = undefined;
    if (engine === 'scenema') {
      const secret = process.env.BRIDGE_SECRET;
      if (!secret) return res.status(503).json({ error: 'The render lane is not configured here.' });
      let r;
      let previewInfo = null;
      /* Declared outside the try: the preview's estimate below reads it after the start call
       * (Sep 27 2026: "promptToSend is not defined" failed a preview after the job was sent). */
      let promptToSend = script;
      try {
        /* A preview performs one fixed sample line in the described voice,
         * not her whole script — the point is to hear the ACTOR for a penny.
         * The voice= attribute is lifted off her script so what she previews
         * is exactly what the full render will use. */
        if (preview) {
          /* Part 122.1, her report: "that sounded nothing like my description,
           * and it just said some weird sample sentence." Both true, and both
           * were mine. The sentence was HARDCODED — nobody's words — so it is
           * her script's opening now, whole sentences only, same <speak> tag. */
          const speakTag = (script.match(/<speak[^>]*>/i) || [''])[0];
          const base = speakTag
            ? script
            : `<speak voice="${escapeXml(opts.voice_description || 'A warm, clear adult voice.')}" gender="${b.gender === 'male' ? 'male' : 'female'}"></speak>`;
          previewInfo = previewExcerpt(base, { maxWords: 40 });
          promptToSend = previewInfo.prompt;
        }
        /* ⭐ THE SEED IS THE VOICE (Part 122.1). AuK casts a new random
         * actor off the description on EVERY render unless a seed is pinned.
         * Unpinned, the penny she spent on "hear this voice first" auditioned
         * somebody the real render would never use — the preview was a lottery
         * ticket, not a preview. Her seat's own jobs that night: 194376,
         * 959021, 952142, 908614, all different, all random.
         * One seed per PROJECT now, set by whichever fires first and reused by
         * every render after, so preview and render and re-render are the same
         * person. `newVoice: true` rerolls it on purpose. */
        const bridgeBody = {
          secret,
          userId: String(req.user.id),
          agentId: 'soundbooth',
          agentName: 'Sound Booth',
          prompt: promptToSend,
          auk_task: opts.auk_task,
          instruction: opts.instruction,
          gen_seconds: opts.gen_seconds,
          reference_voice_url: opts.reference_voice_url,
          background_sfx: opts.background_sfx,
          seed: project.voiceSeed,
          pace: opts.pace,
          keep_wav: opts.keep_wav,
          validate: opts.validate,
          min_match_ratio: opts.min_match_ratio,
          vc_cfg_rate: opts.vc_cfg_rate,
          vc_steps: opts.vc_steps,
          skip_vc: opts.skip_vc,
          /* Oct 2 2026: a description-only voice is set by a private opening take, so
           * AuK never speaks the description (her Oct 1 preview did). Worker
           * aa31fa8; KADE_AUK_VOICE_SAMPLE=0 turns it off. */
          voice_sample: process.env.KADE_AUK_VOICE_SAMPLE !== '0' && opts.auk_task !== 'edit' && !opts.reference_voice_url ? true : undefined,
        };
        /* A clip and a designed voice are two different ways to choose a voice
         * and this file says so elsewhere: "a reference clip beats a preset
         * name, and sending both is undefined." Her broken preview ran
         * mode=voice_design AND has_reference_voice=true at the same time —
         * the engine was told to invent a voice from words and to sound like a
         * recording, in the same breath. If a clip is attached the real render
         * will CLONE it, so the preview must clone it too; voice_design is for
         * previewing a written description, which is the case with no clip. */
        if (preview && !opts.reference_voice_url) bridgeBody.mode = 'voice_design';
        r = await axios.post(`${bridgeBase()}/audio/scenema/start`, bridgeBody, {
          headers: { 'User-Agent': UA },
          timeout: 20000,
        });
      } catch (e) {
        /* The bridge's own sentence when it sent one; never an object said as "[object Object]". */
        const said = providerError(e, { name: 'The render service' });
        logger.warn(`[soundbooth/render] scenema start failed project=${project._id} user=${req.user.id}: ${said.detail}`);
        project.state = 'failed';
        project.lastError = said.message.slice(0, 300);
        await project.save();
        return res.status(400).json({ error: said.message, projectId: String(project._id) });
      }
      const jobId = r.data?.jobId;
      if (!jobId) throw new Error('The render service did not return a job. Check the library before retrying.');
      project.state = 'queued';
      if (jobId) project.jobs = [...(project.jobs || []), jobId].slice(-20);
      await project.save();
      /* The preview says WHAT IT IS ABOUT TO PERFORM before it charges, and
       * names the voice number, because that number is the only thing that
       * makes an audition mean anything on the render that follows. */
      const est = preview
        ? {
            engine: 'scenema',
            words: previewInfo?.words || 0,
            audioSeconds: Math.max(5, Math.round((previewInfo?.words || 25) / 2.6)),
            renderSeconds: estimateFor('scenema', promptToSend).renderSeconds,
            costUSD: estimateFor('scenema', promptToSend).costUSD,
            voiceSeed: project.voiceSeed,
            sampleText: previewInfo?.text || '',
            fromScript: !!previewInfo?.fromScript,
            spoken:
              (previewInfo?.fromScript
                ? `Reading the opening of your script: "${String(previewInfo.text).slice(0, 160)}"`
                : `Your script is empty, so it will read a plain line instead: "${String(previewInfo?.text || '').slice(0, 160)}"`) +
              ` Voice number ${project.voiceSeed} — the full render will use this same voice. GPU time is billed.`,
          }
        : estimateFor('scenema', script, priceFactor(req.user));
      /* Part 123: the bridge's estimate is read for a PREVIEW too. Its
       * spokenWait now names which case she is in (card awake / waking / none
       * free), and "about a penny" with no wait attached is exactly the promise
       * that turned a working preview into "minutes and minutes" by ear. */
      const bridgeEst = r.data?.estimate || {};
      if (preview && bridgeEst.spokenWait) est.spoken += ` ${bridgeEst.spokenWait}`;
      /* audioSeconds comes from HERE (the bridge counts direction words as
       * spoken); the wait and the money come from the BRIDGE, which is the
       * only side that knows the measured render rate and the wake charge. */
      const merged = {
        ...est,
        audioSeconds: est.audioSeconds,
        renderSeconds: bridgeEst.renderSeconds || est.renderSeconds,
        renderSecondsWarm: bridgeEst.renderSecondsWarm,
        cardAwake: bridgeEst.cardAwake,
        /* Part 295: the bridge quotes the real price; est.costUSD is already this person's. */
        costUSD: typeof bridgeEst.costUSD === 'number' ? priced(bridgeEst.costUSD, priceFactor(req.user)) : est.costUSD,
      };
      /* A preview writes its OWN sentence (what it will perform, and the voice
       * number). sayEstimate would flatten that back into "about N seconds of
       * audio", which is the least useful thing to know about an audition. */
      if (!preview) {
        /* When the bridge has looked at the endpoint, its sentence about the
         * wait is the true one; sayEstimate's generic "longer if the card has
         * to wake up" is the fallback for a bridge that did not say. */
        merged.spoken = bridgeEst.spokenWait || est.spoken;
      }
      if (compileNotes.length && merged.spoken) merged.spoken += ' ' + compileNotes.join(' ');
      logger.info(`[soundbooth/render] scenema queued job=${jobId} project=${project._id} user=${req.user.id}`);
      return res.json({
        ok: true,
        engine: 'scenema',
        queued: true,
        preview,
        jobId,
        projectId: String(project._id),
        /* The page carries this back on the real render so the voice she
         * auditioned is the voice she gets. */
        voiceSeed: project.voiceSeed,
        estimate: merged,
      });
    }

    /* ---- Lyria 3.5: synchronous music, so the answer carries the record ----
     * Same shape as the Seed lane below -- one call, one asset, state straight
     * to 'done'. The difference is that Google hands the audio back INLINE as
     * base64 rather than as a URL, so this lane has to put the bytes into her
     * own storage itself before anything can play them. */
    if (engine === 'lyria') {
      const key = lyriaKey();
      if (!key) return res.status(503).json({ error: 'Lyria is not set up on this server yet.' });
      if (typeof saveBufferToS3 !== 'function') {
        return res.status(503).json({ error: 'File storage is not set up here, so there is nowhere to keep the song.' });
      }
      project.state = 'running';
      await project.save();

      /* Part 179: the wire prompt in the shape Google's guide asks for -- the
       * brief, then the person's words under "Lyrics:", then the exact
       * instrumental line last so it wins if both were set. */
      const brief = lyriaWirePrompt(script, opts);

      let r;
      try {
        r = await axios.post(
          `${lyriaBase()}/v1beta/models/${LYRIA_MODEL}:generateContent`,
          {
            contents: [{ role: 'user', parts: [{ text: brief }] }],
            /* documented on the generateContent page for Lyria: ask for the
             * record AND the words, explicitly. */
            generationConfig: { responseModalities: ['AUDIO', 'TEXT'] },
          },
          { headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, timeout: 300000 },
        );
      } catch (e) {
        const status = e?.response?.status;
        const said = providerError(e, { name: 'Lyria', max: 200 });
        googleKeyAlarm('Lyria songs', e, lyriaKeyName());
        /* The wall, named out loud. A 404 here is almost always the model id,
         * and the id is the one thing about Lyria 3.5 that does not follow its
         * own family's pattern -- so say the right string instead of handing
         * back Google's "not found for API version v1beta". */
        const msg = status === 404
          ? `Google does not recognise the model id "${LYRIA_MODEL}". The right one is lyria-3.5, with a DOT - its sibling models use hyphens, which is the usual reason this fails. Fix KADE_LYRIA_MODEL, or clear it and let the default stand.`
          : `Lyria could not make that: ${said.message}`;
        project.state = 'failed';
        project.lastError = String(msg).slice(0, 300);
        await project.save();
        logger.warn(`[soundbooth/render] lyria failed status=${status} model=${LYRIA_MODEL} user=${req.user.id}: ${said.detail}`);
        return res.status(status === 404 ? 500 : 502).json({ error: msg, projectId: String(project._id) });
      }

      const parts = r.data?.candidates?.[0]?.content?.parts || [];
      const audioPart = parts.find((p) => p?.inlineData?.data);
      const lyricText = parts
        .filter((p) => typeof p?.text === 'string' && p.text.trim())
        .map((p) => p.text.trim())
        .join('\n\n')
        .slice(0, 8000);
      /* The raw text keeps Lyria's [[A0]] / [:] markers for the asset record;
       * everything a person reads or hears gets the cleaned copy. */
      const lyricsClean = cleanLyrics(lyricText);
      if (!audioPart) {
        /* A refusal comes back as text with no audio, and that text is the
         * useful part -- hand it over rather than saying "no clip". */
        const why = lyricsClean ? ` It said: ${lyricsClean.slice(0, 200)}` : '';
        project.state = 'failed';
        project.lastError = ('Lyria returned no audio.' + why).slice(0, 300);
        await project.save();
        return res.status(502).json({
          error: `Lyria did not make a recording that time.${why} Try rewording the brief.`,
          projectId: String(project._id),
        });
      }

      const mime = String(audioPart.inlineData.mimeType || 'audio/mpeg');
      const ext = /wav/i.test(mime) ? 'wav' : /ogg/i.test(mime) ? 'ogg' : 'mp3';
      const buffer = Buffer.from(audioPart.inlineData.data, 'base64');
      if (!buffer || buffer.length < 1000) {
        project.state = 'failed';
        project.lastError = 'Lyria returned an empty recording.';
        await project.save();
        return res.status(502).json({ error: 'Lyria returned an empty recording. Try that again.', projectId: String(project._id) });
      }
      const fileName = `soundbooth-lyria-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      let url = null;
      try {
        url = await saveBufferToS3({ userId: String(req.user.id), buffer, fileName, basePath: 'audios' });
      } catch (e) {
        logger.error('[soundbooth/render] lyria save failed: ' + e.message);
      }
      if (!url) {
        project.state = 'failed';
        project.lastError = 'The song was made but it did not save.';
        await project.save();
        /* Said plainly, because this one already cost money. */
        return res.status(502).json({
          error: 'The song was made but it did not save, and that take is still billed. Try again before you rewrite the brief.',
          projectId: String(project._id),
        });
      }

      const costUSD = LYRIA_USD_PER_SONG;
      logKadeUsage({
        userId: req.user.id,
        service: 'google_lyria',
        quantity: 1,
        unit: 'songs',
        costUSD,
        metadata: { model: LYRIA_MODEL, via: 'sound-booth', format: ext, instrumental: !!opts.instrumental },
      }).catch(() => {});
      let assetId = null;
      try {
        const asset = await logKadeAsset({
          userId: req.user.id,
          kind: 'audio',
          service: 'google_lyria',
          url,
          prompt: script,
          model: LYRIA_MODEL,
          costUSD,
          metadata: {
            via: 'sound-booth',
            title: project.title,
            projectId: String(project._id),
            bytes: buffer.length,
            instrumental: !!opts.instrumental,
            lyrics: opts.keep_lyrics === false ? undefined : lyricText || undefined,
            lyricsClean: opts.keep_lyrics === false ? undefined : lyricsClean || undefined,
            wirePrompt: brief.slice(0, 12000),
          },
        });
        if (asset && asset._id) assetId = String(asset._id);
      } catch (e) {
        logger.warn('[soundbooth/render] lyria asset log failed (non-fatal): ' + e.message);
      }
      project.state = 'done';
      project.costUSD = (project.costUSD || 0) + costUSD;
      /* Sep 25 2026: the words it sang are kept as the words it sang. They
       * used to overwrite `readback` -- "what you will hear" -- and stay
       * there through every instrumental take after. An instrumental take
       * sang nothing, whatever text came back with it. */
      project.sungLyrics = opts.keep_lyrics === false || opts.instrumental ? '' : lyricsClean.slice(0, 8000);
      if (assetId) project.assets = [...(project.assets || []), assetId].slice(-20);
      await project.save();
      await notifyMusic(String(req.user.id), project.title, 1, 1, false).catch(error => logger.warn('[soundbooth/music] Lyria notification failed: ' + error.message));
      logger.info(`[soundbooth/render] lyria done ${buffer.length}B $${costUSD} project=${project._id} user=${req.user.id}`);
      return res.json({
        ok: true,
        engine: 'lyria',
        queued: false,
        projectId: String(project._id),
        assetId,
        url,
        bytes: buffer.length,
        lyrics: opts.keep_lyrics === false ? null : lyricsClean || null,
        costUSD: priced(costUSD, priceFactor(req.user)),
        note: (req.songPaste && req.songPaste.note) || null,
        spoken: ((req.songPaste && req.songPaste.note) ? req.songPaste.note + ' ' : '') + (lyricsClean
          ? 'The song is made, and it wrote words for it. They are saved with the recording.'
          : 'The song is made.'),
      });
    }

    /* ---- Seed Audio: synchronous, so the answer carries the audio itself --- */
    const falKey = process.env.FAL_KEY;
    if (!falKey) return res.status(503).json({ error: 'Seed Audio is not configured on this server.' });
    project.state = 'running';
    await project.save();

    /* Oct 2 2026: fal takes a reference clip of up to 30 seconds and 10 MB, as
     * WAV, MP3 or Ogg Opus. Her 32.6-second voice clip failed three renders in a
     * row. Each clip in her own storage is checked first; a long one is cut to
     * 29.5 seconds (at a pause when there is one) into a stored copy that later
     * renders reuse, and the answer says so (kadeSoundBoothSeedClips.js). The
     * project keeps her own clips in audio_urls, so switching it to AuK edit
     * later still works on the whole recording; the copies Seed heard are
     * recorded beside them as seed_sent_urls. */
    let clipNotes = [];
    /* What fal is sent: every clip signed again (so one from an old project is not an expired link), and a copy in place of a clip that needed one. */
    let sentUrls = null;
    if (opts.audio_urls?.length) {
      const prepared = await seedClips()(String(req.user.id), opts.audio_urls);
      clipNotes = prepared.notes;
      sentUrls = prepared.urls;
      if (prepared.fitted) {
        project.options = { ...opts, seed_sent_urls: prepared.urls };
        project.markModified('options');
        logger.info(`[soundbooth/render] seed clips fitted project=${project._id} user=${req.user.id}: ${prepared.logs.join('; ')}`);
      }
    }

    const hq = opts.audio_quality !== 'low';
    const body = {
      prompt: script,
      output_format: hq ? 'wav' : 'mp3',
      sample_rate: 48000,
    };
    if (typeof opts.speed === 'number') body.speed = opts.speed;
    if (typeof opts.volume === 'number') body.volume = opts.volume;
    if (Number.isInteger(opts.pitch)) body.pitch = opts.pitch;
    if (opts.multilingual) body.multilingual = true;
    /* Clips override a preset: the docs say a reference clip beats a preset
     * name, and sending both is undefined. */
    if (opts.audio_urls?.length) body.audio_urls = sentUrls || opts.audio_urls;
    else if (opts.voice) body.voice = opts.voice;

    let r;
    try {
      r = await axios.post('https://fal.run/bytedance/seed-audio-1.0', body, {
        headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
        timeout: 180000,
      });
    } catch (e) {
      /* fal answers a bad request with a FastAPI `detail` ARRAY; String() of it
       * was the "[object Object]" she heard, and nothing was logged. */
      const said = providerError(e, { name: 'Seed Audio', max: 200 });
      logger.warn(`[soundbooth/render] seed failed status=${said.status || '-'} clips=${(body.audio_urls || []).length} chars=${script.length} project=${project._id} user=${req.user.id}: ${said.detail}`);
      const error = `Seed Audio could not make that: ${said.message}`;
      project.state = 'failed';
      project.lastError = error.slice(0, 300);
      await project.save();
      return res
        .status(502)
        .json({ error, projectId: String(project._id) });
    }
    const audio = r.data?.audio;
    if (!audio?.url) {
      logger.warn(`[soundbooth/render] seed returned no clip project=${project._id} user=${req.user.id}: ${providerError({ response: { data: r.data } }, { name: 'Seed Audio' }).detail}`);
      project.state = 'failed';
      project.lastError = 'Seed Audio returned no clip.';
      await project.save();
      return res
        .status(502)
        .json({ error: 'Seed Audio returned no clip. Try rewording it.', projectId: String(project._id) });
    }
    const seconds = Math.max(1, Math.round(Number(audio.duration) || 0));
    const costUSD = Math.round((seconds / 60) * SEED_USD_PER_MIN * 1000) / 1000;
    logKadeUsage({
      userId: req.user.id,
      service: 'fal_audio',
      quantity: seconds,
      unit: 'seconds',
      costUSD,
      metadata: { model: 'seed-audio-1.0', via: 'sound-booth', format: body.output_format },
    }).catch(() => {});
    let assetId = null;
    try {
      const asset = await logKadeAsset({
        userId: req.user.id,
        kind: 'audio',
        service: 'fal_audio',
        url: audio.url,
        prompt: script,
        model: 'seed-audio-1.0',
        costUSD,
        metadata: { seconds, via: 'sound-booth', projectId: String(project._id) },
      });
      if (asset && asset._id) assetId = String(asset._id);
    } catch (e) {
      logger.warn('[soundbooth/render] asset log failed (non-fatal): ' + e.message);
    }
    project.state = 'done';
    project.costUSD = (project.costUSD || 0) + costUSD;
    if (assetId) project.assets = [...(project.assets || []), assetId].slice(-20);
    await project.save();
    logger.info(
      `[soundbooth/render] seed done ${seconds}s $${costUSD} project=${project._id} user=${req.user.id}`,
    );
    return res.json({
      ok: true,
      engine: 'seed',
      queued: false,
      projectId: String(project._id),
      assetId,
      url: audio.url,
      seconds,
      costUSD: priced(costUSD, priceFactor(req.user)),
      /* What happened to a clip on the way, said before "Ready" on both screens (the phone reads `note`). */
      note: clipNotes.length ? clipNotes.join(' ') : null,
    });
  } catch (error) {
    logger.error('[soundbooth/render] failed:', error);
    if (project && projectLease) {
      try {
        project.state = 'failed';
        project.lastError = String(error.message || 'render failed').slice(0, 300);
        await project.save();
      } catch (_) {
        /* noop */
      }
    }
    return res.status(500).json({ error: 'That render could not start. Try again.' });
  } finally { if (project && projectLease) await chain.release(project, projectLease); }
});

/* One push per finished PIECE, not per part — sent after the join, through the
 * same bridge lane the single-shot renders use. */
async function notifyReady(userId, seconds) {
  const secret = process.env.BRIDGE_SECRET;
  if (!secret) return;
  const m = Math.floor((seconds || 0) / 60);
  const sec = Math.round((seconds || 0) % 60);
  const len = m ? `${m} minute${m === 1 ? '' : 's'} ${sec} seconds` : `${sec} seconds`;
  await axios.post(
    `${bridgeBase()}/notify`,
    {
      secret,
      userId: String(userId),
      agentId: 'soundbooth',
      agentName: 'Sound Booth',
      title: 'Your narration is ready',
      body: `${len} of audio, joined from its parts, is in My Creations.`,
      urgent: false,
      requested: true,
      route: 'sound-booth',
    },
    { headers: { 'User-Agent': UA }, timeout: 15000 },
  );
}

/* ============================ GET /status/:jobId =========================== */
/* The phone cannot hold BRIDGE_SECRET, so the fork asks on its behalf -- the
 * same peephole shape build 197 used for the front desk and the crash ring.
 * The row is updated from what comes back, so the Library is right even if the
 * app was closed while the GPU was working. */
router.get('/status/:jobId', requireJwtAuth, async (req, res) => {
  try {
    const secret = process.env.BRIDGE_SECRET;
    if (!secret) return res.status(503).json({ error: 'The render lane is not configured here.' });
    const jobId = String(req.params.jobId || '').slice(0, 64);
    const project = await KadeSoundBoothProject.findOne({ user: req.user.id, jobs: jobId });
    if (!project) return res.status(404).json({ error: 'No render by that name on your account.' });

    /* ---- Part 122: a multi-part piece advances HERE ---------------------
     * There is no worker process in this app, and /status is already polled
     * every 15 s by both surfaces, so the poll is what walks the chain. Every
     * step is idempotent because both surfaces may poll the same project at
     * once. If she closes the app mid-chain it PAUSES rather than breaking —
     * the parts already paid for keep their audio and the next open resumes. */
    if ((project.parts || []).length > 1) {
      const step = await chain.advance(project, {
        onStitched: async ({ seconds }) => {
          await notifyReady(String(req.user.id), seconds).catch(() => {});
        },
      });
      const done = (project.parts || []).filter((p) => p.state === 'done').length;
      const total = project.parts.length;
      return res.json({
        jobId,
        projectId: String(project._id),
        state: project.state,
        error: project.state === 'failed' ? project.lastError || null : null,
        multipart: { total, done, joined: !!project.stitchedAssetId },
        url: step.url || null,
        spoken: step.spoken || chain.sayProgress(project, null),
      });
    }
    let r;
    try {
      r = await axios.get(
        `${bridgeBase()}/audio/scenema/status?jobId=${encodeURIComponent(jobId)}&secret=${encodeURIComponent(secret)}`,
        { headers: { 'User-Agent': UA }, timeout: 15000 },
      );
    } catch (e) {
      if (e?.response?.status === 404) {
        const message = 'The render service no longer has this job. Any saved audio is kept. Open the project and render again to retry.';
        await KadeSoundBoothProject.updateOne({
          _id: project._id, updatedAt: project.updatedAt, state: { $in: ['queued', 'running'] },
          $expr: { $eq: [{ $arrayElemAt: ['$jobs', -1] }, jobId] },
          renderLeaseUntil: { $exists: false },
        }, { $set: { state: 'failed', lastError: message } });
        return res.json({ jobId, projectId: String(project._id), state: 'failed', error: message, spoken: message });
      }
      throw e;
    }
    const j = r.data || {};
    /* The bridge's reason as words, whatever shape it arrived in (Oct 2 2026). */
    const jobError = j.error ? errorText(j.error, { name: 'The render service', max: 300, fallback: 'The render service did not say why.' }) : null;
    const map = { queued: 'queued', running: 'running', done: 'done', failed: 'failed', cancelled: 'cancelled' };
    // An old take must never overwrite the currently rendering take. The
    // conditional update also prevents two polls charging the same finish twice.
    if (map[j.state] && project.jobs.at(-1) === jobId) {
      const set = { state: map[j.state] };
      if (j.state === 'failed') set.lastError = (jobError || 'render failed').slice(0, 300);
      const update = { $set: set };
      if (j.state === 'done' && typeof j.costUSD === 'number') update.$inc = { costUSD: j.costUSD };
      const changed = await KadeSoundBoothProject.updateOne({
        _id: project._id, updatedAt: project.updatedAt, state: { $nin: [map[j.state], 'cancelled'] },
        $or: [{ renderLeaseUntil: { $exists: false } }, { renderLeaseUntil: { $lt: new Date() } }],
      }, update);
      if (changed.modifiedCount && j.state === 'done') {
        try { await linkJobAssets([project], req.user.id); }
        catch (e) { logger.warn('[soundbooth] link on done failed: ' + e.message); }
      }
      /* Logged once, when the failure is first written, with everything the bridge said. */
      if (changed.modifiedCount && j.state === 'failed') {
        logger.warn(`[soundbooth/status] job=${jobId} failed project=${project._id} user=${req.user.id}: ${providerError({ response: { data: j.error ?? null } }).detail}`);
      }
    }
    const d = Math.round(j.result?.durationS || 0);
    return res.json({
      jobId,
      projectId: String(project._id),
      state: j.state,
      error: jobError,
      url: j.result?.url || null,
      durationS: j.result?.durationS || null,
      /* Part 295 review: the bridge reports the real price; a person is shown what they paid (the
       * real price for Kade and for the trials she pays for), the way projectView does. */
      costUSD: j.costUSD ? priced(j.costUSD, KADE_PAYS_ENGINES.includes(project.engine) ? 1 : priceFactor(req.user)) : null,
      /* Part 122: the bridge now says WHY an unfinished job is unfinished, how
       * long it has been that way, and when it will give up. Passed straight
       * through so the surfaces can speak a changing sentence on every poll
       * rather than one line and then six minutes of nothing. */
      wait: j.wait || null,
      /* Said, not shown. */
      spoken:
        j.state === 'done'
          ? `Ready. ${Math.floor(d / 60) ? `${Math.floor(d / 60)} minute${Math.floor(d / 60) === 1 ? '' : 's'} ` : ''}${d % 60} seconds of audio, in the Sound Booth library and My Creations.`
          : j.state === 'failed'
            ? `That render did not finish. ${(jobError || '').slice(0, 160)}`
            : j.state === 'cancelled'
            ? 'Stopped. Any completed takes are kept.'
          : j.wait?.spoken
              ? j.wait.spoken
              : j.state === 'running'
                ? 'Rendering now.'
                : 'Queued, waiting for a graphics card.',
    });
  } catch (error) {
    logger.error('[soundbooth/status] failed:', error);
    return res.status(500).json({ error: 'Could not read that render.' });
  }
});

/* ============================ POST /cancel/:jobId ========================== */
router.post('/cancel/:jobId', requireJwtAuth, async (req, res) => {
  try {
    const secret = process.env.BRIDGE_SECRET;
    if (!secret) return res.status(503).json({ error: 'The render lane is not configured here.' });
    const jobId = String(req.params.jobId || '').slice(0, 64);
    const project = await KadeSoundBoothProject.findOne({ user: req.user.id, jobs: jobId });
    if (!project) return res.status(404).json({ error: 'No render by that name on your account.' });
    if (!['queued', 'running'].includes(project.state)) return res.json({ ok: true, state: project.state });
    const lease = await chain.acquire(project);
    if (!lease) return res.status(409).json({ error: 'This project is finishing an update. Try Stop again in a moment.' });
    try {
      const current = await KadeSoundBoothProject.findById(project._id);
      project.set(current.toObject());
      if (!['queued', 'running'].includes(project.state)) return res.json({ ok: true, state: project.state });
      const active = project.parts?.find((part) => ['queued', 'running'].includes(part.state));
      const activeJobId = active?.jobId || project.jobs.at(-1);
      const result = await axios.post(
        `${bridgeBase()}/audio/scenema/cancel`,
        { secret, jobId: activeJobId },
        { headers: { 'User-Agent': UA }, timeout: 15000 },
      );
      if (result.data?.state === 'done' && !active) {
        return res.json({ ok: true, state: 'done', spoken: 'That take finished before Stop reached it. Refreshing its result.' });
      }
      if (active && result.data?.state === 'done') {
        const finished = await axios.get(`${bridgeBase()}/audio/scenema/status`, {
          params: { secret, jobId: activeJobId }, headers: { 'User-Agent': UA }, timeout: 15000,
        });
        const j = finished.data;
        if (!j.result?.url) throw new Error('The finished part is not ready to save yet. Try Stop again.');
        active.state = 'done'; active.url = j.result.url;
        active.wavUrl = j.result.wavUrl; active.audioEngine = j.result.engine;
        active.durationS = j.result.durationS || null; active.costUSD = j.costUSD || 0;
        project.costUSD = (project.costUSD || 0) + active.costUSD;
      } else if (active) active.state = 'failed';
      project.state = 'cancelled';
      await project.save();
      return res.json({ ok: true, state: 'cancelled', spoken: 'Stopped. Completed takes and finished parts are kept. GPU time already used may still be charged.' });
    } finally { await chain.release(project, lease); }
  } catch (error) {
    logger.error('[soundbooth/cancel] failed:', error);
    return res.status(500).json({ error: 'Could not stop that render.' });
  }
});

/* ============================ projects ==================================== */
router.get('/projects', requireJwtAuth, async (req, res) => {
  try {
    const rows = await KadeSoundBoothProject.find({ user: req.user.id })
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean();
    await linkJobAssets(rows, req.user.id);
    const takes = await takesFor(rows, req.user.id, !isKade(req.user));
    const factor = priceFactor(req.user);
    const projects = await Promise.all(rows.map(async (r) => {
      const v = projectView(r, factor);
      await refreshReferences(v);
      v.takes = (r.assets || []).map((id) => takes.get(String(id))).filter(Boolean).reverse();
      return v;
    }));
    return res.json({ count: projects.length, projects });
  } catch (error) {
    logger.error('[soundbooth/projects] failed:', error);
    return res.status(500).json({ error: "Couldn't load your Sound Booth." });
  }
});

router.get('/projects/:id', requireJwtAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ error: 'No such project.' });
    }
    const p = await KadeSoundBoothProject.findOne({ _id: req.params.id, user: req.user.id }).lean();
    if (!p) return res.status(404).json({ error: 'No such project.' });
    await linkJobAssets([p], req.user.id);
    const takes = await takesFor([p], req.user.id, !isKade(req.user));
    const v = projectView(p, priceFactor(req.user));
    await refreshReferences(v);
    v.takes = (p.assets || []).map((id) => takes.get(String(id))).filter(Boolean).reverse();
    return res.json({ project: v });
  } catch (error) {
    logger.error('[soundbooth/project] failed:', error);
    return res.status(500).json({ error: "Couldn't load that project." });
  }
});

router.patch('/projects/:id', requireJwtAuth, express.json({ limit: '64kb' }), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ error: 'No such project.' });
    }
    const p = await KadeSoundBoothProject.findOne({ _id: req.params.id, user: req.user.id });
    if (!p) return res.status(404).json({ error: 'No such project.' });
    const b = req.body || {};
    if (b.title != null && (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 80)) return res.status(400).json({ error: 'Use a title from 1 to 80 characters.' });
    if (typeof b.title === 'string') p.title = b.title.trim();
    if (typeof b.script === 'string') p.script = b.script;
    if (typeof b.sourceText === 'string') p.sourceText = b.sourceText.slice(0, 8000);
    await p.save();
    if (typeof b.title === 'string') {
      const inProject = { user: req.user.id, 'metadata.projectId': String(p._id) };
      await KadeAsset.updateMany({ ...inProject, 'metadata.voiceOf': { $exists: false } }, { $set: { 'metadata.title': p.title, description: p.title } });
      /* Sep 29 2026: a version in her voice keeps "(in my voice)"; a rename used to give it the same name as its take. */
      const voiced = voiceVersionTitle(p.title);
      await KadeAsset.updateMany({ ...inProject, 'metadata.voiceOf': { $exists: true } }, { $set: { 'metadata.title': voiced, description: voiced } });
    }
    return res.json({ project: projectView(p, priceFactor(req.user)) });
  } catch (error) {
    logger.error('[soundbooth/project patch] failed:', error);
    return res.status(500).json({ error: "Couldn't save that." });
  }
});

/* ==================== POST /projects/:id/carry ============================
 *
 * "If I'm working on something on yue2 music, and I feel like switching over
 * to lyria, which is also music, can you make my lyrics and tags and stuff
 * jump over?"
 *
 * Yes, and without spending anything by default. The lyrics, the section
 * tags, her own typed words, the seed and the imported clip are data and move
 * exactly; the style paragraph is the only thing written in a grammar. Pass
 * rewrite:true and the script desk writes that paragraph again in the new
 * engine's format -- the same desk, in `format` mode, so her words are kept
 * and only the shape around them changes.
 *
 * The original project is never touched. Switching vendors is something you
 * do because you did not like what you got, so what you did not like has to
 * still be there to compare against.
 */
router.post('/projects/:id/carry', requireJwtAuth, express.json({ limit: '16kb' }), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ error: 'No such project.' });
    }
    const source = await KadeSoundBoothProject.findOne({ _id: req.params.id, user: req.user.id }).lean();
    if (!source) return res.status(404).json({ error: 'No such project.' });
    const to = String((req.body || {}).engine || '');
    const out = carry.carryOver(source, to, { toScreenplay: speakToScreenplay });
    if (!out.ok) return res.status(400).json({ error: out.why });

    const notes = [...out.notes];
    const draft = { ...out.draft };
    /* The optional, paid half. It writes the STYLE paragraph again in the new
     * grammar; the lyrics are never sent through it, because they are hers
     * and they already carried across exactly. */
    if ((req.body || {}).rewrite === true && String(draft.script || '').trim()) {
      try {
        /* Sep 25 2026: callModel answers { text, usage, costUSD }. Handing the
         * whole object on saved the literal "[object Object]" as the Lyria
         * direction and then told her the desk had rewritten it. */
        const reply = await callModel({
          system: systemPrompt({ engine: to, mode: 'format' }),
          user: `This was written for ${carry.ENGINES[source.engine].label} and is moving to ${carry.ENGINES[to].label}. Keep what it asks for and put it in the format below.\n\n${draft.script.slice(0, 6000)}`,
          maxTokens: 2000,
        });
        const split = splitScriptAndReadback(reply.text);
        /* The words already carried across exactly; a Lyrics block the desk
         * added to the description would be a second, unasked-for copy.
         * YuE2 keeps words in a field of their own, and the desk's YuE2 format
         * says "Always provide both", so with nothing carried it makes up a
         * song. That never belongs in the style line (YuE2 would read lyrics
         * as style, inside a 3,000-character cap), and words she did not
         * write are not put in her Lyrics either: they are left out and she
         * is told. Lyria keeps words inside its brief, so with nothing
         * carried a Lyria brief keeps the desk's block, as before. */
        const parts = carry.splitLyricsBlock(split.script);
        const carriedWords = !!(draft.options || {}).lyrics;
        const rewritten = carriedWords || to === 'yue2' ? parts.prose : split.script;
        if (rewritten && !carry.isBrokenScript(rewritten)) {
          draft.script = rewritten;
          draft.readback = split.readback;
          notes.push('The desk rewrote the description in the new engine\u2019s format. Your lyrics were not sent to it.');
          if (to === 'yue2' && !carriedWords && parts.lyrics) {
            notes.push('The desk also made up words for it. They were left out of the style and out of Lyrics, because they are not yours. Add your own words under Lyrics, or use Write my song idea to draft them.');
          }
        } else {
          notes.push('The desk did not return a usable description, so it came across as it was. You can still edit it by hand.');
        }
      } catch (error) {
        logger.warn('[soundbooth/carry] rewrite skipped: ' + (error && error.message));
        notes.push('The script desk was busy, so the description came across as it was. You can still edit it by hand.');
      }
    }

    const created = await KadeSoundBoothProject.create({ user: req.user.id, ...draft });
    logger.info(`[soundbooth/carry] ${source.engine} -> ${to} user=${req.user.id} from=${source._id} to=${created._id} rewrite=${(req.body || {}).rewrite === true}`);
    return res.json({
      project: projectView(created.toObject ? created.toObject() : created, priceFactor(req.user)),
      from: { id: String(source._id), engine: source.engine, title: source.title },
      notes,
      rewriteAdvised: out.rewriteAdvised,
    });
  } catch (error) {
    logger.error('[soundbooth/carry] failed:', error);
    return res.status(500).json({ error: "Couldn't carry that over." });
  }
});

router.delete('/projects/:id', requireJwtAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ error: 'No such project.' });
    }
    const r = await KadeSoundBoothProject.deleteOne({ _id: req.params.id, user: req.user.id });
    if (!r.deletedCount) return res.status(404).json({ error: 'No such project.' });
    /* The AUDIO is not deleted with the project -- it lives in My Creations,
     * which is the gallery she manages there. Deleting a script here must
     * never quietly take a finished recording with it. */
    return res.json({ ok: true });
  } catch (error) {
    logger.error('[soundbooth/project delete] failed:', error);
    return res.status(500).json({ error: "Couldn't remove that." });
  }
});

/* ====================== POST /reference (import a clip) ====================
 * Her ask, Part 120: "You might put a way to import files in native too."
 *
 * The reliable way to get a SPECIFIC voice is a reference clip -- describing a
 * voice in words missed the age three times out of four when AuK was
 * measured (Part 119.10), and the record says so plainly. So the phone needs
 * to be able to hand over ten to twenty seconds of somebody talking.
 *
 * The clip goes to the same S3/Backblaze storage every gallery file uses, and
 * the render lane is handed the signed URL. It is NOT filed as a gallery asset:
 * a reference clip is an INPUT, and My Creations is for things she made. It
 * also never leaves the estate for AuK (her own GPU pulls it); for Seed
 * Audio it does, and the screen says so before she picks that engine.
 * ------------------------------------------------------------------------- */
const refUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});
/* ⚠️ Part 121.3 — WHAT EACH ENGINE CAN ACTUALLY READ, from its own docs.
 * She imported a .ogg for a AuK clone and got a render with no clone in
 * it. TWO things were wrong and both were mine: the browser's file picker
 * very likely filtered the file out before it was ever sent (an .ogg is
 * typed video/ogg or application/ogg as often as audio/ogg), and AuK
 * would not have taken it anyway — its README says reference audio is
 * **WAV or MP3**. This route was accepting six formats the renderer cannot
 * use, which is a promise the engine does not keep.
 *
 * AuK:  WAV or MP3 (README, reference_voice_url).
 * Seed 1.0: wav, mp3, pcm, ogg_opus (fal schema, audio_urls).
 * m4a is allowed for both and transcoded nowhere — it is the format a
 * phone voice memo actually produces, both engines' stacks decode it via
 * ffmpeg, and refusing it would fail the most common real case. If a clone
 * from an m4a ever comes back wrong, this comment is the first suspect. */
const REF_EXT = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg', 'application/ogg': 'ogg', 'video/ogg': 'ogg',
};
const ENGINE_REF_FORMATS = {
  scenema: { exts: ['wav', 'mp3', 'm4a'], say: 'a WAV, an MP3, or an M4A voice memo' },
  seed: { exts: ['wav', 'mp3', 'm4a', 'ogg'], say: 'a WAV, an MP3, an M4A voice memo, or an OGG' },
  /* Sing it in my voice decodes anything ffmpeg reads; these are the everyday ones. */
  myvoice: { exts: ['wav', 'mp3', 'm4a', 'ogg', 'flac'], say: 'a WAV, an MP3, an M4A, an OGG or a FLAC' },
};

router.post('/reference', requireJwtAuth, refUpload.single('clip'), async (req, res) => {
  try {
    const f = req.file;
    /* Sing it in my voice: an owner's recording to sing. For anyone else the word is unknown and reads as AuK, as before. */
    const asked = (req.body || {}).engine;
    const engine = asked === 'myvoice' && (await myVoiceOwner(req.user.id)) ? 'myvoice' : ['seed', 'yue2'].includes(asked) ? asked : 'scenema';
    const allowed = ENGINE_REF_FORMATS[engine === 'yue2' ? 'seed' : engine];
    if (!f || !f.buffer || !f.buffer.length) {
      /* Logged, because a REFUSED upload used to leave no trace at all — the
       * only log line fired on success, so "did she even try?" was
       * unanswerable from the record. It is answerable now. */
      logger.warn(`[soundbooth/reference] REFUSED user=${req.user.id}: no file in the request`);
      return res.status(400).json({ error: 'No clip arrived. Pick an audio file and try again.' });
    }
    const mime = String(f.mimetype || '').toLowerCase().split(';')[0].trim();
    const nameExt = String(f.originalname || '').toLowerCase().split('.').pop();
    /* Trust the EXTENSION as much as the mime type: browsers type .ogg as
     * video/ogg or application/ogg, and some send an empty type entirely. */
    /* FLAC is known only on the owner's Sing it in my voice lane, so nobody else's refusal can mention another engine taking it. */
    const flac = engine === 'myvoice' && (mime === 'audio/flac' || mime === 'audio/x-flac' || nameExt === 'flac') ? 'flac' : null;
    const ext = REF_EXT[mime] || (Object.values(REF_EXT).includes(nameExt) ? nameExt : null) || flac;
    if (!ext || !allowed.exts.includes(ext)) {
      logger.warn(
        `[soundbooth/reference] REFUSED user=${req.user.id} engine=${engine} name=${String(f.originalname || '?').slice(0, 60)} mime=${mime || '(none)'} ext=${nameExt || '(none)'}`,
      );
      return res.status(400).json({
        error:
          `${engine === 'seed' ? 'Seed Audio' : engine === 'myvoice' ? 'Sing it in my voice' : 'AuK'} can't read that kind of file. It needs ${allowed.say}.` +
          (ext && !allowed.exts.includes(ext) ? ` An ${ext.toUpperCase()} works for the other engine, but not this one.` : ''),
        accepted: allowed.exts,
      });
    }
    const stored = await storeReference(req, { buffer: f.buffer, ext, engine, name: f.originalname });
    return res.status(stored.status).json(stored.body);
  } catch (error) {
    logger.error('[soundbooth/reference] failed:', error);
    return res.status(500).json({ error: 'That clip could not be imported.' });
  }
});

/* The shared tail of every reference import: a file (above) and a media link
 * (Part 293, /reference/link below) both end here, so both answer with the
 * same JSON. A link import adds `source` (the song's site, title, length and
 * link), which is also kept on the music reference so the cover stays named.
 * Returns { status, body } rather than answering, so each route answers once. */
async function storeReference(req, { buffer, ext, engine, name, source }) {
  if (typeof saveBufferToS3 !== 'function') {
    return { status: 503, body: { error: 'File storage is not set up on this server.' } };
  }
  /* Keep AuK source recordings intact. Its worker decodes M4A/MP3 with
   * ffmpeg and samples references only for speech, never for editing. */
  let outBuffer = buffer;
  let outExt = ext;
  let clipSeconds = null;
  let clipAdvice = '';
  let speedNote = '';
  try {
    const { normalizeReferenceClip, durationOf } = require('./kadeSoundBoothStitch');
    const norm = engine === 'seed' ? await normalizeReferenceClip(buffer, ext) : null;
    if (engine === 'scenema' || engine === 'yue2' || engine === 'myvoice') {
      clipSeconds = await durationOf(buffer);
      clipAdvice = engine === 'myvoice' ? 'The original is kept as it is. Choose what is in the file, then Sing it in my voice.' : engine === 'yue2' ? 'The full original is kept. Choose Transcribe reference lyrics for an editable draft of the words. Singing can be misheard; review before generating.' : 'The full original recording is kept. Speech uses a voice sample; editing uses the recording.';
    }
    if (norm && norm.buffer && norm.buffer.length > 1000) {
      outBuffer = norm.buffer;
      outExt = 'wav';
      clipSeconds = norm.seconds;
      clipAdvice = norm.advice;
      /* Oct 2 2026: Seed Audio refuses a clip over 30 seconds, and this one
       * used to be stored at up to 45 and told "the first twenty are what
       * count, and that is fine". A long Seed import is cut here instead, at a
       * pause when there is one, so Play plays exactly what Seed will hear. */
      const seedFit = require('./kadeSoundBoothSeedClips');
      if (typeof norm.seconds === 'number' && norm.seconds > seedFit.SEED_CLIP_TARGET_SECONDS) {
        try {
          const fitted = await seedFit.fitSeedClip(norm.buffer, { format: 'wav', cut: true, seconds: norm.seconds });
          outBuffer = fitted.buffer;
          clipAdvice = seedFit.sayImportTrim(norm.seconds, fitted, { capped: norm.seconds >= 44.9 });
          clipSeconds = Math.round((fitted.seconds || fitted.at) * 10) / 10;
        } catch (e) {
          logger.warn(`[soundbooth/reference] seed cut failed (stored at ${norm.seconds}s; the render cuts it): ${e.message} ${String(e.stderr || '').slice(-200)}`);
          clipAdvice = seedFit.sayImportLong(norm.seconds);
        }
      }
    }
  } catch (e) {
    logger.warn(`[soundbooth/reference] transcode failed (storing the original): ${e.message} ${String(e.stderr || '').slice(0, 200)}`);
    clipAdvice = 'I could not convert it to a studio WAV, so the original file is attached as-is.';
  }
  if (engine === 'yue2' || engine === 'myvoice') {
    /* Only a YuE2 cover may run past six minutes (up to 6:40 while YUE_FIT_TEMPO=1); Sing it in my
     * voice keeps six minutes and its own sentence. */
    const said = musicReferenceError(clipSeconds, { yueCover: engine === 'yue2' });
    const error = said && engine === 'myvoice' ? said.replace('Covers support', 'Sing it in my voice takes recordings') : said;
    if (error) return { status: 400, body: { error } };
    /* Fit by tempo (YUE_FIT_TEMPO=1): a YuE2 cover recording over about 5:52 is sung a little faster
     * to fit YuE2's six minutes. Said now, before any GPU time is spent; '' with the flag off. */
    if (engine === 'yue2') speedNote = musicReferenceSpeedNote(clipSeconds);
  }
  const fileName = `soundbooth-ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${outExt}`;
  const url = await saveBufferToS3({
    userId: String(req.user.id),
    buffer: outBuffer,
    fileName,
    basePath: 'audios',
  });
  if (!url) return { status: 502, body: { error: 'The clip did not save. Try again.' } };
  await registerMusicReference(String(req.user.id), url, clipSeconds, source || null);
  logger.info(`[soundbooth/reference] user=${req.user.id} ${source ? `link=${source.id} ` : ''}${String(name || fileName).slice(0, 80)} ${buffer.length}B -> ${outExt} ${outBuffer.length}B ${clipSeconds !== null ? clipSeconds + 's' : ''}`);
  const link = source ? require('./kadeSoundBoothLink') : null;
  const heard = source
    ? `Covering ${source.title}${clipSeconds !== null ? `, ${link.spokenMinutes(clipSeconds)}` : ''}, from ${link.siteLabel(source.site)}`
    : `Clip imported${clipSeconds !== null ? `, ${clipSeconds} seconds` : ''}`;
  return {
    status: 200,
    body: {
      ok: true,
      url,
      bytes: outBuffer.length,
      seconds: clipSeconds,
      name: String(name || fileName).slice(0, 120),
      /* Said out loud on the phone the moment it lands, because a silent
       * success on an upload is indistinguishable from nothing happening. */
      ext: outExt,
      /* Her ask: "have a play button to check your sample." The URL comes back
       * so the screen can play the thing that is actually attached — the
       * difference between believing a clone is set up and hearing that it is. */
      spoken: `${heard}. ${speedNote ? `${speedNote} ` : ''}${clipAdvice} Play it to check it before generating.`.replace(/\s+/g, ' '),
      ...(source ? { source: { site: source.site, title: source.title, seconds: source.seconds, link: source.link } } : {}),
    },
  };
}

/* ====================== POST /reference/link (a media-link cover) =========
 * Part 293. The route, its words, caps and the Family feature pack gate live in
 * kadeSoundBoothLink.js; the fetching is packages/api description/links.ts
 * (mediaAudio: YouTube on the describer's ladder, other sites through
 * allowlisted yt-dlp extractors, direct files behind the SSRF guard). The
 * storage tail is storeReference. */
router.use(require('./kadeSoundBoothLink').createReferenceLinkRouter({
  auth: requireJwtAuth,
  store: storeReference,
  media: () => require('@librechat/api'),
  features: boothFeatures,
  logger,
}));
/** Part 295: YuE2's Singing or instrumental and Keep the original chords choices, only while
 * YUE_COVERS_V2 is on (packages/api music/yue.ts). Part 296: Keep the original chords then also
 * decides an ABC score's chords, so the separate score choice (`cot`) is left out.
 * Fit by tempo: while YUE_FIT_TEMPO=1 the cover hint and how-to say 6 minutes 40 seconds and that a
 * song over six minutes is sped up a little to fit (packages/api music/lyrics.ts). */
function withYueCovers(guide) {
  const yue = guide && guide.engines && guide.engines.yue2;
  if (!yue || !Array.isArray(yue.settings)) return guide;
  const settings = yueCoverSettings(yue.settings);
  const covered = settings === yue.settings ? yue : { ...yue, settings };
  const lengthed = musicCoverLengthGuide(covered);
  if (lengthed === yue) return guide;
  return { ...guide, engines: { ...guide.engines, yue2: lengthed } };
}
/** The person's Family feature pack map (packages/api family/pack.ts familyFeatures). */
function boothFeatures(user) {
  return require('@librechat/api').familyFeatures(user);
}
/** Part 295: the YuE2 Style choice for THIS person. Outside the Family feature pack it stays,
 * with every option, greyed out: `locked` is "Part of the Family feature pack" and the hint says
 * so (yue.ts yueStyleAccess). A guide without the choice (styles switched off) is unchanged, and
 * the shared GUIDE is never changed. */
function withStyleAccess(guide, user) {
  const yue = guide && guide.engines && guide.engines.yue2;
  if (!yue || !Array.isArray(yue.settings) || !yue.settings.some((s) => s.key === 'band')) return guide;
  const settings = yueStyleAccess(yue.settings, styleAllowed(user), require('./kadeSoundBoothLink').PACK_NOTE);
  if (settings === yue.settings) return guide;
  return { ...guide, engines: { ...guide.engines, yue2: { ...yue, settings } } };
}

/* ============================ POST /idea ================================== */
/* Surprise me, for songs (Parts 228 to 231; the whole story is at the top of
 * packages/api/src/music/idea.ts). The server draws a genre, a lens and six of
 * Kade's own hundred ideas as the register; the lyric model writes one idea in
 * her format: genre tag, one specific human situation, sometimes a craft rule.
 * 5 to 15 seconds and about a fifth of a cent, measured.
 * What she has already been shown is read back from the usage ledger, because
 * the first version kept that list in memory and every deploy emptied it, so
 * the same sump pump came round again. A pitch that lifts five words in a row
 * from her list or from one she has seen is refused and asked for once more.
 * Any failure answers 502 and the page falls back to its own free list. */
const IDEA_DAILY_CAP = Number(process.env.KADE_SOUNDBOOTH_IDEA_CAP || 80);
let ideaDayStamp = '';
const ideaCounts = new Map();
async function ideasAlreadyShown(userId) {
  try {
    const rows = await KadeUsage.find({ user: userId, service: 'soundbooth_script', 'metadata.mode': 'idea', 'metadata.idea': { $exists: true } })
      .sort({ createdAt: -1 }).limit(30).select('metadata.idea').lean();
    return rows.map((row) => String(row.metadata.idea)).reverse();
  } catch (e) {
    logger.warn('[soundbooth/idea] could not read shown ideas: ' + e.message);
    return [];
  }
}
router.post('/idea', requireJwtAuth, express.json({ limit: '8kb' }), async (req, res) => {
  const started = Date.now();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  if (ideaDayStamp !== today) { ideaDayStamp = today; ideaCounts.clear(); }
  const used = ideaCounts.get(req.user.id) || 0;
  if (used >= IDEA_DAILY_CAP) return res.status(429).json({ error: `That's ${IDEA_DAILY_CAP} ideas today.` });
  ideaCounts.set(req.user.id, used + 1);
  try {
    const seen = await ideasAlreadyShown(req.user.id);
    /* Part 293: clean pitches for the child, the review seat and anyone unknown. Review: held to
     * clean in code as well. Her shelf items with a swear or sex in them and the "dirty blues
     * comedy" genre are never drawn for them, and a pitch with an explicit word is refused, so
     * the two-try loop draws again. */
    const audience = await songAudience(req.user, { band: (req.body || {}).band });
    const clean = audience === 'clean';
    const isClean = (words) => !hasExplicitWords(words);
    let idea = null, costUSD = 0, measured = true, tries = 0, usage = {};
    while (!idea && tries < 2) {
      tries += 1;
      const made = await callModel({
        system: songIdeaSystemFor(audience),
        user: songIdeaRequest(songIdeaSparks(Math.random, seen, clean ? isClean : undefined)),
        model: lyricWritingModel,
        maxTokens: 8000,
        temperature: 1.1,
        top_p: 0.95,
        reasoning: { enabled: true, effort: 'medium', exclude: true },
        timeoutMs: 60000,
      });
      costUSD += made.costUSD; measured = measured && made.measured; usage = made.usage;
      const pitched = cleanSongIdea(made.text);
      const candidate = pitched && clean && !isClean(pitched) ? null : pitched;
      if (pitched && !candidate) logger.info(`[soundbooth/idea] try ${tries} refused: not clean, and this account needs it clean`);
      /* Part 239: `tooCloseToShelf` compares five-word runs, so it catches a
       * sentence copied word for word and nothing else. The way a model
       * really repeats itself is by telling the same idea in new words, and
       * every one of those used to pass. Jev is asked the question the word
       * runs were standing in for, and only AFTER they pass, so a real
       * duplicate still costs nothing. Fails open: no answer, draw stands.
       * Kill: KADE_JEV_IDEA_SAME=0. */
      let twin = null;
      if (candidate && !tooCloseToShelf(candidate, seen)) {
        try {
          twin = await jevJudges.sameIdea(candidate, seen);
        } catch (e) {
          twin = null;
        }
        if (twin) logger.info(`[kadeJev][idea-same] ${twin.p.toFixed(2)} redraw: "${String(candidate).slice(0, 60)}" repeats "${String(twin.other).slice(0, 60)}"`);
      }
      if (candidate && !twin && !tooCloseToShelf(candidate, seen)) idea = candidate;
      else logger.info(`[soundbooth/idea] try ${tries} refused: ${candidate ? (twin ? 'the same idea she has already seen, in new words' : 'too close to an idea she has seen') : 'not an idea'}`);
    }
    logKadeUsage({
      userId: req.user.id, service: 'soundbooth_script', quantity: 1, unit: 'calls', costUSD,
      metadata: { mode: 'idea', idea: idea ? songIdeaTitle(idea) : undefined, tries, costMeasured: measured, model: lyricWritingModel, ms: Date.now() - started, inTok: usage.prompt_tokens, outTok: usage.completion_tokens },
    }).catch(() => {});
    logger.info(`[soundbooth/idea] user=${req.user.id} ok=${!!idea} tries=${tries} ${Date.now() - started}ms`);
    if (!idea) return res.status(502).json({ error: 'The writer came back without an idea.' });
    return res.json({ idea });
  } catch (error) {
    logger.warn('[soundbooth/idea] failed: ' + error.message);
    return res.status(502).json({ error: 'The writer could not be reached.' });
  }
});

/* ============================ GET /health ================================= */
/* ============================ POST /suggest =============================== */
router.post('/suggest', requireJwtAuth, express.json({ limit: '64kb' }), (req, res) => {
  return res.json(suggestEngine((req.body || {}).text));
});

router.get('/health', requireJwtAuth, async (req, res) => {
  /* Sing it in my voice: null for every account without a voice model, and then nothing below mentions it. */
  const myVoice = await myVoiceOwner(req.user.id);
  return res.json({
    /* Part 293: per person. The YuE2 cover field carries `link` only with the
     * Family feature pack; everyone else gets `lockedLink`, shown greyed out
     * ("Part of the Family feature pack") by clients that read it
     * (kadeSoundBoothLink.js guideFor). `features` is the same map
     * GET /api/kade/features answers. */
    /* Part 295: price lines and prices at this person's factor (real for Kade). */
    /* Part 295: the Style choice is greyed out outside the pack (withStyleAccess). */
    guide: (MY_VOICE_READY ? withMyVoiceGuide : (g) => g)(withStyleAccess(require('./kadeSoundBoothLink').guideFor(withYueCovers(guidePriced(GUIDE, priceFactor(req.user))), req.user, boothFeatures), req.user), myVoice),
    features: boothFeatures(req.user),
    engines: {
      scenema: { configured: !!process.env.BRIDGE_SECRET, queued: true, model: 'tencent/AuK' },
      seed: { configured: !!process.env.FAL_KEY, queued: false, usdPerMin: priced(SEED_USD_PER_MIN, priceFactor(req.user)) },
      stable: { configured: effectsConfigured(), queued: true, model: effectsModel, usdPerRecording: effectsPrice, models: effectsVariants },
      yue2: { configured: yueConfigured(), queued: true, model: 'm-a-p/YuE2-3B' },
      lyria: { configured: !!lyriaKey(), queued: false, usdPerSong: priced(LYRIA_USD_PER_SONG, priceFactor(req.user)), model: LYRIA_MODEL },
      ...(myVoice ? { myvoice: { configured: true, queued: true, model: 'RVC v2' } } : {}),
    },
    scriptDesk: !!(process.env.REFRAME_PROXY_SECRET || process.env.OPENROUTER_KEY),
    lyricWritingPersona: 'Lyric',
    lyricWritingModel,
    model: MODEL,
    moods: Object.entries(MOODS).map(([k, v]) => ({ key: k, label: v.label })),
    limits: { scenemaChars: MAX_SCENEMA_CHARS, seedChars: MAX_SEED_CHARS, lyriaChars: MAX_LYRIA_CHARS, lyriaLyricsChars: MAX_LYRIA_LYRICS_CHARS, scriptsPerDay: SCRIPT_DAILY_CAP },
  });
});

module.exports = router;
module.exports.MOODS = MOODS;
module.exports._internals = { shapeAukDraft, aukVoiceOff, aukVoiceWarning, editReadback, myVoiceOwner, myVoiceFollowUps, priceFactor, guidePriced, withYueCovers, withStyleAccess, styleAllowed, asksForStyle, SEED_USD_PER_MIN, googleKeyAlarm, lyriaKeyName, readbackIsSungWords, projectView, lyriaWirePrompt, MAX_LYRIA_LYRICS_CHARS, cleanLyrics, withLyricsBlock, withInstrumentalLine, LYRIA_INSTRUMENTAL_LINE, MUSIC_GRAMMAR, checkScenema, checkSeed, fitSeed, checkMusic, normalizeLyriaModel, LYRIA_KNOWN, LYRIA_MODEL, MAX_LYRIA_CHARS, LYRIA_USD_PER_SONG, estimateFor, splitScriptAndReadback, wrapSpeak, sayEstimate, sanitizeScenema, sanitizeSeed, suggestEngine, looksLikeDescription, MAX_SCENEMA_CHARS, MAX_SEED_CHARS, GUIDE, MUSIC_GRAMMAR_WRITE, systemPrompt, verseCount };

