import { memo, useRef } from 'react';
import * as Ariakit from '@ariakit/react';
import { TooltipAnchor } from '@librechat/client';
import type { TConversation } from 'librechat-data-provider';
import type { CurrencyConfig } from '~/utils';
import { formatTokens, formatCost, cn } from '~/utils';
import useTokenUsage from '~/hooks/Chat/useTokenUsage';
import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';
import Breakdown from './Breakdown';
import Gauge from './Gauge';
import { fullnessKey, estimateMessagesLeft } from './insights';

interface TokenUsageProps {
  index: number;
  conversation: TConversation | null;
  isSubmitting: boolean;
}

function TokenUsageIndicator({
  index,
  conversation,
  isSubmitting,
  showCost,
  currency,
}: TokenUsageProps & {
  showCost: boolean;
  currency?: CurrencyConfig;
}) {
  const localize = useLocalize();
  const view = useTokenUsage({ index, conversation, isSubmitting });
  const popover = Ariakit.usePopoverStore({ placement: 'top' });
  const disclosureRef = useRef<HTMLButtonElement>(null);

  /** Hide until the branch has data — keeps a fresh, message-less chat clean and
   *  lets the indicator animate into view once the first tokens land. */
  if (view.usedTokens <= 0) {
    return null;
  }

  const hasMax = view.maxTokens != null && view.maxTokens > 0;
  const costKnown = showCost && view.hasUsage && view.branchUsage.costKnown;
  const fullnessPhrase = localize(fullnessKey(view.percent));
  const messagesLeft = hasMax ? estimateMessagesLeft(view) : null;

  /** Screen readers land on the gauge and hear this. Lead with running cost
   *  (Kade's priority), then a plain-language fullness read, then room-left in
   *  messages. Every clause is fail-soft — an unknown one is simply dropped. */
  const ariaParts: string[] = [];
  if (costKnown) {
    ariaParts.push(
      localize('com_ui_context_usage_cost_spoken', { 0: formatCost(view.branchCost, currency) }),
    );
  }
  ariaParts.push(
    hasMax
      ? localize('com_ui_context_usage_fullness', {
          0: String(Math.round(view.percent)),
          1: fullnessPhrase,
        })
      : localize('com_ui_context_usage_label_unknown', { 0: formatTokens(view.usedTokens) }),
  );
  if (messagesLeft != null) {
    ariaParts.push(localize('com_ui_context_usage_msgs_spoken', { 0: String(messagesLeft) }));
  }
  const ariaLabel = `${ariaParts.join('. ')}.`;

  const snapshotSummary = hasMax
    ? `${localize('com_ui_context_usage_snapshot', {
        0: formatTokens(view.usedTokens),
        1: formatTokens(view.maxTokens ?? 0),
        2: String(Math.round(view.percent)),
      })} — ${fullnessPhrase}`
    : localize('com_ui_context_usage_snapshot_unknown', { 0: formatTokens(view.usedTokens) });
  const snapshot = costKnown
    ? `${snapshotSummary} · ${formatCost(view.branchCost, currency)}`
    : snapshotSummary;

  return (
    <>
      <TooltipAnchor
        description={snapshot}
        side="top"
        render={
          <Ariakit.PopoverDisclosure
            ref={disclosureRef}
            store={popover}
            type="button"
            data-testid="token-usage"
            aria-label={ariaLabel}
            aria-haspopup="dialog"
            className={cn(
              'flex size-9 items-center justify-center rounded-full p-1 transition-colors',
              'hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'duration-300 animate-in fade-in zoom-in-95',
            )}
          >
            <span
              role="meter"
              aria-valuemin={0}
              aria-valuemax={hasMax ? view.maxTokens : undefined}
              aria-valuenow={view.usedTokens}
              aria-label={localize('com_ui_context_usage')}
              className="flex items-center justify-center"
            >
              <Gauge percent={view.percent} indeterminate={!hasMax} />
            </span>
          </Ariakit.PopoverDisclosure>
        }
      />
      {/* Focus the labelled dialog on open so screen readers enter and announce
          the breakdown, and so focus stays contained instead of falling back to
          the body (which the composer's global focus logic would steal). The
          visible ring is suppressed via focus:outline-none, and finalFocus
          returns focus to the gauge trigger on close. */}
      <Ariakit.Popover
        store={popover}
        gutter={8}
        portal
        unmountOnHide
        finalFocus={disclosureRef}
        aria-label={localize('com_ui_context_usage')}
        className="z-[200] rounded-xl border border-border-medium bg-surface-secondary p-3 shadow-lg focus:outline-none"
      >
        <Breakdown view={view} showCost={showCost} currency={currency} />
      </Ariakit.Popover>
    </>
  );
}

/** Config gate kept outside the indicator so disabled deployments mount nothing */
const TokenUsage = memo(function TokenUsage(props: TokenUsageProps) {
  const { data: startupConfig } = useGetStartupConfig();
  /** Wait for config before mounting: until it loads `contextUsage === false`
   *  reads as undefined, so a disabled deployment would briefly mount the
   *  indicator and fire the token-config query on first load */
  if (startupConfig == null || startupConfig.interface?.contextUsage === false) {
    return null;
  }
  return (
    <TokenUsageIndicator
      {...props}
      showCost={startupConfig.interface?.contextCost === true}
      currency={startupConfig.interface?.currency}
    />
  );
});

export default TokenUsage;
