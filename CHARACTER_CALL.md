# Character call animation — Part 166

This work is held on `session166-character-timing`. It is not deployed. It includes
Part164/165 and the production onboarding/password changes observed in this session.
Paired streaming metadata remains on bridge `session164-character-audio` (8f85fa7).

The call dialog mounts an initially-off, saved and localized motion setting.
Only the authenticated selected agent with the matching prepared portrait gets a
rig. Unknown speakers, invalid/missing metadata and Spotter keep a static fallback.
Artwork is downloaded only once motion is enabled, visible and not reduced.

The original portrait stays fixed. A small mouth patch follows decoded audio
energy; two newly generated eye patches make ordinary blinks. No entire generated
frame replaces the portrait. This is two-state mouth opening/blinking, not phoneme
lip sync or inferred emotion. See dev/character/BLINK.md for provenance and prompt.

## Playback ownership

`adapter.mjs` keeps a bounded ordered queue of envelopes and speaker IDs, without
retaining AudioBuffers. It changes the displayed speaker when the playback clock
reaches the clip's start. Enqueuing a different speaker does not clear current
speech. Same-speaker chunks preserve the blink cycle. Late boundary wakes skip
expired clips; interruption/hangup/disposal clear future identities and timers.
A boundary timer operates independently of animation frames, including motion-off,
reduced-motion and hidden views. Reopening a view reconciles against audio time.

Classic WAV, streaming WAV and Spotter PCM use `playbackTime(ctx)`. A fresh browser
output timestamp estimates device playout position; unavailable/stale measurements
fall back to AudioContext render time. Source scheduling and audio bytes are not
changed. End callbacks do not close the mouth ahead of the measured output tail.
This is browser timing support, not proof of Bluetooth or physical output latency.
[Web Audio timing specification](https://webaudio.github.io/web-audio-api/#dom-audiocontext-getoutputtimestamp).

Bridge JSON immediately precedes one WAV: `{type:'character-audio', version:1,
agentId, speech}`. No text or private instructions are included. Sound effects use
speech:false. Old/malformed/missing metadata never enables a mouth. The bridge
continues sending the same audio if the optional metadata send fails.

## Reproduce

Node 24, installed lockfile dependencies:

- `node --test client/src/components/Chat/character/*.test.mjs` — 46 checks.
- `npm run build:client` — complete frontend plus public asset copy.
- `node dev/character/build.cjs` — dependency-free workshop. Serve out/ on loopback,
  open workshop.html; both neutral Windows and saved Windflower audio are included.
- `node dev/character/build-mounted.cjs` — actual-hook preview retained from Part 165.
- `node dev/character/build-dialog.cjs` — actual ConversationMode dialog, with real
  built CSS. App-shell state/auth hooks and the unrelated game table are fixtures.
- Set CHARACTER_BRIDGE_SOURCE to the held bridge checkout, then
  `node dev/character/serve-dialog.cjs`. It binds only 127.0.0.1:8166 and executes
  the actual bridge WAV sender over a real local WebSocket. Microphone bytes are
  discarded and no model/STT/TTS provider is called by this test server.
- Set CHARACTER_RECEIPTS to an output directory and run
  `node dev/character/check-dialog.cjs`. Uses Playwright and installed Edge with a
  synthetic microphone. It covers queued speakers on/off/reduced/hidden, clear,
  old metadata, Spotter, real decoded samples, focus wrapping through the checkbox,
  accessibility tree, 1040/360/667 layouts, short-screen scrolling and reopen.
- Serve the workshop on 127.0.0.1:8168, then `node dev/character/check-eyes.cjs` for
  eye-region pixel checks and render captures.

The dialog now includes the checkbox in its focus trap, a 44px label target, a
working dark background and a scrollable layout on short screens. Visuals/captions
remain decorative; animation creates no screen-reader announcements.

## Evidence and remaining release gates

46 focused checks, complete-dialog browser checks and full frontend build pass.
Blink changes were confined to 4,180 pixels inside the two eye regions at 512px;
blink and simultaneous mouth/blink captures were inspected. Whole-project
TypeScript still has 14 diagnostics, identical in the unchanged merged parent.
No new diagnostics originate from this work.

The attempted production vischeck call from localhost yielded no protocol messages
or WAV before its 22-second timeout. It was closed, with no retry. Production's
bridge allows the site's origins and rejects localhost before session startup;
local integration success does not establish production-call success. A 60-cent
allowance remains conservatively reserved against the approved $1 session cap;
no billable model/audio generation was confirmed. Artwork used built-in imagegen;
the Windflower recording is reused from Part 165 and costs nothing to replay.

Before release: run the paired complete call from an already allowed site origin
(or approved staging), without weakening the production origin allowlist. Verify
audio, speaker transitions and help there; complete mobile screen-reader, physical
output/Bluetooth and battery acceptance. Then verify both deployment SHAs and live
smoke, update help, and draft family news. Do not treat these development checks as
those release approvals. Native adapters and real audio-relative expression cues
remain open. No persona/model/voice/memory/default edits were made in Part 166.
