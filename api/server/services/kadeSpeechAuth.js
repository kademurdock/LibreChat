/**
 * kadeSpeechAuth — the fork's pass for the voice proxy (Oct 16 2026).
 *
 * inworld-tts-proxy's /v1/audio/speech and /v1/audio/transcriptions used to
 * answer anyone who knew the URL, so a stranger could spend Kade's Fish,
 * Inworld and Deepgram credit. The proxy now wants KADE_SPEECH_SECRET (the
 * same Railway variable on the proxy, this service and the bridge):
 *   - the built-in speech and transcription strategies send it as their
 *     Bearer apiKey (kade-config.yaml `speech.*.openai.apiKey`);
 *   - every direct server-side caller (the Library reader, family history,
 *     Reverie radio, described video) spreads these headers into its request.
 * Browsers never hold it: the website's voice mode goes through the signed-in
 * /api/files/speech/tts/manual like the iPhone does. `lane` names the caller in
 * the proxy's ten-minute summary; it proves nothing by itself. With the
 * variable unset the secret is simply left out.
 */
function speechProxyHeaders(lane, env = process.env) {
  const secret = String(env.KADE_SPEECH_SECRET || '').split(',')[0].trim();
  const headers = { 'x-kade-caller': String(lane || 'fork') };
  if (secret) {
    headers['x-proxy-secret'] = secret;
  }
  return headers;
}

module.exports = { speechProxyHeaders };
