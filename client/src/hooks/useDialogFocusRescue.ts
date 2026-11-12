import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Nov 12 2026 (WEB-3). Keeps keyboard focus inside an open modal whose controls come and go.
 * When the focused control unmounts, focus falls to <body>: Escape stops reaching the dialog and
 * Tab walks into the page behind. After every render of the caller, a fallen focus returns to
 * the dialog. Escape pressed outside the dialog calls onEscape; Tab pressed outside the dialog
 * returns focus to it.
 */
export default function useDialogFocusRescue(
  open: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  onEscape: () => void,
): void {
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  // No dependency list on purpose: it must run after every render while the dialog is open.
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const active = document.activeElement;
    if (active == null || active === document.body) {
      dialogRef.current?.focus({ preventScroll: true });
    }
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(event.target as Node | null)) {
        return; // inside the dialog: its own onKeyDown handles Escape and the Tab trap
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!event.repeat) {
          onEscapeRef.current();
        }
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, dialogRef]);
}
