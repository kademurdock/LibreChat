import {
  afterPush,
  cleanDelivery,
  emptySyncState,
  planListenerSync,
  readSyncState,
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
      planListenerSync(empty, local({ pace: 1.1, paceSaved: true, fillers: false, fillersSaved: true }), emptySyncState())
        .push,
    ).toEqual({ pace: 1.1, fillers: false });
  });

  it("null pace is the character's own speed and is applied as such", () => {
    const plan = planListenerSync({ pace: null, paceAt: 't1' }, local({ pace: 1.3 }), emptySyncState());
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
      planListenerSync({ delivery: {}, deliveryAt: 'd1' }, local(), { seen: { delivery: 'd1' }, pending: {} })
        .apply,
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
