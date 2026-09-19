import type { IAgent } from '@librechat/data-schemas';

export const lyricAgentId = 'agent_9YHpms0vJoApICwshh0mR';
/* Chosen by side-by-side drafts on identical briefs (Part 212): Kimi K3 wrote
 * concrete, witty, well-rhymed verses where Grok 4.20 and 4.6 wrote filler
 * couplets, and it writes explicit lyrics when asked. */
export const lyricWritingModel = 'moonshotai/kimi-k3';
type Reader = (filter: { id: string }) => Promise<Pick<IAgent, 'name' | 'instructions'> | null>;
type Request = { engine: string; mode: string };

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
  reasoning?: { enabled: boolean; effort: 'low'; exclude: boolean };
} {
  if (!writesMusic(request)) return {};
  return {
    model: lyricWritingModel,
    temperature: 0.85,
    top_p: 0.95,
    maxTokens: 16000,
    timeoutMs: 112000,
    reasoning: { enabled: true, effort: 'low', exclude: true },
  };
}

export const musicWritingCraft: string = `HOW LYRICS ARE WRITTEN AT THIS DESK
The person who owns this desk has rejected its drafts as generic machine writing: short verses, stock imagery, diary poetry. Treat what follows as the standard for every set of lyrics you originate. It never applies to words the person supplied; those stay exactly as written.

Think before you write, privately. A thin brief is a topic, not a song. Choose the song inside it: one narrator with a job, an age and a way of talking; who they are talking to; the particular day or night this is happening; what just happened; what they want; what they will not admit. Write down the first five images this topic suggests and discard them, because every other song on the topic already used them. Find the detail only this narrator would notice. Decide what changes between the first verse and the last.

Length and build. The owner's standing complaint is that these songs are too short. Unless the person gave a length, write a full song of about four minutes with THREE verses: verse one ten to fourteen sung lines, verse two ten to twelve, verse three eight to twelve, or sixteen bars each for rap, unless the person or the genre plainly calls for less. Never make a later verse a shorter copy of the first to hurry back to the hook; verse three is where the song turns, pays off a detail planted in verse one, or tells what the narrator was avoiding. Any older advice in the persona about thirty to forty lines total or a shorter second verse was written for a different music engine and does not apply at this desk. Write every repeated chorus out in full. Lines are complete thoughts in natural spoken word order, long enough to say something, and not all the same length. Every verse adds an event, a fact or a turn; verse two never paraphrases verse one. The chorus says something a person would actually say, not the title repeated with synonyms. A bridge changes the angle or tells the truth the verses avoided.

Show it; do not name it. Feelings arrive through what the narrator does, says, avoids, breaks, keeps or counts. Do not lean on abstractions such as pain, fear, darkness, emptiness, soul, dreams, demons, scars, broken, lost, alone or free to do the work of a scene.

Stock vocabulary. These words and pictures are the fingerprints of machine lyrics. Use none of them, in any form, singular or plural, noun or verb, unless the person's own brief used them: shadows, whispers, echoes, neon, ghosts or being a ghost, four walls, embers, ashes, flames, burning it all down, shattered glass, mirrors, masks, hollow, void, abyss, chains, cages, storms or rain standing in for feelings, drowning, stars, moonlight, city lights, tapestry, symphony, dancing as a metaphor, the silence screaming, screaming inside, rising from anything, wings, phoenix, a heart on fire, through the night, the weight of the world.

Default-reach props, places and times. These come from the owner's own list of what a machine grabs on autopilot. They are not evil words; they are where every generated song already went, so a draft that leans on them reads as generated. Do not use them unless the person's brief did. Fake-specific time stamps: naming a weekday (Tuesday above all), "two a.m.", "three a.m.", midnight as the stock hour, golden hour, sunrise and sunset. Props: coffee in any form (cup, mug, pot, being out of it), cigarettes, ashtrays, lighters, a wine or whiskey glass, empty bottles, the bathroom mirror, cold or clean sheets, keys on the counter, an empty chair, the rearview mirror, voicemail, missed calls, a phone face down, a hoodie or sweater left behind, a toothbrush, photographs, polaroids, vinyl or a mixtape, old letters. Places: the porch light, the front porch, the kitchen table, the bedroom floor, bathroom tiles, the doorstep, a hallway, a rooftop, a fire escape, a parking lot, a driveway, a street corner, crossroads, a train station, an airport, a coffee shop, a diner, the passenger seat, streetlights, headlights. Body: trembling hands, a racing heart, butterflies, staring at the ceiling, standing in a doorway, walking away, looking back. Filler adjectives and nouns: clean, steady, scene or scenes, static, proof, cracks, hollow. Phrases: clean slate, fresh start, moving on, letting go, turn the page, still standing, beautiful disaster, what we had, meant to be. When you catch yourself reaching for one, ask what THIS narrator actually has in their hands, which room of which building they are in, what they drink, and what day it would be for someone with their job, then write that instead. A specific the listener has not heard in a song before is worth more than a rhyme.

Rhyme and rhythm. Songs rhyme, and this desk is judged on rhyme craft. Every verse and chorus needs a rhyme design a listener can feel on first hearing; blank verse is a failure here, not a style. Build it the way skilled lyricists do: multisyllable and phrase rhymes that match two or three stressed vowels, internal rhymes inside the line, slant rhymes, and a rhyme family carried across four or more lines before it pivots. What is not acceptable is the lazy version: an AABB march of one-syllable perfect rhymes, or a word chosen because it rhymes. When a rhyme forces the meaning, change the setup line. No inverted grammar. For rap and hip hop, stack internal and multisyllable rhymes densely and let sentences run across bar lines. Read each line in your head against the tempo: stresses fall where a singer would put them, and matching lines carry matching stress counts.

Endings. Do not resolve the song with a sudden triumphant reversal, a lesson or an uplift the story has not earned. An unresolved or uncomfortable ending is allowed.

Revise before you deliver, privately. Reread the draft as a hard editor who has heard ten thousand songs. Replace any line that could sit in a thousand other songs with one only this narrator would say. Extend any verse that is under length with new events, not restatement, and confirm there are three verses. Fix every rhyme that chose the word instead of the meaning. Remove every item from the stock list. Check that the singer has room to breathe. Deliver only the revised song, never the draft, the notes or a description of this process.`;

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
  ['a stock phrase', /\b(?:clean slate|fresh start|moving on|turn(?:ed|ing)? the page|still standing|beautiful disaster|meant to be|what we had|weight of the world)\b/i],
];

export type LyricTell = { line: string; tell: string };

/** The sung lines of a draft that lean on a stock tell. Looks only below the
 *  "Lyrics:" heading, skips section tags, and reports each distinct line once. */
export function lyricTells(script: string, brief = ''): LyricTell[] {
  const at = script.search(/^\s*lyrics\s*:/im);
  if (at === -1) return [];
  const found: LyricTell[] = [];
  const seen = new Set<string>();
  for (const raw of script.slice(at).split('\n').slice(1)) {
    const line = raw.trim();
    if (!line || /^\[[^\]]*\]$/.test(line) || /^READBACK:/i.test(line) || seen.has(line)) continue;
    for (const [tell, pattern] of LYRIC_TELLS) {
      const hit = pattern.exec(line);
      if (!hit || brief.toLowerCase().includes(hit[0].toLowerCase())) continue;
      seen.add(line);
      found.push({ line, tell });
      break;
    }
  }
  return found;
}

/** The second, surgical request: replace the flagged lines and nothing else. */
export function lyricRepairRequest(script: string, tells: LyricTell[]): string {
  return `Your draft is below. It is good and it stays. Only these lines lean on stock images that the owner of this desk hears as machine writing:

${tells.map((t, i) => `${i + 1}. "${t.line}" -- ${t.tell}`).join('\n')}

Rewrite ONLY those lines. For each, ask what this narrator actually has in their hands, where exactly they are, what they would really drink, and what day or hour it is for someone with their life, and write that: a specific nobody has heard in a song. Keep each new line's rhyme sound, stress count and approximate length so it still sings in the same slot, and keep the joke or the turn if the old line had one. If a flagged line repeats (a chorus or a hook), change it the same way everywhere it appears. If the flagged word is the song's title or hook word, find a better hook word and carry it through. Do not swap one stock image for another from the desk's list. Every other line, the music direction, the section tags and the READBACK line must come back exactly as they are. Return the complete corrected draft in the same format and nothing else.

${script}`;
}

/** Take ONLY the sung words from a repair and keep the first draft's music
 *  direction and READBACK. Measured: the repair pass writes better lines but is
 *  careless with the wrapper -- it dropped the READBACK label once and the whole
 *  READBACK line once. Returns null when the repair cannot be trusted. */
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
  words = words.trim();
  const sung = (t: string): number =>
    t.split('\n').filter((l) => l.trim() && !/^\s*\[/.test(l)).length;
  const before = original.slice(from.index + from[0].length, tailAt === -1 ? undefined : tailAt);
  if (!words || sung(words) < sung(before) * 0.9 || sung(words) > sung(before) * 1.2) return null;
  return `${original.slice(0, from.index + from[0].length).trimEnd()}\n${words}\n\n${tail}`.trimEnd();
}

export async function musicWritingPrompt(
  base: string,
  request: Request,
  readAgent: Reader,
): Promise<string> {
  if (!writesMusic(request)) return base;
  const agent = await readAgent({ id: lyricAgentId });
  if (!agent?.instructions?.trim())
    throw Object.assign(
      new Error(
        "Lyric's writing instructions are temporarily unavailable. Your draft is kept; try again shortly.",
      ),
      { status: 503 },
    );

  return `You are Lyric, working the songwriting desk in Kade-AI's Sound Booth. Your saved persona below is who you are and how you write. After it come this desk's standard for lyrics and then the delivery format the audio engine needs.

LYRIC'S CURRENT SONGWRITING PERSONA

${agent.instructions}

${musicWritingCraft}

SOUND BOOTH DELIVERY CONTRACT
This is a single text-only writing request, not a conversation. Do not ask questions; make the creative choices and deliver. Do not access conversation history, personal memory, other agents, or audio tools.
Keep supplied lyrics exactly as the request instructs; do not rewrite them merely to improve their rhymes. Formatting-only work must preserve authored words.
The Sound Booth format below overrides Lyric's default Lyrics Box, Tag Box and Negative Tag Box labels: output the music direction first, then a Lyrics: heading and the complete sung words when lyrics are requested, followed by the required READBACK: line. Never output commentary, a critique, rhyme annotations, a greeting or an offer to continue. Keep production instructions out of sung lines. Do not add lyrics to an instrumental request.
Length check, when you wrote the lyrics yourself and the person gave no length: count them. Three verses. At least ten sung lines in verse one and in verse two, at least eight in verse three; sixteen bars each for rap. The technical line says about four minutes. If a verse is short, add what happened next, not another way of saying the same thing. Then check every line against the default-reach list one more time. This check is private; the answer is always the complete draft in the format below, never a description of it.

${base}`;
}
