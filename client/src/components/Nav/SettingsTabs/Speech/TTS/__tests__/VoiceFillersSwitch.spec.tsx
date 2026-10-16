import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { render, fireEvent } from 'test/layout-test-utils';
import { RecoilRoot } from 'recoil';
import VoiceFillersSwitch from '../VoiceFillersSwitch';

describe('VoiceFillersSwitch', () => {
  afterEach(() => localStorage.clear());

  it('is a named switch, on by default, with its explanation as the description', () => {
    const { getByRole } = render(
      <RecoilRoot>
        <VoiceFillersSwitch />
      </RecoilRoot>,
    );
    const toggle = getByRole('switch', { name: 'Filler words and little sounds' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveAccessibleDescription(
      'Characters sometimes say um or uh, take a breath, or laugh a little, like a real voice message. Only in what you hear: the text never changes. Never in books.',
    );
  });

  it('turns off and remembers the choice', () => {
    const onChange = jest.fn();
    const { getByRole } = render(
      <RecoilRoot>
        <VoiceFillersSwitch onCheckedChange={onChange} />
      </RecoilRoot>,
    );
    fireEvent.click(getByRole('switch', { name: 'Filler words and little sounds' }));
    expect(onChange).toHaveBeenCalledWith(false);
    expect(localStorage.getItem('voiceFillers')).toBe('false');
  });

  it('reads a saved off choice', () => {
    localStorage.setItem('voiceFillers', 'false');
    const { getByRole } = render(
      <RecoilRoot>
        <VoiceFillersSwitch />
      </RecoilRoot>,
    );
    expect(getByRole('switch', { name: 'Filler words and little sounds' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});
