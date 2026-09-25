'use strict';
/**
 * Part 293 (Sep 25 2026) -- WHO A SONG IS FOR.
 *
 * Her words: "Chat gpt is the only model besides like Grok that will cuss in lyrics when I have it
 * write songs... Can we incorporate this into the song writing features in my app". The Sound
 * Booth desk never learned who was asking, so it could neither loosen up for a grown-up nor stay
 * clean for the child account or Apple's reviewer. This file answers that one question for the
 * desk (packages/api/src/music/writing.ts SONG_EXPLICIT_NOTE / SONG_CLEAN_NOTE), for Surprise me,
 * and for the Wall of Fame.
 *
 *   songAudience(user, { band })  -> 'explicit' | 'clean' | null
 *     null      KADE_SONG_EXPLICIT=0: the kill switch, the desk exactly as before (no note at all)
 *     'clean'   the App Review seat, the child account, the Kids choir style, an untyped account,
 *               and ANY failure to find out (fails closed, like kadeReadingRoom.js isChild)
 *     'explicit' an account typed adult, or the admin (isKadeAdult, below)
 *
 * No '~' requires at the top, so node --test loads this file.
 */
const { isReviewSeat } = require('../services/kadeFunding');

/** The same rule as isKadeAdult in api/server/services/Endpoints/agents/build.js (Part 214), copied
 *  because that file is not exported and loads the whole agent stack: an account explicitly typed
 *  'adult', or the admin. Never the child, and never an account with no type recorded. */
const isKadeAdult = (user) =>
  !!user && user.kadeAccountType !== 'child' && (user.kadeAccountType === 'adult' || user.role === 'ADMIN');

/** The Kids trained style (yue.ts yueStyles.kids; stored takes have also said kids_choir). */
const isKidsBand = (band) => /kid|child/i.test(String(band || ''));

async function loadStoredAccount(id) {
  const { getUserById } = require('~/models');
  return getUserById(id, 'kadeAccountType role');
}

/** The signed-in user, with the account type read from the database when the request's user does
 *  not carry one (the admin is known by role and needs no read). Throws when the read fails. */
async function withAccountType(user, loadUser) {
  if (!user || user.kadeAccountType || user.role === 'ADMIN') return user;
  const id = user.id || user._id;
  if (!id) return user;
  const stored = await loadUser(String(id));
  return { ...user, kadeAccountType: stored && stored.kadeAccountType, role: (stored && stored.role) || user.role };
}

async function songAudience(user, { band, env = process.env, loadUser = loadStoredAccount, reviewSeat = isReviewSeat } = {}) {
  if (env.KADE_SONG_EXPLICIT === '0') return null;
  try {
    if (!user) return 'clean';
    if (reviewSeat(user, env)) return 'clean';
    if (isKidsBand(band)) return 'clean';
    const account = await withAccountType(user, loadUser);
    if (account.kadeAccountType === 'child') return 'clean';
    return isKadeAdult(account) ? 'explicit' : 'clean';
  } catch (_) {
    return 'clean';
  }
}

/* ---------------------------------------------------------------------------------------------
 * The Wall of Fame (GET /api/kade/wall) returns every shared asset to every account. A grown-up's
 * explicit song shared there must not reach the child account or Apple's reviewer. A read-time
 * word check on what the wall shows and plays (title, description, prompt, the saved lyrics),
 * for those two viewers only; everyone else sees the wall exactly as before.
 * ------------------------------------------------------------------------------------------- */
const EXPLICIT_WORDS = [
  'fuck\\w*', 'motherfuck\\w*', 'f[*#@]+c?k\\w*',
  'shit\\w*', 'bullshit\\w*', 'sh[*#@]+t\\w*',
  'bitch\\w*', 'b[*#@]+tch\\w*',
  'ass', 'asses', 'asshole\\w*', 'dumbass\\w*', 'jackass\\w*', 'badass\\w*', 'smartass\\w*',
  'damn\\w*', 'goddamn\\w*', 'dammit',
  'cunt\\w*', 'cocks?', 'cocksucker\\w*', 'dicks?', 'dickhead\\w*', 'puss(?:y|ies)',
  'whores?', 'sluts?', 'slutty', 'bastards?', 'piss(?:ed|ing|es)?',
  'tits', 'titties', 'boobs', 'horny', 'sex', 'sexy', 'sexual\\w*',
  'blowjobs?', 'handjobs?', 'porn\\w*', 'dildos?', 'jizz',
  'nigg(?:a|er)s?', 'fag(?:got)?s?', 'retard(?:ed|s)?',
];
const EXPLICIT_RE = new RegExp(`(?:^|[^a-z0-9])(?:${EXPLICIT_WORDS.join('|')})(?![a-z0-9])`, 'i');

function hasExplicitWords(text) {
  return EXPLICIT_RE.test(String(text || ''));
}

/** Everything of an asset that the wall shows or a player reads out. */
function wallAssetText(doc) {
  const m = (doc && doc.metadata) || {};
  return [doc && doc.description, doc && doc.prompt, m.title, m.lyrics, m.lyricsClean, m.spoken]
    .filter((v) => typeof v === 'string' && v)
    .join('\n');
}

/** True for the viewers the wall filters: the App Review seat and the child account. A failed
 *  account read counts as the child (the quieter wall), like kadeReadingRoom.js isChild. */
async function wallViewerRestricted(user, { env = process.env, loadUser = loadStoredAccount, reviewSeat = isReviewSeat } = {}) {
  try {
    if (!user) return true;
    if (reviewSeat(user, env)) return true;
    const account = await withAccountType(user, loadUser);
    return account.kadeAccountType === 'child';
  } catch (_) {
    return true;
  }
}

/** The wall for this viewer. Restricted viewers lose every asset whose text carries an explicit
 *  word, and any asset that cannot be checked (fails closed). */
function filterWallAssets(docs, restricted) {
  if (!restricted) return docs;
  return docs.filter((doc) => {
    try {
      return !hasExplicitWords(wallAssetText(doc));
    } catch (_) {
      return false;
    }
  });
}

module.exports = {
  songAudience,
  isKadeAdult,
  isKidsBand,
  EXPLICIT_WORDS,
  hasExplicitWords,
  wallAssetText,
  wallViewerRestricted,
  filterWallAssets,
};
