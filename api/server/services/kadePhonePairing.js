'use strict';
/**
 * KADE PHONE PAIRING (Nov 11 2026, home agent card 2).
 *
 * A phone call knows the caller only by caller ID. Pairing lets a person say, from the signed-in
 * app, that a phone number is theirs, so later cards can let that number hear their own
 * reminders, lists and calendar (the safety lane decides what a paired phone may do; this file
 * only answers "is this number paired, and to whom").
 *
 *   1. In the signed-in app (typing, the website, or signed-in app voice: services/kadeVoiceLane.js)
 *      the person asks any character to "pair my phone". code makes a 6-digit one-time code. It is
 *      said and shown once: only a keyed hash is stored, so it can never be read back. It works
 *      for one hour. A new code ends the person's older one.
 *   2. On a phone call, from the phone to pair, the caller says "my pairing code is ...". redeem
 *      takes the number the bridge got from Twilio (signed pass, kadeVoiceLane callerNumberOf),
 *      never a number from anyone's words, and pairs it to the account that made the code.
 *   3. Wrong codes (review fix, Nov 11 2026): a calling number that says 5 wrong codes in an hour
 *      is locked out of pairing for that hour, so one guesser gets 5 tries at one in a million
 *      each. Every wrong code also counts against every live code (a guess could be aimed at any
 *      of them), and at 20 wrong tries platform-wide the live codes lock, so many numbers cannot
 *      share the guessing either. One prank caller can no longer lock everyone's codes. One
 *      redeem per turn, so a list of codes in one breath counts as one try.
 *   4. From the app, "unpair my phone" removes a number; list says which numbers are paired, by
 *      their last four digits.
 *
 * A number already paired to another account is refused (that account unpairs it first), so a
 * faked caller ID cannot take a number away from its owner. Up to 5 numbers per account.
 *
 * Stored: kadephonepaircodes {userId, codeHash, createdAt, expiresAt, wrong, usedAt?, lockedAt?}
 * (removed a day after expiry), and kadepairedphones {_id: numberHash, userId, last4, pairedAt}.
 * Numbers and codes are keyed hashes (HMAC-SHA256) under a key derived from CREDS_KEY, the
 * server's existing encryption key. With no CREDS_KEY, or the public example value, pairing is
 * unavailable rather than weak. The full number is never stored or logged.
 *
 * For the safety lane: isPairedPhone(callerNumber) -> accountId | null.
 *
 * Off switch: KADE_PHONE_PAIRING=0 (the tool is not offered and refuses; isPairedPhone says null).
 * No '~' requires at load time, so node --test loads it.
 */
const crypto = require('crypto');
const lane = require('./kadeVoiceLane');

const CODES = 'kadephonepaircodes';
const PHONES = 'kadepairedphones';
const CODE_MINUTES = 60;
const MAX_WRONG = 5;
const LOCK_ALL_AFTER = 20;
/* Wrong tries by calling number (keyed hash), in this process: { n, since }. */
const WRONG_BY_NUMBER = new Map();
const MAX_PHONES = 5;
/* The example CREDS_KEY published with LibreChat (packages/api/src/app/checks.ts). Not a secret. */
const PUBLIC_EXAMPLE_KEY = 'f34be427ebb29de8d88c107a71546019685ed8b241d8f2ed00c3df97ad2566f0';

function on(env = process.env) {
  return String((env && env.KADE_PHONE_PAIRING) ?? '') !== '0';
}

/** The pairing key, or null when the server has no real CREDS_KEY. */
function keyOf(env = process.env) {
  const k = String((env && env.CREDS_KEY) || '').trim();
  if (!k || k.toLowerCase() === PUBLIC_EXAMPLE_KEY) return null;
  return crypto.createHmac('sha256', k).update('kade-phone-pairing.v1').digest();
}
function hashOf(key, kind, value) {
  return crypto.createHmac('sha256', key).update(`${kind}:${value}`).digest('hex');
}

/** '+15550100123' for a US number written any usual way, or any +E.164 number; else null. */
function normalizeNumber(v) {
  const raw = String(v || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

const WORD_DIGITS = { zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
/** The digits in what was said: "4 1 7 2 0 9", "417-209", or "four one seven two oh nine". */
function digitsOf(said) {
  let out = '';
  for (const tok of String(said || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (/^\d+$/.test(tok)) out += tok;
    else if (Object.prototype.hasOwnProperty.call(WORD_DIGITS, tok)) out += WORD_DIGITS[tok];
  }
  return out;
}

function spoken(code) {
  return String(code).split('').join(' ');
}

/* ------------------------------------------------------------------ storage */

let indexed = false;
function cols(deps) {
  if (deps && deps.codes && deps.phones) return { codes: deps.codes, phones: deps.phones };
  const conn = require('mongoose').connection;
  const codes = conn.collection(CODES);
  const phones = conn.collection(PHONES);
  if (!indexed) {
    indexed = true;
    Promise.resolve()
      .then(() =>
        Promise.all([
          codes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 }),
          codes.createIndex({ codeHash: 1 }),
          codes.createIndex({ userId: 1 }),
          phones.createIndex({ userId: 1 }),
        ]),
      )
      .catch(() => {});
  }
  return { codes, phones };
}
function envOf(deps) {
  return (deps && deps.env) || process.env;
}
function nowOf(deps) {
  return deps && typeof deps.now === 'function' ? deps.now() : Date.now();
}
/* Review fix: the number to call, said plainly. KADE_PHONE_LINE is a setting (the call-in number as
 * it should be spoken); without it the character names the line without a number. */
function lineOf(env) {
  const n = String((env && env.KADE_PHONE_LINE) || '').trim().slice(0, 40);
  return n ? `the Kade-AI phone line, ${n},` : 'the Kade-AI phone line (the number they call to talk with characters)';
}
function liveFilter(now) {
  return { usedAt: { $exists: false }, lockedAt: { $exists: false }, expiresAt: { $gt: new Date(now) } };
}
async function endingsOf(phones, userId) {
  const rows = await phones.find({ userId: String(userId) }).toArray();
  return rows
    .sort((a, b) => new Date(a.pairedAt).getTime() - new Date(b.pairedAt).getTime())
    .map((r) => String(r.last4 || ''));
}
function sayEndings(endings) {
  if (!endings.length) return 'No phone numbers are paired with their account.';
  const list = endings.map((e) => `a phone ending in ${spoken(e)}`);
  return `Paired with their account: ${list.join(', ')}.`;
}

/* ------------------------------------------------------------ who is asking */

/**
 * The signed-in person this turn is for, or why not. Pairing, listing and unpairing happen only
 * in the signed-in app: typing, or verified signed-in app voice. Never on a phone call.
 */
function signedInPerson(req) {
  if (!req || !req.user || !req.user.id) return { ok: false, error: 'this is not available here' };
  if (req.kadeHiddenRun === true) return { ok: false, error: 'a background job cannot do this' };
  const where = lane.laneOf(req);
  if (where === 'app-voice') return { ok: true, userId: String(req.kadeOnBehalfOf.id) };
  if (where === 'text') return { ok: true, userId: String(req.user.id) };
  return {
    ok: false,
    error:
      'on a phone call this can only take a pairing code. Making a code, hearing paired numbers and unpairing happen in the app, typed or by voice there',
  };
}

/* ----------------------------------------------------------------- actions */

const OFF = { ok: false, error: 'phone pairing is switched off right now' };
const NO_KEY = { ok: false, error: 'phone pairing is not set up on this server yet' };

/** Make a new one-time code for the signed-in person. Their older code stops working. */
async function makeCode({ req }, deps) {
  const env = envOf(deps);
  if (!on(env)) return OFF;
  const who = signedInPerson(req);
  if (!who.ok) return who;
  const key = keyOf(env);
  if (!key) return NO_KEY;
  const { codes, phones } = cols(deps);
  const now = nowOf(deps);
  await codes.updateMany(
    { userId: who.userId, ...liveFilter(now) },
    { $set: { lockedAt: new Date(now), lockedWhy: 'replaced' } },
  );
  const rand = (deps && deps.random) || (() => crypto.randomInt(0, 1000000));
  let code = null;
  let codeHash = null;
  for (let i = 0; i < 8 && !code; i++) {
    const c = String(rand()).padStart(6, '0').slice(-6);
    const h = hashOf(key, 'code', c);
    if (!(await codes.findOne({ codeHash: h, ...liveFilter(now) }))) {
      code = c;
      codeHash = h;
    }
  }
  if (!code) return { ok: false, error: 'a code could not be made just now. Ask them to try again in a minute' };
  await codes.insertOne({
    userId: who.userId,
    codeHash,
    createdAt: new Date(now),
    expiresAt: new Date(now + CODE_MINUTES * 60000),
    wrong: 0,
  });
  const endings = await endingsOf(phones, who.userId);
  return {
    ok: true,
    code,
    minutes: CODE_MINUTES,
    paired: endings,
    tellThem:
      `Their pairing code is ${spoken(code)}. Say it now, digit by digit, slowly, and again if they ask. ` +
      `It works once, for one hour. Tell them: call ${lineOf(env)} from the phone they want to pair, and say "my pairing code is" and the six digits. ` +
      'It cannot be looked up later: if they lose it, they ask for a new one. Do not bring it up again on your own. ' +
      sayEndings(endings),
  };
}

/** On a phone call: pair the caller's number with the account that made this code. */
async function redeem({ req, code }, deps) {
  const env = envOf(deps);
  if (!on(env)) return OFF;
  if (!req || !req.user) return { ok: false, error: 'this is not available here' };
  if (req.kadeHiddenRun === true) return { ok: false, error: 'a background job cannot do this' };
  const where = lane.laneOf(req);
  if (where !== 'phone') {
    return {
      ok: false,
      error: 'a pairing code is said on a phone call, from the phone they want to pair. Here they are already signed in',
    };
  }
  const number = normalizeNumber(lane.callerNumberOf(req));
  if (!number) {
    return {
      ok: false,
      error: 'the number this call comes from cannot be seen, so it cannot be paired. Ask them to call in from that phone',
    };
  }
  const key = keyOf(env);
  if (!key) return NO_KEY;
  const digits = digitsOf(code);
  if (digits.length !== 6) return { ok: false, error: 'a pairing code has six digits. Ask them to say all six, one at a time' };
  /* One try per turn: several codes said in one breath are not several tries. */
  if (!(deps && deps.skipTurnCheck) && !require('./kadeSpendGate').claimOnce(req, 'kade-phone-pairing-redeem')) {
    return { ok: false, error: 'one pairing code per message. Ask them to say just the one code from the app' };
  }
  const { codes, phones } = cols(deps);
  const now = nowOf(deps);
  const wrongs = (deps && deps.wrongs) || WRONG_BY_NUMBER;
  const numberKey = hashOf(key, 'num', number);
  const mine = wrongs.get(numberKey);
  if (mine && now - mine.since > CODE_MINUTES * 60000) wrongs.delete(numberKey);
  const tries = wrongs.get(numberKey);
  if (tries && tries.n >= MAX_WRONG) {
    return { ok: false, error: 'too many wrong codes from this phone. Ask them to wait an hour, then ask for a new code in the app' };
  }
  const row = await codes.findOne({ codeHash: hashOf(key, 'code', digits), ...liveFilter(now) });
  if (!row) {
    wrongs.set(numberKey, { n: ((tries && tries.n) || 0) + 1, since: (tries && tries.since) || now });
    if (wrongs.size > 5000) wrongs.delete(wrongs.keys().next().value);
    /* A wrong guess could be aimed at any live code, so it counts against all of them. */
    await codes.updateMany(liveFilter(now), { $inc: { wrong: 1 } });
    await codes.updateMany({ ...liveFilter(now), wrong: { $gte: LOCK_ALL_AFTER } }, { $set: { lockedAt: new Date(now), lockedWhy: 'wrong' } });
    return {
      ok: false,
      error:
        'that code did not match a live pairing code. Codes last one hour and stop after a few wrong tries. Ask them to check it, or to ask for a new one in the app',
    };
  }
  const numberHash = hashOf(key, 'num', number);
  const last4 = number.slice(-4);
  const held = await phones.findOne({ _id: numberHash });
  if (held && String(held.userId) !== String(row.userId)) {
    return {
      ok: false,
      error: 'this phone number is already paired with another account. That account has to unpair it in the app first',
    };
  }
  if (!held && (await phones.countDocuments({ userId: String(row.userId) })) >= MAX_PHONES) {
    return { ok: false, error: `that account already has ${MAX_PHONES} paired phones. They can unpair one in the app first` };
  }
  const claimed = await codes.findOneAndUpdate(
    { _id: row._id, ...liveFilter(now) },
    { $set: { usedAt: new Date(now) } },
    { returnDocument: 'after' },
  );
  if (!claimed) return { ok: false, error: 'that code was just used or has closed. Ask them for a new one in the app' };
  try {
    await phones.findOneAndUpdate(
      { _id: numberHash, userId: String(row.userId) },
      { $set: { last4, pairedAt: new Date(now) } },
      { upsert: true, returnDocument: 'after' },
    );
  } catch (e) {
    if (e && e.code === 11000) {
      return { ok: false, error: 'this phone number is already paired with another account. That account has to unpair it in the app first' };
    }
    throw e;
  }
  return {
    ok: true,
    ending: last4,
    tellThem: `Done: this phone, ending in ${spoken(last4)}, is now paired with the account that made the code. They can unpair it any time in the app.`,
  };
}

/** The signed-in person's paired numbers, by last four digits. */
async function list({ req }, deps) {
  const env = envOf(deps);
  if (!on(env)) return OFF;
  const who = signedInPerson(req);
  if (!who.ok) return who;
  const { phones } = cols(deps);
  const endings = await endingsOf(phones, who.userId);
  return { ok: true, paired: endings, tellThem: sayEndings(endings) };
}

/** Remove one paired number (by its last four digits), or all with ending 'all'. */
async function unpair({ req, ending }, deps) {
  const env = envOf(deps);
  if (!on(env)) return OFF;
  const who = signedInPerson(req);
  if (!who.ok) return who;
  const { phones } = cols(deps);
  const rows = await phones.find({ userId: who.userId }).toArray();
  if (!rows.length) return { ok: true, removed: [], tellThem: 'No phone numbers are paired with their account, so there is nothing to unpair.' };
  const want = String(ending || '').trim().toLowerCase();
  let pick;
  if (want === 'all') pick = rows;
  else if (digitsOf(want).length === 4) pick = rows.filter((r) => String(r.last4) === digitsOf(want));
  else if (rows.length === 1) pick = rows;
  else {
    return {
      ok: false,
      error: `more than one phone is paired. ${sayEndings(rows.map((r) => String(r.last4)))} Ask which one, by its last four digits, or all`,
    };
  }
  if (!pick.length) return { ok: false, error: `no paired phone ends in ${spoken(digitsOf(want))}. ${sayEndings(rows.map((r) => String(r.last4)))}` };
  for (const r of pick) await phones.deleteOne({ _id: r._id, userId: who.userId });
  const left = await endingsOf(phones, who.userId);
  return {
    ok: true,
    removed: pick.map((r) => String(r.last4)),
    tellThem: `Unpaired: ${pick.map((r) => `the phone ending in ${spoken(r.last4)}`).join(', ')}. ${sayEndings(left)}`,
  };
}

/**
 * For the safety lane (laneTrust): the account a phone number is paired with, or null.
 * Pass the bridge-verified caller number (kadeVoiceLane.callerNumberOf(req)), never a number
 * taken from anyone's words. Never throws.
 * @param {string} callerNumber
 * @returns {Promise<string|null>}
 */
async function isPairedPhone(callerNumber, deps) {
  try {
    const env = envOf(deps);
    if (!on(env)) return null;
    const key = keyOf(env);
    const number = normalizeNumber(callerNumber);
    if (!key || !number) return null;
    const { phones } = cols(deps);
    const row = await phones.findOne({ _id: hashOf(key, 'num', number) });
    return row && row.userId ? String(row.userId) : null;
  } catch (_) {
    return null;
  }
}

/** Account delete (review fix): paired numbers and codes go with the account. */
async function clearFor(userId, deps) {
  if (!userId) return;
  const { codes, phones } = cols(deps);
  await phones.deleteMany({ userId: String(userId) });
  await codes.deleteMany({ userId: String(userId) });
}

module.exports = {
  CODES,
  PHONES,
  MAX_WRONG,
  LOCK_ALL_AFTER,
  clearFor,
  MAX_PHONES,
  CODE_MINUTES,
  on,
  keyOf,
  normalizeNumber,
  digitsOf,
  makeCode,
  redeem,
  list,
  unpair,
  isPairedPhone,
};
