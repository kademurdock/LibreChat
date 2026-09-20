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
 * the survivor.
 *
 * Her second verdict, an hour later: "a lot better, though it is still a little
 * weird and cliche. You would think it would choose more genres and mashups and
 * topics besides men and women's relationship problems." And she described a
 * song she loved: a dog falls in love with a stick, is not allowed to bring it
 * inside, is world-ending sad, and then is given a ball. "Even stories like that
 * are sometimes interesting. Children's music, all that." Eight of the ten
 * methods and nine of the eleven song types were adult confessionals, so that
 * is what came out. Now a TERRITORY (what part of life), a TONE and a SOUND (a
 * genre, half the time crossed with a second one) are drawn as well. These are
 * wide fields, not props: the writer still has to find the song inside them. */

export type SongSparks = { type: string; method: string; shape: string; territory: string; tone: string; sound: string; avoid: string[] };

const TYPES: string[] = [
  'the flex or anthem', 'the slow-burn seduction', 'the kiss-off', 'the longing ballad', 'the party starter', 'the diss or callout',
  'the love-drunk devotional', 'the story song', 'the grown-and-gone', 'the obsession spiral', 'the last-call confession',
  'a song type of your own choosing that is none of the usual eleven',
  'a story song with a beginning, a middle and an end, where something actually happens', 'a story song with a beginning, a middle and an end, where something actually happens',
  "a children's song that the grown-ups end up singing too", 'a comedy song that is also a real song', 'a singalong anthem for a whole room',
  'a work song or a marching song', 'a lullaby', 'a tall tale', 'a dance song that tells you what to do', 'a theme song for someone or something that has never had one',
];
/* What part of life. Romance is ONE line in this list on purpose. */
const TERRITORIES: string[] = [
  "an animal's point of view, taken completely seriously", "an animal's point of view, taken completely seriously",
  'small stakes felt as the end of the world, and then the beginning of a new one', 'small stakes felt as the end of the world, and then the beginning of a new one',
  'being a child: the rules, the injustice, the best day ever', 'a parent and a child', 'brothers and sisters', 'a grandparent',
  'best friends', 'a job and the people at it', 'money: not having it, suddenly having it, owing it', 'food and the people who make it',
  'a machine or an object that has feelings about its work', 'weather, a season, or a night sky, as a character',
  'a town, a street or a house, sung as an anthem', 'a game, a sport or a contest', 'a vehicle and the road', 'the body: getting older, getting stronger, getting sick, getting well',
  'faith, doubt, luck and superstition', 'a holiday or a day of the year nobody writes songs for', 'a villain who is enjoying it', 'a monster, a legend or a fairy tale told from the inside',
  'a moment in history seen by somebody unimportant who was standing there', 'outer space, the sea or the deep woods', 'neighbours', 'a rivalry that is not about love',
  'romance, but not a breakup and not a complaint', 'a celebration: somebody won, arrived, graduated, got out, got home',
];
const TONES: string[] = [
  'laugh-out-loud funny', 'silly and completely sincere', 'joyful', 'triumphant', 'sweet without being soft', 'tender', 'mischievous', 'spooky and fun',
  'furious', 'smug', 'swaggering', 'wide-eyed wonder', 'bittersweet', 'heartbroken', 'cosy', 'rowdy',
];
/* Genres to cross. Broad on purpose; the writer chooses the instruments. */
const GENRES: string[] = [
  'bluegrass', 'outlaw country', 'Western swing', 'zydeco', 'Tejano cumbia', 'delta blues', 'Chicago blues', 'Memphis soul', 'Motown', 'gospel choir', 'doo-wop',
  'New Orleans brass band', 'big band swing', 'ragtime', 'a Broadway show tune', 'a Disney-style musical number', 'a sea shanty', 'an Irish pub song', 'polka', 'klezmer',
  'mariachi', 'bossa nova', 'salsa', 'reggae', 'ska', 'dancehall', 'Afrobeats', 'highlife', 'Bollywood filmi', 'K-pop', 'city pop', 'disco', 'funk', 'boogie', 'new jack swing',
  '1990s R&B', 'crunk', 'G-funk', 'boom bap hip-hop', 'trap', 'Miami bass', 'house', 'UK garage', 'drum and bass', 'synthwave', 'new wave', 'post-punk', 'pop punk',
  'grunge', 'hair metal', 'symphonic metal', 'surf rock', 'rockabilly', 'psychedelic rock', 'yacht rock', 'a power ballad', 'indie folk', 'a campfire singalong',
  'a nursery rhyme', 'a marching band', 'barbershop quartet', 'a cappella stomp and clap', 'a lullaby for music box', 'a cinematic orchestral score', 'chiptune', 'lo-fi bedroom pop',
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
  const first = pick(GENRES);
  let second = random() < 0.5 ? pick(GENRES) : '';
  if (second === first) second = '';
  const sound = second ? `${first} crossed with ${second}, as one band that really plays both` : first;
  return { type: pick(TYPES), method: pick(METHODS), shape: pick(SHAPES), territory: pick(TERRITORIES), tone: pick(TONES), sound, avoid: avoid.slice(-12) };
}

/* Opens with the song desk's own first sentence on purpose: the gateway knows
 * that sentence (reframe-proxy lyrics.js) and keeps its chat notes and chat
 * rewriters away from the reply. */
export const songIdeaSystem: string = `You are Lyric, working the songwriting desk in Kade-AI's Sound Booth. Right now you are not writing a song. You are handing a songwriter ONE idea worth a song: a concept with an angle, the kind a room of professional writers would stop talking for. She is bored. She has heard every safe idea, every "quirky" one, and far too many songs about a man and a woman having a problem.

HOW TO FIND IT (do this privately, never show it)
1. You are given a territory, a tone, a song type, a method and a sound. The territory and the tone are the assignment: stay inside them. Using the method as a lens where it fits (drop it where it fights the territory), brainstorm at least ten different title-and-concept pairs. Go fast and go wide: different singers, different ages, different stakes. A singer can be a child, an animal, a machine, a whole town.
2. Strike every one you have effectively heard before, every one a greeting card could print, and every one whose only interest is that the character or the prop is odd. An odd job, an odd object and an odd place is not an idea; it is a costume. The idea is the ANGLE, or the STORY. An angle is what the song says about wanting, pride, money, family, revenge, faith, getting older or getting away with it that a listener recognises from their own life and has never heard sung. A story is a small chain of events with a want, an obstacle and a change, simple enough to retell in two sentences and felt all the way: a dog falls in love with a stick, is told it cannot come inside, grieves like the world has ended, and is handed a ball. Small stakes, total commitment. Either is a song.
3. Of what survives, keep the one where the title is a phrase people actually say, could be shouted back by a crowd, and lands differently at the end than at the start.
4. Use the sound you are given. If it is two genres crossed, say how they meet: which one owns the rhythm, which one owns the melody and the instruments. Describe it by era, scene, two or three signature instruments and the feel of the tempo; never name a real artist or song.

WHAT A GOOD ONE HAS
A specific singer mid-feeling, not looking back on it. A reason the song exists right now. A hook title a crowd, or a car full of kids, would sing back. One turn, second meaning, or ending that pays off. It sounds like a song people would put on again, not like the premise of a short story. Funny, silly, sweet, filthy, furious, smug, tender and strange are all welcome; bland and wise are not. No moral, unless it is a children's song, where the moral must be smuggled in, never announced.

NEVER
A named weekday, a clock time, coffee, a kitchen table, a bar at closing, porch lights, neon, shadows, whispers, echoes, rain on glass, empty roads, small-town nostalgia, dancing in a kitchen, finding yourself, healing, a journey, a song about music or writing, ghosts, clowns, carnivals, lighthouses, psychics, or any character whose job is the joke.

RANGE
Most songs pitched at this desk have been a man or a woman unhappy about the other. That is one corner of the map. Unless the territory you are given is romance, there is no couple, no ex and no bar in this idea. Do not drift into melancholy when the tone you were given is bright. Whatever the recent ideas were about, go somewhere else.

HOW TO WRITE IT DOWN
The territory, the tone, the method, the song type and the shape are private instructions. Never repeat their wording or name them in the paragraph ("the thing nobody admits", "two feelings", "the turn", "the angle", "kiss-off" and the like stay out of it). Plain talk, the way she would type an idea to herself: 60 to 120 words, one paragraph, following the shape you are given. It must include the working title in double quotes, who is singing and what is happening to them right now, the angle or turn, the sound, and that it runs about four minutes. Do not label these parts. No lyrics beyond the quoted title or one quoted hook line, no headings, no list, no preamble, no sign-off, nothing after the paragraph.`;

export function songIdeaRequest(sparks: SongSparks): string {
  const avoid = sparks.avoid.length ? `\n\nRecent ideas she has already seen; be nothing like them in subject, sound or title:\n- ${sparks.avoid.join('\n- ')}` : '';
  return `Territory: ${sparks.territory}.\nTone: ${sparks.tone}.\nSound: ${sparks.sound}.\nSong type to aim at: ${sparks.type}.\nMethod: ${sparks.method}\nShape of the paragraph: ${sparks.shape}${avoid}\n\nFind the idea, then write the paragraph.`;
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
