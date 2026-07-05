import { memo } from 'react';
import { Brain } from 'lucide-react';
import { useRecoilState } from 'recoil';
import { useLocalize } from '~/hooks';
import { useLiveAnnouncer } from '~/Providers';
import { cn } from '~/utils';
import store from '~/store';

/**
 * Sticky "Deep think" toggle (July 4 2026; made sticky July 2026).
 *
 * Toggling it ON keeps deep thinking on across turns until you turn it OFF:
 * while on, useSubmitMessage appends an invisible fresh timestamped
 * [DEEP THINK <ms>] marker to every message, and reframe-proxy runs those turns
 * at reasoning effort high (overriding the agent's Answer-speed setting). With
 * it OFF, messages use the agent's own Answer-speed (Instant by default, so no
 * reasoning). Fully screen-reader first: aria-pressed state plus a polite live
 * announcement on every toggle, since the visual state change is silent.
 */
const DeepThinkToggle = memo(function DeepThinkToggle({ disabled }: { disabled?: boolean }) {
  const localize = useLocalize();
  const { announcePolite } = useLiveAnnouncer();
  const [armed, setArmed] = useRecoilState(store.deepThinkArmedState);

  const toggle = () => {
    const next = !armed;
    setArmed(next);
    announcePolite({
      message: localize(next ? 'com_ui_deep_think_on' : 'com_ui_deep_think_off'),
      isStatus: true,
    });
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled}
      aria-pressed={armed}
      aria-label={localize('com_ui_deep_think_label')}
      title={localize('com_ui_deep_think_label')}
      className={cn(
        'flex size-9 items-center justify-center rounded-full border transition-colors disabled:opacity-50',
        armed
          ? 'border-blue-500 bg-blue-500/15 text-blue-500'
          : 'border-border-medium text-text-secondary hover:bg-surface-hover',
      )}
    >
      <Brain className="icon-md" aria-hidden="true" />
    </button>
  );
});

export default DeepThinkToggle;
