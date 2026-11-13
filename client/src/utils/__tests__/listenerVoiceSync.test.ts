import {
  afterPush,
  cleanDelivery,
  emptySyncState,
  parseStoredVoiceValue,
  planListenerSync,
  readSyncState,
  stateForAccount,
  validPace,
  writeSyncState,
} from '../listenerVoiceSync';
import { deliveryFor, voiceCacheKey } from '../voicePace';
import { kadeLiveFields, readAloudOnInThisBrowser } from '../kadeLive';

const local = (over: Partial<Parameters<typeof planListenerSync>[1]> = {}) => ({
  pace: null,
  fillers: true,
  paceSaved: false,
  fillersSaved: false,
  ...over,
});

describe('planListenerSync (decision 24)', () => {
  it('applies a value another device saved', () => {
    const plan = planListenerSync(
      { pace: 1.2, paceAt: 't1', fillers: false, fillersAt: 't2', delivery: {} },
      local(),
      emptySyncState(),
    );
    expect(plan.apply).toEqual({ pace: 1.2, fillers: false });
    expect(plan.push).toEqual({});
    expect(plan.seen).toEqual({ pace: 't1', fillers: 't2' });
  });

  it('does nothing for a stamp this browser has already seen', () => {
    const plan = planListenerSync(
      { pace: 1.2, paceAt: 't1' },
      local({ pace: 0.9, paceSaved: true }),
      { seen: { pace: 't1' }, pending: {} },
    );
    expect(plan.apply).toEqual({});
    expect(plan.push).toEqual({});
  });

  it('a pending change made here wins and is sent again', () => {
    const plan = planListenerSync(
      { pace: 1.2, paceAt: 't9', fillers: true, fillersAt: 't9' },
      local({ pace: 0.8, fillers: false, paceSaved: true, fillersSaved: true }),
      { seen: { pace: 't1' }, pending: { pace: true, fillers: true } },
    );
    expect(plan.apply).toEqual({});
    expect(plan.push).toEqual({ pace: 0.8, fillers: false });
  });

  it('seeds the account only from a choice this browser really saved', () => {
    const empty = { delivery: {} };
    expect(planListenerSync(empty, local(), emptySyncState()).push).toEqual({});
    expect(
      planListenerSync(
        empty,
        local({ pace: 1.1, paceSaved: true, fillers: false, fillersSaved: true }),
        emptySyncState(),
      ).push,
    ).toEqual({ pace: 1.1, fillers: false });
  });

  it("null pace is the character's own speed and is applied as such", () => {
    const plan = planListenerSync(
      { pace: null, paceAt: 't1' },
      local({ pace: 1.3 }),
      emptySyncState(),
    );
    expect(plan.apply).toEqual({ pace: null });
  });

  it('ignores a pace the website cannot use', () => {
    const plan = planListenerSync({ pace: 4, paceAt: 't1' }, local(), emptySyncState());
    expect(plan.apply).toEqual({});
  });

  it('delivery is applied whenever its stamp changes, cleaned', () => {
    const plan = planListenerSync(
      { delivery: { agent_a: 'STABLE', agent_b: 'LOUD', 'x.y': 'STABLE' }, deliveryAt: 'd1' },
      local(),
      emptySyncState(),
    );
    expect(plan.apply.delivery).toEqual({ agent_a: 'STABLE' });
    expect(plan.seen.delivery).toBe('d1');
    expect(
      planListenerSync({ delivery: {}, deliveryAt: 'd1' }, local(), {
        seen: { delivery: 'd1' },
        pending: {},
      }).apply,
    ).toEqual({});
  });

  it('a missing or odd reply changes nothing', () => {
    expect(planListenerSync(undefined, local(), emptySyncState())).toEqual({
      apply: {},
      push: {},
      seen: {},
    });
  });

  it('afterPush records the stamps and clears pending for what was taken', () => {
    const next = afterPush(
      { seen: {}, pending: { pace: true, fillers: true } },
      { pace: 1.2 },
      { pace: 1.2, paceAt: 't5', fillers: true, fillersAt: 't6' },
    );
    expect(next).toEqual({ seen: { pace: 't5' }, pending: { pace: false, fillers: true } });
  });

  it('state survives a round trip through storage and a bad value', () => {
    localStorage.clear();
    expect(readSyncState()).toEqual(emptySyncState());
    writeSyncState({ seen: { pace: 'a' }, pending: { fillers: true } });
    expect(readSyncState()).toEqual({ seen: { pace: 'a' }, pending: { fillers: true } });
    localStorage.setItem('kadeVoiceSyncState', '{nope');
    expect(readSyncState()).toEqual(emptySyncState());
  });

  /* Sweep 5.2 (Nov 13 2026): the state belongs to one account; another account never inherits it. */
  it('a pending change left by another account is dropped, and that browser never seeds the new account', () => {
    localStorage.clear();
    writeSyncState({ seen: { pace: 'a1' }, pending: { pace: true } }, 'amber');
    expect(readSyncState('amber')).toEqual({
      seen: { pace: 'a1' },
      pending: { pace: true },
      uid: 'amber',
    });
    const other = readSyncState('holly');
    expect(other).toEqual({ seen: {}, pending: {}, uid: 'holly', noSeed: true });
    // The first account's speed is still in this browser's storage; the second account never had one.
    const plan = planListenerSync(
      { delivery: {} },
      local({ pace: 1.4, paceSaved: true, fillers: false, fillersSaved: true }),
      other,
    );
    expect(plan.push).toEqual({});
    expect(plan.apply).toEqual({});
    // The second account's own values still arrive, and its own change here is still sent.
    expect(
      planListenerSync({ pace: 0.9, paceAt: 'h1' }, local({ pace: 1.4, paceSaved: true }), other)
        .apply,
    ).toEqual({ pace: 0.9 });
    expect(
      planListenerSync({ delivery: {} }, local({ pace: 1.1, paceSaved: true }), {
        ...other,
        pending: { pace: true },
      }).push,
    ).toEqual({ pace: 1.1 });
    // noSeed stays with the state through a write and a push.
    writeSyncState(other, 'holly');
    expect(readSyncState('holly').noSeed).toBe(true);
    expect(afterPush(other, { pace: 1.1 }, { pace: 1.1, paceAt: 'h2' })).toEqual({
      seen: { pace: 'h2' },
      pending: { pace: false },
      uid: 'holly',
      noSeed: true,
    });
  });

  it('a state from before the fix keeps its stamps but not its pending change', () => {
    localStorage.clear();
    writeSyncState({ seen: { pace: 'a1', fillers: 'a2' }, pending: { pace: true } });
    expect(readSyncState('amber')).toEqual({
      seen: { pace: 'a1', fillers: 'a2' },
      pending: {},
      uid: 'amber',
    });
    expect(readSyncState()).toEqual({
      seen: { pace: 'a1', fillers: 'a2' },
      pending: { pace: true },
    });
  });

  it('the kadeVoiceSyncGuards undo switch uses the state as stored, whoever wrote it', () => {
    localStorage.clear();
    writeSyncState({ seen: {}, pending: { pace: true } }, 'amber');
    localStorage.setItem('kadeVoiceSyncGuards', '0');
    expect(readSyncState('holly').pending).toEqual({ pace: true });
    expect(
      stateForAccount({ seen: {}, pending: { pace: true }, uid: 'amber' }, 'holly').pending,
    ).toEqual({ pace: true });
    localStorage.removeItem('kadeVoiceSyncGuards');
  });

  it('parseStoredVoiceValue reads what another tab saved', () => {
    expect(parseStoredVoiceValue('voicePacePreference', '1.2')).toEqual({ pace: 1.2 });
    expect(parseStoredVoiceValue('voicePacePreference', 'null')).toEqual({ pace: null });
    expect(parseStoredVoiceValue('voicePacePreference', null)).toEqual({ pace: null });
    expect(parseStoredVoiceValue('voicePacePreference', '9')).toBeUndefined();
    expect(parseStoredVoiceValue('voicePacePreference', '{nope')).toBeUndefined();
    expect(parseStoredVoiceValue('voiceFillers', 'false')).toEqual({ fillers: false });
    expect(parseStoredVoiceValue('voiceFillers', null)).toEqual({ fillers: true });
    expect(parseStoredVoiceValue('voiceFillers', '"yes"')).toBeUndefined();
    expect(parseStoredVoiceValue('voice', '"x"')).toBeUndefined();
  });

  it('validPace and cleanDelivery', () => {
    expect(validPace(null)).toBe(true);
    expect(validPace(1.5)).toBe(true);
    expect(validPace(0.4)).toBe(false);
    expect(validPace(Number.NaN)).toBe(false);
    expect(validPace(undefined)).toBe(false);
    expect(cleanDelivery(null)).toEqual({});
  });
});

describe('delivery on speech requests', () => {
  it('deliveryFor answers only a known mode for that character', () => {
    expect(deliveryFor({ agent_a: 'BALANCED' }, 'agent_a')).toBe('BALANCED');
    expect(deliveryFor({ agent_a: 'LOUD' }, 'agent_a')).toBeUndefined();
    expect(deliveryFor({ agent_a: 'BALANCED' }, null)).toBeUndefined();
    expect(deliveryFor(undefined, 'agent_a')).toBeUndefined();
    localStorage.setItem('kadeVoiceSync', '0');
    expect(deliveryFor({ agent_a: 'BALANCED' }, 'agent_a')).toBeUndefined();
    localStorage.removeItem('kadeVoiceSync');
  });

  it('the cache key changes with delivery and is unchanged without it', () => {
    const plain = voiceCacheKey('words', 'Voice 1', 1, true);
    expect(voiceCacheKey('words', 'Voice 1', 1, true, undefined)).toBe(plain);
    expect(voiceCacheKey('words', 'Voice 1', 1, true, 'STABLE')).not.toBe(plain);
    expect(plain).not.toContain('delivery');
  });
});

describe('kadeLive (GW-6 web half)', () => {
  beforeEach(() => localStorage.clear());

  it('is sent only when automatic read-aloud is on', () => {
    expect(readAloudOnInThisBrowser()).toBe(false);
    expect(kadeLiveFields()).toEqual({});
    localStorage.setItem('automaticPlayback', 'true');
    expect(kadeLiveFields()).toEqual({ kadeLive: true });
    localStorage.setItem('textToSpeech', 'false');
    expect(kadeLiveFields()).toEqual({});
  });

  it("the browser switch kadeSendLive = '0' stops it", () => {
    localStorage.setItem('automaticPlayback', 'true');
    localStorage.setItem('kadeSendLive', '0');
    expect(kadeLiveFields()).toEqual({});
  });

  it('a bad stored value means off', () => {
    localStorage.setItem('automaticPlayback', '{bad');
    expect(kadeLiveFields()).toEqual({});
  });
});
