import { memo } from 'react';
import { Brain, Zap } from 'lucide-react';
import { useRecoilState } from 'recoil';
import { useLocalize } from '~/hooks';
import { useLiveAnnouncer } from '~/Providers';
import { cn } from '~/utils';
import store from '~/store';
import type { TThinkMode } from '~/store/families';

/**
 * Thinking-mode picker (Aug 14 2026 — web parity with native build 204).
 * Grew out of the July "Deep think" toggle: one button that CYCLES
 * Automatic → Deep → Instant → Automatic.
 *
 * - Automatic (default): the reframe-proxy router decides per turn — small
 *   talk answers instantly, think-shaped questions get real thought.
 * - Deep: every send carries a fresh [DEEP THINK <ms>] marker (always thinks).
 * - Instant: every send carries a fresh [INSTANT <ms>] marker (never waits).
 *
 * Screen-reader first: the button's label always names the CURRENT mode, and
 * every cycle fires a polite live announcement naming the NEW mode — the
 * visual state change is silent and the visuals are secondary on purpose.
 * Instant persists across reloads; Deep resets to Automatic (store handles it).
 */
const MODE_ORDER: TThinkMode[] = ['auto', 'deep', 'instant'];

const DeepThinkToggle = memo(function DeepThinkToggle({ disabled }: { disabled?: boolean }) {
  const localize = useLocalize();
  const { announcePolite } = useLiveAnnouncer();
  const [mode, setMode] = useRecoilState(store.thinkModeState);

  const cycle = () => {
    const next = MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length];
    setMode(next);
    announcePolite({
      message: localize(
        next === 'deep'
          ? 'com_ui_think_mode_deep_announce'
          : next === 'instant'
            ? 'com_ui_think_mode_instant_announce'
            : 'com_ui_think_mode_auto_announce',
      ),
      isStatus: true,
    });
  };

  const modeName = localize(
    mode === 'deep'
      ? 'com_ui_think_mode_deep'
      : mode === 'instant'
        ? 'com_ui_think_mode_instant'
        : 'com_ui_think_mode_auto',
  );
  const label = `${localize('com_ui_think_mode_label')}: ${modeName}`;

  return (
    <button
      type="button"
      onClick={cycle}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'flex size-9 items-center justify-center rounded-full border transition-colors disabled:opacity-50',
        mode === 'deep'
          ? 'border-blue-500 bg-blue-500/15 text-blue-500'
          : mode === 'instant'
            ? 'border-amber-500 bg-amber-500/15 text-amber-500'
            : 'border-border-medium text-text-secondary hover:bg-surface-hover',
      )}
    >
      {mode === 'instant' ? (
        <Zap className="icon-md" aria-hidden="true" />
      ) : (
        <Brain className="icon-md" aria-hidden="true" />
      )}
    </button>
  );
});

export default DeepThinkToggle;
