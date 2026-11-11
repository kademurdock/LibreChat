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
 *                    a background run the server started for them, and verified signed-in app
 *                    voice: the bridge's signed lane pass says app-voice for the person the
 *                    service seat named (card 2, services/kadeVoiceLane.js isSignedInAppVoice;
 *                    KADE_APP_VOICE_SIGNED_IN=0 turns that off). A bare body flag never counts.
 *     'paired-phone' a phone the person paired with a spoken code from the app (card 2,
 *                    services/kadePhonePairing.js). The caller number must come from the bridge's
 *                    signed pass (kadeVoiceLane.callerNumberOf), be paired, and be paired to the
 *                    very account the service seat named. resolvePairing(req) looks that up once
 *                    per turn, only on a phone turn with a verified number, and only when a tool
 *                    is about to run (kadeLedger.wrapKadeTool awaits it), so no reply waits on it.
 *                    KADE_PHONE_PAIRING=0 turns pairing off (isPairedPhone then says null).
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
 * Until the bridge sends its lane pass (kade-ai-bridge lane-pass.js, card 2), signed-in app voice
 * is still taken for a phone call. A safety gate: no off switch. KADE_APP_VOICE_SIGNED_IN and
 * KADE_PHONE_PAIRING only ever loosen it, and only for a turn the bridge has signed for.
 *
 * No '~' requires, so node --test loads it.
 */

const { latestWords } = require('./kadeSpendGate');
const voiceLane = require('./kadeVoiceLane');

const SIGNED_IN = 'signed-in';
const PAIRED = 'paired-phone';
const PHONE = 'phone';

/* ------------------------------------------------------------------ paired phones (card 2) */

/* Per turn: the pairing answer (a Promise of true/false), keyed by the request object so nothing
 * in a request body can set it. */
const pairings = new WeakMap();
/* The same answer once it has settled, for synchronous readers (laneTrust). */
const settled = new WeakMap();
const PAIR_WAIT_MS = 1500;

/** A phone turn the service seat vouches for, naming a resolved account: the only kind pairing can lift. */
function namedPhoneTurn(req) {
  return Boolean(
    req &&
      typeof req === 'object' &&
      req.user &&
      String(req.user.role || '').toUpperCase() === 'ADMIN' &&
      req.kadeOnBehalfOf &&
      req.kadeOnBehalfOf.id &&
      req.kadeOnBehalfOfUnresolved !== true &&
      !voiceLane.isSignedInAppVoice(req),
  );
}

/**
 * Look up, once per turn, whether this call comes from a phone paired to the account the service
 * seat named. Only a phone turn carrying a bridge-verified caller number does any I/O (one keyed
 * hash read, capped at PAIR_WAIT_MS); every other turn answers false at once. Never throws.
 * @param {object} req
 * @param {{ isPairedPhone?: (num: string) => Promise<string|null>, waitMs?: number }} [deps] tests only
 * @returns {Promise<boolean>}
 */
function resolvePairing(req, deps) {
  if (!req || typeof req !== 'object') return Promise.resolve(false);
  const known = pairings.get(req);
  if (known) return known;
  let answer;
  const num = namedPhoneTurn(req) ? voiceLane.callerNumberOf(req) : null;
  if (!num) {
    answer = Promise.resolve(false);
  } else {
    const look =
      (deps && deps.isPairedPhone) ||
      ((n) => require('./kadePhonePairing').isPairedPhone(n));
    const waitMs = deps && typeof deps.waitMs === 'number' ? deps.waitMs : PAIR_WAIT_MS;
    let timer;
    answer = Promise.race([
      Promise.resolve()
        .then(() => look(num))
        .then((acct) => Boolean(acct) && String(acct) === String(req.kadeOnBehalfOf.id))
        .catch(() => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }),
    ]).then((v) => {
      clearTimeout(timer);
      settled.set(req, v === true);
      return v === true;
    });
  }
  if (!num) settled.set(req, false);
  pairings.set(req, answer);
  return answer;
}

/** Synchronous: was this turn's call found paired (after resolvePairing settled)? false otherwise. */
function pairedOnThisCall(req) {
  return Boolean(req && typeof req === 'object' && settled.get(req) === true && namedPhoneTurn(req));
}

/**
 * How sure is the platform of who is on this turn?
 * @param {object} req the request of the turn
 * @param {Record<string, string | undefined>} [env] kept for callers; the lanes read their own switches
 * @returns {'signed-in' | 'paired-phone' | 'phone'}
 */
// eslint-disable-next-line no-unused-vars
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
  if (voiceLane.isSignedInAppVoice(req)) return SIGNED_IN;
  if (pairedOnThisCall(req)) return PAIRED;
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
    /* Cards 6 and 7 (services/kadeEverydayTool.js). The engine also refuses everything but "now"
     * on a plain phone call; this is the outer gate. A paired phone may hear and add, never
     * remove, clear or change a medicine schedule (a paused dose is a missed dose). */
    now: 'general',
    check_back: 'write',
    timer: 'write',
    alarm: 'write',
    set_timezone: 'write',
    reminder_wording: 'write',
    reminders_on: 'write',
    medicine_add: 'write',
    medicine_list: 'list',
    medicine_change: 'delete',
    list_add: 'write',
    list_read: 'list',
    list_remove: 'delete',
    list_clear: 'delete',
    contact_save: 'write',
    contact_read: 'list',
    contact_remove: 'delete',
    '*': 'private',
  },
  /* Card 2: a pairing code is said ON a phone call, from the phone being paired; the code itself
   * is the proof, and the engine takes the number only from the bridge's signed pass. Making a
   * code, listing and unpairing are the signed-in person's own (the engine refuses them on calls). */
  kade_phone_pairing: { redeem: 'general', '*': 'private' },
  /* Cards 8 and 9: what a character knows about the person, and their own past chats. */
  kade_known: { '*': 'private' },
  kade_recall: { '*': 'private' },
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
  resolvePairing,
  pairedOnThisCall,
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
