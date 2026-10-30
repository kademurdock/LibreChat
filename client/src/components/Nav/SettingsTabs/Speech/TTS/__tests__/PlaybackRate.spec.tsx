import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { render, fireEvent } from 'test/layout-test-utils';
import { RecoilRoot } from 'recoil';
import type { MutableSnapshot } from 'recoil';
import PlaybackRate from '../PlaybackRate';
import store from '~/store';

const renderControl = (voiceSpeed?: number) =>
  render(
    <RecoilRoot
      initializeState={({ set }: MutableSnapshot) => {
        set(store.voiceSpeed, voiceSpeed);
      }}
    >
      <PlaybackRate />
    </RecoilRoot>,
  );

describe('Voice speed (one list for every voice)', () => {
  afterEach(() => localStorage.clear());

  it('is one labelled control showing the agreed numbers', () => {
    const { getByLabelText } = renderControl();
    const select = getByLabelText('Voice speed') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Character's speed (1x)",
      '0.75x',
      '0.8x',
      '0.9x',
      '1x',
      '1.1x',
      '1.2x',
      '1.3x',
      '1.4x',
      '1.5x',
    ]);
    expect(select).toHaveValue('');
  });

  it('names each number for a screen reader', () => {
    const { getByRole } = renderControl();
    expect(getByRole('option', { name: '1.2 times' })).toHaveTextContent('1.2x');
    expect(getByRole('option', { name: "Character's speed (Normal)" })).toHaveValue('');
    expect(getByRole('option', { name: 'Normal' })).toHaveTextContent('1x');
  });

  it('says the number on the empty option', () => {
    const { getByRole, getByLabelText } = renderControl(1.2);
    expect(getByLabelText('Voice speed')).toHaveValue('');
    expect(getByRole('option', { name: "Character's speed (1.2 times)" })).toHaveTextContent(
      "Character's speed (1.2x)",
    );
  });

  it('shows a saved number off the list as itself, not blank', () => {
    localStorage.setItem('voicePacePreference', '1.25');
    const { getByLabelText, getByRole } = renderControl();
    const select = getByLabelText('Voice speed') as HTMLSelectElement;
    expect(select).toHaveValue('1.25');
    expect(select.selectedOptions[0]).toHaveTextContent('1.25x');
    expect(getByRole('option', { name: '1.25 times' })).toBeInTheDocument();
    expect(localStorage.getItem('voicePacePreference')).toBe('1.25');
  });

  it('keeps an old shipped number selected without rewriting it', () => {
    localStorage.setItem('voicePacePreference', '0.9');
    const { getByLabelText } = renderControl();
    expect(getByLabelText('Voice speed')).toHaveValue('0.9');
    expect(localStorage.getItem('voicePacePreference')).toBe('0.9');
  });

  it('saves a chosen number, and null for the character choice', () => {
    const { getByLabelText } = renderControl();
    const select = getByLabelText('Voice speed');
    fireEvent.change(select, { target: { value: '1.4' } });
    expect(localStorage.getItem('voicePacePreference')).toBe('1.4');
    fireEvent.change(select, { target: { value: '' } });
    expect(localStorage.getItem('voicePacePreference')).toBe('null');
  });

  it('has its explanation as the description, and no Fish or Inworld wording', () => {
    const { getByLabelText, container } = renderControl();
    expect(getByLabelText('Voice speed')).toHaveAccessibleDescription(
      expect.stringContaining('for every character'),
    );
    expect(container.textContent).not.toMatch(/Fish|Inworld|Brisk|Quick|Natural/);
  });
});
