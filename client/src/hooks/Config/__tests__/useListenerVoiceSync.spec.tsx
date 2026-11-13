/* Sweep 5.2 (Nov 13 2026): voice speed and fillers follow another tab, and a change left pending
 * by one account is never sent to a different account signed in on the same browser. */
import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import useListenerVoiceSync from '../useListenerVoiceSync';
import store from '~/store';

const mockGet = jest.fn();
const mockPut = jest.fn();
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  request: {
    get: (...args: unknown[]) => mockGet(...args),
    put: (...args: unknown[]) => mockPut(...args),
  },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <RecoilRoot>{children}</RecoilRoot>
);
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
};
const useProbe = (uid: string) => {
  useListenerVoiceSync(true, uid);
  return {
    pace: useRecoilValue(store.voicePacePreference),
    fillers: useRecoilValue(store.voiceFillers),
  };
};
const otherTabSaved = (key: string, value: unknown) => {
  const newValue = JSON.stringify(value);
  localStorage.setItem(key, newValue); // the other tab's write is already in storage
  window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: localStorage }));
};

beforeEach(() => {
  localStorage.clear();
  mockGet.mockReset();
  mockPut.mockReset();
  mockPut.mockResolvedValue({ ok: true, listener: {} });
});

test('a speed or filler change made in another tab is followed here, and not pushed again', async () => {
  // The account already holds what this browser has seen: the sync itself applies nothing.
  mockGet.mockResolvedValue({
    listener: { pace: 1, paceAt: 't1', fillers: true, fillersAt: 't1' },
  });
  localStorage.setItem(
    'kadeVoiceSyncState',
    JSON.stringify({ seen: { pace: 't1', fillers: 't1' }, pending: {}, uid: 'amber' }),
  );
  const { result, unmount } = renderHook(() => useProbe('amber'), { wrapper });
  await settle();
  expect(result.current).toEqual({ pace: null, fillers: true });

  await act(async () => otherTabSaved('voicePacePreference', 1.3));
  await settle();
  expect(result.current.pace).toBe(1.3);
  await act(async () => otherTabSaved('voiceFillers', false));
  await settle();
  expect(result.current.fillers).toBe(false);
  expect(mockPut).not.toHaveBeenCalled(); // the tab that made the change sends it; this one only follows

  // Keys that are not voice settings, and values the website cannot use, change nothing.
  await act(async () => otherTabSaved('voicePacePreference', 9));
  await act(async () => otherTabSaved('automaticPlayback', true));
  await settle();
  expect(result.current).toEqual({ pace: 1.3, fillers: false });
  expect(mockPut).not.toHaveBeenCalled();
  unmount();
});

test('with the kadeVoiceSyncGuards undo switch off, another tab is not followed', async () => {
  localStorage.setItem('kadeVoiceSyncGuards', '0');
  mockGet.mockResolvedValue({ listener: {} });
  const { result, unmount } = renderHook(() => useProbe('amber'), { wrapper });
  await settle();
  await act(async () => otherTabSaved('voicePacePreference', 1.3));
  await settle();
  expect(result.current.pace).toBe(null);
  unmount();
});

test('a change left pending by one account is not sent to the next account on this browser', async () => {
  // The first account changed the speed while offline: saved here, still pending.
  localStorage.setItem('voicePacePreference', '1.4');
  localStorage.setItem(
    'kadeVoiceSyncState',
    JSON.stringify({ seen: { pace: 'a1' }, pending: { pace: true }, uid: 'amber' }),
  );
  // The second account has never chosen a speed.
  mockGet.mockResolvedValue({ listener: { delivery: {} } });
  const { unmount } = renderHook(() => useProbe('holly'), { wrapper });
  await settle();
  expect(mockGet).toHaveBeenCalledTimes(1);
  expect(mockPut).not.toHaveBeenCalled();
  const state = JSON.parse(localStorage.getItem('kadeVoiceSyncState') || '{}');
  expect(state.uid).toBe('holly');
  expect(state.pending).toEqual({});
  unmount();
});

test('the same account still sends its own pending change on the next sync', async () => {
  localStorage.setItem('voicePacePreference', '1.4');
  localStorage.setItem(
    'kadeVoiceSyncState',
    JSON.stringify({ seen: { pace: 'a1' }, pending: { pace: true }, uid: 'amber' }),
  );
  mockGet.mockResolvedValue({ listener: { pace: 1, paceAt: 'a1' } });
  mockPut.mockResolvedValue({ ok: true, listener: { pace: 1.4, paceAt: 'a2' } });
  const { unmount } = renderHook(() => useProbe('amber'), { wrapper });
  await settle();
  expect(mockPut).toHaveBeenCalledWith('/api/kade/voice-prefs', { pace: 1.4 });
  const state = JSON.parse(localStorage.getItem('kadeVoiceSyncState') || '{}');
  expect(state).toEqual({ seen: { pace: 'a2' }, pending: { pace: false }, uid: 'amber' });
  unmount();
});
