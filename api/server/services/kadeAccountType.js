'use strict';
/**
 * KADE ACCOUNT TYPES (Nov 11 2026, home agent plan card 5).
 *
 * An account is typed 'adult', 'teen' or 'child' (user.kadeAccountType). Only Kade sets it
 * (POST /api/kade/account-type, admin only). Many accounts have no type stored yet.
 *
 *   isChildLike(user)      true for 'child' and 'teen'. Every place that used to check for a
 *                          stored 'child' asks this instead, so a teen gets the
 *                          child rules. An account with no type is NOT child-like: untyped
 *                          accounts keep exactly what they have today until Kade types them.
 *   isExplicitAdult(user)  true ONLY when the stored type is exactly 'adult'. No role, no
 *                          default and no missing field counts. For errand tools, connections
 *                          and standing yeses that are not built yet; nothing calls it today.
 *
 * A safety gate: no off switch. No '~' requires, so node --test loads it.
 */

const ACCOUNT_TYPES = Object.freeze(['adult', 'teen', 'child']);

/** The stored type, or null when none is recorded (or the value is not one of ours). */
function accountTypeOf(user) {
  const t = user && typeof user === 'object' ? user.kadeAccountType : undefined;
  return typeof t === 'string' && ACCOUNT_TYPES.includes(t) ? t : null;
}

function isChild(user) {
  return accountTypeOf(user) === 'child';
}

function isTeen(user) {
  return accountTypeOf(user) === 'teen';
}

/** A child or a teen: the child rules apply. Untyped is not child-like. */
function isChildLike(user) {
  const t = accountTypeOf(user);
  return t === 'child' || t === 'teen';
}

/** Only an account Kade typed 'adult'. Admin role alone is not enough; untyped is never adult. */
function isExplicitAdult(user) {
  return accountTypeOf(user) === 'adult';
}

module.exports = { ACCOUNT_TYPES, accountTypeOf, isChild, isTeen, isChildLike, isExplicitAdult };
