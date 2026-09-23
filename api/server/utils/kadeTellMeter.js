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
 * WHAT IS DELIBERATELY NOT COUNTED. Em dashes on their own, because this house
 * writes with them everywhere and a detector that fires on its owner's own
 * voice is noise. Long sentences, for the same reason. A single rule-of-three,
 * because people say three things in a row all the time -- it only counts from
 * the second one in the same reply, which is where it stops being speech and
 * starts being shape.
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

/* ── THE ESSAY VOICE (Sep 21 2026) ────────────────────────────────────────
 *
 * Kade, naming it far better than any taxonomy does: "there's still lots of
 * poetic ai phrasing like, that's not nothing, or just tighty little phrases
 * like that, the thing I'd want is blah blah blah, you aren't owed blah blah
 * blah, everything is just described in poetic professorial ways that don't
 * seem human [...] she just doesn't sound like a soul."
 *
 * This is a DIFFERENT animal from everything above it. "Great question" and
 * "delve" are corporate-assistant tells and the whole world already hunts
 * them. What she is describing is the register a good model reaches for when
 * you tell it to be warm and thoughtful: the literary essay. Balanced
 * clauses, the ironic understatement, the little aphorism that lands the
 * paragraph, the second-person pronouncement. It reads as WRITING. Nobody
 * talks like that, which is exactly why it does not sound like a soul, and
 * why switching models never fixed it -- every good model writes this way
 * when it is trying to be thoughtful.
 *
 * It is the hardest kind to catch, because every one of these is a real thing
 * a person could say once. The tell is DENSITY: four in one reply is an essay
 * wearing a person's clothes. So they are counted together and reported as
 * one `essay-voice` flag carrying its own count, rather than as six separate
 * ones that would swamp the rest of the meter.
 */
const ESSAY = [
  /* The ironic understatement. Her first example, verbatim. "not nothing"
   * takes any subject: the construction is the tell, not the pronoun. */
  [
    'litotes',
    new RegExp(
      String.raw`\b\w+(?:'|’)?s?\s+not\s+nothing\b` +
        String.raw`|\bno\s+small\s+(?:thing|feat|amount)\b` +
        String.raw`|\bnot\s+(?:for\s+nothing|by\s+accident|an?\s+accident)\b` +
        String.raw`|\bnot\s+unimportant\b`,
      'i',
    ),
  ],
  /* The aphorism that lands the paragraph. Case-insensitive, because it is
   * usually the first thing in a sentence -- the first version of this rule
   * had no `i` flag and silently missed every capitalised "That's the whole
   * trade", which is the exact phrasing she quoted. */
  [
    'aphorism',
    new RegExp(
      String.raw`\bthat(?:'|’)?s\s+(?:the\s+)?(?:whole\s+\w+|tell|trade|difference|job|point|part that matters)\b` +
        String.raw`|\bwhich\s+is\s+(?:exactly\s+|kind\s+of\s+)?the\s+point\b`,
      'i',
    ),
  ],
  /* X IS Y, with the verb shouted. Case-SENSITIVE on purpose: the capitals
   * are the whole tell, and lowercased it is just a sentence. */
  ['is-the', new RegExp(String.raw`\b\w+\s+IS\s+(?:the\s+)?\w+`)],
  /* The framing preamble: a sentence about the answer, before the answer. */
  [
    'preamble',
    new RegExp(
      String.raw`\bthe\s+thing\s+I(?:'|’)?d\s+\w+` +
        String.raw`|\bhere(?:'|’)?s\s+what\s+I(?:'|’)?d\b` +
        String.raw`|\bthe\s+honest\s+answer\s+is\b` +
        String.raw`|\bthe\s+real\s+question\s+is\b` +
        String.raw`|\bwhat\s+I(?:'|’)?d\s+actually\s+\w+` +
        String.raw`|\bif\s+I(?:'|’)?m\s+being\s+honest\b`,
      'i',
    ),
  ],
  /* The second-person pronouncement. Her third example. */
  [
    'pronouncement',
    new RegExp(
      /* Negative forms only. "You are owed a refund" is a person telling you
       * a fact; "you aren't owed an explanation" is the pronouncement.
       * "You're" carries no space after "you", which the first version of
       * this required and so missed half of her own example. */
      String.raw`\byou(?:\s+are|(?:'|’)re)\s+not\s+owed\b` +
        String.raw`|\byou\s+aren(?:'|’)?t\s+owed\b` +
        String.raw`|\byou\s+(?:do\s+not|don(?:'|’)?t)\s+owe\b` +
        String.raw`|\byou\s+get\s+to\s+decide\b` +
        String.raw`|\byou(?:'|’)?re\s+allowed\s+to\b` +
        String.raw`|\byou\s+do\s+not\s+have\s+to\s+earn\b`,
      'i',
    ),
  ],
  /* The comfort tag, stapled to the end of a thought. */
  ['and-thats-okay', new RegExp(String.raw`\band\s+that(?:'|’)?s\s+(?:okay|ok|fine|allowed|enough|valid)\b`, 'i')],
  /* The essayist's full stop. */
  [
    'hard-stop',
    new RegExp(
      String.raw`(?:^|[.!?]\s)(?:Full stop\.|Which is the point\.|Every single time\.|And that(?:'|’)?s the thing\.)`,
    ),
  ],
];

/* The paired em-dash appositive. A single em dash is ordinary punctuation in
 * this house and counting it would fire on its owner's own writing; a pair
 * wrapped around a clause is the essayist's aside, and two in one reply is a
 * habit rather than a sentence. */
const APPOSITIVE = new RegExp(String.raw`\s—\s[^—.!?\n]{3,80}\s—\s`, 'g');

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
 * Every essay-voice hit in one piece of prose, as {kind, sample} pairs. The
 * appositive needs two before it says anything; everything else counts once.
 * Exported on its own because it is the useful one to run over a PROMPT as
 * well as over a reply -- a house prompt written in this register teaches it.
 */
function essayVoice(body) {
  const hits = [];
  for (const [kind, re] of ESSAY) {
    const m = body.match(re);
    if (m) {
      hits.push({ kind, sample: sample(m[0]) });
    }
  }
  APPOSITIVE.lastIndex = 0;
  const asides = body.match(APPOSITIVE) || [];
  if (asides.length >= 2) {
    hits.push({ kind: 'appositive', sample: sample(asides[1]) });
  }
  return hits;
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

  /* The essay voice, reported as one flag carrying its own count so it
   * cannot swamp the rest of the line. */
  const essay = essayVoice(body);
  if (essay.length) {
    found.push({
      tell: `essay-voice(${essay.map((e) => e.kind).join('+')})`,
      sample: essay[0].sample,
    });
  }

  add('restated-question', restatesQuestion(body, opts.prompt));
  return found;
}

/** One short line for a log: "pivot,puffery" and nothing more. */
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

function measureMessage(message, opts = {}) {
  try {
    if (!message || message.isCreatedByUser || message.unfinished) return null;
    const text = typeof message.text === 'string' && message.text.trim() ? message.text :
      (Array.isArray(message.content) ? message.content : [])
        .filter((part) => part?.type === 'text')
        .map((part) => typeof part.text === 'string' ? part.text : part.text?.value || '').join('\n');
    return measure(text, opts);
  } catch (_) { return null; }
}

module.exports = { tellsIn, summarize, measure, measureMessage, prose, contentWords, essayVoice };
