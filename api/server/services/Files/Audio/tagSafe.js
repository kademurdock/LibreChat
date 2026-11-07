'use strict';
/* KADE Nov 7 2026 — A %%%STEERING TAG%%% MUST NEVER REACH THE VOICE PROXY IN PIECES.
 *
 * Kade's Nov 6 report: the voice read "warm and curious" aloud. The proxy now repairs the damage
 * (steering-balance.js), but the apps that chop a reply into pieces are what cause most of it. This is
 * the website auto-play chunker's half (createChunkProcessor in streamAudio.js).
 *
 * WHEN IT APPLIES. createChunkProcessor polls a message that may still be growing and speaks it in
 * pieces: it cuts at the last separator (. ? ! ; newline ...) and, when 20 or more characters have no
 * separator at all, it used to send the WHOLE remainder. Both cut a tag in half:
 *   - a poll that lands between a tag's opener and its closer sent `%%%warm and a little teas` and then
 *     `ing%%% So what...` (a piece that starts on a bare closer: the proxy has to guess it is a tag's tail);
 *   - a separator INSIDE a tag body (`%%%like she is sharing a secret. quietly%%%`) was a cut point.
 * (Today's website client only asks for audio after the reply is complete, so on the live path the message
 * is whole at the first poll and this code is idle; it is here for the path that cuts, and for any future
 * client that streams while the reply is written.)
 *
 * THE RULES (the same three the voice proxy's header asks of every chunker):
 *   1. HOLD BACK FROM THE LAST UNMATCHED OPENER: text from an opener whose closer has not arrived yet is
 *      not sent; the poll waits for the closer.
 *   2. IGNORE SEPARATORS INSIDE A TAG: a closed tag is never a place to cut, and neither is an open one.
 *   3. NEVER START A PIECE ON A BARE CLOSER: a cut that would leave the next piece starting with a closer
 *      (`.%%% Then`) keeps that stray run with the piece in front of it.
 *
 * HOW A RUN IS READ. Runs of three or more percent signs are walked left to right and judged by SHAPE, the
 * way the proxy's balancer does (steering-balance.js, rule 3, polarity), because counting runs (odd means
 * open) goes wrong for the rest of the reply the moment one stray run appears: Kiana's reply had an empty
 * `%%%` line in front of the real tag (`%%%\n%%%warm and curious%%% So...`), and a plain count would take
 * everything after it for tag body. A run with a space or line break before it and a word right after it
 * (` %%%warm`) is shaped like an OPENER; a run with a word right before it and a space after
 * (`curious%%% `) is shaped like a CLOSER. In a closed state a closer-shaped run is a bare closer and is
 * ignored; in an open state an opener-shaped run replaces the earlier opener (that one was a stray).
 * Everything else toggles. A run at the very end of the text, whose right side has not arrived, could be
 * either, so it is held back unless it can only close an open tag.
 *
 * A held tag is released (sent as it is, the proxy repairs it) when it cannot be a real direction: the
 * proxy accepts a tight tag up to 400 characters and a padded one up to 200, a tag never spans a blank
 * line, and a stalled message (no new text for 4 polls) is never held. A trailing `%%` (a delimiter whose
 * last sign has not arrived) is held; a trailing single `%` is held unless a digit stands before it, so
 * "50%" is never split from its number.
 *
 * Dependency-free on purpose: the tests run with plain node, and nothing here can throw (every entry point
 * falls back to "no tag found"). */

const DEFAULT_SEPARATORS = ['.', '?', '!', '۔', '。', '‥', ';', '¡', '¿', '\n', '```'];

/** A tight tag (`%%%warm%%%`) is accepted by the proxy up to 400 characters; the opener and closer add 6. */
const TIGHT_OPEN_LIMIT = 460;
/** A padded or fenced tag (`%%% warm %%%`) is accepted up to 200 characters. */
const LOOSE_OPEN_LIMIT = 220;
/** A tag body never spans a paragraph. */
const PARAGRAPH_BREAK = /\n[ \t]*\r?\n/;
const RUN = /%{3,}/g;

const isSpace = (ch) => ch !== '' && /\s/.test(ch);

/**
 * Walk the runs of `%%%` in `text` (the text that has not been sent yet).
 * @param {string} text
 * @returns {{ spans: Array<[number, number]>, openFrom: number }}
 *   spans: [start, end) of every closed tag, delimiters included.
 *   openFrom: index where an unmatched opener (or a half-arrived delimiter) starts, or -1.
 */
function scanTags(text) {
  const spans = [];
  let openAt = -1;
  let openTight = true;
  if (typeof text !== 'string' || text.indexOf('%') === -1) {
    return { spans, openFrom: -1 };
  }
  RUN.lastIndex = 0;
  let m;
  while ((m = RUN.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const before = start === 0 ? '' : text[start - 1];
    const after = end >= text.length ? '' : text[end];
    const hugsLeft = before !== '' && !isSpace(before);
    const hugsRight = after !== '' && !isSpace(after);
    const endsText = after === ''; // the right side has not arrived yet
    const openerShaped = !hugsLeft && hugsRight; // ` %%%warm`
    const closerShaped = hugsLeft && !hugsRight && !endsText; // `curious%%% `

    if (m[0].length >= 6) {
      // Two touching delimiters (or strays glued to one). Inside a tag it closes it, and a word touching
      // its right side starts the next one; with no tag open, a run no word touches is an empty tag.
      const closedHere = openAt !== -1;
      if (closedHere) {
        spans.push([openAt, end]);
        openAt = -1;
      }
      if (hugsRight || endsText) {
        openAt = closedHere ? start + 3 : start;
        openTight = true;
      }
      continue;
    }

    if (openAt === -1) {
      if (closerShaped) {
        continue; // a bare closer: a stray, nothing is open
      }
      openAt = start;
      openTight = hugsRight || endsText;
    } else if (openerShaped) {
      openAt = start; // the earlier opener was a stray; this one starts the real tag
      openTight = true;
    } else if (endsText && !hugsLeft) {
      // A padded closer or the opener of a new tag: only the next character tells which. Keep waiting
      // from the earlier opener.
    } else {
      spans.push([openAt, end]);
      openAt = -1;
    }
  }

  if (openAt !== -1) {
    const held = text.length - openAt;
    if (held > (openTight ? TIGHT_OPEN_LIMIT : LOOSE_OPEN_LIMIT) || PARAGRAPH_BREAK.test(text.slice(openAt))) {
      openAt = -1; // too long or too wide to be a direction: a stray, the proxy repairs it
    }
  }
  if (openAt === -1 && !text.endsWith('%%%')) {
    // the last sign or two of a delimiter that has not arrived yet
    const tail = /%{1,2}$/.exec(text);
    if (tail && (tail[0].length === 2 || !/\d[ \t]*$/.test(text.slice(0, tail.index)))) {
      openAt = tail.index;
    }
  }
  return { spans, openFrom: openAt };
}

/** Does a separator at [index, index + length) touch a closed tag? */
function insideSpan(spans, index, length) {
  for (const [start, end] of spans) {
    if (index < end && index + length > start) {
      return true;
    }
  }
  return false;
}

/**
 * The last separator in `text` that is not inside a tag and lies in front of any tag that is still open.
 * Same contract as librechat-data-provider's findLastSeparatorIndex (the index of the separator's first
 * character, or -1), minus the places a tag lives.
 * @param {string} text
 * @param {string[]} [separators]
 * @param {{ spans: Array<[number, number]>, openFrom: number }} [scan] - a scan of `text`, if the caller has one
 * @returns {number}
 */
function findLastSeparatorIndex(text, separators = DEFAULT_SEPARATORS, scan) {
  const { spans, openFrom } = scan || scanTags(text);
  const limit = openFrom === -1 ? text.length : openFrom;
  let last = -1;
  for (const separator of separators) {
    const from = limit - separator.length;
    if (from < 0) {
      continue;
    }
    let index = text.lastIndexOf(separator, from);
    while (index !== -1 && insideSpan(spans, index, separator.length)) {
      index = index === 0 ? -1 : text.lastIndexOf(separator, index - 1);
    }
    if (index > last) {
      last = index;
    }
  }
  return last;
}

/**
 * Where to cut after a separator so the next piece does not start on a bare closer: a stray closer-shaped
 * run (`.%%% Then`) right behind the cut stays with the piece in front of it.
 * @param {string} text
 * @param {number} cut - index just past the separator
 * @returns {number}
 */
function keepBareCloserWithPreviousPiece(text, cut) {
  RUN.lastIndex = cut;
  const m = RUN.exec(text);
  if (!m || m.index !== cut || cut === 0 || isSpace(text[cut - 1])) {
    return cut;
  }
  const end = cut + m[0].length;
  const after = end >= text.length ? '' : text[end];
  return after !== '' && isSpace(after) ? end : cut;
}

/**
 * Decide what part of the not-yet-sent text of a message that is still being written can be sent now.
 * @param {string} remaining - the text after what was already sent
 * @param {object} [options]
 * @param {string[]} [options.separators]
 * @param {number} [options.minChars=20] - text with no separator is sent whole only from this length
 * @param {boolean} [options.release=false] - never hold back (a stalled message)
 * @returns {{ send: string, held: boolean }} `send` is the text to send now ('' = wait); `held` tells that
 *   an unmatched opener is why the rest waits
 */
function planChunk(remaining, options = {}) {
  const { separators = DEFAULT_SEPARATORS, minChars = 20, release = false } = options;
  let scan = { spans: [], openFrom: -1 };
  try {
    scan = release ? { spans: scanTags(remaining).spans, openFrom: -1 } : scanTags(remaining);
  } catch (error) {
    // never let a scan failure stop the speech: fall back to cutting without tag awareness
  }
  const held = scan.openFrom !== -1;
  const sendable = held ? remaining.slice(0, scan.openFrom) : remaining;
  if (held && sendable.trim().length === 0) {
    return { send: '', held };
  }
  const separatorIndex = findLastSeparatorIndex(sendable, separators, { spans: scan.spans, openFrom: -1 });
  if (separatorIndex !== -1) {
    const cut = keepBareCloserWithPreviousPiece(remaining, separatorIndex + 1);
    return { send: remaining.slice(0, cut), held };
  }
  if (held && sendable.trim().length < minChars) {
    return { send: '', held };
  }
  return { send: sendable, held };
}

module.exports = {
  DEFAULT_SEPARATORS,
  TIGHT_OPEN_LIMIT,
  LOOSE_OPEN_LIMIT,
  scanTags,
  findLastSeparatorIndex,
  keepBareCloserWithPreviousPiece,
  planChunk,
};
