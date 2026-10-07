/* ----------------------------------------------------------------------------
 * WHAT A LIBRARY ITEM IS CALLED, AND WHAT A FEW SHELVES ARE CALLED (Part 296, Sep 27 2026)
 *
 * Her words, Sep 27: "It's confusing in the library that the mp3 movies say movie, like the
 * described tv and movies that are mp3, they should say described audio movie or
 * something. Video files would go under actual full movies and full tv."
 *
 * Every one of her described MP3s (1,635 films, 2,554 episodes) is stored as
 * `kind 'audio'` with `category 'movie'`, because the librarian gives the whole
 * described shelf that category, and every client turned `category` straight into
 * its word, so an episode of a cartoon said "Movie". The 548 VIDEOS with
 * `category 'movie'` said "Movie" too, and none of them is a movie: they are
 * trailers, studio logos and title cards.
 *
 * `typeLabel(item)` is the one honest word for an item, worked out from what the
 * file really is (audio or video), the shelf it is on, its category, its title and
 * its length. The server sends it on every item (summary().typeLabel) and the web
 * page and the iPhone read it instead of the category. `shelfName(path)` is the
 * display name of the few shelves whose real names mislead.
 *
 * EVERYTHING HERE IS DISPLAY ONLY. No item is moved, renamed or re-categorised:
 * `category` and `path` go out exactly as stored, and a shelf is still opened by
 * its real path.
 *
 * Part 296, later the same day, her words: "Yes I want a full movies shelf and tv
 * eps". Two real shelves under Videos, filed by the media librarian: Full Movies
 * reads "Full movies" and Full TV reads "Full TV episodes", both at the top of
 * Videos (shelfRank), and every video on them is a "Full movie" or a "Full TV
 * episode" whatever its length says.
 * -------------------------------------------------------------------------- */

/** Her described shelf (the display path; the librarian files described audio here). */
const DESCRIBED_SHELF = /^Audio\/Described Movies & TV(?:\/|$)/i;
/** Her own folder and file names mark the few files that are not described (Family Guy Season 9, ...). */
const NOT_DESCRIBED = /\b(?:not|non|un)[\s-]?described\b/i;
/** Words that say an audio file off the described shelf is described audio. */
const SAYS_DESCRIBED = /\b(?:audio[\s-]?described|described|descriptive video|audio description|DVS)\b/i;
/** The describer's own note on every copy it makes (kadeDescribedVideo.js), for a copy with no `describedFrom`. */
const DESCRIBER_NOTE = /\bAudio-described copy made by Kade-AI\b/i;
/**
 * A VIDEO whose own title or shelf says it carries description (a DVS copy of a film). Narrower than
 * SAYS_DESCRIBED: a station's "Descriptive Video Service" notice, a bare DVS logo or a YouTube blurb
 * that uses the word is not a described film.
 */
const VIDEO_DESCRIBED = /\baudio[\s-]?described\b|[([]\s*described\s*[)\]]|[-–:]\s*described\s*$|\bdescribed (?:version|video|audio|copy)\b|\bwith (?:audio )?descriptions?\b|\/Described Movies & TV(?:\/|$)/i;
const TRAILERS = /\/Trailers & Previews(?:\/|$)/i;
/** Her two whole-programme shelves under Videos (Part 296); the shelf says it, whatever the length. */
const FULL_MOVIES_SHELF = /^Videos?\/Full Movies(?:\/|$)/i;
const FULL_TV_SHELF = /^Videos?\/Full TV(?:\/|$)/i;
const FEATURE_FILMS = /\/Feature Films(?:\/|$)/i;
const COMMERCIAL_BREAK = /\/Commercial Breaks(?:\/|$)|\b(?:commercial|ad)\s+breaks?\b|\bcommercial blocks?\b/i;
/**
 * A commercial shelf by its own name, whatever the category says: her Ozarks "Local Commercials" (the
 * crown jewels) and "Commercial Breaks" carry the tv category because they sit on the local shelf.
 */
const COMMERCIAL_SHELF = /\/(?:[^/]* )?Commercials(?:\/|$)|\/Commercial Breaks(?:\/|$)|\/Political Ads(?:\/|$)/i;
const INFOMERCIAL = /\/Infomercials?(?:\/|$)|\binfomercials?\b/i;
/** A video this long in the movie category, or on a Feature Films shelf, is a whole film. */
const FULL_MOVIE_SECONDS = 40 * 60;

/** What a described (or not described) audio file is, by its category, off the Movies and TV shelves. */
const DESCRIBED_NOUN = { movie: 'movie', tv: 'episode', commercials: 'commercial', music: 'music video', vhs: 'clip', psa: 'public service announcement' };
const AUDIO_WORDS = { audiobook: 'Audiobook', cassette: 'Cassette', radio: 'Radio', commercials: 'Radio commercial', music: 'Music', psa: 'Public service announcement', vhs: 'VHS audio' };
const VIDEO_WORDS = { tv: 'TV recording', psa: 'Public service announcement', vhs: 'VHS recording', music: 'Music video', radio: 'Radio recording' };

/**
 * item: { kind, category, path, title, seconds, description, meta }
 *   kind      'text' | 'audio' | 'video' (what the file really is)
 *   category  libraryCategory(book)
 *   path      libraryPath(book), the display path ("Audio/Described Movies & TV/TV/...")
 *   seconds   the item's whole length
 *   meta      the stored meta; `describedFrom` marks a copy the describer made
 */
function typeLabel(item) {
  const it = item || {};
  const kind = it.kind || 'text';
  if (kind === 'text') {
    const sourceKind = String(it.meta && it.meta.sourceKind || '');
    const path = String(it.path || '');
    if (/^newspaper(?:_|$)/i.test(sourceKind) || /(?:^|\/)Newspapers?(?:\/|$)/i.test(path)) return 'Newspaper';
    if (/^yearbook(?:_|$)/i.test(sourceKind) || /(?:^|\/)Yearbooks?(?:\/|$)/i.test(path)) return 'Yearbook';
    return 'Book';
  }
  const category = String(it.category || 'other');
  const path = String(it.path || '');
  const title = String(it.title || '');
  const seconds = Number(it.seconds) || 0;

  if (kind === 'audio') {
    const onShelf = DESCRIBED_SHELF.test(path);
    const describer = !!(it.meta && it.meta.describedFrom) || DESCRIBER_NOTE.test(String(it.description || ''));
    if (onShelf || describer) {
      const sub = onShelf ? String(path.split('/')[2] || '').toLowerCase() : '';
      const noun = sub === 'movies' ? 'movie' : sub === 'tv' ? 'episode' : DESCRIBED_NOUN[category] || '';
      if (NOT_DESCRIBED.test(path) || NOT_DESCRIBED.test(title)) return noun ? `Audio ${noun}, not described` : 'Audio, not described';
      return noun ? `Described audio ${noun}` : 'Described audio';
    }
    if (category === 'movie' || category === 'tv') {
      const noun = category === 'movie' ? 'movie' : 'episode';
      const text = `${title} ${it.description || ''} ${path}`;
      if (!NOT_DESCRIBED.test(text) && SAYS_DESCRIBED.test(text)) return `Described audio ${noun}`;
      return category === 'movie' ? 'Movie audio' : 'TV audio';
    }
    return AUDIO_WORDS[category] || 'Recording';
  }

  // video: a real picture. A film, a show or a tape with description mixed in says so ("Described full
  // movie"), which is not the same thing as "Described audio movie" (sound only).
  const word = videoWord(category, path, title, seconds);
  if ((category === 'movie' || category === 'tv' || category === 'vhs')
    && !NOT_DESCRIBED.test(`${title} ${path}`) && (VIDEO_DESCRIBED.test(title) || VIDEO_DESCRIBED.test(path))) {
    return 'Described ' + (/^[A-Z][a-z]/.test(word) ? word.charAt(0).toLowerCase() + word.slice(1) : word);
  }
  return word;
}

function videoWord(category, path, title, seconds) {
  if (FULL_TV_SHELF.test(path)) return 'Full TV episode';
  if (FULL_MOVIES_SHELF.test(path)) return 'Full movie';
  if (category === 'movie') {
    if (TRAILERS.test(path)) return 'Movie trailer';
    return seconds >= FULL_MOVIE_SECONDS ? 'Full movie' : 'Movie clip';
  }
  if (FEATURE_FILMS.test(path) && seconds >= FULL_MOVIE_SECONDS) return 'Full movie';
  if (category === 'commercials' || COMMERCIAL_SHELF.test(path)) {
    if (COMMERCIAL_BREAK.test(path) || COMMERCIAL_BREAK.test(title)) return 'Commercial break';
    if (INFOMERCIAL.test(path) || INFOMERCIAL.test(title)) return 'Infomercial';
    return 'Commercial';
  }
  return VIDEO_WORDS[category] || 'Video';
}

/**
 * Shelves whose real names mislead, by lower-cased real path. The real name stays in
 * `path`; only what is read changes. "Movies & Studios" holds trailers, logos and title
 * cards, and no full movies.
 */
const SHELF_NAMES = new Map([
  ['audio/described movies & tv', 'Described audio movies and TV'],
  ['audio/described movies & tv/movies', 'Described audio movies'],
  ['audio/described movies & tv/tv', 'Described audio TV'],
  ['audio/movies', 'Movie audio'],
  ['audio/television', 'TV audio'],
  ['videos/movies & studios', 'Movie trailers and studio clips'],
  ['videos/full movies', 'Full movies'],
  ['videos/full tv', 'Full TV episodes'],
]);

/** The display name of a shelf at this real path, or null when it reads under its own name. */
function shelfName(path) {
  return SHELF_NAMES.get(String(path == null ? '' : path).toLowerCase()) || null;
}

/**
 * Where a shelf sorts before the others at its level: Full movies, then Full TV episodes, at the top of
 * Videos (her whole programmes first); every other shelf 0, in name order. A row that skips down a chain
 * ("Full TV episodes, Rugrats") keeps its shelf's place.
 */
function shelfRank(path) {
  const p = String(path == null ? '' : path);
  if (FULL_MOVIES_SHELF.test(p)) return -2;
  if (FULL_TV_SHELF.test(p)) return -1;
  return 0;
}

module.exports = { typeLabel, shelfName, shelfRank, SHELF_NAMES, FULL_MOVIE_SECONDS };
