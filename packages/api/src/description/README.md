# Described video owner trial

`/described-video` turns an uploaded video or a downloadable YouTube video into an MP4 with mixed audio description and an M4A audio copy. The legacy `/describe` summary feature remains available. The implementation is web/backend only.

The visual model produces grounded, timed cues and shorter alternatives, plus continuity notes and protected sound intervals. Deepgram word timestamps identify dialogue. Existing platform Inworld/Fish voices synthesize individual cues. FFmpeg measures and time-stretches the actual audio with pitch preserved, fits it into dialogue gaps, ducks background audio, and renders the final copy. Narration speed is selected before generation; playback speed changes the entire finished copy together.

Standard mode keeps the source runtime and reports cues that cannot fit. Extended mode can freeze the picture and pause the source soundtrack at a model-suggested boundary, adjusted past speech/protected sounds, then resume both. The original audio is retained. Multi-section rendering carries character continuity and exports source/output timestamps with omissions in `description.json`.

## Operation

- Existing JWT authentication and account ownership guard every API action under `/api/kade/described-video`.
- ADMIN accounts only by default. `KADE_DESCRIPTION_PUBLIC=1` enables other authenticated accounts. Keep the private trial until listener evaluation is satisfactory.
- Requires existing `OPENROUTER_KEY`, `DEEPGRAM_API_KEY`, S3 credentials/region/bucket, and FFmpeg/FFprobe (already in the Docker image).
- Existing voice catalog/proxy is reused. `KADE_TTS_PROXY_URL` can override it. Numbered voices are not modified.
- YouTube imports accept only canonical individual YouTube video IDs. The existing yt-dlp installation uses Node for its supported JavaScript runtime; no browser cookies or user credentials are forwarded. Live/upcoming streams, oversized media, and unavailable/restricted downloads stop with a file-upload fallback. Importing and checking do not start paid AI processing.
- Defaults: Gemini `google/gemini-3.8-flash`, 2 GiB uploads, 90-minute input limit, one active job per account, one worker across replicas, seven-day output retention, 24-hour unfinished upload retention.
- `KADE_DESCRIPTION_MODEL`, `KADE_DESCRIPTION_MAX_MINUTES`, `KADE_DESCRIPTION_JOB_USD`, and `KADE_DESCRIPTION_DAILY_USD` override the trial defaults. The default job and daily processing allowances are both USD 5. A new job can reserve the unused remainder of the daily allowance. `KADE_DESCRIBED_VIDEO=0` stops new processing and aborts the active job on its next heartbeat.
- `KADE_MEDIA_BUCKET` can override `AWS_BUCKET_NAME`; the bucket must be private. Browser uploads travel through authenticated same-origin 8 MiB chunk requests, avoiding dependence on storage CORS rules. Each chunk is persisted with its hash and acknowledged offset for resuming interrupted uploads. Signed links deliver completed media.
- Free preparation probes duration before the explicit paid Start action. Requests use recovery IDs, durable Mongo jobs, and atomic budget reservations. Cancellation aborts unfinished multipart uploads and propagates to media/model operations. Interrupted paid work is failed rather than automatically replayed after a restart.
- Processing allowances use conservative reservations per provider call. Vision cost reconciles against returned usage; speech/transcription are estimates. These are not exact invoice guarantees. Hosting, storage, and downloads are separate. Requests already accepted by providers can still be charged after cancellation.

## Verification

The media tests execute real FFmpeg renders, probe duration, and inspect audio frequencies to verify preservation of source audio, narration placement, and inserted pauses. Only external model/TTS responses are replaced. Router tests use real MongoDB and test authentication, ownership, upload recovery, concurrent starts, and spending reservations.

Run with Node 24 and `tsx`, `ffmpeg-static`, `ffprobe-static`, `mongodb-memory-server`, and `supertest` available in the test environment:

```sh
node --import tsx --test packages/api/src/description/description.test.mjs packages/api/src/description/router.test.mjs
```

`FFMPEG_PATH` and `FFPROBE_PATH` may point to installed executables in deployments. Production does not depend on the test binaries.

The initial real-provider check described a 40-second Big Buck Bunny excerpt with eight cues for approximately USD 0.044 in metered/estimated processing. That checks the actual integration; it does not establish episode-length quality or a general price guarantee. Fast motion, small text, identity changes across cuts, speech-recognition mistakes, and natural pause selection require further listener evaluation.

Possible future comparisons: Gemini Flash-Lite for economy, Gemini Flash with a second accuracy/timing review for a premium mode, and DeepSeek vision on sampled frames as a separate experiment. No untested quality tier is currently offered.
