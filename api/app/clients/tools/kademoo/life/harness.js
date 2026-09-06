/* Run with the repository's dependencies and mongodb-memory-server available.
 * Uses a disposable local MongoDB, the real engine and real models. No AI calls.
 * node api/app/clients/tools/kademoo/life/harness.js */
const assert = require('node:assert/strict');
const path = require('node:path');
require('module-alias').addAlias('~', path.resolve(__dirname, '../../../../..'));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
process.env.REVERIE_FAST = '1';

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  let checks = 0;
  function check(condition, message) { assert.ok(condition, message); checks++; console.log('PASS', message); }
  try {
    const { runCommand, registry } = require('./index');
    const { MooChar, MooEvent, nextSeq } = require('~/models/kadeMoo');
    const engine = require('../engine');
    const run = (command, userId = 'fixture-a', extra = {}) => runCommand({ userId, displayName: 'Alex Example', command, isWizard: true, ...extra });
    let r = await run('look');
    check(r.mode === 'create' && r.step === 'first', 'a new full-name account enters character creation');
    for (const command of ['Ruby', 'Tester', '1', '2', '1', '1', '1', '1', '4', '1', '1', 'yes']) r = await run(command);
    check(r.ok && r.mode === 'play' && r.hud.name === 'Ruby Tester', 'the complete creation wizard enters the city');
    let ch = await MooChar.findOne({ userId: 'fixture-a', active: true });
    const originalId = String(ch._id);
    await MooChar.updateOne({ _id: ch._id }, { $set: { 'attrs.coin': 70, 'attrs.life.skills.learning': 200 } });
    await run('remake me');
    r = await run('back');
    check(r.step === 'pronouns', 'remake cannot back into the name or origin questions');
    r = await run('start over');
    check(r.step === 'pronouns', 'restart preserves the remake context');
    r = await run('cancel');
    ch = await MooChar.findOne({ userId: 'fixture-a', active: true });
    check(ch && String(ch._id) === originalId && ch.attrs.coin === 70 && r.hud.name === ch.name, 'cancel remake preserves the same character, money and displayed state');
    await run('remake me');
    for (const command of ['1', '2', '1', '1', '1', '4', '1', '1', 'yes']) r = await run(command);
    ch = await MooChar.findOne({ userId: 'fixture-a', active: true });
    check(r.mode === 'play' && ch.attrs.life.skills.learning === 200 && ch.attrs.coin === 70, 'finishing a remake preserves earned skills and money');
    r = await run('@tp the_pier');
    ch = await MooChar.findOne({ userId: 'fixture-a', active: true });
    check(r.room.roomId === 'the_pier' && r.room.roomId === ch.roomId && r.hud.roomName === r.room.name, 'an old-engine move returns the saved room and matching HUD');
    await run('newchar');
    r = await run('cancel');
    check(await MooChar.countDocuments({ userId: 'fixture-a' }) === 1 && r.hud.name === 'Ruby Tester', 'cancel a new character restores the existing character and HUD');
    ch = await MooChar.findOne({ userId: 'fixture-a', active: true });
    await engine.collectMeanwhile(ch);
    for (let i = 0; i < 30; i++) await engine.emit(ch.roomId, 'fixture-b', 'Bea', 'say', 'Backlog ' + i);
    r = await run('status');
    const first = (r.meanwhile || []).filter((e) => e.text.startsWith('Backlog '));
    r = await run('status');
    const second = (r.meanwhile || []).filter((e) => e.text.startsWith('Backlog '));
    check(first.length === 25 && second.length === 5, 'a 30-message backlog is delivered across turns without loss');
    registry.register({ name: 'fixture slow', hidden: true, free: true, async run(ctx) {
      // This independent writer simulates a friend posting during the turn.
      await MooEvent.create({ seq: await nextSeq(), roomId: ctx.ch.roomId, actorUserId: 'fixture-b', actorName: 'Bea', kind: 'say', text: 'Arrived during command' });
      return ctx.ok();
    } });
    await run('fixture slow');
    r = await run('status');
    check((r.meanwhile || []).some((e) => e.text === 'Arrived during command'), 'a message arriving during a command survives for the next turn');
    await run('go to pats');
    r = await run('talk to Pat');
    check(r.ok, 'the legacy citizen conversation still works');
    const ownSeqs = r.seenSeqs || [];
    r = await run('status');
    check(!r.meanwhile || !r.meanwhile.some((e) => (e.text || '').includes('Pat')), 'a citizen reply already returned is not repeated next turn');
    check(ownSeqs.length > 0, 'the response identifies only events created by its own command');
    ch = await MooChar.findOne({ userId: 'fixture-a', active: true });
    const beforeCursor = ch.lastSeenSeq;
    await engine.emit(ch.roomId, 'fixture-b', 'Bea', 'say', 'Live friend message');
    await run('say hello', 'fixture-a', { live: true });
    ch = await MooChar.findOne({ userId: 'fixture-a', active: true });
    check(ch.lastSeenSeq === beforeCursor, 'an old-engine live command does not consume the stream backlog');
    const reverie = require('../reverie');
    const originalTick = reverie.tickWorld;
    let ambient;
    try {
      reverie.tickWorld = async () => { ambient = await engine.emit(ch.roomId, 'fixture-citizen', 'Citizen', 'say', 'City activity during a live turn'); };
      r = await run('status', 'fixture-a', { live: true });
    } finally { reverie.tickWorld = originalTick; }
    ch = await MooChar.findOne({ userId: 'fixture-a', active: true });
    check(!(r.seenSeqs || []).includes(ambient.seq) && !(ch.attrs.seenEventSeqs || []).includes(ambient.seq), 'city tick events remain available to the live room');
    await MooChar.create({ userId: 'fixture-legacy', name: 'Legacy Soul', roomId: 'city_gate', active: true, attrs: { coin: 99, desc: 'Here before Life.' } });
    r = await run('look', 'fixture-legacy');
    check(r.mode === 'play' && r.hud.coin === 99 && r.hud.name === 'Legacy Soul', 'existing characters are still adopted in place');
    console.log(`Reverie: ${checks} regression checks passed.`);
  } finally { await mongoose.disconnect(); await mongo.stop(); }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
