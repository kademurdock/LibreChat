const { runHangout, hangoutView } = require('@librechat/api');
const { MooRoom, emit, logger } = require('./ctx');
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
  name: 'hangout', aliases: ['hangouts', 'party'], free: true,
  help: { topic: 'life', usage: 'hangout · hangout add <your words> · hangout memories', blurb: 'Host a cookout, record night, or story circle. Join in, listen, and keep shared memories.' },
  buttons: async () => [{ label: 'Hangout', cmd: 'hangout', group: 'here' }],
  async run(ctx, arg) {
    const result = await runHangout({
      read: async () => snapshot(await MooRoom.findOne({ roomId: ctx.ch.roomId }).lean(), ctx.ch.userId, ctx.isWizard),
      save: async (before, after) => {
        const revision = before.revision ? { 'props.hangoutRevision': before.revision } : { $or: [{ 'props.hangoutRevision': 0 }, { 'props.hangoutRevision': { $exists: false } }] };
        const saved = await MooRoom.updateOne({ roomId: before.roomId, ...revision }, { $set: {
          'props.hangoutRevision': after.revision, 'props.hangout': after.gathering, 'props.hangoutAlbum': after.album,
        } });
        return saved.modifiedCount === 1;
      },
    }, { userId: ctx.ch.userId, name: ctx.ch.name }, arg.argRaw || '');
    if (result.event) {
      try { await emit(ctx.ch.roomId, ctx.ch.userId, ctx.ch.name, 'hangout', result.event, result.sounds[0]); }
      catch (e) { logger.error('[hangout] saved; room announcement failed:', e.message); }
      delete result.event;
    }
    return result;
  },
});

module.exports = { snapshot, view: (room, userId, isWizard) => hangoutView(snapshot(room, userId, isWizard), userId) };
