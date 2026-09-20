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
   * prompt). The audit that follows stays on low; the handler sets that. */
  if (request.deep)
    return {
      model: lyricWritingModel,
      temperature: 0.85,
      top_p: 0.95,
      maxTokens: 24000,
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
      maxTokens: 16000,
      timeoutMs: 225000,
      reasoning: { enabled: true, effort: 'low', exclude: true },
    };
  return {
    model: lyricWritingModel,
    temperature: 0.85,
    top_p: 0.95,
    maxTokens: 16000,
    timeoutMs: 112000,
    reasoning: { enabled: true, effort: 'low', exclude: true },
  };
}

export const musicWritingCraft: string = `DESK NOTES FROM THE OWNER (these outrank the system above where they differ)
- Words the person supplied are theirs. Never rewrite, trim or "improve" supplied lyrics; shape the music around them.
- The songs have been coming out too short. Follow the desk's lyric budget: about four minutes, three verses, every verse new story. Verse two is not a shorter copy of verse one, and verse three is the payoff.
- Her named pet hates, in her words: "Everything's always a tuesday, drinks are always coffee, scenes are clean." Never name a weekday or a clock time, never reach for coffee, the porch light, the kitchen table, neon, shadows, whispers or echoes, and never use clean, steady or scene as filler, unless her own brief used the word. Ask what THIS singer actually has in their hands, where exactly they are and what they would really drink, and write that.
- Do the SONG SPEC and the hook lab silently before the first line, and the QUALITY GATES silently after the last. Deliver only the finished song.`;

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
  }
  return found;
}

/** The second, surgical request: replace the flagged lines and nothing else. */
/** Seen live: asked for three verses, the writer delivered two. Returns the
 *  instruction to add when a song the desk sized itself came back short; null
 *  when the person set the length or structure, or the shape is fine. */
export function lyricShapeIssue(script: string, brief = ''): string | null {
  if (/\b(?:verses?|minutes?|seconds?|short|brief|quick|jingle|hook only|chorus only|one verse|two verses|bars)\b/i.test(brief)) return null;
  const at = script.search(/^\s*lyrics\s*:/im);
  if (at === -1) return null;
  const verses = (script.slice(at).match(/^\s*\[verse[^\]]*\]\s*$/gim) || []).length;
  if (verses === 0 || verses >= 3) return null;
  return `The song has only ${verses === 1 ? 'one verse' : 'two verses'} and this desk writes three. Add a [Verse ${verses + 1}] of eight to twelve sung lines in the same voice, placed after the bridge if there is one and before the final chorus, otherwise before the last chorus. It must turn the story: pay off a detail planted earlier, or say what the narrator has been avoiding. New events, not a summary.`;
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
export function lyricAuditRequest(script: string, tells: LyricTell[], shape: string | null = null): string {
  const flagged = tells.length
    ? `\n\nThese exact lines lean on default-reach words and must be rewritten, keeping each line's rhyme sound, stress count and length, the same way everywhere a line repeats, and never by swapping in another default-reach word:\n${tells.map((t, i) => `${i + 1}. "${t.line}" -- ${t.tell}`).join('\n')}`
    : '';
  return `Your first draft is below. Now be the producer who decides whether it gets cut. Run the QUALITY GATES on it silently and return the upgraded song. Fix in place: protect every line that already works, the hook above all, and do not paraphrase a working song into a different one.

Check, in this order, and change only what fails:
1. THE TURN and the payoff. Does verse three do new work? Plant one concrete detail in verse one and bring it back loaded in verse three, or let one new fact make the last chorus mean something it did not mean the first time. On the final chorus, change exactly one word or one line if that lands the turn.
2. The hook. Plain speech, six to eight syllables, its click syllable on an open vowel, exactly one surprise, repeated verbatim, title landing four to eight times. If the best line in the song is hiding in a verse, it is the hook in the wrong seat.
3. Hook stew. A near-wordless second hook (a post-chorus chant or run) if the genre wants one.
4. The spice. Exactly one from the list, visible.
5. Variance. Line lengths breathe between sections, one line rhymes with nothing, at least one fragment, no section of tidy perfect-rhymed couplets, no worn rhyme pairs.
6. Moment and voice. Happening now, one attitude in every line, a first line that grabs in eight words, no retrospective wisdom, no Tier 1 structure anywhere.
7. Singability. Open vowels under held notes, a breath in every long line, no stacked sibilants or consonant pileups on stressed beats, parentheses only for sung ad-libs and echoes, never stage directions.${shape ? `\n8. Length. ${shape}` : ''}${flagged}

Return the complete song in the same format: the music direction, the Lyrics: heading with every sung line and every chorus written out in full, then the READBACK line. Nothing else.

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
  if (!words || sung(words) < sung(before) * 0.9 || sung(words) > sung(before) * 1.4) return null;
  return `${original.slice(0, from.index + from[0].length).trimEnd()}\n${words}\n\n${tail}`.trimEnd();
}

/** Seen live: the writer left the "READBACK:" label off, so the spoken
 *  description rode at the end of the lyrics, where a singer would sing it. A
 *  final paragraph that is one long prose line after the sung words is the
 *  readback; give it its label back. Leaves a labelled draft alone. */
export function labelReadback(raw: string): string {
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

  return `You are Lyric, working the songwriting desk in Kade-AI's Sound Booth. Your saved persona below is who you are in conversation. The HIT-WRITING SYSTEM after it is how every song at this desk is written; where the two differ about craft, the system wins. Then come the owner's desk notes and the delivery format the audio engine needs.

LYRIC'S CURRENT SONGWRITING PERSONA

${agent.instructions}

${hitWritingSystem}

${musicWritingCraft}

SOUND BOOTH DELIVERY CONTRACT
This is a single text-only writing request, not a conversation. Do not ask questions; make the creative choices and deliver. Do not access conversation history, personal memory, other agents, or audio tools.
Keep supplied lyrics exactly as the request instructs; do not rewrite them merely to improve their rhymes. Formatting-only work must preserve authored words.
The Sound Booth format below is the ONLY output format. There is no Lyrics Box, Tag Box or Negative Tag Box here: what would go in a tag box (genre, BPM with feel, drums, bass, instrumentation, the signature instrumental hook, the lead voice, backing vocals, arrangement dynamics) is written as the music direction prose, and nothing about story or theme goes in it. So: output the music direction first, then a Lyrics: heading and the complete sung words when lyrics are requested, followed by the required READBACK: line. Never output commentary, a critique, rhyme annotations, a greeting or an offer to continue. Keep production instructions out of sung lines. Do not add lyrics to an instrumental request.
Length check, when you wrote the lyrics yourself and the person gave no length: three verses sized by the genre's density tier, the technical line says about four minutes, and a short verse gets what happened next, not another way of saying the same thing. Then run the Tier 2 scan against Appendix A one more time. This check is private; the answer is always the complete draft in the format below, never a description of it.

${base}`;
}
