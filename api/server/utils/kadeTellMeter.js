/* THE TELL METER (Part 243, Sep 21 2026) — counting what the scrubber cannot delete.
 *
 * Kade: "I would also like to continue working on better agents powered by Jev
 * in the background. Maybe help Kiana sound more like Kiana and less like an AI
 * text book with no personality and lots of tells."
 *
 * WHY A METER AND NOT MORE DELETING. stripAiTells.js already removes the tells
 * that a regex can safely CUT: a sycophancy opener, a reflexive apology, an
 * empty signpost, a canned closer. Those are phrases you can lift out and the
 * sentence still stands. Its own header says the rest is out of scope -- "
 * structure-level tells (negation pivot, cadence) are NOT touched (the prompt
 * layer owns those)" -- and it is right to say so, because the loudest tells
 * left are not removable:
 *
 *   "It's not a diner, it's a living room with a grill."
 *
 * There is no way to delete a piece of that and leave a sentence behind. The
 * prompt layer already forbids it in so many words -- KADE_STYLE_NOTE calls
 * the contrastive pivot "the #1 AI tell" -- and nothing anywhere has ever
 * checked whether the instruction worked.
 *
 * So this counts. It never edits, never blocks, never delays, and never costs
 * anything: it reads the text that is already on its way out and writes one
 * line to the log. That turns "Kiana sounds like a textbook" from a feeling
 * into a number that can go up or down after a change, which is the only way
 * anybody will ever know whether a prompt edit helped.
 *
 * WHAT IS DELIBERATELY NOT COUNTED. Em dashes, because this house writes with
 * them everywhere and a detector that fires on its owner's own voice is noise.
 * Long sentences, for the same reason. A single rule-of-three, because people
 * say three things in a row all the time -- it only counts from the second one
 * in the same reply, which is where it stops being speech and starts being
 * shape.
 *
 * Kill switch: KADE_TELL_METER=0.
 */

/* Each rule is [name, test]. A test returns null, or a sample of what it
 * caught -- the sample is what makes a log line worth reading. */

const PIVOT = [
  /\b(?:it|that|this|he|she|they|you|we|i)(?:'|’)?(?:s|re|m)?\s+(?:is\s+|are\s+|am\s+)?not\s+(?:just\s+|only\s+|merely\s+|simply\s+)?[^.!?;]{2,70}[,;]\s*(?:it|that|this|he|she|they|you|we|i)(?:'|’)?(?:s|re|m)?\s+(?:is\s+|are\s+|am\s+)?\b/i,
  /\bnot\s+(?:just|only|merely|simply)\s+[^.!?;]{2,70},?\s+but\s+(?:also\s+)?\b/i,
  /\b(?:isn|aren|wasn|weren|doesn|don)(?:'|’)t\s+(?:about\s+)?[^.!?;]{2,70}[,;—–]\s*(?:it|that|this)(?:'|’)?s\b/i,
];

/* Words that are almost never reached for by a person talking. Kept short on
 * purpose: "crucial", "vital" and "key" are ordinary English and counting them
 * would drown the signal. */
const PUFFERY =
  /\b(?:delve[sd]?|delving|tapestry|testament to|seamless(?:ly)?|game-?changer|myriad|plethora|underscor(?:e|es|ing)|multifaceted|holistic|embark(?:ing)? on|in the realm of|navigat(?:e|ing) the complexit\w*|rich tapestry|ever-?(?:changing|evolving) landscape|in today(?:'|’)s (?:world|fast-?paced world|digital age))\b/i;

const SIGNPOST =
  /(?:^|\n)\s*(?:first(?:ly)?|second(?:ly)?|third(?:ly)?|lastly|finally|moreover|furthermore|additionally|in conclusion|to sum up|in summary)\b[,:]/i;

const BULLETS = /(?:^|\n)[ \t]*(?:[-*•]\s+\S|#{1,6}\s+\S|\d+\.\s+\S)/;

const BOLD_HEADER = /(?:^|\n)\s*\*\*[^*\n]{2,60}\*\*\s*:/;

const OFFER_BAIT =
  /\b(?:would you like me to|want me to|shall i|should i|i can also|i could also|happy to)\b[^.!?]{0,80}[.!?]?\s*$/i;

const STOCK_OPENER =
  /^\s*(?:certainly|absolutely|of course|sure thing|got it|understood|happy to help|i(?:'|’)?d be happy to)\b[!.,:]/i;

const HERES_THE_THING = /(?:^|\n|[.!?]\s+)here(?:'|’)?s the thing\b/i;

const TRIAD =
  /\b([\w'’-]+(?:\s+[\w'’-]+){0,3}),\s+([\w'’-]+(?:\s+[\w'’-]+){0,3}),\s+and\s+([\w'’-]+(?:\s+[\w'’-]+){0,3})\b/gi;

/** Strip fenced code and inline code: a bulleted list inside a code block is
 *  code, and counting it would make every programming answer look like a
 *  textbook. Markdown links are text, not decoration, so they stay. */
function prose(text) {
  return String(text || '')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

function sample(match) {
  return String(match || '').replace(/\s+/g, ' ').trim().slice(0, 90);
}

const STOP = new Set([
  'about', 'after', 'again', 'their', 'there', 'these', 'those', 'which', 'would', 'could',
  'should', 'where', 'while', 'with', 'that', 'this', 'from', 'have', 'been', 'what', 'when',
  'your', 'youre', 'they', 'them', 'then', 'than', 'just', 'like', 'some', 'into', 'over',
  'because', 'really', 'thing', 'things', 'gonna', 'wanna', 'know', 'think',
]);

function contentWords(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w)),
  );
}

/** Did the reply open by saying the question back? Needs the question, so it
 *  is skipped when the caller does not have one. */
function restatesQuestion(replyProse, prompt) {
  if (!prompt) {
    return null;
  }
  const firstSentence = (replyProse.match(/^[^.!?\n]{10,220}[.!?\n]/) || [replyProse.slice(0, 220)])[0];
  const words = firstSentence.trim().split(/\s+/);
  if (words.length < 5 || words.length > 30) {
    return null;
  }
  const asked = contentWords(prompt);
  if (asked.size < 4) {
    return null;
  }
  const said = contentWords(firstSentence);
  let shared = 0;
  for (const w of said) {
    if (asked.has(w)) {
      shared++;
    }
  }
  /* Most of what they asked, handed straight back, before any answer. */
  return shared >= 4 && shared / Math.max(1, said.size) >= 0.55 ? sample(firstSentence) : null;
}

/**
 * Every tell in one assistant reply.
 *
 * @param {string} text        what the person will actually read (scrub it first)
 * @param {object} opts        { prompt } -- the user's message, for the
 *                             restatement check only. Never stored.
 * @returns {{tell: string, sample: string}[]}
 */
function tellsIn(text, opts = {}) {
  const body = prose(text);
  if (!body.trim()) {
    return [];
  }
  const found = [];
  const add = (tell, m) => {
    if (m) {
      found.push({ tell, sample: sample(Array.isArray(m) ? m[0] : m) });
    }
  };

  for (const re of PIVOT) {
    const m = body.match(re);
    if (m) {
      add('pivot', m);
      break;
    }
  }
  add('puffery', body.match(PUFFERY));
  add('signpost', body.match(SIGNPOST));
  add('bullets', body.match(BULLETS));
  add('bold-header', body.match(BOLD_HEADER));
  add('offer-bait', body.match(OFFER_BAIT));
  add('stock-opener', body.match(STOCK_OPENER));
  add('heres-the-thing', body.match(HERES_THE_THING));

  /* One rule-of-three is speech. Two in the same reply is a shape. */
  TRIAD.lastIndex = 0;
  const triads = body.match(TRIAD) || [];
  if (triads.length >= 2) {
    add('triads', triads[1]);
  }

  add('restated-question', restatesQuestion(body, opts.prompt));
  return found;
}

/** One short line for a log: "pivot,puffery(delving into)" and nothing more. */
function summarize(tells) {
  if (!tells || !tells.length) {
    return 'clean';
  }
  return tells.map((t) => t.tell).join(',');
}

/**
 * Measure a reply and hand back a log-ready line, or null when there is
 * nothing to say or the meter is off. Never throws: a measurement must not be
 * able to break a reply.
 */
function measure(text, opts = {}) {
  try {
    if (process.env.KADE_TELL_METER === '0') {
      return null;
    }
    const tells = tellsIn(text, opts);
    if (!tells.length) {
      return null;
    }
    const where = opts.agentId ? ` agent=${opts.agentId}` : '';
    return `[telltale]${where} tells=${tells.length} ${summarize(tells)} :: ${tells[0].sample}`;
  } catch (_) {
    return null;
  }
}

module.exports = { tellsIn, summarize, measure, prose, contentWords };
