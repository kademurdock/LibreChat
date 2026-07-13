const { TTSProviders } = require('librechat-data-provider');
const { getAppConfig } = require('~/server/services/Config');
const { getProvider } = require('./TTSService');

/**
 * This function retrieves the available voices for the current TTS provider
 * It first fetches the TTS configuration and determines the provider
 * Then, based on the provider, it sends the corresponding voices as a JSON response
 *
 * @param {Object} req - The request object
 * @param {Object} res - The response object
 * @returns {Promise<void>}
 * @throws {Error} - If the provider is not 'openai' or 'elevenlabs', an error is thrown
 */
/**
 * KADE July 13 2026 — the agent voice picker read the STATIC librechat.yaml
 * `speech.tts.openai.voices` list, which froze at 210 while the inworld proxy
 * grew to 324 (voices 211-324 were added to the proxy, never mirrored into the
 * yaml). Fix: pull the LIVE list from the proxy's /voices.json (the same single
 * source of truth the /voices library page uses), so future voice adds appear
 * in the picker automatically with no yaml edit + redeploy. Fail-soft: any
 * error falls back to the yaml list, so the picker never breaks. 5-min cache
 * so opening the picker doesn't hammer the proxy.
 */
let _voiceCache = { at: 0, voices: null };
async function fetchLiveVoices(ttsUrl) {
  try {
    if (!ttsUrl) return null;
    if (_voiceCache.voices && Date.now() - _voiceCache.at < 5 * 60 * 1000) {
      return _voiceCache.voices;
    }
    // ttsUrl is the synthesis endpoint (…/v1/audio/speech); the catalog lives
    // at /voices.json on the same host.
    const base = String(ttsUrl).replace(/\/v1\/audio\/speech.*$/, '').replace(/\/$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const r = await fetch(`${base}/voices.json`, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const d = await r.json();
    const voices = Array.isArray(d?.voices) ? d.voices : null;
    if (voices && voices.length) {
      _voiceCache = { at: Date.now(), voices };
      return voices;
    }
    return null;
  } catch {
    return null;
  }
}

async function getVoices(req, res) {
  try {
    const appConfig =
      req.config ??
      (await getAppConfig({
        role: req.user?.role,
        userId: req.user?.id,
        tenantId: req.user?.tenantId,
      }));

    const ttsSchema = appConfig?.speech?.tts;
    if (!ttsSchema) {
      throw new Error('Configuration or TTS schema is missing');
    }

    const provider = await getProvider(appConfig);
    let voices;

    switch (provider) {
      case TTSProviders.OPENAI:
        // Live list from the proxy (324+), falling back to the static yaml list.
        voices = (await fetchLiveVoices(ttsSchema.openai?.url)) ?? ttsSchema.openai?.voices;
        break;
      case TTSProviders.AZURE_OPENAI:
        voices = ttsSchema.azureOpenAI?.voices;
        break;
      case TTSProviders.ELEVENLABS:
        voices = ttsSchema.elevenlabs?.voices;
        break;
      case TTSProviders.LOCALAI:
        voices = ttsSchema.localai?.voices;
        break;
      default:
        throw new Error('Invalid provider');
    }

    res.json(voices);
  } catch (error) {
    res.status(500).json({ error: `Failed to get voices: ${error.message}` });
  }
}

module.exports = getVoices;
