const {
  GULLY_LAUNDRY,
  laundryAction,
  washhouseBench,
  runWashhouse,
  washhouseReadingChoices,
} = require('@librechat/api');
const { register } = require('./registry');
const { MooRoom, MooChar, setBusy, emit, logger } = require('./ctx');

async function seed() {
  const { roomId, ...room } = GULLY_LAUNDRY;
  await MooRoom.updateOne(
    { roomId },
    { $setOnInsert: { ...room, createdBy: 'reverie_seed' } },
    { upsert: true },
  );
  await MooRoom.updateOne(
    { roomId: 'patch_gully_road', 'exits.ne': { $exists: false } },
    { $set: { 'exits.ne': roomId } },
  );
}
for (const name of ['wash clothes', 'fold laundry', 'sort buttons'])
  register({
    name,
    help: {
      topic: 'senses',
      usage: name,
      blurb:
        'Use the Gully Washhouse on Gully Road. Washing improves comfort; there is no coin charge.',
    },
    buttons: (ctx) =>
      ctx.ch.roomId === GULLY_LAUNDRY.roomId
        ? [
            {
              label: laundryAction(name).label,
              cmd: name,
              group: 'here',
            },
          ]
        : [],
    async run(ctx) {
      if (ctx.ch.roomId !== GULLY_LAUNDRY.roomId)
        return ctx.fail(
          'The washers and folding table are at the Gully Washhouse, northeast from Gully Road.',
        );
      const now = Date.now();
      const claimed = await MooChar.updateOne(
        {
          _id: ctx.ch._id,
          active: true,
          roomId: GULLY_LAUNDRY.roomId,
          $or: [
            { 'attrs.life.laundryAt': { $exists: false } },
            { 'attrs.life.laundryAt': { $lte: now - 15_000 } },
          ],
        },
        { $set: { 'attrs.life.laundryAt': now } },
      );
      if (!claimed.modifiedCount)
        return ctx.fail('Finish with this load first. You can look around or talk while you wait.');
      const action = laundryAction(name);
      await setBusy(ctx.ch, 15, action.doing);
      await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} ${action.event}`);
      ctx.say(action.line).need({ clean: action.clean, fun: 1 });
      return ctx.ok({ wantRoom: true });
    },
  });

const here = (ctx) => ctx.ch.roomId === GULLY_LAUNDRY.roomId;
const revision = (path, value) =>
  value === 0 ? { $or: [{ [path]: 0 }, { [path]: { $exists: false } }] } : { [path]: value };
const wrongRoom = (ctx) => ctx.fail('This is at the Gully Washhouse, northeast from Gully Road.');

async function runSaved(ctx, command, arg) {
  if (!here(ctx)) return wrongRoom(ctx);
  const result = await runWashhouse(
    {
      async bench() {
        const room = await MooRoom.findOne({ roomId: GULLY_LAUNDRY.roomId }).lean();
        return room?.props?.washhouseBench || 0;
      },
      async repair(stage) {
        if (
          !(await MooChar.exists({ _id: ctx.ch._id, active: true, roomId: GULLY_LAUNDRY.roomId }))
        )
          return false;
        const saved = await MooRoom.updateOne(
          { roomId: GULLY_LAUNDRY.roomId, ...revision('props.washhouseBench', stage) },
          { $set: { 'props.washhouseBench': stage + 1 } },
        );
        return saved.modifiedCount === 1;
      },
      async bookmark(id, before, after) {
        const path = `attrs.life.washhousePages.${id}`;
        const saved = await MooChar.updateOne(
          {
            _id: ctx.ch._id,
            active: true,
            roomId: GULLY_LAUNDRY.roomId,
            ...revision(path, before),
          },
          { $set: { [path]: after } },
        );
        return saved.modifiedCount === 1;
      },
      async page(id) {
        const person = await MooChar.findOne({
          _id: ctx.ch._id,
          active: true,
          roomId: GULLY_LAUNDRY.roomId,
        })
          .select('attrs.life.washhousePages')
          .lean();
        return person?.attrs?.life?.washhousePages?.[id] || 0;
      },
    },
    command,
    arg,
  );
  if (result.event) {
    try {
      await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} ${result.event}`);
    } catch {
      logger.warn('[washhouse] repair saved; announcement unavailable');
    }
    delete result.event;
  }
  return result;
}

register({
  name: 'repair bench',
  help: {
    topic: 'senses',
    usage: 'repair bench',
    blurb:
      'Help repair the shared window bench. Supplies are provided and each repair is saved for everyone.',
  },
  buttons: (ctx) =>
    here(ctx) ? [{ label: 'Window bench', cmd: 'repair bench', group: 'here' }] : [],
  run: (ctx, { arg }) => runSaved(ctx, 'repair bench', arg),
});

register({
  name: 'book exchange',
  free: true,
  help: {
    topic: 'fun',
    usage: 'book exchange',
    blurb:
      'Read three short mysteries at the Washhouse. Your place in each book is saved; the books stay on the shelf.',
  },
  buttons: (ctx) =>
    here(ctx) ? [{ label: 'Book exchange', cmd: 'book exchange', group: 'here' }] : [],
  async run(ctx) {
    if (!here(ctx)) return wrongRoom(ctx);
    return ctx.ok({
      lines: [
        'A shelf holds mysteries passed between Nell and Ines. Read here and leave the book for the next person. Your place in each story is saved privately. Each has three short parts; the ending stays closed until you choose it. Reopen your last part if you missed it; Previous part lets you go back further.',
      ],
      choices: washhouseReadingChoices(ctx.life.washhousePages || {}),
    });
  },
});

for (const name of ['read washhouse', 'reread washhouse', 'reopen washhouse'])
  register({
    name,
    hidden: true,
    free: true,
    run: (ctx, { arg }) => runSaved(ctx, name, arg),
  });

module.exports = {
  seed,
  benchView: (room) =>
    room.roomId === GULLY_LAUNDRY.roomId ? washhouseBench(room.props?.washhouseBench || 0) : null,
};
