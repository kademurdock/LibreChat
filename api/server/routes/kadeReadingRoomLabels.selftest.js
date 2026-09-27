/* What a Library item is called (Part 296, Sep 27 2026): her described MP3 movies and episodes said
 * "Movie", and so did trailers and studio logos. One word per item from the real file kind, the shelf,
 * the category, the title and the length; display names for the shelves whose real names mislead.
 * Display only: nothing is moved, renamed or re-categorised.
 * Run: node --test api/server/routes/kadeReadingRoomLabels.selftest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const L = require('./kadeReadingRoomLabels');

const DESCRIBED = 'Audio/Described Movies & TV';
const audio = (path, extra = {}) => L.typeLabel({ kind: 'audio', category: 'movie', path, title: 'x', seconds: 1300, ...extra });
const video = (category, path, extra = {}) => L.typeLabel({ kind: 'video', category, path, title: 'x', seconds: 30, ...extra });

test('a described MP3 says what it is: a described audio movie or a described audio episode, never "Movie"', () => {
  assert.equal(audio(`${DESCRIBED}/Movies/L`, { title: 'The Little Mermaid', seconds: 4980 }), 'Described audio movie');
  assert.equal(audio(`${DESCRIBED}/Movies/0-9`, { title: '101 Dalmatians' }), 'Described audio movie');
  assert.equal(audio(`${DESCRIBED}/Movies/Numbers`), 'Described audio movie');
  assert.equal(audio(`${DESCRIBED}/TV/Family guy/Family Guy - Season 12 (2013)`, { title: '[S12.E01] Finders Keepers' }), 'Described audio episode');
  assert.equal(audio(`${DESCRIBED}/TV/Assorted (One-Offs)`), 'Described audio episode');
  assert.equal(audio(`${DESCRIBED}/TV`), 'Described audio episode');
  assert.equal(audio(DESCRIBED), 'Described audio movie', 'on the shelf itself, by its category');
  // the shelf's spelling of a letter case never matters
  assert.equal(audio('audio/described movies & tv/tv/Bob\'s burgers'), 'Described audio episode');
});

test('the files her own folders and names mark "not described" say so', () => {
  assert.equal(audio(`${DESCRIBED}/TV/Family guy/Family Guy Season 9 not described`, { title: 'Peter\'s Daughter' }), 'Audio episode, not described');
  assert.equal(audio(`${DESCRIBED}/TV/Bob's burgers/Bob's Burgers Season 1 not described`), 'Audio episode, not described');
  assert.equal(audio(`${DESCRIBED}/TV/Garfield`, { title: 'Garfield and Friends (Not Described)' }), 'Audio episode, not described');
  assert.equal(audio(`${DESCRIBED}/TV/x`, { title: 'Pilot - non-described' }), 'Audio episode, not described');
  assert.equal(audio(`${DESCRIBED}/Movies/U`, { title: 'Up (undescribed)' }), 'Audio movie, not described');
  // "described" inside another word, or a description that says "not", is not the marker
  assert.equal(audio(`${DESCRIBED}/TV/x`, { title: 'Nothing Described Here', description: 'not great' }), 'Described audio episode');
});

test("the describer's own copies read as described audio of what they are", () => {
  const kadeAi = `${DESCRIBED}/Described by Kade-AI`;
  assert.equal(audio(kadeAi, { category: 'movie', seconds: 5400 }), 'Described audio movie');
  assert.equal(audio(kadeAi, { category: 'tv' }), 'Described audio episode');
  assert.equal(audio(kadeAi, { category: 'commercials' }), 'Described audio commercial');
  assert.equal(audio(kadeAi, { category: 'music' }), 'Described audio music video');
  assert.equal(audio(kadeAi, { category: 'vhs' }), 'Described audio clip');
  assert.equal(audio(kadeAi, { category: 'other' }), 'Described audio');
  // a described copy saved to another shelf still says it is described, by the mark the describer leaves
  assert.equal(audio('Audio/My Stuff', { category: 'tv', meta: { describedFrom: { book: 'b', track: 0 } } }), 'Described audio episode');
});

test('movie or TV audio off the described shelf: described only when its words say so', () => {
  assert.equal(audio('Audio/Movies', { title: 'The Lion King (described audio)' }), 'Described audio movie');
  assert.equal(audio('Audio/Movies', { title: 'Aladdin', description: 'Audio described version from the DVD.' }), 'Described audio movie');
  assert.equal(audio('Audio/Movies', { title: 'Aladdin DVS' }), 'Described audio movie');
  assert.equal(audio('Audio/Movies', { title: 'Aladdin' }), 'Movie audio');
  assert.equal(audio('Audio/Movies', { title: 'Aladdin (not described)' }), 'Movie audio');
  assert.equal(audio('Audio/Television', { category: 'tv', title: 'Pilot' }), 'TV audio');
  assert.equal(audio('Audio/Television', { category: 'tv', title: 'Pilot (described)' }), 'Described audio episode');
});

test('video with the movie category: trailers, clips, and a full movie only when it is film length', () => {
  assert.equal(video('movie', 'Videos/Movies & Studios/Trailers & Previews/1990s', { title: 'Toy Story (1995) Trailer' }), 'Movie trailer');
  assert.equal(video('movie', 'Videos/Movies & Studios/1980s', { title: 'Tri-Star Pictures logo' }), 'Movie clip');
  assert.equal(video('movie', 'Videos/Movies & Studios/1980s', { seconds: 0 }), 'Movie clip', 'no length is never a full movie');
  assert.equal(video('movie', 'Videos/Movies', { seconds: 40 * 60 }), 'Full movie');
  assert.equal(video('movie', 'Videos/Movies & Studios/Trailers & Previews', { seconds: 3 * 3600 }), 'Movie trailer', 'the trailer shelf wins');
  // a feature film on the home video shelf is a full movie; a coming-soon promo beside it is not
  assert.equal(video('vhs', 'Videos/Home Video (VHS)/Feature Films', { title: 'Millennium (1989, VHS) Full Movie', seconds: 6650 }), 'Full movie');
  assert.equal(video('vhs', 'Videos/Home Video (VHS)/Feature Films', { title: 'Cop Land (1997) Coming Soon to Video (VHS)', seconds: 30 }), 'VHS recording');
  assert.equal(video('vhs', 'Videos/Home Video (VHS)/Feature Films', { title: 'Lost in Dinosaur World (1993, VHS)', seconds: 1646 }), 'VHS recording');
});

test('every other kind reads as one honest word instead of "tv", "Vhs", "psa" or a plural', () => {
  assert.equal(video('tv', 'Videos/Channels/Nickelodeon/1990s'), 'TV recording');
  assert.equal(video('tv', 'Videos/TV Shows/ALF/Promos/1980s'), 'TV recording');
  assert.equal(video('commercials', 'Videos/Commercials/Toys & Video Games/1990s', { title: 'Easy-Bake Oven ad, 1994' }), 'Commercial');
  assert.equal(video('commercials', 'Videos/Commercials/Commercial Breaks/Nick Jr/2000s'), 'Commercial break');
  assert.equal(video('commercials', 'Videos/Commercials/Other Commercials', { title: 'MeTV Commercial Breaks (1/13/2017)' }), 'Commercial break');
  assert.equal(video('commercials', 'Videos/Commercials/Other Commercials', { title: 'Break the Bank bonus round clip, 1986' }), 'Commercial');
  assert.equal(video('commercials', 'Videos/Commercials/Health & Beauty', { title: 'Shark Steam Mop | Infomercial | 2011' }), 'Infomercial');
  assert.equal(video('psa', 'Videos/PSAs/1980s'), 'Public service announcement');
  assert.equal(video('vhs', 'Videos/Home Video (VHS)/1990s'), 'VHS recording');
  assert.equal(video('music', 'Videos/Music'), 'Music video');
  assert.equal(video('radio', 'Videos/Radio'), 'Radio recording');
  assert.equal(video('other', 'Videos/Found Media'), 'Video');
  assert.equal(video(undefined, 'Videos'), 'Video');
  const a = (category) => L.typeLabel({ kind: 'audio', category, path: 'Audio/x', title: 'x' });
  assert.equal(a('audiobook'), 'Audiobook');
  assert.equal(a('cassette'), 'Cassette');
  assert.equal(a('radio'), 'Radio');
  assert.equal(a('commercials'), 'Radio commercial');
  assert.equal(a('music'), 'Music');
  assert.equal(a('other'), 'Recording');
  assert.equal(L.typeLabel({ kind: 'text', category: 'book', path: 'Books/Fiction' }), 'Book');
  assert.equal(L.typeLabel({}), 'Book', 'an item with no kind is a book, as everywhere else');
  assert.equal(L.typeLabel(null), 'Book');
});

test('the shelves whose real names mislead read under display names; every other shelf keeps its own', () => {
  assert.equal(L.shelfName('Audio/Described Movies & TV'), 'Described audio movies and TV');
  assert.equal(L.shelfName('Audio/Described Movies & TV/Movies'), 'Described audio movies');
  assert.equal(L.shelfName('audio/described movies & tv/TV'), 'Described audio TV');
  assert.equal(L.shelfName('Videos/Movies & Studios'), 'Movie trailers and studio clips');
  assert.equal(L.shelfName('Audio/Movies'), 'Movie audio');
  assert.equal(L.shelfName('Audio/Described Movies & TV/Described by Kade-AI'), null);
  assert.equal(L.shelfName('Audio/Described Movies & TV/TV/Family guy'), null);
  assert.equal(L.shelfName('Videos/TV Shows'), null);
  assert.equal(L.shelfName('Videos/Movies & Studios/Trailers & Previews'), null);
  assert.equal(L.shelfName(''), null);
  assert.equal(L.shelfName(undefined), null);
});

test('the server sends the word on every item, and the category stays as stored', () => {
  const T = require('./kadeReadingRoomTree');
  const source = fs.readFileSync(require.resolve('./kadeReadingRoom'), 'utf8');
  const start = source.indexOf('function summary(book, progress)');
  const end = source.indexOf('/* ── the shelf ──', start);
  const c = { shelfTree: T, libraryPath: (b) => b.path || '', libraryCategory: (b) => b.category || 'other', process: { env: {} } };
  vm.runInNewContext(source.slice(start, end), c);
  const ep = c.summary({ _id: 'e', kind: 'audio', category: 'movie', path: `${DESCRIBED}/TV/Family guy`, title: 'Peter\'s Daughter', tracks: [{ seconds: 1320 }] }, null);
  assert.equal(ep.typeLabel, 'Described audio episode');
  assert.equal(ep.category, 'movie', 'pictures and the Edit sheet still key on the real category');
  assert.equal(ep.path, `${DESCRIBED}/TV/Family guy`);
  assert.equal(ep.seconds, 1320);
  const film = c.summary({ _id: 'f', kind: 'video', category: 'vhs', path: 'Videos/Home Video (VHS)/Feature Films', title: 'Captain Barbell (VHS, 2003)', tracks: [{ seconds: 3000 }, { seconds: 4453 }] }, null);
  assert.equal(film.typeLabel, 'Full movie', 'the whole length counts, every part together');
  const trailer = c.summary({ _id: 't', kind: 'video', category: 'movie', path: 'Videos/Movies & Studios/Trailers & Previews/1990s', title: 'Trailer', tracks: [{ seconds: 120 }] }, null);
  assert.equal(trailer.typeLabel, 'Movie trailer');
  assert.equal(c.summary({ _id: 'b', kind: 'text', title: 'A book', sections: [] }, null).typeLabel, 'Book');
});

test('the web page reads the word, falls back to the category for an older answer, and names shelves as sent', () => {
  const page = fs.readFileSync(require.resolve('./kadeReadingRoomPage'), 'utf8');
  const start = page.indexOf('  function catName(c)');
  const end = page.indexOf('  async function api(path, opts)', start);
  assert.ok(start > 0 && end > start);
  const c = {};
  vm.runInNewContext(page.slice(start, end) + '\nthis.typeWord = typeWord; this.catName = catName;', c);
  assert.equal(c.typeWord({ kind: 'audio', category: 'movie', typeLabel: 'Described audio episode' }), 'Described audio episode');
  assert.equal(c.typeWord({ kind: 'audio', category: 'movie' }), 'Movie');
  assert.equal(c.typeWord({ kind: 'text', category: 'book' }), 'Book');
  assert.equal(c.catName('tv'), 'TV', 'the loose-donations filter no longer prints raw "tv"');
  assert.equal(c.catName('vhs'), 'VHS');
  assert.equal(c.catName('psa'), 'Public service announcement');
  // every row, the collection rows and the player header take the word from typeWord
  assert.match(page, /var kind = typeWord\(b\);/);
  assert.match(page, /typeWord\(it\.book\) \+ \(it\.seconds/);
  assert.match(page, /bits\.push\(typeWord\(book\)\)/);
  assert.equal(page.split('catName(b.category)').length, 2, 'only typeWord falls back to the category');
  assert.doesNotMatch(page, /catName\(book\.category\)|catName\(it\.book/);
  // the breadcrumbs read the server's shelf names and still open the real paths
  assert.match(page, /named \? named\[i\]\.name : seg/);
  assert.match(page, /<option value="movie">Movie or described audio<\/option>/);
});

/* ── review fixes ── */
test('a VIDEO with description mixed in still says described, and never "audio"', () => {
  assert.equal(video('movie', 'Videos/Movies', { title: 'The Lion King (Described)', seconds: 5300 }), 'Described full movie');
  assert.equal(video('movie', 'Videos/Movies', { title: 'The Lion King - Audio Described', seconds: 5300 }), 'Described full movie');
  assert.equal(video('movie', 'Videos/Movies', { title: 'The Lion King - described', seconds: 5300 }), 'Described full movie');
  assert.equal(video('vhs', 'Videos/Home Video (VHS)/Feature Films', { title: 'Millennium (1989, VHS) [described]', seconds: 6650 }), 'Described full movie');
  assert.equal(video('movie', 'Videos/Described Movies & TV/Movies/L', { title: 'The Lion King', seconds: 5300 }), 'Described full movie', 'a video filed on a described shelf');
  assert.equal(video('tv', 'Videos/TV Shows/Arthur', { title: 'Arthur - Season 1 Episode 2 (described version)', seconds: 1500 }), 'Described TV recording');
  assert.equal(video('movie', 'Videos/Movies & Studios/1980s', { title: 'Intro (described)', seconds: 30 }), 'Described movie clip');
  // not described, and the words that only look like it
  assert.equal(video('movie', 'Videos/Movies', { title: 'The Lion King (not described)', seconds: 5300 }), 'Full movie');
  assert.equal(video('other', 'Videos/Needs Filing/Archive Intake', { title: 'KETC Descriptive Video Service notice' }), 'Video');
  assert.equal(video('tv', 'Videos/Channels/PBS/1990s', { title: 'PBS Descriptive Video Service (DVS) ident' }), 'TV recording');
  assert.equal(video('tv', 'Videos/Channels/ABC/1990s', { title: 'ABC promo', description: 'The show was described as a hit.' }), 'TV recording', 'a blurb is never read for a video');
  assert.equal(video('commercials', 'Videos/Commercials/Toys & Video Games/1990s', { title: 'Toy ad (described)' }), 'Commercial', 'only films, shows and tapes');
});

test('a commercial shelf is a commercial whatever its category: her Ozarks Local Commercials and breaks', () => {
  assert.equal(video('tv', 'Videos/Ozarks (Springfield Area)/Local Commercials/1990s', { title: 'Meeks Lumber commercial, 1993' }), 'Commercial');
  assert.equal(video('tv', 'Videos/Ozarks (Springfield Area)/Commercial Breaks/1980s', { title: 'KYTV break, 1987' }), 'Commercial break');
  assert.equal(video('other', 'Videos/Needs Filing/Commercials', { title: 'x' }), 'Commercial');
  assert.equal(video('commercials', 'Videos/Missouri/Political Ads/1990s', { title: 'x' }), 'Commercial');
  assert.equal(video('tv', 'Videos/Ozarks (Springfield Area)/Local News/1990s', { title: 'KOLR 10 news open' }), 'TV recording');
  assert.equal(video('tv', 'Videos/Ozarks (Springfield Area)/Station IDs & Sign-offs', { title: 'KSPR sign-off' }), 'TV recording');
});

test("a describer copy saved off the described shelf with no source still says described, by the describer's note", () => {
  const note = 'A commercial for soap.\n\nAudio-described copy made by Kade-AI.';
  assert.equal(audio('Audio/My Stuff', { category: 'commercials', description: note }), 'Described audio commercial');
  assert.equal(audio('Audio/My Stuff', { category: 'tv', description: note }), 'Described audio episode');
  assert.equal(audio('Audio/My Stuff', { category: 'other', description: note }), 'Described audio');
  assert.equal(audio('Audio/Radio Commercials', { category: 'commercials', description: 'Folgers radio spot' }), 'Radio commercial');
});

test('the web row never says "described" twice, and a shelf is announced by its display names', () => {
  const page = fs.readFileSync(require.resolve('./kadeReadingRoomPage'), 'utf8');
  assert.match(page, /if \(b\.described && !\/described\/i\.test\(kind\)\) donor \+= ' · described';/);
  assert.match(page, /say\(\(named && named\.length \? named\.map\(function\(c\)\{ return c\.name; \}\)\.join\(', '\) : \(archivePath \|\| 'The archive'\)\)/);
});
