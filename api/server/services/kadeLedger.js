'use strict';
/**
 * KADE LEDGER (Nov 11 2026, home agent plan card 4): truth from the ledger.
 *
 * Why: characters have said "done" about reminders that were never set, and "the tool failed"
 * when no tool was called (utils/kadePromiseGuard.js has the stories). A prompt rule asks; this
 * records. Every kade_* tool call (and fal_studio) in a turn gets one row, written by code:
 *
 *   { tool, action, ok, code, summary, at }
 *
 * `action` is kept only when it is a plain tool action name (lowercase letters and _), `code` is
 * one of a fixed set, and `summary` is built from those three. No user text, no tool output, no
 * arguments are ever stored or logged. Rows live in memory for the length of the request only
 * (keyed by the request object, like services/kadeSpendGate.js); nothing is written to disk.
 *
 * What the character sees (wrapKadeTool, wired in app/clients/tools/util/handleTools.js):
 *   - every result begins with "OK:" or "FAILED:" (a result that already does is left alone);
 *   - after it, a short code-built note of what really happened this turn so far, so the reply
 *     that follows the tool calls cannot claim a call that did not happen or a failure that
 *     did not;
 *   - a call refused on the phone lane (services/kadeLaneTrust.js, card 3) is refused here,
 *     before the tool runs, and recorded as FAILED.
 *
 * After the reply (controllers/agents/client.js): countLedgerClaims logs, counts only, how many
 * claims of a start, a reminder, a failure or a price the reply made with no ledger row behind
 * them. KADE_CLAIM_COUNT=0 turns that count off. The ledger itself has no off switch: it is a
 * safety gate. Nothing here waits on anything: string checks only.
 *
 * Honest limit: a tool that returns a sentence (not a throw, not "ok": false JSON) is judged
 * FAILED only when its first words say so ("Not started:", "Could not", "NOT MADE", ...). A
 * refusal worded like a success is recorded OK.
 *
 * No '~' requires at load time, so node --test loads it.
 */

const { laneRefusal, kindOf } = require('./kadeLaneTrust');

/* The kinds of call that can back "I started it" (services/kadeLaneTrust.js KINDS). */
const STARTS = new Set(['spend', 'write', 'send']);

const ledgers = new WeakMap();
const NOTE_ROWS = 6;
const CODES = new Set(['done', 'returned-failure', 'empty', 'threw', 'aborted', 'refused-phone', 'refused-paired-phone']);

function log() {
  try {
    return require('@librechat/data-schemas').logger;
  } catch (_) {
    return null;
  }
}

/** Only a plain action name may enter a row; anything else is dropped. */
function cleanAction(input) {
  const a = input && typeof input === 'object' ? input.action : undefined;
  return typeof a === 'string' && /^[a-z_]{1,40}$/.test(a) ? a : null;
}

function summaryOf(row) {
  const what = row.action ? `${row.tool} ${row.action}` : row.tool;
  return `${what}: ${row.ok ? 'OK' : 'FAILED'}${!row.ok && row.code ? ` (${row.code})` : ''}`;
}

/**
 * Record one tool call for this turn. Returns the row, or null without a request.
 * @param {object} req
 * @param {{ tool: string, action?: string | null, ok: boolean, code: string }} row
 */
function record(req, { tool, action = null, ok, code }) {
  if (!req || typeof req !== 'object') return null;
  let book = ledgers.get(req);
  if (!book) {
    book = { rows: [] };
    ledgers.set(req, book);
  }
  const safeTool = typeof tool === 'string' && /^[a-z0-9_]{1,60}$/i.test(tool) ? tool : 'tool';
  const safeAction = typeof action === 'string' && /^[a-z_]{1,40}$/.test(action) ? action : null;
  const row = {
    tool: safeTool,
    action: safeAction,
    ok: ok === true,
    code: CODES.has(code) ? code : ok === true ? 'done' : 'returned-failure',
    at: new Date(),
  };
  row.summary = summaryOf(row);
  book.rows.push(row);
  return row;
}

/** This turn's rows (a copy). */
function rows(req) {
  const book = req && typeof req === 'object' ? ledgers.get(req) : null;
  return book ? book.rows.slice() : [];
}

/** The short "what really happened this turn" note, built from the rows only. '' with none. */
function truthNote(req) {
  const all = rows(req);
  if (!all.length) return '';
  const shown = all.slice(-NOTE_ROWS);
  const lines = shown.map((r, i) => `${all.length - shown.length + i + 1}) ${r.summary}`).join('; ');
  const more = all.length > shown.length ? ` (${all.length} calls; the last ${shown.length} shown)` : '';
  return (
    `[Platform record of this turn's tool calls, kept by code${more}: ${lines}. ` +
    'Tell them only what this record shows. A FAILED call did not happen; never say it worked. ' +
    'Never say a tool failed unless this record says FAILED.]'
  );
}

/* A sentence result that says it did not happen, in its first words. */
const FAIL_START =
  /^\s*(?:FAILED\b|not (?:started|made|sent|set|saved|done|scheduled|created|found|available|allowed)\b|nothing (?:was|is) (?:made|sent|set|saved|started|changed|charged)\b|could ?n[o'’]?t\b|can(?:not|['’]t)\b|unable\b|failed\b|error\b|sorry\b|refused\b|denied\b|blocked\b|no such\b|unknown (?:action|command|check-in|reminder)\b|out of credits\b|budget reached\b)/i;

function textOf(out) {
  if (typeof out === 'string') return out;
  if (Array.isArray(out) && typeof out[0] === 'string') return out[0];
  return null;
}

/** Was this result a success? Code only. */
function judge(out) {
  const text = textOf(out);
  if (text === null) return { ok: out !== undefined && out !== null, code: out == null ? 'empty' : 'done' };
  const t = text.trim();
  if (!t) return { ok: false, code: 'empty' };
  if (/^OK\b/.test(t)) return { ok: true, code: 'done' };
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && (o.ok === false || (o.error && o.ok !== true))) return { ok: false, code: 'returned-failure' };
      return { ok: true, code: 'done' };
    } catch (_) {
      /* not JSON: read it as a sentence */
    }
  }
  if (FAIL_START.test(t)) return { ok: false, code: 'returned-failure' };
  return { ok: true, code: 'done' };
}

/** "OK: ..." or "FAILED: ...", then the turn's note. Leaves a result that already says it. */
function stamp(out, ok, req) {
  const note = truthNote(req);
  const mark = (s) => {
    const head = /^\s*(?:OK|FAILED)\b/.test(s) ? s : `${ok ? 'OK' : 'FAILED'}: ${s}`;
    return note ? `${head}\n\n${note}` : head;
  };
  if (typeof out === 'string') return mark(out);
  if (Array.isArray(out) && typeof out[0] === 'string') return [mark(out[0]), ...out.slice(1)];
  return out;
}

function isAbort(e) {
  return Boolean(e && (e.name === 'AbortError' || e.code === 'ABORT_ERR'));
}

/** Which tools the ledger covers: every kade_* tool, and fal_studio (paid). */
function covers(name) {
  return typeof name === 'string' && (name.startsWith('kade_') || name === 'fal_studio');
}

/**
 * Wrap a tool instance's _call: the lane check first, then the call, then the row and the mark.
 * Safe to call twice (a wrapped tool is left as it is).
 * @param {string} name the tool's key (kade_notify ...)
 * @param {object} tool the tool instance
 * @param {object} req the turn's request
 */
function wrapKadeTool(name, tool, req, env = process.env) {
  if (!covers(name) || !tool || typeof tool._call !== 'function' || tool.__kadeLedger === true) return tool;
  const inner = tool._call.bind(tool);
  tool._call = async function kadeLedgerCall(input, ...rest) {
    const action = cleanAction(input);
    const refusal = laneRefusal(name, input, req, env);
    if (refusal) {
      record(req, { tool: name, action, ok: false, code: `refused-${refusal.lane}` });
      log()?.info?.(`[kade/ledger] refused on the ${refusal.lane} lane: tool=${name} action=${action || '-'} kind=${refusal.kind}`);
      const note = truthNote(req);
      return note ? `${refusal.text}\n\n${note}` : refusal.text;
    }
    let out;
    try {
      out = await inner(input, ...rest);
    } catch (e) {
      if (isAbort(e)) {
        record(req, { tool: name, action, ok: false, code: 'aborted' });
        throw e;
      }
      record(req, { tool: name, action, ok: false, code: 'threw' });
      log()?.warn?.(`[kade/ledger] tool=${name} action=${action || '-'} threw`);
      const why = String((e && e.message) || 'an error').replace(/\s+/g, ' ').slice(0, 200);
      const note = truthNote(req);
      return (
        `FAILED: ${name}${action ? ` ${action}` : ''} did not work (${why}). It did not happen. ` +
        'Tell them plainly, and do not say it was done.' +
        (note ? `\n\n${note}` : '')
      );
    }
    const verdict = judge(out);
    record(req, { tool: name, action, ok: verdict.ok, code: verdict.code });
    return stamp(out, verdict.ok, req);
  };
  Object.defineProperty(tool, '__kadeLedger', { value: true, enumerable: false });
  return tool;
}

/**
 * handleTools helper: a lazy tool loader that hands back the wrapped instance.
 * @param {string} name
 * @param {() => Promise<object>} load
 * @param {object} req
 */
function ledgered(name, load, req) {
  if (!covers(name) || typeof load !== 'function') return load;
  return async (...args) => wrapKadeTool(name, await load(...args), req);
}

/* ------------------------------------------------------- claims with no row behind them */

const REMINDER_ACTIONS = new Set(['set_reminder', 'schedule_checkin', 'schedule_call']);
const PRICE_TOOLS = new Set(['kade_task', 'kade_studio', 'fal_studio', 'kade_research', 'kade_phone_call', 'kade_errand']);

/**
 * After the reply: how many of its claims have no ledger row behind them. Counts only, one log
 * line when any is unbacked; never changes the reply. KADE_CLAIM_COUNT=0 turns it off.
 * @param {object} req
 * @param {Array} contentParts the finished reply's parts
 * @param {{ logger?: object, agentId?: string, env?: Record<string, string | undefined> }} [ctx]
 * @returns {null | { rows: number, ok: number, failed: number, unbacked: { start: number, reminder: number, failure: number, price: number } }}
 */
function countLedgerClaims(req, contentParts, ctx = {}) {
  const env = ctx.env || process.env;
  if (String(env.KADE_CLAIM_COUNT ?? '') === '0') return null;
  const { countClaims, PROMISE_PATTERNS, DELIVERY_CLAIM, REMINDER_WORD } = require('../utils/kadePromiseGuard');
  const n = countClaims(contentParts);
  let reminder = 0;
  for (const part of Array.isArray(contentParts) ? contentParts : []) {
    if (!part || part.type !== 'text') continue;
    const t = typeof part.text === 'string' ? part.text : (part.text && part.text.value) || '';
    for (const s of t.split(/(?<=[.!?])\s+|\n+/)) {
      if (s && (PROMISE_PATTERNS.some((re) => re.test(s)) || (DELIVERY_CLAIM.test(s) && REMINDER_WORD.test(s)))) reminder += 1;
    }
  }
  const all = rows(req);
  const ok = all.filter((r) => r.ok);
  const failed = all.filter((r) => !r.ok);
  const unbacked = {
    start: ok.some((r) => STARTS.has(kindOf(r.tool, { action: r.action || '' }))) ? 0 : n.start,
    reminder: ok.some((r) => r.tool === 'kade_notify' || REMINDER_ACTIONS.has(r.action)) ? 0 : reminder,
    failure: failed.length ? 0 : n.failure,
    price: all.some((r) => PRICE_TOOLS.has(r.tool)) ? 0 : n.price,
  };
  const out = { rows: all.length, ok: ok.length, failed: failed.length, unbacked };
  if (unbacked.start + unbacked.reminder + unbacked.failure + unbacked.price > 0) {
    (ctx.logger || log())?.info?.(
      `[kade/ledger-claims] agent=${ctx.agentId || '?'} rows=${all.length} ok=${ok.length} failed=${failed.length} ` +
        `unbacked start=${unbacked.start} reminder=${unbacked.reminder} failure=${unbacked.failure} price=${unbacked.price}`,
    );
  }
  return out;
}

module.exports = {
  record,
  rows,
  truthNote,
  judge,
  stamp,
  covers,
  wrapKadeTool,
  ledgered,
  countLedgerClaims,
  summaryOf,
};
