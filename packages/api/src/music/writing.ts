import type { IAgent } from '@librechat/data-schemas';
import { hitWritingSystem } from './hitSystem';

export const lyricAgentId = 'agent_9YHpms0vJoApICwshh0mR';
/* Chosen by side-by-side drafts on identical briefs (Part 212): Kimi K3 wrote
 * concrete, witty, well-rhymed verses where Grok 4.20 and 4.6 wrote filler
 * couplets, and it writes explicit lyrics when asked.
 * Sep 20 2026: Kade's word, "Switch the desk to deepseek flash v4.1", after the
 * Moonshot balance ran out and every draft failed with a 429. One probe on a
 * one-sentence brief: 27 s on low, about one cent, three full verses. To go
 * back to Kimi, restore 'moonshotai/kimi-k3' here; its price row is kept. */
export const lyricWritingModel = 'deepseek/deepseek-v4.1-flash';
type Reader = (filter: { id: string }) => Promise<Pick<IAgent, 'name' | 'instructions'> | null>;
type Request = { engine: string; mode: string; patient?: boolean; deep?: boolean };

const writesMusic = (request: Request): boolean =>
  ['lyria', 'yue2'].includes(request.engine) && request.mode === 'write';

/* The shared gateway only thinks when its classifier calls a message complex. A
 * one-sentence song idea is classed simple, so thin briefs were written in
 * seven seconds with no reasoning. The desk asks for reasoning itself; the
 * gateway respects an explicit choice. Reasoning tokens count against
 * max_tokens, hence the larger budget. Measured on Kimi K3: low effort 25 to
 * 30 seconds, medium 73 to 111, high up to 180, and a reasoning max_tokens cap
 * ran past 300. iPhone build 302 abandons this request at 120 seconds, so the
 * desk uses low, gives up first and says so. Low still wrote the better song. */
export function musicWritingSettings(request: Request): {
  model?: string;
  temperature?: number;
  top_p?: number;
  maxTokens?: number;
  timeoutMs?: number;
  reasoning?: { enabled: boolean; effort: 'low' | 'medium'; exclude: boolean };
} {
  if (!writesMusic(request)) return {};
  /* Part 218: Kade, "I want the best lyrics I can get, even if it means waiting."
   * The draft runs as a background job, so no web request has to stay open and
   * the writer can think on medium (275 s measured with the system in the
   * prompt). The audit that follows stays on low; the handler sets that.
   * Sep 20 2026: budgets raised by 8,000 each after a DeepSeek draft spent its
   * whole 16,000 thinking about rhyme and meter and came back cut off mid-bridge.
   * Part 293 follow-up (Sep 25 2026): 2 of 14 deep drafts spent all 32,000 on
   * thinking and came back with no lyrics, and the retry took the job to 276 and
   * 324 s. OpenRouter's /api/v1/models lists deepseek/deepseek-v4.1-flash with a
   * 131,072-token max output on its top provider, and 131,072 or more on every
   * endpoint but one (BaseTen, 32,768), so the deep lane gets 48,000: another
   * ~75 s of thinking at the measured ~215 tokens a second, well inside the
   * job's 600 s, and about two cents at most. The phone and web lanes keep 24,000. */
  if (request.deep)
    return {
      model: lyricWritingModel,
      temperature: 0.85,
      top_p: 0.95,
      maxTokens: 48000,
      timeoutMs: 600000,
      reasoning: { enabled: true, effort: 'medium', exclude: true },
    };
  /* Part 217: the website's own page says it can wait (it aborts at 240 s). iPhone
   * build 302 sends no such flag and gives up at 120 s, so it keeps the 112 s limit. */
  /* Measured with the hit-writing system in the prompt: medium effort wrote the
   * best song of the night and took 275 seconds, past any web request. So both
   * lanes draft on low and then run one low-effort producer's audit (about 30 s
   * plus 40 s). The patient flag only buys time, so the audit always has room. */
  if (request.patient)
    return {
      model: lyricWritingModel,
      temperature: 0.85,
      top_p: 0.95,
      maxTokens: 24000,
      timeoutMs: 225000,
      reasoning: { enabled: true, effort: 'low', exclude: true },
    };
  return {
    model: lyricWritingModel,
    temperature: 0.85,
    top_p: 0.95,
    maxTokens: 24000,
    timeoutMs: 112000,
    reasoning: { enabled: true, effort: 'low', exclude: true },
  };
}

export const musicWritingCraft: string = `DESK NOTES FROM THE OWNER (these outrank the system above where they differ)
- Words the person supplied are theirs. Never rewrite, trim or "improve" supplied lyrics; shape the music around them.
- The songs have been coming out too short. Follow the desk's lyric budget: about four minutes, 45 to 65 sung lines counting every written-out chorus. The desk draws a SECTION MAP for each song and sends it with the request, under the idea. Use that map unless the idea clearly wants another; if the brief gives its own length or structure, the brief wins and no map is sent. Every verse is new story, verse two is not a shorter copy of verse one, and the last verse or the bridge carries the turn. End the song where the map ends it. Use the section tags the map names, each alone on its line.
- Her named pet hates, in her words: "Everything's always a tuesday, drinks are always coffee, scenes are clean." Never name a weekday or a clock time, never reach for coffee, the porch light, the kitchen table, neon, shadows, whispers or echoes, and never use clean, steady or scene as filler, unless her own brief used the word. Ask what THIS singer actually has in their hands, where exactly they are and what they would really drink, and write that.
- The music direction chooses the lead voice, its range and its delivery for this song and this genre. There is no house voice at this desk.
- SING-ALONG FIRST. Her verdict on this desk's drafts (Sep 20 2026): "it's still not sounding like a song I would sing along to at all. It still feels like literary work." She is right, and where the system above disagrees with the rules below, these win:
  1. RHYME YOU CAN HEAR. Every verse is built in couplets (AABB) or alternating lines (ABAB, or XAXA at the very least), and the rhyming word is the LAST word of the line. Perfect rhymes and strong slant rhymes both count; a vowel that merely looks similar does not. A listener must be able to guess the last word of a line before it lands. The chorus rhymes too, and the title line has a rhyme partner. The system's advice to leave lines unrhymed and avoid tidy couplets is for a writer who over-rhymes. This desk under-rhymes. At most ONE deliberately unrhymed line in the whole song. Slant rhyme counts as rhyme. Never twist word order or grammar to land a rhyme; if a line has to bend to reach its rhyme, rewrite the line. Skip the nursery-rhyme pairs everyone has heard a thousand times.
  2. ONE METER PER SECTION. Choose a syllable count for the verse lines and hold it within one syllable, line after line, and match verse one's count in every verse after it so the same tune fits them all. Long line, short line, long line, short line is fine if it repeats exactly. A verse whose lines run 5, 12, 7 and 10 syllables cannot be sung. Do not count syllables one by one while you think; that burns the whole budget and the song comes back cut off. Pick a beat (four stresses a line is the workhorse), say each line to it once, and move on. The desk counts afterwards and will tell you which verses wander.
  3. THE CHORUS STATES THE HOOK. The verses can show; the chorus TELLS. It is the singer saying the feeling straight out in words a ten year old knows, short lines, the title first or last, built to be shouted by a car full of people. Four to six lines plus repeats. No chorus made of description.
  4. SONG, NOT SHORT STORY. No more than two observed details per verse, and each one something only this song could contain. Skip the props recent drafts keep reaching for, unless her brief names them: rain on the window, a swing and its chain, doors, windows, plates, a phone, the TV. The rest is the singer talking, to someone, in plain sentences. Cut every line that only notices something unless the next line cashes it in. No understatement contests, no trailing off, no "and that's that". The opposite failure is just as dead: lines so general they could sit in a thousand songs. Plain words, exact facts. Verses this desk sizes itself run eight lines or more.
  5. LET IT BE FUN. Jokes, stories where something happens, animals, kids, bragging, nonsense syllables, call and response, a bit the crowd does. A children's song or a comedy song gets the same craft and none of the melancholy.
  6. More of her pet hates: humming or a hum of any kind (the heater, the fridge, the engine, a tune), "knowing" as a noun or a mood ("the knowing", "a knowing look"), anything done "slow", and the radio playing a song that comments on the scene.
- WRITE IT LIKE A PERSON WROTE IT. From the songwriting prompt she uses elsewhere; these hold alongside the rules above.
  - Trust the listener. When a line lands, move on. Never explain a joke. Never follow a sad line with one saying how sad the singer is. No lesson at the end and no inspirational turnaround nobody earned: grief can stay grief, anger can stay anger, a fight can stay unresolved, and the singer can still want the person they shouldn't.
  - Give the singer a personality: opinions, bad habits, pettiness, contradictions, wants, and a way of talking you would recognise across a room. They do not have to be the good guy. Songs are not HR training videos.
  - Every line earns its spot. Cut or rewrite any line that could sit in 500 other songs, exists only for the rhyme, explains the line before it, or only links two better lines. Plain words with a sharp observation beat fancy words with nothing behind them. No thesaurus poetry, and never turn a feeling into a person just to get a rhyme.
  - Comedy: take the premise seriously enough for the joke to work. Start with a believable version and escalate. Use callbacks and misdirection; set up an expectation and wreck it. Specific beats random. Never explain the punchline.
  - The hook can be a phrase, a question, a command, a ridiculous image, a repeated word or a punchline. Take the title from the hook or from the central joke.
  - Genre, briefly. Punk and emo: shoutable lines, hard consonants, specific grievances, not eyeliner and darkness. Rap: cadence and internal rhyme, things a person would actually say, no vocabulary flexing and no generic bragging. Country and folk: a truck, a porch or a bottle shows up only when something happens there. R&B: desire lives in bodies and rooms more than in declarations, and the singer needs room to move. Pop: the idea is brutally clear in one sentence. Experimental may break the shape, never into nonsense.
- Do the SONG SPEC and the hook lab silently before the first line, and the QUALITY GATES silently after the last. Then one last silent check on every line: could another good songwriter surprise me with this? Are there a few lines somebody would quote, caption or yell with friends the next morning? If not, rewrite until there are. Deliver only the finished song.`;

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

const audienceNote = (audience: SongAudience | undefined): string =>
  audience === 'explicit' ? SONG_EXPLICIT_NOTE : audience === 'clean' ? SONG_CLEAN_NOTE : '';

/* Part 216 (Sep 19 2026). Her words: "Everything's always a tuesday, drinks are
 * always coffee, scenes are clean." The desk runs the writer on low reasoning so
 * it fits the phone's 120 seconds, which means the "revise privately" paragraph
 * above mostly does not happen. So the kill scan from her own v7 songwriting
 * system is done here, in code, on the finished draft: find the tells, and if
 * there are any, hand the writer the exact lines to replace. High precision on
 * purpose; a false alarm costs one rewritten line, a miss costs her trust. A
 * term the person used in their own brief is theirs and is never flagged. */
const LYRIC_TELLS: [string, RegExp][] = [
  ['a named weekday', /\b(?:mon|tues|wednes|thurs|fri|satur|sun)days?\b/i],
  ['a stock clock time', /\b(?:two|three|four|2|3|4)\s?a\.?\s?m\b\.?|\bmidnight\b|\bgolden hour\b/i],
  ['coffee', /\bcoffee\b|\bespresso\b|\blatte\b/i],
  ['the porch light', /\bporch ?lights?\b|\bfront porch\b/i],
  ['the kitchen table', /\bkitchen (?:table|floor|sink)\b/i],
  ['a stock prop', /\b(?:cigarettes?|ashtrays?|whiske?y|rearview|voicemails?|missed calls?|polaroids?|mixtapes?|streetlights?|headlights?|city lights)\b/i],
  ['neon, shadows, whispers or echoes', /\b(?:neon|shadows?|whisper(?:s|ed|ing)?|echo(?:es|ed|ing)?|ghosts?|embers?|ashes)\b/i],
  ['four walls', /\bfour walls\b/i],
  ['"clean" or "steady" as filler', /\b(?:clean|steady)\b/i],
  ['"scene" or "scenes"', /\bscenes?\b/i],
  ['humming', /\bhumm?(?:s|ed|ing|in['’]?)?\b/i],
  ['"knowing" as a mood', /\b(?:the|a|that|this|some) knowing\b|\bknowing (?:look|smile|glance|eyes?)\b/i],
  ['a stock phrase', /\b(?:clean slate|fresh start|moving on|turn(?:ed|ing)? the page|still standing|beautiful disaster|meant to be|what we had|weight of the world)\b/i],
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
  ['a greeting-card phrase', /\b(?:break(?:ing|in['’]?|s)? (?:these|the|my|those) chains|war (?:inside|in) my head|battle scars?|beautiful mess|perfectly imperfect|shattered pieces|my truth|found my voice|ch(?:ose|oose|oosing) myself|finally free)\b/i],
  ['a lesson-learned line', /\bi(?:['’]ve)? learn(?:ed|t) (?:how )?to (?:let (?:it |you |them |him |her |that |this )?go|love (?:myself|me|again)|breathe|fly(?=\s*(?:[.,!?;:()—–-]|$))|stand(?: tall| on my own)?|be (?:strong|free|me|myself|okay|ok|alone|brave|enough|happy)|live (?:again|without)|walk away|move on|forgive|heal|trust (?:myself|again)|smile again|shine|rise|survive|say no)\b|\bi(?:['’]ve)? learn(?:ed|t) (?:how )?to(?=[\s.,!?;:—–-]*$)|\bnow i know\b|\bi survived(?=\s*(?:[.,!?;:()—–-]|$|it all\b|the (?:storm|fire|worst)\b))|\bi(?:['’]m| am)(?: more than| still| finally| always| already)? enough(?=\s*(?:[.,!?;:()—–-]|$)|\s+for (?:me|myself|you|anyone|them|him|her|us)\b|\s+(?:just )?as i am\b)|(?:\bfound myself|\bfinding myself|(?<=(?:\bto|\bgonna|\bgotta|['’]ll|\bwill|\bcan|\bmust|\bmight)\s)find myself|\bfind myself(?= again\b))(?: again)?(?=[\s.,!?;:—–-]*(?:\([^)]*\)[\s.,!?;:—–-]*)?$)/i],
  ["the desk's own filler", /\b(?:(?:say|said|saying) it plain|on cue|the wild part|sitt?ing pretty|sittin['’]? pretty)\b/i],
  ['a worn image word', /\bdemons\b|\bshimmer(?:s|ed|ing)?\b|\bunfold(?:s|ed|ing)?\b(?!\s+(?:the|a|an|my|your|his|her|our|their|that|this|it|them|up)\b)|\bvalidation\b|\bvibrations?\b|(?<!\b(?:radio|police|scanner|cb|ham|fm|am|shortwave|short-wave|emergency|fire|weather)\s)\bfrequenc(?:y|ies)\b|(?<!\bin a\s)\bheartbeats?\b|(?<!\bthe\s)\belectric\b(?!['’]s\b)(?!\s+(?:guitar|piano|bass|keys|keyboard|organ|slide|bill|compan(?:y|ies)|co-?op|fence|chair|blanket|razor|can opener|drill|car|stove|fan|heater|meter|pump|light|blue|cart|bike|scooter|motor|mower|train|wire|line|pole|shock|heat|oven|range|dryer|avenue|eel|kettle|toothbrush|smoker|grill|saw|truck|boat)(?:e?s)?\b)|(?<=\bthe\s)electric(?=\s+(?:feeling|touch|spark|sparks|charge|current|air|night|energy|love|kiss|pulse|thrill|rush|chemistry|glow|buzz|tension|connection|moment|vibes?)\b)/i],
  ['a worn image word', /(?<!\b(?:[Tt]he|THE|[Tt]hat|THAT|[Tt]his|THIS|[Aa])\s)(?<![A-Z][A-Za-z'’]*\s)\bHollow(?:ness)?\b|(?<!\b(?:[Tt]he|THE|[Tt]hat|THAT|[Tt]his|THIS|[Aa])\s)\b(?:hollow(?:ness)?|HOLLOW(?:NESS)?)\b|(?<=\b[Aa]\s)(?:hollow|Hollow|HOLLOW)\b(?!['’]s\b|\s+(?:by|in|on|at|past|near|under|behind|below|beyond|where|down|up|off|out|over|beside|between|to|from|with)\b|\s*[,.;:!?)—–-]|\s*$)/],
  ['"I don\'t need X, I need Y"', /\bi (?:don['’]?t|do not|ain['’]?t) need\b[^.!?]*?[,;:—–-]\s*(?:but )?(?:i (?:just |only |really )?|just |only )(?:need|want)\b/i],
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
 * the commonest giveaway phrases are scanned for, ONLY in the last four sung
 * lines of the song, where they sum the song up; the same words earlier in a
 * song are ordinary speech. Each is narrowed where plain speech uses it:
 * "turns out" not when somebody turns out the lights or the town turns out,
 * "after all" only closing a clause (never "after all the chairs"), "in the
 * end" only opening or closing a clause (never "the end zone"). */
export const ENDING_TELL = 'a tidy ending: it sums the song up, states a lesson or turns it around';
const ENDING_GIVEAWAYS: RegExp =
  /(?:^|[,;:—–-]\s*|\b(?:it|it's|it has|guess|and|but|so|well|now|oh|yeah)\s+)turn(?:s|ed)? out\b(?!\s+(?:the |my |your |his |her |our |their |that |those |these )?(?:lights?|lamps?|pockets?|porch|candles?|fire|stove|oven|burners?|gas|dogs?|cows?|horses?|cattle|goats?|chickens?)\b)|\bthe lucky ones?\b|\bafter all(?=\s*(?:[.,!?;:)—–-]|$))|(?:^|[,;:—–-]\s*|\b(?:and|but|so)\s+)in the end\b(?!\s+(?:of|zone|stall|seat|booth|row|lane|spot|slot|room|unit|table|chair|pew|bed|house|lot))|\bin the end(?=\s*(?:[.,!?;:)—–-]|$))|\band that['’]?s (?:okay|ok|o\.k\.|alright|all right|fine)\b|\bbest (?:present|gift|thing)s? (?:of all|anyway)\b|\bthat['’]?s all (?:that )?matters\b|\bwouldn['’]?t change a thing\b|\ball along(?=\s*(?:[.,!?;:)—–-]|$))/i;

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

/** The giveaway endings among the last four sung lines; a phrase from the
 *  person's own brief is theirs and is never flagged. */
export function lyricEndingTells(script: string, brief = ''): LyricTell[] {
  const found: LyricTell[] = [];
  for (const { line } of sungLines(script).slice(-4)) {
    const hit = ENDING_GIVEAWAYS.exec(line);
    if (!hit || brief.toLowerCase().includes(hit[0].trim().toLowerCase()) || found.some((t) => t.line === line)) continue;
    found.push({ line, tell: ENDING_TELL });
  }
  return found;
}

/** The sung lines of a draft that lean on a stock tell. Looks only below the
 *  "Lyrics:" heading, skips section tags, and reports each distinct line once. */
export function lyricTells(script: string, brief = ''): LyricTell[] {
  const at = script.search(/^\s*lyrics\s*:/im);
  if (at === -1) return [];
  const found: LyricTell[] = [];
  const seen = new Set<string>();
  const endings = new Map(lyricEndingTells(script, brief).map((t) => [t.line, t]));
  for (const raw of script.slice(at).split('\n').slice(1)) {
    const line = raw.trim();
    if (!line || /^\[[^\]]*\]$/.test(line) || /^READBACK:/i.test(line) || seen.has(line)) continue;
    if (EXAMPLE_LINES.has(plain(line))) {
      seen.add(line);
      found.push({ line, tell: "copied from the writing system's own examples; write your own" });
      continue;
    }
    for (const [tell, pattern] of LYRIC_TELLS) {
      const hit = pattern.exec(line);
      if (!hit || brief.toLowerCase().includes(hit[0].toLowerCase())) continue;
      seen.add(line);
      found.push({ line, tell });
      break;
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
 *  audit's ENDING gate: the last two sung lines of the song and of each chorus
 *  pass, each distinct line once, in song order. */
export function lyricEndingLines(script: string): string[] {
  const lines = sungLines(script);
  const picked = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const { section, pass } = lines[i];
    const lastOfPass = i === lines.length - 1 || lines[i + 1].pass !== pass;
    if (lastOfPass && /^(?:final |last )?(?:chorus|hook|refrain)\b/i.test(section)) {
      if (i > 0 && lines[i - 1].pass === pass) picked.add(lines[i - 1].line);
      picked.add(lines[i].line);
    }
  }
  for (const { line } of lines.slice(-2)) picked.add(line);
  return lines.map((l) => l.line).filter((line, i, all) => picked.has(line) && all.indexOf(line) === i);
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
    plan: '[Verse 1] -> [Chorus] -> [Verse 2] -> [Chorus] -> [Bridge] -> [Verse 3] -> [Chorus]. Verses of eight to twelve lines. The bridge is two to four lines and comes before verse three, which is the payoff. The song ends on that last chorus: no outro.',
    twoVerseLines: Infinity,
    addVerse: 'after the bridge and before the last chorus',
  },
  twoLong: {
    id: 'twoLong',
    name: 'two long verses, a bridge and a final chorus',
    plan: '[Verse 1] -> [Chorus] -> [Verse 2] -> [Chorus] -> [Bridge] -> [Final Chorus] -> [Outro]. Each verse runs twelve to sixteen lines and moves the story on. The bridge is two to six lines. The [Final Chorus] changes one word or one line so it reads differently now. The outro is two to four lines.',
    twoVerseLines: 12,
    addVerse: 'before the bridge',
  },
  prePost: {
    id: 'prePost',
    name: 'verse, pre-chorus, chorus and a post-chorus',
    plan: '[Verse 1] -> [Pre-Chorus] -> [Chorus] -> [Post-Chorus] -> [Verse 2] -> [Pre-Chorus] -> [Chorus] -> [Post-Chorus] -> [Bridge] -> [Chorus] -> [Post-Chorus]. Verses of eight to twelve lines. The pre-chorus is two to four lines that climb. The post-chorus is two to four lines on one short repeated phrase or a wordless run, the part that sticks. The song ends on the post-chorus.',
    twoVerseLines: 8,
    addVerse: 'with its pre-chorus, before the bridge',
  },
  hookFirst: {
    id: 'hookFirst',
    name: 'open on the chorus, then three verses',
    plan: '[Chorus] -> [Verse 1] -> [Chorus] -> [Verse 2] -> [Chorus] -> [Verse 3] -> [Chorus] -> [Outro]. No intro: the first thing sung is the chorus. Verses of eight to ten lines. The outro is two to four lines built from a piece of the hook, and it stops.',
    twoVerseLines: Infinity,
    addVerse: 'before the last chorus',
  },
  storyRefrain: {
    id: 'storyRefrain',
    name: 'a story song with a refrain line instead of a big chorus',
    plan: '[Verse 1] -> [Verse 2] -> [Verse 3] -> [Bridge] -> [Verse 4]. No chorus section. Every verse is eight to twelve lines and closes on the same one-line refrain that carries the title. The bridge is two to four lines. The song ends on the last verse and its refrain: no outro.',
    twoVerseLines: Infinity,
    addVerse: 'as the last verse, closing on the refrain',
  },
  dance: {
    id: 'dance',
    name: 'a dance-floor song with a drop and a breakdown',
    plan: '[Intro] -> [Verse 1] -> [Pre-Chorus] -> [Chorus] -> [Drop] -> [Verse 2] -> [Pre-Chorus] -> [Chorus] -> [Breakdown] -> [Chorus] -> [Drop]. The intro is one or two lines or a chant. Verses of eight to ten lines. The pre-chorus builds in two to four lines. Each drop is two to four lines chanting one short phrase from the chorus for the crowd to shout. The breakdown strips down to the voice and one instrument for two to four lines. The song ends on the drop.',
    twoVerseLines: 8,
    addVerse: 'with its pre-chorus, before the breakdown',
  },
};

/** The brief set its own length or structure: theirs wins, no map is drawn and
 *  the length check stands down. */
const briefSetsShape = (brief: string): boolean =>
  /\b(?:verses?|minutes?|seconds?|short|brief|quick|jingle|hook only|chorus only|no chorus|one verse|two verses|bars|pre-chorus|post-chorus|refrain|song structure|sections?)\b/i.test(brief);

/* Genre decides which maps are in the hat: the drop and breakdown only for a
 * dance style; a chorus-less story song not for pop, a girl group or the club. */
const DANCE_STYLE =
  /\b(?:edm|techno|trance|disco|dubstep|drum (?:and|&|n['’]?) bass|dnb|eurodance|hyperpop|reggaeton|dancehall|jersey club|crunk|rave|(?:deep|tech|acid|progressive|electro|future|tropical) house|house (?:music|track|song|banger)|club (?:song|track|banger|anthem|mix|remix|hit)|dance (?:song|track|pop|anthem|banger|floor|music|remix)|dancefloor|four[- ]on[- ]the[- ]floor)\b/i;
const BIG_CHORUS_STYLE = /\b(?:pop|girl group|boy band|anthem|arena|stadium|k-?pop|j-?pop|power ballad)\b/i;

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
export function lyricShapeIssue(script: string, brief = '', map?: SectionMap | null): string | null {
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
  const tail = 'It must turn the story: pay off a detail planted earlier, or say what the narrator has been avoiding. New events, not a summary.';
  if (map) {
    if (verses === 0 || verses >= 3) return null;
    const need = map.twoVerseLines;
    if (verses === 2 && Math.min(...lengths) >= need) return null;
    if (verses === 2 && need !== Infinity) {
      const which = lengths.map((n, i) => (n < need ? `[Verse ${i + 1}] has ${n}` : '')).filter(Boolean).join(' and ');
      return `The map for this song is ${map.name}, and each verse needs at least ${need} sung lines: ${which}. Lengthen each short verse to ${need} lines or more with what happens next, in the same voice and meter. ${tail}`;
    }
    const lines = need !== Infinity && need > 8 ? `${need} to ${need + 4}` : 'eight to twelve';
    return `The song has only ${verses === 1 ? 'one verse' : 'two verses'}, and the map for this song is ${map.name}. Add a [Verse ${verses + 1}] of ${lines} sung lines in the same voice, ${map.addVerse}. ${tail}`;
  }
  if (verses === 0 || verses >= 3) return null;
  if (verses === 2 && Math.min(...lengths) >= 12) return null;
  const short = verses === 1 ? 'one verse' : Math.max(...lengths) >= 12 ? 'two verses, one of them short,' : 'two short verses';
  return `The song has only ${short} and this desk writes three verses, or two long ones of twelve to sixteen lines each. Add a [Verse ${verses + 1}] of eight to twelve sung lines in the same voice, placed after the bridge if there is one and before the final chorus, otherwise before the last chorus. ${tail}`;
}

export function lyricRepairRequest(script: string, tells: LyricTell[], shape: string | null = null): string {
  if (!tells.length && shape)
    return `Your draft is below. It is good and it stays, word for word. One thing is missing. ${shape} Every existing line, the music direction, the section tags and the READBACK line must come back exactly as they are. Return the complete draft in the same format and nothing else.\n\n${script}`;
  return `Your draft is below. It is good and it stays. Only these lines lean on stock images that the owner of this desk hears as machine writing:

${tells.map((t, i) => `${i + 1}. "${t.line}" -- ${t.tell}`).join('\n')}
${shape ? `\nAlso: ${shape}\n` : ''}
Rewrite ONLY those lines. For each, ask what this narrator actually has in their hands, where exactly they are, what they would really drink, and what day or hour it is for someone with their life, and write that: a specific nobody has heard in a song. Keep each new line's rhyme sound, stress count and approximate length so it still sings in the same slot, and keep the joke or the turn if the old line had one. If a flagged line repeats (a chorus or a hook), change it the same way everywhere it appears. If the flagged word is the song's title or hook word, find a better hook word and carry it through. Do not swap one stock image for another from the desk's list. Every other line, the music direction, the section tags and the READBACK line must come back exactly as they are. Return the complete corrected draft in the same format and nothing else.

${script}`;
}

/** A whole-line parenthesis that is a stage direction, not a sung ad-lib, gets
 *  sung by the generator as words. Seen: "(Whistling)", "(Claps and bass only)".
 *  Turn those into bracket cues; leave real ad-libs and echoes alone. */
export function fixStageDirections(script: string): string {
  const cue = /^\s*\(([^()]*\b(?:whistl\w*|instrumental|solo|fades?|fading|band|guitars?|bass|drums?|claps?|piano|strings|horns?|beat|music|spoken|humming|hummed)\b[^()]*)\)\s*$/i;
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
/* Sep 20 2026. Models cannot count syllables, and "hold one meter" in a prompt
 * changed nothing measurable. So the desk counts (roughly: vowel groups, silent
 * final e dropped) and hands the audit the numbers for every verse whose lines
 * wander by more than four syllables. Rough is fine; the instruction is to even
 * the lines out, and a miscount of one does not change that. */
const syllables = (line: string): number =>
  line
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .reduce((n, word) => {
      const w = word.replace(/'/g, '').replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
      return n + Math.max(1, (w.match(/[aeiouy]{1,2}/g) || []).length);
    }, 0);

export function lyricMeterNote(script: string): string {
  const at = script.search(/^\s*lyrics\s*:/im);
  if (at === -1) return '';
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
    ? `\n\nCounted by the desk (roughly), these verses cannot carry one tune: ${uneven.join('; ')}. Even each verse out so lines in the same position match within one syllable, and so every verse matches verse one.`
    : '';
}

/* Part 293 follow-up (Sep 25 2026): "no lesson at the end" in the desk notes did
 * not stop tidy moral endings, and at low reasoning a general rule is skimmed.
 * So the desk pulls the exact lines the song and each chorus land on and puts
 * them in front of the producer as their own gate, last in the list. */
function endingGate(script: string, number: number): string {
  const lines = lyricEndingLines(script);
  if (!lines.length) return '';
  return `\n${number}. THE ENDING. These are the last two sung lines of the song and of each chorus pass, pulled by the desk:\n${lines.map((l) => `   - "${l}"`).join('\n')}\n   Read each one on its own. Rewrite any that states a lesson, a turnaround, a verdict on the story or a sum-up of it, so it lands on something that happens or gets said in the moment instead: an action, a concrete detail, a joke, a line said to somebody, or the hook itself. Keep its rhyme sound and length, and change it the same way everywhere it repeats. A song can end unresolved. Lines that already land on a moment stay exactly as they are.`;
}

export function lyricAuditRequest(script: string, tells: LyricTell[], shape: string | null = null): string {
  const flagged = tells.length
    ? `\n\nThese exact lines lean on default-reach words and must be rewritten, keeping each line's rhyme sound, stress count and length, the same way everywhere a line repeats, and never by swapping in another default-reach word:\n${tells.map((t, i) => `${i + 1}. "${t.line}" -- ${t.tell}`).join('\n')}`
    : '';
  return `Think briefly: decide what fails, fix it, and write the song out. Your first draft is below. Now be the producer who decides whether it gets cut. Run the QUALITY GATES on it silently and return the upgraded song. Fix in place: keep the story, the hook and every line that already sings, and do not paraphrase a working song into a different one. The exception is gate 5: if the verses do not rhyme or do not hold a meter, rewriting their line endings throughout is the job, not a liberty.

Check, in this order, and change only what fails:
1. THE TURN and the payoff. Does the last verse do new work? Plant one concrete detail in verse one and bring it back loaded in the last verse or the bridge, or let one new fact make the last chorus mean something it did not mean the first time. On the final chorus, change exactly one word or one line if that lands the turn.
2. The hook. Plain speech, six to eight syllables, its click syllable on an open vowel, exactly one surprise, repeated verbatim, title landing four to eight times. If the best line in the song is hiding in a verse, it is the hook in the wrong seat.
3. Hook stew. A near-wordless second hook (a post-chorus chant or run) if the genre wants one.
4. The spice. Exactly one from the list, visible.
5. SING-ALONG, the gate this desk fails most. Read each verse's line endings down the page: they must rhyme in couplets or alternating lines, with the rhyme on the last word, so a listener can guess the word before it lands. Rewrite line endings until they do; move words around inside the line before you change its meaning. Meter: do NOT count syllables yourself, in your thinking or anywhere else; it burns the whole budget and the song comes back empty. The desk has counted, and if any verse wanders it is named at the end of this message; even out only those, by ear, to a steady four-stress line. Then the chorus: it says the feeling straight out in plain words, rhymes, and could be shouted from a car. If the chorus describes instead of declaring, rewrite it and keep the title. No worn rhyme pairs (fire and desire, heart and apart, love and above).
6. Song, not short story, and not a nursery rhyme either. Each verse keeps one or two details so exact that only this song could contain them, never the props recent drafts keep reaching for (rain on the window, a swing and its chain, doors, windows, plates, a phone, the TV) unless the brief named them, and the rest is plain talk. Cut any line that only notices something, and replace any line so general it could sit in a thousand songs. A verse this desk sized itself runs eight lines or more. Moment and voice. Happening now, one attitude in every line, a first line that grabs in eight words, no retrospective wisdom, no Tier 1 structure anywhere.
7. Singability. Open vowels under held notes, a breath in every long line, no stacked sibilants or consonant pileups on stressed beats, parentheses only for sung ad-libs and echoes, never stage directions.${shape ? `\n8. Length. ${shape}` : ''}${endingGate(script, shape ? 9 : 8)}${flagged}${lyricMeterNote(script)}

Return the complete song in the same format: the music direction, the Lyrics: heading with every sung line and every chorus written out in full, then the READBACK line. Nothing else.

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
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return true;
    if (/^[*_#\s]*read\s?back\b/i.test(lines[0])) return true;
    return lines.every((l) => l.length >= 110 && !/^[\[(]/.test(l) && /[.!?]["')*_]*$/.test(l));
  };
  while (blocks.length > 1 && prose(blocks[blocks.length - 1])) blocks.pop();
  return blocks.join('\n\n').trim();
}

export function mergeRepairedLyrics(original: string, repaired: string): string | null {
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
  if (!words || sung(words) < sung(before) * 0.9 || sung(words) > sung(before) * 1.4) return null;
  return `${original.slice(0, from.index + from[0].length).trimEnd()}\n${words}\n\n${tail}`.trimEnd();
}

/** Seen live: the writer left the "READBACK:" label off, so the spoken
 *  description rode at the end of the lyrics, where a singer would sing it. A
 *  final paragraph that is one long prose line after the sung words is the
 *  readback; give it its label back. Leaves a labelled draft alone. */
export function labelReadback(raw: string): string {
  // "Readback:", "**READBACK:**" and the like are the same label; the splitter only knows one spelling.
  raw = raw.replace(/^[ \t]*[*_#]*[ \t]*read\s?back[ \t]*[*_]*[ \t]*:[ \t]*[*_]*[ \t]*/im, 'READBACK: ');
  if (raw.includes('READBACK:') || !/^\s*lyrics\s*:/im.test(raw)) return raw;
  const lines = raw.trimEnd().split('\n');
  const last = lines[lines.length - 1].trim();
  const before = (lines[lines.length - 2] || '').trim();
  const prose = last.length >= 120 && /[.!?]["')]?$/.test(last) && !/^\s*[\[(]/.test(last);
  if (!prose || before !== '') return raw;
  return `${lines.slice(0, -1).join('\n').trimEnd()}\n\nREADBACK: ${last}`;
}

export async function musicWritingPrompt(
  base: string,
  request: Request,
  readAgent: Reader,
  audience: SongAudience = null,
): Promise<string> {
  if (!writesMusic(request)) return base;
  const note = audienceNote(audience);
  const agent = await readAgent({ id: lyricAgentId });
  if (!agent?.instructions?.trim())
    throw Object.assign(
      new Error(
        "Lyric's writing instructions are temporarily unavailable. Your draft is kept; try again shortly.",
      ),
      { status: 503 },
    );

  return `You are Lyric, working the songwriting desk in Kade-AI's Sound Booth. Your saved persona below is who you are in conversation. The HIT-WRITING SYSTEM after it is how every song at this desk is written; where the two differ about craft, the system wins. Then come the owner's desk notes and the delivery format the audio engine needs.

LYRIC'S CURRENT SONGWRITING PERSONA

${agent.instructions}

${hitWritingSystem}

${musicWritingCraft}

${note ? `${note}\n\n` : ''}SOUND BOOTH DELIVERY CONTRACT
This is a single text-only writing request, not a conversation. Do not ask questions; make the creative choices and deliver. Do not access conversation history, personal memory, other agents, or audio tools.
Keep supplied lyrics exactly as the request instructs; do not rewrite them merely to improve their rhymes. Formatting-only work must preserve authored words.
The Sound Booth format below is the ONLY output format. There is no Lyrics Box, Tag Box or Negative Tag Box here: what would go in a tag box (genre, BPM with feel, drums, bass, instrumentation, the signature instrumental hook, the lead voice, backing vocals, arrangement dynamics) is written as the music direction prose, and nothing about story or theme goes in it. So: output the music direction first, then a Lyrics: heading and the complete sung words when lyrics are requested, followed by the required READBACK: line. Never output commentary, a critique, rhyme annotations, a greeting or an offer to continue. Keep production instructions out of sung lines. Do not add lyrics to an instrumental request.
Length check, when you wrote the lyrics yourself and the person gave no length: the sections follow the SECTION MAP sent with the request, every verse sized by the genre's density tier, the technical line says about four minutes, and a short verse gets what happened next, not another way of saying the same thing. Then run the Tier 2 scan against Appendix A one more time. This check is private; the answer is always the complete draft in the format below, never a description of it.

${base}`;
}
