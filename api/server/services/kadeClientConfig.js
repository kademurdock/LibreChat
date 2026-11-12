'use strict';
/* KADE Nov 12 2026 (platform audit, phase 3 A3): one pacing rule for every app, owned by the server.
 *
 * The iPhone (KadeAPIClient minGap 1.5 s, a floor), Android (KadeClient MIN_GAP_MS 1500, a mutex held
 * through the delay, so a queue) and the phone proxy (4 s, one global chain) each froze their own guess
 * into a release. GET /api/kade/client-config answers the numbers instead, read once per launch.
 *
 * mode "legacy" (the default) answers exactly what the apps do today: 1.5 s on every lane. Setting
 * KADE_CLIENT_PACING=lanes answers per-lane gaps, never faster than the real limiters
 * (TTS_USER_MAX / MESSAGE_USER_MAX per window) allow. Unsetting it puts every app back on 1.5 s.
 *
 * Not here yet: the global ceiling across lanes that the audit's design E asks for. Add a number for it
 * before `lanes` mode is switched on. `unpaced` is the contract that Stop and the stream subscribe never
 * wait behind anything. */

function whole(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clientConfig(env = process.env) {
  const ttsPerMinute = Math.max(
    1,
    Math.floor(whole(env.TTS_USER_MAX, 200) / whole(env.TTS_USER_WINDOW, 1)),
  );
  const messagesPerMinute = Math.max(
    1,
    Math.floor(whole(env.MESSAGE_USER_MAX, 40) / whole(env.MESSAGE_USER_WINDOW, 1)),
  );
  const lanesOn = env.KADE_CLIENT_PACING === 'lanes';
  /* The smallest gap that stays inside the limiter. With the defaults: 300 ms for speech, 1500 ms for messages. */
  const floorFor = (perMinute) => Math.ceil(60000 / perMinute);
  const lanes = lanesOn
    ? {
        message: { minGapMs: Math.max(1500, floorFor(messagesPerMinute)) },
        auth: { minGapMs: 1500 },
        speech: { minGapMs: Math.max(350, floorFor(ttsPerMinute)) },
        bulk: { minGapMs: 1100 },
        standard: { minGapMs: 500 },
      }
    : {
        message: { minGapMs: 1500 },
        auth: { minGapMs: 1500 },
        speech: { minGapMs: 1500 },
        bulk: { minGapMs: 1500 },
        standard: { minGapMs: 1500 },
      };
  return {
    version: 1,
    pacing: {
      mode: lanesOn ? 'lanes' : 'legacy',
      lanes,
      unpaced: ['/api/agents/chat/stream/', '/api/agents/chat/abort'],
    },
    limits: { ttsPerMinute, messagesPerMinute },
  };
}

function clientConfigHandler(req, res) {
  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.json(clientConfig(process.env));
}

module.exports = { clientConfig, clientConfigHandler };
