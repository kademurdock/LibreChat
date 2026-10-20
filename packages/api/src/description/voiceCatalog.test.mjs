import assert from 'node:assert/strict';
import test from 'node:test';
import { narratorLabel, retainedNarrators, sameNarrator } from './voiceCatalog.ts';
const catalog = { voices: ['Clear warm voice · cedarbrook'], hidden: ['Voice 1', 'Old narrator'], aliases: ['Kiana'], renames: { 'Voice 2': 'Old narrator' } };
test('new video choices exclude retained narrators while saved video/default voices remain valid', () => {
  assert.equal(narratorLabel(catalog, 'Voice 1'), undefined);
  assert.equal(narratorLabel(catalog, 'Voice 1', true), 'Voice 1');
  assert.equal(narratorLabel(catalog, 'Kiana', true), 'Kiana');
  assert.equal(narratorLabel(catalog, catalog.voices[0]), catalog.voices[0]);
  assert.equal(narratorLabel(catalog, 'made-up narrator', true), undefined);
});
test('an older saved spelling maps to the same retained voice without joining visible choices', () => {
  assert.equal(narratorLabel(catalog, 'Voice 2', true), 'Old narrator');
  assert.equal(narratorLabel(catalog, 'Voice 2'), undefined);
  assert.deepEqual(retainedNarrators(catalog), ['Voice 1', 'Old narrator', 'Kiana']);
  assert.deepEqual(catalog.voices, ['Clear warm voice · cedarbrook']);
});
test('a stored catalog number finds its Inworld voice under the Classic spelling (Oct 15 2026 picker)', () => {
  const live = {
    voices: ['Spotlight Comet', 'Kade (HQ)', 'clear woman · flint (Classic)', 'Kade Professional (Classic)'],
    hidden: ['clear woman · flint', 'Kade Professional', 'Voice 541'],
    renames: { 'Voice 650': 'clear woman · flint', 'Voice 541': 'Kade Professional' },
    fish: ['Spotlight Comet', 'Kade (HQ)'],
  };
  assert.equal(narratorLabel(live, 'Voice 541'), 'Kade Professional (Classic)');
  assert.equal(narratorLabel(live, 'Voice 650'), 'clear woman · flint (Classic)');
  assert.equal(narratorLabel(live, 'clear woman · flint'), 'clear woman · flint (Classic)');
  assert.equal(narratorLabel(live, 'Voice 541', true), 'Voice 541', 'a saved job keeps its retained spelling');
  assert.equal(narratorLabel(live, 'Voice 999'), undefined);
  assert.equal(sameNarrator('clear woman · flint', 'clear woman · flint (Classic)'), true);
  assert.equal(sameNarrator('clear woman · flint', 'Spotlight Comet'), false);
});
