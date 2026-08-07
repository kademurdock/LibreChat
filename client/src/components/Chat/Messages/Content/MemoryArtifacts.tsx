import { Tools } from 'librechat-data-provider';
import { useState, useRef, useMemo, useLayoutEffect, useEffect } from 'react';
import { useRecoilValue } from 'recoil';
import type { MemoryArtifact, TAttachment } from 'librechat-data-provider';
import MemoryInfo from './MemoryInfo';
import { useLiveAnnouncer } from '~/Providers';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

/** Aug 7 2026 (Kade: "I don't even know if you can tell when memories are
 * made") — the MEMORY-SAVED CUE. When memory artifacts arrive on a LIVE
 * reply (they appear mid-render; historical messages mount with theirs
 * already attached, so those stay silent), play two soft high notes and
 * politely announce what happened. Rides the same chimeOnCompletion switch
 * as the rest of the chat sound kit; the announcement always fires (it is
 * the screen-reader lane, not decoration). */
function playMemoryChime() {
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      return;
    }
    const ctx = new Ctor();
    const now = ctx.currentTime;
    [880, 1174.7].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + i * 0.11);
      gain.gain.linearRampToValueAtTime(0.055, now + i * 0.11 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.11 + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.11);
      osc.stop(now + i * 0.11 + 0.24);
    });
    setTimeout(() => void ctx.close(), 800);
  } catch {
    /* sound is garnish — never break the message for it */
  }
}

export default function MemoryArtifacts({ attachments }: { attachments?: TAttachment[] }) {
  const localize = useLocalize();
  const [showInfo, setShowInfo] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState<number | undefined>(0);
  const [isAnimating, setIsAnimating] = useState(false);
  const prevShowInfoRef = useRef<boolean>(showInfo);

  const { hasErrors, memoryArtifacts } = useMemo(() => {
    let hasErrors = false;
    const result: MemoryArtifact[] = [];

    if (!attachments || attachments.length === 0) {
      return { hasErrors, memoryArtifacts: result };
    }

    for (const attachment of attachments) {
      if (attachment?.[Tools.memory] != null) {
        result.push(attachment[Tools.memory]);

        if (!hasErrors && attachment[Tools.memory].type === 'error') {
          hasErrors = true;
        }
      }
    }

    return { hasErrors, memoryArtifacts: result };
  }, [attachments]);

  const { announcePolite } = useLiveAnnouncer();
  const chimeEnabled = useRecoilValue(store.chimeOnCompletion);
  const sawEmptyRef = useRef(false);
  const cuedRef = useRef(false);
  useEffect(() => {
    if (memoryArtifacts.length === 0) {
      sawEmptyRef.current = true; // mounted before artifacts existed = live reply
      return;
    }
    if (!sawEmptyRef.current || cuedRef.current) {
      return; // historical mount (born with artifacts) or already cued
    }
    cuedRef.current = true;
    const kinds = memoryArtifacts.map((a) => a.type);
    const deleted = kinds.filter((k) => k === 'delete').length;
    const errored = kinds.filter((k) => k === 'error').length;
    const saved = memoryArtifacts.length - deleted - errored;
    const parts: string[] = [];
    if (saved > 0) {
      parts.push(saved === 1 ? 'Memory saved' : `${saved} memories saved`);
    }
    if (deleted > 0) {
      parts.push(deleted === 1 ? 'a memory was forgotten' : `${deleted} memories forgotten`);
    }
    if (parts.length === 0) {
      return; // errors alone stay quiet here — the visual row carries them
    }
    if (chimeEnabled) {
      playMemoryChime();
    }
    announcePolite({ message: parts.join(', ') + '.' });
  }, [memoryArtifacts, chimeEnabled, announcePolite]);

  useLayoutEffect(() => {
    if (showInfo !== prevShowInfoRef.current) {
      prevShowInfoRef.current = showInfo;
      setIsAnimating(true);

      if (showInfo && contentRef.current) {
        requestAnimationFrame(() => {
          if (contentRef.current) {
            const height = contentRef.current.scrollHeight;
            setContentHeight(height + 4);
          }
        });
      } else {
        setContentHeight(0);
      }

      const timer = setTimeout(() => {
        setIsAnimating(false);
      }, 400);

      return () => clearTimeout(timer);
    }
  }, [showInfo]);

  useEffect(() => {
    if (!contentRef.current) {
      return;
    }
    const resizeObserver = new ResizeObserver((entries) => {
      if (showInfo && !isAnimating) {
        for (const entry of entries) {
          if (entry.target === contentRef.current) {
            setContentHeight(entry.contentRect.height + 4);
          }
        }
      }
    });
    resizeObserver.observe(contentRef.current);
    return () => {
      resizeObserver.disconnect();
    };
  }, [showInfo, isAnimating]);

  if (!memoryArtifacts || memoryArtifacts.length === 0) {
    return null;
  }

  return (
    <>
      <div className="flex items-center">
        <div className="inline-block">
          <button
            className={cn(
              'outline-hidden my-1 flex items-center gap-1 text-sm font-semibold transition-colors',
              hasErrors
                ? 'text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-500'
                : 'text-text-secondary-alt hover:text-text-primary',
            )}
            type="button"
            onClick={() => setShowInfo((prev) => !prev)}
            aria-expanded={showInfo}
            aria-label={localize('com_ui_memory_updated')}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 18 18"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="mb-[-1px]"
            >
              <path
                d="M6 3C4.89543 3 4 3.89543 4 5V13C4 14.1046 4.89543 15 6 15L6 3Z"
                fill="currentColor"
              />
              <path
                d="M7 3V15H8.18037L8.4899 13.4523C8.54798 13.1619 8.69071 12.8952 8.90012 12.6858L12.2931 9.29289C12.7644 8.82153 13.3822 8.58583 14 8.58578V3.5C14 3.22386 13.7761 3 13.5 3H7Z"
                fill="currentColor"
              />
              <path
                d="M11.3512 15.5297L9.73505 15.8529C9.38519 15.9229 9.07673 15.6144 9.14671 15.2646L9.46993 13.6484C9.48929 13.5517 9.53687 13.4628 9.60667 13.393L12.9996 10C13.5519 9.44771 14.4473 9.44771 14.9996 10C15.5519 10.5523 15.5519 11.4477 14.9996 12L11.6067 15.393C11.5369 15.4628 11.448 15.5103 11.3512 15.5297Z"
                fill="currentColor"
              />
            </svg>
            {hasErrors ? localize('com_ui_memory_error') : localize('com_ui_memory_updated')}
          </button>
        </div>
      </div>
      <div
        className="relative"
        style={{
          height: showInfo ? contentHeight : 0,
          overflow: 'hidden',
          transition:
            'height 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
          opacity: showInfo ? 1 : 0,
          transformOrigin: 'top',
          willChange: 'height, opacity',
          perspective: '1000px',
          backfaceVisibility: 'hidden',
          WebkitFontSmoothing: 'subpixel-antialiased',
        }}
      >
        <div
          className={cn(
            'overflow-hidden rounded-xl border border-border-light bg-surface-primary-alt shadow-md',
            showInfo && 'shadow-lg',
          )}
          style={{
            transform: showInfo ? 'translateY(0) scale(1)' : 'translateY(-8px) scale(0.98)',
            opacity: showInfo ? 1 : 0,
            transition:
              'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          <div ref={contentRef}>
            {showInfo && <MemoryInfo key="memory-info" memoryArtifacts={memoryArtifacts} />}
          </div>
        </div>
      </div>
    </>
  );
}
