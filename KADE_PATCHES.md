# KADE_PATCHES.md — Kade-AI fork patch log

All source-level patches applied to the `kade` branch on top of upstream LibreChat.
Each entry: what changed, which file(s), why it could not be done via config/proxy.

Branch: `kade` (based on upstream tag `v0.8.7`, commit `9e74cc0e57b395926122bd4062c1fcedc48ed465`)

---

## Patch log

### C1 — TTS audio cutoff fix (2026-06-29)

**File:** `api/server/services/Files/Audio/TTSService.js`

**What changed:**
- Line 306: `if (input.length < 4096)` → `if (input.length < 32768)`
- Line 312: `splitTextIntoChunks(input, 1000)` → `splitTextIntoChunks(input, 4000)`

**Why not config/proxy:** LibreChat's chunking logic lives in the backend service layer with no env-var override. The 4096-char threshold caused LibreChat to split long TTS input into 1000-char chunks and pipe each chunk's WAV response sequentially. The browser received multiple concatenated WAV headers and cut off after the first chunk. Our Inworld proxy already handles long text internally, so raising the threshold to 32768 ensures LibreChat almost always makes a single TTS call, letting the proxy do its job cleanly.

**Commit:** `1882b157b7eb747d55f9ac07b6fb35d53f918538`

---

### C2 — Reasoning bubble stays collapsed after user collapses it (2026-06-29)

**Files:**
- `client/src/components/Chat/Messages/Content/Parts/Reasoning.tsx`
- `client/src/components/Chat/Messages/Content/Parts/Thinking.tsx`

**What changed:** Both components now use a lazy `useState` initializer that reads a `localStorage` flag (`reasoningUserCollapsed`). When `showThinkingAtom` is true but the user manually collapses a bubble, all subsequent new reasoning bubbles start collapsed. If the user manually expands a bubble, the flag is cleared so the next bubble starts expanded again. The user's last explicit action wins.

**Why not config/proxy:** This is React component state behavior — `useState(showThinking)` re-initializes on every mount, so new reasoning blocks always matched the global setting regardless of what the user just did. No config or proxy hook available.

**Commits:**
- `47978d57ea90b6b376152909901d16df9631d622` (Reasoning.tsx)
- `9e6899f6324e8364125782c13ab54d6a02f72b18` (Thinking.tsx)

---

### C3/E1 — Voice preview button in ExternalVoiceDropdown (2026-06-29)

**File:** `client/src/components/Audio/Voices.tsx`

**What changed:** Added `VoicePreviewButton` component and `useVoicePreview` hook. When the external (Inworld) voice engine is active and a voice is selected, a Play/Stop button appears beneath the voice picker. Clicking it fetches a short WAV sample via `POST /api/files/speech/tts/manual` (the existing manual TTS route — no new backend routes needed) using the selected voice ID and a fixed sample phrase. Clicking again stops playback.

**Accessibility:** `aria-label` includes the voice name so VoiceOver announces "Preview voice: [name], button". `aria-pressed` reflects live play state. Fully keyboard-navigable with focus ring.

**Why not config/proxy:** This is a React component UI change; no backend or config hook exists for adding UI controls.

**Commit:** `b598dad4e742e146ecf11e2844d4bcf63c957061`

---

### C4/E2 — iOS safe area + form a11y (2026-06-29)

**Files:**
- `client/index.html` — added `viewport-fit=cover` to viewport meta
- `client/src/mobile.css` — added `.pb-ios-safe` utility class using `env(safe-area-inset-bottom, 0px)`
- `client/src/components/Chat/ChatView.tsx` — applied `pb-ios-safe` to the chat form wrapper div
- `client/src/components/Chat/Input/ChatForm.tsx` — added `aria-label` to the `<form>` element

**What changed:**
- **iOS home pill fix:** Without `viewport-fit=cover`, the browser's default safe-area handling was incomplete in standalone PWA mode (apple-mobile-web-app-capable), causing the home indicator to overlap the chat input. Adding `viewport-fit=cover` + `env(safe-area-inset-bottom)` padding resolves this.
- **Form ARIA landmark:** The `<form>` element now has `aria-label={localize('com_ui_message_input')}`, making it a named Forms landmark. VoiceOver users on iOS can jump directly to it via the Forms rotor.

**Why not config/proxy:** CSS and HTML layout — not configurable via LibreChat YAML.

**Commits:**
- `5a791c8d271ef7c77416d1488a77d66aaeaec6ee` (index.html)
- `67c0ae6e2f68d7894b40cf4e58cefb4166b46245` (mobile.css)
- `80e8c3e2e81f72aaebeff3008c8c5974126ed4a3` (ChatView.tsx)
- `28f7778b0ebaf69afe9988970ba58c82b124c215` (ChatForm.tsx)

---


---

## D3 — Per-agent default voices (June 29, 2026)

**Commit:** `1f69691e7490be362906a1221278cf060314fa7a`

**Why it couldn't be config/proxy:** Requires watching Recoil conversation state and imperatively setting another Recoil atom when the agent changes. No yaml config or proxy hook for this — it's client-side React state management.

**Files changed:**

- `client/src/hooks/Agents/useAgentVoiceSync.ts` *(new)* — the hook. Reads `store.conversationAgentIdByIndex(index)` (Recoil selector). On change, reads `localStorage['kade:agent_voices']` (a JSON map of `agent_id → voice_id`). If a saved preference exists, calls `useSetRecoilState(store.voice)` to switch the active TTS voice. Exports `saveAgentVoicePreference(agentId, voice)` utility for callers.

- `client/src/hooks/Agents/index.ts` — added export for `useAgentVoiceSync`, `saveAgentVoicePreference`, and `AGENT_VOICES_KEY`.

- `client/src/components/Chat/ChatView.tsx` — added `useAgentVoiceSync(index)` call after `useResumeOnLoad`. No JSX changes.

- `client/src/components/Audio/Voices.tsx` — in `ExternalVoiceDropdown`: added `useRecoilValue(store.conversationAgentIdByIndex(0))` to track active agent; in `handleVoiceChange`, after setting `store.voice`, calls `saveAgentVoicePreference(activeAgentId, v)` if an agent is active.

**How to use:**
1. Open Settings → Speech → Voice → pick a voice for your current agent's chat. That's it — the preference is saved automatically.
2. Switch to a different agent's conversation — voice auto-switches.
3. Switch back — voice auto-switches back.
4. The `kade:agent_voices` key in localStorage holds the full map; inspect/clear via browser DevTools if needed.

**What's NOT done yet (D1/D2):** The agent schema (`packages/data-schemas/`) doesn't have a `voice` field and the agent builder UI doesn't expose a picker yet. D3's localStorage approach works without schema changes — agent admins (Kade) set preferred voices by using the speech settings while in that agent's chat. A future D1/D2 pass could add a builder UI field and sync it to the schema for multi-user voice defaults.
