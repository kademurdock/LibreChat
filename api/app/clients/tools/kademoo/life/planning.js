const { RESIDENT_PILOT, runResidentPilot, activeResidentAction } = require('@librechat/api');
const { MooChar, MooRoom, MooDistrict, MooEvent, nextSeq } = require('~/models/kadeMoo');
const { logger } = require('@librechat/data-schemas');
const reverie = require('../reverie');
const { register } = require('./registry');

let pending = null;

function publicActivity(person, schedule, outdoor = false) {
  return activeResidentAction(person.attrs?.residentPlan, person.roomId, schedule, outdoor)?.action
    .doing;
}

function tickResidents(rooms, weather) {
  if (pending || !rooms.length) return;
  pending = runResidentPilot(
    {
      async residents() {
        const visitors = await MooChar.find({
          userId: { $not: /^(npc|kid|stray|pet):/ },
          active: true,
          'attrs.life.created': true,
          lastActiveAt: { $gte: new Date(Date.now() - 15 * 60_000) },
          roomId: { $in: rooms },
        })
          .select('roomId')
          .lean();
        const occupied = [...new Set(visitors.map((visitor) => visitor.roomId))];
        const [people, places] = await Promise.all([
          MooChar.find({ userId: /^npc:/, active: true, roomId: { $in: occupied } })
            .select('userId name roomId attrs.residentPlan')
            .lean(),
          MooRoom.find({ roomId: { $in: occupied }, 'props.home': { $exists: false } })
            .select('roomId name props.outdoor props.hangout')
            .lean(),
        ]);
        const byRoom = new Map(places.map((place) => [place.roomId, place]));
        return people.flatMap((person) => {
          const room = byRoom.get(person.roomId),
            canon = reverie.CENSUS_BY_ID[person.userId];
          const slot = reverie.npcDoingNow(person.userId);
          if (!room || !canon || slot?.room !== room.roomId) return [];
          return [
            {
              id: person.userId,
              name: person.name,
              roomId: room.roomId,
              roomName: room.name,
              outdoor: !!room.props.outdoor,
              schedule: slot.doing,
              character: canon.desc || '',
              gathering: !!room.props.hangout,
              plan: person.attrs?.residentPlan,
            },
          ];
        });
      },
      async reserve(now) {
        const result = await MooDistrict.updateOne(
          {
            districtId: RESIDENT_PILOT.id,
            'props.enabledUntil': { $gt: now },
            'props.calls': { $lt: RESIDENT_PILOT.limit },
            'props.nextAt': { $lte: now },
          },
          {
            $inc: { 'props.calls': 1 },
            $set: { 'props.nextAt': now + RESIDENT_PILOT.intervalMs },
          },
        );
        return result.modifiedCount === 1;
      },
      async apply(resident, plan) {
        const slot = reverie.npcDoingNow(resident.id);
        if (slot?.room !== resident.roomId || slot.doing !== resident.schedule) return false;
        if (
          !(await MooRoom.exists({
            roomId: resident.roomId,
            'props.home': { $exists: false },
            'props.hangout': null,
          }))
        )
          return false;
        const result = await MooChar.updateOne(
          {
            userId: resident.id,
            active: true,
            roomId: resident.roomId,
            'attrs.residentPlan.startedAt': resident.plan?.startedAt ?? null,
          },
          { $set: { 'attrs.residentPlan': plan } },
        );
        return result.modifiedCount === 1;
      },
      async emit(resident, action, step) {
        if (!(await MooRoom.exists({ roomId: resident.roomId, 'props.hangout': null })))
          return false;
        const result = await MooChar.updateOne(
          {
            userId: resident.id,
            active: true,
            roomId: resident.roomId,
            'attrs.residentPlan.startedAt': resident.plan.startedAt,
            'attrs.residentPlan.emitted': { $lt: step },
          },
          { $set: { 'attrs.residentPlan.emitted': step } },
        );
        if (!result.modifiedCount) return false;
        await MooEvent.create({
          seq: await nextSeq(),
          roomId: resident.roomId,
          actorUserId: resident.id,
          actorName: resident.name,
          kind: 'emote',
          text: `${resident.name} ${action.event}`,
          sound: action.sound || null,
        });
        return true;
      },
    },
    weather,
  )
    .catch(() => logger.warn('[reverie] resident pilot unavailable; ordinary schedules continue'))
    .finally(() => {
      pending = null;
    });
}

register({
  name: '@resident pilot',
  hidden: true,
  free: true,
  async run(ctx, { arg }) {
    if (!ctx.isWizard) return ctx.fail('That control belongs to the Founder.');
    if (arg === 'start') {
      await MooDistrict.updateOne(
        { districtId: RESIDENT_PILOT.id },
        {
          $setOnInsert: {
            name: 'Resident planning trial',
            props: {
              calls: 0,
              nextAt: 0,
              enabledUntil: Date.now() + 4 * 60 * 60_000,
              reservePerCallUSD: RESIDENT_PILOT.reserveUSD,
              limit: RESIDENT_PILOT.limit,
            },
          },
        },
        { upsert: true },
      );
    } else if (arg === 'pause') {
      await MooDistrict.updateOne(
        { districtId: RESIDENT_PILOT.id },
        { $set: { 'props.enabledUntil': 0 } },
      );
    } else if (arg && arg !== 'status')
      return ctx.fail('Use @resident pilot start, status, or pause.');
    const record = await MooDistrict.findOne({ districtId: RESIDENT_PILOT.id }).lean();
    const calls = record?.props?.calls || 0;
    const active = record?.props?.enabledUntil > Date.now() && calls < RESIDENT_PILOT.limit;
    const plans = await MooChar.find({
      userId: /^npc:/,
      'attrs.residentPlan.startedAt': { $exists: true },
    })
      .select('attrs.residentPlan.emitted')
      .lean();
    const emitted = plans.filter((person) => person.attrs?.residentPlan?.emitted >= 0).length;
    return ctx.ok({
      lines: [
        `Resident trial: ${active ? 'active' : 'paused or finished'}. ${calls} of ${RESIDENT_PILOT.limit} requests reserved, at most $0.36 total. Starting again never refills or extends it. Ordinary routines continue.`,
        `${plans.length} residents have a latest saved plan; ${emitted} of those plans show an emitted activity step. These are saved-plan snapshots, not a lifetime activity count or a billed-cost receipt.`,
        record?.props?.enabledUntil > 0
          ? `The planning window ends at ${new Date(record.props.enabledUntil).toISOString()}.`
          : 'No planning window is currently enabled.',
      ],
    });
  },
});

module.exports = { tickResidents, publicActivity, settled: () => pending };
