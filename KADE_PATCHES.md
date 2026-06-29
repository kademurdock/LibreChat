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
