const fs = require('node:fs');
const path = require('node:path');
const { compileReverie, reverieForecast } = require('@librechat/api');
const { register, get } = require('./registry');
const { MooRoom, MooChar } = require('./ctx');

const world = compileReverie(
  fs.readFileSync(path.join(__dirname, '../world/waterfront.rev'), 'utf8'),
);

async function seed() {
  const destinations = new Set(world.places.map((room) => room.roomId));
  const required = new Set(world.links.map((link) => link.roomId));
  for (const link of world.links)
    if (!destinations.has(link.destination)) required.add(link.destination);
  for (const room of world.places)
    for (const id of Object.values(room.exits)) if (!destinations.has(id)) required.add(id);
  const existing = await MooRoom.find({ roomId: { $in: [...required] } })
    .select('roomId')
    .lean();
  if (existing.length !== required.size)
    throw new Error('Waterfront has a missing connector room.');
  for (const room of world.places)
    await MooRoom.updateOne(
      { roomId: room.roomId },
      { $setOnInsert: { ...room, createdBy: 'reverie_seed' } },
      { upsert: true },
    );
  for (const link of world.links)
    await MooRoom.updateOne(
      { roomId: link.roomId, [`exits.${link.direction}`]: { $exists: false } },
      { $set: { [`exits.${link.direction}`]: link.destination } },
    );
}

for (const action of world.actions) {
  if (get(action.command)) throw new Error('Authored action conflicts with an existing verb.');
  register({
    name: action.command,
    when: (ctx) => ctx.ch.roomId === action.roomId,
    help: { topic: 'fun', usage: action.command, blurb: action.label },
    buttons: (ctx) =>
      ctx.ch.roomId === action.roomId
        ? [{ label: action.label, cmd: action.command, group: 'here' }]
        : [],
    async run(ctx) {
      const now = Date.now();
      const claimed = await MooChar.updateOne(
        {
          _id: ctx.ch._id,
          active: true,
          roomId: action.roomId,
          $or: [
            { 'attrs.life.waterfrontAt': { $exists: false } },
            { 'attrs.life.waterfrontAt': { $lte: now - 15000 } },
          ],
        },
        { $set: { 'attrs.life.waterfrontAt': now } },
      );
      if (!claimed.modifiedCount)
        return ctx.fail('Take a moment to enjoy being here before trying again.');
      await ctx.emit(
        action.roomId,
        ctx.userId,
        ctx.ch.name,
        'emote',
        `${ctx.ch.name} ${action.event}`,
        action.sound,
      );
      ctx.say(action.line).sound(action.sound).need({ fun: 4, rested: 4 });
      return ctx.ok();
    },
  });
}

register({
  name: 'forecast',
  aliases: ['weather forecast'],
  free: true,
  help: {
    topic: 'senses',
    usage: 'forecast',
    blurb: 'The city sky now and over the next twelve hours.',
  },
  buttons: () => [{ label: 'Weather forecast', cmd: 'forecast', group: 'self' }],
  async run(ctx) {
    ctx.say(...reverieForecast());
    return ctx.ok();
  },
});
register({
  name: 'waterfront',
  free: true,
  help: {
    topic: 'moving',
    usage: 'waterfront',
    blurb: 'Find the connected river walk between the Hook and Sweetwater.',
  },
  buttons: () => [{ label: 'River walk', cmd: 'waterfront', group: 'move' }],
  async run(ctx) {
    ctx.say(
      'Follow the river from the Hook ferry landing through Ropewalk and the Reed Pavilion to Sweetwater Park. The Net Loft is a sheltered place to gather along the way.',
    );
    return ctx.ok({
      choices: world.places.map((room) => ({ label: room.name, cmd: `go to ${room.roomId}` })),
    });
  },
});

module.exports = { seed, world };
