/**
 * KADE LOGIN IDENTIFIERS (Part 143, Sep 8 2026) — an account you can reach
 * with whatever you actually have.
 *
 * Kade, the same evening the door learned to make accounts: "you should make
 * it accept a phone as login too. Not everyone has both, one, or the other.
 * It's not like we are texting or emailing them."
 *
 * She is right about the reason, and the reason is the design: this platform
 * never mails anybody and never texts anybody. An email address here is not a
 * channel, it is a NAME — the string LibreChat happens to key accounts on. So
 * for someone who only has a phone number, the phone becomes the name they
 * sign in with, and the stored email is a placeholder under the reserved
 * `.invalid` TLD (RFC 2606) that says out loud it can never receive mail.
 *
 * Every lane that looks at a typed identifier — the login strategy, the login
 * validator, the front door's approval — asks THIS file what it is looking
 * at, so a phone means the same thing in all of them.
 */

/** Anything with an @ and a dot after it: the shape zod will accept. */
const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
/** Loose enough to find one inside a free-text "contact" line. */
const EMAIL_ANYWHERE_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PLACEHOLDER_DOMAIN = 'phone.kade-ai.invalid';

function looksLikeEmail(value) {
  return EMAIL_RE.test(String(value || '').trim());
}

function findEmail(value) {
  const m = String(value || '').match(EMAIL_ANYWHERE_RE);
  return m ? m[0].toLowerCase() : null;
}

/**
 * A US phone reduced to its ten digits, or null. Deliberately narrow: 10
 * digits, or 11 starting with a 1. Everything her family carries is one of
 * those two, and a looser rule would start reading years and zip codes as
 * phone numbers.
 * @returns {string|null}
 */
function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10) {
    return digits;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }
  return null;
}

/** Spoken back to people, never stored: 417-771-9958. */
function prettyPhone(digits) {
  const d = normalizePhone(digits);
  return d ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : String(digits || '');
}

/** The name a phone-only account is filed under. Never mailed, never shown. */
function placeholderEmailForPhone(digits) {
  const d = normalizePhone(digits);
  return d ? `p${d}@${PLACEHOLDER_DOMAIN}` : null;
}

function isPlaceholderEmail(email) {
  return String(email || '').toLowerCase().endsWith(`@${PLACEHOLDER_DOMAIN}`);
}

/**
 * What did somebody just type into the one login box?
 * @returns {{kind:'email',email:string}|{kind:'phone',phone:string}|{kind:'unknown'}}
 */
function classifyLoginId(value) {
  const raw = String(value || '').trim();
  if (looksLikeEmail(raw)) {
    return { kind: 'email', email: raw.toLowerCase() };
  }
  const phone = normalizePhone(raw);
  if (phone) {
    return { kind: 'phone', phone };
  }
  return { kind: 'unknown' };
}

module.exports = {
  EMAIL_RE,
  EMAIL_ANYWHERE_RE,
  PLACEHOLDER_DOMAIN,
  looksLikeEmail,
  findEmail,
  normalizePhone,
  prettyPhone,
  placeholderEmailForPhone,
  isPlaceholderEmail,
  classifyLoginId,
};
