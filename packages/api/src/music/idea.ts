import { ideaShelf } from './ideaShelf';

/* Surprise me, for songs. Four versions in one night (Sep 20 2026), each one
 * corrected by Kade's ear, and the corrections are the design:
 *
 * 1. The page joined one of five styles, places and turns. Greeting cards.
 * 2. The server drew five NOUNS for the writer to stitch. Her word: "madlibs".
 *    Nouns handed to a model come back as nouns.
 * 3. A way of looking was drawn instead (a concept-finding method, a song type),
 *    then a territory, a tone and a genre. "A lot better, though it is still a
 *    little weird and cliche." It wrote 100-word pitches with a title, an
 *    instrument list and a running time, it parroted the one example the prompt
 *    contained, and it kept repeating itself because the list of what she had
 *    already seen lived in memory and every deploy emptied it.
 * 4. She pasted a hundred ideas of the kind she wants (ideaShelf.ts): a genre
 *    tag, ONE very specific human situation, and often a craft rule ("Never say
 *    we grew apart"). This version writes those. What is drawn: a genre (crossed
 *    with a second about a third of the time), a LENS taken from what makes her
 *    hundred work, a loose territory, whether to add a craft rule, and six of her
 *    ideas at random as the register to hit. A pitch that reuses one of hers, or
 *    one she has already been shown, is refused in code, because a model shown an
 *    example will hand it back. */

export type SongSparks = { sound: string; lens: string; territory: string; rule: boolean; shelf: string[]; avoid: string[] };

const GENRES: string[] = [
  '90s R&B slow jam', 'modern R&B', 'neo-soul', 'quiet storm R&B', '2000s R&B', 'alternative R&B', 'R&B duet', 'new jack swing',
  'boom-bap hip-hop', 'storytelling rap', 'Southern hip-hop', 'old-school rap', 'female rap', 'trap', 'G-funk', 'Miami bass', 'crunk',
  '70s soul', 'Memphis soul', 'Motown-style soul', 'deep soul ballad', 'Southern soul', 'soul waltz', 'psychedelic soul', 'soul duet',
  'traditional country', '90s country', 'outlaw country', 'country story song', 'country comedy', 'country duet', 'bluegrass', 'Western swing', 'Appalachian folk', 'Americana',
  'delta blues', 'Chicago blues', 'electric blues', 'swamp blues', 'blues shuffle', 'dirty blues comedy', 'blues-rock',
  'funk', '70s funk', 'P-Funk-style weirdness', 'disco-funk', 'funk-pop', 'boogie', 'disco',
  'grunge', '90s alt-rock', 'garage rock', 'indie rock', 'punk rock', 'pop-punk', 'Southern rock', 'hard rock', 'power ballad', 'surf rock', 'rockabilly', 'new wave', 'yacht rock',
  'heavy metal', 'thrash metal', 'doom metal', 'groove metal', 'metalcore', 'nu metal', 'industrial metal', 'hair metal',
  'gospel choir', 'gospel-blues', 'gospel funk', 'piano gospel ballad', 'gospel rap', 'secular gospel',
  'jazz ballad', 'big band swing', 'electro-swing', 'trip-hop', 'synth-pop', 'dark synth-pop', 'city pop', 'house', 'UK garage',
  'acoustic folk', 'sea shanty', 'Irish pub song', 'polka', 'zydeco', 'Tejano cumbia', 'mariachi', 'reggae', 'ska', 'dancehall', 'Afrobeats', 'bossa nova',
  'Broadway show tune', 'animated-musical number', "children's singalong", 'lullaby', 'barbershop quartet', 'campfire singalong', 'marching band',
];

/* What makes her hundred work, as ways of looking. The last three are the
 * novelty lane she asked to keep: about one draw in five. */
const LENSES: string[] = [
  'ONE TINY TELL. A small habit, object, sound or smell gives the whole situation away, and the song stays on it.',
  'THE FORM IS THE IDEA. The structure does the work: two singers who remember the same night differently, every verse a message never sent, one object followed through many hands, a building taken room by room, loud sections for what they want to say and soft ones for what comes out, several narrators at one event.',
  'THE JOB THAT SEES EVERYTHING. Someone whose ordinary work lets them read people, and what they have noticed.',
  'COMEDY OF ESCALATING SPECIFICS. One plain annoyance or one bad stretch, told through more and more exact and ridiculous particulars.',
  'THE SAME OLD THING. A couple, a family or two friends doing what they have always done, with the real feeling sitting underneath it.',
  'A PLACE OR A THING AS WITNESS. A house, a vehicle, a drawer, a machine or a building holds the story, and the people are seen through it.',
  'THIRTY SECONDS. A feeling that ambushes someone in a completely ordinary place, and is gone again.',
  'THE SMALL ASK. Faith, doubt, courage or pride at the size of one phone call, one drive, one shift, one year with nothing glamorous in it.',
  'PRETENDING. Someone performing fine, or uninterested, or together, while each verse lets a little more of the truth out.',
  'THE WORLD MOVED. Someone notices that the people, the town or the life they knew quietly turned into something else, themselves included.',
  'A WHOLE GROUP. A family, a congregation, a friend group, a street or a workplace, with its grudges and its loyalty, on one particular day.',
  'AN ABSURD PREMISE PLAYED COMPLETELY STRAIGHT. An outsider or an impossible narrator looking at ordinary life, or a small chore treated as an epic.',
  'SMALL STAKES, END OF THE WORLD. An animal or a child wants one thing, loses it, grieves completely, and the story actually goes somewhere.',
  'SMALL STAKES, END OF THE WORLD. An animal or a child wants one thing, loses it, grieves completely, and the story actually goes somewhere.',
];

const TERRITORIES: string[] = [
  'a couple, years in', 'two people who should not start anything', 'an ex, handled like an adult or not at all', 'a parent and a grown child', 'a parent and a small child',
  'brothers and sisters', 'grandparents', 'old friends', 'neighbours', 'a workplace', 'a night shift', 'money and being broke', 'food and whoever cooks it',
  'a vehicle', 'a house', 'a small town', 'a city block', 'a church or no church', 'a funeral, a wedding or a reunion', 'getting older', 'the body', 'technology',
  'an animal', 'being a kid', 'a holiday', 'a game or a contest', 'paperwork, queues and customer service', 'a party', 'a road trip', 'a stranger',
];

function sample(xs: string[], n: number, random: () => number): string[] {
  const pool = xs.slice();
  const out: string[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.min(pool.length - 1, Math.floor(random() * pool.length)), 1)[0]);
  return out;
}

export function songIdeaSparks(random: () => number = Math.random, avoid: string[] = []): SongSparks {
  const pick = (xs: string[]): string => xs[Math.min(xs.length - 1, Math.floor(random() * xs.length))];
  const first = pick(GENRES);
  const second = random() < 0.3 ? pick(GENRES) : '';
  return {
    sound: second && second !== first ? `${first} crossed with ${second}` : first,
    lens: pick(LENSES),
    territory: pick(TERRITORIES),
    rule: random() < 0.5,
    shelf: sample(ideaShelf, 6, random),
    avoid: avoid.slice(-30),
  };
}

/* Opens with the song desk's own first sentence on purpose: the gateway knows
 * that sentence (reframe-proxy lyrics.js) and keeps its chat notes and chat
 * rewriters away from the reply. */
export const songIdeaSystem: string = `You are Lyric, working the songwriting desk in Kade-AI's Sound Booth. Right now you are not writing a song. You are writing ONE generator-ready song idea for a songwriter who will hand it to the lyric writer with one press.

WHAT AN IDEA IS HERE
A genre tag, a colon, then one very specific human situation in one to three plain sentences. Specific means a listener can see who it is, where they are and what just happened or keeps happening, and recognises it from their own life or laughs because they do. Generic prompts ("an emotional song about heartbreak") are where a writer reaches for neon, shattered mirrors, ghosts in the hallway and heartbeats echoing through the universe. A specific situation leaves no room for those.

You are shown a few ideas of hers as the REGISTER to hit: their size, their plainness, their eye. They are not material. Do not reuse their situations, their objects or their phrasing, and do not write a close cousin of any of them.

HOW TO FIND IT (privately; never show the working)
1. Use the genre you are given as the tag; you may sharpen it with an era or a style word. If two genres are crossed, the tag says so.
2. Look through the lens you are given. The territory is a loose nudge; drop it if it fights the lens.
3. Think of eight different situations. Strike any you have effectively heard as a song, any a greeting card could print, and any whose only interest is that someone has an odd job or an odd object. Strike anything that needs explaining.
4. Keep the one that is most specific and most human, the one that makes a writer think "I know exactly what verse two is".

NEVER
Neon, fluorescent light, mirrors, ghosts, shadows, whispers, echoes, heartbeats, the universe, storms as feelings, rain on glass, empty roads, a named weekday, a clock time, coffee, porch lights, kitchen tables, healing, a journey, finding yourself, a moral, a song about songwriting. No real artists, songs or brands.

HOW TO WRITE IT DOWN
One line, 25 to 70 words: the genre tag, a colon, the situation. No title, no instrument list, no tempo, no running time, no lyrics, no quotation of a hook. If you are told to add a craft rule, end with one short sentence that fences the writer off from the lazy version of this exact song, in the manner of "Never say the word sorry." or "Told entirely through what is on the table." or "No one raises their voice." Otherwise end after the situation. No preamble, no sign-off, nothing else.`;

export function songIdeaRequest(sparks: SongSparks): string {
  const avoid = sparks.avoid.length ? `\n\nIdeas she has already been shown. Be nothing like any of them in situation, genre or structure:\n- ${sparks.avoid.join('\n- ')}` : '';
  return `Genre: ${sparks.sound}.\nLens: ${sparks.lens}\nTerritory (loose): ${sparks.territory}.\nCraft rule: ${sparks.rule ? 'yes, end with one' : 'no'}.\n\nThe register to hit, from her own list (never reuse these):\n- ${sparks.shelf.join('\n- ')}${avoid}\n\nWrite the one idea.`;
}

/** What goes on the "already shown" list for a pitch. */
export function songIdeaTitle(idea: string): string {
  return idea.replace(/\s+/g, ' ').trim().slice(0, 170);
}

const words = (text: string): string[] => text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);

/** True when a pitch lifts a run of five words from her shelf or from an idea
 *  she has already been shown. A model shown an example hands it back. */
export function tooCloseToShelf(idea: string, seen: string[] = []): boolean {
  const mine = words(idea.replace(/^[^:]{0,60}:/, ''));
  const runs = new Set<string>();
  for (let i = 0; i + 5 <= mine.length; i++) runs.add(mine.slice(i, i + 5).join(' '));
  for (const other of [...ideaShelf, ...seen]) {
    const theirs = words(other.replace(/^[^:]{0,60}:/, ''));
    for (let i = 0; i + 5 <= theirs.length; i++) if (runs.has(theirs.slice(i, i + 5).join(' '))) return true;
  }
  return false;
}

/** One idea line, or null when the writer returned anything else. */
export function cleanSongIdea(text: string): string | null {
  if (/^\s*(lyrics\s*:|\[verse)/im.test(text)) return null;
  const lines = String(text || '')
    .replace(/```[a-z]*|```/gi, '')
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, ' ').replace(/^(?:[#*_>\-\s]|\d+[.)]\s)+|[*_\s]+$/g, '').trim())
    .filter((p) => p.length >= 60 && /^[^:]{3,60}:\s+\S/.test(p) && !/^(sure|here(?:'s| is)|okay|idea|pitch|lens|territory|craft rule)\b/i.test(p));
  const idea = lines[lines.length - 1];
  return idea ? idea.slice(0, 700) : null;
}
