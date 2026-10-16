'use strict';
/**
 * ZERO-RETENTION ROUTING FOR THE MEDIA DESCRIBERS (Oct 16 2026).
 *
 * Kade's rule: no host may keep a copy of anyone's pictures, videos or documents, or train on
 * them. Every describer request carries OpenRouter's `zdr` and `data_collection: 'deny'`, so it can
 * only reach endpoints that keep nothing. Xiaomi itself is not one of them, so a MiMo request never
 * goes there.
 *
 * Which zero-retention hosts really take in what a describer sends was measured on Oct 16 2026 with
 * self-made clips of known spoken words, one host at a time (evidence: the zero-retention probe
 * results, memory note mimo-media-hosts-and-pro-switches):
 * - A video's soundtrack: only Novita hears it (every word, even four times slowed). DeepInfra and
 *   Venice answered "silent" or invented music, and counted the same 3,688 prompt tokens for a 12,
 *   15 and 47 second clip, so they also look at a fixed handful of frames. MiMo invents music for a
 *   silent clip on any host, so the model's own word about the sound proves nothing.
 * - Pictures and text: DeepInfra and Novita both read them. DeepInfra goes first, because Novita's
 *   filter now and then refuses a harmless request (200, finish_reason content_filter, "The request
 *   was rejected because it was considered high risk"); that text must never be saved or read to
 *   anyone as a description.
 * - Novita refuses a strict json_schema reply format (HTTP 400); json_object works.
 * KADE_VIDEO_HOSTS (a comma list) overrides the video hosts, as it does for the described-video
 * engine in packages/api/src/description/providers.ts.
 */

const ZERO_RETENTION = Object.freeze({ zdr: true, data_collection: 'deny' });

const isMimo = (model) => String(model || '').startsWith('xiaomi/mimo-');

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
 * OpenRouter's `provider` block for one describer request. A MiMo video goes only to the hosts that
 * hear its soundtrack; MiMo pictures and text try DeepInfra first and may fall back to the other
 * zero-retention hosts; Google models never reach AI Studio (Kade's own key, billed double).
 */
function mediaProvider(model, kind, env = process.env) {
  if (isMimo(model)) {
    return kind === 'video'
      ? { ...ZERO_RETENTION, only: videoHosts(env), allow_fallbacks: true }
      : { ...ZERO_RETENTION, order: ['DeepInfra'], allow_fallbacks: true };
  }
  if (String(model || '').startsWith('google/')) {
    return { ...ZERO_RETENTION, ignore: ['google-ai-studio'] };
  }
  return { ...ZERO_RETENTION };
}

/**
 * Whether the host that answered could hear what it was sent: always true for pictures and text;
 * for a MiMo video, only one of `videoHosts`. A reply that names no host is let through, since
 * `only` already pinned the hosts.
 */
function heardBy(model, kind, provider, env = process.env) {
  if (kind !== 'video' || !isMimo(model) || !provider) {
    return true;
  }
  const answered = String(provider).toLowerCase();
  return videoHosts(env).some((host) => host.toLowerCase() === answered);
}

/** A refused or filtered reply is never a description. */
function refusedChoice(choice) {
  return Boolean(
    choice &&
      (choice.finish_reason === 'content_filter' ||
        choice.native_finish_reason === 'content_filter'),
  );
}

/**
 * Reads one chat reply: `text` is the answer, or null when it was refused (`refused`) or when a
 * video went to a host that does not hear its soundtrack (`unheard`).
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
  videoHosts,
  contentKind,
  mediaProvider,
  heardBy,
  refusedChoice,
  readReply,
};
