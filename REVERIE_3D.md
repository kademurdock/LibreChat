# Reverie 3D presentation and shared gatherings — session 169

`client/public/assets/reverie/stage.mjs` renders the existing room snapshot. No game authority, networking for state, audio, or AI provider calls live in the renderer. `presentation.mjs` is its deterministic layout/description contract. Pictures remain aria-hidden; Describe the picture writes once to the existing world log. People and home furnishings come from the room; figures are generic stand-ins, and the miniature is an artistic arrangement, not navigation coordinates.

Eight scene families: home, diner, reading room, generic interior, town, woodland, creek, camp; waterfront is a ninth. Weather is restricted to outdoors. Shared gatherings add a temporary table and activity props. Tree crowns, breathing, fire, water, weather and records animate; successful self movement/dance/wave cues can animate the figure. No sound-only fishing timing is exposed visually. There are no synth/human badges. Controller kinds still exist in API metadata: this is NOT completion of the Veil.

The 30 FPS target and 1.35 maximum device-pixel multiplier limit work. IntersectionObserver, document visibility, reduced motion and the saved motion preference stop the render loop. Picture-off disposes renderer/materials/texture/context. Context failure restores SVG. Camera buttons are ordinary controls outside the hidden canvas, and the canvas cannot capture scroll/touch gestures. Static SVG homes no longer invent furnishings. No dependency script is fetched from a CDN in play; pinned MIT Three.js 0.186.0 is vendored with tarball integrity and per-file hashes. The new mural is original GPT image generation, with its full-size master saved in the owner's context folder.

`hangout invite Name` validates room presence and membership. Authored residents join and make one themed contribution via an optimistic version check. Repeated invitations cannot duplicate the guest or entry. Human players are invited without being enrolled. When only authored residents remain after the host leaves, the existing room album is saved and the gathering ends. This uses existing sound cues, no generation budget. Private AI conversations are never reused in public albums. Autonomous AI player planning, fitted voices, per-character appearance, exact spatial furniture placement and the complete identity Veil remain future work.

Validation commands from repo root:

```
node --test client/public/assets/reverie/presentation.test.mjs
node --require ./api/test/reverie-bootstrap.cjs packages/api/src/reverie/invitations.harness.cjs
node --require ./api/test/reverie-bootstrap.cjs packages/api/src/reverie/harness.cjs
node --require ./api/test/reverie-bootstrap.cjs packages/api/src/reverie/outdoors.harness.cjs
node api/app/clients/tools/kadegames/harness.js
node dev/reverie/serve.cjs
# Second terminal; Playwright browser must be installed. Set PLAYWRIGHT_CHANNEL=msedge on Windows if desired.
node dev/reverie/verify.cjs
```

The browser server binds only to 127.0.0.1 and uses disposable Mongo with invented people. It has no production credentials. REVERIE_NATIVE_ROOT can point at the native checkout for the offline-bundle checks. Export that bundle using `node dev/reverie/export-native.cjs /absolute/path/to/kade-ai-native`; development dependencies rollup and @rollup/plugin-terser are required. The web always consumes the module source; the iPhone bundle is generated, not a separately maintained renderer.

Android's native application opens /world in its existing WebView, so the web release also reaches that surface. Native SwiftUI iPhone support is held on session169-reverie-world. The user asked to wait on the native build; the one just-started run was canceled during machine preparation, before source checkout or compilation. Do not restart or publish native without a new instruction. Physical VoiceOver/TalkBack, actual WebKit resource packaging, listening and sustained device performance remain unverified. Public gate and resident conversation allowance are unchanged.
