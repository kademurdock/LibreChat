/**
 * KADE July 16 2026 — low-vision display preferences (accessibility research paper, Section C).
 *
 * Three user-facing options, all additive and fail-soft:
 *   - High contrast (true black): class `kade-hc` on <html>
 *   - Easy-read font (Lexend / OpenDyslexic): class `kade-font-lexend` | `kade-font-opendyslexic`
 *   - Line spacing (relaxed / loose): class `kade-space-relaxed` | `kade-space-loose`
 *
 * The classes drive CSS in style.css (search "KADE LOW-VISION"). State lives in the same
 * localStorage keys the Recoil atoms in store/settings.ts use, so `applyKadeA11yPrefs()`
 * can run BEFORE React mounts (main.jsx) with no flash of unstyled preference, and the
 * Settings controls call it again on every change. Everything is wrapped so a storage
 * failure can never break boot.
 */

export const KADE_A11Y_STORAGE_KEYS = {
  highContrast: 'kadeA11yHighContrast',
  font: 'kadeA11yFont',
  spacing: 'kadeA11yLineSpacing',
} as const;

export type KadeA11yFont = 'default' | 'lexend' | 'opendyslexic';
export type KadeA11ySpacing = 'default' | 'relaxed' | 'loose';

export interface KadeA11yPrefs {
  highContrast: boolean;
  font: KadeA11yFont;
  spacing: KadeA11ySpacing;
}

const FONT_CLASSES: Record<Exclude<KadeA11yFont, 'default'>, string> = {
  lexend: 'kade-font-lexend',
  opendyslexic: 'kade-font-opendyslexic',
};

const SPACING_CLASSES: Record<Exclude<KadeA11ySpacing, 'default'>, string> = {
  relaxed: 'kade-space-relaxed',
  loose: 'kade-space-loose',
};

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function readKadeA11yPrefs(): KadeA11yPrefs {
  return {
    highContrast: readStored<boolean>(KADE_A11Y_STORAGE_KEYS.highContrast, false) === true,
    font: readStored<KadeA11yFont>(KADE_A11Y_STORAGE_KEYS.font, 'default'),
    spacing: readStored<KadeA11ySpacing>(KADE_A11Y_STORAGE_KEYS.spacing, 'default'),
  };
}

/**
 * Apply (or re-apply) the stored preferences as classes on <html>.
 * `overrides` lets a Settings control apply a just-picked value immediately,
 * without racing the Recoil localStorage effect.
 */
export function applyKadeA11yPrefs(overrides?: Partial<KadeA11yPrefs>): void {
  try {
    const prefs = { ...readKadeA11yPrefs(), ...overrides };
    const root = document.documentElement;

    root.classList.toggle('kade-hc', prefs.highContrast === true);

    Object.values(FONT_CLASSES).forEach((cls) => root.classList.remove(cls));
    if (prefs.font !== 'default' && FONT_CLASSES[prefs.font]) {
      root.classList.add(FONT_CLASSES[prefs.font]);
    }

    Object.values(SPACING_CLASSES).forEach((cls) => root.classList.remove(cls));
    if (prefs.spacing !== 'default' && SPACING_CLASSES[prefs.spacing]) {
      root.classList.add(SPACING_CLASSES[prefs.spacing]);
    }
  } catch {
    // fail-soft: display preferences must never break the app
  }
}
