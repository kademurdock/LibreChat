import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { renderHook } from '@testing-library/react';
import store from '~/store';

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <RecoilRoot>{children}</RecoilRoot>
);

describe('listener voice pace preference', () => {
  afterEach(() => localStorage.clear());

  it('never reads a leftover playback-stretch value as a pace override', () => {
    for (const leftover of ['1', '2', '0', '0.1']) {
      localStorage.setItem('playbackRate', leftover);
      const { result, unmount } = renderHook(() => useRecoilValue(store.voicePacePreference), {
        wrapper: Wrapper,
      });
      expect(result.current).toBeNull();
      unmount();
    }
  });

  it('keeps a pace chosen under its own key', () => {
    localStorage.setItem('voicePacePreference', '0.9');
    const { result } = renderHook(() => useRecoilValue(store.voicePacePreference), {
      wrapper: Wrapper,
    });
    expect(result.current).toBe(0.9);
  });
});
