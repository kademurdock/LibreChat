# Registered portrait layers — Part 165

The approved portrait is the stationary base. `portrait-rig.mjs` uses a feathered
local mouth region from the existing generated atlas. Head, hair, jewelry and
background pixels stay unchanged between mouth states. No original image is
overwritten. This is audio-amplitude mouth opening, not phoneme lip sync.

Blink patches failed visual review: parts of the original eyelids remained
visible. They are excluded from the renderer. Better eyelid artwork is still
needed. Listening tilt is limited to 0.7 degrees.

The actual ConversationMode mounts the new hook/canvas and a persisted,
initially-off localized setting. The native applications are unchanged.
Only an authenticated profile with the prepared portrait identity can use the
rig. Unknown speakers and Spotter hide the previous character portrait.

Run `node dev/character/build.cjs` for the dependency-free workshop.
The separate React StrictMode harness and browser receipts live in the Part165
workspace; it tests the actual hook, not the complete modal/backend call.
Full frontend bundling passes. Whole-project type errors were compared with the
unchanged parent. Backend call, device latency, screen reader and battery
acceptance remain outstanding. Hold this branch until those checks and the
queued-speaker transition review are complete.
