import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVoiceLabel, reconcileVoiceSelection } from './voiceLabels.ts';

const voices = ['clear warm voice · cedarbrook', 'bright voice · silversky'];
test('a retained Inworld selection survives the Fish-only picker', () => {
  assert.equal(normalizeVoiceLabel('Voice 69', voices, {}, ['Voice 69']), 'Voice 69');
  assert.equal(reconcileVoiceSelection('Voice 69', voices, {}, ['Voice 69'], true), 'Voice 69');
  assert.deepEqual(voices, ['clear warm voice · cedarbrook', 'bright voice · silversky']);
});
test('a saved voice is preserved during failed or incomplete metadata loading', () => {
  assert.equal(reconcileVoiceSelection('saved label', voices, undefined, undefined, false), 'saved label');
  assert.equal(reconcileVoiceSelection('saved label', voices, undefined, undefined, true), 'saved label');
});
test('new users get a new visible voice after catalog loading', () => {
  assert.equal(reconcileVoiceSelection(undefined, voices, {}, [], false), undefined);
  assert.equal(reconcileVoiceSelection(undefined, voices, {}, [], true), voices[0]);
  assert.equal(reconcileVoiceSelection('', voices, {}, [], true), voices[0]);
});
test('an old spelling still maps to its retained equivalent', () => {
  assert.equal(normalizeVoiceLabel('Voice 340 (Beta)', voices, {'Voice 340 (Beta)': 'retired label'}, ['retired label']), 'retired label');
});
test('current picks and empty catalogs never change a saved selection', () => {
  assert.equal(reconcileVoiceSelection(voices[1], voices, {}, [], true), voices[1]);
  assert.equal(reconcileVoiceSelection('old Fish', [], {}, [], true), 'old Fish');
});
