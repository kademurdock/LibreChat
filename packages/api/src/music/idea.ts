/* Part 228 (Sep 20 2026). Kade: "On the surprise me button, can we make the
 * writing desk come up with some super original song prompt?" The button used
 * to join one of five styles, five places and five turns: 125 songs, all of
 * them greeting cards. A model asked cold for "an original idea" returns the
 * same dozen ideas, so the dice are thrown HERE: a few sparks drawn from wide
 * lists, and the writer's job is to find the one song that makes them belong
 * together. It may drop a spark that will not fit; it may not fall back on a
 * stock premise. */

export type SongSparks = { sound: string; singer: string; place: string; thing: string; trouble: string };

const SOUNDS: string[] = [
  'early-2000s crunk&B slowed to a crawl', 'a 1962 girl-group record with a wall of reverb', 'Appalachian murder ballad, banjo and one fiddle',
  'New Orleans bounce with a second-line brass band', '1978 yacht rock, electric piano and tight harmonies', 'Memphis soul with a Hammond organ and a horn section',
  'outlaw country, telecaster and a dry snare', '1990s Miami bass', 'a Broadway eleven o\'clock number', 'West Coast G-funk with a whining synth lead',
  'sea shanty sung by a work crew, stomps and hand claps', 'bedroom pop recorded on a four-track cassette', 'Chicago drill, sparse and cold',
  'a Motown duet with tambourine on every beat', 'gospel quartet, a cappella until the last chorus', '1985 power ballad with gated drums',
  'Tejano cumbia with accordion', 'a torch song for a smoky piano trio', 'riot grrrl punk under two minutes a verse', 'zydeco with rubboard and accordion',
  'trip-hop, dusty breakbeat and upright bass', 'Laurel Canyon folk rock with pedal steel', 'New jack swing', 'a lullaby for music box and cello',
  'delta blues, one slide guitar and a stomping foot', 'disco with a full string section', 'pop punk from 2003', 'a waltz for harp and orchestral bells',
  'Atlanta trap soul with 808 glides', 'bluegrass played far too fast', 'a 1950s doo-wop slow dance', 'industrial rock with a drum machine',
  'reggae lovers rock', 'a campfire singalong that turns into a stadium chorus', 'ragtime piano and a kazoo, played completely straight', 'slowcore, two chords and a lot of air',
];
const SINGERS: string[] = [
  'a night-shift tow truck driver', 'the second-best psychic in a small town', 'a retired rodeo clown', 'a woman repossessing her own car',
  'a substitute teacher on their last day', 'the ghost of a lighthouse keeper who is mostly bored', 'a wedding DJ who hates the couple', 'a grandmother running an illegal card game',
  'a man who just won a meat raffle', 'a blind woman teaching her sister to drive by ear', 'a mall Santa in July', 'twins who have not spoken since the funeral',
  'a locksmith called to the same house three times in a week', 'a pageant mother who finally hears herself', 'a long-haul trucker talking to a dashboard hula girl',
  'the last employee of a video rental store', 'a bail bondswoman in love with a client', 'a teenager grounded during the best summer of their life',
  'a church organist with a secret night job', 'a man apologizing to a dog', 'a hairdresser who knows everything about everyone', 'a carnival ride operator at closing time',
  'somebody leaving a voicemail they will regret', 'a bride hiding in the bathroom', 'a veteran bartender training their replacement', 'the person who writes the horoscopes',
  'an ex who still has the Netflix password', 'a father learning to braid hair from videos', 'a woman who faked her way into a job she is now great at', 'a getaway driver with a learner\'s permit',
];
const PLACES: string[] = [
  'a laundromat at three in the morning', 'the parking lot of a closed water park', 'a courthouse hallway', 'the back row of a cousin\'s wedding',
  'a bowling alley on league night', 'a ferry that is running late', 'a hospital vending machine alcove', 'a storage unit being cleared out',
  'the drive-through line of a bank', 'a county fair after the rides shut off', 'a motel with one working ice machine', 'a church basement potluck',
  'a pawn shop counter', 'the roof of an apartment building in a heat wave', 'a bus station in a town neither of them lives in', 'a nail salon during a power cut',
  'a fishing boat that will not start', 'the waiting room of a tattoo removal clinic', 'a karaoke bar on its final night', 'a trailer park swimming pool',
  'a dog track', 'an airport chapel', 'the cereal aisle at midnight', 'a roller rink reunion', 'a stalled elevator', 'a swing in a yard nobody mows',
];
const THINGS: string[] = [
  'a casserole dish that was never returned', 'a lottery ticket nobody has checked', 'a wig', 'a pager that still goes off',
  'a jar of buttons', 'a prosthetic leg with a bumper sticker on it', 'a wedding dress bought at a yard sale', 'the wrong urn',
  'a pair of roller skates', 'a church fan with a funeral home ad on it', 'a parrot that repeats one incriminating sentence', 'a cast-iron skillet',
  'a stack of unopened birthday cards', 'a borrowed ladder', 'a broken accordion', 'a tooth in an envelope', 'a tackle box full of love letters',
  'a karaoke machine', 'somebody else\'s prescription glasses', 'a trophy for second place', 'a half-finished quilt', 'a key that fits nothing in the house',
  'a gas station rose', 'a voicemail saved for nine years', 'a hand-painted sign', 'a cooler that is not full of what it should be',
];
const TROUBLES: string[] = [
  'they are proud of the wrong thing', 'the apology arrives twenty years late and is accepted too quickly', 'they won, and it feels like nothing',
  'they are jealous of their own younger self', 'the lie worked and now they have to live in it', 'they are the villain in somebody else\'s favourite story',
  'forgiving someone who never asked', 'they are about to be found out and cannot stop grinning', 'the revenge was petty and completely worth it',
  'wanting to be missed more than wanting to be loved', 'they kept the promise and it cost the friendship', 'everyone thinks they are grieving and they are relieved',
  'falling for the person sent to fire them', 'they are better at this than their mother was and cannot tell her', 'it is too late, and they are going anyway',
  'being needed by someone they do not like', 'the good news has to be kept secret', 'discovering they were the one who left first',
  'they are rich for exactly one night', 'they are bragging and it is all true', 'lust with a terrible sense of timing', 'a dare that got out of hand',
  'homesick for a place that was never good to them', 'they finally got the last word and it was the wrong word',
];

export function songIdeaSparks(random: () => number = Math.random): SongSparks {
  const pick = (xs: string[]): string => xs[Math.min(xs.length - 1, Math.floor(random() * xs.length))];
  return { sound: pick(SOUNDS), singer: pick(SINGERS), place: pick(PLACES), thing: pick(THINGS), trouble: pick(TROUBLES) };
}

/* Opens with the song desk's own first sentence on purpose: the gateway knows
 * that sentence (reframe-proxy lyrics.js) and keeps its chat notes and chat
 * rewriters away from the reply. */
export const songIdeaSystem: string = `You are Lyric, working the songwriting desk in Kade-AI's Sound Booth. Right now you are not writing a song. You are pitching ONE song idea that nobody has written yet, for a songwriter who is bored of safe ideas and will turn your pitch into a full song with one press.

You are handed five sparks drawn at random. Find the single song in which at least three of them belong together and drop the rest without comment. Do not list the sparks back; make them a situation. The idea must have a specific person in a specific moment wanting something, and one turn the listener does not see coming. Funny, filthy, furious, tender and strange are all welcome; polite is not.

Never reach for: a named weekday, coffee, porch lights, neon, shadows, whispers, echoes, rain on a window, empty roads, hearts on sleeves, dancing in kitchens, small-town nostalgia, "finding yourself", or a moral at the end. No songs about writing songs. No real people or real artists' names; describe a sound by era, place, instruments and production.

Write one paragraph of 70 to 110 words, in plain sentences, in this order: the sound (era and genre, two or three signature instruments, tempo feel, who sings and how); who is singing and what is happening to them; the turn; a working title in double quotes that could be the hook; and that it runs about four minutes. No lyrics, no headings, no list, no preamble, no sign-off, nothing after the paragraph.`;

export function songIdeaRequest(sparks: SongSparks): string {
  return `SPARKS\nSound: ${sparks.sound}\nSinger: ${sparks.singer}\nPlace: ${sparks.place}\nThing: ${sparks.thing}\nTrouble: ${sparks.trouble}\n\nPitch the song.`;
}

/** One paragraph of pitch, or null when the writer returned anything else. */
export function cleanSongIdea(text: string): string | null {
  const paragraphs = String(text || '')
    .replace(/```[a-z]*|```/gi, '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').replace(/^[#*_>\-\s]+|[*_\s]+$/g, '').trim())
    .filter((p) => p.length >= 120 && !/^(sure|here(?:'s| is)|okay|pitch|sparks?)\b/i.test(p));
  const idea = paragraphs[0];
  if (!idea || /^\s*(lyrics\s*:|\[verse)/im.test(text)) return null;
  return idea.slice(0, 1200);
}
