import type { IAgent } from '@librechat/data-schemas';
import { hitWritingSystem } from './hitSystem';
import { rhymeKeyOf, rhymeRelation, rhymeSyllables, rhymeWord, sameRhymeWord } from './rhyme';
import { seedWritingPrompt } from '../audio/script';

export const lyricAgentId = 'agent_9YHpms0vJoApICwshh0mR';
export const lyricWritingModel = 'openai/gpt-6.1-sol';
type Reader = (filter: { id: string }) => Promise<Pick<IAgent, 'name' | 'instructions'> | null>;
export type BoothThinkMode = 'auto' | 'low' | 'medium' | 'high';
type Request = {
  engine: string;
  mode: string;
  patient?: boolean;
  deep?: boolean;
  background?: boolean;
  deepWrite?: boolean;
  thinkMode?: BoothThinkMode;
  title?: string;
};

/* ACE-Step XL ('ace') takes the YuE2 desk path: the same song prompt, craft notes and section tags. */
const writesMusic = (request: Request): boolean =>
  ['lyria', 'yue2', 'ace'].includes(request.engine) && request.mode === 'write';

export function boothThinkMode(request: Request): BoothThinkMode {
  if (request.thinkMode) return request.thinkMode;
  return request.deep || request.deepWrite || request.background ? 'medium' : 'low';
}

export function musicWritingBackground(request: Request): boolean {
  return (
    writesMusic(request) &&
    !!(request.deep || request.deepWrite || request.background || request.thinkMode)
  );
}

export function musicWritingSettings(request: Request): {
  model: string;
  maxTokens: number;
  timeoutMs: number;
  kade_think_max_effort?: 'medium';
  reasoning?: { enabled: boolean; effort: 'low' | 'medium' | 'high'; exclude: boolean };
} {
  const thinkMode = boothThinkMode(request);
  const foregroundTimeoutMs = request.patient ? 225000 : 112000;
  const timeoutMs = musicWritingBackground(request) ? 600000 : foregroundTimeoutMs;
  return {
    model: lyricWritingModel,
    maxTokens: thinkMode === 'high' ? 65536 : 16384,
    timeoutMs,
    ...(thinkMode === 'auto'
      ? { kade_think_max_effort: 'medium' as const }
      : {
          reasoning: { enabled: true, effort: thinkMode, exclude: true },
        }),
  };
}

export const musicWritingCraft: string = `DESK NOTES FROM THE OWNER (these outrank the saved persona where they differ)
- Words the person supplied are theirs. Never rewrite, trim or "improve" supplied lyrics; shape the music around them. Preserve a supplied refrain, including its repeated words and dialect.
- SING-ALONG FIRST FOR MELODIC SONGS. The owner wants songs people can sing and recognize as lyrics on a track. Favor connected plain speech, natural stressed words, compatible phrase patterns, satisfying audible rhyme and room for the voice. The owner loves lyricism and creative rhyme. Reach for multisyllabic, mosaic and internal rhymes and for a pair nobody expects, as long as the line still means something and no grammar is bent. A rhyme that makes no sense is unfinished. Rap can keep its own density, cadence and cross-bar rhyme.
- Follow the requested subject. R&B, a soulful female voice or a decade describes the sound, not a relationship plot. Reflective songs need no invented physical scene. Write a precise feeling, choice or consequence before reaching for an object. Her named pet hates include "Everything's always a tuesday, drinks are always coffee, scenes are clean." Skip named weekdays and clock times, coffee, the porch light, the kitchen table, neon, shadows, whispers or echoes unless the brief makes them relevant. Do not substitute a stranger prop or an arbitrary birthday for a stock one. Keep every phrase understandable in ordinary language.
- The songs have been coming out thin in places. When no length is given, aim for about four minutes, 50 to 70 sung lines counting every written-out chorus, with the section sizes from the craft: a pre-chorus of four lines, a bridge of four to eight, an outro of three to six. This is a lyric budget, not measured duration. The desk draws a SECTION MAP for each song and sends it with the request, under the idea. Use that map unless the idea clearly wants another; if the brief gives its own length or structure, the brief wins and no map is sent. New verses add another thought, pressure, choice or event, not another wording of verse one. No compulsory story turn or payoff. Use the section tags the map names, each alone on its line.
- THE CHORUS STATES THE HOOK. Let the singer say the central feeling directly. Six to eight lines is a useful default, with the brief and the groove deciding the form. The hook normally lands once or twice per chorus; surrounding lines deepen or answer it. A chorus should develop beyond its title instead of exhausting itself in repeated filler. When the brief supplies repetition, a refrain, a chant, a vamp or call and response, preserve that design. A sung word repeated for emphasis is allowed. The same chorus can return unchanged.
- Trust the listener. Do not explain a joke or attach a moral to every verse. No inspirational turnaround nobody earned: grief can stay grief, anger can stay anger, and the problem can remain unresolved. Hope can be determination while things stay hard. A song about coping can contain frustration and practical choices without becoming a worksheet, sermon, superiority speech or recovery story.
- Details, humor, profanity, desire, darkness, tenderness and nonsense syllables are available when this song calls for them. Nobody needs to be a saint, and no flaw is compulsory. A funny or children's song gets real craft without compulsory melancholy. A stock kiss-off about handing back things or what the singer does not need is filler; write the actual thought instead.
- Keep the music direction outside the lyrics. The lead voice, range and delivery fit this song; there is no house voice. Each performed phrase occupies one line. A supplied refrain with several phrases can span several lines while keeping every word in order; keep its line breaks too when the person explicitly requests them. Use one blank line between sections and none between the lines within a section. BACKING VOCALS ARE PART OF THE SONG. The owner feeds these sheets to AI music generators, which sing whatever sits in parentheses as a second voice. Write them as an arranger would: after the lead phrase on the same line when the voices overlap, on their own line when the backing voice sings alone, ten to twenty-five across a full song unless the brief or the genre says otherwise, at least one in every chorus and more in the last chorus. Only sung words and syllables go in parentheses, never directions. Keep a requested riff as a separate bracket cue, with its sound described in the music direction; do not invent words to sing in its place.
- Before delivering, silently check the whole song once: the requested meaning and supplied hook survive, every phrase makes sense, the rhymes land and some of them are creative, the mouthfuls are manageable, the chorus develops, the backing parts are written, no section is thin, and the ending is believable. Repair weak lines and keep the successful ones. No example lyrics, analysis, score or promise of release quality in the output.`;

/* Part 293 (Sep 25 2026). Her words: "Chat gpt is the only model besides like
 * Grok that will cuss in lyrics when I have it write songs... Can we incorporate
 * this into the song writing features in my app". The desk wrote no swear word
 * in 1,011 lines of her songs although the hit system allows profanity: that
 * permission is one sentence in twelve thousand words, and DeepSeek wrote
 * explicit chat only once the adult note in build.js told it who was asking.
 * So the desk is now told who the song is for (api/server/utils/kadeSongAudience.js):
 * a grown-up gets the permission spelled out, the child account, the App Review
 * seat, the Kids choir style and anyone unknown get a clean note. The notes sit
 * after the owner's desk notes and before the delivery contract. */
export type SongAudience = 'explicit' | 'clean' | null;

export const SONG_EXPLICIT_NOTE: string =
  'CLEAN OR EXPLICIT: explicit is allowed. This song is for a verified grown-up on a private, invitation-only platform. Songs here can be funny, filthy, horny, furious, petty, dark, cruel, sarcastic or stupid on purpose. Cussing is fine when the song calls for it: write fuck, shit, bitch, asshole, damn and the rest in full, with no asterisks, no bleeps and no "f-ing". Sexual jokes, dark humor, petty insults and dumb immature jokes are all fair game when they suit the idea. Do not sand a line down just because a cleaner word exists. Do not force it into a song that does not want it either: swear because this singer would actually talk that way, and let it land as punctuation or as the escalation of a joke that already works. A lullaby, a hymn or a sweet song usually wants none. If the brief asks for clean, radio or kid-friendly words, write it clean. Never slurs, and nothing sexual involving anyone under 18.';

export const SONG_CLEAN_NOTE: string =
  'CLEAN OR EXPLICIT: this song must be clean. No swearing, no sexual content or innuendo, no drug jokes, nothing gory. Keep the edge and lose the words: attitude, pettiness, jokes and big feelings all still belong. Write it clean from the start instead of bleeping or starring anything out.';

const audienceNote = (audience: SongAudience | undefined): string => {
  if (audience === 'explicit') return SONG_EXPLICIT_NOTE;
  return audience === 'clean' ? SONG_CLEAN_NOTE : '';
};

/* Part 216 (Sep 19 2026). Her words: "Everything's always a tuesday, drinks are
 * always coffee, scenes are clean." The desk runs the writer on low reasoning so
 * it fits the phone's 120 seconds, which means the "revise privately" paragraph
 * above mostly does not happen. So the kill scan from her own v7 songwriting
 * system is done here, in code, on the finished draft: find the tells, and if
 * there are any, hand the writer the exact lines to replace. High precision on
 * purpose; a false alarm costs one rewritten line, a miss costs her trust. A
 * term the person used in their own brief is theirs and is never flagged. */
const NEED_PIVOT = '"I don\'t need X, I need Y"';
const LYRIC_TELLS: [string, RegExp][] = [
  ['a named weekday', /\b(?:mon|tues|wednes|thurs|fri|satur|sun)days?\b/i],
  [
    'a stock clock time',
    /\b(?:two|three|four|2|3|4)\s?a\.?\s?m\b\.?|\bmidnight\b|\bgolden hour\b/i,
  ],
  ['coffee', /\bcoffee\b|\bespresso\b|\blatte\b/i],
  ['the porch light', /\bporch ?lights?\b|\bfront porch\b/i],
  ['the kitchen table', /\bkitchen (?:table|floor|sink)\b/i],
  [
    'a stock prop',
    /\b(?:cigarettes?|ashtrays?|whiske?y|rearview|voicemails?|missed calls?|polaroids?|mixtapes?|streetlights?|headlights?|city lights)\b/i,
  ],
  [
    'neon, shadows, whispers or echoes',
    /\b(?:neon|shadows?|whisper(?:s|ed|ing)?|echo(?:es|ed|ing)?|ghosts?|embers?|ashes)\b/i,
  ],
  ['four walls', /\bfour walls\b/i],
  ['"clean" or "steady" as filler', /\b(?:clean|steady)\b/i],
  ['"scene" or "scenes"', /\bscenes?\b/i],
  ['humming', /\bhumm?(?:s|ed|ing|in['’]?)?\b/i],
  [
    '"knowing" as a mood',
    /\b(?:the|a|that|this|some) knowing\b|\bknowing (?:look|smile|glance|eyes?)\b/i,
  ],
  [
    'a stock phrase',
    /\b(?:clean slate|fresh start|moving on|turn(?:ed|ing)? the page|still standing|beautiful disaster|meant to be|what we had|weight of the world)\b/i,
  ],
  /* Part 293 (Sep 25 2026): the rest of the anti-AI list in the songwriting
   * prompt she uses with ChatGPT, where this scan had no pattern yet. Narrowed
   * where plain speech uses the same words: "found myself" only in the
   * self-discovery sense (at the end of a line), "I survived" and "I'm enough"
   * only as a declaration, "hollow" not as a place (the hollow), "unfold" not
   * when something is unfolded (the map), "heartbeat" not "in a heartbeat",
   * and "electric" never before an instrument or an everyday thing.
   * Part 293 review: narrowed again where her own register was still hit.
   * "I learned to" only with an abstract complement (let go, breathe, be
   * strong) or dangling at the end of a line, never "I learned to drive in
   * Daddy's Ford". "I'm enough" only as a declaration (end of the line, "for
   * me", "as I am"), never "I'm enough trouble". "find myself" in the present
   * only as a quest ("to find myself", "find myself again"), so an enjambed
   * "Some nights I find myself" stays. "the electric" and "electric's" are the
   * power bill, "electric blue" a colour, and pumps and lights are things.
   * "frequency" after radio, police or scanner is a dial. "hollow" stays a
   * place after the, that or this; after "a" when only a preposition, a
   * comma or the end of the line follows ("a hollow by the creek", but "a
   * hollow heart" is flagged); and after a capitalised word (Possum Hollow),
   * which needs its own pattern without the i flag. */
  [
    'a greeting-card phrase',
    /\b(?:break(?:ing|in['’]?|s)? (?:these|the|my|those) chains|war (?:inside|in) my head|battle scars?|beautiful mess|perfectly imperfect|shattered pieces|my truth|found my voice|ch(?:ose|oose|oosing) myself|finally free)\b/i,
  ],
  [
    'a lesson-learned line',
    /\bi(?:['’]ve)? learn(?:ed|t) (?:how )?to (?:let (?:it |you |them |him |her |that |this )?go|love (?:myself|me|again)|breathe|fly(?=\s*(?:[.,!?;:()—–-]|$))|stand(?: tall| on my own)?|be (?:strong|free|me|myself|okay|ok|alone|brave|enough|happy)|live (?:again|without)|walk away|move on|forgive|heal|trust (?:myself|again)|smile again|shine|rise|survive|say no)\b|\bi(?:['’]ve)? learn(?:ed|t) (?:how )?to(?=[\s.,!?;:—–-]*$)|\bnow i know\b|\bi survived(?=\s*(?:[.,!?;:()—–-]|$|it all\b|the (?:storm|fire|worst)\b))|\bi(?:['’]m| am)(?: more than| still| finally| always| already)? enough(?=\s*(?:[.,!?;:()—–-]|$)|\s+for (?:me|myself|you|anyone|them|him|her|us)\b|\s+(?:just )?as i am\b)|(?:\bfound myself|\bfinding myself|(?<=(?:\bto|\bgonna|\bgotta|['’]ll|\bwill|\bcan|\bmust|\bmight)\s)find myself|\bfind myself(?= again\b))(?: again)?(?=[\s.,!?;:—–-]*(?:\([^)]*\)[\s.,!?;:—–-]*)?$)/i,
  ],
  [
    "the desk's own filler",
    /\b(?:(?:say|said|saying) it plain|on cue|the wild part|sitt?ing pretty|sittin['’]? pretty)\b/i,
  ],
  /* Oct 8 2026: phrases the blind judges quoted again and again as the slightly-AI ones. */
  [
    'a worn phrase',
    /\broom to breathe\b|\bthe good and the bad\b|\btears in my eyes\b|\bsomewhere in between\b|\bi can care and still\b|\blearning how to\b|\b(?:find|found|finding) a better way\b|\blittle things\b|\bno slammed doors?\b|^\s*(?:and )?i almost (?:called|told|texted|said|asked|reached|picked up|dialed)\b/i,
  ],
  [
    'a worn image word',
    /\bdemons\b|\bshimmer(?:s|ed|ing)?\b|\bunfold(?:s|ed|ing)?\b(?!\s+(?:the|a|an|my|your|his|her|our|their|that|this|it|them|up)\b)|\bvalidation\b|\bvibrations?\b|(?<!\b(?:radio|police|scanner|cb|ham|fm|am|shortwave|short-wave|emergency|fire|weather)\s)\bfrequenc(?:y|ies)\b|(?<!\bin a\s)\bheartbeats?\b|(?<!\bthe\s)\belectric\b(?!['’]s\b)(?!\s+(?:guitar|piano|bass|keys|keyboard|organ|slide|bill|compan(?:y|ies)|co-?op|fence|chair|blanket|razor|can opener|drill|car|stove|fan|heater|meter|pump|light|blue|cart|bike|scooter|motor|mower|train|wire|line|pole|shock|heat|oven|range|dryer|avenue|eel|kettle|toothbrush|smoker|grill|saw|truck|boat)(?:e?s)?\b)|(?<=\bthe\s)electric(?=\s+(?:feeling|touch|spark|sparks|charge|current|air|night|energy|love|kiss|pulse|thrill|rush|chemistry|glow|buzz|tension|connection|moment|vibes?)\b)/i,
  ],
  [
    'a worn image word',
    /(?<!\b(?:[Tt]he|THE|[Tt]hat|THAT|[Tt]his|THIS|[Aa])\s)(?<![A-Z][A-Za-z'’]*\s)\bHollow(?:ness)?\b|(?<!\b(?:[Tt]he|THE|[Tt]hat|THAT|[Tt]his|THIS|[Aa])\s)\b(?:hollow(?:ness)?|HOLLOW(?:NESS)?)\b|(?<=\b[Aa]\s)(?:hollow|Hollow|HOLLOW)\b(?!['’]s\b|\s+(?:by|in|on|at|past|near|under|behind|below|beyond|where|down|up|off|out|over|beside|between|to|from|with)\b|\s*[,.;:!?)—–-]|\s*$)/,
  ],
  [
    NEED_PIVOT,
    /\bi (?:don['’]?t|do not|ain['’]?t) need\b[^.!?]*?[,;:—–-]\s*(?:but )?(?:i (?:just |only |really )?|just |only )(?:need|want)\b/i,
  ],
];

export type LyricTell = { line: string; tell: string };

/* Part 217, seen live: given an idea close to one of the system's worked
 * examples, the writer handed back that example almost word for word. The
 * examples teach; they are never output. Every example and BAD/FIX line of four
 * words or more is remembered here, and a sung line that matches one is flagged
 * like any other tell and rewritten by the audit. */
const plain = (line: string): string =>
  line
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const EXAMPLE_LINES: Set<string> = new Set(
  hitWritingSystem
    .split('\n')
    .map((line) => plain(line.replace(/^(?:BAD|FIX):\s*/, '')))
    .filter((line) => line.split(' ').length >= 4 && line.length <= 90),
);

/* Part 293 follow-up (Sep 25 2026). Tidy moral endings kept shipping after the
 * desk notes asked for none ("Turns out that I'm the lucky one", "It's the best
 * present anyway"), and the blind judges named them as why four songs lost. So
 * the commonest giveaway phrases are scanned for ONLY where a song lands: its
 * last four sung lines and the last two of its last verse. The same words
 * anywhere else in a song are ordinary speech. Each is narrowed where plain speech uses it:
 * "turns out" not when somebody turns out the lights or the town turns out,
 * "after all" only closing a clause (never "after all the chairs"), "in the
 * end" only opening or closing a clause (never "the end zone"). From the
 * re-run: anything that "turned out the best" (or fine, right...) and a line
 * that closes on "and I'm glad". */
export const ENDING_TELL = 'a tidy ending: it sums the song up, states a lesson or turns it around';
const ENDING_GIVEAWAYS: RegExp =
  /(?:^|[,;:—–-]\s*|\b(?:it|it's|it has|guess|and|but|so|well|now|oh|yeah)\s+)turn(?:s|ed)? out\b(?!\s+(?:the |my |your |his |her |our |their |that |those |these )?(?:lights?|lamps?|pockets?|porch|candles?|fire|stove|oven|burners?|gas|dogs?|cows?|horses?|cattle|goats?|chickens?)\b)|\bthe lucky ones?\b|\bafter all(?=\s*(?:[.,!?;:)—–-]|$))|(?:^|[,;:—–-]\s*|\b(?:and|but|so)\s+)in the end\b(?!\s+(?:of|zone|stall|seat|booth|row|lane|spot|slot|room|unit|table|chair|pew|bed|house|lot))|\bin the end(?=\s*(?:[.,!?;:)—–-]|$))|\band that['’]?s (?:okay|ok|o\.k\.|alright|all right|fine)\b|\bbest (?:present|gift|thing)s? (?:of all|anyway)\b|\bthat['’]?s all (?:that )?matters\b|\bwouldn['’]?t change a thing\b|\ball along(?=\s*(?:[.,!?;:)—–-]|$))|\bturn(?:s|ed)? out (?:to be )?(?:the )?(?:best|worst|greatest|luckiest|right|okay|ok|alright|all right|fine|good|great|better)\b|\band i['’]?m glad(?=\s*(?:[.,!?;:)—–-]|$))/i;

/** The sung lines of a draft (below "Lyrics:", before READBACK), in order,
 *  without section tags or whole-line parenthesised ad-libs. */
function sungLines(script: string): { line: string; section: string; pass: number }[] {
  const at = script.search(/^\s*lyrics\s*:/im);
  if (at === -1) return [];
  const out: { line: string; section: string; pass: number }[] = [];
  let section = '';
  let pass = 0;
  for (const raw of script.slice(at).split('\n').slice(1)) {
    const line = raw.trim();
    if (/^READBACK:/i.test(line)) break;
    const tag = /^\[([^\]]*)\]$/.exec(line);
    if (tag) {
      section = tag[1].trim();
      pass += 1;
    } else if (line && !/^\(.*\)$/.test(line)) out.push({ line, section, pass });
  }
  return out;
}

/** The last two sung lines of the last section whose tag matches. */
function lastOf(lines: { line: string; section: string; pass: number }[], tag: RegExp): string[] {
  let pass = -1;
  for (const l of lines) if (tag.test(l.section)) pass = l.pass;
  return pass === -1
    ? []
    : lines
        .filter((l) => l.pass === pass)
        .slice(-2)
        .map((l) => l.line);
}

const CHORUS_TAG = /^(?:final |last )?(?:chorus|hook|refrain)\b/i;

/** The lines of the last chorus pass that the first pass does not have: the line
 *  the writer changes "so it reads differently now". Measured on the re-run:
 *  that changed line is where the turnaround moved to ("...turned out the best
 *  day I had", "...but I'm glad you slid up in it"). */
function changedLastChorus(lines: { line: string; section: string; pass: number }[]): string[] {
  const passes: string[][] = [];
  let at = -1;
  for (const l of lines) {
    if (!CHORUS_TAG.test(l.section)) continue;
    if (l.pass !== at) passes.push([]);
    at = l.pass;
    passes[passes.length - 1].push(l.line);
  }
  if (passes.length < 2) return [];
  const first = new Set(passes[0]);
  return passes[passes.length - 1].filter((l) => !first.has(l));
}

/** The giveaway endings where a song lands: its last four sung lines, the last
 *  two of its last verse (measured: two of the three tidy endings that lost
 *  briefs closed the payoff verse, just before the bridge and the last chorus)
 *  and any line the last chorus changed. A phrase from the person's own brief
 *  is theirs and is never flagged. */
export function lyricEndingTells(script: string, brief = ''): LyricTell[] {
  const lines = sungLines(script);
  const scope = new Set([
    ...lines.slice(-4).map((l) => l.line),
    ...lastOf(lines, /^verse/i),
    ...changedLastChorus(lines),
  ]);
  const found: LyricTell[] = [];
  for (const { line } of lines) {
    if (!scope.has(line) || found.some((t) => t.line === line)) continue;
    const hit = ENDING_GIVEAWAYS.exec(line);
    if (!hit || brief.toLowerCase().includes(hit[0].trim().toLowerCase())) continue;
    found.push({ line, tell: ENDING_TELL });
  }
  return found;
}

/* Part 296 follow-up (Sep 27 2026). Her ear on the first songs after the chorus fix: "really
 * one of the only ai tells I could find in them was keep your... keep your this, keep your
 * that, I don't need blah blah blah... I feel like we should break those patterns specific".
 * Measured on the 73 desk songs stored that day: 12 carried one, 20 lines in all (the R&B
 * breakup brief 5 of 6 times, the car-wash quitting song 4 of 7: "You can keep the tip jar and
 * the keys", "So keep the two bucks and the chair", "Keep the ring"), and after the audit the
 * same 12 songs still did. Two kinds of line, each read one clause at a time:
 *  - THE HAND-BACK: the other person told to keep, have or take away their things, said as an
 *    order ("Keep the key", "So keep your little fine") or with you can / you could ("You
 *    can have the whole street"), including "you can keep it", "you can keep standin' there"
 *    and "take it and go".
 *  - THE CAN-DO-WITHOUT: I or we do not need something ("We don't need the lights"), the
 *    same with no subject at the start of a clause ("Don't need your pity"), anyone at all
 *    who needs no one or nothing ("She ain't needed help from nobody"), and who needs it.
 * Left alone where plain speech uses the same words: keep + an -ing word ("You keep askin'"),
 * keep with a word that says how or where ("Keep your wheels down", "Keep it goin'", "keep
 * your hands to yourself"), the idioms where keep means hold to (your word, the faith, your
 * cool), anyone keeping a thing themselves ("I keep it by my chair", "to keep it on the
 * road"), need to + a verb ("she don't need to see"), a thing nobody needed with nothing after
 * it ("a coat I didn't need"), take + a thing with no going away after it ("take the wheel";
 * it or them alone, "take it", and two things handed over in one line still count), and a
 * line that carries on the singer's own sentence above it ("I'll park it where it sat / And
 * keep the keys"). When in doubt it flags: a false alarm costs one rewritten line. Jev gets no
 * veto over these (see the route): it judges whether a line is stock, and these lines are
 * often concrete (a tip jar, the keys), which is exactly why the list could not see them. A
 * phrase from her own brief (through the thing itself), or the same move asked for in it, is
 * hers and is never flagged; a note to the writer (keep it upbeat, keep the chorus short,
 * don't need a bridge) is not asking for the move. */
export const KISS_OFF_TELL =
  'the stock kiss-off: telling them to keep, have or take back their things, or saying what the singer does not need';

const KISS_LEAD = String.raw`(?:(?:and|but|so|or|just|now|well|oh|then|hey|yeah|fine|okay|ok|please|baby|babe|honey|darlin'?|darling|girl|boy|go on(?: and)?|go ahead(?: and)?|you know what|(?:[a-z']+ )?(?:said|says|told [a-z']+|tell [a-z']+))\s+)*`;
const KISS_HAND_BACK = new RegExp(
  String.raw`^(${KISS_LEAD})(?:(you|ya|y'all|you all)\s+(?:(can|could|may|might as well|may as well|should|just|go on and|go ahead and|better|oughta|can just|could just|can go ahead and)\s+)?)?(keep|have|take)\s+(.+)$`,
);
const NEED_NOT = String.raw`(?:don't|dont|do not|ain't|aint|didn't|didnt|did not|never|no longer)\s+(?:(?:even|really|ever|never|sure|much|just|actually|honestly|truly)\s+)?need(?:ed|s)?`;
const NEED_I = new RegExp(
  String.raw`\b(?:i|we)\s+(?:(?:sure|really|just|still|even|honestly|surely)\s+)?${NEED_NOT}\b\s*(\S*)`,
);
const NEED_BARE = new RegExp(String.raw`^${KISS_LEAD}${NEED_NOT}\b\s*(\S*)`);
const NEED_NOBODY = new RegExp(
  String.raw`\b${NEED_NOT}\b(?!\s+to\b).*\b(?:no|nobody|nobody's|no one|nothin'?|nothing|none)\b`,
);
const WHO_NEEDS = new RegExp(String.raw`^${KISS_LEAD}who needs\s+(\S+)`);
/* What may follow need without it being a thing needed: need to + a verb, or a new clause
 * (a hat I didn't need and a pair of boots). */
const NEED_NOT_A_THING = new Set(
  "to from when if since until till 'til before after because 'cause cause cuz 'cuz and or but so then anyway anyhow at in on for with by of"
    .split(' ')
    .concat(''),
);
const WHO_NEEDS_NOT_A_THING = new Set(['to', 'me', 'us', 'help']);
const KISS_PRONOUNS = new Set([
  'it',
  'them',
  "'em",
  'em',
  'that',
  'this',
  'him',
  'her',
  'everything',
  'those',
  'these',
  'all',
]);
const KISS_DETS = new Set([
  'your',
  "yo'",
  'yo',
  'the',
  'all',
  'every',
  'whatever',
  'his',
  'her',
  'their',
  'those',
  'these',
  'this',
  'that',
]);
/* Words that may close a hand-back after a pronoun: "you can keep it all", "keep it for all I care". */
const KISS_TAIL = new Set([
  'all',
  'both',
  'too',
  'then',
  'now',
  'baby',
  'babe',
  'boy',
  'girl',
  'honey',
  "darlin'",
  'darlin',
  'darling',
  'anyway',
  'anyhow',
  'forever',
  'for',
  'good',
  'i',
  'care',
  'yourself',
  'yours',
]);
const NP_SKIP = new Set([
  'of',
  'the',
  'your',
  "yo'",
  'that',
  'those',
  'these',
  'this',
  'his',
  'her',
  'their',
  'damn',
]);
const NP_STOP = new Set([
  'and',
  'or',
  'but',
  'i',
  "i'm",
  "i'll",
  "i've",
  "i'd",
  "'cause",
  'cause',
  'cuz',
  "'cuz",
  'because',
  'so',
  'too',
  'then',
  'baby',
  'babe',
  'honey',
  'girl',
  'boy',
  "darlin'",
  "'til",
  'till',
  'until',
  'while',
  'you',
  'we',
  'now',
]);
/* keep + a word that says how or where it is kept is an instruction, not a hand-back. */
const KEEP_HOW = new Set(
  "down up on off in out inside outside indoors shut open closed locked low high away back to from between close closer tight clean crossed steady still warm safe straight cool calm quiet together dry busy alive awake lit level where here there near at under over around 'round round handy ready hidden happy fed honest humble hungry sharp full fresh cold hot sweet simple light real right loose free short long neat tidy strong".split(
    ' ',
  ),
);
/* keep where it means hold to, not hold on to a thing. */
const KEEP_IDIOMS = new Set(
  'word promise promises vow vows cool head balance pace faith peace beat time tempo score count track watch distance company composure wits nerve calm shape spirits chin guard lid grip footing seat place'.split(
    ' ',
  ),
);
const ING_NOUNS = new Set(
  'thing string spring wedding ceiling building feeling darling earring sibling sling swing bling offering everything nothing something anything clothing painting drawing morning evening bedding ending meeting blessing pudding stuffing filling awning lightning icing frosting topping dressing stocking sapling duckling herring sterling savings'.split(
    ' ',
  ),
);
const KEEP_DONE = new Set('swept set done paid known hid shown sworn'.split(' '));
const ED_NOUNS = new Set('speed steed greed creed breed tweed hundred'.split(' '));
/* take + a thing is a hand-back only when the thing is sent away with them, when it is it or
 * them with nothing after, or when the line hands two things over. */
const TAKE_GO = new Set(
  'go leave get git run walk split scram beat move roll head hit drive ride shove stick bounce disappear vanish'.split(
    ' ',
  ),
);
const TAKE_IDIOMS = new Set(
  'time hand word shot chance turn seat place medicine advice cue lead pick bow aim breath step stand wheel long high low back short scenic stairs stage mic floor spotlight reins heat fall blame bait cake hit call road exit'.split(
    ' ',
  ),
);
const TAKE_BARE = new Set(['it', 'them', "'em", 'em', 'everything']);
/* The words before the thing needed, so a phrase reaches the thing itself. */
const THING_DETS = new Set([
  'a',
  'an',
  'the',
  'your',
  "yo'",
  'yo',
  'his',
  'her',
  'their',
  'my',
  'no',
  'any',
  'some',
  'of',
  'nobody',
  "nobody's",
]);
/* A line that carries on the singer's own sentence from the line above: "I'll drive it once
 * around and park it where it sat / And keep the keys forever after that" is the singer keeping
 * them. Only a subject whose verb can take "and keep" after it (I, we, they, anyone's 'll or
 * 'd, gonna); "I'm leavin' / and keep the ring" is still an order. */
const GOES_ON =
  /^(?:(?:and|but|so|then|now|well|oh|yeah)\s+)*(?:i|we|they|(?:i|we|they|he|she)'(?:ll|d)|i'ma|imma|(?:i'm|we're|they're|he's|she's) (?:gonna|gon'?|fixin'? to|finna|about to|going to))(?:\s|$)/;

type KissOff = { family: string; phrase: string };

/** The clauses of one line, lower case, apostrophes straightened, punctuation gone. */
const kissClauses = (line: string): string[] =>
  line
    .replace(/[’‘`]/g, "'")
    .toLowerCase()
    .split(/[,;:!?.()"“”…]+|\s[—–-]+\s|[—–]/)
    .map((c) =>
      c
        .replace(/[^a-z0-9' ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);

/** From a need to the thing needed ("don't need your cousin's boat" -> "don't need your cousin's"). */
const throughThing = (clause: string, from: number): string => {
  const words = clause.slice(from).trim().split(' ');
  let k = words.findIndex((w) => /^need/.test(w)) + 1;
  while (k > 0 && k < words.length && THING_DETS.has(words[k])) k += 1;
  return words.slice(0, k + 1).join(' ');
};

/** The hand-back after its verb: `rest` is what follows keep, have or take; `offered` when
 *  it follows you can (you could, you might as well...). */
function handBack(verb: string, rest: string[], offered = false): string | null {
  const [first, ...after] = rest;
  if (!first) return null;
  /* Seen in the first fresh song on this desk: "You can keep standin' there". Offered, keep
   * + an -ing word is the same dismissal; said plainly (you keep askin') it is not. */
  const going = (w: string): boolean => /[a-z]{2,}(?:ing|in')$/.test(w) && !ING_NOUNS.has(w);
  if (verb === 'keep' && offered && (going(first) || (first === 'on' && going(after[0] || ''))))
    return `keep ${first}`;
  if (verb === 'take') {
    /* Seen in the fix's first songs: "Go on and take it", "Take it, I think two years is
     * enough". It or them with nothing after is the hand-over; "take it back", "take it slow"
     * and "take it or leave it" go on, and are not. */
    if (TAKE_BARE.has(first) && after.every((w) => KISS_TAIL.has(w))) return `take ${first}`;
    const pronoun = KISS_PRONOUNS.has(first);
    if (!pronoun && !KISS_DETS.has(first)) return null;
    let i = 0;
    while (i < after.length && NP_SKIP.has(after[i])) i += 1;
    if (!pronoun && TAKE_IDIOMS.has(after[i] || '')) return null;
    const near = after.slice(0, 8);
    const goes = near.some(
      (w, j) =>
        (w === 'and' && TAKE_GO.has(near[j + 1] || '')) ||
        w === 'outta' ||
        (w === 'with' && near[j + 1] === 'you') ||
        (w === 'out' && near[j + 1] === 'of') ||
        (!pronoun && ((w === 'back' && j === i + 1) || w === 'elsewhere')),
    );
    return goes ? `take ${first}` : null;
  }
  if (
    KISS_PRONOUNS.has(first) &&
    after.every((w) => KISS_TAIL.has(w) || (verb === 'have' && w === 'back'))
  )
    return `${verb} ${first}`;
  if (!KISS_DETS.has(first)) return null;
  let i = 0;
  while (i < after.length && NP_SKIP.has(after[i])) i += 1;
  const np: string[] = [];
  for (; i < after.length && np.length < 5 && !NP_STOP.has(after[i]); i++) np.push(after[i]);
  if (!np.length) return null;
  if (verb === 'keep') {
    if (KEEP_IDIOMS.has(np[0])) return null;
    /* "keep her safe", "keep that quiet": her, that and the like are the thing kept. */
    if (KISS_PRONOUNS.has(first) && KEEP_HOW.has(np[0])) return null;
    /* keep the engine running, the porch swept, the bills paid: how it is kept. */
    if (
      np
        .slice(1)
        .some(
          (w) =>
            KEEP_HOW.has(w) ||
            KEEP_DONE.has(w) ||
            going(w) ||
            (/[a-z]{3,}ed$/.test(w) && !ED_NOUNS.has(w)),
        )
    )
      return null;
  }
  return `${verb} ${first} ${np[0]}`;
}

/** Is this one sung line a stock kiss-off? Reads it a clause at a time; `previous` is the sung
 *  line above it in the same section. */
function kissOff(line: string, previous = ''): KissOff | null {
  const clauses = kissClauses(line);
  const above = /[.!?]["”')]*\s*$/.test(previous) ? '' : kissClauses(previous).pop() || '';
  const carriesOn = GOES_ON.test(above);
  let takes: string[] = [];
  for (const [n, clause] of clauses.entries()) {
    const hand = KISS_HAND_BACK.exec(clause);
    if (hand) {
      const [, lead, you, modal, verb, rest] = hand;
      /* Advice (you should keep the receipt) is not a hand-back, and "have" is one only
       * when offered (you can have it) or said bare with it or them ("Have it, I got a place
       * to be"). */
      const advice = !!modal && /^(?:should|better|oughta)$/.test(modal);
      const offered = !!you && !!modal && !advice && modal !== 'just';
      const bareHave = verb === 'have' && !you && !modal;
      const carried = n === 0 && !you && carriesOn && /^(?:(?:and|then|or)\s+)+$/.test(lead);
      if (!advice && !carried && (verb !== 'have' || offered || bareHave)) {
        const words = rest.split(' ');
        const phrase = handBack(verb, words, offered);
        if (phrase && (!bareHave || phrase.split(' ').length === 2))
          return { family: verb === 'take' ? 'take' : 'keep', phrase };
        /* A run of things handed over, each with take: "take the car, take the cable". */
        if (verb === 'take' && KISS_DETS.has(words[0])) {
          let i = 1;
          while (i < words.length && NP_SKIP.has(words[i])) i += 1;
          if (words[i] && !TAKE_IDIOMS.has(words[i]) && !NP_STOP.has(words[i]))
            takes = [...takes, `take ${words[0]} ${words[i]}`];
        }
      }
    }
    for (const pattern of [NEED_I, NEED_BARE]) {
      const hit = pattern.exec(clause);
      if (hit && !NEED_NOT_A_THING.has(hit[1]))
        return { family: 'need', phrase: throughThing(clause, hit.index) };
    }
    const nobody = NEED_NOBODY.exec(clause);
    if (nobody) return { family: 'need', phrase: nobody[0].trim() };
    const who = WHO_NEEDS.exec(clause);
    if (who && !WHO_NEEDS_NOT_A_THING.has(who[1]))
      return { family: 'need', phrase: throughThing(clause, clause.indexOf('who needs')) };
  }
  return takes.length >= 2 ? { family: 'take', phrase: takes[0] } : null;
}

/* The same move asked for in her brief, read with the same rules as a sung line: keep, have or
 * take offered or ordered (he can keep the house, tell him to take his gnomes and go, she gets
 * to keep the dog), or someone doing without (I don't need him, who needs a man), and not
 * after a no, not, never, without, avoid, stop, skip, hate or ban a few words before. A note to
 * the writer about the song itself is not the move (keep it upbeat, keep the chorus short,
 * take it slow, don't need a bridge, I don't need it to rhyme). */
const SONG_PARTS = new Set(
  'song songs chorus choruses verse verses bridge bridges hook hooks intro outro tempo beat beats rhythm lyric lyrics word words language line lines tone vibe vibes mood energy pace rhyme rhymes rhyming melody melodies vocals vocal length story theme groove bpm key drums bass guitar piano part parts ending title listener listeners audience minute minutes swearing cussing cursing profanity style genre'.split(
    ' ',
  ),
);
const OFFERED_BY = new Set(['you', 'ya', "y'all", 'he', 'she', 'they']);
const OFFER_VERBS = new Set(['can', 'could', 'may', 'gets', 'get']);
const TOLD_BY = new Set(['tell', 'tells', 'telling', 'told']);
const BRIEF_LEADS = new Set(
  'and but so just now well oh then hey yeah fine okay ok please'.split(' '),
);
const NEED_NEGATED = new Set([
  "don't",
  'dont',
  "ain't",
  'aint',
  "didn't",
  'didnt',
  'never',
  "doesn't",
  'doesnt',
  "won't",
  'wont',
]);
const NEED_SOFT = new Set(
  'even really ever never sure much just actually honestly truly'.split(' '),
);
const BRIEF_NEGATIONS = new Set([
  'no',
  'not',
  "don't",
  'dont',
  'never',
  'without',
  'avoid',
  'stop',
  'skip',
  'hate',
  'ban',
  'less',
  'fewer',
  'none',
]);

/** Her brief asks for the move at word i: its family and the word where the move starts. */
function briefMoveAt(words: string[], i: number): { family: string; start: number } | null {
  const word = words[i];
  const partAhead = (from: number): boolean =>
    words.slice(from, from + 4).some((w) => SONG_PARTS.has(w));
  if (word === 'keep' || word === 'have' || word === 'take') {
    const j = words[i - 1] === 'to' ? i - 2 : i - 1;
    let start = -1;
    let offered = false;
    if (OFFER_VERBS.has(words[j] || '') && OFFERED_BY.has(words[j - 1] || ''))
      [start, offered] = [j - 1, true];
    else if (j >= 1 && TOLD_BY.has(words[j - 1])) [start, offered] = [j - 1, true];
    else if (words.slice(0, i).every((w) => BRIEF_LEADS.has(w))) start = 0;
    if (start === -1 || (word === 'have' && !offered)) return null;
    return handBack(word, words.slice(i + 1), offered) && !partAhead(i + 1)
      ? { family: word === 'take' ? 'take' : 'keep', start }
      : null;
  }
  if (!/^need(?:s|ed)?$/.test(word)) return null;
  const j =
    !NEED_NEGATED.has(words[i - 1] || '') && NEED_SOFT.has(words[i - 1] || '') ? i - 2 : i - 1;
  let start = -1;
  if (NEED_NEGATED.has(words[j] || '')) start = j;
  else if (words[j] === 'not' && ['do', 'does', 'did'].includes(words[j - 1] || '')) start = j - 1;
  else if (words[j] === 'longer' && words[j - 1] === 'no') start = j - 1;
  else if (
    word === 'needs' &&
    words[i - 1] === 'who' &&
    words.slice(0, i - 1).every((w) => BRIEF_LEADS.has(w)) &&
    !WHO_NEEDS_NOT_A_THING.has(words[i + 1] || '')
  )
    start = i - 1;
  const next = words[i + 1] || '';
  if (
    start === -1 ||
    NEED_NOT_A_THING.has(next) ||
    partAhead(i + 1) ||
    (next === 'it' && words[i + 2] === 'to')
  )
    return null;
  return { family: 'need', start };
}

const bareWords = (text: string): string => sayable(text).split(' ').map(bare).join(' ');
const briefKissOffs = (brief: string): Set<string> => {
  const asked = new Set<string>();
  for (const sentence of String(brief || '')
    .replace(/[’‘`]/g, "'")
    .toLowerCase()
    .split(/[.!?;\n]+/)) {
    const before: string[] = [];
    for (const clause of sentence.split(/[,:()…]+|\s[—–-]+\s|[—–]/)) {
      const words = clause
        .replace(/[^a-z0-9' ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .map(bare)
        .filter(Boolean);
      for (let i = 0; i < words.length; i++) {
        const move = briefMoveAt(words, i);
        if (
          move &&
          !before
            .concat(words.slice(0, move.start))
            .slice(-6)
            .some((w) => BRIEF_NEGATIONS.has(w))
        )
          asked.add(move.family);
      }
      before.push(...words);
    }
  }
  return asked;
};

/** Part 296 follow-up: the sung lines that are a stock kiss-off, each distinct line once.
 *  Supplied lyrics never reach this; a phrase or the same move from her brief is hers. */
export function lyricKissOffTells(script: string, brief = ''): LyricTell[] {
  const asked = briefKissOffs(brief);
  const said = ` ${bareWords(brief)} `;
  const found: LyricTell[] = [];
  let above = { line: '', pass: -1 };
  for (const { line, pass } of sungLines(script)) {
    const previous = above.pass === pass ? above.line : '';
    above = { line, pass };
    if (found.some((t) => t.line === line)) continue;
    const hit = kissOff(line, previous);
    if (!hit || asked.has(hit.family)) continue;
    /* Her own phrase counts through the thing itself: "keep it" or "don't need a" alone would
     * let any line through behind her "keep it upbeat" or "I don't need a bridge". */
    const phrase = bareWords(hit.phrase).split(' ');
    const last = phrase[phrase.length - 1];
    if (
      phrase.length >= 3 &&
      !KISS_PRONOUNS.has(last) &&
      !THING_DETS.has(last) &&
      said.includes(` ${phrase.join(' ')} `)
    )
      continue;
    found.push({ line, tell: KISS_OFF_TELL });
  }
  return found;
}

/** The sung lines of a draft that lean on a stock tell. Looks only below the
 *  "Lyrics:" heading, skips section tags, and reports each distinct line once. */
export function lyricTells(script: string, brief = ''): LyricTell[] {
  const at = script.search(/^\s*lyrics\s*:/im);
  if (at === -1) return [];
  const copingBrief =
    /\b(?:coping|cope|handling stress|managing stress|patience|boundaries)\b/i.test(brief);
  const found: LyricTell[] = [];
  const seen = new Set<string>();
  const endings = new Map(lyricEndingTells(script, brief).map((t) => [t.line, t]));
  const kissOffs = new Set(lyricKissOffTells(script, brief).map((t) => t.line));
  for (const raw of script.slice(at).split('\n').slice(1)) {
    const line = raw.trim();
    if (!line || /^\[[^\]]*\]$/.test(line) || /^READBACK:/i.test(line) || seen.has(line)) continue;
    if (EXAMPLE_LINES.has(plain(line))) {
      seen.add(line);
      found.push({ line, tell: "copied from the writing system's own examples; write your own" });
      continue;
    }
    let tell = '';
    for (const [name, pattern] of LYRIC_TELLS) {
      const hit = pattern.exec(line);
      if (!hit || brief.toLowerCase().includes(hit[0].toLowerCase())) continue;
      if (
        copingBrief &&
        name === 'a lesson-learned line' &&
        /\bto (?:breathe|say no)$/i.test(hit[0])
      )
        continue;
      tell = name;
      break;
    }
    /* A kiss-off is named first: the fix is a new move, which takes a stock word out with it. */
    if (kissOffs.has(line))
      tell = tell && tell !== NEED_PIVOT ? `${KISS_OFF_TELL}, and ${tell}` : KISS_OFF_TELL;
    if (tell) {
      seen.add(line);
      found.push({ line, tell });
    }
    const ending = endings.get(line);
    if (ending && !seen.has(line)) {
      seen.add(line);
      found.push(ending);
    }
  }
  return found;
}

/** Part 293 follow-up: the lines a song ends on, pulled by the desk for the
 *  audit's ENDING gate: the last two sung lines of the song, of each chorus
 *  pass, and of the last verse and the last bridge (where the payoff lands),
 *  each distinct line once, in the order they first appear. */
export function lyricEndingLines(script: string): string[] {
  const lines = sungLines(script);
  const picked = new Set<string>([
    ...lastOf(lines, /^verse/i),
    ...lastOf(lines, /^bridge/i),
    ...changedLastChorus(lines),
  ]);
  for (let i = 0; i < lines.length; i++) {
    const { section, pass } = lines[i];
    const lastOfPass = i === lines.length - 1 || lines[i + 1].pass !== pass;
    if (lastOfPass && CHORUS_TAG.test(section)) {
      if (i > 0 && lines[i - 1].pass === pass) picked.add(lines[i - 1].line);
      picked.add(lines[i].line);
    }
  }
  for (const { line } of lines.slice(-2)) picked.add(line);
  return lines
    .map((l) => l.line)
    .filter((line, i, all) => picked.has(line) && all.indexOf(line) === i);
}

/* Part 293 follow-up (Sep 25 2026). Measured on ten briefs: with the desk's two
 * maps written into the prompt, [Final Chorus] turned up in 10 of 10 songs and 6
 * of 10 ended Verse 3 > Bridge > Final Chorus > Outro. A list of shapes in a
 * prompt reads, at low reasoning, as one shape. So the desk draws ONE real map
 * per request in code, from a seeded random over the request, hands it to the
 * writer with the idea ("use this map unless the idea clearly wants another"),
 * and holds the length check to the same map. [Final Chorus] is named only by
 * the map that has one. When the brief sets its own length or structure, no map
 * is drawn and the brief wins, as before. */
export type SectionMap = {
  id: string;
  name: string;
  plan: string;
  /** Three verses pass any map; two pass only when each has at least this many sung lines. */
  twoVerseLines: number;
  /** Where a missing verse goes, said to the audit. */
  addVerse: string;
};

export const SECTION_MAPS: Record<string, SectionMap> = {
  threeVerses: {
    id: 'threeVerses',
    name: 'three verses, a chorus after each, and a short bridge',
    plan: '[Verse 1] -> [Chorus] -> [Verse 2] -> [Chorus] -> [Bridge] -> [Verse 3] -> [Chorus]. Verses of eight to twelve lines. The bridge is four to six lines and comes before verse three, which adds another aspect of the subject. The last chorus lifts with an added line or heavier backing vocals. The song ends on that last chorus: no outro.',
    twoVerseLines: Infinity,
    addVerse: 'after the bridge and before the last chorus',
  },
  twoLong: {
    id: 'twoLong',
    name: 'two long verses, a bridge and a final chorus',
    plan: '[Verse 1] -> [Chorus] -> [Verse 2] -> [Chorus] -> [Bridge] -> [Final Chorus] -> [Outro]. Each verse runs twelve to sixteen lines and develops the subject. The bridge is four to eight lines. The [Final Chorus] lifts: an added line, a changed last line or heavier backing vocals. The outro is three to six lines.',
    twoVerseLines: 12,
    addVerse: 'before the bridge',
  },
  prePost: {
    id: 'prePost',
    name: 'verse, pre-chorus, chorus and a post-chorus',
    plan: '[Verse 1] -> [Pre-Chorus] -> [Chorus] -> [Post-Chorus] -> [Verse 2] -> [Pre-Chorus] -> [Chorus] -> [Post-Chorus] -> [Bridge] -> [Chorus] -> [Post-Chorus]. Verses of eight to twelve lines. The pre-chorus is four lines that climb. The post-chorus is three or four lines on a short repeated phrase or a wordless run that changes at least once, the part that sticks. The bridge is four to six lines. The song ends on the post-chorus.',
    twoVerseLines: 8,
    addVerse: 'with its pre-chorus, before the bridge',
  },
  hookFirst: {
    id: 'hookFirst',
    name: 'open on the chorus, then three verses',
    plan: '[Chorus] -> [Verse 1] -> [Chorus] -> [Verse 2] -> [Chorus] -> [Verse 3] -> [Chorus] -> [Outro]. No intro: the first thing sung is the chorus. Verses of eight to ten lines. The outro is three to six lines built from a piece of the hook, and it stops.',
    twoVerseLines: Infinity,
    addVerse: 'before the last chorus',
  },
  storyRefrain: {
    id: 'storyRefrain',
    name: 'a story song with a refrain line instead of a big chorus',
    plan: '[Verse 1] -> [Verse 2] -> [Verse 3] -> [Bridge] -> [Verse 4]. No chorus section. Every verse is eight to twelve lines and closes on the same one-line refrain that carries the title. The bridge is four to six lines. The song ends on the last verse and its refrain: no outro.',
    twoVerseLines: Infinity,
    addVerse: 'as the last verse, closing on the refrain',
  },
  dance: {
    id: 'dance',
    name: 'a dance-floor song with a drop and a breakdown',
    plan: '[Intro] -> [Verse 1] -> [Pre-Chorus] -> [Chorus] -> [Drop] -> [Verse 2] -> [Pre-Chorus] -> [Chorus] -> [Breakdown] -> [Chorus] -> [Drop]. The intro is one or two lines or a chant. Verses of eight to ten lines. The pre-chorus builds in four lines. Each drop is two to four lines chanting one short phrase from the chorus for the crowd to shout. The breakdown strips down to the voice and one instrument for two to four lines. The song ends on the drop.',
    twoVerseLines: 8,
    addVerse: 'with its pre-chorus, before the breakdown',
  },
};

/** The brief set its own length or structure: theirs wins, no map is drawn and
 *  the length check stands down. */
const briefSetsShape = (brief: string): boolean =>
  /\b(?:verses?|minutes?|seconds?|short|brief|quick|jingle|hook only|chorus only|no chorus|one verse|two verses|bars|pre-chorus|post-chorus|refrain|song structure|sections?)\b/i.test(
    brief,
  );

/* Genre decides which maps are in the hat: the drop and breakdown only for a
 * dance style; a chorus-less story song not for pop, a girl group or the club. */
const DANCE_STYLE =
  /\b(?:edm|techno|trance|disco|dubstep|drum (?:and|&|n['’]?) bass|dnb|eurodance|hyperpop|reggaeton|dancehall|jersey club|crunk|rave|(?:deep|tech|acid|progressive|electro|future|tropical) house|house (?:music|track|song|banger)|club (?:song|track|banger|anthem|mix|remix|hit)|dance (?:song|track|pop|anthem|banger|floor|music|remix)|dancefloor|four[- ]on[- ]the[- ]floor)\b/i;
const BIG_CHORUS_STYLE =
  /\b(?:pop|girl group|boy band|anthem|arena|stadium|k-?pop|j-?pop|power ballad)\b/i;

/** FNV-1a, then mulberry32: the same request always draws the same map. */
function seededUnit(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** The maps this brief can draw from. */
export function sectionMapPool(brief: string): SectionMap[] {
  const m = SECTION_MAPS;
  if (DANCE_STYLE.test(brief)) return [m.dance, m.dance, m.prePost, m.hookFirst];
  const pool = [m.threeVerses, m.twoLong, m.prePost, m.hookFirst];
  if (!BIG_CHORUS_STYLE.test(brief)) pool.push(m.storyRefrain);
  return pool;
}

/** Draws this request's section map; null when the brief sets its own shape.
 *  `salt` is the rest of the request (who asked and when), so asking again
 *  draws again; the brief alone gives a repeatable draw. */
export function songSectionMap(brief: string, salt = ''): SectionMap | null {
  const text = String(brief || '').trim();
  if (!text || briefSetsShape(text)) return null;
  const pool = sectionMapPool(text);
  return pool[Math.floor(seededUnit(`${text}\n${salt}`) * pool.length)];
}

/** The line the writer gets under the idea. */
export function sectionMapNote(map: SectionMap | null): string {
  if (!map) return '';
  return `SECTION MAP, drawn by the desk for this song: ${map.name}. ${map.plan} Use this map unless the idea clearly wants another. Write the STRUCTURE line of the music direction from it.`;
}

/* Part 296 (Sep 27 2026). Her words about the desk's choruses: "it does good on
 * some of the rhymes, but the chorus is horrible... over and over, nothing else.
 * Sounds like a writer that was lyrical for a minute then... ran out of ideas."
 * Measured on 46 drafts: the hook sung three or more times in 78% of first
 * choruses, and in 48% half the lines or fewer said anything new. The section
 * map said nothing about the inside of a chorus, and the system above it asks
 * for one phrase sung over and over. So the desk draws ONE chorus shape per
 * request in code, the same way it draws the map (a list of shapes in a prompt
 * reads as one shape at low reasoning), and says it in words: never an example
 * line, because the writer hands examples back. The gate after the draft
 * (lyricRepeatIssues) holds the song to it. */
export type ChorusShape = { id: string; plan: string };

export const CHORUS_SHAPES: Record<string, ChorusShape> = {
  bookends: {
    id: 'bookends',
    plan: 'the hook is the first line and the last line, and the lines between carry it somewhere: what happens because of it, what it costs, or the comeback.',
  },
  answer: {
    id: 'answer',
    plan: 'the hook is the first line and comes back once, as the third. The second line answers its thought, and the lines after the third raise the stakes and land hardest on the last.',
  },
  build: {
    id: 'build',
    plan: 'the chorus climbs to the hook. The lines before it develop the thought or push the feeling further, and the hook lands on the last line. It may also open the chorus, and that is its only other time.',
  },
};

/** The brief asked for a chant or for repetition: the desk draws no chorus shape
 *  and the gate leaves the chorus alone.
 *  Part 296 review: the first version stood down on any of these words, so "don't
 *  repeat the hook over and over", "no repetitive chorus" and "not too repetitive",
 *  the very thing she asked for, turned the fix off, and so did a story that only
 *  mentions repeating ("my toddler repeats everything", "he calls me over and
 *  over"). Now a form word counts unless a no, not, don't, too, without or less
 *  stands just before it in the same sentence, and a word about repeating counts
 *  only next to a word for a part of the song. A sea shanty is call and response
 *  by definition. */
const REPEAT_FORM =
  /\b(?:repetitive|chant(?:s|ed|ing)?|mantra|call[- ]and[- ]response|hook only|chorus only|(?:sea )?shant(?:y|ies))\b/gi;
const REPEAT_WORD =
  /\b(?:repeat(?:s|ed|ing)?|on repeat|over and over|again and again|loop(?:s|ed|ing)?)\b/gi;
const SONG_PART =
  /\b(?:hook|chorus(?:es)?|refrain|lines?|phrase|title|words?|lyrics?|sings?|sung)\b/i;
const NEGATED_BEFORE =
  /\b(?:no|not|don['’]?t|do not|never|without|less|too|stop|avoid|instead of|rather than|hate|isn['’]?t|shouldn['’]?t|won['’]?t)\b[^.!?;\n]{0,30}$/i;
const briefWantsRepeats = (brief: string): boolean => {
  const text = String(brief || '');
  const asks = (pattern: RegExp, near: boolean): boolean => {
    for (const hit of text.matchAll(pattern)) {
      const at = hit.index || 0;
      if (NEGATED_BEFORE.test(text.slice(0, at))) continue;
      if (near && !SONG_PART.test(text.slice(Math.max(0, at - 40), at + hit[0].length + 40)))
        continue;
      return true;
    }
    return false;
  };
  return asks(REPEAT_FORM, false) || asks(REPEAT_WORD, true);
};

/** This request's chorus shape; null for a map with no chorus (the story song's
 *  refrain is one line by design) or when the brief asks for repetition or for
 *  no chorus. Drawn with the same salt as the map, so asking again draws again. */
export function chorusShapeFor(
  brief: string,
  salt = '',
  map: SectionMap | null = null,
): ChorusShape | null {
  const text = String(brief || '').trim();
  if (
    !text ||
    briefWantsRepeats(text) ||
    briefRepeatsItself(text) ||
    /\bno chorus\b/i.test(text) ||
    map?.id === 'storyRefrain'
  )
    return null;
  const pool = Object.values(CHORUS_SHAPES);
  return pool[Math.floor(seededUnit(`${text}\nchorus\n${salt}`) * pool.length)];
}

/** The line the writer gets under the section map. */
export function chorusShapeNote(shape: ChorusShape | null, map: SectionMap | null = null): string {
  if (!shape) return '';
  const chants: Record<string, string> = {
    dance: ' Chanting one short phrase belongs to the [Drop], not to the chorus.',
    prePost: ' Chanting one short phrase belongs to the [Post-Chorus], not to the chorus.',
  };
  const chant = map ? chants[map.id] || '' : '';
  return `CHORUS SHAPE, drawn by the desk for this song: ${shape.plan} Whatever the shape, the hook is sung no more than twice in one chorus, and surrounding lines deepen or answer the central thought without filler. Other lines are never sung twice inside it, two lines in a row never open with the same words, and a word ends two of its lines at most. Six to eight lines by default, with room for vocal phrasing. Supplied refrains and requested repetition win over this default. The same chorus can come back unchanged.${chant}`;
}

/** The second, surgical request: replace the flagged lines and nothing else. */
/** Seen live: asked for three verses, the writer delivered two. Returns the
 *  instruction to add when a song the desk sized itself came back short; null
 *  when the person set the length or structure, or the shape is fine.
 *  Part 293: two LONG verses are the desk's other map (a bridge and a final
 *  chorus carry the turn), so two verses of twelve or more sung lines EACH
 *  pass; a lopsided 16 and 8 does not (review). Whole-line (parenthesised)
 *  ad-libs are not counted.
 *  Part 293 follow-up: given the drawn map, the check holds the song to THAT
 *  map: three verses pass any map (the writer may take another shape), and two
 *  pass only where the map has two, each long enough. Without a map (a caller
 *  that drew none) it is the check it was. */
export function lyricShapeIssue(
  script: string,
  brief = '',
  map?: SectionMap | null,
): string | null {
  if (briefSetsShape(brief)) return null;
  const at = script.search(/^\s*lyrics\s*:/im);
  if (at === -1) return null;
  const lengths: number[] = [];
  let inVerse = false;
  for (const raw of script.slice(at).split('\n').slice(1)) {
    const line = raw.trim();
    if (/^READBACK:/i.test(line)) break;
    const tag = /^\[([^\]]*)\]$/.exec(line);
    if (tag) {
      inVerse = /^\s*verse/i.test(tag[1]);
      if (inVerse) lengths.push(0);
    } else if (inVerse && line && !/^\(.*\)$/.test(line)) lengths[lengths.length - 1] += 1;
  }
  const verses = lengths.length;
  const tail =
    'Develop the requested subject with another aspect, pressure, choice, consequence or event. Preserve supplied phrases; do not invent a scene, life lesson or reversal merely to extend the song.';
  if (map) {
    if (verses === 0 || verses >= 3) return null;
    const need = map.twoVerseLines;
    if (verses === 2 && Math.min(...lengths) >= need) return null;
    if (verses === 2 && need !== Infinity) {
      const which = lengths
        .map((n, i) => (n < need ? `[Verse ${i + 1}] has ${n}` : ''))
        .filter(Boolean)
        .join(' and ');
      return `The map for this song is ${map.name}, and each verse needs at least ${need} sung lines: ${which}. Lengthen each short verse to ${need} lines or more with what happens next, in the same voice and meter. ${tail}`;
    }
    const lines = need !== Infinity && need > 8 ? `${need} to ${need + 4}` : 'eight to twelve';
    return `The song has only ${verses === 1 ? 'one verse' : 'two verses'}, and the map for this song is ${map.name}. Add a [Verse ${verses + 1}] of ${lines} sung lines in the same voice, ${map.addVerse}. ${tail}`;
  }
  if (verses === 0 || verses >= 3) return null;
  if (verses === 2 && Math.min(...lengths) >= 12) return null;
  let short = 'one verse';
  if (verses !== 1)
    short = Math.max(...lengths) >= 12 ? 'two verses, one of them short,' : 'two short verses';
  return `The song has only ${short} and this desk writes three verses, or two long ones of twelve to sixteen lines each. Add a [Verse ${verses + 1}] of eight to twelve sung lines in the same voice, placed after the bridge if there is one and before the final chorus, otherwise before the last chorus. ${tail}`;
}

/* Part 320 (Oct 8 2026). Her words: the writer sounds slightly AI, leaves too few lines in
 * certain places, and she wants backing vocals in (parentheses) to feed a music generator.
 * Measured on 24 drafts the live desk's own pipeline wrote from 12 short briefs: 23 had no backing line at all (the
 * music direction promised "close backing harmonies" and the lyrics carried none), pre-choruses
 * and post-choruses were often two lines, and the producer's audit handed the draft back
 * unchanged in 10 of 12 songs. A general rule in the prompt is skimmed, so the desk MEASURES
 * both things in code and gives the audit the numbers: the sections that are too thin, and the
 * backing vocals that are missing or are directions the generator would sing aloud. */
const SECTION_START =
  /^(?:final |last |second |third )?(?:pre[- ]?chorus|post[- ]?chorus|chorus|verse|bridge|outro|intro|hook|refrain|drop|breakdown|interlude|vamp|coda|tag|middle)\b/i;

type SectionPass = {
  tag: string;
  kind: string;
  lead: number;
  own: number;
  inline: number;
  ownLines: string[];
  inlineLines: string[];
  leads: string[];
  /** Every line of the pass in order, lead and backing alike. */
  all: string[];
};

function sectionKind(tag: string): string {
  const t = tag.toLowerCase();
  if (/pre[- ]?chorus/.test(t)) return 'prechorus';
  if (/post[- ]?chorus/.test(t)) return 'postchorus';
  if (/chorus|hook|refrain/.test(t)) return 'chorus';
  const named = /verse|bridge|outro|intro|drop|breakdown|interlude/.exec(t);
  return named ? named[0] : 'other';
}

/** Every section pass below "Lyrics:" with its lead-line count and its backing parts: a whole
 *  line in (parentheses) is a backing line of its own; parentheses after a lead phrase are
 *  inline backing. Bracket cues that are not section tags ([riff]) are skipped. */
function sectionPasses(script: string): SectionPass[] {
  const at = script.search(/^\s*lyrics\s*:/im);
  if (at === -1) return [];
  const passes: SectionPass[] = [];
  let cur: SectionPass | null = null;
  const open = (tag: string): SectionPass => {
    const pass: SectionPass = {
      tag,
      kind: sectionKind(tag),
      lead: 0,
      own: 0,
      inline: 0,
      ownLines: [],
      inlineLines: [],
      leads: [],
      all: [],
    };
    passes.push(pass);
    return pass;
  };
  for (const raw of script.slice(at).split('\n').slice(1)) {
    const line = raw.trim();
    if (/^READBACK:/i.test(line)) break;
    if (!line) continue;
    const tag = /^\[([^\]]*)\]$/.exec(line);
    if (tag) {
      if (SECTION_START.test(tag[1].trim())) cur = open(tag[1].trim());
      continue;
    }
    cur = cur || open('');
    cur.all.push(line);
    if (/^\(.*\)$/.test(line)) {
      cur.own += 1;
      cur.ownLines.push(line);
    } else {
      cur.lead += 1;
      cur.leads.push(line);
      if (/\([^()]+\)/.test(line)) {
        cur.inline += 1;
        cur.inlineLines.push(line);
      }
    }
  }
  return passes;
}

const SECTION_FLOOR: Record<string, number> = {
  verse: 8,
  prechorus: 4,
  chorus: 6,
  postchorus: 3,
  bridge: 4,
  outro: 3,
};
const SECTION_LABEL: Record<string, string> = {
  verse: 'verse',
  prechorus: 'pre-chorus',
  chorus: 'chorus',
  postchorus: 'post-chorus',
  bridge: 'bridge',
  outro: 'outro',
};

export type ThinSection = { tag: string; kind: string; lines: number; need: number; times: number };

/** The sections shorter than a melody can use: a verse under eight lead lines, a pre-chorus
 *  under four, a chorus under six, a post-chorus under three, a bridge under four, an outro
 *  under three. A section that returns at the same short size is reported once with how many
 *  times it comes back. The brief's own length or structure, and a chant it asks for, win. */
export function lyricThinSections(script: string, brief = ''): ThinSection[] {
  if (briefSetsShape(brief)) return [];
  const chant = briefWantsRepeats(brief) || briefRepeatsItself(brief);
  const found: ThinSection[] = [];
  for (const pass of sectionPasses(script)) {
    const need = SECTION_FLOOR[pass.kind];
    if (!need || pass.lead >= need) continue;
    if (chant && (pass.kind === 'chorus' || pass.kind === 'postchorus')) continue;
    const same = found.find((s) => s.kind === pass.kind && s.lines === pass.lead);
    if (same) same.times += 1;
    else found.push({ tag: pass.tag, kind: pass.kind, lines: pass.lead, need, times: 1 });
  }
  return found;
}

const NO_BACKING =
  /\b(?:a cappella|acapella|no backing|without backing|no harmon(?:y|ies)|no background vocals?|no ad-?libs?|spoken[- ]word|no parentheses)\b/i;
const DIRECTION_WORDS: Set<string> = new Set(
  'soft softly quiet quietly loud loudly whisper whispers whispered whispering spoken speaking laugh laughs laughing laughter sigh sighs sighing chuckle chuckles chuckling harmony harmonies harmonized harmonised backing background vocal vocals choir key change modulation build builds building crescendo fade fades fading out instrumental solo guitar piano drums drum bass strings horns horn sax clap claps clapping stomp stomps stomping repeat repeats repeated twice x ad lib libs adlib adlibs ad-lib ad-libs vocalizing vocalising'.split(
    ' ',
  ),
);

/** The parenthesised groups in a draft's lyrics that hold only directions (a generator sings
 *  "(whispered)" aloud). A group with any other word in it is a sung part. */
function directionsInParens(script: string): string[] {
  const at = script.search(/^\s*lyrics\s*:/im);
  if (at === -1) return [];
  const body = script.slice(at).split(/^READBACK:/im)[0];
  const found: string[] = [];
  for (const hit of body.matchAll(/\(([^()\n]{1,60})\)/g)) {
    const words = hit[1]
      .toLowerCase()
      .replace(/[’‘`]/g, "'")
      .split(/[^a-z']+/)
      .filter(Boolean);
    if (words.length && words.every((w) => DIRECTION_WORDS.has(w))) found.push(hit[0]);
  }
  return found;
}

export type BackingIssue = {
  /** Backing events in the draft: whole backing lines plus lead lines carrying parentheses. */
  total: number;
  /** About how many a full song of this size wants. */
  need: number;
  /** Events in each chorus pass, in order. */
  choruses: number[];
  /** Parentheses that hold directions, not sung words. */
  directions: string[];
  /** When most backing parts only repeat the lead's last words: the parts counted, and how many echo. */
  parts: number;
  echoes: number;
};

/** The words of a line without its parentheses, lower case, as a list. */
const wordsOf = (text: string): string[] =>
  sayable(text.replace(/\([^()]*\)/g, ' '))
    .split(' ')
    .map(bare)
    .filter(Boolean);

/** How many backing parts only repeat the last one to three words of the lead line they follow
 *  or answer. Echoes are fine for a build; a song of nothing else is arrangement filler. */
function echoCount(passes: SectionPass[]): { parts: number; echoes: number } {
  let parts = 0;
  let echoes = 0;
  const echoed = (lead: string[], said: string[]): boolean => {
    if (!said.length || said.length > 3 || lead.length < said.length) return false;
    return lead.slice(-said.length).join(' ') === said.join(' ');
  };
  for (const pass of passes) {
    let last: string[] = [];
    for (const line of pass.all) {
      if (/^\(.*\)$/.test(line)) {
        parts += 1;
        if (echoed(last, sayable(line).split(' ').map(bare).filter(Boolean))) echoes += 1;
        continue;
      }
      last = wordsOf(line);
      for (const hit of line.matchAll(/\(([^()]+)\)/g)) {
        parts += 1;
        if (echoed(last, sayable(hit[1]).split(' ').map(bare).filter(Boolean))) echoes += 1;
      }
    }
  }
  return { parts, echoes };
}

/** Whether a full-length draft is missing its backing vocals: fewer events than a song of this
 *  size wants, a chorus pass with none, or parentheses that are directions. Null when the brief
 *  asks for none, when the draft is too short to be a song, or when nothing is missing. */
export function lyricBackingIssue(script: string, brief = ''): BackingIssue | null {
  if (NO_BACKING.test(brief)) return null;
  const passes = sectionPasses(script);
  const lead = passes.reduce((n, p) => n + p.lead, 0);
  if (lead < 16) return null;
  const events = (p: SectionPass): number => p.own + p.inline;
  const total = passes.reduce((n, p) => n + events(p), 0);
  const need = Math.max(6, Math.round(lead / 7));
  const choruses = passes.filter((p) => p.kind === 'chorus').map(events);
  const directions = directionsInParens(script);
  const { parts, echoes } = echoCount(passes);
  const echoHeavy = parts >= 6 && echoes / parts > 0.5;
  if (total >= need && !choruses.some((n) => n === 0) && !directions.length && !echoHeavy)
    return null;
  return {
    total,
    need,
    choruses,
    directions,
    parts: echoHeavy ? parts : 0,
    echoes: echoHeavy ? echoes : 0,
  };
}

/** The last chorus has the same lead lines as the first in a song with three or more choruses:
 *  the blind judges named the pasted final chorus in every song, and extra backing parts alone
 *  were not a change in what the chorus says. */
export function lyricLiftIssue(script: string, brief = ''): boolean {
  if (briefWantsRepeats(brief) || briefRepeatsItself(brief)) return false;
  const choruses = sectionPasses(script).filter((p) => p.kind === 'chorus');
  if (choruses.length < 3) return false;
  const sig = (p: SectionPass): string => p.leads.map((l) => wordsOf(l).join(' ')).join('|');
  return sig(choruses[0]) === sig(choruses[choruses.length - 1]);
}

/* Words the blind judges found in song after song ("little" in 9 of 24 songs): kept to one line
 * each unless the brief itself uses the word. */
const PET_WORDS: [string, RegExp, number][] = [
  ['little', /\blittle\b/i, 3],
  ['small', /\bsmall\b/i, 3],
  ['tiny', /\btiny\b/i, 3],
  ['some days', /^\s*some days\b/i, 3],
  ['almost', /\balmost\b/i, 3],
  ['somehow', /\bsomehow\b/i, 2],
  ['maybe', /\bmaybe\b/i, 3],
];

export type PetWord = { word: string; lines: string[] };

/** The pet words that open or fill too many different lines of the song. */
export function lyricPetWords(script: string, brief = ''): PetWord[] {
  const lines = new Set<string>();
  for (const pass of sectionPasses(script)) for (const l of pass.leads) lines.add(l);
  const found: PetWord[] = [];
  for (const [word, pattern, limit] of PET_WORDS) {
    if (pattern.test(brief)) continue;
    const hits = [...lines].filter((l) => pattern.test(l));
    if (hits.length >= limit) found.push({ word, lines: hits.slice(0, 4) });
  }
  return found;
}

/* The desk can now hear rhyme (see rhyme.ts). Her words: "I love lyricism and rhyming. I think
 * creative rhymes is awesome." Measured on the same 24 drafts: 80 to 95 percent of end pairs
 * were plain one-syllable pairs, five songs had verses that rhymed with almost nothing, and one
 * word ended four lines of a song. The report names the lines, the repeated end words, the worn
 * pairs and the plain couplets worth upgrading, so the audit edits exact lines instead of being
 * told to "rhyme better". */
const WORN_RHYMES: Set<string> = new Set(
  (
    'love|above fire|desire heart|apart heart|start night|light night|tight night|right light|sight light|bright light|right me|be me|see be|see free|me be|free free|see ' +
    'true|you do|you through|you away|stay away|day day|way day|say stay|way say|stay pain|rain mind|find behind|mind behind|find eyes|lies eyes|skies dream|seem go|know know|show go|slow ' +
    'long|strong long|wrong strong|wrong control|soul soul|whole cry|goodbye cry|why goodbye|why right|tonight light|tonight alone|own alone|home home|own mine|time feel|real deal|real ' +
    'cold|hold hold|told cold|old burn|learn burn|turn learn|turn breathe|leave hand|stand sorrow|tomorrow'
  )
    .split(' ')
    .map((pair) => pair.split('|').sort().join('|')),
);
const RHYMED_KINDS: Set<string> = new Set([
  'verse',
  'prechorus',
  'chorus',
  'postchorus',
  'bridge',
  'outro',
]);

export type RhymeReport = {
  /** Lead lines in rhymed sections whose end word the table knows. */
  lines: number;
  /** Of those, the lines that rhyme with another line within three lines. */
  rhymed: number;
  /** Lines with no partner, in sections that have more of them than the one open line allowed. */
  lonely: { tag: string; line: string }[];
  /** End words that close four or more different lines of the song. */
  repeatedEnds: { word: string; lines: string[] }[];
  /** Neighbouring lines that end on the same word or a homophone. */
  sameWord: string[];
  /** Stock rhyme pairs. */
  worn: { pair: string; tag: string }[];
  /** Rhymes that span two syllables or more, plus internal rhymes. */
  creative: number;
  /** About how many a song this size wants. */
  need: number;
  /** Plain one-syllable verse couplets worth upgrading. */
  plain: { first: string; second: string; tag: string }[];
  /** Three or more lines of one section closing on the same suffix (-tion, -ance, -ment...). */
  suffixStacks: { family: string; tag: string; words: string[] }[];
  /** Every section of the song runs in plain couplets: how many sections do, out of how many judged. */
  couplets: { sections: number; of: number } | null;
};

/* The lazy rhyme: a stack of long Latinate words that rhyme because they share a suffix. */
const SUFFIX_FAMILIES: [string, RegExp][] = [
  ['-tion or -sion', /(?:tion|sion)s?$/],
  ['-ance or -ence', /(?:ance|ence)s?$/],
  ['-ity', /ity$|ities$/],
  ['-ment', /ments?$/],
];

/** How well a draft's lines rhyme, from the sounds of the words. Null when the brief asks for no
 *  rhyme, when the draft is too short to judge or when the table knows too few of its end words. */
export function lyricRhymeReport(script: string, brief = ''): RhymeReport | null {
  if (/\b(?:no rhymes?|unrhymed|free verse|spoken[- ]word|without rhyme)\b/i.test(brief))
    return null;
  const seen = new Set<string>();
  let total = 0;
  let known = 0;
  let counted = 0;
  let rhymed = 0;
  let creative = 0;
  let verses = 0;
  const lonely: { tag: string; line: string }[] = [];
  const worn: { pair: string; tag: string }[] = [];
  const sameWord: string[] = [];
  const plainPairs: { first: string; second: string; tag: string; verse: number }[] = [];
  const endLines = new Map<string, Set<string>>();
  const suffixStacks: { family: string; tag: string; words: string[] }[] = [];
  let coupletSections = 0;
  let judgedSections = 0;
  for (const pass of sectionPasses(script)) {
    if (!RHYMED_KINDS.has(pass.kind) || pass.leads.length < 2) continue;
    const signature = `${pass.kind}|${pass.leads.map(sayable).join('/')}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    if (pass.kind === 'verse') verses += 1;
    const n = pass.leads.length;
    const ends = pass.leads.map((line) => endWord(line));
    const keys = ends.map((word) => (word ? rhymeKeyOf(word) : undefined));
    const inChorus = pass.kind === 'chorus' || pass.kind === 'postchorus';
    total += ends.filter(Boolean).length;
    known += keys.filter(Boolean).length;
    const paired = ends.map(() => false);
    for (let i = 0; i < n; i++) {
      if (ends[i]) {
        const set = endLines.get(rhymeWord(ends[i])) || new Set<string>();
        set.add(sayable(pass.leads[i]));
        endLines.set(rhymeWord(ends[i]), set);
      }
      for (let j = i + 1; j <= Math.min(n - 1, i + 3); j++) {
        if (!ends[i] || !ends[j]) continue;
        const relation = rhymeRelation(ends[i], ends[j]);
        if (!relation) {
          if (sameRhymeWord(ends[i], ends[j])) {
            if (inChorus) {
              paired[i] = true;
              paired[j] = true;
            } else if (j === i + 1) sameWord.push(`"${pass.leads[i]}" / "${pass.leads[j]}"`);
          }
          continue;
        }
        paired[i] = true;
        paired[j] = true;
        if (relation !== 'perfect') continue;
        const pair = [rhymeWord(ends[i]), rhymeWord(ends[j])].sort().join('|');
        if (WORN_RHYMES.has(pair)) worn.push({ pair: pair.replace('|', '/'), tag: pass.tag });
        const sounds = rhymeSyllables(rhymeKeyOf(ends[i]) || '');
        if (sounds >= 2) creative += 1;
        else if (pass.kind === 'verse' && j === i + 1)
          plainPairs.push({
            first: pass.leads[i],
            second: pass.leads[j],
            tag: pass.tag,
            verse: verses,
          });
      }
      // An internal rhyme: a word inside the line chimes with this line's end or a neighbour's.
      const words = sayable(pass.leads[i]).split(' ').map(bare).filter(Boolean);
      const mids = words.slice(0, -1).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
      const targets = [ends[i], ends[i - 1], ends[i + 1]].filter(Boolean);
      if (mids.some((m) => targets.some((t) => rhymeRelation(m, t) === 'perfect'))) creative += 1;
    }
    const open: { tag: string; line: string }[] = [];
    for (let i = 0; i < n; i++) {
      if (!keys[i]) continue;
      counted += 1;
      if (paired[i]) rhymed += 1;
      else open.push({ tag: pass.tag, line: pass.leads[i] });
    }
    if (n >= 4 && open.length > Math.max(1, Math.floor(n / 6))) lonely.push(...open);
    for (const [family, pattern] of SUFFIX_FAMILIES) {
      const words = ends.filter((w) => w.length > 4 && pattern.test(rhymeWord(w)));
      if (words.length >= 3) suffixStacks.push({ family, tag: pass.tag, words: words.slice(0, 4) });
    }
    if (n >= 4 && (pass.kind === 'verse' || pass.kind === 'chorus' || pass.kind === 'bridge')) {
      judgedSections += 1;
      const twos = Math.floor(n / 2);
      let couplets = 0;
      for (let k = 0; k < twos; k++)
        if (ends[2 * k] && ends[2 * k + 1] && rhymeRelation(ends[2 * k], ends[2 * k + 1]))
          couplets += 1;
      if (couplets >= Math.ceil(twos * 0.75)) coupletSections += 1;
    }
  }
  if (counted < 12 || known < total * 0.6) return null;
  const repeatedEnds = [...endLines.entries()]
    .filter(([word, lines]) => lines.size >= 4 && word.length > 1)
    .map(([word, lines]) => ({ word, lines: [...lines].slice(0, 4) }));
  const picked: { first: string; second: string; tag: string }[] = [];
  const perVerse = new Map<number, number>();
  for (const p of plainPairs) {
    const taken = perVerse.get(p.verse) || 0;
    if (picked.length >= 4 || taken >= (p.verse === 1 ? 2 : 1)) continue;
    perVerse.set(p.verse, taken + 1);
    picked.push({ first: p.first, second: p.second, tag: p.tag });
  }
  return {
    lines: counted,
    rhymed,
    lonely,
    repeatedEnds,
    sameWord,
    worn,
    creative,
    need: Math.max(3, verses * 2),
    plain: picked,
    suffixStacks,
    /* Rap and children's songs live on couplets, so they are never asked to leave them. */
    couplets:
      judgedSections >= 4 &&
      coupletSections / judgedSections >= 0.8 &&
      !/\b(?:rap|hip[ -]?hop|grime|drill|kids?|children|nursery|lullaby|toddler)\b/i.test(
        `${brief}\n${script.slice(0, Math.max(0, script.search(/^\s*lyrics\s*:/im)))}`,
      )
        ? { sections: coupletSections, of: judgedSections }
        : null,
  };
}

/** How much a rhyme report asks the audit to fix: used to keep an audit that made it worse. */
export function lyricRhymeWeight(report: RhymeReport | null): number {
  if (!report) return 0;
  return (
    report.lonely.length +
    report.repeatedEnds.length +
    report.sameWord.length +
    report.worn.length +
    report.suffixStacks.length +
    (report.couplets ? 1 : 0) +
    (report.creative < report.need ? 1 : 0)
  );
}

/** Sung lines too long for a singer at tempo: more than 14 syllables, or 17 for rap. The verse
 *  note from the desk only compares a verse's lines with each other; this one reads the line. */
export function lyricLongLines(script: string, brief = ''): string[] {
  const at = script.search(/^\s*lyrics\s*:/im);
  if (at === -1) return [];
  const rapped = /\b(?:rap|hip[ -]?hop|spoken[ -]word|grime|drill)\b/i.test(
    `${brief}\n${script.slice(0, at)}`,
  );
  const limit = rapped ? 17 : 14;
  const found = new Set<string>();
  for (const pass of sectionPasses(script))
    for (const line of pass.leads) if (syllables(line) > limit) found.add(line);
  return [...found];
}

export function lyricRepairRequest(
  script: string,
  tells: LyricTell[],
  shape: string | null = null,
): string {
  if (!tells.length && shape)
    return `Your draft is below. It is good and it stays, word for word. One thing is missing. ${shape} Every existing line, the music direction, the section tags and the READBACK line must come back exactly as they are. Return the complete draft in the same format and nothing else.\n\n${script}`;
  return `Your draft is below. It is good and it stays. Only these lines lean on stock images that the owner of this desk hears as machine writing:

${tells.map((t, i) => `${i + 1}. "${t.line}" -- ${t.tell}`).join('\n')}
${shape ? `\nAlso: ${shape}\n` : ''}
Rewrite ONLY those lines with a clear thought that belongs to the requested subject and this singer's language. Specificity can be a feeling, choice or consequence; do not add objects, a scene or stranger props merely to replace a stock image. Keep each new line's rhyme sound, stress count and approximate length so it still sings in the same slot, and keep the joke or the turn if the old line had one. If a flagged line repeats (a chorus or a hook), change it the same way everywhere it appears. Keep any supplied title or hook intact. If a generated hook word needs repair, carry the repair through its returning lines. Do not swap one stock image for another from the desk's list. Every other line, the music direction, the section tags and the READBACK line must come back exactly as they are. Return the complete corrected draft in the same format and nothing else.

${script}`;
}

/** A whole-line parenthesis that is a stage direction, not a sung ad-lib, gets
 *  sung by the generator as words. Seen: "(Whistling)", "(Claps and bass only)".
 *  Turn those into bracket cues; leave real ad-libs and echoes alone. */
export function fixStageDirections(script: string): string {
  const cue =
    /^\s*\(([^()]*\b(?:whistl\w*|instrumental|solo|fades?|fading|band|guitars?|bass|drums?|claps?|piano|strings|horns?|beat|music|spoken|humming|hummed)\b[^()]*)\)\s*$/i;
  const at = script.search(/^\s*lyrics\s*:/im);
  if (at === -1) return script;
  const body = script
    .slice(at)
    .split('\n')
    .map((line) => {
      const hit = cue.exec(line);
      if (!hit) return line;
      const words = hit[1].trim().replace(/\s+/g, ' ');
      return `[${words.charAt(0).toUpperCase()}${words.slice(1)}]`;
    })
    .join('\n');
  return script.slice(0, at) + body;
}

/** Part 217: the producer's audit. Deep reasoning wrote the best songs (a planted
 *  detail paid off in verse three, a last chorus that rereads) but took 275
 *  seconds, which no web request survives. A fast draft followed by ONE fast
 *  audit gets most of that: the writer is handed its own draft and the gates
 *  that matter most, and fixes in place. Flagged tells ride in the same call. */
/** Rough counts identify passages to review by ear, never a measured meter failure. */
const syllables = (line: string): number =>
  line
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .reduce((n, word) => {
      const w = word
        .replace(/'/g, '')
        .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
        .replace(/^y/, '');
      return n + Math.max(1, (w.match(/[aeiouy]{1,2}/g) || []).length);
    }, 0);

export function lyricMeterNote(script: string, brief = ''): string {
  const at = script.search(/^\s*lyrics\s*:/im);
  if (at === -1) return '';
  if (
    /\b(?:rap|hip[ -]?hop|spoken[ -]word|grime|drill)\b/i.test(brief + '\n' + script.slice(0, at))
  )
    return '';
  const uneven: string[] = [];
  let tag = '';
  let counts: number[] = [];
  const close = (): void => {
    if (/^verse/i.test(tag) && counts.length >= 4 && Math.max(...counts) - Math.min(...counts) > 4)
      uneven.push(`[${tag}] lines run ${counts.join(', ')} syllables`);
    counts = [];
  };
  for (const raw of script.slice(at).split('\n').slice(1)) {
    const line = raw.trim();
    if (/^READBACK:/i.test(line)) break;
    const section = /^\[([^\]]*)\]$/.exec(line);
    if (section) {
      close();
      tag = section[1];
    } else if (line && !/^\(.*\)$/.test(line)) counts.push(syllables(line));
  }
  close();
  return uneven.length
    ? `\n\nRough phrase-length observations, not a melody or timing verdict: ${uneven.join('; ')}. Review only genuinely crowded or awkward phrases by ear. Alternating long-short lines, pickups, held notes and varied verse patterns can work; do not equalize them merely because these rough counts differ.`
    : '';
}

/* Part 296 (Sep 27 2026): the repetition gate. Her two complaints, measured in
 * code because "prompt-only pleading does not work at low reasoning; guards in
 * code do" (Part 216):
 *  1. A chorus that is its hook sung again and again with nothing else. In a
 *     chorus pass: the hook (its most repeated phrase that carries a real word)
 *     sung more than twice, another line sung twice besides the hook, or fewer
 *     than three in four of its lines different.
 *  2. "same this same this same this and that. Very ai." Three or more lines in
 *     a row opening with the same two words (or the same word, when it is not a
 *     pronoun, an article or a joining word), or one line stacking three clauses
 *     on the same opening. Her own Tier 2 bans already name this (lists that
 *     only repeat, checklist lyrics); nothing enforced them.
 * Plus one rhyme check the collapsed choruses shared: one word ending three or
 * more lines of a section.
 * Chants are left alone where the map designs them (post-chorus, drop, intro,
 * outro), a single word repeated for pressure is the system's spice, not a list, and
 * whole-line (ad-libs) are backing vocals. A word from her brief is hers. */
const STOP_WORDS = new Set(
  (
    'i me my mine you your yours we us our he him his she her it its they them their a an the and or but so if of to in on at by for with from up down out off over into onto is am are was were be been being do does did done have has had ' +
    "i'm you're it's that's don't can't won't ain't i'll you'll i've i'd you'd we're they're she's he's gonna wanna gotta just like that this these those what when where who how why all no not yeah oh ooh ah hey uh na la whoa baby babe girl boy yo ay now then too very some any got get come go let's lets mm hmm huh"
  ).split(/\s+/),
);
/* Openings too common in speech to count as a list on their own (two shared words still do). */
const COMMON_OPENINGS = new Set(
  "i i'm i've i'd i'll you you're you've you'd you'll he he's she she's it it's we we're we've they they're they've that's there's the a an and but so then or if when my your our his her their".split(
    ' ',
  ),
);
const EXEMPT_SECTION =
  /^(?:post[- ]?chorus|drop|intro|outro|chant|vamp|tag|interlude|instrumental|solo)\b/i;

const sayable = (line: string): string =>
  line
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const bare = (word: string): string => word.replace(/^'+|'+$/g, '');
const contentWords = (text: string): string[] =>
  text
    .split(' ')
    .map(bare)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
/** The phrases of a line split at punctuation, each made sayable, two words or more. */
const phrasesOf = (line: string): { said: string; raw: string }[] =>
  line
    .replace(/\([^)]*\)/g, ' ')
    .split(/[,;:!?.]+|\s[—–-]+\s|[—–]/)
    .map((raw) => ({ said: sayable(raw), raw: raw.trim() }))
    .filter((p) => p.said.includes(' '));
/* A voice tic at the end of a line ("..., yeah") is breath, not the rhyme word. */
const TAIL_TICS = new Set(
  'yeah yea oh ooh ah hey uh whoa baby babe na la mm yo ay huh now'.split(' '),
);
const endWord = (line: string): string => {
  const words = sayable(line).split(' ').map(bare).filter(Boolean);
  while (words.length > 1 && TAIL_TICS.has(words[words.length - 1])) words.pop();
  return words[words.length - 1] || '';
};
const hasWords = (brief: string, words: string): boolean =>
  ` ${sayable(brief)} `.includes(` ${words} `);

/** Part 296 review: the idea spells out its own chorus, repeats and all ("the chorus
 *  goes: ..."), when a two-word phrase with a real word in it comes three times in
 *  it. That repetition is hers: no chorus shape is drawn against it, and the audit is
 *  told to keep it (the gate itself leaves alone a hook the brief sings that often). */
function briefRepeatsItself(brief: string): boolean {
  const words = sayable(String(brief || ''))
    .split(' ')
    .map(bare)
    .filter(Boolean);
  for (let i = 0; i + 2 < words.length; i++) {
    if (words[i] === words[i + 1] && words[i] === words[i + 2] && contentWords(words[i]).length)
      return true;
  }
  const pairs = new Map<string, number>();
  for (let i = 0; i + 1 < words.length; i++) {
    const pair = `${words[i]} ${words[i + 1]}`;
    if (contentWords(pair).length) pairs.set(pair, (pairs.get(pair) || 0) + 1);
  }
  return [...pairs.values()].some((n) => n >= 3);
}

type LyricPass = { tag: string; tagAt: number; lines: string[] };

/** Every section pass below "Lyrics:" (before READBACK) with its tag, the index
 *  of its tag line in the script's lines (for sung lines before any tag, the
 *  "Lyrics:" heading's) and its sung lines, whole-line ad-libs left out. */
function lyricPasses(script: string): { rows: string[]; passes: LyricPass[] } {
  const rows = script.split('\n');
  const passes: LyricPass[] = [];
  const at = rows.findIndex((row) => /^\s*lyrics\s*:\s*$/i.test(row));
  if (at === -1) return { rows, passes };
  let current: LyricPass | null = null;
  for (let i = at + 1; i < rows.length; i++) {
    const line = rows[i].trim();
    if (/^READBACK:/i.test(line)) break;
    const tag = /^\[([^\]]*)\]$/.exec(line);
    if (tag) {
      current = { tag: tag[1].trim(), tagAt: i, lines: [] };
      passes.push(current);
    } else if (line && !/^\(.*\)$/.test(line)) {
      if (!current) {
        current = { tag: '', tagAt: at, lines: [] };
        passes.push(current);
      }
      current.lines.push(line);
    }
  }
  return { rows, passes };
}

/** How often a phrase is sung across these lines, as whole words; words in
 *  parentheses are echoes and are not counted. */
function timesSung(phrase: string, lines: string[]): number {
  let hits = 0;
  for (const line of lines) {
    const words = ` ${sayable(line)} `;
    for (
      let from = words.indexOf(` ${phrase} `);
      from !== -1;
      from = words.indexOf(` ${phrase} `, from + phrase.length + 1)
    )
      hits += 1;
  }
  return hits;
}

/** The chorus's hook: of its phrases (whole lines, and the pieces of a line
 *  between punctuation) that carry a real word, the one sung most often in this
 *  pass, the longer on a tie. */
function chorusHook(lines: string[]): { hook: string; shown: string; hits: number } {
  const shown = new Map<string, string>();
  for (const line of lines) {
    const whole = {
      said: sayable(line),
      raw: line
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    };
    for (const { said, raw } of [...phrasesOf(line), whole])
      if (said.includes(' ') && contentWords(said).length && !shown.has(said))
        shown.set(said, raw.replace(/[,;:!?.]+$/, ''));
  }
  let hook = '';
  let hits = 0;
  for (const said of shown.keys()) {
    const n = timesSung(said, lines);
    if (n > hits || (n === hits && said.length > hook.length)) [hook, hits] = [said, n];
  }
  return { hook, shown: shown.get(hook) || hook, hits };
}

/** How many lines of a section bring something new: two or more real words not
 *  yet sung in it, or at least half of the line's real words new. */
function linesWithNews(lines: string[]): number {
  const seen = new Set<string>();
  let news = 0;
  for (const line of lines) {
    const words = contentWords(sayable(line));
    const fresh = words.filter((w) => !seen.has(w));
    words.forEach((w) => seen.add(w));
    if (
      fresh.length >= 2 ||
      (words.length > 0 && fresh.length > 0 && fresh.length / words.length >= 0.5)
    )
      news += 1;
  }
  return news;
}

/** The longest run of three or more consecutive, different lines that open the
 *  same way: two shared opening words, or one when it is not a common opening. */
function openingRun(
  lines: string[],
  brief: string,
): { run: number; from: number; key: string } | null {
  let best: { run: number; from: number; key: string } | null = null;
  for (const width of [2, 1]) {
    let run = 1;
    for (let i = 1; i <= lines.length; i++) {
      const a = sayable(lines[i - 1]).split(' ');
      const b = i < lines.length ? sayable(lines[i]).split(' ') : [];
      const key = a.slice(0, width).join(' ');
      /* A wordless run (a na-na line) is a vocal, not a line of the list. */
      const same =
        b.length >= width &&
        a.length >= width &&
        b.slice(0, width).join(' ') === key &&
        sayable(lines[i - 1]) !== sayable(lines[i]) &&
        contentWords(sayable(lines[i - 1])).length > 0 &&
        contentWords(sayable(lines[i])).length > 0 &&
        (width === 2 || !COMMON_OPENINGS.has(bare(key)));
      if (same) {
        run += 1;
        continue;
      }
      if (run >= 3 && !hasWords(brief, key) && (!best || run > best.run)) {
        const opening = lines[i - 1]
          .replace(/\([^)]*\)/g, ' ')
          .trim()
          .split(/\s+/)
          .slice(0, width)
          .join(' ')
          .replace(/[,;:!?.]+$/, '');
        best = { run, from: i - run, key: opening };
      }
      run = 1;
    }
  }
  return best;
}

/** A line that stacks three or more clauses on the same opening: the same two
 *  words, or the same word when it is not a common opening. Clauses of one word
 *  (a word repeated for pressure) and clauses with no real word (a
 *  chant) do not count.
 *  Part 296 follow-up: a clause that opens on "the" is also counted by the words
 *  after it. Measured, "Same three cousins, same old dog, and the same damn
 *  everything" passed: "and" splits the line, and the last clause then opened
 *  on "the same", so the list counted only two. */
function stackedLine(line: string, brief: string): { n: number; key: string } | null {
  const parts = line
    .replace(/\([^)]*\)/g, ' ')
    .split(/,|;|—|–|\band\b|\bor\b/i)
    .map((part) => ({ said: sayable(part), raw: part.trim() }))
    .filter(
      (p, i, all) =>
        p.said.includes(' ') &&
        contentWords(p.said).length &&
        all.findIndex((q) => q.said === p.said) === i,
    );
  /* Different clauses only: one phrase sung three times is a chant (the chorus
   * gate counts it there), not a list of things. */
  const counts = new Map<string, { n: number; raw: string }>();
  for (const { said, raw } of parts) {
    const words = said.split(' ');
    const rawWords = raw.split(/\s+/);
    const keys: [string, string][] = [
      [words.slice(0, 2).join(' '), rawWords.slice(0, 2).join(' ')],
    ];
    if (!COMMON_OPENINGS.has(bare(words[0]))) keys.push([words[0], rawWords[0]]);
    if (bare(words[0]) === 'the') {
      const after = words.slice(1, 3).join(' ');
      if (words.length >= 3) keys.push([after, rawWords.slice(1, 3).join(' ')]);
      if (!COMMON_OPENINGS.has(bare(words[1]))) keys.push([words[1], rawWords[1]]);
    }
    /* One clause counts once for each opening it carries. */
    const once = keys.filter(([k], i) => keys.findIndex(([other]) => other === k) === i);
    for (const [key, shown] of once) {
      const had = counts.get(key);
      counts.set(key, { n: (had?.n || 0) + 1, raw: had?.raw || shown.replace(/[,;:!?.]+$/, '') });
    }
  }
  let best: { n: number; key: string } | null = null;
  for (const [key, { n, raw }] of counts)
    if (n >= 3 && !hasWords(brief, key) && (!best || n > best.n)) best = { n, key: raw };
  return best;
}

export type RepeatIssue = {
  /** The section tag as written, e.g. Chorus or Verse 2. */
  tag: string;
  /** A unique name for this section in a rewrite request (the tag, told apart when two differ). */
  label: string;
  /** Script line indices of the tag lines of every pass that carries these exact lines. */
  passes: number[];
  /** Is it a chorus (the rewrite writes a whole new one) or another section (named lines only)? */
  chorus: boolean;
  /** The pass's sung lines as written. */
  lines: string[];
  /** The hook as written, for a chorus. */
  hook: string;
  /** What the desk measured, in plain words. */
  problems: string[];
  /** How far over the line it is; the desk keeps the version that weighs less. */
  weight: number;
};

/** Measures one section pass. */
function sectionRepeats(
  tag: string,
  lines: string[],
  brief: string,
): { hook: string; problems: string[]; weight: number } {
  const problems: string[] = [];
  let weight = 0;
  let hook = '';
  const chorus = CHORUS_TAG.test(tag);
  const worded = lines.filter((line) => contentWords(sayable(line)).length);
  if (chorus && worded.length >= 2) {
    const found = chorusHook(worded);
    hook = found.shown;
    /* Part 296 review: a chorus she wrote into her own idea is hers. A hook her brief
     * sings more than twice, or a line it sings twice, is her design, not the desk's,
     * and is never counted against the song. (One mention of a hook leaves how often
     * to sing it to the desk.) */
    const briefSings = (phrase: string): number => (phrase ? timesSung(phrase, [brief]) : 0);
    const hersHook = briefSings(found.hook) > 2;
    const counts = new Map<string, number>();
    for (const line of worded) counts.set(sayable(line), (counts.get(sayable(line)) || 0) + 1);
    const repeated = [...counts].filter(([said, n]) => n >= 2 && briefSings(said) < 2);
    const distinct = counts.size;
    /* Her own repeated lines are not held against the count of different lines. */
    const hersExtra = [...counts]
      .filter(([said, n]) => n >= 2 && briefSings(said) >= 2)
      .reduce((more, [, n]) => more + n - 1, 0);
    if (found.hits > 2 && !hersHook) {
      problems.push(`the hook "${found.shown}" is sung ${found.hits} times in one chorus`);
      weight += found.hits - 2;
    }
    /* A line sung twice that does not carry the hook (lines that do are counted above). */
    const others = repeated
      .filter(([said]) => !found.hook || !` ${said} `.includes(` ${found.hook} `))
      .map(([said]) => worded.find((line) => sayable(line) === said) || said);
    if (others.length) {
      problems.push(
        `besides the hook, ${others.map((line) => `"${line}"`).join(' and ')} ${others.length === 1 ? 'is' : 'are'} sung more than once in it`,
      );
      weight += others.length;
    }
    if ((distinct + hersExtra) / worded.length < 0.75 && !hersHook) {
      problems.push(`only ${distinct} of its ${worded.length} lines are different`);
      weight += 1;
    }
    if (problems.length) {
      const news = linesWithNews(worded);
      if (news <= worded.length / 2)
        problems.push(`only ${news} of its ${worded.length} lines say anything the hook does not`);
    }
  }
  const ends = new Map<string, number>();
  for (const line of worded) {
    const word = endWord(line);
    if (word) ends.set(word, (ends.get(word) || 0) + 1);
  }
  for (const [word, n] of ends) {
    if (n < 3 || hasWords(brief, word)) continue;
    /* Part 296 review: outside a chorus the rewrite changes only the lines it is shown,
     * so they are quoted (the chorus is rewritten whole and needs no list). */
    const which = chorus
      ? ''
      : ` (${[...new Set(worded.filter((line) => endWord(line) === word))].map((line) => `"${line}"`).join(', ')})`;
    problems.push(`${n} of its lines end on the word "${word}"${which}`);
    weight += n - 2;
  }
  const run = openingRun([...lines], brief);
  if (run) {
    problems.push(
      `${run.run} lines in a row open with "${run.key}" (${lines
        .slice(run.from, run.from + run.run)
        .map((line) => `"${line}"`)
        .join(', ')})`,
    );
    weight += run.run - 2;
  }
  for (const line of [...new Set(lines)]) {
    const stack = stackedLine(line, brief);
    if (!stack) continue;
    problems.push(
      `the line "${line}" stacks ${stack.n} clauses that each open with "${stack.key}"`,
    );
    weight += stack.n - 2;
  }
  return { hook, problems, weight };
}

/** Part 296: the sections of a draft that repeat instead of saying something,
 *  one entry per distinct section (a chorus sung three times is one entry that
 *  names its three passes). Empty when there is nothing to fix. */
export function lyricRepeatIssues(script: string, brief = ''): RepeatIssue[] {
  const { passes } = lyricPasses(script);
  const issues: RepeatIssue[] = [];
  const byContent = new Map<string, RepeatIssue | null>();
  const labels = new Set<string>();
  /* Part 296 review: when the idea asks for a chant or for repetition, the chorus is
   * that chant and is left alone whole. Standing down only the hook count still sent
   * a requested chant to the rewrite for its openings and end words, and the rewrite
   * of a chorus sings the hook twice at most. The verses are still measured. */
  const chantAsked = briefWantsRepeats(brief) || briefRepeatsItself(brief);
  for (const pass of passes) {
    if (!pass.lines.length || EXEMPT_SECTION.test(pass.tag)) continue;
    const chorus = CHORUS_TAG.test(pass.tag);
    if (chorus && chantAsked) continue;
    const key = `${chorus ? 'chorus' : pass.tag.toLowerCase()}\n${pass.lines.map(sayable).join('\n')}`;
    if (byContent.has(key)) {
      const seen = byContent.get(key);
      if (seen) seen.passes.push(pass.tagAt);
      continue;
    }
    const measured = sectionRepeats(pass.tag, pass.lines, brief);
    if (!measured.weight) {
      byContent.set(key, null);
      continue;
    }
    const name = pass.tag || 'Lyrics';
    let label = name;
    for (let n = 2; labels.has(label.toLowerCase()); n++) label = `${name} (version ${n})`;
    labels.add(label.toLowerCase());
    const issue: RepeatIssue = {
      tag: name,
      label,
      passes: [pass.tagAt],
      chorus,
      lines: pass.lines,
      hook: measured.hook,
      problems: measured.problems,
      weight: measured.weight,
    };
    byContent.set(key, issue);
    issues.push(issue);
  }
  return issues;
}

/** The total weight of a draft's repeat issues: lower is better. */
export function lyricRepeatWeight(script: string, brief = ''): number {
  return lyricRepeatIssues(script, brief).reduce((n, issue) => n + issue.weight, 0);
}

const passCount = (issue: RepeatIssue): string =>
  issue.passes.length > 1 ? `, sung ${issue.passes.length} times` : '';

/** The audit's gate for what the desk measured. Empty when nothing repeats. */
/* Part 320: the audit's two measured gates besides the repeats. Each says exactly which sections
 * or parts are missing, because the audit gave the draft back unchanged in 10 of 12 songs when
 * it was only asked to "change what fails". */
function sizeGate(thin: ThinSection[], number: number): string {
  if (!thin.length) return '';
  const rows = thin.map(
    (s) =>
      `[${s.tag || SECTION_LABEL[s.kind] || s.kind}] has ${s.lines} lead line${s.lines === 1 ? '' : 's'} and wants at least ${s.need}${s.times > 1 ? ` (it comes back ${s.times} times at that size; change every copy the same way)` : ''}`,
  );
  return `\n${number}. SECTION SIZES, measured by the desk. These sections are too thin to carry a melody: ${rows.join('; ')}. Write the missing lines as new thoughts in the same voice, rhyme sound and rhythm, so each section climbs or answers instead of stopping early. Do not fill the gap by repeating a line, chanting the hook or restating the line above. Keep every line that is already there.`;
}

function backingGate(issue: BackingIssue | null, number: number): string {
  if (!issue) return '';
  const parts: string[] = [];
  if (issue.total < issue.need || issue.choruses.some((n) => n === 0))
    parts.push(
      `The draft has ${issue.total} backing part${issue.total === 1 ? '' : 's'} (a backing line in parentheses, or parentheses after a lead phrase)${issue.choruses.length ? `; the choruses carry ${issue.choruses.join(', ')} in order` : ''}. A song this size wants about ${issue.need}, at least one in every chorus and more in the last chorus. Add them the way an arranger would: an echo of a line's last word, a reply of one to four words, a harmony on the hook, a call-and-response between lead and backing voice, a gang shout or a hype ad-lib where the genre uses them. When the voices overlap, put the backing words after the lead phrase on the same line; when the backing voice sings alone, give it its own line in parentheses. Backing words never repeat a whole lead line, and a lead line keeps its words.`,
    );
  if (issue.parts && issue.echoes)
    parts.push(
      `${issue.echoes} of the ${issue.parts} backing parts only repeat the last words of the lead line. Turn at least half of those into replies, retorts, agreements, questions or asides that comment on or contradict the lead, and keep straight echoes for the build of the last chorus.`,
    );
  if (issue.directions.length)
    parts.push(
      `These parentheses hold directions, and a generator sings them aloud: ${issue.directions.map((d) => `"${d}"`).join(', ')}. Delete each one or turn it into a sung syllable or word.`,
    );
  return `\n${number}. BACKING VOCALS, measured by the desk. ${parts.join(' ')}`;
}

function liftGate(lift: boolean, pets: PetWord[], longLines: string[], number: number): string {
  const parts: string[] = [];
  if (lift)
    parts.push(
      'The last chorus says exactly what the first one said. Lift it without touching the hook: add one line, or change a line so it lands harder after everything the verses have said. More backing vocals on top are welcome and are not enough alone.',
    );
  if (longLines.length > 1)
    parts.push(
      `These lines are too long to sing at tempo: ${longLines
        .slice(0, 6)
        .map((l) => `"${l}"`)
        .join('; ')}. Split each into two lines or trim the tail, keeping the joke and the rhyme.`,
    );
  for (const p of pets)
    parts.push(
      `The word "${p.word}" fills ${p.lines.length} or more different lines (${p.lines.map((l) => `"${l}"`).join(', ')}). Keep it in one of them and give the others a sharper word, a number or the thing itself.`,
    );
  return parts.length
    ? `\n${number}. LIFT, WORDS AND LINE LENGTH, measured by the desk. ${parts.join(' ')}`
    : '';
}

function rhymeGate(report: RhymeReport | null, number: number): string {
  if (!report || !lyricRhymeWeight(report)) return '';
  const parts: string[] = [];
  if (report.lonely.length)
    parts.push(
      `These lines rhyme with nothing within three lines of them: ${report.lonely
        .slice(0, 8)
        .map((l) => `[${l.tag}] "${l.line}"`)
        .join(
          '; ',
        )}. Give each a rhyme partner by changing the end of that line or of a neighbour, keeping what it means.`,
    );
  for (const e of report.repeatedEnds)
    parts.push(
      `The word "${e.word}" ends ${e.lines.length} or more different lines (${e.lines.map((l) => `"${l}"`).join(', ')}). Change the end word of all but one of them, on the same rhyme sound when the pair needs it.`,
    );
  if (report.sameWord.length)
    parts.push(
      `A word cannot rhyme with itself: ${report.sameWord.slice(0, 4).join('; ')}. Give one line of each pair another end word.`,
    );
  if (report.worn.length)
    parts.push(
      `Worn rhyme pairs: ${report.worn
        .slice(0, 4)
        .map((w) => `${w.pair} in [${w.tag}]`)
        .join(', ')}. Rhyme the second line against something less expected.`,
    );
  for (const s of report.suffixStacks)
    parts.push(
      `[${s.tag}] closes ${s.words.length} or more lines on words that rhyme only because they share the ending ${s.family} (${s.words.join(', ')}). Keep at most two of them and rhyme the others on concrete words.`,
    );
  if (report.couplets)
    parts.push(
      `${report.couplets.sections} of ${report.couplets.of} sections run in plain couplets, which sounds like a nursery rhyme. Give the chorus a different scheme (alternating lines, or a run on one sound that ends on the hook) and the bridge another, keeping their meaning, their hook and their rhymes.`,
    );
  if (report.creative < report.need && report.plain.length)
    parts.push(
      `The song has ${report.creative} two-syllable, mosaic or internal rhymes, and a song this size wants about ${report.need}. Upgrade these plain couplets by rewriting the second line (or both) so the pair rhymes on two syllables, on a run of words that sounds like one longer word, or with an internal rhyme, without bending the grammar or changing what the line means: ${report.plain.map((p) => `[${p.tag}] "${p.first}" / "${p.second}"`).join('; ')}.`,
    );
  return `\n${number}. RHYME, measured by the desk from the sounds of the words. ${parts.join(' ')}`;
}

function repeatGate(issues: RepeatIssue[], number: number): string {
  if (!issues.length) return '';
  return `\n${number}. REPEATS, measured by the desk. ${issues.map((issue) => `[${issue.tag}]${passCount(issue)}: ${issue.problems.join('; ')}.`).join(' ')} Fix each where it stands. A chorus normally sings its hook word for word once or twice and develops the central thought with surrounding answers or consequences, leaving room for phrasing; change it the same way every time it comes back. Lines that open the same way get new openings, a word that ends too many lines gives way to other words on the same rhyme sound, and a line that stacks a list becomes one plain thought. Keep the hook, the rhyme sounds and the length.`;
}

type RepeatPart = RepeatIssue & {
  /** A later chorus that changed from the first one. */
  later: boolean;
  /** Not at fault itself, but carries the old chorus: rewritten with it so the song keeps one chorus. */
  companion: boolean;
};

/** The sections a rewrite asks for: the issues, and when the first chorus is at
 *  fault, every later chorus that changed from it (a final chorus with its one
 *  changed line), so the new chorus reaches every place the old one was sung.
 *  The request and the step that writes the answer in both build this list, so
 *  their labels agree. */
function repeatParts(script: string, issues: RepeatIssue[]): RepeatPart[] {
  const choruses = lyricPasses(script).passes.filter(
    (pass) => pass.lines.length && CHORUS_TAG.test(pass.tag),
  );
  const firstAt = choruses.length ? choruses[0].tagAt : NaN;
  const parts: RepeatPart[] = issues.map((issue) => ({
    ...issue,
    passes: [...issue.passes],
    later: issue.chorus && !issue.passes.includes(firstAt),
    companion: false,
  }));
  const main = parts.find((part) => part.chorus && part.passes.includes(firstAt));
  if (!main) return parts;
  const covered = new Set(parts.flatMap((part) => part.passes));
  const labels = new Set(parts.map((part) => part.label.toLowerCase()));
  const byContent = new Map<string, RepeatPart>();
  for (const pass of choruses) {
    if (covered.has(pass.tagAt)) continue;
    const key = pass.lines.map(sayable).join('\n');
    const had = byContent.get(key);
    if (had) {
      had.passes.push(pass.tagAt);
      continue;
    }
    let label = pass.tag;
    for (let n = 2; labels.has(label.toLowerCase()); n++) label = `${pass.tag} (version ${n})`;
    labels.add(label.toLowerCase());
    const part: RepeatPart = {
      tag: pass.tag,
      label,
      passes: [pass.tagAt],
      chorus: true,
      lines: pass.lines,
      hook: main.hook,
      problems: [],
      weight: 0,
      later: true,
      companion: true,
    };
    byContent.set(key, part);
    parts.push(part);
  }
  return parts;
}

/** Part 296: the one targeted rewrite when a section still repeats after the
 *  audit. Only the named sections come back; the desk writes them in, a new
 *  chorus into every pass that carried the old one. */
export function lyricRepeatRequest(script: string, issues: RepeatIssue[], brief = ''): string {
  const parts = repeatParts(script, issues);
  const main = parts.find((part) => part.chorus && !part.later);
  const many = parts.length > 1;
  const asks = parts.map((part, i) => {
    const head = `${i + 1}. [${part.label}]${passCount(part)}`;
    if (main && part.later) {
      /* Measured: told only to "carry the change over", the writer invented a new one
       * (a done-with-him song's last chorus turned into "I still love you"). So the
       * changed line is quoted and kept. */
      const first = new Set(main.lines.map(sayable));
      const changed = [...new Set(part.lines.filter((line) => !first.has(sayable(line))))];
      const keep =
        changed.length && changed.length <= 2
          ? ` Its changed line${changed.length > 1 ? 's' : ''} ${changed.map((line) => `"${line}"`).join(' and ')} ${changed.length > 1 ? 'stay' : 'stays'} word for word, in the same place in the chorus; everything else is your new [${main.label}].`
          : ` Write it as your new [${main.label}] with that same change carried over, and nothing else different.`;
      return `${head}: a later chorus that changed from the first one${part.companion ? '' : ', with the same problems'}.${keep}`;
    }
    const said = `${head}: ${part.problems.join('; ')}.`;
    if (part.chorus) {
      const later = part.later
        ? ' It is a later chorus: keep it as close to the first chorus of the song as it already is, with its own change.'
        : '';
      return `${said}\n   Rewrite it as a real chorus. Keep the hook${part.hook ? ` "${part.hook}"` : ''} word for word and sing it no more than twice: open and close on it, or sing it first and third. Surrounding lines should deepen or answer the thought without filler. Do not require new facts or a physical image in every line. Other lines are never sung twice, two lines in a row never open with the same words, and a word ends two of its lines at most. Keep about ${part.lines.length} lines, the same beat and a rhyme a listener can hear, and keep the lines short enough to shout: none longer than the longest line it has now.${part.passes.length > 1 ? ` It is sung every time the chorus comes back, so it has to hold up ${part.passes.length} times.` : ''}${later}`;
    }
    /* Part 296 review: this used to say "keep its last word where you can", which a
     * section flagged for one word ending three lines could only obey by failing. */
    return `${said}\n   Rewrite only the lines named: lines that open the same way get new openings, a line that stacks a list becomes one plain thought, and a word that ends too many lines gives way to other words on the same rhyme sound. Keep what each line says, its rhyme sound and its length. Return the whole section with every other line exactly as it is.`;
  });
  return `Think briefly: fix what is named, then write it out. Do not count syllables. Your song is below, and it stays exactly as it is except for the part${many ? 's' : ''} named here. The desk measured the song and found ${issues.length > 1 ? 'these sections' : 'this section'} repeating instead of saying something, which the owner of this desk hears as a writer who ran out of ideas:

${asks.join('\n\n')}

ORIGINAL BRIEF: ${JSON.stringify(brief)}
Keep every supplied lyric phrase, its repeated words and its dialect. Stay on the requested subject without adding a physical scene or moral payoff.
Keep the song's voice, its story, its attitude and who it is for. Return ONLY the rewritten part${many ? 's' : ''}, each under its label in square brackets exactly as written above (${parts.map((part) => `[${part.label}]`).join(', ')}), every line written out. Nothing else: no music direction, no other sections, no READBACK, no notes.

${script}`;
}

/** Part 296: writes a targeted rewrite into the draft. A returned section is
 *  taken only when it keeps about its length and weighs less than the one it
 *  replaces (a companion chorus: when it passes the gate), and it goes into
 *  every pass it names, a chorus into every place it is sung. A later chorus is
 *  taken only with the new first chorus, and gets that new chorus when its own
 *  answer is missing or fails, so the song keeps one chorus. The music
 *  direction, the tags, every other line and the READBACK stay as written.
 *  Null when nothing usable came back. */
export function applyRepeatRewrite(
  script: string,
  reply: string,
  issues: RepeatIssue[],
  brief = '',
): string | null {
  const blocks = new Map<string, string[]>();
  let open: string[] | null = null;
  for (const raw of String(reply || '').split('\n')) {
    const line = raw
      .trim()
      .replace(/^[*_#]+\s*|\s*[*_]+$/g, '')
      .trim();
    if (/^READBACK\b/i.test(line) || /^lyrics\s*:\s*$/i.test(line)) {
      open = null;
      continue;
    }
    const tag = /^\[([^\]]+)\]:?$/.exec(line);
    if (tag) {
      const key = tag[1].trim().replace(/\s+/g, ' ').toLowerCase();
      open = blocks.has(key) ? null : [];
      if (open) blocks.set(key, open);
      continue;
    }
    /* A section is one run of lines: a blank line or a code fence after it ends it, so
     * a note the writer adds underneath is never taken for sung words. */
    if (!line || /^```/.test(line)) {
      if (open && open.length) open = null;
      continue;
    }
    if (!open || (line.length >= 110 && /[.!?]["')]?$/.test(line) && !/^\(/.test(line))) continue;
    open.push(line);
  }
  const parts = repeatParts(script, issues);
  const usable = (part: RepeatPart): string[] | null => {
    const lines = blocks.get(part.label.toLowerCase());
    if (!lines) return null;
    const sung = lines.filter((line) => !/^\(.*\)$/.test(line));
    const n = part.lines.length;
    if (sung.length < Math.max(2, n - 2) || sung.length > n + 3) return null;
    /* Same beat: measured, a rap chorus of short shouts came back as long verse lines
     * (longest 7 syllables before, 13 after) while every good rewrite stayed within 2.
     * The desk's count is rough, hence the room. */
    if (Math.max(...sung.map(syllables)) > Math.max(...part.lines.map(syllables)) + 3) return null;
    const weight = sectionRepeats(part.tag, sung, brief).weight;
    return (part.companion ? weight === 0 : weight < part.weight) ? lines : null;
  };
  const main = parts.find((part) => part.chorus && !part.later);
  const mainLines = main ? usable(main) : null;
  const replace = new Map<number, string[]>();
  for (const part of parts) {
    let lines = part === main ? mainLines : usable(part);
    if (part.chorus && part.later && main) lines = mainLines ? lines || mainLines : null;
    if (lines) for (const at of part.passes) replace.set(at, lines);
  }
  if (!replace.size) return null;
  const rows = script.split('\n');
  const heading = rows.findIndex((row) => /^\s*lyrics\s*:\s*$/i.test(row));
  const readback = rows.findIndex((row, i) => i > heading && /^\s*READBACK:/i.test(row));
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    out.push(rows[i]);
    const lines = replace.get(i);
    if (!lines) continue;
    let end = i + 1;
    while (end < rows.length && end !== readback && !/^\s*\[[^\]]*\]\s*$/.test(rows[end])) end += 1;
    let keep = end;
    while (keep > i + 1 && !rows[keep - 1].trim()) keep -= 1;
    out.push(...lines, ...rows.slice(keep, end));
    i = end - 1;
  }
  return out.join('\n');
}

/* Part 293 follow-up (Sep 25 2026): "no lesson at the end" in the desk notes did
 * not stop tidy moral endings, and at low reasoning a general rule is skimmed.
 * So the desk pulls the exact lines the song and each chorus land on and puts
 * them in front of the producer as their own gate, last in the list. */
function endingGate(script: string, number: number): string {
  const lines = lyricEndingLines(script);
  if (!lines.length) return '';
  return `\n${number}. THE ENDING. These are the last two sung lines of the song, of each chorus pass, of the last verse and of the bridge, and any line the last chorus changed, pulled by the desk:\n${lines.map((l) => `   - "${l}"`).join('\n')}\n   Read each one on its own. Repair any unearned moral, cure or reversal. Keep requested encouragement, direct emotional statements and the supplied hook when they fit the subject; an unresolved problem can coexist with determination. Do not add a physical scene or new prop to prove the ending is concrete. Keep its rhyme sound and length, and change it the same way everywhere it repeats. A song can end unresolved. Lines that already land on a moment stay exactly as they are.`;
}

/* Part 296: gate 2 used to say the hook is "repeated verbatim, title landing four
 * to eight times". The system gives that count across a full song; said to the
 * producer of one draft it read as a count for one chorus, and the audit left
 * every collapsed chorus as it found it (9 of 9 stored, 8 of 8 fresh). It now
 * says where the count lives, and what the desk measured rides as its own gate.
 * Part 296 review: the audit never sees the idea, so when the idea asked for a
 * chant or for repetition, or spelled out a chorus that repeats (`brief`), gate 2
 * says so instead of cutting the hook to two, or the audit itself would flatten
 * what she asked for. */
export function lyricAuditRequest(
  script: string,
  tells: LyricTell[],
  shape: string | null = null,
  repeats: RepeatIssue[] = [],
  brief = '',
  gates: {
    thin?: ThinSection[];
    backing?: BackingIssue | null;
    rhyme?: RhymeReport | null;
    lift?: boolean;
    pets?: PetWord[];
    longLines?: string[];
  } = {},
): string {
  const rapped = /\b(?:rap|hip[ -]?hop|spoken[ -]word|grime|drill)\b/i.test(
    brief + '\n' + script.split(/^\s*lyrics\s*:/im)[0],
  );
  const cadence = rapped
    ? '5. FLOW AND MEANING. Check the bars against the requested groove, with internal and multisyllabic rhyme, deliberate stress placement, changes of cadence and usable breath points. Preserve intentional enjambment and unequal bar lengths. Do not force rap into four-stress couplets or predictable end rhymes. Every rhyme must serve the sentence, the character or the payoff; remove filler wordplay. Keep hooks memorable in the form the brief asks for.'
    : "5. SING-ALONG. Read the verses aloud against their groove. Preserve a coherent rhyme pattern and melodic stresses; prefer surprising but natural rhyme partners over predictable stock pairs. Nearly every line of a verse and chorus should land in a rhyme. Look for two-syllable, mosaic and internal rhymes, aim for at least two in each verse and one in the chorus, and keep them only where the line still means what it says. Do not count syllables yourself. If the desk flags uneven lines, check them by ear and change only lines that lose the groove, keeping deliberate pickups and held notes. The chorus needs a clear feeling and a memorable hook in this singer's own words. No worn rhyme pairs (fire and desire, heart and apart, love and above).";
  const hookCount =
    briefWantsRepeats(brief) || briefRepeatsItself(brief)
      ? 'The idea asked for this repetition (a chant, or a chorus it spelled out itself), so the chorus sings its hook as often as the idea does.'
      : 'It is sung word for word once or twice in each chorus, never more: the title lands because the chorus comes back, not because one chorus says it over and over. Every other chorus line says something the hook does not.';
  /* Part 296 follow-up: a kiss-off line is fixed by a new move, not by new words for the same
   * one, or the rewrite hands the same things back in other words. Named, never shown. */
  const kissOffs = tells.some((t) => t.tell.startsWith(KISS_OFF_TELL))
    ? '\nA line marked as the stock kiss-off needs a different move, not the same move in new words: nothing handed back or left behind for them in any wording, and no run of things the singer can do without. Give the singer something only this song has to do or say to this person instead: an action, a fact about the two of them, a joke or a comeback aimed at them.'
    : '';
  const flagged = tells.length
    ? `\n\nThese exact lines lean on default-reach words and must be rewritten, keeping each line's rhyme sound, stress count and length, the same way everywhere a line repeats, and never by swapping in another default-reach word:\n${tells.map((t, i) => `${i + 1}. "${t.line}" -- ${t.tell}`).join('\n')}${kissOffs}`
    : '';
  let next = shape ? 8 : 7;
  const sizes = sizeGate(gates.thin || [], next);
  if (sizes) next += 1;
  const backs = backingGate(gates.backing || null, next);
  if (backs) next += 1;
  const rhymes = rhymeGate(gates.rhyme || null, next);
  if (rhymes) next += 1;
  const lifts = liftGate(!!gates.lift, gates.pets || [], gates.longLines || [], next);
  if (lifts) next += 1;
  const repeatText = repeatGate(repeats, next);
  if (repeatText) next += 1;
  const endings = endingGate(script, next);
  return `Make one focused producer edit of the draft below. Keep working lines, the requested subject, the singer's language, and every supplied lyric phrase. Do not invent a different song to demonstrate improvement.

ORIGINAL BRIEF: ${JSON.stringify(brief)}

Check, in this order, and change only what fails:
1. TOPIC AND MEANING. Does the whole song answer the actual brief? Genre and vocal identity do not imply a romance. Reflective subjects need no invented physical scene. Every line should have a clear ordinary-language meaning; fix unclear pronouns, unrelated images and thoughts added only for rhyme. Personal context need not become the narrator's biography.
2. The hook. Keep supplied wording, repetitions and dialect exactly. ${hookCount} Let surrounding lines deepen or answer the feeling and leave room for the voice. Six to eight lines is a useful chorus default, not a quota. No compulsory syllable count, surprise, title flip or second hook.
3. DEVELOPMENT. Verses add another aspect, pressure, choice, consequence or event. A bridge may change perspective or phrasing. Do not demand a planted prop, plot turn, quirk or rewritten final chorus. For coping, let practical responses remain human language instead of clinical labels, and let frustration coexist with care.
4. EMOTIONAL HONESTY. Preserve the stance requested in the brief. Encouragement can coexist with continuing difficulty. No unearned cure, superiority speech, guaranteed victory or fairy-tale ending. A good chorus can return unchanged.
${cadence}
6. Singability. Natural speech stress, plausible breaths, manageable phrases and room for held notes. Preserve intentional long-short patterns, pickups and expressive repeats. Parentheses are sung backing vocals and ad-libs; production cues stay separate. Without a melody, do not claim exact timing or force equal syllable counts.${shape ? `\n7. Length. ${shape}` : ''}${sizes}${backs}${rhymes}${lifts}${repeatText}${endings}${flagged}${lyricMeterNote(script, brief)}

Last, find the three weakest lines in the song: filler, a line that explains the feeling instead of showing it, a rhyme chosen only to finish a pair, or words that could sit in five hundred other songs. Rewrite each so only this singer in this song could have said it, keeping its rhyme sound, stress and length.

Return the complete song in the same format: the music direction, the Lyrics: heading with every sung line and every chorus written out in full, then the READBACK line. One performed phrase per line, no blank lines within a section, one blank line between sections. Nothing else.

${script}`;
}

/** Take ONLY the sung words from a repair and keep the first draft's music
 *  direction and READBACK. Measured: the repair pass writes better lines but is
 *  careless with the wrapper -- it dropped the READBACK label once and the whole
 *  READBACK line once. Returns null when the repair cannot be trusted. */
/* Sep 20 2026, sung on Kade's harp song: a repair came back with the READBACK
 * reworded and its label gone, so the matching above found nothing and the engine
 * sang the description. Sung lines are short. Closing paragraphs made only of long
 * prose sentences (or a relabelled "Readback:") are never sung words. */
function dropTrailingProse(words: string): string {
  const blocks = words.trim().split(/\n\s*\n/);
  const prose = (block: string): boolean => {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return true;
    if (/^[*_#\s]*read\s?back\b/i.test(lines[0])) return true;
    return lines.every((l) => l.length >= 110 && !/^[[(]/.test(l) && /[.!?]["')*_]*$/.test(l));
  };
  while (blocks.length > 1 && prose(blocks[blocks.length - 1])) blocks.pop();
  return blocks.join('\n\n').trim();
}

export function mergeRepairedLyrics(
  original: string,
  repaired: string,
  maxGrowth = 1.4,
): string | null {
  const heading = /^\s*lyrics\s*:\s*$/im;
  const from = heading.exec(original);
  const to = heading.exec(repaired);
  if (!from || !to) return null;
  const tailAt = original.lastIndexOf('READBACK:');
  const tail = tailAt === -1 ? '' : original.slice(tailAt);
  let words = repaired.slice(to.index + to[0].length);
  const mark = words.lastIndexOf('READBACK:');
  if (mark !== -1) words = words.slice(0, mark);
  else if (tail) {
    // Label dropped: cut a trailing paragraph that is the readback in disguise.
    const opening = tail.replace(/^READBACK:\s*/, '').slice(0, 40);
    const at = opening.length >= 20 ? words.lastIndexOf(opening) : -1;
    if (at !== -1) words = words.slice(0, at);
  }
  words = dropTrailingProse(words);
  const sung = (t: string): number =>
    // A tag is a line that is ONLY a bracket. "[Her] You go first" is a sung line
    // (seen Sep 20 2026: a duet's audit was refused because nine such lines were
    // counted as tags and the repair looked like it had lost them).
    t.split('\n').filter((l) => l.trim() && !/^\s*\[[^\]]*\]\s*$/.test(l)).length;
  const before = original.slice(from.index + from[0].length, tailAt === -1 ? undefined : tailAt);
  if (!words || sung(words) < sung(before) * 0.9 || sung(words) > sung(before) * maxGrowth)
    return null;
  return `${original.slice(0, from.index + from[0].length).trimEnd()}\n${words}\n\n${tail}`.trimEnd();
}

/** Seen live: the writer left the "READBACK:" label off, so the spoken
 *  description rode at the end of the lyrics, where a singer would sing it. A
 *  final paragraph that is one long prose line after the sung words is the
 *  readback; give it its label back. Leaves a labelled draft alone. */
export function labelReadback(raw: string): string {
  // "Readback:", "**READBACK:**" and the like are the same label; the splitter only knows one spelling.
  raw = raw.replace(
    /^[ \t]*[*_#]*[ \t]*read\s?back[ \t]*[*_]*[ \t]*:[ \t]*[*_]*[ \t]*/im,
    'READBACK: ',
  );
  if (raw.includes('READBACK:') || !/^\s*lyrics\s*:/im.test(raw)) return raw;
  const lines = raw.trimEnd().split('\n');
  const last = lines[lines.length - 1].trim();
  const before = (lines[lines.length - 2] || '').trim();
  const prose = last.length >= 120 && /[.!?]["')]?$/.test(last) && !/^\s*[[(]/.test(last);
  if (!prose || before !== '') return raw;
  return `${lines.slice(0, -1).join('\n').trimEnd()}\n\nREADBACK: ${last}`;
}

export async function musicWritingPrompt(
  base: string,
  request: Request,
  readAgent: Reader,
  audience: SongAudience = null,
): Promise<string> {
  if (!writesMusic(request)) return seedWritingPrompt(base, request.engine, request.mode);
  const note = audienceNote(audience);
  const songName = request.engine === 'ace' ? 'ACE-Step XL' : 'YuE2';
  const direction =
    request.engine === 'yue2' || request.engine === 'ace'
      ? songName +
        ' direction is 25 to 45 words in one or two compact sentences: language, genre, rhythmic feel, a few defining instruments and the lead vocal character. No section-by-section arrangement narrative, production essay, technical duration line or story summary. The full development belongs in the lyrics and section tags, not in a Lyria-style brief. In the lyrics, mix the two forms of backing vocal: echoes in parentheses after a lead phrase, and a few replies or fills on a line of their own in parentheses.'
      : "Lyria direction is music production prose: genre, BPM and feel, instrumentation, the lead voice, backing vocals and arrangement dynamics as appropriate. Keep story and theme in the lyrics. Follow the engine format below for section shape and the technical line. In the lyrics, write backing vocals in parentheses after the lead phrase on the same line, which is the form Lyria's own prompt guide documents; a whole line in parentheses is for a wordless run or a fill.";
  const agent = await readAgent({ id: lyricAgentId });
  if (!agent?.instructions?.trim())
    throw Object.assign(
      new Error(
        "Lyric's writing instructions are temporarily unavailable. Your draft is kept; try again shortly.",
      ),
      { status: 503 },
    );

  return `You are Lyric, working the songwriting desk in Kade-AI's Sound Booth. Your saved persona below supplies your conversational character. The SONGWRITING CRAFT after it governs the actual lyric: where the persona demands a scene, rare repetition, fixed hook form or a story turn, the craft instructions win. Then come the owner's desk notes and the delivery format the audio engine needs.

LYRIC'S CURRENT SONGWRITING PERSONA

${agent.instructions}

${hitWritingSystem}

${musicWritingCraft}

${base}

${note ? `${note}\n\n` : ''}SOUND BOOTH DELIVERY CONTRACT
This is a single text-only writing request, not a conversation. Do not ask questions; make the creative choices and deliver. Do not access conversation history, personal memory, other agents, or audio tools.
Keep supplied lyrics exactly as the request instructs; do not rewrite them merely to improve their rhymes. Formatting-only work must preserve authored words.
The Sound Booth format below is the ONLY output format. There is no Lyrics Box, Tag Box or Negative Tag Box here. ${direction} Start with one TITLE: line containing ${request.title?.trim() ? `the person's chosen title, exactly: ${JSON.stringify(request.title.trim().slice(0, 80))}` : "a specific, original song title of at most 80 characters, taken from this song's hook, central joke or defining image; never a generic label such as Untitled or Your Song"}. Then output the music direction, a Lyrics: heading and the complete sung words when lyrics are requested, followed by the required READBACK: line. The TITLE: line is metadata, never a sung line or music direction. Never output commentary, a critique, rhyme annotations, a greeting or an offer to continue. Keep production instructions out of sung lines. Do not add lyrics to an instrumental request.
The TITLE: metadata line is an exception to the engine's direction-first, no-other-headings or direction-only instructions above. For an instrumental, return TITLE: followed by the music direction, with no Lyrics: heading or sung words.
Length check, when you wrote the lyrics yourself and the person gave no length: use the SECTION MAP sent with the request unless the brief needs another form, with enough lyric development for a complete song, ${request.engine === 'lyria' ? 'the technical line says about four minutes, ' : ''}and a short verse gains another relevant thought, choice or event rather than padding. Check topic, meaning, phrase space, section sizes, the rhymes, the backing vocals and supplied words once more. This check is private; the answer is always the complete draft in the format above, never a description of it.`;
}
