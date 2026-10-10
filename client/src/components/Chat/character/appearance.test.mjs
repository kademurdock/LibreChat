import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { characterAppearanceKey } from './appearance.ts';
import * as portraits from './portrait-rig.mjs';

const translations = JSON.parse(readFileSync(new URL('../../../locales/en/translation.json', import.meta.url)));

test('all seven registered appearances have readable localized descriptions', () => {
  for (const name of ['ANGEL', 'KIANA', 'DELLA', 'HARLEY', 'LILLY', 'LILLY_PUBLIC', 'WITHERSPOON']) {
    const id = portraits[name + '_ID'];
    const path = '/uploads/' + portraits[name + '_PORTRAIT_FILE'];
    const key = characterAppearanceKey(id, path);
    assert.ok(key, name);
    assert.match(translations[key], /^In h(er|is) current/);
    assert.ok(translations[key].length > 100);
    assert.equal(characterAppearanceKey(id, path + '.replacement.png'), undefined);
    assert.equal(characterAppearanceKey('agent_unregistered', path), undefined);
  }
});

test('public Lilly cannot borrow the private Lilly avatar gate or vice versa', () => {
  assert.equal(characterAppearanceKey(portraits.LILLY_ID, portraits.LILLY_PUBLIC_PORTRAIT_FILE), undefined);
  assert.equal(characterAppearanceKey(portraits.LILLY_PUBLIC_ID, portraits.LILLY_PORTRAIT_FILE), undefined);
  assert.equal(characterAppearanceKey(portraits.KIANA_ID, 'https://['), undefined);
});
