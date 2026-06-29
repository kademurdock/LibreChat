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

---

## Patch P1 — Per-user usage tracker (TTS / Flux / Tavily) + admin usage route (June 29 2026)

**Goal:** Track server-side per-user API usage that LibreChat does NOT already record in `transactions` (LLM spend is already there), and expose an admin-only aggregation endpoint.

**New files:**
- `api/models/kadeUsage.js` *(new)* — standalone Mongoose model + collection `kadeusage` (model name `KadeUsage`). Lives outside `@librechat/data-schemas` so no TS build step. Exports `logKadeUsage({userId, service, quantity, unit, costUSD, metadata})` — a fire-and-forget logger wrapped in try/catch that NEVER throws (usage logging must never break a user's request). Also exports `fluxCost(endpoint, images)`, `RATES`, `FLUX_ENDPOINT_USD`. Rates: TTS $5/1M chars, Flux $0.025/img (per-endpoint table), Tavily $0.008/search.
- `api/server/routes/kade.js` *(new)* — `GET /api/kade/usage?days=30`. Gated by `requireJwtAuth` + `requireCapability(SystemCapabilities.ACCESS_ADMIN)`. Aggregates: LLM spend from `transactions` (`tokenValue`, USD = |value|/1e6), extra-service usage from `KadeUsage` (cost + quantity per service), and current `Balance` (tokenCredits/1e6). Returns all-time + windowed (default 30d) totals, `perService`, and `perUser` (sorted by all-time LLM spend).

**Instrumented (each call best-effort, never throws):**
- `api/server/services/Files/Audio/TTSService.js` — `processTextToSpeech` logs `input.length` chars; `streamAudio` accumulates `update.text.length` across chunks and logs once on completion. service='tts', unit='chars'.
- `api/app/clients/tools/structured/FluxAPI.js` — logs 1 image after each successful generation in `_call` and `generateFinetunedImage` (uses `this.userId`, per-endpoint cost). service='flux', unit='images'.
- `api/app/clients/tools/structured/TavilySearchResults.js` — captures `this.userId = fields.userId` in constructor; logs each search in `_call` (advanced depth = 2 requests). service='tavily', unit='searches'.

**Wiring:** `api/server/routes/index.js` (require + export `kade`), `api/server/index.js` (`app.use('/api/kade', routes.kade)` after `/api/rum`).

**Not in this patch:** the daily email digest is a Cowork scheduled task (external to the fork) that calls `/api/kade/usage` + the Twilio billing API and emails Kade.

---

## Patch P2 — Usage dashboards + "Feed the Server" donation page (June 29 2026)

Replaces the originally-planned daily email digest (Kade's call) with live web pages.

**New self endpoint:**
- `GET /api/kade/my-usage` (in `api/server/routes/kade.js`) — gated by `requireJwtAuth` only (any logged-in user, own data). Returns the caller's month-to-date + all-time spend (LLM + tts/flux/tavily), current balance, and `suggestedDonationUSD` = month-to-date total. Safe for non-admins — only ever the caller's own ObjectId.

**New pages (`api/server/routes/kadePages.js`, served as static HTML shells):**
- `/feed-the-server` — friendly personal page: "your tab so far this month" framed as an optional suggested donation, with a PayPal "Chip in" button (paypal.me/kademurdock), this-month breakdown, all-time totals, remaining balance. Public-appropriate copy (not Kiana voice). Accessible: semantic headings, `aria-live` status, tabular-nums, dark-mode aware, focus-visible outlines.
- `/usage-dashboard` — admin-only full breakdown (totals, by-service table, by-person table). Shows "admins only" if the API returns 403.

**Auth model for the pages:** the JWT strategy only reads the `Authorization` header (no cookie), so the HTML shells carry no server-side auth. Their client JS calls `POST /api/auth/refresh` (the same httpOnly refresh-cookie flow the SPA uses on boot) to obtain an access token, then calls the gated `/api/kade/*` APIs. Not signed in → page shows "please sign in at the chat site first."

**Wiring:** friendly top-level routes `app.get('/usage-dashboard'|'/feed-the-server', ...)` registered in `api/server/index.js` immediately before the SPA fallback; same handlers also reachable at `/api/kade/dashboard` and `/api/kade/feed`. `kade.js` no longer applies a router-wide admin gate (it's now per-route) so `/my-usage` and the HTML shells are reachable by any/no auth as appropriate while `/usage` stays admin-only.

**Not done (Kade's call):** adding a link to `/feed-the-server` in the login welcome message — that lives in `kademurdock/librechat.yaml` and needs a separate manual redeploy of the LibreChat config repo.

---

## Patch P3 — In-app nav links to Feed-the-Server + Usage Dashboard (PWA accessibility) (June 29 2026)

Problem: in standalone PWA mode there's no address bar, so `/feed-the-server` and `/usage-dashboard` were unreachable from inside the installed app. Fix: surface them as items in the account dropdown menu.

- `client/src/components/Nav/AccountSettings.tsx` — added two `Menu.MenuItem`s after Settings: **Feed the Server** (all users -> `window.location.href='/feed-the-server'`, Heart icon, aria-label) and **Usage Dashboard** (gated `user?.role === SystemRoles.ADMIN`, -> `/usage-dashboard`, Gauge icon). Same-origin navigation so it stays inside the PWA. Imported `Gauge, Heart` from lucide-react and `SystemRoles` from librechat-data-provider.
- `api/server/routes/kadePages.js` — added an accessible "← Back to chat" link (href `/`) at the top of both pages, since a full-page load in standalone PWA has no back button. Added `a.back` style with focus-visible outline.

Kade to eyeball: account menu (bottom-left avatar) should show "Feed the Server" for everyone and "Usage Dashboard" for admins; both should be VoiceOver-reachable; each page should have a "Back to chat" link.

---

## Patch P4 — iOS voice-preview fix (autoplay unlock) + visible error readout (June 29 2026)

C3 preview still failed on iPhone after 256bf88. Root cause: the `<audio>` element was created inside the tap, but `audio.play()` only ran AFTER `await fetch(...)`. iOS Safari requires the element to have been *played* within the user gesture; the fetch gap made the later play() count as non-user-initiated → blocked → button untoggled.

`client/src/components/Audio/Voices.tsx`:
- Added `SILENT_WAV` (a ~10ms inline silent WAV data URI). In `togglePreview`, synchronously set `audio.src = SILENT_WAV` and call `audio.play()` inside the tap to UNLOCK the element (unmuted — a muted play does not satisfy iOS's unlock for later unmuted audio; the clip is pure silence so it's inaudible anyway). The real sample fetched async then plays on the same unlocked element.
- Added an `error` state surfaced in a `role="alert"` `aria-live="assertive"` span under the button, set on HTTP error / decode error (`onerror`) / `play()` rejection / fetch failure. This makes the next iPhone test diagnostic (Kade can read the on-screen/VoiceOver message) instead of a silent "didn't work" — since there's no console access on her phone.

Kade to retest on iPhone: pick a voice -> Preview. If it plays, done; if not, tell me the red error text that now appears.
