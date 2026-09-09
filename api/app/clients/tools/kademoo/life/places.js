const { GULLY_LAUNDRY, laundryAction } = require('@librechat/api');
const { register } = require('./registry');
const { MooRoom, MooChar, setBusy, emit } = require('./ctx');

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
for (const name of ['wash clothes', 'fold laundry'])
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
              label: name === 'wash clothes' ? 'Wash clothes' : 'Fold laundry',
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
      await emit(
        ctx.ch.roomId,
        ctx.userId,
        ctx.ch.name,
        'emote',
        `${ctx.ch.name} ${name === 'fold laundry' ? 'folds a stack of warm laundry.' : 'finishes a small load at the washers.'}`,
      );
      ctx.say(action.line).need({ clean: action.clean, fun: 1 });
      return ctx.ok({ wantRoom: true });
    },
  });

module.exports = { seed };
