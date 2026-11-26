const bcrypt = require('bcryptjs');
const { logger } = require('@librechat/data-schemas');
const { errorsToString } = require('librechat-data-provider');
const { Strategy: PassportLocalStrategy } = require('passport-local');
const { isEnabled, checkEmailConfig, comparePassword } = require('@librechat/api');
const { findUser, updateUser } = require('~/models');
const { classifyLoginId } = require('~/server/utils/kadeLoginId');
const { loginSchema } = require('./validators');

// Unix timestamp for 2024-06-07 15:20:18 Eastern Time
const verificationEnabledTimestamp = 1717788018;

/* Nov 26 2026 (Part 460): an unknown account and a wrong password now look
 * the same from outside: the same status (404, which the iPhone and Android
 * apps already read as "wrong email or password"), the same words, and about
 * the same wait. Before, "Email does not exist." told anyone which addresses
 * have accounts here, and a missing account answered faster because no
 * password was checked. Now a missing account still runs one bcrypt check
 * against a stand-in hash of the same cost (10) that real passwords use.
 * The words still follow what was typed (a phone or an email), never whether
 * an account was found. */
const DUMMY_HASH_COST = 10;
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = bcrypt.hash(`no-account-${Math.random()}`, DUMMY_HASH_COST);
  }
  return dummyHashPromise;
}

function loginFailedMessage(kind) {
  return kind === 'phone'
    ? 'That phone number and password do not match an account.'
    : 'That email and password do not match an account.';
}

/** Spends about as long as a real password check, then reports no match. */
async function compareAgainstNothing(password) {
  try {
    await bcrypt.compare(String(password ?? ''), await dummyHash());
  } catch (_) {
    /* the time is what matters here, not the answer */
  }
  return false;
}

async function validateLoginRequest(req) {
  const { error } = loginSchema.safeParse(req.body);
  return error ? errorsToString(error.errors) : null;
}

async function passportLogin(req, email, password, done) {
  try {
    const validationError = await validateLoginRequest(req);
    if (validationError) {
      logError('Passport Local Strategy - Validation Error', { email: req.body?.email });
      logger.error(`[Login] [Login failed] [Username: ${email}] [Request-IP: ${req.ip}]`);
      return done(null, false, { message: validationError });
    }

    /* Part 143 (Sep 8 2026): the one login box takes an email address or a
     * phone number. A phone is matched against `kadePhone`, which the front
     * door and registration both store as ten bare digits, so 417-771-9958,
     * (417) 771 9958 and 14177719958 are the same person. The failure
     * message stops saying "email" at people who typed a phone. */
    const id = classifyLoginId(email);
    const user =
      id.kind === 'phone'
        ? await findUser({ kadePhone: id.phone }, '+password')
        : await findUser({ email: String(email).trim() }, '+password');
    const failed = loginFailedMessage(id.kind);
    if (!user) {
      await compareAgainstNothing(password);
      logError('Passport Local Strategy - User Not Found', { email });
      logger.error(`[Login] [Login failed] [Username: ${email}] [Request-IP: ${req.ip}]`);
      return done(null, false, { message: failed });
    }

    if (!user.password) {
      await compareAgainstNothing(password);
      logError('Passport Local Strategy - User has no password', { email });
      logger.error(`[Login] [Login failed] [Username: ${email}] [Request-IP: ${req.ip}]`);
      return done(null, false, { message: failed });
    }

    const isMatch = await comparePassword(user, password, { compare: bcrypt.compare });
    if (!isMatch) {
      logError('Passport Local Strategy - Password does not match', { isMatch });
      logger.error(`[Login] [Login failed] [Username: ${email}] [Request-IP: ${req.ip}]`);
      return done(null, false, { message: failed });
    }

    const emailEnabled = checkEmailConfig();
    const userCreatedAtTimestamp = Math.floor(new Date(user.createdAt).getTime() / 1000);

    if (
      !emailEnabled &&
      !user.emailVerified &&
      userCreatedAtTimestamp < verificationEnabledTimestamp
    ) {
      await updateUser(user._id, { emailVerified: true });
      user.emailVerified = true;
    }

    const unverifiedAllowed = isEnabled(process.env.ALLOW_UNVERIFIED_EMAIL_LOGIN);
    if (user.expiresAt && unverifiedAllowed) {
      await updateUser(user._id, {});
    }

    if (!user.emailVerified && !unverifiedAllowed) {
      logError('Passport Local Strategy - Email not verified', { email });
      logger.error(`[Login] [Login failed] [Username: ${email}] [Request-IP: ${req.ip}]`);
      return done(null, user, { message: 'Email not verified.' });
    }

    logger.info(`[Login] [Login successful] [Username: ${email}] [Request-IP: ${req.ip}]`);
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}

function logError(title, parameters) {
  const entries = Object.entries(parameters).map(([name, value]) => ({ name, value }));
  logger.error(title, { parameters: entries });
}

const createLocalStrategy = () => {
  // Made once at startup, so even the first failed sign-in takes the usual time.
  dummyHash().catch(() => {
    dummyHashPromise = null;
  });
  return new PassportLocalStrategy(
    {
      usernameField: 'email',
      passwordField: 'password',
      session: false,
      passReqToCallback: true,
    },
    passportLogin,
  );
};

module.exports = createLocalStrategy;
module.exports.loginFailedMessage = loginFailedMessage;
module.exports.dummyHash = dummyHash;
