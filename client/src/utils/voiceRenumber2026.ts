/**
 * KADE — one-time client migration for the 2026-07-01 voice renumbering.
 *
 * The TTS proxy renumbered its catalog so Kade's custom voices lead as
 * Voice 1–70 and the stock library follows as 71–210 (see the proxy's
 * NUMBERED_VOICE_ALIASES derivation and KADE_PATCHES D2d). Old labels could
 * NOT be kept as aliases — the label space collides ("Voice 1" old/stock vs
 * new/custom) — so every device's saved labels must be rewritten once or
 * they'd silently resolve to different-sounding voices.
 *
 * This runs at app boot, BEFORE React (and Recoil's localStorage effects)
 * initialize, rewrites the two client-side stores that hold voice labels,
 * and flags itself done:
 *   - `voice`             — the global TTS voice (Recoil atomWithLocalStorage,
 *                           JSON-encoded string)
 *   - `kade:agent_voices` — the per-agent voice map (plain JSON object)
 *
 * The mapping is FROZEN HISTORY (it describes a completed renumbering event),
 * so hardcoding it here cannot go stale:
 *   old 108–175 -> 1–68, old 209/210 -> 69/70,
 *   old 1–107   -> 71–177, old 176–208 -> 178–210.
 */

const MIGRATION_FLAG = 'kade:voice_renumber_2026_07_01';

function oldToNewLabel(label: unknown): unknown {
  if (typeof label !== 'string') {
    return label;
  }
  const m = /^Voice (\d+)$/.exec(label);
  if (!m) {
    return label; // friendly names ("Kiana (Comedian)") still resolve proxy-side
  }
  const n = Number(m[1]);
  let nn: number | null = null;
  if (n >= 108 && n <= 175) {
    nn = n - 107;
  } else if (n === 209) {
    nn = 69;
  } else if (n === 210) {
    nn = 70;
  } else if (n >= 1 && n <= 107) {
    nn = n + 70;
  } else if (n >= 176 && n <= 208) {
    nn = n + 2;
  }
  return nn == null ? label : `Voice ${nn}`;
}

export function migrateVoiceNumbering(): void {
  try {
    if (localStorage.getItem(MIGRATION_FLAG) != null) {
      return;
    }

    // 1) Global voice setting — Recoil persistence stores JSON.
    const rawVoice = localStorage.getItem('voice');
    if (rawVoice != null) {
      try {
        const parsed = JSON.parse(rawVoice) as unknown;
        const migrated = oldToNewLabel(parsed);
        if (migrated !== parsed) {
          localStorage.setItem('voice', JSON.stringify(migrated));
        }
      } catch {
        /* unparseable -> leave untouched */
      }
    }

    // 2) Per-agent voice map — plain JSON object of agent_id -> label.
    const rawMap = localStorage.getItem('kade:agent_voices');
    if (rawMap != null) {
      try {
        const map = JSON.parse(rawMap) as Record<string, unknown>;
        if (map != null && typeof map === 'object' && !Array.isArray(map)) {
          let changed = false;
          for (const key of Object.keys(map)) {
            const next = oldToNewLabel(map[key]);
            if (next !== map[key]) {
              map[key] = next;
              changed = true;
            }
          }
          if (changed) {
            localStorage.setItem('kade:agent_voices', JSON.stringify(map));
          }
        }
      } catch {
        /* unparseable -> leave untouched */
      }
    }

    localStorage.setItem(MIGRATION_FLAG, new Date().toISOString());
  } catch {
    // localStorage unavailable (privacy mode etc.) — nothing to migrate.
  }
}
