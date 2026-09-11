const mongoose = require('mongoose');

/**
 * THE READING ROOM — the shelf, the library, and where everyone is in a book
 * (Part 181, Sep 11 2026).
 *
 * Her words: "it's a readingroom/library ... Amber submits [a book] through the
 * share on iPhone, and it's on her private shelf like she donated the book,
 * then she can share it to the public library, where it will say donated by
 * ..., and other people on the platform can check it out."
 *
 * Four collections:
 *   - KadeBook            one row per uploaded book: who donated it, the
 *                         jacket facts, the chapter list, what was skipped
 *                         and why, and whether it sits in the public library.
 *   - KadeBookText        the words, one document per book: every chunk of
 *                         every section, in reading order. Kept apart from
 *                         KadeBook so the shelf can list a hundred books
 *                         without hauling a hundred novels out of Mongo.
 *   - KadeReadingProgress one row per reader per book — the bookmark that
 *                         moves. Its existence is what "checked out" means:
 *                         a library book with a progress row is on that
 *                         reader's shelf.
 *   - KadeReadingBookmark the bookmarks a reader placed on purpose.
 *
 * Nothing here stores audio. Every chunk is spoken fresh by the voice proxy
 * (characters are inside the Inworld plan; ten hours of WAV a voice is not).
 */
const sectionSummary = {
  title: { type: String, default: '' },
  chunkCount: { type: Number, default: 0 },
  chars: { type: Number, default: 0 },
  kind: { type: String, default: 'section' },
};
const skippedSummary = {
  title: { type: String, default: '' },
  reason: { type: String, default: '' },
  chunkCount: { type: Number, default: 0 },
  chars: { type: Number, default: 0 },
};

/** Part 181 continued (her word, same day): "people [can] donate audio books
 * too, mp3 or whatever ... a movie category ... audio versions of descriptive
 * videos ... retro media, commercials, radio from the past ... a cassette
 * category." So an item is one of two KINDS:
 *   kind 'text'  — a book file, parsed into chunks, spoken by a voice (above)
 *   kind 'audio' — recordings donated as files, played straight from B2:
 *                  `tracks[]` in order (sides, parts, episodes), each a key
 *                  in the bucket; a signed URL is minted when the item opens.
 * `category` is the library shelf it sits on. */
const CATEGORIES = ['book', 'audiobook', 'movie', 'cassette', 'radio', 'commercials', 'music', 'tv', 'vhs', 'psa', 'other'];
const track = {
  title: { type: String, default: '' },
  key: { type: String, default: '' },
  bytes: { type: Number, default: 0 },
  seconds: { type: Number, default: 0 },
  mime: { type: String, default: 'audio/mpeg' },
  originalName: { type: String, default: '' },
  /** Part 181 continued — the AI video description ("a blind VDS type thing"):
   * scenes with a time in seconds and what is on screen, plus a summary. */
  description: {
    summary: { type: String, default: '' },
    scenes: { type: [{ t: { type: Number, default: 0 }, text: { type: String, default: '' } }], default: [] },
    model: { type: String, default: '' },
    costUSD: { type: Number, default: 0 },
    frames: { type: Number, default: 0 },
    state: { type: String, default: '' }, // '' | 'working' | 'done' | 'failed'
    error: { type: String, default: '' },
    at: { type: Date },
  },
  /** "What just happened?" — the last few ranged descriptions, newest last. */
  recaps: { type: [{ from: Number, to: Number, summary: String, scenes: [{ t: Number, text: String }], costUSD: Number, at: Date }], default: [] },
};

const kadeBookSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['text', 'audio', 'video'], default: 'text', index: true },
    /** Part 181 continued — THE ARCHIVE. Her media sorter files ~46,000 clips
     * under Video/<Category>/<Channel or Brand>/<Decade>/. A pushed clip keeps
     * that folder as `path` so the library can be browsed the way her drive
     * is, and the sorter's own catalogue row (year, decade, network, call
     * sign, brand, market) rides along in `meta`. `originalPath` is the
     * relative path on her drive — the duplicate guard for re-runs. */
    path: { type: String, default: '', index: true },
    originalPath: { type: String, default: '' },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    tags: { type: [String], default: [] },
    /** The librarian's note: web-dug, honest about certainty, with sources. */
    librarian: {
      note: { type: String, default: '' },
      confidence: { type: String, default: '' },
      identified: { type: String, default: '' },
      sources: { type: [{ title: String, url: String }], default: [] },
      model: { type: String, default: '' },
      costUSD: { type: Number, default: 0 },
      state: { type: String, default: '' }, // '' | working | done | failed
      error: { type: String, default: '' },
      at: { type: Date },
    },
    category: { type: String, enum: CATEGORIES, default: 'book', index: true },
    /** Audio items: what it is, in the donor's words ("The 1986 Disney
     * descriptive VHS", "Grandma's cassette, side A is Christmas 1994"). */
    description: { type: String, default: '', maxlength: 2000 },
    tracks: { type: [track], default: [] },
    /** Audio items start 'pending' until the first track lands. */
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    /** Shown on the library card ("Donated by Amber"). Snapshotted at upload
     * so the card never has to join on users. */
    ownerName: { type: String, default: '' },
    title: { type: String, default: 'Untitled', index: true },
    author: { type: String, default: '' },
    publisher: { type: String, default: '' },
    copyrightYear: { type: String, default: '' },
    synopsis: { type: String, default: '' },
    language: { type: String, default: 'en' },
    isbn: { type: String, default: '' },
    bookshareId: { type: String, default: '' },
    /** 'bookshare' when the file carried Bookshare's notice or ids; else 'upload'. */
    source: { type: String, default: 'upload' },
    /** daisy3 | daisy2 | epub | txt | docx | html */
    format: { type: String, default: '' },
    originalName: { type: String, default: '' },
    /** The file as uploaded, on B2, so a better parser later can re-read it. */
    fileUrl: { type: String, default: '' },
    fileBytes: { type: Number, default: 0 },
    /** The NLS-style opening ("Title. By Author. Published by ..."). */
    jacket: { type: String, default: '' },
    sections: { type: [sectionSummary], default: [] },
    skipped: { type: [skippedSummary], default: [] },
    stats: {
      chunks: { type: Number, default: 0 },
      chars: { type: Number, default: 0 },
      listen: { type: String, default: '' },
    },
    /** In the public library. Off = private shelf. */
    shared: { type: Boolean, default: false, index: true },
    sharedAt: { type: Date },
    /** Hidden from child accounts (never announced to them — rule 8). */
    grownUpsOnly: { type: Boolean, default: false },
    state: { type: String, enum: ['ready', 'failed', 'pending'], default: 'ready' },
    error: { type: String },
  },
  { timestamps: true },
);
kadeBookSchema.index({ owner: 1, updatedAt: -1 });
kadeBookSchema.index({ shared: 1, sharedAt: -1 });
kadeBookSchema.index({ owner: 1, originalPath: 1 });
kadeBookSchema.index({ shared: 1, path: 1, title: 1 });

/** Part 181 continued — COLLECTIONS ("playlists of vids or audio or whatever,
 * like collections you have organised your way from stuff in the cloud").
 * An ordered list of (item, track) pairs. Private until shared. */
const kadeCollectionSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    ownerName: { type: String, default: '' },
    title: { type: String, default: 'Untitled collection' },
    description: { type: String, default: '', maxlength: 1000 },
    shared: { type: Boolean, default: false, index: true },
    items: {
      type: [{ book: { type: mongoose.Schema.Types.ObjectId, ref: 'KadeBook' }, track: { type: Number, default: 0 }, title: { type: String, default: '' } }],
      default: [],
    },
  },
  { timestamps: true },
);
kadeCollectionSchema.index({ owner: 1, updatedAt: -1 });

const kadeBookTextSchema = new mongoose.Schema(
  {
    book: { type: mongoose.Schema.Types.ObjectId, ref: 'KadeBook', unique: true },
    sections: { type: [{ chunks: { type: [String], default: [] } }], default: [] },
    skipped: { type: [{ chunks: { type: [String], default: [] } }], default: [] },
  },
  { timestamps: true },
);

const kadeReadingProgressSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    book: { type: mongoose.Schema.Types.ObjectId, ref: 'KadeBook', index: true },
    s: { type: Number, default: 0 },
    c: { type: Number, default: 0 },
    /** Audio items: seconds into track `s` (`c` stays 0). */
    pos: { type: Number, default: 0 },
    voice: { type: String, default: '' },
    speed: { type: Number, default: 1 },
    finished: { type: Boolean, default: false },
  },
  { timestamps: true },
);
kadeReadingProgressSchema.index({ user: 1, book: 1 }, { unique: true });
kadeReadingProgressSchema.index({ user: 1, updatedAt: -1 });

const kadeReadingBookmarkSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    book: { type: mongoose.Schema.Types.ObjectId, ref: 'KadeBook', index: true },
    s: { type: Number, default: 0 },
    c: { type: Number, default: 0 },
    pos: { type: Number, default: 0 },
    note: { type: String, default: '', maxlength: 400 },
    /** The first words at that spot, so the bookmark list reads like a list. */
    snippet: { type: String, default: '' },
    sectionTitle: { type: String, default: '' },
  },
  { timestamps: true },
);
kadeReadingBookmarkSchema.index({ user: 1, book: 1, createdAt: -1 });

const KadeBook = mongoose.models.KadeBook || mongoose.model('KadeBook', kadeBookSchema, 'kadebooks');
/* Part 181: a text index briefly existed here and Mongo read the `language`
 * field ("en-US") as its language override, refusing every book. Search is
 * regex-based, so the index is gone; this drops the one already built. */
KadeBook.collection.dropIndex('title_text_author_text_description_text_tags_text').catch(() => {});
const KadeBookText = mongoose.models.KadeBookText || mongoose.model('KadeBookText', kadeBookTextSchema, 'kadebooktexts');
const KadeReadingProgress =
  mongoose.models.KadeReadingProgress || mongoose.model('KadeReadingProgress', kadeReadingProgressSchema, 'kadereadingprogress');
const KadeReadingBookmark =
  mongoose.models.KadeReadingBookmark || mongoose.model('KadeReadingBookmark', kadeReadingBookmarkSchema, 'kadereadingbookmarks');
const KadeCollection = mongoose.models.KadeCollection || mongoose.model('KadeCollection', kadeCollectionSchema, 'kadecollections');

module.exports = { KadeBook, KadeBookText, KadeReadingProgress, KadeReadingBookmark, KadeCollection, CATEGORIES };
