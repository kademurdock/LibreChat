import React from 'react';
import { render, screen, act } from '@testing-library/react';
import type { AnnounceOptions } from '~/common';
import { useLiveAnnouncer } from '~/Providers/AnnouncerContext';
import LiveAnnouncer from '../LiveAnnouncer';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

let announce: (options: AnnounceOptions) => void = () => undefined;

const Grab = () => {
  announce = useLiveAnnouncer().announcePolite;
  return null;
};

describe('LiveAnnouncer (WEB-14)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    render(
      <LiveAnnouncer>
        <Grab />
      </LiveAnnouncer>,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('silenced events do not wipe a status in flight', () => {
    act(() => announce({ message: 'Generating reply...', isStatus: true }));
    expect(screen.getByRole('status')).toHaveTextContent('Generating reply...');
    act(() => announce({ message: 'start', isStatus: true }));
    act(() => announce({ message: 'composing', isStatus: true }));
    expect(screen.getByRole('status')).toHaveTextContent('Generating reply...');
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('re-announces the same status by clearing first', () => {
    act(() => announce({ message: 'Reply ready', isStatus: true }));
    act(() => announce({ message: 'Reply ready', isStatus: true }));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    act(() => {
      jest.advanceTimersByTime(50);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Reply ready');
  });

  it('keeps the reply and the memory cue as separate lines, then removes them', () => {
    act(() => announce({ message: 'Here is your answer.' }));
    act(() => announce({ message: 'Memory saved.' }));
    act(() => announce({ message: 'start', isStatus: true }));
    const log = screen.getByRole('log');
    expect(log.querySelectorAll('p')).toHaveLength(2);
    expect(log).toHaveTextContent('Here is your answer.');
    expect(log).toHaveTextContent('Memory saved.');
    act(() => {
      jest.advanceTimersByTime(8000);
    });
    expect(log).toBeEmptyDOMElement();
  });

  it('announces an identical reply as a new line and keeps at most four', () => {
    act(() => announce({ message: 'Okay.' }));
    act(() => announce({ message: 'Okay.' }));
    expect(screen.getByRole('log').querySelectorAll('p')).toHaveLength(2);
    act(() => announce({ message: 'three' }));
    act(() => announce({ message: 'four' }));
    act(() => announce({ message: 'five' }));
    expect(screen.getByRole('log').querySelectorAll('p')).toHaveLength(4);
  });

  it('keeps a long reply longer than a short one', () => {
    act(() => announce({ message: 'x'.repeat(400) }));
    act(() => {
      jest.advanceTimersByTime(8000);
    });
    expect(screen.getByRole('log').querySelectorAll('p')).toHaveLength(1);
    act(() => {
      jest.advanceTimersByTime(12000);
    });
    expect(screen.getByRole('log')).toBeEmptyDOMElement();
  });

  it('never announces the reasoning inside inline think tags (WEB-4)', () => {
    act(() => announce({ message: 'Hello <think>private plan</think>there.' }));
    expect(screen.getByRole('log')).toHaveTextContent('Hello there.');
    expect(screen.getByRole('log')).not.toHaveTextContent('private');
  });
});
