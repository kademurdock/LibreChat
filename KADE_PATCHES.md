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
