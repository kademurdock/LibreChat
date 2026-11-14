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
 *
 * HALF PRICE FOR VIDEOS NOBODY WAITS ON (Nov 14 2026). Google Vertex's flex tier of the video model
 * costs half its standard tier and keeps nothing either (`FLEX_ENDPOINT`), but it is slower and is
 * turned away when Google is busy. So only background callers ask for it, the Library's video
 * describer (kadeReadingRoomDescribe.js) and the gallery's videos (kadeAsset.js), and each asks
 * once more on the standard tier when flex fails (`askFlexFirst`). Share-to-describe and companion
 * sight, where a person waits, stay on the standard tier.
 */

const ZERO_RETENTION = Object.freeze({ zdr: true, data_collection: 'deny' });

/**
 * OpenRouter's endpoint for Google Vertex's flex tier of the video model. On OpenRouter's endpoint
 * list of Nov 14 2026 (21:29 UTC), google/gemini-3.8-flash costs $0.375 and $1.875 per million
 * tokens there, half the $0.75 and $3.75 of Vertex's global standard endpoint, and the endpoint is
 * on OpenRouter's zero-retention list. It was slower that day: about a 15-second wait, two minutes
 * at the slow end, and 94% uptime over a day. The described-video engine has asked the same
 * endpoint since Sep 26 2026 (packages/api/src/description/providers.ts `flexEndpoint`).
 */
const FLEX_ENDPOINT = 'google-vertex/global/flex';

/**
 * How a refused request is asked again: Novita's two refusals on Oct 16 2026 came in one burst
 * about 11 s apart, so up to three tries, 20 s apart. Tests shorten the wait.
 * `flexQueueMs`: how much longer than a standard try a flex try may take, for Google's queue (the
 * described-video engine's `visionLimits.flexQueueMs`: in its Sep 26 2026 bake-off flex's first
 * byte came 19 to 112 s in).
 */
const limits = { refusalTries: 3, refusalMs: 20000, flexQueueMs: 120000 };
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
 * Whether a background caller's request for `model` asks Google Vertex's flex tier first. Only a
 * Google model has one here. KADE_VIDEO_TIER=standard puts every request back on the standard
 * tier, as before Nov 14 2026.
 */
function flexFor(model, env = process.env) {
  const tier = String((env && env.KADE_VIDEO_TIER) || '')
    .trim()
    .toLowerCase();
  return isGoogle(model) && tier !== 'standard';
}

/**
 * OpenRouter's `provider` block for one describer request, for the model it is really sent to
 * (`mediaModel`). A MiMo video goes only to the hosts that hear its soundtrack; MiMo pictures and
 * text try DeepInfra first and may fall back to the other zero-retention hosts; Google models never
 * reach AI Studio (Kade's own key, billed double), which leaves Google Vertex.
 *
 * `flex` (Nov 14 2026, for background callers only): a Google request goes only to Vertex's flex
 * endpoint, still with zero retention, and with no fallback inside OpenRouter, since a flex request
 * that fell back there would bill the standard price unasked. When flex fails, the caller asks once
 * more on the standard tier itself (`askFlexFirst`). Other models have no flex tier here and are
 * routed as before, and so is everything when KADE_VIDEO_TIER=standard (`flexFor`).
 */
function mediaProvider(model, kind, env = process.env, { flex = false } = {}) {
  if (isMimo(model)) {
    return kind === 'video'
      ? { ...ZERO_RETENTION, only: videoHosts(env), allow_fallbacks: true }
      : { ...ZERO_RETENTION, order: ['DeepInfra'], allow_fallbacks: true };
  }
  if (isGoogle(model)) {
    return flex && flexFor(model, env)
      ? {
          ...ZERO_RETENTION,
          only: [FLEX_ENDPOINT],
          ignore: ['google-ai-studio'],
          allow_fallbacks: false,
        }
      : { ...ZERO_RETENTION, ignore: ['google-ai-studio'] };
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

/** A positive price from a setting, or `fallback`. */
const rate = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * USD per million tokens, in and out, for a reply from the video model that names no cost. The
 * default is google/gemini-3.8-flash's price in OpenRouter's public model list on Nov 13 2026
 * ($0.825 and $4.125, thinking billed as output). Its Vertex endpoints list $0.75 and $3.75
 * (global) and $0.825 and $4.125 (us), so the dearer one never books too little. A different
 * KADE_VIDEO_MODEL needs KADE_VIDEO_IN_USD_PER_M and KADE_VIDEO_OUT_USD_PER_M set with it.
 */
function videoRates(env = process.env) {
  return {
    in: rate(env && env.KADE_VIDEO_IN_USD_PER_M, 0.825),
    out: rate(env && env.KADE_VIDEO_OUT_USD_PER_M, 4.125),
  };
}

/**
 * USD per million tokens, in and out, on Vertex's flex tier: for a flex reply that names no cost,
 * and for the Library's estimate of a run that asks flex. The default is google/gemini-3.8-flash on
 * `FLEX_ENDPOINT` ($0.375 and $1.875, OpenRouter's endpoint list on Nov 14 2026; it doubles on Jan 1
 * 2027). A different KADE_VIDEO_MODEL needs KADE_VIDEO_FLEX_IN_USD_PER_M and
 * KADE_VIDEO_FLEX_OUT_USD_PER_M set with it.
 */
function flexRates(env = process.env) {
  return {
    in: rate(env && env.KADE_VIDEO_FLEX_IN_USD_PER_M, 0.375),
    out: rate(env && env.KADE_VIDEO_FLEX_OUT_USD_PER_M, 1.875),
  };
}

/**
 * The tier that served a reply, `flex` or `standard`: what OpenRouter's `service_tier` says, or the
 * tier asked when it says nothing. A flex request that Google moved to its standard tier is billed
 * the standard price (OpenRouter: billing follows the tier that served), so it is priced as one.
 */
function servedTier(data, asked) {
  const said = String((data && data.service_tier) || '')
    .trim()
    .toLowerCase();
  if (asked !== 'flex' || !said) {
    return asked;
  }
  return said === 'flex' ? 'flex' : 'standard';
}

/** A reply cut off at its token limit: OpenRouter's `length`, or Google's own MAX_TOKENS. */
function cutOff(choice) {
  return (
    Boolean(choice) &&
    (choice.finish_reason === 'length' ||
      String(choice.native_finish_reason || '').toUpperCase() === 'MAX_TOKENS')
  );
}

/**
 * Why the reply to a flex try is no use, so it is asked again on the standard tier; '' when it can
 * be read. An error OpenRouter sent inside the reply (Google took the request, then failed: busy,
 * or out of time), a reply with no answer, or one cut off at its token limit. A refusal is read as
 * one (`readReply`), never asked again: Google declines the same clip on standard too. So is a
 * content filter's decline sent as an error inside the reply (OpenRouter's `error_type`
 * content_policy_violation or refusal, as providers.ts reads it).
 */
function flexTrouble(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : undefined;
  const error = (choice && choice.error) || (data && data.error);
  if (error || (choice && choice.finish_reason === 'error')) {
    const type = error && error.metadata && error.metadata.error_type;
    if (type === 'content_policy_violation' || type === 'refusal') {
      return '';
    }
    const code = Number(error && error.code);
    return Number.isInteger(code) && code > 0 ? `error ${code} in the reply` : 'error in the reply';
  }
  if (!choice) {
    return 'no answer';
  }
  return cutOff(choice) ? 'cut off' : '';
}

/**
 * Whether a flex try that failed outright is worth one more try on the standard tier: Google busy
 * or rate limiting (429), a server error (5xx), no flex endpoint to send it to (404: renamed,
 * dropped or down), a timeout (408, or the caller's own deadline), or a connection that dropped
 * with no answer. A refused key, no credit or a bad request (400, 401, 402, 403, 413) would fail on
 * standard too.
 */
function flexRetryable(error) {
  const status = Number(error && error.response && error.response.status) || 0;
  if (status) {
    return status === 404 || status === 408 || status === 429 || status >= 500;
  }
  return Boolean(error && (error.isAxiosError || error.code));
}

/** A failed flex try in a few words for the log: its HTTP status or error code, never its body. */
function flexFailure(error) {
  const status = error && error.response && error.response.status;
  return status ? `HTTP ${status}` : String((error && error.code) || 'no answer');
}

/**
 * Asks one background request on Vertex's flex tier first when `flex` (`flexFor`), then once more
 * on the standard tier if flex failed in a way worth it (`flexRetryable`) or its reply is no use
 * (`flexTrouble`). OpenRouter never moves a flex request to standard by itself, since flex is
 * pinned with no fallback (`mediaProvider`), so this is the one second try, at the standard price.
 * `ask(tier)` sends one request and answers its axios response; the caller counts each reply's
 * cost there, a flex reply that was no use included. `onRetry(reason)` hears why flex failed.
 * Answers `{ response, tier }`: the reply that is used and the tier it was asked on.
 */
async function askFlexFirst(flex, ask, onRetry = () => {}) {
  if (!flex) {
    return { response: await ask('standard'), tier: 'standard' };
  }
  let reason;
  try {
    const response = await ask('flex');
    reason = flexTrouble(response && response.data);
    if (!reason) {
      return { response, tier: 'flex' };
    }
  } catch (error) {
    if (!flexRetryable(error)) {
      throw error;
    }
    reason = flexFailure(error);
  }
  onRetry(reason);
  return { response: await ask('standard'), tier: 'standard' };
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
  FLEX_ENDPOINT,
  limits,
  pause,
  isMimo,
  isGoogle,
  videoHosts,
  contentKind,
  mediaModel,
  flexFor,
  mediaProvider,
  heardBy,
  refusedChoice,
  refusalTries,
  alwaysThinks,
  plainAnswer,
  videoRates,
  flexRates,
  servedTier,
  cutOff,
  flexTrouble,
  flexRetryable,
  askFlexFirst,
  readReply,
};
