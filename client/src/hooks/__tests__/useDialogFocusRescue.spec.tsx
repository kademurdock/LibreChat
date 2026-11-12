/* eslint-disable i18next/no-literal-string */
import { useRef, useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import useDialogFocusRescue from '../useDialogFocusRescue';

function Harness({ onEscape }: { onEscape: () => void }) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [speaking, setSpeaking] = useState(true);
  useDialogFocusRescue(true, dialogRef, onEscape);
  return (
    <>
      <button>Behind</button>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-label="Call">
        {speaking && <button onClick={() => setSpeaking(false)}>Interrupt</button>}
        <button>End call</button>
      </div>
    </>
  );
}

describe('useDialogFocusRescue', () => {
  it('returns fallen focus to the dialog and hangs up on Escape from body', () => {
    const onEscape = jest.fn();
    render(<Harness onEscape={onEscape} />);
    const interrupt = screen.getByRole('button', { name: 'Interrupt' });
    interrupt.focus();
    fireEvent.click(interrupt);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('ignores a repeated Escape and an Escape inside the dialog', () => {
    const onEscape = jest.fn();
    render(<Harness onEscape={onEscape} />);
    fireEvent.keyDown(document.body, { key: 'Escape', repeat: true });
    fireEvent.keyDown(screen.getByRole('button', { name: 'End call' }), { key: 'Escape' });
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('pulls Tab from the page behind back to the dialog', () => {
    render(<Harness onEscape={jest.fn()} />);
    const behind = screen.getByRole('button', { name: 'Behind' });
    behind.focus();
    fireEvent.keyDown(behind, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });
});
