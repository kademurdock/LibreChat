/**
 * Oct 28 2026 (Kade: "we kinda need a vision and non vision flag because
 * of the gaming emulator on the platform anyway. Like, an account thing").
 * One row per account: whether this person uses the screen, and whether
 * they want the paid live video faces. Blind accounts never open a paid
 * face session; nothing else on the platform changes for them.
 *
 *   sight: 'sighted' | 'nonvisual' | null (never said)
 *   liveFaces: true by default; a sighted person can turn the video off.
 */
const mongoose = require('mongoose');

const SIGHT_VALUES = ['sighted', 'nonvisual'];

const kadeSightSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    sight: { type: String, enum: SIGHT_VALUES, default: null },
    liveFaces: { type: Boolean, default: true },
    setBy: { type: String, default: 'user', maxlength: 40 },
  },
  { timestamps: true },
);

const KadeSight = mongoose.models.KadeSight || mongoose.model('KadeSight', kadeSightSchema);

function plain(row) {
  return {
    sight: row && SIGHT_VALUES.includes(row.sight) ? row.sight : null,
    liveFaces: row ? row.liveFaces !== false : true,
  };
}

async function getSight(userId) {
  const row = await KadeSight.findOne({ userId: String(userId) }).lean();
  return plain(row);
}

/* Fields left out of `patch` keep their value; `sight: null` clears it. */
async function setSight(userId, patch, setBy = 'user') {
  const $set = { setBy: String(setBy).slice(0, 40) };
  if ('sight' in patch) {
    const v = patch.sight;
    if (v !== null && !SIGHT_VALUES.includes(v)) {
      throw new Error("sight must be 'sighted', 'nonvisual' or null");
    }
    $set.sight = v;
  }
  if ('liveFaces' in patch) {
    $set.liveFaces = patch.liveFaces !== false;
  }
  const row = await KadeSight.findOneAndUpdate(
    { userId: String(userId) },
    { $set, $setOnInsert: { userId: String(userId) } },
    { upsert: true, new: true },
  ).lean();
  return plain(row);
}

/**
 * Oct 29 2026: several accounts at once, for Kade's access-requests page.
 * Returns a Map userId -> 'sighted' | 'nonvisual' | null.
 */
async function getSights(userIds) {
  const ids = [...new Set((userIds || []).map(String))];
  const out = new Map(ids.map((id) => [id, null]));
  if (!ids.length) {
    return out;
  }
  const rows = await KadeSight.find({ userId: { $in: ids } }, 'userId sight').lean();
  for (const row of rows) {
    out.set(String(row.userId), plain(row).sight);
  }
  return out;
}

/**
 * Oct 29 2026: what someone picked when asking for an account. The sign-up
 * forms send 'sighted', 'nonvisual', or 'unsaid' ("I'd rather not say").
 * Returns the value to store ('sighted' | 'nonvisual' | null), or undefined
 * when nothing usable was sent at all, so callers can tell "they said rather
 * not" from "the form never asked".
 */
function parseSightChoice(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const v = String(value).trim().toLowerCase();
  if (SIGHT_VALUES.includes(v)) {
    return v;
  }
  if (v === '' || v === 'unsaid' || v === 'none' || v === 'null') {
    return null;
  }
  return undefined;
}

module.exports = {
  KadeSight,
  SIGHT_VALUES,
  getSight,
  getSights,
  setSight,
  plain,
  parseSightChoice,
};
