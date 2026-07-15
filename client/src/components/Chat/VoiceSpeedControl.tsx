import { Component, useRef } from 'react';
import type { ReactNode } from 'react';
import { useRecoilValue } from 'recoil';
import * as Ariakit from '@ariakit/react';
import { Volume2 } from 'lucide-react';
import { TooltipAnchor } from '@librechat/client';
import VoiceDropdown from '~/components/Nav/SettingsTabs/Speech/TTS/VoiceDropdown';
import PlaybackRate from '~/components/Nav/SettingsTabs/Speech/TTS/PlaybackRate';
import store from '~/store';

/**
 * KADE (July 2026): the voice picker + read-aloud speed, RIGHT IN THE
 * CONVERSATION header instead of buried in Settings → Speech. Kade's ask:
 * "change that voice in the conversation of whatever character you're having,
 * and that voice change carries over on the phone."
 *
 * - Voice pick reuses the exact Settings dropdown (VoiceDropdown → the
 *   accessible ExternalVoiceDropdown), which saves the per-agent voice. That
 *   save now ALSO syncs to the server pref (see useAgentVoiceSync), so the
 *   choice follows this character onto phone + web calls.
 * - Speed reuses the Settings PlaybackRate slider — read-aloud only (Kade's
 *   call: rate stays an in-app listening setting, not carried to calls).
 *
 * Screen-reader-first + built on the SAME Ariakit popover pattern as the
 * TokenUsage indicator (store + portal + finalFocus). PORTALED so the header's
 * horizontal scroll can't clip it. Only shown for agent conversations with
 * read-aloud on. Wrapped in a local error boundary so — since this reuses a
 * component authored for the Settings dialog — any render hiccup makes the
 * control quietly disappear instead of ever taking down the chat header.
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
    /* swallow: the control hides, the header (and the whole chat) stays up. */
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function VoiceSpeedControlInner() {
  const textToSpeech = useRecoilValue(store.textToSpeech);
  const agentId = useRecoilValue(store.conversationAgentIdByIndex(0));
  const disclosureRef = useRef<HTMLButtonElement>(null);
  const popover = Ariakit.usePopoverStore();

  if (!textToSpeech || !agentId) {
    return null;
  }

  return (
    <>
      <TooltipAnchor
        description="Voice & speed for this character"
        side="bottom"
        render={
          <Ariakit.PopoverDisclosure
            ref={disclosureRef}
            store={popover}
            type="button"
            aria-haspopup="dialog"
            aria-label="Voice and speed for this character"
            className="inline-flex size-9 flex-shrink-0 items-center justify-center rounded-xl border border-border-light bg-presentation text-text-primary transition-all ease-in-out hover:bg-surface-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Volume2 className="icon-md" aria-hidden={true} />
          </Ariakit.PopoverDisclosure>
        }
      />
      <Ariakit.Popover
        store={popover}
        gutter={8}
        portal
        unmountOnHide
        finalFocus={disclosureRef}
        aria-label="Voice and speed for this character"
        className="z-[200] w-80 max-w-[92vw] rounded-2xl border border-border-medium bg-surface-secondary p-4 text-text-primary shadow-lg focus:outline-none"
      >
        <div className="mb-1 text-sm font-semibold">Voice &amp; speed for this character</div>
        <p className="mb-3 text-xs text-text-secondary">
          Your voice pick follows this character everywhere — read-aloud here and on phone/web
          calls. Speed applies to read-aloud here.
        </p>
        <div className="mb-3 max-h-[50vh] overflow-y-auto">
          <VoiceDropdown />
        </div>
        <div className="border-t border-border-medium pt-3">
          <PlaybackRate />
        </div>
      </Ariakit.Popover>
    </>
  );
}

export default function VoiceSpeedControl() {
  return (
    <SafeBoundary>
      <VoiceSpeedControlInner />
    </SafeBoundary>
  );
}
