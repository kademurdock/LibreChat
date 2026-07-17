import { Component, useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { Camera } from 'lucide-react';
import { TooltipAnchor } from '@librechat/client';

/**
 * KADE (July 17 2026): Scan Mode — a header button that opens the NATIVE
 * on-device camera text reader (Apple Vision framework OCR + system speech,
 * nothing uploaded, zero ongoing cost, works offline). See
 * kade-ai-app/ios/App/App/KadeScanTextPlugin.swift + capacitor.config.json's
 * ios.packageClassList for the native half.
 *
 * Native-app-only by construction, not a feature flag: `window.Capacitor` is
 * only ever injected when this page is loaded inside the Capacitor/iOS
 * shell, so on the plain website (or an old app build without the plugin)
 * this button simply never renders — nothing to configure, nothing that can
 * show a dead button on the web.
 *
 * Same defensive shape as VoiceSpeedControl in this folder: local error
 * boundary so a render hiccup hides the button instead of ever taking down
 * the chat header, and the native call itself is wrapped try/catch so a
 * missing plugin (e.g. a not-yet-updated app install) fails silently instead
 * of throwing into the chat UI.
 */
class SafeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    /* swallow: the button hides, the header (and the whole chat) stays up. */
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

type KadeScanTextPlugin = { start: () => Promise<void>; stop: () => Promise<void> };
declare global {
  interface Window {
    Capacitor?: {
      isNativePlatform?: () => boolean;
      Plugins?: { KadeScanText?: KadeScanTextPlugin };
    };
  }
}

function isNativeScanAvailable(): boolean {
  try {
    return (
      window.Capacitor?.isNativePlatform?.() === true &&
      typeof window.Capacitor?.Plugins?.KadeScanText?.start === 'function'
    );
  } catch {
    return false;
  }
}

function ScanModeButtonInner() {
  // Computed once — Capacitor's native bridge is injected before the page's
  // own scripts run, so this is already accurate on first render; no need
  // to re-check on every render.
  const [available] = useState(isNativeScanAvailable);

  const handleClick = useCallback(() => {
    try {
      window.Capacitor?.Plugins?.KadeScanText?.start?.();
    } catch {
      /* fail-soft: nothing to do if the native call itself throws */
    }
  }, []);

  if (!available) {
    return null;
  }

  return (
    <TooltipAnchor
      description="Scan Mode — point the camera at text and hear it read aloud"
      side="bottom"
      render={
        <button
          type="button"
          onClick={handleClick}
          aria-label="Scan Mode — point the camera at text and hear it read aloud"
          className="inline-flex size-9 flex-shrink-0 items-center justify-center rounded-xl border border-border-light bg-presentation text-text-primary transition-all ease-in-out hover:bg-surface-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Camera className="icon-md" aria-hidden={true} />
        </button>
      }
    />
  );
}

export default function ScanModeButton() {
  return (
    <SafeBoundary>
      <ScanModeButtonInner />
    </SafeBoundary>
  );
}
