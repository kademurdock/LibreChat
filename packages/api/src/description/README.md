# Described video

`/described-video` turns an uploaded file, a YouTube link or a Library video into a described copy: the original picture and soundtrack with timed spoken descriptions, as MP4 and M4A, plus a readable described transcript, WebVTT description and caption tracks and a JSON timing report. The legacy `/describe` summary feature is separate. Web and backend only.

## How a job runs

1. **Check** (free, its own worker lane so a long render never blocks it): download or import, probe, show the length and estimate.
2. **Plan** (once per job, kept in storage): one ffmpeg pass measures the soundtrack's loudness (EBU R128) and writes a small mono copy; Deepgram Nova-3 transcribes the whole film once with speaker diarization; sections of about 90 seconds break in quiet moments and snap to the picture's frame grid.
3. **Each section**: the vision model watches a 960 px copy with sound and returns a strict JSON script (people with consistent labels and names once spoken or shown, or from the first appearance for a well-known fictional character marked nameFrom known, speaker matches, timed cues with short versions and pause points, protected sounds). The next section is watched while this one is voiced. Descriptions are voiced two at a time through the platform TTS proxy at the engine's own speed (up to 1.5×), trimmed of engine silence, and placed most important first:
   - into a dialogue gap at up to the listener's fastest speed (full text, then the short version);
   - in pause mode, starting at the pause point and freezing the picture only for what does not fit;
   - minor details (importance 1) are left out rather than pausing.
4. **Mix** in PCM: the soundtrack is brought toward -20 LUFS (at most 6 dB into the limiter), narration sits 0/2/5 dB above it (softer/balanced/louder), the soundtrack eases down 6/8/11 dB around each description and fades around pauses, then a -1 dBFS limiter. Standard mode with H.264 keeps the original picture untouched; otherwise sections are re-encoded frame-exactly so long films cannot drift.
5. **Keep**: each finished section (FLAC, picture part, JSON record) is uploaded before the next begins. A restart or redeploy puts the job back in the queue and it continues from the last finished section (three automatic tries; then a Continue button). A failed section is reported and skipped; three in a row, or an account error (HTTP 401/402/403), stops the job.
6. **Finish**: MP4, M4A, `transcript.txt`, `descriptions.vtt`, `captions.vtt`, `description.json`; phone and browser notice through the bridge (`requested: true`, like the Sound Booth).

Re-voicing a finished copy reuses the saved script and dialogue: only speech and mixing are paid. Voice samples (`POST /sample`) are cached per voice and speed and limited to 40 an hour.

## Website corrections and inspection

- `GET /jobs/:id/script` returns the latest finished script, its version, and stable section/cue IDs for that version. `POST /jobs/:id/revoice` accepts `expectedVersion` and a bounded `edits` array (full text, short text, or omission). Stale versions and unknown/duplicate IDs are rejected. Original cue timing is preserved. When voice, speed, mode and volume stay the same, unaffected sections reuse their rendered media. Browser drafts are local to the job and script version.
- Finished outputs are published under `copies/<version>/` and advertised only when every output has been saved. Previous finished versions remain accessible during processing, after cancellation and after failure through `files?version=N` and `text/<kind>?version=N`. Legacy copies in the job root still work. Cancelling a new attempt does not shorten an older copy's retention.
- `POST /jobs/:id/reanalyze` writes fresh descriptions with new notes/detail/inspection settings while retaining earlier outputs. It reuses dialogue timing and soundtrack measurements. Script revisions remain tied to the latest analysis; earlier outputs can be played, but their old editable scripts are not yet separately restorable.
- Optional `closeLook` creates a 1440-pixel maximum analysis copy at quarter speed, sampling four source frames per second. Dialogue and model times use the slowed timeline; cues and protected sounds are converted back to source time before placement. Narration density/windows use original runtime. The final video's normal speed is unaffected. This improves temporal coverage but does not guarantee tiny or blurred text is readable.
- Optional `firstLook` surveys every section before narration, checkpointing each completed section in `first-look-<analysis version>.json`. The resulting people/appearance reference is separate from current narrative continuity. The prompt prohibits revealing names before they are spoken/shown, except well-known fictional characters (cartoon, puppet, mascot, game, comic) recognized on sight, which the ledger reveals from the section start; KADE_DESCRIPTION_KNOWN_CHARACTERS=off turns that exception off. This is a model instruction, not a guarantee against spoilers or misidentification. Re-voicing skips this pass.
- `GET /library-folders` suggests the owner's existing folders. Saving accepts a validated logical Library `path`, `share`, and finished `version`. The original default shelf remains the default. Concurrent saves are gated for ten minutes and deletions wait for a save to finish. Each version may be saved once.
- Extra inspection is included in estimates. New runs estimated above the configured per-run cap are rejected before provider calls. Reservation and settlement updates are serialized while paid provider requests may run concurrently.
- Opening a job restores its settings. Playback link refresh preserves position, stale file responses cannot replace another video's player, and an unsupported video cannot trigger an endless automatic refresh loop.

## Operation

- JWT auth and owner checks on every route under `/api/kade/described-video`. ADMIN only unless `KADE_DESCRIPTION_PUBLIC=1`.
- Up to 10 unfinished jobs per account; one check and one render run at a time across replicas (Mongo locks `video-check` and `video`).
- Money: starting sets aside about 1.25× the estimate from that day's allowance; a job may grow its reservation up to the per-job cap if it needs more, and unused money returns when it ends. Defaults: `KADE_DESCRIPTION_JOB_USD=5`, `KADE_DESCRIPTION_DAILY_USD=5`. Prices used: Deepgram $0.0052/min, speech $15 per million UTF-8 bytes (Fish's price; Inworld is lower), vision from OpenRouter's reported cost.
- `KADE_DESCRIPTION_MODEL` (default `google/gemini-3.8-flash`), `KADE_DESCRIPTION_MAX_MINUTES` (90), `KADE_DESCRIPTION_VOICES` (parallel voice requests, default 2), `KADE_DESCRIBED_VIDEO=0` stops new work.
- YouTube: the Clubhouse jukebox's ladder (four player clients, two passes), the PO-token sidecar via `KADE_POT_URL`, optional `KADE_YT_COOKIES`; prefers H.264/AAC at 720p.
- Storage: everything for a job lives under `described-video/<owner>/<job>/` (source, plan, first-look checkpoints, sections, versioned outputs) and is erased on delete or expiry (ready and stopped jobs after 3 days, or the existing finished-copy expiry if later; finished jobs after 7). A Library source is read in place and never deleted. "Save to my Library" copies the selected version's M4A to `media-library/<book>/` under the chosen logical folder.
- Gemini quirk: an integer `enum` in the response schema empties every cue object, so `importance` is a plain integer. An all-empty reply is retried once in plain JSON mode.

## Verification

Node 24 with `tsx`, `ffmpeg-static`, `ffprobe-static`, `mongodb-memory-server` and `supertest`:

```sh
node --import tsx --test packages/api/src/description/description.test.mjs packages/api/src/description/router.test.mjs
```

The media tests render real video and check audio by frequency (narration in its gap, ducking, silent pauses, frame counts across 29.97 fps sections). The router tests run whole jobs against an in-memory MongoDB and a small S3-compatible server: stop halfway, continue, re-voice, library save, notices, deletion of every stored file. Before pushing, run the package build (`tsdown` in `packages/api`), which requires explicit types on exported values.
