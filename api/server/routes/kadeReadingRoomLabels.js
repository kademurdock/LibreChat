/* ----------------------------------------------------------------------------
 * WHAT A LIBRARY ITEM IS CALLED, AND WHAT A FEW SHELVES ARE CALLED (Part 296, Sep 27 2026)
 *
 * Kade, Sep 27: "It's confusing in the library that the mp3 movies say movie, like the
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
 * -------------------------------------------------------------------------- */

/** Her described shelf (the display path; the librarian files described audio here). */
const DESCRIBED_SHELF = /^Audio\/Described Movies & TV(?:\/|$)/i;
/** Her own folder and file names mark the few files that are not described (Family Guy Season 9, ...). */
const NOT_DESCRIBED = /\b(?:not|non|un)[\s-]?described\b/i;
/** Words that say an audio file off the described shelf is described audio. */
const SAYS_DESCRIBED = /\b(?:audio[\s-]?described|described|descriptive video|audio description|DVS)\b/i;
const TRAILERS = /\/Trailers & Previews(?:\/|$)/i;
const FEATURE_FILMS = /\/Feature Films(?:\/|$)/i;
const COMMERCIAL_BREAK = /\/Commercial Breaks(?:\/|$)|\b(?:commercial|ad)\s+breaks?\b|\bcommercial blocks?\b/i;
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
  if (kind === 'text') return 'Book';
  const category = String(it.category || 'other');
  const path = String(it.path || '');
  const title = String(it.title || '');
  const seconds = Number(it.seconds) || 0;

  if (kind === 'audio') {
    const onShelf = DESCRIBED_SHELF.test(path);
    const describer = !!(it.meta && it.meta.describedFrom);
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

  // video
  if (category === 'movie') {
    if (TRAILERS.test(path)) return 'Movie trailer';
    return seconds >= FULL_MOVIE_SECONDS ? 'Full movie' : 'Movie clip';
  }
  if (FEATURE_FILMS.test(path) && seconds >= FULL_MOVIE_SECONDS) return 'Full movie';
  if (category === 'commercials') {
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
]);

/** The display name of a shelf at this real path, or null when it reads under its own name. */
function shelfName(path) {
  return SHELF_NAMES.get(String(path == null ? '' : path).toLowerCase()) || null;
}

module.exports = { typeLabel, shelfName, SHELF_NAMES, FULL_MOVIE_SECONDS };
