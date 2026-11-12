/**
 * Nov 12 2026 (Kade's decision 24: voice speed, delivery and fillers are "Same on every device").
 *
 * The listener's own voice speed (`voicePacePreference`), filler switch (`voiceFillers`) and per-character
 * delivery (`voiceDeliveryByAgent`) now follow the account through GET/PUT /api/kade/voice-prefs
 * (server: api/server/services/kadeListenerPrefs.js). Speech never waits on that: the values in this
 * browser are what every request uses, at once. This file only decides what to do when the account's
 * values arrive.
 *
 * Per field, with the stamps the server sets on every write:
 * - A change made here is saved here first and marked pending, then sent. While pending, this browser's
 *   value wins and is sent again on the next sync.
 * - Otherwise, an account stamp this browser has not seen means another device changed it: apply it.
 * - The account never had the field and this browser has its own saved choice: send it up (seed).
 *   A browser that never chose anything sends nothing, so it can never overwrite a phone's choice
 *   with a default.
 *
 * Delivery is read-only on the website (it has no delivery control yet); it is applied whenever the
 * account's delivery stamp changes.
 *
 * Undo on one browser: localStorage.setItem('kadeVoiceSync', '0'); the server switch is
 * KADE_LISTENER_PREFS=0.
 */

export type DeliveryMode = 'STABLE' | 'BALANCED' | 'CREATIVE';

export interface AccountListenerPrefs {
  pace?: number | null;
  paceAt?: string;
  fillers?: boolean;
  fillersAt?: string;
  delivery?: Record<string, string>;
  deliveryAt?: string;
}

export interface ListenerSyncState {
  /** The last account stamp this browser applied or wrote, per field. */
  seen: { pace?: string; fillers?: string; delivery?: string };
  /** A change made here that the account has not taken yet. */
  pending: { pace?: boolean; fillers?: boolean };
}

export interface LocalListenerValues {
  pace: number | null;
  fillers: boolean;
  /** True when this browser holds its own saved choice (the localStorage key exists). */
  paceSaved: boolean;
  fillersSaved: boolean;
}

export interface SyncPlan {
  apply: { pace?: number | null; fillers?: boolean; delivery?: Record<string, DeliveryMode> };
  push: { pace?: number | null; fillers?: boolean };
  seen: ListenerSyncState['seen'];
}

export const LISTENER_SYNC_STATE_KEY = 'kadeVoiceSyncState';
export const DELIVERY_BY_AGENT_KEY = 'voiceDeliveryByAgent';
const DELIVERY_MODES = new Set(['STABLE', 'BALANCED', 'CREATIVE']);

export function emptySyncState(): ListenerSyncState {
  return { seen: {}, pending: {} };
}

export function readSyncState(): ListenerSyncState {
  try {
    const raw = globalThis.localStorage?.getItem(LISTENER_SYNC_STATE_KEY);
    if (!raw) {
      return emptySyncState();
    }
    const parsed = JSON.parse(raw) as Partial<ListenerSyncState>;
    return {
      seen: parsed && typeof parsed.seen === 'object' && parsed.seen ? parsed.seen : {},
      pending: parsed && typeof parsed.pending === 'object' && parsed.pending ? parsed.pending : {},
    };
  } catch {
    return emptySyncState();
  }
}

export function writeSyncState(state: ListenerSyncState): void {
  try {
    globalThis.localStorage?.setItem(LISTENER_SYNC_STATE_KEY, JSON.stringify(state));
  } catch {
    /* storage blocked: the next sync starts fresh, which is safe */
  }
}

/** True when this browser holds its own saved value under `key`. */
export function hasSavedValue(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) != null;
  } catch {
    return false;
  }
}

/** A pace the website can use: a finite number in 0.5..1.5, or null for the character's speed. */
export function validPace(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 1.5)
  );
}

export function cleanDelivery(map: unknown): Record<string, DeliveryMode> {
  const out: Record<string, DeliveryMode> = {};
  if (!map || typeof map !== 'object') {
    return out;
  }
  for (const [agentId, mode] of Object.entries(map as Record<string, unknown>)) {
    if (
      /^[A-Za-z0-9_-]{1,64}$/.test(agentId) &&
      typeof mode === 'string' &&
      DELIVERY_MODES.has(mode)
    ) {
      out[agentId] = mode as DeliveryMode;
    }
  }
  return out;
}

/** What to do with the account's values. Pure; the hook carries it out. */
export function planListenerSync(
  account: AccountListenerPrefs | null | undefined,
  local: LocalListenerValues,
  state: ListenerSyncState,
): SyncPlan {
  const plan: SyncPlan = { apply: {}, push: {}, seen: { ...state.seen } };
  if (!account || typeof account !== 'object') {
    return plan;
  }

  // Pace
  if (state.pending.pace) {
    plan.push.pace = local.pace;
  } else if (account.paceAt && validPace(account.pace ?? null)) {
    if (account.paceAt !== state.seen.pace) {
      const value = account.pace ?? null;
      if (value !== local.pace) {
        plan.apply.pace = value;
      }
      plan.seen.pace = account.paceAt;
    }
  } else if (!account.paceAt && local.paceSaved && !state.seen.pace && validPace(local.pace)) {
    plan.push.pace = local.pace;
  }

  // Fillers
  if (state.pending.fillers) {
    plan.push.fillers = local.fillers;
  } else if (account.fillersAt && typeof account.fillers === 'boolean') {
    if (account.fillersAt !== state.seen.fillers) {
      if (account.fillers !== local.fillers) {
        plan.apply.fillers = account.fillers;
      }
      plan.seen.fillers = account.fillersAt;
    }
  } else if (!account.fillersAt && local.fillersSaved && !state.seen.fillers) {
    plan.push.fillers = local.fillers;
  }

  // Delivery (read-only here)
  if (account.deliveryAt && account.deliveryAt !== state.seen.delivery) {
    plan.apply.delivery = cleanDelivery(account.delivery);
    plan.seen.delivery = account.deliveryAt;
  }

  return plan;
}

/** After the account took a write: remember its stamps and clear what is no longer pending. */
export function afterPush(
  state: ListenerSyncState,
  sent: { pace?: unknown; fillers?: unknown },
  account: AccountListenerPrefs | null | undefined,
): ListenerSyncState {
  const next: ListenerSyncState = { seen: { ...state.seen }, pending: { ...state.pending } };
  if ('pace' in sent && account?.paceAt) {
    next.seen.pace = account.paceAt;
    next.pending.pace = false;
  }
  if ('fillers' in sent && account?.fillersAt) {
    next.seen.fillers = account.fillersAt;
    next.pending.fillers = false;
  }
  return next;
}
