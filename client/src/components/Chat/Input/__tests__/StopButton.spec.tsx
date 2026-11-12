import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import StopButton from '../StopButton';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('@librechat/client', () => ({
  TooltipAnchor: ({ render: child }: { render: React.ReactElement }) => child,
}));

// setupTests.js defines window.matchMedia as writable but not configurable: assign, never redefine.
const setCoarse = (coarse: boolean) => {
  window.matchMedia = ((query: string) => ({
    matches: coarse && query === '(pointer: coarse)',
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })) as unknown as typeof window.matchMedia;
};

const setup = () => {
  const stop = jest.fn();
  render(
    <>
      <input data-testid="elsewhere" />
      <textarea id="prompt-textarea" data-testid="box" />
      <StopButton stop={stop} setShowStopButton={jest.fn()} />
    </>,
  );
  return { stop, button: screen.getByTestId('stop-generation-button') };
};

describe('StopButton focus hand-off (WEB-7)', () => {
  it('moves keyboard focus to the message box when Stop held focus', () => {
    setCoarse(false);
    const { stop, button } = setup();
    button.focus();
    fireEvent.click(button);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByTestId('box'));
  });

  it('leaves focus alone when it was somewhere else', () => {
    setCoarse(false);
    const { button } = setup();
    screen.getByTestId('elsewhere').focus();
    fireEvent.click(button);
    expect(document.activeElement).toBe(screen.getByTestId('elsewhere'));
  });

  it('does not focus the message box on a touch screen', () => {
    setCoarse(true);
    const { button } = setup();
    button.focus();
    fireEvent.click(button);
    expect(document.activeElement).not.toBe(screen.getByTestId('box'));
  });
});
