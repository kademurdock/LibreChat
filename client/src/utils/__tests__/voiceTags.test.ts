import fs from 'fs';
import path from 'path';
import { stripVoiceTags, hideDanglingVoiceTag } from '../voiceTags';

const live = (t: string) => hideDanglingVoiceTag(stripVoiceTags(t, true));

describe('stripVoiceTags pairs %%% runs by shape (WEB-12)', () => {
  it.each([
    [
      "Two different problems.\n\n%%%\n%%%warm and curious%%% So what's the shape of it?",
      "So what's the shape of it?",
      'warm and curious',
    ],
    ['%%%sigh%% Okay so I think %%%laughs%%% more', 'Okay so I think more', 'laughs'],
    ['%%%warm Hello there. How was the drive?', 'Hello there. How was the drive?', 'warm'],
    ['curious%%% So what is the shape of it?', 'So what is the shape of it?', 'curious'],
    ['%%%pleased%%% That went well. %%%wry%%% Mostly.', 'That went well. Mostly.', 'wry'],
  ])('%j', (input, kept, gone) => {
    const out = stripVoiceTags(input);
    expect(out).not.toContain('%');
    expect(out).toContain(kept);
    expect(out).not.toContain(gone);
  });

  it('keeps doubled percent signs inside code and single percentages in prose', () => {
    expect(stripVoiceTags('Use `printf("%%d", n)` to print a percent.')).toBe(
      'Use `printf("%%d", n)` to print a percent.',
    );
    expect(
      stripVoiceTags('%%%warm%%% Sure.\n\n```bat\nfor %%i in (*.txt) do echo %%i\n```\nDone.'),
    ).toContain('for %%i in (*.txt) do echo %%i');
    expect(stripVoiceTags('%%%warm%%% It went up 50% and then 20%.')).toBe(
      'It went up 50% and then 20%.',
    );
  });

  it.each([
    [
      '%%%warm and curious%%% So what is it? I sat down, %%%wry%%% and laughed.',
      ['warm', 'curious', 'wry'],
    ],
    ['Hello.\n\n%%%like she is sharing a secret%%% Come closer.', ['like she', 'secret']],
    ['%%%soft. slower now%%% Hello there, friend.', ['soft', 'slower']],
    ['%%%so very excited%%% We did it!', ['so very', 'excited']],
    ['%%%nostalgic%%% I remember that.', ['no']],
    [
      "Two different problems.\n\n%%%\n%%%warm and curious%%% So what's the shape of it?",
      ['warm', 'curious'],
    ],
  ])('never shows a tag while %j streams in', (full, words) => {
    for (let n = 1; n <= full.length; n++) {
      const shown = live(full.slice(0, n));
      expect(shown).not.toContain('%%');
      for (const w of words as string[]) {
        expect(shown).not.toContain(w);
      }
    }
  });

  it('shows the speech of a forgotten closer while it streams', () => {
    expect(live('%%%warm Hello there. How was')).toBe('Hello there. How was');
    expect(live('%%%warm%%%Hello there. How are')).toBe('Hello there. How are');
  });

  it('steeringBalance.js is still the generated copy of the server file (the pin)', () => {
    const read = (p: string) =>
      fs.readFileSync(path.join(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
    const server = read('../../../../api/server/utils/steeringBalance.js')
      .replace(/^'use strict';\n/, '')
      .replace(/module\.exports = \{([^}]*)\};\s*$/, 'export {$1};\n');
    const client = read('../steeringBalance.js')
      .replace(/^\/\* eslint-disable \*\/\n\/\/ GENERATED[^\n]*\n/, '')
      .replace(
        "globalThis.process?.env?.KADE_STEERING_BALANCE === '0'",
        "process.env.KADE_STEERING_BALANCE === '0'",
      );
    expect(client).toBe(server); // differs? run: node scripts/sync-steering-balance.mjs
  });
});
