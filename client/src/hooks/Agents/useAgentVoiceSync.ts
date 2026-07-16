import { useEffect } from 'react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { useGetAgentByIdQuery } from '~/data-provider/Agents';
import { request } from 'librechat-data-provider';
import store from '~/store';

/** localStorage key for per-agent voice preferences (JSON map: agent_id → voice). */
export const AGENT_VOICES_KEY = 'kade:agent_voices';

function readAgentVoiceMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(AGENT_VOICES_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Persist a per-agent voice preference to localStorage.
 * Called from ExternalVoiceDropdown when the user picks a voice while an agent
 * is active in the primary conversation.
 */
export function saveAgentVoicePreference(agentId: string, voice: string): void {
  try {
    const map = readAgentVoiceMap();
    map[agentId] = voice;
    localStorage.setItem(AGENT_VOICES_KEY, JSON.stringify(map));
  } catch {
    // localStorage unavailable — fail silently
  }
  /**
   * KADE (July 2026): ALSO sync this pick to the SERVER per-user voice pref
   * (`/api/kade/voice-prefs`, model kadeVoicePref) so it carries to the PHONE
   * and web calls — the call ticket + phone lookup read that server row. Until
   * now the picker only wrote localStorage (in-app read-aloud), so a voice
   * chosen in the app never followed you onto a call. Fire-and-forget + fail-
   * soft: a sync hiccup never blocks the in-app voice change. request.post
   * carries auth via the shared axios interceptors.
   */
  if (agentId && voice) {
    try {
      void request.post('/api/kade/voice-prefs', { agentId, voice });
    } catch {
      // network/auth hiccup — the local pick still applied; phone sync will
      // catch up on the next pick.
    }
  }
}

/**
 * KADE July 16 2026: a voice change saved in the AGENT BUILDER is the editor's
 * freshest voice intent. If this user's own personal pick for that agent
 * (localStorage map + server kadeVoicePref row) disagrees with the voice they
 * just saved, drop the pick — otherwise the stale pick silently overrides the
 * new builder voice on web/phone calls (kadeWebVoice.js mints call tickets
 * personal-pick-first, by design, for everyone ELSE's sake) and on this
 * device's read-aloud. Live report that prompted this: builder set to
 * Voice 294; the web call still spoke the old personal pick, Voice 23.
 * Only ever runs for the editor's own account — other users' picks untouched.
 * Fail-soft everywhere: cleanup must never block or break the agent save.
 */
export function reconcileAgentVoicePreference(agentId: string, builderVoice?: string | null): void {
  if (!agentId || !builderVoice) {
    return;
  }
  let hadStaleLocal = false;
  try {
    const map = readAgentVoiceMap();
    const personal = map[agentId];
    if (personal != null && personal !== builderVoice) {
      hadStaleLocal = true;
      delete map[agentId];
      localStorage.setItem(AGENT_VOICES_KEY, JSON.stringify(map));
    }
  } catch {
    // localStorage unavailable — still try the server row below
  }
  /* The server row is ALSO cleared by the agent-update route itself when the
   * voice actually changes; this client POST additionally covers the re-save
   * self-heal case (builder voice unchanged but a stale local pick existed,
   * e.g. a device that picked before the server-side hook shipped). */
  if (hadStaleLocal) {
    try {
      void request.post('/api/kade/voice-prefs', { agentId, voice: null });
    } catch {
      // fail-soft: server hook and/or the next save will catch up
    }
  }
}

/**
 * ♿ D3 + D1/D2: Per-agent voices.
 *
 * Watches the active agent for the conversation at `index`. When the agent
 * changes, resolves which TTS voice to apply, in this order (2026-07-01):
 *
 *   1. The user's own per-agent override — the `kade:agent_voices`
 *      localStorage map, saved whenever they pick a voice while this agent
 *      is active. Kept on top: "I like this agent's default but want
 *      something else" stays a personal, per-device choice.
 *   2. The agent's own default — `agent.tts.voiceId`, the real backend field
 *      set in the agent builder (D1/D2).
 *   3. Neither set → leave store.voice alone, i.e. the user's global
 *      Settings → Speech voice stays in effect.
 *
 * Fail-soft note: if a resolved voice no longer exists in the live library,
 * the speech hooks' own reconciliation (useTTSExternal's voices effect)
 * snaps playback back to a valid voice — a stale saved voice can't break TTS.
 *
 * Mount once inside ChatView so it runs for the lifetime of a chat.
 */
export function useAgentVoiceSync(index: number = 0): void {
  const agentId = useRecoilValue(store.conversationAgentIdByIndex(index));
  const setVoice = useSetRecoilState(store.voice);
  const setVoiceSpeed = useSetRecoilState(store.voiceSpeed);
  /** D1/D2: the agent record (cached, VIEW-level) carries its default voice. */
  const { data: agent } = useGetAgentByIdQuery(agentId);

  useEffect(() => {
    if (!agentId) return;
    const personal = readAgentVoiceMap()[agentId]; // 1) personal override
    const agentDefault = agent?.tts?.voiceId; // 2) agent's own default
    const resolved = personal ?? agentDefault;
    if (resolved) {
      setVoice(resolved); // 3) neither -> untouched global default
    }
    // D2d: the agent's speaking rate — unlike voice this RESETS when the
    // incoming agent has none, so one agent's pace never bleeds into the next.
    const rate = agent?.tts?.speakingRate;
    setVoiceSpeed(typeof rate === 'number' ? rate : undefined);
  }, [agentId, agent?.tts?.voiceId, agent?.tts?.speakingRate, setVoice, setVoiceSpeed]);
}
