import { useEffect, useRef } from 'react';
import { useRecoilValue } from 'recoil';
import store from '~/store';

// Bridge lives outside this app; same URL the fork's KadeNotify tool posts to.
const BRIDGE_URL = 'https://kade-ai-bridge-production.up.railway.app';

declare global {
  interface Window {
    Capacitor?: { isNativePlatform?: () => boolean };
    __kadeaiPushToken?: string;
  }
}

function isKadeAiNativeShell(): boolean {
  // The Kade-AI iOS app (kade-ai-app) wraps this exact site in a Capacitor
  // WKWebView via capacitor.config.json's server.url — Capacitor injects its
  // native bridge (window.Capacitor) into whatever page loads, remote or not,
  // so this is true only when we're actually running inside that native shell,
  // never in a plain desktop/mobile browser tab.
  return typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();
}

async function registerPushToken(token: string, userId: string) {
  try {
    await fetch(`${BRIDGE_URL}/push-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, userId, platform: 'ios' }),
    });
  } catch {
    // Best-effort — native's own /push-register call (token only, no userId)
    // already ran as a fallback, so notifications still work either way; this
    // call only upgrades that registration with the userId link.
  }
}

/**
 * Links this device's APNs push token to the logged-in Kade-AI user, so
 * agent-initiated notifications and scheduled check-ins (kade_notify) reach
 * only this person's phone instead of every registered device.
 *
 * AppDelegate.swift (kade-ai-app) hands the raw token to this webview once
 * obtained — via window.__kadeaiPushToken and a 'kadeai:pushtoken' event,
 * since the native layer never learns who is logged in. This component is the
 * other half: it already knows the user (from auth state) and owns the actual
 * POST to the bridge. No-ops entirely outside the native app.
 *
 * See NOTIFY_AGENT_TOOL_DONE_2026-07-15.md for the full design + why this
 * split (native -> JS handoff, JS -> bridge call) was chosen over the
 * alternative (JS -> native via a custom Capacitor plugin).
 */
const PushTokenRegistrar = () => {
  const user = useRecoilValue(store.user);
  const sentKeyRef = useRef<string>('');

  useEffect(() => {
    if (!isKadeAiNativeShell() || !user?.id) {
      return;
    }

    const tryRegister = (token?: string) => {
      if (!token) {
        return;
      }
      const key = `${token}:${user.id}`;
      if (sentKeyRef.current === key) {
        return; // already registered this exact token+user pairing this session
      }
      sentKeyRef.current = key;
      registerPushToken(token, user.id as string);
    };

    // Native may have set this before this component ever mounted (its
    // evaluateJavaScript call doesn't wait for React), so check immediately...
    tryRegister(window.__kadeaiPushToken);

    // ...and also listen for it arriving later (permission prompt still
    // pending, slow APNs round trip, etc).
    const onToken = (e: Event) => tryRegister((e as CustomEvent<string>).detail);
    window.addEventListener('kadeai:pushtoken', onToken);
    return () => window.removeEventListener('kadeai:pushtoken', onToken);
  }, [user?.id]);

  return null;
};

export default PushTokenRegistrar;
