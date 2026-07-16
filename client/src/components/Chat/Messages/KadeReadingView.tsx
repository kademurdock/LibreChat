import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useLocalize } from '~/hooks';

/**
 * KADE July 16 2026 — distraction-free full-screen reading view for a reply
 * (accessibility research paper, Section C). Plain text on the app's surface
 * color, big font, no chrome. Deliberately renders the message as plain text
 * (predictable for low-vision readers + screen readers); the styled markdown
 * stays in the normal chat view. Escape or the close button dismisses; focus
 * is moved in on open and handed back to the opener on close.
 */

export default function KadeReadingView({
  text,
  onClose,
}: {
  text: string;
  onClose: () => void;
}) {
  const localize = useLocalize();
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    openerRef.current = (document.activeElement as HTMLElement) ?? null;
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = previousOverflow;
      try {
        openerRef.current?.focus();
      } catch {
        // opener may be gone; nothing to restore
      }
    };
  }, [onClose]);

  return createPortal(
    <div
      className="kade-reading-view"
      role="dialog"
      aria-modal="true"
      aria-label={localize('com_ui_kade_reading_view')}
    >
      <div className="flex items-center justify-end p-3">
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label={localize('com_ui_kade_reading_view_close')}
          className="rounded-lg border border-border-medium p-3 text-text-primary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black dark:focus-visible:ring-white"
        >
          <X size={24} aria-hidden="true" />
        </button>
      </div>
      <div className="kade-reading-view__body">
        <article className="kade-reading-view__text">{text}</article>
      </div>
    </div>,
    document.body,
  );
}
