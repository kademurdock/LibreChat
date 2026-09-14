import assert from 'node:assert/strict';
import { reviewedLibraryMoves } from './review';

const categories = ['book', 'commercials', 'radio', 'other'];
const move = { id: 'a61737cbbea74c6ca3c112cf', from: 'Video/Other', title: 'Pledge commercial', kind: 'video', to: 'Videos/Commercials/Cleaning', category: 'commercials', addTags: ['Cleaning', 'Cleaning'] };
const operation = reviewedLibraryMoves([move], categories)[0].updateOne;
assert.deepEqual(operation.filter, { _id: move.id, path: move.from, title: move.title, kind: 'video', state: 'ready' });
assert.deepEqual(operation.update, { $set: { path: move.to, category: 'commercials' }, $addToSet: { tags: { $each: ['Cleaning'] } } });
for (const to of ['Audio/Commercials', 'Videos/../Private', 'Videos//Cleaning', 'Videos/./Cleaning', 'Videos/Bad\\Folder', 'Videos/Bad\nFolder']) assert.throws(() => reviewedLibraryMoves([{ ...move, to }], categories));
assert.throws(() => reviewedLibraryMoves([{ ...move, category: 'book' }], categories));
assert.throws(() => reviewedLibraryMoves([{ ...move, addTags: [''] }], categories));
assert.throws(() => reviewedLibraryMoves([{ ...move, newTitle: ' ' }], categories));
assert.throws(() => reviewedLibraryMoves([move, { ...move, id: move.id.toUpperCase() }], categories));
assert.throws(() => reviewedLibraryMoves([], categories));
assert.throws(() => reviewedLibraryMoves(Array(501).fill(move), categories));
const audio = reviewedLibraryMoves([{ ...move, kind: 'audio', to: 'Audio/Radio', category: 'radio' }], categories)[0];
assert.equal(audio.updateOne.update.$set.path, 'Audio/Radio');
console.log('Reviewed library move validation passed; stale records require matching title, kind and folder.');
