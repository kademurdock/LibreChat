import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import { VoicePreviewButton } from '../Voices';

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ token: 'token' }),
}));

jest.mock('~/hooks/Audio/useVoiceCatalog', () => ({
  ...jest.requireActual('~/hooks/Audio/useVoiceCatalog'),
  useVoiceCatalog: () => ({ sample: 'A sample.', categories: [], tags: {} }),
}));

jest.mock('~/hooks/Audio/speech', () => ({
  ...jest.requireActual('~/hooks/Audio/speech'),
  speechAudioBlob: async (blob: Blob) => blob,
}));

describe('builder Preview speed', () => {
  const realFetch = globalThis.fetch;
  const realAudio = globalThis.Audio;
  const realCreate = URL.createObjectURL;

  beforeEach(() => {
    globalThis.fetch = jest.fn(
      async () => new Response(new Blob(['x'])),
    ) as unknown as typeof fetch;
    globalThis.Audio = jest.fn(() => {
      const element = document.createElement('audio');
      element.play = () => Promise.resolve();
      element.pause = () => {};
      element.load = () => {};
      return element;
    }) as unknown as typeof Audio;
    URL.createObjectURL = () => 'blob:x';
  });

  afterEach(() => {
    localStorage.clear();
    globalThis.fetch = realFetch;
    globalThis.Audio = realAudio;
    URL.createObjectURL = realCreate;
  });

  const sentSpeed = async (props: { speakingRate?: number; characterSpeedOnly?: boolean }) => {
    const { getByRole, unmount } = render(
      <RecoilRoot>
        <VoicePreviewButton voiceId="Voice 1" disabled={false} {...props} />
      </RecoilRoot>,
    );
    fireEvent.click(getByRole('button', { name: /Voice 1/ }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const calls = (globalThis.fetch as unknown as jest.Mock).mock.calls;
    const body = calls[calls.length - 1][1].body as FormData;
    unmount();
    return body.get('speed');
  };

  it("plays the character's number, not the listener's", async () => {
    localStorage.setItem('voicePacePreference', '1.5');
    await expect(sentSpeed({ speakingRate: 1.2, characterSpeedOnly: true })).resolves.toBe('1.2');
  });

  it('plays 1x for a new character with no speed, whatever the listener set', async () => {
    localStorage.setItem('voicePacePreference', '0.75');
    await expect(sentSpeed({ characterSpeedOnly: true })).resolves.toBe('1');
  });

  it("other pickers keep today's behavior: the listener's number wins", async () => {
    localStorage.setItem('voicePacePreference', '1.5');
    await expect(sentSpeed({ speakingRate: 1.2 })).resolves.toBe('1.5');
  });
});
