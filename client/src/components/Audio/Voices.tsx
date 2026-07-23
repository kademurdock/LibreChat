import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRecoilState, useRecoilValue } from 'recoil';
import { Volume2, Square, ChevronDown, Check } from 'lucide-react';
import { Dropdown } from '@librechat/client';
import type { Option } from '~/common';
import { useLocalize, useTTSBrowser, useTTSExternal } from '~/hooks';
import { useAuthContext } from '~/hooks/AuthContext';
import { cn, logger } from '~/utils';
import type { FocusEvent, KeyboardEvent } from 'react';
import { useVoiceAudition } from '~/components/Audio/useVoiceAudition';
import store from '~/store';
import {
  saveAgentVoicePreference,
  getAgentVoicePreference,
  clearAgentVoicePreference,
} from '~/hooks/Agents/useAgentVoiceSync';
import { useGetAgentByIdQuery } from '~/data-provider/Agents';

/** Short phrase spoken when the user previews a voice. */
const PREVIEW_TEXT =
  "Hi there! This is a little sample of my voice, so you can hear how I sound "
  + "before you pick me. I can be warm and friendly, or calm and clear when it "
  + "matters — whatever your conversation needs. Thanks for listening, and I hope "
  + "you like how I sound!";

/** ~10ms of silence. Played synchronously inside the tap to UNLOCK the audio
 * element on iOS Safari, so the real play() after the fetch await is allowed.
 * Exported: AgentVoicePicker reuses the same unlock trick for its
 * audition-as-you-browse playback (D2b). */
export const SILENT_WAV =
  'data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';

/** Same proxy base the ConversationMode voice pipeline points at. */
const TTS_PROXY_BASE = 'https://inworld-tts-proxy-production.up.railway.app';

/**
 * ♿ KADE D2c/D2d: voice-catalog metadata from the TTS proxy (GET /voices.json).
 * `sample` is the expressive audition monologue the /voices library page
 * performs — the in-app pickers use the same text so both surfaces sound
 * identical. (The `custom` list is still served but no longer drives any UI:
 * the 2026-07-01 renumbering made Kade's customs Voice 1–70, so plain numeric
 * order already leads with them, indistinguishably — her call.)
 * Fail-soft: on any fetch error `sample` is undefined and callers fall back
 * to their built-in line.
 */
export function useVoiceCatalogTexts(): { sample?: string; audition?: string } {
  const { data } = useQuery(
    ['kade', 'voiceCatalog'],
    async () => {
      const res = await fetch(`${TTS_PROXY_BASE}/voices.json`);
      if (!res.ok) {
        throw new Error(`voices.json ${res.status}`);
      }
      return (await res.json()) as { sample?: string; audition?: string };
    },
    { staleTime: Infinity, retry: 1, refetchOnWindowFocus: false },
  );
  return {
    sample: typeof data?.sample === 'string' && data.sample !== '' ? data.sample : undefined,
    /** Short expressive one-liner for browse-as-you-go auditions; `{voice}`
     * placeholder is filled by the caller. %%% steering converts to [bracket]
     * direction on the proxy's synth path. */
    audition: typeof data?.audition === 'string' && data.audition !== '' ? data.audition : undefined,
  };
}

/** "Voice 12" sorts numerically. KADE July 22 2026: the match is now
 * suffix-tolerant — "Voice 327 (Beta) Kade calm and casual" sorts as 327,
 * between 326 and 328, instead of failing the old ^Voice (\d+)$ exact match
 * and being hoisted (with the whole Beta wave) above "Voice 1" — her report:
 * "voices from fish are on top of the old ones, and the numbering looks
 * weird that way." Equal numbers tie-break alphabetically; any label with no
 * leading "Voice N" keeps the old behavior (first, alphabetically). */
export function compareVoices(a: string, b: string): number {
  const ma = /^Voice (\d+)\b/i.exec(a);
  const mb = /^Voice (\d+)\b/i.exec(b);
  if (ma && mb) {
    const d = Number(ma[1]) - Number(mb[1]);
    if (d !== 0) {
      return d;
    }
    return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
  }
  if (ma || mb) {
    return ma ? 1 : -1;
  }
  return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
}

/**
 * useVoicePreview — fetches a WAV sample for the given voice ID and plays it.
 * Returns { isPlaying, togglePreview } so the caller can wire up a play/stop button.
 */
function useVoicePreview() {
  const { token } = useAuthContext();
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** Object URL currently pointed at by audioRef — tracked so stop() can revoke
   * it even after we detach the element's own onended/onerror handlers. */
  const urlRef = useRef<string | null>(null);

  const stop = useCallback(() => {
    const el = audioRef.current;
    if (el) {
      // Detach handlers BEFORE tearing down. The old code set src = '' here,
      // which makes Safari resolve the empty URL to the page itself, try to
      // decode the HTML as media, and fire onerror — that is exactly what
      // popped the spurious "this device could not decode the audio" message
      // when Kade tapped the button a second time to STOP mid-preview. Remove
      // the attribute and load() instead: aborts playback with no error event.
      el.onended = null;
      el.onerror = null;
      el.pause();
      el.removeAttribute('src');
      try {
        el.load();
      } catch {
        /* no-op: nothing to load, just releasing the element */
      }
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setIsPlaying(false);
  }, []);

  // play() receives an <audio> element created synchronously inside the click
  // handler (iOS Safari blocks play() if the element is first touched after an
  // await), fetches the sample, and points the element at it.
  // D2d: `text` lets callers supply the catalog's expressive sample monologue;
  // `speed` is the optional per-agent speaking rate (0.5–1.5).
  const play = useCallback(async (
    voiceId: string,
    audio: HTMLAudioElement,
    opts?: { text?: string; speed?: number },
  ) => {
    try {
      const fd = new FormData();
      fd.append('input', opts?.text ?? PREVIEW_TEXT);
      fd.append('voice', voiceId);
      if (typeof opts?.speed === 'number') {
        fd.append('speed', String(opts.speed));
      }

      const doFetch = () =>
        fetch('/api/files/speech/tts/manual', {
          method: 'POST',
          body: fd,
          credentials: 'include',
          // LibreChat's JWT auth reads ONLY the Authorization header (not cookies),
          // so the in-memory access token must be sent explicitly or this 401s.
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });

      let res = await doFetch();
      if (!res.ok && res.status >= 500) {
        // KADE July 2 2026: a 5xx here is usually transient (the TTS proxy
        // mid-redeploy, or an upstream hiccup) — one quiet retry after a
        // beat fixes it more often than not. Kade hit exactly this as a
        // one-off 502 on a long preview.
        logger.warn(`[VoicePreview] HTTP ${res.status}, retrying once...`);
        await new Promise((r) => setTimeout(r, 1500));
        res = await doFetch();
      }

      if (!res.ok) {
        logger.error(`[VoicePreview] HTTP ${res.status}`);
        setError(`Preview failed: server error ${res.status}.`);
        stop();
        return;
      }

      // The backend hardcodes Content-Type: audio/mpeg, but the Inworld proxy
      // actually returns WAV bytes. Re-wrap the blob as audio/wav so the browser
      // decodes it instead of firing onerror (which was untoggling the button).
      const rawBlob = await res.blob();
      const wavBlob = new Blob([rawBlob], { type: 'audio/wav' });
      const url = URL.createObjectURL(wavBlob);
      urlRef.current = url;

      audio.onended = () => {
        if (urlRef.current === url) {
          URL.revokeObjectURL(url);
          urlRef.current = null;
        }
        if (audioRef.current === audio) {
          audioRef.current = null;
        }
        setIsPlaying(false);
      };
      audio.onerror = () => {
        if (urlRef.current === url) {
          URL.revokeObjectURL(url);
          urlRef.current = null;
        }
        if (audioRef.current === audio) {
          audioRef.current = null;
        }
        setError('Preview failed: this device could not decode the audio.');
        setIsPlaying(false);
      };

      audio.src = url;
      audio.play().catch((err) => {
        logger.error('[VoicePreview] play() failed:', err);
        setError(`Preview blocked by the browser (${err?.name || 'autoplay'}). Tap again.`);
        stop();
      });
    } catch (err) {
      logger.error('[VoicePreview] fetch failed:', err);
      setError('Preview failed: could not reach the voice server.');
      stop();
    }
  }, [stop, token]);

  const togglePreview = useCallback(
    (voiceId: string, opts?: { text?: string; speed?: number }) => {
      if (isPlaying) {
        stop();
        return;
      }
      setError(null);
      // Create the element NOW, inside the user gesture, before any await.
      const audio = new Audio();
      // iOS Safari only allows a later programmatic play() if THIS element was
      // already played within the user gesture. Setting the silent clip
      // and calling play() synchronously here "unlocks" it; the real sample
      // (fetched async below) can then play without being blocked. The clip is
      // pure silence, so it is inaudible — do NOT mute it (a muted play does
      // not satisfy iOS's unlock requirement for later unmuted audio).
      audio.src = SILENT_WAV;
      const unlock = audio.play();
      if (unlock && typeof unlock.catch === 'function') {
        unlock.catch(() => {});
      }
      audioRef.current = audio;
      setIsPlaying(true);
      play(voiceId, audio, opts);
    },
    [isPlaying, stop, play],
  );

  return { isPlaying, togglePreview, error };
}

/** Preview button shown alongside the ExternalVoiceDropdown, and reused by the
 * agent builder's default-voice picker (D1/D2) — same iOS-safe playback path. */
export function VoicePreviewButton({
  voiceId,
  disabled,
  speed,
}: {
  voiceId: string;
  disabled: boolean;
  /** D2d: optional speaking rate so the preview matches the agent's configured pace. */
  speed?: number;
}) {
  const localize = useLocalize();
  const { isPlaying, togglePreview, error } = useVoicePreview();
  // The same expressive monologue the /voices library page performs.
  const { sample: sampleText } = useVoiceCatalogTexts();

  const label = isPlaying
    ? localize('com_nav_stop_voice_preview') ?? 'Stop voice preview'
    : `${localize('com_nav_preview_voice') ?? 'Preview voice'}: ${voiceId}`;

  return (
    <div className="flex flex-col gap-1">
    <button
      type="button"
      onClick={() => togglePreview(voiceId, { text: sampleText, speed })}
      disabled={disabled || !voiceId}
      aria-label={label}
      aria-pressed={isPlaying}
      className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-text-secondary
        hover:bg-surface-hover hover:text-text-primary
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy
        disabled:cursor-not-allowed disabled:opacity-40
        transition-colors duration-150"
    >
      {isPlaying ? (
        <Square className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Volume2 className="h-4 w-4" aria-hidden="true" />
      )}
      <span aria-hidden="true">
        {isPlaying
          ? (localize('com_nav_stop_voice_preview') ?? 'Stop')
          : (localize('com_nav_preview_voice') ?? 'Preview')}
      </span>
    </button>
      {error && (
        <span role="alert" aria-live="assertive" className="text-xs text-red-500">
          {error}
        </span>
      )}
    </div>
  );
}

export function BrowserVoiceDropdown({ disabled = false }: { disabled?: boolean }) {
  const localize = useLocalize();
  const { voices = [] } = useTTSBrowser();
  const [voice, setVoice] = useRecoilState(store.voice);

  const handleVoiceChange = (newValue?: string | Option) => {
    logger.log('Browser Voice changed:', newValue);
    const newVoice = typeof newValue === 'string' ? newValue : newValue?.value;
    if (newVoice != null) {
      return setVoice(newVoice.toString());
    }
  };

  const labelId = 'browser-voice-dropdown-label';

  return (
    <div className="flex items-center justify-between">
      <div id={labelId}>{localize('com_nav_voice_select')}</div>
      <Dropdown
        key={`browser-voice-dropdown-${voices.length}`}
        value={voice ?? ''}
        options={voices}
        onChange={handleVoiceChange}
        sizeClasses="min-w-[200px] !max-w-[400px] [--anchor-max-width:400px]"
        testId="BrowserVoiceDropdown"
        className="z-50"
        aria-labelledby={labelId}
        disabled={disabled}
      />
    </div>
  );
}

export function ExternalVoiceDropdown({ disabled = false }: { disabled?: boolean }) {
  const localize = useLocalize();
  const { voices = [] } = useTTSExternal();
  const orderedVoices = useMemo(() => voices.map((v) => String(v)).sort(compareVoices), [voices]);
  const [voice, setVoice] = useRecoilState(store.voice);
  const activeAgentId = useRecoilValue(store.conversationAgentIdByIndex(0));
  /* ♿ KADE July 17 2026 (proposal B): voice-SOURCE transparency. Blind-first:
   * the picker says WHERE the active voice comes from ("your personal pick"
   * vs "<agent>'s default") and offers "Use character default" to clear a
   * personal pick — the exact confusion behind the July 16 wrong-voice call
   * (a forgotten personal pick silently shadowing a new builder voice). */
  const { data: activeAgent } = useGetAgentByIdQuery(activeAgentId);
  const [personalPick, setPersonalPick] = useState<string | undefined>(() =>
    getAgentVoicePreference(activeAgentId),
  );
  useEffect(() => {
    setPersonalPick(getAgentVoicePreference(activeAgentId));
  }, [activeAgentId]);
  const [resetAnnouncement, setResetAnnouncement] = useState('');
  // ♿ 2026-07-05 (Kade): SAME swipe-to-hear the builder has — she picks voices HERE.
  const { audition: auditionTemplate } = useVoiceCatalogTexts();
  const { unlock, audition, stop, playingVoice, error } = useVoiceAudition({ auditionTemplate });

  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  const current = typeof voice === 'string' && voice !== '' ? voice : undefined;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? orderedVoices.filter((v) => v.toLowerCase().includes(q)) : orderedVoices;
  }, [orderedVoices, filter]);

  // ♿ DIALOG-FOCUS FIX (the bug that blocked Kade): Settings is a Headless UI v2
  // modal Dialog with an aggressive focus trap. A bespoke disclosure whose list
  // appears on open let the trap yank focus to the neighboring Auto-transcribe
  // switch, so the list never really opened for VoiceOver. Remedy: the instant
  // the list opens, pull focus INTO it (onto the selected, else first, voice) in
  // a rAF that runs AFTER the trap's synchronous focus handling — focus ends on
  // an in-dialog element the trap is happy with, and that option auditions itself
  // so she immediately hears where she landed.
  useEffect(() => {
    if (!open) {
      return;
    }
    const id = window.requestAnimationFrame(() => {
      const list = listRef.current;
      if (!list) {
        return;
      }
      const target =
        list.querySelector<HTMLButtonElement>('button[data-voice-option][aria-selected="true"]') ??
        list.querySelector<HTMLButtonElement>('button[data-voice-option]');
      target?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  const commitVoice = (newVoice: string) => {
    if (activeAgentId) {
      saveAgentVoicePreference(activeAgentId, newVoice);
      setPersonalPick(newVoice);
    }
    setVoice(newVoice);
    setResetAnnouncement('');
  };

  const builderVoice = activeAgent?.tts?.voiceId ?? undefined;
  const agentDisplayName = activeAgent?.name ?? '';
  /** Which chain link is actually sounding right now (mirrors useAgentVoiceSync). */
  const voiceSourceText = useMemo(() => {
    if (current == null || activeAgentId == null || activeAgentId === '') {
      return '';
    }
    if (personalPick != null && current === personalPick) {
      return localize('com_agents_voice_source_personal', { voice: current });
    }
    if (builderVoice != null && current === builderVoice) {
      return agentDisplayName !== ''
        ? localize('com_agents_voice_source_builder', { voice: current, name: agentDisplayName })
        : '';
    }
    return localize('com_agents_voice_source_global', { voice: current });
  }, [current, activeAgentId, personalPick, builderVoice, agentDisplayName, localize]);

  const useCharacterDefault = () => {
    if (!activeAgentId) {
      return;
    }
    clearAgentVoicePreference(activeAgentId);
    setPersonalPick(undefined);
    if (builderVoice != null && builderVoice !== '') {
      setVoice(builderVoice);
      setResetAnnouncement(
        localize('com_agents_voice_reset_done', {
          name: agentDisplayName || localize('com_agents_voice_this_character'),
          voice: builderVoice,
        }),
      );
    } else {
      setResetAnnouncement(localize('com_agents_voice_reset_done_novoice'));
    }
  };

  const close = useCallback(
    (refocusOpener: boolean) => {
      stop();
      setOpen(false);
      setFilter('');
      if (refocusOpener) {
        openerRef.current?.focus();
      }
    },
    [stop],
  );

  const toggleOpen = () => {
    if (disabled) {
      return;
    }
    if (open) {
      close(false);
    } else {
      unlock(); // inside the user gesture — the browse experience depends on this
      setOpen(true);
    }
  };

  const select = (v: string) => {
    commitVoice(v);
    close(true);
  };

  /** Stop audition audio only if focus truly leaves the widget. */
  const onRootBlur = (e: FocusEvent) => {
    if (!rootRef.current?.contains(e.relatedTarget as Node)) {
      stop();
    }
  };

  const onListKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      return;
    }
    if (
      (e.key === 'Home' || e.key === 'End') &&
      (document.activeElement as HTMLElement)?.tagName === 'INPUT'
    ) {
      return;
    }
    e.preventDefault();
    const btns = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-voice-option]') ?? [],
    );
    if (btns.length === 0) {
      return;
    }
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'Home' ? 0
      : e.key === 'End' ? btns.length - 1
      : idx === -1 ? 0
      : e.key === 'ArrowDown' ? Math.min(idx + 1, btns.length - 1)
      : Math.max(idx - 1, 0);
    btns[next]?.focus();
  };

  const labelId = 'external-voice-dropdown-label';

  return (
    <div ref={rootRef} onBlur={onRootBlur} className="flex flex-col gap-2">
      <div id={labelId}>{localize('com_nav_voice_select')}</div>
      <button
        ref={openerRef}
        type="button"
        id="external-voice-opener"
        onClick={toggleOpen}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`${localize('com_nav_voice_select')}: ${
          voiceSourceText !== '' ? voiceSourceText : (current ?? '')
        }. ${localize('com_agents_voice_opener_hint')}`}
        className="flex w-full items-center justify-between rounded-lg border border-border-medium
          bg-surface-primary px-3 py-2 text-sm text-text-primary
          hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2
          focus-visible:ring-border-heavy transition-colors duration-150
          disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span aria-hidden="true">{current ?? '—'}</span>
        <ChevronDown
          className={cn('h-4 w-4 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>

      {voiceSourceText !== '' && (
        <p className="text-xs text-text-secondary">{voiceSourceText}</p>
      )}
      {personalPick != null && activeAgentId != null && activeAgentId !== '' && (
        <div className="flex justify-start">
          <button
            type="button"
            onClick={useCharacterDefault}
            aria-label={localize('com_agents_voice_use_default_aria', {
              name: agentDisplayName || localize('com_agents_voice_this_character'),
            })}
            className="rounded-lg px-2.5 py-1.5 text-sm text-text-secondary
              hover:bg-surface-hover hover:text-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
          >
            {localize('com_agents_voice_use_default')}
          </button>
        </div>
      )}
      {/* ♿ the reset outcome is ANNOUNCED — VoiceOver hears what just happened. */}
      <span role="status" aria-live="polite" className="sr-only">
        {resetAnnouncement}
      </span>
      {open && (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions
        <div
          onKeyDown={onListKeyDown}
          className="flex flex-col gap-2 rounded-lg border border-border-medium bg-surface-primary p-2"
        >
          <p className="text-xs text-text-secondary">{localize('com_agents_voice_browse_hint')}</p>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                listRef.current
                  ?.querySelector<HTMLButtonElement>('button[data-voice-option]')
                  ?.focus();
              }
            }}
            placeholder={localize('com_agents_voice_filter')}
            aria-label={localize('com_agents_voice_filter')}
            className="rounded-md border border-border-light bg-surface-primary px-2 py-1.5 text-sm
              text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
          />
          <div
            ref={listRef}
            role="listbox"
            aria-label={localize('com_nav_voice_select')}
            className="flex max-h-64 flex-col overflow-y-auto"
          >
            {filtered.map((v) => {
              const isCurrent = v === current;
              const isPlaying = v === playingVoice;
              return (
                <button
                  key={v}
                  type="button"
                  role="option"
                  aria-selected={isCurrent}
                  tabIndex={isCurrent ? 0 : -1}
                  data-voice-option
                  onFocus={() => audition(v)}
                  onMouseEnter={() => audition(v)}
                  onClick={() => select(v)}
                  aria-label={v}
                  className={cn(
                    'flex items-center justify-between rounded-md px-2.5 py-2 text-left text-sm',
                    'text-text-primary hover:bg-surface-hover',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy',
                    isCurrent && 'bg-surface-tertiary',
                  )}
                >
                  <span aria-hidden="true">{v}</span>
                  <span className="flex items-center gap-1.5" aria-hidden="true">
                    {isPlaying && <Volume2 className="h-4 w-4 animate-pulse" />}
                    {isCurrent && <Check className="h-4 w-4" />}
                  </span>
                </button>
              );
            })}
          </div>
          {filtered.length === 0 && (
            <p className="px-2.5 py-2 text-sm text-text-secondary" role="status">
              {localize('com_agents_voice_no_match')}
            </p>
          )}
          {error && (
            <span role="alert" aria-live="assertive" className="text-xs text-red-500">
              {error}
            </span>
          )}
          <button
            type="button"
            onClick={() => close(true)}
            className="self-end rounded-lg px-2.5 py-1.5 text-sm text-text-secondary
              hover:bg-surface-hover hover:text-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
          >
            {localize('com_agents_voice_close')}
          </button>
        </div>
      )}

      {/* ♿ C3: long-form Preview button stays — full audition of the selected voice. */}
      {current != null && (
        <div className="flex justify-end">
          <VoicePreviewButton voiceId={current} disabled={disabled} />
        </div>
      )}
    </div>
  );
}
