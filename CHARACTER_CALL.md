# Character call animation — Part 167

Animation is held on `session167-character-cues` in both fork and bridge repos.
The fork includes Parts164–166 and the separately releasable Part167 recovery work.
Recovery and animation have separate production ancestry; inspect both remote tips.

## Part167: delivery cues on the audio boundary

The bridge now passes each exact synthesis input alongside its own WAV through
the ordered playback chain. Only its leading delivery tags can produce canonical
clip-start cues. It never sends input text, persona, captions, names embedded in
directions, or guessed mid-sentence times. Existing direction carry supplies the
input; this work does not modify it or alter synthesis/audio bytes. One-shot
speech uses the same path. Effects carry no expressions.

Optional version-1 `cues` have `{at:0, tag:'warm'}` shape (up to eight canonical
values). Both metadata parsing and the playback adapter bound/copy/validate them.
Malformed optional cues are discarded without dropping the audio or its speaker.
Each clip resets the previous expression, then applies only its own cues when
playback begins. Carried directions continue only if present on the next synth
input. No gestures leak across unknown speakers, effects, interruptions or calls.

Warmth, amusement, skepticism, concern and surprise produce small tilts/nods.
The approved portrait and local mouth/blink patches remain intact. These are
delivery gestures, not a new smile/brow rig, phoneme lip sync or emotion detection.
The workshop has a labeled gesture study over saved audio; it does not retune
that recording or claim the selected gesture was heard in it.

50 focused client checks, four actual bridge/cue checks and the full dialog
browser suite pass. The latter traverses a real local WebSocket, actual bridge
WAV dispatcher, actual streaming hook and actual portrait, including queued cues.
Set CHARACTER_PORT=8171 to avoid a prior session's preview process. Whole frontend
build/public asset copy pass; existing TypeScript diagnostics remain tracked.

An allowed-origin browser probe reached production `ready` and `listening` with
one test-seat login and one socket. It supplied silence and received no WAV.
Source inspection confirms user-started web calls intentionally do not greet
(Part110). That outcome proves connection setup, not a broken voice or a spoken
round trip. The next paid call test must provide a synthetic spoken utterance,
capture teardown/close events after cleanup, and verify the reply. No origin
allowlist change is needed. This session retains a conservative $0.60 reservation
within its approved $1 cap; no further allowance carries to another session.

Full paired live speech, physical output/Bluetooth, mobile screen-reader and
battery acceptance remain release gates. Native renderers remain unbuilt.

## Parts164–166 mechanics and earlier evidence

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
