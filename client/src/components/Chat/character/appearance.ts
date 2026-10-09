import {
  DELLA_ID,
  HARLEY_ID,
  KIANA_ID,
  LILLY_ID,
  LILLY_PUBLIC_ID,
  WITHERSPOON_ID,
  hasPreparedPortrait,
} from './portrait-rig.mjs';

const descriptions = new Map(
  Object.entries({
    [KIANA_ID]: 'com_ui_character_appearance_kiana',
    [DELLA_ID]: 'com_ui_character_appearance_della',
    [HARLEY_ID]: 'com_ui_character_appearance_harley',
    [LILLY_ID]: 'com_ui_character_appearance_lilly',
    [LILLY_PUBLIC_ID]: 'com_ui_character_appearance_lilly',
    [WITHERSPOON_ID]: 'com_ui_character_appearance_witherspoon',
  } as const),
);

export function characterAppearanceKey(id: string, path: string) {
  return hasPreparedPortrait(id, path) ? descriptions.get(id) : undefined;
}
