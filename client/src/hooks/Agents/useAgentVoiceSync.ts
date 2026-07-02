import { useEffect } from 'react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { useGetAgentByIdQuery } from '~/data-provider/Agents';
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
  }, [agentId, agent?.tts?.voiceId, setVoice]);
}
