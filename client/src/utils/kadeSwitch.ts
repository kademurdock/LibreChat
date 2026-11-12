/**
 * Nov 12 2026 (platform audit): per-browser undo switches for the web fixes that change behaviour.
 * The web bundle cannot read the server's environment at run time, so each switch is a
 * localStorage key: set it to '0' in the browser console (localStorage.setItem('<key>', '0'))
 * and reload, and that one fix goes back to the old behaviour on that browser. Unset (the
 * default) keeps the fix on. Fail-soft: blocked storage means "on".
 */
export const KADE_SWITCHES = {
  /** WEB-2: the screen reader stays quiet while the reply voice reads a finished reply. */
  quietScreenReaderUnderVoice: 'kadeQuietUnderVoice',
  /** WEB-5: one reply voice at a time (a new one pauses the one that was speaking). */
  oneVoice: 'kadeOneVoice',
  /** WEB-12: pair %%% voice tags by shape, as the server and the voice proxy do. */
  balancedVoiceTags: 'kadeBalancedTags',
  /** WEB-13: reconnect a reply stream that closes without its end, or goes 45 s without a byte. */
  streamWatchdog: 'kadeStreamWatchdog',
  /** DESC-3: a Spotter picture waits while the call socket still holds about a frame. */
  frameGate: 'kadeFrameGate',
  /** DESC-11: skip Spotter pictures that barely differ from the last one sent. */
  stillFrameSkip: 'kadeStillFrames',
  /** GW-6 web half: with automatic read-aloud on, a chat request says kadeLive: true. */
  sendLive: 'kadeSendLive',
  /** Phase 3 A1: show the server's tool names (kade.toolLabels) for Kade tools. */
  toolLabels: 'kadeToolLabels',
  /** Decision 24: voice speed, fillers and delivery follow the account. */
  voiceSync: 'kadeVoiceSync',
} as const;

export type KadeSwitch = keyof typeof KADE_SWITCHES;

/** True unless this browser has the switch set to '0'. */
export function kadeSwitchOn(name: KadeSwitch): boolean {
  try {
    return globalThis.localStorage?.getItem(KADE_SWITCHES[name]) !== '0';
  } catch {
    return true;
  }
}
