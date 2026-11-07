'use strict';
/* Nov 6 2026 — A STRAY %%% MUST NOT TURN THE NEXT TAG INTO SPEECH.
 *
 * Kade, about the last message Kiana sent her: the voice said "warm and curious" out loud. The message had
 *     ... Two different problems.\n\n%%%\n%%%warm and curious%%% So what's the shape of it?
 * an empty `%%%` line and then the real tag. applySteeringTags pairs `%%%` runs left to right, so the stray
 * one paired with the real tag's OPENER (what sat between them was a newline, which converts to nothing)
 * and the real tag's CLOSER was left over: its words stayed in the text, the sweep removed the delimiters,
 * and the carry-forward stamped the previous direction in front, which the live log showed as
 *     [to correct with respect] warm and curious So what's the shape of it?
 * Every later tag in that message would have flipped the same way. It is the old "slightly amused" disease
 * (Aug 20) in a shape the July and August guards did not cover: they all assume the runs come in pairs.
 *
 * So decide the pairing once, here, before anything pairs by position. Prose is never touched except for the
 * stray runs and the words of tags; a bare single % (a real percentage) is not a run and is left alone.
 * What is left is exactly the well-formed `%%%direction%%%` shape the rest of applySteeringTags converts.
 *
 * HOW A PAIR IS DECIDED (walking the runs left to right). The first version of this file judged every pair by
 * its words, and a red team showed that was the wrong way round: when it rejected a perfectly good
 * `%%%excited!%%%`, both runs became strays, the direction was spoken, and the freed closer paired with the
 * NEXT opener, which was the original bug again. Real directions are short lowercase phrases (the live corpus:
 * 7,148 of them, none with a capital, a full stop, ? or !), so the words are only a tie-breaker.
 *   1. HUGGING WINS. When the opener touches its first word and the closer touches its last, it is a tag
 *      whatever the words are: `!`, `?`, abbreviations, `hmm...`, two short sentences, other alphabets, a
 *      couple of lines, up to 400 characters. That is the shape the old pairing always accepted.
 *   2. A LOOSE SPAN (space or a line break on a side) is where "stray or tag" is a real question, so the words
 *      have to look like a direction: at most 24 words and 200 characters, one line (or a fence: `%%%` alone
 *      at the end of its line, the direction on the next, `%%%` alone again, up to three lines), and not
 *      several sentences (an abbreviation's full stop ends no sentence in a lowercase span, so a padded
 *      `%%% gentle Mr. Rogers voice %%%` stays a tag as the old pairing had it, and does end one in a capitalised
 *      span: `%%% Dr. Smith went home today. %%%` is speech). A capitalised full-stop sentence or a question or
 *      exclamation of three words or more, standing on a line next to a run (`%%\nThat is on me.\n%%`, the way
 *      strays and separators land) or, when capitalised, closed by a run that opens another tag, is speech. A
 *      capitalised line next to a run is speech too when the reply writes tight tags, when the line is a
 *      sentence, a question or three words (`%%%\nYes.\n%%%`, `%%%\nGood morning Sam`), or when only one side of
 *      it is a line break (`Hi.%%%\nHello there %%%`: a fence has a break on BOTH sides); a short unpunctuated
 *      one inside a fence in a reply with no tight tag (`%%%\nWhispering\n%%%`) is a model that fences and
 *      capitalises, so a direction. "Capitalised" includes a capital behind an opening quote, bracket or
 *      inverted mark.
 *      Anything shorter (`%%% Warm and curious. %%%`) is only SUSPECT: still a direction unless something
 *      believable follows (rule 4). A fragment that ends in a full stop is suspect whatever its first letter
 *      (none of the 7,148 real directions does): a stray in the middle of a sentence leaves `and look.` behind.
 *   3. POLARITY. A run with a space before it and a word right after it (` %%%wry`) is shaped like an opener,
 *      so it cannot be the closer of the loose span in front of it when it really does open a tag of its own.
 *      That is what lets a spare `%%% ` in front of a tag be a stray instead of swallowing the tag's opener.
 *   4. A SUSPECT span gives way to the pair after it when that pair is a believable direction, and to the
 *      reply's own style: a model is consistent inside one reply, so when the reply writes any canonical tag
 *      that hugs its words (`%%%pleased%%%`), a loose speech-like span of four words or more between two runs
 *      is two strays around a sentence, not a capitalised padded direction (shorter ones, `%%% Warm. %%%`, stay
 *      tags). A reply that pads EVERY tag keeps its padded tags. A following span that is itself prose, a
 *      sentence or a dozen words, never counts as a believable direction. A loose span that is really
 *      `<a few lowercase words> <a capitalised sentence>.` (`%%%amused Thanks.`) is a forgotten closer with its
 *      speech. A run of exactly two percent signs pairs only the way the old typo normaliser did: on one line,
 *      within 160 characters, the opener hugging a first word that starts with a letter or digit, and a letter
 *      somewhere in it (`half%% of it, then %% some`, `Yes%%%. Yeah,%%` and two doubled strays far apart are
 *      prose; the old normaliser knew ASCII letters only, a word in any alphabet counts here).
 *   5. A run of six or more percent signs that no word touches on its right is an empty tag and is dropped
 *      whole, as the old pairing dropped it. One that a word touches on its right is strays glued to an
 *      opener. As a closer it closes with its first three and the rest is a new opener (two tags touching),
 *      unless the tag hugs its words and no word touches the run on its right: then the whole run is a long
 *      closer (`%%%happy%%%%%%% Yes.%%%` must not turn "Yes." into a tag). Exactly six signs are also what two
 *      touching tags make when the second is padded or fenced, so six stay closer + opener when a believable
 *      lowercase direction follows (`%%%sad%%%%%% curious %%% Yes.`) and are a long closer when speech does or
 *      when what follows starts with a capital (`%%%warm%%%%%% How far%%%%% back`: a stray inside the speech must
 *      not turn "How far" into a tag).
 *      Two runs with nothing but blanks, line breaks or marks (no letter or digit) between them are an empty tag
 *      too when the second does not touch a word and a space and anything but a lowercase letter follows it: the
 *      old pairing dropped that pair, and it is the iPhone's re-stamped bare newline (`%%%\n%%% See you soon.`),
 *      whose second run ends the stamp and must not open a padded tag around the sentence after it, so that a
 *      stray later in the piece closes it and swallows the sentence. (A lowercase start stays a padded direction:
 *      `%%%\n%%% a little amused %%% Hello there.` is repaired.) A pair of three-sign runs round a short body with
 *      no letter in it (`%%%...%%%`, `%%%?!%%%`, `%%%3%%%`) is an empty tag too, as the old pairing had it.
 *   6. A tag the model forgot to close is still a direction and is closed for it: at the start of a sentence with
 *      speech right after one to four lowercase words (`%%%warm Hello there.`; a comma, colon or lone % typed
 *      after the words goes with them, a full stop does not: that is a sentence; a line start is a sentence
 *      start only when the line before did not end in a letter or a comma, or a blank line came between), or alone
 *      on a short line
 *      that is lowercase and hugged by its run (`%%%warm and curious` then a line break). The words must not
 *      start like speech (`yeah`, `okay`, `you`, `what`, `sorry`). A stray glued to speech looks the same, so a
 *      capitalised line is never taken for a direction, nor a line with a capital anywhere in it (the speech runs
 *      on after the words: `%%%fond and a little emotional She walked in`), nor a line the run does not hug
 *      (`%%% Talk soon`: the bare closer a chunker leaves at the start of a piece, or the iPhone's re-stamped
 *      `%%%\n%%%` in front of a piece), nor one that starts with a digit or punctuation. The whole-line rule takes
 *      plain lowercase words only (ASCII letters, digits, commas, apostrophes, hyphens: a dash, a bracket, an
 *      accent or an emoji means the speech runs on), ten words at most (the longest real direction): swallowing a line of speech
 *      loses all of it, while leaving a direction unclosed only speaks its words, as the old pairing did. A line
 *      that ends the text counts too: it is far more often the head of a tag a chunker cut off than speech.
 *   7. THE TAIL OF A CUT TAG. The apps send replies in pieces, and the website's auto-play chunker cuts inside a
 *      tag in 1.5 to 3 percent of tagged replies; the second request then starts `curious%%% So what is the
 *      shape of it?` and the direction would be spoken. A closer with no opener, at the very start of the text,
 *      after at most twelve lowercase words with no punctuation, and followed by a capital or a line break (the
 *      speech a tag leads into: `see you%%% soon.` is speech with a stray in it), is the end of a direction (or
 *      a forgotten opener, the same shape) and becomes a tag. Interjections (yeah, okay, hello ...) are not.
 *      A lone `%` that is the first or last thing in the text (a cut between the percent signs of a delimiter) is
 *      dropped first. In a text that holds a `%%` run (the first piece of a reply starts with a tag) it goes unless a
 *      number (digits, fractions or words, a blank or two between) stands before it at the end, or a digit follows
 *      it at the start; a lone `%` alone on a line goes too. A text with no `%%` run is ordinary text and keeps its
 *      `%` (`The percent sign is %`, `%PATH%`, `%d items left`) unless a cut delimiter's rest is the likelier
 *      reading: at the start before a blank and a capital (`% So what is the shape of it?`), at the end after a
 *      sentence end or a line break (`Two different problems.\n\n%`). applySteeringTags hands any text with a `%`
 *      in it to this function, which returns a text without a `%%` run right after that step.
 * A dropped stray between two words leaves a space so the words do not fuse (`hope%%%you` -> `hope you`). A stray alone
 * on its line between two lines of text takes its line with it, so the reply keeps the paragraphs it had (a blank line
 * left there is a paragraph break the reply never had, and it moved the carry-forward cap of the paragraphs after it by
 * one); next to a blank line, or at an end of the text, it leaves what it always left.
 * KILL SWITCH: KADE_STEERING_BALANCE=0 (a Railway variable and a redeploy) hands every text on untouched, which
 * is exactly the old left-to-right pairing. Texts over 150,000 characters are handed on untouched too.
 *
 * KNOWN LIMITS (almost all of them are the old pairing's too; none shows up in the real traffic, whose 7,148 tags
 * are all tight, lowercase and at a paragraph start):
 *   - two independent strays on one line around one short sentence read as a padded tag and swallow it, in a
 *     reply that pads every tag, in a tight reply when the sentence is three words or fewer, in a reply with no
 *     tag at all (`Hello. %%% Yeah, you are right. %%% Bye.`), and for a lowercase one-word fragment; so does a
 *     lowercase sentence that holds an abbreviation (`%%% hello Mr. Smith, I said so today. %%%`, whose full
 *     stop is not counted); three or more strays in one reply, and strays of six or more percent signs glued to
 *     words, can swallow words too (the worst of them leaves a short reply silent: `%%%good natured%%%%%%%% %%% Oh. %%%`);
 *   - a forgotten closer followed by a direction of more than four words, or by lowercase speech, is left as it
 *     was (the direction words are spoken, no speech is lost) except where the whole line passes the line rule:
 *     plain lowercase words, ten at most, nothing else on the line. Such a line is closed as a direction and not
 *     spoken, and a stray glued to a line of lowercase speech has the same shape (`%%%warm 5 more minutes`,
 *     `%%%warm and so then we went home`); a forgotten OPENER is repaired only at the very start of the text,
 *     not at a later paragraph;
 *   - a capitalised direction of three words or more, or in a reply with tight tags, alone in a fence reads as
 *     speech (`%%%\nWarm\n%%%` in a tight reply), and so does a lowercase question or exclamation of three words
 *     or more in a fence or half fence, a line break on either side (`%%%\nreally excited now!\n%%%`,
 *     `%%%warm and easy!\n%%% You made it.`); a tight direction past 70 words or 400 characters is not one;
 *   - a run that has a space before it and a word right after it opens a tag, so in a reply that pads its tags
 *     speech glued to a closer breaks the pairing (`%%% quietly %%%Not a chance.%%% thoughtful %%% Hello.`); and
 *     the other way round, a stray line, a lowercase unpunctuated speech line and then a tight tag whose closer
 *     is glued to the next word (`%%%resolved%%%The paper trail`) pair the stray with the tag's opener;
 *   - a padded or fenced direction of more than 24 words or 200 characters is not one (the old pairing took any
 *     length), so a long lowercase unpunctuated speech line of up to 24 words between two stray lines is read as
 *     a fenced direction; real directions are at most ten words;
 *   - a text that starts or ends with a lone % that has no number before it (`x%`, `one third %`, `%s is the
 *     placeholder`) loses the sign, and `In 2019 %` cut after the first sign of the next tag's opener still says
 *     "percent" (normalizeForSpeech has already turned `2019 %` into `2019 percent`);
 *   - a lowercase phrase of up to twelve words at the very start of a text, a stray glued to its last word and a
 *     capital after it (`sounds good to me%%% Kade, I will do it.`) reads as the tail of a cut tag;
 *   - a piece cut off inside the first word of a direction (`%%%she` from "sheepish") is read as speech;
 *   - the tail of a cut tag is repaired only when it starts the text: behind the iPhone's re-stamp
 *     (`%%%pleased%%% curious%%% So what now?`) the direction word is spoken, and so is the head of a tag cut off
 *     in the middle of a paragraph (`I sat down, %%%wry`);
 *   - an iPhone re-stamp the phone built from a wrongly paired stray (it then carries speech as the direction:
 *     a paragraph of 400 to 600 characters, or a sentence inside a ragged `%%%% ... %%%` delimiter) is not a tag
 *     here, so the speech is spoken a second time; after the re-stamped bare newline a fragment that starts
 *     with a lowercase letter, an ellipsis or a dash, with a later stray in the piece, is swallowed as a padded
 *     tag (`%%%\n%%% and then quietly she left %%%`, `%%%\n%%% and the rest were in the laundry.\n\n%%%\nThe
 *     reunion...`); the phone should carry no direction that is longer than a few words, holds a sentence stop
 *     or a %, or is only a line break;
 *   - a padded lowercase direction that ends in a full stop (any length), followed by short unpunctuated speech
 *     and another tag (`%%% soft and slow. %%% Hello there %%% dry. %%% Okay`), is read as speech, and in a reply
 *     that also writes a tight tag so is a padded lowercase direction of four words or more that ends in . ! or ?;
 *     a direction that names a person and ends in a full stop, padded on its right
 *     (`%%%zqaa, like talking to Kade. %%% Hello`), has the shape of a forgotten closer plus its speech and is
 *     cut at the name; in a reply that pads every tag a padded direction that starts with a capital, a quote or a
 *     digit right behind the iPhone's re-stamp is dropped with it; and a line that
 *     starts with a symbol and ends in a full stop between two stray lines, and a line in a script without
 *     capitals (CJK, Arabic, Hebrew) there is read as a direction; a first word of 41 or more letters after a
 *     forgotten closer is not recognised;
 *   - a six-percent stray glued to a padded or fenced opener (`%%%%%% a little amused %%%`) is an empty tag, so
 *     the padded words are spoken (the old pairing speaks them too);
 *   - glued tags with a 4- or 5-percent junction are one closer; a direction that wraps onto a second line with
 *     a space on only one side is not a tag;
 *   - a doubled `%%` run pairs only the way the old typo normaliser paired it, on one line, so a direction closed
 *     by `%%` alone on the next line (`%%%like she is sharing a secret\n%%`) is not a tag; the first version
 *     paired it, and the strictness is what keeps `half%% of it, then %% some` prose;
 *   - a stray line alone between a line that ends in a letter or a comma and a tag whose closer was forgotten
 *     (`Dear Kade,` / `%%%` / `%%%pleased Thanks for coming over.`) leaves the tag unclosed, so its words are spoken: exactly
 *     what the same reply WITHOUT the stray line does. The blank line such a stray used to leave once closed it by accident
 *     (before e936b4d), and it is not remembered on purpose: remembering it (a `strayBreak` flag was built and measured) also
 *     closes `%%%not Kade who called, it was Kiana.` after `I told her it was` + a stray line, which swallows the word "not"
 *     and flips the sentence, and the forgotten-closer rule cannot tell the two apart without a vocabulary. Swallowing speech
 *     is worse than speaking a direction word, the rule of this file; stray lines in real traffic follow a sentence end or a
 *     blank line, where nothing is lost either way;
 *   - a tag-only line, a stray line and another tag (`%%%cool%%%` / `%%%` / `%%%warm%%% Second thing.`) read as ONE paragraph
 *     once the stray's line is gone, which is what they are without the stray: applySteeringTags sends both cues where the
 *     blank line used to make the first a direction-only paragraph that it drops;
 *   - a stray between two letters becomes a space, so a stray inside a word splits it (`hope%%%you` is `hope
 *     you`, and `No%%%t` is `No t`); next to an apostrophe or a hyphen inside a word it just vanishes
 *     (`you'%%%re`, `well-%%%known`). */

const TAG_MAX = 200;        // a loose direction, trimmed; the old normalizer capped at 160 and layered ones grew past it
const TIGHT_MAX = 400;      // a direction whose delimiters hug its words
const WORDS_MAX = 24;
const TIGHT_WORDS_MAX = 70;
const LINE_MAX = 80;        // an unclosed tag line is a few words, never a sentence
const LETTER = /\p{L}/u;
const BOUNDARY = /[.!?]["'”’)]*\s+["“‘'(¿¡]?\p{Lu}/u; // a sentence ends and another starts
const ABBREVIATION = /\b(Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|vs|etc|No)\./g;               // their full stops are not sentence ends
const spaceAt = (s, i) => i < 0 || i >= s.length || /\s/.test(s[i]);
const wordCount = (t) => t.split(/\s+/).length;

/** Is the text between two runs a direction? { body, speechy } or null.
 *  `speechy`: the words are acceptable as a direction but read like speech (a capitalised full-stop sentence,
 *  a question or exclamation, two short sentences). The caller accepts such a span only when the pair that
 *  follows is not a believable direction instead. */
function judgeBody(between, closerOpens, replyTight) {
  if (between.length === 0 || between.length > TIGHT_MAX + 60) return null;
  const t = between.trim();
  if (!LETTER.test(t)) return null;
  const lines = t.split(/\r?\n/).length;
  if (lines > 3) return null;
  const tight = !/^\s/.test(between) && !/\s$/.test(between);
  const n = wordCount(t);
  // (a quote, bracket or inverted mark in front of the first letter changes nothing: `¿Qué tal?` is as much speech
  // as `Que tal?`; a tight span ignores all of this anyway)
  const capitalLed = /^["“‘'(¿¡]*\p{Lu}/u.test(t);
  // An abbreviation's full stop is not a sentence end in a lowercase span: `%%% gentle Mr. Rogers voice %%%` was a
  // tag for the old pairing, and this must never be worse than that. In a capitalised span it is: no real
  // direction has a capital, and `%%% Dr. Smith went home today. %%%` between two strays is speech.
  const boundary = BOUNDARY.test(capitalLed ? t : t.replace(ABBREVIATION, '$1'));
  const sentence = capitalLed && /(?:^|[^.])\.["'”’)]*$/.test(t);
  const query = /[?!]["'”’)]*$/.test(t);
  // prose, not a direction, whatever its delimiters look like: a sentence or more, or a long run of words
  const proseLike = ((boundary || sentence || query) && n >= 4) || n >= 12;
  let speechy = false;
  if (!tight) {
    // the stray-or-tag question is real here: the words have to look like a direction
    if (t.length > TAG_MAX || n > WORDS_MAX) return null;
    // a fence: the opener alone at the end of its line and the closer alone at the start of one
    const fence = /^[ \t]*\r?\n/.test(between) && /\r?\n[ \t]*$/.test(between);
    if (lines > 1 && !fence) return null; // more than one line only inside a fence
    // Real directions are short lowercase phrases (the live corpus: 7,148 of them, none with a capital, a full
    // stop, ? or !), so a capitalised full-stop sentence, a question or an exclamation between loose runs is
    // suspect. Three words of it standing on a line next to a run (`%%\nThat is on me.\n%%`, the way strays and
    // separators land) is speech, and so are several real sentences in a row. Anything shorter is only SUSPECT:
    // `%%% Warm and curious. %%%` and `%%%\nwhispering?\n%%%` are still directions unless a believable
    // direction follows (see the caller).
    const lineSide = /^[ \t]*\r?\n/.test(between) || /\r?\n[ \t]*$/.test(between);
    // whatever its first letter, a fragment that ends in a full stop is no direction (none of the 7,148 real ones
    // does): a stray in the middle of a sentence leaves `and look.` behind, and that must not pair with a later tag
    const endsInStop = /(?:^|[^.])\.["'”’)]*$/.test(t);
    if (boundary && n >= 4) return null;
    // (a closer that opens the next tag only counts against a capitalised span: `%%% so very excited! %%%Hello`
    // is a lowercase direction closed with a space before the closer, which the old pairing took for a tag)
    if (((closerOpens && capitalLed) || lineSide) && (sentence || query) && n >= 3) return null;
    // A capitalised line standing next to a run on its own line is speech (`%%%\nYes.\n%%%`, `%%%\nGood morning Sam`;
    // none of the 7,148 real directions starts with a capital) when the reply already writes tight tags, or when
    // the line is a sentence, a question or three words or more, or when only one side of it is a line break
    // (`Hi.%%%\nHello there %%%`: a fence has a line break on BOTH sides). A short unpunctuated capitalised fence
    // body in a reply with no tight tag (`%%%\nWhispering\n%%%`) is a model that fences and capitalises: still a
    // direction.
    if (lineSide && capitalLed && (!fence || replyTight || endsInStop || query || n >= 3)) return null;
    speechy = boundary || sentence || endsInStop || query;
  } else if (t.length > TIGHT_MAX || n > TIGHT_WORDS_MAX) {
    return null;
  }
  // a lone % at either edge of the body would be emitted as a fourth percent sign of the delimiter (`%%%ok% %%%`)
  const body = (lines > 1 ? t.replace(/\s*\r?\n\s*/g, ' ') : t).replace(/^%+|%+$/g, '').trim();
  return body ? { body, speechy, proseLike, tight, words: n } : null;
}

/** The direction between two runs, trimmed, or null when it cannot be one. */
function tagBody(between) {
  const j = judgeBody(between);
  return j ? j.body : null;
}

/** A tag the model opened but never closed, alone on a short line: a few plain lowercase words, no sentence end.
 *  The shape is the same as a stray glued to a line of lowercase speech, and swallowing a line of speech loses
 *  every word of it (the old pairing spoke it, with the stray swept), so the line has to look like a direction
 *  and nothing else: letters, digits, spaces, commas, apostrophes and hyphens (a capital, a dash, a bracket or an
 *  emoji means the speech runs on), ten words at most (the longest of the 7,148 real directions). A line at the
 *  very end of a text counts too, though it is as likely to be speech with a stray in front as a direction: it is far
 *  more often the head of a tag that a chunker cut off (`%%%warm and a little teas`, the whole piece), and closing
 *  that is silence, which is right. */
function unclosedLine(between) {
  const nl = between.indexOf('\n');
  const line = (nl === -1 ? between : between.slice(0, nl)).trim();
  if (!line || line.length > LINE_MAX || !LETTER.test(line)) return null;
  if (!/^[a-z][a-z0-9 ,'’-]*$/.test(line)) return null;               // (so no sentence end either: no . ! ?)
  if (wordCount(line) > 10) return null;
  return line;
}

/** A tag whose closer was forgotten, with the speech starting right after the words: `%%%warm Hello there.`
 *  One to four lowercase words, then a capital (or a quote) that starts the speech, or the end of the line,
 *  or the next run. Anything longer or all-lowercase is left alone: nothing shows where the direction ends. */
const HEAD = /^([a-z][a-z0-9'’-]{0,39}(?:,?[ \t\u00a0][a-z][a-z0-9'’-]{0,39}){0,3})([,:%]?)(?:[ \t\u00a0]*(?:\r?\n|$)|[ \t\u00a0]+(?=["“(¿¡\p{Lu}]))/u;
// A stray glued to lowercase speech has exactly the same shape (`%%%yeah Kade, ...`). What tells them apart is
// the first word: directions start with an adjective, an adverb, a verb or `to`/`a` (warm, quietly, laugh, to
// correct, a little amused); speech starts with an interjection, a pronoun or a question word.
const SPEECH_OPENERS = new Set(('yeah yes yep nope no okay ok oh ah hm hmm mm uh um huh well right so you your i i\'m i\'ll i\'ve we he she ' +
  'they it it\'s that this what why how who hello hi hey wait look listen thanks thank please honestly actually anyway maybe ' +
  'sure my me let let\'s and but because if do did can will would there here sorry alright wow ha haha aw aww ooh ouch gosh geez ' +
  'dear bye goodbye hola gracias bueno buenas buenos bien oye vale pues claro adiós adios ' +
  // (none of these starts any of the 7,148 real directions; `good` does, four times, so it is not here)
  'goodness great nice exactly definitely just now absolutely totally true really seriously basically obviously ' +
  'clearly fine cool awesome perfect wonderful lovely indeed certainly also then still yet ugh whoa yikes ' +
  'damn dang jeez man dude nah yup mhm oof like yea uhh lol lmao yay').split(' '));
const firstWord = (words) => words.split(/[\s,]/, 1)[0].replace(/’/g, "'").toLowerCase();   // any blank: a tab or a no-break space hides nothing
const startsLikeSpeech = (words) => SPEECH_OPENERS.has(firstWord(words));
/** { words, used }: the direction and how much of `between` it took (a comma, colon or lone % typed right after the
 *  words goes with them), or null. */
function unclosedHead(between) {
  const m = HEAD.exec(between);
  return m && !startsLikeSpeech(m[1]) ? { words: m[1], used: m[1].length + m[2].length } : null;
}

/** A loose span that is really `<a few lowercase words> <a capitalised sentence>.`: an unclosed direction with its
 *  speech after it (`%%%amused Thanks.`), so the run in front of the span is no opener of this span's tag. */
function headThenSentence(t) {
  const h = HEAD.exec(t);
  if (!h || startsLikeSpeech(h[1])) return false;
  const rest = t.slice(h[1].length + h[2].length).trim();
  return /^["“(¿¡]*\p{Lu}/u.test(rest) && /[.!?]["'”’)]*$/.test(rest);
}

/** A reply cut in the middle of a tag reaches the proxy as its tail (the website's auto-play chunker does this in
 *  1.5 to 3 percent of tagged replies): `curious%%% So what is the shape of it?`, a few lowercase words, a closer,
 *  and no opener anywhere before. The same shape is a forgotten opener. Only at the very start of the text, at
 *  most twelve words, no punctuation but commas, hyphens and apostrophes, and only when what follows the closer
 *  is the speech a tag leads into: a capital letter or a line break (the caller checks). Lowercase words
 *  followed by lowercase speech (`see you%%% soon.`) are speech with a stray in it, not a cut tag. */
const LEAD_TAIL = /^\s*([a-z][a-z0-9'’-]{0,39}(?:,?[ \t\u00a0][a-z][a-z0-9'’-]{0,39}){0,11})$/;
// A cut can fall between any two words of a direction, so the tail may start with `and`, `but`, `like`, `she`,
// `you`: only the interjections that begin speech and never a direction rule it out.
const CUT_SPEECH_OPENERS = new Set(('yeah yes yep nope no okay ok oh ah hm hmm mm uh um huh well right hello hi hey wait look listen ' +
  'thanks thank please sorry alright wow ha haha').split(' '));
function cutTail(lead) {
  const m = lead.length <= 120 ? LEAD_TAIL.exec(lead) : null;
  return m && !CUT_SPEECH_OPENERS.has(firstWord(m[1])) ? m[1] : null;
}

/** A cut that fell between the percent signs of a delimiter leaves ONE percent sign at an end of the piece
 *  (`%curious%%% So what now?`, `Hello there.\n\n%`). A real percentage has a number right before it, in digits
 *  or in words and with at most a blank between (`50%`, `ninety %`), so a lone percent sign that is the first or
 *  last thing in the text and has none beside it is the rest of a delimiter. (applySteeringTags hands any text
 *  with a `%` in it to the balancer, which returns it right after this step when no `%%` run is left.) */
const NUMBER_BEFORE = /(?:[\d¼½¾⅓⅔⅛]|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|half|quarter))$/i;
const BLANK = /[ \t\u00a0\u2009\u202f]/;
function trimLonePercent(s) {
  if (s.indexOf('%') === -1) return s;
  // A text with no `%%` run in it is ordinary text unless a cut delimiter left its lone % where a delimiter's rest
  // would be: before a blank and a capital at the start (`% So what is the shape of it?`), after a sentence end or
  // a line break at the end (`Two different problems.\n\n%`). `The percent sign is %`, `%PATH%`, `%d items left`
  // and a text that is only `%` stay as they are. Next to a `%%` run (the first chunk of a reply starts with a tag)
  // any lone % at an end with no number beside it is the rest of a delimiter.
  const plain = s.indexOf('%%') === -1;
  // a lone % on a line of its own is the incident's stray line one character short (`\n\n%\n%%%warm%%% Hi`)
  if (!plain) s = s.replace(/(\n)[ \t]*%[ \t]*(?=\r?\n|$)/g, '$1');      // (a first line is the start rule's)
  let a = 0;
  while (a < s.length && /\s/.test(s[a])) a += 1;
  if (s[a] === '%' && (plain ? /^[ \t]+["“‘'(¿¡]*\p{Lu}/u.test(s.slice(a + 1, a + 12)) : !/[%\d]/.test(s[a + 1] || ''))) {
    s = s.slice(0, a) + s.slice(a + 1);
  }
  let z = s.length - 1;
  while (z >= 0 && /\s/.test(s[z])) z -= 1;
  if (z >= 0 && s[z] === '%') {
    // (walk back over the blanks by hand and look at a dozen characters: a regex like /[ \t]+$/ on a text that
    // holds 100,000 blanks and then a letter takes minutes, and every text with a % in it comes through here)
    let b = z;
    while (b > 0 && BLANK.test(s[b - 1])) b -= 1;
    const before = s.slice(Math.max(0, b - 12), b);
    if (!/%$/.test(before) && !NUMBER_BEFORE.test(before) && (!plain || /(?:[.!?…:]["'”’)]*|\n)$/.test(before))) {
      s = s.slice(0, z) + s.slice(z + 1);
    }
  }
  return s;
}

// Optional: a function the caller hands in to hear about repairs ({ strays, closed }), so the proxy log can
// answer "is this firing in real traffic, and how often". Nothing is logged unless a logger is set, and a
// logger that throws can never break a message.
let repairLogger = null;
function setRepairLogger(fn) { repairLogger = typeof fn === 'function' ? fn : null; }

// Nobody speaks more than this in one request (the apps cap speech at 100,000 characters; the balancer needs
// 0.15 to 0.25 ms per KB of real text and up to about 3 ms per KB of nothing but runs), and the server accepts
// bodies of 10 MB: past it the text goes on as it came, so a multi-megabyte reply of tiny runs can never hold up
// every other listener (at the limit the worst case is about half a second).
const MAX_CHARS = 150000;

function balanceSteeringRuns(text) {
  const raw = String(text == null ? '' : text);
  // Kill switch: KADE_STEERING_BALANCE=0 hands every text on untouched, which is exactly the old left-to-right
  // pairing. One Railway variable and a redeploy instead of a revert.
  if (raw.length > MAX_CHARS || process.env.KADE_STEERING_BALANCE === '0') return raw;
  const src = trimLonePercent(raw);
  if (src.indexOf('%%') === -1) return src;
  let strays = 0;         // runs dropped
  let closed = 0;         // forgotten closers closed
  const runs = [];
  for (const m of src.matchAll(/%{2,}/g)) runs.push({ start: m.index, end: m.index + m[0].length });

  const parts = [];       // the output, in pieces: appending to a string and asking for its end is quadratic on a big message
  let last = '';          // the last character written
  let lineBlank = true;   // nothing but whitespace written since the last line break
  let sigTail = '';       // the last few characters written that were not whitespace
  let tailWs = '';        // the whitespace written after them (its last few characters)
  const put = (s) => {
    if (!s) return;
    parts.push(s);
    last = s[s.length - 1];
    const nl = s.lastIndexOf('\n');
    lineBlank = nl === -1 ? lineBlank && /^\s*$/.test(s) : /^\s*$/.test(s.slice(nl + 1));
    const sig = s.trimEnd();
    if (sig) { sigTail = (sigTail + sig).slice(-3); tailWs = s.slice(sig.length).slice(-20); }
    else tailWs = (tailWs + s).slice(-20);
  };
  // a new sentence starts here: the start of a line, after . ! ? … or a colon, or right after a tag. (A line that
  // carries on a sentence the one before it left open, one that ends in a letter or a comma, is not one, unless a
  // blank line came between: a paragraph break ends whatever the paragraph before it was, `Dear Kade,\n\n%%%warm Hi`.)
  const sentenceStart = () => (lineBlank && (!/[\p{L},]$/u.test(sigTail) || /\n[ \t]*\r?\n[ \t]*$/.test(tailWs)))
    || /(?:[.!?…:]["'”’)]*|%%%)$/.test(sigTail);
  const hugsRight = (r) => !spaceAt(src, r.end);
  const hugsLeft = (r) => !spaceAt(src, r.start - 1);
  const size = (r) => r.end - r.start;

  // The message's own style. A model is consistent inside one reply: if it writes canonical tags that hug
  // their words (`%%%pleased%%%`), a loose speech-like pair elsewhere (`%%% Everybody wanted blue. %%%`) is two
  // strays around a sentence, not a capitalised padded direction. Where NO tag hugs its words the model pads
  // every tag and a capitalised one is its own style.
  let tightTags = 0;
  for (let k = 0; k + 1 < runs.length; k++) {
    if (hugsRight(runs[k]) && hugsLeft(runs[k + 1])) {
      const j = judgeBody(src.slice(runs[k].end, runs[k + 1].start));
      if (j && !j.proseLike) { tightTags += 1; k += 1; }
    }
  }

  let cursor = 0;
  let i = 0;
  // the tail of a tag cut in half by a chunker, or a forgotten opener: `curious%%% So what is the shape of it?`
  // (what follows the closer must be the speech a tag leads into: a capital letter or a line break)
  if (runs.length && size(runs[0]) <= 5 && hugsLeft(runs[0]) && !hugsRight(runs[0])
      && /^[ \t\u00a0]*(?:\r?\n|["“(\[¿¡]*\p{Lu})/u.test(src.slice(runs[0].end, runs[0].end + 8))) {
    const words = cutTail(src.slice(0, runs[0].start));
    if (words) {
      closed += 1;
      put(`%%%${words}%%%`);
      cursor = runs[0].end;
      i = 1;
    }
  }
  while (i < runs.length) {
    const run = runs[i];
    put(src.slice(cursor, run.start));
    cursor = run.start;
    const dropRun = () => { // a stray: dropped, never spoken
      strays += 1;
      cursor = run.end;
      // A stray alone on its line, between two lines of text, takes its line with it. Left behind, that line is a blank
      // one, a paragraph break the reply never had: applySteeringTags would count one paragraph more than the old pairing
      // did and the carry-forward cap would end one paragraph early. (Next to a blank line, or at an end of the text, its
      // line was a paragraph break already, or none, and what it leaves there stays as it was.)
      if (sigTail && /^[ \t]*\r?\n[ \t]*$/.test(tailWs) && /^[ \t]*\r?\n[ \t]*\S/.test(src.slice(run.end, run.end + 400))) {
        cursor = src.indexOf('\n', run.end) + 1;
        i += 1;
        return;
      }
      // two words must not fuse (but no space before punctuation: `Hello%%%, friend` is `Hello, friend`, and none
      // inside a word that has an apostrophe or a hyphen in it: `you'%%%re`, `you%%%'re`, `well-%%%known`; a closing
      // quote or a spaced dash is no such thing: `'yes'%%%Then` is two words)
      const insideWord = /[\p{L}\p{N}]['’-]$/u.test(sigTail) && /[\p{Ll}\p{N}]/u.test(src[run.end]);
      // (nor inside a number, `10%%%000`, nor before the tail of a contraction, `does%%%n't`: the old pairing glued both)
      const insideNumber = /\d/.test(last) && /\d/.test(src[run.end]);
      const contractionTail = /^n['’]t/i.test(src.slice(run.end, run.end + 3));
      if (last && !/\s/.test(last) && !spaceAt(src, run.end) && !/[,.;:!?)\]}'’-]/.test(src[run.end]) && !insideWord
          && !insideNumber && !contractionTail) put(' ');
      i += 1;
    };
    if (size(run) >= 6 && !hugsRight(run)) { dropRun(); continue; } // `%%%%%%` alone: an empty tag

    const next = runs[i + 1];
    // A pair of three-sign runs that hugs a body with no letter in it, on one line and no more than a few
    // characters (`%%%...%%%`, `%%%?!%%%`, `%%%3%%%`), is an empty tag as well: the old pairing took the body for a
    // direction that sanitises to nothing and dropped the lot, where leaving it would speak "..." or "3" (and Fish
    // would add a pause). (Both runs must hug it: `%%%. \n\n%%%quietly` is a stray and a real opener.)
    if (next && size(run) === 3 && size(next) === 3 && hugsRight(run) && hugsLeft(next)) {
      const mid = src.slice(run.end, next.start);
      if (mid.length <= 40 && mid.indexOf('\n') === -1 && !LETTER.test(mid)) {
        strays += 2;
        cursor = next.end;
        i += 2;
        continue;
      }
    }
    // An empty pair, two runs with nothing but blanks, line breaks or marks between them, is an empty tag: the old
    // pairing dropped it and so do we. The iPhone's re-stamped bare newline (`%%%\n%%% See you soon.`) is one: its
    // second run ends the stamp, it does not open a padded tag around the sentence after it, so a stray later in
    // the piece must not be allowed to close it and swallow the sentence. (A second run that hugs its words opens
    // a tag, and a run with a letter before the next one is judged below.)
    if (next && size(run) < 6 && !/[\p{L}\p{N}]/u.test(src.slice(run.end, next.start))
        && /^[ \t]+[^\p{Ll}\s]/u.test(src.slice(next.end, next.end + 12))) {
      strays += 2;
      cursor = next.end;
      i += 2;
      continue;
    }
    let body = null;
    let first = null;
    let longCloser = false;   // the run after a tag is just a long closer: nothing is left over to open the next tag
    if (next) {
      const closerOpens = size(next) < 6 && spaceAt(src, next.start - 1) && hugsRight(next);
      first = judgeBody(src.slice(run.end, next.start), closerOpens, tightTags > 0);
      body = first && first.body;
      // this reply writes tight tags: a loose sentence (four words or more) between two runs is not one
      if (body && first.speechy && first.words >= 4 && tightTags > 0) body = null;
      // The old pairing used a run of exactly two percent signs only as the typo tolerance of its normaliser: on ONE
      // line, within 160 characters, the opener hugging a first word that starts with a letter or digit, and a
      // letter somewhere in it. So a doubled percent sign in prose (`half%% of it, then %% some`), a `%%` and a
      // `%%%` on either side of a short sentence on different lines (`%%Okay.\n%%%`), two doubled strays that hug
      // words far apart (`%%there friend. ... you%% today`) and a stray glued to punctuation (`Yes%%%. Yeah,%%`)
      // never made a tag. (The old normaliser knew ASCII letters only; a word in any alphabet does here.)
      if (body && (size(run) === 2 || size(next) === 2)) {
        const span = src.slice(run.end, next.start);
        if (span.indexOf('\n') !== -1 || span.length > 160 || !/^[\p{L}\p{N}]/u.test(span) || !LETTER.test(span)) body = null;
      }
      // `%%%amused Thanks.` followed by another run: an unclosed direction with its speech, not a direction. (Only
      // when the opener hugs its words, the real forgotten-closer shape, or the reply writes tight tags, so that a
      // padded direction cannot be there: `%%% warm, like talking to Kade. %%%` in a reply that pads every tag is an
      // ordinary tag that happens to name someone.)
      if (body && !first.tight && (hugsRight(run) || tightTags > 0) && headThenSentence(first.body)) body = null;
      const after = runs[i + 2];
      if (body && after) {
        const second = judgeBody(src.slice(next.end, after.start), false, tightTags > 0);
        // POLARITY: the closer opens a tag of its own that closes tightly (its own closer is not glued to a word
        // on the right), so it cannot also close this one
        if (closerOpens && hugsLeft(after) && !hugsRight(after) && second && !second.proseLike) body = null;
        // a span that reads like speech is a tag only if the pair after it is not a believable direction instead
        else if (first.speechy && second && !second.speechy && !second.proseLike) body = null;
      }
      // A glued closer + opener: the first three close this tag, the rest start the next. But when this tag hugs
      // its words and no word touches the run on its right, the rest may have nothing to open: it is a long closer,
      // and re-queuing it as an opener would let the next stray close it around the speech after it
      // (`%%%happy%%%%%%% Yes.%%%` would lose "Yes."). Exactly six signs are the one length that two touching tags
      // also make, a padded or fenced second tag: those stay closer + opener when a believable direction follows,
      // and a direction is lowercase (speech after a tag starts with a capital: `%%%warm%%%%%% How far%%%%% back`
      // is a closer, a stray and a second stray, and must not turn "How far" into a tag).
      if (body && size(next) >= 6 && first.tight && !hugsRight(next)) {
        longCloser = true;
        if (size(next) === 6 && after) {
          const between6 = src.slice(next.end, after.start);
          const j = judgeBody(between6, false, tightTags > 0);
          if (j && !j.speechy && !j.proseLike && /^\s*\p{Ll}/u.test(between6)) longCloser = false;
        }
      }
    }
    if (body) {
      if (last === '%') put(' '); // two tags touching would be a six-percent run again, which nothing downstream can pair
      else if (last && /[\p{L}\p{N}]/u.test(last)) put(' ');   // a tag glued to the word before it: a tag that is dropped later must not fuse the words
      put(`%%%${body}%%%`);
      if (size(next) < 6 && /[\p{L}\p{N}]/u.test(src[next.end] || '')) put(' ');   // ... nor to the word after it
      if (size(next) >= 6 && !longCloser) {                 // a glued closer + opener (see above)
        runs[i + 1] = { start: next.start + 3, end: next.end };
        cursor = next.start + 3;
        i += 1;
      } else {
        cursor = next.end;
        i += 2;
      }
      continue;
    }

    // A closer forgotten where speech follows on the same line: a few lowercase words, then a capital
    // (`%%%warm Thanks Kade`). It goes first because it can tell where the direction ends; the whole-line
    // rule below would swallow a short reply that has no final full stop.
    const between = src.slice(run.end, next ? next.start : src.length);
    const head = hugsRight(run) && sentenceStart() ? unclosedHead(between) : null;
    if (head) {
      closed += 1;
      if (last === '%') put(' ');
      put(`%%%${head.words}%%%`);
      cursor = run.end + head.used;
      i += 1;
      continue;
    }
    // an unclosed tag is alone on its line: if another run sits on the same line the question is how the two
    // pair up (decided above), not whether a closer was forgotten
    let line = lineBlank && (!next || between.indexOf('\n') !== -1) ? unclosedLine(between) : null;
    // A forgotten-closer direction is lowercase and its opener hugs it (`%%%warm and curious`). So these are not
    // directions: a capitalised line or a line that starts with a digit or punctuation (`%%%Talk soon`, the
    // preparation step gluing a stray's line to `...and then`), a line the run does not hug (`%%% Talk soon` and
    // `%%% ha`: the bare closer a chunker leaves at the start of a piece, the iPhone's re-stamped `%%%\n%%%`), and
    // a line that starts like speech (`%%%yeah Thanks Kade`).
    if (line && (!hugsRight(run) || !/^[a-z]/.test(line) || startsLikeSpeech(line))) line = null;
    if (line) {
      closed += 1;
      put(`%%%${line}%%%`);
      cursor = run.end + between.indexOf(line) + line.length; // the rest of the line break stays; anything on the same line after the words is prose
      i += 1;
      continue;
    }
    dropRun();
  }
  put(src.slice(cursor));
  if (repairLogger && (strays || closed)) {
    try {
      const pending = repairLogger({ strays, closed });
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});  // an async logger's rejection too
    } catch (e) { /* a logger must never break a message */ }
  }
  return parts.join('');
}

module.exports = { balanceSteeringRuns, setRepairLogger, tagBody, unclosedLine };
