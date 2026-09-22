# Expressive faces — September 22, 2026

Kiana, Della, Lilly and Harley each have an additional identity-preserving expression sheet generated from their existing artwork. Eight new panels distinguish curious, thoughtful, playful, confident, tender, tired, serious and delighted delivery. Smug uses playful; excited uses delighted. Original angry, sad, surprised, worried, skeptical, smiling, laughing and blinking faces remain available.

The extra sheet is optional and loads alongside the existing rig. A missing extra sheet falls back to the established expression mapping. The renderer composites facial regions only, preserving the stationary background and hair. Original assets remain untouched. Mouth shapes still follow measured audio energy and are approximate, not phoneme lip sync. Saved-message expression timing still estimates positions from spoken text.

The four prepared identities have different continuous motion rhythms, occasional nods and subtle breathing. Serious/sad/worried delivery reduces that additional movement. Pausing, hiding, disabling or requesting reduced motion retains the existing lifecycle behavior. Web voice portraits are now 256px wide, bounded by their container.

Validation: `node --test client/src/components/Chat/character/*.test.mjs` passes 41 tests, including actual asset dimensions, fallback expression mapping, all four real character IDs, bounded/continuous movement, silence, ownership and cancellation. A local studio imports the actual production renderer and motion modules; new facial patches and speaking simulation were visually inspected in the browser, including a 390px layout and still mode. The simulation is not a live conversation or an audio-sync acceptance test.

No production deployment is implied by this branch. The companion native changes require a Swift/iOS build and device verification. Source PNGs are 1254px squares on the existing 414px-cell/420px-pitch grid.

Full application build is not passing in the existing local dependency installation: it initially lacked compiled shared packages and `postcss-import`, then resolved incompatible `react-window` 2.3.1 despite the lockfile specifying 1.8.11. An isolated verification override used integrity-checked locked react-window/memoize-one packages and located the installed CSS dependency. The next build failed resolving `@radix-ui/react-slot` from the shared client package. No dependency manifest, lockfile, or production build configuration was changed to hide these failures. Run a clean lockfile install/build in CI before release.
