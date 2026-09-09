import { useSyncExternalStore } from 'react';
const KEY = 'kadeVoicePortraits';
const CHANGE = 'kade-voice-portrait-preference';
let fallback = true;
function read() {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return fallback;
  }
}
function subscribe(listener: () => void) {
  window.addEventListener('storage', listener);
  window.addEventListener(CHANGE, listener);
  return () => {
    window.removeEventListener('storage', listener);
    window.removeEventListener(CHANGE, listener);
  };
}
export function useVoicePortraitPreference(): [boolean, (value: boolean) => void] {
  return [
    useSyncExternalStore(subscribe, read),
    (value) => {
      fallback = value;
      try {
        localStorage.setItem(KEY, value ? '1' : '0');
      } catch {
        /* unavailable storage */
      }
      window.dispatchEvent(new Event(CHANGE));
    },
  ];
}
