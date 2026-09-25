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
 *     'clean'    the App Review seat, the child account, the Kids choir style, an untyped account,
 *                and ANY failure to find out (fails closed, like kadeReadingRoom.js isChild)
 *     'explicit' an account typed adult, or the admin (isKadeAdult, below)
 *     null       a grown-up while the kill switch KADE_SONG_EXPLICIT=0 is on: the explicit
 *                permission is withdrawn and no note is sent. The switch never touches 'clean',
 *                so pulling it can only make a song cleaner, never less protected.
 *
 * The wall asks the same question (wallViewerRestricted), so the desk and the wall never
 * disagree about an account.
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

/** The one rule, before any kill switch: 'explicit' only for a grown-up, 'clean' for everyone
 *  else and for every failure. */
async function decideAudience(user, { band, env, loadUser, reviewSeat }) {
  try {
    if (!user) return 'clean';
    if (reviewSeat(user, env)) return 'clean';
    if (isKidsBand(band)) return 'clean';
    const account = await withAccountType(user, loadUser);
    if (!account || account.kadeAccountType === 'child') return 'clean';
    return isKadeAdult(account) ? 'explicit' : 'clean';
  } catch (_) {
    return 'clean';
  }
}

async function songAudience(user, { band, env = process.env, loadUser = loadStoredAccount, reviewSeat = isReviewSeat } = {}) {
  const audience = await decideAudience(user, { band, env, loadUser, reviewSeat });
  return audience === 'explicit' && env && env.KADE_SONG_EXPLICIT === '0' ? null : audience;
}

/* ---------------------------------------------------------------------------------------------
 * The Wall of Fame (GET /api/kade/wall) returns every shared asset to every account. A grown-up's
 * explicit song shared there must not reach the child account or Apple's reviewer. A read-time
 * word check on what the wall shows and plays (title, description, prompt, every text the asset
 * keeps), for every viewer who is not a grown-up; grown-ups see the wall exactly as before.
 * ------------------------------------------------------------------------------------------- */

/** Whole words: each starts after a non-letter and ends before one. */
const EXPLICIT_WORDS = [
  'ass', 'asses', 'assed', 'ass(?:hat|wipe|face|clown|kisser|hole)s?',
  '(?:bad|big|dumb|fat|half|hard|jack|kick|lard|lazy|smart|wise)ass(?:es|ed)?',
  'damn\\w*', 'goddamn\\w*', 'dammit',
  'cocks?', 'cocksucker\\w*', 'dick(?:head|wad)s?', 'puss(?:y|ies)(?!\\s*(?:cats?|willows?)\\b)',
  'bastards?', 'piss(?:ed|ing|es)?',
  'tits', 'titt(?:y|ies)', 'boobs', 'horny(?!\\s+toads?\\b)', 'sex(?!\\s+pistols\\b)', 'sexy', 'sexual\\w*',
  'blowjobs?', 'handjobs?', 'porn\\w*', 'dildos?', 'jizz',
  /* Slurs stay whole words: "snigger" and "niggardly" contain one. */
  'nigg(?:a|er)s?', 'fag(?:got)?s?', 'retard(?:ed|s)?',
  'fck\\w*', 'fkn', 'f[*#@]+c?k\\w*', 'sh[*#@!]+t\\w*', 'b[*#@!]+tch\\w*',
];
const EXPLICIT_RE = new RegExp(`(?:^|[^a-z0-9])(?:${EXPLICIT_WORDS.join('|')})(?![a-z0-9])`, 'i');

/** Hard roots, anywhere inside a word: clusterfuck, dipshit, batshit, sonofabitch, whorehouse.
 *  The lookarounds spare the real words that contain one (shitake, Shittim wood, Scunthorpe). */
const EXPLICIT_ROOTS = ['fuck', 'shit(?!ake|tim|tah)', '(?<!s)cunt', 'bitch', 'whore', 'slut'];
const ROOTS_RE = new RegExp(`(?:${EXPLICIT_ROOTS.join('|')})`, 'i');

/** "dick" only in lower case or all capitals, so Moby Dick, Dick Clark and Dickens stay. */
const DICK_RE = /(?:^|[^A-Za-z0-9])(?:dick(?:s|less)?|DICK(?:S|LESS)?)(?![A-Za-z0-9])/;

/** Starred and symbol spellings (f***, s**t, a**hole, b***h, sh!t, a$$, motherf***er). A word with
 *  a * @ ! or $ in it is read as a pattern, each run of symbols standing for missing letters, and
 *  it counts when a word on this list fits the pattern. So a masked swear is caught however it is
 *  starred, while F# minor, Ke$ha, P!nk, A$AP, *NSYNC and "Wow!!" are left alone ('#' only counts
 *  inside the spelled-out patterns above, because keys are written F# and C#). */
const MASKABLE = [
  'fuck', 'fucks', 'fucked', 'fucker', 'fuckers', 'fucking', 'fuckin', 'motherfucker', 'motherfuckers', 'motherfucking',
  'shit', 'shits', 'shitty', 'shitting', 'shithead', 'bullshit', 'bitch', 'bitches', 'bitching', 'bitchy',
  'ass', 'asses', 'asshole', 'assholes', 'damn', 'damned', 'dammit', 'goddamn', 'goddamned',
  'cunt', 'cunts', 'cock', 'cocks', 'dick', 'dicks', 'dickhead', 'pussy', 'whore', 'whores', 'slut', 'sluts',
  'bastard', 'bastards', 'piss', 'pissed',
];
function hasMaskedWord(text) {
  for (const raw of text.toLowerCase().match(/[a-z*@!$#]+/g) || []) {
    const token = raw.replace(/!+$/, '');
    if (!/[*@!$]/.test(token) || !/[a-z]/.test(token)) continue;
    const parts = token.match(/[a-z]+|[^a-z]+/g);
    const source = parts
      .map((part, i) => (/[a-z]/.test(part) ? part : i > 0 && i < parts.length - 1 ? `[a-z]{1,${part.length + 1}}` : `[a-z]{${part.length}}`))
      .join('');
    const pattern = new RegExp(`^${source}$`);
    if (MASKABLE.some((word) => pattern.test(word))) return true;
  }
  return false;
}

function hasExplicitWords(text) {
  const s = String(text || '');
  return EXPLICIT_RE.test(s) || ROOTS_RE.test(s) || DICK_RE.test(s) || hasMaskedWord(s);
}

/** The sung lines of a desk draft that carry an explicit word: below the "Lyrics:" heading, not
 *  section tags, not the READBACK line, each distinct line once. A clean song is held to clean
 *  with these (kadeSoundBooth.js scriptHandler), in the shape the audit takes flagged lines. */
function explicitSungLines(script) {
  const text = String(script || '');
  const at = text.search(/^\s*lyrics\s*:/im);
  if (at === -1) return [];
  const found = [];
  const seen = new Set();
  for (const raw of text.slice(at).split('\n').slice(1)) {
    const line = raw.trim();
    if (/^READBACK:/i.test(line)) break;
    if (!line || /^\[[^\]]*\]$/.test(line) || seen.has(line)) continue;
    seen.add(line);
    if (hasExplicitWords(line)) found.push({ line, tell: 'a swear word or a sexual word, and this song has to be clean' });
  }
  return found;
}

/** Everything of an asset that the wall shows, a player reads out or an engine sang: the title,
 *  description and prompt, and every text its metadata keeps. The Lyria wire prompt carries words
 *  typed into "Your own lyrics" even when "Keep the words it wrote" is off, and a text field added
 *  later is read without anyone remembering to list it. Links, storage keys and ids are skipped:
 *  the random letters in them are not words anyone hears. */
const SKIPPED_KEY = /^(?:url|key|id|_id)$|(?:Url|URL|Key|Id|ID)$/;
function collectText(value, key, out, depth) {
  if (value == null || depth > 4) return;
  if (typeof value === 'string') {
    if (value && !SKIPPED_KEY.test(key) && !/^(?:https?:)?\/\//i.test(value.trim())) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, key, out, depth + 1);
    return;
  }
  if (typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
    for (const [k, v] of Object.entries(value)) collectText(v, k, out, depth + 1);
}
function wallAssetText(doc) {
  const out = [];
  if (doc) {
    for (const key of ['title', 'description', 'prompt']) collectText(doc[key], key, out, 0);
    collectText(doc.metadata, 'metadata', out, 0);
  }
  return out.join('\n');
}

/** True for every viewer the wall filters: anyone who would not get 'explicit' at the desk (the
 *  App Review seat, the child account, an untyped account, a failed read). The kill switch plays
 *  no part: it only withdraws the desk's permission. */
async function wallViewerRestricted(user, { env = process.env, loadUser = loadStoredAccount, reviewSeat = isReviewSeat } = {}) {
  return (await decideAudience(user, { env, loadUser, reviewSeat })) !== 'explicit';
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
  explicitSungLines,
  wallAssetText,
  wallViewerRestricted,
  filterWallAssets,
};
