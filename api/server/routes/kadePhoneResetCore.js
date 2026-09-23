/* The rules of password reset by phone call, with every outside dependency
 * passed in, so kadePhoneReset.selftest.js runs them with no Mongo, no bcrypt
 * install and no phone. The wiring (Mongo store, bridge call, routes) and the
 * full description are in kadePhoneReset.js. */
const crypto = require('crypto');
const { normalizePhone, placeholderEmailForPhone } = require('../utils/kadeLoginId');

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_TRIES = 5;
const PER_NUMBER_GAP_MS = 2 * 60 * 1000;
const PER_NUMBER_DAILY = 3;
const PLATFORM_DAILY = 40;
const PER_IP_HOURLY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const START_MESSAGE =
  "If that number has a Kade-AI account, it's ringing now. Answer and listen for a six-digit code, then type it below. " +
  'No call within a minute? Check the number, wait two minutes and try again, or ask Kade.';
const DONE_MESSAGE = 'Your password is changed. Sign in with your phone number and the new password.';
const EXPIRED_MESSAGE = 'That code has expired or was already used. Ask for a new call.';
const BAD_NUMBER = 'Enter the 10-digit phone number you sign in with.';

const masked = (digits) => `...${String(digits).slice(-2)}`;

function createPhoneReset({
  findUser,
  updateUser,
  deleteAllUserSessions,
  store,
  callCode,
  hash,
  compare,
  logger,
  now = () => Date.now(),
  randomCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0'),
}) {
  const ipHits = new Map();

  function ipAllowed(ip) {
    const cutoff = now() - 60 * 60 * 1000;
    const hits = (ipHits.get(ip) || []).filter((t) => t > cutoff);
    const allowed = hits.length < PER_IP_HOURLY;
    if (allowed) {
      hits.push(now());
    }
    ipHits.set(ip, hits);
    return allowed;
  }

  /** Always the same answer for a well-formed number, so the form reveals nobody's account. */
  async function start({ phone, ip }) {
    const digits = normalizePhone(phone);
    if (!digits) {
      return { status: 400, body: { message: BAD_NUMBER } };
    }
    if (!ipAllowed(String(ip || 'unknown'))) {
      return { status: 429, body: { message: 'Too many tries from here. Wait an hour, or ask Kade.' } };
    }
    const generic = { status: 200, body: { ok: true, message: START_MESSAGE } };
    const user = await findUser({ email: placeholderEmailForPhone(digits) }, '_id email');
    if (!user) {
      // Spend the same hashing time a real request does, so response time does not
      // reveal whether the number has an account.
      hash(randomCode());
      return generic;
    }
    const since = now() - DAY_MS;
    const [recent, platform] = await Promise.all([store.recent(digits, since), store.countAll(since)]);
    if (recent.length >= PER_NUMBER_DAILY || recent.some((r) => now() - r.createdAt < PER_NUMBER_GAP_MS)) {
      logger.info(`[phone-reset] call to ${masked(digits)} skipped: per-number limit`);
      return generic;
    }
    if (platform >= PLATFORM_DAILY) {
      logger.warn('[phone-reset] platform daily call limit reached');
      return generic;
    }
    const code = randomCode();
    await store.create({
      phone: digits,
      userId: user._id,
      codeHash: hash(code),
      expiresAt: now() + CODE_TTL_MS,
      attempts: 0,
      used: false,
      createdAt: now(),
    });
    // Not awaited: waiting on the phone call would make a real account answer
    // seconds slower than an unknown number.
    Promise.resolve()
      .then(() => callCode(`+1${digits}`, code))
      .then(
        () => logger.info(`[phone-reset] code call placed to ${masked(digits)} for user ${user._id}`),
        (error) => logger.error(`[phone-reset] code call to ${masked(digits)} failed: ${error && error.message}`),
      );
    return generic;
  }

  async function finish({ phone, code, password }) {
    const digits = normalizePhone(phone);
    const typed = String(code || '').replace(/\D/g, '');
    const pass = String(password || '');
    if (!digits) {
      return { status: 400, body: { message: BAD_NUMBER } };
    }
    if (typed.length !== 6) {
      return { status: 400, body: { message: 'The code is six digits. Type all six.' } };
    }
    if (pass.length < 8 || pass.length > 128) {
      return { status: 400, body: { message: 'Choose a password of 8 to 128 characters.' } };
    }
    const entry = await store.latestActive(digits, now());
    if (!entry || entry.attempts >= MAX_TRIES) {
      return { status: 400, body: { message: EXPIRED_MESSAGE } };
    }
    if (!compare(typed, entry.codeHash)) {
      const attempts = await store.addAttempt(entry._id);
      const left = MAX_TRIES - attempts;
      if (left <= 0) {
        await store.useAll(digits);
        return {
          status: 400,
          body: { message: "That code doesn't match, and it has now been cancelled. Ask for a new call." },
        };
      }
      return { status: 400, body: { message: `That code doesn't match. ${left} ${left === 1 ? 'try' : 'tries'} left.` } };
    }
    // Spend the code first, so a second request racing this one cannot use it too.
    await store.useAll(digits);
    await updateUser(entry.userId, { password: hash(pass) });
    try {
      await deleteAllUserSessions({ userId: entry.userId });
    } catch (error) {
      logger.error('[phone-reset] session clear failed:', error);
    }
    logger.info(`[phone-reset] password reset by phone call for user ${entry.userId}`);
    return { status: 200, body: { ok: true, message: DONE_MESSAGE } };
  }

  return { start, finish };
}

module.exports = {
  createPhoneReset,
  CODE_TTL_MS,
  MAX_TRIES,
  PER_NUMBER_GAP_MS,
  PER_NUMBER_DAILY,
  PLATFORM_DAILY,
  PER_IP_HOURLY,
  START_MESSAGE,
};
