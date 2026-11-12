import { kadeSwitchOn } from './kadeSwitch';

/**
 * Nov 12 2026 (gateway audit GW-6, website half). When automatic read-aloud is on, this browser will
 * speak the reply, so its chat request says `kadeLive: true`. The fork forwards that to the gateway as
 * `kade_live` (packages/api custom/initialize.ts, server switch KADE_SEND_LIVE=0 stops it), and the
 * gateway may then stream a turn it has proved does not think (its own switch KADE_SCREEN_LIVE, unset =
 * off, so nothing changes until the lead sets it to `asked`). Every other body stays byte-identical.
 *
 * Read from the same localStorage keys the Recoil atoms write (store/settings.ts: textToSpeech defaults
 * on, automaticPlayback defaults off), so the send path needs no Recoil root. Undo on one browser:
 * localStorage kadeSendLive = '0'.
 */
function storedBoolean(key: string, fallback: boolean): boolean {
  const raw = globalThis.localStorage?.getItem(key);
  if (raw == null) {
    return fallback;
  }
  return JSON.parse(raw) === true;
}

/** True when this browser will read the reply aloud by itself. */
export function readAloudOnInThisBrowser(): boolean {
  try {
    return storedBoolean('textToSpeech', true) && storedBoolean('automaticPlayback', false);
  } catch {
    return false;
  }
}

/** The fields to add to a chat request body: { kadeLive: true } or nothing. */
export function kadeLiveFields(): { kadeLive?: true } {
  return kadeSwitchOn('sendLive') && readAloudOnInThisBrowser() ? { kadeLive: true } : {};
}
