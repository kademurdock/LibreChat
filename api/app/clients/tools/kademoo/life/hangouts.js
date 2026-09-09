const { runHangout, hangoutView, inviteHangout } = require('@librechat/api');
const { MooRoom, MooChar, emit, logger, matchName, kindOfSoul } = require('./ctx');
const { register } = require('./registry');

function snapshot(room, userId, isWizard = false) {
  const home = room.props?.home;
  const resident = home && (home.owner === userId || (home.tenants || []).includes(userId));
  return {
    roomId: room.roomId,
    revision: room.props?.hangoutRevision || 0,
    gathering: room.props?.hangout || null,
    album: room.props?.hangoutAlbum || [],
    canHost: !home || !!resident || isWizard,
    canManage: !!resident || isWizard,
  };
}

register({
  name: 'hangout',
  aliases: ['hangouts', 'party'],
  free: true,
  help: {
    topic: 'life',
    usage: 'hangout · hangout add <your words> · hangout memories',
    blurb:
      'Host a cookout, record night, or story circle. Join in, listen, and keep shared memories.',
  },
  buttons: async () => [{ label: 'Hangout', cmd: 'hangout', group: 'here' }],
  async run(ctx, arg) {
    const store = {
      read: async () =>
        snapshot(
          await MooRoom.findOne({ roomId: ctx.ch.roomId }).lean(),
          ctx.ch.userId,
          ctx.isWizard,
        ),
      save: async (before, after) => {
        const revision = before.revision
          ? { 'props.hangoutRevision': before.revision }
          : {
              $or: [
                { 'props.hangoutRevision': 0 },
                { 'props.hangoutRevision': { $exists: false } },
              ],
            };
        const saved = await MooRoom.updateOne(
          { roomId: before.roomId, ...revision },
          {
            $set: {
              'props.hangoutRevision': after.revision,
              'props.hangout': after.gathering,
              'props.hangoutAlbum': after.album,
            },
          },
        );
        return saved.modifiedCount === 1;
      },
    };
    const actor = { userId: ctx.ch.userId, name: ctx.ch.name };
    const invitation = /^invite\s+(.+)$/i.exec(arg.argRaw || '');
    let result;
    if (invitation) {
      const people = await MooChar.find({
        roomId: ctx.ch.roomId,
        userId: { $ne: ctx.ch.userId },
      }).lean();
      const person = matchName(people, invitation[1]);
      if (!person) return ctx.fail('Invite somebody who is here: hangout invite Name.');
      if (!['citizen', 'player'].includes(kindOfSoul(person)))
        return ctx.fail('They can keep you company here while you enjoy the hangout.');
      if (kindOfSoul(person) === 'player') {
        const room = await store.read();
        if (!room.gathering?.guests.some((p) => p.userId === ctx.ch.userId))
          return ctx.fail('Start or join a hangout here first.');
        const text = `${ctx.ch.name} invites ${person.name} to the hangout. Join in whenever you like.`;
        await emit(ctx.ch.roomId, ctx.ch.userId, ctx.ch.name, 'hangout', text, 'hangout.seat');
        return ctx.ok({ lines: [text], sounds: ['hangout.seat'] });
      }
      result = await inviteHangout(
        {
          ...store,
          present: async () => !!(await MooChar.exists({ _id: person._id, roomId: ctx.ch.roomId })),
        },
        actor,
        { userId: person.userId, name: person.name },
      );
    } else result = await runHangout(store, actor, arg.argRaw || '');
    if (result.event) {
      try {
        await emit(
          ctx.ch.roomId,
          ctx.ch.userId,
          ctx.ch.name,
          'hangout',
          result.event,
          result.sounds[0],
        );
      } catch (e) {
        logger.error('[hangout] saved; room announcement failed:', e.message);
      }
      delete result.event;
    }
    return result;
  },
});

module.exports = {
  snapshot,
  view: (room, userId, isWizard) => hangoutView(snapshot(room, userId, isWizard), userId),
};
