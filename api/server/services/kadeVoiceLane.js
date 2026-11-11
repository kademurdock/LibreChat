'use strict';
/**
 * KADE VOICE LANE (Nov 11 2026, home agent card 2): which lane a voice turn came in on.
 *
 * Every voice turn reaches this server through the voice proxy, signed in as the service seat
 * (an ADMIN), with the person on the line named by email (services/kadeOnBehalfOf.js). Until now
 * nothing said whether that person was signed in to the app (web or app voice, opened with a
 * ticket this server minted for their sign-in, routes/kadeWebVoice.js) or calling a phone number
 * (caller ID only, which can be borrowed or faked). So signed-in app voice was treated as a call.
 *
 * The bridge now sends a short-lived pass with each voice turn (kade-ai-bridge lane-pass.js),
 * signed with the secret the two already share for web voice tickets and call transcripts:
 * KADE_CALL_INGEST_SECRET, falling back to KADE_USAGE_EVENT_SECRET. No new variable. The pass
 * rides as one `messages` entry with role 'kade-lane' and no content (the proxy forwards only
 * named fields, and builds the model's text only from entries with content). A top-level
 * body.kadeLanePass is read too, for a proxy that forwards it one day.
 *
 * markVoiceLane (a middleware after resolveKadeOnBehalfOf in routes/agents/chat.js) reads it,
 * takes the entry out of body.messages, and sets at most:
 *   req.kadeAppVoice    { userId }  the pass says app-voice, its email is the person the service
 *                                   seat named, and that person resolved to an account here.
 *   req.kadeCallerNumber '+1...'    the pass says phone and carries the number Twilio gave the
 *                                   bridge for an inbound call. It never makes anyone signed in.
 * It runs only on the service seat, waits on nothing (on a phone turn with a verified number it
 * starts the one pairing lookup and moves on), and never throws: a turn with no pass, a bad
 * pass or an old bridge goes on exactly as before (a phone call, as today).
 *
 * For other code:
 *   laneOf(req)            'text' | 'app-voice' | 'phone'
 *   isSignedInAppVoice(req) true only for a verified app voice turn
 *   callerNumberOf(req)     the bridge-verified caller number on a phone turn, or null
 *
 * Off switch: KADE_APP_VOICE_SIGNED_IN=0 ignores app-voice passes (app voice is a phone call again).
 * The caller number is still read, because phone pairing needs it (KADE_PHONE_PAIRING=0 stops that).
 */
const crypto = require('crypto');

const PREFIX = 'kade-lane.v1.';
const ROLE = 'kade-lane';
const MAX_LIFE_MS = 10 * 60 * 1000;
const SKEW_MS = 60 * 1000;

function secretOf(env = process.env) {
  return String((env && (env.KADE_CALL_INGEST_SECRET || env.KADE_USAGE_EVENT_SECRET)) || '');
}
function appVoiceOn(env = process.env) {
  return String((env && env.KADE_APP_VOICE_SIGNED_IN) ?? '') !== '0';
}
function isServiceSeat(req) {
  return Boolean(req && req.user && String(req.user.role || '').toUpperCase() === 'ADMIN');
}
function e164(v) {
  const s = String(v || '').trim();
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

/** The pass's claims when its signature, age and shape are good; otherwise null. */
function verifyLanePass(token, env = process.env, now = Date.now()) {
  try {
    const secret = secretOf(env);
    if (!secret || typeof token !== 'string' || token.length > 2048) return null;
    const dot = token.lastIndexOf('.');
    if (dot < 1) return null;
    const body = token.slice(0, dot);
    const sig = Buffer.from(token.slice(dot + 1));
    const expect = Buffer.from(crypto.createHmac('sha256', secret).update(PREFIX + body).digest('base64url'));
    if (sig.length !== expect.length || !crypto.timingSafeEqual(sig, expect)) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p || p.v !== 1 || typeof p.exp !== 'number' || typeof p.iat !== 'number') return null;
    if (now > p.exp || p.iat > now + SKEW_MS || p.exp - p.iat > MAX_LIFE_MS) return null;
    if (p.lane !== 'app-voice' && p.lane !== 'phone') return null;
    if (p.lane === 'app-voice' && (typeof p.email !== 'string' || !p.email)) return null;
    return p;
  } catch (_) {
    return null;
  }
}

/** Take the pass out of the request body (always, so nothing later sees it) and return its token. */
function takePass(body) {
  if (!body || typeof body !== 'object') return null;
  let token = typeof body.kadeLanePass === 'string' ? body.kadeLanePass : null;
  if (Object.prototype.hasOwnProperty.call(body, 'kadeLanePass')) delete body.kadeLanePass;
  if (Array.isArray(body.messages)) {
    const kept = [];
    for (const m of body.messages) {
      if (m && typeof m === 'object' && m.role === ROLE) {
        if (!token && typeof m.kadeLanePass === 'string') token = m.kadeLanePass;
        continue;
      }
      kept.push(m);
    }
    if (kept.length !== body.messages.length) body.messages = kept;
  }
  return token;
}

/**
 * Read the pass on a voice turn. Pure and synchronous: adds no wait before a reply.
 * @returns {{ lane: string|null, why: string }} for logs and tests (no email, no number)
 */
function readLane(req, env = process.env, now = Date.now()) {
  if (!req || !req.body) return { lane: null, why: 'no-body' };
  const token = takePass(req.body);
  if (!token) return { lane: null, why: 'no-pass' };
  if (!isServiceSeat(req)) return { lane: null, why: 'not-service-seat' };
  const p = verifyLanePass(token, env, now);
  if (!p) return { lane: null, why: 'bad-pass' };
  const agentId = String(req.body.agentId || req.body.agent_id || '');
  if (p.agentId && agentId && p.agentId !== agentId) return { lane: null, why: 'other-agent' };
  if (p.lane === 'phone') {
    /* Nov 11 2026 review: a verified phone pass marks the turn as a call even when it names nobody,
     * so an unknown caller is never taken for the service seat's own signed-in owner. */
    req.kadeVoicePass = 'phone';
    const num = e164(p.num);
    if (num) req.kadeCallerNumber = num;
    return { lane: 'phone', why: num ? 'phone-number' : 'phone' };
  }
  if (!appVoiceOn(env)) return { lane: null, why: 'app-voice-off' };
  const who = req.kadeOnBehalfOf;
  if (!who || !who.id || req.kadeOnBehalfOfUnresolved === true) return { lane: null, why: 'nobody' };
  const named = String(req.body.kadeOnBehalfOf || '').trim().toLowerCase();
  const resolved = String(who.email || '').trim().toLowerCase();
  if (!named || p.email !== named || (resolved && resolved !== named)) return { lane: null, why: 'other-person' };
  req.kadeAppVoice = { userId: String(who.id) };
  return { lane: 'app-voice', why: 'verified' };
}

function markVoiceLane(req, _res, next) {
  try {
    const r = readLane(req);
    if (r.lane || r.why === 'bad-pass' || r.why === 'other-person' || r.why === 'other-agent') {
      try {
        require('@librechat/data-schemas').logger.info(`[kadeVoiceLane] ${r.lane || 'none'} (${r.why})`);
      } catch (_) {
        /* logging is never worth a turn */
      }
    }
  } catch (_) {
    /* never break a voice turn */
  }
  /* Phone pairing: start this turn's one lookup now, without waiting for it, so it has usually
   * settled before any tool asks (kadeLaneTrust.resolvePairing; kadeLedger awaits the same
   * promise only when a kade tool is about to run). No number on the turn: nothing is looked up. */
  try {
    if (req && req.kadeCallerNumber) require('./kadeLaneTrust').resolvePairing(req);
  } catch (_) {
    /* pairing is never worth a turn */
  }
  return next();
}

/** A verified signed-in app voice turn for the person the service seat named. */
function isSignedInAppVoice(req) {
  return Boolean(
    req &&
      req.kadeAppVoice &&
      req.kadeOnBehalfOf &&
      req.kadeOnBehalfOf.id &&
      String(req.kadeAppVoice.userId) === String(req.kadeOnBehalfOf.id) &&
      req.kadeOnBehalfOfUnresolved !== true,
  );
}

/** A turn the bridge signed as a phone call (with or without a caller number). */
function isPhonePass(req) {
  return Boolean(req && (req.kadeVoicePass === 'phone' || e164(req.kadeCallerNumber)));
}

/** The caller's number on a phone turn, as the bridge got it from Twilio; null otherwise. */
function callerNumberOf(req) {
  if (!req || isSignedInAppVoice(req)) return null;
  return e164(req.kadeCallerNumber);
}

/**
 * 'text' for someone typing in the app or on the website, 'app-voice' for verified signed-in
 * voice, 'phone' for every other voice or service-seat turn (caller ID only, or nobody named).
 */
function laneOf(req) {
  if (!req) return 'phone';
  if (isSignedInAppVoice(req)) return 'app-voice';
  const body = req.body || {};
  if (req.kadeOnBehalfOf || req.kadeOnBehalfOfUnresolved === true || body.kadeOnBehalfOf) return 'phone';
  if (req.kadeCallerNumber || req.kadeVoicePass === 'phone') return 'phone';
  if (isServiceSeat(req) && Array.isArray(body.messages)) return 'phone';
  const raw = typeof body.text === 'string' ? body.text.toLowerCase() : '';
  if (raw.startsWith('[earlier in this conversation')) return 'phone';
  return 'text';
}

module.exports = {
  PREFIX,
  ROLE,
  verifyLanePass,
  takePass,
  readLane,
  markVoiceLane,
  isSignedInAppVoice,
  callerNumberOf,
  isPhonePass,
  laneOf,
  appVoiceOn,
};
