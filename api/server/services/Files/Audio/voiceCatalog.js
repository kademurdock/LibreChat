/**
 * KADE July 16 2026 — shared live-voice-catalog fetch.
 *
 * Extracted out of getVoices.js so TTSService.js can use it too, without a
 * circular require (getVoices.js already does `require('./TTSService')` for
 * getProvider()).
 *
 * Backstory: the July 13 fix made the PICKER's list (getVoices.js) pull the
 * live 324-voice catalog from the inworld proxy instead of the static
 * librechat.yaml `speech.tts.openai.voices` list (frozen at 210 — voices
 * 211-324 were added on the proxy side and never mirrored into the yaml).
 * But TTSService.js's getVoice() — the function that validates a REQUESTED
 * voice before synthesis and silently substitutes a random one if it looks
 * invalid — was never updated to match, so it kept checking every request
 * against that same stale 210-voice yaml list. Any voice 211-324 (all valid,
 * all shown in the already-fixed picker) failed that check and got replaced
 * by `getRandomVoiceId()` picking blind from the yaml's 1-210 pool. The
 * audition TEXT (built client-side from the real requested voice, before the
 * request ever left the browser) still announced the correct number — only
 * the actual synthesized VOICE got swapped — which is exactly the "sample
 * sounds like a different voice, changes every session" bug Kade reported
 * and reproduced. Root-caused via production log correlation (see
 * PROJECT_STATUS.md, July 16 2026 entry).
 *
 * Fail-soft: any fetch error returns null, so callers fall back to the yaml
 * list (unchanged behavior for the 1-210 range that yaml still gets right).
 * 5-min cache so every audition/synthesis call doesn't hammer the proxy.
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


/**
 * Synchronous, best-effort peek at whatever fetchLiveVoices() last cached --
 * no fetch, never blocks. Used by TTSService.js's provider-strategy functions
 * (e.g. openAIProvider), which are plain sync functions and run AFTER
 * getVoice() has already awaited fetchLiveVoices() once for this request, so
 * the cache is warm by the time they need it. Returns null if nothing has
 * been fetched yet (fail-soft: caller falls back to the static yaml list).
 */
function getCachedLiveVoices() {
  return _voiceCache.voices;
}

module.exports = { fetchLiveVoices, getCachedLiveVoices };
