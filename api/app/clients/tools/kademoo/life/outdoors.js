const { REVERIE_OUTDOORS, reverieSenses, outdoorEncounter } = require('@librechat/api');
const { register } = require('./registry');
const { MooRoom, MooChar, makeItem, setAttrs, worldClock } = require('./ctx');

async function seed() {
  for (const room of REVERIE_OUTDOORS)
    await MooRoom.updateOne(
      { roomId: room.roomId },
      { $setOnInsert: { ...room, createdBy: 'reverie_seed' } },
      { upsert: true },
    );
  for (const [roomId, dir, dest] of [
    ['tandy_orchard', 'n', 'alder_trail'],
    ['the_lake_dock', 'n', 'reedbank_creek'],
  ]) {
    await MooRoom.updateOne(
      { roomId, [`exits.${dir}`]: { $exists: false } },
      { $set: { [`exits.${dir}`]: dest } },
    );
  }
}
const nature = async (ctx) => reverieSenses(await ctx.room()).nature;
register({
  name: 'notice',
  aliases: ['surroundings'],
  free: true,
  help: {
    topic: 'senses',
    usage: 'notice',
    blurb: 'Hear the room, its smells, and the ground beneath you in a few plain sentences.',
  },
  buttons: async () => [{ label: 'Notice surroundings', cmd: 'notice', group: 'here' }],
  async run(ctx) {
    const room = await ctx.room();
    const senses = reverieSenses(room, require('../reverie').weatherNow().kind, worldClock().dark);
    ctx.say(room.props?.listenLine, room.props?.smell, senses.texture);
    return ctx.ok();
  },
});
register({
  name: 'explore',
  aliases: ['outdoors'],
  free: true,
  help: {
    topic: 'fun',
    usage: 'explore',
    blurb: 'Find the trail, creek, campsite, and optional wildlife activities.',
  },
  buttons: async () => [{ label: 'Explore outdoors', cmd: 'explore', group: 'move' }],
  async run(ctx) {
    return ctx.ok({
      lines: [
        ...ctx.lines,
        'Beyond Tandy Orchard: a woodland trail, creek, campsite, and wildlife hide. Choose a destination; directions and buttons both work. Easy fishing has no reaction timer.',
      ],
      choices: REVERIE_OUTDOORS.map((r) => ({ label: r.name, cmd: `go to ${r.roomId}` })),
    });
  },
});
for (const name of ['track wildlife', 'photograph wildlife', 'rest by fire'])
  register({
    name,
    help: {
      topic: 'fun',
      usage: name,
      blurb: 'Take your time outdoors and keep the small discoveries in your field journal.',
    },
    when: name === 'rest by fire' ? async (ctx) => ctx.ch.roomId === 'alder_camp' : nature,
    buttons: async (ctx) =>
      (name === 'rest by fire' ? ctx.ch.roomId === 'alder_camp' : await nature(ctx))
        ? [{ label: name[0].toUpperCase() + name.slice(1), cmd: name, group: 'here' }]
        : [],
    async run(ctx) {
      const now = Date.now();
      const stamp = name === 'rest by fire' ? 'attrs.life.campRestAt' : 'attrs.life.fieldAt';
      const claimed = await MooChar.updateOne(
        {
          _id: ctx.ch._id,
          $or: [{ [stamp]: { $exists: false } }, { [stamp]: { $lte: now - 20000 } }],
        },
        { $set: { [stamp]: now } },
      );
      if (!claimed.modifiedCount)
        return ctx.fail(
          'Take a moment to enjoy this spot. You can make another discovery in a few seconds.',
        );
      const count = ctx.life.fieldCount || 0;
      const out = outdoorEncounter(name, count, worldClock().dark);
      await setAttrs(ctx.ch, {
        'life.fieldCount': count + 1,
        'life.fieldJournal': [
          ...(ctx.life.fieldJournal || []),
          `${(await ctx.room()).name}: ${out.line}`,
        ].slice(-20),
      });
      ctx
        .need({ fun: out.fun, rested: out.rested })
        .learn(out.skill, 2)
        .sound(out.sound)
        .say(out.line);
      return ctx.ok();
    },
  });
register({
  name: 'field journal',
  free: true,
  help: {
    topic: 'fun',
    usage: 'field journal',
    blurb: 'Read your last twenty outdoor discoveries.',
  },
  buttons: async (ctx) =>
    (await nature(ctx)) ? [{ label: 'Field journal', cmd: 'field journal', group: 'here' }] : [],
  async run(ctx) {
    return ctx.ok({
      lines: [
        ...ctx.lines,
        ...(ctx.life.fieldJournal?.length
          ? ctx.life.fieldJournal
          : ['Your journal is empty. Try track wildlife on Alder Trail.']),
      ],
    });
  },
});
register({
  name: 'easy fish',
  aliases: ['fish'],
  free: true,
  help: {
    topic: 'fishing',
    usage: 'easy fish · easy fish keep · easy fish release',
    blurb:
      'Borrow a pole and fish at your pace. No reaction timer or equipment purchase. Keep or release your catch.',
  },
  when: async (ctx) =>
    ['river', 'lake', 'harbor', 'deep'].includes((await ctx.room())?.props?.water),
  whyNot: async () => 'Find fishing water first. Try go to Reedbank Creek or go to Pier Seven.',
  buttons: async (ctx) => {
    if (!['river', 'lake', 'harbor', 'deep'].includes((await ctx.room())?.props?.water)) return [];
    if (ctx.life.easyCatch)
      return [
        { label: 'Keep fish', cmd: 'easy fish keep', group: 'here' },
        { label: 'Release fish', cmd: 'easy fish release', group: 'here' },
      ];
    return [{ label: 'Easy fishing', cmd: 'easy fish', group: 'here' }];
  },
  async run(ctx, { arg }) {
    if (ctx.ch.attrs?.fishing)
      return ctx.fail('Reel in your current line before borrowing an easy-fishing pole.');
    if (arg && !['keep', 'release'].includes(arg))
      return ctx.fail('Choose easy fish, easy fish keep, or easy fish release.');
    if (arg) {
      const before = await MooChar.findOneAndUpdate(
        { _id: ctx.ch._id, 'attrs.life.easyCatch': { $ne: null } },
        { $set: { 'attrs.life.easyCatch': null } },
        { new: false },
      );
      const caught = before?.attrs?.life?.easyCatch;
      if (!caught) return ctx.fail('You have no easy-fishing catch waiting. Try easy fish.');
      if (arg === 'keep')
        await makeItem({
          name: caught.name,
          desc: 'A fresh catch from a quiet afternoon by the water.',
          location: { type: 'char', id: ctx.ch.userId },
          props: { fish: true, ingredient: 'fish', pay: caught.pay, lbs: 1 },
        });
      ctx
        .sound(arg === 'keep' ? 'fish.land.slap.wood' : 'fish.release')
        .say(
          arg === 'keep'
            ? `You keep ${caught.name}. It is in your pockets; cook a fish fry or sell it at the Shack.`
            : `You lower ${caught.name} into the water and let it swim away.`,
        );
      return ctx.ok();
    }
    if (ctx.life.easyCatch)
      return ctx.ok({
        lines: [
          ...ctx.lines,
          `${ctx.life.easyCatch.name} is waiting. Choose keep or release; there is no timer.`,
        ],
        choices: [
          { label: 'Keep', cmd: 'easy fish keep' },
          { label: 'Release', cmd: 'easy fish release' },
        ],
      });
    const now = Date.now();
    const room = await ctx.room();
    const catchList =
      room.props.water === 'harbor' || room.props.water === 'deep'
        ? [
            { name: 'a croaker', pay: 2 },
            { name: 'a flounder', pay: 4 },
          ]
        : [
            { name: 'a bluegill', pay: 1 },
            { name: 'a crappie', pay: 2 },
            { name: 'a channel cat', pay: 3 },
          ];
    const caught = catchList[(ctx.life.easyFishCount || 0) % catchList.length];
    const claimed = await MooChar.updateOne(
      {
        _id: ctx.ch._id,
        'attrs.life.easyCatch': null,
        $or: [
          { 'attrs.life.easyFishAt': { $exists: false } },
          { 'attrs.life.easyFishAt': { $lte: now - 60000 } },
        ],
      },
      {
        $set: { 'attrs.life.easyFishAt': now, 'attrs.life.easyCatch': caught },
        $inc: { 'attrs.life.easyFishCount': 1 },
      },
    );
    if (!claimed.modifiedCount)
      return ctx.fail('The water settles after your last cast. Try again in a minute.');
    ctx
      .need({ fun: 8, rested: 2 })
      .learn('fishing', 3)
      .sound('fish.bite.take')
      .say(
        `You borrow a pole, settle by the water, and cast. After a quiet wait, a firm tug bends the tip. You guide ${caught.name} into the shallows. Keep or release it whenever you are ready.`,
      );
    return ctx.ok({
      choices: [
        { label: 'Keep fish', cmd: 'easy fish keep' },
        { label: 'Release fish', cmd: 'easy fish release' },
      ],
    });
  },
});
register({
  name: 'hunt',
  free: true,
  help: {
    topic: 'fun',
    usage: 'hunt · hunt rabbit',
    blurb:
      'Optional small-game bow hunting at Alder Hide. Tracking and photographs are also available.',
  },
  when: async (ctx) => ctx.ch.roomId === 'alder_hide',
  whyNot: async () => 'Small-game hunting is only available at Alder Hide. Try go to Alder Hide.',
  buttons: async (ctx) =>
    ctx.ch.roomId === 'alder_hide'
      ? [{ label: 'Hunting choices', cmd: 'hunt', group: 'here' }]
      : [],
  async run(ctx, { arg }) {
    if (!arg)
      return ctx.ok({
        lines: [
          ...ctx.lines,
          'A loaner bow hangs inside the hide. You can hunt a wild rabbit for food, track animals, or take field photographs. No quick reactions are needed.',
        ],
        choices: [
          { label: 'Hunt rabbit for food', cmd: 'hunt rabbit' },
          { label: 'Track wildlife', cmd: 'track wildlife' },
          { label: 'Photograph wildlife', cmd: 'photograph wildlife' },
        ],
      });
    if (arg !== 'rabbit')
      return ctx.fail(
        'Only wild rabbits on the marked small-game ground can be hunted. Choose hunt rabbit, track wildlife, or photograph wildlife.',
      );
    const now = Date.now();
    const claimed = await MooChar.updateOne(
      {
        _id: ctx.ch._id,
        $or: [
          { 'attrs.life.huntAt': { $exists: false } },
          { 'attrs.life.huntAt': { $lte: now - 300000 } },
        ],
      },
      { $set: { 'attrs.life.huntAt': now } },
    );
    if (!claimed.modifiedCount)
      return ctx.fail('You have taken enough for now. The clearing needs a few quiet minutes.');
    await makeItem({
      name: 'prepared rabbit meat',
      desc: 'Small game prepared at the hide, ready for the cooking pot.',
      location: { type: 'char', id: ctx.ch.userId },
      props: { ingredient: 'meat' },
    });
    ctx
      .need({ fun: 3 })
      .learn('fitness', 2)
      .sound('hunt.bow')
      .say(
        'You follow a rabbit’s tracks, wait for a clear shot, and take it with the loaner bow. You prepare the meat at the hide and pack it for cooking. The borrowed gear goes back on its hooks.',
      );
    return ctx.ok();
  },
});
module.exports = { seed };
