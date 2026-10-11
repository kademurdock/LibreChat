const mongoose = require('mongoose');

/**
 * KadeSoundBoothProject -- one saved piece of work in the Sound Booth
 * (Part 120, Sep 3 2026; her ask from Part 119.10: "a native playground on my
 * platform where I can use Scenema").
 *
 * The screen is on the phone, but the PROJECT is server-side on purpose: her
 * standing rule is that anything she makes should be reachable from whatever
 * surface she happens to be on, and the web page at /sound-booth reads the
 * same rows the app writes. A project is the SCRIPT plus the settings that
 * made it -- not the audio. The audio lands in My Creations like every other
 * generated thing (KadeAsset), and `assets[]` here holds the ids so a project
 * can be replayed, re-rendered with a different voice, or downloaded without
 * hunting through the gallery.
 *
 * Three engines, one row shape:
 *   - engine 'scenema' : her own RunPod GPU, QUEUED. `jobs[]` carries the
 *                        bridge job ids; state moves queued -> running -> done.
 *   - engine 'seed'    : Seed Audio 1.0 on fal, SYNCHRONOUS. One render, one
 *                        asset, no job id -- `state` goes straight to 'done'.
 *   - engine 'lyria'   : Lyria 3.5 on Google's Gemini API, SYNCHRONOUS. Music,
 *                        not speech. Same shape as 'seed': one render, one
 *                        asset, no job id. Its `options` carry no clips and no
 *                        voice settings, because it has none.
 *   - engine 'ace'     : ACE-Step XL (Oct 10 2026), QUEUED like 'yue2' on its own
 *                        endpoint; `options` are its Quality, Length, Singing, lyrics,
 *                        weirdness (Creative variation), guidance (Prompt guidance), seed.
 *
 * Collection name is `kadeplayground` deliberately: the plan that ordered this
 * work called the screen the Playground and specced the rows under that name.
 * The SCREEN is called Sound Booth (her pick, Part 120); the table keeps its
 * birth name rather than buying a migration for a cosmetic rename.
 */
const kadeSoundBoothProjectSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    title: { type: String, default: 'Untitled' },
    /** 'myvoice' (Sep 27 2026): Sing it in my voice, only ever on the rows of an account with a voice model. */
    /** 'ace' (Oct 10 2026): ACE-Step XL, a second song engine beside 'yue2', behind ACE_ENABLED. Without it here
     * hooks.project cannot save the row and every ACE render answers "Could not save the draft". */
    engine: { type: String, enum: ['scenema', 'seed', 'lyria', 'yue2', 'ace', 'stable', 'myvoice'], default: 'scenema', index: true },
    /** 'easy' or 'advanced' -- which side of the screen she was on. Kept so the
     * app can reopen a project in the mode it was written in. */
    mode: { type: String, enum: ['easy', 'advanced'], default: 'easy' },
    /** What she typed. Kept separate from `script` so "Turn my words into a
     * script" is never destructive -- her own words survive the formatting. */
    sourceText: { type: String, default: '' },
    /** What actually gets rendered: Scenema <speak> XML, or the Seed Audio
     * prose script. */
    script: { type: String, default: '' },
    /** The plain-English read-back the model wrote, so she can hear the plan
     * again without spending anything. */
    readback: { type: String, default: '' },
    /** Lyria only (Sep 25 2026): the words the latest take actually sang, as
     * Lyria handed them back, cleaned of its markers. These used to be written
     * into `readback`, which every screen reads as "what you will hear", so a
     * lyric sheet sat where the description of the music belongs and stayed
     * there through later instrumental takes. Empty for an instrumental take
     * or when "Keep the words it wrote" is off. */
    sungLyrics: { type: String, default: '' },
    options: { type: mongoose.Schema.Types.Mixed, default: {} },
    /** Bridge job ids, newest last. Scenema only. */
    jobs: { type: [String], default: [] },
    /** Part 122 — a script too long for one render is cut into PARTS, rendered
     * in order, and joined into one recording. Each part is its own bridge job
     * and its own charge, so this array is the receipt for a chain that dies
     * halfway: the finished parts keep their audio and a resume picks up from
     * the first one that is not done. Empty on a normal single-shot render. */
    parts: {
      type: [
        {
          index: { type: Number },
          script: { type: String },
          editStart: { type: Number },
          editEnd: { type: Number },
          targetSeconds: { type: Number },
          preserveBefore: { type: Boolean },
          preserveAfter: { type: Boolean },
          jobId: { type: String },
          url: { type: String },
          wavUrl: { type: String },
          audioEngine: { type: String },
          state: { type: String, enum: ['pending', 'queued', 'running', 'done', 'failed'], default: 'pending' },
          durationS: { type: Number },
          costUSD: { type: Number },
          error: { type: String },
        },
      ],
      default: [],
    },
    /** Set once the parts are joined and filed, so a re-poll cannot make a
     * second copy of the same recording. */
    stitchedAssetId: { type: String },
    /** ⭐ Part 122.1 — THE SEED IS THE VOICE. Scenema casts a NEW random actor
     * off the description on every render unless a seed is pinned, so without
     * this the "hear this voice first" button auditioned somebody the real
     * render would never use, and a re-render of a saved project came back a
     * different person. Set on the first preview or render of a project and
     * reused for every render after; `newVoice: true` rerolls it deliberately. */
    voiceSeed: { type: Number },
    renderLease: { type: String },
    renderLeaseUntil: { type: Date },
    /** KadeAsset ids for every finished render of this project. */
    assets: { type: [String], default: [] },
    state: {
      type: String,
      enum: ['draft', 'queued', 'running', 'done', 'failed', 'cancelled'],
      default: 'draft',
      index: true,
    },
    lastError: { type: String },
    costUSD: { type: Number, default: 0 },
    /** Sep 27 2026: what a YuE2 project's automatic versions in her voice cost, kept apart because the YuE2 job rewrites
     * costUSD with its own takes' total on every step. Shown added together. */
    voiceCostUSD: { type: Number, default: 0 },
    lastRenderAt: { type: Date },
  },
  { timestamps: true },
);
kadeSoundBoothProjectSchema.index({ user: 1, updatedAt: -1 });

const KadeSoundBoothProject =
  mongoose.models.KadeSoundBoothProject ||
  mongoose.model('KadeSoundBoothProject', kadeSoundBoothProjectSchema, 'kadeplayground');

module.exports = { KadeSoundBoothProject };

