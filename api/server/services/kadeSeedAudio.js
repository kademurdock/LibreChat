/* ----------------------------------------------------------------------------
 * SEED AUDIO, ONE DOOR FOR EVERY CALLER (Oct 22 2026)
 *
 * Her ask: "Figure out how we can update our soundbooth to seedaudio 1.5
 * instead of 1. If we have to use something besides fal, I just ran out of
 * funding on there so we can switch if we need."
 *
 * What is true on Oct 22 2026:
 *   - Seed Audio 1.5 is not public anywhere. BytePlus (ByteDance's own cloud)
 *     runs it as a confidential early access on ModelArk endpoints (an "ep-"
 *     endpoint id plus a bearer key); fal does not have it.
 *   - Seed Audio 1.0, the model fal resold, is sold directly by BytePlus Seed
 *     Speech: POST https://voice.ap-southeast-1.bytepluses.com/api/v3/tts/create
 *     with an X-Api-Key from the Seed Speech console (a ModelArk key is refused
 *     with 401 / 45000010). $0.15 a generated minute against fal's $0.1875,
 *     billed on `original_duration`, 60 free minutes when the service is turned
 *     on. Same prompt language, same @Audio1-@Audio3 tags, same 30 s clip and
 *     120 s output limits, so every script the booth's desk writes still fits.
 *     Field names: the BytePlus Audio 1.0 API reference as captured in the
 *     public openapi.yaml of tryAGI/BytePlusSeedSpeech (text_prompt, references
 *     [{audio_url | audio_data | speaker | image_url}], audio_config {format,
 *     sample_rate, speech_rate -50..100, loudness_rate -50..100, pitch_rate
 *     -12..12, enable_subtitle}, watermark; answer {code, message, audio
 *     (base64), duration, original_duration, url (two hours), subtitle}).
 *
 * So this door speaks BytePlus when BYTEPLUS_SEED_KEY is set and fal otherwise
 * (KADE_SEED_PROVIDER=byteplus|fal forces one). KADE_SEED_MODEL (and
 * KADE_SEED_MODEL_MULTILINGUAL) rename the model the day BytePlus opens 1.5 on
 * Seed Speech; 1.5 on ModelArk endpoints is a different request and gets its
 * own branch here when she has access.
 *
 * BytePlus answers with the audio itself (base64); its link dies in two hours,
 * so callers get a Buffer to store. fal answers with a durable link, as before.
 * -------------------------------------------------------------------------- */
const crypto = require('crypto');

const BYTEPLUS_URL = 'https://voice.ap-southeast-1.bytepluses.com/api/v3/tts/create';
const FAL_URL = 'https://fal.run/bytedance/seed-audio-1.0';

/** Dollars per generated minute, read Oct 22 2026 (fal: Sep 2 2026, Part 119.2). */
const PRICES = { byteplus: 0.15, fal: 0.1875 };
const SERVICES = { byteplus: 'byteplus_audio', fal: 'fal_audio' };
const WHERE = {
  byteplus: "Made on BytePlus's servers, ByteDance's own cloud, so your words and clips leave the house.",
  fal: "Made on fal's servers, so your words and clips leave the house.",
};

/** 'byteplus', 'fal', or null when neither can run. */
function seedProvider(env = process.env) {
  const has = { byteplus: !!env.BYTEPLUS_SEED_KEY, fal: !!env.FAL_KEY };
  const want = String(env.KADE_SEED_PROVIDER || 'auto').trim().toLowerCase();
  if (want === 'byteplus' || want === 'fal') {
    return has[want] ? want : null;
  }
  if (has.byteplus) {
    return 'byteplus';
  }
  return has.fal ? 'fal' : null;
}

function seedUsdPerMin(env = process.env) {
  return PRICES[seedProvider(env)] ?? PRICES.fal;
}

function seedWhere(env = process.env) {
  return WHERE[seedProvider(env)] || WHERE.fal;
}

function seedModel(multilingual, env = process.env) {
  if (multilingual) {
    return env.KADE_SEED_MODEL_MULTILINGUAL || 'seed-audio-1.0-multilingual';
  }
  return env.KADE_SEED_MODEL || 'seed-audio-1.0';
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) {
    return 0;
  }
  return n < lo ? lo : n > hi ? hi : n;
}

/** The booth's "times" (0.5 to 2, one is normal) as BytePlus's rate (-50 to 100, zero is normal). */
function rateFrom(times) {
  return clampInt((Number(times) - 1) * 100, -50, 100);
}

const FORMATS = ['wav', 'mp3', 'pcm', 'ogg_opus'];
const SAMPLE_RATES = [8000, 16000, 24000, 32000, 44100, 48000];

/**
 * The BytePlus request for one generation.
 * @param {object} r { prompt, format, sampleRate, speed, volume, pitch, multilingual, audioUrls, imageUrl, voice, subtitles }
 */
function byteplusBody(r, env = process.env) {
  const format = FORMATS.includes(r.format) ? r.format : 'wav';
  const sampleRate = SAMPLE_RATES.includes(r.sampleRate) ? r.sampleRate : 48000;
  const audio_config = { format, sample_rate: sampleRate };
  if (typeof r.speed === 'number' && rateFrom(r.speed) !== 0) {
    audio_config.speech_rate = rateFrom(r.speed);
  }
  if (typeof r.volume === 'number' && rateFrom(r.volume) !== 0) {
    audio_config.loudness_rate = rateFrom(r.volume);
  }
  if (Number.isFinite(Number(r.pitch)) && clampInt(r.pitch, -12, 12) !== 0) {
    audio_config.pitch_rate = clampInt(r.pitch, -12, 12);
  }
  if (r.subtitles) {
    audio_config.enable_subtitle = true;
  }
  const body = {
    model: seedModel(!!r.multilingual, env),
    text_prompt: String(r.prompt || ''),
    audio_config,
    watermark: { aigc_watermark: false },
  };
  const urls = Array.isArray(r.audioUrls) ? r.audioUrls.filter((u) => typeof u === 'string' && u).slice(0, 3) : [];
  /* A clip beats a preset (the old fal note); image and audio never mix. */
  if (urls.length) {
    body.references = urls.map((audio_url) => ({ audio_url }));
  } else if (r.imageUrl) {
    body.references = [{ image_url: String(r.imageUrl) }];
  } else if (r.voice) {
    body.references = [{ speaker: String(r.voice) }];
  }
  return body;
}

/** The fal request, exactly as the three callers built it before. */
function falBody(r) {
  const body = {
    prompt: String(r.prompt || ''),
    output_format: FORMATS.includes(r.format) ? r.format : 'wav',
    sample_rate: SAMPLE_RATES.includes(r.sampleRate) ? r.sampleRate : 48000,
  };
  if (typeof r.speed === 'number') {
    body.speed = r.speed;
  }
  if (typeof r.volume === 'number') {
    body.volume = r.volume;
  }
  if (Number.isInteger(r.pitch)) {
    body.pitch = r.pitch;
  }
  if (r.multilingual) {
    body.multilingual = true;
  }
  const urls = Array.isArray(r.audioUrls) ? r.audioUrls.filter((u) => typeof u === 'string' && u).slice(0, 3) : [];
  if (urls.length) {
    body.audio_urls = urls;
  } else if (r.imageUrl) {
    body.image_url = String(r.imageUrl);
  } else if (r.voice) {
    body.voice = String(r.voice);
  }
  return body;
}

function costFor(seconds, provider) {
  return Math.round((seconds / 60) * (PRICES[provider] ?? PRICES.fal) * 1000) / 1000;
}

const MIME = { wav: 'audio/wav', mp3: 'audio/mpeg', ogg_opus: 'audio/ogg', pcm: 'audio/L16' };

/** BytePlus answer codes worth saying in plain words. */
const PLAIN_CODES = {
  45000030: 'BytePlus has not turned Seed Audio on for this account yet (code 45000030). Turn it on in the Seed Speech console.',
  45000010: 'BytePlus did not accept the Seed Speech key (code 45000010). It needs a Seed Speech key, not a ModelArk one.',
};

/**
 * One Seed Audio generation.
 * Resolves to null when the engine answered without a clip (callers say "returned no clip");
 * throws the provider's own error otherwise (callers pass it to providerError).
 * @returns {Promise<null | { provider, model, service, buffer: Buffer|null, url: string|null,
 *   seconds, costUSD, format, ext, mime, subtitle, requestId }>}
 */
async function generateSeed(r, { env = process.env, http = require('axios'), timeoutMs = 180000 } = {}) {
  const provider = seedProvider(env);
  if (!provider) {
    const e = new Error('Seed Audio is not configured on this server.');
    e.seedUnavailable = true;
    throw e;
  }
  if (provider === 'byteplus') {
    const body = byteplusBody(r, env);
    const requestId = crypto.randomUUID();
    let res;
    try {
      res = await http.post(BYTEPLUS_URL, body, {
        headers: {
          'X-Api-Key': env.BYTEPLUS_SEED_KEY,
          'X-Api-Request-Id': requestId,
          'Content-Type': 'application/json',
        },
        timeout: timeoutMs,
        maxBodyLength: 64 * 1024 * 1024,
        maxContentLength: 200 * 1024 * 1024,
      });
    } catch (e) {
      /* Two answers seen live on Oct 22 2026 with her new key, said in plain words:
       * 45000030 "requested resource not granted" = the key is good but Seed Audio
       * is not turned on for the account; 45000010 = not a Seed Speech key. */
      const data = e && e.response && e.response.data;
      const code = data && Number(data.code);
      const plain = PLAIN_CODES[code];
      if (plain) {
        e.response.data = { ...data, message: plain };
        e.message = plain;
      }
      throw e;
    }
    const d = (res && res.data) || {};
    let buffer = typeof d.audio === 'string' && d.audio ? Buffer.from(d.audio, 'base64') : null;
    if ((!buffer || buffer.length < 1000) && typeof d.url === 'string' && /^https:\/\//i.test(d.url)) {
      const file = await http.get(d.url, { responseType: 'arraybuffer', timeout: 60000 });
      buffer = Buffer.from(file.data);
    }
    if (!buffer || buffer.length < 1000) {
      /* An answer that carries a provider code and message is an error the
       * person should hear in its own words; a bare empty answer is "no clip". */
      if (d.message && d.code && Number(d.code) !== 0 && Number(d.code) !== 20000000) {
        const e = new Error(String(d.message));
        e.response = { status: res && res.status, data: d };
        throw e;
      }
      return null;
    }
    const seconds = Math.max(1, Math.round(Number(d.original_duration || d.duration) || 0));
    const format = body.audio_config.format;
    return {
      provider,
      model: body.model,
      service: SERVICES.byteplus,
      buffer,
      url: null,
      seconds,
      costUSD: costFor(Number(d.original_duration) || seconds, provider),
      format,
      ext: format === 'ogg_opus' ? 'ogg' : format,
      mime: MIME[format] || 'application/octet-stream',
      subtitle: d.subtitle || null,
      requestId,
    };
  }
  const body = falBody(r);
  const res = await http.post(FAL_URL, body, {
    headers: { Authorization: `Key ${env.FAL_KEY}`, 'Content-Type': 'application/json' },
    timeout: timeoutMs,
  });
  const audio = res && res.data && res.data.audio;
  if (!audio || !audio.url) {
    return null;
  }
  const seconds = Math.max(1, Math.round(Number(audio.duration) || 0));
  const format = body.output_format;
  return {
    provider,
    model: 'seed-audio-1.0',
    service: SERVICES.fal,
    buffer: null,
    url: audio.url,
    seconds,
    costUSD: costFor(seconds, provider),
    format,
    ext: format === 'ogg_opus' ? 'ogg' : format,
    mime: MIME[format] || 'application/octet-stream',
    subtitle: null,
    requestId: null,
  };
}

module.exports = {
  generateSeed,
  seedProvider,
  seedUsdPerMin,
  seedWhere,
  seedModel,
  byteplusBody,
  falBody,
  rateFrom,
  PRICES,
  SERVICES,
  BYTEPLUS_URL,
  FAL_URL,
};
