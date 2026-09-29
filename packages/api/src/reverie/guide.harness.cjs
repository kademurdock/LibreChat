const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const {
  guideRoute,
  guideMatches,
  CANAL_STOPS,
  CANAL_PROJECTS,
  reverieSenses,
  reverieCanSwim,
} = require('@librechat/api');
const { MooRoom, MooChar, MooItem } = require('~/models/kadeMoo');
const { runCommand } = require('~/app/clients/tools/kademoo/life');
let checks = 0;
const check = (value, label) => {
  assert.ok(value, label);
  checks++;
  console.log('PASS', label);
};

(async () => {
  const db = await MongoMemoryServer.create();
  await mongoose.connect(db.getUri());
  const run = (command, userId = 'guide-a') =>
    runCommand({ userId, displayName: 'Canal Tester', command, isWizard: true, live: true });
  const current = (userId = 'guide-a') => MooChar.findOne({ userId, active: true }).lean();
  try {
    const park = { roomId: 'sweetwater_park', props: { outdoor: true } };
    check(
      reverieSenses(park, 'rain').surface === 'grass.wet',
      'rain wets the park lawn without turning it into mud',
    );
    check(
      reverieSenses(park, 'storm').footstep === 'move.step.grass.dry',
      'wet grass keeps a grassy cue rather than water footsteps',
    );
    check(
      reverieSenses({ ...park, props: { outdoor: true, surface: 'mud.shallow' } }, 'rain')
        .surface === 'mud.shallow',
      'explicit muddy ground still sounds muddy',
    );
    let r = await run('town');
    check(
      r.mode === 'create' && r.step === 'first',
      'the guide cannot accidentally become a new player name',
    );
    for (const user of ['guide-a', 'guide-b']) {
      await run('look', user);
      await MooChar.updateOne(
        { userId: user },
        {
          $set: {
            'attrs.life.created': true,
            'attrs.life.wiz': null,
            'attrs.life.needsAt': Date.now(),
          },
        },
      );
    }
    const rooms = await MooRoom.find({}).lean();
    await run('go to canal_overlook');
    const swimming = require('~/app/clients/tools/kademoo/life/registry').get('swim');
    const overlook = rooms.find((room) => room.roomId === 'canal_overlook');
    check(
      (await swimming.buttons({ room: async () => overlook })).length === 0,
      'railed canal overlooks do not offer swimming',
    );
    r = await run('swim');
    check(!r.ok && !r.kinds?.includes('splash'), 'canal swimming commands cannot splash');
    r = await run('shower');
    check(!r.ok && !r.kinds?.includes('splash'), 'washing cannot bypass canal access');
    check(reverieCanSwim({ roomId: 'the_pier' }), 'the existing Pier still permits swimming');
    check(
      CANAL_STOPS.every((stop) => rooms.some((room) => room.roomId === stop.id)),
      'all six places are seeded',
    );
    const inverse = { n: 's', s: 'n', e: 'w', w: 'e', ne: 'sw', sw: 'ne', nw: 'se', se: 'nw' };
    for (const stop of CANAL_STOPS) {
      const room = rooms.find((room) => room.roomId === stop.id);
      check(
        Object.entries(room.exits).every(
          ([dir, id]) =>
            rooms.find((room) => room.roomId === id)?.exits?.[inverse[dir]] === room.roomId,
        ),
        `${stop.id} has coherent reciprocal exits`,
      );
    }
    check(
      guideRoute(rooms, 'millrace_channel', 'garden_plots').length > 1,
      'the two neighborhoods connect',
    );
    r = await run('town make');
    check(
      r.choices.some((choice) => choice.cmd === 'route repair_hall') &&
        r.lines.some((line) => line.includes('Supplies are free')),
      'the activity guide explains useful destinations and cost',
    );
    await run('go to foundry_court');
    await run('route glass_canopy');
    check(
      (await current()).attrs.life.guide.destination === 'glass_canopy',
      'walking destination is persisted',
    );
    r = await run('walk route');
    check(
      r.ok && (await current()).roomId === 'canal_towpath',
      'guided movement crosses exactly one real exit',
    );
    check(
      !((await current()).attrs.life.guide.notes || {}).canal_towpath,
      'arriving alone does not complete a trail stop',
    );
    await run('read the water marks');
    check(
      (await current()).attrs.life.guide.notes.canal_towpath,
      'a meaningful local action saves the discovery',
    );
    await run('go to pats_diner');
    r = await run('route');
    check(
      r.guide.current === 'pats_diner' && r.guide.stops.at(-1).id === 'glass_canopy',
      'the saved route recalculates after a detour',
    );
    const origin = (await current()).roomId;
    r = await run('route canal');
    check(
      !r.guide && r.choices.length >= 2 && (await current()).roomId === origin,
      'ambiguous place names require a choice and never move the player',
    );
    await run('go to foundry_court');
    await run('route canal_towpath');
    r = await run('walk route');
    check(
      r.ok &&
        (await current()).roomId === 'canal_towpath' &&
        r.lines.some((line) => line.startsWith('You have reached')) &&
        !(await current()).attrs.life.guide.destination &&
        !r.hud.guide.destination &&
        !r.actions?.some((action) => action.cmd === 'route'),
      'arriving by the route puts the saved route away',
    );
    r = await run('route foundry_court');
    check(
      (await current()).attrs.life.guide.destination === 'foundry_court' &&
        r.actions.some((action) => action.cmd === 'route'),
      'a new route is saved, with its button, after arriving',
    );
    await run('go to foundry_court');
    check(
      !(await current()).attrs.life.guide.destination,
      'walking to the destination without the route also puts it away',
    );
    r = await run('route foundry_court');
    check(
      r.ok && !(await current()).attrs.life.guide.destination,
      'asking for a route to where you already stand saves nothing',
    );
    check(guideMatches(rooms, 'constructor').length === 0, 'prototype names are not destinations');
    r = await run('project constructor');
    check(
      r.ok && r.choices[0].cmd === 'projects',
      'invalid project ids do not execute object properties',
    );
    for (const [id, project] of Object.entries(CANAL_PROJECTS)) {
      await run(`go to ${project.room}`);
      const first = await run(`project ${id}`);
      check(
        first.choices.length > 0 && !(await current()).attrs.life.guide.projects?.[id],
        `${id}: looking at choices does not advance work`,
      );
      const pair = await Promise.all([run(`project ${id} 0 0`), run(`project ${id} 0 0`)]);
      check(
        pair.filter((result) => result.lines.some((line) => line.includes('Step 1 saved')))
          .length === 1,
        `${id}: simultaneous clicks advance one step only`,
      );
      await run('go to foundry_court');
      const away = await run(`project ${id} 1 0`);
      check(
        !away.lines.some((line) => line.includes('Step 2 saved')) &&
          (await current()).attrs.life.guide.projects[id].stage === 1,
        `${id}: work cannot continue from another room`,
      );
      await run(`go to ${project.room}`);
      await run(`project ${id} 1 0`);
      r = await run(`project ${id} 2 0`);
      check(
        r.ok && r.lines.some((line) => line.startsWith('Finished:')),
        `${id}: returning resumes and finishes the project`,
      );
      await run(`project ${id} 2 0`);
      const ch = await current();
      const itemId = `canal_${ch._id}_${id}`;
      check(
        (await MooItem.countDocuments({ itemId })) === 1,
        `${id}: retrying completion cannot duplicate the keepsake`,
      );
      if (project.finishes)
        check(
          (await MooItem.findOne({ itemId }).lean()).desc.includes(project.finishes[0]),
          `${id}: the chosen finish stays with the kept item`,
        );
      await MooItem.updateOne(
        { itemId },
        { $set: { location: { type: 'room', id: project.room } } },
      );
      await run(`project ${id}`);
      check(
        (await MooItem.findOne({ itemId }).lean()).location.type === 'room',
        `${id}: revisiting cannot take back an item left in the world`,
      );
      await MooItem.deleteOne({ itemId });
      await MooChar.updateOne(
        { userId: 'guide-a' },
        { $unset: { [`attrs.life.guide.projects.${id}.delivered`]: '' } },
      );
      await run(`project ${id}`);
      check(
        (await MooItem.countDocuments({ itemId })) === 1 &&
          (await current()).attrs.life.guide.projects[id].delivered === true,
        `${id}: a revisit still hands over a piece that never arrived`,
      );
      await MooItem.deleteOne({ itemId });
      r = await run(`project ${id}`);
      check(
        r.ok && (await MooItem.countDocuments({ itemId })) === 0,
        `${id}: a piece that was pawned or lost is not made again for free`,
      );
    }
    /* the Canal Towpath note was read above; start the walk with a fresh pause */
    await MooChar.updateOne({ userId: 'guide-a' }, { $unset: { 'attrs.life.authoredAt': '' } });
    for (const stop of CANAL_STOPS) {
      await run(`go to ${stop.id}`);
      r = await run(stop.command);
      check(r.ok, `trail activity runs at ${stop.id}, right after the last stop`);
    }
    r = await run(CANAL_STOPS.at(-1).command);
    check(!r.ok, 'repeating the same stop right away still waits');
    r = await run('notebook');
    check(
      r.lines.some((line) => line.startsWith('Canal trail complete')) &&
        r.hud.guide.completed === 6,
      'all six discoveries form a saved completed notebook',
    );
    r = await run('notebook', 'guide-b');
    check(
      r.hud.guide.completed === 0 && !r.lines.some((line) => line.startsWith('Made:')),
      'another player cannot see private discoveries or project progress',
    );
    const graph = [
      {
        roomId: 'a',
        name: 'Public A',
        district: 'gate',
        exits: { n: 'private', e: 'b', s: 'missing' },
      },
      {
        roomId: 'private',
        name: 'Secret Home',
        district: 'gate',
        exits: { e: 'c' },
        props: { home: {} },
      },
      {
        roomId: 'b',
        name: 'Public B',
        district: 'gate',
        exits: { e: 'c' },
        props: { locks: { e: true } },
      },
      { roomId: 'c', name: 'Public C', district: 'gate', exits: {} },
    ];
    check(
      guideRoute(graph, 'a', 'c') === null,
      'routes cannot cross a private home, locked door, or missing room',
    );
    check(guideMatches(graph, 'secret').length === 0, 'the guide never lists private homes');
    check(
      guideRoute(graph, 'private', 'c').length === 2,
      'a player can leave their current home for a public destination',
    );
    await MooRoom.updateOne(
      { roomId: 'foundry_court' },
      { $set: { desc: 'Founder custom prose', 'exits.e': 'pats_diner' } },
    );
    await require('~/app/clients/tools/kademoo/life/authored').seed();
    const kept = await MooRoom.findOne({ roomId: 'foundry_court' }).lean();
    check(
      kept.desc === 'Founder custom prose' && kept.exits.e === 'pats_diner',
      're-seeding preserves Founder edits',
    );
    console.log(`Guide and canal: ${checks} checks passed.`);
  } finally {
    await mongoose.disconnect();
    await db.stop();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
