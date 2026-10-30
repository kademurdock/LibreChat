import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { RecoilRoot, useRecoilValue, useSetRecoilState } from 'recoil';
import {
  useAgentVoiceSync,
  saveAgentVoicePreference,
  AGENT_VOICES_KEY,
} from '../useAgentVoiceSync';
import store from '~/store';

let mockAgent: { tts?: { voiceId?: string; speakingRate?: number } } | undefined;

jest.mock('~/data-provider/Agents', () => ({
  useGetAgentByIdQuery: () => ({ data: mockAgent }),
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  request: { post: jest.fn(() => Promise.resolve()) },
}));

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <RecoilRoot>{children}</RecoilRoot>
);

function useHarness() {
  useAgentVoiceSync(0);
  return {
    speed: useRecoilValue(store.voiceSpeed),
    voice: useRecoilValue(store.voice),
    setVoice: useSetRecoilState(store.voice),
    setConversation: useSetRecoilState(store.conversationByIndex(0)),
  };
}

const conversationWith = (agent_id: string | null) =>
  ({ conversationId: 'c', agent_id }) as unknown as Parameters<
    ReturnType<typeof useHarness>['setConversation']
  >[0];

describe('useAgentVoiceSync speed rule', () => {
  afterEach(() => {
    localStorage.clear();
    mockAgent = undefined;
  });

  it("sets the character's speed while its builder voice is in use", () => {
    mockAgent = { tts: { voiceId: 'Builder', speakingRate: 1.2 } };
    const { result } = renderHook(useHarness, { wrapper: Wrapper });
    act(() => result.current.setConversation(conversationWith('agent_a')));
    expect(result.current.voice).toBe('Builder');
    expect(result.current.speed).toBe(1.2);
  });

  it('drops it for a listener who already picked their own voice', () => {
    mockAgent = { tts: { voiceId: 'Builder', speakingRate: 1.2 } };
    localStorage.setItem(AGENT_VOICES_KEY, JSON.stringify({ agent_a: 'Mine' }));
    const { result } = renderHook(useHarness, { wrapper: Wrapper });
    act(() => result.current.setConversation(conversationWith('agent_a')));
    expect(result.current.voice).toBe('Mine');
    expect(result.current.speed).toBeUndefined();
  });

  it('drops it the moment a listener picks in the header, and returns on picking the builder voice', () => {
    mockAgent = { tts: { voiceId: 'Builder', speakingRate: 1.2 } };
    const { result } = renderHook(useHarness, { wrapper: Wrapper });
    act(() => result.current.setConversation(conversationWith('agent_a')));
    expect(result.current.speed).toBe(1.2);

    act(() => {
      saveAgentVoicePreference('agent_a', 'Mine');
      result.current.setVoice('Mine');
    });
    expect(result.current.voice).toBe('Mine');
    expect(result.current.speed).toBeUndefined();

    act(() => {
      saveAgentVoicePreference('agent_a', 'Builder');
      result.current.setVoice('Builder');
    });
    expect(result.current.speed).toBe(1.2);
  });

  it('resets for a conversation with no agent', () => {
    mockAgent = { tts: { voiceId: 'Builder', speakingRate: 1.2 } };
    const { result } = renderHook(useHarness, { wrapper: Wrapper });
    act(() => result.current.setConversation(conversationWith('agent_a')));
    expect(result.current.speed).toBe(1.2);
    mockAgent = undefined;
    act(() => result.current.setConversation(conversationWith(null)));
    expect(result.current.speed).toBeUndefined();
  });

  it('does not fight a voice the speech hooks set', () => {
    mockAgent = { tts: { voiceId: 'Builder' } };
    const { result } = renderHook(useHarness, { wrapper: Wrapper });
    act(() => result.current.setConversation(conversationWith('agent_a')));
    act(() => result.current.setVoice('Snapped back'));
    expect(result.current.voice).toBe('Snapped back');
  });
});
