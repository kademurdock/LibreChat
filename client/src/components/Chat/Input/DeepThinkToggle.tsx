import { memo } from 'react';
import { Brain } from 'lucide-react';
import { useRecoilState } from 'recoil';
import { useLocalize } from '~/hooks';
import { useLiveAnnouncer } from '~/Providers';
import { cn } from '~/utils';
import store from '~/store';

/**
 * Per-message "Deep think" arm button (July 4 2026).
 *
 * Pressing it arms deep thinking for the NEXT message only: useSubmitMessage
 * appends an invisible timestamped [DEEP THINK <ms>] marker to that one
 * message, reframe-proxy runs that turn at reasoning effort high (overriding
 * the agent's Answer-speed setting), and the button disarms itself after the
 * send. Fully screen-reader first: aria-pressed state plus a polite live
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
