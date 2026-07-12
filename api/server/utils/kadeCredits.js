/**
 * KADE July 13 2026 — friendly out-of-credits detection for the fork's RAW
 * OpenRouter call sites (Debate Room turns, Describe page, gallery
 * descriptions). Chat traffic gets this for free from reframe-proxy's
 * friendlyErrorBody; these three call OpenRouter directly, so an empty
 * account surfaced as "Insufficient credits ... openrouter.ai" — gibberish
 * (or worse, scary) to family users.
 *
 * KEEP THE MESSAGE IN SYNC with reframe-proxy server.js OUT_OF_CREDITS_MESSAGE
 * (same wording, one voice platform-wide).
 */
const OUT_OF_CREDITS_MESSAGE =
  "Kade-AI is out of AI credits right now, so I can't answer just yet. " +
  'Nothing is wrong on your end and there is nothing you need to fix or pay for. ' +
  'Please let Kade know the site needs more credits. Once she tops it up, ' +
  'just send your message again — all of your conversations are saved.';

/** True when an axios/OpenRouter error smells like an exhausted account. */
function isCreditsError(err) {
  const status = err?.response?.status;
  const raw = JSON.stringify(err?.response?.data || '') + ' ' + String(err?.message || '');
  return status === 402 || /insufficient credits|payment required|credit balance|more credits/i.test(raw);
}

/** The message a HUMAN should see for this error (friendly for credits, fallback otherwise). */
function friendlyAiErrorMessage(err, fallback) {
  return isCreditsError(err) ? OUT_OF_CREDITS_MESSAGE : (fallback || 'Something went wrong — try again.');
}

module.exports = { OUT_OF_CREDITS_MESSAGE, isCreditsError, friendlyAiErrorMessage };
