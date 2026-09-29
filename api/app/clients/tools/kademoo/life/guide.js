const { runReverieGuide, CANAL_PROJECTS, CANAL_STOPS } = require('@librechat/api');
const { register, get } = require('./registry');
const { MooRoom, MooChar, MooItem, emit, logger } = require('./ctx');

function storeFor(ctx) {
  const location = { _id: ctx.ch._id, active: true, roomId: ctx.ch.roomId };
  return {
    rooms: () =>
      MooRoom.find({})
        .select('roomId name district exits props.home props.locks props.outdoor')
        .lean(),
    async state() {
      const ch = await MooChar.findOne(location).select('attrs.life.guide').lean();
      return ch?.attrs?.life?.guide || {};
    },
    async destination(id) {
      const saved = await MooChar.updateOne(location, {
        $set: { 'attrs.life.guide.destination': id },
      });
      return saved.matchedCount === 1;
    },
    async project(id, before, after) {
      const stage = `attrs.life.guide.projects.${id}.stage`;
      const match =
        before === 0
          ? { $or: [{ [stage]: 0 }, { [stage]: { $exists: false } }] }
          : { [stage]: before };
      const saved = await MooChar.updateOne(
        { ...location, ...match },
        { $set: { [`attrs.life.guide.projects.${id}`]: after } },
      );
      return saved.modifiedCount === 1;
    },
    async deliver(id, title, description) {
      await MooItem.updateOne(
        { itemId: `canal_${ctx.ch._id}_${id}` },
        {
          $setOnInsert: {
            name: title,
            desc: description,
            portable: true,
            location: { type: 'char', id: ctx.userId },
            props: { crafted: true, maker: ctx.ch.name, project: id },
          },
        },
        { upsert: true },
      );
      /* Sep 29 2026: once handed over, a revisit never makes the piece again */
      await MooChar.updateOne(
        { _id: ctx.ch._id, [`attrs.life.guide.projects.${id}.finished`]: true },
        { $set: { [`attrs.life.guide.projects.${id}.delivered`]: true } },
      );
    },
    async announce(line, sound) {
      try {
        await emit(
          ctx.ch.roomId,
          ctx.userId,
          ctx.ch.name,
          'emote',
          `${ctx.ch.name} ${line}`,
          sound,
        );
      } catch (error) {
        logger.warn('[reverie] project saved; announcement unavailable');
      }
    },
    async walk(direction) {
      const before = ctx.lines.length;
      const result = await get('go').run(ctx, { arg: direction, argRaw: direction });
      return { ...result, lines: result.lines.slice(before) };
    },
  };
}

for (const name of [
  'town',
  'route',
  'walk route',
  'notebook',
  'canal trail',
  'projects',
  'project',
]) {
  register({
    name,
    aliases:
      name === 'town' ? ['town guide', 'guide'] : name === 'notebook' ? ['canal notebook'] : [],
    free: name !== 'walk route' && name !== 'project',
    help: {
      topic: name === 'project' || name === 'projects' ? 'fun' : 'moving',
      usage: name,
      blurb:
        'Find things to do, follow a saved route, and keep your canal discoveries and projects.',
    },
    buttons(ctx) {
      if (name === 'town') return [{ label: 'Town guide', cmd: name, group: 'move' }];
      if (name === 'route' && ctx.life.guide?.destination)
        return [{ label: 'My walking route', cmd: name, group: 'move' }];
      if (name === 'notebook') return [{ label: 'My notebook', cmd: name, group: 'self' }];
      if (name === 'project')
        return Object.entries(CANAL_PROJECTS)
          .filter(([, p]) => p.room === ctx.ch.roomId)
          .map(([id, p]) => ({ label: p.name, cmd: `project ${id}`, group: 'here' }));
      return [];
    },
    async run(ctx, { arg }) {
      const prefix = ctx.lines.slice();
      const result = await runReverieGuide(storeFor(ctx), ctx.ch.roomId, name, arg);
      const titles = {
        town: 'Town guide',
        route: 'Walking directions',
        'walk route': 'Walking directions',
        notebook: 'My canal notebook',
        'canal trail': 'The Canal trail',
        projects: 'Workshop projects',
        project: 'My workshop project',
      };
      return { ...result, menuTitle: titles[name], lines: [...prefix, ...result.lines] };
    },
  });
}

/* Sep 29 2026: a saved route ends when you stand at its destination, by the
 * route or on your own feet. It used to stay saved and later lead you back.
 * Called once after every turn (life/index.js) with the fresh character. */
async function arrive(ctx) {
  const guide = ctx.life && ctx.life.guide;
  const destination = guide && guide.destination;
  if (!destination || !ctx.ch || destination !== ctx.ch.roomId) return;
  await MooChar.updateOne(
    { _id: ctx.ch._id, 'attrs.life.guide.destination': destination },
    { $set: { 'attrs.life.guide.destination': '' } },
  );
  guide.destination = '';
}

function progress(life) {
  const state = life.guide || {};
  const completed = CANAL_STOPS.filter((stop) => state.notes?.[stop.id]).length;
  const next = CANAL_STOPS.find((stop) => !state.notes?.[stop.id]);
  return {
    completed,
    total: CANAL_STOPS.length,
    destination: state.destination || null,
    next: next ? { id: next.id, name: next.name, command: next.command } : null,
  };
}

module.exports = { progress, arrive };
