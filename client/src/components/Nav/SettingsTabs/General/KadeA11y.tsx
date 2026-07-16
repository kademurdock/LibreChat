import { useCallback, useContext } from 'react';
import { useRecoilState } from 'recoil';
import { Dropdown, ThemeContext } from '@librechat/client';
import { useLocalize } from '~/hooks';
import ToggleSwitch from '../ToggleSwitch';
import { applyKadeA11yPrefs } from '~/utils/kadeA11yPrefs';
import type { KadeA11yFont, KadeA11ySpacing } from '~/utils/kadeA11yPrefs';
import store from '~/store';

/**
 * KADE July 16 2026 — Settings › General › Accessibility controls for the
 * low-vision display preferences (see utils/kadeA11yPrefs.ts). Each control
 * writes its Recoil atom (persisted to localStorage by the atom effect) AND
 * immediately re-applies the <html> classes so the change is instant.
 */

export function KadeHighContrastToggle() {
  const { setTheme } = useContext(ThemeContext);

  const onCheckedChange = useCallback(
    (value: boolean) => {
      applyKadeA11yPrefs({ highContrast: value });
      if (value) {
        // True-black palette rides the dark theme's variables — make sure it's on.
        try {
          setTheme('dark');
        } catch {
          // fail-soft: contrast class still applies on its own
        }
      }
    },
    [setTheme],
  );

  return (
    <ToggleSwitch
      stateAtom={store.kadeA11yHighContrast}
      localizationKey="com_nav_kade_high_contrast"
      hoverCardText="com_nav_info_kade_high_contrast"
      switchId="kadeA11yHighContrast"
      onCheckedChange={onCheckedChange}
    />
  );
}

export function KadeFontSelector() {
  const localize = useLocalize();
  const [font, setFont] = useRecoilState(store.kadeA11yFont);

  const onChange = useCallback(
    (value: string) => {
      const next = (value || 'default') as KadeA11yFont;
      setFont(next);
      applyKadeA11yPrefs({ font: next });
    },
    [setFont],
  );

  const options = [
    { value: 'default', label: localize('com_nav_kade_font_default') },
    { value: 'lexend', label: localize('com_nav_kade_font_lexend') },
    { value: 'opendyslexic', label: localize('com_nav_kade_font_opendyslexic') },
  ];

  const labelId = 'kade-a11y-font-label';

  return (
    <div className="flex items-center justify-between">
      <div id={labelId}>{localize('com_nav_kade_easy_font')}</div>
      <Dropdown
        value={font}
        onChange={onChange}
        options={options}
        sizeClasses="w-[220px]"
        testId="kade-a11y-font-selector"
        className="z-50"
        aria-labelledby={labelId}
      />
    </div>
  );
}

export function KadeLineSpacingSelector() {
  const localize = useLocalize();
  const [spacing, setSpacing] = useRecoilState(store.kadeA11yLineSpacing);

  const onChange = useCallback(
    (value: string) => {
      const next = (value || 'default') as KadeA11ySpacing;
      setSpacing(next);
      applyKadeA11yPrefs({ spacing: next });
    },
    [setSpacing],
  );

  const options = [
    { value: 'default', label: localize('com_nav_kade_spacing_default') },
    { value: 'relaxed', label: localize('com_nav_kade_spacing_relaxed') },
    { value: 'loose', label: localize('com_nav_kade_spacing_loose') },
  ];

  const labelId = 'kade-a11y-spacing-label';

  return (
    <div className="flex items-center justify-between">
      <div id={labelId}>{localize('com_nav_kade_line_spacing')}</div>
      <Dropdown
        value={spacing}
        onChange={onChange}
        options={options}
        sizeClasses="w-[220px]"
        testId="kade-a11y-spacing-selector"
        className="z-50"
        aria-labelledby={labelId}
      />
    </div>
  );
}
