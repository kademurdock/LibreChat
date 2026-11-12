'use strict';
/* KADE Nov 12 2026 (platform audit, phase 3 A2): what a person reads and a screen reader says, worked
 * out once on the server. Saved replies in the final frame (and GET /api/kade/messages/:id) carry it as
 * `kade.readableText`; `text` and `content` stay raw, because the voice needs the %%% tags.
 *
 * The apps had their own copies (iPhone MessageTextSanitizer, Android ReadableText) that pair %%% tags
 * by position, which is the Nov 6 bug. This one uses the server's structural strip (steeringStrip.js).
 *
 * Every pattern here is bounded on purpose. The audit's first draft copied three app patterns that took
 * 13 s or more on a hostile 200,000-character message; kadeReadableText.nodetest.js re-times all of them.
 * Do not widen a quantifier without re-timing it on a 200,000-character run of the character it starts with.
 *
 * Kill switch: KADE_READABLE_TEXT=0 sends no field (every app falls back to its own sanitizer). */
const { stripSteeringTags } = require('./steeringStrip');

const CODE_SPAN = /```[\s\S]*?(?:```|$)|`[^`\n]+`/g;
// eslint-disable-next-line no-control-regex -- the code-span placeholders are control characters on purpose
const HELD_CODE = /\u0001(\d{1,6})\u0002/g;
const SCENE_TAG = /\[\[[ \t]{0,4}([^[\]\n]{1,58}?)[: \t]{0,4}\]\][ \t]{0,8}/g;
const GAME_SOUND = /\[sound:[a-z0-9_]{1,40}\]/gi;
const GAME_TABLE = /\[table:[a-z0-9]{1,12}\]/gi;
const DEEP_THINK = /\[DEEP THINK(?: {1,4}\d{10,17})?\]/gi;
const INSTANT = /\[INSTANT(?: {1,4}\d{10,17})?\]/gi;
const LITERAL_CITATION = /\\{1,4}u ?e?20[0-9a-f](?:turn\d{1,3}[a-z]{2,10}\d{1,3})?/gi;
const PUA_CITATION = /[-](?:turn\d{1,3}[a-z]{2,10}\d{1,3})?/gi;
const ORPHAN_ANCHOR =
  /\bturn\d{1,3}(?:search|news|image|ref|view|fetch|video|file|local|tech)\d{1,3}\b/gi;
const SPECIAL_TOKEN = /<\|[^|<>]{1,48}\|>/g;
const MD_HEADER = /^#{1,6}[ \t]+/;
const MD_BULLET = /^[ \t]*[-*•][ \t]+/;
const MD_BOLD = /\*\*([^*\n]{1,400})\*\*/g;
const MD_ITALIC = /(^|[^*\w])\*(\S(?:[^*\n]{0,58}\S)?)\*(?!\*)/g;
const MD_UNDERLINE = /__([^_\n]{1,400})__/g;
const MD_STRIKE = /~~([^~\n]{1,400})~~/g;
/* The address may hold one level of round brackets, as Wikipedia addresses do. */
const MD_LINK = /\[([^[\]\n]{1,200})\]\(((?:[^()\s]|\([^()\s]{0,100}\)){0,600})\)/g;
const HASH_RUN = /#{2,}/g;
const STAR_RUN = /\*{2,}/g;
const DOUBLED_SPACE = /[ \t]{2,}/g;
const LEADING_PER_LINE = /^[ \t]+/gm;
const BLANK_RUN = /\n{3,}/g;
const MAX_CHARS = 200000;

/**
 * What a person reads and a screen reader says. Never use this for speech: the voice needs the raw text.
 * Returns '' for no text, for text over MAX_CHARS and on any failure; the caller then sends no field
 * and the client falls back to its own sanitizer.
 */
function toReadableText(raw) {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_CHARS) {
    return '';
  }
  try {
    const held = [];
    // eslint-disable-next-line no-control-regex
    let t = raw.replace(/[\u0001\u0002]/g, '');
    if (t.indexOf('`') !== -1) {
      t = t.replace(CODE_SPAN, (code) => {
        held.push(code);
        return '\u0001' + (held.length - 1) + '\u0002';
      });
    }
    if (t.indexOf('[[') !== -1) {
      t = t.replace(SCENE_TAG, '$1: ');
    }
    t = stripSteeringTags(t, '');
    t = t
      .replace(GAME_SOUND, '')
      .replace(GAME_TABLE, '')
      .replace(DEEP_THINK, '')
      .replace(INSTANT, '');
    t = t
      .replace(LITERAL_CITATION, '')
      .replace(PUA_CITATION, '')
      .replace(ORPHAN_ANCHOR, '')
      .replace(SPECIAL_TOKEN, '');
    if (/[#*]|__|~~|\]\(/.test(t)) {
      t = t
        .split('\n')
        .map((line) => line.replace(MD_HEADER, '').replace(MD_BULLET, ''))
        .join('\n');
      t = t
        .replace(MD_BOLD, '$1')
        .replace(MD_ITALIC, '$1$2')
        .replace(MD_UNDERLINE, '$1')
        .replace(MD_STRIKE, '$1')
        .replace(MD_LINK, '$1')
        .replace(HASH_RUN, '')
        .replace(STAR_RUN, '');
    }
    t = t
      .replace(DOUBLED_SPACE, ' ')
      .replace(LEADING_PER_LINE, '')
      .replace(BLANK_RUN, '\n\n')
      .trim();
    if (!held.length) {
      return t;
    }
    return t.replace(HELD_CODE, (whole, n) =>
      held[Number(n)] !== undefined ? held[Number(n)] : whole,
    );
  } catch {
    return '';
  }
}

/** The text a client shows for one saved message: text parts joined, else `text`. */
function messageBodyText(message) {
  if (!message) {
    return '';
  }
  if (Array.isArray(message.content) && message.content.length) {
    const joined = message.content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string' && part.text)
      .map((part) => part.text)
      .join('\n\n');
    if (joined) {
      return joined;
    }
  }
  return typeof message.text === 'string' ? message.text : '';
}

/** Adds `kade.readableText` to a copy of the message when there is text. Additive. Fail-soft. */
function withReadableText(message) {
  try {
    if (process.env.KADE_READABLE_TEXT === '0') {
      return message;
    }
    if (!message || typeof message !== 'object') {
      return message;
    }
    const readableText = toReadableText(messageBodyText(message));
    if (!readableText) {
      return message;
    }
    return { ...message, kade: { ...(message.kade || {}), readableText } };
  } catch {
    return message;
  }
}

module.exports = { toReadableText, messageBodyText, withReadableText, MAX_CHARS };
