import React from 'react';
import { cn } from '~/utils';

/* ♿ KADE July 2 2026 (evening 2): this used to be a plain div inside a
   role="button" row, with a second aria-label on the title and a
   double-click-to-rename trap on the text. iOS VoiceOver could focus the row
   but double-tap activation was unreliable (nested interactive content +
   duplicate labels), which is why Kade couldn't open old conversations.
   It is now a REAL anchor: native link semantics, native VO activation, and
   even if the SPA click handler ever misfires, the href still opens the
   conversation the old-fashioned way. Rename lives in the options menu. */

interface ConvoLinkProps {
  href: string;
  onClick: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  isActiveConvo: boolean;
  isPopoverActive: boolean;
  title: string | null;
  ariaLabel: string;
  localize: (key: any, options?: any) => string;
  children: React.ReactNode;
}

const ConvoLink: React.FC<ConvoLinkProps> = ({
  href,
  onClick,
  isActiveConvo,
  isPopoverActive,
  title,
  ariaLabel,
  localize,
  children,
}) => {
  return (
    <a
      href={href}
      onClick={onClick}
      data-testid="convo-link"
      aria-label={ariaLabel}
      aria-current={isActiveConvo ? 'page' : undefined}
      title={title ?? undefined}
      className={cn(
        'flex h-full min-w-0 grow items-center gap-2 overflow-hidden rounded-lg px-2 text-text-primary no-underline outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-black dark:focus-visible:ring-white',
        isActiveConvo || isPopoverActive ? 'bg-surface-active-alt' : '',
      )}
    >
      {children}
      {/* Visual title only — the accessible name comes from the link's
          aria-label, so this is hidden from AT to avoid double-speak. */}
      <div
        className="relative flex-1 grow overflow-hidden whitespace-nowrap"
        style={{ textOverflow: 'clip' }}
        aria-hidden="true"
      >
        {title || localize('com_ui_untitled')}
        <div
          className={cn(
            'pointer-events-none absolute bottom-0 right-0 top-0 w-20 bg-gradient-to-l',
            isActiveConvo || isPopoverActive
              ? 'from-surface-active-alt'
              : 'from-surface-primary-alt from-0% to-transparent group-hover:from-surface-active-alt group-hover:from-0%',
          )}
        />
      </div>
    </a>
  );
};

export default ConvoLink;
