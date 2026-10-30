import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import type { MutableSnapshot } from 'recoil';
import type { TConversation } from 'librechat-data-provider';
import { ExternalVoiceDropdown } from '../Voices';
import store from '~/store';

/* Oct 30 2026: each sample in the header and Settings voice list plays at the speed that voice will
 * really play, whatever voice is in use right now. */

const mockAgent: { current?: { name: string; tts?: Record<string, unknown> } } = {};

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ token: 'token' }),
}));

jest.mock('~/hooks/Audio/useTTSExternal', () => ({
  __esModule: true,
  default: () => ({ voices: ['Builder', 'Other', 'Renamed label'] }),
}));

jest.mock('~/hooks/Audio/useVoiceCatalog', () => ({
  ...jest.requireActual('~/hooks/Audio/useVoiceCatalog'),
  useVoiceCatalog: () => ({
    audition: 'I am {voice}.',
    categories: [],
    tags: {},
    renames: { 'Old name': 'Renamed label' },
  }),
}));

jest.mock('~/data-provider/Agents', () => ({
  ...jest.requireActual('~/data-provider/Agents'),
  useGetAgentByIdQuery: () => ({ data: mockAgent.current }),
}));

describe('voice list audition speed', () => {
  const realFetch = globalThis.fetch;
  const realContext = window.AudioContext;

  beforeEach(() => {
    /* Opening the list moves focus to the current voice a frame later, which samples that voice. */
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(1),
    })) as unknown as typeof fetch;
    window.AudioContext = jest.fn(() => ({
      state: 'running',
      destination: {},
      close: async () => {},
      resume: async () => {},
      decodeAudioData: async () => ({}),
      createBufferSource: () => ({
        connect: () => {},
        disconnect: () => {},
        start: () => {},
        stop: () => {},
      }),
    })) as unknown as typeof AudioContext;
    mockAgent.current = { name: 'Ann', tts: { voiceId: 'Builder', speakingRate: 1.2 } };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
    globalThis.fetch = realFetch;
    window.AudioContext = realContext;
  });

  /** voiceSpeed is what useAgentVoiceSync leaves in the store for the voice in use. */
  const sampleSpeed = async (
    sampled: string,
    { voiceSpeed, agentId = 'agent_1' }: { voiceSpeed?: number; agentId?: string } = {},
  ) => {
    (globalThis.fetch as unknown as jest.Mock).mockClear();
    const { getByRole, getByLabelText, unmount } = render(
      <RecoilRoot
        initializeState={({ set }: MutableSnapshot) => {
          set(store.voiceSpeed, voiceSpeed);
          set(store.voice, 'Builder');
          set(store.conversationByIndex(0), {
            conversationId: 'c',
            agent_id: agentId,
          } as unknown as TConversation);
        }}
      >
        <ExternalVoiceDropdown />
      </RecoilRoot>,
    );
    fireEvent.click(getByLabelText(/Voice/, { selector: '#external-voice-opener' }));
    fireEvent.focus(getByRole('option', { name: sampled }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const calls = (globalThis.fetch as unknown as jest.Mock).mock.calls;
    const body = calls[calls.length - 1][1].body as FormData;
    unmount();
    expect(body.get('voice')).toBe(sampled);
    return body.get('speed');
  };

  it("plays another voice at 1x, not the character's number on the voice in use", async () => {
    await expect(sampleSpeed('Other', { voiceSpeed: 1.2 })).resolves.toBe('1');
  });

  it("plays another voice at the listener's number", async () => {
    localStorage.setItem('voicePacePreference', '0.9');
    await expect(sampleSpeed('Other', { voiceSpeed: 1.2 })).resolves.toBe('0.9');
  });

  it("plays the character's own builder voice at the character's number", async () => {
    await expect(sampleSpeed('Builder', { voiceSpeed: 1.2 })).resolves.toBe('1.2');
  });

  it("plays the builder voice at the character's number while the listener is on their own voice", async () => {
    await expect(sampleSpeed('Builder', { voiceSpeed: undefined })).resolves.toBe('1.2');
  });

  it("the listener's number beats the character's on the builder voice too", async () => {
    localStorage.setItem('voicePacePreference', '1.5');
    await expect(sampleSpeed('Builder', { voiceSpeed: 1.2 })).resolves.toBe('1.5');
  });

  it('plays a builder voice saved under an old name at the character number', async () => {
    mockAgent.current = { name: 'Ann', tts: { voiceId: 'Old name', speakingRate: 1.3 } };
    await expect(sampleSpeed('Renamed label', { voiceSpeed: 1.3 })).resolves.toBe('1.3');
    await expect(sampleSpeed('Other', { voiceSpeed: 1.3 })).resolves.toBe('1');
  });

  it('a character with a number but no builder voice plays every voice at 1x', async () => {
    mockAgent.current = { name: 'Ann', tts: { speakingRate: 1.3 } };
    await expect(sampleSpeed('Other')).resolves.toBe('1');
    await expect(sampleSpeed('Builder')).resolves.toBe('1');
  });

  it('with no character, plays at 1x', async () => {
    mockAgent.current = undefined;
    await expect(sampleSpeed('Other', { agentId: '' })).resolves.toBe('1');
  });
});
