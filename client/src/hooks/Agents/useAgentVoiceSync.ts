import { useEffect } from 'react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
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
 * ♿ D3: Per-agent default voices.
 *
 * Watches the active agent for the conversation at `index`. When the agent
 * changes, looks up any saved voice preference in localStorage and applies it
 * to store.voice (the global TTS voice atom). If no saved preference exists
 * for the incoming agent, the current voice is left unchanged so the user's
 * last manual selection persists.
 *
 * Mount once inside ChatView so it runs for the lifetime of a chat.
 */
export function useAgentVoiceSync(index: number = 0): void {
  const agentId = useRecoilValue(store.conversationAgentIdByIndex(index));
  const setVoice = useSetRecoilState(store.voice);

  useEffect(() => {
    if (!agentId) return;
    const saved = readAgentVoiceMap()[agentId];
    if (saved) {
      setVoice(saved);
    }
  }, [agentId, setVoice]);
}
