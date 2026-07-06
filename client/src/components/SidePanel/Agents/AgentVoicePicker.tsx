import { useState, useRef, useCallback, useMemo } from 'react';
import { ChevronDown, Volume2, Check } from 'lucide-react';
import type { FocusEvent, KeyboardEvent } from 'react';
import { useVoiceCatalogTexts, compareVoices } from '~/components/Audio/Voices';
import { useVoicesQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import { useVoiceAudition } from '~/components/Audio/useVoiceAudition';

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
 *
 * WINDOWS/NVDA (added 2026-07-01, Kade's report): NVDA's browse mode moves a
 * VIRTUAL cursor that never touches DOM focus, so focus-triggered samples
 * were silent there. The list is therefore a real role="listbox" with
 * focusable role="option" children (the APG roving-tabindex listbox
 * variant): when focus lands on an option, NVDA auto-switches to focus mode,
 * arrow keys reach the app, and each arrow step plays that voice. Tabbing
 * into the list from the filter box — or pressing Down/Enter inside the
 * filter — lands on the first option and starts the same flow. iOS VoiceOver
 * behavior is unchanged (options are still focusable buttons).
 */

export default function AgentVoicePicker({
  value,
  onChange,
  speed,
}: {
  value?: string | null;
  onChange: (voice?: string) => void;
  /** D2d: the agent's configured speaking rate — auditions play at this pace. */
  speed?: number;
}) {
  const localize = useLocalize();
  const { data: voicesData } = useVoicesQuery();
  /* D2c note: grouping/badges removed on Kade's call — after the 2026-07-01
     renumbering her custom voices ARE Voice 1–70, so plain numeric order
     leads with them without giving away which entries are custom. */
  const { audition: auditionTemplate } = useVoiceCatalogTexts();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const { unlock, audition, stop, playingVoice, error } = useVoiceAudition({ auditionTemplate, speed });
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
    return names.sort(compareVoices);
  }, [voicesData]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? voices.filter((v) => v.toLowerCase().includes(q)) : voices;
  }, [voices, filter]);


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
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      return;
    }
    // Home/End only when NOT typing in the filter box (there they move the caret)
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
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'Home' ? 0
      : e.key === 'End' ? btns.length - 1
      : i === -1 ? 0
      : e.key === 'ArrowDown' ? Math.min(i + 1, btns.length - 1)
      : Math.max(i - 1, 0);
    btns[next]?.focus();
  };

  /** One voice row — no custom/stock distinction, per Kade (2026-07-01).
   * role="option" inside the listbox + roving tabindex = NVDA enters focus
   * mode here, so its arrow keys reach the app and samples play per step. */
  const renderVoiceOption = (v: string) => {
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
  };

  return (
    <div ref={rootRef} onBlur={onRootBlur} className="flex flex-col gap-2">
      <button
        ref={openerRef}
        type="button"
        id="agent-voice-dropdown"
        onClick={toggleOpen}
        aria-expanded={open}
        aria-haspopup="listbox"
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
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                // The picker sits INSIDE the agent builder <form> — a bare
                // Enter here would submit the whole agent. Move into the
                // list instead, same as ArrowDown.
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
            aria-label={localize('com_agents_default_voice')}
            className="flex max-h-64 flex-col overflow-y-auto"
          >
            <button
              type="button"
              role="option"
              aria-selected={current == null}
              tabIndex={current == null || !filtered.includes(current) ? 0 : -1}
              data-voice-option
              onFocus={stop}
              onClick={() => select(undefined)}
              aria-label={localize('com_agents_default_voice_none')}
              className={cn(
                'flex items-center justify-between rounded-md px-2.5 py-2 text-left text-sm',
                'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy',
              )}
            >
              <span aria-hidden="true">{localize('com_agents_default_voice_none')}</span>
              {current == null && <Check className="h-4 w-4" aria-hidden="true" />}
            </button>
            {filtered.map((v) => renderVoiceOption(v))}
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
    </div>
  );
}
