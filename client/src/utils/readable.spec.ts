import { toReadableText, stripHiddenMarkup } from './readable';

const TAG = '%'.repeat(3);

describe('toReadableText (WEB-4)', () => {
  it('drops voice tags, cues, citations, reasoning and markdown', () => {
    expect(
      toReadableText(
        `${TAG}warm${TAG} ## Plan\n**Bring** a coat.turn0search1 [sound:card_deal]\n:::thinking secret:::\n`,
      ),
    ).toBe('Plan\nBring a coat.');
  });

  it('drops inline think tags and single emphasis, keeps snake_case and maths', () => {
    expect(
      toReadableText(
        'Hi <think>secret **plan**</think>there *really* and _so_ snake_case_name 2 * 3 * 4.',
      ),
    ).toBe('Hi there really and so snake_case_name 2 * 3 * 4.');
  });

  it('collapses the blank lines a removed cue leaves, keeps image alt text, drops quote marks', () => {
    expect(
      toReadableText(
        `A\n\n[sound:x_y]\n\n${TAG}soft${TAG}\n\nB ![cat](http://x/y.png)\n> q2\n* item\n- *it*`,
      ),
    ).toBe('A\n\nB cat\nq2\n- item\n- it');
  });

  it('returns an empty string for empty input', () => {
    expect(toReadableText('')).toBe('');
  });
});

describe('stripHiddenMarkup', () => {
  it('leaves citation markers for the clipboard to number', () => {
    expect(stripHiddenMarkup('This is a fact turn0search0 from search.')).toBe(
      'This is a fact turn0search0 from search.',
    );
  });

  it('removes a multi-line reasoning block before the prose pass', () => {
    expect(
      stripHiddenMarkup(':::thinking\n**a**\n:::\nAnswer **bold** `code` [link](http://a).'),
    ).toBe('Answer bold code link.');
  });
});
