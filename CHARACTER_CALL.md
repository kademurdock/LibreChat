# Part 165 continuation

ConversationMode now mounts the character hook, registered mouth renderer and
initially-off saved/localized motion preference. This branch is still held.
The original portrait remains the base; blink layers are excluded after visual
review. See dev/character/REGISTRATION.md for current limits.

`npm ci`, `node dev/character/build-mounted.cjs`, then serve
`dev/character/out-mounted` on loopback. `check-mounted.cjs` uses Playwright;
CHARACTER_PREVIEW_URL and CHARACTER_BROWSER can select the URL/browser.
The dependency-free `build.cjs` workshop is also updated to the mouth rig.

35 engine/integration checks pass, React StrictMode controller browser checks
pass, and the full frontend builds. Whole-project type checking has existing
errors outside these changes; the same baseline errors were reproduced.
Hardware, full backend call, accessibility acceptance and queued speaker
transition review are still release gates. No native adapter or live release.

---

The following Part164 record describes the parent increment:

# Character playback integration — Part 164

This is held development work. No production caller supplies the new optional
`ConversationMode.presentation` prop yet. There is no new user setting or native
release. The workshop is a working portrait/audio preview, not a live call demo.

## Implementation

`client/src/components/Chat/character` contains an ESM port of Part163's engine
(inworld branch `session163-character-motion`, commit `160b394`) plus the new
call adapter, typed presentation interface, metadata reader and atlas renderer.
The original 24 expression/motion/player checks are retained.

Classic `enqueueAudio` and streaming WAV/PCM scheduling notify the presentation
only after `AudioBufferSourceNode.start` succeeds, using the actual decoded
buffer and AudioContext time. End listeners are additional listeners; they do
not replace audio's existing cleanup. The adapter computes an envelope without
retaining the AudioBuffer, and waits for locally queued clips to drain even if
the server says listening earlier. Clearing invalidates all old completions.
Observer failures cannot prevent playback or its end callback. A malformed clip
cannot strand a speaking animation loop. Changing renderers uses a stable relay.

Classic game clips explicitly use `speech:false`. There is also a post-decode
turn check: interruption while decoding must not schedule an old sentence.
Streaming Spotter PCM uses `speech:false, agentId:null`; it cannot animate the
selected character. Old socket events are ignored after a replacement call.

## Paired bridge contract

Bridge branch `session164-character-audio` adds this JSON immediately before
each existing binary WAV frame, without an intervening await:

```json
{"type":"character-audio","version":1,"agentId":"agent_id","speech":true}
```

The bridge's existing game-sound call (`noCaption:true`) emits `speech:false`.
No text, persona, estimated phonemes or guessed expression timestamps travel in
the message. A metadata-send failure does not block the existing binary send.
The client consumes metadata once, before decode, and clears it on interruption,
call start and any intervening control event. An old bridge or malformed metadata
leaves animation static; audio still plays. Old clients ignore the new event.

The speaker id is presentation metadata, not authorization to load a profile.
`resolveProfile(id)` must return only a rig already available to that user.
Unknown ids use `rigReady:false`. On a speaker change the old animation is cleared;
the new atlas is hidden until its scheduled start. The containing UI must also
choose the correct authorized static portrait; never leave the old speaker's
portrait representing a new speaker.

## Workshop and repeatable checks

Node 24 (no npm dependencies needed):

```sh
node --test client/src/components/Chat/character/*.test.mjs
node dev/character/build.cjs
python -m http.server 8164 --bind 127.0.0.1 --directory dev/character/out
```

Open `http://127.0.0.1:8164/workshop.html`. Motion starts off. The neutral local
Windows voice is not Kiana's voice; its deliberate pause closes the mouth.
The portrait remains underneath the atlas, including failed artwork loads,
disabled/reduced motion and unknown rigs. Controls and transcript are accessible;
the portrait, atlas and frame data are decorative. No mic, model or upload.

`dev/character/PROMPT.md` records the included-imagegen prompt. **The atlas is a
draft:** blink cells tilt the head and the framing drifts. This causes jitter.
It is retained for review, not accepted as a production rig. The original portrait
is preserved. The renderer uses two mouth states, not phoneme lip sync; expression
directions remain supported by the engine but have no production audio cue times.

34 fork tests pass, plus 2 bridge tests. Browser evidence uses the actual React
streaming hook and real Edge WebAudio with a synthetic transport and microphone
stream. It verifies speech, early server listening, clear during decoding, game
cues, missing metadata, PCM and stop. The portrait workshop passes real-audio
speech/silence, listening, interruption, reduced-motion, unknown-rig and 360/1040
layout checks. Browser test scripts/JSON/screenshots are in the Part164 session
workspace. Strict TypeScript checking passes for the streaming hook and typed
presentation modules; full ConversationMode TSX syntax passes. The complete
LibreChat build and a live backend call were not run, so this is not release QA.

## Release work still required

1. Make a stable rig with consistent registration and review it at playback speed.
2. Mount the renderer in the actual call dialog, with the existing static portrait
   beneath it and a localized, persisted, initially-off motion setting. Supply a
   stable adapter through `presentation`; dispose it on teardown. Connect reduced
   motion and visibility preferences and keep all existing screen-reader flow.
3. Bind only authorized profiles, verify mid-call speaker changes and Spotter
   transitions with the mounted UI, and keep other characters static until ready.
4. Finish the full frontend build, live vischeck call acceptance, hardware latency,
   accessibility, mobile and battery checks. Then release the paired branches,
   verify Railway deployment SHAs plus smoke, update help and draft family news.
5. Native playback adapters and genuine audio-relative expression cues are later
   work. Do not change TTS chunking or invent timestamps from captions.

No Scenema, original sound master, agent/persona/model/voice/default or memory
record was changed. Forge can continue both branches with existing repo tools.
