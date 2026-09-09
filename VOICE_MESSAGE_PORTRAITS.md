# Voice-message portraits

This release is independent of the held call/bridge work. It observes existing saved, cached and autoplay message audio. Each message selects its original agent_id or agent model, never the currently selected chat agent. The regular authenticated agent lookup supplies the authorized portrait.

Animated voice portraits is enabled by default under Settings > Speech. The new inline Pause/Resume button controls the same existing audio element and does not regenerate speech. Unknown authors or missing portraits keep the existing audio controls and text. Other characters use their own portrait with gentle movement; only Kiana's exact approved portrait enables her prepared mouth/eye patches. This is amplitude-driven mouth opening, not phoneme lip sync.

Visible prepared portraits optionally decode a bounded local blob copy. Streaming or unsupported blobs use a closed mouth; there is no extra synthesis request and no WebAudio re-routing of the audible element. Pause, waiting, seeking, interruption, changed speakers, reduced motion, hidden tabs and offscreen portraits are handled. The image is decorative; controls remain labeled and the transcript stays readable.

Run node --test client/src/components/Chat/character/*.test.mjs and build the full client. dev/character/build-voice.cjs builds an actual-component harness over a saved recording; voice-shell.ts fixtures only the app lookup/localization. dev/character/check-voice.cjs records real browser playback, pause/resume without requests, identity, interruption, reduced/off settings, accessible tree and narrow/wide layouts. No test calls a model or TTS provider.

Native iPhone and Android implementations use the same source-clock/identity rules. Native call rendering, rich individualized facial artwork for other agents, phoneme sync, device audio/Bluetooth and physical screen-reader/battery acceptance remain separate work. Preserve the original art and its provenance when preparing further rigs.
