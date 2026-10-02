'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * kadeSoundBoothErrors.js — a provider's failure, in words a person can hear.
 *
 * Oct 2 2026: her Seed Audio renders had stopped coming through at all. Three
 * renders that night all failed the same way, and
 * the booth said "Seed Audio could not make that: [object Object]". fal had
 * answered 422 with a FastAPI `detail` ARRAY (one item per problem, each with
 * loc, msg, type and ctx), and the route did String() on it. The real reason —
 * her voice clip was 32.6 seconds and Seed takes 30 — was in that array, and
 * nothing logged it, so the record showed a failure and no cause.
 *
 * Every booth lane that turns a provider's error into words comes here, so the
 * shapes are read in one place: fal and FastAPI `detail` (array or string),
 * Google's `{ error: { message } }`, the bridge's `{ error: '...' }`, a plain
 * string body, an HTML error page, a timeout, a host that cannot be reached,
 * and ffmpeg failing on a file. `message` is short and plain, for her and her
 * screen reader: a link in it becomes its file name (or "the clip"), never an
 * address or an account folder, and an answer it cannot read as words is not
 * read out as JSON. An engine's XML tag keeps its name. `detail` is the whole
 * answer for logger.warn, with signed links cut short so a log line never
 * carries a working key to her audio, and the `input` a provider echoes back
 * (which can be her script) cut to 80 characters.
 * ───────────────────────────────────────────────────────────────────────── */

const MAX_MESSAGE = 240;
const MAX_DETAIL = 1500;
/** How much of a rejected value (fal's `input`) reaches the log: enough to know it, never her whole script. */
const MAX_INPUT = 80;

const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT']);
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ERR_NETWORK',
]);

/** A signed link keeps its address and loses its signature. */
function redactUrls(text) {
  return String(text == null ? '' : text).replace(/(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/gi, '$1?[signed]');
}

function looksLikeHtml(text) {
  return /^\s*<(!doctype|html|head|body)\b/i.test(text);
}

/** A file name worth saying: short, plain, with a real extension (".wav", not "1.0"). */
const SAYABLE_FILE = /^\w[\w .-]{0,79}\.[a-z][a-z0-9]{1,4}$/i;

/**
 * A link, said: its file name, or "the clip". The address itself, its
 * signature and the account folder in it are never read aloud; the redacted
 * link stays in `detail` for the log.
 */
function sayLinks(text) {
  return text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (match) => {
    const trail = (match.match(/[.,;:!?)\]}]+$/) || [''])[0];
    const link = trail ? match.slice(0, -trail.length) : match;
    let file = '';
    try {
      file = decodeURIComponent(new URL(link).pathname.split('/').filter(Boolean).pop() || '');
    } catch (_) {
      file = '';
    }
    return (SAYABLE_FILE.test(file) ? file : 'the clip') + trail;
  });
}

/**
 * Short, one line, cut at a word. A link becomes its file name, a storage path
 * loses its account folder, and a 24-character account or project id is not
 * read out. Markup is removed only from an HTML page; anywhere else a tag such
 * as <emotion> keeps its name, because in an engine's error that name is the
 * thing to fix.
 */
function clean(text, max = MAX_MESSAGE) {
  let s = sayLinks(String(text == null ? '' : text).slice(0, 4000))
    .replace(/(?:[\w.-]+\/)*[0-9a-f]{24}\/(?=[\w.-])/gi, '')
    .replace(/\b[0-9a-f]{24}\b/gi, '');
  s = /<(!doctype|html|head|body)\b/i.test(s)
    ? s.replace(/<[^>]*>/g, ' ')
    : s.replace(/<\/?\s*([A-Za-z][\w:.-]*)[^<>]*>/g, '$1');
  s = s.replace(/\s+([,.;:!?])(?=\s|$)/g, '$1').replace(/\s+/g, ' ').trim();
  if (s.length > max) {
    const cut = s.slice(0, max - 1);
    const space = cut.lastIndexOf(' ');
    s = (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '') + '…';
  }
  return s;
}

/** A response body as data: JSON bodies that arrived as text or bytes are parsed. */
function readBody(data) {
  if (data == null) return null;
  let value = data;
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  else if (value instanceof ArrayBuffer) value = Buffer.from(value).toString('utf8');
  if (typeof value === 'string') {
    const t = value.trim();
    if (/^[[{]/.test(t)) {
      try {
        return JSON.parse(t);
      } catch (_) {
        /* not JSON after all */
      }
    }
    return t;
  }
  return value;
}

function compactJson(value, max) {
  try {
    return JSON.stringify(value).slice(0, max);
  } catch (_) {
    return '';
  }
}

/** One problem from a FastAPI / fal `detail` array, as a sentence. */
function itemWords(item, name) {
  if (item == null) return '';
  if (typeof item !== 'object') return String(item);
  const loc = Array.isArray(item.loc) ? item.loc : [];
  const at = loc.indexOf('audio_urls');
  const clip = at >= 0 && Number.isInteger(loc[at + 1]) ? loc[at + 1] + 1 : null;
  const who = clip ? `Clip ${clip}` : 'A clip';
  const type = String(item.type || '');
  const msg = textOf(item.msg ?? item.message ?? item.detail, name);
  const ctx = item.ctx && typeof item.ctx === 'object' ? item.ctx : {};
  if (type === 'audio_duration_too_long' || /audio duration exceeds/i.test(msg)) {
    const max = Number(ctx.max_duration) || 30;
    return `${who} is too long. ${name} takes clips up to ${max} seconds.`;
  }
  if (/file_too_large|too_large/i.test(type) || /file (size )?(is )?too large|exceeds the maximum (allowed )?(file )?size/i.test(msg)) {
    return `${who} is too big a file for ${name}.`;
  }
  if (clip) return msg ? `Clip ${clip}: ${msg}` : `${name} could not use clip ${clip}.`;
  const field = loc.filter((part) => typeof part === 'string' && part !== 'body').pop();
  if (field && msg && !msg.toLowerCase().includes(field.toLowerCase())) return `${field}: ${msg}`;
  return msg;
}

/**
 * Any error-ish value as words: a string, a FastAPI `detail`, `{ error }`,
 * `{ message }`. Never "[object Object]", and never raw JSON: an object in a
 * shape this does not know says nothing here (the caller falls back to the
 * status, or "did not say why"), and the JSON goes to `detail` for the log.
 * A string that is itself JSON is read the same way.
 */
function textOf(value, name = 'The service') {
  if (value == null) return '';
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t || looksLikeHtml(t) || /^\[object \w+\]$/.test(t)) return '';
    if (/^[[{]/.test(t)) {
      try {
        return textOf(JSON.parse(t), name);
      } catch (_) {
        /* words that happen to start with a bracket */
      }
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const said = [];
    for (const item of value) {
      const words = itemWords(item, name);
      if (words && !said.includes(words)) said.push(words);
    }
    return said.join(' ');
  }
  if (typeof value === 'object') {
    for (const key of ['detail', 'error', 'message', 'msg', 'error_message', 'reason']) {
      if (value[key] != null) {
        const words = textOf(value[key], name);
        if (words) return words;
      }
    }
    /* Braces and quotes are not words: an unfamiliar shape says nothing aloud. */
    return '';
  }
  return String(value);
}

/** A rejected value echoed back (fal's `input`), cut for the log. A link keeps its end, where the file name is. */
function shortInput(value) {
  const s = redactUrls(typeof value === 'string' ? value : compactJson(value, MAX_INPUT * 4)).replace(/\s+/g, ' ');
  if (s.length <= MAX_INPUT) return s;
  return /^https?:\/\/\S+$/i.test(s) ? '…' + s.slice(-(MAX_INPUT - 1)) : s.slice(0, MAX_INPUT - 1) + '…';
}

/** The answer as it is logged: every problem in a `detail` list (or a bare list) has its `input` cut short. */
function forLog(body) {
  const items = (list) =>
    list.map((item) =>
      item && typeof item === 'object' && !Array.isArray(item) && item.input !== undefined
        ? { ...item, input: shortInput(item.input) }
        : item,
    );
  if (Array.isArray(body)) return items(body);
  if (body && typeof body === 'object' && Array.isArray(body.detail)) return { ...body, detail: items(body.detail) };
  return body;
}

function statusWords(status, name) {
  if (status === 400) return `${name} turned that request down.`;
  if (status === 401 || status === 403) return `${name} refused the server's key.`;
  if (status === 404) return `${name} could not find that.`;
  if (status === 408 || status === 504) return `${name} took too long to answer. Try again.`;
  if (status === 413) return `That was too big for ${name}.`;
  if (status === 422) return `${name} could not use that request.`;
  if (status === 429) return `${name} is busy right now. Try again in a minute.`;
  if (status >= 500) return `${name} had a problem on its side. Try again in a minute.`;
  return '';
}

/**
 * A provider's failure (an axios error, an Error, or a bare value) as
 * { message, detail, status, code }. `name` is how the engine is said aloud.
 * @param {unknown} error
 * @param {{ name?: string, max?: number }} [options]
 */
function providerError(error, { name = 'The service', max = MAX_MESSAGE } = {}) {
  const e = error && typeof error === 'object' ? error : { message: error == null ? '' : String(error) };
  const response = e.response && typeof e.response === 'object' ? e.response : null;
  const status = response && Number.isInteger(response.status) ? response.status : null;
  const code = typeof e.code === 'string' ? e.code : null;
  const body = response ? readBody(response.data) : null;
  const ownMessage = typeof e.message === 'string' ? e.message : '';
  const ffmpeg = typeof e.cmd === 'string' || /^Command failed:/i.test(ownMessage);

  let words = body != null ? textOf(body, name) : '';
  if (!words && !response && code && TIMEOUT_CODES.has(code)) words = `${name} did not answer in time.`;
  else if (!words && !response && code && UNREACHABLE_CODES.has(code)) words = `${name} could not be reached.`;
  else if (!words && code === 'ERR_CANCELED') words = `The request to ${name} was stopped.`;
  if (!words && status) words = statusWords(status, name);
  if (!words && ffmpeg) words = 'The audio tool could not read that file.';
  if (!words && ownMessage && !/^Request failed with status code \d+$/i.test(ownMessage)) words = textOf(ownMessage, name);
  if (!words && error && typeof error === 'object' && !(error instanceof Error) && !response) words = textOf(error, name);
  if (!words) words = `${name} did not say why.`;

  const parts = [];
  if (status) parts.push(`status=${status}`);
  if (code) parts.push(`code=${code}`);
  if (body != null) parts.push(`body=${typeof body === 'string' ? body : compactJson(forLog(body), MAX_DETAIL)}`);
  else if (ownMessage) parts.push(`message=${ownMessage}`);
  else if (!(error && typeof error === 'object')) parts.push(`value=${String(error)}`);
  else if (!(error instanceof Error)) parts.push(`value=${compactJson(forLog(error), MAX_DETAIL)}`);
  if (ffmpeg && e.stderr) parts.push(`stderr=${String(e.stderr).slice(-400)}`);

  return {
    message: clean(words, max),
    detail: redactUrls(parts.join(' ')).replace(/\s+/g, ' ').slice(0, MAX_DETAIL),
    status,
    code,
  };
}

/** Just the words, for a value that is already an error message or body (a bridge job's `error`). */
function errorText(value, { name = 'The service', max = MAX_MESSAGE, fallback = '' } = {}) {
  const words = textOf(value, name);
  return words ? clean(words, max) : fallback;
}

module.exports = { providerError, errorText, redactUrls, textOf, clean, sayLinks, forLog, MAX_INPUT };
