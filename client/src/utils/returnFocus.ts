import { mainTextareaId } from '~/common';

/**
 * Nov 12 2026 (WEB-7). A control that removes itself when pressed (Stop, "Answer now instead",
 * the Spotter card's "Maybe later") leaves keyboard focus on <body>, so the next Tab starts at
 * the top of the page. Call this inside the press handler, while the control is still mounted,
 * to land in the message box instead.
 *
 * Moves focus only when it is on (or inside) the leaving control, or already lost to <body>.
 * Skips touch screens, where focusing the message box would open the on-screen keyboard (same
 * rule as ChatForm's handleContainerClick).
 */
export function returnFocusToMainTextarea(leaving: Element | null | undefined): void {
  if (typeof document === 'undefined') {
    return;
  }
  const active = document.activeElement;
  const focusIsLeaving =
    active == null || active === document.body || (leaving != null && leaving.contains(active));
  if (!focusIsLeaving) {
    return;
  }
  if (window.matchMedia?.('(pointer: coarse)').matches) {
    return;
  }
  document.getElementById(mainTextareaId)?.focus({ preventScroll: true });
}
