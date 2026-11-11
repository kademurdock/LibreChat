'use strict';
/**
 * KADE LANE TRUST (Nov 11 2026, home agent plan card 3): what a turn may touch, by how sure the
 * platform is of who is talking.
 *
 * The phone lane knows a caller only by caller ID, and caller ID can be faked or borrowed. So on
 * a plain phone turn nothing that belongs to a person is read back, changed, deleted or paid for.
 * The refusal is made here, in code, before the tool runs (app/clients/tools/util/handleTools.js
 * wraps every kade_* tool and fal_studio through services/kadeLedger.js). It closes hole N6 from
 * CHARACTERS_AND_AGENTIC_PLAN_2026-11-10.md: no forget and no delete from a phone.
 *
 *   laneTrust(req) -> 'signed-in' | 'paired-phone' | 'phone'
 *     'signed-in'    text chat in the app or website (the request is the person's own sign-in),
 *                    a background run the server started for them, and signed-in app voice once
 *                    the bridge says so (body.kadeCallerSignedIn === true from the service seat,
 *                    with KADE_STUDIO_APP_VOICE=1; the same rule as services/kadeStudio.js).
 *     'paired-phone' a phone the person paired with a spoken code from the app (card 2, not built
 *                    yet). Honoured only when the bridge says body.kadeCallerPaired === true from
 *                    the service seat AND KADE_PHONE_PAIRING=1. Off by default: nothing sends it.
 *     'phone'        everything else on the voice lane: a caller named by number, an unmatched
 *                    caller, a folded call turn. When unsure, this.
 *
 *   What each lane may do (by the kind of action, see KINDS):
 *     signed-in     everything it could do before.
 *     paired-phone  general things, hearing their own reminders and lists, and ordinary writes
 *                   such as setting a reminder. Never mail or messages sent as them, memory,
 *                   deletes, spending or a standing yes.
 *     phone         general things only: weather, news, a joke, a game, a chat.
 *
 * Today the bridge sends neither kadeCallerSignedIn nor kadeCallerPaired, so signed-in app voice
 * is still taken for a phone call (the known gap that card 2 closes). A safety gate: no off switch.
 * KADE_STUDIO_APP_VOICE and KADE_PHONE_PAIRING only ever loosen it, and both are off by default.
 *
 * No '~' requires, so node --test loads it.
 */

const { latestWords } = require('./kadeSpendGate');

const SIGNED_IN = 'signed-in';
const PAIRED = 'paired-phone';
const PHONE = 'phone';

function appVoiceOn(env = process.env) {
  return String((env && env.KADE_STUDIO_APP_VOICE) ?? '') === '1';
}
function pairingOn(env = process.env) {
  return String((env && env.KADE_PHONE_PAIRING) ?? '') === '1';
}

/**
 * How sure is the platform of who is on this turn?
 * @param {object} req the request of the turn
 * @param {Record<string, string | undefined>} [env]
 * @returns {'signed-in' | 'paired-phone' | 'phone'}
 */
function laneTrust(req, env = process.env) {
  if (!req || typeof req !== 'object' || !req.user || !req.user.id) return PHONE;
  if (req.kadeHiddenRun === true) return SIGNED_IN;
  const body = req.body || {};
  const behalf = req.kadeOnBehalfOf && req.kadeOnBehalfOf.id ? req.kadeOnBehalfOf : null;
  const named = Boolean(behalf || req.kadeOnBehalfOfUnresolved === true || body.kadeOnBehalfOf);
  const folded = latestWords(body.text).folded;
  if (!named && !folded) return SIGNED_IN;
  if (req.kadeOnBehalfOfUnresolved === true || !behalf) return PHONE;
  /* Only the service seat (the voice proxy) may vouch for a caller. */
  const serviceSeat = String(req.user.role || '').toUpperCase() === 'ADMIN';
  if (!serviceSeat) return PHONE;
  if (appVoiceOn(env) && body.kadeCallerSignedIn === true) return SIGNED_IN;
  if (pairingOn(env) && body.kadeCallerPaired === true) return PAIRED;
  return PHONE;
}

/* ------------------------------------------------------------------ the kinds of action */

/*
 * general   nothing of the person's: weather, news, a joke, a game, a public page
 * list      hearing their own reminders, lists, job status
 * write     an ordinary change to their account: set a reminder, file feedback, save a game
 * send      something sent as them to someone else (a family message)
 * private   their memory, files, balance, the owner's own tools
 * delete    removing or cancelling something of theirs
 * spend     anything that costs money or starts paid work, quotes included
 * standing  approvals and platform-wide actions
 */
const ALLOWED = {
  [SIGNED_IN]: null, // everything
  [PAIRED]: new Set(['general', 'list', 'write']),
  [PHONE]: new Set(['general']),
};

/* tool -> { action -> kind, '*' -> kind for any other action }. A tool not listed is 'private'. */
const KINDS = {
  kade_weather: { '*': 'general' },
  kade_wikipedia: { '*': 'general' },
  kade_joke: { '*': 'general' },
  kade_news: { '*': 'general' },
  kade_lyrics: { '*': 'general' },
  kade_read_page: { '*': 'general' },
  kade_help: { '*': 'general' },
  kade_media: { '*': 'general' },
  kade_location: { '*': 'general' },
  kade_games: { '*': 'general' },
  kade_world: { '*': 'general' },
  kade_adventure: { list: 'list', load: 'list', save: 'write', delete: 'delete', '*': 'private' },
  kade_notify: {
    platform_status: 'general',
    list_reminders: 'list',
    list_checkins: 'list',
    send: 'write',
    set_reminder: 'write',
    schedule_checkin: 'write',
    test_checkin: 'write',
    pause_checkin: 'write',
    spontaneous_on: 'write',
    spontaneous_off: 'write',
    cancel_reminder: 'delete',
    cancel_checkin: 'delete',
    broadcast_whats_new: 'standing',
    '*': 'private',
  },
  kade_call_me: {
    list_ringtones: 'general',
    list_calls: 'list',
    schedule_call: 'write',
    pause_call: 'write',
    cancel_call: 'delete',
    test_call: 'spend',
    '*': 'private',
  },
  kade_phone_call: {
    check_result: 'list',
    list_checkins: 'list',
    pause_checkin: 'write',
    cancel_checkin: 'delete',
    place_call: 'spend',
    schedule_checkin: 'spend',
    test_checkin: 'spend',
    '*': 'spend',
  },
  kade_research: { check: 'list', get: 'list', cancel: 'delete', start: 'spend', '*': 'spend' },
  kade_task: { status: 'list', list: 'list', cancel: 'delete', quote: 'spend', start: 'spend', '*': 'spend' },
  kade_studio: { status: 'list', list: 'list', cancel: 'delete', quote: 'spend', start: 'spend', '*': 'spend' },
  kade_errand: { status: 'list', list: 'list', receipts: 'list', cancel: 'delete', '*': 'spend' },
  /* A bug report to Kade is not the caller's private thing and is how voice users report
   * problems; reopening one changes their own past report. */
  kade_feedback: { file: 'general', reopen: 'write', '*': 'write' },
  kade_make_file: { '*': 'write' },
  kade_message: { '*': 'send' },
  kade_memory_search: { '*': 'private' },
  kade_living_memory: { '*': 'private' },
  kade_transcribe: { '*': 'private' },
  kade_funding_balance: { '*': 'private' },
  kade_code: { '*': 'private' },
  kade_drive_pc: { '*': 'private' },
  kade_council: { '*': 'private' },
  kade_approvals: { list: 'private', '*': 'standing' },
  fal_studio: { '*': 'spend' },
};

/* Left to their own access rules on purpose (the Library and family history are not changed by
 * this card); they already refuse an unmatched caller themselves. */
const EXEMPT = new Set(['kade_library', 'kade_library_requests', 'kade_family_history']);

/** The kind of one call. */
function kindOf(tool, input) {
  const map = KINDS[tool];
  if (!map) return 'private';
  const action = input && typeof input === 'object' && typeof input.action === 'string' ? input.action : '';
  return map[action] || map['*'] || 'private';
}

const LINE_PHONE = 'I can do that in the app, or once this phone is paired.';
const LINE_PAIRED = 'I can do that in the app.';

/**
 * Should this call be refused on this lane? Returns null to go on, or the refusal the tool
 * returns instead of running (it begins "FAILED:").
 * @param {string} tool
 * @param {unknown} input the tool call's arguments
 * @param {object} req
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ lane: string, kind: string, text: string } | null}
 */
function laneRefusal(tool, input, req, env = process.env) {
  if (EXEMPT.has(tool)) return null;
  const lane = laneTrust(req, env);
  const allowed = ALLOWED[lane];
  if (!allowed) return null;
  const kind = kindOf(tool, input);
  if (allowed.has(kind)) return null;
  const line = lane === PAIRED ? LINE_PAIRED : LINE_PHONE;
  const why =
    lane === PAIRED
      ? 'This phone is paired, but mail, messages, memory, deletes and anything that costs money still need the app.'
      : 'This is a phone call, and the platform cannot be sure who is calling, so nothing that belongs to them can be read back, changed, deleted or paid for here.';
  return {
    lane,
    kind,
    text: `FAILED: not done, nothing was changed. ${why} Tell them in one short plain sentence, in your own voice, something like: "${line}" Do not say it was done, and do not try another tool for it.`,
  };
}

module.exports = {
  laneTrust,
  laneRefusal,
  kindOf,
  KINDS,
  EXEMPT,
  LINE_PHONE,
  LINE_PAIRED,
  SIGNED_IN,
  PAIRED,
  PHONE,
};
