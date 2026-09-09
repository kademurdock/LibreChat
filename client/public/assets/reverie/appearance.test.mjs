import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneModel, figureAppearance, figurePosition, describePicture } from './presentation.mjs';

test('chosen features affect the figure without using pronouns as appearance', () => {
  const person = {
    id: 'test',
    appearance: { build: 'tall and lean', hair: 'locs', style: 'hoodie and headphones' },
  };
  const a = figureAppearance(person);
  assert.equal(a.hair, 'locks');
  assert.ok(a.height > 1 && a.width < 1);
  assert.equal(a.headphones, true);
  assert.deepEqual(a, figureAppearance({ ...person, pronouns: 'she' }));
  assert.equal(
    figureAppearance({ appearance: { hair: 'a shaved head', style: 'sundresses and sneakers' } })
      .outfit,
    'dress',
  );
  assert.equal(figureAppearance({ appearance: { hair: 'a shaved head' } }).hair, 'bald');
});
test('gathering follows the engine guest names and public appearance survives scene conversion', () => {
  const room = {
    name: 'Diner',
    peopleDetail: [
      { id: 'b', name: 'Pat' },
      { id: 'a', name: 'Mira' },
    ],
    hangout: { title: 'Record night', guests: ['Alex', 'Pat'] },
  };
  const hud = {
    name: 'Alex',
    characterId: 'owner',
    appearance: { hair: 'a bun', build: 'solid', style: 'a good coat, always' },
  };
  const m = sceneModel(room, hud);
  assert.equal(m.people[0].id, 'owner');
  assert.equal(m.people[1].id, 'a');
  assert.equal(figurePosition(m, m.people[0], 0).gathering, true);
  assert.equal(figurePosition(m, m.people[1], 1).gathering, false);
  assert.equal(figurePosition(m, m.people[2], 2).gathering, true);
  assert.match(describePicture(m), /Alex: solid, a bun/);
  assert.match(describePicture(m), /colors and unchosen details are artistic/);
});
