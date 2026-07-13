const rateLimit = require('express-rate-limit');
const { ViolationTypes } = require('librechat-data-provider');
const { limiterCache, removePorts } = require('@librechat/api');
const logViolation = require('~/cache/logViolation');

const getEnvironmentVariables = () => {
  const TTS_IP_MAX = parseInt(process.env.TTS_IP_MAX) || 300;
  const TTS_IP_WINDOW = parseInt(process.env.TTS_IP_WINDOW) || 1;
  const TTS_USER_MAX = parseInt(process.env.TTS_USER_MAX) || 200;
  const TTS_USER_WINDOW = parseInt(process.env.TTS_USER_WINDOW) || 1;
  const TTS_VIOLATION_SCORE = process.env.TTS_VIOLATION_SCORE;

  const ttsIpWindowMs = TTS_IP_WINDOW * 60 * 1000;
  const ttsIpMax = TTS_IP_MAX;
  const ttsIpWindowInMinutes = ttsIpWindowMs / 60000;

  const ttsUserWindowMs = TTS_USER_WINDOW * 60 * 1000;
  const ttsUserMax = TTS_USER_MAX;
  const ttsUserWindowInMinutes = ttsUserWindowMs / 60000;

  return {
    ttsIpWindowMs,
    ttsIpMax,
    ttsIpWindowInMinutes,
    ttsUserWindowMs,
    ttsUserMax,
    ttsUserWindowInMinutes,
    ttsViolationScore: TTS_VIOLATION_SCORE,
  };
};

const createTTSHandler = (ip = true) => {
  const { ttsIpMax, ttsIpWindowInMinutes, ttsUserMax, ttsUserWindowInMinutes, ttsViolationScore } =
    getEnvironmentVariables();

  return async (req, res) => {
    const type = ViolationTypes.TTS_LIMIT;
    const errorMessage = {
      type,
      max: ip ? ttsIpMax : ttsUserMax,
      limiter: ip ? 'ip' : 'user',
      windowInMinutes: ip ? ttsIpWindowInMinutes : ttsUserWindowInMinutes,
    };

    /* KADE July 13 2026: voice-sampling must NEVER contribute to a BAN — Kade:
     * "don't harass my people about switching voices too fast." Hitting the TTS
     * rate limit now returns a gentle 429 ONLY (a brief "slow down"); it no
     * longer calls logViolation, so it can't accrue toward the 15-min ban.
     * The rate cap still protects against runaway synthesis cost. To restore
     * ban-scoring, set env TTS_VIOLATION_SCORE and re-enable the logViolation
     * line below. */
    void type; void errorMessage; void ttsViolationScore; // (kept for shape)
    res.status(429).json({ message: 'One moment — give the voices a second to catch up, then try again.' });
  };
};

const createTTSLimiters = () => {
  const { ttsIpWindowMs, ttsIpMax, ttsUserWindowMs, ttsUserMax } = getEnvironmentVariables();

  /* KADE July 13 2026: admin (Kade) is never TTS-rate-limited — she sampled her
   * own voices into a ban. */
  let SystemRoles;
  try { ({ SystemRoles } = require('librechat-data-provider')); } catch { SystemRoles = { ADMIN: 'ADMIN' }; }
  const skipAdmin = (req) => req.user?.role === SystemRoles.ADMIN;

  const ipLimiterOptions = {
    windowMs: ttsIpWindowMs,
    max: ttsIpMax,
    handler: createTTSHandler(),
    keyGenerator: removePorts,
    skip: skipAdmin,
    store: limiterCache('tts_ip_limiter'),
  };

  const userLimiterOptions = {
    windowMs: ttsUserWindowMs,
    max: ttsUserMax,
    handler: createTTSHandler(false),
    keyGenerator: function (req) {
      return req.user?.id;
    },
    skip: skipAdmin,
    store: limiterCache('tts_user_limiter'),
  };

  const ttsIpLimiter = rateLimit(ipLimiterOptions);
  const ttsUserLimiter = rateLimit(userLimiterOptions);

  return { ttsIpLimiter, ttsUserLimiter };
};

module.exports = createTTSLimiters;
