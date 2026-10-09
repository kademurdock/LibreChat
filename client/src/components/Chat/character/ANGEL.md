Angel's vector master is original code-authored artwork shared unchanged with the native iPhone app. `angel-vector.json` has SHA-256 `805783c577c0beb332256fd8786fefa6b42d8a24a2f499b4e1a3de9e26f7f1e0` and 149 shapes. It contains no other character's pixels.

`angel-motion.mjs` follows the native `CharacterAngelVectorMotion.swift` geometry: seventeen faces, nine mouth roles, continuous clipped eyelids, slow wings, floating halo and dimming jewels at stable positions. The web rig consumes the existing voice-message audio clock, RMS envelope, viseme selection and motion policy. It creates no timer and does not control audio. ID and avatar filename must both match the public Angel record.

When animation is paused, disabled, reduced, hidden or unavailable, the server avatar remains the fallback. Its localized appearance description and voice-message controls remain accessible. Live browser calls do not currently consume this prepared-portrait renderer.
