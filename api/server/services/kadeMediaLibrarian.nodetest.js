'use strict';
/* node --test api/server/services/kadeMediaLibrarian.nodetest.js
 * The media librarian's rules, held still. Every case here is one her own
 * catalog produced in the Part 270 trial (1,269 items, live Jev). */
const test = require('node:test');
const assert = require('node:assert');
const L = require('./kadeMediaLibrarian');

const ans = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = Array.isArray(v) ? { choice: v[0], confidence: v[1] } : { noul: v };
  return out;
};
const video = (title, path, extra = {}) => ({ _id: 'x', kind: 'video', title, path, description: '', ...extra });

test('folder facts: described movies and cassettes leave Needs Filing by rule, keeping her sub-folders', () => {
  const d = L.decide({ kind: 'audio', title: 'Ali', path: 'Audio/Needs Filing/described movies and TV/Movies/A' }, {});
  assert.strictEqual(d.to, 'Audio/Described Movies & TV/Movies/A');
  assert.strictEqual(L.decide({ kind: 'audio', title: 'Bambi', path: 'Audio/Needs Filing/Cassette tapes/Story tapes' }, {}).to, 'Audio/Cassettes/Story tapes');
  assert.strictEqual(L.questionsFor({ kind: 'audio', title: 'Ali', path: 'Audio/Needs Filing/described movies and TV/Movies/A' }), null, 'Jev is never asked about a folder fact');
  assert.strictEqual(L.categoryOf('Audio/Described Movies & TV/Movies/A', 'audio'), 'movie');
  assert.strictEqual(L.categoryOf('Audio/Cassettes/Story tapes', 'audio'), 'cassette');
});

test('folder facts: both mp3 movies collections join her alphabetical described shelf (her word, Sep 23)', () => {
  const to = (title, path) => L.decide({ kind: 'audio', title, path }, {}).to;
  assert.strictEqual(to('101_Dalmations', 'Audio/Needs Filing/mp3 movies'), 'Audio/Described Movies & TV/Movies/0-9');
  assert.strictEqual(to("A_Bug's_Life", 'Audio/Needs Filing/mp3 movies'), 'Audio/Described Movies & TV/Movies/A');
  assert.strictEqual(to('Babe_Pig_in_the_City', 'Audio/Needs Filing/described movies'), 'Audio/Described Movies & TV/Movies/B');
  assert.strictEqual(to('...And Justice for All', 'Audio/Needs Filing/MP3 Movies/extra'), 'Audio/Described Movies & TV/Movies/A');
  assert.strictEqual(to('Ali', 'Audio/Needs Filing/described movies and TV/Movies/A'), 'Audio/Described Movies & TV/Movies/A', 'her own letter folders still win');
  assert.strictEqual(L.questionsFor({ kind: 'audio', title: '17_Again', path: 'Audio/Needs Filing/mp3 movies' }), null, 'Jev is never asked');
  assert.strictEqual(L.folderFact({ kind: 'audio', title: 'Zoo', path: 'Audio/Described Movies & TV/Movies/Z' }), null, 'already filed stays');
  assert.strictEqual(L.folderFact({ kind: 'video', title: 'Zoo', path: 'Video/Needs Filing/mp3 movies' }), null, 'audio only');
});

test('folder facts: audio in a TV or Movies folder joins her described shelf, her folders kept word for word (her word, Sep 26)', () => {
  const to = (path, title = 'x', index) => L.decide({ kind: 'audio', title, path }, {}, { describedShelves: index }).to;
  // Her Sep 24 upload, as it sits in Needs Filing.
  assert.strictEqual(to('Audio/Needs Filing/TV/Family guy/Family Guy - Season 12 (2013)', '[S12.E08] Christmas Guy'), 'Audio/Described Movies & TV/TV/Family guy/Family Guy - Season 12 (2013)');
  assert.strictEqual(to('Audio/Needs Filing/TV/Empire/Empire Season 3 U S'), 'Audio/Described Movies & TV/TV/Empire/Empire Season 3 U S');
  assert.strictEqual(to('Audio/Needs Filing/TV/The Big Bang Theory - Season 2'), 'Audio/Described Movies & TV/TV/The Big Bang Theory/The Big Bang Theory - Season 2', 'a bare season folder joins a show folder: depth');
  assert.strictEqual(to('Audio/Needs Filing/TV/Insecure Season 2 (2018)'), 'Audio/Described Movies & TV/TV/Insecure/Insecure Season 2 (2018)');
  assert.strictEqual(to('Audio/Needs Filing/TV/Rick and Morty - Season 1 [New Description] (2013)'), 'Audio/Described Movies & TV/TV/Rick and Morty/Rick and Morty - Season 1 [New Description] (2013)');
  assert.strictEqual(to('Audio/Needs Filing/TV/The Fairly OddParents- Fairly Odder - Season 1 (2022)'), 'Audio/Described Movies & TV/TV/The Fairly OddParents- Fairly Odder/The Fairly OddParents- Fairly Odder - Season 1 (2022)');
  assert.strictEqual(to('Audio/Needs Filing/TV/Hillary (2020)'), 'Audio/Described Movies & TV/TV/Hillary (2020)', 'no season in the name: hers as it is');
  assert.strictEqual(to('Audio/Needs Filing/TV/arrested development'), 'Audio/Described Movies & TV/TV/arrested development');
  assert.strictEqual(to('Audio/Needs Filing/TV/Family guy/Family Guy Season 9 not described/Season 9 not described'), 'Audio/Described Movies & TV/TV/Family guy/Family Guy Season 9 not described/Season 9 not described');
  assert.strictEqual(to('Audio/Needs Filing/TV'), 'Audio/Described Movies & TV/TV/Assorted (One-Offs)', 'a loose episode still gets a folder');
  assert.strictEqual(to('Audio/Needs Filing/Movies/Disney'), 'Audio/Described Movies & TV/Movies/D/Disney', 'a film folder goes inside its letter');
  assert.strictEqual(to('Audio/Needs Filing/Movies', 'Zootopia'), 'Audio/Described Movies & TV/Movies/Z', 'a loose film joins her alphabetical shelf');
  // Any case in her folder names; the shelf's own spelling wins when only the case differs.
  const index = L.shelfIndex([
    'Audio/Described Movies & TV/TV/Family guy/Family Guy - Season 12 (2013)',
    'Audio/Described Movies & TV/TV/Bob\'s burgers/Bob\'s Burgers season 2',
    'Audio/Described Movies & TV/Movies/B',
  ]);
  assert.strictEqual(to('Audio/Needs Filing/tv/Family Guy/family guy - season 12 (2013)', 'x', index), 'Audio/Described Movies & TV/TV/Family guy/Family Guy - Season 12 (2013)', 'the split season is one folder again');
  assert.strictEqual(to('Audio/Needs Filing/TV/Family Guy/Family Guy - Season 20 (2021)', 'x', index), 'Audio/Described Movies & TV/TV/Family guy/Family Guy - Season 20 (2021)', 'a new season goes inside her show folder, new name kept');
  assert.strictEqual(to('Audio/Needs Filing/TV/Bob\'s Burgers/Bob\'s Burgers Season 2', 'x', index), 'Audio/Described Movies & TV/TV/Bob\'s burgers/Bob\'s Burgers season 2');
  assert.strictEqual(to('Audio/Needs Filing/movies/b', 'x', index), 'Audio/Described Movies & TV/Movies/B');
  assert.strictEqual(to('Audio/Needs Filing/TV/Star Season 1', 'x', index), 'Audio/Described Movies & TV/TV/Star/Star Season 1', 'no match: a new show folder, her season folder inside as she typed it');
  // A show the shelf keeps season by season at the top stays that way; a season already there is used.
  const flat = L.shelfIndex(['Audio/Described Movies & TV/TV/Arthur - Season 1 (1996)', 'Audio/Described Movies & TV/TV/Animaniacs - Season 1 (2020)']);
  assert.strictEqual(to('Audio/Needs Filing/TV/Arthur - Season 2 (1997)', 'x', flat), 'Audio/Described Movies & TV/TV/Arthur - Season 2 (1997)');
  assert.strictEqual(to('Audio/Needs Filing/TV/animaniacs - season 1 (2020)', 'x', flat), 'Audio/Described Movies & TV/TV/Animaniacs - Season 1 (2020)');
  // Two seasons of one show typed two ways, filed in one pass: the sweep adds the planned folders to the index.
  const planned = L.shelfIndex([], ["Audio/Described Movies & TV/TV/schitt's creek/schitt's creek - Season 2 (2016)", "Audio/Described Movies & TV/TV/Schitt's Creek/Schitt's Creek - Season 1 (2015)"]);
  assert.strictEqual(to("Audio/Needs Filing/TV/schitt's creek - Season 2 (2016)", 'x', planned), "Audio/Described Movies & TV/TV/Schitt's Creek/schitt's creek - Season 2 (2016)");
  assert.strictEqual(L.shelfIndex(['Audio/Described Movies & TV/TV/Family guy'], ['Audio/Described Movies & TV/TV/Family Guy']).get('audio/described movies & tv/tv/family guy'), 'Family guy', 'the shelf beats a new spelling');
  assert.strictEqual(to('Audio/Needs Filing/described movies and TV/TV/family guy/Family Guy - Season 15 (2016)/Season 15', 'x', index), 'Audio/Described Movies & TV/TV/Family guy/Family Guy - Season 15 (2016)/Season 15', 'the older folder fact spells it the same way');
  // Never asked of Jev; never for video; never for what is already filed.
  assert.strictEqual(L.questionsFor({ kind: 'audio', title: 'Christmas Guy', path: 'Audio/Needs Filing/TV/Family guy/Family Guy - Season 12 (2013)' }), null);
  assert.strictEqual(L.folderFact({ kind: 'video', title: 'x', path: 'Videos/Needs Filing/TV/Family guy' }), null);
  assert.strictEqual(L.folderFact({ kind: 'audio', title: 'x', path: 'Audio/Described Movies & TV/TV/Family guy/Family Guy - Season 11 (2012)' }), null);
  assert.strictEqual(L.folderFact({ kind: 'audio', title: 'x', path: 'Audio/Cassettes/My cassette collection/TV' }), null, 'a TV folder outside Needs Filing is hers');
  assert.strictEqual(L.categoryOf('Audio/Described Movies & TV/TV/Empire/Empire Season 2', 'audio'), 'movie');
});

test('the audio intake lane: songs by kind and decade, stories, talks and episodes, radio as before', () => {
  const intake = (title, extra = {}) => ({ kind: 'audio', title, path: 'Audio/Needs Filing/Archive Intake', description: '', ...extra });
  const q = L.questionsFor(intake('Spoonful of Sugar'));
  assert.deepStrictEqual(Object.keys(q).sort(), ['audioKind', 'category', 'musicKind', 'ozarks']);
  assert.strictEqual(q.audioKind, L.AUDIO_INTAKE_KIND_Q);
  assert.ok(q.audioKind.criteria['Radio Commercial'].includes('brand name'), 'the radio kinds keep the radio judge\'s wording');
  // A song: its kind of music and the decade read off the title.
  const song = (title, a) => L.decide(intake(title), ans(a));
  assert.strictEqual(song('Spoonful of Sugar', { audioKind: ['Song or music', 0.93], musicKind: ['TV & Movie Songs', 0.88], ozarks: 0.04 }).to, 'Audio/Music/TV & Movie Songs/Undated');
  const fred = song('Fred Flintstone & Barney Rubble in Songs from Mary Poppins (1965)', { audioKind: ['Song or music', 0.9], musicKind: ['TV & Movie Songs', 0.81], ozarks: 0.02 });
  assert.strictEqual(fred.to, 'Audio/Music/TV & Movie Songs/1960s');
  assert.deepStrictEqual(fred.flags, [], 'a sure song carries no note');
  assert.strictEqual(song('Dayyenu', { audioKind: ['Song or music', 0.8], musicKind: ['Religious & Holiday Music', 0.75], ozarks: 0.01 }).to, 'Audio/Music/Religious & Holiday Music/Undated');
  assert.strictEqual(song('Pharoh Blues', { audioKind: ['Song or music', 0.85], musicKind: ["Children's Music", 0.5], ozarks: 0.01 }).to, 'Audio/Music/Assorted Music/Undated', 'an unsure kind of music still leaves intake, like an unsure product');
  // The other kinds.
  assert.strictEqual(song('Sadie and the Snowman read-along 1985', { audioKind: ['Story or audiobook', 0.9], ozarks: 0.02 }).to, 'Audio/Audiobooks/1980s');
  assert.strictEqual(song('Opportunity Meeting 1994', { audioKind: ['Speech or talk', 0.86], ozarks: 0.02 }).to, 'Audio/Spoken Word/1990s');
  assert.strictEqual(song('Christmas Guy', { audioKind: ['Episode of a TV programme', 0.9], ozarks: 0.02 }).to, 'Audio/Described Movies & TV/TV/Assorted (One-Offs)');
  assert.strictEqual(song('101 Dalmatians', { audioKind: ['Whole film', 0.9], ozarks: 0.02 }).to, 'Audio/Described Movies & TV/Movies/0-9');
  const home = song('Grandma at Christmas 1991', { audioKind: ['Home recording', 0.9], ozarks: 0.1 });
  assert.strictEqual(home.to, 'Audio/Home Recordings/1990s');
  assert.deepStrictEqual(home.flags, ['Space review: family or local home recording.']);
});

test('the audio intake lane: a radio commercial, a Springfield aircheck and game radio keep the radio routes', () => {
  const intake = (title) => ({ kind: 'audio', title, path: 'Audio/Needs Filing/Archive Intake', description: '' });
  assert.strictEqual(L.decide(intake("Folgers - 'Checkout Commotion'"), ans({ audioKind: ['Radio Commercial', 0.95], category: ['Food & Grocery', 0.9], ozarks: 0.08 })).to, 'Audio/Radio Commercials/Food & Grocery/Undated');
  assert.strictEqual(L.decide(intake('Sprint - Mrs Chavez 2004'), ans({ audioKind: ['Radio Commercial', 0.9], category: ['Phone & Wireless', 0.5], ozarks: 0.1 })).to, 'Audio/Radio Commercials/Other Commercials/2000s');
  assert.strictEqual(L.decide(intake('KTTS legal ID 1985'), ans({ audioKind: ['Aircheck', 0.92], ozarks: 0.95 })).to, 'Audio/Ozarks (Springfield Area)/Radio Airchecks/1980s');
  assert.strictEqual(L.decide(intake('Lazlow - WKTT spot'), ans({ audioKind: ['Video Game Radio', 0.9], ozarks: 0.1 })).to, 'Audio/Video Game Radio/Other Games', 'an intake folder is not a game');
  assert.strictEqual(L.audioShelf({ title: 'x', path: 'Audio/Needs Filing/Grand Theft Auto IV - Commercials' }, 'Video Game Radio', {}, 'Undated', L.knobs()), 'Audio/Video Game Radio/Grand Theft Auto IV');
});

test('always a folder: an unsure item goes to its best guess, or its catch-all, with a note she can search for', () => {
  const intake = (title) => video(title, 'Videos/Needs Filing/Archive Intake');
  const kfc = L.decide(intake('1994 Kentucky Fried Chicken commercials'), ans({ kind: ['One product advert', 0.55], category: ['Restaurants & Fast Food', 0.52], elsewhere: 0.1 }));
  assert.strictEqual(kfc.to, 'Video/Commercials/Other Commercials/1990s');
  assert.deepStrictEqual(kfc.flags, ['Jev review: librarian guess, Commercials/Other Commercials/1990s (0.55). Check this one.']);
  assert.strictEqual(kfc.why, 'guess: One product advert');
  assert.strictEqual(kfc.confidence, 0.55, 'the record keeps Jev\'s real confidence');
  const munich = L.decide(intake('1985 Munich, Germany'), ans({ kind: ['Home movie', 0.52], foreign: 0.4, elsewhere: 0.2 }));
  assert.strictEqual(munich.to, 'Video/Home Video (VHS)/Home Movies/1980s');
  assert.deepStrictEqual(munich.flags, ['Jev review: librarian guess, Home Video (VHS)/Home Movies/1980s (0.52). Check this one.']);
  // Under the guess floor the choice is noise, and "Something else" has no shelf: the catch-alls, by title.
  const mine = L.decide(intake('My Video 12'), ans({ kind: ['Something else', 0.61] }));
  assert.strictEqual(mine.to, 'Video/Other Video/Undated');
  assert.deepStrictEqual(mine.flags, ['Jev review: librarian guess, Other Video/Undated (0.61). Check this one.']);
  assert.strictEqual(mine.why, 'guess: no sure kind');
  assert.strictEqual(L.decide(intake('1992 commercial'), ans({ kind: ['Promo for a TV programme or channel', 0.3] })).to, 'Video/Commercials/Other Commercials/1990s');
  assert.strictEqual(L.decide(intake('bas4.25.92'), ans({ kind: ['Something else', 0.2] })).to, 'Video/Other Video/Undated', 'a real answer under the floor still leaves intake');
  // A sure answer carries no note, and other flags keep their place before the guess.
  assert.deepStrictEqual(L.decide(intake('1999 Jeep Cherokee commercial'), ans({ kind: ['One product advert', 0.95], category: ['Cars and Trucks', 0.9] })).flags, []);
  const far = L.decide(intake('1987 Waterbed Palace and Olan Mills commercials'), ans({ kind: ['Block of several commercials', 0.5], elsewhere: 0.81 }));
  assert.strictEqual(far.to, 'Video/Commercials/Commercial Breaks/1980s', 'two names before the advert word: a block');
  assert.deepStrictEqual(far.flags, ['Space review: local to another area (0.81).', 'Jev review: librarian guess, Commercials/Commercial Breaks/1980s (0.50). Check this one.']);
  // A guess note starts "Jev review:", so TubeVault lists it with her other review tasks.
  assert.ok(far.flags[1].startsWith('Jev review:'));
  // Audio too.
  const aintake = (title) => ({ kind: 'audio', title, path: 'Audio/Needs Filing/Archive Intake', description: '' });
  const blues = L.decide(aintake('Pharoh Blues'), ans({ audioKind: ['Song or music', 0.55], musicKind: ['Religious & Holiday Music', 0.72], ozarks: 0.02 }));
  assert.strictEqual(blues.to, 'Audio/Music/Religious & Holiday Music/Undated');
  assert.deepStrictEqual(blues.flags, ['Jev review: librarian guess, Music/Religious & Holiday Music/Undated (0.55). Check this one.']);
  const beep = L.decide(aintake('track 07'), ans({ audioKind: ['Something else', 0.8], ozarks: 0.02 }));
  assert.strictEqual(beep.to, 'Audio/Other Audio/Undated');
  assert.deepStrictEqual(beep.flags, ['Jev review: librarian guess, Other Audio/Undated (0.80). Check this one.']);
});

test('always a folder, except her part of the country: a maybe-local item waits for her, and a guess never lands on her shelves', () => {
  const kplr = L.decide(video('May 19, 1985 KPLR Channel 11 Sunday Movie commercial bumpers', 'Videos/Needs Filing/Archive Intake'),
    ans({ kind: ['Station ID, bumper or sign-off', 0.5], recorded: 0.9, madefor: 0.7, local: 0.63, area: ['St. Louis', 0.9] }));
  assert.strictEqual(kplr.to, null);
  assert.deepStrictEqual(kplr.flags, ['Jev review: Missouri (St. Louis), unsure if local (0.63).'], 'flagged as before, no guess');
  const sure = L.decide(video('1991 KSD 93.7 FM commercial', 'Videos/Needs Filing/Archive Intake'),
    ans({ kind: ['One product advert', 0.9], category: ['Radio & Music', 0.3], recorded: 0.8, madefor: 0.6, local: 0.5, area: ['St. Louis', 0.9] }));
  assert.strictEqual(sure.to, 'Video/Commercials/Other Commercials/1990s', 'a sure kind still files as it did before');
  // Audio from the Ozarks: a sure radio kind goes to her Ozarks shelf as before; anything else waits, flagged.
  const aintake = (title) => ({ kind: 'audio', title, path: 'Audio/Needs Filing/Archive Intake', description: '' });
  const unsureAir = L.decide(aintake('KWTO 1978'), ans({ audioKind: ['Aircheck', 0.5], ozarks: 0.8 }));
  assert.strictEqual(unsureAir.to, null);
  assert.deepStrictEqual(unsureAir.flags, ['Jev review: Ozarks, unsure which local shelf (0.80).']);
  const localSong = L.decide(aintake('Branson Belle theme 1996'), ans({ audioKind: ['Song or music', 0.9], musicKind: ['Assorted Music', 0.8], ozarks: 0.7 }));
  assert.strictEqual(localSong.to, null);
  assert.deepStrictEqual(localSong.flags, ['Jev review: Ozarks, unsure which local shelf (0.70).']);
});

test('Part 295 review: an item naming her part of the country is never guessed onto a national shelf', () => {
  const intake = (title, extra) => video(title, 'Videos/Needs Filing/Archive Intake', extra);
  // Jev's Missouri answers came back low, so the Missouri block never flagged these: the title still holds them.
  const kc = L.decide(intake('1994 Kansas City Renaissance Festival promos'), ans({ kind: ['Promo for a TV programme or channel', 0.55], recorded: 0.5, madefor: 0.7, local: 0.5, area: ['Kansas City', 0.8] }));
  assert.strictEqual(kc.to, null);
  assert.deepStrictEqual(kc.flags, ['Jev review: Missouri (Kansas City), unsure if local (0.50).']);
  const kplr = L.decide(intake('2004 KPLR WB11 Recycling Hero promos'), ans({ kind: ['Promo for a TV programme or channel', 0.5], recorded: 0.6, madefor: 0.5, local: 0.4, area: ['Elsewhere in Missouri', 0.4] }));
  assert.strictEqual(kplr.to, null);
  assert.deepStrictEqual(kplr.flags, ['Jev review: Missouri (St. Louis), unsure if local (0.40).'], 'the station names the area when Jev cannot');
  // Arkansas and the Ozarks edge get no Missouri questions; the title or TubeVault's folder holds them.
  const harrison = L.decide(intake('Harrison, AR Pizza Hut grand opening 1992'), ans({ kind: ['One product advert', 0.5] }));
  assert.strictEqual(harrison.to, null);
  assert.deepStrictEqual(harrison.flags, ['Jev review: Arkansas or the Ozarks edge, unsure if local.']);
  const family = L.decide(video('Grandpa at the fair', 'Videos/Needs Filing/Arkansas Family Relevance'), ans({ kind: ['Home movie', 0.5] }));
  assert.strictEqual(family.to, null, 'her Arkansas folder counts too');
  // Jev sure it is national material that only aired here: the guess goes ahead, tagged, and an old doubt is answered.
  const hbo = L.decide(intake('1991 HBO commercial recorded off KPLR', { meta: { review: 'Jev review: Missouri (St. Louis), unsure if local (0.49).' } }),
    ans({ kind: ['Promo for a TV programme or channel', 0.5], recorded: 0.9, madefor: 0.2, local: 0.1, area: ['St. Louis', 0.9] }));
  assert.strictEqual(hbo.to, 'Video/Channels/HBO/1990s');
  assert.deepStrictEqual(hbo.tags, ['Aired in St. Louis']);
  assert.strictEqual(L.reviewNote('Jev review: Missouri (St. Louis), unsure if local (0.49).', hbo.flags, hbo.drop), 'Jev review: librarian guess, Channels/HBO/1990s (0.50). Check this one.');
  // Audio: the title holds it whatever the Ozarks answer.
  const aintake = (title) => ({ kind: 'audio', title, path: 'Audio/Needs Filing/Archive Intake', description: '' });
  const kwto = L.decide(aintake('KWTO Springfield - Spring Sale'), ans({ audioKind: ['Radio Commercial', 0.5], ozarks: 0.4 }));
  assert.strictEqual(kwto.to, null);
  assert.deepStrictEqual(kwto.flags, ['Jev review: Ozarks, unsure which local shelf (0.40).']);
  const stlSong = L.decide(aintake('KSHE 95 jingle 1983'), ans({ audioKind: ['Song or music', 0.5], musicKind: ['Assorted Music', 0.8], ozarks: 0.05 }));
  assert.deepStrictEqual([stlSong.to, stlSong.flags], [null, ['Jev review: Missouri (St. Louis), unsure if local.']]);
  // Review: Jev sure of the kind does not send her area to a national shelf; the Ozarks question asks about Springfield only.
  const buck = L.decide(aintake('KMOX St. Louis - Jack Buck interview 1985'), ans({ audioKind: ['Speech or talk', 0.9], ozarks: 0.05 }));
  assert.deepStrictEqual([buck.to, buck.flags], [null, ['Jev review: Missouri (St. Louis), unsure if local.']]);
  const news = L.decide(aintake('KSDK St. Louis 10 PM news 1992'), ans({ audioKind: ['Episode of a TV programme', 0.85], ozarks: 0.1 }));
  assert.deepStrictEqual([news.to, news.flags], [null, ['Jev review: Missouri (St. Louis), unsure if local.']]);
  const hogs = L.decide(aintake('Arkansas Razorbacks fight song 1994'), ans({ audioKind: ['Song or music', 0.9], musicKind: ['Assorted Music', 0.8], ozarks: 0.1 }));
  assert.deepStrictEqual([hogs.to, hogs.flags], [null, ['Jev review: Arkansas or the Ozarks edge, unsure if local.']]);
  const doubted = L.decide({ ...aintake('Opportunity Meeting 1994'), meta: { review: 'Jev review: Ozarks, unsure which local shelf (0.45).' } }, ans({ audioKind: ['Speech or talk', 0.9], ozarks: 0.1 }));
  assert.deepStrictEqual([doubted.to, doubted.flags], [null, ['Jev review: Ozarks, unsure which local shelf (0.10).']], 'an earlier doubt still holds it');
  // The radio kinds keep their own judge, which has her local shelves; a talk naming nowhere files as before.
  assert.strictEqual(L.decide(aintake('Opportunity Meeting 1994'), ans({ audioKind: ['Speech or talk', 0.9], ozarks: 0.1 })).to, 'Audio/Spoken Word/1990s');
  assert.strictEqual(L.decide(aintake('KMOX legal ID 1985'), ans({ audioKind: ['Aircheck', 0.92], ozarks: 0.1 })).to, 'Audio/Radio Airchecks/1980s', 'a sure aircheck is not held');
});

test('Part 295 review: St. Louis as Part 283 knew it (her word: "If it\'s from STL, put it in stl")', () => {
  const intake = (title) => video(title, 'Videos/Needs Filing/Archive Intake');
  // Confirmed St. Louis businesses go to her St. Louis shelf by rule, with no Jev call.
  for (const [title, dec] of [['2001 Schnucks commercials', '2000s'], ['2004 Suntrup Automotive Group commercials w/ Joe Buck', '2000s'], ['2008 Carol House Furniture commercials', '2000s'],
    ['2005 Holiday, Entertaining & Gift Guide Famous-Barr segment', '2000s'], ['1987 Schnucks/Y98 FM Walt Disney World 15th Birthday Bash Contest promo', '1980s']]) {
    const d = L.decide(intake(title), {});
    assert.strictEqual(d.to, `Video/Missouri/St. Louis (Local)/${dec}`, title);
    assert.deepStrictEqual(d.tags, ['Missouri', 'St. Louis']);
    assert.strictEqual(L.questionsFor(intake(title)), null, 'Jev is not asked');
  }
  // Rothman had been flagged "local to another area", a deletion suggestion: the note comes off as it moves home.
  const rothman = L.decide(intake('2007 Rothman Furniture commercials'), {});
  assert.strictEqual(rothman.to, 'Video/Missouri/St. Louis (Local)/2000s');
  assert.strictEqual(L.reviewNote('Space review: local to another area (0.81).', rothman.flags, rothman.drop), '');
  // The rest is evidence enough to ask the Missouri questions and hold, not to file: stations, shared names, tie-ins.
  for (const title of ['KNLC station/religious promos', '1991 KSD 93.7 FM commercial', '1983 K-SHE 95 commercial', "1998 Denny's commercials w/ Isaac Bruce", "1999 GrandPa's commercials",
    '1991 Rodney D. Young commercial', '2009 Fairmount Park commercial', '1985 Cardinals']) {
    assert.ok(L.stLouis(title), title);
    const q = L.questionsFor(intake(title));
    assert.ok(q.recorded && q.area && !q.elsewhere, title);
    const d = L.decide(intake(title), ans({ kind: ['One product advert', 0.5], recorded: 0.4, madefor: 0.5, local: 0.4, area: ['St. Louis', 0.5] }));
    assert.deepStrictEqual([d.to, d.flags], [null, ['Jev review: Missouri (St. Louis), unsure if local (0.40).']], title);
  }
  // Not St. Louis: the collection's Indianapolis tapes, network material with a Cardinals name, other Cardinals, a price.
  for (const title of ['1990 Schnucks Indianapolis grand opening', '1987 CBS World Series promo w/ Jack Buck', '1994 Arizona Cardinals promo', 'dirt cheap prices commercial 1992', 'Goodyear auto tire commercial 1990']) {
    assert.strictEqual(L.stLouis(title), false, title);
  }
  // A recorded break is several advertisers: Jev decides, as before.
  assert.strictEqual(L.stlFact(intake("1995 KSDK commercial break - Schnucks, McDonald's")), null);
  // Arkansas, Missouri and St. Louis are all "her part of the country" for downloads too.
  assert.strictEqual(L.wantVerdict({ title: '2007 Rothman Furniture commercials', channel: 'x' }, { elsewhere: { noul: 0.95 } }).skip, null);
});

test('Part 295 review: a missing or malformed Jev answer decides nothing and is tried again', async () => {
  const aintake = (title) => ({ kind: 'audio', title, path: 'Audio/Needs Filing/Archive Intake', description: '' });
  const sdc = L.decide(aintake('Silver Dollar City 1985 tape'), { audioKind: { choices: { 'Radio Commercial': 0.9 } }, ozarks: { p: 0.95 } });
  assert.deepStrictEqual([sdc.to, sdc.error], [null, L.MALFORMED]);
  assert.strictEqual(L.decide(aintake('track 07'), ans({ audioKind: ['Song or music', 0.9] })).error, L.MALFORMED, 'no Ozarks answer');
  assert.strictEqual(L.decide(aintake('track 07'), ans({ audioKind: ['Polka', 0.9], ozarks: 0.1 })).error, L.MALFORMED, 'not one of the kinds');
  const ksdk = L.decide(video('1991 KSDK The More You Know', 'Videos/Needs Filing/Archive Intake'), {});
  assert.deepStrictEqual([ksdk.to, ksdk.error], [null, L.MALFORMED]);
  const noMissouri = L.decide(video('1991 KSDK The More You Know', 'Videos/Needs Filing/Archive Intake'), ans({ kind: ['Public service announcement', 0.95] }));
  assert.deepStrictEqual([noMissouri.to, noMissouri.error], [null, L.MALFORMED], 'a Missouri title needs its Missouri answers, even for a sure kind');
  assert.strictEqual(L.decide(video('bas4.25.92', 'Videos/Needs Filing/Archive Intake'), {}).error, L.MALFORMED);
  // fileMedia hands the error to the sweep, which counts a try and moves nothing.
  const { decisions } = await L.fileMedia([aintake('Silver Dollar City 1985 tape')], { ask: async () => ({ answers: { audioKind: { choices: {} } }, usage: {} }) });
  assert.deepStrictEqual([decisions[0].to, decisions[0].error], [null, L.MALFORMED]);
});

test('Part 295 review: a second look does not contradict an earlier doubt, and her other words stay', () => {
  // An earlier read's "unsure if local" holds a guess even when the new answers are lower.
  const item = video('1991 KSDK The More You Know', 'Videos/Needs Filing/Archive Intake', { meta: { review: 'Jev review: Missouri (St. Louis), unsure if local (0.46).' } });
  const d = L.decide(item, ans({ kind: ['Public service announcement', 0.5], recorded: 0.7, madefor: 0.6, local: 0.5, area: ['St. Louis', 0.9] }));
  assert.strictEqual(d.to, null);
  assert.strictEqual(L.reviewNote(item.meta.review, d.flags, d.drop), 'Jev review: Missouri (St. Louis), unsure if local (0.50).', 'one note, the new number');
  // ...even where nothing in the item itself names her area any more.
  const bare = video('Mystery promo 1990', 'Videos/Needs Filing/Archive Intake', { meta: { review: 'Jev review: Missouri (Kansas City), unsure if local (0.60).' } });
  assert.strictEqual(L.decide(bare, ans({ kind: ['Promo for a TV programme or channel', 0.5] })).to, null);
  // A note cut off leaves whatever else was written after it.
  assert.strictEqual(L.reviewNote('Space review: local to another area (0.81). Her note.', [], [L.LOCATION_DOUBT_NOTE]), 'Her note.');
});

test('Part 295 review: folder facts stay off her local shelves; films go inside their letter; soundtracks go to Jev', () => {
  assert.strictEqual(L.folderFact({ kind: 'audio', title: 'x', path: 'Audio/Ozarks (Springfield Area)/Needs Filing/TV/KY3 News' }), null);
  assert.strictEqual(L.folderFact({ kind: 'audio', title: 'x', path: 'Audio/Missouri/Needs Filing/Movies/Local film' }), null);
  assert.strictEqual(L.folderFact({ kind: 'audio', title: 'x', path: 'Audio/Needs Filing/Movies/Frozen (2013)' }), 'Audio/Described Movies & TV/Movies/F/Frozen (2013)');
  assert.strictEqual(L.folderFact({ kind: 'audio', title: 'x', path: 'Audio/Needs Filing/Movies/101 Dalmatians' }), 'Audio/Described Movies & TV/Movies/0-9/101 Dalmatians');
  assert.strictEqual(L.folderFact({ kind: 'audio', title: 'x', path: 'Audio/Needs Filing/described movies and TV/Movies/B' }), 'Audio/Described Movies & TV/Movies/B', 'her letter folders as they are');
  assert.strictEqual(L.folderFact({ kind: 'audio', title: 'x', path: 'Audio/Needs Filing/Movies/Numbers' }), 'Audio/Described Movies & TV/Movies/Numbers');
  const top = L.shelfIndex(['Audio/Described Movies & TV/Movies/Disney Collection/Bambi']);
  assert.strictEqual(L.folderFact({ kind: 'audio', title: 'x', path: 'Audio/Needs Filing/Movies/disney collection' }, top), 'Audio/Described Movies & TV/Movies/Disney Collection', 'a folder the shelf keeps at the top stays there');
  assert.strictEqual(L.folderFact({ kind: 'audio', title: 'Let It Go', path: 'Audio/Needs Filing/Movies/Frozen Soundtrack' }), null);
  assert.strictEqual(L.folderFact({ kind: 'audio', title: 'Main Title (OST)', path: 'Audio/Needs Filing/TV/Star Wars Rebels' }), null);
  assert.ok(L.questionsFor({ kind: 'audio', title: 'Let It Go', path: 'Audio/Needs Filing/Movies/Frozen Soundtrack' }).musicKind);
});

test('Part 295 review: a one-advertiser reel Jev half-calls a block is guessed onto the advertiser\'s shelf', () => {
  const intake = (title) => video(title, 'Videos/Needs Filing/Archive Intake');
  const kfc = L.decide(intake('1994 Kentucky Fried Chicken commercials'), ans({ kind: ['Block of several commercials', 0.5], category: ['Restaurants & Fast Food', 0.8] }));
  assert.strictEqual(kfc.to, 'Video/Commercials/Restaurants & Fast Food/1990s');
  assert.strictEqual(kfc.why, 'guess: One product advert');
  assert.strictEqual(L.decide(intake('1985 Toy Chest commercials'), ans({ kind: ['Block of several commercials', 0.45] })).to, 'Video/Commercials/Other Commercials/1980s');
  // A named channel, a break word, or two names before the advert word: still a block.
  assert.strictEqual(L.decide(intake('1994 CBS commercials'), ans({ kind: ['Block of several commercials', 0.5] })).to, 'Video/Commercials/Commercial Breaks/CBS/1990s');
  assert.strictEqual(L.decide(intake('1994 assorted commercials'), ans({ kind: ['Block of several commercials', 0.5] })).to, 'Video/Commercials/Commercial Breaks/1990s');
  assert.strictEqual(L.decide(intake('1988 Sears and True Value commercials'), ans({ kind: ['Block of several commercials', 0.5] })).to, 'Video/Commercials/Commercial Breaks/1980s');
  // A sure block is a block.
  assert.strictEqual(L.decide(intake('1994 Kentucky Fried Chicken commercials'), ans({ kind: ['Block of several commercials', 0.9] })).to, 'Video/Commercials/Commercial Breaks/1990s');
});

test('Part 295 review: a guess note is a TubeVault review task as TubeVault reads notes today', () => {
  const d = L.decide(video('My Video 12', 'Videos/Needs Filing/Archive Intake'), ans({ kind: ['Something else', 0.61], foreign: 0.95 }));
  const review = L.reviewNote('', d.flags);
  // TubeVault 1.43: review_tools.task_matches counts 'Jev review:' notes; archive_workflow.FLAG_SPLIT splits them.
  assert.ok(review.includes('Jev review:'));
  assert.deepStrictEqual(review.split(/(?<=\.)\s+(?=(?:Jev|Space) review:)/), ['Jev review: made outside the US (0.95).', 'Jev review: librarian guess, Other Video/Undated (0.61). Check this one.']);
});

test('local shelves are never moved from, audio included, whatever Jev says', () => {
  const air = { kind: 'audio', title: 'KTTS 1985', path: 'Audio/Ozarks (Springfield Area)/Radio Airchecks/Undated', description: '' };
  assert.strictEqual(L.zoneOf(air), 'local');
  assert.strictEqual(L.questionsFor(air), null);
  assert.strictEqual(L.decide(air, ans({ audioKind: ['Song or music', 0.99], musicKind: ['Assorted Music', 0.99], ozarks: 0.01 })).to, null);
  const tape = video('Branson show 1994', 'Video/Ozarks (Springfield Area)/1990s');
  const d = L.decide(tape, ans({ kind: ['Something else', 0.2] }));
  assert.strictEqual(d.to, null, 'no guess on her local shelf');
  assert.deepStrictEqual(d.flags, []);
});

test('review notes: a new read adds and replaces its own sentences, keeps hers, and drops a stale guess or copy note', () => {
  assert.strictEqual(L.reviewNote('', ['Jev review: made outside the US (0.93).']), 'Jev review: made outside the US (0.93).');
  assert.strictEqual(L.reviewNote('Jev review: made outside the US (0.93).', []), 'Jev review: made outside the US (0.93).', 'a note it does not repeat stays');
  assert.strictEqual(L.reviewNote('Space review: local to another area (0.84).', ['Space review: local to another area (0.86).', 'Jev review: librarian guess, Other Video/1990s (0.30). Check this one.']),
    'Space review: local to another area (0.86). Jev review: librarian guess, Other Video/1990s (0.30). Check this one.', 'the new number replaces the old');
  assert.strictEqual(L.reviewNote('Jev review: librarian guess, Other Video/1990s (0.30). Check this one. Space review: identical copy, another is kept.', []), '', 'worked out afresh each read');
  assert.strictEqual(L.reviewNote('Jev review: Missouri (St. Louis), unsure if local (0.49).', ['Jev review: Missouri (St. Louis), unsure if local (0.63).']), 'Jev review: Missouri (St. Louis), unsure if local (0.63).');
  assert.strictEqual(L.withoutGuess('Space review: local to another area (0.84). Librarian guess: Commercials/Other Commercials/1990s (0.55). Check this one.'), 'Space review: local to another area (0.84).', 'the first wording too');
  assert.strictEqual(L.withoutGuess('Jev review: made outside the US (0.93). Jev review: librarian guess, Home Video (VHS)/Home Movies/1980s (0.52). Check this one.'), 'Jev review: made outside the US (0.93).');
  assert.strictEqual(L.withoutGuess(undefined), '');
  // Part 295 review: notes a read has made stale come off, whichever read wrote them.
  assert.strictEqual(L.reviewNote('Jev review: Missouri (St. Louis), unsure if local (0.46). Jev review: made outside the US (0.93).', [], [L.LOCATION_DOUBT_NOTE]), 'Jev review: made outside the US (0.93).', 'on her own shelves');
  assert.strictEqual(L.reviewNote('Space review: local to another area (0.81). Her note.', [], [L.LOCATION_DOUBT_NOTE]), 'Her note.');
  assert.strictEqual(L.reviewNote('Jev review: Arkansas or the Ozarks edge, unsure if local. Jev review: Ozarks, unsure which local shelf (0.70).', [], [L.LOCATION_DOUBT_NOTE]), '');
});

test('fileMedia: the TV folder fact uses the shelf index it is given and never asks Jev', async () => {
  const asked = [];
  const ask = async (state) => { asked.push(state.title); return { answers: {}, usage: { input_tokens: 10 } }; };
  const index = L.shelfIndex(['Audio/Described Movies & TV/TV/Empire/Empire Season 2']);
  const { decisions, costUSD } = await L.fileMedia([{ _id: 'e', kind: 'audio', title: '02 - 13  Empire - The tameness of the wolf', path: 'Audio/Needs Filing/TV/empire/empire season 2' }], { ask, deps: { describedShelves: index } });
  assert.strictEqual(decisions[0].to, 'Audio/Described Movies & TV/TV/Empire/Empire Season 2');
  assert.strictEqual(decisions[0].why, 'folder says so');
  assert.deepStrictEqual(asked, []);
  assert.strictEqual(costUSD, 0);
  assert.strictEqual(L.VERSION, 2, 'the second look reads version-1 leftovers once');
});

test('kids blocks: Nick Jr and Disney Junior have their own folders, filed by rule (her word, Sep 23)', () => {
  const to = (title, path = 'Videos/Needs Filing/Archive Intake') => L.decide(video(title, path), {}).to;
  // The seven that sat in Archive Intake for want of a confident kind.
  assert.strictEqual(to('Nick jr yo gabba gabba curriculum board fall 2012'), 'Video/Channels/Nickelodeon/Nick Jr/2010s');
  assert.strictEqual(to('Nick jr backyardigans curriculum board 2012'), 'Video/Channels/Nickelodeon/Nick Jr/2010s');
  assert.strictEqual(to('Nick jr toot and puddle curriculum board 2012'), 'Video/Channels/Nickelodeon/Nick Jr/2010s');
  assert.strictEqual(to('Nick jr face little bill intro 2004'), 'Video/Channels/Nickelodeon/Nick Jr/2000s');
  assert.strictEqual(to('1993 Nick Jr'), 'Video/Channels/Nickelodeon/Nick Jr/1990s');
  assert.strictEqual(to('Nick jr sign off commercial breaks  September 2015'), 'Video/Commercials/Commercial Breaks/Nickelodeon/Nick Jr/2010s');
  assert.strictEqual(to('Nick jr on CBS piper commercial breaks 2005 pt1'), 'Video/Commercials/Commercial Breaks/CBS/Nick Jr on CBS/2000s');
  // Disney Junior, however it is spelled.
  assert.strictEqual(to('Disney Junior bumper 2013'), 'Video/Channels/Disney Channel/Disney Junior/2010s');
  assert.strictEqual(to('Disney Jr. promo Sofia the First 2014'), 'Video/Channels/Disney Channel/Disney Junior/2010s');
  assert.strictEqual(to('DisneyJr commercial breaks 2012'), 'Video/Commercials/Commercial Breaks/Disney Channel/Disney Junior/2010s');
  assert.strictEqual(to('NickJr Face bumper'), 'Video/Channels/Nickelodeon/Nick Jr/Undated');
  // Jev is never asked about a block's own presentation...
  assert.strictEqual(L.questionsFor(video('Nick jr yo gabba gabba curriculum board fall 2012', 'Videos/Needs Filing/Archive Intake')), null);
  // ...but a single advert, a fan remake, audio, or a show merely mentioning the block stay with the rules they had.
  assert.strictEqual(L.blockFact(video('Nick Jr magazine commercial 1999', 'Videos/Needs Filing/Archive Intake')), null);
  assert.strictEqual(L.blockFact(video('Nick Jr bumper recreation', 'Videos/Needs Filing/Archive Intake')), null);
  assert.strictEqual(L.blockFact({ kind: 'audio', title: 'Nick Jr theme', path: 'Audio/Needs Filing' }), null);
  assert.strictEqual(L.blockFact(video('Blues clues episode as seen on nick jr', 'Videos/Needs Filing/Archive Intake')), null);
  // Filed items are left alone by this rule; only intake is filed by it.
  assert.strictEqual(L.blockFact(video('Nick Jr bumper 1998', 'Video/Channels/Nickelodeon/1990s')), null);
  // Noggin keeps its priority over a Nick Jr mention.
  assert.strictEqual(to('Noggin Nick Jr bumper 2007'), 'Video/Channels/Noggin/2000s');
  assert.strictEqual(L.networkOf('Nick Jr. Face promo'), 'Nickelodeon/Nick Jr');
  assert.strictEqual(L.networkOf('Disney Junior promo'), 'Disney Channel/Disney Junior');
  assert.strictEqual(L.networkOf('Nickelodeon SNICK promo'), 'Nickelodeon/SNICK', 'a block wins over its channel');
});

test('programming blocks, former and current, sit inside their channel (her word, Sep 23)', () => {
  const to = (title, path = 'Videos/Needs Filing/Archive Intake') => L.decide(video(title, path), {}).to;
  // Titles as they are in her library.
  assert.strictEqual(to('Nickel-O-Zone Promo： The Wild Thornberrys (1998)'), 'Video/Channels/Nickelodeon/Nickel-O-Zone/1990s');
  assert.strictEqual(to('Nick In the Afternoon bumper, 1998'), 'Video/Channels/Nickelodeon/Nick in the Afternoon/1990s');
  assert.strictEqual(to('SNICK Screenbug #1 (1993)'), 'Video/Channels/Nickelodeon/SNICK/1990s');
  assert.strictEqual(to('Toonami - October 1999 Promos & Bumps'), 'Video/Channels/Cartoon Network/Toonami/1990s');
  assert.strictEqual(to('Toonami Midnight Run - 7⧸25⧸1999 Promos & Bumps'), 'Video/Channels/Cartoon Network/Toonami Midnight Run/1990s');
  assert.strictEqual(to('[adult swim] bumps (August 26, 2016)'), 'Video/Channels/Cartoon Network/Adult Swim/2010s');
  assert.strictEqual(to('Cartoon Cartoon Fridays - 6⧸11⧸1999 Host Segments & Promos'), 'Video/Channels/Cartoon Network/Cartoon Cartoon Fridays/1990s');
  assert.strictEqual(to('Zoog Disney (1999) Bumper - Disney Channel - Website'), 'Video/Channels/Disney Channel/Zoog Disney/1990s');
  assert.strictEqual(to('Vault Disney (1998) Bumper - Disney Channel - Cinderella'), 'Video/Channels/Disney Channel/Vault Disney/1990s');
  assert.strictEqual(to('Fox Box ｜ Bumper ｜ 2003 ｜ Totally Tuned In'), 'Video/Channels/FOX/FoxBox/2000s');
  assert.strictEqual(to('Various FOX Kids Bumpers (1995)'), 'Video/Channels/FOX/Fox Kids/1990s');
  assert.strictEqual(to('4KidsTV Split Screen Credits (November 17, 2007)'), 'Video/Channels/FOX/4Kids TV/2000s');
  assert.strictEqual(to("Kids' WB Snow Jam bumpers (2000)"), "Video/Channels/The WB/Kids' WB/2000s");
  assert.strictEqual(to('One Saturday Morning Commercials (05⧸01⧸1999)'), 'Video/Commercials/Commercial Breaks/ABC/One Saturday Morning/1990s');
  assert.strictEqual(to('Jetix on ABC Family Commercial Break (July 29, 2005)'), 'Video/Commercials/Commercial Breaks/ABC Family/Jetix/2000s');
  assert.strictEqual(to('Jetix Split Screen Credits (April 30, 2005)'), 'Video/Channels/Toon Disney/Jetix/2000s');
  assert.strictEqual(to('Bookworm Bunch credits： George Shrinks (Season 2)'), 'Video/Channels/PBS/PBS Kids Bookworm Bunch/Undated');
  assert.strictEqual(to('PBS Kids GO! Interstitials (May 25, 2011)'), 'Video/Channels/PBS/PBS Kids Go/2010s');
  assert.strictEqual(to('GSN Kids Zone promo, 1997'), "Video/Channels/GSN/Kids' Zone/1990s");
  assert.strictEqual(to('USA Cartoon Express intro, 1985'), 'Video/Channels/USA Network/USA Cartoon Express/1980s');
  assert.strictEqual(to('NickRewind Sign Off (March 18, 2019)'), 'Video/Channels/TeenNick/NickRewind/2010s');
  assert.strictEqual(L.networkOf('Nick at Nite promo, 1985'), 'Nickelodeon/Nick at Nite');
  assert.strictEqual(L.networkOf('Nick-at-Nite promo'), 'Nickelodeon/Nick at Nite');
  assert.strictEqual(L.networkOf('Friday Night Nicktoons Opening (2002-2004)'), 'Nickelodeon/Nicktoons');
  assert.strictEqual(L.networkOf('Disney One Saturday Mornings (1999) Television Commercial - ABC'), 'ABC/One Saturday Morning');
  // A recording of the block and something else stays on the channel.
  assert.strictEqual(L.networkOf('Cartoon Network & Adult Swim - 8⧸12⧸2003 promos, commercials, and bumpers'), 'Cartoon Network');
  assert.strictEqual(L.networkOf('Toonami ⧸ Adult Swim - May 2005 Promos & Bumps'), 'Cartoon Network');
  assert.strictEqual(L.networkOf('(May 19-20, 2002) Adult Swim⧸Cartoon Network Commercials'), 'Cartoon Network');
  assert.strictEqual(L.networkOf('Cartoon Network to Adult Swim Transition (2008-2010)'), 'Cartoon Network');
  assert.strictEqual(L.networkOf('Christmas commercial break 2000 - Flintstone, Toonami, Scooby-Doo'), 'Cartoon Network');
  assert.strictEqual(L.networkOf('Toon Disney and Jetix Commercials (March 2, 2005)'), 'Toon Disney');
  assert.strictEqual(L.networkOf('Nickelodeon & Nick At Nite Promo’s Back In July Of 1992'), 'Nickelodeon');
  assert.strictEqual(L.networkOf('Nickelodeon sign off nick jr sign on 1999'), 'Nickelodeon');
  assert.strictEqual(L.networkOf('Pokemon & Digimon 1999 Commercial Break ｜ Kids WB vs Fox Kids'), 'FOX', 'two blocks: the first one\'s channel');
  assert.strictEqual(L.blockFact(video('Cartoon Network ⧸ Adult Swim - December 2006 Promos & Bumps', 'Videos/Needs Filing/Archive Intake')), null, 'mixed: Jev decides');
  // Commas and dates are not pairs.
  assert.strictEqual(L.networkOf('Toonami, 1999'), 'Cartoon Network/Toonami');
  assert.strictEqual(L.networkOf('Adult Swim - 7⧸10⧸2003 promos, commercials & bumpers'), 'Cartoon Network/Adult Swim');
  // A channel with no block stays the channel; TEENick is not a block here; Snickers is not SNICK.
  assert.strictEqual(L.networkOf('Cartoon Network promo 1998'), 'Cartoon Network');
  assert.strictEqual(L.networkOf('Teenick Sabrina commercial breaks 2003'), 'TeenNick', 'her one-n spelling files under the channel');
  assert.strictEqual(L.networkOf('Snickers commercial 1996'), null);
  // A single advert or a fan recreation still waits for Jev.
  assert.strictEqual(L.blockFact(video('Toonami action figure commercial 2001', 'Videos/Needs Filing/Archive Intake')), null);
  assert.strictEqual(L.blockFact(video('[Timelapse] Recreating a 2001 Nickelodeon U-Pick Live on-screen graphic', 'Videos/Needs Filing/Archive Intake')), null);
});

test('the brands and topics she named get folders, filed by rule (her word, Sep 23)', () => {
  const to = (title, path = 'Videos/Needs Filing/Archive Intake') => L.decide(video(title, path), {}).to;
  // Her waiting batch, with the titles the server used to cut restored.
  assert.strictEqual(to("1996 Chuck E. Cheese's commercial"), 'Video/Commercials/Restaurants & Fast Food/Chuck E. Cheese/1990s');
  assert.strictEqual(to('2007 Dave & Busters commercials'), "Video/Commercials/Restaurants & Fast Food/Dave & Buster's/2000s");
  assert.strictEqual(to('1999 Yellow Pages commercials w/ Jon Lovitz'), 'Video/Commercials/Phone & Wireless/Yellow Pages/1990s');
  assert.strictEqual(to('1988 Nissan Cash Back Close-Out commercials'), 'Video/Commercials/Cars and Trucks/Nissan/1980s');
  assert.strictEqual(to('2004 Tennessee Tourism commercial w/ Dolly Parton'), 'Video/Commercials/Travel & Attractions/Tourism/2000s');
  assert.strictEqual(to('2008 Holiday Inn commercials w/ Philip Baker Hall'), 'Video/Commercials/Travel & Attractions/Holiday Inn/2000s');
  assert.strictEqual(to('January 13, 1989 Channel Surfing'), 'Video/Channels/Channel Surfing/1980s');
  assert.strictEqual(to("1986 Shoney's commercial"), "Video/Commercials/Restaurants & Fast Food/Shoney's/1980s");
  assert.strictEqual(to('1986 ShowBiz Pizza Place commercial'), 'Video/Commercials/Restaurants & Fast Food/Chuck E. Cheese/1980s');
  assert.strictEqual(to('Datsun 310 ad, 1979'), 'Video/Commercials/Cars and Trucks/Nissan/1970s');
  assert.strictEqual(L.questionsFor(video('1988 Nissan Cash Back Close-Out commercials', 'Videos/Needs Filing/Archive Intake')), null, 'Jev is not asked');
  // Jev's kind plus a named brand: the brand's own shelf beats Jev's guess at a category.
  const guessed = L.decide(video('Chuck E. Cheese Pizza Time 1994', 'Videos/Needs Filing/Archive Intake'), ans({ kind: ['One product advert', 0.95], category: ['Toys & Video Games', 0.9] }));
  assert.strictEqual(guessed.to, 'Video/Commercials/Restaurants & Fast Food/Chuck E. Cheese/1990s');
  // Her own part of the country still goes to Jev and her local shelves; a break is several brands; a venue is not an advert.
  assert.strictEqual(L.brandFact(video('2004 Branson, Missouri Tourism commercial', 'Videos/Needs Filing/Archive Intake')), null);
  assert.strictEqual(L.brandFact(video("2000 Cartoon Network commercial break - Chuck E Cheese, Mickey's Fruit Snacks", 'Videos/Needs Filing/Archive Intake')), null);
  assert.strictEqual(L.brandFact(video('Live at Nissan Pavilion 1999', 'Videos/Needs Filing/Archive Intake')), null);
  assert.strictEqual(L.brandFact(video('Holiday Inn and Shoney\'s ads 1990', 'Videos/Needs Filing/Archive Intake')), null, 'two brands: a reel');
  assert.strictEqual(L.brandFact(video("Chuck E. Cheese's commercial 1996", 'Video/Commercials/Restaurants & Fast Food/1990s')), null, 'filed items are left to the move');
  assert.strictEqual(L.brandOf('The Accidental Tourist (1988) Television Commercial - Movie'), null);
});

test('zones: intake, local shelves, filed, and books skipped', () => {
  assert.strictEqual(L.zoneOf(video('a', 'Videos/Needs Filing/Archive Intake')), 'intake');
  assert.strictEqual(L.zoneOf(video('a', 'Videos/Advertising/Show Promos (Review)')), 'intake');
  assert.strictEqual(L.zoneOf(video('a', '')), 'intake');
  assert.strictEqual(L.zoneOf(video('a', 'Video/Ozarks (Springfield Area)/Local News/1990s')), 'local');
  assert.strictEqual(L.zoneOf(video('a', 'Video/Missouri/Kansas City (Local)/1990s')), 'local');
  assert.strictEqual(L.zoneOf(video('a', 'Video/Commercials/Toys & Video Games/1990s')), 'filed');
  assert.strictEqual(L.zoneOf({ kind: 'text', title: 'a', path: 'Books/Poetry' }), 'skip');
});

test('networks come off the title by rule, longest name first', () => {
  assert.strictEqual(L.networkOf('Nick jr on CBS commercial breaks 2005'), 'CBS/Nick Jr on CBS', 'a block that aired on CBS sits under CBS');
  assert.strictEqual(L.networkOf('ABC Family promo 2003'), 'ABC Family');
  assert.strictEqual(L.networkOf('Teennick degrassi promo 2013'), 'TeenNick');
  assert.strictEqual(L.networkOf('Teenick Sabrina commercial breaks 2003'), 'TeenNick', 'her own spelling, one n');
  assert.strictEqual(L.networkOf('Toon Disney bumper'), 'Toon Disney');
  assert.strictEqual(L.networkOf('Playhouse Disney sign on 2007'), 'Disney Channel/Playhouse Disney');
  assert.strictEqual(L.networkOf('Noggin Nick Jr bumper 2007'), 'Noggin');
  assert.strictEqual(L.networkOf('Noggin on Nick Commercial Breaks 2001'), 'Nickelodeon/Noggin on Nick');
  assert.strictEqual(L.networkOf('Sprout tape commercial breaks 2015'), 'Sprout');
  assert.strictEqual(L.networkOf('1999 Dodge commercial'), null);
});

test('decades come off the folder, then the title, never from Jev', () => {
  assert.strictEqual(L.decadeOf(video('x 1999', 'Video/PSAs/1980s')), '1980s');
  assert.strictEqual(L.decadeOf(video('Noggin commercial breaks 2004', 'Videos/Needs Filing/Archive Intake')), '2000s');
  assert.strictEqual(L.decadeOf(video('March', 'Videos/Needs Filing/Archive Intake')), 'Undated');
});

test('intake: Jev decides the shelf; the network and decade come from rules', () => {
  const brk = L.decide(video('Noggin commercial breaks 2004', 'Videos/Needs Filing/Archive Intake'), ans({ kind: ['Block of several commercials', 1] }));
  assert.strictEqual(brk.to, 'Video/Commercials/Commercial Breaks/Noggin/2000s');
  const ad = L.decide(video('1999 Jeep Cherokee commercial', 'Videos/Needs Filing/Archive Intake'), ans({ kind: ['One product advert', 1], category: ['Cars and Trucks', 0.98] }));
  assert.strictEqual(ad.to, 'Video/Commercials/Cars and Trucks/1990s');
  const unsure = L.decide(video('Rolie polie olie clay piece', 'Videos/Needs Filing/Archive Intake'), ans({ kind: ['Promo for a TV programme or channel', 0.44] }));
  assert.strictEqual(unsure.to, 'Video/Channels/Other Channels/Undated', 'Part 295: under the floor it goes to the best guess...');
  assert.deepStrictEqual(unsure.flags, ['Jev review: librarian guess, Channels/Other Channels/Undated (0.44). Check this one.'], '...with a note she can search for');
  const promo = L.decide(video('Nick jr backyardigans is next 2012', 'Videos/Needs Filing/Archive Intake'), ans({ kind: ['Promo for a TV programme or channel', 0.95] }));
  assert.strictEqual(promo.to, 'Video/Channels/Nickelodeon/Nick Jr/2010s');
  const show = L.decide(video('Bear in the big blue house intro 2001', 'Videos/Needs Filing/Archive Intake'), ans({ kind: ['Episode or clip of a TV programme', 0.9] }), { broadcastShelf: () => 'TV Shows/Bear in the Big Blue House/Intros & Credits' });
  assert.strictEqual(show.to, 'Video/TV Shows/Bear in the Big Blue House/Intros & Credits/2000s');
  const brandless = L.decide(video('Mystery spot 1988', 'Videos/Needs Filing/Archive Intake'), ans({ kind: ['One product advert', 0.9], category: ['Toys & Video Games', 0.4] }));
  assert.strictEqual(brandless.to, 'Video/Commercials/Other Commercials/1980s', 'an advert with no sure shelf still leaves intake');
});

test('an identified channel is a useful shelf when the show dictionary has no match', () => {
  const item = video('Noggin Connie the cow ending 2004', 'Videos/Needs Filing/Archive Intake');
  const a = ans({ kind: ['Episode or clip of a TV programme', 0.91] });
  assert.strictEqual(L.decide(item, a).to, 'Video/Channels/Noggin/2000s');
  assert.strictEqual(L.decide({ ...item, title: 'Playhouse Disney Stanley horsepower' }, a).to, 'Video/Channels/Disney Channel/Playhouse Disney/Undated');
  assert.strictEqual(L.decide({ ...item, title: 'Unidentified episode' }, a).to, 'Video/TV Shows/Assorted (One-Offs)/Undated');
  assert.strictEqual(L.routeByKind({ ...item, title: 'Playhouse Disney commercial breaks 2001' }, 'Block of several commercials', null, '2000s', {}), 'Video/Commercials/Commercial Breaks/Disney Channel/Playhouse Disney/2000s');
});

test('Missouri comes first, to the right local shelf, with tags', () => {
  const item = video('September 13, 1990 KSDK partial 6 p.m', 'Videos/Needs Filing/Archive Intake');
  const d = L.decide(item, ans({ kind: ['News or special report', 0.96], recorded: 0.95, madefor: 0.9, local: 0.92, area: ['St. Louis', 0.97] }));
  assert.strictEqual(d.to, 'Video/Missouri/St. Louis (Local)/1990s');
  assert.deepStrictEqual(d.tags, ['Missouri', 'St. Louis']);
  const oz = L.decide(video('KOLR 10 Commercials Meeks 1988', 'Video/Commercials/Home Improvement/1980s'),
    ans({ kind: ['One product advert', 0.9], recorded: 0.9, madefor: 0.9, local: 0.9, area: ['Springfield and the Ozarks', 0.95], localKind: ['Local Commercials', 0.93] }));
  assert.strictEqual(oz.to, 'Video/Ozarks (Springfield Area)/Local Commercials/1980s');
  const unsure = L.decide(video('EyeMasters 2004', 'Video/Commercials/Other Commercials/2000s'), ans({ recorded: 0.8, madefor: 0.5, local: 0.65, area: ['Kansas City', 0.9] }));
  assert.strictEqual(unsure.to, null);
  assert.ok(unsure.flags[0].startsWith('Jev review: Missouri (Kansas City), unsure if local (0.65)'), unsure.flags[0]);
});

test('local shelves are never moved from, only flagged', () => {
  const d = L.decide(video('KY3 promo 1994 from a UK tape', 'Video/Ozarks (Springfield Area)/Show Promos/1990s'), ans({ kind: ['One product advert', 1], category: ['Toys & Video Games', 1], foreign: 0.95 }));
  assert.strictEqual(d.to, null);
  assert.deepStrictEqual(d.flags, ['Jev review: made outside the US (0.95).']);
});

test('audit: a store stays a store; a re-shelving needs near-certainty', () => {
  const kmart = L.decide(video('Kmart ad w/Martha Stewart, 1997', 'Video/Commercials/Stores & Retail/1990s'), ans({ kind: ['One product advert', 1], category: ['Clothing & Shoes', 0.99] }));
  assert.strictEqual(kmart.to, null);
  const buns = L.decide(video('Cinnamon Mini-Buns ad, 1993', 'Video/Commercials/Food & Grocery/1990s'), ans({ kind: ['One product advert', 1], category: ['Breakfast Cereal', 1] }));
  assert.strictEqual(buns.to, 'Video/Commercials/Breakfast Cereal/1990s');
  const middling = L.decide(video('Cinnamon Mini-Buns ad, 1993', 'Video/Commercials/Food & Grocery/1990s'), ans({ kind: ['One product advert', 1], category: ['Breakfast Cereal', 0.92] }));
  assert.strictEqual(middling.to, null);
  const psa = L.decide(video('Missing Children | 1-800-The-Lost | 2002', 'Video/Commercials/Sweepstakes & Direct Response/2000s'), ans({ kind: ['Public service announcement', 0.9], category: ['Charities & Nonprofits', 0.6] }));
  assert.strictEqual(psa.to, 'Video/PSAs/2000s');
});

test('audit: a single advert filed under a channel goes to its product shelf', () => {
  const d = L.decide(video('Budweiser | Television Commercial | 1988 | USA Olympics', 'Video/Channels/USA Network/1980s'), ans({ kind: ['One product advert', 1], category: ['Beer, Wine & Spirits', 0.99] }));
  assert.strictEqual(d.to, 'Video/Commercials/Beer, Wine & Spirits/1980s');
  const promo = L.decide(video('ABC Fall Preview 1989', 'Video/Channels/ABC/1980s'), ans({ kind: ['Promo for a TV programme or channel', 1], category: ['Movies & Home Entertainment', 0.9] }));
  assert.strictEqual(promo.to, null);
});

test('Other Commercials is not re-guessed, and costs no Jev question without a flag to raise', () => {
  assert.strictEqual(L.questionsFor(video("Mueller's ad, 1978", 'Video/Commercials/Other Commercials/1970s')), null);
  assert.strictEqual(L.decide(video("Mueller's ad, 1978", 'Video/Commercials/Other Commercials/1970s'), ans({ kind: ['One product advert', 1], category: ['Medicine & Pharmacy', 0.94] })).to, null);
});

test('VHS tapes get a kind shelf; home movies need 0.85 and are flagged', () => {
  const vhs = (t) => video(t, 'Video/Home Video (VHS)/1990s');
  assert.strictEqual(L.decide(vhs('Deep Cover (1992) VHS Trailer'), ans({ tape: ['Openings & Previews', 0.86] })).to, 'Video/Home Video (VHS)/Openings & Previews/1990s');
  const sears = L.decide(vhs('Sears Get A Picture Taken with ET 1991'), ans({ tape: ['Home Movies', 0.76] }));
  assert.strictEqual(sears.to, null);
  assert.deepStrictEqual(sears.flags, []);
  const family = L.decide(vhs('Safari, Carnival, Rides & Aquatic Show On April 3, 1991 Family Video'), ans({ tape: ['Home Movies', 1] }));
  assert.strictEqual(family.to, 'Video/Home Video (VHS)/Home Movies/1990s');
  assert.deepStrictEqual(family.flags, ['Space review: family or local home recording.']);
  assert.strictEqual(L.decide(vhs('Zondervan Video (VHS)'), ans({ tape: ['Other Tapes', 0.82] })).to, null);
});

test('full sports games are flagged, never moved; Missouri teams are left alone', () => {
  const game = video('Auburn Tigers at LSU Tigers | College Football | 1997', 'Video/Commercials/Education & Careers/1990s', { bytes: 1.2e9 });
  const d = L.decide(game, ans({ kind: ['Episode or clip of a TV programme', 0.6] }));
  assert.strictEqual(d.to, null);
  assert.deepStrictEqual(d.flags, ['Space review: full sports game broadcast.']);
  const cards = video('Chiefs @ Raiders NFL 1995', 'Video/Channels/NBC/1990s', { bytes: 1.2e9 });
  assert.deepStrictEqual(L.decide(cards, ans({})).flags, []);
});

test('questions: only what the item needs', () => {
  const q = L.questionsFor(video('Budweiser ad 1988', 'Video/Channels/USA Network/1980s'));
  assert.deepStrictEqual(Object.keys(q).sort(), ['category', 'kind']);
  const mo = L.questionsFor(video('KSDK news 1990', 'Videos/Needs Filing/Archive Intake'));
  assert.ok(mo.recorded && mo.madefor && mo.local && mo.area && mo.localKind);
  const uk = L.questionsFor(video('British Gas advert 1986', 'Video/Commercials/Gas, Oil & Auto Care/1980s'));
  assert.ok(uk.foreign);
  assert.strictEqual(L.questionsFor({ kind: 'audio', title: 'x', path: 'Audio/Radio Commercials/Banks & Insurance' }), null);
});

test('the description Jev reads drops headers, links and disclaimers', () => {
  const text = 'Source: https://www.youtube.com/watch?v=abc\nMatched by: TubeVault download history\nPublisher description (video):\nCommercial breaks from WGN, 1994.\nNo copyright infringement intended.\nhttp://x.y/z';
  assert.strictEqual(L.clean(text), 'Commercial breaks from WGN, 1994.');
});

test('fileMedia never throws: a failed item comes back with error and stays put', async () => {
  const items = [video('Nickelodeon commercial breaks 2004', 'Videos/Needs Filing/Archive Intake', { _id: 'a' }), video('Boom 1999', 'Videos/Needs Filing/Archive Intake', { _id: 'b' }),
    video('Noggin commercial breaks 2004', 'Videos/Needs Filing/Archive Intake', { _id: 'c' })];
  const asked = [];
  const ask = async (state) => {
    asked.push(state.title);
    if (state.title.startsWith('Boom')) throw new Error('timeout');
    return { answers: ans({ kind: ['Block of several commercials', 1] }), usage: { input_tokens: 1000 } };
  };
  const { decisions, costUSD } = await L.fileMedia(items, { ask });
  const byTitle = Object.fromEntries(decisions.map((d) => [d.item.title, d]));
  assert.strictEqual(byTitle['Nickelodeon commercial breaks 2004'].to, 'Video/Commercials/Commercial Breaks/Nickelodeon/2000s');
  assert.strictEqual(byTitle['Noggin commercial breaks 2004'].to, 'Video/Commercials/Commercial Breaks/Noggin/2000s', 'a kids block files by rule');
  assert.ok(!asked.includes('Noggin commercial breaks 2004'), 'and Jev is not asked about it');
  assert.strictEqual(byTitle['Boom 1999'].to, null);
  assert.strictEqual(byTitle['Boom 1999'].error, 'timeout');
  assert.ok(costUSD > 0);
});

test('probably not wanted: foreign at 0.9, AFN is American, Missouri always wanted', () => {
  const v = (title, channel, foreign, home = 0.1) => L.wantVerdict({ title, channel }, { foreign: { noul: foreign }, home: { noul: home } });
  assert.match(v('Nicktoons (UK) Commercial Break (December 14, 2017)', "Evan's Media Archive", 0.97).skip, /made outside the US \(0\.97\)/);
  assert.strictEqual(v('KARD Promo Station ID 2017', "David's TV and Commercial Archives", 0.82).skip, null, 'below the cut: downloaded');
  assert.strictEqual(v('AFN Germany promos, 7/14/1994 (partial)', 'The AVTB Archives', 0.9).skip, null, 'American Forces Network');
  assert.strictEqual(L.wantQuestions({ title: 'AFN Germany promos/PSAs, 7/1/1994-A' }).foreign, undefined, 'not even asked');
  assert.strictEqual(v('KY3 Springfield news open 1996', '', 0.99, 0.99).skip, null);
  assert.strictEqual(L.wantQuestions({ title: 'KSDK Channel 5 promo 1990' }), null);
  assert.match(v("Emma's 5th birthday party 1994", 'Our family tapes', 0.05, 0.93).skip, /home movie/);
  assert.strictEqual(v('Norwalk High School Marching Bears - Tournament of Roses Performance - 1990', 'Random Stuff I Find on VHS', 0.02, 0.6).skip, null);
});

test('probably not wanted: full games by title, never their promos, ads or highlights', () => {
  assert.strictEqual(L.wantVerdict({ title: 'Auburn Tigers @ Ole Miss Rebels (2006) NCAA College Football' }).skip, 'a full sports game');
  assert.strictEqual(L.wantVerdict({ title: 'June 8, 1992 WGN Chicago Bulls vs Portland Trailblazers NBA Finals Game 3 Coverage' }).skip, 'a full sports game');
  assert.strictEqual(L.wantVerdict({ title: '1996 CBS College Football Tennessee vs UCLA promo' }).skip, null);
  assert.strictEqual(L.wantVerdict({ title: '1986 MacGyver & ABC NFL Monday Night Football Commercial' }).skip, null);
  assert.strictEqual(L.wantVerdict({ title: '1988 Kansas Jayhawks vs Oklahoma Sooners NCAA Basketball Championship Game Highlights' }).skip, null);
  assert.strictEqual(L.wantVerdict({ title: 'Chiefs vs Raiders NFL 1994' }).skip, null, 'a Missouri team');
  assert.strictEqual(L.fullSportsGame({ title: 'GT Merchandising & Licensing/Dragonfly Productions/GoodTimes Entertainment (2003)' }), false, 'Dragonfly is not the NFL');
});

test('probably not wanted: a batch never throws, a failure is wanted', async () => {
  const ask = async (state) => {
    if (/boom/.test(state.title)) throw new Error('timeout');
    return { answers: { foreign: { noul: /Canada/.test(state.title) ? 0.95 : 0.1 }, home: { noul: 0.1 } }, usage: { input_tokens: 1000 } };
  };
  const { verdicts, costUSD } = await L.judgeWanted([
    { key: 'a', title: 'Cartoon Network Canada Described Video notice (2021)', channel: 'The AVTB Archives' },
    { key: 'b', title: 'boom', channel: '' },
    { key: 'c', title: '1996 Crest commercial', channel: 'Retro TV Commercials' },
  ], { ask });
  const by = Object.fromEntries(verdicts.map((v) => [v.key, v]));
  assert.match(by.a.skip, /outside the US/);
  assert.strictEqual(by.b.skip, null);
  assert.ok(by.b.error);
  assert.strictEqual(by.c.skip, null);
  assert.ok(costUSD > 0);
  assert.strictEqual(L.wantState({ title: 'x', channel: 'CBZ VHS' }).description, 'Posted by the YouTube channel "CBZ VHS". No description has been read yet.');
});

test('local to another area: skipped from downloads at 0.85, flagged on new arrivals at 0.8, never her part of the country', () => {
  const v = (title, elsewhere) => L.wantVerdict({ title, channel: "David's TV and Commercial Archives" }, { foreign: { noul: 0.05 }, home: { noul: 0.05 }, elsewhere: { noul: elsewhere } });
  assert.match(v('Northeast Furniture Mart ad 1993 (Vidalia, LA)', 0.95).skip, /local to another area \(0\.95\)/);
  assert.strictEqual(v('December 1994 Ray Skillman Discount Mitsubishi commercial', 0.84).skip, null, 'below the download cut');
  assert.strictEqual(v('Harrison, AR Pizza Hut grand opening 1992', 0.97).skip, null, 'Arkansas is hers');
  assert.strictEqual(L.wantQuestions({ title: 'KHBS 40/29 news open 1996' }), null);
  assert.ok(L.wantQuestions({ title: 'WOLF Fox 56 id montage 2001' }).elsewhere);
  const intake = { kind: 'video', title: 'Waterbed Palace ad 1987 Colorado Springs', path: 'Videos/Needs Filing/Archive Intake', description: '' };
  assert.ok(L.questionsFor(intake).elsewhere);
  const flags = L.decide(intake, { kind: { choice: 'Commercial', confidence: 0.9 }, category: { choice: 'Furniture & Mattresses', confidence: 0.9 }, elsewhere: { noul: 0.93 } }).flags;
  assert.ok(flags.includes('Space review: local to another area (0.93).'), flags);
  assert.strictEqual(L.questionsFor({ kind: 'video', title: 'KY3 news open 1996', path: 'Videos/Needs Filing/Archive Intake' }).elsewhere, undefined);
});

/* ── Part 296: Full Movies and Full TV (her words, Sep 27: "Yes I want a full movies shelf and tv eps") ── */
const MIN = 60;
const INTAKE = 'Videos/Needs Filing/Archive Intake';
const fresh = (title, path, seconds, extra = {}) => video(title, path, { seconds, _fresh: true, ...extra });
const fullTo = (item, deps = {}) => (L.fullShelfFact(item, deps) || {}).to || null;

test('Full Movies: a new upload whose title says it is a whole film, by decade (her five VHS feature films as they would arrive)', () => {
  assert.strictEqual(fullTo(fresh('Millennium (1989, VHS) Full Movie', 'Video/Home Video (VHS)/1980s', 6650)), 'Video/Full Movies/1980s');
  assert.strictEqual(fullTo(fresh('Straight Out of Compton (2000, VHS) Full Movie', 'Video/Home Video (VHS)/2000s', 4804)), 'Video/Full Movies/2000s');
  assert.strictEqual(fullTo(fresh('Hello, Fools! (1996, VHS) Russian, Very Rare, No English Subs, Full Feature Film', 'Video/Home Video (VHS)/1990s', 6729)), 'Video/Full Movies/1990s');
  assert.strictEqual(fullTo(fresh('Code Name Alpha aka Red Dragon (1965, VHS)', 'Video/Home Video (VHS)/Feature Films/1960s', 5184)), 'Video/Full Movies/1960s', 'the Feature Films shelf says so');
  assert.strictEqual(fullTo(fresh('Lost in Dinosaur World (1993, VHS)', 'Video/Home Video (VHS)/Feature Films/1990s', 1646)), null, 'a 27-minute tape is not a feature film');
  const d = L.decide(fresh('Millennium (1989, VHS) Full Movie', 'Video/Home Video (VHS)/1980s', 6650), {});
  assert.strictEqual(d.to, 'Video/Full Movies/1980s');
  assert.strictEqual(d.why, 'a whole film: its title says so');
  assert.strictEqual(L.questionsFor(fresh('Millennium (1989, VHS) Full Movie', 'Video/Home Video (VHS)/1980s', 6650)), null, 'Jev is never asked about a rule');
  assert.strictEqual(L.categoryOf('Video/Full Movies/1980s', 'video'), 'movie');
  assert.strictEqual(L.categoryOf('Videos/Full TV/Rugrats/Season 2', 'video'), 'tv');
});

test('Full Movies: 40 minutes with plain film words, an hour with plainer ones; the release year sets the decade', () => {
  assert.strictEqual(fullTo(video('The Night Stalker (1972 TV movie)', INTAKE, { seconds: 74 * MIN })), 'Video/Full Movies/1970s');
  assert.strictEqual(fullTo(video('Halloweentown (1998) Disney Channel Original Movie', INTAKE, { seconds: 84 * MIN })), 'Video/Full Movies/1990s');
  assert.strictEqual(fullTo(video('The Rugrats Movie (1998)', INTAKE, { seconds: 80 * MIN })), 'Video/Full Movies/1990s');
  assert.strictEqual(fullTo(video('Winnie the Pooh movie night', INTAKE, { seconds: 50 * MIN })), null, 'under an hour, "movie" alone is not enough');
  assert.strictEqual(fullTo(video('Pinocchio (1940 film)', INTAKE, { seconds: 50 * MIN })), 'Video/Full Movies/1940s', 'at 40 minutes the plain words do it');
  assert.strictEqual(fullTo(video('Some Title', INTAKE, { seconds: 95 * MIN, category: 'movie' })), 'Video/Full Movies/Undated', 'the movie category at film length');
  assert.strictEqual(fullTo(fresh('A film', 'Video/Channels/Other Channels/1980s', 95 * MIN)), 'Video/Full Movies/1980s', 'no year in the title: the shelf decade');
});

test('Full Movies and Full TV never take a channel recording, a pile, a piece, a short, an old shelf item or anything from her part of the country', () => {
  // channel recordings stay on the channel (her channel and block rules)
  assert.strictEqual(fullTo(fresh('Embassy (1985) ABC Sunday Night Movie with Original Commercials', 'Video/Channels/ABC/1980s', 120 * MIN)), null);
  assert.deepStrictEqual(L.fullQuestions(fresh('Embassy (1985) ABC Sunday Night Movie with Original Commercials', 'Video/Channels/ABC/1980s', 120 * MIN)), {});
  assert.strictEqual(fullTo(video('SNICK full episode 1995 Clarissa Explains It All S01E01', INTAKE, { seconds: 25 * MIN })), null, 'a programming block named');
  assert.strictEqual(fullTo(video('Rugrats S02E05 with commercials', INTAKE, { seconds: 30 * MIN })), null);
  assert.strictEqual(fullTo(video('Rugrats S02E05 aired on Nickelodeon 1993', INTAKE, { seconds: 30 * MIN })), null, 'a network and "aired"');
  assert.strictEqual(fullTo(video('Cartoon Network marathon Dexter Season 1', INTAKE, { seconds: 60 * MIN })), null);
  // piles and pieces
  assert.strictEqual(fullTo(video('Disney VHS Trailers Compilation (Full Movie Previews)', INTAKE, { seconds: 70 * MIN })), null);
  assert.strictEqual(fullTo(video('Titanic (1997) behind the scenes feature film special', INTAKE, { seconds: 45 * MIN })), null);
  assert.strictEqual(fullTo(video('Millennium (1989) Full Movie Part 1 of 3', INTAKE, { seconds: 45 * MIN })), null);
  assert.strictEqual(fullTo(video('Rugrats S01E01 intro', INTAKE, { seconds: 1 * MIN })), null);
  assert.strictEqual(fullTo(video("Rugrats S01E01 Tommy's First Birthday", INTAKE, { seconds: 11 * MIN })), null, "under 15 minutes: today's rules");
  assert.strictEqual(fullTo(video('Rugrats S01E01', INTAKE, { seconds: 0 })), null, 'no length, no title rule');
  // an item already on a shelf is never re-read for this (the audit pass applies its moves)
  assert.strictEqual(fullTo(video('Millennium (1989, VHS) Full Movie', 'Video/Home Video (VHS)/1980s', { seconds: 6650 })), null);
  assert.strictEqual(L.decide(video('Millennium (1989, VHS) Full Movie', 'Video/Home Video (VHS)/1980s', { seconds: 6650 }), {}).to, null);
  assert.strictEqual(fullTo(fresh('Rugrats S02E05', 'Video/Full TV/Rugrats/Season Two', 23 * MIN)), null, 'already on a Full shelf: stays where it was put');
  // her part of the country comes first
  assert.strictEqual(fullTo(fresh('The Saint Louis Cardinals The Movie (1985)', 'Video/Missouri/St. Louis (Local)', 60 * MIN)), null, 'her Missouri shelves are never moved from');
  assert.strictEqual(fullTo(video('The Saint Louis Cardinals The Movie (1985)', INTAKE, { seconds: 60 * MIN })), null, 'naming St. Louis');
  assert.strictEqual(fullTo(video('Ozarks Today S01E03 (KY3)', INTAKE, { seconds: 28 * MIN })), null, "a local show's episode");
  assert.deepStrictEqual(L.fullQuestions(video('KOLR 10 Springfield Christmas special full movie', INTAKE, { seconds: 70 * MIN })), {});
  assert.strictEqual(fullTo(video('Tommy', 'Video/Needs Filing/TV/Ozarks Today/Season 1', { seconds: 28 * MIN })), null, 'even in her TV folder');
  const local = L.decide(video('Ozarks Today S01E03 (KY3)', INTAKE, { seconds: 28 * MIN }), {
    kind: { choice: 'Episode or clip of a TV programme', confidence: 0.9 }, episode: { noul: 0.99 }, recorded: { noul: 0.9 }, madefor: { noul: 0.9 }, local: { noul: 0.9 },
    area: { choice: 'Springfield and the Ozarks', confidence: 0.9 }, localKind: { choice: 'Around the Ozarks', confidence: 0.9 },
  });
  assert.ok(local.to.startsWith('Video/Ozarks (Springfield Area)'), 'a full local episode goes to her Ozarks shelves');
});

test('Full TV: an episode code and a show name, 15 to 65 minutes, filed Show then Season', () => {
  assert.strictEqual(fullTo(fresh('Rugrats S02E05 - Chuckie vs the Potty', 'Video/Channels/Nickelodeon/1990s', 23 * MIN)), 'Video/Full TV/Rugrats/Season 2');
  assert.strictEqual(fullTo(video('The Big Bang Theory - Season 2 Episode 3 - The Barbarian Sublimation', INTAKE, { seconds: 21 * MIN })), 'Video/Full TV/The Big Bang Theory/Season 2');
  assert.strictEqual(fullTo(video('Family.Guy.S09E01.720p', INTAKE, { seconds: 22 * MIN })), 'Video/Full TV/Family Guy/Season 9', 'a dotted file name');
  assert.strictEqual(fullTo(video("1995 Hey Arnold! 1x02 Arnold's Christmas", INTAKE, { seconds: 22 * MIN })), 'Video/Full TV/Hey Arnold!/Season 1');
  assert.strictEqual(fullTo(video("Doug S00E01 Doug's Christmas Story", INTAKE, { seconds: 24 * MIN })), 'Video/Full TV/Doug/Specials');
  assert.strictEqual(fullTo(video('Arthur Episode 12', INTAKE, { seconds: 25 * MIN })), 'Video/Full TV/Arthur/Other episodes', 'no season');
  assert.strictEqual(fullTo(video('Rugrats (1991) Full Episode', INTAKE, { seconds: 23 * MIN })), 'Video/Full TV/Rugrats/Other episodes');
  assert.strictEqual(fullTo(video('Nickelodeon Rugrats S01E01', INTAKE, { seconds: 23 * MIN })), 'Video/Full TV/Rugrats/Season 1', 'a channel name before the show is not the show');
  assert.strictEqual(fullTo(video('ER S03E10', INTAKE, { seconds: 44 * MIN })), 'Video/Full TV/ER/Season 3', 'an hour drama without its adverts');
  assert.strictEqual(fullTo(video('Rugrats S01E01', INTAKE, { seconds: 70 * MIN })), 'Video/Full TV/Rugrats/Season 1', 'Part 297: a coded episode up to 100 minutes (two or three parts in one file)');
  assert.strictEqual(fullTo(video('[S12.E08] Christmas Guy', INTAKE, { seconds: 22 * MIN })), null, "no show named: today's rules");
  assert.strictEqual(fullTo(video("Full Episode: Hey Arnold! - Arnold's Christmas", INTAKE, { seconds: 22 * MIN })), null, 'no code and no known show');
  const d = L.decide(fresh('Rugrats S02E05 - Chuckie vs the Potty', 'Video/Channels/Nickelodeon/1990s', 23 * MIN), {});
  assert.strictEqual(d.why, 'a whole episode: its title says so');
  assert.strictEqual(d.confidence, 1);
});

test('Full TV: shows her described audio TV side knows, and the spellings Full TV already has', () => {
  const knownShows = L.knownShows([
    'Audio/Described Movies & TV/TV/Family guy/Family Guy Season 9 not described',
    'Audio/Described Movies & TV/TV/Insecure Season 1',
    'Audio/Described Movies & TV/TV/Assorted (One-Offs)',
    'Audio/Described Movies & TV/TV/Hey Arnold!/Season 1',
  ], ["Video/Full TV/Schitt's Creek/Season 1"]);
  assert.deepStrictEqual([...knownShows.values()].sort(), ['Family guy', 'Hey Arnold!', 'Insecure', "Schitt's Creek"]);
  const fullShelves = L.fullIndex(["Video/Full TV/Schitt's Creek/Season 1", 'Video/Full TV/Family Guy/Family Guy Season 9']);
  const deps = { knownShows, fullShelves };
  assert.strictEqual(fullTo(video('schitts creek S01E02', INTAKE, { seconds: 22 * MIN }), deps), "Video/Full TV/Schitt's Creek/Season 1", "Full TV's spelling wins");
  assert.strictEqual(fullTo(video('Family Guy S09E03 Excellence in Broadcasting', INTAKE, { seconds: 22 * MIN }), deps), 'Video/Full TV/Family Guy/Family Guy Season 9', 'a season folder of hers keeps its words');
  assert.strictEqual(fullTo(video('Insecure Season 1 Episode 1', INTAKE, { seconds: 30 * MIN }), deps), 'Video/Full TV/Insecure/Season 1', 'the described side names the show');
  assert.strictEqual(fullTo(video("Full Episode: Hey Arnold! - Arnold's Christmas", INTAKE, { seconds: 22 * MIN }), deps), 'Video/Full TV/Hey Arnold!/Other episodes');
  // no code: Jev is asked whether it is one whole episode, only when the show can be named
  const bare = video("Hey Arnold! - Arnold's Christmas", INTAKE, { seconds: 22 * MIN });
  assert.strictEqual(fullTo(bare, deps), null);
  assert.ok(L.questionsFor(bare, deps).episode);
  assert.strictEqual(L.questionsFor(bare, {}).episode, undefined, 'no show name, no question');
  const yes = L.decide(bare, { kind: { choice: 'Episode or clip of a TV programme', confidence: 0.9 }, episode: { noul: 0.93 } }, deps);
  assert.strictEqual(yes.to, 'Video/Full TV/Hey Arnold!/Other episodes');
  assert.strictEqual(yes.why, 'a whole episode (Jev)');
  const unsure = L.decide(bare, { kind: { choice: 'Episode or clip of a TV programme', confidence: 0.9 }, episode: { noul: 0.6 } }, deps);
  assert.ok(!String(unsure.to || '').includes('Full TV'), "unsure: today's rules");
  const short = L.decide(video("Hey Arnold! - Arnold's Christmas", INTAKE, { seconds: 10 * MIN }), { kind: { choice: 'Episode or clip of a TV programme', confidence: 0.9 }, episode: { noul: 0.99 } }, deps);
  assert.strictEqual(short.to, 'Video/TV Shows/Assorted (One-Offs)/Undated', 'too short whatever Jev says');
});

test('Full TV and Full Movies from her own folders, word for word, the way her described MP3s were filed', () => {
  assert.strictEqual(fullTo(video("Tommy's First Birthday", 'Video/Needs Filing/TV/Rugrats/Season 1', { seconds: 23 * MIN })), 'Video/Full TV/Rugrats/Season 1');
  assert.strictEqual(fullTo(video('Episode 1', 'Videos/Needs Filing/TV/Insecure Season 1', { seconds: 30 * MIN })), 'Video/Full TV/Insecure/Insecure Season 1', 'a bare season folder joins its show (the depth rule)');
  assert.strictEqual(fullTo(video('Fast and Furry-ous', 'Video/Needs Filing/TV/Looney Tunes/Season 1', { seconds: 7 * MIN })), 'Video/Full TV/Looney Tunes/Season 1', 'a cartoon short is still an episode');
  assert.strictEqual(fullTo(video('Theme', 'Video/Needs Filing/TV/Looney Tunes/Season 1', { seconds: 1 * MIN })), null, "under 5 minutes: today's rules");
  assert.strictEqual(fullTo(video("Tommy's First Birthday", 'Video/Needs Filing/TV/Rugrats/Season 1', {})), 'Video/Full TV/Rugrats/Season 1', 'no length yet: her folder says so');
  assert.strictEqual(fullTo(video('Rugrats S03E02', 'Video/Needs Filing/TV', { seconds: 23 * MIN })), 'Video/Full TV/Rugrats/Season 3', 'straight in her TV folder: the show from the title');
  assert.strictEqual(fullTo(video('Some special', 'Video/Needs Filing/TV', { seconds: 23 * MIN })), 'Video/Full TV/Assorted (One-Offs)');
  const index = L.fullIndex(['Video/Full TV/Rugrats/season 1']);
  assert.strictEqual(fullTo(video('x', 'Video/Needs Filing/TV/rugrats/Season 1', { seconds: 23 * MIN }), { fullShelves: index }), 'Video/Full TV/Rugrats/season 1', "the shelf's spelling when only the case differs");
  assert.strictEqual(fullTo(video('Frozen', 'Video/Needs Filing/Movies/Frozen (2013)', { seconds: 102 * MIN })), 'Video/Full Movies/2010s');
  assert.strictEqual(fullTo(video('Frozen trailer', 'Video/Needs Filing/Movies', { seconds: 2 * MIN })), null, "under 40 minutes in her Movies folder: today's rules");
  assert.strictEqual(fullTo(video('Frozen soundtrack', 'Video/Needs Filing/Movies', { seconds: 90 * MIN })), null, 'a soundtrack is music');
  assert.strictEqual(L.decide(video("Tommy's First Birthday", 'Video/Needs Filing/TV/Rugrats/Season 1', { seconds: 23 * MIN }), {}).why, 'her TV folder: a whole episode');
});

test('Jev for a long video with no words of its own: one whole feature film at an hour, a feature-film tape at 40 minutes', () => {
  const barbell = video('Captain Barbell (VHS, 2003)', INTAKE, { seconds: 7453 });
  assert.strictEqual(fullTo(barbell), null);
  assert.ok(L.questionsFor(barbell).film, 'asked');
  assert.strictEqual(L.questionsFor(video('Captain Barbell (VHS, 2003)', INTAKE, { seconds: 30 * MIN })).film, undefined, 'under an hour, not asked');
  const yes = L.decide(barbell, { kind: { choice: 'Something else', confidence: 0.5 }, film: { noul: 0.91 } });
  assert.strictEqual(yes.to, 'Video/Full Movies/2000s');
  assert.strictEqual(yes.why, 'a whole film (Jev)');
  assert.ok(!String(L.decide(barbell, { kind: { choice: 'Special-interest or instructional tape', confidence: 0.8 }, film: { noul: 0.5 } }).to).includes('Full Movies'));
  // a tape the tape question calls a feature film, new on the VHS shelf
  const tape = fresh('Rare Kung Fu Tape (VHS, 1994)', 'Video/Home Video (VHS)/1990s', 50 * MIN);
  const q = L.questionsFor(tape);
  assert.ok(q.tape && !q.film, 'the tape question, no film question under an hour');
  assert.strictEqual(L.decide(tape, { kind: { choice: 'Something else', confidence: 0.5 }, tape: { choice: 'Feature Films', confidence: 0.8 } }).to, 'Video/Full Movies/1990s');
  const old = video('Rare Kung Fu Tape (VHS, 1994)', 'Video/Home Video (VHS)/1990s', { seconds: 50 * MIN });
  assert.strictEqual(L.decide(old, { kind: { choice: 'Something else', confidence: 0.5 }, tape: { choice: 'Feature Films', confidence: 0.8 } }).to, 'Video/Home Video (VHS)/Feature Films/1990s', "an old shelf item keeps today's rule");
  assert.strictEqual(L.lengthWords(7453), '2 hours 4 minutes');
  assert.strictEqual(L.lengthWords(22 * MIN), '22 minutes');
  assert.strictEqual(L.lengthWords(60 * MIN), '1 hour');
});

test("the whole-film question reads the video's length; other questions read the state as before", async () => {
  const states = [];
  const ask = async (state) => {
    states.push(state);
    return { answers: { kind: { choice: 'Something else', confidence: 0.5 }, film: { noul: 0.95 }, elsewhere: { noul: 0.1 } }, usage: { input_tokens: 10 } };
  };
  const { decisions } = await L.fileMedia([
    video('Captain Barbell (VHS, 2003)', INTAKE, { tracks: [{ seconds: 7453 }] }),
    video('Zest soap commercial 1985', INTAKE, { tracks: [{ seconds: 30 }] }),
  ], { ask, concurrency: 1 });
  assert.strictEqual(states[0].length, '2 hours 4 minutes', 'the length comes from the tracks when the item has no total');
  assert.strictEqual(states[1].length, undefined);
  assert.strictEqual(decisions.find((x) => /Barbell/.test(x.item.title)).to, 'Video/Full Movies/2000s');
  assert.ok(!String(decisions.find((x) => /Zest/.test(x.item.title)).to).includes('Full'));
});

test('Full TV names the show the way her downloaded titles write it (from the Sep 26 catalog copy)', () => {
  const at = (title, minutes) => fullTo(video(title, INTAKE, { seconds: minutes * MIN }));
  assert.strictEqual(at('Another World (1986) - NBC - Full Episode', 43), 'Video/Full TV/Another World/Other episodes');
  assert.strictEqual(at('CNET Central (1997) Digital Volunteers; Failed Web Companies ｜ Full Episode', 22), 'Video/Full TV/CNET Central/Other episodes');
  assert.strictEqual(at('Extreme Dodgeball (2004 GSN Show) Episode 1 (Rough Cut Version)', 21), 'Video/Full TV/Extreme Dodgeball/Other episodes');
  assert.strictEqual(at('SportsCenter ｜ 03-18-1995 ｜ Michael Jordan Returns Full Episode', 23), 'Video/Full TV/SportsCenter/Other episodes');
  assert.strictEqual(at("Herman's Head Season 1 Episode 25 ＂Twisted Sister＂", 29), "Video/Full TV/Herman's Head/Season 1");
  assert.strictEqual(at('Tough Crowd with Colin Quinn - Episode 143： Jim Norton, Jeff Cesario', 30), 'Video/Full TV/Tough Crowd with Colin Quinn/Other episodes');
  assert.strictEqual(at('Zoom ｜ S3E302 ｜ PBS Kids', 28), null, 'a programming block named: the channel keeps it');
  assert.strictEqual(fullTo(fresh('Captain Barbell (VHS, 2003)', 'Video/Home Video (VHS)/Feature Films/2000s', 7453)), 'Video/Full Movies/2000s');
  assert.strictEqual(L.fullShelfFact(fresh('Captain Barbell (VHS, 2003)', 'Video/Home Video (VHS)/Feature Films/2000s', 7453)).why, 'a whole film: the Feature Films shelf');
});

test("a short show name her shelves know never swallows a longer one: the described side's Star is not Star Trek", () => {
  const knownShows = new Map([['star', 'Star'], ['family guy', 'Family guy']]);
  const deps = { knownShows };
  const at = (title) => video(title, INTAKE, { seconds: 45 * MIN });
  assert.strictEqual(fullTo(at('Star Trek S01E01 The Man Trap'), deps), 'Video/Full TV/Star Trek/Season 1');
  assert.strictEqual(L.showFor(at('Star Trek - The Menagerie'), deps), null, 'no code and not a known show: nothing to name');
  assert.deepStrictEqual(L.fullQuestions(at('Star Trek - The Menagerie'), deps), {});
  assert.strictEqual(L.showFor(at('Star - Pilot'), deps), 'Star');
  assert.strictEqual(fullTo(at('Family Guy S09E01'), deps), 'Video/Full TV/Family guy/Season 9', 'the spelling her described side uses');
});

test('Part 296 review: news, commercials, music, radio, events, pieces and piles never reach a Full shelf', () => {
  const at = (title, minutes, path = INTAKE, extra = {}) => fullTo(video(title, path, { seconds: minutes * MIN, ...extra }));
  const asked = (title, minutes, path = INTAKE, extra = {}) => Object.keys(L.fullQuestions(video(title, path, { seconds: minutes * MIN, ...extra }), { knownShows: new Map([['friends', 'Friends']]) }));
  // local news of anywhere, and national news, is never a Full TV episode (her channel and local-first rules keep it)
  assert.strictEqual(at('NBC Nightly News - Full Episode (1995)', 30), null);
  assert.strictEqual(at('Local 4 News at 11 (Detroit, 1992) Full Episode', 30), null, "another city's local news");
  assert.strictEqual(at('Channel 2 Action News Season 1 Episode 4', 30), null);
  assert.strictEqual(at('WGN News at Nine (1994) Full Episode', 30), null);
  assert.strictEqual(at('KY3 News at 10 - Full Episode', 30), null, 'her own local news: local first');
  assert.deepStrictEqual(asked('Friends News Special', 22), [], 'no whole-episode question about news either');
  assert.strictEqual(at('Broadcast News (1987) Full Movie', 133), 'Video/Full Movies/1980s', 'a film is not read for the news word');
  // commercials and paid programming, and anything already filed as a commercial, PSA, music or radio
  assert.strictEqual(at('George Foreman Grill Paid Programming Episode 3 (1996)', 28), null);
  assert.strictEqual(at('80s Toy Commercials Vol 1 Full Episode', 30), null);
  assert.strictEqual(fullTo(fresh('Rugrats S02E05 (1993)', 'Video/Commercials/Toys & Video Games/1990s', 23 * MIN)), null, 'a new upload filed as a commercial stays one');
  assert.strictEqual(fullTo(fresh('Home Alone (1990) Full Movie', 'Video/Commercials/Toys & Video Games/1990s', 100 * MIN)), null);
  assert.deepStrictEqual(L.fullQuestions(fresh('Your Joint Benefits with Andrew Lessman HSN', 'Video/Commercials/Infomercials & Paid Programming/Undated', 84 * MIN)), {});
  assert.strictEqual(fullTo(fresh('Eminem In Concert (2001) Full Movie', 'Video/Music/Eminem/2000s', 90 * MIN)), null);
  assert.strictEqual(fullTo(fresh('Howard Stern Radio Show Episode 12', 'Video/Radio/Airchecks & Broadcasts/1990s', 40 * MIN)), null);
  assert.strictEqual(at('Some Title (1990) Full Movie', 95, INTAKE, { category: 'commercials' }), null, 'the commercials category');
  assert.strictEqual(fullTo(video('Tommy', 'Video/Needs Filing/TV/Music/Season 1', { seconds: 23 * MIN })), 'Video/Full TV/Music/Season 1', 'her own TV folder is read first');
  assert.strictEqual(at('Show Promo Full Episode S01E01', 20, 'Videos/Advertising/Show Promos (Review)'), null);
  // film music, concerts, radio, home movies
  assert.strictEqual(at('Jaws - Original Film Score (1975)', 45), null);
  assert.strictEqual(at('Star Wars Music from the Motion Picture (1977)', 75), null);
  assert.strictEqual(at('Home Movie 1987 Christmas at Grandmas', 70), null);
  assert.deepStrictEqual(asked('Home Movie 1987 Christmas at Grandmas', 70), [], 'not even asked');
  // pieces and piles
  assert.strictEqual(at('The Burning Bed (1984) Full Movie Part 1', 50), null);
  assert.strictEqual(at('The Burning Bed (1984) Full Movie (1/2)', 50), null);
  assert.deepStrictEqual(asked('Ericksonian Hypnosis (1986, VHS) Tape 1 of 3', 107), []);
  assert.strictEqual(at('Rugrats S01E01-E03', 60), null);
  assert.strictEqual(at('Rugrats Episodes 1-2', 23), null);
  assert.strictEqual(at('Top 10 Episodes of Friends Season 1', 30), null);
  assert.strictEqual(at('3 Full Episodes of Arthur Season 2', 60), null);
  // events, games and specials
  assert.strictEqual(at('Oscars 1995 (Academy Awards) Full Show Episode 67', 60), null);
  assert.strictEqual(at('NBA Finals 1998 Game 6 Full Episode', 60), null);
  assert.strictEqual(at('Sundance Film Festival 1995 coverage', 70), null, 'a plain film word is not enough for a festival');
  assert.strictEqual(at('Bob Hope Christmas Special starring Brooke Shields (1984)', 70), null);
  assert.strictEqual(at('Saturday Night Live starring Steve Martin (1978)', 90), null, '"starring" is not a film word');
  assert.strictEqual(at('Bell Telephone training film (1962)', 62), null);
  // what should still go does
  assert.strictEqual(at('The Tonight Show Starring Johnny Carson (1985) Full Episode', 60), 'Video/Full TV/The Tonight Show Starring Johnny Carson/Other episodes', 'an episode code wins over a film word');
  assert.strictEqual(at('Friends Season 1 Episode 1 The Pilot', 22), 'Video/Full TV/Friends/Season 1');
  assert.strictEqual(at('The Score (2001) Full Movie', 124), 'Video/Full Movies/2000s');
  assert.strictEqual(at('ABC Sunday Night Movie: The Day After (1983)', 120), 'Video/Full Movies/1980s');
});

test('Part 296 review: a film files under its release year, not a number in its name', () => {
  const dec = (title, path = INTAKE) => L.filmDecade({ title, path });
  assert.strictEqual(dec('2001: A Space Odyssey (1968) Full Movie'), '1960s');
  assert.strictEqual(dec('1941 (1979) Full Movie'), '1970s');
  assert.strictEqual(dec('2001 A Space Odyssey 1968 Full Movie'), '1960s', 'no brackets: the year after the name');
  assert.strictEqual(dec('1941 Full Movie'), '1940s', 'the only year');
  assert.strictEqual(dec('Captain Barbell (VHS, 2003)'), '2000s');
  assert.strictEqual(dec('Hello, Fools! (1996, VHS) Russian, Very Rare, No English Subs, Full Feature Film'), '1990s');
  assert.strictEqual(dec('A film', 'Video/Channels/Other Channels/1980s'), '1980s');
  assert.strictEqual(L.showFromTitle('Local 4 (Detroit, 1992) S01E01', L.episodeSign('Local 4 (Detroit, 1992) S01E01')), 'Local 4', 'brackets holding a year end the show');
});

test('Part 297: a downloaded collection files by its own season and Movies folders (her Drake & Josh upload, Sep 28)', () => {
  const COLL = 'Video/Needs Filing/[NICKELODEON] DRAKE AND JOSH [COMPLETE][VERIFIED-VIDZ]';
  const knownShows = L.knownShows([], [], ['Video/TV Shows/Drake & Josh/Promos & Previews/2000s', 'Video/TV Shows/Assorted (One-Offs)/Undated', 'Video/TV Shows/Game Shows/1990s', 'Video/TV Shows/Program Lineups/1990s']);
  assert.deepStrictEqual([...knownShows.values()], ['Drake & Josh'], 'show folders of TV Shows, never its catch-alls');
  const deps = { knownShows };
  const ep = (title, folder, minutes) => fullTo(video(title, `${COLL}/${folder}`, { seconds: minutes * MIN }), deps);
  assert.strictEqual(ep('S02e01.Drake___Josh-(The_Bet)', 'S2', 23), 'Video/Full TV/Drake & Josh/Season 2');
  assert.strictEqual(ep('Drake.and.josh.101.pilot', 'S1', 24), 'Video/Full TV/Drake & Josh/Season 1');
  assert.strictEqual(ep('S04e17-18.Drake___Josh-(Really_Big_Shrimp)', 'S4', 48), 'Video/Full TV/Drake & Josh/Season 4', 'a double episode in a season folder');
  assert.strictEqual(ep('Drake & Josh promo', 'S1', 1), null, "under 5 minutes: today's rules");
  assert.strictEqual(fullTo(video('S02e01.Drake___Josh-(The_Bet)', `${COLL}/S2`, {})), 'Video/Full TV/Drake and Josh/Season 2', 'no known show: the folder, in title case');
  assert.strictEqual(fullTo(video('Merry_Christmas__Drake___Josh', `${COLL}/MOVIES`, { seconds: 87 * MIN })), 'Video/Full Movies/Undated');
  assert.strictEqual(fullTo(video('Drake_And_Josh_Go_Hollywood', `${COLL}/MOVIES`, { seconds: 73 * MIN })), 'Video/Full Movies/Undated');
  assert.strictEqual(fullTo(video('Movie trailer', `${COLL}/MOVIES`, { seconds: 2 * MIN })), null, 'under 40 minutes');
  assert.strictEqual(fullTo(video('Rugrats S01E01', 'Video/Needs Filing/Season 1', { seconds: 23 * MIN })), 'Video/Full TV/Rugrats/Season 1', 'a season folder straight in Needs Filing names no show: the title does');
  assert.strictEqual(L.decide(video('S02e02.Drake___Josh-(Guitar)', `${COLL}/S2`, { seconds: 23 * MIN }), {}, deps).why, 'a season folder in the upload: a whole episode');
  assert.strictEqual(fullTo(video('Ozarks Life episode', 'Video/Needs Filing/KY3 Ozarks Life/Season 1', { seconds: 25 * MIN })), null, 'her part of the country comes first');
});

test('Part 297: file names that put the code first, or write it as three digits after a show her shelves know', () => {
  const deps = { knownShows: new Map([['drake and josh', 'Drake & Josh'], ['family guy', 'Family guy']]) };
  const at = (title, d = deps) => fullTo(video(title, INTAKE, { seconds: 23 * MIN }), d);
  assert.strictEqual(at('S02e01.Drake___Josh-(The_Bet)'), 'Video/Full TV/Drake & Josh/Season 2');
  assert.strictEqual(at('S02e09.Drake_and_Josh-(Drivers_License)', {}), 'Video/Full TV/Drake and Josh/Season 2', 'the name after the code');
  assert.strictEqual(at('S03E04 - Family Guy - Fish Out of Water'), 'Video/Full TV/Family guy/Season 3');
  assert.strictEqual(at('Drake.and.josh.101.pilot'), 'Video/Full TV/Drake & Josh/Season 1');
  assert.strictEqual(at('Drake.and.josh.101.pilot', {}), null, 'three digits only after a known show');
  assert.strictEqual(at('Room.101.Episode', {}), null);
  assert.strictEqual(at('Blink.182.Live.2001', deps), null);
  assert.strictEqual(L.uploadShow('[NICKELODEON] DRAKE AND JOSH [COMPLETE][VERIFIED-VIDZ]'), 'Drake and Josh');
  assert.strictEqual(L.uploadShow('Family.Guy.Complete.Series.720p'), 'Family Guy');
  assert.strictEqual(L.uploadShow('Rugrats (1991-2004) Complete'), 'Rugrats');
  assert.strictEqual(L.uploadShow('[COMPLETE]'), null);
  // her As Told By Ginger upload, the same afternoon: a running number before the show made 7 show folders
  const GINGER = 'Video/Needs Filing/As Told By Ginger - Entire series in ENGLISH no subtitles';
  assert.strictEqual(fullTo(video('007. As Told By Ginger - Ep07 - Hello Stranger', GINGER, { seconds: 22 * MIN })), 'Video/Full TV/As Told By Ginger/Other episodes');
  assert.strictEqual(fullTo(video('006. As Told By Ginger - Ep06- Dare I, Darren', GINGER, { seconds: 22 * MIN })), 'Video/Full TV/As Told By Ginger/Other episodes');
  assert.strictEqual(fullTo(video('12 - Rugrats - S02E05', INTAKE, { seconds: 23 * MIN })), 'Video/Full TV/Rugrats/Season 2');
  assert.strictEqual(fullTo(video('2 Broke Girls - S01E01 - Pilot', INTAKE, { seconds: 22 * MIN })), 'Video/Full TV/2 Broke Girls/Season 1', 'a number that is part of the name stays');
  // the same upload's last two: an episode whose name starts with a number, and three parts in one 69-minute file
  assert.strictEqual(fullTo(video('056. As Told By Ginger - Ep 56 - 10 Chairs', GINGER, { seconds: 23 * MIN })), 'Video/Full TV/As Told By Ginger/Other episodes', 'a range counts upward: not episodes 56 to 10');
  assert.strictEqual(fullTo(video('057. As Told By Ginger - Ep 57 - The Wedding Frame', GINGER, { seconds: 69 * MIN })), 'Video/Full TV/As Told By Ginger/Other episodes', 'a coded episode up to 100 minutes');
  assert.strictEqual(fullTo(video('S04e17-18.Drake___Josh-(Really_Big_Shrimp)', INTAKE, { seconds: 48 * MIN })), 'Video/Full TV/Drake & Josh/Season 4', 'two episodes in a row are one double episode');
  assert.strictEqual(fullTo(video('Rugrats S01E01-E03', INTAKE, { seconds: 69 * MIN })), null, 'three episodes are still a pile');
  assert.strictEqual(fullTo(video('South Park S14E05 - 200', 'Video/Needs Filing/South Park/South Park Season 14', { seconds: 22 * MIN })), 'Video/Full TV/South Park/Season 14', 'an episode called "200" is not episodes 5 to 200');
  assert.strictEqual(fullTo(video('South Park S14E06 - 201', INTAKE, { seconds: 22 * MIN })), 'Video/Full TV/South Park/Season 14');
  assert.strictEqual(fullTo(video('Rugrats Episodes 4-9 (1992)', INTAKE, { seconds: 60 * MIN })), null);
  assert.strictEqual(fullTo(video('Rugrats S01E13 & S02E01', INTAKE, { seconds: 46 * MIN })), null, 'two seasons in one file');
  assert.strictEqual(fullTo(video('Rugrats S02E05', INTAKE, { seconds: 110 * MIN })), null, 'over 100 minutes the title alone does not say');
  const soaps = { knownShows: new Map([['all my children', 'All My Children']]) };
  assert.deepStrictEqual(L.fullQuestions(video('All My Children (11-16-1994)  Partial', INTAKE, { seconds: 41 * MIN }), soaps), {}, 'a partial recording is not a whole episode');
  assert.ok(L.fullQuestions(video('All My Children (11-16-1994)', INTAKE, { seconds: 41 * MIN }), soaps).episode, 'a show her TV Shows shelf knows can be asked about');
});
