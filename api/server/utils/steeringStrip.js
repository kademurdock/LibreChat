'use strict';
/* KADE Nov 7 2026 — TAKE A %%%STEERING TAG%%% OUT OF TEXT BY STRUCTURE, NOT BY POSITION.
 *
 * The three rooms (the Debate Room's cleanReply, the Lounge narrator, the Game Parlor) took the tags out of a
 * model's reply with `.replace(/%%%[^%]*%%%/g, ' ')`, which pairs percent-sign runs from left to right. One
 * stray run turns that around for the rest of the reply. Kade's Nov 6 report (a voice reading its own stage
 * direction aloud) came from exactly this shape:
 *     Two different problems.\n\n%%%\n%%%warm and curious%%% So what is the shape of it?
 * an empty `%%%` line in front of the real tag. By position the stray pairs with the real opener, the real
 * closer is left over, and what stays on the screen (and goes to the voice) is
 *     warm and curious%%% So what is the shape of it?
 * Every later tag in the reply flips the same way.
 *
 * So the pairing is decided first, the way the voice proxy decides it (inworld-tts-proxy steering-balance.js,
 * rules and known limits in its header): runs are judged by SHAPE, hugging pairs are tags, strays are dropped
 * and never spoken, a tag the model forgot to close is closed, a stray `%%%` line never swallows speech. What
 * is left is only well-formed `%%%direction%%%` tags, which the plain pattern then removes, so the room shows
 * exactly the words the voice would speak.
 *
 * steeringBalance.js is a BYTE-FOR-BYTE copy of that proxy file (proxy commit f4bf9c3, sha256 pinned in
 * steeringStrip.nodetest.js). Do not edit it here: change the proxy's, run its test suite and mutation sweep,
 * and copy it over. KADE_STEERING_BALANCE=0 on the website service switches the structure pass off here too
 * (exactly the old pairing); any failure inside it falls back to the old pairing as well.
 *
 * Text with no run of two or more percent signs is returned as it came (the old pattern could not match it). */

const { balanceSteeringRuns } = require('./steeringBalance');

const PAIR = /%%%[^%]*%%%/g;
const ANY_RUN = /%{2,}/g;

/**
 * Remove every %%%steering tag%%% (delimiters and the words between them) and every stray delimiter run.
 * @param {string} text
 * @param {string} [replacement=' '] - what a removed tag becomes (the rooms use a space and collapse blanks after)
 * @returns {string}
 */
function stripSteeringTags(text, replacement = ' ') {
  const raw = typeof text === 'string' ? text : text == null ? '' : String(text);
  if (raw.indexOf('%%') === -1) {
    return raw;
  }
  if (process.env.KADE_STEERING_BALANCE === '0') {
    return raw.replace(PAIR, replacement);
  }
  let balanced;
  try {
    balanced = balanceSteeringRuns(raw);
  } catch (error) {
    return raw.replace(PAIR, replacement);
  }
  // (a stray run the pass left behind, which it should not, never stays on the screen either)
  return balanced.replace(PAIR, replacement).replace(ANY_RUN, '');
}

module.exports = { stripSteeringTags };
