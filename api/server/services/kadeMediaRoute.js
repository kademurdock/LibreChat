'use strict';
/**
 * ZERO-RETENTION ROUTING FOR THE MEDIA DESCRIBERS (Oct 16 2026; videos moved Nov 13 2026).
 *
 * Kade's rule: no host may keep a copy of anyone's pictures, videos or documents, or train on
 * them. Every describer request carries OpenRouter's `zdr` and `data_collection: 'deny'`, so it can
 * only reach endpoints that keep nothing. Xiaomi itself is not one of them, so a MiMo request never
 * goes there.
 *
 * PICTURES AND TEXT stay on the lane's own model. Measured Oct 16 2026 (memory note
 * mimo-media-hosts-and-pro-switches): MiMo's zero-retention hosts read them, and DeepInfra goes
 * first, because Novita's filter now and then refused a harmless request (200, finish_reason
 * content_filter, "The request was rejected because it was considered high risk"); that text must
 * never be saved or read to anyone as a description.
 *
 * VIDEOS. A video's soundtrack must be heard, and the model's own word about the sound proves
 * nothing: MiMo invents music for a silent clip on any host. From Oct 16 2026 a MiMo video was
 * pinned to Novita, the one zero-retention host that heard it. On Nov 13 2026 Novita no longer
 * serves MiMo: a Novita-only request answers HTTP 404 "No allowed providers are available for the
 * selected model", so every video sent with a MiMo model failed. A hearing test the same day, with
 * a clip of known spoken words, of the hosts that do serve MiMo Pro:
 * - Xiaomi hears every word, but keeps data.
 * - DeepInfra (zero retention) is deaf to a video's sound. On Oct 16 it also counted the same 3,688
 *   prompt tokens for a 12, 15 and 47 second clip, so it looks at a fixed handful of frames.
 * - GMICloud answers that it cannot take video or audio. StreamLake returned an error.
 * - PrimaLabs (zero retention, about nine times the price) was not tested.
 * So no zero-retention MiMo host is known to hear a video, and a lane whose model is MiMo sends its
 * videos to another model instead (`mediaModel`): KADE_VIDEO_MODEL, by default
 * google/gemini-3.8-flash, which Google Vertex serves with zero retention and which hears the
 * soundtrack. The same model and route the described-video engine uses
 * (packages/api/src/description/providers.ts, KADE_DESCRIPTION_MODEL).
 *
 * KADE_VIDEO_MODEL=mimo (or a MiMo id) keeps videos on MiMo, for the day a zero-retention MiMo host
 * hears them again. A MiMo video still goes only to KADE_VIDEO_HOSTS (a comma list, default Novita,
 * as in providers.ts), so name the hearing host there too. Use the names OpenRouter reports as a
 * reply's `provider` ("Novita"), not endpoint tags ("novita/fp8"): `heardBy` compares them. Before
 * trusting a host, look at OpenRouter's endpoint list for the model
 * (/api/v1/models/<id>/endpoints) and send it a clip of known words.
 *
 * A caller works out the model once per request (`mediaModel`) and uses that one model for
 * everything about the request: the id sent, `mediaProvider`, how it thinks, the room for its
 * thinking, `readReply`, `refusalTries`, the price of a reply that names no cost (`videoRates`)
 * and the usage row.
 */

const ZERO_RETENTION = Object.freeze({ zdr: true, data_collection: 'deny' });

/**
 * How a refused request is asked again: Novita's two refusals on Oct 16 2026 came in one burst
 * about 11 s apart, so up to three tries, 20 s apart. Tests shorten the wait.
 */
const limits = { refusalTries: 3, refusalMs: 20000 };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isMimo = (model) => String(model || '').startsWith('xiaomi/mimo-');
const isGoogle = (model) => String(model || '').startsWith('google/');

/** Where a MiMo lane's videos go unless KADE_VIDEO_MODEL says otherwise. */
const VIDEO_MODEL = 'google/gemini-3.8-flash';

/** The zero-retention hosts that hear a MiMo video's soundtrack, in the order asked. */
function videoHosts(env = process.env) {
  const chosen = String((env && env.KADE_VIDEO_HOSTS) || '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  return chosen.length ? chosen : ['Novita'];
}

/**
 * What a describer request sends: `video` when a video part goes (its soundtrack must be heard),
 * `image` for pictures and documents, `text` otherwise.
 */
function contentKind(content) {
  const parts = Array.isArray(content) ? content : [];
  if (parts.some((part) => part && part.type === 'video_url')) {
    return 'video';
  }
  if (parts.some((part) => part && (part.type === 'image_url' || part.type === 'file'))) {
    return 'image';
  }
  return 'text';
}

/**
 * The model one request is really sent to. A video from a lane whose model is MiMo goes to the
 * video model, KADE_VIDEO_MODEL (default `VIDEO_MODEL`), because no zero-retention MiMo host hears a
 * video's soundtrack (see the top of this file). KADE_VIDEO_MODEL=mimo keeps the lane's own MiMo
 * model; a MiMo id there is used as given; either way that video is pinned to `videoHosts`.
 * Pictures, documents and text, and every lane whose model is not MiMo, keep the model unchanged.
 */
function mediaModel(model, kind, env = process.env) {
  if (kind !== 'video' || !isMimo(model)) {
    return model;
  }
  const chosen = String((env && env.KADE_VIDEO_MODEL) || '').trim();
  if (!chosen) {
    return VIDEO_MODEL;
  }
  return chosen.toLowerCase() === 'mimo' ? model : chosen;
}

/**
 * OpenRouter's `provider` block for one describer request, for the model it is really sent to
 * (`mediaModel`). A MiMo video goes only to the hosts that hear its soundtrack; MiMo pictures and
 * text try DeepInfra first and may fall back to the other zero-retention hosts; Google models never
 * reach AI Studio (Kade's own key, billed double), which leaves Google Vertex.
 */
function mediaProvider(model, kind, env = process.env) {
  if (isMimo(model)) {
    return kind === 'video'
      ? { ...ZERO_RETENTION, only: videoHosts(env), allow_fallbacks: true }
      : { ...ZERO_RETENTION, order: ['DeepInfra'], allow_fallbacks: true };
  }
  if (isGoogle(model)) {
    return { ...ZERO_RETENTION, ignore: ['google-ai-studio'] };
  }
  return { ...ZERO_RETENTION };
}

/**
 * Whether the host that answered could hear what it was sent: always true for pictures and text;
 * for a MiMo video, only one of `videoHosts`. A reply that names no host is let through, since
 * `only` already pinned the hosts. Google's models hear a video on every host that serves them.
 */
function heardBy(model, kind, provider, env = process.env) {
  if (kind !== 'video' || !isMimo(model) || !provider) {
    return true;
  }
  const answered = String(provider).toLowerCase();
  return videoHosts(env).some((host) => host.toLowerCase() === answered);
}

/**
 * Google's own words for a declined request, which OpenRouter passes on as a reply's
 * `native_finish_reason` (the same list the described-video engine reads, providers.ts `declined`).
 */
const DECLINED = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'RECITATION',
  'IMAGE_SAFETY',
]);

/** A refused or filtered reply is never a description. */
function refusedChoice(choice) {
  if (!choice) {
    return false;
  }
  return (
    choice.finish_reason === 'content_filter' ||
    choice.native_finish_reason === 'content_filter' ||
    DECLINED.has(String(choice.native_finish_reason || '').toUpperCase())
  );
}

/**
 * How many times a request is asked when its reply is refused. Novita's filter (MiMo) refuses a
 * harmless request now and then and passes it a little later, so MiMo is asked up to
 * `limits.refusalTries` times. Google declines the same clip again (providers.ts `Refusal`), so
 * asking twice only pays twice: any other model is asked once.
 */
function refusalTries(model) {
  return isMimo(model) ? limits.refusalTries : 1;
}

const isGeminiPro = (model) => /(?:^|\/)gemini-[^/]*-pro(?:-|$)/i.test(String(model || ''));

/**
 * Whether a model thinks whatever it is asked. OpenRouter refuses to switch reasoning off for
 * Google's Gemini Pro models and, on Nov 13 2026, for google/gemini-3.8-flash: HTTP 400 "Reasoning
 * is mandatory for this endpoint and cannot be disabled." Gemini's Flash-Lite models, the gallery's
 * first describers, took reasoning off, as MiMo does.
 */
function alwaysThinks(model) {
  const id = String(model || '');
  return /(?:^|\/)gemini-/i.test(id) && !/flash-lite/i.test(id);
}

/**
 * How a describer that wants a plain answer, not a thinking pass, asks `model` for one: the
 * `reasoning` block to send, and `room`, the output tokens to add to max_tokens for the thinking
 * the model does anyway. A thinking model counts its thinking inside max_tokens, so without room a
 * thinking pass eats the answer (kadeAsset.js, Part 121.3: descriptions cut off at 15 to 41
 * characters). Gemini Pro thinks briefly and hides it, as the gallery has asked it to since Oct 16
 * 2026; a Gemini Flash that cannot switch thinking off is asked for the least it does.
 */
function plainAnswer(model) {
  if (isGeminiPro(model)) {
    return { reasoning: { effort: 'low', exclude: true }, room: 2000 };
  }
  if (alwaysThinks(model)) {
    return { reasoning: { effort: 'minimal', exclude: true }, room: 2000 };
  }
  return { reasoning: { enabled: false }, room: 0 };
}

/**
 * USD per million tokens, in and out, for a reply from the video model that names no cost. The
 * default is google/gemini-3.8-flash's price in OpenRouter's public model list on Nov 13 2026
 * ($0.825 and $4.125, thinking billed as output). Its Vertex endpoints list $0.75 and $3.75
 * (global) and $0.825 and $4.125 (us), so the dearer one never books too little. A different
 * KADE_VIDEO_MODEL needs KADE_VIDEO_IN_USD_PER_M and KADE_VIDEO_OUT_USD_PER_M set with it.
 */
function videoRates(env = process.env) {
  const rate = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    in: rate(env && env.KADE_VIDEO_IN_USD_PER_M, 0.825),
    out: rate(env && env.KADE_VIDEO_OUT_USD_PER_M, 4.125),
  };
}

/**
 * Reads one chat reply: `text` is the answer, or null when it was refused (`refused`) or when a
 * video went to a host that does not hear its soundtrack (`unheard`). `model` is the model the
 * request was really sent to (`mediaModel`).
 */
function readReply(data, model, kind, env = process.env) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : undefined;
  if (refusedChoice(choice)) {
    return { text: null, refused: true, unheard: false };
  }
  if (!heardBy(model, kind, data && data.provider, env)) {
    return { text: null, refused: false, unheard: true };
  }
  const text = choice && choice.message && choice.message.content;
  return { text: typeof text === 'string' ? text.trim() : null, refused: false, unheard: false };
}

module.exports = {
  ZERO_RETENTION,
  VIDEO_MODEL,
  limits,
  pause,
  isMimo,
  isGoogle,
  videoHosts,
  contentKind,
  mediaModel,
  mediaProvider,
  heardBy,
  refusedChoice,
  refusalTries,
  alwaysThinks,
  plainAnswer,
  videoRates,
  readReply,
};
