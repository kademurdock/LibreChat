import { useCallback, useEffect, useRef } from 'react';
import { useRecoilState, useSetRecoilState } from 'recoil';
import { request } from 'librechat-data-provider';
import { kadeSwitchOn } from '~/utils/kadeSwitch';
import {
  afterPush,
  hasSavedValue,
  planListenerSync,
  readSyncState,
  validPace,
  writeSyncState,
} from '~/utils/listenerVoiceSync';
import type { AccountListenerPrefs } from '~/utils/listenerVoiceSync';
import store from '~/store';

/** Refetch the account values when the tab comes back, at most this often. */
const REFRESH_MIN_MS = 60_000;

type PutReply = { ok?: boolean; listener?: AccountListenerPrefs };

/**
 * Nov 12 2026 (Kade's decision 24): the listener's voice speed, fillers and per-character delivery follow
 * her account across devices. The atoms in this browser stay the immediate source for speech; this hook
 * applies the account's values when they arrive (on sign-in and when the tab is shown again) and sends
 * this browser's changes up. Rules: utils/listenerVoiceSync.ts. Undo on one browser:
 * localStorage kadeVoiceSync = '0'.
 */
export default function useListenerVoiceSync(isAuthenticated: boolean) {
  const [pace, setPace] = useRecoilState(store.voicePacePreference);
  const [fillers, setFillers] = useRecoilState(store.voiceFillers);
  const setDelivery = useSetRecoilState(store.voiceDeliveryByAgent);

  const on = isAuthenticated && kadeSwitchOn('voiceSync');
  /** The values this hook last saw or applied; a different value in an atom is the listener's own change. */
  const known = useRef<{ pace: number | null; fillers: boolean } | null>(null);
  const current = useRef({ pace, fillers });
  current.current = { pace, fillers };
  const lastFetch = useRef(0);
  const inFlight = useRef(false);

  const push = useCallback(async (body: { pace?: number | null; fillers?: boolean }) => {
    if (!Object.keys(body).length) {
      return;
    }
    try {
      const reply = (await request.put('/api/kade/voice-prefs', body)) as PutReply;
      if (!reply?.ok || !reply.listener) {
        return;
      }
      // Clear pending only for a value this browser still holds; a newer change sends itself.
      const stillHeld: { pace?: unknown; fillers?: unknown } = {};
      if ('pace' in body && body.pace === current.current.pace) stillHeld.pace = body.pace;
      if ('fillers' in body && body.fillers === current.current.fillers) {
        stillHeld.fillers = body.fillers;
      }
      writeSyncState(afterPush(readSyncState(), stillHeld, reply.listener));
    } catch {
      /* offline or the server switch is off: the change stays pending here and goes on the next sync */
    }
  }, []);

  const sync = useCallback(async () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    lastFetch.current = Date.now();
    try {
      const reply = (await request.get('/api/kade/voice-prefs')) as {
        listener?: AccountListenerPrefs;
      };
      if (!reply || !reply.listener) {
        return; // older server, or KADE_LISTENER_PREFS=0: this browser keeps its own settings
      }
      const local = current.current;
      const plan = planListenerSync(
        reply.listener,
        {
          pace: local.pace,
          fillers: local.fillers,
          paceSaved: hasSavedValue('voicePacePreference'),
          fillersSaved: hasSavedValue('voiceFillers'),
        },
        readSyncState(),
      );
      const state = readSyncState();
      writeSyncState({ seen: plan.seen, pending: state.pending });
      if ('pace' in plan.apply && validPace(plan.apply.pace)) {
        const value = plan.apply.pace ?? null;
        known.current = { ...(known.current ?? local), pace: value };
        setPace(value);
      }
      if (typeof plan.apply.fillers === 'boolean') {
        const value = plan.apply.fillers;
        known.current = { ...(known.current ?? local), fillers: value };
        setFillers(value);
      }
      if (plan.apply.delivery) {
        setDelivery(plan.apply.delivery);
      }
      await push(plan.push);
    } catch {
      /* the account could not be read: speech goes on with this browser's values */
    } finally {
      inFlight.current = false;
    }
  }, [push, setPace, setFillers, setDelivery]);

  // The account's values, once signed in, and again when the tab is shown after a while.
  useEffect(() => {
    if (!on) {
      return;
    }
    void sync();
    const onVisible = () => {
      if (
        document.visibilityState === 'visible' &&
        Date.now() - lastFetch.current > REFRESH_MIN_MS
      ) {
        void sync();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [on, sync]);

  // The listener's own changes in this browser: saved here already by the atom, marked pending, sent up.
  useEffect(() => {
    if (!on) {
      known.current = null;
      return;
    }
    if (known.current == null) {
      known.current = { pace, fillers };
      return;
    }
    const body: { pace?: number | null; fillers?: boolean } = {};
    if (pace !== known.current.pace && validPace(pace ?? null)) {
      body.pace = pace ?? null;
    }
    if (fillers !== known.current.fillers && typeof fillers === 'boolean') {
      body.fillers = fillers;
    }
    known.current = { pace, fillers };
    if (!Object.keys(body).length) {
      return;
    }
    const state = readSyncState();
    writeSyncState({
      seen: state.seen,
      pending: {
        ...state.pending,
        ...('pace' in body ? { pace: true } : {}),
        ...('fillers' in body ? { fillers: true } : {}),
      },
    });
    void push(body);
  }, [on, pace, fillers, push]);
}
