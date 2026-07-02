import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { ChevronDown, Volume2, Check } from 'lucide-react';
import type { FocusEvent, KeyboardEvent } from 'react';
import { SILENT_WAV, useCustomVoiceSet, orderVoicesCustomFirst } from '~/components/Audio/Voices';
import { useAuthContext } from '~/hooks/AuthContext';
import { useVoicesQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { logger } from '~/utils';
import { cn } from '~/utils';

/**
 * ♿ KADE D2b (2026-07-01): audition-as-you-browse voice picker for the agent
 * builder.
 *
 * The first D1/D2 pass used the generic Dropdown, which meant: commit to a
 * voice, close the picker, find the separate Preview button, play, repeat.
 * Kade's ask: hear the voice BEFORE picking it, ideally as you move through
 * the list. Custom VoiceOver rotor actions aren't available to web content,
 * so this does the next-best (arguably better) thing with plain, honest
 * buttons:
 *
 *   - Every voice is a real <button>. iOS VoiceOver moves DOM focus along
 *     with the VO cursor on focusable elements, so swiping onto a voice
 *     fires onFocus → a short sample plays after a brief debounce. Keyboard
 *     users get the same via arrow keys; mouse users via hover.
 *   - Double-tap / Enter / click SELECTS the focused voice and closes the
 *     list ("they play as you go through them, then you hit done").
 *   - Samples are fetched through the same manual-TTS route as the C3
 *     preview (Authorization header — P5) on ONE audio element unlocked
 *     inside the tap that opened the list (P4), then cached, so revisiting
 *     a voice replays instantly.
 *
 * If a platform ever stops syncing VO focus to DOM focus, nothing breaks:
 * options still announce their names and select on activate, and the
 * long-form Preview button below the picker still plays the selected voice.
 */

const AUDITION_DEBOUNCE_MS = 450;
const AUDITION_CACHE_MAX = 40;

/** Short line per voice — quick to synthesize, enough to judge the timbre. */
function auditionLine(voice: string) {
  return `Hi there — ${voice} here. This is how I sound.`;
}

function useVoiceAudition() {
  const { token } = useAuthContext();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** voice -> object URL of an already-fetched sample */
  const cacheRef = useRef<Map<string, string>>(new Map());
  /** latest-wins guard: bumping it invalidates any pending/in-flight play */
  const seqRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** MUST be called inside a real user gesture (the tap that opens the list):
   * plays a silent clip to unlock the element for later programmatic play(). */
  const unlock = useCallback(() => {
    if (audioRef.current) {
      return;
    }
    const el = new Audio();
    el.src = SILENT_WAV;
    const p = el.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {});
    }
    audioRef.current = el;
  }, []);

  const stop = useCallback(() => {
    window.clearTimeout(timerRef.current);
    seqRef.current += 1;
    audioRef.current?.pause();
    setPlayingVoice(null);
  }, []);

  const playNow = useCallback(
    async (voice: string) => {
      const el = audioRef.current;
      if (!el) {
        return;
      }
      const seq = ++seqRef.current;
      setError(null);
      try {
        let url = cacheRef.current.get(voice);
        if (url == null) {
          const fd = new FormData();
          fd.append('input', auditionLine(voice));
          fd.append('voice', voice);
          const res = await fetch('/api/files/speech/tts/manual', {
            method: 'POST',
            body: fd,
            credentials: 'include',
            // JWT strategy reads ONLY the Authorization header (P5 lesson)
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          });
          if (!res.ok) {
            logger.error(`[VoiceAudition] HTTP ${res.status}`);
            if (seq === seqRef.current) {
              setError(`Sample failed: server error ${res.status}.`);
            }
            return;
          }
          // Proxy returns WAV bytes regardless of declared content type (C3 lesson)
          const blob = new Blob([await res.blob()], { type: 'audio/wav' });
          url = URL.createObjectURL(blob);
          if (cacheRef.current.size >= AUDITION_CACHE_MAX) {
            const oldest = cacheRef.current.keys().next().value as string | undefined;
            if (oldest != null) {
              const oldUrl = cacheRef.current.get(oldest);
              if (oldUrl != null) {
                URL.revokeObjectURL(oldUrl);
              }
              cacheRef.current.delete(oldest);
            }
          }
          cacheRef.current.set(voice, url);
        }
        if (seq !== seqRef.current) {
          return; // user already moved to another voice
        }
        el.pause();
        el.src = url;
        el.onended = () => {
          if (seq === seqRef.current) {
            setPlayingVoice(null);
          }
        };
        el.onerror = () => {
          if (seq === seqRef.current) {
            setError('Sample failed: this device could not decode the audio.');
            setPlayingVoice(null);
          }
        };
        const p = el.play();
        if (p && typeof p.catch === 'function') {
          p.catch((err: unknown) => {
            logger.error('[VoiceAudition] play() failed:', err);
          });
        }
        setPlayingVoice(voice);
      } catch (err) {
        logger.error('[VoiceAudition] fetch failed:', err);
        if (seq === seqRef.current) {
          setError('Sample failed: could not reach the voice server.');
        }
      }
    },
    [token],
  );

  /** Debounced audition — call on option focus/hover. Rapid movement through
   * the list only plays the voice the user actually rests on. */
  const audition = useCallback(
    (voice: string) => {
      window.clearTimeout(timerRef.current);
      seqRef.current += 1;
      timerRef.current = window.setTimeout(() => {
        void playNow(voice);
      }, AUDITION_DEBOUNCE_MS);
    },
    [playNow],
  );

  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      window.clearTimeout(timerRef.current);
      seqRef.current += 1;
      audioRef.current?.pause();
      audioRef.current = null;
      cache.forEach((u) => URL.revokeObjectURL(u));
      cache.clear();
    };
  }, []);

  return { unlock, audition, stop, playingVoice, error };
}

export default function AgentVoicePicker({
  value,
  onChange,
}: {
  value?: string | null;
  onChange: (voice?: string) => void;
}) {
  const localize = useLocalize();
  const { data: voicesData } = useVoicesQuery();
  /* ♿ D2c: Kade's custom voices float to the top (labeled group); the numbered
     library stays available below. The set comes from the proxy's
     /voices.json — same truth as the /voices library page. */
  const customSet = useCustomVoiceSet();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const { unlock, audition, stop, playingVoice, error } = useVoiceAudition();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  const voices: string[] = useMemo(() => {
    const raw: unknown = voicesData;
    const arr = Array.isArray(raw)
      ? raw
      : ((raw as { voices?: unknown[] } | undefined)?.voices ?? []);
    const names = arr
      .map((v) =>
        typeof v === 'string'
          ? v
          : String((v as { value?: unknown; label?: unknown })?.value ?? (v as { label?: unknown })?.label ?? ''),
      )
      .filter((v) => v !== '');
    return orderVoicesCustomFirst(names, customSet);
  }, [voicesData, customSet]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? voices.filter((v) => v.toLowerCase().includes(q)) : voices;
  }, [voices, filter]);
  const customMatches = useMemo(
    () => filtered.filter((v) => customSet.has(v)),
    [filtered, customSet],
  );
  const libraryMatches = useMemo(
    () => filtered.filter((v) => !customSet.has(v)),
    [filtered, customSet],
  );

  const current = typeof value === 'string' && value !== '' ? value : undefined;

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
    if (open) {
      close(false);
    } else {
      unlock(); // inside the user gesture — the whole browse experience depends on this
      setOpen(true);
    }
  };

  const select = (voice?: string) => {
    onChange(voice);
    close(true);
  };

  /** Stop audition audio if focus genuinely leaves the widget. */
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
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
      return;
    }
    e.preventDefault();
    const btns = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-voice-option]') ?? [],
    );
    if (btns.length === 0) {
      return;
    }
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      i === -1 ? 0 : e.key === 'ArrowDown' ? Math.min(i + 1, btns.length - 1) : Math.max(i - 1, 0);
    btns[next]?.focus();
  };

  /** One voice row. Custom voices announce and show their "custom" badge —
   * same wording as the /voices library page, so it sounds familiar. */
  const renderVoiceOption = (v: string, isCustom: boolean) => {
    const isCurrent = v === current;
    const isPlaying = v === playingVoice;
    const labelParts = [v];
    if (isCustom) {
      labelParts.push(localize('com_agents_voice_custom_badge'));
    }
    if (isCurrent) {
      labelParts.push(localize('com_agents_voice_current'));
    }
    return (
      <button
        key={v}
        type="button"
        data-voice-option
        onFocus={() => audition(v)}
        onMouseEnter={() => audition(v)}
        onClick={() => select(v)}
        aria-label={labelParts.join(', ')}
        className={cn(
          'flex items-center justify-between rounded-md px-2.5 py-2 text-left text-sm',
          'text-text-primary hover:bg-surface-hover',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy',
          isCurrent && 'bg-surface-tertiary',
        )}
      >
        <span className="flex items-center gap-2" aria-hidden="true">
          {v}
          {isCustom && (
            <span className="rounded-full bg-surface-tertiary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-secondary">
              custom
            </span>
          )}
        </span>
        <span className="flex items-center gap-1.5" aria-hidden="true">
          {isPlaying && <Volume2 className="h-4 w-4 animate-pulse" />}
          {isCurrent && <Check className="h-4 w-4" />}
        </span>
      </button>
    );
  };

  return (
    <div ref={rootRef} onBlur={onRootBlur} className="flex flex-col gap-2">
      <button
        ref={openerRef}
        type="button"
        id="agent-voice-dropdown"
        onClick={toggleOpen}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`${localize('com_agents_default_voice')}: ${
          current ?? localize('com_agents_default_voice_none')
        }. ${localize('com_agents_voice_opener_hint')}`}
        className="flex w-full items-center justify-between rounded-lg border border-border-medium
          bg-surface-primary px-3 py-2 text-sm text-text-primary
          hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2
          focus-visible:ring-border-heavy transition-colors duration-150"
      >
        <span aria-hidden="true">{current ?? localize('com_agents_default_voice_none')}</span>
        <ChevronDown
          className={cn('h-4 w-4 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>

      {open && (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions
        <div
          onKeyDown={onListKeyDown}
          className="flex flex-col gap-2 rounded-lg border border-border-medium bg-surface-primary p-2"
        >
          <p className="text-xs text-text-secondary">
            {localize('com_agents_voice_browse_hint')}
          </p>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={localize('com_agents_voice_filter')}
            aria-label={localize('com_agents_voice_filter')}
            className="rounded-md border border-border-light bg-surface-primary px-2 py-1.5 text-sm
              text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
          />
          <div
            ref={listRef}
            role="group"
            aria-label={localize('com_agents_default_voice')}
            className="flex max-h-64 flex-col overflow-y-auto"
          >
            <button
              type="button"
              data-voice-option
              onFocus={stop}
              onClick={() => select(undefined)}
              aria-label={`${localize('com_agents_default_voice_none')}${
                current == null ? `, ${localize('com_agents_voice_current')}` : ''
              }`}
              className={cn(
                'flex items-center justify-between rounded-md px-2.5 py-2 text-left text-sm',
                'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy',
              )}
            >
              <span aria-hidden="true">{localize('com_agents_default_voice_none')}</span>
              {current == null && <Check className="h-4 w-4" aria-hidden="true" />}
            </button>
            {customMatches.length > 0 && (
              <p className="px-2.5 pb-1 pt-2 text-xs font-medium uppercase tracking-wider text-text-secondary">
                {localize('com_agents_voice_group_custom')}
              </p>
            )}
            {customMatches.map((v) => renderVoiceOption(v, true))}
            {libraryMatches.length > 0 && (
              <p className="px-2.5 pb-1 pt-3 text-xs font-medium uppercase tracking-wider text-text-secondary">
                {localize('com_agents_voice_group_library')}
              </p>
            )}
            {libraryMatches.map((v) => renderVoiceOption(v, false))}
            {filtered.length === 0 && (
              <p className="px-2.5 py-2 text-sm text-text-secondary">
                {localize('com_agents_voice_no_match')}
              </p>
            )}
          </div>
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
    </div>
  );
}
