/* Part 228 (Sep 20 2026). Kade: "On the surprise me button, can we make the
 * writing desk come up with some super original song prompt?" The button used
 * to join one of five styles, five places and five turns.
 *
 * The first server version drew five nouns (a sound, a singer, a place, a
 * thing, a trouble) and had the writer stitch them. Her verdict the same night:
 * "very boring unoriginal prompts that feel like fill in the blanks or madlibs."
 * She was right: every pitch was a quirky stranger holding a quirky prop, in
 * the same sentence order. Nouns handed to a model come back as nouns.
 *
 * So nothing the listener would see is drawn here any more. What is drawn is
 * HOW to look for the idea: one of her own system's song types, one way of
 * finding a concept (title first, the cliche flip, the second meaning), and a
 * shape for the pitch so two ideas in a row do not read alike. The writer
 * brainstorms privately, throws away what it has heard before, and pitches
 * the survivor. */

export type SongSparks = { type: string; method: string; shape: string; avoid: string[] };

const TYPES: string[] = [
  'the flex or anthem', 'the slow-burn seduction', 'the kiss-off', 'the longing ballad', 'the party starter', 'the diss or callout',
  'the love-drunk devotional', 'the story song', 'the grown-and-gone', 'the obsession spiral', 'the last-call confession',
  'a song type of your own choosing that is none of the usual eleven',
];
const METHODS: string[] = [
  'TITLE FIRST. Start from a phrase people really say out loud (at work, in a fight, in bed, at a register, in a group chat) that has never been a song title, and that means a second thing by the last chorus.',
  'THE CLICHE FLIP. Take a worn saying and flip it: swap its parts, aim the whole phrase at someone it is never aimed at, or zoom into one small detail inside it.',
  'TWO FEELINGS THAT SHOULD NOT SHARE A ROOM. Find the moment where a person feels both at once and is not ashamed of either, and name it in a way people will quote.',
  'FIVE MINUTES OFF. Take a situation every song covers and move the camera to five minutes before it or five minutes after it, where nobody writes.',
  'THE WRONG NARRATOR. A familiar kind of song sung by the person who never gets to sing it: the one who did the leaving, the one who was right, the one who is fine.',
  'AN ARGUMENT WITH ONE SPECIFIC YOU. The whole song is said to one person who would recognise themselves, and the hook is the line the singer has been rehearsing.',
  'A RULE, A LIST OR A RITUAL. The song is a set of instructions, terms and conditions, a count, or a habit, and the feeling leaks out through the form.',
  'THE BRAG THAT IS TRUE. Somebody is proud of something nobody writes songs about, and means it completely.',
  'THE ORDINARY DAY. Nothing happens. A person who got through something is simply living, and one small detail shows what it cost or what it bought.',
  'THE THING NOBODY ADMITS. A petty, horny, jealous, relieved or greedy thought that most people have had and no song has said plainly.',
];
const SHAPES: string[] = [
  'Open with the title in double quotes, then say what the song is in two or three plain sentences, then the sound.',
  'Open with the sound in one sentence, then the idea as if you were telling a friend about a song you cannot stop playing.',
  'Open with "What if" and let the idea run, then the title, then the sound.',
  'Open with the one line from the chorus everybody will sing, in double quotes, then explain who is singing it and why it stings or grins, then the sound.',
  'Write it as one long breathless sentence followed by one short one.',
  'Open with who is singing and the exact minute we meet them, then the hook title, then the sound.',
];

export function songIdeaSparks(random: () => number = Math.random, avoid: string[] = []): SongSparks {
  const pick = (xs: string[]): string => xs[Math.min(xs.length - 1, Math.floor(random() * xs.length))];
  return { type: pick(TYPES), method: pick(METHODS), shape: pick(SHAPES), avoid: avoid.slice(-12) };
}

/* Opens with the song desk's own first sentence on purpose: the gateway knows
 * that sentence (reframe-proxy lyrics.js) and keeps its chat notes and chat
 * rewriters away from the reply. */
export const songIdeaSystem: string = `You are Lyric, working the songwriting desk in Kade-AI's Sound Booth. Right now you are not writing a song. You are handing a songwriter ONE idea worth a song: a concept with an angle, the kind a room of professional writers would stop talking for. She is bored. She has heard every safe idea and every "quirky" one.

HOW TO FIND IT (do this privately, never show it)
1. Using the method you are given, brainstorm at least ten different title-and-concept pairs. Go fast and go wide: different people, different decades of life, different stakes.
2. Strike every one you have effectively heard before, every one a greeting card could print, and every one whose only interest is that the character or the prop is odd. An odd job, an odd object and an odd place is not an idea; it is a costume. The idea is the ANGLE: what this song says about wanting, pride, sex, money, family, revenge, faith, getting older or getting away with it that a listener recognises from their own life and has never heard sung.
3. Of what survives, keep the one where the title is a phrase people actually say, could be shouted back by a crowd, and lands differently at the end than at the start.
4. Give it a sound that is not the obvious sound for that idea. Describe the sound by era, scene, two or three signature instruments and the feel of the tempo; never name a real artist or song.

WHAT A GOOD ONE HAS
A specific person mid-feeling, not looking back on it. A reason the song exists tonight. A hook title. One turn or second meaning. Permission to be funny, filthy, furious, smug, tender or strange, and never polite or wise. No moral.

NEVER
A named weekday, coffee, porch lights, neon, shadows, whispers, echoes, rain on glass, empty roads, small-town nostalgia, dancing in a kitchen, finding yourself, healing, a journey, a song about music or writing, ghosts, clowns, carnivals, lighthouses, psychics, or any character whose job is the joke.

RANGE
Romance is one subject among many: money, work, siblings, parents, children, friends, rivals, neighbours, God, the body, getting old, getting even and getting lucky are all songs. The singer can be any age and any gender; do not default to a woman and an ex. Whatever the recent ideas were about, go somewhere else.

HOW TO WRITE IT DOWN
The method, the song type and the shape are private instructions. Never repeat their wording or name them in the paragraph ("the thing nobody admits", "two feelings", "the turn", "the angle", "kiss-off" and the like stay out of it). Plain talk, the way she would type an idea to herself: 60 to 120 words, one paragraph, following the shape you are given. It must include the working title in double quotes, who is singing and what is happening to them right now, the angle or turn, the sound, and that it runs about four minutes. Do not label these parts. No lyrics beyond the quoted title or one quoted hook line, no headings, no list, no preamble, no sign-off, nothing after the paragraph.`;

export function songIdeaRequest(sparks: SongSparks): string {
  const avoid = sparks.avoid.length ? `\n\nRecent ideas she has already seen; be nothing like them in subject, sound or title:\n- ${sparks.avoid.join('\n- ')}` : '';
  return `Song type to aim at: ${sparks.type}.\nMethod: ${sparks.method}\nShape of the paragraph: ${sparks.shape}${avoid}\n\nFind the idea, then write the paragraph.`;
}

/** The working title of a pitch, for the "already seen" list. */
export function songIdeaTitle(idea: string): string {
  const quoted = /["“]([^"”]{2,60})["”]/.exec(idea);
  return (quoted ? quoted[1] : idea.slice(0, 60)).trim();
}

/** One paragraph of pitch, or null when the writer returned anything else. */
export function cleanSongIdea(text: string): string | null {
  const paragraphs = String(text || '')
    .replace(/```[a-z]*|```/gi, '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').replace(/^[#*_>\-\s]+|[*_\s]+$/g, '').trim())
    .filter((p) => p.length >= 120 && !/^(sure|here(?:'s| is)|okay|pitch|brainstorm|candidates?|step \d)\b/i.test(p));
  const idea = paragraphs[paragraphs.length - 1];
  if (!idea || /^\s*(lyrics\s*:|\[verse)/im.test(text)) return null;
  return idea.slice(0, 1400);
}
